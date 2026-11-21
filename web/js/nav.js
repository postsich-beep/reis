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
  pos.spoofAt = Date.now();
  if (first) log('warn', `підміна GPS (${why}, ${f.prov}): ${(+f.lat).toFixed(3)}, ${(+f.lon).toFixed(3)} — відкинуто`);
  bus.emit('spoof', { why, prov: f.prov });
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

// Поки GPS не знайшов супутників: показуємо приблизне місце за вишками й Wi-Fi або останнє відоме.
function approx(f) {
  if (pos.mode !== 'none' && pos.mode !== 'approx') return;
  if ((f.prov === 'last' || f.prov === 'saved') && pos.mode !== 'none') return;
  const why = fake(f, Date.now());
  if (why) { spoofSeen(why, f); return; }
  const age = f.age > 0 ? f.age : 0;
  if (age > 7 * 86400) return;
  let acc = Math.round(f.acc || 1500); if (age > 600) acc = Math.max(acc, 1000);
  if (pos.mode === 'approx' && pos.acc != null && acc > pos.acc * 2 && Date.now() - approxT < 60000) return;   // свіжу кращу точку не міняємо на гіршу
  approxT = Date.now();
  pos.mode = 'approx'; pos.lat = f.lat; pos.lon = f.lon; pos.acc = acc;
  pos.spd = f.spd > 0 ? f.spd : 0;
  if (f.brg != null) pos.hdg = f.brg; else if (compass != null) pos.hdg = compass;
  pos.approxSrc = f.prov; pos.approxAge = age;
  matchRoute(pos, pos.spd);
  if (f.prov === 'network') saveGood();
  bus.emit('pos', pos);
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
  if (simOn && !f.sim) return;
  const now = Date.now();
  if (f.prov === 'network' || f.prov === 'fused' || f.prov === 'last' || f.prov === 'saved') {
    if (f.prov === 'network' && inUkraine(f)) net = { lat: f.lat, lon: f.lon, acc: f.acc || 2000, rt: now };
    approx(f);
    return;
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
    if (bad) { cand = []; return; }
    f.rt = now;
    const last = cand[cand.length - 1];
    if (last && !f.sim && hav(last, f) / Math.max((now - last.rt) / 1000, 0.5) > 55) cand = [];
    cand.push(f); if (cand.length > 6) cand.shift();
    if (cand.length < 4) return;
    const tol = Math.max(400, 0.25 * pos.drDist + 150), dEst = hav(pos, f);
    const netOk = net && now - net.rt < 90000 && net.acc < 3000 && hav(net, f) < Math.max(3000, 3 * net.acc);
    if ((dEst <= tol || netOk || !S.spoof) && pos.reason !== 'manual') exitDR(f);   // у ручному режимі GPS повертає лише водій
    else if (!pos.pending || Math.abs(pos.pending.d - dEst) > 200) { pos.pending = { lat: f.lat, lon: f.lon, d: Math.round(dEst) }; bus.emit('pos', pos); }
    return;
  }

  if (bad) {
    if ((pos.mode === 'none' || pos.mode === 'approx') && bad === 'weak') { accept(f); return; }   // неточний GPS кращий за вишки
    if (pos.mode !== 'gps') return;                                   // ще немає справжньої позиції — підробку просто ігноруємо
    badRun++;
    if (badRun >= (bad === 'weak' ? 4 : 2)) enterDR(bad === 'weak' ? 'weak' : 'spoof');
    return;
  }
  badRun = 0;
  accept(f);
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
  const v = moving ? vCruise : 0, step = v * (dt + carry); carry = 0;
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
  try {                                     // після перезапуску — з останнього справжнього місця
    const g = JSON.parse(localStorage.getItem('reis.lastGood') || 'null');
    if (g && g.lat != null) onGps({ prov: 'saved', lat: g.lat, lon: g.lon, acc: 300, age: Math.round((Date.now() - g.t) / 1000), t: g.t });
  } catch (_) {}
}
export const debugState = () => ({ vCruise, moving, varStop, varMove, net, compass, yawNow, cand: cand.length, badRun });
