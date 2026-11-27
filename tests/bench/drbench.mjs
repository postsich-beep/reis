// Стенд «два телефони»: перший їде з GPS (еталон — де фура справді), другий — без GPS, на справжньому коді ведення
// з web/js/nav.js. Кожну секунду: гіроскоп (накопичений поворот за годинниковою), вібрація (їдемо/стоїмо), за бажанням — вишки.
// Похибка = де вважає телефон без GPS − де фура насправді (уздовж рейсу), метри.
//   node tests/bench/drbench.mjs [сценарій,…] [--csv теки]
// (1.1.37) Акселерометр і гіроскоп по осях (оболонка №9) — BENCH_ACC=1: телефон щосекунди дає середнє прискорення й кутову швидкість
// (фізика — accSim нижче), перед поїздкою 16 хв «їздить містом із GPS» (вісь руху, зсув нуля, самоперевірка). Чесне порівняння
// «з оцінкою й без неї» — на ТИХ САМИХ поїздках: BENCH_ACC=1 BENCH_ACCUSE=off (оцінку в розрахунок не беремо) проти BENCH_ACC=1.
// Без BENCH_ACC стенд працює, як до 1.1.37 (випадковий потік поїздок інший — порівнювати з BENCH_ACC=1 напряму не можна).
globalThis.window = globalThis; globalThis.addEventListener = () => {};
const mem = new Map(); globalThis.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
globalThis.indexedDB = { open() { throw new Error('no idb'); } };
try { Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, language: 'uk' }, configurable: true }); } catch (_) {}
globalThis.document = { addEventListener() {}, hidden: false };
let NOW = Date.UTC(2026, 10, 23, 8, 0, 0); const realNow = Date.now; Date.now = () => NOW;
globalThis.performance = { now: () => NOW };
const core = await import('../../web/js/core.js');
const nav = await import('../../web/js/nav.js');
const { AccelSpeed, rotVec } = await import('../../web/js/accel.js');
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
/* ---------- (1.1.37) акселерометр і три осі гіроскопа, як їх віддає служба навігації ----------
   Середнє за секунду в осях телефона: a — прискорення з тяжінням (м/с²), w — кутова швидкість (рад/с). Усередині секунди рахуємо 10 разів:
   розгін уздовж дороги, доцентрове в повороті, ухил дороги (горби: сума трьох хвиль), кабіна «присідає» на розгоні й нахиляється в повороті
   (із запізненням 0,7 с), телефон стоїть у тримачі під випадковим кутом. Датчики: сталий зсув нуля, шум (на ходу більший),
   гіроскоп «пливе» (випадкове блукання — за хвилину після зупинки рівень сповзає на ~0,4°). */
function accSim(tr, seed, o = {}) {
  let rs = (seed * 7919 + 13) % 2147483648; const R = () => ((rs = (rs * 1103515245 + 12345) % 2147483648) / 2147483648);
  const gauss = () => { let x = 0; for (let i = 0; i < 6; i++) x += R() - 0.5; return x * Math.SQRT2; };
  const G = 9.80665, mm = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j])), mv = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]), T = A => [0, 1, 2].map(i => [0, 1, 2].map(j => A[j][i]));
  const Rx = a => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]], Ry = a => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]], Rz = a => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const M = mm(mm(Rz(R() * 2 * Math.PI), Rx((20 + 55 * R()) * Math.PI / 180)), Ry((R() - 0.5) * 0.3));       // тримач: як завгодно навколо вертикалі, нахил 20–75°
  const kp = 0.006 + 0.014 * R(), kr = 0.01, ba = [0, 1, 2].map(() => gauss() * (o.accBias != null ? o.accBias : 0.12)), bw = [0, 1, 2].map(() => gauss() * 5e-4), drift = o.gyroWalk != null ? o.gyroWalk : 2e-5;
  // далі — дорога (горби) і шум: свої для кожної поїздки (o.leg), телефон той самий
  rs = (seed * 104729 + 7 + (o.leg || 0) * 9973) % 2147483648;
  const sg = o.grade != null ? o.grade : 0.015, ph = [R() * 6.28, R() * 6.28, R() * 6.28];
  const grade = d => sg * (0.9 * Math.sin(2 * Math.PI * d / 2300 + ph[0]) + 0.6 * Math.sin(2 * Math.PI * d / 870 + ph[1]) + 0.4 * Math.sin(2 * Math.PI * d / 310 + ph[2]));
  const C = (yawCw, th, ph) => mm(mm(Rz(-yawCw * Math.PI / 180), Ry(-th)), Rx(ph));                           // кузов → земля: курс, ніс угору, крен
  const out = []; let sq = 0, roll = 0, prevC = null;
  for (let k = 0; k < tr.out.length; k++) {
    const s1 = tr.out[k], s0 = k ? tr.out[k - 1] : { ...s1, v: s1.v, d: s1.d, yaw: s1.yaw }, al = s1.v - s0.v, wz = (s1.yaw - s0.yaw) * Math.PI / 180;   // за секунду
    const A = [0, 0, 0], W = [0, 0, 0];
    for (let j = 1; j <= 10; j++) {
      const f = j / 10, v = s0.v + al * f, d = s0.d + (s1.d - s0.d) * f, ay = -v * wz;                          // доцентрове: праворуч — мінус (вісь y — ліворуч)
      sq += (kp * al - sq) * (0.1 / 0.7); roll += (kr * ay - roll) * (0.1 / 0.7);
      const Cj = C(s0.yaw + (s1.yaw - s0.yaw) * f, Math.atan(grade(d)) + sq, roll), up = mv(T(Cj), [0, 0, 1]);
      const fb = [al + G * up[0], ay + G * up[1], G * up[2]];
      let wb = [0, 0, 0];
      if (prevC) { const D = mm(T(prevC), Cj); wb = [(D[2][1] - D[1][2]) / 0.2, (D[0][2] - D[2][0]) / 0.2, (D[1][0] - D[0][1]) / 0.2]; }
      prevC = Cj;
      const ap = mv(M, fb), wp = mv(M, wb);
      for (let q = 0; q < 3; q++) { A[q] += ap[q] / 10; W[q] += wp[q] / 10; }
      if (j === 10) out.upTrue = mv(M, up), out.fTrue = mv(M, [1, 0, 0]);
    }
    for (let q = 0; q < 3; q++) { bw[q] += gauss() * drift; A[q] += ba[q] + gauss() * (0.012 + 0.0012 * s1.v); W[q] += bw[q] + gauss() * 4e-5; }
    out.push({ a: A, w: W, up: out.upTrue, f: out.fTrue, ba: ba.slice(), bw: bw.slice() });
  }
  return out;
}
/* ---------- рейс для навігатора: маневри з плановим часом (як Valhalla для фури) ---------- */
// як Valhalla для фури: маневр на кожному повороті, час ділянки — за типом дороги (місто 40, з'їзд 35, траса 80 км/год)
function tripFor(idx, tr, road, planK = 1) {
  const n = idx.c.length, cuts = [0], SPD = { city: 11.1 * planK, ramp: 9.7 * planK, hwy: 22.2 * Math.min(1, planK * 1.6) };
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
export { accSim, truth, ROADS };
export function run(name, o = {}) {
  const road = ROADS[o.road || name.split(':')[0]]();
  // кожна поїздка — свій водій: темп (−8…+6% від зони), як проходить повороти, як розганяється; свій дрейф гіроскопа
  const fr = x => x - Math.floor(x), sd = o.seed || 7;
  o = { zoneK: 0.92 + 0.14 * fr(sd * 0.618), aLat: 1.2 + 0.5 * fr(sd * 0.414), acc: 0.35 + 0.15 * fr(sd * 0.732), bias: (fr(sd * 0.27) - 0.5) * 2.4, ...o };
  const tr = truth(road, sd, o);
  const idx = tr.idx, trip = tripFor(idx, tr, road, o.planK || 1);
  // (1.1.37) акселерометр: BENCH_ACC=1 — для всіх сценаріїв; оцінку беремо без самоперевірки ('on'), крім сценаріїв, що перевіряють саме її
  const useAcc = (o.imu != null ? !!o.imu : !!process.env.BENCH_ACC) && !o.noGyro, AS = useAcc ? accSim(tr, sd, o) : null;   // телефон без гіроскопа кутової швидкості не дає — оцінки немає        // (o.acc — це розгін водія, не плутати)
  S.accUse = useAcc ? (o.accUse || process.env.BENCH_ACCUSE || 'auto') : 'off';
  // До того, як GPS зник, водій уже їздив із ним (o.warm хвилин містом, типово 16): оцінювач за цей час вивчив вісь руху й зсув нуля
  // акселерометра і перевірив себе. Те саме калібрування лежить у телефоні й далі (як і насправді — воно зберігається між поїздками).
  nav.accelReset(); globalThis.__accWarm = null;
  if (useAcc) {
    const E = new AccelSpeed(), fr2 = x => x - Math.floor(x), warm = o.warm != null ? o.warm : 16;
    let wr = sd * 31 + 5; const wg = () => { let x = 0; for (let i = 0; i < 6; i++) x += ((wr = (wr * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5; return x * Math.SQRT2; };
    for (let leg = 1; leg <= Math.ceil(warm / 8); leg++) {
      const s2 = sd + leg, od = { zoneK: 0.92 + 0.14 * fr2(s2 * 0.618), aLat: 1.2 + 0.5 * fr2(s2 * 0.414), acc: 0.35 + 0.15 * fr2(s2 * 0.732) }, t2 = truth(ROADS.city(), s2, od), A2 = accSim(t2, sd, { ...o, leg });
      for (let q = 0; q < 6; q++) E.step({ a: A2[0].a, w: A2[0].w, quiet: true }, { v: 0 });
      t2.out.forEach((x, k) => E.step({ a: A2[k].a, w: A2[k].w, quiet: x.v <= 0.3 }, { v: Math.max(0, x.v + wg() * 0.15) }));
    }
    E.endRun();
    globalThis.__accWarm = JSON.stringify(E.cal);
  }
  // скидаємо стан навігатора
  nav.setManualSpeed(null); mem.clear(); if (globalThis.__accWarm) mem.set('reis.acc', globalThis.__accWarm); nav.setRoute(null);
  NOW += 3600e3;
  nav.setRoute(new RouteIndex(trip.coords), trip.mans);
  let seed = o.seed || 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s * Math.SQRT2; };
  const gpsUntil = o.gpsSec != null ? o.gpsSec : 90, bias = (o.bias != null ? o.bias : 0.6) / 60;   // дрейф гіроскопа, °/с
  const errs = [], log = []; let tapDone = false, tapPre = false, tapLog = null;
  // (1.1.38) Водій на стенді. Позначка сама повороту не перестрибує: кнопка «Поворот» блимає «був?» — і водій за drv секунд
  // (типово 8; BENCH_DRIVER=off — не відповідає взагалі) торкається її, ЯКЩО фура справді вже за цим поворотом. Просять даремно
  // (фура ще перед поворотом) — водій не торкається. Більше водій нічого не робить: кнопку «сам» не тисне.
  const drvEnv = process.env.BENCH_DRIVER, drv = o.driver != null ? o.driver : drvEnv === 'off' ? null : drvEnv ? +drvEnv : 8;
  const askS = { n: 0, good: 0, bad: 0, taps: 0, both: 0 }; let askAt = null, askCp = null;
  let Rg = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let yawOff = 0, wig = null, lastNet = -999, grab = null, grabNext = gpsUntil + 40 + 60 * Math.abs(rnd());
  // (1.1.34) підказка датчиків — ще й нахил телефона: у руці він інший (30°), а потім телефон стоїть у тримачі, як стояв (найгірший випадок: тримач повернули)
  globalThis.__motionHint = o.grab === 'hint' ? () => ({ handled: !!grab, tilt: grab ? 30 : 1, peak: 20, up: grab ? [0, 4.9, 8.5] : [0, 0, 9.8] }) : () => null;
  // перед виїздом фура кілька секунд стоїть (як і насправді) — перша точка відліку для акселерометра
  if (AS) for (let q = 6; q >= 1; q--) { NOW += 1000; bus.emit('sens', { var: 0.0004, yaw: o.noGyro ? undefined : tr.out[0].yaw, a: AS[0].a.map((x, i) => x + gauss() * 0.01), w: AS[0].w }); }
  const t0 = NOW; let sk = -1;
  for (const s of tr.out) {
    NOW = t0 + s.t * 1000; sk++;
    const p = idx.at(s.d);
    // (1.1.34) останні секунди перед втратою GPS точка лежить збоку від рейсу (АЗС, стоянка, глушіння вже кидає точки на 150–400 м)
    const side = o.lastOff && s.t > gpsUntil - (o.lastSec || 15) ? core.destPoint(p, (p.brg + 90) % 360, o.lastOff) : null;
    if (s.t <= gpsUntil) bus.emit('gps', { prov: 'gps', lat: side ? side.lat : p.lat, lon: side ? side.lon : p.lon, acc: side ? 25 : 5, spd: s.v, brg: p.brg, t: NOW });
    else if (o.net && s.t - lastNet >= (o.netEvery || 30)) {
      lastNet = s.t; const e = o.net;
      bus.emit('gps', { prov: 'network', lat: p.lat + gauss() * e * 0.55 / KY, lon: p.lon + gauss() * e * 0.55 / KX, acc: e, t: NOW });
    }
    // перестроювання на трасі: ±6° туди й назад за 6 с — гіроскоп це бачить, а дорога ні
    if (!wig && s.v > 15 && rnd() > 0.495 + 0.004) wig = { t: s.t, a: (rnd() > 0 ? 1 : -1) * 6 };
    let w = 0; if (wig) { const k = (s.t - wig.t) / 6; if (k >= 1) wig = null; else w = wig.a * Math.sin(Math.PI * k); }
    // телефон узяли в руки: 'fast' — ривок 100–150° за 2 с; 'hint'/'slow' — повільно, 20°/с три секунди (видно лише за нахилом телефона)
    if (o.grab && !grab && s.t >= grabNext) grab = { t: s.t, dur: o.grab === 'fast' ? 2 : 3, rate: (rnd() > 0 ? 1 : -1) * (o.grab === 'fast' ? 50 + 25 * Math.abs(rnd()) * 2 : 20) };
    let gW = null;
    if (grab) { if (s.t - grab.t >= grab.dur) { grabNext = s.t + 90 + 240 * Math.abs(rnd()); grab = null; } else { yawOff += grab.rate; gW = -grab.rate * Math.PI / 180; } }
    // (1.1.37) те саме бачать акселерометр і гіроскоп: телефон повернувся в тримачі навколо вертикалі (yaw — за годинниковою, тож оберт −rate),
    // усе, що «прив'язане до фури», в осях телефона тепер стоїть інакше; зсуви нуля датчиків лишаються в осях телефона
    let imu = null;
    if (AS) {
      const x = AS[sk], mvv = (A, v) => A.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]), mmm = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
      let wX = [0, 0, 0];
      if (gW != null && !process.env.BENCH_NOGRAB) { const u = mvv(Rg, x.up); wX = u.map(c => c * gW); Rg = mmm(rotVec(wX.map(c => -c)), Rg); }
      imu = { a: mvv(Rg, x.a.map((c, i) => c - x.ba[i])).map((c, i) => c + x.ba[i]), w: mvv(Rg, x.w.map((c, i) => c - x.bw[i])).map((c, i) => c + x.bw[i] + wX[i]) };
    }
    const yaw = o.noGyro ? undefined : s.yaw + bias * s.t + gauss() * 0.7 + w + yawOff;
    bus.emit('sens', { var: s.v > 0.3 ? 0.08 + Math.abs(gauss()) * 0.02 : 0.0004 + Math.abs(gauss()) * 0.0001, yaw, ...imu });
    if (o.place != null && s.t === gpsUntil + 10) nav.placeAtD(Math.max(0, s.d + o.place));     // стартова помилка (напр. з вишок)
    // (1.1.34) водій торкається на карті контрольного повороту, біля якого фура зараз: перед ним (за 20 м) чи щойно за ним (+30 м)
    if (o.tapCp != null && !tapDone) { const m = road.marks.filter(x => x.ang != null && Math.abs(x.ang) >= 35)[o.tapCp], at = o.tapAfter ? m.d1 + 30 : m.d0 - 20;
      if (m && o.tapOff != null && !tapPre && s.d >= at - 5 * Math.max(s.v, 3)) { tapPre = true; nav.placeAtD(Math.max(0, s.d + o.tapOff)); }   // позначка помиляється на tapOff
      if (m && s.d >= at) { tapDone = true; const rd0 = Math.round(nav.pos.rd); const mid = (m.d0 + m.d1) / 2, cp = nav.routeCps().slice().sort((a, b) => Math.abs(a.d - mid) - Math.abs(b.d - mid))[0]; const r = cp && nav.jumpToCp(cp.d); tapLog = { t: s.t, truth: Math.round(s.d), before: rd0, cp: cp && [Math.round(cp.d0), Math.round(cp.d1), cp.ang, cp.sgn], r: r && { after: r.after }, nowRd: Math.round(nav.pos.rd) }; } }
    nav.benchTick();
    const P = nav.pos;
    { const cv = P.mode === 'dr' ? P.cp : null, cpNow = cv && nav.routeCps().find(c => Math.abs(c.d - cv.d) < 1);
      if (cv && cv.ask && cpNow) {
        if (askCp !== cv.d) { askCp = cv.d; askAt = s.t; askS.n++; if (s.d > cpNow.d1) askS.good++; else askS.bad++; }
        if (drv != null && s.t - askAt >= drv && s.d > cpNow.d1 + 5) { const r = nav.passTurn(); if (r) { askS.taps++; if (r.both) askS.both++; } askAt = Infinity; }
      } else if (!cv || !cv.ask) { if (askAt === Infinity || !cv) askCp = null; } }
    if (s.t > gpsUntil + 6 && P.mode === 'dr') { const e = (P.rd || 0) - s.d, st = nav.debugState().pf; errs.push({ t: s.t, d: s.d, e, v: s.v, est: nav.speedView().kmh, acc: globalThis.__accTrace ? nav.accelState() : undefined, grab: !!grab, sig: st ? st.sig : null, tr: st ? st.trust : null, g: st && st.gate ? `${st.cpi}:${st.gate.state || '-'}:${st.gate.prog}:${st.gate.ang}${st.gate.handled ? ':H' : ''}` : '' }); }
  }
  const ab = errs.map(x => Math.abs(x.e)).sort((a, b) => a - b), q = p => ab.length ? ab[Math.min(ab.length - 1, Math.floor(p * ab.length))] : NaN;
  // похибка одразу після кожної контрольної точки (через 20 с після виходу з повороту)
  const cps = road.marks.filter(m => m.ang != null && Math.abs(m.ang) >= 35);
  const after = cps.map(m => { const e = errs.find(x => x.d >= m.d1 + 150); return e ? { name: m.name || (m.ang + '°'), e: Math.round(e.e) } : null; }).filter(Boolean);
  return { name, marks: road.marks.filter(m => m.ang != null).map(m => ({ d0: Math.round(m.d0), d1: Math.round(m.d1), ang: m.ang })), n: errs.length, mean: Math.round(ab.reduce((a, b) => a + b, 0) / (ab.length || 1)), p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(ab[ab.length - 1] || 0),
    end: errs.length ? Math.round(errs[errs.length - 1].e) : null, after, tap: tapLog && { ...tapLog, e: [5, 20, 60, 120].map(k => { const x = errs.find(z => z.t >= tapLog.t + k); return x ? Math.round(x.e) : null; }) }, km: Math.round(idx.total / 100) / 10, min: Math.round(tr.out[tr.out.length - 1].t / 6) / 10, asks: askS, errs };
}
export const SCEN = {
  'mix': {}, 'mix:зсув+600': { road: 'mix', place: 600 }, 'mix:зсув−500': { road: 'mix', place: -500 }, 'mix:затор': { road: 'mix', jam: { d0: 9000, d1: 13000, v: 4 } }, 'mix:стоп-поїхали': { road: 'mix', jam: { d0: 9000, d1: 12000, v: 7, go: true } },
  'mix:вишки': { road: 'mix', net: 1500 }, 'mix:без гіроскопа': { road: 'mix', noGyro: true }, 'mix:дрейф 3°/хв': { road: 'mix', bias: 3 },
  'hwy': {}, 'hwy:вишки': { road: 'hwy', net: 1500 }, 'city': {}, 'city:зсув+300': { road: 'city', place: 300 },
  // 1.1.12 — як на справжній дорозі: план удвічі повільніший за водія (Львів: 17 за планом, 42 насправді), GPS зник ще на стоянці,
  // телефон беруть у руки (ривком; повільно — з підказкою датчика нахилу і без неї)
  'city:план÷2': { road: 'city', planK: 0.5 }, 'city:зі стоянки': { road: 'city', gpsSec: 2, planK: 0.5 }, 'mix:план÷1.6': { road: 'mix', planK: 0.6 },
  // (1.1.34) Діма, Черкащина: GPS зник, коли останні точки вже лягли збоку від рейсу, — позначка пішла «вільно» і на рейс не повернулась
  'mix:точки збоку 200': { road: 'mix', lastOff: 200 }, 'hwy:АЗС збоку 350': { road: 'hwy', lastOff: 350, lastSec: 40 }, 'city:точки збоку 150': { road: 'city', lastOff: 150 },
  // (1.1.34) позначка відстала на 500 м (чи випередила на 600), водій торкається повороту на карті — перед ним чи вже за ним
  'mix:дотик перед поворотом': { road: 'mix', tapOff: -600, tapCp: 2 }, 'mix:дотик за поворотом': { road: 'mix', tapOff: 700, tapCp: 2, tapAfter: true },
  'city:дотик перед поворотом': { road: 'city', tapOff: 300, tapCp: 4 }, 'hwy:дотик за з\'їздом': { road: 'hwy', tapOff: -900, tapCp: 1, tapAfter: true },
  'mix:телефон ривком': { road: 'mix', grab: 'fast' }, 'mix:телефон у руках': { road: 'mix', grab: 'hint' }, 'mix:крутили непомітно': { road: 'mix', grab: 'slow' },
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
