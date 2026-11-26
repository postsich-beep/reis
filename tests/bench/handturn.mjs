// Стенд «телефон на столі» (1.1.34): рейс задано, GPS немає, швидкість — від водія; позначка доїжджає до контрольного повороту
// й чекає («Чекаю повороту: телефон його ще не відчув»). Телефон повертають рукою на кут рейсу — швидко, повільно, з нахилом,
// у той бік і не в той. Перевіряємо, чи програма зарахувала це як поворот (так Олексій перевіряє ведення без GPS, не виходячи з дому),
// і чи НЕ зараховує те, що поворотом не є (узяли телефон і поклали назад; покрутили не в той бік).
//   node tests/bench/handturn.mjs            — усі випадки, код виходу 1, якщо щось не так
globalThis.window = globalThis; globalThis.addEventListener = () => {};
const mem = new Map(); globalThis.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.indexedDB = { open() { throw new Error('no idb'); } };
try { Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, language: 'uk' }, configurable: true }); } catch (_) {}
globalThis.document = { addEventListener() {}, hidden: false };
let NOW = Date.UTC(2026, 10, 26, 8, 0, 0); Date.now = () => NOW; globalThis.performance = { now: () => NOW };
const core = await import('../../web/js/core.js');
const nav = await import('../../web/js/nav.js');
const { RouteIndex, bus, S } = core;
S.truck = { ...S.truck, vmax: 90 };
nav.benchStart();

const LAT0 = 49.8, LON0 = 24.0, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111320;
function buildRoad(ops) {
  let x = 0, y = 0, h = 0; const pts = [[LAT0, LON0]], marks = []; let dist = 0;
  const push = () => pts.push([LAT0 + y / KY, LON0 + x / KX]);
  for (const o of ops) {
    if (o.s) { const n = Math.max(1, Math.round(o.s / 10)); for (let i = 0; i < n; i++) { x += Math.sin(h * Math.PI / 180) * o.s / n; y += Math.cos(h * Math.PI / 180) * o.s / n; push(); } dist += o.s; }
    else { const len = Math.abs(o.t) * Math.PI / 180 * o.r, n = Math.max(2, Math.round(len / 2)); marks.push({ d0: dist, d1: dist + len, ang: o.t });
      for (let i = 0; i < n; i++) { h += o.t / n; x += Math.sin(h * Math.PI / 180) * len / n; y += Math.cos(h * Math.PI / 180) * len / n; push(); } dist += len; }
  }
  return { coords: pts, marks };
}
// як на знімку Олексія (Львів, Рахівська): старт, за 300 м — довгий поворот ліворуч (жовтий), далі різке перехрестя праворуч (червоне)
const ROADS = {
  'довгий ліворуч': [{ s: 300 }, { t: -100, r: 130 }, { s: 700 }, { t: 90, r: 12 }, { s: 600 }],
  'різкий праворуч': [{ s: 300 }, { t: 90, r: 12 }, { s: 700 }, { t: -90, r: 12 }, { s: 600 }],
  'різкий ліворуч': [{ s: 300 }, { t: -90, r: 12 }, { s: 700 }, { t: 90, r: 12 }, { s: 600 }],
};
/** Один випадок. o: road; ang — на скільки повернули телефон (за годинниковою +); dur — за скільки секунд; tilt — нахил руки під час повороту
 *  (підказка датчиків WebView: 'none' — датчиків немає, 'calm' — нахил малий, 'hand' — телефон у руці, нахил великий); back — повернули назад через back с */
export function run(o) {
  const road = buildRoad(ROADS[o.road]), idx = new RouteIndex(road.coords);
  nav.setManualSpeed(null); mem.clear(); nav.setRoute(null); NOW += 3600e3;
  const n = idx.c.length, mans = [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: idx.total, time: idx.total / 11 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }];
  nav.setRoute(new RouteIndex(road.coords), mans);
  let hint = null; globalThis.__motionHint = () => hint;
  const passes = []; const off = bus.on('cpPass', ev => passes.push({ by: ev.by, ang: ev.cp.ang, t: Math.round((NOW - t0) / 1000) }));
  const t0 = NOW; let yaw = 0, sec = 0, waitAt = null, rotAt = null, rotEnd = null, log = [];
  const p0 = idx.at(5);
  const tick = (v = 0.0004) => { sec++; NOW = t0 + sec * 1000; bus.emit('sens', { var: v, yaw }); nav.benchTick(); };
  // 20 с справжнього GPS на старті (стоїмо), далі GPS зникає; водій вибирає швидкість 60
  for (let i = 0; i < 20; i++) { sec++; NOW = t0 + sec * 1000; bus.emit('gps', { prov: 'gps', lat: p0.lat, lon: p0.lon, acc: 5, spd: 0, brg: p0.brg, t: NOW }); bus.emit('sens', { var: 0.0004, yaw }); nav.benchTick(); }
  for (let i = 0; i < 8; i++) tick();
  nav.setManualSpeed(60);
  const gate = () => { const st = nav.debugState().pf; return st && st.gate ? st.gate : null; };
  // їдемо до повороту й чекаємо на ньому 6 с
  for (let i = 0; i < 240 && waitAt == null; i++) { tick(); const G = gate(); if (G && G.state === 'wait') waitAt = sec; }
  if (waitAt == null) { off(); return { ...o, ok: false, why: 'позначка не стала чекати на повороті', mode: nav.pos.mode, gate: gate() }; }
  for (let i = 0; i < 6; i++) tick();
  const before = passes.length, rd0 = nav.pos.rd;
  // повертаємо телефон
  // нахил телефона відносно землі: FLAT — лежить/стоїть, як до повороту; HAND — у руці (інший нахил, 30°)
  const FLAT = [0, 0, 9.8], HAND = [0, 4.9, 8.5], inHand = o.tilt === 'hand' || o.tilt === 'stay', H = (handled, up, tilt = 2, peak = 5) => o.tilt === 'none' ? null : { handled, tilt, peak, up };
  hint = H(false, FLAT); tick();
  rotAt = sec; const steps = Math.max(1, Math.round(o.dur));
  for (let i = 0; i < steps; i++) { yaw += o.ang / steps; hint = inHand ? H(true, HAND, 25, 120) : H(false, FLAT, 3, Math.abs(o.ang / steps)); tick(); }
  // після повороту: 'hand' — поклали так само, як лежав; 'stay' — так і тримають у руці; back — потримали й повернули назад
  hint = H(inHand, o.tilt === 'stay' || o.back != null ? HAND : FLAT); tick(); hint = H(false, o.tilt === 'stay' || (o.back != null && inHand) ? HAND : FLAT, 1, 3);
  if (o.back != null) { for (let i = 0; i < o.back; i++) tick(); for (let i = 0; i < steps; i++) { yaw -= o.ang / steps; if (inHand) hint = H(true, HAND, 25, 120); tick(); } hint = H(false, FLAT, 1, 3); }
  for (let i = 0; i < 25; i++) tick();
  off();
  const passed = passes.slice(before), G = gate();
  return { ...o, passed: passed.length > 0, by: passed.map(p => p.by).join(','), after: passed.length ? passed[0].t - (rotAt - 0) - 0 : null, sec: passed.length ? passed[0].t - rotAt : null, moved: Math.round(nav.pos.rd - rd0), state: G && G.state };
}
const CASES = [];
for (const road of Object.keys(ROADS)) {
  const sgn = road.endsWith('праворуч') ? 1 : -1;
  // у той бік: швидко рукою (1 с), звичайно (2 с), повільно (4 с), як фура (8 с); з підказкою датчиків і без неї; телефон у руці (нахил)
  // (без датчиків нахилу WebView не видно, чи телефон у руці: тоді швидкий поворот, як і раніше, не зараховується — лише повільний, як у фури)
  for (const dur of [1, 2, 4, 8]) for (const tilt of ['none', 'calm', 'hand']) CASES.push({ road, ang: 90 * sgn, dur, tilt, want: tilt !== 'none' || dur >= 4 });
  CASES.push({ road, ang: 70 * sgn, dur: 1, tilt: 'calm', want: true });           // повернули не до кінця, але явно
  // не поворот: не в той бік; узяли в руку й тримають (нахил інший); узяли й поклали назад (швидко й за 10 с); ледь хитнули
  CASES.push({ road, ang: -90 * sgn, dur: 1, tilt: 'calm', want: false });
  CASES.push({ road, ang: 90 * sgn, dur: 1, tilt: 'stay', want: false });
  CASES.push({ road, ang: 90 * sgn, dur: 1, tilt: 'hand', back: 2, want: false });
  CASES.push({ road, ang: 90 * sgn, dur: 2, tilt: 'hand', back: 10, want: false });
  CASES.push({ road, ang: 90 * sgn, dur: 1, tilt: 'none', back: 2, want: false });
  CASES.push({ road, ang: 15 * sgn, dur: 1, tilt: 'calm', want: false });
}
if (process.argv[1] && process.argv[1].endsWith('handturn.mjs')) {
  let bad = 0;
  for (const c of CASES) {
    const r = run(c), ok = r.passed === c.want && r.ok !== false; if (!ok) bad++;
    const what = `${c.ang > 0 ? '+' : ''}${c.ang}° за ${c.dur} с, ${c.tilt === 'none' ? 'датчиків нахилу немає' : c.tilt === 'calm' ? 'телефон рівно' : c.tilt === 'stay' ? 'узяли в руку й тримають' : 'рукою, поклали як лежав'}${c.back != null ? `, за ${c.back} с — назад` : ''}`;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.road.padEnd(16)} ${what.padEnd(58)} → ${r.ok === false ? r.why : r.passed ? `поворот зараховано за ${r.sec} с (${r.by}), позначка пішла на ${r.moved} м` : `не зараховано (стан «${r.state}»)`}${ok ? '' : `   ← мало бути: ${c.want ? 'зараховано' : 'не зараховано'}`}`);
  }
  console.log(bad ? `ПРОВАЛЕНО: ${bad} з ${CASES.length}` : `УСІ ${CASES.length} ВИПАДКІВ ЯК ТРЕБА`);
  process.exit(bad ? 1 : 0);
}
