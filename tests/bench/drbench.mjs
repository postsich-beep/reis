// Стенд «два телефони»: перший їде з GPS (еталон — де фура справді), другий — без GPS, на справжньому коді ведення
// з web/js/nav.js. Кожну секунду: гіроскоп (накопичений поворот за годинниковою), вібрація (їдемо/стоїмо), за бажанням — вишки.
// Похибка = де вважає телефон без GPS − де фура насправді (уздовж рейсу), метри.
//   node tests/bench/drbench.mjs [сценарій,…] [--csv теки]
globalThis.window = globalThis; globalThis.addEventListener = () => {};
const mem = new Map(); globalThis.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.indexedDB = { open() { throw new Error('no idb'); } };
try { Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, language: 'uk' }, configurable: true }); } catch (_) {}
globalThis.document = { addEventListener() {}, hidden: false };
let NOW = Date.UTC(2026, 10, 23, 8, 0, 0); const realNow = Date.now; Date.now = () => NOW;
globalThis.performance = { now: () => NOW };
const core = await import('../../web/js/core.js');
const nav = await import('../../web/js/nav.js');
const { RouteIndex, bus, S } = core;
S.truck = { ...S.truck, vmax: 90 };
S.drAlgo = process.env.DR_ALGO || 'pf';                     // 'kf' — як було до 1.1.8 (для порівняння)
if (process.env.DR_OPTS) S.drOpts = JSON.parse(process.env.DR_OPTS);
nav.benchStart();

/* ---------- дороги: будуємо з відрізків і дуг (кут > 0 — праворуч) ---------- */
const LAT0 = 50, LON0 = 36, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 111320;
function buildRoad(ops) {
  let x = 0, y = 0, h = 0; const pts = [[LAT0, LON0]], marks = [];   // h — курс за годинниковою від півночі, градуси (не загорнутий)
  const push = () => pts.push([LAT0 + y / KY, LON0 + x / KX]);
  let dist = 0;
  for (const o of ops) {
    if (o.s) { const n = Math.max(1, Math.round(o.s / 10)); for (let i = 0; i < n; i++) { x += Math.sin(h * Math.PI / 180) * o.s / n; y += Math.cos(h * Math.PI / 180) * o.s / n; push(); } dist += o.s; }
    else if (o.t != null) {
      const len = Math.abs(o.t) * Math.PI / 180 * o.r, n = Math.max(2, Math.round(len / 2));
      marks.push({ d0: dist, d1: dist + len, ang: o.t, r: o.r, name: o.name || '' });
      for (let i = 0; i < n; i++) { h += o.t / n; x += Math.sin(h * Math.PI / 180) * len / n; y += Math.cos(h * Math.PI / 180) * len / n; push(); }
      dist += len;
    }
    if (o.zone) marks.push({ zone: o.zone, d: dist });
    if (o.stop) marks.push({ stop: o.stop, d: dist });
  }
  return { coords: pts, marks };
}
/* ---------- рейси для перевірки ---------- */
const ROADS = {
  // місто → з'їзд на трасу → траса з довгими дугами → з'їзд → місто зі світлофорами
  mix: () => buildRoad([{ zone: 'city' }, { s: 350 }, { t: 90, r: 12, name: 'перехрестя праворуч' }, { s: 700 }, { stop: 25 }, { t: -90, r: 12, name: 'світлофор ліворуч' }, { s: 1400 }, { t: 14, r: 300 }, { s: 600 },
    { t: 45, r: 25, name: 'розвилка 45°' }, { s: 900 }, { t: 40, r: 15 }, { t: -80, r: 18 }, { t: 40, r: 15, name: 'кільце прямо' }, { s: 700 }, { t: 40, r: 15 }, { t: -170, r: 18 }, { t: 40, r: 15, name: 'кільце ліворуч (−90)' }, { s: 500 },
    { zone: 'ramp' }, { t: 120, r: 80, name: 'заїзд на трасу' }, { zone: 'hwy' }, { s: 4000 }, { t: -35, r: 1000, name: 'дуга траси 35°' }, { s: 6000 }, { t: 18, r: 900 }, { s: 2500 }, { t: 55, r: 1000, name: 'дуга траси 55°' }, { s: 9000 },
    { t: -22, r: 800 }, { s: 3000 }, { zone: 'ramp' }, { t: 90, r: 60, name: "з'їзд 90°" }, { zone: 'city' }, { s: 900 }, { stop: 35 }, { t: -90, r: 12, name: 'світлофор ліворуч' }, { s: 1300 }, { t: 90, r: 12, name: 'перехрестя праворуч' }, { s: 700 }]),
  // довга траса з рідкими поворотами — найважче: контрольних точок мало
  hwy: () => buildRoad([{ zone: 'hwy' }, { s: 3000 }, { t: 30, r: 1200 }, { s: 12000 }, { t: -50, r: 1100, name: 'дуга траси 50°' }, { s: 15000 }, { t: 25, r: 900 }, { s: 8000 }, { zone: 'ramp' }, { t: 95, r: 55, name: "з'їзд 95°" }, { zone: 'city' }, { s: 1500 }, { t: -90, r: 12, name: 'перехрестя ліворуч' }, { s: 1000 }]),
  // місто: багато прямих кутів, світлофори
  city: () => buildRoad([{ zone: 'city' }, { s: 400 }, { t: 90, r: 12, name: 'праворуч' }, { s: 350 }, { stop: 20 }, { t: -90, r: 12, name: 'ліворуч' }, { s: 600 }, { t: 90, r: 12, name: 'праворуч' }, { s: 300 }, { t: 90, r: 12, name: 'праворуч' },
    { s: 800 }, { stop: 40 }, { t: -90, r: 12, name: 'ліворуч' }, { s: 250 }, { t: -90, r: 12, name: 'ліворуч' }, { s: 1200 }, { t: 60, r: 20, name: 'праворуч 60°' }, { s: 500 }, { t: 90, r: 12, name: 'праворуч' }, { s: 600 }]),
};
/* ---------- справжня фура: швидкість за дорогою (крива, зона, світлофори), розгін 0,45 м/с², гальмування 1 м/с² ---------- */
function truth(road, seed, opts = {}) {
  const idx = new RouteIndex(road.coords), N = Math.ceil(idx.total / 2) + 1;
  const ZONE = { city: 12.5, ramp: 11, hwy: 23.6 };
  const vlim = new Float64Array(N), head = new Float64Array(N);
  // курс уздовж дороги (не загорнутий) кожні 2 м
  let hPrev = null, acc = 0;
  for (let i = 0; i < N; i++) { const a = idx.at(i * 2), b = idx.at(Math.min(idx.total, i * 2 + 2)); const br = core.hav(a, b) > 0.5 ? core.bearing(a, b) : (hPrev == null ? 0 : ((hPrev % 360) + 360) % 360);
    if (hPrev == null) acc = br; else { let dd = br - (((acc % 360) + 360) % 360); dd = ((dd + 540) % 360) - 180; acc += dd; } hPrev = acc; head[i] = acc; }
  let zone = 'hwy'; const zones = road.marks.filter(m => m.zone).sort((a, b) => a.d - b.d), stops = road.marks.filter(m => m.stop);
  for (let i = 0; i < N; i++) {
    const d = i * 2; for (const z of zones) if (z.d <= d) zone = z.zone;
    const k = Math.abs(head[Math.min(N - 1, i + 3)] - head[Math.max(0, i - 3)]) * Math.PI / 180 / 12;   // кривина, 1/м
    vlim[i] = Math.min(ZONE[zone] * (opts.zoneK || 1), k > 1e-5 ? Math.sqrt((opts.aLat || 1.4) / k) : 99);
  }
  vlim[N - 1] = 0;
  for (let i = N - 2; i >= 0; i--) vlim[i] = Math.min(vlim[i], Math.sqrt(vlim[i + 1] ** 2 + 2 * 1.0 * 2));      // гальмування
  // їдемо: розгін 0,45 м/с², повільні коливання швидкості водієм ±6%, світлофори стоять своє
  let rnd = seed; const R = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = []; let d = 0, v = opts.v0 != null ? opts.v0 : 0, t = 0, waitUntil = -1, stopI = 0, ph = R() * 6;
  const stopList = stops.map(s => ({ d: s.d, dur: s.stop })).sort((a, b) => a.d - b.d);
  const jam = opts.jam;                  // затор на трасі: { d0, d1, v }
  while (d < idx.total - 1 && t < 4 * 3600) {
    for (let sub = 0; sub < 10; sub++) {
      const i = Math.min(N - 1, Math.round(d / 2));
      let target = vlim[i] * (1 + 0.06 * Math.sin(t / 47 + ph));
      // затор «стоп-поїхали»: 25–45 с стоїмо, 30–50 с повземо (як черга на блокпості чи ремонт)
      if (jam && d > jam.d0 && d < jam.d1) { const cyc = jam.go ? (t + ph * 13) % 80 : 99; target = Math.min(target, jam.go && cyc < 32 ? 0 : jam.v); }
      // світлофор попереду: гальмуємо до нього, стоїмо своє, рушаємо
      if (stopI < stopList.length) {
        const sd = stopList[stopI].d - d;
        if (sd <= 1.5) { if (waitUntil < 0) { waitUntil = t + stopList[stopI].dur; v = 0; } if (t < waitUntil) { t += 0.1; continue; } stopI++; waitUntil = -1; }
        else target = Math.min(target, Math.sqrt(2 * 1.0 * Math.max(0, sd - 1)));
      }
      v = v < target ? Math.min(target, v + (opts.acc || 0.4) * 0.1) : Math.max(target, v - 1.2 * 0.1);
      d += v * 0.1; t += 0.1;
    }
    out.push({ t: Math.round(t), d, v, yaw: head[Math.min(N - 1, Math.round(d / 2))] });
  }
  return { idx, out, head };
}
/* ---------- рейс для навігатора: маневри з плановим часом (як Valhalla для фури) ---------- */
// як Valhalla для фури: маневр на кожному повороті, час ділянки — за типом дороги (місто 40, з'їзд 35, траса 80 км/год)
function tripFor(idx, tr, road) {
  const n = idx.c.length, cuts = [0], SPD = { city: 11.1, ramp: 9.7, hwy: 22.2 };
  for (const m of road.marks) if (m.ang != null && Math.abs(m.ang) >= 30) cuts.push(m.d0);
  cuts.push(idx.total);
  const zones = road.marks.filter(m => m.zone).sort((a, b) => a.d - b.d), zoneAt = d => { let z = 'hwy'; for (const x of zones) if (x.d <= d + 1) z = x.zone; return z; };
  const iAt = d => idx.segAt(d), mans = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const d0 = cuts[k], d1 = cuts[k + 1]; if (d1 - d0 < 5) continue;
    let time = 0; for (let d = d0; d < d1; d += 50) time += Math.min(50, d1 - d) / SPD[zoneAt(d)];
    mans.push({ type: k ? 10 : 1, ins: 'Далі', street: '', streets: [], i0: iAt(d0), i1: iAt(d1), len: d1 - d0, time });
  }
  mans.push({ type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 });
  return { coords: idx.c, mans };
}
/* ---------- один прогін ---------- */
export function run(name, o = {}) {
  const road = ROADS[o.road || name.split(':')[0]]();
  // кожна поїздка — свій водій: темп (−8…+6% від зони), як проходить повороти, як розганяється; свій дрейф гіроскопа
  const fr = x => x - Math.floor(x), sd = o.seed || 7;
  o = { zoneK: 0.92 + 0.14 * fr(sd * 0.618), aLat: 1.2 + 0.5 * fr(sd * 0.414), acc: 0.35 + 0.15 * fr(sd * 0.732), bias: (fr(sd * 0.27) - 0.5) * 2.4, ...o };
  const tr = truth(road, sd, o);
  const idx = tr.idx, trip = tripFor(idx, tr, road);
  // скидаємо стан навігатора
  nav.setManualSpeed(null); mem.clear(); nav.setRoute(null);
  NOW += 3600e3;
  nav.setRoute(new RouteIndex(trip.coords), trip.mans);
  let seed = o.seed || 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s * Math.SQRT2; };
  const gpsUntil = o.gpsSec != null ? o.gpsSec : 90, bias = (o.bias != null ? o.bias : 0.6) / 60;   // дрейф гіроскопа, °/с
  const errs = [], log = [];
  let yawOff = 0, wig = null, lastNet = -999;
  const t0 = NOW;
  for (const s of tr.out) {
    NOW = t0 + s.t * 1000;
    const p = idx.at(s.d);
    if (s.t <= gpsUntil) bus.emit('gps', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: s.v, brg: p.brg, t: NOW });
    else if (o.net && s.t - lastNet >= (o.netEvery || 30)) {
      lastNet = s.t; const e = o.net;
      bus.emit('gps', { prov: 'network', lat: p.lat + gauss() * e * 0.55 / KY, lon: p.lon + gauss() * e * 0.55 / KX, acc: e, t: NOW });
    }
    // перестроювання на трасі: ±6° туди й назад за 6 с — гіроскоп це бачить, а дорога ні
    if (!wig && s.v > 15 && rnd() > 0.495 + 0.004) wig = { t: s.t, a: (rnd() > 0 ? 1 : -1) * 6 };
    let w = 0; if (wig) { const k = (s.t - wig.t) / 6; if (k >= 1) wig = null; else w = wig.a * Math.sin(Math.PI * k); }
    const yaw = o.noGyro ? undefined : s.yaw + bias * s.t + gauss() * 0.7 + w;
    bus.emit('sens', { var: s.v > 0.3 ? 0.08 + Math.abs(gauss()) * 0.02 : 0.0004 + Math.abs(gauss()) * 0.0001, yaw });
    if (o.place != null && s.t === gpsUntil + 10) nav.placeAtD(Math.max(0, s.d + o.place));     // стартова помилка (напр. з вишок)
    nav.benchTick();
    const P = nav.pos;
    if (s.t > gpsUntil + 6 && P.mode === 'dr') { const e = (P.rd || 0) - s.d, st = nav.debugState().pf; errs.push({ t: s.t, d: s.d, e, v: s.v, est: nav.speedView().kmh, sig: st ? st.sig : null, tr: st ? st.trust : null }); }
  }
  const ab = errs.map(x => Math.abs(x.e)).sort((a, b) => a - b), q = p => ab.length ? ab[Math.min(ab.length - 1, Math.floor(p * ab.length))] : NaN;
  // похибка одразу після кожної контрольної точки (через 20 с після виходу з повороту)
  const cps = road.marks.filter(m => m.ang != null && Math.abs(m.ang) >= 35);
  const after = cps.map(m => { const e = errs.find(x => x.d >= m.d1 + 150); return e ? { name: m.name || (m.ang + '°'), e: Math.round(e.e) } : null; }).filter(Boolean);
  return { name, marks: road.marks.filter(m => m.ang != null).map(m => ({ d0: Math.round(m.d0), d1: Math.round(m.d1), ang: m.ang })), n: errs.length, mean: Math.round(ab.reduce((a, b) => a + b, 0) / (ab.length || 1)), p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(ab[ab.length - 1] || 0),
    end: errs.length ? Math.round(errs[errs.length - 1].e) : null, after, km: Math.round(idx.total / 100) / 10, min: Math.round(tr.out[tr.out.length - 1].t / 6) / 10, errs };
}
export const SCEN = {
  'mix': {}, 'mix:зсув+600': { road: 'mix', place: 600 }, 'mix:зсув−500': { road: 'mix', place: -500 }, 'mix:затор': { road: 'mix', jam: { d0: 9000, d1: 13000, v: 4 } }, 'mix:стоп-поїхали': { road: 'mix', jam: { d0: 9000, d1: 12000, v: 7, go: true } },
  'mix:вишки': { road: 'mix', net: 1500 }, 'mix:без гіроскопа': { road: 'mix', noGyro: true }, 'mix:дрейф 3°/хв': { road: 'mix', bias: 3 },
  'hwy': {}, 'hwy:вишки': { road: 'hwy', net: 1500 }, 'city': {}, 'city:зсув+300': { road: 'city', place: 300 },
};
// Кожен сценарій — в окремому процесі: стан навігатора не переходить із прогону в прогін (як свіжий телефон)
const one = process.argv.indexOf('--one');
if (one > 0) { const k = process.argv[one + 1], seed = +process.argv[one + 2] || 7; const r = run(k, { ...SCEN[k], seed }); if (process.argv.includes('--slim')) delete r.errs; else r.errs = r.errs.map(x => ({ e: x.e })); process.stdout.write(JSON.stringify(r)); }
else if (process.argv[1] && process.argv[1].endsWith('drbench.mjs')) {
  const { execFileSync } = await import('child_process');
  const pick = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2].split(',') : Object.keys(SCEN);
  const rows = [];
  const seeds = (process.env.BENCH_SEEDS || '7').split(',').map(Number);
  for (const k of pick) for (const sd of seeds) { const r = JSON.parse(execFileSync(process.execPath, [process.argv[1], '--one', k, String(sd)], { maxBuffer: 64 << 20, env: process.env }).toString()); r.name = k + (seeds.length > 1 ? '#' + sd : ''); rows.push(r);
    if (!process.argv.includes('--quiet')) console.log(`${r.name.padEnd(22)} ${String(r.km).padStart(5)} км ${String(r.min).padStart(5)} хв | похибка: середня ${String(r.mean).padStart(5)} м, медіана ${String(r.p50).padStart(5)}, 95% ${String(r.p95).padStart(5)}, макс ${String(r.max).padStart(5)}, у кінці ${String(r.end).padStart(6)}`);
    if (process.argv.includes('--cp')) console.log('   після поворотів: ' + r.after.map(a => `${a.name} ${a.e > 0 ? '+' : ''}${a.e}`).join(' · ')); }
  if (process.argv.includes('--summary')) {
    const by = {}; for (const r of rows) { const k = r.name.replace(/#.*/, ''); (by[k] ||= []).push(r); }
    for (const [k, rs] of Object.entries(by)) console.log(`${k.padEnd(20)} середня ${String(Math.round(rs.reduce((a, r) => a + r.mean, 0) / rs.length)).padStart(5)} м · 95% ${String(Math.round(rs.reduce((a, r) => a + r.p95, 0) / rs.length)).padStart(5)} м · найгірший макс ${String(Math.max(...rs.map(r => r.max))).padStart(5)} м`);
  }
  const all = rows.flatMap(r => r.errs.map(x => Math.abs(x.e))).sort((a, b) => a - b);
  const gyro = rows.filter(r => !/без гіроскопа/.test(r.name)).flatMap(r => r.errs.map(x => Math.abs(x.e))).sort((a, b) => a - b);
  console.log(`З гіроскопом: середня ${Math.round(gyro.reduce((a, b) => a + b, 0) / gyro.length)} м, 95% ${Math.round(gyro[Math.floor(0.95 * gyro.length)])} м, макс ${Math.round(gyro[gyro.length - 1])} м`);
  console.log(`РАЗОМ: середня ${Math.round(all.reduce((a, b) => a + b, 0) / all.length)} м, 95% ${Math.round(all[Math.floor(0.95 * all.length)])} м, макс ${Math.round(all[all.length - 1])} м`);
}
