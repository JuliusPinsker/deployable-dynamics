import React, { useState, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  CONFIGURATIONS,
  DEFAULT_PARAMS,
  MATERIAL_PRESETS,
  type ConfigType,
  type MaterialPresetKey,
} from '@/lib/physics/types';
import { runFullSimulation, type SimulationFrame } from '@/lib/physics/engine';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, BarChart, Bar, ResponsiveContainer } from 'recharts';
import ThemeToggle from '@/components/ui/theme-toggle';
import { AlertTriangle } from 'lucide-react';

const chartConfig: ChartConfig = {
  'long-edge': { label: 'Long-edge', color: 'hsl(210, 100%, 55%)' },
  'double-long-edge': { label: 'Double Long-edge', color: 'hsl(168, 70%, 45%)' },
  'short-edge': { label: 'Short-edge', color: 'hsl(35, 95%, 55%)' },
  'short-edge-long-edge': { label: 'Coupled', color: 'hsl(280, 65%, 55%)' },
};

const COLORS = ['hsl(210, 100%, 55%)', 'hsl(168, 70%, 45%)', 'hsl(35, 95%, 55%)', 'hsl(280, 65%, 55%)'];

const UNIT_TO_SECONDS: Record<'ns' | 'µs' | 'ms', number> = {
  ns: 1e-9,
  µs: 1e-6,
  ms: 1e-3,
};

type AnomalyType = 'none' | 'one-stuck' | 'two-opposite' | 'two-adjacent' | 'all-stuck';
type FailureAnomalyType = Exclude<AnomalyType, 'none'>;

const FAILURE_SCENARIO_TEXT: Record<FailureAnomalyType, string> = {
  'one-stuck': 'Panel Failure: 1 panel jammed at 0° — asymmetric inertia disturbance',
  'two-opposite': 'Panel Failure: 2 opposite panels stuck — symmetric torque imbalance',
  'two-adjacent': 'Panel Failure: 2 adjacent panels stuck — net CoM offset + torque bias',
  'all-stuck': 'Catastrophic Failure: All panels locked — deployment aborted, CubeSat remains in tumble state',
};

/**
 * Index at which to cut a trajectory so the charts end at the deployment settle point,
 * trimming the post-deployment observation-window tail (during which the engine keeps the
 * body coasting while panels are held fixed, so `time` now advances instead of freezing).
 *
 * Uses a tolerance band around the final (held) panel angle and returns just past the LAST
 * frame still outside the band — robust to overshoot/ringing (the calibrated lightly
 * damped hinge arrives at the stop with momentum; a bistable hinge could oscillate).
 * Configs that never move (e.g. all-stuck) return 1, matching the previous near-t=0
 * deploy-time behaviour. NOTE: the resulting cut marks the deployment SETTLE point
 * (panel motion complete) — a different quantity from the report's t_deploy,90 metric
 * (first reach of 90% of the deployed angle).
 */
export function deploymentSettleCut(frames: SimulationFrame[]): number {
  const finalAngles = frames.at(-1)?.panelAngles ?? [];
  const finalMax = finalAngles.length ? Math.max(...finalAngles) : 0;
  const tol = Math.max(1e-4, 0.001 * finalMax);
  let lastMoving = -1;
  for (let k = 0; k < frames.length; k++) {
    const m = frames[k].panelAngles.length ? Math.max(...frames[k].panelAngles) : 0;
    if (Math.abs(m - finalMax) > tol) lastMoving = k; // still deploying / oscillating
  }
  return lastMoving >= 0 ? Math.min(frames.length, lastMoving + 3) : 1; // +3 settle buffer
}


export default function ComparePage() {
  const location = useLocation();
  const [stuckPanels, setStuckPanels] = useState<number[]>([]);
  const [anomaly, setAnomaly] = useState<AnomalyType>('none');
  const [delayMagnitude, setDelayMagnitude] = useState<number>(0);
  const [delayUnit, setDelayUnit] = useState<'ns' | 'µs' | 'ms'>('µs');
  const delaySeconds = delayMagnitude * UNIT_TO_SECONDS[delayUnit];
  const delayPresets = [
    { label: 'Ideal (0 ns)', magnitude: 0, unit: 'ns' },
    { label: 'Nominal (250 µs)', magnitude: 250, unit: 'µs' },
    { label: 'Worst-case (5 ms)', magnitude: 5, unit: 'ms' },
  ] as const;
  // Router state from the Landing page only SEEDS the on-page selector (header
  // links drop router state, so the page owns material selection).
  const navPanelMass = (location.state as { panelMass?: number } | null)?.panelMass
    ?? DEFAULT_PARAMS.panelMass;
  const [materialKey, setMaterialKey] = useState<MaterialPresetKey>(
    MATERIAL_PRESETS.find(preset => preset.panelMass === navPanelMass)?.key ?? 'fr4',
  );
  const activeMaterial = MATERIAL_PRESETS.find(preset => preset.key === materialKey)!;

  const stuckConfig = useMemo(() => {
    switch (anomaly) {
      case 'one-stuck': return [0];
      case 'two-opposite': return [0, 1];
      case 'two-adjacent': return [0, 2];
      case 'all-stuck': return [0, 1, 2, 3, 4, 5];
      default: return [];
    }
  }, [anomaly]);

  const activeFailureText = anomaly !== 'none' ? FAILURE_SCENARIO_TEXT[anomaly] : null;

  const failureImpactData = useMemo(() => {
    return CONFIGURATIONS.map((config, i) => {
      const stuckCount = Math.min(stuckConfig.length, config.panelCount);
      const deployedCount = config.panelCount - stuckCount;
      const stuckFraction = stuckCount / config.panelCount;

      let coupling: 'None' | 'Low' | 'Medium' | 'High' | 'Catastrophic' = 'None';
      if (stuckFraction > 0.75) coupling = 'Catastrophic';
      else if (stuckFraction > 0.5) coupling = 'High';
      else if (stuckFraction > 0.25) coupling = 'Medium';
      else if (stuckFraction > 0) coupling = 'Low';

      const successFraction = (deployedCount / config.panelCount) * 100;
      const progressBarColor =
        successFraction > 75
          ? 'bg-green-500'
          : successFraction >= 25
          ? 'bg-amber-500'
          : 'bg-red-500';

      return {
        config,
        color: COLORS[i],
        stuckCount,
        deployedCount,
        coupling,
        successFraction,
        progressBarColor,
      };
    });
  }, [stuckConfig]);

  // Physics-driven comparison runs for the SELECTED material, computed in an
  // effect (one config per event-loop turn) with a computing badge instead of
  // freezing the page. The `cancelled` flag guarantees a superseded selection
  // (material/δt/anomaly change) can never overwrite newer results with stale
  // ones.
  const [allSimData, setAllSimData] =
    useState<Record<ConfigType, SimulationFrame[]> | null>(null);
  const [computing, setComputing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setComputing(true);
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    const results: Record<ConfigType, SimulationFrame[]> = {} as Record<ConfigType, SimulationFrame[]>;
    const resolvedStuck = stuckConfig ?? [];
    const panelMass = activeMaterial.panelMass;

    (async () => {
      for (const c of configs) {
        // Yield to the event loop before each config so rendering stays live.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (cancelled) return;
        // Sequential burn-wire release: panel i fires at i × δt, per config's panel count.
        // Deployment is physics-driven (calibrated torsional spring-damper hinge from
        // DEFAULT_PARAMS) — the same authoritative dynamics used by the Report sweep.
        // The horizon is a CAP: each run ends once all panels latch (plus the observation
        // window); the slowest 3-stage coupled config completes in ~12 s of simulated time.
        const panelCount = CONFIGURATIONS.find(cfg => cfg.id === c)?.panelCount ?? 2;
        const panelStartDelays = Array.from({ length: panelCount }, (_, i) => i * delaySeconds);
        const params = {
          ...DEFAULT_PARAMS,
          panelMass,
          hinge: {
            ...DEFAULT_PARAMS.hinge,
            panelStartDelays,
          },
        };
        const frames = runFullSimulation(c, params, 90, resolvedStuck);
        // The engine keeps the body coasting through a post-deployment observation window, so
        // `time` advances monotonically instead of freezing at settle. Trim to the deployment
        // window via panel-angle settle detection so the shared chart x-axis and deploy-time
        // metric stay focused on deployment (not the coast tail).
        results[c] = frames.slice(0, deploymentSettleCut(frames));
      }
      if (!cancelled) {
        setAllSimData(results);
        setComputing(false);
      }
    })();

    return () => { cancelled = true; };
  }, [stuckConfig, activeMaterial.panelMass, delaySeconds]);

  // Merge data for angular velocity chart
  const angVelData = useMemo(() => {
    if (!allSimData) return [];
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    const maxLen = Math.max(...configs.map(c => allSimData[c].length));
    const data: any[] = [];
    for (let i = 0; i < maxLen; i += 2) {
      const point: any = {};
      for (const c of configs) {
        const frame = allSimData[c][i];
        if (frame) {
          point.time = frame.time;
          const totalOmega = Math.sqrt(
            frame.angularVelocity.x ** 2 +
            frame.angularVelocity.y ** 2 +
            frame.angularVelocity.z ** 2
          );
          point[c] = Number(((totalOmega * 180) / Math.PI).toFixed(3));
        }
      }
      if (point.time !== undefined) data.push(point);
    }
    return data;
  }, [allSimData]);

  // Detumbling energy over time (mJ)
  const eDetumbleData = useMemo(() => {
    if (!allSimData) return [];
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    const maxLen = Math.max(...configs.map(c => allSimData[c].length));
    const data: any[] = [];
    for (let i = 0; i < maxLen; i += 2) {
      const point: any = {};
      for (const c of configs) {
        const frame = allSimData[c][i];
        if (frame) {
          point.time = frame.time;
          point[c] = Number(frame.eDetumble.toFixed(3));
        }
      }
      if (point.time !== undefined) data.push(point);
    }
    return data;
  }, [allSimData]);

  // Peak acceleration bar chart
  const peakAccelData = useMemo(() => {
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    return configs.map((c, i) => {
      const frames = allSimData?.[c] ?? [];
      let peakAccel = 0;
      for (const f of frames) {
        const total = Math.sqrt(f.angularAcceleration.x ** 2 + f.angularAcceleration.y ** 2 + f.angularAcceleration.z ** 2);
        peakAccel = Math.max(peakAccel, total);
      }
      return {
        name: CONFIGURATIONS[i].shortName,
        value: Number(((peakAccel * 180) / Math.PI).toFixed(2)),
        fill: COLORS[i],
      };
    });
  }, [allSimData]);

  // Deployment time
  const deployTimeData = useMemo(() => {
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    return configs.map((c, i) => {
      const frames = allSimData?.[c] ?? [];
      const lastFrame = frames[frames.length - 1];
      return {
        name: CONFIGURATIONS[i].shortName,
        value: Number((lastFrame?.time || 0).toFixed(2)),
        fill: COLORS[i],
      };
    });
  }, [allSimData]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <a href="/" className="font-semibold text-lg tracking-tight">
          <span className="text-primary">CubeSat</span> Deploy Sim
        </a>
        <div className="flex items-center gap-4">
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <a href="/" className="hover:text-foreground transition-colors">Overview</a>
            <a href="/simulate" className="hover:text-foreground transition-colors">Simulation</a>
            <a href="/compare" className="text-foreground">Compare</a>
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Configuration Comparison</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Quantitative comparison of deployment dynamics across all 4 configurations —
              computed for ONE selected panel material at a time
            </p>
            <span className="text-sm text-muted-foreground">
              Material: {activeMaterial.label} ({activeMaterial.massGrams} g/panel)
              {computing && (
                <span className="ml-2 text-xs text-primary animate-pulse">
                  computing physics runs…
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Panel material">
              {MATERIAL_PRESETS.map(preset => (
                <button
                  key={preset.key}
                  type="button"
                  role="radio"
                  aria-checked={materialKey === preset.key}
                  onClick={() => setMaterialKey(preset.key)}
                  className={`px-2.5 py-1.5 rounded-md text-xs border transition-colors ${
                    materialKey === preset.key
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-transparent bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  {preset.label} · {preset.massGrams} g
                </button>
              ))}
            </div>
            <Select value={anomaly} onValueChange={(value) => setAnomaly(value as AnomalyType)}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Anomaly scenario" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nominal (no failure)</SelectItem>
                <SelectItem value="one-stuck">One panel stuck</SelectItem>
                <SelectItem value="two-opposite">Two panels (opposite)</SelectItem>
                <SelectItem value="two-adjacent">Two panels (adjacent)</SelectItem>
                <SelectItem value="all-stuck">All panels stuck (total failure)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {activeFailureText && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2.5 flex items-center gap-3 text-xs">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            <div className="flex-grow">
              <p className="font-semibold text-amber-200/90">{activeFailureText}</p>
            </div>
            <div className="flex items-center gap-3">
              {failureImpactData.map(({ config, stuckCount }) => {
                return (
                  <span key={config.id} className="font-mono text-[11px] bg-amber-900/30 text-amber-300/80 px-2 py-1 rounded">
                    {config.shortName}: {stuckCount} stuck
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Timing-coupling controls (Bugs 3 & 4) */}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-border bg-card px-4 py-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Timing Discrepancy δt</Label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={1}
                value={delayMagnitude}
                onChange={e => setDelayMagnitude(Math.max(0, Number(e.target.value)))}
                className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              />
              <div className="flex items-center gap-1">
                {(['ns', 'µs', 'ms'] as const).map(unit => (
                  <button
                    key={unit}
                    type="button"
                    onClick={() => setDelayUnit(unit)}
                    aria-pressed={delayUnit === unit}
                    className={`px-2 py-1 rounded-md text-[10px] border transition-colors ${
                      delayUnit === unit
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-transparent bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
                    }`}
                  >
                    {unit}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {delayPresets.map(preset => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => { setDelayMagnitude(preset.magnitude); setDelayUnit(preset.unit); }}
                  className="rounded-md border border-border bg-secondary/50 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground hover:bg-secondary"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground max-w-md">
            δt staggers burn-wire release (panel i fires at i·δt): at δt = 0 the panel-pair
            reactions cancel and the body stays at rest; at δt &gt; 0 the symmetry breaks and the
            body gains angular velocity. Deployment is physics-driven (torsional spring hinge).
            Timing resolution = the fixed physics timestep of
            {' '}{(DEFAULT_PARAMS.timeStep * 1000).toFixed(2)} ms (1/1200 s): release times snap
            to the next step boundary — a 5 ms δt is honoured to within one step; values below
            one step quantise to zero.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Angular Velocity over time */}
          <Card className="col-span-1 lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm">
                <>
                  Total Angular Velocity (°/s) vs Time
                  {anomaly !== 'none' && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 ml-2">
                      FAILURE MODE
                    </span>
                  )}
                </>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[300px]">
                <LineChart data={angVelData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, style: { fontSize: 11 } }} />
                  <YAxis tick={{ fontSize: 11 }} label={{ value: '°/s', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line type="monotone" dataKey="long-edge" stroke={COLORS[0]} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="double-long-edge" stroke={COLORS[1]} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="short-edge" stroke={COLORS[2]} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="short-edge-long-edge" stroke={COLORS[3]} strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
              <div className="flex gap-4 mt-2 justify-center">
                {CONFIGURATIONS.map((c, i) => (
                  <div key={c.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <div className="w-3 h-0.5 rounded" style={{ backgroundColor: COLORS[i] }} />
                    {c.shortName}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Detumbling energy over time */}
          <Card className="col-span-1 lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm">Detumbling Energy (mJ) vs Time</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[300px]">
                <LineChart data={eDetumbleData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, style: { fontSize: 11 } }} />
                  <YAxis tick={{ fontSize: 11 }} label={{ value: 'mJ', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line type="monotone" dataKey="long-edge" stroke={COLORS[0]} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="double-long-edge" stroke={COLORS[1]} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="short-edge" stroke={COLORS[2]} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="short-edge-long-edge" stroke={COLORS[3]} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ChartContainer>
              <div className="flex gap-4 mt-2 justify-center">
                {CONFIGURATIONS.map((c, i) => (
                  <div key={c.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <div className="w-3 h-0.5 rounded" style={{ backgroundColor: COLORS[i] }} />
                    {c.shortName}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Peak Angular Acceleration */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Peak Angular Acceleration (°/s²)</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[250px]">
                <BarChart data={peakAccelData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Deployment settle time */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Deployment Settle Time (s)</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Time until all panel motion settles (stop capture) — not the report&apos;s
                t_deploy,90 metric (first reach of 90% of the deployed angle).
              </p>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[250px]">
                <BarChart data={deployTimeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Summary Table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Summary Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 text-muted-foreground font-medium">Config</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">Panels</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">Peak ω (°/s)</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">T_settle (s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CONFIGURATIONS.map((c, i) => {
                      const frames = allSimData?.[c.id] ?? [];
                      let peakOmega = 0;
                      for (const f of frames) {
                        const omega = Math.sqrt(f.angularVelocity.x ** 2 + f.angularVelocity.y ** 2 + f.angularVelocity.z ** 2);
                        peakOmega = Math.max(peakOmega, omega);
                      }
                      const lastT = frames[frames.length - 1]?.time || 0;
                      return (
                        <tr key={c.id} className="border-b border-border/50">
                          <td className="py-2 flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                            {c.shortName}
                          </td>
                          <td className="text-right py-2 font-mono">{c.panelCount}</td>
                          <td className="text-right py-2 font-mono">{((peakOmega * 180) / Math.PI).toFixed(2)}</td>
                          <td className="text-right py-2 font-mono">{lastT.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {anomaly !== 'none' && (
            <Card className="col-span-1 lg:col-span-2">
              <CardHeader>
                <CardTitle>Failure Mode Impact by Configuration</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {activeFailureText}
                </p>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {failureImpactData.map(({ config, color, stuckCount, deployedCount, coupling, successFraction, progressBarColor }) => {
                    return (
                      <div key={config.id} className="bg-muted/40 rounded-lg p-3 space-y-2 text-xs">
                        <div className="flex items-center gap-2 font-semibold">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                          {config.name}
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Stuck panels:</span>
                          <span>{stuckCount} / {config.panelCount}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Deployed panels:</span>
                          <span>{deployedCount}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Angular momentum coupling:</span>
                          <span className="font-semibold">{coupling}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground text-[11px]">Deploy Success:</span>
                          <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                            <div
                              className={`h-1.5 rounded-full transition-all ${progressBarColor}`}
                              style={{ width: `${successFraction}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
