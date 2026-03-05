// Physics engine types for CubeSat solar panel deployment simulation

import type { ThermalState, ThermalParams } from './thermalModel';
import type { FlexParams, FlexState } from './flexModel';

export type { ThermalState, ThermalParams } from './thermalModel';
export type { FlexParams, FlexState } from './flexModel';

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

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
  // ── Flexible panel dynamics (optional) ──
  tipDeflectionDeg?: number; // tip deflection as equivalent angle error (degrees)
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
  // ── Thermal model state (optional) ──
  thermalState?: ThermalState;
  thermalParams?: ThermalParams;
  // ── Flexible panel dynamics state (optional, one per panel) ──
  flexState?: FlexState[];
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
  /** Orbit altitude above Earth's surface in metres (default: 400,000 m = 400 km LEO). */
  orbitAltitudeM?: number;
  /** Whether to include gravity gradient torque in body dynamics (default: true). */
  gravityGradientEnabled?: boolean;
  // ── Optional thermal model parameters ──
  thermal?: ThermalParams;
  // ── Optional flexible panel dynamics parameters ──
  flex?: FlexParams;
}

export type ConfigType =
  | 'long-edge'
  | 'double-long-edge'
  | 'short-edge'
  | 'short-edge-long-edge';

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

export const DEFAULT_PARAMS: SimulationParams = {
  panelMass: 0.3,
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
    deployDuration: 2.0,
  },
  timeStep: 1 / 60,
  orbitAltitudeM: 400_000,       // 400 km LEO
  gravityGradientEnabled: true,
};
