import { unit } from 'mathjs';
import * as satellite from 'satellite.js';

const SAT_CONSTANTS = (satellite as unknown as { constants?: { earthRadius?: number } }).constants;

// Earth gravitational parameter mu = GM (m^3/s^2) - WGS-84
export const GM_EARTH = 3.986004418e14; // mathjs: evaluate('gravitationConstant * earthMass')

// Earth mean radius (m) - WGS-84
export const R_EARTH_M = 6.371e6;

// Earth mean radius (km) - for satellite.js (uses km internally)
export const R_EARTH_KM = SAT_CONSTANTS?.earthRadius ?? 6378.135; // curated WGS-72 value

// Solar radiation pressure at 1 AU (N/m^2) - IERS/IAU
export const P_SOLAR = 4.56e-6;

// Speed of light (m/s) - CODATA 2018 exact value
export const C_LIGHT: number = (() => {
	try {
		return unit('speedOfLight').toNumber('m/s');
	} catch {
		return unit('299792458 m/s').toNumber('m/s');
	}
})();

// Temperature coefficient of elastic modulus for spring steel EN10270-1 (K^-1)
// Source: ESA ECSS-E-HB-32-20A (2011), Table 4.3
export const ALPHA_E = 3.0e-4;

// Reference elastic modulus of spring steel at 20°C (GPa)
export const E0_GPa = 206.0;

