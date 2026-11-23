// Офлайн-карта всієї України: файл PMTiles у телефоні (завантажує оболонка), стиль Protomaps українською.
import { bus, log, S } from './core.js';
import * as P from './platform.js';

export const off = { supported: P.isNative && P.offlineSupported(), installed: false, size: 0, date: '', free: 0, dl: { state: 'none' }, remote: null, remoteErr: '', bad: '' };
let timer = null, wasInstalled = false;

export function refreshStatus() {
  const s = P.offlineStatus(); if (!s) return off;
  off.installed = !!s.installed; off.size = s.size || 0; off.date = s.date || ''; off.free = s.free || 0; off.dl = s.dl || { state: 'none' };
  const busy = ['running', 'pending', 'paused'].includes(off.dl.state);
  if (busy && !timer) timer = setInterval(refreshStatus, 1500);
  if (!busy && timer) { clearInterval(timer); timer = null; }
  if (off.installed && !wasInstalled) { wasInstalled = true; off.bad = ''; log('info', 'офлайн-карта: ' + (off.size / 1e6).toFixed(0) + ' МБ, ' + off.date); bus.emit('offlineReady'); verify(); }
  if (!off.installed) { wasInstalled = false; off.bad = ''; }
  bus.emit('offline', off);
  return off;
}
// Офлайн-карта показується, коли вона є, читається і водій не вибрав «лише онлайн».
export const offlineActive = () => off.installed && !off.bad && S.mapMode !== 'online';

// Самоперевірка файлу карти (1.1.12): читаємо заголовок PMTiles так само, як це робить карта (шматком, через Range),
// і звіряємо довжину файлу з тим, що записано в заголовку. Обірване завантаження чи збій читання — це «сіра карта»:
// кажемо про це прямо й показуємо онлайн-карту, а не мовчки малюємо порожнє тло.
export async function verify() {
  let bad = '';
  try {
    const r = await fetch(location.origin + '/offline/ukraine.pmtiles', { headers: { Range: 'bytes=0-126' }, cache: 'no-store' });
    if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer(), v = new DataView(buf);
    if (buf.byteLength < 127 || String.fromCharCode(...new Uint8Array(buf, 0, 7)) !== 'PMTiles') throw new Error('це не файл карти');
    const u = o => Number(v.getBigUint64(o, true)), need = Math.max(u(8) + u(16), u(24) + u(32), u(40) + u(48), u(56) + u(64));
    if (off.size && off.size < need) bad = 'short:' + Math.round(off.size / 1e6) + '/' + Math.round(need / 1e6);
  } catch (e) { bad = 'read:' + (e && e.message || e); }
  if (bad !== off.bad) {
    off.bad = bad;
    if (bad) { log('err', 'офлайн-карта не читається (' + bad + ') — показую онлайн-карту'); bus.emit('offlineBad', bad); }
    else bus.emit('offlineReady');                 // знову читається — повертаємо офлайн-карту
    bus.emit('offline', off);
  }
  return !bad;
}

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
export function offlineStyle(night = false) {
  const base = location.origin + '/';
  const lang = S.lang === 'ru' ? 'ru' : 'uk';
  const flavor = { ...basemaps.namedFlavor(night ? 'dark' : 'light'), ...(night ? NIGHT : DAY) };
  return {
    version: 8,
    glyphs: base + 'vendor/glyphs/{fontstack}/{range}.pbf',
    sprite: base + 'vendor/sprites/' + (night ? 'dark' : 'light'),
    metadata: { reisNight: !!night },
    sources: { protomaps: { type: 'vector', url: 'pmtiles://' + base + 'offline/ukraine.pmtiles', attribution: '© OpenStreetMap · Protomaps' } },
    layers: basemaps.layers('protomaps', flavor, { lang })
  };
}

export function init() {
  if (typeof pmtiles !== 'undefined') {
    try { const proto = new pmtiles.Protocol(); maplibregl.addProtocol('pmtiles', proto.tile); }
    catch (e) { log('warn', 'pmtiles: ' + e.message); }
  }
  bus.on('native:offline', d => {
    if (d && d.remote) { off.remote = d.remote; off.remoteErr = ''; }
    if (d && d.error) off.remoteErr = d.error;
    refreshStatus();
  });
  if (off.supported) { refreshStatus(); if (P.online()) P.offlineCheck(); }
}
