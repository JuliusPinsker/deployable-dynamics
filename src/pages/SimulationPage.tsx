import React, { useState, useCallback, useRef, useEffect } from 'react';
import CubeSatViewer from '@/components/CubeSatViewer';
import TelemetryOverlay from '@/components/TelemetryOverlay';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  CONFIGURATIONS,
  MATERIAL_PRESETS,
  type ConfigType,
  type MaterialPresetKey,
  type SpacecraftState,
  type SimulationParams,
  Quaternion,
  Vector3,
} from '@/lib/physics/types';
import {
  computeAverageRequiredDetumblingTorque,
  computeDetumbleAngularMomentum,
  computeSystemCoM,
  createInitialState,
  stepSimulation,
  accumulateOmegaPeak,
  EMPTY_OMEGA_PEAK,
  type OmegaPeak,
} from '@/lib/physics/engine';
import { Play, RotateCcw, Pause, AlertTriangle } from 'lucide-react';
import SiteHeader from '@/components/SiteHeader';
import DelayInput from '@/components/DelayInput';
import { useScenario } from '@/hooks/useScenario';
import {
  FAILURE_MODE_LABELS,
  buildScenarioParams,
  resolveStuckPanels,
  validFailureModes,
  type ScenarioFailureMode,
} from '@/lib/scenario/scenarioSpec';
import { deriveDelayDisplay } from '@/lib/scenario/delay';

// Per-mode banner accent, keyed by the shared failure-mode vocabulary.
const FAILURE_BANNER_TONE: Record<Exclude<ScenarioFailureMode, 'nominal'>, string> = {
  'one-stuck': 'bg-amber-500/20 border-amber-500/40 text-amber-400',
  'two-opposite': 'bg-amber-500/20 border-amber-500/40 text-amber-400',
  'two-adjacent': 'bg-orange-500/20 border-orange-500/40 text-orange-400',
  'all-stuck': 'bg-red-500/20 border-red-500/40 text-red-400',
};

const FAILURE_BANNER_TEXT: Record<Exclude<ScenarioFailureMode, 'nominal'>, string> = {
  'one-stuck': '1 Panel Stuck — Asymmetric Inertia',
  'two-opposite': '2 Panels Stuck — Symmetric Imbalance',
  'two-adjacent': '2 Adjacent Stuck — Asymmetric release',
  'all-stuck': 'ALL PANELS STUCK — Deployment Aborted',
};

// Failure-mode dot colour for the picker, keyed by the shared vocabulary.
const FAILURE_MODE_DOTS: Record<ScenarioFailureMode, string> = {
  nominal: 'bg-green-500',
  'one-stuck': 'bg-amber-400',
  'two-adjacent': 'bg-orange-500',
  'two-opposite': 'bg-amber-500',
  'all-stuck': 'bg-red-500',
};

// Initial-tumble ω₀ presets (deg/s), applied about body Z so |ω₀| equals the labelled rate.
// Grounded in published CubeSat post-separation / deployment-induced body rates:
//  - Typical tip-off 10°/s and worst-case 200°/s (SwissCube's flown post-separation rate):
//      Yadav & Goyal, "Investigation of Instabilities in Detumbling Algorithms" (BITS Pilani / IEEE 2020)
//  - Elevated 30°/s: mid-range of asymmetric / stuck-panel body rates (14–50°/s):
//      Peters, "Dynamic Instabilities Imparted by CubeSat Deployable Solar Panels" (MIT thesis)
const TUMBLE_PRESETS = [
  { label: 'At rest', sub: '0°/s (default)', rate: 0 },
  { label: 'Typical', sub: '10°/s tip-off', rate: 10 },
  { label: 'Elevated', sub: '30°/s deploy-induced', rate: 30 },
  { label: 'Worst case', sub: '200°/s (SwissCube)', rate: 200 },
] as const;

/** Convert a {x,y,z} tumble vector in °/s to a rad/s Vector3 for the engine boundary. */
function degToRadVec(d: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(d.x, d.y, d.z).multiplyScalar(Math.PI / 180);
}

export default function SimulationPage() {
  // The active scenario lives in the URL — config, material, δt, and failure mode all survive
  // refresh, copied links, browser Back, and navigation to Compare/Report and back.
  const { scenario, setScenario, searchParams } = useScenario();
  const { config, failureMode, delaySeconds, material: materialKey } = scenario;
  const activeMaterial = MATERIAL_PRESETS.find(p => p.key === materialKey)!;

  const [state, setState] = useState<SpacecraftState>(() =>
    createInitialState(config)
  );
  const [speed, setSpeed] = useState(1);
  const [wireframe, setWireframe] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showCoM, setShowCoM] = useState(false);
  // Initial body tumble ω₀ in °/s (UI unit). Converted to rad/s at the engine boundary.
  const [tumbleDeg, setTumbleDeg] = useState<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });
  const [advancedTumbleOpen, setAdvancedTumbleOpen] = useState(false);
  const delayDisplay = deriveDelayDisplay(delaySeconds);
  // A fresh params object per (material, δt, config) from the ONE shared builder — the same
  // inputs Compare and the Report sweep derive from this scenario. The engine caches per-params
  // kinematics by object identity, so this memo must hold and the result must never be mutated.
  const params = React.useMemo<SimulationParams>(
    () => buildScenarioParams({ config, material: materialKey, delaySeconds }),
    [config, materialKey, delaySeconds],
  );

  const rafRef = useRef<number>(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Peak of the internal detumbling intermediate for the current run (same accumulator
  // reportData.ts uses); the overlay divides it to show the required torque. The live value
  // decays to ~0 during the post-deployment coast, so holding the peak keeps the demo panel
  // from looking like the reading "reset" to zero.
  const peakRef = useRef<OmegaPeak>(EMPTY_OMEGA_PEAK);

  // Peak total contact torque reached so far this run (N·m), maximised across physics
  // substeps — a mechanical-stop impact can last only a few 1/1200 s substeps within
  // one rendered frame, so reading contactTorque off the last substep alone misses it.
  const contactPeakRef = useRef(0);

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

    // Rendering is decoupled from physics: each display frame advances
    // speed × (1/60) s of simulation time as N fixed physics substeps of
    // params.timeStep (1/1200 s → exactly 20 substeps per frame at 1×).
    // Browser frame rate never changes the dynamics or the δt resolution.
    const stepsPerFrame = Math.max(
      1,
      Math.round((speedRef.current / 60) / currentParams.timeStep),
    );
    let newState = st;
    for (let i = 0; i < stepsPerFrame; i++) {
      newState = stepSimulation(newState, configRef.current, currentParams);
      // Track the peaks across every substep (a peak can fall between displayed frames).
      const omegaRad = newState.angularVelocity.length();
      const hInst = computeDetumbleAngularMomentum(
        newState.angularVelocity,
        newState._bodyQ ?? new Quaternion(),
        currentParams,
      );
      peakRef.current = accumulateOmegaPeak(peakRef.current, omegaRad, hInst);
      const substepContact = Math.max(...newState.panels.map(p => p.contactTorque), 0);
      contactPeakRef.current = Math.max(contactPeakRef.current, substepContact);
    }
    // The composite CoM is a rendering concern (viewer rotates about it) —
    // compute it once per DISPLAYED frame, not per physics substep.
    const { comBody } = computeSystemCoM(newState, configRef.current, currentParams);
    setState({ ...newState, comBody });

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

  const applyFailureModeToState = useCallback(
    (baseState: SpacecraftState, mode: ScenarioFailureMode, cfg: ConfigType): SpacecraftState => {
      // Canonical per-config topology (shared with Compare and the Report sweep) — not a
      // page-local guess at which panel indices a mode refers to.
      const indices = resolveStuckPanels(cfg, mode);
      if (indices.length === 0) return baseState;
      const panels = baseState.panels.map((p, i) =>
        indices.includes(i)
          ? { ...p, stuck: true, stuckAngle: 0 }
          : p,
      );
      return { ...baseState, panels };
    },
    [],
  );

  // Single reseed path for EVERY scenario change (Reset, config, failure mode, ω₀).
  // Takes explicit NEXT values — React state updates are async, so handlers must never
  // rebuild state from a just-set config/failureMode/tumbleDeg. Guarantees, in order:
  // cancel any active frame loop, clear run-specific peak telemetry, then build exactly
  // one fresh state (deploying=false → paused, time=0, panels folded, failure mode
  // re-applied as stuck-at-0) so Deploy can immediately start a clean run.
  const resetSimulation = useCallback(
    (
      nextConfig: ConfigType,
      nextFailureMode: ScenarioFailureMode,
      nextTumbleDeg: { x: number; y: number; z: number },
    ) => {
      cancelAnimationFrame(rafRef.current);
      peakRef.current = EMPTY_OMEGA_PEAK;
      contactPeakRef.current = 0;
      const base = createInitialState(nextConfig, degToRadVec(nextTumbleDeg));
      setState(applyFailureModeToState(base, nextFailureMode, nextConfig));
    },
    [applyFailureModeToState],
  );

  const handleReset = useCallback(() => {
    resetSimulation(config, failureMode, tumbleDeg);
  }, [config, failureMode, tumbleDeg, resetSimulation]);

  const handleConfigChange = useCallback((c: ConfigType) => {
    // A configuration change can invalidate the active failure mode (long-edge has no
    // adjacent/opposite pair) — reconcile to nominal and reseed with the SAME resolved mode
    // the URL will carry, so the visible state and the URL can never disagree.
    const nextFailureMode: ScenarioFailureMode =
      validFailureModes(c).includes(failureMode) ? failureMode : 'nominal';
    setScenario({ config: c, failureMode: nextFailureMode });
    resetSimulation(c, nextFailureMode, tumbleDeg);
  }, [failureMode, tumbleDeg, resetSimulation, setScenario]);

  const handleMaterialChange = useCallback((key: MaterialPresetKey) => {
    setScenario({ material: key });
    // New panel mass ⇒ new inertia/CoM inputs. Any in-progress or completed
    // trajectory from the previous material is invalid — full reset so stale
    // results can never remain displayed under the new material.
    resetSimulation(config, failureMode, tumbleDeg);
  }, [config, failureMode, tumbleDeg, resetSimulation, setScenario]);

  const handleFailureModeChange = useCallback(
    (mode: ScenarioFailureMode) => {
      setScenario({ failureMode: mode });
      resetSimulation(config, mode, tumbleDeg);
    },
    [config, tumbleDeg, resetSimulation, setScenario],
  );

  const handleTumbleChange = useCallback(
    (next: { x: number; y: number; z: number }) => {
      setTumbleDeg(next);
      resetSimulation(config, failureMode, next);
    },
    [config, failureMode, resetSimulation],
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
      <SiteHeader scenario={scenario} active="/simulate" searchParams={searchParams} />

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
            detumblingTorqueNm={computeAverageRequiredDetumblingTorque(
              computeDetumbleAngularMomentum(
                state.angularVelocity,
                state._bodyQ ?? new Quaternion(),
                params,
              ),
            )}
            peakDetumblingTorqueNm={computeAverageRequiredDetumblingTorque(
              peakRef.current.peakDetumbleAngularMomentum,
            )}
            peakContactTorqueNm={contactPeakRef.current}
            delayMagnitude={delayDisplay.magnitude}
            delayUnit={delayDisplay.unit}
            materialLabel={`${activeMaterial.label} (${activeMaterial.massGrams} g)`}
          />

          {failureMode !== 'nominal' && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold
                backdrop-blur-sm border shadow-lg ${FAILURE_BANNER_TONE[failureMode]}`}>
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>{FAILURE_BANNER_TEXT[failureMode]}</span>
                <span className="text-[10px] opacity-70 ml-1">
                  ({resolveStuckPanels(config, failureMode).length}/
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
              <CardTitle className="text-sm">Panel Material</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {MATERIAL_PRESETS.map(preset => (
                <button
                  key={preset.key}
                  type="button"
                  role="radio"
                  aria-checked={materialKey === preset.key}
                  onClick={() => handleMaterialChange(preset.key)}
                  className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors border ${
                    materialKey === preset.key
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-transparent bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{preset.label}</span>
                    <span className="text-[11px] font-mono text-muted-foreground">{preset.massGrams} g</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{preset.description}</div>
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

              <DelayInput
                delaySeconds={delaySeconds}
                onChange={next => setScenario({ delaySeconds: next })}
              />

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
              <div className="mt-2 text-xs text-muted-foreground">Body mass: {params.bodyMass} kg</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Panel: {activeMaterial.label} — {(params.panelMass * 1000).toFixed(0)} g each
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Failure Mode</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {/* Only the modes this configuration can physically exhibit — long-edge has two
                  panels, so it offers no adjacent/opposite pair anywhere in the application. */}
              {validFailureModes(config).map(mode => (
                <button
                  key={mode}
                  onClick={() => handleFailureModeChange(mode)}
                  className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors border ${
                    failureMode === mode
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-transparent bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${FAILURE_MODE_DOTS[mode]}`} />
                    <span className="font-medium">{FAILURE_MODE_LABELS[mode].label}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 ml-4">
                    {FAILURE_MODE_LABELS[mode].sub}
                  </div>
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

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Initial Tumble (ω₀)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-[10px] text-muted-foreground">
                Body angular rate at t=0, applied about Z.
              </p>
              <div className="space-y-1.5">
                {TUMBLE_PRESETS.map(preset => {
                  const active =
                    tumbleDeg.x === 0 && tumbleDeg.y === 0 && tumbleDeg.z === preset.rate;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => handleTumbleChange({ x: 0, y: 0, z: preset.rate })}
                      className={`w-full text-left px-3 py-2 rounded-md text-xs transition-colors border ${
                        active
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-transparent bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary'
                      }`}
                    >
                      <span className="font-medium">{preset.label}</span>
                      <div className="text-[10px] text-muted-foreground mt-0.5">{preset.sub}</div>
                    </button>
                  );
                })}
              </div>

              <div className="pt-1 border-t border-border">
                <button
                  type="button"
                  onClick={() => setAdvancedTumbleOpen(o => !o)}
                  className="mt-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {advancedTumbleOpen ? '▾' : '▸'} Advanced (manual ωx / ωy / ωz)
                </button>
                {advancedTumbleOpen && (
                  <div className="mt-2 space-y-2">
                    {(['x', 'y', 'z'] as const).map(axis => (
                      <div key={axis} className="flex items-center justify-between gap-2">
                        <Label className="text-xs text-muted-foreground">ω{axis}</Label>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            step={1}
                            value={tumbleDeg[axis]}
                            onChange={e => {
                              const v = Number(e.target.value);
                              handleTumbleChange({
                                ...tumbleDeg,
                                [axis]: Number.isFinite(v) ? v : 0,
                              });
                            }}
                            className="w-24 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                          />
                          <span className="text-[10px] text-muted-foreground">°/s</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
