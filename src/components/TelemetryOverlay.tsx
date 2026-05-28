import React from 'react';
import type { SpacecraftState } from '@/lib/physics/types';

interface TelemetryOverlayProps {
  state: SpacecraftState;
  gravityGradientTorqueMag?: number;
  eDetumbleMJ?: number;
  delayMagnitude: number;
  delayUnit: 'ns' | 'µs' | 'ms';
  panelLength?: number; // metres, for computing tip deflection in mm
  materialLabel: string;
}

function formatNum(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

function toDegPerSec(rad: number): string {
  const deg = (rad * 180) / Math.PI;
  const absDeg = Math.abs(deg);
  const safeDeg = Object.is(deg, -0) ? 0 : deg;

  if (absDeg < 0.01) {
    return `${safeDeg.toExponential(2)}°/s`;
  }
  if (absDeg < 0.1) {
    return `${safeDeg.toFixed(4)}°/s`;
  }
  return `${safeDeg.toFixed(2)}°/s`;
}

export default function TelemetryOverlay({
  state,
  gravityGradientTorqueMag,
  eDetumbleMJ,
  delayMagnitude,
  delayUnit,
  materialLabel,
  panelLength = 0.1, // default 0.1 m
}: TelemetryOverlayProps) {
  const maxContact = Math.max(...state.panels.map(p => p.contactForce), 0);
  const avgAngle = state.panels.reduce((s, p) => s + p.angle, 0) / state.panels.length;
  const deployPct = Math.min(100, (avgAngle / (Math.PI / 2)) * 100);
  const eDetumbleValue = eDetumbleMJ ?? 0;
  const eDetumbleColor = eDetumbleValue > 1
    ? '#f97316'
    : eDetumbleValue > 0.1
    ? '#eab308'
    : '#22c55e';
  const delayDisplay = delayMagnitude === 0
    ? '0 (ideal sync)'
    : `${delayMagnitude} ${delayUnit}`;

  // Compute max tip deflection in mm from tipDeflectionDeg (if flex model active)
  const hasFlex = state.panels.some(p => p.tipDeflectionDeg !== undefined);
  const maxTipDeflectionMm = hasFlex
    ? Math.max(
        ...state.panels.map(p => {
          if (p.tipDeflectionDeg === undefined) return 0;
          // deflection (m) = tipDeflectionDeg × π/180 × panelLength
          // deflection (mm) = above × 1000
          return Math.abs(p.tipDeflectionDeg) * (Math.PI / 180) * panelLength * 1000;
        }),
      )
    : undefined;

  return (
    <div className="absolute top-3 left-3 bg-card/90 backdrop-blur-md border border-border rounded-lg p-3 font-mono text-xs space-y-2 min-w-[200px]">
      <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-1">Live Telemetry</div>

      <div className="space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωx</span>
          <span className="text-primary">{toDegPerSec(state.angularVelocity.x)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωy</span>
          <span className="text-accent">{toDegPerSec(state.angularVelocity.y)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωz</span>
          <span className="text-config-4">{toDegPerSec(state.angularVelocity.z)}</span>
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

      <div className="border-t border-border pt-1 flex justify-between">
        <span className="text-muted-foreground">GG Torque</span>
        <span className="text-yellow-400">
          {gravityGradientTorqueMag !== undefined
            ? `${(gravityGradientTorqueMag * 1e6).toFixed(3)} µN·m`
            : '—'}
        </span>
      </div>

      <div className="border-t border-border pt-1 flex justify-between">
        <span className="text-muted-foreground">E detumble</span>
        <span className="font-mono font-semibold" style={{ color: eDetumbleColor }}>
          {eDetumbleValue.toFixed(3)} mJ
        </span>
      </div>

      <div className="border-t border-border pt-1 flex justify-between">
        <span className="text-muted-foreground">Panel material</span>
        <span>{materialLabel}</span>
      </div>

      {/* Flexible panel tip deflection (if flex model active) */}
      {maxTipDeflectionMm !== undefined && (
        <div className="border-t border-border pt-1 flex justify-between">
          <span className="text-muted-foreground">Tip Flex</span>
          <span className="text-cyan-400">
            {maxTipDeflectionMm.toFixed(2)} mm
          </span>
        </div>
      )}

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
