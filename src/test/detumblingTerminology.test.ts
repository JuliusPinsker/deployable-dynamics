import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
//  Exactly ONE detumbling metric is displayed anywhere: the average required
//  detumbling torque, in N·m. Every earlier framing — rotational energy, the
//  angular-momentum-to-remove readout, a "force required", or a peak torque
//  differenced from adjacent samples — must stay out of the presentation layer.
//
//  These are the only files that render the metric to a user (screen, report,
//  PDF). The intermediate |Iω| still exists inside the physics layer, which is
//  deliberately not scanned — it is required to compute the torque.
// ─────────────────────────────────────────────────────────────────────────────
const USER_FACING_FILES = [
  '../components/TelemetryOverlay.tsx',
  '../pages/ComparePage.tsx',
  '../pages/ReportPage.tsx',
  '../pages/SimulationPage.tsx',
];

// Anchored so legitimate neighbours survive: the hinge damping coefficient is genuinely
// measured in N·m·s/rad, and SimulationPage must still CALL computeDetumbleAngularMomentum
// to obtain the intermediate it divides.
const FORBIDDEN: RegExp[] = [
  /\beDetumble/,
  /\bE_detumble\b/i,
  /\bE_det\b/,
  /Detumbling Energy/i,
  /\bdetumbleAngularMomentum\b/,
  /formatAngularMomentumNms/,
  /angular momentum to remove/i,
  /Detumbling requirement \(/i, // the retired telemetry label, parenthetical and all
  /N·m·s(?!\/rad)/,
  /\bmJ\b/,
  /\bLED\b/,
  /F_detumble/i,
  /force required/i,
  /peak torque/i,
];

// Where the spelled-out phrase is allowed, and how many times: exactly once, as the symbol
// definition. Everything else uses the compact symbol τ_avg,detumble (spelled "tau" in PDF
// text, since jsPDF's standard fonts have no τ glyph).
const PHRASE = /average required detumbling torque/gi;
const ALLOWED_PHRASE_COUNT: Record<string, number> = {
  '../components/TelemetryOverlay.tsx': 0,
  '../pages/ComparePage.tsx': 1,
  '../pages/ReportPage.tsx': 2, // once on the page, once in the PDF export
  '../pages/SimulationPage.tsx': 0,
};

describe('detumbling terminology: one metric, one unit', () => {
  for (const relPath of USER_FACING_FILES) {
    it(`${relPath} uses no superseded detumbling terminology`, () => {
      const src = readFileSync(resolve(__dirname, relPath), 'utf-8');
      for (const banned of FORBIDDEN) {
        expect(
          banned.test(src),
          `${relPath} must not reference ${banned}`,
        ).toBe(false);
      }
    });

    it(`${relPath} spells the phrase out only in the symbol definition`, () => {
      const src = readFileSync(resolve(__dirname, relPath), 'utf-8');
      expect(
        (src.match(PHRASE) ?? []).length,
        `${relPath} may spell the phrase out only as the one symbol definition`,
      ).toBe(ALLOWED_PHRASE_COUNT[relPath]);
    });
  }

  it('the report row exposes exactly one detumbling field', () => {
    const src = readFileSync(resolve(__dirname, '../lib/physics/reportData.ts'), 'utf-8');
    const rowBlock = src.slice(
      src.indexOf('export interface ReportRow'),
      src.indexOf('export function resolveReportStuckPanels'),
    );

    expect(rowBlock).toContain('averageRequiredDetumblingTorqueNm');
    expect(rowBlock).not.toContain('detumbleAngularMomentum:');
    expect(rowBlock).not.toContain('eDetumble');
  });
});
