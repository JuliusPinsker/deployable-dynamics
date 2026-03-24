import { describe, it, expect } from 'vitest';
import {
  computeOrbitPeriodS,
  computeEclipseFraction,
  initThermalState,
  stepThermalState,
  applyThermalStiffness,
  DEFAULT_THERMAL_PARAMS,
  THERMAL_TIME_SCALE,
} from '../lib/physics/thermalModel';
import * as satellite from 'satellite.js';
import type { ThermalParams, ThermalState } from '../lib/physics/thermalModel';

// ─────────────────────────────────────────────────────────────────────────────
//  Physical constants for validation
// ─────────────────────────────────────────────────────────────────────────────
const SAT_CONSTANTS = (satellite as unknown as { constants?: { earthRadius?: number } }).constants;
const R_E = SAT_CONSTANTS?.earthRadius ?? 6378.135; // km
const MU = 398600.4418; // km^3/s^2

describe('computeOrbitPeriodS', () => {
  it('returns ~92.5 minutes for ISS-altitude (400 km)', () => {
    const T = computeOrbitPeriodS(400);
    // Analytical: 2π √((6771)³/398600.4418) ≈ 5554.6 s ≈ 92.6 min
    expect(T).toBeGreaterThan(5530);
    expect(T).toBeLessThan(5580);
    // More precise: ~5554.6 s
    const expected = 2 * Math.PI * Math.sqrt(Math.pow(R_E + 400, 3) / MU);
    expect(T).toBeCloseTo(expected, 2);
  });

  it('returns ~84.3 minutes for very low orbit (160 km)', () => {
    const T = computeOrbitPeriodS(160);
    const expected = 2 * Math.PI * Math.sqrt(Math.pow(R_E + 160, 3) / MU);
    expect(T).toBeCloseTo(expected, 2);
  });

  it('returns ~127 minutes for 2000 km altitude', () => {
    const T = computeOrbitPeriodS(2000);
    const expected = 2 * Math.PI * Math.sqrt(Math.pow(R_E + 2000, 3) / MU);
    expect(T).toBeCloseTo(expected, 2);
  });

  it('increases with altitude (Kepler 3rd law)', () => {
    const T200 = computeOrbitPeriodS(200);
    const T400 = computeOrbitPeriodS(400);
    const T800 = computeOrbitPeriodS(800);
    expect(T400).toBeGreaterThan(T200);
    expect(T800).toBeGreaterThan(T400);
  });
});

describe('computeEclipseFraction', () => {
  it('returns ~0.37 for 400 km, beta=0° (equatorial)', () => {
    const f = computeEclipseFraction(400, 0);
    // Eclipse fraction at 400 km, β=0 is about 0.36–0.38
    expect(f).toBeGreaterThan(0.33);
    expect(f).toBeLessThan(0.40);
  });

  it('decreases as beta angle increases', () => {
    const f0 = computeEclipseFraction(400, 0);
    const f30 = computeEclipseFraction(400, 30);
    const f60 = computeEclipseFraction(400, 60);
    expect(f30).toBeLessThanOrEqual(f0);
    expect(f60).toBeLessThanOrEqual(f30);
  });

  it('returns 0 for beta angle > 66.5° (no eclipse)', () => {
    expect(computeEclipseFraction(400, 67)).toBe(0);
    expect(computeEclipseFraction(400, 90)).toBe(0);
    expect(computeEclipseFraction(400, -70)).toBe(0);
  });

  it('handles negative beta angles symmetrically', () => {
    const fPos = computeEclipseFraction(400, 30);
    const fNeg = computeEclipseFraction(400, -30);
    expect(fPos).toBeCloseTo(fNeg, 6);
  });

  it('is clamped to maximum 0.45', () => {
    // Even extreme inputs should not exceed 0.45
    const f = computeEclipseFraction(100, 0);
    expect(f).toBeLessThanOrEqual(0.45);
  });

  it('decreases with higher altitude (narrower shadow cone)', () => {
    const f200 = computeEclipseFraction(200, 0);
    const f800 = computeEclipseFraction(800, 0);
    expect(f800).toBeLessThan(f200);
  });
});

describe('DEFAULT_THERMAL_PARAMS', () => {
  it('has correct default values', () => {
    expect(DEFAULT_THERMAL_PARAMS.orbitAltitudeKm).toBe(400);
    expect(DEFAULT_THERMAL_PARAMS.betaAngleDeg).toBe(0);
    expect(DEFAULT_THERMAL_PARAMS.referenceTemperatureDeg).toBe(20);
    expect(DEFAULT_THERMAL_PARAMS.eclipseTemperatureDeg).toBe(-40);
    expect(DEFAULT_THERMAL_PARAMS.sunlightTemperatureDeg).toBe(85);
    expect(DEFAULT_THERMAL_PARAMS.thermalTimeConstantS).toBe(300);
    expect(DEFAULT_THERMAL_PARAMS.enabled).toBe(true);
  });
});

describe('initThermalState', () => {
  it('initializes at sunlight temperature', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    expect(state.currentTemperatureDeg).toBe(DEFAULT_THERMAL_PARAMS.sunlightTemperatureDeg);
  });

  it('starts in sunlight (not eclipse)', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    expect(state.isEclipse).toBe(false);
  });

  it('starts at orbit phase 0', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    expect(state.orbitPhaseRad).toBe(0);
  });

  it('computes correct orbit period', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    const expected = computeOrbitPeriodS(400);
    expect(state.orbitPeriodS).toBeCloseTo(expected, 2);
  });

  it('computes stiffness multiplier from sunlight temperature', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    // multiplier = 1 - 3e-4 * (85 - 20) = 1 - 0.0195 = 0.9805
    const expected = 1.0 - 3.0e-4 * (85 - 20);
    expect(state.stiffnessMultiplier).toBeCloseTo(expected, 6);
  });

  it('uses the provided params, not just defaults', () => {
    const custom: ThermalParams = {
      ...DEFAULT_THERMAL_PARAMS,
      orbitAltitudeKm: 800,
      sunlightTemperatureDeg: 60,
    };
    const state = initThermalState(custom);
    expect(state.currentTemperatureDeg).toBe(60);
    expect(state.orbitPeriodS).toBeCloseTo(computeOrbitPeriodS(800), 2);
  });
});

describe('stepThermalState', () => {
  it('advances orbit phase with time scale', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    const dt = 1; // 1 second
    const next = stepThermalState(state, DEFAULT_THERMAL_PARAMS, dt);
    const expectedPhase = (2 * Math.PI / state.orbitPeriodS) * dt * THERMAL_TIME_SCALE;
    expect(next.orbitPhaseRad).toBeCloseTo(expectedPhase, 8);
  });

  it('wraps orbit phase to [0, 2π]', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    // Jump enough for multiple full orbits with time scale
    const dt = state.orbitPeriodS * 1.5 / THERMAL_TIME_SCALE;
    const next = stepThermalState(state, DEFAULT_THERMAL_PARAMS, dt);
    expect(next.orbitPhaseRad).toBeGreaterThanOrEqual(0);
    expect(next.orbitPhaseRad).toBeLessThan(2 * Math.PI);
  });

  it('enters eclipse when phase exceeds (1 - eclipseFraction) · 2π', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    const eclipseF = computeEclipseFraction(400, 0);
    const eclipseStartPhase = (1 - eclipseF) * 2 * Math.PI;

    // Jump to just past the eclipse start + small margin, accounting for time scale
    const phaseTarget = eclipseStartPhase + 0.01;
    const dt = (phaseTarget / (2 * Math.PI)) * state.orbitPeriodS / THERMAL_TIME_SCALE;

    const next = stepThermalState(state, DEFAULT_THERMAL_PARAMS, dt);
    expect(next.isEclipse).toBe(true);
  });

  it('temperature moves toward eclipse temperature during eclipse', () => {
    // Step through the orbit in small increments until we enter eclipse
    let current = initThermalState(DEFAULT_THERMAL_PARAMS);
    // With THERMAL_TIME_SCALE=600, effective dt = 0.1 * 600 = 60s (stable for τ = 300s)
    const dt = 0.1;

    // Advance until we're in eclipse
    for (let i = 0; i < 10000; i++) {
      current = stepThermalState(current, DEFAULT_THERMAL_PARAMS, dt);
      if (current.isEclipse) break;
    }

    // Confirm we are in eclipse
    expect(current.isEclipse).toBe(true);

    // Step further — temperature should decrease toward eclipse temp
    const prev = current.currentTemperatureDeg;
    current = stepThermalState(current, DEFAULT_THERMAL_PARAMS, dt);
    expect(current.currentTemperatureDeg).toBeLessThan(prev);
  });

  it('temperature moves toward sunlight temperature in sunlight', () => {
    // Start at a cold temperature in sunlight
    const coldState: ThermalState = {
      currentTemperatureDeg: -20,
      isEclipse: false,
      orbitPhaseRad: 0,
      stiffnessMultiplier: 1.0,
      orbitPeriodS: computeOrbitPeriodS(400),
    };
    const next = stepThermalState(coldState, DEFAULT_THERMAL_PARAMS, 60);
    expect(next.currentTemperatureDeg).toBeGreaterThan(-20);
  });

  it('stiffness multiplier is clamped to [0.85, 1.15]', () => {
    // Create extreme temperature state
    const extremeHot: ThermalState = {
      currentTemperatureDeg: 600, // unrealistically hot → multiplier would go very low
      isEclipse: false,
      orbitPhaseRad: 0,
      stiffnessMultiplier: 1.0,
      orbitPeriodS: computeOrbitPeriodS(400),
    };
    const next = stepThermalState(extremeHot, DEFAULT_THERMAL_PARAMS, 0.01);
    expect(next.stiffnessMultiplier).toBeGreaterThanOrEqual(0.85);
    expect(next.stiffnessMultiplier).toBeLessThanOrEqual(1.15);

    // Extremely cold → multiplier would be > 1
    const extremeCold: ThermalState = {
      currentTemperatureDeg: -200,
      isEclipse: false,
      orbitPhaseRad: 0,
      stiffnessMultiplier: 1.0,
      orbitPeriodS: computeOrbitPeriodS(400),
    };
    const next2 = stepThermalState(extremeCold, DEFAULT_THERMAL_PARAMS, 0.01);
    expect(next2.stiffnessMultiplier).toBeGreaterThanOrEqual(0.85);
    expect(next2.stiffnessMultiplier).toBeLessThanOrEqual(1.15);
  });

  it('stiffness multiplier tracks temperature correctly', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    // At sunlight temp 85°C: multiplier = 1 - 3e-4*(85-20) = 0.9805
    const expected = 1.0 - 3.0e-4 * (85 - 20);
    expect(state.stiffnessMultiplier).toBeCloseTo(expected, 6);
  });

  it('completes a full orbit cycle', () => {
    let state = initThermalState(DEFAULT_THERMAL_PARAMS);
    const dt = 1; // 1 second steps (with THERMAL_TIME_SCALE, covers orbit faster)
    // With THERMAL_TIME_SCALE=600, one orbit of ~5555s takes ~9.3 real seconds
    const nSteps = Math.ceil(state.orbitPeriodS / (dt * THERMAL_TIME_SCALE));

    let sawEclipse = false;
    let sawSunlight = false;

    for (let i = 0; i < nSteps; i++) {
      state = stepThermalState(state, DEFAULT_THERMAL_PARAMS, dt);
      if (state.isEclipse) sawEclipse = true;
      else sawSunlight = true;
    }

    expect(sawEclipse).toBe(true);
    expect(sawSunlight).toBe(true);
    // After one full orbit, phase should wrap back near 0
    expect(state.orbitPhaseRad).toBeLessThan(1.0);
  });
});

describe('applyThermalStiffness', () => {
  it('scales spring constant by stiffness multiplier when enabled', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    const baseK = 0.02;
    const result = applyThermalStiffness(baseK, state, DEFAULT_THERMAL_PARAMS);
    expect(result).toBeCloseTo(baseK * state.stiffnessMultiplier, 8);
  });

  it('returns base spring constant when disabled', () => {
    const disabledParams: ThermalParams = {
      ...DEFAULT_THERMAL_PARAMS,
      enabled: false,
    };
    const state = initThermalState(disabledParams);
    const baseK = 0.02;
    const result = applyThermalStiffness(baseK, state, disabledParams);
    expect(result).toBe(baseK);
  });

  it('handles zero spring constant', () => {
    const state = initThermalState(DEFAULT_THERMAL_PARAMS);
    expect(applyThermalStiffness(0, state, DEFAULT_THERMAL_PARAMS)).toBe(0);
  });
});

describe('THERMAL_TIME_SCALE', () => {
  it('is exported and equals 600', () => {
    expect(THERMAL_TIME_SCALE).toBe(600);
  });

  it('makes eclipse visible within ~9 real seconds', () => {
    // At 400 km, orbit period ~5555 s. With ×600 scale, one orbit = ~9.3 real seconds.
    // Eclipse starts at ~63% of orbit → should occur at ~5.8 real seconds.
    let state = initThermalState(DEFAULT_THERMAL_PARAMS);
    const dt = 1 / 60; // 60 fps timestep
    const maxFrames = 10 * 60; // 10 real seconds at 60 fps

    let eclipseFrame = -1;
    for (let i = 0; i < maxFrames; i++) {
      state = stepThermalState(state, DEFAULT_THERMAL_PARAMS, dt);
      if (state.isEclipse && eclipseFrame < 0) {
        eclipseFrame = i;
        break;
      }
    }

    // Eclipse should be reached within 10 seconds of simulation
    expect(eclipseFrame).toBeGreaterThan(0);
    const eclipseTimeS = eclipseFrame * dt;
    expect(eclipseTimeS).toBeLessThan(10);
    expect(eclipseTimeS).toBeGreaterThan(4); // sanity: not instant
  });

  it('temperature changes visibly within deployment window', () => {
    // Step from sunlight into eclipse and verify temperature drops
    let state = initThermalState(DEFAULT_THERMAL_PARAMS);
    const dt = 1 / 60;
    const initialTemp = state.currentTemperatureDeg;

    // Run for 8 real seconds — should enter eclipse and start cooling
    for (let i = 0; i < 8 * 60; i++) {
      state = stepThermalState(state, DEFAULT_THERMAL_PARAMS, dt);
    }

    // Temperature should have changed noticeably (> 5°C)
    const tempChange = Math.abs(state.currentTemperatureDeg - initialTemp);
    expect(tempChange).toBeGreaterThan(5);
  });
});
