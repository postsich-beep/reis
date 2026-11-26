// Довідник населених пунктів України (web/data/places.json): миттєві підказки з першої літери, без інтернету.
// Порядок: недавні місця → міста → селища → села; збіг з початку назви — українською чи російською.
import { log } from './core.js';
import { normName, oblastName } from './route.js';
import { t } from './i18n.js';

export const pl = { ready: false, loading: null, rows: [], n1: [], n2: [], n3: [], n4: [], date: '' };
// Латиницею теж шукаємо: «Lviv», «Lvov», «Kyiv», «Kiev», «Kharkov» → Львів, Київ, Харків.
const UK_LAT = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia' };
const RU_LAT = { ...UK_LAT, г: 'g', е: 'e', ё: 'e', и: 'i', й: 'y', ы: 'y', э: 'e', ъ: '', ю: 'yu', я: 'ya' };
const lat = (s, M) => String(s || '').toLowerCase().split('').map(c => M[c] ?? c).join('');
// «вільне» латинське написання: kh=h, y=i=j, ye=e, ya=a… — щоб Kharkov, Harkiv і Kharkiv зійшлися
export const loose = s => s.toLowerCase().replace(/[^a-z]/g, '').replace(/kh/g, 'h').replace(/[yj]/g, 'i').replace(/w/g, 'v')
  .replace(/i([eaou])/g, '$1').replace(/ii+/g, 'i').replace(/(.)\1+/g, '$1');
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
      pl.n3 = pl.rows.map(x => loose(lat(x[3], UK_LAT))); pl.n4 = pl.rows.map(x => x[4] ? loose(lat(x[4], RU_LAT)) : '');
      pl.ready = pl.rows.length > 0;
      log('info', `довідник населених пунктів: ${pl.rows.length}`);
    } catch (e) { log('warn', 'довідник населених пунктів: ' + e.message); }
  })();
  return pl.loading;
}

const kindLabel = k => t(k === 'c' ? 'kindCity' : k === 't' ? 'kindTown' : 'kindVillage');
export function toPlace(x) {
  return { lat: x[0], lon: x[1], label: x[3], sub: kindLabel(x[2]) + ', ' + oblastName(x[5]) + ' ' + t('oblShort'), kind: x[2], pop: x[6] || 0, local: true };
}

export function search(q, limit = 8) {
  if (!pl.ready) return [];
  const latin = /[a-z]/i.test(q) && !/[а-яіїєґё]/i.test(q);
  const nq = latin ? loose(q) : normName(q); if (!nq) return [];
  const hits = [];
  for (let i = 0; i < pl.rows.length; i++) {
    const a = latin ? pl.n3[i] : pl.n1[i], b = latin ? pl.n4[i] : pl.n2[i];
    let s = 0;
    if (a === nq || b === nq) s = 3;
    else if (a.startsWith(nq) || (b && b.startsWith(nq))) s = 2;
    else if (nq.length >= 3 && (a.includes(' ' + nq) || a.includes('-' + nq) || (b && b.includes(' ' + nq)))) s = 1;
    if (!s) continue;
    const r = pl.rows[i];
    hits.push([s * 10 + KR[r[2]] * 3 + Math.min(3, Math.log10(1 + r[6]) / 2), i, s]);
  }
  hits.sort((x, y) => y[0] - x[0]);
  return hits.slice(0, limit).map(h => ({ ...toPlace(pl.rows[h[1]]), m: h[2] }));          // m: 3 — назва збігається, 2 — починається з набраного, 1 — слово всередині
}

// Найближчий помітний населений пункт: місто чи селище в межах 25 км, інакше будь-який у межах 8 км.
export function nearest(lat, lon) {
  if (!pl.ready) return '';
  let best = null, bs = Infinity;
  const kx = 111 * Math.cos(lat * Math.PI / 180);
  for (const r of pl.rows) {
    const dy = (r[0] - lat) * 111; if (dy > 25 || dy < -25) continue;
    const dx = (r[1] - lon) * kx; if (dx > 25 || dx < -25) continue;
    const d = Math.hypot(dx, dy); if (d > (r[2] === 'v' ? 8 : 25)) continue;
    const sc = d / (r[2] === 'c' ? 3 : r[2] === 't' ? 1.6 : 1);
    if (sc < bs) { bs = sc; best = r; }
  }
  return best ? best[3] : '';
}

/* недавні місця: показуються, щойно поле отримує фокус */
export function recent() { try { return JSON.parse(localStorage.getItem('reis.recent') || '[]'); } catch (_) { return []; } }
export function remember(p) {
  if (!p || p.lat == null || !p.label) return;
  const list = recent().filter(x => !(Math.abs(x.lat - p.lat) < 1e-4 && Math.abs(x.lon - p.lon) < 1e-4));
  list.unshift({ lat: p.lat, lon: p.lon, label: p.label, sub: p.sub || '' });
  try { localStorage.setItem('reis.recent', JSON.stringify(list.slice(0, 8))); } catch (_) {}
}
