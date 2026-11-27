// Пройдений шлях рейсу (1.1.25): де насправді їхали — від старту до фінішу, з GPS чи без нього.
// Поки рейс іде, шлях пишеться сам і лишається на карті блідою лінією. На фініші (чи коли рейс зупинили) — питаємо,
// чи зберегти; збережене лежить в «Архіві поїздок»: шлях на карті, швидкості, зупинки, скільки їхали без GPS.
// Точка шляху: [lat, lon, t (с від початку епохи), v (км/год), m (0 — GPS, 1 — розрахунок без GPS), j (1 — розрив: лінію від попередньої
// точки сюди не ведемо; з 1.1.39)].
import { bus, db, log } from './core.js';
import { pos } from './nav.js';
import { g } from './guide.js';
import { tripTitle } from './route.js';
import { saveText } from './platform.js';

const R = 6371008.8, D2R = Math.PI / 180;
export const havP = (a, b) => { const dφ = (b[0] - a[0]) * D2R, dλ = (b[1] - a[1]) * D2R, s = Math.sin(dφ / 2) ** 2 + Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dλ / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(s))); };
export const JR = {
  STEP_M: 25,            // нову точку пишемо, коли від'їхали від попередньої на стільки метрів…
  SLOW_S: 60, SLOW_M: 8, // …або минула хвилина й зрушили хоч на 8 м (повзли в заторі)
  MAX_PTS: 80000,        // запас на ~2000 км
  KEEP_M: 6,             // спрощення перед збереженням: точку можна викинути, якщо лінія без неї відхиляється менше ніж на стільки
  KEEP_DV: 8,            // …і швидкість на ній не відрізняється від сусідніх більше ніж на стільки км/год (інакше графік швидкості збіднів би)
  KEEP_S: 90,            // …і без точки не лишається проміжку, довшого за стільки секунд
  STOP_KMH: 3, STOP_S: 120,   // зупинка: стояли (повільніше 3 км/год) щонайменше дві хвилини
  MIN_SAVE_M: 300,       // коротше — це не поїздка (пробний запуск): зберігати не пропонуємо
  BUCKETS: [15, 50, 70, 90],  // межі кольорів швидкості, км/год: до 15 · 15–50 · 50–70 · 70–90 · понад 90
  BACK_M: 30,            // (1.1.39) без GPS: позначку повернули назад більш як на стільки — шлях, «проїханий» далі, стираємо
  JUMP_M: 150, JUMP_V: 50,   // стрибок: далі 150 м і швидше 50 м/с від попередньої точки — це не їзда (поправка, позначку переставили)
  SAVE_EVERY: 30000,     // незавершений шлях кладемо в базу раз на стільки мс — перезапуск програми його не губить
  DRAW_EVERY: 1000       // лінію на карті оновлюємо не частіше (давню частину довгого шляху карта проріджує, тож це дешево)
};
export const SPEED_COLORS = ['#d6453d', '#f08c00', '#d9b300', '#37a84a', '#1c7ed6'];

/* ---------- чиста логіка (без карти, сховища й екрана) ---------- */
/** Чи писати нову точку p після last (обидві — [lat, lon, t, v, m]). */
export function wantPoint(last, p) {
  if (!last) return true;
  if (p[4] !== last[4]) return true;                       // GPS зник / повернувся — межу ділянки пишемо завжди
  const d = havP(last, p);
  return d >= JR.STEP_M || (p[2] - last[2] >= JR.SLOW_S && d >= JR.SLOW_M);
}
/** Спрощення (Дуглас — Пекер) у метрах. Лишаються: точки, де змінюється режим (GPS ↔ розрахунок), краї зупинок,
 *  помітні зміни швидкості й точки, без яких проміжок у часі став би задовгим. */
export function simplify(pts, tol = JR.KEEP_M) {
  const n = pts.length; if (n < 3) return pts.slice();
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  for (let i = 1; i < n - 1; i++) {
    if (pts[i][4] !== pts[i - 1][4] || pts[i][4] !== pts[i + 1][4]) keep[i] = 1;
    if (pts[i][5] || pts[i + 1][5]) keep[i] = 1;                                          // край розриву
    if (pts[i + 1][2] - pts[i][2] >= JR.STOP_S || pts[i][2] - pts[i - 1][2] >= JR.STOP_S) keep[i] = 1;
  }
  const lat0 = pts[0][0] * D2R, kx = Math.cos(lat0) * R * D2R, ky = R * D2R, X = i => (pts[i][1] - pts[0][1]) * kx, Y = i => (pts[i][0] - pts[0][0]) * ky;
  const stack = []; let a = 0; for (let i = 1; i < n; i++) if (keep[i]) { stack.push([a, i]); a = i; }
  while (stack.length) {
    const [i0, i1] = stack.pop(); if (i1 - i0 < 2) continue;
    const ax = X(i0), ay = Y(i0), bx = X(i1), by = Y(i1), dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let far = -1, fd = tol;
    for (let i = i0 + 1; i < i1; i++) { const px = X(i) - ax, py = Y(i) - ay, t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, d = Math.hypot(px - t * dx, py - t * dy); if (d > fd) { fd = d; far = i; } }
    if (far > 0) { keep[far] = 1; stack.push([i0, far], [far, i1]); }
  }
  // швидкість і час: ідемо від останньої залишеної точки й лишаємо ту, де швидкість уже помітно інша або минуло забагато часу
  let last = 0;
  for (let i = 1; i < n; i++) {
    if (keep[i]) { last = i; continue; }
    if (Math.abs(pts[i][3] - pts[last][3]) >= JR.KEEP_DV || pts[i][2] - pts[last][2] >= JR.KEEP_S) { keep[i] = 1; last = i; }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Швидкість на відрізку a → p, км/год: за відстанню й часом, а на зовсім короткому (до 5 с) — за записаною швидкістю (час тут надто грубий). */
export const segV = (a, p) => { const dt = p[2] - a[2]; return dt >= 5 ? havP(a, p) / dt * 3.6 : p[3]; };
/** Зведення поїздки: метри, секунди (усього і в русі), швидкості, скільки без GPS, зупинки. */
export function stats(pts) {
  const s = { dist: 0, dur: 0, moving: 0, avg: 0, max: 0, est: 0, stops: 0, stopS: 0, t0: 0, t1: 0, n: pts.length };
  if (pts.length < 2) return s;
  s.t0 = pts[0][2]; s.t1 = pts[pts.length - 1][2]; s.dur = s.t1 - s.t0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; if (b[5]) continue;                                 // розрив — це не проїхані метри
    const d = havP(a, b), dt = b[2] - a[2], v = segV(a, b);
    s.dist += d; if (a[4] || b[4]) s.est += d;
    if (v < JR.STOP_KMH && dt >= JR.STOP_S) { s.stops++; s.stopS += dt; } else if (v >= JR.STOP_KMH) s.moving += dt;
  }
  for (const p of pts) if (!p[4] && p[3] > s.max && p[3] < 160) s.max = p[3];        // найбільша — із записаних швидкостей за GPS
  s.avg = s.moving > 0 ? s.dist / s.moving * 3.6 : 0;
  s.dist = Math.round(s.dist); s.est = Math.round(s.est); s.max = Math.round(s.max); s.avg = Math.round(s.avg);
  return s;
}
export const bucket = v => { let b = 0; while (b < JR.BUCKETS.length && v >= JR.BUCKETS[b]) b++; return b; };
/** Ділянки для карти: сусідні відрізки з тим самим кольором швидкості й тим самим режимом зливаються в одну лінію.
 *  Повертає [{ b (0…4), e (0/1), c: [[lon, lat], …] }]. bySpeed = false — ділимо лише за режимом (для блідої лінії в дорозі). */
export function segments(pts, bySpeed = true) {
  const out = []; let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], p = pts[i]; if (p[5]) { cur = null; continue; }                           // (1.1.39) розрив: лінію сюди не ведемо
    const b = bySpeed ? bucket(segV(a, p)) : 0, e = p[4] ? 1 : 0;      // відрізок належить до режиму точки, в яку він приходить
    if (cur && cur.b === b && cur.e === e) cur.c.push([p[1], p[0]]);
    else { cur = { b, e, c: [[a[1], a[0]], [p[1], p[0]]] }; out.push(cur); }
  }
  return out;
}
export const geojson = segs => ({ type: 'FeatureCollection', features: segs.map(s => ({ type: 'Feature', properties: { b: s.b, e: s.e }, geometry: { type: 'LineString', coordinates: s.c } })) });
/** Найближча до місця дотику точка шляху: { i, d (м) }. */
export function nearest(pts, lat, lon) { let bi = -1, bd = Infinity; for (let i = 0; i < pts.length; i++) { const d = havP(pts[i], [lat, lon]); if (d < bd) { bd = d; bi = i; } } return { i: bi, d: bd }; }
/** Найближче місце НА лінії шляху (не лише у вершинах): { i — відрізок pts[i-1] → pts[i], f — частка відрізка (0…1), d — метрів до лінії }. */
export function nearestOn(pts, lat, lon) {
  if (pts.length < 2) return { i: pts.length ? 0 : -1, f: 0, d: pts.length ? havP(pts[0], [lat, lon]) : Infinity };
  const kx = Math.cos(lat * D2R) * R * D2R, ky = R * D2R; let best = { i: 1, f: 0, d: Infinity };
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][5]) continue;
    const ax = (pts[i - 1][1] - lon) * kx, ay = (pts[i - 1][0] - lat) * ky, bx = (pts[i][1] - lon) * kx, by = (pts[i][0] - lat) * ky, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const f = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0, d = Math.hypot(ax + f * dx, ay + f * dy);
    if (d < best.d) best = { i, f, d };
  }
  return best;
}
/** Місце на шляху за відстанню від старту (м): { lat, lon, t, v, e, i } — між точками інтерполюємо. cum — з cumDist(pts). */
export function atDist(pts, cum, d) {
  const total = cum[cum.length - 1]; d = Math.max(0, Math.min(total, d));
  let lo = 1, hi = pts.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < d) lo = m + 1; else hi = m; }
  const a = pts[lo - 1], b = pts[lo], len = cum[lo] - cum[lo - 1], f = len > 0 ? (d - cum[lo - 1]) / len : 0;
  return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, t: Math.round(a[2] + (b[2] - a[2]) * f), v: segV(a, b), e: b[4] ? 1 : 0, i: lo, d };
}
/** Відстань від старту до кожної точки, м. */
export function cumDist(pts) { const c = new Float64Array(pts.length); for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + (pts[i][5] ? 0 : havP(pts[i - 1], pts[i])); return c; }
/** Графік швидкості: n рівних кроків за відстанню → [{ d (м), v (км/год), i (номер точки шляху), e }]. */
export function profile(pts, n = 160) {
  if (pts.length < 2) return [];
  const c = cumDist(pts), total = c[c.length - 1], out = []; let j = 1;
  for (let k = 0; k <= n; k++) {
    const d = total * k / n; while (j < pts.length - 1 && c[j] < d) j++;
    out.push({ d, v: Math.max(0, Math.round(segV(pts[j - 1], pts[j]))), i: j, e: pts[j][4] ? 1 : 0 });
  }
  return out;
}
/** GPX пройденого шляху (ділянки без GPS позначено <fix>none</fix>). */
export function toGpx(name, pts) {
  const body = pts.map((p, i) => `${p[5] && i ? '</trkseg><trkseg>\n' : ''}<trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(p[2] * 1000).toISOString()}</time><speed>${(p[3] / 3.6).toFixed(1)}</speed>${p[4] ? '<fix>none</fix>' : ''}</trkpt>`).join('\n');
  const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Reis" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${esc(name)}</name><trkseg>\n${body}\n</trkseg></trk>\n</gpx>\n`;
}

/* ---------- запис у дорозі ---------- */
// cur — шлях рейсу, що йде; pending — рейс закінчився, чекаємо на відповідь «зберегти?»; list — зведення збережених поїздок (без точок)
export const jr = { cur: null, pending: null, list: [], ready: false };
const K_CUR = 'jrCur', K_PEND = 'jrPend', K_IDX = 'jrIdx', K_PTS = id => 'jr:' + id;
let dirty = false, drawT = 0, readyP = Promise.resolve();
// (1.1.39) Без GPS позначка їде рейсом, але не рівно: її підтягує підтверджений поворот, повертає водій (дотик до повороту, ↓100),
// вона може забігти вперед. Раніше в шлях ішло «де стояла позначка щоразу», і кожен стрибок лишав на карті пряму сіру риску через
// квартали, а забіг уперед — пунктир там, де фура ще не їхала (Олексій, 27.11: «розберись з артефактами — сірі пунктири»).
// Тепер шлях без GPS — це лінія рейсу від місця, де GPS зник, до місця, де позначка зараз:
//   • позначка пішла вперед (хоч би й стрибком) — дописуємо дорогою рейсу;
//   • позначку повернули назад — зайве стираємо;
//   • позначку переставили деінде (інший рейс, «Я тут» осторонь) — розрив, пряму туди не ведемо.
// run: { idx — лінія рейсу, rds — відстань уздовж рейсу для кожної точки цього відрізка (вони — останні в шляху) }
let run = null;
const now = () => Math.round(Date.now() / 1000);
const pointNow = () => [+pos.lat.toFixed(6), +pos.lon.toFixed(6), now(), Math.max(0, Math.round((pos.spd || 0) * 3.6)), pos.mode === 'gps' ? 0 : 1];
const changed = force => { const t = Date.now(); if (force || t - drawT >= JR.DRAW_EVERY) { drawT = t; bus.emit('journey', jr); } };

function begin(trip) {
  jr.cur = { id: 'j' + Date.now().toString(36), tripId: trip.id, title: tripTitle(trip), a: (trip.a && trip.a.label) || '', b: (trip.b && trip.b.label) || '', t0: now(), sim: !!pos.sim, pts: [] };
  run = null;
  if (pos.lat != null) jr.cur.pts.push(pointNow());         // точка відбуття — звідки рушили, є GPS чи немає
  dirty = true; changed(true);
}
/** Чи це стрибок, а не їзда: від попередньої точки далі JUMP_M і швидше JUMP_V. */
export const jumpy = (last, p) => { if (!last) return false; const d = havP(last, p); return d > JR.JUMP_M && d / Math.max(1, p[2] - last[2]) > JR.JUMP_V; };
// у «пробній поїздці» (симулятор) швидкість буває будь-яка — там стрибком це не вважаємо
const teleport = (last, p) => !pos.sim && jumpy(last, p);
const push = (c, p) => { c.pts.push(p); if (c.pts.length > JR.MAX_PTS) c.pts.splice(0, 2000); dirty = true; };
/** Відрізок без GPS уздовж рейсу: привести його кінець до місця позначки rd (м уздовж лінії run.idx). Чиста логіка — c.pts і run.rds. */
export function syncRun(c, R, rd, t, kmh) {
  const rds = R.rds, lastRd = rds[rds.length - 1], last = c.pts[c.pts.length - 1];
  if (rd < lastRd - JR.BACK_M) {
    // позначку повернули назад: «проїхане» далі стираємо (там фура ще не їхала)
    while (rds.length > 1 && rds[rds.length - 1] > rd) { rds.pop(); c.pts.pop(); }
    const a = R.idx.at(rd), q = [+a.lat.toFixed(6), +a.lon.toFixed(6), t, kmh, 1];
    if (rds[rds.length - 1] > rd) {
      // повернули раніше, ніж починався цей відрізок: його перша точка переїжджає сюди; від попередньої точки шляху — розрив, якщо далеко
      const prev = c.pts[c.pts.length - 2];
      if (prev && havP(prev, q) > JR.JUMP_M) q[5] = 1;
      c.pts[c.pts.length - 1] = q; rds[0] = rd;
    } else if (rd - rds[rds.length - 1] >= 1) { c.pts.push(q); rds.push(rd); }
    return true;
  }
  const step = rd - lastRd;
  if (step >= JR.STEP_M || (last && t - last[2] >= JR.SLOW_S && step >= JR.SLOW_M)) {
    // уперед: дописуємо лінією рейсу — і коли позначка стрибнула (поворот підтверджено, водій підсунув), теж дорогою, а не прямою
    const n = Math.max(1, Math.ceil(step / JR.STEP_M)), t0 = last ? last[2] : t;
    for (let k = 1; k <= n; k++) { const d = lastRd + step * k / n, a = R.idx.at(d); c.pts.push([+a.lat.toFixed(6), +a.lon.toFixed(6), Math.round(t0 + (t - t0) * k / n), kmh, 1]); rds.push(d); }
    return true;
  }
  return false;
}
function onPos() {
  const c = jr.cur; if (!c || !g.active || !g.trip || g.trip.id !== c.tripId || pos.lat == null) return;
  if (pos.sim) c.sim = true;
  const onLine = pos.onRoute && pos.rd != null && !!g.idx, kmh = Math.max(0, Math.round((pos.spd || 0) * 3.6));
  if (pos.mode !== 'gps' && onLine) {
    if (run && run.idx === g.idx) { if (syncRun(c, run, pos.rd, now(), kmh)) { if (c.pts.length > JR.MAX_PTS) { c.pts.splice(0, 2000); } dirty = true; changed(false); } return; }
    // початок відрізка без GPS на цій лінії рейсу: GPS щойно зник, рейс перебудували чи позначку поставили на рейс
    const p = pointNow(), last = c.pts[c.pts.length - 1]; if (teleport(last, p)) p[5] = 1;
    run = { idx: g.idx, rds: [pos.rd] }; push(c, p); changed(false);
    return;
  }
  if (run) {
    // GPS повернувся (чи позначка зійшла з рейсу). GPS каже, де фура насправді: якщо це на тій самій лінії — доводимо відрізок до цього
    // місця дорогою рейсу (відстали) або стираємо зайве (забігли)
    if (pos.mode === 'gps' && onLine && run.idx === g.idx) syncRun(c, run, pos.rd, now(), kmh);
    run = null; dirty = true;
  }
  const p = pointNow(), last = c.pts[c.pts.length - 1];
  if (teleport(last, p)) p[5] = 1;                           // позначку переставили — пряму через карту не малюємо
  if (!p[5] && !wantPoint(last, p)) return;
  push(c, p); changed(false);
}
/** Рейс закінчився (прибули чи зупинили): короткий пробний шлях відкидаємо мовчки, справжній — лишаємо чекати на відповідь водія. */
function finish(why) {
  const c = jr.cur; if (!c) return;
  jr.cur = null; run = null; db.del('kv', K_CUR);
  if (pos.lat != null && c.pts.length) { const p = pointNow(), last = c.pts[c.pts.length - 1]; if (havP(last, p) >= 3 || p[2] - last[2] >= 5) c.pts.push(p); }
  const st = stats(c.pts);
  if (st.dist < JR.MIN_SAVE_M) { log('info', `пройдений шлях: ${st.dist} м — закороткий, не пропонуємо зберігати`); changed(true); return; }
  const pts = simplify(c.pts);
  if (jr.pending) bus.emit('journeyAuto', savePending());   // на попереднє запитання так і не відповіли — той шлях зберігаємо самі
  jr.pending = { id: c.id, title: c.title, a: c.a, b: c.b, sim: !!c.sim, why, st: stats(pts), raw: c.pts.length, pts };
  db.set('kv', K_PEND, jr.pending);
  log('info', `пройдений шлях: ${st.dist} м, точок ${c.pts.length} → ${pts.length}; чекаємо на відповідь «зберегти?»`);
  changed(true); bus.emit('journeyDone', jr.pending);
}
async function onTrip() {
  await readyP;
  const tr = g.trip;
  if (g.active && tr) {
    if (jr.cur && jr.cur.tripId === tr.id) return;                       // той самий рейс (перебудова маршруту, відновлення після перезапуску)
    if (jr.cur) finish('stopped');
    if (jr.pending) { const m = savePending(); bus.emit('journeyAuto', m); }   // на «зберегти?» не відповіли й поїхали далі — зберігаємо: викинути з архіву легко, а повернути загублене — ніяк
    begin(tr);
  } else if (!tr && jr.cur) finish('stopped');
}
function persist() { if (dirty && jr.cur) { dirty = false; return db.set('kv', K_CUR, jr.cur); } return Promise.resolve(); }
/** Негайно покласти недописаний шлях у базу (програму згортають, закривають чи оновлюють). */
export const flush = () => persist();

/* ---------- архів ---------- */
const meta = p => ({ id: p.id, title: p.title, a: p.a, b: p.b, sim: !!p.sim, why: p.why, ...p.st });
/** Зберегти шлях, що чекає на відповідь. Повертає його зведення. */
export function savePending() {
  const p = jr.pending; if (!p) return null;
  const m = meta(p);
  jr.list = [m, ...jr.list.filter(x => x.id !== m.id)];
  db.set('kv', K_PTS(p.id), p.pts); db.set('kv', K_IDX, jr.list); db.del('kv', K_PEND);
  jr.pending = null; changed(true); bus.emit('journeys', jr);
  return m;
}
export function dropPending() { if (!jr.pending) return; jr.pending = null; db.del('kv', K_PEND); changed(true); }
export const list = () => jr.list.slice().sort((a, b) => b.t0 - a.t0);
export async function load(id) { const m = jr.list.find(x => x.id === id); if (!m) return null; const pts = await db.get('kv', K_PTS(id)); return Array.isArray(pts) && pts.length > 1 ? { meta: m, pts } : null; }
/** Видалити поїздку з архіву. Повертає функцію «повернути» (випадковий дотик до кошика). */
export async function remove(id) {
  const m = jr.list.find(x => x.id === id); if (!m) return null;
  const pts = await db.get('kv', K_PTS(id));
  jr.list = jr.list.filter(x => x.id !== id); db.set('kv', K_IDX, jr.list); db.del('kv', K_PTS(id)); bus.emit('journeys', jr);
  return () => { if (jr.list.some(x => x.id === id)) return; jr.list = [m, ...jr.list]; db.set('kv', K_IDX, jr.list); if (pts) db.set('kv', K_PTS(id), pts); bus.emit('journeys', jr); };
}
export function exportGpx(m, pts) {
  const d = new Date(m.t0 * 1000), p2 = n => String(n).padStart(2, '0'), name = `reis-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.gpx`;
  return saveText(name, 'application/gpx+xml', toGpx(m.title || name, pts)) ? name : null;
}
/** Лінія для карти в дорозі: шлях рейсу, що йде, або того, що чекає на відповідь. */
export const shownPts = () => (jr.cur ? jr.cur.pts : jr.pending ? jr.pending.pts : null);
/** Чи пишеться шлях просто зараз (рейс іде). */
export const recording = () => !!jr.cur && g.active;

/** Програма запустилась і вже спробувала відновити рейс, що йшов до перезапуску. Не відновила (чи рейс інший) — недописаний шлях завершуємо. */
export function afterResume() { return readyP.then(() => { if (jr.cur && !(g.active && g.trip && g.trip.id === jr.cur.tripId)) finish('stopped'); }); }
export function init() {
  readyP = Promise.all([db.get('kv', K_IDX), db.get('kv', K_PEND), db.get('kv', K_CUR)]).then(([idx, pend, cur]) => {
    if (Array.isArray(idx)) jr.list = idx;
    if (pend && Array.isArray(pend.pts) && !jr.pending) jr.pending = pend;
    // рейс ішов до перезапуску: якщо його відновлять (той самий рейс) — шлях продовжиться; якщо ні — це завершена поїздка
    if (cur && Array.isArray(cur.pts) && !jr.cur) jr.cur = cur;
    jr.ready = true; changed(true); bus.emit('journeys', jr); if (jr.pending) bus.emit('journeyDone', jr.pending);
  }).catch(e => { jr.ready = true; log('warn', 'архів поїздок: ' + e.message); });
  bus.on('trip', onTrip);
  bus.on('arrived', () => finish('arrived'));
  bus.on('pos', onPos);
  setInterval(persist, JR.SAVE_EVERY);
  document.addEventListener('visibilitychange', () => { if (document.hidden) persist(); });
  window.addEventListener('pagehide', persist);
}
