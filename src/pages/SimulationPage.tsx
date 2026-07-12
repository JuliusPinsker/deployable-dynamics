import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import CubeSatViewer from '@/components/CubeSatViewer';
import TelemetryOverlay from '@/components/TelemetryOverlay';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  CONFIGURATIONS,
  DEFAULT_PARAMS,
  MATERIAL_PRESETS,
  type ConfigType,
  type SpacecraftState,
  type SimulationParams,
  Quaternion,
} from '@/lib/physics/types';
import { computeEDetumble, createInitialState, stepSimulation } from '@/lib/physics/engine';
import { Play, RotateCcw, Pause, AlertTriangle } from 'lucide-react';
import ThemeToggle from '@/components/ui/theme-toggle';

const UNIT_TO_SECONDS: Record<'ns' | 'µs' | 'ms', number> = {
  ns: 1e-9,
  µs: 1e-6,
  ms: 1e-3,
};

export default function SimulationPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const initialConfig = (searchParams.get('config') as ConfigType) || 'long-edge';
  const navPanelMass = (location.state as { panelMass?: number } | null)?.panelMass
    ?? DEFAULT_PARAMS.panelMass;
  const materialLabel = MATERIAL_PRESETS.find(p => p.panelMass === navPanelMass)?.label ?? 'Custom';

  const [config, setConfig] = useState<ConfigType>(initialConfig);
  const [state, setState] = useState<SpacecraftState>(() =>
    createInitialState(config)
  );
  const [speed, setSpeed] = useState(1);
  const [delayMagnitude, setDelayMagnitude] = useState<number>(0);
  const [delayUnit, setDelayUnit] = useState<'ns' | 'µs' | 'ms'>('µs');
  const [wireframe, setWireframe] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showCoM, setShowCoM] = useState(false);
  const [failureMode, setFailureMode] = useState<
    'nominal' | 'one-stuck' | 'two-opposite' | 'two-adjacent' | 'all-stuck'
  >('nominal');
  const delaySeconds = delayMagnitude * UNIT_TO_SECONDS[delayUnit];
  const delayPresets = [
    { label: 'Ideal (0 ns)', magnitude: 0, unit: 'ns' },
    { label: 'Nominal (250 µs)', magnitude: 250, unit: 'µs' },
    { label: 'Worst-case (5 ms)', magnitude: 5, unit: 'ms' },
  ] as const;
  const params = React.useMemo<SimulationParams>(() => {
    const base: SimulationParams = { ...DEFAULT_PARAMS };
    const panelCount = CONFIGURATIONS.find(c => c.id === config)?.panelCount ?? 2;
    // Sequential burn-wire release: panel i fires at i × δt. Applies to all configs.
    const panelStartDelays = Array.from({ length: panelCount }, (_, i) => i * delaySeconds);
    const shortEdgeStartDelays: [number, number, number, number] = [0, delaySeconds, 0, delaySeconds];
    return {
      ...base,
      panelMass: navPanelMass,
      hinge: {
        ...base.hinge,
        panelStartDelays,
        shortEdgeStartDelays,
      },
    };
  }, [config, delaySeconds, navPanelMass]);

  const rafRef = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const configRef = useRef(config);
  configRef.current = config;

  const speedRef = useRef(speed);
  speedRef.current = speed;

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const animate = useCallback(() => {
    const st = stateRef.current;
    const currentParams = paramsRef.current;

    if (!st.deploying) return;

    // Normal deployment physics loop
    const stepsPerFrame = Math.max(1, Math.round(speedRef.current));
    let newState = st;
    for (let i = 0; i < stepsPerFrame; i++) {
      newState = stepSimulation(newState, configRef.current, currentParams);
    }
    setState(newState);

    rafRef.current = requestAnimationFrame(animate);
  }, [params]);

  const handleDeploy = useCallback(() => {
    setState(s => ({ ...s, deploying: !s.deploying }));
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

  const getStuckIndicesForMode = useCallback(
    (mode: typeof failureMode, cfg: ConfigType): number[] => {
      const panelCount = CONFIGURATIONS.find(c => c.id === cfg)?.panelCount ?? 2;
      switch (mode) {
        case 'one-stuck':
          return [0];
        case 'two-opposite':
          return [0, 1];
        case 'two-adjacent':
          return [0, 2];
        case 'all-stuck':
          return Array.from({ length: panelCount }, (_, i) => i);
        default:
          return [];
      }
    },
    [],
  );

  const applyFailureModeToState = useCallback(
    (baseState: SpacecraftState, mode: typeof failureMode, cfg: ConfigType): SpacecraftState => {
      const indices = getStuckIndicesForMode(mode, cfg);
      if (indices.length === 0) return baseState;
      const panels = baseState.panels.map((p, i) =>
        indices.includes(i)
          ? { ...p, stuck: true, stuckAngle: 0 }
          : p,
      );
      return { ...baseState, panels };
    },
    [getStuckIndicesForMode],
  );

  const handleReset = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const base = createInitialState(config);
    setState(applyFailureModeToState(base, failureMode, config));
  }, [config, failureMode, applyFailureModeToState]);

  const handleConfigChange = useCallback((c: ConfigType) => {
    cancelAnimationFrame(rafRef.current);
    setConfig(c);
    const base = createInitialState(c);
    setState(applyFailureModeToState(base, failureMode, c));
  }, [failureMode, applyFailureModeToState]);

  const handleFailureModeChange = useCallback(
    (mode: typeof failureMode) => {
      cancelAnimationFrame(rafRef.current);
      setFailureMode(mode);
      const base = createInitialState(config);
      setState(applyFailureModeToState(base, mode, config));
    },
    [config, applyFailureModeToState],
  );

  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    if (!state.deploying) return;
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state.deploying, animate]);

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
            showCoM={showCoM}
          />
          <TelemetryOverlay
            state={state}
            eDetumbleMJ={computeEDetumble(
              state.angularVelocity,
              state._bodyQ ?? new Quaternion(),
              params,
            )}
            delayMagnitude={delayMagnitude}
            delayUnit={delayUnit}
            materialLabel={materialLabel}
          />

          {failureMode !== 'nominal' && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold
                backdrop-blur-sm border shadow-lg
                ${failureMode === 'all-stuck'
                  ? 'bg-red-500/20 border-red-500/40 text-red-400'
                  : failureMode === 'two-adjacent'
                  ? 'bg-orange-500/20 border-orange-500/40 text-orange-400'
                  : 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                }`}>
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>
                  {{
                    'one-stuck': '1 Panel Stuck — Asymmetric Inertia',
                    'two-opposite': '2 Panels Stuck — Symmetric Imbalance',
                    'two-adjacent': '2 Adjacent Stuck — CoM Offset',
                    'all-stuck': 'ALL PANELS STUCK — Deployment Aborted',
                  }[failureMode]}
                </span>
                <span className="text-[10px] opacity-70 ml-1">
                  ({getStuckIndicesForMode(failureMode, config).length}/
                  {CONFIGURATIONS.find(c => c.id === config)?.panelCount} panels)
                </span>
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

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Timing Discrepancy</Label>
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
                      onClick={() => {
                        setDelayMagnitude(preset.magnitude);
                        setDelayUnit(preset.unit);
                      }}
                      className="rounded-md border border-border bg-secondary/50 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground hover:bg-secondary"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
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
                <Label className="text-xs text-muted-foreground">Centre of Mass</Label>
                <Switch checked={showCoM} onCheckedChange={setShowCoM} />
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
              <CardTitle className="text-sm">Failure Mode</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(
                [
                  { id: 'nominal', label: 'Nominal', sub: 'All panels free', dot: 'bg-green-500' },
                  { id: 'one-stuck', label: '1 Panel Stuck', sub: 'Asymmetric inertia', dot: 'bg-amber-400' },
                  { id: 'two-opposite', label: '2 Opposite', sub: 'Symmetric torque imbalance', dot: 'bg-amber-500' },
                  { id: 'two-adjacent', label: '2 Adjacent', sub: 'CoM offset + torque bias', dot: 'bg-orange-500' },
                  { id: 'all-stuck', label: 'All Stuck', sub: 'Deployment aborted', dot: 'bg-red-500' },
                ] as const
              ).map(mode => (
                <button
                  key={mode.id}
                  onClick={() => handleFailureModeChange(mode.id)}
                  className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors border ${
                    failureMode === mode.id
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-transparent bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${mode.dot}`} />
                    <span className="font-medium">{mode.label}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 ml-4">{mode.sub}</div>
                </button>
              ))}

              <div className="mt-3 pt-3 border-t border-border space-y-1">
                <p className="text-[10px] text-muted-foreground mb-1.5">
                  Live panel status — click 3D panel to toggle
                </p>
                {state.panels.map((p, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Panel {i + 1}</span>
                    <span className={p.stuck ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                      {p.stuck
                        ? `Stuck @ ${((p.stuckAngle * 180) / Math.PI).toFixed(0)}°`
                        : `${((p.angle * 180) / Math.PI).toFixed(0)}°`}
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
