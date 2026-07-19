// ─────────────────────────────────────────────────────────────────────────────
//  Analytic and brute-force reference tests for the Phase-B coupled EOM.
//
//  These are the ADJUDICATION tests for the b_θ sign/coefficient convention:
//  the coupled solver was not wired into production until they passed.
//
//  1. Hinge-at-B closed form (convention-independent Newton–Euler): a panel
//     hinged AT the body reference point exerts no force moment on the hub
//     (the reaction force acts at B), so ω̇·ŝ2 = −τ/I_b and the panel obeys
//     Ieff·(ω̇·ŝ2 + θ̈) = τ  ⇒  θ̈ = τ/Ieff + τ/I_b. Matching θ̈ = b_θ·ω̇ + c_θ
//     forces b_θ·ŝ2 = −1 exactly (the paper's Eq. 14 form; NOT −I_S2/Ieff).
//  2. Independent planar 2-DOF Lagrangian reference: hub + offset-hinged
//     panel, mass matrix and generalized forces derived by hand in this file
//     and integrated with a test-local RK4 — trajectory-level comparison.
//  3. Coefficient-level checks: b_θ = −K/Ieff; K equals BOTH textbook forms
//     (centroidal I_S2 with r_S/B, and Ieff with r_H/B); the d = 0 degenerate
//     case; and the demonstrably-not-−ŝ2 offset-hinge case.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion, Euler } from 'three';
import {
  coupledDeriv,
  integrateCoupledSystemRK4,
  computeAssemblyCoefficients,
  computePanelGeometryAtStage,
  type PanelKinematics,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS, type SimulationParams } from '../lib/physics/types';

// ── Hand-built single-panel kinematics (independent of getPanelSpecs) ────────
// Panel local frame: X = hinge axis (extent H), Y = thickness (t), Z = outward
// (extent R, panel occupies Z ∈ [-R, 0]). Paper convention r_S/H = −d·ŝ1.
function makeKin(opts: {
  m: number; H: number; t: number; R: number;
  hinge: [number, number, number];
  pos?: [number, number, number];
}): PanelKinematics {
  const { m, H, t, R, hinge } = opts;
  const pos = opts.pos ?? ([0, 0, -R / 2] as [number, number, number]);
  const posV = new Vector3(pos[0], pos[1], pos[2]);
  const d = posV.length();
  // Textbook rectangular-prism centroidal moments, written fresh here:
  const IS2 = (1 / 12) * m * (t * t + R * R);
  const IS3 = (1 / 12) * m * (H * H + R * R);
  const IS1 = (1 / 12) * m * (H * H + t * t);
  const aLocal = new Vector3(1, 0, 0);
  const s1Local = d > 0 ? posV.clone().multiplyScalar(-1 / d) : new Vector3(0, 0, 1);
  return {
    spec: {
      id: 'TEST', size: [H, t, R], hinge, pos, rot: [0, 0, 0], axis: 'x',
    },
    qMount: new Quaternion(),
    aLocal,
    aBody: aLocal.clone(),
    Ip: new Vector3(IS2 + m * d * d, IS3 + m * d * d, IS1),
    IpCentroid: new Vector3(IS2, IS3, IS1),
    d,
    s1Local,
    s3Local: s1Local.clone().cross(aLocal),
  };
}

function makeParams(over: {
  bodyMass?: number; k?: number; c?: number; friction?: number; m?: number;
}): SimulationParams {
  return {
    ...DEFAULT_PARAMS,
    panelMass: over.m ?? 0.032,
    bodyMass: over.bodyMass ?? 4.0,
    hinge: {
      ...DEFAULT_PARAMS.hinge,
      springConstant: over.k ?? 2e-3,
      dampingCoeff: over.c ?? 1e-3,
      frictionCoeff: over.friction ?? 0,
      preloadTorque: 0,
      stopAngle: Math.PI / 2,
      hingeModel: 'linear',
    },
  };
}

const M = 0.032, H = 0.1, T = 0.0025, R = 0.34;
const D = R / 2;
const IS2 = (1 / 12) * M * (T * T + R * R);
const IEFF = IS2 + M * D * D; // = (1/3)mR² + (1/12)mt²

describe('hinge-at-B closed form (b_θ convention adjudication)', () => {
  it('at rest with r_H/B = 0: ω̇·ŝ2 = −τ/I_b and θ̈ = τ/Ieff + τ/I_b exactly', () => {
    const params = makeParams({});
    const kin = [makeKin({ m: M, H, t: T, R, hinge: [0, 0, 0] })];
    const IbX = (1 / 12) * params.bodyMass *
      (params.bodyHeight * params.bodyHeight + params.bodyDepth * params.bodyDepth);
    const tau0 = params.hinge.springConstant * (Math.PI / 2); // spring at θ=0, θ̇=0

    const r = coupledDeriv(
      new Quaternion(), new Vector3(), [0], [0], [0], [Math.PI / 2], kin, params,
    );

    // Hub: the hinge reaction force acts AT B (no moment); only −τ·ŝ2 remains.
    expect(r.dOmega.x).toBeCloseTo(-tau0 / IbX, 12);
    expect(Math.abs(r.dOmega.y)).toBeLessThan(1e-15);
    expect(Math.abs(r.dOmega.z)).toBeLessThan(1e-15);
    // Panel: physical pendulum on the co-accelerating pivot.
    const expected = tau0 / IEFF + tau0 / IbX;
    expect(r.dThetaDot[0]).toBeCloseTo(expected, 10);
    // The J-form (b_θ·ŝ2 = −I_S2/Ieff) would instead give
    // τ/Ieff + (I_S2/Ieff)·τ/I_b — verify we are NOT that:
    const jForm = tau0 / IEFF + (IS2 / IEFF) * (tau0 / IbX);
    expect(Math.abs(r.dThetaDot[0] - jForm)).toBeGreaterThan(
      0.5 * Math.abs(expected - jForm),
    );
  });

  it('b_θ·ŝ2 = −1 exactly when r_H/B = 0 (paper Eq. 14 form)', () => {
    const kin = [makeKin({ m: M, H, t: T, R, hinge: [0, 0, 0] })];
    const geo = computePanelGeometryAtStage(kin, new Quaternion(), [0.3]);
    const { bTheta, Ieff, K } = computeAssemblyCoefficients(
      [0], kin, geo, new Vector3(), 0, M, 0,
    );
    expect(bTheta.dot(geo[0].s2World)).toBeCloseTo(-1, 12);
    expect(Ieff).toBeCloseTo(IEFF, 12);
    // K = Ieff·ŝ2 exactly in this geometry (r_S/B = −d·ŝ1 ⊥ ŝ2):
    expect(K.dot(geo[0].s2World)).toBeCloseTo(IEFF, 12);
  });
});

describe('coefficient-level checks (K, b_θ, Ieff)', () => {
  const hinge: [number, number, number] = [0, 0, 0.17025];
  const kin = [makeKin({ m: M, H, t: T, R, hinge })];

  it('b_θ = −K/Ieff, and K equals BOTH textbook forms (centroidal-with-r_S/B and Ieff-with-r_H/B)', () => {
    for (const theta of [0, 0.4, 1.1]) {
      const geo = computePanelGeometryAtStage(kin, new Quaternion(), [theta]);
      const g = geo[0];
      const { K, bTheta, Ieff } = computeAssemblyCoefficients(
        [0], kin, geo, new Vector3(), 0, M, 0,
      );
      // b_θ = −K/Ieff (identity used by the implementation)
      expect(bTheta.clone().multiplyScalar(-Ieff).distanceTo(K)).toBeLessThan(1e-14);
      // CM-referenced form: K = I_S2·ŝ2 + m·d·(r_S/B × ŝ3)
      const kCm = g.s2World.clone().multiplyScalar(IS2)
        .addScaledVector(new Vector3().crossVectors(g.rCmWorld, g.s3World), M * D);
      expect(K.distanceTo(kCm)).toBeLessThan(1e-14);
      // Hinge-referenced form: K = Ieff·ŝ2 + m·d·(r_H/B × ŝ3)
      const kHinge = g.s2World.clone().multiplyScalar(IEFF)
        .addScaledVector(new Vector3().crossVectors(g.rHingeWorld, g.s3World), M * D);
      expect(K.distanceTo(kHinge)).toBeLessThan(1e-14);
      // ...so b_θ equals the paper's literal Eq. 14:
      // −ŝ2 − (m·d/Ieff)·(r_H/B × ŝ3)
      const bPaper = g.s2World.clone().multiplyScalar(-1)
        .addScaledVector(new Vector3().crossVectors(g.rHingeWorld, g.s3World), -M * D / IEFF);
      expect(bTheta.distanceTo(bPaper)).toBeLessThan(1e-14);
    }
  });

  it('d = 0 degenerate case: Ieff = I_S2, K = I_S2·ŝ2, b_θ = −ŝ2 exactly', () => {
    const kin0 = [makeKin({ m: M, H, t: T, R, hinge, pos: [0, 0, 0] })];
    const geo = computePanelGeometryAtStage(kin0, new Quaternion(), [0.6]);
    const { K, bTheta, Ieff } = computeAssemblyCoefficients(
      [0], kin0, geo, new Vector3(), 0, M, 0,
    );
    expect(Ieff).toBeCloseTo(IS2, 15);
    expect(K.distanceTo(geo[0].s2World.clone().multiplyScalar(IS2))).toBeLessThan(1e-15);
    expect(bTheta.clone().add(geo[0].s2World).length()).toBeLessThan(1e-15);
  });

  it('nonzero d with offset hinge: b_θ is demonstrably NOT −ŝ2 (b_θ·ŝ2 = −1 + m·d·h/Ieff at θ=0)', () => {
    const geo = computePanelGeometryAtStage(kin, new Quaternion(), [0]);
    const { bTheta } = computeAssemblyCoefficients([0], kin, geo, new Vector3(), 0, M, 0);
    const hZ = hinge[2];
    expect(bTheta.dot(geo[0].s2World)).toBeCloseTo(-1 + (M * D * hZ) / IEFF, 12);
    expect(Math.abs(bTheta.dot(geo[0].s2World) + 1)).toBeGreaterThan(0.1);
  });
});

// ── Independent planar 2-DOF Lagrangian reference ────────────────────────────
// Hub rotating φ about world X, panel hinged at body point (0,0,h) about the
// same X axis, hinge angle θ. Derived by hand from the Lagrangian:
//   [Ib + IS2 + m(h²+d²−2hd·cosθ)]·φ̈ + [IS2 + md² − mhd·cosθ]·θ̈
//        = −m·h·d·sinθ·θ̇·(2φ̇+θ̇)
//   [IS2 + md² − mhd·cosθ]·φ̈ + (IS2+md²)·θ̈ = τ(θ,θ̇) + m·h·d·sinθ·φ̇²
function planarReference(
  IbX: number, hZ: number, k: number, c: number, stop: number,
  phiDot0: number, dt: number, steps: number,
): { phi: number; phiDot: number; theta: number; thetaDot: number } {
  let y = [0, phiDot0, 0, 0]; // [φ, φ̇, θ, θ̇]

  function deriv(s: number[]): number[] {
    const [, phiDot, theta, thetaDot] = s;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const m11 = IbX + IS2 + M * (hZ * hZ + D * D - 2 * hZ * D * cos);
    const m12 = IS2 + M * D * D - M * hZ * D * cos;
    const m22 = IS2 + M * D * D;
    const tau = k * (stop - theta) - c * thetaDot;
    const f1 = -M * hZ * D * sin * thetaDot * (2 * phiDot + thetaDot);
    const f2 = tau + M * hZ * D * sin * phiDot * phiDot;
    const det = m11 * m22 - m12 * m12;
    const phiDdot = (m22 * f1 - m12 * f2) / det;
    const thetaDdot = (m11 * f2 - m12 * f1) / det;
    return [phiDot, phiDdot, thetaDot, thetaDdot];
  }

  for (let i = 0; i < steps; i++) {
    const k1 = deriv(y);
    const k2 = deriv(y.map((v, j) => v + 0.5 * dt * k1[j]));
    const k3 = deriv(y.map((v, j) => v + 0.5 * dt * k2[j]));
    const k4 = deriv(y.map((v, j) => v + dt * k3[j]));
    y = y.map((v, j) => v + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
  }
  return { phi: y[0], phiDot: y[1], theta: y[2], thetaDot: y[3] };
}

describe('independent planar Lagrangian brute-force comparison', () => {
  const hZ = 0.17025;
  const dt = 1 / 1200;

  function runEngine(phiDot0: number, steps: number, params: SimulationParams) {
    const kin = [makeKin({ m: M, H, t: T, R, hinge: [0, 0, hZ] })];
    let q = new Quaternion();
    let w = new Vector3(phiDot0, 0, 0);
    let th = [0];
    let thd = [0];
    for (let i = 0; i < steps; i++) {
      const r = integrateCoupledSystemRK4(
        q, w, th, thd, [0], [Math.PI / 2], kin, params, dt,
      );
      q = r.qBodyNew; w = r.omegaBodyNew; th = r.thetasNew; thd = r.thetaDotsNew;
    }
    // Planar motion: rotation purely about world X → φ = 2·atan2(qx, qw).
    return { phi: 2 * Math.atan2(q.x, q.w), phiDot: w.x, theta: th[0], thetaDot: thd[0], w };
  }

  it('matches the hand-derived 2-DOF reference through free travel (hub initially at rest)', () => {
    const params = makeParams({ k: 2e-3, c: 1e-3 });
    const IbX = (1 / 12) * params.bodyMass *
      (params.bodyHeight * params.bodyHeight + params.bodyDepth * params.bodyDepth);
    const steps = 1440; // 1.2 s
    const ref = planarReference(IbX, hZ, 2e-3, 1e-3, Math.PI / 2, 0, dt, steps);
    const eng = runEngine(0, steps, params);

    expect(eng.theta).toBeGreaterThan(0.3); // the panel genuinely moved
    expect(eng.theta).toBeLessThan(Math.PI / 2); // stayed in free travel
    expect(eng.theta).toBeCloseTo(ref.theta, 6);
    expect(eng.thetaDot).toBeCloseTo(ref.thetaDot, 6);
    expect(eng.phi).toBeCloseTo(ref.phi, 6);
    expect(eng.phiDot).toBeCloseTo(ref.phiDot, 6);
  });

  it('matches the reference with an initial hub spin (exercises φ̇θ̇ and φ̇² coupling terms)', () => {
    const params = makeParams({ k: 2e-3, c: 1e-3 });
    const IbX = (1 / 12) * params.bodyMass *
      (params.bodyHeight * params.bodyHeight + params.bodyDepth * params.bodyDepth);
    const steps = 1200; // 1.0 s
    const phiDot0 = 0.25;
    const ref = planarReference(IbX, hZ, 2e-3, 1e-3, Math.PI / 2, phiDot0, dt, steps);
    const eng = runEngine(phiDot0, steps, params);

    expect(eng.theta).toBeCloseTo(ref.theta, 6);
    expect(eng.thetaDot).toBeCloseTo(ref.thetaDot, 6);
    expect(eng.phi).toBeCloseTo(ref.phi, 6);
    expect(eng.phiDot).toBeCloseTo(ref.phiDot, 6);
    // Motion stays planar: no spurious out-of-plane rates.
    expect(Math.abs(eng.w.y)).toBeLessThan(1e-12);
    expect(Math.abs(eng.w.z)).toBeLessThan(1e-12);
  });

  it('recovers the isolated-hinge pendulum in the infinite-hub-inertia limit', () => {
    const params = makeParams({ k: 2e-3, c: 1e-3, bodyMass: 4e9 });
    const steps = 1200;
    const eng = runEngine(0, steps, params);

    // 1-DOF reference: Ieff·θ̈ = k(stop−θ) − c·θ̇, same RK4, same dt.
    let th = 0, thd = 0;
    const dt1 = dt;
    const f = (a: number, b: number) => (2e-3 * (Math.PI / 2 - a) - 1e-3 * b) / IEFF;
    for (let i = 0; i < steps; i++) {
      const k1t = thd, k1v = f(th, thd);
      const k2t = thd + 0.5 * dt1 * k1v, k2v = f(th + 0.5 * dt1 * k1t, thd + 0.5 * dt1 * k1v);
      const k3t = thd + 0.5 * dt1 * k2v, k3v = f(th + 0.5 * dt1 * k2t, thd + 0.5 * dt1 * k2v);
      const k4t = thd + dt1 * k3v, k4v = f(th + dt1 * k3t, thd + dt1 * k3v);
      th += (dt1 / 6) * (k1t + 2 * k2t + 2 * k3t + k4t);
      thd += (dt1 / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
    }
    expect(eng.theta).toBeCloseTo(th, 7);
    expect(Math.abs(eng.phiDot)).toBeLessThan(1e-10); // hub effectively frozen
  });
});

describe('joint-RK4 state-vector wiring sanity', () => {
  it('the derivative returns dθ_i equal to the input stage θ̇_i for active panels', () => {
    const params = makeParams({});
    const kin = [makeKin({ m: M, H, t: T, R, hinge: [0, 0, 0.17] })];
    const r = coupledDeriv(
      new Quaternion().setFromEuler(new Euler(0.2, -0.1, 0.05, 'XYZ')),
      new Vector3(0.1, -0.05, 0.2),
      [0.5], [0.8], [0], [Math.PI / 2], kin, params,
    );
    expect(r.dTheta[0]).toBe(0.8);
  });

  it('inactive panels get exactly zero θ/θ̇ derivatives', () => {
    const params = makeParams({});
    const kin = [makeKin({ m: M, H, t: T, R, hinge: [0, 0, 0.17] })];
    const r = coupledDeriv(
      new Quaternion(), new Vector3(0.3, 0, 0), [0.5], [0], [-1], [Math.PI / 2], kin, params,
    );
    expect(r.dTheta[0]).toBe(0);
    expect(r.dThetaDot[0]).toBe(0);
  });
});
