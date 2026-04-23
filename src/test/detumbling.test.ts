import { describe, it, expect } from 'vitest';
import { MathUtils, Quaternion, Vector3 } from 'three';
import {
  getMagneticFieldBody,
  bdotControl,
  magnetorquerTorque,
  stepDetumbling,
  DEFAULT_DETUMBLING_PARAMS,
  type DetumblingParams,
  type DetumblingState,
} from '../lib/physics/detumbling';
import { R_EARTH } from '../lib/physics/constants';

function expectVectorClose(actual: Vector3, expected: Vector3, tolerance: number): void {
  expect(actual.x).toBeCloseTo(expected.x, tolerance);
  expect(actual.y).toBeCloseTo(expected.y, tolerance);
  expect(actual.z).toBeCloseTo(expected.z, tolerance);
}

describe('getMagneticFieldBody', () => {
  it('returns a finite non-zero field in LEO', () => {
    const bBody = getMagneticFieldBody(new Quaternion(), 0, 400_000);

    expect(Number.isFinite(bBody.length())).toBe(true);
    expect(bBody.length()).toBeGreaterThan(0);
  });

  it('follows inverse-cube scaling with orbital radius', () => {
    const altitudeLow = 400_000;
    const altitudeHigh = 800_000;
    const timeS = 0;

    const bLow = getMagneticFieldBody(new Quaternion(), timeS, altitudeLow);
    const bHigh = getMagneticFieldBody(new Quaternion(), timeS, altitudeHigh);

    const ratioMeasured = bLow.length() / bHigh.length();
    const ratioExpected = ((R_EARTH + altitudeHigh) / (R_EARTH + altitudeLow)) ** 3;

    expect(ratioMeasured).toBeCloseTo(ratioExpected, 10);
  });

  it('rotates world field into body frame via qBody conjugate', () => {
    const t = 250;
    const altitudeM = 400_000;
    const qBody = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      MathUtils.degToRad(90),
    );

    const bIdentity = getMagneticFieldBody(new Quaternion(), t, altitudeM);
    const bRotated = getMagneticFieldBody(qBody, t, altitudeM);
    const expected = bIdentity.clone().applyQuaternion(qBody.clone().conjugate());

    expectVectorClose(bRotated, expected, 12);
  });
});

describe('bdotControl', () => {
  it('applies m = -k * dB/dt', () => {
    const bBody = new Vector3(2e-5, -1e-5, 3e-5);
    const bBodyPrev = new Vector3(1e-5, -1e-5, 1e-5);
    const dt = 2;
    const gain = 1e-4;
    const maxDipoleMoment = 0.2;

    const command = bdotControl(bBody, bBodyPrev, dt, gain, maxDipoleMoment);
    const expected = bBody.clone().sub(bBodyPrev).divideScalar(dt).multiplyScalar(-gain);

    expectVectorClose(command, expected, 16);
  });

  it('saturates command magnitude at maxDipoleMoment', () => {
    const command = bdotControl(
      new Vector3(1, 0, 0),
      new Vector3(-1, 0, 0),
      0.1,
      10,
      0.2,
    );

    expect(command.length()).toBeCloseTo(0.2, 12);
    expect(command.x).toBeLessThan(0);
  });

  it('returns zero command for non-positive dt', () => {
    const command = bdotControl(
      new Vector3(1, 2, 3),
      new Vector3(3, 2, 1),
      0,
      1,
      1,
    );

    expect(command.length()).toBe(0);
  });
});

describe('magnetorquerTorque', () => {
  it('computes tau = m x B in body frame', () => {
    const tau = magnetorquerTorque(new Vector3(1, 0, 0), new Vector3(0, 2, 0));
    expectVectorClose(tau, new Vector3(0, 0, 2), 12);
  });
});

describe('DEFAULT_DETUMBLING_PARAMS', () => {
  it('provides expected baseline values', () => {
    expect(DEFAULT_DETUMBLING_PARAMS.gain).toBe(1e-4);
    expect(DEFAULT_DETUMBLING_PARAMS.maxDipoleMoment).toBe(0.2);
    expect(DEFAULT_DETUMBLING_PARAMS.omegaThreshold).toBeCloseTo(MathUtils.degToRad(0.5), 12);
    expect(DEFAULT_DETUMBLING_PARAMS.altitudeM).toBe(400_000);
    expect(DEFAULT_DETUMBLING_PARAMS.enabled).toBe(false);
  });
});

describe('stepDetumbling', () => {
  const baseState: DetumblingState = {
    active: true,
    bBodyPrev: new Vector3(),
    dipoleMoment: new Vector3(),
    torqueWorld: new Vector3(),
    omegaMag: 0,
    converged: false,
  };

  const baseParams: DetumblingParams = {
    gain: 1e-4,
    maxDipoleMoment: 0.2,
    omegaThreshold: 0.01,
    altitudeM: 400_000,
    enabled: true,
  };

  it('outputs zero torque when controller is disabled', () => {
    const params = { ...baseParams, enabled: false };
    const omegaBody = new Vector3(0.1, 0, 0);

    const { newState, torqueWorld } = stepDetumbling(
      baseState,
      params,
      new Quaternion(),
      omegaBody,
      0,
      0.1,
    );

    expect(torqueWorld.length()).toBe(0);
    expect(newState.torqueWorld.length()).toBe(0);
    expect(newState.dipoleMoment.length()).toBe(0);
    expect(newState.active).toBe(false);
  });

  it('updates state and convergence when enabled', () => {
    const omegaBody = new Vector3(0.001, 0, 0);

    const { newState, torqueWorld } = stepDetumbling(
      baseState,
      baseParams,
      new Quaternion(),
      omegaBody,
      10,
      0.1,
    );

    expect(newState.bBodyPrev.length()).toBeGreaterThan(0);
    expect(newState.dipoleMoment.length()).toBeLessThanOrEqual(baseParams.maxDipoleMoment + 1e-12);
    expectVectorClose(newState.torqueWorld, torqueWorld, 12);
    expect(newState.omegaMag).toBeCloseTo(omegaBody.length(), 12);
    expect(newState.converged).toBe(true);
    expect(newState.active).toBe(false);
  });
});
