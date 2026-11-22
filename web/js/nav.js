// Двигун позиції: довіра до GPS, детектор підміни, розрахунок шляху без сигналу, ручна поправка ±100 м.
import { bus, log, S, hav, bearing, destPoint, inUkraine, clamp } from './core.js';

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
const vmaxKmh = () => { const v = +((S.truck || {}).vmax); return v > 0 ? v : 0; };
const VMAX = () => vmaxKmh() ? vmaxKmh() / 3.6 : MAX_SPD;          // м/с — стеля для будь-якої оцінки
const SUS_SPD = () => vmaxKmh() ? (vmaxKmh() + 15) / 3.6 : MAX_SPD; // м/с — вище цього GPS для фури неправдоподібний
const startT = Date.now();
let lockT = 0, netInnov = [], manualSpd = null, manualSpdT = 0;
let turns = [], yawHist = [], lastTurnEv = 0, holdSince = 0;
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

export function setRoute(idx) {
  const keepDr = pos.mode === 'dr' && route && idx && pos.onRoute;     // перебудова під час розрахунку — лишаємось на маршруті
  route = idx; pos.rd = null; pos.onRoute = false; pos.off = 0;
  routeInUA = true;
  turns = idx ? findTurns(idx) : [];
  if (idx) for (let i = 0; i < idx.c.length; i += 200) if (!inUkraine({ lat: idx.c[i][0], lon: idx.c[i][1] })) { routeInUA = false; break; }
  if (idx && pos.lat != null) {
    const loc = idx.locate(pos, null);
    if (keepDr && loc && loc.off < 400) { pos.rd = loc.d; pos.onRoute = true; pos.off = 0; }
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
  return a || b;
}
function placeOnRoute(d, accBase, reason) {
  pos.rd = clamp(d, 0, route.total); pos.onRoute = true; pos.off = 0;
  const p = route.at(pos.rd); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = p.brg;
  if (pos.mode !== 'dr') { pos.mode = 'approx'; enterDR(reason); carry = 0; }    // оцінка вже врахувала час
  else pos.reason = reason;
  pos.accRef = pos.drDist; pos.accBase = accBase; pos.acc = Math.round(accBase); netInnov = []; holdSince = 0;
  bus.emit('pos', pos);
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
// Швидкість від водія (спідометр фури): поки GPS немає, рахуємо за нею. 0 — «стою». null — авто.
export function setManualSpeed(kmh) {
  manualSpd = kmh == null ? null : Math.max(0, kmh) / 3.6; manualSpdT = Date.now();
  if (manualSpd != null && pos.mode !== 'dr' && pos.mode !== 'gps' && route) snapToRoute();
  bus.emit('pos', pos);
}
export const manualSpeed = () => manualSpd == null ? null : Math.round(manualSpd * 3.6);
// М'яка поправка за вишками: якщо 3 точки поспіль кажуть, що ми далеко попереду чи позаду, — підтягуємо наполовину.
function netCorrect() {
  if (pos.mode !== 'dr' || !route || !pos.onRoute || pos.rd == null || pos.reason === 'manual' && pos.drDist - pos.accRef < 3000) return;
  const l = route.locate(net, pos.rd); if (!l || l.off > Math.max(6000, 3 * net.acc)) { netInnov = []; return; }
  const inn = l.d - pos.rd, lim = Math.max(2500, 1.5 * net.acc);
  if (Math.abs(inn) < lim) { netInnov = []; return; }
  netInnov.push(inn); if (netInnov.length > 3) netInnov.shift();
  if (netInnov.length === 3 && netInnov.every(x => Math.sign(x) === Math.sign(inn))) {
    const k = netInnov.reduce((s, x) => s + x, 0) / 3 * 0.5;
    log('info', `розрахунок виправлено за вишками на ${Math.round(k)} м`);
    pos.rd = clamp(pos.rd + k, 0, route.total); netInnov = [];
    const p = route.at(pos.rd); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = p.brg;
    pos.accBase = Math.max(pos.accBase, lim * 0.6); pos.accRef = pos.drDist;
    bus.emit('pos', pos);
  }
}
// Різкі повороти маршруту (перехрестя, з'їзди, кільця): де гіроскоп має «відчути» поворот.
function findTurns(idx) {
  const out = [], step = 15;
  for (let d = 40; d < idx.total - 40; d += step) {
    const a = idx.at(d - 35).brg, b = idx.at(d + 35).brg, ang = ((b - a + 540) % 360) - 180;
    if (Math.abs(ang) < 50) continue;
    const last = out[out.length - 1];
    if (last && d - last.d < 80) { if (Math.abs(ang) > Math.abs(last.ang)) { last.d = d; last.ang = ang; } continue; }
    out.push({ d, ang });
  }
  return out;
}
// Гіроскоп відчув поворот: знаходимо такий самий поворот маршруту поблизу й ставимо позначку точно на нього.
function onTurn(ang, ago) {
  if (pos.mode !== 'dr' || !route || !pos.onRoute || pos.rd == null || !turns.length) return;
  const v = curSpeed(), at = pos.rd - v * ago;                        // де ми були посеред повороту
  const w = clamp(300 + 0.25 * (pos.drDist - pos.accRef) + pos.accBase, 400, 3000);
  let best = null;
  for (const t of turns) {
    if (Math.abs(t.d - at) > w || Math.sign(t.ang) !== Math.sign(ang) || Math.abs(Math.abs(t.ang) - Math.abs(ang)) > 70) continue;
    if (!best || Math.abs(t.d - at) < Math.abs(best.d - at)) best = t;
  }
  if (!best) return;
  log('info', `поворот ${Math.round(ang)}° підтверджено гіроскопом: позначку зсунуто на ${Math.round(best.d + v * ago - pos.rd)} м`);
  pos.rd = clamp(best.d + v * ago, 0, route.total); holdSince = 0;
  const p = route.at(pos.rd); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = p.brg;
  pos.accRef = pos.drDist; pos.accBase = 40; pos.acc = 40;
  bus.emit('pos', pos); bus.emit('turnMatch', { ang: Math.round(ang), d: Math.round(best.d) });
}
function onYaw(yaw) {
  const now = Date.now();
  yawHist.push({ t: now, yaw }); while (yawHist.length && now - yawHist[0].t > 30000) yawHist.shift();
  if (!moving || now - lastTurnEv < 8000) return;
  const old = yawHist.find(x => now - x.t <= 14000); if (!old || now - old.t < 6000) return;
  const dy = yaw - old.yaw;
  if (Math.abs(dy) >= 50) { lastTurnEv = now; yawHist = [{ t: now, yaw }]; onTurn(dy, (now - old.t) / 2000); }
}
// Поточна швидкість розрахунку: водій сказав → чесна швидкість GPS → Wi-Fi; стоїмо — 0.
function curSpeed() {
  if (manualSpd != null) return manualSpd;
  if (!moving) return 0;
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
  pos.mode = 'dr'; pos.reason = reason; pos.lostSince = Date.now();
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
  pos.mode = 'gps'; pos.pending = null; cand = []; badRun = 0; pos.raw = null; pos.reason = ''; manualSpd = null; holdSince = 0;
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
    if (f.prov === 'network' && inUkraine(f)) {
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
  if (pos.mode !== 'dr') return;
  if (manualSpd === 0 && now - manualSpdT > 5 * 60000) manualSpd = null;          // «стою» саме минає за 5 хв, як у BlindDriver
  const v = curSpeed(), step = v * (dt + carry); carry = 0;
  if (route && pos.onRoute && pos.rd != null) {
    let nd = Math.min(route.total, pos.rd + step);
    // Перед різким поворотом чекаємо, поки гіроскоп його відчує, щоб позначка не проскакувала перехрестя.
    const tn = yawNow != null && turns.find(t => t.d > pos.rd - 1 && t.d <= nd + 1);
    if (tn && now - lastTurnEv > 20000) {
      if (!holdSince) holdSince = now;
      if (now - holdSince < 45000) nd = Math.max(pos.rd, tn.d - 15);
      else holdSince = 0;
    } else if (!tn) holdSince = 0;
    pos.rd = nd;
    const a = route.at(pos.rd); pos.lat = a.lat; pos.lon = a.lon; pos.hdg = a.brg;
  } else if (step > 0) {
    const h = (yawNow != null && yawRef != null && hdgRef != null) ? ((hdgRef + yawNow - yawRef) % 360 + 360) % 360 : (compass != null ? compass : pos.hdg);
    const p = destPoint(pos, h, step); pos.lat = p.lat; pos.lon = p.lon; pos.hdg = h;
  }
  pos.drDist += step; pos.spd = v;
  pos.acc = Math.round(pos.accBase + 0.08 * (pos.drDist - pos.accRef));
  bus.emit('pos', pos);
}

function onSens(s) {
  if (s.hdg != null) compass = s.hdg;
  if (s.yaw != null) { yawNow = s.yaw; onYaw(s.yaw); }
  if (s.var == null) return;
  // Самокалібрування: запам'ятовуємо рівень вібрації на стоянці й у русі, поки GPS живий.
  if (pos.mode === 'gps' && Date.now() - lastFixT < 2500) {
    if (pos.spd < 0.5) varStop = ema(varStop, s.var); else if (pos.spd > 5) varMove = ema(varMove, s.var);
  }
  const thr = (varStop != null && varMove != null && varMove > 2.5 * varStop) ? Math.sqrt(varStop * varMove) : 0.004;
  if (s.var > thr) { moving = true; stillT = 0; } else if (++stillT >= 4) moving = false;
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
export const debugState = () => ({ vCruise, vCruiseT, moving, varStop, varMove, net, compass, yawNow, cand: cand.length, badRun, apSpd, apSpdErr, apSpdT, manualSpd, turns: turns.length, holdSince, gq: { ...gq } });
/** Журнал GPS для розбору: усе, що віддав телефон за останні 40 хв, і що з цим зробив застосунок. */
export function gpsJournal() {
  return { app: 'Reis', made: new Date().toISOString(), spoofCheck: !!S.spoof, pos: { ...pos, raw: undefined, pending: undefined }, state: debugState(), entries: journal.slice() };
}
