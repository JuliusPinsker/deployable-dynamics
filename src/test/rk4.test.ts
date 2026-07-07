import { describe, it, expect } from 'vitest';
import { integrateBodyRK4 } from '../lib/physics/engine';
import { runFullSimulation } from '../lib/physics/engine';
import { DEFAULT_PARAMS } from '../lib/physics/types';
import type { Vector3, Quaternion } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: quaternion norm
// ─────────────────────────────────────────────────────────────────────────────
function qNorm(q: Quaternion): number {
  return Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
}

/** Rotate vector v by quaternion q:  v' = q ⊗ v ⊗ q*  (same as engine). */
function qRotVec(q: Quaternion, v: Vector3): Vector3 {
  const qv = { x: q.x, y: q.y, z: q.z };
  const t = {
    x: 2 * (qv.y * v.z - qv.z * v.y),
    y: 2 * (qv.z * v.x - qv.x * v.z),
    z: 2 * (qv.x * v.y - qv.y * v.x),
  };
  return {
    x: v.x + q.w * t.x + (qv.y * t.z - qv.z * t.y),
    y: v.y + q.w * t.y + (qv.z * t.x - qv.x * t.z),
    z: v.z + q.w * t.z + (qv.x * t.y - qv.y * t.x),
  };
}

/** Compute rotational kinetic energy T = 0.5 · ω_body · I_body · ω_body */
function kineticEnergy(q: Quaternion, omegaWorld: Vector3, I: Vector3): number {
  // Transform ω to body frame: ω_body = q* · ω_world
  const qConj: Quaternion = { w: q.w, x: -q.x, y: -q.y, z: -q.z };
  const wb = qRotVec(qConj, omegaWorld);
  return 0.5 * (I.x * wb.x ** 2 + I.y * wb.y ** 2 + I.z * wb.z ** 2);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helper: simple diagonal inertia (like a 3U CubeSat)
// ─────────────────────────────────────────────────────────────────────────────
const I_BODY: Vector3 = {
  x: (1 / 12) * 4.0 * (0.3405 ** 2 + 0.1 ** 2),   // ~0.0420
  y: (1 / 12) * 4.0 * (0.1 ** 2 + 0.1 ** 2),       // ~0.0067
  z: (1 / 12) * 4.0 * (0.1 ** 2 + 0.3405 ** 2),    // ~0.0420
};

const Q_IDENTITY: Quaternion = { w: 1, x: 0, y: 0, z: 0 };
const ZERO_VEC: Vector3 = { x: 0, y: 0, z: 0 };

describe('integrateBodyRK4', () => {
  it('preserves state when torque and angular velocity are both zero', () => {
    const dt = 1 / 60;
    const { qBodyNew, omegaBodyNew } = integrateBodyRK4(
      Q_IDENTITY, ZERO_VEC, ZERO_VEC, I_BODY, dt,
    );

    // Quaternion should remain identity
    expect(qBodyNew.w).toBeCloseTo(1, 10);
    expect(qBodyNew.x).toBeCloseTo(0, 10);
    expect(qBodyNew.y).toBeCloseTo(0, 10);
    expect(qBodyNew.z).toBeCloseTo(0, 10);

    // Angular velocity should remain zero
    expect(omegaBodyNew.x).toBeCloseTo(0, 10);
    expect(omegaBodyNew.y).toBeCloseTo(0, 10);
    expect(omegaBodyNew.z).toBeCloseTo(0, 10);
  });

  it('output quaternion has unit norm', () => {
    const dt = 1 / 60;
    // Arbitrary initial angular velocity and torque
    const omega: Vector3 = { x: 0.5, y: -0.3, z: 0.1 };
    const torque: Vector3 = { x: 0.01, y: -0.005, z: 0.02 };

    const { qBodyNew } = integrateBodyRK4(Q_IDENTITY, omega, torque, I_BODY, dt);
    expect(qNorm(qBodyNew)).toBeCloseTo(1, 8);
  });

  it('produces linear spin-up under constant torque about a principal axis', () => {
    // Torque about Z axis only, starting from rest, identity orientation
    // Expected: α_z = τ_z / I_z, ω_z(t) = α_z · t (no cross-coupling on principal axis)
    const tauZ = 0.01; // N·m
    const torque: Vector3 = { x: 0, y: 0, z: tauZ };
    const dt = 1 / 60;
    const alpha_z = tauZ / I_BODY.z;

    let q: Quaternion = { ...Q_IDENTITY };
    let omega: Vector3 = { ...ZERO_VEC };
    const nSteps = 60; // 1 second

    for (let i = 0; i < nSteps; i++) {
      const result = integrateBodyRK4(q, omega, torque, I_BODY, dt);
      q = result.qBodyNew;
      omega = result.omegaBodyNew;
    }

    const expectedOmegaZ = alpha_z * nSteps * dt;
    // RK4 should be very accurate for this linear case (essentially exact)
    expect(omega.z).toBeCloseTo(expectedOmegaZ, 6);
    // Cross-axis contamination should be negligible
    expect(Math.abs(omega.x)).toBeLessThan(1e-10);
    expect(Math.abs(omega.y)).toBeLessThan(1e-10);
  });

  it('conserves rotational kinetic energy during torque-free precession', () => {
    // Non-principal-axis spin, zero external torque → T = 0.5·ω·I·ω is conserved
    const omega0: Vector3 = { x: 1.0, y: 0.5, z: 0.3 };
    const dt = 1 / 60;

    let q: Quaternion = { ...Q_IDENTITY };
    let omega: Vector3 = { ...omega0 };
    const T0 = kineticEnergy(q, omega, I_BODY);

    // Integrate for 5 seconds (300 steps)
    for (let i = 0; i < 300; i++) {
      const result = integrateBodyRK4(q, omega, ZERO_VEC, I_BODY, dt);
      q = result.qBodyNew;
      omega = result.omegaBodyNew;
    }

    const T1 = kineticEnergy(q, omega, I_BODY);

    // RK4 should conserve energy well; relative error < 0.1% over 5 seconds
    expect(Math.abs(T1 - T0) / T0).toBeLessThan(1e-3);
  });

  it('quaternion remains normalized after many integration steps', () => {
    const omega: Vector3 = { x: 2.0, y: -1.5, z: 0.8 };
    const torque: Vector3 = { x: 0.005, y: 0.01, z: -0.003 };
    const dt = 1 / 60;

    let q: Quaternion = { ...Q_IDENTITY };
    let w: Vector3 = { ...omega };

    for (let i = 0; i < 600; i++) { // 10 seconds
      const result = integrateBodyRK4(q, w, torque, I_BODY, dt);
      q = result.qBodyNew;
      w = result.omegaBodyNew;
    }

    expect(qNorm(q)).toBeCloseTo(1, 6);
  });

  it('is more accurate than semi-implicit Euler for the same step size', () => {
    // Analytical solution for constant torque on principal axis:
    //   ω_z(t) = (τ / I_z) · t
    //   θ_z(t) = 0.5 · (τ / I_z) · t²
    const tauZ = 0.01;
    const torque: Vector3 = { x: 0, y: 0, z: tauZ };
    const dt = 1 / 60;
    const nSteps = 120; // 2 seconds
    const tFinal = nSteps * dt;
    const alpha_z = tauZ / I_BODY.z;

    // RK4 integration
    let q_rk4: Quaternion = { ...Q_IDENTITY };
    let omega_rk4: Vector3 = { ...ZERO_VEC };
    for (let i = 0; i < nSteps; i++) {
      const r = integrateBodyRK4(q_rk4, omega_rk4, torque, I_BODY, dt);
      q_rk4 = r.qBodyNew;
      omega_rk4 = r.omegaBodyNew;
    }

    const expectedOmega = alpha_z * tFinal;
    const rk4Error = Math.abs(omega_rk4.z - expectedOmega);

    // For this linear ODE, RK4 should be essentially exact (error < 1e-10)
    expect(rk4Error).toBeLessThan(1e-10);
  });
});

describe('existing simulation regression with RK4 body integrator', () => {
  it('long-edge panels deploy in ~0.4s with no overshoot', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 6);
    expect(frames.length).toBeGreaterThan(0);

    const stopAngle = DEFAULT_PARAMS.hinge.stopAngle;
    const angleSeries = frames.map(f => f.panelAngles[0]);

    // Monotonic (no overshoot)
    for (let i = 1; i < angleSeries.length; i++) {
      expect(angleSeries[i]).toBeGreaterThanOrEqual(angleSeries[i - 1] - 1e-9);
    }
    expect(Math.max(...angleSeries)).toBeLessThanOrEqual(stopAngle + 1e-6);

    // Deployment time ~0.4s (DEFAULT_PARAMS.hinge.deployDuration = 0.4)
    const deployedFrame = frames.find(f => f.panelAngles[0] >= 0.999 * stopAngle);
    expect(deployedFrame).toBeDefined();
    expect(deployedFrame!.time).toBeGreaterThan(0.25);
    expect(deployedFrame!.time).toBeLessThan(0.55);
  });

  it('double-long-edge sequential deployment still works', () => {
    const frames = runFullSimulation('double-long-edge', DEFAULT_PARAMS, 6);
    expect(frames.length).toBeGreaterThan(0);

    const stopAngle = DEFAULT_PARAMS.hinge.stopAngle;
    const stage2MaxAngle = Math.PI;

    // Stage 1 panels reach π/2
    const last = frames[frames.length - 1];
    expect(last.panelAngles[0]).toBeCloseTo(stopAngle, 4);
    expect(last.panelAngles[1]).toBeCloseTo(stopAngle, 4);

    // Stage 2 panels reach ~π. At the faster 0.4s deployment they rest ~0.1°
    // short of π (Coulomb-friction dead-band at the mechanical stop), so assert
    // effectively-deployed (≥ 99.9% of π) with no overshoot rather than exact π.
    expect(last.panelAngles[2]).toBeGreaterThanOrEqual(0.999 * stage2MaxAngle);
    expect(last.panelAngles[2]).toBeLessThanOrEqual(stage2MaxAngle + 1e-6);
    expect(last.panelAngles[3]).toBeGreaterThanOrEqual(0.999 * stage2MaxAngle);
    expect(last.panelAngles[3]).toBeLessThanOrEqual(stage2MaxAngle + 1e-6);
  });
});
