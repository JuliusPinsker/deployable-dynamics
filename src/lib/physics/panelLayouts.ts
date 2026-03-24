import type { ConfigType, SimulationParams } from './types';
import { MathUtils } from 'three';

// Panel spec in world coordinate system (meters)
// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL COORDINATE SYSTEM:
//   +X = right face
//   -X = left face
//   +Y = front face
//   -Y = back face
//   +Z = top face
//   -Z = bottom face
//   Origin = center of CubeSat body
// ══════════════════════════════════════════════════════════════════════════════
export type PanelSpec = {
  id: string;
  // box geometry size in meters: [outward length, thickness, span along hinge]
  size: [number, number, number];
  // hinge pivot position (meters, world frame) — for root panels only
  hinge: [number, number, number];
  // panel center offset from hinge (in local frame, before rot)
  pos: [number, number, number];
  // mounting rotation (Euler XYZ radians) - transforms local frame to body frame
  rot: [number, number, number];
  // hinge rotation axis in LOCAL frame (before rot transform)
  axis: 'x' | 'y' | 'z';
  // ── Hierarchical panel support ──
  // Index of parent panel (undefined = root panel attached to body)
  parentIndex?: number;
  // Hinge offset in parent's LOCAL frame (used when parentIndex is set)
  hingeOffset?: [number, number, number];
  // ── Sequential deployment support ──
  // Deployment stage (1..3). A stage N panel deploys only after all stages < N complete.
  stage?: 1 | 2 | 3;
  // Maximum deployment angle in radians (default: π/2 for 90°, but stage 2 can be π for 180°)
  maxAngle?: number;
};

// ──────────────────────────────────────────────────────────────────────────────
// CubeSat Dimensions (3U):
//   Width (X)  = 0.1 m
//   Depth (Y)  = 0.1 m  
//   Height (Z) = 0.3405 m
//
// Half-dimensions:
//   hx = 0.05 m (±X face positions)
//   hy = 0.05 m (±Y face positions)
//   hz = 0.17025 m (±Z face positions)
// ──────────────────────────────────────────────────────────────────────────────

function halfX(params: SimulationParams) { return params.bodyWidth / 2; }   // 0.05
function halfY(params: SimulationParams) { return params.bodyDepth / 2; }   // 0.05
function halfZ(params: SimulationParams) { return params.bodyHeight / 2; }  // 0.17025

export function getPanelSpecs(config: ConfigType, params: SimulationParams): PanelSpec[] {
  const T = params.panelThickness;       // thickness (≈0.0025m)
  const L = params.panelLength;          // outward deployment length
  const W = params.panelWidth;           // span (= body height for long-edge)

  const hx = halfX(params);  // 0.05
  const hy = halfY(params);  // 0.05
  const hz = halfZ(params);  // 0.17025

  // Short-edge panel dimensions
  const SE_LEN = 0.1;
  const SE_SPAN = 0.1;

  switch (config) {
    // ══════════════════════════════════════════════════════════════════════════
    // LONG-EDGE: 2 panels mounted on ±Y faces (front/back faces)
    // ══════════════════════════════════════════════════════════════════════════
    //
    // PANEL LOCAL COORDINATE SYSTEM (hinge edge at origin):
    //   Local X: span direction (panel width), from -W/2 to +W/2
    //   Local Y: thickness direction, from -T/2 to +T/2
    //   Local Z: outward direction, panel extends from -L to 0 (hinge edge at Z=0)
    //
    // STOWED STATE (θ = 0°):
    //   +Y panel: hinge at (0, +hy, 0), panel extends in -Z (downward from hinge)
    //             Panel lies in X-Z plane, normal = +Y
    //   -Y panel: hinge at (0, -hy, 0), panel extends in -Z (downward from hinge)
    //             Panel lies in X-Z plane, normal = -Y
    //
    // DEPLOYMENT (θ = 0° → 90°):
    //   Pure rotation about X-axis (hinge edge is pivot)
    //   +Y panel: rotates +90° about X → panel extends in +Y, normal becomes +Z
    //   -Y panel: rotates -90° about X (via flipped local axis) → extends in -Y, normal becomes +Z
    //
    // ROTATION MATH:
    //   +90° about X: -Z → +Y, +Y → +Z
    //   -90° about X: -Z → -Y, -Y → +Z
    // ══════════════════════════════════════════════════════════════════════════
    case 'long-edge': {
      // Panel dimensions: L = 0.1m (width along hinge), W = 0.3405m (deploy length)
      // Local frame: X = width (0.1m), Y = thickness, Z = deploy direction (0.3405m)
      return [
        {
          id: 'LE_PosY',
          // size: [width along X, thickness, deploy length along Z]
          size: [L, T, W],
          hinge: [0, hy, hz],              // hinge at top edge of +Y face
          pos: [0, 0, -W / 2],             // panel center offset so hinge edge at Z=0
          rot: [0, 0, 0],                  // no rotation: solar faces +Y, black faces -Y (toward body)
          axis: 'x',                       // rotation about +X axis
        },
        {
          id: 'LE_NegY',
          size: [L, T, W],
          hinge: [0, -hy, hz],             // hinge at top edge of -Y face
          pos: [0, 0, -W / 2],             // same offset
          rot: [0, 0, MathUtils.degToRad(180)], // flip X,Y: solar faces -Y, black faces +Y (toward body), aBody = -X
          axis: 'x',                       // +θ about local X = -θ about world X
        },
      ];
    }

    // ── Double long-edge: 4 panels (2 first-stage on ±Y + 2 second-stage) ──────
    // First-stage panels identical to long-edge config on ±Y faces
    case 'double-long-edge': {
      // First-stage: identical to long-edge (2 panel) config
      const firstStagePanels: PanelSpec[] = [
        {
          id: 'DLE_Stage1_PosY',
          // size: [width along X (0.1m), thickness, deploy length along Z (0.3405m)]
          size: [L, T, W],
          hinge: [0, hy, hz],              // hinge at top edge of +Y face
          pos: [0, 0, -W / 2],             // panel center offset so hinge edge at Z=0
          rot: [0, 0, 0],                  // no rotation: solar faces +Y, black faces -Y (toward body)
          axis: 'x',                       // rotation about +X axis
          stage: 1,                        // primary deployment stage
          maxAngle: MathUtils.degToRad(90), // 90° deployment
        },
        {
          id: 'DLE_Stage1_NegY',
          size: [L, T, W],
          hinge: [0, -hy, hz],             // hinge at top edge of -Y face
          pos: [0, 0, -W / 2],             // same offset
          rot: [0, 0, MathUtils.degToRad(180)], // flip X,Y: solar faces -Y, black faces +Y (toward body), aBody = -X
          axis: 'x',                       // +θ about local X = -θ about world X
          stage: 1,
          maxAngle: MathUtils.degToRad(90),
        },
      ];

      // Second-stage panels: children of first-stage panels (accordion fold)
      // Panel 3 is child of Panel 1 (+Y side), Panel 4 is child of Panel 2 (-Y side)
      //
      // STOWED STATE:
      //   Panels 3,4 lie perfectly flat on top of Panels 1,2.
      //   They are parallel to their parents with NO pre-rotation.
      //   Hinge at the outer (far) edge of the parent panel (Z = -W from parent hinge).
      //   Panel body folds BACK over parent: pos = [0, 0, +W/2] (extends in +Z from
      //   child hinge toward CubeSat, overlapping parent panel body at [0, 0, -W/2]).
      //
      // DEPLOYMENT SEQUENCE (strict two-stage, matching Fig. 5):
      //   Stage 1 (t ∈ [0, T]):  Panels 1,2 rotate 0→90° about X-axis.
      //                          Panels 3,4 remain rigidly attached (angle = 0).
      //   Stage 2 (t ∈ [T, 2T]): Panels 1,2 stay fixed at 90°.
      //                          Panels 3,4 rotate 0→180° about X-axis (longitudinal).
      //                          180° flips the fold: pos [0,0,+W/2] → [0,0,-W/2],
      //                          extending the panel further away from CubeSat.
      //
      // FINAL DEPLOYED GEOMETRY:
      //   After Stage 1, Panel 1 extends from CubeSat in +Y direction.
      //   After Stage 2, Panel 3 continues the strip further in +Y.
      //   Symmetrically, Panel 2 → -Y, Panel 4 → further -Y.
      //   Result: straight extended solar array strip along ±Y axis.
      //
      // HINGE AXIS:
      //   X-axis (parallel to parent hinge). No Y or Z rotation involved.
      //   Mirror symmetry is provided by Panel 2's mounting rotation [0,0,π].
      const secondStagePanels: PanelSpec[] = [
        {
          id: 'DLE_Stage2_PosY',
          // Same dimensions as parent
          size: [L, T, W],
          // World hinge position (initial reference, transformed by parent hierarchy)
          hinge: [0, hy, hz - W],
          // Panel folds back over parent: extends in +Z from child hinge
          // At stowed (0°), body center at [0, 0, W/2] from hinge → overlaps parent body
          pos: [0, 0, W / 2],
          // NO pre-rotation — panel is parallel to parent in stowed state
          rot: [0, 0, 0],
          // X-axis hinge — same axis as parent, for longitudinal unfolding
          axis: 'x',
          // ── Hierarchical: child of Panel 1 ──
          parentIndex: 0,
          // Hinge at outer (far) edge of parent panel
          hingeOffset: [0, 0, -W],
          // ── Sequential deployment ──
          stage: 2,                        // secondary deployment stage (waits for stage 1)
          maxAngle: MathUtils.degToRad(180), // 180° deployment
        },
        {
          id: 'DLE_Stage2_NegY',
          size: [L, T, W],
          hinge: [0, -hy, hz - W],
          // Same fold-back geometry as Panel 3
          pos: [0, 0, W / 2],
          // NO pre-rotation — mirror behavior inherited from parent's [0,0,π] flip
          rot: [0, 0, 0],
          // X-axis hinge — parallel to parent, longitudinal opening
          axis: 'x',
          // ── Hierarchical: child of Panel 2 ──
          parentIndex: 1,
          hingeOffset: [0, 0, -W],
          stage: 2,
          maxAngle: MathUtils.degToRad(180),
        },
      ];

      return [...firstStagePanels, ...secondStagePanels];
    }

    // ── Short-edge: 4 panels on ±Z faces (top and bottom) ────────────────────
    // Hinges lie on ±Y edges of top and bottom decks, all rotating about X.
    case 'short-edge': {
      return [
        {
          id: 'SE_Top_PosY',
          size: [SE_LEN, T, SE_SPAN],
          hinge: [0, hy, hz],              // top face, +Y edge
          pos: [0, 0, SE_SPAN / 2],        // stowed inward from +Y edge toward center
          rot: [MathUtils.degToRad(90), 0, MathUtils.degToRad(180)], // flat on +Z; Z-flip preserves outward deployment sense
          axis: 'x',
        },
        {
          id: 'SE_Top_NegY',
          size: [SE_LEN, T, SE_SPAN],
          hinge: [0, -hy, hz],             // top face, -Y edge
          pos: [0, 0, -SE_SPAN / 2],       // stowed inward from -Y edge toward center
          rot: [MathUtils.degToRad(90), 0, 0], // flat on +Z face (panel normal +Z)
          axis: 'x',
        },
        {
          id: 'SE_Bot_PosY',
          size: [SE_LEN, T, SE_SPAN],
          hinge: [0, hy, -hz],             // bottom face, +Y edge
          pos: [0, 0, -SE_SPAN / 2],       // stowed inward from +Y edge toward center
          rot: [MathUtils.degToRad(-90), 0, 0], // flat on -Z face (panel normal -Z)
          axis: 'x',
        },
        {
          id: 'SE_Bot_NegY',
          size: [SE_LEN, T, SE_SPAN],
          hinge: [0, -hy, -hz],            // bottom face, -Y edge
          pos: [0, 0, SE_SPAN / 2],        // stowed inward from -Y edge toward center
          rot: [MathUtils.degToRad(-90), 0, MathUtils.degToRad(180)], // flat on -Z; Z-flip preserves outward deployment sense
          axis: 'x',
        },
      ];
    }

    // ── Coupled: compose validated long-edge chain + short-edge subsystems ──
    case 'short-edge-long-edge': {
      // Panels 0..3: unchanged long-edge chain (including hierarchy, axes, and dimensions).
      const longEdgeChain = getPanelSpecs('double-long-edge', params).map((spec, idx) => ({
        ...spec,
        id: `CPL_LE_${idx + 1}`,
      }));

      // Panels 4..7: unchanged short-edge geometry as independent stage-3 panels.
      const shortEdgePanels = getPanelSpecs('short-edge', params).map((spec, idx) => ({
        ...spec,
        id: `CPL_SE_${idx + 1}`,
        stage: 3 as const,
        maxAngle: MathUtils.degToRad(90),
      }));

      return [...longEdgeChain, ...shortEdgePanels];
    }

    default:
      return [];
  }
}
