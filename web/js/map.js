// Карта: MapLibre + кеш тайлів у пам'яті телефону (офлайн), маршрут, позначка машини, камери, зупинки.
import { PT_SVG } from './pticons.js';
import { bus, log, S, db, isNight, clamp, sleep, sideLayout } from './core.js';
import { pos, routeCps } from './nav.js';
import { g } from './guide.js';
import { poi } from './poi.js';
import { feed, relevance, zoneRegions } from './feed.js';
import { OBLAST_CENTER, oblastName, viasOf } from './route.js';
import { off, offlineActive, offlineStyle, tilesBad, tileBytesAt } from './offline.js';
import { houseLayer, HOUSE_Z } from './addr.js';
export { HOUSE_Z };
import { sdb, TYPES, SHOWER_COLOR } from './stopsdb.js';
import * as showers from './showers.js';
import { routeCats, hazardsAlong, hazardText, indexOf } from './roads.js';
import * as rough from './rough.js';
import { vp, onMap as vpOnMap } from './vplaces.js';
import { reps, REP_SVG, shown as repShown, repStamp } from './reports.js';
import * as P from './platform.js';
import { shownPts, recording as jrLive, segments as jrSegments, geojson as jrGeo, SPEED_COLORS } from './journey.js';

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
let previewCoords = null, previewR = null;
const lineOf = coords => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.map(c => [c[1], c[0]]) } });
// Маршрут шматками за категорією доріг: М/Н — синій, Р/Т — бірюзовий, місцеві дороги й вулиці — фіолетовий.
function routeData(coords, route) {
  const rc = S.routeCats !== false && route ? routeCats(route) : null;
  if (!rc) return lineOf(coords);
  const f = [];
  for (const s of rc.segs) {
    const cs = coords.slice(s.i0, s.i1 + 1);
    if (cs.length >= 2) f.push({ type: 'Feature', properties: { c: s.c }, geometry: { type: 'LineString', coordinates: cs.map(c => [c[1], c[0]]) } });
  }
  return f.length ? { type: 'FeatureCollection', features: f } : lineOf(coords);
}
export const ROUTE_COLORS = { a: '#2f6bff', b: '#0f9f9a', c: '#8b5cf6' };
let puck = null, puckEl = null, wps = [], hzMarks = [], pickMarker = null, styleTimer = null, doneD = -1, doneT = 0;
const evMarks = new Map(), vpMarks = new Map(), repMarks = new Map();
// Позначки водіїв (ДТП, поліція, транспортна служба): значок у кружечку, під ним — дата й час (після підтвердження — новий,
// з галочкою). Торкнутися — що й коли. Вимкнені в «Що показувати на карті» — не малюємо.
export function drawReports() {
  if (!map) return;
  const keep = new Set(), on = S.mapReports !== false;
  if (on) for (const r of repShown()) {
    keep.add(r.id);
    const lbl = (r.conf ? '✓ ' : '') + repStamp(r);
    if (repMarks.has(r.id)) { const m = repMarks.get(r.id), tt = m.getElement().querySelector('.rpm-t'); if (tt && tt.textContent !== lbl) tt.textContent = lbl; continue; }
    const el = document.createElement('button'); el.className = 'rpm rpm-' + r.t; el.innerHTML = (REP_SVG[r.t] || '') + '<span class="rpm-t"></span>'; el.dataset.rep = r.id;
    el.querySelector('.rpm-t').textContent = lbl;
    el.addEventListener('click', e => { if (tapHook) return; e.stopPropagation(); bus.emit('repTap', r.id); });
    repMarks.set(r.id, new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([r.lon, r.lat]).addTo(map));
  }
  for (const [id, m] of repMarks) if (!keep.has(id)) { m.remove(); repMarks.delete(id); }
  if (askM && !keep.has(askM._rid)) askHide();
}
// «Поліція ще тут?» — маленька бульбашка над самою позначкою, дві великі кнопки. Сама зникає за 20 с.
let askM = null, askT = 0;
export function askShow(r, onAnswer) {
  if (!map) return;
  askHide();
  const el = document.createElement('div'); el.className = 'rpq';
  el.innerHTML = `<b></b><div><button class="rpq-y" data-ra="y"></button><button class="rpq-n" data-ra="n"></button></div>`;
  el.querySelector('b').textContent = onAnswer.q; el.querySelector('.rpq-y').textContent = onAnswer.yes; el.querySelector('.rpq-n').textContent = onAnswer.no;
  el.addEventListener('click', e => { e.stopPropagation(); const b = e.target.closest('[data-ra]'); if (!b) return; askHide(); onAnswer.fn(b.dataset.ra === 'y'); });
  askM = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -26] }).setLngLat([r.lon, r.lat]).addTo(map); askM._rid = r.id;
  clearTimeout(askT); askT = setTimeout(askHide, 20000);
}
export function askHide() { clearTimeout(askT); if (askM) { askM.remove(); askM = null; } }
// Приціл для позначки: поки він увімкнений, дотик до карти — це місце позначки (а не вибір точки маршруту)
// (1.1.34) Дотик до сірого варіанта маршруту робить його вибраним — як у Google Maps. Раніше спрацьовував лише точний дотик
// у саму лінію (7 px) — пальцем туди майже не влучити. Тепер шукаємо варіанти в колі ±22 px від пальця й беремо найближчий;
// там, де варіант іде спільною дорогою з вибраним (лінії лежать одна на одній), лишаємо вибраний.
const ALT_TOL = 22;
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const k = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy);
}
function featDist(f, pt) {
  const g = f.geometry; if (!g) return Infinity;
  const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  let best = Infinity;
  for (const ln of lines) {
    let prev = null;
    for (const c of ln) { const q = map.project(c); if (prev) best = Math.min(best, segDist(pt, prev, q)); else best = Math.min(best, Math.hypot(pt.x - q.x, pt.y - q.y)); prev = q; }
  }
  return best;
}
// (1.1.34) Контрольний поворот на карті без GPS — дотик пальцем у радіусі 26 px від кружечка (сам кружечок 6–14 px)
export function cpAt(point) {
  if (!map || !map.getLayer || !map.getLayer('cps-dot') || !point || pos.mode !== 'dr') return null;
  let fs = []; try { fs = map.queryRenderedFeatures([[point.x - 26, point.y - 26], [point.x + 26, point.y + 26]], { layers: ['cps-dot'] }); } catch (_) { return null; }
  let best = null, bd = Infinity;
  for (const f of fs) { const q = map.project(f.geometry.coordinates), d = Math.hypot(q.x - point.x, q.y - point.y); if (d < bd && d <= 26) { bd = d; best = f.properties.d; } }
  return best;
}
export function altAt(point) {
  if (!map || !map.getLayer || !map.getLayer('route-alts') || !point) return null;
  const box = [[point.x - ALT_TOL, point.y - ALT_TOL], [point.x + ALT_TOL, point.y + ALT_TOL]];
  const layers = ['route-alts', 'route-line', 'route-sel'].filter(id => map.getLayer(id));
  let fs = []; try { fs = map.queryRenderedFeatures(box, { layers }); } catch (_) { return null; }
  let k = null, altD = Infinity, mainD = Infinity;
  for (const f of fs) {
    const d = featDist(f, point);
    if (f.layer && f.layer.id === 'route-alts') { if (d < altD) { altD = d; k = f.properties ? f.properties.k : null; } }
    else mainD = Math.min(mainD, d);
  }
  if (k == null || altD > ALT_TOL) return null;
  if (mainD <= altD + 3) return null;              // спільна дорога: палець однаково близько до обох — лишаємо вибраний
  return k;
}
let tapHook = null, lpT = 0;                 // lpT — коли востаннє спрацювало довге натискання
export function setTapHook(fn) { tapHook = fn || null; document.body.classList.toggle('aiming', !!tapHook); }
export const aiming = () => !!tapHook;
export function screenToGeo(x, y) { if (!map) return null; const p = map.unproject([x, y]); return { lat: p.lat, lon: p.lng }; }
// Перевірене місце: маленький бургер із золотою зіркою — відрізняється від кольорових кружечків піт-стопів
const VP_ICON = { food: '<svg viewBox="0 0 32 32"><path d="M6 14a10 7 0 0 1 20 0z" fill="#f5a524"/><circle cx="12" cy="10" r=".9" fill="#fff6d6"/><circle cx="17" cy="8.6" r=".9" fill="#fff6d6"/><circle cx="20.5" cy="11" r=".9" fill="#fff6d6"/><path d="M5.5 15.6q2.6 1.8 5.2 0t5.3 0 5.3 0 5.2 0" stroke="#3fae49" stroke-width="2.2" fill="none" stroke-linecap="round"/><rect x="6" y="17.4" width="20" height="3.6" rx="1.8" fill="#7a2e12"/><path d="M6.5 22.4h19a1.5 1.5 0 0 1-1.6 3.1H8.1a1.5 1.5 0 0 1-1.6-3.1z" fill="#f5a524"/></svg>' };
VP_ICON.complex = VP_ICON.park = '<svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="22" rx="5" fill="#1f6feb"/><path d="M12.5 22.5V9.5h5a4 4 0 0 1 0 8h-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const VP_STAR = '<i class="vpm-star"><svg viewBox="0 0 24 24"><path d="M12 3.2l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L12 16.5l-5.3 2.9 1.2-5.9L3.4 9.4l6-.7z" fill="#fff"/></svg></i>';
export function drawVerified() {
  if (!map) return;
  const on = S.mapVerified !== false, keep = new Set();
  if (on) for (const p of vp.list) {
    if (!vpOnMap(p)) continue;
    keep.add(p.id);
    if (vpMarks.has(p.id)) { vpMarks.get(p.id).setLngLat([p.lon, p.lat]); continue; }
    const el = document.createElement('button');
    el.className = 'vpm'; el.innerHTML = (VP_ICON[p.kind] || VP_ICON.food) + VP_STAR; el.setAttribute('aria-label', p.name);
    el.addEventListener('click', e => { if (tapHook) return; e.stopPropagation(); bus.emit('vpTap', p.id); });
    vpMarks.set(p.id, new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(map));
  }
  for (const [id, m] of vpMarks) if (!keep.has(id)) { m.remove(); vpMarks.delete(id); }
}
const EMPTY = { type: 'FeatureCollection', features: [] };

export function initMap() {
  maplibregl.addProtocol('fc', cacheProtocol);
  map = new maplibregl.Map({
    container: 'map', style: currentStyle(), center: [31.3, 49.0], zoom: 5.4,
    attributionControl: false, maxPitch: 60, fadeDuration: 120,
    // мережеві запити карти йдуть через кеш у телефоні; власні файли застосунку — напряму
    // супутникові знімки — напряму (власний кеш у IndexedDB без межі розміру розрісся б на сотні МБ; WebView кешує їх сам)
    transformRequest: url => /^https?:\/\//.test(url) && !url.startsWith(location.origin) && !isSatUrl(url) ? { url: 'fc://' + url } : undefined
  });
  const seenErr = new Set();
  map.on('error', e => {
    const m = (e && e.error && e.error.message) || 'map error';
    if (!seenErr.has(m) && seenErr.size < 20) { seenErr.add(m); log('warn', 'карта: ' + m); }
  });
  map.on('style.load', addLayers);
  map.on('click', e => {
    if (tapHook) { tapHook({ lat: e.lngLat.lat, lon: e.lngLat.lng }); return; }
    // довге натискання щойно відкрило меню точки — відпущений палець не є ще й дотиком до повороту чи сірої лінії
    if (Date.now() - lpT > 1200) {
      { const d = cpAt(e.point); if (d != null) { bus.emit('cpTap', d); return; } }
      { const k = altAt(e.point); if (k != null) { bus.emit('altTap', k); return; } }
    }
    if (jv && jvTap) { const q = map.unproject([e.point.x + 1, e.point.y]), px = Math.abs(q.lng - e.lngLat.lng) * 111320 * Math.cos(e.lngLat.lat * Math.PI / 180); jvTap({ lat: e.lngLat.lat, lon: e.lngLat.lng, px }); }
  });
  map.on('styleimagemissing', e => {
    if (map.hasImage(e.id)) return;
    try { const f = e.id === 'cam-ico' ? camImage() : e.id.startsWith('fuel:') ? fuelImage(e.id.slice(5)) : null; if (f) map.addImage(e.id, f.img, { pixelRatio: f.dpr }); } catch (_) {}
  });
  // запасна страховка: якщо стиль змінився, а наших шарів немає — повертаємо їх
  map.on('styledata', () => { if (map.isStyleLoaded() && !map.getSource('route')) addLayers(); });
  // Стиль не завантажився (немає мережі й кешу) — показуємо хоча б маршрут на порожньому тлі.
  styleTimer = setTimeout(() => { if (!map.isStyleLoaded() && !map.getSource('route')) { view.blank = true; map.setStyle(BLANK); bus.emit('mapBlank', true); } }, 12000);
  map.on('movestart', e => { if (e.originalEvent) { view.follow = false; view.lastTouch = Date.now(); bus.emit('view', view); } });
  // Палець на карті — камера не смикається за машиною, інакше на повільному телефоні чи великому екрані
  // плавне «стеження» щосекунди перериває жест і карту не вдається зсунути.
  const cont = map.getCanvasContainer(), down = () => { view.down = true; view.touchT = Date.now(); }, up = () => { if (view.down) { view.down = false; view.touchT = Date.now(); } };
  cont.addEventListener('pointerdown', down, true); cont.addEventListener('touchstart', down, { capture: true, passive: true });
  for (const ev of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) window.addEventListener(ev, up, true);
  map.on('moveend', e => { if (e.originalEvent) view.lastTouch = Date.now(); });
  map.on('pitch', () => bus.emit('tilt', Math.round(map.getPitch())));
  map.on('pitchend', e => { if (e.originalEvent && pitchLive == null) tiltCommit(Math.round(map.getPitch())); });
  setupLongPress();
  puckEl = document.createElement('div'); puckEl.className = 'puck';
  puckEl.innerHTML = '<svg viewBox="0 0 48 48"><path class="puck-halo" d="M24 3 42 43 24 34 6 43Z"/><path class="puck-body" d="M24 8 37.5 38 24 31 10.5 38Z"/></svg>';
  puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'map' });
  bus.on('pos', onPos);
  const attr = document.getElementById('attr');
  if (attr) {
    attrBase = attr.textContent.trim(); attr.dataset.full = attrBase;
    attr.textContent = 'ⓘ'; attr.title = attrBase;
    attr.onclick = () => { const full = attr.dataset.full; attr.classList.toggle('open'); attr.textContent = attr.classList.contains('open') ? full : 'ⓘ'; clearTimeout(attr._t); if (attr.classList.contains('open')) attr._t = setTimeout(() => { attr.classList.remove('open'); attr.textContent = 'ⓘ'; }, 6000); };
  }
  bus.on('route', drawRoute);
  bus.on('hazards', drawHazards);
  bus.on('rough', drawRough);
  bus.on('marks', drawMarks);
  bus.on('settings', k => { if (k === 'mapStopTypes' || k === 'mapStops') drawMarks(); if (k === 'mapEvents') drawEvents(); if (k === 'mapHazards') drawHazards(); if (k === 'cams') drawStops(); });
  bus.on('settings', k => { if (k === 'roughMap') drawRough(); });
  bus.on('settings', k => { if (k === 'routeCats' || k === 'passed') drawRoute(); if (k === 'truck') drawHazards(); });
  bus.on('guide', drawProgress);
  bus.on('poi', drawPoi);
  bus.on('feed', drawEvents);
  bus.on('vplaces', drawVerified);
  bus.on('reports', drawReports); bus.on('settings', k => { if (k === 'mapVerified') drawVerified(); if (k === 'mapReports') drawReports(); });
  bus.on('stopsdb', drawStops);
  bus.on('journey', drawJourney); bus.on('view', jrPaint); bus.on('settings', k => { if (k === 'mapType') jrPaint(); });
  bus.on('settings', k => { if (k === 'mapStops' || k === 'mapStopTypes') drawStops(); });
  map.on('render', () => { if (!labTimer) labTimer = setTimeout(labelDots, LAB_EVERY); });
  map.on('idle', () => { clearTimeout(labTimer); labTimer = null; labelDots(); });
  setInterval(drawEvents, 60000);
  bus.on('settings', k => { if (k === 'theme') applyTheme(); if (k === 'view3d') follow(true); });
  bus.on('settings', k => { if (k === 'mapType' || k === 'satUrl') applySat(true); });
  window.addEventListener('online', () => applySat(false)); window.addEventListener('offline', () => applySat(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { cam.anc = null; follow(true); } });
  window.addEventListener('resize', () => { cam.anc = null; if (view.follow) follow(true); });
  setInterval(() => {
    applyTheme();
    if (!view.follow && S.autoCenter && !jv && Date.now() - view.lastTouch > 12000 && (g.active || pos.spd > 3)) setFollow(true);   // поїздку з архіву роздивляються скільки треба
  }, 3000);
  applyTheme();
  return map;
}

/* ---------- (1.1.25) пройдений шлях ---------- */
const JR_DAY = '#5d6a7c', JR_NIGHT = '#b6c1d2';
let jrNight = null;
function jrPaint() {
  if (!map || !map.getLayer || !map.getLayer('jr-line')) return;
  // Уночі звичайну карту «перевертає» фільтр (світле стає темним) — разом із нею й нашу лінію: темно-сіра сама стає світлою.
  // Світлий колір потрібен лише там, де карта темна без фільтра: супутник і нічна офлайн-карта.
  const dark = satOn() || nativeDark(); if (dark === jrNight) return; jrNight = dark;
  for (const id of ['jr-line', 'jr-est']) { try { map.setPaintProperty(id, 'line-color', dark ? JR_NIGHT : JR_DAY); map.setPaintProperty(id, 'line-opacity', dark ? 0.55 : 0.5); } catch (_) {} }
}
// Лінія рейсу, що йде (або щойно завершеного, поки не відповіли «зберегти?»). Давню частину довгого шляху проріджуємо.
function drawJourney() {
  const src = map && map.getSource && map.getSource('jr'); if (!src) return;
  let p = shownPts(); if (!p || p.length < 2) { src.setData(EMPTY); return; }
  if (p.length > 3000) { const head = p.slice(0, p.length - 600), k = Math.ceil(head.length / 2400); p = head.filter((x, i) => i % k === 0 || (i > 0 && head[i - 1][4] !== x[4])).concat(p.slice(p.length - 600)); }
  // рейс іде — лінію дотягуємо до самої машини (нова точка пишеться раз на 25 м, а стрілка вже попереду)
  if (jrLive() && pos.lat != null) { const l = p[p.length - 1]; if (Math.abs(l[0] - pos.lat) + Math.abs(l[1] - pos.lon) > 2e-5) p = p.concat([[pos.lat, pos.lon, l[2], l[3], pos.mode === 'gps' ? 0 : 1]]); }
  src.setData(jrGeo(jrSegments(p, false)));
}
// Поїздка з архіву на карті: лінія кольором за швидкістю, старт і фініш, позначка вибраної точки
let jv = null, jvMarks = [], jvSel = null;
const jvDot = (cls, txt) => { const el = document.createElement('div'); el.className = 'jv-pin ' + cls; el.textContent = txt || ''; return el; };
function drawJv() {
  const src = map && map.getSource && map.getSource('jv'); if (!src) return;
  for (const m of jvMarks) m.remove(); jvMarks = [];
  if (!jv) { src.setData(EMPTY); return; }
  src.setData(jrGeo(jrSegments(jv.pts, true)));
  const a = jv.pts[0], b = jv.pts[jv.pts.length - 1];
  jvMarks.push(new maplibregl.Marker({ element: jvDot('a', 'A') }).setLngLat([a[1], a[0]]).addTo(map), new maplibregl.Marker({ element: jvDot('b', 'Б') }).setLngLat([b[1], b[0]]).addTo(map));
}
/** Показати поїздку з архіву (pts — [[lat, lon, t, v, m], …]) або прибрати (null). Допоміжні позначки карти на цей час ховаємо. */
let jvClean = false;
export function showJourney(pts) {
  const was = !!jv; jv = pts && pts.length > 1 ? { pts } : null;
  if (jv && !was) { jvClean = clean; setClean(true); } else if (!jv && was) setClean(jvClean);
  if (!jv) journeyMark(null);
  drawJv();
}
export const journeyShown = () => !!jv;
/** Уся поїздка — у вільній частині карти (між верхом екрана й карткою знизу). */
export function fitJourney(padTop, padBottom) { if (jv) fitRoutes([jv.pts.map(p => [p[0], p[1]])], padTop, padBottom, 34); }
/** Позначка вибраної точки шляху (p — [lat, lon, …]) або прибрати (null). */
export function journeyMark(p) {
  if (jvSel) { jvSel.remove(); jvSel = null; }
  if (p && map) jvSel = new maplibregl.Marker({ element: jvDot('sel') }).setLngLat([p[1], p[0]]).addTo(map);
}
/** Дотик до карти під час перегляду поїздки: fn({ lat, lon, px }) — px: скільки метрів в одному пікселі тут (щоб зрозуміти, чи влучили в лінію). */
let jvTap = null;
export function onJourneyTap(fn) { jvTap = fn || null; }

/* ---------- чиста карта для екранів маршруту ---------- */
// Вибір варіанта маршруту і «Маршрут» у дорозі відкриваються без допоміжних позначок (піт-стопи, плашки АЗС, камери,
// події, перевірені місця, позначки водіїв, проблемні місця): видно лише дороги, області й сам маршрут із точками А, Б, С.
// Кнопкою на тих екранах позначки можна повернути.
const AUX_LAYERS = ['stops-major', 'stops-all', 'cams-ico', 'fuel-label', 'poi-dot', 'poi-cam', 'marks-dot', 'rough-dot'];
let clean = false;
export function setClean(on) {
  clean = !!on; document.body.classList.toggle('map-clean', clean);     // DOM-позначки (.rpm, .vpm, .evm, .hzm) ховає CSS
  if (!map) return;
  for (const id of AUX_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', clean ? 'none' : 'visible');
}
export const isClean = () => clean;

/* ---------- кружечок не потрібен, коли назву вже видно ---------- */
// Наближено над АЗС стоїть плашка з назвою мережі, а біля кафе, мотелю чи стоянки карта сама пише назву.
// Кружечок поруч із назвою лише рябить — ховаємо його (натиснути на місце можна, як і раніше).
// Віддалили — назв на карті вже немає, і кружечки повертаються.
const LAB_EVERY = 300, LAB_HOLD = 900, LAB_R = 60;      // як часто перевіряти; скільки тримати схованим, коли назва зникла на мить; радіус пошуку назви, пікселі
const labSeen = new Map(), labHid = new Set();         // номер точки → коли востаннє бачили її назву; сховані кружечки
let labTimer = null, poiLy = null;
const normName = s => String(s || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const sameName = (a, b) => a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b));
// шари підписів місць базової карти (OpenFreeMap — source-layer «poi», офлайн-карта Protomaps — «pois»), без наших
function poiLayers() {
  if (poiLy) return poiLy.filter(id => map.getLayer(id));
  poiLy = [];
  try { for (const l of map.getStyle().layers || []) if (l.type === 'symbol' && (l['source-layer'] === 'poi' || l['source-layer'] === 'pois' || /^pois?[_-]|^pois$/.test(l.id)) && l.id !== 'poi-dot') poiLy.push(l.id); } catch (_) {}
  return poiLy;
}
export function labelDots() {
  labTimer = null;
  if (!map || !map.getLayer('stops-all') || !map.getSource('stops')) return;
  const now = performance.now(), seen = i => { if (i != null) labSeen.set(+i, now); };
  if (map.getZoom() >= 9.5 && S.mapStops !== false) {
    try {
      if (map.getLayer('fuel-label')) for (const f of map.queryRenderedFeatures({ layers: ['fuel-label'] })) seen(f.properties.i);
      const pl = poiLayers();
      if (pl.length) {
        const labels = [];
        for (const f of map.queryRenderedFeatures({ layers: pl })) {
          if (!f.geometry || f.geometry.type !== 'Point') continue;
          const pr = f.properties || {}, n = normName(pr['name:uk'] || pr.name || pr.name_int || '');
          if (n) labels.push({ p: map.project(f.geometry.coordinates), n });
        }
        if (labels.length) for (const f of map.queryRenderedFeatures({ layers: ['stops-all'] })) {
          const i = f.properties.i, r = sdb.rows[i], n = normName(r && r[4]); if (!n) continue;
          const p = map.project(f.geometry.coordinates);
          if (labels.some(l => Math.abs(l.p.x - p.x) < LAB_R && Math.abs(l.p.y - p.y) < LAB_R && sameName(l.n, n))) seen(i);
        }
      }
    } catch (_) {}
  }
  let pending = false;
  for (const [i, ts] of labSeen) {
    const hide = now - ts < LAB_HOLD;
    if (hide) { if (ts < now) pending = true; if (!labHid.has(i)) { labHid.add(i); map.setFeatureState({ source: 'stops', id: i }, { lab: true }); } }
    else { labSeen.delete(i); if (labHid.delete(i)) map.setFeatureState({ source: 'stops', id: i }, { lab: false }); }
  }
  if (pending && !labTimer) labTimer = setTimeout(labelDots, LAB_HOLD);   // назва зникла, а карта стоїть — перевірити ще раз і повернути кружечок
}
export const hiddenDots = () => [...labHid];

// Плашка АЗС: значок колонки + назва мережі; колір — наш, за назвою (не фірмовий)
const FUEL_COL = ['#0f766e', '#1d4ed8', '#7c3aed', '#b45309', '#be123c', '#047857', '#4338ca', '#0e7490', '#a16207', '#334155'];
// Камера фіксації — значок фотоапарата в білому колі з червоним обідком (як знак): одразу зрозуміло, що це камера,
// а не червона крапка. Малюємо самі на полотні — працює й офлайн, без шрифтів і картинок карти.
function camImage() {
  const dpr = 2, D = 30 * dpr, c = document.createElement('canvas'), x = c.getContext('2d'), m = D / 2;
  c.width = D; c.height = D;
  x.beginPath(); x.arc(m, m, m - 1.5 * dpr, 0, Math.PI * 2); x.fillStyle = '#ffffff'; x.fill();
  x.lineWidth = 3.2 * dpr; x.strokeStyle = '#e5484d'; x.stroke();
  const rr = (X, Y, W, H, R) => { x.beginPath(); x.moveTo(X + R, Y); x.lineTo(X + W - R, Y); x.quadraticCurveTo(X + W, Y, X + W, Y + R); x.lineTo(X + W, Y + H - R); x.quadraticCurveTo(X + W, Y + H, X + W - R, Y + H); x.lineTo(X + R, Y + H); x.quadraticCurveTo(X, Y + H, X, Y + H - R); x.lineTo(X, Y + R); x.quadraticCurveTo(X, Y, X + R, Y); x.closePath(); };
  const bw = 17 * dpr, bh = 11.5 * dpr, bx = m - bw / 2, by = m - bh / 2 + 1.2 * dpr;
  x.fillStyle = '#1f2937';
  rr(m - 3.6 * dpr, by - 2.8 * dpr, 7.2 * dpr, 3.6 * dpr, 1 * dpr); x.fill();          // видошукач
  rr(bx, by, bw, bh, 2.4 * dpr); x.fill();                                                 // корпус
  x.beginPath(); x.arc(m, by + bh / 2, 3.9 * dpr, 0, Math.PI * 2); x.fillStyle = '#ffffff'; x.fill();   // об'єктив
  x.beginPath(); x.arc(m, by + bh / 2, 2.3 * dpr, 0, Math.PI * 2); x.fillStyle = '#1f2937'; x.fill();
  x.beginPath(); x.arc(bx + bw - 2.8 * dpr, by + 2.6 * dpr, 1.2 * dpr, 0, Math.PI * 2); x.fillStyle = '#e5484d'; x.fill();   // вогник запису
  return { img: x.getImageData(0, 0, D, D), dpr };
}
function fuelImage(nm) {
  const dpr = 2, fs = 15 * dpr, pad = 7 * dpr, ico = 14 * dpr, h = 26 * dpr;
  const c = document.createElement('canvas'), x = c.getContext('2d');
  x.font = `800 ${fs}px Roboto, "Segoe UI", system-ui, sans-serif`;
  const w = Math.ceil(pad + ico + 4 * dpr + x.measureText(nm).width + pad), tail = 5 * dpr;
  c.width = w; c.height = h + tail;
  x.font = `800 ${fs}px Roboto, "Segoe UI", system-ui, sans-serif`;     // зміна розміру полотна скидає шрифт — ставимо знову
  let hsh = 0; for (const ch of nm) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  const col = nm === 'Газ' ? '#6b7280' : nm === 'АЗС' ? '#374151' : FUEL_COL[hsh % FUEL_COL.length];
  const r = 7 * dpr;
  x.fillStyle = col; x.strokeStyle = '#ffffff'; x.lineWidth = 2 * dpr;
  x.beginPath(); x.moveTo(r, 1); x.lineTo(w - r, 1); x.quadraticCurveTo(w - 1, 1, w - 1, r); x.lineTo(w - 1, h - r); x.quadraticCurveTo(w - 1, h - 1, w - r, h - 1);
  x.lineTo(w / 2 + tail, h - 1); x.lineTo(w / 2, h + tail - 1); x.lineTo(w / 2 - tail, h - 1);
  x.lineTo(r, h - 1); x.quadraticCurveTo(1, h - 1, 1, h - r); x.lineTo(1, r); x.quadraticCurveTo(1, 1, r, 1); x.closePath(); x.fill(); x.stroke();
  // колонка
  const ix = pad, iy = (h - ico) / 2; x.fillStyle = '#ffffff';
  x.fillRect(ix, iy, ico * 0.62, ico); x.fillStyle = col; x.fillRect(ix + ico * 0.12, iy + ico * 0.14, ico * 0.38, ico * 0.3); x.fillStyle = '#ffffff';
  x.fillRect(ix + ico * 0.7, iy + ico * 0.25, ico * 0.14, ico * 0.6);
  x.fillStyle = '#ffffff'; x.textBaseline = 'middle'; x.fillText(nm, pad + ico + 4 * dpr, h / 2 + dpr);
  return { img: x.getImageData(0, 0, c.width, c.height), dpr };
}
function addLayers() {
  clearTimeout(styleTimer);
  if (map.getSource('route')) return;
  try { if (!map.hasImage('cam-ico')) { const ci = camImage(); map.addImage('cam-ico', ci.img, { pixelRatio: ci.dpr }); } } catch (_) {}
  const w = (a, b, c) => ['interpolate', ['linear'], ['zoom'], 6, a, 12, b, 17, c];
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addSource('route-alts', { type: 'geojson', data: EMPTY });
  map.addSource('route-sel', { type: 'geojson', data: EMPTY });     // (1.1.28) новий маршрут у дорозі: вибраний варіант
  map.addSource('route-done', { type: 'geojson', data: EMPTY });
  // короткий шматок біля стрілки (до ~700 м): оновлюється разом зі стрілкою, тож лінія зникає під нею плавно, а не стрибками
  map.addSource('route-near', { type: 'geojson', data: EMPTY });
  map.addSource('done-near', { type: 'geojson', data: EMPTY });
  map.addSource('poi', { type: 'geojson', data: EMPTY });
  map.addSource('stops', { type: 'geojson', data: EMPTY });
  map.addSource('acc', { type: 'geojson', data: EMPTY });
  map.addSource('route-bad', { type: 'geojson', data: EMPTY });
  map.addSource('rough', { type: 'geojson', data: EMPTY });
  map.addSource('marks', { type: 'geojson', data: EMPTY });
  map.addSource('cps', { type: 'geojson', data: EMPTY });
  map.addSource('plan-line', { type: 'geojson', data: EMPTY });
  map.addSource('jr', { type: 'geojson', data: EMPTY });      // (1.1.25) пройдений шлях рейсу, що йде, — бліда лінія
  map.addSource('jv', { type: 'geojson', data: EMPTY });      // поїздка з архіву — кольором за швидкістю
  // Лінії рейсу кладемо під підписи карти: назви вулиць і міст читаються поверх синьої лінії, як у звичних навігаторах.
  // Наші значки (АЗС, стоянки, позначки) лишаються згори.
  const under = firstSymbolId();
  // Лабораторія: якість покриття за власними замірами — маленькі кольорові крапки на дорозі
  map.addLayer({ id: 'rough-dot', type: 'circle', source: 'rough', minzoom: 10.5, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1.6, 14, 3.5, 17, 6],
    'circle-color': ['match', ['get', 'l'], 'r', '#e5484d', 'y', '#f6bd16', '#2f9e62'], 'circle-opacity': 0.85 } }, under);
  // (1.1.25) Пройдений шлях — бліда лінія під маршрутом: де їхали насправді, від старту (перебудова маршруту її не стирає).
  // Суцільна — за GPS, пунктир — без GPS (розрахунок). Колір — у jrPaint(): удень темніший, уночі світліший.
  map.addLayer({ id: 'jr-line', type: 'line', source: 'jr', filter: ['!=', ['get', 'e'], 1], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': JR_DAY, 'line-opacity': 0.5, 'line-width': w(2.5, 4.5, 9) } }, under);
  map.addLayer({ id: 'jr-est', type: 'line', source: 'jr', filter: ['==', ['get', 'e'], 1], layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: { 'line-color': JR_DAY, 'line-opacity': 0.5, 'line-width': w(2.5, 4.5, 9), 'line-dasharray': [1.6, 1.2] } }, under);
  // інші варіанти маршруту — сірі під основним; дотик вибирає варіант
  map.addLayer({ id: 'route-alts-case', type: 'line', source: 'route-alts', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#2b3240', 'line-width': w(7, 10, 16) } }, under);
  map.addLayer({ id: 'route-alts', type: 'line', source: 'route-alts', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#a3adbd', 'line-width': w(4, 7, 12) } }, under);
  const casePaint = { 'line-color': '#0c2a6e', 'line-width': w(5, 9, 17) }, linePaint = { 'line-color': ['match', ['get', 'c'], 'b', ROUTE_COLORS.b, 'c', ROUTE_COLORS.c, ROUTE_COLORS.a], 'line-width': w(3, 6, 12) };
  map.addLayer({ id: 'route-case', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: casePaint }, under);
  map.addLayer({ id: 'route-near-case', type: 'line', source: 'route-near', layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: casePaint }, under);
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: linePaint }, under);
  map.addLayer({ id: 'route-near-line', type: 'line', source: 'route-near', layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: linePaint }, under);
  // ґрунт і погане покриття на маршруті — червоний пунктир поверх
  map.addLayer({ id: 'route-bad', type: 'line', source: 'route-bad', layout: { 'line-join': 'round' }, paint: { 'line-color': '#e5484d', 'line-width': w(3, 5, 9), 'line-dasharray': [1.2, 1.2] } }, under);
  // пройдене — світло-сіро-блакитне поверх синього
  map.addLayer({ id: 'route-done', type: 'line', source: 'route-done', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#a7b6d1', 'line-width': w(3, 6, 12) } }, under);
  map.addLayer({ id: 'done-near', type: 'line', source: 'done-near', layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: { 'line-color': '#a7b6d1', 'line-width': w(3, 6, 12) } }, under);
  // (1.1.28) новий маршрут у дорозі — варіанти на вибір: вибраний — бурштиновий із темною облямівкою поверх чинного рейсу, решта — сірі
  map.addLayer({ id: 'route-sel-case', type: 'line', source: 'route-sel', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3d2a00', 'line-width': w(6, 10, 17) } }, under);
  map.addLayer({ id: 'route-sel', type: 'line', source: 'route-sel', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#f5a400', 'line-width': w(3.5, 6.5, 12) } }, under);
  // похибка позиції — лише тонкий пунктирний контур, без заливки
  // (1.1.25) Поїздка з архіву: темний обідок, зверху — колір за швидкістю; ділянки без GPS — ще й білий пунктир посередині
  map.addLayer({ id: 'jv-case', type: 'line', source: 'jv', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#10151c', 'line-width': w(5, 8.5, 14) } }, under);
  map.addLayer({ id: 'jv-line', type: 'line', source: 'jv', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['match', ['get', 'b'], 0, SPEED_COLORS[0], 1, SPEED_COLORS[1], 2, SPEED_COLORS[2], 3, SPEED_COLORS[3], SPEED_COLORS[4]], 'line-width': w(3, 5.5, 10) } }, under);
  map.addLayer({ id: 'jv-est', type: 'line', source: 'jv', filter: ['==', ['get', 'e'], 1], layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: { 'line-color': '#ffffff', 'line-width': w(1, 1.6, 2.6), 'line-dasharray': [2, 2.4] } }, under);
  map.addLayer({ id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': '#c98600', 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [3, 3] } }, under);
  // піт-стопи по всій Україні: здалеку — головні (стоянки для фур, великі АЗС), ближче — усі
  const color = ['match', ['get', 't'], 'e', TYPES.e.color, 'f', TYPES.f.color, 's', TYPES.s.color, 'p', TYPES.p.color, 'm', TYPES.m.color, 'h', TYPES.h.color, '#1f2937'];
  // точка з душем — товстий бірюзовий обідок, щоб душ було видно серед АЗС і стоянок
  // назву вже видно (плашка АЗС чи підпис карти) — кружечок прозорий, але натискається
  const unlab = ['case', ['boolean', ['feature-state', 'lab'], false], 0, 1];
  labSeen.clear(); labHid.clear(); poiLy = null;
  const stopPaint = r => ({
    'circle-opacity': unlab, 'circle-stroke-opacity': unlab,
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, r, 9, r + 1.8, 13, r + 4.5, 16, r + 7],
    'circle-color': color,
    'circle-stroke-color': ['case', ['==', ['get', 'sh'], 1], SHOWER_COLOR, ['match', ['get', 't'], 'c', '#e5484d', '#ffffff']],
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['==', ['get', 'sh'], 1], 1.6, 0.8], 12, ['case', ['==', ['get', 'sh'], 1], 3.5, 2]]
  });
  map.addLayer({ id: 'stops-major', type: 'circle', source: 'stops', minzoom: 5, maxzoom: 9.5, filter: ['all', ['>=', ['get', 'r'], 2], ['!=', ['get', 't'], 'c']], paint: stopPaint(2.2) });
  map.addLayer({ id: 'stops-all', type: 'circle', source: 'stops', minzoom: 9.5, filter: ['!=', ['get', 't'], 'c'], paint: stopPaint(2.6) });
  // камери — значком камери (пропозиція Діми): здалеку дрібніше, зблизька — як справжній знак
  const camSize = ['interpolate', ['linear'], ['zoom'], 7.5, 0.5, 10, 0.7, 13, 1.0, 16, 1.25];
  map.addLayer({ id: 'cams-ico', type: 'symbol', source: 'stops', minzoom: 7.5, filter: ['==', ['get', 't'], 'c'],
    layout: { 'icon-image': 'cam-ico', 'icon-size': camSize, 'icon-allow-overlap': true, 'icon-padding': 0 } });
  // АЗС — плашка з назвою мережі (OKKO, WOG, UPG…), щоб одразу видно, яка заправка далі. Малюємо самі, без шрифтів карти — працює й офлайн.
  map.addLayer({ id: 'fuel-label', type: 'symbol', source: 'stops', minzoom: 10, filter: ['==', ['get', 't'], 'f'],
    layout: { 'icon-image': ['concat', 'fuel:', ['get', 'nm']], 'icon-anchor': 'bottom', 'icon-offset': [0, 1], 'icon-allow-overlap': false, 'icon-padding': 2,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.85, 14, 1.05], 'symbol-sort-key': ['-', 0, ['get', 'r']] } });
  map.on('click', 'fuel-label', e => { const f = e.features && e.features[0]; if (f && !tapHook) bus.emit('stopTap', { i: f.properties.i, lat: e.lngLat.lat, lon: e.lngLat.lng }); });
  map.addLayer({ id: 'poi-cam', type: 'symbol', source: 'poi', minzoom: 7.5, filter: ['==', ['get', 'k'], 'cam'],
    layout: { 'icon-image': 'cam-ico', 'icon-size': camSize, 'icon-allow-overlap': true, 'icon-padding': 0 } });
  map.addLayer({
    id: 'poi-dot', type: 'circle', source: 'poi', minzoom: 8, filter: ['!=', ['get', 'k'], 'cam'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 13, 7, 16, 10],
      'circle-color': '#1f2937', 'circle-stroke-color': '#e5484d', 'circle-stroke-width': 2.5
    }
  });
  // власні позначки водія «тут є душ»
  map.addLayer({ id: 'marks-dot', type: 'circle', source: 'marks', minzoom: 5, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 12, 8, 16, 12], 'circle-color': SHOWER_COLOR,
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 12, 3] } });
  map.on('click', 'marks-dot', e => { const f = e.features && e.features[0]; if (f && !tapHook) bus.emit('markTap', f.properties.id); });
  // контрольні повороти рейсу (без GPS): червоні — перехрестя й різкі повороти, жовті — довгі дуги трас
  map.addLayer({ id: 'cps-dot', type: 'circle', source: 'cps', minzoom: 9, paint: {
    'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['==', ['get', 'n'], 1], 5, 3.5], 13, ['case', ['==', ['get', 'n'], 1], 9, 6], 17, ['case', ['==', ['get', 'n'], 1], 14, 10]], 'circle-color': ['match', ['get', 'c'], 'red', '#e5484d', '#f6bd16'],
    'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 14, 2.5], 'circle-opacity': 0.95 } });
  for (const id of ['stops-major', 'stops-all', 'cams-ico']) {
    map.on('click', id, e => { const f = e.features && e.features[0]; if (f && !tapHook) bus.emit('stopTap', { i: f.properties.i, lat: e.lngLat.lat, lon: e.lngLat.lng }); });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  // пряма між точками, поставленими на карті: чорний пунктир на білій підкладці — видно і вдень, і вночі
  map.addLayer({ id: 'plan-line-bg', type: 'line', source: 'plan-line', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'plan-line', type: 'line', source: 'plan-line', paint: { 'line-color': '#13171c', 'line-width': 3, 'line-dasharray': [1.6, 1.4] } });
  doneD = -1; cpKey = ''; drawRoute(); drawPoi(); drawStops(); drawRough(); drawMarks(); drawCps(); if (planPts) planPoints(planPts);
  jrNight = null; jrPaint(); drawJourney(); drawJv();
  offlineWatch();
  tuneLabels();
  satLayer();
  if (clean) setClean(true);
}
const firstSymbolId = () => { try { const l = (map.getStyle().layers || []).find(x => x.type === 'symbol'); return l ? l.id : undefined; } catch (_) { return undefined; } };
// Назви вулиць — більші, темні, з товстим білим обідком: читаються навіть поверх лінії рейсу.
// Номери будинків — лише зблизька (коли водій сам наблизив карту), щоб на ходу не захаращували.
function tuneLabels() {
  let style; try { style = map.getStyle(); } catch (_) { return; }
  const ls = style.layers || [], size = ['interpolate', ['linear'], ['zoom'], 12, 12.5, 15, 14.5, 17, 17, 19, 19];
  let omt = null, firstRoad = null, house = false; const dark = !!(style.metadata && style.metadata.reisNight);
  for (const l of ls) {
    if (l.type !== 'symbol') continue;
    const sl = l['source-layer'];
    if (sl === 'housenumber' || l.id === 'address_label') { house = true; try { map.setLayerZoomRange(l.id, HOUSE_Z, 24); } catch (_) {} continue; }
    const road = (sl === 'transportation_name' && !(l.layout && l.layout['icon-image'])) || (sl === 'roads' && /label/.test(l.id));
    if (!road) continue;
    if (sl === 'transportation_name') omt = omt || l.source;
    firstRoad = firstRoad || l.id;
    try {
      map.setLayoutProperty(l.id, 'text-size', size);
      map.setPaintProperty(l.id, 'text-color', dark ? '#eef1f4' : '#1d2330');
      map.setPaintProperty(l.id, 'text-halo-color', dark ? '#0f1317' : '#ffffff');
      map.setPaintProperty(l.id, 'text-halo-width', 2.4);
      map.setPaintProperty(l.id, 'text-halo-blur', 0.2);
    } catch (_) {}
  }
  // OpenMapTiles (онлайн-карта): у стилі немає шару номерів — додаємо свій із того ж джерела, нижче назв вулиць
  if (!house && omt && !map.getLayer('reis-house')) {
    try { map.addLayer(houseLayer(omt, false), firstRoad || undefined); } catch (e) { log('warn', 'номери будинків: ' + e.message); }
  }
  // Офлайн-карта: шар номерів уже в стилі (джерело — addr.js, із запасом у телефоні); ставимо його теж під назви вулиць
  else if (map.getLayer('reis-house') && firstRoad) { try { map.moveLayer('reis-house', firstRoad); } catch (_) {} }
}
// Контрольні повороти наперед (до 25 км, до 12 штук): видно, коли GPS немає, або коли водій увімкнув їх у Лабораторії
let cpKey = '';
function drawCps() {
  const src = map && map.getSource && map.getSource('cps'); if (!src) return;
  let key = 'off', feats = [];
  if (g.active && g.idx && pos.rd != null && pos.onRoute && (pos.mode === 'dr' || S.cpsShow)) {
    const d = pos.rd, ahead = routeCps().filter(c => c.d1 > d - 20 && c.d < d + 25000).slice(0, 12);
    const nx = pos.cp ? pos.cp.d : (ahead[0] && ahead[0].d);                   // наступний контрольний поворот — більший кружечок
    key = ahead.map(c => c.d).join(',') + '|' + nx;
    if (key !== cpKey) feats = ahead.map(c => { const p = g.idx.at(c.d); return { type: 'Feature', properties: { c: c.cls, a: c.ang, n: c.d === nx ? 1 : 0, d: c.d }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }; });
  }
  if (key === cpKey) return;
  cpKey = key; src.setData({ type: 'FeatureCollection', features: feats });
}

/* ---------- тип карти: звичайна чи супутник (1.1.19) ----------
   Супутник — знімки поверх карти, але ПІД лініями рейсу, назвами вулиць і міст, номерами будинків і нашими значками:
   видно, як місце виглядає насправді (ворота складу, майданчик для фур), і водночас — куди їхати.
   Лише з інтернетом: зникла мережа — сам показуємо звичайну (завантажену) карту, з'явилась — повертаємо знімки.
   Квадрат знімка не прийшов (слабкий сигнал) — під ним просто видно звичайну карту, сірих дірок немає. */
let attrBase = '', satShown = false;
export const SAT_ATTR = 'Супутник: Esri, Maxar, Earthstar Geographics';
const satTpl = () => S.satUrl || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
function isSatUrl(url) { const pre = satTpl().split('{')[0]; return pre.length > 12 && url.startsWith(pre); }
export const satWanted = () => S.mapType === 'sat';
export const satOn = () => satWanted() && P.online();
function satLayer() {
  if (!map) return false;
  const want = satOn();
  let has = false; try { has = !!map.getLayer('reis-sat'); } catch (_) { return false; }
  const ready = !!map.getSource('route');                        // стиль іще вантажиться — шар додасть addLayers, щойно він буде готовий
  if (want && !has && ready) {
    try {
      if (!map.getSource('reis-sat')) map.addSource('reis-sat', { type: 'raster', tiles: [satTpl()], tileSize: 256, maxzoom: 18, attribution: SAT_ATTR });
      // під першим нашим шаром (лінії рейсу кладуться під підписи карти) — тобто над заливками й дорогами карти, під усім, що треба читати
      const before = ['rough-dot', 'route-alts-case'].find(id => map.getLayer(id)) || firstSymbolId();
      map.addLayer({ id: 'reis-sat', type: 'raster', source: 'reis-sat', paint: { 'raster-fade-duration': 150 } }, before);
    } catch (e) { log('warn', 'супутник: ' + e.message); return false; }
  } else if (!want && has) {
    try { map.removeLayer('reis-sat'); if (map.getSource('reis-sat')) map.removeSource('reis-sat'); } catch (_) {}
  }
  document.body.classList.toggle('mapsat', want);
  const attr = document.getElementById('attr'); if (attr && attrBase) { attr.dataset.full = attrBase + (want ? ' · ' + SAT_ATTR : ''); attr.title = attr.dataset.full; }
  satShown = want;
  return want;
}
/** Застосувати вибір типу карти. user — водій щойно вибрав сам (тоді мовчимо: він бачить результат). */
export function applySat(user) {
  if (map && user && map.getSource('reis-sat')) { try { if (map.getLayer('reis-sat')) map.removeLayer('reis-sat'); map.removeSource('reis-sat'); } catch (_) {} }   // інша адреса знімків — джерело наново
  const was = satShown, now = satLayer();
  if (!user && satWanted() && was !== now) bus.emit('satNet', now);       // мережа зникла / повернулась, а вибрано супутник — UI скаже водієві
  bus.emit('mapType', { want: satWanted(), on: now });
}

/* ---------- день / ніч ---------- */
export function applyTheme() {
  const night = S.theme === 'night' || (S.theme === 'auto' && isNight(pos.lat ?? 49.0, pos.lon ?? 31.3));
  if (night === view.night && document.body.dataset.theme) return;
  const was = view.night;
  view.night = night; document.body.dataset.theme = night ? 'night' : 'day';
  if (map && offlineActive() && was !== night) setMapStyle(currentStyle());      // офлайн-карта: день і ніч — два окремі набори кольорів
  bus.emit('view', view);
}

/* ---------- нахил карти (1.1.21): повзунок справа і жест двома пальцями — одне й те саме ----------
   Нахил — це кут, під яким дивимось на карту: 0° — згори (2D), до 60° — збоку (3D). Раніше було лише «2D / 3D» (0° або 52°).
   Тепер кут можна виставити повзунком (або двома пальцями вгору-вниз по карті) — і він лишається: і коли карта стежить
   за машиною, і після перезапуску. Плитка «2D / 3D» у швидких налаштуваннях працює, як і раніше: 3D — це останній виставлений кут. */
export const PITCH_MAX = 60, PITCH_3D = 52;
let pitchLive = null;                         // поки палець тягне повзунок — кут звідси; у налаштування пишемо, коли відпустили
export const pitchNow = () => pitchLive != null ? pitchLive : (S.view3d ? clamp(Math.round(+S.pitch) || PITCH_3D, 3, PITCH_MAX) : 0);
/** Кут, який карта показує просто зараз (повзунок малює саме його). */
export const tiltShown = () => { try { return map ? Math.round(map.getPitch()) : pitchNow(); } catch (_) { return pitchNow(); } };
function tiltCommit(v) {
  if (v < 3) { if (S.view3d) S.view3d = false; return; }               // майже згори — це «2D»
  if (S.pitch !== v) S.pitch = v;
  if (!S.view3d) S.view3d = true;
}
/** Виставити нахил. live — палець іще тягне повзунок (карта нахиляється одразу, налаштування не чіпаємо). */
export function setTilt(v, live = false) {
  v = clamp(Math.round(v), 0, PITCH_MAX);
  pitchLive = live ? v : null;
  if (!live) tiltCommit(v);
  let moved = false;
  try { if (map && Math.abs(map.getPitch() - v) > 0.05) { map.setPitch(v); moved = true; } } catch (_) {}
  if (!moved) bus.emit('tilt', v);                                     // карта вже під цим кутом (або її ще немає) — повзунок однаково перемальовуємо
}

/* ---------- позиція і камера ---------- */
// Як у звичайному навігаторі: у режимі «за рухом» стрілка стоїть в одній точці екрана — посередині по ширині,
// у нижній частині вільної карти — і дивиться строго вгору; рухається й повертається карта під нею.
// Позицію між фіксами (раз на секунду) ведемо плавно кадр за кадром: і стрілку, і камеру — однією точкою,
// тому стрілка не «гуляє» відносно центру, як було з окремою анімацією камери.
export const ANCHOR = { frac: 0.79 };          // частка висоти вільної карти від її верху до стрілки (1.1.29: Діма — «на пару міліметрів нижче, більше простору попереду»; було 0,72; 1.1.32: Олексій — «ще трохи нижче», було 0,75)
const cam = { cur: null, from: null, to: null, t0: 0, dur: 0, lastPosT: 0, brg: null, tBrg: 0, z: null, raf: 0, lastT: 0, drawT: 0, blendUntil: 0, pad: null, anc: null, ancT: 0,
  dd: null, rdT: 0, rdAt: 0, v: 0, idx: null, onR: false };
export const camState = cam;
export function setFollow(on) { view.follow = on; if (on) { view.zoomBias = 0; follow(true); } bus.emit('view', view); }
export function zoomBy(d) {
  if (view.follow) { view.zoomBias = clamp(view.zoomBias + d, -5, 3); follow(true); }
  else if (map) map.easeTo({ zoom: map.getZoom() + d, duration: 250 });
}
const D2R = Math.PI / 180;
const brgOf = (a, b) => { const y = Math.sin((b.lon - a.lon) * D2R) * Math.cos(b.lat * D2R), x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) - Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lon - a.lon) * D2R); return (Math.atan2(y, x) / D2R + 360) % 360; };
const distM = (a, b) => { const x = (b.lon - a.lon) * D2R * Math.cos((a.lat + b.lat) / 2 * D2R), y = (b.lat - a.lat) * D2R; return Math.hypot(x, y) * 6371008.8; };
const angD = (a, b) => ((b - a) % 360 + 540) % 360 - 180;
// Напрям «вгору»: на маршруті — уздовж самої лінії маршруту трохи наперед (короткі зламані відрізки доріг і шум GPS не крутять карту),
// поза маршрутом — курс руху.
const onRouteNow = () => !!(g.active && g.idx && pos.onRoute && pos.rd != null);
function routeBrg(R, d) {
  const L = clamp((pos.spd || 0) * 2.5, 30, 80);
  const a = R.at(Math.max(0, d - L * 0.35)), b = R.at(Math.min(R.total, d + L));
  return distM(a, b) > 8 ? brgOf(a, b) : null;
}
function navBrg() {
  if (onRouteNow()) { const b = routeBrg(g.idx, pos.rd); if (b != null) return b; }
  return pos.hdg || 0;
}
// Точка екрана для стрілки: посередині по ширині, на ANCHOR.frac висоти вільної карти між верхньою і нижньою плашками
export function anchorPoint() {
  const c = map.getContainer(), W = c.clientWidth, H = c.clientHeight, cr = c.getBoundingClientRect(), now = Date.now();
  if (cam.anc && cam.anc.W === W && cam.anc.H === H && now - cam.ancT < 1000) return cam.anc;
  let top = 0, bot = H;
  if (W <= H) {
    const tp = document.getElementById('top'), bt = document.getElementById('bottom');
    if (tp && !tp.hidden) top = Math.max(0, tp.getBoundingClientRect().bottom - cr.top);
    if (bt && !bt.hidden) bot = Math.min(H, bt.getBoundingClientRect().top - cr.top);
    // (1.1.34) Без GPS стрілка стоїть на тій самій висоті, що й із GPS (Олексій: «в офлайні стрілка вища, ніж в онлайні»).
    // До 1.1.34 її піднімали над стовпчиком кнопок ±100 / «Поворот», але ці кнопки — праворуч, а стрілка — посередині: не заважають.
    if (bot - top < 160) { top = 0; bot = H; }
  } else {                                       // альбомна: плашки по боках, середина екрана вільна
    const st = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--st')) || 0;
    top = st + 10; bot = H - 10;
  }
  cam.anc = { x: W / 2, y: Math.round(top + (bot - top) * ANCHOR.frac), W, H, top, bot }; cam.ancT = now;
  return cam.anc;
}
function camPadding() {
  const a = anchorPoint(), y = a.y;
  return { top: Math.max(0, 2 * y - a.H), bottom: Math.max(0, a.H - 2 * y), left: 0, right: 0 };
}
function targetZoom() {
  const kmh = pos.spd * 3.6;
  let zoom = clamp(16.8 - kmh / 45, 14.4, 16.8);
  if (g.active && g.next && g.distNext < 350) zoom = Math.max(zoom, 16.3);
  // позиція приблизна — віддаляємо карту, щоб коло похибки вміщалося на екрані
  // Без GPS на рейсі — той самий масштаб, що й із GPS: стрілка їде лінією рейсу, віддаляти нема чого.
  // Лише місце «за вишками» поза рейсом — трохи далі, але не дрібніше за квартал.
  if (pos.mode === 'approx' && !onRouteNow() && pos.acc > 150) zoom = Math.min(zoom, clamp(16.6 - 0.5 * Math.log2(pos.acc / 50), 14.5, 16.6));
  if (view.pip) zoom -= 0.9;                 // у маленькому вікні показуємо трохи більше дороги попереду
  return clamp(zoom + view.zoomBias, 5, 19);
}
/** Програма у вікні поверх інших (1.1.27): карта стежить за машиною, трохи далі. */
export function setPipView(on) { view.pip = !!on; cam.anc = null; if (on) setFollow(true); else follow(true); try { map && map.resize(); } catch (_) {} }
const camFree = () => view.down && Date.now() - view.touchT < 8000 || Date.now() - (view.touchT || 0) < 700;   // палець на карті
// Перехід до стеження (кнопка «Моє місце», 3D, північ, масштаб): коротка анімація, далі — покадрово
function follow(force) {
  if (!map || !cam.cur || !view.follow || (document.hidden && !force)) return;
  if (!force && camFree()) return;
  const z = targetZoom(); cam.z = z; cam.pad = camPadding();
  map.easeTo({ center: [cam.cur.lon, cam.cur.lat], zoom: z, bearing: view.north ? 0 : cam.brg, pitch: pitchNow(), padding: cam.pad, duration: 400 });
  cam.blendUntil = performance.now() + 430; kick();
}
function kick() { if (!cam.raf) cam.raf = requestAnimationFrame(frame); }
function frame(ts) {
  cam.raf = 0;
  if (!map || !cam.cur) return;
  const dt = cam.lastT ? Math.min(300, ts - cam.lastT) : 16; cam.lastT = ts; cam.ft = ts;   // повільний телефон — кадри рідші, але швидкість та сама
  let more = false;
  if (cam.onR && g.idx === cam.idx && cam.dd != null) {
    // На маршруті стрілка їде самою лінією маршруту з рівною швидкістю: між фіксами — наперед зі швидкістю руху,
    // а розбіжність із новим фіксом (раз на секунду, пачками) розтягуємо на ~0,7 с. Назад не смикаємо: дрібне випередження
    // просто «чекає», доки машина наздожене. На вигинах не зрізає кути, як пряма між двома фіксами.
    const R = cam.idx, pred = cam.rdT + cam.v * Math.min(2, (ts - cam.rdAt) / 1000);
    const err = pred - cam.dd;
    let step = cam.v * dt / 1000 + err * (1 - Math.exp(-dt / 700));
    if (step < 0 && err > -40) step = Math.max(step, 0);
    cam.dd = clamp(cam.dd + step, 0, R.total);
    const p = R.at(cam.dd); cam.cur = { lat: p.lat, lon: p.lon };
    const b = routeBrg(R, cam.dd); if (b != null) cam.tBrg = b;
    if (cam.v > 0.2 || Math.abs(err) > 0.3) more = true;
    if (ts - prog.t >= 45 || !more) { prog.t = ts; progressAt(cam.dd, false); }
  } else if (cam.dur > 0) {
    const k = Math.min(1, (ts - cam.t0) / cam.dur);
    cam.cur = { lat: cam.from.lat + (cam.to.lat - cam.from.lat) * k, lon: cam.from.lon + (cam.to.lon - cam.from.lon) * k };
    if (k < 1) more = true; else cam.dur = 0;
  }
  if (cam.brg == null) cam.brg = cam.tBrg;
  const db = angD(cam.brg, cam.tBrg);
  if (Math.abs(db) > 0.2) {
    let st = db * (1 - Math.exp(-dt / 280)); const cap = 140 * dt / 1000;
    if (Math.abs(st) > cap) st = Math.sign(st) * cap;
    if (Math.abs(db) < 0.6) st = db;
    cam.brg = (cam.brg + st + 360) % 360; more = true;
  }
  puck.setLngLat([cam.cur.lon, cam.cur.lat]).setRotation(cam.brg);
  if (view.follow && !document.hidden && !camFree() && ts >= cam.blendUntil) {
    const tz = targetZoom(), pad = camPadding();
    if (cam.z == null) cam.z = map.getZoom();
    const dz = tz - cam.z; cam.z = Math.abs(dz) < 0.01 ? tz : cam.z + dz * (1 - Math.exp(-dt / 900));
    if (!cam.pad) cam.pad = pad;
    let padMove = false;
    for (const k of ['top', 'bottom']) { const d = pad[k] - cam.pad[k]; if (Math.abs(d) > 0.5) { cam.pad = { ...cam.pad, [k]: cam.pad[k] + d * (1 - Math.exp(-dt / 250)) }; padMove = true; } else cam.pad = { ...cam.pad, [k]: pad[k] }; }
    if (ts - cam.drawT >= 22 || !more) {          // не частіше ~45 кадрів/с — батарея
      cam.drawT = ts;
      map.jumpTo({ center: [cam.cur.lon, cam.cur.lat], zoom: cam.z, bearing: view.north ? 0 : cam.brg, pitch: pitchNow(), padding: cam.pad });
    }
    if (cam.z !== tz || padMove) more = true;
  }
  if (more) kick(); else cam.lastT = 0;
}
function circle(p, r) {
  const pts = [], kx = 111320 * Math.cos(p.lat * Math.PI / 180);
  for (let i = 0; i <= 48; i++) { const a = i / 48 * 2 * Math.PI; pts.push([p.lon + r * Math.cos(a) / kx, p.lat + r * Math.sin(a) / 110540]); }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
}
let accShown = false;
function onPos() {
  if (!map || pos.lat == null) return;
  const now = performance.now(), to = { lat: pos.lat, lon: pos.lon };
  cam.tBrg = navBrg();
  // між фіксами — плавно за час, що минув від попереднього (≈1 с); великий стрибок (прив'язка, «Я тут») — одразу
  const jump = !cam.cur || distM(cam.cur, to) > 400;
  if (onRouteNow()) {
    if (!cam.onR || cam.idx !== g.idx || cam.dd == null || Math.abs(cam.dd - pos.rd) > 400) cam.dd = pos.rd;   // перший раз, новий маршрут, «Я тут»
    cam.onR = true; cam.idx = g.idx; cam.rdT = pos.rd; cam.rdAt = now; cam.v = pos.spd > 0.3 ? pos.spd : 0; cam.dur = 0;
    if (jump) { const p = g.idx.at(cam.dd); cam.cur = { lat: p.lat, lon: p.lon }; cam.brg = cam.tBrg; }
  } else {
    cam.onR = false; cam.dd = null;
    if (jump || now - cam.lastPosT > 4000) { cam.cur = to; cam.dur = 0; if (jump) cam.brg = cam.tBrg; }
    else { cam.from = { ...cam.cur }; cam.to = to; cam.t0 = now; cam.dur = clamp(now - cam.lastPosT, 200, 1150); }
  }
  cam.lastPosT = now;
  if (!puck._added) { cam.brg = cam.tBrg; puck.setLngLat([to.lon, to.lat]).setRotation(cam.brg).addTo(map); puck._added = true; follow(true); }
  const est = pos.mode === 'dr' || pos.mode === 'approx';
  puckEl.classList.toggle('dr', est);
  const src = map.getSource && map.getSource('acc');
  drawCps();
  if (src) {
    // на рейсі без GPS кола похибки не малюємо: місце — на самій лінії рейсу, а кілометрове коло лише плутає
    if (est && !(pos.mode === 'dr' && onRouteNow())) { src.setData(circle(pos, Math.max(20, pos.acc || 20))); accShown = true; }
    else if (accShown) { src.setData(EMPTY); accShown = false; }
  }
  kick();
}

/* ---------- маршрут ---------- */
function wpEl(cls, k) { const d = document.createElement('div'); d.className = 'wp ' + cls; if (k && PT_SVG[k]) d.innerHTML = PT_SVG[k]; return d; }
// Мітки точок: старт (зелений прапорець), через (кільце), фініш (картатий прапор) — і в дорозі, і поки вибираємо варіант
let previewTrip = null;
export function previewPoints(tr) { previewTrip = tr || null; drawRoute(); }
function drawPins(tr) {
  const add = (p, cls, txt) => { if (p) wps.push(new maplibregl.Marker({ element: wpEl(cls, txt), anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map)); };
  add(tr.a, 'wp-a', 'a'); for (const v of viasOf(tr)) add(v, 'wp-v', 'v'); add(tr.b, 'wp-b', 'b');
}
/* ---------- точки рейсу, поставлені просто на карті (1.1.12): значки й пряма між ними ---------- */
let planMarks = [], planPts = null;
export function planPoints(pts) {
  planPts = pts || null;
  for (const m of planMarks) m.remove(); planMarks = [];
  const src = map && map.getSource && map.getSource('plan-line');
  if (!map || !pts) { if (src) src.setData(EMPTY); return; }
  const vs = pts.vs || (pts.v ? [pts.v] : []), mk = (k, p) => planMarks.push(new maplibregl.Marker({ element: wpEl('wp-' + k + ' wp-plan', k), anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map));
  if (pts.a) mk('a', pts.a); for (const v of vs) mk('v', v); if (pts.b) mk('b', pts.b);
  const line = [pts.a || pts.me, ...vs, pts.b].filter(Boolean);
  if (src) src.setData(line.length >= 2 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line.map(p => [p.lon, p.lat]) } } : EMPTY);
}
export const planPointsShown = () => planMarks.length;
function drawRoute() {
  for (const m of wps) m.remove(); wps = [];
  const src = map && map.getSource && map.getSource('route'); if (!src) return;
  doneD = -1; doneT = 0; setDone(EMPTY);
  if (!g.route) { clearNear(); src.setData(previewCoords ? routeData(previewCoords, previewR) : EMPTY); drawHazards(); if (previewCoords && previewTrip) drawPins(previewTrip); return; }
  src.setData(routeData(g.route.coords, g.route));
  drawHazards();
  const tr = g.trip; if (!tr) return;
  drawPins(tr);
  prog.idx = null; progressAt(progD(), true);
}
function setDone(data) { const s = map && map.getSource && map.getSource('route-done'); if (s) s.setData(data); }
// Пройдена частина маршруту — окрема світла лінія від старту до машини. Оновлюється не частіше ніж раз на 2 с.
// Залишок маршруту від машини до кінця (з категоріями доріг) — коли пройдене ховаємо.
function remainData(rd, end) {
  const idx = g.idx, rc = S.routeCats !== false ? routeCats(g.route) : null, f = [], E = end == null ? idx.total : end;
  const line = (a, b, c) => { const cs = idx.slice(a, b); if (cs.length >= 2) f.push({ type: 'Feature', properties: c ? { c } : {}, geometry: { type: 'LineString', coordinates: cs } }); };
  if (rc) { for (const s of rc.segs) { const d0 = idx.cum[Math.min(s.i0, idx.cum.length - 1)], d1 = idx.cum[Math.min(s.i1, idx.cum.length - 1)]; if (d1 > rd && d0 < E) line(Math.max(d0, rd), Math.min(d1, E), s.c); } }
  else line(rd, E);
  return { type: 'FeatureCollection', features: f };
}
// Лінія маршруту біля стрілки. Великий шматок (уся решта маршруту чи все пройдене) перемальовуємо рідко — раз на ~700 м;
// короткий шматок між стрілкою й межею великого — щокадру (≈20 разів/с), тому лінія «з'їдається» під стрілкою плавно.
const prog = { B0: null, A0: null, idx: null, mode: '', t: 0 };
const progD = () => (cam.onR && cam.idx === g.idx && cam.dd != null) ? cam.dd : (pos.rd || 0);
function doneData(d) {
  let c = g.idx.slice(0, d);
  if (c.length > 3000) {                    // давню частину проріджуємо, останні 600 точок — повністю
    const head = c.slice(0, c.length - 600), k = Math.ceil(head.length / 2400);
    c = head.filter((_, i) => i % k === 0).concat(c.slice(c.length - 600));
  }
  return c.length >= 2 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } } : EMPTY;
}
function progressAt(d, force) {
  if (!map || !g.idx || !g.route) return;
  const R = g.idx, grey = S.passed === 'grey', sR = map.getSource('route'), sN = map.getSource('route-near'), sD = map.getSource('done-near');
  if (!sR || !sN || !sD) return;
  if (prog.idx !== R || prog.mode !== (grey ? 'g' : 'h')) { prog.idx = R; prog.mode = grey ? 'g' : 'h'; prog.B0 = prog.A0 = null; force = true; }
  d = clamp(d, 0, R.total);
  if (!grey) {                               // пройдене ховаємо: на карті лише шлях попереду
    if (force || prog.B0 == null || d > prog.B0 - 150 || d < prog.B0 - 900) {
      prog.B0 = Math.min(R.total, d + 700);
      sR.setData(prog.B0 >= R.total ? EMPTY : remainData(prog.B0));
      setDone(EMPTY); sD.setData(EMPTY);
    }
    sN.setData(d < prog.B0 ? remainData(d, prog.B0) : EMPTY);
  } else {                                   // пройдене — блідою лінією поверх
    if (force || prog.A0 == null || d - prog.A0 > 700 || d < prog.A0) {
      prog.A0 = d; sR.setData(routeData(g.route.coords, g.route)); sN.setData(EMPTY);
      setDone(d < 5 ? EMPTY : doneData(d));
    }
    const c = d > prog.A0 + 0.5 ? R.slice(prog.A0, d) : [];
    sD.setData(c.length >= 2 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } } : EMPTY);
  }
}
function drawProgress() { progressAt(progD(), false); }
function clearNear() { for (const id of ['route-near', 'done-near']) { const s = map && map.getSource && map.getSource(id); if (s) s.setData(EMPTY); } prog.idx = null; }

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
  el.addEventListener('click', e => { if (tapHook) return; e.stopPropagation(); bus.emit('evTap', id); });
  m = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  m.seen = true; evMarks.set(id, m);
}
export function drawEvents() {
  if (!map) return;
  for (const m of evMarks.values()) m.seen = false;
  const now = Date.now();
  if (S.lookahead && S.mapEvents !== false) {
    for (const it of feed.items) {                         // лише те, що тут і попереду: пройдене й далеке не захаращує карту
      if (it.lat == null || it.src === 'stop') continue;
      const r = relevance(it, now); if (!r.show) continue;
      const cls = (it.src === 'wx' ? 'wx ' : '') + it.level + (it.locKind === 'area' ? ' area' : '') + (r.tier === 'far' ? ' far' : '');
      evMarker(it.id, it, cls, it.src === 'wx' ? EV_ICON.wx : EV_ICON[it.level], it.sum || it.text);
    }
    if (S.air) for (const { id } of zoneRegions()) {
      const c = OBLAST_CENTER[id]; if (!c || !(feed.air || {})[id]) continue;
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
  noPad();
  map.fitBounds(b, { padding: { top: Math.round(h * 0.22), bottom: Math.round(h * 0.42), left: 40, right: 40 }, bearing: 0, pitch: 0, duration: 700, maxZoom: 15 });
}
// Вибір варіанта: обидва маршрути цілком у верхній частині екрана (над шторкою вибору), як у BlindDriver.
// Поки вибираємо, карта сама не повертається до машини.
export function fitRoutes(list, padTop, padBottom, padRight = 70) {
  if (!map || !list || !list.length) return;
  const b = new maplibregl.LngLatBounds();
  for (const coords of list) {
    const step = Math.max(1, Math.floor(coords.length / 300));
    for (let i = 0; i < coords.length; i += step) b.extend([coords[i][1], coords[i][0]]);
    b.extend([coords[coords.length - 1][1], coords[coords.length - 1][0]]);
  }
  view.follow = false; view.lastTouch = Date.now() + 3600e3; bus.emit('view', view);
  const h = map.getContainer().clientHeight, w = map.getContainer().clientWidth;
  const land = sideLayout(w, h), side = land ? { left: 30, right: Math.round(w * 0.46) + 80 } : { left: 34, right: Math.max(70, Math.round(padRight)) };   // справа — кнопки масштабу (на планшеті шторка вужча за екран, і кнопки не біля краю)
  // вільного місця по висоті має лишитись хоча б 90 px — інакше карта «не вміщає» рейс і не рухається зовсім
  let pt = Math.round(padTop), pb = Math.round(land ? 30 : padBottom); const free = h - pt - pb;
  if (free < 90) { const k = Math.max(0, (h - 90)) / Math.max(1, pt + pb); pt = Math.floor(pt * k); pb = Math.floor(pb * k); }
  noPad();
  map.fitBounds(b, { padding: { top: pt, bottom: pb, ...side }, bearing: 0, pitch: 0, duration: 600, maxZoom: 14 });
}
// Камера «за машиною» тримає відступ згори (машина нижче центру). fitBounds додає свої відступи ДО нього —
// на невисокому екрані сума перевищувала висоту карти, і рейс не показувався зовсім. Перед оглядом рейсу відступ знімаємо.
function noPad() { try { map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); } catch (_) {} }
export function freeView() { view.lastTouch = Date.now(); }
// Маршрут, який ще лише планується (до «Поїхали»): малюємо без запуску ведення.
export function previewAlts(list) {
  const src = map && map.getSource && map.getSource('route-alts'); if (!src) return;
  src.setData({ type: 'FeatureCollection', features: (list || []).map(([k, coords]) => ({ type: 'Feature', properties: { k }, geometry: { type: 'LineString', coordinates: coords.map(c => [c[1], c[0]]) } })) });
}
// (1.1.28) Варіанти нового маршруту в дорозі: list — координати кожного; sel — вибраний (яскравий), решта — сірі (дотик вибирає).
// Чинний рейс при цьому лишається на карті, як був. list = null — прибрати.
// Уночі звичайну карту перевертає фільтр (body.mapdark/mapsat — без нього): бурштин під ним темніє до брунатного, а темна облямівка
// світлішає. Тому під фільтром даємо кольори, які ПІСЛЯ фільтра виглядають помаранчевою лінією з темною облямівкою (підібрано на екрані).
function selPaint() {
  if (!map || !map.getLayer || !map.getLayer('route-sel')) return;
  const b = document.body, inv = b.dataset.theme === 'night' && !b.classList.contains('mapdark') && !b.classList.contains('mapsat');
  try { map.setPaintProperty('route-sel', 'line-color', inv ? 'hsl(24,100%,46%)' : '#f5a400'); map.setPaintProperty('route-sel-case', 'line-color', inv ? 'hsl(42,100%,76%)' : '#3d2a00'); } catch (_) {}
}
export function pickRoutes(list, sel = 0) {
  selPaint();
  previewAlts(list ? list.map((c, k) => [k, c]).filter(([k]) => k !== sel) : null);
  const src = map && map.getSource && map.getSource('route-sel'); if (!src) return;
  src.setData(list && list[sel] ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: list[sel].map(c => [c[1], c[0]]) } } : EMPTY);
}
export function previewRoute(coords, route = null) {
  const src = map && map.getSource && map.getSource('route'); if (!src) return;
  if (!coords) previewAlts(null);
  previewCoords = coords || null; previewR = coords ? route : null;
  src.setData(coords ? routeData(coords, route) : EMPTY);
  if (!coords) previewTrip = null;
  if (!g.route) { for (const m of wps) m.remove(); wps = []; if (coords && previewTrip) drawPins(previewTrip); }
  drawHazards();
  doneD = -1; setDone(EMPTY);
  if (coords) showRoute(coords);
}
// Офлайн-карта України, якщо завантажена; інакше онлайн-стиль, вибраний у налаштуваннях.
// Сторож офлайн-карти (1.1.13): стиль увімкнувся — за кілька секунд на екрані мають з'явитися суша, вода чи дороги з файлу.
// Якщо нічого не намалювалось (файл не читається шматками, збій розпакування) — не лишаємо порожнє сіре тло:
// повертаємо онлайн-карту й кажемо про це. Раніше водій бачив просто «сіру карту» без жодного пояснення.
let offWatchT = 0, offTiles = { ok: 0, err: 0, msg: '' }, offHooked = false;
function offlineWatch() {
  clearTimeout(offWatchT);
  if (!offHooked) {            // лічильники тайлів офлайн-карти: скільки прийшло, скільки зірвалось
    offHooked = true;
    map.on('sourcedata', e => { if (e.sourceId === 'protomaps' && e.tile && e.tile.state === 'loaded') offTiles.ok++; });
    map.on('error', e => { if (e && e.sourceId === 'protomaps') { offTiles.err++; offTiles.msg = String(e.error && e.error.message || '').slice(0, 100); } });
  }
  offTiles = { ok: 0, err: 0, msg: '' };
  if (!offlineActive()) return;
  let tries = 0;
  const check = async () => {
    if (!map || !offlineActive() || !map.getSource('protomaps')) return;
    // «Малюється» — це коли з файлу справді прийшли об'єкти: суша, вода, дороги, забудова. Більше нічому не віримо:
    // у 1.1.13–1.1.14 «квадрати завантажились без помилок» вважалось успіхом, а на екрані було порожнє сіре тло
    // (бібліотека викидала квадрат через брак набору літер і не казала про це жодною помилкою).
    let feat = 0; for (const l of ['earth', 'water', 'roads', 'landuse', 'landcover', 'buildings', 'boundaries', 'places']) { try { feat += map.querySourceFeatures('protomaps', { sourceLayer: l }).length; } catch (_) {} if (feat) break; }
    if (feat > 0) { log('info', 'офлайн-карта малюється (квадратів: ' + offTiles.ok + ', читань файлу: ' + off.reads + ', помилок: ' + off.errs + (off.glyphMiss.length ? ', бракує наборів літер: ' + off.glyphMiss.length : '') + ')'); return; }
    if (++tries < 5) { offWatchT = setTimeout(check, 4000); return; }
    // 20 секунд — і жодного об'єкта з файлу
    let why = '';
    if (offTiles.err || off.errs) why = 'зірвалось квадратів ' + offTiles.err + (offTiles.msg ? ': ' + offTiles.msg : '') + ', помилок читання ' + off.errs + (off.lastErr ? ': ' + off.lastErr : '');
    else {
      const c = map.getCenter(), n = await tileBytesAt(c.lat, c.lng, map.getZoom());
      if (!map || !offlineActive()) return;
      if (n > 0) why = 'квадрат у файлі є (' + n + ' байтів), а на карті порожньо';
      else { log('info', 'офлайн-карта: під цим місцем у файлі карти немає (' + c.lat.toFixed(3) + ', ' + c.lng.toFixed(3) + ') — це не збій'); return; }
    }
    tilesBad(why + '; читань ' + off.reads);
  };
  offWatchT = setTimeout(check, 4000);
}
// Офлайн-карта має власну темну раскладку кольорів — «перевертати» її фільтром уночі не треба (body.mapdark вимикає фільтр).
export const nativeDark = () => offlineActive() && view.night;
export function currentStyle() { try { if (offlineActive()) return offlineStyle(view.night); } catch (e) { log('warn', 'офлайн-стиль: ' + e.message); } return S.styleUrl; }
export function applyMapSource() { setMapStyle(currentStyle()); bus.emit('mapSource', offlineActive()); }
export function setMapStyle(url) {
  if (!map || !url) return;
  view.blank = false; doneD = -1;
  document.body.classList.toggle('mapdark', typeof url === 'object' && !!(url.metadata && url.metadata.reisNight));
  // diff: false — повне перезавантаження стилю, інакше бібліотека «порівнює» стилі й мовчки викидає наші шари маршруту
  try { map.setStyle(url, { diff: false }); } catch (e) { log('warn', 'стиль карти: ' + e.message); }
}
// offY — на скільки пікселів підняти точку над серединою (коли низ карти закриває картка)
export function flyTo(p, zoom = 14, offY = 0) { if (!map) return; view.follow = false; view.lastTouch = Date.now(); bus.emit('view', view); noPad(); map.easeTo({ center: [p.lon, p.lat], zoom, pitch: 0, bearing: 0, duration: 600, offset: [0, -Math.round(offY)] }); }

function drawMarks() {
  const src = map && map.getSource && map.getSource('marks'); if (!src) return;
  const on = (S.mapStopTypes || {}).shower !== false && S.mapStops !== false;
  src.setData({ type: 'FeatureCollection', features: on ? showers.myShowers().map(m => ({ type: 'Feature', properties: { id: m.id }, geometry: { type: 'Point', coordinates: [m.lon, m.lat] } })) : [] });
}
function drawRough() {
  const src = map && map.getSource && map.getSource('rough'); if (!src) return;
  src.setData(S.roughMap ? rough.geojson() : EMPTY);
}

/* ---------- проблемні для фури місця на маршруті ---------- */
const NO_ENTRY = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#e5484d"/><rect x="6" y="10.5" width="12" height="3" rx="1" fill="#fff"/></svg>';
function drawHazards() {
  for (const m of hzMarks) m.remove(); hzMarks = [];
  const bad = map && map.getSource && map.getSource('route-bad'); if (!bad) return;
  const route = g.route || previewR;
  if (!route || S.mapHazards === false) { bad.setData(EMPTY); return; }
  const list = hazardsAlong(route), idx = indexOf(route), f = [];
  for (const x of list) {
    if (x.kind === 'u' || x.kind === 's') {
      const c = idx.slice(x.d0, Math.max(x.d1, x.d0 + 60));
      if (c.length >= 2) f.push({ type: 'Feature', properties: { k: x.kind }, geometry: { type: 'LineString', coordinates: c } });
      continue;
    }
    const tx = hazardText(x), el = document.createElement('div');
    el.className = 'hzm ' + x.level;
    if (x.kind === 'g' && x.value === 0) el.innerHTML = NO_ENTRY; else el.textContent = tx.tag;
    el.title = tx.title;
    hzMarks.push(new maplibregl.Marker({ element: el }).setLngLat([x.lon, x.lat]).addTo(map));
  }
  bad.setData({ type: 'FeatureCollection', features: f });
}

function drawPoi() {
  const src = map && map.getSource && map.getSource('poi'); if (!src) return;
  const f = [];
  // камери вздовж маршруту; стоянки малює загальний шар бази (або цей, якщо бази ще немає)
  if (S.cams && !(sdb.ready && S.mapStops)) for (const c of poi.cams) f.push({ type: 'Feature', properties: { k: 'cam' }, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } });
  if (S.stops && !sdb.ready) for (const s of poi.stops) if (s.score >= 2) f.push({ type: 'Feature', properties: { k: 'stop' }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
  src.setData({ type: 'FeatureCollection', features: f });
}
export function drawStops() {
  const src = map && map.getSource && map.getSource('stops'); if (!src) return;
  if (!sdb.ready || !S.mapStops) { src.setData(EMPTY); drawPoi(); return; }
  const on = S.mapStopTypes || {};
  const want = t => t === 'c' ? S.cams && on.cam !== false : t === 'e' ? on.food !== false : t === 'f' ? on.fuel !== false : t === 'm' ? on.motel !== false : t === 'h' ? on.shower !== false : on.park !== false;
  // точки з душем показуємо, навіть якщо їхній тип вимкнено, — коли ввімкнено «Душ»
  src.setData({ type: 'FeatureCollection', features: sdb.geo.features.filter(f => want(f.properties.t) || (f.properties.sh && on.shower !== false)) });
  drawPoi();
}

/* ---------- довге натискання: вибір точки на карті ---------- */
// Довге натискання на карту — меню точки («Я тут», «Їхати сюди»). Усе на подіях сторінки, а не карти:
// на повільному телефоні чи великому екрані події карти запізнюються, і «тягну карту» ставало «довгим натисканням».
function setupLongPress() {
  let tm = null, s0 = null;
  const cont = map.getCanvasContainer(), cancel = () => { clearTimeout(tm); tm = null; };
  cont.addEventListener('touchstart', ev => {
    cancel(); if (ev.touches.length !== 1) return;
    const t = ev.touches[0], t0 = Date.now(); s0 = { x: t.clientX, y: t.clientY };
    const fire = () => { tm = null; lpT = Date.now(); const r = cont.getBoundingClientRect(), ll = map.unproject([s0.x - r.left, s0.y - r.top]); bus.emit('mapPick', { lat: ll.lat, lon: ll.lng }); };
    // таймер спізнився (телефон був зайнятий малюванням) — спершу даємо дійти рухам пальця, що стоять у черзі
    tm = setTimeout(() => { tm = Date.now() - t0 > 850 ? setTimeout(fire, 150) : (fire(), null); }, 650);
  }, { capture: true, passive: true });
  cont.addEventListener('touchmove', ev => { const t = ev.touches[0]; if (tm && (ev.touches.length !== 1 || !t || Math.hypot(t.clientX - s0.x, t.clientY - s0.y) > 12)) cancel(); }, { capture: true, passive: true });
  cont.addEventListener('touchend', cancel, true); cont.addEventListener('touchcancel', cancel, true);
  map.on('movestart', e => { if (e.originalEvent) cancel(); });
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
