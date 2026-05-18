import { MathUtils } from 'three';
import {
  CONFIGURATIONS,
  DEFAULT_PARAMS,
  MATERIAL_PRESETS,
  Vector3,
  Quaternion,
  type ConfigType,
  type FailureModeKey,
  type MaterialPresetKey,
  type SimulationParams,
} from './types';
import { runFullSimulation, computeEDetumble } from './engine';

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
  'none',
  'one-stuck',
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
  finalOmegaDegPerS: number;
  eDetumbleMJ: number;
  deployTimeS: number;
  peakOmegaDegPerS: number;
}

function resolveStuckPanels(config: SimulationConfig, failureMode: FailureMode): number[] {
  const panelCount = CONFIGURATIONS.find(entry => entry.id === config)?.panelCount ?? 0;

  switch (failureMode) {
    case 'one-stuck':
      return [0];
    case 'two-opposite':
      return config === 'long-edge' || config === 'double-long-edge' ? [0, 1] : [0, 2];
    case 'all-stuck':
      return Array.from({ length: panelCount }, (_, index) => index);
    default:
      return [];
  }
}

function buildParams(panelMass: number): SimulationParams {
  return {
    ...DEFAULT_PARAMS,
    panelMass,
    hinge: {
      ...DEFAULT_PARAMS.hinge,
      deployDuration: 2,
    },
  };
}

function computeSingleRow(
  config: SimulationConfig,
  failureMode: FailureMode,
  material: PanelMaterial,
): ReportRow {
  const panelMass = materialMasses[material];
  const params = buildParams(panelMass);
  const stuckPanels = resolveStuckPanels(config, failureMode);
  const trajectory = runFullSimulation(config, params, 8, stuckPanels);
  const lastState = trajectory.at(-1);

  const lastAngles = lastState?.panelAngles ?? [];
  const finalAngleRad = lastAngles.length > 0 ? Math.max(...lastAngles) : 0;
  const finalAngleDeg = MathUtils.radToDeg(finalAngleRad);

  const finalOmegaRad = lastState?.angularVelocity.length() ?? 0;
  const finalOmegaDegPerS = MathUtils.radToDeg(finalOmegaRad);

  const fallbackDetumble = computeEDetumble(
    lastState?.angularVelocity ?? new Vector3(0, 0, 0),
    new Quaternion(),
    params,
  );
  const eDetumbleMJ = lastState?.eDetumble ?? fallbackDetumble;

  const targetAngle = finalAngleRad * 0.9;
  let deployTimeS = lastState?.time ?? 0;
  for (const state of trajectory) {
    const angle = state.panelAngles.length > 0 ? Math.max(...state.panelAngles) : 0;
    if (angle >= targetAngle) {
      deployTimeS = state.time;
      break;
    }
  }

  let maxOmegaRad = 0;
  for (const state of trajectory) {
    maxOmegaRad = Math.max(maxOmegaRad, state.angularVelocity.length());
  }
  const peakOmegaDegPerS = MathUtils.radToDeg(maxOmegaRad);

  return {
    id: `${config}-${failureMode}-${material}`,
    config,
    failureMode,
    material,
    panelMass,
    finalAngleDeg,
    finalOmegaDegPerS,
    eDetumbleMJ,
    deployTimeS,
    peakOmegaDegPerS,
  };
}

export function generate48Rows(): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const config of REPORT_CONFIGS) {
    for (const failureMode of REPORT_FAILURES) {
      for (const material of REPORT_MATERIALS) {
        rows.push(computeSingleRow(config, failureMode, material));
      }
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function getFilteredRows(
  configs: SimulationConfig[] | null,
  failures: FailureMode[] | null,
  materials: PanelMaterial[] | null,
): ReportRow[] {
  const allRows = generate48Rows();
  return allRows.filter(row =>
    (!configs || configs.length === 0 || configs.includes(row.config)) &&
    (!failures || failures.length === 0 || failures.includes(row.failureMode)) &&
    (!materials || materials.length === 0 || materials.includes(row.material)),
  );
}

export interface SummaryStats {
  count: number;
  meanFinalAngle: number;
  stdFinalAngle: number;
  meanEDetumbleMJ: number;
  stdEDetumbleMJ: number;
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
      meanEDetumbleMJ: 0,
      stdEDetumbleMJ: 0,
      meanDeployTimeS: 0,
      stdDeployTimeS: 0,
      maxPeakOmegaDegPerS: 0,
    };
  }

  const count = rows.length;
  const meanFinalAngle = rows.reduce((sum, row) => sum + row.finalAngleDeg, 0) / count;
  const meanEDetumbleMJ = rows.reduce((sum, row) => sum + row.eDetumbleMJ, 0) / count;
  const meanDeployTimeS = rows.reduce((sum, row) => sum + row.deployTimeS, 0) / count;

  const angles = rows.map(row => row.finalAngleDeg);
  const eDetumbles = rows.map(row => row.eDetumbleMJ);
  const deployTimes = rows.map(row => row.deployTimeS);
  const peakOmegas = rows.map(row => row.peakOmegaDegPerS);

  return {
    count,
    meanFinalAngle,
    stdFinalAngle: std(angles, meanFinalAngle),
    meanEDetumbleMJ,
    stdEDetumbleMJ: std(eDetumbles, meanEDetumbleMJ),
    meanDeployTimeS,
    stdDeployTimeS: std(deployTimes, meanDeployTimeS),
    maxPeakOmegaDegPerS: Math.max(...peakOmegas),
  };
}

export { REPORT_CONFIGS, REPORT_FAILURES, REPORT_MATERIALS };
