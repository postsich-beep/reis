// Ведення за маршрутом: наступний маневр, голос, прибуття, перерахунок при з'їзді.
import { bus, log, S, RouteIndex, hav, clamp, db } from './core.js';
import { pos, setRoute, holdRejoin } from './nav.js';
import { speak, stopSpeak, online } from './platform.js';
import { buildRoute, viasOf, setVias, viaSlot, VIA_MAX } from './route.js';
import { t } from './i18n.js';

export const g = {
  trip: null, route: null, idx: null, active: false, arrived: false,
  manI: 0, next: null, after: null, distNext: 0, remain: 0, remTime: 0, eta: 0,
  rerouting: false, offRoute: false, passedA: true, passedV: false, passedN: 0, leadPending: false, reroutePending: null,
  offer: null,               // (1.1.28) пропозиція, що чекає на відповідь водія: { id, kind, title, text, secs, at, until, actions: [{ id, label, pri }] }
  choice: null               // (1.1.28) вибір нового маршруту в дорозі: { id, state: 'load' | 'ready', routes: [{ kind, r }], sel, until }
};
let said = {}, offSince = 0, lastReroute = 0, lastManI = -1;
// (1.1.28) Маршрут у дорозі САМ не перебудовується. З'їхали з рейсу чи сталося щось інше — показуємо пропозицію з причиною, читаємо її вголос
// і чекаємо OFFER_SECS секунд. Підтвердили — перебудовуємо; ні (або час вийшов) — ведемо далі запланованим рейсом.
export const OFFER_SECS = 10, CHOICE_SECS = 30;          // на вибір нового маршруту — 30 с; кожен дотик до картки дає ще 30
let offerT = 0, offerSeq = 0, offAsked = false, onSince = 0, lastOfferEnd = 0, choiceT = 0;
// (1.1.37) «Зійшов з рейсу — перебудувати самому» (S.offMode, типово 'auto'). У дорозі на запитання ніхто не відповідає (Діма: «все одно
// тягне своїми дорогами, перебудовується в половині випадків»), тож картка тепер лише попереджає: за AUTO_SECS секунд програма сама
// прокладе шлях ЗВІДСИ — вперед тією дорогою, якою водій поїхав. Повертає на вибраний рейс лише тоді, коли це майже нічого не коштує
// (заїхали на АЗС, стоянку); з'їхали вдруге поспіль — водій їде по-своєму: перебудовуємо одразу, без картки й без повернення.
// S.offMode = 'ask' — як було в 1.1.28: спитати й чекати, без відповіді нічого не міняти.
export const AUTO_SECS = 6, AUTO_STREAK_MS = 180000, AUTO_BACK_S = 120;
let autoAt = 0, autoBusy = false, wasOff = 0;
const offAuto = () => S.offMode !== 'ask';

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
  db.set('kv', ACTIVE_KEY, { trip: { ...g.trip, route: undefined }, route: r, passedA: g.passedA, passedV: g.passedV, passedN: g.passedN, at: Date.now() }).catch(() => {});
}
let flagsSaved = '';
function saveFlags() { const k = g.passedA + ':' + g.passedN; if (k !== flagsSaved) { flagsSaved = k; saveActive(); } }
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
    g.passedA = !!s.passedA || g.passedA;
    viaPassed(Math.max(g.passedN, s.passedN != null ? +s.passedN : s.passedV ? viasOf(g.trip).length : 0));
    say(t('voiceResume'));
    bus.emit('trip', g);
    log('info', 'рейс відновлено після перезапуску');
    return true;
  } catch (e) { log('warn', 'відновлення рейсу: ' + e.message); return false; }
}

// (1.1.32) Пройдені контрольні точки: g.passedN — скільки (вони йдуть по порядку), g.passedV — чи пройдено всі
let viaDone = [], viaBase = 0;
function viaPassed(n) { const all = viasOf(g.trip).length; g.passedN = Math.max(0, Math.min(all, n)); g.passedV = g.passedN >= all; }
function applyRoute(route, resumed = false) {
  g.route = route; g.idx = new RouteIndex(route.coords);
  for (const m of route.mans) m.d0 = g.idx.cum[Math.min(m.i0, g.idx.cum.length - 1)];
  g.manI = 0; lastManI = -1; said = {}; offSince = 0; g.offRoute = false; offAsked = false; onSince = 0;
  if (g.offer) closeOffer('route');
  if (g.choice) closeChoice('route');
  g.passedA = route.aD == null;
  viaDone = (route.viaDs || (route.viaD != null ? [route.viaD] : [])).map(d => d == null);     // точку не знайдено на лінії — стежити за нею не можемо
  viaBase = route.viaDs ? route.viaBase || 0 : 0;
  viaPassed(viaBase + viaDone.filter(Boolean).length);
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
  for (const v of viasOf(g.trip).slice(g.passedN)) { const lv = idx.locate(v, null); if (lv && lv.d > l.d) pts.push({ lat: v.lat, lon: v.lon, d: lv.d }); }
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
  for (const v of viasOf(g.trip)) { const lv = idx.locate(v, null); if (lv && lv.off < 400) pts.push({ lat: v.lat, lon: v.lon, d: lv.d }); else return null; }
  return pts.sort((a, b) => a.d - b.d).map(({ lat, lon, brg }) => brg == null ? { lat, lon } : { lat, lon, brg });
}
async function buildLead(heading) {
  const through = leadThrough(g.trip.route || g.route);
  if (through) { try { return await buildRoute(g.trip, { from: pos, heading, through }); } catch (e) { log('warn', 'підведення до А вибраним рейсом: ' + e.message); } }
  return buildRoute(g.trip, { from: pos, heading });
}
export async function startTrip(trip, opts = {}) {
  g.trip = trip; g.active = true; g.arrived = false; g.reroutePending = null; lastOfferEnd = 0; autoAt = 0; wasOff = 0; holdRejoin(0);
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
  clearActive(); closeOffer('stop'); closeChoice('stop');
  g.active = false; g.trip = null; g.route = null; g.idx = null; g.next = null; g.arrived = false; g.rerouting = false; g.reroutePending = null;
  setRoute(null); queue.length = 0;
  bus.emit('route', g); bus.emit('trip', g); bus.emit('guide', g);
}

/* ---------- (1.1.28) пропозиція перебудувати маршрут: вікно з причиною, зворотний відлік, голос ---------- */
// o: { kind, title, text, voice, secs, actions: [{ id, label, pri, run }] }. Одна пропозиція за раз; нова замінює стару.
// Жодну дію не вибрали (час вийшов або «Лишити») — нічого не міняється: ведемо запланованим рейсом.
export function propose(o) {
  if (!g.active || !g.trip) return false;
  if (g.offer) closeOffer('replaced');
  const secs = o.secs || OFFER_SECS, now = Date.now();
  // def — що станеться саме, коли час вийде ({ id, label, run }); без неї нічого не міняється («Лишити як є»)
  g.offer = { id: ++offerSeq, kind: o.kind || 'info', title: o.title || '', text: o.text || '', secs, at: now, until: now + secs * 1000, actions: o.actions || [], def: o.def || null };
  log('info', 'пропозиція щодо маршруту: ' + g.offer.kind + ' — ' + g.offer.title);
  bus.emit('offer', g.offer);
  if (o.voice) say(o.voice, { urgent: true });
  clearTimeout(offerT); offerT = setTimeout(() => answerOffer(null, 'timeout'), secs * 1000);
  return true;
}
function closeOffer(why) {
  if (!g.offer) return null;
  const o = g.offer; g.offer = null; clearTimeout(offerT); offerT = 0; lastOfferEnd = Date.now();
  bus.emit('offerEnd', { why, offer: o });
  return o;
}
// Відповідь водія: act — id дії з картки ('new', 'back'); порожньо — «Лишити» або час вийшов (why = 'timeout').
export function answerOffer(act, why) {
  const cur = g.offer, def = cur && cur.def;
  const a = cur && act ? cur.actions.find(x => x.id === act) || (def && def.id === act ? def : null) : (why === 'timeout' && def ? def : null);
  const o = closeOffer(why || (a ? a.id : 'no')); if (!o) return;
  log('info', 'пропозиція ' + o.kind + ': ' + (a ? (why === 'timeout' ? 'час вийшов — ' : 'вибрано ') + '«' + a.label + '»' : why === 'timeout' ? 'не підтверджено — лишаюсь на запланованому рейсі' : 'відхилено — лишаюсь на запланованому рейсі'));
  if (a) { if (a.run) a.run(); }
  else if (why === 'timeout') say(t('rrStayVoice'));
}
// З'їхали з рейсу: програма нічого не міняє сама, а питає — прокласти НОВИЙ маршрут звідси (кілька варіантів на вибір) чи повернутись
// на запланований. manual — водій сам торкнувся плашки «Ви зійшли з рейсу» (питаємо знову, без голосу).
export function offerOffRoute(manual = false) {
  if (!g.active || !g.trip || g.rerouting || g.choice || pos.lat == null) return false;
  if (!online() && pos.mode === 'gps') { if (manual) bus.emit('offerNoNet'); return false; }
  offAsked = true;
  if (offAuto() && !manual) {
    // щойно самі перебудували, а водій знову з'їхав — він їде по-своєму: одразу новий шлях звідси, без запитань
    if (Date.now() - autoAt < AUTO_STREAK_MS) { log('info', 'знову з\'їхали одразу після перебудови — прокладаю звідси без запитань'); autoReroute(true); return true; }
    return propose({
      kind: 'off', title: t('rrOffTitle'), text: (pos.off > 150 ? t('rrOffDist', distShort(pos.off)) + ' ' : '') + t('rrAutoText'), voice: t('rrAutoVoice'), secs: AUTO_SECS,
      actions: [{ id: 'back', label: t('rrBack'), run: () => { lastReroute = 0; reroute(); } }],
      def: { id: 'auto', label: t('rrAutoGo'), run: () => { autoReroute(false); } }
    });
  }
  return propose({
    kind: 'off', title: t('rrOffTitle'), text: (pos.off > 150 ? t('rrOffDist', distShort(pos.off)) + ' ' : '') + t('rrOffText'),
    voice: manual ? '' : t('rrOffVoice'),
    actions: [{ id: 'new', label: t('rrNew'), pri: true, run: () => { newRouteChoice(); } }, { id: 'back', label: t('rrBack'), run: () => { lastReroute = 0; reroute(); } }]
  });
}
const distShort = m => m < 950 ? (Math.round(m / 50) * 50 || 50) + ' м' : (m < 9500 ? (Math.round(m / 100) / 10).toFixed(1).replace('.', ',').replace(',0', '') : Math.round(m / 1000)) + ' км';

/* ---------- (1.1.28) новий маршрут із поточного місця: кілька варіантів для всіх видів рейсу — водій вибирає й підтверджує ---------- */
// Види: фура «суворо» й «на свій розсуд» (дорогами загального користування); для легкової — лише легкова. Однакові шляхи не дублюємо.
const sameRoute = (a, b) => {
  if (Math.abs(a.dist - b.dist) > Math.max(250, a.dist * 0.012)) return false;
  const ia = new RouteIndex(a.coords), ib = new RouteIndex(b.coords);
  return [0.2, 0.4, 0.6, 0.8].every(f => { const p = ia.at(ia.total * f), l = ib.locate(p, null); return l && l.off < 90; });
};
function closeChoice(why) {
  if (!g.choice) return null;
  const c = g.choice; g.choice = null; clearTimeout(choiceT); choiceT = 0; lastOfferEnd = Date.now();
  bus.emit('choice', null); bus.emit('choiceEnd', { why, choice: c });
  return c;
}
export async function newRouteChoice() {
  if (!g.active || !g.trip || g.choice || g.rerouting || pos.lat == null) return false;
  if (g.offer) closeOffer('choice');
  const c = g.choice = { id: ++offerSeq, state: 'load', routes: [], sel: 0, at: Date.now(), until: 0 }, tr = g.trip;
  const alive = () => g.choice === c && g.active && g.trip === tr;
  bus.emit('choice', c); say(t('rrCalcVoice'), { urgent: true });
  const kinds = S.vehicle === 'auto' ? ['car'] : tr.costing === 'auto' ? ['free', 'strict'] : ['strict', 'free'];
  const heading = pos.spd > 2 ? pos.hdg : null, from = { lat: pos.lat, lon: pos.lon };
  let err = null;
  for (let k = 0; k < kinds.length && alive(); k++) {
    const kind = kinds[k];
    if (k) await new Promise(r => setTimeout(r, 1100));              // публічний сервер — не частіше запиту на секунду
    if (!alive()) return false;
    try {
      const like = { ...tr, costing: kind === 'strict' ? 'truck' : 'auto', soft: kind === 'strict' ? tr.soft : null };
      const r = await buildRoute(like, { from, heading, skipA: g.passedA, skipVia: g.passedN, alternates: 1, altsFrom: true });
      if (!alive()) return false;
      const got = [r, ...(r.alts || [])]; delete r.alts;
      for (const x of got) {
        const real = x.costing === 'truck' ? 'strict' : kind === 'car' ? 'car' : 'free';   // для фури шляху не знайшлося — це вже «на свій розсуд»
        if (!c.routes.some(o => sameRoute(o.r, x))) c.routes.push({ kind: real, r: x });
      }
      if (c.routes.length && !c.until) { c.until = Date.now() + (S.choiceSecs || CHOICE_SECS) * 1000; choiceT = setTimeout(() => cancelChoice('timeout'), (S.choiceSecs || CHOICE_SECS) * 1000); }
      bus.emit('choice', c);
    } catch (e) { err = e; log('warn', 'новий маршрут (' + kind + '): ' + e.message); }
  }
  if (!alive()) return false;
  c.state = 'ready';
  if (!c.routes.length) { closeChoice('fail'); log('warn', 'новий маршрут: варіантів немає' + (err ? ' — ' + err.message : '')); return false; }
  bus.emit('choice', c); say(t('rrReadyVoice', c.routes.length));
  return true;
}
export function selectChoice(i) {
  const c = g.choice; if (!c || !c.routes[i]) return;
  c.sel = i;
  if (c.until) { const secs = S.choiceSecs || CHOICE_SECS; c.until = Date.now() + secs * 1000; clearTimeout(choiceT); choiceT = setTimeout(() => cancelChoice('timeout'), secs * 1000); }   // водій вибирає — час іде знову
  bus.emit('choice', c);
}
// Водій підтвердив варіант: відтепер це і є рейс (його ж запам'ятовуємо як «вибраний» — на нього й повертатимемо).
export function confirmChoice(i) {
  const c = g.choice; if (!c) return false;
  const it = c.routes[i == null ? c.sel : i]; if (!it || !g.trip) return false;
  const r = it.r, tr = g.trip;
  closeChoice('chosen');
  tr.costing = r.costing === 'truck' ? 'truck' : 'auto';
  if (it.kind === 'free') tr.free = true; else delete tr.free;
  tr.soft = ['alt', 'only', 'chosen'].includes(r.soft) ? (r.soft === 'only' ? 'only' : 'chosen') : null;
  tr.chosen = chosenOf(r);
  log('info', 'новий маршрут затверджено: ' + it.kind + ', ' + Math.round(r.dist / 1000) + ' км');
  lastReroute = Date.now();
  applyRoute(r); say(t('rrNewVoice'), { urgent: true });
  if (r.truckFail) bus.emit('truckFail', r);
  return true;
}
export function cancelChoice(why = 'no') {
  const c = closeChoice(why); if (!c) return;
  log('info', 'новий маршрут не вибрано (' + why + ') — лишаюсь на запланованому рейсі');
  if (why === 'timeout') say(t('rrStayVoice'));
}

/* (1.1.37) Сама перебудова після з'їзду. Рахуємо шлях звідси вперед (за курсом). Якщо водій ще не «з'їжджав удруге» й має вибраний рейс —
   рахуємо ще й повернення на нього та порівнюємо: повернення беремо, лише коли воно довше не більш як на 2 хв (чи 3 %) — так АЗС
   і стоянка не «з'їдають» варіант, який водій вибрав перед рейсом, а справжня інша дорога дає новий шлях уперед.
   force — без GPS (місце щойно поставив водій або GPS зник секунди тому): перебудовуємо від нього; без інтернету — щойно з'явиться зв'язок. */
async function autoReroute(freshOnly = false, force = false, hdg = null) {
  if (!g.trip || !g.active || pos.lat == null) return false;
  if (g.rerouting || autoBusy) { if (force) g.reroutePending = { lead: false, fresh: true, force: true, auto: true }; return false; }
  if (pos.mode !== 'gps' && !force) return false;
  if (!online()) {
    if (force) { g.reroutePending = { lead: false, fresh: true, force: true, auto: true }; log('info', 'перебудова звідси: інтернету немає — виконаю, щойно з\'явиться'); bus.emit('autoFail', { net: true }); bus.emit('guide', g); }
    else { offAsked = false; lastOfferEnd = Date.now(); }
    return false;
  }
  g.reroutePending = null;
  if (g.offer) closeOffer('reroute');
  if (g.choice) closeChoice('reroute');
  const tr = g.trip, alive = () => g.active && g.trip === tr;
  autoBusy = true; g.rerouting = true; lastReroute = Date.now(); bus.emit('guide', g);
  let ok = false;
  try {
    const heading = hdg != null ? hdg : pos.mode === 'gps' && pos.spd > 2 ? pos.hdg : null, from = { lat: pos.lat, lon: pos.lon };
    const through = freshOnly || force || S.keepChosen === false ? null : throughChosen();
    const F = await buildRoute(tr, { from, heading, skipA: g.passedA, skipVia: g.passedN });
    let pick = F, kind = 'fresh';
    if (through && alive()) {
      await new Promise(r => setTimeout(r, 1100));                     // публічний сервер — не частіше запиту на секунду
      try {
        const C = await buildRoute(tr, { from, heading, through }), extra = C.time - F.time;
        if (extra <= Math.max(AUTO_BACK_S, 0.03 * F.time)) { pick = C; kind = 'chosen'; }
        log('info', `з'їзд: шлях звідси ${Math.round(F.dist / 1000)} км / ${Math.round(F.time / 60)} хв, повернення на вибраний рейс ${extra >= 0 ? '+' : '−'}${Math.round(Math.abs(extra) / 60)} хв — ${kind === 'chosen' ? 'повертаю на вибраний' : 'веду новим шляхом'}`);
      } catch (e) { log('warn', 'повернення на вибраний маршрут: ' + e.message); }
    }
    if (alive()) {
      if (kind === 'fresh') tr.chosen = chosenOf(pick);
      holdRejoin(0);
      applyRoute(pick); autoAt = Date.now(); ok = true;
      say(t(kind === 'chosen' ? 'voiceRejoin' : 'voiceAuto'), { urgent: true });
      if (pick.truckFail) bus.emit('truckFail', pick);
      bus.emit('autoRoute', { kind, force, km: Math.round(pick.dist / 1000) });
    }
  } catch (e) {
    log('warn', 'перебудова після з\'їзду: ' + e.message);
    if (force && alive()) { g.reroutePending = { lead: false, fresh: true, force: true, auto: true }; bus.emit('autoFail', { net: !online(), msg: e.message }); }
  }
  autoBusy = false; g.rerouting = false;
  if (!ok) { offAsked = false; lastOfferEnd = Date.now() + 20000; }     // не вийшло (сервер, зв'язок) — спробуємо ще раз за пів хвилини
  bus.emit('guide', g);
  return ok;
}
/** (1.1.37) Без GPS водій поставив «Я тут» осторонь рейсу: він їде іншою дорогою — прокладаємо рейс від цього місця (не в режимі «питати»). */
export function rerouteFromHere() {
  if (!g.active || !g.trip || pos.lat == null || !offAuto()) return false;
  holdRejoin(15 * 60000);                                                // поки нового рейсу немає — на старий позначку не повертаємо
  autoReroute(true, true);
  return true;
}

async function reroute(lead = false, fresh = false, force = false) {
  if (!g.trip) return;
  if (g.rerouting) { if (force) g.reroutePending = { lead, fresh: true, force: true }; return; }      // контрольну точку поставили під час перерахунку — ще раз, уже з нею
  // Без GPS рейс НЕ перебудовуємо: місце лише розраховане, перебудова від нього може повести не туди.
  // Прохання водія («новий шлях») запам'ятовуємо й виконуємо, щойно GPS повернеться.
  // (1.1.32) Виняток — контрольна точка, яку водій сам поставив на карті (force): він бачить дорогу й вирішив їхати через неї —
  // перебудовуємо одразу від розрахованого місця. Без інтернету — щойно з'явиться зв'язок.
  if (pos.mode !== 'gps' && !force) {
    const was = g.reroutePending;
    g.reroutePending = { lead: lead || !!(was && was.lead), fresh: fresh || !!(was && was.fresh), force: !!(was && was.force) };
    if (!was) { log('info', 'перебудову рейсу відкладено до GPS'); bus.emit('rerouteWait', g.reroutePending); }
    bus.emit('guide', g); return;
  }
  if (force && !online()) {
    const was = g.reroutePending;
    g.reroutePending = { lead: lead || !!(was && was.lead), fresh: true, force: true };
    log('info', 'контрольна точка: інтернету немає — перебудую, щойно з\'явиться'); bus.emit('rerouteNet', g.reroutePending);
    bus.emit('guide', g); return;
  }
  g.reroutePending = null;
  if (g.offer) closeOffer('reroute');
  if (g.choice) closeChoice('reroute');
  g.rerouting = true; lastReroute = Date.now(); bus.emit('guide', g);
  try {
    const heading = pos.spd > 2 ? pos.hdg : null;
    // з'їхали — повертаємо на вибраний маршрут (точки вздовж нього); «новий шлях» — лише на прохання водія
    const through = lead || fresh || S.keepChosen === false ? null : throughChosen();
    let r = null;
    if (through) { try { r = await buildRoute(g.trip, { from: pos, heading, through }); } catch (e) { log('warn', 'повернення на вибраний маршрут: ' + e.message); } }
    if (!r && lead) r = await buildLead(heading);                       // підведення до А — тим самим вибраним рейсом
    if (!r) r = await buildRoute(g.trip, { from: pos.lat != null ? pos : viasOf(g.trip)[g.passedN] || g.trip.a, heading, skipA: lead ? false : g.passedA, skipVia: pos.lat != null ? g.passedN : g.passedN + 1 });
    if (fresh) g.trip.chosen = chosenOf(r);
    if (g.active) {
      applyRoute(r); say(t(force ? 'voiceViaRoute' : through ? 'voiceRejoin' : 'voiceReroute'));
      if (r.truckFail) bus.emit('truckFail', r);         // для фури проїзду немає — веду звичайним, водій попереджений
      if (force) bus.emit('viaRouted', r);
    }
  } catch (e) { log('warn', 'перерахунок: ' + e.message); if (force) { if (!online()) g.reroutePending = { lead, fresh: true, force: true }; bus.emit('viaFail', { net: !online(), msg: e.message }); } }
  g.rerouting = false; bus.emit('guide', g);
}
// Заїхати по дорозі / контрольна точка: точка стає ще однією проміжною (туди, де дає найменший гак, але не раніше пройдених),
// маршрут перебудовується від поточного місця одразу — і без GPS теж (водій сам бачить, куди їде). Повертає номер точки або -1.
export function setVia(p) {
  if (!g.trip || !p) return -1;
  const vs = viasOf(g.trip).slice(), pt = { lat: p.lat, lon: p.lon, label: p.label || '' };
  if (vs.length >= VIA_MAX) { const left = vs.slice(g.passedN); if (!left.length && g.passedN) { vs.splice(0, g.passedN); g.passedN = 0; } else { bus.emit('viaMax', VIA_MAX); return -1; } }
  const i = viaSlot(pos.lat != null ? pos : null, vs.slice(g.passedN), g.trip.b, pt, 0) + g.passedN;
  vs.splice(i, 0, pt); setVias(g.trip, vs); viaPassed(g.passedN);
  lastReroute = 0; reroute(false, true, true);
  return i;
}
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
  if (g.reroutePending && g.reroutePending.auto) {
    // (1.1.37) відкладена перебудова «звідси» (не було зв'язку чи сервер не відповів): не частіше ніж раз на 15 с; ведення тим часом працює далі
    if (!g.rerouting && online() && now - lastReroute > 15000) { g.reroutePending = null; log('info', 'є зв\'язок — прокладаю рейс звідси'); autoReroute(true, pos.mode !== 'gps'); return; }
  } else if (g.reroutePending && (pos.mode === 'gps' || g.reroutePending.force) && !g.rerouting && online()) {
    const p = g.reroutePending;
    log('info', p.force && pos.mode !== 'gps' ? 'є зв\'язок — прокладаю через контрольну точку' : 'GPS є — виконую відкладену перебудову'); reroute(p.lead, p.fresh, !!p.force); return;
  }
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
      // (1.1.37) у режимі «перебудувати самому» — швидше (5 с) і частіше: якщо новий шлях не підійшов і водій їде далі по-своєму, наступний — за 12 с
      const auto = offAuto();
      if (now - offSince > (far ? 3000 : auto ? 5000 : 8000) && !offAsked && !g.offer && !g.choice && !g.rerouting && now - lastReroute > (auto ? 10000 : 20000) && now - lastOfferEnd > (auto ? 12000 : 30000) && online()) offerOffRoute();
      // їдемо іншою дорогою, а GPS може зникнути будь-якої миті: тоді позначку НЕ повертаємо на старий рейс (див. gpsLost нижче)
      if (auto && pos.spd >= 5 && now - offSince > 3000) { holdRejoin(20000); wasOff = now; }
    } else offSince = 0;
  } else {
    offSince = 0; g.offRoute = false;
    if (g.offer && g.offer.kind === 'off') closeOffer('back');           // самі повернулись на рейс — питати вже нема про що
    // повернулись на рейс надовго (15 с) — наступний з'їзд буде новим, про нього спитаємо знову; коротке «зачепило лінію» не рахується
    if (offAsked) { if (!onSince) onSince = now; else if (now - onSince > 15000) { offAsked = false; onSince = 0; } }
  }

  const d = pos.rd == null ? 0 : pos.rd;
  if (g.route.aD != null && d >= g.route.aD - 80) g.passedA = true;
  { const ds = g.route.viaDs || (g.route.viaD != null ? [g.route.viaD] : []); let ch = false;
    ds.forEach((vd, k) => { if (vd != null && !viaDone[k] && d >= vd - 80) { viaDone[k] = true; ch = true; } });
    if (ch) viaPassed(viaBase + viaDone.filter(Boolean).length); }
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
  g.arrived = true; g.active = false; clearActive(); closeOffer('arrived'); closeChoice('arrived'); say(t('voiceArrived'), { urgent: true });
  bus.emit('arrived', g);
}

export function init() {
  bus.on('pos', update);
  // (1.1.37) GPS зник саме тоді, коли водій уже їхав іншою дорогою, а новий шлях ще не проклали: остання точка — справжня,
  // прокладаємо від неї (інакше позначка стала б на старий рейс і поїхала ним — «іде в поле»)
  bus.on('gpsLost', d => {
    if (!g.active || !g.trip || !offAuto() || !d || d.reason === 'manual' || pos.onRoute || !wasOff) return;
    if (Date.now() - wasOff > 20000) return;
    log('info', 'GPS зник після з\'їзду з рейсу — прокладаю від останньої справжньої точки');
    holdRejoin(15 * 60000); autoReroute(true, true, pos.spd > 2 ? pos.hdg : null);
  });
  bus.on('manualOff', () => { rerouteFromHere(); });
}
