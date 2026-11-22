// База піт-стопів для фур по всій Україні (web/data/stops.json, збирає GitHub раз на місяць з OpenStreetMap).
// Працює без інтернету: точки на карті, стоянки попереду, камери швидкості.
import { bus, log } from './core.js';

export const TYPES = {
  e: { key: 'food', color: '#2f9e62' },      // їжа — зелене
  f: { key: 'fuel', color: '#2f6bff' },      // АЗС — синє
  s: { key: 'svc', color: '#7c3aed' },       // зона сервісу / відпочинку — фіолетове
  p: { key: 'park', color: '#7c3aed' },      // стоянка для фур — фіолетове
  m: { key: 'motel', color: '#e07b00' },     // мотель — помаранчеве
  c: { key: 'cam', color: '#1f2937' },       // камера швидкості — темне з червоним обідком
  h: { key: 'shower', color: '#0891b2' }     // душ — бірюзове (і бірюзовий обідок у будь-якої точки з душем)
};
export const SHOWER_COLOR = '#06b6d4';
export const F = { HGV: 1, SHOWER: 2, FOOD: 4, WC: 8, H24: 16, BIG: 32 };
export const sdb = { ready: false, date: '', rows: [], geo: null, count: 0 };

// Інші точки бази поруч (без камер): [{i, r, dist}] за відстанню.
export function nearbyRows(i, radius = 300) {
  const me = sdb.rows[i]; if (!me) return [];
  const out = [], kx = 111320 * Math.cos(me[0] * Math.PI / 180);
  sdb.rows.forEach((r, j) => {
    if (j === i || r[2] === 'c') return;
    const dy = (r[0] - me[0]) * 111320; if (dy > radius || dy < -radius) return;
    const dx = (r[1] - me[1]) * kx, d = Math.hypot(dx, dy);
    if (d <= radius) out.push({ i: j, r, dist: d });
  });
  return out.sort((a, b) => a.dist - b.dist);
}

// Наскільки точка важлива фурі — щоб здалеку показувати головне, а при наближенні все.
export function rank(r) {
  const [, , t, f] = r;
  if (t === 's' || t === 'p') return 3;
  if (t === 'f') return (f & F.HGV ? 2 : 0) + (f & F.BIG ? 1 : 0) + (f & (F.SHOWER | F.FOOD) ? 1 : 0);
  if (t === 'm') return 2;
  if (t === 'h') return 2;
  if (t === 'e') return r[4] ? 1 : 0;
  return 0;
}
// Бал для оголошення «стоянка попереду» (як у poi.js).
export function score(r) {
  const [, , t, f] = r;
  return (f & F.HGV ? 3 : 0) + (f & F.SHOWER ? 2 : 0) + (f & F.FOOD ? 1 : 0) + (f & F.WC ? 1 : 0) + (f & F.H24 ? 1 : 0) + (f & F.BIG ? 1 : 0) +
    (t === 's' ? 3 : t === 'p' ? 2 : t === 'm' ? 1 : 0);
}

// Назва мережі АЗС для підпису на карті: одна мережа — одна назва (ОККО/OKKO, Сокар/Socar…).
// Лише назви на наших кольорових плашках: фірмові логотипи — чужі знаки, їх не малюємо.
const BRANDS = [
  [/^(окко|okko)/i, 'OKKO'], [/^wog/i, 'WOG'], [/^(upg|юпіджі)/i, 'UPG'], [/^(укрнафта|ukrnafta)/i, 'Укрнафта'], [/^(брсм|brsm)/i, 'БРСМ'],
  [/^amic/i, 'AMIC'], [/^(socar|сокар)/i, 'SOCAR'], [/^shell/i, 'Shell'], [/^(кло|klo)$/i, 'KLO'], [/^motto/i, 'Motto'], [/^chipo/i, 'Chipo'],
  [/^(marshal|маршал)/i, 'Marshal'], [/^(атан|atan)/i, 'ATAN'], [/^avantage\s?7/i, 'Avantage 7'], [/^(паралл?ель|parallel)/i, 'Параллель'],
  [/^(tes|тэс|тес)$/i, 'TES'], [/^(glusco|глуско)/i, 'Glusco'], [/^укр-?петроль/i, 'Укр-Петроль'], [/^sun oil/i, 'Sun Oil'], [/^brent/i, 'Brent Oil'],
  [/^(агзс|агнкс|газ|пропан|метан)/i, 'Газ']
];
export function brandOf(name) {
  const n = String(name || '').trim();
  if (!n || /^(азс|маркет|заправка|автозаправка)$/i.test(n)) return 'АЗС';
  for (const [re, b] of BRANDS) if (re.test(n)) return b;
  return n.length > 14 ? n.slice(0, 13) + '…' : n;
}
export async function load() {
  try {
    const r = await fetch('data/stops.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    sdb.rows = j.rows || []; sdb.date = j.date || ''; sdb.count = sdb.rows.length;
    sdb.geo = {
      type: 'FeatureCollection',
      features: sdb.rows.map((x, i) => ({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [x[1], x[0]] }, properties: x[2] === 'f' ? { t: x[2], r: rank(x) + (x[3] & F.SHOWER ? 1 : 0), sh: x[3] & F.SHOWER ? 1 : 0, i, nm: brandOf(x[4]) } : { t: x[2], r: rank(x) + (x[3] & F.SHOWER ? 1 : 0), sh: x[3] & F.SHOWER ? 1 : 0, i } }))
    };
    sdb.ready = sdb.count > 0;
    log('info', `база піт-стопів: ${sdb.count} точок, дані від ${sdb.date}`);
  } catch (e) { log('warn', 'база піт-стопів: ' + e.message); }
  bus.emit('stopsdb', sdb);
  return sdb;
}

/* Точки біля маршруту. Маршрут нарізаємо через 250 м і кладемо в сітку — так 20 тисяч точок
   перевіряються за мілісекунди навіть для маршруту на тисячу кілометрів. */
export function alongRoute(idx, types, maxOff = 1200) {
  if (!sdb.ready || !idx) return [];
  const cell = 0.02, grid = new Map(), key = (la, lo) => Math.floor(la / cell) + ':' + Math.floor(lo / cell);
  for (let d = 0; d <= idx.total; d += 250) {
    const p = idx.at(d), k = key(p.lat, p.lon);
    let a = grid.get(k); if (!a) grid.set(k, a = []);
    a.push([p.lat, p.lon, d]);
  }
  const out = [];
  for (let i = 0; i < sdb.rows.length; i++) {
    const r = sdb.rows[i]; if (!types.includes(r[2])) continue;
    const ci = Math.floor(r[0] / cell), cj = Math.floor(r[1] / cell);
    let best = null, bd = maxOff;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const a = grid.get((ci + di) + ':' + (cj + dj)); if (!a) continue;
      for (const s of a) {
        const dd = Math.hypot((s[0] - r[0]) * 111000, (s[1] - r[1]) * 71500);
        if (dd < bd) { bd = dd; best = s; }
      }
    }
    if (best) out.push({ i, r, d: best[2], off: Math.round(bd) });
  }
  return out.sort((a, b) => a.d - b.d);
}
