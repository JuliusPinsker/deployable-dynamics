// ─────────────────────────────────────────────────────────────────────────────
//  Minimal explicit 3×3 linear algebra for the coupled hub–panel EOM solve.
//
//  The coupled rotational system matrix [D_total] = [I_sc,B] + Σ K_i ⊗ b_θ,i
//  is a genuine dense 3×3 (generally non-diagonal, and — because of the
//  rank-1 outer-product corrections — not necessarily symmetric), so the
//  engine's rotate-divide-rotate diagonal-inertia trick cannot solve it.
//
//  Deliberately NOT three.js's Matrix3: its `.set(n11, n12, …)` argument order
//  is row-major while its `.elements` storage is column-major, a silent-
//  transpose trap for hand-assembled matrices. This representation is
//  explicit row-major, nothing else.
// ─────────────────────────────────────────────────────────────────────────────

import { Vector3 } from 'three';

/**
 * Row-major 3×3 matrix. `rows[r]` is row r; element (r,c) is
 * `rows[r].getComponent(c)`.
 */
export interface Mat3 {
  rows: [Vector3, Vector3, Vector3];
}

export function mat3Zero(): Mat3 {
  return { rows: [new Vector3(), new Vector3(), new Vector3()] };
}

export function mat3Identity(): Mat3 {
  return {
    rows: [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
  };
}

/** Rows are cloned — callers keep ownership of their vectors. */
export function mat3FromRows(r0: Vector3, r1: Vector3, r2: Vector3): Mat3 {
  return { rows: [r0.clone(), r1.clone(), r2.clone()] };
}

export function mat3Clone(m: Mat3): Mat3 {
  return mat3FromRows(m.rows[0], m.rows[1], m.rows[2]);
}

/** dst += src, in place. */
export function mat3AddInPlace(dst: Mat3, src: Mat3): void {
  dst.rows[0].add(src.rows[0]);
  dst.rows[1].add(src.rows[1]);
  dst.rows[2].add(src.rows[2]);
}

/** dst += scale · src, in place. */
export function mat3AddScaledInPlace(dst: Mat3, src: Mat3, scale: number): void {
  dst.rows[0].addScaledVector(src.rows[0], scale);
  dst.rows[1].addScaledVector(src.rows[1], scale);
  dst.rows[2].addScaledVector(src.rows[2], scale);
}

/**
 * dst += col ⊗ row  (rank-1 update: element (r,c) += col[r]·row[c]).
 * Used for the per-panel K_i ⊗ b_θ,i corrections to [D_total] and the
 * −m·(r ⊗ r) part of parallel-axis shifts.
 */
export function mat3AddOuterInPlace(dst: Mat3, col: Vector3, row: Vector3): void {
  dst.rows[0].addScaledVector(row, col.x);
  dst.rows[1].addScaledVector(row, col.y);
  dst.rows[2].addScaledVector(row, col.z);
}

/** m · v (matrix–vector product). */
export function mat3MulVec(m: Mat3, v: Vector3): Vector3 {
  return new Vector3(m.rows[0].dot(v), m.rows[1].dot(v), m.rows[2].dot(v));
}

/** Frobenius norm √(Σ m_ij²) — the scale reference for the singularity guard. */
export function mat3FrobeniusNorm(m: Mat3): number {
  return Math.sqrt(
    m.rows[0].lengthSq() + m.rows[1].lengthSq() + m.rows[2].lengthSq(),
  );
}

/**
 * Relative pivot threshold for the singularity guard in solve3x3. A pivot
 * whose magnitude falls below `SOLVE3X3_PIVOT_EPS × ‖A‖_F` marks the system
 * as numerically singular. Relative (not absolute) so the guard works
 * unchanged across the engine's ~1e-4 kg·m² panel-inertia scale and unit-
 * scale test matrices alike.
 */
export const SOLVE3X3_PIVOT_EPS = 1e-10;

/**
 * Solve A·x = b for a 3×3 system via Gaussian elimination with partial
 * pivoting (a solve, not an explicit inverse). Inputs are not mutated.
 *
 * @throws Error when the largest available pivot at any elimination step is
 *   below SOLVE3X3_PIVOT_EPS × ‖A‖_F (singular or near-singular system).
 */
export function solve3x3(m: Mat3, b: Vector3): Vector3 {
  // Augmented working copy [A | b], plain number arrays.
  const a: number[][] = [
    [m.rows[0].x, m.rows[0].y, m.rows[0].z, b.x],
    [m.rows[1].x, m.rows[1].y, m.rows[1].z, b.y],
    [m.rows[2].x, m.rows[2].y, m.rows[2].z, b.z],
  ];

  const normA = mat3FrobeniusNorm(m);
  const pivotFloor = SOLVE3X3_PIVOT_EPS * normA;

  for (let col = 0; col < 3; col++) {
    // Partial pivoting: bring the largest-|entry| row in this column up.
    let pivotRow = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivotRow][col])) pivotRow = r;
    }
    if (Math.abs(a[pivotRow][col]) <= pivotFloor) {
      throw new Error(
        `solve3x3: singular or near-singular system ` +
        `(pivot |${a[pivotRow][col].toExponential(3)}| ≤ ${SOLVE3X3_PIVOT_EPS} · ‖A‖_F = ${pivotFloor.toExponential(3)})`,
      );
    }
    if (pivotRow !== col) {
      const tmp = a[col];
      a[col] = a[pivotRow];
      a[pivotRow] = tmp;
    }

    // Eliminate below the pivot.
    for (let r = col + 1; r < 3; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 4; c++) a[r][c] -= f * a[col][c];
    }
  }

  // Back-substitution.
  const x = new Vector3();
  const x2 = a[2][3] / a[2][2];
  const x1 = (a[1][3] - a[1][2] * x2) / a[1][1];
  const x0 = (a[0][3] - a[0][1] * x1 - a[0][2] * x2) / a[0][0];
  x.set(x0, x1, x2);

  if (!Number.isFinite(x.x) || !Number.isFinite(x.y) || !Number.isFinite(x.z)) {
    throw new Error('solve3x3: non-finite solution component');
  }
  return x;
}
