// Карта: MapLibre + кеш тайлів у пам'яті телефону (офлайн), маршрут, позначка машини, камери, зупинки.
import { bus, log, S, db, isNight, clamp, sleep } from './core.js';
import { pos } from './nav.js';
import { g } from './guide.js';
import { poi } from './poi.js';
import { feed } from './feed.js';
import { OBLAST_CENTER, oblastName } from './route.js';
import { offlineActive, offlineStyle } from './offline.js';

export let map = null;
export const view = { follow: true, north: false, night: false, zoomBias: 0, blank: false, lastTouch: 0 };
const BLANK = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e8e4da' } }] };

/* ---------- кеш: усе, що карта бере з мережі, осідає в IndexedDB ---------- */
const TILE_RE = /\/(\d{1,2})\/(\d+)\/(\d+)\.(pbf|mvt|png|jpe?g|webp)$/;
export function cacheKey(url) {
  const u = new URL(url), p = u.pathname, m = p.match(TILE_RE);
  if (!m) return u.host + p;
  return u.host + p.slice(0, m.index).replace(/\/\d{8}_\d{6}_[a-z0-9]+/i, '') + m[0];   // номер тижневої версії даних прибираємо
}
const isTileUrl = url => TILE_RE.test(new URL(url).pathname);
const stats = { net: 0, hit: 0, fail: 0 };
export const cacheStats = () => stats;

async function fetchBuf(url, signal, timeoutMs) {
  const ac = new AbortController();
  const onAbort = () => ac.abort(); if (signal) signal.addEventListener('abort', onAbort);
  const tm = timeoutMs ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (r.status === 204 || r.status === 404) return { empty: true };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { buf: await r.arrayBuffer() };
  } finally { if (tm) clearTimeout(tm); if (signal) signal.removeEventListener('abort', onAbort); }
}
async function cacheProtocol(params, abort) {
  const url = params.url.slice(5), key = cacheKey(url), tile = isTileUrl(url);
  const out = b => params.type === 'json' ? { data: JSON.parse(new TextDecoder().decode(b)) } : { data: b };
  const hit = await db.get('c', key);
  // Тайли: спершу кеш (до 30 днів). Стиль і шрифти: спершу мережа, кеш — запасний.
  if (hit && (navigator.onLine === false || (tile && Date.now() - hit.t < 30 * 864e5))) { stats.hit++; return out(hit.b.slice(0)); }
  try {
    const r = await fetchBuf(url, abort && abort.signal, hit ? 5000 : 25000);
    if (r.empty) { if (tile) return { data: new ArrayBuffer(0) }; throw new Error('HTTP 404'); }
    stats.net++;
    db.set('c', key, { b: r.buf.slice(0), t: Date.now() });
    return out(r.buf);
  } catch (e) {
    if (hit) { stats.hit++; return out(hit.b.slice(0)); }
    stats.fail++; throw e;
  }
}
async function fetchToCache(url) {                    // для завантаження коридору маршруту наперед
  const key = cacheKey(url), hit = await db.get('c', key);
  if (hit && Date.now() - hit.t < 20 * 864e5) return 0;
  const r = await fetchBuf(url, null, 20000);
  if (r.empty) return 0;
  await db.set('c', key, { b: r.buf, t: Date.now() });
  return r.buf.byteLength;
}

/* ---------- створення карти ---------- */
let puck = null, puckEl = null, wps = [], pickMarker = null, styleTimer = null, doneD = -1, doneT = 0;
const evMarks = new Map();
const EMPTY = { type: 'FeatureCollection', features: [] };

export function initMap() {
  maplibregl.addProtocol('fc', cacheProtocol);
  map = new maplibregl.Map({
    container: 'map', style: currentStyle(), center: [31.3, 49.0], zoom: 5.4,
    attributionControl: false, maxPitch: 60, fadeDuration: 120,
    // мережеві запити карти йдуть через кеш у телефоні; власні файли застосунку — напряму
    transformRequest: url => /^https?:\/\//.test(url) && !url.startsWith(location.origin) ? { url: 'fc://' + url } : undefined
  });
  const seenErr = new Set();
  map.on('error', e => {
    const m = (e && e.error && e.error.message) || 'map error';
    if (!seenErr.has(m) && seenErr.size < 20) { seenErr.add(m); log('warn', 'карта: ' + m); }
  });
  map.on('style.load', addLayers);
  // Стиль не завантажився (немає мережі й кешу) — показуємо хоча б маршрут на порожньому тлі.
  styleTimer = setTimeout(() => { if (!map.isStyleLoaded() && !map.getSource('route')) { view.blank = true; map.setStyle(BLANK); bus.emit('mapBlank', true); } }, 12000);
  map.on('movestart', e => { if (e.originalEvent) { view.follow = false; view.lastTouch = Date.now(); bus.emit('view', view); } });
  map.on('moveend', e => { if (e.originalEvent) view.lastTouch = Date.now(); });
  setupLongPress();
  puckEl = document.createElement('div'); puckEl.className = 'puck';
  puckEl.innerHTML = '<svg viewBox="0 0 48 48"><path class="puck-halo" d="M24 3 42 43 24 34 6 43Z"/><path class="puck-body" d="M24 8 37.5 38 24 31 10.5 38Z"/></svg>';
  puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'map' });
  bus.on('pos', onPos);
  bus.on('route', drawRoute);
  bus.on('guide', drawProgress);
  bus.on('poi', drawPoi);
  bus.on('feed', drawEvents);
  setInterval(drawEvents, 60000);
  bus.on('settings', k => { if (k === 'theme') applyTheme(); if (k === 'view3d') follow(true); });
  setInterval(() => {
    applyTheme();
    if (!view.follow && S.autoCenter && Date.now() - view.lastTouch > 12000 && (g.active || pos.spd > 3)) setFollow(true);
  }, 3000);
  applyTheme();
  return map;
}

function addLayers() {
  clearTimeout(styleTimer);
  if (map.getSource('route')) return;
  const w = (a, b, c) => ['interpolate', ['linear'], ['zoom'], 6, a, 12, b, 17, c];
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addSource('route-done', { type: 'geojson', data: EMPTY });
  map.addSource('poi', { type: 'geojson', data: EMPTY });
  map.addSource('acc', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'route-case', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0c2a6e', 'line-width': w(5, 9, 17) } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#2f6bff', 'line-width': w(3, 6, 12) } });
  // пройдене — світло-сіро-блакитне поверх синього
  map.addLayer({ id: 'route-done', type: 'line', source: 'route-done', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#a7b6d1', 'line-width': w(3, 6, 12) } });
  map.addLayer({ id: 'acc-fill', type: 'fill', source: 'acc', paint: { 'fill-color': '#f5a300', 'fill-opacity': 0.16 } });
  map.addLayer({ id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': '#c98600', 'line-width': 2, 'line-dasharray': [2, 2] } });
  map.addLayer({
    id: 'poi-dot', type: 'circle', source: 'poi', minzoom: 8,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 13, 7, 16, 10],
      'circle-color': ['match', ['get', 'k'], 'cam', '#e5484d', '#2f9e62'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2
    }
  });
  doneD = -1; drawRoute(); drawPoi();
}

/* ---------- день / ніч ---------- */
export function applyTheme() {
  const night = S.theme === 'night' || (S.theme === 'auto' && isNight(pos.lat ?? 49.0, pos.lon ?? 31.3));
  if (night === view.night && document.body.dataset.theme) return;
  view.night = night; document.body.dataset.theme = night ? 'night' : 'day';
  bus.emit('view', view);
}

/* ---------- позиція і камера ---------- */
export function setFollow(on) { view.follow = on; if (on) { view.zoomBias = 0; follow(true); } bus.emit('view', view); }
export function zoomBy(d) {
  if (view.follow) { view.zoomBias = clamp(view.zoomBias + d, -5, 3); follow(true); }
  else if (map) map.easeTo({ zoom: map.getZoom() + d, duration: 250 });
}
function follow(force) {
  if (!map || pos.lat == null || (document.hidden && !force) || !view.follow) return;
  const kmh = pos.spd * 3.6;
  let zoom = clamp(16.8 - kmh / 45, 14.4, 16.8);
  if (g.active && g.next && g.distNext < 350) zoom = Math.max(zoom, 16.3);
  const h = map.getContainer().clientHeight;
  map.easeTo({
    center: [pos.lon, pos.lat], zoom: clamp(zoom + view.zoomBias, 5, 19), bearing: view.north ? 0 : pos.hdg, pitch: S.view3d ? 52 : 0,
    padding: { top: Math.round(h * 0.36), bottom: Math.round(h * 0.16), left: 0, right: 0 }, duration: force ? 400 : 950, easing: x => x
  });
}
function circle(p, r) {
  const pts = [], kx = 111320 * Math.cos(p.lat * Math.PI / 180);
  for (let i = 0; i <= 48; i++) { const a = i / 48 * 2 * Math.PI; pts.push([p.lon + r * Math.cos(a) / kx, p.lat + r * Math.sin(a) / 110540]); }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
}
let accShown = false;
function onPos() {
  if (!map || pos.lat == null) return;
  puck.setLngLat([pos.lon, pos.lat]).setRotation(pos.hdg);
  if (!puck._added) { puck.addTo(map); puck._added = true; follow(true); }
  const est = pos.mode === 'dr' || pos.mode === 'approx';
  puckEl.classList.toggle('dr', est);
  const src = map.getSource && map.getSource('acc');
  if (src) {
    if (est) { src.setData(circle(pos, Math.max(20, pos.acc || 20))); accShown = true; }
    else if (accShown) { src.setData(EMPTY); accShown = false; }
  }
  follow(false);
}

/* ---------- маршрут ---------- */
function wpEl(cls, txt) { const d = document.createElement('div'); d.className = 'wp ' + cls; d.textContent = txt; return d; }
function drawRoute() {
  for (const m of wps) m.remove(); wps = [];
  const src = map && map.getSource && map.getSource('route'); if (!src) return;
  doneD = -1; setDone(EMPTY);
  if (!g.route) { src.setData(EMPTY); return; }
  src.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: g.route.coords.map(c => [c[1], c[0]]) } });
  const tr = g.trip; if (!tr) return;
  const add = (p, cls, txt) => { if (p) wps.push(new maplibregl.Marker({ element: wpEl(cls, txt), anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map)); };
  add(tr.a, 'wp-a', 'A'); add(tr.v, 'wp-v', '•'); add(tr.b, 'wp-b', 'Б');
  drawProgress();
}
function setDone(data) { const s = map && map.getSource && map.getSource('route-done'); if (s) s.setData(data); }
// Пройдена частина маршруту — окрема світла лінія від старту до машини. Оновлюється не частіше ніж раз на 2 с.
function drawProgress() {
  if (!map || !g.idx) return;
  const rd = pos.rd == null ? 0 : pos.rd, now = Date.now();
  if (Math.abs(rd - doneD) < 10 || (now - doneT < 2000 && Math.abs(rd - doneD) < 300)) return;
  doneD = rd; doneT = now;
  if (rd < 5) { setDone(EMPTY); return; }
  let c = g.idx.slice(0, rd);
  if (c.length > 3000) {                    // давню частину проріджуємо, останні 600 точок — повністю
    const head = c.slice(0, c.length - 600), k = Math.ceil(head.length / 2400);
    c = head.filter((_, i) => i % k === 0).concat(c.slice(c.length - 600));
  }
  setDone({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } });
}

/* ---------- події на карті: Telegram, погода, тривоги ---------- */
const EV_ICON = {
  red: '<svg viewBox="0 0 24 24"><path d="M12 5v9" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><circle cx="12" cy="19" r="2" fill="#fff"/></svg>',
  yellow: '<svg viewBox="0 0 24 24"><path d="M12 6v7" stroke="#231a00" stroke-width="3.2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.9" fill="#231a00"/></svg>',
  green: '<svg viewBox="0 0 24 24"><path d="m6.5 12.5 3.6 3.6L17.8 8" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wx: '<svg viewBox="0 0 24 24"><path d="M7 17.5h10a4 4 0 0 0 .6-8 5.5 5.5 0 0 0-10.6 1.4A3.4 3.4 0 0 0 7 17.5Z" fill="currentColor"/></svg>',
  air: '<svg viewBox="0 0 24 24"><path d="M12 3 4 7v5c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V7Z" fill="currentColor"/><path d="M12 8v5" stroke="#f6bd16" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.5" fill="#f6bd16"/></svg>'
};
function evMarker(id, p, cls, icon, title) {
  let m = evMarks.get(id);
  if (m) { m.seen = true; return; }
  const el = document.createElement('button');
  el.className = 'evm ' + cls; el.innerHTML = icon; el.setAttribute('aria-label', title || '');
  el.addEventListener('click', e => { e.stopPropagation(); bus.emit('evTap', id); });
  m = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  m.seen = true; evMarks.set(id, m);
}
export function drawEvents() {
  if (!map) return;
  for (const m of evMarks.values()) m.seen = false;
  const now = Date.now();
  if (S.lookahead) {
    for (const it of feed.items) {
      if (it.filtered || !it.level || it.vote === -1 || it.lat == null || it.src === 'stop' || now - it.time > 3 * 3600e3) continue;
      const cls = (it.src === 'wx' ? 'wx ' : '') + it.level + (it.locKind === 'area' ? ' area' : '');
      evMarker(it.id, it, cls, it.src === 'wx' ? EV_ICON.wx : EV_ICON[it.level], it.sum || it.text);
    }
    if (S.air) for (const id of Object.keys(feed.air || {})) {
      const c = OBLAST_CENTER[id]; if (!c) continue;
      evMarker('air:' + id, { lat: c[0], lon: c[1] }, 'air', EV_ICON.air, oblastName(id));
    }
  }
  for (const [id, m] of evMarks) if (!m.seen) { m.remove(); evMarks.delete(id); }
}
export function showRoute(coords) {
  if (!map || !coords || coords.length < 2) return;
  const b = new maplibregl.LngLatBounds();
  const step = Math.max(1, Math.floor(coords.length / 400));
  for (let i = 0; i < coords.length; i += step) b.extend([coords[i][1], coords[i][0]]);
  b.extend([coords[coords.length - 1][1], coords[coords.length - 1][0]]);
  view.follow = false; view.lastTouch = Date.now() + 20000; bus.emit('view', view);
  const h = map.getContainer().clientHeight;
  map.fitBounds(b, { padding: { top: Math.round(h * 0.22), bottom: Math.round(h * 0.42), left: 40, right: 40 }, bearing: 0, pitch: 0, duration: 700, maxZoom: 15 });
}
// Маршрут, який ще лише планується (до «Поїхали»): малюємо без запуску ведення.
export function previewRoute(coords) {
  const src = map && map.getSource && map.getSource('route'); if (!src) return;
  src.setData(coords ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.map(c => [c[1], c[0]]) } } : EMPTY);
  doneD = -1; setDone(EMPTY);
  if (coords) showRoute(coords);
}
// Офлайн-карта України, якщо завантажена; інакше онлайн-стиль, вибраний у налаштуваннях.
export function currentStyle() { try { if (offlineActive()) return offlineStyle(); } catch (e) { log('warn', 'офлайн-стиль: ' + e.message); } return S.styleUrl; }
export function applyMapSource() { setMapStyle(currentStyle()); bus.emit('mapSource', offlineActive()); }
export function setMapStyle(url) {
  if (!map || !url) return;
  view.blank = false; doneD = -1;
  try { map.setStyle(url); } catch (e) { log('warn', 'стиль карти: ' + e.message); }
}
export function flyTo(p, zoom = 14) { if (!map) return; view.follow = false; view.lastTouch = Date.now(); bus.emit('view', view); map.easeTo({ center: [p.lon, p.lat], zoom, pitch: 0, bearing: 0, duration: 600 }); }

function drawPoi() {
  const src = map && map.getSource && map.getSource('poi'); if (!src) return;
  const f = [];
  if (S.cams) for (const c of poi.cams) f.push({ type: 'Feature', properties: { k: 'cam' }, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } });
  if (S.stops) for (const s of poi.stops) if (s.score >= 2) f.push({ type: 'Feature', properties: { k: 'stop' }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
  src.setData({ type: 'FeatureCollection', features: f });
}

/* ---------- довге натискання: вибір точки на карті ---------- */
function setupLongPress() {
  let tm = null, start = null;
  const cancel = () => { clearTimeout(tm); tm = null; };
  map.on('touchstart', e => {
    cancel(); if (e.originalEvent.touches.length !== 1) return;
    start = e.point;
    tm = setTimeout(() => { tm = null; bus.emit('mapPick', { lat: e.lngLat.lat, lon: e.lngLat.lng }); }, 650);
  });
  map.on('touchmove', e => { if (tm && start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > 12) cancel(); });
  map.on('touchend', cancel); map.on('touchcancel', cancel);
  map.on('contextmenu', e => bus.emit('mapPick', { lat: e.lngLat.lat, lon: e.lngLat.lng }));
}
export function showPick(p) {
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  if (p && map) pickMarker = new maplibregl.Marker({ element: wpEl('wp-pick', ''), anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map);
}

/* ---------- завантаження карти вздовж маршруту для офлайну ---------- */
const xy = (lat, lon, z) => {
  const n = 2 ** z, la = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n)];
};
export async function prefetchRoute(idx, onProgress, ctl) {
  const style = map.getStyle(), sources = [], urls = [], seen = new Set();
  for (const [id, src] of Object.entries(style.sources || {})) {
    if (src.type !== 'vector' && src.type !== 'raster') continue;
    const live = map.getSource(id), tiles = (live && live.tiles) || src.tiles;
    if (!tiles || !tiles[0]) continue;
    sources.push({ tpl: tiles[0], min: (live && live.minzoom) ?? src.minzoom ?? 0, max: (live && live.maxzoom) ?? src.maxzoom ?? 14, vec: src.type === 'vector' });
  }
  if (!sources.length) throw new Error('nosource');
  const pts = []; for (let d = 0; d <= idx.total; d += 400) pts.push(idx.at(d)); pts.push(idx.at(idx.total));
  const push = (tpl, z, x, y) => { const u = tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y); if (!seen.has(u)) { seen.add(u); urls.push(u); } };
  for (const s of sources) for (let z = Math.max(s.min, 3); z <= Math.min(s.max, 14); z++) for (const p of pts) { const [x, y] = xy(p.lat, p.lon, z); push(s.tpl, z, x, y); }
  for (const s of sources) if (s.vec) for (let z = 12; z <= Math.min(s.max, 14); z++) for (const p of pts) {
    const [x, y] = xy(p.lat, p.lon, z);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) push(s.tpl, z, x + dx, y + dy);
  }
  if (style.glyphs) {                                   // шрифти підписів: латиниця, кирилиця, пунктуація
    const stacks = new Set();
    for (const l of style.layers || []) { const f = l.layout && l.layout['text-font']; if (Array.isArray(f) && f.every(x => typeof x === 'string')) stacks.add(f.join(',')); }
    for (const st of stacks) for (const r of ['0-255', '256-511', '1024-1279', '8192-8447']) urls.unshift(style.glyphs.replace('{fontstack}', st).replace('{range}', r));
  }
  // Правила OpenFreeMap для офлайн-завантажень: до 3000 тайлів або 50 МБ за раз, не більше 4 запитів одночасно.
  const list = urls.slice(0, 2900), total = list.length;
  let i = 0, done = 0, bytes = 0, fail = 0;
  const worker = async () => {
    while (i < total && bytes < 48e6 && !(ctl && ctl.stop)) {
      const u = list[i++];
      try { bytes += await fetchToCache(u); } catch (_) { fail++; }
      done++; if (onProgress && done % 10 === 0) onProgress(done, total, bytes);
      if (fail > 40 && fail > done * 0.5) { ctl && (ctl.stop = true); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (onProgress) onProgress(done, total, bytes);
  return { done, total, bytes, fail, cut: urls.length > total };
}
export async function cacheInfo() { return { count: await db.count('c') }; }
export async function clearCache() { await db.clear('c'); }
