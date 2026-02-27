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
import { Play, RotateCcw, Pause } from 'lucide-react';
import ThemeToggle from '@/components/ui/theme-toggle';

export default function SimulationPage() {
  const [searchParams] = useSearchParams();
  const initialConfig = (searchParams.get('config') as ConfigType) || 'long-edge';

  const [config, setConfig] = useState<ConfigType>(initialConfig);
  const [state, setState] = useState<SpacecraftState>(() => createInitialState(config));
  const [speed, setSpeed] = useState(1);
  const [wireframe, setWireframe] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [params] = useState<SimulationParams>(DEFAULT_PARAMS);

  const rafRef = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const configRef = useRef(config);
  configRef.current = config;

  const speedRef = useRef(speed);
  speedRef.current = speed;

  const animate = useCallback(() => {
    const st = stateRef.current;
    if (!st.deploying) return;

    const stepsPerFrame = Math.max(1, Math.round(speedRef.current));
    let newState = st;
    for (let i = 0; i < stepsPerFrame; i++) {
      newState = stepSimulation(newState, configRef.current, params);
    }
    setState(newState);
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
    setState(createInitialState(config));
  }, [config]);

  const handleConfigChange = useCallback((c: ConfigType) => {
    cancelAnimationFrame(rafRef.current);
    setConfig(c);
    setState(createInitialState(c));
  }, []);

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
          />
          <TelemetryOverlay state={state} />

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
        </div>
      </div>
    </div>
  );
}
