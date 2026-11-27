// (1.1.39) «Ворота»: рейс хорошими дорогами — як веде Google.
//
// Навіщо. Сервер маршрутів (Valhalla) здорожчує дороги в щільній забудові (до 44 %) і кожне міське перехрестя (до 3,5 раза),
// тож у місто він заходить об'їзною й дворами, а головною вулицею — ні. Приклад Олексія (27.11): Милятичі → Рядова, 26.
// Google веде Стрийською до міста (23 хв); у нас такого варіанта не було зовсім, і запитом це не вимикається.
//
// Як. 1) З векторного квадрата карти (офлайн-карта в телефоні або OpenFreeMap) беремо головні дороги біля фінішу й старту.
//     2) «Ворота» — місця, де головна дорога (траса чи магістральна вулиця) перетинає коло довкола фінішу з боку старту
//        (і навпаки). Через кожні ворота просимо в сервера ще один варіант: «проїдь цією дорогою».
//     3) Усі варіанти оцінюємо самі — час за класом дороги (траса 80, магістральна 56, … місцева 22 км/год) — і першим
//        показуємо найшвидший; серед майже однакових — той, де більше головних доріг.
// Перевірено на справжній карті Львова (квадрат із нашої офлайн-карти): ворота на Стрийській знаходяться, шлях через них —
// той самий, що в Google. Сам сервер зі стенда недоступний — живий результат покаже дорога.
import { log, S } from './core.js';
import { pmTileData } from './offline.js';
import { ofmTemplate } from './addr.js';

const D2R = Math.PI / 180, KY = 110540;
const kx = lat => Math.cos(lat * D2R) * 111320;
/** Точки тут — [lat, lon]. */
export const dist = (a, b) => Math.hypot((b[1] - a[1]) * kx(a[0]), (b[0] - a[0]) * KY);
export const brg = (a, b) => (Math.atan2((b[1] - a[1]) * kx(a[0]), (b[0] - a[0]) * KY) / D2R + 360) % 360;
const adiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
export const RANK = { motorway: 5, trunk: 4, primary: 3, secondary: 2, tertiary: 1 };
/** Швидкість для оцінки, км/год: чим вищий клас дороги, тим швидше (це й є «спершу хороші дороги»). */
export const CLASS_KMH = { motorway: 100, trunk: 80, primary: 56, secondary: 46, tertiary: 36, minor: 22 };
export const GATE = { MIN_TRIP_M: 4000, RHO_K: 0.3, RHO_MIN: 1500, RHO_MAX: 6000, SIDE: 90, TAN: 60, TURN: 75, LOCAL_M: 60000, SEP: 25, MAX_END: 2, MAX_REQ: 2, LONG_M: 150000, TOL_M: 20, NEAR_M: 90, SNAP_M: 40, LOOP_M: 45, LOOP_GAP_M: 250, TILE_MS: 4500, MAX_TILES: 8, TIE: 0.05, TIE_S: 120 };

/* ---------- векторний квадрат → головні дороги ---------- */
// Мінімальний читач MVT: лише шар доріг і лише потрібні властивості. Дві схеми: OpenMapTiles (OpenFreeMap) — шар transportation,
// клас у class, з'їзди — ramp; Protomaps (наша офлайн-карта) — шар roads, клас у kind_detail, з'їзди — «…_link».
function reader(b, o = 0, end = b.length) {
  const r = { o, end,
    varint() { let v = 0, s = 0, x; do { x = b[r.o++]; v += (x & 0x7f) * 2 ** s; s += 7; } while ((x & 0x80) && r.o < end); return v; },
    skip(wt) { if (wt === 0) r.varint(); else if (wt === 2) { const n = r.varint(); r.o += n; } else if (wt === 5) r.o += 4; else if (wt === 1) r.o += 8; else r.o = end; } };
  return r;
}
const zz = n => (n % 2 ? -(n + 1) / 2 : n / 2);
const utf8 = new TextDecoder();
function value(b, o, end) {
  const r = reader(b, o, end); let v = null;
  while (r.o < end) { const k = r.varint(), f = k >>> 3, wt = k & 7;
    if (f === 1 && wt === 2) { const n = r.varint(); v = utf8.decode(b.subarray(r.o, r.o + n)); r.o += n; }
    else if ((f === 4 || f === 5) && wt === 0) v = r.varint(); else if (f === 6 && wt === 0) v = zz(r.varint()); else if (f === 7 && wt === 0) v = !!r.varint();
    else r.skip(wt); }
  return v;
}
/** Головні дороги квадрата z/x/y: [{ cls, c: [[lat, lon], …] }] (без з'їздів і розв'язок). */
export function readRoads(buf, z, x, y) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), out = [], n = 2 ** z, top = reader(b);
  while (top.o < b.length) {
    const k = top.varint(), wt = k & 7;
    if (wt !== 2 || (k >>> 3) !== 3) { top.skip(wt); continue; }
    const len = top.varint(), from = top.o, to = from + len; top.o = to;
    const L = reader(b, from, to); let name = '', ext = 4096; const keys = [], vals = [], feats = [];
    while (L.o < to) { const kk = L.varint(), f = kk >>> 3, w = kk & 7;
      if (w === 2) { const m = L.varint(), s = L.o; L.o += m;
        if (f === 1) name = utf8.decode(b.subarray(s, s + m)); else if (f === 2) feats.push([s, s + m]); else if (f === 3) keys.push(utf8.decode(b.subarray(s, s + m))); else if (f === 4) vals.push([s, s + m]); }
      else if (f === 5 && w === 0) ext = L.varint(); else L.skip(w); }
    const omt = name === 'transportation', pm = name === 'roads';
    if (!omt && !pm) continue;
    const vcache = new Map(), val = i => { if (!vcache.has(i)) vcache.set(i, vals[i] ? value(b, vals[i][0], vals[i][1]) : null); return vcache.get(i); };
    const ll = (px, py) => { const lon = (x + px / ext) / n * 360 - 180, yy = (y + py / ext) / n; return [Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) / D2R, lon]; };
    for (const [fs, fe] of feats) {
      const F = reader(b, fs, fe); let type = 0, tags = null, geom = null;
      while (F.o < fe) { const kk = F.varint(), f = kk >>> 3, w = kk & 7;
        if (f === 3 && w === 0) type = F.varint(); else if ((f === 2 || f === 4) && w === 2) { const m = F.varint(); if (f === 2) tags = [F.o, F.o + m]; else geom = [F.o, F.o + m]; F.o += m; } else F.skip(w); }
      if (type !== 2 || !tags || !geom) continue;
      const P = {}, T = reader(b, tags[0], tags[1]);
      while (T.o < tags[1]) { const ki = T.varint(), vi = T.varint(), key = keys[ki]; if (key === 'class' || key === 'kind' || key === 'kind_detail' || key === 'ramp') P[key] = val(vi); }
      let cls = omt ? P.class : (P.kind === 'major_road' || P.kind === 'highway') ? P.kind_detail : null;
      if (!cls || (omt && P.ramp) || /_link$/.test(cls)) continue;
      if (!RANK[cls]) continue;
      const Gm = reader(b, geom[0], geom[1]); let cx = 0, cy = 0, cur = null;
      while (Gm.o < geom[1]) { const cmd = Gm.varint(), id = cmd & 7, cnt = cmd >>> 3;
        if (id === 1) for (let c = 0; c < cnt; c++) { cx += zz(Gm.varint()); cy += zz(Gm.varint()); cur = [ll(cx, cy)]; out.push({ cls, c: cur }); }
        else if (id === 2) for (let c = 0; c < cnt; c++) { cx += zz(Gm.varint()); cy += zz(Gm.varint()); if (cur) cur.push(ll(cx, cy)); }
        else if (id !== 7) break; }
    }
  }
  return out.filter(r => r.c.length > 1);
}
async function gunzipIfNeeded(b) {
  if (b.length < 3 || b[0] !== 0x1f || b[1] !== 0x8b || typeof DecompressionStream === 'undefined') return b;
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/* ---------- квадрати довкола кінців рейсу ---------- */
const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const ty = (lat, z) => { const r = lat * D2R; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const tileBox = (z, x, y) => { const n = 2 ** z, la = v => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) / D2R; return [la(y + 1), la(y), x / n * 360 - 180, (x + 1) / n * 360 - 180]; };   // [lat0, lat1, lon0, lon1]
const mem = new Map();                                   // розібрані квадрати — до перезапуску (той самий рейс будують повторно)
export const gateStat = { tiles: 0, net: 0, fails: 0, src: '', last: '' };
const flying = new Map();                                // квадрати, що саме вантажаться: другий запит того самого квадрата чекає на перший
function tileRoads(src, z, x, y, signal) {
  const key = src + '/' + z + '/' + x + '/' + y;
  if (mem.has(key)) return Promise.resolve(mem.get(key));
  if (flying.has(key)) return flying.get(key);
  const job = loadTile(key, src, z, x, y, signal).finally(() => flying.delete(key));
  flying.set(key, job); return job;
}
async function loadTile(key, src, z, x, y, signal) {
  let u8 = null;
  if (src === 'pm') { const t = await pmTileData(z, x, y); u8 = t ? new Uint8Array(t) : null; }
  else { const tpl = await ofmTemplate(); const r = await fetch(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal }); if (!r.ok) throw new Error('HTTP ' + r.status); u8 = new Uint8Array(await r.arrayBuffer()); gateStat.net += u8.length; }
  const roads = u8 && u8.length ? readRoads(await gunzipIfNeeded(u8), z, x, y) : [];
  mem.set(key, roads); if (mem.size > 40) mem.delete(mem.keys().next().value);
  gateStat.tiles++;
  return roads;
}
/** Головні дороги довкола точок pts (радіус rho, м). Повертає { roads, cover: [[lat0, lat1, lon0, lon1], …], src } або null. */
export async function roadsAround(pts, rho, { ms = GATE.TILE_MS } = {}) {
  const src = pmTileData.ready() ? 'pm' : 'ofm', z = src === 'pm' ? 10 : 11, want = new Map();
  for (const p of pts) { const dLat = rho / KY, dLon = rho / kx(p[0]);
    for (let x = tx(p[1] - dLon, z); x <= tx(p[1] + dLon, z); x++) for (let y = ty(p[0] + dLat, z); y <= ty(p[0] - dLat, z); y++) if (want.size < GATE.MAX_TILES) want.set(x + '/' + y, [x, y]); }
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = setTimeout(() => { if (ctl) ctl.abort(); }, ms);
  const roads = [], cover = [];
  try {
    const res = await Promise.all([...want.values()].map(([x, y]) => tileRoads(src, z, x, y, ctl && ctl.signal).then(r => ({ x, y, r }), e => ({ x, y, e }))));
    for (const t of res) { if (t.e) { gateStat.fails++; gateStat.last = String(t.e && t.e.message || t.e); continue; } for (const r of t.r) roads.push(r); cover.push(tileBox(z, t.x, t.y)); }
  } finally { clearTimeout(timer); }
  gateStat.src = src;
  return cover.length ? { roads, cover, src, z } : null;
}

/* ---------- ворота ---------- */
/** Місця, де головні дороги перетинають коло радіуса rho довкола C з боку O. → [{ p, cls, bg, off, inward }], найважливіші перші. */
export function gateways(roads, C, O, rho, { classes = ['motorway', 'trunk', 'primary'], side = GATE.SIDE, tan = GATE.TAN, turn = null, sep = GATE.SEP, max = GATE.MAX_END } = {}) {
  const toO = brg(C, O), found = [];
  if (turn == null) turn = dist(C, O) <= GATE.LOCAL_M ? GATE.TURN : 999;
  for (const r of roads) { if (!classes.includes(r.cls)) continue;
    for (let i = 1; i < r.c.length; i++) { const a = r.c[i - 1], b = r.c[i], da = dist(C, a), db = dist(C, b);
      if ((da < rho) === (db < rho)) continue;                                   // відрізок кола не перетинає
      const f = (rho - da) / (db - da), p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], bg = brg(C, p);
      if (adiff(bg, toO) > side) continue;                                        // з протилежного боку — це не дорога «звідти»
      // 1) дорога має вести ДО центру кола, а не повз нього: об'їзна лише «зачіпає» коло (кут до радіуса понад 60°) — це не в'їзд;
      // 2) у близькому рейсі (до 60 км) — ще й «кут ходу»: дорога у воротах не має вести вбік від прямої з іншого кінця рейсу
      //    більше ніж на 75° (траса, що йде крізь містечко поперек рейсу: Стрий → Дрогобич, М-06 — 78°; Стрийська у Львові — 46°).
      //    У далекому рейсі цей кут нічого не каже: траса підходить до міста зі свого боку (Одеса з Умані — із заходу).
      const inward = da > db ? brg(a, b) : brg(b, a), tn = adiff(inward, brg(p, C)), prog = adiff(inward, brg(O, p));
      if (tn > tan || prog > turn) continue;
      found.push({ p, cls: r.cls, bg, off: adiff(bg, toO), inward, tan: tn, prog }); } }
  // спершу — дорога просто «звідти» (найменший кут до напрямку на інший кінець рейсу), клас — лише серед рівних: інакше об'їзна
  // (траса, перетинає коло збоку) випереджала б головну вулицю, що веде в місто навпростець (Луцьк із Рівного, Київ зі Львова)
  found.sort((x, y) => (Math.round(x.off / 5) - Math.round(y.off / 5)) || (RANK[y.cls] - RANK[x.cls]) || (x.off - y.off));
  const out = [];
  for (const g of found) { if (out.some(o => adiff(o.bg, g.bg) < sep)) continue; out.push(g); if (out.length >= max) break; }   // дві смуги однієї дороги — одні ворота
  return out;
}

/* ---------- оцінка варіанта за класом дороги ---------- */
/** Сітка відрізків головних доріг: «який клас дороги в цій точці» (у межах tol метрів). */
export function classIndex(R) {
  const CELL = 60, lat0 = R.roads.length ? R.roads[0].c[0][0] : 49, KX = kx(lat0), grid = new Map();
  for (const r of R.roads) for (let i = 1; i < r.c.length; i++) { const a = r.c[i - 1], b = r.c[i], n = Math.max(1, Math.ceil(dist(a, b) / (CELL / 2)));
    let last = '';
    for (let k = 0; k <= n; k++) { const la = a[0] + (b[0] - a[0]) * k / n, lo = a[1] + (b[1] - a[1]) * k / n, key = Math.floor(la * KY / CELL) + ':' + Math.floor(lo * KX / CELL); if (key === last) continue; last = key; let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(a, b, r.cls); } }
  const segD = (p, a, b) => { const bx = (b[1] - a[1]) * KX, by = (b[0] - a[0]) * KY, px = (p[1] - a[1]) * KX, py = (p[0] - a[0]) * KY, L2 = bx * bx + by * by, t = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0; return Math.hypot(px - t * bx, py - t * by); };
  const covered = p => R.cover.some(c => p[0] >= c[0] && p[0] <= c[1] && p[1] >= c[2] && p[1] <= c[3]);
  const classAt = (p, tol = GATE.TOL_M) => { const cy = Math.floor(p[0] * KY / CELL), cx = Math.floor(p[1] * KX / CELL); let best = null;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const l = grid.get((cy + dy) + ':' + (cx + dx)); if (!l) continue; for (let i = 0; i < l.length; i += 3) if ((!best || RANK[l[i + 2]] > RANK[best]) && segD(p, l[i], l[i + 1]) <= tol) best = l[i + 2]; }
    return best || 'minor'; };
  return { classAt, covered };
}
/** Оцінка варіанта r (coords, time/timeSrv, dist): час за класом дороги там, де є дані карти; деінде — час сервера (за часткою довжини).
 *  → { t — оцінка, с; major — частка траси й магістральних вулиць; cov — частка шляху, де клас відомий; km — довжини за класами }. */
export function classTime(r, ix) {
  const c = r.coords, L = {}; let tIn = 0, lIn = 0, lAll = 0;
  for (let i = 1; i < c.length; i++) { const a = c[i - 1], b = c[i], d = dist(a, b); if (!d) continue; lAll += d;
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; if (!ix.covered(m)) continue;
    const k = ix.classAt(m); tIn += d / (CLASS_KMH[k] / 3.6); lIn += d; L[k] = (L[k] || 0) + d; }
  const srv = r.timeSrv != null ? r.timeSrv : r.time, tOut = lAll > 0 ? srv * (lAll - lIn) / lAll : srv;
  const major = lIn > 0 ? ((L.motorway || 0) + (L.trunk || 0) + (L.primary || 0)) / lIn : 0;
  return { t: tIn + tOut, major, cov: lAll > 0 ? lIn / lAll : 0, km: L };
}
/** Той самий шлях? Довжини в межах 3 % і п'ять точок уздовж — у межах 80 м. */
export function sameRoute(a, b) {
  if (Math.abs(a.dist - b.dist) > 0.03 * Math.max(a.dist, b.dist) + 50) return false;
  const at = (r, f) => { const c = r.coords; let need = f * r.dist, i = 1; for (; i < c.length; i++) { const d = dist(c[i - 1], c[i]); if (need <= d) { const k = d ? need / d : 0; return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * k, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * k]; } need -= d; } return c[c.length - 1]; };
  return [0.2, 0.35, 0.5, 0.65, 0.8].every(f => dist(at(a, f), at(b, f)) <= 80);
}
/** Чи проходить варіант біля точки p (у межах m метрів). */
const segDist = (p, a, b) => { const KX = kx(p[0]), bx = (b[1] - a[1]) * KX, by = (b[0] - a[0]) * KY, px = (p[1] - a[1]) * KX, py = (p[0] - a[0]) * KY, L2 = bx * bx + by * by, t = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0; return Math.hypot(px - t * bx, py - t * by); };
export function passesNear(r, p, m = GATE.NEAR_M) { const c = r.coords; for (let i = 1; i < c.length; i++) if (segDist(p, c[i - 1], c[i]) <= m) return true; return false; }
/** Шлях проходить повз точку p більше ніж раз — петля. Так буває, коли сервер «причепив» ворота до зустрічної смуги дороги з
 *  розділювачем: їде повз, розвертається, проїжджає ворота назад і розвертається ще раз. Такий варіант — не «хороша дорога». */
export function loopsAt(r, p, m = GATE.LOOP_M, gap = GATE.LOOP_GAP_M) {
  const c = r.coords; let s = 0, lastNear = -Infinity, n = 0;
  for (let i = 1; i < c.length; i++) { const d = dist(c[i - 1], c[i]); if (segDist(p, c[i - 1], c[i]) <= m) { if (s - lastNear > gap) n++; lastNear = s + d; } s += d; }
  return n > 1;
}
/** Порядок варіантів: найшвидший за оцінкою; серед майже однакових (у межах 5 %) — той, де більше головних доріг. */
export function rankByClass(list, ix) {
  const E = list.map((r, i) => { const e = classTime(r, ix), srv = r.timeSrv != null ? r.timeSrv : r.time; r.gate = { ...(r.gate || {}), t: Math.round(e.t), major: +e.major.toFixed(3), cov: +e.cov.toFixed(2) }; return { r, i, e, s: Math.sqrt(e.t * srv) }; });
  // оцінка — середнє геометричне нашого часу й часу сервера: сервер знає обмеження швидкості й покриття, ми — клас дороги
  E.sort((x, y) => x.s - y.s || x.i - y.i);
  const best = E[0], tie = E.filter(x => x.s <= best.s * (1 + GATE.TIE) && x.s - best.s <= GATE.TIE_S).sort((x, y) => (y.e.major - x.e.major) || (x.s - y.s));
  const rest = E.filter(x => !tie.includes(x));
  return [...tie, ...rest].map(x => x.r);
}

/* ---------- головне: додати варіанти крізь ворота ---------- */
const rhoOf = D => Math.max(GATE.RHO_MIN, Math.min(GATE.RHO_MAX, GATE.RHO_K * D));
/** Заздалегідь, поки сервер рахує рейс, прочитати квадрати карти довкола старту й фінішу: тоді ворота не додають очікування. */
export function warmGates(a, b) {
  try { if (S.gates === false || !a || !b) return; const A = [a.lat, a.lon], B = [b.lat, b.lon], D = dist(A, B); if (D < GATE.MIN_TRIP_M) return;
    roadsAround([B, A], rhoOf(D)).catch(() => {}); } catch (_) {}
}
/** a, b — { lat, lon }; base — уже знайдені варіанти; ask(G) → Promise<варіант> — запит до сервера через ворота G ({ lat, lon, brg }).
 *  → { list — усі варіанти в правильному порядку (або null, якщо даних карти немає), info — для журналу }. */
export async function withGates(a, b, base, ask, { pause = null } = {}) {
  if (S.gates === false) return { list: null, info: 'вимкнено' };
  const A = [a.lat, a.lon], B = [b.lat, b.lon], D = dist(A, B);
  if (D < GATE.MIN_TRIP_M) return { list: null, info: 'короткий рейс' };
  const rho = rhoOf(D);
  // карта не відповіла за кілька секунд — не чекаємо: рейс важливіший (лишається порядок сервера)
  let R = null; try { R = await Promise.race([roadsAround([B, A], rho), new Promise(res => setTimeout(() => res(null), GATE.TILE_MS + 800))]); } catch (e) { gateStat.last = String(e && e.message || e); }
  if (!R || !R.roads.length) return { list: null, info: 'немає даних карти' + (gateStat.last ? ' (' + gateStat.last + ')' : '') };
  const ix = classIndex(R), list = base.slice();
  const gs = [...gateways(R.roads, B, A, rho).map(g => ({ ...g, end: 'b' })), ...gateways(R.roads, A, B, rho).map(g => ({ ...g, end: 'a', inward: (g.inward + 180) % 360 }))];
  // далекий рейс — один додатковий запит, не два: кожен такий запит — це весь рейс наново
  const tried = [], maxReq = D > GATE.LONG_M ? 1 : GATE.MAX_REQ; let asked = 0;
  for (const g of gs) {
    if (asked >= maxReq) break;
    if (list.some(r => passesNear(r, g.p))) { tried.push(g.cls + ' — уже є'); continue; }       // цією дорогою вже веде якийсь варіант
    asked++;
    try {
      if (pause) await pause();
      // rad: на дорозі з розділювачем точка з квадрата карти може лежати на зустрічній смузі — сервер сам вибере смугу за курсом
      const r = await ask({ lat: +g.p[0].toFixed(6), lon: +g.p[1].toFixed(6), brg: Math.round(g.inward), rad: GATE.SNAP_M });
      if (!r || !r.coords || r.coords.length < 2) continue;
      if (loopsAt(r, g.p)) { tried.push(g.cls + ' — петля'); continue; }                           // розворот біля воріт — не варіант
      const short = Math.min(...list.map(x => x.dist));
      if (r.dist > 1.6 * short + 500) { tried.push(g.cls + ' — гак'); continue; }                 // крізь ворота вийшов великий гак — не варіант
      if (list.some(x => sameRoute(x, r))) { tried.push(g.cls + ' — той самий шлях'); continue; }
      r.gate = { cls: g.cls, end: g.end, p: g.p.map(v => +v.toFixed(5)) }; list.push(r); tried.push(g.cls + ' — новий варіант');
    } catch (e) { tried.push(g.cls + ' — ' + String(e && e.message || e).slice(0, 40)); }
  }
  const ranked = rankByClass(list, ix);
  const info = `ворота (${R.src}, z${R.z}): знайдено ${gs.length}, запитів ${asked}: ${tried.join('; ') || '—'}; порядок: ` + ranked.map(r => `${Math.round(r.gate.t / 60)} хв${r.gate.cls ? '*' : ''} (${Math.round(r.gate.major * 100)} % головними)`).join(', ');
  log('info', info);
  return { list: ranked, info };
}
