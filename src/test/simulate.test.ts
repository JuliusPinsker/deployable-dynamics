import { describe, it, expect } from 'vitest';
import { runFullSimulation } from '../lib/physics/engine';
import { DEFAULT_PARAMS } from '../lib/physics/types';

describe('sample simulation (3U)', () => {
  it('runs long-edge for 5s and logs summary', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 5);
    console.log('--- simulation summary ---');
    console.log('frames recorded:', frames.length);
    if (frames.length > 0) {
      const first = frames[0];
      const last = frames[frames.length - 1];
      console.log('start time:', first.time, 's  end time:', last.time, 's');
      console.log('final panel angles (deg):', last.panelAngles.map(a => (a * 180 / Math.PI).toFixed(1)).join(', '));
      console.log('final total contact force (N):', last.totalContactForce.toFixed(3));
    }

    expect(frames.length).toBeGreaterThan(0);
  });

  it('long-edge panels deploy in ~2.0s (ease-out) with no overshoot', () => {
    const frames = runFullSimulation('long-edge', DEFAULT_PARAMS, 6);
    expect(frames.length).toBeGreaterThan(0);

    const stopAngle = DEFAULT_PARAMS.hinge.stopAngle;

    // deployment should be monotonic (no oscillation/overshoot) and reach the stop in ~2s
    const angleSeries = frames.map(f => f.panelAngles[0]);

    // monotonic (non-decreasing) check
    for (let i = 1; i < angleSeries.length; i++) {
      expect(angleSeries[i]).toBeGreaterThanOrEqual(angleSeries[i - 1] - 1e-9);
    }

    // no overshoot
    expect(Math.max(...angleSeries)).toBeLessThanOrEqual(stopAngle + 1e-6);

    // find first frame where panel has effectively reached the stop (99.9%)
    const deployedFrame = frames.find(f => f.panelAngles[0] >= 0.999 * stopAngle);
    expect(deployedFrame).toBeDefined();
    // expect deployment time ~2.0s (tolerance ±0.25s)
    expect(deployedFrame!.time).toBeGreaterThan(1.75);
    expect(deployedFrame!.time).toBeLessThan(2.25);
  });

  it('double-long-edge panels deploy in two stages with no overshoot', () => {
    const frames = runFullSimulation('double-long-edge', DEFAULT_PARAMS, 6);
    expect(frames.length).toBeGreaterThan(0);

    const stopAngle = DEFAULT_PARAMS.hinge.stopAngle;  // π/2 for stage 1
    const stage2MaxAngle = Math.PI;                     // 180° for stage 2

    // Stage 1 panels (0, 1): monotonic increase, max = stopAngle (90°)
    for (let p = 0; p < 2; p++) {
      const series = frames.map(f => f.panelAngles[p]);
      for (let i = 1; i < series.length; i++) {
        expect(series[i]).toBeGreaterThanOrEqual(series[i - 1] - 1e-9);
      }
      expect(Math.max(...series)).toBeLessThanOrEqual(stopAngle + 1e-6);
    }

    // Stage 2 panels (2, 3): monotonic increase, max = π (180°)
    for (let p = 2; p < 4; p++) {
      const series = frames.map(f => f.panelAngles[p]);
      for (let i = 1; i < series.length; i++) {
        expect(series[i]).toBeGreaterThanOrEqual(series[i - 1] - 1e-9);
      }
      expect(Math.max(...series)).toBeLessThanOrEqual(stage2MaxAngle + 1e-6);
    }

    // Stage 1 completes at ~2.0s
    const stage1Done = frames.find(f =>
      f.panelAngles[0] >= 0.999 * stopAngle && f.panelAngles[1] >= 0.999 * stopAngle
    );
    expect(stage1Done).toBeDefined();
    expect(stage1Done!.time).toBeGreaterThan(1.75);
    expect(stage1Done!.time).toBeLessThan(2.25);

    // Stage 2 panels must NOT move during Stage 1
    const duringStage1 = frames.filter(f => f.time < stage1Done!.time);
    for (const f of duringStage1) {
      expect(f.panelAngles[2]).toBeCloseTo(0, 5);
      expect(f.panelAngles[3]).toBeCloseTo(0, 5);
    }

    // Stage 2 completes at ~4.0s (2× deployDuration)
    const stage2Done = frames.find(f =>
      f.panelAngles[2] >= 0.999 * stage2MaxAngle && f.panelAngles[3] >= 0.999 * stage2MaxAngle
    );
    expect(stage2Done).toBeDefined();
    expect(stage2Done!.time).toBeGreaterThan(3.75);
    expect(stage2Done!.time).toBeLessThan(4.25);

    // Final frame: stage 1 at π/2, stage 2 at π
    const last = frames[frames.length - 1];
    expect(last.panelAngles[0]).toBeCloseTo(stopAngle, 5);
    expect(last.panelAngles[1]).toBeCloseTo(stopAngle, 5);
    expect(last.panelAngles[2]).toBeCloseTo(stage2MaxAngle, 5);
    expect(last.panelAngles[3]).toBeCloseTo(stage2MaxAngle, 5);
  });

  it('short-edge supports per-panel delayed activation with same motion profile', () => {
    const delay = 1.5;
    const params = {
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        deployDuration: 2.0,
        shortEdgeStartDelays: [0, delay, 0, delay] as [number, number, number, number],
      },
    };

    const frames = runFullSimulation('short-edge', params, 6);
    expect(frames.length).toBeGreaterThan(0);

    const beforeDelay = frames.findLast(f => f.time < delay - 0.1);
    expect(beforeDelay).toBeDefined();
    expect(beforeDelay!.panelAngles[1]).toBeCloseTo(0, 6);
    expect(beforeDelay!.panelAngles[3]).toBeCloseTo(0, 6);

    const afterDelay = frames.find(f => f.time > delay + 0.2);
    expect(afterDelay).toBeDefined();
    expect(afterDelay!.panelAngles[1]).toBeGreaterThan(0);
    expect(afterDelay!.panelAngles[3]).toBeGreaterThan(0);

    // Same speed profile check: delayed panel at (delay + t) should match immediate panel at t.
    const sampleT = 0.8;
    const leaderFrame = frames.find(f => f.time >= sampleT);
    const delayedFrame = frames.find(f => f.time >= delay + sampleT);
    expect(leaderFrame).toBeDefined();
    expect(delayedFrame).toBeDefined();

    expect(delayedFrame!.panelAngles[1]).toBeCloseTo(leaderFrame!.panelAngles[0], 1);
    expect(delayedFrame!.panelAngles[3]).toBeCloseTo(leaderFrame!.panelAngles[2], 1);
  });

  it('5 ms per-panel delay produces different trajectory than ideal sync', () => {
    const delay = 5e-3;
    const paramsIdeal = {
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        panelStartDelays: [0, 0, 0, 0],
      },
    };
    const paramsDelayed = {
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        panelStartDelays: [0, delay, 0, delay],
      },
    };

    const framesIdeal = runFullSimulation('short-edge', paramsIdeal, 6);
    const framesDelayed = runFullSimulation('short-edge', paramsDelayed, 6);
    const wIdeal = framesIdeal.at(-1)!.angularVelocity;
    const wDelayed = framesDelayed.at(-1)!.angularVelocity;
    expect(wIdeal).not.toEqual(wDelayed);
  });

  it('coupled enforces three stages with optional short-edge delay', () => {
    const delay = 0.8;
    const params = {
      ...DEFAULT_PARAMS,
      hinge: {
        ...DEFAULT_PARAMS.hinge,
        deployDuration: 2.0,
        shortEdgeStartDelays: [0, delay, 0, delay] as [number, number, number, number],
      },
    };

    const frames = runFullSimulation('short-edge-long-edge', params, 8);
    expect(frames.length).toBeGreaterThan(0);

    const stage1Stop = params.hinge.stopAngle;
    const stage2Stop = Math.PI;
    const stage3Stop = Math.PI / 2;

    const stage1Done = frames.find(f =>
      f.panelAngles[0] >= 0.999 * stage1Stop && f.panelAngles[1] >= 0.999 * stage1Stop,
    );
    expect(stage1Done).toBeDefined();
    expect(stage1Done!.time).toBeGreaterThan(1.75);
    expect(stage1Done!.time).toBeLessThan(2.25);

    for (const f of frames.filter(f => f.time < stage1Done!.time)) {
      expect(f.panelAngles[2]).toBeCloseTo(0, 5);
      expect(f.panelAngles[3]).toBeCloseTo(0, 5);
      expect(f.panelAngles[4]).toBeCloseTo(0, 5);
      expect(f.panelAngles[5]).toBeCloseTo(0, 5);
      expect(f.panelAngles[6]).toBeCloseTo(0, 5);
      expect(f.panelAngles[7]).toBeCloseTo(0, 5);
    }

    const stage2Done = frames.find(f =>
      f.panelAngles[2] >= 0.999 * stage2Stop && f.panelAngles[3] >= 0.999 * stage2Stop,
    );
    expect(stage2Done).toBeDefined();
    expect(stage2Done!.time).toBeGreaterThan(3.75);
    expect(stage2Done!.time).toBeLessThan(4.25);

    for (const f of frames.filter(f => f.time < stage2Done!.time)) {
      expect(f.panelAngles[4]).toBeCloseTo(0, 5);
      expect(f.panelAngles[5]).toBeCloseTo(0, 5);
      expect(f.panelAngles[6]).toBeCloseTo(0, 5);
      expect(f.panelAngles[7]).toBeCloseTo(0, 5);
    }

    const beforeDelayedStart = frames.findLast(f => f.time < 4 + delay - 0.1);
    expect(beforeDelayedStart).toBeDefined();
    expect(beforeDelayedStart!.panelAngles[5]).toBeCloseTo(0, 5);
    expect(beforeDelayedStart!.panelAngles[7]).toBeCloseTo(0, 5);

    const afterDelayedStart = frames.find(f => f.time > 4 + delay + 0.2);
    expect(afterDelayedStart).toBeDefined();
    expect(afterDelayedStart!.panelAngles[5]).toBeGreaterThan(0);
    expect(afterDelayedStart!.panelAngles[7]).toBeGreaterThan(0);

    const last = frames[frames.length - 1];
    expect(last.panelAngles[0]).toBeCloseTo(stage1Stop, 5);
    expect(last.panelAngles[1]).toBeCloseTo(stage1Stop, 5);
    expect(last.panelAngles[2]).toBeCloseTo(stage2Stop, 5);
    expect(last.panelAngles[3]).toBeCloseTo(stage2Stop, 5);
    expect(last.panelAngles[4]).toBeCloseTo(stage3Stop, 5);
    expect(last.panelAngles[5]).toBeCloseTo(stage3Stop, 5);
    expect(last.panelAngles[6]).toBeCloseTo(stage3Stop, 5);
    expect(last.panelAngles[7]).toBeCloseTo(stage3Stop, 5);
  });
});
