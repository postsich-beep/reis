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

// Чи схожа точка на справжню. Підміна в Україні переносить телефон у Перу, Москву тощо — такі точки не беремо ніколи.
function fake(f, now) {
  if (!S.spoof || f.sim && !f.spoofSim) return '';
  if (f.mock) return 'mock';
  if (!inUkraine(f)) return 'bounds';
  if (f.spd != null && f.spd > MAX_SPD) return 'speed';
  if (f.prov !== 'network' && net && now - net.rt < 90000 && net.acc < 3000 && hav(net, f) > Math.max(5000, 4 * net.acc)) return 'net';
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
  route = idx; pos.rd = null; pos.onRoute = false; pos.off = 0;
  routeInUA = true;
  if (idx) for (let i = 0; i < idx.c.length; i += 200) if (!inUkraine({ lat: idx.c[i][0], lon: idx.c[i][1] })) { routeInUA = false; break; }
  if (idx && pos.lat != null) matchRoute(pos, pos.spd);
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
  if ((spd == null || spd < 0) && pos.raw) { const dt = (now - pos.raw.rt) / 1000; if (dt > 0.3 && dt < 10) spd = hav(pos.raw, f) / dt; }
  if (spd == null || spd < 0) spd = 0;
  let hdg = pos.hdg || 0;
  if (spd >= 1.5) {
    if (f.brg != null) hdg = f.brg;
    else if (pos.raw && hav(pos.raw, f) > 3) hdg = bearing(pos.raw, f);
  } else if (pos.raw == null && compass != null) hdg = compass;
  if (spd > 3) { yawRef = yawNow; hdgRef = hdg; }
  vCruise = vCruise > 0.5 ? vCruise * 0.6 + spd * 0.4 : spd;
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
  if (v > 2.5 * sv && sv < 5) { apSpd = Math.min(v, MAX_SPD); apSpdErr = sv; apSpdT = p.rt; }
  else if (v + 2 * sv < 2.5) { apSpd = 0; apSpdErr = sv; apSpdT = p.rt; }
}
// Що показувати на спідометрі: справжня швидкість GPS, оцінка, «стоїть» або «невідомо».
export function speedView() {
  const fresh = apSpd != null && Date.now() - apSpdT < 60000;
  if (pos.mode === 'gps') return { kmh: pos.spd * 3.6, kind: 'gps' };
  if (!moving) return { kmh: 0, kind: 'still' };
  if (pos.mode === 'dr' && vCruise > 0.5) return { kmh: pos.spd * 3.6, kind: 'est' };
  if (fresh && apSpd > 0.5) return { kmh: apSpd * 3.6, kind: 'approx' };
  // GPS підмінено, а машина їде: тримаємо останню чесну швидкість (навіть із до перезапуску), поки не мине 15 хв
  if (pos.mode === 'approx' && vCruise > 0.5 && Date.now() - vCruiseT < 15 * 60000 && Date.now() - pos.spoofAt < 120000) return { kmh: vCruise * 3.6, kind: 'est' };
  if (pos.mode === 'approx' && pos.spd > 0.5) return { kmh: pos.spd * 3.6, kind: 'approx' };
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
  if (f.prov === 'network') saveGood();
  bus.emit('pos', pos);
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
  pos.mode = 'gps'; pos.pending = null; cand = []; badRun = 0; pos.raw = null; pos.reason = '';
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
    if (f.prov === 'network' && inUkraine(f)) { net = { lat: f.lat, lon: f.lon, acc: f.acc || 2000, rt: now, t: f.t }; netSpeed(net); }
    return approx(f);
  }
  let bad = '';
  if (f.acc != null && f.acc > 120) bad = 'weak';
  const why = fake(f, now);
  if (why) { bad = why; spoofSeen(why, f); }
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
    if ((dEst <= tol || netOk || !S.spoof) && pos.reason !== 'manual') { exitDR(f); return 'back'; }   // у ручному режимі GPS повертає лише водій
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
  if (pos.mode !== 'dr') return;
  const v = moving ? (vCruise > 0.5 ? vCruise : (apSpd != null && Date.now() - apSpdT < 60000 ? apSpd : 0)) : 0, step = v * (dt + carry); carry = 0;
  if (route && pos.onRoute && pos.rd != null) {
    pos.rd = Math.min(route.total, pos.rd + step);
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
  if (s.yaw != null) yawNow = s.yaw;
  if (s.var == null) return;
  // Самокалібрування: запам'ятовуємо рівень вібрації на стоянці й у русі, поки GPS живий.
  if (pos.mode === 'gps' && Date.now() - lastFixT < 2500) {
    if (pos.spd < 0.5) varStop = ema(varStop, s.var); else if (pos.spd > 5) varMove = ema(varMove, s.var);
  }
  const thr = (varStop != null && varMove != null && varMove > 2.5 * varStop) ? Math.sqrt(varStop * varMove) : 0.004;
  if (s.var > thr) { moving = true; stillT = 0; } else if (++stillT >= 4) moving = false;
}

export function start() {
  if (timer) return;
  bus.on('gps', onGps);
  bus.on('sens', onSens);
  bus.on('gnss', g => { pos.sats = g; });
  lastTick = Date.now();
  timer = setInterval(tick, 1000);
  try {                                     // чесна швидкість до перезапуску (не старша 10 хв)
    const m = JSON.parse(localStorage.getItem('reis.motion') || 'null');
    if (m && m.v > 0.5 && Date.now() - m.t < 10 * 60000) { vCruise = m.v; vCruiseT = m.t; }
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
export const debugState = () => ({ vCruise, vCruiseT, moving, varStop, varMove, net, compass, yawNow, cand: cand.length, badRun, apSpd, apSpdErr, apSpdT });
/** Журнал GPS для розбору: усе, що віддав телефон за останні 40 хв, і що з цим зробив застосунок. */
export function gpsJournal() {
  return { app: 'Reis', made: new Date().toISOString(), spoofCheck: !!S.spoof, pos: { ...pos, raw: undefined, pending: undefined }, state: debugState(), entries: journal.slice() };
}
