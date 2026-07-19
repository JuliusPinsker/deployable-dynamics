// ─────────────────────────────────────────────────────────────────────────────
//  Deterministic deployment-timing matrix (Phase-B audit, Gate A).
//
//  Requirement: 1.0 s ≤ t₉₀ ≤ 2.0 s for EVERY nominal configuration/stage row
//  and EVERY supported material, under the explicitly documented metric:
//
//    release_p = stage-open instant + panel start delay (engine's own rules)
//    t₉₀(row)  = max over the stage's panels of
//                (first reach of 90% of the panel's travel − release_p)
//
//  Nominal physics-driven deployment only, production timestep 1/1200 s,
//  production substepping. Every row is printed (metric, parameters, timestep,
//  substeps, measured value) and asserted inside the window; representative
//  rows carry exact regression pins so silent drift is caught.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  stepSimulation,
  computeCoupledSubstepCount,
  getPanelKinematics,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS, MATERIAL_PRESETS, type ConfigType, type SimulationParams } from '../lib/physics/types';

const CONFIGS: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
const MAX_TIME: Record<ConfigType, number> = {
  'long-edge': 15, 'double-long-edge': 25, 'short-edge': 20, 'short-edge-long-edge': 45,
};

/** Engine's own per-panel start-delay resolution (mirrored for the metric). */
function panelDelay(config: ConfigType, i: number, stage: number, params: SimulationParams): number {
  const general = params.hinge.panelStartDelays?.[i];
  if (general !== undefined) return general;
  if (config === 'short-edge') return params.hinge.shortEdgeStartDelays?.[i] ?? 0;
  if (config === 'short-edge-long-edge' && stage === 3) {
    const se = i - 4;
    if (se >= 0 && se < 4) return params.hinge.shortEdgeStartDelays?.[se] ?? 0;
  }
  return 0;
}

interface MatrixRow { label: string; t90: number; latch: number; substeps: number }

function measureConfig(config: ConfigType, params: SimulationParams): MatrixRow[] {
  const kin = getPanelKinematics(config, params);
  const stages = [...new Set(kin.map(k => k.spec.stage ?? 1))].sort();
  const stops = kin.map(k => k.spec.maxAngle ?? params.hinge.stopAngle);
  const nSub = computeCoupledSubstepCount(config, params);

  let state = createInitialState(config);
  state.deploying = true;
  const steps = Math.ceil(MAX_TIME[config] / params.timeStep);
  const t90: number[] = kin.map(() => NaN);
  const latch: number[] = kin.map(() => NaN);
  const stageOpen: Record<number, number> = { 1: 0 };
  let prevDeployed = state.panels.map(p => p.deployed);

  for (let i = 0; i < steps && state.deploying; i++) {
    state = stepSimulation(state, config, params);
    for (const [s, t] of Object.entries(state._stageOpenTimes ?? {})) {
      if (stageOpen[Number(s)] === undefined) stageOpen[Number(s)] = t as number;
    }
    for (let p = 0; p < kin.length; p++) {
      if (Number.isNaN(t90[p]) && state.panels[p].angle >= 0.9 * stops[p]) t90[p] = state.time;
      if (Number.isNaN(latch[p]) && state.panels[p].deployed && !prevDeployed[p]) latch[p] = state.time;
    }
    prevDeployed = state.panels.map(p => p.deployed);
  }

  return stages.map(s => {
    const idx = kin.map((k, p) => ((k.spec.stage ?? 1) === s ? p : -1)).filter(p => p >= 0);
    const rel = idx.map(p => (stageOpen[s] ?? NaN) + panelDelay(config, p, s, params));
    return {
      label: `${config}${stages.length > 1 ? `-s${s}` : ''}`,
      t90: Math.max(...idx.map((p, j) => t90[p] - rel[j])),
      latch: Math.max(...idx.map((p, j) => latch[p] - rel[j])),
      substeps: nSub,
    };
  });
}

describe('deployment timing matrix: every configuration/stage × every material inside 1.0–2.0 s (t₉₀)', () => {
  for (const mat of MATERIAL_PRESETS) {
    it(`${mat.key} (panelMass ${mat.panelMass} kg): all config/stage rows in window`, () => {
      const params: SimulationParams = { ...DEFAULT_PARAMS, panelMass: mat.panelMass };
      const rows: MatrixRow[] = [];
      for (const config of CONFIGS) rows.push(...measureConfig(config, params));

      for (const row of rows) {
        console.info(
          `[timing-matrix] ${mat.key.padEnd(9)} ${row.label.padEnd(24)} ` +
          `t90=${row.t90.toFixed(4)}s latch=${row.latch.toFixed(4)}s ` +
          `k=${params.hinge.springConstant} c=${params.hinge.dampingCoeff} ` +
          `dt=${params.timeStep.toExponential(3)} substeps=${row.substeps}`,
        );
        expect(Number.isFinite(row.t90), `${mat.key}/${row.label} must reach 90%`).toBe(true);
        expect(row.t90, `${mat.key}/${row.label} t90 ≥ 1.0 s`).toBeGreaterThanOrEqual(1.0);
        expect(row.t90, `${mat.key}/${row.label} t90 ≤ 2.0 s`).toBeLessThanOrEqual(2.0);
        expect(Number.isFinite(row.latch), `${mat.key}/${row.label} must latch`).toBe(true);
      }
    }, 120000);
  }

  it('is deterministic and pins the FR4 reference rows exactly', () => {
    const a = measureConfig('long-edge', DEFAULT_PARAMS);
    const b = measureConfig('long-edge', DEFAULT_PARAMS);
    expect(a[0].t90).toBe(b[0].t90);
    // Exact regression pins (measured, 1/1200 s):
    expect(a[0].t90).toBeCloseTo(1.2333, 3);
    const dle = measureConfig('double-long-edge', DEFAULT_PARAMS);
    expect(dle[0].t90).toBeCloseTo(1.3092, 3);
    expect(dle[1].t90).toBeCloseTo(1.2125, 3);
  }, 120000);
});
