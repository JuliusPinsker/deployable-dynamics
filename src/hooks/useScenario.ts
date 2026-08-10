/**
 * Scenario state, owned by the URL.
 *
 * The query string IS the state — there is no duplicate `useState` copy, no provider, and no
 * state-management dependency. That single choice is what makes refresh, copied links, and browser
 * Back/Forward all restore the same scenario: there is nothing living outside the URL that could
 * disagree with it. Router `location.state` is deliberately unused for scenario parameters.
 *
 * URL contract (all optional; absent or invalid values fall back to DEFAULT_SCENARIO):
 *   config    — long-edge | double-long-edge | short-edge | short-edge-long-edge
 *   material  — fr4 | al-kapton | cfrp
 *   dt        — timing discrepancy in SECONDS (e.g. 0.005)
 *   failure   — nominal | one-stuck | two-adjacent | two-opposite | all-stuck
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CONFIGURATIONS, MATERIAL_PRESETS, type ConfigType, type MaterialPresetKey } from '@/lib/physics/types';
import {
  DEFAULT_SCENARIO,
  SCENARIO_FAILURE_MODES,
  reconcileScenario,
  type ScenarioFailureMode,
  type ScenarioSpec,
} from '@/lib/scenario/scenarioSpec';

/** The four URL keys this hook owns. Every other search param is left alone. */
export const SCENARIO_PARAM_KEYS = ['config', 'material', 'dt', 'failure'] as const;

function parseConfig(raw: string | null): ConfigType {
  return CONFIGURATIONS.some(entry => entry.id === raw)
    ? (raw as ConfigType)
    : DEFAULT_SCENARIO.config;
}

function parseMaterial(raw: string | null): MaterialPresetKey {
  return MATERIAL_PRESETS.some(preset => preset.key === raw)
    ? (raw as MaterialPresetKey)
    : DEFAULT_SCENARIO.material;
}

/** δt is a non-negative finite number of seconds; anything else falls back to the default. */
function parseDelaySeconds(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_SCENARIO.delaySeconds;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_SCENARIO.delaySeconds;
  return value;
}

function parseFailureMode(raw: string | null): ScenarioFailureMode {
  return SCENARIO_FAILURE_MODES.includes(raw as ScenarioFailureMode)
    ? (raw as ScenarioFailureMode)
    : DEFAULT_SCENARIO.failureMode;
}

/**
 * Pure URL → ScenarioSpec parse, reconciled so the returned failure mode is always valid for the
 * returned configuration (e.g. `?config=long-edge&failure=two-adjacent` yields `nominal`).
 */
export function parseScenario(search: URLSearchParams): ScenarioSpec {
  return reconcileScenario({
    config: parseConfig(search.get('config')),
    material: parseMaterial(search.get('material')),
    delaySeconds: parseDelaySeconds(search.get('dt')),
    failureMode: parseFailureMode(search.get('failure')),
  });
}

/**
 * Writes a scenario into a copy of `current`, replacing ONLY the four scenario keys and preserving
 * every other parameter. Non-destructive by design: the Report page's filter parameters
 * (configs/failures/materials) must survive a trip through Simulation or Compare and back.
 */
export function applyScenarioToParams(
  spec: ScenarioSpec,
  current?: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(current ?? undefined);
  next.set('config', spec.config);
  next.set('material', spec.material);
  next.set('dt', String(spec.delaySeconds));
  next.set('failure', spec.failureMode);
  return next;
}

/** The query string for a navigation link that carries `spec` and keeps `current`'s other params. */
export function scenarioSearch(spec: ScenarioSpec, current?: URLSearchParams): string {
  return `?${applyScenarioToParams(spec, current).toString()}`;
}

export interface UseScenarioResult {
  /** The active scenario, always internally consistent. */
  scenario: ScenarioSpec;
  /**
   * Patch the scenario. The result is reconciled, so changing `config` to one that cannot exhibit
   * the active failure mode resets that mode to `nominal` automatically.
   */
  setScenario: (patch: Partial<ScenarioSpec>) => void;
  /** Live search params — pass to `scenarioSearch` so links preserve page-specific parameters. */
  searchParams: URLSearchParams;
  /** Replace non-scenario params (e.g. report filters) without disturbing the scenario. */
  setSearchParam: (key: string, value: string | null) => void;
}

export function useScenario(): UseScenarioResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const scenario = useMemo(() => parseScenario(searchParams), [searchParams]);

  // Normalise the URL to the reconciled scenario. Absent parameters are filled in with the
  // documented defaults and an invalid combination (?config=long-edge&failure=two-adjacent) is
  // rewritten to what is actually displayed, so a copied URL can never carry a value the page
  // is not honouring. Replaces rather than pushes, and settles after one write because the
  // canonical form parses back to itself.
  useEffect(() => {
    const canonical = applyScenarioToParams(scenario, searchParams);
    if (canonical.toString() !== searchParams.toString()) {
      setSearchParams(canonical, { replace: true });
    }
  }, [scenario, searchParams, setSearchParams]);

  const setScenario = useCallback(
    (patch: Partial<ScenarioSpec>) => {
      setSearchParams(
        prev => {
          const next = reconcileScenario({ ...parseScenario(prev), ...patch });
          return applyScenarioToParams(next, prev);
        },
        // Scenario tweaks replace rather than push, so a slider nudge does not bury the previous
        // PAGE behind dozens of history entries; Back still returns to the previous page with its
        // own scenario intact, because that page's URL carried it.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setSearchParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          if (value === null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { scenario, setScenario, searchParams, setSearchParam };
}
