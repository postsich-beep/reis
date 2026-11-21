// Дороги очима фури: категорії доріг на маршруті (за номерами трас), проблемні місця з OpenStreetMap
// (мости з обмеженням маси, низькі проїзди, заборони для вантажівок, ґрунт, погане покриття)
// і правила, що залежать від часу: Київ у години пік. Дані місць — web/data/hazards.json (tools/build_osm.py).
import { bus, log, S, hav, RouteIndex } from './core.js';
import { pos } from './nav.js';
import { g, say, distWords } from './guide.js';
import { t } from './i18n.js';

export const hz = { ready: false, date: '', groups: [], pts: [], grid: null, count: 0 };
const CELL = 0.01;
let loading = null;

export function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await fetch('data/hazards.json', { cache: 'no-cache' });
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !Array.isArray(j.pts) || !Array.isArray(j.groups)) return;
      let pts = j.pts;
      if (j.v >= 2) {                              // плаский масив різниць: [dlat·1e5, dlon·1e5, напрям/5, dгрупа]
        pts = []; let la = 0, lo = 0, gid = 0;
        for (let i = 0; i + 3 < j.pts.length; i += 4) {
          la += j.pts[i]; lo += j.pts[i + 1]; gid += j.pts[i + 3];
          pts.push([la / 1e5, lo / 1e5, j.pts[i + 2] * 5, gid]);
        }
      }
      const grid = new Map();
      pts.forEach((p, i) => { const k = Math.floor(p[0] / CELL) + ':' + Math.floor(p[1] / CELL); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i); });
      Object.assign(hz, { ready: true, date: j.date || '', groups: j.groups, pts, grid, count: j.groups.length });
      log('info', `проблемні ділянки для фур: ${hz.count}`);
      bus.emit('hazards');
    } catch (e) { log('warn', 'hazards.json: ' + e.message); }
  })();
  return loading;
}

/* ---------- категорії доріг за номерами трас у маршруті ---------- */
// a — міжнародні й національні (М, Н, Е), b — регіональні й територіальні (Р, Т), c — місцеві дороги й вулиці
export function refCat(names) {
  const n = (names || []).map(x => String(x).trim());
  if (n.some(x => /^(?:[МM]|[НH]|[ЕE])\s?-?\s?\d/.test(x))) return 'a';
  if (n.some(x => /^(?:[РP]|[ТT])\s?-?\s?\d/.test(x))) return 'b';
  return 'c';
}
export function routeCats(route) {
  if (!route || !route.mans || !route.mans.length || !route.mans.some(m => m.streets)) return null;
  const segs = [], len = { a: 0, b: 0, c: 0 };
  for (const m of route.mans) {
    if (m.i1 <= m.i0) continue;
    const c = refCat(m.streets);
    segs.push({ i0: m.i0, i1: m.i1, c }); len[c] += m.len || 0;
  }
  const total = len.a + len.b + len.c;
  return { segs, share: total > 0 ? { a: len.a / total, b: len.b / total, c: len.c / total } : null };
}

/* ---------- проблемні місця вздовж маршруту ---------- */
const idxCache = new WeakMap();
export function indexOf(route) {
  if (!route || !route.coords) return null;
  if (g.route === route && g.idx) return g.idx;
  let i = idxCache.get(route); if (!i) { i = new RouteIndex(route.coords); idxCache.set(route, i); }
  return i;
}
// Рівень для конкретної фури: червоне — фура не проходить або заборонено; жовте — увага; null — не стосується.
function levelOf(kind, value) {
  const tr = S.truck || {};
  if (kind === 'w') return value < (tr.weight || 40) ? 'red' : null;
  if (kind === 'a') return value < (tr.axle || 11.5) ? 'red' : null;
  if (kind === 'h') return value < (tr.height || 4) + 0.1 ? 'red' : value < (tr.height || 4) + 0.3 ? 'yellow' : null;
  if (kind === 'g') return value === 0 ? 'red' : 'yellow';
  if (kind === 'u' || kind === 's') return 'yellow';
  return null;
}
export function hazardsAlong(route) {
  if (!hz.ready || !route) return [];
  if (route._hz && route._hz.date === hz.date && route._hz.truck === JSON.stringify(S.truck)) return route._hz.list;
  const idx = indexOf(route); if (!idx) return [];
  const STEP = 40, TOL = 22, hits = new Map();
  for (let d = 0; d <= idx.total; d += STEP) {
    const p = idx.at(d), ci = Math.floor(p.lat / CELL), cj = Math.floor(p.lon / CELL), kx = 111320 * Math.cos(p.lat * Math.PI / 180);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const a = hz.grid.get((ci + di) + ':' + (cj + dj)); if (!a) continue;
      for (const i of a) {
        const q = hz.pts[i], dy = (q[0] - p.lat) * 111320;
        if (dy > TOL || dy < -TOL) continue;
        const dx = (q[1] - p.lon) * kx;
        if (dx * dx + dy * dy > TOL * TOL) continue;
        const x = ((q[2] - p.brg) % 360 + 360) % 360, dev = Math.min(x, 360 - x);
        if (dev > 35 && dev < 145) continue;                 // дорога перетинає маршрут (міст над нами, вулиця навхрест)
        let h = hits.get(q[3]);
        if (!h) hits.set(q[3], h = { gid: q[3], d0: d, d1: d, lat: q[0], lon: q[1] }); else h.d1 = d;
      }
    }
  }
  let list = [];
  for (const h of hits.values()) {
    const [kind, value, name, len, bridge] = hz.groups[h.gid];
    const level = levelOf(kind, value); if (!level) continue;
    list.push({ kind, value, name, bridge: !!bridge, level, d0: h.d0, d1: Math.max(h.d1, h.d0 + Math.min(len || 0, 150)), lat: h.lat, lon: h.lon });
  }
  list.sort((a, b) => a.d0 - b.d0);
  // сусідні шматки однієї проблеми (дорога в OSM поділена на кілька ліній) — одним записом
  const out = [];
  for (const x of list) {
    const prev = out.findLast(y => y.kind === x.kind && (x.kind === 'u' || x.kind === 's' || y.value === x.value));
    if (prev && x.d0 - prev.d1 < 400) { prev.d1 = Math.max(prev.d1, x.d1); if (x.level === 'red') prev.level = 'red'; continue; }
    out.push({ ...x });
  }
  for (const x of out) x.len = Math.max(0, x.d1 - x.d0);
  route._hz = { date: hz.date, truck: JSON.stringify(S.truck), list: out };
  return out;
}
// Короткий підпис і пояснення для водія
export function hazardText(x) {
  const tr = S.truck || {}, km = m => (m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' ' + t('km') : Math.round(m) + ' ' + t('m'));
  const v = String(x.value).replace('.', ',');
  switch (x.kind) {
    case 'w': return { title: t(x.bridge ? 'hzBridge' : 'hzWeight', v), sub: t('hzYourWeight', String(tr.weight).replace('.', ',')), tag: v + 'т' };
    case 'a': return { title: t('hzAxle', v), sub: t('hzYourAxle', String(tr.axle).replace('.', ',')), tag: v + 'т/в' };
    case 'h': return { title: t('hzHeight', v), sub: t('hzYourHeight', String(tr.height).replace('.', ',')), tag: v + 'м' };
    case 'g': return { title: t(x.value === 0 ? 'hzNoTrucks' : 'hzDestOnly'), sub: '', tag: x.value === 0 ? '⛔' : 'P' };
    case 'u': return { title: t('hzUnpaved', km(x.len)), sub: '', tag: '' };
    case 's': return { title: t('hzRough', km(x.len)), sub: '', tag: '' };
  }
  return { title: '', sub: '', tag: '' };
}

/* ---------- Київ у години пік ---------- */
// В'їзд вантажівок до Києва обмежено 07:00–10:00 і 17:00–20:00 (рішення Ради оборони Києва, з 20.09.2023).
export const KYIV = { lat: 50.4501, lon: 30.5234, r: 15000 };
export const kyivRush = h => (h >= 7 && h < 10) || (h >= 17 && h < 20);
export function kyivOnRoute(route, fromD, etaAt) {
  const idx = indexOf(route); if (!idx) return null;
  const d0 = Math.max(0, fromD || 0);
  if (hav(idx.at(d0), KYIV) < KYIV.r) return { d: d0, inside: true };      // уже в місті — в'їзду попереду немає
  for (let d = d0; d <= idx.total; d += 500) {
    if (hav(idx.at(d), KYIV) < KYIV.r) { const when = new Date(etaAt(d)); return { d, when, rush: kyivRush(when.getHours()) }; }
  }
  return null;
}

/* ---------- попередження під час руху ---------- */
let warned = new Set();
function onPos() {
  if (!g.active || !g.route || pos.rd == null || !S.voice && !S.popups) return;
  const list = hazardsAlong(g.route);
  for (const x of list) {
    const ahead = x.d0 - pos.rd;
    if (ahead < 0 || ahead > 1500) continue;
    const key = x.kind + ':' + Math.round(x.d0);
    if (warned.has(key)) continue;
    warned.add(key);
    const tx = hazardText(x);
    say(t('hzSay', distWords(ahead), tx.title), { urgent: x.level === 'red' });
    bus.emit('toast', { text: tx.title + (tx.sub ? ' · ' + tx.sub : ''), level: x.level });
  }
}
export function init() {
  bus.on('route', () => { warned = new Set(); load(); });
  bus.on('pos', onPos);
}
