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
import { type FlexParams, DEFAULT_FLEX_PARAMS } from '@/lib/physics/flexModel';
import { GM_EARTH, R_EARTH } from '@/lib/physics/orbitalTorques';
import { Play, RotateCcw, Pause } from 'lucide-react';
import ThemeToggle from '@/components/ui/theme-toggle';

export default function SimulationPage() {
  const [searchParams] = useSearchParams();
  const initialConfig = (searchParams.get('config') as ConfigType) || 'long-edge';

  const [config, setConfig] = useState<ConfigType>(initialConfig);
  const [thermalEnabled, setThermalEnabled] = useState(false);
  const [flexEnabled, setFlexEnabled] = useState(false);
  const [gravityGradientEnabled, setGravityGradientEnabled] = useState(true);
  const [thermalParams, setThermalParams] = useState<ThermalParams>(DEFAULT_THERMAL_PARAMS);
  const [state, setState] = useState<SpacecraftState>(() => 
    createInitialState(config, thermalEnabled ? thermalParams : undefined, flexEnabled ? DEFAULT_FLEX_PARAMS : undefined)
  );
  const [speed, setSpeed] = useState(1);
  const [ggTorqueMag, setGgTorqueMag] = useState<number | undefined>(undefined);
  const [wireframe, setWireframe] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const params = React.useMemo<SimulationParams>(() => {
    const base: SimulationParams = thermalEnabled
      ? {
          ...DEFAULT_PARAMS,
          hinge: {
            ...DEFAULT_PARAMS.hinge,
            deployDuration: 0,
            springConstant: 0.12,
            dampingCoeff: 0.08,
            preloadTorque: 0.015,
          },
        }
      : { ...DEFAULT_PARAMS };
    return {
      ...base,
      gravityGradientEnabled,
      ...(flexEnabled ? { flex: DEFAULT_FLEX_PARAMS } : {}),
    };
  }, [thermalEnabled, gravityGradientEnabled, flexEnabled]);

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

      // Compute GG torque for telemetry display (only when toggle is on)
      if (currentParams.gravityGradientEnabled) {
        const altM = currentParams.orbitAltitudeM ?? 400_000;
        const R = R_EARTH + altM;
        const Ixx = (1/12) * currentParams.bodyMass * (currentParams.bodyHeight**2 + currentParams.bodyDepth**2);
        const Iyy = (1/12) * currentParams.bodyMass * (currentParams.bodyWidth**2 + currentParams.bodyDepth**2);
        const Izz = (1/12) * currentParams.bodyMass * (currentParams.bodyWidth**2 + currentParams.bodyHeight**2);
        const factor = (3 * GM_EARTH) / (R**3);
        const maxGG = factor * Math.max(
          Math.abs(Izz - Iyy),
          Math.abs(Ixx - Izz),
          Math.abs(Iyy - Ixx),
        ) * 0.5;
        setGgTorqueMag(maxGG);
      } else {
        setGgTorqueMag(0);
      }
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
    setState(createInitialState(config, thermalEnabled ? thermalParams : undefined, flexEnabled ? DEFAULT_FLEX_PARAMS : undefined));
  }, [config, thermalEnabled, thermalParams, flexEnabled]);

  const handleConfigChange = useCallback((c: ConfigType) => {
    cancelAnimationFrame(rafRef.current);
    setConfig(c);
    setState(createInitialState(c, thermalEnabled ? thermalParams : undefined, flexEnabled ? DEFAULT_FLEX_PARAMS : undefined));
  }, [thermalEnabled, thermalParams, flexEnabled]);

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

              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Gravity Gradient</Label>
                <Switch checked={gravityGradientEnabled} onCheckedChange={setGravityGradientEnabled} />
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Flex Model</Label>
                <Switch
                  checked={flexEnabled}
                  onCheckedChange={(v) => {
                    setFlexEnabled(v);
                    cancelAnimationFrame(rafRef.current);
                    setState(createInitialState(config, thermalEnabled ? thermalParams : undefined, v ? DEFAULT_FLEX_PARAMS : undefined));
                  }}
                />
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

        </div>
      </div>
    </div>
  );
}
