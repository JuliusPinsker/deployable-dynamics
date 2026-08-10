/**
 * Timing-discrepancy δt unit handling.
 *
 * δt is stored and transported in SECONDS (the canonical `dt` URL parameter and the
 * ScenarioSpec field). Users, however, think in ns / µs / ms — so the display magnitude and
 * unit are DERIVED from the canonical value here rather than being separately stored state.
 */

export type DelayUnit = 'ns' | 'µs' | 'ms';

export const DELAY_UNITS: DelayUnit[] = ['ns', 'µs', 'ms'];

export const UNIT_TO_SECONDS: Record<DelayUnit, number> = {
  ns: 1e-9,
  'µs': 1e-6,
  ms: 1e-3,
};

/** Shared δt presets, previously duplicated verbatim on the Simulation and Compare pages. */
export const DELAY_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: 'Ideal (0 ns)', seconds: 0 },
  { label: 'Nominal (250 µs)', seconds: 250e-6 },
  { label: 'Worst-case (5 ms)', seconds: 5e-3 },
];

/**
 * Derives the display magnitude and unit from canonical seconds: the largest unit that keeps the
 * magnitude at or above 1 (so 0.005 s reads "5 ms", not "5000000 ns"). Zero keeps the finest unit,
 * matching the "Ideal (0 ns)" preset.
 */
export function deriveDelayDisplay(delaySeconds: number): { magnitude: number; unit: DelayUnit } {
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) return { magnitude: 0, unit: 'ns' };
  for (const unit of ['ms', 'µs', 'ns'] as DelayUnit[]) {
    const magnitude = scaleTo(delaySeconds, unit);
    if (magnitude >= 1) return { magnitude, unit };
  }
  return { magnitude: scaleTo(delaySeconds, 'ns'), unit: 'ns' };
}

/**
 * Converts seconds to a unit's magnitude, trimming binary floating-point residue
 * (250e-6 / 1e-6 is 250.00000000000003, which must not surface in an input box).
 */
export function scaleTo(delaySeconds: number, unit: DelayUnit): number {
  return Number((delaySeconds / UNIT_TO_SECONDS[unit]).toPrecision(12));
}

/** Reader-facing δt, e.g. "5 ms" / "250 µs" / "0 ns". */
export function formatDelay(delaySeconds: number): string {
  const { magnitude, unit } = deriveDelayDisplay(delaySeconds);
  const rounded = Number(magnitude.toFixed(3));
  return `${rounded} ${unit}`;
}
