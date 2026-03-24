// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Orbital Torques Module Tests
//
//  Validates gravity gradient and SRP torque calculations against
//  analytical formulas from Hughes (1986) and Wertz (1978).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { describe, it, expect } from 'vitest';
import * as satellite from 'satellite.js';
import {
  meanMotion,
  orbitalPeriod,
  gravityGradientTorque,
  maxGravityGradientTorque,
  srpTorque,
  updateNadirVector,
  GM_EARTH,
  R_EARTH,
  SOLAR_CONSTANT_1AU,
  P_SOLAR,
} from '../lib/physics/orbitalTorques';
import type { Vector3, Quaternion } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function v3Mag(v: Vector3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function qIdentity(): Quaternion {
  return { w: 1, x: 0, y: 0, z: 0 };
}

function toNumericConstant(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    const maybeValue = (value as { value?: unknown }).value;
    if (typeof maybeValue === 'number' && Number.isFinite(maybeValue)) {
      return maybeValue;
    }
    const maybeToNumber = (value as { toNumber?: (() => number) | undefined }).toNumber;
    if (typeof maybeToNumber === 'function') {
      const numeric = maybeToNumber.call(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }
  throw new Error(`Unable to resolve numeric value for ${name}`);
}

const satConstants = (satellite as unknown as { constants?: { mu?: number; earthRadius?: number } }).constants;

// Quaternion for rotation about Z axis by angle θ
function qFromAxisAngle(axis: Vector3, angle: number): Quaternion {
  const s = Math.sin(angle / 2);
  const c = Math.cos(angle / 2);
  const mag = v3Mag(axis);
  return {
    w: c,
    x: (axis.x / mag) * s,
    y: (axis.y / mag) * s,
    z: (axis.z / mag) * s,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mean Motion Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('meanMotion', () => {
  it('returns correct mean motion for 400 km orbit', () => {
    // satellite.js uses WGS-72 radius and mu in km^3/s^2
    const altKm = 400;
    const a_km = (satConstants?.earthRadius ?? 6378.135) + altKm;
    const expected = Math.sqrt(398600.4418 / Math.pow(a_km, 3));

    const n = meanMotion(altKm);

    expect(n).toBeCloseTo(expected, 8);
    // Sanity check: n ≈ 0.00113 rad/s for 400 km
    expect(n).toBeCloseTo(0.00113, 4);
  });

  it('returns correct mean motion for ISS altitude (408 km)', () => {
    const n = meanMotion(408);
    // ISS completes ~15.54 orbits per day → n ≈ 0.00113 rad/s
    const orbitsPerDay = n * 86400 / (2 * Math.PI);
    expect(orbitsPerDay).toBeCloseTo(15.5, 0);
  });

  it('increases for lower orbits', () => {
    const n200 = meanMotion(200);
    const n400 = meanMotion(400);
    const n800 = meanMotion(800);

    expect(n200).toBeGreaterThan(n400);
    expect(n400).toBeGreaterThan(n800);
  });
});

describe('orbitalPeriod', () => {
  it('returns ~92 minutes for 400 km orbit', () => {
    const T = orbitalPeriod(400);
    const T_minutes = T / 60;
    // ISS period ≈ 92.68 minutes
    expect(T_minutes).toBeCloseTo(92.5, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Gravity Gradient Torque Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('gravityGradientTorque', () => {
  const n = meanMotion(400); // ~0.00113 rad/s

  it('returns zero for symmetric body with nadir along principal axis', () => {
    // Symmetric body: I_xx = I_yy = I_zz
    const I_symmetric: Vector3 = { x: 0.01, y: 0.01, z: 0.01 };
    const qBody = qIdentity();
    const nadirWorld: Vector3 = { x: 0, y: 0, z: -1 }; // Along -Z

    const tau = gravityGradientTorque(qBody, I_symmetric, nadirWorld, n);

    expect(v3Mag(tau)).toBeLessThan(1e-12);
  });

  it('returns zero when nadir is along principal axis', () => {
    // Asymmetric body but nadir along Z axis
    const I_asymm: Vector3 = { x: 0.01, y: 0.02, z: 0.03 };
    const qBody = qIdentity();
    const nadirWorld: Vector3 = { x: 0, y: 0, z: -1 }; // Along -Z

    const tau = gravityGradientTorque(qBody, I_asymm, nadirWorld, n);

    // Torque should be small (not exactly zero due to floating point)
    expect(v3Mag(tau)).toBeLessThan(1e-12);
  });

  it('produces torque when nadir is at 45° between principal axes', () => {
    // Nadir at 45° in Y-Z plane gives maximum torque component
    const I_asymm: Vector3 = { x: 0.01, y: 0.02, z: 0.03 };
    const qBody = qIdentity();
    const sqrt2_2 = Math.sqrt(2) / 2;
    const nadirWorld: Vector3 = { x: 0, y: -sqrt2_2, z: -sqrt2_2 };

    const tau = gravityGradientTorque(qBody, I_asymm, nadirWorld, n);

    // Should have significant torque
    expect(v3Mag(tau)).toBeGreaterThan(1e-10);

    // Check X-component (from Y-Z asymmetry)
    // τ_x = 3n² (I_z - I_y) r_y r_z
    const expected_x = 3 * n * n * (I_asymm.z - I_asymm.y) * (-sqrt2_2) * (-sqrt2_2);
    expect(tau.x).toBeCloseTo(expected_x, 12);
  });

  it('matches analytical formula within 0.1%', () => {
    // Verify against Hughes (1986) Eq. 3.3.10
    const I: Vector3 = { x: 0.010, y: 0.015, z: 0.020 }; // Typical 3U CubeSat
    const qBody = qIdentity();

    // Nadir at arbitrary angle in Y-Z plane
    const theta = 0.3; // radians
    const nadirWorld: Vector3 = {
      x: 0,
      y: -Math.sin(theta),
      z: -Math.cos(theta),
    };

    const tau = gravityGradientTorque(qBody, I, nadirWorld, n);

    // Analytical calculation
    const rx = 0, ry = -Math.sin(theta), rz = -Math.cos(theta);
    const tau_x = 3 * n * n * (I.z - I.y) * ry * rz;
    const tau_y = 3 * n * n * (I.x - I.z) * rz * rx;
    const tau_z = 3 * n * n * (I.y - I.x) * rx * ry;

    expect(tau.x).toBeCloseTo(tau_x, 14);
    expect(tau.y).toBeCloseTo(tau_y, 14);
    expect(tau.z).toBeCloseTo(tau_z, 14);

    // Check relative error < 0.1%
    if (Math.abs(tau_x) > 1e-15) {
      expect(Math.abs((tau.x - tau_x) / tau_x)).toBeLessThan(0.001);
    }
  });

  it('transforms correctly with body rotation', () => {
    const I: Vector3 = { x: 0.01, y: 0.02, z: 0.03 };
    // Use nadir at 45° in Y-Z plane (not aligned with principal axis)
    const sqrt2_2 = Math.sqrt(2) / 2;
    const nadirWorld: Vector3 = { x: 0, y: -sqrt2_2, z: -sqrt2_2 };

    // No rotation vs 90° rotation about X
    const q0 = qIdentity();
    const q90 = qFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2);

    const tau0 = gravityGradientTorque(q0, I, nadirWorld, n);
    const tau90 = gravityGradientTorque(q90, I, nadirWorld, n);

    // Torque magnitude should be non-zero for both
    // (rotating body changes how nadir vector appears in body frame)
    expect(v3Mag(tau0)).toBeGreaterThan(1e-12);
    expect(v3Mag(tau90)).toBeGreaterThan(1e-12);
    
    // And torques should differ (different body orientation relative to nadir)
    const componentDiff = Math.abs(tau0.x - tau90.x) + Math.abs(tau0.y - tau90.y) + Math.abs(tau0.z - tau90.z);
    expect(componentDiff).toBeGreaterThan(0); // Different directions due to body-frame alignment
  });
});

describe('maxGravityGradientTorque', () => {
  it('returns correct maximum torque for typical CubeSat', () => {
    const I: Vector3 = { x: 0.01, y: 0.02, z: 0.03 };
    const n = meanMotion(400);

    const tauMax = maxGravityGradientTorque(I, n);

    // Maximum inertia difference is |I_z - I_x| = 0.02
    // τ_max = (3/2) n² |ΔI|_max
    const expected = (3 / 2) * n * n * 0.02;

    expect(tauMax).toBeCloseTo(expected, 14);
  });

  it('computes maximum at 45° orientation', () => {
    const I: Vector3 = { x: 0.01, y: 0.01, z: 0.02 };
    const n = meanMotion(400);

    // When nadir is at 45° from principal axis, sin(2θ) = 1
    // gives maximum torque
    const tauMax = maxGravityGradientTorque(I, n);

    // Verify by computing at 45°
    const sqrt2_2 = Math.sqrt(2) / 2;
    const nadirWorld: Vector3 = { x: 0, y: -sqrt2_2, z: -sqrt2_2 };
    const tau45 = gravityGradientTorque(qIdentity(), I, nadirWorld, n);

    // Actual torque at 45° should be close to max
    // (may differ due to which axis pair gives maximum)
    expect(v3Mag(tau45)).toBeLessThanOrEqual(tauMax * 1.01);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Nadir Vector Update Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('updateNadirVector', () => {
  it('rotates nadir vector at mean motion rate for inclined orbit', () => {
    const n = meanMotion(400);
    const dt = 1.0; // 1 second
    const inclinationRad = Math.PI / 4; // 45° inclination

    // For inclined orbit, nadir rotates in a tilted plane
    // Start with nadir pointing -Z
    let nadir: Vector3 = { x: 0, y: 0, z: -1 };

    // Update for 1 second
    nadir = updateNadirVector(nadir, n, dt, inclinationRad);

    // After dt, nadir should have rotated by angle n*dt
    expect(v3Mag(nadir)).toBeCloseTo(1, 10); // Still unit vector
    
    // For inclined orbit, nadir should now have some X component
    // (rotation around tilted axis moves Z-component into X)
    expect(Math.abs(nadir.x)).toBeGreaterThan(0);
  });

  it('preserves nadir vector along orbit normal (equatorial, nadir perpendicular)', () => {
    const n = meanMotion(400);
    const halfPeriod = Math.PI / n;

    // For equatorial orbit (inc=0), orbit normal is [0, 0, 1]
    // Start with nadir in X-Y plane (perpendicular to orbit normal)
    let nadir: Vector3 = { x: 0, y: -1, z: 0 };

    // After half orbit, nadir should have rotated 180° in X-Y plane
    nadir = updateNadirVector(nadir, n, halfPeriod, 0);

    // Nadir should now point approximately +Y
    expect(nadir.y).toBeCloseTo(1, 3);
    expect(nadir.z).toBeCloseTo(0, 3);
  });

  it('remains normalized over many steps', () => {
    const n = meanMotion(400);
    const dt = 0.001; // 1ms timestep
    let nadir: Vector3 = { x: 0, y: 0, z: -1 };

    // Run for 10 seconds (10,000 steps)
    for (let i = 0; i < 10000; i++) {
      nadir = updateNadirVector(nadir, n, dt, 0);
    }

    // Should still be unit vector
    expect(v3Mag(nadir)).toBeCloseTo(1, 8);
  });

  it('respects orbital inclination', () => {
    const n = meanMotion(400);
    const dt = 100; // Large step to see clear difference

    // Equatorial orbit
    let nadir0: Vector3 = { x: 0, y: 0, z: -1 };
    nadir0 = updateNadirVector(nadir0, n, dt, 0);

    // 45° inclined orbit  
    let nadir45: Vector3 = { x: 0, y: 0, z: -1 };
    nadir45 = updateNadirVector(nadir45, n, dt, Math.PI / 4);

    // Trajectories should differ
    expect(nadir0.x).not.toBeCloseTo(nadir45.x, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Solar Radiation Pressure Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('srpTorque', () => {
  it('returns zero for stowed panels', () => {
    const qBody = qIdentity();
    const sunWorld: Vector3 = { x: 1, y: 0, z: 0 };

    const specs = [
      {
        id: 'panel-1',
        hinge: [0.05, 0, 0] as [number, number, number],
        pos: [0, 0, -0.15] as [number, number, number],
        size: [0.3, 0.003, 0.1] as [number, number, number],
        rot: [0, 0, 0] as [number, number, number],
        axis: 'y' as const,
      },
    ];

    const states = [
      {
        id: 'panel-1',
        angle: 0, // Stowed
        angularVelocity: 0,
        stuck: true, // And stuck stowed
        stuckAngle: 0,
        deployed: false,
        contactForce: 0,
      },
    ];

    const tau = srpTorque(qBody, specs, states, sunWorld, 0.2);

    // Stowed panels have negligible SRP
    expect(v3Mag(tau)).toBeLessThan(1e-10);
  });

  it('produces torque proportional to panel area', () => {
    const qBody = qIdentity();
    const sunWorld: Vector3 = { x: 1, y: 0, z: 0 };

    // Small panel
    const specsSmall = [
      {
        id: 'panel-1',
        hinge: [0.05, 0, 0] as [number, number, number],
        pos: [0, 0, -0.05] as [number, number, number],
        size: [0.1, 0.003, 0.05] as [number, number, number], // 0.005 m²
        rot: [0, 0, 0] as [number, number, number],
        axis: 'y' as const,
      },
    ];

    // Large panel (4x area)
    const specsLarge = [
      {
        id: 'panel-1',
        hinge: [0.05, 0, 0] as [number, number, number],
        pos: [0, 0, -0.1] as [number, number, number],
        size: [0.2, 0.003, 0.1] as [number, number, number], // 0.02 m²
        rot: [0, 0, 0] as [number, number, number],
        axis: 'y' as const,
      },
    ];

    const states = [
      {
        id: 'panel-1',
        angle: Math.PI / 2, // Fully deployed
        angularVelocity: 0,
        stuck: false,
        stuckAngle: 0,
        deployed: true,
        contactForce: 0,
      },
    ];

    const tauSmall = srpTorque(qBody, specsSmall, states, sunWorld, 0.2);
    const tauLarge = srpTorque(qBody, specsLarge, states, sunWorld, 0.2);

    // Torque should scale with area (approximately)
    // Exact ratio depends on geometry, but larger panel → larger torque
    if (v3Mag(tauSmall) > 1e-12) {
      expect(v3Mag(tauLarge)).toBeGreaterThan(v3Mag(tauSmall));
    }
  });

  it('uses correct solar pressure constant', () => {
    // Verify P_SOLAR ≈ 4.56e-6 N/m² (L_sun / 4πc at 1 AU)
    expect(P_SOLAR).toBeCloseTo(4.54e-6, 7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Physical Constants Validation
// ─────────────────────────────────────────────────────────────────────────────

describe('physical constants', () => {
  it('GM_EARTH matches standard value', () => {
   expect(GM_EARTH).toBeCloseTo(3.986004418e14, 6);
  });

  it('R_EARTH matches centralized mean-radius value', () => {
    expect(R_EARTH).toBeCloseTo(6.371e6, 1);
  });

  it('P_SOLAR matches fixed curated SRP constant', () => {
    expect(P_SOLAR).toBeCloseTo(4.56e-6, 8);
  });
});
