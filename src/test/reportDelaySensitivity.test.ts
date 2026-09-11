import { beforeAll, describe, expect, it } from 'vitest';
import { generateReportRows, type ReportRow } from '@/lib/physics/reportData';

// ─────────────────────────────────────────────────────────────────────────────
//  Empirical confirmation that δt is correctly wired into the 42-scenario report
//  sweep (generateReportRows), end to end — no mocking, the real physics-driven
//  computation path (buildScenarioParams -> runFullSimulation -> computeSingleRow).
//
//  Three δt values, all other inputs (config/failureMode/material) held constant:
//    0 s      — Ideal
//    250 µs   — Nominal preset
//    5 ms     — Worst-case preset
//
//  Each full sweep is ~24 s of physics, so all three are generated ONCE here and
//  reused by every assertion below (generateReportRows caches per δt internally,
//  but that cache is per-module-instance, so a single beforeAll keeps this file's
//  total runtime to ~3 sweeps instead of N).
// ─────────────────────────────────────────────────────────────────────────────

const DT_IDEAL = 0;
const DT_NOMINAL = 250e-6;
const DT_WORST = 5e-3;

let rowsIdeal: ReportRow[];
let rowsNominal: ReportRow[];
let rowsWorst: ReportRow[];

beforeAll(() => {
  rowsIdeal = generateReportRows(DT_IDEAL);
  rowsNominal = generateReportRows(DT_NOMINAL);
  rowsWorst = generateReportRows(DT_WORST);
}, 180000); // 3 full 42-row physics sweeps (~24 s each)

function findRow(rows: ReportRow[], id: string): ReportRow {
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error(`row ${id} missing from sweep`);
  return row;
}

function relDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), 1e-300);
  return Math.abs(b - a) / denom;
}

describe('42-scenario report sweep responds to δt (all three sweeps present)', () => {
  it('every δt sweep produces exactly 42 rows', () => {
    expect(rowsIdeal).toHaveLength(42);
    expect(rowsNominal).toHaveLength(42);
    expect(rowsWorst).toHaveLength(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tier 1 — all-stuck: zero panels ever activate (engine.ts short-circuits
//  activation on `panel.stuck` before the δt-derived delay is even consulted),
//  so these rows must be EXACTLY (===) invariant to δt — a genuine structural
//  guarantee, not an approximation.
// ─────────────────────────────────────────────────────────────────────────────

describe('all-stuck rows are byte-identical across every δt (no panel ever deploys)', () => {
  it('τ_avg,detumble, peak ω, and t90 are exactly (===) unchanged for every all-stuck row', () => {
    const allStuckIdeal = rowsIdeal.filter(r => r.failureMode === 'all-stuck');
    expect(allStuckIdeal.length).toBeGreaterThan(0);

    for (const baseline of allStuckIdeal) {
      const nominal = findRow(rowsNominal, baseline.id);
      const worst = findRow(rowsWorst, baseline.id);

      for (const row of [nominal, worst]) {
        expect(row.averageRequiredDetumblingTorqueNm).toBe(baseline.averageRequiredDetumblingTorqueNm);
        expect(row.peakOmegaDegPerS).toBe(baseline.peakOmegaDegPerS);
        expect(row.deployTimeS).toBe(baseline.deployTimeS);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tier 2 — two-adjacent / two-opposite: two or more panels release with a
//  genuine relative stagger (their global panel indices differ by enough that
//  i*δt crosses the 1/1200 s physics-timestep quantisation boundary at 5 ms —
//  see the δt=250µs "only Coupled responds" investigation for the same
//  mechanism). Breaking the δt=0 release symmetry changes the peak momentum
//  the deployment induces by many orders of magnitude, not just a rounding-level
//  amount — so a 1e-6 relative-difference floor comfortably separates this from
//  floating-point noise.
// ─────────────────────────────────────────────────────────────────────────────

describe('multi-panel-pairing rows (two-adjacent / two-opposite) diverge sharply between δt=0 and δt=5ms', () => {
  it('every two-adjacent/two-opposite row shows relative difference > 1e-6 in τ_avg,detumble and peak ω', () => {
    const pairedIdeal = rowsIdeal.filter(
      r => r.failureMode === 'two-adjacent' || r.failureMode === 'two-opposite',
    );
    // 3 configs (double-long-edge, short-edge, short-edge-long-edge) x 2 modes x 3 materials.
    expect(pairedIdeal.length).toBe(18);

    for (const baseline of pairedIdeal) {
      const worst = findRow(rowsWorst, baseline.id);

      const tauDiff = relDiff(baseline.averageRequiredDetumblingTorqueNm, worst.averageRequiredDetumblingTorqueNm);
      const omegaDiff = relDiff(baseline.peakOmegaDegPerS, worst.peakOmegaDegPerS);

      expect(tauDiff, `${baseline.id}: τ_avg,detumble`).toBeGreaterThan(1e-6);
      expect(omegaDiff, `${baseline.id}: peak ω`).toBeGreaterThan(1e-6);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tier 3 — long-edge one-stuck: the ONE row with exactly one free (deploying)
//  panel. Its own release delay (1 x δt) genuinely shifts when it starts
//  moving, so this is NOT expected to be byte-identical like an all-stuck row —
//  but with only one panel in motion there is no release-ORDER symmetry to
//  break, so the shift shows up only as a small peak-sampling-resolution
//  artifact (trajectory frames are recorded at ~20 Hz), not a structural
//  coupling effect. Verified empirically before writing this assertion: the
//  measured relative difference is ~3e-4, comfortably below 1%.
// ─────────────────────────────────────────────────────────────────────────────

describe('long-edge one-stuck (single free panel): real but small, not byte-identical', () => {
  it('shows a nonzero but small (<1%) relative difference in τ_avg,detumble at δt=5ms vs δt=0', () => {
    for (const material of ['fr4', 'al-kapton', 'cfrp'] as const) {
      const id = `long-edge-one-stuck-${material}`;
      const baseline = findRow(rowsIdeal, id);
      const worst = findRow(rowsWorst, id);

      const tauDiff = relDiff(baseline.averageRequiredDetumblingTorqueNm, worst.averageRequiredDetumblingTorqueNm);

      // Genuinely different — do NOT expect byte-identical here.
      expect(tauDiff, `${id}: τ_avg,detumble`).toBeGreaterThan(0);
      // ...but small: this is a single-panel timing shift, not a multi-panel coupling effect.
      expect(tauDiff, `${id}: τ_avg,detumble`).toBeLessThan(1e-2);
    }
  });
});
