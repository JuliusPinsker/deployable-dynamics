// ─────────────────────────────────────────────────────────────────────────────
//  Translational-coupling omission diagnostic (Phase-B, Gate C).
//
//  The production coupled EOM is the ROTATIONAL-ONLY specialization of the
//  Bascom–Schaub formulation: body reference point B is treated as inertially
//  pinned. This diagnostic is a BOUND ON INTENTIONALLY OMITTED FORCING, not a
//  claim that hub translation is zero — with F_ext ≡ 0 and v_cm(0) = 0 the
//  SYSTEM CM acceleration is exactly zero, but B is offset from the CM during
//  asymmetric deployment, so B genuinely accelerates: r̈_B/N = −r̈_C/B ≠ 0.
//
//  The rotational-only model omits TWO r̈_B/N-dependent contributions to the
//  paper's Eq. 5 / Eq. 11:
//    (1) the direct system term  m_sc·(r_C/B × r̈_B/N)          (Eq. 5 LHS)
//    (2) each active panel's     a_θ,i·r̈_B/N  term, propagated  (Eq. 11/12)
//        through that panel's K_i in the hub equation.
//  Both are assembled COMBINED and pushed through the same [D]⁻¹ solve as the
//  real dynamics, giving Δω̇(t); the reported ratio is evaluated across the
//  FULL TIME HISTORY (every `sampleStride`-th step; stencil-contaminated
//  windows around latch/floor events excluded, since the event is impulsive
//  by design and has its own dedicated validation):
//
//    ratio(t) = ‖Δω̇(t)‖ / max(‖ω̇_retained(t)‖, OMEGA_DOT_FLOOR)
//
//  r̈_B/N is estimated from the exact identity r̈_B/N = −r̈_C/B via a 5-point
//  Savitzky–Golay second derivative of computeSystemCoM(...).comWorld.
//
//  This ratio bounds omitted FORCING relative to retained rotational forcing
//  at each instant — it does NOT bound output attitude or angle error.
//  NO-GO gate: src/test/translationalCoupling.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { Vector3 } from 'three';
import {
  createInitialState,
  stepSimulation,
  computeSystemCoM,
  computeSystemInertiaAboutB,
  computePanelGeometryAtStage,
  computeAssemblyCoefficients,
  coupledDeriv,
  getPanelKinematics,
  hingeTorqueTotal,
  type PanelKinematics,
} from './engine';
import { mat3Clone, mat3AddOuterInPlace, solve3x3 } from './linearAlgebra';
import { DEFAULT_PARAMS, Quaternion, type ConfigType, type SimulationParams, type SpacecraftState } from './types';

/**
 * Floor for the ω̇ normalisation (rad/s²): guards the ratio against
 * near-zero-acceleration instants (e.g. spatially symmetric deployments,
 * post-latch coast). Documented scale: ≈1e-9 rad/s² is ~6 orders below the
 * smallest genuine deployment transient observed in any scenario.
 */
export const OMEGA_DOT_FLOOR = 1e-9;

/** Steps skipped around each latch/floor event (stencil width + margin). */
const EVENT_EXCLUSION_STEPS = 3;

export interface TranslationalCouplingReport {
  /** max over the scanned history of ‖Δω̇‖/max(‖ω̇_retained‖, floor). */
  ratio: number;
  /** Time at which the maximum occurs (s). */
  peakTime: number;
  /** r̈_B/N at that instant (m/s²), world frame. */
  rBddotWorld: Vector3;
  /** Retained rotational-only ω̇ at that instant (rad/s²). */
  omegaDotActual: Vector3;
  /** Combined omitted-forcing ω̇ perturbation at that instant (rad/s²). */
  deltaOmegaDot: Vector3;
  /** ‖m_sc·(r_C/B×r̈_B/N)‖ at that instant (N·m) — direct component alone. */
  directTermMag: number;
  /** ‖Σ K_i·(a_θ,i·r̈_B/N)‖ summed magnitude (N·m) — panel component alone. */
  panelTermMag: number;
  /** Number of history samples evaluated. */
  samplesEvaluated: number;
}

/**
 * Scan a scenario's FULL deployment history with the production engine and
 * report the worst-case combined omitted-forcing ratio. Deterministic:
 * fixed-step production integration, fixed sampling stride, no randomness.
 */
export function estimateTranslationalCouplingRatio(
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
  stuckPanels: number[] = [],
  initialOmega: Vector3 = new Vector3(0, 0, 0),
  maxTime = 12,
  sampleStride = 3,
): TranslationalCouplingReport {
  const dt = params.timeStep;
  const steps = Math.ceil(maxTime / dt);
  const kinematics: PanelKinematics[] = getPanelKinematics(config, params);
  const nPanels = kinematics.length;
  const stopAngles = kinematics.map(k => k.spec.maxAngle ?? params.hinge.stopAngle);
  const mSc = params.bodyMass + params.panelMass * nPanels;

  let state = createInitialState(config, initialOmega.clone());
  state.deploying = true;
  for (const idx of stuckPanels) {
    if (idx < state.panels.length) {
      state.panels[idx].stuck = true;
      state.panels[idx].stuckAngle = 0;
    }
  }

  // Rolling buffers: CoM at the last 5 steps; states at the last 3 steps
  // (the stencil centre is 2 steps behind the newest sample).
  const comBuf: Vector3[] = [];
  const stateBuf: SpacecraftState[] = [];
  let prevDeployed = state.panels.map(p => p.deployed);
  let lastEventStep = -Infinity;

  const best: TranslationalCouplingReport = {
    ratio: 0, peakTime: NaN,
    rBddotWorld: new Vector3(), omegaDotActual: new Vector3(), deltaOmegaDot: new Vector3(),
    directTermMag: 0, panelTermMag: 0, samplesEvaluated: 0,
  };

  for (let i = 0; i < steps && state.deploying; i++) {
    state = stepSimulation(state, config, params);
    const deployedNow = state.panels.map(p => p.deployed);
    if (deployedNow.some((d, j) => d !== prevDeployed[j])) lastEventStep = i;
    prevDeployed = deployedNow;

    comBuf.push(computeSystemCoM(state, config, params).comWorld.clone());
    if (comBuf.length > 5) comBuf.shift();
    stateBuf.push(state);
    if (stateBuf.length > 3) stateBuf.shift();
    if (comBuf.length < 5) continue;

    const centreStep = i - 2;
    if (centreStep % sampleStride !== 0) continue;
    // Exclude stencil windows contaminated by an impulsive latch/floor event
    // (the event has its own dedicated validation in coupledLatch.test.ts):
    if (Math.abs(centreStep - lastEventStep) <= EVENT_EXCLUSION_STEPS + 2) continue;

    const centre = stateBuf[0];
    const sample = evaluateAt(centre, comBuf, dt, config, kinematics, stopAngles, params, mSc);
    if (sample && sample.ratio > best.ratio) {
      best.ratio = sample.ratio;
      best.peakTime = centre.time;
      best.rBddotWorld = sample.rBddot;
      best.omegaDotActual = sample.omegaDotActual;
      best.deltaOmegaDot = sample.deltaOmegaDot;
      best.directTermMag = sample.directTermMag;
      best.panelTermMag = sample.panelTermMag;
    }
    best.samplesEvaluated++;
  }

  return best;
}

function evaluateAt(
  centre: SpacecraftState,
  comBuf: Vector3[],
  dt: number,
  config: ConfigType,
  kinematics: PanelKinematics[],
  stopAngles: number[],
  params: SimulationParams,
  mSc: number,
): {
  ratio: number; rBddot: Vector3; omegaDotActual: Vector3; deltaOmegaDot: Vector3;
  directTermMag: number; panelTermMag: number;
} | null {
  // 5-point Savitzky–Golay second derivative: f̈ ≈ Σ w_k f_k / (7·dt²).
  const w = [2, -1, -2, -1, 2];
  const rCddot = new Vector3();
  for (let k = 0; k < 5; k++) rCddot.addScaledVector(comBuf[k], w[k]);
  rCddot.multiplyScalar(1 / (7 * dt * dt));
  const rBddot = rCddot.clone().multiplyScalar(-1); // exact: F_ext ≡ 0, v_cm(0) = 0

  const nPanels = kinematics.length;
  const qBody = centre._bodyQ
    ? new Quaternion(centre._bodyQ.x, centre._bodyQ.y, centre._bodyQ.z, centre._bodyQ.w)
    : new Quaternion();
  const omega = centre.angularVelocity.clone();
  const thetas = centre.panels.map(p => (p.stuck ? p.stuckAngle : p.angle));
  const thetaDots = centre.panels.map(p => (p.stuck || p.deployed ? 0 : p.angularVelocity));

  // Active/rider classification mirroring the engine's rule at this state:
  const active = thetas.map((_, i) =>
    !centre.panels[i].stuck && !centre.panels[i].deployed && Math.abs(thetaDots[i]) > 1e-12,
  );
  const hingeOf: number[] = new Array(nPanels).fill(-1);
  for (let i = 0; i < nPanels; i++) {
    if (active[i]) { hingeOf[i] = i; continue; }
    let a = kinematics[i].spec.parentIndex;
    while (a !== undefined) {
      if (active[a]) { hingeOf[i] = a; break; }
      a = kinematics[a].spec.parentIndex;
    }
  }
  if (!active.some(Boolean)) return null; // nothing deploying at this instant

  // Rebuild [D] and the per-assembly coefficients exactly as the dynamics do:
  const geo = computePanelGeometryAtStage(kinematics, qBody, thetas);
  const D = mat3Clone(computeSystemInertiaAboutB(centre, config, params));
  const omitted = new Vector3();
  let panelTermMag = 0;
  for (let i = 0; i < nPanels; i++) {
    if (hingeOf[i] !== i) continue;
    const members: number[] = [];
    for (let j = 0; j < nPanels; j++) if (hingeOf[j] === i) members.push(j);
    const { tau } = hingeTorqueTotal(thetas[i], thetaDots[i], stopAngles[i], params.hinge);
    const coeffs = computeAssemblyCoefficients(members, kinematics, geo, omega, tau, params.panelMass, i);
    mat3AddOuterInPlace(D, coeffs.K, coeffs.bTheta);
    // Omitted per-panel forcing: −K_i · (a_θ,i · r̈_B/N)
    const scale = coeffs.aTheta.dot(rBddot);
    omitted.addScaledVector(coeffs.K, -scale);
    panelTermMag += coeffs.K.length() * Math.abs(scale);
  }

  // Omitted direct system term: −m_sc·(r_C/B × r̈_B/N), r_C/B at the centre sample.
  const rCB = comBuf[2];
  const direct = new Vector3().crossVectors(rCB, rBddot).multiplyScalar(mSc);
  const directTermMag = direct.length();
  omitted.addScaledVector(direct, -1);

  const deltaOmegaDot = solve3x3(D, omitted);
  const omegaDotActual = coupledDeriv(
    qBody, omega, thetas, thetaDots, hingeOf, stopAngles, kinematics, params,
  ).dOmega;

  return {
    ratio: deltaOmegaDot.length() / Math.max(omegaDotActual.length(), OMEGA_DOT_FLOOR),
    rBddot, omegaDotActual, deltaOmegaDot, directTermMag, panelTermMag,
  };
}
