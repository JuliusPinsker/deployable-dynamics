// Physics engine types for CubeSat solar panel deployment simulation

import type { Vector3, Quaternion } from 'three';
export { Vector3, Quaternion, Euler } from 'three';

export interface HingeParams {
  springConstant: number;    // N·m/rad
  dampingCoeff: number;      // N·m·s/rad
  frictionCoeff: number;     // N·m
  preloadTorque: number;     // N·m
  stopAngle: number;         // radians (deployment target)
  /**
   * Rotational contact model for the mechanical stop:
   *   τ_stop = -k_stop · (θ - θ_stop) - c_stop · dθ/dt   [N·m]
   * where k_stop = stopStiffness and c_stop = stopDamping.
   */
  stopStiffness: number;     // N·m/rad — rotational stiffness of mechanical stop
  stopDamping: number;       // N·m·s/rad — rotational damping of mechanical stop
  // Optional: kinematic deployment duration (seconds). When provided, panels follow a deterministic ease-out
  // kinematic profile (useful for precise animation timing). If omitted, the hinge is physics-driven.
  deployDuration?: number;
  // Optional per-panel start delays (seconds) for short-edge config panels [0..3].
  // Delays shift activation time only and do not change motion profile.
  shortEdgeStartDelays?: [number, number, number, number];
  /**
   * Per-panel activation delay in seconds for ALL configurations.
   * Index i corresponds to panel i in the layout spec.
   * Panels not listed default to 0 (immediate activation).
   * This generalises shortEdgeStartDelays to all config types.
   */
  panelStartDelays?: number[];
  // Hinge torque law model. Default behavior is linear spring-damper.
  hingeModel?: 'linear' | 'bistable';
  // Optional bistable tape-spring parameters when hingeModel is 'bistable'.
  bistability?: {
    bistabilityCoeff: number;
    snapThroughAngle?: number;
  };
}

export interface PanelState {
  id: string;
  angle: number;             // radians from stowed (0)
  angularVelocity: number;   // rad/s (scalar, relative hinge rate)
  stuck: boolean;            // failure mode
  stuckAngle: number;        // angle where stuck
  deployed: boolean;         // has reached stop angle
  contactForce: number;      // N at mechanical stop
  // ── Internal 3D state (engine-managed, derived each step) ──
  _q?: Quaternion;           // panel orientation quaternion (world frame)
  _omega?: Vector3;          // panel angular velocity (world frame, 3D)
}

export interface SpacecraftState {
  angularVelocity: Vector3;  // rad/s world-frame (3D)
  angularAcceleration: Vector3;
  orientation: Vector3;      // Euler angles (XYZ intrinsic, derived from body quaternion)
  panels: PanelState[];
  time: number;              // seconds
  deploying: boolean;
  // ── Internal quaternion state (engine-managed) ──
  _bodyQ?: Quaternion;       // body orientation quaternion
  /** Composite system CoM in body frame (metres). Populated each step. */
  comBody?: Vector3;
  /**
   * Time (s) at which deployment first completed (all panels deployed/stuck).
   * `undefined` until then. Drives the post-deployment observation window during
   * which the body keeps coasting with panels held fixed. Engine-managed.
   */
  _deployCompleteTime?: number;
}

export interface SimulationParams {
  panelMass: number;         // kg per panel
  panelLength: number;       // m (outward deployment length from hinge)
  panelWidth: number;        // m (panel span along hinge axis)
  panelThickness: number;    // m (panel sandwich thickness)
  bodyMass: number;          // kg
  bodyWidth: number;         // m (X dimension / right)
  bodyDepth: number;         // m (Y dimension / forward)
  bodyHeight: number;        // m (Z dimension / up / long edge)
  hinge: HingeParams;
  timeStep: number;          // seconds
}

export type ConfigType =
  | 'long-edge'
  | 'double-long-edge'
  | 'short-edge'
  | 'short-edge-long-edge';

export type FailureModeKey = 'none' | 'one-stuck' | 'two-opposite' | 'all-stuck';

export interface ConfigInfo {
  id: ConfigType;
  name: string;
  shortName: string;
  panelCount: number;
  description: string;
  color: string;           // tailwind config color key
}

export const CONFIGURATIONS: ConfigInfo[] = [
  {
    id: 'long-edge',
    name: 'Long-edge Deployable',
    shortName: 'Long-edge',
    panelCount: 2,
    description: 'Two 3U panels attached along the Z-axis, rotating 90° from stowed. Symmetrical deployment self-cancels induced rotations.',
    color: 'config-1',
  },
  {
    id: 'double-long-edge',
    name: 'Double Long-edge Deployable',
    shortName: 'Double Long-edge',
    panelCount: 4,
    description: 'Two-panel assemblies (4 total) in accordion fold along long edges. Complex sequential deployment dynamics.',
    color: 'config-2',
  },
  {
    id: 'short-edge',
    name: 'Short-edge Deployable',
    shortName: 'Short-edge',
    panelCount: 4,
    description: 'Four 3U panels on short edges, each moving independently. High disturbance risk if deployment is asynchronous.',
    color: 'config-3',
  },
  {
    id: 'short-edge-long-edge',
    name: 'Short-edge + Long-edge Coupled',
    shortName: 'Coupled',
    panelCount: 8,
    description: 'Eight panels in four assemblies combining both attachment types. Most complex with highest tumbling risk.',
    color: 'config-4',
  },
];

export type MaterialPresetKey = 'fr4' | 'al-kapton' | 'cfrp';

export interface MaterialPreset {
  key: MaterialPresetKey;
  label: string;
  panelMass: number;        // kg per panel
  description: string;      // one-line physics description
  example: string;          // real mission example
  massGrams: number;        // display value in grams
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    key: 'fr4',
    label: 'FR4 PCB',
    panelMass: 0.032,
    description: 'Standard fibreglass PCB substrate with GaAs cells',
    example: 'GomSpace NanoPower P110 - GOMX-1, Aalto-1',
    massGrams: 32,
  },
  {
    key: 'al-kapton',
    label: 'Al / Kapton Flex',
    panelMass: 0.050,
    description: 'Aluminium facesheet with Kapton flex circuit and Si cells',
    example: 'JPL MarCO (2018), ISARA (2017)',
    massGrams: 50,
  },
  {
    key: 'cfrp',
    label: 'CFRP Composite',
    panelMass: 0.020,
    description: 'Carbon fibre facesheet with GaAs cells - lightest option',
    example: 'Planet Labs Dove, ESA OPS-SAT (2019)',
    massGrams: 20,
  },
];

export const DEFAULT_PARAMS: SimulationParams = {
  panelMass: 0.032,          // FR4 PCB substrate panel - GomSpace NanoPower P110 (32 g)
  // Panel dimensions for top-mounted cross configuration (X=right, Y=forward, Z=up)
  // Panel dimensions match CubeSat body for realistic proportions
  panelLength: 0.1,          // 0.1 m outward deployment length (matches body width/depth)
  panelWidth: 0.3405,        // 0.3405 m span (matches body height / long edge)
  panelThickness: 0.0025,    // 2.5 mm total sandwich thickness
  bodyMass: 4.0,
  // 3U CubeSat dimensions (meters): 100 mm x 100 mm x 340.5 mm
  // Coordinate system: X=right, Y=forward, Z=up
  bodyWidth: 0.1,            // X dimension
  bodyDepth: 0.1,            // Y dimension
  bodyHeight: 0.3405,        // Z dimension (long edge)
  // Hinge tuned to produce ~2.0s ease-out deployment with no overshoot (critically/over-damped)
  hinge: {
    springConstant: 0.02,    // N·m/rad — tuned for ~2s deployment with adequate torque
    dampingCoeff: 0.08,      // N·m·s/rad — overdamped to avoid overshoot
    frictionCoeff: 0.0005,   // small Coulomb friction
    preloadTorque: 0.0,      // no preload — controlled spring response
    stopAngle: Math.PI / 2,
    stopStiffness: 10,       // N·m/rad — ω_n ≈ 100 rad/s for I_panel = 0.001 kg·m²
    stopDamping: 0.24,        // N·m·s/rad — ζ ≈ 1.2 (overdamped, settles in ~0.05 s)
    deployDuration: 0.4,     // 400 ms — consistent with Planet Labs Flock observed deployment
    shortEdgeStartDelays: [0, 1.0, 0, 1.0],
  },
  timeStep: 1 / 60,
};
