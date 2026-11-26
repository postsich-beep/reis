// «Улюблені місця» (1.1.34): місця, які водій позначив сердечком (картка знайденого місця на карті, форма «Рейс»).
// Лежать у телефоні (localStorage), без мережі; з форми «Рейс» улюблене місце одним дотиком стає стартом, «через» чи фінішем.
// (1.1.36) Місце можна додати просто з екрана «Улюблені місця», перейменувати (name — своя назва: «Склад», «База») і змінити йому адресу.
import { bus } from './core.js';

const KEY = 'reis.favs', MAX = 200;
const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;   // ~10 м: те саме місце

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => x && Number.isFinite(x.lat) && Number.isFinite(x.lon) && x.label) : [];
  } catch (_) { return []; }
}
function write(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (_) {} bus.emit('favs', list.length); }

/** Усі улюблені: найновіші згори. */
export const list = () => read();
export const count = () => read().length;
export const has = p => !!p && p.lat != null && read().some(x => same(x, p));
export function find(id) { return read().find(x => x.id === id) || null; }
/** Додає місце (якщо його ще немає) і повертає запис; те саме місце вдруге не додається. */
export function add(p) {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !p.label) return null;
  const l = read(), old = l.find(x => same(x, p)); if (old) return old;
  const f = { id: 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), lat: p.lat, lon: p.lon, label: String(p.label), sub: p.sub ? String(p.sub) : '', t: Date.now() };
  l.unshift(f); write(l); return f;
}
export function remove(id) { const l = read(), i = l.findIndex(x => x.id === id); if (i < 0) return null; const f = l[i]; write(l.filter(x => x.id !== id)); return { ...f, _i: i }; }
/** Повертає видалене місце назад (кнопка «Повернути» у сповіщенні). */
export function restore(f) { if (!f) return; const { _i, ...rec } = f, l = read().filter(x => x.id !== rec.id && !same(x, rec)); l.splice(Math.min(_i ?? 0, l.length), 0, rec); write(l); }   // на те саме місце в списку
/** Сердечко: є — прибрати, нема — додати. Повертає true, якщо після виклику місце в улюблених. */
export function toggle(p) {
  const f = read().find(x => same(x, p));
  if (f) { remove(f.id); return false; }
  return !!add(p);
}
/** (1.1.36) Змінити запис: name — своя назва ('' — прибрати, лишається назва місця); place — нове місце (адреса, координати).
    Повертає запис; 'dup' — на новому місці вже є інше улюблене; null — такого запису немає. */
export function update(id, { name, place } = {}) {
  const l = read(), f = l.find(x => x.id === id); if (!f) return null;
  if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon) && place.label) {
    if (l.some(x => x.id !== id && same(x, place))) return 'dup';
    f.lat = place.lat; f.lon = place.lon; f.label = String(place.label); f.sub = place.sub ? String(place.sub) : '';
  }
  if (name != null) { const n = String(name).trim().slice(0, 60); if (n && n !== f.label) f.name = n; else delete f.name; }
  write(l); return f;
}
/** Як місце названо на екрані: своя назва, а якщо її немає — назва місця. */
export const title = f => f.name || f.label;
/** Другий рядок: адреса (коли є своя назва — разом із назвою місця). */
export const subOf = f => f.name ? [f.label, f.sub].filter(Boolean).join(', ') : (f.sub || '');
/** Для вставки в точку рейсу — у тому ж вигляді, що й результат пошуку. */
export const toPlace = f => ({ lat: f.lat, lon: f.lon, label: title(f), sub: subOf(f) });
