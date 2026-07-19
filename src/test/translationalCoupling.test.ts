// ─────────────────────────────────────────────────────────────────────────────
//  Translational-coupling omission diagnostic — full-history evaluation
//  (Phase-B audit, Gate C).
//
//  Metric (mandated): max over the deployment history of
//      ‖ω̇_omitted‖ / max(‖ω̇_retained‖, OMEGA_DOT_FLOOR)
//  with the COMBINED omitted forcing (direct m_sc·(r_C/B×r̈_B/N) Eq. 5 term
//  plus every active panel's a_θ-propagated K_i contribution). It bounds
//  omitted FORCING relative to retained rotational forcing — NOT output
//  attitude or angle error. NO-GO threshold: 0.01 (1%). NOT loosened here.
//
//  ┌───────────────────────────────────────────────────────────────────────┐
//  │ GATE-C RESULT: NO-GO (measured, preserved as evidence below).         │
//  │                                                                       │
//  │ Under the full-history metric the rotational-only specialization does │
//  │ NOT satisfy the 1% bound:                                             │
//  │  • one-stuck scenarios reach ≈3–9% of retained forcing during         │
//  │    ordinary free-travel deployment (FR4: long-edge 3.1%,              │
//  │    double-long-edge 8.6%, short-edge 4.6%, coupled 7.6%);             │
//  │  • during spatially SYMMETRIC sub-phases the retained rotational      │
//  │    forcing cancels to ≈0 while the omitted term (deployed-stack CoM   │
//  │    offset × B-point acceleration) does not — the pointwise ratio is   │
//  │    then unbounded (measured up to ≈1.6e3 for the coupled nominal,     │
//  │    with ABSOLUTE omitted forcing only ~3.6e-6 N·m / |Δω̇|~2e-4        │
//  │    rad/s²). No defensible floor changes the outcome.                  │
//  │                                                                       │
//  │ The earlier peak-|ω̇|-sample diagnostic reported 0.06–0.17% because   │
//  │ it sampled exactly where the denominator is largest.                  │
//  │                                                                       │
//  │ These tests PIN the measured evidence (so it cannot silently drift)   │
//  │ and assert the diagnostic's own validity. They do NOT convert the     │
//  │ NO-GO into a pass — see the Phase-B audit report for the decision     │
//  │ and the candidate next actions (full translational back-substitution  │
//  │ per paper Eqs. 16–24, or an explicit thesis-scope re-statement of the │
//  │ bound as an integrated-effect limit).                                 │
//  └───────────────────────────────────────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  estimateTranslationalCouplingRatio,
  type TranslationalCouplingReport,
} from '../lib/physics/translationalCoupling';
import { DEFAULT_PARAMS, MATERIAL_PRESETS, type ConfigType, type SimulationParams } from '../lib/physics/types';

const OMEGA0 = new Vector3(0, 0, (10 * Math.PI) / 180);
/** Mandated NO-GO threshold — kept at 0.01; never loosened. */
const RATIO_MAX = 0.01;

const MAX_TIME: Record<ConfigType, number> = {
  'long-edge': 10, 'double-long-edge': 16, 'short-edge': 14, 'short-edge-long-edge': 24,
};

const collected: { label: string; ratio: number }[] = [];

function report(label: string, r: TranslationalCouplingReport): void {
  collected.push({ label, ratio: r.ratio });
  console.info(
    `[translational-coupling] ${label}: maxRatio=${r.ratio.toExponential(3)} ` +
    `@t=${r.peakTime.toFixed(3)}s (${r.samplesEvaluated} samples)  ` +
    `|r̈_B|=${r.rBddotWorld.length().toExponential(2)} m/s²  ` +
    `|ω̇_retained|=${r.omegaDotActual.length().toExponential(2)}  |Δω̇|=${r.deltaOmegaDot.length().toExponential(2)}  ` +
    `direct=${r.directTermMag.toExponential(2)} N·m  panel=${r.panelTermMag.toExponential(2)} N·m`,
  );
}

function expectValid(r: TranslationalCouplingReport): void {
  expect(Number.isFinite(r.ratio)).toBe(true);
  expect(r.samplesEvaluated).toBeGreaterThan(100);
  expect(Number.isFinite(r.rBddotWorld.length())).toBe(true);
}

describe('full-history omitted-coupling measurement (evidence collection, all configurations × materials)', () => {
  for (const config of ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'] as ConfigType[]) {
    it(`${config}: one-stuck measured under every material (evidence rows)`, () => {
      for (const mat of MATERIAL_PRESETS) {
        const params: SimulationParams = { ...DEFAULT_PARAMS, panelMass: mat.panelMass };
        const r = estimateTranslationalCouplingRatio(
          config, params, [0], OMEGA0.clone(), MAX_TIME[config],
        );
        report(`${config}/one-stuck/${mat.key}`, r);
        expectValid(r);
      }
    }, 240000);
  }

  it('two-opposite-stuck (short-edge [0,2], coupled [0,2]) measured (evidence rows)', () => {
    for (const config of ['short-edge', 'short-edge-long-edge'] as ConfigType[]) {
      const r = estimateTranslationalCouplingRatio(
        config, DEFAULT_PARAMS, [0, 2], OMEGA0.clone(), MAX_TIME[config],
      );
      report(`${config}/two-opposite`, r);
      expectValid(r);
    }
  }, 240000);

  it('asymmetric 5 ms timing-offset and nominal staged deployments measured (evidence rows)', () => {
    const params: SimulationParams = {
      ...DEFAULT_PARAMS,
      hinge: { ...DEFAULT_PARAMS.hinge, panelStartDelays: [0, 0.005] },
    };
    report('long-edge/δt=5ms', estimateTranslationalCouplingRatio('long-edge', params, [], OMEGA0.clone(), 10));
    for (const config of ['double-long-edge', 'short-edge-long-edge'] as ConfigType[]) {
      const r = estimateTranslationalCouplingRatio(
        config, DEFAULT_PARAMS, [], OMEGA0.clone(), MAX_TIME[config],
      );
      report(`${config}/nominal`, r);
      expectValid(r);
    }
  }, 240000);

  it('is deterministic and reproducible (identical inputs → identical report)', () => {
    const a = estimateTranslationalCouplingRatio('long-edge', DEFAULT_PARAMS, [0], OMEGA0.clone(), 6);
    const b = estimateTranslationalCouplingRatio('long-edge', DEFAULT_PARAMS, [0], OMEGA0.clone(), 6);
    expect(a.ratio).toBe(b.ratio);
    expect(a.peakTime).toBe(b.peakTime);
    expect(a.samplesEvaluated).toBe(b.samplesEvaluated);
  }, 120000);

  it('GATE-C DECISION PIN: the 1% bound is measurably EXCEEDED — rotational-only omission is NOT validated under this metric (NO-GO evidence, not a pass)', () => {
    // Every asymmetric one-stuck row individually exceeds the threshold, and
    // the symmetric-phase rows exceed it by orders of magnitude. These
    // assertions pin the measured NO-GO so it cannot silently drift or be
    // reinterpreted as a pass; the threshold itself remains 0.01, unweakened.
    const oneStuckRows = collected.filter(c => c.label.includes('/one-stuck/'));
    expect(oneStuckRows.length).toBeGreaterThanOrEqual(12);
    for (const row of oneStuckRows) {
      expect(row.ratio, `${row.label} (measured evidence)`).toBeGreaterThan(RATIO_MAX);
      // Sanity ceiling: asymmetric-transient rows are percent-scale, not
      // divergent (divergence is specific to symmetric near-zero phases):
      expect(row.ratio, `${row.label} sanity ceiling`).toBeLessThan(0.5);
    }
    const worst = collected.reduce((m, c) => (c.ratio > m.ratio ? c : m));
    console.info(
      `[translational-coupling] GATE-C: worst ratio ${worst.ratio.toExponential(3)} (${worst.label}) ` +
      `> threshold ${RATIO_MAX} → NO-GO (see audit report)`,
    );
    expect(worst.ratio).toBeGreaterThan(RATIO_MAX);
  });
});
