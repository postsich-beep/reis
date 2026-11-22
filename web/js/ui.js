// Головний екран і панелі «Рейс», «Події», «Чат».
import { bus, log, S, hav, fmtDist, fmtDur, fmtClock, fmtMS, RouteIndex } from './core.js';
import * as P from './platform.js';
import { pos, nudge, acceptPending, setManual, speedView, snapToRoute, setManualSpeed, manualSpeed, placeAtD, estimateNow } from './nav.js';
import { g, startTrip, stopTrip, rerouteNow, say, setVia, resumeActive } from './guide.js';
import { poi, stopsAhead, stopLabel, restore as restorePoi, snapshot as poiSnapshot } from './poi.js';
import { feed, strip, vote, markSeen, regionsAhead, setRouteContext, pollTelegram, pollAir, tgAvailable, activeChannels, feedLists, relLabel, zoneRegions, nearM } from './feed.js';
import { chat, send, voiceOnce, toggleLive, clearChat, errorText } from './chat.js';
import { hasKey } from './ai.js';
import { geocode, reverse, buildRoute, regionsAlong, newTrip, saveTrip, deleteTrip, getTrips, tripTitle, oblastName, mainRoads } from './route.js';
import { view, setFollow, zoomBy, previewRoute, previewAlts, fitRoutes, freeView, showRoute, showPick, prefetchRoute, applyTheme, ROUTE_COLORS, flyTo } from './map.js';
import * as mapM from './map.js';
import { hz, load as loadHazards, routeCats, hazardsAlong, hazardText, kyivOnRoute, indexOf as indexOfRoute } from './roads.js';
import { heatAlong, heatApplies } from './weather.js';
import * as rough from './rough.js';
import * as showers from './showers.js';
import { offlineActive } from './offline.js';
import { sdb, TYPES, F, nearbyRows } from './stopsdb.js';
import * as places from './places.js';
import { exportGpx, track, trackKm } from './track.js';
import { vp, byId as byIdVp, listed as vpListed, whereIs as vpWhere, txt as vpTxt, onMap as vpOnMap, setLocation as vpSetLocation } from './vplaces.js';
import { $, ICON, manIcon, toast, definePanel, openPanel, closePanel, refresh, currentPanel, esc, applyGlass } from './ui_base.js';
import { t } from './i18n.js';
import { reps, report, REP_TYPES, REP_SVG, repName, repAgo } from './reports.js';
import { limitNow, overLimit } from './limits.js';

/* =====================  ГОЛОВНИЙ ЕКРАН  ===================== */
function layoutVars() {
  const r = document.documentElement.style;
  r.setProperty('--th', Math.round($('top').getBoundingClientRect().height) + 'px');
  r.setProperty('--bh', Math.round($('bottom').getBoundingClientRect().height) + 'px');
}

function staticLabels() {
  $('spdUnit').textContent = t('kmh');
  $('bBack100').innerHTML = ICON.down + '100'; $('bBack100').setAttribute('aria-label', t('back100'));
  $('bFwd100').innerHTML = ICON.up + '100'; $('bFwd100').setAttribute('aria-label', t('fwd100'));
  $('camLbl').textContent = t('camera');
  $('manThenLbl').textContent = t('then');
  const tabs = document.querySelectorAll('#tabs button[data-panel]');
  const names = { trip: 'tabTrip', feed: 'tabFeed', places: 'tabPlaces', gps: 'tabGps', settings: 'qSettings' };
  const icons = { trip: ICON.route, feed: ICON.feed, places: ICON.places, gps: ICON.gpsSig, settings: ICON.gear };
  tabs.forEach(b => { const p = b.dataset.panel; b.innerHTML = (p === 'trip' ? `<span class="mc">${icons[p]}</span>` : p === 'gps' ? `<span class="gc">${icons[p]}</span>` : icons[p]) + `<span${p === 'gps' ? ' id="tabGpsL"' : ''}>` + t(names[p]) + '</span>'; });
  $('panelClose').innerHTML = ICON.x; $('panelBack').innerHTML = ICON.back;
  $('bCenter').innerHTML = ICON.center; $('bCenter').setAttribute('aria-label', t('qCenter'));
  $('bQuick').setAttribute('aria-label', t('quickTitle'));
  railState();
}
/* ---------- «Шари карти»: галочки, що показувати на карті; усе вимкнути — чиста карта ---------- */
const LAYERS = [
  ['fuel', 'f', 'lyFuel'], ['food', 'e', 'lyFood'], ['park', 'p', 'lyPark'], ['motel', 'm', 'lyMotel'], ['shower', 'h', 'lyShower'], ['cam', 'c', 'lyCam'],
  ['@mapVerified', '', 'lyVerified'], ['@mapEvents', '', 'lyEvents'], ['@mapHazards', '', 'lyHazards'], ['@roughMap', '', 'lyRough']
];
const layerOn = k => k[0] === '@' ? S[k.slice(1)] !== false : S.mapStops !== false && (S.mapStopTypes || {})[k] !== false;
function setLayer(k, v) {
  if (k[0] === '@') { S[k.slice(1)] = v; return; }
  const m = { ...(S.mapStopTypes || {}) }; m[k] = v;
  if (v && S.mapStops === false) {                     // увімкнули один шар після «вимкнути все» в налаштуваннях — інші лишаються вимкненими
    for (const [kk] of LAYERS) if (kk[0] !== '@' && kk !== k) m[kk] = false;
    S.mapStops = true;
  }
  S.mapStopTypes = m;
  if (k === 'cam' && v && !S.cams) S.cams = true;
}
function layersHtml() {
  const dot = (ty, k) => k === '@mapVerified' ? '<span class="sdot" style="background:#f5a524;border-color:#f5b301"></span>' : k === '@mapEvents' ? '<span class="sdot" style="background:var(--red)"></span>'
    : k === '@mapHazards' ? '<span class="sdot hz">20</span>' : k === '@roughMap' ? '<span class="sdot" style="background:linear-gradient(90deg,#2f9e62 33%,#f6bd16 33% 66%,#e5484d 66%)"></span>'
    : `<span class="sdot" style="background:${TYPES[ty].color}${ty === 'c' ? ';border-color:#e5484d' : ty === 'h' ? ';border-color:#06b6d4' : ''}"></span>`;
  const anyOn = LAYERS.some(([k]) => layerOn(k));
  return `<div class="ly-head">${t('lyTitle')}</div>` + LAYERS.map(([k, ty, lbl]) => {
    const on = layerOn(k);
    return `<button class="ly-row${on ? ' on' : ''}" data-ly="${k}" role="checkbox" aria-checked="${on}">${dot(ty, k)}<span class="grow">${t(lbl)}</span><span class="ly-box">${on ? ICON.check : ''}</span></button>`;
  }).join('') + `<button class="btn sm wide" data-ly="${anyOn ? '#off' : '#on'}">${anyOn ? t('lyAllOff') : t('lyAllOn')}</button>`;
}
function layersClick(e) {
  const b = e.target.closest('[data-ly]'); if (!b) return false;
  const k = b.dataset.ly;
  if (k === '#off' || k === '#on') { const v = k === '#on'; const m = {}; for (const [kk] of LAYERS) if (kk[0] !== '@') m[kk] = v; if (v) S.mapStops = true; S.mapStopTypes = m; S.mapEvents = v; S.mapHazards = v; S.roughMap = v; S.mapVerified = v; }
  else setLayer(k, !layerOn(k));
  return true;
}

/* ---------- швидкі налаштування: одна кнопка → шторка з великими плитками (як шторка Android) ----------
   Звук, 3D, північ/курс, моє місце, шари, запис, тема, екран, налаштування, масштаб. Сама ховається за 15 с без дотиків,
   щоб у дорозі не лишилась відкритою. Значок на кнопці показує, що звук вимкнено чи йде запис. */
const Q_IDLE = 15000;
let quickView = 'main', quickTimer = null;
const THEME_NEXT = { auto: 'day', day: 'night', night: 'auto' };
function quickHtml() {
  const head = (title, back) => `<div class="q-head">${back ? `<button class="q-x" data-q="back" aria-label="${t('back')}">${ICON.back}</button>` : ''}<b>${title}</b><button class="q-x" data-q="close" aria-label="${t('close')}">${ICON.x}</button></div>`;
  if (quickView === 'layers') return head(t('lyTitle'), true) + `<div class="q-ly">${layersHtml().replace(/^<div class="ly-head">.*?<\/div>/, '')}</div>`;
  const tile = (k, icon, label, state, on, extra = '') => `<button class="q-tile${on ? ' on' : ''}${extra}" data-q="${k}" aria-pressed="${!!on}">${icon}<span class="q-l">${label}</span><span class="q-s">${state}</span></button>`;
  const nOn = LAYERS.filter(([k]) => layerOn(k)).length, th = S.theme || 'auto';
  return head(t('quickTitle')) + `<div class="q-grid">
    ${tile('voice', S.voice ? ICON.vol : ICON.mute, t('qVoice'), S.voice ? t('qOn') : t('qOff'), S.voice, S.voice ? '' : ' warn')}
    ${tile('3d', `<b class="q-txt">${S.view3d ? '3D' : '2D'}</b>`, t('qView'), S.view3d ? t('q3d') : t('q2d'), S.view3d)}
    ${tile('north', view.north ? ICON.north : ICON.head, t('qOrient'), view.north ? t('qNorthUp') : t('qHeadUp'), view.north)}
    ${tile('center', ICON.center, t('qCenter'), view.follow ? t('qFollowOn') : t('qFollowOff'), view.follow)}
    ${tile('layers', ICON.layers, t('qLayers'), nOn + ' / ' + LAYERS.length, false)}
    ${tile('rec', ICON.rec, t('qRec'), S.rec ? t('qRecOn') : t('qOff'), S.rec, S.rec ? ' rec' : '')}
    ${tile('theme', th === 'night' ? ICON.moon : th === 'day' ? ICON.sun : ICON.auto, t('qTheme'), t(th === 'night' ? 'themeNight' : th === 'day' ? 'themeDay' : 'themeAuto'), false)}
    ${tile('awake', ICON.awake, t('qAwake'), S.keepAwake !== false ? t('qAwakeOn') : t('qAwakeOff'), S.keepAwake !== false)}
    ${tile('settings', ICON.gear, t('qSettings'), t('qAll'), false)}
  </div>
  <div class="q-zoom"><button data-q="zout" aria-label="${t('qZoomOut')}">−</button><span>${t('qZoom')}</span><button data-q="zin" aria-label="${t('qZoomIn')}">+</button></div>`;
}
function quickRender() { const box = $('quick'); if (!box.hidden) box.innerHTML = quickHtml(); }
function quickIdle() { clearTimeout(quickTimer); quickTimer = setTimeout(() => quickOpen(false), Q_IDLE); }
export function quickOpen(open) {
  const box = $('quick');
  if (open) { quickView = 'main'; box.hidden = false; box.innerHTML = quickHtml(); $('spdPop').hidden = true; quickIdle(); }
  else { box.hidden = true; clearTimeout(quickTimer); }
  $('bQuick').classList.toggle('on', !!open); $('bQuick').setAttribute('aria-expanded', String(!!open));
}
function quickClick(e) {
  quickIdle();
  if (quickView === 'layers' && layersClick(e)) { quickRender(); return; }
  const b = e.target.closest('[data-q]'); if (!b) return;
  const k = b.dataset.q;
  if (k === 'close') return quickOpen(false);
  if (k === 'back') { quickView = 'main'; return quickRender(); }
  if (k === 'layers') { quickView = 'layers'; return quickRender(); }
  if (k === 'voice') { S.voice = !S.voice; if (!S.voice) P.stopSpeak(); toast(t(S.voice ? 'voiceOn' : 'voiceOff'), '', 1800); }
  else if (k === '3d') { S.view3d = !S.view3d; setFollow(true); }
  else if (k === 'north') { view.north = !view.north; setFollow(true); }
  else if (k === 'center') { setFollow(true); quickOpen(false); return; }
  else if (k === 'rec') toggleRec();
  else if (k === 'theme') { S.theme = THEME_NEXT[S.theme || 'auto']; applyTheme(); }
  else if (k === 'awake') { S.keepAwake = S.keepAwake === false; P.keepAwake(S.keepAwake); }
  else if (k === 'settings') { quickOpen(false); currentPanel() === 'settings' ? closePanel() : openPanel('settings'); return; }
  else if (k === 'zin') zoomBy(1);
  else if (k === 'zout') zoomBy(-1);
  quickRender();
}
function toggleRec() {
  S.rec = !S.rec;
  if (S.rec) toast(t('recOn'), '', 2500);
  else if (track.pts.length > 1) { const n = exportGpx(); toast(n ? t('recSaved', trackKm().toFixed(1), n) : t('recOff'), 'green', 6000); }
  else toast(t('recOff'), '', 2000);
}

function railState() {
  const qb = $('bQuick');
  qb.innerHTML = ICON.quick + (!S.voice ? `<i class="q-badge mute">${ICON.mute}</i>` : S.rec ? '<i class="q-badge rec"></i>' : '');
  qb.classList.toggle('muted', !S.voice);
  const c = $('bCenter'), need = !view.follow;
  if (c.hidden === need) { c.hidden = !need; c.classList.toggle('need', need); }
  quickRender();
}

const WHY = { timeout: 'whyTimeout', spoof: 'whySpoof', weak: 'whyWeak', manual: 'whyManual' };
let lostShown = null;
export const lostReason = () => t(WHY[pos.reason] || 'whyTimeout') + ' ' + (pos.onRoute ? t('drRoute') : t('drFree'));
export const locState = { known: false, enabled: null, gps: null, fine: null, listening: false, error: '' };
let searchSince = Date.now(), indoorHinted = false, offWarned = false;
const accText = a => a == null ? '' : a >= 1000 ? (a / 1000).toFixed(1).replace('.', ',') + ' ' + t('km') : a + ' ' + t('m');
function hud() {
  // швидкість
  const sv = speedView(), sp = $('speed'), kmh = sv.kmh || 0;
  const guess = sv.kind === 'approx' || sv.kind === 'est' || sv.kind === 'manual' || sv.kind === 'plan';
  $('spdVal').textContent = sv.kind === 'none' ? '—' : (guess ? '≈' : '') + (kmh < 2 ? '0' : Math.round(kmh));
  $('spdUnit').textContent = sv.kind === 'none' ? t('spdUnknown') : sv.kind === 'est' ? t('spdEst') : sv.kind === 'plan' ? t('spdPlan') : sv.kind === 'approx' ? t('spdNet') : sv.kind === 'manual' ? t('spdManual') : sv.kind === 'still' && manualSpeed() === 0 ? t('standShort') : t('kmh');
  sp.classList.toggle('est', sv.kind !== 'gps' && sv.kind !== 'still');
  sp.classList.toggle('wide', guess);
  const cam = S.cams ? poi.nextCam : null;
  // червоний — коли перевищено більш ніж на 20 км/год (з цього починається штраф); без GPS — червоно-помаранчевий
  const lim = limitNow(), over = sv.kind !== 'none' && overLimit(kmh, lim);
  sp.classList.toggle('over', over);
  const ls = $('spdLim'); ls.hidden = !lim || lim.src === 'cam'; if (lim) ls.textContent = lim.max;
  $('cam').hidden = !cam;
  if (cam) { $('camMax').innerHTML = cam.max ? cam.max : ICON.cam; $('camDist').textContent = fmtDist(Math.max(0, cam.ahead)); }

  // стан GPS
  const chip = $('gpsChip');
  const off = locState.enabled === false && !pos.sim;
  const spoofNow = Date.now() - pos.spoofAt < 30000 && pos.mode !== 'gps' && pos.mode !== 'dr';
  if (off) { chip.className = 'chip lost'; $('gpsText').textContent = t('locOffChip'); }
  else if (spoofNow) { chip.className = 'chip lost'; $('gpsText').textContent = t('spoofChip'); }
  else if (pos.mode === 'dr') { chip.className = 'chip lost'; $('gpsText').textContent = 'GPS ✕'; }
  else if (pos.mode === 'gps') { const weak = pos.acc != null && pos.acc > 30; chip.className = 'chip' + (weak ? ' weak' : ''); $('gpsText').textContent = pos.acc != null ? '±' + accText(pos.acc) : 'GPS'; }
  else if (pos.mode === 'approx') { chip.className = 'chip weak'; $('gpsText').textContent = '≈ ±' + accText(pos.acc); }
  else { chip.className = 'chip none'; $('gpsText').textContent = t('gpsWait'); }
  // кружечок GPS у нижній панелі: є справжній GPS — зелений, немає — червоний
  const gOk = pos.mode === 'gps' && !off && !spoofNow, tg = $('tabGps');
  if (tg) { tg.classList.toggle('g-ok', gOk); tg.classList.toggle('g-bad', !gOk); const l = $('tabGpsL'); if (l) l.textContent = gOk ? (pos.acc != null ? '±' + accText(pos.acc) : 'GPS') : pos.mode === 'dr' ? 'GPS ✕' : off ? t('locOffChip') : t('tabNoGps'); }
  // GPS шукає вже хвилину, а геолокація ввімкнена — швидше за все, телефон у приміщенні
  if (pos.mode === 'gps' || pos.mode === 'dr' || pos.sim) searchSince = Date.now();
  else if (!indoorHinted && !off && Date.now() - searchSince > 60000) { indoorHinted = true; toast(t('gpsIndoor'), 'yellow', 12000, () => openPanel('gps')); }

  // режим втрати сигналу
  const lost = pos.mode === 'dr';
  if (lost !== lostShown) {
    lostShown = lost;
    $('nudge').hidden = !lost; $('lostLine').hidden = !lost; $('gpsChip').hidden = lost;
    if (!lost) $('bAcceptGps').hidden = true;
    requestAnimationFrame(layoutVars);
  }
  if (lost) {
    const ms = manualSpeed();
    $('lostLine').textContent = 'GPS ✕ ' + fmtMS((Date.now() - pos.lostSince) / 1000) + ' · ±' + accText(pos.acc)
      + (pos.reason === 'spoof' ? ' · ' + t('spoofShort') : pos.reason === 'manual' ? ' · ' + t('manualShort') : '')
      + (pos.onRoute ? ' · ' + t('onRouteShort') : '') + (ms != null ? ' · ' + (ms === 0 ? t('standShort') : ms + ' ' + t('kmh')) : '');
    const b = $('bAcceptGps'), show = !!pos.pending;
    if (b.hidden === show) { b.hidden = !show; requestAnimationFrame(layoutVars); }
    if (show) b.textContent = pos.reason === 'manual' ? t('backToGps') : t('acceptGps', fmtDist(pos.pending.d));
  }

  // картка маневру
  const man = $('man'), stripEl = $('strip');
  let show = false;
  man.classList.remove('info', 'off');
  if (g.arrived) { show = true; man.classList.add('info'); $('manIco').innerHTML = manIcon(4); $('manDist').textContent = t('arrived'); $('manText').textContent = g.trip ? (g.trip.b.label || '') : ''; $('manThen').hidden = true; }
  else if (g.active && g.route) {
    show = true;
    if (g.rerouting) { man.classList.add('info'); $('manIco').innerHTML = manIcon(8); $('manDist').textContent = t('rerouting'); $('manText').textContent = ''; $('manThen').hidden = true; }
    else if (pos.mode === 'approx' && !pos.onRoute) {          // GPS немає чи підмінено, а вишки — не на маршруті: пропонуємо стати на маршрут
      man.classList.add('info');
      $('manIco').innerHTML = manIcon(8); $('manDist').textContent = t('noGpsRoute');
      $('manText').textContent = t('noGpsRouteSub'); $('manThen').hidden = true;
    } else if (g.offRoute || pos.rd == null) {
      man.classList.add('info'); if (g.offRoute) man.classList.add('off');
      $('manIco').innerHTML = manIcon(8); $('manDist').textContent = g.offRoute ? t('offRoute') : t('toRoute');
      $('manText').textContent = pos.off ? fmtDist(pos.off) : ''; $('manThen').hidden = true;
    } else if (g.next) {
      $('manIco').innerHTML = manIcon(g.next.type) + (g.next.type === 26 && g.next.exits ? '' : '');
      $('manDist').textContent = fmtDist(g.distNext);
      $('manText').textContent = g.next.street || g.next.ins;
      const then = g.after && (g.after.d0 - g.next.d0) < 350 && g.next.type !== 4;
      $('manThen').hidden = !then; if (then) $('manThenIco').innerHTML = manIcon(g.after.type);
    } else { $('manIco').innerHTML = manIcon(4); $('manDist').textContent = fmtDist(g.remain); $('manText').textContent = g.trip.b.label || ''; $('manThen').hidden = true; }
  }
  // «На маршрут»: рейс іде, а GPS ненадійний — одним дотиком ставимо позначку на маршрут і ведемо без GPS
  const snapOn = g.active && !!g.route && pos.mode !== 'gps' && (pos.mode === 'approx' || !pos.onRoute);
  const sb = $('manSnap');
  if (sb.hidden === snapOn) { sb.hidden = !snapOn; if (snapOn) sb.innerHTML = ICON.pin + '<span>' + t('snapRoute') + '</span>'; }
  if (man.hidden === show) { man.hidden = !show; stripEl.classList.toggle('alone', !show); stripUpdate(); requestAnimationFrame(layoutVars); }

  // нижній рядок
  if (g.arrived) { $('eta').textContent = fmtClock(new Date()); $('remain').textContent = t('tripDone'); }
  else if (g.active && g.route) { $('eta').textContent = fmtClock(new Date(g.eta)); $('remain').textContent = fmtDist(g.remain) + ' · ' + fmtDur(g.remTime); }
  else if (plan.trip && plan.trip.route) { const r = plan.trip.route; $('eta').textContent = fmtClock(new Date()); $('remain').textContent = fmtDist(r.dist) + ' · ' + fmtDur(r.time) + ' · ' + t('previewReady'); }
  else { $('eta').textContent = fmtClock(new Date()); $('remain').textContent = ''; }
}

/* ---------- рейс без «Поїхали»: водій побудував маршрут і просто поїхав ним — вмикаємо ведення самі ---------- */
let followSince = 0, followHint = 0;
function autoStart() {
  if (g.active || !plan.trip || !plan.trip.route || pos.mode !== 'gps' || pos.sim) { followSince = 0; return; }
  const idx = indexOfRoute(plan.trip.route), loc = idx && idx.locate(pos, followHint);
  const on = loc && loc.off < 50 && pos.spd > 4;
  if (!on) { followSince = 0; return; }
  followHint = loc.d;
  if (!followSince) { followSince = Date.now(); return; }
  if (Date.now() - followSince < 15000) return;
  followSince = 0;
  const trip = plan.trip;
  toast(t('autoStarted'), 'green', 6000);
  goTrip(trip, { onRoute: true });
}
// «Де ви зараз?» — список місць на маршруті, найближчі до оцінки зверху
function whereHtml() {
  const e = estimateNow(), list = [];
  if (e) list.push({ d: 'est', name: t('whereEst'), sub: fmtDist(e.d) + ' ' + t('fromStart') });
  list.push({ d: 0, name: t('whereStart'), sub: (g.trip && g.trip.a && g.trip.a.label) || '' });
  const towns = ((g.trip && g.trip.towns) || []).filter(x => x.d > 500);
  const ref = e ? e.d : 0;
  towns.sort((a, b) => Math.abs(a.d - ref) - Math.abs(b.d - ref));
  for (const x of towns.slice(0, 7).sort((a, b) => a.d - b.d)) list.push({ d: x.d, name: x.name, sub: fmtDist(x.d) + ' ' + t('fromStart') });
  if (g.route && g.route.viaD) list.push({ d: g.route.viaD, name: (g.trip.v && g.trip.v.label) || t('via'), sub: fmtDist(g.route.viaD) + ' ' + t('fromStart') });
  return `<div class="ly-head">${t('whereTitle')}</div>` + list.map(x => `<button class="ly-row" data-d="${x.d}"><span class="grow">${esc(x.name)}<small class="muted" style="display:block;font-size:13px">${esc(x.sub)}</small></span></button>`).join('') +
    `<div class="muted" style="margin:6px 4px 2px;font-size:13px">${t('whereHint')}</div>`;
}
// Рейс, що йшов до перезапуску чи оновлення, — продовжуємо, ніби нічого не сталося.
export async function resumeTrip() {
  if (!(await resumeActive())) return false;
  const tr = g.trip;
  restorePoi(tr.cams, tr.stops); setRouteContext(tr.regions, tr.towns);
  setFollow(true); P.keepAwake(S.keepAwake !== false);
  toast(t('tripResumed'), 'green', 5000);
  return true;
}

// Шторка під карткою маневру: лише те, що тут і попереду. Коли нічого немає — ховається, щоб не закривати карту
// (без рейсу лишається маленькою плашкою — нею відкривається стрічка).
function stripUpdate() {
  const s = strip(), el = $('strip');
  const off = !S.lookahead, calm = off || !s.top, manOn = !$('man').hidden;
  el.dataset.level = s.top && !off ? s.top.level : 'none';
  el.classList.toggle('calm', calm);
  const hide = calm && manOn;
  if (el.hidden !== hide) { el.hidden = hide; $('top').classList.toggle('nostrip', hide); requestAnimationFrame(layoutVars); }
  $('stripText').textContent = off ? t('stripOff') : s.top ? ((s.label ? s.label + ' · ' : '') + (s.top.sum || s.top.text)).replace(/\s+/g, ' ').slice(0, 140) : t('stripEmpty');
  const c = s.counts;
  $('stripCounts').innerHTML = off ? '' : ['red', 'yellow', 'green'].filter(k => c[k]).map(k => `<i class="c-${k}">${c[k]}</i>`).join('');
  const tab = document.querySelector('#tabs button[data-panel="feed"]');
  if (tab) { let b = tab.querySelector('.badge'); if (s.unseen && !off) { if (!b) { b = document.createElement('span'); b.className = 'badge'; tab.appendChild(b); } b.textContent = s.unseen; } else if (b) b.remove(); }
}

/* =====================  ПАНЕЛЬ «РЕЙС»  ===================== */
const plan = { a: null, v: null, b: null, trip: null, busy: false, err: '', sugg: [], field: null, regBusy: false, off: null, routes: [], sel: 0 };
let geoTimer = null;

function summaryHtml(trip) {
  const r = trip.route;
  const regs = (trip.regions || []).map(x => `<span class="pill${feed.air[x.id] ? ' air' : ''}">${esc(oblastName(x.id))}</span>`).join('');
  const fx = (trip.foreign || []).map(c => t('cc_' + c) !== 'cc_' + c ? t('cc_' + c) : c).join(', ');
  const foreign = fx ? `<div style="margin-top:10px;padding:10px;border-radius:12px;background:var(--red);color:#fff;font-weight:600">${esc(t('routeForeign', fx))}</div>` : '';
  return `<div class="kv"><div><b>${fmtDist(r.dist)}</b><span>${t('distance')}</span></div><div><b>${fmtDur(r.time)}</b><span>${t('driveTime')}</span></div><div><b>${fmtClock(new Date(Date.now() + r.time * 1000))}</b><span>${t('arrival')}</span></div></div>
  <div style="margin-top:10px">${regs || (plan.regBusy ? `<span class="muted">${t('regionsLoading')}</span>` : '')}</div>${foreign}`;
}
function offlineHtml() {
  const o = plan.off; if (!o) return '';
  if (o.running) return `<div class="muted" style="margin-top:8px">${t('offProgress', o.done, o.total, (o.bytes / 1e6).toFixed(1))}</div><div class="prog"><i style="width:${o.total ? Math.round(o.done / o.total * 100) : 0}%"></i></div>`;
  if (o.error) return `<div class="muted" style="margin-top:8px">${t('offError')} ${esc(o.error)}</div>`;
  return `<div class="muted" style="margin-top:8px">${t('offDone', o.done, (o.bytes / 1e6).toFixed(1))}${o.cut ? ' ' + t('offCut') : ''}</div>`;
}
async function runOffline(route) {
  if (plan.off && plan.off.running) return;
  const idx = new RouteIndex(route.coords), ctl = { stop: false };
  plan.off = { running: true, done: 0, total: 0, bytes: 0, ctl };
  try {
    const r = await prefetchRoute(idx, (done, total, bytes) => { Object.assign(plan.off, { done, total, bytes }); refresh('trip'); }, ctl);
    plan.off = { running: false, ...r };
    log('info', `офлайн-карта маршруту: ${r.done} тайлів, ${(r.bytes / 1e6).toFixed(1)} МБ, помилок ${r.fail}`);
  } catch (e) { plan.off = { running: false, error: e.message, done: 0, bytes: 0 }; log('warn', 'офлайн-карта: ' + e.message); }
  refresh('trip');
}
async function loadRegions(trip) {
  if (plan.regBusy || (trip.regions && trip.regions.length) || !P.online()) return;
  plan.regBusy = true; refresh('trip');
  try {
    const r = await regionsAlong(new RouteIndex(trip.route.coords));
    trip.regions = r.regions; trip.towns = r.towns; trip.foreign = r.foreign || [];
    if (getTrips().some(x => x.id === trip.id)) saveTrip(trip);
    if (g.trip && g.trip.id === trip.id) setRouteContext(trip.regions, trip.towns);
  } catch (e) { log('warn', 'регіони: ' + e.message); }
  plan.regBusy = false; refresh('trip');
}

/* ---------- «Для фури на маршруті»: категорії доріг, Київ у години пік, спека, проблемні місця ---------- */
const NO_ENTRY_ICO = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#e5484d"/><rect x="6" y="10.5" width="12" height="3" rx="1" fill="#fff"/></svg>';
const SUN_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M5.2 18.8 7 17M17 7l1.8-1.8"/></svg>';
const heatBusy = new WeakSet();
function ensureRouteInfo(route) {
  if (!route) return;
  loadHazards();
  const fresh = route.heat && Date.now() - (route.heat.at || 0) < 3600e3;   // прогноз на маршрут — не старший за годину
  if (!fresh && !heatBusy.has(route) && S.weather && P.online()) {
    heatBusy.add(route);
    heatAlong(route).then(h => { heatBusy.delete(route); if (h) route.heat = h; else route.heat = { maxT: null, first: null, at: Date.now() }; refresh('trip'); });
  }
}
function truckHtml(route, fromD, etaAt) {
  if (!route) return '';
  ensureRouteInfo(route);
  const items = [];
  const ky = kyivOnRoute(route, fromD, etaAt);
  if (ky && !ky.inside) items.push({ level: ky.rush ? 'red' : 'green', ico: 'К', title: t(ky.rush ? 'kyivRush' : 'kyivOk', fmtClock(ky.when)), sub: t('kyivRule'), d: ky.d });
  const h = route.heat && route.heat.first;
  if (h && h.d + 1 >= fromD) {
    if (heatApplies()) items.push({ level: 'yellow', ico: SUN_ICO, title: t('heatTitle', Math.round(route.heat.maxT), fmtClock(new Date(h.when))) + (h.town ? ' · ' + h.town : ''), sub: t('heatRule'), d: h.d });
    else items.push({ level: 'green', ico: SUN_ICO, title: t('heatExemptOk', Math.round(route.heat.maxT)), sub: '', d: h.d });
  }
  const rb = S.rough ? rough.badAlong(indexOfRoute(route)) : null;
  if (rb && rb.d + rb.m >= fromD) items.push({ level: 'yellow', ico: '≈', title: t('roughOnRoute', (rb.m / 1000).toFixed(1).replace('.', ',')), sub: t('roughOnRouteSub'), d: Math.max(rb.d, fromD) });
  for (const x of hazardsAlong(route)) {
    if (x.d1 < fromD) continue;
    const tx = hazardText(x);
    items.push({ level: x.level, ico: x.kind === 'g' && x.value === 0 ? NO_ENTRY_ICO : esc(tx.tag || '≈'), title: tx.title, sub: [x.name, tx.sub].filter(Boolean).join(' · '), d: Math.max(x.d0, fromD) });
  }
  items.sort((a, b) => a.d - b.d);
  const rc = S.routeCats !== false ? routeCats(route) : null;
  const bar = rc && rc.share ? `<div class="card"><div class="roadbar">${['a', 'b', 'c'].map(k => `<i style="width:${(rc.share[k] * 100).toFixed(1)}%;background:${ROUTE_COLORS[k]}"></i>`).join('')}</div>
    <div class="muted">${['a', 'b', 'c'].filter(k => rc.share[k] >= 0.005).map(k => `<span style="white-space:nowrap;margin-right:10px"><span class="rdot" style="background:${ROUTE_COLORS[k]}"></span>${t('cat_' + k)} ${Math.round(rc.share[k] * 100)}%</span>`).join('')}</div></div>` : '';
  const list = items.length
    ? `<div class="list" style="margin-top:8px">${items.map(x => `<div class="item hz-item ${x.level}"><div class="hz-ico ${x.level}">${x.ico}</div><div class="grow"><div class="t">${esc(x.title)}</div>${x.sub ? `<div class="muted">${esc(x.sub)}</div>` : ''}</div><b style="font:800 18px var(--f-num);white-space:nowrap">${fmtDist(Math.max(0, x.d - fromD))}</b></div>`).join('')}</div>`
    : `<div class="muted" style="margin-top:8px">${hz.ready ? t('hzNone') : t('hzNoData')}</div>`;
  const src = hz.ready ? `<div class="muted" style="margin-top:6px">${t('hzSrc', hz.date ? hz.date.slice(6, 8) + '.' + hz.date.slice(4, 6) + '.' + hz.date.slice(0, 4) : '')}</div>` : '';
  return `<div class="sec">${t('truckSec')}</div>${bar}${list}${src}`;
}

/* ---------- душ: попереду на маршруті або найближчий ---------- */
function showerKind(x) { return x.kind === 'mine' ? t('showerMineShort') : t(STOP_T[x.kind] || 'stop_shower') + (x.mine ? ' · ' + t('showerMineShort') : ''); }
function showerItems(list, distOf) {
  return list.map(x => `<div class="item hz-item sh-item" data-shlat="${x.lat}" data-shlon="${x.lon}"><div class="hz-ico sh">${ICON.shower}</div><div class="grow"><div class="t">${esc(x.name || t('stop_shower'))}</div><div class="muted">${esc(showerKind(x))}${x.off > 300 ? ' · ' + t('showerOff', fmtDist(x.off)) : ''}</div></div><b style="font:800 18px var(--f-num);white-space:nowrap">${fmtDist(distOf(x))}</b></div>`).join('');
}
function showersRouteHtml(route, idx, fromD) {
  const list = showers.along(route, idx).filter(x => x.d >= fromD - 200).slice(0, 3);
  return `<div class="sec">${t('showerSec')}</div>` + (list.length
    ? `<div class="list">${showerItems(list, x => Math.max(0, x.d - fromD))}</div>`
    : `<div class="muted">${sdb.ready ? t('showerNoneRoute') : t('loading')}</div>`);
}
function showersNearHtml() {
  if (pos.lat == null || !sdb.ready) return '';
  const list = showers.nearest(pos, 2); if (!list.length) return '';
  return `<div class="sec">${t('showerNear')}</div><div class="list">${showerItems(list, x => x.dist)}</div><div class="muted" style="margin-top:6px">${t('showerHint')}</div>`;
}

function tripActiveHtml() {
  const tr = g.trip;
  const st = stopsAhead(3).slice(0, 3).map(s => { const l = stopLabel(s); return `<div class="item"><div class="grow"><div class="t">${esc(l.title)}</div><div class="muted">${esc(l.sub)}</div></div><b style="font:800 20px var(--f-num)">${fmtDist(Math.max(0, s.d - (pos.rd || 0)))}</b></div>`; }).join('');
  const regs = regionsAhead().map(r => `<span class="pill${feed.air[r.id] ? ' air' : ''}">${esc(oblastName(r.id))}${r.eta > 60 ? ' · ' + fmtDur(r.eta) : ''}</span>`).join('');
  return `<div class="card"><div class="t" style="font-weight:600;margin-bottom:10px">${esc(tripTitle(tr))}</div>
    <div class="kv"><div><b>${fmtDist(g.remain)}</b><span>${t('remainL')}</span></div><div><b>${fmtDur(g.remTime)}</b><span>${t('driveTime')}</span></div><div><b>${g.arrived ? '—' : fmtClock(new Date(g.eta))}</b><span>${t('arrival')}</span></div></div>
    ${regs ? `<div style="margin-top:10px">${regs}</div>` : ''}${offlineHtml()}</div>
  <div class="btns"><button class="btn" data-act="reroute">${t('reroute')}</button><button class="btn" data-act="rerouteFresh">${t('rerouteFresh')}</button></div>
  <div class="btns"><button class="btn" data-act="offline">${t('offlineMap')}</button></div>
  <div class="btns"><button class="btn danger wide" data-act="stop">${t('endTrip')}</button></div>
  ${poi.drive > 300 ? `<div class="sec">${t('driveSec')}</div><div class="card">${t('driveNow', fmtDur(poi.drive))}</div>` : ''}
  <div class="sec">${t('stopsSec')}</div><div class="list">${st || `<div class="muted">${poi.loading ? t('loading') : t('stopsNone')}</div>`}</div>
  ${showersRouteHtml(g.route, g.idx, pos.rd || 0)}
  ${truckHtml(g.route, pos.rd || 0, d => Date.now() + Math.max(0, d - (pos.rd || 0)) / Math.max(1, g.remain) * g.remTime * 1000)}`;
}
function savedHtml() {
  const list = getTrips().filter(x => !g.trip || x.id !== g.trip.id);
  if (!list.length) return '';                                       // порожньо — нічого не показуємо
  return `<div class="sec">${t('savedSec')}</div><div class="list">` + list.map(x => `<div class="item"><div class="grow"><div class="t">${esc(tripTitle(x))}</div><div class="muted">${x.route ? fmtDist(x.route.dist) + ' · ' + fmtDur(x.route.time) : ''}</div></div>
    <button class="btn sm pri" data-open="${x.id}">${t('open')}</button><button class="btn sm" data-del="${x.id}" aria-label="${t('delete')}">${ICON.trash}</button></div>`).join('') + '</div>';
}
function fieldHtml(k, cls, tag, ph) {
  const v = plan[k];
  return `<div class="field"><div class="tag ${cls}">${tag}</div><input id="in_${k}" data-f="${k}" placeholder="${esc(ph)}" value="${esc(v ? v.label : '')}" autocomplete="off" enterkeyhint="search">
    ${k === 'a' ? `<button data-here="1" aria-label="${t('myPlace')}">${ICON.here}</button>` : `<button data-clear="${k}" aria-label="${t('clear')}">${ICON.x}</button>`}</div><div class="sugg" id="sg_${k}" hidden></div>`;
}
function planHtml() {
  // Лише три точки: А — звідки, Б — через (проміжна, необов'язково), С — куди. Нічого зайвого (душі тощо — на карті й у дорозі).
  return `<div id="planSum">${plan.trip ? planSumHtml() : ''}</div><div class="sec">${t('newTrip')}</div>
    ${fieldHtml('a', 'a', 'А', t('phA'))}${fieldHtml('v', 'v', 'Б', t('phV'))}${fieldHtml('b', 'b', 'С', t('phB'))}
    ${vehHtml()}
    <div class="btns"><button class="btn pri wide" data-act="build" ${plan.busy ? 'disabled' : ''}>${plan.busy ? t('building') : t('build')}</button></div>
    <div id="planErr" class="muted" style="color:var(--red);margin-top:8px">${esc(plan.err)}</div>
    <div id="savedBox">${savedHtml()}</div>`;
}
// Фура чи легковик: для фури — габарити, маса, мости, обмежувач; для легковика — без обмежень
function vehHtml() {
  const v = S.vehicle === 'auto' ? 'auto' : 'truck';
  return `<div class="seg veh"><button data-veh="truck" class="${v === 'truck' ? 'on' : ''}">${ICON.truck}${t('vehTruck')}</button><button data-veh="auto" class="${v === 'auto' ? 'on' : ''}">${ICON.car}${t('vehCar')}</button></div>`;
}
// Варіанти маршруту карточками (до трьох): час, кілометри, головні дороги, обмеження для фури
function altCardsHtml(force = false) {
  const rs = plan.routes || []; if (rs.length < 2 && !force) return '';
  const truck = plan.trip && plan.trip.costing !== 'auto';
  const best = Math.min(...rs.map(r => r.time));
  return `<div class="alts">` + rs.map((r, i) => {
    const red = truck ? hazardsAlong(r).filter(h => h.level === 'red').length : 0;
    const ky = kyivOnRoute(r, 0, d => Date.now() + d / Math.max(1, r.dist) * r.time * 1000);
    const flags = [red ? `<i class="bad">${t('altLimits', red)}</i>` : '', ky && !ky.inside ? `<i>${t('altKyiv')}</i>` : '', r.time === best && rs.length > 1 ? `<i class="good">${t('altFastest')}</i>` : ''].join('');
    return `<button class="alt${i === plan.sel ? ' on' : ''}" data-alt="${i}"><b>≈ ${fmtDur(r.time)}</b><span>${fmtDist(r.dist)}</span><small>${esc(mainRoads(r).join(', ') || t('altLocal'))}</small>${flags ? `<span class="fl">${flags}</span>` : ''}</button>`;
  }).join('') + `</div>`;
}
function selectAlt(i) {
  const tr = plan.trip, r = plan.routes[i]; if (!tr || !r) return;
  plan.sel = i; tr.route = r; tr.regions = []; tr.towns = []; tr.chosen = null;
  previewRoute(r.coords, r); previewAlts(plan.routes.map((x, k) => [k, x.coords]).filter(([k]) => k !== i));
  hud(); refresh('trip'); loadRegions(tr);
  if (!$('routePick').hidden) pickShow();
}
/* ---------- вибір варіанта, як у BlindDriver: карта з обома маршрутами зверху, дві карточки й кнопки знизу ---------- */
function pickHtml() {
  const tr = plan.trip;
  return `<div class="rp-zoom"><button data-rp="zin" aria-label="${t('qZoomIn')}">+</button><button data-rp="zout" aria-label="${t('qZoomOut')}">−</button><button data-rp="fit" aria-label="${t('rpFit')}">${ICON.route}</button></div>
    <div class="rp-head"><i class="rp-t a">А</i><b>${esc(tr.a.label || '')}</b>${tr.v ? `<i class="rp-t v">Б</i><b>${esc(tr.v.label || '')}</b>` : ''}<i class="rp-t b">С</i><b>${esc(tr.b.label || '')}</b>${plan.routes.length < 2 ? ` <span class="muted">· ${t('altOne')}</span>` : ''}</div>
    ${altCardsHtml(true).replace('class="alts"', 'class="alts rp-cards"')}
    <div class="rp-btns"><button class="btn pri" data-rp="go">${ICON.go}${t('go')}</button><button class="btn" data-rp="save">${t('saveShort')}</button><button class="btn" data-rp="info">${t('details')}</button><button class="btn rp-x" data-rp="x" aria-label="${t('close')}">${ICON.x}</button></div>`;
}
function pickShow() {
  if (!plan.trip || g.active) return pickHide();
  const box = $('routePick'); box.innerHTML = pickHtml(); box.hidden = false;
  requestAnimationFrame(pickFit);
}
// Увесь маршрут (обидва варіанти) цілком — у вільній частині карти над шторкою
function pickFit() {
  const box = $('routePick'); if (box.hidden || !plan.trip) return;
  const tp = $('top'), top = (tp.hidden ? 0 : tp.getBoundingClientRect().bottom) + 24, bottom = box.getBoundingClientRect().height + 34;
  fitRoutes(plan.routes.map(r => r.coords), top, bottom);
}
function pickHide() { const box = $('routePick'); if (!box.hidden) { box.hidden = true; freeView(); } }
function pickCancel() { plan.trip = null; plan.routes = []; plan.sel = 0; pickHide(); previewRoute(null); hud(); setFollow(true); }   // скасували — карта знову за машиною
/* ---------- позначки водіїв: ДТП, поліція, транспортна служба ---------- */
function repOpen(open) {
  const box = $('repSheet');
  if (open) {
    box.innerHTML = `<div class="q-head"><b>${t('repTitle')}</b><button class="q-x" data-rep="x" aria-label="${t('close')}">${ICON.x}</button></div>
      <div class="rep-grid">${Object.keys(REP_TYPES).map(k => `<button data-rep="${k}"><span class="rep-ic">${REP_SVG[k]}</span><span>${t('rep_' + k)}</span></button>`).join('')}</div>
      <div class="muted rep-hint">${t('repHint')}</div>`;
    box.hidden = false;
  } else box.hidden = true;
}
async function repClick(e) {
  const b = e.target.closest('[data-rep]'); if (!b) return;
  const k = b.dataset.rep;
  if (k === 'x') { repOpen(false); return; }
  if (pos.lat == null) { toast(t('repNoPos'), 'yellow', 5000); return; }
  repOpen(false);
  const r = await report(k);
  if (r) { toast(t('repDone', t('rep_' + k)), REP_TYPES[k].level === 'red' ? 'red' : 'green', 6000); P.vibrate(60); }
}

/* ---------- «Маршрут» у дорозі: увесь залишок маршруту на карті; контрольна точка, залишитись, завершити ---------- */
const ts = { via: false, q: '', sugg: [], timer: 0 };
const tsOpen = () => $('routePick').dataset.mode === 'trip' && !$('routePick').hidden;
const tsKvHtml = () => `<div class="ts-kv"><div><b>${fmtDist(g.remain)}</b><small>${t('remainL')}</small></div><div><b>${fmtDur(g.remTime)}</b><small>${t('driveTime')}</small></div><div><b>${g.arrived ? '—' : fmtClock(new Date(g.eta))}</b><small>${t('arrival')}</small></div></div>`;
function tsHtml() {
  const tr = g.trip;
  const pin = (cls, l, p) => p ? `<i class="rp-t ${cls}">${l}</i><b>${esc(p.label || '')}</b>` : '';
  const via = ts.via ? `<div class="ts-via"><input id="tsViaIn" placeholder="${esc(t('tsViaPh'))}" value="${esc(ts.q)}" autocomplete="off" enterkeyhint="search">
      <div class="ts-sugg">${ts.sugg.map((x, i) => `<button data-tsg="${i}"><b>${esc(x.label)}</b><small>${esc(x.sub || '')}</small></button>`).join('')}</div></div>` : '';
  return `${ts.via ? '' : `<div class="rp-zoom"><button data-rp="zin" aria-label="${t('qZoomIn')}">+</button><button data-rp="zout" aria-label="${t('qZoomOut')}">−</button><button data-rp="fit" aria-label="${t('rpFit')}">${ICON.route}</button></div>`}
    <div class="rp-head">${pin('a', 'А', tr.a)}${pin('v', 'Б', tr.v)}${pin('b', 'С', tr.b)}<button class="ts-more" data-ts="details">${t('details')}</button></div>
    ${tsKvHtml()}
    ${via}
    <div class="rp-btns ts-btns"><button class="btn" data-ts="via">${ICON.plus}${t('tsVia')}</button><button class="btn danger" data-ts="stop">${t('tsStop')}</button>
      <button class="btn pri" data-ts="stay">${t('tsStay')}</button></div>`;
}
export function tsShow() {
  if (!g.active || !g.route) return;
  if (currentPanel()) closePanel();
  const box = $('routePick'); box.dataset.mode = 'trip'; box.innerHTML = tsHtml(); box.hidden = false;
  requestAnimationFrame(tsFit);
}
function tsRender() { if (!tsOpen()) return; const box = $('routePick'), f = document.activeElement && document.activeElement.id === 'tsViaIn'; box.innerHTML = tsHtml(); if (f) { const i = $('tsViaIn'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } } }
// залишок маршруту — від машини до кінця — цілком у вільній частині карти
function tsFit() {
  if (!tsOpen() || !g.idx) return;
  const box = $('routePick'), tp = $('top'), top = (tp.hidden ? 0 : tp.getBoundingClientRect().bottom) + 24, bottom = box.getBoundingClientRect().height + 34;
  const cs = g.idx.slice(Math.max(0, pos.rd || 0), g.idx.total).map(c => [c[1], c[0]]);
  if (cs.length >= 2) fitRoutes([cs], top, bottom);
}
function tsHide(follow = true) {
  const box = $('routePick'); if (box.dataset.mode !== 'trip') return;
  box.hidden = true; delete box.dataset.mode; ts.via = false; ts.q = ''; ts.sugg = [];
  if (follow) setFollow(true); else freeView();
}
function endTrip(openForm) {
  const tr = g.trip; if (tr) { const snap = poiSnapshot(); tr.cams = snap.cams; tr.stops = snap.stops; if (getTrips().some(x => x.id === tr.id)) saveTrip(tr); }
  stopTrip(); previewRoute(null); setRouteContext([], []);
  if (openForm) openPanel('trip'); else setFollow(true);
}
function tsClick(e) {
  const sg = e.target.closest('[data-tsg]');
  if (sg) { const p = ts.sugg[+sg.dataset.tsg]; if (p) { setVia({ lat: p.lat, lon: p.lon, label: p.label }); toast(t('tsViaDone', p.label), 'green', 6000); ts.via = false; ts.q = ''; ts.sugg = []; tsRender(); } return; }
  const b = e.target.closest('[data-ts],[data-rp]'); if (!b) return;
  const k = b.dataset.ts || b.dataset.rp;
  if (k === 'zin' || k === 'zout') { zoomBy(k === 'zin' ? 1 : -1); return; }
  if (k === 'fit') { tsFit(); return; }
  if (k === 'via') { ts.via = !ts.via; tsRender(); requestAnimationFrame(tsFit); if (ts.via) { const i = $('tsViaIn'); if (i) i.focus(); } return; }
  if (k === 'stay') { tsHide(true); return; }
  if (k === 'details') { tsHide(false); openPanel('trip'); return; }
  if (k === 'stop') { if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = t('tsStopSure'); return; } tsHide(false); endTrip(false); toast(t('tsStopped'), 'green', 4000); }
}
function tsInput(e) {
  if (e.target.id !== 'tsViaIn') return;
  ts.q = e.target.value; clearTimeout(ts.timer);
  const q = ts.q.trim(); if (q.length < 2) { ts.sugg = []; tsRender(); return; }
  ts.timer = setTimeout(async () => { const r = await findPlaces(q); if (ts.q.trim() !== q) return; ts.sugg = r.slice(0, 6); tsRender(); }, 250);
}
function pickClick(e) {
  if ($('routePick').dataset.mode === 'trip') { tsClick(e); return; }
  const c = e.target.closest('[data-alt]'); if (c) { selectAlt(+c.dataset.alt); return; }
  const b = e.target.closest('[data-rp]'); if (!b || !plan.trip) return;
  const k = b.dataset.rp;
  if (k === 'zin' || k === 'zout') { zoomBy(k === 'zin' ? 1 : -1); return; }
  if (k === 'fit') { pickFit(); return; }
  if (k === 'go') { pickHide(); goTrip(plan.trip); }
  else if (k === 'save') { const tr = plan.trip; if (tr.route) delete tr.route.alts; saveTrip(tr); toast(t('saved'), 'green', 3000); pickCancel(); }
  else if (k === 'info') { pickHide(); openPanel('trip'); }
  else if (k === 'x') pickCancel();
}
function placeLine(p) { return p ? esc(p.label) + (p.sub ? ` <span class="muted">${esc(p.sub)}</span>` : '') : ''; }
function planSumHtml() {
  const tr = plan.trip, r = tr.route, alt = r.alt;
  const warn = alt ? `<div class="card" style="margin-top:8px;border:2px solid var(--yellow)"><div style="font-weight:600">${t('detourTitle', fmtDist(r.dist), fmtDist(alt.dist))}</div>
      <div class="muted" style="margin-top:4px">${t('detourText')}</div>
      <div class="btns"><button class="btn" data-act="useAlt">${t('useAlt', fmtDist(alt.dist))}</button></div></div>`
    : r.costing === 'auto' ? `<div class="muted" style="margin-top:8px;color:var(--red)">${t('altInUse')}</div>` : '';
  return `<div class="sec">${t('routeReady')}${plan.routes.length > 1 ? ' · ' + t('altCount', plan.routes.length) : ''}</div>${altCardsHtml()}<div class="card"><div style="font-weight:600">${placeLine(tr.a)}</div><div style="font-weight:600;margin:2px 0 10px">→ ${placeLine(tr.b)}</div>${summaryHtml(tr)}${offlineHtml()}</div>${warn}
    <div class="btns"><button class="btn dark" data-act="go">${ICON.go}${t('go')}</button><button class="btn" data-act="save">${t('saveLater')}</button></div>
    ${truckHtml(r, 0, d => Date.now() + d / Math.max(1, r.dist) * r.time * 1000)}`;
}
function showSugg(k, list, head) {
  const box = $('sg_' + k); if (!box) return;
  for (const o of ['a', 'v', 'b']) if (o !== k) { const ob = $('sg_' + o); if (ob) ob.hidden = true; }
  box.hidden = !list.length;
  box.innerHTML = (head && list.length ? `<div class="sg-head">${esc(head)}</div>` : '') +
    list.map((s, i) => `<button data-sg="${k}:${i}"><b>${esc(s.label)}</b><small>${esc(s.sub || '')}</small></button>`).join('');
  plan.sugg = list; plan.field = k;
}
// Підказки: спершу довідник у телефоні (миттєво, без інтернету), потім адреси й вулиці з сервера.
const ADDR = /\d|вул|просп|пров|пл\.|бульв|шосе|ул\.|улиц|street/i;
async function findPlaces(q) {
  await places.load();
  const local = places.search(q, 8);
  if (local.length >= 5 && !ADDR.test(q)) return local;
  if (q.length < 3 || !P.online()) return local;
  let remote = [];
  try { remote = await geocode(q, pos.lat != null ? pos : null); } catch (e) { log('warn', 'пошук: ' + e.message); }
  const near = (a, b) => Math.abs(a.lat - b.lat) < 0.02 && Math.abs(a.lon - b.lon) < 0.03;
  return local.concat(remote.filter(r => !local.some(l => near(l, r)))).slice(0, 9);
}
async function doBuild() {
  plan.err = '';
  // текст у полі без вибраної підказки — беремо перший результат пошуку
  for (const k of ['a', 'v', 'b']) {
    const inp = $('in_' + k), txt = inp ? inp.value.trim() : '';
    if (txt && (!plan[k] || plan[k].label !== txt)) {
      const r = await findPlaces(txt);
      if (r[0]) plan[k] = r[0]; else { plan.err = P.online() ? t('notFound', txt) : t('netErr'); refresh('trip'); return; }
    } else if (!txt) plan[k] = null;
  }
  if (!plan.a && pos.lat != null) plan.a = { lat: pos.lat, lon: pos.lon, label: t('myPlace') };
  if (!plan.a || !plan.b) { plan.err = t('needAB'); refresh('trip'); return; }
  plan.busy = true; plan.trip = null; plan.off = null; refresh('trip');
  try {
    const trip = newTrip(plan.a, plan.v, plan.b);
    trip.costing = S.vehicle === 'auto' ? 'auto' : 'truck';
    const r = await buildRoute(trip, { alternates: 1 });
    plan.routes = [r, ...(r.alts || [])].slice(0, 2); plan.sel = 0;          // два варіанти, як у BlindDriver
    for (const x of plan.routes) delete x.alts;
    trip.route = r;
    plan.trip = trip; mapM.previewPoints(trip); previewRoute(trip.route.coords, trip.route); previewAlts(plan.routes.slice(1).map((x, k) => [k + 1, x.coords])); hud();
    loadRegions(trip);
    plan.busy = false; closePanel(); pickShow(); return;
  } catch (e) {
    plan.err = (e.code ? t('routeFail') : t('netErr')) + ' ' + (e.message || '');
    log('warn', 'маршрут: ' + e.message);
  }
  plan.busy = false; refresh('trip');
}
async function goTrip(trip, opts = {}) {
  plan.going = true; pickHide();
  if (trip.route) delete trip.route.alts;
  previewAlts(null); plan.routes = []; plan.sel = 0;
  saveTrip(trip); places.remember(trip.b);
  restorePoi(trip.cams, trip.stops);
  if (!opts.onRoute) closePanel();
  showPick(null);
  P.keepAwake(S.keepAwake !== false);
  await startTrip(trip, opts);
  setRouteContext(trip.regions, trip.towns);
  setFollow(true);
  plan.trip = null; plan.a = plan.v = plan.b = null;
  plan.going = false;
  if (!trip.regions || !trip.regions.length) loadRegions(trip);
  if (S.offline && P.online() && !offlineActive()) runOffline(trip.route);
  pollAir(); pollTelegram(true);
}
function tripClicks(e) {
  const sh = e.target.closest('[data-shlat]');
  if (sh) { closePanel(); flyTo({ lat: +sh.dataset.shlat, lon: +sh.dataset.shlon }, 15); return; }
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.act === 'build') doBuild();
  else if (d.veh) { S.vehicle = d.veh; e.currentTarget.querySelectorAll('[data-veh]').forEach(x => x.classList.toggle('on', x.dataset.veh === d.veh)); if (plan.trip) doBuild(); }
  else if (d.alt != null) selectAlt(+d.alt);
  else if (d.act === 'rerouteFresh') { rerouteNow(true); closePanel(); }
  else if (d.act === 'go' && plan.trip) goTrip(plan.trip);
  else if (d.act === 'useAlt' && plan.trip && plan.trip.route.alt) {
    const tr = plan.trip, alt = tr.route.alt;
    alt.aD = null; alt.viaD = tr.route.viaD; alt.detour = 1; tr.costing = 'auto'; tr.route = alt; tr.regions = []; tr.towns = [];
    previewRoute(alt.coords, alt); hud(); refresh('trip'); loadRegions(tr);
  }
  else if (d.act === 'save' && plan.trip) { if (plan.trip.route) delete plan.trip.route.alts; plan.routes = []; saveTrip(plan.trip); toast(t('saved'), 'green', 3000); plan.trip = null; plan.a = plan.v = plan.b = null; previewRoute(null); hud(); openPanel('trip'); }
  else if (d.act === 'reroute') { rerouteNow(); closePanel(); }
  else if (d.act === 'offline' && g.route) runOffline(g.route);
  else if (d.act === 'stop') endTrip(true);
  else if (d.open) { const tr = getTrips().find(x => x.id === d.open); if (tr && tr.route) { plan.routes = []; plan.sel = 0; plan.trip = tr; plan.a = tr.a; plan.v = tr.v; plan.b = tr.b; plan.off = null; mapM.previewPoints(tr); previewRoute(tr.route.coords, tr.route); hud(); openPanel('trip'); loadRegions(tr); } }
  else if (d.del) { deleteTrip(d.del); refresh('trip'); }
  else if (d.here) {
    if (pos.lat == null) { toast(t('gpsWait')); return; }
    plan.a = { lat: pos.lat, lon: pos.lon, label: t('myPlace') }; $('in_a').value = plan.a.label;
    reverse(pos.lat, pos.lon).then(r => { if (r && plan.a && plan.a.label === t('myPlace')) { plan.a.label = [r.name || r.city, r.city !== r.name ? r.city : ''].filter(Boolean).join(', ') || plan.a.label; const i = $('in_a'); if (i) i.value = plan.a.label; } }).catch(() => {});
  }
  else if (d.clear) { plan[d.clear] = null; const i = $('in_' + d.clear); if (i) { i.value = ''; i.focus(); } showSugg(d.clear, []); }
  else if (d.sg) { clearTimeout(geoTimer); const [k, i] = d.sg.split(':'); const s = plan.sugg[+i]; if (s) { plan[k] = s; $('in_' + k).value = s.label; showSugg(k, []); showPick(s); places.remember(s); } }
}
function tripInput(e) {
  const k = e.target.dataset && e.target.dataset.f; if (!k) return;
  plan[k] = null; clearTimeout(geoTimer);
  const q = e.target.value.trim();
  if (!q) { showSugg(k, places.recent(), t('recentPlaces')); return; }
  // довідник — одразу з першої літери; сервер — лише після паузи в наборі
  if (places.pl.ready) showSugg(k, places.search(q, 8));
  geoTimer = setTimeout(async () => {
    const r = await findPlaces(q);
    if ($('in_' + k) && $('in_' + k).value.trim() === q && !plan[k]) showSugg(k, r);   // місце вже вибрано — список не відкриваємо знову
  }, places.pl.ready ? 500 : 300);
}
function tripFocus(e) {
  const k = e.target.dataset && e.target.dataset.f; if (!k) return;
  places.load();
  if (!e.target.value.trim()) showSugg(k, places.recent(), t('recentPlaces'));
}
definePanel('trip', {
  title: () => t('tabTrip'),
  render(body) {
    const active = g.trip && (g.active || g.arrived);
    body.innerHTML = active ? tripActiveHtml() : planHtml();
    body.onclick = tripClicks; body.oninput = tripInput; body.onfocusin = tripFocus;
    $('panel').classList.toggle('half', !active && !!plan.trip);     // маршрут побудовано — панель нижче, лінію видно на карті
  },
  update(body) {
    const active = g.trip && (g.active || g.arrived);
    if (active) { body.innerHTML = tripActiveHtml(); return; }
    // форму не перемальовуємо, щоб не збивати введення
    const sum = $('planSum'), sv = $('savedBox'), er = $('planErr'), bb = body.querySelector('[data-act="build"]');
    if (!sum) { body.innerHTML = planHtml(); return; }
    sum.innerHTML = plan.trip ? planSumHtml() : ''; sv.innerHTML = savedHtml(); er.textContent = plan.err;
    if (bb) { bb.disabled = plan.busy; bb.textContent = plan.busy ? t('building') : t('build'); }
    if (plan.trip && !sum.dataset.shown) { sum.dataset.shown = '1'; body.scrollTop = 0; } else if (!plan.trip) delete sum.dataset.shown;
    $('panel').classList.toggle('half', !!plan.trip);
  },
  close() { if (plan.trip && !g.active) { /* залишаємо попередній перегляд на карті */ } }
});

/* вибір точки довгим натисканням на карті */
/* =====================  ПЕРЕВІРЕНІ МІСЦЯ  ===================== */
let vpCur = null, vpPickFor = null;
const stars = n => '★'.repeat(Math.max(0, Math.min(5, n || 0))) + '☆'.repeat(5 - Math.max(0, Math.min(5, n || 0)));
function vpWhereText(p) {
  const w = vpWhere(p); if (!w) return vpOnMap(p) ? '' : t('vpNoLoc');
  if (w.route) return w.ahead >= 0 ? t('vpOnRoute', fmtDist(w.ahead)) : t('vpBehind');
  return t('vpAway', fmtDist(w.dist));
}
function vpMonth(s) { const [y, m] = String(s || '').split('-').map(Number); if (!y || !m) return ''; try { return new Date(y, m - 1, 1).toLocaleDateString(S.lang === 'ru' ? 'ru-RU' : 'uk-UA', { month: 'long', year: 'numeric' }); } catch (_) { return s; } }
function placesHtml() {
  if (!vp.ready) return `<div class="muted">${t('loading')}</div>`;
  const trip = g.active && g.idx && pos.rd != null, items = vpListed(), list = items.map(x => x.p), W = new Map(items.map(x => [x.p.id, x.w]));
  const where = p => { const w = W.get(p.id); if (!w) return vpWhereText(p);
    if (w.route) return w.ahead < 1000 ? t(w.off > 1500 ? 'vpHereOff' : 'vpHere', fmtDist(w.off)) : t(w.off > 1500 ? 'vpAheadOff' : 'vpOnRoute', fmtDist(w.ahead), fmtDist(w.off));
    return t('vpAway', fmtDist(w.dist)); };
  const head = `<div class="vp-scope">${t(trip ? 'vpScopeRoute' : pos.lat != null ? 'vpScopeNear' : 'vpScopeAll')}</div>`;
  if (!list.length) return head + `<div class="card vp-empty">${t(trip ? 'vpNoneRoute' : 'vpNoneNear')}</div><div class="muted" style="margin-top:12px">${t('vpHowAdd')}</div>`;
  return head + `<div class="list">` + list.map(p => `<button class="vp-row" data-vpid="${esc(p.id)}">
      <img src="data/${esc((p.thumbs || p.photos || [])[0] || '')}" alt="" loading="lazy"><span class="grow"><b>${esc(p.name)}</b><span class="vp-stars">${stars(p.rating)}</span>
      <small>${esc([t('vpKind_' + (p.kind || 'food')), p.road, vpTxt(p.town)].filter(Boolean).join(' · '))}</small><small class="vp-w">${esc(where(p))}</small></span></button>`).join('') +
    `</div><div class="muted" style="margin-top:12px">${t('vpHowAdd')}</div>`;
}
function placeHtml(p) {
  const ph = p.photos || [];
  return `<div class="vp-photos">${ph.map((src, i) => `<img src="data/${esc(src)}" alt="" ${i > 1 ? 'loading="lazy"' : ''} data-ph="${i}">`).join('')}</div>
    ${ph.length > 1 ? `<div class="muted vp-hint">${t('vpSwipe', ph.length)}</div>` : ''}
    <div class="vp-head"><b>${esc(p.name)}</b><span class="vp-stars big">${stars(p.rating)}</span></div>
    <div class="vp-badge">${ICON.check}<span>${t('vpChecked', vpMonth(p.checked))}</span></div>
    <div class="muted">${esc([t('vpKind_' + (p.kind || 'food')), p.road, vpTxt(p.town)].filter(Boolean).join(' · '))}${p.side ? '<br>' + esc(vpTxt(p.side)) : ''}</div>
    ${vpWhereText(p) ? `<div class="vp-where">${esc(vpWhereText(p))}</div>` : ''}
    <p class="vp-say">${esc(vpTxt(p.say))}</p>
    <div class="vp-tags">${(vpTxt(p.tags) || []).map(x => `<span class="pill">${esc(x)}</span>`).join('')}</div>
    ${p.menu && p.menu.length ? `<div class="sec">${t('vpMenu')}</div><div class="vp-menu">${p.menu.map(([n, pr]) => `<div><span>${esc(n)}</span><b>${esc(pr)}</b></div>`).join('')}</div><div class="muted" style="margin-top:6px">${esc(vpTxt(p.note))}</div>` : ''}
    <div class="btns">${vpOnMap(p) ? `<button class="btn pri" data-vp="go">${g.active ? t('vpVia') : t('vpRoute')}</button><button class="btn" data-vp="map">${t('vpOnMap')}</button>` : ''}</div>
    ${!vpOnMap(p) || p.own ? `<div class="btns"><button class="btn" data-vp="setloc">${t('vpSetLoc')}</button></div>` : ''}`;
}
definePanel('places', {
  title: () => t('tabPlaces'),
  render(body) {
    body.innerHTML = placesHtml();
    body.onclick = e => { const b = e.target.closest('[data-vpid]'); if (!b) return; vpCur = byIdVp(b.dataset.vpid); if (vpCur) openPanel('place'); };
  }
});
definePanel('place', {
  title: () => vpCur ? vpCur.name : '', back: 'places', tab: 'places',
  render(body) {
    if (!vpCur) return;
    body.innerHTML = placeHtml(vpCur);
    body.onclick = e => {
      const im = e.target.closest('[data-ph]');
      if (im) { const pv = $('photoView'); pv.innerHTML = `<button class="pv-x" data-pv="x" aria-label="${t('close')}">${ICON.x}</button><div class="pv-strip">${(vpCur.photos || []).map(src => `<img src="data/${esc(src)}" alt="">`).join('')}</div>`; pv.hidden = false; const st = pv.querySelector('.pv-strip'); st.scrollLeft = st.clientWidth * +im.dataset.ph; return; }
      const b = e.target.closest('[data-vp]'); if (!b) return;
      const p = vpCur, k = b.dataset.vp;
      if (k === 'map') { closePanel(); flyTo(p, 16); }
      else if (k === 'go') {
        const pt = { lat: p.lat, lon: p.lon, label: p.name, sub: [p.road, vpTxt(p.town)].filter(Boolean).join(' · ') };
        if (g.active) { setVia(pt); closePanel(); toast(t('vpViaDone', p.name), 'green', 6000); }
        else { plan.b = pt; plan.trip = null; plan.routes = []; openPanel('trip'); }
      } else if (k === 'setloc') { vpPickFor = p.id; closePanel(); toast(t('vpSetLocHint'), '', 9000); }
    };
  },
  update(body) { if (vpCur) body.innerHTML = placeHtml(vpCur); }
});

function onMapPick(p) {
  if (vpPickFor) { const id = vpPickFor; vpPickFor = null; vpSetLocation(id, p); vpCur = byIdVp(id); toast(t('vpLocSet'), 'green', 5000); openPanel('place'); return; }
  // Без GPS довге натискання біля маршруту = «я тут, на маршруті»: попадати пальцем точно в лінію на ходу незручно.
  if (g.active && g.idx && pos.mode !== 'gps') {
    const l = g.idx.locate(p, null), z = mapM.map ? mapM.map.getZoom() : 12;
    const mpp = 156543 * Math.cos(p.lat * Math.PI / 180) / Math.pow(2, z);          // метрів на піксель
    if (l && l.off <= Math.max(150, mpp * 70)) { placeAtD(l.d); setFollow(true); toast(t('snapPress'), 'green', 5000); return; }
  }
  showPick(p);
  const box = $('pick'); box.hidden = false;
  const pts = g.active ? '' : `<button class="btn" data-k="a">А</button><button class="btn" data-k="v">Б · ${t('via')}</button><button class="btn" data-k="b">С</button>`;
  box.innerHTML = `<div class="muted">${t('pickTitle')} ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div><div class="row">
    ${pts}<button class="btn" data-k="here">${t('iAmHere')}</button><button class="btn" data-k="x" aria-label="${t('clear')}">${ICON.x}</button></div>
    <div class="row"><button class="btn sm" data-k="shower">${ICON.shower}${t('showerMarkAction')}</button></div>`;
  box.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    box.hidden = true;
    const k = b.dataset.k; if (k === 'x') { showPick(null); return; }
    if (k === 'shower') { showPick(null); showers.toggleShower(p, ''); toast(t('showerMarked'), 'green', 4000); return; }
    if (k === 'here') { showPick(null); setManual(p); setFollow(true); toast(t('hereSet'), 'green', 6000); return; }
    plan[k] = { lat: p.lat, lon: p.lon, label: p.lat.toFixed(5) + ', ' + p.lon.toFixed(5) };
    reverse(p.lat, p.lon).then(r => { if (r && plan[k]) { plan[k].label = [r.name, r.city !== r.name ? r.city : ''].filter(Boolean).join(', ') || plan[k].label; const i = $('in_' + k); if (i) i.value = plan[k].label; } }).catch(() => {});
    openPanel('trip');
  };
}

/* картка власної позначки «тут є душ» */
function onMarkTap(id) {
  const m = showers.myShowers().find(x => x.id === id); if (!m) return;
  const p = { lat: m.lat, lon: m.lon, label: m.name || t('showerMineTitle') };
  const dist = pos.lat != null ? ' · ' + fmtDist(hav(pos, m)) + ' ' + t('fromYou') : '';
  const box = $('pick'); box.hidden = false; showPick(null);
  const btns = g.active ? `<button class="btn pri" data-k="via">${t('stopVia')}</button>`
    : `<button class="btn" data-k="a">А</button><button class="btn" data-k="v">Б · ${t('via')}</button><button class="btn" data-k="b">С</button>`;
  box.innerHTML = `<div class="row" style="margin-top:0"><span class="sdot" style="background:#06b6d4"></span><div class="grow"><div class="t">${esc(m.name || t('showerMineTitle'))}</div>
    <div class="muted">${t('showerMineShort')} · ${new Date(m.t).toLocaleDateString('uk-UA')}${dist}</div></div></div>
    <div class="row">${btns}<button class="btn" data-k="x" aria-label="${t('clear')}">${ICON.x}</button></div>
    <div class="row"><button class="btn wide" data-k="del">${t('showerRemove')}</button></div>`;
  box.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    box.hidden = true;
    const k = b.dataset.k;
    if (k === 'x') return;
    if (k === 'del') { showers.removeMark(id); toast(t('showerUnmarked'), '', 3000); return; }
    if (k === 'via') { setVia(p); toast(t('stopViaOk', p.label), 'green', 5000); return; }
    plan[k] = p; openPanel('trip');
  };
}

/* картка піт-стопу: торкання кольорової точки на карті */
const STOP_T = { e: 'stop_food', f: 'stop_fuel', s: 'stop_services', p: 'stop_parking', m: 'stop_motel', c: 'camera', h: 'stop_shower' };
// Довідка до точки: що тут є, що поруч, години, посилання на сайт, телефон, Google Maps, OpenStreetMap.
const FA_ORDER = ['wc', 'water', 'shop', 'picnic', 'tyres', 'repair', 'air', 'wash', 'atm', 'hotel'];
// Години у форматі OSM («Mo-Fr 08:00-20:00; Sa off») — людською мовою
function fmtHours(h) {
  const D = S.lang === 'ru' ? { Mo: 'Пн', Tu: 'Вт', We: 'Ср', Th: 'Чт', Fr: 'Пт', Sa: 'Сб', Su: 'Вс', PH: 'праздники', off: 'выходной' }
    : { Mo: 'Пн', Tu: 'Вт', We: 'Ср', Th: 'Чт', Fr: 'Пт', Sa: 'Сб', Su: 'Нд', PH: 'свята', off: 'вихідний' };
  return String(h).replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH|off)\b/g, m => D[m]).replace(/;\s*/g, '; ');
}
function stopKindLabel(ty, info) { return ty === 's' && info && info.k === 'ra' ? t('stop_rest') : t(STOP_T[ty]); }
function stopInfoHtml(i, r) {
  const [lat, lon, ty, f, , , info = {}] = r;
  if (ty === 'c') return { html: '', links: '' };
  const have = FA_ORDER.filter(c => (info.fa || []).includes(c)).map(c => t('fa_' + c));
  const R = ty === 's' ? (info.k === 'ra' ? 200 : 350) : 200;
  const near = nearbyRows(i, R).slice(0, 4).map(x => { const k = stopKindLabel(x.r[2], x.r[6]), n = x.r[4];
    return (n && n.toLowerCase() !== k.toLowerCase() ? n + ' (' + k + ')' : k) + ' · ' + fmtDist(x.dist); });
  const L = [];
  if (have.length) L.push(`<div><b>${t('infoHave')}</b> ${esc(have.join(' · '))}</div>`);
  if (near.length) L.push(`<div><b>${t('infoNear')}</b> ${esc(near.join('; '))}</div>`);
  if (info.h) L.push(`<div><b>${t('infoHours')}</b> ${esc(fmtHours(info.h))}</div>`);
  if (info.o) L.push(`<div><b>${t('infoOperator')}</b> ${esc(info.o)}</div>`);
  if (!have.length && !near.length && !(f & (F.SHOWER | F.FOOD | F.WC)) && (ty === 's' || ty === 'p')) L.push(`<div>${t('infoUnknown')}</div>`);
  const links = [`<button class="btn sm" data-u="${esc('https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lon)}">${t('linkGmaps')}</button>`];
  if (info.w) links.push(`<button class="btn sm" data-u="${esc(info.w)}">${t('linkSite')}</button>`);
  if (info.p) links.push(`<button class="btn sm" data-u="${esc('tel:' + info.p.replace(/[^\d+]/g, ''))}">${t('linkCall')}</button>`);
  if (info.id) links.push(`<button class="btn sm" data-u="${esc('https://www.openstreetmap.org/' + (info.id[0] === 'n' ? 'node/' : 'way/') + info.id.slice(1))}">OSM</button>`);
  return { html: L.length ? `<div class="pick-info">${L.join('')}</div>` : '', links: `<div class="row pick-links">${links.join('')}</div>` };
}

function onStopTap(x) {
  const r = sdb.rows[x.i]; if (!r) return;
  const [lat, lon, ty, f, name, extra, info] = r;
  const fa = (info && info.fa) || [];
  const feats = [f & F.HGV && t('f_hgv'), f & F.SHOWER && t('f_shower'), f & F.FOOD && t('f_food'), (f & F.WC || fa.includes('wc')) && t('f_wc'), f & F.H24 && '24/7'].filter(Boolean);
  const dist = pos.lat != null ? ' · ' + fmtDist(hav(pos, { lat, lon })) + ' ' + t('fromYou') : '';
  const kindL = stopKindLabel(ty, info);
  const title = ty === 'c' ? t('camera') + (extra ? ' · ' + extra + ' ' + t('kmh') : '') : (name || kindL);
  const p = { lat, lon, label: name || kindL };
  const inf = stopInfoHtml(x.i, r);
  const box = $('pick'); box.hidden = false; showPick(null);
  const btns = ty === 'c' ? '' : g.active
    ? `<button class="btn pri" data-k="via">${t('stopVia')}</button>`
    : `<button class="btn" data-k="a">А</button><button class="btn" data-k="v">Б · ${t('via')}</button><button class="btn" data-k="b">С</button>`;
  const mine = showers.myShowerAt({ lat, lon }, 60);
  const shBtn = ty === 'c' ? '' : `<div class="row"><button class="btn sm${mine ? ' sh-on' : ''}" data-k="shower">${ICON.shower}${mine ? t('showerMine') : t('showerMarkAction')}</button></div>`;
  box.innerHTML = `<div class="row" style="margin-top:0"><span class="sdot" style="background:${TYPES[ty].color}${f & F.SHOWER || mine ? ';border-color:#06b6d4' : ''}"></span><div class="grow"><div class="t">${esc(title)}</div>
    <div class="muted">${esc((name ? kindL : '') + (name && feats.length ? ' · ' : '') + feats.join(', ') + (mine && !(f & F.SHOWER) ? (feats.length || name ? ' · ' : '') + t('showerMineShort') : ''))}${dist}</div></div></div>
    ${inf.html}${inf.links}
    <div class="row">${btns}<button class="btn" data-k="x" aria-label="${t('clear')}">${ICON.x}</button></div>${shBtn}`;
  box.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.u) { P.openUrl(b.dataset.u); return; }     // посилання не закривають картку
    box.hidden = true;
    const k = b.dataset.k;
    if (k === 'x') return;
    if (k === 'shower') { const on = showers.toggleShower({ lat, lon }, name || t(STOP_T[ty])); toast(on ? t('showerMarked') : t('showerUnmarked'), on ? 'green' : '', 4000); return; }
    if (k === 'via') { setVia(p); toast(t('stopViaOk', p.label), 'green', 5000); return; }
    plan[k] = p; openPanel('trip');
  };
}

/* =====================  ПАНЕЛЬ «ПОДІЇ»  ===================== */
let feedTab = 'main';
const SRC = { tg: 'Telegram', air: 'srcAir', stop: 'srcStop', drive: 'srcDrive', sys: 'srcSys', wx: 'srcWx' };
function ago(ts) { const s = (Date.now() - ts) / 1000; return s < 90 ? t('justNow') : s < 3600 ? Math.round(s / 60) + ' ' + t('minAgo') : fmtClock(new Date(ts)); }
// Чому подія не в головному: позаду, застаріло, не на маршруті, ще далеко
function whyHtml(i, r) {
  if (!r) return '';
  if (r.show) { const l = relLabel(i, r); return (l ? `<span class="ev-d">${esc(l)}</span>` : '') + (r.tier === 'far' ? `<span>${t('evFar')}</span>` : ''); }
  const k = { behind: 'evBehind', old: 'evOld', away: 'evAway', off: 'evOff' }[r.tier];
  if (r.tier === 'later') return `<span>${esc(t('evLater', Math.round(r.ahead / 1000)))}</span>`;
  return k && !(r.tier === 'off' && i.filtered === false && !i.level) ? `<span>${t(k)}</span>` : '';
}
function evHtml([i, r]) {
  const src = i.src === 'tg' ? '@' + i.ch : t(SRC[i.src] || 'srcSys');
  const v = i.vote;
  return `<div class="ev ${i.level || ''}${r && !r.show ? ' dim' : ''}"><div class="meta">${whyHtml(i, r)}<span>${esc(src)}</span><span>${ago(i.time)}</span>${i.ai ? '<span>Claude</span>' : ''}</div>
    ${i.sum ? `<div class="sum">${esc(i.sum)}</div>` : ''}<div class="txt cl" data-exp="1">${esc(i.text)}</div>
    <div class="votes"><button class="up${v === 1 ? ' on' : ''}" data-v="${i.id}:1">${ICON.like}${t('need')}</button><button class="down${v === -1 ? ' on' : ''}" data-v="${i.id}:-1">${ICON.dislike}${t('noNeed')}</button><button class="und${v === 0 ? ' on' : ''}" data-v="${i.id}:0">${ICON.q}${t('undecided')}</button></div></div>`;
}
function feedStatus() {
  const parts = [];
  if (!S.lookahead) return t('stripOff');
  if (S.tg) {
    const n = activeChannels().length;
    if (!tgAvailable()) parts.push(t('tgWeb'));
    else if (!(S.channels || []).length) parts.push(t('tgNoCh'));
    else parts.push(t('tgStat', n) + (feed.tgAt ? ', ' + ago(feed.tgAt) : '') + (feed.tgErr && feed.tgErr !== 'web' ? ' · ' + t('errShort') : ''));
  }
  if (S.air) {
    const on = zoneRegions().filter(r => feed.air[r.id]).map(r => oblastName(r.id) + (r.dist > 1500 ? ' · ' + t('evIn', Math.round(r.dist / 1000)) : ''));
    parts.push(feed.airErr ? t('airErr') : feed.airAt ? (on.length ? t('airNow', on.join(', ')) : t('airNone')) : t('airWait'));
  }
  return parts.join(' · ');
}
// «Події» на весь екран, без нижньої панелі: 1) тривога там, де машина; 2) прильоти, вибухи, НП — лише на шляху попереду;
// 3) інше (відсіяне, позаду) — згорнуто. Унизу «Назад», щоб не тягнутися до хрестика вгорі.
function airCardHtml() {
  const here = (zoneRegions(1)[0] || {}).id || feed.here, a = here && feed.air[here];
  const ahead = zoneRegions().filter(z => z.id !== here && feed.air[z.id]).map(z => oblastName(z.id));
  if (!here) return `<div class="ev-air none"><b>${t('evAirUnknown')}</b><span>${t(feed.airAt ? 'airWhere' : 'airNoData')}</span></div>`;
  return `<div class="ev-air ${a ? 'on' : 'off'}"><b>${a ? t('evAirOn') : t('evAirCalm')}</b><span>${esc(oblastName(here))} ${t('oblShort')}${a && a.since ? ' · ' + t('evAirSince', a.since) : ''}${a && a.part ? ' · ' + t('evAirPart') : ''}</span>
    ${ahead.length ? `<small>${t('evAirAhead', ahead.join(', '))}</small>` : ''}</div>`;
}
function feedHtml() {
  // лише події: тривоги (окремою карткою), Telegram (прильоти, ДТП, перекриття), позначки водіїв, погода на дорозі;
  // підказки про стоянки, перевірені місця й час за кермом сюди не потрапляють — вони звучать у дорозі
  const EV = i => i.src !== 'air' && i.src !== 'stop' && i.src !== 'drive';
  const L = feedLists(), main = L.main.filter(([i]) => EV(i)).slice(0, 60), rest = L.rest.filter(([i]) => EV(i)).slice(0, 60);
  const onTrip = g.active && g.route;
  return `${airCardHtml()}
    <div class="sec">${t(onTrip ? 'feedAhead' : 'feedAround')}</div>
    <div class="list">${main.map(evHtml).join('') || `<div class="card ev-calm">${t(onTrip ? 'feedCalmAhead' : 'feedCalmAround')}</div>`}</div>
    ${rest.length ? `<button class="btn sm wide ev-more" data-tab="${feedTab === 'rest' ? 'main' : 'rest'}">${t(feedTab === 'rest' ? 'feedRestHide' : 'feedRestShow', rest.length)}</button>
      ${feedTab === 'rest' ? `<div class="list">${rest.map(evHtml).join('')}</div>` : ''}` : ''}
    <div class="btns"><button class="btn sm" data-act="refresh">${t('refreshNow')}</button><button class="btn sm" data-act="channels">${t('channels')}</button></div>
    <div class="muted" style="margin-top:8px">${esc(feedStatus())}</div>
    <div class="pb-back"><button class="btn wide" data-act="back">${ICON.back}${t('back')}</button></div>`;
}
definePanel('feed', {
  title: () => t('tabFeed'), full: true,
  render(body) {
    body.innerHTML = feedHtml(); markSeen();
    body.onclick = e => {
      const b = e.target.closest('button'), x = e.target.closest('[data-exp]');
      if (!b) { if (x) x.classList.toggle('cl'); return; }
      if (b.dataset.tab) { feedTab = b.dataset.tab; body.innerHTML = feedHtml(); }
      else if (b.dataset.act === 'back') closePanel();
      else if (b.dataset.v) { const [id, v] = b.dataset.v.split(':'); vote(id, +v); }
      else if (b.dataset.act === 'refresh') { pollAir(); pollTelegram(true); toast(t('refreshing'), '', 2500); }
      else if (b.dataset.act === 'channels') openPanel('channels');
    };
  },
  update(body) { body.innerHTML = feedHtml(); }
});

/* =====================  ПАНЕЛЬ «ЧАТ»  ===================== */
function chatHtml() {
  const msgs = chat.msgs.map(m => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join('');
  const state = chat.listening ? `<div class="msg sys">${t('listening')} ${esc(chat.partial)}</div>` : chat.busy ? `<div class="msg sys">${t('thinking')}</div>` : '';
  const err = chat.error ? `<div class="msg sys" style="color:var(--red)">${esc(errorText(chat.error))}</div>` : '';
  const intro = !chat.msgs.length && !chat.error ? `<div class="msg sys">${hasKey() ? t('chatIntro') : t('chatNoKey')}</div>` : '';
  return `<div class="chat"><div class="msgs">${intro}${msgs}${state}${err}</div>
    <div class="chatbar"><div class="row"><input id="chatIn" placeholder="${t('chatPh')}" autocomplete="off" enterkeyhint="send"><button class="btn pri" data-act="send" aria-label="${t('send')}">${ICON.send}</button></div>
    <div class="row"><button class="btn grow${chat.listening && !chat.live ? ' danger' : ''}" data-act="voice">${ICON.mic}${t('voiceMsg')}</button><button class="btn grow${chat.live ? ' danger' : ' dark'}" data-act="live">${chat.live ? t('liveStop') : t('liveStart')}</button></div>
    ${!hasKey() ? `<button class="btn sm wide" data-act="key">${t('enterKey')}</button>` : chat.msgs.length ? `<button class="btn sm wide" data-act="clear">${t('clearChat')}</button>` : ''}</div></div>`;
}
definePanel('chat', {
  title: () => t('tabChat'),
  render(body) {
    body.innerHTML = chatHtml(); body.scrollTop = body.scrollHeight;
    const submit = () => { const i = $('chatIn'), v = i.value.trim(); if (!v) return; i.value = ''; send(v); };
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'send') submit(); else if (a === 'voice') voiceOnce(); else if (a === 'live') toggleLive();
      else if (a === 'clear') clearChat(); else if (a === 'key') openPanel('settings');
    };
    body.onkeydown = e => { if (e.key === 'Enter' && e.target.id === 'chatIn') submit(); };
  },
  update(body) {
    const i = $('chatIn'), val = i ? i.value : '', foc = document.activeElement === i;
    body.innerHTML = chatHtml(); const n = $('chatIn'); if (n) { n.value = val; if (foc) n.focus(); }
    body.scrollTop = body.scrollHeight;
  }
});

/* =====================  ЗВ'ЯЗКИ  ===================== */
export function initUI() {
  applyGlass(); staticLabels(); layoutVars(); hud(); stripUpdate();
  window.addEventListener('resize', layoutVars);
  bus.on('layout', () => requestAnimationFrame(layoutVars));
  setInterval(stripUpdate, 10000);                       // відстань до події в шторці зменшується, поки їдемо
  setInterval(() => { hud(); if (currentPanel() === 'trip' && g.active) refresh('trip'); }, 1000);
  bus.on('pos', hud); bus.on('pos', autoStart); bus.on('guide', hud); bus.on('poi', () => { hud(); refresh('trip'); });
  bus.on('feed', () => { stripUpdate(); refresh('feed'); if (g.active) refresh('trip'); });
  bus.on('chat', () => refresh('chat'));
  bus.on('vplaces', () => { refresh('places'); refresh('place'); });
  bus.on('vpTap', id => { vpCur = byIdVp(id); if (vpCur) openPanel('place'); });
  bus.on('trips', () => refresh('trip'));
  bus.on('hazards', () => refresh('trip'));
  bus.on('view', railState);
  bus.on('settings', k => { railState(); if (k === 'glass') applyGlass(); if (k === 'lang') { staticLabels(); hud(); stripUpdate(); } if (k === 'lookahead') stripUpdate(); });
  bus.on('toast', x => { const s = $('strip'); s.classList.remove('pulse'); void s.offsetWidth; s.classList.add('pulse'); if (S.popups) toast(x.text.replace(/\s+/g, ' ').slice(0, 180), x.level, 9000, () => openPanel('feed')); });
  bus.on('mapPick', onMapPick);
  $('routePick').onclick = pickClick;
  // панель «Маршрут» (деталі) закрили, а варіант ще не вибрано — повертаємо шторку вибору
  bus.on('panel', name => { if (name) { if (tsOpen()) tsHide(false); else if (!$('routePick').hidden) $('routePick').hidden = true; } else if (plan.trip && !g.active && !plan.busy && !plan.going) pickShow(); });
  bus.on('trip', () => { if (tsOpen() && !g.active) tsHide(true); else if (g.active && $('routePick').dataset.mode !== 'trip') pickHide(); });
  bus.on('route', () => { if (tsOpen()) { tsRender(); requestAnimationFrame(tsFit); } });
  bus.on('guide', () => { if (tsOpen()) { const kv = document.querySelector('#routePick .ts-kv'); if (kv) kv.outerHTML = tsKvHtml(); } });
  $('routePick').addEventListener('input', tsInput);
  bus.on('altTap', k => { if (plan.trip && !g.active && plan.routes[k]) selectAlt(+k); });
  bus.on('stopTap', onStopTap);
  bus.on('markTap', onMarkTap);
  bus.on('marks', () => refresh('trip'));
  bus.on('evTap', id => {
    if (id.startsWith('air:')) { toast(t('airOn', oblastName(id.slice(4))), 'yellow', 7000, () => openPanel('feed')); return; }
    const it = feed.items.find(x => x.id === id); if (!it) return;
    const src = it.src === 'tg' ? '@' + it.ch : t(SRC[it.src] || 'srcSys');
    toast(src + ' · ' + ago(it.time) + (it.locName ? ' · ' + it.locName : '') + '\n' + (it.sum || it.text).replace(/\s+/g, ' ').slice(0, 260), it.level, 12000, () => openPanel('feed'));
  });
  bus.on('gpsLost', d => { if (d.reason !== 'manual') say(t(d.reason === 'spoof' ? 'voiceSpoof' : 'voiceLost'), { urgent: true }); P.vibrate(300); });
  bus.on('gpsBack', d => { if (d.reason !== 'sim') { say(t('voiceBack')); toast(t('gpsBackToast', d.err), 'green', 5000); } });
  bus.on('arrived', () => { toast(t('arrived'), 'green', 8000); });
  bus.on('mapBlank', () => toast(t('mapBlank'), 'yellow', 9000));
  bus.on('native:ttsLang', d => { if (d && !d.ok) toast(t('ttsNoVoice'), 'yellow', 12000); });
  bus.on('native:perm', d => { if (d && d.loc === false) toast(t('permLoc'), 'red', 15000, () => P.openAppSettings()); });
  let spoofWarnT = 0;
  bus.on('spoof', () => {
    hud();
    if (Date.now() - spoofWarnT < 600000) return;
    spoofWarnT = Date.now(); P.vibrate(300);
    toast(t('spoofToast'), 'red', 15000, () => openPanel('gps'));
    if (pos.mode !== 'dr') say(t('voiceSpoof'), { urgent: true });
  });
  bus.on('native:locstate', d => {
    if (!d) return;
    Object.assign(locState, { known: true, enabled: d.enabled, gps: d.gps, fine: d.fine, listening: !!d.listening, error: d.error || '' });
    if (d.enabled === false && !offWarned) { offWarned = true; P.vibrate(200); toast(t('locOffToast'), 'red', 20000, () => { if (!P.openLocationSettings()) openPanel('gps'); }); }
    if (d.enabled) { offWarned = false; }
    hud(); refresh('gps');
  });
  // системна кнопка «Назад»: закрити панель або вибір точки; інакше оболонка згорне застосунок
  window.__reisBack = () => {
    if (!$('quick').hidden) { quickOpen(false); return true; }
    if (!$('repSheet').hidden) { repOpen(false); return true; }
    if (tsOpen()) { tsHide(true); return true; }
    if (!$('routePick').hidden) { pickCancel(); return true; }
    if (!$('pick').hidden) { $('pick').hidden = true; showPick(null); return true; }
    if (currentPanel()) { closePanel(); return true; }
    return false;
  };

  $('strip').onclick = () => openPanel('feed');
  $('panelClose').onclick = closePanel;
  document.querySelectorAll('#tabs button[data-panel]').forEach(b => { b.onclick = () => {
    // у дорозі «Маршрут» — не панель, а карта з усім залишком маршруту й трьома кнопками
    if (b.dataset.panel === 'trip' && g.active && !g.arrived) { if (tsOpen()) tsHide(true); else tsShow(); return; }
    if (tsOpen()) tsHide(false);
    currentPanel() === b.dataset.panel ? closePanel() : openPanel(b.dataset.panel);
  }; });
  $('bQuick').onclick = e => { e.stopPropagation(); quickOpen($('quick').hidden); };
  $('quick').onclick = e => { e.stopPropagation(); quickClick(e); };
  document.addEventListener('pointerdown', e => { if (!$('quick').hidden && !e.target.closest('#quick,#bQuick')) quickOpen(false); });
  $('bCenter').onclick = () => setFollow(true);
  // позначити подію на дорозі (як у навігаторах для водіїв): три великі кнопки
  $('bReport').innerHTML = ICON.warnTri; $('bReport').setAttribute('aria-label', t('repBtn'));
  $('bReport').onclick = e => { e.stopPropagation(); repOpen($('repSheet').hidden); };
  $('repSheet').onclick = repClick;
  bus.on('repTap', id => { const r = reps.list.find(x => x.id === id); if (r) toast(t(r.own ? 'repMine' : 'repTap', repName(r), repAgo(r)), REP_TYPES[r.t].level, 6000); });
  // ±100: дотик — 100 м; утримання — повтор із більшим кроком (500 м, далі 1 км), як у BlindDriver
  for (const [id, sign] of [['bFwd100', 1], ['bBack100', -1]]) {
    const b = $(id); let timer = null, t0 = 0, held = false;
    const stop = () => { clearTimeout(timer); timer = null; };
    const rep = () => { held = true; const el = Date.now() - t0; nudge(sign * (el > 3500 ? 1000 : el > 1200 ? 500 : 100)); timer = setTimeout(rep, 450); };
    b.onpointerdown = () => { held = false; t0 = Date.now(); stop(); timer = setTimeout(rep, 600); };
    b.onpointerup = b.onpointerleave = b.onpointercancel = stop;
    b.onclick = () => { if (!held) nudge(sign * 100); held = false; };
  }
  // «На маршрут» → «Де ви зараз?»: оцінка (якщо є), початок маршруту, міста й проміжна точка вздовж маршруту
  $('manSnap').onclick = e => {
    e.stopPropagation();
    const box = $('wherePop'); if (!box.hidden) { box.hidden = true; return; }
    box.innerHTML = whereHtml(); box.hidden = false; $('spdPop').hidden = true;
  };
  $('wherePop').onclick = e => {
    e.stopPropagation();
    const b = e.target.closest('[data-d]'); if (!b) return;
    const box = $('wherePop'); box.hidden = true;
    const ok = b.dataset.d === 'est' ? snapToRoute() : placeAtD(+b.dataset.d);
    if (ok) toast(t('snapDone'), 'green', 6000); else toast(t('snapFail'), 'yellow', 9000);
  };
  document.addEventListener('pointerdown', e => { if (!$('wherePop').hidden && !e.target.closest('#wherePop,#manSnap')) $('wherePop').hidden = true; });
  // спідометр: без GPS водій каже свою швидкість (з приладів фури) — розрахунок іде за нею
  $('speed').onclick = e => {
    e.stopPropagation();
    const box = $('spdPop');
    if (!box.hidden) { box.hidden = true; return; }
    if (pos.mode === 'gps') { toast(t('spdGpsOk'), '', 3000); return; }
    const cur = manualSpeed();
    box.innerHTML = `<div class="ly-head">${t('spdPick')}</div><div class="spd-grid">` +
      [0, 30, 50, 60, 70, 80, 85, 90].map(v => `<button data-v="${v}" class="${cur === v ? 'on' : ''}">${v === 0 ? t('standShort') : v}</button>`).join('') +
      `<button data-v="auto" class="wide${cur == null ? ' on' : ''}">${t('spdAuto')}</button></div>`;
    box.hidden = false;
  };
  $('spdPop').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    setManualSpeed(b.dataset.v === 'auto' ? null : +b.dataset.v);
    $('spdPop').hidden = true; hud();
  };
  document.addEventListener('pointerdown', e => { if (!$('spdPop').hidden && !e.target.closest('#spdPop,#speed')) $('spdPop').hidden = true; });
  $('bAcceptGps').onclick = acceptPending;
  $('gpsChip').onclick = () => openPanel('gps');
  $('lostLine').onclick = () => openPanel('gps');

  $('photoView').onclick = e => { if (e.target.closest('[data-pv="x"]') || e.target === $('photoView')) $('photoView').hidden = true; };
}
