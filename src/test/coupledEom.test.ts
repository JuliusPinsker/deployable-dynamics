// ─────────────────────────────────────────────────────────────────────────────
//  Phase-B coupled-EOM invariants and full scenario coverage.
//
//  Conservation criterion: with L_B = 0 exactly (free float, no external
//  torque), |H(t) − H(0)| / max(|H(0)|, H_scale) ≤ FREE_FLOAT_MOMENTUM_ERROR_MAX
//  = 0.001 = 0.1%. For zero-initial-momentum runs H(0) ≈ 0, so the frames'
//  momentumError field is the ABSOLUTE drift |H(t)| (kg·m²/s) and is checked
//  against a scale derived from the scenario's characteristic panel momentum
//  (H_scale = Ieff·θ̇_char, documented per test) rather than divided by zero.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Vector3 } from 'three';
import {
  runFullSimulation,
  createInitialState,
  stepSimulation,
  computeTotalAngularMomentum,
  getPanelKinematics,
  FREE_FLOAT_MOMENTUM_ERROR_MAX,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS, CONFIGURATIONS, type ConfigType, type SimulationParams } from '../lib/physics/types';
import { isFailureModeValid, TWO_PANEL_TOPOLOGY } from '../lib/scenario/scenarioSpec';

const CONFIGS: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];

/** ω₀ = 10 °/s about body Z — a representative tip-off tumble. */
const OMEGA0 = new Vector3(0, 0, (10 * Math.PI) / 180);

/** Simulation horizons long enough for every stage to latch plus coast. */
const MAX_TIME: Record<ConfigType, number> = {
  'long-edge': 12,
  'double-long-edge': 22,
  'short-edge': 14,
  'short-edge-long-edge': 30,
};

/** Stuck-panel index mapping, mirroring reportData/ComparePage conventions. */
function stuckFor(config: ConfigType, mode: 'none' | 'one-stuck' | 'two-adjacent' | 'two-opposite' | 'all-stuck'): number[] {
  const count = CONFIGURATIONS.find(c => c.id === config)!.panelCount;
  switch (mode) {
    case 'none': return [];
    case 'one-stuck': return [0];
    case 'two-adjacent':
      return TWO_PANEL_TOPOLOGY[config]?.adjacent ?? [];
    case 'two-opposite':
      return config === 'long-edge' || config === 'double-long-edge' ? [0, 1] : [0, 2];
    case 'all-stuck': return Array.from({ length: count }, (_, i) => i);
  }
}

describe('physics invariants (free float, L_B = 0 exactly)', () => {
  it('zero-torque principal-axis spin is preserved (all panels stuck, rigid composite)', () => {
    const frames = runFullSimulation(
      'long-edge', DEFAULT_PARAMS, 3, stuckFor('long-edge', 'all-stuck'), OMEGA0.clone(),
    );
    expect(frames.length).toBeGreaterThan(10);
    const last = frames[frames.length - 1];
    // Body Z is a principal axis of the stowed composite (±Y panel mirror
    // symmetry) → ω must stay exactly ω₀ up to integrator truncation.
    expect(last.angularVelocity.z).toBeCloseTo(OMEGA0.z, 9);
    expect(Math.abs(last.angularVelocity.x)).toBeLessThan(1e-10);
    expect(Math.abs(last.angularVelocity.y)).toBeLessThan(1e-10);
    const maxErr = Math.max(...frames.map(f => f.momentumError));
    expect(maxErr).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);
  });

  it('a body at rest with no moving panels stays exactly at rest (no hidden external torque)', () => {
    let state = createInitialState('long-edge');
    state.deploying = true;
    for (const idx of [0, 1]) { state.panels[idx].stuck = true; state.panels[idx].stuckAngle = 0; }
    for (let i = 0; i < 1200; i++) state = stepSimulation(state, 'long-edge', DEFAULT_PARAMS);
    expect(state.angularVelocity.length()).toBe(0);
    expect(state.orientation.length()).toBe(0);
  });

  it('production dynamics source references no gravity-gradient/SRP/thermal/detumbling/motor torque', () => {
    const src = readFileSync(resolve(__dirname, '../lib/physics/engine.ts'), 'utf-8');
    for (const banned of [
      'gravityGradient', 'srpTorque', 'orbitalTorques', 'stepDetumbling',
      'magnetorquer', 'thermal', 'motorTorque',
    ]) {
      expect(src.includes(banned), `engine.ts must not reference ${banned}`).toBe(false);
    }
  });

  it('zero-ω₀ symmetric long-edge deployment: negligible momentum and negligible hub attitude disturbance', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, MAX_TIME['long-edge']);
    const last = frames[frames.length - 1];
    expect(last.panelAngles.every(a => Math.abs(a - Math.PI / 2) < 1e-6)).toBe(true);
    // H₀ = 0 → momentumError is ABSOLUTE |H| (kg·m²/s). Scale it by the
    // characteristic single-panel hinge momentum Ieff·θ̇_char (θ̇_char = 1 rad/s):
    const hScale = getPanelKinematics('long-edge', DEFAULT_PARAMS)[0].Ip.x * 1.0;
    const maxAbs = Math.max(...frames.map(f => f.momentumError));
    expect(maxAbs / hScale).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);
    // Mirror-symmetric pair: hinge reactions cancel — the hub must not rotate.
    const maxAttitude = Math.max(...frames.map(f => f.attitudeCouplingDeg ?? 0));
    expect(maxAttitude).toBeLessThan(1e-3); // degrees
  }, 30000);

  it('asymmetric timing offset (δt = 250 ms) produces a real attitude disturbance AND conserves momentum', () => {
    const params: SimulationParams = {
      ...DEFAULT_PARAMS,
      hinge: { ...DEFAULT_PARAMS.hinge, panelStartDelays: [0, 0.25] },
    };
    const frames = runFullSimulation('long-edge', params, MAX_TIME['long-edge'], [], OMEGA0.clone());
    const last = frames[frames.length - 1];
    expect(last.panelAngles.every(a => Math.abs(a - Math.PI / 2) < 1e-6)).toBe(true);
    const maxErr = Math.max(...frames.map(f => f.momentumError));
    expect(maxErr).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);
    // The staggered release must produce a genuinely different body-rate
    // trajectory than the synchronized release (same ω₀, same frame times):
    const zeroDelay = runFullSimulation('long-edge', DEFAULT_PARAMS, 4, [], OMEGA0.clone());
    let maxOmegaDiff = 0;
    for (let i = 0; i < Math.min(zeroDelay.length, frames.length); i++) {
      maxOmegaDiff = Math.max(
        maxOmegaDiff,
        frames[i].angularVelocity.clone().sub(zeroDelay[i].angularVelocity).length(),
      );
    }
    expect(maxOmegaDiff).toBeGreaterThan(1e-5); // real asymmetric wobble, not roundoff
  }, 30000);
});

describe('scenario coverage: every configuration × failure mode, spinning, 0.1% momentum criterion', () => {
  for (const config of CONFIGS) {
    for (const mode of ['none', 'one-stuck', 'two-adjacent', 'two-opposite', 'all-stuck'] as const) {
      // two-adjacent has no distinct panel pair on long-edge (2 panels only) — skip via the
      // codebase's own validity resolver rather than fabricating stuck indices for it.
      if (mode === 'two-adjacent' && !isFailureModeValid(config, mode)) continue;
      it(`${config} / ${mode}: finite, momentum ≤ ${(FREE_FLOAT_MOMENTUM_ERROR_MAX * 100).toFixed(1)}%, correct deployment outcome`, () => {
        const stuck = stuckFor(config, mode);
        const frames = runFullSimulation(
          config, DEFAULT_PARAMS, MAX_TIME[config], stuck, OMEGA0.clone(),
        );
        expect(frames.length).toBeGreaterThan(10);
        const last = frames[frames.length - 1];

        // Numerical sanity everywhere:
        for (const f of [frames[0], frames[Math.floor(frames.length / 2)], last]) {
          expect(Number.isFinite(f.angularVelocity.length())).toBe(true);
          expect(f.panelAngles.every(Number.isFinite)).toBe(true);
        }

        // Momentum conservation (|H₀| > 0 here, so momentumError is relative):
        const maxErr = Math.max(...frames.map(f => f.momentumError));
        console.info(
          `[momentum] ${config}/${mode}: max e_H = ${maxErr.toExponential(3)} ` +
          `(${(maxErr * 100).toFixed(4)}%)`,
        );
        expect(maxErr).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);

        // Deployment outcome:
        if (mode === 'all-stuck') {
          // No false deployment — everything pinned at stowed:
          expect(last.panelAngles.every(a => a === 0)).toBe(true);
        } else {
          for (let p = 0; p < last.panelAngles.length; p++) {
            if (stuck.includes(p)) {
              expect(last.panelAngles[p]).toBe(0); // stuck panels never move
            } else {
              expect(last.panelAngles[p]).toBeGreaterThan(0.5); // deployed toward stop
            }
          }
        }
      }, 60000); // real multi-stage sims; default 5 s trips under full-suite load
    }
  }

  it('one-stuck long-edge is genuinely asymmetric: body wobble exceeds the symmetric case', () => {
    const nominal = runFullSimulation('long-edge', DEFAULT_PARAMS, 8);
    const oneStuck = runFullSimulation('long-edge', DEFAULT_PARAMS, 8, [0]);
    const peak = (fr: typeof nominal) =>
      Math.max(...fr.map(f => f.angularVelocity.length()));
    expect(peak(oneStuck)).toBeGreaterThan(peak(nominal) * 10);
    expect(peak(oneStuck)).toBeGreaterThan(1e-4);
  }, 30000);
});

describe('momentum diagnostic remains a pure diagnostic', () => {
  it('mutating the H the diagnostic returns cannot influence the trajectory', () => {
    // Run twice; on one run, call the diagnostic mid-flight and mangle its
    // return value. Identical trajectories prove nothing feeds back.
    const run = (mangle: boolean) => {
      let state = createInitialState('long-edge', OMEGA0.clone());
      state.deploying = true;
      for (let i = 0; i < 2400; i++) {
        state = stepSimulation(state, 'long-edge', DEFAULT_PARAMS);
        if (mangle && i % 100 === 0) {
          const H = computeTotalAngularMomentum(state, 'long-edge', DEFAULT_PARAMS);
          H.multiplyScalar(1e6); // vandalise the returned vector
        }
      }
      return state;
    };
    const a = run(false);
    const b = run(true);
    expect(a.angularVelocity.x).toBe(b.angularVelocity.x);
    expect(a.angularVelocity.z).toBe(b.angularVelocity.z);
    expect(a.panels[0].angle).toBe(b.panels[0].angle);
    expect(a._bodyQ!.w).toBe(b._bodyQ!.w);
  }, 30000);
});
