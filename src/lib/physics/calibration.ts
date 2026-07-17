// ─────────────────────────────────────────────────────────────────────────────
//  Torsional-hinge calibration & sensitivity diagnostic
//
//  ENGINEERING CALIBRATION — NOT FLIGHT QUALIFICATION. There is no vendor
//  torsion-spring datasheet or hinge test record in this repository. This
//  module provides a reproducible, deterministic sweep over candidate
//  (springConstant k, dampingCoeff c) pairs, evaluated with the PRODUCTION
//  engine (stepSimulation) on the FR4 nominal long-edge configuration, so the
//  default hinge constants can be selected transparently against a documented
//  target and re-derived at any time.
//
//  Calibration target (basis documented in DEFAULT_PARAMS, types.ts):
//    - nominal single-stage deployment time, defined as the time from release
//      to FIRST reach of 90% of the deployed (stop) angle, within 1.0–2.0 s,
//      preferring ≈ 1.5 s;
//    - free-travel hinge response underdamped / lightly damped (ζ < 1);
//    - no numerical instability, unbounded angle, or persistent post-stop
//      oscillation; deployment time remains an EMERGENT simulation result.
//
//  Free-travel hinge approximation used for ζ and ωₙ (documented, exact):
//    the 1-DOF hinge equation the engine integrates in free travel is
//        I_eff·θ̈ = k·(θ_stop − θ) − c·θ̇ − τ_f·sgn(θ̇)
//    where I_eff is the panel inertia about the hinge axis as the engine maps
//    it: the hinge axis is local X, so I_eff = Ixx of panelInertiaDiag =
//        I_eff = (1/12)·m_panel·(span² + thickness²)
//    (long-edge FR4: (1/12)(0.032)(0.3405² + 0.0025²) ≈ 3.0917e-4 kg·m²).
//    Then  ωₙ = √(k/I_eff)  [rad/s]  and  ζ = c / (2·√(k·I_eff))  [-].
//    NOTE (known Phase-B item): whether Ixx is the physically correct
//    hinge-axis moment is the IS2 axis-mapping question deferred to Phase B;
//    the engine is self-consistent with this mapping, and the calibration is
//    defined against the engine as it exists.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createInitialState,
  stepSimulation,
  computeTotalAngularMomentum,
} from './engine';
import { getPanelSpecs } from './panelLayouts';
import {
  DEFAULT_PARAMS,
  type ConfigType,
  type SimulationParams,
} from './types';

/**
 * Effective free-travel hinge inertia (kg·m²) exactly as the production engine
 * maps it (hinge axis = panel-local X → diagonal entry Ixx of the panel
 * inertia tensor about the hinge edge).
 */
export function hingeFreeTravelInertia(
  params: SimulationParams = DEFAULT_PARAMS,
  config: ConfigType = 'long-edge',
  panelIndex = 0,
): number {
  const spec = getPanelSpecs(config, params)[panelIndex];
  const span = spec.size[2];
  const thickness = spec.size[1];
  return (1 / 12) * params.panelMass * (span * span + thickness * thickness);
}

/** ωₙ = √(k/I_eff) for the free-travel hinge approximation (rad/s). */
export function hingeNaturalFrequency(k: number, inertia: number): number {
  return Math.sqrt(k / inertia);
}

/** ζ = c / (2·√(k·I_eff)) for the free-travel hinge approximation (–). */
export function hingeDampingRatio(k: number, c: number, inertia: number): number {
  return c / (2 * Math.sqrt(k * inertia));
}

export interface HingeCandidateMetrics {
  /** Spring stiffness (N·m/rad). */
  k: number;
  /** Viscous damping (N·m·s/rad). */
  c: number;
  /** Free-travel natural frequency ωₙ (rad/s). */
  omegaN: number;
  /** Free-travel damping ratio ζ (–). */
  zeta: number;
  /** Effective hinge inertia used for ωₙ/ζ (kg·m²). */
  inertia: number;
  /** Physics timestep used (s). */
  timeStep: number;
  /** First time panel 0 reaches 90% of its deployed angle (s); NaN if never. */
  t90: number;
  /** First time panel 0 reaches its full deployed angle / stop (s); NaN if never. */
  t100: number;
  /** Time at which ALL non-stuck panels have latched deployed (s); NaN if never. */
  latchTime: number;
  /** Largest angle gap (rad) closed by a latch snap (θ_stop − θ just before latch). */
  maxLatchSnapRad: number;
  /** Peak |θ̇| over all panels (rad/s). */
  peakPanelRate: number;
  /** Peak |hinge torque| over all panels (N·m). */
  peakHingeTorque: number;
  /** Peak |ω_body| (rad/s). */
  peakBodyRate: number;
  /** Max |H_total| drift: absolute (kg·m²/s) since |H₀| ≈ 0 for rest starts. */
  maxMomentumDriftAbs: number;
  /** Max relative |ΔH|/|H₀| when |H₀| > 1e-12, else 0. */
  maxMomentumDriftRel: number;
  /** Whether any mechanical-stop contact occurred (contactForce > 0). */
  stopContact: boolean;
  /** Max overshoot past the stop angle (rad), from stop penetration. */
  maxOvershootRad: number;
  /** Time from first stop contact to full latch (s); NaN if no contact/latch. */
  contactToLatchS: number;
  /** Any NaN/∞ encountered in angles or body rate. */
  numericalFailure: boolean;
}

export interface EvaluateOptions {
  config?: ConfigType;
  stuckPanels?: number[];
  timeStep?: number;
  /** Simulation cap (s) — runs end early once all panels latch + observation window. */
  maxTime?: number;
  params?: SimulationParams;
  /**
   * Coulomb friction override (N·m). Used by the sensitivity analysis to
   * demonstrate the legacy 5e-4 N·m value is inconsistent with the calibrated
   * soft spring (short-edge panels stall 23° short of the stop) — see the
   * frictionCoeff note in DEFAULT_PARAMS and calibration.test.ts.
   */
  friction?: number;
}

/**
 * Evaluate one (k, c) candidate with the production engine. Deterministic:
 * fixed-step integration, no randomness — identical inputs give identical
 * metrics.
 */
export function evaluateHingeCandidate(
  k: number,
  c: number,
  options: EvaluateOptions = {},
): HingeCandidateMetrics {
  const config = options.config ?? 'long-edge';
  const timeStep = options.timeStep ?? DEFAULT_PARAMS.timeStep;
  const maxTime = options.maxTime ?? 30;
  const base = options.params ?? DEFAULT_PARAMS;

  const params: SimulationParams = {
    ...base,
    timeStep,
    hinge: {
      ...base.hinge,
      springConstant: k,
      dampingCoeff: c,
      ...(options.friction !== undefined ? { frictionCoeff: options.friction } : {}),
    },
  };
  const specs = getPanelSpecs(config, params);
  const targets = specs.map(s => s.maxAngle ?? params.hinge.stopAngle);

  const inertia = hingeFreeTravelInertia(params, config);
  const omegaN = hingeNaturalFrequency(k, inertia);
  const zeta = hingeDampingRatio(k, c, inertia);

  let state = createInitialState(config);
  state.deploying = true;
  for (const idx of options.stuckPanels ?? []) {
    if (idx < state.panels.length) {
      state.panels[idx].stuck = true;
      state.panels[idx].stuckAngle = 0;
    }
  }

  const H0 = computeTotalAngularMomentum(state, config, params);
  const H0mag = Math.hypot(H0.x, H0.y, H0.z);

  // Deployment-time metrics track the first NON-stuck panel (panel 0 unless stuck).
  const trackedPanel = state.panels.findIndex(p => !p.stuck);
  let t90 = NaN;
  let t100 = NaN;
  let latchTime = NaN;
  let firstContactT = NaN;
  let maxLatchSnapRad = 0;
  let peakPanelRate = 0;
  let peakHingeTorque = 0;
  let peakBodyRate = 0;
  let maxMomentumDriftAbs = 0;
  let maxMomentumDriftRel = 0;
  let stopContact = false;
  let maxOvershootRad = 0;
  let numericalFailure = false;

  const maxSteps = Math.ceil(maxTime / timeStep);
  // Sample H at ~50 ms cadence (H evaluation is comparatively expensive).
  const hEvery = Math.max(1, Math.round(0.05 / timeStep));
  let prevAngles = state.panels.map(p => p.angle);
  let prevDeployed = state.panels.map(p => p.deployed);

  for (let i = 0; i < maxSteps; i++) {
    state = stepSimulation(state, config, params);

    for (let p = 0; p < state.panels.length; p++) {
      const panel = state.panels[p];
      if (!Number.isFinite(panel.angle) || !Number.isFinite(panel.angularVelocity)) {
        numericalFailure = true;
      }
      peakPanelRate = Math.max(peakPanelRate, Math.abs(panel.angularVelocity));
      peakHingeTorque = Math.max(peakHingeTorque, Math.abs(panel.hingeTorque));
      if (panel.contactForce > 0) {
        stopContact = true;
        if (Number.isNaN(firstContactT)) firstContactT = state.time;
      }
      maxOvershootRad = Math.max(maxOvershootRad, panel.angle - targets[p]);
      // Latch snap size: gap closed when `deployed` flips true this step.
      if (panel.deployed && !prevDeployed[p]) {
        maxLatchSnapRad = Math.max(maxLatchSnapRad, targets[p] - prevAngles[p]);
      }
    }

    const bodyRate = Math.hypot(
      state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z,
    );
    if (!Number.isFinite(bodyRate)) numericalFailure = true;
    peakBodyRate = Math.max(peakBodyRate, bodyRate);

    if (trackedPanel >= 0) {
      if (Number.isNaN(t90) && state.panels[trackedPanel].angle >= 0.9 * targets[trackedPanel]) {
        t90 = state.time;
      }
      if (Number.isNaN(t100) && state.panels[trackedPanel].angle >= targets[trackedPanel] - 1e-12) {
        t100 = state.time;
      }
    }
    if (Number.isNaN(latchTime) && state.panels.every(p => p.deployed || p.stuck)) {
      latchTime = state.time;
    }

    if (i % hEvery === 0 || !state.deploying) {
      const H = computeTotalAngularMomentum(state, config, params);
      const drift = Math.hypot(H.x - H0.x, H.y - H0.y, H.z - H0.z);
      maxMomentumDriftAbs = Math.max(maxMomentumDriftAbs, drift);
      if (H0mag > 1e-12) {
        maxMomentumDriftRel = Math.max(maxMomentumDriftRel, drift / H0mag);
      }
    }

    prevAngles = state.panels.map(p => p.angle);
    prevDeployed = state.panels.map(p => p.deployed);

    if (!state.deploying) break;
  }

  const contactToLatchS =
    Number.isNaN(firstContactT) || Number.isNaN(latchTime) ? NaN : latchTime - firstContactT;

  return {
    k, c, omegaN, zeta, inertia, timeStep,
    t90, t100, latchTime, maxLatchSnapRad,
    peakPanelRate, peakHingeTorque, peakBodyRate,
    maxMomentumDriftAbs, maxMomentumDriftRel,
    stopContact, maxOvershootRad, contactToLatchS,
    numericalFailure,
  };
}

export interface CalibrationGridEntry {
  /** Metrics at the production timestep. */
  atDt: HingeCandidateMetrics;
  /** Metrics at half the production timestep (convergence check). */
  atHalfDt: HingeCandidateMetrics;
  /** |t90(dt) − t90(dt/2)| / t90(dt/2) — deployment-time convergence. */
  t90RelDiff: number;
}

/**
 * The documented calibration grid: ωₙ ∈ {1.2, 1.5, 2.0, 2.5, 3.0} rad/s ×
 * ζ ∈ {0.15, 0.3, 0.5, 0.8}, mapped to (k, c) via the free-travel
 * approximation k = I_eff·ωₙ², c = 2ζ√(k·I_eff). Grid bounds bracket the
 * 1.0–2.0 s target window for the 90%-angle metric (ωₙ ≈ 2 rad/s gives a
 * ≈ 1.5 s first-90% crossing for light damping) while staying strictly
 * underdamped (ζ < 1).
 */
export const CALIBRATION_OMEGA_N = [1.2, 1.5, 2.0, 2.5, 3.0] as const;
export const CALIBRATION_ZETA = [0.15, 0.3, 0.5, 0.8] as const;

export function runCalibrationGrid(): CalibrationGridEntry[] {
  const inertia = hingeFreeTravelInertia();
  const entries: CalibrationGridEntry[] = [];
  for (const omegaN of CALIBRATION_OMEGA_N) {
    for (const zeta of CALIBRATION_ZETA) {
      const k = inertia * omegaN * omegaN;
      const c = 2 * zeta * Math.sqrt(k * inertia);
      const atDt = evaluateHingeCandidate(k, c);
      const atHalfDt = evaluateHingeCandidate(k, c, { timeStep: DEFAULT_PARAMS.timeStep / 2 });
      const t90RelDiff =
        Number.isFinite(atDt.t90) && Number.isFinite(atHalfDt.t90) && atHalfDt.t90 > 0
          ? Math.abs(atDt.t90 - atHalfDt.t90) / atHalfDt.t90
          : NaN;
      entries.push({ atDt, atHalfDt, t90RelDiff });
    }
  }
  return entries;
}

/** One-line table row for logging a grid entry. */
export function formatGridEntry(e: CalibrationGridEntry): string {
  const m = e.atDt;
  const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'never');
  return (
    `k=${m.k.toExponential(3)} N·m/rad  c=${m.c.toExponential(3)} N·m·s/rad  ` +
    `ωn=${m.omegaN.toFixed(2)}  ζ=${m.zeta.toFixed(2)}  ` +
    `t90=${f(m.t90)}s  t100=${f(m.t100)}s  latch=${f(m.latchTime)}s  ` +
    `snap=${(m.maxLatchSnapRad * 180 / Math.PI).toFixed(2)}°  ` +
    `θ̇pk=${m.peakPanelRate.toFixed(3)}rad/s  τpk=${m.peakHingeTorque.toExponential(2)}N·m  ` +
    `ωbody,pk=${m.peakBodyRate.toExponential(2)}rad/s  |ΔH|max=${m.maxMomentumDriftAbs.toExponential(2)}  ` +
    `contact=${m.stopContact ? 'y' : 'n'}  overshoot=${(m.maxOvershootRad * 180 / Math.PI).toFixed(2)}°  ` +
    `t90(dt vs dt/2)Δ=${Number.isFinite(e.t90RelDiff) ? (e.t90RelDiff * 100).toFixed(2) + '%' : 'n/a'}  ` +
    `${m.numericalFailure ? 'NUMERICAL-FAILURE' : 'ok'}`
  );
}
