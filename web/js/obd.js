// (1.1.33) Модуль OBD: показання машини з її власної мережі — лише прийом.
// Вантажівки Євро 5 / Євро 6 усіх європейських марок передають у свою мережу стандартні повідомлення SAE J1939 (на них же
// побудований інтерфейс FMS для тахографів і GPS-трекерів). Модуль у роз'ємі слухає ці повідомлення й передає їх у телефон;
// тут ми їх розшифровуємо. У машину не надсилається нічого.
// Звідки кадри: оболонка (Android) викликає window.__reis('obd', { id, d }) — id — 29-бітний ідентифікатор CAN (числом або
// шістнадцятковим рядком), d — 8 байтів (рядок «0A1B…» чи масив); або пачкою: { f: [[id, d], …] }. Стан зв'язку —
// window.__reis('obdLink', { state: 'search' | 'ok' | 'lost' | 'err', dev: 'назва модуля', msg }).
import { bus, log, S } from './core.js';
import { t } from './i18n.js';

const N = window.ReisNative || null;
// чи вміє оболонка підключати модуль (Bluetooth): з'явиться в наступній версії застосунку разом із самим модулем
export const supported = () => !!(N && typeof N.obdStart === 'function');

// (1.1.35, Олексій) Логіка: модуль «апріорі вимкнений», доки пристрій зчитування не підключено, — перемикач неактивний. Пристрій
// підключився (про це каже оболонка) — модуль умикається сам, і тоді перемикачем його можна вимкнути чи ввімкнути знову.
// conn — пристрій зчитування підключено (оболонка бачить модуль); link: 'none' — пристрою немає; 'conn' — підключено, показань ще
// немає; 'ok' — показання йдуть; 'lost' — пристрій є, але показань немає понад 5 с
export const st = { conn: false, link: 'none', dev: '', msg: '', last: 0, frames: 0, vals: {}, demo: false };
const STALE = 5000;

/* ---------- розшифровка J1939 ---------- */
// PGN з 29-бітного ідентифікатора: пріоритет(3) · EDP · DP · PF(8) · PS(8) · SA(8); PF < 240 — PS це адреса, а не частина PGN
export function pgnOf(id) { let p = (id >>> 8) & 0x3FFFF; if (((p >> 8) & 0xFF) < 240) p &= 0x3FF00; return p; }
// значення «немає» за J1939: 1 байт ≥ 0xFB, 2 байти ≥ 0xFB00, 4 байти ≥ 0xFB000000; 2-бітне поле: 2 — помилка, 3 — немає
const u8 = (b, i) => b[i] >= 0xFB ? null : b[i];
const u16 = (b, i) => { const v = b[i] | (b[i + 1] << 8); return v >= 0xFB00 ? null : v; };
const u32 = (b, i) => { const v = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 16777216; return v >= 0xFB000000 ? null : v; };
const bits2 = (b, i, sh) => { const v = (b[i] >> sh) & 3; return v >= 2 ? null : v; };
const lin = (v, k, o = 0) => v == null ? null : v * k + o;
const DEG = 180 / Math.PI;

// Показання за групами. pgn — повідомлення J1939 (назва — для довідки), f — як дістати значення з 8 байтів.
// Підібрано «по темі» навігатора: рух, стійкість, керування, паливо, стан машини. Даних про водія (картка тахографа) не беремо.
export const PARAMS = [
  // рух
  { k: 'speedW', g: 'move', pgn: 0xFEF1, n: 'CCVS1', u: 'kmh', f: b => lin(u16(b, 1), 1 / 256) },
  { k: 'speedT', g: 'move', pgn: 0xFE6C, n: 'TCO1', u: 'kmh', f: b => lin(u16(b, 6), 1 / 256) },
  { k: 'rpm', g: 'move', pgn: 0xF004, n: 'EEC1', u: 'rpm', f: b => lin(u16(b, 3), 0.125) },
  { k: 'gear', g: 'move', pgn: 0xF005, n: 'ETC2', u: 'gear', f: b => lin(u8(b, 3), 1, -125) },
  { k: 'dist', g: 'move', pgn: 0xFEC1, n: 'VDHR', u: 'km', f: b => lin(u32(b, 0), 0.005) },
  // стійкість
  { k: 'steer', g: 'stab', pgn: 0xF009, n: 'VDC2', u: 'deg', f: b => lin(lin(u16(b, 0), 1 / 1024, -31.374), DEG) },
  { k: 'yaw', g: 'stab', pgn: 0xF009, n: 'VDC2', u: 'degs', f: b => lin(lin(u16(b, 3), 1 / 8192, -3.92), DEG) },
  { k: 'latAcc', g: 'stab', pgn: 0xF009, n: 'VDC2', u: 'ms2', f: b => lin(u16(b, 5), 1 / 2048, -15.687) },
  { k: 'lonAcc', g: 'stab', pgn: 0xF009, n: 'VDC2', u: 'ms2', f: b => lin(u8(b, 7), 0.1, -12.5) },
  { k: 'abs', g: 'stab', pgn: 0xF001, n: 'EBC1', u: 'act', f: b => bits2(b, 0, 4) },
  { k: 'asr', g: 'stab', pgn: 0xF001, n: 'EBC1', u: 'act', f: b => bits2(b, 0, 0) },
  { k: 'axle', g: 'stab', pgn: 0xFEBF, n: 'EBC2', u: 'kmh', f: b => lin(u16(b, 0), 1 / 256) },
  // керування
  { k: 'brake', g: 'drive', pgn: 0xF001, n: 'EBC1', u: 'pct', f: b => lin(u8(b, 1), 0.4) },
  { k: 'accel', g: 'drive', pgn: 0xF003, n: 'EEC2', u: 'pct', f: b => lin(u8(b, 1), 0.4) },
  { k: 'cruise', g: 'drive', pgn: 0xFEF1, n: 'CCVS1', u: 'onoff', f: b => bits2(b, 3, 0) },
  { k: 'park', g: 'drive', pgn: 0xFEF1, n: 'CCVS1', u: 'onoff', f: b => bits2(b, 0, 2) },
  // паливо
  { k: 'fuelRate', g: 'fuel', pgn: 0xFEF2, n: 'LFE', u: 'lh', f: b => lin(u16(b, 0), 0.05) },
  { k: 'fuelLvl', g: 'fuel', pgn: 0xFEFC, n: 'DD', u: 'pct', f: b => lin(u8(b, 1), 0.4) },
  { k: 'adblue', g: 'fuel', pgn: 0xFE56, n: 'AT1T1I', u: 'pct', f: b => lin(u8(b, 0), 0.4) },
  { k: 'fuelTot', g: 'fuel', pgn: 0xFEE9, n: 'LFC', u: 'l', f: b => lin(u32(b, 4), 0.5) },
  // стан машини
  { k: 'cool', g: 'eng', pgn: 0xFEEE, n: 'ET1', u: 'c', f: b => lin(u8(b, 0), 1, -40) },
  { k: 'amb', g: 'eng', pgn: 0xFEF5, n: 'AMB', u: 'c', f: b => lin(u16(b, 3), 0.03125, -273) },
  { k: 'batt', g: 'eng', pgn: 0xFEF7, n: 'VEP1', u: 'v', f: b => lin(u16(b, 4), 0.05) },
  { k: 'hours', g: 'eng', pgn: 0xFEE5, n: 'HOURS', u: 'h', f: b => lin(u32(b, 0), 0.05) }
];
export const GROUPS = ['move', 'stab', 'drive', 'fuel', 'eng'];
const BY_PGN = new Map();
for (const p of PARAMS) { if (!BY_PGN.has(p.pgn)) BY_PGN.set(p.pgn, []); BY_PGN.get(p.pgn).push(p); }

const hexBytes = d => Array.isArray(d) ? d.map(x => x & 0xFF) : String(d || '').replace(/[^0-9a-f]/gi, '').match(/../g)?.map(h => parseInt(h, 16)) || [];
/** Один кадр CAN → оновлені показання. Повертає кількість розпізнаних значень. */
export function feed(id, data, now = Date.now()) {
  const n = typeof id === 'string' ? parseInt(id.replace(/^0x/i, ''), 16) : +id;
  if (!Number.isFinite(n)) return 0;
  const list = BY_PGN.get(pgnOf(n)); if (!list) return 0;
  const b = hexBytes(data); if (b.length < 8) return 0;
  let k = 0;
  for (const p of list) { let v = null; try { v = p.f(b); } catch (_) {} if (v != null && Number.isFinite(v)) { st.vals[p.k] = { v, t: now }; k++; } }
  if (k) { st.last = now; st.frames++; }
  return k;
}
export const fresh = (k, now = Date.now()) => { const x = st.vals[k]; return x && now - x.t < STALE ? x.v : null; };
export const freshCount = (now = Date.now()) => Object.keys(st.vals).filter(k => fresh(k, now) != null).length;

/* ---------- як показати ---------- */
const nf = (v, d = 0) => v.toLocaleString('uk-UA', { minimumFractionDigits: d, maximumFractionDigits: d });
export function fmt(p, v) {
  if (v == null) return '—';
  switch (p.u) {
    case 'kmh': return nf(v, 0) + ' ' + t('obdU_kmh');
    case 'rpm': return nf(Math.round(v / 10) * 10, 0) + ' ' + t('obdU_rpm');
    case 'gear': return v === 0 ? 'N' : v < 0 ? 'R' + (v === -1 ? '' : -v) : String(v);
    case 'km': return nf(v, v < 100 ? 2 : 1) + ' ' + t('obdU_km');
    case 'deg': return nf(v, 0) + '°';
    case 'degs': return nf(v, 1) + ' °/' + t('obdU_s');
    case 'ms2': return nf(v, 2) + ' ' + t('obdU_ms2');
    case 'act': return t(v ? 'obdAct' : 'obdIdle');
    case 'onoff': return t(v ? 'obdOn' : 'obdOff');
    case 'pct': return nf(v, 0) + ' %';
    case 'lh': return nf(v, 1) + ' ' + t('obdU_lh');
    case 'l': return nf(v, 0) + ' ' + t('obdU_l');
    case 'c': return nf(v, 0) + ' °C';
    case 'v': return nf(v, 1) + ' ' + t('obdU_v');
    case 'h': return nf(v, 0) + ' ' + t('obdU_h');
    default: return nf(v, 1);
  }
}

/* ---------- увімкнути / вимкнути ---------- */
let emitT = 0, emitQ = false, watchT = 0;
function emit() { if (emitT) { emitQ = true; return; } bus.emit('obd', st); emitT = setTimeout(() => { emitT = 0; if (emitQ) { emitQ = false; emit(); } }, 250); }
// Перемикач: діє лише коли пристрій підключено. Вимкнули — показання не беремо й не показуємо (пристрій лишається підключеним).
export function setOn(on) {
  if (!st.conn) return false;
  S.obd = !!on; st.demo = false;
  if (!on) { st.vals = {}; st.last = 0; st.link = 'conn'; }
  log('info', 'модуль OBD: ' + (on ? 'увімкнено' : 'вимкнено'));
  emit(); return true;
}
// увімкнено = пристрій підключено й водій його не вимкнув (за замовчуванням — увімкнено, щойно підключився)
export const isOn = () => st.conn && S.obd !== false;
// показання йдуть просто зараз
export const linkOk = () => isOn() && st.link === 'ok' && Date.now() - st.last < STALE;

// Приклад показань (як виглядатиме з модулем): чесно позначений «приклад», зникає з першим справжнім кадром чи з закриттям вікна
const DEMO = [
  ['18FEF100', '00 80 55 00 00 00 00 00'],          // 85,5 км/год за колесами
  ['0CFE6CEE', '00 00 00 00 00 00 40 55'],          // 85,25 км/год за тахографом
  ['0CF00400', 'F0 7D 82 30 2A 00 F0 7D'],          // 1350 об/хв
  ['18F00503', '89 00 00 8F 00 00 00 00'],          // передача 18
  ['18FEC1EE', '40 9F 5A 03 10 27 00 00'],          // ≈ 281 351 км
  ['18F0090B', '24 7D 00 5A 7D 5C 7D 7F'],          // кермо, поворот, прискорення
  ['18F0010B', '00 00 00 00 00 00 00 00'],          // ABS і ASR не працюють, гальмо 0 %
  ['0CF00300', '00 50 00 00 00 00 00 00'],          // газ 32 %
  ['18FEF200', '8C 02 00 00 00 00 00 00'],          // 32,6 л/год
  ['18FEFC17', 'FF A6 00 00 00 00 00 00'],          // паливо 66 %
  ['18FE5600', 'BE 00 00 00 00 00 00 00'],          // AdBlue 76 %
  ['18FEE900', '00 00 00 00 A0 F0 1A 00'],          // всього витрачено
  ['18FEEE00', '7D 00 00 00 00 00 00 00'],          // 85 °C
  ['18FEF500', '00 00 00 C0 24 00 00 00'],          // повітря +20 °C
  ['18FEF700', '00 00 00 00 30 02 00 00'],          // 28 В
  ['18FEE500', 'A0 86 01 00 00 00 00 00']           // 5000 мотогодин
];
export function demo(on) {
  st.demo = !!on;
  if (on) { const now = Date.now(); for (const [id, d] of DEMO) feed(id, d, now + 3600e3); }      // «приклад» не старіє, поки вікно відкрите
  else { st.vals = {}; st.last = 0; }
  emit();
}

export function init() {
  bus.on('native:obd', d => {
    if (!d) return;
    if (!st.conn) { st.conn = true; st.link = 'conn'; }               // кадри йдуть — отже, пристрій підключено
    if (!isOn()) { emit(); return; }                                   // вимкнено водієм — показань не беремо
    if (st.demo) { st.demo = false; st.vals = {}; }
    const now = Date.now();
    if (Array.isArray(d.f)) for (const [id, x] of d.f) feed(id, x, now); else feed(d.id, d.d, now);
    if (st.link !== 'ok' && st.last) st.link = 'ok';
    emit();
  });
  // стан від оболонки: 'ok' / 'conn' — пристрій підключено; 'none' / 'off' / 'search' / 'err' — пристрою немає
  bus.on('native:obdLink', d => {
    if (!d) return;
    const was = st.conn; st.conn = d.state === 'ok' || d.state === 'conn' || d.state === 'lost';
    st.dev = d.dev || (st.conn ? st.dev : ''); st.msg = d.msg || '';
    if (!st.conn) { st.link = 'none'; st.vals = {}; st.last = 0; }
    else if (!was || st.link === 'none') st.link = 'conn';
    if (st.conn !== was) log('info', 'пристрій зчитування OBD: ' + (st.conn ? 'підключено' + (st.dev ? ' (' + st.dev + ')' : '') : 'відключено'));
    emit();
  });
  // показань давно немає — «показань немає» (повертається сам, щойно кадри підуть)
  clearInterval(watchT);
  watchT = setInterval(() => { if (st.link === 'ok' && Date.now() - st.last > STALE) { st.link = 'lost'; emit(); } }, 1000);
  // оболонка, що вміє підключати модуль, шукає його сама від запуску; ця (№8) — ще не вміє, пристрій «не підключено»
  if (supported()) { try { N.obdStart(); } catch (e) { st.msg = String(e && e.message || e); } }
}
