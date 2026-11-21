// Спільне для екранів: іконки, панелі, спливаючі сповіщення.
import { bus, S, esc } from './core.js';

export const $ = id => document.getElementById(id);

/* Прозорість плашок: непрозорість легких плашок (кнопки, швидкість, низ) і похідні для панелей,
   картки маневру і кольорової шторки. Значення — у змінних CSS, див. кінець app.css. */
export const GLASS = { low: 0.82, mid: 0.6, high: 0.4, max: 0.22 };
export function applyGlass() {
  const a = GLASS[S.glass] ?? GLASS.high, r = document.documentElement.style, cl = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  r.setProperty('--ga', a.toFixed(2));
  r.setProperty('--gs', cl(a + 0.36, 0.6, 0.95).toFixed(2));
  r.setProperty('--gm', cl(a + 0.3, 0.55, 0.92).toFixed(2));
  r.setProperty('--gc', cl(a + 0.3, 0.62, 0.92).toFixed(2));
}
const I = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const ICON = {
  trip: I('<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>'),
  feed: I('<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7 2.5 7h-17S6 15 6 9Z"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/>'),
  mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>'),
  chat: I('<path d="M4 5h16v11H9l-5 4Z"/>'),
  lab: I('<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>'),
  north: I('<path d="M12 3 17 20 12 16.5 7 20Z"/>'),
  head: I('<circle cx="12" cy="12" r="9"/><path d="M12 6.5 15 15l-3-1.8L9 15Z" fill="currentColor"/>'),
  sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M5.2 18.8 7 17M17 7l1.8-1.8"/>'),
  moon: I('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>'),
  auto: I('<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 9 9h-9Z" fill="currentColor" stroke="none"/>'),
  vol: I('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>'),
  mute: I('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  gear: I('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  center: I('<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
  x: I('<path d="M6 6l12 12M18 6 6 18"/>'),
  back: I('<path d="m14.5 5-7 7 7 7"/>'),
  up: I('<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>', 'stroke-width="2.6"'),
  down: I('<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5"/>', 'stroke-width="2.6"'),
  like: I('<path d="M7 10v10H4V10Zm0 0 4.5-7c1.6 0 2.5 1.2 2.2 2.8L13 9.5h5.2a2 2 0 0 1 2 2.4l-1.3 6.4a2 2 0 0 1-2 1.7H7"/>'),
  dislike: I('<path d="M7 14V4H4v10Zm0 0 4.5 7c1.6 0 2.5-1.2 2.2-2.8L13 14.5h5.2a2 2 0 0 0 2-2.4l-1.3-6.4a2 2 0 0 0-2-1.7H7"/>'),
  q: I('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1 1-1.1 1.8M12 17v.2"/>'),
  here: I('<circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="8"/>'),
  send: I('<path d="M4 12 20 4l-5 16-3.5-6.5Z"/>'),
  trash: I('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  go: I('<path d="M5 12h13M12.5 6l6 6-6 6"/>', 'stroke-width="2.6"'),
  cam: I('<rect x="3" y="8" width="13" height="9" rx="2"/><path d="m16 11 5-3v9l-5-3"/>')
};

/* Іконка маневру за типом Valhalla. Ліві варіанти — дзеркало правих. */
const M = {
  straight: '<path d="M24 42V10M12 22 24 10l12 12"/>',
  slight: '<path d="M18 42V29L33 12M20 12h13v13"/>',
  right: '<path d="M15 42V25q0-8 8-8h15M30 9l8 8-8 8"/>',
  sharp: '<path d="M15 42V13l19 19M34 19v13H21"/>',
  uturn: '<path d="M13 42V20a10.5 10.5 0 0 1 21 0v14M25.5 26l8.5 8.5 8.5-8.5"/>',
  merge: '<path d="M24 42V10M12 22 24 10l12 12M39 42q0-12-15-16"/>',
  round: '<circle cx="24" cy="23" r="8"/><path d="M24 42V31M30 17l8-8M30 8.5h8.5V17"/>',
  flag: '<path d="M14 43V7M14 9h23l-6 7.5 6 7.5H14"/>'
};
const MAP = { 9: 'slight', 23: 'slight', 18: 'slight', 20: 'slight', 37: 'slight', 10: 'right', 11: 'sharp', 12: 'uturn', 25: 'merge', 26: 'round', 27: 'round', 4: 'flag', 5: 'flag', 6: 'flag' };
const LEFT = { 16: 'slight', 24: 'slight', 19: 'slight', 21: 'slight', 38: 'slight', 15: 'right', 14: 'sharp', 13: 'uturn' };
export function manIcon(type) {
  const left = LEFT[type], shape = M[left || MAP[type] || 'straight'];
  return `<svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${left ? `<g transform="translate(48 0) scale(-1 1)">${shape}</g>` : shape}</svg>`;
}

/* ---------- спливаючі сповіщення ---------- */
export function toast(text, level = '', ms = 7000, onTap) {
  const box = $('toasts'); if (!box) return;
  const el = document.createElement('div'); el.className = 'toast ' + level; el.textContent = text;
  el.onclick = () => { el.remove(); if (onTap) onTap(); };
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

/* ---------- панелі ---------- */
const panels = {};          // name -> {title: () => string, render: (body) => void, half?: bool, back?: name, on?: [events]}
let current = null, rerenderTimer = null;
export function definePanel(name, def) { panels[name] = def; }
export const currentPanel = () => current;
export function openPanel(name, arg) {
  const def = panels[name]; if (!def) return;
  current = name;
  const p = $('panel'); p.hidden = false; p.classList.toggle('half', !!def.half);
  $('panelTitle').textContent = def.title();
  $('panelBack').hidden = !def.back;
  $('panelBack').onclick = () => openPanel(def.back);
  const body = $('panelBody'); body.innerHTML = ''; body.scrollTop = 0;
  def.render(body, arg);
  document.querySelectorAll('#tabs button[data-panel]').forEach(b => b.classList.toggle('act', b.dataset.panel === (def.tab || name)));
  bus.emit('panel', name);
}
export function closePanel() {
  if (!current) return;
  const def = panels[current]; current = null;
  $('panel').hidden = true; $('panelBody').innerHTML = '';
  document.querySelectorAll('#tabs button[data-panel]').forEach(b => b.classList.remove('act'));
  if (def && def.close) def.close();
  bus.emit('panel', null);
}
// Перемалювати відкриту панель (не частіше ніж раз на 400 мс), якщо вона показує саме цей екран.
export function refresh(name) {
  if (current !== name) return;
  if (rerenderTimer) return;
  rerenderTimer = setTimeout(() => {
    rerenderTimer = null; if (current !== name) return;
    const def = panels[name], body = $('panelBody'), st = body.scrollTop;
    if (def.update) def.update(body); else { body.innerHTML = ''; def.render(body); }
    body.scrollTop = st;
  }, 400);
}
export const html = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? (vals[i] == null ? '' : vals[i]) : ''), '');
export { esc };
export function toggleRow(key, title, desc, on, soon) {
  return `<div class="tg${soon ? ' soon' : ''}" ${soon ? '' : `data-tg="${key}"`}><div class="grow"><b>${esc(title)}</b><small>${esc(desc)}</small></div>${soon ? `<span class="soon-tag">${esc(soon)}</span>` : `<button class="sw${on ? ' on' : ''}" role="switch" aria-checked="${!!on}" aria-label="${esc(title)}"></button>`}</div>`;
}
