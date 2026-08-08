import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const OMEGA_EPS = 1e-9;

/** Format an angular-velocity component (rad/s) as a clean deg/s string,
 *  clamping near-zero floating-point noise to 0.00 so configs read consistently. */
export function formatOmegaDegPerSec(rad: number): string {
  const deg = (rad * 180) / Math.PI;
  const x = Math.abs(deg) < OMEGA_EPS ? 0 : deg;
  return `${x.toFixed(2)}°/s`;
}

/** Format a torque magnitude (N·m) in scientific notation. Required detumbling
 *  torques land around 1e-7 N·m, so fixed decimals would round them all to 0. */
export function formatTorqueNm(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '--';
  return value.toExponential(digits);
}
