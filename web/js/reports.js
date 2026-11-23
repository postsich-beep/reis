// Позначки водіїв на дорозі: ДТП, поліція, транспортна служба. Живуть 2 години від останнього підтвердження.
// Спільні для всіх телефонів із «Рейсом»: обмін через ntfy.sh (відкритий сервіс повідомлень, без реєстрації) —
// позначка йде одним POST-запитом у спільний канал, а кожен телефон раз на 30 с забирає свіжі.
// 1.1.9: водій, що проїжджає позначку, відповідає «Ще тут?» — «Так» продовжує її на 2 години від цієї хвилини,
// два «Немає» від різних водіїв прибирають. Захист від засмічення: не далі 3 км від машини, ліміти на телефон.
import { bus, log, S, hav, uid } from './core.js';
import { pos } from './nav.js';
import { g } from './guide.js';
import { t } from './i18n.js';

export const REP_TTL = 2 * 3600e3, REP_MAX_LIFE = 10 * 3600e3, REP_MAX_DIST = 3000, ASK_R = 160;
export const REP_TYPES = {
  crash: { level: 'red', color: '#e5484d' },
  police: { level: 'yellow', color: '#2f6bff' },
  transport: { level: 'yellow', color: '#f59e0b' }
};
export const reps = { list: [], ok: null, err: '', at: 0 };
// значки (власні, прості): ДТП — спалах і машина, поліція — кашкет, транспортна служба — фура на вагах
export const REP_SVG = {
  crash: '<svg viewBox="0 0 48 48"><path d="M24 5l3.8 7.6 8.3-2.5-2.5 8.3L41.2 22l-7.6 3.8 2.5 8.3-8.3-2.5L24 39.2l-3.8-7.6-8.3 2.5 2.5-8.3L6.8 22l7.6-3.8-2.5-8.3 8.3 2.5z" fill="#ffcf3f" stroke="#e5484d" stroke-width="2.4" stroke-linejoin="round"/><path d="M16.5 27.5l3.6-6.5h7.8l3.6 6.5v4.5h-15z" fill="#e5484d"/><path d="M20.8 22.6h6.4l2 3.6H18.8z" fill="#ffe7e7"/><circle cx="19.6" cy="32.5" r="2.3" fill="#1f2937"/><circle cx="28.4" cy="32.5" r="2.3" fill="#1f2937"/></svg>',
  police: '<svg viewBox="0 0 48 48"><path d="M7 21c0-6 7.6-10 17-10s17 4 17 10l-3.4 5.6H10.4z" fill="#2f6bff"/><path d="M10 26.6h28l-2.2 5.4H12.2z" fill="#16307a"/><path d="M24 14.2l2.6 1.4v3.2c0 1.8-1.2 3.2-2.6 3.8-1.4-.6-2.6-2-2.6-3.8v-3.2z" fill="#ffd34d"/><path d="M15 32c1.8 5.6 5.2 8.6 9 8.6s7.2-3 9-8.6z" fill="#f2c39a"/></svg>',
  transport: '<svg viewBox="0 0 48 48"><rect x="4.5" y="13" width="23" height="16" rx="2.5" fill="#f59e0b"/><path d="M27.5 17.5h8.2l5.3 6.3V29H27.5z" fill="#fbbf24"/><path d="M30 19.5h5l3 3.6h-8z" fill="#fff7df"/><circle cx="12.5" cy="30.5" r="3.6" fill="#1f2937"/><circle cx="34" cy="30.5" r="3.6" fill="#1f2937"/><path d="M5 37.5h38" stroke="#cbd5e1" stroke-width="3" stroke-linecap="round"/><path d="M24 34.5v3M18 37.5l-2 4h16l-2-4" fill="none" stroke="#cbd5e1" stroke-width="2.2" stroke-linejoin="round"/></svg>'
};
const KEY = 'reis.reps', DEV_KEY = 'reis.dev', VOTE_KEY = 'reis.repVotes', MINE_KEY = 'reis.repMine';
const topic = () => (S.repTopic || 'reis-ua-road-2026-k7q9x2m4').replace(/[^\w-]/g, '');
const base = () => 'https://ntfy.sh/' + topic();
let dev = '', lastId = '', busy = false, said = new Set(), votes = {}, mine = [];
const asked = new Set(), devSeen = new Map(), pend = new Map();

function devId() {
  if (dev) return dev;
  try { dev = localStorage.getItem(DEV_KEY) || ''; if (!dev) { dev = uid() + uid(); localStorage.setItem(DEV_KEY, dev); } } catch (_) { dev = uid(); }
  return dev;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(reps.list)); localStorage.setItem(VOTE_KEY, JSON.stringify(votes)); localStorage.setItem(MINE_KEY, JSON.stringify(mine)); } catch (_) {} }
const noCount = r => r.no ? Object.keys(r.no).length : 0;
const alive = (r, now) => now - r.at < REP_TTL && now - (r.born || r.at) < REP_MAX_LIFE && noCount(r) < 2;
function prune(now = Date.now()) { const n = reps.list.length; reps.list = reps.list.filter(r => alive(r, now)); return n !== reps.list.length; }
const valid = r => r && REP_TYPES[r.t] && isFinite(r.lat) && isFinite(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 && typeof r.id === 'string' && r.id.length <= 40;
const byId = id => reps.list.find(x => x.id === id);
// видно на карті й у підказках: не прихована водієм («Немає») і не прибрана іншими
export const shown = () => reps.list.filter(r => !r.hide);

function add(r, own, at) {
  if (!valid(r) || byId(r.id)) return null;
  const x = { id: r.id, t: r.t, lat: +r.lat, lon: +r.lon, brg: isFinite(r.brg) ? +r.brg : null, at: at || +r.at || Date.now(), born: 0,
    dev: String(r.ad || r.dev || '').slice(0, 40), own: !!own || (r.ad || r.dev) === devId(), sent: own ? !!r.sent : true, conf: 0, no: {} };
  x.born = Math.min(x.at, +r.born || x.at);
  if (votes[x.id] === 'no') x.hide = true;
  reps.list.push(x);
  return x;
}
// Час позначки під значком: «23.11 13:05» (поліцію бачили о цій порі; після підтвердження — новий час)
export function repStamp(r) {
  const d = new Date(r.at), p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
const age = r => Math.max(0, Math.round((Date.now() - r.at) / 60000));
export const repName = r => t('rep_' + r.t);
export const repAgo = r => age(r) < 1 ? t('repNow') : t('repAgo', age(r));

// Водій вибрав «ДТП», «Поліція» чи «Транспортна служба» і показав місце прицілом (або «тут, де я»).
// Не далі 3 км від машини: позначки «з дивана» на іншому кінці країни — це вже засмічення.
// Відправляємо через 8 с — водій встигне скасувати, якщо промахнувся.
export function report(type, at = null) {
  if (!REP_TYPES[type] || pos.lat == null) return { err: 'pos' };
  const p = at || pos;
  if (hav(pos, p) > REP_MAX_DIST) return { err: 'far' };
  const now = Date.now();
  mine = mine.filter(x => now - x < 3600e3);
  if (mine.length && now - mine[mine.length - 1] < 15000) return { err: 'often' };
  if (mine.length >= 12) return { err: 'many' };
  mine.push(now);
  const r = { v: 1, id: uid(), t: type, lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), brg: Math.round(pos.hdg || 0), at: now, dev: devId(), sent: false };
  add(r, true, now); save(); bus.emit('reports', reps);
  if (S.repShare !== false) pend.set(r.id, setTimeout(() => { pend.delete(r.id); send(r); }, 8000));
  return { r };
}
// «Скасувати» в перші 8 с — позначка ще не пішла іншим
export function undo(id) {
  const tm = pend.get(id); if (tm) { clearTimeout(tm); pend.delete(id); }
  const x = byId(id); if (!x || !x.own || x.sent) return false;
  reps.list = reps.list.filter(y => y.id !== id); mine.pop(); save(); bus.emit('reports', reps);
  return true;
}
async function post(msg) {
  const res = await fetch(base(), { method: 'POST', body: JSON.stringify(msg) });          // простий запит, без власних заголовків
  if (!res.ok) throw new Error('HTTP ' + res.status);
}
async function send(r) {
  try {
    await post({ v: 1, id: r.id, t: r.t, lat: r.lat, lon: r.lon, brg: r.brg, at: r.at, dev: r.dev });
    const x = byId(r.id); if (x) x.sent = true;
    reps.ok = true; save(); bus.emit('reports', reps);
  } catch (e) { reps.ok = false; reps.err = e.message; log('warn', 'позначка не відправилась: ' + e.message); }
}
// Відповідь водія, що проїжджає позначку: «Так, ще тут» — продовжуємо на 2 години від цієї хвилини (і час під значком новий);
// «Немає» — у себе ховаємо одразу, для всіх прибираємо, коли «Немає» скаже ще хтось.
export function vote(id, yes) {
  const x = byId(id); if (!x || x.own || votes[id]) return false;
  votes[id] = yes ? 'ok' : 'no';
  if (yes) { x.at = Date.now(); x.conf = (x.conf || 0) + 1; x.no = {}; } else x.hide = true;
  save(); bus.emit('reports', reps);
  if (S.repShare !== false) {
    const msg = yes ? { v: 1, k: 'ok', id, t: x.t, lat: x.lat, lon: x.lon, brg: x.brg, born: x.born, ad: x.dev, dev: devId() } : { v: 1, k: 'no', id, dev: devId() };
    post(msg).catch(e => log('warn', 'відповідь про позначку не пішла: ' + e.message));
  }
  return true;
}
// Чуже повідомлення з каналу. at — час сервера (не годинник чужого телефона).
// Захист: від одного телефона — не більше 10 нових позначок за годину; голос — один від телефона; автор сам собі не продовжує.
function onMsg(r, at) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string') return false;
  const k = r.k || 'new', who = String(r.dev || '').slice(0, 40);
  if (!who) return false;
  if (k === 'no') {
    const x = byId(r.id); if (!x || who === x.dev || x.no[who]) return false;
    x.no[who] = at; return true;
  }
  if (k !== 'new' && k !== 'ok') return false;
  if (k === 'new') {
    const seen = (devSeen.get(who) || []).filter(q => at - q < 3600e3);
    if (seen.length >= 10 && who !== devId()) return false;
    seen.push(at); devSeen.set(who, seen);
  }
  let x = byId(r.id), changed = false;
  if (!x) { x = add(r, false, at); if (!x) return false; changed = true; }
  if (k === 'ok' && who !== x.dev && at > x.at && at - x.born < REP_MAX_LIFE) {
    x.at = at; x.conf = (x.conf || 0) + 1;
    for (const d of Object.keys(x.no)) if (x.no[d] < at) delete x.no[d];          // новіше «Так» сильніше за давнє «Немає»
    changed = true;
  }
  return changed;
}
// Свіжі позначки всіх водіїв (за 10 годин — бо підтверджені живуть довше; канал ntfy тримає 12 годин)
export async function poll() {
  if (busy || S.repShare === false || navigator.onLine === false) return;
  busy = true;
  try {
    const res = await fetch(base() + '/json?poll=1&since=' + (lastId || '10h'), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text(); let n = 0, cnt = 0;
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.event !== 'message' || !m.message) continue;
      lastId = m.id || lastId;
      if (++cnt > 400) continue;                                                     // злива повідомлень — решту пропускаємо
      let r; try { r = JSON.parse(m.message); } catch (_) { continue; }
      const at = m.time ? Math.min(Date.now(), m.time * 1000) : Date.now();
      if (onMsg(r, at)) n++;
    }
    reps.ok = true; reps.at = Date.now(); reps.err = '';
    if (prune() || n) { save(); bus.emit('reports', reps); }
  } catch (e) { reps.ok = false; reps.err = e.message; }
  busy = false;
}
// Позначка попереду на маршруті (до 20 км) — одне повідомлення в «Події» й голосом
function ahead() {
  if (!g.active || !g.idx || pos.rd == null) return;
  for (const r of shown()) {
    const key = 'rep:' + r.id; if (said.has(key)) continue;
    const l = g.idx.locate(r, null); if (!l || l.off > 250) continue;
    const a = l.d - pos.rd; if (a < 200 || a > 20000) continue;
    said.add(key);
    bus.emit('feedPush', { src: 'rep', level: REP_TYPES[r.t].level, key, lat: r.lat, lon: r.lon, text: t('repAhead', repName(r), repAgo(r)), voice: t('repVoice', repName(r)) });
  }
}
// Проїжджаємо чужу позначку (до 160 м, за справжнім GPS, у русі, позначки на карті показуються) — питаємо «Ще тут?»
function askNear() {
  if (S.repAsk === false || S.mapReports === false || pos.mode !== 'gps' || !(pos.spd > 1.5) || pos.lat == null) return;
  for (const r of shown()) {
    if (r.own || votes[r.id] || asked.has(r.id)) continue;
    if (hav(pos, r) > ASK_R) continue;
    asked.add(r.id); bus.emit('repAsk', r); return;
  }
}
export function init() {
  try { reps.list = JSON.parse(localStorage.getItem(KEY) || '[]').filter(valid).map(r => ({ conf: 0, no: {}, born: r.at, dev: '', ...r })); } catch (_) {}
  try { votes = JSON.parse(localStorage.getItem(VOTE_KEY) || '{}') || {}; mine = JSON.parse(localStorage.getItem(MINE_KEY) || '[]') || []; } catch (_) {}
  prune(); bus.emit('reports', reps);
  // свої позначки, що не встигли піти (застосунок закрили в ці 8 с) — відправляємо зараз
  for (const r of reps.list) if (r.own && !r.sent && Date.now() - r.at < 600000 && S.repShare !== false) send({ ...r, v: 1, dev: devId() });
  setTimeout(poll, 3000);
  setInterval(() => { poll(); if (prune()) { save(); bus.emit('reports', reps); } }, 30000);
  let lastA = 0; bus.on('pos', () => { const now = Date.now(); askNear(); if (now - lastA > 5000) { lastA = now; ahead(); } });
  bus.on('reports', () => ahead());
  window.addEventListener('online', () => poll());
}
