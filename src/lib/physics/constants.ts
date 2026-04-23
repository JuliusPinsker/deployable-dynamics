// Standardized physical constants used by the physics engine.

/** Earth gravitational parameter μ = GM (m^3/s^2) - WGS-84 / IERS 2010. */
export const GM_EARTH = 3.986004418e14;

/** Earth mean radius (m) - IUGG mean Earth radius consistent with WGS-84 usage. */
export const R_EARTH = 6.371e6;

/** Solar radiation pressure at 1 AU (N/m^2) - standard spacecraft environment model value. */
export const P_SOLAR_1AU = 4.56e-6;

/** Speed of light in vacuum (m/s) - CODATA 2018 exact defined value. */
export const C_LIGHT = 299_792_458;

/** Earth surface equatorial magnetic field reference (Tesla) - IGRF-13 epoch 2020. */
export const EARTH_B0_TESLA = 3.12e-5;

/** Earth magnetic dipole tilt from geographic north (radians) - IGRF-13. */
export const EARTH_DIPOLE_TILT_RAD = 0.19722; // MathUtils.degToRad(11.3)
