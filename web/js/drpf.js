// Ведення без GPS по рейсу: «хмара» можливих положень фури (частинковий фільтр). Без DOM — те саме працює й на стенді.
//
// Кожна частинка — своя гіпотеза «де фура на рейсі і як швидко їде». Щосекунди всі рухаються за фізикою фури:
// розгін ~0,45 м/с², гальмування до ~1,3 м/с², у поворотах повільно (90° перехрестя фура проходить на 15–20 км/год,
// далі знову розганяється до планової швидкості ділянки). А гіроскоп відсіює ті, що не збігаються з дорогою:
//  • телефон відчув поворот, а частинка за ці секунди поворотів рейсу не проїхала — відпадає (позначка доганяє поворот);
//  • частинка «проскочила» перехрестя, а фура не повертала — теж відпадає (позначка чекає перед поворотом);
//  • довга дуга траси (50–60° на кілометр) звіряється так само, як і перехрестя, — за тим, як курс змінюється в часі.
// Рейс без GPS не змінюється, тож усі повороти попереду — відомі контрольні точки.
//
// Контрольні точки для водія (показуємо на карті без GPS):
//  • червоні — різкі, на коротких метрах (перехрестя, світлофори, кільця, крутий з'їзд): звірка майже напевно;
//  • жовті — довгі дуги й плавні з'їзди від 35°.

const R2D = 180 / Math.PI, D2R = Math.PI / 180;
const brg = (a, b) => { const y = Math.sin((b.lon - a.lon) * D2R) * Math.cos(b.lat * D2R), x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) - Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lon - a.lon) * D2R); return (Math.atan2(y, x) * R2D + 360) % 360; };
const dist = (a, b) => { const kx = Math.cos(a.lat * D2R) * 111320; return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540); };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ---------- курс рейсу як функція відстані (не загорнутий: кільце — це справді 360°) ---------- */
export function headingProfile(idx, step = 5) {
  const n = Math.max(2, Math.ceil(idx.total / step) + 1), H = new Float32Array(n);
  let acc = null;
  for (let k = 0; k < n; k++) {
    const d = k * step, a = idx.at(clamp(d - 10, 0, idx.total)), b = idx.at(clamp(d + 10, 0, idx.total));
    const h = dist(a, b) > 1 ? brg(a, b) : (acc == null ? 0 : ((acc % 360) + 360) % 360);
    if (acc == null) acc = h; else { let dd = h - (((acc % 360) + 360) % 360); dd = ((dd + 540) % 360) - 180; acc += dd; }
    H[k] = acc;
  }
  return { step, n, H, total: idx.total, at(d) { const x = clamp(d / step, 0, n - 1), i = Math.floor(x), f = x - i; return i >= n - 1 ? H[n - 1] : H[i] + (H[i + 1] - H[i]) * f; } };
}

/* ---------- контрольні точки: де дорога повертає від 35° ----------
   (1.1.39) Переписано після рейсу Олексія Львовом (27.11). Лінія рейсу від сервера — це вузли карти: стоять густо (кожні 15–40 м)
   і не ідеально рівно (±0,2–0,5 м убік). Раніше «поворот» шукали за миттєвою кривиною (на 20 м), і кожен такий вузол її давав:
   ланцюжок вузлів зливав 90° перехрестя з усією вулицею за ним в один «довгий поворот траси» на пів кілометра й більше — жовта
   точка стояла за 200 м від рогу, а наступний «поворот» починався на рівній вулиці за кілометри до справжнього вигину. Позначка
   там стояла й чекала («Чекаю повороту»), а коли курс нарешті мінявся — стрибала.
   Тепер:
     1) різкі повороти (червоні): де курс за 50 м міняється на ≥ 40° — перехрестя, кільце, розвилка, крутий з'їзд;
        кілька таких поспіль (до 60 м між ними) — одна складна точка (кільце, зигзаг);
     2) затяжні (жовті): поза різкими, де курс за 120 м стабільно йде в один бік (від 0,0275 °/м, радіус до ~2 км) і набирає ≥ 35°;
     3) межі кожної точки — там, де курс справді відходить від в'їзного й доходить до виїзного (а не де «ворухнувся» вузол),
        тож позначка чекає біля самого повороту, а точка на карті стоїть на ньому. */
export const CP_MIN = 35, CP_SHARP = 40;
export function controlPoints(prof) {
  const { step, n, H } = prof, at = k => H[k < 0 ? 0 : k > n - 1 ? n - 1 : k];
  const W1 = Math.round(25 / step), W2 = Math.round(60 / step), GAP = Math.round(60 / step), PAD = Math.round(40 / step);
  const med = (k0, k1) => { const a = []; for (let k = Math.max(0, k0); k <= Math.min(n - 1, k1); k++) a.push(H[k]); a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
  // Межі повороту в кандидаті [a, b]: курс на в'їзді h0 й виїзді h1 — медіани «полиць» перед ним і за ним (у межах [lo, hi]: сусідній
  // поворот у полицю не потрапляє); далі звужуємо до місця, де курс справді відійшов від h0 і ще не дійшов до h1.
  const trim = (a, b, sharp, lo = 0, hi = n - 1) => {
    a = Math.max(lo, a); b = Math.min(hi, b);
    const h0 = med(Math.max(lo, a - PAD), a), h1 = med(b, Math.min(hi, b + PAD)), net = h1 - h0, tau = Math.max(5, 0.12 * Math.abs(net));
    let k0 = a, k1 = b;
    while (k0 < b && !(Math.abs(H[k0] - h0) >= tau && Math.abs(at(k0 + 1) - h0) >= tau && Math.abs(at(k0 + 2) - h0) >= tau)) k0++;
    while (k1 > k0 && !(Math.abs(H[k1] - h1) >= tau && Math.abs(at(k1 - 1) - h1) >= tau && Math.abs(at(k1 - 2) - h1) >= tau)) k1--;
    k0 = Math.max(a, k0 - 2); k1 = Math.min(b, k1 + 2);
    let amp = 0; for (let k = k0; k <= k1; k++) amp = Math.max(amp, Math.abs(H[k] - h0));
    return { k0, k1, h0, h1, net, amp: Math.max(amp, Math.abs(net)), sharp };
  };
  // 1) різкі: «зерно» — де за 50 м курс міняється на ≥ 40°; від нього точка росте, поки поворот лишається крутим (≥ 20° за 50 м) —
  //    так з'їзд радіусом 70–90 м (на межі «різкого») лишається ОДНІЄЮ точкою, а не ділиться навпіл, коли вузли лягли трохи нерівно
  const S = k => at(k + W1) - at(k - W1), sharp = [];
  { let cur = null;
    for (let k = 0; k < n; k++) { if (Math.abs(S(k)) < CP_SHARP) continue; if (cur && k - cur.k1 <= GAP) cur.k1 = k; else { if (cur) sharp.push(cur); cur = { k0: k, k1: k }; } }
    if (cur) sharp.push(cur); }
  for (const r of sharp) { while (r.k0 > 0 && Math.abs(S(r.k0 - 1)) >= CP_SHARP / 2) r.k0--; while (r.k1 < n - 1 && Math.abs(S(r.k1 + 1)) >= CP_SHARP / 2) r.k1++; }
  for (let i = sharp.length - 1; i > 0; i--) if (sharp[i].k0 - sharp[i - 1].k1 <= GAP) { sharp[i - 1].k1 = Math.max(sharp[i - 1].k1, sharp[i].k1); sharp.splice(i, 1); }
  const found = sharp.map((r, i) => trim(r.k0 - W1 - 4, r.k1 + W1 + 4, true, i ? sharp[i - 1].k1 + W1 : 0, i + 1 < sharp.length ? sharp[i + 1].k0 - W1 : n - 1));
  // 2) затяжні — лише між різкими: де курс за 120 м стабільно йде в один бік
  const taken = new Uint8Array(n); for (const f of found) for (let k = Math.max(0, f.k0 - 2); k <= Math.min(n - 1, f.k1 + 2); k++) taken[k] = 1;
  const T = k => at(k + W2) - at(k - W2), ARC = 0.0275 * 2 * W2 * step, arcs = [];
  { let cur = null;
    for (let k = 0; k < n; k++) {
      if (taken[k]) { if (cur) arcs.push(cur); cur = null; continue; }
      const v = T(k); if (Math.abs(v) < ARC) continue;
      if (cur && k - cur.k1 <= GAP && Math.sign(v) === cur.s) cur.k1 = k; else { if (cur) arcs.push(cur); cur = { k0: k, k1: k, s: Math.sign(v) }; } }
    if (cur) arcs.push(cur); }
  for (const r of arcs) {
    let lo = r.k0, hi = r.k1; while (lo > 0 && !taken[lo - 1]) lo--; while (hi < n - 1 && !taken[hi + 1]) hi++;     // вільний проміжок між різкими поворотами
    const f = trim(r.k0 - W2, r.k1 + W2, false, lo, hi); if (f.k1 - f.k0 >= 2) found.push(f);
  }
  const out = [];
  for (const f of found.sort((x, y) => x.k0 - y.k0)) {
    if (Math.abs(f.net) < CP_MIN && f.amp < CP_MIN + 7) continue;                                     // розмах без підсумкового кута (зигзаг, кільце) — із запасом на нерівність вузлів
    if (out.length && f.k0 * step <= out[out.length - 1].d1) continue;                                  // той самий поворот двічі не рахуємо
    const net = f.net, amp = f.amp, len = (f.k1 - f.k0) * step;
    // sgn — у який бік повертає (0 — складна точка: кільце, зигзаг, де курс іде туди-сюди); H0/H1 — курс рейсу на в'їзді й виїзді
    const mono = amp <= Math.abs(net) + 15 && Math.abs(net) >= 25;
    out.push({ d0: f.k0 * step, d1: f.k1 * step, d: Math.round((f.k0 + f.k1) / 2 * step), ang: Math.round(net), amp: Math.round(amp), len: Math.round(len),
      cls: f.sharp ? 'red' : 'yellow', sgn: mono ? Math.sign(net) : 0, H0: f.h0, H1: f.h1 });
  }
  return out;
}

/* ---------- фізика фури вздовж рейсу: планова швидкість ділянки і стеля в поворотах ---------- */
const STEP_V = 10;
function speedProfile(prof, planFn, vmax, aLat) {
  const total = prof.total, n = Math.ceil(total / STEP_V) + 1, plan = new Float32Array(n), cap = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const d = k * STEP_V;
    plan[k] = clamp(planFn ? planFn(d) : 16.7, 3, vmax);
    const kap = Math.abs(prof.at(d + 8) - prof.at(d - 8)) * D2R / 16;                      // рад/м
    cap[k] = Math.min(vmax, kap > 1e-5 ? Math.sqrt(aLat / kap) : vmax);
  }
  for (let k = n - 2; k >= 0; k--) cap[k] = Math.min(cap[k], Math.sqrt(cap[k + 1] * cap[k + 1] + 2 * 1.0 * STEP_V));   // загальмувати заздалегідь
  return { n, plan, cap, at: (arr, d) => arr[clamp(Math.round(d / STEP_V), 0, n - 1)] };
}

/* ---------- сама хмара ---------- */
export const PF_DEFAULTS = {
  N: 1400, hist: 64, windows: [3, 8, 20, 40, 60], slow: 0.1, regime: 0.001, cluster: 400, clusterMass: 0.6, alpha: 0.3, sig0: 10, sigK: 0.06, eps: 0.03, rateGain: 0.25, mWalk: 0.003, supportMin: 0.12, slowEnd: 0.003, seedShare: 0.4,
  aLat: 1.8, accUp: 0.5, accDn: 1.4, tau: 9, accNoise: 0.1, accP: 4, accTol: 1.5, accTolK: 0.15, accTolMin: 0.4, accZ0: 1, accZ1: 1.5, accM: 0.15, accMed: 0.05, accMSig: 1.5, mLo: 0.82, mHi: 1.18, mWide: 1.7, inject: 0.0005, lostInject: 0.03, lostL: 0.12, holdMax: 75, holdProven: 900,
  // «замок на повороті» (1.1.12): контрольну точку або відпрацьовано гіроскопом, або водій натиснув «Поворот» — інакше позначка чекає
  gate: true, gateLik: true, gMargin: 12, gTempoHi: 2.2, gTempoLo: 0.5, gSlowEnd: 0.02, gArc: false, gThrArc: 99,
  // (1.1.39) СУВОРЕ ПРАВИЛО (Олексій, 27.11: «поки поворот не пройшли — не перестрибуємо; без підтвердження позначка далі не йде»).
  // Контрольний поворот проходимо лише двома способами: телефон відчув цей поворот (гіроскоп) або водій торкнувся («Поворот», точка
  // на карті, ±100). Усе, що раніше «само» пропускало поворот — телефон відчув уже наступний, вишки кажуть «ви далі», гіроскоп
  // замовк, запасний пошук переставив позначку вперед, — тепер поворот НЕ проходить, а лише просить водія підтвердити (ask):
  // кнопка «Поворот» блимає. Виняток один: у телефоні гіроскопа немає зовсім — тоді, як і раніше, за швидкістю.
  gStrict: true,
};
// поріг «це поворот»: 35° (для пологих контрольних точок 35–47° — три чверті їхнього кута)
const gThr = c => clamp(0.75 * Math.abs(c.ang), 26, CP_MIN);
export class RouteTracker {
  constructor(idx, o = {}) {
    this.o = { ...PF_DEFAULTS, ...o };
    this.idx = idx; this.prof = headingProfile(idx); this.cps = controlPoints(this.prof);
    this.vmax = o.vmax || 25; this.sp = speedProfile(this.prof, o.planFn, this.vmax, this.o.aLat);
    // швидкість у самому повороті (найменша «стеля» на його дузі): із різкого перехрестя фура виїжджає повільно й розганяється
    for (const c of this.cps) { let v = this.vmax; for (let d = c.d0; d <= c.d1; d += 5) v = Math.min(v, this.sp.at(this.sp.cap, d)); c.vt = v; }
    const N = this.o.N, Hn = this.o.hist;
    this.d = new Float64Array(N); this.v = new Float32Array(N); this.m = new Float32Array(N); this.w = new Float64Array(N);
    this.hd = new Float32Array(N * Hn); this.ht = new Float64Array(Hn); this.hi = 0; this.hn = 0;
    this.yaw = []; this.bias = 0; this.handledUntil = 0; this.on = false; this.seed = 1234567;
    this.est = { d: 0, v: 0, sig: 0, w: 0 }; this.mode = null; this.stuck = { t: 0, d: 0 }; this.trust = 1;
    // замок: наступна контрольна точка, прив'язка курсу гіроскопа до курсу рейсу, події для екрана
    this.cpi = 0; this.off = null; this.cc = 0; this.ca = 0; this.baseA = null; this.baseUp = null; this.adj = 0; this.align = 'weak'; this.anchor = null; this.ev = []; this.undo = null;
    this.g = { state: 'go', cp: null, prog: 0, since: 0, handled: false }; this.eng = null; this.netAhead = 0;
  }
  // темп частинки відносно плану: здебільшого «як завжди» (0,82–1,18), а частина — повільно (затор, ремонт, 10–80%)
  pickM(base = null) {
    const o = this.o;
    if (base == null && this.rnd() < o.slow) return 0.1 + 0.7 * this.rnd();
    const wide = o.gate ? o.gTempoHi : o.mWide, low = o.gate && base != null ? Math.min(o.mLo - 0.1, Math.max(base, o.gTempoLo)) : o.mLo - 0.1;
    return base != null ? clamp(base + this.gauss() * 0.06, low, Math.max(o.mHi + 0.1, Math.min(base, wide))) : o.mLo + (o.mHi - o.mLo) * this.rnd();
  }
  rnd() { this.seed = (this.seed * 1103515245 + 12345) % 2147483648; return this.seed / 2147483648; }
  gauss() { let u = 0, v = 0; while (u === 0) u = this.rnd(); v = this.rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  // старт: де фура (± sig) і як їде (± sv). Чесна швидкість GPS перед втратою каже, як цей водій їде відносно плану:
  // 85 там, де план 80, — і далі хмара тримає такий самий темп (на трасі, у місті — пропорційно).
  init(d, sig, v, sv, t, known = false) {
    const N = this.o.N, pl = this.sp.at(this.sp.plan, d);
    const mc = known && v > 3 && pl > 3 ? clamp(v / pl, this.o.mLo, this.o.mHi) : null;
    this.mMed = mc; this.lbar = null; this.bias = this.bias || 0;
    for (let i = 0; i < N; i++) {
      this.d[i] = clamp(d + this.gauss() * sig, 0, this.idx.total); this.v[i] = clamp(v + this.gauss() * sv, 0, this.vmax);
      this.m[i] = mc != null && this.rnd() >= this.o.slow ? this.pickM(mc) : this.pickM(); this.w[i] = 1 / N;
    }
    this.hn = 0; this.hi = 0; this.on = true; this.mode = null; this.stuck = { t, d }; this.trust = 1;
    this.pushHist(t); this.estimate();
    // замок: які повороти вже позаду; курс гіроскопа прив'язуємо до курсу рейсу. Якщо GPS зник на ходу — фура точно їде вздовж рейсу;
    // якщо на стоянці (могла стояти як завгодно) — прив'язку уточнимо, щойно поїде рівно.
    this.regate(d); this.off = null; this.align = known && v > 2 ? 'ok' : 'weak'; this.eng = null; this.netAhead = 0; this.undo = null; this.conf = new Set();
    this.anchor = { d, t, sure: sig <= 60, sig };                 // місце відоме (GPS чи водій) — від нього міряємо, наскільки позначка відстає
    this.g = { state: 'go', cp: this.cps[this.cpi] || null, prog: 0, since: t, handled: false };
  }
  regate(d) { let i = 0; while (i < this.cps.length && this.cps[i].d <= d - 10) i++; this.cpi = i; this.eng = null; this.base = null; this.legStop = 0; }
  lastYaw() { return this.yaw.length ? this.yaw[this.yaw.length - 1] : null; }
  // точка в контрольному повороті, де курс рейсу відхилився від в'їзного на a градусів (у бік повороту)
  headD(c, a) {
    if (a <= 0) return c.d0;
    for (let d = c.d0; d <= c.d1; d += 2) if (c.sgn * (this.prof.at(d) - c.H0) >= a) return d;
    return c.d1;
  }
  // уся хмара — в одне місце (після кнопки «Поворот» чи скасування)
  place(d, sig, t, v = null) {
    const N = this.o.N;
    for (let i = 0; i < N; i++) { this.d[i] = clamp(d + this.gauss() * sig, 0, this.idx.total); if (v != null) this.v[i] = clamp(v + this.gauss() * 0.8, 0, this.vmax); this.w[i] = 1 / N; }
    this.hn = 0; this.hi = 0; this.mode = null; this.pushHist(t); this.estimate();
  }
  // середня планова швидкість ділянки рейсу
  planAvg(a, b) { let L = 0, T = 0; for (let d = a; d < b; d += 50) { const l = Math.min(50, b - d), v = this.sp.at(this.sp.plan, d); L += l; T += l / Math.max(v, 1); } return T > 0 ? L / T : 0; }
  // контрольну точку пройдено: by — 'gyro' (телефон відчув поворот), 'button' (водій), 'skip' (відчули вже наступну), 'auto' (гіроскопа немає), 'net' (вишки)
  passCp(by, t, c = this.cps[this.cpi], info = {}) {
    if (!c) return;
    const o = this.o, a = this.anchor;
    // Темп від точки до точки. Позначку довелося підтягнути вперед — водій їде швидше, ніж ми думали: у стільки ж разів і додаємо.
    // Позначка приїхала раніше й чекала (а фура при цьому їхала, не стояла на світлофорі) — трохи збавляємо, не більш як на 15% за раз:
    // приїхати до повороту зарано й почекати — не біда, а відстати й потім стрибати — гірше.
    if (!info.late && (by === 'gyro' || by === 'button') && a && a.sure && c.d0 - a.d >= 200) {
      const used = this.mMed != null ? this.mMed : 1, from = info.from != null ? info.from : c.d0; let f = 1;
      let w = 0.8;
      if (from < c.d0 - 30) { f = clamp((c.d0 - a.d) / Math.max(from - a.d, 40), 1, 2.5); w = clamp((from - a.d) / 300, 0.25, 0.8); }   // коротка ділянка — обережніше
      else if (info.tArr != null) { const pred = info.tArr - a.t, real = (t - a.t) - (this.legStop || 0); if (pred > 10 && real > pred) f = clamp(pred / real, 0.85, 1); }
      if (f !== 1) {
        this.mMed = clamp(used * (f > 1 ? 1 + w * (f - 1) : f), o.gTempoLo, o.gTempoHi);
        for (let i = 0; i < o.N; i++) if (this.m[i] >= 0.75 || this.rnd() < 0.7) this.m[i] = clamp(this.mMed + this.gauss() * 0.06, 0.3, o.gTempoHi);
      }
    }
    // Довга дуга — це ще й спідометр: від кута до кута телефон пройшов відому відстань за відомий час.
    // Їхали нею набагато повільніше за план (затор) — далі теж повземо, поки не розсмокчеться; трохи інакше — уточнюємо темп.
    if (o.gArc && by === 'gyro' && info.dAt != null && info.tEng != null && t - info.tEng >= 8 && c.d1 - info.dAt >= 150) {
      const pl = this.planAvg(info.dAt, c.d1), mArc = pl > 2 ? (c.d1 - info.dAt) / (t - info.tEng) / pl : null, used = this.mMed != null ? this.mMed : 1;
      if (mArc != null && mArc < 0.7 * used) { for (let i = 0; i < o.N; i++) if (this.rnd() < 0.85) this.m[i] = clamp(mArc * (1 + this.gauss() * 0.1), 0.08, 0.74); }
      else if (mArc != null && mArc < 1.4 * used) this.mMed = clamp(0.7 * used + 0.3 * mArc, o.gTempoLo, o.gTempoHi);
    }
    this.legStop = 0; this.ask = null;
    this.ev.push({ type: 'pass', by, t, cp: { d: c.d, d1: c.d1, ang: c.ang, cls: c.cls, sgn: c.sgn }, jump: Math.round(info.jump || 0), waited: Math.round(info.waited || 0), tempo: this.mMed, hand: !!info.hand, late: !!info.late });
    { const yl = this.lastYaw(); this.baseA = yl && yl.a != null ? yl.a : null; this.baseUp = yl ? yl.u || null : null; }   // (1.1.34) цей поворот телефона вже враховано
    if (by === 'gyro' || by === 'button') (this.conf || (this.conf = new Set())).add(this.cps.indexOf(c));
    if (this.cps[this.cpi] === c) this.cpi++; else this.cpi = Math.max(this.cpi, this.cps.indexOf(c) + 1);
    this.anchor = { d: c.d1, t, sure: by === 'gyro' || by === 'button', sig: 20 }; this.eng = null; this.netAhead = 0;
  }
  takeEvents() { const e = this.ev; this.ev = []; return e; }
  // куди фура доїхала б від d за dt секунд за планом рейсу й вивченим темпом (не далі за lim)
  ahead(d, dt, lim = Infinity) {
    const m = this.mMed != null ? this.mMed : 1; let x = d, left = Math.min(dt, 600);
    while (left > 0 && x < lim) { const st = Math.min(left, 2); x += Math.max(this.sp.at(this.sp.plan, x) * m, 1) * st; left -= st; }
    return Math.min(x, lim, this.idx.total);
  }
  // (1.1.39) Схоже, поворот уже пройдено, але підтвердження немає: why — 'next' (телефон відчув поворот, що пасує до НАСТУПНОЇ точки),
  // 'turn' (відчув поворот, якого тут на рейсі немає), 'net' (вишки кажуть, що фура вже далі). Позначка лишається, де була, —
  // кнопка «Поворот» блимає й чекає на водія.
  suspect(t, why, ang = 0) {
    const c = this.cps[this.cpi]; if (!c) return;
    if (this.ask && this.ask.d === c.d && t - this.ask.t0 < 120) {
      this.ask.t = t; if (Math.abs(ang) > Math.abs(this.ask.ang)) this.ask.ang = Math.round(ang);
      if (why === 'next' && this.ask.why !== 'next') { this.ask.why = 'next'; this.ask.t0 = t; }   // тепер знаємо більше: це саме наступна точка
      return;
    }
    this.ask = { t0: t, t, why, ang: Math.round(ang), d: c.d };
    this.ev.push({ type: 'ask', why, t, ang: Math.round(ang), cp: { d: c.d, d1: c.d1, ang: c.ang, cls: c.cls, sgn: c.sgn } });
  }
  // (1.1.34) Повертає в історію гіроскопа поворот, відкинутий після моменту t0 як «телефон у руках» (y і c — без відкинутого,
  // a — з ним): далі замок, пошук і відбір частинок бачать його так, наче його й не відкидали. Повертає, скільки градусів повернуто.
  unhandle(t0) {
    let add = 0, pa = null, pc = null;
    for (const q of this.yaw) {
      const a = q.a, c = q.c;
      if (pa != null && a != null && q.t > t0) add += (a - pa) - (c - pc);
      pa = a; pc = c;
      if (add) { q.y += add; q.c += add; }
    }
    this.adj -= add; this.cc += add;
    return add;
  }
  // Кнопка «Поворот»: водій каже «я на наступному повороті» — позначка стає одразу за ним, курс гіроскопа прив'язуємо заново
  passNext(t, i = this.cpi) {
    const c = this.cps[i]; if (!c || !this.on) return null;
    this.undo = { d: this.est.d, cpi: this.cpi, off: this.off, anchor: this.anchor, t };
    const from = this.est.d, wait = this.g.state === 'wait', waited = wait ? t - this.g.since : 0;
    // (1.1.39) Кнопка блимала «був?»: водій підтверджує поворот заднім числом — фура пройшла його раніше і відтоді їхала далі.
    //   'next' — телефон тоді відчув поворот НАСТУПНОЇ точки: одним натиском зараховано обидві (цю — водій, наступну — датчик);
    //   'turn' — відчув поворот, якого на рейсі тут немає: це й був цей поворот;  'net' — коли саме, не знаємо.
    // Позначку ставимо туди, куди фура доїхала б відтоді за планом рейсу (але не далі за наступний контрольний поворот).
    const ak = i === this.cpi && this.ask && this.ask.d === c.d && t - this.ask.t < 90 ? this.ask : null;
    const c2 = ak && ak.why === 'next' ? this.cps[i + 1] || null : null, last = c2 || c, nx = this.cps[i + (c2 ? 2 : 1)] || null;
    let to = last.d1 + 8, sig = 10;
    if (ak && ak.why !== 'net') {
      const lim = nx ? Math.max(to, nx.d0 - 15) : this.idx.total;
      to = this.ahead(to, Math.max(0, t - ak.t) + 5, lim);      // прохання з'являється секунд через п'ять після того, як телефон заспокоївся
      sig = clamp(10 + 0.25 * (to - last.d1 - 8), 10, 250);
    }
    const jump = to - from;
    this.place(to, sig, t, ak ? Math.min(Math.max(this.sp.at(this.sp.plan, to) * (this.mMed != null ? this.mMed : 1), 3), this.vmax) : Math.min(Math.max(this.est.v, 3), this.sp.at(this.sp.cap, c.d1 + 8), 8));
    this.passCp('button', t, c, { jump: c2 ? c.d1 + 8 - from : jump, waited, from, tArr: wait ? this.g.since : null, late: !!ak });
    if (c2) this.passCp('gyro', t, c2, { jump: to - c.d1 - 8, late: true });
    this.cpi = i + (c2 ? 2 : 1);                               // (1.1.34) поворот, вибраний на карті, може бути й позаду
    if (ak) this.anchor = { d: to, t, sure: false, sig };
    const y = this.lastYaw(); if (y) { this.off = y.c - this.prof.at(this.est.d); this.align = 'ok'; }
    this.g = { state: 'go', cp: this.cps[this.cpi] || null, prog: 0, since: t, handled: false };
    return Object.assign({}, last, { both: !!c2, late: !!ak, first: c });
  }
  // (1.1.34) Водій торкнувся контрольного повороту на карті: «я тут». Це може бути не найближчий поворот — і далі попереду,
  // і вже позаду. Гіроскоп за останні 25 с відчув саме такий поворот — фура вже повернула: ставимо одразу за ним, як кнопка
  // «Поворот» (курс гіроскопа прив'язуємо заново). Не відчув — фура ще перед поворотом: ставимо за 15 м до нього, і замок
  // чекає, поки телефон відчує поворот (курс не чіпаємо — інакше ми б прив'язали його до дороги після повороту).
  jumpTo(i, t) {
    const c = this.cps[i]; if (!c || !this.on) return null;
    const y1 = this.lastYaw(), y0 = this.yaw.find(y => y.t >= t - 25) || null, dy = y1 && y0 && y1 !== y0 ? y1.c - y0.c : 0;
    const turned = c.sgn ? Math.sign(dy) === c.sgn && Math.abs(dy) >= Math.max(25, 0.6 * Math.abs(c.ang)) : Math.abs(dy - c.ang) <= 40 && Math.abs(dy) >= 25;
    if (turned) { const r = this.passNext(t, i); return r ? { cp: r, after: true } : null; }
    this.undo = { d: this.est.d, cpi: this.cpi, off: this.off, anchor: this.anchor, t }; this.ask = null;
    // як ↑100/↓100: уся хмара (з історією) зсувається; курс прив'язується до дороги перед поворотом — фура саме там
    const d = Math.max(0, c.d0 - 15);
    this.shift(d - this.est.d, 12);
    this.anchor = { d: this.est.d, t, sure: true, sig: 12 }; this.netAhead = 0;
    this.g = { state: 'go', cp: this.cps[this.cpi] || null, prog: 0, since: t, handled: false };
    return { cp: c, after: false };
  }
  undoPass(t) {
    const u = this.undo; if (!u || t - u.t > 30) return false;
    this.place(u.d, 12, t); this.cpi = u.cpi; this.off = u.off; this.anchor = u.anchor; this.eng = null; this.undo = null;
    this.g = { state: 'go', cp: this.cps[this.cpi] || null, prog: 0, since: t, handled: false };
    return true;
  }
  pushHist(t) {
    const N = this.o.N, Hn = this.o.hist, j = this.hi;
    for (let i = 0; i < N; i++) this.hd[i * Hn + j] = this.d[i];
    this.ht[j] = t; this.hi = (j + 1) % Hn; this.hn = Math.min(Hn, this.hn + 1);
  }
  histIdx(t) {                                       // заміри історії, найближчий до моменту t (±0,6 с)
    const Hn = this.o.hist; let best = -1, bd = 0.6;
    for (let k = 0; k < this.hn; k++) { const j = (this.hi - 1 - k + Hn) % Hn, dd = Math.abs(this.ht[j] - t); if (dd < bd) { bd = dd; best = j; } }
    return best;
  }
  yawAt(t) { for (let k = this.yaw.length - 1; k >= 0; k--) { const y = this.yaw[k]; if (Math.abs(y.t - t) < 0.6) return y; if (y.t < t - 0.6) break; } return null; }
  // замір гіроскопа (накопичений поворот за годинниковою, градуси) — раз на секунду
  // hint — від датчиків руху телефона (60 разів на секунду): { handled } — телефон цієї секунди крутили в руках
  // (нахил відносно землі змінився), тож його «поворот» — не поворот фури.
  addYaw(t, raw, still, hint = null) {
    this.hasGyro = true;
    const last = this.yaw[this.yaw.length - 1];
    if (this.o.gate) {
      // Замок: секунду, коли телефон брали в руки, просто викидаємо (поворот за неї = 0), а не глушимо гіроскоп на хвилину
      const dt = last ? Math.max(0.2, t - last.t) : 1, dRaw = last ? raw - last.raw : 0;
      const bad = !!last && ((hint && hint.handled) || Math.abs(dRaw) > 40 * Math.max(1, dt));
      if (bad) { this.adj += dRaw; this.handledUntil = t + 1.5; }
      const y = raw - this.adj;
      if (last) { this.cc += (y - last.y) - this.bias * dt; this.ca = (this.ca || 0) + dRaw - this.bias * dt; }
      // (1.1.34) a — увесь поворот телефона, разом із секундами, відкинутими як «телефон у руках»; u — куди в осях телефона дивиться «вгору»
      // (нахил телефона відносно землі; null — датчиків WebView немає). Потрібні, щоб зарахувати різкий поворот — див. gateStep.
      const up = hint && Array.isArray(hint.up) ? hint.up : null, um = up ? Math.hypot(up[0], up[1], up[2]) : 0;
      this.yaw.push({ t, y, raw, c: this.cc, a: this.ca || 0, u: um > 0 ? [up[0] / um, up[1] / um, up[2] / um] : null });
    } else {
      if (last && Math.abs(raw - last.y) > 40 * Math.max(1, t - last.t)) this.handledUntil = t + this.o.windows[this.o.windows.length - 1] + 1;   // фура так швидко не повертає — телефон узяли в руки
      this.yaw.push({ t, y: raw, raw, c: raw });
    }
    const y = this.yaw[this.yaw.length - 1].y;
    while (this.yaw.length && t - this.yaw[0].t > 180) this.yaw.shift();
    // дрейф гіроскопа: коли стоїмо, курс не змінюється — що набіжить, те й дрейф
    if (still && last) { const n = this.yaw.length; const a = this.yaw[Math.max(0, n - 9)]; if (t - a.t >= 6 && Math.abs(y - a.y) / (t - a.t) < 1) this.bias = this.bias * 0.7 + 0.3 * (y - a.y) / (t - a.t); }
  }
  // Дрейф гіроскопа — з самої дороги: хмара впевнена, що останню хвилину фура їхала прямо (рейс там не повертає),
  // а телефон «набіг» на кілька градусів — це і є дрейф. Так дрейф вчиться і в русі, а не лише на стоянках.
  learnBias(t, moving) {
    if (moving === false || this.est.sig > 150 || t <= this.handledUntil) return;
    const y1 = this.yawAt(t), y0 = this.yawAt(t - 60); if (!y1 || !y0) return;
    const d = this.est.d, back = Math.max(0, d - this.est.v * 60 - 50);
    let flat = true; for (let x = back; x <= d + 20; x += 25) if (Math.abs(this.prof.at(x) - this.prof.at(back)) > 2.5) { flat = false; break; }
    if (!flat) return;
    const rate = (y1.y - y0.y) / (y1.t - y0.t);
    if (Math.abs(rate) < 0.2) this.bias = this.bias * 0.9 + rate * 0.1;
  }
  // Свій детектор повороту (і різкого, і довгої дуги): курс був спокійний → змінився на ≥35° → знову спокійний.
  // Рахуємо всю дугу цілком (55° на кілометрі — це 55°, а не перші 28°). Він запускає пошук по поворотах рейсу.
  turnEvent(t, moving) {
    const Y = this.yaw, n = Y.length; if (n < 12 || t <= this.handledUntil) return;
    const rate = (a, b) => { const y1 = this.yawAt(a), y0 = this.yawAt(b); return y1 && y0 ? ((y1.y - y0.y) / (y1.t - y0.t || 1)) - this.bias : null; };
    const r6 = rate(t, t - 6); if (r6 == null || Math.abs(r6) > 0.35) return;                // ще повертаємо
    // назад від «зараз»: де курс востаннє був спокійний до цього повороту
    const yNow = Y[n - 1].y - this.bias * Y[n - 1].t;
    let k = n - 7, start = null, mid = null;
    for (; k >= 6; k--) {
      const r = (Y[k].y - Y[k - 6].y) / (Y[k].t - Y[k - 6].t || 1) - this.bias;
      const dyk = yNow - (Y[k].y - this.bias * Y[k].t);
      if (Math.abs(r) <= 0.35 && Math.abs(dyk) >= CP_MIN) { start = k; break; }
    }
    if (start == null) return;
    const y0 = Y[start].y - this.bias * Y[start].t, dy = yNow - y0;
    for (let q = start; q < n; q++) if (Math.abs((Y[q].y - this.bias * Y[q].t) - y0) >= Math.abs(dy) / 2) { mid = Y[q].t; break; }
    if (mid == null || (this.lastEv && this.lastEv > Y[start].t - 1)) return;               // цей поворот уже враховано
    this.lastEv = t;
    this.lastTurn = { t, dy, ago: t - mid };
    return this.onGyroTurn(t, dy, t - mid);
  }
  handled(t) { this.handledUntil = Math.max(this.handledUntil, t + (this.o.gate ? 1.5 : this.o.windows[this.o.windows.length - 1] + 1)); }
  /* ---------- Замок на повороті ----------
     Курс гіроскопа прив'язано до рейсу: Hg = c − off ≈ курс рейсу там, де фура зараз. Між контрольними точками позначка їде
     за швидкістю. А в самій точці діє просте правило:
       • телефон ще не повертав — позначка чекає на в'їзді в поворот (межа hi) скільки треба: світлофор, затор;
       • телефон повернув на ≥35° у бік повороту — фура вже в ньому: позначка одразу стає туди, де курс рейсу збігається
         з курсом телефона (межа lo) — і на різкому перехресті, і на довгій дузі траси (там позначка йде дугою разом із курсом);
       • повернув до кінця або водій натиснув «Поворот» — точку пройдено, розгін далі.
     Якщо телефон відчув поворот «не в той бік» — це вже наступна точка (попередню фура пройшла непомітно): переходимо на неї. */
  reachable(c, t) {
    const e = this.est.d, a = this.anchor || { d: e, t, sig: 100 }, el = Math.max(0, t - a.t), trav = Math.max(0, e - a.d), near = c.d0 - e, sl = 2 * (a.sig || 0);
    let ok = c.d0 - a.d <= this.vmax * 1.15 * el + 150 + sl && near <= 1.5 * trav + 400 + sl;      // фура не могла заїхати так далеко / позначка не могла так відстати
    if (this.align === 'weak') ok = ok && near <= 150;                                             // зі стоянки (курс ще не прив'язано) — лише найближчий поворот
    return ok;
  }
  gateStep(t, moving, dt = 1) {
    const o = this.o, y = this.lastYaw(), G = this.g;
    let e = this.est.d, lo = -Infinity, hi = Infinity, done = null;
    const alive = !!y && t - y.t < 3.5;
    G.alive = alive; G.handled = alive && t <= this.handledUntil;
    if (moving === false) this.legStop = (this.legStop || 0) + dt;                             // скільки стояли на цій ділянці (світлофор)
    if (!alive && o.gStrict && this.hasGyro) {
      // (1.1.39) гіроскоп у телефоні є, але зараз мовчить (служба не встигла, датчик заснув) — підтвердити поворот нічим:
      // позначка доїжджає до нього й чекає; за швидкістю повороти більше не проходимо
      const c = this.cps[this.cpi] || null;
      this.eng = null; G.cp = c; G.prog = 0; G.dist = c ? Math.max(0, c.d0 - e) : null; G.ask = null;
      if (c) { hi = c.d0; for (let d = c.d0; d <= c.d1; d += 2) { hi = d; if (Math.abs(this.prof.at(d) - c.H0) >= o.gMargin) break; } }
      const st = c && e >= hi - 4 ? 'wait' : 'go'; if (st !== G.state) { G.state = st; G.since = t; }
      return { lo, hi, done, vt: c ? c.vt : undefined };
    }
    if (!alive) {
      // гіроскопа немає — повороти проходимо за швидкістю, як звичайний розрахунок
      while (this.cpi < this.cps.length && this.cps[this.cpi].d1 < e - 5) this.passCp('auto', t);
      this.off = null; this.base = null; this.eng = null; G.cp = this.cps[this.cpi] || null; G.prog = 0; G.dist = G.cp ? Math.max(0, G.cp.d0 - e) : null;
      if (G.state !== 'go') { G.state = 'go'; G.since = t; }
      return { lo, hi, done };
    }
    const H = d => this.prof.at(d), back = s => { const a = this.yawAt(t - s); return a ? Math.abs(y.c - a.c) : null; };
    // запасний пошук переставив позначку за поворот (або назад) — замок іде за нею
    if (!this.eng) {
      let moved = false;
      if (!o.gStrict) while (this.cpi < this.cps.length && this.cps[this.cpi].d1 < e - 60) { this.passCp('skip', t); moved = true; }
      while (this.cpi > 0 && e < this.cps[this.cpi - 1].d0 - 60) { this.cpi--; moved = true; }
      if (moved) { this.off = y.c - H(e); this.base = y.c; }
    }
    if (this.off == null) this.off = y.c - H(e);
    // «Поворот від останнього спокою»: поки курс спокійний (за 6 с — менш як 2,5°), база йде за ним; почали повертати — база стоїть,
    // і rot показує, на скільки телефон уже повернув. Дрейф гіроскопа й давні вигини дороги сюди не потрапляють.
    const c6 = back(6);
    if (this.base == null || (c6 != null && c6 <= 2.5 && !this.eng)) this.base = y.c;
    let rot = y.c - this.base;
    // (1.1.34) те саме для ПОВНОГО повороту телефона (y.a — разом із відкинутими секундами): база йде за спокійним курсом
    // і запам'ятовує нахил телефона в ту мить
    { const y6 = this.yawAt(t - 6), a6 = y6 && y.a != null && y6.a != null ? Math.abs(y.a - y6.a) : null;
      if (this.baseA == null || (a6 != null && a6 <= 2.5 && !this.eng && !G.handled)) { this.baseA = y.a != null ? y.a : 0; this.baseUp = y.u || null; this.baseAT = t; } }
    // Позначка щойно проскочила поворот без підтвердження (GPS зник перед самим перехрестям, фура ще стояла на світлофорі),
    // а телефон повертає саме зараз і саме туди — фура ще на ньому: повертаємо позначку на цей поворот.
    { const pv = this.cps[this.cpi - 1], pi = this.cpi - 1;
      if (!this.eng && !G.handled && pv && pv.sgn && !(this.conf && this.conf.has(pi)) && e >= pv.d && e - pv.d1 <= 150 && pv.sgn * rot >= gThr(pv)) {
        this.cpi = pi; this.off = y.c - pv.H0 - rot; this.place(this.headD(pv, pv.sgn * rot - 5), 6, t); e = this.est.d;
      } }
    let c = this.cps[this.cpi];
    // (1.1.34) Різкий поворот. Секунди, коли телефон повертався швидше за 40 °/с чи з нахилом, відкинуто як «телефон у руках» —
    // фура так не повертає. Але якщо позначка вже стоїть на цьому повороті й чекає («Чекаю повороту»), телефон повернувся саме в його
    // бік щонайменше на 0,6 кута, після цього 3 с спокійний і його нахил відносно землі той самий,
    // що й до повороту (лежить, як лежав, чи стоїть у тримачі, як стояв), — це поворот: фуру труснуло на ямі посеред повороту
    // або водій перевіряє ведення, повернувши телефон рукою (Олексій, 26.11: «повернув телефон на 90°, а він так і не повернув»).
    // Тоді відкинуті секунди повертаємо в історію гіроскопа — і далі працює звичайний замок, наче їх і не відкидали.
    // Узяли телефон у руку (нахил інший) чи повернули й поклали назад (повороту в підсумку немає) — не зараховуємо.
    if (c && c.sgn && !this.eng && !G.handled && y.a != null && this.baseA != null) {
      const A = Math.abs(c.ang), grA = c.sgn * (y.a - this.baseA), needS = 3, yb = this.yawAt(t - needS), near = !!y.u && !!this.baseUp && G.state === 'wait' && G.cp === c && t - G.since >= 1;   // без датчиків нахилу не видно, чи телефон у руці, — тоді не зараховуємо (як і було)
      const calmA = !!yb && yb.a != null && Math.abs(y.a - yb.a) <= 3 && t - this.handledUntil >= needS - 1.5;
      const sameUp = !!y.u && !!this.baseUp && (y.u[0] * this.baseUp[0] + y.u[1] * this.baseUp[1] + y.u[2] * this.baseUp[2]) >= 0.966;   // нахил змінився менш як на 15°
      if (near && calmA && sameUp && grA >= Math.max(gThr(c), 0.6 * A) && c.sgn * rot < gThr(c)) {
        const add = this.unhandle(this.baseAT != null ? this.baseAT - 1 : t - 60);
        if (Math.abs(add) >= 20) { rot = y.c - this.base; this.handAt = t; }
        this.baseA = y.a; this.baseUp = y.u || null; this.baseAT = t;
      }
    }
    const prev = this.cps[this.cpi - 1], nearCp = (c && e > c.d0 - 60) || (prev && e < prev.d1 + 30);
    const r = (y.c - this.off) - H(e), c5 = back(5);
    // рівна дорога й спокійний курс: гіроскоп і рейс мають казати одне — що набігло (дрейф, нерівність карти), потроху списуємо
    if (!G.handled && moving !== false && this.est.v > 1.5 && c5 != null && c5 <= 2 && !nearCp && !this.eng && Math.abs(H(e + 120) - H(e - 120)) < 4) {
      if (this.align === 'weak') { this.calmN = (this.calmN || 0) + 1; if (this.calmN >= 4) { this.off = y.c - H(e); this.align = 'ok'; } }
      else this.off += clamp(0.1 * r, -1, 1);
    } else if (this.align === 'weak') this.calmN = 0;
    if (!c) { G.cp = null; G.prog = 0; G.dist = null; if (G.state !== 'go') { G.state = 'go'; G.since = t; } return { lo, hi, done }; }
    // поворот «не в той бік» — це вже наступна точка (цю фура пройшла, а телефон не відчув)
    if (!this.eng && !G.handled) {
      const c2 = this.cps[this.cpi + 1];
      if (c2 && c2.sgn && c.sgn && c2.sgn !== c.sgn && c2.sgn * rot >= gThr(c2) && c2.d0 - c.d1 <= 3000 && this.reachable(c2, t)) {
        if (o.gStrict) this.suspect(t, 'next', rot);                                         // не перестрибуємо: просимо водія підтвердити
        else { this.off = y.c - c2.H0 - rot; this.passCp('skip', t, c); c = c2; }
      }
    }
    const at = e >= c.d0 - 30, thr = gThr(c), calm4 = (() => { const v = back(4); return v != null && v <= 2.5; })();
    const u = (y.c - this.off) - c.H0;
    const fit = (x, R) => !!x && x.sgn === Math.sign(R) && Math.abs(Math.abs(R) - Math.abs(x.ang)) <= Math.max(25, 0.45 * Math.abs(R));
    const mkEng = far => ({ t, from: e, v0: this.est.v, far, waited: G.state === 'wait' ? t - G.since : 0, tArr: G.state === 'wait' ? G.since : null });
    let restore = null;
    if (c.sgn) {
      let g = c.sgn * u; const gr = c.sgn * rot, A = Math.abs(c.ang);
      if (!this.eng && !G.handled) {
        // позначка вже біля повороту — досить, що телефон повернув на ≥35° (хоч повільно, хоч різко);
        // ще не доїхала — потрібен упевнений поворот «зі спокою» (понад половину кута) і щоб фура фізично могла до нього доїхати
        // (на довгій дузі траси, коли позначка вже на ній, досить 18° — далі позначка йде дугою разом із курсом телефона)
        const thrAt = c.len > 200 ? Math.min(thr, o.gThrArc) : thr;
        if (at ? (g >= thrAt || gr >= thrAt) : (gr >= Math.max(thr, 0.6 * A) && this.reachable(c, t))) {
          this.eng = mkEng(!at);
          if (!at || gr > g) { this.off = y.c - c.H0 - rot; g = gr; }                      // прив'язуємо курс до в'їзду в цей поворот
          this.eng.dAt = this.headD(c, g - 5);
        }
      }
      if (this.eng) {
        lo = this.headD(c, g - 5); hi = this.headD(c, g + o.gMargin); if (hi >= c.d1) hi = Infinity;
        const ended = (calm4 && t - this.eng.t >= 3) || t - this.eng.t > 90;
        // (1.1.39) Затяжна дуга: позначка вже йде нею разом із курсом телефона (це й є підтвердження датчиком).
        //   • Курс на кілька секунд завмер (перестроювання, пряма вставка, затор посеред дуги), а повернули ще мало — фура все одно
        //     на дузі: тримаємо позначку там, де курс рейсу збігається з курсом телефона, і чекаємо далі. Раніше тут спрацьовувало
        //     «поворот закінчився, кут замалий»: позначку кидало назад на в'їзд, і решти дуги вже не вистачало, щоб зарахувати її вдруге.
        //   • Повернули вже понад 0,6 кута й курс завмер — раніше позначка одразу стрибала в кінець дуги (на трасі це 200–400 м уперед,
        //     хоч фура ще посеред неї). Тепер шлагбаум відкрито (free): позначка доїжджає дугу сама, за швидкістю, без стрибка.
        //   • Скидаємо, лише коли курс повернувся до в'їзного (то була не дуга).
        const long = o.gStrict && c.len > 200, onArc = long && g >= 0.5 * thr;
        if (long && ended && g >= Math.max(thr, 0.6 * A)) this.eng.free = true;
        if (this.eng.free) hi = Infinity;
        if (g >= A - 12 || (!long && ended && g >= Math.max(thr, 0.6 * A))) { lo = c.d1; hi = Infinity; done = { c, calm: calm4 }; }
        else if (this.eng.free && e >= c.d1 - 5) done = { c, calm: calm4 };
        else if (ended && onArc) { /* лишаємось на дузі: межі lo/hi — за курсом телефона */ }
        else if (ended) {
          // телефон повернув і заспокоївся, але це явно не цей поворот (кут замалий). Якщо кут пасує до наступної точки — це вона
          // (цю фура пройшла непомітно); якщо ні — хибна тривога (об'їзд ями, заїзд на АЗС): повертаємо позначку, де була.
          const Rs = c.sgn * g, c2 = this.cps[this.cpi + 1];
          if (!o.gStrict && fit(c2, Rs) && c2.d0 - c.d1 <= 3000 && this.reachable(c2, t)) { lo = c2.d1; hi = Infinity; done = { c: c2, skip: c, calm: true }; }
          else {
            if (o.gStrict && fit(c2, Rs) && c2.d0 - c.d1 <= 3000) this.suspect(t, 'next', Rs); if (this.eng.far) restore = Math.min(c.d0 - 5, this.eng.from + this.eng.v0 * (t - this.eng.t)); this.eng = null; this.off = y.c - c.H0; this.base = y.c; lo = -Infinity; hi = this.headD(c, o.gMargin); }
        }
      } else hi = this.headD(c, Math.min(Math.max(0, g, gr) + o.gMargin, Math.max(thr, o.gMargin)));
      G.prog = Math.round(this.eng ? g : Math.max(g, gr));
    } else {
      // складна точка (кільце, зигзаг): чекаємо на в'їзді; телефон «закрутився» — їдемо крізь неї; заспокоївся — пройдено.
      // Здалеку (понад 250 м) на таку точку не перескакуємо: кілець багато, і всі «крутять» схоже.
      const au = Math.max(Math.abs(u), Math.abs(rot)); let hold = c.d0; for (let d = c.d0; d <= c.d1; d += 2) { hold = d; if (Math.abs(H(d) - c.H0) >= o.gMargin) break; }
      if (!this.eng && !G.handled && (at ? au >= 20 : Math.abs(rot) >= CP_MIN && c.d0 - e <= 250 && this.reachable(c, t))) this.eng = mkEng(!at);
      if (this.eng) { lo = hold; if ((calm4 && t - this.eng.t >= 4) || t - this.eng.t > 90) { lo = c.d1; done = { c, calm: true }; } }
      else hi = hold;
      G.prog = Math.round(au);
    }
    G.cp = c; G.dist = Math.max(0, c.d0 - e);
    G.ask = this.ask && this.ask.d === c.d && t - this.ask.t < 90 ? this.ask.why : null;      // «схоже, цей поворот уже позаду — підтвердіть»
    const st = this.eng ? 'turn' : (e >= hi - 4 ? 'wait' : 'go');
    if (st !== G.state) { G.state = st; G.since = t; }
    return { lo, hi, done, restore, vt: (done ? done.c : c).vt };
  }
  // крок у секунду: рух за фізикою → звірка з гіроскопом → відбір
  // proven — гіроскоп уже підтверджував повороти: тоді позначка чекає перед поворотом скільки треба (затор, світлофор)
  step(t, dt, { moving = true, manualV = null, proven = false, accV = null } = {}) {
    if (!this.on) return;
    const o = this.o, N = o.N, sp = this.sp, total = this.idx.total;
    // (1.1.37) Швидкість з акселерометра після зупинки (accel.js): { v, sig } — що свіжіша зупинка, то менша похибка sig і то сильніше
    // тягнемо до неї швидкість кожної гіпотези; похибка виросла — тягнемо слабше, і гіпотези самі повертаються до темпу рейсу.
    // Це окремий канал: «замок на повороті» й перевірка «телефон у руках» працюють, як працювали (на відміну від «водій назвав швидкість»).
    const aK = accV && manualV == null && moving !== false && accV.sig > 0 && Number.isFinite(accV.v) ? o.accP / (o.accP + accV.sig * accV.sig) : 0;
    // Темп: розгін скінчився, швидкість рівна — акселерометр прямо каже, у якому темпі проти плану їде водій саме зараз (затор — повільно,
    // вільна дорога — швидше за план). Навчаємо цього гіпотези: коли оцінка «видихнеться» (за хвилину-півтори від зупинки), вони
    // поїдуть далі в цьому ж темпі, а не повернуться до планового. Звичайний темп (не затор) запам'ятовує й уся хмара (mMed).
    const aM = aK > 0 && accV.flat && accV.sig < o.accMSig && o.accM > 0 ? o.accM * aK * Math.min(dt, 2) : 0, mTop = o.gate ? o.gTempoHi : o.mWide;
    if (aM > 0 && this.est) {
      const pl = sp.at(sp.plan, this.est.d);
      if (pl > 2 && sp.at(sp.cap, this.est.d) >= 0.9 * pl) {
        const mt = accV.v / pl, used = this.mMed != null ? this.mMed : 1;
        if (mt >= 0.75 * Math.min(used, 1)) this.mMed = clamp(used + o.accMed * aK * Math.min(dt, 2) * (clamp(mt, o.gTempoLo, mTop) - used), o.gTempoLo, mTop);
      }
    }
    const B = o.gate ? this.gateStep(t, moving, dt) : null;
    // Швидкість у повороті: телефон повертає на ω °/с, дорога там вигнута на κ °/м — отже, фура їде ω/κ м/с.
    // Дуга радіусом 1 км і 0,23 °/с — це 4 м/с (затор), 1,3 °/с — 23 м/с (траса). Підказуємо це частинкам у повороті.
    let omega = null, steady = false;
    if (t > this.handledUntil && manualV == null) {
      const y1 = this.yawAt(t), y0 = this.yawAt(t - 4), y8 = this.yawAt(t - 8);
      if (y1 && y0) omega = (y1.y - y0.y) / (y1.t - y0.t || 4) - this.bias;
      if (omega != null && y8) { const o8 = (y1.y - y8.y) / (y1.t - y8.t || 8) - this.bias; steady = Math.abs(o8 - omega) < 0.25 * Math.abs(omega) + 0.05; }   // повертає рівно вже 8 с
    }
    for (let i = 0; i < N; i++) {
      let v = this.v[i];
      if (omega != null && moving !== false && Math.abs(omega) > 0.15) {
        const dd = this.d[i], kap = (this.prof.at(dd + 10) - this.prof.at(dd - 10)) / 20;
        if (Math.abs(kap) > 0.03 && Math.sign(kap) === Math.sign(omega)) {
          const vm = omega / kap;
          if (vm > 0.5 && vm < this.vmax * 1.1) {
            v += o.rateGain * (vm - v);
          }
        }
      }
      if (manualV != null) {
        // водій сказав швидкість — їдемо нею, але перехрестя на 80 не проходять: перед поворотом — гальмуємо,
        // після — розгін (від повільного до вибраної), як фура насправді
        const cap = sp.at(sp.cap, this.d[i]), tgt = Math.min(manualV + this.gauss() * 0.4, cap);
        v = v > tgt ? Math.max(tgt, v - o.accDn * 1.5 * dt) : Math.min(tgt, v + Math.max(o.accUp, 0.8) * dt);
        if (v < tgt && cap >= manualV && v < manualV * 0.5) v = Math.min(tgt, Math.max(v, manualV * 0.5));   // щойно вибрали швидкість — не повземо з нуля
        v = Math.max(0, v);
      } else if (moving === false) v = 0;
      else {
        const d = this.d[i], tgt = Math.min(this.m[i] * sp.at(sp.plan, d), sp.at(sp.cap, d), this.vmax);
        let a = clamp((tgt - v) / o.tau * 2, -o.accDn, o.accUp) + this.gauss() * o.accNoise;
        if (v > sp.at(sp.cap, d)) a = Math.min(a, -o.accDn * 0.8);                              // перед поворотом гальмуємо
        v = clamp(v + a * dt, 0, this.vmax * 1.02);
        // інколи темп змінюється: почався затор (повільно) або скінчився (назад до темпу, якого хмара навчилась)
        const back = () => this.mMed != null ? this.pickM(this.mMed) : this.pickM(1);
        if (this.m[i] < 0.75 && this.rnd() < (o.gate ? o.gSlowEnd : o.slowEnd)) this.m[i] = back();   // «затор» скінчився (у середньому за ~5 хв)
        else if (this.rnd() < o.regime) this.m[i] = this.rnd() < 0.5 ? 0.1 + 0.6 * this.rnd() : back();
        else this.m[i] = clamp(this.m[i] + this.gauss() * o.mWalk, 0.08, this.m[i] > o.mHi + 0.1 ? (o.gate ? o.gTempoHi : o.mWide) : o.mHi + 0.1);
        if (aK > 0) {
          // тягнемо лише тоді, коли гіпотеза помітно розходиться з акселерометром (затор, «стоп-поїхали», водій їде не в темпі рейсу):
          // у межах звичайного розкиду темп рейсу точніший за акселерометр, і чіпати його — тільки шкодити. «Звичайний розкид» — частка
          // швидкості (15 %, від 0,4 до 1,5 м/с): на трасі план рейсу вгадує добре, а коли фура повзе 7 км/год — не вгадує зовсім
          const tol = clamp(o.accTolK * accV.v, o.accTolMin, o.accTol);
          const z = Math.abs(accV.v - v) / Math.sqrt(accV.sig * accV.sig + tol * tol), k = aK * clamp((z - o.accZ0) / o.accZ1, 0, 1);
          if (k > 0) v = clamp(v + k * (accV.v - v) + this.gauss() * 0.3 * accV.sig, 0, this.vmax * 1.02);
          if (aM > 0) { const pl = sp.at(sp.plan, d); if (pl > 2 && sp.at(sp.cap, d) >= 0.9 * pl) this.m[i] += aM * (clamp(accV.v / pl, 0.08, mTop) - this.m[i]); }
        }
      }
      const pd = this.d[i];
      let nd = clamp(pd + v * dt + this.gauss() * 0.3 * Math.sqrt(dt), 0, total);
      if (B) {
        // шлагбаум: хто під'їхав до непідтвердженого повороту — чекає на в'їзді. Гіпотези, що вже за ним (запасні, «а раптом фура далі»),
        // не чіпаємо — їх відсіє чи підтвердить подальша звірка.
        if (nd > B.hi && (o.gStrict || pd <= B.hi + 6)) {
          // (1.1.39) суворо: за непідтверджений поворот не заходить ЖОДНА гіпотеза — і ті, що опинились далі (запасні, від вишок), стають на в'їзд
          const to = B.hi - this.rnd() * 3, sh = to - nd; nd = to; v = Math.min(v, 2.5);
          if (o.gStrict && sh < -40) { const Hn = o.hist; for (let h = 0; h < Hn; h++) this.hd[i * Hn + h] = Math.max(0, this.hd[i * Hn + h] + sh); }
        }
        // телефон уже повернув — позначка в повороті, і їде так, як там їздять: різке перехрестя — повільно, дуга траси — з ходу
        if (nd < B.lo) {
          const to = Math.min(total, B.lo + this.rnd() * 4), sh = to - nd; nd = to;
          v = Math.max(Math.min(v, B.vt + 1), 0.9 * Math.min(this.m[i] * sp.at(sp.plan, nd), B.vt, this.vmax));
          if (o.gateLik && sh > 40) { const Hn = o.hist; for (let h = 0; h < Hn; h++) this.hd[i * Hn + h] = Math.min(total, this.hd[i * Hn + h] + sh); }   // і «слід» частинки — туди ж
        }
      }
      this.v[i] = v; this.d[i] = nd;
    }
    this.pushHist(t);
    // Тонка звірка з гіроскопом між контрольними точками (невеликі вигини дороги, дуги до 35°): відсіює гіпотези, що пройшли
    // вигин не тоді, коли телефон. На самих контрольних точках рішення приймає замок — просто й однозначно.
    const yNow = this.yawAt(t); let used = 0;
    if ((!B || o.gateLik) && yNow && t > this.handledUntil) {
      const Hn = o.hist, prof = this.prof;
      const lw = new Float64Array(N);
      for (const W of o.windows) {
        const yW = this.yawAt(t - W), j = this.histIdx(t - W); if (!yW || j < 0) continue;
        const dY = (yNow.y - yW.y) - this.bias * W, sig0 = o.sig0 + 0.03 * W;
        const jn = (this.hi - 1 + Hn) % Hn;
        for (let i = 0; i < N; i++) {
          const dH = prof.at(this.hd[i * Hn + jn]) - prof.at(this.hd[i * Hn + j]), r = dY - dH, s = sig0 + o.sigK * Math.max(Math.abs(dH), Math.abs(dY));
          lw[i] += Math.log((1 - o.eps) * Math.exp(-r * r / (2 * s * s)) + o.eps);
        }
        used++;
      }
      if (used) {
        const a = o.alpha * this.trust; let lbar = 0;
        for (let i = 0; i < N; i++) { const l = Math.exp(a * lw[i]); lbar += this.w[i] * l; this.w[i] *= l; }
        this.normalize();
        // уся хмара розійшлась із гіроскопом (фура «загубилась»: стартували не там, водій звернув не туди, де ми думали) —
        // розсипаємо більше запасних гіпотез ширше; інакше — зовсім трохи, щоб не розмивати те, чого хмара навчилась
        this.lbar = this.lbar == null ? lbar : this.lbar * 0.7 + lbar * 0.3;
      }
    }
    const lost = this.lbar != null && this.lbar < Math.pow(o.lostL, o.alpha * used || 1);
    this.resampleIfNeeded(); this.injectNear(lost ? o.lostInject : o.inject); this.estimate();
    if (B && o.gStrict && !B.done && this.est.d > B.hi) this.est.d = B.hi;                    // і сама позначка — не далі в'їзду
    if (B) {
      if (B.restore != null) this.place(B.restore, 25, t);
      if (B.done) {
        const c = B.done.c, en = this.eng || { from: this.est.d, waited: 0 }, y = this.lastYaw();
        if (B.done.skip) this.passCp('skip', t, B.done.skip);
        this.passCp('gyro', t, c, { jump: en.from < c.d0 - 30 ? c.d0 - en.from : 0, waited: en.waited, from: en.from, tArr: en.tArr, dAt: en.dAt, tEng: en.t, hand: this.handAt != null && t - this.handAt <= 10 });
        this.handAt = null;
        if (y && B.done.calm) { this.off = y.c - c.H1; this.align = 'ok'; }                  // уже їдемо рівно новою дорогою — прив'язуємо курс точно
        if (y) this.base = y.c;                                                              // цей поворот уже враховано — наступний рахуємо з нуля
        this.g.state = 'go'; this.g.since = t; this.g.cp = this.cps[this.cpi] || null; this.g.prog = 0;
      }
      // запасний пошук (якщо фура «загубилась» далі, ніж на один поворот) — як і раніше: гіпотези на схожих поворотах рейсу
      this.learnBias(t, moving); if (!this.eng && !B.done) this.turnEvent(t, moving);
      return;
    }
    this.learnBias(t, moving); this.turnEvent(t, moving);
    // запобіжник: гіроскоп «не бачить» поворотів (телефон лежить як попало, датчик збоїть) — не тримати позначку вічно
    if (moving !== false && this.est.d - this.stuck.d < 25) { if (t - this.stuck.t > (proven ? o.holdProven : o.holdMax)) this.trust = 0.15; }
    else { this.stuck = { t, d: this.est.d }; this.trust = Math.min(1, this.trust + 0.05); }
  }
  normalize() { let s = 0; for (const x of this.w) s += x; if (!(s > 0) || !isFinite(s)) { this.w.fill(1 / this.o.N); return; } for (let i = 0; i < this.o.N; i++) this.w[i] /= s; }
  resampleIfNeeded() {
    const N = this.o.N; let s2 = 0; for (const x of this.w) s2 += x * x;
    if (1 / s2 > N * 0.5) return;
    const Hn = this.o.hist, d = new Float64Array(N), v = new Float32Array(N), m = new Float32Array(N), hd = new Float32Array(N * Hn);
    let c = this.w[0], j = 0; const u0 = this.rnd() / N;
    for (let i = 0; i < N; i++) {
      const u = u0 + i / N; while (u > c && j < N - 1) { j++; c += this.w[j]; }
      d[i] = clamp(this.d[j] + this.gauss() * 2, 0, this.idx.total); v[i] = Math.max(0, this.v[j] + this.gauss() * 0.15); m[i] = this.m[j];
      hd.set(this.hd.subarray(j * Hn, j * Hn + Hn), i * Hn);
    }
    this.d = d; this.v = v; this.m = m; this.hd = hd; this.w.fill(1 / N);
  }
  // кілька частинок — у широкому вікні навколо оцінки: якщо хмара помилилась цілком, наступний поворот її знайде
  // wide — біля вишки: темп у ширших межах (водій їде на 40% швидше за план чи вдвічі повільніше) — виживуть ті,
  // що зійдуться з наступними вишками
  injectNear(p, around = null, R = null, wide = false) {
    const N = this.o.N, Hn = this.o.hist, k = Math.round(N * p); if (!k) return;
    const c = around != null ? around : this.est.d, rad = R != null ? R : clamp(3 * this.est.sig + 400, 500, 4000);
    for (let q = 0; q < k; q++) {
      const i = Math.floor(this.rnd() * N), d0 = clamp(c + (this.rnd() * 2 - 1) * rad, 0, this.idx.total), shift = d0 - this.d[i];
      this.d[i] = d0; this.v[i] = clamp(this.est.v + this.gauss() * 2, 0, this.vmax);
      this.m[i] = wide && this.rnd() < 0.5 ? 0.5 + (this.o.mWide - 0.5) * this.rnd() : this.mMed != null && this.rnd() > this.o.slow ? this.pickM(this.mMed) : this.pickM();
      for (let h = 0; h < Hn; h++) this.hd[i * Hn + h] = clamp(this.hd[i * Hn + h] + shift, 0, this.idx.total);
    }
  }
  // вишки чи Wi-Fi: точка, спроєктована на рейс (± acc); поодинокі «стрибки» вишок не перевертають хмару
  measure(z, acc, t = null) {
    const N = this.o.N, R = Math.max(acc * 0.7, 250), eps = 0.08;
    for (let i = 0; i < N; i++) { const r = z - this.d[i]; this.w[i] *= (1 - eps) * Math.exp(-r * r / (2 * R * R)) + eps; }
    this.normalize(); this.resampleIfNeeded(); this.injectNear(0.02, z, R, true); this.estimate();
    if (t != null) this.towerTempo(t, z);
    // позначка чекає на повороті, а вишки тричі поспіль кажуть «фура вже далеко за ним» — поворот пройдено непомітно
    if (this.o.gate && t != null) {
      const c = this.cps[this.cpi];
      if (c && this.g.state === 'wait' && z - Math.max(acc, 500) > c.d1) {
        if (++this.netAhead >= 3) {
          if (this.o.gStrict) this.suspect(t, 'net');                                        // вишки — не підтвердження: просимо водія
          else { this.passCp('net', t, c); const y = this.lastYaw(); if (y) this.off = y.c - c.H1; this.g.state = 'go'; this.g.since = t; }
        }
      }
      else this.netAhead = 0;
    }
  }
  // Темп за вишками: кожна вишка неточна (±1 км), але за 2–10 хв їхній ряд добре показує середню швидкість.
  // Медіана нахилів між парами вишок (Тейл — Сен): одна вишка, що «стрибнула» на 20 км, на неї не впливає.
  towerTempo(t, z) {
    const q = this.tw = (this.tw || []).filter(x => t - x.t < 600 && t >= x.t); q.push({ t, z });
    if (q.length < 6 || t - q[0].t < 150 || this.est.v < 3) return;
    const sl = [];
    for (let a = 0; a < q.length; a++) for (let b = a + 1; b < q.length; b++) { const dt = q[b].t - q[a].t; if (dt >= 60) sl.push((q[b].z - q[a].z) / dt); }
    if (sl.length < 8) return;
    sl.sort((x, y) => x - y);
    const vT = sl[sl.length >> 1], iq = sl[Math.floor(sl.length * 0.75)] - sl[Math.floor(sl.length * 0.25)];
    const pl = this.sp.at(this.sp.plan, this.est.d); if (!(pl > 3) || vT < 2 || iq > 0.5 * vT) return;   // розкид великий — не віримо
    const mt = clamp(vT / pl, 0.3, this.o.mWide);
    this.mMed = this.mMed == null ? mt : this.mMed * 0.6 + mt * 0.4;
    // частина хмари переходить на цей темп; хто з ним не зійдеться з наступними вишками — відсіється
    for (let i = 0; i < this.o.N; i++) if (this.rnd() < 0.25 && this.m[i] >= 0.75) this.m[i] = clamp(this.mMed + this.gauss() * 0.05, 0.3, this.o.mWide);
  }
  // водій: ↑100 / ↓100 — уся хмара зсувається, і довіра до точки висока
  shift(dd, sig = 30) {
    const c = this.est.d + dd, Hn = this.o.hist;
    for (let i = 0; i < this.o.N; i++) { const nd = clamp(c + this.gauss() * sig, 0, this.idx.total), s = nd - this.d[i]; this.d[i] = nd; for (let h = 0; h < Hn; h++) this.hd[i * Hn + h] += s; }
    this.w.fill(1 / this.o.N); this.estimate();
    if (this.o.gate) { this.ask = null; this.regate(this.est.d); const y = this.lastYaw(); this.off = y ? y.c - this.prof.at(this.est.d) : null; this.anchor = { d: this.est.d, t: y ? y.t : 0, sure: false, sig }; }
  }
  // оцінка: найщільніше місце хмари (не середнє: якщо гіпотез дві — не ставимо позначку посередині, де фури точно немає)
  estimate() {
    const N = this.o.N, B = 25; let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) { if (this.d[i] < lo) lo = this.d[i]; if (this.d[i] > hi) hi = this.d[i]; }
    const nb = Math.max(1, Math.ceil((hi - lo) / B) + 1), hist = new Float64Array(nb);
    for (let i = 0; i < N; i++) hist[Math.floor((this.d[i] - lo) / B)] += this.w[i];
    let best = 0, bv = -1;
    for (let b = 0; b < nb; b++) { let s = 0; for (let k = -3; k <= 3; k++) { const q = b + k; if (q >= 0 && q < nb) s += hist[q] * (4 - Math.abs(k)); } if (s > bv) { bv = s; best = b; } }
    // тримаємо попередню гіпотезу, доки нова не стане помітно сильнішою — позначка не скаче між двома місцями
    const peak = lo + (best + 0.5) * B;
    let c = peak;
    if (this.mode != null && Math.abs(this.mode - peak) > 200) {
      let wo = 0, wn = 0; for (let i = 0; i < N; i++) { if (Math.abs(this.d[i] - this.mode) < 150) wo += this.w[i]; if (Math.abs(this.d[i] - peak) < 150) wn += this.w[i]; }
      if (wo > 0.2 && wn < 1.6 * wo) c = this.mode;
    }
    // у головному скупченні (±400 м від піку) — зважена медіана: не тягнеться за поодинокими «хвостами» хмари
    const near = []; let sw = 0, sv = 0, all = 0, alld = 0;
    for (let i = 0; i < N; i++) { all += this.w[i]; alld += this.w[i] * this.d[i]; if (Math.abs(this.d[i] - c) < (this.o.cluster || 400)) { near.push(i); sw += this.w[i]; sv += this.w[i] * this.v[i]; } }
    const median = (ids, tot) => { ids.sort((a, b) => this.d[a] - this.d[b]); let acc = 0; for (const i of ids) { acc += this.w[i]; if (acc >= tot / 2) return i; } return ids[ids.length - 1]; };
    // хмара зібралась (після повороту) — беремо головне скупчення; розмита рівно (довга пряма) — медіану всієї хмари
    let d, v, ids;
    if (sw >= this.o.clusterMass * (all || 1)) { ids = near; const im = median(near.slice(), sw); d = this.d[im]; v = sv / sw; }
    else { ids = Array.from({ length: N }, (_, i) => i); const im = median(ids.slice(), all); d = this.d[im]; let s2 = 0, vv = 0; for (let i = 0; i < N; i++) if (Math.abs(this.d[i] - d) < this.o.cluster) { s2 += this.w[i]; vv += this.w[i] * this.v[i]; } v = s2 > 0 ? vv / s2 : 0; }
    // темп, якого навчилась хмара (зважена медіана m у скупченні) — лише коли вона впевнена (щойно звірилась на повороті),
    // інакше медленні гіпотези затору тягнули б «вивчений темп» униз
    // (із замком темп не «вгадуємо» за тим, які гіпотези вижили на повороті — так темп плутався з тим, як фура гальмувала перед ним;
    //  темп міняють лише факти: наскільки позначка відстала чи випередила на ділянці між двома звірками, і вишки)
    if ((!this.o.gate && this.est && this.est.sig < 80) || this.mMed == null) { const ms = ids.filter(i => Math.abs(this.d[i] - d) < this.o.cluster).sort((a, b) => this.m[a] - this.m[b]); let tw = 0; for (const i of ms) tw += this.w[i]; let acc = 0; for (const i of ms) { acc += this.w[i]; if (acc >= tw / 2) { this.mMed = this.m[i]; break; } } }
    let var_ = 0; for (let i = 0; i < N; i++) var_ += this.w[i] * (this.d[i] - d) ** 2;
    this.mode = d; this.est = { d, v, sig: Math.sqrt(var_ / (all || 1)), w: sw };
    return this.est;
  }
  // Гіроскоп упізнав поворот (від спокійного курсу до спокійного: dy градусів, середина — ago секунд тому).
  // Якщо хмара цього повороту в себе «не бачить» — фура загубилась: шукаємо всі повороти рейсу з таким самим знаком і кутом
  // уперед і назад (вікно — кілька кілометрів, ширше, що довше без звірки) і ставимо на кожен гіпотези «щойно його пройшла»
  // з правдоподібною історією руху. Далі звірка сама відбере справжню.
  onGyroTurn(t, dy, ago) {
    if (!this.on || Math.abs(dy) < CP_MIN || t <= this.handledUntil) return null;
    const o = this.o, N = o.N, Hn = o.hist, jn = (this.hi - 1 + Hn) % Hn, j0 = this.histIdx(Math.max(t - 2 * ago - 8, t - o.hist + 2));
    const tol = Math.max(20, 0.35 * Math.abs(dy));
    let sup = 0;
    if (j0 >= 0) for (let i = 0; i < N; i++) { const dH = this.prof.at(this.hd[i * Hn + jn]) - this.prof.at(this.hd[i * Hn + j0]); if (Math.abs(dH - dy) < tol) sup += this.w[i]; }
    if (globalThis.__pfLog) globalThis.__pfLog({ t, dy: Math.round(dy), ago: Math.round(ago), sup: +sup.toFixed(3), j0, e: Math.round(this.est.d), cpi: this.cpi });
    if (sup >= o.supportMin) return { sup, seeded: 0 };
    const W = clamp(4 * this.est.sig + 2500, 3000, 15000), e = this.est.d;
    // (1.1.39) суворо: уперед через непідтверджений поворот запасний пошук не переставляє — лише назад (позначка забігла)
    //            або на той поворот, на який позначка й так чекає; відчутий поворот без пари на рейсі — прохання підтвердити
    const gateI = o.gate && o.gStrict ? this.cpi : Infinity;
    if (o.gate && o.gStrict && this.cps[this.cpi] && !this.eng) {
      const c2 = this.cps[this.cpi + 1], c1 = this.cps[this.cpi];
      const fits = x => !!x && Math.sign(x.ang || x.amp) === Math.sign(dy) && Math.abs(Math.abs(x.ang) - Math.abs(dy)) < Math.max(25, 0.45 * Math.abs(dy));
      // Не питаємо, коли відчутий поворот нічого не каже про той, на який чекаємо:
      //  • його відчули ДО того, як позначку поставили сюди (водій торкнувся повороту на карті, натиснув «Поворот», «Я тут»);
      //  • це поворот, який позначка щойно лишила позаду (GPS зник на самому перехресті — фура ще повертала, а позначка вже за ним).
      const pv = this.cps[this.cpi - 1], justBehind = fits(pv) && e - pv.d1 <= 300 + this.vmax * ago;
      //  • фура фізично ще не могла доїхати до свого повороту (до нього кілометри, а від останньої звірки минуло мало):
      //    вигин дороги чи заїзд на АЗС не означає, що він уже позаду.
      const near = c1.d0 - e <= Math.max(300, 2 * this.est.sig + 150), can = near || this.reachable(c1, t);
      const kind = fits(c2) && !fits(c1) && c2.d0 - c1.d1 <= 3000 && (near || this.reachable(c2, t)) ? 'next' : can ? 'turn' : null;
      const fresh = !this.anchor || t - ago > this.anchor.t + 2;
      if (fits(c1) && near && !justBehind && fresh) {
        // Телефон відчув САМЕ ТОЙ поворот, на який чекає позначка (той самий бік і кут), і позначка біля нього. Замок його не
        // зарахував, бо кут набігав надто повільно (затор на дузі) чи з перервою, — але це і є підтвердження датчиком.
        // Поворот скінчився секунд шість тому (стільки курс має бути спокійним, щоб його «відчути» цілим).
        const nx = this.cps[this.cpi + 1], to = this.ahead(c1.d1 + 8, 6, nx ? Math.max(c1.d1 + 8, nx.d0 - 15) : this.idx.total);
        this.place(to, clamp(20 + 0.25 * (to - c1.d1), 20, 150), t);
        this.passCp('gyro', t, c1, { jump: Math.max(0, to - e), late: true });
        const y = this.lastYaw(); if (y) { this.off = y.c - this.prof.at(this.est.d); this.align = 'ok'; }
        this.g = { state: 'go', cp: this.cps[this.cpi] || null, prog: 0, since: t, handled: false };
        return { sup, seeded: 0, passed: true };
      }
      if (kind && !justBehind && fresh) this.suspect(t, kind, dy);
    }
    const cands = this.cps.filter((c, ci) => ci <= gateI && Math.sign(c.ang || c.amp) === Math.sign(dy) && Math.abs(Math.abs(c.ang) - Math.abs(dy)) < Math.max(25, 0.45 * Math.abs(dy)) && Math.abs(c.d - e) < W)
      .map(c => ({ c, p: Math.exp(-((c.d - e) ** 2) / (2 * (o.gate ? clamp(2 * this.est.sig + 150, 250, W / 2) : W / 2) ** 2)) }))
      .filter(x => !o.gate || x.p > 0.02).sort((a, b) => b.p - a.p).slice(0, 6);     // із замком — лише найближчі схожі повороти: у місті всі перехрестя «на одне лице»
    if (!cands.length) return { sup, seeded: 0 };
    const ps = cands.reduce((a, x) => a + x.p, 0), share = Math.round(N * o.seedShare);
    let k = 0;
    for (const { c, p } of cands) {
      const n = Math.max(8, Math.round(share * p / ps)), vAfter = Math.min(Math.max(this.est.v, 6), this.sp.at(this.sp.plan, c.d1));
      for (let q = 0; q < n && k < share; q++, k++) {
        const i = Math.floor(this.rnd() * N), v = clamp(vAfter * (0.7 + 0.5 * this.rnd()), 1, this.vmax);
        const dNow = clamp(c.d + v * 0.8 * ago + this.gauss() * (25 + 0.15 * v * ago), 0, this.idx.total);
        this.d[i] = dNow; this.v[i] = v; this.m[i] = this.mMed != null ? this.pickM(this.mMed) : this.pickM();
        for (let h = 0; h < this.hn; h++) { const jj = (this.hi - 1 - h + Hn) % Hn, back = t - this.ht[jj]; this.hd[i * Hn + jj] = clamp(dNow - v * 0.85 * back, 0, this.idx.total); }
        this.w[i] = 1 / N;
      }
    }
    this.normalize(); this.estimate();
    return { sup, seeded: k, cands: cands.map(x => Math.round(x.c.d)) };
  }
  // наступна контрольна точка попереду
  nextCp(d = this.est.d, minAhead = 30) { return this.cps.find(c => c.d1 > d + minAhead) || null; }
}
