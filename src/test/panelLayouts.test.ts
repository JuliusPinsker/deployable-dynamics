import { describe, it, expect } from 'vitest';
import { Euler, Vector3 } from 'three';
import { getPanelSpecs } from '@/lib/physics/panelLayouts';
import { DEFAULT_PARAMS } from '@/lib/physics/types';

describe('getPanelSpecs - long-edge configuration (side-mounted panels)', () => {
  // Coordinate system: X = right, Y = forward, Z = up
  const hy = DEFAULT_PARAMS.bodyDepth / 2;   // 0.05
  const hz = DEFAULT_PARAMS.bodyHeight / 2;  // 0.17025

  it('returns 2 panels for long-edge mounted on ±Y faces', () => {
    const specs = getPanelSpecs('long-edge', DEFAULT_PARAMS);
    expect(specs.length).toBe(2);

    const L = DEFAULT_PARAMS.panelLength;   // 0.1m width along hinge (X)
    const W = DEFAULT_PARAMS.panelWidth;    // 0.3405m deploy length (Z)

    // Hinges at Y = ±hy (on ±Y faces), X = 0, Z = hz (top edge of face)
    expect(specs[0].hinge[1]).toBeCloseTo(hy, 6);   // +Y face
    expect(specs[1].hinge[1]).toBeCloseTo(-hy, 6);  // -Y face
    
    // Both hinges at X = 0, Z = hz
    expect(specs[0].hinge[0]).toBeCloseTo(0, 6);
    expect(specs[0].hinge[2]).toBeCloseTo(hz, 6);
    expect(specs[1].hinge[0]).toBeCloseTo(0, 6);
    expect(specs[1].hinge[2]).toBeCloseTo(hz, 6);

    // Panel sizes: [width along X (hinge span), thickness, deploy length along Z]
    expect(specs[0].size[0]).toBeCloseTo(L, 6);     // 0.1m along X (hinge edge)
    expect(specs[1].size[0]).toBeCloseTo(L, 6);
    expect(specs[0].size[2]).toBeCloseTo(W, 6);     // 0.3405m along Z (deploy direction)
    expect(specs[1].size[2]).toBeCloseTo(W, 6);

    // Hinge axis should be 'x' for ±Y faces (rotation about X)
    expect(specs[0].axis).toBe('x');
    expect(specs[1].axis).toBe('x');
  });

  it('returns 4 panels for double-long-edge (2 first-stage + 2 second-stage hierarchical)', () => {
    const specs = getPanelSpecs('double-long-edge', DEFAULT_PARAMS);
    expect(specs.length).toBe(4);

    const L = DEFAULT_PARAMS.panelLength;   // 0.1m
    const W = DEFAULT_PARAMS.panelWidth;    // 0.3405m

    // All hinges at Z = hz (top deck) for first-stage, or hz-W for second-stage (stowed)
    
    // First-stage panels (0,1) - identical to long-edge config on ±Y faces
    const firstStage = specs.slice(0, 2);
    firstStage.forEach(s => {
      expect(s.size[0]).toBeCloseTo(L, 6);     // width along X
      expect(s.size[2]).toBeCloseTo(W, 6);     // deploy length along Z
      expect(s.axis).toBe('x');                // X-axis rotation
      expect(s.hinge[0]).toBeCloseTo(0, 6);    // centered on X
      expect(s.hinge[2]).toBeCloseTo(hz, 6);   // at top
      expect(s.parentIndex).toBeUndefined();   // root panels
      expect(s.stage).toBe(1);                 // primary stage
      expect(s.maxAngle).toBeCloseTo(Math.PI / 2, 6);  // 90°
    });
    expect(firstStage[0].hinge[1]).toBeCloseTo(hy, 6);   // +Y face
    expect(firstStage[1].hinge[1]).toBeCloseTo(-hy, 6);  // -Y face

    // Second-stage panels (2,3) - children of first-stage (accordion fold)
    // X-axis hinge (parallel to parent), 180° deployment, no pre-rotation
    const secondStage = specs.slice(2, 4);
    secondStage.forEach((s, i) => {
      expect(s.axis).toBe('x');                // X-axis rotation (parallel to parent hinge)
      expect(s.size[0]).toBeCloseTo(L, 6);     // same width
      expect(s.size[2]).toBeCloseTo(W, 6);     // same deploy length
      expect(s.parentIndex).toBe(i);           // child of panel 0 or 1
      expect(s.hingeOffset).toBeDefined();
      expect(s.hingeOffset![2]).toBeCloseTo(-W, 6);  // hinge at outer edge of parent
      expect(s.rot).toEqual([0, 0, 0]);        // NO pre-rotation (panels lie flat on parents)
      expect(s.stage).toBe(2);                 // secondary stage
      expect(s.maxAngle).toBeCloseTo(Math.PI, 6);    // 180°
    });
  });

  it('returns 4 short-edge panels mounted flat on ±Z faces with X-axis hinges', () => {
    const specs = getPanelSpecs('short-edge', DEFAULT_PARAMS);
    expect(specs.length).toBe(4);

    const topPanels = specs.filter(s => s.hinge[2] > 0);
    const bottomPanels = specs.filter(s => s.hinge[2] < 0);
    expect(topPanels.length).toBe(2);
    expect(bottomPanels.length).toBe(2);

    // All panels use X-axis hinges and are centered on X=0 with hinges at Y=±hy.
    specs.forEach(s => {
      expect(s.axis).toBe('x');
      expect(s.hinge[0]).toBeCloseTo(0, 6);
      expect(Math.abs(s.hinge[1])).toBeCloseTo(hy, 6);
      expect(s.size[0]).toBeCloseTo(0.1, 6);
      expect(s.size[2]).toBeCloseTo(0.1, 6);
    });

    // Top panels on +Z face, bottom panels on -Z face.
    topPanels.forEach(s => expect(s.hinge[2]).toBeCloseTo(hz, 6));
    bottomPanels.forEach(s => expect(s.hinge[2]).toBeCloseTo(-hz, 6));

    // Stowed panel normals must align with ±Z (flat and parallel to ±Z faces).
    specs.forEach(s => {
      const normal = new Vector3(0, 1, 0).applyEuler(new Euler(s.rot[0], s.rot[1], s.rot[2], 'XYZ'));
      expect(Math.abs(normal.z)).toBeGreaterThan(0.999);
      expect(Math.abs(normal.x)).toBeLessThan(1e-6);
      expect(Math.abs(normal.y)).toBeLessThan(1e-6);
    });

    // All panels must deploy outward from the body for +theta rotation.
    const theta = Math.PI / 6;
    for (const s of specs) {
      const mount = new Euler(s.rot[0], s.rot[1], s.rot[2], 'XYZ');
      const hingeStep = new Euler(theta, 0, 0, 'XYZ');

      const pos = new Vector3(s.pos[0], s.pos[1], s.pos[2]);
      const offset = pos.applyEuler(hingeStep).applyEuler(mount);
      const zStep = s.hinge[2] + offset.z;

      // For top panels (hinge z > 0), outward means z increases from hinge plane.
      // For bottom panels (hinge z < 0), outward means z decreases from hinge plane.
      const outwardSign = Math.sign(s.hinge[2]);
      expect(outwardSign * (zStep - s.hinge[2])).toBeGreaterThan(0);

      // No inward motion at the start of deployment.
      const smallTheta = Math.PI / 90;
      const smallStep = new Vector3(s.pos[0], s.pos[1], s.pos[2])
        .applyEuler(new Euler(smallTheta, 0, 0, 'XYZ'))
        .applyEuler(mount);
      const zSmall = s.hinge[2] + smallStep.z;
      expect(outwardSign * (zSmall - s.hinge[2])).toBeGreaterThan(0);
    }

    // Opposite top/bottom panels should mirror deployment displacement.
    const topPosY = specs.find(s => s.id === 'SE_Top_PosY');
    const topNegY = specs.find(s => s.id === 'SE_Top_NegY');
    const botPosY = specs.find(s => s.id === 'SE_Bot_PosY');
    const botNegY = specs.find(s => s.id === 'SE_Bot_NegY');

    expect(topPosY).toBeDefined();
    expect(topNegY).toBeDefined();
    expect(botPosY).toBeDefined();
    expect(botNegY).toBeDefined();

    const zDeltaAt = (s: (typeof specs)[number], thetaRad: number) => {
      const mount = new Euler(s.rot[0], s.rot[1], s.rot[2], 'XYZ');
      const offset = new Vector3(s.pos[0], s.pos[1], s.pos[2])
        .applyEuler(new Euler(thetaRad, 0, 0, 'XYZ'))
        .applyEuler(mount);
      return offset.z;
    };

    const zTopPosY = zDeltaAt(topPosY!, theta);
    const zTopNegY = zDeltaAt(topNegY!, theta);
    const zBotPosY = zDeltaAt(botPosY!, theta);
    const zBotNegY = zDeltaAt(botNegY!, theta);

    expect(zTopPosY).toBeCloseTo(-zBotPosY, 6);
    expect(zTopNegY).toBeCloseTo(-zBotNegY, 6);
  });

  it('short-edge-long-edge composes unchanged long-edge chain + short-edge geometry', () => {
    const specs = getPanelSpecs('short-edge-long-edge', DEFAULT_PARAMS);
    expect(specs.length).toBe(8);

    const longEdgeCoupled = specs.slice(0, 4);
    const shortEdgeCoupled = specs.slice(4, 8);

    const longEdgeBase = getPanelSpecs('double-long-edge', DEFAULT_PARAMS);
    const shortEdgeBase = getPanelSpecs('short-edge', DEFAULT_PARAMS);

    expect(longEdgeCoupled.length).toBe(4);
    expect(shortEdgeCoupled.length).toBe(4);

    // Coupled panels 0..3 must preserve validated long-edge chain geometry and hierarchy.
    longEdgeCoupled.forEach((s, i) => {
      const b = longEdgeBase[i];
      expect(s.size).toEqual(b.size);
      expect(s.hinge).toEqual(b.hinge);
      expect(s.pos).toEqual(b.pos);
      expect(s.rot).toEqual(b.rot);
      expect(s.axis).toBe(b.axis);
      expect(s.parentIndex).toBe(b.parentIndex);
      expect(s.hingeOffset).toEqual(b.hingeOffset);
      expect(s.stage).toBe(b.stage);
      expect(s.maxAngle).toBeCloseTo(b.maxAngle ?? Math.PI / 2, 6);
    });

    // Coupled panels 4..7 must preserve short-edge geometry and stay independent.
    shortEdgeCoupled.forEach((s, i) => {
      const b = shortEdgeBase[i];
      expect(s.size).toEqual(b.size);
      expect(s.hinge).toEqual(b.hinge);
      expect(s.pos).toEqual(b.pos);
      expect(s.rot).toEqual(b.rot);
      expect(s.axis).toBe(b.axis);
      expect(s.parentIndex).toBeUndefined();
      expect(s.hingeOffset).toBeUndefined();
      expect(s.stage).toBe(3);
      expect(s.maxAngle).toBeCloseTo(Math.PI / 2, 6);
    });

    // Stage sequence metadata: 1,1,2,2,3,3,3,3
    const stages = specs.map(s => s.stage ?? 1);
    expect(stages).toEqual([1, 1, 2, 2, 3, 3, 3, 3]);
  });

  it('returns empty array for unknown config', () => {
    // @ts-ignore
    const specs = getPanelSpecs('invalid-config', DEFAULT_PARAMS);
    expect(specs).toEqual([]);
  });
});
