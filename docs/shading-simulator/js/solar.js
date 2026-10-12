// Sun position, clear-sky irradiance and plane-of-array transposition.
// Checked against pvlib 0.16.1 in tests/solar.test.mjs (fixtures from tools/make_reference.py).
import { DEG, clamp } from './vec.js';

// ---------- Local time <-> UTC (handles daylight saving through Intl) ----------

function utcOffsetHours(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs) / 3.6e6;
}

/** UTC epoch (ms) of a local wall-clock time `minutes` after local midnight on `date` (YYYY-MM-DD). */
export function localToUtc(date, minutes, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, 0) + minutes * 60000;
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - utcOffsetHours(guess, timeZone) * 3.6e6;
  return guess;
}

export function dayOfYear(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5) + 1;
}

// ---------- Sun position: NOAA solar calculator (Meeus), about 0.01 deg ----------

function refractionDeg(e) {
  // NOAA approximation of atmospheric refraction (degrees) at true elevation e (degrees).
  if (e > 85) return 0;
  const t = Math.tan(e * DEG);
  let arcsec;
  if (e > 5) arcsec = 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5;
  else if (e > -0.575) arcsec = 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)));
  else arcsec = -20.774 / t;
  return arcsec / 3600;
}

/**
 * Sun position at a UTC instant. Returns degrees and a unit vector toward the sun
 * (east, north, up) built from the apparent (refracted) elevation, as used for shadows.
 */
export function sunPosition(utcMs, lat, lon) {
  const jd = utcMs / 864e5 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * DEG) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * DEG) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * DEG) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * DEG);
  const decl = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG));
  const y = Math.tan((eps / 2) * DEG) ** 2;
  const eqTime = 4 / DEG * (y * Math.sin(2 * L0 * DEG) - 2 * e * Math.sin(M * DEG)
    + 4 * e * y * Math.sin(M * DEG) * Math.cos(2 * L0 * DEG)
    - 0.5 * y * y * Math.sin(4 * L0 * DEG) - 1.25 * e * e * Math.sin(2 * M * DEG));
  const utcMinutes = (((utcMs / 60000) % 1440) + 1440) % 1440;
  const trueSolarTime = (((utcMinutes + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = (trueSolarTime / 4 - 180) * DEG;
  const phi = lat * DEG;
  const east = -Math.cos(decl) * Math.sin(hourAngle);
  const north = Math.cos(phi) * Math.sin(decl) - Math.sin(phi) * Math.cos(decl) * Math.cos(hourAngle);
  const up = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle);
  const elevation = Math.asin(clamp(up, -1, 1)) / DEG;
  const azimuth = ((Math.atan2(east, north) / DEG) + 360) % 360;
  const apparentElevation = elevation + refractionDeg(elevation);
  const ce = Math.cos(apparentElevation * DEG);
  const vector = [ce * Math.sin(azimuth * DEG), ce * Math.cos(azimuth * DEG), Math.sin(apparentElevation * DEG)];
  return { elevation, apparentElevation, azimuth, zenith: 90 - apparentElevation, vector,
    declination: decl / DEG, equationOfTime: eqTime };
}

// ---------- Clear sky: Ineichen-Perez (as pvlib.clearsky.ineichen) ----------

export function extraterrestrial(doy) {
  const b = 2 * Math.PI * (doy - 1) / 365; // Spencer (1971), pvlib solar constant 1366.1 W/m2
  return 1366.1 * (1.00011 + 0.034221 * Math.cos(b) + 0.00128 * Math.sin(b)
    + 0.000719 * Math.cos(2 * b) + 0.000077 * Math.sin(2 * b));
}

/** Monthly Linke turbidity interpolated between mid-month values. */
export function linkeTurbidity(date, monthly) {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 12);
  const mid = (yy, mm) => (Date.UTC(yy, mm, 1) + Date.UTC(yy, mm + 1, 1)) / 2; // mm may be -1 or 12
  let a = m - 1;
  if (t < mid(y, a)) a -= 1;
  const ta = mid(y, a), tb = mid(y, a + 1);
  const va = monthly[(a + 12) % 12], vb = monthly[(a + 13) % 12];
  return va + (vb - va) * (t - ta) / (tb - ta);
}

export function clearSky(apparentZenith, doy, linke, altitudeM = 0, extra = extraterrestrial(doy)) {
  if (apparentZenith >= 90) return { ghi: 0, dni: 0, dhi: 0, extra };
  const cosZ = Math.cos(apparentZenith * DEG);
  const amRel = 1 / (cosZ + 0.50572 * (96.07995 - apparentZenith) ** -1.6364); // Kasten-Young 1989
  const pressure = 100 * ((44331.514 - altitudeM) / 11880.516) ** (1 / 0.1902632);
  const am = amRel * pressure / 101325;
  const fh1 = Math.exp(-altitudeM / 8000), fh2 = Math.exp(-altitudeM / 1250);
  const cg1 = 5.09e-5 * altitudeM + 0.868, cg2 = 3.92e-5 * altitudeM + 0.0387;
  const ghi = cg1 * extra * cosZ * Math.max(0, Math.exp(-cg2 * am * (fh1 + fh2 * (linke - 1))));
  const bnci = extra * Math.max(0, (0.664 + 0.163 / fh1) * Math.exp(-0.09 * am * (linke - 1)));
  const bnci2 = ghi * Math.min(Math.max(0, (1 - (0.1 - 0.2 * Math.exp(-linke)) / (0.1 + 0.882 / fh1)) / cosZ), 1e20);
  const dni = Math.min(bnci, bnci2);
  return { ghi, dni, dhi: ghi - dni * cosZ, extra };
}

// ---------- Plane of array: Hay-Davies sky diffuse + isotropic ground reflection ----------

/** Unit normal of a plane with given tilt and azimuth (degrees, azimuth clockwise from north). */
export function planeNormal(tiltDeg, azimuthDeg) {
  const t = tiltDeg * DEG, a = azimuthDeg * DEG;
  return [Math.sin(t) * Math.sin(a), Math.sin(t) * Math.cos(a), Math.cos(t)];
}

/**
 * Irradiance components on a plane with unit normal `n` (W/m2).
 * `direct + circumsolar` comes from the solar disc's neighbourhood and is what an obstruction blocks;
 * `isotropic` is the rest of the sky dome; `ground` is reflected from the ground.
 */
export function planeIrradiance(n, sun, sky, albedo) {
  const cosZ = Math.cos(sun.zenith * DEG);
  if (sky.ghi <= 0 || cosZ <= 0) return { direct: 0, circumsolar: 0, isotropic: 0, ground: 0, total: 0, cosAoi: 0 };
  const cosAoi = n[0] * sun.vector[0] + n[1] * sun.vector[1] + n[2] * sun.vector[2];
  const rb = Math.max(cosAoi, 0) / Math.max(cosZ, 0.01745);
  const ai = sky.dni / sky.extra;
  const direct = Math.max(0, sky.dni * cosAoi);
  const circumsolar = Math.max(0, sky.dhi * ai * rb);
  const isotropic = Math.max(0, sky.dhi * (1 - ai) * (1 + n[2]) / 2);
  const ground = sky.ghi * albedo * (1 - n[2]) / 2;
  return { direct, circumsolar, isotropic, ground, total: direct + circumsolar + isotropic + ground, cosAoi };
}
