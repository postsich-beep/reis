// Офлайн-карта всієї України: файл PMTiles у телефоні (завантажує оболонка), стиль Protomaps українською.
import { bus, log, S } from './core.js';
import * as P from './platform.js';

export const off = { supported: P.isNative && P.offlineSupported(), installed: false, size: 0, date: '', free: 0, dl: { state: 'none' }, remote: null, remoteErr: '',
  ok: false, bad: '', mode: '', reads: 0, errs: 0, lastErr: '', glyphMiss: [], bounds: null, zooms: null };
let timer = null, wasInstalled = false;

export function refreshStatus() {
  const s = P.offlineStatus(); if (!s) return off;
  off.installed = !!s.installed; off.size = s.size || 0; off.date = s.date || ''; off.free = s.free || 0; off.dl = s.dl || { state: 'none' };
  const busy = ['running', 'pending', 'paused'].includes(off.dl.state);
  if (busy && !timer) timer = setInterval(refreshStatus, 1500);
  if (!busy && timer) { clearInterval(timer); timer = null; }
  // файл з'явився: спершу перевіряємо, що він читається шматками (verify), і лише тоді вмикаємо офлайн-карту
  if (off.installed && !wasInstalled) { wasInstalled = true; off.ok = false; off.bad = ''; off.mode = ''; log('info', 'офлайн-карта: ' + (off.size / 1e6).toFixed(0) + ' МБ, ' + off.date); verify(); }
  if (!off.installed) { wasInstalled = false; off.ok = false; off.bad = ''; off.mode = ''; }
  bus.emit('offline', off);
  return off;
}
// Офлайн-карта показується, коли вона є, перевірена (читається шматками) і водій не вибрав «лише онлайн».
export const offlineActive = () => off.installed && off.ok && !off.bad && S.mapMode !== 'online';

/* ---------- читання файлу карти шматками ----------
   Карта (PMTiles) читає з файлу 1,9 ГБ маленькі шматки: заголовок, каталоги, тайли. Спосіб читання — два:
     'q'     — шматок задано в адресі (?r=початок-кінець): оболонка №7+ віддає рівно ці байти;
     'range' — заголовок Range (браузер; оболонка, чий Range працює).
   До 1.1.12 був лише Range, а Android WebView обробляє його по-своєму (сам перемотує потік) — на телефоні читався
   тільки початок файлу, жоден тайл не приходив: «сіра карта». Тому тепер спосіб ПЕРЕВІРЯЄМО читанням із середини. */
const PM_URL = () => location.origin + '/offline/ukraine.pmtiles';
const nativeRev = () => { try { return +(P.appInfo() || {}).nativeRev || 0; } catch (_) { return 0; } };
async function readBytes(mode, offset, length, signal) {
  const end = offset + length - 1, ctrl = new AbortController();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', () => ctrl.abort(), { once: true }); }
  const r = mode === 'q' ? await fetch(PM_URL() + '?r=' + offset + '-' + end, { cache: 'no-store', signal: ctrl.signal })
    : await fetch(PM_URL(), { headers: { Range: 'bytes=' + offset + '-' + end }, cache: 'no-store', signal: ctrl.signal });
  if (r.status !== 200 && r.status !== 206) throw new Error('HTTP ' + r.status);
  const cl = r.headers.get('content-length');
  // замість шматка йде файл цілком (1,9 ГБ) — обриваємо одразу, у пам'ять він не влізе
  if ((cl != null && +cl > length) || (cl == null && r.status === 200 && mode === 'range' && offset > 0)) { ctrl.abort(); throw new Error('замість шматка прийшов файл цілком'); }
  return r.arrayBuffer();
}
// Джерело для бібліотеки PMTiles: читає нашим перевіреним способом і рахує читання й помилки (видно в «Налаштуваннях»)
class PmSource {
  getKey() { return PM_URL(); }
  async getBytes(offset, length, signal) {
    if (!off.mode) { await verify(); if (!off.mode) throw new Error('офлайн-карта не читається'); }
    try { const data = await readBytes(off.mode, offset, length, signal); off.reads++; return { data }; }
    catch (e) { if (!(signal && signal.aborted)) { off.errs++; off.lastErr = String(e && e.message || e).slice(0, 120); } throw e; }
  }
}

// Самоперевірка файлу карти: 1) заголовок PMTiles і повна довжина файлу (обірване завантаження);
// 2) шматок НЕ з початку файлу — саме так читаються тайли. Не читається — кажемо прямо й показуємо онлайн-карту,
// а не мовчки малюємо порожнє сіре тло.
let checking = null;
export function verify() { if (!checking) checking = doVerify().finally(() => { checking = null; }); return checking; }
async function doVerify() {
  let bad = '', mode = '';
  try {
    const buf = await readBytes('range', 0, 256), head = new Uint8Array(buf), v = new DataView(buf);
    if (head.length < 127 || String.fromCharCode(...head.subarray(0, 7)) !== 'PMTiles') throw new Error('це не файл карти');
    const u = o => Number(v.getBigUint64(o, true)), need = Math.max(u(8) + u(16), u(24) + u(32), u(40) + u(48), u(56) + u(64));
    off.zooms = [head[100], head[101]];                                                     // найдрібніший і найбільший масштаб у файлі
    off.bounds = [102, 106, 110, 114].map(o => v.getInt32(o, true) / 1e7);                  // межі карти: захід, південь, схід, північ
    if (off.size && off.size < need) bad = 'short:' + Math.round(off.size / 1e6) + '/' + Math.round(need / 1e6);
    else {
      const from = 128, n = Math.min(128, head.length - from), want = head.subarray(from, from + n), why = [];
      for (const m of (nativeRev() >= 7 ? ['q', 'range'] : ['range'])) {
        try {
          const got = new Uint8Array(await readBytes(m, from, n));
          if (got.length === n && got.every((x, i) => x === want[i])) { mode = m; break; }
          why.push(m + ': не ті байти (' + got.length + ')');
        } catch (e) { why.push(m + ': ' + (e && e.message || e)); }
      }
      if (!mode) { bad = 'app'; off.lastErr = why.join('; ').slice(0, 160); }
    }
  } catch (e) { bad = 'read:' + (e && e.message || e); }
  const was = off.bad, wasOk = off.ok;
  off.bad = bad; off.ok = !bad; off.mode = bad ? '' : mode;
  if (bad && bad !== was) { log('err', 'офлайн-карта не читається (' + bad + (off.lastErr ? '; ' + off.lastErr : '') + ') — показую онлайн-карту'); bus.emit('offlineBad', bad); }
  if (!bad && (!wasOk || was)) { log('info', 'офлайн-карта читається, спосіб «' + mode + '»'); bus.emit('offlineReady'); }
  bus.emit('offline', off);
  return !bad;
}
/** Карта увімкнулась, а тайли так і не намалювались (перевіряє map.js): показуємо онлайн-карту й кажемо про це. */
export function tilesBad(info) {
  if (off.bad) return;
  off.bad = 'tiles'; off.lastErr = String(info || off.lastErr || '').slice(0, 160);
  log('err', 'офлайн-карта не малюється (' + off.lastErr + ') — показую онлайн-карту');
  bus.emit('offlineBad', 'tiles'); bus.emit('offline', off);
}
/** Дочекатися першої перевірки файлу (щоб карта одразу стартувала з правильним джерелом), але не довше за ms. */
export const whenChecked = (ms = 1500) => !off.installed || off.ok || off.bad ? Promise.resolve() : Promise.race([verify().catch(() => {}), new Promise(r => setTimeout(r, ms))]);

// Власні кольори офлайн-карти (1.1.12). Стандартна світла карта Protomaps малює всі дороги білим по світлому,
// а вночі її просто «перевертали» фільтром — дороги ставали чорними на темно-сірому: «сіра карта без доріг».
// Тепер траси — помаранчеві, головні дороги — жовті, вулиці — білі з обвідкою; уночі — окрема темна карта (без фільтра).
const DAY = {
  background: '#d9dde0', earth: '#eceae4', water: '#9fd0ea', buildings: '#d9d4cc', railway: '#8b959b', boundaries: '#8f8f9c',
  highway: '#f5b041', highway_casing_early: '#b9770e', highway_casing_late: '#b9770e',
  major: '#fbe391', major_casing_early: '#c9a437', major_casing_late: '#c9a437',
  link: '#f8cf6a', link_casing: '#b98f2a',
  minor_a: '#ffffff', minor_b: '#ffffff', minor_casing: '#b9c0c9',
  minor_service: '#f6f7f8', minor_service_casing: '#c9ced6', other: '#f1f2f4',
  bridges_highway: '#f5b041', bridges_highway_casing: '#9c6309', bridges_major: '#fbe391', bridges_major_casing: '#b08c26',
  bridges_link: '#f8cf6a', bridges_link_casing: '#a57f22', bridges_minor: '#ffffff', bridges_minor_casing: '#a9b1bb', bridges_other: '#f1f2f4', bridges_other_casing: '#b9c0c9',
  tunnel_highway: '#f3cf94', tunnel_highway_casing: '#c7a56a', tunnel_major: '#f5ebc4', tunnel_major_casing: '#cdbf8a', tunnel_link: '#f3deaa', tunnel_link_casing: '#c9b47c',
  tunnel_minor: '#eceef0', tunnel_minor_casing: '#c3c9d0', tunnel_other: '#e6e8eb', tunnel_other_casing: '#c9ced4',
  roads_label_minor: '#3f454d', roads_label_minor_halo: '#ffffff', roads_label_major: '#2a2f36', roads_label_major_halo: '#ffffff',
  city_label: '#22262b', city_label_halo: '#ffffff', subplace_label: '#5f6772', subplace_label_halo: '#f4f4f2', state_label: '#8b93a0', country_label: '#6f7783',
  address_label: '#6b6257', address_label_halo: '#ffffff'
};
const NIGHT = {
  background: '#0f1317', earth: '#1a1f25', water: '#10304a', buildings: '#252b33', railway: '#59626c', boundaries: '#6f7a8c',
  park_a: '#182820', park_b: '#1b3528', wood_a: '#17261e', wood_b: '#193022', scrub_a: '#1a271f', scrub_b: '#1b2f24', pedestrian: '#20262d',
  industrial: '#20252b', hospital: '#262328', school: '#25242a', aerodrome: '#1f242b', runway: '#3a424c', pier: '#3a424c', military: '#23232a', zoo: '#1b2a26', beach: '#2a2a24', sand: '#26261f', glacier: '#2a3038',
  highway: '#e0a03c', highway_casing_early: '#5e3d0c', highway_casing_late: '#5e3d0c',
  major: '#b9a15a', major_casing_early: '#4a3f1a', major_casing_late: '#4a3f1a',
  link: '#c9953a', link_casing: '#57400f',
  minor_a: '#727d8b', minor_b: '#727d8b', minor_casing: '#0c0f12',
  minor_service: '#4b545f', minor_service_casing: '#0c0f12', other: '#414a54',
  bridges_highway: '#e0a03c', bridges_highway_casing: '#3d2706', bridges_major: '#b9a15a', bridges_major_casing: '#33290c',
  bridges_link: '#c9953a', bridges_link_casing: '#3d2c08', bridges_minor: '#727d8b', bridges_minor_casing: '#07090b', bridges_other: '#414a54', bridges_other_casing: '#07090b',
  tunnel_highway: '#8a6a34', tunnel_highway_casing: '#3a2a10', tunnel_major: '#77693f', tunnel_major_casing: '#322a13', tunnel_link: '#806432', tunnel_link_casing: '#35280e',
  tunnel_minor: '#4c545e', tunnel_minor_casing: '#0c0f12', tunnel_other: '#353c45', tunnel_other_casing: '#0c0f12',
  roads_label_minor: '#c3cad3', roads_label_minor_halo: '#0f1317', roads_label_major: '#e3e7ec', roads_label_major_halo: '#0f1317',
  city_label: '#eef1f4', city_label_halo: '#0f1317', subplace_label: '#98a2ae', subplace_label_halo: '#0f1317', state_label: '#6c7682', state_label_halo: '#0f1317', country_label: '#8a94a1',
  ocean_label: '#6f9ccb', address_label: '#8f99a6', address_label_halo: '#0f1317'
};
/* ---------- набори літер для підписів офлайн-карти (1.1.15) ----------
   Підписи малюються з наборів літер (гліфів): по файлу на кожні 256 символів Юнікоду. У застосунку лежать лише
   потрібні для України набори, а на карті трапляється що завгодно («№», грузинська назва ресторану, грецька літера).
   Бібліотека карти, не знайшовши ОДНОГО набору, викидає ВЕСЬ квадрат карти — з дорогами, водою й забудовою:
   так у 1.1.13–1.1.14 офлайн-карта в місті лишалась порожнім сірим тлом, хоч файл уже читався правильно.
   Тепер набори йдуть через наш завантажувач: немає файлу — віддаємо порожній набір. Такої літери в підписі не буде,
   але карта намалюється. */
function glyphMissed(url, why) {
  const m = /([^/]+)\/(\d+-\d+)\.pbf/.exec(decodeURIComponent(url)), key = m ? m[1] + ' ' + m[2] : url;
  if (off.glyphMiss.includes(key)) return;
  off.glyphMiss.push(key);
  log('warn', 'офлайн-карта: немає набору літер «' + key + '» (' + why + ') — підписи з такими літерами пропускаю');
}
export async function glyphLoad(params, abortController) {
  const url = String(params && params.url || '').replace(/^reisglyph:\/\//, ''), signal = abortController && abortController.signal;
  try {
    const r = await fetch(url, signal ? { signal } : undefined);
    if (r.ok) { const data = await r.arrayBuffer(); if (data.byteLength) return { data }; glyphMissed(url, 'порожній файл'); }
    else glyphMissed(url, 'HTTP ' + r.status);
  } catch (e) {
    if (signal && signal.aborted) throw e;
    glyphMissed(url, String(e && e.message || e).slice(0, 60));
  }
  return { data: new ArrayBuffer(0) };
}
export function offlineStyle(night = false) {
  const base = location.origin + '/';
  const lang = S.lang === 'ru' ? 'ru' : 'uk';
  const flavor = { ...basemaps.namedFlavor(night ? 'dark' : 'light'), ...(night ? NIGHT : DAY) };
  return {
    version: 8,
    glyphs: 'reisglyph://' + base + 'vendor/glyphs/{fontstack}/{range}.pbf',
    sprite: base + 'vendor/sprites/' + (night ? 'dark' : 'light'),
    metadata: { reisNight: !!night },
    sources: { protomaps: { type: 'vector', url: 'pmtiles://' + base + 'offline/ukraine.pmtiles', attribution: '© OpenStreetMap · Protomaps' } },
    layers: basemaps.layers('protomaps', flavor, { lang })
  };
}

/** Чи є у файлі квадрат карти під цим місцем: повертає його розмір у байтах (0 — немає; null — не вдалося прочитати).
 *  Сторож «карта не малюється» питає це перед вироком: квадрат є, а на екрані порожньо — отже, збій малювання. */
let pmFile = null;
export async function tileBytesAt(lat, lon, zoom) {
  if (!pmFile) return null;
  const Z = off.zooms || [0, 14], z = Math.max(Z[0], Math.min(Z[1], Math.floor(zoom))), n = 2 ** z, r = lat * Math.PI / 180;
  const x = Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n))), y = Math.min(n - 1, Math.max(0, Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)));
  try { const t = await pmFile.getZxy(z, x, y); return t && t.data ? t.data.byteLength : 0; } catch (_) { return null; }
}

export function init() {
  if (typeof pmtiles !== 'undefined') {
    try { const proto = new pmtiles.Protocol(); pmFile = new pmtiles.PMTiles(new PmSource()); proto.add(pmFile); maplibregl.addProtocol('pmtiles', proto.tile); }
    catch (e) { log('warn', 'pmtiles: ' + e.message); }
  }
  try { maplibregl.addProtocol('reisglyph', glyphLoad); } catch (e) { log('warn', 'набори літер: ' + e.message); }
  bus.on('native:offline', d => {
    if (d && d.remote) { off.remote = d.remote; off.remoteErr = ''; }
    if (d && d.error) off.remoteErr = d.error;
    refreshStatus();
  });
  if (off.supported) { refreshStatus(); if (P.online()) P.offlineCheck(); }
}
