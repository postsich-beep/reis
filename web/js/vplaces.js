// Перевірені місця: власна картотека водіїв (поїсти, стати, помитись) — з фото, описом, цінами.
// Дані — web/data/verified.json (приходять з оновленням застосунку). Без переходу в Google Maps.
import { bus, log, S, hav } from './core.js';
import { pos } from './nav.js';
import { g } from './guide.js';
import { t } from './i18n.js';

export const vp = { ready: false, list: [], date: '' };
const LOC_KEY = 'reis.vpLoc';          // точка, яку водій сам поставив місцю без координат
let said = new Set(), lastCheck = 0;

const locs = () => { try { return JSON.parse(localStorage.getItem(LOC_KEY) || '{}'); } catch (_) { return {}; } };
export const txt = (v) => v == null ? '' : typeof v === 'string' ? v : (v[S.lang === 'ru' ? 'ru' : 'uk'] || v.uk || '');
export const onMap = p => p.lat != null && p.lon != null;

export async function load() {
  try {
    const r = await fetch('data/verified.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const own = locs();
    vp.list = (j.places || []).map(p => (p.lat == null && own[p.id] ? { ...p, lat: own[p.id].lat, lon: own[p.id].lon, own: true } : p));
    vp.date = j.date || ''; vp.ready = true;
    log('info', `перевірені місця: ${vp.list.length}`);
  } catch (e) { log('warn', 'перевірені місця: ' + e.message); }
  bus.emit('vplaces', vp);
}
export const byId = id => vp.list.find(p => p.id === id);

// Водій ставить місцю точку на карті (коли координат у базі ще немає)
export function setLocation(id, p) {
  const own = locs(); own[id] = { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) };
  try { localStorage.setItem(LOC_KEY, JSON.stringify(own)); } catch (_) {}
  const x = byId(id); if (x) { x.lat = own[id].lat; x.lon = own[id].lon; x.own = true; }
  bus.emit('vplaces', vp);
}

// Де місце відносно нас: по маршруту попереду («через N км») або по прямій («за N км»)
export function whereIs(p) {
  if (!onMap(p)) return null;
  if (g.active && g.idx && pos.rd != null) {
    const l = g.idx.locate(p, null);
    if (l && l.off < 1500) return { ahead: l.d - pos.rd, off: l.off, route: true };
  }
  if (pos.lat == null) return null;
  return { dist: hav(pos, p), route: false };
}
export function sorted() {
  return vp.list.slice().sort((a, b) => {
    const wa = whereIs(a), wb = whereIs(b);
    const ka = !wa ? 1e12 : wa.route ? (wa.ahead >= -500 ? wa.ahead : 5e11 - wa.ahead) : 1e9 + wa.dist;
    const kb = !wb ? 1e12 : wb.route ? (wb.ahead >= -500 ? wb.ahead : 5e11 - wb.ahead) : 1e9 + wb.dist;
    return ka - kb;
  });
}

// У дорозі: перевірене місце на маршруті за 25 км — одне повідомлення (голос і шторка)
function check() {
  const now = Date.now(); if (now - lastCheck < 15000) return; lastCheck = now;
  if (!vp.ready || !g.active || !g.idx || pos.rd == null) return;
  for (const p of vp.list) {
    const w = whereIs(p); if (!w || !w.route || w.off > 600 || w.ahead < 1500 || w.ahead > 25000) continue;
    const key = 'vp:' + p.id + ':' + (g.trip && g.trip.id);
    if (said.has(key)) continue; said.add(key);
    const km = Math.round(w.ahead / 1000);
    bus.emit('feedPush', { src: 'stop', level: 'green', key, lat: p.lat, lon: p.lon,
      text: t('vpAhead', p.name, t('vpKind_' + (p.kind || 'food')), km), voice: t('vpAheadVoice', p.name, km) });
  }
}
export function init() { load(); bus.on('pos', check); bus.on('settings', k => { if (k === 'lang') bus.emit('vplaces', vp); }); }
