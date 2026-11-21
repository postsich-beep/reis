// Камери швидкості та піт-стопи для фур уздовж маршруту (OpenStreetMap через Overpass), контроль часу за кермом.
import { bus, log, S, fmtDist, sleep } from './core.js';
import { http, online } from './platform.js';
import { pos } from './nav.js';
import { g, say, distWords } from './guide.js';
import { t } from './i18n.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const poi = { cams: [], stops: [], loading: false, nextCam: null, drive: 0, driveWarn: 0 };
let lastFetch = 0, camSaid = new Set(), stopSaid = new Set(), lastStopSay = 0;

async function overpass(q) {
  let err;
  for (const base of OVERPASS) {
    try {
      const r = await http(base, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), timeout: 50000 });
      if (r.status === 200) return JSON.parse(r.text);
      err = new Error('HTTP ' + r.status);
    } catch (e) { err = e; }
  }
  throw err || new Error('overpass');
}

// Маршрут шматками до 120 км, точки не частіше ніж кожні 400 м.
function chunks(idx) {
  const out = []; let cur = [], lastD = -1e9, startD = 0;
  for (let i = 0; i < idx.c.length; i++) {
    const d = idx.cum[i];
    if (d - lastD < 400 && i !== idx.c.length - 1) continue;
    cur.push(idx.c[i][0].toFixed(5) + ',' + idx.c[i][1].toFixed(5)); lastD = d;
    if (d - startD > 120000 && cur.length > 1) { out.push(cur); cur = [cur[cur.length - 1]]; startD = d; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function stopInfo(tags) {
  const hgv = /yes|designated/.test(tags.hgv || '') || tags['fuel:HGV_diesel'] === 'yes';
  const shower = tags.shower === 'yes' || tags['amenity:shower'] === 'yes';
  const food = ['restaurant', 'cafe', 'fast_food'].some(k => tags[k] === 'yes') || tags.shop === 'convenience' || !!tags.cuisine;
  const wc = tags.toilets === 'yes';
  const h24 = tags.opening_hours === '24/7';
  const name = tags.name || tags.brand || tags.operator || '';
  const big = /okko|wog|upg|socar|shell|amic|брсм|brsm|окко|укрнафта|ukrnafta|glusco|klo|кло|авантаж|avantage/i.test(name + ' ' + (tags.brand || ''));
  const kind = tags.highway === 'services' ? 'services' : tags.highway === 'rest_area' ? 'rest' : tags.amenity === 'parking' ? 'parking' : 'fuel';
  const score = (hgv ? 3 : 0) + (shower ? 2 : 0) + (food ? 1 : 0) + (wc ? 1 : 0) + (h24 ? 1 : 0) + (big ? 1 : 0) + (kind === 'services' ? 3 : kind === 'rest' ? 2 : kind === 'parking' ? 2 : 0);
  return { name, kind, hgv, shower, food, wc, h24, score };
}

let rawCams = new Map(), rawStops = new Map(), refetchTimer = null;
export async function fetchForRoute(idx, force) {
  if (!idx) return;
  reproject(idx);                                          // одразу показуємо те, що вже знаємо
  if (poi.loading || !online()) return;
  if (!force && Date.now() - lastFetch < 60000) {          // частий перерахунок — не смикаємо сервер
    clearTimeout(refetchTimer); refetchTimer = setTimeout(() => { if (g.idx) fetchForRoute(g.idx, true); }, 61000);
    return;
  }
  poi.loading = true; lastFetch = Date.now(); bus.emit('poi', poi);
  try {
    for (const ch of chunks(idx)) {
      const c = ch.join(','), parts = [];
      if (S.cams) parts.push(`node["highway"="speed_camera"](around:150,${c});`);
      if (S.stops) parts.push(`nwr["amenity"="fuel"](around:350,${c});nwr["highway"~"^(services|rest_area)$"](around:900,${c});nwr["amenity"="parking"]["hgv"~"^(yes|designated)$"](around:900,${c});`);
      if (!parts.length) break;
      const j = await overpass(`[out:json][timeout:45];(${parts.join('')});out center tags;`);
      for (const e of j.elements || []) {
        const key = e.type + e.id;
        const lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
        if (lat == null) continue;
        const tags = e.tags || {};
        if (tags.highway === 'speed_camera') rawCams.set(key, { id: key, lat, lon, max: parseInt(tags.maxspeed, 10) || null });
        else rawStops.set(key, { id: key, lat, lon, ...stopInfo(tags) });
      }
      if (g.idx === idx) reproject(idx);
      await sleep(1200);
    }
    log('info', `POI: камер ${poi.cams.length}, зупинок ${poi.stops.length}`);
  } catch (e) { log('warn', 'POI: ' + e.message); }
  poi.loading = false; bus.emit('poi', poi);
}

// Прив'язка об'єктів до поточного маршруту: відстань уздовж і відхилення вбік.
function reproject(idx) {
  const fit = (pool, maxOff) => [...pool.values()].map(x => { const l = idx.locate(x, null); return l ? { ...x, d: l.d, off: l.off } : null; })
    .filter(x => x && x.off <= maxOff).sort((a, b) => a.d - b.d);
  poi.cams = fit(rawCams, 200); poi.stops = fit(rawStops, 1200);
  bus.emit('poi', poi);
}
export function restore(cams, stops) { for (const c of cams || []) rawCams.set(c.id, c); for (const s of stops || []) rawStops.set(s.id, s); }
export const snapshot = () => ({ cams: [...rawCams.values()], stops: [...rawStops.values()] });

export const stopsAhead = (minScore = 0) => poi.stops.filter(s => pos.rd == null || s.d > pos.rd + 200).filter(s => s.score >= minScore);
export function stopLabel(s) {
  const kind = t('stop_' + s.kind), feats = [s.hgv && t('f_hgv'), s.shower && t('f_shower'), s.food && t('f_food'), s.wc && t('f_wc'), s.h24 && '24/7'].filter(Boolean);
  return { title: s.name ? s.name : kind, sub: (s.name ? kind + (feats.length ? ' · ' : '') : '') + feats.join(', ') };
}

function check() {
  if (!g.active || pos.rd == null || !pos.onRoute) { poi.nextCam = null; return; }
  const rd = pos.rd;
  // камери
  let next = null;
  if (S.cams) for (const c of poi.cams) { if (c.d > rd - 30) { next = c; break; } }
  if (next && next.d - rd < 1500) {
    poi.nextCam = { ...next, ahead: next.d - rd };
    if (next.d - rd < 800 && !camSaid.has(next.id)) {
      camSaid.add(next.id);
      say(t('voiceCam', distWords(next.d - rd)) + (next.max ? '. ' + t('voiceLimit', next.max) : ''));
    }
  } else poi.nextCam = null;
  // піт-стопи: щойно гідна стоянка потрапляє у вікно S.stopKm — кажемо про найкращу, не частіше ніж раз на 5 хв
  if (S.stops && S.lookahead && Date.now() - lastStopSay > 300000) {
    const far = S.stopKm * 1000;
    const win = poi.stops.filter(s => s.score >= 3 && !stopSaid.has(s.id) && s.d - rd > 2000 && s.d - rd <= far);
    if (win.length) {
      const best = win.slice().sort((a, b) => (b.score - a.score) || (a.d - b.d))[0], ahead = best.d - rd, lb = stopLabel(best);
      for (const s of win) stopSaid.add(s.id);
      lastStopSay = Date.now();
      bus.emit('feedPush', { src: 'stop', level: 'green', text: t('stopAhead', fmtDist(ahead), lb.title) + (lb.sub ? ' — ' + lb.sub : ''), key: 'stop' + best.id, lat: best.lat, lon: best.lon, voice: t('voiceStop', distWords(ahead), lb.title) });
    }
  }
}

/* ---------- час за кермом: 4,5 год руху → перерва 45 хв ---------- */
let dState = { drive: 0, stand: 0, t: Date.now() };
try { const s = JSON.parse(localStorage.getItem('reis.drive') || 'null'); if (s && Date.now() - s.t < 45 * 60000) dState = s; } catch (_) {}
function driveTick() {
  const now = Date.now(), dt = Math.min(30, (now - dState.t) / 1000); dState.t = now;
  if (pos.mode === 'none') return;
  if (pos.spd > 1.4) { dState.drive += dt; dState.stand = 0; }
  else { dState.stand += dt; if (dState.stand >= 45 * 60) { dState.drive = 0; poi.driveWarn = 0; } }
  poi.drive = dState.drive;
  if (S.drive) {
    if (dState.drive >= 4.5 * 3600 && poi.driveWarn < 2) { poi.driveWarn = 2; bus.emit('feedPush', { src: 'drive', level: 'red', text: t('drive450'), key: 'drive2-' + Math.floor(now / 36e5), voice: t('drive450') }); }
    else if (dState.drive >= 4 * 3600 && poi.driveWarn < 1) { poi.driveWarn = 1; bus.emit('feedPush', { src: 'drive', level: 'yellow', text: t('drive400'), key: 'drive1-' + Math.floor(now / 36e5), voice: t('drive400') }); }
  }
}
export function resetDrive() { dState.drive = 0; dState.stand = 0; poi.drive = 0; poi.driveWarn = 0; }

export function init() {
  bus.on('guide', check);
  bus.on('route', () => {
    camSaid = new Set();
    if (!g.idx) { poi.cams = []; poi.stops = []; poi.nextCam = null; bus.emit('poi', poi); return; }
    fetchForRoute(g.idx, false);
  });
  setInterval(() => { driveTick(); try { localStorage.setItem('reis.drive', JSON.stringify(dState)); } catch (_) {} }, 5000);
}
