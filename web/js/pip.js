// Вікно поверх інших програм (1.1.27) — як у Google Maps: під час рейсу водій іде з «Рейсу» (дзвінок, повідомлення, інша програма) —
// навігатор не зникає, а лишається маленьким вікном поверх усього. Саме вікно робить оболонка Android (№8 і новіша): вона ж дає міняти
// його розмір двома пальцями й розгортати назад. Тут — що в цьому вікні видно: карта, стрілка маневру, скільки до нього, і рядок
// «лишилось · час прибуття». Кнопок немає: дотики до такого вікна дістаються системі, а не програмі.
import { bus, S, fmtDist, fmtClock, log } from './core.js';
import * as P from './platform.js';
import { g } from './guide.js';
import { $, esc } from './ui_base.js';
import { t } from './i18n.js';
import { setPipView } from './map.js';

export const pip = { on: false, want: false, capable: false };
/** Сказати оболонці, чи вікно потрібне: рейс іде й у налаштуваннях дозволено. */
export function sync() {
  pip.capable = P.pipCapable();
  const want = S.pip !== false && !!g.active && !!g.trip;
  if (want === pip.want && pip.sent) return;
  pip.sent = true; pip.want = want;
  if (pip.capable) { const ok = P.setPip(want); if (want && !ok) log('info', 'вікно поверх інших програм: телефон не підтримує'); }
}
let key = '';
function draw() {
  if (!pip.on) return;
  const box = $('pipView'); if (!box) return;
  const man = $('man'), manOn = man && !man.hidden, info = manOn && man.classList.contains('info');
  const ico = manOn ? $('manIco').innerHTML : '', dist = manOn ? $('manDist').textContent : fmtClock(new Date());
  const sub = g.arrived ? ((g.trip && g.trip.b && g.trip.b.label) || '') : g.active && g.route ? `${fmtDist(g.remain)} · ${fmtClock(new Date(g.eta))}` : t('pipNoTrip');
  const k = [dist, sub, info, g.offRoute, ico].join('|'); if (k === key) return; key = k;   // сам малюнок стрілки, а не його довжина: «ліворуч» і «праворуч» однакові завдовжки
  box.className = (info ? 'info' : '') + (g.offRoute ? ' off' : '');
  box.innerHTML = `${ico ? `<span class="pv-ico">${ico}</span>` : ''}<span class="pv-t"><b>${esc(dist)}</b><small>${esc(sub)}</small></span>`;
}
/** Оболонка повідомила: програма у вікні / знову на весь екран. */
export function setOn(on) {
  on = !!on; if (on === pip.on) return;
  pip.on = on; key = '';
  document.body.classList.toggle('pip', on);
  const box = $('pipView'); if (box) box.hidden = !on;
  setPipView(on);
  if (on) draw();
  try { window.dispatchEvent(new Event('resize')); } catch (_) {}      // розміри плашок і карти перераховуємо одразу (вікно стало іншим)
  bus.emit('pip', on);
}
export function init() {
  bus.on('native:pip', d => setOn(!!(d && d.on)));
  bus.on('trip', sync); bus.on('arrived', sync);
  bus.on('settings', k => { if (k === 'pip') sync(); });
  bus.on('guide', draw); bus.on('pos', draw);
  setInterval(() => { sync(); draw(); }, 1000);     // sync — страховка: рейс могли завершити шляхом, що не шле події
  sync();
}
