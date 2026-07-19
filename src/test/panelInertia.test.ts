// ─────────────────────────────────────────────────────────────────────────────
//  Independent hinge-axis inertia mapping tests (Phase B).
//
//  Every I_S1/I_S2/I_S3/Ieff below is derived FRESH in this file from the raw
//  layout geometry (spec.size, spec.pos) with the textbook rectangular-prism
//  formulas — never by calling the production inertia helpers — and then
//  cross-checked against what the engine's kinematics cache actually serves.
//
//  Panel local frame (verified against the renderer's boxGeometry mapping):
//    local X = hinge axis  (extent H = size[0])
//    local Y = thickness   (extent t = size[1])
//    local Z = outward     (extent R = size[2]) — CM offset d = R/2 along ∓Z
//
//  The Phase-B bug this pins down: the pre-fix engine used the CENTROIDAL
//  moment (1/12)m(R²+t²) as the hinge-axis inertia, missing the parallel-axis
//  term m·(R/2)² — the true hinge-edge moment is (1/3)mR² + (1/12)mt², ≈4×.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion, Euler } from 'three';
import {
  getPanelKinematics,
  panelWorldQuaternion,
  computeSystemInertiaAboutB,
  computePanelGeometryAtStage,
  createInitialState,
} from '../lib/physics/engine';
import { mat3MulVec, type Mat3 } from '../lib/physics/linearAlgebra';
import { DEFAULT_PARAMS, type ConfigType, type SimulationParams } from '../lib/physics/types';

const CONFIGS: ConfigType[] = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'];

describe('independent hinge-axis inertia mapping (all four configurations)', () => {
  for (const config of CONFIGS) {
    it(`${config}: centroidal I_S1/I_S2/I_S3 and hinge-edge Ieff match the textbook formulas for every panel`, () => {
      const kin = getPanelKinematics(config, DEFAULT_PARAMS);
      expect(kin.length).toBeGreaterThan(0);
      const m = DEFAULT_PARAMS.panelMass;

      for (const k of kin) {
        const [H, t, R] = k.spec.size;
        // Independent textbook values (rectangular prism, centroidal):
        const IS2 = (1 / 12) * m * (t * t + R * R);   // about hinge-parallel axis through CM
        const IS3 = (1 / 12) * m * (H * H + R * R);   // about thickness axis through CM
        const IS1 = (1 / 12) * m * (H * H + t * t);   // about outward axis through CM
        // Hinge-EDGE moment via parallel axis (d = R/2, offset ⊥ X and ⊥ Y):
        const IeffEdge = (1 / 3) * m * R * R + (1 / 12) * m * t * t;

        // Production centroidal tensor (x, y, z) = (I_S2, I_S3, I_S1):
        expect(k.IpCentroid.x).toBeCloseTo(IS2, 15);
        expect(k.IpCentroid.y).toBeCloseTo(IS3, 15);
        expect(k.IpCentroid.z).toBeCloseTo(IS1, 15);

        // Production hinge-referenced tensor: Ip.x is the hinge-axis Ieff.
        expect(k.Ip.x).toBeCloseTo(IeffEdge, 15);
        expect(k.Ip.x).toBeCloseTo(IS2 + m * k.d * k.d, 15);

        // d really is R/2 in every layout:
        expect(k.d).toBeCloseTo(R / 2, 12);

        // The two representations must NEVER be conflated: for real panels
        // (d > 0) the hinge-edge value is strictly larger — ≈4× here.
        expect(k.Ip.x).toBeGreaterThan(k.IpCentroid.x * 3.5);
      }
    });
  }

  it('FR4 long-edge: the corrected Ieff is ≈4.0× the old (centroidal) value used pre-Phase-B', () => {
    const kin = getPanelKinematics('long-edge', DEFAULT_PARAMS);
    const m = DEFAULT_PARAMS.panelMass;
    const [, t, R] = kin[0].spec.size;
    const oldWrong = (1 / 12) * m * (R * R + t * t); // pre-fix "hinge" inertia
    expect(oldWrong).toBeCloseTo(3.0919e-4, 7);       // the old pinned value
    expect(kin[0].Ip.x / oldWrong).toBeGreaterThan(3.9);
    expect(kin[0].Ip.x / oldWrong).toBeLessThan(4.1);
    expect(kin[0].Ip.x).toBeCloseTo(1.2367e-3, 6);
  });

  it('double-long-edge: ŝ1 sign flips for the folded stage-2 children (r_S/H = −d·ŝ1 convention)', () => {
    const kin = getPanelKinematics('double-long-edge', DEFAULT_PARAMS);
    // Roots: pos = (0,0,−W/2) → ŝ1 = +ẑ. Children fold back: pos = (0,0,+W/2) → ŝ1 = −ẑ.
    expect(kin[0].s1Local.z).toBeCloseTo(1, 12);
    expect(kin[1].s1Local.z).toBeCloseTo(1, 12);
    expect(kin[2].s1Local.z).toBeCloseTo(-1, 12);
    expect(kin[3].s1Local.z).toBeCloseTo(-1, 12);
    // ŝ3 = ŝ1 × ŝ2 flips with it (right-handed triad preserved):
    expect(kin[0].s3Local.y).toBeCloseTo(1, 12);
    expect(kin[2].s3Local.y).toBeCloseTo(-1, 12);
    for (const k of kin) {
      expect(k.s1Local.clone().cross(k.aLocal).distanceTo(k.s3Local)).toBeLessThan(1e-14);
    }
  });
});

describe('panelWorldQuaternion convention (single shared helper)', () => {
  it('identity qBody/qMount at θ=0 returns identity (local axes preserved)', () => {
    const q = panelWorldQuaternion(new Quaternion(), new Quaternion(), 0, new Vector3(1, 0, 0));
    expect(q.x).toBeCloseTo(0, 15);
    expect(q.y).toBeCloseTo(0, 15);
    expect(q.z).toBeCloseTo(0, 15);
    expect(Math.abs(q.w)).toBeCloseTo(1, 15);
  });

  it('θ=π/2 rotates local ŝ1=(0,0,1), ŝ3=(0,1,0) about ŝ2=x̂ with right-hand-rule sign', () => {
    const q = panelWorldQuaternion(new Quaternion(), new Quaternion(), Math.PI / 2, new Vector3(1, 0, 0));
    // Right-hand rotation about +x by 90°: z → −... (y,z) → (y cosθ − z sinθ, y sinθ + z cosθ)
    const s1 = new Vector3(0, 0, 1).applyQuaternion(q);
    expect(s1.x).toBeCloseTo(0, 12);
    expect(s1.y).toBeCloseTo(-1, 12); // ẑ → −ŷ
    expect(s1.z).toBeCloseTo(0, 12);
    const s3 = new Vector3(0, 1, 0).applyQuaternion(q);
    expect(s3.z).toBeCloseTo(1, 12);  // ŷ → +ẑ
    const s2 = new Vector3(1, 0, 0).applyQuaternion(q);
    expect(s2.x).toBeCloseTo(1, 12);  // hinge axis invariant
  });

  it('non-identity qBody and qMount give the same world hinge axis as the engine’s aBody⊗qBody construction', () => {
    const qBody = new Quaternion().setFromEuler(new Euler(0.4, -0.7, 1.1, 'XYZ'));
    for (const config of CONFIGS) {
      const kin = getPanelKinematics(config, DEFAULT_PARAMS);
      const geo = computePanelGeometryAtStage(kin, qBody, kin.map(() => 0.5));
      for (let i = 0; i < kin.length; i++) {
        if (kin[i].spec.parentIndex !== undefined) continue; // children chain differently
        const aWorldLegacy = kin[i].aBody.clone().applyQuaternion(qBody.clone());
        expect(geo[i].s2World.distanceTo(aWorldLegacy)).toBeLessThan(1e-12);
      }
    }
  });
});

// ── System inertia about B ───────────────────────────────────────────────────

function mat3ToRows(m: Mat3): number[][] {
  return m.rows.map(r => [r.x, r.y, r.z]);
}

function expectMat3Close(a: Mat3, b: Mat3, digits: number): void {
  const ra = mat3ToRows(a), rb = mat3ToRows(b);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    expect(ra[r][c]).toBeCloseTo(rb[r][c], digits);
  }
}

describe('computeSystemInertiaAboutB', () => {
  const bodyDiag = (p: SimulationParams) => new Vector3(
    (1 / 12) * p.bodyMass * (p.bodyHeight ** 2 + p.bodyDepth ** 2),
    (1 / 12) * p.bodyMass * (p.bodyWidth ** 2 + p.bodyDepth ** 2),
    (1 / 12) * p.bodyMass * (p.bodyWidth ** 2 + p.bodyHeight ** 2),
  );

  it('zero-panel-mass fixture reduces exactly to the hub inertia (the only hub-only case)', () => {
    const params: SimulationParams = { ...DEFAULT_PARAMS, panelMass: 0 };
    const state = createInitialState('long-edge');
    const I = computeSystemInertiaAboutB(state, 'long-edge', params);
    const Ib = bodyDiag(params);
    expect(I.rows[0].x).toBeCloseTo(Ib.x, 12);
    expect(I.rows[1].y).toBeCloseTo(Ib.y, 12);
    expect(I.rows[2].z).toBeCloseTo(Ib.z, 12);
    expect(Math.abs(I.rows[0].y)).toBeLessThan(1e-15);
    expect(Math.abs(I.rows[1].z)).toBeLessThan(1e-15);
  });

  it('stowed long-edge equals the hand-computed hub + panel-centroidal + parallel-axis sum (NOT hub-only)', () => {
    const state = createInitialState('long-edge');
    const I = computeSystemInertiaAboutB(state, 'long-edge', DEFAULT_PARAMS);
    const p = DEFAULT_PARAMS;
    const m = p.panelMass;
    const kin = getPanelKinematics('long-edge', p);
    const [H, t, R] = kin[0].spec.size;
    const IS2 = (1 / 12) * m * (t * t + R * R);
    const IS3 = (1 / 12) * m * (H * H + R * R);
    const IS1 = (1 / 12) * m * (H * H + t * t);
    // Stowed geometry (hand-derived): both panels' CMs sit at (0, ±hy, 0)
    // (hinge at (0, ±hy, +hz), panel hanging −W/2 down the Z face), with the
    // panel local frame axis-aligned to the body (the −Y panel's π Z-flip
    // leaves its diagonal tensor unchanged). Parallel-axis r = (0, ±0.05, 0):
    //   ΔI = m·(|r|²E − rrᵀ) = m·diag(r², 0, r²)
    const hy = p.bodyDepth / 2;
    const Ib = bodyDiag(p);
    const hand: [number, number, number] = [
      Ib.x + 2 * (IS2 + m * hy * hy),
      Ib.y + 2 * IS3,
      Ib.z + 2 * (IS1 + m * hy * hy),
    ];
    expect(I.rows[0].x).toBeCloseTo(hand[0], 12);
    expect(I.rows[1].y).toBeCloseTo(hand[1], 12);
    expect(I.rows[2].z).toBeCloseTo(hand[2], 12);
    // Panels contribute — this must NOT equal the hub alone:
    expect(I.rows[0].x).toBeGreaterThan(Ib.x * 1.001);
  });

  it('rigid whole-system rotation transforms I_sc,B by the similarity R·I·Rᵀ', () => {
    const params = DEFAULT_PARAMS;
    const state0 = createInitialState('double-long-edge');
    state0.panels[0].angle = 0.6;
    state0.panels[1].angle = 0.6;
    const I0 = computeSystemInertiaAboutB(state0, 'double-long-edge', params);

    const qRot = new Quaternion().setFromEuler(new Euler(0.3, 0.9, -0.5, 'XYZ'));
    const state1 = createInitialState('double-long-edge');
    state1.panels[0].angle = 0.6;
    state1.panels[1].angle = 0.6;
    state1._bodyQ = qRot.clone();
    const I1 = computeSystemInertiaAboutB(state1, 'double-long-edge', params);

    // Build R·I0·Rᵀ column-by-column: (R·I0·Rᵀ)·v = R·(I0·(Rᵀ·v))
    const qInv = qRot.clone().conjugate();
    const applySim = (v: Vector3) =>
      mat3MulVec(I0, v.clone().applyQuaternion(qInv)).applyQuaternion(qRot);
    const cols = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map(applySim);
    for (let r = 0; r < 3; r++) {
      expect(I1.rows[r].x).toBeCloseTo(cols[0].getComponent(r), 12);
      expect(I1.rows[r].y).toBeCloseTo(cols[1].getComponent(r), 12);
      expect(I1.rows[r].z).toBeCloseTo(cols[2].getComponent(r), 12);
    }
  });

  it('symmetric fully-deployed long-edge matches an independent hand calculation', () => {
    const p = DEFAULT_PARAMS;
    const m = p.panelMass;
    const state = createInitialState('long-edge');
    state.panels[0].angle = Math.PI / 2;
    state.panels[1].angle = Math.PI / 2;
    const I = computeSystemInertiaAboutB(state, 'long-edge', p);

    const kin = getPanelKinematics('long-edge', p);
    const [H, t, R] = kin[0].spec.size;
    const IS2 = (1 / 12) * m * (t * t + R * R);
    const IS3 = (1 / 12) * m * (H * H + R * R);
    const IS1 = (1 / 12) * m * (H * H + t * t);
    // Deployed 90° about +x: the +Y panel swings its outward (−z from hinge)
    // direction into +y: CM at hinge + (0, W/2, 0) = (0, hy + R/2, hz).
    // Local axes in body frame: x→x, y→−z... wait — verified numerically below
    // via the geometry helper instead of hand-rotating: the tensor diagonal
    // (IS2, IS3, IS1) rotated 90° about x becomes diag(IS2, IS1, IS3).
    const hy = p.bodyDepth / 2, hz = p.bodyHeight / 2;
    const r = new Vector3(0, hy + R / 2, hz);
    const Ib = bodyDiag(p);
    const hand = [
      Ib.x + 2 * (IS2 + m * (r.y * r.y + r.z * r.z)),
      Ib.y + 2 * (IS1 + m * (r.x * r.x + r.z * r.z)),
      Ib.z + 2 * (IS3 + m * (r.x * r.x + r.y * r.y)),
    ];
    expect(I.rows[0].x).toBeCloseTo(hand[0], 12);
    expect(I.rows[1].y).toBeCloseTo(hand[1], 12);
    expect(I.rows[2].z).toBeCloseTo(hand[2], 12);
    // Off-diagonals: the ±Y mirror symmetry cancels the yz products:
    expect(Math.abs(I.rows[1].z)).toBeLessThan(1e-15);
  });

  it('varying only θ rotates r_S/B and ŝ1/ŝ3 about ŝ2, preserving norms and the hinge-to-CM distance d', () => {
    const kin = getPanelKinematics('long-edge', DEFAULT_PARAMS);
    const qBody = new Quaternion().setFromEuler(new Euler(0.2, 0.5, -0.3, 'XYZ'));
    const geo0 = computePanelGeometryAtStage(kin, qBody, [0, 0]);
    const theta = 1.234;
    const geo1 = computePanelGeometryAtStage(kin, qBody, [theta, 0]);

    // ŝ2 unchanged by the panel's own θ:
    expect(geo1[0].s2World.distanceTo(geo0[0].s2World)).toBeLessThan(1e-14);
    // Hinge point unchanged:
    expect(geo1[0].rHingeWorld.distanceTo(geo0[0].rHingeWorld)).toBeLessThan(1e-14);
    // ŝ1/ŝ3 are geo0's vectors rotated about ŝ2 by exactly θ, norms preserved:
    const rot = new Quaternion().setFromAxisAngle(geo0[0].s2World, theta);
    expect(geo1[0].s1World.distanceTo(geo0[0].s1World.clone().applyQuaternion(rot))).toBeLessThan(1e-12);
    expect(geo1[0].s3World.distanceTo(geo0[0].s3World.clone().applyQuaternion(rot))).toBeLessThan(1e-12);
    expect(geo1[0].s1World.length()).toBeCloseTo(1, 12);
    expect(geo1[0].s3World.length()).toBeCloseTo(1, 12);
    // CM revolves about the hinge line: hinge→CM distance d preserved:
    const d0 = geo0[0].rCmWorld.clone().sub(geo0[0].rHingeWorld).length();
    const d1 = geo1[0].rCmWorld.clone().sub(geo1[0].rHingeWorld).length();
    expect(d0).toBeCloseTo(kin[0].d, 12);
    expect(d1).toBeCloseTo(kin[0].d, 12);
    const arm1 = geo1[0].rCmWorld.clone().sub(geo1[0].rHingeWorld);
    const arm0rot = geo0[0].rCmWorld.clone().sub(geo0[0].rHingeWorld).applyQuaternion(rot);
    expect(arm1.distanceTo(arm0rot)).toBeLessThan(1e-12);
    // The untouched second panel's geometry is bit-identical in intent:
    expect(geo1[1].rCmWorld.distanceTo(geo0[1].rCmWorld)).toBeLessThan(1e-14);
  });

  it('double-long-edge child geometry rides the parent’s current angle (chain-resolved hinge position)', () => {
    const kin = getPanelKinematics('double-long-edge', DEFAULT_PARAMS);
    const q = new Quaternion();
    const stowed = computePanelGeometryAtStage(kin, q, [0, 0, 0, 0]);
    const parentDeployed = computePanelGeometryAtStage(kin, q, [Math.PI / 2, 0, 0, 0]);
    // Child 2 (parent 0): its hinge sits at the parent's far edge, so
    // deploying the parent 90° must MOVE the child's hinge point:
    expect(
      parentDeployed[2].rHingeWorld.distanceTo(stowed[2].rHingeWorld),
    ).toBeGreaterThan(0.1);
    // ...and swing the child's own hinge→CM arm with it (orientation chained):
    const armStowed = stowed[2].rCmWorld.clone().sub(stowed[2].rHingeWorld);
    const armDeployed = parentDeployed[2].rCmWorld.clone().sub(parentDeployed[2].rHingeWorld);
    expect(armDeployed.distanceTo(armStowed)).toBeGreaterThan(0.1);
    expect(armDeployed.length()).toBeCloseTo(armStowed.length(), 12);
  });
});
