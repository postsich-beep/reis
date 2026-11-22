// Панелі «Лабораторія», «Налаштування», «Telegram-канали», «GPS», «Діагностика», «Про застосунок».
import { bus, log, getLog, S, VERSION, fmtClock, fmtMS } from './core.js';
import * as P from './platform.js';
import { pos, nudge, acceptPending, debugState, speedView, gpsJournal, gq } from './nav.js';
import { g, say } from './guide.js';
import { feed, resetLearning, clearFeed, tgAvailable, addDefaultChannels } from './feed.js';
import { OBLASTS, oblastName } from './route.js';
import { cacheInfo, clearCache, cacheStats, setMapStyle, applyTheme, setFollow, applyMapSource } from './map.js';
import { off, offlineActive, refreshStatus } from './offline.js';
import { sdb, TYPES } from './stopsdb.js';
import { drawStops } from './map.js';
import { sim, start as simStart, stop as simStop, setLost, setSpoof, setSpeed } from './sim.js';
import * as rough from './rough.js';
import { track, trackKm, exportGpx, clearTrack } from './track.js';
import { $, ICON, toast, definePanel, openPanel, refresh, esc, toggleRow } from './ui_base.js';
import { locState, lostReason } from './ui.js';
import { t } from './i18n.js';

/* =====================  ЛАБОРАТОРІЯ  ===================== */
const TG = [
  ['sec', 'labMain'], ['lookahead'],
  ['sec', 'labWatch'], ['tg'], ['air'], ['weather'], ['cams'], ['stops'], ['drive'], ['aiFilter'],
  ['sec', 'labPos'], ['spoof'], ['offline'], ['rec']
];
const SOON = ['obd', 'camera', 'mesh', 'localAi', 'traffic'];
function simHtml() {
  const can = !!g.idx;
  return `<div class="card"><div class="muted">${can ? t('simHint') : t('simNeedTrip')}</div>
    <div class="btns"><button class="btn ${sim.on ? 'danger' : 'dark'}" data-sim="toggle" ${can ? '' : 'disabled'}>${sim.on ? t('simStop') : t('simStart')}</button>
      <select class="inp" id="simSpd" style="flex:1;margin:0" aria-label="${t('simSpeed')}">${[40, 70, 90, 300].map(k => `<option value="${k}" ${sim.kmh === k ? 'selected' : ''}>${k === 300 ? t('simFast') : k + ' ' + t('kmh')}</option>`).join('')}</select></div>
    <div class="btns"><button class="btn sm${sim.lost ? ' danger' : ''}" data-sim="lost" ${sim.on ? '' : 'disabled'}>${sim.lost ? t('simLostOff') : t('simLost')}</button>
      <button class="btn sm${sim.spoof ? ' danger' : ''}" data-sim="spoof" ${sim.on ? '' : 'disabled'}>${sim.spoof ? t('simSpoofOff') : t('simSpoof')}</button></div></div>`;
}
function roughHtml() {
  const s = rough.stats();
  const body = !s.cells ? t('roughEmpty') : s.calib < 100 ? t('roughCalib', s.km, s.calib) : t('roughStats', s.km, s.g, s.y, s.r);
  return `<div class="card" style="margin-top:8px"><div>${body}</div>
    <div class="legend" style="margin-top:8px"><button disabled><span class="sdot" style="background:#2f9e62"></span>${t('roughG')}</button><button disabled><span class="sdot" style="background:#f6bd16"></span>${t('roughY')}</button><button disabled><span class="sdot" style="background:#e5484d"></span>${t('roughR')}</button></div>
    ${s.cells ? `<div class="btns"><button class="btn sm" data-act="roughClear">${b_sure ? t('roughClearSure') : t('roughClear')}</button></div>` : ''}</div>`;
}
let b_sure = false;
function labHtml() {
  let h = '';
  for (const [k, v] of TG) {
    if (k === 'sec') { h += `</div><div class="sec">${t(v)}</div><div class="list">`; continue; }
    h += toggleRow(k, t('tg_' + k), t('tgd_' + k, k === 'stops' ? S.stopKm : k === 'lookahead' ? S.aheadH : ''), S[k]);
  }
  h = h.replace(/^<\/div>/, '') + '</div>';
  h += `<div class="sec">${t('labRough')}</div><div class="muted" style="margin:0 2px 8px">${t('labRoughHint')}</div><div class="list">${toggleRow('rough', t('tg_rough'), t('tgd_rough'), S.rough)}${toggleRow('roughMap', t('tg_roughMap'), t('tgd_roughMap'), S.roughMap)}</div><div id="roughBox">${roughHtml()}</div>`;
  h += `<div class="sec">${t('labTest')}</div><div id="simBox">${simHtml()}</div>`;
  h += `<div class="sec">${t('labSoon')}</div><div class="list">${SOON.map(k => toggleRow(k, t('soon_' + k), t('soond_' + k), false, t('soon'))).join('')}</div>`;
  h += `<div class="sec">${t('labMore')}</div><div class="btns"><button class="btn" data-go="settings">${t('settings')}</button><button class="btn" data-go="channels">${t('channels')}</button></div>
    <div class="btns"><button class="btn" data-go="gps">GPS</button><button class="btn" data-go="diag">${t('diag')}</button><button class="btn" data-go="about">${t('about')}</button></div>`;
  return h;
}
definePanel('lab', {
  title: () => t('labTitle'),
  render(body) {
    body.innerHTML = labHtml();
    body.onclick = e => {
      const row = e.target.closest('[data-tg]'), b = e.target.closest('button');
      if (row) {
        const k = row.dataset.tg; S[k] = !S[k];
        const sw = row.querySelector('.sw'); sw.classList.toggle('on', !!S[k]); sw.setAttribute('aria-checked', !!S[k]);
        if (k === 'aiFilter' && S[k] && !(S.apiKey || '').trim()) toast(t('needKey'), 'yellow', 5000);
        if (k === 'tg' && S[k] && !(S.channels || []).length) toast(t('tgNoCh'), 'yellow', 5000);
        return;
      }
      if (!b) return;
      if (b.dataset.go) openPanel(b.dataset.go);
      else if (b.dataset.act === 'roughClear') { if (b_sure) { rough.clear(); b_sure = false; toast(t('done'), 'green', 2500); } else b_sure = true; const rb = $('roughBox'); if (rb) rb.innerHTML = roughHtml(); }
      else if (b.dataset.sim === 'toggle') { if (sim.on) simStop(); else if (!simStart()) toast(t('simNeedTrip'), 'yellow'); }
      else if (b.dataset.sim === 'lost') setLost(!sim.lost);
      else if (b.dataset.sim === 'spoof') setSpoof(!sim.spoof);
    };
    body.onchange = e => { if (e.target.id === 'simSpd') setSpeed(+e.target.value); };
  },
  update() { const b = $('simBox'); if (b) b.innerHTML = simHtml(); const rb = $('roughBox'); if (rb) rb.innerHTML = roughHtml(); }
});

/* =====================  НАЛАШТУВАННЯ  ===================== */
const STYLES = [['liberty', 'https://tiles.openfreemap.org/styles/liberty'], ['bright', 'https://tiles.openfreemap.org/styles/bright'], ['positron', 'https://tiles.openfreemap.org/styles/positron']];
const RATES = [['slow', 0.85], ['normal', 1], ['fast', 1.2]];
const seg = (key, opts) => `<div class="seg">${opts.map(([v, label, on]) => `<button data-seg="${key}:${v}" class="${on ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
const GB = b => b >= 1e9 ? (b / 1e9).toFixed(2).replace('.', ',') + ' ' + t('gb') : Math.round(b / 1e6) + ' ' + t('mb');
const fmtDate = d => /^\d{8}$/.test(d || '') ? d.slice(6, 8) + '.' + d.slice(4, 6) + '.' + d.slice(0, 4) : (d || '');
function offlineHtml() {
  if (!off.supported) return `<div class="muted">${t('offNeedApk')}</div>`;
  const dl = off.dl || {}, busy = ['running', 'pending', 'paused'].includes(dl.state), r = off.remote;
  const lines = [];
  lines.push(off.installed ? t('offInstalled', GB(off.size), fmtDate(off.date)) : t('offNotInstalled'));
  if (r) lines.push(t('offRemote', GB(r.size || 0), fmtDate(r.date)));
  else if (off.remoteErr) lines.push(t('offRemoteErr'));
  else lines.push(t('offChecking'));
  let h = `<div class="card"><div>${lines.map(esc).join('<br>')}</div>`;
  if (busy) {
    const pct = dl.total > 0 ? Math.round(dl.done / dl.total * 100) : 0;
    const why = dl.state === 'paused' ? (dl.reason === 3 ? t('offWaitWifi') : dl.reason === 2 ? t('offWaitNet') : t('offPaused')) : dl.state === 'pending' ? t('offPending') : '';
    h += `<div class="muted" style="margin-top:8px">${t('offProgress2', pct, GB(dl.done || 0), GB(dl.total || 0))}${why ? ' · ' + why : ''}</div><div class="prog"><i style="width:${pct}%"></i></div>
      <div class="btns"><button class="btn sm wide" data-act="offCancel">${t('offCancel')}</button></div>`;
  } else {
    if (dl.state === 'failed') h += `<div class="muted" style="margin-top:8px;color:var(--red)">${t('offFailed')}</div>`;
    const newer = r && off.installed && String(r.date) > String(off.date);
    const btns = [];
    if (!off.installed && r) btns.push(`<button class="btn pri" data-act="offDl">${t('offDownload', GB(r.size || 0))}</button>`);
    if (newer) btns.push(`<button class="btn pri" data-act="offDl">${t('offUpdate')}</button>`);
    if (off.installed) btns.push(`<button class="btn" data-act="offDel">${t('delete')}</button>`);
    if (btns.length) h += `<div class="btns">${btns.join('')}</div>`;
    if (r && off.free && off.free < (r.size || 0) + 3e8) h += `<div class="muted" style="margin-top:6px;color:var(--red)">${t('offNoSpace', GB(off.free))}</div>`;
  }
  h += '</div>';
  h += `<div class="list" style="margin-top:8px">${toggleRow('offlineWifi', t('set_offlineWifi'), t('setd_offlineWifi'), S.offlineWifi)}</div>`;
  if (off.installed) h += `<div class="muted" style="margin:10px 2px 6px">${t('setMapMode')}</div>` + seg('mapMode', [['auto', t('mapAuto'), S.mapMode === 'auto'], ['online', t('mapOnline'), S.mapMode === 'online'], ['offline', t('mapOffline'), S.mapMode === 'offline']]);
  h += `<div class="muted" style="margin-top:8px">${t('offRouteNote')}</div>`;
  return h;
}
const LEG = [['food', 'e', 'legFood'], ['fuel', 'f', 'legFuel'], ['park', 'p', 'legPark'], ['motel', 'm', 'legMotel'], ['shower', 'h', 'legShower'], ['cam', 'c', 'legCam']];
function pointsHtml() {
  const on = S.mapStopTypes || {};
  const info = sdb.ready ? t('dbInfo', sdb.count.toLocaleString('uk-UA'), fmtDate(sdb.date)) : t('dbNone');
  return `<div class="list">${toggleRow('mapStops', t('set_mapStops'), info, S.mapStops)}</div>
    <div class="legend" style="margin-top:10px">${LEG.map(([k, ty, lbl]) => `<button data-leg="${k}" class="${on[k] === false ? 'off' : ''}"><span class="sdot" style="background:${TYPES[ty].color}${ty === 'c' ? ';border-color:#e5484d' : ty === 'h' ? ';border-color:#06b6d4' : ''}"></span>${t(lbl)}</button>`).join('')}
      <button disabled><span class="sdot" style="background:var(--red)"></span>${t('legEvent')}</button></div>
    <div class="muted" style="margin-top:6px">${t('legHint')}</div>`;
}
function settingsHtml() {
  const tr = S.truck, num = (id, label, v, step = '0.1') => `<label>${label}<input id="${id}" type="number" inputmode="decimal" step="${step}" value="${v}"></label>`;
  const tog = k => toggleRow(k, t('set_' + k), t('setd_' + k), S[k]);
  const styleOn = STYLES.find(x => x[1] === S.styleUrl);
  return `<div class="sec">${t('secScreen')}</div>
  <div class="muted" style="margin:0 2px 6px">${t('setTheme')}</div>
  ${seg('theme', [['auto', t('themeAuto'), S.theme === 'auto'], ['day', t('themeDay'), S.theme === 'day'], ['night', t('themeNight'), S.theme === 'night']])}
  <div class="muted" style="margin:-4px 2px 10px">${t('themeHint')}</div>
  <div class="muted" style="margin:0 2px 6px">${t('setPassed')}</div>
  ${seg('passed', [['hide', t('passed_hide'), S.passed !== 'grey'], ['grey', t('passed_grey'), S.passed === 'grey']])}
  <div class="muted" style="margin:0 2px 6px">${t('setGlass')}</div>
  ${seg('glass', [['low', t('glass_low'), S.glass === 'low'], ['mid', t('glass_mid'), S.glass === 'mid'], ['high', t('glass_high'), S.glass === 'high'], ['max', t('glass_max'), S.glass === 'max']])}
  <div class="muted" style="margin:-4px 2px 10px">${t('glassHint')}</div>
  <div class="muted" style="margin:0 2px 6px">${t('setMapStyle')}</div>
  ${offlineActive() ? `<div class="muted" style="margin:0 2px 10px">${t('styleOffNote')}</div>` : seg('style', STYLES.map(([k, u]) => [k, t('style_' + k), S.styleUrl === u]))}
  <div class="list">${tog('view3d')}${tog('autoCenter')}${tog('keepAwake')}${tog('routeCats')}</div>

  <div class="sec">${t('secPoints')}</div>
  <div id="ptsSec">${pointsHtml()}</div>

  <div class="sec">${t('secOffline')}</div>
  <div id="offSec">${offlineHtml()}</div>

  <div class="sec">${t('secSound')}</div>
  <div class="list">${tog('voice')}${tog('vibrate')}</div>
  <div class="sec">${t('secVoice')}</div>
  <div id="voiceSec">${voiceHtml()}</div>
  <div class="muted" style="margin:10px 2px 6px">${t('setRate')}</div>
  ${seg('rate', RATES.map(([k, r]) => [k, t('rate_' + k), Math.abs((S.ttsRate || 1) - r) < 0.05]))}
  <div class="btns" style="margin-top:0"><button class="btn wide" data-act="testVoice">${t('testVoice')}</button></div>

  <div class="sec">${t('secNotify')}</div>
  <div class="list">${tog('popups')}${tog('notify')}</div>

  <div class="sec">${t('setLang')}</div>
  ${seg('lang', [['uk', 'Українська', S.lang === 'uk'], ['ru', 'Русский', S.lang === 'ru']])}

  <div class="sec">${t('setTruck')}</div><div class="form">
    ${num('tr_height', t('trHeight'), tr.height)}${num('tr_width', t('trWidth'), tr.width, '0.05')}${num('tr_length', t('trLength'), tr.length)}${num('tr_weight', t('trWeight'), tr.weight, '0.5')}${num('tr_axle', t('trAxle'), tr.axle, '0.5')}${num('tr_vmax', t('trVmax'), tr.vmax, '5')}
    <label>${t('trHazmat')}<select id="tr_hazmat"><option value="0" ${tr.hazmat ? '' : 'selected'}>${t('no')}</option><option value="1" ${tr.hazmat ? 'selected' : ''}>${t('yes')}</option></select></label></div>
  <div class="muted" style="margin-top:6px">${t('setTruckHint')}</div>
  <div class="list" style="margin-top:8px">${tog('heatExempt')}</div>

  <div class="sec">${t('setAhead')}</div><div class="form">
    ${num('s_aheadH', t('setAheadH'), S.aheadH, '0.5')}${num('s_nearKm', t('setNearKm'), S.nearKm, '10')}${num('s_stopKm', t('setStopKm'), S.stopKm, '5')}</div>
  <div class="muted" style="margin-top:6px">${t('setNearHint')}</div>

  <div class="sec">Claude</div><div class="form">
    <label class="full">${t('setKey')}<input id="s_apiKey" type="password" autocomplete="off" value="${esc(S.apiKey)}" placeholder="sk-ant-…"></label>
    <label class="full">${t('setModel')}<select id="s_model">${['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'].map(m => `<option ${S.model === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label></div>
  <div class="muted" style="margin-top:6px">${t('setKeyHint')}</div>

  ${P.isNative ? `<div class="sec">${t('secPerm')}</div><div class="btns" style="margin-top:0"><button class="btn" data-act="appset">${t('openAppSettings')}</button><button class="btn" data-act="locset">${t('openLocSettings')}</button></div><div class="muted" style="margin-top:6px">${t('appSettingsHint')}</div>` : ''}

  <div class="sec">${t('setSources')}</div><div class="form">
    <label class="full">${t('setAlertsToken')}<input id="s_alertsToken" autocomplete="off" value="${esc(S.alertsToken)}"></label>
    <label class="full">${t('setRouteUrl')}<input id="s_routeUrl" autocomplete="off" value="${esc(S.routeUrl)}"></label>
    <label class="full">${t('setStyleUrl')}<input id="s_styleUrl" autocomplete="off" value="${esc(S.styleUrl)}"></label></div>
  <div class="btns"><button class="btn sm" data-act="resetLearn">${t('resetLearn')}</button><button class="btn sm" data-act="clearFeed">${t('clearFeed')}</button></div>
  <div class="btns"><button class="btn sm wide" data-act="about">${t('about')} · ${VERSION.name}</button></div>`;
}
definePanel('settings', {
  title: () => t('settings'),
  render(body) {
    body.innerHTML = settingsHtml();
    body.onclick = e => {
      const row = e.target.closest('[data-tg]'), b = e.target.closest('button');
      const vr = e.target.closest('[data-voice]'); if (vr) { selectVoice(vr.dataset.voice); return; }
      if (b && /^v(Dl|Cancel|Del)$/.test(b.dataset.act || '')) { voiceAct(b); return; }
      if (row) {
        const k = row.dataset.tg; S[k] = !S[k];
        const sw = row.querySelector('.sw'); sw.classList.toggle('on', !!S[k]); sw.setAttribute('aria-checked', !!S[k]);
        if (k === 'keepAwake') P.keepAwake(S.keepAwake);
        if (k === 'view3d' || k === 'autoCenter') setFollow(true);
        if (k === 'voice' && !S.voice) P.stopSpeak();
        if (k === 'vibrate' && S.vibrate) P.vibrate(120);
        if (k === 'mapStops') drawStops();
        return;
      }
      if (!b) return;
      if (b.dataset.leg) {
        const m = { ...(S.mapStopTypes || {}) }; m[b.dataset.leg] = m[b.dataset.leg] === false; S.mapStopTypes = m;
        $('ptsSec').innerHTML = pointsHtml(); return;
      }
      if (b.dataset.seg) {
        const [k, v] = b.dataset.seg.split(':');
        if (k === 'theme') { S.theme = v; applyTheme(); }
        else if (k === 'lang') S.lang = v;
        else if (k === 'glass') S.glass = v;
        else if (k === 'passed') S.passed = v;
        else if (k === 'rate') { S.ttsRate = (RATES.find(r => r[0] === v) || RATES[1])[1]; say(t('voiceTest'), { force: true, urgent: true }); }
        else if (k === 'style') { const u = (STYLES.find(x => x[0] === v) || STYLES[0])[1]; S.styleUrl = u; if (!offlineActive()) setMapStyle(u); }
        else if (k === 'mapMode') { S.mapMode = v; applyMapSource(); }
        const st = body.scrollTop; body.innerHTML = settingsHtml(); body.scrollTop = st;
        return;
      }
      const a = b.dataset.act;
      if (a === 'testVoice') say(t('voiceTest'), { force: true, urgent: true });
      else if (a === 'resetLearn') { resetLearning(); toast(t('done'), 'green', 2500); }
      else if (a === 'clearFeed') { clearFeed(); toast(t('done'), 'green', 2500); }
      else if (a === 'appset') P.openAppSettings();
      else if (a === 'locset') P.openLocationSettings();
      else if (a === 'about') openPanel('about');
      else if (a === 'offDl') { P.offlineDownload(S.offlineWifi); setTimeout(refreshStatus, 800); toast(t('offStarted'), 'green', 6000); }
      else if (a === 'offCancel') { P.offlineCancel(); refreshStatus(); }
      else if (a === 'offDel') { if (b.dataset.sure) { P.offlineDelete(); refreshStatus(); applyMapSource(); } else { b.dataset.sure = '1'; b.textContent = t('offDelSure'); } }
    };
    body.onchange = e => {
      const id = e.target.id || '', v = e.target.value;
      if (id.startsWith('tr_')) {
        const k = id.slice(3), tr = { ...S.truck };
        if (k === 'hazmat') tr.hazmat = v === '1';
        else { const n = parseFloat(String(v).replace(',', '.')); if (!(n > 0) && !(k === 'vmax' && n === 0)) return; tr[k] = n; }   // обмежувач 0 — вимкнено
        S.truck = tr;
      } else if (id.startsWith('s_')) {
        const k = id.slice(2);
        if (['aheadH', 'stopKm', 'nearKm'].includes(k)) { const n = parseFloat(String(v).replace(',', '.')); if (n > 0) S[k] = n; }
        else S[k] = String(v).trim();
        if (k === 'styleUrl' && !offlineActive()) setMapStyle(S.styleUrl);
      }
    };
  }
});

/* =====================  TELEGRAM-КАНАЛИ  ===================== */
function channelsHtml() {
  const list = (S.channels || []).map((c, i) => `<div class="item"><div class="grow"><div class="t">@${esc(c.name)}</div><div class="muted">${c.region === 'all' ? t('allUkraine') : esc(oblastName(c.region)) + ' ' + t('oblast')}${feed.chStatus[c.name] === 'empty' ? ' · ' + t('chEmpty') : feed.chStatus[c.name] === 'err' ? ' · ' + t('errShort') : ''}</div></div>
    <button class="sw${c.on !== false ? ' on' : ''}" data-chsw="${i}" role="switch" aria-checked="${c.on !== false}" aria-label="@${esc(c.name)}"></button><button class="btn sm" data-chdel="${i}" aria-label="${t('delete')}">${ICON.trash}</button></div>`).join('');
  return `<div class="muted">${tgAvailable() ? t('chHint') : t('tgWeb')}</div>
  <div class="sec">${t('chAdd')}</div><div class="form">
    <label class="full">${t('chName')}<input id="chName" autocomplete="off" autocapitalize="off" placeholder="@kanal  або  t.me/kanal"></label>
    <label class="full">${t('chRegion')}<select id="chRegion"><option value="all">${t('allUkraine')}</option>${OBLASTS.map(o => `<option value="${o.id}">${esc(S.lang === 'ru' ? o.ru : o.uk)}</option>`).join('')}</select></label></div>
  <div class="btns"><button class="btn pri wide" data-act="add">${t('add')}</button></div>
  <div class="btns"><button class="btn wide" data-act="defaults">${t('chDefaults')}</button></div>
  <div class="sec">${t('chList')}</div><div class="list">${list || `<div class="muted">${t('chNone')}</div>`}</div>`;
}
definePanel('channels', {
  title: () => t('channels'), back: 'lab', tab: 'lab',
  render(body) {
    body.innerHTML = channelsHtml();
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const list = (S.channels || []).slice();
      if (b.dataset.act === 'defaults') { const n = addDefaultChannels(); toast(n ? t('chAdded', n) : t('chAllThere'), 'green', 3000); openPanel('channels'); return; }
      if (b.dataset.act === 'add') {
        const raw = $('chName').value.trim(), m = raw.match(/(?:t\.me\/(?:s\/)?|@)?([A-Za-z][A-Za-z0-9_]{3,})\/?$/);
        if (!m) { toast(t('chBad'), 'yellow'); return; }
        if (list.some(c => c.name.toLowerCase() === m[1].toLowerCase())) { toast(t('chDup'), 'yellow'); return; }
        list.push({ name: m[1], region: $('chRegion').value, on: true }); S.channels = list; openPanel('channels');
      } else if (b.dataset.chsw != null) { const c = list[+b.dataset.chsw]; c.on = c.on === false; S.channels = list; openPanel('channels'); }
      else if (b.dataset.chdel != null) { list.splice(+b.dataset.chdel, 1); S.channels = list; openPanel('channels'); }
    };
  }
});

/* =====================  GPS  ===================== */
function gpsHtml() {
  const d = debugState(), rows = [];
  if (locState.known) rows.push([t('gpsPhoneLoc'), locState.enabled ? t('on') : t('off')]);
  if (locState.known && locState.fine === false) rows.push([t('gpsPerm'), t('gpsOnlyCoarse')]);
  rows.push([t('gpsMode'), pos.mode === 'gps' ? t('gpsOk') : pos.mode === 'dr' ? t('gpsDr') : pos.mode === 'approx' ? t('gpsApprox') : t('gpsWait')]);
  if (pos.lat != null) rows.push([t('gpsPos'), pos.lat.toFixed(5) + ', ' + pos.lon.toFixed(5)]);
  if (pos.acc != null) rows.push([t('gpsAcc'), '±' + pos.acc + ' ' + t('m')]);
  rows.push([t('gpsSats'), pos.sats ? t('gpsSatsVal', pos.sats.used, pos.sats.vis) + (pos.sats.cn0 != null ? ' · ' + Math.round(pos.sats.cn0) + ' dB-Hz' : '') : locState.listening ? t('gpsSatsNone') : t('gpsNetNo')]);
  if (locState.error) rows.push([t('errShort'), locState.error]);
  rows.push([t('gpsNet'), d.net ? t('gpsNetYes', Math.round(d.net.acc)) : t('gpsNetNo')]);
  rows.push([t('gpsSpoofDet'), (S.spoof ? t('on') : t('off')) + (pos.spoofAt ? ' · ' + t('spoofLast', fmtClock(new Date(pos.spoofAt))) : '')]);
  if (pos.spoofAt) rows.push([t('spoofWhat'), t('spoofWhy_' + pos.spoofWhy) + ' · ' + pos.spoofProv + ' · ' + pos.spoofLat.toFixed(3) + ', ' + pos.spoofLon.toFixed(3) + (pos.spoofSpd != null ? ' · ' + Math.round(pos.spoofSpd * 3.6) + ' ' + t('kmh') : '')]);
  if (pos.mode === 'dr') { rows.push([t('gpsDrTime'), fmtMS((Date.now() - pos.lostSince) / 1000) + ' · ' + Math.round(pos.drDist) + ' ' + t('m')]); rows.push([t('gpsWhy'), lostReason()]); }
  if (gq.t && Date.now() - gq.t < 15000) {
    const f1 = x => x == null ? '—' : x.toFixed(1).replace('.', ',');
    rows.push([t('gpsSignal'), `AGC ${f1(gq.agc)}${gq.agcBase != null ? ' (' + t('gpsNorm') + ' ' + f1(gq.agcBase) + ')' : ''} · C/N0 ${f1(gq.cn0)} · ${t('gq_' + (gq.verdict || 'ok'))}`]);
  }
  if (d.turns) rows.push([t('gpsTurns'), String(d.turns)]);
  const sv = speedView();
  rows.push([t('gpsSpeedSrc'), sv.kind === 'none' ? '—' : Math.round(sv.kmh || 0) + ' ' + t('kmh') + ' · ' + t('spdKind_' + sv.kind) + (sv.kind === 'approx' && d.apSpdErr != null ? ' ±' + Math.round(d.apSpdErr * 3.6 * 2) : '')]);
  const fix = P.isNative ? `<div class="btns">${locState.enabled === false ? `<button class="btn pri wide" data-act="locset">${t('openLocSettings')}</button>` : ''}<button class="btn sm wide" data-act="appset">${t('openAppSettings')}</button></div><div class="muted" style="margin-top:6px">${t('appSettingsHint')}</div>` : '';
  return `<div class="list">${rows.map(r => `<div class="item"><div class="grow muted">${esc(r[0])}</div><div class="t">${esc(r[1])}</div></div>`).join('')}</div>${fix}
    <div class="sec">${t('gpsManual')}</div><div class="muted">${t('gpsManualHint')}</div>
    <div class="muted" style="margin-top:6px">${t('hereHint')}</div>
    <div class="btns">${pos.mode === 'dr' ? `<button class="btn pri wide" data-act="back" ${pos.pending ? '' : 'disabled'}>${t('backToGps')}</button>` : `<button class="btn dark wide" data-act="manual" ${pos.lat == null ? 'disabled' : ''}>${t('gpsManualOn')}</button>`}</div>
    <div class="sec">${t('jSec')}</div><div class="muted">${t('jHint')}</div>
    <div class="btns"><button class="btn wide" data-act="journal">${t('jSave')}</button></div>`;
}
definePanel('gps', {
  title: () => 'GPS', half: true,
  render(body) {
    body.innerHTML = gpsHtml();
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'manual') nudge(0); else if (a === 'back') acceptPending();
      else if (a === 'journal') {
        const j = gpsJournal(), d = new Date(), p2 = n => String(n).padStart(2, '0');
        const name = `reis-gps-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
        if (!P.saveText(name, 'application/json', JSON.stringify(j))) toast(t('saveErr'), 'yellow');
        else if (!P.isNative) toast(t('jSaved', name), 'green', 6000);
      }
      else if (a === 'locset') P.openLocationSettings(); else if (a === 'appset') P.openAppSettings();
      refresh('gps');
    };
  }
});

/* =====================  ДІАГНОСТИКА  ===================== */
let cacheCount = null;
function diagHtml() {
  const d = debugState(), cs = cacheStats(), info = P.appInfo();
  const lines = getLog().slice(-150).map(l => `<span class="${l.level}">${fmtClock(new Date(l.t))} ${esc(l.msg)}</span>`).join('\n');
  return `<div class="list">
    <div class="item"><div class="grow muted">${t('diagVer')}</div><div class="t">${VERSION.name} · web ${VERSION.web}${info.native ? ' · apk ' + esc(info.app) : ' · ' + t('browser')}</div></div>
    <div class="item"><div class="grow muted">${t('diagNet')}</div><div class="t">${P.online() ? t('on') : t('off')}</div></div>
    <div class="item"><div class="grow muted">${t('diagCache')}</div><div class="t">${cacheCount == null ? '…' : cacheCount} · ↓${cs.net} ⟲${cs.hit} ✕${cs.fail}</div></div>
    <div class="item"><div class="grow muted">${t('diagMotion')}</div><div class="t">${d.moving ? t('moving') : t('still')} · ${(d.vCruise * 3.6).toFixed(0)} ${t('kmh')}</div></div>
    <div class="item"><div class="grow muted">${t('diagTrack')}</div><div class="t">${track.pts.length} · ${trackKm().toFixed(1)} км</div></div></div>
  <div class="btns"><button class="btn sm" data-act="copy">${t('copyLog')}</button><button class="btn sm" data-act="gpx">GPX</button><button class="btn sm" data-act="cache">${t('clearCache')}</button></div>
  <div class="sec">${t('diagLog')}</div><div class="log" id="logBox">${lines || '—'}</div>`;
}
definePanel('diag', {
  title: () => t('diag'), back: 'lab', tab: 'lab',
  render(body) {
    body.innerHTML = diagHtml();
    cacheInfo().then(c => { cacheCount = c.count; refresh('diag'); });
    body.onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'copy') {
        const txt = getLog().map(l => new Date(l.t).toISOString() + ' ' + l.level + ' ' + l.msg).join('\n');
        try { await navigator.clipboard.writeText(txt); toast(t('copied'), 'green', 2500); } catch (_) { P.saveText('reis-log.txt', 'text/plain', txt); }
      } else if (b.dataset.act === 'gpx') { const n = exportGpx(); toast(n ? t('recSaved', trackKm().toFixed(1), n) : t('trackEmpty'), n ? 'green' : '', 4000); }
      else if (b.dataset.act === 'cache') { await clearCache(); cacheCount = 0; toast(t('done'), 'green', 2500); refresh('diag'); }
    };
  },
  update(body) { const lb = $('logBox'), st = lb ? lb.scrollTop : 0; body.innerHTML = diagHtml(); const nb = $('logBox'); if (nb) nb.scrollTop = st; }
});

/* =====================  ГОЛОС: телефону або якісний із пакета  ===================== */
// Пакет «uk» (Piper ukrainian_tts) має трьох дикторів: 0 — Лада, 1 — Микита, 2 — Тетяна.
const VOICES = [['system', '', 0, 'vSystem', 'vSystemD'], ['uk:2', 'uk', 2, 'vTetiana'], ['uk:1', 'uk', 1, 'vMykyta'], ['uk:0', 'uk', 0, 'vLada']];
const vst = { dl: null };
const PACK_VER = 2;                                          // v1 читала текст через espeak і звучала невірно — такий пакет оновлюємо
const packOk = st => { const p = st && st.packs && st.packs.uk; return !!p && (p.ver || 0) >= PACK_VER; };
const fmtMB = b => Math.max(1, Math.round((b || 0) / 1e6)) + ' МБ';
export function applyVoice() {
  const v = VOICES.find(x => x[0] === (S.ttsVoice || 'system'));
  if (!v || !v[1] || !packOk(P.voiceStatus())) P.setVoice('', 0, ''); else P.setVoice(v[1], v[2], 'uk');
}
function voiceHtml() {
  if (!P.isNative) return `<div class="muted">${t('vWeb')}</div>`;
  if (!P.hasVoices()) return `<div class="muted">${t('vOldShell')}</div>`;
  const st = P.voiceStatus() || {}, cur = S.ttsVoice || 'system', old = st.packs && st.packs.uk && !packOk(st), have = packOk(st) && st.packs.uk;
  const dl = vst.dl || (st.dl && st.dl.pack === 'uk' ? { pct: st.dl.pct } : null);
  const rows = VOICES.map(([id, pack, , nk, dk]) => `<button class="vrow${cur === id ? ' on' : ''}" data-voice="${id}" aria-pressed="${cur === id}"><i class="vdot"></i><span class="grow"><b>${t(nk)}</b><small>${pack ? t('vNeuralD') + (have ? '' : ' · ' + t('vNeedPack')) : t(dk)}</small></span></button>`).join('');
  let pk;
  if (dl) pk = `<div class="vbar"><i style="width:${Math.max(3, dl.pct)}%"></i></div><div class="vdl"><span class="muted">${dl.unzip ? t('vUnzip') : t('vDlNow', dl.pct >= 0 ? dl.pct + '%' : '')}</span><button class="btn sm" data-act="vCancel">${t('vCancel')}</button></div>`;
  else if (have) pk = `<div class="vdl"><span class="muted">${t('vPackHave', fmtMB(have.size))}</span><button class="btn sm" data-act="vDel">${t('vDel')}</button></div>`;
  else pk = `<div class="muted">${old ? t('vPackOld') : t('vPackSize')}</div><div class="btns"><button class="btn pri wide" data-act="vDl">${old ? t('vPackUpd') : t('vDl')}</button></div>`;
  return `<div class="list vlist">${rows}</div><div class="card vpack"><b>${t('vPack')}</b>${pk}</div>` +
    (S.lang === 'ru' ? `<div class="muted" style="margin-top:6px">${t('vUkOnly')}</div>` : '') + (st.lib === false ? `<div class="muted" style="margin-top:6px;color:var(--red)">${t('vEngine')}</div>` : '');
}
function voiceRefresh() { const el = $('voiceSec'); if (el) el.innerHTML = voiceHtml(); }
function voiceDl(pack) { vst.dl = { pct: 0 }; if (!P.voiceDownload(pack)) vst.dl = null; voiceRefresh(); }
function selectVoice(id) {
  const v = VOICES.find(x => x[0] === id); if (!v) return;
  S.ttsVoice = id; applyVoice();
  const st = P.voiceStatus() || {};
  if (v[1] && !packOk(st)) { if (!vst.dl && !(st.dl && st.dl.pack)) voiceDl(v[1]); }
  else setTimeout(() => say(t('voiceTest'), { force: true, urgent: true }), v[1] ? 600 : 0);
  voiceRefresh();
}
function voiceAct(b) {
  const a = b.dataset.act;
  if (a === 'vDl') voiceDl('uk');
  else if (a === 'vCancel') P.voiceCancel();
  else if (a === 'vDel') { if (b.dataset.sure) P.voiceDelete('uk'); else { b.dataset.sure = '1'; b.textContent = t('vDelSure'); } }
}

/* =====================  ПРО ЗАСТОСУНОК І ОНОВЛЕННЯ  ===================== */
export const upd = { state: 'idle', apk: null, web: null, error: '', webReady: false, webName: '', apkSt: '', pct: -1, checkedAt: 0 };
function aboutHtml() {
  const info = P.appInfo();
  let u = '';
  if (!info.native) u = `<div class="muted">${t('updWeb')}</div>`;
  else if (upd.state === 'checking') u = `<div class="muted">${t('updChecking')}</div>`;
  else if (upd.state === 'error') u = `<div class="muted">${t('updError')} ${esc(upd.error)}</div>`;
  else if (upd.state === 'done') u = (upd.apk ? `<div class="card">${t('updApk', esc(upd.apk.name))}<div class="btns"><button class="btn pri wide" data-act="apk">${t('updInstall')}</button></div></div>` : '')
    + (upd.web ? `<div class="card" style="margin-top:8px">${t('updWebNew', upd.web.ver)}</div>` : '') + (!upd.apk && !upd.web ? `<div class="muted">${t('updNone')}</div>` : '');
  return `<div class="card"><b style="font:800 34px var(--f-num)">РЕЙС</b><div class="muted">${t('aboutText')}</div>
    <div style="margin-top:8px">${t('diagVer')}: ${VERSION.name} · web ${VERSION.web}${info.native ? ' · apk ' + esc(info.app) + ' (' + info.code + ')' : ''}</div></div>
  <div class="sec">${t('updSec')}</div>${u}
  ${info.native ? `<div class="btns"><button class="btn wide" data-act="check">${t('updCheck')}</button></div>` : ''}
  <div class="sec">${t('aboutData')}</div><div class="muted">${t('aboutSources')}</div>`;
}
definePanel('about', {
  title: () => t('about'), back: 'settings',
  render(body) {
    body.innerHTML = aboutHtml();
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'check') { upd.state = 'checking'; refresh('about'); if (!P.checkUpdate()) { upd.state = 'error'; upd.error = ''; refresh('about'); } }
      else if (b.dataset.act === 'apk') updApk();
    };
  }
});
export function initLab() {
  bus.on('stopsdb', () => { const el = $('ptsSec'); if (el) el.innerHTML = pointsHtml(); });
  bus.on('offline', () => { const el = $('offSec'); if (el) el.innerHTML = offlineHtml(); });
  bus.on('settings', k => { if (k === 'lang' && offlineActive()) applyMapSource(); });
  bus.on('sim', () => refresh('lab'));
  bus.on('rough', () => refresh('lab'));
  bus.on('pos', () => refresh('gps'));
  bus.on('log', () => refresh('diag'));
  bus.on('native:update', d => {
    upd.state = d.error ? 'error' : 'done'; upd.error = d.error || ''; upd.checkedAt = Date.now();
    if (!d.error) { upd.apk = d.apk || null; if (!upd.apk) upd.apkSt = ''; }
    refresh('about');
    if (d.web && !upd.webReady) { upd.web = d.web; P.applyWebUpdate(); }      // інтерфейс завантажуємо самі, у фоні
    updBar();
  });
  bus.on('native:webUpdated', d => {
    if (!(d && d.ok)) { log('warn', 'оновлення інтерфейсу: ' + ((d && d.error) || '')); return; }
    upd.webReady = true; upd.webName = (upd.web && upd.web.name) || ''; updBar();
    if (!P.canReloadUi()) return;
    // Перезапускаємось самі, коли спокійно: без активного рейсу, не без GPS і не в зоні підміни (там місце й швидкість — у пам'яті).
    // Раніше — коли водій сам торкнеться плашки.
    const calm = () => !g.active && pos.mode !== 'dr' && Date.now() - (pos.spoofAt || 0) > 10 * 60000;
    if (calm()) { updReload(); return; }
    clearInterval(calmTimer); calmTimer = setInterval(() => { if (calm()) { clearInterval(calmTimer); updReload(); } }, 20000);
  });
  bus.on('native:voice', d => {
    const s = d && d.state;
    if (s === 'dl') vst.dl = { pct: d.pct };
    else if (s === 'unzip') vst.dl = { pct: 92, unzip: true };
    else if (s === 'ready') { vst.dl = null; applyVoice(); toast(t('vReady'), 'green', 5000); if ((S.ttsVoice || 'system') !== 'system') setTimeout(() => say(t('voiceTest'), { force: true, urgent: true }), 1800); }
    else if (s === 'error' || s === 'cancel') { vst.dl = null; if (s === 'error') toast(t('vErr', d.error === 'space' ? t('vNoSpace') : (d.error || '')), 'yellow', 8000); }
    else if (s === 'deleted') vst.dl = null;
    else if (s === 'fallback') log('warn', 'якісний голос не спрацював: ' + (d.error || ''));
    else if (s === 'loaded') log('info', `голос завантажено в памʼять за ${d.ms} мс`);
    voiceRefresh();
  });
  applyVoice();
  bus.on('native:apk', d => {
    upd.apkSt = d.state || ''; if (d.pct != null) upd.pct = d.pct; if (d.error) { upd.error = d.error; log('warn', 'оновлення APK: ' + d.error); }
    updBar();
  });
  $('updGo').onclick = updTap;
  $('updX').onclick = () => { try { localStorage.setItem('reis.updHide', JSON.stringify({ k: updKey(), until: Date.now() + 3 * 3600e3 })); } catch (_) {} updBar(true); };
  $('updX').innerHTML = ICON.x; $('updX').setAttribute('aria-label', t('ubHide'));
  // повернулися з налаштувань («дозволити встановлення») — одразу встановлюємо; давно не перевіряли — перевіряємо
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (upd.apkSt === 'perm') setTimeout(() => P.installApk(), 400);
    if (Date.now() - upd.checkedAt > UPD_EVERY) updCheck();
  });
  bus.on('settings', k => { if (k === 'lang') updBar(); });
  if (P.isNative) setInterval(() => { if (Date.now() - upd.checkedAt > UPD_EVERY - 60000) updCheck(); }, 5 * 60000);
  bus.on('native:saved', d => { if (d && d.error) toast(t('saveErr') + ' ' + d.error, 'yellow'); else if (d && /^reis-gps/.test(d.name || '')) toast(t('jSaved', d.path || d.name), 'green', 9000); });
  if (P.isNative) setTimeout(updCheck, 15000);
}

/* ---------- плашка оновлення внизу: «Нова версія — оновити» ---------- */
// Перевіряємо при запуску і кожні 30 хв. Інтерфейс (web.zip) завантажується сам і ставиться, коли спокійно або коли водій торкнеться;
// новий APK (лише коли змінилася сама оболонка) завантажуємо в телефоні й відкриваємо системне «Встановити».
const UPD_EVERY = 30 * 60000;
let calmTimer = 0;
function updCheck() { if (!P.isNative || !P.online()) return; upd.checkedAt = Date.now(); P.checkUpdate(); }
const inApp = () => !!P.appInfo().inst;                                // оболонка вміє сама завантажити й поставити APK
const updKey = () => upd.apk ? 'apk' + upd.apk.code : upd.webReady ? 'web' + ((upd.web && upd.web.ver) || '') : '';
function updHidden() { try { const h = JSON.parse(localStorage.getItem('reis.updHide') || 'null'); return !!h && h.k === updKey() && Date.now() < h.until; } catch (_) { return false; } }
function updReload() { toast(t('updWebNow'), 'green', 4000); setTimeout(() => P.reloadUi(), 1200); }
function updApk() {
  if (inApp()) { upd.apkSt = 'dl'; upd.pct = 0; P.installApk(); }
  else { upd.apkSt = 'browser'; P.installApk(); }                        // стара оболонка: завантаження браузером
  updBar();
}
function updTap() {
  if (upd.apk) {
    if (upd.apkSt === 'dl') return;
    if (upd.apkSt === 'error' || upd.apkSt === 'browser') { upd.apkSt = 'browser'; P.apkInBrowser(); updBar(); return; }
    updApk(); return;
  }
  if (upd.webReady) { if (P.canReloadUi()) updReload(); else toast(t('updWebDone'), 'green', 6000); }
}
export function updBar(hideNow) {
  const bar = $('updBar'), go = $('updGo'); if (!bar) return;
  let text = '', busy = false;
  if (upd.apk) {
    const st = upd.apkSt;
    if (st === 'dl') { text = t('ubDl', upd.pct >= 0 ? upd.pct + '%' : ''); busy = true; }
    else if (st === 'perm') text = t('ubPerm');
    else if (st === 'install') text = t('ubInstall');
    else if (st === 'error') text = t('ubErr');
    else if (st === 'browser') text = t('ubBrowser');
    else text = t('ubApk', String(upd.apk.name || '').split('.').slice(0, 3).join('.'));
  } else if (upd.webReady) text = t('ubWeb', upd.webName ? ' ' + upd.webName : '');
  const show = !!text && !(hideNow === true || (!busy && updHidden()));
  go.innerHTML = `${ICON.up}<span>${esc(text)}</span>`;
  bar.classList.toggle('busy', busy); bar.style.setProperty('--p', Math.max(0, upd.pct) + '%');
  if (bar.hidden === show) { bar.hidden = !show; bus.emit('layout'); }
}
