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

    // Flat stowed mounting on ±Z: top uses +90° about X, bottom uses -90° about X.
    topPanels.forEach(s => {
      expect(s.rot[0]).toBeCloseTo(Math.PI / 2, 6);
      expect(s.rot[1]).toBeCloseTo(0, 6);
      const zWrap = ((s.rot[2] % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const zIsZeroOrPi = Math.abs(zWrap - 0) < 1e-6 || Math.abs(zWrap - Math.PI) < 1e-6;
      expect(zIsZeroOrPi).toBe(true);
    });
    bottomPanels.forEach(s => {
      expect(s.rot[0]).toBeCloseTo(-Math.PI / 2, 6);
      expect(s.rot[1]).toBeCloseTo(0, 6);
      const zWrap = ((s.rot[2] % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const zIsZeroOrPi = Math.abs(zWrap - 0) < 1e-6 || Math.abs(zWrap - Math.PI) < 1e-6;
      expect(zIsZeroOrPi).toBe(true);
    });

    // Positive deployment angle must move every panel outward from its face.
    const theta = Math.PI / 6;
    const zDeltaAt = (s: (typeof specs)[number], thetaRad: number) => {
      const mount = new Euler(s.rot[0], s.rot[1], s.rot[2], 'XYZ');
      const offset = new Vector3(s.pos[0], s.pos[1], s.pos[2])
        .applyEuler(new Euler(thetaRad, 0, 0, 'XYZ'))
        .applyEuler(mount);
      return offset.z;
    };

    specs.forEach(s => {
      const zStep = zDeltaAt(s, theta);
      const outwardSign = Math.sign(s.hinge[2]);
      expect(outwardSign * zStep).toBeGreaterThan(0);
    });

    // Opposite top/bottom panels on the same Y side should mirror each other.
    const topPosY = specs.find(s => s.id === 'SE_Top_PosY');
    const topNegY = specs.find(s => s.id === 'SE_Top_NegY');
    const botPosY = specs.find(s => s.id === 'SE_Bot_PosY');
    const botNegY = specs.find(s => s.id === 'SE_Bot_NegY');

    expect(topPosY).toBeDefined();
    expect(topNegY).toBeDefined();
    expect(botPosY).toBeDefined();
    expect(botNegY).toBeDefined();

    expect(zDeltaAt(topPosY!, theta)).toBeCloseTo(-zDeltaAt(botPosY!, theta), 6);
    expect(zDeltaAt(topNegY!, theta)).toBeCloseTo(-zDeltaAt(botNegY!, theta), 6);
  });

  it('short-edge-long-edge returns 8 top-mounted panels', () => {
    const specs = getPanelSpecs('short-edge-long-edge', DEFAULT_PARAMS);
    expect(specs.length).toBe(8);

    // All hinges at Z = hz (top deck)
    specs.forEach(s => expect(s.hinge[2]).toBeCloseTo(hz, 6));

    // First 4 are LE with slightly reduced length (90%)
    const reducedLen = DEFAULT_PARAMS.panelLength * 0.9;
    const lePanels = specs.slice(0, 4);
    lePanels.forEach(s => expect(s.size[0]).toBeCloseTo(reducedLen, 6));

    // LE panels should use 'y' axis (on ±X edges)
    lePanels.forEach(s => expect(s.axis).toBe('y'));

    // SE panels are last 4
    const sePanels = specs.slice(4);
    expect(sePanels.length).toBe(4);
  });

  it('returns empty array for unknown config', () => {
    // @ts-ignore
    const specs = getPanelSpecs('invalid-config', DEFAULT_PARAMS);
    expect(specs).toEqual([]);
  });
});
