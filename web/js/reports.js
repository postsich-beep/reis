// Позначки водіїв на дорозі: ДТП, поліція, транспортна служба. Живуть 2 години.
// Спільні для всіх телефонів із «Рейсом»: обмін через ntfy.sh (відкритий сервіс повідомлень, без реєстрації) —
// позначка йде одним POST-запитом у спільний канал, а кожен телефон раз на 30 с забирає свіжі за останні 2 години.
import { bus, log, S, hav, uid } from './core.js';
import { pos } from './nav.js';
import { g } from './guide.js';
import { t } from './i18n.js';

export const REP_TTL = 2 * 3600e3;
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
const KEY = 'reis.reps', DEV_KEY = 'reis.dev';
const topic = () => (S.repTopic || 'reis-ua-road-2026-k7q9x2m4').replace(/[^\w-]/g, '');
const base = () => 'https://ntfy.sh/' + topic();
let dev = '', lastId = '', busy = false, said = new Set();

function devId() {
  if (dev) return dev;
  try { dev = localStorage.getItem(DEV_KEY) || ''; if (!dev) { dev = uid() + uid(); localStorage.setItem(DEV_KEY, dev); } } catch (_) { dev = uid(); }
  return dev;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(reps.list)); } catch (_) {} }
function prune(now = Date.now()) { const n = reps.list.length; reps.list = reps.list.filter(r => now - r.at < REP_TTL); return n !== reps.list.length; }
const valid = r => r && REP_TYPES[r.t] && isFinite(r.lat) && isFinite(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180 && typeof r.id === 'string' && r.id.length <= 40;

function add(r, own) {
  if (!valid(r) || reps.list.some(x => x.id === r.id)) return false;
  reps.list.push({ id: r.id, t: r.t, lat: +r.lat, lon: +r.lon, brg: isFinite(r.brg) ? +r.brg : null, at: +r.at || Date.now(), own: !!own || r.dev === devId(), sent: own ? r.sent : true });
  return true;
}
const age = r => Math.max(0, Math.round((Date.now() - r.at) / 60000));
export const repName = r => t('rep_' + r.t);
export const repAgo = r => age(r) < 1 ? t('repNow') : t('repAgo', age(r));

// Водій торкнувся «ДТП», «Поліція» чи «Транспортна служба» — позначка там, де машина зараз
export async function report(type) {
  if (!REP_TYPES[type] || pos.lat == null) return null;
  const r = { v: 1, id: uid(), t: type, lat: +pos.lat.toFixed(5), lon: +pos.lon.toFixed(5), brg: Math.round(pos.hdg || 0), at: Date.now(), dev: devId(), sent: false };
  add(r, true); save(); bus.emit('reports', reps);
  if (S.repShare !== false) send(r);
  return r;
}
async function send(r) {
  try {
    const body = JSON.stringify({ v: 1, id: r.id, t: r.t, lat: r.lat, lon: r.lon, brg: r.brg, at: r.at, dev: r.dev });
    const res = await fetch(base(), { method: 'POST', body });                 // простий запит, без власних заголовків
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const x = reps.list.find(y => y.id === r.id); if (x) x.sent = true;
    reps.ok = true; save(); bus.emit('reports', reps);
  } catch (e) { reps.ok = false; reps.err = e.message; log('warn', 'позначка не відправилась: ' + e.message); }
}
// Свіжі позначки всіх водіїв за останні 2 години
export async function poll() {
  if (busy || S.repShare === false || navigator.onLine === false) return;
  busy = true;
  try {
    const res = await fetch(base() + '/json?poll=1&since=' + (lastId || '2h'), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const txt = await res.text(); let n = 0;
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.event !== 'message' || !m.message) continue;
      lastId = m.id || lastId;
      let r; try { r = JSON.parse(m.message); } catch (_) { continue; }
      if (r && m.time) r.at = Math.min(Date.now(), m.time * 1000);           // час — за сервером, не за годинником чужого телефона
      if (add(r, false)) n++;
    }
    reps.ok = true; reps.at = Date.now(); reps.err = '';
    if (prune() || n) { save(); bus.emit('reports', reps); }
  } catch (e) { reps.ok = false; reps.err = e.message; }
  busy = false;
}
// Позначка попереду на маршруті (до 20 км) — одне повідомлення в «Події» й голосом
function ahead() {
  if (!g.active || !g.idx || pos.rd == null) return;
  for (const r of reps.list) {
    const key = 'rep:' + r.id; if (said.has(key)) continue;
    const l = g.idx.locate(r, null); if (!l || l.off > 250) continue;
    const a = l.d - pos.rd; if (a < 200 || a > 20000) continue;
    said.add(key);
    bus.emit('feedPush', { src: 'rep', level: REP_TYPES[r.t].level, key, lat: r.lat, lon: r.lon, text: t('repAhead', repName(r), repAgo(r)), voice: t('repVoice', repName(r)) });
  }
}
export function init() {
  try { reps.list = JSON.parse(localStorage.getItem(KEY) || '[]').filter(valid); } catch (_) {}
  prune(); bus.emit('reports', reps);
  setTimeout(poll, 3000);
  setInterval(() => { poll(); if (prune()) { save(); bus.emit('reports', reps); } }, 30000);
  let lastA = 0; bus.on('pos', () => { const now = Date.now(); if (now - lastA > 5000) { lastA = now; ahead(); } });
  bus.on('reports', () => ahead());
  window.addEventListener('online', () => poll());
}
