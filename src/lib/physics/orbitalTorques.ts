// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Orbital Environment Torques for LEO CubeSat Deployment
//
//  Models gravity gradient and solar radiation pressure torques that act
//  on a spacecraft during solar panel deployment in low Earth orbit.
//
//  Gravity Gradient: τ_gg = (3n²/2) r̂ × (I · r̂)
//    - Dominant disturbance for LEO CubeSats (~10⁻⁶ N·m)
//    - Depends on inertia asymmetry and nadir pointing error
//
//  Solar Radiation Pressure: τ_srp = P_sr · A · (1+ρ) · (r_cp - r_cm) × n̂_sun
//    - Smaller (~10⁻⁷ N·m) but relevant for long deployments
//    - Depends on panel area and center of pressure offset
//
//  References:
//    - Wertz (1978), Spacecraft Attitude Determination and Control, §7.2
//    - Sidi (1997), Spacecraft Dynamics and Control, Ch. 6
//    - Hughes (1986), Spacecraft Attitude Dynamics, §3.3
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { Vector3, Quaternion } from './types';
import type { PanelState } from './types';
import type { PanelSpec } from './panelLayouts';
import { C_LIGHT, GM_EARTH, P_SOLAR_1AU, R_EARTH } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
//  Physical Constants (WGS-84 / SI)
// ─────────────────────────────────────────────────────────────────────────────

/** Earth gravitational parameter μ = GM (m³/s²) */
export { GM_EARTH } from './constants';

/** Earth mean radius (m) — WGS-84 */
export { R_EARTH } from './constants';

/** Solar radiation pressure at 1 AU (N/m²) */
export { P_SOLAR_1AU as P_SOLAR } from './constants';

/** Speed of light (m/s) */
export { C_LIGHT } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
//  Orbital Parameters Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parameters defining the orbital environment for torque calculations.
 */
export interface OrbitalParams {
  /** Orbital altitude above Earth surface (km). Default: 400 (ISS-like). */
  altitudeKm: number;

  /** Orbital inclination (degrees). Default: 51.6 (ISS). */
  inclinationDeg: number;

  /** Nadir unit vector in body frame at t=0 [x, y, z]. Default: [0, 0, -1] (Z-down). */
  nadirBodyVec: [number, number, number];

  /** Sun unit vector in body frame (optional). Default: [1, 0, 0] (sun on +X). */
  sunBodyVec?: [number, number, number];

  /** Include solar radiation pressure torque. Default: false. */
  enableSRP: boolean;

  /** Panel reflectivity coefficient (0-1). Default: 0.2 for solar cells. */
  reflectivity?: number;
}

/**
 * Default orbital parameters for ISS-like 400 km LEO orbit.
 */
export const DEFAULT_ORBITAL_PARAMS: OrbitalParams = {
  altitudeKm: 400,
  inclinationDeg: 51.6,
  nadirBodyVec: [0, 0, -1],
  sunBodyVec: [1, 0, 0],
  enableSRP: false,
  reflectivity: 0.2,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Orbital Mechanics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute mean orbital motion n = √(GM/R³) for circular orbit.
 *
 * @param altitudeKm Orbital altitude above Earth surface (km)
 * @returns Mean motion in rad/s
 */
export function meanMotion(altitudeKm: number): number {
  const R = R_EARTH + altitudeKm * 1000; // Convert km to m
  return Math.sqrt(GM_EARTH / (R * R * R));
}

/**
 * Compute orbital period for circular orbit.
 *
 * @param altitudeKm Orbital altitude above Earth surface (km)
 * @returns Orbital period in seconds
 */
export function orbitalPeriod(altitudeKm: number): number {
  const n = meanMotion(altitudeKm);
  return (2 * Math.PI) / n;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Gravity Gradient Torque
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute gravity gradient torque acting on spacecraft.
 *
 * The gravity gradient torque arises from the variation of Earth's gravitational
 * field across the spacecraft. For a rigid body in circular orbit:
 *
 *   τ_gg = (3μ/R³) r̂_body × (I · r̂_body)
 *        = 3n² r̂_body × (I · r̂_body)
 *
 * In body-frame principal axes (diagonal I):
 *   τ_x = 3n² (I_zz - I_yy) r̂_y r̂_z
 *   τ_y = 3n² (I_xx - I_zz) r̂_z r̂_x
 *   τ_z = 3n² (I_yy - I_xx) r̂_x r̂_y
 *
 * The torque is zero when:
 *   - Spacecraft is symmetric (I_xx = I_yy = I_zz)
 *   - Nadir vector is aligned with a principal axis
 *
 * Reference: Hughes (1986), Spacecraft Attitude Dynamics, Eq. 3.3.10
 *
 * @param qBody Body orientation quaternion (world frame)
 * @param Itotal_diag Total system inertia tensor (diagonal, body frame, kg·m²)
 * @param nadirWorld Nadir unit vector in world frame (points toward Earth)
 * @param n Mean orbital motion (rad/s)
 * @returns Gravity gradient torque in WORLD frame (N·m)
 */
export function gravityGradientTorque(
  qBody: Quaternion,
  Itotal_diag: Vector3,
  nadirWorld: Vector3,
  n: number,
): Vector3 {
  const qBodySafe = new Quaternion(qBody.x, qBody.y, qBody.z, qBody.w);

  // Transform nadir to body frame: r̂_body = q* ⊗ r̂_world
  const nadirBody = new Vector3(nadirWorld.x, nadirWorld.y, nadirWorld.z)
    .applyQuaternion(qBodySafe.clone().conjugate());
  const rx = nadirBody.x;
  const ry = nadirBody.y;
  const rz = nadirBody.z;

  // Gravity gradient factor: 3n² (since μ/R³ = n²)
  const factor = 3 * n * n;

  // Body-frame torque components
  const tauBodyX = factor * (Itotal_diag.z - Itotal_diag.y) * ry * rz;
  const tauBodyY = factor * (Itotal_diag.x - Itotal_diag.z) * rz * rx;
  const tauBodyZ = factor * (Itotal_diag.y - Itotal_diag.x) * rx * ry;
  const tauBody = new Vector3(tauBodyX, tauBodyY, tauBodyZ);

  // Rotate torque to world frame
  return tauBody.applyQuaternion(qBodySafe.clone());
}

/**
 * Compute analytical gravity gradient torque magnitude for validation.
 * Maximum torque occurs at 45° from principal axis.
 *
 * τ_max = (3n²/2) |I_max - I_min|
 *
 * @param Itotal_diag Total inertia tensor (diagonal)
 * @param n Mean motion (rad/s)
 * @returns Maximum possible gravity gradient torque magnitude (N·m)
 */
export function maxGravityGradientTorque(
  Itotal_diag: Vector3,
  n: number,
): number {
  const diffs = [
    Math.abs(Itotal_diag.z - Itotal_diag.y),
    Math.abs(Itotal_diag.x - Itotal_diag.z),
    Math.abs(Itotal_diag.y - Itotal_diag.x),
  ];
  const maxDiff = Math.max(...diffs);
  // Maximum at 45° where sin(2θ) = 1 → ry·rz = 0.5
  return (3 / 2) * n * n * maxDiff;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Solar Radiation Pressure Torque
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute solar radiation pressure (SRP) torque on deployed panels.
 *
 * SRP force on a flat plate:
 *   F_srp = P_sr · A · (1 + ρ) · cos(θ) · n̂
 *
 * where:
 *   P_sr = 4.56×10⁻⁶ N/m² (solar constant at 1 AU)
 *   A = panel area (m²)
 *   ρ = reflectivity (0-1)
 *   θ = angle between sun vector and panel normal
 *   n̂ = panel normal vector
 *
 * Torque arises from offset between center of pressure and center of mass:
 *   τ_srp = r_cp × F_srp
 *
 * For a flat panel, center of pressure ≈ geometric center.
 *
 * Reference: Wertz (1978), §7.2.3
 *
 * @param qBody Body orientation quaternion
 * @param panelSpecs Panel specification array
 * @param panelStates Current panel states (angles)
 * @param sunWorld Sun unit vector in world frame
 * @param reflectivity Panel reflectivity (default 0.2)
 * @returns SRP torque in WORLD frame (N·m)
 */
export function srpTorque(
  qBody: Quaternion,
  panelSpecs: PanelSpec[],
  panelStates: PanelState[],
  sunWorld: Vector3,
  reflectivity: number = 0.2,
): Vector3 {
  const totalTorque = new Vector3(0, 0, 0);
  const qBodySafe = new Quaternion(qBody.x, qBody.y, qBody.z, qBody.w);
  const sunWorldSafe = new Vector3(sunWorld.x, sunWorld.y, sunWorld.z);

  for (let i = 0; i < panelSpecs.length; i++) {
    const spec = panelSpecs[i];
    const state = panelStates[i];

    if (state.stuck && state.angle < 0.01) {
      // Stowed panel — negligible SRP contribution
      continue;
    }

    // Panel dimensions (L × W × t stored as size[0], size[1], size[2])
    const panelLength = spec.size[0];
    const panelWidth = spec.size[2];
    const panelArea = panelLength * panelWidth;

    // Panel normal in body frame (perpendicular to panel surface)
    // For a deployed panel, normal rotates with hinge angle
    // Simplified: assume panel normal is approximately radial from hinge
    const deployAngle = state.angle;

    // Panel center of pressure in body frame (at panel centroid)
    // Approximate: r_cp ≈ hinge position + (L/2) × panel outward direction
    const hingePos = new Vector3(spec.pos[0], spec.pos[1], spec.pos[2]);

    // Panel outward direction rotates with deployment angle
    // Start with mount rotation, then apply hinge rotation
    const mountRot = spec.rot;
    const cosA = Math.cos(deployAngle);
    const sinA = Math.sin(deployAngle);

    // Simplified panel normal (pointing outward from body)
    // This is an approximation — actual normal depends on panel geometry
    let panelNormalBody: Vector3;
    switch (spec.axis) {
      case 'x':
        panelNormalBody = new Vector3(cosA, sinA, 0);
        break;
      case 'y':
        panelNormalBody = new Vector3(sinA, cosA, 0);
        break;
      case 'z':
      default:
        panelNormalBody = new Vector3(sinA, 0, cosA);
        break;
    }

    // Transform to world frame
    const panelNormalWorld = panelNormalBody.clone().applyQuaternion(qBodySafe.clone());

    // Illumination factor: cos(θ) between sun and panel normal
    const cosTheta = sunWorldSafe.dot(panelNormalWorld);

    // Only illuminated side contributes (cosTheta > 0)
    if (cosTheta <= 0) continue;

    // SRP force magnitude
    const forceMag = P_SOLAR_1AU * panelArea * (1 + reflectivity) * cosTheta;

    // Force direction: along panel normal (specular reflection)
    const forceWorld = panelNormalWorld.clone().multiplyScalar(-forceMag);

    // Panel center position in body frame
    const panelCenterBody = new Vector3(
      hingePos.x + (panelLength / 2) * panelNormalBody.x,
      hingePos.y + (panelLength / 2) * panelNormalBody.y,
      hingePos.z + (panelLength / 2) * panelNormalBody.z,
    );

    // Transform to world frame
    const panelCenterWorld = panelCenterBody.clone().applyQuaternion(qBodySafe.clone());

    // Torque: τ = r × F
    const panelTorque = new Vector3().crossVectors(panelCenterWorld, forceWorld);

    totalTorque.add(panelTorque);
  }

  return totalTorque;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Nadir Vector Update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update nadir vector as spacecraft orbits.
 *
 * In a circular orbit, the nadir vector (pointing from spacecraft to Earth center)
 * rotates at the mean motion rate n in the orbital plane.
 *
 * For numerical stability, the updated vector is re-normalized each step.
 *
 * @param nadirWorld Current nadir vector in world frame
 * @param n Mean orbital motion (rad/s)
 * @param dt Timestep (s)
 * @param inclinationRad Orbital inclination (radians)
 * @returns Updated nadir vector (normalized)
 */
export function updateNadirVector(
  nadirWorld: Vector3,
  n: number,
  dt: number,
  inclinationRad: number = 0,
): Vector3 {
  // Rotation angle during timestep
  const dTheta = n * dt;

  // Orbit normal vector (perpendicular to orbital plane)
  // For inclined orbit: orbit normal in inertial frame
  // Simplified: assume orbit normal is [sin(i), 0, cos(i)] in world frame
  const orbitNormal = new Vector3(Math.sin(inclinationRad), 0, Math.cos(inclinationRad));

  const updated = new Vector3(nadirWorld.x, nadirWorld.y, nadirWorld.z);
  updated.applyQuaternion(
    new Quaternion().setFromAxisAngle(orbitNormal.clone().normalize(), dTheta),
  );
  updated.normalize();

  return updated;
}

/**
 * Initialize nadir vector in world frame from body-frame specification.
 *
 * @param nadirBodyVec Nadir vector in body frame at t=0
 * @param qBody Initial body quaternion
 * @returns Nadir vector in world frame
 */
export function initNadirWorld(
  nadirBodyVec: [number, number, number],
  qBody: Quaternion,
): Vector3 {
  const nadirBody = new Vector3(nadirBodyVec[0], nadirBodyVec[1], nadirBodyVec[2]);
  const qBodySafe = new Quaternion(qBody.x, qBody.y, qBody.z, qBody.w);
  return nadirBody.applyQuaternion(qBodySafe).normalize();
}

/**
 * Initialize sun vector in world frame from body-frame specification.
 *
 * @param sunBodyVec Sun vector in body frame
 * @param qBody Body quaternion
 * @returns Sun vector in world frame
 */
export function initSunWorld(
  sunBodyVec: [number, number, number],
  qBody: Quaternion,
): Vector3 {
  const sunBody = new Vector3(sunBodyVec[0], sunBodyVec[1], sunBodyVec[2]);
  const qBodySafe = new Quaternion(qBody.x, qBody.y, qBody.z, qBody.w);
  return sunBody.applyQuaternion(qBodySafe).normalize();
}
