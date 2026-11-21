// Лабораторія: якість покриття за датчиками телефона. Тряска (розкид прискорення за секунду) на ділянках ~90 м
// з поправкою на швидкість; так само оцінюють рівність дороги Roadroid і RoadLab Pro Світового банку.
// Самокалібрування: кожен телефон і кріплення трясуться по-своєму, тому ділянку порівнюємо з медіаною власних замірів.
import { bus, log, S, db } from './core.js';
import { pos } from './nav.js';

const CELL = 1 / 1250;                    // ≈ 89 м уздовж меридіана, ≈ 58 м уздовж паралелі
const MAX_CELLS = 60000, RES_MAX = 4000, CALIB_MIN = 300;
export const rg = { cells: new Map(), res: [], median: null, loaded: false, samples: 0 };
let dirty = false, lastSave = 0, lastDraw = 0;

const key = (lat, lon) => Math.round(lat / CELL) + ':' + Math.round(lon / CELL);
const cellCenter = k => { const [a, b] = k.split(':').map(Number); return { lat: a * CELL, lon: b * CELL }; };
export const calibrated = () => rg.res.length >= CALIB_MIN && rg.median > 0;
export const calibPct = () => Math.min(100, Math.round(rg.res.length / CALIB_MIN * 100));

// Одна секунда руху: місце, швидкість (м/с), розкид прискорення (м/с²)². Повертає нормовану тряску або null.
export function addSample(lat, lon, spd, v) {
  if (!(spd > 4.2) || !(v >= 0)) return null;            // повільніше ~15 км/год тряска нічого не каже про дорогу
  const norm = Math.sqrt(v) * 20 / Math.max(spd, 6);       // приводимо до ~72 км/год
  const k = key(lat, lon), now = Math.floor(Date.now() / 1000);
  let c = rg.cells.get(k);
  if (!c) { c = [0, 0, now]; rg.cells.set(k, c); }
  if (c[1] >= 30) c[0] *= 29 / 30; else c[1]++;           // ковзне середнє з 30 останніх проїздів-секунд
  c[0] += norm; c[2] = now;
  rg.res.push(norm); if (rg.res.length > RES_MAX) rg.res.splice(0, rg.res.length - RES_MAX);
  if (++rg.samples % 60 === 0 || rg.median == null) rg.median = median(rg.res);
  dirty = true;
  return norm;
}
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }
// Рівень ділянки: g — рівна, y — так собі, r — погана; null — замало даних або ще калібруємось.
export function levelOf(c) {
  if (!c || c[1] < 2 || !calibrated()) return null;
  const r = c[0] / c[1] / rg.median;
  return r < 1.35 ? 'g' : r < 2 ? 'y' : 'r';
}
export function stats() {
  let g = 0, y = 0, r = 0;
  for (const c of rg.cells.values()) { const l = levelOf(c); if (l === 'g') g++; else if (l === 'y') y++; else if (l === 'r') r++; }
  return { cells: rg.cells.size, km: Math.round(rg.cells.size * 0.075), g, y, r, calib: calibPct() };
}
export function geojson() {
  const f = [];
  if (calibrated()) for (const [k, c] of rg.cells) {
    const l = levelOf(c); if (!l) continue;
    const p = cellCenter(k);
    f.push({ type: 'Feature', properties: { l }, geometry: { type: 'Point', coordinates: [+p.lon.toFixed(5), +p.lat.toFixed(5)] } });
  }
  return { type: 'FeatureCollection', features: f };
}
// Погані ділянки на маршруті за власними замірами: скільки кілометрів і де перша.
export function badAlong(idx) {
  if (!idx || !calibrated()) return null;
  let bad = 0, first = null;
  for (let d = 0; d <= idx.total; d += 80) {
    const p = idx.at(d), l = levelOf(rg.cells.get(key(p.lat, p.lon)));
    if (l === 'r') { bad += 80; if (first == null) first = d; }
  }
  return bad >= 300 ? { m: bad, d: first } : null;
}
export function clear() { rg.cells.clear(); rg.res = []; rg.median = null; rg.samples = 0; dirty = true; save(true); bus.emit('rough'); }

async function save(force) {
  if (!dirty || (!force && Date.now() - lastSave < 60000)) return;
  lastSave = Date.now(); dirty = false;
  if (rg.cells.size > MAX_CELLS) {                        // найдавніші ділянки забуваємо
    const old = [...rg.cells].sort((a, b) => a[1][2] - b[1][2]).slice(0, rg.cells.size - MAX_CELLS);
    for (const [k] of old) rg.cells.delete(k);
  }
  try { await db.set('kv', 'rough', { v: 1, cells: [...rg.cells].map(([k, c]) => [k, +c[0].toFixed(3), c[1], c[2]]), res: rg.res.map(x => +x.toFixed(3)) }); }
  catch (e) { log('warn', 'заміри покриття: ' + e.message); }
}
async function load() {
  try {
    const j = await db.get('kv', 'rough');
    if (j && Array.isArray(j.cells)) { for (const [k, s, n, t] of j.cells) rg.cells.set(k, [s, n, t]); rg.res = j.res || []; rg.median = median(rg.res); }
  } catch (e) { log('warn', 'заміри покриття: ' + e.message); }
  rg.loaded = true; bus.emit('rough');
}

function onSens(s) {
  if (!S.rough || s.var == null || pos.mode !== 'gps' || !pos.raw || pos.sim) return;
  if (Date.now() - pos.raw.rt > 2500 || (pos.acc != null && pos.acc > 30)) return;
  addSample(pos.lat, pos.lon, pos.spd, s.var);
  const now = Date.now();
  if (S.roughMap && now - lastDraw > 30000) { lastDraw = now; bus.emit('rough'); }
  save(false);
}
export function init() {
  load();
  bus.on('sens', onSens);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
  setInterval(() => save(false), 60000);
}
