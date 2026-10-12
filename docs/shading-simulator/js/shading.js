// Shading of the module surfaces by obstructions.
//
// Approximation (illustrative, not a validated CdTe model):
// - Each Series 6 Plus module is a set of long, narrow cells ("stripes") in series, with no bypass
//   diodes. The string current is set by the weakest stripe, so the frame's output follows the
//   most-shaded stripe, not the shaded area.
// - The light a stripe receives = (beam + circumsolar) x mean sunlight transmittance along the stripe
//   + isotropic sky diffuse x (1 - sky fraction hidden by the obstruction) + ground-reflected light.
// - Output ratio = (weakest stripe's irradiance) / (unshaded irradiance), at constant voltage.
import { add, scale, dot, normalize, cross } from './vec.js';
import { transmittance } from './obstructions.js';

export const STRIPE_DIRECTIONS = {
  slope: 'Stripes run up the slope (along the module length)',
  across: 'Stripes run across the frame (along the module width)',
};

/**
 * Sample points on each module of a frame, grouped by stripe.
 * nStripes stripes per module, nAlong samples along each stripe.
 */
export function moduleSamples(frame, { nStripes = 32, nAlong = 24, direction = 'slope' } = {}) {
  const lift = scale(frame.normal, 0.005);
  return frame.modules.map((m) => {
    const stripes = [];
    for (let s = 0; s < nStripes; s++) {
      const pts = [];
      for (let k = 0; k < nAlong; k++) {
        const a = (s + 0.5) / nStripes, b = (k + 0.5) / nAlong;
        const [fu, fv] = direction === 'slope' ? [a, b] : [b, a];
        pts.push(add(frame.point(m.u0 + fu * (m.u1 - m.u0), m.v0 + fv * (m.v1 - m.v0)), lift));
      }
      stripes.push(pts);
    }
    return { module: m.index, stripes };
  });
}

/** Mean sunlight transmittance of each stripe for sun direction `sunVec`. */
export function stripeTransmittance(samples, sunVec, obstructions) {
  return samples.map(({ stripes }) => stripes.map((pts) => {
    let sum = 0;
    for (const p of pts) sum += transmittance(p, sunVec, obstructions);
    return sum / pts.length;
  }));
}

// Fixed cosine-weighted direction set over a hemisphere (golden-angle spiral).
function hemisphereDirections(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n), phi = i * 2.399963229728653;
    out.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - r * r)]);
  }
  return out;
}
const HEMI = hemisphereDirections(192);

/**
 * Fraction of the isotropic sky diffuse hidden from each module by the obstructions.
 * Directions are cosine-weighted about the module normal; only directions above the horizon are sky.
 */
export function skyBlocking(frame, obstructions) {
  if (!obstructions.length) return frame.modules.map(() => 0);
  const n = frame.normal, t1 = normalize(cross(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], n)), t2 = cross(n, t1);
  const dirs = HEMI.map((h) => add(add(scale(t1, h[0]), scale(t2, h[1])), scale(n, h[2]))).filter((d) => d[2] > 0);
  return frame.modules.map((m) => {
    let blocked = 0, count = 0;
    for (const fv of [0.2, 0.5, 0.8]) for (const fu of [0.25, 0.75]) {
      const p = add(frame.point(m.u0 + fu * (m.u1 - m.u0), m.v0 + fv * (m.v1 - m.v0)), scale(n, 0.005));
      for (const d of dirs) { blocked += 1 - transmittance(p, d, obstructions); count++; }
    }
    return count ? blocked / count : 0;
  });
}

/**
 * Output ratio of a frame (0-1) given plane irradiance components, stripe transmittances and sky blocking.
 * Returns the current-limited ratio, the area-average ratio (for comparison) and the shaded-area fraction.
 */
export function frameOutputRatio(poa, stripeTau, skyBlock) {
  if (poa.total <= 0) return { ratio: 1, areaRatio: 1, shadedArea: 0, weakest: null };
  const beam = poa.direct + poa.circumsolar;
  let worst = Infinity, weakest = null, sum = 0, count = 0, shaded = 0;
  stripeTau.forEach((stripes, m) => {
    const diffuse = poa.isotropic * (1 - skyBlock[m]) + poa.ground;
    stripes.forEach((tau, s) => {
      const g = beam * tau + diffuse;
      if (g < worst) { worst = g; weakest = { module: m, stripe: s }; }
      sum += g; count++; shaded += 1 - tau;
    });
  });
  return { ratio: Math.min(1, worst / poa.total), areaRatio: Math.min(1, sum / count / poa.total),
    shadedArea: shaded / count, weakest };
}

/** True when the sun is in front of the module plane (otherwise the frame is self-shaded / unlit by beam). */
export function sunInFront(frame, sunVec) {
  return dot(frame.normal, sunVec) > 1e-6 && sunVec[2] > 0;
}
