// «Архів поїздок» (1.1.25): запитання «зберегти пройдений шлях?» на фініші, список збережених поїздок і перегляд однієї
// на карті — лінія кольором за швидкістю, графік швидкості, зведення (відстань, час, середня й найбільша, без GPS, зупинки).
import { bus, S, fmtDist, fmtDur, fmtClock } from './core.js';
import { $, ICON, esc, toast, definePanel, openPanel, closePanel, currentPanel, refresh } from './ui_base.js';
import { t } from './i18n.js';
import { showJourney, fitJourney, journeyMark, onJourneyTap, zoomBy, setFollow } from './map.js';
import { jr, JR, SPEED_COLORS, list, load, remove, savePending, dropPending, exportGpx, profile, cumDist, nearestOn, atDist, bucket } from './journey.js';

const loc = () => (S.lang === 'ru' ? 'ru-RU' : 'uk-UA');
const dayOf = ts => { try { return new Date(ts * 1000).toLocaleDateString(loc(), { day: 'numeric', month: 'short' }); } catch (_) { return ''; } };
const clockOf = ts => fmtClock(new Date(ts * 1000));
const kmh = v => `${Math.round(v)} ${t('kmh')}`;
/** Короткий рядок поїздки: «143 км · 2 год 5 хв». */
const brief = m => `${fmtDist(m.dist)} · ${fmtDur(m.dur)}`;
const estNote = m => (m.est >= 200 ? t('jrEst', fmtDist(m.est)) : '');

/* ---------- запитання на фініші: «Зберегти пройдений шлях?» ---------- */
function askShow(p) {
  const box = $('jrAsk'); if (!box || !p) return;
  box.innerHTML = `<div class="ja-t"><b>${t('jrAskQ')}</b><small>${esc([p.title, brief(p.st), estNote(p.st)].filter(Boolean).join(' · '))}</small></div>
    <div class="ja-b"><button class="btn" data-ja="no">${t('jrAskNo')}</button><button class="btn pri" data-ja="yes">${ICON.save}${t('jrAskYes')}</button></div>`;
  box.hidden = false; document.body.classList.add('ja-on');
}
function askHide() { const box = $('jrAsk'); if (box) { box.hidden = true; box.innerHTML = ''; } document.body.classList.remove('ja-on'); }
function askClick(e) {
  const b = e.target.closest('[data-ja]'); if (!b) return;
  if (b.dataset.ja === 'yes') { const m = savePending(); askHide(); if (m) toast(t('jrSaved'), 'green', 9000, () => jvOpen(m.id)); }
  else { dropPending(); askHide(); toast(t('jrDropped'), '', 4000); }
}

/* ---------- список: «Архів поїздок» ---------- */
function listHtml() {
  const L = list();
  if (!L.length) return `<div class="arch-empty">${ICON.archive}<div>${t('jrEmpty')}</div></div>`;
  // рядок цілком — кнопка «відкрити на карті» (окремої кнопки немає: тексту лишається більше місця); кошик — праворуч
  return `<div class="muted arch-hint">${t('jrHint')}</div><div class="list arch jr-list">` + L.map(m => `<div class="item" data-jopen="${esc(m.id)}" role="button" tabindex="0" aria-label="${esc(t('open') + ': ' + (m.title || ''))}"><div class="grow"><div class="t">${esc(m.title || '')}</div>
      <div class="muted">${esc([dayOf(m.t0) + ', ' + clockOf(m.t0), brief(m)].join(' · '))}</div><div class="muted jr-note">${esc([t('jrAvg', kmh(m.avg)), estNote(m), m.sim ? t('jrSim') : ''].filter(Boolean).join(' · '))}</div></div>
    <button class="btn sm arch-del" data-jdel="${esc(m.id)}" aria-label="${t('delete')}">${ICON.trash}</button></div>`).join('') + '</div>';
}
async function listClick(e) {
  const del = e.target.closest('[data-jdel]');
  if (del) { const undo = await remove(del.dataset.jdel); if (undo) toast(t('jrDeleted'), '', 7000, () => { undo(); toast(t('jrRestored'), 'green', 3000); }); return; }
  const op = e.target.closest('[data-jopen]'); if (op) jvOpen(op.dataset.jopen);
}
definePanel('journeys', {
  title: () => t('jrTitle'), back: 'settings',
  render(body) { body.innerHTML = listHtml(); body.onclick = listClick; body.oninput = null; body.onfocusin = null; },
  update(body) { body.innerHTML = listHtml(); }
});
/** Кнопка в «Налаштуваннях»: «Архів поїздок» із кількістю. */
export const journeysBtnHtml = () => `<div class="btns jr-entry"><button class="btn wide" data-act="journeys">${ICON.archive}<span>${t('jrTitle')}</span>${jr.list.length ? `<i>${jr.list.length}</i>` : ''}</button></div>`;

/* ---------- одна поїздка на карті ---------- */
const jv = { m: null, pts: null, prof: [], cum: null, sel: -1, min: false };
export const jvIsOpen = () => !!jv.m;
function chartHtml() {
  const P = jv.prof, W = 320, H = 64, top = Math.max(60, Math.ceil(Math.max(...P.map(x => x.v), 1) / 10) * 10), x = k => (k / (P.length - 1) * W), y = v => H - 2 - Math.min(1, v / top) * (H - 8);
  let area = `M0 ${H}`, lines = '', est = '';
  P.forEach((p, k) => { area += `L${x(k).toFixed(1)} ${y(p.v).toFixed(1)}`; });
  area += `L${W} ${H}Z`;
  for (let k = 1; k < P.length; k++) lines += `<path d="M${x(k - 1).toFixed(1)} ${y(P[k - 1].v).toFixed(1)}L${x(k).toFixed(1)} ${y(P[k].v).toFixed(1)}" stroke="${SPEED_COLORS[bucket(P[k].v)]}"/>`;
  for (let k = 0, a = -1; k <= P.length; k++) { const e = k < P.length && P[k].e; if (e && a < 0) a = k; if (!e && a >= 0) { est += `<rect x="${x(Math.max(0, a - 1)).toFixed(1)}" y="0" width="${(x(k - 1) - x(Math.max(0, a - 1))).toFixed(1)}" height="${H}"/>`; a = -1; } }
  return `<div class="jv-chart" id="jvChart" data-top="${top}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><g class="jc-est">${est}</g><path class="jc-area" d="${area}"/><path class="jc-mid" d="M0 ${y(top / 2).toFixed(1)}H${W}"/><g class="jc-line">${lines}</g></svg>
      <i class="jc-cur" id="jvCur" hidden></i><span class="jc-top">${top}</span><span class="jc-half">${top / 2}</span></div>`;
}
function readout() {
  const el = $('jvRead'); if (!el) return;
  if (jv.sel < 0) { el.textContent = t('jvPickHint'); el.classList.add('muted'); return; }
  const p = atDist(jv.pts, jv.cum, jv.sel);
  el.classList.remove('muted');
  el.textContent = [clockOf(p.t), kmh(p.v), t('jvFromStart', fmtDist(p.d)), p.e ? t('jvNoGps') : ''].filter(Boolean).join(' · ');
}
// вибране місце — відстань від старту (м): між записаними точками інтерполюємо, тож курсор стоїть рівно під пальцем
function select(d) {
  const total = jv.cum[jv.cum.length - 1] || 1; jv.sel = Math.max(0, Math.min(total, d));
  const p = atDist(jv.pts, jv.cum, jv.sel);
  journeyMark([p.lat, p.lon]);
  const cur = $('jvCur'); if (cur) { cur.hidden = false; cur.style.left = (jv.sel / total * 100).toFixed(2) + '%'; }
  readout();
}
function chartPick(e) {
  const box = $('jvChart'); if (!box || !jv.pts) return;
  const r = box.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  select(f * jv.cum[jv.cum.length - 1]);
}
function html() {
  const m = jv.m, cell = (v, l) => `<div><b>${esc(v)}</b><small>${esc(l)}</small></div>`, share = m.dist > 0 ? Math.round(m.est / m.dist * 100) : 0;
  const B = JR.BUCKETS, lg = [t('jvTo', B[0]), `${B[0]}–${B[1]}`, `${B[1]}–${B[2]}`, `${B[2]}–${B[3]}`, `${B[3]}+`];
  return `<div class="rp-zoom jv-zoom"><button data-jv="zin" aria-label="${t('qZoomIn')}">+</button><button data-jv="zout" aria-label="${t('qZoomOut')}">−</button><button data-jv="fit" aria-label="${t('rpFit')}">${ICON.route}</button></div>
    <button class="jv-head" data-jv="min" aria-expanded="${!jv.min}"><span class="grow"><b>${esc(m.title || '')}</b><small>${esc(`${dayOf(m.t0)}, ${clockOf(m.t0)} – ${clockOf(m.t1)}${m.sim ? ' · ' + t('jrSim') : ''}`)}</small></span><em>${ICON.down}</em></button>
    <div class="jv-body">
      <div class="jv-kv">${cell(fmtDist(m.dist), t('jvDist'))}${cell(fmtDur(m.dur), t('jvDur'))}${cell(fmtDur(m.moving), t('jvMoving'))}${cell(kmh(m.avg), t('jvAvg'))}${cell(m.max ? kmh(m.max) : '—', t('jvMax'))}${cell(m.est >= 200 ? `${fmtDist(m.est)} · ${share} %` : t('jvEstNone'), t('jvEst'))}</div>
      <div class="jv-stops"><span>${m.stops ? t('jvStops', m.stops, fmtDur(m.stopS)) : t('jvStopsNone')}</span>${m.est >= 200 ? `<span class="est"><i></i>${t('jvNoGps')}</span>` : ''}</div>
      ${chartHtml()}
      <div class="jv-read muted" id="jvRead">${t('jvPickHint')}</div>
      <div class="jv-legend" aria-label="${t('jvLegend')}">${lg.map((x, i) => `<span><i style="background:${SPEED_COLORS[i]}"></i>${esc(x)}</span>`).join('')}</div>
    </div>
    <div class="jv-btns"><button class="btn sm" data-jv="gpx">GPX</button><button class="btn sm arch-del" data-jv="del" aria-label="${t('delete')}">${ICON.trash}</button></div>
    <button class="pl-ok" data-jv="done" aria-label="${t('done')}">${ICON.check}</button>`;
}
function fit() { const box = $('jv'); if (!box) return; requestAnimationFrame(() => fitJourney(26, box.getBoundingClientRect().height + 30)); }
/** Відкрити поїздку з архіву на карті. */
export async function jvOpen(id) {
  const d = await load(id); if (!d) { toast(t('jvGone'), 'yellow', 5000); return; }
  if (currentPanel()) closePanel();
  jv.m = d.meta; jv.pts = d.pts; jv.prof = profile(d.pts, 160); jv.cum = cumDist(d.pts); jv.sel = -1; jv.min = false;
  const box = $('jv'); box.innerHTML = html(); box.classList.remove('min'); box.hidden = false; document.body.classList.add('jv-on');
  showJourney(d.pts); onJourneyTap(mapTap); fit();
  bus.emit('journeyView', true);
}
/** Закрити перегляд. back = true — назад до списку поїздок, інакше — на карту. */
export function jvClose(back = true) {
  if (!jv.m) return;
  jv.m = null; jv.pts = null; jv.prof = []; jv.cum = null; jv.sel = -1;
  const box = $('jv'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('jv-on');
  onJourneyTap(null); showJourney(null); setFollow(true);
  bus.emit('journeyView', false);
  if (back) openPanel('journeys');
}
// дотик до лінії на карті — та сама точка на графіку
function mapTap({ lat, lon, px }) {
  if (!jv.pts) return; const n = nearestOn(jv.pts, lat, lon);
  if (n.i >= 1 && n.d <= Math.max(30, px * 30)) select(jv.cum[n.i - 1] + (jv.cum[n.i] - jv.cum[n.i - 1]) * n.f);
}
async function click(e) {
  const b = e.target.closest('[data-jv]'); if (!b || !jv.m) return;
  const k = b.dataset.jv;
  if (k === 'zin' || k === 'zout') zoomBy(k === 'zin' ? 1 : -1);
  else if (k === 'fit') fit();
  else if (k === 'min') { jv.min = !jv.min; $('jv').classList.toggle('min', jv.min); b.setAttribute('aria-expanded', String(!jv.min)); }
  else if (k === 'gpx') { const n = exportGpx(jv.m, jv.pts); toast(n ? t('jvGpxSaved', n) : t('jvGpxFail'), n ? 'green' : 'yellow', 6000); }
  else if (k === 'del') { const undo = await remove(jv.m.id); jvClose(true); if (undo) toast(t('jrDeleted'), '', 7000, () => { undo(); toast(t('jrRestored'), 'green', 3000); }); }
  else if (k === 'done') jvClose(true);
}

export function initJourneyUi() {
  const ask = $('jrAsk'), box = $('jv');
  if (ask) ask.onclick = askClick;
  if (box) {
    box.onclick = click;
    let drag = false;
    box.addEventListener('pointerdown', e => { if (e.target.closest('#jvChart')) { drag = true; chartPick(e); try { e.target.setPointerCapture(e.pointerId); } catch (_) {} } });
    box.addEventListener('pointermove', e => { if (drag) chartPick(e); });
    const end = () => { drag = false; }; box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  }
  bus.on('journeyDone', p => askShow(p));
  bus.on('journeyAuto', m => { askHide(); if (m) toast(t('jrAutoSaved'), 'green', 7000, () => openPanel('journeys')); });
  bus.on('journeys', () => refresh('journeys'));
  if (jr.pending) askShow(jr.pending);
}
