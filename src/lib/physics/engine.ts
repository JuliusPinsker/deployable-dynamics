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
  DEFAULT_PARAMS,
} from './types';

import { getPanelSpecs } from './panelLayouts';

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

export function createInitialState(config: ConfigType): SpacecraftState {
  return {
    angularVelocity: { x: 0, y: 0, z: 0 },
    angularAcceleration: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0 },
    panels: createInitialPanels(config),
    time: 0,
    deploying: false,
    _bodyQ: qIdentity(),
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
  const specs = getPanelSpecs(config, params);

  // ── Current body state ────────────────────────────────────────────────────
  const Ib = bodyInertiaDiag(params);
  const qBody = state._bodyQ ? { ...state._bodyQ } : qFromEuler(state.orientation);
  const omegaBody: Vector3 = { ...state.angularVelocity }; // world-frame

  // ── Phase 1: per-panel hinge dynamics & accumulate body torque ─────────────
  const bodyTorqueWorld: Vector3 = { x: 0, y: 0, z: 0 };

  interface PanelUpdate {
    thetaNew: number;
    omegaRelNew: number;
    deployedNew: boolean;
    contactForceNew: number;
    hingeTorque: number;
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
        contactForceNew: 0, hingeTorque: 0,
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
    let contactForceNew: number, hingeTorque: number;

    if (!stage1Complete) {
      // ── Stage 2 panel waiting — hold perfectly still ───────────────────────
      thetaNew = theta;
      omegaRelNew = 0;
      deployedNew = false;
      contactForceNew = 0;
      hingeTorque = 0;

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
      const thetaDDot = (omegaRelNew - omegaRel) / dt;
      hingeTorque = Ieff * thetaDDot;
      contactForceNew = 0;

    } else {
      // ── Physics-driven spring-damper hinge (stage-aware) ───────────────────
      const h = params.hinge;
      // Use panel-specific max angle as the target stop angle
      const stopAngle = panelMaxAngle;
      let tau = h.springConstant * (stopAngle - theta) + h.preloadTorque;
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
      const thetaDDot = v3Dot(alphaPanelWorld, aWorld);

      // Semi-implicit Euler (velocity first)
      omegaRelNew = omegaRel + thetaDDot * dt;
      thetaNew = theta + omegaRelNew * dt;

      if (thetaNew < 0) { thetaNew = 0; omegaRelNew = 0; }
      deployedNew = thetaNew >= stopAngle && Math.abs(omegaRelNew) < 0.1;
      if (deployedNew) { thetaNew = stopAngle; omegaRelNew = 0; }
    }

    updates.push({ thetaNew, omegaRelNew, deployedNew, contactForceNew, hingeTorque, aBody, aLocal, qMount });

    // Accumulate equal-and-opposite reaction on body:  τ_body += −τ · â_world
    const aWorld2 = qRotateVec(qBody, aBody);
    bodyTorqueWorld.x -= hingeTorque * aWorld2.x;
    bodyTorqueWorld.y -= hingeTorque * aWorld2.y;
    bodyTorqueWorld.z -= hingeTorque * aWorld2.z;
  }

  // ── Phase 2: body rotational dynamics (RK4) ───────────────────────────────
  // Integrate spacecraft body attitude using 4th-order Runge-Kutta.
  // Euler equation: I·α = τ − ω×(I·ω), with external torque from panel hinges.
  const { qBodyNew, omegaBodyNew } = integrateBodyRK4(
    qBody, omegaBody, bodyTorqueWorld, Ib, dt,
  );

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

    return {
      ...panel,
      angle: up.thetaNew,
      angularVelocity: up.omegaRelNew,
      deployed: up.deployedNew,
      contactForce: up.contactForceNew,
      _q: qPanelNew,
      _omega: omegaPanelNew,
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
}

export function runFullSimulation(
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
  maxTime: number = 10,
  stuckPanels: number[] = [],
): SimulationFrame[] {
  let state = createInitialState(config);
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

  for (let i = 0; i < maxSteps; i++) {
    state = stepSimulation(state, config, params);

    // Record every 3rd frame for chart data
    if (i % 3 === 0) {
      frames.push({
        time: Math.round(state.time * 1000) / 1000,
        angularVelocity: { ...state.angularVelocity },
        angularAcceleration: { ...state.angularAcceleration },
        panelAngles: state.panels.map(p => p.angle),
        contactForces: state.panels.map(p => p.contactForce),
        totalContactForce: state.panels.reduce((s, p) => s + p.contactForce, 0),
      });
    }

    if (!state.deploying && state.time > 0.5) break;
  }

  return frames;
}
