// Екран «Калібрування телефона» (1.1.22): на весь екран, три кроки й результат. Логіка замірів — calib.js.
// Телефон тримають вертикально, як у тримачі; на екрані — телефон, що повертається разом зі справжнім, шкала з ціллю 90°
// і великий підпис, що робити зараз. Коли телефон повернуто «ребром», екрана не видно — тому кожен крок підтверджується
// звуком, вібрацією й голосом.
import { S, bus } from './core.js';
import * as P from './platform.js';
import { ms } from './sensors.js';
import { newCal, calSave, calGet, calFresh, CAL } from './calib.js';
import { chime } from './sfx.js';
import { say } from './guide.js';
import { $, ICON, esc } from './ui_base.js';
import { t } from './i18n.js';

let cal = null, raf = 0, lastStep = 0, noSensT = 0, view = '';
const fmt1 = n => String(Math.round(n * 10) / 10).replace('.', ',');
const speak = text => { try { say(text, { urgent: true }); } catch (_) {} };

/* ---------- шкала (вид згори): 0° — прямо, ліворуч і праворуч по 90°; ціль підсвічено; стрілка — як стоїть телефон зараз ---------- */
const pt = (deg, r) => { const a = (deg - 90) * Math.PI / 180; return [(r * Math.cos(a)).toFixed(1), (r * Math.sin(a)).toFixed(1)]; };
const arc = (a0, a1, r) => { const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r); return `M${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}`; };
function dialSvg(step) {
  const target = step === 2 ? -90 : step === 3 ? 90 : null, ticks = [];
  for (let a = -120; a <= 120; a += 15) { const big = a % 45 === 0, [x0, y0] = pt(a, big ? 82 : 86), [x1, y1] = pt(a, 94); ticks.push(`<path d="M${x0} ${y0}L${x1} ${y1}" class="${big ? 'cb-tk big' : 'cb-tk'}"/>`); }
  const lab = (a, s) => { const [x, y] = pt(a, 110); return `<text x="${x}" y="${y}" class="cb-lb${a === target ? ' on' : ''}">${s}</text>`; };
  return `<svg class="cb-dial" viewBox="-132 -128 264 156" aria-hidden="true">
    <path d="${arc(-120, 120, 94)}" class="cb-ring"/>
    ${target != null ? `<path d="${arc(target - 16, target + 16, 94)}" class="cb-goal"/>` : ''}
    ${ticks.join('')}${lab(-90, '90°')}${lab(0, '0°')}${lab(90, '90°')}
    <g id="cbNeedle"><path d="M0 0L0 -78" class="cb-nd"/><path d="M-7 -70L0 -88L7 -70Z" class="cb-nh"/></g>
    <circle r="7" class="cb-hub"/>
  </svg>`;
}

function shellHtml() {
  const stepLi = (n, key) => `<li data-s="${n}"><b>${n}</b><span>${t(key)}</span></li>`;
  return `<div class="cb-head"><b>${t('cbTitle')}</b><button class="cb-x" data-cb="x" aria-label="${t('close')}">${ICON.x}</button></div>
    <ol class="cb-steps">${stepLi(1, 'cbS1')}${stepLi(2, 'cbS2')}${stepLi(3, 'cbS3')}<li data-s="4" class="fin">${ICON.check}<span>${t('cbS4')}</span></li></ol>
    <div class="cb-body" id="cbBody"></div>
    <div class="cb-foot">${t('cbWhy')}</div>`;
}
function stageHtml(step) {
  return `<div class="cb-stage">
      <div class="cb-ph3d"><div class="cb-phone" id="cbPhone"><i></i><u></u></div>${step > 1 ? `<div class="cb-ghost ${step === 2 ? 'l' : 'r'}"></div>` : ''}</div>
      ${dialSvg(step)}
      <div class="cb-ang" id="cbAng">${step === 1 ? '' : '0°'}</div>
    </div>
    <div class="cb-title" id="cbTitle">${t('cbT' + step)}</div>
    <div class="cb-text" id="cbText">${t('cbD' + step)}</div>
    <div class="cb-prog"><i id="cbProg"></i></div>
    <div class="cb-hint" id="cbHint"></div>`;
}
function resultHtml(r) {
  const pose = r.pose ? t('cbPose_' + r.pose.kind, r.pose.lean) : '';
  if (r.ok) return `<div class="cb-res ok"><div class="cb-big">${ICON.check}</div><div class="cb-title">${t('cbOkTitle')}</div>
      <div class="cb-rows"><div><span>${t('cbRSeen')}</span><b>${fmt1(r.seen90)}°</b></div><div><span>${t('cbRFix')}</span><b>${r.pct > 0 ? '+' : ''}${fmt1(r.pct)} %</b></div>
        <div><span>${t('cbRBias')}</span><b>${fmt1(Math.abs(r.bias) < 0.005 ? 0 : r.bias)} °/с</b></div>${pose ? `<div><span>${t('cbRPose')}</span><b>${esc(pose)}</b></div>` : ''}</div>
      <div class="cb-text">${t('cbOkText')}</div>
      <div class="cb-btns"><button class="btn pri wide" data-cb="save">${t('plDone')}</button><button class="btn wide" data-cb="again">${t('cbAgain')}</button></div></div>`;
  return `<div class="cb-res bad"><div class="cb-big">!</div><div class="cb-title">${t('cbBadTitle')}</div>
      <div class="cb-text">${t('cbBad_' + r.why, fmt1(r.left), fmt1(r.right), fmt1(Math.abs(r.bias)))}</div>
      <div class="cb-btns"><button class="btn pri wide" data-cb="again">${t('cbAgain')}</button><button class="btn wide" data-cb="x">${t('close')}</button></div></div>`;
}
function setSteps(step) {
  for (const li of document.querySelectorAll('#calib .cb-steps li')) { const n = +li.dataset.s; li.classList.toggle('cur', n === step); li.classList.toggle('done', n < step || (step === 4 && n === 4)); }
}
function show(step) {
  view = 'step' + step; setSteps(step);
  $('cbBody').innerHTML = step === 4 ? resultHtml(cal.st.result) : stageHtml(step);
}
function noSensors() {
  view = 'nosens'; setSteps(0);
  $('cbBody').innerHTML = `<div class="cb-res bad"><div class="cb-big">!</div><div class="cb-title">${t('cbNoSensTitle')}</div><div class="cb-text">${t('cbNoSensText')}</div>
    <div class="cb-btns"><button class="btn pri wide" data-cb="again">${t('cbAgain')}</button><button class="btn wide" data-cb="x">${t('close')}</button></div></div>`;
}

function frame() {
  raf = requestAnimationFrame(frame);
  if (!cal || cal.st.step < 1 || cal.st.step > 3) return;
  const now = Date.now();
  if (!ms.ok || now - ms.t > 1500) { if (!noSensT) noSensT = now; if (now - noSensT > 3500 && view !== 'nosens') noSensors(); return; }
  noSensT = 0;
  const st = cal.feed({ t: performance.now() / 1000, yaw: ms.yaw, rateUp: ms.rateUp, rate: ms.rate, up: ms.up });
  if (st.step !== lastStep) {                                  // крок зараховано
    const was = lastStep; lastStep = st.step;
    if (was) { chime('pass'); P.vibrate(st.step === 4 ? 350 : 160); speak(t(st.step === 4 ? (st.result.ok ? 'cbSayDone' : 'cbSayBad') : 'cbSay' + st.step)); }
    show(st.step);
    if (st.step === 4) return;
  }
  if (view !== 'step' + st.step) show(st.step);
  // телефон на екрані повертається разом зі справжнім; на кроці 1 лише ледь «дихає»
  const a = st.step === 1 ? 0 : Math.max(-135, Math.min(135, st.angle)), ph = $('cbPhone'), nd = $('cbNeedle');
  if (ph) ph.style.transform = `rotateX(7deg) rotateY(${(-a).toFixed(1)}deg)`;
  if (nd) nd.setAttribute('transform', `rotate(${a.toFixed(1)})`);
  const ang = $('cbAng'); if (ang && st.step > 1) ang.textContent = Math.round(Math.abs(a)) + '°' + (Math.abs(a) < 3 ? '' : ' ' + t(a < 0 ? 'cbLeft' : 'cbRight'));
  const pr = $('cbProg'); if (pr) pr.style.width = Math.round(st.prog * 100) + '%';
  const hint = $('cbHint'); if (hint) { const h = st.hint ? t('cbHint_' + st.hint + (st.hint === 'wrongSide' ? st.step : '')) : ''; if (hint.textContent !== h) hint.textContent = h; hint.classList.toggle('warn', st.hint === 'wrongSide' || st.hint === 'tooFar'); }
  document.getElementById('calib').classList.toggle('holding', st.prog > 0 && st.prog < 1);
}

function start() { cal = newCal(); lastStep = 0; noSensT = 0; view = ''; show(1); lastStep = 1; }
export function calibOpen() {
  const box = $('calib'); if (!box.hidden) return;
  box.innerHTML = shellHtml(); box.hidden = false; document.body.classList.add('calib-on');
  box.onclick = e => {
    const b = e.target.closest('[data-cb]'); if (!b) return;
    const k = b.dataset.cb;
    if (k === 'x') calibClose();
    else if (k === 'again') start();
    else if (k === 'save') { if (cal && cal.st.result && calSave(cal.st.result)) { calibClose(); bus.emit('calibSaved'); } }
  };
  start(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
}
export function calibClose() {
  cancelAnimationFrame(raf); raf = 0; if (cal) cal.stop(); cal = null;
  const box = $('calib'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('calib-on');
}
export const calibState = () => ({ open: !$('calib').hidden, step: cal ? cal.st.step : 0, st: cal ? { ...cal.st } : null, view, saved: calGet(), fresh: calFresh(), cfg: CAL });
