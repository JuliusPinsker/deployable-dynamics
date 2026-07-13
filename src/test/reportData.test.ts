import { describe, it, expect } from 'vitest';
import { MathUtils } from 'three';
import { computeSingleRow, runScenarioTrajectory } from '../lib/physics/reportData';
import { accumulateOmegaPeak, EMPTY_OMEGA_PEAK, runFullSimulation } from '../lib/physics/engine';
import { DEFAULT_PARAMS, Vector3 } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Peak-frame reporting (regression protection for thesis-facing numbers)
//
//  The body starts from rest and momentum is conserved, so its angular velocity
//  decays back to ~0 once panels stop moving. `computeSingleRow` must therefore
//  report `w_final` / `E_det` from the PEAK-ω frame, not the settled last frame.
//
//  The test asserts against the REAL computation path via `runScenarioTrajectory`
//  (same material-sourced params, stuck resolution, and horizon that computeSingleRow
//  uses) — no material masses, deployDuration, or stuck indices are reconstructed here.
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSingleRow — peak-frame reporting', () => {
  it('reports the peak-ω frame (not the settled last frame) for an asymmetric scenario', () => {
    const row = computeSingleRow('long-edge', 'one-stuck', 'fr4');

    // Asymmetric deployment (one panel stuck) induces a genuine body-rate transient.
    // Under the OLD last-frame reading these would be ~0 — this is the core regression guard.
    expect(row.finalOmegaDegPerS).toBeGreaterThan(0);
    expect(row.eDetumbleMJ).toBeGreaterThan(0);

    // After the fix, w_final is taken from the same peak frame as w_peak.
    expect(row.finalOmegaDegPerS).toBeCloseTo(row.peakOmegaDegPerS, 10);

    // Deploy time is config-dependent (long-edge = 1.117 s in the report; set by the kinematic
    // ease-out timing, independent of panel mass) and must NOT jump to the window-end time.
    expect(row.deployTimeS).toBeCloseTo(1.117, 3);

    // Explicitly show the reported value is NOT the last frame: pull the exact trajectory
    // computeSingleRow computed and confirm the last frame's ω has decayed far below the peak.
    const { trajectory } = runScenarioTrajectory('long-edge', 'one-stuck', 'fr4');
    const last = trajectory.at(-1)!;
    const lastOmegaDeg = MathUtils.radToDeg(last.angularVelocity.length());

    expect(lastOmegaDeg).toBeLessThan(row.finalOmegaDegPerS * 0.2);
  });

  it('keeps w_final and E_det at ~0 for all-stuck (physically correct, not a bug)', () => {
    const row = computeSingleRow('long-edge', 'all-stuck', 'fr4');
    expect(row.finalOmegaDegPerS).toBeCloseTo(0, 6);
    expect(row.eDetumbleMJ).toBeCloseTo(0, 6);
    expect(row.peakOmegaDegPerS).toBeCloseTo(0, 6);
  });
});

// Shared peak-by-|ω| accumulator — used by both computeSingleRow (trajectory reduce) and the
// live Simulation-page telemetry (per-frame fold). Guards the "hold the peak, ignore the decay"
// behaviour that fixes the E_detumble-resets-to-0 telemetry issue.
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
      peak = accumulateOmegaPeak(peak, f.angularVelocity.length(), f.eDetumble);
    }

    const peakDeg = MathUtils.radToDeg(peak.peakOmegaRad);
    const omega0Deg = MathUtils.radToDeg(omega0.length());

    // FP-robust `>=` (peak equals |ω₀| for a coasting principal-axis spin).
    expect(peakDeg).toBeGreaterThanOrEqual(omega0Deg - 1e-6);
  });
});

describe('accumulateOmegaPeak', () => {
  it('holds the eDetumble at the max-|ω| sample and ignores the later decay to ~0', () => {
    let p = EMPTY_OMEGA_PEAK;
    p = accumulateOmegaPeak(p, 0.1, 0.5);  // ramp up
    p = accumulateOmegaPeak(p, 0.3, 2.0);  // transient peak
    p = accumulateOmegaPeak(p, 0.05, 0.1); // decaying during coast
    p = accumulateOmegaPeak(p, 0.0, 0.0);  // settled
    expect(p.peakOmegaRad).toBeCloseTo(0.3, 10);
    expect(p.eDetumbleMJ).toBeCloseTo(2.0, 10);
  });

  it('stays zero from EMPTY when nothing ever spins (all-stuck / at rest)', () => {
    const p = accumulateOmegaPeak(EMPTY_OMEGA_PEAK, 0, 0);
    expect(p.peakOmegaRad).toBe(0);
    expect(p.eDetumbleMJ).toBe(0);
  });
});
