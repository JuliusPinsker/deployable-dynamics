import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  stepSimulation,
  runFullSimulation,
  computeSystemCoM,
  computeTotalAngularMomentum,
} from '../lib/physics/engine';
import {
  runScenarioTrajectory,
  materialMasses,
} from '../lib/physics/reportData';
import {
  DEFAULT_PARAMS,
  MATERIAL_PRESETS,
  Vector3,
  type SimulationParams,
} from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Deployment-mode scope guard (Phase-B prerequisite)
//
//  The physics-driven torsional-hinge path is the ONLY deployment model: the
//  kinematic ease-out ("visual demo") path and its `deployDuration` knob were
//  removed. These tests pin that decision so it cannot silently regress:
//    1. physics-driven is the default (no kinematic knob in DEFAULT_PARAMS),
//    2. the report/batch path cannot run a prescribed-motion profile,
//    3. a nominal physics run applies real (nonzero) hinge torque while active,
//    4. material panel mass flows dynamically into dynamics and CoM.
// ─────────────────────────────────────────────────────────────────────────────

describe('physics-driven deployment is the default and only mode', () => {
  it('DEFAULT_PARAMS carries no kinematic deployment knob', () => {
    expect('deployDuration' in DEFAULT_PARAMS.hinge).toBe(false);
  });

  it('a DEFAULT_PARAMS run follows hinge dynamics, not the old prescribed 0.4 s profile', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 2);
    // Under the removed kinematic profile the panel was fully deployed at 0.4 s.
    // Under the calibrated lightly damped spring (ωₙ ≈ 1.2 rad/s) it is only
    // ~11% deployed at 0.4 s (1 − cos(ωₙ·t) ≈ 0.11).
    const at04 = frames.find(f => f.time >= 0.4)!;
    expect(at04.panelAngles[0]).toBeLessThan(0.5 * DEFAULT_PARAMS.hinge.stopAngle);
    // …but it IS moving (dynamics active, not held).
    expect(frames.at(-1)!.panelAngles[0]).toBeGreaterThan(0);
  });

  it('engine ignores a legacy deployDuration value smuggled into params (no demo-mode backdoor)', () => {
    const smuggled = {
      ...DEFAULT_PARAMS,
      hinge: { ...DEFAULT_PARAMS.hinge, deployDuration: 2 },
    } as unknown as SimulationParams;

    const clean = runFullSimulation('long-edge', DEFAULT_PARAMS, 3);
    const withKnob = runFullSimulation('long-edge', smuggled, 3);

    expect(withKnob.length).toBe(clean.length);
    for (let i = 0; i < clean.length; i++) {
      expect(withKnob[i].panelAngles).toEqual(clean[i].panelAngles);
      expect(withKnob[i].angularVelocity).toEqual(clean[i].angularVelocity);
    }
  });
});

describe('scientific report path is physics-driven only', () => {
  it('report scenario params contain no prescribed-motion field and use DEFAULT hinge dynamics', () => {
    // failureMode only affects which panels are stuck, never `params` itself — any
    // valid long-edge mode exercises the same params-construction path.
    const { params } = runScenarioTrajectory('long-edge', 'one-stuck', 'fr4');
    expect('deployDuration' in params.hinge).toBe(false);
    expect(params.hinge.springConstant).toBe(DEFAULT_PARAMS.hinge.springConstant);
    expect(params.hinge.dampingCoeff).toBe(DEFAULT_PARAMS.hinge.dampingCoeff);
  });

  it('report trajectories evolve on the dynamics timescale, not a prescribed profile', () => {
    // one-stuck holds panel 0; panel 1 is the free panel actually deploying under
    // real hinge dynamics (every valid long-edge Report mode holds panel 0 — there
    // is no longer a "nothing stuck" mode to observe panel 0 deploying through).
    const { trajectory } = runScenarioTrajectory('long-edge', 'one-stuck', 'fr4');
    const at04 = trajectory.find(f => f.time >= 0.4)!;
    // A prescribed ease-out (0.4 s or 2 s variants) would be ≥ 50% deployed here;
    // the physics hinge has covered only a small fraction of travel.
    expect(at04.panelAngles[1]).toBeLessThan(0.5 * DEFAULT_PARAMS.hinge.stopAngle);
    // The run still completes: the friction-dead-band latch holds the stop exactly.
    expect(trajectory.at(-1)!.panelAngles[1]).toBeCloseTo(DEFAULT_PARAMS.hinge.stopAngle, 9);
    // Panel 0 stays held at its stuck angle throughout.
    expect(trajectory.at(-1)!.panelAngles[0]).toBe(0);
  });

  it('report runs apply nonzero hinge torque while panels are active', () => {
    const { params, stuckPanels } = runScenarioTrajectory('long-edge', 'one-stuck', 'fr4');
    let state = createInitialState('long-edge');
    state.deploying = true;
    for (const idx of stuckPanels) state.panels[idx].stuck = true;
    const oneSecond = Math.round(1 / params.timeStep);
    for (let i = 0; i < oneSecond; i++) state = stepSimulation(state, 'long-edge', params);
    for (let i = 0; i < state.panels.length; i++) {
      const panel = state.panels[i];
      if (stuckPanels.includes(i)) {
        expect(panel.hingeTorque).toBe(0); // held stuck — no torque
      } else {
        expect(panel.deployed).toBe(false); // still mid-deployment at t = 1 s
        expect(Math.abs(panel.hingeTorque)).toBeGreaterThan(0);
      }
    }
  });
});

describe('nominal physics run — hinge torque telemetry', () => {
  it('active panels carry nonzero hinge torque; stuck panels carry zero', () => {
    let state = createInitialState('long-edge');
    state.deploying = true;
    state.panels[0].stuck = true;
    state.panels[0].stuckAngle = 0;

    const oneSecond = Math.round(1 / DEFAULT_PARAMS.timeStep);
    for (let i = 0; i < oneSecond; i++) state = stepSimulation(state, 'long-edge', DEFAULT_PARAMS);

    expect(Math.abs(state.panels[1].hingeTorque)).toBeGreaterThan(0);
    expect(state.panels[0].hingeTorque).toBe(0);
  });

  it('hinge torque returns to zero once the panel latches deployed', () => {
    let state = createInitialState('long-edge');
    state.deploying = true;
    const maxSteps = Math.ceil(30 / DEFAULT_PARAMS.timeStep);
    for (let i = 0; i < maxSteps && !state.panels[0].deployed; i++) {
      state = stepSimulation(state, 'long-edge', DEFAULT_PARAMS);
    }
    expect(state.panels[0].deployed).toBe(true);
    state = stepSimulation(state, 'long-edge', DEFAULT_PARAMS);
    expect(state.panels[0].hingeTorque).toBe(0);
  });
});

describe('material panel mass flows dynamically (no hard-coded masses)', () => {
  it('materialMasses is derived from MATERIAL_PRESETS and feeds report params', () => {
    for (const preset of MATERIAL_PRESETS) {
      expect(materialMasses[preset.key]).toBe(preset.panelMass);
      const { params } = runScenarioTrajectory('long-edge', 'one-stuck', preset.key);
      expect(params.panelMass).toBe(preset.panelMass);
    }
  });

  it('different material masses produce different asymmetric-deployment dynamics', () => {
    const peakOmega = (material: 'fr4' | 'al-kapton') => {
      const { trajectory } = runScenarioTrajectory('long-edge', 'one-stuck', material);
      return Math.max(
        ...trajectory.map(f =>
          new Vector3(f.angularVelocity.x, f.angularVelocity.y, f.angularVelocity.z).length(),
        ),
      );
    };
    const fr4Peak = peakOmega('fr4');
    const alKaptonPeak = peakOmega('al-kapton');
    expect(fr4Peak).toBeGreaterThan(0);
    expect(alKaptonPeak).toBeGreaterThan(0);
    // Heavier panels exchange more momentum with the body — the peak must differ
    // by well over numerical noise.
    expect(Math.abs(alKaptonPeak - fr4Peak) / fr4Peak).toBeGreaterThan(0.05);
  });

  it('panel inertia scales with each material panelMass (H ∝ m for a pure hinge rate)', () => {
    // With the body at rest and one panel spinning about its hinge, the total
    // angular momentum comes solely from the panel inertia tensor — which must
    // be built from params.panelMass, so |H| must scale exactly with the mass.
    const Hmag = (panelMass: number) => {
      const params: SimulationParams = { ...DEFAULT_PARAMS, panelMass };
      const state = createInitialState('long-edge');
      state.panels[0].angularVelocity = 1.0;   // rad/s about the hinge
      state.panels[0].angle = Math.PI / 4;
      const H = computeTotalAngularMomentum(state, 'long-edge', params);
      return new Vector3(H.x, H.y, H.z).length();
    };
    const base = Hmag(materialMasses.fr4);
    expect(base).toBeGreaterThan(0);
    for (const preset of MATERIAL_PRESETS) {
      const ratio = Hmag(preset.panelMass) / base;
      expect(ratio).toBeCloseTo(preset.panelMass / materialMasses.fr4, 9);
    }
  });

  it('panel mass changes the composite CoM offset for an asymmetric deployed state', () => {
    const offsetFor = (panelMass: number) => {
      const params: SimulationParams = { ...DEFAULT_PARAMS, panelMass };
      const state = createInitialState('long-edge');
      state.panels[0] = { ...state.panels[0], stuck: true, stuckAngle: 0 };
      state.panels[1] = { ...state.panels[1], angle: Math.PI / 2, deployed: true };
      return computeSystemCoM(state, 'long-edge', params).offsetMm;
    };
    const light = offsetFor(materialMasses.cfrp);
    const heavy = offsetFor(materialMasses['al-kapton']);
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light);
  });
});
