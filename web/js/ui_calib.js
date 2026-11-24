// Екран «Калібрування телефона» (1.1.22): на весь екран, три кроки й результат. Логіка замірів — calib.js.
// (1.1.23) Три малюнки з рукою — це й є три кроки: «екран до себе» (нуль), «ліва грань до себе» (90° в один бік),
// «права грань до себе» (90° в інший) — як описав Олексій. Поточний крок підсвічено, зроблений — із зеленою галочкою.
// Нижче — телефон, що повертається разом зі справжнім, шкала з ціллю 90° і короткий підпис, що робити зараз.
// Коли телефон повернуто гранню, екрана не видно — тому кожен крок підтверджується звуком, вібрацією й голосом,
// а якщо зупинились не там — голос підкаже («ще трохи», «забагато»). Унизу дрібний рядок «Датчики» — що телефон відчуває
// цієї миті: якщо щось не вийде, з нього одразу видно чому.
import { bus, S, log } from './core.js';
import * as P from './platform.js';
import { onRaw, gyroAxes } from './sensors.js';
import { newCal, calSave, calGet, calFresh, calBusy, CAL } from './calib.js';
import { calTone } from './sfx.js';
import { say } from './guide.js';
import { $, ICON, esc } from './ui_base.js';
import { t } from './i18n.js';

let cal = null, raf = 0, off = null, lastStep = 0, view = '', seenN = 0, seenT = 0, hintKey = '', hintT = 0, hintSaid = 0, t0 = 0, rawN = 0, natPrev = null, diagT = 0;
const fmt1 = n => String(Math.round(n * 10) / 10).replace('.', ',');
const speak = text => { try { say(text, { urgent: true, force: true }); } catch (_) {} };      // голос тут — частина дії: екрана «ребром» не видно

/* ---------- три положення телефона в руці (малюнки-кроки). f — екран до себе: долоня ззаду, великий палець ліворуч, пальці праворуч.
   l — ліва грань до себе: телефон ребром, екран дивиться праворуч (видно його смужку), великий палець спереду.
   r — права грань до себе: на грані кнопки, екран дивиться ліворуч, пальці спереду. ---------- */
const HND = 'class="cb-hand"', PHN = 'class="cb-case"';
const POSE = {
  f: `<svg viewBox="0 0 72 92" aria-hidden="true"><path d="M20 92V80c-5-5-8-12-8-20 0-7 4-12 10-12h28c6 0 10 5 10 12 0 8-3 15-8 20v12z" ${HND}/>
      <rect x="20" y="5" width="32" height="62" rx="6" ${PHN}/><rect x="23.5" y="9" width="25" height="52" rx="3" class="cb-scr"/><path d="M32 64h8" class="cb-bar"/>
      <rect x="12" y="42" width="11" height="25" rx="5.5" transform="rotate(-10 17.5 54)" ${HND}/>
      <rect x="49" y="38" width="12" height="8" rx="4" ${HND}/><rect x="50" y="47.5" width="12" height="8" rx="4" ${HND}/><rect x="49.5" y="57" width="11.5" height="8" rx="4" ${HND}/></svg>`,
  l: `<svg viewBox="0 0 72 92" aria-hidden="true"><path d="M18 92V80c-5-5-7-11-7-18 0-8 5-13 12-13h14c7 0 11 5 11 13 0 7-2 13-7 18v12z" ${HND}/>
      <rect x="41.5" y="9" width="3.2" height="54" rx="1.6" class="cb-scr"/><rect x="31" y="5" width="11" height="62" rx="4.5" ${PHN}/>
      <rect x="25" y="44" width="11.5" height="27" rx="5.7" transform="rotate(8 30.7 57)" ${HND}/></svg>`,
  r: `<svg viewBox="0 0 72 92" aria-hidden="true"><path d="M24 92V80c-5-5-7-11-7-18 0-8 4-13 11-13h14c7 0 12 5 12 13 0 7-2 13-7 18v12z" ${HND}/>
      <rect x="27.3" y="9" width="3.2" height="54" rx="1.6" class="cb-scr"/><rect x="30" y="5" width="11" height="62" rx="4.5" ${PHN}/>
      <rect x="34" y="17" width="3" height="12" rx="1.5" class="cb-key"/><rect x="34" y="32" width="3" height="6.5" rx="1.5" class="cb-key"/>
      <rect x="28" y="44" width="17" height="8" rx="4" ${HND}/><rect x="28.5" y="53.5" width="17" height="8" rx="4" ${HND}/><rect x="28" y="63" width="16" height="8" rx="4" ${HND}/></svg>`,
};
const poseKey = st => st.step === 1 ? 'f' : st.want < 0 ? 'l' : 'r';

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
  return `<div class="cb-head"><b>${t('cbTitle')}</b><button class="cb-x" data-cb="x" aria-label="${t('close')}">${ICON.x}</button></div>
    <div class="cb-body" id="cbBody"></div>
    <div class="cb-diag" id="cbDiag"></div>
    <div class="cb-foot">${t('cbWhy')}</div>`;
}
// Малюнки-кроки: поточний підсвічено, зроблений — із зеленою галочкою. На кроці 2 зараховуємо будь-який бік: куди водій
// справді повертає, той малюнок і світиться.
let stepsKey = '';
function setSteps() {
  const st = cal ? cal.st : null; if (!st) return;
  const cur = st.step >= 1 && st.step <= 3 ? poseKey(st) : '', done = { f: st.step > 1, l: st.step === 3 && st.first < 0, r: st.step === 3 && st.first > 0 };
  const key = cur + (done.f ? 'f' : '') + (done.l ? 'l' : '') + (done.r ? 'r' : ''); if (key === stepsKey) return; stepsKey = key;
  for (const li of document.querySelectorAll('#calib .cb-steps li')) {
    const k = li.dataset.k; li.classList.toggle('cur', k === cur); li.classList.toggle('done', !!done[k]);
    li.querySelector('b').innerHTML = done[k] ? ICON.check : li.dataset.n;
  }
}
function stageHtml(step) {
  const tile = (k, n) => `<li data-k="${k}" data-n="${n}"><span class="cb-pose">${POSE[k]}</span><b>${n}</b><span class="cb-tl">${t('cbS_' + k)}</span></li>`;
  return `<div class="cb-in"><div class="cb-stage">
      <ol class="cb-steps">${tile('f', 1)}${tile('l', 2)}${tile('r', 3)}</ol>
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
  view = 'step' + step;
  $('cbBody').innerHTML = step === 4 ? resultHtml(cal.st.result) : stageHtml(step);
  $('calib').dataset.step = step; stepsKey = ''; setSteps();
}
// Рядок «Датчики»: скільки замірів за секунду віддає екран, як швидко телефон зараз обертається, чи звітує служба навігації
function diag() {
  const st = cal ? cal.st : null; if (!st) return;
  const now = Date.now(); if (now - diagT < 300) return; diagT = now;
  const svc = t(st.nat ? 'cbDgSvcYes' : 'cbDgSvcNo'), ax = gyroAxes() !== !!st.swap ? ' · ' + t('cbDgAxes') : '';
  const low = !st.slow && st.hz > 0 && st.hz < 20;                 // екран віддає заміри надто рідко (телефон зайнятий) — кут рахується грубо, кроки можуть іти довше
  set('cbDiag', st.slow ? t('cbDgSlow') : st.n === 0 ? t('cbDgNone', svc) : t('cbDg', (st.hz || '…') + (low ? ' — ' + t('cbDgLow') : ''), Math.round(st.rate), svc) + ax);
  const de = $('cbDiag'); if (de) de.classList.toggle('warn', low);
}
function noSensors() {
  view = 'nosens'; $('calib').dataset.step = 0;
  $('cbBody').innerHTML = badHtml(t('cbNoSensTitle'), t('cbNoSensText'));
}
const set = (id, text) => { const e = $(id); if (e && e.textContent !== text) e.textContent = text; };

function frame() {
  raf = requestAnimationFrame(frame);
  if (!cal) return;
  const st = cal.st, now = Date.now();
  if (st.step < 1) return;
  diag();
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
  setSteps();
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
  const pk = poseKey(st);
  set('cbAng', st.step > 1 ? Math.round(Math.abs(a)) + '°' : '');
  set('cbTitle', t('cbT_' + pk));
  set('cbText', t((st.step === 3 ? 'cbD3_' : 'cbD_') + pk));
  const pr = $('cbProg'); if (pr) pr.style.width = Math.round(st.prog * 100) + '%';
  const hint = st.hint ? t('cbHint_' + st.hint) : '';
  set('cbHint', hint); const he = $('cbHint'); if (he) he.classList.toggle('warn', st.hint === 'tooFar' || st.hint === 'upright');
  // екрана «ребром» не видно — якщо зупинились не там і стоять, підказуємо голосом (не частіше, ніж раз на 5 с)
  if (st.hint !== hintKey) { hintKey = st.hint; hintT = now; }
  else if ((st.hint === 'more' || st.hint === 'tooFar' || (st.hint === 'upright' && st.step > 1)) && now - hintT > 1200 && now - hintSaid > 5000) { hintSaid = now; speak(hint); }
  box.classList.toggle('holding', st.prog > 0 && st.prog < 1);
}

// Калібрування побачило, що осі гіроскопа на цьому телефоні йдуть в іншому порядку (calib.js: самоперевірка за акселерометром) —
// запам'ятовуємо для датчиків: так рахуватиме і ведення без GPS, і наступне калібрування.
function keepAxes() {
  if (!cal || !cal.st.swap) return;
  cal.st.swap = false; gyroAxes(!gyroAxes()); S.gyroAlt = gyroAxes();
  log('info', 'калібрування: осі гіроскопа на цьому телефоні йдуть у ' + (S.gyroAlt ? 'запасному' : 'звичайному') + ' порядку — запамʼятав');
}
function start() {
  if (off) off(); keepAxes();
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
    if (natPrev && ts - natPrev.t < 0.2) return;               // два звіти служби впритул — дочекаємось наступного
    if (natPrev && ts - natPrev.t < 3) cal.feed({ t: ts, w: [0, -(s.yaw - natPrev.yaw) / (ts - natPrev.t), 0], g: [0, 9.81, 0], slow: true });
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
  cancelAnimationFrame(raf); raf = 0; if (off) off(); off = null; keepAxes(); if (cal) cal.stop(); cal = null; bus.off('sens', onSens); calBusy(false);
  const box = $('calib'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('calib-on');
}
export const calibState = () => ({ open: !$('calib').hidden, step: cal ? cal.st.step : 0, st: cal ? { ...cal.st } : null, view, saved: calGet(), fresh: calFresh(), cfg: CAL });
