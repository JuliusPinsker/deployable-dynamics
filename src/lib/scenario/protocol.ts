/**
 * The report's evaluation protocol — the statement of what was actually evaluated.
 *
 * Built ONCE and rendered twice (on screen and into the PDF) so the two can never drift. The PDF
 * variant differs only by an ASCII substitution: jsPDF's standard fonts cannot render δ, τ, or
 * subscript digits, so those characters are spelled out. Any test comparing the two renderings is
 * therefore comparing the same source data, not two hand-written strings.
 */

import { DEFAULT_PARAMS } from '@/lib/physics/types';
import { formatDelay } from './delay';

export interface ProtocolLine {
  label: string;
  value: string;
}

export interface ProtocolInput {
  /** Active timing discrepancy in seconds — the ScenarioSpec field that reaches report physics. */
  delaySeconds: number;
  /** Configurations currently passing the filter. */
  selectedConfigCount: number;
  /** Failure modes currently passing the filter. */
  selectedFailureCount: number;
  /** Materials currently passing the filter. */
  selectedMaterialCount: number;
  /** Rows generated before any filter is applied (the full matrix). */
  totalScenarios: number;
  /** Rows visible after filtering. */
  shownScenarios: number;
}

/** Total configurations / materials / failure modes the sweep spans. Fixed by the matrix design. */
export const PROTOCOL_CONFIG_COUNT = 4;
export const PROTOCOL_MATERIAL_COUNT = 3;

export function buildProtocolLines(input: ProtocolInput): ProtocolLine[] {
  const timeStepMs = (DEFAULT_PARAMS.timeStep * 1000).toFixed(2);

  return [
    {
      label: 'Timing discrepancy δt',
      value: `${formatDelay(input.delaySeconds)} (${input.delaySeconds} s) — panel i releases at i·δt`,
    },
    {
      label: 'Fixed physics time step',
      value: `${timeStepMs} ms (1/1200 s) — release times quantise to this step`,
    },
    {
      label: 'Configurations',
      value: `${PROTOCOL_CONFIG_COUNT} panel configurations (long-edge, double-long-edge, short-edge, short-edge with long-edge coupling)`,
    },
    {
      label: 'Material presets',
      value: `${PROTOCOL_MATERIAL_COUNT} presets (FR4, Al/Kapton, CFRP)`,
    },
    {
      label: 'Failure modes',
      value:
        'Topology-valid only: one-stuck and all-stuck for every configuration; two-adjacent and '
        + 'two-opposite only where a distinct panel pair exists (not long-edge)',
    },
    {
      label: 'Unfiltered matrix',
      value: `${input.totalScenarios}-scenario sweep — (2 modes × 3 materials) + (4 modes × 3 configurations × 3 materials)`,
    },
    {
      label: 'Active filters',
      value:
        `${input.selectedConfigCount}/${PROTOCOL_CONFIG_COUNT} configurations · `
        + `${input.selectedFailureCount}/4 failure modes · `
        + `${input.selectedMaterialCount}/${PROTOCOL_MATERIAL_COUNT} materials · `
        + `${input.shownScenarios} of ${input.totalScenarios} scenarios shown`,
    },
  ];
}

/** Characters jsPDF's standard fonts cannot render, and their spelled-out equivalents. */
const PDF_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/δt/g, 'dt'],
  [/τ/g, 'tau'],
  [/θ/g, 'theta'],
  [/ω/g, 'omega'],
  [/₉₀/g, '90'],
];

/** ASCII-safe form of a single protocol string. Content is otherwise identical to the screen text. */
export function toPdfAscii(text: string): string {
  return PDF_SUBSTITUTIONS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    text,
  );
}

/** The protocol as `"Label: value"` lines for the PDF, from the same builder the screen uses. */
export function protocolToPdfLines(lines: ProtocolLine[]): string[] {
  return lines.map(line => toPdfAscii(`${line.label}: ${line.value}`));
}
