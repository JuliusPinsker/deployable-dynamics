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
