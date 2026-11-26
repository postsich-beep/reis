// (1.1.33) Вікно «Модуль OBD»: угорі — назва, стан зв'язку й перемикач «увімк./вимк.» (зелений), посередині — показання машини
// за групами (без показань — сірі «—»), унизу — «Назад». Відкривається значком «OBD» у заголовку швидких налаштувань.
// (1.1.35) Пристрій зчитування не підключено — перемикач неактивний і написано «Підключіть пристрій зчитування».
import { bus, S } from './core.js';
import { $, ICON, esc } from './ui_base.js';
import { t } from './i18n.js';
import * as obd from './obd.js';

export const OBD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5h17l-2.2 9H5.7z"/><path d="M7.6 10.6h.8M11.6 10.6h.8M15.6 10.6h.8M9.6 13.4h.8M13.6 13.4h.8"/></svg>';
let open = false;

// стан для значка у швидких налаштуваннях: { on — зелений (пристрій підключено й модуль увімкнено), txt — підпис для читача екрана }
export function tileState() {
  if (obd.isOn()) return { on: true, txt: t('obdTileOk') };
  return { on: false, txt: t(obd.st.conn ? 'obdTileOff' : 'obdTileNo') };
}

function statusHtml() {
  const ok = obd.linkOk(), on = obd.isOn(), conn = obd.st.conn, dev = esc(obd.st.dev || t('obdDev'));
  // пристрою немає — «підключіть пристрій зчитування»; є, але вимкнено — «увімкніть перемикач»; увімкнено без показань — «увімкніть запалювання»
  const head = obd.st.demo ? t('obdDemoHead') : !conn ? t('obdNoDev') : !on ? t('obdOffHead', dev) : t('obdOk', dev);
  const why = obd.st.demo ? t('obdDemoText') : !conn ? t('obdNoDevText') + (obd.supported() ? '' : ' ' + t('obdNoSup')) : !on ? t('obdOffText') : ok ? '' : t('obdNoData');
  return `<div class="obd-st ${ok ? 'ok' : obd.st.demo ? 'demo' : on ? 'wait' : 'no'}"><i class="obd-dot"></i><div><b>${head}</b>${why ? `<small>${why}</small>` : ''}</div></div>`;
}
function rowsHtml() {
  const now = Date.now(), live = obd.linkOk() || obd.st.demo;
  return obd.GROUPS.map(g => `<div class="obd-g"><div class="obd-gh">${t('obdG_' + g)}</div>` + obd.PARAMS.filter(p => p.g === g).map(p => {
    const v = live ? obd.fresh(p.k, now) : null;
    return `<div class="obd-r${v == null ? ' na' : ''}" data-k="${p.k}"><span>${t('obdP_' + p.k)}</span><b>${obd.fmt(p, v)}</b></div>`;
  }).join('') + `</div>`).join('');
}
function html() {
  const on = obd.isOn(), conn = obd.st.conn;
  return `<div class="obd-head"><span class="obd-ic">${OBD_ICON}</span><h2>${t('obdTitle')}</h2>
      <button class="obd-sw${on ? ' on' : ''}${conn ? '' : ' dis'}" data-obd="sw" role="switch" aria-checked="${on}" aria-disabled="${!conn}" aria-label="${t(conn ? 'obdSwitch' : 'obdSwitchNo')}"><span>${t(on ? 'obdSwOn' : 'obdSwOff')}</span><i></i></button></div>
    <div class="obd-body" id="obdBody">${statusHtml()}
      ${!obd.linkOk() && !obd.st.demo ? `<button class="obd-demo" data-obd="demo">${t('obdDemoBtn')}</button>` : obd.st.demo ? `<button class="obd-demo" data-obd="demo0">${t('obdDemoOff')}</button>` : ''}
      <div class="obd-rows" id="obdRows">${rowsHtml()}</div>
      <div class="obd-legal"><b>${t('obdLegalTitle')}</b>${t('obdLegal')}</div></div>
    <div class="obd-foot"><button class="btn obd-back" data-obd="back">${ICON.arrowL}<span>${t('obdBack')}</span></button></div>`;
}
function draw(full = true) {
  const box = $('obdBox'); if (!box || !open) return;
  if (full) { const st = ($('obdBody') || {}).scrollTop || 0; box.innerHTML = html(); const b = $('obdBody'); if (b) b.scrollTop = st; return; }
  // часте оновлення показань — лише значення, без перемальовування всього вікна
  const now = Date.now(), live = obd.linkOk() || obd.st.demo;
  for (const r of box.querySelectorAll('.obd-r')) { const p = obd.PARAMS.find(x => x.k === r.dataset.k), v = live ? obd.fresh(p.k, now) : null, s = obd.fmt(p, v), b = r.querySelector('b'); if (b.textContent !== s) b.textContent = s; r.classList.toggle('na', v == null); }
}
let lastKey = '';
const stateKey = () => [obd.st.conn, obd.isOn(), obd.st.link, obd.linkOk(), obd.st.demo, obd.st.dev].join('|');
export function openObd() {
  const box = $('obdBox'); if (!box) return;
  open = true; box.hidden = false; document.body.classList.add('obd-on'); lastKey = stateKey(); draw(true);
}
export function closeObd() {
  if (!open) return; open = false;
  if (obd.st.demo) obd.demo(false);                 // приклад — лише поки вікно відкрите
  const box = $('obdBox'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('obd-on');
  bus.emit('obdClosed');
}
export const obdOpen = () => open;
function onClick(e) {
  const b = e.target.closest('[data-obd]'); if (!b) return;
  const k = b.dataset.obd;
  if (k === 'back') { closeObd(); return; }
  if (k === 'sw') {
    // без пристрою перемикач не діє: підказуємо, що зробити (рядок стану блимає)
    if (!obd.setOn(!obd.isOn())) { const s = $('obdBox').querySelector('.obd-st'); if (s) { s.classList.remove('nudge'); void s.offsetWidth; s.classList.add('nudge'); } }
    return;
  }
  if (k === 'demo') { obd.demo(true); return; }
  if (k === 'demo0') { obd.demo(false); return; }
}
export function initObdUi() {
  obd.init();
  $('obdBox').addEventListener('click', onClick);
  bus.on('obd', () => { if (!open) return; const k = stateKey(); if (k !== lastKey) { lastKey = k; draw(true); } else draw(false); });
  // системна «Назад» — закриває вікно
  const prev = window.__reisBack;
  window.__reisBack = () => { if (open) { closeObd(); return true; } return prev ? prev() : false; };
}
