// Номери будинків на карті (1.1.16).
//
// На онлайн-карті номери є з 1.1.8 (шар «reis-house» із квадратів OpenFreeMap — див. tuneLabels у map.js).
// А у файлі офлайн-карти (Protomaps, масштаб до 14) адрес немає взагалі: наблизив — будинки без номерів. Тому:
//   • офлайн-карта — номери підвантажуємо з квадратів OpenFreeMap (у них є шар «housenumber»), лише коли водій
//     наблизив карту (від масштабу HOUSE_Z, як і на онлайн-карті), і ЗБЕРІГАЄМО в телефоні: далі вони є й без мережі;
//   • рушили в рейс — заздалегідь зберігаємо номери навколо фінішу й проміжної точки: остання миля — саме там,
//     де номер будинку потрібен, а мережі може не бути.
// З квадрата (~100 КБ) зберігаємо один шар номерів (кілька КБ), тож запас на півтори тисячі квадратів — це мегабайти.
import { bus, log } from './core.js';
import * as P from './platform.js';

const TJ_URL = 'https://tiles.openfreemap.org/planet';      // TileJSON: адреса квадратів містить тижневу версію даних
const CACHE = 'reis-addr-1', Z = 14, TPL_KEY = 'reis.addrTpl';
const FRESH_MS = 45 * 864e5;                                // номери будинків змінюються рідко: 45 днів квадрат не перепитуємо
const TPL_MS = 6 * 3600e3, MAX_TILES = 1500;
export const HOUSE_Z = 17;                                  // номери — лише зблизька, щоб на ходу не захаращували карту (домовленість 1.1.8)
export const addr = { net: 0, hits: 0, fails: 0, last: '', prefetched: 0 };

/* ---------- адреса квадратів (із версією) ---------- */
let tpl = null, tplAt = 0, tplBusy = null;
async function template(force) {
  if (tpl == null) { tpl = ''; try { const o = JSON.parse(localStorage.getItem(TPL_KEY) || 'null'); if (o && o.u) { tpl = o.u; tplAt = o.t || 0; } } catch (_) {} }
  if (tpl && !force && Date.now() - tplAt < TPL_MS) return tpl;
  if (!tplBusy) tplBusy = (async () => {
    const r = await fetch(TJ_URL, { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), u = j && j.tiles && j.tiles[0];
    if (!u || !/\{z\}/.test(u)) throw new Error('у відповіді немає адреси квадратів');
    tpl = u; tplAt = Date.now(); try { localStorage.setItem(TPL_KEY, JSON.stringify({ u, t: tplAt })); } catch (_) {}
    return u;
  })().finally(() => { tplBusy = null; });
  try { return await tplBusy; } catch (e) { if (tpl) return tpl; throw e; }      // каталог недоступний — пробуємо стару адресу
}
const fill = (u, x, y) => u.replace('{z}', Z).replace('{x}', x).replace('{y}', y);

/* ---------- із квадрата лишаємо тільки шар номерів ---------- */
// Квадрат MVT — це послідовність шарів (поле 3). Беремо байти шару з назвою «housenumber» як є, решту викидаємо.
export function onlyHouseNumbers(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), keep = []; let o = 0, total = 0;
  const rv = () => { let v = 0, s = 0, x; do { x = b[o++]; v += (x & 0x7f) * 2 ** s; s += 7; } while ((x & 0x80) && o < b.length); return v; };
  const nameOf = (from, to) => {
    const save = o; o = from; let name = '';
    while (o < to) { const k = rv(), wt = k & 7; if (wt === 2) { const len = rv(); if ((k >>> 3) === 1) { name = new TextDecoder().decode(b.subarray(o, o + len)); break; } o += len; } else if (wt === 0) rv(); else if (wt === 5) o += 4; else if (wt === 1) o += 8; else break; }
    o = save; return name;
  };
  while (o < b.length) {
    const start = o, k = rv(), wt = k & 7;
    if (wt === 2) { const len = rv(), from = o; o += len; if (o > b.length) break; if ((k >>> 3) === 3 && nameOf(from, o) === 'housenumber') { keep.push(b.subarray(start, o)); total += o - start; } }
    else if (wt === 0) rv(); else if (wt === 5) o += 4; else if (wt === 1) o += 8; else break;
  }
  const out = new Uint8Array(total); let p = 0; for (const c of keep) { out.set(c, p); p += c.length; }
  return out;
}

// Квадрат зазвичай приходить уже розпакованим (браузер знімає gzip сам). Якщо сервер віддав стиснене «як є» — розпаковуємо.
async function gunzipIfNeeded(b) {
  if (b.length < 3 || b[0] !== 0x1f || b[1] !== 0x8b || typeof DecompressionStream === 'undefined') return b;
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/* ---------- запас у телефоні ---------- */
const mem = new Map();                                      // якщо сховища Cache у цьому WebView немає — тримаємо в пам'яті до перезапуску
let puts = 0;
const keyOf = (x, y) => location.origin + '/__addr/' + Z + '/' + x + '/' + y;
const store = async () => { try { return typeof caches !== 'undefined' ? await caches.open(CACHE) : null; } catch (_) { return null; } };
async function cacheGet(x, y) {
  const c = await store();
  if (c) { try { const r = await c.match(keyOf(x, y)); return r ? { data: new Uint8Array(await r.arrayBuffer()), t: +r.headers.get('x-reis-t') || 0 } : null; } catch (_) { return null; } }
  return mem.get(x + '/' + y) || null;
}
async function cachePut(x, y, data) {
  const t = Date.now(), c = await store();
  if (c) {
    try {
      await c.put(keyOf(x, y), new Response(data, { headers: { 'content-type': 'application/x-protobuf', 'x-reis-t': String(t) } }));
      if (++puts % 40 === 0) { const ks = await c.keys(); for (const k of ks.slice(0, Math.max(0, ks.length - MAX_TILES))) await c.delete(k); }   // найстаріші — геть
      return;
    } catch (_) {}
  }
  mem.set(x + '/' + y, { data, t });
}
export async function cacheInfo() { const c = await store(); if (!c) return { tiles: mem.size, mem: true }; try { return { tiles: (await c.keys()).length, mem: false }; } catch (_) { return { tiles: 0, mem: false }; } }

/* ---------- один квадрат номерів: із запасу або з мережі ---------- */
// Запит не обриваємо, навіть якщо карта вже «передумала» (водій посунув її далі): квадрат малий, а в запасі знадобиться.
const flying = new Map();
function getTile(x, y) {
  const k = x + '/' + y;
  if (!flying.has(k)) flying.set(k, loadTile(x, y).finally(() => flying.delete(k)));
  return flying.get(k);
}
async function loadTile(x, y) {
  const hit = await cacheGet(x, y);
  if (hit && Date.now() - hit.t < FRESH_MS) { addr.hits++; return hit.data; }
  try {
    let r = await fetch(fill(await template(false), x, y));
    if (r.status === 404 || r.status === 410) r = await fetch(fill(await template(true), x, y));   // дані оновились — у квадратів нова адреса
    if (r.status === 404 || r.status === 204) { const e = new Uint8Array(0); await cachePut(x, y, e); return e; }                    // такого квадрата немає (море, за межами)
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = onlyHouseNumbers(await gunzipIfNeeded(new Uint8Array(await r.arrayBuffer())));
    addr.net++; await cachePut(x, y, data);
    return data;
  } catch (e) {
    addr.fails++; addr.last = String(e && e.message || e).slice(0, 80);
    return hit ? hit.data : null;                             // мережі немає: віддаємо хоч старий запас
  }
}
/** Завантажувач для карти: reisaddr://14/x/y → шар номерів. Немає ні мережі, ні запасу — порожній квадрат, спитаємо ще раз за 40 с. */
export async function tileLoad(params, abortController) {
  const m = /^reisaddr:\/\/(\d+)\/(\d+)\/(\d+)/.exec(String(params && params.url || ''));
  if (!m || +m[1] !== Z) return { data: new ArrayBuffer(0) };
  const d = await getTile(+m[2], +m[3]);
  if (d == null) return { data: new ArrayBuffer(0), cacheControl: 'max-age=40' };
  return { data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) };
}

/* ---------- заздалегідь: номери навколо точки (фініш, «через») ---------- */
export const tileXY = (lat, lon) => { const n = 2 ** Z, r = lat * Math.PI / 180; return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)]; };
export async function prefetch(lat, lon, radius = 1) {
  const [x0, y0] = tileXY(lat, lon); let got = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) { try { if (await getTile(x0 + dx, y0 + dy)) got++; } catch (_) {} }
  addr.prefetched += got;
  return got;
}

/* ---------- шар на карті ---------- */
/** Підписи номерів (один вигляд для онлайн- і офлайн-карти): дрібний темний текст із білою обвідкою; від масштабу HOUSE_Z. */
export function houseLayer(source, night = false) {
  return {
    id: 'reis-house', type: 'symbol', source, 'source-layer': 'housenumber', minzoom: HOUSE_Z,
    layout: { 'text-field': ['to-string', ['get', 'housenumber']], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 17, 11, 19, 14], 'text-padding': 3 },
    paint: { 'text-color': night ? '#cfd6de' : '#5a5145', 'text-halo-color': night ? '#0f1317' : '#ffffff', 'text-halo-width': 1.5 }
  };
}
/** Джерело номерів для офлайн-карти (для онлайн-карти джерело вже є в стилі — «openmaptiles»). */
export const houseSource = () => ({ type: 'vector', tiles: ['reisaddr://{z}/{x}/{y}'], minzoom: Z, maxzoom: Z, attribution: '© OpenMapTiles © OpenStreetMap' });

export function init() {
  try { maplibregl.addProtocol('reisaddr', tileLoad); } catch (e) { log('warn', 'номери будинків: ' + e.message); }
  // рушили в рейс — номери навколо фінішу й проміжної точки кладемо в запас (один раз на рейс, лише коли є мережа)
  let doneFor = '';
  bus.on('trip', g => {
    const tr = g && g.active && g.trip; if (!tr || !tr.b || !P.online()) return;
    const key = (tr.id || '') + '|' + tr.b.lat + ',' + tr.b.lon + '|' + (tr.v ? tr.v.lat + ',' + tr.v.lon : '');
    if (key === doneFor) return; doneFor = key;
    (async () => {
      let n = await prefetch(tr.b.lat, tr.b.lon, 1);
      if (tr.v) n += await prefetch(tr.v.lat, tr.v.lon, 0);
      log('info', 'номери будинків біля фінішу' + (tr.v ? ' і проміжної точки' : '') + ': у запасі квадратів ' + n);
    })().catch(() => {});
  });
}
