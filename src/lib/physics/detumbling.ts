import { Vector3, Quaternion, MathUtils } from 'three';
import {
  GM_EARTH,
  R_EARTH,
  EARTH_B0_TESLA,
  EARTH_DIPOLE_TILT_RAD,
} from './constants';

const TWO_PI_RAD = MathUtils.degToRad(360);
const WORLD_Z_AXIS = new Vector3(0, 0, 1);
const WORLD_Y_AXIS = new Vector3(0, 1, 0);
const ORBIT_REFERENCE_DIRECTION = new Vector3(1, 0, 0);

/**
 * Calculates the Earth's magnetic field vector in the body frame using a tilted dipole model.
 * Source equation: Wertz (1978), Spacecraft Attitude Determination and Control,
 * §5.1, Eq. 5.1-1 (dipole field) with equatorial circular-orbit kinematics.
 *
 * @param {Quaternion} qBody Body orientation in the world frame.
 * @param {number} t Simulation time in seconds.
 * @param {number} altitudeM Orbit altitude above Earth's surface in meters.
 * @returns {Vector3} The magnetic field vector in the body frame (Tesla).
 */
export function getMagneticFieldBody(
  qBody: Quaternion,
  t: number,
  altitudeM: number,
): Vector3 {
  const orbitRadiusM = R_EARTH + altitudeM;
  const orbitMeanMotionRadPerSec = (GM_EARTH / orbitRadiusM ** 3) ** 0.5;
  const orbitPeriodS = TWO_PI_RAD / orbitMeanMotionRadPerSec;
  const thetaOrbit = (TWO_PI_RAD / orbitPeriodS) * t;

  const rHatWorld = ORBIT_REFERENCE_DIRECTION
    .clone()
    .applyAxisAngle(WORLD_Z_AXIS, thetaOrbit)
    .normalize();

  const dipoleAxisWorld = WORLD_Z_AXIS
    .clone()
    .applyAxisAngle(WORLD_Y_AXIS, EARTH_DIPOLE_TILT_RAD)
    .normalize();

  const dipoleShape = rHatWorld
    .clone()
    .multiplyScalar(3 * dipoleAxisWorld.dot(rHatWorld))
    .sub(dipoleAxisWorld);

  const radialScale = (R_EARTH / orbitRadiusM) ** 3;
  const bWorld = dipoleShape.multiplyScalar(EARTH_B0_TESLA * radialScale);

  return bWorld.applyQuaternion(qBody.clone().conjugate());
}

/**
 * Implements the B-dot control law to command a magnetic dipole moment.
 * Source equation: Wertz (1978), Spacecraft Attitude Determination and Control,
 * §7.4, Eq. 7.4-3.
 *
 * @param {Vector3} bBody Current magnetic field in the body frame (Tesla).
 * @param {Vector3} bBodyPrev Magnetic field in the body frame at the previous timestep (Tesla).
 * @param {number} dt Timestep in seconds.
 * @param {number} gain Controller gain k (A·m²·s / (rad·kg)).
 * @param {number} maxDipoleMoment Saturation limit for the magnetorquer dipole moment (A·m²).
 * @returns {Vector3} The commanded magnetic dipole moment m in the body frame (A·m²).
 */
export function bdotControl(
  bBody: Vector3,
  bBodyPrev: Vector3,
  dt: number,
  gain: number,
  maxDipoleMoment: number,
): Vector3 {
  if (dt <= 0) {
    return new Vector3();
  }

  const dBdt = bBody.clone().sub(bBodyPrev).divideScalar(dt);
  const mBody = dBdt.multiplyScalar(-gain);

  const commandMagnitude = mBody.length();
  const clampedMagnitude = MathUtils.clamp(commandMagnitude, 0, maxDipoleMoment);

  if (commandMagnitude > 0 && clampedMagnitude < commandMagnitude) {
    mBody.normalize().multiplyScalar(clampedMagnitude);
  }

  return mBody;
}

/**
 * Calculates the torque produced by a magnetorquer.
 * Source equation: Wertz (1978), Spacecraft Attitude Determination and Control,
 * §7.4, Eq. 7.4-1.
 *
 * @param {Vector3} mBody Commanded dipole moment in the body frame (A·m²).
 * @param {Vector3} bBody Magnetic field in the body frame (Tesla).
 * @returns {Vector3} The resulting torque in the body frame (N·m).
 */
export function magnetorquerTorque(
  mBody: Vector3,
  bBody: Vector3,
): Vector3 {
  return mBody.clone().cross(bBody);
}

// Runtime state for B-dot detumbling control.
export interface DetumblingState {
  active: boolean;
  bBodyPrev: Vector3;
  dipoleMoment: Vector3;
  torqueWorld: Vector3;
  omegaMag: number;
  converged: boolean;
}

// Controller parameters for B-dot detumbling.
export interface DetumblingParams {
  gain: number;
  maxDipoleMoment: number;
  omegaThreshold: number;
  altitudeM: number;
  enabled: boolean;
}

export const DEFAULT_DETUMBLING_PARAMS: DetumblingParams = {
  gain: 1e-4,
  maxDipoleMoment: 0.2,
  omegaThreshold: MathUtils.degToRad(0.5),
  altitudeM: 400_000,
  enabled: false,
};

/**
 * Steps the detumbling simulation forward by one timestep.
 * Source equations: Wertz (1978), Spacecraft Attitude Determination and Control,
 * §7.4, Eq. 7.4-1 and Eq. 7.4-3.
 *
 * @param {DetumblingState} state The current detumbling state.
 * @param {DetumblingParams} params The detumbling controller parameters.
 * @param {Quaternion} qBody The current body orientation in the world frame.
 * @param {Vector3} omegaBody The current angular velocity in the world frame (rad/s).
 * @param {number} t The current simulation time (s).
 * @param {number} dt The timestep (s).
 * @returns {{ newState: DetumblingState; torqueWorld: Vector3 }} The updated state and resulting torque.
 */
export function stepDetumbling(
  state: DetumblingState,
  params: DetumblingParams,
  qBody: Quaternion,
  omegaBody: Vector3,
  t: number,
  dt: number,
): { newState: DetumblingState; torqueWorld: Vector3 } {
  if (!params.enabled || !state.active) {
    const omegaMag = omegaBody.length();
    const converged = omegaMag < params.omegaThreshold;
    const zeroTorque = new Vector3();
    const newState: DetumblingState = {
      ...state,
      active: params.enabled && state.active,
      dipoleMoment: new Vector3(),
      torqueWorld: zeroTorque.clone(),
      omegaMag,
      converged,
    };
    return { newState, torqueWorld: zeroTorque };
  }

  const bBody = getMagneticFieldBody(qBody, t, params.altitudeM);
  const mBody = bdotControl(bBody, state.bBodyPrev, dt, params.gain, params.maxDipoleMoment);
  const torqueBody = magnetorquerTorque(mBody, bBody);
  const torqueWorld = torqueBody.clone().applyQuaternion(qBody);

  const omegaMag = omegaBody.length();
  const converged = omegaMag < params.omegaThreshold;

  const newState: DetumblingState = {
    ...state,
    bBodyPrev: bBody,
    dipoleMoment: mBody,
    torqueWorld,
    omegaMag,
    converged,
    active: params.enabled && !converged,
  };

  return { newState, torqueWorld };
}
