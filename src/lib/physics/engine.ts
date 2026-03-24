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
  type Vector3,
  type Quaternion,
  type ThermalParams,
  type FlexParams,
  DEFAULT_PARAMS,
} from './types';

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
import * as THREE from 'three';
import { GM_EARTH, R_EARTH as R_EARTH_M } from './orbitalTorques';

function isSimDebugEnabled(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const g = globalThis as { __SIM_DEBUG__?: boolean };
  return g.__SIM_DEBUG__ === true;
}

function vec3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function vecFrom(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function cloneVec(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function quatIdentity(): THREE.Quaternion {
  return new THREE.Quaternion();
}

function quatFromLike(q: { w: number; x: number; y: number; z: number }): THREE.Quaternion {
  return new THREE.Quaternion(q.x, q.y, q.z, q.w);
}

function quatFromEuler(e: { x: number; y: number; z: number }): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(e.x, e.y, e.z, 'XYZ'));
}

function quatAxisAngle(axis: THREE.Vector3, angle: number): THREE.Quaternion {
  if (axis.lengthSq() < 1e-24) return quatIdentity();
  return new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), angle);
}

function rotateVec(q: THREE.Quaternion, v: THREE.Vector3): THREE.Vector3 {
  return v.clone().applyQuaternion(q);
}

function eulerFromQuat(q: THREE.Quaternion): THREE.Vector3 {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return new THREE.Vector3(e.x, e.y, e.z);
}

function addVec(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b);
}

function subVec(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().sub(b);
}

function scaleVec(v: THREE.Vector3, s: number): THREE.Vector3 {
  return v.clone().multiplyScalar(s);
}

function dotVec(a: THREE.Vector3, b: THREE.Vector3): number {
  return a.dot(b);
}

function crossVec(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3().crossVectors(a, b);
}

function mulQuat(a: THREE.Quaternion, b: THREE.Quaternion): THREE.Quaternion {
  return a.clone().multiply(b);
}

function conjQuat(q: THREE.Quaternion): THREE.Quaternion {
  return q.clone().conjugate();
}

function normQuat(q: THREE.Quaternion): THREE.Quaternion {
  return q.clone().normalize();
}

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
function bodyInertiaDiag(params: SimulationParams): THREE.Vector3 {
  const w = params.bodyWidth;
  const h = params.bodyHeight;
  const d = params.bodyDepth;
  const m = params.bodyMass;
  return new THREE.Vector3(
    (1 / 12) * m * (h * h + d * d),
    (1 / 12) * m * (w * w + d * d),
    (1 / 12) * m * (w * w + h * h),
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
function panelInertiaDiag(m: number, L: number, W: number, t: number): THREE.Vector3 {
  return new THREE.Vector3(
    (1 / 12) * m * (W * W + t * t),
    (1 / 3) * m * L * L + (1 / 12) * m * W * W,
    (1 / 3) * m * L * L + (1 / 12) * m * t * t,
  );
}

/**
 * Solve  α = I_world⁻¹ · τ_world  without forming the full 3×3.
 * Strategy: rotate τ into body frame → divide by diagonal I → rotate back.
 */
function inertiaInvMul(
  Idiag: THREE.Vector3,
  q: THREE.Quaternion,
  torqueWorld: THREE.Vector3,
): THREE.Vector3 {
  const tBody = torqueWorld.clone().applyQuaternion(q.clone().conjugate());
  const aBody = new THREE.Vector3(tBody.x / Idiag.x, tBody.y / Idiag.y, tBody.z / Idiag.z);
  return aBody.applyQuaternion(q);
}

/** I_body · ω  (diagonal body frame). */
function inertiaMul(Idiag: THREE.Vector3, w: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(Idiag.x * w.x, Idiag.y * w.y, Idiag.z * w.z);
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
  Ib: THREE.Vector3,
  qBody: THREE.Quaternion,
  t: number,
  altitudeM: number,
): THREE.Vector3 {
  // Orbital mechanics
  const R = R_EARTH_M + altitudeM;           // orbit radius (m)
  const T_orbit = 2 * Math.PI * Math.sqrt((R * R * R) / GM_EARTH); // period (s)
  const n = (2 * Math.PI) / T_orbit;       // mean motion (rad/s)

  // Nadir unit vector in world frame: points from spacecraft toward Earth centre.
  // For equatorial circular orbit in our convention (X=right, Y=forward, Z=up),
  // nadir rotates in the Y-Z plane as the satellite orbits.
  const nadirWorld = new THREE.Vector3(0, -Math.sin(n * t), -Math.cos(n * t));

  // Transform nadir to body frame: r̂_body = q* ⊗ r̂_world
  const nadirBody = rotateVec(qBody.clone().conjugate(), nadirWorld);
  const rx = nadirBody.x;
  const ry = nadirBody.y;
  const rz = nadirBody.z;

  // Gravity gradient factor: 3μ/R³
  const factor = (3 * GM_EARTH) / (R * R * R);

  // Body-frame torque components (Hughes 1986, Eq. 3.3.10)
  const tauBodyX = factor * (Ib.z - Ib.y) * ry * rz;
  const tauBodyY = factor * (Ib.x - Ib.z) * rz * rx;
  const tauBodyZ = factor * (Ib.y - Ib.x) * rx * ry;
  const tauBody = new THREE.Vector3(tauBodyX, tauBodyY, tauBodyZ);

  // Rotate torque back to world frame for accumulation with hinge torques
  return rotateVec(qBody, tauBody);
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
  qBody: THREE.Quaternion,
  omegaBody: THREE.Vector3,
  torqueWorld: THREE.Vector3,
  Ib: THREE.Vector3,
  dt: number,
): { qBodyNew: THREE.Quaternion; omegaBodyNew: THREE.Vector3 } {
  const qIn = quatFromLike(qBody as unknown as { w: number; x: number; y: number; z: number });
  const omegaIn = vecFrom(omegaBody as unknown as { x: number; y: number; z: number });
  const torqueIn = vecFrom(torqueWorld as unknown as { x: number; y: number; z: number });
  const inertiaIn = vecFrom(Ib as unknown as { x: number; y: number; z: number });

  // State vector: [qw, qx, qy, qz, wx, wy, wz]
  const y0 = [qIn.w, qIn.x, qIn.y, qIn.z, omegaIn.x, omegaIn.y, omegaIn.z];

  const deriv = (y: number[]): number[] => {
    const [qw, qx, qy, qz, wx, wy, wz] = y;
    const q = new THREE.Quaternion(qx, qy, qz, qw).normalize();
    const omega = new THREE.Vector3(wx, wy, wz);

    // dq/dt = 0.5 * [0, omega_world] ⊗ q
    const omegaQ = new THREE.Quaternion(omega.x, omega.y, omega.z, 0);
    const qDot = omegaQ.clone().multiply(q);
    const dqw = 0.5 * qDot.w;
    const dqx = 0.5 * qDot.x;
    const dqy = 0.5 * qDot.y;
    const dqz = 0.5 * qDot.z;

    // Euler's equation: dω/dt = I⁻¹(τ - ω×(Iω))
    const omegaBodyLocal = omega.clone().applyQuaternion(q.clone().conjugate());
    const Iomega = new THREE.Vector3(
      inertiaIn.x * omegaBodyLocal.x,
      inertiaIn.y * omegaBodyLocal.y,
      inertiaIn.z * omegaBodyLocal.z,
    );
    const IomegaWorld = Iomega.applyQuaternion(q);
    const gyro = new THREE.Vector3().crossVectors(omega, IomegaWorld);
    const netTau = torqueIn.clone().sub(gyro);
    const tBody2 = netTau.clone().applyQuaternion(q.clone().conjugate());
    const aBody2 = new THREE.Vector3(
      tBody2.x / inertiaIn.x,
      tBody2.y / inertiaIn.y,
      tBody2.z / inertiaIn.z,
    );
    const dOmega = aBody2.applyQuaternion(q);

    return [dqw, dqx, dqy, dqz, dOmega.x, dOmega.y, dOmega.z];
  };

  const k1 = deriv(y0);
  const yk2 = y0.map((v, i) => v + 0.5 * dt * k1[i]);
  const k2 = deriv(yk2);
  const yk3 = y0.map((v, i) => v + 0.5 * dt * k2[i]);
  const k3 = deriv(yk3);
  const yk4 = y0.map((v, i) => v + dt * k3[i]);
  const k4 = deriv(yk4);

  const yFinal = y0.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));

  const [qw, qx, qy, qz, wx, wy, wz] = yFinal;
  return {
    qBodyNew: new THREE.Quaternion(qx, qy, qz, qw).normalize(),
    omegaBodyNew: new THREE.Vector3(wx, wy, wz),
  };
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
  const qBody = state._bodyQ ? quatFromLike(state._bodyQ) : quatFromEuler(state.orientation);
  const omegaBody = vecFrom(state.angularVelocity);

  // ── Body contribution: H_body = R_body · I_body_diag · R_body^T · ω_body ──
  const Ib = bodyInertiaDiag(params);
  const omegaBodyLocal = rotateVec(conjQuat(qBody), omegaBody);
  const HbodyLocal = inertiaMul(Ib, omegaBodyLocal);
  const Htotal: Vector3 = cloneVec(rotateVec(qBody, HbodyLocal));

  // ── Panel contributions ────────────────────────────────────────────────────
  for (let i = 0; i < state.panels.length; i++) {
    const panel = state.panels[i];
    const spec = specs[i];

    // Panel inertia tensor (diagonal, panel body frame about hinge edge)
    const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

    // Panel orientation quaternion
    const qMount = quatFromEuler(vec3(spec.rot[0], spec.rot[1], spec.rot[2]));
    const aLocal = hingeAxisUnit(spec.axis);
    const aBody = rotateVec(qMount, aLocal);
    const aWorld = rotateVec(qBody, aBody);

    const qHinge = quatAxisAngle(aLocal, panel.angle);
    const qPanel = normQuat(mulQuat(mulQuat(qBody, qMount), qHinge));

    // Panel angular velocity in world frame: ω_panel = ω_body + θ̇ · â_world
    const omegaPanel = addVec(omegaBody, scaleVec(aWorld, panel.angularVelocity));

    // Rotate ω to panel body frame, apply diagonal inertia, rotate back
    const omegaPanelLocal = rotateVec(conjQuat(qPanel), omegaPanel);
    const HpanelLocal = inertiaMul(Ip, omegaPanelLocal);
    const HpanelWorld = rotateVec(qPanel, HpanelLocal);

    Htotal.x += HpanelWorld.x;
    Htotal.y += HpanelWorld.y;
    Htotal.z += HpanelWorld.z;
  }

  return Htotal;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hinge axis from panel spec
// ─────────────────────────────────────────────────────────────────────────────

/** Unit vector for hinge axis in spacecraft body frame. */
function hingeAxisUnit(axis: 'x' | 'y' | 'z'): THREE.Vector3 {
  switch (axis) {
    case 'x': return vec3(1, 0, 0);
    case 'y': return vec3(0, 1, 0);
    case 'z': return vec3(0, 0, 1);
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
    _q: quatIdentity(),
    _omega: vec3(0, 0, 0),
  }));
}

export function createInitialState(
  config: ConfigType,
  thermalParams?: ThermalParams,
  flexParams?: FlexParams,
): SpacecraftState {
  const panels = createInitialPanels(config);
  return {
    angularVelocity: vec3(0, 0, 0),
    angularAcceleration: vec3(0, 0, 0),
    orientation: vec3(0, 0, 0),
    panels,
    time: 0,
    deploying: false,
    _bodyQ: quatIdentity(),
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
  const qBody = state._bodyQ ? quatFromLike(state._bodyQ) : quatFromEuler(state.orientation);
  const omegaBody = cloneVec(state.angularVelocity); // world-frame

  // ── Conservation reference: capture H_total before panel updates ──────────
  // Following Hughes (1986) Ch. 3 and Wie (2008) §8.2:
  //   H_total = I_body·ω_body + Σ_i [I_panel_i · (ω_body + θ̇_i · â_i)]
  // We track H₀ so we can enforce conservation after updating panels.
  const H0 = computeTotalAngularMomentum(state, config, params);

  // ── Phase 1: per-panel hinge dynamics & accumulate body torque ─────────────
  const bodyTorqueWorld = vec3(0, 0, 0);

  interface PanelUpdate {
    thetaNew: number;
    omegaRelNew: number;
    deployedNew: boolean;
    contactForceNew: number;
    hingeTorque: number;
    thetaDDot: number;     // angular acceleration for flex model
    aBody: THREE.Vector3;        // physical hinge axis in body frame (rot-rotated)
    aLocal: THREE.Vector3;       // raw hinge axis in local frame (before rot)
    qMount: THREE.Quaternion;    // mounting rotation quaternion from spec.rot
  }
  const updates: PanelUpdate[] = [];

  for (let i = 0; i < state.panels.length; i++) {
    const panel = state.panels[i];
    const spec = specs[i];

    if (panel.stuck) {
      updates.push({
        thetaNew: panel.angle, omegaRelNew: 0, deployedNew: panel.deployed,
        contactForceNew: 0, hingeTorque: 0, thetaDDot: 0,
        aBody: vec3(0, 0, 0), aLocal: vec3(0, 0, 0), qMount: quatIdentity(),
      });
      continue;
    }

    // Once deployed, hold panel at stop angle — no further hinge dynamics needed
    if (panel.deployed) {
      const qMountD = quatFromEuler(vec3(spec.rot[0], spec.rot[1], spec.rot[2]));
      const aLocalD = hingeAxisUnit(spec.axis);
      const aBodyD = rotateVec(qMountD, aLocalD);
      updates.push({
        thetaNew: panel.angle, omegaRelNew: 0, deployedNew: true,
        contactForceNew: 0, hingeTorque: 0, thetaDDot: 0,
        aBody: aBodyD, aLocal: aLocalD, qMount: qMountD,
      });
      continue;
    }

    // Mounting rotation from spec.rot (transforms local panel frame → body frame)
    const qMount = quatFromEuler(vec3(spec.rot[0], spec.rot[1], spec.rot[2]));
    const aLocal = hingeAxisUnit(spec.axis);        // hinge axis in local frame
    const aBody = rotateVec(qMount, aLocal);       // physical hinge axis in body frame
    const aWorld = rotateVec(qBody, aBody);         // physical hinge axis in world frame

    // Panel inertia tensor (diagonal, panel body frame about hinge edge)
    const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

    // Panel orientation:  q_panel = q_body ⊗ q_mount ⊗ q_hinge_local(θ)
    const qHingeLocal = quatAxisAngle(aLocal, panel.angle);
    const qPanel = normQuat(mulQuat(mulQuat(qBody, qMount), qHingeLocal));

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

    // A stage-N panel must wait until all prior stages are fully deployed/stuck.
    const previousStagesComplete = panelStage <= 1 || state.panels.every((p, idx) => {
      const s = specs[idx];
      const candidateStage = s.stage ?? 1;
      return candidateStage >= panelStage || p.deployed || p.stuck;
    });

    let thetaNew: number, omegaRelNew: number, deployedNew: boolean;
    let contactForceNew: number, hingeTorque: number, thetaDDot: number;

    if (!previousStagesComplete) {
      // ── Waiting for prior stages — hold perfectly still ────────────────
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

      // Effective hinge-axis inertia via full tensor:  I_eff = 1 / (â · I⁻¹ · â)
      const alphaUnit = inertiaInvMul(Ip, qPanel, aWorld);
      const Ieff = 1 / dotVec(alphaUnit, aWorld);

      // Equivalent torque τ = I_eff · θ̈  (reaction couples to body)
      thetaDDot = (omegaRelNew - omegaRel) / dt;
      hingeTorque = Ieff * thetaDDot;
      contactForceNew = 0;

    } else {
      // ── Physics-driven hinge (stage-aware) ─────────────────────────────────
      const h = params.hinge as typeof params.hinge & {
        hingeModel?: string;
        bistability?: { bistabilityCoeff: number };
      };
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
      const tauVecWorld = scaleVec(aWorld, tau);
      const alphaPanelWorld = inertiaInvMul(Ip, qPanel, tauVecWorld);

      // Project onto hinge axis for 1-DOF constraint:  θ̈ = α_panel · â
      thetaDDot = dotVec(alphaPanelWorld, aWorld);

      // Semi-implicit Euler (velocity first)
      omegaRelNew = omegaRel + thetaDDot * dt;
      thetaNew = theta + omegaRelNew * dt;

      if (thetaNew < 0) { thetaNew = 0; omegaRelNew = 0; }
      deployedNew = thetaNew >= stopAngle && Math.abs(omegaRelNew) < 0.1;
      if (deployedNew) { thetaNew = stopAngle; omegaRelNew = 0; }
    }

    updates.push({ thetaNew, omegaRelNew, deployedNew, contactForceNew, hingeTorque, thetaDDot, aBody, aLocal, qMount });

    // Accumulate equal-and-opposite reaction on body:  τ_body += −τ · â_world
    const aWorld2 = rotateVec(qBody, aBody);
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
  const totalBodyTorqueWorld = cloneVec(bodyTorqueWorld);
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

  let omegaBodyIter = cloneVec(omegaBodyRK4);
  const MAX_ITERS = 5;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // Compute panel angular momentum contribution using current body velocity estimate
    let H_panels = vec3(0, 0, 0);

    for (let i = 0; i < state.panels.length; i++) {
      const panel = state.panels[i];
      const spec = specs[i];
      const up = updates[i];

      if (panel.stuck) continue;

      // Panel inertia tensor (diagonal, panel body frame about hinge edge)
      const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

      // Panel orientation using RK4-predicted body orientation:
      // q_panel = q_body_RK4 ⊗ q_mount ⊗ q_hinge_local(θ_new)
      const qHingeNew = quatAxisAngle(up.aLocal, up.thetaNew);
      const qPanelNew = normQuat(mulQuat(mulQuat(qBodyRK4, up.qMount), qHingeNew));

      // Hinge axis in world frame (using RK4-predicted body orientation)
      const aWorldNew = rotateVec(qBodyRK4, up.aBody);

      // Panel angular velocity: ω_panel = ω_body_iter + θ̇_new · â_world
      const omegaPanelNew = addVec(omegaBodyIter, scaleVec(aWorldNew, up.omegaRelNew));

      // Rotate ω to panel body frame, apply diagonal inertia, rotate back
      const omegaPanelLocal = rotateVec(conjQuat(qPanelNew), omegaPanelNew);
      const HpanelLocal = inertiaMul(Ip, omegaPanelLocal);
      const HpanelWorld = rotateVec(qPanelNew, HpanelLocal);

      H_panels.x += HpanelWorld.x;
      H_panels.y += HpanelWorld.y;
      H_panels.z += HpanelWorld.z;
    }

    // Enforce conservation — derive body angular velocity
    // H_body = H_total_initial - H_panels  (for free-float, H_total is conserved)
    // ω_body_conserved = R_body · I_body_diag^{-1} · R_body^T · H_body
    const H_body_required = vec3(
      H0.x - H_panels.x,
      H0.y - H_panels.y,
      H0.z - H_panels.z,
    );

    // Transform H_body to body frame, divide by principal inertia, transform back
    const H_body_local = rotateVec(conjQuat(qBodyRK4), H_body_required);
    const omegaConserved = vec3(
      H_body_local.x / Ib.x,
      H_body_local.y / Ib.y,
      H_body_local.z / Ib.z,
    );
    omegaBodyIter = rotateVec(qBodyRK4, omegaConserved);
  }

  const omegaConservedWorld = omegaBodyIter;

  // Step 2d: Cross-check RK4 vs conservation — warn if discrepancy > 1%
  const H0mag = Math.sqrt(H0.x * H0.x + H0.y * H0.y + H0.z * H0.z);
  const deltaOmega = subVec(omegaConservedWorld, omegaBodyRK4);
  const deltaOmegaMag = Math.sqrt(deltaOmega.x * deltaOmega.x + deltaOmega.y * deltaOmega.y + deltaOmega.z * deltaOmega.z);
  const omegaRK4Mag = Math.sqrt(omegaBodyRK4.x * omegaBodyRK4.x + omegaBodyRK4.y * omegaBodyRK4.y + omegaBodyRK4.z * omegaBodyRK4.z);
  const relativeError = omegaRK4Mag > 1e-12 ? deltaOmegaMag / omegaRK4Mag : (H0mag > 1e-12 ? deltaOmegaMag : 0);

  if (relativeError > 0.01 && H0mag > 1e-9 && isSimDebugEnabled()) {
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
  let qBodyNew: THREE.Quaternion;
  let omegaBodyNew: THREE.Vector3;

  if (!hasExternalTorque || H0mag < 1e-12) {
    // Pure free-float: use conservation-derived ω directly
    qBodyNew = qBodyRK4;
    omegaBodyNew = omegaConservedWorld;
  } else {
    // With external torque: use RK4 but apply small conservation correction
    // to prevent cumulative drift from panel momentum exchange
    // Blend: 90% RK4 (captures external torque) + 10% conservation correction
    const blendFactor = 0.1;
    qBodyNew = qBodyRK4;
    omegaBodyNew = vec3(
      omegaBodyRK4.x + blendFactor * deltaOmega.x,
      omegaBodyRK4.y + blendFactor * deltaOmega.y,
      omegaBodyRK4.z + blendFactor * deltaOmega.z,
    );
  }

  // Approximate angular acceleration from finite difference (for telemetry)
  const alphaWorld = scaleVec(subVec(omegaBodyNew, omegaBody), 1 / dt);

  // ── Phase 3: assemble new panel states with derived quaternions ────────────
  const newPanels: PanelState[] = state.panels.map((panel, i) => {
    const up = updates[i];

    if (panel.stuck) {
      return { ...panel, _q: panel._q ?? quatIdentity(), _omega: panel._omega ?? vec3(0, 0, 0) };
    }

    // Derive panel quaternion:  q_panel = q_body ⊗ q_mount ⊗ q_hinge_local(θ)
    const qHingeNew = quatAxisAngle(up.aLocal, up.thetaNew);
    const qPanelNew = normQuat(mulQuat(mulQuat(qBodyNew, up.qMount), qHingeNew));

    // Panel world-frame angular velocity:  ω_panel = ω_body + θ̇ · â_world(new)
    const aWorldNew = rotateVec(qBodyNew, up.aBody);
    const omegaPanelNew = addVec(omegaBodyNew, scaleVec(aWorldNew, up.omegaRelNew));

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
  const euler = eulerFromQuat(qBodyNew);
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
  const q0 = state._bodyQ ? quatFromLike(state._bodyQ) : quatIdentity();

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
      if (i % 60 === 59 && momentumError > 0.05 && isSimDebugEnabled()) {
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
      const qCur = state._bodyQ ? quatFromLike(state._bodyQ) : quatIdentity();
      const qRel = mulQuat(qCur, conjQuat(q0));
      const attitudeCouplingRad = 2 * Math.acos(Math.min(1, Math.abs(qRel.w)));
      const attitudeCouplingDeg = (attitudeCouplingRad * 180) / Math.PI;

      frames.push({
        time: Math.round(state.time * 1000) / 1000,
        angularVelocity: cloneVec(state.angularVelocity),
        angularAcceleration: cloneVec(state.angularAcceleration),
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
                state._bodyQ ? quatFromLike(state._bodyQ) : quatIdentity(),
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
      });
    }

    if (!state.deploying && state.time > 0.5) break;
  }

  return frames;
}
