// Лабораторія (1.1.12): окремий екран на дві частини.
//   Угорі — схема всього рейсу: пройдене, контрольні повороти (червоні й жовті), де зараз позначка і куди дивиться.
//   Унизу — телефон у 3D (повертаєте телефон — модель повертається так само, видно градуси ліворуч/праворуч)
//   і всі дані, які програма знімає з телефона: гіроскоп, трясіння, GPS, розрахунок без GPS, «замок на повороті».
// Вхід — прихований: у «Налаштуваннях» на логотипі два дотики й на другому тримати палець 3 секунди.
import { bus, S, fmtDist, fmtMS, VERSION } from './core.js';
import { pos, debugState, routeCps } from './nav.js';
import { g } from './guide.js';
import { ms } from './sensors.js';
import { $, ICON, openPanel, closePanel, esc } from './ui_base.js';
import { t } from './i18n.js';
import * as P from './platform.js';

let on = false, raf = 0, dataT = 0, zoomNear = false, yaw0 = null, yawS0 = null, evLog = [], openedAt = 0, zeroT = 0;
const D2R = Math.PI / 180;
const sgnTxt = v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '°';
const side = d => d == null ? t('labNoSens') : Math.abs(d) < 0.5 ? t('labStraight') : t(d > 0 ? 'labRightBy' : 'labLeftBy', Math.abs(d).toFixed(0));

function html() {
  return `<header class="lab-h"><button class="lab-x" data-lab="x" aria-label="${t('close')}">${ICON.x}</button><b>${t('labTitle')}</b>
      <span class="grow"></span><button class="btn sm" data-lab="tools">${t('labTools')}</button></header>
    <section class="lab-top"><canvas id="labMap"></canvas><div class="lab-cap" id="labCap"></div>
      <button class="btn sm lab-zoom" data-lab="zoom" id="labZoom"></button></section>
    <section class="lab-bot">
      <div class="lab-ph">
        <div class="lab-scene"><div class="lab-stage"><div class="lab-ground"><u id="labArc"></u><i id="labDial"></i></div>
          <div class="lab-phone" id="labPhone"><i class="f"></i><i class="bk"></i><i class="sl"></i><i class="sr"></i><i class="st"></i><i class="sb"></i></div></div></div>
        <div class="lab-yaw" id="labYaw"></div>
        <button class="btn sm" data-lab="zero">${t('labZero')}</button>
      </div>
      <div class="lab-data" id="labData"></div>
    </section>`;
}

/* ---------- схема рейсу ---------- */
function drawMap() {
  const cv = $('labMap'); if (!cv) return;
  const box = cv.parentElement.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.max(50, box.width), H = Math.max(50, box.height);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement), ink = cs.getPropertyValue('--ink').trim() || '#111', ink2 = cs.getPropertyValue('--ink-2').trim() || '#666';
  const idx = g.active && g.idx ? g.idx : null, cap = $('labCap');
  if (!idx) {
    x.fillStyle = ink2; x.font = '600 15px system-ui, sans-serif'; x.textAlign = 'center';
    for (const [i, line] of t('labNoTrip').split('\n').entries()) x.fillText(line, W / 2, H / 2 - 8 + i * 22);
    if (cap) cap.textContent = ''; $('labZoom').hidden = true; return;
  }
  $('labZoom').hidden = false; $('labZoom').textContent = t(zoomNear ? 'labZoomAll' : 'labZoomNear');
  const total = idx.total, rd = pos.rd != null && pos.onRoute ? pos.rd : null, cps = routeCps(), nx = pos.cp ? pos.cp.d : null;
  let capH = 20;
  if (cap) {
    const c = pos.cp, left = rd != null ? total - rd : null;
    const txt = [t('labRouteAll', fmtDist(total)), rd != null ? t('labDone', fmtDist(rd)) : '', left != null ? t('labLeft', fmtDist(left)) : '',
      pos.mode === 'dr' ? 'GPS ✕ ' + fmtMS((Date.now() - pos.lostSince) / 1000) + ' ±' + Math.round(pos.acc) + ' ' + t('m') : pos.mode === 'gps' ? 'GPS ±' + Math.round(pos.acc || 0) + ' ' + t('m') : t('tabNoGps'),
      c ? t('labNextCp', fmtDist(c.dist)) + ' ' + t(c.state === 'wait' ? 'labCpWait' : c.state === 'turn' ? 'labCpTurn' : 'labCpGo') : '', t('labCpCount', cps.length)].filter(Boolean).join(' · ');
    if (cap.textContent !== txt) cap.textContent = txt;
    capH = cap.offsetHeight + 8;
  }
  const d0 = zoomNear && rd != null ? Math.max(0, rd - 700) : 0, d1 = zoomNear && rd != null ? Math.min(total, rd + 2300) : total;
  const step = Math.max(8, (d1 - d0) / 500), pts = [];
  const a0 = idx.at(d0), kx = Math.cos(a0.lat * D2R) * 111320;
  for (let d = d0; d <= d1 + 0.1; d += step) { const p = idx.at(Math.min(d, d1)); pts.push([(p.lon - a0.lon) * kx, (p.lat - a0.lat) * 110540, Math.min(d, d1)]); }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const pad = 22, top = capH + 6, bot = 50;                                  // угорі підпис, унизу кнопка масштабу
  const k = Math.min((W - 2 * pad) / Math.max(1, x1 - x0), (H - top - bot) / Math.max(1, y1 - y0));
  const ox = (W - (x1 - x0) * k) / 2, oy = top + (H - top - bot - (y1 - y0) * k) / 2;
  const X = p => ox + (p[0] - x0) * k, Y = p => oy + (y1 - p[1]) * k;
  const at = d => { const p = idx.at(d); return [(p.lon - a0.lon) * kx, (p.lat - a0.lat) * 110540]; };
  const line = (from, to, color, w) => { x.beginPath(); let st = false; for (const p of pts) { if (p[2] < from - step || p[2] > to + step) continue; if (!st) { x.moveTo(X(p), Y(p)); st = true; } else x.lineTo(X(p), Y(p)); } x.strokeStyle = color; x.lineWidth = w; x.lineJoin = 'round'; x.lineCap = 'round'; x.stroke(); };
  line(d0, d1, 'rgba(120,130,150,.55)', 4);
  if (rd != null) line(d0, Math.min(rd, d1), '#7c5cff', 5);
  // похибка розрахунку без GPS — помаранчева смуга вздовж рейсу
  if (rd != null && pos.mode === 'dr') line(Math.max(d0, rd - pos.acc), Math.min(d1, rd + pos.acc), 'rgba(245,165,36,.45)', 11);
  for (const c of cps) {
    if (c.d < d0 || c.d > d1) continue;
    const p = at(c.d), big = c.d === nx, r = big ? 7 : zoomNear ? 5 : 3.5;
    x.beginPath(); x.arc(X(p), Y(p), r, 0, 7); x.fillStyle = c.cls === 'red' ? '#e5484d' : '#f6bd16'; x.fill();
    x.lineWidth = big ? 2.5 : 1.2; x.strokeStyle = big ? ink : '#fff'; x.stroke();
  }
  const dot = (d, color, lbl) => { if (d < d0 || d > d1) return; const p = at(d); x.beginPath(); x.arc(X(p), Y(p), 6, 0, 7); x.fillStyle = color; x.fill(); x.lineWidth = 2; x.strokeStyle = '#fff'; x.stroke(); x.fillStyle = ink; x.font = '700 11px system-ui, sans-serif'; x.textAlign = 'left'; x.fillText(lbl, X(p) + 9, Y(p) + 4); };
  dot(0, '#2f9e62', t('ptStart')); dot(total, '#e5484d', t('ptFinish'));
  if (rd != null) {
    const p = at(rd), q = at(Math.min(total, rd + 15)), ang = Math.atan2(-(q[1] - p[1]), q[0] - p[0]);
    x.save(); x.translate(X(p), Y(p)); x.rotate(ang);
    x.beginPath(); x.moveTo(12, 0); x.lineTo(-8, -8); x.lineTo(-3, 0); x.lineTo(-8, 8); x.closePath();
    x.fillStyle = pos.mode === 'dr' ? '#f5a524' : '#2f6bff'; x.fill(); x.lineWidth = 2; x.strokeStyle = '#fff'; x.stroke(); x.restore();
  }
}

/* ---------- телефон у 3D ----------
   Нахил беремо з напрямку «вгору» (сила тяжіння в осях телефона) — він не «стрибає», коли телефон стоїть рівно,
   як кути датчика положення. Поворот ліворуч/праворуч — накопичений гіроскоп навколо вертикалі. */
const norm = v => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function phoneMatrix(up, yawCw) {
  const u = norm(up), w = Math.min(1, Math.max(0, (Math.abs(u[2]) - 0.6) / 0.3));
  // «вперед»: у тримачі — туди, куди дивиться задня кришка; якщо телефон лежить — туди, куди показує його верх
  let f = [0, w, -(1 - w)]; const k = dot3(f, u); f = [f[0] - k * u[0], f[1] - k * u[1], f[2] - k * u[2]];
  if (Math.hypot(f[0], f[1], f[2]) < 0.05) f = [0, 1, 0];
  const Y = norm(f), X = cross(Y, u), a = -yawCw * D2R, c = Math.cos(a), sn = Math.sin(a);
  // світ: X праворуч, Y вперед, Z угору → екран: x праворуч, y вниз, z до глядача; осі моделі: x, −y, z телефона
  const R = [[X[0], -X[1], X[2]], [Y[0], -Y[1], Y[2]], [u[0], -u[1], u[2]]];
  const W = [[c * R[0][0] - sn * R[1][0], c * R[0][1] - sn * R[1][1], c * R[0][2] - sn * R[1][2]],
    [sn * R[0][0] + c * R[1][0], sn * R[0][1] + c * R[1][1], sn * R[0][2] + c * R[1][2]], R[2]];
  const M = [W[0], [-W[2][0], -W[2][1], -W[2][2]], [-W[1][0], -W[1][1], -W[1][2]]];
  const r = v => Math.abs(v) < 1e-4 ? 0 : +v.toFixed(4);
  return `matrix3d(${r(M[0][0])},${r(M[1][0])},${r(M[2][0])},0,${r(M[0][1])},${r(M[1][1])},${r(M[2][1])},0,${r(M[0][2])},${r(M[1][2])},${r(M[2][2])},0,0,0,0,1)`;
}
let phoneView = { yaw: null, web: null, svc: null };
function drawPhone() {
  const ph = $('labPhone'); if (!ph) return;
  const st = debugState(), yawSvc = st.yawNow, haveWeb = ms.ok && Date.now() - ms.t < 3000;
  if (yaw0 == null && haveWeb) yaw0 = ms.yaw;
  if (yawS0 == null && yawSvc != null) yawS0 = yawSvc;
  const dWeb = haveWeb && yaw0 != null ? ms.yaw - yaw0 : null, dSvc = yawSvc != null && yawS0 != null ? yawSvc - yawS0 : null;
  const yaw = dWeb != null ? dWeb : (dSvc != null ? dSvc : 0);
  ph.style.transform = phoneMatrix(haveWeb ? ms.up : [0, 0.9, 0.44], yaw);
  const sc = ph.closest('.lab-scene'), stg = ph.parentElement;
  if (sc && stg) { const k = Math.max(0.5, Math.min(1.9, sc.clientWidth / 228, sc.clientHeight / 262)); if (Math.abs(k - (stg._k || 0)) > 0.01) { stg._k = k; stg.style.transform = `scale(${k.toFixed(2)}) rotateX(-22deg)`; } }
  ph.classList.toggle('hand', !!ms.handled);
  const dial = $('labDial'), arc = $('labArc'), ya = ((yaw % 360) + 540) % 360 - 180;      // на колі — від −180° до +180°
  if (dial) dial.style.transform = `rotate(${ya.toFixed(1)}deg)`;
  if (arc) arc.style.background = Math.abs(ya) < 0.5 ? 'none' : ya > 0 ? `conic-gradient(from 0deg, var(--amber) 0 ${ya.toFixed(1)}deg, transparent 0)` : `conic-gradient(from ${ya.toFixed(1)}deg, var(--amber) 0 ${(-ya).toFixed(1)}deg, transparent 0)`;
  phoneView = { yaw, web: dWeb, svc: dSvc };
  const y = $('labYaw'), shown = dWeb != null ? dWeb : dSvc;
  const h = `<b>${esc(side(shown))}</b><small>${Date.now() - zeroT < 2500 ? t('labZeroed') : t('labYawWeb') + ': ' + sgnTxt(dWeb) + ' · ' + t('labYawSvc') + ': ' + sgnTxt(dSvc)}</small>`;
  if (y && y._h !== h) { y._h = h; y.innerHTML = h; }
}
export const phoneState = () => ({ ...phoneView });

/* ---------- дані ---------- */
const row = (k, v, cls = '') => `<div class="lab-r${cls ? ' ' + cls : ''}"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`;
function drawData() {
  const box = $('labData'); if (!box) return;
  const st = debugState(), pf = st.pf, G = pf && pf.gate, haveWeb = ms.ok && Date.now() - ms.t < 3000, yh = st.yawHist || [];
  const dY = n => yh.length > n ? yh[yh.length - 1].yaw - yh[yh.length - 1 - n].yaw : null;
  const thr = (st.varStop != null && st.varMove != null && st.varMove > 2.5 * st.varStop) ? st.varStop * Math.pow(st.varMove / st.varStop, 0.3) : 0.002;
  const f = (v, n = 1) => v == null || !isFinite(v) ? '—' : (+v).toFixed(n);
  let h = `<div class="lab-sec">${t('labSecPhone')}</div>`;
  h += row(t('labWebSens'), haveWeb ? t('labYes', ms.hz) : t('labNo'), haveWeb ? 'ok' : 'warn');
  h += row(t('labRate'), haveWeb ? t('labRateV', f(ms.rateUp), f(ms.rate)) : '—');
  h += row(t('labTilt'), haveWeb ? f(ms.tilt) + '° · ' + t('labPeak') + ' ' + f(ms.peak, 0) + ' °/с' : '—');
  h += row(t('labHand'), ms.handled ? t('labHandYes') : t('labHandNo'), ms.handled ? 'bad' : '');
  h += row(t('labPose'), ms.beta != null ? `β ${f(ms.beta, 0)}° γ ${f(ms.gamma, 0)}° α ${f(ms.alpha, 0)}°` : '—');
  h += row(t('labAcc'), haveWeb ? f(ms.acc, 2) + ' м/с²' : '—');
  h += `<div class="lab-sec">${t('labSecSvc')}</div>`;
  h += row(t('labGyro'), st.yawNow != null ? f(st.yawNow) + '°' : t('labNoGyro'), st.yawNow != null ? '' : 'warn');
  h += row(t('labGyroD'), `1 с: ${sgnTxt(dY(1))} · 3 с: ${sgnTxt(dY(3))} · 8 с: ${sgnTxt(dY(8))}`);
  h += row(t('labShake'), (st.lastVar != null ? f(st.lastVar, 4) : '—') + ' · ' + t('labThr') + ' ' + f(thr, 4));
  h += row(t('labMoving'), st.moving ? t('labMoveYes') : t('labMoveNo'), st.moving ? 'ok' : '');
  h += row(t('labCompass'), st.compass != null ? f(st.compass, 0) + '°' : '—');
  h += `<div class="lab-sec">GPS</div>`;
  h += row(t('labMode'), pos.mode === 'gps' ? 'GPS' : pos.mode === 'dr' ? t('labModeDr') : pos.mode === 'approx' ? t('labModeNet') : t('tabNoGps'), pos.mode === 'gps' ? 'ok' : 'warn');
  h += row(t('labFix'), pos.lat != null ? pos.lat.toFixed(5) + ', ' + pos.lon.toFixed(5) + ' ±' + Math.round(pos.acc || 0) + ' ' + t('m') : '—');
  h += row(t('labSpeed'), Math.round((pos.spd || 0) * 3.6) + ' ' + t('kmh') + ' · ' + t('labCourse') + ' ' + Math.round(pos.hdg || 0) + '°');
  h += row(t('labSats'), pos.sats ? `${pos.sats.used}/${pos.sats.vis}` + (pos.sats.cn0 != null ? ' · ' + Math.round(pos.sats.cn0) + ' дБ' : '') : '—');
  h += row(t('labNet'), st.net ? '±' + Math.round(st.net.acc) + ' ' + t('m') + ' · ' + fmtMS((Date.now() - st.net.rt) / 1000) : '—');
  h += `<div class="lab-sec">${t('labSecDr')}</div>`;
  if (pf) {
    h += row(t('labDrPos'), fmtDist(pf.d) + ' · ' + Math.round(pf.v * 3.6) + ' ' + t('kmh') + ' · ±' + pf.sig + ' ' + t('m'));
    h += row(t('labTempo'), pf.mMed != null ? '×' + pf.mMed.toFixed(2) : '—');
    h += row(t('labBias'), f(pf.bias * 60, 2) + ' °/хв');
    if (G) {
      h += row(t('labGate'), (G.sgn > 0 ? '↱ ' : G.sgn < 0 ? '↰ ' : '⟳ ') + G.ang + '° · ' + t(G.cls === 'red' ? 'labRed' : 'labYellow') + ' · ' + fmtDist(G.dist));
      h += row(t('labGateState'), t(G.state === 'wait' ? 'labCpWait' : G.state === 'turn' ? 'labCpTurn' : 'labCpGo') + ' · ' + t('labProg', G.prog, Math.abs(G.ang)), G.state === 'wait' ? 'warn' : G.state === 'turn' ? 'ok' : '');
      h += row(t('labAlign'), t(G.align === 'ok' ? 'labAlignOk' : 'labAlignWeak') + (G.alive ? '' : ' · ' + t('labNoGyro')));
    }
  } else h += row(t('labDrPos'), t('labDrOff'));
  if (evLog.length) { h += `<div class="lab-sec">${t('labSecEv')}</div>`; for (const e of evLog.slice(-6).reverse()) h += `<div class="lab-ev">${esc(e)}</div>`; }
  box.innerHTML = h;
}

function loop() {
  if (!on) return;
  drawPhone();
  const now = performance.now();
  if (now - dataT > 250) { dataT = now; drawData(); drawMap(); }
  raf = requestAnimationFrame(loop);
}
export function openLab(byHold) {
  const box = $('labApp'); if (!box) return;
  closePanel();
  box.innerHTML = html(); box.hidden = false; on = true; yaw0 = null; yawS0 = null; dataT = 0; zoomNear = false; openedAt = byHold === true ? performance.now() : 0;
  document.body.classList.add('lab-on');
  cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
}
export function closeLab() { on = false; cancelAnimationFrame(raf); const box = $('labApp'); if (box) { box.hidden = true; box.innerHTML = ''; } document.body.classList.remove('lab-on'); }
export const labOpen = () => on;
// «Перемикачі»: старі налаштування Лабораторії (що стежити, симуляція, канали, діагностика)
export function tools() { closeLab(); openPanel('lab'); }

/* ---------- прихований вхід: на логотипі два дотики, на другому тримати 3 секунди ----------
   Слухаємо на документі: «Налаштування» перемальовуються, а жест має жити далі. */
const HOLD_MS = 3000, TAP_GAP = 700;
let gLast = 0, gHold = null, gEl = null;
function gStop() { clearTimeout(gHold); gHold = null; if (gEl) gEl.classList.remove('arming'); gEl = null; }
function bindLogo() {
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest && e.target.closest('.app-logo'); gStop(); if (!el) { gLast = 0; return; }
    if (Date.now() - gLast < TAP_GAP) {
      gEl = el; el.classList.add('arming');
      gHold = setTimeout(() => { gStop(); gLast = 0; P.vibrate(60); openLab(true); }, HOLD_MS);
    }
  }, true);
  const up = e => {
    const el = e.target.closest && e.target.closest('.app-logo'), was = !!gHold; gStop();
    gLast = el && !was && e.type === 'pointerup' ? Date.now() : 0;
  };
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('.app-logo')) e.preventDefault(); }, true);
}
/** Логотип для «Налаштувань»: кольоровий значок застосунку, назва й версія. */
export function logoHtml() {
  return `<div class="app-logo" role="img" aria-label="Рейс ${esc(VERSION.name)}"><span class="al-ring"><span class="al-ico"></span></span>
    <b>РЕЙС</b><small>${esc(VERSION.name)} · ${t('labLogoSub', VERSION.web)}</small></div>`;
}
export function initLabApp() {
  const box = $('labApp'); if (!box) return;
  bindLogo();
  box.onclick = e => {
    if (performance.now() - openedAt < 600) return;        // палець, що тримав логотип, відпускають уже над Лабораторією — це не натискання
    const b = e.target.closest('[data-lab]'); if (!b) { if (e.target.id === 'labMap') { zoomNear = !zoomNear; drawMap(); } return; }
    const k = b.dataset.lab;
    if (k === 'x') closeLab();
    else if (k === 'tools') tools();
    else if (k === 'zoom') { zoomNear = !zoomNear; drawMap(); }
    else if (k === 'zero') { yaw0 = ms.ok ? ms.yaw : null; const y = debugState().yawNow; yawS0 = y != null ? y : null; zeroT = Date.now(); }
  };
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
  bus.on('cpPass', ev => { evLog.push(`${stamp()} · ${t('labEvPass', ev.cp.ang, t('labBy_' + ev.by))}` + (ev.jump ? ' · +' + ev.jump + ' ' + t('m') : '') + (ev.waited ? ' · ' + t('labEvWait', ev.waited) : '')); if (evLog.length > 40) evLog.shift(); });
  bus.on('gpsLost', d => evLog.push(`${stamp()} · GPS ✕ (${d.reason})`));
  bus.on('gpsBack', d => evLog.push(`${stamp()} · GPS ✓ · ${t('labEvErr', d.err)}`));
  window.addEventListener('resize', () => { if (on) drawMap(); });
}
