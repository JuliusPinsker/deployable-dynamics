// ─────────────────────────────────────────────────────────────────────────────
//  Timestep-convergence study for the coupled EOM (Phase B, required).
//
//  Representative asymmetric case — long-edge with panel 0 stuck and a 10 °/s
//  body tumble — run THROUGH the mechanical stop-contact event (the stiffest
//  dynamics in the model) at dt = 1/1200 s, dt/2 and dt/4. Reported metrics
//  (all three resolutions, logged for the implementation report):
//    • max relative momentum error e_H
//    • final attitude difference vs the dt/4 reference (deg)
//    • final panel angles (and mid-contact angle difference, pre-latch)
//    • peak body-rate difference vs dt/4 (relative)
//  The production timestep must be converged on these metrics; the
//  deterministic substep count inside stepSimulation is part of the scheme
//  under test (observable via computeCoupledSubstepCount).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import {
  createInitialState,
  stepSimulation,
  computeTotalAngularMomentum,
  computeCoupledSubstepCount,
  FREE_FLOAT_MOMENTUM_ERROR_MAX,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS, MATERIAL_PRESETS, type SimulationParams } from '../lib/physics/types';

const OMEGA0 = new Vector3(0, 0, (10 * Math.PI) / 180);
const T_MID = 1.4;   // mid stop-approach/contact, pre-latch (continuous state)
const T_END = 3.5;   // post-latch coast (attitude/rate comparison)

interface RunResult {
  maxMomentumErr: number;
  qFinal: Quaternion;
  omegaFinal: Vector3;
  peakOmega: number;
  thetaMid: number;      // free panel angle at T_MID
  thetaFinal: number[];
}

function run(dtDivisor: number): RunResult {
  const params: SimulationParams = { ...DEFAULT_PARAMS, timeStep: DEFAULT_PARAMS.timeStep / dtDivisor };
  let state = createInitialState('long-edge', OMEGA0.clone());
  state.deploying = true;
  state.panels[0].stuck = true;
  state.panels[0].stuckAngle = 0;

  const H0 = computeTotalAngularMomentum(state, 'long-edge', params);
  const H0mag = H0.length();
  const steps = Math.round(T_END / params.timeStep);
  const midStep = Math.round(T_MID / params.timeStep);
  const sampleEvery = Math.max(1, Math.round(0.05 / params.timeStep));

  let maxMomentumErr = 0;
  let peakOmega = 0;
  let thetaMid = NaN;
  for (let i = 0; i < steps; i++) {
    state = stepSimulation(state, 'long-edge', params);
    peakOmega = Math.max(peakOmega, state.angularVelocity.length());
    if (i === midStep - 1) thetaMid = state.panels[1].angle;
    if (i % sampleEvery === 0 || i === steps - 1) {
      const H = computeTotalAngularMomentum(state, 'long-edge', params);
      maxMomentumErr = Math.max(maxMomentumErr, H.sub(H0).length() / H0mag);
    }
  }
  return {
    maxMomentumErr,
    qFinal: state._bodyQ!.clone(),
    omegaFinal: state.angularVelocity.clone(),
    peakOmega,
    thetaMid,
    thetaFinal: state.panels.map(p => p.angle),
  };
}

function quatAngleDeg(a: Quaternion, b: Quaternion): number {
  const rel = a.clone().multiply(b.clone().conjugate());
  return (2 * Math.acos(Math.min(1, Math.abs(rel.w))) * 180) / Math.PI;
}

describe('dt / dt/2 / dt/4 convergence through stop contact (long-edge, one-stuck, 10°/s tumble)', () => {
  it('production timestep is converged on momentum, attitude, panel angle and peak-rate metrics', () => {
    const r1 = run(1);
    const r2 = run(2);
    const r4 = run(4);

    console.info(
      `[convergence] max e_H:  dt=${r1.maxMomentumErr.toExponential(3)}  ` +
      `dt/2=${r2.maxMomentumErr.toExponential(3)}  dt/4=${r4.maxMomentumErr.toExponential(3)}`,
    );
    console.info(
      `[convergence] final attitude diff vs dt/4:  dt=${quatAngleDeg(r1.qFinal, r4.qFinal).toExponential(3)}°  ` +
      `dt/2=${quatAngleDeg(r2.qFinal, r4.qFinal).toExponential(3)}°`,
    );
    console.info(
      `[convergence] θ(T_mid):  dt=${r1.thetaMid.toFixed(9)}  dt/2=${r2.thetaMid.toFixed(9)}  ` +
      `dt/4=${r4.thetaMid.toFixed(9)}  |Δ(dt−dt/4)|=${Math.abs(r1.thetaMid - r4.thetaMid).toExponential(3)} rad`,
    );
    console.info(
      `[convergence] final panel angles:  dt=[${r1.thetaFinal.map(a => a.toFixed(6)).join(', ')}]  ` +
      `dt/4=[${r4.thetaFinal.map(a => a.toFixed(6)).join(', ')}]`,
    );
    console.info(
      `[convergence] peak |ω|:  dt=${r1.peakOmega.toExponential(6)}  dt/2=${r2.peakOmega.toExponential(6)}  ` +
      `dt/4=${r4.peakOmega.toExponential(6)}`,
    );

    // Momentum criterion holds at every resolution:
    expect(r1.maxMomentumErr).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);
    expect(r2.maxMomentumErr).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);
    expect(r4.maxMomentumErr).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);

    // Attitude converged: production dt within 0.1° of the dt/4 reference,
    // and halving dt must not move the answer materially:
    expect(quatAngleDeg(r1.qFinal, r4.qFinal)).toBeLessThan(0.1);
    expect(quatAngleDeg(r2.qFinal, r4.qFinal)).toBeLessThan(0.05);

    // Mid-contact panel angle (continuous, pre-latch) converged:
    expect(Math.abs(r1.thetaMid - r4.thetaMid)).toBeLessThan(1e-4);

    // Final panel angles: identical latched outcome:
    for (let p = 0; p < r1.thetaFinal.length; p++) {
      expect(Math.abs(r1.thetaFinal[p] - r4.thetaFinal[p])).toBeLessThan(1e-6);
    }

    // Peak body rate converged to well under 1%:
    expect(Math.abs(r1.peakOmega - r4.peakOmega) / r4.peakOmega).toBeLessThan(0.01);
    expect(Math.abs(r2.peakOmega - r4.peakOmega) / r4.peakOmega).toBeLessThan(0.005);
  }, 60000); // dt/4 run is 4× the production step count; default 5 s trips under load

  it('substep count is observable, deterministic, and ≥2 for the stiffest material/config (CFRP short-edge)', () => {
    // FR4 long-edge sits well inside RK4's stability region at 1/1200 s:
    expect(computeCoupledSubstepCount('long-edge', DEFAULT_PARAMS)).toBe(1);
    // The lightest panel (CFRP, 20 g) on the small short-edge geometry pushes
    // the stop-contact damping mode past RK4's real-axis limit — substeps
    // must engage (this is the documented stability mitigation, visible here):
    const cfrp = MATERIAL_PRESETS.find(m => m.key === 'cfrp')!;
    const params: SimulationParams = { ...DEFAULT_PARAMS, panelMass: cfrp.panelMass };
    expect(computeCoupledSubstepCount('short-edge', params)).toBeGreaterThanOrEqual(2);
    // Deterministic: same inputs, same answer.
    expect(computeCoupledSubstepCount('short-edge', params)).toBe(
      computeCoupledSubstepCount('short-edge', params),
    );
  });

  it('CFRP short-edge (substepped stop contact) still deploys cleanly and conserves momentum', () => {
    const cfrp = MATERIAL_PRESETS.find(m => m.key === 'cfrp')!;
    const params: SimulationParams = { ...DEFAULT_PARAMS, panelMass: cfrp.panelMass };
    let state = createInitialState('short-edge', OMEGA0.clone());
    state.deploying = true;
    const H0 = computeTotalAngularMomentum(state, 'short-edge', params);
    const steps = Math.round(8 / params.timeStep);
    let maxErr = 0;
    for (let i = 0; i < steps && state.deploying; i++) {
      state = stepSimulation(state, 'short-edge', params);
      if (i % 60 === 0) {
        const H = computeTotalAngularMomentum(state, 'short-edge', params);
        maxErr = Math.max(maxErr, H.sub(H0).length() / H0.length());
      }
    }
    expect(state.panels.every(p => p.deployed)).toBe(true);
    expect(state.panels.every(p => Number.isFinite(p.angle))).toBe(true);
    expect(maxErr).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);
  }, 30000);
});
