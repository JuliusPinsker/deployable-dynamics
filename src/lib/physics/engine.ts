// Browser-based rigid body dynamics engine for CubeSat solar panel deployment
import {
  type ConfigType,
  type SimulationParams,
  type SpacecraftState,
  type PanelState,
  type Vector3,
  DEFAULT_PARAMS,
} from './types';

function createInitialPanels(config: ConfigType): PanelState[] {
  const counts: Record<ConfigType, number> = {
    'long-edge': 2,
    'double-long-edge': 4,
    'short-edge': 4,
    'short-edge-long-edge': 8,
  };
  const n = counts[config];
  return Array.from({ length: n }, (_, i) => ({
    id: `panel-${i}`,
    angle: 0,
    angularVelocity: 0,
    stuck: false,
    stuckAngle: 0,
    deployed: false,
    contactForce: 0,
  }));
}

export function createInitialState(config: ConfigType): SpacecraftState {
  return {
    angularVelocity: { x: 0, y: 0, z: 0 },
    angularAcceleration: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0 },
    panels: createInitialPanels(config),
    time: 0,
    deploying: false,
  };
}

// Compute panel moment of inertia about hinge (thin rod approximation)
function panelInertia(params: SimulationParams): number {
  return (1 / 3) * params.panelMass * params.panelLength * params.panelLength;
}

// Body moment of inertia (cube approximation)
function bodyInertia(params: SimulationParams): number {
  return (1 / 6) * params.bodyMass * params.bodySize * params.bodySize;
}

// Compute hinge torque for a single panel using spring-damper model
function hingeTorque(panel: PanelState, params: SimulationParams): number {
  if (panel.stuck || panel.deployed) return 0;

  const h = params.hinge;
  // Spring torque drives panel toward stop angle
  const springT = h.springConstant * (h.stopAngle - panel.angle) + h.preloadTorque;
  // Damping opposes motion
  const dampT = -h.dampingCoeff * panel.angularVelocity;
  // Friction opposes motion (Coulomb-like)
  const frictionT = -Math.sign(panel.angularVelocity) * h.frictionCoeff;

  return springT + dampT + frictionT;
}

// Contact force when panel hits mechanical stop
function contactTorque(panel: PanelState, params: SimulationParams): number {
  const h = params.hinge;
  if (panel.angle < h.stopAngle) return 0;

  const penetration = panel.angle - h.stopAngle;
  const force = -h.stopStiffness * penetration - h.stopDamping * panel.angularVelocity;
  return force;
}

// Get the torque axis contribution to spacecraft body for each panel based on config
function getPanelTorqueAxis(config: ConfigType, panelIndex: number, panelCount: number): Vector3 {
  switch (config) {
    case 'long-edge':
      // Two panels on opposite sides along Z, hinge torque affects X rotation
      return panelIndex === 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 };
    case 'double-long-edge':
      // 4 panels in 2 assemblies, inner panels along Z, outer panels cascade
      if (panelIndex < 2) return panelIndex === 0 ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 };
      return panelIndex === 2 ? { x: 0.7, y: 0.3, z: 0 } : { x: -0.7, y: 0.3, z: 0 };
    case 'short-edge':
      // 4 panels on 4 faces, each contributes to different axes
      const axes: Vector3[] = [
        { x: 1, y: 0, z: 0 },
        { x: -1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: -1, z: 0 },
      ];
      return axes[panelIndex];
    case 'short-edge-long-edge':
      // 8 panels in 4 assemblies combining both attachment types
      const angle = (panelIndex % 4) * (Math.PI / 2);
      const isOuter = panelIndex >= 4;
      const scale = isOuter ? 0.6 : 1;
      return {
        x: Math.cos(angle) * scale,
        y: Math.sin(angle) * scale,
        z: isOuter ? 0.3 : 0,
      };
    default:
      return { x: 0, y: 0, z: 0 };
  }
}

export function stepSimulation(
  state: SpacecraftState,
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
): SpacecraftState {
  if (!state.deploying) return state;

  const dt = params.timeStep;
  const Ip = panelInertia(params);
  const Ib = bodyInertia(params);

  const newPanels: PanelState[] = [];
  const totalReactionTorque: Vector3 = { x: 0, y: 0, z: 0 };

  for (let i = 0; i < state.panels.length; i++) {
    const panel = state.panels[i];

    if (panel.stuck) {
      newPanels.push({ ...panel });
      continue;
    }

    // Compute torques
    const tHinge = hingeTorque(panel, params);
    const tContact = contactTorque(panel, params);
    const totalTorque = tHinge + tContact;

    // Panel angular acceleration
    const alpha = totalTorque / Ip;

    // Integrate panel state
    let newVel = panel.angularVelocity + alpha * dt;
    let newAngle = panel.angle + newVel * dt;

    // Clamp
    if (newAngle < 0) { newAngle = 0; newVel = 0; }

    const deployed = newAngle >= params.hinge.stopAngle && Math.abs(newVel) < 0.1;
    if (deployed) {
      newAngle = params.hinge.stopAngle;
      newVel = 0;
    }

    const cf = Math.abs(tContact);

    newPanels.push({
      ...panel,
      angle: newAngle,
      angularVelocity: newVel,
      deployed,
      contactForce: cf,
    });

    // Reaction torque on body (conservation of angular momentum)
    const axis = getPanelTorqueAxis(config, i, state.panels.length);
    const reactionMag = -totalTorque * (Ip / (Ib + state.panels.length * Ip));
    totalReactionTorque.x += axis.x * reactionMag;
    totalReactionTorque.y += axis.y * reactionMag;
    totalReactionTorque.z += axis.z * reactionMag;
  }

  // Body angular acceleration
  const effectiveInertia = Ib + state.panels.length * Ip * 0.3; // coupled inertia
  const bodyAlpha: Vector3 = {
    x: totalReactionTorque.x / effectiveInertia,
    y: totalReactionTorque.y / effectiveInertia,
    z: totalReactionTorque.z / effectiveInertia,
  };

  const newBodyOmega: Vector3 = {
    x: state.angularVelocity.x + bodyAlpha.x * dt,
    y: state.angularVelocity.y + bodyAlpha.y * dt,
    z: state.angularVelocity.z + bodyAlpha.z * dt,
  };

  const newOrientation: Vector3 = {
    x: state.orientation.x + newBodyOmega.x * dt,
    y: state.orientation.y + newBodyOmega.y * dt,
    z: state.orientation.z + newBodyOmega.z * dt,
  };

  const allDeployed = newPanels.every(p => p.deployed || p.stuck);

  return {
    angularVelocity: newBodyOmega,
    angularAcceleration: bodyAlpha,
    orientation: newOrientation,
    panels: newPanels,
    time: state.time + dt,
    deploying: !allDeployed,
  };
}

// Run a full simulation and return time-series data
export interface SimulationFrame {
  time: number;
  angularVelocity: Vector3;
  angularAcceleration: Vector3;
  panelAngles: number[];
  contactForces: number[];
  totalContactForce: number;
}

export function runFullSimulation(
  config: ConfigType,
  params: SimulationParams = DEFAULT_PARAMS,
  maxTime: number = 10,
  stuckPanels: number[] = [],
): SimulationFrame[] {
  let state = createInitialState(config);
  state.deploying = true;

  // Apply stuck panels
  for (const idx of stuckPanels) {
    if (idx < state.panels.length) {
      state.panels[idx].stuck = true;
      state.panels[idx].stuckAngle = 0;
    }
  }

  const frames: SimulationFrame[] = [];
  const maxSteps = Math.ceil(maxTime / params.timeStep);

  for (let i = 0; i < maxSteps; i++) {
    state = stepSimulation(state, config, params);
    
    // Record every 3rd frame for chart data
    if (i % 3 === 0) {
      frames.push({
        time: Math.round(state.time * 1000) / 1000,
        angularVelocity: { ...state.angularVelocity },
        angularAcceleration: { ...state.angularAcceleration },
        panelAngles: state.panels.map(p => p.angle),
        contactForces: state.panels.map(p => p.contactForce),
        totalContactForce: state.panels.reduce((s, p) => s + p.contactForce, 0),
      });
    }

    if (!state.deploying && state.time > 0.5) break;
  }

  return frames;
}
