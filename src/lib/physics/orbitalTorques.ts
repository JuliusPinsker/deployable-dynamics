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

import type { Vector3, Quaternion, PanelState } from './types';
import type { PanelSpec } from './panelLayouts';
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { GM_EARTH, R_EARTH_M, P_SOLAR, C_LIGHT } from './constants';

const SAT_CONSTANTS = (satellite as unknown as { constants?: { earthRadius?: number } }).constants;

/** Solar irradiance at 1 AU (W/m²), nominal value per ISO 21348 */
export const SOLAR_CONSTANT_1AU = 1361;
export { GM_EARTH, R_EARTH_M as R_EARTH, P_SOLAR, C_LIGHT } from './constants';

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

function vec3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function vecFrom(v: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function quatFromLike(q: { w: number; x: number; y: number; z: number }): THREE.Quaternion {
  return new THREE.Quaternion(q.x, q.y, q.z, q.w);
}

function addVec(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): THREE.Vector3 {
  return vecFrom(a).add(vecFrom(b));
}

function scaleVec(v: { x: number; y: number; z: number }, s: number): THREE.Vector3 {
  return vecFrom(v).multiplyScalar(s);
}

function dotVec(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return vecFrom(a).dot(vecFrom(b));
}

function crossVec(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3().crossVectors(vecFrom(a), vecFrom(b));
}

function normalizeVec(v: { x: number; y: number; z: number }): THREE.Vector3 {
  const next = vecFrom(v);
  return next.lengthSq() < 1e-24 ? vec3(0, 0, 1) : next.normalize();
}

function magVec(v: { x: number; y: number; z: number }): number {
  return vecFrom(v).length();
}

function conjQuat(q: { w: number; x: number; y: number; z: number }): THREE.Quaternion {
  return quatFromLike(q).conjugate();
}

function rotateVec(q: { w: number; x: number; y: number; z: number }, v: { x: number; y: number; z: number }): THREE.Vector3 {
  return vecFrom(v).applyQuaternion(quatFromLike(q));
}

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
  // satellite.js uses km; mean motion returned in rad/s
  const a_km = (SAT_CONSTANTS?.earthRadius ?? 6378.135) + altitudeKm;
  const mu_km3 = 398600.4418; // km^3/s^2 (WGS-72 standard used by satellite.js)
  return Math.sqrt(mu_km3 / Math.pow(a_km, 3));
}

/**
 * Compute orbital period for circular orbit.
 *
 * @param altitudeKm Orbital altitude above Earth surface (km)
 * @returns Orbital period in seconds
 */
export function orbitalPeriod(altitudeKm: number): number {
  return (2 * Math.PI) / meanMotion(altitudeKm);
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
  const qBodyThree = quatFromLike(qBody);
  // Transform nadir to body frame: r̂_body = q* ⊗ r̂_world
  const nadirBody = vecFrom(nadirWorld).applyQuaternion(qBodyThree.clone().conjugate());
  const rx = nadirBody.x;
  const ry = nadirBody.y;
  const rz = nadirBody.z;

  // Gravity gradient factor: 3n² (since μ/R³ = n²)
  const factor = 3 * n * n;

  // Body-frame torque components
  const tauBodyX = factor * (Itotal_diag.z - Itotal_diag.y) * ry * rz;
  const tauBodyY = factor * (Itotal_diag.x - Itotal_diag.z) * rz * rx;
  const tauBodyZ = factor * (Itotal_diag.y - Itotal_diag.x) * rx * ry;
  const tauBody = vec3(tauBodyX, tauBodyY, tauBodyZ);

  // Rotate torque to world frame
  return tauBody.applyQuaternion(qBodyThree);
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
  const qBodyThree = quatFromLike(qBody);
  let totalTorque = vec3(0, 0, 0);

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
    const hingePos = vec3(spec.pos[0], spec.pos[1], spec.pos[2]);

    // Panel outward direction rotates with deployment angle
    // Start with mount rotation, then apply hinge rotation
    const cosA = Math.cos(deployAngle);
    const sinA = Math.sin(deployAngle);

    // Simplified panel normal (pointing outward from body)
    // This is an approximation — actual normal depends on panel geometry
    let panelNormalBody: THREE.Vector3;
    switch (spec.axis) {
      case 'x':
        panelNormalBody = vec3(cosA, sinA, 0);
        break;
      case 'y':
        panelNormalBody = vec3(sinA, cosA, 0);
        break;
      case 'z':
      default:
        panelNormalBody = vec3(sinA, 0, cosA);
        break;
    }

    // Transform to world frame
    const panelNormalWorld = panelNormalBody.clone().applyQuaternion(qBodyThree);

    // Illumination factor: cos(θ) between sun and panel normal
    const cosTheta = vecFrom(sunWorld).dot(panelNormalWorld);

    // Only illuminated side contributes (cosTheta > 0)
    if (cosTheta <= 0) continue;

    // SRP force magnitude
    const forceMag = P_SOLAR * panelArea * (1 + reflectivity) * cosTheta;

    // Force direction: along panel normal (specular reflection)
    const forceWorld = scaleVec(panelNormalWorld, -forceMag);

    // Panel center position in body frame
    const panelCenterBody = vec3(
      hingePos.x + (panelLength / 2) * panelNormalBody.x,
      hingePos.y + (panelLength / 2) * panelNormalBody.y,
      hingePos.z + (panelLength / 2) * panelNormalBody.z,
    );

    // Transform to world frame
    const panelCenterWorld = panelCenterBody.clone().applyQuaternion(qBodyThree);

    // Torque: τ = r × F
    const panelTorque = crossVec(panelCenterWorld, forceWorld);

    totalTorque = addVec(totalTorque, panelTorque);
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
  const orbitNormal = vec3(Math.sin(inclinationRad), 0, Math.cos(inclinationRad));

  // Rodrigues rotation formula: v' = v·cos(θ) + (k×v)·sin(θ) + k·(k·v)·(1-cos(θ))
  const cosT = Math.cos(dTheta);
  const sinT = Math.sin(dTheta);
  const kCrossV = crossVec(orbitNormal, nadirWorld);
  const kDotV = dotVec(orbitNormal, nadirWorld);

  const updated = vec3(
    nadirWorld.x * cosT + kCrossV.x * sinT + orbitNormal.x * kDotV * (1 - cosT),
    nadirWorld.y * cosT + kCrossV.y * sinT + orbitNormal.y * kDotV * (1 - cosT),
    nadirWorld.z * cosT + kCrossV.z * sinT + orbitNormal.z * kDotV * (1 - cosT),
  );

  // Re-normalize for numerical stability
  return normalizeVec(updated);
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
  const nadirBody: Vector3 = vec3(nadirBodyVec[0], nadirBodyVec[1], nadirBodyVec[2]);
  return normalizeVec(rotateVec(qBody, nadirBody));
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
  const sunBody: Vector3 = vec3(sunBodyVec[0], sunBodyVec[1], sunBodyVec[2]);
  return normalizeVec(rotateVec(qBody, sunBody));
}
