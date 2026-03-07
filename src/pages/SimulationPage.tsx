import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import CubeSatViewer from '@/components/CubeSatViewer';
import TelemetryOverlay from '@/components/TelemetryOverlay';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CONFIGURATIONS, DEFAULT_PARAMS, type ConfigType, type SpacecraftState, type SimulationParams } from '@/lib/physics/types';
import { createInitialState, stepSimulation } from '@/lib/physics/engine';
import { type ThermalParams, DEFAULT_THERMAL_PARAMS } from '@/lib/physics/thermalModel';
import { Play, RotateCcw, Pause } from 'lucide-react';
import ThemeToggle from '@/components/ui/theme-toggle';

export default function SimulationPage() {
  const [searchParams] = useSearchParams();
  const initialConfig = (searchParams.get('config') as ConfigType) || 'long-edge';

  const [config, setConfig] = useState<ConfigType>(initialConfig);
  const [thermalEnabled, setThermalEnabled] = useState(false);
  const [thermalParams, setThermalParams] = useState<ThermalParams>(DEFAULT_THERMAL_PARAMS);
  const [state, setState] = useState<SpacecraftState>(() => 
    createInitialState(config, thermalEnabled ? thermalParams : undefined)
  );
  const [speed, setSpeed] = useState(1);
  const [ggTorqueMag, setGgTorqueMag] = useState<number | undefined>(undefined);
  const [wireframe, setWireframe] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const params = React.useMemo<SimulationParams>(() => {
    if (thermalEnabled) {
      // Switch to physics-driven spring mode so thermal stiffness
      // changes are physically visible in deployment speed.
      // deployDuration: 0 disables kinematic ease-out and activates
      // the spring-damper branch where applyThermalStiffness is called.
      return {
        ...DEFAULT_PARAMS,
        hinge: {
          ...DEFAULT_PARAMS.hinge,
          deployDuration: 0,
          springConstant: 0.12,
          dampingCoeff: 0.08,
          preloadTorque: 0.015,
        },
      };
    }
    return DEFAULT_PARAMS;
  }, [thermalEnabled]);

  const rafRef = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const configRef = useRef(config);
  configRef.current = config;

  const speedRef = useRef(speed);
  speedRef.current = speed;

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const thermalEnabledRef = useRef(thermalEnabled);
  thermalEnabledRef.current = thermalEnabled;

  const animate = useCallback(() => {
    const st = stateRef.current;
    const currentParams = paramsRef.current;
    
    if (st.deploying) {
      // Normal deployment physics loop
      const stepsPerFrame = Math.max(1, Math.round(speedRef.current));
      let newState = st;
      for (let i = 0; i < stepsPerFrame; i++) {
        newState = stepSimulation(newState, configRef.current, currentParams);
      }
      setState(newState);

      // Compute GG torque for telemetry display
      const MU = 3.986004418e14;
      const R_EARTH = 6.371e6;
      const altM = 400_000;
      const R = R_EARTH + altM;
      const Ixx = (1/12) * 4.0 * (0.3405**2 + 0.1**2);
      const Iyy = (1/12) * 4.0 * (0.1**2 + 0.1**2);
      const Izz = (1/12) * 4.0 * (0.1**2 + 0.3405**2);
      const factor = (3 * MU) / (R**3);
      // Max GG torque at 45° nadir angle: each component max = factor * |ΔI| * 0.5
      const maxGG = factor * Math.max(
        Math.abs(Izz - Iyy),
        Math.abs(Ixx - Izz),
        Math.abs(Iyy - Ixx),
      ) * 0.5;
      setGgTorqueMag(maxGG);
    } else if (thermalEnabledRef.current && st.thermalState && st.thermalParams) {
      // Post-deployment: keep advancing thermal state only
      // so the user can watch the full eclipse/sunlight cycle
      import('@/lib/physics/thermalModel').then(({ stepThermalState }) => {
        const newThermal = stepThermalState(
          st.thermalState!,
          st.thermalParams!,
          currentParams.timeStep
        );
        setState(prev => ({
          ...prev,
          thermalState: newThermal,
          thermalParams: prev.thermalParams,
        }));
      });
    } else {
      return;
    }
    
    rafRef.current = requestAnimationFrame(animate);
  }, [params]);

  const handleDeploy = useCallback(() => {
    if (state.deploying) {
      cancelAnimationFrame(rafRef.current);
      setState(s => ({ ...s, deploying: false }));
    } else {
      setState(s => ({ ...s, deploying: true }));
      rafRef.current = requestAnimationFrame(animate);
    }
  }, [state.deploying, animate]);

  const handleReset = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    setState(createInitialState(config, thermalEnabled ? thermalParams : undefined));
  }, [config, thermalEnabled, thermalParams]);

  const handleConfigChange = useCallback((c: ConfigType) => {
    cancelAnimationFrame(rafRef.current);
    setConfig(c);
    setState(createInitialState(c, thermalEnabled ? thermalParams : undefined));
  }, [thermalEnabled, thermalParams]);

  const handlePanelClick = useCallback((index: number) => {
    setState(s => {
      const panels = [...s.panels];
      panels[index] = {
        ...panels[index],
        stuck: !panels[index].stuck,
        stuckAngle: panels[index].angle,
      };
      return { ...s, panels };
    });
  }, []);

  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Start background thermal animation when enabled
  useEffect(() => {
    if (thermalEnabled && !state.deploying) {
      rafRef.current = requestAnimationFrame(animate);
    }
    return () => {
      if (!state.deploying) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [thermalEnabled, animate]);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <a href="/" className="font-semibold text-lg tracking-tight">
          <span className="text-primary">CubeSat</span> Deploy Sim
        </a>
        <div className="flex items-center gap-4">
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <a href="/" className="hover:text-foreground transition-colors">Overview</a>
            <a href="/simulate" className="text-foreground">Simulation</a>
            <a href="/compare" className="hover:text-foreground transition-colors">Compare</a>
          </nav>
          <ThemeToggle />
        </div>
      </header>

      <div className="flex h-[calc(100vh-53px)]">
        {/* 3D Viewport */}
        <div className="flex-1 relative">
          <CubeSatViewer
            config={config}
            state={state}
            params={params}
            showLabels={showLabels}
            showAxes={showAxes}
            wireframe={wireframe}
            onPanelClick={handlePanelClick}
            thermalEnabled={thermalEnabled}
            thermalState={state.thermalState}
          />
          <TelemetryOverlay state={state} gravityGradientTorqueMag={ggTorqueMag} />

          {thermalEnabled && (
            <div style={{
              position: 'absolute',
              bottom: 16,
              right: 16,
              background: 'rgba(0,0,0,0.75)',
              borderRadius: 8,
              padding: '8px 12px',
              pointerEvents: 'none',
            }}>
              <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Panel Temperature (K)</div>
              <div style={{
                width: 120,
                height: 10,
                borderRadius: 4,
                background: 'linear-gradient(to right, rgb(30,80,200), rgb(40,160,80), rgb(255,80,10))',
                marginBottom: 4,
              }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#ccc' }}>
                <span>170 K</span><span>255 K</span><span>340 K</span>
              </div>
            </div>
          )}

          {/* Deploy controls overlay */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
            <Button onClick={handleDeploy} size="lg" className="gap-2">
              {state.deploying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {state.deploying ? 'Pause' : 'Deploy'}
            </Button>
            <Button onClick={handleReset} variant="outline" size="lg" className="gap-2">
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          </div>
        </div>

        {/* Controls sidebar */}
        <div className="w-80 border-l border-border bg-card overflow-y-auto p-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {CONFIGURATIONS.map(c => (
                <button
                  key={c.id}
                  onClick={() => handleConfigChange(c.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors border ${
                    config === c.id
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-transparent bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  <div className="font-medium">{c.shortName}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{c.panelCount} panels</div>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Speed: {speed}x</Label>
                <Slider
                  value={[speed]}
                  onValueChange={([v]) => setSpeed(v)}
                  min={0.25}
                  max={5}
                  step={0.25}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Wireframe</Label>
                <Switch checked={wireframe} onCheckedChange={setWireframe} />
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Panel Labels</Label>
                <Switch checked={showLabels} onCheckedChange={setShowLabels} />
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Coordinate System</Label>
                <Switch checked={showAxes} onCheckedChange={setShowAxes} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Spacecraft</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xs text-muted-foreground">
                {`Dimensions: ${Math.round(params.bodyWidth * 1000)} × ${Math.round(params.bodyDepth * 1000)} × ${(params.bodyHeight * 1000).toFixed(1)} mm (W × D × H)`}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">Mass: {params.bodyMass} kg</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Failure Modes</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Click any panel in the 3D view to toggle a deployment failure (stuck panel). Stuck panels are highlighted in red.
              </p>
              <div className="mt-2 space-y-1">
                {state.panels.map((p, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span>Panel {i + 1}</span>
                    <span className={p.stuck ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                      {p.stuck ? `Stuck @ ${((p.stuckAngle * 180) / Math.PI).toFixed(0)}°` : `${((p.angle * 180) / Math.PI).toFixed(0)}°`}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center justify-between">
                <span>Thermal Environment</span>
                <Switch
                  checked={thermalEnabled}
                  onCheckedChange={(v) => {
                    setThermalEnabled(v);
                    cancelAnimationFrame(rafRef.current);
                    setState(createInitialState(config, v ? thermalParams : undefined));
                  }}
                />
              </CardTitle>
            </CardHeader>
            {thermalEnabled && (
              <CardContent className="space-y-4">
                {/* Temperature readout */}
                <div className="rounded-md bg-secondary/50 p-3 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Spring Temp</span>
                    <span className="font-mono font-medium">
                      {state.thermalState
                        ? `${state.thermalState.currentTemperatureDeg.toFixed(1)}°C`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Stiffness</span>
                    <span className={`font-mono font-medium ${
                      !state.thermalState
                        ? ''
                        : state.thermalState.stiffnessMultiplier < 0.97
                        ? 'text-yellow-500'
                        : state.thermalState.stiffnessMultiplier > 1.03
                        ? 'text-blue-400'
                        : 'text-green-500'
                    }`}>
                      {state.thermalState
                        ? `${(state.thermalState.stiffnessMultiplier * 100).toFixed(2)}%`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Orbit Phase</span>
                    <span className="font-mono">
                      {state.thermalState
                        ? `${((state.thermalState.orbitPhaseRad / (2 * Math.PI)) * 100).toFixed(1)}%`
                        : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Status</span>
                    <span className={
                      state.thermalState?.isEclipse
                        ? 'text-blue-400 font-medium'
                        : 'text-yellow-400 font-medium'
                    }>
                      {state.thermalState
                        ? (state.thermalState.isEclipse ? '🌑 Eclipse' : '☀️ Sunlit')
                        : '—'}
                    </span>
                  </div>
                </div>

                {/* Orbit altitude slider */}
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    Orbit Altitude: {thermalParams.orbitAltitudeKm} km
                  </Label>
                  <Slider
                    value={[thermalParams.orbitAltitudeKm]}
                    onValueChange={([v]) => setThermalParams(p => ({ ...p, orbitAltitudeKm: v }))}
                    min={200}
                    max={800}
                    step={50}
                  />
                </div>

                {/* Temperature range display */}
                <div className="text-xs text-muted-foreground space-y-1">
                  <div>Eclipse: {thermalParams.eclipseTemperatureDeg}°C</div>
                  <div>Sunlight: {thermalParams.sunlightTemperatureDeg}°C</div>
                  <div className="pt-1 border-t border-border text-[10px] text-muted-foreground/60">
                    Orbit time ×600 accelerated for display.
                    Physics equations unchanged.
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
