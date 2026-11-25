// Головний екран і панелі «Рейс», «Події», «Чат».
import { bus, log, S, hav, fmtDist, fmtDur, fmtClock, fmtMS, RouteIndex } from './core.js';
import * as P from './platform.js';
import { pos, nudge, acceptPending, setManual, speedView, snapToRoute, setManualSpeed, manualSpeed, placeAtD, estimateNow, routeCps, passTurn, undoTurn } from './nav.js';
import { chime, initSfx } from './sfx.js';
import { g, startTrip, stopTrip, rerouteNow, say, setVia, resumeActive, distWords, selectChoice, confirmChoice, cancelChoice } from './guide.js';
import { poi, stopsAhead, stopLabel, restore as restorePoi, snapshot as poiSnapshot } from './poi.js';
import { feed, strip, vote, markSeen, regionsAhead, setRouteContext, pollTelegram, pollAir, tgAvailable, activeChannels, feedLists, relLabel, zoneRegions, nearM } from './feed.js';
import { chat, send, voiceOnce, toggleLive, clearChat, errorText } from './chat.js';
import { hasKey } from './ai.js';
import { geocode, reverse, buildRoute, softVariant, regionsAlong, newTrip, saveTrip, deleteTrip, getTrips, tripTitle, oblastName, mainRoads } from './route.js';
import { view, setFollow, zoomBy, previewRoute, previewAlts, fitRoutes, freeView, showRoute, showPick, prefetchRoute, applyTheme, ROUTE_COLORS, flyTo } from './map.js';
import * as mapM from './map.js';
import { hz, load as loadHazards, routeCats, hazardsAlong, hazardText, kyivOnRoute, indexOf as indexOfRoute } from './roads.js';
import { heatAlong, heatApplies } from './weather.js';
import * as rough from './rough.js';
import * as showers from './showers.js';
import { off, offlineActive } from './offline.js';
import { autoOn as addrAutoOn, waitsWifi as addrWaitsWifi } from './addr.js';
import { sdb, TYPES, F, nearbyRows, alongRoute, brandOf } from './stopsdb.js';
import * as places from './places.js';
import { exportGpx, track, trackKm } from './track.js';
import { jvIsOpen, jvClose } from './ui_journey.js';
import { vp, byId as byIdVp, listed as vpListed, whereIs as vpWhere, txt as vpTxt, onMap as vpOnMap, setLocation as vpSetLocation } from './vplaces.js';
import { $, ICON, manIcon, toast, definePanel, openPanel, closePanel, refresh, currentPanel, esc, applyGlass, panelDodge, panelDodgeSoon, panelParent } from './ui_base.js';
import { t } from './i18n.js';
import { PT_SVG, ptTag } from './pticons.js';
import { labOpen, closeLab } from './lab.js';
import { reps, report, undo as repUndo, vote as repVote, REP_TYPES, REP_SVG, repName, repAgo, repStamp, repsAhead } from './reports.js';
import { calibOpen, calibClose } from './ui_calib.js';
import { bindPhotoZoom } from './photozoom.js';
import { calFresh, calGet } from './calib.js';
import { limitNow, overLimit } from './limits.js';

/* =====================  ГОЛОВНИЙ ЕКРАН  ===================== */
function layoutVars() {
  const r = document.documentElement.style;
  r.setProperty('--th', Math.round($('top').getBoundingClientRect().height) + 'px');
  r.setProperty('--bh', Math.round($('bottom').getBoundingClientRect().height) + 'px');
  barShape();
  // --bl — скільки знизу зайнято ЛІВОРУЧ (там плашка рівна й низька): над цим стоїть круг швидкості. Якщо над плашкою є щось на всю
  // ширину («Нова версія», «прийняти GPS») — круг стає над ним. Кнопки «без GPS» (±100) з 1.1.28 стоять праворуч, над повзунком
  // нахилу, тож круг через них більше не підстрибує.
  { let top = $('tabbar').querySelector('.tb-main').getBoundingClientRect().top;
    for (const id of ['updBar', 'bAcceptGps']) { const e = $(id), q = e && !e.hidden ? e.getBoundingClientRect() : null; if (q && q.height > 0) top = Math.min(top, q.top); }
    r.setProperty('--bl', Math.max(0, Math.round($('bottom').getBoundingClientRect().bottom - top)) + 'px'); }
  // --ex — відстань від правого краю екрана до осі повзунка нахилу: на цій осі стоять «Моє місце», кнопки справа вгорі й (правим краєм) ±100
  { const T = $('tilt').getBoundingClientRect(); if (T.width > 0) r.setProperty('--ex', (Math.round((window.innerWidth - (T.left + T.right) / 2) * 2) / 2) + 'px'); }
  tiltFit();
}
// Нахил карти (1.1.22): стрілка вгору-вниз у крайньому правому куті нижньої плашки, без тла. Її місце на тонкій рисці показує нахил:
// унизу — вид згори (2D), угорі — збоку (до 60°). Те саме, що двома пальцями вгору-вниз по карті: стрілка йде за жестом, жест — за нею.
// (1.1.24) Контур нижньої плашки: рівна низька плашка (час прибуття й кнопки) і один виступ угору праворуч — стрілка нахилу карти.
// Малюємо одним шляхом у SVG за справжніми розмірами — із заокругленими кутами назовні й плавною «впадиною» перед виступом.
// Коли виступ опущено (складаємо рейс) — це звичайна плашка із заокругленим верхом.
function barShape() {
  const bar = $('tabbar'), sv = $('tbShape'); if (!bar || !sv) return;
  const B = bar.getBoundingClientRect(), T = $('tilt').getBoundingClientRect(), tabs = $('tabs').getBoundingClientRect();
  const W = Math.round(B.width), H = Math.round(B.height); if (!W || !H) return;
  const xR = Math.round(T.left - B.left) - 1, yB = Math.round(tabs.top - B.top), R = 18, q = Math.min(14, Math.max(0, yB - R) / 1.2);
  const top = yB > 6
    ? `M0 ${yB + R}Q0 ${yB} ${R} ${yB}L${xR - q} ${yB}Q${xR} ${yB} ${xR} ${yB - q}L${xR} ${R}Q${xR} 0 ${xR + R} 0L${W - R} 0Q${W} 0 ${W} ${R}`
    : `M0 ${R}Q0 0 ${R} 0L${W - R} 0Q${W} 0 ${W} ${R}`;
  const key = W + '|' + H + '|' + top; if (sv.dataset.k === key) return; sv.dataset.k = key;
  sv.querySelector('.tb-fill').setAttribute('d', `M0 ${H}L` + top.slice(1) + `L${W} ${H}Z`);
  sv.querySelector('.tb-edge').setAttribute('d', top);
}
const TILT_THUMB = 30;                      // (1.1.26) ручка — кругла «точка» на дорожці
function tiltFit() {}                      // місце й висоту дає сама плашка (CSS); лишено для layoutVars
function tiltDraw(v) {
  const el = $('tilt'); if (!el) return;
  v = Math.max(0, Math.min(mapM.PITCH_MAX, Math.round(v))); const k = v / mapM.PITCH_MAX;
  if (el.dataset.v === String(v)) return; el.dataset.v = String(v);
  el.style.setProperty('--tv', k.toFixed(3));
  el.setAttribute('aria-valuenow', String(v)); el.setAttribute('aria-valuetext', v < 3 ? t('tiltTop') : t('tiltDeg', v));
  el.classList.toggle('flat', v < 3); el.classList.toggle('max', v >= mapM.PITCH_MAX - 2);       // на краях одна зі стрілок блідне: далі нікуди
}
function tiltInit() {
  const el = $('tilt'); if (!el) return;
  el.setAttribute('aria-label', t('tiltAria'));
  // Стрілку ТЯГНУТЬ: палець униз чи вгору — нахил змінюється на стільки ж (де б не взялися). Самий лише дотик нічого не міняє —
  // стрілка стоїть поруч із «Мітками», і випадковий дотик не має перекидати карту.
  const tr = el.querySelector('.tl-track'); let drag = false, y0 = 0, v0 = 0, val = 0, moved = false;
  const snap = v => { v = Math.round(Math.max(0, Math.min(mapM.PITCH_MAX, v))); return v <= 3 ? 0 : v >= mapM.PITCH_MAX - 2 ? mapM.PITCH_MAX : v; };
  const gain = () => mapM.PITCH_MAX / Math.max(60, tr.getBoundingClientRect().height - TILT_THUMB);          // на всю шкалу — весь хід стрілки (а на низькій плашці — 60 пікселів)
  el.addEventListener('pointerdown', e => { drag = true; moved = false; y0 = e.clientY; v0 = val = mapM.tiltShown(); try { el.setPointerCapture(e.pointerId); } catch (_) {} el.classList.add('drag'); e.preventDefault(); });
  el.addEventListener('pointermove', e => { if (!drag) return; if (!moved && Math.abs(e.clientY - y0) < 4) return; moved = true; const v = snap(v0 + (y0 - e.clientY) * gain()); if (v !== val) { val = v; mapM.setTilt(v, true); } });
  const end = () => { if (!drag) return; drag = false; el.classList.remove('drag'); if (moved) mapM.setTilt(val, false); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
  el.addEventListener('keydown', e => { const d = e.key === 'ArrowUp' ? 5 : e.key === 'ArrowDown' ? -5 : 0; if (d) { e.preventDefault(); mapM.setTilt(mapM.tiltShown() + d, false); } });
  bus.on('tilt', tiltDraw); tiltDraw(mapM.tiltShown());
}

function staticLabels() {
  $('spdUnit').textContent = t('kmh');
  $('bBack100').innerHTML = ICON.down + '100'; $('bBack100').setAttribute('aria-label', t('back100'));
  $('bFwd100').innerHTML = ICON.up + '100'; $('bFwd100').setAttribute('aria-label', t('fwd100'));
  $('bTurn').setAttribute('aria-label', t('turnBtnAria'));
  $('camLbl').textContent = t('camera');
  $('manThenLbl').textContent = t('then');
  const tabs = document.querySelectorAll('#tabs button[data-panel]');
  const names = { trip: 'tabTrip', feed: 'tabFeed', places: 'tabPlaces' };
  const icons = { trip: ICON.route, feed: ICON.feed, places: ICON.places };
  tabs.forEach(b => { const p = b.dataset.panel; b.innerHTML = (p === 'trip' ? `<span class="mc">${icons[p]}</span>` : icons[p]) + '<span>' + t(names[p]) + '</span>'; });
  // 1.1.22: нижня стрічка спокійна, без кольорових плям. «Мітки» — кашкет поліції (зелений, коли на маршруті є позначки).
  // (1.1.24) «Калібрування телефона» — плитка у швидких налаштуваннях, у правій нижній клітинці (зелена, коли відкалібровано).
  $('tabRep').innerHTML = `<span class="tc">${ICON.repTab}</span><span>${t('tabRep')}</span>`;
  $('spdGps').innerHTML = ICON.gpsSig;
  tabCalSync(); repTabSync();
  $('panelClose').innerHTML = ICON.x; $('panelBack').innerHTML = ICON.back;
  $('panelOk').innerHTML = ICON.check; $('panelOk').setAttribute('aria-label', t('plDone'));
  $('bCenter').innerHTML = ICON.center; $('bCenter').setAttribute('aria-label', t('qCenter'));
  $('bQuick').setAttribute('aria-label', t('quickTitle'));

  railState();
}
/* ---------- що показувати на карті: перелік шарів і перемикання ----------
   До 1.1.19 галочки жили у віконці кнопки «Шари» справа вгорі й повторювали квадратики в «Місцях». З 1.1.20 (прохання
   Олексія) кнопки й віконця немає: усі одинадцять галочок — у «Місцях» (плитки), там же «Показати все / Прибрати все»
   й «Готово». Екран вільніший, вибір — в одному місці. */
// значок камери — такий самий, як на карті: фотоапарат у білому колі з червоним обідком
const CAM_SVG = '<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="13" fill="#fff" stroke="#e5484d" stroke-width="3.2"/><rect x="11.4" y="8.6" width="7.2" height="3.6" rx="1" fill="#1f2937"/><rect x="6.5" y="10.45" width="17" height="11.5" rx="2.4" fill="#1f2937"/><circle cx="15" cy="16.2" r="3.9" fill="#fff"/><circle cx="15" cy="16.2" r="2.3" fill="#1f2937"/><circle cx="20.7" cy="13" r="1.2" fill="#e5484d"/></svg>';
const LAYERS = [
  ['fuel', 'f', 'lyFuel'], ['food', 'e', 'lyFood'], ['park', 'p', 'lyPark'], ['motel', 'm', 'lyMotel'], ['shower', 'h', 'lyShower'], ['cam', 'c', 'lyCam'],
  ['@mapVerified', '', 'lyVerified'], ['@mapReports', '', 'lyReports'], ['@mapEvents', '', 'lyEvents'], ['@mapHazards', '', 'lyHazards'], ['@roughMap', '', 'lyRough']
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
/** Усе ввімкнути (true) або все вимкнути — чиста карта (false): усі одинадцять шарів. */
function setAllLayers(v) {
  const m = {}; for (const [kk] of LAYERS) if (kk[0] !== '@') m[kk] = v;
  if (v) S.mapStops = true;
  S.mapStopTypes = m; S.mapEvents = v; S.mapHazards = v; S.roughMap = v; S.mapVerified = v; S.mapReports = v;
}

/* ---------- швидкі налаштування: одна кнопка → шторка з великими плитками (як шторка Android) ----------
   Звук, 3D, північ/курс, моє місце, шари, запис, тема, екран, налаштування, масштаб. Сама ховається за 15 с без дотиків,
   щоб у дорозі не лишилась відкритою. Значок на кнопці показує, що звук вимкнено чи йде запис. */
const Q_IDLE = 15000;
let quickTimer = null;
const THEME_NEXT = { auto: 'day', day: 'night', night: 'auto' };
/* ---------- тип карти: перемикач справа вгорі ----------
   1.1.19 — віконце з вибором і посиланнями в Google Maps; 1.1.20 (прохання Олексія) — ОДИН ДОТИК, як «2D / 3D»:
   клац — супутник, ще клац — схема. Без віконець і без виходу з програми. Повідомлень про перемикання теж немає
   (1.1.21): карта змінилась на очах — це й так видно.
   1.1.22: кругла мініатюра була незрозуміла («що це за кружок?»). Тепер це перемикач із двох зрозумілих значків —
   складена карта (схема) і супутник над Землею (знімки); той, що ввімкнений, підсвічено. Дотик будь-де — перемкнути.
   Без інтернету супутника немає: його значок блідий, дотик лише пояснює (карта лишається завантаженою).
   1.1.22 (на прохання Олексія): два значки одразу — зайве на екрані. Тепер це одна кругла кнопка зі значком того виду,
   який працює ЗАРАЗ: схема — складена карта, супутник — супутник над Землею. Дотик — вид міняється, значок разом із ним. */
const MT_PIC = {
  scheme: '<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M3.5 7.4 10.4 4.6l7.2 2.8 6.9-2.8v16L17.6 23.4l-7.2-2.8-6.9 2.8z" fill="#f7f3e6" stroke="#6b7280" stroke-width="1.5" stroke-linejoin="round"/><path d="M10.4 4.6v16M17.6 7.4v16" stroke="#b9bec7" stroke-width="1.2"/><path d="M5 16.8c2.6-.6 3.9-3.6 6.6-4.2 2.6-.6 3.4 1.9 6 1.2 2-.5 3.2-2.2 5.4-3.2" fill="none" stroke="#f5a300" stroke-width="2.2" stroke-linecap="round"/><circle cx="20.3" cy="17.8" r="1.7" fill="#2f6bff"/></svg>',
  sat: '<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M2.5 28a11.5 11.5 0 0 1 23 0z" fill="#2f7fd6"/><path d="M6.3 24.2c1.7-1.5 4-1.3 5 .2.8 1.3-.3 2.3.3 3.6H4.8c.1-1.5.6-2.8 1.5-3.8zM16.4 22.3c1.5-.9 3.6-.5 4.7.9.9 1.2 1.9 2.9 2.2 4.8h-5.4c-.8-1.8-2.9-3.8-1.5-5.7z" fill="#3fa650"/><g transform="rotate(-38 14 10)"><rect x="11.3" y="6.4" width="5.4" height="7.2" rx="1.1" fill="#e5e7eb" stroke="#374151" stroke-width="1.3"/><rect x="3.3" y="7.7" width="6.2" height="4.6" rx=".7" fill="#2f6bff" stroke="#1e3a8a" stroke-width="1.1"/><rect x="18.5" y="7.7" width="6.2" height="4.6" rx=".7" fill="#2f6bff" stroke="#1e3a8a" stroke-width="1.1"/><path d="M9.5 10h1.8M16.7 10h1.8M6.4 7.7v4.6M21.6 7.7v4.6" stroke="#1e3a8a" stroke-width="1"/><path d="M14 13.6v2.2" stroke="#374151" stroke-width="1.3" stroke-linecap="round"/></g></svg>'
};
const mtShown = () => mapM.satOn() ? 'sat' : 'scheme';
function mapTypeTap() {
  if (!$('quick').hidden) quickOpen(false);
  if (mtShown() === 'scheme' && !P.online()) { toast(t('mtSatOffline'), 'yellow', 5000); return; }   // супутник без інтернету — неможливо: пояснюємо, карту не чіпаємо
  S.mapType = mtShown() === 'sat' ? 'scheme' : 'sat';                                                   // settings → map.applySat
  railState();
}
function quickHtml() {
  const head = title => `<div class="q-head"><b>${title}</b><button class="q-x" data-q="close" aria-label="${t('close')}">${ICON.x}</button></div>`;
  const tile = (k, icon, label, state, on, extra = '') => `<button class="q-tile${on ? ' on' : ''}${extra}" data-q="${k}" aria-pressed="${!!on}">${icon}<span class="q-l">${label}</span><span class="q-s">${state}</span></button>`;
  const th = S.theme || 'auto';
  return head(t('quickTitle')) + `<div class="q-grid">
    ${tile('voice', S.voice ? ICON.vol : ICON.mute, t('qVoice'), S.voice ? t('qOn') : t('qOff'), S.voice, S.voice ? '' : ' warn')}
    ${tile('3d', `<b class="q-txt">${S.view3d ? '3D' : '2D'}</b>`, t('qView'), S.view3d ? t('q3d') : t('q2d'), S.view3d)}
    ${tile('north', view.north ? ICON.north : ICON.head, t('qOrient'), view.north ? t('qNorthUp') : t('qHeadUp'), view.north)}
    ${tile('center', ICON.center, t('qCenter'), view.follow ? t('qFollowOn') : t('qFollowOff'), view.follow)}
    ${tile('rec', ICON.rec, t('qRec'), S.rec ? t('qRecOn') : t('qOff'), S.rec, S.rec ? ' rec' : '')}
    ${tile('theme', th === 'night' ? ICON.moon : th === 'day' ? ICON.sun : ICON.auto, t('qTheme'), t(th === 'night' ? 'themeNight' : th === 'day' ? 'themeDay' : 'themeAuto'), false)}
    ${tile('awake', ICON.awake, t('qAwake'), S.keepAwake !== false ? t('qAwakeOn') : t('qAwakeOff'), S.keepAwake !== false)}
    ${tile('settings', ICON.gear, t('qSettings'), t('qAll'), false)}
    ${tile('cal', ICON.calTab, t('qCal'), t(calFresh() ? 'qCalOk' : calGet() ? 'qCalOld' : 'qCalNo'), false, calFresh() ? ' cal-ok' : '')}
  </div>`;        // (1.1.26) рядка «− Масштаб +» тут більше немає: карту наближають двома пальцями
}
function quickRender() { const box = $('quick'); if (!box.hidden) box.innerHTML = quickHtml(); }
function quickIdle() { clearTimeout(quickTimer); quickTimer = setTimeout(() => quickOpen(false), Q_IDLE); }
// open: false — закрити; інше — відкрити плитки
export function quickOpen(open) {
  const box = $('quick');
  if (open) { box.hidden = false; box.innerHTML = quickHtml(); $('spdPop').hidden = true; quickIdle(); }
  else { box.hidden = true; clearTimeout(quickTimer); }
  $('bQuick').classList.toggle('on', !!open); $('bQuick').setAttribute('aria-expanded', String(!!open));
}
function quickClick(e) {
  quickIdle();
  const b = e.target.closest('[data-q]'); if (!b) return;
  const k = b.dataset.q;
  if (k === 'close') return quickOpen(false);
  if (k === 'cal') { quickOpen(false); if (tsOpen()) tsHide(false); closePanel(); calibOpen(); return; }      // (1.1.24) калібрування телефона — звідси
  if (k === 'voice') { S.voice = !S.voice; if (!S.voice) P.stopSpeak(); toast(t(S.voice ? 'voiceOn' : 'voiceOff'), '', 1800); }
  else if (k === '3d') { S.view3d = !S.view3d; setFollow(true); }
  else if (k === 'north') { view.north = !view.north; setFollow(true); }
  else if (k === 'center') { setFollow(true); quickOpen(false); return; }
  else if (k === 'rec') toggleRec();
  else if (k === 'theme') { S.theme = THEME_NEXT[S.theme || 'auto']; applyTheme(); }
  else if (k === 'awake') { S.keepAwake = S.keepAwake === false; P.keepAwake(S.keepAwake); }
  else if (k === 'settings') { quickOpen(false); currentPanel() === 'settings' ? closePanel() : openPanel('settings'); return; }
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
  const mb = $('bMap'), cur = mtShown(), key = cur + (P.online() ? '' : '-nonet');
  if (mb.dataset.k !== key) { mb.dataset.k = key; mb.classList.toggle('nonet', !P.online());
    mb.innerHTML = `<span class="mt-seg on" data-k="${cur}">${MT_PIC[cur]}</span>`;
    mb.setAttribute('aria-pressed', String(cur === 'sat')); mb.setAttribute('aria-label', t(cur === 'sat' ? 'mtBtnSat' : 'mtBtnScheme')); }
  const c = $('bCenter'), need = !view.follow;
  if (c.hidden === need) { c.hidden = !need; c.classList.toggle('need', need); }
  quickRender();
}

const WHY = { timeout: 'whyTimeout', spoof: 'whySpoof', weak: 'whyWeak', manual: 'whyManual' };
let lostShown = null;
export const lostReason = () => t(WHY[pos.reason] || 'whyTimeout') + ' ' + (pos.onRoute ? t('drRoute') : t('drFree'));
// Кнопка «Поворот» (без GPS): куди повертати, скільки до повороту і що зараз — їдемо до нього, чекаємо на ньому чи вже повертаємо.
// Натиснути — «я на цьому повороті»: позначка стає одразу за ним (якщо телефон поворот не відчув або позначка відстала).
const TURN_IC = {
  r: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 20v-7a4 4 0 0 1 4-4h8"/><path d="M14 5l4 4-4 4"/></svg>',
  l: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 20v-7a4 4 0 0 0-4-4H6"/><path d="M10 5L6 9l4 4"/></svg>',
  o: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/></svg>',
};
let turnKey = '', waitHintFor = null, waitVoiced = false;
function turnBtnSync(lost) {
  const b = $('bTurn'), c = lost ? pos.cp : null;
  if (!c) { if (!b.hidden) { b.hidden = true; turnKey = ''; $('nudge').classList.remove('has-turn'); document.body.classList.remove('turn-on'); requestAnimationFrame(layoutVars); } if (!lost) { waitHintFor = null; waitVoiced = false; } return; }
  const label = c.state === 'wait' ? t('turnWait') : c.state === 'turn' ? t('turnNow') : fmtDist(c.dist);
  const key = [c.sgn, c.cls, c.state, label, c.handled].join('|');
  if (key !== turnKey) {
    turnKey = key;
    b.className = 'turn-btn ' + c.cls + ' st-' + c.state + (c.handled ? ' hand' : '');
    b.innerHTML = TURN_IC[c.sgn > 0 ? 'r' : c.sgn < 0 ? 'l' : 'o'] + `<span>${esc(label)}</span>`;
  }
  if (b.hidden) { b.hidden = false; $('nudge').classList.add('has-turn'); document.body.classList.add('turn-on'); requestAnimationFrame(layoutVars); }
  // позначка стоїть на повороті понад 25 с, а машина (за трясінням) їде — підкажемо про кнопку: раз на поворот, голосом — раз за втрату GPS
  if (c.state === 'wait' && Date.now() - c.since > 25000 && pos.spd > 0.5 && waitHintFor !== c.d) {
    waitHintFor = c.d; toast(t('turnWaitHint', cpWhat(c)), 'yellow', 9000);
    if (!waitVoiced) { waitVoiced = true; say(t('voiceTurnWait')); }
  }
}
// найближчий контрольний поворот попереду на рейсі (там без GPS місце звіряється за гіроскопом)
export function nextCp(min = 150) { if (!g.active || pos.rd == null || !pos.onRoute) return null; const d = pos.rd; return routeCps().find(c => c.d > d + min) || null; }
export const cpWhat = c => t(c.cls === 'red' ? 'cpRed' : 'cpYellow', t(c.ang > 0 ? 'cpRight' : 'cpLeft'));

export const locState = { known: false, enabled: null, gps: null, fine: null, listening: false, error: '' };
let searchSince = Date.now(), indoorHinted = false, offWarned = false;
const accText = a => a == null ? '' : a >= 1000 ? (a / 1000).toFixed(1).replace('.', ',') + ' ' + t('km') : a + ' ' + t('m');
function hud() {
  // швидкість
  const sv = speedView(), sp = $('speed'), kmh = sv.kmh || 0;
  const guess = sv.kind === 'approx' || sv.kind === 'est' || sv.kind === 'manual' || sv.kind === 'plan';
  const spdTxt = sv.kind === 'none' ? '—' : (guess ? '≈' : '') + (kmh < 2 ? '0' : Math.round(kmh));
  $('spdVal').textContent = spdTxt;
  // (1.1.24) круг менший, знак обмеження — ліворуч угорі: три цифри («100») і «≈100» пишемо дрібніше, щоб знак їх не закривав
  sp.classList.toggle('d3', !guess && spdTxt.length >= 3); sp.classList.toggle('d4', guess && spdTxt.length >= 4);
  $('spdUnit').textContent = sv.kind === 'none' ? t('spdUnknown') : sv.kind === 'est' ? t('spdEst') : sv.kind === 'plan' ? t('spdPlan') : sv.kind === 'approx' ? t('spdNet') : sv.kind === 'manual' ? t('spdManual') : sv.kind === 'still' && manualSpeed() === 0 ? t('standShort') : t('kmh');
  sp.classList.toggle('est', sv.kind !== 'gps' && sv.kind !== 'still');
  sp.classList.toggle('wide', guess);
  const cam = S.cams ? poi.nextCam : null;
  // червоний — коли перевищено більш ніж на 20 км/год (з цього починається штраф); без GPS — червоно-помаранчевий
  const lim = limitNow(), over = sv.kind !== 'none' && overLimit(kmh, lim);
  sp.classList.toggle('over', over);
  // знак обмеження в населеному пункті — видно весь час, поки воно діє, навіть без перевищення; з'являється з «підскоком»
  const ls = $('spdLim'), lsHide = !lim || lim.src === 'cam';
  if (ls.hidden && !lsHide) { ls.classList.remove('pop'); void ls.offsetWidth; ls.classList.add('pop'); }
  ls.hidden = lsHide; if (lim) { ls.textContent = lim.max; ls.title = lim.name || ''; }
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
  // кружечок GPS біля круга швидкості, праворуч унизу (1.1.22; до того — у нижній стрічці): є справжній GPS — зелений, немає — червоний
  const gOk = pos.mode === 'gps' && !off && !spoofNow, tg = $('spdGps');
  tg.classList.toggle('g-ok', gOk); tg.classList.toggle('g-bad', !gOk);
  const gShort = gOk ? (pos.acc != null ? '±' + accText(pos.acc) : 'GPS') : pos.mode === 'dr' ? 'GPS ✕' : off ? t('locOffChip') : t('tabNoGps');
  if (tg.dataset.s !== gShort) tg.dataset.s = gShort;
  if (Date.now() - repTabT > 4000) repTabSync();
  let gLbl = gOk ? 'GPS' + (pos.acc != null ? ' ±' + accText(pos.acc) : '') : gShort;
  // GPS шукає вже хвилину, а геолокація ввімкнена — швидше за все, телефон у приміщенні
  if (pos.mode === 'gps' || pos.mode === 'dr' || pos.sim) searchSince = Date.now();
  else if (!indoorHinted && !off && Date.now() - searchSince > 60000) { indoorHinted = true; toast(t('gpsIndoor'), 'yellow', 12000, () => openPanel('gps')); }

  // режим втрати сигналу
  const lost = pos.mode === 'dr';
  if (lost !== lostShown) {
    lostShown = lost;
    $('nudge').hidden = !lost; $('gpsChip').hidden = lost; $('zoom').classList.toggle('dr', lost); document.body.classList.toggle('dr-on', lost);   // без GPS місце «Мого місця» над повзунком тримаємо завжди: ±100 не стрибають
    if (!lost) $('bAcceptGps').hidden = true;
    requestAnimationFrame(layoutVars);
  }
  turnBtnSync(lost);
  if (lost) {
    const ms = manualSpeed();
    // червоного рядка під часом прибуття більше немає (1.1.6) — подробиці лишились у підписі кружечка GPS і на екрані «GPS»
    gLbl = 'GPS ✕ ' + fmtMS((Date.now() - pos.lostSince) / 1000) + ' · ±' + accText(pos.acc)
      + (pos.reason === 'spoof' ? ' · ' + t('spoofShort') : pos.reason === 'manual' ? ' · ' + t('manualShort') : '')
      + (pos.onRoute ? ' · ' + t('onRouteShort') : '') + (ms != null ? ' · ' + (ms === 0 ? t('standShort') : ms + ' ' + t('kmh')) : '');
    const b = $('bAcceptGps'), show = !!pos.pending;
    if (b.hidden === show) { b.hidden = !show; requestAnimationFrame(layoutVars); }
    if (show) b.textContent = pos.reason === 'manual' ? t('backToGps') : t('acceptGps', fmtDist(pos.pending.d));
  }
  if (tg.getAttribute('aria-label') !== gLbl) tg.setAttribute('aria-label', gLbl);

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
      // (1.1.28) маршрут сам не перебудовується: кажемо, що ведемо запланованим і що дотик до плашки — перебудувати
      $('manText').textContent = g.offRoute ? (pos.off ? fmtDist(pos.off) + ' · ' : '') + t('offRouteTap') : pos.off ? fmtDist(pos.off) : ''; $('manThen').hidden = true;
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

  // ліворуч у нижній плашці: час прибуття, під ним — що лишилось, кожне окремим рядком (між ними невидимий « · »)
  // Місце невисоке — три рядки: у дорозі «час / км / хв»; маршрут побудовано, але не рушили — «км / хв / не запущено» (годинник тут зайвий);
  // прибули — «час / Рейс / завершено».
  let clock = new Date(), parts = [], sep = ' · ', pre = false;
  if (g.arrived) { parts = t('tripDone').split(' '); sep = ' '; }
  else if (g.active && g.route) { clock = new Date(g.eta); parts = [fmtDist(g.remain), fmtDur(g.remTime)]; }
  else if (plan.trip && plan.trip.route) { const r = plan.trip.route; parts = [fmtDist(r.dist), fmtDur(r.time), t('previewReady')]; pre = true; }
  $('eta').textContent = fmtClock(clock); if ($('eta').hidden !== pre) $('eta').hidden = pre;
  const key = parts.join('|'), rm = $('remain');
  if (rm.dataset.k !== key) { rm.dataset.k = key; rm.innerHTML = parts.map(x => `<span>${esc(x)}</span>`).join(`<i>${sep}</i>`); requestAnimationFrame(layoutVars); }
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
  const h0 = el.offsetHeight;
  $('stripText').textContent = off ? t('stripOff') : s.top ? ((s.label ? s.label + ' · ' : '') + (s.top.sum || s.top.text)).replace(/\s+/g, ' ').slice(0, 140) : t('stripEmpty');
  const c = s.counts;
  $('stripCounts').innerHTML = off ? '' : ['red', 'yellow', 'green'].filter(k => c[k]).map(k => `<i class="c-${k}">${c[k]}</i>`).join('');
  if (el.offsetHeight !== h0) requestAnimationFrame(layoutVars);      // (1.1.26) довге повідомлення стало у два рядки — верхня плашка вища: кнопки праворуч і повідомлення посуваються
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

// Перевірені стоянки для фур попереду на маршруті (1.1.22). В Україні фури біля АЗС тепер здебільшого не пускають, тож «стоянкою для фур»
// називаємо лише перевірене місце-стоянку (вид «Стоянка» чи «Стоянка · готель · кафе») — і лише коли ввімкнено галочку «Перевірені».
function truckParksAhead() {
  if (!layerOn('@mapVerified') || !vp.ready) return [];
  return vp.list.filter(p => p.kind === 'park' || p.kind === 'complex').map(p => ({ p, w: vpWhere(p) }))
    .filter(x => x.w && x.w.route && x.w.ahead > -300 && x.w.off <= 1500).sort((a, b) => a.w.ahead - b.w.ahead);
}
function tripActiveHtml() {
  const tr = g.trip;
  const st = stopsAhead(3).slice(0, 3).map(s => { const l = stopLabel(s); return `<div class="item"><div class="grow"><div class="t">${esc(l.title)}</div><div class="muted">${esc(l.sub)}</div></div><b style="font:800 20px var(--f-num)">${fmtDist(Math.max(0, s.d - (pos.rd || 0)))}</b></div>`; }).join('');
  const parks = truckParksAhead().slice(0, 4).map(x => `<button class="item tp-row" data-vpid="${esc(x.p.id)}"><div class="grow"><div class="t">${esc(x.p.name)}</div><div class="muted">${esc(t('vpKind_' + x.p.kind))} · ${t('tpChecked', vpMonth(x.p.checked))}</div></div><b style="font:800 20px var(--f-num)">${fmtDist(Math.max(0, x.w.ahead))}</b></button>`).join('');
  const regs = regionsAhead().map(r => `<span class="pill${feed.air[r.id] ? ' air' : ''}">${esc(oblastName(r.id))}${r.eta > 60 ? ' · ' + fmtDur(r.eta) : ''}</span>`).join('');
  return `<div class="card"><div class="t" style="font-weight:600;margin-bottom:10px">${esc(tripTitle(tr))}</div>
    <div class="kv"><div><b>${fmtDist(g.remain)}</b><span>${t('remainL')}</span></div><div><b>${fmtDur(g.remTime)}</b><span>${t('driveTime')}</span></div><div><b>${g.arrived ? '—' : fmtClock(new Date(g.eta))}</b><span>${t('arrival')}</span></div></div>
    ${regs ? `<div style="margin-top:10px">${regs}</div>` : ''}${offlineHtml()}</div>
  <div class="btns"><button class="btn" data-act="reroute">${t('reroute')}</button><button class="btn" data-act="rerouteFresh">${t('rerouteFresh')}</button></div>
  <div class="btns"><button class="btn" data-act="offline">${t('offlineMap')}</button></div>
  <div class="btns"><button class="btn danger wide" data-act="stop">${t('endTrip')}</button></div>
  ${poi.drive > 300 ? `<div class="sec">${t('driveSec')}</div><div class="card">${t('driveNow', fmtDur(poi.drive))}</div>` : ''}
  <div class="sec">${t('stopsSec')}</div><div class="list">${parks || `<div class="muted">${t(layerOn('@mapVerified') ? 'tpNone' : 'tpOff')}</div>`}</div>
  <div class="sec">${t('stopsOtherSec')}</div><div class="list">${st || `<div class="muted">${poi.loading ? t('loading') : t('stopsNone')}</div>`}</div>
  ${showersRouteHtml(g.route, g.idx, pos.rd || 0)}
  ${truckHtml(g.route, pos.rd || 0, d => Date.now() + Math.max(0, d - (pos.rd || 0)) / Math.max(1, g.remain) * g.remTime * 1000)}
`;
}
/* ---------- «Архів рейсів» і «Зберегти рейс» — дві окремі кнопки (1.1.16) ----------
   Раніше всі збережені рейси розгортались стрічкою під формою «Рейс» (а зберігається кожен рейс, яким рушили, —
   стрічка росла й відсувала форму). Тепер у формі — дві кнопки, з 1.1.18 — ПІД «Прокласти рейс» (у порядку дій:
   вписав точки → проклав → зберіг; архів — поруч), кожна з кольоровим значком: синій годинник — архів (із кількістю
   рейсів на значку), зелена дискета — зберегти:
     • «Архів рейсів» (з кількістю) — окремий екран зі списком: найновіші згори, «Відкрити», кошик (із поверненням);
     • «Зберегти рейс» — зберігає прокладений рейс; якщо рейс іще не прокладено, а фініш уже є — прокладає й зберігає. */
const archList = () => getTrips().filter(x => !g.trip || x.id !== g.trip.id).slice().sort((a, b) => (b.created || 0) - (a.created || 0));
const canSaveTrip = () => !!plan.trip || !!plan.b || !!($('in_b') && $('in_b').value.trim());
function tripToolsHtml() {
  const n = archList().length;
  return `<button class="tt-b" data-act="archive"><em class="tt-ic" aria-hidden="true">${ICON.archive}${n ? `<i>${n}</i>` : ''}</em><span>${t('tripArchive')}</span></button>
    <button class="tt-b${canSaveTrip() ? ' can' : ''}" data-act="saveTrip" ${plan.busy ? 'disabled' : ''}><em class="tt-ic" aria-hidden="true">${ICON.save}</em><span>${t('tripSave')}</span></button>`;
}
function tripToolsSync() { const b = $('tripTools'); if (b) b.innerHTML = tripToolsHtml(); }
/** Зберегти прокладений рейс і почати з чистого аркуша (його видно в «Архіві рейсів»). */
function saveCurrentTrip() {
  const tr = plan.trip; if (!tr) return;
  if (tr.route) delete tr.route.alts;
  plan.routes = []; saveTrip(tr); toast(t('saved'), 'green', 4000);
  plan.trip = null; plan.a = plan.v = plan.b = null; pickHide(); previewRoute(null); previewAlts(null); mapM.previewPoints(null); hud(); openPanel('trip');
}
function saveTripTap() {
  if (plan.busy) return;
  if (plan.trip) { saveCurrentTrip(); return; }
  if (!canSaveTrip()) { toast(t('tripSaveNeed'), 'yellow', 5000); const i = $('in_b'); if (i) i.focus(); return; }
  plan.saveAfter = true; toast(t('tripSaving'), '', 4000); doBuild();        // рейс іще не прокладено: прокладаємо й одразу зберігаємо
}
const archDate = x => { try { return x.created ? new Date(x.created).toLocaleDateString(S.lang === 'ru' ? 'ru-RU' : 'uk-UA', { day: 'numeric', month: 'short' }) : ''; } catch (_) { return ''; } };
function archiveHtml() {
  const list = archList();
  if (!list.length) return `<div class="arch-empty">${ICON.archive}<div>${t('archEmpty')}</div></div>`;
  return `<div class="muted arch-hint">${t('archHint')}</div><div class="list arch">` + list.map(x => `<div class="item"><div class="grow"><div class="t">${esc(tripTitle(x))}</div>
      <div class="muted">${[x.route ? fmtDist(x.route.dist) + ' · ' + fmtDur(x.route.time) : '', archDate(x)].filter(Boolean).join(' · ')}</div></div>
    <button class="btn sm pri" data-open="${x.id}">${t('open')}</button><button class="btn sm arch-del" data-del="${x.id}" aria-label="${t('delete')}">${ICON.trash}</button></div>`).join('') + '</div>';
}
function openSavedTrip(id) {
  const tr = getTrips().find(x => x.id === id); if (!tr || !tr.route) return;
  plan.routes = []; plan.sel = 0; plan.trip = tr; plan.a = tr.a; plan.v = tr.v; plan.b = tr.b; plan.off = null;
  mapM.previewPoints(tr); previewRoute(tr.route.coords, tr.route); hud(); openPanel('trip'); loadRegions(tr);
}
function archClicks(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.open) openSavedTrip(b.dataset.open);
  else if (b.dataset.del) {
    const tr = getTrips().find(x => x.id === b.dataset.del); if (!tr) return;
    deleteTrip(tr.id); archRedraw();
    toast(t('tripDeleted'), '', 7000, () => { saveTrip(tr); toast(t('tripRestored'), 'green', 3000); });      // випадковий дотик до кошика — можна повернути
  }
}
function archRedraw() { if (currentPanel() === 'archive') { const b = $('panelBody'), st = b.scrollTop; b.innerHTML = archiveHtml(); b.scrollTop = st; } }
definePanel('archive', {
  title: () => t('tripArchive'), back: 'trip', tab: 'trip',
  render(body) { body.innerHTML = archiveHtml(); body.onclick = archClicks; body.oninput = null; body.onfocusin = null; },
  update(body) { body.innerHTML = archiveHtml(); }
});
// Поле точки рейсу: значок (старт / через / фініш), текст — або кнопка «на карті»: поставити точку пальцем
function fieldHtml(k, ph) {
  const v = k === 'a' && startIsMe() ? null : plan[k];
  // Старт: поле + два явні способи під ним — «З мого місця» (за замовчуванням) або «Вказати на карті».
  // Через і фініш: текст або кнопка «на карті» в полі.
  return `<div class="field"><div class="tag ${k}" title="${t(PT_NAME[k])}">${PT_SVG[k]}</div><input id="in_${k}" data-f="${k}" placeholder="${esc(ph)}" value="${esc(v ? v.label : '')}" autocomplete="off" enterkeyhint="search">
    ${k === 'a' ? '' : `<button class="onmap" data-onmap="${k}" aria-label="${t('ptOnMap')}: ${t(PT_NAME[k])}">${ICON.pin}</button>`}
    <button data-clear="${k}" aria-label="${t('clear')}">${ICON.x}</button></div><div class="sugg" id="sg_${k}" hidden></div>
    ${k === 'a' ? `<div class="pt-two" id="startTwo">${startTwoHtml()}</div>` : ''}`;
}
const startTwoHtml = () => `<button class="${startIsMe() ? 'on' : ''}" data-here="1">${ICON.here}<span>${t('ptFromMeBtn')}</span></button><button class="${startIsMe() ? '' : 'on'}" data-onmap="a">${ICON.pin}<span>${t('ptOnMapBtn')}</span></button>`;
const startTwoSync = () => { const e = $('startTwo'); if (e) e.innerHTML = startTwoHtml(); };
function planHtml() {
  // Лише три точки: старт — звідки, через (проміжна, необов'язково), фініш — куди. Нічого зайвого (душі тощо — на карті й у дорозі).
  return `<div id="planSum">${plan.trip ? planSumHtml() : ''}</div><div class="sec" id="newSec" ${plan.trip ? '' : 'hidden'}>${t('newTrip')}</div>
    ${fieldHtml('a', t('phA'))}${fieldHtml('v', t('phV'))}${fieldHtml('b', t('phB'))}
    <div class="muted pt-hint">${ICON.pin}<span>${t('ptFormHint')}</span></div>
    ${vehHtml()}
    <div class="btns"><button class="btn pri wide" data-act="build" ${plan.busy ? 'disabled' : ''}>${plan.busy ? t('building') : t('build')}</button></div>
    <div id="planErr" class="muted" style="color:var(--red);margin-top:8px">${esc(plan.err)}</div>
    <div class="trip-tools" id="tripTools">${tripToolsHtml()}</div>`;
}
// Знак «фурам заборонено», а іншої дороги немає й усі їздять: рейс уже показано, тим часом питаємо сервер про варіант
// через такі дороги. Якщо він помітно коротший — додаємо третьою карткою; вибирає водій.
async function softOffer(trip, strict) {
  try {
    await new Promise(r => setTimeout(r, 1200));                       // публічний сервер — не частіше запиту на секунду
    if (plan.trip !== trip) return;
    const sv = await softVariant(trip, strict);
    if (!sv || plan.trip !== trip || g.active || plan.routes.some(x => x.soft === 'alt')) return;
    plan.routes = [...plan.routes, sv].slice(0, 3);
    previewAlts(plan.routes.map((x, k) => [k, x.coords]).filter(([k]) => k !== plan.sel));
    refresh('trip'); if (!$('routePick').hidden) { pickShow(); }
    toast(t('softFound', sv.saves.km, sv.saves.min), 'yellow', 9000);
  } catch (e) { log('info', 'варіант через заборону для фур: ' + (e && e.message)); }
}
// (1.1.28) Яким буде рейс — вибирають ДО побудови, і під кнопками одразу написано, що це означає:
//  • «Фура: суворо» — жорсткі обмеження: лише дорогами, де фурі можна (габарити, маса, мости, знаки). Шлях може бути довшим.
//  • «Фура: на свій розсуд» — той самий рейс дорогами загального користування: обмеження для фур не враховано, за знаками водій стежить сам.
//  • «Легкова» — без обмежень і без обмежувача швидкості.
const vehKind = () => S.vehicle === 'auto' ? 'car' : S.routeMode === 'free' ? 'free' : 'strict';
function vehHtml() {
  const k = vehKind(), b = (kind, veh, mode, ico, l1, l2) => `<button data-veh="${veh}"${mode ? ` data-mode="${mode}"` : ''} data-kind="${kind}" class="${k === kind ? 'on' : ''}" aria-pressed="${k === kind}">${ico}<span><b>${l1}</b>${l2 ? `<small>${l2}</small>` : ''}</span></button>`;
  return `<div class="seg veh veh3">${b('strict', 'truck', 'strict', ICON.truck, t('vehTruck'), t('vehStrict'))}${b('free', 'truck', 'free', ICON.truck, t('vehTruck'), t('vehFree'))}${b('car', 'auto', '', ICON.car, t('vehCar'), '')}</div>
    <div class="veh-hint ${k}" id="vehHint">${vehHintHtml(k)}</div>`;
}
const vehHintHtml = k => `<b>${t('vehHintT_' + k)}</b> ${t('vehHint_' + k)}`;
// Те саме — одним рядком на екрані вибору маршруту (рейс уже прокладено: з форми, з точки на карті, з архіву). Натиснули інший вид —
// той самий рейс одразу перераховується для нього. Так вид транспорту видно й можна змінити там, де рейс підтверджують.
function vehMiniHtml() {
  const k = vehKind(), b = (kind, veh, mode, ico, lbl) => `<button data-veh="${veh}"${mode ? ` data-mode="${mode}"` : ''} data-kind="${kind}" class="${k === kind ? 'on' : ''}" aria-pressed="${k === kind}">${ico}<span>${lbl}</span></button>`;
  return `<div class="seg veh vehm" role="group" aria-label="${t('vehMiniAria')}">${b('strict', 'truck', 'strict', ICON.truck, t('vehMini_strict'))}${b('free', 'truck', 'free', ICON.truck, t('vehMini_free'))}${b('car', 'auto', '', ICON.car, t('vehCar'))}</div>`;
}
async function pickKind(veh, mode) {
  if (plan.busy || !plan.trip) return;
  S.vehicle = veh; if (mode) S.routeMode = mode;
  const box = $('routePick'), k = vehKind();
  box.classList.add('busy'); box.querySelectorAll('.vehm button').forEach(x => { x.classList.toggle('on', x.dataset.kind === k); x.setAttribute('aria-pressed', String(x.dataset.kind === k)); });
  try { await doBuild(); } finally { box.classList.remove('busy'); }
  if (!plan.trip) { toast(plan.err || t('routeFail'), 'red', 7000); openPanel('trip'); }     // не вдалося — показуємо форму з поясненням
}
// Варіанти маршруту карточками (до трьох): час, кілометри, головні дороги, обмеження для фури
function altCardsHtml(force = false) {
  const rs = plan.routes || []; if (rs.length < 2 && !force) return '';
  const truck = plan.trip && plan.trip.costing !== 'auto';
  const best = Math.min(...rs.map(r => r.time));
  return `<div class="alts">` + rs.map((r, i) => {
    const red = truck ? hazardsAlong(r).filter(h => h.level === 'red').length : 0;
    const ky = kyivOnRoute(r, 0, d => Date.now() + d / Math.max(1, r.dist) * r.time * 1000);
    const softCard = truck && ['alt', 'only', 'chosen'].includes(r.soft);
    const flags = [softCard ? `<i class="warn">${t('altSoft')}</i>` : '', red ? `<i class="bad">${t('altLimits', red)}</i>` : '', ky && !ky.inside ? `<i>${t('altKyiv')}</i>` : '', r.time === best && rs.length > 1 ? `<i class="good">${t('altFastest')}</i>` : ''].join('');
    return `<button class="alt${i === plan.sel ? ' on' : ''}${softCard ? ' soft' : ''}" data-alt="${i}"><b>≈ ${fmtDur(r.time)}</b><span>${fmtDist(r.dist)}</span><small>${esc(mainRoads(r).join(', ') || t('altLocal'))}</small>${flags ? `<span class="fl">${flags}</span>` : ''}</button>`;
  }).join('') + `</div>`;
}
function selectAlt(i) {
  const tr = plan.trip, r = plan.routes[i]; if (!tr || !r) return;
  plan.sel = i; tr.route = r; tr.regions = []; tr.towns = []; tr.chosen = null;
  tr.soft = ['alt', 'only', 'chosen'].includes(r.soft) ? (r.soft === 'only' ? 'only' : 'chosen') : null;      // вибрано варіант через знак «фурам заборонено» — у дорозі перебудовуємо так само
  previewRoute(r.coords, r); previewAlts(plan.routes.map((x, k) => [k, x.coords]).filter(([k]) => k !== i));
  hud(); refresh('trip'); loadRegions(tr);
  if (!$('routePick').hidden) pickShow();
}
/* ---------- екрани маршруту відкриваються з чистою картою ---------- */
// І вибір варіанта, і «Маршрут» у дорозі показують лише дороги, області й сам маршрут — без кольорових кружечків
// піт-стопів, камер, подій та інших позначок. Хто хоче — вмикає їх кнопкою над «+»; закрили екран — наступного разу знову чисто.
let rpMarks = false;
const rpMarksBtn = () => `<button data-rp="marks" class="rp-mk${rpMarks ? ' on' : ''}" aria-pressed="${rpMarks}" aria-label="${t(rpMarks ? 'rpMarksHide' : 'rpMarksShow')}">${ICON.layersPin}</button>`;
function rpSync() { const open = !$('routePick').hidden; if (!open) rpMarks = false; mapM.setClean(open && !rpMarks); }
function rpMarksToggle(b) {
  rpMarks = !rpMarks; rpSync();
  b.classList.toggle('on', rpMarks); b.setAttribute('aria-pressed', String(rpMarks)); b.setAttribute('aria-label', t(rpMarks ? 'rpMarksHide' : 'rpMarksShow'));
  toast(t(rpMarks ? 'rpMarksOn' : 'rpMarksOff'), '', 2500);
}
/* ---------- вибір варіанта, як у BlindDriver: карта з обома маршрутами зверху, дві карточки й кнопки знизу ---------- */
function pickHtml() {
  const tr = plan.trip;
  return `<div class="rp-zoom">${rpMarksBtn()}<button data-rp="zin" aria-label="${t('qZoomIn')}">+</button><button data-rp="zout" aria-label="${t('qZoomOut')}">−</button><button data-rp="fit" aria-label="${t('rpFit')}">${ICON.route}</button></div>
    <div class="rp-head">${ptTag('a', 'rp-t')}<b>${esc(tr.a.label || '')}</b>${tr.v ? `${ptTag('v', 'rp-t')}<b>${esc(tr.v.label || '')}</b>` : ''}${ptTag('b', 'rp-t')}<b>${esc(tr.b.label || '')}</b>${plan.routes.length < 2 ? ` <span class="muted">· ${t('altOne')}</span>` : ''}</div>
    ${vehMiniHtml()}${pickWarnHtml()}${altCardsHtml(true).replace('class="alts"', 'class="alts rp-cards"')}
    <div class="rp-btns"><button class="btn pri" data-rp="go">${ICON.go}${t('go')}</button><button class="btn" data-rp="save">${t('saveShort')}</button><button class="btn" data-rp="info">${t('details')}</button><button class="btn rp-x" data-rp="x" aria-label="${t('close')}">${ICON.x}</button></div>`;
}
// для фури проїзду не знайшлося — показуємо звичайний маршрут із червоним попередженням; старт/фініш перенесено на основну дорогу — тихо кажемо
// Варіант дорогою зі знаком «фурам заборонено»: чесно кажемо, що це за варіант і що враховано
function softWarnHtml(r, cls = 'rp-warn soft') {
  if (!r || r.costing === 'auto') return '';
  if (r.soft === 'only') return `<div class="${cls}"><b>${t('softOnlyTitle')}.</b> ${t('softOnlyText')}</div>`;
  if (r.soft === 'alt' || r.soft === 'chosen') return `<div class="${cls}"><b>${t('softTitle')}.</b> ${r.saves ? t('softSaves', r.saves.km, r.saves.min) + ' ' : ''}${t('softText')}</div>`;
  if (r.soft === 'go') return `<div class="${cls} mild">${t('softGo')}</div>`;
  return '';
}
function pickWarnHtml() {
  const r = plan.routes[plan.sel] || plan.trip.route;
  if (r && r.costing === 'auto' && !r.truckFail && plan.trip.free) return `<div class="rp-warn soft"><b>${t('freeTitle')}.</b> ${t('freeText')}</div>`;
  return r && r.truckFail ? `<div class="rp-warn red"><b>${t('truckFailTitle')}.</b> ${t('truckFailShort')}</div>` : softWarnHtml(r) || (r && r.snapped ? `<div class="rp-warn">${t('truckSnapped')}</div>` : '');
}
function pickShow() {
  if (!plan.trip || g.active) return pickHide();
  const box = $('routePick'); box.innerHTML = pickHtml(); box.hidden = false;
  requestAnimationFrame(pickFit);
}
// Скільки лишити праворуч, щоб рейс не ховався під стовпчиком кнопок масштабу (він стоїть біля правого краю шторки)
const zoomPad = box => { const z = box.querySelector('.rp-zoom'); return z ? window.innerWidth - z.getBoundingClientRect().left + 14 : 70; };
// Увесь маршрут (обидва варіанти) цілком — у вільній частині карти над шторкою
function pickFit() {
  const box = $('routePick'); if (box.hidden || !plan.trip) return;
  const tp = $('top'), top = (tp.hidden ? 0 : tp.getBoundingClientRect().bottom) + 24, bottom = box.getBoundingClientRect().height + 34;
  fitRoutes(plan.routes.map(r => r.coords), top, bottom, zoomPad(box));
}
function pickHide() { const box = $('routePick'); if (!box.hidden) { box.hidden = true; freeView(); } }
function pickCancel() { plan.trip = null; plan.routes = []; plan.sel = 0; pickHide(); previewRoute(null); hud(); setFollow(true); }   // скасували — карта знову за машиною
/* ---------- (1.1.28) новий маршрут у дорозі: кілька варіантів на вибір ---------- */
// Водій з'їхав із рейсу й вибрав «Новий маршрут» — показуємо всі варіанти звідси: для фури («суворо»), дорогами загального користування
// («на свій розсуд»), для легкової — легкові. Картка: вид, час, кілометри, головні дороги. Вибрав і підтвердив — це новий рейс.
// «Лишити старий» або час вийшов — нічого не міняється.
const rrOpen = () => $('routePick').dataset.mode === 'rr' && !$('routePick').hidden;
let rrTick = 0, rrFitN = -1;
function rrCardsHtml(c) {
  const best = Math.min(...c.routes.map(x => x.r.time));
  return `<div class="alts rp-cards rr-cards n${Math.min(4, c.routes.length)}">` + c.routes.map((x, i) => {
    const r = x.r, truck = r.costing === 'truck', red = truck ? hazardsAlong(r).filter(h => h.level === 'red').length : 0;
    const flags = [r.truckFail ? `<i class="bad">${t('rrNoTruck')}</i>` : '', truck && ['alt', 'only', 'chosen', 'go'].includes(r.soft) ? `<i class="warn">${t('altSoft')}</i>` : '', red ? `<i class="bad">${t('altLimits', red)}</i>` : '', r.time === best && c.routes.length > 1 ? `<i class="good">${t('altFastest')}</i>` : ''].join('');
    return `<button class="alt${i === c.sel ? ' on' : ''}" data-rrv="${i}" aria-pressed="${i === c.sel}"><em class="rr-kind ${x.kind}">${t('rrKind_' + x.kind)}</em><b>≈ ${fmtDur(r.time)}</b><span>${fmtDist(r.dist)}</span><small>${esc(mainRoads(r).join(', ') || t('altLocal'))}</small>${flags ? `<span class="fl">${flags}</span>` : ''}</button>`;
  }).join('') + `</div>`;
}
function rrHtml() {
  const c = g.choice, tr = g.trip, sel = c.routes[c.sel];
  const warn = !sel ? '' : sel.r.truckFail ? `<div class="rp-warn red"><b>${t('truckFailTitle')}.</b> ${t('truckFailShort')}</div>` : sel.kind === 'free' ? `<div class="rp-warn soft"><b>${t('freeTitle')}.</b> ${t('freeText')}</div>` : softWarnHtml(sel.r);
  return `<div class="rp-zoom"><button data-rp="zin" aria-label="${t('qZoomIn')}">+</button><button data-rp="zout" aria-label="${t('qZoomOut')}">−</button><button data-rp="fit" aria-label="${t('rpFit')}">${ICON.route}</button></div>
    <div class="rp-head">${ptTag('b', 'rp-t')}<b>${esc(tr.b.label || '')}</b> <span class="muted">· ${t(c.routes.length ? 'rrPickHint' : 'rrLoading')}</span></div>
    ${warn}${c.routes.length ? rrCardsHtml(c) : `<div class="rr-wait">${t('rrLoading')}</div>`}${c.state === 'load' && c.routes.length ? `<div class="muted rr-more">${t('rrMore')}</div>` : ''}
    <div class="rp-btns rr-btns"><button class="btn pri" data-rrc="go" ${sel ? '' : 'disabled'}>${ICON.go}<span>${t('rrGo')}</span></button><button class="btn" data-rrc="x"><span>${t('rrKeep')}</span><i class="rr-sec" id="rrcSec"${c.until ? '' : ' hidden'}>${c.until ? Math.max(0, Math.ceil((c.until - Date.now()) / 1000)) : ''}</i></button></div>`;
}
function rrFit() {
  const box = $('routePick'), c = g.choice; if (box.hidden || !c || !c.routes.length) return;
  const tp = $('top'), top = (tp.hidden ? 0 : tp.getBoundingClientRect().bottom) + 24, bottom = box.getBoundingClientRect().height + 34;
  fitRoutes(c.routes.map(x => x.r.coords), top, bottom, zoomPad(box));
}
function rrRender() {
  const c = g.choice, box = $('routePick');
  if (!c) { if (box.dataset.mode === 'rr') { clearInterval(rrTick); rrTick = 0; rrFitN = -1; box.hidden = true; delete box.dataset.mode; box.innerHTML = ''; mapM.pickRoutes(null); setFollow(true); } return; }
  if (tsOpen()) tsHide(false);
  if (currentPanel()) closePanel();
  quickOpen(false); showPick(null); $('pick').hidden = true;
  box.dataset.mode = 'rr'; box.innerHTML = rrHtml(); box.hidden = false;
  mapM.pickRoutes(c.routes.map(x => x.r.coords), c.sel);
  if (rrFitN !== c.routes.length) { rrFitN = c.routes.length; requestAnimationFrame(rrFit); }      // карту підганяємо, коли додались варіанти (не на кожен дотик)
  if (!rrTick) rrTick = setInterval(() => { const s = $('rrcSec'), k = g.choice; if (!k || !s) return; if (k.until) { s.hidden = false; s.textContent = Math.max(0, Math.ceil((k.until - Date.now()) / 1000)); } }, 250);
}
function rrClick(e) {
  const b = e.target.closest('button'); if (!b || !g.choice) return;
  if (b.dataset.rp === 'zin' || b.dataset.rp === 'zout') { zoomBy(b.dataset.rp === 'zin' ? 1 : -1); return; }
  if (b.dataset.rp === 'fit') { rrFit(); return; }
  if (b.dataset.rrv != null) { selectChoice(+b.dataset.rrv); return; }
  if (b.dataset.rrc === 'go') { if (confirmChoice()) toast(t('rrNewToast'), 'green', 5000); return; }
  if (b.dataset.rrc === 'x') cancelChoice('no');
}

/* ---------- позначки водіїв: ДТП, поліція, транспортна служба ---------- */
function repOpen(open) {
  const box = $('repSheet');
  if (open) {
    aimEnd();
    // (1.1.22) значок «Мітки» горить зеленим — отже, є позначки попереду: показуємо їх тут же, найближчі перші; дотик — показати на карті
    const near = repsAhead().slice(0, 4);
    // (1.1.24) один низький рядок: «Попереду» і плитки «значок + відстань»; хто й коли позначив — у підписі для читача екрана й на карті після дотику
    const nearHtml = near.length ? `<div class="rep-near"><span class="rep-sub">${t('repAheadShort')}</span><div class="rep-chips">${near.map(x => { const d = x.ahead < 150 ? t('plHere') : fmtDist(x.ahead); return `<button class="rep-row" data-repgo="${esc(x.r.id)}" aria-label="${esc(repName(x.r))} · ${esc(repAgo(x.r))} · ${esc(x.ahead < 150 ? d : t('plAhead', d))}"><span class="rep-ri">${REP_SVG[x.r.t]}</span><b>${esc(d)}</b></button>`; }).join('')}</div></div>` : '';
    // (1.1.24) Низька майже прозора смужка внизу: три кнопки в ряд і ✕. Під значком і підписом кожної кнопки — щільніша підкладка
    // (текст читається на будь-якій карті), сама смужка майже прозора й карту не закриває. Великого заголовка й довгого тексту немає.
    box.setAttribute('aria-label', t('repTitle'));
    box.innerHTML = `${nearHtml}<div class="rep-grid">${Object.keys(REP_TYPES).map(k => `<button data-rep="${k}"><span class="rep-ic">${REP_SVG[k]}</span><span>${t('rep_' + k)}</span></button>`).join('')}</div><button class="q-x" data-rep="x" aria-label="${t('close')}">${ICON.x}</button>`;
    box.hidden = false;
  } else box.hidden = true;
}
// «Мітки» в нижній стрічці: блідий кашкет — позначок попереду немає; зелений із числом — є, можна перевірити
let repTabT = 0;
function repTabSync() {
  repTabT = Date.now();
  const b = $('tabRep'); if (!b) return; const n = repsAhead().length;
  b.classList.toggle('has', n > 0);
  let bd = b.querySelector('.badge'); if (n && !bd) { bd = document.createElement('i'); bd.className = 'badge rep'; b.appendChild(bd); } else if (!n && bd) { bd.remove(); bd = null; }
  if (bd && bd.textContent !== String(n)) bd.textContent = String(n);
  b.setAttribute('aria-label', n ? t('repBtnHas', n) : t('repBtn'));
}
// «Калібрування телефона» — плитка у швидких налаштуваннях: зелена — відкалібровано (і не давніше ніж 90 днів)
function tabCalSync() { quickRender(); }
function repClick(e) {
  const go = e.target.closest('[data-repgo]');
  if (go) { const r = reps.list.find(x => String(x.id) === go.dataset.repgo); repOpen(false); if (r) flyTo({ lat: r.lat, lon: r.lon }, 15); return; }
  const b = e.target.closest('[data-rep]'); if (!b) return;
  const k = b.dataset.rep;
  if (k === 'x') { repOpen(false); return; }
  if (pos.lat == null) { toast(t('repNoPos'), 'yellow', 5000); return; }
  repOpen(false); aimStart(k);
}
// Приціл: позначку ставимо там, де водій бачив (уже проїхали — не чекаємо), а не лише під машиною.
// Дотик до карти — позначка в це місце; або «Сюди» — у перехрестя прицілу; або «Де я зараз».
let aim = null;
function aimStart(k) {
  aim = { k, timer: setTimeout(aimEnd, 60000) };
  const box = $('aim');
  box.innerHTML = `<div class="aim-cross" aria-hidden="true"></div><div class="aim-bar"><div class="aim-t"><span class="aim-ic">${REP_SVG[k]}</span><span></span></div>
    <div class="row"><button class="btn pri" data-aim="cross">${ICON.center}${t('aimCross')}</button><button class="btn" data-aim="here">${t('aimHere')}</button><button class="btn" data-aim="x" aria-label="${t('close')}">${ICON.x}</button></div></div>`;
  box.querySelector('.aim-t span:last-child').textContent = t('aimHint', t('rep_' + k));
  box.hidden = false; aimPlaceCross();
  mapM.setTapHook(p => aimPlace(p));
}
function aimPlaceCross() {
  const c = $('aim').querySelector('.aim-cross'), mc = document.getElementById('map').getBoundingClientRect();
  const tp = $('top'), bt = $('bottom'), bar = $('aim').querySelector('.aim-bar');
  const top = Math.max(bar.getBoundingClientRect().bottom, tp && !tp.hidden ? 0 : 0), bot = bt && !bt.hidden ? bt.getBoundingClientRect().top : mc.bottom;
  aim.x = Math.round(mc.left + mc.width / 2); aim.y = Math.round((top + bot) / 2);
  c.style.left = aim.x + 'px'; c.style.top = aim.y + 'px';
}
function aimEnd() { if (!aim) return; clearTimeout(aim.timer); aim = null; $('aim').hidden = true; mapM.setTapHook(null); }
function aimPlace(p) {
  if (!aim) return;
  const k = aim.k, res = report(k, p);
  if (res.err === 'far') { toast(t('aimFar'), 'yellow', 6000); return; }
  if (res.err === 'pos') { toast(t('repNoPos'), 'yellow', 5000); return; }
  aimEnd();
  if (res.err) { toast(t(res.err === 'often' ? 'repOften' : 'repMany'), 'yellow', 6000); return; }
  const id = res.r.id;
  toast(t('repDoneUndo', t('rep_' + k)), REP_TYPES[k].level === 'red' ? 'red' : 'green', 8000, () => { if (repUndo(id)) toast(t('repUndone'), '', 4000); });
  P.vibrate(60);
}
function aimClick(e) {
  const b = e.target.closest('[data-aim]'); if (!b || !aim) return;
  const k = b.dataset.aim;
  if (k === 'x') { aimEnd(); return; }
  if (k === 'here') { aimPlace(null); return; }
  const mc = document.getElementById('map').getBoundingClientRect();
  aimPlace(mapM.screenToGeo(aim.x - mc.left, aim.y - mc.top));
}

/* ---------- точки рейсу на карті (1.1.14: без прицілу) ----------
   Правила, зведені з двох побажань водія:
   • СТАРТ — «моє місце», доки не вказано інше. У старту завжди два способи: «З мого місця» або «Вказати на карті».
   • ФІНІШ — адресою або пальцем на карті. «Через» — за бажанням.
   • На карті точку ставить палець: затримали — картка «Їхати сюди · Старт тут · Через». Прицілу немає.
     «Їхати сюди» — фініш тут, а старт — місце телефона. Якщо старт уже вказано вручну, кнопка зветься «Фініш тут» (старт не чіпаємо).
   • Плашка з трьома точками лишається на карті: відстань по прямій і «Маршрут».
   • Пересунути точку: торкнутись її на плашці (вона «чекає дотику»), потім торкнутись карти. Поки жодна точка
     не чекає, дотики до карти нічого не пересувають — випадково рейс не зіпсуєш. */
const PT_NAME = { a: 'ptStart', v: 'ptVia', b: 'ptFinish' };
let pm = null;                                   // { arm: 'a'|'v'|'b'|null — яка точка чекає дотику до карти, form: відкрили з «Рейсу» }
const startIsMe = () => !plan.a || !!plan.a.me;  // старт — моє місце (живий GPS), а не вказана точка
// «Їхати сюди» — завжди від мого місця. Якщо старт уже вказано на карті чи адресою, кнопка чесно зветься «Фініш тут»: старт лишається.
// Порядок (1.1.22, як попросив Олексій): Старт · Через · Їхати сюди — так, як рейс і складається. short — у меню точки на карті:
// там усе в один ряд значками, тож підписи найкоротші («Старт», «Через», «Їхати»), а повна назва — для озвучення.
const ptBtnsHtml = (short = false) => { const go = startIsMe() ? 'ptGoHere' : 'ptFinishHere', lb = k => `<span>${t(short ? k + 'S' : k)}</span>`, al = k => short ? ` aria-label="${t(k)}"` : '';
  return `<button class="btn pt-b" data-k="a"${al('ptStartHere')}>${ptTag('a', 'rp-t')}${lb('ptStartHere')}</button><button class="btn pt-b" data-k="v"${al('ptViaHere')}>${ptTag('v', 'rp-t')}${short ? lb('ptViaHere') : `<span>${t('ptVia')}</span>`}</button>
  <button class="btn pri pt-b pt-go" data-k="b"${al(go)}>${ptTag('b', 'rp-t')}${lb(go)}</button>`; };
const ptsMe = () => startIsMe() && pos.lat != null ? { lat: pos.lat, lon: pos.lon } : null;
function ptsDist() {
  const pts = [startIsMe() ? ptsMe() : plan.a, plan.v, plan.b].filter(Boolean); if (pts.length < 2) return null;
  const legs = []; for (let i = 1; i < pts.length; i++) legs.push(hav(pts[i - 1], pts[i]));
  return { legs, total: legs.reduce((a, b) => a + b, 0), fromMe: startIsMe() };
}
function ptsOpen(arm, form) {
  if (g.active) return;
  closePanel(); $('pick').hidden = true; showPick(null); quickOpen(false); if (aim) aimEnd();
  if (plan.trip) { plan.trip = null; plan.routes = []; plan.sel = 0; pickHide(); previewRoute(null); }
  pm = { arm: arm || null, form: !!form || !!(pm && pm.form) };
  $('pts').hidden = false; document.body.classList.add('pts-on'); ptsRender(); setFollow(false);
}
function ptsRender() {
  if (!pm) return;
  const box = $('pts'), d = ptsDist(), me = ptsMe(), arm = pm.arm, isMe = startIsMe();
  const chip = k => { const p = k === 'a' && isMe ? null : plan[k], txt = p ? p.label : k === 'a' ? t(me ? 'myPlace' : 'ptNoGps') : t(k === 'v' ? 'ptViaNo' : 'ptNotSet');
    return `<button class="pt-chip${arm === k ? ' on' : ''}${p || (k === 'a' && me) ? ' set' : ''}" data-pt="${k}" aria-label="${t(PT_NAME[k])}" aria-pressed="${arm === k}">${ptTag(k, 'rp-t')}<span><small>${t(PT_NAME[k])}</small><b>${esc(txt)}</b></span></button>`; };
  const sum = d ? (d.legs.length > 1 ? d.legs.map(x => fmtDist(x)).join(' + ') + ' = ' : '') + `<b>${fmtDist(d.total)}</b> ${t('ptStraight')}` + (d.fromMe ? ' · ' + t('ptFromMe') : '') : t('ptIdleHint');
  const any = !isMe || plan.v || plan.b;
  // що зробить наступний дотик до карти — і (для старту) другий спосіб: «з мого місця»
  const armLine = arm ? `<div class="pt-arm ${arm}" id="ptArm">${ICON.pin}<span>${t('ptArmHint', t(PT_NAME[arm]).toLowerCase())}</span></div>` : '';
  // та сама пара, що й у формі «Рейс»: «З мого місця» (зелена, коли вибрано) — або дотик до карти
  const ctx = arm === 'a' ? `<button class="btn pt-ctx${isMe ? ' on' : ''}" data-pt="me" aria-pressed="${isMe}">${ICON.here}<span>${t('ptFromMeBtn')}</span></button>`
    : arm === 'v' && plan.v ? `<button class="btn pt-ctx" data-pt="del">${ICON.x}<span>${t('ptViaDel')}</span></button>` : '';
  box.innerHTML = `<div class="aim-bar pt-bar">
    <div class="pt-chips">${chip('a')}${chip('v')}${chip('b')}</div>
    <div class="pt-mid"><div class="pt-sum" id="ptSum">${sum}</div>
      ${any ? `<button class="pt-ic" data-pt="reset" aria-label="${t('ptReset')}">${ICON.trash}</button>` : ''}<button class="pt-ic" data-pt="x" aria-label="${t('close')}">${ICON.x}</button></div>
    ${armLine}
    <div class="row">${ctx}<button class="btn dark" data-pt="route" ${plan.b ? '' : 'disabled'}>${ICON.route}${t('ptRoute')}</button></div></div>`;
  mapM.planPoints({ a: isMe ? null : plan.a, v: plan.v, b: plan.b, me });
  mapM.setTapHook(arm ? p => ptsPlace(p) : null);            // дотик до карти ставить точку лише тоді, коли вона цього чекає
  requestAnimationFrame(layoutVars);
}
function ptsPut(k, p) {
  const pt = { lat: p.lat, lon: p.lon, label: p.label || p.lat.toFixed(5) + ', ' + p.lon.toFixed(5) };
  plan[k] = pt; plan.trip = null; plan.routes = [];
  if (!p.label) reverse(p.lat, p.lon).then(r => { if (r && plan[k] === pt) { pt.label = [r.name, r.city !== r.name ? r.city : ''].filter(Boolean).join(', ') || pt.label; const i = $('in_' + k); if (i) i.value = pt.label; ptsRender(); } }).catch(() => {});
  return pt;
}
// після старту логічно одразу вказати фініш; без GPS після фінішу — старт. В інших випадках ніщо не чекає дотику.
const ptsNextArm = k => k === 'a' && !plan.b ? 'b' : k === 'b' && startIsMe() && pos.lat == null ? 'a' : null;
function ptsPlace(p) {
  if (!pm || !pm.arm || !p) return;
  const k = pm.arm; ptsPut(k, p); P.vibrate(40);
  pm.arm = ptsNextArm(k); ptsRender();
}
/** Точку вибрано з картки на карті (довге натискання, піт-стоп, позначка): ставимо й лишаємось на карті з плашкою точок. */
function ptsSet(k, p) { ptsPut(k, p); ptsOpen(ptsNextArm(k)); }
function ptsEnd(back) {
  if (!pm) return;
  const form = pm.form; pm = null; $('pts').hidden = true; $('pts').innerHTML = ''; document.body.classList.remove('pts-on'); mapM.setTapHook(null); mapM.planPoints(null);
  if (back && form) openPanel('trip');                       // прийшли з «Рейсу» — туди й повертаємось
}
function ptsClick(e) {
  const b = e.target.closest('[data-pt]'); if (!b || !pm) return;
  const k = b.dataset.pt;
  if (k === 'x') { ptsEnd(true); return; }
  if (k === 'a' || k === 'v' || k === 'b') { pm.arm = pm.arm === k ? null : k; ptsRender(); return; }
  if (k === 'me') { plan.a = null; pm.arm = ptsNextArm('a'); ptsRender(); return; }
  if (k === 'del') { plan.v = null; pm.arm = null; ptsRender(); return; }
  if (k === 'reset') { plan.a = plan.v = plan.b = null; pm.arm = null; ptsRender(); return; }
  if (k === 'route') { if (!plan.b) return; ptsEnd(false); openPanel('trip'); doBuild(); }
}
export const ptsState = () => pm ? { arm: pm.arm, form: pm.form, me: startIsMe(), dist: ptsDist() } : null;
// Проїжджаємо чужу позначку — «Поліція ще тут?» над самою позначкою
let askRep = null;
function onRepAsk(r) {
  askRep = r; P.vibrate(40);
  mapM.askShow(r, { q: t('repAskQ', repName(r)), yes: t('repAskYes'), no: t('repAskNo'),
    fn: yes => { askRep = null; if (repVote(r.id, yes)) toast(t(yes ? 'repAskThxYes' : 'repAskThxNo'), 'green', 5000); } });
}

/* ---------- «Маршрут» у дорозі: увесь залишок маршруту на карті; контрольна точка, залишитись, завершити ---------- */
const ts = { via: false, q: '', sugg: [], timer: 0 };
const tsOpen = () => $('routePick').dataset.mode === 'trip' && !$('routePick').hidden;
const tsKvHtml = () => `<div class="ts-kv"><div><b>${fmtDist(g.remain)}</b><small>${t('remainL')}</small></div><div><b>${fmtDur(g.remTime)}</b><small>${t('driveTime')}</small></div><div><b>${g.arrived ? '—' : fmtClock(new Date(g.eta))}</b><small>${t('arrival')}</small></div></div>`;
function tsHtml() {
  const tr = g.trip;
  const pin = (k, p) => p ? `${ptTag(k, 'rp-t')}<b>${esc(p.label || '')}</b>` : '';
  const via = ts.via ? `<div class="ts-via"><input id="tsViaIn" placeholder="${esc(t('tsViaPh'))}" value="${esc(ts.q)}" autocomplete="off" enterkeyhint="search">
      <div class="ts-sugg">${ts.sugg.map((x, i) => `<button data-tsg="${i}"><b>${esc(x.label)}</b><small>${esc(x.sub || '')}</small></button>`).join('')}</div></div>` : '';
  return `${ts.via ? '' : `<div class="rp-zoom">${rpMarksBtn()}<button data-rp="zin" aria-label="${t('qZoomIn')}">+</button><button data-rp="zout" aria-label="${t('qZoomOut')}">−</button><button data-rp="fit" aria-label="${t('rpFit')}">${ICON.route}</button></div>`}
    <div class="rp-head">${pin('a', tr.a)}${pin('v', tr.v)}${pin('b', tr.b)}<button class="ts-more" data-ts="details">${t('details')}</button></div>
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
  if (cs.length >= 2) fitRoutes([cs], top, bottom, zoomPad(box));
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
  if (k === 'marks') { rpMarksToggle(b); return; }
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
  if ($('routePick').dataset.mode === 'rr') { rrClick(e); return; }
  { const v = e.target.closest('.vehm [data-veh]'); if (v) { pickKind(v.dataset.veh, v.dataset.mode); return; } }
  const c = e.target.closest('[data-alt]'); if (c) { selectAlt(+c.dataset.alt); return; }
  const b = e.target.closest('[data-rp]'); if (!b || !plan.trip) return;
  const k = b.dataset.rp;
  if (k === 'marks') { rpMarksToggle(b); return; }
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
    : r.truckFail ? `<div class="card" style="margin-top:8px;border:2px solid var(--red)"><div style="font-weight:700;color:var(--red)">${t('truckFailTitle')}</div><div class="muted" style="margin-top:4px">${t('truckFailText')}</div></div>`
    : r.costing === 'auto' ? (S.vehicle === 'auto' ? '' : `<div class="card softcard"><b>${t('freeTitle')}.</b> ${t('freeText')}</div>`)
    : softWarnHtml(r, 'card softcard') || (r.snapped ? `<div class="muted" style="margin-top:8px">${t('truckSnapped')}</div>` : '');
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
    const inp = $('in_' + k), txt = inp ? inp.value.trim() : k === 'a' && startIsMe() ? '' : plan[k] ? plan[k].label : '';
    if (txt && (!plan[k] || plan[k].label !== txt)) {
      const r = await findPlaces(txt);
      if (r[0]) plan[k] = r[0]; else { plan.err = P.online() ? t('notFound', txt) : t('netErr'); plan.saveAfter = false; refresh('trip'); return; }
    } else if (!txt) plan[k] = null;
  }
  if (startIsMe()) plan.a = pos.lat != null ? { lat: pos.lat, lon: pos.lon, label: t('myPlace'), me: true } : null;   // «моє місце» — щоразу свіже
  if (!plan.a || !plan.b) { plan.err = t('needAB'); plan.saveAfter = false; refresh('trip'); return; }
  plan.busy = true; plan.trip = null; plan.off = null; refresh('trip');
  try {
    const trip = newTrip(plan.a, plan.v, plan.b);
    trip.costing = vehKind() === 'strict' ? 'truck' : 'auto';
    if (vehKind() === 'free') trip.free = true;                    // фура дорогами загального користування — на розсуд водія
    const r = await buildRoute(trip, { alternates: 1 });
    plan.routes = [r, ...(r.alts || [])].slice(0, 2); plan.sel = 0;          // два варіанти, як у BlindDriver
    for (const x of plan.routes) delete x.alts;
    trip.route = r;
    plan.trip = trip; mapM.previewPoints(trip); previewRoute(trip.route.coords, trip.route); previewAlts(plan.routes.slice(1).map((x, k) => [k + 1, x.coords])); hud();
    loadRegions(trip);
    plan.busy = false;
    if (plan.saveAfter) { plan.saveAfter = false; saveCurrentTrip(); return; }       // «Зберегти рейс» без прокладеного рейсу: проклали — і одразу в архів
    closePanel(); pickShow();
    softOffer(trip, r); return;
  } catch (e) {
    // помилки сервера — людською мовою, а не «No path could be found for input»
    plan.err = e.code ? t('routeFail') + ' ' + (e.code === 171 ? t('noEdge') : [170, 442].includes(e.code) ? t('noPath') : (e.message || '')) : t('netErr') + ' ' + (e.message || '');
    log('warn', 'маршрут: ' + e.message);
  }
  plan.busy = false; plan.saveAfter = false; refresh('trip');
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
  const tp = e.target.closest('.tp-row[data-vpid]');
  if (tp) { vpCur = byIdVp(tp.dataset.vpid); if (vpCur) openPanel('place'); return; }
  const sh = e.target.closest('[data-shlat]');
  if (sh) { closePanel(); flyTo({ lat: +sh.dataset.shlat, lon: +sh.dataset.shlon }, 15); return; }
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.act === 'build') doBuild();
  else if (d.veh) {
    S.vehicle = d.veh; if (d.mode) S.routeMode = d.mode;
    const k = vehKind(); e.currentTarget.querySelectorAll('[data-veh]').forEach(x => { x.classList.toggle('on', x.dataset.kind === k); x.setAttribute('aria-pressed', String(x.dataset.kind === k)); });
    const h = $('vehHint'); if (h) { h.className = 'veh-hint ' + k; h.innerHTML = vehHintHtml(k); }
    if (plan.trip) doBuild();
  }
  else if (d.alt != null) selectAlt(+d.alt);
  else if (d.act === 'rerouteFresh') { rerouteNow(true); closePanel(); }
  else if (d.act === 'go' && plan.trip) goTrip(plan.trip);
  else if (d.act === 'useAlt' && plan.trip && plan.trip.route.alt) {
    const tr = plan.trip, alt = tr.route.alt;
    alt.aD = null; alt.viaD = tr.route.viaD; alt.detour = 1; tr.costing = 'auto'; tr.free = true; tr.route = alt; tr.regions = []; tr.towns = [];
    previewRoute(alt.coords, alt); hud(); refresh('trip'); loadRegions(tr);
  }
  else if (d.act === 'save' && plan.trip) saveCurrentTrip();
  else if (d.act === 'saveTrip') saveTripTap();
  else if (d.act === 'archive') openPanel('archive');
  else if (d.act === 'reroute') { rerouteNow(); closePanel(); }
  else if (d.act === 'offline' && g.route) runOffline(g.route);
  else if (d.act === 'stop') endTrip(true);
  else if (d.act === 'back') closePanel();

  else if (d.here) {
    // «З мого місця»: старт — там, де телефон у мить побудови рейсу (не знімок координат, зроблений зараз)
    plan.a = null; const i = $('in_a'); if (i) i.value = ''; showSugg('a', []); startTwoSync();
    if (pos.lat == null) toast(t('ptNoGpsHint'), 'yellow', 6000);
  }
  else if (d.onmap) ptsOpen(d.onmap, true);
  else if (d.clear) { plan[d.clear] = null; const i = $('in_' + d.clear); if (i) { i.value = ''; i.focus(); } showSugg(d.clear, []); if (d.clear === 'a') startTwoSync(); }
  else if (d.sg) { clearTimeout(geoTimer); const [k, i] = d.sg.split(':'); const s = plan.sugg[+i]; if (s) { plan[k] = s; $('in_' + k).value = s.label; showSugg(k, []); showPick(s); places.remember(s); if (k === 'a') startTwoSync(); } }
}
function tripInput(e) {
  const k = e.target.dataset && e.target.dataset.f; if (!k) return;
  if (k === 'b') requestAnimationFrame(tripToolsSync);
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
    // Маршрут побудовано, але ще не рушили — панель нижча: лінію маршруту видно на карті над нею (тут карта потрібна).
    // У решті випадків «Рейс», як і всі панелі, — на весь екран (ui_base.js).
    { const half = !active && !!plan.trip, P = $('panel'); P.classList.toggle('half', half); P.classList.toggle('full', !half); }
    // (1.1.22) деталі рейсу в дорозі — на ВЕСЬ екран: верхня плашка з маневром і нижня (час, кілометри, вкладки) належать карті й тут заважали
  },
  update(body) {
    const active = g.trip && (g.active || g.arrived);
    { const half = !active && !!plan.trip, P = $('panel'); P.classList.toggle('half', half); P.classList.toggle('full', !half); }
    if (active) { body.innerHTML = tripActiveHtml(); return; }
    // форму не перемальовуємо, щоб не збивати введення
    const sum = $('planSum'), er = $('planErr'), bb = body.querySelector('[data-act="build"]'), ns = $('newSec');
    if (!sum) { body.innerHTML = planHtml(); return; }
    sum.innerHTML = plan.trip ? planSumHtml() : ''; er.textContent = plan.err; tripToolsSync(); if (ns) ns.hidden = !plan.trip;
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
/* Місця: квадратики «що шукаю» — АЗС, їжа, стоянки, мотелі, душ, перевірені. Ті самі галочки, що й «Що показувати на карті»:
   поставив — бачиш на карті й списком найближчих попереду по рейсу (або поруч, якщо рейсу немає); зняв — зникло. */
const PL = [['fuel', 'f', 'plFuel'], ['food', 'e', 'plFood'], ['park', 'p', 'plPark'], ['motel', 'm', 'plMotel'], ['shower', 'h', 'plShower'], ['@mapVerified', '', 'plVerified']];
// «ще на карті» (1.1.20): те, що раніше вмикалось лише у віконці «Шари», — камери, позначки водіїв, події, проблемні місця, заміри покриття.
// Списку нижче вони не дають — це позначки на карті. Третє поле — короткий напис на плитці, четверте — повна назва (для озвучення).
const PL_MAP = [['cam', 'c', 'plCam', 'lyCam'], ['@mapReports', '', 'plReports', 'lyReports'], ['@mapEvents', '', 'plEvents', 'lyEvents'], ['@mapHazards', '', 'plHazards', 'lyHazards'], ['@roughMap', '', 'plRough', 'lyRough']];
const PL_ROW = { fuel: r => r[2] === 'f', food: r => r[2] === 'e', park: r => r[2] === 'p' || r[2] === 's', motel: r => r[2] === 'm', shower: r => r[2] === 'h' || !!(r[3] & F.SHOWER) };
let plCache = { idx: null, n: 0, list: [] };
function plNearest(keys) {
  if (!keys.length || !sdb.ready) return [];
  const want = r => keys.some(k => PL_ROW[k](r));
  if (g.active && g.idx && pos.rd != null && pos.onRoute) {
    if (plCache.idx !== g.idx || plCache.n !== sdb.count) plCache = { idx: g.idx, n: sdb.count, list: alongRoute(g.idx, ['f', 'e', 'p', 's', 'm', 'h'], 1500) };
    return plCache.list.filter(x => x.d > pos.rd - 150 && want(x.r)).slice(0, 15).map(x => ({ i: x.i, r: x.r, ahead: x.d - pos.rd, off: x.off }));
  }
  if (pos.lat == null) return [];
  const out = [], R = 50000;
  for (let i = 0; i < sdb.rows.length; i++) {
    const r = sdb.rows[i]; if (r[2] === 'c' || Math.abs(r[0] - pos.lat) * 111320 > R || !want(r)) continue;
    const d = hav(pos, { lat: r[0], lon: r[1] }); if (d < R) out.push({ i, r, dist: d });
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, 15);
}
/* Мінізображення замість кольорових кружечків (1.1.22, прохання Олексія): на значку — те, що він означає (колонка, вилка
   з ножем, «P», ліжко, душ…), а колір значка — той самий, що в точки цього виду на карті. Ті самі значки — у списку нижче. */
const picSvg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const PIC_D = {
  f: '<path d="M5.5 20V5.6A1.6 1.6 0 0 1 7.1 4h4.8a1.6 1.6 0 0 1 1.6 1.6V20"/><path d="M4 20h11"/><path d="M7.6 7.4h3.8v3.2H7.6z" fill="#fff" stroke="none"/><path d="M13.5 11.2h1.3a1.5 1.5 0 0 1 1.5 1.5v3.8a1.5 1.5 0 0 0 3 0V8.6L17 6.2"/>',
  e: '<path d="M6 3v5.8a2.5 2.5 0 0 0 5 0V3"/><path d="M8.5 3v18"/><path d="M17.2 21v-8.6h-2c-.9 0-1.4-.6-1.3-1.5.3-3.2 1.3-5.7 3.3-7.9z"/>',
  p: '<path d="M8.2 20.2V4h4.9a4.6 4.6 0 0 1 0 9.2H8.2" stroke-width="2.8"/>',
  m: '<path d="M3 6.5V19"/><path d="M3 15.4h18"/><path d="M21 19v-5.6a3 3 0 0 0-3-3h-6.8v4.9"/><circle cx="7.1" cy="11.6" r="1.7" fill="#fff" stroke="none"/>',
  h: '<path d="M5 21V8a4 4 0 0 1 4-4h1a4 4 0 0 1 4 4"/><path d="M10.2 8.3h7.6"/><path d="M12 12.2v.01M15 12.2v.01M18 12.2v.01M12.6 15.4v.01M15.6 15.4v.01M18.6 15.4v.01M13.2 18.6v.01M16.2 18.6v.01M19.2 18.6v.01" stroke-width="2.4"/>',
  bell: '<path d="M6.4 9.6a5.6 5.6 0 1 1 11.2 0c0 5.4 2.2 6.4 2.2 6.4H4.2s2.2-1 2.2-6.4z"/><path d="M10.2 19.4a2 2 0 0 0 3.6 0"/>',
  road: '<path d="M2.5 14.5c1.7-4.4 3.4-4.4 5.1 0s3.4 4.4 5.1 0 3.4-4.4 5.1 0 2.3 3.2 3.7 1.2"/>'
};
/** Значок виду місця: ty — літера виду зупинки (f, e, p, s, m, h) або ключ шару (cam, @mapVerified, @mapReports…). sh — у точки є душ. */
function plPic(ty, sh) {
  if (ty === 'cam' || ty === 'c') return `<span class="pl-ic cam">${CAM_SVG}</span>`;
  if (ty === '@mapVerified') return '<span class="pl-ic vp">★</span>';
  if (ty === '@mapReports') return `<span class="pl-ic rep">${REP_SVG.police}</span>`;
  if (ty === '@mapEvents') return `<span class="pl-ic pic" style="background:var(--red)">${picSvg(PIC_D.bell)}</span>`;
  if (ty === '@mapHazards') return '<span class="pl-ic hz">20</span>';
  if (ty === '@roughMap') return `<span class="pl-ic pic" style="background:linear-gradient(90deg,#2f9e62 34%,#e0a800 34% 67%,#e5484d 67%)">${picSvg(PIC_D.road)}</span>`;
  const k = ty === 's' ? 'p' : ty;
  return `<span class="pl-ic pic${sh && k !== 'h' ? ' sh' : ''}" style="background:${TYPES[ty] ? TYPES[ty].color : '#1f2937'}">${picSvg(PIC_D[k] || PIC_D.p)}</span>`;
}
function plChipsHtml() {
  const chip = ([k, ty, lbl, full]) => { const on = layerOn(k); return `<button class="pl-chip${on ? ' on' : ''}" data-plc="${k}" role="checkbox" aria-checked="${on}"${full ? ` aria-label="${esc(t(full))}"` : ''}>${plPic(k[0] === '@' || k === 'cam' ? k : ty)}<span>${t(lbl)}</span>${on ? `<i class="pl-ck">${ICON.check}</i>` : ''}</button>`; };
  return `<div class="pl-chips">${[...PL, ...PL_MAP].map(chip).join('')}</div>`;
}
const plAllHtml = () => { const any = LAYERS.some(([k]) => layerOn(k)), all = LAYERS.every(([k]) => layerOn(k));
  return `<div class="pl-all"><button class="btn sm" data-plc="#all"${all ? ' disabled' : ''}>${t('plAll')}</button><button class="btn sm" data-plc="#none"${any ? '' : ' disabled'}>${t('plNone')}</button></div>`; };
function plRowHtml(x) {
  const [, , ty, f, name, , info] = x.r, fa = (info && info.fa) || [];
  const kind = stopKindLabel(ty, info), title = ty === 'f' ? brandOf(name) : (name || kind);
  const feats = [f & F.SHOWER && t('f_shower'), f & F.FOOD && ty !== 'e' && t('f_food'), (f & F.WC || fa.includes('wc')) && t('f_wc'), f & F.H24 && '24/7'].filter(Boolean);       // «для фур» не пишемо: перевірити не можемо (1.1.22)
  const where = x.ahead != null ? (x.ahead < 150 ? t('plHere') : t('plAhead', fmtDist(x.ahead))) : fmtDist(x.dist);
  const side = x.ahead != null && x.off > 300 ? `<small>${esc(t('plOff', fmtDist(x.off)))}</small>` : '';
  return `<button class="pl-row" data-sti="${x.i}">${plPic(ty, !!(f & F.SHOWER))}
    <span class="grow"><b>${esc(title)}</b><small>${esc([title !== kind ? kind : '', ...feats].filter(Boolean).join(' · '))}</small></span><span class="pl-d"><b>${esc(where)}</b>${side}</span></button>`;
}
function vpListHtml() {
  if (!vp.ready) return `<div class="muted">${t('loading')}</div>`;
  const trip = g.active && g.idx && pos.rd != null, items = vpListed(), list = items.map(x => x.p), W = new Map(items.map(x => [x.p.id, x.w]));
  const where = p => { const w = W.get(p.id); if (!w) return vpWhereText(p);
    if (w.route) return w.ahead < 1000 ? t(w.off > 1500 ? 'vpHereOff' : 'vpHere', fmtDist(w.off)) : t(w.off > 1500 ? 'vpAheadOff' : 'vpOnRoute', fmtDist(w.ahead), fmtDist(w.off));
    return t('vpAway', fmtDist(w.dist)); };
  const head = `<div class="vp-scope">${t('plVerified')} · ${t(trip ? 'vpScopeRoute' : pos.lat != null ? 'vpScopeNear' : 'vpScopeAll')}</div>`;
  if (!list.length) return head + `<div class="card vp-empty">${t(trip ? 'vpNoneRoute' : 'vpNoneNear')}</div>`;
  return head + `<div class="list">` + list.map(p => `<button class="vp-row" data-vpid="${esc(p.id)}">
      <img src="data/${esc((p.thumbs || p.photos || [])[0] || '')}" alt="" loading="lazy"><span class="grow"><b>${esc(p.name)}</b><span class="vp-stars">${stars(p.rating)}</span>
      <small>${esc([t('vpKind_' + (p.kind || 'food')), p.road, vpTxt(p.town)].filter(Boolean).join(' · '))}</small><small class="vp-w">${esc(where(p))}</small></span></button>`).join('') + `</div>`;
}
function placesHtml() {
  const keys = PL.filter(([k]) => k[0] !== '@' && layerOn(k)).map(([k]) => k), trip = g.active && g.idx && pos.rd != null && pos.onRoute;
  let h = plAllHtml();
  if (keys.length) {
    const list = plNearest(keys);
    h += `<div class="vp-scope">${t(trip ? 'plScopeRoute' : 'plScopeNear')}</div>`;
    h += !sdb.ready ? `<div class="muted">${t('loading')}</div>` : list.length ? `<div class="list pl-list">${list.map(plRowHtml).join('')}</div>` : `<div class="card vp-empty">${t(trip ? 'plNoneRoute' : 'plNoneNear')}</div>`;
  }
  if (layerOn('@mapVerified')) h += vpListHtml();
  if (!keys.length && !layerOn('@mapVerified')) h += `<div class="card vp-empty">${t('plPick')}</div>`;
  // «Готово» — спільна для всіх панелей галочка праворуч унизу (1.1.24; у «Місцях» вона з'явилась першою, у 1.1.22)
  return plChipsHtml() + h + `<div class="muted pl-how">${t('vpHowAdd')}</div>`;
}
function plClick(k) {
  if (k === '#all' || k === '#none') setAllLayers(k === '#all');
  else setLayer(k, !layerOn(k));
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
    ${p.services && p.services.length ? `<div class="sec">${t('vpServices')}</div><div class="vp-menu vp-serv">${p.services.map(([n, pr]) => `<div><span>${esc(vpTxt(n))}</span><b>${esc(pr)}</b></div>`).join('')}</div>` : ''}
    ${p.menu && p.menu.length ? `<div class="sec">${t(p.services && p.services.length ? 'vpMenuCafe' : 'vpMenu')}</div><div class="vp-menu">${p.menu.map(([n, pr]) => `<div><span>${esc(n)}</span><b>${esc(pr)}</b></div>`).join('')}</div><div class="muted" style="margin-top:6px">${esc(vpTxt(p.note))}</div>` : ''}
    <div class="btns">${vpOnMap(p) ? `<button class="btn pri" data-vp="go">${g.active ? t('vpVia') : t('vpRoute')}</button><button class="btn" data-vp="map">${t('vpOnMap')}</button>` : ''}</div>
    ${!vpOnMap(p) || p.own ? `<div class="btns"><button class="btn" data-vp="setloc">${t('vpSetLoc')}</button></div>` : ''}`;
}
function plDraw(body) { body.innerHTML = placesHtml(); panelDodge(); panelDodgeSoon(); }
definePanel('places', {
  title: () => t('tabPlaces'),
  render(body) {
    plDraw(body);
    body.onclick = e => {
      const c = e.target.closest('[data-plc]');
      if (c) { plClick(c.dataset.plc); const st = body.scrollTop; plDraw(body); body.scrollTop = st; panelDodge(); return; }
      const r = e.target.closest('[data-sti]');
      if (r) { const i = +r.dataset.sti, row = sdb.rows[i]; if (!row) return; closePanel(); flyTo({ lat: row[0], lon: row[1] }, 15); onStopTap({ i, lat: row[0], lon: row[1] }); return; }
      const b = e.target.closest('[data-vpid]'); if (!b) return; vpCur = byIdVp(b.dataset.vpid); if (vpCur) openPanel('place');
    };
  },
  update(body) { plDraw(body); }
});
definePanel('place', {
  title: () => vpCur ? vpCur.name : '', back: 'places', tab: 'places',
  render(body) {
    if (!vpCur) return;
    body.innerHTML = placeHtml(vpCur);
    body.onclick = e => {
      const im = e.target.closest('[data-ph]');
      if (im) {      // фото на весь екран: гортаємо пальцем; (1.1.24) двома пальцями — збільшити, одним — зсунути, подвійний дотик — збільшити / повернути
        const pv = $('photoView'), n = (vpCur.photos || []).length;
        pv.innerHTML = `<button class="pv-x" data-pv="x" aria-label="${t('close')}">${ICON.x}</button><div class="pv-strip">${(vpCur.photos || []).map(src => `<div class="pv-slide"><img src="data/${esc(src)}" alt="" draggable="false"></div>`).join('')}</div><div class="pv-hint">${t('pvHint')}${n > 1 ? ' · ' + t('pvSwipe') : ''}</div>`;
        pv.classList.remove('zoomed'); pv.hidden = false; const st = pv.querySelector('.pv-strip'); st.scrollLeft = st.clientWidth * +im.dataset.ph; bindPhotoZoom(pv); return; }
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
  // (1.1.22) Меню точки — один ряд значків: Старт · Через · Їхати сюди · Я тут · ✕. Тло майже прозоре — карту під ним видно.
  // «Я бачив тут душ» звідси прибрано (душ позначають на картці місця: АЗС, стоянка).
  const box = $('pick'); box.hidden = false; box.className = 'pick-pt';
  box.innerHTML = `<div class="pk-cap">${t('pickTitle')} ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div><div class="row pk-row">
    ${g.active ? '' : ptBtnsHtml(true)}<button class="btn pt-b pt-me" data-k="here" aria-label="${t('iAmHereFull')}">${ptTag('me', 'rp-t')}<span>${t('iAmHere')}</span></button><button class="btn pk-x" data-k="x" aria-label="${t('clear')}">${ICON.x}</button></div>`;
  box.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    box.hidden = true;
    const k = b.dataset.k; if (k === 'x') { showPick(null); return; }
    if (k === 'here') { showPick(null); setManual(p); setFollow(true); toast(t('hereSet'), 'green', 6000); return; }
    showPick(null); ptsSet(k, { lat: p.lat, lon: p.lon });
  };
}

/* картка власної позначки «тут є душ» */
function onMarkTap(id) {
  const m = showers.myShowers().find(x => x.id === id); if (!m) return;
  const p = { lat: m.lat, lon: m.lon, label: m.name || t('showerMineTitle') };
  const dist = pos.lat != null ? ' · ' + fmtDist(hav(pos, m)) + ' ' + t('fromYou') : '';
  const box = $('pick'); box.hidden = false; box.className = ''; showPick(null);
  const btns = g.active ? `<button class="btn pri" data-k="via">${t('stopVia')}</button>`
    : ptBtnsHtml();
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
    ptsSet(k, p);
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
  const feats = [f & F.SHOWER && t('f_shower'), f & F.FOOD && t('f_food'), (f & F.WC || fa.includes('wc')) && t('f_wc'), f & F.H24 && '24/7'].filter(Boolean);
  const dist = pos.lat != null ? ' · ' + fmtDist(hav(pos, { lat, lon })) + ' ' + t('fromYou') : '';
  const kindL = stopKindLabel(ty, info);
  const title = ty === 'c' ? t('camera') + (extra ? ' · ' + extra + ' ' + t('kmh') : '') : (name || kindL);
  const p = { lat, lon, label: name || kindL };
  const inf = stopInfoHtml(x.i, r);
  const box = $('pick'); box.hidden = false; box.className = ''; showPick(null);
  const btns = ty === 'c' ? '' : g.active
    ? `<button class="btn pri" data-k="via">${t('stopVia')}</button>`
    : ptBtnsHtml();
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
    ptsSet(k, p);
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
  return `<div class="ev ${i.level || ''}${r && !r.show ? ' dim' : ''}"><div class="meta">${whyHtml(i, r)}<span>${esc(src)}</span><span>${ago(i.time)}</span>${i.ai ? '<span>Claude</span>' : ''}</div>
    ${i.sum ? `<div class="sum">${esc(i.sum)}</div>` : ''}<div class="txt cl" data-exp="1">${esc(i.text)}</div></div>`;      // (1.1.24) рядка оцінки «Потрібно / Не потрібно / Не вирішив» більше немає
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
  `;
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
  let plT = 0; bus.on('stopsdb', () => refresh('places')); bus.on('pos', () => { const n = Date.now(); if (n - plT > 10000) { plT = n; refresh('places'); } });
  bus.on('vpTap', id => { vpCur = byIdVp(id); if (vpCur) openPanel('place'); });
  bus.on('trips', () => { refresh('trip'); refresh('archive'); });
  let addrMissT = 0;
  bus.on('addrMiss', () => { const z = mapM.map ? mapM.map.getZoom() : 0, now = Date.now(); if (!offlineActive() || z < mapM.HOUSE_Z || now - addrMissT < 600000) return; addrMissT = now; toast(t(!addrAutoOn() ? 'addrMissOff' : addrWaitsWifi() ? 'addrMissWifi' : 'addrMissToast'), 'yellow', 9000); });
  // уся Україна вперше лягла в телефон сама — кажемо один раз (щомісячні оновлення — мовчки)
  bus.on('addrAuto', o => { if (o && o.first) toast(t('addrAutoDone'), 'green', 7000); });
  bus.on('hazards', () => refresh('trip'));
  bus.on('view', railState);
  bus.on('settings', k => { railState(); if (k === 'glass') applyGlass(); if (k === 'lang') { staticLabels(); hud(); stripUpdate(); } if (k === 'lookahead') stripUpdate(); });
  bus.on('toast', x => { const s = $('strip'); s.classList.remove('pulse'); void s.offsetWidth; s.classList.add('pulse'); if (S.popups) toast(x.text.replace(/\s+/g, ' ').slice(0, 180), x.level, 9000, () => openPanel('feed')); });
  bus.on('mapPick', p => { if (pm && pm.arm) { ptsPlace(p); return; } if (!aim) onMapPick(p); });
  $('routePick').onclick = pickClick;
  // панель «Маршрут» (деталі) закрили, а варіант ще не вибрано — повертаємо шторку вибору
  bus.on('panel', name => { if (name) { if (rrOpen()) cancelChoice('panel'); else if (tsOpen()) tsHide(false); else if (!$('routePick').hidden) $('routePick').hidden = true; } else if (plan.trip && !g.active && !plan.busy && !plan.going) pickShow(); });
  bus.on('trip', () => { if (tsOpen() && !g.active) tsHide(true); else if (g.active && $('routePick').dataset.mode !== 'trip') pickHide(); });
  bus.on('route', () => { if (tsOpen()) { tsRender(); requestAnimationFrame(tsFit); } });
  bus.on('guide', () => { if (tsOpen()) { const kv = document.querySelector('#routePick .ts-kv'); if (kv) kv.outerHTML = tsKvHtml(); } });
  $('routePick').addEventListener('input', tsInput);
  bus.on('altTap', k => { if (rrOpen()) selectChoice(+k); else if (plan.trip && !g.active && plan.routes[k]) selectAlt(+k); });
  bus.on('choice', rrRender);
  bus.on('stopTap', x => { if (!aim) onStopTap(x); });
  bus.on('markTap', onMarkTap);
  bus.on('marks', () => refresh('trip'));
  bus.on('evTap', id => {
    if (id.startsWith('air:')) { toast(t('airOn', oblastName(id.slice(4))), 'yellow', 7000, () => openPanel('feed')); return; }
    const it = feed.items.find(x => x.id === id); if (!it) return;
    const src = it.src === 'tg' ? '@' + it.ch : t(SRC[it.src] || 'srcSys');
    toast(src + ' · ' + ago(it.time) + (it.locName ? ' · ' + it.locName : '') + '\n' + (it.sum || it.text).replace(/\s+/g, ' ').slice(0, 260), it.level, 12000, () => openPanel('feed'));
  });
  // GPS зник: пояснюємо водієві, що нічого страшного — ведемо тим самим рейсом і де саме звіримо місце
  bus.on('gpsLost', d => {
    P.vibrate(300);
    if (d.reason === 'manual') return;
    if (d.reason === 'spoof') { say(t('voiceSpoof'), { urgent: true }); return; }
    const c = nextCp();
    if (c && c.d - pos.rd < 30000) { const m = c.d - pos.rd; say(t('voiceLostCp', distWords(m)), { urgent: true }); toast(t('lostCpToast', fmtDist(m), cpWhat(c)), 'yellow', 12000, () => openPanel('gps')); }
    else if (g.active && pos.onRoute) { say(t('voiceLostRoute'), { urgent: true }); toast(t('lostRouteToast'), 'yellow', 10000, () => openPanel('gps')); }
    else say(t('voiceLost'), { urgent: true });
  });
  // Контрольний поворот пройдено: тихий «дзинь» завжди; плашка — коли позначку довелось підтягнути чи вона довго чекала
  let cpToastT = 0;
  bus.on('cpPass', ev => {
    if (pos.mode !== 'dr') return;
    if (ev.by === 'gyro' || ev.by === 'button') chime('pass');
    if (ev.by !== 'gyro' || (ev.jump < 60 && ev.waited < 10)) return;
    const now = Date.now(); if (now - cpToastT < 20000) return; cpToastT = now;
    toast(t(ev.jump >= 60 ? 'turnPassJump' : 'turnPassWait', ev.jump >= 60 ? fmtDist(ev.jump) : fmtMS(ev.waited)) + (ev.next ? ' ' + t('turnMatchNext', fmtDist(ev.next.dist)) : ''), 'green', 6000);
  });
  $('bTurn').onclick = () => {
    const c = passTurn(); if (!c) return;
    P.vibrate(40);
    toast(t('turnPassBtn', cpWhat(c)), 'green', 8000, () => { if (undoTurn()) toast(t('turnUndone'), '', 4000); });
  };
  initSfx();
  let tmToastT = 0, tmVoiceT = 0;
  bus.on('turnMatch', m => {
    if (!m || pos.mode !== 'dr') return;
    const now = Date.now(), nx = m.next && pos.rd != null && m.next.d > pos.rd ? m.next.d - pos.rd : null;
    if (m.was > 300 && now - tmVoiceT > 180000) { tmVoiceT = now; say(t('voiceTurnMatch')); }
    if (now - tmToastT < 45000) return;
    tmToastT = now;
    toast(t('turnMatchToast', m.now != null ? m.now : pos.acc) + (nx != null ? ' ' + t('turnMatchNext', fmtDist(nx)) : ''), 'green', 6000);
  });
  bus.on('truckFail', () => { say(t('voiceTruckFail')); toast(t('truckFailTitle') + '\n' + t('truckFailText'), 'red', 12000); });
  bus.on('rerouteWait', () => { say(t('voiceRerouteWait')); toast(t('rerouteWait'), 'yellow', 9000); });
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
    if (!$('calib').hidden) { calibClose(); return true; }
    if (jvIsOpen()) { jvClose(true); return true; }                       // (1.1.25) поїздка з архіву на карті → назад до списку поїздок
    // (1.1.24) відкрите фото місця — «Назад» закриває саме його (раніше закривалась картка під ним, а наступний дотик згортав програму)
    if (!$('photoView').hidden) { $('photoView').hidden = true; $('photoView').innerHTML = ''; return true; }
    if (labOpen()) { closeLab(); return true; }
    if (!$('quick').hidden) { quickOpen(false); return true; }
    if (!$('repSheet').hidden) { repOpen(false); return true; }
    if (aim) { aimEnd(); return true; }
    if (pm) { ptsEnd(true); return true; }
    if (tsOpen()) { tsHide(true); return true; }
    if (!$('routePick').hidden) { pickCancel(); return true; }
    if (!$('pick').hidden) { $('pick').hidden = true; showPick(null); return true; }
    // «Назад» іде кроками: з вкладеної панелі — у ту, звідки прийшли (картка місця → «Місця», архів → «Рейс», екрани налаштувань →
    // «Налаштування»), з головної панелі — на карту; і лише з карти оболонка згортає програму
    { const up = panelParent(); if (up) { openPanel(up); return true; } }
    if (currentPanel()) { closePanel(); return true; }
    return false;
  };

  $('strip').onclick = () => openPanel('feed');
  $('panelClose').onclick = closePanel;
  $('panelOk').onclick = closePanel;                                   // (1.1.24) одна галочка на всіх панелях: «Готово» — назад на карту
  $('panelBody').addEventListener('scroll', panelDodgeSoon, { passive: true });
  document.querySelectorAll('#tabs button[data-panel]').forEach(b => { b.onclick = () => {
    // у дорозі «Маршрут» — не панель, а карта з усім залишком маршруту й трьома кнопками
    if (b.dataset.panel === 'trip' && g.active && !g.arrived) { if (tsOpen()) tsHide(true); else tsShow(); return; }
    if (tsOpen()) tsHide(false);
    currentPanel() === b.dataset.panel ? closePanel() : openPanel(b.dataset.panel);
  }; });
  $('bQuick').onclick = e => { e.stopPropagation(); quickOpen($('quick').hidden); };
  // кружечок GPS біля круга швидкості — подробиці про сигнал (як раніше з нижньої стрічки)
  $('spdGps').onclick = e => { e.stopPropagation(); if (tsOpen()) tsHide(false); currentPanel() === 'gps' ? closePanel() : openPanel('gps'); };
  // калібрування телефона — на весь екран
  bus.on('calib', tabCalSync); bus.on('calibSaved', () => { tabCalSync(); toast(t('cbSaved'), 'green', 5000); });
  bus.on('reports', repTabSync); bus.on('trip', repTabSync);
  $('bMap').onclick = e => { e.stopPropagation(); mapTypeTap(); };
  // мережа зникла / повернулась: мініатюра на кнопці і — якщо вибрано супутник — коротко водієві
  const netChanged = () => railState();
  window.addEventListener('online', netChanged); window.addEventListener('offline', netChanged);
  bus.on('mapType', netChanged);
  bus.on('satNet', on => toast(t(on ? 'mtNetBack' : 'mtNetLost'), on ? 'green' : 'yellow', on ? 3500 : 7000));
  $('quick').onclick = e => { e.stopPropagation(); quickClick(e); };
  document.addEventListener('pointerdown', e => { if (!$('quick').hidden && !e.target.closest('#quick,#bQuick')) quickOpen(false); });
  $('bCenter').onclick = () => setFollow(true);
  tiltInit();
  // позначити подію на дорозі (як у навігаторах для водіїв): три великі кнопки
  $('tabRep').onclick = e => { e.stopPropagation(); if (tsOpen()) tsHide(false); repOpen($('repSheet').hidden); };

  $('repSheet').onclick = repClick;
  // екран маршруту відкрили чи закрили (будь-яким шляхом) — карта чиста або знову з позначками
  new MutationObserver(rpSync).observe($('routePick'), { attributes: true, attributeFilter: ['hidden'] });
  bus.on('repTap', id => { if (aim) return; const r = reps.list.find(x => x.id === id); if (r) toast(t(r.own ? 'repMine' : 'repTap', repName(r), repStamp(r) + ' (' + repAgo(r) + ')') + (r.conf ? t('repConf', r.conf) : ''), REP_TYPES[r.t].level, 6000); });
  bus.on('repAsk', onRepAsk);
  bus.on('pos', () => { if (askRep && pos.lat != null && hav(pos, askRep) > 800) { askRep = null; mapM.askHide(); } });
  const offBadSay = why => toast(t(why === 'app' ? 'offBadAppToast' : why === 'tiles' ? 'offBadTilesToast' : 'offBadToast'), 'red', 18000, () => openPanel('settings'));
  bus.on('offlineBad', offBadSay);
  if (off.bad) setTimeout(() => offBadSay(off.bad), 1500);      // файл перевіряється ще до запуску інтерфейсу — кажемо про результат тепер
  $('aim').onclick = aimClick;
  $('pts').onclick = ptsClick;
  /* ---------- клавіатура й нижня плашка (1.1.14) ----------
     Коли відкрита екранна клавіатура, вікно стає нижчим, і нижня плашка (час, вкладки) опинялась одразу над клавіатурою —
     поверх підказок адрес. Поки водій набирає текст, нижню плашку ховаємо, а панель розтягуємо на всю висоту над клавіатурою. */
  let kbW = 0, kbMaxH = 0, kbT = 0, kbEl = null;
  const kbWant = () => {
    const w = window.innerWidth, h = window.innerHeight;
    if (kbW !== w) { kbW = w; kbMaxH = h; }                 // повернули екран — нова «повна» висота
    kbMaxH = Math.max(kbMaxH, h);
    const el = document.activeElement, typing = !!el && ((el.tagName === 'INPUT' && !/^(checkbox|radio|range|button|file|color)$/.test(el.type)) || el.tagName === 'TEXTAREA');
    return typing && h < kbMaxH - 120 ? el : null;
  };
  const kbApply = el => {
    const on = !!el;
    if (document.body.classList.contains('kb') !== on) { document.body.classList.toggle('kb', on); layoutVars(); }
    // поле, в яке набирають, — угорі панелі: підказки під ним видно цілком, а не десь під клавіатурою
    if (on && el !== kbEl) { const body = $('panelBody'), f = el.closest('.field') || el; if (body && body.contains(el)) body.scrollTop += f.getBoundingClientRect().top - body.getBoundingClientRect().top - 6; }
    kbEl = on ? el : null;
  };
  // Вмикаємо одразу, вимикаємо із затримкою: дотик до підказки чи кнопки спершу знімає фокус із поля,
  // і якби екран перебудувався в ту ж мить, кнопка «втекла» б з-під пальця й натискання пропало б.
  const kbSync = () => { clearTimeout(kbT); const el = kbWant(); if (el) kbApply(el); else kbT = setTimeout(() => kbApply(kbWant()), 300); };
  document.addEventListener('focusin', kbSync);
  document.addEventListener('focusout', kbSync);
  window.addEventListener('resize', kbSync);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', kbSync);
  kbSync();
  // поки відкрита панель чи плашка точок, нижня плашка непрозора: під нею не просвічують підписи карти
  bus.on('panel', name => {
    document.body.classList.toggle('panel-open', !!name);
    // складаємо рейс (форма «Рейс», рейс ще не їде): рядок із годинником у нижній плашці ховаємо — формі більше місця, кнопка «Побудувати» не ховається під плашку
    document.body.classList.toggle('planning', (name === 'trip' || name === 'archive') && !g.active && !g.arrived);
    // відкриті «Місця» (1.1.22): час прибуття, кілометри й хвилини внизу зараз не потрібні — ховаємо, списку з відстанями більше місця
    document.body.classList.toggle('places-on', name === 'places' || name === 'place');
    requestAnimationFrame(layoutVars);
  });
  window.addEventListener('resize', () => { if (aim) aimPlaceCross(); });
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

  $('photoView').onclick = e => { if (e.target.closest('[data-pv="x"]') || e.target === $('photoView')) { $('photoView').hidden = true; $('photoView').innerHTML = ''; } };
}
