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

// ─────────────────────────────────────────────────────────────────────────────
//  Vector3 helpers
// ─────────────────────────────────────────────────────────────────────────────

function v3(x: number, y: number, z: number): Vector3 { return { x, y, z }; }
function v3Add(a: Vector3, b: Vector3): Vector3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function v3Sub(a: Vector3, b: Vector3): Vector3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function v3Scale(v: Vector3, s: number): Vector3 { return { x: v.x * s, y: v.y * s, z: v.z * s }; }
function v3Dot(a: Vector3, b: Vector3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function v3Cross(a: Vector3, b: Vector3): Vector3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Quaternion helpers
// ─────────────────────────────────────────────────────────────────────────────

function qIdentity(): Quaternion { return { w: 1, x: 0, y: 0, z: 0 }; }

function qNormalize(q: Quaternion): Quaternion {
  const len = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  if (len < 1e-12) return qIdentity();
  const inv = 1 / len;
  return { w: q.w * inv, x: q.x * inv, y: q.y * inv, z: q.z * inv };
}

function qMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function qConjugate(q: Quaternion): Quaternion {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

function qFromAxisAngle(axis: Vector3, angle: number): Quaternion {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return { w: Math.cos(half), x: axis.x * s, y: axis.y * s, z: axis.z * s };
}

/** Reconstruct quaternion from XYZ intrinsic Euler angles (matches THREE.js default). */
function qFromEuler(e: Vector3): Quaternion {
  const c1 = Math.cos(e.x * 0.5), s1 = Math.sin(e.x * 0.5);
  const c2 = Math.cos(e.y * 0.5), s2 = Math.sin(e.y * 0.5);
  const c3 = Math.cos(e.z * 0.5), s3 = Math.sin(e.z * 0.5);
  return {
    w: c1 * c2 * c3 - s1 * s2 * s3,
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
  };
}

/** Rotate vector v by quaternion q:  v' = q ⊗ v ⊗ q*  (optimised). */
function qRotateVec(q: Quaternion, v: Vector3): Vector3 {
  const qv = v3(q.x, q.y, q.z);
  const t = v3Scale(v3Cross(qv, v), 2);
  return v3Add(v, v3Add(v3Scale(t, q.w), v3Cross(qv, t)));
}

/**
 * Convert quaternion → XYZ intrinsic Euler angles (matches THREE.js default order).
 * Uses the exact rotation matrix decomposition from THREE.js Euler.setFromQuaternion.
 */
function qToEuler(q: Quaternion): Vector3 {
  const { w, x, y, z } = q;
  const xx = x * x, yy = y * y, zz = z * z;

  // Rotation matrix elements for XYZ decomposition
  const m13 = 2 * (x * z + w * y);
  const m23 = 2 * (y * z - w * x);
  const m33 = 1 - 2 * (xx + yy);
  const m12 = 2 * (x * y - w * z);
  const m11 = 1 - 2 * (yy + zz);

  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  let ex: number, ez: number;

  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    // Gimbal lock
    const m32 = 2 * (y * z + w * x);
    const m22 = 1 - 2 * (xx + zz);
    ex = Math.atan2(m32, m22);
    ez = 0;
  }

  return { x: ex, y: ey, z: ez };
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
function bodyInertiaDiag(params: SimulationParams): Vector3 {
  const w = params.bodyWidth;
  const h = params.bodyHeight;
  const d = params.bodyDepth;
  const m = params.bodyMass;
  return {
    x: (1 / 12) * m * (h * h + d * d),
    y: (1 / 12) * m * (w * w + d * d),
    z: (1 / 12) * m * (w * w + h * h),
  };
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
  return {
    x: (1 / 12) * m * (W * W + t * t),
    y: (1 / 3) * m * L * L + (1 / 12) * m * W * W,
    z: (1 / 3) * m * L * L + (1 / 12) * m * t * t,
  };
}

/**
 * Solve  α = I_world⁻¹ · τ_world  without forming the full 3×3.
 * Strategy: rotate τ into body frame → divide by diagonal I → rotate back.
 */
function applyInverseInertia(Idiag: Vector3, q: Quaternion, torqueWorld: Vector3): Vector3 {
  const tBody = qRotateVec(qConjugate(q), torqueWorld);
  const aBody = { x: tBody.x / Idiag.x, y: tBody.y / Idiag.y, z: tBody.z / Idiag.z };
  return qRotateVec(q, aBody);
}

/** I_body · ω  (diagonal body frame). */
function applyInertia(Idiag: Vector3, w: Vector3): Vector3 {
  return { x: Idiag.x * w.x, y: Idiag.y * w.y, z: Idiag.z * w.z };
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
  // Physical constants (SI)
  const MU = 3.986004418e14;    // m³/s²  Earth gravitational parameter
  const R_EARTH = 6.371e6;      // m       Earth mean radius

  // Orbital mechanics
  const R = R_EARTH + altitudeM;           // orbit radius (m)
  const T_orbit = 2 * Math.PI * Math.sqrt((R * R * R) / MU); // period (s)
  const n = (2 * Math.PI) / T_orbit;       // mean motion (rad/s)

  // Nadir unit vector in world frame: points from spacecraft toward Earth centre.
  // For equatorial circular orbit in our convention (X=right, Y=forward, Z=up),
  // nadir rotates in the Y-Z plane as the satellite orbits.
  const nadirWorld: Vector3 = {
    x: 0,
    y: -Math.sin(n * t),
    z: -Math.cos(n * t),
  };

  // Transform nadir to body frame: r̂_body = q* ⊗ r̂_world
  const nadirBody = qRotateVec(qConjugate(qBody), nadirWorld);
  const rx = nadirBody.x;
  const ry = nadirBody.y;
  const rz = nadirBody.z;

  // Gravity gradient factor: 3μ/R³
  const factor = (3 * MU) / (R * R * R);

  // Body-frame torque components (Hughes 1986, Eq. 3.3.10)
  const tauBodyX = factor * (Ib.z - Ib.y) * ry * rz;
  const tauBodyY = factor * (Ib.x - Ib.z) * rz * rx;
  const tauBodyZ = factor * (Ib.y - Ib.x) * rx * ry;
  const tauBody: Vector3 = { x: tauBodyX, y: tauBodyY, z: tauBodyZ };

  // Rotate torque back to world frame for accumulation with hinge torques
  return qRotateVec(qBody, tauBody);
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
    // Kinematic equation: dq/dt = 0.5 · [0, ω_world] ⊗ q  (world-frame convention)
    const omegaQuat: Quaternion = { w: 0, x: omega.x, y: omega.y, z: omega.z };
    const qDot = qMultiply(omegaQuat, q);
    const dq: Quaternion = {
      w: 0.5 * qDot.w,
      x: 0.5 * qDot.x,
      y: 0.5 * qDot.y,
      z: 0.5 * qDot.z,
    };

    // Euler's equation: I·α = τ - ω×(I·ω)
    // Compute gyroscopic term in world frame via body frame
    const omegaBody = qRotateVec(qConjugate(q), omega);
    const IomegaBody = applyInertia(Ib, omegaBody);
    const IomegaWorld = qRotateVec(q, IomegaBody);
    const gyro = v3Cross(omega, IomegaWorld);
    const netTorque = v3Sub(torqueWorld, gyro);
    const dOmega = applyInverseInertia(Ib, q, netTorque);

    return { dq, dOmega };
  }

  // ── Helper: add scaled quaternion derivative to quaternion ────────────────
  function qAddScaled(q: Quaternion, dq: Quaternion, s: number): Quaternion {
    return {
      w: q.w + dq.w * s,
      x: q.x + dq.x * s,
      y: q.y + dq.y * s,
      z: q.z + dq.z * s,
    };
  }

  // ── RK4 stages ───────────────────────────────────────────────────────────
  // k1
  const k1 = deriv(qBody, omegaBody);

  // k2 (midpoint using k1)
  const q2 = qNormalize(qAddScaled(qBody, k1.dq, 0.5 * dt));
  const omega2 = v3Add(omegaBody, v3Scale(k1.dOmega, 0.5 * dt));
  const k2 = deriv(q2, omega2);

  // k3 (midpoint using k2)
  const q3 = qNormalize(qAddScaled(qBody, k2.dq, 0.5 * dt));
  const omega3 = v3Add(omegaBody, v3Scale(k2.dOmega, 0.5 * dt));
  const k3 = deriv(q3, omega3);

  // k4 (full step using k3)
  const q4 = qNormalize(qAddScaled(qBody, k3.dq, dt));
  const omega4 = v3Add(omegaBody, v3Scale(k3.dOmega, dt));
  const k4 = deriv(q4, omega4);

  // ── Weighted combination ─────────────────────────────────────────────────
  // y_{n+1} = y_n + (dt/6)(k1 + 2k2 + 2k3 + k4)
  const dqFinal: Quaternion = {
    w: (k1.dq.w + 2 * k2.dq.w + 2 * k3.dq.w + k4.dq.w) / 6,
    x: (k1.dq.x + 2 * k2.dq.x + 2 * k3.dq.x + k4.dq.x) / 6,
    y: (k1.dq.y + 2 * k2.dq.y + 2 * k3.dq.y + k4.dq.y) / 6,
    z: (k1.dq.z + 2 * k2.dq.z + 2 * k3.dq.z + k4.dq.z) / 6,
  };

  const dOmegaFinal: Vector3 = {
    x: (k1.dOmega.x + 2 * k2.dOmega.x + 2 * k3.dOmega.x + k4.dOmega.x) / 6,
    y: (k1.dOmega.y + 2 * k2.dOmega.y + 2 * k3.dOmega.y + k4.dOmega.y) / 6,
    z: (k1.dOmega.z + 2 * k2.dOmega.z + 2 * k3.dOmega.z + k4.dOmega.z) / 6,
  };

  const qBodyNew = qNormalize(qAddScaled(qBody, dqFinal, dt));
  const omegaBodyNew = v3Add(omegaBody, v3Scale(dOmegaFinal, dt));

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
  const qBody = state._bodyQ ? { ...state._bodyQ } : qFromEuler(state.orientation);
  const omegaBody = state.angularVelocity;

  // ── Body contribution: H_body = R_body · I_body_diag · R_body^T · ω_body ──
  const Ib = bodyInertiaDiag(params);
  const omegaBodyLocal = qRotateVec(qConjugate(qBody), omegaBody);
  const HbodyLocal = applyInertia(Ib, omegaBodyLocal);
  const Htotal: Vector3 = { ...qRotateVec(qBody, HbodyLocal) };

  // ── Panel contributions ────────────────────────────────────────────────────
  for (let i = 0; i < state.panels.length; i++) {
    const panel = state.panels[i];
    const spec = specs[i];

    // Panel inertia tensor (diagonal, panel body frame about hinge edge)
    const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

    // Panel orientation quaternion
    const qMount = qFromEuler({ x: spec.rot[0], y: spec.rot[1], z: spec.rot[2] });
    const aLocal = hingeAxisUnit(spec.axis);
    const aBody = qRotateVec(qMount, aLocal);
    const aWorld = qRotateVec(qBody, aBody);

    const qHinge = qFromAxisAngle(aLocal, panel.angle);
    const qPanel = qNormalize(qMultiply(qMultiply(qBody, qMount), qHinge));

    // Panel angular velocity in world frame: ω_panel = ω_body + θ̇ · â_world
    const omegaPanel = v3Add(omegaBody, v3Scale(aWorld, panel.angularVelocity));

    // Rotate ω to panel body frame, apply diagonal inertia, rotate back
    const omegaPanelLocal = qRotateVec(qConjugate(qPanel), omegaPanel);
    const HpanelLocal = applyInertia(Ip, omegaPanelLocal);
    const HpanelWorld = qRotateVec(qPanel, HpanelLocal);

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
function hingeAxisUnit(axis: 'x' | 'y' | 'z'): Vector3 {
  switch (axis) {
    case 'x': return { x: 1, y: 0, z: 0 };
    case 'y': return { x: 0, y: 1, z: 0 };
    case 'z': return { x: 0, y: 0, z: 1 };
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
    _q: qIdentity(),
    _omega: v3(0, 0, 0),
  }));
}

export function createInitialState(
  config: ConfigType,
  thermalParams?: ThermalParams,
  flexParams?: FlexParams,
): SpacecraftState {
  const panels = createInitialPanels(config);
  return {
    angularVelocity: { x: 0, y: 0, z: 0 },
    angularAcceleration: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0 },
    panels,
    time: 0,
    deploying: false,
    _bodyQ: qIdentity(),
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
  const qBody = state._bodyQ ? { ...state._bodyQ } : qFromEuler(state.orientation);
  const omegaBody: Vector3 = { ...state.angularVelocity }; // world-frame

  // ── Conservation reference: capture H_total before panel updates ──────────
  // Following Hughes (1986) Ch. 3 and Wie (2008) §8.2:
  //   H_total = I_body·ω_body + Σ_i [I_panel_i · (ω_body + θ̇_i · â_i)]
  // We track H₀ so we can enforce conservation after updating panels.
  const H0 = computeTotalAngularMomentum(state, config, params);

  // ── Phase 1: per-panel hinge dynamics & accumulate body torque ─────────────
  const bodyTorqueWorld: Vector3 = { x: 0, y: 0, z: 0 };

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
        aBody: v3(0, 0, 0), aLocal: v3(0, 0, 0), qMount: qIdentity(),
      });
      continue;
    }

    // Mounting rotation from spec.rot (transforms local panel frame → body frame)
    const qMount = qFromEuler({ x: spec.rot[0], y: spec.rot[1], z: spec.rot[2] });
    const aLocal = hingeAxisUnit(spec.axis);        // hinge axis in local frame
    const aBody = qRotateVec(qMount, aLocal);       // physical hinge axis in body frame
    const aWorld = qRotateVec(qBody, aBody);         // physical hinge axis in world frame

    // Panel inertia tensor (diagonal, panel body frame about hinge edge)
    const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

    // Panel orientation:  q_panel = q_body ⊗ q_mount ⊗ q_hinge_local(θ)
    const qHingeLocal = qFromAxisAngle(aLocal, panel.angle);
    const qPanel = qNormalize(qMultiply(qMultiply(qBody, qMount), qHingeLocal));

    const theta = panel.angle;
    const omegaRel = panel.angularVelocity;
    const deployDuration = params.hinge.deployDuration ?? 0;

    // ── Stage-aware deployment parameters ────────────────────────────────────
    const panelStage = spec.stage ?? 1;
    const panelMaxAngle = spec.maxAngle ?? params.hinge.stopAngle;

    // Stage 2 panels must wait until ALL stage 1 panels are fully deployed
    const stage1Complete = panelStage <= 1 || state.panels.every((p, idx) => {
      const s = specs[idx];
      return (s.stage ?? 1) !== 1 || p.deployed || p.stuck;
    });

    let thetaNew: number, omegaRelNew: number, deployedNew: boolean;
    let contactForceNew: number, hingeTorque: number, thetaDDot: number;

    if (!stage1Complete) {
      // ── Stage 2 panel waiting — hold perfectly still ───────────────────
      thetaNew = theta;
      omegaRelNew = 0;
      deployedNew = false;
      contactForceNew = 0;
      hingeTorque = 0;
      thetaDDot = 0;

    } else if (deployDuration > 0) {
      // ── Kinematic ease-out deployment (stage-aware) ────────────────────────
      // Stage 1 panels deploy during [0, deployDuration]
      // Stage 2 panels deploy during [deployDuration, 2*deployDuration]
      const tNext = state.time + dt;
      const stageStartTime = (panelStage - 1) * deployDuration;
      const stageElapsed = tNext - stageStartTime;
      const progress = Math.min(Math.max(stageElapsed / deployDuration, 0), 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const targetAngle = panelMaxAngle * easeOut;

      omegaRelNew = (targetAngle - theta) / dt;
      thetaNew = targetAngle;
      deployedNew = progress >= 1;
      if (deployedNew) { thetaNew = panelMaxAngle; omegaRelNew = 0; }

      // Effective hinge-axis inertia via full tensor:  I_eff = 1 / (â · I⁻¹ · â)
      const alphaUnit = applyInverseInertia(Ip, qPanel, aWorld);
      const Ieff = 1 / v3Dot(alphaUnit, aWorld);

      // Equivalent torque τ = I_eff · θ̈  (reaction couples to body)
      thetaDDot = (omegaRelNew - omegaRel) / dt;
      hingeTorque = Ieff * thetaDDot;
      contactForceNew = 0;

    } else {
      // ── Physics-driven spring-damper hinge (stage-aware) ───────────────────
      const h = params.hinge;
      // Use panel-specific max angle as the target stop angle
      const stopAngle = panelMaxAngle;
      // Apply thermal stiffness multiplier if thermal model is active
      const effectiveSpringConstant = thermalState && thermalParams
        ? applyThermalStiffness(h.springConstant, thermalState, thermalParams)
        : h.springConstant;
      let tau = effectiveSpringConstant * (stopAngle - theta) + h.preloadTorque;
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
      const tauVecWorld = v3Scale(aWorld, tau);
      const alphaPanelWorld = applyInverseInertia(Ip, qPanel, tauVecWorld);

      // Project onto hinge axis for 1-DOF constraint:  θ̈ = α_panel · â
      thetaDDot = v3Dot(alphaPanelWorld, aWorld);

      // Semi-implicit Euler (velocity first)
      omegaRelNew = omegaRel + thetaDDot * dt;
      thetaNew = theta + omegaRelNew * dt;

      if (thetaNew < 0) { thetaNew = 0; omegaRelNew = 0; }
      deployedNew = thetaNew >= stopAngle && Math.abs(omegaRelNew) < 0.1;
      if (deployedNew) { thetaNew = stopAngle; omegaRelNew = 0; }
    }

    updates.push({ thetaNew, omegaRelNew, deployedNew, contactForceNew, hingeTorque, thetaDDot, aBody, aLocal, qMount });

    // Accumulate equal-and-opposite reaction on body:  τ_body += −τ · â_world
    const aWorld2 = qRotateVec(qBody, aBody);
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
  const totalBodyTorqueWorld: Vector3 = { ...bodyTorqueWorld };
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

  let omegaBodyIter = { ...omegaBodyRK4 };
  const MAX_ITERS = 5;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    // Compute panel angular momentum contribution using current body velocity estimate
    let H_panels: Vector3 = { x: 0, y: 0, z: 0 };

    for (let i = 0; i < state.panels.length; i++) {
      const panel = state.panels[i];
      const spec = specs[i];
      const up = updates[i];

      if (panel.stuck) continue;

      // Panel inertia tensor (diagonal, panel body frame about hinge edge)
      const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);

      // Panel orientation using RK4-predicted body orientation:
      // q_panel = q_body_RK4 ⊗ q_mount ⊗ q_hinge_local(θ_new)
      const qHingeNew = qFromAxisAngle(up.aLocal, up.thetaNew);
      const qPanelNew = qNormalize(qMultiply(qMultiply(qBodyRK4, up.qMount), qHingeNew));

      // Hinge axis in world frame (using RK4-predicted body orientation)
      const aWorldNew = qRotateVec(qBodyRK4, up.aBody);

      // Panel angular velocity: ω_panel = ω_body_iter + θ̇_new · â_world
      const omegaPanelNew = v3Add(omegaBodyIter, v3Scale(aWorldNew, up.omegaRelNew));

      // Rotate ω to panel body frame, apply diagonal inertia, rotate back
      const omegaPanelLocal = qRotateVec(qConjugate(qPanelNew), omegaPanelNew);
      const HpanelLocal = applyInertia(Ip, omegaPanelLocal);
      const HpanelWorld = qRotateVec(qPanelNew, HpanelLocal);

      H_panels.x += HpanelWorld.x;
      H_panels.y += HpanelWorld.y;
      H_panels.z += HpanelWorld.z;
    }

    // Enforce conservation — derive body angular velocity
    // H_body = H_total_initial - H_panels  (for free-float, H_total is conserved)
    // ω_body_conserved = R_body · I_body_diag^{-1} · R_body^T · H_body
    const H_body_required: Vector3 = {
      x: H0.x - H_panels.x,
      y: H0.y - H_panels.y,
      z: H0.z - H_panels.z,
    };

    // Transform H_body to body frame, divide by principal inertia, transform back
    const H_body_local = qRotateVec(qConjugate(qBodyRK4), H_body_required);
    const omegaConserved: Vector3 = {
      x: H_body_local.x / Ib.x,
      y: H_body_local.y / Ib.y,
      z: H_body_local.z / Ib.z,
    };
    omegaBodyIter = qRotateVec(qBodyRK4, omegaConserved);
  }

  const omegaConservedWorld = omegaBodyIter;

  // Step 2d: Cross-check RK4 vs conservation — warn if discrepancy > 1%
  const H0mag = Math.sqrt(H0.x * H0.x + H0.y * H0.y + H0.z * H0.z);
  const deltaOmega = v3Sub(omegaConservedWorld, omegaBodyRK4);
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
    omegaBodyNew = {
      x: omegaBodyRK4.x + blendFactor * deltaOmega.x,
      y: omegaBodyRK4.y + blendFactor * deltaOmega.y,
      z: omegaBodyRK4.z + blendFactor * deltaOmega.z,
    };
  }

  // Approximate angular acceleration from finite difference (for telemetry)
  const alphaWorld: Vector3 = v3Scale(v3Sub(omegaBodyNew, omegaBody), 1 / dt);

  // ── Phase 3: assemble new panel states with derived quaternions ────────────
  const newPanels: PanelState[] = state.panels.map((panel, i) => {
    const up = updates[i];

    if (panel.stuck) {
      return { ...panel, _q: panel._q ?? qIdentity(), _omega: panel._omega ?? v3(0, 0, 0) };
    }

    // Derive panel quaternion:  q_panel = q_body ⊗ q_mount ⊗ q_hinge_local(θ)
    const qHingeNew = qFromAxisAngle(up.aLocal, up.thetaNew);
    const qPanelNew = qNormalize(qMultiply(qMultiply(qBodyNew, up.qMount), qHingeNew));

    // Panel world-frame angular velocity:  ω_panel = ω_body + θ̇ · â_world(new)
    const aWorldNew = qRotateVec(qBodyNew, up.aBody);
    const omegaPanelNew = v3Add(omegaBodyNew, v3Scale(aWorldNew, up.omegaRelNew));

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
  const euler = qToEuler(qBodyNew);
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
  const q0 = state._bodyQ ? { ...state._bodyQ } : qIdentity();

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
      const qCur = state._bodyQ ?? qIdentity();
      const qRel = qMultiply(qCur, qConjugate(q0));
      const attitudeCouplingRad = 2 * Math.acos(Math.min(1, Math.abs(qRel.w)));
      const attitudeCouplingDeg = (attitudeCouplingRad * 180) / Math.PI;

      frames.push({
        time: Math.round(state.time * 1000) / 1000,
        angularVelocity: { ...state.angularVelocity },
        angularAcceleration: { ...state.angularAcceleration },
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
                state._bodyQ ?? qIdentity(),
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
