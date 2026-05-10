// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  3D Rigid-Body Rotational Dynamics Engine for CubeSat Solar Panel Deployment
//
//  • Quaternion orientation for body and panels
//  • Full 3×3 inertia tensors (diagonal in body frame, rotated to world each step)
//  • Euler's rotational equation with gyroscopic coupling: I·α = τ − ω×(I·ω)
//  • 1-DOF hinge constraint per panel (spring-damper + mechanical stop)
//  • Semi-implicit Euler integration (velocity-first)
//  • Angular momentum conserving internal hinge torques
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import {
  type ConfigType,
  type SimulationParams,
  type SpacecraftState,
  type PanelState,
  type ThermalParams,
  type FlexParams,
  Vector3,
  Quaternion,
  Euler,
  DEFAULT_PARAMS,
} from './types';
import { MathUtils } from 'three';

import { getPanelSpecs } from './panelLayouts';
import {
  initThermalState,
  stepThermalState,
  applyThermalStiffness,
} from './thermalModel';
import {
  initFlexState,
  stepFlexState,
  DEFAULT_FLEX_PARAMS,
} from './flexModel';
import { GM_EARTH, R_EARTH } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
//  Inertia tensor helpers (diagonal in body frame)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Diagonal principal inertia for a rectangular prism (spacecraft body).
 *   Ixx = (1/12) m (H² + D²)
 *   Iyy = (1/12) m (W² + D²)
 *   Izz = (1/12) m (W² + H²)
 * Axis convention: X = bodyWidth, Y = bodyHeight, Z = bodyDepth.
 */
function bodyInertiaDiag(params: SimulationParams): Vector3 {
  const w = params.bodyWidth;
  const h = params.bodyHeight;
  const d = params.bodyDepth;
  const m = params.bodyMass;
  return new Vector3(
    (1 / 12) * m * (h * h + d * d),
    (1 / 12) * m * (w * w + d * d),
    (1 / 12) * m * (w * w + h * h),
  );
}

/**
 * Rotational kinetic energy of the spacecraft body (millijoules).
 *
 * E = 1/2 · (Ixx·ωx² + Iyy·ωy² + Izz·ωz²)
 *
 * ω must be expressed in the body principal frame.
 * Pass state.angularVelocity (world frame) and state._bodyQ so the
 * function can rotate ω into the body frame internally.
 *
 * Reference: Hughes (1986), Spacecraft Attitude Dynamics, Ch. 4 §4.2.3
 *
 * @param omegaWorld  Angular velocity vector in world frame (rad/s)
 * @param bodyQ       Body quaternion (world→body rotation)
 * @param params      SimulationParams — used to call bodyInertiaDiag
 * @returns           Rotational KE in millijoules (mJ)
 */
export function computeEDetumble(
  omegaWorld: Vector3,
  bodyQ: Quaternion,
  params: SimulationParams,
): number {
  const Ib = bodyInertiaDiag(params);
  const omegaBody = omegaWorld
    .clone()
    .applyQuaternion(bodyQ.clone().conjugate());
  return (
    0.5 *
    (Ib.x * omegaBody.x * omegaBody.x +
      Ib.y * omegaBody.y * omegaBody.y +
      Ib.z * omegaBody.z * omegaBody.z) *
    1000 // J → mJ
  );
}

/**
 * Diagonal inertia for a rectangular panel plate about the hinge edge.
 * Panel body frame: X = outward (L), Y = thickness (t), Z = span (W).
 * Hinge runs along Z at the X = 0 edge (parallel-axis theorem applied).
 *
 *   Ixx = (1/12) m (W² + t²)
 *   Iyy = (1/3)  m L² + (1/12) m W²
 *   Izz = (1/3)  m L² + (1/12) m t²     ← moment about hinge axis
 */
function panelInertiaDiag(m: number, L: number, W: number, t: number): Vector3 {
  return new Vector3(
    (1 / 12) * m * (W * W + t * t),
    (1 / 3) * m * L * L + (1 / 12) * m * W * W,
    (1 / 3) * m * L * L + (1 / 12) * m * t * t,
  );
}

/**
 * Solve  α = I_world⁻¹ · τ_world  without forming the full 3×3.
 * Strategy: rotate τ into body frame → divide by diagonal I → rotate back.
 */
function applyInverseInertia(Idiag: Vector3, q: Quaternion, torqueWorld: Vector3): Vector3 {
  const tBody = new Vector3(torqueWorld.x, torqueWorld.y, torqueWorld.z)
    .applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w).clone().conjugate());
  const aBody = new Vector3(tBody.x / Idiag.x, tBody.y / Idiag.y, tBody.z / Idiag.z);
  return aBody.applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
}

/** I_body · ω  (diagonal body frame). */
function applyInertia(Idiag: Vector3, w: Vector3): Vector3 {
  return new Vector3(Idiag.x * w.x, Idiag.y * w.y, Idiag.z * w.z);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gravity gradient torque
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Compute the gravity gradient torque acting on the spacecraft body.
 *
 * For a rigid body in a circular orbit, the gravity gradient torque is:
 *   τ_gg = (3μ/R³) · r̂_body × (I · r̂_body)
 *
 * In body-frame components (diagonal I):
 *   τ_x = (3μ/R³) · (Izz - Iyy) · r̂_y · r̂_z
 *   τ_y = (3μ/R³) · (Ixx - Izz) · r̂_z · r̂_x
 *   τ_z = (3μ/R³) · (Iyy - Ixx) · r̂_x · r̂_y
 *
 * Reference: Hughes (1986), Spacecraft Attitude Dynamics, §3.3.
 *
 * @param Ib   Diagonal body principal inertia tensor [Ixx, Iyy, Izz] (kg·m²)
 * @param qBody Current body orientation quaternion (world frame)
 * @param t    Current simulation time (seconds)
 * @param altitudeM Orbit altitude above Earth surface (metres)
 * @returns Gravity gradient torque vector in WORLD frame (N·m)
 */
function computeGravityGradientTorque(
  Ib: Vector3,
  qBody: Quaternion,
  t: number,
  altitudeM: number,
): Vector3 {
  // Orbital mechanics
  const R = R_EARTH + altitudeM;           // orbit radius (m)
  const T_orbit = 2 * Math.PI * Math.sqrt((R * R * R) / GM_EARTH); // period (s)
  const n = (2 * Math.PI) / T_orbit;       // mean motion (rad/s)

  // Nadir unit vector in world frame: points from spacecraft toward Earth centre.
  // For equatorial circular orbit in our convention (X=right, Y=forward, Z=up),
  // nadir rotates in the Y-Z plane as the satellite orbits.
  const nadirWorld = new Vector3(0, -Math.sin(n * t), -Math.cos(n * t));

  // Transform nadir to body frame: r̂_body = q* ⊗ r̂_world
  const qBodySafe = new Quaternion(qBody.x, qBody.y, qBody.z, qBody.w);
  const nadirBody = nadirWorld.clone().applyQuaternion(qBodySafe.clone().conjugate());
  const rx = nadirBody.x;
  const ry = nadirBody.y;
  const rz = nadirBody.z;

  // Gravity gradient factor: 3μ/R³
  const factor = (3 * GM_EARTH) / (R * R * R);

  // Body-frame torque components (Hughes 1986, Eq. 3.3.10)
  const tauBodyX = factor * (Ib.z - Ib.y) * ry * rz;
  const tauBodyY = factor * (Ib.x - Ib.z) * rz * rx;
  const tauBodyZ = factor * (Ib.y - Ib.x) * rx * ry;
  const tauBody = new Vector3(tauBodyX, tauBodyY, tauBodyZ);

  // Rotate torque back to world frame for accumulation with hinge torques
  return tauBody.applyQuaternion(qBodySafe);
}

// ─────────────────────────────────────────────────────────────────────────────
//  4th-order Runge-Kutta body integrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Integrate spacecraft body rotational dynamics using classical 4th-order
 * Runge-Kutta (RK4).  The state vector is (q, ω) where:
 *
 *   dq/dt = 0.5 · q ⊗ [0, ω_body]          (kinematic equation)
 *   dω/dt = I⁻¹ · (τ - ω × (I·ω))          (Euler's rotation equation)
 *
 * The external torque τ is treated as constant over the timestep — the
 * standard approach for externally driven systems.
 *
 * Quaternion kinematic equation reference:
 *   Wertz, J. R. (1978). *Spacecraft Attitude Determination and Control*,
 *   Kluwer Academic Publishers, §16.1.
 *
 * RK4 error characteristics reference:
 *   Shampine, L. F. & Reichelt, M. W. (1997). "The MATLAB ODE Suite",
 *   SIAM Journal on Scientific Computing, 18(1), pp. 1–22.
 *
 * @param qBody     Current body orientation quaternion (world frame)
 * @param omegaBody Current body angular velocity (world frame, rad/s)
 * @param torqueWorld External torque in world frame (N·m) — held constant over dt
 * @param Ib        Diagonal principal inertia tensor (body frame, kg·m²)
 * @param dt        Integration timestep (s)
 * @returns         {qBodyNew, omegaBodyNew} after one RK4 step
 */
export function integrateBodyRK4(
  qBody: Quaternion,
  omegaBody: Vector3,
  torqueWorld: Vector3,
  Ib: Vector3,
  dt: number,
): { qBodyNew: Quaternion; omegaBodyNew: Vector3 } {

  // ── Derivative function: (q, ω) → (dq/dt, dω/dt) ────────────────────────
  function deriv(
    q: Quaternion,
    omega: Vector3,
  ): { dq: Quaternion; dOmega: Vector3 } {
    const qSafe = new Quaternion(q.x, q.y, q.z, q.w);
    const omegaSafe = new Vector3(omega.x, omega.y, omega.z);

    // Kinematic equation: dq/dt = 0.5 · [0, ω_world] ⊗ q  (world-frame convention)
    const omegaQuat = new Quaternion(omegaSafe.x, omegaSafe.y, omegaSafe.z, 0);
    const qDot = omegaQuat.clone().multiply(qSafe);
    const dq = new Quaternion(0.5 * qDot.x, 0.5 * qDot.y, 0.5 * qDot.z, 0.5 * qDot.w);

    // Euler's equation: I·α = τ - ω×(I·ω)
    // Compute gyroscopic term in world frame via body frame
    const omegaBody = omegaSafe.clone().applyQuaternion(qSafe.clone().conjugate());
    const IomegaBody = applyInertia(Ib, omegaBody);
    const IomegaWorld = IomegaBody.clone().applyQuaternion(qSafe.clone());
    const gyro = new Vector3().crossVectors(omegaSafe, IomegaWorld);
    const netTorque = new Vector3(torqueWorld.x, torqueWorld.y, torqueWorld.z).sub(gyro);
    const dOmega = applyInverseInertia(Ib, q, netTorque);

    return { dq, dOmega };
  }

  // ── Helper: add scaled quaternion derivative to quaternion ────────────────
  function qAddScaled(q: Quaternion, dq: Quaternion, s: number): Quaternion {
    return new Quaternion(
      q.x + dq.x * s,
      q.y + dq.y * s,
      q.z + dq.z * s,
      q.w + dq.w * s,
    );
  }

  // ── RK4 stages ───────────────────────────────────────────────────────────
  // k1
  const k1 = deriv(qBody, omegaBody);

  // k2 (midpoint using k1)
  const q2 = qAddScaled(qBody, k1.dq, 0.5 * dt).clone().normalize();
  const omega2 = new Vector3(omegaBody.x, omegaBody.y, omegaBody.z).add(k1.dOmega.clone().multiplyScalar(0.5 * dt));
  const k2 = deriv(q2, omega2);

  // k3 (midpoint using k2)
  const q3 = qAddScaled(qBody, k2.dq, 0.5 * dt).clone().normalize();
  const omega3 = new Vector3(omegaBody.x, omegaBody.y, omegaBody.z).add(k2.dOmega.clone().multiplyScalar(0.5 * dt));
  const k3 = deriv(q3, omega3);

  // k4 (full step using k3)
  const q4 = qAddScaled(qBody, k3.dq, dt).clone().normalize();
  const omega4 = new Vector3(omegaBody.x, omegaBody.y, omegaBody.z).add(k3.dOmega.clone().multiplyScalar(dt));
  const k4 = deriv(q4, omega4);

  // ── Weighted combination ─────────────────────────────────────────────────
  // y_{n+1} = y_n + (dt/6)(k1 + 2k2 + 2k3 + k4)
  const dqFinal = new Quaternion(
    (k1.dq.x + 2 * k2.dq.x + 2 * k3.dq.x + k4.dq.x) / 6,
    (k1.dq.y + 2 * k2.dq.y + 2 * k3.dq.y + k4.dq.y) / 6,
    (k1.dq.z + 2 * k2.dq.z + 2 * k3.dq.z + k4.dq.z) / 6,
    (k1.dq.w + 2 * k2.dq.w + 2 * k3.dq.w + k4.dq.w) / 6,
  );

  const dOmegaFinal = new Vector3(
    (k1.dOmega.x + 2 * k2.dOmega.x + 2 * k3.dOmega.x + k4.dOmega.x) / 6,
    (k1.dOmega.y + 2 * k2.dOmega.y + 2 * k3.dOmega.y + k4.dOmega.y) / 6,
    (k1.dOmega.z + 2 * k2.dOmega.z + 2 * k3.dOmega.z + k4.dOmega.z) / 6,
  );

  const qBodyNew = qAddScaled(qBody, dqFinal, dt).clone().normalize();
  const omegaBodyNew = new Vector3(omegaBody.x, omegaBody.y, omegaBody.z).add(dOmegaFinal.clone().multiplyScalar(dt));

  return { qBodyNew, omegaBodyNew };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Angular momentum computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the total system angular momentum H_total in the world frame.
 *
 * The decomposition follows Hughes (1986) *Spacecraft Attitude Dynamics*,
 * Cambridge University Press, Chapter 3:
 *
 *   H_total = I_body · ω_body + Σ_i [ I_panel_i · ω_panel_i ]
 *
 * where:
 *   ω_panel_i = ω_body + θ̇_i · â_i   (body velocity + relative hinge rotation)
 *   â_i = hinge axis in world frame
 *   I_panel_i is the panel's full inertia tensor (about its hinge edge),
 *     rotated to the world frame.
 *
 * All inertia tensors are diagonal in their respective body frames and
 * are rotated to the world frame using the current orientation quaternions.
 *
 * @param state  Current spacecraft state (body + panels)
 * @param config Configuration type (determines panel specs)
 * @param params Simulation parameters (masses, dimensions)
 * @returns H_total as a Vector3 in world frame (kg·m²/s)
 */
export function computeTotalAngularMomentum(
  state: SpacecraftState,
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
): Vector3 {
  const specs = getPanelSpecs(config, params);
  const qBody = state._bodyQ
    ? new Quaternion(state._bodyQ.x, state._bodyQ.y, state._bodyQ.z, state._bodyQ.w)
    : new Quaternion().setFromEuler(new Euler(state.orientation.x, state.orientation.y, state.orientation.z, 'XYZ'));
  const omegaBody = new Vector3(state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z);

  // ── Body contribution: H_body = R_body · I_body_diag · R_body^T · ω_body ──
  const Ib = bodyInertiaDiag(params);
  const omegaBodyLocal = omegaBody.clone().applyQuaternion(qBody.clone().conjugate());
  const HbodyLocal = applyInertia(Ib, omegaBodyLocal);
  const Htotal = HbodyLocal.clone().applyQuaternion(qBody.clone());

  // ── Panel contributions ────────────────────────────────────────────────────
  for (let i = 0; i < state.panels.length; i++) {
    const panel = state.panels[i];
    const spec = specs[i];

    // Panel inertia tensor (diagonal, panel body frame about hinge edge)
    const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

    // Panel orientation quaternion
    const qMount = new Quaternion().setFromEuler(new Euler(spec.rot[0], spec.rot[1], spec.rot[2], 'XYZ'));
    const aLocal = hingeAxisUnit(spec.axis);
    const aBody = aLocal.clone().applyQuaternion(qMount.clone());
    const aWorld = aBody.clone().applyQuaternion(qBody.clone());

    const qHinge = new Quaternion().setFromAxisAngle(aLocal.clone().normalize(), panel.angle);
    const qPanel = qBody.clone().multiply(qMount.clone()).multiply(qHinge).normalize();

    // Panel angular velocity in world frame: ω_panel = ω_body + θ̇ · â_world
    const omegaPanel = omegaBody.clone().add(aWorld.clone().multiplyScalar(panel.angularVelocity));

    // Rotate ω to panel body frame, apply diagonal inertia, rotate back
    const omegaPanelLocal = omegaPanel.clone().applyQuaternion(qPanel.clone().conjugate());
    const HpanelLocal = applyInertia(Ip, omegaPanelLocal);
    const HpanelWorld = HpanelLocal.clone().applyQuaternion(qPanel.clone());

    Htotal.x += HpanelWorld.x;
    Htotal.y += HpanelWorld.y;
    Htotal.z += HpanelWorld.z;
  }

  return Htotal;
}

/**
 * Compute the instantaneous system Centre of Mass (CoM) in the spacecraft
 * body frame (with the body's geometric centre at the origin).
 *
 * The composite CoM follows the standard mass-weighted centroid formula:
 *
 *   r_CoM = (m_body · r_body + Σ_i m_panel_i · r_panel_i) / M_total
 *
 * where r_body = [0,0,0] (body CoM is the reference frame origin), and
 * r_panel_i is the panel geometric centre in the BODY frame at the current
 * hinge angle θ_i.
 *
 * Panel centre in body frame derivation (kinematic chain):
 *   1. Local-frame centre offset (from panelLayouts spec.pos) is transformed
 *      to the body frame using the panel's mounting+hinge quaternion:
 *        r_panel_body = q_mount ⊗ q_hinge(θ) ⊗ spec.pos ⊗ (q_mount ⊗ q_hinge)†
 *   2. Add hinge pivot position (spec.hinge) expressed in body frame to get
 *      the panel centre relative to body origin.
 *   3. For hierarchical (child) panels (parentIndex set): the hinge world position
 *      is derived from the parent's current orientation quaternion:
 *        hingeBody_child = hingeBody_parent + spec.hingeOffset rotated by q_parent_mount_hinge
 *
 * The offset vector from the nominal CoM (origin) is also returned for
 * visualisation: a non-zero offset indicates asymmetric deployment (e.g.
 * stuck panels) and gives rise to a net gravity-gradient torque bias.
 *
 * Reference for composite CoM derivation:
 *   Hughes, P. C. (1986). Spacecraft Attitude Dynamics. John Wiley & Sons.
 *   Chapter 3, Eq. (3.2.1): r_c = Σ m_i r_i / M.
 *
 * Reference for kinematic chain quaternion rotation:
 *   Wertz, J. R. (ed.) (1978). Spacecraft Attitude Determination and Control.
 *   Kluwer Academic Publishers. Section 16.1 — quaternion composition.
 *
 * @param state   Current spacecraft state (body + panels with live _q quaternions)
 * @param config  Configuration type (determines panel layout specs)
 * @param params  Simulation parameters (masses and body dimensions)
 * @returns Object containing:
 *   - comBody:  CoM position in BODY frame (Vector3, metres)
 *   - comWorld: CoM position in WORLD frame (Vector3, metres)
 *   - offsetMm: CoM offset from nominal origin, converted to mm (scalar, mm)
 *   - panelCentresWorld: array of per-panel CoM positions in world frame (Vector3[])
 */
export function computeSystemCoM(
  state: SpacecraftState,
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
): {
  comBody: Vector3;
  comWorld: Vector3;
  offsetMm: number;
  panelCentresWorld: Vector3[];
} {
  const specs = getPanelSpecs(config, params);
  const mBody = params.bodyMass;
  const mPanel = params.panelMass;
  const nPanels = state.panels.length;
  const mTotal = mBody + mPanel * nPanels;

  // Body quaternion (world orientation of spacecraft body frame)
  const qBody = state._bodyQ
    ? new Quaternion(state._bodyQ.x, state._bodyQ.y, state._bodyQ.z, state._bodyQ.w)
    : new Quaternion().setFromEuler(
        new Euler(state.orientation.x, state.orientation.y, state.orientation.z, 'XYZ'),
      );

  // Body CoM is at origin in body frame → world position = body translation (none in this sim)
  // r_body_world = [0,0,0] (spacecraft body centre IS the world origin in this simulation)
  let comBodyX = 0;
  let comBodyY = 0;
  let comBodyZ = 0;

  const panelCentresWorld: Vector3[] = [];

  // Build per-panel body-frame hinge positions (needed for hierarchical panels)
  // panelHingeBody[i] = hinge position of panel i in body frame (live, angle-dependent for children)
  const panelHingeBody: Vector3[] = new Array(nPanels);

  for (let i = 0; i < nPanels; i++) {
    const spec = specs[i];
    const panel = state.panels[i];

    // ── 1. Mounting rotation quaternion (local → body frame) ────────────────
    const qMount = new Quaternion().setFromEuler(
      new Euler(spec.rot[0], spec.rot[1], spec.rot[2], 'XYZ'),
    );

    // ── 2. Hinge rotation quaternion (1-DOF deployment angle) ────────────────
    const aLocal = hingeAxisUnit(spec.axis);
    const currentAngle = panel.stuck ? panel.stuckAngle : panel.angle;
    const qHinge = new Quaternion().setFromAxisAngle(aLocal.clone().normalize(), currentAngle);

    // ── 3. Combined panel orientation in body frame ──────────────────────────
    //   q_panel_in_body = q_mount ⊗ q_hinge
    const qPanelInBody = qMount.clone().multiply(qHinge).normalize();

    // ── 4. Resolve hinge pivot position in body frame ────────────────────────
    //   Root panel: spec.hinge is directly in body frame
    //   Child panel: derived from parent panel's live orientation
    let hingeBodyVec: Vector3;

    if (spec.parentIndex !== undefined && spec.hingeOffset !== undefined) {
      // Child panel: hinge position = parent hinge + hingeOffset rotated by parent's body-frame quaternion
      const parentHinge = panelHingeBody[spec.parentIndex];
      const parentSpec = specs[spec.parentIndex];
      const parentPanel = state.panels[spec.parentIndex];

      const qParentMount = new Quaternion().setFromEuler(
        new Euler(parentSpec.rot[0], parentSpec.rot[1], parentSpec.rot[2], 'XYZ'),
      );
      const aParentLocal = hingeAxisUnit(parentSpec.axis);
      const parentAngle = parentPanel.stuck ? parentPanel.stuckAngle : parentPanel.angle;
      const qParentHinge = new Quaternion().setFromAxisAngle(
        aParentLocal.clone().normalize(), parentAngle,
      );
      const qParentInBody = qParentMount.clone().multiply(qParentHinge).normalize();

      const offsetLocal = new Vector3(
        spec.hingeOffset[0],
        spec.hingeOffset[1],
        spec.hingeOffset[2],
      );
      const offsetBody = offsetLocal.clone().applyQuaternion(qParentInBody);
      hingeBodyVec = parentHinge.clone().add(offsetBody);
    } else {
      hingeBodyVec = new Vector3(spec.hinge[0], spec.hinge[1], spec.hinge[2]);
    }

    panelHingeBody[i] = hingeBodyVec;

    // ── 5. Panel centre in body frame ────────────────────────────────────────
    //   spec.pos is the centre offset in LOCAL frame (before any rotation)
    //   Rotate by q_panel_in_body to get body-frame offset
    const posLocal = new Vector3(spec.pos[0], spec.pos[1], spec.pos[2]);
    const posInBody = posLocal.clone().applyQuaternion(qPanelInBody);
    const panelCentreBody = hingeBodyVec.clone().add(posInBody);

    // Accumulate mass-weighted CoM in body frame
    comBodyX += mPanel * panelCentreBody.x;
    comBodyY += mPanel * panelCentreBody.y;
    comBodyZ += mPanel * panelCentreBody.z;

    // ── 6. Panel centre in world frame ───────────────────────────────────────
    //   q_panel_world = q_body ⊗ q_panel_in_body
    const qPanelWorld = qBody.clone().multiply(qPanelInBody).normalize();
    const panelCentreWorld = hingeBodyVec
      .clone()
      .applyQuaternion(qBody)           // hinge in world
      .add(posLocal.clone().applyQuaternion(qPanelWorld)); // add rotated offset
    panelCentresWorld.push(panelCentreWorld);
  }

  // ── 7. Composite CoM in body frame ─────────────────────────────────────────
  // r_CoM_body = (m_body · 0 + Σ m_panel · r_panel_body) / M_total
  // Body contributes 0 because its CoM is the reference origin
  const comBody = new Vector3(comBodyX / mTotal, comBodyY / mTotal, comBodyZ / mTotal);

  // ── 8. Composite CoM in world frame ────────────────────────────────────────
  const comWorld = comBody.clone().applyQuaternion(qBody);

  // ── 9. Scalar offset from nominal (mm) ─────────────────────────────────────
  const offsetMm = comBody.length() * 1000;

  return { comBody, comWorld, offsetMm, panelCentresWorld };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hinge axis from panel spec
// ─────────────────────────────────────────────────────────────────────────────

/** Unit vector for hinge axis in spacecraft body frame. */
function hingeAxisUnit(axis: 'x' | 'y' | 'z'): Vector3 {
  switch (axis) {
    case 'x': return new Vector3(1, 0, 0);
    case 'y': return new Vector3(0, 1, 0);
    case 'z': return new Vector3(0, 0, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Initial state
// ─────────────────────────────────────────────────────────────────────────────

function createInitialPanels(config: ConfigType): PanelState[] {
  const specs = getPanelSpecs(config, DEFAULT_PARAMS);
  return specs.map(s => ({
    id: s.id,
    angle: 0,
    angularVelocity: 0,
    stuck: false,
    stuckAngle: 0,
    deployed: false,
    contactForce: 0,
    _q: new Quaternion(),
    _omega: new Vector3(0, 0, 0),
  }));
}

export function createInitialState(
  config: ConfigType,
  thermalParams?: ThermalParams,
  flexParams?: FlexParams,
): SpacecraftState {
  const panels = createInitialPanels(config);
  return {
    angularVelocity: new Vector3(0, 0, 0),
    angularAcceleration: new Vector3(0, 0, 0),
    orientation: new Vector3(0, 0, 0),
    panels,
    time: 0,
    deploying: false,
    _bodyQ: new Quaternion(),
    thermalState: thermalParams ? initThermalState(thermalParams) : undefined,
    thermalParams: thermalParams,
    flexState: flexParams ? panels.map(() => initFlexState(flexParams)) : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Simulation step  —  coupled quaternion rigid-body dynamics
// ─────────────────────────────────────────────────────────────────────────────

export function stepSimulation(
  state: SpacecraftState,
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
): SpacecraftState {
  if (!state.deploying) return state;

  const dt = params.timeStep;

  // ── Step thermal model (if active) ─────────────────────────────────────────
  let thermalState = state.thermalState;
  const thermalParams = state.thermalParams ?? params.thermal;
  if (thermalState && thermalParams) {
    thermalState = stepThermalState(thermalState, thermalParams, dt);
  }
  const specs = getPanelSpecs(config, params);

  // ── Current body state ────────────────────────────────────────────────────
  const Ib = bodyInertiaDiag(params);
  const qBody = state._bodyQ
    ? new Quaternion(state._bodyQ.x, state._bodyQ.y, state._bodyQ.z, state._bodyQ.w)
    : new Quaternion().setFromEuler(new Euler(state.orientation.x, state.orientation.y, state.orientation.z, 'XYZ'));
  const omegaBody = new Vector3(state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z); // world-frame

  // ── Conservation reference: capture H_total before panel updates ──────────
  // Following Hughes (1986) Ch. 3 and Wie (2008) §8.2:
  //   H_total = I_body·ω_body + Σ_i [I_panel_i · (ω_body + θ̇_i · â_i)]
  // We track H₀ so we can enforce conservation after updating panels.
  const H0 = computeTotalAngularMomentum(state, config, params);

  // ── Phase 1: per-panel hinge dynamics & accumulate body torque ─────────────
  const bodyTorqueWorld = new Vector3(0, 0, 0);

  interface PanelUpdate {
    thetaNew: number;
    omegaRelNew: number;
    deployedNew: boolean;
    contactForceNew: number;
    hingeTorque: number;
    thetaDDot: number;     // angular acceleration for flex model
    aBody: Vector3;        // physical hinge axis in body frame (rot-rotated)
    aLocal: Vector3;       // raw hinge axis in local frame (before rot)
    qMount: Quaternion;    // mounting rotation quaternion from spec.rot
  }
  const updates: PanelUpdate[] = [];

  for (let i = 0; i < state.panels.length; i++) {
    const panel = state.panels[i];
    const spec = specs[i];

    if (panel.stuck) {
      updates.push({
        thetaNew: panel.angle, omegaRelNew: 0, deployedNew: panel.deployed,
        contactForceNew: 0, hingeTorque: 0, thetaDDot: 0,
        aBody: new Vector3(0, 0, 0), aLocal: new Vector3(0, 0, 0), qMount: new Quaternion(),
      });
      continue;
    }

    // Once deployed, hold panel at stop angle — no further hinge dynamics needed
    if (panel.deployed) {
      const qMountD = new Quaternion().setFromEuler(new Euler(spec.rot[0], spec.rot[1], spec.rot[2], 'XYZ'));
      const aLocalD = hingeAxisUnit(spec.axis);
      const aBodyD = aLocalD.clone().applyQuaternion(qMountD.clone());
      updates.push({
        thetaNew: panel.angle, omegaRelNew: 0, deployedNew: true,
        contactForceNew: 0, hingeTorque: 0, thetaDDot: 0,
        aBody: aBodyD, aLocal: aLocalD, qMount: qMountD,
      });
      continue;
    }

    // Mounting rotation from spec.rot (transforms local panel frame → body frame)
    const qMount = new Quaternion().setFromEuler(new Euler(spec.rot[0], spec.rot[1], spec.rot[2], 'XYZ'));
    const aLocal = hingeAxisUnit(spec.axis);        // hinge axis in local frame
    const aBody = aLocal.clone().applyQuaternion(qMount.clone());       // physical hinge axis in body frame
    const aWorld = aBody.clone().applyQuaternion(qBody.clone());         // physical hinge axis in world frame

    // Panel inertia tensor (diagonal, panel body frame about hinge edge)
    const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

    // Panel orientation:  q_panel = q_body ⊗ q_mount ⊗ q_hinge_local(θ)
    const qHingeLocal = new Quaternion().setFromAxisAngle(aLocal.clone().normalize(), panel.angle);
    const qPanel = qBody.clone().multiply(qMount.clone()).multiply(qHingeLocal).normalize();

    const theta = panel.angle;
    const omegaRel = panel.angularVelocity;
    const deployDuration = params.hinge.deployDuration ?? 0;

    // ── Stage-aware deployment parameters ────────────────────────────────────
    const panelStage = spec.stage ?? 1;
    const panelMaxAngle = spec.maxAngle ?? params.hinge.stopAngle;
    const panelStartDelay = (() => {
      if (config === 'short-edge') {
        return params.hinge.shortEdgeStartDelays?.[i] ?? 0;
      }

      if (config === 'short-edge-long-edge' && panelStage === 3) {
        const coupledShortEdgeIndex = i - 4;
        if (coupledShortEdgeIndex >= 0 && coupledShortEdgeIndex < 4) {
          return params.hinge.shortEdgeStartDelays?.[coupledShortEdgeIndex] ?? 0;
        }
      }

      return 0;
    })();
    const panelStartTime = (panelStage - 1) * deployDuration + panelStartDelay;

    // Stage N panels wait until all earlier stages are fully deployed or stuck.
    const previousStagesComplete = panelStage <= 1 || state.panels.every((p, idx) => {
      const s = specs[idx];
      const candidateStage = s.stage ?? 1;
      return candidateStage >= panelStage || p.deployed || p.stuck;
    });

    let thetaNew: number, omegaRelNew: number, deployedNew: boolean;
    let contactForceNew: number, hingeTorque: number, thetaDDot: number;

    if (!previousStagesComplete) {
      // ── Waiting for previous stages — hold perfectly still ─────────────
      thetaNew = theta;
      omegaRelNew = 0;
      deployedNew = false;
      contactForceNew = 0;
      hingeTorque = 0;
      thetaDDot = 0;

    } else if ((state.time + dt) < panelStartTime) {
      // ── Delayed activation window — hold panel stowed until its start time ──
      thetaNew = theta;
      omegaRelNew = 0;
      deployedNew = false;
      contactForceNew = 0;
      hingeTorque = 0;
      thetaDDot = 0;

    } else if (deployDuration > 0) {
      // ── Kinematic ease-out deployment (stage-aware) ────────────────────────
      // Stage 1 panels deploy during [startDelay, startDelay + deployDuration]
      // Stage 2 panels deploy during [deployDuration + startDelay, 2*deployDuration + startDelay]
      const tNext = state.time + dt;
      const stageElapsed = tNext - panelStartTime;
      const progress = Math.min(Math.max(stageElapsed / deployDuration, 0), 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const targetAngle = panelMaxAngle * easeOut;

      omegaRelNew = (targetAngle - theta) / dt;
      thetaNew = targetAngle;
      deployedNew = progress >= 1;
      if (deployedNew) { thetaNew = panelMaxAngle; omegaRelNew = 0; }

      // Kinematic panels should not inject reaction torque into body dynamics.
      // Momentum conservation is enforced by the correction loop using the
      // prescribed panel angles.
      thetaDDot = (omegaRelNew - omegaRel) / dt;
      hingeTorque = 0;
      contactForceNew = 0;

    } else {
      // ── Physics-driven hinge (stage-aware) ─────────────────────────────────
      const h = params.hinge;
      // Use panel-specific max angle as the target stop angle
      const stopAngle = panelMaxAngle;

      let tau: number;
      if (h.hingeModel === 'bistable' && h.bistability) {
        // ── Bistable tape-spring double-well potential ────────────────────────
        // U(θ) = A·θ²·(θ − θ_max)² − τ_preload·θ
        // τ(θ) = −dU/dθ = −2A·θ·(θ − θ_max)·(2θ − θ_max) + τ_preload
        // Ref: Seffen & Pellegrino 1999; Mallikarachchi & Pellegrino 2011
        const A = h.bistability.bistabilityCoeff;
        tau = -2 * A * theta * (theta - stopAngle) * (2 * theta - stopAngle) + h.preloadTorque;
      } else {
        // ── Linear spring-damper (default) ───────────────────────────────────
        // Apply thermal stiffness multiplier if thermal model is active
        const effectiveSpringConstant = thermalState && thermalParams
          ? applyThermalStiffness(h.springConstant, thermalState, thermalParams)
          : h.springConstant;
        tau = effectiveSpringConstant * (stopAngle - theta) + h.preloadTorque;
      }

      // Viscous damping and Coulomb friction (common to both models)
      tau -= h.dampingCoeff * omegaRel;
      tau -= Math.sign(omegaRel) * h.frictionCoeff;

      // Mechanical stop at panel's max angle
      let tContact = 0;
      if (theta >= stopAngle) {
        const penetration = theta - stopAngle;
        tContact = -h.stopStiffness * penetration - h.stopDamping * omegaRel;
        tau += tContact;
      }

      hingeTorque = tau;
      contactForceNew = Math.abs(tContact);

      // Full 3D panel angular acceleration:  α_panel = I_panel_world⁻¹ · (τ · â_world)
      const tauVecWorld = aWorld.clone().multiplyScalar(tau);
      const alphaPanelWorld = applyInverseInertia(Ip, qPanel, tauVecWorld);

      // Project onto hinge axis for 1-DOF constraint:  θ̈ = α_panel · â
      thetaDDot = alphaPanelWorld.dot(aWorld);

      // Semi-implicit Euler (velocity first)
      omegaRelNew = omegaRel + thetaDDot * dt;
      thetaNew = theta + omegaRelNew * dt;

      if (thetaNew < 0) { thetaNew = 0; omegaRelNew = 0; }
      deployedNew = thetaNew >= stopAngle && Math.abs(omegaRelNew) < 0.1;
      if (deployedNew) { thetaNew = stopAngle; omegaRelNew = 0; }
    }

    updates.push({ thetaNew, omegaRelNew, deployedNew, contactForceNew, hingeTorque, thetaDDot, aBody, aLocal, qMount });

    // Accumulate equal-and-opposite reaction on body:  τ_body += −τ · â_world
    const aWorld2 = aBody.clone().applyQuaternion(qBody.clone());
    bodyTorqueWorld.x -= hingeTorque * aWorld2.x;
    bodyTorqueWorld.y -= hingeTorque * aWorld2.y;
    bodyTorqueWorld.z -= hingeTorque * aWorld2.z;
  }

  // ── Phase 1b: Update flexible panel dynamics (if enabled) ─────────────────
  // Step the Craig-Bampton modal dynamics for each panel using thetaDDot
  const flexParams = params.flex;
  let newFlexState = state.flexState;
  if (flexParams && newFlexState) {
    newFlexState = newFlexState.map((fs, i) => {
      const up = updates[i];
      return stepFlexState(
        fs,
        flexParams,
        up.thetaDDot,
        dt,
        specs[i].size[0], // panel length
        params.panelMass,
      );
    });
  }

  // ── Phase 2: body rotational dynamics (RK4 + conservation correction) ─────
  // Integrate spacecraft body attitude using 4th-order Runge-Kutta.
  // External torque = hinge reaction torques + gravity gradient disturbance.
  // Then apply angular-momentum conservation correction as per Hughes (1986) Ch. 3.

  // Compute gravity gradient torque and add to body torque
  const totalBodyTorqueWorld = bodyTorqueWorld.clone();
  if (params.gravityGradientEnabled !== false) {
    const altM = params.orbitAltitudeM ?? 400_000;
    const ggTorque = computeGravityGradientTorque(Ib, qBody, state.time, altM);
    totalBodyTorqueWorld.x += ggTorque.x;
    totalBodyTorqueWorld.y += ggTorque.y;
    totalBodyTorqueWorld.z += ggTorque.z;
  }

  // Step 2a: RK4 integration for body (predictor step)
  const { qBodyNew: qBodyRK4, omegaBodyNew: omegaBodyRK4 } = integrateBodyRK4(
    qBody, omegaBody, totalBodyTorqueWorld, Ib, dt,
  );

  // Step 2b-2c: Iterative conservation correction
  // The panel momentum depends on body velocity: H_panel_i = I_i · (ω_body + θ̇_i · â_i)
  // We need to iterate to solve: ω_body = I_body⁻¹ · (H₀ − H_panels(ω_body))
  // Start with RK4 prediction and iterate 3 times for convergence.

  let omegaBodyIter = omegaBodyRK4.clone();
  const MAX_ITERS = 5;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // Compute panel angular momentum contribution using current body velocity estimate
    const H_panels = new Vector3(0, 0, 0);

    for (let i = 0; i < state.panels.length; i++) {
      const panel = state.panels[i];
      const spec = specs[i];
      const up = updates[i];

      // Stuck panels still co-rotate with the body, so they contribute inertia
      // with zero relative hinge rate.
      const qMountIter = new Quaternion().setFromEuler(
        new Euler(spec.rot[0], spec.rot[1], spec.rot[2], 'XYZ'),
      );
      const aLocalIter = hingeAxisUnit(spec.axis);
      const thetaIter = panel.stuck ? panel.stuckAngle : up.thetaNew;
      const omegaRelIter = panel.stuck ? 0 : up.omegaRelNew;

      // Panel inertia tensor (diagonal, panel body frame about hinge edge)
      const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

      // Panel orientation using RK4-predicted body orientation:
      // q_panel = q_body_RK4 ⊗ q_mount ⊗ q_hinge_local(θ_new)
      const qHingeNew = new Quaternion().setFromAxisAngle(aLocalIter.clone().normalize(), thetaIter);
      const qPanelNew = qBodyRK4.clone().multiply(qMountIter.clone()).multiply(qHingeNew).normalize();

      // Hinge axis in world frame (using RK4-predicted body orientation)
      const aBodyIter = aLocalIter.clone().applyQuaternion(qMountIter.clone());
      const aWorldNew = aBodyIter.clone().applyQuaternion(qBodyRK4.clone());

      // Panel angular velocity: ω_panel = ω_body_iter + θ̇_new · â_world
      const omegaPanelNew = omegaBodyIter.clone().add(aWorldNew.clone().multiplyScalar(omegaRelIter));

      // Rotate ω to panel body frame, apply diagonal inertia, rotate back
      const omegaPanelLocal = omegaPanelNew.clone().applyQuaternion(qPanelNew.clone().conjugate());
      const HpanelLocal = applyInertia(Ip, omegaPanelLocal);
      const HpanelWorld = HpanelLocal.clone().applyQuaternion(qPanelNew.clone());

      H_panels.x += HpanelWorld.x;
      H_panels.y += HpanelWorld.y;
      H_panels.z += HpanelWorld.z;
    }

    // Enforce conservation — derive body angular velocity
    // H_body = H_total_initial - H_panels  (for free-float, H_total is conserved)
    // ω_body_conserved = R_body · I_body_diag^{-1} · R_body^T · H_body
    const H_body_required = new Vector3(H0.x - H_panels.x, H0.y - H_panels.y, H0.z - H_panels.z);

    // Transform H_body to body frame, divide by principal inertia, transform back
    const H_body_local = H_body_required.clone().applyQuaternion(qBodyRK4.clone().conjugate());
    const omegaConserved = new Vector3(H_body_local.x / Ib.x, H_body_local.y / Ib.y, H_body_local.z / Ib.z);
    omegaBodyIter = omegaConserved.clone().applyQuaternion(qBodyRK4.clone());
  }

  const omegaConservedWorld = omegaBodyIter;

  // Step 2d: Cross-check RK4 vs conservation — warn if discrepancy > 1%
  const H0mag = Math.sqrt(H0.x * H0.x + H0.y * H0.y + H0.z * H0.z);
  const deltaOmega = omegaConservedWorld.clone().sub(omegaBodyRK4);
  const deltaOmegaMag = Math.sqrt(deltaOmega.x * deltaOmega.x + deltaOmega.y * deltaOmega.y + deltaOmega.z * deltaOmega.z);
  const omegaRK4Mag = Math.sqrt(omegaBodyRK4.x * omegaBodyRK4.x + omegaBodyRK4.y * omegaBodyRK4.y + omegaBodyRK4.z * omegaBodyRK4.z);
  const relativeError = omegaRK4Mag > 1e-12 ? deltaOmegaMag / omegaRK4Mag : (H0mag > 1e-12 ? deltaOmegaMag : 0);

  if (relativeError > 0.01 && H0mag > 1e-9) {
    // Log at debug level — this can happen during high-dynamics phases
    if (typeof console !== 'undefined' && console.debug) {
      console.debug(
        `[momentum] t=${(state.time + dt).toFixed(3)}s: RK4 vs conservation ` +
        `Δω/ω = ${(relativeError * 100).toFixed(2)}% (> 1% threshold)`,
      );
    }
  }

  // Step 2e: Apply conservation-derived ω as correction (prevents drift)
  // Use conserved ω for body dynamics when in free-float (τ_external ≈ 0)
  // For gravity gradient or other external torques, blend RK4 and conserved values
  const hasExternalTorque = params.gravityGradientEnabled !== false;
  let qBodyNew: Quaternion;
  let omegaBodyNew: Vector3;

  if (!hasExternalTorque || H0mag < 1e-9) {
    // Pure free-float: use conservation-derived ω directly
    qBodyNew = qBodyRK4;
    omegaBodyNew = omegaConservedWorld;
  } else {
    // With external torque: use RK4 but apply small conservation correction
    // to prevent cumulative drift from panel momentum exchange
    // Blend: 90% RK4 (captures external torque) + 10% conservation correction
    const blendFactor = 0.1;
    qBodyNew = qBodyRK4;
    omegaBodyNew = omegaBodyRK4.clone().add(deltaOmega.clone().multiplyScalar(blendFactor));
  }

  // Approximate angular acceleration from finite difference (for telemetry)
  const alphaWorld = omegaBodyNew.clone().sub(omegaBody).multiplyScalar(1 / dt);

  // ── Phase 3: assemble new panel states with derived quaternions ────────────
  const newPanels: PanelState[] = state.panels.map((panel, i) => {
    const up = updates[i];

    if (panel.stuck) {
      return { ...panel, _q: panel._q ?? new Quaternion(), _omega: panel._omega ?? new Vector3(0, 0, 0) };
    }

    // Derive panel quaternion:  q_panel = q_body ⊗ q_mount ⊗ q_hinge_local(θ)
    const qHingeNew = new Quaternion().setFromAxisAngle(up.aLocal.clone().normalize(), up.thetaNew);
    const qPanelNew = qBodyNew.clone().multiply(up.qMount.clone()).multiply(qHingeNew).normalize();

    // Panel world-frame angular velocity:  ω_panel = ω_body + θ̇ · â_world(new)
    const aWorldNew = up.aBody.clone().applyQuaternion(qBodyNew.clone());
    const omegaPanelNew = omegaBodyNew.clone().add(aWorldNew.clone().multiplyScalar(up.omegaRelNew));

    // Get tip deflection from flex state (if enabled)
    const tipDeflectionDeg = newFlexState?.[i]?.tipDeflectionDeg;

    return {
      ...panel,
      angle: up.thetaNew,
      angularVelocity: up.omegaRelNew,
      deployed: up.deployedNew,
      contactForce: up.contactForceNew,
      _q: qPanelNew,
      _omega: omegaPanelNew,
      tipDeflectionDeg,
    };
  });

  // ── Map to legacy state ────────────────────────────────────────────────────
  const e = new Euler().setFromQuaternion(qBodyNew.clone(), 'XYZ');
  const euler = new Vector3(e.x, e.y, e.z);
  const allDeployed = newPanels.every(p => p.deployed || p.stuck);

  return {
    angularVelocity: omegaBodyNew,
    angularAcceleration: alphaWorld,
    orientation: euler,
    panels: newPanels,
    time: state.time + dt,
    deploying: !allDeployed,
    _bodyQ: qBodyNew,
    thermalState,
    thermalParams,
    flexState: newFlexState,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Full simulation runner (API unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulationFrame {
  time: number;
  angularVelocity: Vector3;
  angularAcceleration: Vector3;
  panelAngles: number[];
  contactForces: number[];
  totalContactForce: number;
  /** Relative angular momentum error |H - H₀| / |H₀| (dimensionless). 0 when H₀ ≈ 0. */
  momentumError: number;
  /** Current thermal temperature in °C (undefined if thermal model inactive). */
  thermalTemperatureDeg?: number;
  /** Thermal stiffness multiplier (undefined if thermal model inactive). */
  stiffnessMultiplier?: number;
  /** Gravity gradient torque magnitude at this timestep (N·m). */
  gravityGradientTorqueMag?: number;
  /**
   * Cumulative body attitude rotation (in degrees) caused purely by panel deployment
   * angular momentum exchange — body Euler-angle change from t=0 to current frame.
   */
  attitudeCouplingDeg?: number;
  /** Panel tip deflections in degrees (undefined if flex model inactive). */
  tipDeflectionDeg?: number[];
  /**
   * Rotational kinetic energy of the spacecraft body at this timestep (mJ).
   *
   * Defined as the scalar rotational KE of the body alone (not panels),
   * expressed in the body principal frame:
   *
   *   E = ½ · (Ixx·ωx² + Iyy·ωy² + Izz·ωz²)
   *
   * where ω components are the body angular velocity projected onto the
   * principal axes (body frame), and Ixx/Iyy/Izz are the diagonal
   * principal moments of inertia from bodyInertiaDiag().
   *
   * Converted to millijoules (× 1000) for readability in telemetry.
   *
   * During free tumble this value is constant (energy conserved).
   * During panel deployment it changes as angular momentum redistributes
   * between the body and deploying panels — a decrease indicates energy
   * being transferred into panel rotational motion (desirable for passive
   * detumbling via the "scissors" effect).
   *
   * In active B-dot detumbling this metric is the primary convergence
   * indicator — detumbling is complete when E_detumble → 0.
   *
   * Reference: Hughes, P. C. (1986). Spacecraft Attitude Dynamics.
   * Wiley, Chapter 4 — rotational kinetic energy of a rigid body.
   *
   * Units: millijoules (mJ)
   */
  eDetumble: number;
}

export function runFullSimulation(
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
  maxTime: number = 10,
  stuckPanels: number[] = [],
): SimulationFrame[] {
  let state = createInitialState(config, params.thermal, params.flex);
  state.deploying = true;

  // Apply stuck panels
  for (const idx of stuckPanels) {
    if (idx < state.panels.length) {
      state.panels[idx].stuck = true;
      state.panels[idx].stuckAngle = 0;
    }
  }

  const frames: SimulationFrame[] = [];
  const maxSteps = Math.ceil(maxTime / params.timeStep);

  // ── Angular momentum conservation tracking ─────────────────────────────
  const H0 = computeTotalAngularMomentum(state, config, params);
  const H0mag = Math.sqrt(H0.x * H0.x + H0.y * H0.y + H0.z * H0.z);

  // ── Attitude coupling tracking (cumulative rotation from t=0) ──────────
  const q0 = state._bodyQ
    ? new Quaternion(state._bodyQ.x, state._bodyQ.y, state._bodyQ.z, state._bodyQ.w)
    : new Quaternion();

  for (let i = 0; i < maxSteps; i++) {
    state = stepSimulation(state, config, params);

    // ── Periodic momentum conservation check (every 60 frames ≈ 1 s) ─────
    let momentumError = 0;
    if (i % 60 === 59 || i % 3 === 0) {
      const Hcur = computeTotalAngularMomentum(state, config, params);
      const dH = {
        x: Hcur.x - H0.x,
        y: Hcur.y - H0.y,
        z: Hcur.z - H0.z,
      };
      const dHmag = Math.sqrt(dH.x * dH.x + dH.y * dH.y + dH.z * dH.z);
      momentumError = H0mag > 1e-12 ? dHmag / H0mag : dHmag;

      // Warn on > 5% violation (only on the 60-frame check cadence)
      if (i % 60 === 59 && momentumError > 0.05) {
        console.warn(
          `[momentum] t=${state.time.toFixed(3)}s: angular momentum error ` +
          `${(momentumError * 100).toFixed(2)}% exceeds 5% threshold`,
        );
      }
    }

    // Record every 3rd frame for chart data
    if (i % 3 === 0) {
      // Compute attitude coupling: rotation angle from initial to current orientation
      // q_rel = q_current ⊗ q_0* → extract angle: θ = 2·acos(|w|)
      const qCur = state._bodyQ ?? new Quaternion();
      const qRel = qCur.clone().multiply(q0.clone().conjugate());
      const attitudeCouplingRad = 2 * Math.acos(MathUtils.clamp(Math.abs(qRel.w), -1, 1));
      const attitudeCouplingDeg = MathUtils.radToDeg(attitudeCouplingRad);

      const eDetumbleMJ = computeEDetumble(
        state.angularVelocity,
        state._bodyQ ?? new Quaternion(),
        params,
      );

      frames.push({
        time: Math.round(state.time * 1000) / 1000,
        angularVelocity: state.angularVelocity.clone(),
        angularAcceleration: state.angularAcceleration.clone(),
        panelAngles: state.panels.map(p => p.angle),
        contactForces: state.panels.map(p => p.contactForce),
        totalContactForce: state.panels.reduce((s, p) => s + p.contactForce, 0),
        momentumError,
        thermalTemperatureDeg: state.thermalState?.currentTemperatureDeg,
        stiffnessMultiplier: state.thermalState?.stiffnessMultiplier,
        gravityGradientTorqueMag: params.gravityGradientEnabled !== false
          ? (() => {
              const altM = params.orbitAltitudeM ?? 400_000;
              const gg = computeGravityGradientTorque(
                bodyInertiaDiag(params),
                state._bodyQ ?? new Quaternion(),
                state.time,
                altM,
              );
              return Math.sqrt(gg.x * gg.x + gg.y * gg.y + gg.z * gg.z);
            })()
          : undefined,
        attitudeCouplingDeg,
        tipDeflectionDeg: state.flexState
          ? state.panels.map(p => p.tipDeflectionDeg ?? 0)
          : undefined,
        eDetumble: Math.round(eDetumbleMJ * 1000) / 1000,
      });
    }

    if (!state.deploying && state.time > 0.5) break;
  }

  return frames;
}
