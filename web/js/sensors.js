// Датчики руху телефона у WebView (≈60 разів на секунду): чутливий детектор положення телефона.
// Служба навігації дає поворот навколо вертикалі раз на секунду — цього досить, щоб вести позначку. А тут — подробиці:
//   • чи телефон цієї секунди крутили в руках (нахил відносно землі змінився) — тоді його «поворот» не про фуру;
//   • положення телефона для Лабораторії (3D-модель, градуси повороту ліворуч/праворуч).
// Працює без дозволів (Android WebView, захищена адреса). Якщо подій немає — усе решта працює як раніше.
const D2R = Math.PI / 180;
export const ms = {
  ok: false, n: 0, hz: 0, t: 0,
  up: [0, 0, 1],                 // напрямок «угору» в осях телефона (згладжене прискорення)
  rate: 0, rateUp: 0,            // кутова швидкість: повна і навколо вертикалі, °/с (за годинниковою — плюс)
  yaw: 0,                        // накопичений поворот навколо вертикалі, ° (за годинниковою)
  tilt: 0, peak: 0,              // за останню секунду: на скільки градусів змінився нахил; пік кутової швидкості
  handled: false,                // телефон у руках
  acc: 0,                        // модуль прискорення без земного тяжіння, м/с²
  alpha: null, beta: null, gamma: null, abs: false,   // положення телефона (deviceorientation)
};
let lastT = 0, hx = 0, hy = 0, hz = 0, peak = 0, cnt = 0, secT = 0, started = false, lastHandled = 0;
// Сирі заміри для калібрування телефона (calib.js): кожна подія датчиків як є — кутова швидкість у осях телефона й прискорення з тяжінням.
let rawFn = null;
/** Слухати сирі заміри: fn({ t (с), w: [x, y, z] °/с, g: [x, y, z] м/с² }). Повертає функцію «перестати слухати». Слухач один (екран калібрування). */
export function onRaw(fn) { rawFn = fn; startMotion(); return () => { if (rawFn === fn) rawFn = null; }; }
function onMotion(e) {
  const r = e.rotationRate, g = e.accelerationIncludingGravity; if (!g || g.x == null) return;
  const now = (e.timeStamp || performance.now()) / 1000, dt = lastT ? Math.min(0.2, Math.max(0, now - lastT)) : 0; lastT = now;
  ms.ok = true; ms.n++; cnt++; ms.t = Date.now();
  // «угору»: акселерометр у спокої показує +g по осі, що дивиться вгору
  const k = 0.06; ms.up = [ms.up[0] + k * (g.x - ms.up[0]), ms.up[1] + k * (g.y - ms.up[1]), ms.up[2] + k * (g.z - ms.up[2])];
  const a = e.acceleration; if (a && a.x != null) ms.acc = Math.hypot(a.x, a.y, a.z);
  if (!r || r.alpha == null) return;
  const m = Math.hypot(ms.up[0], ms.up[1], ms.up[2]) || 1, ux = ms.up[0] / m, uy = ms.up[1] / m, uz = ms.up[2] / m;
  const wx = r.beta, wy = r.gamma, wz = r.alpha;                      // °/с навколо осей x, y, z телефона
  if (rawFn) { try { rawFn({ t: now, w: [wx, wy, wz], g: [g.x, g.y, g.z] }); } catch (_) {} }
  const wUp = wx * ux + wy * uy + wz * uz;                             // навколо вертикалі (проти годинникової — плюс)
  ms.rate = Math.hypot(wx, wy, wz); ms.rateUp = -wUp; ms.yaw -= wUp * dt;
  hx += (wx - wUp * ux) * dt; hy += (wy - wUp * uy) * dt; hz += (wz - wUp * uz) * dt;   // обертання НЕ навколо вертикалі — це нахил телефона
  if (ms.rate > peak) peak = ms.rate;
  if (now - secT >= 1) flush(now);
}
function flush(now) {
  ms.tilt = Math.hypot(hx, hy, hz); ms.peak = peak; ms.hz = cnt; hx = hy = hz = 0; peak = 0; cnt = 0; secT = now;
  // Фура нахиляє кабіну на кілька градусів і повертає не швидше ~30 °/с; рука — десятки градусів нахилу за секунду або різкий ривок
  if (ms.tilt >= 12 || ms.peak >= 220) lastHandled = Date.now();
  ms.handled = Date.now() - lastHandled < 1500;
}
function onOri(e) { if (e.alpha == null && e.beta == null) return; ms.alpha = e.alpha; ms.beta = e.beta; ms.gamma = e.gamma; ms.abs = !!e.absolute; }
// Підказка для ведення: чи можна вірити повороту за останню секунду. null — датчиків WebView немає (тоді працюють старі правила).
export function motionHint() {
  if (typeof globalThis.__motionHint === 'function') return globalThis.__motionHint();      // стенд: підміна датчиків
  if (!ms.ok || Date.now() - ms.t > 2500) return null;
  return { handled: Date.now() - lastHandled < 1200, tilt: ms.tilt, peak: ms.peak };
}
export function startMotion() {
  if (started || typeof window === 'undefined' || !window.addEventListener || typeof DeviceMotionEvent === 'undefined') return;
  started = true;
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('deviceorientation', onOri);
}
export const _test = { onMotion, onOri, flush };
