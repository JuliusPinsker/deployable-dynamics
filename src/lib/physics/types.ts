// Physics engine types for CubeSat solar panel deployment simulation

export interface Vector3 {
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
  stopStiffness: number;     // N/m for mechanical stop
  stopDamping: number;       // N·s/m for mechanical stop
}

export interface PanelState {
  id: string;
  angle: number;             // radians from stowed (0)
  angularVelocity: number;   // rad/s
  stuck: boolean;            // failure mode
  stuckAngle: number;        // angle where stuck
  deployed: boolean;         // has reached stop angle
  contactForce: number;      // N at mechanical stop
}

export interface SpacecraftState {
  angularVelocity: Vector3;  // rad/s body-frame
  angularAcceleration: Vector3;
  orientation: Vector3;      // Euler angles (simplified)
  panels: PanelState[];
  time: number;              // seconds
  deploying: boolean;
}

export interface SimulationParams {
  panelMass: number;         // kg per panel
  panelLength: number;       // m
  panelWidth: number;        // m
  bodyMass: number;          // kg
  bodySize: number;          // m (cube side)
  hinge: HingeParams;
  timeStep: number;          // seconds
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
  panelLength: 0.3,
  panelWidth: 0.1,
  bodyMass: 4.0,
  bodySize: 0.1,
  hinge: {
    springConstant: 0.05,
    dampingCoeff: 0.01,
    frictionCoeff: 0.002,
    preloadTorque: 0.01,
    stopAngle: Math.PI / 2,
    stopStiffness: 500,
    stopDamping: 5,
  },
  timeStep: 1 / 60,
};
