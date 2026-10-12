// Lightweight SVG charts (no library).
import { clock } from './simulate.js';

export const FRAME_COLORS = { A: 'var(--frame-a)', B: 'var(--frame-b)' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * Power through the day for both frames: dashed = unshaded, solid = with obstruction.
 * Shaded band = tested window. Dots = inverter record (only on its own date).
 */
export function powerChart({ day, minute, record, ids }) {
  const W = 900, H = 300, L = 52, R = 16, Tp = 26, B = 34, pw = W - L - R, ph = H - Tp - B;
  const daylight = day.items.filter((it) => it.sun.apparentElevation > -2);
  const m0 = Math.max(0, Math.floor((daylight[0]?.minute ?? 300) / 60) * 60 - 60);
  const m1 = Math.min(1440, Math.ceil((daylight.at(-1)?.minute ?? 1200) / 60) * 60 + 60);
  let ymax = 0;
  for (const it of day.items) for (const id of ids) ymax = Math.max(ymax, it.frames[id].p0);
  if (record) for (const r of record.rows) if (r.pvW != null) ymax = Math.max(ymax, r.pvW / 1000);
  ymax = niceMax(ymax * 1.08);
  const x = (m) => L + (pw * (m - m0)) / (m1 - m0), y = (p) => Tp + ph * (1 - p / ymax);
  let s = '';
  if (day.window) {
    s += `<rect x="${x(day.window.start)}" y="${Tp}" width="${x(day.window.end) - x(day.window.start)}" height="${ph}" class="band"/>`;
    s += `<text x="${(x(day.window.start) + x(day.window.end)) / 2}" y="${Tp - 9}" class="band-label" text-anchor="middle">Tested window ${clock(day.window.start)}–${clock(day.window.end)} (sun ≥ ${esc(day.windowElevation)}°)</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const v = (ymax * i) / 4;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${v.toFixed(2)}</text>`;
  }
  for (let m = m0; m <= m1; m += 120) s += `<text x="${x(m)}" y="${H - 10}" text-anchor="middle" class="tick">${clock(m)}</text>`;
  s += `<text x="${L}" y="14" class="axis-label">kW per frame</text>`;
  const items = day.items.filter((it) => it.minute >= m0 && it.minute <= m1);
  const path = (fn) => items.map((it, i) => `${i ? 'L' : 'M'}${x(it.minute).toFixed(1)} ${y(fn(it)).toFixed(1)}`).join('');
  for (const id of ids) {
    const area = items.map((it) => `${x(it.minute).toFixed(1)},${y(it.frames[id].p0).toFixed(1)}`)
      .concat(items.slice().reverse().map((it) => `${x(it.minute).toFixed(1)},${y(it.frames[id].p).toFixed(1)}`)).join(' ');
    s += `<polygon points="${area}" fill="${FRAME_COLORS[id]}" opacity="0.16"/>`;
    s += `<path d="${path((it) => it.frames[id].p0)}" fill="none" stroke="${FRAME_COLORS[id]}" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.8"/>`;
    s += `<path d="${path((it) => it.frames[id].p)}" fill="none" stroke="${FRAME_COLORS[id]}" stroke-width="2.4"/>`;
  }
  if (record) {
    for (const r of record.rows) {
      if (r.pvW == null) continue;
      const [h, mm] = r.time.split(':').map(Number), m = h * 60 + mm;
      if (m < m0 || m > m1) continue;
      s += `<circle cx="${x(m).toFixed(1)}" cy="${y(r.pvW / 1000).toFixed(1)}" r="2.2" class="record"><title>${r.time} · ${(r.pvW / 1000).toFixed(3)} kW measured</title></circle>`;
    }
  }
  s += `<line x1="${x(minute)}" x2="${x(minute)}" y1="${Tp}" y2="${Tp + ph}" class="cursor"/>`;
  return { svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Power of frames A and B through the day, with and without the obstruction">${s}</svg>`,
    toMinute: (px) => Math.round(Math.min(m1, Math.max(m0, m0 + ((px - L) / pw) * (m1 - m0)))), width: W };
}

/** Hourly shortfall Q_1h inside the tested window, both frames side by side. */
export function hourlyChart({ day, ids }) {
  const W = 900, H = 220, L = 52, R = 16, Tp = 18, B = 34, pw = W - L - R, ph = H - Tp - B;
  const hours = [];
  for (let h = 0; h < 24; h++) if (ids.some((id) => day.day[id].hours[h].e0 > 1e-6)) hours.push(h);
  if (!hours.length) return `<svg viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="tick">No tested-window hours on this date.</text></svg>`;
  let ymax = 0;
  for (const h of hours) for (const id of ids) ymax = Math.max(ymax, day.day[id].hours[h].q);
  ymax = niceMax(Math.max(ymax * 1.1, 0.02));
  const slot = pw / hours.length, bw = Math.min(26, (slot - 8) / ids.length);
  const y = (v) => Tp + ph * (1 - v / ymax);
  let s = '';
  for (let i = 0; i <= 4; i++) {
    const v = (ymax * i) / 4;
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${v.toFixed(3)}</text>`;
  }
  s += `<text x="${L}" y="12" class="axis-label">Q₁ₕ shortfall, kWh</text>`;
  hours.forEach((h, i) => {
    const cx = L + slot * (i + 0.5);
    ids.forEach((id, k) => {
      const hr = day.day[id].hours[h], bx = cx - (ids.length * bw) / 2 + k * bw;
      const pct = hr.e0 > 0 ? (100 * hr.q) / hr.e0 : 0;
      s += `<rect x="${bx.toFixed(1)}" y="${y(hr.q).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(Tp + ph - y(hr.q)).toFixed(1)}" fill="${FRAME_COLORS[id]}" rx="2"><title>Frame ${id}, ${clock(h * 60)}–${clock(h * 60 + 60)}: Q₁ₕ = ${hr.q.toFixed(3)} kWh of ${hr.e0.toFixed(3)} kWh (${pct.toFixed(1)}%)</title></rect>`;
    });
    s += `<text x="${cx}" y="${H - 12}" text-anchor="middle" class="tick">${String(h).padStart(2, '0')}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hourly shading shortfall inside the tested window">${s}</svg>`;
}
