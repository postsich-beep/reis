// (1.1.28) Пропозиція перебудувати маршрут. У дорозі маршрут сам не міняється: якщо водій з'їхав із рейсу (чи сталося щось інше),
// над нижньою плашкою з'являється картка — що сталося й що пропонуємо, — це саме читає голос, і йде зворотний відлік.
// «Перебудувати» — будуємо новий шлях; «Лишити» або час вийшов — ведемо далі запланованим рейсом.
import { bus } from './core.js';
import { $, ICON, esc, toast } from './ui_base.js';
import { t } from './i18n.js';
import { g, answerOffer, offerOffRoute } from './guide.js';

let tick = 0, shown = 0;
const left = o => Math.max(0, Math.ceil((o.until - Date.now()) / 1000));

function show(o) {
  const box = $('rrAsk'); if (!box) return;
  shown = o.id;
  // дії з картки (для з'їзду: «Новий маршрут» і «Назад на рейс») — дві великі кнопки; під ними — «Лишити як є» з лічильником:
  // саме це й станеться, коли час вийде
  // (1.1.37) o.def — дія, яка станеться сама, коли час вийде («Новий маршрут звідси»): тоді лічильник стоїть на ній, а «Лишити як є» —
  // звичайна кнопка поруч із «Назад на рейс»
  const def = o.def;
  const acts = (o.actions || []).map(a => `<button class="btn${a.pri ? ' pri' : ''}" data-rr="${esc(a.id)}">${a.id === 'new' ? ICON.route : ''}<span>${esc(a.label)}</span></button>`).join('') +
    (def ? `<button class="btn" data-rr="no"><span>${t('rrNo')}</span></button>` : '');
  box.innerHTML = `<div class="rr-t"><span class="rr-ico">${ICON.warn || ''}</span><div class="rr-tx"><b>${esc(o.title)}</b><small>${esc(o.text)}</small></div></div>
    <div class="rr-b">${acts}</div>
    <button class="btn rr-no${def ? ' pri rr-def' : ''}" data-rr="${def ? esc(def.id) : 'no'}">${def ? ICON.route : ''}<span>${def ? esc(def.label) : t('rrNo')}</span><i class="rr-sec" id="rrSec">${left(o)}</i></button>
    <i class="rr-bar"><i style="animation-duration:${o.secs}s"></i></i>`;
  box.hidden = false; document.body.classList.add('rr-on');
  clearInterval(tick); tick = setInterval(() => { const s = $('rrSec'); if (!g.offer || g.offer.id !== shown) return hide(); if (s) s.textContent = left(g.offer); }, 250);
}
function hide() {
  clearInterval(tick); tick = 0; shown = 0;
  const box = $('rrAsk'); if (box) { box.hidden = true; box.innerHTML = ''; }
  document.body.classList.remove('rr-on');
}

export function initOfferUi() {
  const box = $('rrAsk'); if (!box) return;
  box.addEventListener('click', e => { const b = e.target.closest('[data-rr]'); if (b) answerOffer(b.dataset.rr === 'no' ? null : b.dataset.rr); });
  bus.on('offer', o => { if (o) show(o); });
  bus.on('offerEnd', e => {
    hide();
    // Не підтвердили (чи натиснули «Лишити»): коротко кажемо, що маршрут той самий і як перебудувати, якщо все-таки треба
    if (e && (e.why === 'no' || (e.why === 'timeout' && !(e.offer && e.offer.def)))) toast(t('rrStayToast'), '', 6000);
  });
  // (1.1.37) самі перебудували після з'їзду: новий шлях звідси чи повернення на вибраний рейс
  bus.on('autoRoute', e => { if (e) toast(e.kind === 'chosen' ? t('autoBack') : t('autoNew', e.km), 'green', 6000); });
  bus.on('autoFail', e => toast(t(e && e.net ? 'autoNet' : 'autoFail'), e && e.net ? 'yellow' : 'red', 8000));
  bus.on('choiceEnd', e => {
    if (!e) return;
    if (e.why === 'fail') toast(t('rrFail'), 'red', 7000);
    else if (e.why === 'timeout' || e.why === 'no') toast(t('rrStayToast'), '', 6000);
  });
  bus.on('offerNoNet', () => toast(t('rrNoNet'), 'yellow', 6000));
  bus.on('trip', () => { if (!g.active) hide(); });
  // Дотик до плашки «Ви зійшли з рейсу» — спитати ще раз (якщо водій передумав або не встиг відповісти)
  const man = $('man');
  if (man) man.addEventListener('click', e => { if (g.active && g.offRoute && !g.offer && !g.choice && !g.rerouting && !e.target.closest('#manSnap')) offerOffRoute(true); });
}
