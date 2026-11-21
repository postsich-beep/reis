// Панелі «Лабораторія», «Налаштування», «Telegram-канали», «GPS», «Діагностика», «Про застосунок».
import { bus, log, getLog, S, VERSION, fmtClock, fmtMS } from './core.js';
import * as P from './platform.js';
import { pos, nudge, acceptPending, debugState } from './nav.js';
import { g, say } from './guide.js';
import { feed, resetLearning, clearFeed, tgAvailable, addDefaultChannels } from './feed.js';
import { OBLASTS, oblastName } from './route.js';
import { cacheInfo, clearCache, cacheStats, setMapStyle, applyTheme, setFollow } from './map.js';
import { sim, start as simStart, stop as simStop, setLost, setSpoof, setSpeed } from './sim.js';
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
const SOON = ['obd', 'camera', 'mesh', 'localAi', 'fullMap', 'traffic'];
function simHtml() {
  const can = !!g.idx;
  return `<div class="card"><div class="muted">${can ? t('simHint') : t('simNeedTrip')}</div>
    <div class="btns"><button class="btn ${sim.on ? 'danger' : 'dark'}" data-sim="toggle" ${can ? '' : 'disabled'}>${sim.on ? t('simStop') : t('simStart')}</button>
      <select class="inp" id="simSpd" style="flex:1;margin:0" aria-label="${t('simSpeed')}">${[40, 70, 90, 300].map(k => `<option value="${k}" ${sim.kmh === k ? 'selected' : ''}>${k === 300 ? t('simFast') : k + ' ' + t('kmh')}</option>`).join('')}</select></div>
    <div class="btns"><button class="btn sm${sim.lost ? ' danger' : ''}" data-sim="lost" ${sim.on ? '' : 'disabled'}>${sim.lost ? t('simLostOff') : t('simLost')}</button>
      <button class="btn sm${sim.spoof ? ' danger' : ''}" data-sim="spoof" ${sim.on ? '' : 'disabled'}>${sim.spoof ? t('simSpoofOff') : t('simSpoof')}</button></div></div>`;
}
function labHtml() {
  let h = '';
  for (const [k, v] of TG) {
    if (k === 'sec') { h += `</div><div class="sec">${t(v)}</div><div class="list">`; continue; }
    h += toggleRow(k, t('tg_' + k), t('tgd_' + k, k === 'stops' ? S.stopKm : k === 'lookahead' ? S.aheadH : ''), S[k]);
  }
  h = h.replace(/^<\/div>/, '') + '</div>';
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
      else if (b.dataset.sim === 'toggle') { if (sim.on) simStop(); else if (!simStart()) toast(t('simNeedTrip'), 'yellow'); }
      else if (b.dataset.sim === 'lost') setLost(!sim.lost);
      else if (b.dataset.sim === 'spoof') setSpoof(!sim.spoof);
    };
    body.onchange = e => { if (e.target.id === 'simSpd') setSpeed(+e.target.value); };
  },
  update() { const b = $('simBox'); if (b) b.innerHTML = simHtml(); }
});

/* =====================  НАЛАШТУВАННЯ  ===================== */
const STYLES = [['liberty', 'https://tiles.openfreemap.org/styles/liberty'], ['bright', 'https://tiles.openfreemap.org/styles/bright'], ['positron', 'https://tiles.openfreemap.org/styles/positron']];
const RATES = [['slow', 0.85], ['normal', 1], ['fast', 1.2]];
const seg = (key, opts) => `<div class="seg">${opts.map(([v, label, on]) => `<button data-seg="${key}:${v}" class="${on ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
function settingsHtml() {
  const tr = S.truck, num = (id, label, v, step = '0.1') => `<label>${label}<input id="${id}" type="number" inputmode="decimal" step="${step}" value="${v}"></label>`;
  const tog = k => toggleRow(k, t('set_' + k), t('setd_' + k), S[k]);
  const styleOn = STYLES.find(x => x[1] === S.styleUrl);
  return `<div class="sec">${t('secScreen')}</div>
  <div class="muted" style="margin:0 2px 6px">${t('setTheme')}</div>
  ${seg('theme', [['auto', t('themeAuto'), S.theme === 'auto'], ['day', t('themeDay'), S.theme === 'day'], ['night', t('themeNight'), S.theme === 'night']])}
  <div class="muted" style="margin:-4px 2px 10px">${t('themeHint')}</div>
  <div class="muted" style="margin:0 2px 6px">${t('setMapStyle')}</div>
  ${seg('style', STYLES.map(([k, u]) => [k, t('style_' + k), S.styleUrl === u]))}
  <div class="list">${tog('view3d')}${tog('autoCenter')}${tog('keepAwake')}</div>

  <div class="sec">${t('secSound')}</div>
  <div class="list">${tog('voice')}${tog('vibrate')}</div>
  <div class="muted" style="margin:10px 2px 6px">${t('setRate')}</div>
  ${seg('rate', RATES.map(([k, r]) => [k, t('rate_' + k), Math.abs((S.ttsRate || 1) - r) < 0.05]))}
  <div class="btns" style="margin-top:0"><button class="btn wide" data-act="testVoice">${t('testVoice')}</button></div>

  <div class="sec">${t('secNotify')}</div>
  <div class="list">${tog('popups')}${tog('notify')}</div>

  <div class="sec">${t('setLang')}</div>
  ${seg('lang', [['uk', 'Українська', S.lang === 'uk'], ['ru', 'Русский', S.lang === 'ru']])}

  <div class="sec">${t('setTruck')}</div><div class="form">
    ${num('tr_height', t('trHeight'), tr.height)}${num('tr_width', t('trWidth'), tr.width, '0.05')}${num('tr_length', t('trLength'), tr.length)}${num('tr_weight', t('trWeight'), tr.weight, '0.5')}${num('tr_axle', t('trAxle'), tr.axle, '0.5')}
    <label>${t('trHazmat')}<select id="tr_hazmat"><option value="0" ${tr.hazmat ? '' : 'selected'}>${t('no')}</option><option value="1" ${tr.hazmat ? 'selected' : ''}>${t('yes')}</option></select></label></div>
  <div class="muted" style="margin-top:6px">${t('setTruckHint')}</div>

  <div class="sec">${t('setAhead')}</div><div class="form">
    ${num('s_aheadH', t('setAheadH'), S.aheadH, '0.5')}${num('s_stopKm', t('setStopKm'), S.stopKm, '5')}</div>

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
      if (row) {
        const k = row.dataset.tg; S[k] = !S[k];
        const sw = row.querySelector('.sw'); sw.classList.toggle('on', !!S[k]); sw.setAttribute('aria-checked', !!S[k]);
        if (k === 'keepAwake') P.keepAwake(S.keepAwake);
        if (k === 'view3d' || k === 'autoCenter') setFollow(true);
        if (k === 'voice' && !S.voice) P.stopSpeak();
        if (k === 'vibrate' && S.vibrate) P.vibrate(120);
        return;
      }
      if (!b) return;
      if (b.dataset.seg) {
        const [k, v] = b.dataset.seg.split(':');
        if (k === 'theme') { S.theme = v; applyTheme(); }
        else if (k === 'lang') S.lang = v;
        else if (k === 'rate') { S.ttsRate = (RATES.find(r => r[0] === v) || RATES[1])[1]; say(t('voiceTest'), { force: true, urgent: true }); }
        else if (k === 'style') { const u = (STYLES.find(x => x[0] === v) || STYLES[0])[1]; S.styleUrl = u; setMapStyle(u); }
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
    };
    body.onchange = e => {
      const id = e.target.id || '', v = e.target.value;
      if (id.startsWith('tr_')) {
        const k = id.slice(3), tr = { ...S.truck };
        if (k === 'hazmat') tr.hazmat = v === '1'; else { const n = parseFloat(String(v).replace(',', '.')); if (!(n > 0)) return; tr[k] = n; }
        S.truck = tr;
      } else if (id.startsWith('s_')) {
        const k = id.slice(2);
        if (['aheadH', 'stopKm'].includes(k)) { const n = parseFloat(String(v).replace(',', '.')); if (n > 0) S[k] = n; }
        else S[k] = String(v).trim();
        if (k === 'styleUrl') setMapStyle(S.styleUrl);
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
  if (pos.mode === 'dr') { rows.push([t('gpsDrTime'), fmtMS((Date.now() - pos.lostSince) / 1000) + ' · ' + Math.round(pos.drDist) + ' ' + t('m')]); rows.push([t('gpsWhy'), lostReason()]); }
  const fix = P.isNative ? `<div class="btns">${locState.enabled === false ? `<button class="btn pri wide" data-act="locset">${t('openLocSettings')}</button>` : ''}<button class="btn sm wide" data-act="appset">${t('openAppSettings')}</button></div><div class="muted" style="margin-top:6px">${t('appSettingsHint')}</div>` : '';
  return `<div class="list">${rows.map(r => `<div class="item"><div class="grow muted">${esc(r[0])}</div><div class="t">${esc(r[1])}</div></div>`).join('')}</div>${fix}
    <div class="sec">${t('gpsManual')}</div><div class="muted">${t('gpsManualHint')}</div>
    <div class="muted" style="margin-top:6px">${t('hereHint')}</div>
    <div class="btns">${pos.mode === 'dr' ? `<button class="btn pri wide" data-act="back" ${pos.pending ? '' : 'disabled'}>${t('backToGps')}</button>` : `<button class="btn dark wide" data-act="manual" ${pos.lat == null ? 'disabled' : ''}>${t('gpsManualOn')}</button>`}</div>`;
}
definePanel('gps', {
  title: () => 'GPS', half: true,
  render(body) {
    body.innerHTML = gpsHtml();
    body.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'manual') nudge(0); else if (a === 'back') acceptPending();
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

/* =====================  ПРО ЗАСТОСУНОК І ОНОВЛЕННЯ  ===================== */
const upd = { state: 'idle', apk: null, web: null, error: '' };
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
      else if (b.dataset.act === 'apk') P.installApk();
    };
  }
});
export function initLab() {
  bus.on('sim', () => refresh('lab'));
  bus.on('pos', () => refresh('gps'));
  bus.on('log', () => refresh('diag'));
  bus.on('native:update', d => {
    upd.state = d.error ? 'error' : 'done'; upd.error = d.error || ''; upd.apk = d.apk || null; upd.web = d.web || null;
    refresh('about');
    if (d.web) { P.applyWebUpdate(); }
    if (d.apk) toast(t('updApk', d.apk.name), 'green', 9000, () => openPanel('about'));
  });
  bus.on('native:webUpdated', d => { toast(d && d.ok ? t('updWebDone') : t('updError'), d && d.ok ? 'green' : 'yellow', 7000); });
  bus.on('native:saved', d => { if (d && d.error) toast(t('saveErr') + ' ' + d.error, 'yellow'); });
  if (P.isNative) setTimeout(() => { if (P.online()) P.checkUpdate(); }, 15000);
}
