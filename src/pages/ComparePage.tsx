import React, { useState, useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CONFIGURATIONS, DEFAULT_PARAMS, type ConfigType } from '@/lib/physics/types';
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
import ThemeToggle from '@/components/ui/theme-toggle';

const chartConfig: ChartConfig = {
  'long-edge': { label: 'Long-edge', color: 'hsl(210, 100%, 55%)' },
  'double-long-edge': { label: 'Double Long-edge', color: 'hsl(168, 70%, 45%)' },
  'short-edge': { label: 'Short-edge', color: 'hsl(35, 95%, 55%)' },
  'short-edge-long-edge': { label: 'Coupled', color: 'hsl(280, 65%, 55%)' },
};

const COLORS = ['hsl(210, 100%, 55%)', 'hsl(168, 70%, 45%)', 'hsl(35, 95%, 55%)', 'hsl(280, 65%, 55%)'];

export default function ComparePage() {
  const [stuckPanels, setStuckPanels] = useState<number[]>([]);
  const [anomaly, setAnomaly] = useState('none');
  const [betaAngle, setBetaAngle] = useState(0); // degrees, 0 = equatorial

  const stuckConfig = useMemo(() => {
    switch (anomaly) {
      case 'one-stuck': return [0];
      case 'two-opposite': return [0, 1];
      case 'two-adjacent': return [0, 2];
      default: return [];
    }
  }, [anomaly]);

  const allSimData = useMemo(() => {
    const configs: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];
    const results: Record<ConfigType, SimulationFrame[]> = {} as any;
    
    // Physics-driven mode: disable kinematic ramp to enable spring-damper + stop physics
    const physicsParams = {
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        deployDuration: 0, // disables kinematic ramp; enables physics-driven motion
      },
    };
    
    for (const c of configs) {
      results[c] = runFullSimulation(c, physicsParams, 8, stuckConfig);
    }
    return results;
  }, [stuckConfig]);

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
          </div>
          <Select value={anomaly} onValueChange={setAnomaly}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Anomaly scenario" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nominal (no failure)</SelectItem>
              <SelectItem value="one-stuck">One panel stuck</SelectItem>
              <SelectItem value="two-opposite">Two panels (opposite)</SelectItem>
              <SelectItem value="two-adjacent">Two panels (adjacent)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Angular Velocity over time */}
          <Card className="col-span-1 lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm">Total Angular Velocity (°/s) vs Time</CardTitle>
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
                    className="w-36 accent-primary"
                  />
                  <span className="text-xs font-mono w-12 text-right font-semibold">{betaAngle > 0 ? '+' : ''}{betaAngle}°</span>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

                {/* Left: Peak Temperature */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-3">
                    Peak Sunlit Temperature (°C) — β = {betaAngle > 0 ? '+' : ''}{betaAngle}°
                  </p>
                  <ChartContainer config={chartConfig} className="h-[240px]">
                    <BarChart data={thermalComparisonData} margin={{ top: 10, right: 10, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        domain={[-60, 100]}
                        label={{ value: '°C', angle: -90, position: 'insideLeft', offset: 10, style: { fontSize: 11 } }}
                      />
                      <ChartTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="bg-popover border border-border rounded p-2 text-xs shadow">
                              <p className="font-semibold mb-1">{d.name}</p>
                              <p>Peak sunlit: <span className="font-mono font-bold text-orange-400">{d.peakTemp}°C</span></p>
                              <p>Eclipse min: <span className="font-mono">{d.eclipseTemp}°C</span></p>
                              <p>ΔT: <span className="font-mono">{d.peakTemp - d.eclipseTemp}°C</span></p>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="peakTemp" radius={[4, 4, 0, 0]}>
                        {thermalComparisonData.map((entry, index) => (
                          <rect key={index} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ChartContainer>
                  <div className="flex gap-4 mt-2 justify-center flex-wrap">
                    {thermalComparisonData.map((d, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: d.fill }} />
                        <span>{d.name}: <span className="font-mono font-semibold text-foreground">{d.peakTemp}°C</span></span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right: Stiffness degradation */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-3">
                    Spring Stiffness k(T)/k₀ (%) at Peak Temperature
                  </p>
                  <ChartContainer config={chartConfig} className="h-[240px]">
                    <BarChart data={thermalComparisonData} margin={{ top: 10, right: 10, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        domain={[80, 105]}
                        label={{ value: '%', angle: -90, position: 'insideLeft', offset: 10, style: { fontSize: 11 } }}
                      />
                      <ChartTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="bg-popover border border-border rounded p-2 text-xs shadow">
                              <p className="font-semibold mb-1">{d.name}</p>
                              <p>Stiffness: <span className="font-mono font-bold text-blue-400">{d.stiffnessPct}%</span></p>
                              <p className="text-muted-foreground">Degradation: -{100 - d.stiffnessPct}%</p>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="stiffnessPct" radius={[4, 4, 0, 0]}>
                        {thermalComparisonData.map((entry, index) => (
                          <rect key={index} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ChartContainer>
                  <div className="flex gap-4 mt-2 justify-center flex-wrap">
                    {thermalComparisonData.map((d, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: d.fill }} />
                        <span>{d.name}: <span className="font-mono font-semibold text-foreground">{d.stiffnessPct}%</span></span>
                      </div>
                    ))}
                  </div>
                </div>

              </div>

              {/* Insight row */}
              <div className="mt-4 pt-4 border-t border-border grid grid-cols-2 md:grid-cols-4 gap-3">
                {thermalComparisonData.map((d, i) => (
                  <div key={i} className="bg-muted/40 rounded-lg p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-1">{d.name}</div>
                    <div className="text-lg font-bold font-mono" style={{ color: d.fill }}>
                      {d.peakTemp}°C
                    </div>
                    <div className="text-xs text-muted-foreground">
                      k = {d.stiffnessPct}% · ΔT = {d.peakTemp - d.eclipseTemp}°C
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
