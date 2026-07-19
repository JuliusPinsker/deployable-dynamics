// ─────────────────────────────────────────────────────────────────────────────
//  Latch/floor constraint-event validation (Phase-B audit, Gate B).
//
//  A latch is a non-smooth, velocity-level unilateral constraint event
//  (J(q)·q̇⁺ = 0 on the latching hinge rate). Production resolves it with a
//  generalized perfectly-inelastic constraint projection; these tests verify
//  that resolution against an INDEPENDENTLY DERIVED planar reference:
//
//    q̇⁺ = q̇⁻ − M⁻¹Jᵀ(J M⁻¹ Jᵀ)⁻¹ J q̇⁻
//
//  with the generalized mass matrix M(q) built from fresh planar formulas in
//  this file (never from production helpers; only physical constants are
//  copied into the fixture). Long-edge deployments about the body X axis are
//  exactly planar, giving an analytically defined geometry:
//
//    M_φφ = I_b,x + Σ_p [ I_S2 + m·|r_p|² ]              (hub row, about x)
//    M_φj = s_j·I_S2 + m·(x̂×r_j)·(dr_j/dθ_j)            (hub–hinge coupling)
//    M_jj = I_S2 + m·d²                                   (hinge row)
//    M_ij = 0  (i ≠ j: panels couple only through the hub)
//
//  where r_j(θ) = (s_j·(hy + d·sinθ), hz − d·cosθ) in the (y,z) plane,
//  s_j = ±1 the mount mirror sign, d = R/2. The fresh M is anchored against
//  the momentum diagnostic before use (H_x = M_φφ·ω_x + Σ M_φj·θ̇_j).
//
//  Production's event solve additionally carries H across the ≤0.6° latch
//  snap (geometry evaluated post-snap). The tests therefore compare against
//  BOTH the snap-aware reference (expected: agreement to solver precision)
//  and the gate's literal fixed-q projection (expected: agreement within the
//  quantified snap bound).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { Vector3, Quaternion } from 'three';
import {
  createInitialState,
  stepSimulation,
  integrateCoupledSystemRK4,
  computeCoupledSubstepCount,
  computeTotalAngularMomentum,
  getPanelKinematics,
  FREE_FLOAT_MOMENTUM_ERROR_MAX,
  type SpacecraftState,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS, type SimulationParams } from '../lib/physics/types';

// Test fixture: underdamped hinge (ζ ≈ 0.16) with zero Coulomb friction so
// the panel reaches the stop ballistically and the latch engages within the
// 0.01 rad margin (small, quantifiable snap). Heavier hub (40 kg) shrinks the
// snap's relative inertia effect. Physical constants copied explicitly:
const HY = DEFAULT_PARAMS.bodyDepth / 2;      // 0.05 m — hinge y offset
const HZ = DEFAULT_PARAMS.bodyHeight / 2;     // 0.17025 m — hinge z offset
const R = DEFAULT_PARAMS.panelWidth;          // 0.3405 m — outward reach
const T = DEFAULT_PARAMS.panelThickness;      // 0.0025 m
const H = DEFAULT_PARAMS.panelLength;         // 0.1 m — hinge-axis extent
const M_PANEL = DEFAULT_PARAMS.panelMass;     // 0.032 kg
const D = R / 2;
const IS2 = (1 / 12) * M_PANEL * (T * T + R * R);
const STOP = Math.PI / 2;

function testParams(over?: Partial<SimulationParams>): SimulationParams {
  return {
    ...DEFAULT_PARAMS,
    bodyMass: 40,
    hinge: {
      ...DEFAULT_PARAMS.hinge,
      springConstant: 2e-3,
      dampingCoeff: 5e-4,
      frictionCoeff: 0,
      panelStartDelays: undefined,
      shortEdgeStartDelays: undefined,
    },
    ...over,
  };
}

/** Hub principal inertia about x (fresh formula). */
function ibX(params: SimulationParams): number {
  return (1 / 12) * params.bodyMass *
    (params.bodyHeight * params.bodyHeight + params.bodyDepth * params.bodyDepth);
}

/** Panel CM position (y, z) at hinge angle θ; s = mount mirror sign (±1). */
function cmPos(s: number, theta: number): [number, number] {
  return [s * (HY + D * Math.sin(theta)), HZ - D * Math.cos(theta)];
}

/** Fresh planar mass-matrix entries for one panel at angle θ. */
function planarPanel(s: number, theta: number): { mPhiPhi: number; mPhiJ: number; mJJ: number } {
  const [y, z] = cmPos(s, theta);
  // dr/dθ = (s·d·cosθ, d·sinθ);  x̂×r = (−z, y) in the (y,z) plane.
  const dY = s * D * Math.cos(theta);
  const dZ = D * Math.sin(theta);
  return {
    mPhiPhi: IS2 + M_PANEL * (y * y + z * z),
    mPhiJ: s * IS2 + M_PANEL * (-z * dY + y * dZ),
    mJJ: IS2 + M_PANEL * D * D,
  };
}

/**
 * Literal gate reference: q̇⁺ = q̇⁻ − M⁻¹Jᵀ(JM⁻¹Jᵀ)⁻¹J·q̇⁻ for a dense
 * symmetric M (Gaussian elimination written fresh here), constraint = zero
 * the `latchIdx`-th generalized rate.
 */
function inelasticProjection(Mm: number[][], qdotMinus: number[], latchIdx: number): number[] {
  const n = qdotMinus.length;
  // Solve M·x = e_latch (dense, partial pivoting — fresh implementation).
  const solve = (A: number[][], b: number[]): number[] => {
    const a = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
      [a[col], a[piv]] = [a[piv], a[col]];
      for (let r = col + 1; r < n; r++) {
        const f = a[r][col] / a[col][col];
        for (let cc = col; cc <= n; cc++) a[r][cc] -= f * a[col][cc];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = a[r][n];
      for (let cc = r + 1; cc < n; cc++) s -= a[r][cc] * x[cc];
      x[r] = s / a[r][r];
    }
    return x;
  };
  const e = new Array(n).fill(0);
  e[latchIdx] = 1;
  const MinvJt = solve(Mm, e);                       // M⁻¹Jᵀ
  const lambda = qdotMinus[latchIdx] / MinvJt[latchIdx]; // (JM⁻¹Jᵀ)⁻¹ J q̇⁻
  return qdotMinus.map((v, i) => v - MinvJt[i] * lambda);
}

/** Step production until the given panel latches; returns the states around the event. */
function runToLatch(
  config: 'long-edge', params: SimulationParams, watch: number,
  setup: (s: SpacecraftState) => void, maxTime = 10,
): { prev: SpacecraftState; post: SpacecraftState } {
  let state = createInitialState(config);
  state.deploying = true;
  setup(state);
  const steps = Math.ceil(maxTime / params.timeStep);
  for (let i = 0; i < steps; i++) {
    const prev = state;
    state = stepSimulation(state, config, params);
    if (state.panels[watch].deployed && !prev.panels[watch].deployed) {
      return { prev, post: state };
    }
  }
  throw new Error('panel never latched');
}

describe('single-latch event vs independent planar projection (long-edge, panel 0 stuck)', () => {
  it('production post-event ω matches the snap-aware reference to solver precision, and the literal fixed-q projection within the quantified snap bound', () => {
    const params = testParams();
    const { prev, post } = runToLatch('long-edge', params, 1, s => {
      s.panels[0].stuck = true;
      s.panels[0].stuckAngle = 0;
      s.angularVelocity = new Vector3(0.05, 0, 0);
    });

    // Reconstruct the exact pre-event integrator output (same integrator,
    // same substep count, same classification as stepSimulation):
    const nSub = computeCoupledSubstepCount('long-edge', params);
    expect(nSub).toBe(1);
    const q = new Quaternion(prev._bodyQ!.x, prev._bodyQ!.y, prev._bodyQ!.z, prev._bodyQ!.w);
    const r = integrateCoupledSystemRK4(
      q, prev.angularVelocity.clone(),
      [prev.panels[0].stuckAngle, prev.panels[1].angle],
      [0, prev.panels[1].angularVelocity],
      [-1, 1], [STOP, STOP], KIN(params), params, params.timeStep,
    );

    const thetaMinus = r.thetasNew[1];
    const thetaDotMinus = r.thetaDotsNew[1];
    const omegaMinus = r.omegaBodyNew;
    // The latch condition must fire on this integrator output (margin 0.01 rad,
    // |θ̇| < 0.1 — zero friction ⇒ zero dead-band):
    expect(thetaMinus).toBeGreaterThanOrEqual(STOP - 0.01);
    expect(Math.abs(thetaDotMinus)).toBeLessThan(0.1);
    const snap = Math.abs(STOP - thetaMinus);
    expect(snap).toBeLessThanOrEqual(0.011);

    // Anchor the fresh planar M against the (independently validated)
    // momentum diagnostic at the pre-step state:
    const pp = planarPanel(1, prev.panels[1].angle);      // active +Y panel... panel 1 is NegY
    // Panel 1 is the −Y-mounted panel (mirror sign −1); panel 0 (stuck) at θ=0:
    const act = planarPanel(-1, prev.panels[1].angle);
    const stk = planarPanel(1, 0);
    void pp;
    const mPhiPhi = ibX(params) + act.mPhiPhi + stk.mPhiPhi;
    const hX = mPhiPhi * prev.angularVelocity.x + act.mPhiJ * prev.panels[1].angularVelocity;
    const hDiag = computeTotalAngularMomentum(prev, 'long-edge', params);
    expect(hX).toBeCloseTo(hDiag.x, 10);
    expect(Math.abs(hDiag.y)).toBeLessThan(1e-12);

    // Snap-aware reference (matches production's treatment: H_pre at θ⁻,
    // post inertia at θ⁺ = stop):
    const actMinus = planarPanel(-1, thetaMinus);
    const mPhiPhiMinus = ibX(params) + actMinus.mPhiPhi + stk.mPhiPhi;
    const hPre = mPhiPhiMinus * omegaMinus.x + actMinus.mPhiJ * thetaDotMinus;
    const actPlus = planarPanel(-1, STOP);
    const mPhiPhiPlus = ibX(params) + actPlus.mPhiPhi + stk.mPhiPhi;
    const omegaPlusRef = hPre / mPhiPhiPlus;

    expect(post.panels[1].angularVelocity).toBe(0);
    expect(post.angularVelocity.x).toBeCloseTo(omegaPlusRef, 12);
    expect(Math.abs(post.angularVelocity.y)).toBeLessThan(1e-12);
    expect(Math.abs(post.angularVelocity.z)).toBeLessThan(1e-12);

    // Literal fixed-q projection (the gate's formula, M at θ⁻): agreement is
    // bounded by the snap's inertia change |ΔM_φφ|/M_φφ ≈ 2m·d·hz·snap/M_φφ:
    const Mm = [
      [mPhiPhiMinus, actMinus.mPhiJ],
      [actMinus.mPhiJ, actMinus.mJJ],
    ];
    const proj = inelasticProjection(Mm, [omegaMinus.x, thetaDotMinus], 1);
    expect(proj[1]).toBeCloseTo(0, 15);
    const snapBound = (Math.abs(mPhiPhiPlus - mPhiPhiMinus) / mPhiPhiPlus) * Math.abs(proj[0]) + 1e-12;
    expect(Math.abs(post.angularVelocity.x - proj[0])).toBeLessThanOrEqual(snapBound * 1.5);

    // Total angular momentum is carried through the event exactly:
    const hPost = computeTotalAngularMomentum(post, 'long-edge', params);
    expect(hPost.x).toBeCloseTo(hDiag.x, 10);
  });
});

// Production kinematics accessor — used ONLY to drive the production
// integrator with production inputs; the reference formulas above never
// touch it.
function KIN(params: SimulationParams) {
  return getPanelKinematics('long-edge', params);
}

describe('multi-panel event: generalized projection distributes the impulse (hub AND still-active panel)', () => {
  it('latching panel zeroes; the active panel’s θ̇ jump equals the independent 3-DOF projection; H conserved', () => {
    const params = testParams({
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        springConstant: 2e-3,
        dampingCoeff: 5e-4,
        frictionCoeff: 0,
        panelStartDelays: [0, 0.35],
        shortEdgeStartDelays: undefined,
      },
    });
    const { prev, post } = runToLatch('long-edge', params, 0, s => {
      s.angularVelocity = new Vector3(0.05, 0, 0);
    });

    // Panel 0 (+Y, s=+1) latches; panel 1 (−Y, s=−1) is mid-deployment:
    expect(post.panels[0].deployed).toBe(true);
    expect(post.panels[1].deployed).toBe(false);
    expect(Math.abs(prev.panels[1].angularVelocity)).toBeGreaterThan(0.1);

    // Reconstruct the pre-event integrator output:
    const q = new Quaternion(prev._bodyQ!.x, prev._bodyQ!.y, prev._bodyQ!.z, prev._bodyQ!.w);
    const r = integrateCoupledSystemRK4(
      q, prev.angularVelocity.clone(),
      [prev.panels[0].angle, prev.panels[1].angle],
      [prev.panels[0].angularVelocity, prev.panels[1].angularVelocity],
      [0, 1], [STOP, STOP], KIN(params), params, params.timeStep,
    );
    const thetaL = r.thetasNew[0];       // latching panel angle (pre-snap)
    const thetaA = r.thetasNew[1];       // active panel angle (unchanged by event)
    const thdL = r.thetaDotsNew[0];
    const thdA = r.thetaDotsNew[1];
    const wMinus = r.omegaBodyNew;

    // Independent 3-DOF reference, replicating the two-geometry treatment
    // (H_pre and p_active⁻ at pre angles; projection at post angles):
    const L = (th: number) => planarPanel(1, th);
    const A = (th: number) => planarPanel(-1, th);
    const mPhiPhiMinus = ibX(params) + L(thetaL).mPhiPhi + A(thetaA).mPhiPhi;
    const hPre = mPhiPhiMinus * wMinus.x + L(thetaL).mPhiJ * thdL + A(thetaA).mPhiJ * thdA;
    const pActPre = A(thetaA).mPhiJ * wMinus.x + A(thetaA).mJJ * thdA;

    const mPhiPhiPlus = ibX(params) + L(STOP).mPhiPhi + A(thetaA).mPhiPhi;
    const kAct = A(thetaA).mPhiJ;
    const eAct = A(thetaA).mJJ;
    const meff = mPhiPhiPlus - (kAct * kAct) / eAct;
    const omegaPlusRef = (hPre - (kAct * pActPre) / eAct) / meff;
    const thdActPlusRef = (pActPre - kAct * omegaPlusRef) / eAct;

    expect(post.panels[0].angularVelocity).toBe(0);
    expect(post.panels[0].angle).toBe(STOP);
    expect(post.angularVelocity.x).toBeCloseTo(omegaPlusRef, 12);
    expect(post.panels[1].angularVelocity).toBeCloseTo(thdActPlusRef, 12);

    // The generalized projection genuinely engaged: the active panel's rate
    // moved (by the hub back-reaction), by a small, finite, physical amount:
    const jump = Math.abs(post.panels[1].angularVelocity - thdA);
    expect(jump).toBeGreaterThan(1e-12);
    expect(jump).toBeLessThan(0.05 * Math.abs(thdA));

    // Total angular momentum carried through the event exactly:
    const hBefore = computeTotalAngularMomentum(prev, 'long-edge', params);
    const hAfter = computeTotalAngularMomentum(post, 'long-edge', params);
    expect(hAfter.x).toBeCloseTo(hBefore.x, 10);
    expect(hAfter.clone().sub(hBefore).length() / hBefore.length()).toBeLessThan(1e-9);
  });

  it('non-event steps apply the integrator output untouched (no hidden momentum correction)', () => {
    const params = testParams();
    let state = createInitialState('long-edge');
    state.deploying = true;
    state.angularVelocity = new Vector3(0.05, 0, 0);
    // A mid-deployment step, far from any latch/floor event:
    for (let i = 0; i < 600; i++) state = stepSimulation(state, 'long-edge', params);
    const prev = state;
    const q = new Quaternion(prev._bodyQ!.x, prev._bodyQ!.y, prev._bodyQ!.z, prev._bodyQ!.w);
    const r = integrateCoupledSystemRK4(
      q, prev.angularVelocity.clone(),
      [prev.panels[0].angle, prev.panels[1].angle],
      [prev.panels[0].angularVelocity, prev.panels[1].angularVelocity],
      [0, 1], [STOP, STOP], KIN(params), params, params.timeStep,
    );
    const post = stepSimulation(prev, 'long-edge', params);
    expect(post.panels[0].deployed).toBe(false);
    expect(post.panels[1].deployed).toBe(false);
    // Bit-identical to the raw integrator output — nothing rewrote ω:
    expect(post.angularVelocity.x).toBe(r.omegaBodyNew.x);
    expect(post.angularVelocity.y).toBe(r.omegaBodyNew.y);
    expect(post.angularVelocity.z).toBe(r.omegaBodyNew.z);
    expect(post.panels[1].angularVelocity).toBe(r.thetaDotsNew[1]);
  });
});

describe('event-focused timestep refinement (dt, dt/2, dt/4)', () => {
  function refine(delays: number[] | undefined, watch: number) {
    const rows: {
      div: number; tEvent: number; omegaPost: number; thdActive: number;
      attitude: number; maxErr: number;
    }[] = [];
    for (const div of [1, 2, 4]) {
      const params = testParams({
        timeStep: DEFAULT_PARAMS.timeStep / div,
        hinge: {
          ...DEFAULT_PARAMS.hinge,
          springConstant: 2e-3, dampingCoeff: 5e-4, frictionCoeff: 0,
          panelStartDelays: delays, shortEdgeStartDelays: undefined,
        },
      });
      let state = createInitialState('long-edge');
      state.deploying = true;
      if (!delays) { state.panels[0].stuck = true; state.panels[0].stuckAngle = 0; }
      state.angularVelocity = new Vector3(0.05, 0, 0);
      const H0 = computeTotalAngularMomentum(state, 'long-edge', params);
      const steps = Math.ceil(6 / params.timeStep);
      let tEvent = NaN, omegaPost = NaN, thdActive = NaN, maxErr = 0;
      const sample = Math.max(1, Math.round(0.05 / params.timeStep));
      for (let i = 0; i < steps; i++) {
        const prevDeployed = state.panels[watch].deployed;
        state = stepSimulation(state, 'long-edge', params);
        if (!prevDeployed && state.panels[watch].deployed && Number.isNaN(tEvent)) {
          tEvent = state.time;
          omegaPost = state.angularVelocity.x;
          thdActive = state.panels[1 - watch].angularVelocity;
        }
        if (i % sample === 0) {
          const dH = computeTotalAngularMomentum(state, 'long-edge', params).sub(H0).length();
          maxErr = Math.max(maxErr, dH / H0.length());
        }
      }
      const qf = state._bodyQ!;
      rows.push({
        div, tEvent, omegaPost, thdActive,
        attitude: 2 * Math.acos(Math.min(1, Math.abs(qf.w))) * 180 / Math.PI,
        maxErr,
      });
    }
    return rows;
  }

  it('one-panel and multi-panel events: e_H criterion at every resolution; event time localizes at O(dt)', () => {
    for (const [label, delays, watch] of [
      ['one-stuck single latch', undefined, 1],
      ['multi-panel latch', [0, 0.35], 0],
    ] as const) {
      const rows = refine(delays as number[] | undefined, watch);
      for (const row of rows) {
        console.info(
          `[latch-refinement] ${label} dt/${row.div}: tEvent=${row.tEvent.toFixed(5)}s ` +
          `ωx⁺=${row.omegaPost.toExponential(6)} θ̇active⁺=${Number.isFinite(row.thdActive) ? row.thdActive.toExponential(4) : 'n/a'} ` +
          `finalAttitude=${row.attitude.toFixed(4)}° maxE_H=${row.maxErr.toExponential(3)}`,
        );
        expect(Number.isFinite(row.tEvent)).toBe(true);
        expect(row.maxErr).toBeLessThanOrEqual(FREE_FLOAT_MOMENTUM_ERROR_MAX);
      }
      // Event-time localization: detection is quantized to the step boundary,
      // so refinement must move the event time by no more than a few coarse
      // steps (NOT a fourth-order claim — the event is an instantaneous
      // constraint switch; fourth-order behavior applies to smooth segments
      // only, per coupledConvergence.test.ts):
      const spread = Math.abs(rows[0].tEvent - rows[2].tEvent);
      expect(spread).toBeLessThanOrEqual(3 * DEFAULT_PARAMS.timeStep);
      // Post-event hub rate consistent across refinement (impact resolution
      // is state-driven, not step-size-driven):
      const rel = Math.abs(rows[0].omegaPost - rows[2].omegaPost) /
        Math.max(Math.abs(rows[2].omegaPost), 1e-12);
      expect(rel).toBeLessThan(5e-3);
    }
  }, 120000);
});
