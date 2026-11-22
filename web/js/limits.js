// Обмеження швидкості там, де машина зараз: камера (її знак) або населений пункт (ПДР п. 12.4 — 50 км/год).
// Штраф за КУпАП ст. 122 — лише за перевищення більш ніж на 20 км/год, тож спідометр червоніє саме тоді.
// Межі населених пунктів беремо з довідника (центр + радіус за кількістю жителів) — обережно, щоб об'їзні не плутались.
import { S, hav, clamp } from './core.js';
import { pos } from './nav.js';
import { poi } from './poi.js';
import { pl, load } from './places.js';

export const TOWN_MAX = 50, FINE_OVER = 20;
let grid = null;
const cell = (la, lo) => Math.floor(la * 10) + ':' + Math.floor(lo * 10);
function buildGrid() {
  grid = new Map();
  for (const r of pl.rows) { const k = cell(r[0], r[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(r); }
}
// радіус забудови: місто 300 тис. ≈ 4 км, 20 тис. ≈ 1,2 км, село ≈ 0,5 км
export const townRadius = r => {
  const pop = +r[6] || 0;
  if (pop > 0) return clamp(0.25 + 0.007 * Math.sqrt(pop), 0.45, 12) * 1000;
  return (r[2] === 'c' ? 1.2 : r[2] === 't' ? 0.8 : 0.5) * 1000;
};
export function townAt(p) {
  if (!pl.ready) { load(); return null; }
  if (!grid) buildGrid();
  const la = Math.floor(p.lat * 10), lo = Math.floor(p.lon * 10);
  let best = null, bk = Infinity;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const list = grid.get((la + i) + ':' + (lo + j)); if (!list) continue;
    for (const r of list) {
      const d = hav(p, { lat: r[0], lon: r[1] }), R = townRadius(r);
      if (d <= R && d / R < bk) { bk = d / R; best = r; }
    }
  }
  return best;
}
let cache = { t: 0, lat: null, lon: null, town: null };
// → { max, src: 'cam' | 'town', name } або null, якщо обмеження не знаємо
export function limitNow() {
  const cam = S.cams !== false ? poi.nextCam : null;
  if (cam && cam.max && cam.ahead < 400 && cam.ahead > -150) return { max: cam.max, src: 'cam' };
  if (pos.lat == null) return null;
  const now = Date.now();
  if (now - cache.t > 3000 || cache.lat == null || hav(cache, pos) > 150) cache = { t: now, lat: pos.lat, lon: pos.lon, town: townAt(pos) };
  return cache.town ? { max: TOWN_MAX, src: 'town', name: cache.town[3] } : null;
}
export const overLimit = (kmh, lim) => !!lim && kmh > lim.max + FINE_OVER;
export function init() { load(); }
