// (1.1.29) Пошук адреси чи місця — як у Google Maps, усе українською.
// Без рейсу — рядок «Пошук адреси чи місця» згори карти; у рейсі — лупа праворуч (під кнопкою звуку).
// Екран пошуку: «Дім», «Робота», недавні; поки набираєте — населені пункти з довідника в телефоні (миттєво, без інтернету) і адреси,
// вулиці, місця з сервера. Під вулицею без номера — «Вказати номер будинку». Дотик до результату — місце на карті й картка:
// без рейсу «Їхати сюди», у рейсі «Заїхати по дорозі»; «Зберегти як Дім / Роботу». Просто подивитись, де це, — теж можна.
import { bus, S, log, fmtDist, hav } from './core.js';
import { $, ICON, esc, toast, closePanel, currentPanel } from './ui_base.js';
import * as favs from './favs.js';
import { t } from './i18n.js';
import { g, setVia } from './guide.js';
import { pos } from './nav.js';
import * as P from './platform.js';
import * as places from './places.js';
import { geocode, normName, rankPlaces } from './route.js';
import * as mapM from './map.js';
import { routeTo, quickOpen } from './ui.js';

const sr = { open: false, q: '', res: [], busy: false, err: '', ctx: null, setFor: null, pick: null, seq: 0, card: null, city: null, rest: '' };
let timer = 0;
// схоже на адресу (цифри, «вул», «просп»…) — тоді спершу адреси з сервера, а не населені пункти
const ADDR = /\d|вул|просп|пров|пл\.|бульв|шосе|ул\.|улиц|street|майдан|узвіз|тупик|проїзд/i;
const near = (a, b) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.015 && normName(a.label) === normName(b.label);
const hw = k => S[k] && S[k].lat != null ? S[k] : null;

/* ---------- екран пошуку ---------- */
// setFor: 'home' | 'work' — шукаємо адресу дому чи роботи (зберігаємо й лишаємось у пошуку).
// (1.1.36) pick: { ph, hint, done(p, me), back() } — місце вибирає інший екран («Улюблені місця»: додати місце, змінити адресу, Дім, Робота):
// торкнулись результату — пошук закривається й викликається done; «назад» — back. Карта під пошуком тут не потрібна (місто не «вгадуємо»).
export function openSearch(setFor = null, pick = null) {
  if (currentPanel()) closePanel();
  quickOpen(false); closeCard(false);
  sr.open = true; sr.setFor = setFor; sr.pick = pick; sr.q = ''; sr.res = []; sr.err = ''; sr.ctx = null; cityMode(null);
  const box = $('search'); box.hidden = false; document.body.classList.add('sr-on');
  box.innerHTML = `<div class="sr-head"><button class="sr-back" data-sr="back" aria-label="${t('srBack')}">${ICON.arrowL}</button>
    <input id="srIn" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(pick ? pick.ph : t(setFor ? (setFor === 'home' ? 'srFindHome' : 'srFindWork') : 'srPh'))}">
    <button class="sr-clr" data-sr="clr" aria-label="${t('clear')}" hidden>${ICON.x}</button></div><div class="sr-body" id="srBody"></div>`;
  const inp = $('srIn');
  inp.addEventListener('input', () => { sr.q = inp.value; $('search').querySelector('.sr-clr').hidden = !inp.value; if (!inp.value.trim()) sr.ctx = null; schedule(); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); inp.blur(); } });
  render();
  setTimeout(() => { try { inp.focus(); } catch (_) {} }, 60);
}
export function closeSearch() {
  if (!sr.open) return;
  sr.open = false; sr.setFor = null; sr.pick = null; clearTimeout(timer); sr.seq++;
  const box = $('search'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('sr-on');
  cityMode(null); zbSync();
}
/* ---------- (1.1.32) набрали місто — карта одразу там; далі вулиці шукаємо в ньому ----------
   «Київ» (чи «Кие», «Львів», «николаев») — щойно місто вгадано, карта переноситься туди, а список стає меншим і карту під ним видно.
   Далі пишете вулицю: «Київ, Хрещатик» чи «Київ хрещатик» — шукаємо в цьому місті. Можна й просто затримати палець на карті:
   поставити точку, прокласти маршрут. Праворуч — повзунок масштабу (не всім зручно двома пальцями). */
const CITY_Z = { c: 11.6, t: 13.2, v: 14.4 };
function refPt() { const mc = mapM.map && mapM.map.getCenter ? mapM.map.getCenter() : null; return pos.lat != null ? pos : mc ? { lat: mc.lat, lon: mc.lng } : null; }
// Місто на початку набраного: повертає { city, rest } — rest — решта тексту (вулиця, адреса) або ''.
// Вгадуємо місто чи селище (від 3 літер — з початку назви), а село — лише за повною назвою: сіл тисячі, карта не має стрибати від кожної літери.
function cityOf(raw) {
  const words = raw.trim().split(/[\s,]+/).filter(Boolean);
  for (let k = words.length; k >= 1; k--) {
    const cand = words.slice(0, k).join(' '); if (cand.replace(/[^\p{L}]/gu, '').length < 3) break;      // від 3 літер (normName ковтає частину літер — рахуємо самі літери)
    const rest = words.slice(k).join(' ');
    if (sr.city && normName(sr.city.label) === normName(cand)) return { city: sr.city, rest };
    const top = places.search(cand, 4)[0]; if (!top) continue;
    const full = top.m === 3, ok = k === words.length ? (full || (top.m === 2 && (top.kind === 'c' || top.kind === 't'))) : full;
    if (ok) return { city: top, rest };
  }
  return null;
}
function cityMode(c) {
  const was = sr.city; sr.city = c || null;
  document.body.classList.toggle('sr-map', !!sr.city && sr.open);
  if (sr.city && (!was || was.lat !== sr.city.lat || was.lon !== sr.city.lon)) flyCity(sr.city);
  zbSync();
}
function flyCity(c) {
  requestAnimationFrame(() => {
    const body = $('srBody'), head = $('search').querySelector('.sr-head'), H = window.innerHeight;
    const top = Math.max(head ? head.getBoundingClientRect().bottom : 0, body && body.offsetHeight ? body.getBoundingClientRect().bottom : 0);
    const bot = document.body.classList.contains('kb') ? H : $('bottom').getBoundingClientRect().top;
    mapM.flyTo(c, CITY_Z[c.kind] || 12, H / 2 - (top + bot) / 2); mapM.view.lastTouch = Date.now() + 3600e3;
  });
}
export const searchOpen = () => sr.open;

function schedule() { clearTimeout(timer); render(); timer = setTimeout(run, 320); }
async function run() {
  const raw = sr.q.trim(), my = ++sr.seq;
  if (!raw) { sr.res = []; sr.busy = false; sr.err = ''; cityMode(null); return render(); }
  await places.load();
  if (my !== sr.seq) return;
  // (1.1.32) місто на початку — карта туди; решта тексту — вулиця в цьому місті
  const cg = sr.setFor || sr.pick || sr.ctx ? null : cityOf(raw);
  cityMode(cg && cg.city); sr.rest = cg ? cg.rest : '';
  // «Вказати номер будинку» / вулиця у вгаданому місті: шукаємо в тому самому місті
  const ctx = sr.ctx || (cg && cg.rest ? { city: cg.city.label, lat: cg.city.lat, lon: cg.city.lon } : null);
  const q = cg && cg.rest ? cg.rest + ', ' + cg.city.label : ctx && ctx.city && !normName(raw).includes(normName(ctx.city)) ? raw + ', ' + ctx.city : raw;
  // від чого міряти відстань: місто вулиці, моє місце, а без GPS — середина карти
  const ref = ctx || refPt();
  const local = cg && cg.rest ? [] : ADDR.test(raw) ? places.search(raw, 3) : places.search(raw, 6);
  sr.res = rankPlaces(local, raw, ref); sr.err = ''; sr.busy = raw.length >= 3 && P.online(); render();
  if (!sr.busy) { if (raw.length >= 3 && !P.online()) { sr.err = t('srOffline'); render(); } return; }
  let remote = [];
  try { remote = await geocode(q, ref); }
  catch (e) { log('warn', 'пошук: ' + e.message); if (my === sr.seq) sr.err = t('srNetErr'); }
  if (my !== sr.seq) return;
  const rem = remote.filter(r => !local.some(l => near(l, r)));
  sr.res = rankPlaces(local.concat(rem), cg && cg.rest ? cg.rest : raw, ref).slice(0, 12); sr.busy = false; render();
}

function rowHtml(r, i, ico) {
  const d = pos.lat != null ? fmtDist(hav(pos, r)) : '';
  const isCity = sr.city && r.local && r.lat === sr.city.lat && r.lon === sr.city.lon && !sr.rest;
  return `<div class="sr-item${isCity ? ' sr-city' : ''}"><button class="sr-row" data-sri="${i}"><span class="sr-ico">${ico}</span><span class="sr-tx"><b>${esc(r.label)}</b><small>${esc(r.sub || '')}</small></span>${d ? `<span class="sr-d">${d}</span>` : ''}</button>
    ${r.street ? `<button class="sr-house" data-srh="${i}">${ICON.plus}<span>${t('srHouse')}</span></button>` : isCity ? `<button class="sr-house" data-srs="${i}">${ICON.search}<span>${t('srStreetIn', r.label)}</span></button>` : ''}</div>`;
}
function render() {
  const body = $('srBody'); if (!body) return;
  requestAnimationFrame(zbSync);
  const q = sr.q.trim();
  if (!q) {
    const rec = places.recent();
    sr.res = rec;
    const tile = (k, ico) => { const v = hw(k); return `<button class="sr-hw" data-srk="${k}"><span class="sr-hw-i">${ico}</span><span class="sr-tx"><b>${t(k === 'home' ? 'srHome' : 'srWork')}</b><small>${esc(v ? v.label : t('srAdd'))}</small></span></button>`; };
    body.innerHTML = (sr.pick ? `<div class="sr-set">${esc(sr.pick.hint)}</div>` : sr.setFor ? `<div class="sr-set">${t(sr.setFor === 'home' ? 'srSetHome' : 'srSetWork')}</div>` : `<div class="sr-hws">${tile('home', ICON.home)}${tile('work', ICON.work)}</div>`) +
      ((sr.setFor || sr.pick) && pos.lat != null ? `<div class="sr-item"><button class="sr-row" data-srme="1"><span class="sr-ico me">${ICON.pin}</span><span class="sr-tx"><b>${t('srMyPlace')}</b><small>${t('srMyPlaceSub')}</small></span></button></div>` : '') +
      (rec.length ? `<div class="sr-sec">${t('srRecent')}</div>` + rec.map((r, i) => rowHtml(r, i, ICON.clock)).join('') : `<div class="sr-empty">${t('srHint')}</div>`);
    return;
  }
  body.innerHTML = sr.res.map((r, i) => rowHtml(r, i, ICON.pin)).join('') +
    (sr.busy ? `<div class="sr-wait">${t('srBusy')}</div>` : '') +
    (!sr.busy && sr.err ? `<div class="sr-err">${esc(sr.err)}</div>` : '') +
    (!sr.busy && !sr.err && !sr.res.length && q.length >= 2 ? `<div class="sr-empty">${t('srNone', esc(q))}</div>` : '') +
    (!sr.busy && !sr.err && !sr.res.length && q.length < 2 ? `<div class="sr-empty">${t('srMore')}</div>` : '');
}

// «Назад» з пошуку: вибирали місце для іншого екрана — назад на нього; шукали адресу дому чи роботи — назад у звичайний пошук
function backOut() {
  if (sr.pick) { const pk = sr.pick; closeSearch(); if (pk.back) pk.back(); }
  else if (sr.setFor) { closeSearch(); openSearch(); }
  else closeSearch();
}
function choose(r) {
  const p = { lat: r.lat, lon: r.lon, label: r.label, sub: r.sub || '' };
  if (sr.pick) { const pk = sr.pick; closeSearch(); pk.done(p, !!r.me); return; }      // місце вибирав інший екран
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
  if (d.sr === 'back') { backOut(); return; }
  if (d.sr === 'clr') { const i = $('srIn'); i.value = ''; sr.q = ''; sr.ctx = null; b.hidden = true; i.focus(); schedule(); return; }
  if (d.srk) { const v = hw(d.srk); if (v) choose(v); else { closeSearch(); openSearch(d.srk); } return; }
  if (d.srme) { if (pos.lat != null) choose({ lat: pos.lat, lon: pos.lon, label: t('srMyPlace'), sub: [pos.lat.toFixed(5), pos.lon.toFixed(5)].join(', '), me: true }); return; }
  if (d.srs != null) { const r = sr.res[+d.srs]; if (!r) return; const i = $('srIn'); i.value = r.label + ', '; sr.q = i.value; $('search').querySelector('.sr-clr').hidden = false; i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} schedule(); return; }
  if (d.srh != null) { const r = sr.res[+d.srh]; if (!r) return; const i = $('srIn'); sr.ctx = { city: r.city || '', lat: r.lat, lon: r.lon }; i.value = r.label + ' '; sr.q = i.value; $('search').querySelector('.sr-clr').hidden = false; i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch (_) {} schedule(); return; }
  if (d.sri != null) { const r = sr.res[+d.sri]; if (r) choose(r); }
}

/* ---------- знайдене місце на карті: картка ---------- */
function cardHtml(p) {
  const d = pos.lat != null ? fmtDist(hav(pos, p)) : '';
  const isH = k => { const v = hw(k); return v && Math.abs(v.lat - p.lat) < 1e-5 && Math.abs(v.lon - p.lon) < 1e-5; };
  const main = g.active ? `<button class="btn pri" data-src="via">${ICON.route}<span>${t('srVia')}</span></button>` : `<button class="btn pri" data-src="go">${ICON.go}<span>${t('srGo')}</span></button>`;
  return `<div class="src-t"><span class="src-pin">${ICON.pin}</span><div class="src-tx"><b>${esc(p.label)}</b><small>${esc([p.sub, d ? t('srFromMe', d) : ''].filter(Boolean).join(' · '))}</small></div>
    <button class="src-fav${favs.has(p) ? ' on' : ''}" data-src="fav" aria-pressed="${favs.has(p)}" aria-label="${t(favs.has(p) ? 'favDelAria' : 'favAddAria')}">${ICON.heart}</button><button class="src-x" data-src="x" aria-label="${t('close')}">${ICON.x}</button></div>
    <div class="src-b">${main}<button class="btn sm${isH('home') ? ' on' : ''}" data-src="home" aria-label="${t('srSaveHome')}">${ICON.home}<span>${t('srHome')}</span></button><button class="btn sm${isH('work') ? ' on' : ''}" data-src="work" aria-label="${t('srSaveWork')}">${ICON.work}<span>${t('srWork')}</span></button></div>`;
}
export function showCard(p) {
  sr.card = p;
  const box = $('srCard'); box.innerHTML = cardHtml(p); box.hidden = false; document.body.classList.add('src-on');
  // точка — посередині вільної частини карти (над карткою); карта стоїть на місці, поки картка відкрита
  const top = $('top').getBoundingClientRect().bottom, bot = box.getBoundingClientRect().top, H = window.innerHeight;
  mapM.showPick(p); mapM.flyTo(p, 15, Math.max(0, H / 2 - (top + bot) / 2)); mapM.view.lastTouch = Date.now() + 3600e3;
  zbSync();
}
export function closeCard(follow = true) {
  if (!sr.card) return;
  sr.card = null; const box = $('srCard'); box.hidden = true; box.innerHTML = ''; document.body.classList.remove('src-on');
  mapM.showPick(null);
  if (follow) mapM.setFollow(true);
  zbSync();
}
function onCardClick(e) {
  const b = e.target.closest('button'); if (!b || !sr.card) return;
  const p = sr.card, k = b.dataset.src;
  if (k === 'x') { closeCard(); return; }
  if (k === 'go') { closeCard(false); routeTo(p); return; }
  if (k === 'via') { closeCard(); setVia(p); toast(t('stopViaOk', p.label), 'green', 5000); return; }
  if (k === 'fav') { const on = favs.toggle(p); toast(on ? t('favAdded', p.label) : t('favRemoved'), on ? 'green' : '', on ? 3000 : 4000, on ? undefined : () => { favs.add(p); $('srCard').innerHTML = cardHtml(p); }); $('srCard').innerHTML = cardHtml(p); return; }
  if (k === 'home' || k === 'work') { S[k] = { lat: p.lat, lon: p.lon, label: p.label, sub: p.sub || '' }; toast(t(k === 'home' ? 'srHomeSaved' : 'srWorkSaved', p.label), 'green', 4000); $('srCard').innerHTML = cardHtml(p); }
}

let wasActive = null;
function syncTrip() {
  const a = !!g.active; if (a === wasActive) return; wasActive = a;
  document.body.classList.toggle('trip-on', a);
  if (sr.card && !$('srCard').hidden) $('srCard').innerHTML = cardHtml(sr.card);      // рейс почався чи скінчився — інша головна кнопка
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));             // у рейсі праворуч з'являється лупа — перерахувати місце кнопок
}

/* ---------- (1.1.32) повзунок масштабу: поки шукаєте на карті (місто вгадано) і поки відкрита картка знайденого місця ----------
   Праворуч, на тій самій осі, що й кнопки та повзунок нахилу; посередині вільної частини карти. Згори «+», знизу «−», між ними дорожка
   з круглою ручкою — як у повзунка нахилу. Тягнути ручку чи торкнутись дорожки — масштаб одразу там. */
const ZB = { min: 5, max: 18 };
let zbDrag = false;
function zbShown() { return (sr.open && !!sr.city) || (!!sr.card && !$('srCard').hidden); }
export function zbSync() {
  const el = $('zoomBar'); if (!el) return;
  const on = zbShown(); if (!on) { el.hidden = true; return; }
  const H = window.innerHeight, kb = document.body.classList.contains('kb');
  let top, bot;
  if (sr.open) { const body = $('srBody'), head = $('search').querySelector('.sr-head'); top = Math.max(head ? head.getBoundingClientRect().bottom : 0, body && body.offsetHeight ? body.getBoundingClientRect().bottom : 0); }
  else { const rl = $('rail'), rr = rl && rl.offsetParent ? rl.getBoundingClientRect() : null; top = Math.max($('top').getBoundingClientRect().bottom, rr && rr.height && rr.left > window.innerWidth / 2 ? rr.bottom : 0); }
  bot = sr.card && !$('srCard').hidden ? $('srCard').getBoundingClientRect().top : kb ? H : $('bottom').getBoundingClientRect().top;
  const pad = 14, avail = bot - top - 2 * pad, h = Math.min(300, avail);
  if (h < 130) { el.hidden = true; return; }           // вільної карти замало (малий екран, відкрита клавіатура) — без повзунка
  el.hidden = false; el.style.top = Math.round(top + pad + (avail - h) / 2) + 'px'; el.style.height = Math.round(h) + 'px';
  zbDraw();
}
function zbDraw() {
  const el = $('zoomBar'); if (!el || el.hidden || !mapM.map) return;
  const z = mapM.map.getZoom(), k = Math.max(0, Math.min(1, (z - ZB.min) / (ZB.max - ZB.min)));
  el.style.setProperty('--zv', k.toFixed(3));
  const tr = el.querySelector('.zb-track'); tr.setAttribute('aria-valuenow', z.toFixed(1)); tr.setAttribute('aria-valuemin', ZB.min); tr.setAttribute('aria-valuemax', ZB.max);
  el.classList.toggle('min', z <= ZB.min + 0.05); el.classList.toggle('max', z >= ZB.max - 0.05);
}
function zbInit() {
  const el = $('zoomBar'); if (!el) return;
  const tr = el.querySelector('.zb-track'), TH = 30;
  el.querySelector('.zb-in').setAttribute('aria-label', t('qZoomIn')); el.querySelector('.zb-out').setAttribute('aria-label', t('qZoomOut')); tr.setAttribute('aria-label', t('zbAria'));
  const zAt = y => { const r = tr.getBoundingClientRect(), k = 1 - (y - r.top - TH / 2) / Math.max(1, r.height - TH); return ZB.min + Math.max(0, Math.min(1, k)) * (ZB.max - ZB.min); };
  const setZ = (z, ms = 0) => { if (!mapM.map) return; mapM.view.lastTouch = Date.now() + 3600e3; mapM.map.easeTo({ zoom: Math.max(ZB.min, Math.min(ZB.max, z)), duration: ms }); };
  tr.addEventListener('pointerdown', e => { zbDrag = true; el.classList.add('drag'); try { tr.setPointerCapture(e.pointerId); } catch (_) {} setZ(zAt(e.clientY)); e.preventDefault(); });
  tr.addEventListener('pointermove', e => { if (zbDrag) setZ(zAt(e.clientY)); });
  const end = () => { if (!zbDrag) return; zbDrag = false; el.classList.remove('drag'); };
  tr.addEventListener('pointerup', end); tr.addEventListener('pointercancel', end); tr.addEventListener('lostpointercapture', end);
  tr.addEventListener('keydown', e => { const d = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0; if (d) { e.preventDefault(); setZ(Math.round(mapM.map.getZoom()) + d, 200); } });
  el.addEventListener('click', e => { const b = e.target.closest('[data-zb]'); if (!b || !mapM.map) return; setZ(Math.round(mapM.map.getZoom() + (b.dataset.zb === 'in' ? 1 : -1)), 250); });
  const hook = () => { if (mapM.map && mapM.map.on) { mapM.map.on('zoom', zbDraw); return true; } return false; };
  if (!hook()) { const tm = setInterval(() => { if (hook()) clearInterval(tm); }, 500); }
  window.addEventListener('resize', () => requestAnimationFrame(zbSync));
}

export function initSearch() {
  zbInit();
  // (1.1.32) шукаємо на карті й затримали на ній палець — пошук ховаємо, лишається меню точки (поставити, прокласти маршрут)
  bus.on('mapPick', () => { if (sr.open && sr.city) closeSearch(); });
  $('srBar').addEventListener('click', () => openSearch());
  bus.on('pickPlace', o => openSearch(null, o));                 // (1.1.36) інший екран просить вибрати місце
  $('bSearch').addEventListener('click', e => { e.stopPropagation(); openSearch(); });
  $('search').addEventListener('click', onSearchClick);
  $('srCard').addEventListener('click', onCardClick);
  bus.on('trip', syncTrip); bus.on('arrived', syncTrip); syncTrip();
  setInterval(syncTrip, 2000);
  bus.on('panel', name => { if (name) { closeSearch(); closeCard(false); } });
  // системна «Назад»: спершу пошук, потім картка знайденого місця
  const prev = window.__reisBack;
  window.__reisBack = () => {
    if (sr.open) { backOut(); return true; }
    if (sr.card) { closeCard(); return true; }
    return prev ? prev() : false;
  };
}
