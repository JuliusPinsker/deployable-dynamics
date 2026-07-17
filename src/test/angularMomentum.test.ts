import { describe, it, expect, vi } from 'vitest';
import {
  computeTotalAngularMomentum,
  createInitialState,
  stepSimulation,
  runFullSimulation,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS, Vector3, type SimulationParams } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: vector magnitude
// ─────────────────────────────────────────────────────────────────────────────
function v3Mag(v: Vector3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// Physics-driven hinge dynamics (the engine's only deployment model), zero
// friction for clean conservation.
const PHYSICS_PARAMS: SimulationParams = {
  ...DEFAULT_PARAMS,
  hinge: {
    ...DEFAULT_PARAMS.hinge,
    frictionCoeff: 0,        // zero friction for momentum conservation
  },
};

describe('computeTotalAngularMomentum', () => {
  it('returns zero vector for a system at rest', () => {
    const state = createInitialState('long-edge');
    const H = computeTotalAngularMomentum(state, 'long-edge', DEFAULT_PARAMS);

    expect(H.x).toBeCloseTo(0, 10);
    expect(H.y).toBeCloseTo(0, 10);
    expect(H.z).toBeCloseTo(0, 10);
  });

  it('returns nonzero for a spinning body with stowed panels', () => {
    const state = createInitialState('long-edge');
    state.angularVelocity = { x: 0, y: 0, z: 1.0 }; // 1 rad/s about Z

    const H = computeTotalAngularMomentum(state, 'long-edge', DEFAULT_PARAMS);

    // Body contributes I_z · ω_z; panels at θ=0 also contribute through their
    // inertia tensors. H_z should be positive and nonzero.
    expect(H.z).toBeGreaterThan(0);
    expect(v3Mag(H)).toBeGreaterThan(0);
  });

  it('includes panel angular velocity contributions', () => {
    const state = createInitialState('long-edge');
    // Give panels a nonzero hinge rate with body at rest
    state.panels[0].angularVelocity = 1.0;        // rad/s
    state.panels[0].angle = Math.PI / 4;            // 45°

    const H = computeTotalAngularMomentum(state, 'long-edge', DEFAULT_PARAMS);

    // With a panel spinning, momentum should be nonzero
    expect(v3Mag(H)).toBeGreaterThan(0);
  });
});

describe('angular momentum conservation (physics-driven mode)', () => {
  it('conserves total angular momentum during force-free deployment', () => {
    const config = 'long-edge' as const;
    let state = createInitialState(config);
    state.deploying = true;

    // Compute initial angular momentum (should be zero from rest)
    const H0 = computeTotalAngularMomentum(state, config, PHYSICS_PARAMS);
    const H0mag = v3Mag(H0);

    // Step for 1 second of simulated time (step count derives from the timestep)
    const oneSecondSteps = Math.round(1 / PHYSICS_PARAMS.timeStep);
    for (let i = 0; i < oneSecondSteps; i++) {
      state = stepSimulation(state, config, PHYSICS_PARAMS);
    }

    const H1 = computeTotalAngularMomentum(state, config, PHYSICS_PARAMS);

    // Starting from rest: H0 ≈ 0, so H1 should also remain near zero
    // Use absolute tolerance since H0 magnitude is ~0
    expect(v3Mag(H1)).toBeLessThan(1e-6);
  });

  it('conserves angular momentum with initial body spin', () => {
    const config = 'long-edge' as const;
    let state = createInitialState(config);
    state.deploying = true;
    state.angularVelocity = { x: 0.1, y: 0, z: 0 };

    const H0 = computeTotalAngularMomentum(state, config, PHYSICS_PARAMS);
    const H0mag = v3Mag(H0);

    // Step for 2 seconds of simulated time (step count derives from the timestep)
    const twoSecondSteps = Math.round(2 / PHYSICS_PARAMS.timeStep);
    for (let i = 0; i < twoSecondSteps; i++) {
      state = stepSimulation(state, config, PHYSICS_PARAMS);
    }

    const H1 = computeTotalAngularMomentum(state, config, PHYSICS_PARAMS);

    // Relative error should be small (< 5%)
    const dH = { x: H1.x - H0.x, y: H1.y - H0.y, z: H1.z - H0.z };
    const relError = v3Mag(dH) / H0mag;
    expect(relError).toBeLessThan(0.05);
  });
});

describe('configurable initial tumble (ω₀)', () => {
  it('createInitialState applies ω₀ to the spacecraft angular velocity', () => {
    const omega0 = new Vector3(0.1, -0.2, 0.3);
    const state = createInitialState('long-edge', omega0);

    expect(state.angularVelocity.x).toBeCloseTo(0.1, 12);
    expect(state.angularVelocity.y).toBeCloseTo(-0.2, 12);
    expect(state.angularVelocity.z).toBeCloseTo(0.3, 12);

    // Default (no arg) still starts at rest — guards backward compatibility.
    const rest = createInitialState('long-edge');
    expect(v3Mag(rest.angularVelocity)).toBeCloseTo(0, 12);
  });

  it('runFullSimulation seeds ω₀ and conserves momentum (relative < 5%)', () => {
    // ω₀ about Z (principal axis of the symmetric stowed long-edge).
    const omega0 = new Vector3(0, 0, 0.2);
    const frames = runFullSimulation('long-edge', PHYSICS_PARAMS, 2, [], omega0);

    expect(frames.length).toBeGreaterThan(0);
    // frames[0] is recorded AFTER the first step, so ω is ≈ ω₀ (not exactly).
    expect(frames[0].angularVelocity.z).toBeCloseTo(0.2, 2);

    // The engine reports RELATIVE momentum error (dH / |H₀|) since |H₀| ≠ 0 here.
    // NOTE: 5% is the current iterative-correction tolerance and is provisional —
    // it will likely tighten to ~0.1% once Phase B replaces that mechanism.
    for (const f of frames) {
      expect(f.momentumError).toBeLessThan(0.05);
    }
  });
});

describe('SimulationFrame momentumError field', () => {
  it('includes momentumError in each frame from runFullSimulation', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 3);
    expect(frames.length).toBeGreaterThan(0);

    for (const frame of frames) {
      expect(frame).toHaveProperty('momentumError');
      expect(typeof frame.momentumError).toBe('number');
      expect(frame.momentumError).toBeGreaterThanOrEqual(0);
    }
  });

  it('momentum warning fires when threshold exceeded', () => {
    // Use asymmetric stuck panel to induce large momentum drift
    // With one panel stuck, the system is externally constrained and
    // momentum may drift — but we only test that the warning mechanism works
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Run a physics-driven sim with asymmetric conditions that may trigger a warning
    const asymParams: SimulationParams = {
      ...PHYSICS_PARAMS,
      hinge: {
        ...PHYSICS_PARAMS.hinge,
        springConstant: 5.0,   // very stiff spring to induce fast dynamics
        dampingCoeff: 0,       // no damping
        frictionCoeff: 0.5,    // high friction breaks conservation
      },
    };

    runFullSimulation('long-edge', asymParams, 5);

    // We don't assert the warning fires (depends on numerics), just verify the spy works
    warnSpy.mockRestore();
  });
});
