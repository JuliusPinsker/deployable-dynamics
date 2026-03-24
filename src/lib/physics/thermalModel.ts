// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import * as satellite from 'satellite.js';
import { ALPHA_E } from './constants';

const SAT_CONSTANTS = (satellite as unknown as { constants?: { earthRadius?: number } }).constants;
const EARTH_RADIUS_KM = SAT_CONSTANTS?.earthRadius ?? 6378.135;
//  Temperature-Dependent Torsional Spring Stiffness Model for LEO CubeSat
//
//  Models the thermal environment of a Low Earth Orbit satellite and its
//  effect on torsional spring stiffness (EN10270-1 spring steel).
//
//  Physical basis:
//    E(T) = E₀ · (1 - αE · (T - T_ref))
//    k_t(T) / k_t(T_ref) = E(T) / E₀ = stiffnessMultiplier
//    where E₀ = 206 GPa, αE = 3.0×10⁻⁴ K⁻¹, T_ref = 20 °C
//
//  References:
//    - Gilmore, D. G. (2002). *Spacecraft Thermal Control Handbook*,
//      2nd ed., AIAA. (Thermal stiffness model)
//    - Wertz, J. R. & Larson, W. J. (1999). *Space Mission Analysis and
//      Design*, 3rd ed., Microcosm Press. (Eclipse fraction formula)
//    - ESA ECSS-E-HB-32-20A (2011). *Structural Materials Handbook*.
//      (Material thermal properties for spring steel)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Time acceleration factor for thermal simulation.
 * Compresses a full LEO orbit (~5555s at 400km) into
 * the deployment window so eclipse transitions are
 * visible during a ~5-10 second simulation.
 * A factor of 600 means 1 real second = 10 orbit-minutes.
 * Scientific basis: this is a display accelerator only —
 * the underlying physics equations are unchanged.
 */
export const THERMAL_TIME_SCALE = 600;

// ─────────────────────────────────────────────────────────────────────────────
//  Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** Parameters controlling the thermal model. */
export interface ThermalParams {
  /** Orbit altitude in km (default 400). */
  orbitAltitudeKm: number;
  /** Solar beta angle in degrees (default 0). */
  betaAngleDeg: number;
  /** Spring reference temperature in °C (default 20). */
  referenceTemperatureDeg: number;
  /** Spring temperature in eclipse in °C (default -40). */
  eclipseTemperatureDeg: number;
  /** Spring temperature in sunlight in °C (default 85). */
  sunlightTemperatureDeg: number;
  /** First-order thermal lag time constant in seconds (default 300). */
  thermalTimeConstantS: number;
  /** Whether the thermal model is active (default true). */
  enabled: boolean;
}

/** Runtime thermal state evolved each timestep. */
export interface ThermalState {
  /** Current spring temperature in °C. */
  currentTemperatureDeg: number;
  /** True if the satellite is currently in Earth's shadow. */
  isEclipse: boolean;
  /** Current orbital phase in radians, 0 to 2π. */
  orbitPhaseRad: number;
  /**
   * Stiffness scaling factor k(T)/k₀ (dimensionless).
   * Clamped to [0.85, 1.15].
   */
  stiffnessMultiplier: number;
  /** Computed Keplerian orbital period in seconds. */
  orbitPeriodS: number;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Default parameters
// ─────────────────────────────────────────────────────────────────────────────

/** Default thermal model parameters for a 400 km LEO CubeSat. */
export const DEFAULT_THERMAL_PARAMS: ThermalParams = {
  orbitAltitudeKm: 400,
  betaAngleDeg: 0,
  referenceTemperatureDeg: 20,
  eclipseTemperatureDeg: -40,
  sunlightTemperatureDeg: 85,
  thermalTimeConstantS: 300,
  enabled: true,
};

// ─────────────────────────────────────────────────────────────────────────────
//  Orbital mechanics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the Keplerian orbital period for a circular orbit.
 *
 * $$T = 2\\pi \\sqrt{\\frac{(R_E + h)^3}{\\mu}}$$
 *
 * where $R_E = 6371$ km and $\\mu = 398600.4418$ km³/s².
 *
 * Reference: Wertz & Larson (1999), §5.2.
 *
 * @param altitudeKm  Orbit altitude above mean sea level (km)
 * @returns           Orbital period (seconds)
 */
export function computeOrbitPeriodS(altitudeKm: number): number {
  const a_km = EARTH_RADIUS_KM + altitudeKm;
  const mu_km3 = 398600.4418;
  return 2 * Math.PI * Math.sqrt(Math.pow(a_km, 3) / mu_km3);
}

/**
 * Compute the fraction of the orbit spent in Earth's shadow (eclipse).
 *
 * $$f_{ecl} = \\frac{1}{\\pi} \\arccos\\!\\left(
 *   \\frac{\\sqrt{h^2 + 2 R_E h}}{(R_E + h) \\cos\\beta}
 * \\right)$$
 *
 * where $h$ = altitude (km), $R_E = 6371$ km, $\\beta$ = solar beta angle.
 *
 * Physical limits:
 *   - If $|\\beta| > 66.5°$ the orbit is always sunlit (polar dawn/dusk
 *     sun-synchronous) → returns 0.
 *   - Result clamped to [0, 0.45].
 *
 * Reference: Wertz & Larson (1999), §5.3 — eclipse geometry.
 *
 * @param altitudeKm    Orbit altitude (km)
 * @param betaAngleDeg  Solar beta angle (degrees, ±90)
 * @returns             Eclipse fraction ∈ [0, 0.45]
 */
export function computeEclipseFraction(
  altitudeKm: number,
  betaAngleDeg: number,
): number {
  // No eclipse beyond ±66.5° beta
  if (Math.abs(betaAngleDeg) > 66.5) return 0;

  const h = altitudeKm;
  const cosBeta = Math.cos(betaAngleDeg * Math.PI / 180);

  // Geometric argument: sin(ρ) / cos(β) where ρ = half-angle of Earth disk
  const numerator = Math.sqrt(h * h + 2 * EARTH_RADIUS_KM * h);
  const denominator = (EARTH_RADIUS_KM + h) * cosBeta;

  const arg = numerator / denominator;

  // If argument ≥ 1: orbit is always sunlit at this beta angle
  if (arg >= 1) return 0;

  const fraction = (1 / Math.PI) * Math.acos(arg);

  // Clamp to physical limit
  return Math.min(Math.max(fraction, 0), 0.45);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Thermal state management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the stiffness multiplier from the current temperature.
 *
 * $$\\frac{k_t(T)}{k_t(T_{ref})} = 1 - \\alpha_E \\cdot (T - T_{ref})$$
 *
 * where $\\alpha_E = 3.0 \\times 10^{-4}$ K⁻¹ (spring steel EN10270-1).
 *
 * Clamped to [0.85, 1.15] to stay within the linear elastic regime.
 *
 * Reference: Gilmore (2002), Ch. 4 — material thermal properties.
 *
 * @param tempDeg  Current temperature (°C)
 * @param refDeg   Reference temperature (°C)
 * @returns        Dimensionless multiplier ∈ [0.85, 1.15]
 */
function computeStiffnessMultiplier(tempDeg: number, refDeg: number): number {
  const raw = 1.0 - ALPHA_E * (tempDeg - refDeg);
  return Math.min(Math.max(raw, 0.85), 1.15);
}

/**
 * Create an initial thermal state for the beginning of a simulation.
 *
 * Assumes deployment occurs at orbit dawn (sunlight side):
 *   - Temperature starts at the sunlight equilibrium value.
 *   - Orbit phase starts at 0 (beginning of sunlit arc).
 *
 * @param params  Thermal model parameters
 * @returns       Initial ThermalState
 */
export function initThermalState(params: ThermalParams): ThermalState {
  const orbitPeriodS = computeOrbitPeriodS(params.orbitAltitudeKm);
  const stiffnessMultiplier = computeStiffnessMultiplier(
    params.sunlightTemperatureDeg,
    params.referenceTemperatureDeg,
  );

  return {
    currentTemperatureDeg: params.sunlightTemperatureDeg,
    isEclipse: false,
    orbitPhaseRad: 0,
    stiffnessMultiplier,
    orbitPeriodS,
  };
}

/**
 * Advance the thermal state by one simulation timestep.
 *
 * Steps performed:
 *   1. Advance orbit phase: $\\phi_{n+1} = \\phi_n + \\frac{2\\pi}{T_{orb}} \\cdot \\Delta t$,
 *      wrapped to $[0, 2\\pi)$.
 *   2. Determine eclipse/sunlight from eclipse fraction:
 *      Eclipse when $\\phi > (1 - f_{ecl}) \\cdot 2\\pi$.
 *   3. First-order thermal lag:
 *      $\\frac{dT}{dt} = \\frac{T_{target} - T_{current}}{\\tau}$
 *      where $T_{target}$ is the eclipse or sunlight temperature and
 *      $\\tau$ is the thermal time constant.
 *   4. Stiffness multiplier from the updated temperature.
 *
 * Reference: Gilmore (2002), Ch. 2 — lumped-capacitance thermal model.
 *
 * @param state   Current thermal state
 * @param params  Thermal model parameters
 * @param dt      Integration timestep (seconds)
 * @returns       Updated ThermalState
 */
export function stepThermalState(
  state: ThermalState,
  params: ThermalParams,
  dt: number,
): ThermalState {
  // (a) Advance orbital phase and wrap to [0, 2π)
  const phaseRate = (2 * Math.PI) / state.orbitPeriodS;
  let newPhase = state.orbitPhaseRad + phaseRate * dt * THERMAL_TIME_SCALE;
  newPhase = newPhase % (2 * Math.PI);
  if (newPhase < 0) newPhase += 2 * Math.PI;

  // (b) Eclipse fraction for current orbit parameters
  const eclipseFraction = computeEclipseFraction(
    params.orbitAltitudeKm,
    params.betaAngleDeg,
  );

  // (c) Eclipse when phase exceeds (1 - eclipseFraction) · 2π
  const eclipseStartPhase = (1 - eclipseFraction) * 2 * Math.PI;
  const isEclipse = newPhase > eclipseStartPhase;

  // (d) First-order thermal lag toward target temperature
  const targetTemp = isEclipse
    ? params.eclipseTemperatureDeg
    : params.sunlightTemperatureDeg;

  const dTdt = (targetTemp - state.currentTemperatureDeg) / params.thermalTimeConstantS;
  const newTemp = state.currentTemperatureDeg + dTdt * dt * THERMAL_TIME_SCALE;

  // (e) Stiffness multiplier from updated temperature
  const stiffnessMultiplier = computeStiffnessMultiplier(
    newTemp,
    params.referenceTemperatureDeg,
  );

  return {
    currentTemperatureDeg: newTemp,
    isEclipse,
    orbitPhaseRad: newPhase,
    stiffnessMultiplier,
    orbitPeriodS: state.orbitPeriodS,
  };
}

/**
 * Apply the thermal stiffness scaling to a base spring constant.
 *
 * When the thermal model is enabled:
 *   $k_{eff} = k_0 \\cdot \\text{stiffnessMultiplier}$
 *
 * When disabled, returns the unmodified base spring constant.
 *
 * Reference: Gilmore (2002), Ch. 4 — temperature-dependent material properties.
 *
 * @param baseSpringConstant  Nominal spring constant at reference temperature (N·m/rad)
 * @param thermalState        Current thermal state
 * @param params              Thermal model parameters
 * @returns                   Effective spring constant (N·m/rad)
 */
export function applyThermalStiffness(
  baseSpringConstant: number,
  thermalState: ThermalState,
  params: ThermalParams,
): number {
  return params.enabled
    ? baseSpringConstant * thermalState.stiffnessMultiplier
    : baseSpringConstant;
}
