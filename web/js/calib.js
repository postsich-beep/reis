// Калібрування телефона (1.1.22) — щоб без GPS телефон точніше відчував повороти фури.
//
// Навіщо. Без GPS позначку на рейсі ведемо за гіроскопом: телефон відчув поворот на стільки-то градусів — отже, машина
// пройшла цей поворот рейсу (nav.js: detectTurn, контрольні повороти). У кожного телефона гіроскоп трохи свій: поворот на
// 90° один показує як 87°, інший — як 93°; дехто дає повільний дрейф. Калібрування міряє це на КОНКРЕТНОМУ телефоні.
//
// Як. Телефон тримають так, як він стоїть у тримачі (вертикально або трохи нахилений — поворот однаково рахуємо навколо
// вертикалі, sensors.js), і роблять три короткі кроки:
//   1) тримати нерухомо ~2,5 с — міряємо дрейф гіроскопа і як стоїть телефон;
//   2) повернути ЛІВОРУЧ на 90° (доки телефон не стане ребром до очей) і затримати — фіксуємо, скільки побачив гіроскоп;
//   3) повернути ПРАВОРУЧ на 90° від прямого положення (через пряме, знову до «ребром») і затримати.
// Між «ребром ліворуч» і «ребром праворуч» рівно 180°, хоч би як неточно стояло «прямо» на початку, — тому поправку беремо
// з усього розмаху: k = 180 / (ліворуч + праворуч). Це точніше, ніж довіряти одному повороту «на око».
//
// Що з цим робить навігація: кут повороту від служби множиться на k (nav.js: calYaw). Дрейф лише показуємо й перевіряємо
// (Android сам його постійно компенсує; постійна поправка «назавжди» могла б зашкодити).
//
// Тут — лише логіка (без екрана й без датчиків): її легко перевірити. Екран — ui_calib.js.
import { S, bus, log } from './core.js';

export const CAL = {
  STILL_S: 2.5,          // крок 1: стільки секунд нерухомо
  STILL_RATE: 5,         // °/с — «нерухомо» (рука трохи тремтить)
  HOLD_S: 0.9,           // кроки 2–3: стільки тримати повернутим, щоб зафіксувати
  HOLD_RATE: 9,          // °/с — «затримали»
  TURN_MIN: 62, TURN_MAX: 124,   // що вважаємо «приблизно 90°» для одного повороту (точність дає розмах, а не цей коридор)
  K_MIN: 0.86, K_MAX: 1.16,      // розумні межі поправки: гіроскоп телефона не бреше на десятки відсотків — якщо вийшло більше, повернули не на 90°
  ASYM: 0.22,            // ліворуч і праворуч мають бути схожі (різниця до 22 % від середнього) — інакше «прямо» загубилось, повторити
  BIAS_BAD: 1.0,         // °/с — дрейф, з яким гіроскопу довіряти не варто
  FRESH_DAYS: 90         // калібрування «свіже» стільки днів; далі значок знову блідий — варто повторити
};

/** Збережене калібрування: { k, left, right, bias, tilt, at, v } або null. */
export function calGet() { const c = S.gyroCal; return c && c.v === 1 && c.k > 0.5 && c.k < 2 ? c : null; }
/** Чи є свіже калібрування (значок зелений). */
export function calFresh(now = Date.now()) { const c = calGet(); return !!c && now - (c.at || 0) < CAL.FRESH_DAYS * 864e5; }
/** Поправка кута повороту для навігації (1 — без калібрування). */
export const gyroK = () => { const c = calGet(); return c ? c.k : 1; };
export function calClear() { S.gyroCal = null; bus.emit('calib', null); }

/** Положення телефона за вектором «угору» (в осях телефона): кут між довгою віссю телефона й вертикаллю. */
export function poseOf(up) {
  const m = Math.hypot(up[0], up[1], up[2]) || 1, uy = up[1] / m, uz = up[2] / m;
  const lean = Math.round(Math.acos(Math.max(-1, Math.min(1, Math.abs(uy)))) * 180 / Math.PI);     // 0 — стоїть рівно вертикально (чи догори дриґом), 90 — лежить
  return { lean, kind: Math.abs(uz) > 0.82 ? 'flat' : lean <= 12 ? 'upright' : 'tilted' };
}

/** Нове калібрування. feed(s) приймає заміри { t (с), yaw (°, за годинниковою — плюс), rateUp (°/с навколо вертикалі), rate (°/с повна), up:[x,y,z] }. */
export function newCal() {
  const st = {
    step: 1,                    // 1 — нерухомо, 2 — ліворуч, 3 — праворуч, 4 — готово (є результат), 0 — зупинено
    prog: 0,                    // 0..1 — скільки вже «натримали» на цьому кроці
    angle: 0,                   // поточний поворот від прямого положення, ° (ліворуч — мінус)
    hint: '',                   // підказка, якщо роблять не те: 'wrongSide' | 'tooFar' | 'more' | 'hold' | ''
    bias: 0, pose: null, left: null, right: null, result: null,
    n: 0, hz: 0
  };
  let t0 = null, tStill = null, sumR = 0, nR = 0, up = [0, 0, 0], yaw0 = 0, tZero = 0, tHold = null, tFirst = null;
  const zero = s => { yaw0 = s.yaw; tZero = s.t; };
  const ang = s => (s.yaw - yaw0) - st.bias * (s.t - tZero);
  function feed(s) {
    if (st.step < 1 || st.step > 3 || !s || !isFinite(s.yaw) || !isFinite(s.t)) return st;
    if (tFirst == null) tFirst = s.t;
    st.n++; if (s.t > tFirst) st.hz = Math.round(st.n / (s.t - tFirst));
    if (st.step === 1) {
      const quiet = Math.abs(s.rate != null ? s.rate : s.rateUp) < CAL.STILL_RATE;
      if (!quiet || tStill == null) { tStill = s.t; sumR = 0; nR = 0; up = [0, 0, 0]; t0 = s; if (!quiet) { st.prog = 0; st.hint = 'hold'; return st; } }
      st.hint = '';
      sumR += s.rateUp || 0; nR++; if (s.up) { up[0] += s.up[0]; up[1] += s.up[1]; up[2] += s.up[2]; }
      st.prog = Math.min(1, (s.t - tStill) / CAL.STILL_S);
      if (st.prog >= 1 && nR >= 3) {
        // дрейф: за нахилом накопиченого кута на проміжку спокою (точніше за середнє миттєвих значень)
        st.bias = t0 && s.t - t0.t > 0.5 ? (s.yaw - t0.yaw) / (s.t - t0.t) : sumR / nR;
        st.pose = poseOf(up); zero(s); st.step = 2; st.prog = 0; tHold = null; st.angle = 0;
      }
      return st;
    }
    const a = ang(s); st.angle = a;
    const want = st.step === 2 ? -1 : 1, d = a * want;                      // d — поворот у потрібний бік
    const steady = Math.abs(s.rateUp || 0) < CAL.HOLD_RATE;
    st.hint = d < -35 && steady ? 'wrongSide' : d > CAL.TURN_MAX ? 'tooFar' : d >= CAL.TURN_MIN ? (steady ? '' : 'hold') : d > 25 ? 'more' : '';
    if (d >= CAL.TURN_MIN && d <= CAL.TURN_MAX && steady) {
      if (tHold == null) tHold = s.t;
      st.prog = Math.min(1, (s.t - tHold) / CAL.HOLD_S);
      if (st.prog >= 1) {
        if (st.step === 2) { st.left = Math.abs(a); st.step = 3; st.prog = 0; tHold = null; }
        else { st.right = Math.abs(a); st.step = 4; st.prog = 1; st.result = judge(st); }
      }
    } else { tHold = null; st.prog = 0; }
    return st;
  }
  return { st, feed, stop() { st.step = 0; } };
}

/** Оцінка замірів: { ok, k, pct, left, right, bias, pose, why }. why: '' | 'asym' | 'range' | 'bias'. */
export function judge({ left, right, bias, pose, hz }) {
  const mean = (left + right) / 2, k = 180 / (left + right), asym = Math.abs(left - right) / mean;
  const r = { ok: true, k: +k.toFixed(4), pct: +((k - 1) * 100).toFixed(1), left: +left.toFixed(1), right: +right.toFixed(1), seen90: +mean.toFixed(1), bias: +(+bias || 0).toFixed(3), pose: pose || null, hz: hz || 0, why: '' };
  if (Math.abs(r.bias) > CAL.BIAS_BAD) { r.ok = false; r.why = 'bias'; }
  else if (asym > CAL.ASYM) { r.ok = false; r.why = 'asym'; }
  else if (k < CAL.K_MIN || k > CAL.K_MAX) { r.ok = false; r.why = 'range'; }
  return r;
}

/** Зберегти результат (водій натиснув «Готово»). */
export function calSave(r, now = Date.now()) {
  if (!r || !r.ok) return false;
  S.gyroCal = { v: 1, k: r.k, left: r.left, right: r.right, bias: r.bias, lean: r.pose ? r.pose.lean : null, pose: r.pose ? r.pose.kind : '', hz: r.hz, at: now };
  log('info', `калібрування телефона: 90° телефон бачить як ${r.seen90}° (ліворуч ${r.left}°, праворуч ${r.right}°) → поправка ×${r.k}; дрейф ${r.bias} °/с; ${r.pose ? r.pose.kind + ' ' + r.pose.lean + '°' : ''}`);
  bus.emit('calib', S.gyroCal);
  return true;
}
