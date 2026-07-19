// Tests for the explicit 3×3 solve primitive backing the coupled hub–panel
// EOM (Phase B). Cross-checks use Cramer's rule — an independent method — so
// a bug in the Gaussian elimination cannot silently validate itself.

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  type Mat3,
  mat3FromRows,
  mat3Identity,
  mat3Zero,
  mat3AddInPlace,
  mat3AddOuterInPlace,
  mat3MulVec,
  mat3FrobeniusNorm,
  solve3x3,
} from '../lib/physics/linearAlgebra';

/** Independent check: solve by Cramer's rule (explicit determinants). */
function cramer(m: Mat3, b: Vector3): Vector3 {
  const [r0, r1, r2] = m.rows;
  const det3 = (
    a: number, bb: number, c: number,
    d: number, e: number, f: number,
    g: number, h: number, i: number,
  ) => a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);

  const D = det3(r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, r2.x, r2.y, r2.z);
  const Dx = det3(b.x, r0.y, r0.z, b.y, r1.y, r1.z, b.z, r2.y, r2.z);
  const Dy = det3(r0.x, b.x, r0.z, r1.x, b.y, r1.z, r2.x, b.z, r2.z);
  const Dz = det3(r0.x, r0.y, b.x, r1.x, r1.y, b.y, r2.x, r2.y, b.z);
  return new Vector3(Dx / D, Dy / D, Dz / D);
}

/** Deterministic LCG so the residual sweep is reproducible (no Math.random). */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('Mat3 helpers', () => {
  it('mat3MulVec on the identity returns the input vector', () => {
    const v = new Vector3(3.5, -2, 0.25);
    const out = mat3MulVec(mat3Identity(), v);
    expect(out.x).toBe(3.5);
    expect(out.y).toBe(-2);
    expect(out.z).toBe(0.25);
  });

  it('mat3AddOuterInPlace adds col⊗row elementwise', () => {
    const m = mat3Zero();
    mat3AddOuterInPlace(m, new Vector3(1, 2, 3), new Vector3(4, 5, 6));
    // (r,c) = col[r]·row[c]
    expect(m.rows[0].x).toBe(4);   // 1·4
    expect(m.rows[0].z).toBe(6);   // 1·6
    expect(m.rows[1].y).toBe(10);  // 2·5
    expect(m.rows[2].x).toBe(12);  // 3·4
    expect(m.rows[2].z).toBe(18);  // 3·6
  });

  it('mat3AddInPlace sums two matrices', () => {
    const m = mat3Identity();
    mat3AddInPlace(m, mat3Identity());
    expect(m.rows[0].x).toBe(2);
    expect(m.rows[1].y).toBe(2);
    expect(m.rows[0].y).toBe(0);
  });

  it('mat3FrobeniusNorm of the identity is √3', () => {
    expect(mat3FrobeniusNorm(mat3Identity())).toBeCloseTo(Math.sqrt(3), 12);
  });
});

describe('solve3x3', () => {
  it('identity system returns b exactly', () => {
    const b = new Vector3(0.1, -7, 42);
    const x = solve3x3(mat3Identity(), b);
    expect(x.x).toBe(0.1);
    expect(x.y).toBe(-7);
    expect(x.z).toBe(42);
  });

  it('known non-diagonal integer system matches its hand-verified solution', () => {
    // A = [[2,1,0],[1,3,1],[0,1,2]], x = (1,2,3) → b = A·x = (4, 10, 8)
    const m = mat3FromRows(
      new Vector3(2, 1, 0),
      new Vector3(1, 3, 1),
      new Vector3(0, 1, 2),
    );
    const b = new Vector3(4, 10, 8);
    const x = solve3x3(m, b);
    expect(x.x).toBeCloseTo(1, 12);
    expect(x.y).toBeCloseTo(2, 12);
    expect(x.z).toBeCloseTo(3, 12);
  });

  it('symmetric positive-definite case (I_sc,B-like) matches Cramer’s rule', () => {
    // Symmetric, diagonally dominant — same character as a physical inertia
    // tensor at the engine's ~1e-2..1e-4 kg·m² scale.
    const m = mat3FromRows(
      new Vector3(4.1e-2, 3.0e-4, -1.2e-4),
      new Vector3(3.0e-4, 3.9e-2, 2.5e-4),
      new Vector3(-1.2e-4, 2.5e-4, 7.5e-3),
    );
    const b = new Vector3(1.3e-4, -8.0e-5, 2.0e-6);
    const x = solve3x3(m, b);
    const ref = cramer(m, b);
    expect(x.x).toBeCloseTo(ref.x, 10);
    expect(x.y).toBeCloseTo(ref.y, 10);
    expect(x.z).toBeCloseTo(ref.z, 10);
  });

  it('non-symmetric case (rank-1-corrected D_total-like) matches Cramer’s rule', () => {
    const m = mat3FromRows(
      new Vector3(3.2, -0.7, 0.15),
      new Vector3(0.4, 2.8, -1.1),
      new Vector3(-0.9, 0.05, 1.9),
    );
    const b = new Vector3(-2, 0.5, 3.25);
    const x = solve3x3(m, b);
    const ref = cramer(m, b);
    expect(x.x).toBeCloseTo(ref.x, 10);
    expect(x.y).toBeCloseTo(ref.y, 10);
    expect(x.z).toBeCloseTo(ref.z, 10);
  });

  it('requires pivoting when the leading diagonal entry is zero', () => {
    // a11 = 0 forces a row swap; solvable overall (det ≠ 0).
    const m = mat3FromRows(
      new Vector3(0, 2, 1),
      new Vector3(1, 0, 3),
      new Vector3(2, 1, 0),
    );
    const b = new Vector3(5, 10, 4);
    const x = solve3x3(m, b);
    const ref = cramer(m, b);
    expect(x.x).toBeCloseTo(ref.x, 10);
    expect(x.y).toBeCloseTo(ref.y, 10);
    expect(x.z).toBeCloseTo(ref.z, 10);
  });

  it('throws the specific singularity error for two identical rows', () => {
    const m = mat3FromRows(
      new Vector3(1, 2, 3),
      new Vector3(1, 2, 3),
      new Vector3(0, 1, 4),
    );
    expect(() => solve3x3(m, new Vector3(1, 1, 1))).toThrowError(
      /solve3x3: singular or near-singular system/,
    );
  });

  it('throws for a near-singular system (condition ~1e12) instead of returning garbage', () => {
    // Third row ≈ linear combination of the first two, perturbed at 1e-12
    // relative — far below the pivot floor.
    const r0 = new Vector3(1, 2, 3);
    const r1 = new Vector3(4, 5, 6);
    const r2 = r0.clone().multiplyScalar(2).add(r1).add(new Vector3(1e-12, -1e-12, 1e-12));
    const m = mat3FromRows(r0, r1, r2);
    expect(() => solve3x3(m, new Vector3(1, 0, 0))).toThrowError(
      /singular or near-singular/,
    );
  });

  it('residual check: A·x ≈ b for seeded well-conditioned systems', () => {
    const rand = makeLcg(0xC0FFEE);
    for (let trial = 0; trial < 20; trial++) {
      // Diagonally dominant by construction → well-conditioned.
      const rows = [0, 1, 2].map(r => {
        const v = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5);
        v.setComponent(r, v.getComponent(r) + 3);
        return v;
      });
      const m = mat3FromRows(rows[0], rows[1], rows[2]);
      const b = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(10);
      const x = solve3x3(m, b);
      expect(Number.isFinite(x.x) && Number.isFinite(x.y) && Number.isFinite(x.z)).toBe(true);
      const residual = mat3MulVec(m, x).sub(b).length();
      expect(residual).toBeLessThan(1e-12 * Math.max(1, b.length()));
    }
  });

  it('does not mutate its inputs', () => {
    const m = mat3FromRows(
      new Vector3(2, 1, 0),
      new Vector3(1, 3, 1),
      new Vector3(0, 1, 2),
    );
    const b = new Vector3(4, 10, 8);
    solve3x3(m, b);
    expect(m.rows[0].x).toBe(2);
    expect(m.rows[1].y).toBe(3);
    expect(b.x).toBe(4);
  });
});
