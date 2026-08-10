/**
 * The canonical scenario vocabulary shared by the Simulation, Compare, and Report pages.
 *
 * Before this module each page carried its own failure-mode union ('nominal' vs 'none'), its own
 * stuck-panel switch, and its own params builder — three descriptions of the same physical scenario
 * that disagreed with one another and with the report's canonical topology. Everything scientific
 * about a scenario now lives here, so a given ScenarioSpec maps to exactly one set of simulation
 * inputs no matter which page asks.
 *
 * This module owns TWO_PANEL_TOPOLOGY / CONFIG_FAILURE_MODES / resolveReportStuckPanels (moved from
 * reportData.ts, which re-exports them). The dependency runs scenario → physics only; reportData
 * imports from here, never the reverse.
 */

import {
  CONFIGURATIONS,
  DEFAULT_PARAMS,
  MATERIAL_PRESETS,
  type ConfigType,
  type FailureModeKey,
  type MaterialPresetKey,
  type SimulationParams,
} from '@/lib/physics/types';

/**
 * The one failure-mode type. `nominal` is the single identifier for "no failure" — the former
 * ComparePage spelling `none` does not exist anywhere in shared code.
 */
export type ScenarioFailureMode = 'nominal' | FailureModeKey;

/** Every failure mode, in the display order used by all three pages. */
export const SCENARIO_FAILURE_MODES: ScenarioFailureMode[] = [
  'nominal',
  'one-stuck',
  'two-adjacent',
  'two-opposite',
  'all-stuck',
];

/** The complete description of an interactive scenario. The URL is its persistent form. */
export interface ScenarioSpec {
  /** Selected panel configuration. */
  config: ConfigType;
  /** Selected material preset. */
  material: MaterialPresetKey;
  /** Timing discrepancy δt in seconds (canonical unit; the UI converts ns/µs/ms to this). */
  delaySeconds: number;
  /** Failure mode; always valid for `config` (see reconcileScenario). */
  failureMode: ScenarioFailureMode;
}

/** Documented fallbacks for absent or invalid URL parameters. */
export const DEFAULT_SCENARIO: ScenarioSpec = {
  config: 'long-edge',
  material: 'fr4',
  delaySeconds: 0,
  failureMode: 'nominal',
};

/** Shared display labels — identical wording on Simulation, Compare, and Report. */
export const FAILURE_MODE_LABELS: Record<ScenarioFailureMode, { label: string; sub: string }> = {
  nominal: { label: 'Nominal', sub: 'All panels free' },
  'one-stuck': { label: '1 Panel Stuck', sub: 'Asymmetric inertia' },
  'two-adjacent': { label: '2 Adjacent', sub: 'CoM offset + torque bias' },
  'two-opposite': { label: '2 Opposite', sub: 'Symmetric torque imbalance' },
  'all-stuck': { label: 'All Stuck', sub: 'Deployment aborted' },
};

/**
 * Reader-facing failure-mode names for the report's tables, filters, and PDF export. Kept here
 * alongside FAILURE_MODE_LABELS so every spelling of a mode has one home, but deliberately
 * distinct from the interactive pickers: the report spells out the "-stuck" suffix.
 */
export const FAILURE_MODE_REPORT_LABELS: Record<FailureModeKey, string> = {
  'one-stuck': 'one-stuck',
  'two-adjacent': 'two-adjacent-stuck',
  'two-opposite': 'two-opposite-stuck',
  'all-stuck': 'all-stuck',
};

/** Shown wherever a configuration has no physically valid result for the active failure mode. */
export const NOT_APPLICABLE_TEXT = 'Not applicable — two-panel topology';

/**
 * The report evaluates a 42-scenario failure-mode sweep across four panel configurations
 * and three material presets. The number of valid failure cases depends on the number and
 * arrangement of panels in each configuration. The long-edge configuration contains two
 * panels; therefore, it has no separate adjacent-pair and opposite-pair failure cases — the
 * only panel pair that exists ([0,1]) is inherently the opposite pair, so `two-adjacent` and
 * `two-opposite` are never generated for it. (2 modes × 3 materials) + (4 modes × 3 configs
 * × 3 materials) = 6 + 36 = 42 rows.
 */
export const CONFIG_FAILURE_MODES: Record<ConfigType, FailureModeKey[]> = {
  'long-edge': ['one-stuck', 'all-stuck'],
  'double-long-edge': ['one-stuck', 'two-adjacent', 'two-opposite', 'all-stuck'],
  'short-edge': ['one-stuck', 'two-adjacent', 'two-opposite', 'all-stuck'],
  'short-edge-long-edge': ['one-stuck', 'two-adjacent', 'two-opposite', 'all-stuck'],
};

/**
 * For configurations with multiple geometrically non-equivalent panel locations, each
 * one-panel-stuck and two-panel-stuck mode represents a defined canonical panel selection.
 * In the coupled configuration, the two-panel failure cases are applied to the unchanged
 * long-edge sub-chain, panels 0-3. The short-edge subassembly is included in the
 * all-panels-stuck case. (Not present for `long-edge` — see CONFIG_FAILURE_MODES above.)
 */
export const TWO_PANEL_TOPOLOGY: Partial<Record<ConfigType, { adjacent: number[]; opposite: number[] }>> = {
  // double-long-edge: panel 0 (+Y stage-1 root) and panel 1 (-Y stage-1 root) are the
  // mirrored ±Y pair — opposite. Panel 2 is panel 0's folded stage-2 child, same +Y side — adjacent.
  'double-long-edge': { opposite: [0, 1], adjacent: [0, 2] },
  // short-edge: panels 0/1 (SE_Top_PosY/SE_Top_NegY) share the top deck — adjacent.
  // Panels 0/2 (SE_Top_PosY/SE_Bot_PosY) share the +Y edge across top/bottom decks — opposite.
  'short-edge': { opposite: [0, 2], adjacent: [0, 1] },
  // short-edge-long-edge (coupled): panels 0-3 are the unchanged double-long-edge chain
  // (see panelLayouts.ts) — reuse that config's own derived pair rather than a new one.
  'short-edge-long-edge': { opposite: [0, 1], adjacent: [0, 2] },
};

/**
 * Resolves the canonical stuck-panel indices for a (config, failureMode) pair.
 *
 * Invalid-mode guard: `two-adjacent`/`two-opposite` throw for any configuration with no
 * entry in TWO_PANEL_TOPOLOGY (i.e. `long-edge`) rather than returning an empty array,
 * `[0,1]`, or any other fallback — there is no physically valid pair to invent. This is a
 * defensive guard only: `reportCombos` (via CONFIG_FAILURE_MODES) is the mechanism that
 * actually prevents these invalid combinations from ever being generated.
 */
export function resolveReportStuckPanels(config: ConfigType, failureMode: FailureModeKey): number[] {
  const panelCount = CONFIGURATIONS.find(entry => entry.id === config)?.panelCount ?? 0;

  if (failureMode === 'one-stuck') return [0];
  if (failureMode === 'all-stuck') return Array.from({ length: panelCount }, (_, index) => index);

  const topology = TWO_PANEL_TOPOLOGY[config];
  if (!topology) {
    throw new Error(`Failure mode ${failureMode} is not applicable to configuration ${config}.`);
  }
  return failureMode === 'two-adjacent' ? topology.adjacent : topology.opposite;
}

/**
 * The failure modes a configuration can physically exhibit, `nominal` first. This is THE
 * valid-mode resolver — Simulation, Compare, and Report all build their pickers from it, so
 * long-edge never offers a two-panel mode anywhere.
 */
export function validFailureModes(config: ConfigType): ScenarioFailureMode[] {
  return ['nominal', ...(CONFIG_FAILURE_MODES[config] ?? [])];
}

/** Whether `mode` is physically meaningful for `config`. */
export function isFailureModeValid(config: ConfigType, mode: ScenarioFailureMode): boolean {
  return validFailureModes(config).includes(mode);
}

/**
 * The stuck-panel indices for a scenario — `nominal` sticks nothing, every other mode defers to
 * the canonical report topology. The single mapping used by live simulation, the comparison
 * sweep, and the report sweep alike.
 */
export function resolveStuckPanels(config: ConfigType, mode: ScenarioFailureMode): number[] {
  if (mode === 'nominal') return [];
  return resolveReportStuckPanels(config, mode);
}

/** Panel mass (kg) per material preset. */
export const materialMasses: Record<MaterialPresetKey, number> = MATERIAL_PRESETS.reduce(
  (acc, preset) => {
    acc[preset.key] = preset.panelMass;
    return acc;
  },
  {} as Record<MaterialPresetKey, number>,
);

/**
 * The one params builder. Material panel mass and the δt-derived sequential burn-wire release are
 * the only per-scenario overrides; every other physical parameter comes from DEFAULT_PARAMS.
 *
 * Sequential release: panel i fires at i × δt, for all configurations. `shortEdgeStartDelays` is
 * kept in step with δt for the legacy short-edge path, though `panelStartDelays` takes precedence
 * inside the engine whenever it is defined (see engine.ts).
 *
 * Returns a FRESH object every call — the engine caches per-params kinematics by object identity,
 * so callers must memoise this rather than rebuild it per render, and must never mutate the result.
 */
export function buildScenarioParams(
  spec: Pick<ScenarioSpec, 'config' | 'material' | 'delaySeconds'>,
): SimulationParams {
  const { config, material, delaySeconds } = spec;
  const panelCount = CONFIGURATIONS.find(entry => entry.id === config)?.panelCount ?? 2;
  const panelStartDelays = Array.from({ length: panelCount }, (_, i) => i * delaySeconds);
  const shortEdgeStartDelays: [number, number, number, number] = [
    0,
    delaySeconds,
    0,
    delaySeconds,
  ];

  return {
    ...DEFAULT_PARAMS,
    panelMass: materialMasses[material] ?? DEFAULT_PARAMS.panelMass,
    hinge: {
      ...DEFAULT_PARAMS.hinge,
      panelStartDelays,
      shortEdgeStartDelays,
    },
  };
}

/**
 * Forces a scenario into a self-consistent state: a failure mode the active configuration cannot
 * exhibit falls back to `nominal`. Applied on every URL parse and on every configuration change,
 * so an invalid combination can never reach the physics or the UI.
 */
export function reconcileScenario(spec: ScenarioSpec): ScenarioSpec {
  if (isFailureModeValid(spec.config, spec.failureMode)) return spec;
  return { ...spec, failureMode: 'nominal' };
}
