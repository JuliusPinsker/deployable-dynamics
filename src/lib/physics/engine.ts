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
  type HingeParams,
  Vector3,
  Quaternion,
  Euler,
  DEFAULT_PARAMS,
} from './types';
import { MathUtils } from 'three';

import { getPanelSpecs } from './panelLayouts';
import {
  type Mat3,
  mat3Zero,
  mat3Clone,
  mat3AddOuterInPlace,
  mat3MulVec,
  solve3x3,
} from './linearAlgebra';

/**
 * Free-float angular-momentum conservation criterion (dimensionless):
 * |H(t) − H(0)| / max(|H(0)|, H_scale) must stay ≤ this bound
 * (0.001 = 0.1%). With zero external torque the coupled EOM conserves H
 * structurally; this bound is the allowance for integration truncation.
 */
export const FREE_FLOAT_MOMENTUM_ERROR_MAX = 0.001;

/**
 * Post-deployment observation window (seconds). Once every panel has deployed (or
 * stuck), the hinges stop moving but the spacecraft body keeps coasting under the
 * existing dynamics for this long so the motion stays visible. Part of normal
 * simulation behaviour — not a separate mode.
 */
const POST_DEPLOY_OBSERVATION_S = 6;

/**
 * Settle margin (rad) for the deployment-completion latch, on top of the
 * (capped) Coulomb-friction dead-band. A frictional hinge can stall where the
 * spring torque drops to the friction torque — θ_rest = θ_stop − τ_f/k_eff —
 * strictly short of the stop, so completion is detected at rest near the stop
 * rather than at θ_stop exactly. Detection only: it does not alter the hinge
 * dynamics. ≈ 0.57°.
 */
const DEPLOY_LATCH_MARGIN_RAD = 0.01;

/**
 * Cap (rad, ≈ 2°) on the friction dead-band used by the completion latch.
 * With a soft spring, the raw dead-band τ_f/k_eff can span tens of degrees;
 * an uncapped latch then fires far from the stop and snaps the panel through
 * a large angle (measured up to ~65° in the calibration sweep —
 * calibration.ts), silently faking completion. With the cap, the latch can
 * only engage close to the stop: a panel that genuinely stalls further out
 * (insufficient spring energy against friction) is honestly reported as an
 * incomplete deployment instead of being teleported to the stop. The cap
 * comfortably covers the post-contact friction rest distance of the
 * calibrated underdamped hinge (≲ 1.6°).
 */
const DEPLOY_LATCH_MAX_DEADBAND_RAD = 0.035;

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

// ─────────────────────────────────────────────────────────────────────────────
//  Peak-by-|ω| tracking (shared by the report sweep and live telemetry)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Running peak of body angular-velocity magnitude, plus the detumbling energy at that peak
 * frame. Because the body starts from rest and momentum is conserved, ω decays back to ~0 once
 * panels stop, so a settled/last value is misleading — the meaningful figure is the peak. This
 * is the single selection rule used both by the report sweep (`computeSingleRow`, reducing over
 * a full trajectory) and by live Simulation-page telemetry (folding one frame at a time).
 */
export interface OmegaPeak {
  /** Peak body angular-velocity magnitude seen so far (rad/s). */
  peakOmegaRad: number;
  /** Detumbling energy (mJ) at that peak-ω frame. */
  eDetumbleMJ: number;
}

export const EMPTY_OMEGA_PEAK: OmegaPeak = { peakOmegaRad: 0, eDetumbleMJ: 0 };

/** Fold one sample into the running peak, selecting by |ω| (ties keep the newer sample). */
export function accumulateOmegaPeak(
  prev: OmegaPeak,
  omegaRad: number,
  eDetumbleMJ: number,
): OmegaPeak {
  return omegaRad >= prev.peakOmegaRad ? { peakOmegaRad: omegaRad, eDetumbleMJ } : prev;
}

/**
 * Diagonal CENTROIDAL principal inertia for a rectangular panel plate, about
 * the panel's own centre of mass, in the panel's REAL local frame (verified
 * against the layout specs and the renderer's boxGeometry mapping):
 *
 *   local X = hinge/rotation axis   (extent H = spec.size[0], the short edge)
 *   local Y = thickness             (extent t = spec.size[1])
 *   local Z = outward/deploy        (extent R = spec.size[2]; panel occupies
 *                                    Z ∈ [-R, 0], hinge edge line at Z = 0)
 *
 * In the Bascom–Schaub (AAS 22-725) panel-frame naming (ŝ2 = hinge axis,
 * ŝ1 along the CM–hinge line, ŝ3 completing the right-handed set):
 *
 *   Ixx = I_S2 = (1/12) m (t² + R²)   ← about the hinge-parallel axis THROUGH THE CM
 *   Iyy = I_S3 = (1/12) m (H² + R²)   ← about the thickness axis through the CM
 *   Izz = I_S1 = (1/12) m (H² + t²)   ← about the outward axis through the CM
 */
function panelInertiaCentroidDiag(m: number, H: number, t: number, R: number): Vector3 {
  return new Vector3(
    (1 / 12) * m * (t * t + R * R),
    (1 / 12) * m * (H * H + R * R),
    (1 / 12) * m * (H * H + t * t),
  );
}

/**
 * Diagonal inertia for a rectangular panel plate about the HINGE-EDGE line,
 * derived from the centroidal tensor by the parallel-axis theorem. The panel
 * CM sits at local (0, 0, −R/2), i.e. offset d = R/2 from the hinge line
 * purely along local Z, so the shift m·(R/2)² applies to the X and Y moments
 * and leaves Z unchanged:
 *
 *   Ixx = (1/12) m (t² + R²) + m (R/2)² = (1/3) m R² + (1/12) m t²   ← hinge axis (Ieff = I_S2 + m·d²)
 *   Iyy = (1/12) m (H² + R²) + m (R/2)² = (1/12) m H² + (1/3) m R²
 *   Izz = (1/12) m (H² + t²)                                          ← outward axis (no shift)
 *
 * NOTE (Phase-B bug fix): the previous implementation returned the CENTROIDAL
 * moment (1/12)m(R²+t²) as Ixx — missing the m·(R/2)² parallel-axis term, a
 * uniform ≈4× underestimate of the true hinge-axis inertia. The hinge
 * calibration (k, c, friction in DEFAULT_PARAMS) was re-derived against the
 * corrected value; see the calibration block comment in types.ts.
 *
 * Parameter names keep the existing call-site convention:
 * L = spec.size[0] (hinge-axis extent H), W = spec.size[2] (outward extent R),
 * t = spec.size[1] (thickness).
 */
function panelInertiaDiag(m: number, L: number, W: number, t: number): Vector3 {
  const cm = panelInertiaCentroidDiag(m, L, t, W);
  const shift = m * (W / 2) * (W / 2);
  return new Vector3(cm.x + shift, cm.y + shift, cm.z);
}

/**
 * The single panel-orientation composition used EVERYWHERE a panel's world
 * orientation (or a panel-local vector's world direction) is needed:
 *
 *   q_panel_world = q_body ⊗ q_mount ⊗ q_hinge(θ)
 *
 * (q_body outermost, q_hinge innermost — the engine's verified convention;
 * three.js a.multiply(b) sets a = a⊗b.) Centralised so the coupled solver,
 * CoM/inertia assembly, momentum diagnostic, and renderer-facing panel state
 * can never drift onto different multiplication orders.
 */
export function panelWorldQuaternion(
  qBody: Quaternion,
  qMount: Quaternion,
  theta: number,
  aLocal: Vector3,
): Quaternion {
  const qHinge = new Quaternion().setFromAxisAngle(aLocal, theta);
  return qBody.clone().multiply(qMount.clone()).multiply(qHinge).normalize();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Per-(params, config) panel kinematics cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Step-invariant per-panel quantities: layout spec plus the mounting quaternion,
 * hinge axes, and inertia tensor derived from it. These depend only on the
 * geometry/material in `params` (never on the dynamic state), but were being
 * rebuilt — including Euler-angle trigonometry — several times per physics step.
 * At the 1/1200 s physics timestep that reconstruction dominated the hot loop.
 *
 * Cached per params-object identity (WeakMap): callers construct a fresh params
 * object whenever a value changes (React useMemo / test spreads), so identity
 * keying cannot serve stale data. Params must be treated as immutable after
 * first use by the engine — matching existing usage everywhere.
 *
 * Consumers must NOT mutate the returned vectors/quaternions (engine code
 * always `.clone()`s before applying rotations).
 */
export interface PanelKinematics {
  spec: ReturnType<typeof getPanelSpecs>[number];
  qMount: Quaternion;   // mounting rotation from spec.rot (local → body frame)
  aLocal: Vector3;      // hinge axis ŝ2, local frame (unit)
  aBody: Vector3;       // hinge axis, body frame (qMount-rotated, unit)
  Ip: Vector3;          // diagonal panel inertia about the HINGE edge (Ip.x = Ieff = I_S2 + m·d²)
  /**
   * Diagonal CENTROIDAL panel inertia (about the panel CM): a genuinely
   * separate representation from Ip — (x, y, z) = (I_S2, I_S3, I_S1) in the
   * paper's naming. Never interchangeable with Ip: Ieff = Ip.x belongs only
   * in the 1/Ieff prefactors; the coupled-EOM numerator terms (K, gyroscopic
   * cross-term) require these centroidal values.
   */
  IpCentroid: Vector3;
  /** Hinge-line → panel-CM distance d = |spec.pos| (= R/2 for every layout). */
  d: number;
  /**
   * ŝ1, LOCAL frame (pre-mount, pre-hinge): the paper's convention is
   * r_S/H = −d·ŝ1, so ŝ1 = −pos/|pos|. Sign varies per panel (double-long-
   * edge stage-2 children fold back, pos = +R/2 ẑ) — never hardcode. This is
   * only the fixed local reference; the world-frame ŝ1 must be re-derived at
   * each integrator stage via panelWorldQuaternion (it rotates with θ).
   */
  s1Local: Vector3;
  /** ŝ3 = ŝ1 × ŝ2, LOCAL frame (completes the right-handed paper triad). */
  s3Local: Vector3;
}

const kinematicsCache = new WeakMap<SimulationParams, Map<ConfigType, PanelKinematics[]>>();

export function getPanelKinematics(config: ConfigType, params: SimulationParams): PanelKinematics[] {
  let byConfig = kinematicsCache.get(params);
  if (!byConfig) {
    byConfig = new Map();
    kinematicsCache.set(params, byConfig);
  }
  let kin = byConfig.get(config);
  if (!kin) {
    kin = getPanelSpecs(config, params).map(spec => {
      const qMount = new Quaternion().setFromEuler(new Euler(spec.rot[0], spec.rot[1], spec.rot[2], 'XYZ'));
      const aLocal = hingeAxisUnit(spec.axis).normalize();
      const aBody = aLocal.clone().applyQuaternion(qMount.clone());
      const Ip = panelInertiaDiag(params.panelMass, spec.size[0], spec.size[2], spec.size[1]);
      const IpCentroid = panelInertiaCentroidDiag(
        params.panelMass, spec.size[0], spec.size[1], spec.size[2],
      );
      const pos = new Vector3(spec.pos[0], spec.pos[1], spec.pos[2]);
      const d = pos.length();
      const s1Local = d > 0 ? pos.clone().multiplyScalar(-1 / d) : new Vector3(0, 0, 1);
      const s3Local = s1Local.clone().cross(aLocal);
      return { spec, qMount, aLocal, aBody, Ip, IpCentroid, d, s1Local, s3Local };
    });
    byConfig.set(config, kin);
  }
  return kin;
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
//  Phase-B coupled hub–panel EOM (Bascom & Schaub AAS 22-725, rotational-only,
//  L_B = 0 exactly, u = 0)
//
//  Every active hinge DOF and the hub attitude are integrated TOGETHER as one
//  extended state y = {q, ω, θ_i, θ̇_i} through classical RK4; each stage
//  solves the coupled 3×3 rotational system
//
//      [D]·ω̇ = v_r,   [D] = [I_sc,B] + Σ_i K_i ⊗ b_θ,i
//
//  and back-substitutes θ̈_i = b_θ,i·ω̇ + c_θ,i (paper Eqs. 12–24 specialised
//  to a pinned, force-free body reference point B).
//
//  The implementation uses the member-summed generalisation of the paper's
//  single-panel coefficients: an "assembly" is an active hinge DOF plus every
//  panel rigidly riding it (e.g. the folded stage-2 panel riding a deploying
//  double-long-edge stage-1 panel). For each member j, with world-frame
//  hinge axis ŝ2, hinge point r_H, member CM r_j, member centroidal tensor
//  M_j (world), and u_j = ŝ2×(r_j − r_H):
//
//      Ieff = Σ_j [ ŝ2·M_j·ŝ2 + m·|u_j|² ]          (∂²T/∂θ̇² — hinge-referenced)
//      K    = Σ_j [ M_j·ŝ2 + m·(r_j × u_j) ]         (∂H/∂θ̇ — Eq. 20's vector)
//      b_θ  = −K / Ieff                              (≡ paper Eq. 14; for a lone
//                                                     panel K = Ieff·ŝ2 + m·d·(r_H/B×ŝ3),
//                                                     so b_θ = −ŝ2 − (m·d/Ieff)(r_H/B×ŝ3),
//                                                     and b_θ·ŝ2 = −1 when r_H/B = 0)
//      c_θ  = (1/Ieff)[ τ_hinge + Σ_j ( ω·(ŝ2×M_j·ω)
//                       + m((r_j·u_j)|ω|² − (r_j·ω)(u_j·ω)) ) ]
//                                                    (≡ Eq. 15's gyroscopic
//                                                     (I_S3−I_S1+m·d²)ω_S1ω_S3 −
//                                                     m·d·ŝ3·(ω×(ω×r_H/B)) terms)
//
//  v_r = Σ_active [ −θ̇(ω×K) − c_θ·K − θ̇²·Σ_j( ŝ2×(M_j·ŝ2) + m·r_j×(ŝ2×u_j) ) ]
//        − ω×(I_sc,B·ω) − Σ_active θ̇·(∂I_A/∂θ)·ω
//
//  Sign note: conservation (dH/dt = 0) and an independent planar-Lagrangian
//  reference both give the θ̇² transport term with a MINUS sign; the paper's
//  printed Eq. 22 shows "+ m_sp·d·θ̇²·r_S/B×ŝ1". The minus form is what the
//  brute-force reference tests validate. The [I′_sc,B]·ω shape-rate term is
//  retained explicitly (dropping it fails the same reference comparison).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The calibrated torsional-hinge torque law — the SINGLE deployment torque
 * model (spring or bistable + preload, elastic/damped mechanical stop,
 * viscous damping, Coulomb friction), evaluated at an arbitrary (θ, θ̇).
 * Identical branch structure and constants to the pre-Phase-B law; extracted
 * so the coupled integrator can evaluate it at every RK4 stage state.
 *
 * Returns the total hinge torque on the panel about +ŝ2 and the stop-contact
 * magnitude (telemetry).
 */
export function hingeTorqueTotal(
  theta: number,
  omegaRel: number,
  stopAngle: number,
  h: HingeParams,
): { tau: number; contact: number } {
  let tauCons: number;
  if (h.hingeModel === 'bistable' && h.bistability) {
    // Bistable tape-spring double-well: τ(θ) = −2A·θ·(θ−θmax)·(2θ−θmax) + preload
    // Ref: Seffen & Pellegrino 1999; Mallikarachchi & Pellegrino 2011
    const A = h.bistability.bistabilityCoeff;
    tauCons = -2 * A * theta * (theta - stopAngle) * (2 * theta - stopAngle) + h.preloadTorque;
  } else {
    tauCons = h.springConstant * (stopAngle - theta) + h.preloadTorque;
  }
  let cTotal = h.dampingCoeff;
  let contact = 0;
  if (theta >= stopAngle) {
    const penetration = theta - stopAngle;
    tauCons -= h.stopStiffness * penetration;
    cTotal += h.stopDamping;
    contact = Math.abs(-h.stopStiffness * penetration - h.stopDamping * omegaRel);
  }
  const friction = Math.sign(omegaRel) * h.frictionCoeff;
  return { tau: tauCons - cTotal * omegaRel - friction, contact };
}

/**
 * Stage-local panel geometry: every vector a coupled-EOM stage evaluation
 * needs, derived fresh from the CURRENT (qBody, θ[]) — including the full
 * hierarchical parent chain for child panels (a child's mounting frame and
 * hinge position ride its parent's current angle). Nothing here may be
 * cached across integrator stages: ŝ1/ŝ3, r_S/B and the panel orientation
 * all rotate with θ.
 */
export interface PanelStageGeometry {
  /** Panel orientation in the BODY frame: qMountEff ⊗ qHinge(θ). */
  qInBody: Quaternion;
  /** Panel orientation in the WORLD frame: qBody ⊗ qInBody. */
  qPanelWorld: Quaternion;
  /** Hinge pivot position, body frame (parent-chain resolved). */
  rHingeBody: Vector3;
  /** Hinge pivot position r_{H/B}, world frame. */
  rHingeWorld: Vector3;
  /** Panel CM position r_{S/B}, world frame. */
  rCmWorld: Vector3;
  /** ŝ2 — hinge axis, world frame (unit). */
  s2World: Vector3;
  /** ŝ1 — paper convention r_S/H = −d·ŝ1, world frame (rotates with θ). */
  s1World: Vector3;
  /** ŝ3 = ŝ1 × ŝ2, world frame (rotates with θ). */
  s3World: Vector3;
}

const IDENTITY_Q = new Quaternion();

export function computePanelGeometryAtStage(
  kinematics: PanelKinematics[],
  qBody: Quaternion,
  thetas: number[],
): PanelStageGeometry[] {
  const out: PanelStageGeometry[] = [];
  for (let i = 0; i < kinematics.length; i++) {
    const kin = kinematics[i];
    const spec = kin.spec;

    // Effective mounting (body frame) and hinge position: child panels chain
    // through their parent's CURRENT orientation (specs order parents first).
    let qMountEff: Quaternion;
    let rHingeBody: Vector3;
    if (spec.parentIndex !== undefined && spec.hingeOffset !== undefined) {
      const parent = out[spec.parentIndex];
      qMountEff = parent.qInBody.clone().multiply(kin.qMount.clone());
      rHingeBody = parent.rHingeBody.clone().add(
        new Vector3(spec.hingeOffset[0], spec.hingeOffset[1], spec.hingeOffset[2])
          .applyQuaternion(parent.qInBody),
      );
    } else {
      qMountEff = kin.qMount;
      rHingeBody = new Vector3(spec.hinge[0], spec.hinge[1], spec.hinge[2]);
    }

    const qInBody = panelWorldQuaternion(IDENTITY_Q, qMountEff, thetas[i], kin.aLocal);
    const qPanelWorld = qBody.clone().multiply(qInBody.clone()).normalize();
    const rHingeWorld = rHingeBody.clone().applyQuaternion(qBody);
    const rCmWorld = rHingeWorld.clone().add(
      new Vector3(spec.pos[0], spec.pos[1], spec.pos[2]).applyQuaternion(qPanelWorld),
    );
    // ŝ2 is invariant under the panel's own hinge rotation (a vector is fixed
    // under rotation about itself), so rotating aLocal by the full panel
    // quaternion equals rotating by qBody ⊗ qMountEff — one code path.
    const s2World = kin.aLocal.clone().applyQuaternion(qPanelWorld);
    const s1World = kin.s1Local.clone().applyQuaternion(qPanelWorld);
    const s3World = kin.s3Local.clone().applyQuaternion(qPanelWorld);

    out.push({ qInBody, qPanelWorld, rHingeBody, rHingeWorld, rCmWorld, s2World, s1World, s3World });
  }
  return out;
}

/** dst += R(q)·diag·R(q)ᵀ, built as Σ_k diag_k · (ê_k′ ⊗ ê_k′). */
function mat3AddRotatedDiagInPlace(dst: Mat3, q: Quaternion, diag: Vector3): void {
  const ex = new Vector3(1, 0, 0).applyQuaternion(q);
  const ey = new Vector3(0, 1, 0).applyQuaternion(q);
  const ez = new Vector3(0, 0, 1).applyQuaternion(q);
  mat3AddOuterInPlace(dst, ex.clone().multiplyScalar(diag.x), ex);
  mat3AddOuterInPlace(dst, ey.clone().multiplyScalar(diag.y), ey);
  mat3AddOuterInPlace(dst, ez.clone().multiplyScalar(diag.z), ez);
}

/** dst += m·(|r|²·E − r ⊗ r)  (parallel-axis shift of a centroidal tensor to B). */
function mat3AddParallelAxisInPlace(dst: Mat3, m: number, r: Vector3): void {
  const mr2 = m * r.lengthSq();
  dst.rows[0].x += mr2;
  dst.rows[1].y += mr2;
  dst.rows[2].z += mr2;
  mat3AddOuterInPlace(dst, r.clone().multiplyScalar(-m), r);
}

/** M_j·v for a member's world-frame centroidal tensor (rotate–scale–rotate). */
function applyCentroidTensor(kin: PanelKinematics, geo: PanelStageGeometry, v: Vector3): Vector3 {
  const local = v.clone().applyQuaternion(geo.qPanelWorld.clone().conjugate());
  return applyInertia(kin.IpCentroid, local).applyQuaternion(geo.qPanelWorld);
}

/**
 * Total system inertia about body reference point B (world frame, symmetric
 * 3×3): hub (CM at B, no shift) + every panel's world-rotated CENTROIDAL
 * tensor parallel-axis-shifted by its current CM position. Panels at their
 * current (chain-resolved) orientation, whatever their deployment status.
 */
export function computeSystemInertiaAboutB(
  state: SpacecraftState,
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
): Mat3 {
  const kinematics = getPanelKinematics(config, params);
  const qBody = state._bodyQ
    ? new Quaternion(state._bodyQ.x, state._bodyQ.y, state._bodyQ.z, state._bodyQ.w)
    : new Quaternion().setFromEuler(new Euler(state.orientation.x, state.orientation.y, state.orientation.z, 'XYZ'));
  const thetas = state.panels.map(p => (p.stuck ? p.stuckAngle : p.angle));
  const geo = computePanelGeometryAtStage(kinematics, qBody, thetas);
  return systemInertiaFromGeometry(kinematics, geo, qBody, params);
}

function systemInertiaFromGeometry(
  kinematics: PanelKinematics[],
  geo: PanelStageGeometry[],
  qBody: Quaternion,
  params: SimulationParams,
): Mat3 {
  const Isc = mat3Zero();
  mat3AddRotatedDiagInPlace(Isc, qBody, bodyInertiaDiag(params));
  for (let j = 0; j < kinematics.length; j++) {
    mat3AddRotatedDiagInPlace(Isc, geo[j].qPanelWorld, kinematics[j].IpCentroid);
    mat3AddParallelAxisInPlace(Isc, params.panelMass, geo[j].rCmWorld);
  }
  return Isc;
}

/**
 * Coupled coefficients for one active hinge DOF (assembly = the active panel
 * plus every member rigidly riding its hinge), all in the world frame.
 */
export interface CoupledCoefficients {
  /** Ieff = ∂²T/∂θ̇² (kg·m²) — the ONLY place the hinge-referenced inertia enters. */
  Ieff: number;
  /** K = ∂H/∂θ̇ (paper Eq. 20's I_S2·ŝ2 + m·d·(r_S/B×ŝ3), member-summed). */
  K: Vector3;
  /** b_θ = −K/Ieff (≡ paper Eq. 14). */
  bTheta: Vector3;
  /** c_θ (rad/s²) — hinge torque + gyroscopic/centripetal terms, /Ieff. */
  cTheta: number;
  /** a_θ = −(Σ m·u_j)/Ieff — translational-coupling diagnostic only (unused by the solve). */
  aTheta: Vector3;
  /** v_r transport vector: Σ_j [ ŝ2×(M_j·ŝ2) + m·r_j×(ŝ2×u_j) ] (θ̇²-term, minus sign applied in v_r). */
  dKdTheta: Vector3;
}

export function computeAssemblyCoefficients(
  members: number[],
  kinematics: PanelKinematics[],
  geo: PanelStageGeometry[],
  omega: Vector3,
  tauHinge: number,
  panelMass: number,
  hingeIndex: number,
): CoupledCoefficients {
  const s2 = geo[hingeIndex].s2World;
  const rH = geo[hingeIndex].rHingeWorld;

  let Ieff = 0;
  const K = new Vector3();
  const aSum = new Vector3();
  const dKdTheta = new Vector3();
  let gyro = 0;
  const omega2 = omega.lengthSq();

  for (const j of members) {
    const kin = kinematics[j];
    const g = geo[j];
    const r = g.rCmWorld;
    const rho = r.clone().sub(rH);
    const u = new Vector3().crossVectors(s2, rho);
    const Ms2 = applyCentroidTensor(kin, g, s2);
    const Momega = applyCentroidTensor(kin, g, omega);

    Ieff += s2.dot(Ms2) + panelMass * u.lengthSq();
    K.add(Ms2).addScaledVector(new Vector3().crossVectors(r, u), panelMass);
    aSum.addScaledVector(u, panelMass);
    // ∂K/∂θ member term: ŝ2×(M·ŝ2) + m·r×(ŝ2×u)
    dKdTheta.add(new Vector3().crossVectors(s2, Ms2));
    dKdTheta.addScaledVector(new Vector3().crossVectors(r, new Vector3().crossVectors(s2, u)), panelMass);
    // c_θ gyroscopic/centripetal member term: ω·(ŝ2×(M·ω)) + m[(r·u)|ω|² − (r·ω)(u·ω)]
    gyro += omega.dot(new Vector3().crossVectors(s2, Momega));
    gyro += panelMass * (r.dot(u) * omega2 - r.dot(omega) * u.dot(omega));
  }

  const bTheta = K.clone().multiplyScalar(-1 / Ieff);
  const cTheta = (tauHinge + gyro) / Ieff;
  const aTheta = aSum.multiplyScalar(-1 / Ieff);
  return { Ieff, K, bTheta, cTheta, aTheta, dKdTheta };
}

/** Extended-state derivative result for one coupled stage evaluation. */
export interface CoupledDerivResult {
  dq: Quaternion;
  dOmega: Vector3;
  /** dθ_i/dt (= θ̇_i for active panels, 0 otherwise). */
  dTheta: number[];
  /** dθ̇_i/dt (= θ̈_i for active panels, 0 otherwise). */
  dThetaDot: number[];
}

/**
 * Evaluate the complete coupled right-hand side at one candidate stage state.
 * `hingeOf[j]` names the active panel whose hinge drives panel j this step
 * (j itself when active, the active ancestor for a rigid rider, −1 when the
 * panel is rigid with the hub). The hinge torque law is re-evaluated at the
 * STAGE-LOCAL (θ, θ̇) — nothing about the torque is frozen at step start.
 */
export function coupledDeriv(
  qBody: Quaternion,
  omegaBody: Vector3,
  thetas: number[],
  thetaDots: number[],
  hingeOf: number[],
  stopAngles: number[],
  kinematics: PanelKinematics[],
  params: SimulationParams,
): CoupledDerivResult {
  const geo = computePanelGeometryAtStage(kinematics, qBody, thetas);
  const Isc = systemInertiaFromGeometry(kinematics, geo, qBody, params);
  const m = params.panelMass;

  // v_r accumulator: −ω×(I_sc,B·ω) first (whole-system gyroscopic term).
  const vr = new Vector3().crossVectors(omegaBody, mat3MulVec(Isc, omegaBody)).multiplyScalar(-1);
  const D = mat3Clone(Isc);

  const dTheta = new Array<number>(thetas.length).fill(0);
  const dThetaDot = new Array<number>(thetas.length).fill(0);
  const activeCoeffs: { i: number; coeffs: CoupledCoefficients }[] = [];

  for (let i = 0; i < kinematics.length; i++) {
    if (hingeOf[i] !== i) continue; // not an active hinge DOF
    const members: number[] = [];
    for (let j = 0; j < kinematics.length; j++) if (hingeOf[j] === i) members.push(j);

    const thetaDot = thetaDots[i];
    const { tau } = hingeTorqueTotal(thetas[i], thetaDot, stopAngles[i], params.hinge);
    const coeffs = computeAssemblyCoefficients(members, kinematics, geo, omegaBody, tau, m, i);
    activeCoeffs.push({ i, coeffs });

    // [D] += K ⊗ b_θ
    mat3AddOuterInPlace(D, coeffs.K, coeffs.bTheta);
    // v_r += −θ̇·(ω×K) − c_θ·K − θ̇²·(∂K/∂θ)
    vr.addScaledVector(new Vector3().crossVectors(omegaBody, coeffs.K), -thetaDot);
    vr.addScaledVector(coeffs.K, -coeffs.cTheta);
    vr.addScaledVector(coeffs.dKdTheta, -thetaDot * thetaDot);

    // −[I′_sc,B]·ω shape-rate term, member-summed:
    // (∂I_pB/∂θ)·ω = ŝ2×(M·ω) − M·(ŝ2×ω) + m·(2(r·u)ω − (r·ω)u − (u·ω)r)
    const s2 = geo[i].s2World;
    const rHinge = geo[i].rHingeWorld;
    for (const j of members) {
      const g = geo[j];
      const r = g.rCmWorld;
      const rho = r.clone().sub(rHinge);
      const u = new Vector3().crossVectors(s2, rho);
      const Momega = applyCentroidTensor(kinematics[j], g, omegaBody);
      const s2xO = new Vector3().crossVectors(s2, omegaBody);
      const IdotOmega = new Vector3()
        .crossVectors(s2, Momega)
        .sub(applyCentroidTensor(kinematics[j], g, s2xO))
        .addScaledVector(omegaBody, 2 * m * r.dot(u))
        .addScaledVector(u, -m * r.dot(omegaBody))
        .addScaledVector(r, -m * u.dot(omegaBody));
      vr.addScaledVector(IdotOmega, -thetaDot);
    }
  }

  const dOmega = solve3x3(D, vr);

  for (const { i, coeffs } of activeCoeffs) {
    dTheta[i] = thetaDots[i];
    dThetaDot[i] = coeffs.bTheta.dot(dOmega) + coeffs.cTheta;
  }

  // Kinematic equation (world-frame convention, unchanged): dq/dt = ½·[0,ω]⊗q
  const omegaQuat = new Quaternion(omegaBody.x, omegaBody.y, omegaBody.z, 0);
  const qDot = omegaQuat.multiply(qBody.clone());
  const dq = new Quaternion(0.5 * qDot.x, 0.5 * qDot.y, 0.5 * qDot.z, 0.5 * qDot.w);

  return { dq, dOmega, dTheta, dThetaDot };
}

/**
 * Deterministic substep count for the coupled RK4, from params/config alone
 * (never from runtime state — reproducibility). Explicit RK4's stability
 * region bounds dt·λ for the stiffest hinge mode; the mechanical stop's
 * damping on the lightest panel is the binding case (e.g. CFRP short-edge
 * reaches dt·c_stop/Ieff ≈ 3.0 > RK4's ≈2.79 real-axis limit at 1/1200 s).
 * Substeps divide dt so the worst mode stays ≤ ~1.4 with margin.
 */
export function computeCoupledSubstepCount(config: ConfigType, params: SimulationParams): number {
  const kinematics = getPanelKinematics(config, params);
  const h = params.hinge;
  let zMax = 0;
  for (const kin of kinematics) {
    const Ieff = kin.Ip.x; // single-member minimum; assemblies only add inertia
    const stopAngle = kin.spec.maxAngle ?? h.stopAngle;
    const springSlope = (h.hingeModel === 'bistable' && h.bistability)
      ? 2 * h.bistability.bistabilityCoeff * stopAngle * stopAngle
      : h.springConstant;
    const zDamp = params.timeStep * (h.dampingCoeff + h.stopDamping) / Ieff;
    const zOsc = params.timeStep * Math.sqrt((springSlope + h.stopStiffness) / Ieff);
    zMax = Math.max(zMax, zDamp, zOsc);
  }
  return Math.max(1, Math.ceil(zMax / 1.4));
}

/** One classical RK4 step of the full coupled extended state {q, ω, θ, θ̇}. */
export function integrateCoupledSystemRK4(
  qBody: Quaternion,
  omegaBody: Vector3,
  thetas: number[],
  thetaDots: number[],
  hingeOf: number[],
  stopAngles: number[],
  kinematics: PanelKinematics[],
  params: SimulationParams,
  dt: number,
): { qBodyNew: Quaternion; omegaBodyNew: Vector3; thetasNew: number[]; thetaDotsNew: number[] } {
  const n = thetas.length;

  function advance(
    dq: Quaternion, dOmega: Vector3, dTh: number[], dThD: number[], s: number,
  ): { q: Quaternion; w: Vector3; th: number[]; thd: number[] } {
    const q = new Quaternion(
      qBody.x + dq.x * s, qBody.y + dq.y * s, qBody.z + dq.z * s, qBody.w + dq.w * s,
    ).normalize();
    const w = omegaBody.clone().addScaledVector(dOmega, s);
    const th = thetas.map((t, i) => t + dTh[i] * s);
    const thd = thetaDots.map((t, i) => t + dThD[i] * s);
    return { q, w, th, thd };
  }

  const k1 = coupledDeriv(qBody, omegaBody, thetas, thetaDots, hingeOf, stopAngles, kinematics, params);
  const s2 = advance(k1.dq, k1.dOmega, k1.dTheta, k1.dThetaDot, 0.5 * dt);
  const k2 = coupledDeriv(s2.q, s2.w, s2.th, s2.thd, hingeOf, stopAngles, kinematics, params);
  const s3 = advance(k2.dq, k2.dOmega, k2.dTheta, k2.dThetaDot, 0.5 * dt);
  const k3 = coupledDeriv(s3.q, s3.w, s3.th, s3.thd, hingeOf, stopAngles, kinematics, params);
  const s4 = advance(k3.dq, k3.dOmega, k3.dTheta, k3.dThetaDot, dt);
  const k4 = coupledDeriv(s4.q, s4.w, s4.th, s4.thd, hingeOf, stopAngles, kinematics, params);

  const qBodyNew = new Quaternion(
    qBody.x + (dt / 6) * (k1.dq.x + 2 * k2.dq.x + 2 * k3.dq.x + k4.dq.x),
    qBody.y + (dt / 6) * (k1.dq.y + 2 * k2.dq.y + 2 * k3.dq.y + k4.dq.y),
    qBody.z + (dt / 6) * (k1.dq.z + 2 * k2.dq.z + 2 * k3.dq.z + k4.dq.z),
    qBody.w + (dt / 6) * (k1.dq.w + 2 * k2.dq.w + 2 * k3.dq.w + k4.dq.w),
  ).normalize();
  const omegaBodyNew = omegaBody.clone()
    .addScaledVector(k1.dOmega, dt / 6)
    .addScaledVector(k2.dOmega, dt / 3)
    .addScaledVector(k3.dOmega, dt / 3)
    .addScaledVector(k4.dOmega, dt / 6);
  const thetasNew = new Array<number>(n);
  const thetaDotsNew = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    thetasNew[i] = thetas[i] +
      (dt / 6) * (k1.dTheta[i] + 2 * k2.dTheta[i] + 2 * k3.dTheta[i] + k4.dTheta[i]);
    thetaDotsNew[i] = thetaDots[i] +
      (dt / 6) * (k1.dThetaDot[i] + 2 * k2.dThetaDot[i] + 2 * k3.dThetaDot[i] + k4.dThetaDot[i]);
  }

  return { qBodyNew, omegaBodyNew, thetasNew, thetaDotsNew };
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
 * Total system angular momentum about body reference point B, world frame.
 *
 * Exact rigid-multibody decomposition (Hughes 1986, Ch. 3), per panel j:
 *
 *   H_j = M_j · ω_p,j + m · r_j × v_j
 *
 * with M_j the panel's world-rotated CENTROIDAL tensor, r_j its CM position,
 * and the panel's angular velocity / CM velocity accumulated down the full
 * hinge chain (a folded child riding a deploying parent inherits the
 * parent's hinge rate — a chain, not per-panel-independent, kinematics):
 *
 *   ω_p,j = ω + Σ_{a ∈ chain(j)} θ̇_a · ŝ2_a
 *   v_j   = ω × r_j + Σ_{a ∈ chain(j)} θ̇_a · ŝ2_a × (r_j − r_H,a)
 *
 * PHASE-B FIX: the previous diagnostic applied each panel's HINGE-referenced
 * tensor to (ω + θ̇·â) with no m·r×v transport term — an O(1) misstatement of
 * the panel momentum (and it ignored chain riding entirely). This corrected
 * form is the quantity the coupled EOM conserves exactly for L_B = 0.
 * Diagnostic ONLY — never fed back into the state.
 *
 * @returns H_total as a Vector3 in world frame (kg·m²/s)
 */
export function computeTotalAngularMomentum(
  state: SpacecraftState,
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
): Vector3 {
  const kinematics = getPanelKinematics(config, params);
  const qBody = state._bodyQ
    ? new Quaternion(state._bodyQ.x, state._bodyQ.y, state._bodyQ.z, state._bodyQ.w)
    : new Quaternion().setFromEuler(new Euler(state.orientation.x, state.orientation.y, state.orientation.z, 'XYZ'));
  const omegaBody = new Vector3(state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z);

  const thetas = state.panels.map(p => (p.stuck ? p.stuckAngle : p.angle));
  const rates = state.panels.map(p => (p.stuck || p.deployed ? 0 : p.angularVelocity));
  const geo = computePanelGeometryAtStage(kinematics, qBody, thetas);
  const m = params.panelMass;

  // ── Body contribution: H_body = R·I_body_diag·Rᵀ·ω ───────────────────────
  const Ib = bodyInertiaDiag(params);
  const omegaBodyLocal = omegaBody.clone().applyQuaternion(qBody.clone().conjugate());
  const Htotal = applyInertia(Ib, omegaBodyLocal).applyQuaternion(qBody.clone());

  // ── Panel contributions (chain kinematics) ─────────────────────────────────
  for (let j = 0; j < state.panels.length; j++) {
    const r = geo[j].rCmWorld;
    const omegaPanel = omegaBody.clone();
    const vCm = new Vector3().crossVectors(omegaBody, r);
    // Walk j's hinge chain (self, then parent, …) accumulating hinge rates.
    let a: number | undefined = j;
    while (a !== undefined) {
      const rate: number = rates[a];
      if (rate !== 0) {
        omegaPanel.addScaledVector(geo[a].s2World, rate);
        const arm = r.clone().sub(geo[a].rHingeWorld);
        vCm.addScaledVector(new Vector3().crossVectors(geo[a].s2World, arm), rate);
      }
      a = kinematics[a].spec.parentIndex;
    }

    const HspinWorld = applyCentroidTensor(kinematics[j], geo[j], omegaPanel);
    Htotal.add(HspinWorld).addScaledVector(new Vector3().crossVectors(r, vCm), m);
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
  // Thin consumer of the shared stage-geometry helper — the same kinematic
  // chain (parent-resolved hinge positions, panelWorldQuaternion composition)
  // the coupled EOM and the momentum diagnostic use. Child panels' centre
  // offsets now rotate through the FULL parent chain (previously the child's
  // own pos was rotated by its local mount⊗hinge only — inconsistent with the
  // renderer's nested rotating groups for deployed double-long-edge parents).
  const kinematics = getPanelKinematics(config, params);
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

  const thetas = state.panels.map(p => (p.stuck ? p.stuckAngle : p.angle));
  const geo = computePanelGeometryAtStage(kinematics, qBody, thetas);

  // Body CoM is at origin in body frame; panels are mass-weighted about it.
  // r_CoM_body = (m_body · 0 + Σ m_panel · r_panel_body) / M_total
  const comBody = new Vector3();
  const panelCentresWorld: Vector3[] = [];
  const qBodyConj = qBody.clone().conjugate();
  for (let i = 0; i < nPanels; i++) {
    const centreBody = geo[i].rCmWorld.clone().applyQuaternion(qBodyConj);
    comBody.addScaledVector(centreBody, mPanel / mTotal);
    panelCentresWorld.push(geo[i].rCmWorld.clone());
  }

  const comWorld = comBody.clone().applyQuaternion(qBody);
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
    hingeTorque: 0,
    _q: new Quaternion(),
    _omega: new Vector3(0, 0, 0),
  }));
}

export function createInitialState(
  config: ConfigType,
  initialOmega: Vector3 = new Vector3(0, 0, 0),
): SpacecraftState {
  const panels = createInitialPanels(config);
  return {
    angularVelocity: initialOmega.clone(),
    angularAcceleration: new Vector3(0, 0, 0),
    orientation: new Vector3(0, 0, 0),
    panels,
    time: 0,
    deploying: false,
    _bodyQ: new Quaternion(),
    // Explicitly cleared so a fresh (or mutated re-run) state can never inherit a
    // stale post-deployment completion time or stage-activation clock.
    _deployCompleteTime: undefined,
    _stageOpenTimes: undefined,
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

  const kinematics = getPanelKinematics(config, params);
  const specs = kinematics.map(k => k.spec);

  // ── Current body state ────────────────────────────────────────────────────
  const qBody = state._bodyQ
    ? new Quaternion(state._bodyQ.x, state._bodyQ.y, state._bodyQ.z, state._bodyQ.w)
    : new Quaternion().setFromEuler(new Euler(state.orientation.x, state.orientation.y, state.orientation.z, 'XYZ'));
  const omegaBody = new Vector3(state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z); // world-frame

  // ── Stage-relative activation clock ────────────────────────────────────────
  // Record the time at which each stage's predecessor stages first complete
  // (every earlier-stage panel deployed or stuck). Stage 1 opens at t = 0.
  // Per-panel start delays offset from the stage opening time, so the
  // timing-discrepancy δt applies within every stage of staged configurations.
  const stageOpenTimes: Record<number, number> = { 1: 0, ...(state._stageOpenTimes ?? {}) };
  for (const spec of specs) {
    const stage = spec.stage ?? 1;
    if (stageOpenTimes[stage] !== undefined) continue;
    const previousStagesComplete = state.panels.every((p, idx) => {
      const candidateStage = specs[idx].stage ?? 1;
      return candidateStage >= stage || p.deployed || p.stuck;
    });
    if (previousStagesComplete) stageOpenTimes[stage] = state.time;
  }

  // ── Phase 1: classify panels (no dynamics here — the joint RK4 does those) ─
  // A panel is ACTIVE when its hinge DOF evolves this step: not stuck, not
  // latched deployed, its stage has opened, and its start delay has elapsed.
  // The classification is decided once per outer step and held fixed across
  // every RK4 stage/substep (panels never transition mid-step).
  // NOTE: activation is resolved at timestep resolution — delays smaller than
  // params.timeStep quantise to zero and do not shift the trajectory.
  const nPanels = state.panels.length;
  const stopAngles = specs.map(s => s.maxAngle ?? params.hinge.stopAngle);
  const active: boolean[] = new Array(nPanels);
  for (let i = 0; i < nPanels; i++) {
    const panel = state.panels[i];
    const spec = specs[i];
    if (panel.stuck || panel.deployed) { active[i] = false; continue; }
    const panelStage = spec.stage ?? 1;
    const panelStartDelay = (() => {
      // General per-panel delays — authoritative source, applies to ALL configs.
      const generalDelay = params.hinge.panelStartDelays?.[i];
      if (generalDelay !== undefined) return generalDelay;
      // Legacy short-edge-specific delays (retained for backward compatibility).
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
    const stageOpenTime = stageOpenTimes[panelStage];
    active[i] =
      stageOpenTime !== undefined &&
      (state.time + dt) >= stageOpenTime + panelStartDelay;
  }

  // Rider resolution: hingeOf[j] = the active panel whose hinge drives j.
  // An active panel drives itself; a non-active panel rigidly rides its
  // nearest ACTIVE ancestor (e.g. the folded stage-2 child riding a deploying
  // stage-1 parent — its mass moves with the parent's hinge, and ignoring
  // that is an O(1) momentum error); −1 = rigid with the hub.
  const hingeOf: number[] = new Array(nPanels).fill(-1);
  for (let i = 0; i < nPanels; i++) {
    if (active[i]) { hingeOf[i] = i; continue; }
    let a = specs[i].parentIndex;
    while (a !== undefined) {
      if (active[a]) { hingeOf[i] = a; break; }
      a = specs[a].parentIndex;
    }
  }

  const thetas = state.panels.map(p => (p.stuck ? p.stuckAngle : p.angle));
  const thetaDots = state.panels.map((p, i) => (active[i] ? p.angularVelocity : 0));

  // ── Phase 2: joint coupled RK4 over the extended state {q, ω, θ_i, θ̇_i} ──
  // Hub attitude and every active hinge DOF integrate together; each stage
  // re-solves [D]·ω̇ = v_r and re-evaluates the hinge torque law at that
  // stage's (θ, θ̇). Substeps keep the stiff stop-contact mode inside RK4's
  // stability region (count is deterministic from params/config alone).
  const nSub = computeCoupledSubstepCount(config, params);
  let qCur = qBody;
  let wCur = omegaBody;
  let thCur = thetas;
  let thdCur = thetaDots;
  for (let s = 0; s < nSub; s++) {
    const r = integrateCoupledSystemRK4(
      qCur, wCur, thCur, thdCur, hingeOf, stopAngles, kinematics, params, dt / nSub,
    );
    qCur = r.qBodyNew;
    wCur = r.omegaBodyNew;
    thCur = r.thetasNew;
    thdCur = r.thetaDotsNew;
  }
  const qBodyNew: Quaternion = qCur;
  let omegaBodyNew: Vector3 = wCur;

  // ── Phase 3: constraint events (stowed floor + completion latch) ───────────
  // Both events change the state discontinuously: a hinge rate is zeroed (a
  // plastic impact at a physical constraint — the stowed hard stop / the
  // end-of-travel latch engaging) and the latch may snap the angle through
  // the small friction dead-band to the stop. The event is resolved by
  // momentum continuity ACROSS it — the impact impulse is internal, so
  //   H_pre = I_sc,B(θ⁻)·ω⁻ + Σ K_i(θ⁻)·θ̇_i⁻   equals
  //   H_post = I_sc,B(θ⁺)·ω⁺ + Σ K_i(θ⁺)·θ̇_i⁺
  // solved for ω⁺ (covering both the removed hinge-rate momentum and the
  // inertia change from the ≤2° latch snap). This is constraint-impact
  // physics local to the event step — NOT a per-step conservation
  // correction: on steps with no latch/floor event the integrator output is
  // used untouched.
  const thetaFinal = thCur.slice();
  const thetaDotFinal = thdCur.slice();
  const deployedFinal = state.panels.map(p => p.deployed);
  let constraintEvent = false;
  const eventConstrained: boolean[] = new Array(nPanels).fill(false);
  const h = params.hinge;

  for (let i = 0; i < nPanels; i++) {
    if (!active[i]) continue;

    // Stowed hard-stop floor: never rotate below θ = 0.
    if (thetaFinal[i] < 0) {
      constraintEvent = true;
      eventConstrained[i] = true;
      thetaFinal[i] = 0;
      thetaDotFinal[i] = 0;
    }

    // ── Completion latch ────────────────────────────────────────────────────
    // Latch "deployed" once the panel is effectively at rest close to the
    // stop, then hold it there — a real end-of-travel latch engaging. The
    // tolerance is the Coulomb-friction dead-band τ_f/k_eff (where the hinge
    // can stall short of the stop), CAPPED at DEPLOY_LATCH_MAX_DEADBAND_RAD
    // so a soft-spring hinge that stalls far from the stop is honestly
    // reported as an incomplete deployment instead of being snapped through
    // tens of degrees. The calibrated underdamped hinge reaches the stop with
    // momentum and latches during/after the first stop contact (snap ≈ 0°).
    const effectiveStiffness = (h.hingeModel === 'bistable' && h.bistability)
      ? 2 * h.bistability.bistabilityCoeff * stopAngles[i] * stopAngles[i]
      : h.springConstant;
    const frictionDeadband = Math.min(
      effectiveStiffness > 0 ? h.frictionCoeff / effectiveStiffness : 0,
      DEPLOY_LATCH_MAX_DEADBAND_RAD,
    );
    if (
      thetaFinal[i] >= stopAngles[i] - (frictionDeadband + DEPLOY_LATCH_MARGIN_RAD) &&
      Math.abs(thetaDotFinal[i]) < 0.1
    ) {
      deployedFinal[i] = true;
      constraintEvent = true;
      eventConstrained[i] = true;
      thetaFinal[i] = stopAngles[i];
      thetaDotFinal[i] = 0;
    }
  }

  // Final geometry at the post-event angles (shared by the event resolution,
  // telemetry, and panel-state assembly below).
  const geoFinal = computePanelGeometryAtStage(kinematics, qBodyNew, thetaFinal);

  if (constraintEvent) {
    // Generalized perfectly-inelastic constraint projection over the full
    // active generalized state (ω, θ̇_j). The event applies an impulsive
    // constraint torque only at the latching/floored hinge(s); every OTHER
    // generalized momentum is carried across the event:
    //
    //   hub:            I_sc,B⁺·ω⁺ + Σ_A K_j⁺·θ̇_j⁺        = H_pre
    //   hinge j ∈ A:    K_j⁺·ω⁺   + Ieff_j⁺·θ̇_j⁺          = p_j⁻
    //                   with p_j⁻ = K_j⁻·ω⁻ + Ieff_j⁻·θ̇_j⁻ (conjugate hinge
    //                   momentum ∂T/∂θ̇_j, unchanged by the impulse)
    //
    // where A = assemblies still active after the event. Eliminating θ̇_j⁺
    // gives the Schur-reduced 3×3 solve
    //
    //   [I_sc,B⁺ − Σ_A (K_j⁺⊗K_j⁺)/Ieff_j⁺]·ω⁺ = H_pre − Σ_A K_j⁺·p_j⁻/Ieff_j⁺
    //
    // This is exactly q̇⁺ = q̇⁻ − M⁻¹Jᵀ(JM⁻¹Jᵀ)⁻¹J·q̇⁻ for the system mass
    // matrix M(q) (panel–panel coupling is zero — panels couple only through
    // the hub) — validated against an independently derived planar reference
    // in coupledLatch.test.ts. With no other active panel it reduces to the
    // pure momentum-continuity hub solve. Geometry (the ≤2° latch snap) is
    // taken at the post-event angles; H_pre at the pre-event angles, so total
    // angular momentum is carried through the event exactly. This fires ONLY
    // on latch/floor event steps — never as a per-step correction.
    const assembly = (geo: PanelStageGeometry[], i: number) => {
      const members: number[] = [];
      for (let j = 0; j < nPanels; j++) if (hingeOf[j] === i) members.push(j);
      const co = computeAssemblyCoefficients(
        members, kinematics, geo, new Vector3(), 0, params.panelMass, i,
      );
      return { K: co.K, Ieff: co.Ieff };
    };

    // H immediately before the event (integrator-output angles/rates):
    const geoPre = computePanelGeometryAtStage(kinematics, qBodyNew, thCur);
    const Hpre = mat3MulVec(
      systemInertiaFromGeometry(kinematics, geoPre, qBodyNew, params), omegaBodyNew,
    );
    for (let i = 0; i < nPanels; i++) {
      if (hingeOf[i] === i && thdCur[i] !== 0) {
        Hpre.addScaledVector(assembly(geoPre, i).K, thdCur[i]);
      }
    }

    // Still-active assemblies: conjugate momenta p_j⁻ and post-event coefficients.
    const IscFinal = systemInertiaFromGeometry(kinematics, geoFinal, qBodyNew, params);
    const Meff = mat3Clone(IscFinal);
    const rhs = Hpre.clone();
    const post: { i: number; K: Vector3; Ieff: number; pPre: number }[] = [];
    for (let i = 0; i < nPanels; i++) {
      if (hingeOf[i] !== i || eventConstrained[i]) continue;
      const pre = assembly(geoPre, i);
      const fin = assembly(geoFinal, i);
      const pPre = pre.K.dot(omegaBodyNew) + pre.Ieff * thdCur[i];
      post.push({ i, K: fin.K, Ieff: fin.Ieff, pPre });
      mat3AddOuterInPlace(Meff, fin.K.clone().multiplyScalar(-1 / fin.Ieff), fin.K);
      rhs.addScaledVector(fin.K, -pPre / fin.Ieff);
    }

    omegaBodyNew = solve3x3(Meff, rhs);
    for (const a of post) {
      thetaDotFinal[a.i] = (a.pPre - a.K.dot(omegaBodyNew)) / a.Ieff;
    }
  }

  // Approximate angular acceleration from finite difference (for telemetry)
  const alphaWorld = omegaBodyNew.clone().sub(omegaBody).multiplyScalar(1 / dt);

  // ── Phase 4: assemble new panel states ─────────────────────────────────────
  const newPanels: PanelState[] = state.panels.map((panel, i) => {
    if (panel.stuck) {
      return {
        ...panel,
        hingeTorque: 0,
        _q: geoFinal[i].qPanelWorld,
        _omega: omegaBodyNew.clone(),
      };
    }

    // Telemetry at the final state: hinge torque and stop-contact magnitude
    // from the same single torque law the integrator uses (0 when inactive).
    let hingeTorque = 0;
    let contactForce = 0;
    if (active[i] && !deployedFinal[i]) {
      const t = hingeTorqueTotal(thetaFinal[i], thetaDotFinal[i], stopAngles[i], h);
      hingeTorque = t.tau;
      contactForce = t.contact;
    }

    // Panel world angular velocity via the hinge chain (a rider inherits its
    // driving parent's rate; matches the momentum diagnostic's kinematics).
    const omegaPanelNew = omegaBodyNew.clone();
    let a: number | undefined = i;
    while (a !== undefined) {
      if (thetaDotFinal[a] !== 0) omegaPanelNew.addScaledVector(geoFinal[a].s2World, thetaDotFinal[a]);
      a = specs[a].parentIndex;
    }

    return {
      ...panel,
      angle: thetaFinal[i],
      angularVelocity: thetaDotFinal[i],
      deployed: deployedFinal[i],
      contactForce,
      hingeTorque,
      _q: geoFinal[i].qPanelWorld,
      _omega: omegaPanelNew,
    };
  });

  // ── Map to legacy state ────────────────────────────────────────────────────
  const e = new Euler().setFromQuaternion(qBodyNew.clone(), 'XYZ');
  const euler = new Vector3(e.x, e.y, e.z);
  const allDeployed = newPanels.every(p => p.deployed || p.stuck);
  const newTime = state.time + dt;

  // ── Post-deployment observation window ─────────────────────────────────────
  // Once deployment completes the panels are already held fixed (per-panel branches
  // above), but we keep `deploying` true — and thus keep integrating the body — for a
  // short window so the attitude keeps evolving and stays visible. `_deployCompleteTime`
  // records the completion instant and is shared by every caller (runFullSimulation loop
  // and the SimulationPage RAF loop both key off `deploying`).
  const deployCompleteTime = state._deployCompleteTime ?? (allDeployed ? newTime : undefined);
  const withinObservationWindow =
    deployCompleteTime !== undefined && newTime < deployCompleteTime + POST_DEPLOY_OBSERVATION_S;

  const newState: SpacecraftState = {
    angularVelocity: omegaBodyNew,
    angularAcceleration: alphaWorld,
    orientation: euler,
    panels: newPanels,
    time: newTime,
    deploying: !allDeployed || withinObservationWindow,
    _bodyQ: qBodyNew,
    _deployCompleteTime: deployCompleteTime,
    _stageOpenTimes: stageOpenTimes,
  };

  // NOTE: the composite system CoM (`comBody`) is a rendering concern and is no
  // longer computed here — at the 1/1200 s physics timestep it dominated the hot
  // loop. The UI computes it once per DISPLAYED frame via computeSystemCoM and
  // attaches it to the state it renders (see SimulationPage), which is the only
  // consumer (CubeSatViewer group offset).
  return newState;
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
  /**
   * Cumulative body attitude rotation (in degrees) caused purely by panel deployment
   * angular momentum exchange — body Euler-angle change from t=0 to current frame.
   */
  attitudeCouplingDeg?: number;
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
  initialOmega: Vector3 = new Vector3(0, 0, 0),
): SimulationFrame[] {
  let state = createInitialState(config, initialOmega);
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

  // Cadences are TIME-based (steps derived from the timestep), so the recorded
  // chart density (~20 Hz) and the 1 Hz momentum-warning check are independent
  // of the physics resolution.
  const recordEvery = Math.max(1, Math.round(0.05 / params.timeStep)); // ~20 Hz frames
  const warnEvery = Math.max(1, Math.round(1 / params.timeStep));      // ~1 Hz warn check

  // ── Angular momentum conservation tracking ─────────────────────────────
  const H0 = computeTotalAngularMomentum(state, config, params);
  const H0mag = Math.sqrt(H0.x * H0.x + H0.y * H0.y + H0.z * H0.z);

  // ── Attitude coupling tracking (cumulative rotation from t=0) ──────────
  const q0 = state._bodyQ
    ? new Quaternion(state._bodyQ.x, state._bodyQ.y, state._bodyQ.z, state._bodyQ.w)
    : new Quaternion();

  for (let i = 0; i < maxSteps; i++) {
    state = stepSimulation(state, config, params);

    // ── Periodic momentum conservation check (~1 s warn / ~50 ms record) ──
    let momentumError = 0;
    if (i % warnEvery === warnEvery - 1 || i % recordEvery === 0) {
      const Hcur = computeTotalAngularMomentum(state, config, params);
      const dH = {
        x: Hcur.x - H0.x,
        y: Hcur.y - H0.y,
        z: Hcur.z - H0.z,
      };
      const dHmag = Math.sqrt(dH.x * dH.x + dH.y * dH.y + dH.z * dH.z);
      momentumError = H0mag > 1e-12 ? dHmag / H0mag : dHmag;

      // Warn on > 5% violation (only on the ~1 s check cadence)
      if (i % warnEvery === warnEvery - 1 && momentumError > 0.05) {
        console.warn(
          `[momentum] t=${state.time.toFixed(3)}s: angular momentum error ` +
          `${(momentumError * 100).toFixed(2)}% exceeds 5% threshold`,
        );
      }
    }

    // Record frames at ~20 Hz for chart data (independent of physics timestep)
    if (i % recordEvery === 0) {
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
        attitudeCouplingDeg,
        // 6-decimal (nJ) resolution: physics-driven deployment transients are
        // ~1e-4 mJ and would underflow the previous 3-decimal rounding to 0.
        eDetumble: Math.round(eDetumbleMJ * 1e6) / 1e6,
      });
    }

    // `deploying` now stays true through the post-deployment observation window, so this
    // fires only once the window closes; the `maxSteps` loop bound still caps at `maxTime`
    // (deployments that never complete keep the existing maxTime behaviour).
    if (!state.deploying) break;
  }

  return frames;
}

// NOTE: the legacy engine-level `computeReportData` (a second, kinematic-configured
// report path, unused by the UI) was removed with the kinematic deployment mode.
// The single scientific report path is `src/lib/physics/reportData.ts`, which runs
// the physics-driven hinge dynamics only.
