// (1.1.37) Швидкість з акселерометра після зупинки — «обнуління на зупинках».
// Без GPS головна похибка — швидкість між поворотами: у заторі фура повзе 5 км/год, а план рейсу каже 70. Гіроскоп швидкості не бачить.
// Акселерометр бачить розгін, але сам по собі «пливе»: 0,05 м/с² помилки за хвилину — це вже 3 м/с. Тому рахуємо короткими відрізками:
//   • фура стоїть (не трясе, не повертає, прискорення рівне) — це точка відліку: швидкість рівно 0; запам'ятовуємо показ акселерометра
//     (тяжіння + зсув нуля датчика) і зсув нуля гіроскопа (усі три осі);
//   • рушила — гіроскопом стежимо, як повернувся телефон відносно землі (кабіна «присідає» на розгоні, дорога йде вгору чи вниз,
//     фура повертає на схилі), і тяжіння в «розгін» не потрапляє; прискорення складаємо вздовж осі руху;
//   • вісь руху в осях телефона: поки є GPS — вчимо її з розгонів (зміна швидкості GPS проти прискорення); без неї — беремо напрямок
//     самого рушання (з місця фура їде вперед);
//   • що довше від зупинки, то менше віри: похибка росте з часом. За 60–90 с відрізок закінчується; наступна зупинка — нова точка.
//
// ЗСУВ НУЛЯ АКСЕЛЕРОМЕТРА (найпідступніше). На зупинці датчик показує «тяжіння + зсув нуля» — і розділити їх з одного положення не можна.
// Поки фура їде прямо, це не заважає. Але після повороту тяжіння в осях телефона лишається тим самим, а «повернутий» разом із ним
// зсув нуля дає хибні 0,1–0,4 м/с² — за пів хвилини це метри на секунду. Тому зсув нуля вчимо за GPS: похибка швидкості після поворотів
// лінійно залежить від нього (а як телефон повернувся — каже гіроскоп), тож за кілька рушань із поворотами він знаходиться найменшими
// квадратами. Не вивчено — після повороту оцінці майже не віримо.
//
// Вхід — раз на секунду від служби навігації (оболонка №9): a — середнє прискорення за секунду в осях телефона, м/с² (із тяжінням),
// w — середня кутова швидкість, рад/с. Старіша оболонка їх не надсилає — тоді нічого не рахуємо, усе працює як раніше.
//
// ТЕЛЕФОН ПЕРЕСТАВИЛИ. Нахил змінився — видно на першій же зупинці за тяжінням: вісь руху вчимо заново. Повернули в тримачі навколо
// вертикалі — тяжіння те саме, і цього на зупинці не видно; зате видно на рушанні: фура з місця їде вперед, і якщо перший поштовх не збігся
// з вивченою віссю — цьому відрізку не віримо, а вдруге поспіль — вчимо вісь заново. Зсув нуля — властивість самого датчика,
// від положення телефона не залежить, тому він лишається.
//
// САМОПЕРЕВІРКА. На справжньому телефоні це ще не міряли, тому програма перевіряє себе сама: поки GPS справжній, вона рахує швидкість
// з акселерометра «в тіні» й порівнює з GPS на кожному рушанні. Для ведення без GPS оцінка береться лише тоді, коли на цьому телефоні
// й у цьому кріпленні вона сходилась із GPS (більшість останніх рушань). Не сходиться — ведення лишається таким, як було.
const G = 9.80665;
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const add = (p, q, k = 1) => [p[0] + k * q[0], p[1] + k * q[1], p[2] + k * q[2]];
const mul = (p, k) => [p[0] * k, p[1] * k, p[2] * k];
const len = p => Math.hypot(p[0], p[1], p[2]);
const unit = p => { const m = len(p); return m > 0 ? mul(p, 1 / m) : [0, 0, 0]; };
const okVec = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const angle = (p, q) => { const m = len(p) * len(q); return m > 0 ? Math.acos(Math.max(-1, Math.min(1, dot(p, q) / m))) * 180 / Math.PI : 180; };
const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mv = (A, v) => [dot(A[0], v), dot(A[1], v), dot(A[2], v)];
const mtv = (A, v) => [A[0][0] * v[0] + A[1][0] * v[1] + A[2][0] * v[2], A[0][1] * v[0] + A[1][1] * v[1] + A[2][1] * v[2], A[0][2] * v[0] + A[1][2] * v[1] + A[2][2] * v[2]];
const mm = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
// поворот на вектор th (рад) — формула Родрігеса
function rot(th) {
  const a = len(th); if (a < 1e-9) return I3();
  const n = mul(th, 1 / a), s = Math.sin(a), c = 1 - Math.cos(a), K = [[0, -n[2], n[1]], [n[2], 0, -n[0]], [-n[1], n[0], 0]], K2 = mm(K, K);
  return I3().map((r, i) => r.map((x, j) => x + s * K[i][j] + c * K2[i][j]));
}
// розв'язок (A + λI)x = y для симетричної 3×3
function solve3(A, y, lam) {
  const M = A.map((r, i) => r.map((x, j) => x + (i === j ? lam : 0)));
  const d = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  if (!(Math.abs(d) > 1e-12)) return null;
  const c = (i, j) => { const r = [0, 1, 2].filter(k => k !== i), q = [0, 1, 2].filter(k => k !== j); return ((i + j) % 2 ? -1 : 1) * (M[r[0]][q[0]] * M[r[1]][q[1]] - M[r[0]][q[1]] * M[r[1]][q[0]]); };
  return [0, 1, 2].map(j => (c(0, j) * y[0] + c(1, j) * y[1] + c(2, j) * y[2]) / d);
}

export const ACC_DEF = {
  stillSec: 3,          // стільки секунд спокою — і це зупинка (точка відліку)
  stillDa: 0.12,        // м/с²: на стоянці середнє прискорення від секунди до секунди майже не міняється
  stillW: 0.012,        // рад/с (0,7 °/с): і телефон не повертається
  launchDv: 0.5,        // м/с: набрали стільки з місця — напрямок рушання відомий
  tMax: 90,             // с: довше від зупинки акселерометру не віримо
  sigMax: 3.5,          // м/с: і коли похибка виросла до цього — теж
  sig0: 0.2, sigT: 0.012, lev: 1e-4,     // похибка: стартова; м/с за секунду (шум); рад/с — «сповзання» рівня гіроскопом
  dLearn: 3, dLaunch: 10,                // °: наскільки точно знаємо вісь руху — вивчену за GPS і взяту з рушання
  bUnk: 0.15, bE: 1.5,                   // зсув нуля акселерометра: поки не вивчено — ±0,15 м/с² на вісь; похибка звірки швидкості з GPS, м/с
  mountDeg: 8,          // °: тяжіння в осях телефона змінилось більше — телефон переставили, вісь руху вчимо заново
  launchDeg: 35,        // °: рушили не туди, куди дивиться вивчена вісь (і не заднім ходом) — телефон повернули в тримачі
  handTilt: 0.25, handYaw: 0.75,         // рад/с: телефон нахиляють чи крутять так швидко — це рука, а не фура
  learnDv: 0.25, learnSum: 6,            // навчання осі: секунди, де GPS-швидкість змінилась на ≥0,25 м/с; досить, коли набралося 6 м/с
  proveMin: 4, proveOf: 6,               // «перевірено»: з останніх 6 рушань із GPS принаймні 4 зійшлися
};

export class AccelSpeed {
  constructor(o = {}, cal = null) { this.o = { ...ACC_DEF, ...o }; this.cal = cal && typeof cal === 'object' ? { ...cal } : {}; this.reset(); }
  reset() {
    this.st = 'none'; this.buf = []; this.prevA = null; this.a0 = null; this.bw = [0, 0, 0]; this.Q = I3();
    this.v = 0; this.sig = 0; this.tRun = 0; this.L = [0, 0, 0]; this.fL = null; this.leak = 0; this.flat = 0; this.rev = false; this.mis = false; this.C = [0, 0, 0];
    this.lastGps = null; this.F = okVec(this.cal.F) ? this.cal.F.slice() : [0, 0, 0]; this.Fsum = +this.cal.Fsum || 0;
    this.run = null; this.out = null; this.changed = false;
  }
  /** Чи телефон стоїть так само, як тоді, коли вчили вісь і зсув нуля. */
  sameMount() { return okVec(this.cal.g) && !!this.a0 && angle(this.cal.g, this.a0) <= this.o.mountDeg; }
  /** Вивчена вісь руху (одиничний вектор в осях телефона). */
  axis() { return okVec(this.cal.f) && this.sameMount() ? this.cal.f : null; }
  /** Вивчений зсув нуля акселерометра (м/с², в осях телефона) — або нуль, якщо ще не вивчено. Від положення телефона не залежить. */
  bias() { return okVec(this.cal.b) ? this.cal.b : [0, 0, 0]; }
  /** Вісь руху більше не годиться (телефон переставили чи повернули в тримачі): вчимо заново; зсув нуля лишається. */
  forgetAxis() { const c = this.cal; this.cal = { hist: [], ...(okVec(c.b) ? { b: c.b, bA: c.bA, by: c.by, bN: c.bN } : null) }; this.F = [0, 0, 0]; this.Fsum = 0; this.changed = true; }
  /** Якої помилки у швидкості (м/с, 1σ) чекати від невивченої частини зсуву нуля, якщо телефон від зупинки повернувся як C. */
  biasSig(C) {
    const o = this.o, lam = (o.bE * o.bE) / (o.bUnk * o.bUnk), A = Array.isArray(this.cal.bA) && this.cal.bA.length === 3 ? this.cal.bA : [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const x = solve3(A, C, lam); return x ? o.bE * Math.sqrt(Math.max(0, dot(C, x))) : o.bUnk * len(C);
  }
  biasKnown() { return okVec(this.cal.b) && this.biasSig([10, 10, 10]) < 0.6 * this.o.bUnk * len([10, 10, 10]); }
  /** Чи зійшлась оцінка з GPS на цьому телефоні (останні рушання). */
  proven() { const h = Array.isArray(this.cal.hist) ? this.cal.hist : []; const last = h.slice(-this.o.proveOf); return last.length >= this.o.proveMin && last.filter(x => x).length >= this.o.proveMin; }
  stats() { const h = Array.isArray(this.cal.hist) ? this.cal.hist : []; return { launches: h.length, good: h.filter(x => x).length, proven: this.proven(), err: this.cal.err != null ? this.cal.err : null, axis: !!this.axis(), bias: this.biasKnown(), st: this.st }; }
  /**
   * Одна секунда. s: { a: [x,y,z] м/с², w: [x,y,z] рад/с, quiet — вібрація нижча за поріг «їдемо» }, gps: { v м/с } | null — чесна швидкість GPS,
   * handled — телефон цієї секунди крутили в руках. Повертає { v, sig, age, flat } — швидкість, її похибка (1σ), секунд від зупинки,
   * flat — швидкість уже рівна (розгін скінчився); або null — оцінки зараз немає. Після кроку changed — калібрування змінилось (зберегти).
   */
  step(s, gps = null, handled = false, dt = 1) {
    const o = this.o; this.changed = false; this.out = null;
    if (!s || !okVec(s.a) || !okVec(s.w)) { this.st = 'none'; this.buf.length = 0; this.prevA = null; return null; }
    const a = s.a, w = s.w, gm = len(a), gv = gps ? gps.v : null;
    const drop = () => { this.endRun(); this.st = 'none'; this.buf.length = 0; this.prevA = a; this.lastGps = gv; return null; };   // чекаємо наступної зупинки
    if (handled || gm < 6 || gm > 14) return drop();                     // телефон у руках чи датчик бреше
    const calm = !!s.quiet && this.prevA != null && len(add(a, this.prevA, -1)) < o.stillDa && len(add(w, this.bw, this.st === 'none' ? 0 : -1)) < (this.st === 'none' ? 0.05 : o.stillW);
    this.prevA = a;
    if (calm) { this.buf.push({ a, w }); if (this.buf.length > 12) this.buf.shift(); } else this.buf.length = 0;
    if (this.buf.length >= o.stillSec) {
      // зупинка: швидкість рівно 0; показ акселерометра й нуль гіроскопа — середнє за спокійні секунди
      const n = this.buf.length; let ga = [0, 0, 0], gw = [0, 0, 0];
      for (const b of this.buf) { ga = add(ga, b.a); gw = add(gw, b.w); }
      if (this.st === 'run') this.endRun();
      this.a0 = mul(ga, 1 / n); this.bw = mul(gw, 1 / n); this.Q = I3();
      this.st = 'still'; this.v = 0; this.sig = 0.1; this.tRun = 0; this.L = [0, 0, 0]; this.fL = null; this.leak = 0; this.flat = 0; this.rev = false; this.mis = false; this.C = [0, 0, 0];
      if (okVec(this.cal.g) && angle(this.cal.g, this.a0) > o.mountDeg) this.forgetAxis();   // телефон переставили — вісь руху вчимо заново
      this.lastGps = gv;
      return (this.out = { v: 0, sig: 0.1, age: 0, flat: true });
    }
    if (this.st === 'none' || !this.a0) { this.lastGps = gv; return null; }
    if (this.st === 'still') { this.st = 'run'; this.run = { max: 0, n: 0, vg: 0, A: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y: [0, 0, 0], n2: 0 }; }
    // рух: як повернувся телефон відносно землі від зупинки (Q), де тепер тяжіння, і що лишилось — прискорення фури
    this.tRun += dt;
    const om = add(w, this.bw, -1), b = this.bias(), g0 = add(this.a0, b, -1);
    this.Q = mm(rot(mul(om, -dt)), this.Q);
    const g = mv(this.Q, g0), up = unit(g), wUp = dot(om, up), wTilt = len(add(om, up, -wUp));
    if (wTilt > o.handTilt || Math.abs(wUp) > o.handYaw || angle(g, g0) > 20) return drop();   // так фура не нахиляється й не крутиться — телефон узяли в руку
    const lin = add(add(a, g, -1), b, -1), h = add(lin, up, -dot(lin, up));
    const fK = this.mis || this.rev ? null : this.axis();
    let got = false;
    if (!this.fL) {
      this.L = add(this.L, h, dt);
      if (len(this.L) >= o.launchDv) {
        this.fL = unit(this.L); got = true;
        if (fK) {
          // рушання проти вивченої осі — задній хід; убік — телефон повернули в тримачі (вдруге поспіль — вісь уже не та, вчимо заново);
          // три «задні ходи» поспіль без жодного рушання вперед — телефон розвернули
          const c = dot(this.fL, fK), cal = this.cal;
          if (c < -0.5) { this.rev = true; cal.revN = (+cal.revN || 0) + 1; this.changed = true; if (cal.revN >= 3) this.forgetAxis(); }
          else if (c < Math.cos(o.launchDeg * Math.PI / 180)) { this.mis = true; cal.mis = (+cal.mis || 0) + 1; this.changed = true; if (cal.mis >= 2) this.forgetAxis(); }
          else if (cal.mis || cal.revN) { cal.mis = 0; cal.revN = 0; this.changed = true; }
        }
      }
    }
    const f = fK || this.fL;
    if (fK) this.v += dot(h, fK) * dt;                                  // вісь вивчено за GPS — складаємо вздовж неї з першої секунди
    else if (this.fL) this.v = got ? len(this.L) : this.v + dot(h, this.fL) * dt;   // вісь — напрямок рушання
    else this.v = len(this.L);                                          // ще не рушили як слід: скільки набрали в будь-який бік
    if (this.v < 0) this.v = 0;
    // наскільки помилка в зсуві нуля db дала б помилку у швидкості: v_помилка = C · db, де C — сума (I − Q)ᵀ·f за секундами
    if (f) this.C = add(this.C, add(f, mtv(this.Q, f), -1), dt);
    const al = f ? add(h, f, -dot(h, f)) : [0, 0, 0];
    this.leak += len(al) * Math.sin((fK ? o.dLearn : o.dLaunch) * Math.PI / 180) * dt;
    this.sig = Math.sqrt(o.sig0 ** 2 + (o.sigT * this.tRun) ** 2 + (G * o.lev * this.tRun * this.tRun / 2) ** 2 + this.leak ** 2 + this.biasSig(this.C) ** 2 + (f ? 0 : 0.6) ** 2);
    this.flat = f && Math.abs(dot(h, f)) < 0.15 ? this.flat + dt : 0;
    if (gv != null && this.lastGps != null && this.tRun <= o.tMax) {
      // вісь руху за GPS: секунда, де швидкість GPS помітно змінилась, а фура ще не поверталась від зупинки (зсув нуля не заважає)
      const dv = gv - this.lastGps;
      if (Math.abs(dv) >= o.learnDv && Math.abs(wUp) < 0.05 && len(this.C) < 3) {
        this.F = add(mul(this.F, 0.995), h, dv); this.Fsum = this.Fsum * 0.995 + Math.abs(dv);
        if (this.Fsum >= o.learnSum && len(this.F) > 0) { this.cal.f = unit(this.F); this.cal.g = this.a0.slice(); this.cal.F = this.F.slice(); this.cal.Fsum = this.Fsum; this.changed = true; }
      }
      // зсув нуля акселерометра за GPS: v_акс − v_GPS = C · (b_справжній − b), збираємо для найменших квадратів (поки вісь вивчена)
      if (this.run && fK && !this.rev && this.tRun >= 4 && this.tRun <= 60) {
        const E = this.v - gv + dot(this.C, b), c = this.C, r = this.run;
        for (let i = 0; i < 3; i++) { r.y[i] += c[i] * E; for (let j = 0; j < 3; j++) r.A[i][j] += c[i] * c[j]; }
        r.n2 += dot(c, c);
      }
      // самоперевірка: з 5-ї по 25-ту секунду після рушання порівнюємо з GPS
      if (this.run && this.tRun >= 5 && this.tRun <= 25 && f && !this.rev && !this.mis) { this.run.n++; this.run.max = Math.max(this.run.max, Math.abs(this.v - gv)); this.run.vg = Math.max(this.run.vg, gv); }
    }
    this.lastGps = gv;
    if (this.tRun > o.tMax || this.sig > o.sigMax || this.rev || this.mis) return null;
    return (this.out = { v: this.v, sig: this.sig, age: this.tRun, flat: this.flat >= 4 });
  }
  // відрізок від зупинки закінчився (нова зупинка чи телефон узяли в руку): зійшлося з GPS чи ні; що дізнались про зсув нуля
  endRun() {
    const r = this.run, o = this.o; this.run = null; if (!r) return;
    if (r.n2 > 0 && this.sameMount()) {
      const A = Array.isArray(this.cal.bA) && this.cal.bA.length === 3 ? this.cal.bA.map(x => x.slice()) : [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y = okVec(this.cal.by) ? this.cal.by.slice() : [0, 0, 0];
      for (let i = 0; i < 3; i++) { y[i] = y[i] * 0.97 + r.y[i]; for (let j = 0; j < 3; j++) A[i][j] = A[i][j] * 0.97 + r.A[i][j]; }
      const b = solve3(A, y, (o.bE * o.bE) / (o.bUnk * o.bUnk));
      if (b && len(b) < 1.5) { this.cal.bA = A; this.cal.by = y; this.cal.b = b.map(x => +x.toFixed(4)); this.cal.bN = +(((+this.cal.bN || 0) * 0.97) + r.n2).toFixed(1); this.changed = true; }
    }
    if (r.n < 6 || r.vg < 2) return;                                    // надто коротко чи майже не їхали — про точність нічого не каже
    const good = r.max <= Math.max(1.2, 0.2 * r.vg);
    const h = Array.isArray(this.cal.hist) ? this.cal.hist : []; h.push(good ? 1 : 0); while (h.length > 12) h.shift();
    this.cal.hist = h; this.cal.err = +(this.cal.err == null ? r.max : this.cal.err * 0.7 + r.max * 0.3).toFixed(2); this.changed = true;
  }
}

/** Для стенда: матриця повороту на вектор (рад). */
export const rotVec = rot;
