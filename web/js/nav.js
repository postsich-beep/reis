// Двигун позиції: довіра до GPS, детектор підміни, розрахунок шляху без сигналу, ручна поправка ±100 м.
import { bus, log, S, hav, bearing, destPoint, inUkraine, clamp } from './core.js';
import { RouteTracker } from './drpf.js';

export const pos = {
  mode: 'none',            // 'none' — ще немає позиції, 'approx' — приблизно (вишки, Wi-Fi), 'gps' — довіряємо GPS, 'dr' — рахуємо самі
  lat: null, lon: null, hdg: 0, spd: 0, acc: null,
  raw: null,               // остання прийнята точка GPS
  lostSince: 0, reason: '', drDist: 0, accRef: 0, accBase: 15,
  pending: null,           // GPS повернувся, але показує іншу точку: чекаємо рішення водія
  rd: null, onRoute: false, off: 0,   // положення вздовж маршруту
  sats: null, sim: false, approxSrc: '', approxAge: 0,
  spoofAt: 0               // коли востаннє відкинули підроблену точку (за межами України, неможлива швидкість, програма-підміна)
};

let route = null, routeInUA = true;
let lastFixT = 0, lastTick = Date.now(), vCruise = 0, net = null, compass = null;
let yawNow = null, yawRef = null, hdgRef = null;
let moving = true, stillT = 0, varStop = null, varMove = null;
let badRun = 0, cand = [], hadUA = false, simOn = false, timer = null, carry = 0, approxT = 0;
let netHist = [], apSpd = null, apSpdT = 0, apSpdErr = null;   // швидкість за зсувом вишок/Wi-Fi, коли GPS немає або підмінено
let vCruiseT = 0, motionT = 0;                  // коли востаннє бачили чесну швидкість GPS; коли її зберегли
const journal = [];                             // журнал GPS за останні 40 хв — для розбору, що саме віддає телефон
const J_MS = 40 * 60000;

const ema = (o, v, k = 0.1) => o == null ? v : o + (v - o) * k;
const MAX_SPD = 50;                          // 180 км/год — фура так не їде
// Обмежувач фури (налаштування «Обмежувач», км/год; 0 — вимкнено, як у легковика). Швидше фура не їде, тож:
//  • оцінка швидкості без GPS (розрахунок, вишки, збережена) ніколи не більша за обмежувач;
//  • GPS, що показує на 15 км/год більше за обмежувач, — не наша швидкість: так підміна «затягує» приймач
//    (точки плавні, а швидкість росте 94 → 130). Саме так на М-03 з'явилось «≈106 оцінка».
const vmaxKmh = () => { if (S.vehicle === 'auto') return 0; const v = +((S.truck || {}).vmax); return v > 0 ? v : 0; };   // легковик — без обмежувача
const VMAX = () => vmaxKmh() ? vmaxKmh() / 3.6 : MAX_SPD;          // м/с — стеля для будь-якої оцінки
const SUS_SPD = () => vmaxKmh() ? (vmaxKmh() + 15) / 3.6 : MAX_SPD; // м/с — вище цього GPS для фури неправдоподібний
const startT = Date.now();
let lockT = 0, netInnov = [], manualSpd = null, manualSpdT = 0;
let turns = [], yawHist = [], lastTurnEv = 0, holdSince = 0, gyroSeen = 0, heldTurn = null, plan = [];
// 1.1.8: без GPS по рейсу веде «хмара» можливих положень (drpf.js), звірена з гіроскопом на кожному повороті.
// Старий фільтр (kf) лишився запасним: без рейсу і для порівняння на стенді (S.drAlgo = 'kf').
let trk = null, trkFor = null, trkCal = null;
const usePf = () => S.drAlgo !== 'kf';
function tracker() {
  if (!route) return null;
  if (trkFor !== route) { trk = new RouteTracker(route, { planFn: planSpeed, vmax: VMAX(), ...(S.drOpts || {}) }); trkFor = route; }
  return trk;
}
export const drTracker = () => (trk && trk.on && pos.mode === 'dr') ? trk : null;
// звідки контрольні точки рейсу (для карти й підказок): є навіть до втрати GPS
export function routeCps() { const t = tracker(); return t ? t.cps : []; }
/* ---------- фільтр «місце і швидкість уздовж маршруту» (без GPS) ----------
   Один стан на все: d — де ми на маршруті, v — швидкість, P — наскільки впевнені. Кожну секунду: d += v·dt.
   Вишки й Wi-Fi проєктуються на маршрут (помилка вбік на 1,5 км тоді не заважає) і м'яко тягнуть d і v.
   Швидкість, коли її ніхто не каже: плановa швидкість ділянки (з маршруту, не більша за обмежувач) — тож позначка
   не стоїть, якщо машина їде. Акселерометр каже «стоїмо» — v = 0. Водій назвав швидкість — вона головна.
   Так поводиться BlindDriver: метка не зупиняється, похибку виправляють ±100 і вишки. */
const kf = { on: false, d: 0, v: 0, Pdd: 0, Pdv: 0, Pvv: 0, src: '', out: [] };
// Якість супутникового сигналу (AGC, C/N0) і еталон цього телефона, знятий, поки GPS справжній
export const gq = { agc: null, cn0: null, n: 0, t: 0, agcBase: null, cnBase: null, verdict: '' };

// Чи схожа точка на справжню. Підміна в Україні переносить телефон у Перу, Москву тощо — такі точки не беремо ніколи.
function fake(f, now) {
  if (!S.spoof || f.sim && !f.spoofSim) return '';
  if (f.mock) return 'mock';
  if (!inUkraine(f)) return 'bounds';
  if (f.spd != null && f.spd > MAX_SPD) return 'speed';
  // Розбіжність із вишками — слабкий доказ: у полі мережеве місце буває хибним на 5–10 км (так було на М-03).
  // Тож відкидаємо лише великий розрив (понад 25 км) і не чіпаємо точку, що лежить на нашому маршруті
  // або плавно продовжує останній справжній трек — підміна так не поводиться.
  if (f.prov !== 'network' && net && now - net.rt < 60000 && net.acc <= 2500) {
    const dn = hav(net, f);
    const onRoute = route && (() => { const l = route.locate(f, pos.rd); return l && l.off < 120; })();
    const smooth = pos.raw && pos.mode === 'gps' && now - pos.raw.rt < 120000 && hav(pos.raw, f) / Math.max((now - pos.raw.rt) / 1000, 1) < 45;
    const sus = gq.verdict === 'spoof' && now - gq.t < 10000;
    if (!onRoute && !smooth && (dn > Math.max(25000, 6 * net.acc) || (sus && dn > 8000))) return 'net';
  }
  return '';
}
function spoofSeen(why, f) {
  const first = Date.now() - pos.spoofAt > 60000;
  pos.spoofAt = Date.now(); pos.spoofWhy = why; pos.spoofProv = f.prov; pos.spoofLat = +f.lat; pos.spoofLon = +f.lon; pos.spoofSpd = f.spd;
  if (first) log('warn', `підміна GPS (${why}, ${f.prov}): ${(+f.lat).toFixed(3)}, ${(+f.lon).toFixed(3)} — відкинуто`);
  bus.emit('spoof', { why, prov: f.prov });
}
// Остання чесна швидкість: переживає перезапуск, щоб у зоні підміни спідометр не падав у «—».
function saveMotion(now) {
  if (now - motionT < 5000 || pos.sim) return; motionT = now;
  try { localStorage.setItem('reis.motion', JSON.stringify({ v: Math.round(vCruise * 10) / 10, t: now })); } catch (_) {}
}
// Останнє справжнє місце: з нього стартуємо після перезапуску, якщо GPS підмінено.
let goodT = 0;
function saveGood() {
  const now = Date.now(); if (now - goodT < 20000 || pos.lat == null || pos.sim) return; goodT = now;
  try { localStorage.setItem('reis.lastGood', JSON.stringify({ lat: pos.lat, lon: pos.lon, t: now })); } catch (_) {}
}

// Планова швидкість ділянок маршруту (час Valhalla для фури) — запасна швидкість, коли інших немає
function makePlan(idx, mans) {
  const out = [];
  if (idx && mans) for (const m of mans) {
    const i0 = Math.min(m.i0, idx.cum.length - 1), i1 = Math.min(m.i1, idx.cum.length - 1), d0 = idx.cum[i0], d1 = idx.cum[i1];
    if (d1 - d0 > 30 && m.time > 0) out.push([d0, d1, (d1 - d0) / m.time]);
  }
  return out;
}
export function planSpeed(d) {
  const seg = plan.find(x => d >= x[0] && d < x[1]);
  return clamp(seg ? seg[2] : 16.7, 5, VMAX());        // невідомо — 60 км/год
}
export function setRoute(idx, mans = null) {
  const keepDr = pos.mode === 'dr' && route && idx && pos.onRoute;     // перебудова під час розрахунку — лишаємось на маршруті
  plan = makePlan(idx, mans); heldTurn = null;
  if (!idx || !keepDr) kf.on = false;
  route = idx; pos.rd = null; pos.onRoute = false; pos.off = 0;
  routeInUA = true;
  turns = idx ? findTurns(idx) : [];
  if (idx) for (let i = 0; i < idx.c.length; i += 200) if (!inUkraine({ lat: idx.c[i][0], lon: idx.c[i][1] })) { routeInUA = false; break; }
  if (idx && pos.lat != null) {
    const loc = idx.locate(pos, null);
    if (keepDr && loc && loc.off < 400) { pos.rd = loc.d; pos.onRoute = true; pos.off = 0; if (kf.on) kf.d = loc.d; }
    else matchRoute(pos, pos.spd);
  }
  if (idx && pos.mode === 'approx' && !simOn) tryLock();
}

/* ---------- ведення по маршруту без GPS ----------
   Коли GPS немає або йому не можна вірити, позначка не стрибає за вишками (у полі вони помиляються на кілометри),
   а їде маршрутом: остання чесна швидкість × час, зупинки — з акселерометра, повороти — з гіроскопа.
   Вишки лише м'яко виправляють, якщо розрахунок явно відстав чи випередив. Так само працює BlindDriver. */
function estimateRd() {
  if (!route) return null;
  let a = null, b = null;
  try {
    const lg = JSON.parse(localStorage.getItem('reis.lastGood') || 'null');
    if (lg && lg.lat != null && Date.now() - lg.t < 30 * 60000) {
      const l = route.locate(lg, null), age = (Date.now() - lg.t) / 1000;
      if (l && l.off < 300) a = { d: Math.min(route.total, l.d + (vCruise > 0.5 ? vCruise * age * 0.85 : 0)), sig: 150 + 0.25 * vCruise * age, src: 'last' };
    }
  } catch (_) {}
  if (net && Date.now() - net.rt < 120000) {
    const l = route.locate(net, a ? a.d : pos.rd);
    if (l && l.off < Math.max(6000, 3 * net.acc)) b = { d: l.d, sig: Math.max(1500, net.acc), src: 'net' };
  }
  if (a && b) return Math.abs(a.d - b.d) < 2 * b.sig + a.sig ? a : b;
  if (a || b) return a || b;
  // Ні свіжої справжньої точки, ні вишок (на Samsung без «Точності Google» мережевого місця немає зовсім):
  // беремо будь-яке відоме місце біля маршруту — далі поведе планова швидкість, а водій поправить («Де ви?», ±100).
  const cands = [];
  try { const lg = JSON.parse(localStorage.getItem('reis.lastGood') || 'null'); if (lg && lg.lat != null) cands.push(lg); } catch (_) {}
  if (pos.lat != null) cands.push({ lat: pos.lat, lon: pos.lon });
  for (const p of cands) { const l = route.locate(p, null); if (l && l.off < 5000) return { d: l.d, sig: 1500, src: 'stale' }; }
  return null;
}
function placeOnRoute(d, accBase, reason) {
  pos.rd = clamp(d, 0, route.total); pos.onRoute = true; pos.off = 0;
  const p = route.at(pos.rd); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = p.brg;
  if (pos.mode !== 'dr') { pos.mode = 'approx'; enterDR(reason); carry = 0; }    // оцінка вже врахувала час
  else pos.reason = reason;
  pos.accRef = pos.drDist; pos.accBase = accBase; pos.acc = Math.round(accBase); netInnov = []; holdSince = 0;
  kfInit(pos.rd, accBase);
  bus.emit('pos', pos);
}
// Старт фільтра: швидкість — від водія, з останнього чесного GPS, з Wi-Fi або планова.
function kfInit(d, sig) {
  const now = Date.now();
  let v, sv, src;
  if (manualSpd != null) { v = manualSpd; sv = 1; src = 'manual'; }
  else if (vCruise > 0.5 && now - vCruiseT < 10 * 60000) { v = Math.min(vCruise, VMAX()); sv = 2.5; src = 'gps'; }
  else if (apSpd != null && now - apSpdT < 60000) { v = Math.min(apSpd, VMAX()); sv = Math.max(3, apSpdErr || 3); src = 'net'; }
  else { v = planSpeed(d); sv = 7; src = 'plan'; }
  Object.assign(kf, { on: true, d, v, Pdd: sig * sig, Pdv: 0, Pvv: sv * sv, src, out: [], measT: 0 });
  if (usePf() && tracker()) { trk.init(d, Math.max(sig, 15), v, Math.max(sv, 1.5), now / 1000, src === 'gps' || src === 'manual'); trkCal = { sig: trk.est.sig, t: now }; }
}
// Вишки/Wi-Fi: точка, спроєктована на маршрут. Викиди (стрибок вишки на 10 км) ігноруємо, доки 3 поспіль не скажуть те саме.
function kfMeasure(z, acc) {
  const R = Math.pow(Math.max(acc * 0.7, 250), 2), inn = z - kf.d, S = kf.Pdd + R;
  if (inn * inn > 9 * S) {
    kf.out.push(inn); if (kf.out.length > 3) kf.out.shift();
    if (kf.out.length < 3 || !kf.out.every(x => Math.sign(x) === Math.sign(inn) && Math.abs(x - inn) < 3 * Math.sqrt(R))) return false;
    kf.Pdd += inn * inn; kf.Pdv = 0; kf.Pvv = Math.max(kf.Pvv, 25);   // три поспіль — ми справді не там: довіряємо вишкам і заново вчимо швидкість
  }
  kf.out = [];
  const S2 = kf.Pdd + R, Kd = kf.Pdd / S2, Kv = kf.Pdv / S2;
  kf.d += Kd * inn; if (manualSpd == null) kf.v = clamp(kf.v + Kv * inn, 0, VMAX());
  const Pdd = kf.Pdd, Pdv = kf.Pdv;
  kf.Pdd = (1 - Kd) * Pdd; kf.Pdv = (1 - Kd) * Pdv; kf.Pvv = kf.Pvv - Kv * Pdv;
  if (kf.src === 'plan' && kf.Pvv < 12) kf.src = 'net';
  kf.d = clamp(kf.d, 0, route.total); kf.measT = Date.now();
  return true;
}
// Автоматично: рейс іде, GPS підмінено або давно немає, а вишки кажуть, що ми десь біля маршруту.
function tryLock() {
  const now = Date.now();
  if (!route || pos.mode !== 'approx' || now - lockT < 5000) return;
  const noGps = now - Math.max(lastFixT, startT) > 45000, spoof = now - pos.spoofAt < 300000;
  if (!noGps && !spoof) return;
  lockT = now;
  const e = estimateRd(); if (!e) return;
  log('info', `ведення по маршруту без GPS: старт з ${e.src === 'last' ? 'останньої справжньої точки' : 'вишок'}, ±${Math.round(e.sig)} м`);
  placeOnRoute(e.d, clamp(e.sig, 100, 3000), spoof ? 'spoof' : 'timeout');
}
// Вручну: «На маршрут» — з найкращої оцінки або з точки, яку водій указав на карті.
export function snapToRoute(p = null) {
  if (!route) return false;
  if (p) { const l = route.locate(p, pos.rd); if (!l || l.off > 600) return false; placeOnRoute(l.d, 60, 'manual'); return true; }
  const e = estimateRd() || (pos.lat != null ? (() => { const l = route.locate(pos, pos.rd); return l ? { d: l.d, sig: Math.max(300, l.off) } : null; })() : null);
  if (!e) return false;
  placeOnRoute(e.d, clamp(e.sig, 100, 3000), 'manual');
  return true;
}
// «Де ви?»: водій вибрав місто чи орієнтир на маршруті — ставимо туди позначку й ведемо далі.
export function placeAtD(d) { if (!route) return false; placeOnRoute(d, 400, 'manual'); return true; }
export const estimateNow = () => estimateRd();
// Швидкість від водія (спідометр фури): поки GPS немає, рахуємо за нею. 0 — «стою». null — авто.
export function setManualSpeed(kmh) {
  manualSpd = kmh == null ? null : Math.max(0, kmh) / 3.6; manualSpdT = Date.now();
  if (kf.on) { if (manualSpd != null) { kf.v = manualSpd; kf.Pvv = 1; kf.src = 'manual'; } else { kf.src = 'plan'; kf.Pvv = 36; } }
  if (manualSpd != null && pos.mode !== 'dr' && pos.mode !== 'gps' && route) snapToRoute();
  bus.emit('pos', pos);
}
export const manualSpeed = () => manualSpd == null ? null : Math.round(manualSpd * 3.6);
// Вишки й Wi-Fi під час розрахунку по маршруту: у фільтр (місце і швидкість уздовж маршруту)
function netCorrect() {
  if (pos.mode !== 'dr' || !route || !pos.onRoute || pos.rd == null || !kf.on) return;
  if (pos.reason === 'manual' && pos.drDist - pos.accRef < 1500) return;      // водій щойно сам поставив точку — перші 1,5 км вишкам не перебивати
  const l = route.locate(net, kf.d); if (!l || l.off > Math.max(6000, 3 * net.acc)) return;
  if (drTracker()) {
    const was = trk.est.d; trk.measure(l.d, net.acc); kf.d = trk.est.d; kf.measT = Date.now();
    if (Math.abs(trk.est.d - was) > 300) log('info', `розрахунок виправлено за вишками на ${Math.round(trk.est.d - was)} м`);
    pos.rd = trk.est.d; const p = route.at(pos.rd); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = p.brg;
    pos.acc = Math.round(clamp(trk.est.sig, 15, 9999)); pos.accBase = pos.acc; pos.accRef = pos.drDist;
    bus.emit('pos', pos); return;
  }
  const was = kf.d;
  if (kfMeasure(l.d, net.acc)) {
    if (Math.abs(kf.d - was) > 300) log('info', `розрахунок виправлено за вишками на ${Math.round(kf.d - was)} м`);
    pos.rd = kf.d; const p = route.at(pos.rd); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = p.brg;
    pos.acc = Math.round(Math.sqrt(kf.Pdd)); pos.accBase = pos.acc; pos.accRef = pos.drDist;
    bus.emit('pos', pos);
  }
}
// Різкі повороти маршруту (перехрестя, з'їзди, кільця): де гіроскоп має «відчути» поворот.
// Контрольні точки маршруту — повороти від 40°: і різкі (перехрестя, 70 м), і з'їзди (160 м), і плавні дуги (до 320 м).
// По них розрахункова позначка звіряється з гіроскопом: доганяє поворот або чекає, поки машина поверне.
export const TURN_MIN = 40;
const SPANS = [70, 160, 320];
function dirAt(idx, d, back) {                         // напрям дороги на 30 м до (back) чи після точки — без дрібних зламів лінії
  const a = idx.at(clamp(back ? d - 30 : d, 0, idx.total)), b = idx.at(clamp(back ? d : d + 30, 0, idx.total));
  return hav(a, b) > 3 ? bearing(a, b) : a.brg;
}
export function findTurns(idx) {
  const raw = [], step = 15;
  for (let d = 50; d < idx.total - 50; d += step) {
    for (const sp of SPANS) {
      const d0 = d - sp / 2, d1 = d + sp / 2; if (d0 < 0 || d1 > idx.total) continue;
      const ang = ((dirAt(idx, d1, false) - dirAt(idx, d0, true) + 540) % 360) - 180;
      if (Math.abs(ang) >= TURN_MIN) { raw.push({ d, ang, sp }); break; }
    }
  }
  // сусідні точки одного повороту — одна контрольна точка: найкрутіша, посередині повороту
  const out = [];
  for (const t of raw) {
    const last = out[out.length - 1];
    if (last && Math.sign(last.ang) === Math.sign(t.ang) && t.d - last.end <= Math.max(60, t.sp / 2)) {
      last.end = t.d; if (Math.abs(t.ang) > Math.abs(last.ang) + 2 || (Math.abs(t.ang) >= Math.abs(last.ang) - 2 && t.sp < last.sp)) { last.ang = t.ang; last.sp = t.sp; }
      last.d = Math.round((last.start + last.end) / 2);
      continue;
    }
    out.push({ d: t.d, ang: t.ang, sp: t.sp, start: t.d, end: t.d });
  }
  return out.map(t => ({ d: t.d, ang: Math.round(t.ang), sp: t.sp }));
}
// Гіроскоп відчув поворот: знаходимо такий самий поворот маршруту поблизу й ставимо позначку точно на нього.
function onTurn(ang, ago) {
  if (drTracker()) return;                                            // хмара звіряє повороти сама, безперервно
  if (pos.mode !== 'dr' || !route || !pos.onRoute || pos.rd == null || !turns.length) return;
  const v = curSpeed(), at = pos.rd - v * ago;                        // де ми були посеред повороту
  const w = clamp(300 + 0.25 * (pos.drDist - pos.accRef) + pos.accBase, 400, 3000);
  let best = null;
  for (const t of turns) {
    if (Math.abs(t.d - at) > w || Math.sign(t.ang) !== Math.sign(ang) || Math.abs(Math.abs(t.ang) - Math.abs(ang)) > Math.max(35, 0.6 * Math.abs(t.ang))) continue;
    if (!best || Math.abs(t.d - at) < Math.abs(best.d - at)) best = t;
  }
  if (!best) return;
  log('info', `поворот ${Math.round(ang)}° підтверджено гіроскопом: позначку зсунуто на ${Math.round(best.d + v * ago - pos.rd)} м`);
  pos.rd = clamp(best.d + v * ago, 0, route.total); holdSince = 0; heldTurn = best.d;
  if (kf.on) { kf.d = pos.rd; kf.Pdd = 40 * 40; kf.Pdv = 0; }
  const p = route.at(pos.rd); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = p.brg;
  pos.accRef = pos.drDist; pos.accBase = 40; pos.acc = 40;
  bus.emit('pos', pos); bus.emit('turnMatch', { ang: Math.round(ang), d: Math.round(best.d) });
}
// Гіроскоп: поворот від 28° (було 50° — удвічі чутливіше), і різкий, і плавна дуга до 35 с.
// Поворот рахуємо від спокійного курсу до спокійного курсу: обгін (туди й назад) і кільце «прямо» дають ~0 і не плутають.
export const YAW_MIN = 28;
export function detectTurn(hist, now) {
  const n = hist.length; if (n < 3) return null;
  const y = hist[n - 1].yaw;
  let k = n - 2; while (k > 0 && now - hist[k].t < 1500) k--;                          // замір ~2 с тому (чи попередній, якщо рідше)
  if (Math.abs(y - hist[k].yaw) > 5) return null;                                       // ще повертаємо — чекаємо кінця
  let s = -1, best = 0;
  for (let i = k; i >= 0; i--) {
    const h = hist[i]; if (now - h.t > 40000) break;
    const stable = (i < 1 || Math.abs(hist[i - 1].yaw - h.yaw) < 4) && (i < 2 || Math.abs(hist[i - 2].yaw - h.yaw) < 6);
    const dy = y - h.yaw;
    if (stable && Math.abs(dy) >= YAW_MIN && Math.abs(dy) > Math.abs(best) + 2) { best = dy; s = i; }
  }
  if (s < 0) return null;
  // початок — останній спокійний замір перед поворотом; кінець — перший замір, де курс уже майже остаточний
  let a = s; while (a + 1 < n && Math.abs(hist[a + 1].yaw - hist[s].yaw) < 3) a++;
  let e = a; while (e < n - 1 && Math.abs(y - hist[e].yaw) > 4) e++;
  return { dy: best, ago: (now - (hist[a].t + hist[e].t) / 2) / 1000 };
}
function onYaw(yaw) {
  const now = Date.now();
  if (trk) trk.addYaw(now / 1000, yaw, !moving);
  yawHist.push({ t: now, yaw }); while (yawHist.length && now - yawHist[0].t > 45000) yawHist.shift();
  const n = yawHist.length;
  if (n >= 4 && Math.abs(yaw - yawHist[n - 4].yaw) > 6) { moving = true; stillT = 0; }     // машина крутиться — отже, їде
  if (!moving || now - lastTurnEv < 4000) return;
  const tr = detectTurn(yawHist, now); if (!tr) return;
  lastTurnEv = now; gyroSeen = now; yawHist = [{ t: now, yaw }];
  onTurn(tr.dy, tr.ago);
}
// Поточна швидкість розрахунку: водій сказав → чесна швидкість GPS → Wi-Fi; стоїмо — 0.
function curSpeed() {
  if (manualSpd != null) return manualSpd;
  if (!moving) return 0;
  if (kf.on && pos.mode === 'dr') return kf.v;
  if (vCruise > 0.5) return Math.min(vCruise, VMAX());
  return apSpd != null && Date.now() - apSpdT < 60000 ? Math.min(apSpd, VMAX()) : 0;
}
export function setSim(on) {      // імітація і справжній GPS не змішуються: стан починаємо з чистого аркуша
  simOn = on; pos.sim = on; net = null; pos.raw = null; pos.pending = null; pos.reason = '';
  badRun = 0; cand = []; vCruise = 0; varStop = varMove = null; moving = true; pos.spd = 0;
  if (pos.mode === 'dr') { pos.mode = 'gps'; lastFixT = Date.now(); bus.emit('gpsBack', { err: 0, dur: 0, drDist: 0, reason: 'sim' }); }
}

function matchRoute(p, spd) {
  if (!route) { pos.onRoute = false; return null; }
  const loc = route.locate(p, pos.rd);
  if (!loc) { pos.onRoute = false; return null; }
  pos.off = loc.off;
  const tol = clamp((p.acc || 10) * 1.5, 45, 120);
  if (loc.off <= tol) { pos.onRoute = true; pos.rd = loc.d; return loc; }
  pos.onRoute = false; return null;
}

function accept(f) {
  const now = Date.now(); f.rt = now;
  let spd = f.spd;
  if ((spd == null || spd < 0) && pos.raw) {
    // Без швидкості у фіксі рахуємо за часом самого фікса, а не за часом, коли він дійшов: Android віддає фікси пачками,
    // і 25 м за 0,4 с (а насправді за 1 с) давали «183 км/год».
    const dt = f.t > 0 && pos.raw.t > 0 ? (f.t - pos.raw.t) / 1000 : (now - pos.raw.rt) / 1000;
    if (dt > 0.3 && dt < 10) spd = Math.min(hav(pos.raw, f) / dt, SUS_SPD());
  }
  if (spd == null || spd < 0) spd = 0;
  let hdg = pos.hdg || 0;
  if (spd >= 1.5) {
    if (f.brg != null) hdg = f.brg;
    else if (pos.raw && hav(pos.raw, f) > 3) hdg = bearing(pos.raw, f);
  } else if (pos.raw == null && compass != null) hdg = compass;
  if (spd > 3) { yawRef = yawNow; hdgRef = hdg; }
  const sv = Math.min(spd, VMAX());                       // крейсерська — не більша за обмежувач
  vCruise = vCruise > 0.5 ? vCruise * 0.6 + sv * 0.4 : sv;
  vCruiseT = now; saveMotion(now);
  if (inUkraine(f)) hadUA = true;
  pos.raw = f; lastFixT = now; pos.mode = 'gps';
  pos.lat = f.lat; pos.lon = f.lon; pos.acc = f.acc == null ? null : Math.round(f.acc); pos.spd = spd; pos.hdg = hdg;
  const loc = matchRoute(f, spd);
  if (loc && loc.off < 35) {              // притискаємо позначку до дороги
    pos.lat = loc.lat; pos.lon = loc.lon;
    if (spd < 1.5) pos.hdg = loc.brg;
  }
  saveGood();
  bus.emit('pos', pos);
}

// Швидкість за вишками й Wi-Fi: пряма через усі точки за 4 хвилини, кожна з вагою за своєю точністю.
// Показуємо, лише коли рух помітно більший за похибку; Wi-Fi у селах дає ±50 м і добру оцінку, голі вишки — рідко.
function netSpeed(p) {
  const last = netHist[netHist.length - 1];
  if (last && (last.t === p.t || (last.lat === p.lat && last.lon === p.lon && p.rt - last.rt < 30000))) return;   // той самий збережений фікс
  if (!(p.acc > 0 && p.acc <= 300)) return;          // голі вишки (±1–3 км) швидкості не дають: лише Wi-Fi-точність
  netHist.push(p); netHist = netHist.filter(x => p.rt - x.rt <= 240000);
  if (netHist.length < 3 || p.rt - netHist[0].rt < 45000) return;
  const kx = 111320 * Math.cos(p.lat * Math.PI / 180), ky = 111320;
  let W = 0, Wt = 0;
  const rows = netHist.map(x => {
    const s = clamp(x.acc || 1500, 25, 1500) / 1.4, w = 1 / (s * s), t = (x.rt - p.rt) / 1000;
    W += w; Wt += w * t;
    return { w, t, X: (x.lon - p.lon) * kx, Y: (x.lat - p.lat) * ky };
  });
  const tm = Wt / W; let Stt = 0, Stx = 0, Sty = 0;
  for (const r of rows) { const d = r.t - tm; Stt += r.w * d * d; Stx += r.w * d * r.X; Sty += r.w * d * r.Y; }
  if (!(Stt > 0)) return;
  const v = Math.hypot(Stx / Stt, Sty / Stt), sv = Math.sqrt(1 / Stt);
  if (v > VMAX() * 1.15) return;                         // фура так не їде — це стрибок між вишками, а не рух
  if (v > 2.5 * sv && sv < 4) { apSpd = v; apSpdErr = sv; apSpdT = p.rt; }
  else if (v + 2 * sv < 2.5) { apSpd = 0; apSpdErr = sv; apSpdT = p.rt; }
}
// Що показувати на спідометрі: справжня швидкість GPS, оцінка, «стоїть» або «невідомо».
export function speedView() {
  const fresh = apSpd != null && Date.now() - apSpdT < 60000, cap = v => Math.min(v, VMAX()) * 3.6;
  if (pos.mode === 'gps') return { kmh: pos.spd * 3.6, kind: 'gps' };
  if (manualSpd != null) return { kmh: manualSpd * 3.6, kind: manualSpd === 0 ? 'still' : 'manual' };
  if (!moving) return { kmh: 0, kind: 'still' };
  if (pos.mode === 'dr' && kf.on) return { kmh: cap(kf.v), kind: kf.src === 'plan' ? 'plan' : 'est' };
  if (pos.mode === 'dr' && vCruise > 0.5) return { kmh: cap(pos.spd), kind: 'est' };
  if (fresh && apSpd > 0.5 && apSpd <= VMAX() * 1.15) return { kmh: cap(apSpd), kind: 'approx' };
  // GPS підмінено, а машина їде: тримаємо останню чесну швидкість (навіть із до перезапуску), поки не мине 15 хв
  if (pos.mode === 'approx' && vCruise > 0.5 && Date.now() - vCruiseT < 15 * 60000 && Date.now() - pos.spoofAt < 120000) return { kmh: cap(vCruise), kind: 'est' };
  if (pos.mode === 'approx' && pos.spd > 0.5) return { kmh: cap(pos.spd), kind: 'approx' };
  return { kmh: null, kind: 'none' };
}

// Поки GPS не знайшов супутників: показуємо приблизне місце за вишками й Wi-Fi або останнє відоме.
function approx(f) {
  const active = pos.mode === 'none' || pos.mode === 'approx';
  const why = fake(f, Date.now());
  if (why) { if (active) spoofSeen(why, f); return 'rej:' + why; }      // поки GPS живий, про підміну судимо лише за ним самим
  if (f.prov === 'fused' && f.acc != null && f.acc < 3000) netSpeed({ lat: f.lat, lon: f.lon, acc: f.acc, rt: Date.now(), t: f.t });
  if (!active) return 'skip';
  if ((f.prov === 'last' || f.prov === 'saved') && pos.mode !== 'none') return 'skip';
  const age = f.age > 0 ? f.age : 0;
  if (age > 7 * 86400) return 'old';
  let acc = Math.round(f.acc || 1500); if (age > 600) acc = Math.max(acc, 1000);
  if (pos.mode === 'approx' && pos.acc != null && acc > pos.acc * 2 && Date.now() - approxT < 60000) return 'worse';   // свіжу кращу точку не міняємо на гіршу
  approxT = Date.now();
  pos.mode = 'approx'; pos.lat = f.lat; pos.lon = f.lon; pos.acc = acc;
  pos.spd = f.spd > 0 ? f.spd : 0;
  if (f.brg != null) pos.hdg = f.brg; else if (compass != null) pos.hdg = compass;
  pos.approxSrc = f.prov; pos.approxAge = age;
  matchRoute(pos, pos.spd);
  bus.emit('pos', pos);
  if (route && !simOn) tryLock();
  return 'approx';
}

function enterDR(reason) {
  if (pos.lat == null || pos.mode === 'dr') return;
  pos.mode = 'dr'; pos.reason = reason; pos.lostSince = Date.now(); kf.on = false;
  pos.drDist = 0; pos.accRef = 0; pos.accBase = clamp(pos.acc || 15, 15, 60);
  pos.pending = null; cand = []; badRun = 0;
  // Машина їхала й ті секунди, поки ми помічали втрату: надолужимо їх на першому ж кроці.
  carry = reason === 'manual' ? 0 : clamp((Date.now() - lastFixT) / 1000, 0, 15);
  log('warn', 'GPS: розрахунок без сигналу, причина=' + reason);
  bus.emit('gpsLost', { reason });
  bus.emit('pos', pos);
}

function exitDR(f) {
  const info = { err: Math.round(hav(pos, f)), dur: Math.round((Date.now() - pos.lostSince) / 1000), drDist: Math.round(pos.drDist), reason: pos.reason };
  pos.mode = 'gps'; pos.pending = null; cand = []; badRun = 0; pos.raw = null; pos.reason = ''; manualSpd = null; holdSince = 0; kf.on = false;
  log('info', 'GPS відновлено: похибка розрахунку ' + info.err + ' м за ' + info.dur + ' с');
  accept(f);
  bus.emit('gpsBack', info);
}

function onGps(f) {
  const v = judge(f);
  if (f.sim) return;
  journal.push({ k: 'loc', rt: Date.now(), prov: f.prov, lat: +(+f.lat).toFixed(5), lon: +(+f.lon).toFixed(5), acc: f.acc == null ? null : Math.round(f.acc),
    spd: f.spd == null ? null : Math.round(f.spd * 10) / 10, brg: f.brg == null ? null : Math.round(f.brg), t: f.t, age: f.age, mock: f.mock || undefined,
    sats: f.prov === 'gps' && pos.sats ? `${pos.sats.used}/${pos.sats.vis}` + (pos.sats.cn0 != null ? '@' + Math.round(pos.sats.cn0) : '') : undefined, v, mode: pos.mode });
  trimJournal();
}
function trimJournal() { const lim = Date.now() - J_MS; while (journal.length && (journal[0].rt < lim || journal.length > 6000)) journal.shift(); }
function judge(f) {
  if (simOn && !f.sim) return 'sim-skip';
  const now = Date.now();
  if (f.prov === 'network' || f.prov === 'fused' || f.prov === 'last' || f.prov === 'saved') {
    // мережеве місце: і «network», і «fused» без супутників (точність гірша за 150 м) — це вишки й Wi-Fi
    if ((f.prov === 'network' || (f.prov === 'fused' && (f.acc || 0) >= 150)) && inUkraine(f)) {
      const fresh = !net || net.t !== f.t || net.lat !== f.lat;
      net = { lat: f.lat, lon: f.lon, acc: f.acc || 2000, rt: now, t: f.t }; netSpeed(net);
      if (fresh) netCorrect();
    }
    return approx(f);
  }
  let bad = '';
  if (f.acc != null && f.acc > 120) bad = 'weak';
  const why = fake(f, now);
  if (why) { bad = why; spoofSeen(why, f); }
  else if (S.spoof && !f.sim && f.spd != null && f.spd > SUS_SPD()) {         // фура з обмежувачем так не їде — «затягування» підміною
    bad = 'speed'; if (badRun >= 1 || pos.mode !== 'gps') spoofSeen('speed', f);   // один випадковий сплеск — ще не тривога
  }
  else if (S.spoof && pos.raw && pos.mode === 'gps') {
    const dt = (now - pos.raw.rt) / 1000, d = hav(pos.raw, f);
    if (!f.sim && d > 200 && d / Math.max(dt, 0.5) > MAX_SPD) { bad = 'jump'; spoofSeen('jump', f); }   // стрибок, якого фура не зробить
  }

  if (pos.mode === 'dr') {
    if (bad) { cand = []; return 'dr:rej:' + bad; }
    f.rt = now;
    const last = cand[cand.length - 1];
    if (last && !f.sim && hav(last, f) / Math.max((now - last.rt) / 1000, 0.5) > 55) cand = [];
    cand.push(f); if (cand.length > 6) cand.shift();
    if (cand.length < 4) return 'dr:cand' + cand.length;
    const tol = Math.max(400, 0.25 * pos.drDist + 150), dEst = hav(pos, f);
    const netOk = net && now - net.rt < 90000 && net.acc < 3000 && hav(net, f) < Math.max(3000, 3 * net.acc);
    const onRoute = route && pos.onRoute && (() => { const l = route.locate(f, pos.rd); return l && l.off < 60; })();
    const jam = (gq.verdict === 'jam' || gq.verdict === 'spoof') && now - gq.t < 10000;
    if (onRoute && !jam) { exitDR(f); return 'back-route'; }          // GPS знову кладе нас на наш маршрут — це справжній сигнал
    if ((dEst <= tol || netOk || !S.spoof) && !jam && pos.reason !== 'manual') { exitDR(f); return 'back'; }   // у ручному режимі GPS повертає лише водій
    if (!pos.pending || Math.abs(pos.pending.d - dEst) > 200) { pos.pending = { lat: f.lat, lon: f.lon, d: Math.round(dEst) }; bus.emit('pos', pos); }
    return 'dr:pending';
  }

  if (bad) {
    if ((pos.mode === 'none' || pos.mode === 'approx') && bad === 'weak') { accept(f); return 'ok-weak'; }   // неточний GPS кращий за вишки
    if (pos.mode !== 'gps') return 'rej:' + bad;                      // ще немає справжньої позиції — підробку просто ігноруємо
    badRun++;
    if (badRun >= (bad === 'weak' ? 4 : 2)) enterDR(bad === 'weak' ? 'weak' : 'spoof');
    return 'rej:' + bad;
  }
  badRun = 0;
  accept(f);
  return 'ok';
}

// «Я тут»: водій сам ставить точку на карті (GPS підмінено, а вишки мовчать). Далі — розрахунок і кнопки ±100.
export function setManual(p) {
  if (route) { const l = route.locate(p, pos.rd); if (l && l.off < 300) { placeOnRoute(l.d, 50, 'manual'); saveGood(); return; } }
  const was = pos.mode;
  pos.lat = p.lat; pos.lon = p.lon; pos.acc = 50; pos.spd = 0;
  if (was === 'dr') { pos.reason = 'manual'; pos.accRef = pos.drDist; pos.accBase = 50; pos.pending = null; }
  else { pos.mode = 'approx'; enterDR('manual'); pos.accBase = 50; }
  matchRoute(pos, 0);
  saveGood();
  bus.emit('pos', pos);
}

export function acceptPending() {
  const f = cand[cand.length - 1];
  if (pos.mode === 'dr' && f) exitDR(f);
}

// Ручна поправка: водій бачить орієнтир і зсуває розрахункову точку вперед або назад.
export function nudge(d) {
  if (pos.lat == null) return;
  if (pos.mode !== 'dr') enterDR('manual');
  if (route && pos.onRoute && pos.rd != null) {
    pos.rd = clamp(pos.rd + d, 0, route.total);
    const a = route.at(pos.rd); pos.lat = a.lat; pos.lon = a.lon; pos.hdg = a.brg;
    if (!kf.on) kfInit(pos.rd, 30); else { kf.d = pos.rd; kf.Pdd = 30 * 30; kf.Pdv = 0; kf.out = []; }
    if (drTracker()) trk.shift(pos.rd - trk.est.d, 30);
  } else {
    const p = destPoint(pos, d >= 0 ? pos.hdg : (pos.hdg + 180) % 360, Math.abs(d));
    pos.lat = p.lat; pos.lon = p.lon;
  }
  pos.accRef = pos.drDist; pos.accBase = 30; pos.acc = 30;
  bus.emit('pos', pos);
}

function tick() {
  const now = Date.now(), dt = clamp((now - lastTick) / 1000, 0, 300); lastTick = now;
  if (pos.mode === 'gps' && now - lastFixT > 5000) enterDR('timeout');
  if (pos.mode === 'approx' && route && !simOn) tryLock();
  if (pos.mode !== 'dr') { kf.on = false; return; }          // фільтр живе лише під час розрахунку; наступний старт — з поточного місця
  if (manualSpd === 0 && now - manualSpdT > 5 * 60000) { manualSpd = null; if (kf.on) { kf.src = 'plan'; kf.Pvv = 36; } }   // «стою» саме минає за 5 хв, як у BlindDriver
  if (route && pos.onRoute && pos.rd != null && !kf.on) kfInit(pos.rd, Math.max(pos.acc || 50, 50));
  if (kf.on && route && pos.onRoute && pos.rd != null && drTracker()) {
    const T = dt + carry; carry = 0;
    const before = trk.est.d;
    trk.step(now / 1000, Math.max(T, 0.2), { moving, manualV: manualSpd, proven: now - gyroSeen < 40 * 60000 });
    const e = trk.est;
    kf.d = e.d; kf.v = manualSpd != null ? manualSpd : (moving ? e.v : 0);
    calibrationCheck(now, before, e);
    const step = Math.max(0, e.d - pos.rd);
    pos.rd = e.d; const a = route.at(pos.rd); pos.lat = a.lat; pos.lon = a.lon; pos.hdg = a.brg;
    pos.drDist += step; pos.spd = kf.v; pos.acc = Math.round(clamp(e.sig, 15, 9999));
    bus.emit('pos', pos);
    return;
  }
  if (kf.on && route && pos.onRoute && pos.rd != null) {
    // швидкість: водій > «стоїмо» (акселерометр) > фільтр; без жодних даних швидкість повільно тягнеться до планової
    const T = dt + carry; carry = 0;
    if (manualSpd != null) { kf.v = manualSpd; kf.Pvv = 1; }
    else if (!moving) { kf.v = 0; kf.Pvv = Math.min(kf.Pvv, 4); }
    else {
      // до планової — повільно: за 2 хв, якщо вишок давно не було, і за 15 хв, якщо вони щойно казали своє
      const vp = planSpeed(kf.d), k = Math.min(1, T / (now - (kf.measT || 0) > 300000 ? 120 : 900));
      if (kf.v < 1 && kf.src !== 'plan') kf.v = vp * 0.5;          // рушили після зупинки
      kf.v = clamp(kf.v + (vp - kf.v) * k, 0, VMAX());
      kf.Pvv = Math.min(kf.Pvv + 0.02 * T, 64);
    }
    const prev = kf.d;
    kf.d = Math.min(route.total, kf.d + kf.v * T);
    kf.Pdd += 2 * kf.Pdv * T + kf.Pvv * T * T + 4 * T; kf.Pdv += kf.Pvv * T;
    kf.Pdd = Math.min(kf.Pdd, 8000 * 8000);
    // Різкий поворот попереду: якщо гіроскоп працює — чекаємо, поки він відчує поворот, але не довше 8 с
    // і кожен поворот лише раз (раніше позначка стояла до 45 с і знову, якщо швидкість мала — «зависла на повороті»).
    const tn = yawNow != null && turns.find(t => t.d > prev - 1 && t.d <= kf.d + 1 && t.d !== heldTurn);
    if (tn && now - lastTurnEv > 20000) {
      if (!holdSince) holdSince = now;
      if (now - holdSince < 8000) kf.d = Math.max(prev, tn.d - 15);
      else { holdSince = 0; heldTurn = tn.d; }
    } else if (!tn) holdSince = 0;
    const step = kf.d - prev;
    pos.rd = kf.d;
    const a = route.at(pos.rd); pos.lat = a.lat; pos.lon = a.lon; pos.hdg = a.brg;
    pos.drDist += Math.max(0, step); pos.spd = kf.v;
    pos.acc = Math.round(Math.sqrt(kf.Pdd));
    bus.emit('pos', pos);
    return;
  }
  const v = curSpeed(), step = v * (dt + carry); carry = 0;
  if (step > 0) {
    const h = (yawNow != null && yawRef != null && hdgRef != null) ? ((hdgRef + yawNow - yawRef) % 360 + 360) % 360 : (compass != null ? compass : pos.hdg);
    const p = destPoint(pos, h, step); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = h;
  }
  pos.drDist += step; pos.spd = v;
  pos.acc = Math.round(pos.accBase + 0.08 * (pos.drDist - pos.accRef));
  bus.emit('pos', pos);
}

// Звірка відбулась: хмара була розмита (>120 м) і зібралась (<70 м) біля контрольного повороту — кажемо водієві
function calibrationCheck(now, before, e) {
  if (!trkCal) trkCal = { sig: e.sig, t: now, peak: e.sig };
  trkCal.peak = Math.max(trkCal.peak || 0, e.sig);
  if (trkCal.peak > 120 && e.sig < 70) {
    const cp = trk.cps.find(c => e.d >= c.d0 - 60 && e.d <= c.d1 + 500);
    if (cp) {
      const nx = trk.nextCp(e.d, 200);
      log('info', `звірка на повороті ${cp.ang}° (${cp.cls === 'red' ? 'різкий' : 'дуга'}): похибка була ±${Math.round(trkCal.peak)} м, тепер ±${Math.round(e.sig)} м`);
      bus.emit('turnMatch', { ang: cp.ang, cls: cp.cls, d: cp.d, was: Math.round(trkCal.peak), now: Math.round(e.sig), next: nx ? { d: nx.d, cls: nx.cls, ang: nx.ang } : null });
    }
    trkCal = { sig: e.sig, t: now, peak: e.sig };
  }
}
function onSens(s) {
  if (s.hdg != null) compass = s.hdg;
  if (s.yaw != null) { yawNow = s.yaw; onYaw(s.yaw); }
  if (s.var == null) return;
  // Самокалібрування: запам'ятовуємо рівень вібрації на стоянці й у русі, поки GPS живий.
  if (pos.mode === 'gps' && Date.now() - lastFixT < 2500) {
    if (pos.spd < 0.5) varStop = ema(varStop, s.var); else if (pos.spd > 5) varMove = ema(varMove, s.var);
  }
  // поріг «їдемо» — ближче до рівня стоянки (чутливіше удвічі, ніж середнє геометричне); «стоїмо» — лише після 6 с спокою
  const thr = (varStop != null && varMove != null && varMove > 2.5 * varStop) ? varStop * Math.pow(varMove / varStop, 0.3) : 0.002;
  if (s.var > thr) { moving = true; stillT = 0; } else if (++stillT >= 6) moving = false;
  // телефон узяли в руки (трясе набагато сильніше за дорогу) — кілька секунд гіроскоп не про фуру
  if (trk && varMove != null && s.var > 40 * varMove) trk.handled(Date.now() / 1000);
}

// AGC і C/N0: поки GPS справжній — вчимо еталон телефона; далі порівнюємо. Глушіння: обидва падають.
// Підміна: сильний сигнал (C/N0 вище звичного) при помітно нижчому AGC — чужий передавач поруч.
function onGq(q) {
  const now = Date.now();
  gq.agc = q.agc != null ? +q.agc : null; gq.cn0 = q.cn0 != null ? +q.cn0 : null; gq.n = q.n || 0; gq.t = now;
  const trusted = pos.mode === 'gps' && now - lastFixT < 3000 && now - pos.spoofAt > 120000;
  if (trusted) { if (gq.agc != null) gq.agcBase = ema(gq.agcBase, gq.agc, 0.03); if (gq.cn0 != null) gq.cnBase = ema(gq.cnBase, gq.cn0, 0.03); }
  let v = '';
  if (gq.agcBase != null && gq.agc != null) {
    const dA = gq.agc - gq.agcBase, dC = gq.cn0 != null && gq.cnBase != null ? gq.cn0 - gq.cnBase : 0;
    if (dA < -6 && dC < -4) v = 'jam'; else if (dA < -6 && dC > 2) v = 'spoof'; else if (dA < -6) v = 'agc';
  }
  if (v !== gq.verdict) { gq.verdict = v; if (v) log('warn', `GNSS: ${v} (AGC ${gq.agc && gq.agc.toFixed(1)} при еталоні ${gq.agcBase && gq.agcBase.toFixed(1)}, C/N0 ${gq.cn0 && gq.cn0.toFixed(1)})`); }
  journal.push({ k: 'gq', rt: now, agc: gq.agc == null ? null : +gq.agc.toFixed(1), cn0: gq.cn0 == null ? null : +gq.cn0.toFixed(1), n: gq.n, base: gq.agcBase == null ? null : +gq.agcBase.toFixed(1), v });
  trimJournal();
}

export function start() {
  if (timer) return;
  bus.on('gps', onGps);
  bus.on('sens', onSens);
  bus.on('gnss', g => { pos.sats = g; });
  bus.on('gnssq', onGq);
  lastTick = Date.now();
  timer = setInterval(tick, 1000);
  try {                                     // чесна швидкість до перезапуску (не старша 10 хв)
    const m = JSON.parse(localStorage.getItem('reis.motion') || 'null');
    if (m && m.v > 0.5 && Date.now() - m.t < 10 * 60000) { vCruise = Math.min(m.v, VMAX()); vCruiseT = m.t; }
  } catch (_) {}
  setInterval(() => {                       // раз на 10 с — стан супутників і руху до журналу
    journal.push({ k: 'st', rt: Date.now(), mode: pos.mode, sats: pos.sats ? { ...pos.sats } : null, moving, vCruise: Math.round(vCruise * 10) / 10,
      apSpd: apSpd == null ? null : Math.round(apSpd * 10) / 10, apErr: apSpdErr == null ? null : Math.round(apSpdErr * 10) / 10, speed: speedView() });
    trimJournal();
  }, 10000);
  try {                                     // після перезапуску — з останнього справжнього місця
    const g = JSON.parse(localStorage.getItem('reis.lastGood') || 'null');
    if (g && g.lat != null) onGps({ prov: 'saved', lat: g.lat, lon: g.lon, acc: 300, age: Math.round((Date.now() - g.t) / 1000), t: g.t });
  } catch (_) {}
}
export const routeTurns = () => turns.slice();
// Стенд перевірки ведення без GPS (tests/bench): ті самі обробники, але час і такт задає стенд
export function benchStart() { bus.on('gps', onGps); bus.on('sens', onSens); lastTick = Date.now(); }
export const benchTick = () => tick();
export const debugState = () => ({ yawHist: yawHist.slice(-8), lastTurnEv, vCruise, vCruiseT, moving, varStop, varMove, net, compass, yawNow, cand: cand.length, badRun, apSpd, apSpdErr, apSpdT, manualSpd, turns: turns.length, holdSince, gq: { ...gq }, kf: { ...kf, out: kf.out.length }, gyroSeen,
  pf: trk && trk.on ? { d: Math.round(trk.est.d), v: +trk.est.v.toFixed(1), sig: Math.round(trk.est.sig), bias: +trk.bias.toFixed(3), trust: trk.trust, cps: trk.cps.length } : null });
/** Журнал GPS для розбору: усе, що віддав телефон за останні 40 хв, і що з цим зробив застосунок. */
export function gpsJournal() {
  return { app: 'Reis', made: new Date().toISOString(), spoofCheck: !!S.spoof, pos: { ...pos, raw: undefined, pending: undefined }, state: debugState(), entries: journal.slice() };
}
