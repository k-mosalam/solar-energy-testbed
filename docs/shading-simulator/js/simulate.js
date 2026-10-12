// Production and shading-loss simulation for the two RFS frames on a clear day.
import { localToUtc, sunPosition, clearSky, linkeTurbidity, dayOfYear, extraterrestrial, planeIrradiance } from './solar.js';
import { sessionFrames, SCANNED_SURROUNDINGS } from './site.js';
import { buildObstructions } from './obstructions.js';
import { moduleSamples, stripeTransmittance, skyBlocking, frameOutputRatio, sunInFront } from './shading.js';

export const RATING_LEVELS = [
  { key: 'green', label: 'No serious impairment' },
  { key: 'yellow', label: 'Noticeable loss' },
  { key: 'amber', label: 'Serious loss' },
  { key: 'red', label: 'Severe loss' },
];

/** Traffic-light rating of a daily loss percentage against three ascending thresholds (%). */
export function rateLoss(pct, thresholds) {
  const [t1, t2, t3] = thresholds;
  const index = pct >= t3 ? 3 : pct >= t2 ? 2 : pct >= t1 ? 1 : 0;
  return { index, ...RATING_LEVELS[index] };
}

export const clock = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Sun and clear-sky irradiance at a local time. */
export function skyAt(site, date, minute) {
  const utc = localToUtc(date, minute, site.timezone);
  const sun = sunPosition(utc, site.latitude, site.longitude);
  const doy = dayOfYear(date);
  const sky = clearSky(sun.zenith, doy, linkeTurbidity(date, site.linkeMonthly), site.altitudeM, extraterrestrial(doy));
  return { utc, sun, sky };
}

/**
 * Scale factor k (W of string output per W/m2 of plane-of-array irradiance) fitted by least squares
 * to the calibration window of the inverter record, using Frame A's baseline plane.
 */
export function calibrate(site, meta, record) {
  const cal = site.calibration;
  const frame = sessionFrames(meta, meta.baseline, site.module).find((f) => f.id === cal.frame);
  const [w0, w1] = cal.window.map(minutesOf);
  const rows = [];
  for (const r of record.rows) {
    const m = minutesOf(r.time);
    if (m < w0 || m > w1 || (m - w0) % cal.stepMinutes || r.pvW == null) continue;
    const { sun, sky } = skyAt(site, record.date, m);
    rows.push({ minute: m, measuredW: r.pvW, poa: planeIrradiance(frame.normal, sun, sky, site.albedo).total });
  }
  const k = rows.reduce((s, r) => s + r.measuredW * r.poa, 0) / rows.reduce((s, r) => s + r.poa * r.poa, 0);
  const rmseW = Math.sqrt(rows.reduce((s, r) => s + (r.measuredW - k * r.poa) ** 2, 0) / rows.length);
  return { k, rmseW, n: rows.length, rows };
}

/** Everything that does not change with the time of day, cached by the caller. */
export function prepare(ctx, settings) {
  const frames = sessionFrames(ctx.meta, settings.session, ctx.site.module);
  const obstructions = buildObstructions(settings, frames, SCANNED_SURROUNDINGS);
  const samples = Object.fromEntries(frames.map((f) => [f.id, moduleSamples(f, { direction: settings.stripeDirection })]));
  const sky = Object.fromEntries(frames.map((f) => [f.id, skyBlocking(f, obstructions)]));
  return { frames, obstructions, samples, skyBlock: sky };
}

function frameFactor(settings, id) {
  return id === settings.testFrame ? settings.frameRatio : 1;
}

/** Unshaded and shaded output of every frame at one instant. */
export function instant(ctx, prep, settings, minute) {
  const { sun, sky } = skyAt(ctx.site, settings.date, minute);
  const frames = {};
  for (const f of prep.frames) {
    const poa = planeIrradiance(f.normal, sun, sky, ctx.site.albedo);
    const p0 = ctx.k * frameFactor(settings, f.id) * poa.total / 1000;
    let stripeTau = null, out = { ratio: 1, areaRatio: 1, shadedArea: 0, weakest: null };
    if (prep.obstructions.length && poa.total > 0) {
      stripeTau = sunInFront(f, sun.vector)
        ? stripeTransmittance(prep.samples[f.id], sun.vector, prep.obstructions)
        : prep.samples[f.id].map((m) => m.stripes.map(() => 1));
      out = frameOutputRatio(poa, stripeTau, prep.skyBlock[f.id]);
    }
    const shaded = p0 * out.ratio;
    const curtailed = settings.curtail?.enabled && minute >= settings.curtail.fromMinute
      ? Math.min(shaded, settings.curtail.capKw) : shaded;
    frames[f.id] = { poa, p0, shaded, p: curtailed, shadingLoss: p0 - shaded, operatingLoss: shaded - curtailed,
      ratio: out.ratio, areaRatio: out.areaRatio, shadedArea: out.shadedArea, weakest: out.weakest, stripeTau };
  }
  return { minute, sun, sky, frames };
}

/**
 * Whole-day simulation on a fixed step. The tested window is where the sun's apparent elevation is
 * at least `windowElevation` degrees. Q_W = unshaded minus actual energy inside the window
 * (shading + operating shortfall), broken down into clock hours (Q_1h).
 */
export function simulateDay(ctx, prep, settings) {
  const step = ctx.site.stepMinutes;
  const items = [];
  for (let m = 0; m <= 1440; m += step) items.push(instant(ctx, prep, settings, m));
  const inWindow = items.map((it) => it.sun.apparentElevation >= settings.windowElevation);
  const first = inWindow.indexOf(true), last = inWindow.lastIndexOf(true);
  const window = first < 0 ? null : { start: items[first].minute, end: items[last].minute };
  const ids = prep.frames.map((f) => f.id);
  const zero = () => ({ e0: 0, e: 0, q: 0, qShading: 0, qOperating: 0 });
  const day = Object.fromEntries(ids.map((id) => [id, { all: zero(), window: zero(), hours: Array.from({ length: 24 }, zero) }]));
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i], dt = (b.minute - a.minute) / 60;
    const both = inWindow[i - 1] && inWindow[i];
    const hour = Math.floor(a.minute / 60);
    for (const id of ids) {
      const fa = a.frames[id], fb = b.frames[id];
      const seg = {
        e0: (fa.p0 + fb.p0) / 2 * dt, e: (fa.p + fb.p) / 2 * dt,
        qShading: (fa.shadingLoss + fb.shadingLoss) / 2 * dt, qOperating: (fa.operatingLoss + fb.operatingLoss) / 2 * dt,
      };
      seg.q = seg.e0 - seg.e;
      const targets = [day[id].all];
      if (both) targets.push(day[id].window, day[id].hours[hour]);
      for (const t of targets) for (const k of Object.keys(seg)) t[k] += seg[k];
    }
  }
  for (const id of ids) {
    const w = day[id].window;
    w.pct = w.e0 > 0 ? (100 * w.q) / w.e0 : 0;
    day[id].rating = rateLoss(w.pct, settings.thresholds);
  }
  // The headline rating follows the more affected frame.
  const worst = ids.reduce((a, b) => (day[b].window.pct > day[a].window.pct ? b : a), settings.testFrame);
  return { items, window, windowElevation: settings.windowElevation, day, worstFrame: worst,
    rating: day[worst].rating, pct: day[worst].window.pct };
}
