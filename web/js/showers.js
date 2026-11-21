// Душ для водія: місця з бази OpenStreetMap (окремі душі, АЗС і стоянки з душем) і власні позначки водія
// «тут є душ» — у відкритих даних душів мало, тож позначки самого водія важать не менше.
import { bus, hav, RouteIndex } from './core.js';
import { sdb, F, alongRoute } from './stopsdb.js';

const KEY = 'reis.marks';
let marks = [];
try { marks = JSON.parse(localStorage.getItem(KEY) || '[]'); if (!Array.isArray(marks)) marks = []; } catch (_) { marks = []; }
let ver = 0;
const save = () => { ver++; try { localStorage.setItem(KEY, JSON.stringify(marks)); } catch (_) {} bus.emit('marks'); };
const near = (a, b, m) => hav(a, b) < m;

export const myShowers = () => marks.filter(m => m.kind === 'shower');
export const myShowerAt = (p, r = 40) => marks.find(m => m.kind === 'shower' && near(m, p, r)) || null;
// Позначити / зняти позначку «тут є душ». Повертає true, якщо позначку поставлено.
export function toggleShower(p, name = '') {
  const m = myShowerAt(p);
  if (m) { marks = marks.filter(x => x !== m); save(); return false; }
  marks.push({ id: Date.now().toString(36), kind: 'shower', lat: +(+p.lat).toFixed(6), lon: +(+p.lon).toFixed(6), name: String(name || '').slice(0, 60), t: Date.now() });
  save(); return true;
}
export function removeMark(id) { marks = marks.filter(m => m.id !== id); save(); }

// Усі відомі душі: [{lat, lon, name, kind, mine, i}] — kind: тип точки бази ('f','h','p','s','m','e') або 'mine'
export function allShowers() {
  const out = [];
  if (sdb.ready) sdb.rows.forEach((r, i) => { if (r[3] & F.SHOWER) out.push({ lat: r[0], lon: r[1], name: r[4], kind: r[2], mine: false, i }); });
  for (const m of myShowers()) {
    const dup = out.find(x => near(x, m, 60));
    if (dup) dup.mine = true; else out.push({ lat: m.lat, lon: m.lon, name: m.name, kind: 'mine', mine: true, id: m.id });
  }
  return out;
}
// Найближчі душі від точки по прямій.
export function nearest(p, n = 3) {
  if (!p || p.lat == null) return [];
  return allShowers().map(x => ({ ...x, dist: hav(p, x) })).sort((a, b) => a.dist - b.dist).slice(0, n);
}
// Душі вздовж маршруту (до 1,5 км убік), відсортовані за відстанню від старту. Кешується на маршрут.
const cache = new WeakMap();
export function along(route, idx) {
  if (!route || !route.coords) return [];
  const key = sdb.count + ':' + ver, c = cache.get(route);
  if (c && c.key === key) return c.list;
  idx = idx || new RouteIndex(route.coords);
  const list = [];
  for (const x of alongRoute(idx, ['f', 's', 'p', 'm', 'e', 'h'], 1500)) {
    if (!(x.r[3] & F.SHOWER)) continue;
    list.push({ lat: x.r[0], lon: x.r[1], name: x.r[4], kind: x.r[2], mine: !!myShowerAt({ lat: x.r[0], lon: x.r[1] }, 60), d: x.d, off: x.off, i: x.i });
  }
  for (const m of myShowers()) {
    if (list.some(y => near(y, m, 60))) continue;
    const loc = idx.locate(m, null);
    if (loc && loc.off < 1500) list.push({ lat: m.lat, lon: m.lon, name: m.name, kind: 'mine', mine: true, d: loc.d, off: Math.round(loc.off), id: m.id });
  }
  list.sort((a, b) => a.d - b.d);
  cache.set(route, { key, list });
  return list;
}
export const marksVersion = () => ver;
