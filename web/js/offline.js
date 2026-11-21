// Офлайн-карта всієї України: файл PMTiles у телефоні (завантажує оболонка), стиль Protomaps українською.
import { bus, log, S } from './core.js';
import * as P from './platform.js';

export const off = { supported: P.isNative && P.offlineSupported(), installed: false, size: 0, date: '', free: 0, dl: { state: 'none' }, remote: null, remoteErr: '' };
let timer = null, wasInstalled = false;

export function refreshStatus() {
  const s = P.offlineStatus(); if (!s) return off;
  off.installed = !!s.installed; off.size = s.size || 0; off.date = s.date || ''; off.free = s.free || 0; off.dl = s.dl || { state: 'none' };
  const busy = ['running', 'pending', 'paused'].includes(off.dl.state);
  if (busy && !timer) timer = setInterval(refreshStatus, 1500);
  if (!busy && timer) { clearInterval(timer); timer = null; }
  if (off.installed && !wasInstalled) { wasInstalled = true; log('info', 'офлайн-карта: ' + (off.size / 1e6).toFixed(0) + ' МБ, ' + off.date); bus.emit('offlineReady'); }
  if (!off.installed) wasInstalled = false;
  bus.emit('offline', off);
  return off;
}
// Офлайн-карта показується, коли вона є і водій не вибрав «лише онлайн».
export const offlineActive = () => off.installed && S.mapMode !== 'online';

export function offlineStyle() {
  const base = location.origin + '/';
  const lang = S.lang === 'ru' ? 'ru' : 'uk';
  return {
    version: 8,
    glyphs: base + 'vendor/glyphs/{fontstack}/{range}.pbf',
    sprite: base + 'vendor/sprites/light',
    sources: { protomaps: { type: 'vector', url: 'pmtiles://' + base + 'offline/ukraine.pmtiles', attribution: '© OpenStreetMap · Protomaps' } },
    layers: basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang })
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
