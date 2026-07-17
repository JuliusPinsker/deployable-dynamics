import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  stepSimulation,
  runFullSimulation,
} from '../lib/physics/engine';
import { DEFAULT_PARAMS, Vector3, type SimulationParams } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Timing resolution of the fixed physics timestep (dt = 1/1200 s ≈ 0.833 ms)
//
//  Millisecond-scale release-timing discrepancy (δt) is a first-class study
//  input, so the physics timestep must resolve it: panel activation happens on
//  the first step boundary at/after the requested delay (never rounded to
//  zero), and the achieved delay is within one timestep of the request.
//  Integration is deterministic fixed-step — never adaptive.
// ─────────────────────────────────────────────────────────────────────────────

const DT = DEFAULT_PARAMS.timeStep;

function withDelays(delays: number[], timeStep = DT): SimulationParams {
  return {
    ...DEFAULT_PARAMS,
    timeStep,
    hinge: { ...DEFAULT_PARAMS.hinge, panelStartDelays: delays },
  };
}

/** Simulation time at which the given panel first leaves θ = 0. */
function firstMoveTime(params: SimulationParams, panelIdx: number): number {
  let state = createInitialState('short-edge');
  state.deploying = true;
  const maxSteps = Math.ceil(1 / params.timeStep); // 1 s is ample for activation
  for (let i = 0; i < maxSteps; i++) {
    state = stepSimulation(state, 'short-edge', params);
    if (state.panels[panelIdx].angle > 1e-12) return state.time;
  }
  throw new Error(`panel ${panelIdx} never moved`);
}

describe('timestep represents the smallest supported δt study value (5 ms)', () => {
  it('physics timestep is fixed at 1/1200 s (≤ 1 ms) and deterministic', () => {
    expect(DT).toBeCloseTo(1 / 1200, 12);
    expect(DT).toBeLessThanOrEqual(0.001);
    // Determinism: identical inputs → bit-identical trajectories.
    const a = runFullSimulation('short-edge', withDelays([0, 0.005, 0, 0]), 5);
    const b = runFullSimulation('short-edge', withDelays([0, 0.005, 0, 0]), 5);
    expect(a.at(-1)!.angularVelocity).toEqual(b.at(-1)!.angularVelocity);
    expect(a.at(-1)!.panelAngles).toEqual(b.at(-1)!.panelAngles);
  });

  it('a 5 ms requested delay is NOT rounded to zero and is honoured within one timestep', () => {
    const tBaseline = firstMoveTime(withDelays([0, 0, 0, 0]), 1);   // first step: t = dt
    const tDelayed = firstMoveTime(withDelays([0, 0.005, 0, 0]), 1);

    // Activation must actually be delayed…
    expect(tDelayed).toBeGreaterThan(tBaseline);
    // …and the achieved release stagger must be within one physics timestep of 5 ms.
    // (Baseline first motion lands at t = dt, so the measured stagger is
    // tDelayed − tBaseline; the release itself snaps to the 5 ms step boundary.)
    const achievedStagger = tDelayed - tBaseline;
    expect(Math.abs(achievedStagger - 0.005)).toBeLessThanOrEqual(DT + 1e-12);
    // The delayed panel's first motion occurs at/after 5 ms, within one step of it.
    expect(tDelayed).toBeGreaterThanOrEqual(0.005 - 1e-12);
    expect(tDelayed).toBeLessThanOrEqual(0.005 + DT + 1e-12);
  });

  it('δt = 0 vs δt = 5 ms produce measurably different trajectories (staggered release)', () => {
    // Delay a SINGLE panel: delaying an opposite pair together ([0, δ, 0, δ])
    // keeps the release pairwise-symmetric and the reactions still cancel, so
    // the asymmetric single-panel stagger is the physically meaningful case.
    const ideal = runFullSimulation('short-edge', withDelays([0, 0, 0, 0]), 30);
    const d5 = runFullSimulation('short-edge', withDelays([0, 0.005, 0, 0]), 30);

    expect(d5.at(-1)!.angularVelocity).not.toEqual(ideal.at(-1)!.angularVelocity);

    // The 5 ms stagger must break the release symmetry with a real (nonzero)
    // body-rate transient, not just floating-point noise.
    const peak = (frames: ReturnType<typeof runFullSimulation>) =>
      Math.max(...frames.map(f =>
        new Vector3(f.angularVelocity.x, f.angularVelocity.y, f.angularVelocity.z).length()));
    expect(peak(d5)).toBeGreaterThan(peak(ideal) + 1e-9);
  });

  it('δt = 50 ms remains distinct from both 0 and 5 ms', () => {
    const ideal = runFullSimulation('short-edge', withDelays([0, 0, 0, 0]), 30);
    const d5 = runFullSimulation('short-edge', withDelays([0, 0.005, 0, 0]), 30);
    const d50 = runFullSimulation('short-edge', withDelays([0, 0.05, 0, 0]), 30);

    expect(d50.at(-1)!.angularVelocity).not.toEqual(ideal.at(-1)!.angularVelocity);
    expect(d50.at(-1)!.angularVelocity).not.toEqual(d5.at(-1)!.angularVelocity);

    // Release times differ step-exactly too.
    const t5 = firstMoveTime(withDelays([0, 0.005, 0, 0]), 1);
    const t50 = firstMoveTime(withDelays([0, 0.05, 0, 0]), 1);
    expect(Math.abs(t50 - t5 - 0.045)).toBeLessThanOrEqual(DT + 1e-12);
  });

  it('reports dt vs dt/2 convergence for an asymmetric 5 ms timing case', () => {
    // Single delayed panel → asymmetric release transient. Halving the timestep
    // must not change the physics qualitatively; the peak body rate magnitude is
    // reported so the resolution of the δt transient is documented, not hidden.
    const peakW = (timeStep: number) => {
      const frames = runFullSimulation('short-edge', withDelays([0, 0.005, 0, 0], timeStep), 30);
      return Math.max(...frames.map(f =>
        new Vector3(f.angularVelocity.x, f.angularVelocity.y, f.angularVelocity.z).length()));
    };
    const pDt = peakW(DT);
    const pHalf = peakW(DT / 2);
    const relDiff = Math.abs(pDt - pHalf) / Math.max(pDt, 1e-30);

    // eslint-disable-next-line no-console
    console.info(
      `[timestep-convergence] asymmetric 5 ms case: peak|ω| dt=1/1200 → ${pDt.toExponential(4)} rad/s, ` +
      `dt=1/2400 → ${pHalf.toExponential(4)} rad/s, relative difference ${(relDiff * 100).toFixed(1)}%`,
    );

    // Both resolutions must see a real transient of the same order of magnitude.
    expect(pDt).toBeGreaterThan(0);
    expect(pHalf).toBeGreaterThan(0);
    expect(pHalf).toBeGreaterThan(pDt * 0.3);
    expect(pHalf).toBeLessThan(pDt * 3);
  });
});
