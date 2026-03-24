import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLEX_PARAMS,
  computeFirstNaturalFreq,
  computeParticipationFactors,
  initFlexState,
  stepFlexState,
  type FlexParams,
} from '@/lib/physics/flexModel';

describe('flexModel', () => {
  it('initializes modal state with zeros for requested mode count', () => {
    const params: FlexParams = {
      ...DEFAULT_FLEX_PARAMS,
      numModes: 3,
      naturalFreqHz: [8, 20, 45],
      modalDamping: [0.01, 0.01, 0.01],
      modalMassNorm: [1, 1, 1],
      participationFactor: [1.4, 0.8, 0.3],
    };

    const state = initFlexState(params);
    expect(state.modalAmplitudes).toEqual([0, 0, 0]);
    expect(state.modalVelocities).toEqual([0, 0, 0]);
    expect(state.tipDeflectionM).toBe(0);
    expect(state.tipDeflectionDeg).toBe(0);
  });

  it('returns stable analytical participation factors', () => {
    const factors = computeParticipationFactors(0.3405, 0.3);
    expect(factors).toHaveLength(2);
    expect(factors[0]).toBeCloseTo(1.566, 3);
    expect(factors[1]).toBeCloseTo(0.868, 3);
    expect(factors[0]).toBeGreaterThan(factors[1]);
  });

  it('first natural frequency decreases strongly with longer panel length', () => {
    const shortPanelF1 = computeFirstNaturalFreq(0.2, 0.1, 0.0025);
    const longPanelF1 = computeFirstNaturalFreq(0.4, 0.1, 0.0025);

    expect(shortPanelF1).toBeGreaterThan(longPanelF1);
    expect(shortPanelF1 / longPanelF1).toBeGreaterThan(3.5);
  });

  it('first natural frequency increases with panel thickness', () => {
    const thinPanelF1 = computeFirstNaturalFreq(0.3405, 0.1, 0.0015);
    const thickPanelF1 = computeFirstNaturalFreq(0.3405, 0.1, 0.003);

    expect(thickPanelF1).toBeGreaterThan(thinPanelF1);
  });

  it('keeps zero state at rest when forcing is zero', () => {
    const state = initFlexState(DEFAULT_FLEX_PARAMS);
    const next = stepFlexState(state, DEFAULT_FLEX_PARAMS, 0, 1 / 60);

    expect(next.modalAmplitudes[0]).toBeCloseTo(0, 12);
    expect(next.modalVelocities[0]).toBeCloseTo(0, 12);
    expect(next.tipDeflectionM).toBeCloseTo(0, 12);
    expect(next.tipDeflectionDeg).toBeCloseTo(0, 12);
  });

  it('responds to non-zero angular acceleration with non-zero deflection', () => {
    const state = initFlexState(DEFAULT_FLEX_PARAMS);
    const next = stepFlexState(state, DEFAULT_FLEX_PARAMS, 3.0, 1 / 120, 0.3405, 0.3);

    expect(Math.abs(next.modalAmplitudes[0])).toBeGreaterThan(0);
    expect(Math.abs(next.modalVelocities[0])).toBeGreaterThan(0);
    expect(Math.abs(next.tipDeflectionM)).toBeGreaterThan(0);
    expect(Math.abs(next.tipDeflectionDeg)).toBeGreaterThan(0);
  });

  it('damping reduces free-vibration amplitude over repeated steps', () => {
    const params: FlexParams = {
      numModes: 1,
      naturalFreqHz: [2],
      modalDamping: [0.2],
      modalMassNorm: [1],
      participationFactor: [1],
    };

    let state = {
      modalAmplitudes: [0.05],
      modalVelocities: [0],
      tipDeflectionM: 0.05,
      tipDeflectionDeg: 0,
    };

    const initialAbsAmplitude = Math.abs(state.modalAmplitudes[0]);
    for (let i = 0; i < 200; i++) {
      state = stepFlexState(state, params, 0, 1 / 240, 0.3405, 0.3);
    }

    const finalAbsAmplitude = Math.abs(state.modalAmplitudes[0]);
    expect(finalAbsAmplitude).toBeLessThan(initialAbsAmplitude);
  });
});
