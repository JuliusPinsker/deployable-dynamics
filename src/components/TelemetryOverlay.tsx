import React from 'react';
import type { SpacecraftState } from '@/lib/physics/types';
import { formatOmegaDegPerSec, formatTorqueNm } from '@/lib/utils';

interface TelemetryOverlayProps {
  state: SpacecraftState;
  /** Instantaneous (current-frame) τ_avg,detumble (N·m) — decays to ~0 as the body settles. */
  detumblingTorqueNm?: number;
  /** Peak τ_avg,detumble reached so far this run (N·m) — stays elevated through the coast. */
  peakDetumblingTorqueNm?: number;
  delayMagnitude: number;
  delayUnit: 'ns' | 'µs' | 'ms';
  materialLabel: string;
}

function formatNum(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

export default function TelemetryOverlay({
  state,
  detumblingTorqueNm,
  peakDetumblingTorqueNm,
  delayMagnitude,
  delayUnit,
  materialLabel,
}: TelemetryOverlayProps) {
  const maxContact = Math.max(...state.panels.map(p => p.contactForce), 0);
  const avgAngle = state.panels.reduce((s, p) => s + p.angle, 0) / state.panels.length;
  const deployPct = Math.min(100, (avgAngle / (Math.PI / 2)) * 100);
  // Live value still feeds the peak as a floor (so the reading never lags below the current
  // instantaneous), but is no longer rendered on its own — only the peak is displayed.
  const liveValue = detumblingTorqueNm ?? 0;
  const peakValue = Math.max(peakDetumblingTorqueNm ?? 0, liveValue);
  const delayDisplay = delayMagnitude === 0
    ? '0 (ideal sync)'
    : `${delayMagnitude} ${delayUnit}`;

  return (
    <div className="absolute top-3 left-3 bg-card/90 backdrop-blur-md border border-border rounded-lg p-3 font-mono text-xs space-y-2 min-w-[200px]">
      <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-1">Live Telemetry</div>

      <div className="space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωx</span>
          <span className="text-primary">{formatOmegaDegPerSec(state.angularVelocity.x)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωy</span>
          <span className="text-accent">{formatOmegaDegPerSec(state.angularVelocity.y)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωz</span>
          <span className="text-config-4">{formatOmegaDegPerSec(state.angularVelocity.z)}</span>
        </div>
      </div>

      <div className="border-t border-border pt-1 space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Deploy</span>
          <span>{deployPct.toFixed(0)}%</span>
        </div>
        <div className="w-full bg-secondary rounded-full h-1.5">
          <div
            className="bg-primary h-1.5 rounded-full transition-all"
            style={{ width: `${deployPct}%` }}
          />
        </div>
      </div>

      <div className="border-t border-border pt-1 flex justify-between">
        <span className="text-muted-foreground">Contact F</span>
        <span className={maxContact > 10 ? 'text-destructive' : ''}>{formatNum(maxContact, 1)} N</span>
      </div>

      <div className="border-t border-border pt-1">
        <div className="text-muted-foreground text-[10px] leading-tight">τ_avg,detumble</div>
        <div className="flex justify-end font-mono font-semibold">
          {formatTorqueNm(peakValue)} N·m
        </div>
      </div>

      <div className="border-t border-border pt-1 flex justify-between">
        <span className="text-muted-foreground">Panel material</span>
        <span>{materialLabel}</span>
      </div>

      <div className="border-t border-border pt-1 flex justify-between">
        <span className="text-muted-foreground">Δt actuation</span>
        <span>{delayDisplay}</span>
      </div>

      <div className="border-t border-border pt-1 flex justify-between">
        <span className="text-muted-foreground">Time</span>
        <span>{formatNum(state.time, 2)}s</span>
      </div>
    </div>
  );
}
