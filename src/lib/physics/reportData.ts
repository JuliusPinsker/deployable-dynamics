import { MathUtils } from 'three';
import {
  CONFIGURATIONS,
  DEFAULT_PARAMS,
  MATERIAL_PRESETS,
  type ConfigType,
  type FailureModeKey,
  type MaterialPresetKey,
  type SimulationParams,
} from './types';
import {
  runFullSimulation,
  accumulateOmegaPeak,
  computeAverageRequiredDetumblingTorque,
  EMPTY_OMEGA_PEAK,
  type SimulationFrame,
} from './engine';

export type SimulationConfig = ConfigType;
export type FailureMode = FailureModeKey;
export type PanelMaterial = MaterialPresetKey;

export const materialMasses: Record<PanelMaterial, number> = MATERIAL_PRESETS.reduce(
  (acc, preset) => {
    acc[preset.key] = preset.panelMass;
    return acc;
  },
  {} as Record<PanelMaterial, number>,
);

const REPORT_CONFIGS: SimulationConfig[] = [
  'long-edge',
  'double-long-edge',
  'short-edge',
  'short-edge-long-edge',
];

const REPORT_FAILURES: FailureMode[] = [
  'one-stuck',
  'two-adjacent',
  'two-opposite',
  'all-stuck',
];

const REPORT_MATERIALS: PanelMaterial[] = ['fr4', 'al-kapton', 'cfrp'];

/**
 * The report evaluates a 42-scenario failure-mode sweep across four panel configurations
 * and three material presets. The number of valid failure cases depends on the number and
 * arrangement of panels in each configuration. The long-edge configuration contains two
 * panels; therefore, it has no separate adjacent-pair and opposite-pair failure cases — the
 * only panel pair that exists ([0,1]) is inherently the opposite pair, so `two-adjacent` and
 * `two-opposite` are never generated for it. (2 modes × 3 materials) + (4 modes × 3 configs
 * × 3 materials) = 6 + 36 = 42 rows.
 */
export const CONFIG_FAILURE_MODES: Record<SimulationConfig, FailureMode[]> = {
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
export const TWO_PANEL_TOPOLOGY: Partial<Record<SimulationConfig, { adjacent: number[]; opposite: number[] }>> = {
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

export interface ReportRow {
  id: string;
  config: SimulationConfig;
  failureMode: FailureMode;
  material: PanelMaterial;
  panelMass: number;
  finalAngleDeg: number;
  finalOmegaDegPerS: number;
  /**
   * The one reported detumbling figure (N·m): the trajectory-maximum internal body
   * angular momentum divided by the assumed 5400 s allocation. An ADCS sizing
   * requirement, not a simulated actuator torque.
   */
  averageRequiredDetumblingTorqueNm: number;
  deployTimeS: number;
  peakOmegaDegPerS: number;
}

/**
 * Resolves the canonical stuck-panel indices for a (config, failureMode) pair.
 *
 * Invalid-mode guard: `two-adjacent`/`two-opposite` throw for any configuration with no
 * entry in TWO_PANEL_TOPOLOGY (i.e. `long-edge`) rather than returning an empty array,
 * `[0,1]`, or any other fallback — there is no physically valid pair to invent. This is a
 * defensive guard only: `reportCombos` (via CONFIG_FAILURE_MODES) is the mechanism that
 * actually prevents these invalid combinations from ever being generated.
 */
export function resolveReportStuckPanels(config: SimulationConfig, failureMode: FailureMode): number[] {
  const panelCount = CONFIGURATIONS.find(entry => entry.id === config)?.panelCount ?? 0;

  if (failureMode === 'one-stuck') return [0];
  if (failureMode === 'all-stuck') return Array.from({ length: panelCount }, (_, index) => index);

  const topology = TWO_PANEL_TOPOLOGY[config];
  if (!topology) {
    throw new Error(`Failure mode ${failureMode} is not applicable to configuration ${config}.`);
  }
  return failureMode === 'two-adjacent' ? topology.adjacent : topology.opposite;
}

function buildParams(panelMass: number): SimulationParams {
  // Physics-driven torsional-hinge dynamics only — the scientific report must
  // never run a prescribed-motion profile. Material panel mass is the only
  // per-row override; it flows into panel inertia, momentum, and CoM.
  return {
    ...DEFAULT_PARAMS,
    panelMass,
    hinge: { ...DEFAULT_PARAMS.hinge },
  };
}

/**
 * Simulation horizon CAP (seconds) for every report scenario row. Runs end as
 * soon as all panels latch deployed/stuck plus the post-deployment observation
 * window, so this only bounds pathological cases. Under the calibrated default
 * hinge the slowest (3-stage coupled) configuration completes in ~6 s of
 * simulated time (~12 s including the observation window).
 */
export const REPORT_MAX_TIME = 90;

/**
 * Build the exact inputs and trajectory a report row is derived from. Exposed so tests
 * (and any future tooling) can assert against the real computation path — same
 * material-sourced params (`buildParams`), stuck-panel resolution, and horizon — instead of
 * reconstructing those values by hand and silently drifting when the source data changes.
 */
export function runScenarioTrajectory(
  config: SimulationConfig,
  failureMode: FailureMode,
  material: PanelMaterial,
): { params: SimulationParams; stuckPanels: number[]; trajectory: SimulationFrame[] } {
  const params = buildParams(materialMasses[material]);
  const stuckPanels = resolveReportStuckPanels(config, failureMode);
  const trajectory = runFullSimulation(config, params, REPORT_MAX_TIME, stuckPanels);
  return { params, stuckPanels, trajectory };
}

export function computeSingleRow(
  config: SimulationConfig,
  failureMode: FailureMode,
  material: PanelMaterial,
): ReportRow {
  const panelMass = materialMasses[material];
  const { trajectory } = runScenarioTrajectory(config, failureMode, material);
  const lastState = trajectory.at(-1);

  // Final panel angle comes from the last frame — panels are held at their final angles.
  const lastAngles = lastState?.panelAngles ?? [];
  const finalAngleRad = lastAngles.length > 0 ? Math.max(...lastAngles) : 0;
  const finalAngleDeg = MathUtils.radToDeg(finalAngleRad);

  // Peak values over the trajectory. The LAST frame is a settled/near-zero frame — the body
  // starts from rest and momentum is conserved, so ω decays back to ~0 once the panels stop
  // moving. Reading w_final from it is misleading. Reduce the full trajectory via the
  // shared accumulator (same one live telemetry uses). |ω| and the internal |Iω| are
  // maximised INDEPENDENTLY: the body inertia is anisotropic and the mass distribution
  // changes as the panels swing, so the peak-rate frame need not be the peak-momentum frame.
  // (`all-stuck` and symmetric-nominal legitimately keep both peaks = 0.)
  let peak = EMPTY_OMEGA_PEAK;
  for (const state of trajectory) {
    peak = accumulateOmegaPeak(
      peak,
      state.angularVelocity.length(),
      state.detumbleAngularMomentum,
    );
  }
  const finalOmegaDegPerS = MathUtils.radToDeg(peak.peakOmegaRad);
  const peakOmegaDegPerS = finalOmegaDegPerS;

  // The reported ADCS sizing value — that independent maximum spread over the assumed
  // 5400 s (one-orbit) recovery allocation. Never differenced from adjacent samples.
  const averageRequiredDetumblingTorqueNm =
    computeAverageRequiredDetumblingTorque(peak.peakDetumbleAngularMomentum);

  // Calculated deployment time t₉₀: first recorded frame at/after 90% of the
  // final (deployed) panel angle — the scientific deployment-time metric used
  // across the report and UI. This is NOT the latch/settle time (stop capture
  // happens later); it is an emergent simulation result, never prescribed.
  const targetAngle = finalAngleRad * 0.9;
  let deployTimeS = lastState?.time ?? 0;
  for (const state of trajectory) {
    const angle = state.panelAngles.length > 0 ? Math.max(...state.panelAngles) : 0;
    if (angle >= targetAngle) {
      deployTimeS = state.time;
      break;
    }
  }

  return {
    id: `${config}-${failureMode}-${material}`,
    config,
    failureMode,
    material,
    panelMass,
    finalAngleDeg,
    finalOmegaDegPerS,
    averageRequiredDetumblingTorqueNm,
    deployTimeS,
    peakOmegaDegPerS,
  };
}

// The 42 rows are deterministic (fixed per-config failure modes × materials, no user
// inputs), so compute them once per session; filter changes reuse the cache and the
// physics-driven sweeps (~24 s total at the 1/1200 s timestep) never re-run.
let cachedRows: ReportRow[] | null = null;

function reportCombos(): Array<[SimulationConfig, FailureMode, PanelMaterial]> {
  const combos: Array<[SimulationConfig, FailureMode, PanelMaterial]> = [];
  for (const config of REPORT_CONFIGS) {
    for (const failureMode of CONFIG_FAILURE_MODES[config]) {
      for (const material of REPORT_MATERIALS) {
        combos.push([config, failureMode, material]);
      }
    }
  }
  return combos;
}

export function generateReportRows(): ReportRow[] {
  if (cachedRows) return cachedRows;
  const rows = reportCombos().map(([config, failureMode, material]) =>
    computeSingleRow(config, failureMode, material),
  );
  cachedRows = rows.sort((a, b) => a.id.localeCompare(b.id));
  return cachedRows;
}

/**
 * Async variant for the browser: computes one scenario per event-loop turn so the
 * page can render progress and stay responsive during the ~24 s full-physics sweep
 * (worst single scenario ≈ 1.7 s — the 3-stage coupled config). Same rows, same
 * cache as generateReportRows; identical physics fidelity.
 */
export async function generateReportRowsAsync(
  onProgress?: (done: number, total: number) => void,
): Promise<ReportRow[]> {
  if (cachedRows) {
    onProgress?.(cachedRows.length, cachedRows.length);
    return cachedRows;
  }
  const combos = reportCombos();
  const rows: ReportRow[] = [];
  for (let i = 0; i < combos.length; i++) {
    const [config, failureMode, material] = combos[i];
    rows.push(computeSingleRow(config, failureMode, material));
    onProgress?.(i + 1, combos.length);
    // Yield to the event loop between scenarios so rendering/input stay live.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  cachedRows = rows.sort((a, b) => a.id.localeCompare(b.id));
  return cachedRows;
}

/** Pure filter over already-generated rows (no simulation work). */
export function filterRows(
  allRows: ReportRow[],
  configs: SimulationConfig[] | null,
  failures: FailureMode[] | null,
  materials: PanelMaterial[] | null,
): ReportRow[] {
  return allRows.filter(row =>
    (!configs || configs.length === 0 || configs.includes(row.config)) &&
    (!failures || failures.length === 0 || failures.includes(row.failureMode)) &&
    (!materials || materials.length === 0 || materials.includes(row.material)),
  );
}

export function getFilteredRows(
  configs: SimulationConfig[] | null,
  failures: FailureMode[] | null,
  materials: PanelMaterial[] | null,
): ReportRow[] {
  return filterRows(generateReportRows(), configs, failures, materials);
}

export interface SummaryStats {
  count: number;
  meanFinalAngle: number;
  stdFinalAngle: number;
  /** Mean / std of the per-row average required detumbling torque (N·m). */
  meanAverageRequiredDetumblingTorqueNm: number;
  stdAverageRequiredDetumblingTorqueNm: number;
  meanDeployTimeS: number;
  stdDeployTimeS: number;
  maxPeakOmegaDegPerS: number;
}

function std(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const sqDiff = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(sqDiff / values.length);
}

export function computeSummaryStats(rows: ReportRow[]): SummaryStats {
  if (rows.length === 0) {
    return {
      count: 0,
      meanFinalAngle: 0,
      stdFinalAngle: 0,
      meanAverageRequiredDetumblingTorqueNm: 0,
      stdAverageRequiredDetumblingTorqueNm: 0,
      meanDeployTimeS: 0,
      stdDeployTimeS: 0,
      maxPeakOmegaDegPerS: 0,
    };
  }

  const count = rows.length;
  const meanFinalAngle = rows.reduce((sum, row) => sum + row.finalAngleDeg, 0) / count;
  const meanDeployTimeS = rows.reduce((sum, row) => sum + row.deployTimeS, 0) / count;

  const meanAverageRequiredDetumblingTorqueNm =
    rows.reduce((sum, row) => sum + row.averageRequiredDetumblingTorqueNm, 0) / count;

  const angles = rows.map(row => row.finalAngleDeg);
  const requiredTorques = rows.map(row => row.averageRequiredDetumblingTorqueNm);
  const deployTimes = rows.map(row => row.deployTimeS);
  const peakOmegas = rows.map(row => row.peakOmegaDegPerS);

  return {
    count,
    meanFinalAngle,
    stdFinalAngle: std(angles, meanFinalAngle),
    meanAverageRequiredDetumblingTorqueNm,
    stdAverageRequiredDetumblingTorqueNm: std(
      requiredTorques,
      meanAverageRequiredDetumblingTorqueNm,
    ),
    meanDeployTimeS,
    stdDeployTimeS: std(deployTimes, meanDeployTimeS),
    maxPeakOmegaDegPerS: Math.max(...peakOmegas),
  };
}

export { REPORT_CONFIGS, REPORT_FAILURES, REPORT_MATERIALS };
