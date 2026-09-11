import { MathUtils } from 'three';
import {
  type ConfigType,
  type FailureModeKey,
  type MaterialPresetKey,
  type SimulationParams,
} from './types';
import {
  buildScenarioParams,
  materialMasses,
  CONFIG_FAILURE_MODES,
  TWO_PANEL_TOPOLOGY,
  resolveReportStuckPanels,
} from '@/lib/scenario/scenarioSpec';
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

// The scenario vocabulary (per-config valid modes, canonical two-panel topology, stuck-panel
// resolution, material masses) is owned by scenarioSpec.ts so Simulation and Compare share it.
// Re-exported here because this module has always been their published home.
export { materialMasses, CONFIG_FAILURE_MODES, TWO_PANEL_TOPOLOGY, resolveReportStuckPanels };

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

export interface ReportRow {
  id: string;
  config: SimulationConfig;
  failureMode: FailureMode;
  material: PanelMaterial;
  panelMass: number;
  finalAngleDeg: number;
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
  delaySeconds: number = 0,
): { params: SimulationParams; stuckPanels: number[]; trajectory: SimulationFrame[] } {
  // Physics-driven torsional-hinge dynamics only — the scientific report must never run a
  // prescribed-motion profile. Material panel mass and the δt-derived sequential release are
  // the only per-row overrides, and they come from the SAME builder the interactive pages use,
  // so a given (config, material, δt) means one thing across the whole application.
  const params = buildScenarioParams({ config, material, delaySeconds });
  const stuckPanels = resolveReportStuckPanels(config, failureMode);
  const trajectory = runFullSimulation(config, params, REPORT_MAX_TIME, stuckPanels);
  return { params, stuckPanels, trajectory };
}

export function computeSingleRow(
  config: SimulationConfig,
  failureMode: FailureMode,
  material: PanelMaterial,
  delaySeconds: number = 0,
): ReportRow {
  const panelMass = materialMasses[material];
  const { trajectory } = runScenarioTrajectory(config, failureMode, material, delaySeconds);
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
  const peakOmegaDegPerS = MathUtils.radToDeg(peak.peakOmegaRad);

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
    averageRequiredDetumblingTorqueNm,
    deployTimeS,
    peakOmegaDegPerS,
  };
}

// The 42 rows are deterministic in (config × failure mode × material × δt), so they are cached
// KEYED BY δt: filter changes reuse the cache and never re-run the physics-driven sweeps (~24 s
// total at the 1/1200 s timestep), while a different timing discrepancy computes its own set
// rather than serving another δt's numbers.
const rowCache = new Map<number, ReportRow[]>();

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

export function generateReportRows(delaySeconds: number = 0): ReportRow[] {
  const cached = rowCache.get(delaySeconds);
  if (cached) return cached;
  const rows = reportCombos().map(([config, failureMode, material]) =>
    computeSingleRow(config, failureMode, material, delaySeconds),
  );
  rows.sort((a, b) => a.id.localeCompare(b.id));
  rowCache.set(delaySeconds, rows);
  return rows;
}

/**
 * Async variant for the browser: computes one scenario per event-loop turn so the
 * page can render progress and stay responsive during the ~24 s full-physics sweep
 * (worst single scenario ≈ 1.7 s — the 3-stage coupled config). Same rows, same
 * cache as generateReportRows; identical physics fidelity.
 */
export async function generateReportRowsAsync(
  onProgress?: (done: number, total: number) => void,
  delaySeconds: number = 0,
): Promise<ReportRow[]> {
  const cached = rowCache.get(delaySeconds);
  if (cached) {
    onProgress?.(cached.length, cached.length);
    return cached;
  }
  const combos = reportCombos();
  const rows: ReportRow[] = [];
  for (let i = 0; i < combos.length; i++) {
    const [config, failureMode, material] = combos[i];
    rows.push(computeSingleRow(config, failureMode, material, delaySeconds));
    onProgress?.(i + 1, combos.length);
    // Yield to the event loop between scenarios so rendering/input stay live.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  rowCache.set(delaySeconds, rows);
  return rows;
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
  delaySeconds: number = 0,
): ReportRow[] {
  return filterRows(generateReportRows(delaySeconds), configs, failures, materials);
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
