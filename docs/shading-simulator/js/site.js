// Frame geometry taken directly from the 14 Sep 2026 LiDAR plane fits.
// Each session is rigidly registered (rotation about the vertical + horizontal shift) so that
// Frame A's lower-edge midpoint sits at the world origin and Frame A's plane faces due south.
// Tilts, heights and the A-B offset are therefore exactly as scanned.
import { add, sub, scale, dot, cross, length, normalize, DEG } from './vec.js';

/** Rigid transform that maps raw scan coordinates (m) of `session` to world coordinates. */
export function registration(session) {
  const a = session.units.find((u) => u.id === 'A');
  const lowMid = scale(add(a.corners[0], a.corners[1]), 0.5);
  const face = normalize([a.normal[0], a.normal[1], 0]);
  // Rotate the horizontal facing direction onto south (0, -1).
  const angle = Math.atan2(-1, 0) - Math.atan2(face[1], face[0]);
  const c = Math.cos(angle), s = Math.sin(angle);
  const apply = (p) => {
    const x = p[0] - lowMid[0], y = p[1] - lowMid[1];
    return [x * c - y * s, x * s + y * c, p[2]];
  };
  return { angleDeg: angle / DEG, origin: lowMid, cos: c, sin: s, apply };
}

/**
 * Frames of a session in world coordinates. Corner order follows the plane fit:
 * 0 lower-west, 1 lower-east, 2 upper-east, 3 upper-west.
 */
export function sessionFrames(meta, sessionId, module) {
  const session = meta.sessions[sessionId];
  if (!session) throw new Error(`Unknown scan session ${sessionId}`);
  const reg = registration(session);
  return session.units.map((u) => {
    let corners = u.corners.map(reg.apply);
    // Make sure corner 0 is the west end of the lower edge.
    if (corners[1][0] < corners[0][0]) corners = [corners[1], corners[0], corners[3], corners[2]];
    const acrossVec = sub(corners[1], corners[0]);
    const upVec = sub(corners[3], corners[0]);
    const width = length(acrossVec), slope = length(upVec);
    const across = normalize(acrossVec), up = normalize(upVec);
    let normal = normalize(cross(across, up));
    if (normal[2] < 0) normal = scale(normal, -1);
    const tilt = Math.acos(normal[2]) / DEG;
    const azimuth = ((Math.atan2(normal[0], normal[1]) / DEG) + 360) % 360;
    // Two portrait modules flush with the fitted outline; whatever is left over is the centre gap.
    const mw = module.widthM, ml = module.lengthM;
    const gap = Math.max(0, width - 2 * mw);
    const v0 = Math.max(0, (slope - ml) / 2);
    const modules = [
      { index: 0, u0: 0, u1: Math.min(mw, width / 2), v0, v1: v0 + Math.min(ml, slope) },
      { index: 1, u0: Math.max(width - mw, width / 2), u1: width, v0, v1: v0 + Math.min(ml, slope) },
    ];
    const point = (uu, vv) => add(corners[0], add(scale(across, uu), scale(up, vv)));
    // Centre pivot: the frames tilt about a horizontal axis at mid-slope (consistent with the
    // three sessions, where Frame B's lower edge moves as if pivoting about its mid-height).
    const pivot = point(width / 2, slope / 2);
    return {
      id: u.id, role: u.role, scanTilt: u.tilt, rmseMm: u.rmse_mm, tilt, azimuth,
      corners, across, up, normal, width, slope, gap, modules, point, pivot,
      lowerMid: point(width / 2, 0), upperMid: point(width / 2, slope),
    };
  });
}

/** Local (u across, v up-slope, w along normal) coordinates of a world point relative to a frame. */
export function toFrame(frame, p) {
  const d = sub(p, frame.corners[0]);
  return [dot(d, frame.across), dot(d, frame.up), dot(d, frame.normal)];
}

/** Horizontal basis of a frame: forward = horizontal facing direction, right = along the lower edge (east). */
export function frameBasis(frame) {
  const forward = normalize([frame.normal[0], frame.normal[1], 0]);
  const right = normalize([frame.across[0], frame.across[1], 0]);
  return { forward, right };
}

/** Decode a scan binary (int16 mm xyz, then uint8 class) into world-space Float32 positions. */
export function decodeScan(buffer, session) {
  const n = session.pointCount;
  if (buffer.byteLength !== n * 7) throw new Error('Scan file has an unexpected size.');
  const reg = registration(session);
  const view = new DataView(buffer);
  const positions = new Float32Array(n * 3);
  const classes = new Uint8Array(buffer, n * 6, n);
  for (let i = 0; i < n; i++) {
    const x = view.getInt16(i * 6, true) / 1000, y = view.getInt16(i * 6 + 2, true) / 1000;
    const z = view.getInt16(i * 6 + 4, true) / 1000;
    const dx = x - reg.origin[0], dy = y - reg.origin[1];
    positions[i * 3] = dx * reg.cos - dy * reg.sin;
    positions[i * 3 + 1] = dx * reg.sin + dy * reg.cos;
    positions[i * 3 + 2] = z;
  }
  return { positions, classes, count: n };
}

// Scanned power pole (registered baseline scan): the only surrounding object that can optionally cast
// shadows in the calculation. The rest of the surroundings are drawn from the raw scans (env-*.bin).
export const SCANNED_SURROUNDINGS = {
  powerPole: { x: 10.3, y: 0.8, height: 13.7, crossArms: [10.6, 13.2] },
};
