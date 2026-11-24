// Калібрування телефона (1.1.22) — щоб без GPS телефон точніше відчував повороти фури.
//
// Навіщо. Без GPS позначку на рейсі ведемо за гіроскопом: телефон відчув поворот на стільки-то градусів — отже, машина
// пройшла цей поворот рейсу (nav.js: detectTurn, звірка поворотів; хмара точок). У кожного телефона гіроскоп трохи свій:
// поворот на 90° один показує як 87°, інший — як 93°; дехто дає повільний дрейф, а в когось датчик узагалі мовчить.
// Калібрування перевіряє це на КОНКРЕТНОМУ телефоні й бере його «90°» за основу.
//
// Як. Телефон тримають так, як він стоїть у тримачі: вертикально або з нахилом, сторч чи набік — байдуже. Три кроки:
//   1) тримати нерухомо ~2,5 с — міряємо дрейф гіроскопа (усі три осі) і де для телефона «вгору» (як він стоїть);
//   2) повернути, як двері на завісах, на 90° в один бік — доки не побачите телефон ребром — і затримати на секунду;
//   3) повернути через пряме положення на 90° в інший бік — знову «ребром» — і затримати.
//
// Що саме міряємо. Не «кутову швидкість навколо вертикалі» (так рахує ведення), а КУДИ ДИВИТЬСЯ ЕКРАН: з показів гіроскопа
// складаємо повний поворот телефона у просторі й дивимось, на скільки градусів повернувся (у плані, згори) перпендикуляр
// до екрана. Саме це око й називає «ребром»: екран повернуто рівно на 90° від погляду. Тому байдуже, чи телефон повертали
// навколо вертикалі (як у тримачі), чи навколо його власної довгої осі (як зручно руці з нахиленим телефоном) — раніше
// другий спосіб давав би «90° = 85°» лише через нахил, і поправка вийшла б хибна.
//
// Між «ребром в один бік» і «ребром в інший» рівно 180°, хоч би як неточно стояло «прямо» на початку й хоч би де було око,
// — тому поправку беремо з усього розмаху: k = 180 / (ліворуч + праворуч).
//
// Чесно про точність. «Ребром» на око — це ±2…3°, тобто розмах відомий із точністю ~2–3 %. Гіроскоп справного телефона
// зазвичай точніший. Тому: якщо телефон бачить 90° у межах ±4 % (86,4…93,6°) — гіроскоп «у нормі», поправка не потрібна
// (k = 1): не псуємо точний датчик неточною рукою. Якщо відхилення більше (до ±16 %) — це вже особливість телефона,
// її й виправляємо. Ще більше — повернули не на 90°, просимо повторити.
//
// Звідки точність, коли екран «заїкається». Заміри для екрана йдуть ~60 разів на секунду, але якщо телефон зайнятий (малює
// карту), частина пропадає, і кут виходить заниженим. Служба навігації (NavService) рахує той самий поворот сама, поза
// екраном, і нічого не губить — але лише «навколо вертикалі» і звітує раз на секунду. Тому беремо найкраще з обох:
// величину розмаху — від служби, а поправку на те, ЯК саме повертали телефон (навколо вертикалі чи власної осі), — з
// замірів екрана: розмах = (кут служби) × (кут екрана «куди дивиться екран» / кут екрана «навколо вертикалі»).
// Заїкання псує обидва кути екрана однаково, тож їхнє відношення лишається вірним. До того ж саме кут служби потім і
// множиться на поправку у веденні — калібруємо рівно те, чим користуємось. Служби немає (браузер) — рахуємо лише з екрана
// й стежимо, щоб заїкань було небагато.
//
// Що з цим робить навігація: кут повороту від служби множиться на k (nav.js: calYaw). Дрейф лише показуємо й перевіряємо
// (Android сам його постійно компенсує; постійна поправка «назавжди» могла б зашкодити).
//
// Тут — лише логіка (без екрана й без датчиків): її легко перевірити. Екран — ui_calib.js.
import { S, bus, log } from './core.js';

export const CAL = {
  STILL_S: 2.5,          // крок 1: стільки секунд нерухомо
  STILL_RATE: 5,         // °/с — «нерухомо» (рука трохи тремтить)
  HOLD_S: 1.0,           // кроки 2–3: стільки тримати повернутим, щоб зафіксувати
  HOLD_NAT_S: 1.5,       // …а коли є кут від служби навігації (раз на секунду) — півтори секунди, щоб у затримку напевно влучив її замір
  NAT_LAG: 0.35,         // с — замір служби беремо не раніше, ніж за стільки від початку затримки (телефон уже напевно стоїть)
  NAT_ALIVE_S: 2.5,      // с — служба «жива», якщо її замір був не давніше
  NAT_MIN: 0.85, NAT_MAX: 1.6,   // служба нарахувала проти екрана в стільки разів: менше/більше — щось не те, службі не віримо
  GAP_BAD: 0.12,         // с — пауза між замірами екрана, довша за яку вважаємо «заїканням»
  LOSS_MAX: 20,          // ° — стільки повороту можна «проковтнути» в заїканнях, якщо звіритись нема з чим (служби немає)
  HOLD_RATE: 7,          // °/с — «затримали»
  TURN_MIN: 70, TURN_MAX: 124,   // що вважаємо «приблизно 90°» для одного повороту (точність дає розмах, а не цей коридор)
  K_DEAD: 0.04,          // у межах ±4 % гіроскоп «у нормі»: поправка 1 (рука неточніша за датчик)
  K_MIN: 0.86, K_MAX: 1.16,      // розумні межі поправки: далі — повернули не на 90°
  ASYM: 0.22,            // ліворуч і праворуч мають бути схожі (різниця до 22 % від середнього) — інакше десь не довели до «ребром»
  BIAS_BAD: 1.0,         // °/с — дрейф, з яким гіроскопу довіряти не варто
  RIGID_RMS: 0.25,       // °/с — розкид кутової швидкості, нижче якого телефон «закріплено» (тримач, стіл), а не в руці
  LEAN_MAX: 55,          // ° — екран нахилено від вертикалі більше — це вже «лежить»: напрямок екрана в плані не визначити
  GAP_S: 1.0,            // довша пауза в замірах (програму згорнули?) — кут загублено, починаємо знову; коротші (екран «заїкнувся») — перекриваємо
  GAP_SLOW_S: 2.6,       // те саме, коли заміри йдуть раз на секунду (екран датчиків не віддає — рахуємо лише за службою навігації)
  FRESH_DAYS: 90         // калібрування «свіже» стільки днів; далі значок знову блідий — варто повторити
};
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** Збережене калібрування: { v, k, seen, left, right, bias, lean, pose, hz, at } або null. */
export function calGet() { const c = S.gyroCal; return c && c.v === 1 && c.k > 0.5 && c.k < 2 ? c : null; }
/** Чи є свіже калібрування (значок зелений). */
export function calFresh(now = Date.now()) { const c = calGet(); return !!c && now - (c.at || 0) < CAL.FRESH_DAYS * 864e5; }
/** Поправка кута повороту для навігації (1 — без калібрування або гіроскоп у нормі). */
export const gyroK = () => { const c = calGet(); return c ? c.k : 1; };
export function calClear() { S.gyroCal = null; bus.emit('calib', null); }
// Поки відкрито екран калібрування, телефон крутять у руках — ведення ці «повороти» за повороти фури не має приймати (nav.js)
let busy = false;
export function calBusy(v) { if (v !== undefined) busy = !!v; return busy; }

/* ---------- трохи геометрії: повороти як кватерніони [w, x, y, z] ---------- */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };
const qmul = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const qrot = (q, v) => { const u = [q[1], q[2], q[3]], t = cross(u, v).map(x => 2 * x), c = cross(u, t); return [v[0] + q[0] * t[0] + c[0], v[1] + q[0] * t[1] + c[1], v[2] + q[0] * t[2] + c[2]]; };
/** Поворот телефона за крок: кутова швидкість w (°/с, в осях телефона) за dt секунд. */
function qstep(q, w, dt) {
  const th = Math.hypot(w[0], w[1], w[2]) * D2R * dt; if (th < 1e-9) return q;
  const a = unit(w), s = Math.sin(th / 2), r = qmul(q, [Math.cos(th / 2), a[0] * s, a[1] * s, a[2] * s]), m = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
  return [r[0] / m, r[1] / m, r[2] / m, r[3] / m];
}

/** Положення телефона за вектором «угору» (в осях телефона): lean — на скільки екран нахилено від вертикалі (0 — стоїть рівно, 90 — лежить). */
export function poseOf(up) {
  const u = unit(up), lean = Math.round(Math.asin(Math.min(1, Math.abs(u[2]))) * R2D);
  return { lean, kind: lean > CAL.LEAN_MAX ? 'flat' : lean <= 12 ? 'upright' : 'tilted', side: Math.abs(u[0]) > Math.abs(u[1]) };   // side — телефон набік (альбомно)
}

/**
 * Нове калібрування. feed(s) приймає сирі заміри датчиків: { t (с), w: [x, y, z] — кутова швидкість в осях телефона, °/с;
 * g: [x, y, z] — прискорення з тяжінням, м/с² (у спокої — «угору») }. Позначка slow: заміри рідкі (раз на секунду) — так буває,
 * коли екран датчиків не віддає й кути беремо лише в служби навігації (ui_calib.js).
 */
export function newCal() {
  const st = {
    step: 1,                    // 1 — нерухомо, 2 — перший поворот, 3 — другий (в інший бік), 4 — готово (є результат), 0 — зупинено
    prog: 0,                    // 0..1 — скільки вже «натримали» на цьому кроці
    angle: 0,                   // куди повернуто екран від прямого положення, ° (ліворуч — мінус, праворуч — плюс)
    want: -1,                   // куди повертати зараз: −1 ліворуч, +1 праворуч (на кроці 2 зарахуємо будь-який бік)
    first: 0,                   // який бік зафіксовано першим (−1 / +1)
    hint: '',                   // підказка: 'hold' | 'upright' | 'more' | 'tooFar' | ''
    bias: 0, pose: null, left: null, right: null, result: null,
    n: 0, hz: 0
  };
  let lastT = null, tFirst = null, tStill = null, sw = [0, 0, 0], sw2 = 0, sg = [0, 0, 0], nS = 0, gl = null, drift = 0;
  let b = [0, 0, 0], u0 = [0, 1, 0], p0 = [0, 0, 1], q = [1, 0, 0, 0], pw = null, tHold = null, sumA = 0, nA = 0, tSlow = null;
  let yawW = 0, loss = 0, nat = [], natBias = 0, capN = { '-1': null, '1': null };          // кут «навколо вертикалі» з замірів екрана; проковтнуте в заїканнях; заміри служби
  const natAlive = t => nat.length > 0 && t - nat[nat.length - 1].t < CAL.NAT_ALIVE_S;
  const natSince = t0 => { for (let i = nat.length - 1; i >= 0; i--) if (nat[i].t >= t0) return nat[i]; else break; return null; };
  /** Кут від служби навігації (раз на секунду): запам'ятовуємо разом із тим, що цієї ж миті показують заміри екрана. */
  function native(yaw) { if (lastT == null || !isFinite(yaw)) return; nat.push({ t: lastT, yaw: +yaw, Y: yawW, H: st.angle }); if (nat.length > 40) nat.shift(); }
  const still0 = t => { tStill = t; sw = [0, 0, 0]; sw2 = 0; sg = [0, 0, 0]; nS = 0; st.prog = 0; };
  function heading() {                       // на скільки градусів (у плані) повернувся перпендикуляр до екрана; за годинниковою — плюс
    const n = qrot(q, [0, 0, 1]), d = dot(n, u0), p = [n[0] - d * u0[0], n[1] - d * u0[1], n[2] - d * u0[2]];
    if (Math.hypot(p[0], p[1], p[2]) < 0.35) return null;            // екран дивиться майже вгору чи вниз — телефон поклали
    let a = -Math.atan2(dot(cross(p0, p), u0), dot(p0, p)) * R2D;
    while (a - st.angle > 180) a -= 360; while (a - st.angle < -180) a += 360;       // без стрибка на ±180°
    return a;
  }
  function feed(s) {
    if (st.step < 1 || st.step > 3 || !s || !isFinite(s.t) || !s.w || !s.g) return st;
    const w = s.w, g = s.g; if (![...w, ...g].every(isFinite)) return st;
    if (tFirst == null) tFirst = s.t;
    st.n++; if (s.t - tFirst > 0.5) st.hz = Math.round(st.n / (s.t - tFirst));
    const dt = lastT == null ? 0 : s.t - lastT, GAP = s.slow ? CAL.GAP_SLOW_S : CAL.GAP_S; lastT = s.t; st.slow = !!s.slow;
    { const al = Math.min(1, dt / 0.24);                    // згладжене «вгору» — з тією самою сталою часу (~0,25 с), що й у служби навігації
      gl = gl ? [gl[0] + al * (g[0] - gl[0]), gl[1] + al * (g[1] - gl[1]), gl[2] + al * (g[2] - gl[2])] : g.slice(); }
    if (st.step === 1) {
      st.angle = 0;
      if (poseOf(gl).kind === 'flat') { still0(s.t); st.hint = 'upright'; return st; }      // лежить — спершу поставити вертикально
      const quiet = Math.hypot(w[0], w[1], w[2]) < CAL.STILL_RATE;
      if (!quiet || tStill == null || dt > GAP) { still0(s.t); if (!quiet) { st.hint = 'hold'; return st; } }
      st.hint = '';
      sw[0] += w[0]; sw[1] += w[1]; sw[2] += w[2]; sw2 += w[0] * w[0] + w[1] * w[1] + w[2] * w[2]; sg[0] += g[0]; sg[1] += g[1]; sg[2] += g[2]; nS++;
      st.prog = Math.min(1, (s.t - tStill) / CAL.STILL_S);
      if (st.prog >= 1 && nS >= (s.slow ? 3 : 5)) {
        const m = [sw[0] / nS, sw[1] / nS, sw[2] / nS], bm = Math.hypot(m[0], m[1], m[2]), rms = Math.sqrt(Math.max(0, sw2 / nS - bm * bm));
        u0 = unit(sg);
        if (bm > CAL.BIAS_BAD && ++drift < 4) { still0(s.t); st.hint = 'hold'; return st; }      // «тихо», але весь час повільно повертається — ще не нерухомо
        // Середня кутова швидкість у спокої — це дрейф гіроскопа лише тоді, коли телефон справді нерухомий (у тримачі, на столі:
        // шум датчика — соті частки °/с). У руці це здебільшого сама рука; віднявши її як «дрейф», ми б зіпсували замір розмаху.
        st.rigid = !s.slow && rms < CAL.RIGID_RMS; b = st.rigid ? m : [0, 0, 0];
        { const a = nat.filter(x => x.t >= tStill), n0 = a[0], n1 = a[a.length - 1];           // …і те саме для кута служби: її дрейф за час спокою
          natBias = st.rigid && n0 && n1.t - n0.t >= 0.9 ? (n1.yaw - n0.yaw) / (n1.t - n0.t) : 0; }
        st.bias = -dot(m, u0); st.biasAll = bm; st.pose = s.slow ? null : poseOf(u0);          // за рідкими замірами служби положення телефона невідоме
        if (bm > CAL.BIAS_BAD) { st.step = 4; st.prog = 1; st.result = judge({ left: 90, right: 90, bias: bm, pose: st.pose, hz: st.hz }); return st; }   // гіроскоп «пливе» й у повному спокої
        const d = u0[2]; p0 = unit([-d * u0[0], -d * u0[1], 1 - d * u0[2]]);          // перпендикуляр до екрана — його слід у плані
        q = [1, 0, 0, 0]; pw = null; yawW = 0; loss = 0; capN = { '-1': null, '1': null }; st.step = 2; st.prog = 0; st.angle = 0; st.want = -1; tHold = null; tSlow = null;
      }
      return st;
    }
    if (dt > GAP) {                                          // заміри урвались посеред повороту (програму згорнули?) — кут загублено
      st.step = 1; st.left = st.right = null; st.first = 0; st.want = -1; st.angle = 0; drift = 0; still0(s.t); st.hint = 'hold'; return st;
    }
    const wb = [w[0] - b[0], w[1] - b[1], w[2] - b[2]];
    // поворот за крок — за середньою швидкістю між двома замірами (трапеція): пропущений замір чи два кута не псують.
    // Рідкі заміри (slow) — це вже середня швидкість за секунду, тож їх беремо як є.
    const mid = pw && !s.slow ? [(pw[0] + wb[0]) / 2, (pw[1] + wb[1]) / 2, (pw[2] + wb[2]) / 2] : wb; pw = wb;
    q = qstep(q, mid, dt);
    yawW -= dot(mid, unit(gl)) * dt;                          // те саме, що рахує служба: поворот навколо вертикалі (за годинниковою — плюс)
    if (dt > CAL.GAP_BAD && !s.slow) loss += Math.hypot(mid[0], mid[1], mid[2]) * dt;
    const a = heading();
    if (a == null) { st.hint = 'upright'; tHold = null; st.prog = 0; return st; }
    st.angle = a;
    const steady = Math.hypot(wb[0], wb[1], wb[2]) < CAL.HOLD_RATE;
    const side = st.step === 2 ? (Math.abs(a) >= 35 ? Math.sign(a) : st.want) : st.want, d = a * side;       // d — поворот у потрібний бік
    if (st.step === 2) st.want = side;
    if (d >= CAL.TURN_MIN && d <= CAL.TURN_MAX && steady) {
      if (tHold == null) { tHold = s.t; sumA = 0; nA = 0; }
      sumA += Math.abs(a); nA++; st.hint = '';
      st.prog = Math.min(1, (s.t - tHold) / (natAlive(s.t) ? CAL.HOLD_NAT_S : CAL.HOLD_S));
      if (st.prog >= 1) {
        const got = sumA / nA;
        if (side < 0) st.left = got; else st.right = got;
        capN[side] = natSince(tHold + CAL.NAT_LAG);
        if (st.step === 2) { st.first = side; st.want = -side; st.step = 3; st.prog = 0; tHold = null; tSlow = null; }
        else {
          const L = capN[-1], R = capN[1];
          st.step = 4; st.prog = 1;
          st.result = judge({ left: st.left, right: st.right, bias: st.biasAll, yawBias: st.bias, rigid: st.rigid, pose: st.pose, hz: st.hz, loss,
            nat: L && R ? { N: R.yaw - L.yaw - natBias * (R.t - L.t), Y: R.Y - L.Y, H: R.H - L.H } : null });
        }
      }
      return st;
    }
    tHold = null; st.prog = 0;
    // підказки, коли зупинились не там: замало (ще не «ребром») чи забагато
    if (d > CAL.TURN_MAX) st.hint = 'tooFar';
    else if (d >= CAL.TURN_MIN) st.hint = 'hold';
    else if (d > 30 && steady) { if (tSlow == null) tSlow = s.t; st.hint = s.t - tSlow > 0.8 ? 'more' : ''; }
    else { tSlow = null; st.hint = ''; }
    return st;
  }
  return { st, feed, native, stop() { st.step = 0; } };
}

/** Оцінка замірів: { ok, k, kRaw, fine, pct, left, right, seen90, src, bias, pose, hz, why }. why: '' | 'asym' | 'range' | 'bias' | 'jank'.
 *  left/right — що показали заміри екрана; nat — що між тими самими двома затримками нарахувала служба (N) і заміри екрана
 *  цієї ж миті (Y — навколо вертикалі, H — «куди дивиться екран»); loss — скільки градусів пройшло в «заїканнях» екрана. */
export function judge({ left, right, bias, yawBias, rigid, pose, hz, nat, loss }) {
  const web = left + right, asym = Math.abs(left - right) / (web / 2);
  let sweep = web, src = 'web';
  if (nat && nat.Y > 60 && nat.H > 60 && nat.N / nat.Y > CAL.NAT_MIN && nat.N / nat.Y < CAL.NAT_MAX) { sweep = nat.N * nat.H / nat.Y; src = 'native'; }
  const f = sweep / web, kRaw = 180 / sweep, fine = Math.abs(kRaw - 1) <= CAL.K_DEAD, k = fine ? 1 : kRaw;
  const r = { ok: true, k: +k.toFixed(4), kRaw: +kRaw.toFixed(4), fine, pct: +((k - 1) * 100).toFixed(1), left: +(left * f).toFixed(1), right: +(right * f).toFixed(1), seen90: +(sweep / 2).toFixed(1), src,
    web: +(web / 2).toFixed(1), loss: +(+loss || 0).toFixed(1), native: nat ? +(+nat.N).toFixed(1) : null,
    bias: +(+(yawBias != null ? yawBias : bias) || 0).toFixed(3), rigid: !!rigid, pose: pose || null, hz: hz || 0, why: '' };
  if (Math.abs(+bias || 0) > CAL.BIAS_BAD) { r.ok = false; r.why = 'bias'; r.bias = +(+bias).toFixed(2); }
  else if (asym > CAL.ASYM) { r.ok = false; r.why = 'asym'; }
  else if (src === 'web' && r.loss > CAL.LOSS_MAX) { r.ok = false; r.why = 'jank'; }
  else if (kRaw < CAL.K_MIN || kRaw > CAL.K_MAX) { r.ok = false; r.why = 'range'; }
  return r;
}

/** Зберегти результат (водій натиснув «Готово»). */
export function calSave(r, now = Date.now()) {
  if (!r || !r.ok) return false;
  S.gyroCal = { v: 1, k: r.k, seen: r.seen90, left: r.left, right: r.right, src: r.src, bias: r.bias, lean: r.pose ? r.pose.lean : null, pose: r.pose ? r.pose.kind : '', hz: r.hz, at: now };
  log('info', `калібрування телефона: 90° телефон бачить як ${r.seen90}° (ліворуч ${r.left}°, праворуч ${r.right}°) → ${r.fine ? 'у нормі, поправка не потрібна' : 'поправка ×' + r.k}; `
    + (r.src === 'native' ? `розмах — за службою навігації (${r.native}°), заміри екрана дали ${r.web}° на бік` : `лише заміри екрана${r.native != null ? ' (служба дала ' + r.native + '° — не зійшлось)' : ''}`)
    + `; у заїканнях екрана ${r.loss}°; ${r.pose ? r.pose.kind + ' ' + r.pose.lean + '°' + (r.pose.side ? ', набік' : '') : ''}; ${r.hz} замірів/с`);
  bus.emit('calib', S.gyroCal);
  return true;
}
