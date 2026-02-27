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
        </div>
      </div>
    </div>
  );
}
