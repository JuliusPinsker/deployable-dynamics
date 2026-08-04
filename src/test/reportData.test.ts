import { describe, it, expect } from 'vitest';
import { MathUtils } from 'three';
import {
  computeSingleRow,
  runScenarioTrajectory,
  resolveReportStuckPanels,
  generateReportRows,
  getFilteredRows,
  CONFIG_FAILURE_MODES,
  type SimulationConfig,
} from '../lib/physics/reportData';
import {
  accumulateOmegaPeak,
  DETUMBLING_TIME_REQUIREMENT_S,
  EMPTY_OMEGA_PEAK,
  runFullSimulation,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS, Vector3 } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Peak-frame reporting (regression protection for thesis-facing numbers)
//
//  The body starts from rest and momentum is conserved, so its angular velocity
//  decays back to ~0 once panels stop moving. `computeSingleRow` must therefore
//  report `w_final` from the PEAK-ω frame, not the settled last frame — and the reported
//  average required detumbling torque from the INDEPENDENT trajectory maximum of the
//  internal angular momentum, divided by the assumed 5400 s allocation.
//
//  The test asserts against the REAL computation path via `runScenarioTrajectory`
//  (same material-sourced params, stuck resolution, and horizon that computeSingleRow
//  uses) — no material masses, hinge params, or stuck indices are reconstructed here.
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSingleRow — peak-frame reporting', () => {
  it('reports the peak-ω frame (not the settled last frame) for an asymmetric scenario', () => {
    const row = computeSingleRow('long-edge', 'one-stuck', 'fr4');

    // Asymmetric deployment (one panel stuck) induces a genuine body-rate transient.
    // Under the OLD last-frame reading these would be ~0 — this is the core regression guard.
    expect(row.finalOmegaDegPerS).toBeGreaterThan(0);
    expect(row.averageRequiredDetumblingTorqueNm).toBeGreaterThan(0);

    // After the fix, w_final is taken from the same peak frame as w_peak.
    expect(row.finalOmegaDegPerS).toBeCloseTo(row.peakOmegaDegPerS, 10);

    // Calculated deployment time t₉₀ is a dynamics outcome (first frame at/after
    // 90% of the final panel angle, 50 ms frame cadence). Under the CALIBRATED
    // default hinge (k = 7.729e-3, c = 4.947e-3, ζ ≈ 0.80 — engineering
    // calibration, see calibration.ts) long-edge measures 1.251 s. Window
    // first (target 1.0–2.0 s), then a narrow regression pin on the selected
    // default; it must NOT jump to the window-end time.
    expect(row.deployTimeS).toBeGreaterThan(1.0);
    expect(row.deployTimeS).toBeLessThan(2.0);
    expect(row.deployTimeS).toBeCloseTo(1.251, 3);

    // Explicitly show the reported value is NOT the last frame: pull the exact trajectory
    // computeSingleRow computed and confirm the last frame's ω has decayed far below the peak.
    const { trajectory } = runScenarioTrajectory('long-edge', 'one-stuck', 'fr4');
    const last = trajectory.at(-1)!;
    const lastOmegaDeg = MathUtils.radToDeg(last.angularVelocity.length());

    expect(lastOmegaDeg).toBeLessThan(row.finalOmegaDegPerS * 0.2);
  });

  it('derives the reported torque from the trajectory MAXIMUM angular momentum', () => {
    const row = computeSingleRow('long-edge', 'one-stuck', 'fr4');
    const { trajectory } = runScenarioTrajectory('long-edge', 'one-stuck', 'fr4');

    // The internal intermediate is still the max over every frame — not a last-frame
    // sample, not the peak-ω sample, and never a difference between adjacent samples.
    const trajectoryMax = Math.max(...trajectory.map(f => f.detumbleAngularMomentum));
    expect(trajectoryMax).toBeGreaterThan(trajectory.at(-1)!.detumbleAngularMomentum);

    expect(row.averageRequiredDetumblingTorqueNm).toBe(
      trajectoryMax / DETUMBLING_TIME_REQUIREMENT_S,
    );
  });

  it('keeps w_final and the required torque at ~0 for all-stuck (physically correct)', () => {
    const row = computeSingleRow('long-edge', 'all-stuck', 'fr4');
    expect(row.finalOmegaDegPerS).toBeCloseTo(0, 6);
    expect(row.averageRequiredDetumblingTorqueNm).toBeCloseTo(0, 9);
    expect(row.peakOmegaDegPerS).toBeCloseTo(0, 6);
  });
});

// Shared peak accumulator — used by both computeSingleRow (trajectory reduce) and the
// live Simulation-page telemetry (per-frame fold). Guards the "hold the peak, ignore the decay"
// behaviour that fixes the metric-resets-to-0 telemetry issue.
// A nonzero initial tumble ω₀ must flow through to the peak-ω reporting. We isolate it from
// deployment torque with the all-stuck scenario (both panels stuck → the body just coasts).
// ω₀ is about the long-edge's principal Z axis, so ω × Iω = 0 and the body is torque-free:
// ω_z is preserved to machine precision, and the peak |ω| equals |ω₀| exactly. This validates
// the ω₀ → report path via the same shared `accumulateOmegaPeak` fold that `computeSingleRow`
// uses, without touching reportData's public API. (During an actual tumbling deployment the peak
// is ≥ |ω₀| plus a deployment-induced transient; the coast case pins the lower bound cleanly —
// note runFullSimulation records its first frame after one step, so t=0 itself is never sampled.)
describe('peak-ω reporting with initial tumble (ω₀)', () => {
  it('reports peakOmegaDegPerS >= |ω₀| when the body starts tumbling', () => {
    const omega0 = new Vector3(0, 0, 0.5); // rad/s about principal Z
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 2, [0, 1], omega0);

    let peak = EMPTY_OMEGA_PEAK;
    for (const f of frames) {
      peak = accumulateOmegaPeak(peak, f.angularVelocity.length(), f.detumbleAngularMomentum);
    }

    const peakDeg = MathUtils.radToDeg(peak.peakOmegaRad);
    const omega0Deg = MathUtils.radToDeg(omega0.length());

    // FP-robust `>=` (peak equals |ω₀| for a coasting principal-axis spin).
    expect(peakDeg).toBeGreaterThanOrEqual(omega0Deg - 1e-6);
  });
});

describe('accumulateOmegaPeak', () => {
  it('maximises |ω| and the detumbling requirement INDEPENDENTLY, ignoring the later decay', () => {
    // The body inertia is anisotropic and the mass distribution changes as the panels
    // swing, so the peak-rate frame need not be the peak-momentum frame: here |ω| peaks
    // at sample 2 while |Iω| peaks at sample 3.
    let p = EMPTY_OMEGA_PEAK;
    p = accumulateOmegaPeak(p, 0.1, 0.5);  // ramp up
    p = accumulateOmegaPeak(p, 0.3, 2.0);  // peak |ω|
    p = accumulateOmegaPeak(p, 0.05, 3.0); // peak |Iω| at a LOWER |ω|
    p = accumulateOmegaPeak(p, 0.0, 0.0);  // settled
    expect(p.peakOmegaRad).toBeCloseTo(0.3, 10);
    expect(p.peakDetumbleAngularMomentum).toBeCloseTo(3.0, 10);
  });

  it('stays zero from EMPTY when nothing ever spins (all-stuck / at rest)', () => {
    const p = accumulateOmegaPeak(EMPTY_OMEGA_PEAK, 0, 0);
    expect(p.peakOmegaRad).toBe(0);
    expect(p.peakDetumbleAngularMomentum).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  42-scenario failure-mode sweep: per-config topology and row-count coverage.
//
//  `long-edge` has only 2 panels, so the only panel pair that exists ([0,1]) is
//  inherently the opposite pair — there is no distinct adjacent pair. two-adjacent
//  and two-opposite are therefore never generated for it (CONFIG_FAILURE_MODES),
//  and resolveReportStuckPanels throws rather than inventing a fallback pair.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveReportStuckPanels — canonical topology mappings', () => {
  it('long-edge: one-stuck -> [0], all-stuck -> [0,1]', () => {
    expect(resolveReportStuckPanels('long-edge', 'one-stuck')).toEqual([0]);
    expect(resolveReportStuckPanels('long-edge', 'all-stuck')).toEqual([0, 1]);
  });

  it('double-long-edge: two-adjacent -> [0,2], two-opposite -> [0,1]', () => {
    expect(resolveReportStuckPanels('double-long-edge', 'two-adjacent')).toEqual([0, 2]);
    expect(resolveReportStuckPanels('double-long-edge', 'two-opposite')).toEqual([0, 1]);
  });

  it('short-edge: two-adjacent -> [0,1], two-opposite -> [0,2]', () => {
    expect(resolveReportStuckPanels('short-edge', 'two-adjacent')).toEqual([0, 1]);
    expect(resolveReportStuckPanels('short-edge', 'two-opposite')).toEqual([0, 2]);
  });

  it('short-edge-long-edge (coupled): two-adjacent -> [0,2], two-opposite -> [0,1]', () => {
    expect(resolveReportStuckPanels('short-edge-long-edge', 'two-adjacent')).toEqual([0, 2]);
    expect(resolveReportStuckPanels('short-edge-long-edge', 'two-opposite')).toEqual([0, 1]);
  });

  it('every applicable adjacent/opposite pair has exactly 2 unique indices', () => {
    for (const config of ['double-long-edge', 'short-edge', 'short-edge-long-edge'] as SimulationConfig[]) {
      const adjacent = resolveReportStuckPanels(config, 'two-adjacent');
      const opposite = resolveReportStuckPanels(config, 'two-opposite');
      expect(adjacent).toHaveLength(2);
      expect(opposite).toHaveLength(2);
      expect(new Set(adjacent).size).toBe(2);
      expect(new Set(opposite).size).toBe(2);
    }
  });

  it('adjacent and opposite pairs differ for double-long-edge, short-edge, and short-edge-long-edge', () => {
    for (const config of ['double-long-edge', 'short-edge', 'short-edge-long-edge'] as SimulationConfig[]) {
      const adjacent = resolveReportStuckPanels(config, 'two-adjacent');
      const opposite = resolveReportStuckPanels(config, 'two-opposite');
      expect(adjacent).not.toEqual(opposite);
    }
  });

  it('throws for long-edge (2 panels: no distinct adjacent/opposite pair exists) instead of returning a fallback', () => {
    expect(() => resolveReportStuckPanels('long-edge', 'two-adjacent')).toThrow(
      /not applicable to configuration long-edge/,
    );
    expect(() => resolveReportStuckPanels('long-edge', 'two-opposite')).toThrow(
      /not applicable to configuration long-edge/,
    );
  });
});

describe('42-scenario report sweep — row count and per-config mode coverage', () => {
  it('generates exactly 42 rows', () => {
    expect(generateReportRows()).toHaveLength(42);
  }, 90000); // first call in this file runs the full physics-driven sweep (~24 s)

  it('long-edge rows use exactly {one-stuck, all-stuck} — never two-adjacent/two-opposite', () => {
    const longEdgeModes = new Set(
      generateReportRows()
        .filter(row => row.config === 'long-edge')
        .map(row => row.failureMode),
    );
    expect(longEdgeModes).toEqual(new Set(['one-stuck', 'all-stuck']));
    expect(CONFIG_FAILURE_MODES['long-edge']).toEqual(['one-stuck', 'all-stuck']);
  });

  it('double-long-edge, short-edge, and short-edge-long-edge each use exactly 4 distinct failure modes', () => {
    for (const config of ['double-long-edge', 'short-edge', 'short-edge-long-edge'] as SimulationConfig[]) {
      const modes = new Set(
        generateReportRows()
          .filter(row => row.config === config)
          .map(row => row.failureMode),
      );
      expect(modes).toEqual(new Set(['one-stuck', 'two-adjacent', 'two-opposite', 'all-stuck']));
    }
  });

  it('never represents an unavailable combination with a zero-valued placeholder row — it is omitted entirely', () => {
    expect(getFilteredRows(['long-edge'], ['two-adjacent'], null)).toEqual([]);
    expect(getFilteredRows(['long-edge'], ['two-opposite'], null)).toEqual([]);
  });
});
