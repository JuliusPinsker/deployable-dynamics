// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Flexible Panel Dynamics — Craig-Bampton Modal Reduction
//
//  Real CFRP/Al honeycomb panels exhibit elastic bending during rapid angular
//  deceleration at the mechanical stop. This module implements a reduced-order
//  model using the first N bending modes (typically 2) per panel.
//
//  Theory: Euler-Bernoulli cantilever beam with modal decomposition
//    f_n = (λ_n² / 2πL²) √(EI / ρA)    — natural frequency
//    η̈_k + 2ζ_k ω_k η̇_k + ω_k² η_k = φ_k^T · F_tip(t)  — modal EOM
//
//  References:
//    - Thornton & Kim (1993), AIAA J. Guidance — flexible appendage dynamics
//    - Banerjee & Williams (1992), IJSS — exact dynamic stiffness method
//    - Craig & Bampton (1968) — component mode synthesis
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Parameters for flexible panel modal dynamics.
 * Default values tuned for 0.3405 m × 0.1 m × 2.5 mm CFRP/Al honeycomb panel.
 */
export interface FlexParams {
  /** Number of bending modes to simulate (default: 2). */
  numModes: number;
  /** Natural frequencies [f₁, f₂, ...] in Hz (default: [12, 75] for first two modes). */
  naturalFreqHz: number[];
  /** Modal damping ratios [ζ₁, ζ₂, ...] (default: [0.005, 0.005] for CFRP). */
  modalDamping: number[];
  /** Normalized modal masses (default: [1, 1]). */
  modalMassNorm: number[];
  /** Participation factors φ_k^T — coupling to inertial forcing. */
  participationFactor: number[];
}

/**
 * State of flexible panel vibration (per panel).
 */
export interface FlexState {
  /** Modal amplitudes η_k for each mode (m). */
  modalAmplitudes: number[];
  /** Modal velocities η̇_k for each mode (m/s). */
  modalVelocities: number[];
  /** Total tip deflection in metres (sum of modal contributions). */
  tipDeflectionM: number;
  /** Tip deflection as equivalent angle error in degrees. */
  tipDeflectionDeg: number;
}

/**
 * Default flex parameters for a 3U CubeSat panel.
 * Based on Euler-Bernoulli cantilever analysis:
 *   L = 0.3405 m, t = 2.5 mm, E = 70 GPa (Al), ρ = 2700 kg/m³
 *   f₁ ≈ 12 Hz, f₂ ≈ 75 Hz (first two bending modes)
 */
export const DEFAULT_FLEX_PARAMS: FlexParams = {
  numModes: 2,
  naturalFreqHz: [12, 75],      // Hz — first two cantilever modes
  modalDamping: [0.005, 0.005], // typical CFRP damping ratio
  modalMassNorm: [1, 1],        // normalized modal masses
  participationFactor: [1.566, 0.868], // φ_k analytical values for cantilever
};

/**
 * Initialize flex state with zero modal amplitudes and velocities.
 * @param params Flex parameters (unused but kept for API consistency)
 * @returns Initial FlexState with all zeros
 */
export function initFlexState(params: FlexParams): FlexState {
  const numModes = params.numModes;
  return {
    modalAmplitudes: Array(numModes).fill(0),
    modalVelocities: Array(numModes).fill(0),
    tipDeflectionM: 0,
    tipDeflectionDeg: 0,
  };
}

/**
 * Compute analytical participation factor for cantilever first mode.
 * φ₁ ≈ (2 / mL) × (L / 2) = 1 / m (simplified)
 * More accurate: φ_k = ∫₀ᴸ φ_k(x) dx / m_modal
 *
 * For first cantilever mode: φ₁(L) ≈ 2 (tip displacement per unit forcing)
 * Participation factor: φ = (2/mL) × (L/2) × m = 1 (normalized)
 *
 * @param panelLength Panel length in metres
 * @param panelMass Panel mass in kg
 * @returns Participation factors for first two modes
 */
export function computeParticipationFactors(
  panelLength: number,
  panelMass: number,
): number[] {
  // Cantilever mode shape integrals (analytical values)
  // Mode 1: ∫φ₁ dx / L ≈ 0.783 (first bending mode)
  // Mode 2: ∫φ₂ dx / L ≈ 0.434 (second bending mode)
  // Participation = (modal displacement at tip) × (moment arm) / (modal mass)
  //
  // Simplified formula: φ_k ≈ (2/mL) × (L/2) × modeFactor_k
  // where modeFactor accounts for mode shape curvature
  const modeFactor1 = 1.566; // First mode (dominant)
  const modeFactor2 = 0.868; // Second mode (higher frequency, less displacement)

  return [modeFactor1, modeFactor2];
}

/**
 * Step the flexible panel modal dynamics using semi-implicit Euler.
 *
 * Modal equation of motion:
 *   η̈_k + 2ζ_k ω_k η̇_k + ω_k² η_k = φ_k × F_inertial
 *
 * where F_inertial = m × L/2 × θ̈ is the inertial forcing at panel CG
 * due to deployment angular acceleration θ̈.
 *
 * Semi-implicit Euler (velocity-first):
 *   η̇_k^{n+1} = η̇_k^n + η̈_k^n × dt
 *   η_k^{n+1} = η_k^n + η̇_k^{n+1} × dt
 *
 * @param state Current flex state
 * @param params Flex parameters
 * @param angularAcceleration θ̈ of rigid deployment angle (rad/s²)
 * @param dt Integration timestep (s)
 * @param panelLength Panel length (m) — for converting deflection to angle
 * @param panelMass Panel mass (kg) — for inertial forcing
 * @returns Updated FlexState
 */
export function stepFlexState(
  state: FlexState,
  params: FlexParams,
  angularAcceleration: number,
  dt: number,
  panelLength: number = 0.3405,
  panelMass: number = 0.3,
): FlexState {
  const numModes = params.numModes;
  const newAmplitudes: number[] = [];
  const newVelocities: number[] = [];

  // Inertial forcing: F = m × (L/2) × θ̈
  // This is the equivalent tip force from angular deceleration
  const momentArm = panelLength / 2; // CG to tip distance
  const F_inertial = panelMass * momentArm * angularAcceleration;

  for (let k = 0; k < numModes; k++) {
    const eta = state.modalAmplitudes[k] ?? 0;
    const etaDot = state.modalVelocities[k] ?? 0;

    // Natural frequency in rad/s
    const omega_k = 2 * Math.PI * (params.naturalFreqHz[k] ?? 12);
    const zeta_k = params.modalDamping[k] ?? 0.005;
    const phi_k = params.participationFactor[k] ?? 1;
    const m_k = params.modalMassNorm[k] ?? 1;

    // Modal acceleration: η̈_k = (φ_k × F - 2ζω η̇ - ω² η) / m_modal
    const modalForce = phi_k * F_inertial / m_k;
    const dampingForce = 2 * zeta_k * omega_k * etaDot;
    const stiffnessForce = omega_k * omega_k * eta;

    const etaDDot = modalForce - dampingForce - stiffnessForce;

    // Semi-implicit Euler: velocity first, then position
    const etaDotNew = etaDot + etaDDot * dt;
    const etaNew = eta + etaDotNew * dt;

    newVelocities.push(etaDotNew);
    newAmplitudes.push(etaNew);
  }

  // Total tip deflection is sum of modal contributions
  // For cantilever, tip deflection ≈ η_k × φ_k(L) where φ_k(L) ≈ 1 (normalized)
  let tipDeflectionM = 0;
  for (let k = 0; k < numModes; k++) {
    // Mode shape at tip (normalized to 1 for tip deflection)
    const modeShapeAtTip = k === 0 ? 1.0 : 0.5; // First mode dominates tip motion
    tipDeflectionM += newAmplitudes[k] * modeShapeAtTip;
  }

  // Convert tip deflection to equivalent angle error
  // Small angle: θ_error ≈ deflection / panelLength
  const tipDeflectionRad = tipDeflectionM / panelLength;
  const tipDeflectionDeg = (tipDeflectionRad * 180) / Math.PI;

  return {
    modalAmplitudes: newAmplitudes,
    modalVelocities: newVelocities,
    tipDeflectionM,
    tipDeflectionDeg,
  };
}

/**
 * Compute the first natural frequency of a cantilever beam.
 * f₁ = (λ₁² / 2πL²) √(EI / ρA)
 *
 * For Al honeycomb: E ≈ 70 GPa, ρ ≈ 300 kg/m³ (effective)
 *
 * @param length Panel length (m)
 * @param width Panel width (m)
 * @param thickness Panel thickness (m)
 * @param density Effective density (kg/m³)
 * @param elasticModulus Young's modulus (Pa)
 * @returns First natural frequency in Hz
 */
export function computeFirstNaturalFreq(
  length: number,
  width: number,
  thickness: number,
  density: number = 300,      // kg/m³ — effective honeycomb density
  elasticModulus: number = 70e9, // Pa — Al elastic modulus
): number {
  // Second moment of area for rectangular cross-section
  const I = (width * thickness * thickness * thickness) / 12;

  // Cross-sectional area
  const A = width * thickness;

  // First mode eigenvalue for cantilever: λ₁ = 1.875
  const lambda1 = 1.875;

  // Natural frequency
  const f1 = (lambda1 * lambda1 / (2 * Math.PI * length * length)) *
    Math.sqrt((elasticModulus * I) / (density * A));

  return f1;
}
