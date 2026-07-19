import { describe, it, expect } from 'vitest';
import {
  evaluateHingeCandidate,
  hingeFreeTravelInertia,
  hingeNaturalFrequency,
  hingeDampingRatio,
  CALIBRATION_OMEGA_N,
  CALIBRATION_ZETA,
} from '../lib/physics/calibration';
import { DEFAULT_PARAMS, type ConfigType } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Torsional-hinge calibration — selection properties and guard rails.
//
//  The default k/c pair is an ENGINEERING CALIBRATION (see calibration.ts and
//  the DEFAULT_PARAMS block comment), selected from a documented ωₙ × ζ grid
//  run through the production engine. These tests pin the selection by its
//  PROPERTIES (target window, damping regime, completion, convergence), with a
//  narrow numerical regression pin only at the end.
//
//  Selected candidate (FR4 nominal long-edge; Phase-B corrected hinge-EDGE
//  inertia I_eff = (1/3)mR² + (1/12)mt² ≈ 1.2367e-3 kg·m²):
//    k = 7.729454e-3 N·m/rad, c = 4.946851e-3 N·m·s/rad
//    → ωₙ = 2.50 rad/s, ζ = 0.80 (underdamped, ζ < 1)
//    friction scaled with k: 1.932364e-4 N·m (dead-band τ_f/k = 0.025 rad
//    kept identical to the pre-calibration design).
//  SELECTION RATIONALE (Phase-B audit): the 1.0–2.0 s t₉₀ window is required
//  for EVERY nominal configuration/stage row and EVERY supported material
//  (release-relative). ζ = 0.80 compresses the row spread (measured span
//  1.21–1.56 s, all in-window); lighter-damping grid points keep the FR4
//  long-edge row in-window but push double-long-edge stage 1 and/or the
//  material extremes outside it. Two properties of the previous ζ = 0.30
//  selection changed and are re-pinned below with comments: the reference
//  panel now stalls in the friction dead-band ≈0.92° short of the stop and
//  is captured by the latch (no ballistic stop impact), and the material
//  timing ordering is no longer monotonic in mass (damping-regime
//  crossover: ζ_eff ∝ 1/√m crosses critical for the lightest panel).
// ─────────────────────────────────────────────────────────────────────────────

const K = DEFAULT_PARAMS.hinge.springConstant;
const C = DEFAULT_PARAMS.hinge.dampingCoeff;

describe('calibration diagnostic — determinism and documentation', () => {
  it('the sweep grid is documented and brackets the target window', () => {
    // Grid definition is part of the documented method (calibration.ts).
    expect([...CALIBRATION_OMEGA_N]).toEqual([1.2, 1.5, 2.0, 2.5, 3.0]);
    expect([...CALIBRATION_ZETA]).toEqual([0.15, 0.3, 0.5, 0.8]);
    // Every ζ in the grid is strictly underdamped.
    for (const z of CALIBRATION_ZETA) expect(z).toBeLessThan(1);
  });

  it('candidate evaluation is deterministic (identical inputs → identical metrics)', () => {
    const a = evaluateHingeCandidate(K, C);
    const b = evaluateHingeCandidate(K, C);
    expect(b).toEqual(a);
  });
});

describe('selected default hinge calibration (k = 7.729e-3, c = 4.947e-3)', () => {
  it('free-travel response is underdamped: ζ ≈ 0.80 < 1 (documented formula)', () => {
    // ζ = c / (2·√(k·I_eff)) with I_eff the panel inertia about the hinge EDGE
    // exactly as the corrected engine maps it (long-edge FR4 ≈ 1.2367e-3 kg·m²).
    const inertia = hingeFreeTravelInertia();
    expect(inertia).toBeCloseTo(1.2367e-3, 7);
    const zeta = hingeDampingRatio(K, C, inertia);
    expect(zeta).toBeLessThan(1);
    expect(zeta).toBeGreaterThan(0.75);
    expect(zeta).toBeLessThan(0.85);
    // ωₙ ≈ 2.50 rad/s
    expect(hingeNaturalFrequency(K, inertia)).toBeGreaterThan(2.4);
    expect(hingeNaturalFrequency(K, inertia)).toBeLessThan(2.6);
  });

  it('nominal FR4 long-edge t₉₀ is inside the 1.0–2.0 s target window with an honest dead-band latch capture', () => {
    const m = evaluateHingeCandidate(K, C);

    // Target window (90%-angle metric) — deployment time is emergent, so this
    // is a WINDOW, not an exact prescription.
    expect(m.t90).toBeGreaterThan(1.0);
    expect(m.t90).toBeLessThan(2.0);

    // Physical properties of the selected response. NOTE (re-pinned for the
    // ζ = 0.80 selection): the panel decelerates into the Coulomb dead-band
    // just short of the stop instead of striking it ballistically — no stop
    // contact, no overshoot, and the end-of-travel latch captures the final
    // ≈0.92° (measured snap 0.0161 rad, comfortably inside the 2° + margin
    // honest-capture window; angular momentum is carried through the latch
    // event exactly by the constraint-event solve in engine.ts).
    expect(m.numericalFailure).toBe(false);
    expect(m.stopContact).toBe(false);                      // dead-band stall arrival
    expect(m.maxLatchSnapRad).toBeCloseTo(0.0161, 3);       // latch capture distance (rad)
    expect(m.maxLatchSnapRad).toBeLessThan(0.035 + 0.01);   // inside cap + margin
    expect(m.maxOvershootRad).toBe(0);                      // never penetrates the stop
    expect(Number.isNaN(m.contactToLatchS)).toBe(true);     // no contact event exists
    expect(Number.isFinite(m.latchTime)).toBe(true);

    // Momentum diagnostic for a rest start (absolute, |H₀| ≈ 0): the coupled
    // EOM conserves H structurally — drift is at machine precision (~1e-18),
    // orders of magnitude inside this bound.
    expect(m.maxMomentumDriftAbs).toBeLessThan(1e-10);

    // Narrow regression pin for the final selected default only (window and
    // property assertions above are the primary guards). Measured with the
    // Phase-B coupled EOM and recalibrated defaults.
    expect(m.t90).toBeCloseTo(1.2333, 3);
    expect(m.latchTime).toBeCloseTo(1.7417, 3);
  });

  it('dt vs dt/2 convergence: headline scalars agree (t₉₀ ≤ 1%, one-stuck peak body rate ≤ 5%)', () => {
    // Headline-scalar agreement across a timestep halving. Full
    // trajectory-level convergence for the coupled EOM (momentum, attitude,
    // panel angle, peak rate at dt / dt/2 / dt/4, through stop contact) is
    // asserted separately in coupledConvergence.test.ts.
    const nomDt = evaluateHingeCandidate(K, C);
    const nomHalf = evaluateHingeCandidate(K, C, { timeStep: DEFAULT_PARAMS.timeStep / 2 });
    const t90Rel = Math.abs(nomDt.t90 - nomHalf.t90) / nomHalf.t90;
    expect(t90Rel).toBeLessThan(0.01);

    const stuckDt = evaluateHingeCandidate(K, C, { stuckPanels: [0] });
    const stuckHalf = evaluateHingeCandidate(K, C, {
      stuckPanels: [0],
      timeStep: DEFAULT_PARAMS.timeStep / 2,
    });
    expect(stuckDt.peakBodyRate).toBeGreaterThan(0);
    const peakRel =
      Math.abs(stuckDt.peakBodyRate - stuckHalf.peakBodyRate) / stuckHalf.peakBodyRate;
    expect(peakRel).toBeLessThan(0.05);
  }, 30000);

  it('all four configurations complete (latch) under the calibrated defaults', () => {
    const configs: ConfigType[] = [
      'long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge',
    ];
    for (const config of configs) {
      const m = evaluateHingeCandidate(K, C, { config, maxTime: 30 });
      expect(m.numericalFailure).toBe(false);
      expect(Number.isFinite(m.latchTime)).toBe(true);
    }
  }, 60000); // real multi-stage sims; default 5 s trips under full-suite load

  it('legacy friction (5e-4 N·m) violates the documented dead-band design; the scaled default preserves it', () => {
    // HISTORY: against the pre-Phase-B spring (k = 4.45e-4) the legacy 5e-4
    // friction dead-band exceeded the whole travel and deployment failed
    // outright — the measured basis for scaling frictionCoeff with k.
    // Under the ωₙ = 2.5 recalibration (k ≈ 7.73e-3) the legacy value is no
    // longer catastrophic, but it still breaks the documented design: its
    // dead-band τ_f/k = 0.065 rad (≈3.7°) is ≈2.6× the intended 0.025 rad,
    // measurably slows deployment (measured 1.312 s vs 1.233 s) and widens
    // the latch-capture stall. The scaled default keeps the dead-band at the
    // design value exactly.
    const legacyDeadband = 0.0005 / K;
    expect(legacyDeadband / 0.025).toBeGreaterThan(2.5);
    expect(legacyDeadband / 0.025).toBeLessThan(2.7);
    const defaultDeadband = DEFAULT_PARAMS.hinge.frictionCoeff / K;
    expect(defaultDeadband).toBeCloseTo(0.025, 3);

    const legacy = evaluateHingeCandidate(K, C, { friction: 0.0005, maxTime: 30 });
    const nominal = evaluateHingeCandidate(K, C);
    expect(legacy.numericalFailure).toBe(false);
    // Strictly slower than the calibrated design response, with a wider
    // latch-capture stall:
    expect(legacy.t90).toBeGreaterThan(nominal.t90 + 0.05);
    expect(legacy.maxLatchSnapRad).toBeGreaterThan(nominal.maxLatchSnapRad);

    // The scaled default keeps the short-edge config completing (its panels
    // stall inside the small design dead-band and creep-latch cleanly):
    const shortEdge = evaluateHingeCandidate(K, C, { config: 'short-edge', maxTime: 30 });
    expect(Number.isFinite(shortEdge.latchTime)).toBe(true);
  }, 30000);

  it('one-stuck / two-opposite / all-stuck run to completion and report calculated peaks', () => {
    // long-edge is a 2-panel config: two-opposite ≡ all-stuck ≡ both panels.
    const oneStuck = evaluateHingeCandidate(K, C, { stuckPanels: [0], maxTime: 30 });
    expect(oneStuck.numericalFailure).toBe(false);
    expect(oneStuck.peakBodyRate).toBeGreaterThan(0);       // asymmetric → real body rate
    expect(Number.isFinite(oneStuck.latchTime)).toBe(true);

    const allStuck = evaluateHingeCandidate(K, C, { stuckPanels: [0, 1], maxTime: 30 });
    expect(allStuck.peakBodyRate).toBe(0);                  // nothing moves
    expect(allStuck.peakHingeTorque).toBe(0);

    // Four-panel two-opposite (short-edge [0, 2]): the free pair deploys as a
    // symmetric pair, so the calculated body rate stays ≈ 0 — reported as
    // computed; no cross-configuration ordering claim is made here.
    const twoOpp = evaluateHingeCandidate(K, C, {
      config: 'short-edge', stuckPanels: [0, 2], maxTime: 30,
    });
    expect(twoOpp.numericalFailure).toBe(false);
    expect(Number.isFinite(twoOpp.latchTime)).toBe(true);
  }, 30000);

  it('material mass still drives the emergent deployment time (no fixed duration)', () => {
    // Times are emergent — every material produces a measurably DIFFERENT
    // t₉₀ and each stays inside the 1.0–2.0 s window (the Gate-A all-rows
    // requirement). NOTE (ζ = 0.80 selection): the ordering is no longer
    // monotonic in mass — the effective damping ratio ζ_eff ∝ 1/√m crosses
    // critical for the lightest panel (CFRP ζ_eff ≈ 1.01), so its dead-band
    // creep makes it the SLOWEST despite the lowest inertia (measured
    // fr4 1.233 < al-kapton 1.257 < cfrp 1.313). The factual order is pinned
    // so any silent regression of this documented crossover is caught.
    const t90For = (panelMass: number) =>
      evaluateHingeCandidate(K, C, {
        params: { ...DEFAULT_PARAMS, panelMass, hinge: { ...DEFAULT_PARAMS.hinge } },
      }).t90;

    const cfrp = t90For(0.020);
    const fr4 = t90For(0.032);
    const alKapton = t90For(0.050);
    // All distinct (mass genuinely changes the dynamics):
    expect(Math.abs(cfrp - fr4)).toBeGreaterThan(0.02);
    expect(Math.abs(alKapton - fr4)).toBeGreaterThan(0.01);
    // Factual (damping-crossover) ordering at this calibration:
    expect(fr4).toBeLessThan(alKapton);
    expect(alKapton).toBeLessThan(cfrp);
    // Every material stays inside the target window:
    for (const t of [cfrp, fr4, alKapton]) {
      expect(t).toBeGreaterThan(1.0);
      expect(t).toBeLessThan(2.0);
    }
  }, 30000);
});
