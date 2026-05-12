import React, { useState, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { CONFIGURATIONS, DEFAULT_PARAMS, MATERIAL_PRESETS, type ConfigType } from '@/lib/physics/types';
import { runFullSimulation, type SimulationFrame } from '@/lib/physics/engine';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, BarChart, Bar, ResponsiveContainer } from 'recharts';
import {
  initThermalState,
  stepThermalState,
  DEFAULT_THERMAL_PARAMS,
} from '@/lib/physics/thermalModel';
import { DEFAULT_FLEX_PARAMS } from '@/lib/physics/flexModel';
import ThemeToggle from '@/components/ui/theme-toggle';
import { AlertTriangle } from 'lucide-react';

const chartConfig: ChartConfig = {
  'long-edge': { label: 'Long-edge', color: 'hsl(210, 100%, 55%)' },
  'double-long-edge': { label: 'Double Long-edge', color: 'hsl(168, 70%, 45%)' },
  'short-edge': { label: 'Short-edge', color: 'hsl(35, 95%, 55%)' },
  'short-edge-long-edge': { label: 'Coupled', color: 'hsl(280, 65%, 55%)' },
};

const COLORS = ['hsl(210, 100%, 55%)', 'hsl(168, 70%, 45%)', 'hsl(35, 95%, 55%)', 'hsl(280, 65%, 55%)'];

type AnomalyType = 'none' | 'one-stuck' | 'two-opposite' | 'two-adjacent' | 'all-stuck';
type FailureAnomalyType = Exclude<AnomalyType, 'none'>;

const FAILURE_SCENARIO_TEXT: Record<FailureAnomalyType, string> = {
  'one-stuck': 'Panel Failure: 1 panel jammed at 0° — asymmetric inertia disturbance',
  'two-opposite': 'Panel Failure: 2 opposite panels stuck — symmetric torque imbalance',
  'two-adjacent': 'Panel Failure: 2 adjacent panels stuck — net CoM offset + torque bias',
  'all-stuck': 'Catastrophic Failure: All panels locked — deployment aborted, CubeSat remains in tumble state',
};


export default function ComparePage() {
  const location = useLocation();
  const [stuckPanels, setStuckPanels] = useState<number[]>([]);
  const [anomaly, setAnomaly] = useState<AnomalyType>('none');
  const [betaAngle, setBetaAngle] = useState(0); // degrees, 0 = equatorial
  const [flexEnabled, setFlexEnabled] = useState(false);
  const navPanelMass = (location.state as { panelMass?: number } | null)?.panelMass
    ?? DEFAULT_PARAMS.panelMass;
  const activeMaterial = MATERIAL_PRESETS.find(preset => preset.panelMass === navPanelMass)?.label ?? 'Custom';

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

  const allSimData = useMemo(() => {
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    const results: Record<ConfigType, SimulationFrame[]> = {} as any;
    const resolvedStuck = stuckConfig ?? [];
    const resolvedFlex = flexEnabled ?? false;
    const defaultShortEdgeDelays = DEFAULT_PARAMS.hinge.shortEdgeStartDelays ?? [0, 0, 0, 0];
    const delaySeconds = defaultShortEdgeDelays[1] ?? 0;
    
    // Physics-driven mode: disable kinematic ramp to enable spring-damper + stop physics
    const physicsParams = {
      ...DEFAULT_PARAMS,
      panelMass: navPanelMass,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        deployDuration: 0, // disables kinematic ramp; enables physics-driven motion
        panelStartDelays: DEFAULT_PARAMS.hinge.panelStartDelays,
        shortEdgeStartDelays: [0, delaySeconds, 0, delaySeconds],
      },
      ...(resolvedFlex ? { flex: DEFAULT_FLEX_PARAMS } : {}),
    };
    
    for (const c of configs) {
      results[c] = runFullSimulation(c, physicsParams, 8, resolvedStuck);
    }
    return results;
  }, [stuckConfig, flexEnabled, navPanelMass]);

  // Merge data for angular velocity chart
  const angVelData = useMemo(() => {
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
      const frames = allSimData[c];
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

  // Impact force data
  const impactData = useMemo(() => {
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    return configs.map((c, i) => {
      const frames = allSimData[c];
      let peakForce = 0;
      for (const f of frames) {
        peakForce = Math.max(peakForce, f.totalContactForce);
      }
      return {
        name: CONFIGURATIONS[i].shortName,
        value: Number(peakForce.toFixed(1)),
        fill: COLORS[i],
      };
    });
  }, [allSimData]);

  // Deployment time
  const deployTimeData = useMemo(() => {
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    return configs.map((c, i) => {
      const frames = allSimData[c];
      const lastFrame = frames[frames.length - 1];
      return {
        name: CONFIGURATIONS[i].shortName,
        value: Number((lastFrame?.time || 0).toFixed(2)),
        fill: COLORS[i],
      };
    });
  }, [allSimData]);

  // Gravity gradient disturbance torque
  const ggTorqueData = useMemo(() => {
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    return configs.map((c, i) => {
      const frames = allSimData[c];
      let maxGG = 0;
      for (const f of frames) {
        if (f.gravityGradientTorqueMag !== undefined && f.gravityGradientTorqueMag > maxGG) {
          maxGG = f.gravityGradientTorqueMag;
        }
      }
      return {
        name: CONFIGURATIONS[i].shortName,
        value: Number((maxGG * 1e6).toFixed(4)), // convert to µN·m
        fill: COLORS[i],
      };
    });
  }, [allSimData]);

  // Tip deflection data (when flex model is active)
  const tipDeflectionData = useMemo(() => {
    if (!flexEnabled) return null;
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    const maxLen = Math.max(...configs.map(c => allSimData[c].length));
    const data: any[] = [];
    for (let i = 0; i < maxLen; i += 2) {
      const point: any = {};
      for (const c of configs) {
        const frame = allSimData[c][i];
        if (frame && frame.tipDeflectionDeg && frame.tipDeflectionDeg.length > 0) {
          point.time = frame.time;
          // Use max tip deflection across all panels for this config
          const maxTip = Math.max(...frame.tipDeflectionDeg.map(Math.abs));
          point[c] = Number(maxTip.toFixed(4));
        }
      }
      if (point.time !== undefined) data.push(point);
    }
    return data.length > 0 ? data : null;
  }, [allSimData, flexEnabled]);

  // Thermal comparison: radiation-balance model with per-config panel area differentiation
  const thermalComparisonData = useMemo(() => {
    // Physical constants (SI)
    const SOLAR_CONSTANT = 1361;   // W/m² — solar irradiance at 1 AU
    const EARTH_IR = 237;          // W/m² — Earth IR emission
    const ALBEDO = 0.3;            // Earth albedo factor
    const STEFAN = 5.67e-8;        // Stefan-Boltzmann constant

    // Per-configuration physical properties
    // area_m2: total solar panel area in m²
    // mass_kg: panel assembly mass (more panels = more thermal mass)
    const configProps = {
      'long-edge':           { area_m2: 0.006,  mass_kg: 0.08, panelCount: 2 },
      'double-long-edge':    { area_m2: 0.012,  mass_kg: 0.16, panelCount: 4 },
      'short-edge':          { area_m2: 0.002,  mass_kg: 0.04, panelCount: 2 },
      'short-edge-long-edge':{ area_m2: 0.009,  mass_kg: 0.12, panelCount: 3 },
    };

    // GaAs solar cell optical properties (space-grade)
    const alpha_solar = 0.92;   // solar absorptivity
    const epsilon_ir  = 0.85;   // IR emissivity

    // Beta angle effect: eclipse fraction and sunlight factor
    const betaRad = Math.abs(betaAngle) * Math.PI / 180;
    // At beta=0 → eclipseFraction≈0.36 (36% in shadow), at beta=75° → ~0% eclipse
    const eclipseFraction = Math.max(0, 0.36 * Math.cos(betaRad));
    const sunFraction = 1 - eclipseFraction;
    // Effective cosine factor for solar incidence averaged over sunlit arc
    const cosSun = Math.cos(betaRad) * 0.637; // mean cosine over illuminated half-orbit

    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];

    return configs.map((c, i) => {
      const { area_m2, mass_kg } = configProps[c];

      // Radiative equilibrium temperature (sunlit):
      // alpha * G_eff * A = epsilon * sigma * A * T^4
      // G_eff = SOLAR_CONSTANT * cosSun * sunFraction + EARTH_IR * eclipseFraction * 0.5 + ALBEDO * SOLAR_CONSTANT * 0.1
      const G_solar   = SOLAR_CONSTANT * cosSun * sunFraction;
      const G_earthIR = EARTH_IR * eclipseFraction * 0.5;
      const G_albedo  = ALBEDO * SOLAR_CONSTANT * 0.12;
      const G_eff     = alpha_solar * (G_solar + G_albedo) + G_earthIR * epsilon_ir;

      // Equilibrium: G_eff = epsilon * sigma * T^4  →  T = (G_eff / (epsilon * sigma))^0.25
      const T_eq_sunlit_K = Math.pow(G_eff / (epsilon_ir * STEFAN), 0.25);
      const T_eq_sunlit_C = T_eq_sunlit_K - 273.15;

      // Eclipse equilibrium (no solar input, just Earth IR + radiation to deep space)
      const G_eclipse = epsilon_ir * EARTH_IR * 0.5;
      const T_eq_eclipse_K = Math.pow(G_eclipse / (epsilon_ir * STEFAN), 0.25);
      const T_eq_eclipse_C = T_eq_eclipse_K - 273.15;

      // Thermal mass effect: larger panel assemblies lag more → peak is slightly lower
      // Cp_steel ≈ 500 J/(kg·K), orbit period ≈ 5520 s
      const thermalTimeConst = mass_kg * 500 / (epsilon_ir * STEFAN * 4 * T_eq_sunlit_K ** 3 * area_m2);
      const lagFactor = 1 - Math.exp(-2700 / Math.max(thermalTimeConst, 300)); // sunlit arc ~2700 s
      const peakTemp_C = T_eq_eclipse_C + (T_eq_sunlit_C - T_eq_eclipse_C) * lagFactor;

      // Spring stiffness: k(T)/k0 = 1 - alpha_E * (T - T_ref)
      // alpha_E = 3e-4 K^-1, T_ref = 20°C, clamped [0.85, 1.15]
      const ALPHA_E = 3e-4;
      const T_ref = 20;
      const stiffnessRaw = 1.0 - ALPHA_E * (peakTemp_C - T_ref);
      const stiffnessPct = Math.round(Math.min(Math.max(stiffnessRaw, 0.85), 1.15) * 100);

      return {
        name: CONFIGURATIONS[i].shortName,
        peakTemp: Math.round(peakTemp_C),
        stiffnessPct,
        eclipseTemp: Math.round(T_eq_eclipse_C),
        fill: COLORS[i],
      };
    });
  }, [betaAngle]);

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
              Quantitative comparison of deployment dynamics across all 4 configurations
            </p>
            <span className="text-sm text-muted-foreground">Material: {activeMaterial}</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Flex Model</Label>
              <Switch checked={flexEnabled} onCheckedChange={setFlexEnabled} />
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Tip Deflection chart (only when flex model active) */}
          {flexEnabled && tipDeflectionData && (
            <Card className="col-span-1 lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm">Panel Tip Deflection (°) vs Time</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Craig-Bampton modal flex model — max tip deflection across all panels per config
                </p>
              </CardHeader>
              <CardContent>
                <ChartContainer config={chartConfig} className="h-[300px]">
                  <LineChart data={tipDeflectionData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="time" tick={{ fontSize: 11 }} label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, style: { fontSize: 11 } }} />
                    <YAxis tick={{ fontSize: 11 }} label={{ value: '°', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} />
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
          )}

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

          {/* Impact Force */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Peak Contact Force at Stop (N)</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[250px]">
                <BarChart data={impactData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Deployment Time */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Deployment Time (s)</CardTitle>
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

          {/* Gravity Gradient Disturbance Torque */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Peak Gravity Gradient Disturbance (µN·m)</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                τ_gg = (3μ/R³)(I_z − I_y)r̂_y·r̂_z — varies by config inertia distribution
              </p>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[250px]">
                <BarChart data={ggTorqueData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} label={{ value: 'µN·m', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} />
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
                      <th className="text-right py-2 text-muted-foreground font-medium">Peak F (N)</th>
                      <th className="text-right py-2 text-muted-foreground font-medium">T_deploy (s)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CONFIGURATIONS.map((c, i) => {
                      const frames = allSimData[c.id];
                      let peakOmega = 0, peakForce = 0;
                      for (const f of frames) {
                        const omega = Math.sqrt(f.angularVelocity.x ** 2 + f.angularVelocity.y ** 2 + f.angularVelocity.z ** 2);
                        peakOmega = Math.max(peakOmega, omega);
                        peakForce = Math.max(peakForce, f.totalContactForce);
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
                          <td className="text-right py-2 font-mono">{peakForce.toFixed(1)}</td>
                          <td className="text-right py-2 font-mono">{lastT.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Thermal Environment Impact */}
          <Card className="col-span-1 lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="text-sm font-semibold">
                    Thermal Environment Impact on Deployment Spring Stiffness
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">
                    Radiative equilibrium model — GaAs panels, 400 km LEO orbit (α=0.92, ε=0.85)
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">Solar Beta Angle:</span>
                  <input
                    type="range"
                    min={-75}
                    max={75}
                    step={5}
                    value={betaAngle}
                    onChange={e => setBetaAngle(Number(e.target.value))}
                    className="w-36"
                  />
                  <span className="text-xs font-mono w-12 text-right">{betaAngle}°</span>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[250px]">
                <BarChart data={thermalComparisonData} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis type="number" tick={{ fontSize: 11 }} label={{ value: 'Peak Panel Temp (°C) / Stiffness Change (%)', position: 'insideBottom', offset: -5, style: { fontSize: 11 } }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={60} />
                  <ChartTooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div className="p-2 text-xs bg-background/90 border rounded-md shadow-lg">
                            <p className="font-bold">{data.name}</p>
                            <p>Peak Temp: {data.peakTemp}°C</p>
                            <p>Eclipse Temp: {data.eclipseTemp}°C</p>
                            <p>Stiffness: {data.stiffnessPct}%</p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar dataKey="peakTemp" name="Peak Temp (°C)" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="stiffnessPct" name="Stiffness (%)" fillOpacity={0.5} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ChartContainer>
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
