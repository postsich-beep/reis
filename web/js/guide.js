// Ведення за маршрутом: наступний маневр, голос, прибуття, перерахунок при з'їзді.
import { bus, log, S, RouteIndex, hav, clamp } from './core.js';
import { pos, setRoute } from './nav.js';
import { speak, stopSpeak, online } from './platform.js';
import { buildRoute } from './route.js';
import { t } from './i18n.js';

export const g = {
  trip: null, route: null, idx: null, active: false, arrived: false,
  manI: 0, next: null, after: null, distNext: 0, remain: 0, remTime: 0, eta: 0,
  rerouting: false, offRoute: false, passedA: true, passedV: false
};
let said = {}, offSince = 0, lastReroute = 0, lastManI = -1;

/* ---------- голосова черга ---------- */
const queue = []; let speaking = false;
export function say(text, { force = false, urgent = false } = {}) {
  if (!text || (!S.voice && !force)) return;
  if (urgent) { queue.length = 0; stopSpeak(); speaking = false; }
  if (queue.length >= 3) queue.shift();
  queue.push(text);
  if (!speaking) drain();
}
async function drain() {
  speaking = true;
  while (queue.length) { const x = queue.shift(); bus.emit('say', x); try { await speak(x); } catch (_) {} }
  speaking = false;
}
export const isSpeaking = () => speaking;

const lowerFirst = s => s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
export function distWords(m) {
  const ru = S.lang === 'ru';
  if (m < 950) return (Math.round(m / 50) * 50 || 50) + (ru ? ' метров' : ' метрів');
  const k = Math.round(m / 1000);
  if (k === 1) return ru ? 'один километр' : 'один кілометр';
  if (k >= 2 && k <= 4) return k + (ru ? ' километра' : ' кілометри');
  return k + (ru ? ' километров' : ' кілометрів');
}

/* ---------- старт і зупинка рейсу ---------- */
function applyRoute(route) {
  g.route = route; g.idx = new RouteIndex(route.coords);
  for (const m of route.mans) m.d0 = g.idx.cum[Math.min(m.i0, g.idx.cum.length - 1)];
  g.manI = 0; lastManI = -1; said = {}; offSince = 0; g.offRoute = false;
  g.passedA = route.aD == null; g.passedV = route.viaD == null;
  setRoute(g.idx);
  bus.emit('route', g);
  update();
}

export async function startTrip(trip) {
  g.trip = trip; g.active = true; g.arrived = false;
  let route = trip.route;
  // Стартуємо не з точки А — ведемо до неї від поточного місця.
  if (pos.lat != null && pos.mode === 'gps' && hav(pos, trip.a) > 400 && online()) {
    try { route = await buildRoute(trip, { from: pos, heading: pos.spd > 2 ? pos.hdg : null }); }
    catch (e) { log('warn', 'підведення до А: ' + e.message); }
  }
  applyRoute(route);
  say(t('voiceStart'));
  bus.emit('trip', g);
}
export function stopTrip() {
  g.active = false; g.trip = null; g.route = null; g.idx = null; g.next = null; g.arrived = false; g.rerouting = false;
  setRoute(null); queue.length = 0;
  bus.emit('route', g); bus.emit('trip', g); bus.emit('guide', g);
}

async function reroute() {
  if (g.rerouting || !g.trip) return;
  g.rerouting = true; lastReroute = Date.now(); bus.emit('guide', g);
  try {
    const r = await buildRoute(g.trip, { from: pos, heading: pos.spd > 2 ? pos.hdg : null, skipA: g.passedA, skipVia: g.passedV });
    if (g.active) { applyRoute(r); say(t('voiceReroute')); }
  } catch (e) { log('warn', 'перерахунок: ' + e.message); }
  g.rerouting = false; bus.emit('guide', g);
}
export function rerouteNow() { lastReroute = 0; if (pos.lat != null && online()) reroute(); }

function announce() {
  const n = g.next; if (!n || !pos.onRoute) return;
  const d = g.distNext, v = pos.spd, s = said[g.manI + 1] ||= {};
  const nearD = clamp(v * 6, 50, 250);                    // «зараз» — приблизно за 6 секунд до маневру
  const farD = v > 22 ? 2000 : v > 14 ? 1000 : 0;         // далеке попередження лише на трасі
  let msg = null;
  if (d <= nearD) { if (!s.near) { s.near = s.mid = s.far = true; msg = n.pre; } }
  else if (d <= 520 && d > nearD + 120) { if (!s.mid) { s.mid = s.far = true; msg = t('voiceIn', distWords(d)) + ' ' + lowerFirst(n.alert || n.pre); } }
  else if (farD && d <= farD + 100 && d > 700) { if (!s.far) { s.far = true; msg = t('voiceIn', distWords(d)) + ' ' + lowerFirst(n.alert || n.pre); } }
  if (msg) say(msg);
}

function update() {
  if (!g.active || !g.idx || pos.lat == null) return;
  const mans = g.route.mans, idx = g.idx, now = Date.now();
  if (!pos.onRoute) {
    g.offRoute = pos.off > 80;
    if (pos.mode === 'gps' && pos.spd >= 1.5 && pos.off > 80) {
      if (!offSince) offSince = now;
      if (now - offSince > 8000 && now - lastReroute > 20000 && online()) reroute();
    } else offSince = 0;
  } else { offSince = 0; g.offRoute = false; }

  const d = pos.rd == null ? 0 : pos.rd;
  if (g.route.aD != null && d >= g.route.aD - 80) g.passedA = true;
  if (g.route.viaD != null && d >= g.route.viaD - 80) g.passedV = true;

  let i = g.manI;
  if (i >= mans.length || mans[i].d0 > d + 1) i = 0;
  while (i + 1 < mans.length && mans[i + 1].d0 <= d + 1) i++;
  g.manI = i;
  const cur = mans[i], nxt = mans[i + 1] || null;
  g.next = nxt; g.after = mans[i + 2] || null;
  g.distNext = Math.max(0, (nxt ? nxt.d0 : idx.total) - d);
  g.remain = Math.max(0, idx.total - d);
  const curLen = (nxt ? nxt.d0 : idx.total) - cur.d0;
  let rt = curLen > 0 ? cur.time * clamp(g.distNext / curLen, 0, 1) : 0;
  for (let k = i + 1; k < mans.length; k++) rt += mans[k].time;
  g.remTime = rt; g.eta = now + rt * 1000;

  if (pos.onRoute) {
    if (i !== lastManI) {                                   // щойно проїхали маневр: «далі N кілометрів»
      if (lastManI >= 0 && cur.post && curLen > 2500) say(cur.post);
      lastManI = i;
    }
    announce();
    if (g.remain < 45 && !g.arrived) {
      g.arrived = true; g.active = false; say(t('voiceArrived'), { urgent: true });
      bus.emit('arrived', g);
    }
  }
  bus.emit('guide', g);
}

export function init() { bus.on('pos', update); }
