import { describe, it, expect } from 'vitest';
import { deploymentSettleCut } from '../pages/ComparePage';
import type { SimulationFrame } from '../lib/physics/engine';

// deploymentSettleCut only reads `panelAngles`; build minimal frames for the pure-function test.
function frames(maxAngles: number[]): SimulationFrame[] {
  return maxAngles.map(a => ({ panelAngles: [a] }) as unknown as SimulationFrame);
}

describe('deploymentSettleCut — trims the post-deployment coast tail', () => {
  it('cuts just past the plateau for a monotonic deployment, excluding the flat coast tail', () => {
    // ramp 0→1.5 (idx 0..3), then held at 1.5 for a long coast tail (idx 4..7)
    const f = frames([0, 0.5, 1.0, 1.5, 1.5, 1.5, 1.5, 1.5]);
    // last frame outside the band is idx 2 (1.0); +3 buffer → 5
    expect(deploymentSettleCut(f)).toBe(5);
    expect(deploymentSettleCut(f)).toBeLessThan(f.length); // tail is trimmed
  });

  it('includes the last oscillation excursion for a ringing deployment (no mid-ring cut)', () => {
    // overshoot to 1.6, dip to 1.4, ring down, settle+hold at 1.5
    const f = frames([0, 0.8, 1.6, 1.4, 1.55, 1.48, 1.5, 1.5, 1.5, 1.5]);
    // last frame outside the band is idx 5 (1.48); +3 buffer → 8 (past the ringing, before the tail)
    expect(deploymentSettleCut(f)).toBe(8);
    expect(deploymentSettleCut(f)).toBeGreaterThan(3); // did NOT cut at the overshoot (idx 2)
    expect(deploymentSettleCut(f)).toBeLessThan(f.length); // tail is trimmed
  });

  it('returns 1 when nothing ever deploys (all-stuck: angles stay 0)', () => {
    expect(deploymentSettleCut(frames([0, 0, 0, 0, 0]))).toBe(1);
  });
});
