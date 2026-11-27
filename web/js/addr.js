// Номери будинків на карті (1.1.16).
//
// На онлайн-карті номери є з 1.1.8 (шар «reis-house» із квадратів OpenFreeMap — див. tuneLabels у map.js).
// А у файлі офлайн-карти (Protomaps, масштаб до 14) адрес немає взагалі: наблизив — будинки без номерів. Тому:
//   • офлайн-карта — номери підвантажуємо з квадратів OpenFreeMap (у них є шар «housenumber»), лише коли водій
//     наблизив карту (від масштабу HOUSE_Z, як і на онлайн-карті), і ЗБЕРІГАЄМО в телефоні: далі вони є й без мережі;
//   • рушили в рейс — заздалегідь зберігаємо номери навколо фінішу й проміжної точки: остання миля — саме там,
//     де номер будинку потрібен, а мережі може не бути.
// З квадрата (~100 КБ) зберігаємо один шар номерів (кілька КБ), тож запас на півтори тисячі квадратів — це мегабайти.
//
// 1.1.17 — ВЛАСНІ ПАЧКИ: номери всієї України, зібрані з OpenStreetMap (tools/build_addr.py, гілка addr сховища).
// Пачка — квадрат ≈100×100 км, файл від кількох КБ до сотень КБ; уся Україна — близько 9 МБ. Тому застосунок кладе
// в телефон УСІ пачки сам, щойно є офлайн-карта й мережа (packAuto), і раз на місяць оновлює їх: водієві нічого
// натискати не треба. Доки це не сталося — пачку свого району бере, щойно водій наблизив карту з мережею.
// Є пачка — номери малюються без мережі й без сторонніх серверів. Немає пачок (ще не зібрані, немає мережі) —
// працює попередній шлях: квадрати OpenFreeMap із запасом.
import { bus, log } from './core.js';
import * as P from './platform.js';

const TJ_URL = 'https://tiles.openfreemap.org/planet';      // TileJSON: адреса квадратів містить тижневу версію даних
const CACHE = 'reis-addr-1', Z = 14, TPL_KEY = 'reis.addrTpl';
const FRESH_MS = 45 * 864e5;                                // номери будинків змінюються рідко: 45 днів квадрат не перепитуємо
const TPL_MS = 6 * 3600e3, MAX_TILES = 1500;
export const HOUSE_Z = 17;                                  // номери — лише зблизька, щоб на ходу не захаращували карту (домовленість 1.1.8)
export const addr = { net: 0, hits: 0, fails: 0, last: '', prefetched: 0, own: 0 };

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
/** (1.1.40) Адреса квадратів OpenFreeMap із версією даних — «{z}/{x}/{y}» підставляє той, хто питає («ворота» в gates.js). */
export const ofmTemplate = () => template(false);

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

/* ---------- власні пачки номерів: уся Україна без мережі ---------- */
const PACK_CACHE = 'reis-addr-pack-1', IDX_KEY = 'reis.addrIdx', IDX_MS = 24 * 3600e3, PACK_Z = 8;
export const packs = { index: null, busy: false, done: 0, total: 0, stop: false, err: '', net: 0, used: 0 };
const repo = () => { try { return (P.appInfo() || {}).repo || ''; } catch (_) { return ''; } };
// raw.githubusercontent.com віддає файли гілки з дозволом для вебсторінок (CORS); jsDelivr — запасне дзеркало того самого
const packBases = () => { const r = repo(); return r ? ['https://raw.githubusercontent.com/' + r + '/addr/v1/', 'https://cdn.jsdelivr.net/gh/' + r + '@addr/v1/'] : []; };
async function packFetch(name, asJson) {
  let last = new Error('невідомо, де лежать номери');
  for (const b of packBases()) {
    try {
      const r = await fetch(b + name, { cache: 'no-store' });
      if (r.ok) return asJson ? await r.json() : new Uint8Array(await r.arrayBuffer());
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
  }
  throw last;
}
/** Каталог пачок: дата даних, скільки номерів, які квадрати є. Раз на добу — з мережі, решту часу — із пам'яті телефона. */
let idxBusy = null, idxTried = 0;
export function packIndex(force = false) {
  if (packs.index && !force && Date.now() - packs.indexAt < IDX_MS) return Promise.resolve(packs.index);
  if (idxBusy) return idxBusy;
  idxBusy = (async () => {
    let saved = null; try { saved = JSON.parse(localStorage.getItem(IDX_KEY) || 'null'); } catch (_) {}
    if (saved && saved.i && !force && Date.now() - saved.t < IDX_MS) { packs.index = saved.i; packs.indexAt = saved.t; return saved.i; }
    if (P.online() && packBases().length && (force || Date.now() - idxTried > 60000)) {
      idxTried = Date.now();
      try {
        const i = await packFetch('index.json', true);
        if (i && i.packs && i.v === 1) { packs.index = i; packs.indexAt = Date.now(); packs.err = ''; try { localStorage.setItem(IDX_KEY, JSON.stringify({ t: packs.indexAt, i })); } catch (_) {} return i; }
      } catch (e) { packs.err = String(e && e.message || e).slice(0, 80); }
    }
    if (saved && saved.i) { packs.index = saved.i; packs.indexAt = Date.now() - IDX_MS + 600000; return saved.i; }   // старий каталог кращий за жодного; за 10 хв спитаємо знову
    return null;
  })().finally(() => { idxBusy = null; });
  return idxBusy;
}
const memPacks = new Map();
const packUrl = k => location.origin + '/__addrpack/' + k;
const packStore = async () => { try { return typeof caches !== 'undefined' ? await caches.open(PACK_CACHE) : null; } catch (_) { return null; } };
async function packStored(k) {
  const c = await packStore(); if (!c) return memPacks.get(k) || null;
  try { const r = await c.match(packUrl(k)); return r ? { gz: new Uint8Array(await r.arrayBuffer()), date: r.headers.get('x-reis-date') || '' } : null; } catch (_) { return null; }
}
async function packPut(k, gz, date) {
  const c = await packStore();
  if (c) { try { await c.put(packUrl(k), new Response(gz, { headers: { 'content-type': 'application/octet-stream', 'x-reis-date': String(date || '') } })); return; } catch (_) {} }
  memPacks.set(k, { gz, date });
}
/** Що вже лежить у телефоні: квадрат → дата даних. */
export async function packHave() {
  const out = new Map(), c = await packStore();
  if (!c) { for (const [k, v] of memPacks) out.set(k, v.date); return out; }
  try { for (const rq of await c.keys()) { const k = rq.url.slice(rq.url.lastIndexOf('/') + 1), r = await c.match(rq); out.set(k, r ? r.headers.get('x-reis-date') || '' : ''); } } catch (_) {}
  return out;
}
/** Розбір пачки (формат — у tools/build_addr.py): покажчик квадратів масштабу 14 і дані номерів. */
export function readPack(raw) {
  if (raw.length < 6 || raw[0] !== 0x52 || raw[1] !== 0x41 || raw[2] !== 0x44 || raw[3] !== 0x31) throw new Error('це не пачка номерів');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), n = dv.getUint16(4, true), base = 6 + 8 * n, tiles = new Map();
  for (let i = 0; i < n; i++) { const o = 6 + 8 * i; tiles.set(raw[o] + raw[o + 1] * 64, { count: dv.getUint16(o + 2, true), off: base + dv.getUint32(o + 4, true) }); }
  return { raw, tiles };
}
export function packPoints(pk, tx, ty) {
  const e = pk.tiles.get(tx + ty * 64); if (!e) return [];
  const out = [], b = pk.raw, td = new TextDecoder(); let o = e.off;
  for (let i = 0; i < e.count && o + 4 <= b.length; i++) { const L = b[o + 3]; out.push({ x: (b[o] << 4) | (b[o + 1] >> 4), y: ((b[o + 1] & 15) << 8) | b[o + 2], n: td.decode(b.subarray(o + 4, o + 4 + L)) }); o += 4 + L; }
  return out;
}
/** Точки з номерами → квадрат для карти (MVT, шар «housenumber» — той самий, що в OpenFreeMap, тож шар підписів один). */
export function mvtHouse(pts) {
  const out = [], enc = new TextEncoder();
  const v = (a, n) => { do { let c = n % 128; n = Math.floor(n / 128); if (n > 0) c |= 0x80; a.push(c); } while (n > 0); };
  const ld = (a, f, bytes) => { v(a, (f << 3) | 2); v(a, bytes.length); for (let i = 0; i < bytes.length; i++) a.push(bytes[i]); };
  const vals = [], vi = new Map(), body = [];
  ld(body, 1, enc.encode('housenumber'));
  for (const p of pts) {
    let i = vi.get(p.n); if (i == null) { i = vals.length; vals.push(p.n); vi.set(p.n, i); }
    const tags = [], geom = [], ft = []; v(tags, 0); v(tags, i); v(geom, 9); v(geom, p.x << 1); v(geom, p.y << 1);       // 9 = «перейти до» ×1; місце невід'ємне, тож зигзаг — це просто ×2
    ld(ft, 2, tags); v(ft, (3 << 3) | 0); v(ft, 1); ld(ft, 4, geom);
    ld(body, 2, ft);
  }
  ld(body, 3, enc.encode('housenumber'));
  for (const s of vals) { const val = []; ld(val, 1, enc.encode(s)); ld(body, 4, val); }
  v(body, (5 << 3) | 0); v(body, 4096); v(body, (15 << 3) | 0); v(body, 2);
  ld(out, 3, body);
  return new Uint8Array(out);
}
const parsed = new Map(), opening = new Map();               // розібрані пачки в пам'яті (кілька останніх); пачки, які саме зараз відкриваються
// Кілька квадратів на екрані лежать в одній пачці — відкриваємо (і качаємо) її один раз на всіх
function packOpen(k) {
  if (parsed.has(k)) { const pk = parsed.get(k); parsed.delete(k); parsed.set(k, pk); return Promise.resolve(pk); }
  if (!opening.has(k)) opening.set(k, packOpen1(k).finally(() => opening.delete(k)));
  return opening.get(k);
}
async function packOpen1(k) {
  const idx = await packIndex();
  let st = await packStored(k);
  if (!st) {
    if (!idx) return null;                                   // каталогу немає: пачки ще не зібрані або мережі не було жодного разу
    if (!idx.packs[k]) return { raw: new Uint8Array(0), tiles: new Map() };       // у цьому районі в OpenStreetMap номерів немає взагалі
    if (!P.online()) return null;
    try { const gz = await packFetch(k + '.bin.gz'); await packPut(k, gz, idx.date); st = { gz, date: idx.date }; packs.net++; bus.emit('addrPacks', packs); setTimeout(() => { packAuto().catch(() => {}); }, 3000); }   // мережа щойно спрацювала — добрий час докласти й решту України
    catch (e) { packs.err = String(e && e.message || e).slice(0, 80); return null; }
  } else if (idx && idx.packs[k] && st.date !== idx.date && P.online()) {
    packFetch(k + '.bin.gz').then(gz => packPut(k, gz, idx.date)).then(() => parsed.delete(k)).catch(() => {});     // є новіші дані — оновимо тихо, а зараз показуємо те, що є
  }
  let pk; try { pk = readPack(await gunzipIfNeeded(st.gz)); } catch (e) { packs.err = String(e && e.message || e).slice(0, 80); return null; }
  parsed.set(k, pk); while (parsed.size > 6) parsed.delete(parsed.keys().next().value);
  return pk;
}
/** Номери одного квадрата масштабу 14 із власної пачки: готовий квадрат для карти; null — пачки тут (поки) немає. */
async function packTile(x, y) {
  if (!packBases().length) return null;
  const sh = Z - PACK_Z, pk = await packOpen((x >> sh) + '_' + (y >> sh)); if (!pk) return null;
  const pts = packPoints(pk, x & 63, y & 63);
  packs.used++;
  return pts.length ? mvtHouse(pts) : new Uint8Array(0);
}
/** Завантажити в телефон усю Україну (або докачати те, чого бракує чи що застаріло). Перебіг — у packs і події addrPacks. */
export async function packDownloadAll() {
  if (packs.busy) return false;
  packs.busy = true; packs.stop = false; packs.err = ''; packs.done = 0; packs.total = 0; bus.emit('addrPacks', packs);
  try {
    const idx = await packIndex(true); if (!idx) throw new Error(packs.err || 'каталог номерів недоступний');
    const keys = Object.keys(idx.packs), have = await packHave(), todo = keys.filter(k => have.get(k) !== idx.date);
    packs.total = keys.length; packs.done = keys.length - todo.length; bus.emit('addrPacks', packs);
    let i = 0, fail = null;
    // пачка не далась (мережа зникла) — зупиняються всі три «робітники»; те, що вже в телефоні, лишається, наступного разу докачаємо решту
    // водій натиснув «Зупинити» чи «Видалити», поки пачка летіла, — у телефон її вже не кладемо
    const worker = async () => { while (i < todo.length && !packs.stop && !fail) { const k = todo[i++]; try { const gz = await packFetch(k + '.bin.gz'); if (packs.stop) break; await packPut(k, gz, idx.date); parsed.delete(k); packs.done++; packs.net++; bus.emit('addrPacks', packs); } catch (e) { fail = e; } } };
    await Promise.all([worker(), worker(), worker()]);
    if (fail) throw fail;
    const c = await packStore(); if (c && !packs.stop) for (const [k] of have) if (!idx.packs[k]) await c.delete(packUrl(k));     // квадратів, яких більше немає в каталозі, не тримаємо
    if (!packs.stop) fullFor = idx.date;
  } catch (e) { packs.err = String(e && e.message || e).slice(0, 80); }
  packs.busy = false; bus.emit('addrPacks', packs);
  return !packs.err && !packs.stop;
}
export function packStop() { packs.stop = true; autoHold = true; }      // водій натиснув «Зупинити» — до перезапуску чи його дотику сама не поновлюємо
export async function packDeleteAll() {
  packs.stop = true; parsed.clear(); memPacks.clear(); fullFor = '';
  try { if (typeof caches !== 'undefined') await caches.delete(PACK_CACHE); } catch (_) {}
  bus.emit('addrPacks', packs);
}

/* ---------- сама, без дотиків: уся Україна в телефоні ---------- */
// Уся Україна — близько 9 МБ (як кілька фотографій). Тож щойно в телефоні є офлайн-карта й з'явилась мережа, застосунок
// сам кладе в телефон усі пачки, а коли на сервері свіжіші дані (раз на місяць) — сам оновлює. Водієві нічого не треба
// натискати: поїхав туди, де мережі немає, — номери вже є.
//   • качаємо будь-якою мережею, і мобільною теж: водій тижнями в рейсі без Wi-Fi, а 9 МБ — це не файл карти на 1,9 ГБ
//     (перемикач «лише через Wi-Fi» в «Налаштуваннях» — саме про файл карти, і там це сказано);
//   • виняток — у телефоні ввімкнено «Економію трафіку» (navigator.connection.saveData) і мережа мобільна: чекаємо на Wi-Fi
//     (пачку СВОГО району беремо однаково, коли водій наблизив карту: це десятки–сотні КБ);
//   • водій сам видалив номери в «Налаштуваннях» — без його дотику більше не качаємо (AUTO_KEY = '0');
//   • не вдалося (мережа зникла) — те, що встигли, лишається; наступна спроба за кілька хвилин докачає решту.
const AUTO_KEY = 'reis.addrAuto', AUTO_GAP_MS = 5 * 60e3, AUTO_START_MS = 6000, AUTO_TICK_MS = 10 * 60e3;
let autoAt = 0, autoRun = null, mapHere = false, fullFor = '', autoHold = false;
export const autoOn = () => { try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch (_) { return true; } };
export function autoSet(on) { try { if (on) localStorage.removeItem(AUTO_KEY); else localStorage.setItem(AUTO_KEY, '0'); } catch (_) {} autoAt = 0; autoHold = false; }
// Мобільна мережа з «Економією трафіку»? Android WebView каже тип мережі (navigator.connection.type) і чи ввімкнено економію
// (saveData); якщо не каже — не вгадуємо й не чекаємо.
const conn = () => { try { return navigator.connection || null; } catch (_) { return null; } };
export const cellular = () => { const c = conn(); return !!c && c.type === 'cellular'; };
export const dataSaver = () => { const c = conn(); return !!c && c.saveData === true; };
export const waitsWifi = () => autoOn() && cellular() && dataSaver();
/** Спроба покласти в телефон усю Україну без участі водія. Повертає, чим скінчилось (для журналу й перевірок). */
export function packAuto(force = false) {
  if (!autoRun) autoRun = packAuto1(force).catch(() => 'fail').finally(() => { autoRun = null; });
  return autoRun;
}
async function packAuto1(force) {
  if (packs.busy || autoHold || !autoOn() || !mapHere || !packBases().length) return 'skip';
  if (!P.online()) return 'offline';
  if (!force && Date.now() - autoAt < AUTO_GAP_MS) return 'later';
  if (waitsWifi()) return 'wifi';
  const idx = await packIndex(); if (!idx) { autoAt = Date.now(); return 'noindex'; }
  if (fullFor === idx.date) return 'full';
  const have = await packHave();
  if (Object.keys(idx.packs).every(k => have.get(k) === idx.date)) { fullFor = idx.date; return 'full'; }
  autoAt = Date.now();
  const first = have.size === 0;
  log('info', 'номери будинків: кладу в телефон усю Україну (' + (first ? 'вперше' : 'оновлення') + ', дані від ' + idx.date + ')');
  const ok = await packDownloadAll();
  if (!ok) { log('warn', 'номери будинків: завантажити не вдалося' + (packs.err ? ' — ' + packs.err : '') + '; спробую згодом'); return packs.stop ? 'stopped' : 'fail'; }
  autoAt = 0;
  log('info', 'номери будинків: уся Україна в телефоні — ' + (packs.index ? packs.index.total : '?') + ' номерів');
  bus.emit('addrAuto', { first, total: packs.index ? packs.index.total : 0, date: packs.index ? packs.index.date : '' });
  return 'done';
}
/** Для «Налаштувань»: що є на сервері й що вже в телефоні. */
export async function packInfo() {
  const idx = await packIndex(), have = await packHave();
  const all = idx ? Object.keys(idx.packs) : [], fresh = all.filter(k => have.get(k) === idx.date).length, old = all.filter(k => have.has(k) && have.get(k) !== idx.date).length;
  let bytes = 0, nums = 0; if (idx) for (const k of all) if (have.has(k)) { nums += idx.packs[k][0]; bytes += idx.packs[k][1]; }
  return { index: idx ? { date: idx.date, total: idx.total, bytes: idx.bytes, packs: all.length } : null, have: have.size, fresh, old, nums, bytes, busy: packs.busy, done: packs.done, total: packs.total, err: packs.err,
    auto: autoOn(), wifi: waitsWifi(), online: P.online() };
}

/* ---------- один квадрат номерів: із запасу або з мережі ---------- */
// Запит не обриваємо, навіть якщо карта вже «передумала» (водій посунув її далі): квадрат малий, а в запасі знадобиться.
const flying = new Map();
function getTile(x, y) {
  const k = x + '/' + y;
  if (!flying.has(k)) flying.set(k, loadTile(x, y).finally(() => flying.delete(k)));
  return flying.get(k);
}
async function loadTile(x, y) {
  // 1) власна пачка цього району (є в телефоні або щойно взята з мережі) — номери без сторонніх серверів і без мережі
  const own = await packTile(x, y).catch(() => null);
  if (own) { addr.own++; return own; }
  // 2) квадрат OpenFreeMap із запасу або з мережі
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
  if (d == null) { bus.emit('addrMiss', { x: +m[2], y: +m[3] }); return { data: new ArrayBuffer(0), cacheControl: 'max-age=40' }; }
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
export const houseSource = () => ({ type: 'vector', tiles: ['reisaddr://{z}/{x}/{y}'], minzoom: Z, maxzoom: Z, attribution: '© OpenStreetMap' });

export function init() {
  try { maplibregl.addProtocol('reisaddr', tileLoad); } catch (e) { log('warn', 'номери будинків: ' + e.message); }
  if (P.online()) packIndex().then(i => { if (i) log('info', 'номери будинків: каталог пачок від ' + i.date + ', номерів ' + i.total); }).catch(() => {});
  // уся Україна — сама: після запуску (не заважаючи йому), коли з'явилась мережа чи Wi-Fi, коли встановилась офлайн-карта, і зрідка — на випадок довгого рейсу
  try { const s = P.offlineStatus(); mapHere = !!(s && s.installed); } catch (_) {}
  const tryAuto = () => { packAuto().catch(() => {}); };
  bus.on('offline', o => { const was = mapHere; mapHere = !!(o && o.installed); if (mapHere && !was) tryAuto(); });
  setTimeout(tryAuto, AUTO_START_MS); setInterval(tryAuto, AUTO_TICK_MS);
  try { window.addEventListener('online', tryAuto); } catch (_) {}
  try { document.addEventListener('visibilitychange', () => { if (!document.hidden) tryAuto(); }); } catch (_) {}
  try { const c = conn(); if (c && c.addEventListener) c.addEventListener('change', () => { bus.emit('addrPacks', packs); tryAuto(); }); } catch (_) {}
  // просимо систему не чистити наш запас, коли в телефоні мало місця (якщо все ж почистить — packAuto докачає знову)
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (_) {}
  // рушили в рейс — номери навколо фінішу й проміжної точки кладемо в запас (один раз на рейс, лише коли є мережа)
  let doneFor = '';
  bus.on('trip', g => {
    const tr = g && g.active && g.trip; if (!tr || !tr.b || !P.online()) return;
    const key = (tr.id || '') + '|' + tr.b.lat + ',' + tr.b.lon + '|' + (tr.v ? tr.v.lat + ',' + tr.v.lon : '');
    if (key === doneFor) return; doneFor = key;
    tryAuto();                                                // рейс щойно прокладено — мережа є: якщо всієї України ще немає в телефоні, саме час
    (async () => {
      let n = await prefetch(tr.b.lat, tr.b.lon, 1);
      if (tr.v) n += await prefetch(tr.v.lat, tr.v.lon, 0);
      log('info', 'номери будинків біля фінішу' + (tr.v ? ' і проміжної точки' : '') + ': у запасі квадратів ' + n);
    })().catch(() => {});
  });
}
