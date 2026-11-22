// Головний екран і панелі «Рейс», «Події», «Чат».
import { bus, log, S, hav, fmtDist, fmtDur, fmtClock, fmtMS, RouteIndex } from './core.js';
import * as P from './platform.js';
import { pos, nudge, acceptPending, setManual, speedView } from './nav.js';
import { g, startTrip, stopTrip, rerouteNow, say, setVia } from './guide.js';
import { poi, stopsAhead, stopLabel, restore as restorePoi, snapshot as poiSnapshot } from './poi.js';
import { feed, strip, vote, markSeen, regionsAhead, setRouteContext, pollTelegram, pollAir, tgAvailable, activeChannels } from './feed.js';
import { chat, send, voiceOnce, toggleLive, clearChat, errorText } from './chat.js';
import { hasKey } from './ai.js';
import { geocode, reverse, buildRoute, regionsAlong, newTrip, saveTrip, deleteTrip, getTrips, tripTitle, oblastName } from './route.js';
import { view, setFollow, zoomBy, previewRoute, showRoute, showPick, prefetchRoute, applyTheme, ROUTE_COLORS, flyTo } from './map.js';
import { hz, load as loadHazards, routeCats, hazardsAlong, hazardText, kyivOnRoute, indexOf as indexOfRoute } from './roads.js';
import { heatAlong, heatApplies } from './weather.js';
import * as rough from './rough.js';
import * as showers from './showers.js';
import { offlineActive } from './offline.js';
import { sdb, TYPES, F, nearbyRows } from './stopsdb.js';
import * as places from './places.js';
import { exportGpx, track, trackKm } from './track.js';
import { $, ICON, manIcon, toast, definePanel, openPanel, closePanel, refresh, currentPanel, esc, applyGlass } from './ui_base.js';
import { t } from './i18n.js';

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
  const names = { trip: 'tabTrip', feed: 'tabFeed', chat: 'tabChat', lab: 'tabLab' };
  tabs.forEach(b => { b.innerHTML = ICON[b.dataset.panel] + '<span>' + t(names[b.dataset.panel]) + '</span>'; });
  $('bMic').innerHTML = ICON.mic; $('bMic').setAttribute('aria-label', t('micHint'));
  $('panelClose').innerHTML = ICON.x; $('panelBack').innerHTML = ICON.back;
  $('bCenter').innerHTML = ICON.center;
  railState();
}
function railState() {
  $('bCompass').innerHTML = view.north ? ICON.north : ICON.head; $('bCompass').classList.toggle('on', view.north);
  $('b3d').classList.toggle('on', !!S.view3d); $('b3d').textContent = S.view3d ? '3D' : '2D';
  $('bSettings').innerHTML = ICON.gear; $('bSettings').setAttribute('aria-label', t('settings'));
  $('bVoice').innerHTML = S.voice ? ICON.vol : ICON.mute; $('bVoice').classList.toggle('off', !S.voice);
  $('bRec').classList.toggle('on', !!S.rec);
  $('bCenter').classList.toggle('need', !view.follow);
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
  const guess = sv.kind === 'approx' || sv.kind === 'est';
  $('spdVal').textContent = sv.kind === 'none' ? '—' : (guess ? '≈' : '') + (kmh < 2 ? '0' : Math.round(kmh));
  $('spdUnit').textContent = sv.kind === 'none' ? t('spdUnknown') : sv.kind === 'est' ? t('spdEst') : sv.kind === 'approx' ? t('spdNet') : t('kmh');
  sp.classList.toggle('est', sv.kind !== 'gps' && sv.kind !== 'still');
  sp.classList.toggle('wide', guess);
  const cam = S.cams ? poi.nextCam : null;
  sp.classList.toggle('over', !!(cam && cam.max && kmh > cam.max + 3 && cam.ahead < 600));
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
    $('lostLine').textContent = 'GPS ✕ ' + fmtMS((Date.now() - pos.lostSince) / 1000) + ' · ±' + accText(pos.acc)
      + (pos.reason === 'spoof' ? ' · ' + t('spoofShort') : pos.reason === 'manual' ? ' · ' + t('manualShort') : '');
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
    else if (g.offRoute || pos.rd == null) {
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
  if (man.hidden === show) { man.hidden = !show; stripEl.classList.toggle('alone', !show); requestAnimationFrame(layoutVars); }

  // нижній рядок
  if (g.arrived) { $('eta').textContent = fmtClock(new Date()); $('remain').textContent = t('tripDone'); }
  else if (g.active && g.route) { $('eta').textContent = fmtClock(new Date(g.eta)); $('remain').textContent = fmtDist(g.remain) + ' · ' + fmtDur(g.remTime); }
  else { $('eta').textContent = fmtClock(new Date()); $('remain').textContent = t('noTrip'); }
}

function stripUpdate() {
  const s = strip(), el = $('strip');
  const off = !S.lookahead;
  el.dataset.level = s.top && !off ? s.top.level : 'none';
  $('stripText').textContent = off ? t('stripOff') : s.top ? (s.top.sum || s.top.text).replace(/\s+/g, ' ').slice(0, 140) : t('stripEmpty');
  const c = s.counts;
  $('stripCounts').innerHTML = off ? '' : ['red', 'yellow', 'green'].filter(k => c[k]).map(k => `<i class="c-${k}">${c[k]}</i>`).join('');
  const tab = document.querySelector('#tabs button[data-panel="feed"]');
  if (tab) { let b = tab.querySelector('.badge'); if (s.unseen && !off) { if (!b) { b = document.createElement('span'); b.className = 'badge'; tab.appendChild(b); } b.textContent = s.unseen; } else if (b) b.remove(); }
}

/* =====================  ПАНЕЛЬ «РЕЙС»  ===================== */
const plan = { a: null, v: null, b: null, trip: null, busy: false, err: '', sugg: [], field: null, regBusy: false, off: null };
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
  <div class="btns"><button class="btn" data-act="reroute">${t('reroute')}</button><button class="btn" data-act="offline">${t('offlineMap')}</button></div>
  <div class="btns"><button class="btn danger wide" data-act="stop">${t('endTrip')}</button></div>
  ${poi.drive > 300 ? `<div class="sec">${t('driveSec')}</div><div class="card">${t('driveNow', fmtDur(poi.drive))}</div>` : ''}
  <div class="sec">${t('stopsSec')}</div><div class="list">${st || `<div class="muted">${poi.loading ? t('loading') : t('stopsNone')}</div>`}</div>
  ${showersRouteHtml(g.route, g.idx, pos.rd || 0)}
  ${truckHtml(g.route, pos.rd || 0, d => Date.now() + Math.max(0, d - (pos.rd || 0)) / Math.max(1, g.remain) * g.remTime * 1000)}`;
}
function savedHtml() {
  const list = getTrips().filter(x => !g.trip || x.id !== g.trip.id);
  if (!list.length) return `<div class="muted">${t('savedNone')}</div>`;
  return '<div class="list">' + list.map(x => `<div class="item"><div class="grow"><div class="t">${esc(tripTitle(x))}</div><div class="muted">${x.route ? fmtDist(x.route.dist) + ' · ' + fmtDur(x.route.time) : ''}</div></div>
    <button class="btn sm pri" data-open="${x.id}">${t('open')}</button><button class="btn sm" data-del="${x.id}" aria-label="${t('delete')}">${ICON.trash}</button></div>`).join('') + '</div>';
}
function fieldHtml(k, cls, tag, ph) {
  const v = plan[k];
  return `<div class="field"><div class="tag ${cls}">${tag}</div><input id="in_${k}" data-f="${k}" placeholder="${esc(ph)}" value="${esc(v ? v.label : '')}" autocomplete="off" enterkeyhint="search">
    ${k === 'a' ? `<button data-here="1" aria-label="${t('myPlace')}">${ICON.here}</button>` : `<button data-clear="${k}" aria-label="${t('clear')}">${ICON.x}</button>`}</div><div class="sugg" id="sg_${k}" hidden></div>`;
}
function planHtml() {
  return `<div id="planSum">${plan.trip ? planSumHtml() : ''}</div>${plan.trip ? '' : showersNearHtml()}<div class="sec">${t('newTrip')}</div>
    ${fieldHtml('a', 'a', 'A', t('phA'))}${fieldHtml('v', 'v', '•', t('phV'))}${fieldHtml('b', 'b', 'Б', t('phB'))}
    <div class="muted">${t('pickHint')}</div>
    <div class="btns"><button class="btn pri wide" data-act="build" ${plan.busy ? 'disabled' : ''}>${plan.busy ? t('building') : t('build')}</button></div>
    <div id="planErr" class="muted" style="color:var(--red);margin-top:8px">${esc(plan.err)}</div>
    <div class="sec">${t('savedSec')}</div><div id="savedBox">${savedHtml()}</div>`;
}
function placeLine(p) { return p ? esc(p.label) + (p.sub ? ` <span class="muted">${esc(p.sub)}</span>` : '') : ''; }
function planSumHtml() {
  const tr = plan.trip, r = tr.route, alt = r.alt;
  const warn = alt ? `<div class="card" style="margin-top:8px;border:2px solid var(--yellow)"><div style="font-weight:600">${t('detourTitle', fmtDist(r.dist), fmtDist(alt.dist))}</div>
      <div class="muted" style="margin-top:4px">${t('detourText')}</div>
      <div class="btns"><button class="btn" data-act="useAlt">${t('useAlt', fmtDist(alt.dist))}</button></div></div>`
    : r.costing === 'auto' ? `<div class="muted" style="margin-top:8px;color:var(--red)">${t('altInUse')}</div>` : '';
  return `<div class="sec">${t('routeReady')}</div><div class="card"><div style="font-weight:600">${placeLine(tr.a)}</div><div style="font-weight:600;margin:2px 0 10px">→ ${placeLine(tr.b)}</div>${summaryHtml(tr)}${offlineHtml()}</div>${warn}
    <div class="btns"><button class="btn dark" data-act="go">${ICON.go}${t('go')}</button><button class="btn" data-act="save">${t('saveLater')}</button></div>
    ${truckHtml(r, 0, d => Date.now() + d / Math.max(1, r.dist) * r.time * 1000)}
    ${showersRouteHtml(r, indexOfRoute(r), 0)}`;
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
    trip.route = await buildRoute(trip);
    plan.trip = trip; previewRoute(trip.route.coords, trip.route);
    loadRegions(trip);
  } catch (e) {
    plan.err = (e.code ? t('routeFail') : t('netErr')) + ' ' + (e.message || '');
    log('warn', 'маршрут: ' + e.message);
  }
  plan.busy = false; refresh('trip');
}
async function goTrip(trip) {
  saveTrip(trip); places.remember(trip.b);
  restorePoi(trip.cams, trip.stops);
  closePanel(); showPick(null);
  P.keepAwake(S.keepAwake !== false);
  await startTrip(trip);
  setRouteContext(trip.regions, trip.towns);
  setFollow(true);
  plan.trip = null; plan.a = plan.v = plan.b = null;
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
  else if (d.act === 'go' && plan.trip) goTrip(plan.trip);
  else if (d.act === 'useAlt' && plan.trip && plan.trip.route.alt) {
    const tr = plan.trip, alt = tr.route.alt;
    alt.aD = null; alt.viaD = tr.route.viaD; alt.detour = 1; tr.costing = 'auto'; tr.route = alt; tr.regions = []; tr.towns = [];
    previewRoute(alt.coords, alt); refresh('trip'); loadRegions(tr);
  }
  else if (d.act === 'save' && plan.trip) { saveTrip(plan.trip); toast(t('saved'), 'green', 3000); plan.trip = null; plan.a = plan.v = plan.b = null; previewRoute(null); openPanel('trip'); }
  else if (d.act === 'reroute') { rerouteNow(); closePanel(); }
  else if (d.act === 'offline' && g.route) runOffline(g.route);
  else if (d.act === 'stop') { const tr = g.trip; if (tr) { const snap = poiSnapshot(); tr.cams = snap.cams; tr.stops = snap.stops; if (getTrips().some(x => x.id === tr.id)) saveTrip(tr); } stopTrip(); previewRoute(null); setRouteContext([], []); openPanel('trip'); }
  else if (d.open) { const tr = getTrips().find(x => x.id === d.open); if (tr && tr.route) { plan.trip = tr; plan.a = tr.a; plan.v = tr.v; plan.b = tr.b; plan.off = null; previewRoute(tr.route.coords, tr.route); openPanel('trip'); loadRegions(tr); } }
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
function onMapPick(p) {
  showPick(p);
  const box = $('pick'); box.hidden = false;
  const pts = g.active ? '' : `<button class="btn" data-k="a">A</button><button class="btn" data-k="v">${t('via')}</button><button class="btn" data-k="b">Б</button>`;
  box.innerHTML = `<div class="muted">${t('pickTitle')} ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</div><div class="row">
    ${pts}<button class="btn" data-k="here">${t('iAmHere')}</button><button class="btn" data-k="x" aria-label="${t('clear')}">${ICON.x}</button></div>
    <div class="row"><button class="btn wide" data-k="shower">${ICON.shower}${t('showerHere')}</button></div>`;
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
    : `<button class="btn" data-k="a">A</button><button class="btn" data-k="v">${t('via')}</button><button class="btn" data-k="b">Б</button>`;
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
    : `<button class="btn" data-k="a">A</button><button class="btn" data-k="v">${t('via')}</button><button class="btn" data-k="b">Б</button>`;
  const mine = showers.myShowerAt({ lat, lon }, 60);
  const shBtn = ty === 'c' ? '' : `<div class="row"><button class="btn wide${mine ? ' sh-on' : ''}" data-k="shower">${ICON.shower}${mine ? t('showerMine') : f & F.SHOWER ? t('showerConfirm') : t('showerHere')}</button></div>`;
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
function evHtml(i) {
  const src = i.src === 'tg' ? '@' + i.ch : t(SRC[i.src] || 'srcSys');
  const v = i.vote;
  return `<div class="ev ${i.level || ''}"><div class="meta"><span>${esc(src)}</span><span>${ago(i.time)}</span>${i.ai ? '<span>Claude</span>' : ''}</div>
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
    const on = regionsAhead().filter(r => feed.air[r.id]).map(r => oblastName(r.id));
    parts.push(feed.airErr ? t('airErr') : feed.airAt ? (on.length ? t('airNow', on.join(', ')) : t('airNone')) : t('airWait'));
  }
  return parts.join(' · ');
}
function feedHtml() {
  const hot = i => i.level === 'red' && Date.now() - i.time < 3600e3 ? 1 : 0;
  const main = feed.items.filter(i => !i.filtered && i.level && i.vote !== -1).slice(-60).sort((a, b) => (hot(b) - hot(a)) || (b.time - a.time));
  const rest = feed.items.filter(i => i.filtered || !i.level || i.vote === -1).slice(-60).reverse();
  const list = feedTab === 'main' ? main : rest;
  return `<div class="muted" style="margin-bottom:10px">${esc(feedStatus())}</div>
    <div class="seg"><button data-tab="main" class="${feedTab === 'main' ? 'on' : ''}">${t('feedMain')} ${main.length || ''}</button><button data-tab="rest" class="${feedTab === 'rest' ? 'on' : ''}">${t('feedRest')} ${rest.length || ''}</button></div>
    <div class="list">${list.map(evHtml).join('') || `<div class="muted">${feedTab === 'main' ? t('feedEmpty') : t('feedRestEmpty')}</div>`}</div>
    <div class="btns"><button class="btn sm" data-act="refresh">${t('refreshNow')}</button><button class="btn sm" data-act="channels">${t('channels')}</button></div>
    <div class="muted" style="margin-top:10px">${t('feedHint')}</div>`;
}
definePanel('feed', {
  title: () => t('tabFeed'),
  render(body) {
    body.innerHTML = feedHtml(); markSeen();
    body.onclick = e => {
      const b = e.target.closest('button'), x = e.target.closest('[data-exp]');
      if (!b) { if (x) x.classList.toggle('cl'); return; }
      if (b.dataset.tab) { feedTab = b.dataset.tab; body.innerHTML = feedHtml(); }
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
  setInterval(() => { hud(); if (currentPanel() === 'trip' && g.active) refresh('trip'); }, 1000);
  bus.on('pos', hud); bus.on('guide', hud); bus.on('poi', () => { hud(); refresh('trip'); });
  bus.on('feed', () => { stripUpdate(); refresh('feed'); if (g.active) refresh('trip'); });
  bus.on('chat', () => { refresh('chat'); micState(); });
  bus.on('trips', () => refresh('trip'));
  bus.on('hazards', () => refresh('trip'));
  bus.on('view', railState);
  bus.on('settings', k => { railState(); if (k === 'glass') applyGlass(); if (k === 'lang') { staticLabels(); hud(); stripUpdate(); } if (k === 'lookahead') stripUpdate(); });
  bus.on('toast', x => { const s = $('strip'); s.classList.remove('pulse'); void s.offsetWidth; s.classList.add('pulse'); if (S.popups) toast(x.text.replace(/\s+/g, ' ').slice(0, 180), x.level, 9000, () => openPanel('feed')); });
  bus.on('mapPick', onMapPick);
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
    if (!$('pick').hidden) { $('pick').hidden = true; showPick(null); return true; }
    if (currentPanel()) { closePanel(); return true; }
    return false;
  };

  $('strip').onclick = () => openPanel('feed');
  $('panelClose').onclick = closePanel;
  document.querySelectorAll('#tabs button[data-panel]').forEach(b => { b.onclick = () => currentPanel() === b.dataset.panel ? closePanel() : openPanel(b.dataset.panel); });
  $('bCompass').onclick = () => { view.north = !view.north; setFollow(true); railState(); };
  $('b3d').onclick = () => { S.view3d = !S.view3d; setFollow(true); };
  $('bSettings').onclick = () => currentPanel() === 'settings' ? closePanel() : openPanel('settings');
  $('bVoice').onclick = () => { S.voice = !S.voice; if (!S.voice) P.stopSpeak(); toast(t(S.voice ? 'voiceOn' : 'voiceOff'), '', 1800); };
  $('bRec').onclick = () => {
    S.rec = !S.rec;
    if (S.rec) toast(t('recOn'), '', 2500);
    else if (track.pts.length > 1) { const n = exportGpx(); toast(n ? t('recSaved', trackKm().toFixed(1), n) : t('recOff'), 'green', 6000); }
    else toast(t('recOff'), '', 2000);
  };
  $('bZin').onclick = () => zoomBy(1); $('bZout').onclick = () => zoomBy(-1);
  $('bCenter').onclick = () => setFollow(true);
  $('bFwd100').onclick = () => nudge(100); $('bBack100').onclick = () => nudge(-100);
  $('bAcceptGps').onclick = acceptPending;
  $('gpsChip').onclick = () => openPanel('gps');
  $('lostLine').onclick = () => openPanel('gps');

  // мікрофон: коротке натискання — голосове повідомлення, довге — жива розмова
  let lp = null, long = false;
  const mic = $('bMic');
  const down = () => { long = false; lp = setTimeout(() => { long = true; P.vibrate(60); toggleLive(); }, 650); };
  const up = () => { clearTimeout(lp); if (long) return; if (chat.live) toggleLive(); else if (!hasKey()) openPanel('chat'); else voiceOnce(); };
  mic.addEventListener('pointerdown', down); mic.addEventListener('pointerup', up); mic.addEventListener('pointerleave', () => clearTimeout(lp));
  mic.addEventListener('contextmenu', e => e.preventDefault());
}
function micState() { const m = $('bMic'); m.classList.toggle('listening', chat.listening); m.classList.toggle('live', chat.live); }
