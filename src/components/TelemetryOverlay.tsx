import React from 'react';
import type { SpacecraftState } from '@/lib/physics/types';

interface TelemetryOverlayProps {
  state: SpacecraftState;
}

function formatNum(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

function toDegPerSec(rad: number): string {
  return formatNum((rad * 180) / Math.PI, 2);
}

export default function TelemetryOverlay({ state }: TelemetryOverlayProps) {
  const maxContact = Math.max(...state.panels.map(p => p.contactForce), 0);
  const avgAngle = state.panels.reduce((s, p) => s + p.angle, 0) / state.panels.length;
  const deployPct = Math.min(100, (avgAngle / (Math.PI / 2)) * 100);

  return (
    <div className="absolute top-3 left-3 bg-card/90 backdrop-blur-md border border-border rounded-lg p-3 font-mono text-xs space-y-2 min-w-[200px]">
      <div className="text-muted-foreground text-[10px] uppercase tracking-wider mb-1">Live Telemetry</div>
      
      <div className="space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωx</span>
          <span className="text-primary">{toDegPerSec(state.angularVelocity.x)}°/s</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωy</span>
          <span className="text-accent">{toDegPerSec(state.angularVelocity.y)}°/s</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">ωz</span>
          <span className="text-config-4">{toDegPerSec(state.angularVelocity.z)}°/s</span>
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
        <span className="text-muted-foreground">Time</span>
        <span>{formatNum(state.time, 2)}s</span>
      </div>
    </div>
  );
}
