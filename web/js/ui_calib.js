// Екран «Калібрування телефона» (1.1.22): на весь екран, три кроки й результат. Логіка замірів — calib.js.
// Телефон тримають так, як у тримачі; на екрані — телефон, що повертається разом зі справжнім, шкала з ціллю 90°
// і великий підпис, що робити зараз. Коли телефон повернуто «ребром», екрана не видно — тому кожен крок підтверджується
// звуком, вібрацією й голосом, а якщо зупинились не там — голос підкаже («ще трохи», «забагато»).
import { bus } from './core.js';
import * as P from './platform.js';
import { onRaw } from './sensors.js';
import { newCal, calSave, calGet, calFresh, calBusy, CAL } from './calib.js';
import { calTone } from './sfx.js';
import { say } from './guide.js';
import { $, ICON, esc } from './ui_base.js';
import { t } from './i18n.js';

let cal = null, raf = 0, off = null, lastStep = 0, view = '', seenN = 0, seenT = 0, hintKey = '', hintT = 0, hintSaid = 0, t0 = 0, rawN = 0, natPrev = null;
const fmt1 = n => String(Math.round(n * 10) / 10).replace('.', ',');
const speak = text => { try { say(text, { urgent: true, force: true }); } catch (_) {} };      // голос тут — частина дії: екрана «ребром» не видно
const sideKey = s => s < 0 ? 'cbLeft' : 'cbRight';

/* ---------- шкала: півколо з поділками, 0° — прямо, по 90° ліворуч і праворуч; ціль зелена; жовта дуга й кулька — куди екран
   повернуто зараз; пунктир — скільки ще лишилось. Усередині півкола — сам телефон, що повертається разом зі справжнім. ---------- */
const pt = (deg, r) => { const a = (deg - 90) * Math.PI / 180; return [(r * Math.cos(a)).toFixed(1), (r * Math.sin(a)).toFixed(1)]; };
const arc = (a0, a1, r) => { const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r); return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
const RR = 94, GOAL = 80;
function dialSvg(step) {
  const ticks = [];
  for (let a = -105; a <= 105; a += 15) { const big = a % 45 === 0, [x0, y0] = pt(a, big ? 82 : 85.5), [x1, y1] = pt(a, 88.5); ticks.push(`<path d="M${x0} ${y0}L${x1} ${y1}" class="${big ? 'cb-tk big' : 'cb-tk'}"/>`); }
  const lab = (a, s, id) => { const [x, y] = pt(a, 115); return `<text x="${x}" y="${y}" class="cb-lb" id="${id}">${s}</text>`; };
  return `<svg class="cb-dial" viewBox="-132 -124 264 166" aria-hidden="true">
    <path d="${arc(-110, 110, RR)}" class="cb-ring"/>
    ${step > 1 ? `<path d="${arc(-100, -GOAL, RR)}" class="cb-goal" id="cbGoalL"/><path d="${arc(GOAL, 100, RR)}" class="cb-goal" id="cbGoalR"/><path d="" class="cb-rest" id="cbRest"/>` : ''}
    <path d="" class="cb-arc" id="cbArc"/>
    ${ticks.join('')}${lab(-90, '90°', 'cbLbL')}${lab(0, '0°', 'cbLb0')}${lab(90, '90°', 'cbLbR')}
    <circle r="9" class="cb-bead" id="cbBead" transform="translate(0 -${RR})"/>
  </svg>`;
}

function shellHtml() {
  const li = n => `<li data-s="${n}"><b>${n}</b><span></span></li>`;
  return `<div class="cb-head"><b>${t('cbTitle')}</b><button class="cb-x" data-cb="x" aria-label="${t('close')}">${ICON.x}</button></div>
    <ol class="cb-steps">${li(1)}${li(2)}${li(3)}<li data-s="4" class="fin">${ICON.check}<span>${t('cbS4')}</span></li></ol>
    <div class="cb-body" id="cbBody"></div>
    <div class="cb-foot">${t('cbWhy')}</div>`;
}
// Кроки вгорі: 1 — тримати, 2 і 3 — боки в тому порядку, як їх справді повертають (зазвичай ліворуч, потім праворуч)
function setSteps(step) {
  const st = cal ? cal.st : null, first = st && st.first ? st.first : -1;
  const names = { 1: t('cbS1'), 2: t(first < 0 ? 'cbS2' : 'cbS3'), 3: t(first < 0 ? 'cbS3' : 'cbS2') };
  for (const li of document.querySelectorAll('#calib .cb-steps li')) {
    const n = +li.dataset.s; li.classList.toggle('cur', n === step); li.classList.toggle('done', n < step || (step === 4 && n === 4));
    if (names[n]) li.querySelector('span').textContent = names[n];
  }
}
function stageHtml(step) {
  return `<div class="cb-in"><div class="cb-stage">
      <div class="cb-gauge">${dialSvg(step)}<div class="cb-ph3d" id="cbPh3d"><div class="cb-phone" id="cbPhone"><i></i><u></u></div></div></div>
      <div class="cb-ang" id="cbAng"></div>
    </div>
    <div class="cb-info"><div class="cb-title" id="cbTitle"></div>
      <div class="cb-text" id="cbText"></div>
      <div class="cb-prog"><i id="cbProg"></i></div>
      <div class="cb-hint" id="cbHint"></div></div></div>`;
}
function resultHtml(r) {
  const pose = r.pose ? t('cbPose_' + r.pose.kind, r.pose.lean) + (r.pose.side ? ', ' + t('cbPoseSide') : '') : '';
  if (r.ok) return `<div class="cb-in"><div class="cb-res ok"><div class="cb-rl"><div class="cb-big">${ICON.check}</div><div class="cb-title">${t('cbOkTitle')}</div><div class="cb-text">${t(r.fine ? 'cbOkFine' : 'cbOkText')}</div></div>
      <div class="cb-rr"><div class="cb-rows"><div><span>${t('cbRSeen')}</span><b>${fmt1(r.seen90)}°</b></div>
        <div><span>${t('cbRFix')}</span><b>${r.fine ? t('cbRFixNone') : (r.pct > 0 ? '+' : '−') + fmt1(Math.abs(r.pct)) + ' %'}</b></div>
        ${pose ? `<div><span>${t('cbRPose')}</span><b>${esc(pose)}</b></div>` : ''}</div>
      <div class="cb-btns"><button class="btn pri" data-cb="save">${t('plDone')}</button><button class="btn" data-cb="again">${t('cbAgain')}</button></div></div></div></div>`;
  return badHtml(t('cbBadTitle'), t('cbBad_' + r.why, fmt1(r.left), fmt1(r.right), fmt1(Math.abs(r.bias))));
}
const badHtml = (title, text) => `<div class="cb-in"><div class="cb-res bad"><div class="cb-rl"><div class="cb-big">!</div><div class="cb-title">${title}</div><div class="cb-text">${text}</div></div>
      <div class="cb-rr"><div class="cb-btns"><button class="btn pri" data-cb="again">${t('cbAgain')}</button><button class="btn" data-cb="x">${t('close')}</button></div></div></div></div>`;
function show(step) {
  view = 'step' + step; setSteps(step);
  $('cbBody').innerHTML = step === 4 ? resultHtml(cal.st.result) : stageHtml(step);
  $('calib').dataset.step = step;
}
function noSensors() {
  view = 'nosens'; setSteps(0); $('calib').dataset.step = 0;
  $('cbBody').innerHTML = badHtml(t('cbNoSensTitle'), t('cbNoSensText'));
}
const set = (id, text) => { const e = $(id); if (e && e.textContent !== text) e.textContent = text; };

function frame() {
  raf = requestAnimationFrame(frame);
  if (!cal) return;
  const st = cal.st, now = Date.now();
  if (st.step < 1) return;
  // датчики мовчать (немає гіроскопа або WebView не віддає події) — чесно кажемо, а не чекаємо вічно
  if (st.n !== seenN) { seenN = st.n; seenT = now; } else if (st.step < 4 && now - seenT > 3500 && view !== 'nosens') { noSensors(); return; }
  if (view === 'nosens') { if (st.n === seenN && now - seenT > 400) return; }
  if (st.step !== lastStep) {                                  // крок зараховано
    const was = lastStep; lastStep = st.step; hintKey = ''; hintSaid = 0;
    if (was && st.step > was) {
      const r = st.result;
      calTone(st.step === 4 ? (r && r.ok ? 'done' : 'bad') : 'ok'); P.vibrate(st.step === 4 ? 350 : 160);
      speak(st.step === 4 ? t(r.ok ? 'cbSayDone' : 'cbSayBad') : st.step === 2 ? t('cbSay2') : t(st.first < 0 ? 'cbSayL' : 'cbSayR'));
    }
    show(st.step);
    if (st.step === 4) return;
  }
  if (st.step === 4) return;
  if (view !== 'step' + st.step) show(st.step);
  const box = $('calib'), side = st.pose ? st.pose.side : innerWidth > innerHeight * 1.15;
  // телефон на екрані повертається разом зі справжнім; на кроці 1 стоїть рівно
  const a = st.step === 1 ? 0 : Math.max(-135, Math.min(135, st.angle)), A = Math.max(-110, Math.min(110, a)), ph = $('cbPhone');
  $('cbPh3d').classList.toggle('side', !!side);
  if (ph) ph.style.transform = `translate(-50%,-50%) rotateX(7deg) rotateY(${(-a).toFixed(1)}deg)`;
  const ar = $('cbArc'), bd = $('cbBead'), rs = $('cbRest'), gl = $('cbGoalL'), gr = $('cbGoalR');
  if (ar) ar.setAttribute('d', Math.abs(A) < 0.6 ? '' : A < 0 ? arc(A, 0, RR) : arc(0, A, RR));
  if (bd) bd.setAttribute('transform', `translate(${pt(A, RR).join(' ')})`);
  if (gl) {
    gl.style.display = st.want < 0 ? '' : 'none'; gr.style.display = st.want > 0 ? '' : 'none'; $('cbLbL').classList.toggle('on', st.want < 0); $('cbLbR').classList.toggle('on', st.want > 0);
    rs.setAttribute('d', st.want < 0 ? (A > -GOAL + 1 ? arc(-GOAL, A, RR) : '') : (A < GOAL - 1 ? arc(A, GOAL, RR) : '')); rs.dataset.to = st.want < 0 ? 'l' : 'r';
  }
  set('cbAng', st.step > 1 ? Math.round(Math.abs(a)) + '°' + (Math.abs(a) < 3 ? '' : ' ' + t(sideKey(a))) : '');
  set('cbTitle', st.step === 1 ? t('cbT1') : t(st.step === 2 ? 'cbT2' : 'cbT3', t(sideKey(st.want))));
  set('cbText', t('cbD' + st.step, t(st.want < 0 ? 'cbEdgeL' : 'cbEdgeR')));
  const pr = $('cbProg'); if (pr) pr.style.width = Math.round(st.prog * 100) + '%';
  const hint = st.hint ? t('cbHint_' + st.hint) : '';
  set('cbHint', hint); const he = $('cbHint'); if (he) he.classList.toggle('warn', st.hint === 'tooFar' || st.hint === 'upright');
  // екрана «ребром» не видно — якщо зупинились не там і стоять, підказуємо голосом (не частіше, ніж раз на 5 с)
  if (st.hint !== hintKey) { hintKey = st.hint; hintT = now; }
  else if ((st.hint === 'more' || st.hint === 'tooFar' || (st.hint === 'upright' && st.step > 1)) && now - hintT > 1200 && now - hintSaid > 5000) { hintSaid = now; speak(hint); }
  box.classList.toggle('holding', st.prog > 0 && st.prog < 1);
}

function start() {
  if (off) off();
  cal = newCal(); lastStep = 0; view = ''; seenN = 0; seenT = Date.now(); hintKey = ''; hintSaid = 0; t0 = performance.now(); rawN = 0; natPrev = null;
  const c = cal; off = onRaw(s => { if (cal === c) { rawN++; c.feed(s); } });
  show(1); lastStep = 1;
}
// кут повороту від служби навігації (раз на секунду) — опора для розмаху: служба не «заїкається» разом з екраном (calib.js)
// Буває, що екран (WebView) подій датчиків не віддає, а служба кут повороту рахує — саме ним і користується ведення. Тоді калібруємо
// лише за службою: з її кута робимо «замір» раз на секунду (телефон вважаємо вертикальним; на екрані він рухається стрибками).
function onSens(s) {
  if (!s || s.yaw == null || !cal) return;
  const now = performance.now(), ts = now / 1000;
  if (rawN === 0 && now - t0 > 1800) {
    if (natPrev && ts - natPrev.t > 0.2 && ts - natPrev.t < 3) cal.feed({ t: ts, w: [0, -(s.yaw - natPrev.yaw) / (ts - natPrev.t), 0], g: [0, 9.81, 0], slow: true });
    natPrev = { t: ts, yaw: s.yaw };
  }
  cal.native(s.yaw);
}
export function calibOpen() {
  const box = $('calib'); if (!box.hidden) return;
  box.innerHTML = shellHtml(); box.hidden = false; document.body.classList.add('calib-on'); calBusy(true);
  bus.on('sens', onSens);
  box.onclick = e => {
    const b = e.target.closest('[data-cb]'); if (!b) return;
    const k = b.dataset.cb;
    if (k === 'x') calibClose();
    else if (k === 'again') start();
    else if (k === 'save') {
      const r = cal && cal.st.result;
      if (r && calSave(r)) { calibClose(); bus.emit('calibSaved'); }
    }
  };
  start(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
}
export function calibClose() {
  cancelAnimationFrame(raf); raf = 0; if (off) off(); off = null; if (cal) cal.stop(); cal = null; bus.off('sens', onSens); calBusy(false);
  const box = $('calib'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('calib-on');
}
export const calibState = () => ({ open: !$('calib').hidden, step: cal ? cal.st.step : 0, st: cal ? { ...cal.st } : null, view, saved: calGet(), fresh: calFresh(), cfg: CAL });
