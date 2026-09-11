import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENARIO,
  NOT_APPLICABLE_TEXT,
  TWO_PANEL_TOPOLOGY,
  buildScenarioParams,
  isFailureModeValid,
  materialMasses,
  reconcileScenario,
  resolveStuckPanels,
  validFailureModes,
  type ScenarioFailureMode,
  type ScenarioSpec,
} from '@/lib/scenario/scenarioSpec';
import { applyScenarioToParams, parseScenario, scenarioSearch } from '@/hooks/useScenario';
import { CONFIGURATIONS, DEFAULT_PARAMS, type ConfigType } from '@/lib/physics/types';
import { deriveDelayDisplay, formatDelay } from '@/lib/scenario/delay';

// ─────────────────────────────────────────────────────────────────────────────
//  The canonical scenario vocabulary: one failure-mode type, one valid-mode resolver, one
//  stuck-panel mapping, one params builder. These are the guarantees that let Simulation,
//  Compare, and Report agree about what a given scenario means.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseScenario — URL is the source of truth', () => {
  it('round-trips a complete scenario through the query string', () => {
    const spec: ScenarioSpec = {
      config: 'short-edge',
      material: 'cfrp',
      delaySeconds: 0.005,
      failureMode: 'two-adjacent',
    };

    const restored = parseScenario(new URLSearchParams(scenarioSearch(spec)));

    expect(restored).toEqual(spec);
  });

  it('falls back to documented defaults for absent parameters', () => {
    expect(parseScenario(new URLSearchParams())).toEqual(DEFAULT_SCENARIO);
  });

  it.each([
    ['config', 'config=bogus'],
    ['material', 'material=titanium'],
    ['failure', 'failure=exploded'],
    ['dt (non-numeric)', 'dt=abc'],
    ['dt (negative)', 'dt=-1'],
    ['dt (empty)', 'dt='],
  ])('falls back to the default for an invalid %s parameter', (_label, query) => {
    expect(parseScenario(new URLSearchParams(query))).toEqual(DEFAULT_SCENARIO);
  });

  it('reconciles an invalid config/failure combination to nominal', () => {
    const restored = parseScenario(new URLSearchParams('config=long-edge&failure=two-adjacent'));

    expect(restored.config).toBe('long-edge');
    expect(restored.failureMode).toBe('nominal');
  });

  it('preserves non-scenario parameters when writing a scenario into a URL', () => {
    const current = new URLSearchParams('configs=long-edge,short-edge&failures=all-stuck&dt=0');
    const next = applyScenarioToParams(
      { ...DEFAULT_SCENARIO, config: 'short-edge', delaySeconds: 0.001 },
      current,
    );

    // Report filter parameters survive a scenario write untouched.
    expect(next.get('configs')).toBe('long-edge,short-edge');
    expect(next.get('failures')).toBe('all-stuck');
    // …while the scenario keys are replaced.
    expect(next.get('config')).toBe('short-edge');
    expect(next.get('dt')).toBe('0.001');
  });
});

describe('validFailureModes — the one valid-mode resolver', () => {
  it('offers long-edge only nominal, one-stuck, and all-stuck', () => {
    expect(validFailureModes('long-edge')).toEqual(['nominal', 'one-stuck', 'all-stuck']);
    expect(isFailureModeValid('long-edge', 'two-adjacent')).toBe(false);
    expect(isFailureModeValid('long-edge', 'two-opposite')).toBe(false);
  });

  it.each(['double-long-edge', 'short-edge', 'short-edge-long-edge'] as ConfigType[])(
    'offers %s all five modes',
    (config) => {
      expect(validFailureModes(config)).toEqual([
        'nominal',
        'one-stuck',
        'two-adjacent',
        'two-opposite',
        'all-stuck',
      ]);
    },
  );

  it('never uses "none" as a second nominal identifier', () => {
    for (const config of CONFIGURATIONS) {
      expect(validFailureModes(config.id)).not.toContain('none' as ScenarioFailureMode);
    }
  });
});

describe('resolveStuckPanels — canonical topology for every page', () => {
  it('sticks nothing for nominal', () => {
    for (const config of CONFIGURATIONS) {
      expect(resolveStuckPanels(config.id, 'nominal')).toEqual([]);
    }
  });

  it('sizes all-stuck by the configuration panel count', () => {
    expect(resolveStuckPanels('long-edge', 'all-stuck')).toEqual([0, 1]);
    expect(resolveStuckPanels('short-edge', 'all-stuck')).toEqual([0, 1, 2, 3]);
    // The 8-panel coupled config: the old page-local mapping stopped at index 5.
    expect(resolveStuckPanels('short-edge-long-edge', 'all-stuck')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('defers two-panel modes to the per-config canonical topology', () => {
    for (const [config, topology] of Object.entries(TWO_PANEL_TOPOLOGY)) {
      expect(resolveStuckPanels(config as ConfigType, 'two-adjacent')).toEqual(topology!.adjacent);
      expect(resolveStuckPanels(config as ConfigType, 'two-opposite')).toEqual(topology!.opposite);
    }
    // short-edge specifically disagrees with the old flat [0,1]/[0,2] page-local guess.
    expect(resolveStuckPanels('short-edge', 'two-adjacent')).toEqual([0, 1]);
    expect(resolveStuckPanels('short-edge', 'two-opposite')).toEqual([0, 2]);
  });

  it('throws rather than inventing a long-edge panel pair', () => {
    expect(() => resolveStuckPanels('long-edge', 'two-adjacent')).toThrow(
      /not applicable to configuration long-edge/,
    );
    expect(NOT_APPLICABLE_TEXT).toMatch(/two-panel configuration/);
  });
});

describe('reconcileScenario', () => {
  it('forces an unsupported failure mode to nominal', () => {
    expect(
      reconcileScenario({ ...DEFAULT_SCENARIO, config: 'long-edge', failureMode: 'two-opposite' })
        .failureMode,
    ).toBe('nominal');
  });

  it('leaves a valid scenario untouched (same object identity)', () => {
    const spec: ScenarioSpec = { ...DEFAULT_SCENARIO, config: 'short-edge', failureMode: 'two-opposite' };
    expect(reconcileScenario(spec)).toBe(spec);
  });
});

describe('buildScenarioParams — the one params builder', () => {
  it('derives panel mass from the material preset', () => {
    const params = buildScenarioParams({ config: 'long-edge', material: 'cfrp', delaySeconds: 0 });
    expect(params.panelMass).toBeCloseTo(materialMasses.cfrp, 9);
  });

  it('staggers release as panel i × δt, sized by the configuration panel count', () => {
    const params = buildScenarioParams({
      config: 'short-edge-long-edge',
      material: 'fr4',
      delaySeconds: 0.005,
    });
    expect(params.hinge.panelStartDelays).toEqual([
      0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035,
    ]);
    expect(params.hinge.shortEdgeStartDelays).toEqual([0, 0.005, 0, 0.005]);
  });

  it('changes nothing else about the physics parameters', () => {
    const params = buildScenarioParams({ config: 'long-edge', material: 'fr4', delaySeconds: 0 });
    expect(params.timeStep).toBe(DEFAULT_PARAMS.timeStep);
    expect(params.hinge.springConstant).toBe(DEFAULT_PARAMS.hinge.springConstant);
    expect(params.hinge.dampingCoeff).toBe(DEFAULT_PARAMS.hinge.dampingCoeff);
    expect(params.hinge.stopAngle).toBe(DEFAULT_PARAMS.hinge.stopAngle);
  });

  it('returns a fresh object each call (the engine caches kinematics by params identity)', () => {
    const a = buildScenarioParams({ config: 'long-edge', material: 'fr4', delaySeconds: 0 });
    const b = buildScenarioParams({ config: 'long-edge', material: 'fr4', delaySeconds: 0 });
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('δt display derivation', () => {
  it.each([
    [0, 0, 'ns'],
    [5e-3, 5, 'ms'],
    [250e-6, 250, 'µs'],
    [1e-9, 1, 'ns'],
  ])('renders %s s as %s %s', (seconds, magnitude, unit) => {
    expect(deriveDelayDisplay(seconds)).toEqual({ magnitude, unit });
  });

  it('formats δt for reader-facing text', () => {
    expect(formatDelay(0.005)).toBe('5 ms');
    expect(formatDelay(0)).toBe('0 ns');
  });
});
