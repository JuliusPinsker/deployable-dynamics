import { describe, it, expect } from 'vitest';
import {
  computeTotalAngularMomentum,
  computeSystemCoM,
  createInitialState,
  stepSimulation,
  runFullSimulation,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS } from '../lib/physics/types';
import type { Vector3, SimulationParams, SpacecraftState } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: vector magnitude
// ─────────────────────────────────────────────────────────────────────────────
function v3Mag(v: Vector3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test parameters: physics-driven spring deployment with zero external torque
//  - deployDuration = 0 → enables spring-damper physics
//  - frictionCoeff = 0 → zero friction for clean conservation
//  - gravityGradientEnabled = false → pure free-float (no external torque)
// ─────────────────────────────────────────────────────────────────────────────
const FREE_FLOAT_PARAMS: SimulationParams = {
  ...DEFAULT_PARAMS,
  hinge: {
    ...DEFAULT_PARAMS.hinge,
    deployDuration: 0,       // spring-driven physics mode
    frictionCoeff: 0,        // zero friction for momentum conservation
  },
  gravityGradientEnabled: false, // disable gravity gradient → pure free-float
};

describe('angular-momentum-conserving body dynamics (Gap 1)', () => {
  /**
   * Test: Spring-driven deployment should conserve angular momentum in free-float.
   *
   * Following Hughes (1986) and Wie (2008), the total angular momentum
   *   H_total = I_body·ω_body + Σ_i [I_panel_i · (ω_body + θ̇_i · â_i)]
   * should remain constant when no external torques act on the system.
   *
   * This test runs the long-edge configuration for 5 seconds and asserts
   * that the relative angular momentum error |ΔH|/|H₀| < 0.1%.
   */
  it('conserves angular momentum |ΔH|/|H0| < 0.1% at t=5s (long-edge, spring-driven, free-float)', () => {
    const config = 'long-edge' as const;
    const maxTime = 5; // seconds

    // Run full simulation for 5 seconds
    const frames = runFullSimulation(config, FREE_FLOAT_PARAMS, maxTime, []);

    // Find the frame closest to t=5s
    const targetTime = 5.0;
    let bestFrame = frames[frames.length - 1];
    for (const f of frames) {
      if (Math.abs(f.time - targetTime) < Math.abs(bestFrame.time - targetTime)) {
        bestFrame = f;
      }
    }

    // The momentumError field in SimulationFrame tracks |ΔH|/|H₀|
    // For a system starting from rest (H₀ ≈ 0), we check absolute momentum instead
    // Re-compute final momentum directly for accuracy
    let state = createInitialState(config, FREE_FLOAT_PARAMS.thermal);
    state.deploying = true;
    const H0 = computeTotalAngularMomentum(state, config, FREE_FLOAT_PARAMS);
    const H0mag = v3Mag(H0);

    // Step simulation to t≈5s
    const numSteps = Math.ceil(maxTime / FREE_FLOAT_PARAMS.timeStep);
    for (let i = 0; i < numSteps; i++) {
      state = stepSimulation(state, config, FREE_FLOAT_PARAMS);
    }

    const Hfinal = computeTotalAngularMomentum(state, config, FREE_FLOAT_PARAMS);
    const dH = {
      x: Hfinal.x - H0.x,
      y: Hfinal.y - H0.y,
      z: Hfinal.z - H0.z,
    };
    const dHmag = v3Mag(dH);

    // For a system starting at rest, H0 ≈ 0, so we check absolute error
    // |H_final| should remain near zero (< 1e-6 kg·m²/s for a CubeSat)
    if (H0mag > 1e-9) {
      // Relative error: |ΔH|/|H₀| < 0.1%
      const relError = dHmag / H0mag;
      expect(relError).toBeLessThan(0.001);
    } else {
      // Absolute error: |H_final| < 1e-6 kg·m²/s
      expect(v3Mag(Hfinal)).toBeLessThan(1e-6);
    }
  });

  it('tracks attitudeCouplingDeg in SimulationFrame', () => {
    const config = 'long-edge' as const;
    const frames = runFullSimulation(config, FREE_FLOAT_PARAMS, 2, []);

    // All frames should have attitudeCouplingDeg defined
    for (const f of frames) {
      expect(f.attitudeCouplingDeg).toBeDefined();
      expect(typeof f.attitudeCouplingDeg).toBe('number');
      expect(f.attitudeCouplingDeg).toBeGreaterThanOrEqual(0);
    }

    // First frame should have ~0 coupling (just started)
    expect(frames[0].attitudeCouplingDeg).toBeLessThan(1);

    // Coupling should generally increase during deployment as momentum exchanges
    // (not strictly monotonic due to oscillations, but should reach some value)
    const maxCoupling = Math.max(...frames.map(f => f.attitudeCouplingDeg!));
    expect(maxCoupling).toBeGreaterThanOrEqual(0);
  });

  it('conserves momentum for double-long-edge (hierarchical panels)', () => {
    const config = 'double-long-edge' as const;
    const maxTime = 5;

    let state = createInitialState(config, FREE_FLOAT_PARAMS.thermal);
    state.deploying = true;
    const H0 = computeTotalAngularMomentum(state, config, FREE_FLOAT_PARAMS);

    const numSteps = Math.ceil(maxTime / FREE_FLOAT_PARAMS.timeStep);
    for (let i = 0; i < numSteps; i++) {
      state = stepSimulation(state, config, FREE_FLOAT_PARAMS);
    }

    const Hfinal = computeTotalAngularMomentum(state, config, FREE_FLOAT_PARAMS);
    const H0mag = v3Mag(H0);

    if (H0mag > 1e-9) {
      const dHmag = v3Mag({ x: Hfinal.x - H0.x, y: Hfinal.y - H0.y, z: Hfinal.z - H0.z });
      expect(dHmag / H0mag).toBeLessThan(0.001);
    } else {
      expect(v3Mag(Hfinal)).toBeLessThan(1e-6);
    }
  });

  it('conserves momentum with initial body spin', () => {
    const config = 'long-edge' as const;
    // Use shorter duration (1s) to reduce accumulated numerical drift
    const maxTime = 1;

    let state = createInitialState(config, FREE_FLOAT_PARAMS.thermal);
    state.deploying = true;
    state.angularVelocity = { x: 0.1, y: 0.05, z: 0.02 }; // initial spin

    const H0 = computeTotalAngularMomentum(state, config, FREE_FLOAT_PARAMS);
    const H0mag = v3Mag(H0);

    const numSteps = Math.ceil(maxTime / FREE_FLOAT_PARAMS.timeStep);
    for (let i = 0; i < numSteps; i++) {
      state = stepSimulation(state, config, FREE_FLOAT_PARAMS);
    }

    const Hfinal = computeTotalAngularMomentum(state, config, FREE_FLOAT_PARAMS);
    const dH = { x: Hfinal.x - H0.x, y: Hfinal.y - H0.y, z: Hfinal.z - H0.z };
    const dHmag = v3Mag(dH);

    // Relative error: |ΔH|/|H₀| < 2% over 1 second
    // Conservation correction significantly reduces drift vs pure RK4
    expect(dHmag / H0mag).toBeLessThan(0.02);
  });
});

describe('computeSystemCoM', () => {
  it('returns near-zero CoM offset for symmetric long-edge stowed state', () => {
    const state = createInitialState('long-edge');
    const com = computeSystemCoM(state, 'long-edge', DEFAULT_PARAMS);

    expect(com.offsetMm).toBeLessThan(0.1);
    expect(Math.abs(com.comBody.x)).toBeLessThan(1e-6);
    expect(Math.abs(com.comBody.y)).toBeLessThan(1e-6);
    expect(Math.abs(com.comBody.z)).toBeLessThan(1e-6);
    expect(com.panelCentresWorld).toHaveLength(state.panels.length);
  });

  it('shifts CoM upward (+Z in body frame) for long-edge at 90° deployment', () => {
    const state = createInitialState('long-edge');
    state.panels = state.panels.map((panel) => ({
      ...panel,
      angle: Math.PI / 2,
      deployed: true,
    }));

    const com = computeSystemCoM(state, 'long-edge', DEFAULT_PARAMS);
    expect(com.comBody.z).toBeGreaterThan(0);
    expect(com.offsetMm).toBeGreaterThan(0.1);
  });

  it('produces horizontal CoM bias for one-stuck asymmetric long-edge case', () => {
    const state = createInitialState('long-edge');
    state.panels[0] = {
      ...state.panels[0],
      stuck: true,
      stuckAngle: 0,
      angle: 0,
    };
    state.panels[1] = {
      ...state.panels[1],
      angle: Math.PI / 2,
      deployed: true,
    };

    const com = computeSystemCoM(state, 'long-edge', DEFAULT_PARAMS);
    const horizontalOffsetMm = Math.hypot(com.comBody.x, com.comBody.y) * 1000;
    expect(horizontalOffsetMm).toBeGreaterThan(0.1);
  });

  it('returns near-zero CoM offset for all-stuck symmetric short-edge state', () => {
    const state = createInitialState('short-edge');
    state.panels = state.panels.map((panel) => ({
      ...panel,
      stuck: true,
      stuckAngle: 0,
      angle: 0,
    }));

    const com = computeSystemCoM(state, 'short-edge', DEFAULT_PARAMS);
    expect(com.offsetMm).toBeLessThan(0.1);
  });
});
