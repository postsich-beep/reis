// Довідник населених пунктів України (web/data/places.json): миттєві підказки з першої літери, без інтернету.
// Порядок: недавні місця → міста → селища → села; збіг з початку назви — українською чи російською.
import { log } from './core.js';
import { normName, oblastName } from './route.js';
import { t } from './i18n.js';

export const pl = { ready: false, loading: null, rows: [], n1: [], n2: [], date: '' };
const KR = { c: 3, t: 2, v: 1 };

export function load() {
  if (pl.loading) return pl.loading;
  pl.loading = (async () => {
    try {
      const r = await fetch('data/places.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      pl.rows = j.rows || []; pl.date = j.date || '';
      pl.n1 = pl.rows.map(x => normName(x[3])); pl.n2 = pl.rows.map(x => x[4] ? normName(x[4]) : '');
      pl.ready = pl.rows.length > 0;
      log('info', `довідник населених пунктів: ${pl.rows.length}`);
    } catch (e) { log('warn', 'довідник населених пунктів: ' + e.message); }
  })();
  return pl.loading;
}

const kindLabel = k => t(k === 'c' ? 'kindCity' : k === 't' ? 'kindTown' : 'kindVillage');
export function toPlace(x) {
  return { lat: x[0], lon: x[1], label: x[3], sub: kindLabel(x[2]) + ', ' + oblastName(x[5]) + ' ' + t('oblShort'), kind: x[2], local: true };
}

export function search(q, limit = 8) {
  if (!pl.ready) return [];
  const nq = normName(q); if (!nq) return [];
  const hits = [];
  for (let i = 0; i < pl.rows.length; i++) {
    const a = pl.n1[i], b = pl.n2[i];
    let s = 0;
    if (a === nq || b === nq) s = 3;
    else if (a.startsWith(nq) || (b && b.startsWith(nq))) s = 2;
    else if (nq.length >= 3 && (a.includes(' ' + nq) || a.includes('-' + nq) || (b && b.includes(' ' + nq)))) s = 1;
    if (!s) continue;
    const r = pl.rows[i];
    hits.push([s * 10 + KR[r[2]] * 3 + Math.min(3, Math.log10(1 + r[6]) / 2), i]);
  }
  hits.sort((x, y) => y[0] - x[0]);
  return hits.slice(0, limit).map(h => toPlace(pl.rows[h[1]]));
}

/* недавні місця: показуються, щойно поле отримує фокус */
export function recent() { try { return JSON.parse(localStorage.getItem('reis.recent') || '[]'); } catch (_) { return []; } }
export function remember(p) {
  if (!p || p.lat == null || !p.label) return;
  const list = recent().filter(x => !(Math.abs(x.lat - p.lat) < 1e-4 && Math.abs(x.lon - p.lon) < 1e-4));
  list.unshift({ lat: p.lat, lon: p.lon, label: p.label, sub: p.sub || '' });
  try { localStorage.setItem('reis.recent', JSON.stringify(list.slice(0, 8))); } catch (_) {}
}
