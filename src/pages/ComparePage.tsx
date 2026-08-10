import React, { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  CONFIGURATIONS,
  MATERIAL_PRESETS,
  type ConfigType,
} from '@/lib/physics/types';
import {
  DETUMBLING_TIME_REQUIREMENT_S,
  frameAverageRequiredDetumblingTorque,
  peakAverageRequiredDetumblingTorque,
  runFullSimulation,
  type SimulationFrame,
} from '@/lib/physics/engine';
import { formatTorqueNm } from '@/lib/utils';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, BarChart, Bar, ResponsiveContainer } from 'recharts';
import SiteHeader from '@/components/SiteHeader';
import DelayInput from '@/components/DelayInput';
import { useScenario } from '@/hooks/useScenario';
import {
  FAILURE_MODE_LABELS,
  NOT_APPLICABLE_TEXT,
  buildScenarioParams,
  isFailureModeValid,
  resolveStuckPanels,
  validFailureModes,
  type ScenarioFailureMode,
} from '@/lib/scenario/scenarioSpec';
import { AlertTriangle } from 'lucide-react';

const chartConfig: ChartConfig = {
  'long-edge': { label: 'Long-edge', color: 'hsl(210, 100%, 55%)' },
  'double-long-edge': { label: 'Double Long-edge', color: 'hsl(168, 70%, 45%)' },
  'short-edge': { label: 'Short-edge', color: 'hsl(35, 95%, 55%)' },
  'short-edge-long-edge': { label: 'Coupled', color: 'hsl(280, 65%, 55%)' },
};

const COLORS = ['hsl(210, 100%, 55%)', 'hsl(168, 70%, 45%)', 'hsl(35, 95%, 55%)', 'hsl(280, 65%, 55%)'];

type FailureAnomalyType = Exclude<ScenarioFailureMode, 'nominal'>;

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


/** Marker used consistently wherever the active reference configuration is highlighted. */
const ACTIVE_SCENARIO_LABEL = 'Active scenario';

function ActiveScenarioBadge() {
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/30">
      {ACTIVE_SCENARIO_LABEL}
    </span>
  );
}

/**
 * Chart legend covering ALL four configurations: those excluded by the active failure mode stay
 * listed and are labelled not-applicable, so a reader never has to infer why a curve is missing.
 */
function ComparisonLegend({
  referenceConfig,
  failureMode,
}: {
  referenceConfig: ConfigType;
  failureMode: ScenarioFailureMode;
}) {
  return (
    <div className="flex flex-wrap gap-4 mt-2 justify-center">
      {CONFIGURATIONS.map((c, i) => {
        const applicable = isFailureModeValid(c.id, failureMode);
        return (
          <div key={c.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <div
              className="w-3 h-0.5 rounded"
              style={{ backgroundColor: applicable ? COLORS[i] : 'transparent' }}
            />
            <span className={c.id === referenceConfig ? 'text-foreground font-medium' : undefined}>
              {c.shortName}
            </span>
            {c.id === referenceConfig && <ActiveScenarioBadge />}
            {!applicable && (
              <span className="text-[10px] italic">{NOT_APPLICABLE_TEXT}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ComparePage() {
  // Same URL-owned scenario the Simulation page uses. `config` is the ACTIVE REFERENCE
  // configuration here — it is highlighted, never used to filter: this page always compares
  // every configuration that can physically exhibit the active failure mode.
  const { scenario, setScenario, searchParams } = useScenario();
  const { config: referenceConfig, failureMode, delaySeconds } = scenario;
  const activeMaterial = MATERIAL_PRESETS.find(preset => preset.key === scenario.material)!;

  const activeFailureText = failureMode !== 'nominal' ? FAILURE_SCENARIO_TEXT[failureMode] : null;

  /**
   * Configurations that have a physically valid result for the active failure mode. Under
   * `two-adjacent`/`two-opposite` the 2-panel long-edge configuration has no distinct panel pair,
   * so it is excluded from computation entirely and reported as not-applicable rather than being
   * given a substituted mode or a fabricated number.
   */
  const comparedConfigs = useMemo(
    () => CONFIGURATIONS.filter(entry => isFailureModeValid(entry.id, failureMode)),
    [failureMode],
  );
  const comparedIds = useMemo(
    () => comparedConfigs.map(entry => entry.id),
    [comparedConfigs],
  );

  const failureImpactData = useMemo(() => {
    return CONFIGURATIONS.map((config, i) => {
      const applicable = isFailureModeValid(config.id, failureMode);
      // Canonical per-config stuck indices — the same resolver the Simulation page and the
      // report sweep use, so "all-stuck" means every panel of THIS configuration.
      const stuckCount = applicable ? resolveStuckPanels(config.id, failureMode).length : 0;
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
        applicable,
        stuckCount,
        deployedCount,
        coupling,
        successFraction,
        progressBarColor,
      };
    });
  }, [failureMode]);

  // Physics-driven comparison runs for the SELECTED material, computed in an
  // effect (one config per event-loop turn) with a computing badge instead of
  // freezing the page. The `cancelled` flag guarantees a superseded selection
  // (material/δt/anomaly change) can never overwrite newer results with stale
  // ones.
  const [allSimData, setAllSimData] =
    useState<Partial<Record<ConfigType, SimulationFrame[]>> | null>(null);
  const [computing, setComputing] = useState(true);

  const materialKey = scenario.material;

  useEffect(() => {
    let cancelled = false;
    setComputing(true);
    const results: Partial<Record<ConfigType, SimulationFrame[]>> = {};

    (async () => {
      for (const c of comparedIds) {
        // Yield to the event loop before each config so rendering stays live.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (cancelled) return;
        // Sequential burn-wire release: panel i fires at i × δt, per config's panel count.
        // Deployment is physics-driven (calibrated torsional spring-damper hinge from
        // DEFAULT_PARAMS) — the same authoritative dynamics used by the Report sweep, built by
        // the SAME shared params builder from the active scenario.
        // The horizon is a CAP: each run ends once all panels latch (plus the observation
        // window); the slowest 3-stage coupled config completes in ~12 s of simulated time.
        const params = buildScenarioParams({ config: c, material: materialKey, delaySeconds });
        const frames = runFullSimulation(c, params, 90, resolveStuckPanels(c, failureMode));
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
  }, [comparedIds, failureMode, materialKey, delaySeconds]);

  // Merge data for angular velocity chart
  const angVelData = useMemo(() => {
    if (!allSimData) return [];
    const maxLen = Math.max(0, ...comparedIds.map(c => allSimData[c]?.length ?? 0));
    const data: Record<string, number>[] = [];
    for (let i = 0; i < maxLen; i += 2) {
      const point: Record<string, number> = {};
      for (const c of comparedIds) {
        const frame = allSimData[c]?.[i];
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
  }, [allSimData, comparedIds]);

  // τ_avg,detumble over time (N·m) — each raw frame's H(t) divided by the assumed
  // allocation. Values are plotted RAW: they sit around 1e-7 N·m, so any fixed-decimal
  // rounding here would floor the whole series to zero.
  const detumbleTorqueData = useMemo(() => {
    if (!allSimData) return [];
    const maxLen = Math.max(0, ...comparedIds.map(c => allSimData[c]?.length ?? 0));
    const data: Record<string, number>[] = [];
    for (let i = 0; i < maxLen; i += 2) {
      const point: Record<string, number> = {};
      for (const c of comparedIds) {
        const frame = allSimData[c]?.[i];
        if (frame) {
          point.time = frame.time;
          point[c] = frameAverageRequiredDetumblingTorque(frame);
        }
      }
      if (point.time !== undefined) data.push(point);
    }
    return data;
  }, [allSimData, comparedIds]);

  // Peak acceleration bar chart — only configurations the active failure mode applies to.
  const peakAccelData = useMemo(() => {
    return comparedConfigs.map(entry => {
      const frames = allSimData?.[entry.id] ?? [];
      let peakAccel = 0;
      for (const f of frames) {
        const total = Math.sqrt(f.angularAcceleration.x ** 2 + f.angularAcceleration.y ** 2 + f.angularAcceleration.z ** 2);
        peakAccel = Math.max(peakAccel, total);
      }
      return {
        name: entry.shortName,
        value: Number(((peakAccel * 180) / Math.PI).toFixed(2)),
        fill: COLORS[CONFIGURATIONS.indexOf(entry)],
      };
    });
  }, [allSimData, comparedConfigs]);

  // Deployment time
  const deployTimeData = useMemo(() => {
    return comparedConfigs.map(entry => {
      const frames = allSimData?.[entry.id] ?? [];
      const lastFrame = frames[frames.length - 1];
      return {
        name: entry.shortName,
        value: Number((lastFrame?.time || 0).toFixed(2)),
        fill: COLORS[CONFIGURATIONS.indexOf(entry)],
      };
    });
  }, [allSimData, comparedConfigs]);

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader scenario={scenario} active="/compare" searchParams={searchParams} />

      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Configuration Comparison</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Quantitative comparison of deployment dynamics across all 4 configurations —
              computed for ONE selected panel material at a time, under the same δt and failure
              mode. The reference configuration is highlighted as the {ACTIVE_SCENARIO_LABEL}; it
              never removes the other configurations.
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
                  onClick={() => setScenario({ material: preset.key })}
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
            {/* Reference configuration: highlights one configuration as the active scenario and
                travels with it to the Simulation page. It never filters the comparison. */}
            <Select
              value={referenceConfig}
              onValueChange={(value) => setScenario({ config: value as ConfigType })}
            >
              <SelectTrigger className="w-56" aria-label="Active reference configuration">
                <SelectValue placeholder="Reference configuration" />
              </SelectTrigger>
              <SelectContent>
                {CONFIGURATIONS.map(entry => (
                  <SelectItem key={entry.id} value={entry.id}>
                    Reference: {entry.shortName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={failureMode}
              onValueChange={(value) => setScenario({ failureMode: value as ScenarioFailureMode })}
            >
              <SelectTrigger className="w-48" aria-label="Failure mode">
                <SelectValue placeholder="Failure mode" />
              </SelectTrigger>
              <SelectContent>
                {/* Same valid-mode resolver as Simulation and Report — a long-edge reference
                    configuration offers no adjacent/opposite pair. */}
                {validFailureModes(referenceConfig).map(mode => (
                  <SelectItem key={mode} value={mode}>
                    {FAILURE_MODE_LABELS[mode].label}
                  </SelectItem>
                ))}
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
              {failureImpactData.map(({ config, applicable, stuckCount }) => {
                return (
                  <span key={config.id} className="font-mono text-[11px] bg-amber-900/30 text-amber-300/80 px-2 py-1 rounded">
                    {config.shortName}: {applicable ? `${stuckCount} stuck` : NOT_APPLICABLE_TEXT}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Timing-coupling controls (Bugs 3 & 4) */}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-border bg-card px-4 py-3">
          <DelayInput
            delaySeconds={delaySeconds}
            onChange={next => setScenario({ delaySeconds: next })}
            className="space-y-1.5"
          />
          {/* Why δt matters here. The quantisation statement lives in the shared δt control
              (one statement per page — the e2e caption check asserts a single match). */}
          <p className="text-[11px] text-muted-foreground max-w-md">
            δt staggers burn-wire release (panel i fires at i·δt): at δt = 0 the panel-pair
            reactions cancel and the body stays at rest; at δt &gt; 0 the symmetry breaks and the
            body gains angular velocity. Deployment is physics-driven (torsional spring hinge),
            and all configurations are compared under the same δt.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Angular Velocity over time */}
          <Card className="col-span-1 lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm">
                <>
                  Total Angular Velocity (°/s) vs Time
                  {failureMode !== 'nominal' && (
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
                  {/* Only configurations with a valid result for this failure mode get a series;
                      the active reference configuration is drawn heavier. */}
                  {comparedConfigs.map(entry => (
                    <Line
                      key={entry.id}
                      type="monotone"
                      dataKey={entry.id}
                      stroke={COLORS[CONFIGURATIONS.indexOf(entry)]}
                      strokeWidth={entry.id === referenceConfig ? 3.5 : 2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ChartContainer>
              <ComparisonLegend
                referenceConfig={referenceConfig}
                failureMode={failureMode}
              />
            </CardContent>
          </Card>

          {/* τ_avg,detumble over time */}
          <Card className="col-span-1 lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm">τ_avg,detumble (N·m) vs Time</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[300px]">
                <LineChart data={detumbleTorqueData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, style: { fontSize: 11 } }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    width={72}
                    tickFormatter={(v: number) => formatTorqueNm(v, 1)}
                    label={{ value: 'N·m', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, name) => (
                          <div className="flex flex-1 justify-between gap-3 leading-none">
                            <span className="text-muted-foreground">
                              {chartConfig[name as keyof typeof chartConfig]?.label ?? name}
                            </span>
                            <span className="font-mono font-medium tabular-nums text-foreground">
                              {formatTorqueNm(Number(value))} N·m
                            </span>
                          </div>
                        )}
                      />
                    }
                  />
                  {comparedConfigs.map(entry => (
                    <Line
                      key={entry.id}
                      type="monotone"
                      dataKey={entry.id}
                      stroke={COLORS[CONFIGURATIONS.indexOf(entry)]}
                      strokeWidth={entry.id === referenceConfig ? 3 : 1.5}
                      dot={false}
                      strokeDasharray="4 2"
                    />
                  ))}
                </LineChart>
              </ChartContainer>
              <ComparisonLegend
                referenceConfig={referenceConfig}
                failureMode={failureMode}
              />
              <p className="text-[11px] text-muted-foreground mt-3">
                τ_avg,detumble denotes the average required detumbling torque.
                τ_avg,detumble = H_remove,max / {DETUMBLING_TIME_REQUIREMENT_S.toLocaleString()} s.
                Unit: N·m.
              </p>
              <p className="text-[11px] text-muted-foreground mt-2">
                Each point gives the average torque required to remove the body angular momentum
                present at that time within the assumed 5,400 s detumbling allocation. It is not
                an instantaneous simulated actuator torque.
              </p>
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
              <p className="text-[11px] text-muted-foreground">
                τ_avg,detumble here is the per-configuration trajectory maximum: the maximum
                deployment-induced body angular momentum divided by the assumed{' '}
                {DETUMBLING_TIME_REQUIREMENT_S.toLocaleString()} s one-orbit LEO detumbling
                allocation. It is an average ADCS sizing requirement, not a simulated actuator
                torque.
              </p>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 text-muted-foreground font-medium">Config</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">Panels</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">Peak ω (°/s)</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">
                        τ_avg,detumble (N·m)
                      </th>
                      <th className="text-right py-2 text-muted-foreground font-medium">T_settle (s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CONFIGURATIONS.map((c, i) => {
                      const applicable = isFailureModeValid(c.id, failureMode);
                      const isReference = c.id === referenceConfig;
                      // Not-applicable configurations were never simulated for this mode — the
                      // row states that explicitly instead of showing a substituted number.
                      if (!applicable) {
                        return (
                          <tr key={c.id} className="border-b border-border/50" data-testid="compare-summary-row">
                            <td className="py-2 flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                              {c.shortName}
                            </td>
                            <td className="text-right py-2 font-mono">{c.panelCount}</td>
                            <td className="py-2 text-right text-muted-foreground italic" colSpan={3}>
                              {NOT_APPLICABLE_TEXT}
                            </td>
                          </tr>
                        );
                      }
                      const frames = allSimData?.[c.id] ?? [];
                      let peakOmega = 0;
                      for (const f of frames) {
                        const omega = Math.sqrt(f.angularVelocity.x ** 2 + f.angularVelocity.y ** 2 + f.angularVelocity.z ** 2);
                        peakOmega = Math.max(peakOmega, omega);
                      }
                      const tauAvgReq = peakAverageRequiredDetumblingTorque(frames);
                      const lastT = frames[frames.length - 1]?.time || 0;
                      return (
                        <tr
                          key={c.id}
                          data-testid="compare-summary-row"
                          className={`border-b border-border/50 ${isReference ? 'bg-primary/5 text-foreground' : ''}`}
                        >
                          <td className="py-2 flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                            {c.shortName}
                            {isReference && <ActiveScenarioBadge />}
                          </td>
                          <td className="text-right py-2 font-mono">{c.panelCount}</td>
                          <td className="text-right py-2 font-mono">{((peakOmega * 180) / Math.PI).toFixed(2)}</td>
                          <td className="text-right py-2 font-mono">
                            {formatTorqueNm(tauAvgReq)}
                          </td>
                          <td className="text-right py-2 font-mono">{lastT.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {failureMode !== 'nominal' && (
            <Card className="col-span-1 lg:col-span-2">
              <CardHeader>
                <CardTitle>Failure Mode Impact by Configuration</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {activeFailureText}
                </p>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {failureImpactData.map(({ config, color, applicable, stuckCount, deployedCount, coupling, successFraction, progressBarColor }) => {
                    if (!applicable) {
                      return (
                        <div key={config.id} className="bg-muted/40 rounded-lg p-3 space-y-2 text-xs">
                          <div className="flex items-center gap-2 font-semibold">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                            {config.name}
                            {config.id === referenceConfig && <ActiveScenarioBadge />}
                          </div>
                          <p className="text-muted-foreground italic">{NOT_APPLICABLE_TEXT}</p>
                          <p className="text-[11px] text-muted-foreground">
                            This configuration has two panels, so it has no distinct adjacent or
                            opposite pair; no result is computed for it under this failure mode.
                          </p>
                        </div>
                      );
                    }
                    return (
                      <div key={config.id} className="bg-muted/40 rounded-lg p-3 space-y-2 text-xs">
                        <div className="flex items-center gap-2 font-semibold">
                          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                          {config.name}
                          {config.id === referenceConfig && <ActiveScenarioBadge />}
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
