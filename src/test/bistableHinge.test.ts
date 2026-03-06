import { describe, it, expect } from 'vitest';
import { runFullSimulation } from '../lib/physics/engine';
import { DEFAULT_PARAMS, SimulationParams } from '../lib/physics/types';

/**
 * Bistable tape-spring hinge model tests.
 *
 * Double-well potential: U(θ) = A·[θ²·(θ − θ_max)²] − τ_preload·θ
 * Torque:  τ(θ) = −dU/dθ = −2A·θ·(θ − θ_max)·(2θ − θ_max) + τ_preload
 * Energy barrier height: U_barrier = A·θ_max⁴/16  (at θ = θ_max/2)
 *
 * The double-well has stable equilibria at θ = 0 (stowed) and θ = θ_max (deployed),
 * with an unstable equilibrium at θ = θ_max/2. Near θ = 0 the restoring torque
 * pulls the panel back toward stowed; a preload or release mechanism must overcome
 * the barrier to initiate deployment.
 *
 * References:
 *   Seffen & Pellegrino 1999 (Proc. R. Soc. A)
 *   Mallikarachchi & Pellegrino 2011 (AIAA J.)
 */

// Helper: compute bistable torque analytically
function bistableTorque(theta: number, thetaMax: number, A: number, preload: number): number {
  return -2 * A * theta * (theta - thetaMax) * (2 * theta - thetaMax) + preload;
}

// Helper: compute energy barrier height
function energyBarrier(thetaMax: number, A: number): number {
  return A * Math.pow(thetaMax, 4) / 16;
}

// Helper: compute snap-through angle (angle of maximum restoring torque near stowed)
function snapThroughAngle(thetaMax: number): number {
  // dτ/dθ = −2A(6θ² − 6θ_max·θ + θ_max²) = 0
  // θ = θ_max·(3 − √3) / 6
  return thetaMax * (3 - Math.sqrt(3)) / 6;
}

// Realistic bistable coefficient for 90° deployment
// For a 3U CFRP tape spring, energy barrier ≈ 0.5 N·m
// A = U_barrier × 16 / θ_max⁴ ≈ 0.5 × 16 / (π/2)⁴ ≈ 1.31 N·m/rad⁴
const THETA_MAX = Math.PI / 2;      // 90° stop angle
const REALISTIC_A = 1.31;           // N·m/rad⁴ — gives ~0.5 N·m barrier for 90° deployment
const THETA_SNAP = snapThroughAngle(THETA_MAX);

function makeBistableParams(overrides?: Partial<SimulationParams>): SimulationParams {
  return {
    ...DEFAULT_PARAMS,
    hinge: {
      ...DEFAULT_PARAMS.hinge,
      deployDuration: undefined,     // physics-driven, not kinematic
      preloadTorque: 0.05,           // moderate preload to initiate deployment
      dampingCoeff: 0.08,            // same as default linear
      hingeModel: 'bistable',
      bistability: {
        bistabilityCoeff: 0.01,      // very mild bistability, barrier ~0.004 N·m
        snapThroughAngle: THETA_SNAP,
      },
    },
    ...overrides,
  };
}

describe('Bistable tape-spring hinge — analytical torque', () => {
  it('torque is zero at θ = 0 (stowed equilibrium, ignoring preload)', () => {
    const tau = bistableTorque(0, THETA_MAX, REALISTIC_A, 0);
    expect(tau).toBeCloseTo(0, 6);
  });

  it('torque is zero at θ = θ_max (deployed equilibrium, ignoring preload)', () => {
    const tau = bistableTorque(THETA_MAX, THETA_MAX, REALISTIC_A, 0);
    expect(tau).toBeCloseTo(0, 6);
  });

  it('torque is zero at θ = θ_max/2 (unstable equilibrium, ignoring preload)', () => {
    const tau = bistableTorque(THETA_MAX / 2, THETA_MAX, REALISTIC_A, 0);
    expect(tau).toBeCloseTo(0, 6);
  });

  it('torque is negative just after θ = 0 (restores toward stowed well)', () => {
    // In a double-well potential, near θ=0 the hinge resists opening (restoring to stowed)
    const tau = bistableTorque(0.01, THETA_MAX, REALISTIC_A, 0);
    expect(tau).toBeLessThan(0);
  });

  it('torque is negative just before θ_max/2 (resists crossing barrier)', () => {
    const tau = bistableTorque(THETA_MAX / 2 - 0.01, THETA_MAX, REALISTIC_A, 0);
    expect(tau).toBeLessThan(0);
  });

  it('torque is positive just after θ_max/2 (drives toward deployed well)', () => {
    const tau = bistableTorque(THETA_MAX / 2 + 0.01, THETA_MAX, REALISTIC_A, 0);
    expect(tau).toBeGreaterThan(0);
  });

  it('energy barrier U_barrier = A·θ_max⁴/16', () => {
    const expected = energyBarrier(THETA_MAX, REALISTIC_A);
    // Verify directly: U(θ_max/2) = A·(θ_max/2)²·(θ_max/2 − θ_max)² = A·θ_max⁴/16
    const thetaMid = THETA_MAX / 2;
    const Ubarrier = REALISTIC_A * Math.pow(thetaMid, 2) * Math.pow(thetaMid - THETA_MAX, 2);
    expect(Ubarrier).toBeCloseTo(expected, 10);
  });

  it('energy barrier is ~0.3–0.8 N·m for realistic A', () => {
    const barrier = energyBarrier(THETA_MAX, REALISTIC_A);
    expect(barrier).toBeGreaterThan(0.3);
    expect(barrier).toBeLessThan(0.8);
  });

  it('preload shifts all torque values uniformly', () => {
    const preload = 0.01;
    const tauNoPreload = bistableTorque(0.3, THETA_MAX, REALISTIC_A, 0);
    const tauWithPreload = bistableTorque(0.3, THETA_MAX, REALISTIC_A, preload);
    expect(tauWithPreload - tauNoPreload).toBeCloseTo(preload, 10);
  });
});

describe('Bistable tape-spring hinge — simulation integration', () => {
  it('bistable hinge deploys panel to stop angle', () => {
    const params = makeBistableParams();
    const frames = runFullSimulation('long-edge', params, 8);
    expect(frames.length).toBeGreaterThan(0);

    const lastFrame = frames[frames.length - 1];
    const finalAngle = lastFrame.panelAngles[0];
    // Panel should reach near stop angle (within 5%)
    expect(finalAngle).toBeGreaterThan(params.hinge.stopAngle * 0.95);
  });

  it('bistable simulation runs without NaN or Infinity', () => {
    const params = makeBistableParams();
    const frames = runFullSimulation('long-edge', params, 4);
    expect(frames.length).toBeGreaterThan(0);

    for (const frame of frames) {
      for (const angle of frame.panelAngles) {
        expect(Number.isFinite(angle)).toBe(true);
      }
      expect(Number.isFinite(frame.angularVelocity.x)).toBe(true);
      expect(Number.isFinite(frame.angularVelocity.y)).toBe(true);
      expect(Number.isFinite(frame.angularVelocity.z)).toBe(true);
    }
  });

  it('linear hinge model still works (backward compatibility)', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 4);
    expect(frames.length).toBeGreaterThan(0);

    const lastFrame = frames[frames.length - 1];
    expect(lastFrame.panelAngles[0]).toBeGreaterThan(DEFAULT_PARAMS.hinge.stopAngle * 0.95);
  });

  it('explicit hingeModel="linear" behaves same as default', () => {
    const paramsLinear: SimulationParams = {
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        hingeModel: 'linear',
      },
    };
    const framesDefault = runFullSimulation('long-edge', DEFAULT_PARAMS, 3);
    const framesLinear = runFullSimulation('long-edge', paramsLinear, 3);

    expect(framesDefault.length).toBe(framesLinear.length);
    const lastDefault = framesDefault[framesDefault.length - 1];
    const lastLinear = framesLinear[framesLinear.length - 1];
    expect(lastLinear.panelAngles[0]).toBeCloseTo(lastDefault.panelAngles[0], 6);
  });

  it('bistable hinge with high A traps panel in stowed well without sufficient preload', () => {
    const params = makeBistableParams({
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        deployDuration: undefined,
        preloadTorque: 0.001,        // very small preload — insufficient to escape well
        dampingCoeff: 0.12,
        hingeModel: 'bistable',
        bistability: {
          bistabilityCoeff: 10,       // strong bistability
          snapThroughAngle: THETA_SNAP,
        },
      },
    });
    const frames = runFullSimulation('long-edge', params, 4);
    expect(frames.length).toBeGreaterThan(0);

    const lastFrame = frames[frames.length - 1];
    // Panel should remain near stowed (< 30°)
    expect(lastFrame.panelAngles[0]).toBeLessThan(Math.PI / 6);
  });
});

describe('Bistable tape-spring hinge — snap-through angle', () => {
  it('snap-through angle is θ_max·(3−√3)/6', () => {
    const computed = snapThroughAngle(THETA_MAX);
    const expected = THETA_MAX * (3 - Math.sqrt(3)) / 6;
    expect(computed).toBeCloseTo(expected, 10);
  });

  it('snap-through angle is less than θ_max/2', () => {
    expect(THETA_SNAP).toBeLessThan(THETA_MAX / 2);
  });

  it('snap-through angle is positive', () => {
    expect(THETA_SNAP).toBeGreaterThan(0);
  });

  it('for θ_max = π/2, snap-through ≈ 0.33 rad (≈19°)', () => {
    expect(THETA_SNAP).toBeCloseTo(0.33, 1);
  });
});
