// Obstructions built from simple primitives (ellipsoids, finite cylinders, oriented boxes).
// The same primitives drive both the 3D drawing and the shading ray casts, so what you see
// is exactly what blocks light in the calculation.
import { add, sub, scale, dot, cross, length, normalize, clamp } from './vec.js';
import { frameBasis } from './site.js';

// ---------- Seeded random numbers (so a tree looks the same every time) ----------
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Ray-primitive intersection (ray: origin o, unit direction d) ----------
// Each returns the entry distance t (>= 0) or -1 for a miss.

function hitEllipsoid(o, d, p) {
  const r = p.radii;
  const oc = [(o[0] - p.c[0]) / r[0], (o[1] - p.c[1]) / r[1], (o[2] - p.c[2]) / r[2]];
  const dd = [d[0] / r[0], d[1] / r[1], d[2] / r[2]];
  const a = dot(dd, dd), b = dot(oc, dd), c = dot(oc, oc) - 1;
  const h = b * b - a * c;
  if (h < 0) return -1;
  const s = Math.sqrt(h);
  const t1 = (-b - s) / a, t2 = (-b + s) / a;
  if (t2 <= 1e-6) return -1;
  return Math.max(t1, 0);
}

function hitCylinder(o, d, p) {
  // Finite capped cylinder from p.a to p.b with radius p.r (after Inigo Quilez).
  const ba = sub(p.b, p.a), oc = sub(o, p.a);
  const baba = dot(ba, ba), bard = dot(ba, d), baoc = dot(ba, oc);
  const k2 = baba - bard * bard;
  const k1 = baba * dot(oc, d) - baoc * bard;
  const k0 = baba * dot(oc, oc) - baoc * baoc - p.r * p.r * baba;
  let best = -1;
  if (Math.abs(k2) > 1e-12) {
    const h = k1 * k1 - k2 * k0;
    if (h >= 0) {
      const s = Math.sqrt(h);
      for (const t of [(-k1 - s) / k2, (-k1 + s) / k2]) {
        const y = baoc + t * bard;
        if (t > 1e-6 && y > 0 && y < baba) { best = best < 0 ? t : Math.min(best, t); }
      }
    }
  }
  if (Math.abs(bard) > 1e-12) {
    for (const cap of [0, baba]) {
      const t = (cap - baoc) / bard;
      if (t > 1e-6) {
        const q = sub(add(o, scale(d, t)), cap === 0 ? p.a : p.b);
        if (dot(q, q) <= p.r * p.r) best = best < 0 ? t : Math.min(best, t);
      }
    }
  }
  return best;
}

function hitBox(o, d, p) {
  // Oriented box: centre c, unit axes ax[3], half sizes h[3] (slab method).
  let tmin = -Infinity, tmax = Infinity;
  const oc = sub(o, p.c);
  for (let i = 0; i < 3; i++) {
    const e = dot(p.ax[i], oc), f = dot(p.ax[i], d);
    if (Math.abs(f) < 1e-12) {
      if (Math.abs(e) > p.h[i]) return -1;
    } else {
      let t1 = (-e - p.h[i]) / f, t2 = (-e + p.h[i]) / f;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  if (tmax <= 1e-6) return -1;
  return Math.max(tmin, 0);
}

export function hitPrimitive(o, d, p) {
  if (p.type === 'ellipsoid') return hitEllipsoid(o, d, p);
  if (p.type === 'cylinder') return hitCylinder(o, d, p);
  return hitBox(o, d, p);
}

function hitsSphere(o, d, c, r) {
  const oc = sub(o, c), b = dot(oc, d), cc = dot(oc, oc) - r * r;
  if (cc > 0 && b > 0) return false;
  return b * b - cc >= 0;
}

/** Fraction of a ray toward the sun that gets through all obstructions (1 = clear, 0 = fully blocked). */
export function transmittance(o, d, obstructions) {
  let tau = 1;
  for (const ob of obstructions) {
    if (!hitsSphere(o, d, ob.bounds.c, ob.bounds.r)) continue;
    for (const p of ob.primitives) {
      if (hitPrimitive(o, d, p) >= 0) {
        tau *= 1 - p.opacity;
        if (tau < 1e-4) return 0;
      }
    }
  }
  return tau;
}

/** Distance to the first primitive the ray hits (Infinity if none) and the transmittance. */
export function traceRay(o, d, obstructions) {
  let first = Infinity, tau = 1;
  for (const ob of obstructions) {
    if (!hitsSphere(o, d, ob.bounds.c, ob.bounds.r)) continue;
    for (const p of ob.primitives) {
      const t = hitPrimitive(o, d, p);
      if (t >= 0) { first = Math.min(first, t); tau *= 1 - p.opacity; }
    }
  }
  return { first, tau };
}

function boundsOf(primitives) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const grow = (q, r) => { for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], q[i] - r); hi[i] = Math.max(hi[i], q[i] + r); } };
  for (const p of primitives) {
    if (p.type === 'ellipsoid') grow(p.c, Math.max(...p.radii));
    else if (p.type === 'cylinder') { grow(p.a, p.r); grow(p.b, p.r); }
    else grow(p.c, length(p.h));
  }
  const c = scale(add(lo, hi), 0.5);
  return { c, r: length(sub(hi, c)) + 1e-3, lo, hi };
}

// ---------- Builders ----------

/**
 * A broadleaf tree standing on the ground at `base`.
 * height: total height (m); crownWidth: crown diameter (m); crownBase: height where the crown starts (m);
 * density: fraction of sunlight one leaf cluster blocks (0-1). Gaps between clusters let light through.
 */
export function buildTree({ base, height, crownWidth, crownBase, density, seed = 7 }) {
  const rand = rng(seed);
  const H = Math.max(0.5, height);
  const hb = clamp(crownBase, 0.1, H - 0.3);
  const crownH = H - hb, Rh = Math.max(0.2, crownWidth / 2), Rv = crownH / 2;
  const C = [base[0], base[1], hb + Rv];
  const rTrunk = clamp(0.03 * H + 0.02 * crownWidth, 0.06, 0.45);
  const lean = [(rand() - 0.5) * 0.08 * H, (rand() - 0.5) * 0.08 * H];
  const trunkTop = [base[0] + lean[0], base[1] + lean[1], hb + crownH * 0.5];
  const trunk = [{ a: [base[0], base[1], 0], b: trunkTop, r0: rTrunk, r1: rTrunk * 0.55 }];
  const branches = [];
  const nb = 5 + Math.floor(rand() * 3);
  for (let i = 0; i < nb; i++) {
    const ang = (i / nb) * Math.PI * 2 + rand() * 0.6;
    const t = 0.15 + rand() * 0.75;
    const start = [base[0] + lean[0] * t, base[1] + lean[1] * t, hb * 0.85 + (trunkTop[2] - hb * 0.85) * t];
    const reach = 0.55 + rand() * 0.35;
    const end = [C[0] + Math.cos(ang) * Rh * reach, C[1] + Math.sin(ang) * Rh * reach, C[2] + (rand() - 0.25) * Rv * 0.9];
    branches.push({ a: start, b: end, r0: rTrunk * (0.45 - 0.15 * t), r1: rTrunk * 0.12 });
  }
  const blobs = [{ c: C, radii: [Rh * 0.62, Rh * 0.62, Rv * 0.62], tint: 0 }];
  const nBlobs = 13 + Math.floor(rand() * 5);
  for (let i = 0; i < nBlobs; i++) {
    // Spread clusters over the crown envelope, more of them in the upper half.
    const u = rand() * 2 - 1, phi = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const dir = [s * Math.cos(phi), s * Math.sin(phi), u * 0.8 + 0.15];
    const rr = Rh * (0.3 + rand() * 0.18);
    const reach = 0.55 + rand() * 0.35;
    const c = [C[0] + dir[0] * (Rh - rr * 0.5) * reach, C[1] + dir[1] * (Rh - rr * 0.5) * reach,
      clamp(C[2] + dir[2] * (Rv - rr * 0.4) * reach, hb + rr * 0.5, H - rr * 0.6)];
    blobs.push({ c, radii: [rr, rr, Math.min(rr * 0.9, Rv * 0.75)], tint: 1 + Math.floor(rand() * 3) });
  }
  const wood = [...trunk, ...branches].map((s) => ({ type: 'cylinder', a: s.a, b: s.b, r: (s.r0 + s.r1) / 2, opacity: 1 }));
  const leaves = blobs.map((b) => ({ type: 'ellipsoid', c: b.c, radii: b.radii, opacity: clamp(density) }));
  const primitives = [...wood, ...leaves];
  return { kind: 'tree', primitives, bounds: boundsOf(primitives), render: { trunk, branches, blobs, seed } };
}

/** A wooden utility pole with one or two cross-arms. */
export function buildPole({ base, height, diameter = 0.3, crossArms = null, armAxis = [1, 0, 0] }) {
  const r = diameter / 2;
  const prims = [{ type: 'cylinder', a: [base[0], base[1], 0], b: [base[0], base[1], height], r, opacity: 1 }];
  const arms = crossArms ?? [height - 0.6];
  const side = normalize(cross([0, 0, 1], armAxis));
  for (const z of arms) {
    prims.push({ type: 'box', c: [base[0], base[1], z], ax: [normalize(armAxis), side, [0, 0, 1]], h: [1.2, 0.05, 0.05], opacity: 1 });
  }
  return { kind: 'pole', primitives: prims, bounds: boundsOf(prims), render: { base, height, r, arms, armAxis } };
}

/**
 * An overhang (awning, eave or large branch) above a frame's upper edge.
 * projection: how far it reaches out in front of the upper edge (m, horizontal);
 * clearance: vertical gap above the upper edge (m); width: along the frame (m); offset: sideways (m).
 */
export function buildOverhang({ frame, projection, clearance, width, offset = 0, thickness = 0.1 }) {
  const { forward, right } = frameBasis(frame);
  const top = frame.upperMid;
  const back = 0.25; // starts a little behind the upper edge
  const depth = projection + back;
  const centre = add(add(top, scale(forward, projection - depth / 2)), add(scale(right, offset), [0, 0, clearance + thickness / 2]));
  const slab = { type: 'box', c: centre, ax: [right, forward, [0, 0, 1]], h: [width / 2, depth / 2, thickness / 2], opacity: 1 };
  const posts = [-1, 1].map((sgn) => {
    const foot = add(add(top, scale(forward, -back + 0.05)), scale(right, offset + sgn * (width / 2 - 0.06)));
    return { type: 'cylinder', a: [foot[0], foot[1], 0], b: [foot[0], foot[1], centre[2] - thickness / 2], r: 0.05, opacity: 1 };
  });
  const primitives = [slab, ...posts];
  return { kind: 'overhang', primitives, bounds: boundsOf(primitives), render: { slab, posts } };
}

/** Ground position `distance` m in front of a frame's lower edge and `offset` m to its east (right). */
export function groundPointInFront(frame, distance, offset) {
  const { forward, right } = frameBasis(frame);
  const p = add(frame.lowerMid, add(scale(forward, distance), scale(right, offset)));
  return [p[0], p[1], 0];
}

/** Inverse of groundPointInFront: distance/offset of a ground point relative to a frame. */
export function frontCoordinates(frame, p) {
  const { forward, right } = frameBasis(frame);
  const d = sub([p[0], p[1], 0], [frame.lowerMid[0], frame.lowerMid[1], 0]);
  return { distance: dot(d, forward), offset: dot(d, right) };
}

/** Build the obstruction described by UI settings. Returns [] when there is none. */
export function buildObstructions(settings, frames, surroundings) {
  const list = [];
  const frame = frames.find((f) => f.id === settings.anchor) ?? frames[0];
  const o = settings.object;
  if (o.type === 'tree') {
    list.push(buildTree({ base: groundPointInFront(frame, o.distance, o.offset), height: o.height,
      crownWidth: o.crownWidth, crownBase: o.crownBase, density: o.density, seed: o.seed ?? 7 }));
  } else if (o.type === 'pole') {
    list.push(buildPole({ base: groundPointInFront(frame, o.distance, o.offset), height: o.height, diameter: o.diameter,
      armAxis: frameBasis(frame).right }));
  } else if (o.type === 'overhang') {
    list.push(buildOverhang({ frame, projection: o.projection, clearance: o.clearance, width: o.width, offset: o.offset }));
  }
  if (settings.includeScannedPole && surroundings) {
    const p = surroundings.powerPole;
    const pole = buildPole({ base: [p.x, p.y, 0], height: p.height, diameter: 0.3, crossArms: p.crossArms, armAxis: [1, 0, 0] });
    pole.scanned = true;
    list.push(pole);
  }
  return list;
}
