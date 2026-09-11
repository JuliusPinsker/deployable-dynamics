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
  contactTorque: number;     // N·m at mechanical stop
  /**
   * Net hinge torque (N·m) applied to this panel on the last step — spring/bistable
   * + preload − damping − friction − stop. Telemetry: the equal-and-opposite body
   * reaction is derived from this inside the engine. 0 while stowed-held, stuck,
   * or latched deployed.
   */
  hingeTorque: number;
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
  /**
   * Composite system CoM in body frame (metres). Rendering concern: populated by
   * the UI at display-frame cadence via computeSystemCoM (not by the physics step).
   */
  comBody?: Vector3;
  /**
   * Time (s) at which deployment first completed (all panels deployed/stuck).
   * `undefined` until then. Drives the post-deployment observation window during
   * which the body keeps coasting with panels held fixed. Engine-managed.
   */
  _deployCompleteTime?: number;
  /**
   * Time (s) at which each deployment stage's predecessors first completed
   * (stage 1 opens at 0). Per-panel start delays offset from the stage opening,
   * so timing-discrepancy δt applies within every stage. Engine-managed.
   */
  _stageOpenTimes?: Record<number, number>;
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

export type FailureModeKey = 'one-stuck' | 'two-adjacent' | 'two-opposite' | 'all-stuck';

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
    name: 'Coupled',
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
  massGrams: number;        // display value in grams
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    key: 'fr4',
    label: 'FR4 PCB',
    panelMass: 0.032,
    description: 'Standard fibreglass PCB substrate with GaAs cells',
    massGrams: 32,
  },
  {
    key: 'al-kapton',
    label: 'Al / Kapton Flex',
    panelMass: 0.050,
    description: 'Aluminium facesheet with Kapton flex circuit and Si cells',
    massGrams: 50,
  },
  {
    key: 'cfrp',
    label: 'CFRP Composite',
    panelMass: 0.020,
    description: 'Carbon fibre facesheet with GaAs cells - lightest option',
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
  // Torsional spring-damper hinge — the single (physics-driven) deployment model.
  //
  // ── ENGINEERING CALIBRATION ASSUMPTION — NOT A VENDOR-QUALIFIED HINGE VALUE ──
  // k and c were selected by the transparent sensitivity sweep in
  // src/lib/physics/calibration.ts (grid over ωₙ × ζ, production engine, FR4
  // nominal long-edge), pending component-level torsion-spring and deployment
  // testing. Nominal target metric: time from release to FIRST reach of 90% of
  // the deployed angle, window 1.0–2.0 s. Resulting simulated values with
  // these defaults (FR4 long-edge, 1/1200 s timestep, Phase-B coupled EOM):
  // t₉₀ ≈ 1.233 s; latch ≈ 1.742 s. At this damping the panel decelerates
  // into the Coulomb dead-band just short of the stop (no ballistic stop
  // impact); the end-of-travel latch captures the final ≈0.92° — within the
  // 2° honest-capture cap, with angular momentum carried through the latch
  // event exactly (see the constraint-event block in engine.ts).
  // Deployment time remains an emergent simulation result, never prescribed.
  // Target basis: a 1–2 s controlled CubeSat panel deployment range is
  // supported by the Muhammed et al. deployment study, and 1.0 s is used as a
  // deployment-time assumption in the NASA ALBus CubeSat hinge analysis (both
  // provided as project references; no component datasheet exists in-repo).
  //
  // PHASE-B RECALIBRATION: the hinge-axis inertia mapping was corrected from
  // the centroidal (1/12)m(R²+t²) to the true hinge-EDGE moment
  // (1/3)mR² + (1/12)mt² (parallel-axis theorem; a uniform ≈4× increase,
  // long-edge FR4 I_eff ≈ 1.2367e-3 kg·m²), and the sweep re-run against the
  // coupled hub–panel EOM. The selected grid point is
  //   ωₙ = √(k/I_eff) ≈ 2.50 rad/s, ζ = c/(2√(k·I_eff)) ≈ 0.80 (underdamped)
  // — chosen because the Phase-B audit extends the 1.0–2.0 s t₉₀ window to
  // EVERY nominal configuration/stage row for EVERY supported material
  // (release-relative, per the documented metric). ζ ≈ 0.80 compresses the
  // spread between the light/fast rows (CFRP, short-edge) and the
  // heavy/slow rows (Al-Kapton, double-long-edge stage 1 with its folded
  // rider): measured rows span 1.21–1.56 s, all inside the window, while the
  // stop-capture selection criteria (contact with momentum, zero latch snap,
  // bounded overshoot, dt-convergence) all still hold on the reference row.
  // Lighter-damping grid points (e.g. the previous ζ ≈ 0.30 selection) keep
  // the FR4 long-edge reference row in-window but push double-long-edge
  // stage 1 and/or the material extremes outside it.
  hinge: {
    // Grid-exact values (k = I_eff·ωₙ², c = 2ζ√(k·I_eff) with ωₙ = 2.5,
    // ζ = 0.8): the ζ ≈ 0.8 arrival at the stop is only marginally
    // supercritical, and 3-digit roundings of k/c were measured to tip the
    // reference row from clean stop capture (contact with momentum, zero
    // latch snap) into a dead-band stall — so the constants are stored at
    // the precision the documented mapping actually produces.
    springConstant: 7.729454e-3, // N·m/rad — calibrated (see block comment above)
    dampingCoeff: 4.946851e-3,   // N·m·s/rad — calibrated; underdamped, ζ ≈ 0.80
    // Coulomb friction — scaled with the calibrated k to preserve the original
    // design's friction dead-band τ_f/k = 0.025 rad (1.43°).
    // Keeping the legacy 5e-4 N·m against a soft spring is demonstrably
    // inconsistent with the deployment-time target: its dead-band spans tens
    // of degrees and panels stall far short of the stop (measured in the
    // calibration sweep; asserted in calibration.test.ts).
    // Stop and preload values are unchanged by the calibration.
    frictionCoeff: 1.932364e-4,  // N·m — 0.025 rad × k; dead-band 0.025 rad preserved
    preloadTorque: 0.0,      // N·m — no preload (unchanged by calibration)
    stopAngle: Math.PI / 2,
    stopStiffness: 10,       // N·m/rad — mechanical stop (unchanged by calibration)
    stopDamping: 0.24,       // N·m·s/rad — overdamped stop contact
                             //   absorbs the arrival and prevents persistent
                             //   post-stop oscillation without global viscous damping
    shortEdgeStartDelays: [0, 1.0, 0, 1.0],
  },
  // Fixed physics timestep: 1/1200 s ≈ 0.833 ms. This is the timing RESOLUTION of
  // the simulation — panel release delays (δt) activate on step boundaries, so the
  // smallest representable stagger is one step (a 5 ms delay = exactly 6 steps).
  // Deterministic fixed-step integration (never adaptive). Rendering is decoupled:
  // the UI advances 1/60 s of simulation time per display frame = exactly 20
  // physics substeps, so browser frame rate never alters the dynamics.
  timeStep: 1 / 1200,
};
