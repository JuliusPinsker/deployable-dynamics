import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  stepSimulation,
  runFullSimulation,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS } from '../lib/physics/types';
import type { SimulationParams } from '../lib/physics/types';
import { DEFAULT_THERMAL_PARAMS } from '../lib/physics/thermalModel';

describe('thermal model integration with engine', () => {
  describe('createInitialState with thermal params', () => {
    it('initializes thermalState when thermalParams provided', () => {
      const state = createInitialState('long-edge', DEFAULT_THERMAL_PARAMS);
      expect(state.thermalState).toBeDefined();
      expect(state.thermalParams).toBeDefined();
      expect(state.thermalState!.currentTemperatureDeg).toBe(
        DEFAULT_THERMAL_PARAMS.sunlightTemperatureDeg,
      );
    });

    it('thermalState is undefined when thermalParams not provided', () => {
      const state = createInitialState('long-edge');
      expect(state.thermalState).toBeUndefined();
      expect(state.thermalParams).toBeUndefined();
    });

    it('preserves backward compatibility with existing callers', () => {
      // Should work exactly as before when called without thermal params
      const state = createInitialState('long-edge');
      expect(state.deploying).toBe(false);
      expect(state.panels.length).toBe(2);
      expect(state.time).toBe(0);
    });
  });

  describe('stepSimulation with thermal model', () => {
    it('advances thermal state each timestep', () => {
      let state = createInitialState('long-edge', DEFAULT_THERMAL_PARAMS);
      state.deploying = true;

      const params: SimulationParams = {
        ...DEFAULT_PARAMS,
        thermal: DEFAULT_THERMAL_PARAMS,
      };

      const initialPhase = state.thermalState!.orbitPhaseRad;
      state = stepSimulation(state, 'long-edge', params);

      expect(state.thermalState).toBeDefined();
      expect(state.thermalState!.orbitPhaseRad).toBeGreaterThan(initialPhase);
    });

    it('does not crash when thermal model is disabled', () => {
      let state = createInitialState('long-edge');
      state.deploying = true;

      // No thermal params — should work fine
      state = stepSimulation(state, 'long-edge', DEFAULT_PARAMS);
      expect(state.thermalState).toBeUndefined();
    });

    it('applies thermal stiffness in physics-driven mode', () => {
      // Physics-driven params (no kinematic override)
      const physicsParams: SimulationParams = {
        ...DEFAULT_PARAMS,
        hinge: {
          ...DEFAULT_PARAMS.hinge,
          deployDuration: undefined as unknown as number,
        },
        thermal: {
          ...DEFAULT_THERMAL_PARAMS,
          sunlightTemperatureDeg: 100, // Hot → lower stiffness
        },
      };
      delete (physicsParams.hinge as Record<string, unknown>).deployDuration;

      let state = createInitialState('long-edge', physicsParams.thermal);
      state.deploying = true;

      // Step a few times — should not crash and thermal state should update
      for (let i = 0; i < 10; i++) {
        state = stepSimulation(state, 'long-edge', physicsParams);
      }

      expect(state.thermalState).toBeDefined();
      // Stiffness multiplier should be < 1 because temp > reference
      expect(state.thermalState!.stiffnessMultiplier).toBeLessThan(1);
    });
  });

  describe('SimulationFrame thermal fields', () => {
    it('includes thermal data in frames when thermal model active', () => {
      const params: SimulationParams = {
        ...DEFAULT_PARAMS,
        thermal: DEFAULT_THERMAL_PARAMS,
      };

      const frames = runFullSimulation('long-edge', params, 3);
      expect(frames.length).toBeGreaterThan(0);

      for (const frame of frames) {
        expect(frame.thermalTemperatureDeg).toBeDefined();
        expect(frame.stiffnessMultiplier).toBeDefined();
        expect(typeof frame.thermalTemperatureDeg).toBe('number');
        expect(typeof frame.stiffnessMultiplier).toBe('number');
      }
    });

    it('thermal fields are undefined when thermal model inactive', () => {
      const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 3);
      expect(frames.length).toBeGreaterThan(0);

      // Without thermal params, these should be undefined
      expect(frames[0].thermalTemperatureDeg).toBeUndefined();
      expect(frames[0].stiffnessMultiplier).toBeUndefined();
    });
  });

  describe('backward compatibility', () => {
    it('existing simulation tests still pass with thermal integration', () => {
      // Long-edge deployment should still work exactly as before
      const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 6);
      expect(frames.length).toBeGreaterThan(0);

      const stopAngle = DEFAULT_PARAMS.hinge.stopAngle;
      const deployedFrame = frames.find(f => f.panelAngles[0] >= 0.999 * stopAngle);
      expect(deployedFrame).toBeDefined();
      expect(deployedFrame!.time).toBeGreaterThan(1.75);
      expect(deployedFrame!.time).toBeLessThan(2.25);
    });

    it('double-long-edge sequential deployment unchanged', () => {
      const frames = runFullSimulation('double-long-edge', DEFAULT_PARAMS, 6);
      expect(frames.length).toBeGreaterThan(0);

      const last = frames[frames.length - 1];
      expect(last.panelAngles[0]).toBeCloseTo(Math.PI / 2, 4);
      expect(last.panelAngles[2]).toBeCloseTo(Math.PI, 4);
    });
  });
});
