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
//  Selected candidate (FR4 nominal long-edge, I_eff ≈ 3.0919e-4 kg·m²):
//    k = 4.45e-4 N·m/rad, c = 2.23e-4 N·m·s/rad → ωₙ ≈ 1.20 rad/s, ζ ≈ 0.30
//    friction scaled with k: 1.11e-5 N·m (dead-band τ_f/k = 0.025 rad kept
//    identical to the pre-calibration design).
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

describe('selected default hinge calibration (k = 4.45e-4, c = 2.23e-4)', () => {
  it('free-travel response is lightly damped: ζ ≈ 0.30 < 1 (documented formula)', () => {
    // ζ = c / (2·√(k·I_eff)) with I_eff the panel inertia about the hinge axis
    // exactly as the engine maps it (long-edge FR4 ≈ 3.0919e-4 kg·m²).
    const inertia = hingeFreeTravelInertia();
    expect(inertia).toBeCloseTo(3.0919e-4, 7);
    const zeta = hingeDampingRatio(K, C, inertia);
    expect(zeta).toBeLessThan(1);
    expect(zeta).toBeGreaterThan(0.25);
    expect(zeta).toBeLessThan(0.35);
    // ωₙ ≈ 1.20 rad/s
    expect(hingeNaturalFrequency(K, inertia)).toBeGreaterThan(1.1);
    expect(hingeNaturalFrequency(K, inertia)).toBeLessThan(1.3);
  });

  it('nominal FR4 long-edge t₉₀ is inside the 1.0–2.0 s target window with clean stop capture', () => {
    const m = evaluateHingeCandidate(K, C);

    // Target window (90%-angle metric) — deployment time is emergent, so this
    // is a WINDOW, not an exact prescription.
    expect(m.t90).toBeGreaterThan(1.0);
    expect(m.t90).toBeLessThan(2.0);

    // Physical properties of the selected response:
    expect(m.numericalFailure).toBe(false);
    expect(m.stopContact).toBe(true);                       // reaches the stop with momentum
    expect(m.maxLatchSnapRad).toBeLessThan(1e-9);           // latch engages AT the stop (no snap)
    expect(m.maxOvershootRad).toBeLessThan(0.005);          // ≤ ~0.29° stop penetration
    expect(m.contactToLatchS).toBeLessThan(0.2);            // no persistent post-stop oscillation
    expect(Number.isFinite(m.latchTime)).toBe(true);

    // Momentum diagnostic stays reported and small for a rest start (absolute,
    // |H₀| ≈ 0). This is the iterative-correction model — NOT a Phase-B-grade
    // conservation claim.
    expect(m.maxMomentumDriftAbs).toBeLessThan(1e-10);

    // Narrow regression pin for the final selected default only (window and
    // property assertions above are the primary guards).
    expect(m.t90).toBeCloseTo(1.5167, 3);
    expect(m.latchTime).toBeCloseTo(1.6683, 3);
  });

  it('dt vs dt/2 convergence meets the pre-Phase-B criteria (t₉₀ ≤ 1%, one-stuck peak body rate ≤ 5%)', () => {
    // Criteria rationale: pre-Phase-B the body/panel coupling runs through the
    // iterative momentum correction, and stop contact is a stiff transient, so
    // we require agreement of the headline scalar outputs — deployment time to
    // 1% and the (small) asymmetric peak body rate to 5% — rather than
    // trajectory-level convergence, which is deferred to the coupled EOM work.
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
  });

  it('all four configurations complete (latch) under the calibrated defaults', () => {
    const configs: ConfigType[] = [
      'long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge',
    ];
    for (const config of configs) {
      const m = evaluateHingeCandidate(K, C, { config, maxTime: 30 });
      expect(m.numericalFailure).toBe(false);
      expect(Number.isFinite(m.latchTime)).toBe(true);
    }
  });

  it('legacy friction (5e-4 N·m) is demonstrably inconsistent with the calibrated spring', () => {
    // With the soft calibrated spring, the legacy Coulomb friction exceeds the
    // spring-torque margin: the friction dead-band spans over a radian and the
    // nominal long-edge panel never reaches 90% of the deployed angle. This is
    // the measured basis for scaling frictionCoeff with k (dead-band 0.025 rad
    // preserved) instead of keeping the legacy value.
    const legacy = evaluateHingeCandidate(K, C, { friction: 0.0005, maxTime: 30 });
    expect(Number.isNaN(legacy.t90)).toBe(true);
    expect(Number.isNaN(legacy.latchTime)).toBe(true);

    // And the scaled default restores completion for the short-edge config,
    // whose critically-damped panels have no overshoot and stall inside the
    // friction dead-band (creep-latch within the capped latch window).
    const shortEdge = evaluateHingeCandidate(K, C, { config: 'short-edge', maxTime: 30 });
    expect(Number.isFinite(shortEdge.latchTime)).toBe(true);
  });

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
  });

  it('material mass still drives the emergent deployment time (no fixed duration)', () => {
    // ωₙ = √(k/I_eff) with I_eff ∝ panel mass: heavier panels deploy slower.
    // Times are emergent — assert ordering and the FR4 window, not equality.
    const t90For = (panelMass: number) =>
      evaluateHingeCandidate(K, C, {
        params: { ...DEFAULT_PARAMS, panelMass, hinge: { ...DEFAULT_PARAMS.hinge } },
      }).t90;

    const cfrp = t90For(0.020);
    const fr4 = t90For(0.032);
    const alKapton = t90For(0.050);
    expect(cfrp).toBeLessThan(fr4);
    expect(fr4).toBeLessThan(alKapton);
    expect(fr4).toBeGreaterThan(1.0);
    expect(fr4).toBeLessThan(2.0);
  });
});
