// RFS Shading Simulator: UI wiring.
import { calibrate, prepare, simulateDay, instant, clock, RATING_LEVELS } from './simulate.js';
import { decodeScan } from './site.js';
import { powerChart, hourlyChart } from './charts.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : '–');

// ---------- Settings ----------

const OBJECT_FIELDS = {
  tree: [
    ['height', 'Tree height', 1, 15, 0.1, 'm'], ['crownWidth', 'Crown width', 0.5, 10, 0.1, 'm'],
    ['crownBase', 'Crown starts at', 0.2, 6, 0.1, 'm'], ['distance', 'Distance in front of lower edge', -10, 15, 0.1, 'm'],
    ['offset', 'Sideways offset (east +)', -8, 8, 0.1, 'm'], ['density', 'Canopy density', 0.2, 1, 0.05, '%'],
  ],
  pole: [
    ['height', 'Pole height', 1, 15, 0.1, 'm'], ['diameter', 'Diameter', 0.1, 0.8, 0.01, 'm'],
    ['distance', 'Distance in front of lower edge', -10, 15, 0.1, 'm'], ['offset', 'Sideways offset (east +)', -8, 8, 0.1, 'm'],
  ],
  overhang: [
    ['projection', 'Reach in front of upper edge', 0.1, 2.5, 0.05, 'm'], ['clearance', 'Gap above upper edge', 0, 2, 0.05, 'm'],
    ['width', 'Width', 0.5, 5, 0.05, 'm'], ['offset', 'Sideways offset (east +)', -4, 4, 0.05, 'm'],
  ],
};

const objects = {
  tree: { height: 3.8, crownWidth: 2.2, crownBase: 0.9, distance: 2.5, offset: 0, density: 0.75, seed: 7 },
  pole: { height: 6, diameter: 0.3, distance: 3, offset: 0 },
  overhang: { projection: 0.7, clearance: 0.25, width: 2.9, offset: 0 },
};

const PRESETS = [
  { id: 'S0', title: 'S0 · Unshaded', text: 'No obstruction', apply: () => ({ type: 'none', curtail: false }) },
  { id: 'S1', title: 'S1 · Small tree', text: 'In front of lower edge', apply: () => ({ type: 'tree', tree: { height: 3.8, crownWidth: 2.2, crownBase: 0.9, distance: 2.5, offset: 0, density: 0.75 } }) },
  { id: 'S2', title: 'S2 · Large tree', text: 'In front of lower edge', apply: () => ({ type: 'tree', tree: { height: 5.5, crownWidth: 3.6, crownBase: 1.2, distance: 3.0, offset: 0, density: 0.8 } }) },
  { id: 'S3', title: 'S3 · Overhang', text: 'Above upper edge', apply: () => ({ type: 'overhang', overhang: { projection: 0.7, clearance: 0.25, width: 2.9, offset: 0 } }) },
  { id: 'S4', title: 'S4 · Constraint', text: 'Battery full, no shade', apply: () => ({ type: 'none', curtail: true }) },
  { id: 'S5', title: 'S5 · No shadow', text: 'Tree behind the array', apply: () => ({ type: 'tree', tree: { height: 3.5, crownWidth: 2.6, crownBase: 1.0, distance: -6, offset: 0, density: 0.8 } }) },
];

function todayInLA() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const state = {
  ctx: null, scene: null, prep: null, prepKey: '', frameKey: '', day: null, instant: null,
  preset: 'S1', lastRating: null, interacted: false, playing: null, lidar: new Map(),
  settings: {
    date: todayInLA(), minute: 13 * 60, session: '2026091401', testFrame: 'B', frameRatio: 0.99, anchor: 'B',
    stripeDirection: 'slope', windowElevation: 20, thresholds: [10, 20, 30], includeScannedPole: false,
    curtail: { enabled: false, fromMinute: 14 * 60, capKw: 0.04 }, object: { type: 'tree', ...objects.tree },
  },
};

// ---------- Startup ----------

async function loadJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status}). Serve the docs/ folder over HTTP.`);
  return r.json();
}

async function start() {
  const [site, meta, record] = await Promise.all([loadJson('data/site.json'), loadJson('data/scan-meta.json'),
    loadJson('data/goodwe-2026-08-19.json')]);
  const cal = calibrate(site, meta, record);
  state.ctx = { site, meta, record, k: cal.k, cal };
  const s = state.settings;
  s.frameRatio = site.frameRatioDefault; s.windowElevation = site.testedWindowElevationDeg; s.thresholds = [...site.ratingThresholdsPct];
  s.session = meta.baseline;

  $('session').innerHTML = Object.entries(meta.sessions).map(([id, v]) => `<option value="${id}">${v.label}</option>`).join('');
  const calText = `Production is scaled by k = ${fmt(cal.k * 1000, 0)} W per kW/m² of plane-of-array irradiance, fitted by least squares to the ${cal.n} ten-minute inverter readings between ${site.calibration.window[0]} and ${site.calibration.window[1]} on 19 Aug 2026 (one two-module string, RMSE ${fmt(cal.rmseW, 0)} W). Outside that window the off-grid system clamped the string near 35 W, so the rest of that day is not used. The test frame is k̂ × the reference frame; both frames use their own scanned tilt.`;
  $('calnote').textContent = `k = ${fmt(cal.k, 3)} W per W/m², from the 19 Aug inverter record (${cal.n} readings, RMSE ${fmt(cal.rmseW, 0)} W).`;
  $('about-cal').textContent = calText;

  try {
    const { Scene3D } = await import('./scene.js');
    state.scene = new Scene3D($('viewport'), { onObjectDrag: onDrag, onObjectDragEnd: () => scheduleDay(0) });
  } catch (e) {
    console.error(e);
    $('loading').textContent = '3D view unavailable in this browser (WebGL). Charts and results still work.';
  }
  buildPresetButtons();
  bindControls();
  applyUrlParams();
  syncControls();
  recompute({ full: true });
  state.interacted = false;
  if (state.scene) $('loading').hidden = true;
  if (state.pendingView) { document.querySelector(`.views [data-view="${state.pendingView}"]`)?.click(); }
  if (state.pendingLidar) { $('opt-lidar').checked = true; await showLidar(); }
  loadEnvironment();
}

async function loadEnvironment() {
  if (!state.scene) return;
  $('envstatus').hidden = false;
  try {
    const [meta, terrain, points] = await Promise.all([
      loadJson('data/env-meta.json'),
      fetch('data/env-terrain.bin').then((r) => { if (!r.ok) throw new Error('terrain'); return r.arrayBuffer(); }),
      fetch('data/env-points.bin').then((r) => { if (!r.ok) throw new Error('points'); return r.arrayBuffer(); }),
    ]);
    state.scene.setEnvironment(meta, terrain, points);
    state.scene.setOptions({ scenery: $('opt-scenery').checked });
  } catch (e) {
    console.error(e);
    toast('amber', 'Surroundings unavailable', 'The scanned surroundings could not be loaded; the frames and results still work.');
  }
  $('envstatus').hidden = true;
}

// Shareable links, e.g. ?preset=S2&date=2026-12-21&time=10:30&view=sun&heat=1&lidar=1&session=2026091402
function applyUrlParams() {
  const q = new URLSearchParams(location.search), s = state.settings;
  if (q.get('preset') && PRESETS.some((p) => p.id === q.get('preset'))) {
    const p = PRESETS.find((x) => x.id === q.get('preset')).apply();
    state.preset = q.get('preset');
    if (p.tree) Object.assign(objects.tree, p.tree);
    if (p.overhang) Object.assign(objects.overhang, p.overhang);
    s.curtail.enabled = !!p.curtail;
    s.object = p.type === 'none' ? { type: 'none' } : { type: p.type, ...objects[p.type] };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('date') ?? '')) s.date = q.get('date');
  const t = (q.get('time') ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (t) s.minute = Math.min(1439, Number(t[1]) * 60 + Number(t[2]));
  if (state.ctx.meta.sessions[q.get('session')]) s.session = q.get('session');
  if (q.get('heat') === '1') { $('opt-heat').checked = true; state.scene?.setOptions({ heatmap: true }); }
  if (q.get('rays') === '0') { $('opt-rays').checked = false; state.scene?.setOptions({ rays: false }); }
  if (q.get('scenery') === '0') { $('opt-scenery').checked = false; state.scene?.setOptions({ scenery: false }); }
  state.pendingView = q.get('view');
  state.pendingLidar = q.get('lidar') === '1';
}

// ---------- Compute pipeline ----------

let dayTimer = null;
function scheduleDay(delay = 0) {
  clearTimeout(dayTimer);
  dayTimer = setTimeout(() => { runDay(); renderInstant(); }, delay);
}

function recompute({ full = false, dayDelay = 0 } = {}) {
  const s = state.settings;
  const prepKey = JSON.stringify([s.session, s.anchor, s.object, s.includeScannedPole, s.stripeDirection]);
  if (prepKey !== state.prepKey) {
    state.prep = prepare(state.ctx, s);
    state.prepKey = prepKey;
    const frameKey = JSON.stringify([s.session, s.testFrame, s.stripeDirection]);
    if (state.scene) {
      if (frameKey !== state.frameKey) { state.scene.setFrames(state.prep.frames, s, state.ctx.site.racks); state.frameKey = frameKey; }
      state.scene.setObstructions(state.prep.obstructions, s);
    }
  } else if (state.scene) {
    const frameKey = JSON.stringify([s.session, s.testFrame, s.stripeDirection]);
    if (frameKey !== state.frameKey) { state.scene.setFrames(state.prep.frames, s, state.ctx.site.racks); state.frameKey = frameKey; }
  }
  if (full || dayDelay === 0) { runDay(); renderInstant(); } else { renderInstant(); scheduleDay(dayDelay); }
}

function runDay() {
  state.day = simulateDay(state.ctx, state.prep, state.settings);
  renderDay();
  checkRating();
}

// ---------- Rendering ----------

function renderInstant() {
  const s = state.settings, data = instant(state.ctx, state.prep, s, s.minute);
  state.instant = data;
  const sun = data.sun;
  if (state.scene) {
    state.scene.setSun(sun, s.date);
    state.scene.setRays(sun, state.prep.frames, state.prep.obstructions, s.anchor);
    state.scene.setHeatmap(data);
  }
  $('clock').textContent = clock(s.minute);
  $('time').value = s.minute;
  const dateLabel = new Date(`${s.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(sun.azimuth / 45) % 8];
  $('hud-time').innerHTML = `<strong>${clock(s.minute)}</strong> <span class="sub">Pacific time</span><div class="sub">${dateLabel}</div>
    <div class="sub">${sun.apparentElevation > 0 ? `Sun ${fmt(sun.apparentElevation, 1)}° high · ${fmt(sun.azimuth, 0)}° (${dir})` : 'Sun below the horizon'}</div>`;
  for (const f of state.prep.frames) {
    const r = data.frames[f.id];
    const role = f.id === s.testFrame ? 'test frame' : 'reference';
    const pct = r.p0 > 1e-6 ? 100 * r.p / r.p0 : 100;
    const lossTxt = r.p0 > 1e-6 && r.p0 - r.p > 1e-5 ? `<b>${fmt(100 - pct, 0)}%</b> below unshaded` : 'No loss right now';
    $(`card-${f.id}`).innerHTML = `<h3><span>Frame ${f.id} · ${role}</span><span>${fmt(f.scanTilt, 1)}° tilt</span></h3>
      <div class="value">${fmt(r.p * 1000, 0)} <small>W now</small></div>
      <div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:var(--frame-${f.id.toLowerCase()})"></i></div>
      <div class="meta">Unshaded ${fmt(r.p0 * 1000, 0)} W · ${lossTxt}${r.shadedArea > 0.001 ? ` · ${fmt(100 * r.shadedArea, 0)}% of area shaded` : ''}${r.operatingLoss > 1e-5 ? ' · capped by operating constraint' : ''}</div>`;
  }
  const chartData = powerChart({ day: state.day, minute: s.minute, record: s.date === state.ctx.record.date ? state.ctx.record : null, ids: ['A', 'B'] });
  $('power-chart').innerHTML = chartData.svg;
  state.chartToMinute = chartData.toMinute;
  $('rec-legend').hidden = s.date !== state.ctx.record.date;
}

function renderDay() {
  const d = state.day, s = state.settings;
  const w = d.window;
  const band = $('wband');
  if (w) { band.hidden = false; band.style.left = `${(w.start / 1439) * 100}%`; band.style.width = `${((w.end - w.start) / 1439) * 100}%`; }
  else band.hidden = true;
  const ids = ['A', 'B'];
  const rows = ids.map((id) => {
    const x = d.day[id].window;
    return `<span>Frame ${id} E<sub>0,W</sub></span><span>${fmt(x.e0, 2)} kWh</span><span>Frame ${id} Q<sub>W</sub></span><span>${fmt(x.q, 3)} kWh <span class="pill ${d.day[id].rating.key}">${fmt(x.pct, 1)}%</span></span>`;
  }).join('');
  const op = ids.some((id) => d.day[id].window.qOperating > 1e-4);
  $('card-day').innerHTML = `<h3><span>Daily view · tested window</span><span>${w ? `${clock(w.start)}–${clock(w.end)}` : 'none'}</span></h3>
    <div class="value">${fmt(d.pct, 1)}<small>% daily loss (Frame ${d.worstFrame})</small></div>
    <div class="kv">${rows}</div>
    <div class="meta" style="margin-top:6px">Whole-day unshaded: A ${fmt(d.day.A.all.e0, 2)} · B ${fmt(d.day.B.all.e0, 2)} kWh${op ? ' · includes operating-constraint loss' : ''}</div>`;
  const r = d.rating;
  $('rating').className = `rating ${r.key}`;
  $('rating').innerHTML = `<div class="big">${fmt(d.pct, 1)}%</div><div class="lbl">${r.label}</div><div class="sub">Daily loss, Frame ${d.worstFrame} · limits ${s.thresholds.join(' / ')}%</div>`;
  $('hourly-chart').innerHTML = hourlyChart({ day: d, ids });
  const hours = [];
  for (let h = 0; h < 24; h++) if (ids.some((id) => d.day[id].hours[h].e0 > 1e-6)) hours.push(h);
  const cell = (hr) => `<td>${fmt(hr.e0, 3)}</td><td>${fmt(hr.q, 3)}</td><td>${hr.e0 > 0 ? fmt((100 * hr.q) / hr.e0, 1) : '–'}%</td>`;
  $('hourly-table').innerHTML = `<thead><tr><th>Hour</th><th>A E<sub>0,1h</sub></th><th>A Q<sub>1h</sub></th><th>A %</th><th>B E<sub>0,1h</sub></th><th>B Q<sub>1h</sub></th><th>B %</th></tr></thead><tbody>${
    hours.map((h) => `<tr><td>${clock(h * 60)}–${clock(h * 60 + 60)}</td>${cell(d.day.A.hours[h])}${cell(d.day.B.hours[h])}</tr>`).join('')
  }<tr class="total"><td>Window total (kWh)</td>${cell(d.day.A.window)}${cell(d.day.B.window)}</tr></tbody>`;
}

function checkRating() {
  const r = state.day.rating;
  if (state.lastRating !== null && state.interacted && r.index !== state.lastRating) {
    const up = r.index > state.lastRating;
    const msg = r.index === 0 ? 'Back below the first limit: no serious impairment.'
      : `${up ? 'Crossed' : 'Down to'} the ${RATING_LEVELS[r.index].key} limit (${state.settings.thresholds[r.index - 1]}%).`;
    toast(r.key, `${fmt(state.day.pct, 1)}% daily loss · ${r.label}`, `${msg} Frame ${state.day.worstFrame}, tested window.`);
  }
  state.lastRating = r.index;
}

function toast(level, title, body) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<div><b>${title}</b>${body}</div><button type="button" aria-label="Dismiss">×</button>`;
  el.querySelector('button').onclick = () => el.remove();
  const wrap = $('toasts');
  while (wrap.children.length > 1) wrap.firstChild.remove();
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------- Controls ----------

function buildPresetButtons() {
  $('presets').innerHTML = PRESETS.map((p) => `<button type="button" class="preset" data-preset="${p.id}"><b>${p.title}</b><span>${p.text}</span></button>`).join('');
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    applyPreset(b.dataset.preset);
  });
}

function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id).apply();
  const s = state.settings;
  state.preset = id;
  state.interacted = true;
  if (p.tree) Object.assign(objects.tree, p.tree);
  if (p.overhang) Object.assign(objects.overhang, p.overhang);
  s.curtail.enabled = !!p.curtail;
  s.object = p.type === 'none' ? { type: 'none' } : { type: p.type, ...objects[p.type] };
  s.anchor = s.testFrame;
  syncControls();
  recompute({ full: true });
}

function buildObjectFields() {
  const type = state.settings.object.type;
  const fields = OBJECT_FIELDS[type] ?? [];
  $('objfields').innerHTML = fields.map(([key, label, min, max, step, unit]) => `
    <div class="field"><div class="label-line"><label for="f-${key}">${label}</label><output id="o-${key}"></output></div>
    <input type="range" id="f-${key}" data-key="${key}" data-unit="${unit}" min="${min}" max="${max}" step="${step}"></div>`).join('');
  $('reseed').hidden = type !== 'tree';
  $('objhint').hidden = type === 'none';
  $('anchor').disabled = type === 'none';
}

function syncObjectFields() {
  const o = state.settings.object;
  for (const input of $('objfields').querySelectorAll('input')) {
    const key = input.dataset.key;
    input.value = o[key];
    $(`o-${key}`).textContent = input.dataset.unit === '%' ? `${Math.round(o[key] * 100)}%` : `${fmt(o[key], 2)} m`;
  }
}

function syncControls() {
  const s = state.settings;
  $('date').value = s.date;
  $('time').value = s.minute;
  for (const b of $('objtype').querySelectorAll('button')) b.classList.toggle('selected', b.dataset.type === s.object.type);
  for (const b of $('presets').querySelectorAll('.preset')) b.classList.toggle('selected', b.dataset.preset === state.preset);
  buildObjectFields(); syncObjectFields();
  $('anchor').value = s.anchor; $('session').value = s.session; $('testframe').value = s.testFrame;
  $('kratio').value = s.frameRatio; $('kratio-out').textContent = fmt(s.frameRatio, 3);
  [$('t1').value, $('t2').value, $('t3').value] = s.thresholds; $('welev').value = s.windowElevation;
  $('stripes').value = s.stripeDirection; $('opt-pole').checked = s.includeScannedPole;
  $('curt-on').checked = s.curtail.enabled; $('curt-from').value = clock(s.curtail.fromMinute); $('curt-cap').value = s.curtail.capKw;
}

function changed({ dayDelay = 0, preset = 'custom' } = {}) {
  state.interacted = true;
  if (preset) state.preset = preset;
  for (const b of $('presets').querySelectorAll('.preset')) b.classList.toggle('selected', b.dataset.preset === state.preset);
  recompute({ dayDelay });
}

function onDrag({ dDistance, dOffset }) {
  const s = state.settings, o = s.object;
  if (o.type === 'none') return;
  const spec = Object.fromEntries(OBJECT_FIELDS[o.type].map((f) => [f[0], f]));
  if (o.type !== 'overhang' && spec.distance) o.distance = Math.min(spec.distance[3], Math.max(spec.distance[2], o.distance + dDistance));
  o.offset = Math.min(spec.offset[3], Math.max(spec.offset[2], o.offset + dOffset));
  Object.assign(objects[o.type], o);
  syncObjectFields();
  changed({ dayDelay: 140 });
}

function stopPlay() { clearInterval(state.playing); state.playing = null; $('play').textContent = '▶'; }

function bindControls() {
  const s = state.settings;
  $('date').addEventListener('change', () => { if ($('date').value) { s.date = $('date').value; changed({ preset: null }); } });
  $('today').onclick = () => { s.date = todayInLA(); syncControls(); changed({ preset: null }); };
  $('calday').onclick = () => { s.date = state.ctx.record.date; syncControls(); changed({ preset: null }); };
  $('time').addEventListener('input', () => { s.minute = Number($('time').value); stopPlay(); renderInstant(); });
  $('objtype').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const t = b.dataset.type;
    s.object = t === 'none' ? { type: 'none' } : { type: t, ...objects[t] };
    syncControls(); changed();
  });
  $('objfields').addEventListener('input', (e) => {
    const key = e.target.dataset.key; if (!key) return;
    s.object[key] = Number(e.target.value);
    Object.assign(objects[s.object.type], s.object);
    syncObjectFields(); changed({ dayDelay: 120 });
  });
  $('objfields').addEventListener('change', () => scheduleDay(0));
  $('reseed').onclick = () => { objects.tree.seed = (objects.tree.seed % 997) + 13; s.object.seed = objects.tree.seed; changed(); };
  $('anchor').onchange = () => { s.anchor = $('anchor').value; changed(); };
  $('session').onchange = async () => { s.session = $('session').value; changed({ preset: null }); if ($('opt-lidar').checked) await showLidar(); };
  $('testframe').onchange = () => { s.testFrame = $('testframe').value; s.anchor = s.testFrame; syncControls(); changed({ preset: null }); };
  $('kratio').addEventListener('input', () => { s.frameRatio = Number($('kratio').value); $('kratio-out').textContent = fmt(s.frameRatio, 3); changed({ dayDelay: 80, preset: null }); });
  for (const [id, i] of [['t1', 0], ['t2', 1], ['t3', 2]]) {
    $(id).addEventListener('change', () => {
      const v = Number($(id).value);
      if (!Number.isFinite(v)) return;
      s.thresholds[i] = Math.max(0, Math.min(100, v));
      s.thresholds.sort((a, b) => a - b);
      syncControls(); changed({ preset: null });
    });
  }
  $('welev').addEventListener('change', () => { const v = Number($('welev').value); if (Number.isFinite(v)) { s.windowElevation = Math.max(0, Math.min(60, v)); changed({ preset: null }); } });
  $('stripes').onchange = () => { s.stripeDirection = $('stripes').value; changed({ preset: null }); };
  $('curt-on').onchange = () => { s.curtail.enabled = $('curt-on').checked; changed(); };
  $('curt-from').onchange = () => { const [h, m] = $('curt-from').value.split(':').map(Number); if (Number.isFinite(h)) { s.curtail.fromMinute = h * 60 + (m || 0); changed(); } };
  $('curt-cap').onchange = () => { const v = Number($('curt-cap').value); if (Number.isFinite(v) && v >= 0) { s.curtail.capKw = v; changed(); } };
  $('opt-rays').onchange = () => { state.scene?.setOptions({ rays: $('opt-rays').checked }); renderInstant(); };
  $('opt-heat').onchange = () => { state.scene?.setOptions({ heatmap: $('opt-heat').checked }); renderInstant(); };
  $('opt-scenery').onchange = () => state.scene?.setOptions({ scenery: $('opt-scenery').checked });
  $('opt-lidar').onchange = async () => { if ($('opt-lidar').checked) await showLidar(); else state.scene?.setOptions({ lidar: false }); };
  $('opt-pole').onchange = () => { s.includeScannedPole = $('opt-pole').checked; changed({ preset: null }); };
  document.querySelector('.views').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !state.scene) return;
    for (const x of document.querySelectorAll('.views button')) x.classList.toggle('selected', x === b);
    state.scene.setView(b.dataset.view);
  });
  $('play').onclick = () => {
    if (state.playing) { stopPlay(); return; }
    const w = state.day.window ?? { start: 360, end: 1080 };
    if (s.minute >= w.end + 50 || s.minute < w.start - 70) s.minute = Math.max(0, w.start - 60);
    $('play').textContent = '❚❚';
    state.playing = setInterval(() => {
      s.minute = Math.min(1439, s.minute + 3);
      renderInstant();
      if (s.minute >= Math.min(1439, w.end + 60)) stopPlay();
    }, 40);
  };
  $('power-chart').addEventListener('pointerdown', (e) => {
    const svg = $('power-chart').querySelector('svg'); if (!svg || !state.chartToMinute) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    s.minute = Math.min(1439, state.chartToMinute(pt.x)); stopPlay(); renderInstant();
  });
  $('export-csv').onclick = exportCsv;
  $('export-json').onclick = exportJson;
}

async function showLidar() {
  const s = state.settings, session = state.ctx.meta.sessions[s.session];
  try {
    if (!state.lidar.has(s.session)) {
      const r = await fetch(`data/scan-${s.session}.bin`);
      if (!r.ok) throw new Error('Scan file not found');
      state.lidar.set(s.session, decodeScan(await r.arrayBuffer(), session));
    }
    state.scene?.setLidar(state.lidar.get(s.session));
    state.scene?.setOptions({ lidar: true });
  } catch (e) {
    console.error(e);
    toast('amber', 'LiDAR points unavailable', 'The scan file could not be loaded.');
    $('opt-lidar').checked = false;
  }
}

// ---------- Exports ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  const d = state.day, s = state.settings;
  const head = 'date,hour_start,in_tested_window,A_E0_kWh,A_Q_kWh,B_E0_kWh,B_Q_kWh,basis';
  const lines = [];
  for (let h = 0; h < 24; h++) {
    const a = d.day.A.hours[h], b = d.day.B.hours[h];
    if (a.e0 < 1e-6 && b.e0 < 1e-6) continue;
    lines.push([s.date, clock(h * 60), 'yes', a.e0.toFixed(4), a.q.toFixed(4), b.e0.toFixed(4), b.q.toFixed(4), 'illustrative clear-sky simulation'].join(','));
  }
  download(`RFS_hourly_${s.date}.csv`, `${head}\n${lines.join('\n')}\n`, 'text/csv');
}

function exportJson() {
  const d = state.day;
  const out = {
    tool: 'RFS Shading Simulator (illustrative planning tool, not validated results)',
    settings: state.settings, calibration: { k: state.ctx.k, rmseW: state.ctx.cal.rmseW, readings: state.ctx.cal.n },
    testedWindow: d.window, dailyLossPct: d.pct, rating: d.rating.key,
    frames: Object.fromEntries(['A', 'B'].map((id) => [id, { window: d.day[id].window, wholeDay: d.day[id].all }])),
  };
  download(`RFS_scenario_${state.settings.date}.json`, JSON.stringify(out, null, 2), 'application/json');
}

start().catch((e) => {
  console.error(e);
  $('fatal').hidden = false;
  $('fatal').textContent = e.message;
  $('loading').textContent = 'Could not start.';
});
