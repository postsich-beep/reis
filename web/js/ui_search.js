// (1.1.29) Пошук адреси чи місця — як у Google Maps, усе українською.
// Без рейсу — рядок «Пошук адреси чи місця» згори карти; у рейсі — лупа праворуч (під кнопкою звуку).
// Екран пошуку: «Дім», «Робота», недавні; поки набираєте — населені пункти з довідника в телефоні (миттєво, без інтернету) і адреси,
// вулиці, місця з сервера. Під вулицею без номера — «Вказати номер будинку». Дотик до результату — місце на карті й картка:
// без рейсу «Їхати сюди», у рейсі «Заїхати по дорозі»; «Зберегти як Дім / Роботу». Просто подивитись, де це, — теж можна.
import { bus, S, log, fmtDist, hav } from './core.js';
import { $, ICON, esc, toast, closePanel, currentPanel } from './ui_base.js';
import { t } from './i18n.js';
import { g, setVia } from './guide.js';
import { pos } from './nav.js';
import * as P from './platform.js';
import * as places from './places.js';
import { geocode, normName } from './route.js';
import * as mapM from './map.js';
import { routeTo, quickOpen } from './ui.js';

const sr = { open: false, q: '', res: [], busy: false, err: '', ctx: null, setFor: null, seq: 0, card: null };
let timer = 0;
// схоже на адресу (цифри, «вул», «просп»…) — тоді спершу адреси з сервера, а не населені пункти
const ADDR = /\d|вул|просп|пров|пл\.|бульв|шосе|ул\.|улиц|street|майдан|узвіз|тупик|проїзд/i;
const near = (a, b) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.015 && normName(a.label) === normName(b.label);
const hw = k => S[k] && S[k].lat != null ? S[k] : null;

/* ---------- екран пошуку ---------- */
export function openSearch(setFor = null) {
  if (currentPanel()) closePanel();
  quickOpen(false); closeCard(false);
  sr.open = true; sr.setFor = setFor; sr.q = ''; sr.res = []; sr.err = ''; sr.ctx = null;
  const box = $('search'); box.hidden = false; document.body.classList.add('sr-on');
  box.innerHTML = `<div class="sr-head"><button class="sr-back" data-sr="back" aria-label="${t('srBack')}">${ICON.arrowL}</button>
    <input id="srIn" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(t(setFor ? (setFor === 'home' ? 'srFindHome' : 'srFindWork') : 'srPh'))}">
    <button class="sr-clr" data-sr="clr" aria-label="${t('clear')}" hidden>${ICON.x}</button></div><div class="sr-body" id="srBody"></div>`;
  const inp = $('srIn');
  inp.addEventListener('input', () => { sr.q = inp.value; $('search').querySelector('.sr-clr').hidden = !inp.value; if (!inp.value.trim()) sr.ctx = null; schedule(); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); inp.blur(); } });
  render();
  setTimeout(() => { try { inp.focus(); } catch (_) {} }, 60);
}
export function closeSearch() {
  if (!sr.open) return;
  sr.open = false; sr.setFor = null; clearTimeout(timer); sr.seq++;
  const box = $('search'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('sr-on');
}
export const searchOpen = () => sr.open;

function schedule() { clearTimeout(timer); render(); timer = setTimeout(run, 320); }
async function run() {
  const raw = sr.q.trim(), my = ++sr.seq;
  if (!raw) { sr.res = []; sr.busy = false; sr.err = ''; return render(); }
  await places.load();
  if (my !== sr.seq) return;
  // «Вказати номер будинку»: шукаємо в тому самому місті, що й вулиця
  const ctx = sr.ctx, q = ctx && ctx.city && !normName(raw).includes(normName(ctx.city)) ? raw + ', ' + ctx.city : raw;
  const local = ADDR.test(raw) ? places.search(raw, 3) : places.search(raw, 6);
  sr.res = local; sr.err = ''; sr.busy = raw.length >= 3 && P.online(); render();
  if (!sr.busy) { if (raw.length >= 3 && !P.online()) { sr.err = t('srOffline'); render(); } return; }
  let remote = [];
  try { remote = await geocode(q, ctx || (pos.lat != null ? pos : null)); }
  catch (e) { log('warn', 'пошук: ' + e.message); if (my === sr.seq) sr.err = t('srNetErr'); }
  if (my !== sr.seq) return;
  const rem = remote.filter(r => !local.some(l => near(l, r)));
  sr.res = ADDR.test(raw) ? rem.concat(local) : local.concat(rem);
  sr.res = sr.res.slice(0, 12); sr.busy = false; render();
}

function rowHtml(r, i, ico) {
  const d = pos.lat != null ? fmtDist(hav(pos, r)) : '';
  return `<div class="sr-item"><button class="sr-row" data-sri="${i}"><span class="sr-ico">${ico}</span><span class="sr-tx"><b>${esc(r.label)}</b><small>${esc(r.sub || '')}</small></span>${d ? `<span class="sr-d">${d}</span>` : ''}</button>
    ${r.street ? `<button class="sr-house" data-srh="${i}">${ICON.plus}<span>${t('srHouse')}</span></button>` : ''}</div>`;
}
function render() {
  const body = $('srBody'); if (!body) return;
  const q = sr.q.trim();
  if (!q) {
    const rec = places.recent();
    sr.res = rec;
    const tile = (k, ico) => { const v = hw(k); return `<button class="sr-hw" data-srk="${k}"><span class="sr-hw-i">${ico}</span><span class="sr-tx"><b>${t(k === 'home' ? 'srHome' : 'srWork')}</b><small>${esc(v ? v.label : t('srAdd'))}</small></span></button>`; };
    body.innerHTML = (sr.setFor ? `<div class="sr-set">${t(sr.setFor === 'home' ? 'srSetHome' : 'srSetWork')}</div>` : `<div class="sr-hws">${tile('home', ICON.home)}${tile('work', ICON.work)}</div>`) +
      (sr.setFor && pos.lat != null ? `<div class="sr-item"><button class="sr-row" data-srme="1"><span class="sr-ico me">${ICON.pin}</span><span class="sr-tx"><b>${t('srMyPlace')}</b><small>${t('srMyPlaceSub')}</small></span></button></div>` : '') +
      (rec.length ? `<div class="sr-sec">${t('srRecent')}</div>` + rec.map((r, i) => rowHtml(r, i, ICON.clock)).join('') : `<div class="sr-empty">${t('srHint')}</div>`);
    return;
  }
  body.innerHTML = sr.res.map((r, i) => rowHtml(r, i, ICON.pin)).join('') +
    (sr.busy ? `<div class="sr-wait">${t('srBusy')}</div>` : '') +
    (!sr.busy && sr.err ? `<div class="sr-err">${esc(sr.err)}</div>` : '') +
    (!sr.busy && !sr.err && !sr.res.length && q.length >= 2 ? `<div class="sr-empty">${t('srNone', esc(q))}</div>` : '') +
    (!sr.busy && !sr.err && !sr.res.length && q.length < 2 ? `<div class="sr-empty">${t('srMore')}</div>` : '');
}

function choose(r) {
  const p = { lat: r.lat, lon: r.lon, label: r.label, sub: r.sub || '' };
  if (sr.setFor) {                                            // шукали адресу дому чи роботи — зберігаємо й лишаємось у пошуку
    const k = sr.setFor; S[k] = p; toast(t(k === 'home' ? 'srHomeSaved' : 'srWorkSaved', p.label), 'green', 4000);
    closeSearch(); openSearch(); return;
  }
  places.remember(p);
  closeSearch(); showCard(p);
}
function onSearchClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.sr === 'back') { if (sr.setFor) { closeSearch(); openSearch(); } else closeSearch(); return; }
  if (d.sr === 'clr') { const i = $('srIn'); i.value = ''; sr.q = ''; sr.ctx = null; b.hidden = true; i.focus(); schedule(); return; }
  if (d.srk) { const v = hw(d.srk); if (v) choose(v); else { closeSearch(); openSearch(d.srk); } return; }
  if (d.srme) { if (pos.lat != null) choose({ lat: pos.lat, lon: pos.lon, label: t('srMyPlace'), sub: [pos.lat.toFixed(5), pos.lon.toFixed(5)].join(', ') }); return; }
  if (d.srh != null) { const r = sr.res[+d.srh]; if (!r) return; const i = $('srIn'); sr.ctx = { city: r.city || '', lat: r.lat, lon: r.lon }; i.value = r.label + ' '; sr.q = i.value; $('search').querySelector('.sr-clr').hidden = false; i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} schedule(); return; }
  if (d.sri != null) { const r = sr.res[+d.sri]; if (r) choose(r); }
}

/* ---------- знайдене місце на карті: картка ---------- */
function cardHtml(p) {
  const d = pos.lat != null ? fmtDist(hav(pos, p)) : '';
  const isH = k => { const v = hw(k); return v && Math.abs(v.lat - p.lat) < 1e-5 && Math.abs(v.lon - p.lon) < 1e-5; };
  const main = g.active ? `<button class="btn pri" data-src="via">${ICON.route}<span>${t('srVia')}</span></button>` : `<button class="btn pri" data-src="go">${ICON.go}<span>${t('srGo')}</span></button>`;
  return `<div class="src-t"><span class="src-pin">${ICON.pin}</span><div class="src-tx"><b>${esc(p.label)}</b><small>${esc([p.sub, d ? t('srFromMe', d) : ''].filter(Boolean).join(' · '))}</small></div>
    <button class="src-x" data-src="x" aria-label="${t('close')}">${ICON.x}</button></div>
    <div class="src-b">${main}<button class="btn sm${isH('home') ? ' on' : ''}" data-src="home" aria-label="${t('srSaveHome')}">${ICON.home}<span>${t('srHome')}</span></button><button class="btn sm${isH('work') ? ' on' : ''}" data-src="work" aria-label="${t('srSaveWork')}">${ICON.work}<span>${t('srWork')}</span></button></div>`;
}
export function showCard(p) {
  sr.card = p;
  const box = $('srCard'); box.innerHTML = cardHtml(p); box.hidden = false; document.body.classList.add('src-on');
  // точка — посередині вільної частини карти (над карткою); карта стоїть на місці, поки картка відкрита
  const top = $('top').getBoundingClientRect().bottom, bot = box.getBoundingClientRect().top, H = window.innerHeight;
  mapM.showPick(p); mapM.flyTo(p, 15, Math.max(0, H / 2 - (top + bot) / 2)); mapM.view.lastTouch = Date.now() + 3600e3;
}
export function closeCard(follow = true) {
  if (!sr.card) return;
  sr.card = null; const box = $('srCard'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('src-on');
  mapM.showPick(null);
  if (follow) mapM.setFollow(true);
}
function onCardClick(e) {
  const b = e.target.closest('button'); if (!b || !sr.card) return;
  const p = sr.card, k = b.dataset.src;
  if (k === 'x') { closeCard(); return; }
  if (k === 'go') { closeCard(false); routeTo(p); return; }
  if (k === 'via') { closeCard(); setVia(p); toast(t('stopViaOk', p.label), 'green', 5000); return; }
  if (k === 'home' || k === 'work') { S[k] = { lat: p.lat, lon: p.lon, label: p.label, sub: p.sub || '' }; toast(t(k === 'home' ? 'srHomeSaved' : 'srWorkSaved', p.label), 'green', 4000); $('srCard').innerHTML = cardHtml(p); }
}

let wasActive = null;
function syncTrip() {
  const a = !!g.active; if (a === wasActive) return; wasActive = a;
  document.body.classList.toggle('trip-on', a);
  if (sr.card && !$('srCard').hidden) $('srCard').innerHTML = cardHtml(sr.card);      // рейс почався чи скінчився — інша головна кнопка
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));             // у рейсі праворуч з'являється лупа — перерахувати місце кнопок
}

export function initSearch() {
  $('srBar').addEventListener('click', () => openSearch());
  $('bSearch').addEventListener('click', e => { e.stopPropagation(); openSearch(); });
  $('search').addEventListener('click', onSearchClick);
  $('srCard').addEventListener('click', onCardClick);
  bus.on('trip', syncTrip); bus.on('arrived', syncTrip); syncTrip();
  setInterval(syncTrip, 2000);
  bus.on('panel', name => { if (name) { closeSearch(); closeCard(false); } });
  // системна «Назад»: спершу пошук, потім картка знайденого місця
  const prev = window.__reisBack;
  window.__reisBack = () => {
    if (sr.open) { if (sr.setFor) { closeSearch(); openSearch(); } else closeSearch(); return true; }
    if (sr.card) { closeCard(); return true; }
    return prev ? prev() : false;
  };
}
