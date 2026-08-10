import React, { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { DEFAULT_PARAMS } from '@/lib/physics/types';
import {
  DELAY_PRESETS,
  DELAY_UNITS,
  UNIT_TO_SECONDS,
  deriveDelayDisplay,
  scaleTo,
  type DelayUnit,
} from '@/lib/scenario/delay';

interface DelayInputProps {
  /** Canonical δt in seconds (the ScenarioSpec field / `dt` URL parameter). */
  delaySeconds: number;
  onChange: (delaySeconds: number) => void;
  /** Compact layout for the Simulation sidebar; Compare uses the wider default. */
  className?: string;
}

/**
 * The δt control, shared by the Simulation and Compare pages (previously duplicated verbatim).
 *
 * The user still edits in ns / µs / ms; only the canonical seconds value is stored. The unit is
 * purely visual state — seeded from the canonical value and re-seeded whenever δt changes from
 * outside (a preset, a pasted URL, browser Back) — while the magnitude is always derived, never
 * stored, so it cannot fall out of step with the URL.
 */
export default function DelayInput({ delaySeconds, onChange, className }: DelayInputProps) {
  const [unit, setUnit] = useState<DelayUnit>(() => deriveDelayDisplay(delaySeconds).unit);

  // Re-derive the display unit when δt changes to a value the current unit renders poorly
  // (e.g. Back-navigating from 5 ms to 250 µs). Editing within a unit keeps that unit.
  useEffect(() => {
    const derived = deriveDelayDisplay(delaySeconds);
    setUnit(current => {
      const magnitudeInCurrent = delaySeconds / UNIT_TO_SECONDS[current];
      return magnitudeInCurrent >= 1 || delaySeconds === 0 ? current : derived.unit;
    });
  }, [delaySeconds]);

  const magnitude = scaleTo(delaySeconds, unit);
  const timeStepMs = (DEFAULT_PARAMS.timeStep * 1000).toFixed(2);

  return (
    <div className={className ?? 'space-y-2'}>
      <Label className="text-xs text-muted-foreground" htmlFor="delay-magnitude">
        Timing Discrepancy δt
      </Label>
      <div className="flex items-center gap-2">
        <input
          id="delay-magnitude"
          type="number"
          min={0}
          step={1}
          value={magnitude}
          onChange={e => onChange(Math.max(0, Number(e.target.value)) * UNIT_TO_SECONDS[unit])}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
        />
        <div className="flex items-center gap-1">
          {DELAY_UNITS.map(u => (
            <button
              key={u}
              type="button"
              onClick={() => {
                // Switching unit re-interprets the displayed magnitude in the new unit, matching
                // the previous per-page behaviour (magnitude and unit were independent state).
                setUnit(u);
                onChange(magnitude * UNIT_TO_SECONDS[u]);
              }}
              aria-pressed={unit === u}
              className={`px-2 py-1 rounded-md text-[10px] border transition-colors ${
                unit === u
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-transparent bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              {u}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {DELAY_PRESETS.map(preset => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(preset.seconds)}
            className="rounded-md border border-border bg-secondary/50 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground hover:bg-secondary"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground">
        Panel i releases at i·δt. Timing resolution = the fixed physics timestep of {timeStepMs} ms
        (1/1200 s): release times snap to the next step boundary, so a 5 ms δt is honoured to within
        one step, while sub-{timeStepMs} ms values quantise to zero.
      </p>
    </div>
  );
}
