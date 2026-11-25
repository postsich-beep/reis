// Ведення за маршрутом: наступний маневр, голос, прибуття, перерахунок при з'їзді.
import { bus, log, S, RouteIndex, hav, clamp, db } from './core.js';
import { pos, setRoute } from './nav.js';
import { speak, stopSpeak, online } from './platform.js';
import { buildRoute } from './route.js';
import { t } from './i18n.js';

export const g = {
  trip: null, route: null, idx: null, active: false, arrived: false,
  manI: 0, next: null, after: null, distNext: 0, remain: 0, remTime: 0, eta: 0,
  rerouting: false, offRoute: false, passedA: true, passedV: false, leadPending: false, reroutePending: null,
  offer: null                // (1.1.28) пропозиція перебудувати маршрут, що чекає на відповідь водія: { id, kind, title, text, secs, at, until }
};
let said = {}, offSince = 0, lastReroute = 0, lastManI = -1;
// (1.1.28) Маршрут у дорозі САМ не перебудовується. З'їхали з рейсу чи сталося щось інше — показуємо пропозицію з причиною, читаємо її вголос
// і чекаємо OFFER_SECS секунд. Підтвердили — перебудовуємо; ні (або час вийшов) — ведемо далі запланованим рейсом.
export const OFFER_SECS = 10;
let offerT = 0, offerSeq = 0, offAsked = false, onSince = 0, lastOfferEnd = 0;

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
/* ---------- активний рейс переживає перезапуск застосунку й оновлення інтерфейсу ---------- */
const ACTIVE_KEY = 'activeTrip', ACTIVE_MAX_H = 18;
function saveActive() {
  if (!g.active || !g.trip || !g.route) return;
  const r = { ...g.route }; delete r._hz; delete r.heat;
  db.set('kv', ACTIVE_KEY, { trip: { ...g.trip, route: undefined }, route: r, passedA: g.passedA, passedV: g.passedV, at: Date.now() }).catch(() => {});
}
let flagsSaved = '';
function saveFlags() { const k = g.passedA + ':' + g.passedV; if (k !== flagsSaved) { flagsSaved = k; saveActive(); } }
// Позначка «рейс завершено» пишеться одразу (localStorage — синхронний): якщо застосунок закрили чи оновили
// в ту ж мить, видалення з бази могло не встигнути — і зупинений рейс «воскресав».
const DONE_KEY = 'reis.tripDone';
function clearActive() { try { localStorage.setItem(DONE_KEY, String(Date.now())); } catch (_) {} db.del('kv', ACTIVE_KEY); }
// Відновити рейс, що йшов до перезапуску (не старший 18 год і не завершений). Повертає true, якщо відновлено.
export async function resumeActive() {
  try {
    const s = await db.get('kv', ACTIVE_KEY);
    if (!s || !s.route || !s.trip || Date.now() - s.at > ACTIVE_MAX_H * 3600e3 || g.active) return false;
    let done = 0; try { done = +localStorage.getItem(DONE_KEY) || 0; } catch (_) {}
    if (done >= s.at) { db.del('kv', ACTIVE_KEY); return false; }
    g.trip = { ...s.trip, route: s.route }; g.active = true; g.arrived = false;
    applyRoute(s.route, true);
    g.passedA = !!s.passedA || g.passedA; g.passedV = !!s.passedV || g.passedV;
    say(t('voiceResume'));
    bus.emit('trip', g);
    log('info', 'рейс відновлено після перезапуску');
    return true;
  } catch (e) { log('warn', 'відновлення рейсу: ' + e.message); return false; }
}

function applyRoute(route, resumed = false) {
  g.route = route; g.idx = new RouteIndex(route.coords);
  for (const m of route.mans) m.d0 = g.idx.cum[Math.min(m.i0, g.idx.cum.length - 1)];
  g.manI = 0; lastManI = -1; said = {}; offSince = 0; g.offRoute = false; offAsked = false; onSince = 0;
  if (g.offer) closeOffer('route');
  g.passedA = route.aD == null; g.passedV = route.viaD == null;
  setRoute(g.idx, route.mans);
  bus.emit('route', g);
  update();
  if (!resumed) saveActive();
}

// Вибраний водієм маршрут (спрощено, точка на ~500 м): при з'їзді ведемо назад на нього, а не будуємо зовсім інший.
function chosenOf(route) {
  if (!route || !route.coords || route.coords.length < 2) return null;
  const idx = new RouteIndex(route.coords), out = [];
  for (let d = 0; d < idx.total; d += 500) { const p = idx.at(d); out.push([+p.lat.toFixed(5), +p.lon.toFixed(5)]); }
  const e = route.coords[route.coords.length - 1]; out.push([e[0], e[1]]);
  return out;
}
// Точки вздовж вибраного маршруту попереду: перша — за 3 км від найближчої до нас, далі кожні ~40 км (не більше 12)
function throughChosen() {
  const ch = g.trip && g.trip.chosen; if (!ch || ch.length < 2 || pos.lat == null) return null;
  const idx = new RouteIndex(ch), l = idx.locate(pos, null);
  if (!l || l.off > 25000) return null;                    // далеко від вибраного — будуємо заново
  const start = l.d + 3000, end = idx.total - 4000; if (start >= end) return null;
  const n = Math.min(12, Math.max(1, Math.ceil((end - start) / 40000))), pts = [];
  for (let i = 0; i < n; i++) { const d = start + (end - start) * i / n, p = idx.at(d); pts.push({ lat: p.lat, lon: p.lon, brg: p.brg, d }); }
  if (g.trip.v && !g.passedV) { const lv = idx.locate(g.trip.v, null); if (lv && lv.d > l.d) pts.push({ lat: g.trip.v.lat, lon: g.trip.v.lon, d: lv.d }); }
  return pts.sort((a, b) => a.d - b.d).map(({ lat, lon, brg }) => ({ lat, lon, brg }));
}
// (1.1.28) Стартуємо не з точки А: підводимо до неї, а далі ведемо ТИМ САМИМ рейсом, який водій побачив і вибрав, — крізь точки на його
// лінії (перша за 3 км від А, далі кожні ~40 км). Раніше ділянку А → Б сервер рахував заново, і вона могла виявитись іншим варіантом.
function leadThrough(route) {
  if (!route || !route.coords || route.coords.length < 2 || !g.trip) return null;
  const idx = new RouteIndex(route.coords), start = 3000, end = idx.total - 4000;
  if (end - start < 5000) return null;                      // короткий рейс — варіантам ніде розійтись
  const n = Math.min(10, Math.max(1, Math.ceil((end - start) / 40000))), pts = [{ lat: g.trip.a.lat, lon: g.trip.a.lon, d: 0 }];
  for (let i = 0; i < n; i++) { const d = start + (end - start) * i / n, p = idx.at(d); pts.push({ lat: p.lat, lon: p.lon, brg: p.brg, d }); }
  if (g.trip.v) { const lv = idx.locate(g.trip.v, null); if (lv && lv.off < 400) pts.push({ lat: g.trip.v.lat, lon: g.trip.v.lon, d: lv.d }); else return null; }
  return pts.sort((a, b) => a.d - b.d).map(({ lat, lon, brg }) => brg == null ? { lat, lon } : { lat, lon, brg });
}
async function buildLead(heading) {
  const through = leadThrough(g.trip.route || g.route);
  if (through) { try { return await buildRoute(g.trip, { from: pos, heading, through }); } catch (e) { log('warn', 'підведення до А вибраним рейсом: ' + e.message); } }
  return buildRoute(g.trip, { from: pos, heading });
}
export async function startTrip(trip, opts = {}) {
  g.trip = trip; g.active = true; g.arrived = false; g.reroutePending = null; lastOfferEnd = 0;
  let route = trip.route;
  if (!trip.chosen) trip.chosen = chosenOf(route);
  // Стартуємо не з точки А — ведемо до неї від поточного місця (крім випадку, коли водій уже їде цим маршрутом).
  if (!opts.onRoute && pos.lat != null && pos.mode === 'gps' && hav(pos, trip.a) > 400 && online()) {
    try { route = await buildLead(pos.spd > 2 ? pos.hdg : null); }
    catch (e) { log('warn', 'підведення до А: ' + e.message); }
  }
  applyRoute(route);
  g.leadPending = pos.mode !== 'gps';        // GPS ще не знайшов нас: підведемо до А, щойно з'явиться
  say(t('voiceStart'));
  bus.emit('trip', g);
}
export function stopTrip() {
  clearActive(); closeOffer('stop');
  g.active = false; g.trip = null; g.route = null; g.idx = null; g.next = null; g.arrived = false; g.rerouting = false; g.reroutePending = null;
  setRoute(null); queue.length = 0;
  bus.emit('route', g); bus.emit('trip', g); bus.emit('guide', g);
}

/* ---------- (1.1.28) пропозиція перебудувати маршрут: вікно з причиною, зворотний відлік, голос ---------- */
// o: { kind, title, text, voice, secs, onYes }. Одна пропозиція за раз; нова замінює стару.
export function propose(o) {
  if (!g.active || !g.trip) return false;
  if (g.offer) closeOffer('replaced');
  const secs = o.secs || OFFER_SECS, now = Date.now();
  g.offer = { id: ++offerSeq, kind: o.kind || 'info', title: o.title || '', text: o.text || '', secs, at: now, until: now + secs * 1000, onYes: o.onYes || null };
  log('info', 'пропозиція перебудувати маршрут: ' + g.offer.kind + ' — ' + g.offer.title);
  bus.emit('offer', g.offer);
  if (o.voice) say(o.voice, { urgent: true });
  clearTimeout(offerT); offerT = setTimeout(() => answerOffer(false, 'timeout'), secs * 1000);
  return true;
}
function closeOffer(why) {
  if (!g.offer) return null;
  const o = g.offer; g.offer = null; clearTimeout(offerT); offerT = 0; lastOfferEnd = Date.now();
  bus.emit('offerEnd', { why, offer: o });
  return o;
}
// Відповідь водія (або час вийшов — тоді це «ні»): так — перебудовуємо; ні — ведемо запланованим рейсом, як і вели.
export function answerOffer(yes, why = yes ? 'yes' : 'no') {
  const o = closeOffer(why); if (!o) return;
  log('info', 'пропозицію ' + o.kind + (yes ? ' прийнято — перебудовую' : why === 'timeout' ? ' не підтверджено — лишаюсь на запланованому рейсі' : ' відхилено — лишаюсь на запланованому рейсі'));
  if (yes) { if (o.onYes) o.onYes(); }
  else if (why === 'timeout') say(t('rrStayVoice'));
}
// З'їхали з рейсу: пропонуємо перебудувати. manual — водій сам торкнувся плашки «Ви зійшли з рейсу» (питаємо знову, без голосу).
export function offerOffRoute(manual = false) {
  if (!g.active || !g.trip || g.rerouting || pos.lat == null) return false;
  if (!online() && pos.mode === 'gps') { if (manual) bus.emit('offerNoNet'); return false; }
  offAsked = true;
  return propose({
    kind: 'off', title: t('rrOffTitle'), text: (pos.off > 150 ? t('rrOffDist', distShort(pos.off)) + ' ' : '') + t('rrOffText'),
    voice: manual ? '' : t('rrOffVoice'), onYes: () => { lastReroute = 0; reroute(); }
  });
}
const distShort = m => m < 950 ? (Math.round(m / 50) * 50 || 50) + ' м' : (m < 9500 ? (Math.round(m / 100) / 10).toFixed(1).replace('.', ',').replace(',0', '') : Math.round(m / 1000)) + ' км';

async function reroute(lead = false, fresh = false) {
  if (g.rerouting || !g.trip) return;
  // Без GPS рейс НЕ перебудовуємо: місце лише розраховане, перебудова від нього може повести не туди.
  // Прохання водія (новий шлях, «заїхати через») запам'ятовуємо й виконуємо, щойно GPS повернеться.
  if (pos.mode !== 'gps') {
    const was = g.reroutePending;
    g.reroutePending = { lead: lead || !!(was && was.lead), fresh: fresh || !!(was && was.fresh) };
    if (!was) { log('info', 'перебудову рейсу відкладено до GPS'); bus.emit('rerouteWait', g.reroutePending); }
    bus.emit('guide', g); return;
  }
  g.reroutePending = null;
  if (g.offer) closeOffer('reroute');
  g.rerouting = true; lastReroute = Date.now(); bus.emit('guide', g);
  try {
    const heading = pos.spd > 2 ? pos.hdg : null;
    // з'їхали — повертаємо на вибраний маршрут (точки вздовж нього); «новий шлях» — лише на прохання водія
    const through = lead || fresh || S.keepChosen === false ? null : throughChosen();
    let r = null;
    if (through) { try { r = await buildRoute(g.trip, { from: pos, heading, through }); } catch (e) { log('warn', 'повернення на вибраний маршрут: ' + e.message); } }
    if (!r && lead) r = await buildLead(heading);                       // підведення до А — тим самим вибраним рейсом
    if (!r) r = await buildRoute(g.trip, { from: pos, heading, skipA: lead ? false : g.passedA, skipVia: g.passedV });
    if (fresh) g.trip.chosen = chosenOf(r);
    if (g.active) {
      applyRoute(r); say(t(through ? 'voiceRejoin' : 'voiceReroute'));
      if (r.truckFail) bus.emit('truckFail', r);         // для фури проїзду немає — веду звичайним, водій попереджений
    }
  } catch (e) { log('warn', 'перерахунок: ' + e.message); }
  g.rerouting = false; bus.emit('guide', g);
}
// Заїхати по дорозі: точка стає проміжною, маршрут перебудовується від поточного місця.
export function setVia(p) { if (!g.trip) return; g.trip.v = p; g.passedV = false; rerouteNow(true); }
export function rerouteNow(fresh = false) { lastReroute = 0; if (pos.lat != null && (online() || pos.mode !== 'gps')) reroute(false, fresh); }

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
  if (g.reroutePending && pos.mode === 'gps' && !g.rerouting && online()) { const p = g.reroutePending; log('info', 'GPS є — виконую відкладену перебудову'); reroute(p.lead, p.fresh); return; }
  if (g.leadPending && pos.mode === 'gps') {
    g.leadPending = false;
    if (hav(pos, g.trip.a) > 400 && online()) { reroute(true); return; }
  }
  if (!pos.onRoute) {
    g.offRoute = pos.mode === 'gps' && pos.off > 80;      // «поза маршрутом» — лише за справжнім GPS, не за вишками
    const far = pos.off > 1500;              // далеко від маршруту — питаємо, навіть якщо машина стоїть
    onSince = 0;
    if (pos.mode === 'gps' && pos.off > 80 && (pos.spd >= 1.5 || far)) {
      if (!offSince) offSince = now;
      // (1.1.28) сам маршрут НЕ перебудовуємо: один раз на з'їзд пропонуємо — і чекаємо відповіді. Не підтвердили — ведемо запланованим;
      // удруге про той самий з'їзд не питаємо (водій знає, куди їде). Перебудувати можна будь-коли: дотик до плашки «Ви зійшли з рейсу».
      if (now - offSince > (far ? 3000 : 8000) && !offAsked && !g.offer && !g.rerouting && now - lastReroute > 20000 && now - lastOfferEnd > 30000 && online()) offerOffRoute();
    } else offSince = 0;
  } else {
    offSince = 0; g.offRoute = false;
    if (g.offer && g.offer.kind === 'off') closeOffer('back');           // самі повернулись на рейс — питати вже нема про що
    // повернулись на рейс надовго (15 с) — наступний з'їзд буде новим, про нього спитаємо знову; коротке «зачепило лінію» не рахується
    if (offAsked) { if (!onSince) onSince = now; else if (now - onSince > 15000) { offAsked = false; onSince = 0; } }
  }

  const d = pos.rd == null ? 0 : pos.rd;
  if (g.route.aD != null && d >= g.route.aD - 80) g.passedA = true;
  if (g.route.viaD != null && d >= g.route.viaD - 80) g.passedV = true;
  saveFlags();

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
    if (g.remain < 45 && !g.arrived && pos.mode === 'gps') arrive();   // прибуття — лише за справжнім GPS
  } else if (g.offRoute && !g.arrived && pos.mode === 'gps' && g.trip && g.trip.b && hav(pos, g.trip.b) < 60 && (!g.trip.v || g.passedV)) {
    arrive();   // (1.1.28) під'їхали до фінішу не тією дорогою, що в рейсі (маршрут не перебудовували) — це теж прибуття
  }
  bus.emit('guide', g);
}

function arrive() {
  g.arrived = true; g.active = false; clearActive(); closeOffer('arrived'); say(t('voiceArrived'), { urgent: true });
  bus.emit('arrived', g);
}

export function init() { bus.on('pos', update); }
