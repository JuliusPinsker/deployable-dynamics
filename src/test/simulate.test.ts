import { describe, it, expect } from 'vitest';
import { runFullSimulation } from '../lib/physics/engine';
import { DEFAULT_PARAMS } from '../lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Deployment timing — physics-driven torsional-hinge dynamics (the only mode).
//
//  All times are OUTPUTS of the dynamics under the CALIBRATED default hinge
//  (engineering calibration, see calibration.ts / DEFAULT_PARAMS:
//  k = 7.729e-3 N·m/rad, c = 4.947e-3 N·m·s/rad → ωₙ = 2.50 rad/s, ζ = 0.80,
//  underdamped; Phase-B corrected hinge-edge inertia and coupled EOM; the
//  Gate-A all-rows timing window drives the ζ = 0.80 selection).
//  Measured on DEFAULT_PARAMS/FR4 at the 1/1200 s timestep:
//    - long-edge t₉₀ (first reach of 90% of the deployed angle) ≈ 1.23 s;
//      latch ≈ 1.74 s (the ζ = 0.80 panel decelerates into the friction
//      dead-band just short of the stop; the latch captures the final
//      ≈0.92° — no ballistic stop impact, zero overshoot)
//    - double-long-edge stage 1 latch ≈ 1.55 s: the stage-1 panel carries
//      its folded stage-2 rider, which doubles the assembly inertia and
//      HALVES the effective damping ratio (ζ_eff = ζ/√2 ≈ 0.57) — so the
//      assembly arrives at the stop ballistically and latches FASTER than a
//      lone long-edge panel at ζ = 0.80; stage 2 latch ≈ 3.35 s absolute
//  Assertions use target WINDOWS + physical properties, not prescribed times.
// ─────────────────────────────────────────────────────────────────────────────

describe('sample simulation (3U)', () => {
  it('runs long-edge for 5s and produces frames', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 5);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('long-edge deploys under hinge dynamics: t₉₀ in window, bounded overshoot, stop held after latch', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 10);
    expect(frames.length).toBeGreaterThan(0);

    const stopAngle = DEFAULT_PARAMS.hinge.stopAngle;
    const angleSeries = frames.map(f => f.panelAngles[0]);

    // Calculated deployment time t₉₀ — inside the calibration target window
    // (1.0–2.0 s), measured ≈ 1.52 s.
    const t90Frame = frames.find(f => f.panelAngles[0] >= 0.9 * stopAngle);
    expect(t90Frame).toBeDefined();
    expect(t90Frame!.time).toBeGreaterThan(1.0);
    expect(t90Frame!.time).toBeLessThan(2.0);

    // Stop capture: bounded overshoot only (lightly damped arrival into the
    // overdamped mechanical stop; measured penetration ≈ 0.07°).
    expect(Math.max(...angleSeries)).toBeLessThanOrEqual(stopAngle + 0.005);

    // Latch (deployment complete) shortly after — a DIFFERENT quantity than t₉₀.
    const latched = frames.find(f => f.panelAngles[0] >= stopAngle - 1e-9);
    expect(latched).toBeDefined();
    expect(latched!.time).toBeGreaterThan(1.3);
    expect(latched!.time).toBeLessThan(2.1);

    // No persistent post-stop oscillation: every frame after latch holds the stop.
    for (const f of frames.filter(f => f.time > latched!.time)) {
      expect(f.panelAngles[0]).toBeCloseTo(stopAngle, 9);
    }
  });

  it('double-long-edge deploys in two sequential stages under hinge dynamics', () => {
    const frames = runFullSimulation('double-long-edge', DEFAULT_PARAMS, 12);
    expect(frames.length).toBeGreaterThan(0);

    const stopAngle = DEFAULT_PARAMS.hinge.stopAngle;  // π/2 for stage 1
    const stage2MaxAngle = Math.PI;                     // 180° for stage 2

    // Bounded overshoot for all panels (no unbounded angles / instability;
    // stage-2 arrival penetrates the stop slightly deeper under the ≈4×
    // stiffer recalibrated spring — measured ≈ 0.36°, bound 0.57°).
    for (let p = 0; p < 2; p++) {
      expect(Math.max(...frames.map(f => f.panelAngles[p]))).toBeLessThanOrEqual(stopAngle + 0.01);
    }
    for (let p = 2; p < 4; p++) {
      expect(Math.max(...frames.map(f => f.panelAngles[p]))).toBeLessThanOrEqual(stage2MaxAngle + 0.01);
    }

    // Stage 1 latches at ~1.55 s (dynamics outcome, window not prescription).
    // The folded stage-2 rider doubles the assembly inertia AND halves the
    // effective damping ratio (ζ_eff ≈ 0.57), so the assembly reaches the
    // stop ballistically — faster to latch than a lone ζ = 0.80 panel.
    const stage1Done = frames.find(f =>
      f.panelAngles[0] >= stopAngle - 1e-9 && f.panelAngles[1] >= stopAngle - 1e-9
    );
    expect(stage1Done).toBeDefined();
    expect(stage1Done!.time).toBeGreaterThan(1.2);
    expect(stage1Done!.time).toBeLessThan(1.9);

    // Stage 2 panels must NOT move during Stage 1
    const duringStage1 = frames.filter(f => f.time < stage1Done!.time - 0.1);
    for (const f of duringStage1) {
      expect(f.panelAngles[2]).toBeCloseTo(0, 5);
      expect(f.panelAngles[3]).toBeCloseTo(0, 5);
    }

    // Stage 2 (0 → π) latches at ~3.35 s absolute
    const stage2Done = frames.find(f =>
      f.panelAngles[2] >= stage2MaxAngle - 1e-9 && f.panelAngles[3] >= stage2MaxAngle - 1e-9
    );
    expect(stage2Done).toBeDefined();
    expect(stage2Done!.time).toBeGreaterThan(2.9);
    expect(stage2Done!.time).toBeLessThan(3.8);

    // Final frame: latch holds stage 1 at π/2, stage 2 at π exactly
    const last = frames[frames.length - 1];
    expect(last.panelAngles[0]).toBeCloseTo(stopAngle, 9);
    expect(last.panelAngles[1]).toBeCloseTo(stopAngle, 9);
    expect(last.panelAngles[2]).toBeCloseTo(stage2MaxAngle, 9);
    expect(last.panelAngles[3]).toBeCloseTo(stage2MaxAngle, 9);
  }, 30000);

  it('short-edge supports per-panel delayed activation with same motion profile', () => {
    const delay = 1.5;
    const params = {
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        shortEdgeStartDelays: [0, delay, 0, delay] as [number, number, number, number],
      },
    };

    const frames = runFullSimulation('short-edge', params, 15);
    expect(frames.length).toBeGreaterThan(0);

    const beforeDelay = frames.findLast(f => f.time < delay - 0.1);
    expect(beforeDelay).toBeDefined();
    expect(beforeDelay!.panelAngles[1]).toBeCloseTo(0, 6);
    expect(beforeDelay!.panelAngles[3]).toBeCloseTo(0, 6);

    const afterDelay = frames.find(f => f.time > delay + 0.2);
    expect(afterDelay).toBeDefined();
    expect(afterDelay!.panelAngles[1]).toBeGreaterThan(0);
    expect(afterDelay!.panelAngles[3]).toBeGreaterThan(0);

    // Same dynamics profile: delayed panel at (delay + t) matches immediate panel at t.
    // (The [0, δ, 0, δ] pattern keeps opposite pairs symmetric, so the body barely
    // rotates and the shifted profiles agree to high precision.)
    const sampleT = 0.8;
    const leaderFrame = frames.find(f => f.time >= sampleT);
    const delayedFrame = frames.find(f => f.time >= delay + sampleT);
    expect(leaderFrame).toBeDefined();
    expect(delayedFrame).toBeDefined();

    expect(delayedFrame!.panelAngles[1]).toBeCloseTo(leaderFrame!.panelAngles[0], 5);
    expect(delayedFrame!.panelAngles[3]).toBeCloseTo(leaderFrame!.panelAngles[2], 5);
  }, 30000);

  it('δt at/above the 1/1200 s timestep alters the trajectory; sub-timestep δt quantises to zero', () => {
    const mkParams = (delays: number[]) => ({
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        panelStartDelays: delays,
      },
    });

    const framesIdeal = runFullSimulation('short-edge', mkParams([0, 0, 0, 0]), 15);

    // 5 ms = 6 physics steps at dt = 1/1200 s: activation shifts, trajectory diverges.
    // (See timingResolution.test.ts for the full δt resolution suite.)
    const frames5ms = runFullSimulation('short-edge', mkParams([0, 0.005, 0, 0.005]), 15);
    expect(frames5ms.at(-1)!.angularVelocity).not.toEqual(framesIdeal.at(-1)!.angularVelocity);

    // 0.4 ms < timeStep (0.833 ms): activation is resolved at timestep resolution,
    // so the run is bit-identical to ideal sync. Documented engine limitation.
    const framesSubStep = runFullSimulation('short-edge', mkParams([0, 0.0004, 0, 0.0004]), 15);
    expect(framesSubStep.at(-1)!.angularVelocity).toEqual(framesIdeal.at(-1)!.angularVelocity);
    expect(framesSubStep.at(-1)!.panelAngles).toEqual(framesIdeal.at(-1)!.panelAngles);
  }, 30000);

  it('coupled enforces three stages with stage-relative short-edge delay', () => {
    const delay = 0.8;
    const params = {
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        shortEdgeStartDelays: [0, delay, 0, delay] as [number, number, number, number],
      },
    };

    const frames = runFullSimulation('short-edge-long-edge', params, 20);
    expect(frames.length).toBeGreaterThan(0);

    const stage1Stop = params.hinge.stopAngle;
    const stage2Stop = Math.PI;
    const stage3Stop = Math.PI / 2;

    // Stage 1 latches at ~1.55 s (rider-halved damping ratio, see the
    // double-long-edge test above)
    const stage1Done = frames.find(f =>
      f.panelAngles[0] >= stage1Stop - 1e-9 && f.panelAngles[1] >= stage1Stop - 1e-9,
    );
    expect(stage1Done).toBeDefined();
    expect(stage1Done!.time).toBeGreaterThan(1.2);
    expect(stage1Done!.time).toBeLessThan(1.9);

    for (const f of frames.filter(f => f.time < stage1Done!.time - 0.1)) {
      for (let p = 2; p < 8; p++) expect(f.panelAngles[p]).toBeCloseTo(0, 5);
    }

    // Stage 2 latches at ~3.35 s absolute
    const stage2Done = frames.find(f =>
      f.panelAngles[2] >= stage2Stop - 1e-9 && f.panelAngles[3] >= stage2Stop - 1e-9,
    );
    expect(stage2Done).toBeDefined();
    expect(stage2Done!.time).toBeGreaterThan(2.9);
    expect(stage2Done!.time).toBeLessThan(3.8);

    for (const f of frames.filter(f => f.time < stage2Done!.time - 0.1)) {
      for (let p = 4; p < 8; p++) expect(f.panelAngles[p]).toBeCloseTo(0, 5);
    }

    // Stage-3 delays are STAGE-RELATIVE: delayed panels 5 & 7 hold stowed until
    // (stage-2 completion + δ), then activate.
    const beforeDelayedStart = frames.findLast(f => f.time < stage2Done!.time + delay - 0.1);
    expect(beforeDelayedStart).toBeDefined();
    expect(beforeDelayedStart!.panelAngles[5]).toBeCloseTo(0, 5);
    expect(beforeDelayedStart!.panelAngles[7]).toBeCloseTo(0, 5);

    const afterDelayedStart = frames.find(f => f.time > stage2Done!.time + delay + 0.2);
    expect(afterDelayedStart).toBeDefined();
    expect(afterDelayedStart!.panelAngles[5]).toBeGreaterThan(0);
    expect(afterDelayedStart!.panelAngles[7]).toBeGreaterThan(0);

    // Fully deployed: every latch holds its stop exactly
    const last = frames[frames.length - 1];
    expect(last.panelAngles[0]).toBeCloseTo(stage1Stop, 9);
    expect(last.panelAngles[1]).toBeCloseTo(stage1Stop, 9);
    expect(last.panelAngles[2]).toBeCloseTo(stage2Stop, 9);
    expect(last.panelAngles[3]).toBeCloseTo(stage2Stop, 9);
    expect(last.panelAngles[4]).toBeCloseTo(stage3Stop, 9);
    expect(last.panelAngles[5]).toBeCloseTo(stage3Stop, 9);
    expect(last.panelAngles[6]).toBeCloseTo(stage3Stop, 9);
    expect(last.panelAngles[7]).toBeCloseTo(stage3Stop, 9);
  }, 30000);
});
