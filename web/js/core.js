// Ядро: шина подій, журнал, налаштування, сховище, геометрія, форматування.
import { UA_RINGS } from './ua_border.js';
export const VERSION = { web: 38, name: '1.1.11' };

/* ---------- шина подій ---------- */
const handlers = {};
export const bus = {
  on(ev, fn) { (handlers[ev] ||= []).push(fn); return () => bus.off(ev, fn); },
  off(ev, fn) { const a = handlers[ev]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
  emit(ev, data) {
    const a = handlers[ev]; if (!a) return;
    for (const fn of a.slice()) {
      try { fn(data); } catch (e) { log('err', ev + ': ' + (e && e.stack || e)); }
    }
  }
};

/* ---------- журнал діагностики ---------- */
const LOG = [];
export function log(level, msg) {
  const line = { t: Date.now(), level, msg: String(msg) };
  LOG.push(line); if (LOG.length > 400) LOG.shift();
  if (level === 'err') console.error(line.msg);
  const a = handlers.log; if (a) for (const fn of a.slice()) { try { fn(line); } catch (_) {} }
}
export const getLog = () => LOG;
window.addEventListener('error', e => log('err', (e.message || 'error') + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', e => log('err', 'promise: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

/* ---------- налаштування ---------- */
// Базові шари карти (1.1.7, як погодили): на карті лише АЗС і камери. Інше — їжа, стоянки, мотелі, душ, перевірені місця,
// події, проблемні місця, заміри покриття — водій вмикає сам кнопкою «Шари».
const BASE_STOPS = { food: false, fuel: true, park: false, motel: false, cam: true, shower: false };
const DEFAULTS = {
  lang: 'uk', theme: 'auto', view3d: true, autoCenter: true,
  voice: true, popups: true, lookahead: true, cpSound: true,
  tg: true, air: true, cams: true, stops: true, drive: true,
  aiFilter: false, spoof: true, offline: true, rec: false,
  vibrate: true, notify: true, keepAwake: true, channelsSeeded: false, weather: true, chDefVer: 0,
  mapMode: 'auto', offlineWifi: true, mapStops: true, mapStopTypes: { ...BASE_STOPS },
  truck: { height: 4.0, width: 2.55, length: 16.5, weight: 20, axle: 11.5, hazmat: false, vmax: 90 }, truckV: 1,
  stopKm: 30, aheadH: 3, nearKm: 100, vehicle: 'truck', keepChosen: true, ttsRate: 1, ttsVoice: 'system', repShare: true, repTopic: '', glass: 'high', roughMapV: 2, routeCats: true, heatExempt: false, mapEvents: false, mapHazards: false, mapVerified: false, layersDefV: 1, passed: 'hide', rough: true, roughMap: false,
  apiKey: '', model: 'claude-sonnet-5-5',
  routeUrl: 'https://valhalla1.openstreetmap.de',
  styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  alertsToken: '',
  channels: [],            // [{name:'channel', region:'kharkiv'|'all', on:true}]
  onboarded: false
};
export const TRUCK_MAX_T = 20;                       // найважча фура в парку — 20 т
let settings = structuredClone(DEFAULTS);
try {
  const raw = JSON.parse(localStorage.getItem('reis.settings') || '{}');
  settings = { ...settings, ...raw, truck: { ...DEFAULTS.truck, ...(raw.truck || {}) } };
  // 1.1.10: у нас фури не важчі за 20 т — збережені 40 т (старе значення за замовчуванням) стають 20 т
  settings.truck.weight = Math.min(+settings.truck.weight || TRUCK_MAX_T, TRUCK_MAX_T);
  if ((raw.truckV || 0) < 1 && raw.truck) { settings.truckV = 1; localStorage.setItem('reis.settings', JSON.stringify(settings)); }
  // 1.1.12: голос «Лада» прибрано (писклявий) — у кого він був вибраний, тепер говорить Тетяна
  if (settings.ttsVoice === 'uk:0') { settings.ttsVoice = 'uk:2'; localStorage.setItem('reis.settings', JSON.stringify(settings)); }
  // Телефон, на якому «Рейс» уже стояв: один раз ставимо базові галочки шарів, далі вибір водія не чіпаємо
  if ((raw.layersDefV || 0) < 1 && Object.keys(raw).length) {
    Object.assign(settings, { mapStops: true, mapStopTypes: { ...BASE_STOPS }, mapVerified: false, mapEvents: false, mapHazards: false, roughMap: false, layersDefV: 1 });
    localStorage.setItem('reis.settings', JSON.stringify(settings));
  }
} catch (_) {}
export const S = new Proxy(settings, {
  set(o, k, v) {
    o[k] = v;
    try { localStorage.setItem('reis.settings', JSON.stringify(o)); } catch (_) {}
    bus.emit('settings', k);
    return true;
  }
});
export function saveSettings() { S.lang = S.lang; }

/* ---------- IndexedDB: кеш карт і великі об'єкти ---------- */
let dbp = null;
function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let rq;
    try { rq = indexedDB.open('reis', 1); } catch (e) { rej(e); return; }
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains('c')) d.createObjectStore('c');
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
function tx(store, mode, fn) {
  return openDb().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode); const rq = fn(t.objectStore(store));
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
export const db = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)).catch(() => undefined),
  set: (store, key, val) => tx(store, 'readwrite', s => s.put(val, key)).catch(e => log('warn', 'db.set ' + e)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)).catch(() => {}),
  count: (store) => tx(store, 'readonly', s => s.count()).catch(() => 0),
  clear: (store) => tx(store, 'readwrite', s => s.clear()).catch(() => {})
};

/* ---------- геометрія ---------- */
const R = 6371008.8, D2R = Math.PI / 180;
/** Бічна розкладка: телефон набік (карта ліворуч, усе решта праворуч). Планшет і вертикальний телефон — ні. Те саме правило — в app.css. */
export const sideLayout = (w = window.innerWidth, h = window.innerHeight) => w > h && h <= 520;
export function hav(a, b) {
  const dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * D2R) * Math.cos(b.lat * D2R);
  const x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) - Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lon - a.lon) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}
export function destPoint(p, brg, d) {
  const br = brg * D2R, la = p.lat * D2R, lo = p.lon * D2R, ad = d / R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(ad) + Math.cos(la) * Math.sin(ad) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(ad) * Math.cos(la), Math.cos(ad) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 / D2R, lon: lo2 / D2R };
}
export function angDiff(a, b) { return ((a - b + 540) % 360) - 180; }
export function decodePolyline6(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let r = 0, sh = 0, b;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
      const d = (r & 1) ? ~(r >> 1) : (r >> 1);
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}
// Межі України із запасом: для детектора підміни GPS.
// Чи точка в Україні: за справжнім контуром кордону (з Кримом), із запасом 8 км на неточність контуру.
// Прямокутник лише відсікає далеке; Бєлгород чи Гомель всередині прямокутника, але не в Україні.
const UA_EDGE_M = 8000;
function inRing(lat, lon, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [yi, xi] = r[i], [yj, xj] = r[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function nearEdge(lat, lon, m) {
  const ky = 111320, kx = 111320 * Math.cos(lat * Math.PI / 180), lim = m * m;
  for (const r of UA_RINGS) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const ax = (r[j][1] - lon) * kx, ay = (r[j][0] - lat) * ky, bx = (r[i][1] - lon) * kx, by = (r[i][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    if (px * px + py * py <= lim) return true;
  }
  return false;
}
export const inUkraineBox = p => p.lat > 44.0 && p.lat < 52.7 && p.lon > 21.9 && p.lon < 40.6;
export function inUkraine(p) {
  if (p == null || !inUkraineBox(p)) return false;
  const lat = +p.lat, lon = +p.lon;
  for (const r of UA_RINGS) if (inRing(lat, lon, r)) return true;
  return nearEdge(lat, lon, UA_EDGE_M);
}

/* ---------- маршрут як індекс відстаней ---------- */
export class RouteIndex {
  constructor(coords) {
    this.c = coords;                       // [[lat,lon],...]
    this.cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
      this.cum[i] = this.cum[i - 1] + hav({ lat: coords[i - 1][0], lon: coords[i - 1][1] }, { lat: coords[i][0], lon: coords[i][1] });
    }
    this.total = this.cum[coords.length - 1] || 0;
  }
  segAt(d) {                                // бінарний пошук сегмента за відстанню
    let lo = 0, hi = this.c.length - 2;
    if (hi < 0) return 0;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.cum[m] <= d) lo = m; else hi = m - 1; }
    return lo;
  }
  at(d) {
    d = Math.max(0, Math.min(this.total, d));
    const i = this.segAt(d), a = this.c[i], b = this.c[Math.min(i + 1, this.c.length - 1)];
    const len = this.cum[Math.min(i + 1, this.c.length - 1)] - this.cum[i];
    const f = len > 0 ? (d - this.cum[i]) / len : 0;
    const pa = { lat: a[0], lon: a[1] }, pb = { lat: b[0], lon: b[1] };
    return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, brg: len > 0 ? bearing(pa, pb) : 0, seg: i };
  }
  // Найближча точка маршруту. hint — очікувана відстань уздовж; шукаємо спершу у вікні, потім усюди.
  locate(p, hint, back = 150, fwd = 1500) {
    const scan = (i0, i1) => {
      let best = null;
      const kx = Math.cos(p.lat * D2R) * 111320, ky = 110540;
      for (let i = i0; i < i1; i++) {
        const a = this.c[i], b = this.c[i + 1];
        const ax = (a[1] - p.lon) * kx, ay = (a[0] - p.lat) * ky, bx = (b[1] - p.lon) * kx, by = (b[0] - p.lat) * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        let f = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0; f = f < 0 ? 0 : f > 1 ? 1 : f;
        const cx = ax + dx * f, cy = ay + dy * f, off = Math.hypot(cx, cy);
        if (!best || off < best.off) best = { off, seg: i, f };
      }
      if (!best) return null;
      const i = best.seg, a = this.c[i], b = this.c[i + 1];
      return {
        off: best.off, seg: i, d: this.cum[i] + (this.cum[i + 1] - this.cum[i]) * best.f,
        lat: a[0] + (b[0] - a[0]) * best.f, lon: a[1] + (b[1] - a[1]) * best.f,
        brg: bearing({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] })
      };
    };
    const n = this.c.length - 1;
    if (n < 1) return null;
    if (hint != null) {
      const i0 = Math.max(0, this.segAt(Math.max(0, hint - back))), i1 = Math.min(n, this.segAt(Math.min(this.total, hint + fwd)) + 1);
      const w = scan(i0, i1);
      if (w && w.off < 60) return w;
    }
    return scan(0, n);
  }
  slice(d0, d1) {                           // координати відрізка [d0,d1] як [[lon,lat],...] для карти
    d0 = Math.max(0, d0); d1 = Math.min(this.total, d1);
    if (d1 <= d0) return [];
    const out = [], a = this.at(d0), b = this.at(d1);
    out.push([a.lon, a.lat]);
    for (let i = a.seg + 1; i <= b.seg; i++) out.push([this.c[i][1], this.c[i][0]]);
    out.push([b.lon, b.lat]);
    return out;
  }
}

/* ---------- сонце: автоперемикання день/ніч ---------- */
export function isNight(lat, lon, date = new Date()) {
  const rad = D2R, day = Math.floor((date - new Date(Date.UTC(date.getUTCFullYear(), 0, 0))) / 864e5);
  const decl = -23.44 * Math.cos(rad * (360 / 365) * (day + 10));
  const cosH = (Math.sin(-0.83 * rad) - Math.sin(lat * rad) * Math.sin(decl * rad)) / (Math.cos(lat * rad) * Math.cos(decl * rad));
  if (cosH > 1) return true; if (cosH < -1) return false;
  const H = Math.acos(cosH) / rad / 15;                       // половина світлового дня, год
  const noonUTC = 12 - lon / 15;                              // без рівняння часу — точності ±15 хв досить
  const h = date.getUTCHours() + date.getUTCMinutes() / 60;
  let diff = Math.abs(h - noonUTC); if (diff > 12) diff = 24 - diff;
  return diff > H;
}

/* ---------- форматування ---------- */
export const km = m => m / 1000;
export function fmtDist(m, L = S.lang) {
  const u = L === 'ru' ? ['м', 'км'] : ['м', 'км'];
  if (m < 950) return (m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50) + ' ' + u[0];
  if (m < 9950) return (m / 1000).toFixed(1).replace('.', ',') + ' ' + u[1];
  return Math.round(m / 1000) + ' ' + u[1];
}
export function fmtDur(sec, L = S.lang) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  const H = L === 'ru' ? 'ч' : 'год', M = L === 'ru' ? 'мин' : 'хв';
  if (h <= 0) return Math.max(1, m) + ' ' + M;
  return m === 60 ? (h + 1) + ' ' + H : h + ' ' + H + (m ? ' ' + m + ' ' + M : '');
}
export const pad2 = n => String(n).padStart(2, '0');
export const fmtClock = d => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
export const fmtMS = sec => Math.floor(sec / 60) + ':' + pad2(Math.floor(sec % 60));
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
