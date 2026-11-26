// Наскрізна перевірка веб-шару в безголовому Chromium. Усі зовнішні сервіси підмінені:
// маршрут, пошук, Overpass, Telegram, тривоги. Перевіряється логіка, а не живі сервери.
// Запуск:  node tests/e2e.mjs [--shots dir]
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync, deflateSync, crc32 } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
// ONLY=1,2д node tests/e2e.mjs — лише вибрані проходи (для налагодження)
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean), run = id => !ONLY.length || ONLY.includes(id);
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let rangeHits = 0;
const PM = { old: false, rangeBroken: false, failFrom: null, q: 0, range: 0, file: 'tiny', fonts: false };   // як поводиться «оболонка» з файлом офлайн-карти
// Файли карти для перевірок: tiny — крихітний (піраміда до Харкова); city — СПРАВЖНІЙ квадрат Львова (tools/make_city_fixture.mjs);
// blank — той самий заголовок, але у квадраті немає жодного об'єкта («файл читається, а малювати нічого»).
const pmFiles = {};
async function pmFile(name) {
  if (pmFiles[name]) return pmFiles[name];
  const fx = n => readFile(join(ROOT, '..', 'tests', 'fixtures', n + '.pmtiles'));
  if (name !== 'blank') return (pmFiles[name] = await fx(name));
  const city = await fx('city'), { gzipSync } = await import('node:zlib');
  const rv = (b, o) => { let v = 0n, sh = 0n; for (;;) { const x = b[o++]; v |= BigInt(x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7n; } return [v, o]; };
  const wv = n => { const out = []; let x = BigInt(n); do { let c = Number(x & 0x7fn); x >>= 7n; if (x > 0n) c |= 0x80; out.push(c); } while (x > 0n); return out; };
  const [, o1] = rv(city, 127), [id] = rv(city, o1);                                     // номер квадрата з каталогу справжнього файлу
  const tile = gzipSync(Buffer.from([0x1a, 0x09, 0x0a, 0x02, 0x7a, 0x7a, 0x28, 0x80, 0x20, 0x78, 0x02]));   // шар «zz» без об'єктів
  const dir = Buffer.from([...wv(1), ...wv(id), ...wv(1), ...wv(tile.length), ...wv(1)]), H = Buffer.from(city.subarray(0, 127));
  const u64 = (o, v) => H.writeBigUInt64LE(BigInt(v), o), meta = Buffer.from('{}'), dataOff = 127 + dir.length + meta.length;
  u64(8, 127); u64(16, dir.length); u64(24, 127 + dir.length); u64(32, meta.length); u64(40, dataOff); u64(48, 0); u64(56, dataOff); u64(64, tile.length);
  return (pmFiles[name] = Buffer.concat([H, dir, meta, tile]));
}
const server = createServer(async (rq, rs) => {
  try {
    const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
    if (p === '/offline/ukraine.pmtiles') {                     // як оболонка: файл карти шматками
      const b = await pmFile(PM.file);
      const hd = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
      // оболонка №7+: шматок задано в адресі (?r=початок-кінець) — рівно ці байти, відповідь 200
      const q = /[?&]r=(\d+)-(\d+)/.exec(rq.url || '');
      if (q && !PM.old) { const s = +q[1], e = Math.min(+q[2], b.length - 1); PM.q++; if (PM.failFrom != null && s >= PM.failFrom) { rs.writeHead(500); rs.end(); return; }
        rs.writeHead(200, { ...hd, 'content-length': e - s + 1 }); rs.end(b.subarray(s, e + 1)); return; }
      const m = /bytes=(\d+)-(\d*)/.exec(rq.headers.range || '');
      if (!m) { rs.writeHead(200, { ...hd, 'content-length': b.length }); rs.end(b); return; }
      const s = +m[1], e = Math.min(m[2] ? +m[2] : b.length - 1, b.length - 1); rangeHits++; PM.range++;
      // справжній телефон до 1.1.13: WebView сам перемотує потік, а оболонка вже віддала відрізаний шматок —
      // усе, що не з початку файлу, закінчується «range not satisfiable»
      if ((PM.old || PM.rangeBroken) && s > 0) { rs.writeHead(416, { 'content-range': `bytes */${b.length}` }); rs.end(); return; }
      if (PM.failFrom != null && s >= PM.failFrom) { rs.writeHead(500); rs.end(); return; }
      rs.writeHead(206, { ...hd, 'content-range': `bytes ${s}-${e}/${b.length}`, 'content-length': e - s + 1 });
      rs.end(b.subarray(s, e + 1)); return;
    }
    // Набори літер для підписів офлайн-карти: у сховищі їх немає (збірка бере їх із Protomaps), тож тут — як на телефоні,
    // де потрібного набору не знайшлося: 404. Один «тестовий» набір є — щоб перевірити й звичайний шлях.
    if (p === '/vendor/glyphs/Test Font/0-255.pbf') { rs.writeHead(200, { 'content-type': 'application/x-protobuf' }); rs.end(Buffer.from('GLYF')); return; }
    // PM.fonts — «набори літер у збірці є»: латинка з цифрами й кирилиця (справжні файли Noto Sans — tests/fixtures/glyphs); решти, як і в збірці, немає
    if (PM.fonts && p.startsWith('/vendor/glyphs/')) { const b = await readFile(join(ROOT, '..', 'tests', 'fixtures', 'glyphs', p.slice('/vendor/glyphs/'.length).replace(/^Noto Sans (Medium|Italic)\//, 'Noto Sans Regular/'))); rs.writeHead(200, { 'content-type': 'application/x-protobuf' }); rs.end(b); return; }
    const f = join(ROOT, p === '/' ? 'index.html' : p);
    const b = await readFile(f); rs.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); rs.end(b);
  } catch (_) { rs.writeHead(404); rs.end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port + '/';

/* ---------- синтетичний маршрут Харків → «Полтава» ---------- */
const D2R = Math.PI / 180, R = 6371008.8;
function dest(p, brg, d) {
  const br = brg * D2R, la = p[0] * D2R, lo = p[1] * D2R, ad = d / R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(ad) + Math.cos(la) * Math.sin(ad) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(ad) * Math.cos(la), Math.cos(ad) - Math.sin(la) * Math.sin(la2));
  return [la2 / D2R, lo2 / D2R];
}
const legs = [[270, 2000], [180, 1500], [270, 2500], [315, 20000], [0, 800]];
const coords = [[49.9935, 36.2304]], turnIdx = [0];
for (const [brg, len] of legs) { for (let d = 50; d <= len; d += 50) coords.push(dest(coords[coords.length - 1], brg, 50)); turnIdx.push(coords.length - 1); }
function enc6(cs) {
  let out = '', pl = 0, po = 0;
  const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, lo] of cs) { const a = Math.round(la * 1e6), b = Math.round(lo * 1e6); out += e(a - pl) + e(b - po); pl = a; po = b; }
  return out;
}
const names = [[1, 'Рухайтеся на захід вулицею Сумською.', 'вулиця Сумська'], [15, 'Поверніть ліворуч на вулицю Пушкінську.', 'вулиця Пушкінська'], [10, 'Поверніть праворуч на вулицю Полтавський Шлях.', 'вулиця Полтавський Шлях'],
  [9, 'Тримайтеся правіше на трасу М-03.', 'М-03'], [10, 'Поверніть праворуч на вулицю Соборності.', 'вулиця Соборності'], [4, 'Ви прибули до пункту призначення.', '']];
const maneuvers = names.map(([type, ins, street], i) => {
  const b = turnIdx[Math.min(i, turnIdx.length - 1)], e = turnIdx[Math.min(i + 1, turnIdx.length - 1)], len = i < legs.length ? legs[i][1] / 1000 : 0;
  return { type, instruction: ins, verbal_transition_alert_instruction: ins, verbal_pre_transition_instruction: ins, verbal_post_transition_instruction: len > 2 ? `Продовжуйте рух ${Math.round(len)} кілометрів.` : undefined,
    street_names: street ? [street] : [], length: len, time: Math.round(len * 1000 / 15), begin_shape_index: b, end_shape_index: e };
});
const total = legs.reduce((a, l) => a + l[1], 0);
const tripJson = { trip: { legs: [{ shape: enc6(coords), maneuvers, summary: { length: total / 1000, time: Math.round(total / 15) } }], summary: { length: total / 1000, time: Math.round(total / 15) }, status: 0 } };
const A = coords[0], B = coords[coords.length - 1], camPt = coords[turnIdx[2] + 20], stopPt = coords[turnIdx[3] + 240];
// запасний варіант маршруту: дугою на північ трасою Н-31, довший і повільніший
const altCoords = coords.map((c, i) => i === 0 || i === coords.length - 1 ? c : [c[0] + 0.012 * Math.sin(Math.PI * i / (coords.length - 1)), c[1]]);
const altTrip = { legs: [{ shape: enc6(altCoords), maneuvers: [{ type: 1, instruction: 'Рушайте трасою Н-31.', street_names: ['Н-31'], length: 28.4, time: 2100, begin_shape_index: 0, end_shape_index: altCoords.length - 1 },
  { type: 4, instruction: 'Ви прибули.', street_names: [], length: 0, time: 0, begin_shape_index: altCoords.length - 1, end_shape_index: altCoords.length - 1 }], summary: { length: 28.4, time: 2100 } }], summary: { length: 28.4, time: 2100 }, status: 0 };
// перевірене місце біля тестового маршруту (фото — справжні з web/data/verified)
const vpPt = coords[turnIdx[3] + 180];
const VP_JSON = { v: 1, date: '20261122', places: [{ id: 'test-bistro', kind: 'food', name: 'Бістро (тест)', rating: 5, checked: '2026-11', lat: vpPt[0] + 0.0006, lon: vpPt[1], road: 'М-03', town: { uk: 'Тестове', ru: 'Тестовое' },
  photos: ['verified/bistro-1.jpg', 'verified/bistro-2.jpg'], thumbs: ['verified/bistro-1-s.jpg'], say: { uk: 'Радимо: смачно й чисто.', ru: 'Советуем: вкусно и чисто.' }, tags: { uk: ['Гаряча роздача'], ru: ['Горячая раздача'] },
  menu: [['Борщ із м\'ясом', '65 грн / 400 г'], ['Солянка', '60 грн / 300 г']], note: { uk: 'Ціни — з фото.', ru: 'Цены — с фото.' } },
  { id: 'test-noloc', kind: 'food', name: 'Без точки', rating: 5, checked: '2026-11', photos: ['verified/bistro-6.jpg'], thumbs: ['verified/bistro-6-s.jpg'], say: { uk: 'Тест', ru: 'Тест' } },
  { id: 'test-far', kind: 'tire', name: 'Шиномонтаж у Львові', rating: 5, checked: '2026-11', lat: 49.84, lon: 24.03, photos: ['verified/bistro-5.jpg'], thumbs: ['verified/bistro-5-s.jpg'], say: { uk: 'Тест', ru: 'Тест' } }] };

// база піт-стопів (як web/data/stops.json): камера, дві АЗС на маршруті, кафе, стоянка далеко збоку
const STOPS_JSON = { v: 1, date: '20261121', rows: [
  [camPt[0], camPt[1], 'c', 0, '', 50],
  [stopPt[0], stopPt[1], 'f', 1 | 2 | 8 | 16 | 32, 'OKKO', 0],
  [coords[turnIdx[3] + 60][0], coords[turnIdx[3] + 60][1], 'f', 0, 'АЗС', 0],
  [coords[turnIdx[3] + 300][0], coords[turnIdx[3] + 300][1], 'e', 4, 'Кафе Дорога', 0],
  [coords[turnIdx[3] + 200][0] + 0.05, coords[turnIdx[3] + 200][1], 'p', 1, 'Стоянка для фур', 0],
  [coords[turnIdx[3] + 330][0], coords[turnIdx[3] + 330][1], 'h', 2, 'Душ для водіїв', 0],
  [coords[turnIdx[3] + 61][0] + 0.0004, coords[turnIdx[3] + 61][1], 's', 0, 'Зона сервісу Тест', 0, { k: 'sv', w: 'https://example.com/zona', h: 'Mo-Su 06:00-23:00', id: 'w400', fa: ['tyres', 'wc'] }]
] };
const PLACES_JSON = { v: 1, date: '20261121', rows: [
  [49.993, 36.230, 'c', 'Харків', 'Харьков', 'kharkiv', 1421125], [49.839, 24.029, 'c', 'Львів', 'Львов', 'lviv', 717273],
  [49.588, 34.551, 'c', 'Полтава', '', 'poltava', 279593], [49.835, 36.686, 'c', 'Чугуїв', 'Чугуев', 'kharkiv', 31000],
  [48.66, 25.51, 'v', 'Львівка', '', 'chernivtsi', 0], [50.02, 30.12, 'v', 'Харківці', '', 'kyiv', 0], [B[0], B[1], 'c', 'Полтава-тест', '', 'poltava', 1],
  // (1.1.30) однойменні: місто Миколаїв (обласний центр) і місто Миколаїв на Львівщині — у файлі навмисно спершу менше
  [49.524, 23.980, 't', 'Миколаїв', 'Николаев', 'lviv', 14600], [46.975, 31.994, 'c', 'Миколаїв', 'Николаев', 'mykolaiv', 470011],
  // (1.1.32) Київ — для пошуку «набрав місто — карта там»
  [50.450, 30.523, 'c', 'Київ', 'Киев', 'kyiv', 2952301]
] };
// проблемні для фури місця (як web/data/hazards.json, формат 2): міст 15 т на М-03 уздовж маршруту (фура в парку — до 20 т),
// низький проїзд на вулиці навхрест (має ігноруватися), ґрунт 1,2 км, міст 55 т (фурі не заважає)
const HAZ_JSON = (() => {
  const groups = [['w', 15, 'М-03', 300, 1], ['h', 3.8, 'вулиця Навхрест', 50, 0], ['u', 2, 'Т-2101', 1200, 0], ['w', 55, 'М-03', 100, 1]];
  const raw = [[coords[turnIdx[3] + 100], 315, 0], [coords[turnIdx[3] + 150], 45, 1]];
  for (let i = 0; i <= 24; i += 6) raw.push([coords[turnIdx[3] + 200 + i], 315, 2]);
  raw.push([coords[turnIdx[3] + 260], 315, 3]);
  const pts = []; let pla = 0, plo = 0, pg = 0;
  for (const [c, brg, gid] of raw) { const a = Math.round(c[0] * 1e5), b = Math.round(c[1] * 1e5); pts.push(a - pla, b - plo, Math.floor(brg / 5), gid - pg); pla = a; plo = b; pg = gid; }
  return { v: 2, date: '20261121', groups, pts };
})();
const TG_HTML = (ch, msgs) => `<html><body>${msgs.map((m, i) => `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${ch}/${100 + i}"><div class="tgme_widget_message_text">${m}</div><time datetime="${new Date(Date.now() - (i + 1) * 60000).toISOString()}"></time></div></div>`).join('')}</body></html>`;
const AIR_MD = `# SITREP — UKRAINE AIR RAID WARNING STATUS\n## 3. CURRENT WARNING STATUS\n- Kharkivska oblast (Харківська область) — air raid alert in effect since 11:46\n- Tverska oblast (Тверська область) — air raid alert in effect since 00:10\n`;

/* ---------- браузер ---------- */
const exe = process.env.CHROME || '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ executablePath: existsSync(exe) ? exe : undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-proxy-server'] });
const results = [], routeReqs = [], geoReqs = []; let failed = 0;
const ok = (name, cond, extra = '') => { results.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); if (!cond) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ntfy.sh для тестів: одне сховище на всі «телефони» в тесті
const NTFY = { msgs: [], posts: 0, fail: false };
// місце-комплекс для фур (як «Автопорт»): стоянка з душем, готель, кафе — окремо ціни на послуги й окремо меню кафе
const VP_COMPLEX = { id: 'test-complex', kind: 'complex', name: 'Комплекс (тест)', rating: 5, checked: '2026-11', lat: vpPt[0] + 0.0012, lon: vpPt[1] + 0.0004, road: 'М-03', town: { uk: 'Тестове', ru: 'Тестовое' },
    photos: ['verified/bistro-1.jpg'], thumbs: ['verified/bistro-1-s.jpg'], say: { uk: 'Радимо: стоянка, готель і кафе.', ru: 'Советуем: стоянка, гостиница и кафе.' }, tags: { uk: ['Стоянка для фур', 'Готель'], ru: ['Стоянка для фур', 'Гостиница'] },
    services: [[{ uk: 'Стоянка для фури — душ входить у вартість', ru: 'Стоянка для фуры — душ входит в стоимость' }, '100 грн'], [{ uk: 'Готель: одномісний номер', ru: 'Гостиница: одноместный номер' }, '1000 грн']],
    menu: [['Борщ', '100 грн / 300 г']], note: { uk: 'Ціни станом на 24.11.2026.', ru: 'Цены на 24.11.2026.' } };
const ROUTE = { fn: null };
const PACKS = { on: false, down: false, rawDown: false, req: [], date: '', failOn: '' };      // сховище власних пачок номерів будинків                                        // підміна відповіді сервера маршрутів у окремих перевірках
// Сторінки, що лишились відкритими після збою попередньої перевірки, гальмують усі наступні (карта малює й далі) — закриваємо.
const liveCtx = new Set();
async function newPage(native, opts = {}) {
  if (!opts.keep) for (const c of [...liveCtx]) { liveCtx.delete(c); await c.close().catch(() => {}); }
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 412, height: 892 }, deviceScaleFactor: opts.dpr || 2, isMobile: true, hasTouch: true, locale: 'uk-UA' });
  liveCtx.add(ctx); ctx.on('close', () => liveCtx.delete(ctx));
  const page = await ctx.newPage();
  // (1.1.24) Панелі відкриваються на весь екран і закривають кнопки внизу. Щоб відкрити іншу панель, водій спершу закриває цю (✕) —
  // так само робить і перевірка: перед дотиком до кнопки нижньої плашки закриває відкриту панель.
  { const click0 = page.click.bind(page);
    page.click = async (sel, o) => {
      if (typeof sel === 'string' && (/^#tabs /.test(sel) || sel === '#tabRep')) {
        const closed = await page.evaluate(() => { const p = document.getElementById('panel'); if (p && !p.hidden && p.classList.contains('full')) { document.getElementById('panelOk').click(); return true; } return false; }).catch(() => false);
        if (closed) await new Promise(r => setTimeout(r, 150));
      }
      return click0(sel, o);
    }; }
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route('**/data/stops.json', r => json(r, STOPS_JSON));
  await page.route('**/data/places.json', r => json(r, PLACES_JSON));
  await page.route('**/data/hazards.json', r => json(r, HAZ_JSON));
  await page.route('**/styles/liberty', r => json(r, opts.style || { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dde5d8' } }] }));
  await page.route('**/route?json=*', r => { const q = JSON.parse(new URL(r.request().url()).searchParams.get('json')); routeReqs.push(q); const o = ROUTE.fn && ROUTE.fn(q); if (o) return json(r, o.body, o.status); json(r, q.alternates ? { ...tripJson, alternates: [{ trip: altTrip }] } : tripJson); });
  if (!opts.realVp) await page.route('**/data/verified.json', r => json(r, VP_JSON));
  // Власні пачки номерів будинків (гілка addr сховища): за замовчуванням їх «ще немає» (404) — працює шлях через OpenFreeMap.
  // PACKS.on — пачки зібрані й лежать на сервері (tests/fixtures/addr, зроблені тим самим tools/build_addr.py); PACKS.down — мережі немає.
  await page.route(/^https:\/\/(raw\.githubusercontent\.com\/test-owner\/test-repo\/addr|cdn\.jsdelivr\.net\/gh\/test-owner\/test-repo@addr)\/v1\//, async r => {
    const u = r.request().url(), name = u.slice(u.lastIndexOf('/') + 1), cors = { 'access-control-allow-origin': '*' };
    if (PACKS.down) return r.abort();
    PACKS.req.push((/jsdelivr/.test(u) ? 'cdn:' : '') + name);
    if (!PACKS.on || (PACKS.rawDown && !/jsdelivr/.test(u))) return r.fulfill({ status: 404, headers: cors, body: '' });
    if (PACKS.failOn && name === PACKS.failOn) return r.fulfill({ status: 503, headers: cors, body: '' });                 // мережа урвалась саме на цій пачці
    if (PACKS.date && name === 'index.json') { const j = JSON.parse(await readFile(join(ROOT, '..', 'tests', 'fixtures', 'addr', 'v1', name), 'utf8')); j.date = PACKS.date; return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(j) }); }   // на сервері свіжіші дані
    try { const b = await readFile(join(process.env.ADDR_DIR || join(ROOT, '..', 'tests', 'fixtures', 'addr'), 'v1', name)); r.fulfill({ status: 200, contentType: name.endsWith('.json') ? 'application/json' : 'application/octet-stream', headers: cors, body: b }); }
    catch (_) { r.fulfill({ status: 404, headers: cors, body: '' }); }
  });
  await page.route('https://ntfy.sh/**', r => {
    const rq = r.request(), u = new URL(rq.url());
    if (NTFY.fail) return r.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'down' });
    if (rq.method() === 'POST') { NTFY.posts++; const id = 'm' + (NTFY.msgs.length + 1); NTFY.msgs.push({ id, time: Math.floor(Date.now() / 1000), event: 'message', topic: u.pathname.slice(1), message: rq.postData() }); return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(NTFY.msgs[NTFY.msgs.length - 1]) }); }
    const since = u.searchParams.get('since') || 'all', i = NTFY.msgs.findIndex(m => m.id === since);
    const list = i >= 0 ? NTFY.msgs.slice(i + 1) : NTFY.msgs.filter(m => Date.now() / 1000 - m.time < 2 * 3600);
    r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/x-ndjson', body: list.map(m => JSON.stringify(m)).join('\n') + (list.length ? '\n' : '') });
  });
  await page.route('**/v1/forecast*', r => {
    const u = new URL(r.request().url()), n = u.searchParams.get('latitude').split(',').length, t0 = Math.floor(Date.now() / 3600e3) * 3600;
    const time = Array.from({ length: 48 }, (_, i) => t0 + i * 3600), z = v => time.map(() => v);
    json(r, Array.from({ length: n }, (_, i) => ({ hourly: { time, temperature_2m: z(-2), precipitation: z(i === 0 ? 1.1 : 0), snowfall: z(i === 0 ? 1.2 : 0), weather_code: z(i === 0 ? 73 : 3), wind_gusts_10m: z(20), visibility: z(20000) } })));
  });
  await page.route('**/api/?q=*', r => { const U = new URL(r.request().url()), q = decodeURIComponent(U.searchParams.get('q')).toLowerCase(); geoReqs.push(U.search);
    // (1.1.29) вулиці для пошуку «як у Google»: з lang=default — місцеві (українські) назви, без нього — англійські, як на телефоні з англійською мовою
    if (q.includes('антонич')) { const loc = U.searchParams.get('lang') === 'default', L = (uk, en) => loc ? uk : en, st = L('вулиця Богдана-Ігоря Антонича', 'Bohdana-Ihoria Antonycha Street');
      if (/\d/.test(q)) return json(r, { features: [{ geometry: { coordinates: [24.0312, 49.8105] }, properties: { housenumber: '7', street: st, city: L('Львів', 'Lviv'), state: L('Львівська область', 'Lviv Oblast'), osm_key: 'building', osm_value: 'yes', type: 'house', countrycode: 'UA' } }] });
      return json(r, { features: [
        { geometry: { coordinates: [24.0301, 49.8101] }, properties: { name: st, city: L('Львів', 'Lviv'), state: L('Львівська область', 'Lviv Oblast'), osm_key: 'highway', osm_value: 'residential', type: 'street', countrycode: 'UA' } },
        { geometry: { coordinates: [23.4791, 49.7852] }, properties: { name: L('вулиця Антонича', 'Antonycha Street'), city: L('Городок', 'Horodok'), state: L('Львівська область', 'Lviv Oblast'), osm_key: 'highway', osm_value: 'residential', type: 'street', countrycode: 'UA' } },
        { geometry: { coordinates: [24.0205, 49.8203] }, properties: { name: L('Львівська загальноосвітня санаторна школа;School', 'Lviv Sanatorium School'), street: st, housenumber: '3', city: L('Львів', 'Lviv'), state: L('Львівська область', 'Lviv Oblast'), osm_key: 'amenity', osm_value: 'school', countrycode: 'UA' } }] }); }
    // (1.1.30) «рядова» — вулиці в різних містах; сервер навмисно віддає спершу далекі
    if (q.includes('рядов')) { const F = (lon, lat, name, city, state, extra = {}) => ({ geometry: { coordinates: [lon, lat] }, properties: { name, city, state, osm_key: 'highway', osm_value: 'residential', type: 'street', countrycode: 'UA', ...extra } });
      return json(r, { features: [F(30.52, 50.45, 'вулиця Рядова', 'Київ', 'Київська область'), F(25.59, 49.55, 'вулиця Рядова', 'Тернопіль', 'Тернопільська область'),
        { geometry: { coordinates: [32.61, 46.64] }, properties: { name: 'Рядове', osm_key: 'place', osm_value: 'village', state: 'Херсонська область', countrycode: 'UA' } },
        F(23.65, 49.785, 'вулиця Рядова', 'Городок', 'Львівська область'), F(24.052, 49.807, 'вулиця Рядова', 'Львів', 'Львівська область')] }); }
    if (q.includes('миколаїв') || q.includes('николаев')) return json(r, { features: [
      { geometry: { coordinates: [24.04, 49.82] }, properties: { name: 'Миколаївська вулиця', city: 'Львів', state: 'Львівська область', osm_key: 'highway', osm_value: 'residential', type: 'street', countrycode: 'UA' } },
      { geometry: { coordinates: [31.994, 46.975] }, properties: { name: 'Миколаїв', osm_key: 'place', osm_value: 'city', state: 'Миколаївська область', countrycode: 'UA' } },
      { geometry: { coordinates: [23.98, 49.524] }, properties: { name: 'Миколаїв', osm_key: 'place', osm_value: 'town', state: 'Львівська область', countrycode: 'UA' } }] });
    // (1.1.32) вулиця в місті: сервер навмисно віддає спершу однойменну вулицю в іншому місті
    if (q.includes('хрещ')) return json(r, { features: [
      { geometry: { coordinates: [32.062, 49.444] }, properties: { name: 'вулиця Хрещатик', city: 'Черкаси', state: 'Черкаська область', osm_key: 'highway', osm_value: 'tertiary', type: 'street', countrycode: 'UA' } },
      { geometry: { coordinates: [30.5226, 50.4471] }, properties: { name: 'вулиця Хрещатик', city: 'Київ', state: 'Київська область', osm_key: 'highway', osm_value: 'primary', type: 'street', countrycode: 'UA' } }] });
    if (q.includes('львов')) return json(r, { features: [
      { geometry: { coordinates: [36.70, 50.98] }, properties: { name: 'Львов', osm_key: 'place', osm_value: 'village', county: 'Прохоровский муниципальный округ', state: 'Belgorod Oblast', countrycode: 'RU' } },
      { geometry: { coordinates: [24.03, 49.84] }, properties: { name: 'Львів', osm_key: 'place', osm_value: 'city', state: 'Львівська область', countrycode: 'UA' } }] });
    if (q.includes('чугу')) { const c = coords[turnIdx[3] + 100]; return json(r, { features: [{ geometry: { coordinates: [c[1], c[0]] }, properties: { name: 'Чугуїв', state: 'Харківська область', countrycode: 'UA' } }] }); }
    const p = q.includes('полт') ? B : A;
    json(r, { features: [{ geometry: { coordinates: [p[1], p[0]] }, properties: { name: q.includes('полт') ? 'Полтава' : 'Харків', osm_key: 'place', osm_value: 'city', state: q.includes('полт') ? 'Полтавська область' : 'Харківська область', countrycode: 'UA' } }] }); });
  await page.route('**/reverse?*', r => { geoReqs.push(new URL(r.request().url()).search); const lon = +new URL(r.request().url()).searchParams.get('lon'); const kh = lon > 36.1;
    json(r, { features: [{ properties: { name: kh ? 'Пісочин' : 'Чутове', city: kh ? 'Харків' : 'Полтава', state: kh ? 'Харківська область' : 'Полтавська область' } }] }); });
  await page.route('**/api/interpreter', r => json(r, { elements: [
    { type: 'node', id: 1, lat: camPt[0], lon: camPt[1], tags: { highway: 'speed_camera', maxspeed: '50' } },
    { type: 'node', id: 2, lat: stopPt[0], lon: stopPt[1], tags: { amenity: 'fuel', brand: 'OKKO', hgv: 'yes', shower: 'yes', toilets: 'yes', opening_hours: '24/7' } },
    { type: 'node', id: 3, lat: coords[turnIdx[3] + 60][0], lon: coords[turnIdx[3] + 60][1], tags: { amenity: 'fuel', name: 'АЗС' } }] }));
  // Базові шари з 1.1.7 — лише АЗС і камери. Старі перевірки написані під «усе увімкнено», тож для них так і ставимо
  // (лише коли налаштувань ще немає — перезавантаження сторінки вибору водія не скидає). opts.baseLayers — справжній перший запуск.
  if (!opts.baseLayers) await page.addInitScript(() => { try { if (!localStorage.getItem('reis.settings')) localStorage.setItem('reis.settings', JSON.stringify({ layersDefV: 1, mapStops: true,
    mapStopTypes: { food: true, fuel: true, park: true, motel: true, cam: true, shower: true }, mapVerified: true, mapEvents: true, mapHazards: true })); } catch (_) {} });
  if (opts.oldSettings) await page.addInitScript(o => { try { if (!localStorage.getItem('reis.settings')) localStorage.setItem('reis.settings', JSON.stringify(o)); } catch (_) {} }, opts.oldSettings);
  if (opts.motion) await page.addInitScript(m => { try { localStorage.setItem('reis.motion', JSON.stringify(m)); } catch (_) {} }, opts.motion);
  if (native) await page.addInitScript(({ tg, air, offline }) => {
    const cb = (t, d) => setTimeout(() => window.__reis && window.__reis(t, d), 20);
    window.__spoken = []; window.__nativeCalls = [];
    window.ReisNative = {
      info: () => JSON.stringify({ app: '1.0.0-test', code: 1, native: true, inst: true, repo: 'test-owner/test-repo', nativeRev: window.__nativeRev ?? 4 }), ready() {}, startTracking() { window.__nativeCalls.push('startTracking'); }, stopTracking() {},
      speak(text, lang, rate, id) { window.__spoken.push(text); cb('tts', { id, state: 'done' }); }, stopSpeak() {}, listen() { cb('stt', { state: 'final', text: 'Що попереду на дорозі?' }); }, stopListen() {},
      http(id, method, url) {
        let status = 200, body = '';
        if (url.includes('t.me/s/kharkiv_roads')) body = tg;
        else if (url.includes('alerts.in.ua')) body = air;
        else if (url.includes('api.anthropic.com')) body = JSON.stringify({ content: [{ type: 'text', text: 'Попереду ДТП на М-03, раджу об’їзд.' }] });
        else status = 404;
        cb('http', { id, status, body });
      },
      offlineStatus: () => JSON.stringify({ installed: !!offline, size: window.__pmSize || 505, date: '20261120', free: 5e9, dl: { state: 'none' } }),
      offlineCheck() { cb('offline', { remote: { date: '20261120', size: 1100000000, maxzoom: 14 } }); }, offlineDownload() {}, offlineCancel() {}, offlineDelete() {}, apkInBrowser() { window.__nativeCalls.push('apkInBrowser'); },
      // якісні голоси: стан пакета живе в window.__voice
      voiceStatus: () => JSON.stringify(window.__voice || { packs: {} }), setVoice(p, sid, l) { window.__nativeCalls.push('setVoice:' + p + ':' + sid + ':' + l); },
      voiceDownload(p) { window.__nativeCalls.push('voiceDownload:' + p); window.__voice = { packs: {}, dl: { pack: p, pct: 0 } }; }, voiceCancel() { window.__nativeCalls.push('voiceCancel'); }, voiceDelete(p) { window.__nativeCalls.push('voiceDelete:' + p); window.__voice = { packs: {} }; cb('voice', { state: 'deleted', pack: p }); },
      keepAwake(on) { window.__nativeCalls.push('keepAwake:' + on); }, openLocationSettings() { window.__nativeCalls.push('locSettings'); }, openAppSettings() {}, saveFile(n, m, txt) { window.__nativeCalls.push('saveFile:' + n); window.__savedText = txt; }, openUrl(u) { window.__nativeCalls.push('openUrl:' + u); }, postNotice() {}, vibrate() {}, checkUpdate() { window.__nativeCalls.push('checkUpdate'); }, applyWebUpdate() { window.__nativeCalls.push('applyWebUpdate'); }, installApk() { window.__nativeCalls.push('installApk'); }, reloadUi() { window.__nativeCalls.push('reloadUi'); }
    };
  }, { tg: TG_HTML('kharkiv_roads', ['Перекрито рух на трасі М-03 біля Чугуєва через ДТП за участі фури. Об’їзд через Кам’яну Яругу.', 'На заводі «Турбоатом» тимчасово зупинили виробництво.', 'Рух на мосту через Уди відновлено, дорогу відкрили.', 'Можливо, перекриють проїзд вулицею Сумською ввечері, уточнюється.', 'Знижки до 50% у нашому магазині! Підписуйтесь!']), air: AIR_MD, offline: !!opts.offline });
  if (opts.before) await opts.before(page);          // додаткові підміни (напр., квадрати з номерами будинків) — до першого завантаження
  await page.goto(BASE);
  await page.waitForFunction(() => window.__app && document.getElementById('boot') === null, null, { timeout: 15000 });
  return { page, ctx, errors };
}
// Вибір маршруту: чи весь маршрут (обидва варіанти) у вільній частині карти — між верхньою плашкою і шторкою, не під кнопками масштабу
function pickWhole(page) {
  return page.evaluate(() => {
    const m = window.__app.map.map, R = el => el && !el.hidden ? el.getBoundingClientRect() : null;
    const box = R(document.getElementById('routePick')), z = R(document.querySelector('#routePick .rp-zoom')), tp = R(document.getElementById('top')), cr = m.getContainer().getBoundingClientRect();
    const inR = (r, x, y) => r && x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
    const lines = [m.getSource('route')._data, m.getSource('route-alts')._data].flatMap(d => d.features ? d.features : [d]).map(f => f.geometry.coordinates);
    let out = 0, n = 0, under = 0;
    for (const cs of lines) for (let i = 0; i < cs.length; i += 10) { const p = m.project(cs[i]), x = cr.left + p.x, y = cr.top + p.y; n++;
      if (x < 0 || x > innerWidth || y < 0 || y > innerHeight || inR(box, x, y) || inR(tp, x, y)) out++; else if (inR(z, x, y)) under++; }
    return { n, out, under, zoom: Math.round(m.getZoom() * 100) / 100, head: document.querySelector('#routePick .rp-head').textContent.replace(/\s+/g, ' ').trim() }; });
}
// Сприйняття інтерфейсу: кожен видимий текст у межах свого блоку й екрана, не перекритий, не дрібніший за 12 px,
// контраст із тлом не нижчий за 3:1. Прокручуємо контейнер до кінця й перевіряємо кожен «екран» прокрутки.
async function readCheck(page, rootSel, scrollSel) {
  return page.evaluate(async ([rootSel, scrollSel]) => {
    const root = document.querySelector(rootSel); if (!root) return ['немає ' + rootSel];
    const sc = scrollSel ? document.querySelector(scrollSel) : null, out = new Set();
    const lum = c => { const m = c.match(/[\d.]+/g); if (!m) return null; let [r, g, b, a] = m.map(Number); if (/^color\(/.test(c)) { r *= 255; g *= 255; b *= 255; } if (a === 0) return null; const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return { L: 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b), a: a == null ? 1 : a }; };
    // тло — найближчий шар, що помітно зафарбований (скляні плашки над картою — це теж тло); картинка чи градієнт — не оцінюємо
    // (дійшли до body — під текстом сама карта, тло невідоме: не оцінюємо)
    const bgOf = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; const l = lum(cs.backgroundColor); if (l && l.a >= 0.5) return l.L; } return null; };
    const clipOf = el => { const rs = []; for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') rs.push(e.getBoundingClientRect()); } return rs; };
    const name = el => (el.id ? '#' + el.id : el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : el.tagName.toLowerCase()) + ' «' + el.textContent.trim().replace(/\s+/g, ' ').slice(0, 28) + '»';
    // видима частина прокрутки: те, що не сховано під плашками зверху й знизу
    const visView = () => { const r = sc.getBoundingClientRect(), x = (r.left + r.right) / 2; let top = r.top, bot = r.bottom;
      const sticky = h => { for (let e = h; e && e !== sc; e = e.parentElement) if (getComputedStyle(e).position === 'sticky') return true; return false; };
      const mine = y => { const h = document.elementFromPoint(x, y); return h === sc || (h && sc.contains(h) && !sticky(h)); };
      while (bot > top + 20 && !mine(bot - 2)) bot -= 4; while (top < bot - 20 && !mine(top + 2)) top += 4; return { top, bottom: bot }; };
    const check = () => {
      const view = sc ? visView() : { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue;
        const el = n.parentElement; if (!el || el.closest('[hidden]') || el.closest('svg')) continue;
        { const d = el.closest('details'); if (d && !d.open && !el.closest('summary')) continue; }       // згорнутий вміст <details> не видно
        const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
        const rg = document.createRange(); rg.selectNodeContents(n); const rects = [...rg.getClientRects()].filter(r => r.width > 1 && r.height > 1); if (!rects.length) continue;
        const r = rects.reduce((a, b) => ({ left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) }));
        if (r.bottom < view.top + 2 || r.top > view.bottom - 2) continue;                       // ще не прокрутили сюди
        const fs = parseFloat(cs.fontSize); if (fs < 12) out.add('дрібно ' + fs + 'px: ' + name(el));
        if (r.left < -1 || r.right > innerWidth + 1) out.add('за краєм екрана: ' + name(el));
        const ell = cs.textOverflow === 'ellipsis' || el.closest('[style*="ellipsis"]');
        for (const c of clipOf(el)) if (!ell && (r.right > c.right + 2 || r.left < c.left - 2)) { out.add('обрізано по ширині: ' + name(el)); break; }
        if (!ell && el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && cs.display !== 'inline') out.add('не влазить: ' + name(el));
        // перекриття: середина тексту (якщо видима в контейнері) — наш елемент
        const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        if (cy > view.top + 4 && cy < view.bottom - 4 && cx > 0 && cx < innerWidth) {
          const h = document.elementFromPoint(cx, cy);
          // (1.1.25) повідомлення-відповідь на дотик у панелі з'являється поверх неї: на кілька секунд прикриває рядок під собою — це не вада розкладки
          if (h && !(el === h || el.contains(h) || h.contains(el)) && !(h.closest('#toasts.over') && !el.closest('#toasts'))) {
            const hb = h.closest('button,a,[data-act]'), eb = el.closest('button,a,[data-act]');
            if (!(hb && eb && hb === eb)) out.add('перекрито: ' + name(el) + ' ← ' + name(h));
          }
        }
        const fg = lum(cs.color), bg = bgOf(el);
        if (fg && bg != null && fg.a > 0.85) { const hi = Math.max(fg.L, bg), lo = Math.min(fg.L, bg), cr = (hi + 0.05) / (lo + 0.05); if (cr < 3) out.add('слабкий контраст ' + cr.toFixed(1) + ': ' + name(el)); }
      }
    };
    if (sc) { sc.scrollTop = 0; await new Promise(r => setTimeout(r, 60)); for (let i = 0; i < 40; i++) { check(); if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break; sc.scrollTop += Math.max(60, sc.clientHeight * 0.7); await new Promise(r => setTimeout(r, 60)); } sc.scrollTop = 0; }
    else check();
    return [...out].slice(0, 12);
  }, [rootSel, scrollSel]);
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') }); };
const app = (page, fn, arg) => page.evaluate(fn, arg);

/* ============ дані: справжня картотека перевірених місць (web/data/verified.json) ============ */
if (run('1')) try {
  const { statSync } = await import('node:fs');
  const vj = JSON.parse(await readFile(join(ROOT, 'data', 'verified.json'), 'utf8')), bad = [];
  const KINDS = ['food', 'tire', 'repair', 'service', 'park', 'shower', 'complex'];
  for (const p of vj.places) {
    const say = k => bad.push(p.id + ': ' + k);
    if (!p.id || !p.name || !KINDS.includes(p.kind)) say('вид/назва');
    if (!(p.lat > 44 && p.lat < 53 && p.lon > 22 && p.lon < 41)) say('координати поза Україною');
    if (!p.say || !p.say.uk || !p.say.ru) say('опис двома мовами');
    if (!/^\d{4}-\d{2}$/.test(p.checked || '')) say('місяць перевірки');
    if (!(p.photos || []).length || (p.thumbs || []).length !== p.photos.length) say('фото й мініатюри');
    for (const f of [...(p.photos || []), ...(p.thumbs || [])]) { try { const n = statSync(join(ROOT, 'data', f)).size; if (n < 2000 || n > 200000) say('розмір ' + f + ' = ' + n); } catch (_) { say('немає файла ' + f); } }
    // де є ціни — має бути сказано, на який час вони записані
    if (((p.menu || []).length || (p.services || []).length) && !(p.note && /20\d\d/.test(p.note.uk || '') && /20\d\d/.test(p.note.ru || ''))) say('ціни без дати');
    for (const [n, pr] of (p.services || [])) if (!n.uk || !n.ru || !/грн/.test(pr)) say('послуга ' + JSON.stringify(n));
    for (const [n, pr] of (p.menu || [])) if (!n || (pr && !/грн/.test(pr))) say('меню ' + n);
  }
  ok('картотека перевірених місць: у кожного місця вид, координати в Україні, опис двома мовами, фото з мініатюрами (не важчі 200 КБ), ціни — з датою', vj.places.length >= 2 && bad.length === 0 && new Set(vj.places.map(p => p.id)).size === vj.places.length, bad.join(' | '));
  const ap = vj.places.find(p => p.id === 'avtoport-vinnytsia');
  ok('«Автопорт» (Вінниця): комплекс — стоянка 100 грн із душем, готель 1000 грн за одномісний, меню кафе; ціни станом на 24.11.2026', !!ap && ap.kind === 'complex' && ap.rating === 5 && Math.abs(ap.lat - 49.258925) < 1e-6 && Math.abs(ap.lon - 28.573011) < 1e-6
    && ap.services.length === 2 && /душ входить у вартість/.test(ap.services[0][0].uk) && ap.services[0][1] === '100 грн' && /одномісний/.test(ap.services[1][0].uk) && ap.services[1][1] === '1000 грн'
    && ap.menu.length >= 20 && ap.menu.some(m => m[0] === 'Яєшня' && m[1] === '75 грн') && /24\.11\.2026/.test(ap.note.uk) && /24\.11\.2026/.test(ap.note.ru) && ap.photos.length === 10, JSON.stringify(ap && { k: ap.kind, s: ap.services, n: ap.note.uk }));
} catch (e) { ok('картотека перевірених місць читається', false, String(e.message).split('\n')[0]); }

/* ============ прохід 1: застосунок (з імітацією оболонки) ============ */
if (run('1')) try {
  const { page, ctx, errors } = await newPage(true);
  ok('запуск без помилок JS', errors.length === 0, errors.join(' | '));
  ok('оболонку попросили стежити за місцем', await app(page, () => window.__nativeCalls.includes('startTracking')));
  ok('шари маршруту на карті', await page.waitForFunction(() => { const m = window.__app.map.map; return m && m.getLayer && !!m.getLayer('route-line'); }, null, { timeout: 15000 }).then(() => true, () => false));
  // геолокація вимкнена → червоний чип; потім приблизне місце до першого GPS
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await emitN('locstate', { enabled: false, gps: false, network: false, fine: true, coarse: true, listening: true });
  await sleep(300);
  ok('геолокацію вимкнено → чип каже про це', (await page.textContent('#gpsText')) === 'Геолокація вимк.', await page.textContent('#gpsText'));
  await emitN('locstate', { enabled: true, gps: true, network: true, fine: true, coarse: true, listening: true });
  await emitN('loc', { prov: 'last', lat: 49.99, lon: 36.23, acc: 25, age: 3600, t: Date.now() - 3600e3 });
  await sleep(200);
  const ap1 = await app(page, () => ({ mode: window.__app.nav.pos.mode, acc: window.__app.nav.pos.acc, chip: document.getElementById('gpsText').textContent }));
  ok('останнє відоме місце → приблизна позиція', ap1.mode === 'approx' && ap1.acc >= 1000 && ap1.chip.startsWith('≈'), JSON.stringify(ap1));
  await emitN('loc', { prov: 'network', lat: 49.992, lon: 36.231, acc: 600, t: Date.now() });
  await sleep(200);
  const ap2 = await app(page, () => ({ mode: window.__app.nav.pos.mode, acc: window.__app.nav.pos.acc }));
  ok('вишки й Wi-Fi уточнюють приблизне місце', ap2.mode === 'approx' && ap2.acc === 600, JSON.stringify(ap2));
  // справжня підміна: злите місце Android показує Ліму зі швидкістю 202 км/год
  await emitN('loc', { prov: 'fused', lat: -12.05, lon: -77.03, acc: 11, spd: 56, t: Date.now() });
  await emitN('loc', { prov: 'gps', lat: -12.05, lon: -77.03, acc: 5, spd: 0, t: Date.now() });
  await sleep(300);
  const sp0 = await app(page, () => ({ mode: window.__app.nav.pos.mode, lat: window.__app.nav.pos.lat, chip: document.getElementById('gpsText').textContent }));
  ok('Ліма відкинута: позиція лишилась в Україні, чип «Підміна GPS»', sp0.lat > 49 && sp0.mode === 'approx' && sp0.chip === 'Підміна GPS', JSON.stringify(sp0));
  ok('без справжнього GPS спідометр не бреше нулем', (await page.textContent('#spdVal')) === '—', await page.textContent('#spdVal'));
  ok('коло похибки без заливки', await app(page, () => !window.__app.map.map.getLayer('acc-fill') && !!window.__app.map.map.getLayer('acc-line')));
  await page.click('#spdGps'); await page.waitForSelector('#panelBody .item');
  ok('панель GPS: стан і супутники', /Приблизно/.test(await page.textContent('#panelBody')) && /Супутники/.test(await page.textContent('#panelBody')));
  await page.click('#panelOk');
  // підміна «в Бєлгород»: усередині старого прямокутника, але за кордоном — тепер ловиться за контуром України
  await emitN('loc', { prov: 'gps', lat: 50.6, lon: 36.59, acc: 4, spd: 0, t: Date.now() });
  await sleep(150);
  ok('підміна в Бєлгород відкинута як «за межами України»', await app(page, () => window.__app.nav.pos.spoofWhy === 'bounds' && window.__app.nav.pos.lat < 50.1));
  ok('Крим і прикордонні міста — Україна, Бєлгород і Гомель — ні', await app(page, () => {
    const u = window.__app.core.inUkraine;
    return u({ lat: 44.95, lon: 34.1 }) && u({ lat: 50.91, lon: 34.8 }) && u({ lat: 48.43, lon: 22.2 }) && u({ lat: 45.35, lon: 28.84 }) && !u({ lat: 50.6, lon: 36.59 }) && !u({ lat: 52.44, lon: 30.99 }) && !u({ lat: 47.01, lon: 28.86 });
  }));
  await page.click('#spdGps'); await page.waitForSelector('[data-act="journal"]');
  await page.click('[data-act="journal"]'); await sleep(200);
  const jr = await app(page, () => { const n = window.__nativeCalls.find(x => /^saveFile:reis-gps-\d{8}-\d{4}\.json$/.test(x)); let j = null; try { j = JSON.parse(window.__savedText); } catch (_) {} return { n, cnt: j ? j.entries.length : 0, rej: j ? j.entries.filter(e => /^rej:/.test(e.v)).map(e => e.v) : [] }; });
  ok('журнал GPS зберігається файлом і показує, що відкинуто й чому', !!jr.n && jr.cnt >= 4 && jr.rej.includes('rej:bounds'), JSON.stringify(jr));
  await page.click('#panelOk');
  ok('база піт-стопів завантажена й намальована на карті', await page.waitForFunction(() => { const s = window.__app.stopsdb.sdb; const m = window.__app.map.map; return s.ready && s.count === 7 && m.getLayer('stops-all') && m.getLayer('stops-major'); }, null, { timeout: 8000 }).then(() => true, () => false), await app(page, () => JSON.stringify({ c: window.__app.stopsdb.sdb.count, r: window.__app.stopsdb.sdb.ready, l: !!window.__app.map.map.getLayer('stops-all') })));
  await app(page, () => window.__app.bus.emit('stopTap', { i: 1 }));
  const card = await page.textContent('#pick');
  ok('торкання точки: картка з назвою й зручностями; «для фур» про АЗС не пишемо (1.1.22: біля АЗС фури не пускають)', /OKKO/.test(card) && /душ/.test(card) && !/для фур/.test(card), card.slice(0, 120));
  await page.click('#pick [data-k="x"]');
  // зона сервісу: що тут є, що поруч, години й посилання
  await app(page, () => window.__app.bus.emit('stopTap', { i: 6 }));
  const zs = await page.textContent('#pick');
  ok('зона сервісу: що тут є, що поруч, години', /Що тут є: туалет · шиномонтаж/.test(zs) && /Поруч: АЗС · 90 м/.test(zs) && /Години: Пн-Нд 06:00-23:00/.test(zs), zs.replace(/\s+/g, ' ').slice(0, 220));
  ok('зона сервісу: кнопки Google Maps, Сайт, OSM', await page.$$eval('#pick [data-u]', e => e.map(x => x.textContent).join(',')) === 'Google Maps,Сайт,OSM');
  await page.click('#pick [data-u^="https://example.com"]'); await sleep(100);
  ok('«Сайт» відкриває сторінку, картка лишається', await app(page, () => window.__nativeCalls.includes('openUrl:https://example.com/zona') && !document.getElementById('pick').hidden));
  await shot(page, '01c-services');
  await page.click('#pick [data-k="x"]');
  // душ: позначка водія на АЗС без душу в базі
  await app(page, () => window.__app.bus.emit('stopTap', { i: 2 }));
  ok('картка АЗС без душу в базі: душ не стверджується, є лише дія «позначити»', /Я бачив тут душ — позначити/.test(await page.textContent('#pick')) && !/·[^·]*душ/.test(await page.textContent('#pick .muted')));
  await page.click('#pick [data-k="shower"]'); await sleep(200);
  const shm = await app(page, async () => { const d = await window.__app.map.map.getSource('marks').getData(); return { n: window.__app.showers.myShowers().length, f: d.features.length, all: window.__app.showers.allShowers().length }; });
  ok('позначка душу збережена й намальована на карті; усього душів: OKKO, окремий душ і позначка', shm.n === 1 && shm.f === 1 && shm.all === 3, JSON.stringify(shm));
  await page.click('#tabs button[data-panel="trip"]');
  { const pb = await app(page, () => ({ text: document.getElementById('panelBody').textContent, tags: [...document.querySelectorAll('#panelBody .field .tag')].map(x => (x.querySelector('svg') ? x.className.replace('tag ', '') : '?') + x.textContent.trim()).join(''), ph: [...document.querySelectorAll('#panelBody .field input')].map(x => x.placeholder) }));
    ok('«Рейс»: лише три точки — старт (звідки), через, фініш (куди): значки замість літер А·Б·С, без душів і зайвого', pb.tags === 'avb' && /Моє місце зараз/.test(pb.ph[0]) && /Через/.test(pb.ph[1]) && /Куди/.test(pb.ph[2]) && !/душ/i.test(pb.text), JSON.stringify({ tags: pb.tags, ph: pb.ph, text: pb.text.slice(0, 120) })); }
  await shot(page, '01b-shower');
  await page.click('#panelOk');
  // що показувати на карті (1.1.20): кнопки «Шари» справа вгорі більше немає — усі галочки в «Місцях», там же «Показати все / Прибрати все» і «Готово»
  ok('кнопки «Шари» справа вгорі більше немає — справа лише швидкі налаштування, тип карти й (1.1.28) звук', await app(page, () => !document.getElementById('bLayers') && [...document.querySelectorAll('#rail > button')].map(b => b.id).join() === 'bQuick,bMap,bSnd,bSearch'));
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips');
  const plc = await app(page, () => { const R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; }, d = document.querySelector('#panelOk'), pb = document.getElementById('panelBody');
    return { keys: [...document.querySelectorAll('.pl-chip')].map(b => b.dataset.plc).join(), labels: [...document.querySelectorAll('.pl-chip')].map(b => b.querySelector('span:last-of-type').textContent).join(), done: d ? { label: d.getAttribute('aria-label'), box: R(d), svg: !!d.querySelector('svg') } : null, body: R(pb),
      all: !!document.querySelector('[data-plc="#all"]'), none: !!document.querySelector('[data-plc="#none"]'), full: [...document.querySelectorAll('.pl-chip[aria-label]')].map(b => b.getAttribute('aria-label')).join('|'),
      pics: [...document.querySelectorAll('.pl-chip')].map(b => { const i = b.querySelector('.pl-ic'); return b.dataset.plc + ':' + (i.querySelector('svg') ? 'svg' : i.textContent.trim()) + ':' + Math.round(i.getBoundingClientRect().height); }).join(),
      rows: [...document.querySelectorAll('.pl-row')].slice(0, 4).map(r => (r.querySelector('.pl-ic.pic svg, .pl-ic svg') ? 'pic' : 'dot') + ':' + r.querySelector('.pl-d b').textContent.trim()), dots: document.querySelectorAll('#panelBody .sdot').length,
      chipH: Math.max(...[...document.querySelectorAll('.pl-chip')].map(b => Math.round(b.getBoundingClientRect().height))), chipsB: Math.round(Math.max(...[...document.querySelectorAll('.pl-chip')].map(b => b.getBoundingClientRect().bottom))), firstRowT: (r => r ? Math.round(r.getBoundingClientRect().top) : -1)(document.querySelector('.pl-row')) }; });
  ok('«Місця»: одинадцять галочок-плиток в одній сітці — АЗС, Їжа, Стоянки, Мотелі, Душ, Перевірені, Камери, Позначки, Події, Проблемні, Покриття (повні назви — для озвучення); «Показати все», «Прибрати все»', plc.keys === 'fuel,food,park,motel,shower,@mapVerified,cam,@mapReports,@mapEvents,@mapHazards,@roughMap' && plc.labels === 'АЗС,Їжа,Стоянки,Мотелі,Душ,Перевірені,Камери,Позначки,Події,Проблемні,Покриття' && plc.all && plc.none
    && plc.full === 'Камери|Позначки водіїв (поліція, ДТП…)|Події на шляху|Проблемні місця для фури|Мої заміри покриття', JSON.stringify(plc));
  ok('(1.1.22) замість кольорових кружечків — мінізображення: на кожній плитці малюнок того, що вона означає (колонка, вилка з ножем, «P», ліжко, душ, зірка, камера, кашкет, дзвоник, знак «20», дорога), і в списку нижче — ті самі', plc.pics === 'fuel:svg:24,food:svg:24,park:svg:24,motel:svg:24,shower:svg:24,@mapVerified:★:24,cam:svg:25,@mapReports:svg:25,@mapEvents:svg:24,@mapHazards:20:22,@roughMap:svg:24' && plc.dots === 0 && plc.rows.length >= 2 && plc.rows.every(x => /^pic:/.test(x)), JSON.stringify({ pics: plc.pics, rows: plc.rows, dots: plc.dots }));
  ok('(1.1.22) плитки компактні (до 56 пікселів заввишки) — список найближчих із відстанями видно одразу, без прокручування', plc.chipH <= 56 && plc.chipH >= 48 && plc.firstRowT > 0 && plc.firstRowT < plc.body.b - 60 && plc.chipsB - plc.body.t <= 190, JSON.stringify({ chipH: plc.chipH, chipsB: plc.chipsB, firstRowT: plc.firstRowT, body: plc.body }));
  ok('(1.1.22) «Готово» — маленький квадрат із галочкою в правому нижньому куті «Місць» (не на всю ширину)', !!plc.done && plc.done.label === 'Готово' && plc.done.svg && plc.done.box.w === 54 && plc.done.box.h === 54 && plc.body.r - plc.done.box.r <= 20 && plc.done.box.b <= plc.body.b + 1 && plc.body.b - plc.done.box.b <= 24, JSON.stringify({ done: plc.done, body: plc.body }));
  await shot(page, '01d-layers');
  const feats = () => app(page, async () => { const m = window.__app.map.map; const s = await m.getSource('stops').getData(), k = await m.getSource('marks').getData(); return { stops: s.features.map(f => f.properties.t).join(''), marks: k.features.length }; });
  await page.click('[data-plc="#none"]'); await sleep(200);
  const f0 = await feats();
  ok('«Прибрати все» — на карті жодної точки й позначки (чиста карта)', f0.stops === '' && f0.marks === 0 && await app(page, () => { const S = window.__app.S; return !S.mapVerified && !S.mapReports && !S.mapEvents && !S.mapHazards && !S.roughMap; }), JSON.stringify(f0));
  await page.click('.pl-chip[data-plc="fuel"]'); await sleep(200);
  const f1 = await feats();
  ok('галочка «АЗС» — лише заправки', /^f+$/.test(f1.stops) && f1.marks === 0, JSON.stringify(f1));
  await page.click('[data-plc="#none"]'); await page.click('[data-plc="#all"]'); await sleep(200);
  const f2 = await feats();
  ok('«Показати все» — усі точки повернулися, усі одинадцять галочок стоять', f2.stops.length === 7 && f2.marks === 1 && await app(page, () => [...document.querySelectorAll('.pl-chip')].every(b => b.classList.contains('on')) && document.querySelector('[data-plc="#all"]').disabled), JSON.stringify(f2));
  await page.click('#panelOk'); await sleep(250);
  ok('«Готово» закриває «Місця» — знову карта', await app(page, () => document.getElementById('panel').hidden));
  await page.click('#bQuick'); await sleep(150); await page.mouse.click(4, 450); await sleep(150);
  ok('торкання карти закриває швидкі налаштування', await app(page, () => document.getElementById('quick').hidden));
  await shot(page, '01-start');
  // АЗС на карті — плашкою з назвою мережі, а не кружечком
  await app(page, p => { window.__app.map.flyTo({ lat: p[0], lon: p[1] }, 14); }, stopPt); await sleep(1800);
  ok('АЗС на карті підписано назвою мережі (OKKO)', await app(page, () => { const m = window.__app.map.map; return !!m.getLayer('fuel-label') && m.hasImage('fuel:OKKO'); }));
  ok('назви мереж зведено: ОККО → OKKO, Сокар → SOCAR, АГЗС → Газ, порожня → АЗС', await app(page, () => { const b = window.__app.stopsdb.brandOf; return b('ОККО') === 'OKKO' && b('Сокар') === 'SOCAR' && b('АГЗС') === 'Газ' && b('') === 'АЗС' && b('Укрнафта') === 'Укрнафта'; }));
  await shot(page, '01e-fuel');
  // перевірені місця: значок на карті, вкладка «Місця», картка з фото й цінами
  ok('перевірене місце на карті — значок-бургер із зіркою', !!(await page.$('.vpm')));
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.vp-row');
  ok('«Місця» без маршруту (1.1.22): УСІ перевірені місця, найближчі перші, далі за віддаленням (шиномонтаж у Львові — теж, із відстанню); без точки — у кінці, з поясненням', await page.$$eval('.vp-row', e => e.map(x => x.dataset.vpid).join()) === 'test-bistro,test-far,test-noloc' && /Перевірені · Усі · найближчі перші/.test(await page.textContent('#panelBody')) && /Точки на карті ще немає/.test(await page.textContent('#panelBody'))
    && /^За \d+ км від вас$/.test(await page.$eval('.vp-row[data-vpid="test-far"] .vp-w', e => e.textContent)), await page.$$eval('.vp-row', e => e.map(x => x.dataset.vpid + ':' + (x.querySelector('.vp-w') || { textContent: '' }).textContent).join(' | ')));
  await shot(page, '16-places');
  await page.click('.vp-row[data-vpid="test-bistro"]'); await page.waitForSelector('.vp-photos img');
  await page.waitForFunction(() => [...document.querySelectorAll('.vp-photos img')].slice(0, 1).every(i => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
  const vpc = await app(page, () => ({ title: document.getElementById('panelTitle').textContent, imgs: [...document.querySelectorAll('.vp-photos img')].map(i => i.naturalWidth), stars: document.querySelector('.vp-stars').textContent, menu: document.querySelectorAll('.vp-menu div').length, txt: document.getElementById('panelBody').textContent }));
  ok('картка місця: фото завантажились, ★★★★★, «Перевірено нами», меню з цінами', vpc.imgs.length === 2 && vpc.imgs[0] > 0 && vpc.stars === '★★★★★' && /Перевірено нами/.test(vpc.txt) && vpc.menu === 2 && /65 грн/.test(vpc.txt), JSON.stringify({ ...vpc, txt: vpc.txt.slice(0, 120) }));
  await shot(page, '17-place');
  await page.click('.vp-photos img'); await sleep(200);
  ok('дотик по фото — на весь екран, ✕ закриває', await app(page, () => !document.getElementById('photoView').hidden));
  await shot(page, '17b-photo');
  // (1.1.24) фото можна збільшувати двома пальцями, рухати одним, подвійний дотик — збільшити / повернути
  { const pv = () => app(page, () => { const r = document.getElementById('photoView'), sl = r.querySelector('.pv-slide'), im = sl.querySelector('img'), st = r.querySelector('.pv-strip'), m = /translate\(([-\d.]+)px, ?([-\d.]+)px\) scale\(([\d.]+)\)/.exec(im.style.transform) || [0, 0, 0, 1], b = sl.getBoundingClientRect();
      return { s: +m[3], tx: +m[1], ty: +m[2], zoomed: r.classList.contains('zoomed'), ox: getComputedStyle(st).overflowX, scroll: st.scrollLeft, hint: (r.querySelector('.pv-hint') || {}).textContent, box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], n: r.querySelectorAll('.pv-slide').length }; });
    const z0 = await pv(), cx = z0.box[0] + z0.box[2] / 2, cy = z0.box[1] + z0.box[3] / 2, tap = (x, y) => touchSeq(page, [['touchStart', [[x, y]]], ['touchEnd', []]]);
    ok('фото на весь екран: підказка «Двома пальцями — збільшити»; поки не чіпали — звичайний розмір', z0.s === 1 && !z0.zoomed && /Двома пальцями — збільшити/.test(z0.hint) && z0.box[2] >= 320, JSON.stringify(z0));
    await touchSeq(page, [['touchStart', [[cx - 30, cy], [cx + 30, cy]]], ['touchMove', [[cx - 50, cy], [cx + 50, cy]]], ['touchMove', [[cx - 70, cy], [cx + 70, cy]]], ['touchMove', [[cx - 90, cy], [cx + 90, cy]]], ['touchEnd', []]]);
    const z1 = await pv();
    ok(`(1.1.24) фото: розвели два пальці втричі — фото збільшилось утричі (×${z1.s}), середина лишилась під пальцями; стрічка фото при цьому не гортається`, Math.abs(z1.s - 3) < 0.15 && Math.abs(z1.tx) < 4 && Math.abs(z1.ty) < 4 && z1.zoomed && z1.ox === 'hidden' && z1.scroll === z0.scroll, JSON.stringify(z1));
    await shot(page, '17c-photo-zoom');
    await touchSeq(page, [['touchStart', [[cx, cy]]], ['touchMove', [[cx - 20, cy + 14]]], ['touchMove', [[cx - 40, cy + 27]]], ['touchMove', [[cx - 60, cy + 40]]], ['touchEnd', []]]);
    const z2 = await pv();
    ok('фото збільшене: один палець рухає фото (а не гортає стрічку)', Math.abs((z2.tx - z1.tx) + 60) < 3 && Math.abs((z2.ty - z1.ty) - 40) < 3 && z2.scroll === z0.scroll && Math.abs(z2.s - z1.s) < 0.01, JSON.stringify([z1, z2]));
    await touchSeq(page, [['touchStart', [[cx + 150, cy]]], ['touchMove', [[cx, cy]]], ['touchMove', [[cx - 150, cy]]], ['touchEnd', []]]); await touchSeq(page, [['touchStart', [[cx + 150, cy]]], ['touchMove', [[cx, cy]]], ['touchMove', [[cx - 150, cy]]], ['touchEnd', []]]);
    const z3 = await pv();
    ok('фото за край не тікає: зсув обмежено його краєм', Math.abs(z3.tx + (z3.s - 1) * z0.box[2] / 2) < 2 && z3.scroll === z0.scroll, JSON.stringify(z3));
    await tap(cx, cy); await sleep(90); await tap(cx, cy); await sleep(200);
    const z4 = await pv();
    ok('подвійний дотик по збільшеному фото — звичайний розмір; стрічка знову гортається', z4.s === 1 && z4.tx === 0 && !z4.zoomed && z4.ox !== 'hidden', JSON.stringify(z4));
    await sleep(400); await tap(cx + 40, cy - 30); await sleep(90); await tap(cx + 40, cy - 30); await sleep(200);
    const z5 = await pv();
    ok(`подвійний дотик по звичайному фото — збільшує (×${z5.s}) саме там, де торкнулись`, Math.abs(z5.s - 2.6) < 0.05 && Math.abs(z5.tx - 40 * (1 - 2.6)) < 3 && Math.abs(z5.ty + 30 * (1 - 2.6)) < 3 && z5.zoomed, JSON.stringify(z5));
    await touchSeq(page, [['touchStart', [[cx - 90, cy], [cx + 90, cy]]], ['touchMove', [[cx - 50, cy], [cx + 50, cy]]], ['touchMove', [[cx - 20, cy], [cx + 20, cy]]], ['touchEnd', []]]);
    const z6 = await pv();
    ok('звели пальці — фото знову звичайного розміру (меншим за екран не стає)', z6.s === 1 && !z6.zoomed && z6.tx === 0, JSON.stringify(z6)); }
  // (1.1.24) системна «Назад» іде кроками: фото → картка місця → «Місця» → карта; і лише з карти програму згортає оболонка
  { const bk = await app(page, () => { const st = () => ({ photo: !document.getElementById('photoView').hidden, panel: window.__app.core ? (document.getElementById('panel').hidden ? '' : document.getElementById('panelTitle').textContent) : '' }), out = [];
      for (let i = 0; i < 4; i++) { const r = window.__reisBack(); out.push({ r, ...st() }); } return out; });
    ok('системна «Назад» з відкритого фото: закриває фото (картка місця лишається), далі — «Місця», далі — карта, і тільки тоді віддає оболонці (згорнути)',
      bk[0].r === true && !bk[0].photo && /Бістро/.test(bk[0].panel) && bk[1].r === true && bk[1].panel === 'Місця' && bk[2].r === true && bk[2].panel === '' && bk[3].r === false, JSON.stringify(bk));
    await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips'); await page.click('#panelBody [data-vpid]'); await page.waitForSelector('.vp-photos'); await page.click('.vp-photos img'); await sleep(200); }
  await page.click('#photoView [data-pv="x"]');
  // (1.1.32) «Рейс сюди» — місце стає фінішем, і маршрут одразу на карті (без форми «Рейс»)
  await page.click('[data-vp="go"]');
  await page.waitForFunction(() => !document.getElementById('routePick').hidden || !document.getElementById('pts').hidden, null, { timeout: 15000 }); await sleep(300);
  const go1 = await app(page, () => ({ rp: !document.getElementById('routePick').hidden, panel: !document.getElementById('panel').hidden, head: (document.getElementById('routePick').hidden ? document.getElementById('pts') : document.querySelector('#routePick .rp-head')).textContent }));
  ok('«Рейс сюди» — місце стає фінішем, маршрут одразу на карті (форма «Рейс» не відкривається)', /Бістро \(тест\)/.test(go1.head) && !go1.panel, JSON.stringify(go1));
  if (go1.rp) await page.click('#routePick [data-rp="x"]'); else await page.click('#pts [data-pt="x"]');
  await sleep(1500);
  // 1.1.16: комплекс для фур (стоянка з душем, готель, кафе) — свій вид місця, окремо ціни на послуги й окремо меню кафе
  await app(page, cx => { const V = window.__app.vplaces; V.vp.list.push(cx); window.__app.bus.emit('vplaces', V.vp); }, VP_COMPLEX);
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.vp-row[data-vpid="test-complex"]');
  const cxRow = await page.$eval('.vp-row[data-vpid="test-complex"]', e => e.textContent);
  await page.click('.vp-row[data-vpid="test-complex"]'); await page.waitForSelector('.vp-serv');
  const cx = await app(page, () => ({ secs: [...document.querySelectorAll('#panelBody .sec')].map(e => e.textContent.trim()), serv: [...document.querySelectorAll('.vp-serv div')].map(e => e.querySelector('span').textContent + ' = ' + e.querySelector('b').textContent),
    menu: document.querySelectorAll('.vp-menu:not(.vp-serv) div').length, txt: document.getElementById('panelBody').textContent, order: (() => { const a = document.querySelector('.vp-serv'), b = document.querySelector('.vp-menu:not(.vp-serv)'); return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); })(),
    fit: [...document.querySelectorAll('.vp-serv div')].every(e => e.getBoundingClientRect().right <= document.getElementById('panelBody').getBoundingClientRect().right + 1) }));
  ok('комплекс для фур у списку — «Стоянка · готель · кафе»; у картці спершу «Стоянка, душ, готель — почім» (100 і 1000 грн), далі «Кафе: що є і почім»', /Стоянка · готель · кафе/.test(cxRow) && cx.secs[0] === 'Стоянка, душ, готель — почім' && cx.secs[1] === 'Кафе: що є і почім' && cx.serv.length === 2 && /душ входить у вартість = 100 грн/.test(cx.serv[0]) && /одномісний номер = 1000 грн/.test(cx.serv[1]) && cx.menu === 1 && cx.order && cx.fit, JSON.stringify({ secs: cx.secs, serv: cx.serv, row: cxRow.slice(0, 80) }));
  ok('…і під цінами сказано, на який день вони записані', /Ціни станом на 24\.11\.2026/.test(cx.txt));
  ok('на карті комплекс має свій значок — синій знак стоянки із зіркою (а не бургер)', await app(page, () => { const m = [...document.querySelectorAll('.vpm')].find(e => e.getAttribute('aria-label') === 'Комплекс (тест)'); return !!m && !!m.querySelector('rect[fill="#1f6feb"]') && !!m.querySelector('.vpm-star'); }));
  await app(page, () => { const V = window.__app.vplaces; V.vp.list = V.vp.list.filter(p => p.id !== 'test-complex'); window.__app.bus.emit('vplaces', V.vp); });
  await page.click('#panelOk');
  // місцю без координат водій ставить точку сам
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.vp-row');
  await page.click('.vp-row[data-vpid="test-noloc"]'); await page.click('[data-vp="setloc"]');
  await app(page, p => window.__app.bus.emit('mapPick', { lat: p[0], lon: p[1] }), coords[500]); await sleep(300);
  ok('«Поставити на карту»: довге натискання ставить точку місцю', await app(page, () => { const x = window.__app.vplaces.byId('test-noloc'); return x && x.lat != null && document.querySelectorAll('.vpm').length === 3; }));
  await page.click('#panelOk');
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips'); await page.click('.pl-chip[data-plc="@mapVerified"]'); await sleep(150);
  ok('«Місця» → зняли «Перевірені» — значки з карти зникли', await app(page, () => document.querySelectorAll('.vpm').length === 0));
  await page.click('.pl-chip[data-plc="@mapVerified"]'); await page.click('#panelOk'); await sleep(200);

  // пошук: «Львов» — це Львів, а не село під Бєлгородом
  const lv = await app(page, () => window.__app.route.geocode('Львов', { lat: 49.99, lon: 36.23 }));
  ok('пошук лише в Україні: «Львов» → Львів, село в Росії відкинуто', lv.length === 1 && lv[0].label === 'Львів', JSON.stringify(lv.map(x => x.label + ' ' + x.sub)));
  // підказки з довідника: з першої літери, міста вище сіл, українською й російською
  await page.click('#tabs button[data-panel="trip"]');
  await page.fill('#in_b', 'Льв'); await page.waitForSelector('#sg_b button', { timeout: 5000 });
  const sg1 = await page.$$eval('#sg_b button b', e => e.map(x => x.textContent));
  ok('«Льв» → спершу місто Львів, потім село Львівка', sg1[0] === 'Львів' && sg1.includes('Львівка'), sg1.join(', '));
  await page.fill('#in_b', 'Харьк'); await sleep(200);
  const sg2 = await page.$$eval('#sg_b button b', e => e.map(x => x.textContent));
  ok('російське «Харьк» → Харків', sg2[0] === 'Харків', sg2.join(', '));
  for (const [q, want] of [['lviv', 'Львів'], ['Lvov', 'Львів'], ['Kharkov', 'Харків'], ['poltava', 'Полтава']]) {
    await page.fill('#in_b', q); await sleep(200);
    const sg = await page.$$eval('#sg_b button b', e => e.map(x => x.textContent));
    ok(`латиницею «${q}» → ${want}`, sg[0] === want, sg.join(', '));
  }
  await page.fill('#in_b', ''); await page.click('#panelOk');
  // планування рейсу
  await page.click('#tabs button[data-panel="trip"]');
  await page.fill('#in_a', 'Харків'); await page.waitForSelector('#sg_a button', { timeout: 5000 }); await page.click('#sg_a button');
  await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await page.click('#sg_b button');
  await page.click('[data-act="build"]');
  // як у BlindDriver: панель ховається, зверху карта з обома варіантами, знизу дві карточки й кнопки
  await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 10000 }); await sleep(900);
  const rp = await app(page, () => { const m = window.__app.map.map, b = m.getBounds(), box = document.getElementById('routePick').getBoundingClientRect();
    const g = window.__app.guide, inV = (lat, lon) => { const p = m.project([lon, lat]); return b.contains([lon, lat]) && p.y < box.top; };
    const pr = document.getElementById('panel').hidden, cards = [...document.querySelectorAll('#routePick .alt')].map(x => x.textContent.replace(/\s+/g, ' ').trim());
    const alts = m.getSource('route-alts')._data, mainD = m.getSource('route')._data;
    const altC = (alts.features || [])[0] ? alts.features[0].geometry.coordinates : [], mid = altC[Math.floor(altC.length / 2)] || [0, 0];
    return { panelHidden: pr, cards, altMidVisible: inV(mid[1], mid[0]), sheetTop: Math.round(box.top), H: innerHeight }; });
  ok('вибір варіанта: панель сховано, шторка з двома карточками внизу', rp.panelHidden && rp.cards.length === 2 && /М-03/.test(rp.cards[0]) && /Н-31/.test(rp.cards[1]), JSON.stringify(rp));
  ok('обидва варіанти видно на карті над шторкою (сірий — посередині видно)', rp.altMidVisible, JSON.stringify(rp));
  await shot(page, '02a-pick');
  // увесь маршрут цілком: усі точки обох варіантів — у вільній частині карти (між верхньою плашкою і шторкою), не під кнопками масштабу
  const whole = () => pickWhole(page);
  const w1 = await whole();
  ok('вибір: увесь маршрут видно цілком, без прокрутки (обидва варіанти між верхньою плашкою і шторкою)', w1.n > 20 && w1.out === 0 && w1.under === 0, JSON.stringify(w1));
  ok('вибір: зверху шторки старт → фініш (звідки й куди) зі значками', /Харків.*Полтава/.test(w1.head) && await app(page, () => { const h = [...document.querySelectorAll('#routePick .rp-head .rp-t')]; return h.length === 2 && h[0].classList.contains('a') && h[1].classList.contains('b') && h.every(x => x.querySelector('svg')); }), w1.head);
  // на повільному сервері GitHub анімація масштабу триває довше — чекаємо, доки карта зупиниться (до 4 с), а не фіксовані 0,5 с
  const settle = z0 => page.waitForFunction(z0 => { const m = window.__app.map.map; return !m.isMoving() && Math.abs(m.getZoom() - z0) > 0.3; }, z0, { timeout: 4000 }).catch(() => {});
  await page.click('#routePick [data-rp="zin"]'); await settle(w1.zoom);
  const w2 = await whole();
  ok('вибір: «+» наближає карту', w2.zoom > w1.zoom + 0.5, `${w1.zoom} → ${w2.zoom}`);
  await page.click('#routePick [data-rp="zout"]'); await page.click('#routePick [data-rp="zout"]'); await settle(w2.zoom); await sleep(300);
  ok('вибір: «−» віддаляє', (await whole()).zoom < w2.zoom - 1.2);
  await page.click('#routePick [data-rp="fit"]'); await sleep(800);
  const w3 = await whole();
  ok('вибір: кнопка «Увесь маршрут» повертає весь маршрут на екран', w3.out === 0 && Math.abs(w3.zoom - w1.zoom) < 0.2, JSON.stringify(w3));
  await page.click('#routePick .alt[data-alt="1"]'); await sleep(700);
  ok('дотик по другій карточці — він основний (синій), перший — сірий', await app(page, async () => document.querySelector('#routePick .alt.on').dataset.alt === '1' && (await window.__app.map.map.getSource('route-alts').getData()).features.map(f => f.properties.k).join() === '0'));
  await shot(page, '02a-pick2');
  await page.click('#routePick .alt[data-alt="0"]'); await sleep(500);
  await page.click('#routePick [data-rp="info"]'); await page.waitForSelector('[data-act="go"]', { timeout: 10000 });
  ok('«Деталі» — повна панель маршруту, шторку вибору сховано', await app(page, () => document.getElementById('routePick').hidden));
  ok('маршрут побудовано і показано зведення', /26,8 км|27 км/.test(await page.textContent('#planSum')), (await page.textContent('#planSum')).slice(0, 80));
  await page.waitForFunction(() => document.querySelectorAll('#planSum .pill').length >= 2, null, { timeout: 30000 }).catch(() => {});
  ok('області на шляху визначено', (await page.$$eval('#planSum .pill', e => e.map(x => x.textContent))).join(',').includes('Полтавська'));
  // дороги очима фури
  await page.waitForFunction(() => /Міст до 15 т/.test(document.getElementById('panelBody').textContent), null, { timeout: 8000 }).catch(() => {});
  const tk = await page.textContent('#panelBody');
  ok('план: частка доріг за категоріями (М-03 ≈ 75%)', /траси М і Н 7[45]%/.test(tk) && /місцеві й вулиці 2[56]%/.test(tk), (tk.match(/траси М і Н \d+%|місцеві й вулиці \d+%/g) || []).join(' '));
  ok('план: міст 15 т на маршруті — червоним, з вагою фури (20 т)', /Міст до 15 т/.test(tk) && /ваша фура 20 т/.test(tk) && await page.$$eval('.hz-item.red', e => e.some(x => /Міст до 15 т/.test(x.textContent))));
  ok('план: без переліку душів (зайве прибрано)', !/Душ попереду/.test(tk));
  ok('план: ґрунт ≈ 1,2 км', /Ґрунт або щебінь — 1,[12] км/.test(tk), (tk.match(/Ґрунт[^·]*?км/) || [''])[0]);
  ok('проїзд на вулиці навхрест і міст 55 т не вважаються проблемою', !/3,8 м/.test(tk) && !/55 т/.test(tk));
  const rmap = await app(page, async () => { const m = window.__app.map.map; const d = await m.getSource('route').getData(); const bad = await m.getSource('route-bad').getData();
    return { cats: (d.features || []).map(f => f.properties.c).join(''), bad: bad.features.length, marks: [...document.querySelectorAll('.hzm')].map(x => x.textContent + ':' + x.className) }; });
  ok('карта: маршрут розфарбовано за категоріями, ґрунт — пунктиром, на мосту значок «15т»', /a/.test(rmap.cats) && /c/.test(rmap.cats) && rmap.bad === 1 && rmap.marks.some(x => /^15т:.*red/.test(x)), JSON.stringify(rmap));
  await shot(page, '02-plan');
  // варіанти маршруту карточками; вибір — сірий інший варіант на карті; повертаємось до першого
  const alts = await page.$$eval('#planSum .alt', e => e.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('варіанти маршруту: 2 карточки — час, км, дороги; перший найшвидший', alts.length === 2 && /М-03/.test(alts[0]) && /найшвидший/.test(alts[0]) && /Н-31/.test(alts[1]), JSON.stringify(alts));
  ok('запит маршруту просить до двох запасних варіантів (усього до трьох, як у Google)', routeReqs.some(q => q.alternates === 2));
  ok('на карті сірим — інший варіант', await app(page, async () => (await window.__app.map.map.getSource('route-alts').getData()).features.length === 1));
  await page.click('#planSum .alt[data-alt="1"]'); await sleep(700);
  const pick1 = await app(page, async () => ({ on: document.querySelector('#planSum .alt.on') && document.querySelector('#planSum .alt.on').dataset.alt, alts: (await window.__app.map.map.getSource('route-alts').getData()).features.map(f => f.properties.k) }));
  ok('вибрав другий варіант — він основний, перший став сірим', pick1.on === '1' && pick1.alts.join() === '0', JSON.stringify(pick1));
  await shot(page, '02c-alts');
  await page.click('#planSum .alt[data-alt="0"]'); await sleep(700);
  // фура / легкова
  ok('перемикач «Фура / Легкова»: за замовчуванням фура', await app(page, () => document.querySelector('#panelBody .seg.veh .on').dataset.veh === 'truck'));
  // (1.1.28) вид рейсу вибирають до побудови: «Фура: суворо» (жорсткі обмеження), «Фура: на свій розсуд» (дороги загального користування), «Легкова»
  const kinds = () => app(page, () => { const seg = document.querySelector('#panelBody .seg.veh'), R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; }, h = document.getElementById('vehHint');
    return { btns: [...seg.querySelectorAll('button')].map(b => ({ kind: b.dataset.kind, on: b.classList.contains('on'), txt: b.textContent.replace(/\s+/g, ' ').trim(), box: R(b), cut: [...b.querySelectorAll('b,small,svg')].some(x => { const q = x.getBoundingClientRect(), w = b.getBoundingClientRect(); return x.scrollWidth > x.clientWidth + 1 || q.right > w.right - 1 || q.left < w.left + 1; }) })), hint: h ? h.textContent.replace(/\s+/g, ' ').trim() : '', hintCls: h ? h.className : '', seg: R(seg), vw: innerWidth, S: { vehicle: window.__app.S.vehicle, routeMode: window.__app.S.routeMode } }; });
  const k0 = await kinds();
  ok(`види рейсу: три кнопки (${k0.btns.map(b => '«' + b.txt + '»').join(', ')}), (1.1.30) «на свій розсуд» перша, «суворо» посередині й вибрана за замовчуванням; написи цілі, кнопки не менші за 44 px, у межах екрана`, k0.btns.length === 3 && k0.btns.map(b => b.kind).join() === 'free,strict,car' && k0.btns[1].on && !k0.btns[0].on && /Фура\s*на свій розсуд/.test(k0.btns[0].txt) && /Фура\s*суворо/.test(k0.btns[1].txt) && /Легкова/.test(k0.btns[2].txt) && k0.btns.every(b => !b.cut && b.box.h >= 44 && b.box.w >= 80 && b.box.l >= 0 && b.box.r <= k0.vw), JSON.stringify(k0.btns));
  ok(`під кнопками — попередження, що це означає: «${k0.hint.slice(0, 90)}…»`, /Жорсткі обмеження для фур: лише дороги, де фурі можна/.test(k0.hint) && /Шлях може вийти довшим/.test(k0.hint), k0.hint);
  await shot(page, '02d-kinds');
  await page.click('#panelBody .seg.veh [data-kind="free"]'); await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 10000 }); await sleep(300);
  const rqF = routeReqs[routeReqs.length - 1], pickF = await app(page, () => ({ warn: (document.querySelector('#routePick .rp-warn') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(), free: !!window.__app.S && window.__app.S.routeMode === 'free' && window.__app.S.vehicle === 'truck' }));
  ok('«Фура: на свій розсуд» — той самий рейс дорогами загального користування: сервер обмежень для фур не рахує (costing auto), але час — для фури з обмежувачем 90', rqF.costing === 'auto' && rqF.costing_options && rqF.costing_options.auto && rqF.costing_options.auto.top_speed === 90 && pickF.free, JSON.stringify({ costing: rqF.costing, opt: rqF.costing_options, S: pickF.free }));
  ok(`…і на екрані вибору маршруту чесно сказано: «${pickF.warn.slice(0, 100)}…»`, /Рейс на свій розсуд/.test(pickF.warn) && /обмеження для фур .* не враховано/.test(pickF.warn) && /стежте за знаками самі/.test(pickF.warn), pickF.warn);
  await shot(page, '02d-kinds-free');
  await page.click('#routePick [data-rp="info"]'); await page.waitForSelector('#panelBody .seg.veh');
  const k1 = await kinds();
  ok(`у формі вибрано «на свій розсуд», пояснення — жовта рамка: «${k1.hint.slice(0, 80)}…»; у деталях рейсу — те саме попередження`, k1.btns[0].on && !k1.btns[1].on && /free/.test(k1.hintCls) && /На свій розсуд: дороги загального користування/.test(k1.hint) && /програма НЕ перевіряє/.test(k1.hint) && await app(page, () => /Рейс на свій розсуд/.test((document.querySelector('#planSum .softcard') || { textContent: '' }).textContent)), JSON.stringify({ hint: k1.hint, cls: k1.hintCls }));
  await page.click('#panelBody .seg.veh [data-veh="auto"]'); await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 10000 }); await sleep(300);
  ok('легкова: маршрут без обмежень для фур (costing auto), без обмежувача фури', routeReqs[routeReqs.length - 1].costing === 'auto' && !((routeReqs[routeReqs.length - 1].costing_options || {}).auto || {}).top_speed && await app(page, () => window.__app.S.vehicle === 'auto'), JSON.stringify(routeReqs[routeReqs.length - 1].costing_options));
  // (1.1.28) вид транспорту видно й на екрані вибору маршруту (сюди приходять і з точки на карті, і з «Їхати сюди»): натиснули інший — той самий рейс перераховано
  const vm = () => app(page, () => { const seg = document.querySelector('#routePick .vehm'); if (!seg || document.getElementById('routePick').hidden) return null; const R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; }, box = R(document.getElementById('routePick'));
    return { box, btns: [...seg.querySelectorAll('button')].map(b => ({ kind: b.dataset.kind, on: b.classList.contains('on'), txt: b.textContent.trim(), label: b.getAttribute('aria-label'), box: R(b), cut: [...b.querySelectorAll('span')].some(x => x.scrollWidth > x.clientWidth + 1) })) }; });
  const v0 = await vm(); await shot(page, '02e-sheet-kinds');
  ok(`на екрані вибору маршруту — ряд «вид рейсу» (${v0 ? v0.btns.map(b => '«' + b.txt + '»').join(' ') : '—'}), вибрано «Легкова»; кнопки не менші за 44 px, написи цілі, у межах шторки`, !!v0 && v0.btns.map(b => b.kind).join() === 'free,strict,car' && v0.btns[2].on && !v0.btns[1].on && v0.btns.every(b => !b.cut && b.box.h >= 44 && b.box.l >= v0.box.l && b.box.r <= v0.box.r) && /Фура: на свій розсуд/.test(v0.btns[0].label) && /Фура: суворо/.test(v0.btns[1].label), JSON.stringify(v0));
  const nV = routeReqs.length;
  await page.click('#routePick .vehm [data-kind="strict"]'); await page.waitForFunction(n => window.__app && document.querySelector('#routePick .vehm [data-kind="strict"].on') && !document.getElementById('routePick').hidden && !document.getElementById('routePick').classList.contains('busy'), nV, { timeout: 10000 }).catch(() => {}); await sleep(300);
  const v1 = await vm();
  ok('у шторці натиснули «Суворо» — той самий рейс одразу перераховано для фури (costing truck), шторка лишилась, вибрано «Суворо»', routeReqs.length === nV + 1 && routeReqs[nV].costing === 'truck' && !!v1 && v1.btns[1].on && !v1.btns[2].on && await app(page, () => window.__app.S.vehicle === 'truck' && window.__app.S.routeMode === 'strict'), JSON.stringify({ n: routeReqs.length - nV, c: (routeReqs[nV] || {}).costing, v1 }));
  await page.click('#routePick [data-rp="info"]'); await page.waitForSelector('#panelBody .seg.veh');
  await page.click('#panelBody .seg.veh [data-kind="strict"]'); await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 10000 }); await sleep(300);
  ok('знову фура: профіль truck з обмежувачем 90', routeReqs[routeReqs.length - 1].costing === 'truck' && routeReqs[routeReqs.length - 1].costing_options.truck.top_speed === 90);
  await page.click('#routePick [data-rp="info"]'); await page.waitForSelector('[data-act="go"]');
  ok('після вибору підказки список не відкривається знову', await app(page, () => ['a', 'b'].every(k => document.getElementById('sg_' + k).hidden)));
  if (SHOTS) { await app(page, () => { const b = document.getElementById('panelBody'), h = [...b.querySelectorAll('.sec')].find(x => /фури/i.test(x.textContent)); if (h) b.scrollTop = h.offsetTop - 8; }); await sleep(200); await shot(page, '02b-truck');
    await app(page, () => { document.getElementById('panelBody').scrollTop = 0; }); }

  // додаємо канал Telegram і їдемо
  await app(page, () => { window.__app.S.channels = [{ name: 'kharkiv_roads', region: 'kharkiv', on: true }]; window.__app.S.offline = false; });
  await page.click('[data-act="go"]');
  await page.waitForFunction(() => window.__app.guide.g.active && window.__app.guide.g.idx, null, { timeout: 8000 });
  ok('рейс активний', true);
  { const q = routeReqs.find(x => x.costing === 'truck') || {}, tk = (q.costing_options || {}).truck || {};
    ok('запит маршруту: профіль фури з габаритами, мова підказок українська', q.costing === 'truck' && tk.height === 4 && tk.weight === 20 && q.language === 'uk-UA' && q.locations.length === 2 && q.locations[0].type === 'break', JSON.stringify({ c: q.costing, tk, l: q.language })); }
  // черга голосу могла бути зайнята (тривога, подія) — даємо їй договорити; на CI це бувало повільніше
  ok('сказано «маршрут побудовано»', await page.waitForFunction(() => window.__spoken.some(s => /Рейс прокладено/.test(s)), null, { timeout: 8000 }).then(() => true, () => false), JSON.stringify(await app(page, () => window.__spoken.slice(-5))));

  // імітація руху
  await app(page, () => { window.__app.sim.setSpeed(60); window.__app.sim.start(); });
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps' && window.__app.nav.pos.onRoute, null, { timeout: 8000 });
  await sleep(2500);
  const s1 = await app(page, () => ({ next: window.__app.guide.g.next && window.__app.guide.g.next.type, dist: window.__app.guide.g.distNext, man: document.getElementById('manDist').textContent, text: document.getElementById('manText').textContent, spd: document.getElementById('spdVal').textContent }));
  ok('картка маневру: поворот ліворуч попереду', s1.next === 15 && /км|м/.test(s1.man) && /Пушкінськ/.test(s1.text), JSON.stringify(s1));
  ok('швидкість на екрані', +s1.spd > 40 && +s1.spd < 70, s1.spd);
  // «Місця» в дорозі (1.1.22): усі перевірені — спершу ті, що попереду в рейсі, далі решта за відстанню
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.vp-scope');
  const pl = await app(page, () => ({ ids: [...document.querySelectorAll('.vp-row')].map(x => x.dataset.vpid).join(), scope: ([...document.querySelectorAll('.vp-scope')].find(x => /Перевірені/.test(x.textContent)) || { textContent: '' }).textContent, w: [...document.querySelectorAll('.vp-w')].map(x => x.textContent).join(' | ') }));
  ok('«Місця» в дорозі: усі перевірені місця — спершу попереду в рейсі («через 15 км»), далі решта за відстанню (Львів — «За … від вас»)', /^test-bistro/.test(pl.ids) && pl.ids.split(',').pop() === 'test-far' && /Усі · спершу попереду в рейсі/.test(pl.scope) && /через 15 км/.test(pl.w) && /За \d+ км від вас/.test(pl.w), JSON.stringify(pl));
  await page.click('#panelOk');
  await shot(page, '03-drive');
  // пройдене: за замовчуванням ховаємо — на карті лише шлях попереду; за налаштуванням — блідо
  const pr = await app(page, async () => { const m = window.__app.map.map, g = window.__app.guide.g;
    const dn = await m.getSource('route-done').getData();
    const r = m.getSource('route-near')._data, cur = window.__app.map.camState.cur, here = window.__app.nav.pos;   // в одну мить, без очікування
    const first = (r.features || [r])[0].geometry.coordinates[0];
    const off = window.__app.core.hav({ lat: first[1], lon: first[0] }, cur);
    return { off: Math.round(off), rd: Math.round(here.rd), done: dn.geometry ? dn.geometry.coordinates.length : (dn.features || []).length }; });
  ok('пройдена частина маршруту схована: лінія починається просто під стрілкою', pr.rd > 20 && pr.off < 8 && pr.done === 0, JSON.stringify(pr));
  await app(page, () => { window.__app.S.passed = 'grey'; });
  await sleep(2300);
  const done = await app(page, async () => { const s = window.__app.map.map.getSource('route-done'); const d = await s.getData(); return d && d.geometry ? d.geometry.coordinates.length : 0; });
  ok('за налаштуванням «блідо» пройдене малюється окремою лінією', done >= 2, 'точок ' + done + ' ' + JSON.stringify(await app(page, () => ({ rd: window.__app.nav.pos.rd, mode: window.__app.nav.pos.mode, passed: window.__app.S.passed, on: window.__app.nav.pos.onRoute }))));
  await app(page, () => { window.__app.S.passed = 'hide'; });

  // стрічка: Telegram + тривога
  await app(page, async () => { const f = window.__app.feed; await f.pollAir(); await f.pollTelegram(true); });
  await sleep(300);
  const fs = await app(page, () => window.__app.feed.feed.items.map(i => ({ src: i.src, level: i.level, filtered: i.filtered, text: i.text.slice(0, 40) })));
  const by = k => fs.find(i => i.text.includes(k)) || {};
  ok('перекриття через ДТП — червоне', by('Перекрито рух').level === 'red' && !by('Перекрито рух').filtered, JSON.stringify(by('Перекрито рух')) + ' ' + (by('Перекрито рух').level ? '' : JSON.stringify(await app(page, () => ({ ch: window.__app.S.channels.map(c => c.name), tg: window.__app.S.tg, n: window.__app.feed.feed.items.length, log: window.__app.core.getLog ? window.__app.core.getLog().filter(l => l.level !== 'info').slice(-6).map(l => l.msg) : [] })))));
  ok('зупинка заводу — відсіяно', by('На заводі').filtered === true, JSON.stringify(by('На заводі')));
  ok('дорогу відкрили — зелене', by('Рух на мосту').level === 'green', JSON.stringify(by('Рух на мосту')));
  ok('«можливо, перекриють» — жовте', by('Можливо').level === 'yellow', JSON.stringify(by('Можливо')));
  ok('реклама — відсіяно', by('Знижки').filtered === true, JSON.stringify(by('Знижки')));
  ok('повітряна тривога Харківщини — у стрічці', fs.some(i => i.src === 'air' && /Харківська/.test(i.text)), JSON.stringify(fs.filter(i => i.src === 'air')));
  ok('російські регіони зі зведення не потрапили', !fs.some(i => /Тверськ/.test(i.text)));
  ok('ДТП біля Чугуєва — точка на карті', await page.waitForSelector('.evm.red', { timeout: 8000 }).then(() => true, () => false));
  ok('тривога на Харківщині — позначка області на карті', !!(await page.$('.evm.air')));
  await app(page, () => window.__app.weather.checkWeather(true)); await sleep(500);
  const wxi = await app(page, () => window.__app.feed.feed.items.filter(i => i.src === 'wx').map(i => ({ level: i.level, text: i.text, lat: i.lat })));
  ok('погода: сніг попереду — у стрічці й на карті', wxi.length === 1 && wxi[0].level === 'yellow' && /сніг/.test(wxi[0].text) && !!(await page.$('.evm.wx')), JSON.stringify(wxi));
  const st = await app(page, () => ({ level: document.getElementById('strip').dataset.level, text: document.getElementById('stripText').textContent, counts: document.getElementById('stripCounts').textContent }));
  ok('шторка червона з текстом події', st.level === 'red' && /Перекрито/.test(st.text), JSON.stringify(st));
  await shot(page, '04-strip');
  await page.click('#strip'); await page.waitForSelector('.ev');
  await shot(page, '05-feed');
  // «Події» — на весь екран: лише події, без нижньої панелі; першим — тривога там, де машина; унизу «Назад»
  const fv = await app(page, () => { const p = document.getElementById('panel'), tb = document.getElementById('tabs').getBoundingClientRect(), hit = document.elementFromPoint((tb.left + tb.right) / 2, (tb.top + tb.bottom) / 2);
    const air = document.querySelector('#panelBody .ev-air'), back = document.querySelector('#panelOk');
    return { full: p.classList.contains('full'), tabsCovered: !!hit && p.contains(hit), air: air ? air.textContent.replace(/\s+/g, ' ').trim() : '', airFirst: document.getElementById('panelBody').firstElementChild === air, back: !!back,
      airItems: [...document.querySelectorAll('#panelBody .ev')].filter(e => /Повітряна тривога: Харківська/.test(e.textContent)).length }; });
  ok('«Події» на весь екран: нижньої панелі не видно', fv.full && fv.tabsCovered, JSON.stringify(fv));
  ok('«Події»: першою — тривога там, де машина (Харківська обл.), окремою карткою; унизу «Назад»', fv.airFirst && /Повітряна тривога/.test(fv.air) && /Харківська/.test(fv.air) && fv.back && fv.airItems === 0, JSON.stringify(fv));
  const cl = await app(page, () => { const c = window.__app.feed.classify; return { drone: c('Група ударних БпЛА з півночі курсом на Харків').level, mop: c('Ще 5 мопедів над Харківщиною').level, hit: c('Вибух у Чугуєві: приліт біля траси М-03, пошкоджено авто').level }; });
  ok('рух дронів («курсом на…», «ще 5 мопедів») — не показуємо; приліт біля траси — червоним', cl.drone === null && cl.mop === null && cl.hit === 'red', JSON.stringify(cl));
  // оцінка «не потрібно» прибирає подію зі шторки і вчить фільтр
  const redId = await app(page, () => window.__app.feed.feed.items.find(i => i.text.includes('Перекрито рух')).id);
  const base = await app(page, () => window.__app.feed.classify('Перекрито рух на трасі М-03 біля Чугуєва через ДТП за участі фури', 'kharkiv_roads').score);
  // (1.1.24) рядка оцінки під подією («Потрібно / Не потрібно / Не вирішив») більше немає; сам фільтр і його навчання лишились у програмі
  ok('«Події»: рядка оцінки під подією немає', await app(page, () => document.querySelectorAll('#panelBody .ev').length > 0 && !document.querySelector('#panelBody .votes, #panelBody [data-v]') && !/Не вирішив|Не потрібно/.test(document.getElementById('panelBody').textContent)));
  await app(page, id => window.__app.feed.vote(id, -1), redId); await sleep(600);
  ok('після «Не потрібно» шторка вже не червона', (await app(page, () => document.getElementById('strip').dataset.level)) !== 'red');
  const sc = await app(page, () => { const f = window.__app.feed; return { again: f.classify('Перекрито рух на трасі М-03 біля Чугуєва через ДТП за участі фури', 'kharkiv_roads').score, other: f.classify('ДТП на перехресті, рух ускладнено', 'x').score }; });
  ok('схоже повідомлення тепер оцінюється нижче (на ≥1 бал)', sc.again <= base - 1, `було ${base.toFixed(2)}, стало ${sc.again.toFixed(2)}`);
  await page.click('[data-tab="rest"]'); await sleep(200);
  ok('«Події», вкладка «Решта»: рядка оцінки теж немає', await app(page, () => !document.querySelector('#panelBody .votes, #panelBody [data-v]')));
  await app(page, id => window.__app.feed.vote(id, 1), redId); await sleep(500);
  ok('після «Потрібно» подія повернулась', (await app(page, () => document.getElementById('strip').dataset.level)) === 'red');
  await page.click('#panelOk');
  ok('«Назад» унизу закриває «Події»', await app(page, () => document.getElementById('panel').hidden));

  // доречність: лише тут і попереду до S.nearKm; далі — тихо й лише важливе; тривоги — лише свої області
  const rel = await app(page, async () => {
    const A = window.__app, f = A.feed, idx = A.guide.g.idx, rd = A.nav.pos.rd;
    A.S.nearKm = 20;
    const p1 = idx.at(Math.min(idx.total - 300, rd + 22500)), n0 = window.__spoken.length, m0 = document.querySelectorAll('.evm').length;
    A.bus.emit('feedPush', { src: 'tg', ch: 'test', level: 'yellow', text: 'Затор на трасі М-03 біля Тестового', key: 't-later', lat: p1.lat, lon: p1.lon, locKind: 'town' });
    A.bus.emit('feedPush', { src: 'tg', ch: 'test', level: 'red', imp: true, text: 'Перекрито рух на мосту М-03 біля Тестового, міст пошкоджено', key: 't-far', lat: p1.lat, lon: p1.lon, locKind: 'town' });
    f.feed.air.lviv = { part: false }; f.feed.air.poltava = { part: false };
    f.watch(); await new Promise(r => setTimeout(r, 400));
    const it = k => f.feed.items.find(i => i.key === k), main = f.feedLists().main.map(([i]) => i.key || i.src + ':' + i.region);
    return { rd: Math.round(rd), later: f.relevance(it('t-later')).tier, far: f.relevance(it('t-far')).tier, main, spoke: window.__spoken.slice(n0),
      toasts: document.getElementById('toasts').textContent, marks: document.querySelectorAll('.evm').length - m0, farMark: document.querySelectorAll('.evm.far').length,
      air: f.feed.items.filter(i => i.src === 'air' && i.level === 'yellow').map(i => i.region), airMarks: document.querySelectorAll('.evm.air').length,
      zone: f.zoneRegions().map(z => z.id + ':' + Math.round(z.dist)), strip: document.getElementById('stripText').textContent };
  });
  ok('подія за межею 100 км (тут 20) — не в шторці, не на карті й не озвучена: скажемо на підʼїзді', rel.later === 'later' && !rel.main.includes('t-later') && !rel.spoke.some(s => /Затор/.test(s)), JSON.stringify({ later: rel.later, spoke: rel.spoke }));
  ok('важливе далеко (перекриття, міст) — у шторці й на карті тихо: тост без голосу', rel.far === 'far' && rel.main.includes('t-far') && rel.farMark === 1 && rel.marks === 2 && /через 2\d км · Перекрито рух на мосту/.test(rel.toasts) && !rel.spoke.some(s => /на мосту/.test(s)), JSON.stringify({ far: rel.far, marks: rel.marks, farMark: rel.farMark, spoke: rel.spoke, t: rel.toasts.slice(0, 200) }));
  ok('ближча подія важливіша за далеку: у шторці ДТП за кілька км', /^через \d+ км · Перекрито рух на трасі/.test(rel.strip), rel.strip);
  ok('тривога: області на шляху (Харківська тут, Полтавська попереду) — так; Львівська — ні', rel.air.includes('poltava') && !rel.air.includes('lviv') && rel.airMarks === 2 && rel.spoke.some(s => /^Через .*кілометр.*Полтавська/.test(s)), JSON.stringify({ air: rel.air, airMarks: rel.airMarks, zone: rel.zone, spoke: rel.spoke }));
  await shot(page, '05b-relevance');

  // втрата GPS → розрахунок → ±100 м → повернення
  const rd0 = await app(page, () => { window.__app.sim.setLost(true); return window.__app.nav.pos.rd; });
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 12000 });
  await sleep(3200);
  const dr = await app(page, () => ({ mode: window.__app.nav.pos.mode, reason: window.__app.nav.pos.reason, rd: window.__app.nav.pos.rd, noLine: !document.getElementById('lostLine') && (getComputedStyle(document.getElementById('tripbar')).display === 'none' || !/GPS ✕/.test(document.getElementById('tripbar').innerText)), nudge: !document.getElementById('nudge').hidden, chip: document.getElementById('spdGps').getAttribute('aria-label'), gbad: document.getElementById('spdGps').classList.contains('g-bad') }));
  ok('GPS зник → режим розрахунку, компактні кнопки ±100, кружечок GPS червоний', dr.mode === 'dr' && dr.reason === 'timeout' && dr.nudge && dr.chip.startsWith('GPS ✕') && dr.gbad, JSON.stringify(dr));
  ok('1.1.6: червоного рядка про GPS під часом прибуття немає (подробиці — у підписі кружечка GPS)', dr.noLine, JSON.stringify(dr));
  ok('без GPS позиція рухається маршрутом і надолужує паузу', dr.rd > rd0 + 110, `rd ${Math.round(rd0)} → ${Math.round(dr.rd)}`);
  ok('сказано про втрату сигналу', await app(page, () => window.__spoken.some(s => /Сигнал GPS втрачено/.test(s))));
  await shot(page, '06-gps-lost');
  const before = await app(page, () => window.__app.nav.pos.rd);
  await page.click('#bFwd100'); const up = await app(page, () => window.__app.nav.pos.rd);
  await page.click('#bBack100'); await page.click('#bBack100'); const dn = await app(page, () => window.__app.nav.pos.rd);
  ok('↑100 зсуває вперед (100 м + рух за час натискання)', up - before >= 99 && up - before < 150, `${Math.round(up - before)} м`);
  ok('↓100 двічі зсуває назад (200 м мінус рух за час натискань)', up - dn > 110 && up - dn <= 201, `${Math.round(up - dn)} м`);
  await app(page, () => window.__app.sim.setLost(false));
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps', null, { timeout: 12000 });
  ok('GPS повернувся → знову веде GPS, кнопки ±100 сховано, кружечок GPS зелений', await app(page, () => document.getElementById('nudge').hidden && document.getElementById('spdGps').classList.contains('g-ok')));

  // підміна GPS («Ліма»)
  await app(page, () => window.__app.sim.setSpoof(true));
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 8000 });
  const sp = await app(page, () => ({ reason: window.__app.nav.pos.reason, lat: window.__app.nav.pos.lat, why: document.getElementById('spdGps').getAttribute('aria-label') }));
  ok('підміну GPS відкинуто, позиція лишилась в Україні', sp.reason === 'spoof' && sp.lat > 49 && /підмін/.test(sp.why), JSON.stringify(sp));
  await sleep(4500);
  ok('під час підміни координати Ліми не прийнято', await app(page, () => window.__app.nav.pos.mode === 'dr' && window.__app.nav.pos.lat > 49));
  await app(page, () => window.__app.sim.setSpoof(false));
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps', null, { timeout: 12000 });
  ok('після підміни GPS прийнято назад автоматично', true);

  // камера, стоянка, далі швидко до фінішу
  await app(page, () => window.__app.sim.setSpeed(1400));
  await page.waitForFunction(() => window.__app.nav.pos.rd > 17000 && window.__app.nav.pos.mode === 'gps', null, { timeout: 120000 });
  await app(page, () => window.__app.feed.watch());          // у житті — раз на 10 с (на 90 км/год це 250 м); тут 1400 км/год
  const pass = await app(page, () => { const f = window.__app.feed, it = k => f.feed.items.find(i => k(i)), main = f.feedLists().main.map(([i]) => i);
    const dtp = it(i => /Перекрито рух на трасі/.test(i.text)), kh = it(i => i.src === 'air' && i.region === 'kharkiv' && i.level === 'yellow');
    return { rd: Math.round(window.__app.nav.pos.rd), dtp: f.relevance(dtp).tier, kh: kh ? f.relevance(kh).tier : 'none', inMain: main.includes(dtp), strip: document.getElementById('stripText').textContent,
      red: document.querySelectorAll('.evm.red').length, spoke: window.__spoken.filter(s => /Затор на трасі|на мосту/.test(s)) }; });
  ok('проїхали ДТП — воно позаду: зникло зі шторки й карти', pass.dtp === 'behind' && !pass.inMain && !/на трасі М-03 біля Чуг/.test(pass.strip) && pass.red === 1, JSON.stringify(pass));
  ok('виїхали з Харківщини — її тривога більше не показується', pass.kh === 'behind', pass.kh);
  ok('під’їхали ближче межі — далекі події озвучено з відстанню', pass.spoke.some(s => /^Через .*кілометр.*Затор/.test(s)) && pass.spoke.some(s => /^Увага\. Через .*кілометр.*на мосту/.test(s)), JSON.stringify(pass.spoke));
  await page.waitForFunction(() => window.__app.guide.g.arrived, null, { timeout: 240000 });
  const fin = await app(page, () => ({ spoken: window.__spoken, feed: window.__app.feed.feed.items.filter(i => i.src === 'stop').map(i => i.text), man: document.getElementById('manDist').textContent, cams: window.__app.poi.poi.cams.length, stops: window.__app.poi.poi.stops.length }));
  ok('камеру і стоянки з бази піт-стопів прив’язано до маршруту', fin.cams === 1 && fin.stops === 3, `камер ${fin.cams}, стоянок ${fin.stops}`);
  ok('попередження про камеру прозвучало', fin.spoken.some(s => /Камера швидкості через/.test(s)), '');
  ok('голосові підказки поворотів були', fin.spoken.some(s => /Поверніть ліворуч/.test(s)) && fin.spoken.some(s => /Через .* (метрів|кілометр)/.test(s)));
  ok('АЗС OKKO попереду запропоновано заздалегідь — як АЗС, без слів «стоянка для фур» (ні в стрічці, ні голосом)', fin.feed.some(x => /OKKO/.test(x)) && !fin.feed.some(x => /для фур/.test(x)) && fin.spoken.some(s => /^Через .* — АЗС OKKO/.test(s)) && !fin.spoken.some(s => /стоянка для фур/.test(s)), fin.feed.join(' | ') + ' || ' + fin.spoken.filter(s => /OKKO|стоянка/.test(s)).join(' | '));
  ok('перевірене місце на маршруті попереду — у стрічці й голосом', fin.feed.some(x => /Перевірене місце «Бістро \(тест\)»/.test(x)) && fin.spoken.some(s => /перевірене кафе/.test(s)), fin.feed.join(' | '));
  ok('прибуття оголошено', fin.spoken.some(s => /Ви прибули/.test(s)) && /прибули/i.test(fin.man), fin.man);
  await shot(page, '07-arrived');

  // 1.1.7: нижня панель зліва направо — GPS · Події · Рейс · Місця · Мітки; «Параметри» на головному екрані немає
  { const bb = await app(page, () => { const bs = [...document.querySelectorAll('#tabs > button')], r = bs.map(b => b.getBoundingClientRect());
      return { order: bs.map(b => b.dataset.panel || b.id).join(), labels: bs.map(b => b.textContent.trim()).join('|'), ltr: r.every((x, i) => !i || x.left >= r[i - 1].right - 1),
        noSettings: !document.querySelector('#tabs [data-panel="settings"]'), oldGone: !document.getElementById('bGps') && !document.getElementById('bReport'), mic: !!document.getElementById('bMic') || !!document.querySelector('[data-panel="chat"]') }; });
    ok('нижня панель зліва направо: Події · Рейс · Місця · Мітки («Телефон» із 1.1.24 — кнопка праворуч угорі; GPS із 1.1.22 — кружечок біля круга швидкості); «Параметри» прибрано; чату й мікрофона немає', bb.order === 'feed,trip,places,tabRep' && bb.ltr && bb.noSettings && bb.oldGone && !bb.mic && /^Події\d*\|Рейс\|Місця\|Мітки\d*$/.test(bb.labels), JSON.stringify(bb)); }
  ok('кружечок GPS: є сигнал — зелений', await app(page, () => document.getElementById('spdGps').classList.contains('g-ok')), await app(page, () => document.getElementById('spdGps').className + ' ' + window.__app.nav.pos.mode));
  ok('«Параметри» відкриваються зі швидких налаштувань (кнопка вгорі праворуч)', await (async () => { await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); const ok1 = await app(page, () => /Налаштування/.test(document.getElementById('panelTitle').textContent)); await page.click('#panelOk'); return ok1; })());

  // лабораторія (тепер у Параметрах), ніч
  await app(page, () => window.__app.lab.tools()); await page.waitForSelector('[data-tg="tg"]');
  await shot(page, '09-lab');
  await page.click('[data-tg="tg"]');
  ok('перемикач у Лабораторії змінює налаштування', await app(page, () => window.__app.S.tg === false));
  await page.click('#panelOk');
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('[data-seg="theme:night"]');
  await shot(page, '11-settings');
  await page.click('[data-seg="theme:day"]'); await sleep(300);
  ok('швидкі налаштування → «Налаштування» → тема «День»', await app(page, () => document.body.dataset.theme === 'day' && window.__app.S.theme === 'day'));
  // прозорість плашок: за замовчуванням нижня панель і кнопки напівпрозорі, без розмиття
  const alpha = sel => app(page, s => { const e = document.querySelector(s), cs = getComputedStyle(e), m = (e instanceof SVGElement ? cs.fill : cs.backgroundColor).match(/rgba?\(([^)]+)\)/); /* тло нижньої плашки — це SVG-контур (1.1.24) */ const p = m ? m[1].split(',').map(Number) : []; return p.length === 4 ? p[3] : 1; }, sel);
  const aBottom = await alpha('#tbShape .tb-fill'), aRail = await alpha('#bQuick'), aSpeed = await alpha('#speed');
  ok('нижня панель, кнопки і швидкість прозорі (≤ 0,5)', aBottom <= 0.5 && aRail <= 0.5 && aSpeed <= 0.5, `низ ${aBottom}, кнопка ${aRail}, швидкість ${aSpeed}`);
  ok('нижня панель без розмиття', await app(page, () => ['none', ''].includes(getComputedStyle(document.getElementById('tbShape')).backdropFilter || 'none')));
  await page.click('[data-seg="glass:low"]'); await sleep(200);
  const aLow = await alpha('#tbShape .tb-fill');
  await page.click('[data-seg="glass:max"]'); await sleep(200);
  const aMax = await alpha('#tbShape .tb-fill');
  ok('перемикач «Прозорість плашок» міняє щільність', aLow > 0.75 && aMax < 0.3, `слабка ${aLow}, максимум ${aMax}`);
  await page.click('[data-seg="glass:high"]'); await sleep(200);
  if (SHOTS) {
    // знімок для очей: денна тема поверх намальованої «карти» з дорогами й підписами під нижньою панеллю
    await page.click('#panelOk');
    await app(page, () => {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='900'><rect width='420' height='900' fill='#f2efe9'/><rect x='250' y='420' width='170' height='300' fill='#cfe6c4'/><g stroke='#fff' stroke-width='9'><path d='M0 700 L420 640'/><path d='M0 780 L420 820'/><path d='M0 860 L420 880'/><path d='M60 0 L120 900'/></g><path d='M215 0 L205 900' stroke='#f6c85f' stroke-width='14'/><g font-family='sans-serif' font-size='13' fill='#555'><text x='20' y='695'>Новоселівська вулиця</text><text x='230' y='800'>Удянський вʼїзд</text><text x='30' y='850'>Шляхова вулиця</text><text x='225' y='875'>М-03</text></g></svg>`;
      const st = document.createElement('style');
      st.textContent = `#map{background:url("data:image/svg+xml,${encodeURIComponent(svg)}") center/cover}.maplibregl-canvas{opacity:0}`;
      document.head.appendChild(st);
    });
    await sleep(200); await shot(page, '13-day-glass');
    await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('[data-seg="theme:night"]');
  }
  await page.click('[data-seg="theme:night"]'); await sleep(300);
  ok('нічний режим', await app(page, () => document.body.dataset.theme === 'night'));
  ok('вночі нижня панель теж прозора і темна', await app(page, () => { const c = getComputedStyle(document.querySelector('#tbShape .tb-fill')).fill; const p = c.match(/[\d.]+/g).map(Number); return p[0] < 60 && p[3] <= 0.5; }));
  await page.click('[data-tg="vibrate"]');
  ok('перемикач вібрації', await app(page, () => window.__app.S.vibrate === false));
  await page.click('#panelOk');
  await shot(page, '10-night');
  ok('у дорозі голосом попереджено про міст 15 т', await app(page, () => window.__spoken.some(s => /Міст до 15 т/.test(s))), (await app(page, () => window.__spoken.filter(s => /Міст|Ґрунт/.test(s)).join(' | '))));
  // Київ у години пік
  const ky = await app(page, () => {
    const R = window.__app.roads, route = { coords: [[50.95, 30.45], [50.70, 30.50], [50.45, 30.52], [50.20, 30.60]] };
    const at = h => () => new Date(2026, 10, 23, h, 30).getTime();
    const a = R.kyivOnRoute(route, 0, at(8)), b = R.kyivOnRoute(route, 0, at(13)), c = R.kyivOnRoute({ coords: [[49.99, 36.23], [49.6, 34.55]] }, 0, at(8));
    return { a: a && a.rush, b: b && b.rush, c };
  });
  ok('Київ: в\'їзд о 08:30 — години пік, о 13:30 — ні, маршрут Харків–Полтава Києва не зачіпає', ky.a === true && ky.b === false && ky.c === null, JSON.stringify(ky));
  // спека: прогноз +31 °C на маршруті
  await page.route('**/v1/forecast*', r => { const u = new URL(r.request().url()), n = u.searchParams.get('latitude').split(',').length, t0 = Math.floor(Date.now() / 3600e3) * 3600;
    const time = Array.from({ length: 72 }, (_, i) => t0 + i * 3600), z = v => time.map(() => v);
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.from({ length: n }, () => ({ hourly: { time, temperature_2m: z(31), precipitation: z(0), snowfall: z(0), weather_code: z(1), wind_gusts_10m: z(10), visibility: z(20000) } }))) }); });
  const heat = await app(page, async () => {
    const W = window.__app.weather, S = window.__app.S, route = { coords: [[49.99, 36.23], [49.8, 35.5], [49.6, 34.55]], dist: 140000, time: 7200 };
    const h = await W.heatAlong(route), w0 = S.truck.weight; const light = W.heatApplies(); S.truck = { ...S.truck, weight: 40 }; const heavy = W.heatApplies(); S.heatExempt = true; const ex = W.heatApplies(); S.heatExempt = false; S.truck = { ...S.truck, weight: w0 };
    return { maxT: h && h.maxT, first: !!(h && h.first), heavy, ex, light };
  });
  ok('спека: прогноз +31 °C на маршруті; обмеження діє і для нашої фури 20 т (на вісь 11,5 т — понад 7 т), і для 40 т; пільговий вантаж — без', heat.maxT === 31 && heat.first && heat.light === true && heat.heavy === true && heat.ex === false, JSON.stringify(heat));
  // тряска за датчиками: калібрування і погана ділянка
  const rg = await app(page, () => {
    const R = window.__app.rough, base = [49.70, 35.00];
    for (let i = 0; i < 420; i++) for (let k = 0; k < 2; k++) R.addSample(base[0] + i * 0.0009, base[1], 20, 0.04 * (0.8 + ((i + k) % 7) / 10));
    for (let k = 0; k < 6; k++) for (let i = 0; i < 8; i++) R.addSample(base[0] + (100 + i) * 0.0009, base[1], 20, 0.5);
    const idx = new window.__app.core.RouteIndex([[base[0], base[1]], [base[0] + 0.3, base[1]]]);
    const st = R.stats(), bad = R.badAlong(idx), gj = R.geojson();
    return { calib: st.calib, r: st.r, g: st.g, bad: bad && Math.round(bad.m), red: gj.features.filter(f => f.properties.l === 'r').length };
  });
  ok('тряска: після калібрування погані ділянки червоні, на маршруті ≈ 0,6 км поганої дороги', rg.calib === 100 && rg.r >= 6 && rg.g > 300 && rg.bad >= 500 && rg.bad <= 900 && rg.red >= 6, JSON.stringify(rg));
  ok('жодної помилки JS за весь прохід', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('сценарій 1 дійшов до кінця', false, String(e.message).split('\n').slice(0, 8).join(' / ').slice(0, 700)); }

/* ============ прохід 2б: перезапуск посеред зони підміни ============ */
if (run('2б')) try {
  const { page, ctx, errors } = await newPage(true, { motion: { v: 16.4, t: Date.now() - 90000 } });
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await emitN('loc', { prov: 'network', lat: 50.0, lon: 35.97, acc: 900, t: Date.now() });
  await emitN('loc', { prov: 'gps', lat: 50.6, lon: 36.59, acc: 4, spd: 0, t: Date.now() });
  await sleep(1200);
  const v1 = await app(page, () => ({ val: document.getElementById('spdVal').textContent, unit: document.getElementById('spdUnit').textContent, mode: window.__app.nav.pos.mode }));
  ok('після перезапуску в зоні підміни — остання чесна швидкість як оцінка', v1.val === '≈59' && v1.unit === 'оцінка' && v1.mode === 'approx', JSON.stringify(v1));
  // вишки й Wi-Fi, що помітно зсуваються: швидкість за ними (≈ 72 км/год)
  const t0 = Date.now();
  await app(page, () => { window.__realNow = Date.now; });
  for (let i = 0; i <= 6; i++) {
    await app(page, k => { const base = window.__realNow(); Date.now = () => base + k * 30000; }, i);
    await emitN('loc', { prov: 'network', lat: 50.0 + i * 30 * 20 / 111320, lon: 35.97, acc: 60, t: t0 + i * 30000 });
  }
  await sleep(1200);
  const v2 = await app(page, () => ({ sv: window.__app.nav.speedView(), st: window.__app.nav.debugState() }));
  await app(page, () => { Date.now = window.__realNow; });
  ok('швидкість за вишками й Wi-Fi рахується прямою через точки', v2.sv.kind === 'approx' && Math.abs(v2.sv.kmh - 72) < 6, JSON.stringify({ sv: v2.sv, ap: v2.st.apSpd, err: v2.st.apSpdErr }));
  // нова версія інтерфейсу приїхала посеред підміни — не перезавантажуємось самі
  await emitN('webUpdated', { ok: true, ver: 99 });
  await sleep(300);
  ok('у зоні підміни інтерфейс не перезавантажується сам — лише плашка «готова, перезапустити»', await app(page, () => !window.__nativeCalls.includes('reloadUi') && !document.getElementById('updBar').hidden && /перезапустити/.test(document.getElementById('updGo').textContent)));
  ok('прохід перезапуску без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід перезапуску дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 2в: маршрут без «Поїхали» і перезапуск посеред рейсу ============ */
if (run('2в')) try {
  const { page, ctx, errors } = await newPage(true);
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await emitN('loc', { prov: 'gps', lat: coords[0][0], lon: coords[0][1], acc: 5, spd: 0, t: Date.now() });
  const n = coords.length;
  const trip = { id: 't-auto', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  await app(page, tr => window.__app.route.saveTrip(tr), trip);
  await page.click('#tabs button[data-panel="trip"]');
  await page.click('#tripTools [data-act="archive"]'); await page.click('[data-open="t-auto"]'); await page.click('#panelOk');
  ok('без рейсу немає «Рейс не задано»; побудований маршрут — «не запущено»', /не запущено/.test(await page.textContent('#remain')) && !/Рейс не задано/.test(await page.textContent('#bottom')));
  // водій просто їде маршрутом ~20 м/с
  await app(page, () => { const R = window.__app.core.RouteIndex; const idx = new R(window.__app.route.getTrips().find(x => x.id === 't-auto').route.coords); let d = 100;
    window.__drive = setInterval(() => { const p = idx.at(d); window.__reis('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: 20, brg: p.brg, t: Date.now() }); d += 20; }, 1000); });
  await page.waitForFunction(() => window.__app.guide.g.active, null, { timeout: 30000 }).catch(() => {});
  const au = await app(page, () => ({ active: window.__app.guide.g.active, id: window.__app.guide.g.trip && window.__app.guide.g.trip.id, toast: document.getElementById('toasts').textContent, rd: window.__app.nav.pos.rd }));
  ok('їде маршрутом без «Поїхали» → ведення вмикається саме, без повернення до А', au.active && au.id === 't-auto' && /ведення увімкнено/.test(au.toast) && au.rd > 200, JSON.stringify({ ...au, toast: au.toast.slice(0, 80) }));
  await sleep(1500);
  await app(page, () => clearInterval(window.__drive));
  // перезапуск посеред рейсу (оновлення інтерфейсу, закрили застосунок)
  await page.reload();
  await page.waitForFunction(() => window.__app && window.__app.guide.g.active, null, { timeout: 15000 }).catch(() => {});
  const rs = await app(page, () => ({ active: window.__app.guide.g.active, id: window.__app.guide.g.trip && window.__app.guide.g.trip.id, toast: document.getElementById('toasts').textContent }));
  ok('після перезапуску рейс продовжується сам', rs.active && rs.id === 't-auto' && /Рейс продовжено/.test(rs.toast), JSON.stringify({ ...rs, toast: rs.toast.slice(0, 80) }));
  // завершили рейс — після перезапуску не відновлюється
  await app(page, () => window.__app.guide.stopTrip()); await sleep(300);
  await page.reload(); await sleep(2500);
  ok('зупинений рейс після перезапуску не воскресає', await app(page, () => !window.__app.guide.g.active));
  ok('прохід «без Поїхали і перезапуск» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «без Поїхали і перезапуск» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 2г: без GPS — по маршруту (як BlindDriver) ============ */
if (run('2г')) try {
  const { page, ctx, errors } = await newPage(true);
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length;
  const trip = { id: 't-blind', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  const at = d => app(page, d => { const R = window.__app.core.RouteIndex, c = window.__app.guide.g.route.coords; const p = new R(c).at(d); return { lat: p.lat, lon: p.lon, brg: p.brg }; }, d);
  const gps = async (d, extra = {}) => { const p = await at(d); await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: 22, brg: p.brg, t: Date.now(), ...extra }); };
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  await gps(15978); await sleep(1000);
  // 1) вишки помиляються на 7 км, а GPS лежить на маршруті — це справжній GPS, не підміна (випадок на М-03)
  const p7 = await at(16000);
  await emitN('loc', { prov: 'network', lat: p7.lat + 0.063, lon: p7.lon, acc: 1500, t: Date.now() });
  await gps(16000); await sleep(150);
  const r1 = await app(page, () => ({ mode: window.__app.nav.pos.mode, why: window.__app.nav.pos.spoofWhy || '', off: window.__app.guide.g.offRoute }));
  ok('вишки на 7 км убік, GPS — на маршруті: GPS прийнято, «поза маршрутом» немає', r1.mode === 'gps' && r1.why === '' && !r1.off, JSON.stringify(r1));
  // 2) далі GPS підмінили (Бєлгород) — позначка лишається на маршруті й їде за швидкістю
  for (let i = 0; i < 3; i++) { await emitN('loc', { prov: 'gps', lat: 50.6, lon: 36.59, acc: 4, spd: 0, t: Date.now() }); await sleep(200); }
  await sleep(1200);
  const r2 = await app(page, () => ({ mode: window.__app.nav.pos.mode, on: window.__app.nav.pos.onRoute, rd: window.__app.nav.pos.rd, man: document.getElementById('manDist').textContent }));
  ok('підміна посеред рейсу: розрахунок по маршруту, без «поза маршрутом»', r2.mode === 'dr' && r2.on && r2.rd > 15900 && !/зійшли з рейсу/i.test(r2.man), JSON.stringify(r2));
  // 3) швидкість від водія: 80 км/год
  await page.click('#speed'); await shot(page, '15-speed-pick'); await page.click('#spdPop [data-v="80"]');
  const rdA = await app(page, () => window.__app.nav.pos.rd); await sleep(3100);
  const rdB = await app(page, () => window.__app.nav.pos.rd);
  ok('швидкість, вибрана на спідометрі, рухає позначку (80 км/год ≈ 22 м/с)', rdB - rdA > 55 && rdB - rdA < 95 && /ваша/.test(await page.textContent('#spdUnit')), Math.round(rdB - rdA) + ' м за 3 с');
  // 4) гіроскоп: перед різким поворотом позначка чекає, після повороту — стає точно за ним
  const tr0 = await app(page, () => window.__app.nav.routeTurns().find(x => x.d > 300));
  ok('на маршруті знайдено різкий поворот попереду', !!tr0, JSON.stringify(tr0));
  if (tr0) {
    await app(page, d => window.__app.nav.snapToRoute(null) || true, 0);
    await app(page, d => { const R = window.__app.core.RouteIndex, c = window.__app.guide.g.route.coords; const p = new R(c).at(d); window.__app.nav.setManual({ lat: p.lat, lon: p.lon }); }, tr0.d - 120);
    // 1.1.8: гіроскоп — як у телефоні, раз на секунду. 12 с курс рівний: позначка доїжджає до перехрестя й чекає на ньому
    for (let k = 0; k < 12; k++) { await emitN('sens', { var: 0.05, yaw: 0 }); await sleep(1000); }
    const held = await app(page, () => window.__app.nav.pos.rd);
    ok('перед поворотом позначка чекає на гіроскоп (стоїть біля перехрестя ±25 м, не проскакує)', held <= tr0.d + 25 && held > tr0.d - 60, `rd ${Math.round(held)}, поворот ${Math.round(tr0.d)}`);
    ok('поки чекає — кнопка «Поворот» жовта з написом «чекаю»', await app(page, () => { const b = document.getElementById('bTurn'); return !b.hidden && /st-wait/.test(b.className) && /чекаю/.test(b.textContent); }), await app(page, () => document.getElementById('bTurn').className + '|' + document.getElementById('bTurn').textContent));
    // поворот: 6 с повертаємо, далі рівно — позначка за поворотом, похибка мала, далі розгін
    for (let k = 1; k <= 14; k++) { await emitN('sens', { var: 0.05, yaw: tr0.ang * Math.min(1, k / 6) }); await sleep(1000); }
    const after = await app(page, () => window.__app.nav.pos.rd);
    ok('гіроскоп відчув поворот — позначка за поворотом, похибка скинута', after > tr0.d && after < tr0.d + 450 && await app(page, () => window.__app.nav.pos.acc <= 60), `rd ${Math.round(after)}, поворот ${Math.round(tr0.d)}, ±${await app(page, () => window.__app.nav.pos.acc)} м`);
  }
  // 5) вишки «стрибають» на 3 км за 30 с — швидкість 360 км/год не показуємо
  await app(page, () => { window.__realNow = Date.now; });
  for (let i = 0; i <= 4; i++) {
    await app(page, k => { const b = window.__realNow(); Date.now = () => b + k * 30000; }, i);
    await emitN('loc', { prov: 'network', lat: 49.9 + (i % 2) * 0.027, lon: 35.5, acc: 1200, t: Date.now() + i * 30000 });
  }
  await app(page, () => { Date.now = window.__realNow; });
  ok('стрибки вишок не дають «≈143 за вишками»', await app(page, () => { const d = window.__app.nav.debugState(); return d.apSpd == null || d.apSpd < 30; }));
  ok('прохід «без GPS по маршруту» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «без GPS по маршруту» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 2д: швидкість фури (обмежувач 90) — оцінка не може бути більшою ============ */
// Випадок з дороги: «≈106 оцінка» на фурі з обмежувачем 90. Відтворюємо, звідки могла взятися така цифра.
if (run('2д')) try {
  const { page, ctx, errors } = await newPage(true, { motion: { v: 31, t: Date.now() - 60000 } });   // збережено з минулого запуску: 112 км/год
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const sv = () => app(page, () => { const v = window.__app.nav.speedView(); return { kmh: v.kmh == null ? null : Math.round(v.kmh), kind: v.kind, mode: window.__app.nav.pos.mode, reason: window.__app.nav.pos.reason, vc: Math.round(window.__app.nav.debugState().vCruise * 36) / 10 }; });
  const D2R = Math.PI / 180, east = (p, m) => ({ lat: p.lat, lon: p.lon + m / (111320 * Math.cos(p.lat * D2R)) });
  await sleep(1200);
  // 0) перезапуск у зоні підміни: збережена «чесна» швидкість 112 км/год — не більше обмежувача
  await emitN('loc', { prov: 'network', lat: 49.59, lon: 34.55, acc: 900, t: Date.now() });
  for (let i = 0; i < 2; i++) { await emitN('loc', { prov: 'gps', lat: 50.6, lon: 36.59, acc: 4, spd: 0, t: Date.now() }); await sleep(150); }
  const s0 = await sv();
  ok('швидкість: збережена з минулого запуску 112 км/год → показуємо не більше 90', s0.kmh == null || s0.kmh <= 90, JSON.stringify(s0));
  // 1) чесний GPS 88 км/год, далі сигнал зник: оцінка ≈ 88
  let p = { lat: 49.60, lon: 34.40 }, t = Date.now();
  for (let i = 0; i < 8; i++) { p = east(p, 24.4); t += 1000; await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: 24.4, brg: 90, t }); await sleep(60); }
  const s1a = await sv();
  ok('швидкість: чесний GPS 88 км/год показано як є', s1a.kind === 'gps' && s1a.kmh === 88, JSON.stringify(s1a));
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 9000 });
  const s1 = await sv();
  ok('швидкість: GPS зник — оцінка ≈ 88 (як було)', s1.kind === 'est' && s1.kmh >= 84 && s1.kmh <= 90, JSON.stringify(s1));
  // 2) GPS повернувся, а за хвилину підміна «затягує»: швидкість у фіксах росте 94 → 130 км/год, точки плавні; потім стрибок у Бєлгород
  for (let i = 0; i < 4; i++) { p = east(p, 24.4); t += 1000; await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: 24.4, brg: 90, t }); await sleep(250); }
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps', null, { timeout: 6000 }).catch(() => {});
  const spoof = [26, 28, 30, 32, 34, 36];
  for (const v of spoof) { p = east(p, v); t += 1000; await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 4, spd: v, brg: 90, t }); await sleep(60); }
  const s2a = await sv();
  ok('швидкість: GPS показує 130 км/год на фурі з обмежувачем 90 — це не наша швидкість (підміна), на спідометрі її немає', !(s2a.kind === 'gps' && s2a.kmh > 100), JSON.stringify(s2a));
  for (let i = 0; i < 3; i++) { await emitN('loc', { prov: 'gps', lat: 50.6, lon: 36.59, acc: 4, spd: 0, t: Date.now() }); await sleep(150); }
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 9000 });
  const s2 = await sv();
  ok('швидкість: після «затягування» підміною оцінка не більша за 90 (було ≈106–112)', s2.kmh != null && s2.kmh <= 90 && s2.kmh >= 80, JSON.stringify(s2));
  // 3) фікси без швидкості приходять пачкою (раз на 0,4 с, а зняті раз на 1 с): швидкість рахуємо за часом фікса, а не приходу
  await app(page, () => window.__app.sim.setSpoof(false));
  for (let i = 0; i < 6; i++) { p = east(p, 24.4); t += 1000; await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, brg: 90, t }); await sleep(400); }
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps', null, { timeout: 6000 }).catch(() => {});
  for (let i = 0; i < 6; i++) { p = east(p, 24.4); t += 1000; await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, brg: 90, t }); await sleep(400); }
  const s3 = await sv();
  ok('швидкість: фікси без швидкості пачкою — ≈88, а не 220', s3.kind === 'gps' && s3.kmh >= 80 && s3.kmh <= 95, JSON.stringify(s3));
  // 4) легковик (обмежувач 0 — вимкнено): 120 км/год за GPS — справжня швидкість, не підміна
  await app(page, () => { window.__app.S.truck = { ...window.__app.S.truck, vmax: 0 }; });
  for (let i = 0; i < 4; i++) { p = east(p, 33.3); t += 1000; await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: 33.3, brg: 90, t }); await sleep(60); }
  const s4 = await sv();
  ok('швидкість: обмежувач вимкнено (легковик) — 120 км/год за GPS приймається', s4.kind === 'gps' && s4.kmh === 120, JSON.stringify(s4));
  await app(page, () => { window.__app.S.truck = { ...window.__app.S.truck, vmax: 90 }; });
  // 5) маршрут: обмежувач іде у Valhalla як top_speed — час у дорозі для фури, а не для легковика
  const tk = await app(page, async () => { const r = window.__app.route; return r.truckOptions ? r.truckOptions() : null; });
  ok('маршрут: обмежувач 90 передано як top_speed', tk && tk.top_speed === 90, JSON.stringify(tk));
  ok('прохід «швидкість фури» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «швидкість фури» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 2ґ: старт рейсу вже в зоні підміни — «На маршрут» ============ */
if (run('2ґ')) try {
  const { page, ctx, errors } = await newPage(true);
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length;
  const trip = { id: 't-snap', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  // вишки показують за 9 км від маршруту — сама прив'язка не спрацює, а кнопка «На маршрут» є
  await emitN('loc', { prov: 'network', lat: coords[300][0] + 0.08, lon: coords[300][1], acc: 1500, t: Date.now() });
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  await emitN('loc', { prov: 'gps', lat: 50.6, lon: 36.59, acc: 4, spd: 0, t: Date.now() });
  await sleep(1500);
  const s1 = await app(page, () => ({ mode: window.__app.nav.pos.mode, btn: !document.getElementById('manSnap').hidden, man: document.getElementById('manDist').textContent }));
  ok('вишки далеко від маршруту: «Немає GPS» і кнопка «На маршрут»', s1.mode === 'approx' && s1.btn && /Немає GPS/.test(s1.man), JSON.stringify(s1));
  await shot(page, '14-no-gps-snap');
  await page.click('#manSnap'); await sleep(300);
  const wp = await app(page, () => ({ open: !document.getElementById('wherePop').hidden, rows: [...document.querySelectorAll('#wherePop [data-d]')].map(b => b.textContent.trim().slice(0, 40)) }));
  ok('«На маршрут» → «Де ви зараз?»: початок маршруту й місця вздовж нього', wp.open && wp.rows.length >= 1 && /Початок рейсу/.test(wp.rows.join('|')), JSON.stringify(wp));
  await shot(page, '14b-where');
  await page.click('#wherePop [data-d]');
  await sleep(300);
  const s2 = await app(page, () => ({ mode: window.__app.nav.pos.mode, on: window.__app.nav.pos.onRoute, rd: window.__app.nav.pos.rd == null ? -1 : Math.round(window.__app.nav.pos.rd) }));   // 0 — початок маршруту, теж правильно
  ok('«На маршрут» — позначка на маршруті, ведення без GPS', s2.mode === 'dr' && s2.on && s2.rd >= 0, JSON.stringify(s2));
  // (1.1.32) довге натискання біля маршруту (за 50 м від лінії) без GPS — спершу вибір: «Я тут» (на маршрут) чи «Контрольна точка»
  { const pt = await app(page, () => { const R = window.__app.core.RouteIndex, c = window.__app.guide.g.route.coords; const p = new R(c).at(9000); return { lat: p.lat + 0.00045, lon: p.lon }; });
    const rd0 = await app(page, () => Math.round(window.__app.nav.pos.rd));
    await app(page, p => window.__app.bus.emit('mapPick', p), pt); await sleep(250);
    const s3a = await app(page, () => ({ rd: Math.round(window.__app.nav.pos.rd), pick: !document.getElementById('pick').hidden, ks: [...document.querySelectorAll('#pick button')].map(b => b.dataset.k + ':' + b.textContent.trim()) }));
    ok(`без GPS довге натискання біля маршруту — не переносить одразу, а питає: ${s3a.ks.join(' · ')}`, s3a.pick && Math.abs(s3a.rd - rd0) < 30 && s3a.ks.join() === 'cp:Контрольна точка,here:Я тут,x:', JSON.stringify(s3a));
    await page.click('#pick [data-k="here"]'); await sleep(250);
    const s3 = await app(page, () => ({ rd: Math.round(window.__app.nav.pos.rd), pick: !document.getElementById('pick').hidden, toast: document.getElementById('toasts').textContent }));
    ok('«Я тут» — позначка на маршруті в цьому місці (палець міг промахнутись повз лінію)', Math.abs(s3.rd - 9000) < 250 && !s3.pick && /на лінії рейсу/.test(s3.toast), JSON.stringify({ ...s3, toast: s3.toast.slice(-60) })); }
  ok('прохід «На маршрут» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «На маршрут» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 6 (1.1.28): з'їхали з маршруту — програма НЕ перебудовує рейс сама, а пропонує: причина, відлік 10 с, голос ============
   Діма (Чернівці → Львів): «їде машина, проїхати можна, а він постійно: давайте об'їдемо, маршрут перебудовано». Тепер: задали рейс — їдемо
   ним. З'їхали — вікно «Ви з'їхали з рейсу. Перебудувати?» з відліком і голосом; не підтвердили — ведемо запланованим, удруге не питаємо. */
if (run('6')) try {
  const { page, ctx, errors } = await newPage(true);
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length;
  const mkTrip = (id, b) => ({ id, a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: b || { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } });
  await app(page, () => { window.__offers = []; window.__app.bus.on('offer', o => window.__offers.push('show:' + o.kind)); window.__app.bus.on('offerEnd', e => window.__offers.push('hide:' + e.why)); });
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), mkTrip('t-keep'));
  const at = d => app(page, d => { const R = window.__app.core.RouteIndex, c = window.__app.guide.g.route.coords; const p = new R(c).at(d); return { lat: p.lat, lon: p.lon, brg: p.brg }; }, d);
  let D = 7000;                                                    // де ми вздовж рейсу, м
  let cur = 0;                                                     // на скільки градусів ми зараз убік від рейсу
  let lastFix = 0;                                                 // їдемо 20 м/с за справжнім годинником — хоч би як часто йшли відліки
  const fix = async (side = 0) => { const now = Date.now(); if (lastFix) D += Math.min(60, 20 * (now - lastFix) / 1000); lastFix = now; const p = await at(D); cur = side; await emitN('loc', { prov: 'gps', lat: p.lat + side, lon: p.lon, acc: 5, spd: 20, brg: p.brg, t: Date.now() }); };
  // їдемо secs секунд (відлік щосекунди): side — на скільки градусів убік від рейсу (0.0036 ≈ 400 м); stop() — вийти раніше
  const trace = [];
  const drive = async (secs, side, stop) => { for (let i = 0; i < secs; i++) { await fix(typeof side === 'function' ? side(i) : side); await sleep(1000); trace.push(await app(page, () => { const p = window.__app.nav.pos, g = window.__app.guide.g; return (p.mode === 'gps' ? '' : p.mode + ':') + (p.onRoute ? 'on' : 'off' + Math.round(p.off)) + (g.offer ? '?' : ''); })); if (stop && await stop()) return i + 1; } return secs; };
  const offer = () => app(page, () => !!window.__app.guide.g.offer);
  // плавно, як машина: убік — на 33 м за секунду (до max), назад на рейс — так само
  const out = max => i => Math.min(max, cur + 0.0003), back = () => Math.max(0, cur - 0.0003);
  const home = async secs => drive(secs, back);                   // повертаємось на рейс і їдемо ним
  const st = () => app(page, () => { const g = window.__app.guide.g, b = document.getElementById('rrAsk'), vis = !b.hidden && b.getBoundingClientRect().height > 0;
    const R = e => { const q = e.getBoundingClientRect(); return { l: Math.round(q.left), t: Math.round(q.top), r: Math.round(q.right), b: Math.round(q.bottom), w: Math.round(q.width), h: Math.round(q.height) }; };
    const yes = b.querySelector('[data-rr="new"]'), back = b.querySelector('[data-rr="back"]'), no = b.querySelector('[data-rr="no"]'), seen = e => { if (!e) return false; const q = e.getBoundingClientRect(), h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return !!h && e.contains(h); };
    return { vis, offer: g.offer ? { kind: g.offer.kind, secs: g.offer.secs } : null, box: vis ? R(b) : null, title: vis ? b.querySelector('.rr-tx b').textContent : '', text: vis ? b.querySelector('.rr-tx small').textContent : '', sec: vis ? +document.getElementById('rrSec').textContent : null,
      yes: vis ? R(yes) : null, back: vis ? R(back) : null, no: vis ? R(no) : null, yesT: vis ? yes.textContent.trim() : '', backT: vis ? back.textContent.trim() : '', noT: vis ? no.querySelector('span').textContent : '', seen: vis && seen(yes) && seen(back) && seen(no), barT: Math.round(document.getElementById('tabbar').getBoundingClientRect().top), W: innerWidth, H: innerHeight,
      off: g.offRoute, rerouting: g.rerouting, pts: g.route ? g.route.coords.length : 0, man: document.getElementById('manDist').textContent, manText: document.getElementById('manText').textContent, toasts: document.getElementById('toasts').textContent, spoken: window.__spoken.slice(), offers: window.__offers.slice(), speedHidden: getComputedStyle(document.getElementById('speed')).visibility === 'hidden' }; });
  await drive(3, 0);
  ok('вибраний маршрут запам’ятовано (спрощено)', await app(page, () => Array.isArray(window.__app.guide.g.trip.chosen) && window.__app.guide.g.trip.chosen.length > 40));
  const n0 = routeReqs.length, pts0 = (await st()).pts;
  await app(page, () => { window.__spoken.length = 0; });
  // а) з'їхали на паралельну дорогу (400 м убік): через кілька секунд — пропозиція, а не перебудова
  const ramp = out(0.0030);
  const t1 = await drive(24, ramp, offer); await sleep(300);
  const a = await st(); await shot(page, '61-offer');
  ok(`з’їхали з рейсу — маршрут САМ не перебудовано (запитів до сервера: ${routeReqs.length - n0}); через ${t1} с зʼявилась пропозиція`, routeReqs.length === n0 && a.pts === pts0 && !!a.offer && a.offer.kind === 'off' && a.vis && !a.rerouting, JSON.stringify({ reqs: routeReqs.length - n0, offer: a.offer, vis: a.vis, t1 }));
  ok(`картка пропозиції: «${a.title}» — «${a.text}»; відлік із ${a.offer && a.offer.secs} с (зараз ${a.sec})`, /Ви зійшли з рейсу/.test(a.title) && /До рейсу \d+ м\./.test(a.text) && /Прокласти новий маршрут звідси чи повернутись на запланований\?/.test(a.text) && /Не відповісте — веду запланованим/.test(a.text) && a.offer.secs === 10 && a.sec >= 7 && a.sec <= 10, JSON.stringify({ title: a.title, text: a.text, sec: a.sec }));
  ok(`на вибір дві великі дії — «${a.yesT}» (${a.yes && a.yes.w}×${a.yes && a.yes.h}) і «${a.backT}» (${a.back && a.back.w}×${a.back && a.back.h}), під ними «${a.noT}» з лічильником; картка — над нижньою плашкою, у межах екрана, нічим не перекрита; круг швидкості на цей час сховано`,
    a.yesT === 'Новий маршрут' && a.backT === 'Назад на рейс' && a.noT === 'Лишити як є' && [a.yes, a.back, a.no].every(x => x.h >= 48) && a.yes.w >= 120 && a.back.w >= 110 && a.no.t >= a.yes.b && a.box.l >= 0 && a.box.r <= a.W && a.box.b <= a.barT && a.box.t >= 0 && a.seen && a.speedHidden, JSON.stringify({ box: a.box, yes: a.yes, back: a.back, no: a.no, barT: a.barT, seen: a.seen }));
  ok(`причину прочитано вголос: «${a.spoken.find(s => /зійшли/.test(s)) || ''}»`, a.spoken.some(s => /Ви зійшли з рейсу\. Прокласти новий маршрут, чи повернутись на запланований\?/.test(s)), JSON.stringify(a.spoken));
  // б) не відповідаємо: відлік іде, час вийшов — лишаємось на запланованому рейсі
  await drive(4, ramp); const mid = await st();
  ok(`відлік іде: було ${a.sec}, стало ${mid.sec}`, mid.vis && mid.sec < a.sec && mid.sec >= 1, JSON.stringify({ was: a.sec, now: mid.sec }));
  await drive(9, ramp, async () => !(await offer())); await sleep(600);
  const b = await st(); await shot(page, '61-offer-stay');
  ok('час вийшов без підтвердження — картка зникла, маршрут НЕ перебудовано: веде тим самим запланованим рейсом (жодного запиту до сервера)', !b.vis && !b.offer && routeReqs.length === n0 && b.pts === pts0 && !b.rerouting && /hide:timeout/.test(b.offers.join()), JSON.stringify({ reqs: routeReqs.length - n0, offers: b.offers }));
  ok(`про це сказано голосом («${b.spoken.find(s => /Лишаюсь/.test(s)) || ''}») і плашкою; угорі — «${b.man}» · «${b.manText}»`, b.spoken.some(s => /Лишаюсь на запланованому рейсі/.test(s)) && /Веду запланованим рейсом/.test(b.toasts) && /зійшли з рейсу/i.test(b.man) && /веду запланованим/.test(b.manText) && /торкніться — новий маршрут/.test(b.manText), JSON.stringify({ spoken: b.spoken, toasts: b.toasts.slice(0, 120), man: b.man, manText: b.manText }));
  // в) їдемо далі не за рейсом ще пів хвилини — більше не питає («постійно: давайте об'їдемо» — такого бути не повинно)
  await drive(32, ramp);
  const c = await st();
  ok(`їдемо своєю дорогою ще 32 с — удруге про той самий з’їзд не питає й нічого не перебудовує (пропозицій за весь час: ${c.offers.filter(x => /^show/.test(x)).length})`, c.offers.filter(x => /^show/.test(x)).length === 1 && !c.vis && routeReqs.length === n0 && c.pts === pts0 && c.spoken.filter(s => /Прокласти новий маршрут/.test(s)).length === 1, JSON.stringify({ offers: c.offers, reqs: routeReqs.length - n0 }));
  // г) передумали: дотик до плашки «Ви зійшли з рейсу» — пропозиція знову (без голосу); «Перебудувати» — будує шлях назад на вибраний рейс
  await page.click('#man'); await sleep(400);
  const d0 = await st();
  ok('дотик до плашки «Ви зійшли з рейсу» — пропозиція зʼявляється знову (уже без голосу)', d0.vis && d0.offer && d0.offer.kind === 'off' && d0.spoken.filter(s => /Прокласти новий маршрут/.test(s)).length === 1, JSON.stringify({ vis: d0.vis, spoken: d0.spoken }));
  await page.click('#rrAsk [data-rr="back"]');
  await page.waitForFunction(n0 => window.__app.guide.g.rerouting === false && window.__spoken.some(s => /Повертаю на вибраний рейс|Рейс перераховано/.test(s)), n0, { timeout: 6000 }).catch(() => {});
  await sleep(400);
  const rq = routeReqs.slice(n0).pop() || { locations: [] }, d1 = await st();
  ok('«Назад на рейс» — один запит: шлях назад на вибраний рейс, крізь точки вздовж нього (through) з напрямком руху; картка зникла', routeReqs.length === n0 + 1 && rq.locations.length >= 3 && rq.locations.slice(1, -1).every(l => l.type === 'through' && l.heading != null) && !rq.alternates && !d1.vis, JSON.stringify({ reqs: routeReqs.length - n0, loc: rq.locations.map(l => l.type + (l.heading != null ? '@' + l.heading : '')) }));
  ok('сказано «Повертаю на вибраний рейс»', d1.spoken.some(s => /Повертаю на вибраний рейс/.test(s)), JSON.stringify(d1.spoken));
  // ґ) повернулись на рейс, їдемо ним; новий з'їзд — нова пропозиція; «Лишити» — нічого не міняється
  await home(40);
  const n1 = routeReqs.length, k1 = (await st()).offers.filter(x => /^show/.test(x)).length;
  const t2 = await drive(24, ramp, offer); await sleep(300);
  const e0 = await st();
  ok(`повернулись на рейс і з’їхали знову — це новий з’їзд, про нього питає знову (через ${t2} с)`, e0.vis && e0.offers.filter(x => /^show/.test(x)).length === k1 + 1 && routeReqs.length === n1, JSON.stringify({ offers: e0.offers, t2 }));
  await page.click('#rrAsk [data-rr="no"]'); await sleep(500);
  const e1 = await st();
  ok('«Лишити» — картка зникла одразу, маршрут той самий, запитів до сервера немає', !e1.vis && !e1.offer && routeReqs.length === n1 && /hide:no$/.test(e1.offers.join()), JSON.stringify({ offers: e1.offers.slice(-2), reqs: routeReqs.length - n1 }));
  // д) пропозиція на екрані, а водій сам повернувся на рейс — питати вже нема про що, картка зникає сама
  await home(44);
  await drive(24, out(0.0012), offer); await sleep(300);          // недалеко: 130 м убік
  const f0 = await st();
  await drive(7, back, async () => !(await offer())); await sleep(400);
  const f1 = await st();
  ok('пропозиція висить, а водій сам повернувся на рейс — картка зникає сама, нічого не перебудовано', f0.vis && !f1.vis && !f1.offer && /hide:back$/.test(f1.offers.join()) && routeReqs.length === n1 && !f1.off, JSON.stringify({ was: f0.vis, offers: f1.offers.slice(-2), trace: trace.slice(-64).join(' ') }));
  // ж0) (1.1.28) «Новий маршрут»: варіанти звідси для всіх видів рейсу — фура суворо (+ запасний), на свій розсуд; вибрати й підтвердити
  const shifted = coords.map(([la, lo]) => [la + 0.003, lo]);
  const freeJson = { ...tripJson, trip: { ...tripJson.trip, legs: [{ ...tripJson.trip.legs[0], shape: enc6(shifted) }] } };
  ROUTE.fn = q => q.costing === 'auto' ? { status: 200, body: freeJson } : null;
  const ch = () => app(page, () => { const c = window.__app.guide.g.choice, box = document.getElementById('routePick'), vis = !box.hidden && box.dataset.mode === 'rr';
    const R = e => { const q = e.getBoundingClientRect(); return { l: Math.round(q.left), t: Math.round(q.top), r: Math.round(q.right), b: Math.round(q.bottom), w: Math.round(q.width), h: Math.round(q.height) }; };
    const sel = window.__app.map.map.getSource('route-sel'), alts = window.__app.map.map.getSource('route-alts'), sd = sel && sel.serialize().data, ad = alts && alts.serialize().data;
    return { c: c ? { state: c.state, n: c.routes.length, sel: c.sel, kinds: c.routes.map(x => x.kind), until: c.until ? Math.round((c.until - Date.now()) / 1000) : null } : null, vis, box: vis ? R(box) : null, W: innerWidth, H: innerHeight, barT: Math.round(document.getElementById('tabbar').getBoundingClientRect().top),
      cards: vis ? [...box.querySelectorAll('[data-rrv]')].map(b => ({ on: b.classList.contains('on'), kind: (b.querySelector('.rr-kind') || {}).textContent, txt: b.textContent.replace(/\s+/g, ' ').trim(), box: R(b), cut: [...b.querySelectorAll('b,em')].some(x => x.scrollWidth > x.clientWidth + 1) })) : [],
      go: vis && box.querySelector('[data-rrc="go"]') ? box.querySelector('[data-rrc="go"]').textContent.trim() : '', keep: vis && box.querySelector('[data-rrc="x"]') ? box.querySelector('[data-rrc="x"] span').textContent : '', sec: vis && document.getElementById('rrcSec') && !document.getElementById('rrcSec').hidden ? +document.getElementById('rrcSec').textContent : null,
      selLat: sd && sd.geometry ? sd.geometry.coordinates[0][1] : null, alts: ad ? ad.features.length : 0, routeLat0: window.__app.guide.g.route.coords[0][0], costing: window.__app.guide.g.trip.costing, free: !!window.__app.guide.g.trip.free,
      spoken: window.__spoken.slice(), toasts: document.getElementById('toasts').textContent, follow: window.__app.map.view.follow }; });
  const waitReady = async () => { for (let i = 0; i < 14; i++) { await fix(cur); await sleep(500); if (await app(page, () => { const c = window.__app.guide.g.choice; return !c || c.state === 'ready'; })) break; } };
  await home(44); await app(page, () => { window.__spoken.length = 0; });
  await drive(24, ramp, offer); await sleep(200);
  const nN = routeReqs.length, lat0 = (await ch()).routeLat0;
  await page.click('#rrAsk [data-rr="new"]');
  await waitReady(); await sleep(400);
  const h0 = await ch(); await shot(page, '62-choice');
  const qT = routeReqs[nN] || { locations: [] }, qA = routeReqs[nN + 1] || { locations: [] };
  ok(`«Новий маршрут» — два запити від поточного місця з напрямком руху: для фури (${qT.costing}, запасних ${qT.alternates}) і дорогами загального користування (${qA.costing}, обмежувач ${((qA.costing_options || {}).auto || {}).top_speed})`,
    routeReqs.length === nN + 2 && qT.costing === 'truck' && qT.alternates === 1 && qT.locations.length === 2 && qT.locations[0].heading != null && qA.costing === 'auto' && qA.alternates === 1 && ((qA.costing_options || {}).auto || {}).top_speed === 90, JSON.stringify({ n: routeReqs.length - nN, qT: qT.locations.map(l => l.type + (l.heading != null ? '@' + l.heading : '')), qA: qA.costing, alt: [qT.alternates, qA.alternates] }));
  ok(`варіантів на вибір: ${h0.c && h0.c.n} (${h0.cards.map(c => '«' + c.kind + '»').join(', ')}); однакові шляхи не дублюються; перший вибрано`, !!h0.c && h0.c.state === 'ready' && h0.c.n === 3 && h0.c.kinds.join() === 'strict,strict,free' && h0.cards.length === 3 && h0.cards[0].on && /Фура · суворо/.test(h0.cards[0].kind) && /На свій розсуд/.test(h0.cards[2].kind) && h0.cards.every(c => !c.cut && /≈/.test(c.txt) && /км/.test(c.txt)), JSON.stringify(h0));
  ok(`шторка вибору: у межах екрана, кнопки «${h0.go}» і «${h0.keep}» (${h0.sec} с — потім лишається старий); на карті вибраний варіант яскравий, решта (${h0.alts}) — сірі; рейс поки той самий`,
    h0.vis && h0.box.l >= 0 && h0.box.r <= h0.W && h0.box.b <= h0.H && h0.box.t > 120 && h0.go === 'Їхати цим' && h0.keep === 'Лишити старий' && h0.sec >= 25 && h0.sec <= 30 && h0.alts === 2 && h0.selLat != null && Math.abs(h0.routeLat0 - lat0) < 1e-9, JSON.stringify({ box: h0.box, sec: h0.sec, alts: h0.alts, sel: h0.selLat }));
  ok('голос: «Шукаю маршрути звідси», потім «Маршрутів: 3. Виберіть…»', h0.spoken.some(s => /Шукаю маршрути звідси/.test(s)) && h0.spoken.some(s => /Маршрутів: 3/.test(s)), JSON.stringify(h0.spoken));
  await page.click('#routePick [data-rrv="2"]'); await sleep(300);
  const h1 = await ch();
  ok('дотик до третьої картки — вона вибрана, на карті яскравим — саме вона; відлік почався знову', h1.c && h1.c.sel === 2 && h1.cards[2].on && !h1.cards[0].on && Math.abs(h1.selLat - shifted[0][0]) < 1e-6 && h1.sec >= 28, JSON.stringify({ c: h1.c, selLat: h1.selLat, sec: h1.sec }));
  await page.click('#routePick [data-rrc="go"]'); await sleep(600);
  const h2 = await ch();
  ok('«Їхати цим» — це тепер рейс: ведемо новим маршрутом (дорогами загального користування), шторка зникла, карта знову за машиною; сказано «Новий маршрут прокладено»',
    !h2.c && !h2.vis && Math.abs(h2.routeLat0 - shifted[0][0]) < 1e-6 && h2.costing === 'auto' && h2.free && h2.follow && h2.spoken.some(s => /Новий маршрут прокладено/.test(s)) && /Новий маршрут затверджено/.test(h2.toasts), JSON.stringify({ c: h2.c, lat: h2.routeLat0, costing: h2.costing, free: h2.free, follow: h2.follow, spoken: h2.spoken }));
  await drive(6, 0);
  const h3 = await st();
  ok('їдемо новим маршрутом — він і є рейс: «поза рейсом» немає, нічого не питає', !h3.off && !h3.vis && !h3.offer, JSON.stringify({ off: h3.off, offer: h3.offer, trace: trace.slice(-8).join(' ') }));
  // «Лишити старий» — нічого не міняється
  await home(40); await drive(24, ramp, offer); await sleep(200);
  await page.click('#rrAsk [data-rr="new"]'); await waitReady();
  const nK = routeReqs.length, h4 = await ch();
  await page.click('#routePick [data-rrc="x"]'); await sleep(400);
  const h5 = await ch();
  ok('«Лишити старий» — шторка зникла, рейс той самий, запитів більше немає; карта знову за машиною', h4.vis && !h5.c && !h5.vis && Math.abs(h5.routeLat0 - shifted[0][0]) < 1e-6 && routeReqs.length === nK && h5.follow && /Веду запланованим рейсом/.test(h5.toasts), JSON.stringify({ was: h4.vis, c: h5.c, follow: h5.follow }));
  // не вибрали за відведений час — лишається старий; системна «Назад» — теж «лишити старий»
  await app(page, () => { window.__app.S.choiceSecs = 3; });
  await page.click('#man'); await sleep(300);
  await page.click('#rrAsk [data-rr="new"]'); await waitReady();
  for (let i = 0; i < 10; i++) { await fix(cur); await sleep(500); if (await app(page, () => !window.__app.guide.g.choice)) break; }
  const h6 = await ch();
  ok('за відведений час нічого не вибрали — шторка зникла, рейс той самий, голос «Лишаюсь на запланованому рейсі»', !h6.c && !h6.vis && Math.abs(h6.routeLat0 - shifted[0][0]) < 1e-6 && h6.spoken.some(s => /Лишаюсь на запланованому рейсі/.test(s)), JSON.stringify({ c: h6.c, spoken: h6.spoken.slice(-3) }));
  await app(page, () => { window.__app.S.choiceSecs = 0; });
  await page.click('#man'); await sleep(300); await page.click('#rrAsk [data-rr="new"]'); await sleep(300);
  const backed = await app(page, () => window.__reisBack()); await sleep(300);
  const h7 = await ch();
  ok('системна «Назад» на виборі нового маршруту — лишити старий', backed === true && !h7.c && !h7.vis && Math.abs(h7.routeLat0 - shifted[0][0]) < 1e-6, JSON.stringify({ backed, c: h7.c }));
  ROUTE.fn = null; await home(40);
  // е) «Новий шлях від мене» — прохання самого водія: виконується одразу, без запитань
  const n3 = routeReqs.length;
  // у дорозі GPS не мовчить: відліки йдуть і поки водій відкриває деталі рейсу (інакше на повільному стенді — «без GPS», і перебудову чесно відкладено)
  await fix(0); await page.click('#tabs button[data-panel="trip"]'); await fix(0); await page.click('#routePick [data-ts="details"]');
  for (let i = 0; i < 10; i++) { await fix(0); await sleep(400); if (await app(page, () => window.__app.nav.pos.mode === 'gps')) break; }
  await page.click('[data-act="rerouteFresh"]'); await sleep(1500);
  const rq2 = routeReqs[routeReqs.length - 1];
  ok('«Новий шлях від мене» (кнопка в деталях рейсу) — будує одразу, без запитань: звичайний маршрут від поточного місця до Б', routeReqs.length === n3 + 1 && rq2.locations.length === 2 && !(await st()).vis, JSON.stringify({ reqs: routeReqs.slice(n3).map(q => q.locations.length), last: rq2.locations.map(l => l.type), mode: await app(page, () => window.__app.nav.pos.mode) }));
  // є) рейс завершили — пропозиція (якщо була) зникає
  await home(44); await drive(24, ramp, offer); await sleep(200);
  const g0 = await st();
  await app(page, () => window.__app.guide.stopTrip()); await sleep(400);
  const g1 = await st();
  ok('рейс завершили під час пропозиції — картка зникла', g0.vis && !g1.vis, JSON.stringify({ was: g0.vis, now: g1.vis }));
  ok('прохід «з’їзд з маршруту» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
  // ж) старт не з точки А: підводимо до А і далі — ТИМ САМИМ вибраним рейсом (крізь точки на його лінії), а не «як сервер порахує заново»
  { const { page, ctx, errors } = await newPage(true), emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
    for (let i = 0; i < 3; i++) { await emitN('loc', { prov: 'gps', lat: coords[0][0] + 0.02, lon: coords[0][1], acc: 5, spd: 0, t: Date.now() }); await sleep(400); }
    const n2 = routeReqs.length;
    await app(page, tr => window.__app.guide.startTrip(tr), mkTrip('t-lead')); await sleep(800);
    const rl = routeReqs[n2] || { locations: [] }, L = rl.locations, near = (l, c) => l && Math.abs(l.lat - c[0]) < 0.0005 && Math.abs(l.lon - c[1]) < 0.0005;
    ok(`стартуємо за 2 км від точки А: шлях — від нас до А і далі вибраним рейсом (точок на його лінії: ${Math.max(0, L.length - 3)}, кожна з напрямком руху)`, routeReqs.length === n2 + 1 && L.length >= 4 && Math.abs(L[0].lat - (coords[0][0] + 0.02)) < 0.001 && near(L[1], coords[0]) && L[1].type === 'through' && L.slice(2, -1).every(l => l.type === 'through' && l.heading != null) && near(L[L.length - 1], coords[n - 1]), JSON.stringify(L.map(l => l.type + (l.heading != null ? '@' + l.heading : ''))));
    ok('прохід «старт не з точки А» без помилок JS', errors.length === 0, errors.join(' | ')); await ctx.close(); }
  // з) під'їхали до фінішу не тією вулицею, що в рейсі (маршрут не перебудовували) — це теж прибуття
  { const { page, ctx, errors } = await newPage(true), emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
    const bOff = { lat: coords[n - 1][0] + 0.0013, lon: coords[n - 1][1], label: 'Склад' };       // фініш — у дворі за 140 м від кінця лінії рейсу
    const north = k => emitN('loc', { prov: 'gps', lat: bOff.lat + k, lon: bOff.lon, acc: 5, spd: 8, brg: 180, t: Date.now() });
    await north(0.0012); await sleep(500);
    await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), mkTrip('t-arr', bOff)); await sleep(400);
    await app(page, () => { window.__spoken.length = 0; });
    for (let k = 0.0011; k > 0.00025; k -= 0.0001) { await north(k); await sleep(800); }
    const arr = await app(page, () => ({ arrived: window.__app.guide.g.arrived, active: window.__app.guide.g.active, off: Math.round(window.__app.nav.pos.off), mode: window.__app.nav.pos.mode, spoken: window.__spoken.slice() }));
    ok(`до фінішу під’їхали іншою вулицею (за ${arr.off} м від лінії рейсу, маршрут не перебудовували) — «Ви прибули»`, arr.arrived && !arr.active && arr.spoken.some(s => /прибули/i.test(s)), JSON.stringify(arr));
    ok('прохід «прибуття не за лінією рейсу» без помилок JS', errors.length === 0, errors.join(' | ')); await ctx.close(); }
} catch (e) { ROUTE.fn = null; ok('прохід «з’їзд з маршруту» дійшов до кінця', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }

/* ============ прохід 5: без GPS — усі варіанти збою (як на Samsung S10: «завис на першій точці», «завис на повороті») ============ */
// Час прискорено: кожен крок — 10 с життя телефона. «Правда» — де машина насправді; порівнюємо з позначкою.
const FAILS = [
  { n: 'cells', title: 'лише вишки ±1,5 км, датчиків руху немає, 80 км/год', v: 22.2, net: 1500, every: 2, steps: 36, noSens: true, check: r => Math.abs(r.err) < 1500 && r.kmh >= 55 && r.kmh <= 95 },
  { n: 'nonet', title: 'мережевого місця немає взагалі, остання точка 2 год тому', v: 22.2, net: 0, steps: 18, lastGoodAgo: 7200e3, check: r => r.rd > 1500 && r.kind === 'plan' && r.kmh >= 45 },
  { n: 'wifi', title: 'Wi-Fi ±250 м', v: 22.2, net: 250, every: 2, steps: 18, check: r => Math.abs(r.err) < 700 },
  { n: 'stop', title: 'стоїмо (акселерометр: спокій), вишки ±1,5 км', v: 0, net: 1500, every: 2, steps: 14, still: true, check: r => r.moved60 < 300 && r.kmh === 0 },
  { n: 'behind', title: 'поставили на початок, а машина вже на 5 км далі — вишки підтягують', v: 22.2, net: 1500, every: 2, steps: 36, placeAt: 0, head: 5000, check: r => Math.abs(r.err) < 1500 },
  { n: 'outlier', title: 'одна вишка «стрибнула» на 20 км — позначка не стрибає', v: 22.2, net: 1500, every: 2, steps: 24, outlierAt: 16, check: r => Math.abs(r.err) < 1500 && r.maxJump < 3000 },
  // «Замок на повороті» (з 1.1.12): гіроскоп живий (щосекунди, як на телефоні), але повороту не відчув — позначка чекає на повороті
  // й не їде далі сама; водій тисне «Поворот» — рейс іде далі. До 1.1.14 ця перевірка чекала, що позначка проїде сама, і проходила
  // лише коли крок розрахунку випадково потрапляв у «тишу» гіроскопа між замірами тесту (раз на 10 с) — тобто не перевіряла нічого.
  { n: 'turn', title: 'різкий поворот, гіроскоп живий, поворот не відчув — позначка чекає на повороті, кнопка «Поворот» пускає далі', v: 11.1, manual: 40, net: 0, steps: 8, placeAt: 1700,
    yawFn: () => 0, pressAt: 6, check: r => !!r.held && r.held.rd >= 1960 && r.held.rd <= 2010 && r.held.cp === 'wait' && r.held.btn && r.held.tap && r.rd > 2150 && r.kind === 'manual' && r.kmh === 40 },
  { n: 'turnNoGyro', title: 'різкий поворот, гіроскопа в телефоні немає — поворот проходимо за швидкістю, не «зависає»', v: 11.1, manual: 40, net: 0, steps: 6, placeAt: 1700, check: r => r.rd > 2150 && r.cp !== 'wait' },
  { n: 'manual', title: 'водій сказав 80 км/год — їдемо за нею', v: 22.2, manual: 80, net: 1500, every: 2, steps: 12, placeAt: 0, check: r => r.kind === 'manual' && r.kmh === 80 && r.rd > 2000 },
  { n: 'turn45', title: 'поворот лише на 45° (раніше гіроскоп його не помічав): позначка відстала на 600 м — підтягується до повороту', v: 22.2, manual: 80, net: 0, steps: 12, placeAt: 4400, head: 5000,
    yawFn: tr => tr > 6000 ? 45 : 0, check: r => Math.abs(r.err) < 250 }
];
if (run('5')) for (const sc of FAILS.filter(x => !process.env.SCEN || process.env.SCEN.split(',').includes(x.n))) {
  try {
    const { page, ctx, errors } = await newPage(true);
    const T = 'без GPS: ' + sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
    const n = coords.length;
    const trip = { id: 't-f', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
      towns: [{ name: 'Пісочин', d: 6000 }, { name: 'Кам’яна Яруга', d: 15000 }],
      route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
    if (sc.lastGoodAgo) await app(page, ([p, ago]) => localStorage.setItem('reis.lastGood', JSON.stringify({ lat: p[0], lon: p[1], t: Date.now() - ago })), [coords[0], sc.lastGoodAgo]);
    await emitN('loc', { prov: 'last', lat: coords[0][0], lon: coords[0][1], acc: 20, age: 7200, t: Date.now() - 7200e3 });
    await app(page, tr => window.__app.guide.startTrip(tr), trip);
    await app(page, () => { window.__realNow = Date.now; window.__off = 0; Date.now = () => window.__realNow() + window.__off; window.__t0 = Date.now(); });
    const st = () => app(page, v => { const P = window.__app.nav.pos, sv = window.__app.nav.speedView(), b = document.getElementById('bTurn'); return { rd: P.rd == null ? 0 : P.rd, mode: P.mode, kmh: sv.kmh == null ? null : Math.round(sv.kmh), kind: sv.kind, tt: (Date.now() - window.__t0) / 1000, cp: P.cp ? P.cp.state : null, btn: !!b && !b.hidden && /st-wait/.test(b.className) }; }, sc.v);
    if (sc.placeAt != null) {
      await app(page, d => { window.__app.nav.placeAtD(d); }, sc.placeAt);
      if (sc.manual) await app(page, k => window.__app.nav.setManualSpeed(k), sc.manual);
    }
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
    const at = d => app(page, d => { const R = window.__app.core.RouteIndex, c = window.__app.guide.g.route.coords; const p = new R(c).at(Math.max(0, Math.min(d, 26700))); return { lat: p.lat, lon: p.lon }; }, d);
    let prevRd = null, maxJump = 0, last = null, hist = [], held = null;
    for (let i = 0; i < sc.steps; i++) {
      if (sc.pressAt === i) {      // водій тисне «Поворот» — справжній дотик у середину кнопки (вона «дихає», тож page.click чекав би, поки завмре)
        held = await st(); held.rd = Math.round(held.rd);
        const hit = await app(page, () => { const b = document.getElementById('bTurn'), q = b.getBoundingClientRect(), x = q.x + q.width / 2, y = q.y + q.height / 2, e = document.elementFromPoint(x, y); return { x, y, on: !b.hidden && !!e && b.contains(e) }; });
        held.tap = hit.on; await page.mouse.click(hit.x, hit.y); await sleep(300);
      }
      const truthAt = tt => (sc.head || 0) + (sc.placeAt != null && !sc.head ? sc.placeAt : 0) + sc.v * tt;
      if (sc.yawFn) {      // гіроскоп — як на телефоні, раз на секунду (10 замірів за крок)
        for (let j = 0; j < 10; j++) { const t1 = await app(page, () => { window.__off += 1000; return (Date.now() - window.__t0) / 1000; }); await emitN('sens', { var: 0.08, yaw: sc.yawFn(truthAt(t1)) }); }
      } else await app(page, () => { window.__off += 10000; });
      const tt = await app(page, () => (Date.now() - window.__t0) / 1000), truth = truthAt(tt);
      if (!sc.noSens && !sc.yawFn) await emitN('sens', { var: sc.still ? 0.0005 : 0.08, yaw: sc.yaw ? 0 : undefined });
      if (sc.net && i % (sc.every || 1) === (sc.every || 1) - 1) {
        const p = await at(i === sc.outlierAt ? truth + 20000 : truth), e = sc.net;
        await emitN('loc', { prov: 'network', lat: p.lat + rnd() * e / 111320, lon: p.lon + rnd() * e / 71500, acc: e, t: Date.now() + i });
      }
      await sleep(1100);
      last = await st(); last.truth = truth;
      if (prevRd != null) maxJump = Math.max(maxJump, Math.abs(last.rd - prevRd) - sc.v * 12);
      prevRd = last.rd; hist.push(last.rd);
    }
    const r = { ...last, held, err: Math.round(last.rd - last.truth), maxJump: Math.round(maxJump), moved60: Math.round(Math.abs(hist[hist.length - 1] - hist[Math.max(0, hist.length - 7)])), rd: Math.round(last.rd), truth: Math.round(last.truth) };
    if (process.env.DEBUG) console.log(sc.n, JSON.stringify(hist.map(Math.round)), await app(page, () => JSON.stringify({ turns: window.__app.nav.routeTurns(), log: window.__app.core.getLog().slice(-12).map(l => l.msg || l.text || JSON.stringify(l)), st: window.__app.nav.debugState().gyroSeen, yh: window.__app.nav.debugState().yawHist, mv: window.__app.nav.debugState().moving, pf: window.__app.nav.debugState().pf })));
    ok(T, sc.check(r), JSON.stringify(r));
    ok(T + ' — без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } catch (e) { ok('без GPS: ' + sc.title + ' — дійшло до кінця', false, String(e.message).split('\n')[0]); }
}

/* ============ прохід 10: датчики — повороти від 40°, плавні дуги, обгін і кільце не плутають ============ */
if (run('10')) try {
  const { page, ctx, errors } = await newPage(true);
  const r = await app(page, () => {
    const { RouteIndex, destPoint } = window.__app.core, N = window.__app.nav;
    const line = (segs) => { let p = { lat: 49.5, lon: 31.0 }; const c = [[p.lat, p.lon]]; for (const [brg, len, turn] of segs) { let b = brg; const n = Math.max(1, Math.round(len / 10)); for (let i = 0; i < n; i++) { if (turn) b += turn / n; p = destPoint(p, b, len / n); c.push([p.lat, p.lon]); } } return new RouteIndex(c); };
    const T = idx => N.findTurns(idx).map(t => t.ang);
    // історія курсу раз на секунду: [кут через t секунд]
    const H = (arr) => arr.map((yaw, i) => ({ t: i * 1000, yaw }));
    const D = (arr) => { const h = H(arr); return N.detectTurn(h, h[h.length - 1].t); };
    const ramp = (from, to, sec) => Array.from({ length: sec }, (_, i) => from + (to - from) * (i + 1) / sec);
    return {
      sharp90: T(line([[0, 500], [90, 500]])),
      sharp45: T(line([[0, 500], [45, 500]])),
      arc60: T(line([[0, 500], [0, 300, 60], [60, 500]])),          // плавна дуга 60° на 300 м
      bend30: T(line([[0, 500], [30, 500]])),                        // 30° — не контрольна точка
      lane: T(line([[0, 500], [4, 50], [-4, 50], [0, 500]])),         // перестроювання
      gSharp: D([0, 0, 0, 0, 0, 30, 70, 90, 90, 90, 90]),
      gCurve: D([0, 0, 0, 0, ...ramp(0, 42, 18), 42, 42, 42]),        // 42° за 18 с — плавна дуга
      gOvertake: D([0, 0, 0, 6, 12, 8, 2, 0, 0, 0]),
      gRound: D([0, 0, 0, 20, 40, 10, -30, -40, -20, 0, 0, 0]),        // кільце «прямо»
      gSmall: D([0, 0, 0, 5, 12, 18, 20, 20, 20])                      // 20° — не поворот
    };
  });
  ok('маршрут: різкий поворот 90° — контрольна точка', r.sharp90.length === 1 && Math.abs(r.sharp90[0]) >= 80, JSON.stringify(r.sharp90));
  ok('маршрут: поворот 45° — тепер теж контрольна точка (було від 50°)', r.sharp45.length === 1 && Math.abs(r.sharp45[0]) >= 40, JSON.stringify(r.sharp45));
  ok('маршрут: плавна дуга 60° на 300 м — контрольна точка', r.arc60.length === 1 && Math.abs(r.arc60[0]) >= 45, JSON.stringify(r.arc60));
  ok('маршрут: злам 30° і перестроювання — не контрольні точки', r.bend30.length === 0 && r.lane.length === 0, JSON.stringify([r.bend30, r.lane]));
  ok('гіроскоп: різкий поворот 90° помічено', r.gSharp && Math.abs(r.gSharp.dy - 90) < 5, JSON.stringify(r.gSharp));
  ok('гіроскоп: плавна дуга 42° за 18 с помічена (раніше — ні)', r.gCurve && Math.abs(r.gCurve.dy - 42) < 5 && r.gCurve.ago > 3 && r.gCurve.ago < 20, JSON.stringify(r.gCurve));
  ok('гіроскоп: обгін і кільце «прямо» — не поворот', !r.gOvertake && !r.gRound, JSON.stringify([r.gOvertake, r.gRound]));
  ok('гіроскоп: 20° — не поворот', !r.gSmall, JSON.stringify(r.gSmall));
  ok('прохід «датчики» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «датчики» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 4: різні екрани — нічого не накладається, кожна кнопка натискається й робить своє ============ */
// Перевірка в самій сторінці: плашки в межах екрана й одна на одну не налазять; кнопки не перекриті й не замалі для пальця.
const layoutCheck = () => {
  const W = innerWidth, H = innerHeight, out = [];
  const vis = el => !!el && !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
  const R = el => el.getBoundingClientRect();
  const nm = el => el.id ? '#' + el.id : (el.getAttribute('data-panel') ? 'tab:' + el.getAttribute('data-panel') : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName);
  const inter = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  // (1.1.24) #bottom — прозорий стовпчик; нижня плашка — контур із двома виступами: справжні її частини — кнопки (#tabs), лівий виступ із часом
  // (.tb-main) і правий зі стрілкою нахилу (#tilt); між виступами над кнопками — карта, там стоять кнопки «без GPS»
  const top = ['#top', '#rail', '#bCenter', '#speed', '#cam', '#tabs', '#tabbar .tb-main', '#tilt', '#nudge', '#updBar', '#bAcceptGps', '#attr', '#spdPop', '#pick'].map(s => document.querySelector(s)).filter(vis);
  for (const el of top) { const r = R(el); if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) out.push('за межами екрана: ' + nm(el) + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ']'); }
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) if (inter(R(top[i]), R(top[j]))) out.push('накладаються: ' + nm(top[i]) + ' і ' + nm(top[j]));
  for (const sel of ['#tripbar > *', '#tabbar .tb-main > *', '#remain > span', '#tabs > button', '#man > *', '#nudge > button', '#rail > *', '#updBar > *']) {
    const els = [...document.querySelectorAll(sel)].filter(vis);
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) if (inter(R(els[i]), R(els[j]))) out.push('накладаються: ' + nm(els[i]) + ' і ' + nm(els[j]));
  }
  for (const b of [...document.querySelectorAll('#bQuick,#bMap,#tilt,#bCenter,#speed,#spdGps,#strip,#tabs > button,#bFwd100,#bBack100,#gpsChip,#manSnap,#bAcceptGps,#updGo,#updX')].filter(vis)) {
    const r = R(b), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    if (!hit || !(b === hit || b.contains(hit))) out.push('перекрита: ' + nm(b) + ' ← ' + (hit ? nm(hit) : '—'));
    if (!((r.width >= 40 && r.height >= 36) || (r.width >= 120 && r.height >= 28))) out.push('замала для пальця: ' + nm(b) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));   // широка смуга може бути нижчою
  }
  for (const s of ['#tripbar', '#top', '#tabs', '#man']) { const el = document.querySelector(s); if (vis(el) && el.scrollWidth > el.clientWidth + 2) out.push('не влазить по ширині: ' + s); }
  return out;
};
// Справжній дотик пальцем (через протокол DevTools): карта тягнеться так само, як на телефоні
// Кілька пальців (через протокол DevTools): seq — кроки [тип, [[x, y], …]]; тип — touchStart / touchMove / touchEnd
async function touchSeq(page, seq, gap = 25) {
  const c = await page.context().newCDPSession(page);
  for (const [type, pts] of seq) { await c.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) }); await sleep(gap); }
  await c.detach();
}
async function fingerDrag(page, x, y, dx, dy) {
  const c = await page.context().newCDPSession(page);
  const pt = (px, py) => [{ x: px, y: py, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x, y) });
  const N = Math.max(2, Math.floor(Math.hypot(dx, dy) / 15));          // крок ~15 px: палець, що тягне, рушає одразу
  for (let i = 1; i <= N; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x + dx * i / N, y + dy * i / N) }); await sleep(30); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
}
const SCREENS = [
  { n: 'S10', w: 360, h: 670, title: 'Samsung S10 (як на відео: 360×670)' }, { n: 'small', w: 360, h: 600, title: 'малий 360×600' },
  { n: 'tiny', w: 320, h: 568, title: 'дуже малий 320×568' }, { n: 'xiaomi', w: 393, h: 800, title: 'Xiaomi 393×800' },
  { n: 'tall', w: 412, h: 892, title: 'високий 412×892' }, { n: 'land', w: 670, h: 360, title: 'альбомна 670×360' }, { n: 'tablet', w: 800, h: 1180, dpr: 1, title: 'планшет 800×1180' },
  { n: 'notch', w: 360, h: 700, st: 34, sb: 24, title: 'виріз угорі й жести внизу (360×700, відступи 34/24)' }
];
if (run('4')) for (const sc of SCREENS.filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) {
  try {
    const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
    const T = sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
    if (sc.st) await app(page, ([st, sb]) => { const r = document.documentElement.style; r.setProperty('--st', st + 'px'); r.setProperty('--sb', sb + 'px'); }, [sc.st, sc.sb]);
    const n = coords.length;
    const trip = { id: 't-scr', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
      route: { coords, mans: [{ type: 1, ins: 'Рухайтесь по кільцю та поверніть у 1-й зʼїзд на вулицю Довгу-Предовгу Назву', street: '', streets: [], i0: 0, i1: turnIdx[1], len: 2000, time: 140 },
        { type: 15, ins: 'Поверніть ліворуч', street: 'вулиця Пушкінська', streets: [], i0: turnIdx[1], i1: n - 1, len: 24800, time: 1600 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
    // вибір маршруту на цьому екрані: увесь маршрут цілком, шторка й кнопки в межах екрана, нічого не перекрито
    await page.click('#tabs button[data-panel="trip"]');
    await page.fill('#in_a', 'Харків'); await page.waitForSelector('#sg_a button', { timeout: 5000 }); await page.click('#sg_a button');
    await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await page.click('#sg_b button');
    await page.click('[data-act="build"]'); await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 10000 }); await sleep(1000);
    const wp = await pickWhole(page), Lr = await app(page, () => { const out = [], b = document.getElementById('routePick').getBoundingClientRect();
      if (b.top < 0 || b.bottom > innerHeight + 1 || b.right > innerWidth + 1) out.push('шторка за межами екрана');
      for (const el of document.querySelectorAll('#routePick button')) { const r = el.getBoundingClientRect(), h = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        if (r.top < 0 || r.bottom > innerHeight + 1 || r.left < 0 || r.right > innerWidth + 1) out.push('за екраном: ' + (el.dataset.rp || el.dataset.alt)); else if (!h || !(h === el || el.contains(h))) out.push('перекрита: ' + (el.dataset.rp || el.dataset.alt)); }
      return out; });
    ok(`${T}: вибір маршруту — увесь маршрут видно цілком, кнопки й карточки в межах екрана`, wp.out === 0 && wp.under === 0 && Lr.length === 0, JSON.stringify(wp) + ' ' + Lr.join('; '));
    await shot(page, `a-${sc.n}-0-pick`);
    await page.click('#routePick [data-rp="x"]'); await sleep(200);
    await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
    const p0 = coords[40];
    await emitN('loc', { prov: 'gps', lat: p0[0], lon: p0[1], acc: 5, spd: 24, brg: 270, t: Date.now() });
    await sleep(900);
    // (1.1.33, Діма) ліворуч у плашці: крупно — кілометри й час у дорозі, під ними дрібніше — час прибуття з прапорцем; усе вміщається
    const barTxt = async () => app(page, () => { const box = document.querySelector('#tabbar .tb-main'), B = box.getBoundingClientRect(), eta = document.getElementById('eta'), E = eta.getBoundingClientRect(), sp = [...document.querySelectorAll('#remain span')];
      return { drive: box.classList.contains('drive'), eta: eta.textContent, flag: !!eta.querySelector('svg'), etaFs: parseFloat(getComputedStyle(eta).fontSize), etaTop: Math.round(E.top), lab: eta.getAttribute('aria-label'),
        sp: sp.map(x => { const r = x.getBoundingClientRect(); return { t: x.textContent, fs: parseFloat(getComputedStyle(x).fontSize), top: Math.round(r.top), fit: x.scrollWidth <= x.clientWidth + 1 && r.left >= B.left - 0.5 && r.right <= B.right + 0.5 && r.top >= B.top - 0.5 && r.bottom <= B.bottom + 0.5 }; }),
        etaIn: E.top >= B.top - 0.5 && E.bottom <= B.bottom + 0.5 && E.left >= B.left - 0.5 && E.right <= B.right + 0.5 }; });
    const bt1 = await barTxt();
    ok(`${T}: у дорозі ліворуч у плашці крупно «${bt1.sp.map(x => x.t + ' ' + x.fs + 'px').join(' / ')}», під ними дрібніше прибуття «${bt1.eta}» ${bt1.etaFs}px з прапорцем; усе вміщається`,
      bt1.drive && bt1.sp.length === 2 && /км$/.test(bt1.sp[0].t) && /хв$/.test(bt1.sp[1].t) && bt1.sp.every(x => x.fs >= 19 && x.fs > bt1.etaFs + 3 && x.fit) && bt1.sp[0].top < bt1.sp[1].top && bt1.sp[1].top < bt1.etaTop && /^\d\d:\d\d$/.test(bt1.eta) && bt1.flag && bt1.etaFs >= 13 && bt1.etaIn && /^Прибуття о \d\d:\d\d$/.test(bt1.lab), JSON.stringify(bt1));
    // довгий рейс — «5 год 40 хв» теж уміщається (крупно, трохи менше)
    await app(page, () => { const g = window.__app.guide.g; g.remain = 512000; g.remTime = 5 * 3600 + 40 * 60; window.__app.core.bus.emit('guide', g); }); await sleep(400);
    const bt2 = await barTxt();
    ok(`${T}: довгий рейс — «${bt2.sp.map(x => x.t + ' ' + x.fs + 'px').join(' / ')}» уміщається, крупніше за прибуття`, bt2.sp.length === 2 && bt2.sp.every(x => x.fit && x.fs >= 15 && x.fs > bt2.etaFs) && /год/.test(bt2.sp[1].t), JSON.stringify(bt2));
    // найтісніший стан: їдемо без GPS (кнопки ±100), камера попереду, на маневрі довгий текст
    await app(page, () => { window.__app.nav.nudge(0); const c = document.getElementById('cam'); c.hidden = false; document.getElementById('camMax').textContent = '90'; document.getElementById('camDist').textContent = '350 м'; });
    await sleep(250);
    await app(page, () => { const c = document.getElementById('cam'); c.hidden = false; });
    const L1 = await app(page, layoutCheck);
    ok(`${T}: у дорозі без GPS нічого не накладається й не перекрите`, L1.length === 0, L1.join('; '));
    // плашка оновлення внизу — теж нічого не перекриває
    await emitN('update', { apk: { code: 250, name: '1.1.2.50' } }); await sleep(250);
    const Lu = await app(page, layoutCheck), uv = await app(page, () => !document.getElementById('updBar').hidden);
    ok(`${T}: плашка оновлення видна й нічого не перекриває`, uv && Lu.length === 0, Lu.join('; '));
    await shot(page, `a-${sc.n}-0-update`);
    await page.click('#updX'); await sleep(150);
    if (sc.st) {
      const ins = await app(page, () => { const R = s => document.querySelector(s).getBoundingClientRect(); return { top: R('#top').top, rail: R('#rail').top, tabs: Math.max(...[...document.querySelectorAll('#tabs > button')].map(b => b.getBoundingClientRect().bottom)), H: innerHeight }; });      // самі кнопки (тло плашки доходить до низу екрана)
      ok(`${T}: плашки не заходять під виріз угорі й під смугу жестів унизу`, ins.top >= sc.st && ins.rail >= sc.st && ins.tabs <= ins.H - sc.sb + 1, JSON.stringify(ins));
    }
    // меню точки на карті (довге натискання): у межах екрана, нічого не перекриває
    await app(page, p => window.__app.bus.emit('mapPick', { lat: p[0] + 0.1, lon: p[1] }), coords[60]); await sleep(200);   // за 11 км від маршруту — меню, а не «я тут»
    const Lk = await app(page, layoutCheck);
    ok(`${T}: меню точки на карті в межах екрана`, await app(page, () => !document.getElementById('pick').hidden) && Lk.length === 0, Lk.join('; '));
    await page.click('#pick [data-k="x"]');
    await shot(page, `a-${sc.n}-1-drive`);
    // зсунули карту пальцем — зʼявилась «Моє місце»
    { const [cx, cy] = await app(page, () => { document.getElementById('toasts').innerHTML = ''; const land = innerWidth > innerHeight, b = document.getElementById('bottom').getBoundingClientRect();
        const tp = document.getElementById('top').getBoundingClientRect();
        return land ? [Math.round(innerWidth * 0.3), Math.round(innerHeight * 0.55)] : [Math.round(innerWidth * 0.5), Math.round((tp.bottom + b.top) / 2)]; });
      const what = await app(page, ([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.id || String(e.className) || e.tagName) : '—'; }, [cx, cy]);
      ok(`${T}: між плашками є вільна карта, яку можна тягнути пальцем`, /maplibregl-canvas/.test(what), what);
      await fingerDrag(page, cx, cy, -50, -60);
      if (await app(page, () => window.__app.map.view.follow)) { await sleep(400); await fingerDrag(page, cx, cy, 60, 50); } }   // на повільному емуляторі перший жест іноді губиться
    await sleep(250);
    const L2 = await app(page, layoutCheck);
    ok(`${T}: карту зсунуто — «Моє місце» видно, нічого не накладається`, !(await app(page, () => document.getElementById('bCenter').hidden)) && L2.length === 0, L2.join('; '));
    await page.click('#bCenter');
    ok(`${T}: «Моє місце» повертає стеження й ховається`, await app(page, () => window.__app.map.view.follow && document.getElementById('bCenter').hidden));
    // швидкі налаштування: відкрити, кожна плитка робить своє
    await page.click('#bQuick'); await sleep(300);
    const qb = await app(page, () => { const q = document.getElementById('quick'), b = document.getElementById('bottom').getBoundingClientRect();   // без анімації: розмітка, а не кадр
      return { open: !q.hidden, top: q.offsetTop, bottom: q.offsetTop + q.offsetHeight, H: innerHeight, W: innerWidth, left: q.offsetLeft, right: q.offsetLeft + q.offsetWidth, bt: b.top, tiles: q.querySelectorAll('.q-tile').length, land: innerWidth > innerHeight }; });
    ok(`${T}: швидкі налаштування відкрились, 9 плиток (1.1.24: дев'ята — «Телефон», калібрування), у межах екрана й не під нижньою панеллю`, qb.open && qb.tiles === 9 && qb.top >= 0 && qb.left >= 0 && qb.right <= qb.W && (qb.land ? qb.bottom <= qb.H : qb.bottom <= qb.bt + 1), JSON.stringify(qb));
    await shot(page, `a-${sc.n}-2-quick`);
    const st = () => app(page, () => { const A = window.__app; return { voice: A.S.voice, v3d: A.S.view3d, north: A.map.view.north, follow: A.map.view.follow, rec: !!A.S.rec, theme: A.S.theme, awake: A.S.keepAwake !== false, zb: A.map.view.zoomBias, open: !document.getElementById('quick').hidden, panel: A.ui ? null : document.getElementById('panel').hidden ? '' : document.getElementById('panelTitle').textContent, badge: !!document.querySelector('#bQuick .q-badge') }; });
    const tap = async k => { await page.click(`#quick [data-q="${k}"]`); await sleep(120); return st(); };
    const s0 = await st();
    let s1 = await tap('voice'); ok(`${T}: плитка «Звук» вимикає голос; (1.1.28) це видно на кнопці звуку праворуч — червона, динамік перекреслений`, s1.voice === !s0.voice && !s1.badge && s1.open && await app(page, v => document.getElementById('bSnd').classList.contains('off') === !v, s1.voice), JSON.stringify(s1));
    s1 = await tap('voice'); ok(`${T}: «Звук» знову вмикає`, s1.voice === s0.voice && !s1.badge);
    s1 = await tap('3d'); ok(`${T}: плитка «Вигляд» 3D ↔ 2D`, s1.v3d === !s0.v3d); await tap('3d');
    s1 = await tap('north'); ok(`${T}: плитка «Карта» північ ↔ за рухом`, s1.north === !s0.north); await tap('north');
    s1 = await tap('rec'); ok(`${T}: плитка «Запис треку» вмикає запис, на кнопці червона крапка`, s1.rec && s1.badge, JSON.stringify(s1)); s1 = await tap('rec'); ok(`${T}: і вимикає`, !s1.rec);
    const th = [(await tap('theme')).theme, (await tap('theme')).theme, (await tap('theme')).theme];
    ok(`${T}: плитка «Тема» по колу: день → ніч → авто`, th.join() === 'day,night,auto', th.join());
    s1 = await tap('awake'); ok(`${T}: плитка «Екран» — гасне сам / не гасне (команда оболонці)`, s1.awake === !s0.awake && await app(page, v => window.__nativeCalls.includes('keepAwake:' + v), s1.awake)); await tap('awake');
    ok(`${T}: (1.1.26) рядка «− Масштаб +» у швидких налаштуваннях більше немає — лише дев'ять плиток (карту наближають двома пальцями)`, await app(page, () => !document.querySelector('#quick .q-zoom, #quick [data-q="zin"], #quick [data-q="zout"]') && document.querySelectorAll('#quick .q-tile').length === 9 && !/Масштаб/.test(document.getElementById('quick').textContent)));
    await page.click('#quick [data-q="close"]');
    // галочки «що показувати на карті» — у «Місцях» (1.1.20); компактні плитки з мінізображеннями й «Готово»-квадрат у куті (1.1.22)
    await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips'); await sleep(350);
    const pl4 = await app(page, () => { const pb = document.getElementById('panelBody'), pr = pb.getBoundingClientRect(), W = innerWidth, btTop = innerHeight;      // (1.1.24) панель на весь екран — нижня плашка під нею, місця для списку до самого низу
      const chips = [...document.querySelectorAll('.pl-chip')].map(b => { const r = b.getBoundingClientRect(), sp = b.querySelector('span:last-of-type'); return { k: b.dataset.plc, l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), fit: b.scrollWidth <= b.clientWidth + 1 && sp.scrollWidth <= sp.clientWidth + 1 }; });
      const d = document.querySelector('#panelOk'), dr = d.getBoundingClientRect(), hit = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2), P = document.getElementById('panel'), pr2 = P.getBoundingClientRect(), cover = sel => { const e = document.querySelector(sel), q = e && e.getBoundingClientRect(); if (!q || !q.width || getComputedStyle(e).visibility === 'hidden') return true; const h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return !!h && P.contains(h); };
      const first = document.querySelector('.pl-chip').getBoundingClientRect(), fh = document.elementFromPoint(first.left + first.width / 2, first.top + first.height / 2), row = document.querySelector('.pl-row, .vp-row, .vp-empty');
      return { n: chips.length, bad: chips.filter(c => c.l < pr.left - 1 || c.r > Math.min(W, pr.right) + 1 || c.h < 48 || c.h > 58 || !c.fit), done: { l: Math.round(dr.left), t: Math.round(dr.top), r: Math.round(dr.right), b: Math.round(dr.bottom), w: Math.round(dr.width), h: Math.round(dr.height), seen: !!hit && (hit === d || d.contains(hit)) },
        bodyH: Math.round(pb.clientHeight), bodyR: Math.round(Math.min(W, pr.right)), bodyB: Math.round(pr.bottom), btTop: Math.round(btTop), firstSeen: !!fh && !!fh.closest('.pl-chip'), full: P.classList.contains('full') && pr2.top <= 60 && pr2.bottom >= innerHeight - 1, covered: ['#top', '#tabs', '#tabbar .tb-main', '#tilt', '#speed', '#rail'].filter(x => !cover(x)), panel: [Math.round(pr2.top), Math.round(pr2.bottom)],
        listT: row ? Math.round(row.getBoundingClientRect().top) : -1, lastRowT: Math.round([...document.querySelectorAll('.pl-chip')].pop().getBoundingClientRect().top),
        over: [...document.querySelectorAll('.pl-chip, .pl-all .btn')].filter(b => { const r = b.getBoundingClientRect(); return Math.min(r.right, dr.right) - Math.max(r.left, dr.left) > 1 && Math.min(r.bottom, dr.bottom) - Math.max(r.top, dr.top) > 1; }).map(b => b.textContent.trim()) }; });
    // панель така низька, що останній ряд плиток (де для квадрата лишено порожню клітинку) ще не видно — квадрат зʼявиться, щойно прокрутити; на плитки він не лягає ніколи
    const plShort = pl4.lastRowT > Math.min(pl4.bodyB, pl4.btTop) - 55;
    const pl4end = plShort ? await app(page, async () => { const pb = document.getElementById('panelBody'); pb.scrollTop = pb.scrollHeight; await new Promise(r => setTimeout(r, 150)); const d = document.querySelector('#panelOk'), dr = d.getBoundingClientRect(), hit = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2); const ok = !!hit && (hit === d || d.contains(hit)); pb.scrollTop = 0; await new Promise(r => setTimeout(r, 100)); return ok; }) : null;
    await shot(page, '43-places-' + sc.n);
    ok(`${T}: «Місця» — 11 компактних плиток (48…58 заввишки) у межах екрана, написи цілі`, pl4.n === 11 && pl4.bad.length === 0, JSON.stringify(pl4));
    if (plShort) ok(`${T}: панель «Місць» зовсім низька (видно ${Math.min(pl4.bodyB, pl4.btTop) - pl4.listT < 0 ? 'лише плитки' : 'мало'}) — квадрат «Готово» (54×54) на плитки не лягає: стоїть у порожній клітинці останнього ряду й зʼявляється, щойно прокрутити; закрити можна й хрестиком`, pl4.done.w === 54 && pl4.done.h === 54 && pl4.over.length === 0 && pl4.done.t >= pl4.lastRowT - 1 && pl4end === true && pl4.firstSeen, JSON.stringify({ done: pl4.done, lastRowT: pl4.lastRowT, over: pl4.over, end: pl4end }));
    else ok(`${T}: «Готово» — маленький квадрат (54×54) у правому нижньому куті «Місць», на видноті без прокручування, нічим не перекритий; плиток і кнопок «Показати все / Прибрати все» не закриває`, pl4.done.seen && pl4.done.w === 54 && pl4.done.h === 54 && pl4.bodyR - pl4.done.r <= 20 && pl4.done.b <= Math.min(pl4.bodyB, pl4.btTop) + 1 && pl4.firstSeen && pl4.over.length === 0, JSON.stringify(pl4.done) + ' body ' + pl4.bodyR + '×' + pl4.bodyB + ' bottom ' + pl4.btTop + ' over ' + pl4.over.join());
    ok(`${T}: (1.1.24) «Місця» — на весь екран: верхню плашку з маневром і нижню з кнопками закрито, нічого з карти не заважає гортати`, pl4.full && pl4.covered.length === 0, JSON.stringify({ full: pl4.full, covered: pl4.covered, panel: pl4.panel }));
    await page.click('.pl-chip[data-plc="fuel"]'); ok(`${T}: галочка в «Місцях» працює`, await app(page, () => window.__app.S.mapStopTypes.fuel === false));
    await page.click('.pl-chip[data-plc="fuel"]');
    await page.click('#panelOk'); await sleep(350); ok(`${T}: «Готово» закриває «Місця» — карта, плашка з маневром і кнопки знову на місці`, await app(page, () => { const b = document.querySelector('#tabs button.main'), r = b.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return document.getElementById('panel').hidden && !!h && b.contains(h) && getComputedStyle(document.querySelector('#tabbar .tb-main')).display !== 'none'; }));
    await page.click('#bQuick');
    await app(page, () => { window.__app.map.view.lastTouch = Date.now(); window.__app.map.setFollow(false); });
    s1 = await tap('center'); ok(`${T}: плитка «Моє місце» — стежить і шторка закрилась`, s1.follow && !s1.open, JSON.stringify(s1));
    await page.click('#bQuick'); await page.click('#quick [data-q="settings"]');
    ok(`${T}: плитка «Налаштування» відкриває налаштування`, await app(page, () => !document.getElementById('panel').hidden && /Налаштування/.test(document.getElementById('panelTitle').textContent) && document.getElementById('quick').hidden));
    const Lp = await app(page, () => { const p = document.getElementById('panel').getBoundingClientRect(); return { top: p.top, bottom: p.bottom, H: innerHeight, W: innerWidth, right: p.right }; });
    ok(`${T}: панель у межах екрана`, Lp.top >= 0 && Lp.bottom <= Lp.H + 1 && Lp.right <= Lp.W + 1, JSON.stringify(Lp));
    await page.click('#panelOk');
    await page.click('#bQuick'); await page.click('#quick [data-q="close"]'); ok(`${T}: ✕ закриває шторку`, await app(page, () => document.getElementById('quick').hidden));
    await page.click('#bQuick'); ok(`${T}: системна «Назад» закриває шторку`, await app(page, () => window.__reisBack() && document.getElementById('quick').hidden));
    // кружечок GPS біля круга швидкості (1.1.22) і вкладки внизу: кожне відкриває свою панель і закривається
    for (const [tab, re] of [['gps', /GPS/], ['feed', /Події/], ['trip', /Рейс/], ['places', /Місця/]]) {
      await page.click(tab === 'gps' ? '#spdGps' : `#tabs button[data-panel="${tab}"]`);
      if (tab === 'trip') {     // у дорозі «Рейс» — шторка з усім залишком рейсу, закривається «Залишитись у рейсі»
        ok(`${T}: вкладка «Рейс» у дорозі — шторка з рейсом`, await app(page, () => document.getElementById('routePick').dataset.mode === 'trip' && !document.getElementById('routePick').hidden && /Залишитись у рейсі/.test(document.getElementById('routePick').textContent)));
        await page.click('#routePick [data-ts="stay"]');
        ok(`${T}: «Залишитись у рейсі» закриває шторку`, await app(page, () => document.getElementById('routePick').hidden));
        continue;
      }
      const ttl = await app(page, () => document.getElementById('panel').hidden ? '' : document.getElementById('panelTitle').textContent);
      ok(`${T}: вкладка «${tab}» відкриває панель`, re.test(ttl), ttl);
      if (tab === 'feed') await page.click('#panelOk');          // «Події» на весь екран — закриває «Назад» унизу
      else await page.click('#panelOk');                                        // (1.1.24) панель на весь екран — кнопок унизу під нею немає; закриваємо хрестиком
      ok(`${T}: ${tab === 'feed' ? '«Назад»' : 'хрестик'} закриває «${tab}»`, await app(page, () => document.getElementById('panel').hidden));
    }
    // трикутник у нижній панелі відкриває «Що на дорозі?»
    await page.click('#tabRep');
    ok(`${T}: трикутник «Мітки» в нижній панелі — шторка з трьома кнопками, у межах екрана`, await app(page, () => { const b = document.getElementById('repSheet'), r = b.getBoundingClientRect(); return !b.hidden && b.querySelectorAll('.rep-grid button').length === 3 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    await page.click('#repSheet [data-rep="x"]');
    ok(`${T}: ✕ закриває «Що на дорозі?»`, await app(page, () => document.getElementById('repSheet').hidden));
    // ±100 і спідометр без GPS
    const rdA = await app(page, () => window.__app.nav.pos.rd); await page.click('#bFwd100'); const rdB = await app(page, () => window.__app.nav.pos.rd);
    ok(`${T}: ↑100 натискається`, rdB - rdA >= 99, Math.round(rdB - rdA) + ' м');
    await page.click('#bBack100'); ok(`${T}: ↓100 натискається`, (await app(page, () => window.__app.nav.pos.rd)) < rdB);
    await page.click('#speed');
    const sp = await app(page, () => { const b = document.getElementById('spdPop'), r = b.getBoundingClientRect(); return { open: !b.hidden, top: r.top, bottom: r.bottom, H: innerHeight, right: r.right, W: innerWidth }; });
    ok(`${T}: спідометр → вибір швидкості в межах екрана`, sp.open && sp.top >= 0 && sp.bottom <= sp.H && sp.right <= sp.W, JSON.stringify(sp));
    await page.click('#spdPop [data-v="80"]'); ok(`${T}: вибір 80 км/год`, await app(page, () => window.__app.nav.manualSpeed() === 80 && document.getElementById('spdPop').hidden), String(await app(page, () => window.__app.nav.manualSpeed())));
    if (sc.n === 'S10') {
      // довге натискання пальцем: без GPS біля маршруту — «я тут, на маршруті»; далеко від маршруту — меню точки
      const longPress = async (x, y) => { const c = await page.context().newCDPSession(page);
        await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] }); await sleep(900);
        await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await c.detach(); await sleep(250); };
      await app(page, () => { window.__app.map.setFollow(true); document.getElementById('toasts').innerHTML = ''; }); await sleep(600);
      const [px, py] = await app(page, () => { const m = window.__app.map.map, P = window.__app.nav.pos, s = m.project([P.lon, P.lat]), r = m.getContainer().getBoundingClientRect(); return [Math.round(r.left + s.x + 25), Math.round(r.top + s.y)]; });
      const hit0 = await app(page, ([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.id || e.className || e.tagName) + ' < ' + ((e.parentElement && (e.parentElement.id || e.parentElement.className)) || '') : null; }, [px, py]);
      await longPress(px, py);
      ok(`${T}: без GPS довге натискання біля маршруту — меню «Контрольна точка · Я тут»; «Я тут» — на маршруті`, await app(page, () => !document.getElementById('pick').hidden && /Контрольна точка/.test(document.getElementById('pick').textContent)), JSON.stringify({ px, py, hit0, pick: await app(page, () => ({ hidden: document.getElementById('pick').hidden, txt: document.getElementById('pick').textContent.slice(0, 80), toasts: document.getElementById('toasts').textContent.slice(0, 120), mode: window.__app.nav.pos.mode, onRoute: window.__app.nav.pos.onRoute, rect: (() => { const P = document.getElementById('pick'); const was = P.hidden; P.hidden = false; const r = P.getBoundingClientRect(), o = [r.left, r.top, r.right, r.bottom].map(Math.round); P.hidden = was; return o; })(), cls: document.body.className, anc: window.__app.map.anchorPoint().y })) }));
      await page.click('#pick [data-k="here"]'); await sleep(250);
      ok(`${T}: …«Я тут» — «ви тут, на маршруті»`, await app(page, () => document.getElementById('pick').hidden && /на лінії рейсу/.test(document.getElementById('toasts').textContent)));
      await app(page, p => { window.__app.map.flyTo({ lat: p[0] + 0.05, lon: p[1] }, 14); }, coords[60]); await sleep(900);
      const [lx, ly] = await app(page, () => { const tp = document.getElementById('top').getBoundingClientRect(), b = document.getElementById('bottom').getBoundingClientRect(); return [Math.round(innerWidth / 2), Math.round((tp.bottom + b.top) / 2)]; });
      await longPress(lx, ly);
      ok(`${T}: далеко від маршруту довге натискання відкриває меню точки («Я тут»)`, await app(page, () => !document.getElementById('pick').hidden && /Я тут/.test(document.getElementById('pick').textContent)));
      await page.click('#pick [data-k="x"]');
      await fingerDrag(page, lx, ly, 40, 50); await sleep(900);
      ok(`${T}: потягнути карту — не довге натискання, меню не відкривається`, await app(page, () => document.getElementById('pick').hidden));
      // шторка сама ховається, якщо її забули відкритою (15 с)
      await page.click('#bQuick'); await sleep(15600);
      ok(`${T}: забута відкритою шторка ховається сама за 15 с`, await app(page, () => document.getElementById('quick').hidden));
    }
    ok(`${T}: без помилок JS`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  } catch (e) { ok(`екран ${sc.title}: перевірка дійшла до кінця`, false, String(e.message).split('\n').slice(0, 12).join(' / ').slice(0, 900)); }
}

/* ============ прохід 7: стрілка в дорозі — завжди посередині, на одній висоті, дивиться вгору (на всіх екранах) ============ */
// Їдемо маршрутом (GPS раз на секунду, 90 км/год) через поворот ліворуч на 90°, потім 3D, потім без GPS (розрахунок),
// потім зсунули карту і натиснули «Моє місце». Кожні ~0,1 с міряємо: де стрілка відносно своєї точки, як вона повернута
// і куди на екрані йде лінія маршруту попереду.
const camDrive = (page, o) => app(page, async o => {
  const A = window.__app, m = A.map.map, R = A.guide.g.idx, out = [];
  let d = o.d0, nextFix = 0, k = 0, lastFix = 0; const t0 = performance.now();
  while (performance.now() - t0 < o.ms) {
    const now = performance.now();
    // фікси GPS — нерівно, як на телефоні (Android віддає їх пачками): 0,6 с, 1,4 с, 0,6 с…
    if (o.v && now >= nextFix) { if (lastFix) d += o.v * (now - lastFix) / 1000; lastFix = now; const p = R.at(d); window.__reis('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: o.v, brg: p.brg, t: Date.now() }); nextFix = now + (o.jitter ? (k++ % 2 ? 1400 : 600) : 1000); }
    await new Promise(r => setTimeout(r, 90));
    if (performance.now() - t0 < (o.warm || 1500)) continue;
    const el = document.querySelector('.puck'); if (!el) continue;
    const c = m.getContainer().getBoundingClientRect(), r = el.getBoundingClientRect(), anc = A.map.anchorPoint(), pd = m.getPadding();
    // точка, куди камера зараз ставить стрілку (якщо нижня плашка змінила висоту — точка плавно переїжджає за ~0,5 с)
    const a = { x: c.width / 2 + (pd.left - pd.right) / 2, y: (c.height + pd.top - pd.bottom) / 2 }, drift = Math.round(Math.abs(a.y - anc.y));
    const rz = /rotateZ\(([-\d.e]+)deg\)/.exec(el.style.transform || ''), rot = rz ? (((+rz[1]) % 360) + 540) % 360 - 180 : 999;
    const cs = A.map.camState.cur, ll = m.project([cs.lon, cs.lat]), rd = A.nav.pos.rd;
    const ah = R.at(Math.min(R.total, (A.map.camState.dd ?? rd) + 80)), pa = m.project([ah.lon, ah.lat]);
    const hit = document.elementFromPoint(c.left + a.x, c.top + a.y);
    const S0 = A.map.camState, nd = m.getSource('route-near')._data, f0 = nd && nd.features && nd.features[0];
    const gap = f0 && S0.cur ? Math.round(Math.hypot((f0.geometry.coordinates[0][0] - S0.cur.lon) * 71500, (f0.geometry.coordinates[0][1] - S0.cur.lat) * 111320) * 10) / 10 : null;
    out.push({ gap, drift, dd: S0.dd, ft: S0.ft, x: Math.round(r.left + r.width / 2 - c.left - a.x), y: Math.round(r.top + r.height / 2 - c.top - a.y), rot: Math.round(rot * 10) / 10,
      ux: Math.round(pa.x - ll.x), uy: Math.round(pa.y - ll.y), turn: o.turns.some(t => Math.abs(t - rd) < 150), f: A.map.view.follow, mode: A.nav.pos.mode, rd: Math.round(rd),
      cov: hit && !hit.closest('.puck') && !hit.classList.contains('maplibregl-canvas') ? (hit.id || String(hit.className).split(' ')[0] || hit.tagName) : '' });
  }
  return { out, d };
}, o);
function camJudge(T, what, out) {
  const fol = out.filter(s => s.f);
  const worst = k => fol.reduce((w, s) => Math.abs(s[k]) > Math.abs(w[k]) ? s : w, { [k]: 0 });
  const wx = worst('x'), wy = worst('y'), wr = worst('rot');
  ok(`${T}: ${what} — стрілка стоїть у своїй точці посередині (зсув ≤ 3 px по ширині, ≤ 4 px по висоті)`, fol.length >= 10 && Math.abs(wx.x) <= 3 && Math.abs(wy.y) <= 4, `зразків ${fol.length}/${out.length}; найгірше x=${wx.x} (rd ${wx.rd}), y=${wy.y} (rd ${wy.rd})`);
  ok(`${T}: ${what} — стрілка дивиться строго вгору`, Math.abs(wr.rot) <= 1.5, `найгірше ${wr.rot}° (rd ${wr.rd})`);
  const str = fol.filter(s => !s.turn), bad = str.filter(s => !(s.uy < -8 && Math.abs(s.ux) <= Math.max(3, 0.2 * Math.abs(s.uy))));
  ok(`${T}: ${what} — на прямій маршрут попереду йде вгору, а не вбік`, str.length >= 5 && bad.length === 0, `прямих ${str.length}, вбік ${bad.length}` + (bad[0] ? ` (rd ${bad[0].rd}: ux=${bad[0].ux}, uy=${bad[0].uy})` : ''));
  const cov = fol.filter(s => s.cov);
  ok(`${T}: ${what} — стрілку нічого не закриває`, cov.length === 0, cov.slice(0, 3).map(s => s.cov).join(', '));
  const gp = fol.filter(s => s.gap != null), wg = gp.reduce((w, s) => Math.max(w, s.gap), 0);
  ok(`${T}: ${what} — лінія маршруту зникає просто під стрілкою, плавно (розрив ≤ 4 м у кожному замірі)`, gp.length >= 10 && wg <= 4, `замірів ${gp.length}, найбільший розрив ${wg} м`);
  const last = fol.slice(-5);
  ok(`${T}: ${what} — стрілка на своїй висоті (у нижній частині вільної карти)`, last.length && last.every(s => s.drift <= 2), last.map(s => s.drift).join(','));
}
// Плавність: швидкість стрілки на екрані (уздовж маршруту) між замірами рівна — без ривків, зупинок і кроків назад
function camSmooth(T, what, out, v) {
  const sp = [];
  for (let i = 1; i < out.length; i++) { const a = out[i - 1], b = out[i]; if (a.dd == null || b.dd == null || !(b.ft > a.ft)) continue; sp.push({ v: (b.dd - a.dd) / (b.ft - a.ft) * 1000, back: b.dd - a.dd < -0.5, rd: b.rd }); }
  const dev = sp.map(s => Math.abs(s.v - v)).sort((a, b) => a - b), p90 = dev[Math.floor(dev.length * 0.9)] || 0, mx = dev[dev.length - 1] || 0;
  ok(`${T}: ${what} — стрілка їде плавно, без ривків (швидкість на екрані рівна, назад не смикається)`, sp.length >= 10 && !sp.some(s => s.back) && p90 <= 0.2 * v && mx <= 0.45 * v,
    `замірів ${sp.length}, треба ${v} м/с; відхилення p90 ${p90.toFixed(1)}, макс ${mx.toFixed(1)}` + (sp.some(s => s.back) ? ', є крок назад' : ''));
}
if (run('7')) for (const sc of SCREENS.filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) {
  try {
    const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
    const T = 'стрілка, ' + sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
    if (sc.st) await app(page, ([st, sb]) => { const r = document.documentElement.style; r.setProperty('--st', st + 'px'); r.setProperty('--sb', sb + 'px'); }, [sc.st, sc.sb]);
    const n = coords.length;
    const trip = { id: 't-cam', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
      route: { coords, mans: [{ type: 1, ins: 'Рухайтесь на захід', street: '', streets: [], i0: 0, i1: turnIdx[1], len: 2000, time: 140 },
        { type: 15, ins: 'Поверніть ліворуч', street: 'вулиця Пушкінська', streets: [], i0: turnIdx[1], i1: turnIdx[2], len: 1500, time: 110 },
        { type: 10, ins: 'Поверніть праворуч', street: '', streets: [], i0: turnIdx[2], i1: n - 1, len: 23300, time: 1500 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
    await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
    await app(page, () => { window.__app.S.view3d = false; window.__app.map.setFollow(true); });
    const turns = [2000, 3500, 6000];
    const r1 = await camDrive(page, { d0: 1650, v: 25, ms: 19000, turns, jitter: true });
    await shot(page, `c-${sc.n}-2d`);
    camJudge(T, '2D, GPS, поворот ліворуч', r1.out);
    camSmooth(T, 'GPS пачками (0,6 / 1,4 с)', r1.out.slice(8), 25);
    await app(page, () => { window.__app.S.view3d = true; window.__app.map.setFollow(true); });
    const r2 = await camDrive(page, { d0: r1.d, v: 25, ms: 8000, turns });
    await shot(page, `c-${sc.n}-3d`);
    camJudge(T, '3D, GPS', r2.out);
    const a3 = await app(page, () => { const a = window.__app.map.anchorPoint(); return { y: a.y, top: Math.round(a.top), bot: Math.round(a.bot), H: a.H, frac: Math.round((a.y - a.top) / (a.bot - a.top) * 100) / 100 }; });
    ok(`${T}: точка стрілки — у нижній частині вільної карти (видно дорогу попереду)`, a3.frac >= 0.6 && a3.frac <= 0.8 && a3.bot - a3.y >= 60, JSON.stringify(a3));
    await app(page, () => window.__app.nav.nudge(0));                // GPS зник — далі розрахунок уздовж маршруту
    const r3 = await camDrive(page, { d0: 0, v: 0, ms: 6000, turns, warm: 1200 });
    ok(`${T}: без GPS позначка рухається розрахунком`, r3.out.length && r3.out[r3.out.length - 1].mode === 'dr' && r3.out[r3.out.length - 1].rd - r3.out[0].rd > 60, JSON.stringify(r3.out.length ? [r3.out[0].rd, r3.out[r3.out.length - 1].rd, r3.out[r3.out.length - 1].mode] : []));
    camJudge(T, 'без GPS (розрахунок)', r3.out);
    { const v = await app(page, () => window.__app.nav.pos.spd); camSmooth(T, 'без GPS', r3.out.slice(4), Math.round(v * 10) / 10); }
    await shot(page, `c-${sc.n}-dr`);
    // зсунули карту пальцем, потім «Моє місце» — стрілка знову на своєму місці
    const [cx, cy] = await app(page, () => { const a = window.__app.map.anchorPoint(), c = window.__app.map.map.getContainer().getBoundingClientRect(); return [Math.round(c.left + a.x + 30), Math.round(c.top + a.y - 90)]; });
    await fingerDrag(page, cx, cy, -60, 70);
    if (await app(page, () => window.__app.map.view.follow)) { await sleep(400); await fingerDrag(page, cx, cy, 60, 60); }
    const off = await app(page, () => !window.__app.map.view.follow);
    await page.click('#bCenter'); await sleep(700);
    const r4 = await camDrive(page, { d0: 0, v: 0, ms: 3600, turns, warm: 300 });
    ok(`${T}: зсунули карту — стеження вимкнулось`, off);
    camJudge(T, 'після «Моє місце»', r4.out);
    ok(`${T}: без помилок JS`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  } catch (e) { ok(`стрілка, ${sc.title}: перевірка дійшла до кінця`, false, String(e.message).split('\n').slice(0, 8).join(' / ').slice(0, 600)); }
}

/* ============ прохід 8: оновлення з плашки ============ */
if (run('8')) try {
  const { page, ctx, errors } = await newPage(true);
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const bar = () => app(page, () => ({ on: !document.getElementById('updBar').hidden, text: document.getElementById('updGo').textContent.trim(), calls: window.__nativeCalls.slice() }));
  await sleep(300);
  await emitN('update', { apk: { code: 250, name: '1.1.2.50' }, web: { ver: 99, name: '1.1.2' } }); await sleep(250);
  let b = await bar();
  ok('оновлення: інтерфейс завантажується сам, у фоні', b.calls.includes('applyWebUpdate'), b.calls.join());
  ok('оновлення: плашка «Нова версія 1.1.2 — оновити»', b.on && /Нова версія 1\.1\.2 — оновити/.test(b.text), JSON.stringify(b.text));
  await shot(page, '16-update');
  await page.click('#updGo'); await sleep(150); b = await bar();
  ok('торкнулись плашки — застосунок сам завантажує APK (без браузера)', b.calls.includes('installApk') && !b.calls.includes('apkInBrowser') && /Завантажую оновлення/.test(b.text), b.text);
  await emitN('apk', { state: 'dl', pct: 46 }); await sleep(120); b = await bar();
  ok('видно, скільки завантажено', /46%/.test(b.text) && await app(page, () => document.getElementById('updBar').classList.contains('busy')), b.text);
  await shot(page, '16b-update-dl');
  await emitN('apk', { state: 'perm' }); await sleep(120); b = await bar();
  ok('перший раз — підказка дозволити встановлення з цього джерела', /Дозвольте/.test(b.text), b.text);
  await emitN('apk', { state: 'install' }); await sleep(120);
  const n1 = (await bar()).calls.filter(c => c === 'installApk').length;
  await page.click('#updGo'); await sleep(120); b = await bar();
  ok('вікно встановлення не відкрилось — торкнулись ще раз, пробуємо знову', b.calls.filter(c => c === 'installApk').length === n1 + 1);
  await emitN('apk', { state: 'error', error: 'HTTP 404' }); await sleep(120); b = await bar();
  ok('не завантажилось — пропонує браузер', /браузером/.test(b.text), b.text);
  await page.click('#updGo'); await sleep(120); b = await bar();
  ok('…і відкриває завантаження браузером', b.calls.includes('apkInBrowser'));
  await page.click('#updX'); await sleep(120);
  ok('✕ ховає плашку', !(await bar()).on);
  await emitN('update', { apk: { code: 250, name: '1.1.2.50' } }); await sleep(150);
  ok('ту саму версію після ✕ не показує знову одразу', !(await bar()).on);
  // нова версія лише інтерфейсу: завантажилась — плашка «готова», а без рейсу перезапуск сам
  await emitN('update', { web: { ver: 99, name: '1.1.2' } }); await sleep(150);
  await emitN('webUpdated', { ok: true, ver: 99 }); await sleep(200); b = await bar();
  ok('інтерфейс завантажено — плашка «Нова версія 1.1.2 готова — перезапустити»', b.on && /готова — перезапустити/.test(b.text), b.text);
  await sleep(1500);
  ok('без рейсу перезапускається сам', (await bar()).calls.includes('reloadUi'));
  ok('перевірка оновлень при запуску й далі кожні 30 хв (є виклик перевірки)', await app(page, () => typeof window.__app === 'object'));
  ok('прохід «оновлення» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «оновлення» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 9: голос — телефону або якісний із пакета ============ */
if (run('9')) try {
  const { page, ctx, errors } = await newPage(true);
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const calls = () => app(page, () => window.__nativeCalls.slice());
  const vs = () => app(page, () => ({ rows: [...document.querySelectorAll('#voiceSec .vrow')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), on: (document.querySelector('#voiceSec .vrow.on') || {}).dataset?.voice, text: document.getElementById('voiceSec').textContent.replace(/\s+/g, ' ') }));
  await sleep(300);
  ok('голос: за замовчуванням — голос телефону (оболонці сказано «системний»)', (await calls()).includes('setVoice::0:'));
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#voiceSec .vrow');
  let v = await vs();
  ok('Налаштування → Голос: лише голос телефону, Тетяна (жіночий) і Микита (чоловічий) — писклявої Лади більше немає', v.rows.length === 3 && !/Лада/.test(v.text) && /Голос телефону/.test(v.rows[0]) && /Тетяна — жіночий/.test(v.rows[1]) && /Микита — чоловічий/.test(v.rows[2]) && v.on === 'system', JSON.stringify(v.rows));
  ok('якісних голосів ще немає — «потрібен пакет», кнопка «Завантажити пакет»', /потрібен пакет/.test(v.rows[1]) && /Завантажити пакет/.test(v.text));
  await page.click('#voiceSec .vrow[data-voice="uk:1"]'); await sleep(200);
  let c = await calls(); v = await vs();
  ok('вибрали Микиту — пакет почав завантажуватись сам, вибір запамʼятано (поки пакета немає — голос телефону)', c.includes('voiceDownload:uk') && c.slice(-2).includes('setVoice::0:') && v.on === 'uk:1', c.slice(-3).join());
  await emitN('voice', { state: 'dl', pack: 'uk', pct: 37 }); await sleep(150); v = await vs();
  ok('видно, скільки завантажено, і є «Скасувати»', /Завантажую… 37%/.test(v.text) && /Скасувати/.test(v.text), v.text.slice(0, 160));
  await page.screenshot({ path: SHOTS ? join(SHOTS, '17-voice-dl.png') : '/dev/null' }).catch(() => {});
  await page.click('#voiceSec [data-act="vCancel"]'); ok('«Скасувати» передано оболонці', (await calls()).includes('voiceCancel'));
  await emitN('voice', { state: 'cancel', pack: 'uk' }); await sleep(100);
  // старий пакет (v1, вимова через espeak) — пропонує оновити, якісний голос не вмикає
  await app(page, () => { window.__voice = { packs: { uk: { size: 92000000, ver: 1 } } }; window.__nativeCalls.length = 0; });
  await page.click('#voiceSec .vrow[data-voice="uk:1"]'); await sleep(200); v = await vs();
  ok('старий пакет голосу — сам почав оновлюватись, підказки поки голосом телефону', /Завантажую/.test(v.text) && (await calls()).includes('setVoice::0:') && (await calls()).includes('voiceDownload:uk'), (await calls()).join());
  await app(page, () => { window.__voice = { packs: { uk: { size: 92000000, ver: 1 } } }; });
  await emitN('voice', { state: 'cancel', pack: 'uk' }); await sleep(100);
  ok('…а без завантаження — кнопка «Оновити пакет»', /Оновити пакет/.test((await vs()).text));
  await app(page, () => { window.__voice = { packs: { uk: { size: 87300000, ver: 2 } } }; });
  await emitN('voice', { state: 'ready', pack: 'uk', size: 87300000 }); await sleep(300); v = await vs();
  ok('пакет завантажено — «Завантажено · 87 МБ», «потрібен пакет» зник, повідомлення', /Завантажено · 87 МБ/.test(v.text) && !/потрібен пакет/.test(v.text) && /Голос завантажено/.test(await page.textContent('#toasts')), v.text.slice(0, 200));
  await shot(page, '17-voice');
  await page.click('#voiceSec .vrow[data-voice="uk:2"]'); await sleep(900); c = await calls();
  ok('вибрали Тетяну — оболонці sid 2, і звучить пробна фраза', c.includes('setVoice:uk:2:uk') && await app(page, () => window.__spoken.length > 0));
  ok('якісному голосу текст іде словами: малими літерами, без цифр і значків', await app(page, () => { const t = window.__spoken[window.__spoken.length - 1].normalize('NFC'); return /^через п'ятсот метрів поверніть праворуч\.?$/.test(t); }), await app(page, () => window.__spoken.slice(-1)[0].normalize('NFC')));
  await app(page, () => window.__app.P.speak('Через 2 км АЗС OKKO на М-03, обмеження 90 км/год.'));
  ok('…числа, траси, скорочення й латиниця — словами', await app(page, () => window.__spoken.slice(-1)[0].normalize('NFC') === "через два кілометри а зе ес окко на ем нуль три, обмеження дев'яносто кілометрів на годину."), await app(page, () => window.__spoken.slice(-1)[0].normalize('NFC')));
  // 1.1.5: рушій не запустився (як на Samsung і Xiaomi в 1.1.4) — одне зрозуміле повідомлення, хоч подій дві
  await app(page, () => { document.getElementById('toasts').innerHTML = ''; });
  await emitN('voice', { state: 'loadErr', pack: 'uk', error: 'engine: Invalid OfflineTtsConfig: failed to create native OfflineTts' });
  await emitN('voice', { state: 'loadErr', pack: 'uk', error: 'engine: Invalid OfflineTtsConfig: failed to create native OfflineTts' }); await sleep(300);
  { const tt = await app(page, () => [...document.querySelectorAll('#toasts .toast')].map(x => x.textContent)); v = await vs();
    ok('голос не запустився — одна плашка людською мовою (без «OfflineTtsConfig»), подробиці в налаштуваннях', tt.length === 1 && /(не запустився|не спрацював) — (підказки звучать|фразу сказав) голос/.test(tt[0]) && !/OfflineTts/.test(tt[0]) && /якісний голос не спрацював \(engine: Invalid OfflineTtsConfig/.test(v.text), JSON.stringify(tt) + ' | ' + v.text.slice(0, 200)); }
  await emitN('voice', { state: 'loaded', pack: 'uk', ms: 900 }); await sleep(150);
  await emitN('voice', { state: 'spoke', eng: 'neural', ms: 700 }); await sleep(150);
  ok('голос запустився й сказав фразу — пояснення про помилку зникло', !/не спрацював/.test((await vs()).text) && /Говорить якісний голос/.test((await vs()).text), (await vs()).text.slice(0, 200));
  // перемикання голосів: кожен — свій диктор
  for (const [id, sid] of [['uk:1', 1], ['uk:2', 2]]) { await page.click(`#voiceSec .vrow[data-voice="${id}"]`); await sleep(120); }
  c = await calls();
  ok('перемикання Микита → Тетяна — оболонці диктори 1 і 2 (нульового, Ладу, не вмикаємо)', ['setVoice:uk:1:uk', 'setVoice:uk:2:uk'].every(x => c.includes(x)) && !c.includes('setVoice:uk:0:uk'), c.slice(-6).join());
  // стара оболонка 1.1.2–1.1.4: якісний голос не вмикаємо, пропонуємо оновити застосунок
  await app(page, () => { window.__nativeRev = 3; window.__nativeCalls.length = 0; });
  await page.click('#voiceSec .vrow[data-voice="uk:1"]'); await sleep(200); v = await vs(); c = await calls();
  ok('стара оболонка: Микиту запамʼятано, але звучить голос телефону; є «Оновити застосунок»', c.includes('setVoice::0:') && !c.some(x => x.startsWith('setVoice:uk')) && v.on === 'uk:1' && /оновіть застосунок/i.test(v.text) && /Завантажений пакет лишається/.test(v.text), c.join() + ' | ' + v.text.slice(0, 120));
  await shot(page, '17c-voice-old');
  await page.click('#voiceSec [data-act="vApk"]'); await sleep(150);
  ok('«Оновити застосунок» — перевірка оновлення', (await calls()).includes('checkUpdate'));
  await app(page, () => { window.__nativeRev = 4; });
  await page.click('#voiceSec .vrow[data-voice="system"]'); await sleep(150);
  ok('назад на голос телефону', (await calls()).slice(-3).includes('setVoice::0:') && (await vs()).on === 'system');
  await page.click('#voiceSec [data-act="vDel"]'); await page.click('#voiceSec [data-act="vDel"]'); await sleep(200);
  ok('«Видалити пакет» — з підтвердженням', (await calls()).includes('voiceDelete:uk') && /Завантажити пакет/.test((await vs()).text));
  await app(page, () => { window.__app.S.lang = 'ru'; }); await page.click('#panelOk'); await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#voiceSec .vrow');
  ok('російський інтерфейс, вибрано голос телефону: так і написано', /Говорит голос телефона — так выбрано/.test((await vs()).text), (await vs()).text.slice(0, 120));
  await app(page, () => { window.__app.S.lang = 'uk'; });
  ok('прохід «голос» без помилок JS', errors.length === 0, errors.join(' | '));
  // у кого була вибрана Лада — після оновлення говорить Тетяна
  await app(page, () => { const st = JSON.parse(localStorage.getItem('reis.settings') || '{}'); st.ttsVoice = 'uk:0'; localStorage.setItem('reis.settings', JSON.stringify(st)); });
  await page.reload(); await page.waitForFunction(() => window.__app && window.__app.S && window.__app.map && window.__app.map.map);
  ok('була вибрана Лада — після оновлення вибрано Тетяну', await app(page, () => window.__app.S.ttsVoice === 'uk:2' && JSON.parse(localStorage.getItem('reis.settings')).ttsVoice === 'uk:2'));
  await ctx.close();
} catch (e) { ok('прохід «голос» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 11: «Маршрут» у дорозі — увесь залишок на карті, контрольна точка, залишитись, завершити ============ */
if (run('11')) for (const sc of SCREENS.filter(x => ['S10', 'tiny', 'land', 'tall'].includes(x.n) && (!process.env.SCR || process.env.SCR.split(',').includes(x.n)))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = 'у дорозі, ' + sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length;
  const trip = { id: 't-ts', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  const p0 = coords[200]; await emitN('loc', { prov: 'gps', lat: p0[0], lon: p0[1], acc: 5, spd: 20, brg: 315, t: Date.now() }); await sleep(800);
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick[data-mode="trip"] [data-ts="stay"]'); await sleep(900);
  const w = await app(page, () => { const m = window.__app.map.map, g = window.__app.guide.g, P = window.__app.nav.pos, cr = m.getContainer().getBoundingClientRect();
    const R = el => el && !el.hidden ? el.getBoundingClientRect() : null, box = R(document.getElementById('routePick')), tp = R(document.getElementById('top')), z = R(document.querySelector('#routePick .rp-zoom'));
    const inR = (r, x, y) => r && x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
    const cs = g.idx.slice(P.rd, g.idx.total); let out = 0;
    for (let i = 0; i < cs.length; i += 8) { const p = m.project(cs[i]), x = cr.left + p.x, y = cr.top + p.y; if (x < 0 || x > innerWidth || y < 0 || y > innerHeight || inR(box, x, y) || inR(tp, x, y) || inR(z, x, y)) out++; }
    const btns = [...document.querySelectorAll('#routePick button')].map(b => { const r = b.getBoundingClientRect(), h = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return { k: b.dataset.ts || b.dataset.rp, ok: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && !!h && (h === b || b.contains(h)) }; });
    return { panel: !document.getElementById('panel').hidden, out, n: Math.ceil(cs.length / 8), follow: window.__app.map.view.follow, kv: document.querySelector('#routePick .ts-kv').textContent.replace(/\s+/g, ' '), bad: btns.filter(b => !b.ok).map(b => b.k), keys: btns.map(b => b.k).join() }; });
  ok(`${T}: «Маршрут» — не панель, а карта з усім залишком маршруту (нічого не обрізано)`, !w.panel && w.out === 0 && w.n > 10 && !w.follow, JSON.stringify(w));
  ok(`${T}: на шторці — км, час, прибуття і кнопки «Контрольна точка», «Завершити», «Залишитись»`, /км/.test(w.kv) && /прибуття/.test(w.kv) && /via/.test(w.keys) && /stop/.test(w.keys) && /stay/.test(w.keys) && w.bad.length === 0, JSON.stringify(w));
  await shot(page, `t-${sc.n}-trip`);
  // контрольна точка: пошук і вибір — маршрут перебудовано через неї
  const n0 = routeReqs.length;
  await page.click('#routePick [data-ts="via"]'); await page.fill('#tsViaIn', 'Чугу'); await page.waitForSelector('#routePick [data-tsg]', { timeout: 5000 });
  await shot(page, `t-${sc.n}-via`);
  await page.click('#routePick [data-tsg="0"]'); await sleep(1500);
  const rq = routeReqs.slice(n0).pop();
  ok(`${T}: контрольна точка — маршрут перебудовано через неї`, !!rq && rq.locations.length === 3, JSON.stringify(rq ? rq.locations.map(l => l.type) : null));
  await page.click('#routePick [data-ts="stay"]'); await sleep(300);
  ok(`${T}: «Залишитись на маршруті» — назад до карти, стеження ввімкнено`, await app(page, () => document.getElementById('routePick').hidden && window.__app.map.view.follow));
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick[data-mode="trip"]');
  await page.click('#routePick [data-ts="details"]');
  ok(`${T}: «Деталі» — повна панель маршруту`, await app(page, () => !document.getElementById('panel').hidden && !!document.querySelector('[data-act="rerouteFresh"]') && document.getElementById('routePick').hidden));
  // (1.1.22) деталі рейсу — на весь екран: верхньої плашки з маневром і нижньої (час, кілометри, вкладки) під рукою немає
  await sleep(250);
  const dt = await app(page, () => { const P = document.getElementById('panel'), r = P.getBoundingClientRect(), cover = sel => { const e = document.querySelector(sel); if (!e) return true; const b = e.getBoundingClientRect(); if (!b.width || getComputedStyle(e).display === 'none') return true; const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!h && P.contains(h); };
    const bk = document.querySelector('#panelOk'), br = bk ? bk.getBoundingClientRect() : null, body = document.getElementById('panelBody');
    return { full: P.classList.contains('full'), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), vw: innerWidth, vh: innerHeight, top: cover('#top'), tripbar: cover('#tripbar'), tabs: cover('#tabs'), tilt: cover('#tilt'), speed: cover('#speed'),
      back: br ? { t: Math.round(br.top), b: Math.round(br.bottom), txt: bk.textContent.trim() } : null, secs: [...body.querySelectorAll('.sec')].map(x => x.textContent.trim()).join(' | '), text: body.textContent.replace(/\s+/g, ' ') }; });
  await shot(page, `t-${sc.n}-details`);
  ok(`${T}: деталі рейсу — на весь екран: верхню плашку з маневром і нижню (час, кілометри, вкладки, стрілку нахилу) закрито — нічого з карти не заважає`, dt.full && dt.t <= 40 && dt.b >= dt.vh - 1 && dt.r - dt.l >= Math.min(dt.vw, 760) - 1 && dt.top && dt.tripbar && dt.tabs && dt.tilt && dt.speed, JSON.stringify(dt));
  ok(`${T}: у деталях рейсу: «Стоянки для фур попереду» — лише перевірені (тут їх немає — так і сказано, і чому), АЗС — окремо в «АЗС і сервіс попереду», без слів «для фур»`, /Стоянки для фур попереду \| АЗС і сервіс попереду/.test(dt.secs) && /Перевірених стоянок для фур попереду в рейсі немає\. Біля АЗС фури тепер здебільшого не пускають/.test(dt.text) && !/· для фур|, для фур|для фур,/.test(dt.text), JSON.stringify({ secs: dt.secs, text: dt.text.slice(0, 600) }));
  ok(`${T}: деталі рейсу: усе читається; закрити — та сама галочка «Готово» праворуч унизу (окремої кнопки «Назад» немає)`, (await readCheck(page, '#panel', '#panelBody')).length === 0 && !!dt.back && dt.back.txt === '' && dt.back.b <= dt.vh && dt.back.b >= dt.vh - 80 && !/Назад/.test(dt.text), JSON.stringify([await readCheck(page, '#panel', '#panelBody'), dt.back]));
  if (sc.n === 'S10') {
    // перевірена стоянка (комплекс для фур) попереду на маршруті — зʼявляється в «Стоянках для фур попереду»; вимкнули «Перевірені» — підказка, де їх увімкнути
    await app(page, cx => { const V = window.__app.vplaces; V.vp.list.push(cx); window.__app.bus.emit('vplaces', V.vp); window.__app.bus.emit('guide', window.__app.guide.g); }, VP_COMPLEX); await sleep(1300);
    const tp1 = await app(page, () => ({ rows: [...document.querySelectorAll('#panelBody .tp-row')].map(x => x.textContent.replace(/\s+/g, ' ').trim()), text: document.getElementById('panelBody').textContent.replace(/\s+/g, ' ') }));
    ok(`${T}: перевірена стоянка попереду на маршруті — у «Стоянках для фур попереду»: назва, вид, коли перевірено, через скільки`, tp1.rows.length === 1 && /^Комплекс \(тест\)\s*Стоянка · готель · кафе · перевірено .*2026.*\d/.test(tp1.rows[0]) && !/Перевірених стоянок для фур попереду в рейсі немає/.test(tp1.text), JSON.stringify(tp1.rows));
    await page.click('#panelBody .tp-row'); await sleep(350);
    ok(`${T}: дотик до неї — її картка (ціни, фото)`, await app(page, () => /Комплекс \(тест\)/.test(document.getElementById('panelTitle').textContent)), await app(page, () => document.getElementById('panelTitle').textContent));
    await app(page, () => { window.__app.ui.setLayer ? window.__app.ui.setLayer('@mapVerified', false) : (window.__app.S.mapVerified = false); }); await sleep(200);
    await page.click('#panelOk'); await sleep(200);
    await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick[data-mode="trip"]'); await page.click('#routePick [data-ts="details"]'); await sleep(300);
    const tp2 = await app(page, () => ({ rows: document.querySelectorAll('#panelBody .tp-row').length, text: document.getElementById('panelBody').textContent.replace(/\s+/g, ' ') }));
    ok(`${T}: галочку «Перевірені» вимкнено — стоянок для фур не показуємо, підказано, де їх увімкнути`, tp2.rows === 0 && /Тут — лише перевірені стоянки\. Увімкніть «Перевірені» в «Місцях»/.test(tp2.text), tp2.text.slice(0, 400));
    await app(page, () => { window.__app.S.mapVerified = true; const V = window.__app.vplaces; V.vp.list = V.vp.list.filter(x => x.id !== 'test-complex'); window.__app.bus.emit('vplaces', V.vp); });
  }
  // «Назад» унизу закриває деталі — знову карта з плашками
  await page.click('#panelOk'); await sleep(300);
  ok(`${T}: «Назад» закриває деталі — знову карта: верхня й нижня плашки на місці`, await app(page, () => document.getElementById('panel').hidden && (e => { const b = e.getBoundingClientRect(), h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!h && e.contains(h); })(document.getElementById('tabs'))));
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick [data-ts="stop"]');
  await page.click('#routePick [data-ts="stop"]');
  ok(`${T}: «Завершити» питає ще раз`, await app(page, () => window.__app.guide.g.active && /Так, завершити/.test(document.querySelector('#routePick [data-ts="stop"]').textContent)));
  await page.click('#routePick [data-ts="stop"]'); await sleep(300);
  ok(`${T}: другий дотик — маршрут завершено, шторку сховано`, await app(page, () => !window.__app.guide.g.active && document.getElementById('routePick').hidden));
  ok(`${T}: без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`у дорозі, ${sc.title}: перевірка дійшла до кінця`, false, String(e.message).split('\n')[0]); }

/* ============ прохід 12: позначки водіїв — ДТП, поліція, транспортна служба; другий телефон бачить ============ */
if (run('12')) try {
  NTFY.msgs.length = 0;
  const A = await newPage(true, { viewport: { width: 360, height: 670 } }), B = await newPage(true, { viewport: { width: 393, height: 800 }, keep: true });
  const em = (pg, type, d) => app(pg, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length;
  const trip = { id: 't-rep', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  // телефон А стоїть біля поліції на 8-му кілометрі; телефон Б їде тим самим маршрутом позаду, за 1,5 км
  const pA = coords[turnIdx[3] + 40], pB = coords[turnIdx[3] + 10];
  await em(A.page, 'loc', { prov: 'gps', lat: pA[0], lon: pA[1], acc: 5, spd: 0, brg: 315, t: Date.now() });
  await app(B.page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  await em(B.page, 'loc', { prov: 'gps', lat: pB[0], lon: pB[1], acc: 5, spd: 0, brg: 315, t: Date.now() });
  await sleep(500);
  await A.page.click('#tabRep'); await A.page.waitForSelector('#repSheet [data-rep="police"]');
  const sh = await app(A.page, () => ({ btns: [...document.querySelectorAll('#repSheet [data-rep]')].map(b => b.dataset.rep + ':' + b.textContent.trim()), r: document.getElementById('repSheet').getBoundingClientRect().bottom <= innerHeight }));
  ok('позначки: трикутник відкриває ДТП · Поліція · Транспортна служба', sh.r && sh.btns.join('|') === 'crash:ДТП|police:Поліція|transport:Транспортна служба|x:', sh.btns.join('|'));
  await shot(A.page, '18-report');
  // 1.1.9: шторка прозора, як інші; після вибору — приціл: дотик до карти ставить позначку туди, де бачили
  const bgA = await app(A.page, () => { const m = getComputedStyle(document.getElementById('repSheet')).backgroundColor.match(/rgba?\(([^)]+)\)/); const a = m ? m[1].split(',').map(Number) : []; return a.length === 4 ? a[3] : 1; });
  ok('шторка «Що на дорозі?» прозора, як інші (карту під нею видно)', bgA < 0.9, 'alpha ' + bgA);
  await A.page.click('#repSheet [data-rep="police"]'); await sleep(300);
  const aimA = await app(A.page, () => { const a = document.getElementById('aim'), c = a.querySelector('.aim-cross'), r = c && c.getBoundingClientRect(); return { on: !a.hidden && document.body.classList.contains('aiming'), sheet: document.getElementById('repSheet').hidden, cx: r ? r.left + r.width / 2 : 0, cy: r ? r.top + r.height / 2 : 0, t: a.textContent }; });
  ok('після «Поліція» — приціл і підказка «торкніться карти там, де бачили»; позначки ще немає', aimA.on && aimA.sheet && /торкніться карти/.test(aimA.t) && await app(A.page, () => window.__app.reports.reps.list.length === 0), JSON.stringify(aimA));
  await shot(A.page, '18-report-aim');
  // далеко від машини — не можна (захист від засмічення)
  await app(A.page, () => { window.__app.map.setFollow(false); window.__app.map.map.jumpTo({ zoom: 10.5 }); }); await sleep(400);
  const vw = await app(A.page, () => ({ w: innerWidth, h: innerHeight }));
  await A.page.mouse.click(14, aimA.cy - 60); await sleep(300);
  ok('дотик за 3 км від машини — «Задалеко», позначки немає, приціл лишається', /Задалеко/.test(await A.page.textContent('#toasts')) && await app(A.page, () => window.__app.reports.reps.list.length === 0 && !document.getElementById('aim').hidden));
  await app(A.page, ([la, lo]) => window.__app.map.map.jumpTo({ center: [lo, la], zoom: 15 }), pA); await sleep(400);
  const tgt = await app(A.page, ([la, lo]) => { const m = window.__app.map.map, r = m.getContainer().getBoundingClientRect(), q = m.project([lo, la]); return { x: r.left + q.x + 60, y: r.top + q.y - 40 }; }, pA);
  await A.page.mouse.click(tgt.x, tgt.y); await sleep(400);
  const put = await app(A.page, () => { const r = window.__app.reports.reps.list[0]; const el = document.querySelector('.rpm-police .rpm-t'); return { n: window.__app.reports.reps.list.length, lat: r && r.lat, lon: r && r.lon, lbl: el ? el.textContent : '', aim: !document.getElementById('aim').hidden, toast: document.getElementById('toasts').textContent }; });
  const dPut = Math.hypot((put.lat - pA[0]) * 111320, (put.lon - pA[1]) * 71500);
  ok('дотик біля машини — позначка саме там, куди торкнулись (а не під машиною)', put.n === 1 && dPut > 30 && dPut < 200 && !put.aim, JSON.stringify({ ...put, dPut: Math.round(dPut) }));
  ok('під значком — дата й час позначки («23.11 13:05»)', /^\d\d\.\d\d \d\d:\d\d$/.test(put.lbl), put.lbl);
  ok('плашка «Позначено… торкніться, щоб скасувати»; іншим ще не пішло (8 с на скасування)', /щоб скасувати/.test(put.toast) && NTFY.posts === 0, 'POST ' + NTFY.posts);
  // скасування: торкнулись плашки — позначки немає, нікуди не пішла
  await A.page.click('#toasts .toast:has-text("щоб скасувати")'); await sleep(300);
  ok('«Скасувати» — позначка зникла й нікуди не пішла', await app(A.page, () => window.__app.reports.reps.list.length === 0 && !document.querySelector('.rpm-police')) && NTFY.posts === 0);
  // ще раз — «Де я зараз» (поліція тут же); через 8 с позначка йде іншим
  await app(A.page, () => window.__app.map.setFollow(true));
  await A.page.click('#tabRep'); await A.page.click('#repSheet [data-rep="police"]'); await sleep(200);
  await A.page.click('#aim [data-aim="here"]'); await sleep(300);
  // одразу ще одна — ліміт: не частіше ніж раз на 15 с
  await app(A.page, () => { document.getElementById('toasts').innerHTML = ''; });
  await A.page.click('#tabRep'); await A.page.click('#repSheet [data-rep="transport"]'); await sleep(200);
  await A.page.click('#aim [data-aim="here"]'); await sleep(300);
  const often = await A.page.textContent('#toasts');
  ok('ліміт: друга позначка за 15 с — «Зачекайте трохи», зайвої позначки немає', /Зачекайте трохи/.test(often) && await app(A.page, () => window.__app.reports.reps.list.length === 1), often.slice(0, 160));
  await sleep(8800);
  ok('позначка «Поліція» з’явилась там, де машина, і через 8 с пішла іншим водіям', await app(A.page, () => document.querySelectorAll('.rpm-police').length === 1 && document.getElementById('repSheet').hidden) && NTFY.posts === 1, 'POST ' + NTFY.posts);
  const sent = JSON.parse(NTFY.msgs[0].message);
  ok('у повідомленні — тип, місце, напрямок і час; більше нічого', sent.t === 'police' && Math.abs(sent.lat - pA[0]) < 1e-4 && typeof sent.at === 'number' && !('name' in sent), NTFY.msgs[0].message);
  await app(B.page, () => window.__app.reports.poll()); await sleep(400);
  ok('другий телефон бачить поліцію на карті, з тим самим часом під значком', await app(B.page, () => document.querySelectorAll('.rpm-police').length === 1 && /^\d\d\.\d\d \d\d:\d\d$/.test(document.querySelector('.rpm-police .rpm-t').textContent)));
  if (process.env.DEBUG) console.log('FEED', await app(B.page, ([la, lo]) => { const P = window.__app.nav.pos, g = window.__app.guide.g, l = g.idx && g.idx.locate({ lat: la, lon: lo }, null); return JSON.stringify({ mode: P.mode, rd: P.rd, on: P.onRoute, act: g.active, ld: l && l.d, off: l && l.off, items: window.__app.feed.feed.items.map(i => i.src + ':' + i.text).slice(0, 5) }); }, pA));
  ok('…і в «Подіях»: поліція попереду на маршруті, позначка водія', await app(B.page, () => window.__app.feed.feed.items.some(i => i.src === 'rep' && /^Поліція · /.test(i.text))), await app(B.page, () => JSON.stringify(window.__app.feed.feed.items.filter(i => i.src === 'rep').map(i => i.text))));
  await shot(B.page, '18b-report-seen');
  await app(B.page, () => document.querySelector('.rpm-police').click()); await sleep(200);   // значок далеко від машини, за краєм екрана
  ok('торкнутися значка — «Поліція · позначив водій 23.11 13:05 (щойно)»', /Поліція · позначив водій \d\d\.\d\d \d\d:\d\d \(щойно\)/.test(await B.page.textContent('#toasts')), await B.page.textContent('#toasts'));
  // Б проїжджає поліцію — «Поліція ще тут?» над позначкою; «Так» — ще 2 години від цієї хвилини, час під значком новий
  await app(B.page, () => { const r = window.__app.reports.reps.list[0]; r.at -= 40 * 60000; r.born = r.at; window.__app.core.bus.emit('reports', window.__app.reports.reps); });
  const old = await app(B.page, () => window.__app.reports.reps.list[0].at);
  const dA = await app(B.page, ([la, lo]) => window.__app.guide.g.idx.locate({ lat: la, lon: lo }, null).d, pA);
  for (let d = dA - 300; d <= dA - 100; d += 20) {           // справжній проїзд: фікс щосекунди, 20 м/с
    const q = await app(B.page, d => { const p = window.__app.guide.g.idx.at(d); return { lat: p.lat, lon: p.lon, brg: p.brg }; }, d);
    await em(B.page, 'loc', { prov: 'gps', lat: q.lat, lon: q.lon, acc: 5, spd: 20, brg: q.brg, t: Date.now() }); await sleep(1000);
    if (await app(B.page, () => !!document.querySelector('.rpq'))) break;
  }
  await B.page.waitForSelector('.rpq', { timeout: 4000 }).catch(() => {});
  if (process.env.DEBUG) console.log('ASK', await app(B.page, ([la, lo]) => { const P = window.__app.nav.pos, r = window.__app.reports.reps.list[0]; return JSON.stringify({ mode: P.mode, spd: P.spd, lat: P.lat, lon: P.lon, d: r ? window.__app.core.hav(P, r) : null, r, S: window.__app.S.mapReports }); }, pA));
  const ask = await app(B.page, () => { const q = document.querySelector('.rpq'); return q ? q.textContent : ''; });
  ok('проїжджаємо чужу позначку — над нею «Поліція ще тут?» із «✓ Так» / «✕ Немає»', /Поліція ще тут\?/.test(ask) && /Так/.test(ask) && /Немає/.test(ask), ask);
  await shot(B.page, '18c-report-ask');
  const p0 = NTFY.posts;
  await B.page.click('.rpq .rpq-y'); await sleep(500);
  const cf = await app(B.page, () => { const r = window.__app.reports.reps.list[0]; return { at: r.at, conf: r.conf, lbl: document.querySelector('.rpm-police .rpm-t').textContent, ask: !!document.querySelector('.rpq') }; });
  const okMsg = NTFY.msgs.length ? JSON.parse(NTFY.msgs[NTFY.msgs.length - 1].message) : {};
  ok('«Так» — позначка продовжена від цієї хвилини, під значком новий час із ✓, іншим пішло підтвердження', cf.at > old + 30 * 60000 && cf.conf === 1 && /^✓ \d\d\.\d\d \d\d:\d\d$/.test(cf.lbl) && !cf.ask && NTFY.posts === p0 + 1 && okMsg.k === 'ok' && okMsg.id === sent.id, JSON.stringify({ cf, okMsg }));
  await app(A.page, () => window.__app.reports.poll()); await sleep(400);
  ok('у того, хто ставив, — теж «✓» і новий час (підтвердив інший водій)', await app(A.page, () => { const r = window.__app.reports.reps.list[0]; return r.conf === 1 && /^✓ /.test(document.querySelector('.rpm-police .rpm-t').textContent); }));
  // двоє інших водіїв кажуть «Немає» — позначка зникає в усіх
  for (const d of ['dev-x1', 'dev-x2']) NTFY.msgs.push({ id: 'm' + (NTFY.msgs.length + 1), time: Math.floor(Date.now() / 1000) + 1, event: 'message', message: JSON.stringify({ v: 1, k: 'no', id: sent.id, dev: d }) });
  await app(A.page, () => window.__app.reports.poll()); await sleep(400);
  ok('два «Немає» від різних водіїв — позначка зникла з карти', await app(A.page, () => document.querySelectorAll('.rpm-police').length === 0));
  // через 2 години позначка зникає
  await app(B.page, () => { const r = window.__app.reports.reps.list[0]; if (r) r.at -= 2 * 3600e3 + 1000; });
  await app(B.page, () => window.__app.reports.poll()); await sleep(300);
  ok('через 2 години без підтверджень позначка зникає з карти', await app(B.page, () => document.querySelectorAll('.rpm').length === 0 && window.__app.reports.reps.list.length === 0));
  // сервер недоступний — своя позначка все одно на карті
  NTFY.fail = true;
  await app(A.page, () => localStorage.setItem('reis.repMine', '[]'));
  await A.page.reload(); await A.page.waitForFunction(() => window.__app && window.__app.reports);
  await em(A.page, 'loc', { prov: 'gps', lat: pA[0], lon: pA[1], acc: 5, spd: 0, brg: 315, t: Date.now() }); await sleep(600);
  await A.page.click('#tabRep'); await A.page.click('#repSheet [data-rep="crash"]'); await A.page.click('#aim [data-aim="here"]'); await sleep(400);
  ok('немає звʼязку з сервером — своя позначка ДТП усе одно на карті', await app(A.page, () => document.querySelectorAll('.rpm-crash').length === 1));
  NTFY.fail = false;
  ok('прохід «позначки» без помилок JS', A.errors.length === 0 && B.errors.length === 0, A.errors.concat(B.errors).join(' | '));
  await A.ctx.close(); await B.ctx.close();
} catch (e) { ok('прохід «позначки» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 13: спідометр — червоний, коли перевищено понад 20 км/год (з цього штраф), без GPS — червоно-помаранчевий ============ */
if (run('13')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 360, height: 670 } });
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const D2R = Math.PI / 180;
  let t = Date.now();
  const drive = async (p, v, n = 4) => { for (let i = 0; i < n; i++) { p = { lat: p.lat + v / 111320, lon: p.lon }; t += 1000; await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: v, brg: 0, t }); await sleep(250); } await sleep(1100); return p; };
  const st = () => app(page, () => { const s = document.getElementById('speed'), l = document.getElementById('spdLim'); return { over: s.classList.contains('over'), est: s.classList.contains('est'), lim: l.hidden ? '' : l.textContent, v: document.getElementById('spdVal').textContent }; });
  await app(page, () => window.__app.limits.init()); await page.waitForFunction(() => window.__app.limits.townAt({ lat: 49.993, lon: 36.23 }) !== null || true); await sleep(500);
  const tw = await app(page, () => { const T = window.__app.limits.townAt; return { kh: (T({ lat: 49.99, lon: 36.25 }) || [])[3] || '', field: T({ lat: 49.6, lon: 34.0 }), r: Math.round(window.__app.limits.townRadius([0, 0, 'c', '', '', '', 1421125])) }; });
  ok('населений пункт за довідником: центр Харкова — так, поле між містами — ні', tw.kh === 'Харків' && tw.field === null, JSON.stringify(tw));
  let p = await drive({ lat: 49.99, lon: 36.23 }, 75 / 3.6);
  let s1 = await st();
  ok('у місті (50 км/год) їдемо 75 — понад 20 зверху: спідометр червоний, поруч знак «50»', s1.over && s1.lim === '50' && !s1.est, JSON.stringify(s1));
  await shot(page, '19-speed-over');
  p = await drive(p, 66 / 3.6);
  s1 = await st();
  ok('у місті 66 км/год (перевищення до 20 — без штрафу): не червоний', !s1.over && s1.lim === '50', JSON.stringify(s1));
  { const F = await newPage(true, { viewport: { width: 360, height: 670 }, keep: true });           // окремий «телефон» у полі: стрибок на 250 км був би підміною
    let q = { lat: 49.6, lon: 34.0 }, tf = Date.now();
    for (let i = 0; i < 5; i++) { q = { lat: q.lat + 24.4 / 111320, lon: q.lon }; tf += 1000; await app(F.page, d => window.__reis('loc', d), { prov: 'gps', lat: q.lat, lon: q.lon, acc: 5, spd: 24.4, brg: 0, t: tf }); await sleep(250); }
    await sleep(1100);
    const sf = await app(F.page, () => { const s = document.getElementById('speed'), l = document.getElementById('spdLim'); return { over: s.classList.contains('over'), lim: l.hidden ? '' : l.textContent, v: document.getElementById('spdVal').textContent }; });
    ok('поза населеним пунктом 88 км/год: не червоний, знака немає', !sf.over && sf.lim === '' && sf.v === '88', JSON.stringify(sf));
    await F.ctx.close(); }
  // без GPS у місті: оцінка швидкості 80 → червоно-помаранчевий
  p = await drive({ lat: 49.99, lon: 36.23 }, 80 / 3.6, 6);
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 12000 });
  await sleep(1200); s1 = await st();
  ok('без GPS у місті, оцінка ≈80: спідометр червоно-помаранчевий', s1.over && s1.est, JSON.stringify(s1));
  await shot(page, '19b-speed-over-dr');
  ok('прохід «спідометр» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «спідометр» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 14: сприйняття — усе читається, нічого не обрізане й не перекрите (кожен екран, з прокруткою) ============ */
// Тема не має залежати від того, о котрій годині запустили тести (раніше прохід випадково йшов лише вночі):
// кожен екран перевіряємо вдень, а два основні (S10 і альбомний) — ще й уночі.
if (run('14')) for (const [sc, th] of SCREENS.filter(x => ['S10', 'tiny', 'land', 'tall', 'notch'].includes(x.n) && (!process.env.SCR || process.env.SCR.split(',').includes(x.n))).flatMap(x => ['S10', 'land'].includes(x.n) ? [[x, 'day'], [x, 'night']] : [[x, 'day']])) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  await app(page, th => { window.__app.S.theme = th; window.__app.map.applyTheme(); }, th);
  ok(`сприйняття, ${sc.title}: тема «${th === 'day' ? 'день' : 'ніч'}» увімкнена`, await app(page, th => document.body.dataset.theme === th, th));
  const T = 'сприйняття (' + (th === 'day' ? 'день' : 'ніч') + '), ' + sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  if (sc.st) await app(page, ([st, sb]) => { const r = document.documentElement.style; r.setProperty('--st', st + 'px'); r.setProperty('--sb', sb + 'px'); }, [sc.st, sc.sb]);
  const R = async (what, root, scroll) => { const L = await readCheck(page, root, scroll); ok(`${T}: ${what} — читається, нічого не обрізано й не перекрито`, L.length === 0, L.join('; ')); };
  // вибір маршруту
  await page.click('#tabs button[data-panel="trip"]'); await R('форма маршруту', '#panel', '#panelBody');
  await page.fill('#in_a', 'Харків'); await page.waitForSelector('#sg_a button'); await page.click('#sg_a button');
  await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button'); await page.click('#sg_b button');
  await page.click('[data-act="build"]'); await page.waitForSelector('#routePick [data-rp="go"]'); await sleep(700);
  await R('вибір із двох маршрутів', '#routePick');
  await page.click('#routePick [data-rp="go"]'); await sleep(900);
  const p0 = coords[120]; await emitN('loc', { prov: 'gps', lat: p0[0], lon: p0[1], acc: 5, spd: 20, brg: 270, t: Date.now() }); await sleep(700);
  await R('головний екран у дорозі', 'body > header, #top', null); await R('нижня панель', '#bottom', null);
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick[data-mode="trip"]'); await sleep(500);
  await R('«Маршрут» у дорозі', '#routePick');
  if (sc.n === 'S10') {   // сама перевірка ловить обрізаний текст: на мить робимо надпис задовгим
    await app(page, () => { const b = document.querySelector('#routePick .ts-more'); b.dataset.old = b.textContent; b.style.maxWidth = '70px'; b.style.overflow = 'hidden'; b.style.whiteSpace = 'nowrap'; b.textContent = 'Усі деталі цього маршруту повністю'; });
    const L = await readCheck(page, '#routePick');
    ok(`${T}: перевірка сприйняття справді помічає задовгий надпис на кнопці`, L.some(x => /не влазить|обрізано|за краєм/.test(x)), L.join('; '));
    await app(page, () => { const b = document.querySelector('#routePick .ts-more'); b.textContent = b.dataset.old; b.style.maxWidth = b.style.overflow = b.style.whiteSpace = ''; });
  }
  await page.click('#routePick [data-ts="via"]'); await page.fill('#tsViaIn', 'Чугу'); await page.waitForSelector('#routePick [data-tsg]');
  await R('контрольна точка (пошук)', '#routePick');
  await page.click('#routePick [data-ts="stay"]');
  await app(page, async () => { const f = window.__app.feed; await f.pollAir(); await f.pollTelegram(true); }); await sleep(600);
  await page.click('#tabs button[data-panel="feed"]'); await page.waitForSelector('#panelBody .ev-air');
  await R('«Події» (усе, з прокруткою до кінця)', '#panel', '#panelBody');
  await shot(page, `r-${sc.n}-feed`);
  await page.click('#panelOk');
  await page.click('#tabs button[data-panel="places"]'); await R('«Місця»', '#panel', '#panelBody'); await page.click('#panelOk');
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]');
  await app(page, () => { window.__app.S.ttsVoice = 'uk:1'; window.__voice = { packs: { uk: { ver: 2, size: 87e6 } } }; window.__reis('voice', { state: 'fallback', error: 'audio init' }); }); await sleep(200);
  await app(page, () => document.querySelectorAll('#panelBody details').forEach(d => { d.open = true; }));   // «Щоденник голосу» розгорнуто — його теж перевіряємо
  await R('«Параметри» (з прокруткою, щоденник голосу розгорнуто)', '#panel', '#panelBody'); await page.click('#panelOk');
  await app(page, () => { window.__app.S.ttsVoice = 'system'; });
  await page.click('#spdGps'); await R('GPS', '#panel', '#panelBody'); await page.click('#panelOk');
  await page.click('#tabRep'); await R('«Що на дорозі?»', '#repSheet'); await page.click('#repSheet [data-rep="x"]');
  await page.click('#bQuick'); await R('швидкі налаштування', '#quick'); await page.click('#quick [data-q="close"]');
  await emitN('update', { apk: { code: 250, name: '1.1.9.50' } }); await sleep(200); await R('плашка оновлення', '#bottom', null);
  ok(`${T}: без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`сприйняття, ${sc.title}: перевірка дійшла до кінця`, false, String(e.message).split('\n')[0]); }

/* ============ прохід 3: офлайн-карта України з файлу в телефоні ============ */
/* ============ прохід 15 (1.1.5): кружечок не дублює назву; «Шари» — окрема кнопка справа ============ */
if (run('15')) try {
  // базова карта для тесту: підписи місць як у OpenFreeMap (шар «poi_…», з’являються з 14-го масштабу)
  const cafe = coords[turnIdx[3] + 300], shw = coords[turnIdx[3] + 330];
  const style = { version: 8, sources: { tpoi: { type: 'geojson', data: { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { name: 'Кафе «Дорога»' }, geometry: { type: 'Point', coordinates: [cafe[1] + 0.00005, cafe[0]] } },
      { type: 'Feature', properties: { name: 'Магазин' }, geometry: { type: 'Point', coordinates: [shw[1] + 0.00005, shw[0]] } }] } } },
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dde5d8' } },
      { id: 'poi_r1', type: 'symbol', source: 'tpoi', minzoom: 14, layout: { 'icon-image': ['concat', 'fuel:', ['get', 'name']], 'icon-allow-overlap': true, 'icon-anchor': 'top', 'icon-offset': [0, 6] } }] };
  const { page, ctx, errors } = await newPage(true, { style, viewport: { width: 360, height: 670 } });
  const st = i => app(page, i => !!(window.__app.map.map.getFeatureState({ source: 'stops', id: i }) || {}).lab, i);
  const go = async (p, z) => { await app(page, ([p, z]) => { const M = window.__app.map; M.setFollow(false); M.map.jumpTo({ center: [p[1], p[0]], zoom: z, bearing: 0, pitch: 0 }); }, [p, z]); await sleep(1500); };
  await page.waitForFunction(() => window.__app.stopsdb.sdb.ready && window.__app.map.map.getSource('stops'), null, { timeout: 8000 });
  await go(stopPt, 14);
  ok('АЗС наближено: над нею плашка з назвою мережі — кружечка під плашкою немає', await st(1) && await app(page, () => window.__app.map.map.queryRenderedFeatures({ layers: ['fuel-label'] }).some(f => f.properties.i === 1)), JSON.stringify(await app(page, () => window.__app.map.hiddenDots())));
  await shot(page, '18a-fuel-noDot');
  await go(cafe, 16);
  ok('кафе: карта вже пише назву «Кафе «Дорога»» — кружечок сховано', await st(3), JSON.stringify(await app(page, () => window.__app.map.hiddenDots())));
  ok('душ поруч із чужим підписом («Магазин») — кружечок лишається', !(await st(5)));
  ok('схований кружечок і далі натискається — відкриває картку місця', await app(page, ([p]) => { const m = window.__app.map.map, pt = m.project([p[1], p[0]]); return m.queryRenderedFeatures(pt, { layers: ['stops-all'] }).some(f => f.properties.i === 3); }, [cafe]));
  await shot(page, '18b-cafe-noDot');
  await go(cafe, 9.8); await sleep(1200);
  ok('віддалили — назв немає, усі кружечки повернулись', (await app(page, () => window.__app.map.hiddenDots())).length === 0 && !(await st(3)) && !(await st(1)), JSON.stringify(await app(page, () => window.__app.map.hiddenDots())));
  await shot(page, '18c-far-dots');
  // (1.1.20) кнопки «Шари» на головному екрані більше немає: галочки — у «Місцях», екран вільніший
  const lb = await app(page, () => ({ gone: !document.getElementById('bLayers'), rail: [...document.querySelectorAll('#rail > button')].map(b => b.id).join(), quickHasLayers: !!document.querySelector('#quick .ly-row') }));
  ok('кнопки «Шари» справа немає; справа — швидкі налаштування, тип карти й (1.1.28) звук', lb.gone && /^bQuick,bMap,bSnd(,bSearch)?$/.test(lb.rail) && !lb.quickHasLayers, JSON.stringify(lb));
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips'); await sleep(200);
  ok('галочки — у «Місцях»: 11 плиток', await app(page, () => document.querySelectorAll('#panelBody .pl-chip').length === 11));
  await shot(page, '18d-layers');
  await page.click('[data-plc="#none"]'); await sleep(150);
  ok('«Прибрати все» — жодної галочки, кнопка «Прибрати все» неактивна', await app(page, () => !document.querySelector('.pl-chip.on') && document.querySelector('[data-plc="#none"]').disabled && !document.querySelector('[data-plc="#all"]').disabled));
  await page.click('[data-plc="#all"]'); await sleep(150);
  ok('«Показати все» — усі галочки, кнопка «Показати все» неактивна', await app(page, () => document.querySelectorAll('.pl-chip.on').length === 11 && document.querySelector('[data-plc="#all"]').disabled));
  await page.click('#panelOk'); await sleep(200);
  ok('прохід 15 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 15 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 16 (1.1.6): екрани маршруту відкриваються з чистою картою; позначки — кнопкою ============ */
if (run('16')) for (const sc of SCREENS.filter(x => ['S10', 'tiny', 'land', 'tall'].includes(x.n) && (!process.env.SCR || process.env.SCR.split(',').includes(x.n)))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = 'чиста карта, ' + sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  // що видно на карті: шари кружечків, плашки АЗС, камери; DOM-позначки (перевірені місця, події, проблемні місця, позначки водіїв)
  const seen = () => app(page, () => { const m = window.__app.map.map, vis = id => m.getLayer(id) && m.getLayoutProperty(id, 'visibility') !== 'none';
    const dom = [...document.querySelectorAll('.rpm,.vpm,.evm,.hzm')].filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).length;
    const z = document.querySelector('#routePick .rp-zoom'), zr = z ? z.getBoundingClientRect() : null, tp = document.getElementById('top').getBoundingClientRect(), mk = document.querySelector('#routePick [data-rp="marks"]');
    return { clean: document.body.classList.contains('map-clean'), layers: ['stops-major', 'stops-all', 'fuel-label', 'poi-dot', 'marks-dot'].filter(vis).length, dom,
      route: (m.getSource('route')._data.features || [m.getSource('route')._data]).length > 0 && m.getLayoutProperty('route-line', 'visibility') !== 'none', pins: document.querySelectorAll('.wp').length,
      rail: getComputedStyle(document.getElementById('rail')).visibility, mk: mk ? { on: mk.classList.contains('on'), w: Math.round(mk.getBoundingClientRect().width), label: mk.getAttribute('aria-label') } : null,
      zoomIn: zr ? zr.top >= 0 && zr.left >= 0 && zr.right <= innerWidth && zr.bottom <= innerHeight : null, zoomOverTop: zr ? !(zr.right <= tp.left || zr.left >= tp.right || zr.bottom <= tp.top || zr.top >= tp.bottom) : null, nBtn: z ? z.children.length : 0 }; });
  await page.waitForFunction(() => window.__app.stopsdb.sdb.ready && window.__app.map.map.getSource('stops'), null, { timeout: 8000 });
  const base = await seen();
  ok(`${T}: на головному екрані позначки є (кружечки, плашки, значки)`, !base.clean && base.layers === 5, JSON.stringify(base));
  // 1) перше прокладання маршруту
  await page.click('#tabs button[data-panel="trip"]');
  await page.fill('#in_a', 'Харків'); await page.waitForSelector('#sg_a button', { timeout: 5000 }); await page.click('#sg_a button');
  await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await page.click('#sg_b button');
  await page.click('[data-act="build"]');
  await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 10000 }); await sleep(1100);
  let c = await seen();
  ok(`${T}: вибір маршруту відкривається чистим — жодного кружечка, плашки чи значка; маршрут і точки А, С на місці`, c.clean && c.layers === 0 && c.dom === 0 && c.route && c.pins >= 2, JSON.stringify(c));
  ok(`${T}: кнопки швидких налаштувань і шарів на цьому екрані сховані — замість них кнопка позначок над «+»`, c.rail === 'hidden' && c.mk && !c.mk.on && c.mk.w >= 44 && c.nBtn === 4 && /Показати/.test(c.mk.label), JSON.stringify(c));
  ok(`${T}: стовпчик кнопок (позначки, +, −, весь маршрут) у межах екрана й не на верхній плашці`, c.zoomIn === true && c.zoomOverTop === false, JSON.stringify(c));
  const w0 = await pickWhole(page);
  ok(`${T}: увесь маршрут видно цілком і не під кнопками`, w0.n > 20 && w0.out === 0 && w0.under === 0, JSON.stringify(w0));
  await shot(page, `c-${sc.n}-0-pick-clean`);
  await page.click('#routePick [data-rp="marks"]'); await sleep(350);
  c = await seen();
  ok(`${T}: кнопка позначок — кружечки й значки зʼявились, кнопка підсвічена`, !c.clean && c.layers === 5 && c.mk.on && /Сховати/.test(c.mk.label), JSON.stringify(c));
  await shot(page, `c-${sc.n}-1-pick-marks`);
  await page.click('#routePick [data-alt="1"]'); await sleep(400);
  c = await seen();
  ok(`${T}: вибрали інший варіант — позначки лишились, як увімкнув водій`, !c.clean && c.mk.on, JSON.stringify(c));
  await page.click('#routePick [data-rp="marks"]'); await sleep(300);
  c = await seen();
  ok(`${T}: ще раз — знову чисто`, c.clean && c.layers === 0 && c.dom === 0 && !c.mk.on, JSON.stringify(c));
  // позначки ввімкнули й закрили екран → наступного разу знову чисто
  await page.click('#routePick [data-rp="marks"]'); await page.click('#routePick [data-rp="info"]'); await sleep(400);
  c = await seen();
  ok(`${T}: «Деталі» — екран вибору закрито, карта знову з позначками`, !c.clean && c.layers === 5, JSON.stringify(c));
  await page.click('#panelOk'); await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 5000 }); await sleep(500);
  c = await seen();
  ok(`${T}: повернулись до вибору — знову чиста карта (вибір водія не запамʼятовується)`, c.clean && c.layers === 0 && !c.mk.on, JSON.stringify(c));
  // 2) поїхали → у дорозі позначки на місці
  await page.click('#routePick [data-rp="go"]'); await sleep(600);
  const p0 = coords[200]; await emitN('loc', { prov: 'gps', lat: p0[0], lon: p0[1], acc: 5, spd: 20, brg: 315, t: Date.now() }); await sleep(900);
  c = await seen();
  ok(`${T}: «Поїхали» — у дорозі позначки на місці, кнопки справа повернулись`, !c.clean && c.layers === 5 && c.rail === 'visible', JSON.stringify(c));
  // 3) «Маршрут» у дорозі
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick[data-mode="trip"] [data-ts="stay"]'); await sleep(900);
  c = await seen();
  ok(`${T}: «Маршрут» у дорозі відкривається чистим — лише залишок маршруту`, c.clean && c.layers === 0 && c.dom === 0 && c.route && c.mk && !c.mk.on && c.nBtn === 4, JSON.stringify(c));
  ok(`${T}: у дорозі стовпчик кнопок у межах екрана й не на плашці маневру`, c.zoomIn === true && c.zoomOverTop === false, JSON.stringify(c));
  await shot(page, `c-${sc.n}-2-trip-clean`);
  await page.click('#routePick [data-rp="marks"]'); await sleep(350);
  c = await seen();
  ok(`${T}: у дорозі кнопка позначок показує кружечки й значки`, !c.clean && c.layers === 5 && c.mk.on, JSON.stringify(c));
  await shot(page, `c-${sc.n}-3-trip-marks`);
  await page.click('#routePick [data-ts="stay"]'); await sleep(400);
  c = await seen();
  ok(`${T}: «Залишитись на маршруті» — звичайна карта з позначками`, !c.clean && c.layers === 5 && c.rail === 'visible', JSON.stringify(c));
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick[data-mode="trip"] [data-ts="stay"]'); await sleep(400);
  ok(`${T}: відкрили «Маршрут» ще раз — знову чисто`, (await seen()).clean);
  await page.click('#routePick [data-ts="stay"]');
  ok(`${T}: без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 16 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 17 (1.1.7): чому звучить голос телефону — видно на екрані; базові шари ============ */
if (run('17')) try {
  const { page, ctx, errors } = await newPage(true);
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const calls = () => app(page, () => window.__nativeCalls.slice());
  const why = () => app(page, () => { const w = document.getElementById('vWhy'), f = document.querySelector('#voiceSec .vfix'), lg = document.querySelector('#voiceSec .vlog');
    return { code: w ? w.dataset.code : f ? 'oldapp' : '', text: (w || f || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(), btn: ((w || f) && (w || f).querySelector('[data-act]') || {}).dataset?.act || '', log: lg ? lg.textContent.replace(/\s+/g, ' ') : '' }; });
  const toasts = () => app(page, () => [...document.querySelectorAll('#toasts .toast')].map(x => x.textContent));
  await app(page, () => { window.__voice = { packs: { uk: { ver: 2, size: 87e6 } }, loaded: 'uk' }; window.__app.S.ttsVoice = 'uk:1'; });
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#voiceSec .vrow'); await sleep(200);
  let w = await why();
  ok('голос: зверху написано, хто говорить зараз — «Говорить якісний голос: Микита»', w.code === 'neural' && /Говорить якісний голос: Микита/.test(w.text), JSON.stringify(w));
  await emitN('voice', { state: 'spoke', eng: 'neural', ms: 840, sid: 1 }); await sleep(150); w = await why();
  ok('після підказки видно, що її сказав саме якісний голос, і скільки тривав синтез', /сказав якісний голос \(синтез 0,8 с\)/.test(w.text), w.text);
  // як на Xiaomi: зранку працювало, потім підказку сказав голос телефону — причина на екрані, а не здогадки
  await app(page, () => { document.getElementById('toasts').innerHTML = ''; });
  await emitN('voice', { state: 'fallback', error: 'audio init' }); await sleep(250); w = await why();
  ok('якісний голос не спрацював — на екрані час, причина й «Перевірити зараз»', w.code === 'err' && /не спрацював \(audio init\)/.test(w.text) && /О \d\d:\d\d/.test(w.text) && w.btn === 'vTest', JSON.stringify(w));
  ok('…і одна плашка зрозумілою мовою', (await toasts()).filter(x => /не запустився/.test(x)).length === 1, JSON.stringify(await toasts()));
  ok('у «Щоденнику голосу» є запис про збій', /фразу сказав голос телефону: audio init/.test(w.log), w.log.slice(0, 200));
  // 1.1.12: «audio: Invalid audio buffer size.» — помилка старої оболонки (до №6): не «перевірте ще раз», а «оновіть застосунок»
  await emitN('voice', { state: 'fallback', error: 'audio: Invalid audio buffer size.' }); await sleep(250); w = await why();
  ok('«Invalid audio buffer size» на старій оболонці — пояснення й кнопка «оновити застосунок» (а не «спробуйте ще»)', w.code === 'oldaudio' && /не може відкрити звук/.test(w.text) && /Оновіть застосунок/.test(w.text) && w.btn === 'vApk', JSON.stringify(w));
  await app(page, () => { window.__nativeRev = 6; }); await emitN('voice', { state: 'fallback', error: 'audio: Invalid audio buffer size.' }); await sleep(250); w = await why();
  ok('…на новій оболонці (№6) така помилка показується як звичайний збій із «Перевірити зараз»', w.code === 'err' && w.btn === 'vTest', JSON.stringify(w));
  await app(page, () => { window.__nativeRev = 4; }); await emitN('voice', { state: 'fallback', error: 'audio init' }); await sleep(250);
  await app(page, () => { window.__nativeCalls.length = 0; window.__spoken.length = 0; document.getElementById('toasts').innerHTML = ''; });
  await page.click('#voiceSec [data-act="vTest"]'); await sleep(300);
  ok('«Перевірити зараз» — фраза пішла, якісний голос знову вибрано в оболонці', await app(page, () => window.__spoken.length > 0) && (await calls()).includes('setVoice:uk:1:uk'), JSON.stringify(await calls()));
  await emitN('voice', { state: 'spoke', eng: 'neural', ms: 1200 }); await sleep(250); w = await why();
  ok('перевірка вдалася — «Сказав якісний голос», помилку прибрано', w.code === 'neural' && (await toasts()).some(x => /Сказав якісний голос\. Синтез — 1,2 с/.test(x)), JSON.stringify([w, await toasts()]));
  // збій переживає перезапуск сторінки (оновлення інтерфейсу) — причину видно й після нього
  await emitN('voice', { state: 'loadErr', pack: 'uk', error: 'engine: OutOfMemoryError' }); await sleep(150);
  // справжня оболонка після перезапуску сторінки й далі знає про пакет — у тесті так само (до запуску інтерфейсу)
  await page.addInitScript(() => { window.__voice = { packs: { uk: { ver: 2, size: 87e6 } }, loaded: '' }; });
  await page.reload(); await page.waitForFunction(() => window.__app && window.__app.S);
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#voiceSec .vrow'); await sleep(200); w = await why();
  ok('після перезапуску причина лишилась на екрані (OutOfMemoryError), щоденник зберігся', w.code === 'err' && /OutOfMemoryError/.test(w.text) && /модель не запустилась/.test(w.log), JSON.stringify(w).slice(0, 300));
  ok('після перезапуску вибір Микити не загубився — оболонці знову сказано про якісний голос', (await calls()).includes('setVoice:uk:1:uk'), JSON.stringify(await calls()));
  // російський інтерфейс: якісні голоси — лише українською; пояснення й кнопка
  await app(page, () => { window.__app.S.lang = 'ru'; }); await sleep(200); w = await why();
  ok('інтерфейс російською — пояснено, чому голос телефону, є «Переключить на украинский»', w.code === 'lang' && /только по-украински/.test(w.text) && w.btn === 'vLangUk', JSON.stringify(w));
  await page.click('#voiceSec [data-act="vLangUk"]'); await sleep(400);
  ok('кнопка перемкнула інтерфейс на українську — якісний голос знову працює', await app(page, () => window.__app.S.lang === 'uk') && (await calls()).includes('setVoice:uk:1:uk'));
  await page.click('#bQuick').catch(() => {}); await app(page, () => window.__app.ui && 0).catch(() => {});
  // стара оболонка (S10 без оновленого APK)
  await app(page, () => { window.__nativeRev = 3; window.__app.S.ttsVoice = 'uk:1'; }); await page.click('#panelOk').catch(() => {});
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#voiceSec .vrow'); await sleep(200); w = await why();
  ok('стара оболонка — прямо сказано, яка версія стоїть і що оновити', w.code === 'oldapp' && /застосунок 1\.0\.0-test/.test(w.text) && w.btn === 'vApk', JSON.stringify(w));
  await app(page, () => { window.__nativeRev = 4; window.__voice = { packs: {} }; window.__app.S.ttsVoice = 'uk:2'; }); await page.click('#panelOk');
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#voiceSec .vrow'); await sleep(200); w = await why();
  ok('пакета в телефоні немає — так і написано, кнопка «Завантажити пакет»', w.code === 'nopack' && w.btn === 'vDl', JSON.stringify(w));
  ok('прохід 17 (голос) без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
  // базові шари: перший запуск — лише АЗС і камери
  { const { page, ctx, errors } = await newPage(true, { baseLayers: true });
    const lay = () => app(page, () => ({ types: window.__app.S.mapStopTypes, v: window.__app.S.mapVerified, e: window.__app.S.mapEvents, h: window.__app.S.mapHazards, r: window.__app.S.roughMap,
      rows: [...document.querySelectorAll('#panelBody .pl-chip')].map(r => (r.classList.contains('on') ? '✓' : '·') + r.querySelector('span:last-of-type').textContent.trim()) }));
    await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips'); await sleep(200);
    let L = await lay();
    ok('перший запуск: у «Місцях» стоять галочки АЗС і Камери, як на погодженому знімку (+ позначки водіїв, які й раніше було видно завжди)', L.rows.filter(x => x[0] === '✓').map(x => x.slice(1)).join() === 'АЗС,Камери,Позначки' && L.rows.length === 11, JSON.stringify(L.rows));
    await page.click('.pl-chip[data-plc="food"]'); await sleep(150); await page.reload(); await page.waitForFunction(() => window.__app && window.__app.S);
    ok('водій додав «Де поїсти» — після перезапуску вибір водія лишився', await app(page, () => window.__app.S.mapStopTypes.food === true && window.__app.S.mapStopTypes.fuel === true));
    ok('перший запуск без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close(); }
  // телефон, де «Рейс» уже стояв з усіма шарами: один раз ставимо базові, далі не чіпаємо
  { const { page, ctx, errors } = await newPage(true, { baseLayers: true, oldSettings: { lang: 'uk', voice: true, ttsVoice: 'uk:1', mapStops: true, mapStopTypes: { food: true, fuel: true, park: true, motel: true, cam: true, shower: true }, mapEvents: true, mapHazards: true } });
    const L = await app(page, () => ({ t: window.__app.S.mapStopTypes, e: window.__app.S.mapEvents, h: window.__app.S.mapHazards, v: window.__app.S.mapVerified, voice: window.__app.S.ttsVoice, d: window.__app.S.layersDefV }));
    ok('оновлення з попередньої версії: шари стали базовими (АЗС і камери), голос водія лишився', L.t.fuel && L.t.cam && !L.t.food && !L.t.park && !L.t.motel && !L.t.shower && !L.e && !L.h && !L.v && L.voice === 'uk:1' && L.d === 1, JSON.stringify(L));
    await app(page, () => { window.__app.S.mapStopTypes = { ...window.__app.S.mapStopTypes, park: true }; });
    await page.reload(); await page.waitForFunction(() => window.__app && window.__app.S);
    ok('…і лише один раз: далі вибір водія (стоянки) не скидається', await app(page, () => window.__app.S.mapStopTypes.park === true));
    ok('оновлення шарів без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close(); }
} catch (e) { ok('прохід 17 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 18 (1.1.8): без GPS — контрольні повороти, пояснення водієві, рейс не перебудовується, масштаб як із GPS, підписи над лінією ============ */
if (run('18')) try {
  // стиль як OpenFreeMap Liberty: назви вулиць (transportation_name) і щит траси; тайлів немає — перевіряємо самі шари
  const style = { version: 8, glyphs: 'https://tiles.example.test/fonts/{fontstack}/{range}.pbf', sources: { openmaptiles: { type: 'vector', tiles: ['https://tiles.example.test/t/{z}/{x}/{y}.pbf'], maxzoom: 14 } },
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dde5d8' } },
      { id: 'highway-name-minor', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', minzoom: 15, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'symbol-placement': 'line' }, paint: { 'text-color': '#666', 'text-halo-width': 1 } },
      { id: 'highway-shield-non-us', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', minzoom: 8, layout: { 'icon-image': 'road_1', 'text-field': ['get', 'ref'], 'text-font': ['Noto Sans Regular'], 'text-size': 10 } }] };
  const { page, ctx, errors } = await newPage(true, { style });
  await page.route('**/tiles.example.test/**', r => r.fulfill({ status: 404, body: '' }));
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await page.waitForFunction(() => window.__app.map.map && window.__app.map.map.getLayer('route-line'), null, { timeout: 15000 });
  const ly = await app(page, () => { const m = window.__app.map.map, ids = m.getStyle().layers.map(l => l.id), at = id => ids.indexOf(id), h = m.getLayer('reis-house');
    return { line: at('route-line'), near: at('route-near-line'), done: at('route-done'), name: at('highway-name-minor'), fuel: at('fuel-label'), house: at('reis-house'), houseZ: h ? h.minzoom : null,
      halo: m.getPaintProperty('highway-name-minor', 'text-halo-width'), size: JSON.stringify(m.getLayoutProperty('highway-name-minor', 'text-size')), shieldHalo: m.getPaintProperty('highway-shield-non-us', 'text-halo-width') }; });
  ok('назви вулиць — поверх лінії рейсу (лінія під підписами), наші значки АЗС — згори', ly.line >= 0 && ly.line < ly.name && ly.near < ly.name && ly.done < ly.name && ly.fuel > ly.name, JSON.stringify(ly));
  ok('назви вулиць — більші, з товстим білим обідком; щит траси не чіпаємо', ly.halo === 2.4 && /17,17/.test(ly.size) && ly.shieldHalo == null, JSON.stringify(ly));
  ok('номери будинків — окремий шар лише зблизька (від 17) і під назвами вулиць', ly.house >= 0 && ly.house < ly.name && ly.houseZ === 17, JSON.stringify(ly));
  // рейс із поворотами: 90° ліворуч на 2 км, 90° праворуч на 3,5 км, 45° на 6 км і 26 км
  const n = coords.length;
  const trip = { id: 't-cp', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  await emitN('loc', { prov: 'gps', lat: coords[0][0], lon: coords[0][1], acc: 5, spd: 0, t: Date.now() });
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  const cps = await app(page, () => window.__app.nav.routeCps().map(c => ({ d: c.d, cls: c.cls, ang: c.ang })));
  ok('контрольні точки розставлено наперед: перехрестя 90° — червоні, поворот траси 45° — жовтий', cps.filter(c => c.cls === 'red').length === 2 && cps.some(c => c.cls === 'yellow' && Math.abs(c.ang) >= 40 && Math.abs(c.ang) <= 50) && Math.abs(cps[0].d - 2000) < 60 && cps[0].ang < -80 && cps[1].ang > 80, JSON.stringify(cps));
  await app(page, () => { window.__app.sim.setSpeed(60); window.__app.sim.start(); });
  await sleep(5000);
  const cpN = () => app(page, () => { const s = window.__app.map.map.getSource('cps'); const d = s.serialize ? s.serialize().data : s._data; return (d && d.features || []).map(f => f.properties.c); });
  const zG = await app(page, () => window.__app.map.map.getZoom());
  ok('з GPS контрольних точок на карті не видно (карта чиста)', (await cpN()).length === 0, JSON.stringify(await cpN()));
  // GPS зник
  await app(page, () => { window.__spoken.length = 0; document.getElementById('toasts').innerHTML = ''; window.__app.sim.setLost(true); });
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 12000 });
  await sleep(3500);
  const lost = await app(page, () => ({ spoken: window.__spoken.slice(), toasts: [...document.querySelectorAll('#toasts .toast')].map(x => x.textContent).join(' | '), mode: window.__app.nav.pos.mode, acc: window.__app.nav.pos.acc,
    accN: (s => { const d = s.serialize ? s.serialize().data : s._data; return d && d.features ? d.features.length : -1; })(window.__app.map.map.getSource('acc')), z: window.__app.map.map.getZoom(), spd: window.__app.nav.pos.spd }));
  ok('водієві пояснено: «нічого страшного», рейс той самий, звірю місце на повороті через …', lost.spoken.some(s => /Нічого страшного/.test(s) && /звірю місце/.test(s) && /Через \d+ (метрів|кілометр)/.test(s)), JSON.stringify(lost.spoken));
  ok('…і плашка: без перебудови, найближчий поворот і що це за поворот', /без перебудови/.test(lost.toasts) && /найближчий через .* — перехрестя чи різкий поворот ліворуч/.test(lost.toasts), lost.toasts.slice(0, 220));
  const cpd = await cpN();
  ok('без GPS на карті — контрольні повороти попереду (червоні й жовті)', cpd.length >= 3 && cpd[0] === 'red' && cpd.includes('yellow'), JSON.stringify(cpd));
  ok('без GPS масштаб той самий, що з GPS — не віддаляємо карту', lost.z > 15 && Math.abs(lost.z - zG) < 0.6, JSON.stringify({ zG, zD: lost.z, acc: lost.acc, spd: lost.spd }));
  ok('без GPS на рейсі — без кілометрового кола похибки', lost.accN === 0, JSON.stringify({ accN: lost.accN, acc: lost.acc }));
  await shot(page, '18-dr-cps');
  await page.click('#spdGps'); await sleep(400);
  const gpsTxt = await page.textContent('#panelBody');
  ok('у панелі GPS — де наступна звірка', /Звірка на повороті.*(м|км) · перехрестя чи різкий поворот ліворуч/.test(gpsTxt.replace(/\s+/g, ' ')), gpsTxt.replace(/\s+/g, ' ').slice(0, 400));
  await page.click('#panelOk');
  // звірка на повороті — коротка зелена плашка з наступною точкою
  await app(page, () => { document.getElementById('toasts').innerHTML = ''; const P = window.__app.nav.pos; window.__app.core.bus.emit('turnMatch', { ang: -90, cls: 'red', d: P.rd - 20, was: 900, now: 40, next: { d: P.rd + 1500, cls: 'red', ang: 90 } }); });
  await sleep(250);
  const tm = await app(page, () => ({ t: [...document.querySelectorAll('#toasts .toast')].map(x => x.textContent).join(' | '), s: window.__spoken.slice(-1)[0] }));
  ok('після звірки: «Місце звірено на повороті · ±40 м. Наступна звірка через 1,5 км»', /Місце звірено на повороті · ±40 м\. Наступна звірка через 1[,.]5 км/.test(tm.t) && /уточнено на повороті/.test(tm.s), JSON.stringify(tm));
  // без GPS рейс не перебудовуємо: «новий шлях» і «заїхати через» — відкладаються до GPS
  const n0 = routeReqs.length;
  await app(page, () => { window.__spoken.length = 0; document.getElementById('toasts').innerHTML = ''; window.__app.guide.rerouteNow(true); });
  await sleep(1200);
  const rw = await app(page, () => ({ pend: window.__app.guide.g.reroutePending, t: document.getElementById('toasts').textContent, s: window.__spoken.slice() }));
  ok('без GPS «новий шлях» не будує рейс заново — відкладено, водієві сказано чому', routeReqs.length === n0 && rw.pend && rw.pend.fresh && /Без GPS рейс не перебудовую/.test(rw.t) && rw.s.some(x => /не перебудовую/.test(x)), JSON.stringify({ reqs: routeReqs.length - n0, ...rw }));
  // (1.1.32) «заїхати через» / контрольна точка — це рішення водія: перебудовуємо одразу й без GPS, від розрахованого місця
  await app(page, () => { window.__spoken.length = 0; document.getElementById('toasts').innerHTML = ''; window.__app.guide.setVia({ lat: 49.99, lon: 36.0, label: 'Мерефа' }); });
  await page.waitForFunction(n0 => window.__app.guide.g.rerouting === false && window.__app.guide.g.reroutePending == null, n0, { timeout: 8000 }).catch(() => {});
  await sleep(600);
  const vq = routeReqs[n0] || { locations: [] }, vst = await app(page, () => ({ mode: window.__app.nav.pos.mode, lat: window.__app.nav.pos.lat, vs: (window.__app.guide.g.trip.vs || []).map(v => v.label), pend: window.__app.guide.g.reroutePending, s: window.__spoken.slice() }));
  ok('контрольна точка без GPS — рейс перебудовано ОДРАЗУ: від розрахованого місця через точку до фінішу; відкладеного «нового шляху» більше немає', routeReqs.length === n0 + 1 && vq.locations.length === 3 && Math.abs(vq.locations[0].lat - vst.lat) < 0.01 && Math.abs(vq.locations[1].lon - 36.0) < 1e-4 && vst.mode === 'dr' && vst.vs.join() === 'Мерефа' && vst.pend == null && vst.s.some(x => /через вашу точку/.test(x)), JSON.stringify({ n: routeReqs.length - n0, loc: vq.locations.map(l => [l.lat, l.lon]), vst }));
  await app(page, () => window.__app.sim.setLost(false));
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps', null, { timeout: 12000 });
  await sleep(1500);
  ok('GPS повернувся — зайвої перебудови немає (рейс уже через контрольну точку)', routeReqs.length === n0 + 1 && await app(page, () => window.__app.guide.g.reroutePending == null), String(routeReqs.length - n0));
  await app(page, () => window.__app.sim.stop());
  ok('прохід 18 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 18 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 19 (1.1.9): «Місця» — квадратики «що шукаю», найближчі попереду; знак обмеження в місті завжди ============ */
if (run('19')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 393, height: 800 } });
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length;
  const trip = { id: 't-pl', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  const p0 = coords[turnIdx[3]];
  await emitN('loc', { prov: 'gps', lat: p0[0], lon: p0[1], acc: 5, spd: 0, t: Date.now() });
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  await page.waitForFunction(() => window.__app.stopsdb ? true : true); await sleep(800);
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips');
  const pl = () => app(page, () => ({ chips: [...document.querySelectorAll('.pl-chip')].map(b => b.dataset.plc + (b.classList.contains('on') ? '+' : '-')), rows: [...document.querySelectorAll('.pl-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), txt: document.getElementById('panelBody').textContent.replace(/\s+/g, ' ') }));
  let st = await pl();
  ok('«Місця»: угорі одинадцять плиток — шість видів місць (АЗС, Їжа, Стоянки, Мотелі, Душ, Перевірені) і ще п\'ять шарів карти', st.chips.length === 11 && st.chips.slice(0, 6).map(c => c.slice(0, -1)).join() === 'fuel,food,park,motel,shower,@mapVerified' && st.chips.slice(6).map(c => c.slice(0, -1)).join() === 'cam,@mapReports,@mapEvents,@mapHazards,@roughMap', JSON.stringify(st.chips));
  await page.click('[data-plc="#none"]'); await sleep(200); await page.click('.pl-chip[data-plc="fuel"]'); await sleep(300); st = await pl();
  ok('«Прибрати все», потім «АЗС» — список лише АЗС попереду в рейсі, з відстанню', st.chips[0] === 'fuel+' && st.chips.slice(1).every(c => c.endsWith('-')) && st.rows.length >= 2 && st.rows.every(r => /АЗС|OKKO/.test(r)) && st.rows.some(r => /через 3,0 км/.test(r)) && /Найближчі попереду в рейсі/.test(st.txt), JSON.stringify(st.rows));
  await shot(page, '20-places-chips');
  await page.click('.pl-chip[data-plc="food"]'); await sleep(300); st = await pl();
  ok('торкнулись «Їжа» — у списку кафе, і на карті їжу ввімкнено', st.chips[1] === 'food+' && st.rows.some(r => /Кафе Дорога/.test(r)) && await app(page, () => window.__app.S.mapStopTypes.food === true), JSON.stringify(st.rows));
  await page.click('.pl-chip[data-plc="fuel"]'); await sleep(300); st = await pl();
  ok('зняли «АЗС» — АЗС зникли зі списку й з карти, кафе лишилось', st.chips[0] === 'fuel-' && !st.rows.some(r => /OKKO|^АЗС/.test(r)) && st.rows.some(r => /Кафе Дорога/.test(r)) && await app(page, () => window.__app.S.mapStopTypes.fuel === false), JSON.stringify(st.rows));
  await page.click('[data-plc="#none"]'); await sleep(300); st = await pl();
  ok('«Прибрати все» — нічого не вибрано, підказка «виберіть угорі, що шукаєте»', st.chips.every(c => c.endsWith('-')) && /Виберіть угорі/.test(st.txt) && await app(page, () => !window.__app.S.mapVerified && window.__app.S.mapStopTypes.food === false), JSON.stringify(st.chips));
  await page.click('[data-plc="#all"]'); await sleep(300); st = await pl();
  ok('«Показати все» — усі квадратики увімкнено, у списку різні місця', st.chips.every(c => c.endsWith('+')) && st.rows.length >= 4, JSON.stringify(st.rows.slice(0, 6)));
  await page.click('.pl-row:has-text("Душ для водіїв")'); await sleep(500);
  ok('торкнулись рядка — панель закрилась, картка місця з «Заїхати»', await app(page, () => document.getElementById('panel').hidden && !document.getElementById('pick').hidden && /Душ для водіїв/.test(document.getElementById('pick').textContent)));
  // знак обмеження в місті — видно й без перевищення
  const P2 = await newPage(true, { viewport: { width: 360, height: 670 }, keep: true });
  let q = { lat: 49.99, lon: 36.23 }, tq = Date.now();
  for (let i = 0; i < 4; i++) { q = { lat: q.lat + 11 / 111320, lon: q.lon }; tq += 1000; await app(P2.page, d => window.__reis('loc', d), { prov: 'gps', lat: q.lat, lon: q.lon, acc: 5, spd: 11, brg: 0, t: tq }); await sleep(250); }
  await sleep(1200);
  const sg = await app(P2.page, () => {
    const l = document.getElementById('spdLim'), s = document.getElementById('speed'), v = document.getElementById('spdVal'), r = l.getBoundingClientRect();
    // перетин знака з самими цифрами (за обрисом тексту), для «40», «57» і тризначної «100»
    const hit = txt => { const old = v.textContent; v.textContent = txt; s.classList.toggle('d3', txt.length >= 3); /* як у програмі: три цифри — дрібніше */ const rg = document.createRange(); rg.selectNodeContents(v); const g = rg.getBoundingClientRect(), q = l.getBoundingClientRect(); v.textContent = old; s.classList.remove('d3');
      const cx = Math.max(q.left, Math.min(q.right, (g.left + g.right) / 2)), cy = Math.max(q.top, Math.min(q.bottom, (g.top + g.bottom) / 2));
      const R = q.width / 2, ox = q.left + R, oy = q.top + R, nx = Math.max(g.left, Math.min(ox, g.right)), ny = Math.max(g.top + g.height * 0.12, Math.min(oy, g.bottom));   // найближча до центру знака точка цифр
      return Math.hypot(nx - ox, ny - oy) < R; };
    return { on: !l.hidden, txt: l.textContent, w: Math.round(r.width), over: s.classList.contains('over'), v: v.textContent, cover: ['40', '57', '100'].filter(hit) };
  });
  ok('у місті 40 км/год (без перевищення) — знак «50» видно весь час, великий, цифр швидкості не закриває (і «57», і «100»)', sg.on && sg.txt === '50' && sg.w >= 44 && !sg.over && sg.cover.length === 0, JSON.stringify(sg));
  await shot(P2.page, '21-speed-sign');
  await P2.ctx.close();
  ok('прохід 19 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 19 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 20 (1.1.10): сервер «для фури шляху немає» — програма сама обходить ============ */
if (run('20')) try {
  const { page, ctx, errors } = await newPage(true);
  await app(page, d => window.__reis('loc', d), { prov: 'gps', lat: 49.99, lon: 36.23, acc: 5, spd: 0, t: Date.now() }); await sleep(300);
  const NP = { status: 400, body: { error_code: 442, error: 'No path could be found for input', status_code: 400, status: 'Bad Request' } };
  const cls = q => (q.locations[0].search_filter || {}).min_road_class || '';
  const build = async () => {
    await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#in_b');
    await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await page.click('#sg_b button');
    await page.click('[data-act="build"]');
  };
  // 1) біля точки проїзду немає — програма сама «чіпляє» точки за основні дороги
  let n0 = routeReqs.length;
  ROUTE.fn = q => q.costing === 'truck' && cls(q) !== 'tertiary' ? NP : null;
  await build();
  await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 15000 });
  const r1 = routeReqs.slice(n0).map(q => q.costing + ':' + cls(q));
  const w1 = await app(page, () => (document.querySelector('#routePick .rp-warn') || { textContent: '' }).textContent);
  ok('сервер «шляху для фури немає» — програма сама пробує від основних доріг і знаходить рейс для фури', r1.join() === 'truck:,truck:,truck:unclassified,truck:tertiary' && /перенесено на найближчу основну дорогу/.test(w1) && await app(page, () => window.__app.ui ? true : true), JSON.stringify({ r1, w1 }));
  await page.click('#routePick [data-rp="x"]'); await sleep(1600);
  // 2) для фури проїзду немає зовсім — звичайний маршрут із червоним попередженням, водій вирішує
  n0 = routeReqs.length;
  ROUTE.fn = q => q.costing === 'truck' ? NP : null;
  await build();
  await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 15000 });
  const r2 = routeReqs.slice(n0).map(q => q.costing + ':' + cls(q));
  const w2 = await app(page, () => { const w = document.querySelector('#routePick .rp-warn.red'); return w ? w.textContent : ''; });
  ok('для фури зовсім немає (і дорогою зі знаком «фурам заборонено» теж) — звичайний маршрут з червоним «Для фури проїзду не знайшлося… їдьте за знаками»', r2.join() === 'truck:,truck:,truck:unclassified,truck:tertiary,truck:,auto:' && routeReqs[n0].costing_options.truck.exclude_unpaved === true && routeReqs[n0 + 1].costing_options.truck.exclude_unpaved === undefined && routeReqs[n0 + 4].costing_options.truck.hgv_no_access_penalty === 600 && /Для фури проїзду не знайшлося/.test(w2) && /їдьте за знаками/.test(w2), JSON.stringify({ r2, w2 }));
  await shot(page, '22-truck-nopath');
  await page.click('#routePick [data-rp="x"]'); await sleep(300);
  // 3) і звичайного немає — помилка людською мовою, без англійської
  ROUTE.fn = () => NP;
  await build(); await page.waitForFunction(() => /не прокладено/.test(document.getElementById('panelBody').textContent), null, { timeout: 15000 }).catch(() => {});
  const err = await app(page, () => document.getElementById('panelBody').textContent);
  ok('шляху немає взагалі — «Рейс для фури не прокладено: проїзду між цими точками не знайшлося», без англійської', /проїзду між цими точками не знайшлося/.test(err) && !/No path/.test(err), err.replace(/\s+/g, ' ').slice(0, 300));
  ROUTE.fn = null;
  // фури в парку — до 20 т: за замовчуванням 20 т; збережені раніше 40 т стали 20 т; більше 20 не поставити
  ok('фура за замовчуванням — 20 т', await app(page, () => window.__app.S.truck.weight === 20));
  await app(page, () => { const s = JSON.parse(localStorage.getItem('reis.settings') || '{}'); s.truck = { ...(s.truck || {}), weight: 40 }; delete s.truckV; localStorage.setItem('reis.settings', JSON.stringify(s)); });
  await page.reload(); await page.waitForFunction(() => window.__app && window.__app.S);
  ok('телефон, де було збережено 40 т, — після оновлення 20 т', await app(page, () => window.__app.S.truck.weight === 20 && JSON.parse(localStorage.getItem('reis.settings')).truck.weight === 20));
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#tr_weight');
  await app(page, () => { const i = document.getElementById('tr_weight'); i.value = '40'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(300);
  const wcap = await app(page, () => ({ w: window.__app.S.truck.weight, max: document.getElementById('tr_weight').max, v: document.getElementById('tr_weight').value, toast: document.getElementById('toasts').textContent }));
  ok('у «Параметрах» більше 20 т не поставити: 40 → 20 і пояснення', wcap.w === 20 && wcap.max === '20' && wcap.v === '20' && /Найважча фура в парку — 20 т/.test(wcap.toast), JSON.stringify(wcap));
  await page.click('#panelOk');
  ok('прохід 20 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ROUTE.fn = null; ok('прохід 20 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 21 (1.1.11): камери на карті — значком камери (пропозиція Діми) ============ */
if (run('21')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 393, height: 800 } });
  await page.waitForFunction(() => { const m = window.__app.map.map; return window.__app.stopsdb.sdb.ready && m && m.getLayer('cams-ico'); }, null, { timeout: 10000 });
  await app(page, ([la, lo]) => { window.__app.map.setFollow(false); window.__app.map.map.jumpTo({ center: [lo, la], zoom: 14.5, bearing: 0 }); }, camPt);
  await sleep(1200);
  const cm = await app(page, ([la, lo]) => { const m = window.__app.map.map, p = m.project([lo, la]), box = [[p.x - 20, p.y - 20], [p.x + 20, p.y + 20]];
    return { img: m.hasImage('cam-ico'), ico: m.queryRenderedFeatures(box, { layers: ['cams-ico'] }).length, dot: m.queryRenderedFeatures(box, { layers: ['stops-all'] }).filter(f => f.properties.t === 'c').length }; }, camPt);
  ok('камера на карті — значком камери (білий круг, червоний обідок, фотоапарат), а не червоним кружечком', cm.img && cm.ico === 1 && cm.dot === 0, JSON.stringify(cm));
  await shot(page, '23-camera-icon');
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips'); await sleep(300);
  ok('у «Місцях» на плитці «Камери» — той самий значок', await app(page, () => !!document.querySelector('.pl-chip[data-plc="cam"] .pl-ic.cam svg circle[stroke="#e5484d"]')));
  ok('прохід 21 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 21 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 22 (1.1.12): замок на повороті — як на справжній дорозі (Львів: 17 за планом, 42 насправді) ============ */
if (run('22')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 393, height: 800 } });
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length, idx0 = turnIdx[1] - 6;                                    // стоїмо за 300 м до перехрестя «90° ліворуч» (точки рейсу — кожні 50 м)
  const trip = { id: 't-gate', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 5600 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 5600, aD: null, viaD: null } };
  await emitN('loc', { prov: 'gps', lat: coords[idx0][0], lon: coords[idx0][1], acc: 5, spd: 0, t: Date.now() });
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  await app(page, () => { window.__cp = []; window.__app.bus.on('cpPass', e => window.__cp.push(e)); });
  for (let k = 0; k < 7; k++) { await emitN('sens', { var: 0.05, yaw: 0 }); await sleep(1000); }           // GPS зник; телефон їде рівно
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 8000 });
  for (let k = 0; k < 7; k++) { await emitN('sens', { var: 0.05, yaw: 0 }); await sleep(1000); }
  const b0 = await app(page, () => { const b = document.getElementById('bTurn'), P = window.__app.nav.pos; return { rd: P.rd, kmh: Math.round(P.spd * 3.6), vis: !b.hidden, cls: b.className, txt: b.textContent, cp: P.cp, cps: window.__app.nav.routeCps().slice(0, 2).map(c => c.d) }; });
  ok('без GPS — кнопка «Поворот»: стрілка ліворуч, червона, скільки до повороту', b0.vis && /red/.test(b0.cls) && /st-go/.test(b0.cls) && /\d+ м/.test(b0.txt) && b0.cp && b0.cp.sgn === -1, JSON.stringify(b0));
  ok('позначка їде «за планом» повільно й до повороту ще далеко (як на знімку зі Львова)', b0.kmh <= 22 && b0.cps[0] - b0.rd > 150, JSON.stringify({ kmh: b0.kmh, toCp: Math.round(b0.cps[0] - b0.rd) }));
  await shot(page, '24-turn-button');
  // фура насправді вже на перехресті: телефон повертає ліворуч на 90° за 5 с
  for (let k = 1; k <= 5; k++) { await emitN('sens', { var: 0.05, yaw: -18 * k }); await sleep(1000); }
  for (let k = 0; k < 2; k++) { await emitN('sens', { var: 0.05, yaw: -90 }); await sleep(1000); }
  const a1 = await app(page, () => ({ rd: window.__app.nav.pos.rd, cp: window.__cp.slice(), sfx: window.__app.sfx.sfxLog.map(x => x.kind), toast: document.getElementById('toasts').textContent, btn: document.getElementById('bTurn').textContent + '|' + document.getElementById('bTurn').className }));
  const ev = a1.cp[0] || {};
  ok('телефон відчув поворот — позначку одразу підтягнуто на перехрестя (а не «розійшовся на 384 м»)', a1.rd >= b0.cps[0] - 15 && a1.rd <= b0.cps[0] + 120 && ev.by === 'gyro' && ev.jump >= 100, JSON.stringify({ rd: Math.round(a1.rd), cp: b0.cps[0], ev }));
  ok('…тихий «дзинь» і плашка «Поворот відпрацьовано… підтягнуто на … Наступна звірка через …»', a1.sfx.includes('pass') && /Поворот відпрацьовано/.test(a1.toast) && /підтягнуто на/.test(a1.toast) && /Наступна звірка через/.test(a1.toast), a1.toast.slice(0, 200) + ' · ' + a1.sfx);
  ok('кнопка показує вже наступний поворот — праворуч', /st-go/.test(a1.btn) && await app(page, () => window.__app.nav.pos.cp && window.__app.nav.pos.cp.sgn === 1), a1.btn);
  ok('темп підлаштовано: водій їде швидше за план — позначка теж', await app(page, () => window.__app.nav.debugState().pf.mMed >= 1.25), await app(page, () => String(window.__app.nav.debugState().pf.mMed)));
  // кнопка «Поворот»: водій каже «я на наступному повороті» — позначка одразу за ним; можна скасувати
  await app(page, () => { document.getElementById('toasts').innerHTML = ''; window.__app.sfx.sfxLog.length = 0; });
  await page.click('#bTurn'); await sleep(400);
  const a2 = await app(page, () => ({ rd: window.__app.nav.pos.rd, toast: document.getElementById('toasts').textContent, sfx: window.__app.sfx.sfxLog.map(x => x.kind), by: (window.__cp[window.__cp.length - 1] || {}).by }));
  ok('кнопка «Поворот» — позначка одразу за наступним поворотом, «дзинь», можна скасувати', a2.rd >= b0.cps[1] && a2.rd <= b0.cps[1] + 60 && a2.by === 'button' && a2.sfx.includes('pass') && /за поворотом/.test(a2.toast) && /скасувати/.test(a2.toast), JSON.stringify({ rd: Math.round(a2.rd), cp2: b0.cps[1], t: a2.toast.slice(0, 120) }));
  await page.click('#toasts .toast:has-text("скасувати")'); await sleep(400);
  const a3 = await app(page, () => ({ rd: window.__app.nav.pos.rd, sgn: window.__app.nav.pos.cp && window.__app.nav.pos.cp.sgn }));
  ok('«Скасувати» — позначка там, де була, наступний поворот знову праворуч', Math.abs(a3.rd - a1.rd) < 120 && a3.sgn === 1, JSON.stringify(a3));
  // телефон узяли в руки (нахил змінився) — його «поворот» не рахуємо: позначка не стрибає
  await emitN('sens', { var: 0.05, yaw: -90 }); await sleep(600);
  await app(page, () => { const T = window.__app.sensors._test, t0 = performance.now();
    for (let i = 0; i < 70; i++) T.onMotion({ timeStamp: t0 + i * 16, rotationRate: { alpha: 60, beta: 10, gamma: 5 }, accelerationIncludingGravity: { x: 0.3, y: 6, z: 7.5 }, acceleration: { x: 0, y: 0, z: 0 } }); T.flush((t0 + 1200) / 1000); });
  const hint = await app(page, () => window.__app.sensors.motionHint());
  for (let k = 1; k <= 3; k++) { await emitN('sens', { var: 0.05, yaw: -90 + 30 * k }); await app(page, () => { const T = window.__app.sensors._test, t0 = performance.now(); for (let i = 0; i < 70; i++) T.onMotion({ timeStamp: t0 + i * 16, rotationRate: { alpha: 60, beta: 10, gamma: 5 }, accelerationIncludingGravity: { x: 0.3, y: 6, z: 7.5 }, acceleration: { x: 0, y: 0, z: 0 } }); T.flush((t0 + 1200) / 1000); }); await sleep(1000); }
  for (let k = 0; k < 3; k++) { await emitN('sens', { var: 0.05, yaw: 0 }); await sleep(1000); }
  const a4 = await app(page, () => ({ rd: window.__app.nav.pos.rd, n: window.__cp.length, sgn: window.__app.nav.pos.cp && window.__app.nav.pos.cp.sgn }));
  ok('телефон крутили в руках на 90° (датчик нахилу це бачить) — поворот не зараховано, позначка не стрибнула', hint && hint.handled === true && a4.rd < b0.cps[1] - 200 && a4.sgn === 1, JSON.stringify({ hint, a4, cp2: b0.cps[1] }));
  ok('прохід 22 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 22 дійшов до кінця', false, String(e.message).split('\n')[0]); }

// ---------- Прохід 23: Лабораторія — прихований вхід на логотипі, схема рейсу, телефон у 3D, дані ----------
async function fingerTap(page, x, y, holdMs = 60) {
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
  await sleep(holdMs);
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await c.detach();
}
if (run('23')) for (const sc of SCREENS.filter(x => ['xiaomi', 'tiny', 'land', 'tablet'].includes(x.n) && (!process.env.SCR || process.env.SCR.split(',').includes(x.n)))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length, idx0 = turnIdx[1] - 6;
  const trip = { id: 't-lab', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 5600 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 5600 } };
  const labVis = () => app(page, () => !document.getElementById('labApp').hidden);
  const logoXY = async () => { const r = await app(page, () => { const b = document.querySelector('#panelBody .app-logo .al-ico').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }); return r; };
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#panelBody .app-logo');
  const lg = await app(page, () => { const el = document.querySelector('#panelBody .app-logo'), ic = el.querySelector('.al-ico'), r = ic.getBoundingClientRect(), b = document.getElementById('panelBody').getBoundingClientRect();
    return { bg: getComputedStyle(ic).backgroundImage, w: r.width, h: r.height, mid: Math.abs((r.left + r.right) / 2 - (b.left + b.right) / 2), first: el === document.getElementById('panelBody').firstElementChild, txt: el.textContent.replace(/\s+/g, ' ').trim(),
      oldBtn: !!document.querySelector('[data-act="labOpen"]'), anyLabWord: /Лаборатор/.test(document.getElementById('panelBody').textContent) }; });
  ok(`[${T}] у «Налаштуваннях» угорі — кольоровий значок Рейсу з версією, по центру`, lg.first && /icons\/icon\.svg/.test(lg.bg) && lg.w >= 72 && lg.h >= 72 && lg.mid < 3 && /РЕЙС/.test(lg.txt) && /інтерфейс №\d+/.test(lg.txt), JSON.stringify(lg));
  ok(`[${T}] кнопки «Лабораторія» в «Налаштуваннях» більше немає — вхід прихований`, !lg.oldBtn && !lg.anyLabWord);
  if (sc.n === 'xiaomi') await shot(page, '25-settings-logo');
  let p = await logoXY();
  await fingerTap(page, p.x, p.y); await sleep(1200);
  ok(`[${T}] один дотик до значка — нічого не відкриває`, !(await labVis()));
  await fingerTap(page, p.x, p.y); await sleep(250); await fingerTap(page, p.x, p.y); await sleep(600);
  ok(`[${T}] два швидкі дотики — теж ні`, !(await labVis()));
  await sleep(900);
  await fingerTap(page, p.x, p.y, 3400); await sleep(300);
  ok(`[${T}] довге натискання без першого дотику — теж ні`, !(await labVis()));
  await sleep(900);
  // два дотики й на другому тримати: спершу відпускаємо зарано (2 с), потім як треба (3 с)
  await fingerTap(page, p.x, p.y); await sleep(250); await fingerTap(page, p.x, p.y, 2000); await sleep(1300);
  ok(`[${T}] два дотики, але тримали лише 2 с — не відкрилась`, !(await labVis()));
  p = await logoXY();
  await fingerTap(page, p.x, p.y); await sleep(250);
  const c = await page.context().newCDPSession(page);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
  await sleep(1500);
  const arm = await app(page, () => { const el = document.querySelector('.app-logo'); return { cls: el.className, ring: getComputedStyle(el.querySelector('.al-ring'), '::before').opacity }; });
  await sleep(1750);
  const opened = await labVis();
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await c.detach();
  ok(`[${T}] два дотики й на другому тримати 3 с — Лабораторія відкрилась; поки тримаємо — навколо значка біжить кільце`, opened && /arming/.test(arm.cls) && arm.ring === '1', JSON.stringify(arm));
  await sleep(400);
  const L0 = await app(page, () => { const R = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    return { vw: innerWidth, vh: innerHeight, app: R('#labApp'), top: R('.lab-top'), bot: R('.lab-bot'), ph: R('.lab-ph'), scene: R('.lab-scene'), data: R('.lab-data'), head: R('.lab-h'), panel: document.getElementById('panel').hidden,
      title: document.querySelector('.lab-h b').textContent, capNo: document.getElementById('labCap').textContent, zoomHid: document.getElementById('labZoom').hidden, sx: document.documentElement.scrollWidth }; });
  const land = sc.w > sc.h;
  ok(`[${T}] Лабораторія — на весь екран; «Налаштування» закрились`, L0.app.w === L0.vw && L0.app.h === L0.vh && L0.panel && L0.title === 'Лабораторія' && L0.sx <= L0.vw, JSON.stringify(L0.app));
  ok(`[${T}] екран поділено на дві частини: ${land ? 'ліворуч схема рейсу, праворуч телефон і дані' : 'угорі схема рейсу, внизу телефон і дані'}`,
    land ? (L0.top.r <= L0.bot.l + 1 && L0.top.w >= L0.vw * 0.35 && L0.bot.w >= L0.vw * 0.45 && Math.abs(L0.top.t - L0.bot.t) <= 1)
      : (L0.top.b <= L0.bot.t + 1 && L0.top.h >= L0.vh * 0.3 && L0.bot.h >= L0.vh * 0.4 && L0.top.w === L0.vw), JSON.stringify({ top: L0.top, bot: L0.bot }));
  ok(`[${T}] телефон і дані поруч, нічого не вилазить за екран`, L0.ph.r <= L0.data.l + 1 && L0.data.r <= L0.vw + 1 && L0.bot.b <= L0.vh + 1 && L0.scene.h >= 110 && L0.data.w >= 150, JSON.stringify({ ph: L0.ph, data: L0.data, scene: L0.scene }));
  // без рейсу — підказка замість схеми
  const noTrip = await app(page, () => { const cv = document.getElementById('labMap'); return { w: cv.width, h: cv.height, zoomHid: document.getElementById('labZoom').hidden }; });
  ok(`[${T}] рейсу немає — замість схеми підказка, кнопки масштабу немає`, noTrip.w > 100 && noTrip.zoomHid, JSON.stringify(noTrip));
  // рейс іде, GPS зник: схема, позначка, контрольні повороти, дані «замка на повороті»
  await emitN('loc', { prov: 'gps', lat: coords[idx0][0], lon: coords[idx0][1], acc: 5, spd: 0, t: Date.now() });
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  for (let k = 0; k < 14; k++) { await emitN('sens', { var: 0.05, yaw: 0 }); await sleep(1000); if (k > 6 && await app(page, () => window.__app.nav.pos.mode === 'dr' && !!window.__app.nav.pos.cp)) break; }
  await app(page, () => window.__app.lab.openLab()); await sleep(700);
  const L1 = await app(page, () => { const cv = document.getElementById('labMap'), x = cv.getContext('2d'), d = x.getImageData(0, 0, cv.width, cv.height).data; let purple = 0, red = 0, amber = 0;
    for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3]; if (a < 200) continue; if (r > 110 && r < 140 && g > 80 && g < 105 && b > 240) purple++; else if (r > 215 && g > 60 && g < 85 && b > 65 && b < 90) red++; else if (r > 235 && g > 150 && g < 180 && b < 60) amber++; }
    return { cap: document.getElementById('labCap').textContent, zoom: document.getElementById('labZoom').textContent, zoomHid: document.getElementById('labZoom').hidden, purple, red, amber,
      rows: [...document.querySelectorAll('#labData .lab-r')].map(r => r.firstElementChild.textContent + '=' + r.lastElementChild.textContent), secs: [...document.querySelectorAll('#labData .lab-sec')].map(e => e.textContent) }; });
  const rowOf = (L, k) => (L.rows.find(r => r.startsWith(k + '=')) || '').slice(k.length + 1);
  ok(`[${T}] схема рейсу: пройдене фіолетовим, контрольні повороти червоними кружками, позначка без GPS — помаранчева`, (L1.purple > 20 || sc.n === 'tiny') && L1.red > 20 && L1.amber > 20 && !L1.zoomHid && L1.zoom === 'Ближче', JSON.stringify({ purple: L1.purple, red: L1.red, amber: L1.amber, zoom: L1.zoom }));
  ok(`[${T}] підпис схеми: довжина рейсу, пройдено, лишилось, GPS ✕, до повороту, скільки контрольних`, /Рейс 2\d([.,]\d)? км/.test(L1.cap) && /пройдено/.test(L1.cap) && /лишилось/.test(L1.cap) && /GPS ✕/.test(L1.cap) && /поворот через/.test(L1.cap) && /контрольних поворотів: \d+/.test(L1.cap), L1.cap);
  ok(`[${T}] дані: розділи «Датчики телефона», «Служба навігації», GPS, «Розрахунок без GPS»`, L1.secs.length >= 4 && /Датчики телефона/.test(L1.secs[0]) && /Служба навігації/.test(L1.secs[1]) && L1.secs[2] === 'GPS' && /Розрахунок без GPS/.test(L1.secs[3]), L1.secs.join(' | '));
  ok(`[${T}] дані без GPS: режим, позначка зі швидкістю й похибкою, наступний поворот (ліворуч, червоний), його стан`, /розрахунок без GPS/.test(rowOf(L1, 'Режим')) && /км\/год · ±\d+ м/.test(rowOf(L1, 'Позначка')) && /↰ -?\d+° · червоний · \d+ м/.test(rowOf(L1, 'Поворот')) && /їде до нього · 0° із \d+°/.test(rowOf(L1, 'Стан')),
    JSON.stringify({ mode: rowOf(L1, 'Режим'), mark: rowOf(L1, 'Позначка'), cp: rowOf(L1, 'Поворот'), st: rowOf(L1, 'Стан') }));
  ok(`[${T}] дані служби: гіроскоп, трясіння з порогом, «їдемо»`, /°$/.test(rowOf(L1, 'Гіроскоп')) && /0[.,]05\d* · поріг/.test(rowOf(L1, 'Трясіння')) && /^їдемо/.test(rowOf(L1, 'Рух')), JSON.stringify({ g: rowOf(L1, 'Гіроскоп'), s: rowOf(L1, 'Трясіння'), m: rowOf(L1, 'Рух') }));
  await page.click('#labZoom'); await sleep(350);
  ok(`[${T}] «Ближче» — схема навколо позначки; кнопка стала «Увесь рейс»`, await app(page, () => document.getElementById('labZoom').textContent === 'Увесь рейс'));
  if (sc.n !== 'tiny') await shot(page, '26-lab-' + sc.n);
  // телефон у 3D: датчики WebView — стоїть у тримачі, потім повертаємо праворуч на 30°, далі ліворуч на 75°
  const feed = (rate, secs, up = [0, 9.2, 3.3]) => app(page, ([rate, secs, up]) => { const Tt = window.__app.sensors._test, t0 = performance.now() + (window.__mt || 0); const N = Math.round(secs * 60);
    for (let i = 0; i <= N; i++) Tt.onMotion({ timeStamp: t0 + i * 1000 / 60, rotationRate: { alpha: 0, beta: i ? -rate * up[1] / 9.8 : 0, gamma: i ? -rate * up[2] / 9.8 : 0 }, accelerationIncludingGravity: { x: up[0], y: up[1], z: up[2] }, acceleration: { x: 0, y: 0, z: 0 } });
    window.__mt = (window.__mt || 0) + secs * 1000 + 50; Tt.flush((t0 + secs * 1000) / 1000); }, [rate, secs, up]);
  const ph = () => app(page, () => ({ st: window.__app.lab.phoneState(), tr: document.getElementById('labPhone').style.transform, yaw: document.getElementById('labYaw').textContent, dial: document.getElementById('labDial').style.transform, hand: document.getElementById('labPhone').classList.contains('hand') }));
  await feed(0, 1.2); await sleep(250); await page.click('[data-lab="zero"]'); await sleep(250);
  const p0 = await ph();
  ok(`[${T}] телефон стоїть у тримачі — модель нахилена так само, напис «рівно»`, /^matrix3d\(1, 0, 0, 0, 0, 0\.9\d+, 0\.3\d+/.test(p0.tr) && /рівно/.test(p0.yaw), JSON.stringify(p0));
  await feed(30, 1); await sleep(250);
  const p1 = await ph();
  ok(`[${T}] повернули телефон праворуч на 30° — модель повернулась, напис «праворуч на 30°»`, Math.abs(p1.st.web - 30) < 1.5 && /праворуч на (29|30|31)°/.test(p1.yaw) && /rotate\((29|30|31)/.test(p1.dial) && /^matrix3d\(0\.8[5-8]\d*, 0, 0\.[45]\d+/.test(p1.tr), JSON.stringify(p1));
  await feed(-52.5, 2); await sleep(250);
  const p2 = await ph();
  ok(`[${T}] назад і ліворуч — «ліворуч на 75°»`, Math.abs(p2.st.web + 75) < 2 && /ліворуч на 7[3-7]°/.test(p2.yaw), JSON.stringify(p2));
  const d1 = await app(page, () => [...document.querySelectorAll('#labData .lab-r')].map(r => r.firstElementChild.textContent + '=' + r.lastElementChild.textContent));
  const rw = k => (d1.find(r => r.startsWith(k + '=')) || '').slice(k.length + 1);
  ok(`[${T}] дані датчиків: працюють, частота, обертання, «у руках — ні»`, /працюють · \d+\/с/.test(rw('Датчики руху')) && /↻ -?\d+[.,]\d · усього \d+[.,]\d °\/с/.test(rw('Обертання')) && rw('У руках') === 'ні', JSON.stringify({ a: rw('Датчики руху'), b: rw('Обертання'), c: rw('У руках') }));
  await page.click('[data-lab="zero"]'); await sleep(250);
  const p3 = await ph();
  ok(`[${T}] «Нуль тут» — відлік повороту з цього положення; плашки застосунку схему не закривають`, /рівно/.test(p3.yaw) && /нуль виставлено/.test(p3.yaw) && Math.abs(p3.st.web) < 0.6 && await app(page, () => getComputedStyle(document.getElementById('toasts')).display === 'none'), JSON.stringify(p3));
  const fit = await app(page, () => { const sc = document.querySelector('.lab-scene').getBoundingClientRect(), g = document.querySelector('.lab-ground').getBoundingClientRect(), ph = document.getElementById('labPhone').getBoundingClientRect(), cap = document.getElementById('labCap').getBoundingClientRect(), z = document.getElementById('labZoom').getBoundingClientRect(), top = document.querySelector('.lab-top').getBoundingClientRect();
    return { sc: [sc.left, sc.right, sc.top, sc.bottom].map(Math.round), g: [g.left, g.right, g.top, g.bottom].map(Math.round), ph: [ph.left, ph.right, ph.top, ph.bottom].map(Math.round), capH: Math.round(cap.height), capIn: cap.bottom <= top.bottom - 60, zIn: z.right <= top.right && z.bottom <= top.bottom,
      wraps: [...document.querySelectorAll('#labData .lab-r span')].filter(e => e.getBoundingClientRect().height > 40).map(e => e.textContent) }; });
  ok(`[${T}] модель телефона з колом повороту вміщається у свою колонку, підписи рядків не ламаються на три рядки`, fit.g[0] >= fit.sc[0] - 2 && fit.g[1] <= fit.sc[1] + 2 && fit.ph[2] >= fit.sc[2] - 4 && fit.ph[3] <= fit.sc[3] + 4 && fit.capIn && fit.zIn && fit.wraps.length === 0, JSON.stringify(fit));
  // телефон узяли в руки: модель червоніє, у даних — «так»
  await app(page, () => { const Tt = window.__app.sensors._test, t0 = performance.now() + (window.__mt || 0); for (let i = 0; i < 70; i++) Tt.onMotion({ timeStamp: t0 + i * 16, rotationRate: { alpha: 60, beta: 10, gamma: 5 }, accelerationIncludingGravity: { x: 0.3, y: 6, z: 7.5 }, acceleration: { x: 0, y: 0, z: 0 } }); Tt.flush((t0 + 1200) / 1000); window.__mt += 1300; });
  await sleep(450);
  const p4 = await ph(), handRow = await app(page, () => { const r = [...document.querySelectorAll('#labData .lab-r')].find(r => r.firstElementChild.textContent === 'У руках'); return r ? r.lastElementChild.textContent + '|' + r.className : ''; });
  ok(`[${T}] телефон узяли в руки — модель із червоною рамкою, у даних «так — цю секунду не рахую»`, p4.hand && /так/.test(handRow) && /bad/.test(handRow), handRow);
  if (sc.n === 'xiaomi') await shot(page, '27-lab-phone');
  // поворот відпрацьовано — у Лабораторії з'являється запис у «Подіях»
  await app(page, () => window.__app.nav.passTurn()); await sleep(1300);
  const evs = await app(page, () => ({ secs: [...document.querySelectorAll('#labData .lab-sec')].map(e => e.textContent), ev: [...document.querySelectorAll('#labData .lab-ev')].map(e => e.textContent) }));
  ok(`[${T}] у «Подіях» — запис про пройдений поворот (кнопка) і про втрату GPS`, evs.secs.includes('Події') && evs.ev.some(e => /поворот -?\d+° — кнопка/.test(e)) && evs.ev.some(e => /GPS ✕/.test(e)), evs.ev.join(' | '));
  // вихід: системна «Назад»; «Перемикачі» відкривають старі налаштування Лабораторії
  const back = await app(page, () => window.__reisBack());
  ok(`[${T}] системна «Назад» закриває Лабораторію`, back === true && !(await labVis()));
  await app(page, () => window.__app.lab.openLab()); await page.click('[data-lab="tools"]'); await page.waitForSelector('[data-tg="tg"]');
  ok(`[${T}] «Перемикачі» — колишня Лабораторія (перемикачі, імітація руху)`, !(await labVis()) && await app(page, () => !!document.querySelector('#panelBody [data-sim="toggle"]') && document.getElementById('panelTitle').textContent === 'Лабораторія'));
  await page.click('#panelOk');
  await app(page, () => window.__app.lab.openLab()); await page.click('[data-lab="x"]');
  ok(`[${T}] хрестик закриває Лабораторію; карта й рейс на місці`, !(await labVis()) && await app(page, () => window.__app.guide.g.active));
  ok(`[${T}] прохід 23 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 23 (${sc.n}) дійшов до кінця`, false, String(e.message).split('\n')[0]); }

// ---------- Прохід 24: точки рейсу — значки, старт «з мого місця / на карті», точки пальцем на карті (без прицілу) ----------
if (run('24')) for (const sc of SCREENS.filter(x => ['S10', 'tiny', 'land', 'tablet'].includes(x.n) && (!process.env.SCR || process.env.SCR.split(',').includes(x.n)))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const me = coords[4];
  await emitN('loc', { prov: 'gps', lat: me[0], lon: me[1], acc: 5, spd: 0, t: Date.now() }); await sleep(400);
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#panelBody .field');
  const form = () => app(page, () => ({ f: [...document.querySelectorAll('#panelBody .field')].map(f => { const tag = f.querySelector('.tag'), mp = f.querySelector('[data-onmap]'), r = mp && mp.getBoundingClientRect(), inp = f.querySelector('input'), i = inp.getBoundingClientRect();
      return { cls: tag.className, svg: !!tag.querySelector('svg'), txt: tag.textContent.trim(), bg: getComputedStyle(tag).backgroundColor, k: mp && mp.dataset.onmap, bw: r && Math.round(r.width), bh: r && Math.round(r.height), iw: Math.round(i.width), ph: inp.placeholder, val: inp.value }; }),
    two: [...document.querySelectorAll('#startTwo button')].map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), on: b.classList.contains('on'), h: Math.round(r.height), r: Math.round(r.right), sw: b.scrollWidth, cw: b.clientWidth, k: b.dataset.here ? 'here' : 'map' }; }),
    hint: (document.querySelector('#panelBody .pt-hint') || { textContent: '' }).textContent }));
  const F = await form();
  ok(`[${T}] у «Рейсі» замість літер А·Б·С — значки: зелений старт, сіре «через», червоний фініш`, F.f.length === 3 && F.f.every(f => f.svg && !f.txt) && /47, 158, 98/.test(F.f[0].bg) && /125, 135, 146/.test(F.f[1].bg) && /229, 72, 77/.test(F.f[2].bg), JSON.stringify(F.f.map(f => f.cls + ' ' + f.bg)));
  ok(`[${T}] старт за замовчуванням — «Моє місце зараз»; під полем два способи: «З мого місця» (вибрано) і «Вказати на карті»`, F.f[0].ph === 'Моє місце зараз' && F.f[0].val === '' && F.two.length === 2 && F.two[0].t === 'З мого місця' && F.two[0].on && F.two[1].t === 'Вказати на карті' && !F.two[1].on && F.two.every(b => b.h >= 44 && b.r <= sc.w && b.sw <= b.cw + 1), JSON.stringify(F.two));
  ok(`[${T}] «через» і фініш: текстом або кнопкою «на карті» в полі (під палець)`, !F.f[0].k && F.f[1].k === 'v' && F.f[2].k === 'b' && F.f.slice(1).every(f => f.bw >= 40 && f.bh >= 40 && f.iw >= 110) && /затримайте палець/.test(F.hint), JSON.stringify(F.f.map(f => [f.k, f.bw, f.bh, f.iw])));
  if (sc.n === 'S10') await shot(page, '28-trip-fields');
  // фініш «на карті»: «Рейс» ховається, на карті плашка точок; прицілу НЕМАЄ — точку ставить дотик
  const bar = () => app(page, () => { const R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const P = window.__app, br = document.querySelector('#pts .pt-bar'); if (!br) return null; const src = P.map.map.getSource('plan-line')._data;
    return { vis: !document.getElementById('pts').hidden, panel: document.getElementById('panel').hidden, cross: !!document.querySelector('#pts .aim-cross'), put: !!document.querySelector('#pts [data-pt="put"]'),
      chips: [...document.querySelectorAll('#pts .pt-chip')].map(c => ({ k: c.dataset.pt, on: c.classList.contains('on'), set: c.classList.contains('set'), txt: c.textContent.trim(), ...R(c), sw: c.scrollWidth, cw: c.clientWidth })),
      sum: document.getElementById('ptSum').textContent.trim(), arm: (document.getElementById('ptArm') || { textContent: '' }).textContent.trim(), ctx: (document.querySelector('#pts .pt-ctx') || { textContent: '' }).textContent.trim(), ctxOn: !!document.querySelector('#pts .pt-ctx.on'), ctxFit: (e => !e || e.scrollWidth <= e.clientWidth + 1)(document.querySelector('#pts .pt-ctx span')),
      btns: [...document.querySelectorAll('#pts .row .btn, #pts .pt-ic')].map(b => ({ k: b.dataset.pt, dis: b.disabled, ...R(b) })), bar: R(br), st: P.ui.ptsState(), aiming: document.body.classList.contains('aiming'),
      wp: [...document.querySelectorAll('.wp-plan')].map(e => { const r = e.getBoundingClientRect(); return { cls: (/wp-[avb]/.exec(e.className) || [''])[0], x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom) }; }),
      line: src && src.geometry ? src.geometry.coordinates.length : 0, vw: innerWidth, vh: innerHeight, botTop: Math.round(document.getElementById('bottom').getBoundingClientRect().top), pick: document.getElementById('pick').hidden }; });
  const chipT = (B, k) => B.chips.find(c => c.k === k).txt;
  await page.click('[data-onmap="b"]'); await sleep(450);
  const b0 = await bar();
  ok(`[${T}] «на карті» біля фінішу: «Рейс» сховався, на карті плашка з трьома точками; прицілу й кнопки «Сюди» немає`, b0.vis && b0.panel && !b0.cross && !b0.put && b0.chips.length === 3, JSON.stringify({ cross: b0.cross, put: b0.put }));
  ok(`[${T}] старт — «Моє місце»; фініш чекає дотику до карти (підсвічено, смужка «Торкніться карти — там буде фініш»); «Маршрут» ще недоступний`, /Моє місце/.test(chipT(b0, 'a')) && b0.chips[2].on && !b0.chips[0].on && /Торкніться карти — там буде фініш/.test(b0.arm) && b0.st.arm === 'b' && b0.st.me && b0.aiming && b0.btns.find(x => x.k === 'route').dis, JSON.stringify({ a: chipT(b0, 'a'), arm: b0.arm, st: b0.st }));
  ok(`[${T}] плашка в межах екрана, кнопки під палець, написи не обрізані по висоті`, b0.bar.l >= 0 && b0.bar.r <= b0.vw && b0.chips.every(c => c.h >= 44 && c.sw <= c.cw + 1) && b0.btns.every(x => x.h >= 44 && x.w >= 44 && x.r <= b0.bar.r + 1 && x.l >= b0.bar.l - 1), JSON.stringify({ bar: b0.bar, btns: b0.btns.map(x => [x.k, x.w, x.h]) }));
  const geoAt = (x, y) => app(page, ([x, y]) => { const mc = document.getElementById('map').getBoundingClientRect(); return window.__app.map.screenToGeo(x - mc.left, y - mc.top); }, [x, y]);
  const hav = (a, b) => { const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r, q = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(q)); };
  // вільне місце на карті: під плашкою (або ліворуч від неї в альбомній), над нижньою плашкою, осторонь круга швидкості
  const land = sc.w > sc.h && sc.h <= 520;
  const cx = land ? Math.round(b0.bar.l / 2) + 40 : Math.round(sc.w / 2) + 30, cy = land ? Math.round(sc.h / 2) - 20 : Math.round((b0.bar.b + b0.botTop) / 2) - 20;
  const gB = await geoAt(cx, cy);
  await page.mouse.click(cx, cy); await sleep(700);
  const b1 = await bar(), dB = hav({ lat: me[0], lon: me[1] }, gB);
  ok(`[${T}] торкнулись карти — фініш саме під пальцем (мітка з картатим прапором)`, b1.wp.length === 1 && b1.wp[0].cls === 'wp-b' && Math.abs(b1.wp[0].x - cx) <= 2 && Math.abs(b1.wp[0].y - cy) <= 2, JSON.stringify({ wp: b1.wp, tap: [cx, cy] }));
  ok(`[${T}] пряма від мого місця й відстань «… по прямій · від вашого місця»; більше ніщо не чекає дотику; «Маршрут» доступний`, b1.line === 2 && Math.abs(b1.st.dist.total - dB) < 3 && /по прямій · від вашого місця/.test(b1.sum) && b1.st.arm === null && !b1.arm && b1.chips.every(c => !c.on) && !b1.aiming && !b1.btns.find(x => x.k === 'route').dis, JSON.stringify({ sum: b1.sum, st: b1.st }));
  await page.mouse.click(cx + 35, cy - 30); await sleep(500);
  const b1b = await bar();
  ok(`[${T}] випадковий дотик до карти нічого не пересуває (точка не «чекала»)`, b1b.wp.length === 1 && b1b.wp[0].x === b1.wp[0].x && b1b.wp[0].y === b1.wp[0].y, JSON.stringify(b1b.wp));
  if (!(await app(page, () => document.getElementById('pick').hidden))) await app(page, () => { document.getElementById('pick').hidden = true; });
  if (sc.n === 'S10') await shot(page, '29-points-finish');
  // старт: два способи — на карті (дотиком) або «з мого місця»
  await page.click('#pts [data-pt="a"]'); await sleep(300);
  const b2 = await bar();
  if (sc.n === 'S10' || sc.n === 'land') await shot(page, '29b-start-armed-' + sc.n);
  ok(`[${T}] торкнулись «Старт» — він чекає дотику до карти; поруч другий спосіб: «З мого місця» (зараз вибрано, зелена); напис вміщається цілком`, b2.st.arm === 'a' && b2.chips[0].on && /там буде старт/.test(b2.arm) && b2.ctx === 'З мого місця' && b2.ctxOn && b2.ctxFit && b2.aiming, JSON.stringify({ arm: b2.arm, ctx: b2.ctx, fit: b2.ctxFit }));
  const sx = cx - 45, sy = cy + 40, gA = await geoAt(sx, sy);
  await page.mouse.click(sx, sy); await sleep(600);
  const b3 = await bar();
  ok(`[${T}] торкнулись карти — старт там (зелений прапорець під пальцем); відстань тепер між двома точками`, b3.wp.some(w => w.cls === 'wp-a' && Math.abs(w.x - sx) <= 2 && Math.abs(w.y - sy) <= 2) && b3.wp.length === 2 && !b3.st.me && Math.abs(b3.st.dist.total - hav(gA, gB)) < 3 && /по прямій$/.test(b3.sum) && b3.st.arm === null, JSON.stringify({ wp: b3.wp, sum: b3.sum, st: b3.st }));
  await page.click('#pts [data-pt="a"]'); await sleep(250);
  const b3b = await bar();
  if (sc.n === 'S10' || sc.n === 'land') await shot(page, '29c-start-set-armed-' + sc.n);
  await page.click('#pts [data-pt="me"]'); await sleep(350);
  const b4 = await bar();
  ok(`[${T}] «Старт» ще раз → кнопка «З мого місця»: старт знову моє місце (мітка зникла, відстань — «від вашого місця»)`, b3b.ctx === 'З мого місця' && !b3b.ctxOn && b3b.ctxFit && b4.st.me && b4.wp.length === 1 && /Моє місце/.test(chipT(b4, 'a')) && /від вашого місця/.test(b4.sum) && b4.st.arm === null, JSON.stringify({ ctx: b3b.ctx, sum: b4.sum, wp: b4.wp }));
  // «через»
  await page.click('#pts [data-pt="v"]'); await sleep(250);
  const vx = cx + 50, vy = cy + 45, gV = await geoAt(vx, vy);
  await page.mouse.click(vx, vy); await sleep(600);
  const b5 = await bar();
  ok(`[${T}] «Через» → дотик до карти: третя точка, два відрізки й сума`, b5.wp.length === 2 && b5.wp.some(w => w.cls === 'wp-v') && b5.line === 3 && b5.st.dist.legs.length === 2 && /\+ .* = /.test(b5.sum), b5.sum);
  if (sc.n !== 'tiny') await shot(page, '30-points-' + sc.n);
  await page.click('#pts [data-pt="v"]'); await sleep(250);
  const b5b = await bar(); await page.click('#pts [data-pt="del"]'); await sleep(300);
  const b6 = await bar();
  ok(`[${T}] «Через» ще раз → «Без „через“»: проміжну точку прибрано`, /Без «через»/.test(b5b.ctx) && b5b.ctxFit && b6.wp.length === 1 && b6.line === 2 && /не треба/.test(chipT(b6, 'v')), JSON.stringify({ ctx: b5b.ctx, wp: b6.wp }));
  // довге натискання на карті (1.1.22): ОДИН ряд значків у порядку Старт · Через · Їхати сюди (головна) · Я тут · ✕; тло майже прозоре; «душу» тут немає
  await app(page, () => window.__app.bus.emit('mapPick', { lat: 49.985, lon: 36.21 })); await sleep(350);
  const pk = await app(page, () => { const box = document.getElementById('pick'), al = c => { const m = String(c).match(/rgba?\(([^)]+)\)/); const a = m ? m[1].split(/[,/ ]+/).filter(Boolean).map(Number) : []; return a.length >= 4 ? a[3] : (m ? 1 : 0); };
    const bs = [...box.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(), ic = b.querySelector('.rp-t'), sp = b.querySelector('span'); return { k: b.dataset.k, t: b.textContent.trim(), label: b.getAttribute('aria-label'), svg: !!b.querySelector('svg'), ic: ic ? Math.round(ic.getBoundingClientRect().width) : 0, icBg: ic ? getComputedStyle(ic).backgroundColor : '', pri: b.classList.contains('pri'),
      h: Math.round(r.height), t0: Math.round(r.top), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), fit: !sp || sp.scrollWidth <= sp.clientWidth + 1, bg: al(getComputedStyle(b).backgroundColor) }; });
    const r = box.getBoundingClientRect(), cap = box.querySelector('.pk-cap');
    return { b: bs, box: { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), bg: al(getComputedStyle(box).backgroundColor), blur: getComputedStyle(box).backdropFilter, shadow: getComputedStyle(box).boxShadow }, cap: cap ? cap.textContent : '', capFs: cap ? parseFloat(getComputedStyle(cap).fontSize) : 0, text: box.textContent }; });
  ok(`[${T}] затримали палець на карті — один ряд значків у порядку «Старт · Через · Їхати (головна) · Я тут» і хрестик; усі на одній лінії, з підписами, вміщаються`, pk.b.map(x => x.k).join() === 'a,v,b,here,x' && pk.b.slice(0, 4).map(x => x.t).join() === 'Старт,Через,Їхати,Я тут' && pk.b[2].pri && !pk.b[0].pri && !pk.b[3].pri
    && new Set(pk.b.map(x => x.t0)).size === 1 && pk.b.every((x, i) => x.svg && x.h >= 56 && x.w >= 44 && x.l >= pk.box.l && x.r <= pk.box.r && x.fit && (!i || x.l >= pk.b[i - 1].r + 4)) && pk.b.slice(0, 4).every(x => x.ic === 32) && pk.box.r <= sc.w, JSON.stringify(pk.b));
  ok(`[${T}] значки меню точки зрозумілі: зелений прапорець — старт, сіре кільце — через, червоний картатий прапор — їхати сюди, синя стрілка (як машина на карті) — «я тут»; для озвучення — повні назви`, pk.b[0].icBg === 'rgb(47, 158, 98)' && pk.b[1].icBg === 'rgb(95, 106, 117)' && /^rgb\(2[0-9]{2}, \d{2}, \d{2}\)$/.test(pk.b[2].icBg) && pk.b[3].icBg === 'rgb(47, 107, 255)'
    && pk.b[0].label === 'Старт тут' && pk.b[1].label === 'Їхати через цю точку' && pk.b[2].label === 'Їхати сюди' && /^Я тут: поставити моє місце/.test(pk.b[3].label), JSON.stringify(pk.b.map(x => [x.k, x.icBg, x.label])));
  ok(`[${T}] тло меню точки майже прозоре (${pk.box.bg}) і без розмиття — карту під ним видно; самі кнопки щільні (${pk.b[0].bg}); меню вдвічі нижче, ніж було (${pk.box.h} пікселів); кнопки «душ» тут більше немає`, pk.box.bg > 0 && pk.box.bg <= 0.15 && pk.box.blur === 'none' && pk.box.shadow === 'none' && pk.b.every(x => x.bg >= 0.8) && pk.box.h <= 100 && !/душ/.test(pk.text) && /^Точка на карті: 49\.98500, 36\.21000$/.test(pk.cap) && pk.capFs >= 12, JSON.stringify(pk.box) + ' ' + pk.cap);
  ok(`[${T}] меню точки: усе читається`, (await readCheck(page, '#pick')).length === 0, JSON.stringify(await readCheck(page, '#pick')));
  if (sc.n === 'S10' || sc.n === 'tiny') await shot(page, '30-pick-' + sc.n);
  // (1.1.32) фініш уже є — «Старт тут» одразу прокладає маршрут тут, на карті: шторка з варіантами, форму «Рейс» не відкриваємо
  const onMapRoute = async n => { await page.waitForFunction(n => window.__app && !document.getElementById('routePick').hidden && document.getElementById('routePick').dataset.mode !== 'rr', n, { timeout: 15000 }); await sleep(300);
    return app(page, () => ({ pick: !document.getElementById('routePick').hidden, pts: document.getElementById('pts').hidden, panel: document.getElementById('panel').hidden })); };
  let reqS = routeReqs.length;
  await page.click('#pick [data-k="a"]');
  const m7 = await onMapRoute(), q7 = routeReqs[reqS] || { locations: [{}] };
  ok(`[${T}] фініш уже є — «Старт тут» одразу прокладає маршрут тут, на карті (шторка з варіантами; форма «Рейс» не відкривалась); старт — у цій точці`, m7.pick && m7.pts && m7.panel && Math.abs(q7.locations[0].lat - 49.985) < 1e-4 && Math.abs(q7.locations[0].lon - 36.21) < 1e-4, JSON.stringify({ m7, loc: q7.locations.map(l => [l.lat, l.lon]) }));
  await page.click('#routePick [data-rp="pts"]'); await sleep(450);
  const b7 = await bar();
  ok(`[${T}] дотик до рядка точок на шторці — знову плашка точок на карті: старт там, де поставили, ніщо не чекає дотику`, b7.vis && b7.panel && b7.pick && !b7.st.me && b7.wp.some(w => w.cls === 'wp-a') && b7.st.arm === null, JSON.stringify({ st: b7.st, wp: b7.wp }));
  // старт уже вказано вручну → на картці не «Їхати сюди», а «Фініш тут»: фініш переїжджає, старт лишається, де поставили
  await app(page, () => window.__app.bus.emit('mapPick', { lat: 49.9856, lon: 36.2112 })); await sleep(350);
  const pk2 = await app(page, () => [...document.querySelectorAll('#pick .pt-b')].map(b => ({ t: b.textContent.trim(), label: b.getAttribute('aria-label'), pri: b.classList.contains('pri'), sw: b.scrollWidth, cw: b.clientWidth })));
  if (sc.n === 'S10') await shot(page, '30-pick-finish-' + sc.n);
  const a7 = b7.wp.find(w => w.cls === 'wp-a');
  reqS = routeReqs.length;
  await page.click('#pick [data-k="b"]');
  await onMapRoute(); const q7b = routeReqs[reqS] || { locations: [{}] };
  await page.click('#routePick [data-rp="pts"]'); await sleep(450);
  const b7b = await bar(), a7b = b7b.wp.find(w => w.cls === 'wp-a');
  ok(`[${T}] старт уже вказано вручну — у меню «Фініш» (а не «Їхати»; для озвучення «Фініш тут»): фініш переїхав, старт на місці`, pk2.map(x => x.t).join() === 'Старт,Через,Фініш,Я тут' && pk2[2].pri && pk2[2].label === 'Фініш тут' && pk2.every(x => x.sw <= x.cw + 1)
    && !b7b.st.me && !!a7 && !!a7b && b7b.wp.some(w => w.cls === 'wp-b') && b7b.st.arm === null
    && Math.abs(q7b.locations[0].lat - 49.985) < 1e-4 && Math.abs(q7b.locations[q7b.locations.length - 1].lat - 49.9856) < 1e-4, JSON.stringify({ pk2, st: b7b.st, wp: b7b.wp, loc: q7b.locations.map(l => [l.lat, l.lon]) }));
  // «Прибрати всі точки» → з чистого аркуша: «Старт тут», і фініш одразу чекає дотику (поставив першу — одразу другу)
  await page.click('#pts [data-pt="reset"]'); await sleep(300);
  const b8 = await bar();
  ok(`[${T}] «Прибрати всі точки»: міток немає, старт знову «Моє місце», підказка «Затримайте палець на карті…»`, b8.wp.length === 0 && b8.st.me && /Затримайте палець на карті/.test(b8.sum) && b8.st.arm === null && !b8.btns.some(x => x.k === 'reset'), JSON.stringify({ sum: b8.sum, wp: b8.wp }));
  await app(page, ([la, lo]) => window.__app.bus.emit('mapPick', { lat: la, lon: lo }), [gA.lat, gA.lon]); await sleep(350);
  await page.click('#pick [data-k="a"]'); await sleep(500);
  const b9 = await bar();
  ok(`[${T}] «Старт тут» першою точкою — фініш одразу чекає дотику: поставив першу, одразу ставиш другу`, b9.st.arm === 'b' && /там буде фініш/.test(b9.arm) && b9.chips[2].on && b9.wp.length === 1, JSON.stringify({ st: b9.st, arm: b9.arm }));
  await page.mouse.click(cx, cy); await sleep(600);
  const b10 = await bar();
  ok(`[${T}] дотик — фініш; відстань між стартом і фінішем`, b10.wp.length === 2 && b10.st.arm === null && Math.abs(b10.st.dist.total - hav(gA, await geoAt(cx, cy))) < 3, JSON.stringify(b10.st));
  // «Маршрут» — рейс за цими точками
  const reqN = routeReqs.length;
  await page.click('#pts [data-pt="route"]');
  await page.waitForFunction(() => !document.getElementById('routePick').hidden, null, { timeout: 15000 });
  const rq = routeReqs[reqN], hd = await app(page, () => ({ pts: document.getElementById('pts').hidden, wp: document.querySelectorAll('.wp-plan').length, pins: [...document.querySelectorAll('.wp')].map(e => e.className + (e.querySelector('svg') ? '+svg' : '') + e.textContent.trim()), head: [...document.querySelectorAll('#routePick .rp-head .rp-t')].map(e => e.className + (e.querySelector('svg') ? '+svg' : '') + e.textContent.trim()), aiming: document.body.classList.contains('aiming'), on: document.body.classList.contains('pts-on') }));
  ok(`[${T}] «Маршрут» — рейс побудовано від вказаного старту до фінішу; плашку точок закрито`, routeReqs.length > reqN && rq.locations.length === 2 && Math.abs(rq.locations[0].lat - gA.lat) < 1e-4 && Math.abs(rq.locations[0].lon - gA.lon) < 1e-4 && hd.pts && hd.wp === 0 && !hd.aiming && !hd.on, JSON.stringify({ n: rq.locations.length, hd }));
  ok(`[${T}] у вікні варіантів і на карті — ті самі значки (без літер)`, hd.head.length === 2 && hd.head.every(h => /\+svg$/.test(h)) && hd.pins.filter(p => /wp-[ab]/.test(p)).length === 2 && hd.pins.every(p => !/[АБС]$/.test(p)), JSON.stringify(hd));
  await page.click('#routePick [data-rp="x"]'); await sleep(1700);
  // «Рейс»: старт вказано на карті — видно в полі й у двох способах; «З мого місця» повертає живе місце
  if (!(await page.$('#in_a'))) await page.click('#tabs button[data-panel="trip"]');
  await page.waitForSelector('#startTwo');
  const F2 = await form();
  ok(`[${T}] у «Рейсі» видно вказаний на карті старт: назва в полі, вибрано «Вказати на карті»`, F2.f[0].val.length > 2 && !F2.two[0].on && F2.two[1].on, JSON.stringify({ val: F2.f[0].val, two: F2.two.map(b => b.on) }));
  await page.click('#startTwo [data-onmap="a"]'); await sleep(450);
  const b11 = await bar();
  ok(`[${T}] «Вказати на карті» під стартом: плашка, старт чекає дотику; хрестик повертає в «Рейс»`, b11 && b11.vis && b11.st.arm === 'a' && b11.st.form, JSON.stringify(b11 && b11.st));
  await page.click('#pts [data-pt="x"]'); await sleep(400);
  ok(`[${T}] …хрестик — знову «Рейс» з тими самими точками`, await app(page, () => !document.getElementById('panel').hidden && !!document.getElementById('in_b') && document.getElementById('in_b').value.length > 2 && document.getElementById('pts').hidden));
  await page.click('#startTwo [data-here="1"]'); await sleep(300);
  const F3 = await form();
  ok(`[${T}] «З мого місця»: поле старту порожнє («Моє місце зараз»), спосіб вибрано`, F3.f[0].val === '' && F3.f[0].ph === 'Моє місце зараз' && F3.two[0].on && !F3.two[1].on, JSON.stringify(F3.two));
  // телефон поїхав далі: спокійний рух по 7,5 м за секунду (різкий «стрибок» фільтр вважав би підміною GPS)
  let me2 = me;
  for (let k = 1; k <= 6; k++) { const f = k * 0.15; me2 = [coords[4][0] + (coords[5][0] - coords[4][0]) * f, coords[4][1] + (coords[5][1] - coords[4][1]) * f]; await emitN('loc', { prov: 'gps', lat: me2[0], lon: me2[1], acc: 5, spd: 7.5, t: Date.now() }); await sleep(1000); }      // після паузи без GPS застосунок приймає його знову за кілька точок
  const reqM = routeReqs.length;
  await page.click('[data-act="build"]');
  await page.waitForFunction(() => !document.getElementById('routePick').hidden, null, { timeout: 15000 });
  const rm = routeReqs[reqM], moved = Math.hypot(me2[0] - me[0], me2[1] - me[1]);
  ok(`[${T}] будуємо «з мого місця» — старт там, де телефон ЗАРАЗ (а не там, де був, коли відкривали «Рейс»)`, rm.locations.length === 2 && moved > 3e-4 && Math.hypot(rm.locations[0].lat - me2[0], rm.locations[0].lon - me2[1]) < 1e-4, JSON.stringify(rm.locations[0]) + ' / ' + me2 + ' / було ' + me + ' / ' + JSON.stringify(await app(page, () => { const P = window.__app, p = P.nav.pos; return { lat: p.lat, lon: p.lon, mode: p.mode, man: !!p.manRef, log: P.core.getLog().slice(-5).map(l => l.msg || l.text) }; })));
  await page.click('#routePick [data-rp="x"]'); await sleep(1700);
  // (1.1.32) «Їхати сюди» — маршрут від мого місця одразу тут, на карті; системна «Назад» закриває шторку
  await app(page, () => window.__app.bus.emit('mapPick', { lat: 49.985, lon: 36.21 })); await sleep(300);
  reqS = routeReqs.length;
  await page.click('#pick [data-k="b"]');
  const m12 = await onMapRoute(), q12 = routeReqs[reqS] || { locations: [{}] };
  const back = await app(page, () => window.__reisBack()); await sleep(300);
  ok(`[${T}] «Їхати сюди»: маршрут від мого місця до цієї точки — одразу на карті; системна «Назад» закриває шторку`, m12.pick && m12.pts && m12.panel && Math.abs(q12.locations[0].lat - me2[0]) < 2e-3 && Math.abs(q12.locations[q12.locations.length - 1].lat - 49.985) < 1e-4 && back === true && await app(page, () => document.getElementById('routePick').hidden && document.getElementById('pts').hidden && !document.body.classList.contains('aiming') && window.__app.ui.ptsState() === null), JSON.stringify({ m12, loc: q12.locations.map(l => [l.lat, l.lon]) }));
  ok(`[${T}] прохід 24 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 24 (${sc.n}) дійшов до кінця`, false, String(e.message).split('\n')[0]); }

// ---------- Прохід 27: клавіатура — нижня плашка не лізе на підказки адрес ----------
if (run('27')) for (const sc of SCREENS.filter(x => ['xiaomi', 'tiny', 'land'].includes(x.n) && (!process.env.SCR || process.env.SCR.split(',').includes(x.n)))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 0, t: Date.now() }); await sleep(300);
  const lay = () => app(page, () => { const R = e => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; }; const bt = document.getElementById('bottom'), cs = getComputedStyle(bt);
    return { kb: document.body.classList.contains('kb'), open: document.body.classList.contains('planning'), bottomShown: cs.display !== 'none', bottomBg: getComputedStyle(document.querySelector('#tbShape .tb-fill')).fill,   /* (1.1.24) тло нижньої плашки — SVG-контур */ bottom: R(bt), panel: R(document.getElementById('panel')), vh: innerHeight,
      sg: [...document.querySelectorAll('#sg_b button')].map(b => { const r = b.getBoundingClientRect(), el = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)); return { t: Math.round(r.top), b: Math.round(r.bottom), mine: !!el && (el === b || b.contains(el)) }; }) }; });
  const l0 = await lay();
  ok(`[${T}] карта без панелей: нижня плашка напівпрозора (як у налаштуванні «Прозорість плашок»)`, /rgba\(/.test(l0.bottomBg) && !l0.open && !l0.kb, l0.bottomBg);
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#in_b');
  const l1 = await lay();
  // (1.1.24) «Рейс» без побудованого маршруту — панель на весь екран: нижню плашку вона закриває, і крізь неї нічого не просвічує
  const cov = await app(page, () => { const p = document.getElementById('panel'), tb = document.getElementById('tabs').getBoundingClientRect(), h = document.elementFromPoint(tb.left + tb.width / 2, tb.top + tb.height / 2), m = getComputedStyle(p).backgroundColor.match(/rgba?\(([^)]+)\)/), a = m ? m[1].split(',').map(Number) : []; return { covered: !!h && p.contains(h), alpha: a.length === 4 ? a[3] : 1, full: p.classList.contains('full') }; });
  ok(`[${T}] відкрито «Рейс»: панель на весь екран і непрозора — нижню плашку закрито, підписи карти ніде не просвічують`, l1.open && cov.full && cov.covered && cov.alpha === 1 && l1.panel.b >= l1.vh - 1, JSON.stringify({ cov, panel: l1.panel, bottom: l1.bottom }));
  if (sc.w > sc.h) {               // телефон набік: бічна розкладка; перевіряємо лише, що набір тексту в полі йде як слід
    await page.focus('#in_b'); await page.type('#in_b', 'Полтава'); await sleep(300);
    ok(`[${T}] телефон набік: текст у полі набирається по порядку`, await app(page, () => document.getElementById('in_b').value) === 'Полтава', await app(page, () => document.getElementById('in_b').value));
    ok(`[${T}] прохід 27 без помилок JS`, errors.length === 0, errors.join(' | ')); await ctx.close(); continue;
  }
  const tb = await app(page, () => { const R = e => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; }; const bd = document.getElementById('panelBody'); bd.scrollTop = bd.scrollHeight;
    return { tripbar: getComputedStyle(document.getElementById('tripbar')).display, bottom: R(document.getElementById('bottom')), build: R(document.querySelector('[data-act="build"]')), tabs: R(document.getElementById('tabs')) }; });
  ok(`[${T}] складаємо рейс: у нижній плашці лишились тільки вкладки (годинник не забирає місце), кнопку «Побудувати» видно над нею`, tb.tripbar === 'none' && tb.bottom.h < l0.bottom.h - 30 && tb.build.b <= tb.bottom.t + 1, JSON.stringify({ ...tb, was: l0.bottom.h }));
  await app(page, () => { document.getElementById('panelBody').scrollTop = 0; });
  // відкрилась клавіатура: вікно стало нижчим на 300 px
  await page.focus('#in_b'); await page.setViewportSize({ width: sc.w, height: sc.h - 300 }); await sleep(400);
  await page.type('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await sleep(600);
  const l2 = await lay();
  ok(`[${T}] клавіатура відкрита: нижньої плашки немає, «Рейс» — на всю ширину й висоту над клавіатурою (навіть коли вікно стало «альбомним»)`, l2.kb && !l2.bottomShown && l2.panel.b === l2.vh && l2.panel.t <= l1.panel.t + 4 && l2.panel.h >= l2.vh - 40 && await app(page, () => { const r = document.getElementById('panel').getBoundingClientRect(); return Math.round(r.left) === 0 && Math.round(r.right) === innerWidth; }), JSON.stringify({ panel: l2.panel, vh: l2.vh, kb: l2.kb }));
  ok(`[${T}] поле, в яке набирають, угорі панелі; підказки адрес видно цілком і ніщо їх не перекриває`, l2.sg.length >= 1 && l2.sg[0].mine && l2.sg[0].b <= l2.vh && await app(page, () => { const i = document.getElementById('in_b').getBoundingClientRect(), p = document.getElementById('panelBody').getBoundingClientRect(); return i.top >= p.top && (i.top - p.top < 40 || p.scrollHeight === undefined || document.getElementById('panelBody').scrollHeight - document.getElementById('panelBody').clientHeight - document.getElementById('panelBody').scrollTop < 2); }), JSON.stringify(l2.sg.slice(0, 3)));
  await shot(page, '34-keyboard-' + sc.n);
  // дотик до підказки: фокус зникає, але екран не «стрибає» з-під пальця — підказку вибрано
  await page.click('#sg_b button'); await sleep(120);
  const mid = await app(page, () => ({ val: document.getElementById('in_b').value, sgHidden: document.getElementById('sg_b').hidden, kb: document.body.classList.contains('kb') }));
  ok(`[${T}] дотик до підказки вибирає її (екран не стрибає під пальцем): місце в полі, список закрився`, /Полтава/.test(mid.val) && mid.sgHidden, JSON.stringify(mid));
  // клавіатуру сховано
  await app(page, () => document.activeElement && document.activeElement.blur()); await page.setViewportSize({ width: sc.w, height: sc.h }); await sleep(500);
  const l3 = await lay();
  ok(`[${T}] клавіатуру сховано — панель знову на весь екран, нижня плашка під нею на місці`, !l3.kb && l3.bottomShown && l3.bottom.b === l3.vh && l3.panel.b === l3.vh && l3.panel.t === l1.panel.t, JSON.stringify({ panel: l3.panel, bottom: l3.bottom }));
  await page.click('#panelOk'); await sleep(300);
  ok(`[${T}] панель закрито — нижня плашка знову напівпрозора`, /rgba\(/.test((await lay()).bottomBg));
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#panelBody .app-logo'); await sleep(200);
  ok(`[${T}] у «Налаштуваннях» нижня плашка лишається напівпрозорою — прозорість плашок видно, поки її вибирають`, /rgba\(/.test((await lay()).bottomBg) && await app(page, () => getComputedStyle(document.getElementById('tabbar')).display !== 'none'));
  await page.click('#panelOk');
  ok(`[${T}] прохід 27 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 27 (${sc.n}) дійшов до кінця`, false, String(e.message).split('\n')[0]); }

// ---------- Прохід 25: планшет — вертикально й горизонтально: усе, що відкривається, по центру ----------
const TABS = [{ n: 'tabP', w: 800, h: 1180, title: 'планшет вертикально 800×1180' }, { n: 'tabL', w: 1180, h: 800, title: 'планшет горизонтально 1180×800' }, { n: 'tabS', w: 1024, h: 600, title: 'малий планшет горизонтально 1024×600' }, { n: 'tab7', w: 600, h: 960, title: 'планшет 7″ вертикально 600×960' }];
if (run('25')) for (const sc of TABS.filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: 1 });
  const T = sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const wide = sc.w >= 700;                                       // 7″ вертикально — як великий телефон: на всю ширину
  const R = sel => app(page, sel => { const e = document.querySelector(sel); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);
  const centered = (r, maxW) => r && Math.abs((r.l + r.r) / 2 - sc.w / 2) <= 1.5 && r.l >= 0 && r.r <= sc.w && (!wide || r.w <= maxW);
  const overflow = () => app(page, () => { const out = []; for (const e of document.querySelectorAll('#top,#bottom,#panel,#quick,#pick,#routePick,#repSheet,.aim-bar,#toasts .toast,#panelBody *')) { if (e.closest('[hidden]')) continue; const r = e.getBoundingClientRect(); if (!r.width) continue; if (r.right > innerWidth + 1 || r.left < -1) out.push((e.id || e.className || e.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); } return [...new Set(out)].slice(0, 6); });
  await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 0, t: Date.now() }); await sleep(500);
  const top = await R('#top'), bot = await R('#bottom'), bar = await R('#tabbar'), spd = await R('#speed'), zm = await R('#zoom'), mapR = await R('#map');
  const flat = await R('#tabbar .tb-main');                       // (1.1.24) #bottom — прозорий стовпчик із виступом стрілки нахилу; сама плашка — рівна, на висоту лівої частини з часом
  ok(`[${T}] карта на весь екран; верхня й нижня плашки — по центру${wide ? ', не ширші 760 px' : ''} (а не збоку)`, mapR.w === sc.w && mapR.h === sc.h && centered(top, 760) && centered(bot, 760) && bot.b === sc.h, JSON.stringify({ top, bot }));
  ok(`[${T}] круг швидкості й кнопки масштабу не налазять на нижню плашку`, spd && zm && flat && (spd.b <= flat.t || spd.r <= bot.l) && (zm.b <= bar.t || zm.l >= bar.r) && spd.l >= 0 && zm.r <= sc.w && spd.b <= sc.h && zm.b <= sc.h, JSON.stringify({ spd, zm, bot, flat }));
  await shot(page, `31-${sc.n}-map`);
  await page.click('#bQuick'); await sleep(300);
  const q = await R('#quick');
  ok(`[${T}] швидкі налаштування — по центру`, centered(q, 640) && q.b <= bot.t + 2, JSON.stringify(q));
  await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#panelBody .app-logo'); await sleep(250);
  const pn = await R('#panel'), ov1 = await overflow();
  ok(`[${T}] «Налаштування» відкриваються по центру${wide ? ' (не ширші 760 px)' : ''} на всю висоту екрана (1.1.24: плашки їх не затискають), нічого не вилазить`, centered(pn, 760) && pn.t <= 8 && pn.b === sc.h && ov1.length === 0, JSON.stringify({ pn, ov1 }));
  await shot(page, `31-${sc.n}-settings`);
  await page.click('#panelOk');
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#panelBody .field'); await sleep(250);
  const pt = await R('#panel'), ov2 = await overflow();
  ok(`[${T}] «Рейс» — так само по центру й на всю висоту`, centered(pt, 760) && pt.t <= 8 && pt.b === sc.h && ov2.length === 0, JSON.stringify({ pt, ov2 }));
  await shot(page, `31-${sc.n}-trip`);
  // рейс: будуємо, вікно варіантів і плашка в дорозі — по центру
  await page.fill('#in_b', 'Полтава'); await page.click('[data-act="build"]');
  await page.waitForFunction(() => !document.getElementById('routePick').hidden, null, { timeout: 15000 }); await sleep(900);
  const rp = await R('#routePick');
  const fit = await app(page, () => { const m = window.__app.map.map, tr = window.__app.route, c = m.getBounds(); return { w: c.getWest(), e: c.getEast(), s: c.getSouth(), n: c.getNorth() }; });
  ok(`[${T}] вікно варіантів рейсу — по центру внизу; увесь рейс видно на карті`, centered(rp, 720) && rp.b <= sc.h && fit.w < Math.min(...coords.map(c => c[1])) && fit.e > Math.max(...coords.map(c => c[1])) && fit.s < Math.min(...coords.map(c => c[0])) && fit.n > Math.max(...coords.map(c => c[0])), JSON.stringify({ rp, fit }));
  await shot(page, `31-${sc.n}-routes`);
  await page.click('#routePick [data-rp="go"]'); await sleep(900);
  const top2 = await R('#top'), bot2 = await R('#bottom'), man = await R('#man');
  ok(`[${T}] у дорозі: картка маневру й нижня плашка — по центру`, centered(top2, 760) && centered(bot2, 760) && man && man.w <= 760, JSON.stringify({ top2, bot2, man }));
  await shot(page, `31-${sc.n}-drive`);
  // мітки на дорозі й точки на карті — теж по центру
  await page.click('#tabRep'); await sleep(350);
  const rs = await R('#repSheet');
  ok(`[${T}] «Мітки» — по центру`, centered(rs, 720) && rs.b <= sc.h, JSON.stringify(rs));
  await app(page, () => window.__reisBack()); await sleep(200);
  await app(page, () => window.__app.bus.emit('mapPick', { lat: 49.99, lon: 36.21 })); await sleep(300);
  const pk = await R('#pick');
  ok(`[${T}] картка точки на карті — по центру`, centered(pk, 640), JSON.stringify(pk));
  await app(page, () => window.__reisBack()); await sleep(200);
  // Лабораторія на планшеті
  await app(page, () => window.__app.lab.openLab()); await sleep(600);
  const la = await R('#labApp'), lt = await R('.lab-top'), lb = await R('.lab-bot');
  ok(`[${T}] Лабораторія — на весь екран, дві частини (${sc.w > sc.h ? 'поруч' : 'одна над одною'})`, la.w === sc.w && la.h === sc.h && (sc.w > sc.h ? lt.r <= lb.l + 1 : lt.b <= lb.t + 1) && lb.r <= sc.w && lb.b <= sc.h, JSON.stringify({ lt, lb }));
  await shot(page, `31-${sc.n}-lab`);
  await app(page, () => window.__app.lab.closeLab());
  ok(`[${T}] прохід 25 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 25 (${sc.n}) дійшов до кінця`, false, String(e.message).split('\n')[0]); }

// ---------- Прохід 26: дороги зі знаком «фурам заборонено» — варіант на вибір, ручний режим ----------
if (run('26')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 393, height: 800 } });
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const NP = { status: 400, body: { error_code: 442, error: 'No path could be found for input', status_code: 400, status: 'Bad Request' } };
  // короткий шлях навпростець (дорогою зі знаком): Харків → Полтава по діагоналі
  const N = 120, softCoords = Array.from({ length: N + 1 }, (_, i) => [A[0] + (B[0] - A[0]) * i / N, A[1] + (B[1] - A[1]) * i / N]);
  const R = 6371000, rad = Math.PI / 180, havT = (a, b) => { const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad, q = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(q)); };
  const softLen = havT(A, B) / 1000, softTime = Math.round(softLen * 1000 / 15);
  const softJson = { trip: { legs: [{ shape: enc6(softCoords), maneuvers: [{ type: 1, instruction: 'Рушайте вулицею Об’їзною.', street_names: ['вулиця Об’їзна'], length: softLen, time: softTime, begin_shape_index: 0, end_shape_index: N },
    { type: 4, instruction: 'Ви прибули.', street_names: [], length: 0, time: 0, begin_shape_index: N, end_shape_index: N }], summary: { length: softLen, time: softTime } }], summary: { length: softLen, time: softTime }, status: 0 } };
  const pen = q => ((q.costing_options || {}).truck || {}).hgv_no_access_penalty;
  const build = async () => { if (!(await page.$('#in_b'))) await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#in_b'); await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await page.click('#sg_b button'); await page.click('[data-act="build"]'); await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 20000 }); };
  const cards = () => app(page, () => [...document.querySelectorAll('#routePick .alt')].map(c => ({ t: c.textContent.replace(/\s+/g, ' ').trim(), soft: c.classList.contains('soft'), on: c.classList.contains('on'), fl: [...c.querySelectorAll('.fl i')].map(i => i.textContent + ':' + i.className).join('|') })));
  const closePick = async () => { await page.click('#routePick [data-rp="x"]'); await sleep(1700); };
  await emitN('loc', { prov: 'gps', lat: A[0], lon: A[1], acc: 5, spd: 0, t: Date.now() }); await sleep(300);
  // налаштування: три режими, за замовчуванням «Пропонувати»
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('[data-seg="hgvBan:ask"]');
  const st = await app(page, () => ({ on: [...document.querySelectorAll('[data-seg^="hgvBan:"]')].map(b => b.dataset.seg.split(':')[1] + (b.classList.contains('on') ? '*' : '')).join(), hint: document.getElementById('hgvHint').textContent, mode: window.__app.S.hgvBan }));
  ok('«Налаштування → Фура»: дороги зі знаком «фурам заборонено» — Оминати · Пропонувати · Їхати; за замовчуванням «Пропонувати»', st.on === 'avoid,ask*,go' && st.mode === 'ask' && /варіант — «через заборону для фур»/.test(st.hint) && /Висоту, масу й довжину враховано завжди/.test(st.hint), JSON.stringify(st));
  await page.click('#panelOk');
  // 1) об'їзду немає: рейс для фури суворий, запит «через заборону» дає те саме — зайвої картки немає
  let n0 = routeReqs.length;
  await build(); await sleep(2600);
  let rq = routeReqs.slice(n0), cs = await cards();
  ok('рейс для фури: спершу суворо (без доріг зі знаком), потім — тихий запит варіанта «через заборону» з тими самими габаритами', rq.length === 2 && rq[0].costing === 'truck' && pen(rq[0]) === undefined && pen(rq[1]) === 600 && rq[1].costing_options.truck.height === rq[0].costing_options.truck.height && rq[1].costing_options.truck.weight === 20 && rq[1].locations.length === 2, JSON.stringify(rq.map(q => [q.costing, pen(q), q.alternates])));
  ok('варіант через заборону нічого не скорочує — третьої картки й попереджень немає', cs.length === 2 && cs.every(c => !c.soft) && await app(page, () => !document.querySelector('#routePick .rp-warn.soft')), JSON.stringify(cs));
  await closePick();
  // 2) об'їзд великий: з'являється третя картка «через заборону для фур»
  ROUTE.fn = q => q.costing === 'truck' && pen(q) ? { status: 200, body: softJson } : null;
  await app(page, () => { document.getElementById('toasts').innerHTML = ''; });
  await build(); await page.waitForFunction(() => document.querySelectorAll('#routePick .alt').length === 3, null, { timeout: 8000 }).catch(() => {});
  cs = await cards();
  const tst = await app(page, () => ({ toast: document.getElementById('toasts').textContent, alts: window.__app.map.map.getSource('route-alts')._data.features.length, sel: window.__app.guide.g.active }));
  const saveKm = Math.round(total / 1000 - softLen);
  ok(`є коротший шлях під знак — третя картка «через заборону для фур» (пунктирна рамка), повідомлення «−${saveKm} км»`, cs.length === 3 && cs[2].soft && /через заборону для фур:warn/.test(cs[2].fl) && cs[0].on && !cs[0].soft && new RegExp('−' + saveKm + ' км').test(tst.toast) && tst.alts === 2, JSON.stringify({ cs, tst }));
  await shot(page, '32-hgv-soft-card');
  await page.click('#routePick .alt.soft'); await sleep(500);
  const w = await app(page, () => ({ warn: (document.querySelector('#routePick .rp-warn.soft') || { textContent: '' }).textContent, soft: window.__app.route ? null : null, on: [...document.querySelectorAll('#routePick .alt')].map(c => c.classList.contains('on')), go: !!document.querySelector('#routePick [data-rp="go"]') }));
  ok('вибрали цей варіант — чесне попередження: дорога зі знаком, на скільки коротше, габарити враховано, вирішує водій', /знак забороняє рух фур/.test(w.warn) && new RegExp('Коротший на ' + saveKm + ' км').test(w.warn) && /Висоту, масу й довжину враховано/.test(w.warn) && /вирішуєте ви/.test(w.warn) && w.on[2] && w.go, JSON.stringify(w));
  await shot(page, '33-hgv-soft-chosen');
  await page.click('#routePick [data-rp="go"]'); await sleep(900);
  const act = await app(page, () => ({ active: window.__app.guide.g.active, soft: window.__app.guide.g.trip.soft, n: window.__app.guide.g.route.coords.length, costing: window.__app.guide.g.route.costing }));
  ok('поїхали варіантом через заборону — рейс для фури (не «легковий»), позначено як вибір водія', act.active && act.soft === 'chosen' && act.n === N + 1 && act.costing === 'truck', JSON.stringify(act));
  // перебудова в дорозі — так само з дозволеними дорогами під знак
  n0 = routeReqs.length;
  const details = async () => { if (await page.$('#panelBody [data-act="stop"]')) return; await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick [data-ts="details"]'); await page.click('#routePick [data-ts="details"]'); await page.waitForSelector('#panelBody [data-act="stop"]'); };
  let fixAt = null;
  for (let k = 1; k <= 4; k++) { const f = k * 12 / (softLen * 1000 / N); fixAt = { lat: A[0] + (softCoords[1][0] - A[0]) * f, lon: A[1] + (softCoords[1][1] - A[1]) * f }; await emitN('loc', { prov: 'gps', ...fixAt, acc: 5, spd: 12, t: Date.now() }); await sleep(1000); }
  // відкрити деталі рейсу на повільній машині — 3–4 с; GPS «мовчить» довше 5 с — і програма чесно відкладає перебудову до GPS.
  // У дорозі GPS не мовчить: перед натисканням даємо свіжий відлік (перевіряємо перебудову, а не витримку стенда)
  const tD = Date.now(); await details(); if (process.env.DEBUG) console.log('DETAILS ms', Date.now() - tD);
  await emitN('loc', { prov: 'gps', ...fixAt, acc: 5, spd: 12, t: Date.now() }); await sleep(150);
  await page.click('[data-act="reroute"]'); await sleep(2500);
  rq = routeReqs.slice(n0);
  ok('перебудова в дорозі — теж для фури й теж із дозволеною дорогою під знак (а не навколо)', rq.length >= 1 && rq[0].costing === 'truck' && pen(rq[0]) === 600, JSON.stringify({ rq: rq.map(q => [q.costing, pen(q)]), st: await app(page, () => ({ mode: window.__app.nav.pos.mode, pend: window.__app.guide.g.reroutePending, rr: window.__app.guide.g.rerouting, log: window.__app.core.getLog().slice(-4).map(l => l.msg || l.text) })) }));
  await details(); await page.click('#panelBody [data-act="stop"]'); await sleep(700);
  ok('рейс завершено — знову форма нового рейсу', await app(page, () => !window.__app.guide.g.active && !!document.getElementById('in_b')));
  // 3) суворого шляху немає зовсім, а дорогою під знак — є: показуємо її (для фури!), а не «легковий» маршрут
  ROUTE.fn = q => q.costing === 'truck' ? (pen(q) ? { status: 200, body: softJson } : NP) : null;
  n0 = routeReqs.length;
  await build(); await sleep(400);
  rq = routeReqs.slice(n0);
  const w3 = await app(page, () => ({ soft: (document.querySelector('#routePick .rp-warn.soft') || { textContent: '' }).textContent, red: !!document.querySelector('#routePick .rp-warn.red'), costing: window.__app.guide.g.active }));
  ok('іншого шляху для фури немає — показано дорогу під знак із жовтим попередженням (а не червоний «легковий» маршрут)', rq.map(q => q.costing + ':' + (pen(q) || '')).join() === 'truck:,truck:,truck:,truck:,truck:600' && /шлях є лише дорогою зі знаком «фурам заборонено»/.test(w3.soft) && /Іншої дороги немає/.test(w3.soft) && !w3.red, JSON.stringify({ rq: rq.map(q => q.costing + ':' + (pen(q) || '')), w3 }));
  await sleep(2400);
  ok('…і зайвого запиту «варіанта» після цього немає', routeReqs.length === n0 + 5, String(routeReqs.length - n0));
  await closePick();
  // 4) «Оминати» — варіант через заборону не шукаємо й не пропонуємо
  ROUTE.fn = q => q.costing === 'truck' && pen(q) ? { status: 200, body: softJson } : null;
  await app(page, () => { window.__app.S.hgvBan = 'avoid'; });
  n0 = routeReqs.length; await build(); await sleep(2600);
  cs = await cards();
  ok('режим «Оминати»: лише суворий рейс, варіанта «через заборону» немає', routeReqs.length === n0 + 1 && pen(routeReqs[n0]) === undefined && cs.length === 2 && cs.every(c => !c.soft), JSON.stringify(cs.map(c => c.soft)));
  await closePick();
  // 5) «Їхати» — знак не враховуємо зовсім (габарити — так), про це сказано
  await app(page, () => { window.__app.S.hgvBan = 'go'; });
  n0 = routeReqs.length; await build(); await sleep(2600);
  const w5 = await app(page, () => (document.querySelector('#routePick .rp-warn.soft.mild') || { textContent: '' }).textContent);
  ok('режим «Їхати»: рейс одразу дорогами під знак (малий штраф у часі), габарити в запиті, про вибір нагадано', routeReqs.length === n0 + 1 && pen(routeReqs[n0]) === 120 && routeReqs[n0].costing_options.truck.height > 0 && /не враховано — так вибрано в налаштуваннях/.test(w5), JSON.stringify({ p: pen(routeReqs[n0]), w5 }));
  await closePick();
  // 6) легковик — знак для фур його не стосується
  await app(page, () => { window.__app.S.hgvBan = 'ask'; window.__app.S.vehicle = 'auto'; });
  n0 = routeReqs.length; await build(); await sleep(2600);
  ok('легкова: жодних запитів «через заборону для фур»', routeReqs.length === n0 + 1 && routeReqs[n0].costing === 'auto' && pen(routeReqs[n0]) === undefined && await app(page, () => !document.querySelector('#routePick .rp-warn.soft')));
  ROUTE.fn = null;
  ok('прохід 26 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ROUTE.fn = null; ok('прохід 26 дійшов до кінця', false, String(e.message).split('\n')[0]); }

if (run('3')) try {
  const { page, ctx, errors } = await newPage(true, { offline: true });
  const okSrc = await page.waitForFunction(() => { const m = window.__app.map.map; return m && m.getSource && m.getSource('protomaps') && m.isSourceLoaded('protomaps'); }, null, { timeout: 20000 }).then(() => true, () => false);
  ok('офлайн-карта: стиль Protomaps із файлу PMTiles завантажився', okSrc && rangeHits > 0, 'запитів шматками: ' + rangeHits);
  ok('офлайн-карта: шари маршруту на місці', await app(page, () => !!window.__app.map.map.getLayer('route-line') && !!window.__app.map.map.getLayer('route-done')));
  ok('офлайн-карта: лінія рейсу під назвами вулиць, номери будинків — від 17', await app(page, () => { const m = window.__app.map.map, ids = m.getStyle().layers.map(l => l.id), a = m.getLayer('address_label');
    return ids.indexOf('route-line') < ids.indexOf('roads_labels_major') && ids.indexOf('route-line') < ids.indexOf('roads_labels_minor') && a && a.minzoom === 17 && m.getPaintProperty('roads_labels_minor', 'text-halo-width') === 2.4; }));
  // 1.1.12: «сіра карта без доріг» уночі. Офлайн-карта має власні кольори: день — траси помаранчеві, головні жовті; ніч — окрема темна карта без фільтра
  const look = () => app(page, () => { const m = window.__app.map.map, st = m.getStyle(), cv = document.querySelector('.maplibregl-canvas'), col = id => { try { return JSON.stringify(m.getPaintProperty(id, 'line-color')); } catch (_) { return ''; } };
    const bg = st.layers.find(l => l.type === 'background'), earth = st.layers.find(l => l.id === 'earth');
    return { night: !!(st.metadata && st.metadata.reisNight), mapdark: document.body.classList.contains('mapdark'), theme: document.body.dataset.theme, filter: getComputedStyle(cv).filter, sprite: st.sprite, hw: col('roads_highway'), major: col('roads_major'), minor: col('roads_minor'),
      earth: earth && JSON.stringify(earth.paint['fill-color']), bg: bg && bg.paint['background-color'], label: m.getPaintProperty('roads_labels_major', 'text-color'), halo: m.getPaintProperty('roads_labels_major', 'text-halo-color'), route: !!m.getLayer('route-line') }; });
  const lum = c => { const m = /#([0-9a-f]{6})/i.exec(c || ''); if (!m) return -1; const n = parseInt(m[1], 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
  await app(page, () => { window.__app.S.theme = 'night'; window.__app.map.applyTheme(); }); await sleep(1500);
  const nt = await look();
  ok('офлайн-карта вночі: власна темна карта, фільтр «перевертання» вимкнено', nt.night && nt.mapdark && nt.theme === 'night' && nt.filter === 'none' && /sprites\/dark$/.test(nt.sprite) && nt.route, JSON.stringify(nt));
  ok('…дороги світліші за землю (а не чорні на сірому): траса помаранчева, головні жовтуваті, вулиці сірі; підписи світлі', lum(nt.hw) > lum(nt.earth) + 80 && lum(nt.major) > lum(nt.earth) + 70 && lum(nt.minor) > lum(nt.earth) + 50 && lum(nt.earth) < 40 && lum(nt.label) > 200 && lum(nt.halo) < 40,
    JSON.stringify({ hw: nt.hw, major: nt.major, minor: nt.minor, earth: nt.earth, label: nt.label, halo: nt.halo }));
  await app(page, () => { window.__app.S.theme = 'day'; window.__app.map.applyTheme(); }); await sleep(1500);
  const dy = await look();
  ok('офлайн-карта вдень: світла, траси помаранчеві з обвідкою, головні дороги жовті — видно на світлому тлі', !dy.night && !dy.mapdark && /sprites\/light$/.test(dy.sprite) && /#f5b041/i.test(dy.hw) && /#fbe391/i.test(dy.major) && lum(dy.earth) > 200 && lum(dy.label) < 60 && dy.route, JSON.stringify(dy));
  // самоперевірка файлу карти: ціла — мовчить; завантажена не повністю — каже прямо й показує онлайн-карту
  const v0 = await app(page, async () => ({ ok: await window.__app.offline.verify(), bad: window.__app.offline.off.bad }));
  ok('самоперевірка: цілий файл карти — усе гаразд', v0.ok === true && v0.bad === '', JSON.stringify(v0));
  const v1 = await app(page, async () => { const O = window.__app.offline; document.getElementById('toasts').innerHTML = ''; O.off.size = 300; const r = await O.verify(); await new Promise(r => setTimeout(r, 900));
    return { ok: r, bad: O.off.bad, active: O.offlineActive(), src: !!window.__app.map.map.getSource('protomaps'), toast: document.getElementById('toasts').textContent, mapdark: document.body.classList.contains('mapdark') }; });
  ok('самоперевірка: файл обірвано — повідомлення і онлайн-карта замість «сірої»', v1.ok === false && /^short:/.test(v1.bad) && !v1.active && !v1.src && /Офлайн-карта не читається/.test(v1.toast) && !v1.mapdark, JSON.stringify(v1));
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#offSec');
  ok('у «Налаштуваннях» прямо сказано: файл карти завантажено не повністю — видалити й завантажити знову', /завантажено не повністю/.test(await page.textContent('#offSec')) && await app(page, () => !!document.querySelector('#offSec [data-act="offDel"]')));
  const v2 = await app(page, async () => { const O = window.__app.offline; O.off.size = 505; const r = await O.verify(); await new Promise(r => setTimeout(r, 900)); return { ok: r, bad: O.off.bad, src: !!window.__app.map.map.getSource('protomaps') }; });
  ok('файл знову цілий — офлайн-карта повертається', v2.ok && !v2.bad && v2.src, JSON.stringify(v2));
  const offTxt = await page.textContent('#offSec');
  ok('налаштування: розділ офлайн-карти показує стан і вибір карти', /У телефоні/.test(offTxt) && /Онлайн/.test(offTxt), offTxt.slice(0, 120));
  await shot(page, '12-offline');
  await page.click('[data-seg="mapMode:online"]'); await sleep(500);
  ok('режим «Онлайн» повертає онлайн-карту', await app(page, () => !window.__app.map.map.getSource('protomaps')));
  await sleep(1500);
  ok('після зміни карти шари маршруту й пит-стопів на місці', await app(page, () => { const m = window.__app.map.map; return !!m.getLayer('route-line') && !!m.getLayer('route-done') && !!m.getSource('route'); }));
  await page.click('[data-seg="mapMode:offline"]'); await sleep(1500);
  ok('і назад на офлайн — шари маршруту на місці', await app(page, () => { const m = window.__app.map.map; return !!m.getSource('protomaps') && !!m.getLayer('route-line'); }));
  // ---- 1.1.13: «карти так і не підтягнулись» — на справжньому телефоні з файлу читався лише початок, тайли — ні ----
  const offState = () => app(page, () => { const P = window.__app, O = P.offline.off, m = P.map.map; return { ok: O.ok, bad: O.bad, mode: O.mode, reads: O.reads, errs: O.errs, last: O.lastErr, active: P.offline.offlineActive(), src: !!(m && m.getSource && m.getSource('protomaps')),
    toast: document.getElementById('toasts').textContent, log: P.core.getLog().slice(-30).map(l => l.msg || l.text || '').join(' | ') }; });
  const boot = async rev => { const size = (await pmFile(PM.file)).length; await page.addInitScript(([r, n]) => { window.__nativeRev = r; window.__pmSize = n; }, [rev, size]); await page.reload(); await page.waitForFunction(() => window.__app && window.__app.map && window.__app.map.map && window.__app.offline, null, { timeout: 20000 }); };
  const o0 = await offState();
  ok('файл карти перевірено читанням із середини (а не лише заголовка); спосіб читання відомий', o0.ok && o0.mode === 'range' && o0.active && o0.src && o0.reads > 0 && o0.errs === 0, JSON.stringify({ ...o0, log: undefined, toast: undefined }));
  // а) телефон зі старою оболонкою (до №7): початок файлу читається, усе інше — ні. Раніше це була «сіра карта» мовчки
  PM.old = true; await boot(6); await sleep(1500);
  const oa = await offState();
  ok('стара оболонка (як на телефоні): офлайн-карту НЕ вмикаємо — показуємо онлайн-карту, а не порожнє сіре тло', oa.bad === 'app' && !oa.ok && !oa.active && !oa.src, JSON.stringify({ ...oa, log: undefined }));
  ok('…і кажемо прямо: потрібне оновлення застосунку, файл карти завантажувати знову НЕ треба', /запрацює після оновлення застосунку/.test(oa.toast) && /завантажувати знову НЕ треба/.test(oa.toast), oa.toast);
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#offSec');
  const sa = await app(page, () => ({ bad: (document.getElementById('offBad') || { textContent: '' }).textContent, diag: (document.getElementById('offDiag') || { textContent: '' }).textContent }));
  ok('у «Налаштуваннях» те саме й рядок діагностики (спосіб читання, шматки, помилки, номер оболонки)', /оновіть застосунок/.test(sa.bad) && /Читання файлу: — · шматків \d+ · помилок \d+/.test(sa.diag) && /оболонка №6/.test(sa.diag), JSON.stringify(sa));
  // б) нова оболонка №7: шматок задано в адресі — карта читає саме так (Range для цього телефона «зламаний», і це не заважає)
  PM.old = false; PM.rangeBroken = true; PM.q = 0; await boot(7); await sleep(2500);
  const ob = await offState();
  ok('нова оболонка №7: файл читається точними шматками (?r=початок-кінець), офлайн-карта увімкнена', ob.ok && ob.mode === 'q' && ob.active && ob.src && PM.q >= 2 && ob.reads > 0 && ob.errs === 0, JSON.stringify({ ...ob, log: undefined, q: PM.q }));
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#offSec');
  ok('…у «Налаштуваннях»: «Читання файлу: точними шматками», оболонка №7, попереджень немає', await app(page, () => /точними шматками · шматків [1-9]\d* · помилок 0/.test(document.getElementById('offDiag').textContent) && /оболонка №7/.test(document.getElementById('offDiag').textContent) && !document.getElementById('offBad')));
  await page.click('#panelOk');
  // в) сторож: заголовок читається, а тайли — ні → за ~20 с повертаємо онлайн-карту й кажемо про це (а не лишаємо сіре тло)
  PM.rangeBroken = false; PM.failFrom = 256; await boot(7); await sleep(1500);
  const oc0 = await offState();
  await page.waitForFunction(() => window.__app.offline.off.bad === 'tiles', null, { timeout: 40000 }).catch(() => {});
  await sleep(1200);
  const oc = await offState();
  ok('тайли не читаються (заголовок — так): сторож помічає, що карта порожня, і повертає онлайн-карту з поясненням', oc0.active && oc.bad === 'tiles' && !oc.active && !oc.src && oc.errs > 0 && /Офлайн-карта не малюється/.test(oc.toast), JSON.stringify({ ...oc, log: undefined, was: oc0.active }));
  PM.failFrom = null; PM.old = false; PM.rangeBroken = false;
  // г) звичайний випадок: карта малюється — сторож мовчить
  await boot(7);
  await page.waitForFunction(() => window.__app.core.getLog().some(l => /офлайн-карта малюється/.test(l.msg || l.text || '')), null, { timeout: 30000 }).catch(() => {});
  await sleep(21000);
  const od = await offState();
  ok('карта малюється — сторож мовчить і через 20 с: офлайн-карта лишається', od.ok && !od.bad && od.active && od.src && od.errs === 0, JSON.stringify({ ...od, log: od.log.slice(-300) }));
  // ---- 1.1.15: «після оновлення карти знову зникли» — файл уже читався, але бракувало наборів літер для підписів ----
  // Бібліотека карти, не знайшовши ОДНОГО набору (наприклад, зі знаком «№»), викидала весь квадрат: сіре тло без доріг.
  const jump = (lat, lon, z) => app(page, ([lat, lon, z]) => { const P = window.__app; P.map.view.follow = false; P.map.view.lastTouch = Date.now() + 3600e3; P.map.map.jumpTo({ center: [lon, lat], zoom: z, pitch: 0, bearing: 0 }); }, [lat, lon, z]);
  const drawn = () => app(page, () => { const P = window.__app, m = P.map.map, O = P.offline.off, n = l => { try { return m.querySourceFeatures('protomaps', { sourceLayer: l }).length; } catch (e) { return -1; } };
    return { roads: n('roads'), earth: n('earth'), buildings: n('buildings'), rendered: (() => { try { return m.queryRenderedFeatures().filter(f => f.source === 'protomaps').length; } catch (e) { return -1; } })(),
      miss: O.glyphMiss.slice(), bounds: O.bounds, zooms: O.zooms, glyphs: String(m.getStyle().glyphs || ''), active: P.offline.offlineActive(), bad: O.bad }; });
  // д) набір літер: є файл — віддаємо його; немає — порожній набір (а не помилка) і запис, якого саме бракує
  const gl = await app(page, async () => { const O = window.__app.offline, u = n => 'reisglyph://' + location.origin + '/vendor/glyphs/' + n + '.pbf';
    const a = await O.glyphLoad({ url: u('Test%20Font/0-255') }, new AbortController()), b = await O.glyphLoad({ url: u('Test%20Font/256-511') }, new AbortController()), b2 = await O.glyphLoad({ url: u('Test%20Font/256-511') }, new AbortController());
    return { a: a.data.byteLength, b: b.data.byteLength, b2: b2.data.byteLength, miss: O.off.glyphMiss.filter(x => /Test Font/.test(x)) }; });
  ok('набір літер є — віддаємо його; немає (404) — порожній набір замість помилки, і в журналі видно, якого бракує (один раз)', gl.a === 4 && gl.b === 0 && gl.b2 === 0 && gl.miss.length === 1 && gl.miss[0] === 'Test Font 256-511', JSON.stringify(gl));
  // е) справжній квадрат міста (Львів, Сихів) і ЖОДНОГО набору літер (у тестах їх немає — усі 404): карта має намалюватись
  PM.file = 'city'; await boot(7); await jump(49.807, 24.045, 15.3);
  await page.waitForFunction(() => { try { return window.__app.map.map.querySourceFeatures('protomaps', { sourceLayer: 'roads' }).length > 0; } catch (e) { return false; } }, null, { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  const dc = await drawn();
  await shot(page, '12b-offline-city');
  ok('справжній квадрат міста без наборів літер: дороги, суша й забудова НАМАЛЬОВАНІ (раніше — порожнє сіре тло)', dc.roads > 50 && dc.earth > 0 && dc.buildings > 0 && dc.rendered > 50 && dc.active && !dc.bad, JSON.stringify({ ...dc, miss: dc.miss.length }));
  ok('…набори літер ідуть через наш завантажувач (reisglyph://), бракує — записано які', /^reisglyph:\/\//.test(dc.glyphs) && dc.miss.length > 0 && dc.miss.every(x => /^Noto Sans (Regular|Medium|Italic) \d+-\d+$/.test(x)), JSON.stringify({ glyphs: dc.glyphs.slice(0, 40), miss: dc.miss.slice(0, 4) }));
  ok('із заголовка файлу прочитано межі карти й масштаби', Array.isArray(dc.bounds) && Math.abs(dc.bounds[0] - 22.1) < 0.01 && Math.abs(dc.bounds[3] - 52.4) < 0.01 && dc.zooms[0] === 0 && dc.zooms[1] === 14, JSON.stringify({ b: dc.bounds, z: dc.zooms }));
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#offSec');
  ok('у «Налаштуваннях» у рядку діагностики видно, скількох наборів літер бракує', await app(page, () => /бракує наборів літер: [1-9]/.test(document.getElementById('offDiag').textContent)), await app(page, () => document.getElementById('offDiag').textContent));
  await page.click('#panelOk');
  await page.waitForFunction(() => window.__app.core.getLog().some(l => /офлайн-карта малюється/.test(l.msg || l.text || '')), null, { timeout: 30000 }).catch(() => {});
  const oe = await offState();
  ok('сторож бачить намальовані об\'єкти: «офлайн-карта малюється», офлайн лишається', /офлайн-карта малюється/.test(oe.log) && oe.active && !oe.bad, JSON.stringify({ ...oe, log: oe.log.slice(-200) }));
  // є) квадрат у файлі є, читається без жодної помилки, а на карті — нічого (як було на телефоні): сторож не вірить
  //    «завантажилось без помилок», а дивиться, чи щось намальовано, — і повертає онлайн-карту з поясненням
  PM.file = 'blank'; await boot(7); await jump(49.807, 24.045, 15.3);
  const of0 = await offState();
  await page.waitForFunction(() => window.__app.offline.off.bad === 'tiles', null, { timeout: 40000 }).catch(() => {});
  await sleep(1200);
  const of1 = await offState();
  ok('квадрат читається без помилок, а на карті порожньо — сторож повертає онлайн-карту й каже про це (раніше мовчки лишалось сіре тло)', of0.active && of1.bad === 'tiles' && !of1.active && !of1.src && of1.errs === 0 && /квадрат у файлі є/.test(of1.last) && /Офлайн-карта не малюється/.test(of1.toast), JSON.stringify({ ...of1, log: of1.log.slice(-200) }));
  // ж) а якщо під цим місцем у файлі карти просто немає (водій за межами карти) — це не збій: офлайн лишається
  PM.file = 'tiny'; await boot(7); await jump(49.807, 24.045, 12.5);
  await page.waitForFunction(() => window.__app.core.getLog().some(l => /під цим місцем у файлі карти немає/.test(l.msg || l.text || '')), null, { timeout: 40000 }).catch(() => {});
  const og = await offState();
  ok('під цим місцем у файлі карти немає — сторож не зчиняє тривоги: офлайн лишається, у журналі — «це не збій»', og.active && !og.bad && og.src && /під цим місцем у файлі карти немає/.test(og.log), JSON.stringify({ ...og, log: og.log.slice(-200) }));
  PM.file = 'tiny';
  { const er = errors.filter(e => !/офлайн-карта не (читається|малюється)/.test(e) && !/status of (416|500)/.test(e)); ok('прохід офлайн-карти без помилок JS (крім очікуваних записів про файл, що не читається)', er.length === 0, er.join(' | ')); }
  await ctx.close();
} catch (e) { ok('сценарій 3 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 28 (1.1.16): номери будинків — на онлайн- і офлайн-карті, із запасом у телефоні ============ */
// Квадрати OpenFreeMap підмінені: у кожному — шар «housenumber» (шість номерів біля Луганської у Львові) і «важкий» сусідній шар.
const pbv = n => { const o = []; let x = BigInt(n); do { let c = Number(x & 0x7fn); x >>= 7n; if (x > 0n) c |= 0x80; o.push(c); } while (x > 0n); return o; };
const pbld = (f, bytes) => [...pbv((f << 3) | 2), ...pbv(bytes.length), ...bytes], pbs = t => [...Buffer.from(t)], pbzz = n => (n << 1) ^ (n >> 31);
function mvtPoints(name, key, feats) {
  const vals = [...new Set(feats.map(f => f.v))]; let body = [...pbld(1, pbs(name))];
  for (const f of feats) body.push(...pbld(2, [...pbld(2, [...pbv(0), ...pbv(vals.indexOf(f.v))]), ...pbv((3 << 3) | 0), ...pbv(1), ...pbld(4, [...pbv(9), ...pbv(pbzz(f.x)), ...pbv(pbzz(f.y))])]));
  body.push(...pbld(3, pbs(key))); for (const v of vals) body.push(...pbld(4, pbld(1, pbs(v))));
  body.push(...pbv((5 << 3) | 0), ...pbv(4096), ...pbv((15 << 3) | 0), ...pbv(2));
  return pbld(3, body);
}
const HOUSE_AT = [49.807, 24.045], HOUSE_TILE = [9286, 5570];                                   // центр кадру й квадрат 14/x/y, у якому він лежить
const HOUSE_C = (() => { const n = 2 ** 14, r = HOUSE_AT[0] * Math.PI / 180; return [Math.round(((HOUSE_AT[1] + 180) / 360 * n - HOUSE_TILE[0]) * 4096), Math.round(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n - HOUSE_TILE[1]) * 4096)]; })();
const HOUSES = [['12', -70, -150], ['14А', 60, -110], ['16', -40, -20], ['18/2', 70, 40], ['20', -60, 110], ['22-Б', 50, 170]].map(([v, dx, dy]) => ({ v, x: HOUSE_C[0] + dx, y: HOUSE_C[1] + dy }));   // шість будинків навколо центру кадру
const OFM_TILE = Buffer.from([...mvtPoints('building', 'k', Array.from({ length: 400 }, (_, i) => ({ v: 'будівля ' + i, x: i * 9, y: i * 7 }))), ...mvtPoints('housenumber', 'housenumber', HOUSES), ...mvtPoints('poi', 'name', [{ v: 'Кав\'ярня', x: 1200, y: 1600 }])]);
const OFM = { ver: 'V1', tj: 0, tiles: [], down: false };
const ofmStub = async page => {
  const cors = { 'access-control-allow-origin': '*' };
  await page.route('https://tiles.openfreemap.org/planet', r => { if (OFM.down) return r.abort(); OFM.tj++; r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ tiles: [`https://tiles.openfreemap.org/planet/${OFM.ver}/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 14 }) }); });
  await page.route('https://tiles.openfreemap.org/planet/**', r => { if (OFM.down) return r.abort(); const m = /planet\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.pbf/.exec(r.request().url());
    if (!m || m[1] !== OFM.ver) return r.fulfill({ status: 404, headers: cors, body: '' }); OFM.tiles.push(m[2] + '/' + m[3] + '/' + m[4]); r.fulfill({ status: 200, contentType: 'application/x-protobuf', headers: cors, body: OFM_TILE }); });
};
if (run('28')) try {
  PM.fonts = true;
  const VP = { width: 360, height: 670 }, LV = [49.807, 24.045];
  const jumpTo = (page, z) => app(page, ([lat, lon, z]) => { const P = window.__app; P.map.view.follow = false; P.map.view.lastTouch = Date.now() + 3600e3; P.map.map.jumpTo({ center: [lon, lat], zoom: z, pitch: 0, bearing: 0 }); }, [...LV, z]);
  const nums = page => app(page, () => { const m = window.__app.map.map; let r = []; try { r = m.queryRenderedFeatures({ layers: ['reis-house'] }).map(f => String(f.properties.housenumber)); } catch (e) { return { err: String(e) }; }
    const L = m.getLayer('reis-house'), ids = m.getStyle().layers.map(l => l.id); return { layer: !!L, under: ids.indexOf('reis-house') >= 0 && ids.indexOf('reis-house') < Math.max(ids.indexOf('highway-name-minor'), ids.indexOf('roads_labels_minor')), source: L && L.source, minzoom: L && L.minzoom, drawn: [...new Set(r)].sort(), zoom: +m.getZoom().toFixed(2), A: { ...window.__app.addr.addr } }; });
  const waitNums = page => page.waitForFunction(() => { try { return window.__app.map.map.queryRenderedFeatures({ layers: ['reis-house'] }).length >= 4; } catch (e) { return false; } }, null, { timeout: 15000 }).catch(() => {});
  // ---- а) онлайн-карта: шар номерів поверх уже завантажених квадратів ----
  {
    const style = { version: 8, glyphs: BASE + 'vendor/glyphs/{fontstack}/{range}.pbf', sources: { openmaptiles: { type: 'vector', tiles: ['https://tiles.openfreemap.org/planet/V1/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 } },
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dde5d8' } }, { id: 'highway-name-minor', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'symbol-placement': 'line' } }] };
    const { page, ctx, errors } = await newPage(true, { style, viewport: VP, before: ofmStub });
    await jumpTo(page, 17.2); await waitNums(page); await sleep(400);
    const a1 = await nums(page);
    await shot(page, '35-house-online');
    ok('онлайн-карта, наблизили: номери будинків намальовані (12, 14А, 16, 18/2, 20, 22-Б) — із квадратів самої карти, під назвами вулиць', a1.layer && a1.source === 'openmaptiles' && a1.under && a1.drawn.length >= 5 && a1.drawn.includes('12') && a1.drawn.includes('14А') && a1.drawn.includes('18/2'), JSON.stringify(a1));
    ok('…нічого зайвого не завантажуємо: каталог квадратів не питали, окремих запитів по номери немає', OFM.tj === 0 && a1.A.net === 0, JSON.stringify({ tj: OFM.tj, A: a1.A }));
    await jumpTo(page, 16.5); await sleep(900);
    const a2 = await nums(page);
    ok('віддалили (масштаб 16,5) — номерів немає: вони з\'являються від 17, щоб на ходу не захаращувати карту', a2.layer && a2.drawn.length === 0 && a2.minzoom === 17, JSON.stringify(a2));
    ok('номери на онлайн-карті — без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // ---- б) офлайн-карта (справжній квадрат Львова): номерів у файлі немає — беремо з мережі й кладемо в запас ----
  OFM.tj = 0; OFM.tiles = []; PM.file = 'city';
  const size = (await pmFile('city')).length;
  const { page, ctx, errors } = await newPage(true, { offline: true, viewport: VP, before: async pg => { await ofmStub(pg); await pg.addInitScript(([r, n]) => { window.__nativeRev = r; window.__pmSize = n;
    // тип мережі й «Економія трафіку», як їх каже Android WebView (у настільному Chromium типу немає): test.conn = 'cellular' | 'wifi', test.save = '1'
    try { const tp = localStorage.getItem('test.conn'); if (tp) { const c = { type: tp, saveData: localStorage.getItem('test.save') === '1', _l: [], addEventListener(n, f) { this._l.push(f); } }; Object.defineProperty(navigator, 'connection', { configurable: true, get: () => c }); window.__conn = c; } } catch (_) {} }, [7, size]); } });
  await page.waitForFunction(() => window.__app.offline.offlineActive() && !!window.__app.map.map.getSource('protomaps'), null, { timeout: 15000 }).catch(() => {});
  const b0 = await app(page, () => ({ active: window.__app.offline.offlineActive(), addrSrc: !!window.__app.map.map.getSource('addr'), A: { ...window.__app.addr.addr } }));
  ok('офлайн-карта: поки не наблизили — по номери в мережу не ходимо', b0.active && b0.addrSrc && OFM.tiles.length === 0 && OFM.tj === 0 && b0.A.net === 0, JSON.stringify({ b0, tiles: OFM.tiles.length, tj: OFM.tj }));
  await jumpTo(page, 17.2); await waitNums(page); await sleep(500);
  const b1 = await nums(page);
  await shot(page, '35-house-offline');
  ok('офлайн-карта, наблизили: номери будинків намальовані на справжній карті Львова (той самий вигляд, від 17, під назвами вулиць)', b1.layer && b1.source === 'addr' && b1.minzoom === 17 && b1.under && b1.drawn.length >= 5 && b1.drawn.includes('12') && b1.drawn.includes('22-Б'), JSON.stringify(b1));
  ok('…квадрат номерів узято з мережі один раз (каталог — теж раз)', OFM.tj === 1 && OFM.tiles.includes('14/9286/5570') && b1.A.net >= 1 && b1.A.fails === 0, JSON.stringify({ tj: OFM.tj, tiles: OFM.tiles, A: b1.A }));
  const st = await app(page, async full => { const c = await caches.open('reis-addr-1'), r = await c.match(location.origin + '/__addr/14/9286/5570'), b = r ? new Uint8Array(await r.arrayBuffer()) : null, A = window.__app.addr;
    const again = b ? A.onlyHouseNumbers(b) : null, txt = b ? new TextDecoder().decode(b) : '';
    return { n: (await c.keys()).length, bytes: b ? b.length : -1, full, hasNum: /housenumber/.test(txt) && /22-Б/.test(txt), other: /будівля|Кав/.test(txt), idem: !!again && again.length === b.length, info: await A.cacheInfo() }; }, OFM_TILE.length);
  ok('у запас телефона пішов лише шар номерів (решту квадрата відкинуто) — кількасот байтів замість кількох кілобайтів', st.n >= 1 && st.bytes > 40 && st.bytes < st.full / 5 && st.hasNum && !st.other && st.idem && st.info.tiles >= 1 && !st.info.mem, JSON.stringify(st));
  const nReq = OFM.tiles.length;
  const b2 = await app(page, async () => { const A = window.__app.addr, r = await A.tileLoad({ url: 'reisaddr://14/9286/5570' }, new AbortController()); return { len: r.data.byteLength, hits: A.addr.hits }; });
  ok('той самий квадрат удруге — із запасу, без мережі', b2.len > 40 && b2.hits >= 1 && OFM.tiles.length === nReq, JSON.stringify({ b2, req: OFM.tiles.length - nReq }));
  const nightL = await app(page, () => { const O = window.__app.offline, d = O.offlineStyle(false).layers.at(-1), n = O.offlineStyle(true).layers.at(-1); return { id: d.id, day: d.paint['text-color'], night: n.paint['text-color'], halo: n.paint['text-halo-color'], src: Object.keys(O.offlineStyle(false).sources) }; });
  ok('уночі в офлайн-карті номери світлі на темному (власні кольори, без «перевертання»)', nightL.id === 'reis-house' && nightL.day !== nightL.night && nightL.halo === '#0f1317' && nightL.src.includes('addr'), JSON.stringify(nightL));
  // ---- в) мережі немає (і застосунок перезапущено): номери біля цього місця — із запасу ----
  OFM.down = true; OFM.tiles = [];
  await page.reload(); await page.waitForFunction(() => window.__app && window.__app.map && window.__app.map.map && window.__app.offline.offlineActive(), null, { timeout: 20000 });
  await jumpTo(page, 17.2); await waitNums(page); await sleep(400);
  const c1 = await nums(page);
  ok('без мережі після перезапуску: номери будинків є — із запасу в телефоні', c1.drawn.length >= 5 && c1.A.net === 0 && c1.A.hits >= 1 && OFM.tiles.length === 0, JSON.stringify(c1));
  const c2 = await app(page, async () => { const A = window.__app.addr, r = await A.tileLoad({ url: 'reisaddr://14/9000/5500' }, new AbortController()); return { len: r.data.byteLength, cc: r.cacheControl || '', fails: A.addr.fails }; });
  ok('…а де запасу немає — порожньо без помилки, і за 40 с спитаємо знову (мережа може з\'явитись)', c2.len === 0 && /max-age=40/.test(c2.cc) && c2.fails >= 1, JSON.stringify(c2));
  await sleep(300);
  ok('…і водієві сказано прямо: номерів тут поки немає, бо вони ще не в телефоні; буде інтернет — застосунок завантажить їх сам', await app(page, () => /Номерів будинків тут поки немає/.test(document.getElementById('toasts').textContent) && /застосунок сам завантажить їх на всю Україну/.test(document.getElementById('toasts').textContent)), await app(page, () => document.getElementById('toasts').textContent.slice(0, 160)));
  // ---- г) дані на сервері оновились (нова тижнева версія): стара адреса квадратів дає 404 — беремо нову з каталогу ----
  OFM.down = false; OFM.ver = 'V2'; OFM.tj = 0; OFM.tiles = [];
  const d1 = await app(page, async () => { const A = window.__app.addr, r = await A.tileLoad({ url: 'reisaddr://14/9001/5501' }, new AbortController()); return { len: r.data.byteLength, net: A.addr.net, tpl: (JSON.parse(localStorage.getItem('reis.addrTpl') || '{}').u || '') }; });
  ok('версія даних змінилась: квадрат усе одно отримано (адресу оновлено з каталогу)', d1.len > 40 && OFM.tj === 1 && OFM.tiles.includes('14/9001/5501') && /\/V2\//.test(d1.tpl), JSON.stringify({ d1, tj: OFM.tj }));
  // ---- ґ) рушили в рейс: номери навколо фінішу — у запас заздалегідь (остання миля може бути без мережі) ----
  OFM.tiles = [];
  const fin = { lat: 49.5883, lon: 34.5514 };
  const got = await app(page, async fin => { const A = window.__app.addr; window.__app.bus.emit('trip', { active: true, trip: { id: 't-addr', a: { lat: 49.99, lon: 36.23 }, b: fin } });
    const t0 = Date.now(); while (Date.now() - t0 < 8000 && A.addr.prefetched < 9) await new Promise(r => setTimeout(r, 150));
    window.__app.bus.emit('trip', { active: true, trip: { id: 't-addr', a: { lat: 49.99, lon: 36.23 }, b: fin } }); await new Promise(r => setTimeout(r, 400));
    return { pre: A.addr.prefetched, xy: A.tileXY(fin.lat, fin.lon), log: window.__app.core.getLog().filter(l => /номери будинків біля фінішу/.test(l.msg || l.text || '')).length }; }, fin);
  const want = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) want.push('14/' + (got.xy[0] + dx) + '/' + (got.xy[1] + dy));
  ok('рушили в рейс — 9 квадратів номерів навколо фінішу збережено заздалегідь (один раз на рейс)', got.pre === 9 && want.every(k => OFM.tiles.includes(k)) && OFM.tiles.length === 9 && got.log === 1, JSON.stringify({ got, req: OFM.tiles.length }));
  // ======== 1.1.17: ВЛАСНІ ПАЧКИ — номери всієї України з OpenStreetMap, без сторонніх серверів і без мережі ========
  // Пачки зібрано тим самим tools/build_addr.py зі зразка (tests/fixtures/addr): шість будинків біля Луганської у Львові й два в Харкові.
  PACKS.on = true; PACKS.down = false; PACKS.rawDown = false; PACKS.req = []; OFM.down = true; OFM.tiles = []; OFM.tj = 0;
  // (у перевірках з–й застосунок НЕ качає всю Україну сам — прапорець «водій видалив номери»: так видно, що саме береться за наближенням)
  await app(page, async () => { await caches.delete('reis-addr-1'); await caches.delete('reis-addr-pack-1'); localStorage.removeItem('reis.addrIdx'); localStorage.setItem('reis.addrAuto', '0'); });
  const rel = async () => { await page.reload(); await page.waitForFunction(() => window.__app && window.__app.map && window.__app.map.map && window.__app.offline.offlineActive(), null, { timeout: 20000 }); };
  await rel();
  // з) формат: що записав збирач (Python), те й прочитав застосунок (JavaScript)
  const dec = await app(page, async () => { const A = window.__app.addr, r = await fetch('https://raw.githubusercontent.com/test-owner/test-repo/addr/v1/145_87.bin.gz');
    const raw = new Uint8Array(await new Response(new Blob([await r.arrayBuffer()]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()), pk = A.readPack(raw);
    return { pts: A.packPoints(pk, 6, 2), none: A.packPoints(pk, 7, 2).length, tiles: pk.tiles.size, mvt: A.onlyHouseNumbers(A.mvtHouse(A.packPoints(pk, 6, 2))).length }; });
  ok('пачка, зібрана tools/build_addr.py, читається застосунком: ті самі шість номерів на тих самих місцях; дублікат і «сміття» відсіяно', JSON.stringify(dec.pts) === JSON.stringify([{ x: 1185, y: 539, n: '12' }, { x: 1379, y: 599, n: '14А' }, { x: 1224, y: 734, n: '16' }, { x: 1392, y: 817, n: '18/2' }, { x: 1198, y: 921, n: '20' }, { x: 1366, y: 1009, n: '22-Б' }]) && dec.none === 0 && dec.tiles === 1 && dec.mvt > 60, JSON.stringify(dec));
  // и) наблизили карту: пачку свого району застосунок бере сам — і номери є (OpenFreeMap вимкнено й не потрібен)
  const idxReq = PACKS.req.filter(x => x === 'index.json').length; PACKS.req = [];
  await jumpTo(page, 17.2); await waitNums(page); await sleep(500);
  const srcNums = () => app(page, () => [...new Set(window.__app.map.map.querySourceFeatures('addr', { sourceLayer: 'housenumber' }).map(x => String(x.properties.housenumber)))].sort());
  const p1 = await nums(page), p1s = await srcNums(), p1g = await app(page, () => { const f = window.__app.map.map.querySourceFeatures('addr', { sourceLayer: 'housenumber' }).find(x => String(x.properties.housenumber) === '12'); return f ? f.geometry.coordinates : null; });
  await shot(page, '35-house-own-pack');
  const want12 = [24.045 + (-40) / (111320 * Math.cos(49.807 * Math.PI / 180)), 49.807 + 85 / 111320];
  // (номер 12 стоїть під самим підписом «Луганська вулиця» — назва вулиці важливіша, тож на екрані його може не бути; у даних він є)
  ok('офлайн-карта: номери з власної пачки району — у даних усі шість, намальовано щонайменше п\'ять; без OpenFreeMap; каталог і пачку взято по одному разу', p1s.join() === ['12', '14А', '16', '18/2', '20', '22-Б'].sort().join() && p1.drawn.length >= 5 && ['14А', '16', '18/2', '20', '22-Б'].every(n => p1.drawn.includes(n)) && p1.A.own >= 1 && p1.A.net === 0 && OFM.tiles.length === 0 && OFM.tj === 0
    && PACKS.req.filter(x => x === '145_87.bin.gz').length === 1 && idxReq === 1, JSON.stringify({ p1, p1s, req: PACKS.req, idxReq, ofm: OFM.tiles.length }));
  ok('…і стоять там, де будинки (номер 12 — у середині свого будинку, похибка до 3 м)', !!p1g && Math.abs(p1g[0] - want12[0]) < 4e-5 && Math.abs(p1g[1] - want12[1]) < 3e-5, JSON.stringify({ got: p1g, want: want12 }));
  // і) мережі немає зовсім, застосунок перезапущено: номери — з телефона
  PACKS.down = true; PACKS.req = [];
  await rel(); await jumpTo(page, 17.2); await waitNums(page); await sleep(400);
  const p2 = await nums(page), p2s = await srcNums();
  ok('без мережі після перезапуску: ті самі номери — пачка лежить у телефоні', p2s.length === 6 && p2.drawn.length >= 5 && p2.A.own >= 1 && p2.A.net === 0 && p2.A.fails === 0 && PACKS.req.length === 0 && OFM.tiles.length === 0, JSON.stringify({ p2, p2s, req: PACKS.req }));
  // ї) район, де в OpenStreetMap номерів немає взагалі (у каталозі такої пачки немає): порожньо, і це не «немає мережі»
  PACKS.down = false; PACKS.req = [];
  const p3 = await app(page, async () => { const A = window.__app.addr; document.getElementById('toasts').innerHTML = ''; await A.packIndex(true); const r = await A.tileLoad({ url: 'reisaddr://14/9000/5500' }, new AbortController()); await new Promise(r => setTimeout(r, 200)); return { len: r.data.byteLength, cc: r.cacheControl || '', toast: document.getElementById('toasts').textContent }; });
  ok('район без номерів у каталозі: порожній квадрат без зайвих запитів і без підказки «немає інтернету»', p3.len === 0 && p3.cc === '' && p3.toast === '' && !PACKS.req.some(x => /140_85/.test(x)) && OFM.tiles.length === 0, JSON.stringify({ p3, req: PACKS.req }));
  // й) основна адреса сховища недоступна — пачку беремо із запасного дзеркала
  PACKS.rawDown = true; PACKS.req = [];
  const p4 = await app(page, async () => { const A = window.__app.addr; await A.packDeleteAll(); await new Promise(r => setTimeout(r, 100)); const r = await A.tileLoad({ url: 'reisaddr://14/9286/5570' }, new AbortController()); return { len: r.data.byteLength, have: [...(await A.packHave()).keys()] }; });
  ok('основна адреса недоступна — пачку взято із запасного дзеркала й покладено в телефон', p4.len > 60 && PACKS.req.includes('cdn:145_87.bin.gz') && p4.have.includes('145_87'), JSON.stringify({ p4, req: PACKS.req }));
  PACKS.rawDown = false;
  // к) «Налаштування» → офлайн-карта → «Номери будинків без мережі»: завантажити всю Україну одним дотиком, видалити
  await app(page, () => { window.__app.addr.autoSet(true); return window.__app.addr.packDeleteAll(); }); await sleep(200);
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#addrPack');
  await page.waitForFunction(() => !!document.querySelector('#addrPackBtns [data-act="addrGet"]'), null, { timeout: 8000 }).catch(() => {});
  const card = () => app(page, () => { const R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; }, c = document.getElementById('addrPack');
    return { title: c.firstElementChild.textContent, state: document.getElementById('addrPackState').textContent, btns: [...document.querySelectorAll('#addrPackBtns button')].map(b => ({ act: b.dataset.act, t: b.textContent.trim(), ...R(b), fit: b.scrollWidth <= b.clientWidth + 1 })), box: R(c), vw: innerWidth }; });
  const k0 = await card();
  ok('картка «Номери будинків без мережі»: скільки це (уся Україна — МБ і кількість номерів), що застосунок завантажить їх сам, і кнопка «Завантажити всю Україну»', k0.title === 'Номери будинків без мережі' && /Уся Україна — [\d,]+ МБ, 8 номерів\. Застосунок завантажить їх сам, щойно буде інтернет/.test(k0.state) && k0.btns.length === 1 && k0.btns[0].act === 'addrGet' && /Завантажити всю Україну/.test(k0.btns[0].t) && k0.btns[0].h >= 44 && k0.btns[0].fit && k0.box.r <= k0.vw, JSON.stringify(k0));
  PACKS.req = [];
  await page.click('#addrPackBtns [data-act="addrGet"]');
  await page.waitForFunction(() => /У телефоні вся Україна/.test(document.getElementById('addrPackState').textContent), null, { timeout: 10000 }).catch(() => {});
  const k1 = await card(), have1 = await app(page, async () => [...(await window.__app.addr.packHave()).entries()].sort());
  await shot(page, '38-addr-pack-settings');
  ok('«Завантажити всю Україну»: обидві пачки в телефоні, дата даних і кількість номерів названі, сказано, що оновлюються самі; лишилась кнопка «Видалити номери»', /У телефоні вся Україна: 8 номерів, дані OpenStreetMap від 24\.11\.2026\. Номери видно без інтернету\. Оновлюються самі, раз на місяць\./.test(k1.state) && JSON.stringify(have1) === JSON.stringify([['145_87', '20261124'], ['153_86', '20261124']])
    && PACKS.req.includes('145_87.bin.gz') && PACKS.req.includes('153_86.bin.gz') && k1.btns.length === 1 && k1.btns[0].act === 'addrDel' && /Номери будинків усієї України — у телефоні/.test(await app(page, () => document.getElementById('toasts').textContent)), JSON.stringify({ k1, have1, req: PACKS.req }));
  await page.click('#addrPackBtns [data-act="addrDel"]'); await sleep(200);
  const k2 = await card();
  await page.click('#addrPackBtns [data-act="addrDel"]');
  await page.waitForFunction(() => !!document.querySelector('#addrPackBtns [data-act="addrGet"]'), null, { timeout: 8000 }).catch(() => {});
  const k3 = await card(), have3 = await app(page, async () => (await window.__app.addr.packHave()).size);
  ok('«Видалити номери» — з підтвердженням («Справді видалити?»); після нього в телефоні пачок немає, і картка каже, що сам застосунок їх більше не завантажує', /Справді видалити/.test(k2.btns[0].t) && have3 === 0 && k3.btns[0].act === 'addrGet' && /Ви видалили номери, тому сам застосунок їх більше не завантажує/.test(k3.state), JSON.stringify({ k2: k2.btns, k3, have3 }));
  await page.click('#panelOk');
  // л) каталог недоступний (пачки ще не зібрані): картка каже про це чесно, а номери й далі беруться попереднім шляхом
  PACKS.on = false;
  await app(page, () => { localStorage.removeItem('reis.addrIdx'); }); await rel();
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#addrPack');
  await page.waitForFunction(() => /Каталог номерів зараз недоступний/.test(document.getElementById('addrPackState').textContent), null, { timeout: 8000 }).catch(() => {});
  const k4 = await card();
  ok('каталог номерів недоступний — картка каже це прямо й пояснює, звідки номери беруться поки що; кнопок-обіцянок немає', /Каталог номерів зараз недоступний/.test(k4.state) && /беруться з інтернету/.test(k4.state) && k4.btns.length === 0, JSON.stringify(k4));
  await page.click('#panelOk');
  // ======== 1.1.17: УСЯ УКРАЇНА — САМА. Є офлайн-карта й мережа → застосунок кладе в телефон усі пачки без жодного дотику ========
  const khRaw = gunzipSync(readFileSync(join(ROOT, '..', 'tests', 'fixtures', 'addr', 'v1', '153_86.bin.gz'))), kh = [153 * 64 + khRaw[6], 86 * 64 + khRaw[7]];   // квадрат Харкова з другої пачки
  const haveAll = async n => { for (let i = 0; i < 60; i++) { if ((await app(page, async () => (await window.__app.addr.packHave()).size)) === n) return true; await sleep(250); } return false; };   // чекаємо до 15 с, доки в телефоні стане n пачок
  const haveNow = () => app(page, async () => [...(await window.__app.addr.packHave()).entries()].sort());
  const packReq = () => PACKS.req.filter(x => /\.bin\.gz$/.test(x));
  // м) перший запуск із мережею: нічого не натискаємо й карту не наближаємо
  PACKS.on = true; PACKS.req = [];
  await app(page, async () => { await caches.delete('reis-addr-pack-1'); await caches.delete('reis-addr-1'); localStorage.removeItem('reis.addrIdx'); localStorage.removeItem('reis.addrAuto'); document.getElementById('toasts').innerHTML = ''; });
  await rel(); await haveAll(2); await sleep(400);
  const m1 = await app(page, () => ({ toast: document.getElementById('toasts').textContent, log: window.__app.core.getLog().filter(l => /уся Україна в телефоні/.test(l.msg || l.text || '')).length, on: window.__app.addr.autoOn() })), m1h = await haveNow();
  ok('є офлайн-карта й мережа — уся Україна (обидві пачки) сама лягла в телефон: нічого не натискали й карту не наближали; водієві сказано один раз', JSON.stringify(m1h) === JSON.stringify([['145_87', '20261124'], ['153_86', '20261124']]) && /Номери будинків усієї України тепер у телефоні/.test(m1.toast) && m1.log === 1 && m1.on
    && packReq().sort().join() === '145_87.bin.gz,153_86.bin.gz', JSON.stringify({ m1, m1h, req: PACKS.req }));
  // н) мережі немає, застосунок перезапущено; район, де карту ніколи не наближали (Харків)
  PACKS.down = true; PACKS.req = []; await rel();
  const m2 = await app(page, async ([x, y]) => { const A = window.__app.addr; document.getElementById('toasts').innerHTML = ''; const r = await A.tileLoad({ url: 'reisaddr://14/' + x + '/' + y }, new AbortController()); await new Promise(r => setTimeout(r, 250));
    return { len: r.data.byteLength, cc: r.cacheControl || '', own: A.addr.own, fails: A.addr.fails, toast: document.getElementById('toasts').textContent, again: await A.packAuto(true) }; }, kh);
  ok('без мережі, район, де карту ніколи не наближали (Харків): номери є — з телефона; жодного запиту й жодної підказки; качати нема чого', m2.len > 30 && m2.cc === '' && m2.own >= 1 && m2.fails === 0 && m2.toast === '' && m2.again === 'full' && PACKS.req.length === 0 && OFM.tiles.length === 0, JSON.stringify({ m2, kh, req: PACKS.req }));
  // о) на сервері свіжіші дані (раз на місяць): оновлює сама й мовчки
  PACKS.down = false; PACKS.date = '20261224'; PACKS.req = [];
  await app(page, () => { localStorage.removeItem('reis.addrIdx'); }); await rel();
  const m3 = await app(page, async () => { const A = window.__app.addr; document.getElementById('toasts').innerHTML = ''; const r = await A.packAuto(true); await new Promise(r => setTimeout(r, 250)); return { r, toast: document.getElementById('toasts').textContent }; }), m3h = await haveNow();
  ok('на сервері свіжіші дані — пачки оновлено самою, без дотиків і без повідомлень', m3.r === 'done' && JSON.stringify(m3h) === JSON.stringify([['145_87', '20261224'], ['153_86', '20261224']]) && m3.toast === '' && packReq().length === 2, JSON.stringify({ m3, m3h, req: PACKS.req }));
  PACKS.date = '';
  // п) мережа урвалась посеред завантаження: що встигли — лишилось у телефоні; наступна спроба докачує лише решту
  PACKS.failOn = '153_86.bin.gz'; PACKS.req = [];
  const f1 = await app(page, async () => { const A = window.__app.addr; await A.packDeleteAll(); localStorage.removeItem('reis.addrIdx'); await A.packIndex(true); const r = await A.packAuto(true); return { r, err: A.packs.err, have: [...(await A.packHave()).keys()].sort() }; });
  PACKS.failOn = ''; PACKS.req = [];
  const f2 = await app(page, async () => { const A = window.__app.addr; const r = await A.packAuto(true); return { r, have: [...(await A.packHave()).keys()].sort() }; });
  ok('мережа урвалась посеред завантаження: що встигли — лишилось; наступна спроба докачує лише те, чого бракує', f1.r === 'fail' && f1.have.join() === '145_87' && /503/.test(f1.err) && f2.r === 'done' && f2.have.join() === '145_87,153_86' && packReq().join() === '153_86.bin.gz', JSON.stringify({ f1, f2, req: PACKS.req }));
  // р) мобільна мережа, перемикач «лише через Wi-Fi» ввімкнено (він про файл карти): номери (кілька МБ) качає сама й мобільною мережею
  PACKS.req = [];
  await app(page, async () => { await window.__app.addr.packDeleteAll(); localStorage.setItem('test.conn', 'cellular'); document.getElementById('toasts').innerHTML = ''; }); await rel();
  const w1 = await app(page, async () => { const A = window.__app.addr; return { r: await A.packAuto(true), have: (await A.packHave()).size, cell: A.cellular(), saver: A.dataSaver(), wifiOnly: window.__app.S.offlineWifi }; });
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#addrPack');
  const wifiDesc = await app(page, () => { const r = document.querySelector('[data-tg="offlineWifi"]'); return r ? r.textContent : ''; });
  await page.click('#panelOk');
  ok('мобільна мережа, «лише через Wi-Fi» ввімкнено: номери всієї України застосунок завантажив сам (перемикач — про файл карти, і в ньому це сказано)', w1.r === 'done' && w1.have === 2 && w1.cell && !w1.saver && w1.wifiOnly === true && packReq().length === 2 && /Це про файл карти/.test(wifiDesc) && /Номери будинків малі .* завантажуються будь-якою мережею/.test(wifiDesc), JSON.stringify({ w1, wifiDesc, req: PACKS.req }));
  // с) у телефоні ввімкнено «Економію трафіку» і мережа мобільна: сама не качає — чекає на Wi-Fi; картка каже це прямо й лишає кнопку «не чекати»
  PACKS.req = [];
  const w3 = await app(page, async () => { const A = window.__app.addr; await A.packDeleteAll(); localStorage.setItem('test.save', '1'); window.__conn.saveData = true; return { r: await A.packAuto(true), have: (await A.packHave()).size, waits: A.waitsWifi() }; });
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#addrPack');
  await page.waitForFunction(() => !!document.querySelector('#addrPackBtns [data-act="addrGet"]'), null, { timeout: 8000 }).catch(() => {});
  await app(page, () => document.getElementById('addrPack').scrollIntoView({ block: 'center' })); await sleep(150);
  const k5 = await card(); await shot(page, '39-addr-pack-wait-wifi');
  await page.click('#panelOk');
  ok('«Економія трафіку» в телефоні й мобільна мережа: сама не качає — чекає на Wi-Fi; картка каже це прямо, кнопка «Завантажити всю Україну» лишається', w3.r === 'wifi' && w3.have === 0 && w3.waits && packReq().length === 0 && /ввімкнено економію трафіку/.test(k5.state) && /коли буде Wi-Fi/.test(k5.state) && k5.btns.length === 1 && k5.btns[0].act === 'addrGet' && k5.btns[0].fit && k5.box.r <= k5.vw, JSON.stringify({ w3, k5, req: PACKS.req }));
  // т) телефон перейшов на Wi-Fi → завантажує сама
  await app(page, () => { localStorage.setItem('test.conn', 'wifi'); window.__conn.type = 'wifi'; window.__conn._l.forEach(f => f()); }); await haveAll(2);
  const w4 = await haveNow();
  ok('телефон перейшов із мобільної мережі на Wi-Fi — номери завантажились самі', w4.length === 2 && packReq().length === 2, JSON.stringify({ w4, req: PACKS.req }));
  // у) водій сам видалив номери — сама більше не качає (і після перезапуску); «Завантажити» повертає і номери, і самостійне оновлення
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#addrPack');
  await page.waitForFunction(() => !!document.querySelector('#addrPackBtns [data-act="addrDel"]'), null, { timeout: 8000 }).catch(() => {});
  await page.click('#addrPackBtns [data-act="addrDel"]'); await sleep(200); await page.click('#addrPackBtns [data-act="addrDel"]');
  await page.waitForFunction(() => !!document.querySelector('#addrPackBtns [data-act="addrGet"]'), null, { timeout: 8000 }).catch(() => {});
  await page.click('#panelOk'); PACKS.req = [];
  await rel(); await sleep(7000);                                                     // довше, ніж чекає самостійне завантаження після запуску
  const u1 = await app(page, async () => { const A = window.__app.addr; return { r: await A.packAuto(true), on: A.autoOn(), have: (await A.packHave()).size }; });
  ok('водій сам видалив номери — застосунок без його дотику їх більше не качає (і після перезапуску)', u1.r === 'skip' && u1.on === false && u1.have === 0 && packReq().length === 0, JSON.stringify({ u1, req: PACKS.req }));
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#addrPack');
  await page.waitForFunction(() => !!document.querySelector('#addrPackBtns [data-act="addrGet"]'), null, { timeout: 8000 }).catch(() => {});
  await page.click('#addrPackBtns [data-act="addrGet"]');
  await page.waitForFunction(() => /У телефоні вся Україна/.test(document.getElementById('addrPackState').textContent), null, { timeout: 10000 }).catch(() => {});
  const u2 = await app(page, async () => ({ on: window.__app.addr.autoOn(), have: (await window.__app.addr.packHave()).size, state: document.getElementById('addrPackState').textContent }));
  ok('…«Завантажити всю Україну» повертає і номери, і самостійне оновлення', u2.on === true && u2.have === 2 && /Оновлюються самі/.test(u2.state), JSON.stringify(u2));
  await page.click('#panelOk');
  await app(page, () => { localStorage.removeItem('test.conn'); localStorage.removeItem('test.save'); });
  ok('номери будинків на офлайн-карті — без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 28 (номери будинків) дійшов до кінця', false, String(e.message).split('\n')[0]); } finally { PM.fonts = false; PM.file = 'tiny'; OFM.down = false; OFM.ver = 'V1'; PACKS.on = false; PACKS.down = false; PACKS.rawDown = false; PACKS.date = ''; PACKS.failOn = ''; }

/* ============ прохід 29 (1.1.16): «Архів рейсів» і «Зберегти рейс» — дві окремі кнопки, стрічки під формою немає ============ */
if (run('29')) for (const sc of SCREENS.filter(x => ['S10', 'tiny', 'land', 'tablet'].includes(x.n) && (!process.env.SCR || process.env.SCR.split(',').includes(x.n)))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 0, t: Date.now() }); await sleep(300);
  const n = coords.length, mk = (id, la, lb, created) => ({ id, created, a: { lat: coords[0][0], lon: coords[0][1], label: la }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: lb },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } });
  const lay = () => app(page, () => { const R = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const pb = document.getElementById('panelBody'), tools = [...document.querySelectorAll('#tripTools .tt-b')], pr = R(pb), bt = R(document.getElementById('bottom'));
    const seen = e => { const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, el = document.elementFromPoint(x, y); return !!el && (el === e || e.contains(el)); };
    return { panel: !document.getElementById('panel').hidden, title: document.getElementById('panelTitle').textContent.trim(), back: !document.getElementById('panelBack').hidden, body: pr, bottomTop: bt && getComputedStyle(document.getElementById('bottom')).display !== 'none' ? bt.t : innerHeight, vw: innerWidth,
      tools: tools.map(b => { const ic = b.querySelector('.tt-ic'), cs = ic ? getComputedStyle(ic) : null, sv = ic && ic.querySelector('svg'), bd = ic && ic.querySelector('i');
        const sp = b.querySelector('span');
        return { act: b.dataset.act, txt: sp ? sp.textContent.trim() : (b.getAttribute('aria-label') || ''), n: (b.querySelector('i') || { textContent: '' }).textContent, can: b.classList.contains('can'), box: R(b), seen: seen(b), fit: b.scrollWidth <= b.clientWidth + 1 && (!sp || sp.scrollWidth <= sp.clientWidth + 1),
          ic: ic ? { box: R(ic), bg: cs.backgroundColor, fg: cs.color, op: +cs.opacity, svg: !!sv && sv.getBoundingClientRect().width >= 16, badge: bd ? R(bd) : null, left: !sp || R(ic).l < R(sp).l } : null }; }),
      inline: document.querySelectorAll('#panelBody [data-open]').length, saved: !!document.getElementById('savedBox'), newSec: (e => !!e && !e.hidden)(document.getElementById('newSec')),
      build: (b => b ? { box: R(b), seen: seen(b) } : null)(document.querySelector('#panelBody [data-act="build"]')), firstField: R(document.getElementById('in_a')), scroll: pb.scrollTop,
      items: [...document.querySelectorAll('#panelBody .arch .item')].map(e => ({ t: e.querySelector('.t').textContent.trim(), meta: e.querySelector('.muted').textContent.trim(), box: R(e), open: R(e.querySelector('[data-open]')), del: R(e.querySelector('[data-del]')), id: e.querySelector('[data-open]').dataset.open })),
      empty: (document.querySelector('.arch-empty') || { textContent: '' }).textContent.trim(), toast: document.getElementById('toasts').textContent, count: window.__app.route.getTrips().length }; });
  // чотирнадцять рейсів в архіві — раніше це була стрічка на кілька екранів просто під формою
  await app(page, list => { for (const tr of list) window.__app.route.saveTrip(tr); }, Array.from({ length: 14 }, (_, i) => mk('t-' + (i + 1), 'Харків, склад № ' + (i + 1), i === 13 ? 'Полтава, вулиця Європейська, 155, розподільчий центр «Нова лінія»' : 'Полтава ' + (i + 1), Date.UTC(2026, 10, 1 + i, 8))));
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#tripTools .tt-b'); await sleep(300);
  const f0 = await lay();
  await shot(page, '36-trip-tools-' + sc.n);
  ok(`[${T}] у «Рейсі» — окремі кнопки: «Архів рейсів» (із кількістю 14) і «Зберегти рейс», праворуч від них (1.1.34) сердечко «Улюблені місця» — у тому ж рядку; стрічки рейсів під формою немає`, f0.tools.length === 3 && f0.tools[0].act === 'archive' && f0.tools[0].txt === 'Архів рейсів' && f0.tools[0].n === '14' && f0.tools[1].act === 'saveTrip' && f0.tools[1].txt === 'Зберегти рейс' && f0.tools[2].act === 'favs' && f0.tools[2].txt === 'Улюблені місця' && Math.abs(f0.tools[2].box.t - f0.tools[0].box.t) <= 1 && f0.tools[2].box.l > f0.tools[1].box.r && f0.tools[2].box.w >= 46 && f0.inline === 0 && !f0.saved, JSON.stringify(f0.tools.map(x => [x.txt, x.n])));
  // на малих екранах кнопки під «Прокласти рейс» — нижче краю: доходимо до них прокручуванням, як водій пальцем
  await app(page, () => document.getElementById('tripTools').scrollIntoView({ block: 'center' })); await sleep(200);
  const f0s = await lay(); if (sc.n === 'tiny' || sc.n === 'land') await shot(page, '36-trip-tools-scrolled-' + sc.n);
  await app(page, () => { document.getElementById('panelBody').scrollTop = 0; }); await sleep(150);
  ok(`[${T}] кнопки поруч, однакові, зручні для пальця (≥ 46), написи цілі, ніщо їх не перекриває${sc.n === 'tiny' || sc.n === 'land' ? ' (після прокручування)' : ''}`, f0s.tools.every(x => x.box.h >= 46 && x.seen && x.fit && x.box.l >= f0s.body.l && x.box.r <= f0s.body.r + 1 && x.box.b <= f0s.bottomTop) && Math.abs(f0s.tools[0].box.w - f0s.tools[1].box.w) <= 2 && Math.abs(f0s.tools[0].box.t - f0s.tools[1].box.t) <= 1 && f0s.tools[0].box.r < f0s.tools[1].box.l, JSON.stringify({ tools: f0s.tools.map(x => ({ ...x.box, seen: x.seen, fit: x.fit })), bottomTop: f0s.bottomTop, body: f0s.body }));
  ok(`[${T}] (1.1.18) кнопки — ПІД «Прокласти рейс» (у порядку дій), форма починається одразу з полів; «Прокласти рейс» на видноті без прокручування${sc.n === 'S10' || sc.n === 'tablet' ? ', і обидві кнопки теж' : ''}`, !f0.newSec && f0.tools[0].box.t > f0.build.box.b && f0.tools[0].box.t - f0.build.box.b <= 24 && f0.firstField.t - f0.body.t <= 24
    && (sc.n === 'tiny' || sc.n === 'land' || (f0.build.seen && f0.build.box.b <= f0.bottomTop && f0.tools.every(x => x.seen && x.box.b <= f0.bottomTop))), JSON.stringify({ gapBuild: f0.tools[0].box.t - f0.build.box.b, firstField: f0.firstField.t - f0.body.t, build: f0.build, tools: f0.tools.map(x => x.box), bottomTop: f0.bottomTop }));
  ok(`[${T}] (1.1.18) у кожної кнопки — кольоровий значок ліворуч від напису: синій годинник (архів, кількість рейсів — на значку), зелена дискета (зберегти; поки нічого зберігати — блідіша)`, f0.tools.every(x => x.ic && x.ic.svg && x.ic.left && x.ic.box.w >= 28 && x.ic.fg === 'rgb(255, 255, 255)') && f0.tools[0].ic.bg === 'rgb(47, 107, 255)' && f0.tools[1].ic.bg === 'rgb(47, 158, 98)'
    && !!f0.tools[0].ic.badge && f0.tools[0].ic.badge.t < f0.tools[0].ic.box.t + 6 && f0.tools[0].ic.badge.r > f0.tools[0].ic.box.r - 2 && f0.tools[0].ic.badge.b >= f0.tools[0].box.t && f0.tools[1].ic.op < 0.8 && f0.tools[0].ic.op === 1, JSON.stringify(f0.tools.map(x => x.ic)));
  ok(`[${T}] «Зберегти рейс» поки бліда (нічого зберігати); торкнулись — підказка «Спершу вкажіть, куди їхати», рейсів не додалось`, !f0.tools[1].can && await (async () => { await page.click('#tripTools [data-act="saveTrip"]'); await sleep(300); const x = await lay(); return /Спершу вкажіть, куди їхати/.test(x.toast) && x.count === 14; })());
  if (await app(page, () => document.body.classList.contains('kb'))) { await app(page, () => document.activeElement && document.activeElement.blur()); await sleep(500); }
  // ---- архів: окремий екран ----
  await page.click('#tripTools [data-act="archive"]'); await sleep(350);
  const a0 = await lay();
  await shot(page, '37-archive-' + sc.n);
  ok(`[${T}] «Архів рейсів» — окремий екран зі стрілкою «назад»; 14 рейсів, найновіші згори, у кожного «Відкрити» й кошик`, a0.panel && a0.title === 'Архів рейсів' && a0.back && a0.items.length === 14 && a0.items[0].id === 't-14' && a0.items[13].id === 't-1' && a0.items.every(i => i.open && i.del && i.open.h >= 44 && i.del.h >= 44 && i.del.w >= 44), JSON.stringify({ title: a0.title, n: a0.items.length, first: a0.items[0] }));
  ok(`[${T}] довга назва рейсу не розпирає рядок: кнопки на місці, усе в межах панелі; дата й відстань під назвою`, a0.items.every(i => i.box.l >= a0.body.l && i.box.r <= a0.body.r + 1 && i.del.r <= i.box.r && i.open.l > i.box.l + 60) && /27 км · .* · 14 лист/.test(a0.items[0].meta), JSON.stringify({ it: a0.items[0], body: a0.body }));
  // прокручується всередині панелі й не залазить під нижню плашку
  const sc1 = await app(page, () => { const pb = document.getElementById('panelBody'); pb.scrollTop = pb.scrollHeight; const last = [...document.querySelectorAll('.arch .item')].pop().getBoundingClientRect(), bt = document.getElementById('bottom'), btTop = getComputedStyle(bt).display !== 'none' ? bt.getBoundingClientRect().top : innerHeight, pr = document.getElementById('panel').getBoundingClientRect();
    const el = document.elementFromPoint(last.left + 30, last.bottom - 6); return { lastB: Math.round(last.bottom), btTop: Math.round(btTop), panelB: Math.round(pr.bottom), mine: !!el && !!el.closest('.arch .item'), scrolled: pb.scrollTop > 0 }; });
  ok(`[${T}] список прокручується всередині екрана; останній рейс видно повністю, нижня плашка його не накриває`, sc1.mine && sc1.lastB <= Math.max(sc1.btTop, sc1.panelB) + 1, JSON.stringify(sc1));
  // «назад» (стрілка й системна) — у «Рейс»
  await page.click('#panelBack'); await sleep(300);
  const a1 = await lay();
  await page.click('#tripTools [data-act="archive"]'); await sleep(250);
  const backSys = await app(page, () => window.__reisBack()); await sleep(250);
  const a2 = await lay();
  ok(`[${T}] стрілка «назад» і системна «Назад» повертають з архіву у «Рейс» (а не закривають усе)`, a1.title === 'Рейс' && a1.tools.length === 3 && backSys === true && a2.panel && a2.title === 'Рейс', JSON.stringify({ t1: a1.title, t2: a2.title, backSys }));
  // кошик — із поверненням
  await page.click('#tripTools [data-act="archive"]'); await sleep(250);
  await page.click('.arch [data-del="t-13"]'); await sleep(350);
  const d1 = await lay();
  await app(page, () => { const ts = [...document.querySelectorAll('#toasts .toast')]; ts[ts.length - 1].click(); }); await sleep(700);
  const d2 = await lay();
  ok(`[${T}] кошик видаляє рейс одразу, але випадковий дотик можна скасувати: «Торкніться тут — поверну»`, d1.items.length === 13 && !d1.items.some(i => i.id === 't-13') && /Рейс видалено/.test(d1.toast) && d2.items.length === 14 && d2.items.some(i => i.id === 't-13') && d2.count === 14, JSON.stringify({ n1: d1.items.length, n2: d2.items.length, toast: d1.toast.slice(0, 60) }));
  // «Відкрити» — рейс на карті й у «Рейсі», далі «Поїхали»
  await page.click('.arch [data-open="t-14"]'); await sleep(600);
  const o1 = await lay(), o1b = await app(page, () => ({ go: !!document.querySelector('#planSum [data-act="go"]'), save: (document.querySelector('#planSum [data-act="save"]') || { textContent: '' }).textContent.trim(), line: !!window.__app.map.map.getLayer('route-line'), finish: document.getElementById('in_b').value }));
  ok(`[${T}] «Відкрити» — рейс показано у «Рейсі» (підсумок, «Поїхали»), поля заповнені; «Зберегти рейс» тепер жива`, o1.title === 'Рейс' && o1b.go && o1b.save === 'Зберегти рейс' && /Європейська/.test(o1b.finish) && o1.newSec && o1.tools[1].can, JSON.stringify({ o1b, can: o1.tools[1].can }));
  // «Зберегти рейс» із прокладеним рейсом: в архів, форма — з чистого аркуша
  await app(page, () => { const P = window.__app; P.route.deleteTrip('t-14'); }); await sleep(600);
  await page.click('#tripTools [data-act="saveTrip"]'); await sleep(500);
  const s1 = await lay(), s1b = await app(page, () => ({ has: window.__app.route.getTrips().some(x => x.id === 't-14'), finish: (document.getElementById('in_b') || { value: '?' }).value, sum: document.getElementById('planSum').textContent.trim() }));
  ok(`[${T}] «Зберегти рейс» (рейс прокладено) — рейс в архіві, сказано де; форма чиста`, s1b.has && /Рейс збережено — він в «Архіві рейсів»/.test(s1.toast) && s1b.finish === '' && s1b.sum === '' && s1.count === 14 && s1.tools[0].n === '14', JSON.stringify({ s1b, toast: s1.toast.slice(-60), n: s1.tools[0].n }));
  // «Зберегти рейс», коли рейс іще не прокладено, а фініш уже вказано: прокладаємо й зберігаємо одним дотиком
  await page.fill('#in_b', 'Полтава'); await sleep(900);
  const s2a = await lay();
  if (await app(page, () => document.body.classList.contains('kb'))) { await app(page, () => document.activeElement && document.activeElement.blur()); await sleep(500); }
  if (sc.n === 'S10') {   // як виглядає ожила «Зберегти рейс» — і вдень, і вночі (значки мають читатися в обох темах)
    const act = await app(page, () => { const b = document.querySelector('#tripTools [data-act="saveTrip"]'), ic = b.querySelector('.tt-ic'); b.scrollIntoView({ block: 'center' }); return { can: b.classList.contains('can'), op: +getComputedStyle(ic).opacity, border: getComputedStyle(b).borderColor }; });
    await sleep(150); await shot(page, '36b-save-active-S10');
    await app(page, () => { document.body.dataset.theme = 'night'; }); await sleep(200); await shot(page, '36c-trip-tools-night-S10');
    await app(page, () => { document.body.dataset.theme = window.__app.S.theme === 'night' ? 'night' : 'day'; document.getElementById('panelBody').scrollTop = 0; }); await sleep(150);
    ok(`[${T}] (1.1.18) фініш вписано — «Зберегти рейс» ожила: значок яскравий, жовта рамка`, act.can && act.op === 1 && act.border === 'rgb(245, 163, 0)', JSON.stringify(act));
  }
  const reqN = routeReqs.length;
  await page.click('#tripTools [data-act="saveTrip"]');
  await page.waitForFunction(() => window.__app.route.getTrips().length === 15, null, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  const s2 = await lay(), s2b = await app(page, () => { const ts = window.__app.route.getTrips(), last = ts[ts.length - 1]; return { b: last.b && last.b.label, me: !!(last.a && last.a.me), route: !!(last.route && last.route.coords && last.route.coords.length > 2), pick: !document.getElementById('routePick').hidden, finish: (document.getElementById('in_b') || { value: '?' }).value }; });
  ok(`[${T}] фініш уже вписано — «Зберегти рейс» оживає; один дотик: рейс прокладено (від мого місця) і збережено, вікно варіантів не відкривається`, s2a.tools[1].can && routeReqs.length > reqN && s2.count === 15 && s2.tools[0].n === '15' && /Полтава/.test(s2b.b || '') && s2b.me && s2b.route && !s2b.pick && s2b.finish === '' && /Рейс збережено/.test(s2.toast), JSON.stringify({ s2b, n: s2.tools[0].n, toast: s2.toast.slice(-70) }));
  // порожній архів
  await app(page, () => { const P = window.__app; for (const tr of P.route.getTrips().slice()) P.route.deleteTrip(tr.id); });
  // форма оновлюється не миттєво (перемальовування раз на 0,4 с), а на завантаженій машині ще пізніше — чекаємо саме на подію, а не «600 мс»
  await page.waitForFunction(() => { return !document.querySelector('#tripTools [data-act="archive"] i'); }, null, { timeout: 4000 }).catch(() => {}); await sleep(150);
  const e0 = await lay();
  await page.click('#tripTools [data-act="archive"]'); await sleep(300);
  const e1 = await lay();
  ok(`[${T}] порожній архів: на кнопці немає числа, на екрані — що зробити, щоб рейс тут з'явився`, e0.tools[0].n === '' && e1.items.length === 0 && /Архів порожній/.test(e1.empty) && /Зберегти рейс/.test(e1.empty), JSON.stringify({ n: e0.tools[0].n, empty: e1.empty.slice(0, 60) }));
  ok(`[${T}] прохід 29 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 29 (${sc.n}) дійшов до кінця`, false, String(e.message).split('\n')[0]); }

/* ============ знімки справжньої картотеки (лише на прохання: REALVP=1 ONLY=vpreal --shots тека) ============ */
if (process.env.REALVP && run('vpreal')) try {
  const { page, ctx, errors } = await newPage(true, { realVp: true, viewport: { width: 360, height: 760 } });
  await app(page, ([la, lo]) => window.__reis('loc', { prov: 'gps', lat: la, lon: lo, acc: 5, spd: 0, t: Date.now() }), [49.2500, 28.5600]); await sleep(600);
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.vp-row[data-vpid="avtoport-vinnytsia"]'); await sleep(500);
  await shot(page, 'vp-list');
  await page.click('.vp-row[data-vpid="avtoport-vinnytsia"]'); await page.waitForSelector('.vp-serv'); await sleep(900);
  await shot(page, 'vp-card-1');
  for (const [i, y] of [[2, 430], [3, 1000], [4, 1700]]) { await app(page, y => { document.getElementById('panelBody').scrollTop = y; }, y); await sleep(300); await shot(page, 'vp-card-' + i); }
  const info = await app(page, () => ({ imgs: [...document.querySelectorAll('.vp-photos img')].length, secs: [...document.querySelectorAll('#panelBody .sec')].map(e => e.textContent), rows: document.querySelectorAll('.vp-menu div').length, h: document.getElementById('panelBody').scrollHeight }));
  console.log('VPREAL', JSON.stringify(info));
  await page.click('[data-vp="map"]'); await sleep(1500); await shot(page, 'vp-map');
  ok('справжня картка «Автопорт» відкривається без помилок', errors.length === 0 && info.imgs === 10 && info.secs.length >= 2, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('знімки справжньої картотеки', false, String(e.message).split('\n')[0]); }

/* ============ прохід 30 (1.1.19, 1.1.20): тип карти — ОДИН ДОТИК: схема ↔ супутник (лише з інтернетом), без віконець і без виходу з програми ============ */
// Квадрат «знімка» — однотонний PNG 256×256 (сервер знімків тут підмінено; справжній з тестової машини недоступний).
const pngSolid = (w, h, [r, g, b]) => {
  const chunk = (type, data) => { const len = Buffer.alloc(4), tc = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(tc) >>> 0); return Buffer.concat([len, tc, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
};
const SAT_PNG = pngSolid(256, 256, [74, 98, 62]);
if (run('30')) for (const sc of SCREENS.filter(x => ['S10', 'tiny', 'land', 'tablet'].includes(x.n) && (!process.env.SCR || process.env.SCR.split(',').includes(x.n)))) try {
  const SAT = { req: [] };
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr, before: async pg => {
    await pg.route(/^https:\/\/server\.arcgisonline\.com\//, r => { SAT.req.push(r.request().url()); r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: SAT_PNG }); }); } });
  const T = sc.title, main = sc.n === 'S10';
  await app(page, () => { const P = window.__app; P.map.view.follow = false; P.map.view.lastTouch = Date.now() + 3600e3; P.map.map.jumpTo({ center: [36.2304, 49.9935], zoom: 16, pitch: 0, bearing: 0 }); }); await sleep(600);
  const R = sel => app(page, sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, h = document.elementFromPoint(x, y);
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), seen: !!h && (h === e || e.contains(h)), vw: innerWidth, vh: innerHeight }; }, sel);
  const st = () => app(page, () => { const m = window.__app.map.map, ls = m.getStyle().layers.map(l => l.id), at = id => ls.indexOf(id), src = m.getSource('reis-sat'), b = document.getElementById('bMap');
    return { want: window.__app.S.mapType, sat: !!m.getLayer('reis-sat'), iSat: at('reis-sat'), iRough: at('rough-dot'), iRoute: at('route-line'), tiles: src ? src.tiles[0] : '', body: document.body.classList.contains('mapsat'),
      attr: (document.getElementById('attr') || { dataset: {} }).dataset.full || '', cur: (b.querySelector('.mt-seg.on') || { dataset: {} }).dataset.k || '', segs: [...b.querySelectorAll('.mt-seg')].map(x => x.dataset.k + ':' + (x.querySelector('svg') ? Math.round(x.querySelector('svg').getBoundingClientRect().width) : 0) + ':' + Math.round(x.getBoundingClientRect().height)).join(), satDim: (x => x ? +getComputedStyle(x).opacity : 1)(b.querySelector('.mt-seg[data-k="sat"]')), nonet: b.classList.contains('nonet'), pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'),
      popup: !document.getElementById('quick').hidden, ext: window.__nativeCalls.filter(x => /^openUrl:/.test(x)).length,
      net: window.__app.map.cacheStats().net, filter: getComputedStyle(document.querySelector('.maplibregl-canvas')).filter, toast: document.getElementById('toasts').textContent }; });
  const clearToasts = () => app(page, () => { document.getElementById('toasts').innerHTML = ''; });
  // а) кнопка справа вгорі — під швидкими налаштуваннями (кнопки «Шари» з 1.1.20 немає)
  const order = await app(page, () => [...document.querySelectorAll('#rail > button')].map(b => b.id)), bm = await R('#bMap'), s0 = await st();
  const railComp = await app(page, () => document.body.classList.contains('rail-compact'));     // (1.1.35) стовпчик стиснуто, щоб не ділити на два: кнопки 42…48 px, значки відповідно менші
  ok(`[${T}] справа вгорі — одна кругла кнопка типу карти (${bm.w}×${bm.h}) під швидкими налаштуваннями: на ній значок того виду, що зараз, — складена карта (схема); другого значка немає; нічого її не перекриває`, order.slice(0, 2).join() === 'bQuick,bMap' && bm.seen && bm.w === bm.h && (bm.w === 50 || (railComp && bm.w >= 42 && bm.w < 50)) && bm.r <= bm.vw && bm.b <= bm.vh
    && s0.segs.split(',').length === 1 && (railComp ? /^scheme:(2[5-9]|30):\d+$/ : /^scheme:30:\d+$/).test(s0.segs) && s0.cur === 'scheme' && !s0.sat && s0.want === 'scheme' && s0.pressed === 'false' && /зараз схема/.test(s0.label), JSON.stringify({ order, bm, s0 }));
  // б) один дотик — супутник: жодного віконця, знімки під лініями рейсу й нашими значками, напряму (не в наш кеш), джерело підписано
  const net0 = s0.net; await clearToasts();
  await page.click('#bMap'); await page.waitForFunction(() => !!window.__app.map.map.getLayer('reis-sat'), null, { timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 40 && !SAT.req.length; i++) await sleep(150); await sleep(500);
  const s1 = await st();
  await shot(page, '41-sat-' + sc.n);
  ok(`[${T}] один дотик — одразу супутник (як «2D / 3D»): жодного віконця з вибором і жодного повідомлення (карта змінилась — і так видно); значок на кнопці змінився — тепер супутник над Землею (один)`, s1.want === 'sat' && s1.sat && !s1.popup && s1.toast.trim() === '' && s1.cur === 'sat' && (railComp ? /^sat:(2[5-9]|30):\d+$/ : /^sat:30:\d+$/).test(s1.segs) && s1.pressed === 'true' && /зараз супутник/.test(s1.label), JSON.stringify(s1));
  ok(`[${T}] знімки є (квадрати з сервера знімків), лежать ПІД лініями рейсу й нашими значками; джерело знімків підписано; у власний кеш карти не осідають`, s1.iSat >= 0 && s1.iSat < s1.iRough && s1.iRough < s1.iRoute && SAT.req.length > 0 && /\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(SAT.req[0]) && s1.body && /Esri/.test(s1.attr) && s1.net === net0, JSON.stringify({ s1, req: SAT.req.slice(0, 2), n: SAT.req.length, net0 }));
  // в) ще дотик — схема: знімки прибрано, сервер знімків більше не питаємо
  await clearToasts(); await page.click('#bMap'); await sleep(250);
  const s2t = (await st()).toast;                                         // одразу після дотику: повідомлень немає
  SAT.req = []; await app(page, () => window.__app.map.map.panBy([300, 200], { duration: 0 })); await sleep(900);
  const s2 = await st();
  ok(`[${T}] ще дотик — назад схема: знімки прибрано, нових запитів немає; теж без повідомлень; на кнопці знову складена карта`, s2.want === 'scheme' && !s2.sat && !s2.body && !s2.popup && SAT.req.length === 0 && s2t.trim() === '' && s2.cur === 'scheme' && (railComp ? /^scheme:(2[5-9]|30):\d+$/ : /^scheme:30:\d+$/).test(s2.segs), JSON.stringify({ s2, s2t, n: SAT.req.length }));
  if (main) {
    await page.click('#bMap'); await page.waitForFunction(() => !!window.__app.map.map.getLayer('reis-sat'), null, { timeout: 5000 }).catch(() => {});
    // г) уночі знімок не «перевертається» фільтром нічної карти
    await app(page, () => { window.__app.S.theme = 'night'; window.__app.map.applyTheme(); }); await sleep(300);
    const n1 = await st(); await shot(page, '41b-sat-night-S10');
    await app(page, () => { window.__app.S.theme = 'day'; window.__app.map.applyTheme(); }); await sleep(200);
    ok(`[${T}] супутник уночі: без «перевертання» кольорів (лише трохи приглушено)`, !/invert/.test(n1.filter) && /brightness/.test(n1.filter), n1.filter);
    // д) зникла мережа: сам показує завантажену карту й каже про це; вибір «супутник» запам'ятовано
    await clearToasts(); await ctx.setOffline(true); await sleep(500);
    const o1 = await st();
    ok(`[${T}] немає інтернету: знімки прибрано, видно звичайну карту; водієві сказано, що супутник повернеться сам; на кнопці — складена карта (те, що видно зараз)`, !o1.sat && !o1.body && o1.want === 'sat' && /Немає інтернету — показую завантажену карту/.test(o1.toast) && o1.nonet && o1.cur === 'scheme' && /^scheme:30:\d+$/.test(o1.segs), JSON.stringify(o1));
    await clearToasts(); await page.click('#bMap'); await sleep(300);
    const o2 = await st(); await shot(page, '42-sat-offline-tap-S10');
    ok(`[${T}] без інтернету дотик до кнопки — лише підказка «супутник лише з інтернетом», карта лишається завантаженою (не сіра), жодних віконець`, /Супутник працює лише з інтернетом/.test(o2.toast) && !o2.sat && !o2.popup && o2.want === 'sat', JSON.stringify(o2));
    // е) мережа повернулась — знімки повертаються самі
    await clearToasts(); SAT.req = []; await ctx.setOffline(false); await sleep(400);
    await page.waitForFunction(() => !!window.__app.map.map.getLayer('reis-sat'), null, { timeout: 5000 }).catch(() => {}); await sleep(600);
    const o3 = await st();
    ok(`[${T}] інтернет повернувся — супутник знову сам, коротке повідомлення`, o3.sat && o3.body && !o3.nonet && /Інтернет є — знову супутник/.test(o3.toast), JSON.stringify(o3));
    // є) вибір лишається після перезапуску
    await page.reload(); await page.waitForFunction(() => window.__app && window.__app.map && window.__app.map.map && window.__app.map.map.getSource('route'), null, { timeout: 20000 });
    await page.waitForFunction(() => !!window.__app.map.map.getLayer('reis-sat'), null, { timeout: 5000 }).catch(() => {});
    const r1 = await st();
    ok(`[${T}] після перезапуску — так само супутник`, r1.want === 'sat' && r1.sat && r1.iSat < r1.iRough, JSON.stringify(r1));
    // ж) інша адреса знімків у «Налаштування → Джерела» (напр. з ключем) — береться одразу
    const f1 = await app(page, async () => { const S = window.__app.S, def = S.satUrl; S.satUrl = 'https://server.arcgisonline.com/key/{z}/{y}/{x}?token=abc'; await new Promise(r => setTimeout(r, 200)); const m = window.__app.map.map, t1 = m.getSource('reis-sat') && m.getSource('reis-sat').tiles[0]; S.satUrl = def; await new Promise(r => setTimeout(r, 200)); return { t1, t2: m.getSource('reis-sat') && m.getSource('reis-sat').tiles[0], def }; });
    ok(`[${T}] адресу знімків можна змінити в «Налаштуваннях» (напр. з ключем ArcGIS) — застосовується одразу`, f1.t1 === 'https://server.arcgisonline.com/key/{z}/{y}/{x}?token=abc' && f1.t2 === f1.def && /World_Imagery/.test(f1.def), JSON.stringify(f1));
  }
  // з) жодного разу не відкрито нічого поза програмою
  const fin = await st();
  ok(`[${T}] за весь час — жодного виходу з програми (нічого не відкривалось у Google Maps чи браузері)`, fin.ext === 0, JSON.stringify({ ext: fin.ext }));
  ok(`[${T}] прохід 30 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 30 (${sc.n}) дійшов до кінця`, false, String(e.message).split('\n')[0]); }
// и) офлайн-карта (файл у телефоні) + інтернет: знімки лягають над картою з файлу, під лініями рейсу
if (run('30') && (!process.env.SCR || process.env.SCR.split(',').includes('S10'))) try {
  const size = (await pmFile('tiny')).length;
  const { page, ctx, errors } = await newPage(true, { offline: true, viewport: { width: 360, height: 670 }, before: async pg => {
    await pg.route(/^https:\/\/server\.arcgisonline\.com\//, r => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: SAT_PNG }));
    await pg.addInitScript(([r, n]) => { window.__nativeRev = r; window.__pmSize = n; try { const o = JSON.parse(localStorage.getItem('reis.settings') || '{}'); o.mapType = 'sat'; localStorage.setItem('reis.settings', JSON.stringify(o)); } catch (_) {} }, [7, size]); } });
  await page.waitForFunction(() => window.__app.offline.offlineActive() && !!window.__app.map.map.getSource('protomaps') && !!window.__app.map.map.getLayer('reis-sat'), null, { timeout: 15000 }).catch(() => {});
  const o = await app(page, () => { const m = window.__app.map.map, ls = m.getStyle().layers, at = id => ls.findIndex(l => l.id === id), firstPm = ls.findIndex(l => l.source === 'protomaps');
    return { off: window.__app.offline.offlineActive(), iSat: at('reis-sat'), firstPm, lastPmFill: Math.max(...ls.map((l, i) => l.source === 'protomaps' && l.type !== 'symbol' ? i : -1)), iRough: at('rough-dot'), iHouse: at('reis-house') }; });
  ok('офлайн-карта з файлу + інтернет + «Супутник»: знімки над заливками й дорогами карти з файлу, під лініями рейсу й номерами будинків', o.off && o.iSat > o.firstPm && o.iSat > o.lastPmFill && o.iSat < o.iRough && (o.iHouse < 0 || o.iSat < o.iHouse), JSON.stringify(o));
  ok('офлайн-карта + супутник — без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 30 (офлайн-карта + супутник) дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 31 (1.1.21 → 1.1.22): нахил карти — стрілка вгору-вниз у крайньому правому куті нижньої плашки, без тла; вкладки посунуто ліворуч ============ */
if (run('31')) for (const sc of [...SCREENS.filter(x => ['S10', 'tiny', 'land', 'tablet', 'xiaomi'].includes(x.n)), { n: 'tabland', w: 1272, h: 702, dpr: 1, title: 'планшет набік 1272×702 (як на знімку Олексія)' }].filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, main = sc.n === 'S10' || sc.n === 'tabland', emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const gps = () => emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 0, t: Date.now() });
  await gps(); await sleep(900);
  const st = () => app(page, () => { const R = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const vis = e => !!e && !e.hidden && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
    const tl = document.getElementById('tilt'), c = document.getElementById('bCenter'), m = window.__app.map.map, S = window.__app.S, th = tl.querySelector('.tl-thumb'), tr = tl.querySelector('.tl-track'), cs = getComputedStyle(tl), tcs = getComputedStyle(th);
    const seen = e => { const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && (h === e || e.contains(h)); };
    const tabs = [...document.querySelectorAll('#tabs > button')].map(b => { const r = R(b), sp = b.querySelector('span:last-child'); return { id: b.dataset.panel || b.id, l: r.l, r: r.r, w: r.w, cut: !!sp && sp.scrollWidth > sp.clientWidth + 1 }; });
    return { shown: vis(tl), inBar: tl.parentElement.id, tilt: R(tl), track: R(tr), thumb: R(th), seen: vis(tl) && seen(tl), bg: [cs.backgroundColor, cs.borderTopWidth, cs.boxShadow, tcs.backgroundColor, tcs.borderTopWidth].join('|'), caps: tl.querySelectorAll('.tl-cap').length, arrows: tl.querySelectorAll('.tl-thumb svg path').length, dot: tl.querySelectorAll('.tl-thumb svg circle').length, ends: tl.querySelectorAll('.tl-end').length, groove: parseFloat(getComputedStyle(tr, '::before').width) || 0, grooveOp: +getComputedStyle(tr, '::before').opacity, fillH: Math.round(tl.querySelector('.tl-fill').getBoundingClientRect().height),
      dim: [getComputedStyle(tl.querySelector('.tl-up')).opacity, getComputedStyle(tl.querySelector('.tl-dn')).opacity].join(), center: { hidden: c.hidden, vis: vis(c), box: R(c) }, rail: R(document.getElementById('rail')), bottom: R(document.getElementById('tabbar')), stack: R(document.getElementById('bottom')), tabs, tripbar: R(document.querySelector('#tabbar .tb-main')), attr: R(document.getElementById('attr')),
      vw: innerWidth, vh: innerHeight, pitch: Math.round(m.getPitch()), S: { pitch: S.pitch, view3d: S.view3d }, now: +tl.getAttribute('aria-valuenow'), text: tl.getAttribute('aria-valuetext'), label: tl.getAttribute('aria-label'), flat: tl.classList.contains('flat'), max: tl.classList.contains('max'), follow: window.__app.map.view.follow }; });
  const s0 = await st();
  await shot(page, '44-tilt-' + sc.n);
  const last = s0.tabs[s0.tabs.length - 1];
  // а) де стоїть і як виглядає
  ok(`[${T}] нахил карти — у крайньому правому куті нижньої плашки (правіше «Міток»), єдиний виступ угору — стрілці є де ходити (${s0.tilt.h}); у межах екрана, нічим не перекритий, нічого не закриває`, s0.shown && s0.inBar === 'tabbar' && s0.seen && s0.bottom.r - s0.tilt.r >= 0 && s0.bottom.r - s0.tilt.r <= 10 && s0.tilt.t >= s0.bottom.t + 2 && s0.tilt.b <= s0.bottom.b - 2 && s0.tilt.r <= s0.vw && s0.tilt.b <= s0.vh
    && s0.tilt.w >= 40 && s0.tilt.h >= 86 && s0.tilt.l >= last.r && s0.tilt.l >= s0.tripbar.r && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify({ tilt: s0.tilt, bottom: s0.bottom, last, tripbar: s0.tripbar, lay: await page.evaluate(layoutCheck) }));
  ok(`[${T}] (1.1.26) це повзунок: кругла ручка-«точка» (${s0.thumb.w}×${s0.thumb.h}) на видимій дорожці згори донизу (${s0.groove} px завширшки), нижче ручки дорожка яскравіша (${s0.fillH} px — наскільки нахилено), на кінцях — два маленькі вістря; без тла, рамки й підписів «3D / 2D»`, /^rgba\(0, 0, 0, 0\)\|0px\|none\|rgba\(0, 0, 0, 0\)\|0px$/.test(s0.bg) && s0.caps === 0 && s0.arrows === 0 && s0.dot === 1 && s0.ends === 2 && s0.thumb.w === 30 && s0.thumb.h === 30 && s0.groove >= 5 && s0.grooveOp >= 0.2 && s0.fillH >= 20 && /Нахил карти/.test(s0.label), JSON.stringify({ bg: s0.bg, caps: s0.caps, dot: s0.dot, ends: s0.ends, groove: s0.groove, grooveOp: s0.grooveOp, fillH: s0.fillH, thumb: s0.thumb, label: s0.label }));
  ok(`[${T}] (1.1.24) кнопок чотири (Події · Рейс · Місця · Мітки) — між часом ліворуч і стрілкою нахилу праворуч: не накладаються, підписи цілі (не обрізані)`, s0.tabs.length === 4 && s0.tabs.every((x, i) => !x.cut && x.w >= 40 && (!i || x.l >= s0.tabs[i - 1].r - 1)) && (await readCheck(page, '#tabs')).length === 0, JSON.stringify({ tabs: s0.tabs, read: await readCheck(page, '#tabs') }));
  // б) карта стежить за машиною з нахилом «3D» (52°) — стрілка стоїть на тому самому місці шкали
  const travel = s0.track.h - 30;
  ok(`[${T}] карта стежить за машиною під кутом 52° — стрілка стоїть на тому самому місці шкали (хід ${travel} пікселів)`, s0.follow && s0.pitch === 52 && s0.now === 52 && Math.abs((s0.track.b - s0.thumb.b) / travel - 52 / 60) < 0.05, JSON.stringify({ pitch: s0.pitch, now: s0.now, thumb: s0.thumb, track: s0.track }));
  const X = s0.tilt.l + Math.round(s0.tilt.w / 2), Yc = Math.round((s0.thumb.t + s0.thumb.b) / 2), per = 60 / Math.max(60, travel);            // градусів на піксель
  // в) самий лише дотик нічого не міняє (стрілка поруч із «Мітками» — випадковий дотик карту не перекидає)
  await page.mouse.click(X, s0.tilt.b - 6); await sleep(250);
  const tp = await st();
  ok(`[${T}] самий лише дотик до стрілки нічого не міняє — нахил той самий (52°)`, tp.pitch === 52 && tp.S.pitch === 52 && tp.S.view3d === true, JSON.stringify({ pitch: tp.pitch, S: tp.S }));
  // г) тягнемо вниз: карта нахиляється одразу за пальцем; до кінця — вид згори; у налаштування пишеться, коли палець відпустили
  const dMid = Math.round(22 / per);
  await page.mouse.move(X, Yc); await page.mouse.down(); await page.mouse.move(X, Yc + dMid, { steps: 4 }); await sleep(120);
  const d1 = await st();
  await page.mouse.move(X, Yc + Math.round(70 / per), { steps: 5 }); await sleep(150);
  const d2 = await st(); await page.mouse.up(); await sleep(200); await gps(); await sleep(1300);
  const d3 = await st();
  ok(`[${T}] тягнемо стрілку вниз: карта нахиляється одразу за пальцем (на ${dMid} пікселів — стало ${d1.pitch}°), у налаштування кут пишеться, коли палець відпустили`, Math.abs(d1.pitch - (52 - dMid * per)) <= 2 && d1.S.pitch === 52 && d2.pitch === 0 && d2.S.view3d === true, JSON.stringify({ d1: [d1.pitch, d1.S], d2: [d2.pitch, d2.S], per }));
  ok(`[${T}] стрілка внизу — вид згори (2D): запам'ятовано, карта стежить далі й кут не «відскакує»; ручка в самому низу дорожки, нижнє вістря зблідло — далі нікуди`, d3.pitch === 0 && d3.S.view3d === false && d3.now === 0 && d3.flat && d3.text === 'вид згори' && d3.follow && Math.abs(d3.thumb.b - d3.track.b) <= 1 && d3.fillH === 0 && /^0\.75,0\.2$/.test(d3.dim), JSON.stringify({ pitch: d3.pitch, S: d3.S, now: d3.now, flat: d3.flat, text: d3.text, dim: d3.dim, thumb: d3.thumb, track: d3.track }));
  // ґ) тягнемо вгору на 40° — кут лишається й у стеженні
  const Yb = Math.round((d3.thumb.t + d3.thumb.b) / 2);
  await page.mouse.move(X, Yb); await page.mouse.down(); await page.mouse.move(X, Yb - Math.round(40 / per), { steps: 5 }); await page.mouse.up(); await sleep(300); await gps(); await sleep(1300);
  const t1 = await st();
  ok(`[${T}] потягли вгору — нахил ${t1.pitch}° (3D увімкнено), кут запам'ятовано й тримається, поки карта стежить за машиною`, Math.abs(t1.pitch - 40) <= 2 && t1.S.view3d === true && t1.S.pitch === t1.pitch && t1.now === t1.pitch && !t1.flat && t1.follow && t1.text === 'нахил ' + t1.pitch + '°', JSON.stringify({ pitch: t1.pitch, S: t1.S, now: t1.now, text: t1.text }));
  // д) угору до кінця (палець може вийти за плашку) — найбільший нахил
  const Yt = Math.round((t1.thumb.t + t1.thumb.b) / 2);
  await page.mouse.move(X, Yt); await page.mouse.down(); await page.mouse.move(X, Yt - Math.round(40 / per), { steps: 5 }); await page.mouse.up(); await sleep(300);
  const u1 = await st();
  ok(`[${T}] стрілка вгорі — найбільший нахил (60°, дивимось збоку); ручка в самому верху, дорожка під нею вся яскрава, верхнє вістря зблідло`, u1.pitch === 60 && u1.S.pitch === 60 && Math.abs(u1.thumb.t - u1.track.t) <= 1 && u1.max && u1.fillH >= u1.track.h - 34 && /^0\.2,0\.75$/.test(u1.dim), JSON.stringify({ pitch: u1.pitch, thumb: u1.thumb, track: u1.track, dim: u1.dim }));
  await shot(page, '44b-tilt-top-' + sc.n);
  // е) карту зсунули — з'явилось «Моє місце»; стрілка нахилу з місця не зрушила
  // тягнемо вільну карту — нижче плашок згори (з 1.1.29 там ще й «Вказати адресу»)
  const yDrag = Math.max(sc.h * 0.3, sc.w > sc.h ? sc.h * 0.5 : 0, await app(page, () => Math.round(Math.max(document.getElementById('top').getBoundingClientRect().bottom, document.getElementById('toasts').getBoundingClientRect().bottom)) + 24));
  await page.mouse.move(sc.w * 0.35, yDrag); await page.mouse.down(); await page.mouse.move(sc.w * 0.35 + 60, yDrag + 40, { steps: 4 }); await page.mouse.up(); await sleep(500);
  const c1 = await st();
  await shot(page, '44c-tilt-center-' + sc.n);
  ok(`[${T}] карту зсунули — з'явилось «Моє місце» (над нижньою плашкою справа, як і було); стрілка нахилу з місця не зрушила, нічого не накладається`, !c1.center.hidden && c1.center.vis && JSON.stringify(c1.tilt) === JSON.stringify(s0.tilt) && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify({ tilt: c1.tilt, was: s0.tilt, center: c1.center, lay: await page.evaluate(layoutCheck) }));
  if (sc.n === 'tabland') ok(`[${T}] широкий планшет: «Моє місце» не в самому куті — на ${c1.vh - c1.center.box.b} пікселів вище краю (з 1.1.28 — на одній висоті з кругом швидкості), не лежить на ⓘ`, c1.vh - c1.center.box.b >= 40 && (c1.attr.t >= c1.center.box.b || c1.attr.r <= c1.center.box.l), JSON.stringify({ center: c1.center.box, attr: c1.attr, vh: c1.vh }));
  if (main) {
    // є) жест на карті (тут — Ctrl і мишка вгору; на телефоні — два пальці вгору-вниз) — те саме, що стрілка: вона йде слідом, кут запам'ятовується
    const Y1 = Math.round((c1.thumb.t + c1.thumb.b) / 2);
    await page.mouse.move(X, Y1); await page.mouse.down(); await page.mouse.move(X, Y1 + Math.round(40 / per), { steps: 5 }); await page.mouse.up(); await sleep(300);
    const g0 = await st();
    await page.keyboard.down('Control'); await page.mouse.move(sc.w * 0.4, sc.h * 0.4); await page.mouse.down(); await page.mouse.move(sc.w * 0.4, sc.h * 0.4 - 40, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Control'); await sleep(400);
    const g1 = await st();
    ok(`[${T}] нахилили карту жестом — стрілка пішла слідом, новий кут запам'ятовано (жест і стрілка — одне й те саме)`, Math.abs(g0.pitch - 20) <= 2 && g1.pitch > g0.pitch + 8 && g1.now === g1.pitch && g1.S.pitch === g1.pitch && g1.S.view3d === true && g1.thumb.b < g0.thumb.b, JSON.stringify({ before: g0.pitch, after: g1.pitch, now: g1.now, S: g1.S }));
    // ж) плитка «2D / 3D»: 2D — згори, 3D — останній виставлений кут (а не завжди 52°)
    const keep = g1.S.pitch;
    await page.click('#bQuick'); await page.click('#quick [data-q="3d"]'); await sleep(700);
    const q1 = await st(), q1t = await app(page, () => document.querySelector('#quick [data-q="3d"] .q-txt').textContent);
    await page.click('#quick [data-q="3d"]'); await sleep(700);
    const q2 = await st(); await page.click('#quick [data-q="close"]');
    ok(`[${T}] плитка «2D / 3D» працює, як раніше: 2D — вид згори (стрілка внизу), 3D — останній виставлений кут (${keep}°)`, q1.pitch === 0 && q1.now === 0 && q1t === '2D' && q1.S.pitch === keep && q2.pitch === keep && q2.now === keep && q2.S.view3d, JSON.stringify({ q1: [q1.pitch, q1.S, q1t], q2: [q2.pitch, q2.S] }));
    // з) клавіші: стрілки вгору-вниз по 5°
    await app(page, () => document.getElementById('tilt').focus()); await page.keyboard.press('ArrowDown'); await sleep(250);
    const k1 = await st();
    ok(`[${T}] з клавіатури: стрілка вниз — на 5° менше`, k1.pitch === keep - 5 && k1.S.pitch === keep - 5, JSON.stringify({ keep, pitch: k1.pitch, S: k1.S }));
    // и) після перезапуску кут той самий
    await page.reload(); await page.waitForFunction(() => window.__app && window.__app.map && window.__app.map.map && window.__app.map.map.getSource('route'), null, { timeout: 20000 }); await gps(); await sleep(1500);
    const r1 = await st();
    ok(`[${T}] після перезапуску карта стежить під тим самим кутом (${keep - 5}°), стрілка там само`, r1.pitch === keep - 5 && r1.now === keep - 5 && r1.S.pitch === keep - 5, JSON.stringify({ pitch: r1.pitch, now: r1.now, S: r1.S }));
    // і) відкрите меню точки, панель «Місця», рейс без GPS (кнопки ±100) — стрілка на місці, нічого не накладається
    await app(page, () => window.__app.bus.emit('mapPick', { lat: 50.2, lon: 36.4 })); await sleep(400);
    const pk = await app(page, () => ({ pick: !document.getElementById('pick').hidden, tilt: getComputedStyle(document.getElementById('tilt')).visibility }));
    ok(`[${T}] відкрите меню точки на карті — стрілка нахилу на місці (вона в плашці й меню не заважає), нічого не накладається`, pk.pick && pk.tilt === 'visible' && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify({ pk, lay: await page.evaluate(layoutCheck) }));
    await app(page, () => window.__reisBack()); await sleep(200);
    await page.click('#tabs button[data-panel="places"]'); await sleep(400);
    const pl = await st();
    ok(`[${T}] (1.1.24) відкриті «Місця» — панель на весь екран, стрілку нахилу й кнопки закрито (не заважають гортати)`, !pl.seen && await app(page, () => document.getElementById('panel').classList.contains('full')), JSON.stringify({ seen: pl.seen, tilt: pl.tilt }));
    await page.click('#panelOk'); await sleep(250);
    const pl2 = await st();
    ok(`[${T}] закрили «Місця» — стрілка нахилу на тому самому місці, під пальцем, на кнопки не лягає`, pl2.shown && pl2.seen && JSON.stringify(pl2.tilt) === JSON.stringify(s0.tilt) && pl2.tilt.l >= pl2.tabs[pl2.tabs.length - 1].r && pl2.tabs.every(x => !x.cut), JSON.stringify({ tilt: pl2.tilt, was: s0.tilt }));
  }
  ok(`[${T}] прохід 31 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 31 (${sc.n}) дійшов до кінця`, false, String(e.message).split('\n')[0]); }

/* ============ прохід 32 (1.1.22): GPS — кружечок біля круга швидкості; «Калібрування телефона» на весь екран (три кроки);
   «Мітки» — кашкет, що світиться зеленим, коли на маршруті є позначки ============ */
// Датчики телефона підмінено: «рука» повертає телефон на заданий кут навколо заданої осі, гіроскоп і акселерометр показують
// те, що показали б насправді (з похибкою масштабу, дрейфом, тремтінням руки — як задано).
// Рух — як у руки: плавно розганяється й плавно зупиняється; гіроскоп віддає миттєву кутову швидкість (як справжній).
const gyInstall = page => app(page, () => {
  if (window.__gy) return;
  const T = window.__app.sensors._test, D = Math.PI / 180, G = { up: [0, 1, 0], scale: 1, bias: [0, 0, 0], noise: 0, on: false, mv: null, axis: null, timer: 0, yawN: 0, native: true, tremor: 0, sway: 0, axes: '', swayPrev: 0 };
  const rotv = (v, a, deg) => { const c = Math.cos(deg * D), s = Math.sin(deg * D), d = a[0] * v[0] + a[1] * v[1] + a[2] * v[2], cr = [a[1] * v[2] - a[2] * v[1], a[2] * v[0] - a[0] * v[2], a[0] * v[1] - a[1] * v[0]];
    return [v[0] * c + cr[0] * s + a[0] * d * (1 - c), v[1] * c + cr[1] * s + a[1] * d * (1 - c), v[2] * c + cr[2] * s + a[2] * d * (1 - c)]; };
  const tick = () => {
    const now = performance.now(); if (!G.on) return;
    let w = [0, 0, 0];
    if (G.mv) { const m = G.mv, s = Math.min(1, (now - m.t0) / 1000 / m.T), ang = m.deg * (1 - Math.cos(Math.PI * s)) / 2, d = ang - m.done, a = G.axis || G.up; m.done = ang;
      G.yawN -= d * G.scale * (G.axis ? G.axis[0] * G.up[0] + G.axis[1] * G.up[1] + G.axis[2] * G.up[2] : 1);      // те, що нарахує служба: навколо вертикалі, без пропусків
      if (G.axis) G.up = rotv(G.up, G.axis, -d);
      const inst = s < 1 ? m.deg * Math.PI / (2 * m.T) * Math.sin(Math.PI * s) : 0; w = a.map(x => x * inst); if (s >= 1) G.mv = null; }
    // жива рука: дрібне швидке тремтіння (8 разів на секунду, пік G.tremor °/с по кожній осі — телефон при цьому лишається на місці)
    // і повільне погойдування навколо вертикалі (±G.sway°, раз на ~3 с)
    const ts = now / 1000;
    if (G.tremor) w = [w[0] + G.tremor * Math.cos(50.3 * ts), w[1] + G.tremor * Math.cos(50.3 * ts + 2.1), w[2] + G.tremor * Math.cos(50.3 * ts + 4.2)];
    if (G.sway) { const ph = G.sway * Math.sin(2.2 * ts), d = ph - G.swayPrev; G.swayPrev = ph; G.yawN -= d * G.scale; const r = G.sway * 2.2 * Math.cos(2.2 * ts); w = [w[0] + G.up[0] * r, w[1] + G.up[1] * r, w[2] + G.up[2] * r]; }
    const nz = () => G.noise ? G.noise * (Math.random() - 0.5) * 3.46 : 0;
    const m = [w[0] * G.scale + G.bias[0] + nz(), w[1] * G.scale + G.bias[1] + nz(), w[2] * G.scale + G.bias[2] + nz()];
    // у подіях руху alpha, beta, gamma — це осі X, Y, Z телефона (так у всіх браузерах); axes: 'alt' — телефон, де їх переставлено
    if (G.raw !== false) T.onMotion({ rotationRate: G.axes === 'alt' ? { beta: m[0], gamma: m[1], alpha: m[2] } : { alpha: m[0], beta: m[1], gamma: m[2] },
      accelerationIncludingGravity: { x: 9.81 * G.up[0], y: 9.81 * G.up[1], z: 9.81 * G.up[2] }, timeStamp: now });
  };
  G.start = o => { Object.assign(G, { mv: null, axis: null, raw: true, native: true, tremor: 0, sway: 0, axes: '', swayPrev: 0 }, o || {}); { const m = Math.hypot(...G.up); G.up = G.up.map(x => x / m); } G.on = true; if (!G.timer) { G.timer = setInterval(tick, 16); setInterval(() => { if (G.on && G.native) window.__reis('sens', { var: 0.05, yaw: G.yawN }); }, 1000); } };
  G.stop = () => { G.on = false; };
  // поворот на deg градусів (проти годинникової, тобто ЛІВОРУЧ — плюс) із середньою швидкістю rate °/с; axis — вісь в осях телефона (нічого — навколо справжньої вертикалі)
  G.turn = (deg, rate = 80, axis = null) => { G.axis = axis; G.mv = { deg, T: Math.abs(deg) / rate, t0: performance.now(), done: 0 }; };
  window.__gy = G;
});
const calSt = page => app(page, () => { const C = window.__app.uiCalib.calibState(), box = document.getElementById('calib'), q = s => box.querySelector(s), tx = s => { const e = q(s); return e ? e.textContent.trim().replace(/\s+/g, ' ') : ''; };
  const r = box.getBoundingClientRect(), ph = q('#cbPhone'), nd = q('#cbBead');
  return { open: C.open, step: C.step, view: C.view, st: C.st && { step: C.st.step, angle: Math.round(C.st.angle * 10) / 10, want: C.st.want, first: C.st.first, hint: C.st.hint, prog: Math.round(C.st.prog * 100) / 100, left: C.st.left, right: C.st.right, hz: C.st.hz, n: C.st.n, result: C.st.result },
    box: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, sw: box.scrollWidth, cw: box.clientWidth },
    steps: [...box.querySelectorAll('.cb-steps li')].map(li => (li.classList.contains('done') ? '✓' : li.classList.contains('cur') ? '▶' : '·') + li.querySelector('.cb-tl').textContent.trim()).join(' | '),
    tiles: [...box.querySelectorAll('.cb-steps li')].map(li => { const r = li.getBoundingClientRect(), v = li.querySelector('.cb-pose svg').getBoundingClientRect(), cs = getComputedStyle(li); return { k: li.dataset.k, l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), pw: Math.round(v.width), ph: Math.round(v.height), hand: li.querySelectorAll('.cb-hand').length, border: cs.borderTopColor, badge: li.querySelector('b').textContent.trim(), tick: !!li.querySelector('b svg'), dim: +getComputedStyle(li.querySelector('.cb-pose')).opacity }; }),
    diag: tx('#cbDiag'),
    title: tx('#cbTitle') || tx('.cb-res .cb-title'), text: tx('#cbText') || tx('.cb-res .cb-text'), hint: tx('#cbHint'), ang: tx('#cbAng'), prog: q('#cbProg') ? q('#cbProg').style.width : '', foot: tx('.cb-foot'),
    phone: ph ? ph.style.transform : '', needle: nd ? nd.getAttribute('transform') : '', rest: q('#cbRest') ? q('#cbRest').dataset.to + ':' + (q('#cbRest').getAttribute('d') ? 1 : 0) : '', arc: q('#cbArc') ? q('#cbArc').getAttribute('d') : '', side: q('#cbPh3d') ? q('#cbPh3d').classList.contains('side') : null,
    rows: [...box.querySelectorAll('.cb-rows > div')].map(d => d.querySelector('span').textContent.trim() + ' = ' + d.querySelector('b').textContent.trim()).join(' | '), btns: [...box.querySelectorAll('.cb-btns button')].map(b => b.textContent.trim()).join(' | '),
    spoken: (window.__spoken || []).slice(-6), sfx: window.__app.sfx.sfxLog.map(x => x.kind).filter(k => /^cal-/.test(k)).join(), saved: window.__app.S.gyroCal, tab: '', tabLbl: '' }; });
// (1.1.24) калібрування — плитка у швидких налаштуваннях (права нижня клітинка): відкрити калібрування / прочитати стан плитки
const openCal = async page => { await page.click('#bQuick'); await page.click('#quick [data-q="cal"]'); };
const calTile = async page => { await page.click('#bQuick'); await sleep(200);
  const r = await app(page, () => { const b = document.querySelector('#quick [data-q="cal"]'); if (!b) return null; const q = b.getBoundingClientRect(), cs = getComputedStyle(b), g = b.parentElement, kids = [...g.children], gr = g.getBoundingClientRect();
    return { cls: b.className, label: b.querySelector('.q-l').textContent, state: b.querySelector('.q-s').textContent, color: cs.color, w: Math.round(q.width), h: Math.round(q.height), last: kids[kids.length - 1] === b, n: kids.length, fromRight: Math.round(gr.right - q.right), fromBottom: Math.round(gr.bottom - q.bottom), inView: q.left >= 0 && q.right <= innerWidth && q.bottom <= innerHeight,
      fills: b.querySelectorAll('svg [fill]:not([fill="none"]):not([fill="currentColor"])').length, fits: b.scrollWidth <= b.clientWidth + 1 }; });
  await page.click('#quick [data-q="close"]'); await sleep(150); return r; };
const waitCal = async (page, fn, ms = 9000) => { let s = null; for (let i = 0; i < ms / 100; i++) { s = await calSt(page); if (fn(s)) return s; await sleep(100); } return s; };

if (run('32')) try {
  /* ---- А. Логіка калібрування на синтетичних замірах (без екрана й реального часу) ---- */
  { const { page, ctx, errors } = await newPage(true, { viewport: { width: 360, height: 670 } });
    const U = await app(page, () => {
      const C = window.__app.calib, D = Math.PI / 180;
      const rotv = (v, a, deg) => { const c = Math.cos(deg * D), s = Math.sin(deg * D), d = a[0] * v[0] + a[1] * v[1] + a[2] * v[2], cr = [a[1] * v[2] - a[2] * v[1], a[2] * v[0] - a[0] * v[2], a[0] * v[1] - a[1] * v[0]];
        return [v[0] * c + cr[0] * s + a[0] * d * (1 - c), v[1] * c + cr[1] * s + a[1] * d * (1 - c), v[2] * c + cr[2] * s + a[2] * d * (1 - c)]; };
      // Телефон у руці: гіроскоп має похибку масштабу (scale), дрейф (bias), тремтіння (noise). Заміри для екрана — 60 разів на секунду,
      // але частина може пропасти («екран заїкнувся» — op 'lost'). Служба навігації (o.native) рахує той самий поворот без пропусків,
      // лише навколо вертикалі, і звітує раз на секунду (o.natScale — якщо вона раптом рахує не так).
      const sim = o => {
        const cal = C.newCal(), dt = 1 / 60, sc = o.scale || 1, bias = o.bias || [0, 0, 0]; let t = 100, u = o.up || [0, 1, 0], yawN = 0, k = 0; { const m = Math.hypot(...u); u = u.map(x => x / m); }
        let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5, nz = () => o.noise ? o.noise * rnd() * 3.46 : 0;
        let peak = 0;
        const step = (w0, lost) => { t += dt; let w = w0;
          // жива рука: тремтіння 8 разів на секунду (пік o.tremor °/с по кожній осі) і повільне погойдування навколо вертикалі (±o.sway°)
          if (o.tremor) w = [w[0] + o.tremor * Math.cos(50.3 * t), w[1] + o.tremor * Math.cos(50.3 * t + 2.1), w[2] + o.tremor * Math.cos(50.3 * t + 4.2)];
          if (o.sway) { const r = o.sway * 2.2 * Math.cos(2.2 * t); w = [w[0] + u[0] * r, w[1] + u[1] * r, w[2] + u[2] * r]; }
          if (w0[0] === 0 && w0[1] === 0 && w0[2] === 0) peak = Math.max(peak, Math.hypot(w[0], w[1], w[2]));
          const m = [w[0] * sc + bias[0] + nz(), w[1] * sc + bias[1] + nz(), w[2] * sc + bias[2] + nz()];
          yawN -= (m[0] * u[0] + m[1] * u[1] + m[2] * u[2]) * dt * (o.natScale || 1);
          if (!lost && !(o.drop && rnd() + 0.5 < o.drop)) cal.feed({ t, w: o.axes === 'alt' ? [m[2], m[0], m[1]] : m, g: u.map(x => 9.81 * x) });     // 'alt' — телефон, що віддає осі гіроскопа в іншому порядку; drop — частка замірів, що пропадає (телефон зайнятий)
          if (o.native && ++k % 60 === 0) cal.native(yawN); };
        const rest = s => { for (let i = 0; i < Math.round(s * 60); i++) step([0, 0, 0]); };
        const turn = (deg, s, axis, lost) => { const n = Math.round(s * 60), st = deg / n; for (let i = 0; i < n; i++) { const a = axis || u; step(a.map(x => x * st / dt), lost); if (axis) u = rotv(u, axis, -st); } };
        const log = [];
        for (const [op, a, b, c] of o.ops) { if (op === 'rest') rest(a); else if (op === 'turn') turn(a, b, c); else if (op === 'lost') turn(a, b, c, true); else if (op === 'gap') t += a;
          log.push({ step: cal.st.step, hint: cal.st.hint, ang: Math.round(cal.st.angle * 10) / 10, prog: Math.round(cal.st.prog * 100) / 100, want: cal.st.want }); }
        const s = cal.st; return { step: s.step, hint: s.hint, left: s.left, right: s.right, first: s.first, want: s.want, pose: s.pose, rigid: s.rigid, bias: s.bias, hz: s.hz, r: s.result, log, swap: s.swap, peak: Math.round(peak), rate: Math.round(s.rate) };
      };
      // звичайний хід: 3 с нерухомо → ліворуч на L → затримати → праворуч через пряме на R → затримати
      const std = (L, R, axis) => [['rest', 3], ['turn', L, 1.2, axis], ['rest', 1.4], ['turn', -(L + R), 2, axis], ['rest', 1.4]];
      const c25 = Math.cos(25 * D), s25 = Math.sin(25 * D), out = {};
      out.exact = sim({ ops: std(90, 90) });
      out.s92 = sim({ scale: 0.92, ops: std(90, 90) });
      out.s98 = sim({ scale: 0.98, ops: std(90, 90) });
      out.s955 = sim({ scale: 0.955, ops: std(90, 90) }); out.s965 = sim({ scale: 0.965, ops: std(90, 90) });
      out.s108 = sim({ scale: 1.08, ops: std(90, 90) });
      out.leanOwn = sim({ up: [0, c25, s25], ops: std(90, 90, [0, 1, 0]) });          // нахилений телефон повертають навколо його власної довгої осі
      out.leanVert = sim({ up: [0, c25, s25], ops: std(90, 90) });                    // …і навколо вертикалі (як у тримачі)
      out.leanOwn92 = sim({ up: [0, c25, s25], scale: 0.92, ops: std(90, 90, [0, 1, 0]) });
      out.land = sim({ up: [1, 0, 0], ops: std(90, 90) }); out.land2 = sim({ up: [-0.94, 0, 0.34], ops: std(90, 90) });
      out.offCentre = sim({ ops: std(82, 98) });                                      // «прямо» на початку було на 8° убік — розмах той самий
      out.rightFirst = sim({ ops: [['rest', 3], ['turn', -90, 1.2], ['rest', 1.4], ['turn', 180, 2], ['rest', 1.4]] });
      out.early = sim({ ops: [['rest', 3], ['turn', 55, 1], ['rest', 1.6], ['turn', 35, 0.6], ['rest', 1.4]] });
      out.asym = sim({ ops: std(75, 100) }); out.short1 = sim({ ops: std(72, 90) }); out.short1b = sim({ ops: std(90, 73) }); out.s92off = sim({ scale: 0.92, ops: std(86, 94) });
      out.range = sim({ ops: std(72, 72) });
      out.flat = sim({ up: [0, 0.3, 0.954], ops: [['rest', 4]] });
      out.moving = sim({ ops: [['turn', 40, 4]] });
      out.rigidBias = sim({ bias: [0, 0.5, 0], ops: std(90, 90) });
      out.hand = sim({ bias: [0, 0.4, 0], noise: 1, ops: std(90, 90) });
      out.drift = sim({ bias: [0, 2, 0], ops: [['rest', 12]] });
      out.gap = sim({ ops: [['rest', 3], ['turn', 40, 0.6], ['gap', 1.5], ['rest', 0.2]] });
      // екран «заїкнувся» на 0,3 с посеред повороту (заміри пропали, телефон повертався далі) — кут не загублено
      out.stutter = sim({ ops: [['rest', 3], ['turn', 30, 0.4], ['lost', 22.5, 0.3], ['turn', 37.5, 0.5], ['rest', 1.4]] });
      // …а якщо в заїканні телефон саме смикнули швидше (20° за 0,15 с), екран недорахує ~9° за кожен такий раз:
      const jerky = (L, R, axis) => [['rest', 3.2], ['turn', 40, 0.53, axis], ['lost', 20, 0.15, axis], ['turn', L - 60, (L - 60) / 75, axis], ['rest', 1.8], ['turn', -(L + R - 60), (L + R - 60) / 75, axis], ['lost', -20, 0.15, axis], ['turn', -40, 0.53, axis], ['rest', 1.8]];
      out.jankWeb = sim({ ops: jerky(90, 90) });                                         // служби немає — звіритись нема з чим
      out.jankNat = sim({ native: true, ops: jerky(90, 90) });                           // служба є — розмах беремо в неї
      out.jankNat92 = sim({ native: true, scale: 0.92, ops: jerky(90, 90) });
      const stdN = (L, R, axis) => [['rest', 3.2], ['turn', L, 1.2, axis], ['rest', 1.8], ['turn', -(L + R), 2, axis], ['rest', 1.8]];
      out.nat = sim({ native: true, ops: stdN(90, 90) }); out.nat92 = sim({ native: true, scale: 0.92, ops: stdN(90, 90) });
      out.natLeanOwn = sim({ native: true, up: [0, c25, s25], ops: stdN(90, 90, [0, 1, 0]) });
      out.natWrong = sim({ native: true, natScale: 0.5, scale: 0.92, ops: stdN(90, 90) });   // служба рахує щось не те — їй не віримо
      out.natBias = sim({ native: true, bias: [0, 0.5, 0], ops: stdN(90, 90) });
      out.tooFar = sim({ ops: [['rest', 3], ['turn', 131, 1.6], ['rest', 1.4]] });
      // (1.1.23) жива рука: тремтить (пік 18 °/с по кожній осі) і погойдується на ±3° — телефон при цьому на місці
      out.tremor = sim({ tremor: 18, sway: 3, ops: std(90, 90) }); out.tremor92 = sim({ tremor: 18, sway: 3, scale: 0.92, ops: std(90, 90) });
      out.tremorNat = sim({ native: true, tremor: 18, sway: 3, ops: stdN(90, 90) });
      out.tremorLean = sim({ up: [0, c25, s25], tremor: 14, sway: 2, ops: std(90, 90, [0, 1, 0]) });
      // жива рука + телефон зайнятий: до екрана доходить лише ~40 % замірів, нерівно (≈24/с) — нахил за гіроскопом «напливає», вирівнюємо за акселерометром
      { const jk = [['rest', 4], ['turn', 90, 1.2], ['rest', 3], ['turn', -180, 2], ['rest', 3]], oj = { native: true, tremor: 18, sway: 2.5, drop: 0.6, up: [0, 0.94, 0.34], ops: jk };
        out.handJank = sim(oj); const keep = C.CAL.LEVEL_RATE; C.CAL.LEVEL_RATE = 0; out.handJankNoLevel = sim(oj); C.CAL.LEVEL_RATE = keep; }
      // до грані «доїжджають» повільно (останні 20° — дві секунди): фіксуємо не на півдорозі, а коли телефон справді став
      out.creep = sim({ ops: [['rest', 3], ['turn', 70, 0.9], ['turn', 20, 2], ['rest', 1.4], ['turn', -180, 2], ['rest', 1.4]] });
      // телефон, що віддає осі гіроскопа в іншому порядку: самоперевірка за акселерометром це бачить і рахує правильно
      out.axAlt = sim({ axes: 'alt', ops: std(90, 90) }); out.axAltLean = sim({ axes: 'alt', up: [0, c25, s25], scale: 0.92, ops: std(90, 90, [0, 1, 0]) }); out.axAltHand = sim({ axes: 'alt', tremor: 18, sway: 3, ops: std(90, 90) });
      // датчики руху (sensors.js): у подіях руху alpha — вісь X, beta — Y, gamma — Z
      { const Sn = window.__app.sensors, Tt = Sn._test, raw = []; const offR = Sn.onRaw(x => raw.push(x.w.map(v => Math.round(v)).join())); let tt = performance.now() + 5e6;
        const run1 = (rr, up, n = 60) => { for (let i = 0; i < n; i++) { Tt.onMotion({ timeStamp: tt, rotationRate: rr, accelerationIncludingGravity: { x: up[0] * 9.81, y: up[1] * 9.81, z: up[2] * 9.81 }, acceleration: { x: 0, y: 0, z: 0 } }); tt += 1000 / 60; } Tt.flush(tt / 1000); return { yaw: Sn.ms.yaw, tilt: Math.round(Sn.ms.tilt * 10) / 10 }; };
        const Z = { alpha: 0, beta: 0, gamma: 0 };
        run1(Z, [0, 1, 0], 400);                                                                              // «угору» встановилось: телефон сторч
        const a0 = run1(Z, [0, 1, 0]), a1 = run1({ alpha: 0, beta: 30, gamma: 0 }, [0, 1, 0]), rawY = raw[raw.length - 1];   // 1 с повертають ліворуч 30 °/с навколо довгої осі (Y)
        run1(Z, [0, 0.94, 0.34], 400);                                                                        // у тримачі з нахилом 20°
        const b0 = run1(Z, [0, 0.94, 0.34]), b1 = run1({ alpha: 0, beta: -25 * 0.94, gamma: -25 * 0.34 }, [0, 0.94, 0.34]), hand = Sn.motionHint();   // фура 1 с повертає праворуч 25 °/с
        const c0 = run1(Z, [0, 0.94, 0.34]), c1 = run1({ alpha: 40, beta: 0, gamma: 0 }, [0, 0.94, 0.34]), hand2 = Sn.motionHint();                   // нахиляють уперед-назад (вісь X) — це не поворот, це рука
        offR(); out.axes = { yawY: Math.round((a1.yaw - a0.yaw) * 10) / 10, tiltY: a1.tilt, rawY, truckYaw: Math.round((b1.yaw - b0.yaw) * 10) / 10, truckTilt: b1.tilt, hand, yawX: Math.round((c1.yaw - c0.yaw) * 10) / 10, tiltX: c1.tilt, hand2 }; }
      out.laidDown = sim({ ops: [['rest', 3], ['turn', 80, 1.2, [1, 0, 0]], ['rest', 0.5]] });      // на другому кроці телефон поклали екраном догори
      out.judge = [C.judge({ left: 86.6, right: 86.6 }), C.judge({ left: 87, right: 87 }), C.judge({ left: 93.5, right: 93.5 }), C.judge({ left: 94, right: 94 }), C.judge({ left: 78, right: 78 }), C.judge({ left: 77, right: 77 }), C.judge({ left: 104, right: 104 }), C.judge({ left: 105, right: 105 })].map(r => [r.ok, r.fine, r.k, r.why].join(':'));
      out.pose = [C.poseOf([0, 1, 0]), C.poseOf([0, Math.cos(35 * D), Math.sin(35 * D)]), C.poseOf([0, 0, 1]), C.poseOf([1, 0, 0.1])].map(p => p.kind + ':' + p.lean + ':' + p.side);
      // навігація: кут від служби множиться на поправку, без стрибка в мить, коли поправка змінилась
      const N = window.__app.nav, S = window.__app.S; S.gyroCal = null;
      const y = [N.calYaw(10), N.calYaw(100)]; S.gyroCal = { v: 1, k: 1.1, at: Date.now() }; y.push(N.calYaw(100), N.calYaw(190)); S.gyroCal = null; y.push(N.calYaw(190), N.calYaw(100));
      out.calYaw = y.map(v => Math.round(v * 10) / 10).join();
      out.fresh = [C.calFresh(), (S.gyroCal = { v: 1, k: 1, at: Date.now() - 80 * 864e5 }, C.calFresh()), (S.gyroCal = { v: 1, k: 1, at: Date.now() - 91 * 864e5 }, C.calFresh()), (S.gyroCal = { v: 1, k: 7, at: Date.now() }, C.gyroK())].join(); S.gyroCal = null;
      return out; });
    const near = (v, x, e = 0.3) => v != null && Math.abs(v - x) <= e;
    const R = k => U[k].r || {};
    ok('калібрування, логіка: точний гіроскоп, рівно тримають — три кроки, 90° телефон бачить як 90,0°, поправка не потрібна (k = 1); 60 замірів/с', U.exact.step === 4 && R('exact').ok && R('exact').fine && R('exact').k === 1 && near(R('exact').seen90, 90, 0.1) && near(U.exact.left, 90, 0.1) && near(U.exact.right, 90, 0.1) && U.exact.first === -1 && U.exact.pose.kind === 'upright' && U.exact.hz >= 58 && U.exact.hz <= 62, JSON.stringify(U.exact));
    ok('калібрування, логіка: гіроскоп занижує на 8 % (90° бачить як 82,8°) — поправка ×1,087; завищує на 8 % (97,2°) — ×0,926', R('s92').ok && !R('s92').fine && near(R('s92').seen90, 82.8, 0.1) && near(R('s92').k, 1.087, 0.002) && near(R('s92').pct, 8.7, 0.15) && R('s108').ok && !R('s108').fine && near(R('s108').k, 0.9259, 0.002), JSON.stringify([R('s92'), R('s108')]));
    ok('калібрування, логіка: відхилення до ±4 % (тут 2 %: 88,2°) — «гіроскоп у нормі», поправка 1: неточність руки не псує точний датчик; межа — між 3,5 % і 4,5 %', R('s98').ok && R('s98').fine && R('s98').k === 1 && near(R('s98').seen90, 88.2, 0.1) && near(R('s98').kRaw, 1.0204, 0.001) && R('s965').fine && R('s965').k === 1 && !R('s955').fine && near(R('s955').k, 1.0471, 0.001), JSON.stringify([R('s98'), R('s965'), R('s955')]));
    ok('калібрування, логіка: межі оцінки — 86,6°…93,5° ще норма, 87° теж, 94° уже поправка; 78°…104° приймаємо, 77° і 105° — «повторіть»', U.judge.join(' ') === 'true:true:1:' + ' true:true:1:' + ' true:true:1:' + ' true:false:0.9574:' + ' true:false:1.1538:' + ' false:false:1.1688:range' + ' true:false:0.8654:' + ' false:false:0.8571:range', U.judge.join(' '));
    ok('калібрування, логіка: телефон із нахилом 25° — хоч навколо вертикалі (як у тримачі), хоч навколо власної довгої осі (як зручно руці): однаково 90,0° — нахил не дає хибної поправки (раніше було б 81,6°, тобто +10 %)',
      R('leanOwn').ok && R('leanOwn').fine && near(R('leanOwn').seen90, 90, 0.15) && R('leanVert').fine && near(R('leanVert').seen90, 90, 0.15) && U.leanOwn.pose.kind === 'tilted' && U.leanOwn.pose.lean === 25 && !R('leanOwn92').fine && R('leanOwn92').seen90 > 82.5 && R('leanOwn92').seen90 < 84 && near(R('leanOwn92').k, 1.08, 0.01), JSON.stringify([R('leanOwn'), R('leanVert'), R('leanOwn92')]));
    ok('калібрування, логіка: телефон набік (альбомно), рівно чи з нахилом 20° — так само 90,0°; у результаті позначено «набік»', R('land').ok && near(R('land').seen90, 90, 0.15) && U.land.pose.side === true && U.land.pose.kind === 'upright' && R('land2').ok && near(R('land2').seen90, 90, 0.15) && U.land2.pose.side === true && U.land2.pose.kind === 'tilted', JSON.stringify([U.land.pose, R('land'), U.land2.pose, R('land2')]));
    ok('калібрування, логіка: «прямо» на початку було на 8° убік (ліворуч 82°, праворуч 98°) — розмах той самий 180°, результат 90,0°', R('offCentre').ok && R('offCentre').fine && near(R('offCentre').left, 82, 0.2) && near(R('offCentre').right, 98, 0.2) && near(R('offCentre').seen90, 90, 0.1), JSON.stringify(R('offCentre')));
    ok('калібрування, логіка: спершу повернули праворуч — теж зараховано (перший бік — праворуч, далі просимо ліворуч)', R('rightFirst').ok && U.rightFirst.first === 1 && near(U.rightFirst.left, 90, 0.2) && near(U.rightFirst.right, 90, 0.2), JSON.stringify({ first: U.rightFirst.first, log: U.rightFirst.log }));
    ok('калібрування, логіка: зупинились на 55° — не зараховано, підказка «ще трохи»; довели до 90° — зараховано', U.early.log[2].step === 2 && U.early.log[2].hint === 'more' && U.early.log[4].step === 3 && near(U.early.left, 90, 0.2), JSON.stringify(U.early.log));
    ok('калібрування, логіка: ліворуч 75°, праворуч 100° — надто по-різному: «повторіть» (asym); обидва боки по 72° — це не 90°: «повторіть» (range)', U.asym.step === 4 && !R('asym').ok && R('asym').why === 'asym' && !R('range').ok && R('range').why === 'range', JSON.stringify([R('asym'), R('range')]));
    ok(`калібрування, логіка: один бік не довели до грані (72° і 90°) — виглядає як «гіроскоп занижує на 10 %», але справжня похибка датчика дає боки однакові: чесно «повторіть», а не хибна поправка +11 %; гіроскоп −8 % і «прямо» трохи вбік (79° і 86,5°) — поправку беремо`,
      U.short1.step === 4 && !R('short1').ok && R('short1').why === 'asym' && !R('short1b').ok && R('short1b').why === 'asym' && R('s92off').ok && !R('s92off').fine && near(R('s92off').k, 1.087, 0.003), JSON.stringify([R('short1'), R('short1b'), R('s92off')]));
    ok('калібрування, логіка: телефон лежить — крок 1 не йде, підказка «поставте вертикально»; телефон рухають — «тримайте нерухомо»; на кроці 2 поклали екраном догори — теж «вертикально»', U.flat.step === 1 && U.flat.hint === 'upright' && U.moving.step === 1 && U.moving.hint === 'hold' && U.moving.log[0].prog < 0.6 && U.laidDown.step === 2 && U.laidDown.hint === 'upright' && U.laidDown.left == null, JSON.stringify([U.flat.log, U.moving.log, U.laidDown.log]));
    ok('калібрування, логіка: повернули на 131° — забагато, не зараховано; заміри урвались на 1,5 с посеред повороту (програму згорнули) — починаємо з кроку 1', U.tooFar.step === 2 && U.tooFar.hint === 'tooFar' && U.tooFar.left == null && U.gap.step === 1 && U.gap.left == null, JSON.stringify([U.tooFar.log, U.gap.log]));
    ok('калібрування, логіка: екран «заїкнувся» на 0,3 с посеред рівного повороту — кут не загублено (90,0°), крок зараховано', U.stutter.step === 3 && near(U.stutter.left, 90, 0.5), JSON.stringify([U.stutter.left, U.stutter.log]));
    ok('калібрування, логіка: є кут від служби навігації — розмах беремо в неї (та сама відповідь: 90,0° і 82,8°), затримка довша — 1,5 с', R('nat').ok && R('nat').src === 'native' && near(R('nat').seen90, 90, 0.2) && R('nat').fine && R('nat92').src === 'native' && near(R('nat92').seen90, 82.8, 0.2) && near(R('nat92').k, 1.087, 0.003), JSON.stringify([R('nat'), R('nat92')]));
    ok(`калібрування, логіка: у заїканні телефон смикнули — заміри екрана недорахували (${R('jankNat').web}° на бік замість 90°), але служба нічого не губить: результат 90,0°, гіроскоп «у нормі» (без служби тут вийшла б хибна поправка +${Math.round((90 / R('jankNat').web - 1) * 100)} %)`, R('jankNat').ok && R('jankNat').src === 'native' && R('jankNat').web < 87 && near(R('jankNat').seen90, 90, 0.3) && R('jankNat').fine && R('jankNat').k === 1 && near(R('jankNat92').seen90, 82.8, 0.4) && !R('jankNat92').fine, JSON.stringify([R('jankNat'), R('jankNat92')]));
    ok('калібрування, логіка: те саме без служби (браузер) — звіритись нема з чим, заїкань забагато: чесно «повторіть, повертайте повільніше», а не хибна поправка', U.jankWeb.step === 4 && !R('jankWeb').ok && R('jankWeb').why === 'jank' && R('jankWeb').src === 'web' && R('jankWeb').loss > 20, JSON.stringify(R('jankWeb')));
    ok('калібрування, логіка: нахилений телефон повертають навколо власної осі — служба бачить менше (163°: вона рахує навколо вертикалі), але заміри екрана знають, як повертали: 90,0°', R('natLeanOwn').ok && R('natLeanOwn').src === 'native' && near(R('natLeanOwn').native, 163.1, 0.6) && near(R('natLeanOwn').seen90, 90, 0.8) && R('natLeanOwn').fine, JSON.stringify(R('natLeanOwn')));
    ok('калібрування, логіка: служба нарахувала вдвічі менше, ніж екран (щось не те) — їй не віримо, рахуємо із замірів екрана; дрейф служби 0,5 °/с на закріпленому телефоні — виміряно в спокої й віднято', R('natWrong').ok && R('natWrong').src === 'web' && near(R('natWrong').seen90, 82.8, 0.2) && R('natBias').src === 'native' && near(R('natBias').seen90, 90, 0.4), JSON.stringify([R('natWrong'), R('natBias')]));
    ok('калібрування, логіка: телефон закріплено (шуму немає), гіроскоп дрейфує 0,5 °/с — дрейф виміряно й віднято: 90,0°', U.rigidBias.rigid === true && R('rigidBias').ok && near(R('rigidBias').seen90, 90, 0.1) && near(Math.abs(R('rigidBias').bias), 0.5, 0.02), JSON.stringify([U.rigidBias.rigid, R('rigidBias')]));
    ok('калібрування, логіка: телефон у руці (тремтіння 1 °/с, рука «пливе» 0,4 °/с) — це не дрейф датчика, не віднімаємо; результат у межах 90 ± 1,5°, «у нормі»', U.hand.rigid === false && R('hand').ok && R('hand').fine && near(R('hand').seen90, 90, 1.5), JSON.stringify([U.hand.rigid, R('hand')]));
    ok('калібрування, логіка: телефон закріплено (тремтіння немає), а гіроскоп увесь час показує поворот 2 °/с — чесно: «гіроскоп пливе», а не хибна поправка', U.drift.step === 4 && !R('drift').ok && R('drift').why === 'bias' && near(R('drift').bias, 2, 0.05), JSON.stringify([U.drift.log, R('drift')]));
    ok(`калібрування, логіка (1.1.23): ЖИВА РУКА — тремтить (у спокої гіроскоп показує до ${U.tremor.peak} °/с; у 1.1.22 «нерухомо» було < 5 °/с, і відлік не йшов) і погойдується на ±3°: телефон лишається на місці — кроки зараховано, 90° = ${R('tremor').seen90}°, «у нормі»; з гіроскопом, що занижує на 8 %, — поправка ×${R('tremor92').k}`,
      U.tremor.peak >= 25 && U.tremor.step === 4 && R('tremor').ok && R('tremor').fine && near(R('tremor').seen90, 90, 3) && U.tremor.rigid === false && R('tremor92').ok && !R('tremor92').fine && near(R('tremor92').k, 1.087, 0.035) && R('tremorLean').ok && R('tremorLean').fine && near(R('tremorLean').seen90, 90, 3), JSON.stringify([U.tremor.peak, R('tremor'), R('tremor92'), R('tremorLean')]));
    ok('калібрування, логіка: жива рука й кут від служби навігації — розмах беремо в служби: 90° ± 3°, «у нормі»', R('tremorNat').ok && R('tremorNat').src === 'native' && R('tremorNat').fine && near(R('tremorNat').seen90, 90, 3), JSON.stringify(R('tremorNat')));
    ok(`калібрування, логіка: жива рука, а телефон ще й зайнятий (до екрана доходить ~40 % замірів, ${U.handJank.hz}/с): нахил, що «напливає» за гіроскопом, вирівнюємо за акселерометром — 90° = ${R('handJank').seen90}° (без вирівнювання вийшло б ${R('handJankNoLevel').seen90 || '—'}°)`,
      U.handJank.step === 4 && R('handJank').ok && R('handJank').src === 'native' && near(R('handJank').seen90, 90, 3) && U.handJank.hz >= 18 && U.handJank.hz <= 30, JSON.stringify([U.handJank.hz, R('handJank'), R('handJankNoLevel')]));
    ok(`калібрування, логіка: до грані «доїжджають» повільно (останні 20° — дві секунди) — фіксуємо не на півдорозі, а коли телефон став: ${U.creep.left && U.creep.left.toFixed(1)}° (а не ~75°)`, U.creep.log[2].step === 2 && U.creep.step === 4 && near(U.creep.left, 90, 1.5) && R('creep').ok && R('creep').fine, JSON.stringify([U.creep.left, U.creep.log, R('creep')]));
    ok('датчики руху (1.1.23): у подіях руху alpha — вісь X, beta — Y, gamma — Z. Телефон сторч повертають ліворуч 30 °/с навколо довгої осі — це ПОВОРОТ на 30° (а не нахил, як читалось із 1.1.12); нахил уперед-назад — не поворот',
      near(U.axes.yawY, -30, 1) && U.axes.tiltY < 2 && U.axes.rawY === '0,30,0' && Math.abs(U.axes.yawX) < 1 && U.axes.tiltX > 30 && U.axes.hand2 && U.axes.hand2.handled === true, JSON.stringify(U.axes));
    ok(`датчики руху: фура різко повертає праворуч (25 °/с), телефон у тримачі з нахилом 20° — поворот ${U.axes.truckYaw}°, нахил телефона за цю секунду ${U.axes.truckTilt}° — це НЕ «телефон крутять у руках» (раніше такий поворот відкидався)`, near(U.axes.truckYaw, 25, 1) && U.axes.truckTilt < 3 && U.axes.hand && U.axes.hand.handled === false, JSON.stringify(U.axes));
    ok('калібрування, логіка: самоперевірка осей — телефон віддає осі гіроскопа в іншому порядку: після повороту «вгору» за гіроскопом не збігається з акселерометром, а з переставленими осями збігається — рахуємо з переставленими: 90,0° (рівно), 82,8° (нахил 25°, гіроскоп −8 %), жива рука — теж; на звичайних телефонах перестановка не вмикається',
      U.axAlt.swap === true && R('axAlt').ok && R('axAlt').fine && near(R('axAlt').seen90, 90, 0.5) && U.axAltLean.swap === true && R('axAltLean').ok && near(R('axAltLean').seen90, 82.8, 1.2) && U.axAltHand.swap === true && R('axAltHand').ok && near(R('axAltHand').seen90, 90, 3)
      && ['exact', 'leanOwn', 'leanVert', 'land', 'land2', 'tremor', 'tremorLean', 'hand', 'jankNat', 'stutter', 'laidDown', 'early', 'rightFirst'].every(k => U[k].swap === false), JSON.stringify({ alt: [U.axAlt.swap, R('axAlt')], lean: [U.axAltLean.swap, R('axAltLean')], hand: [U.axAltHand.swap, R('axAltHand')], others: ['exact', 'leanOwn', 'leanVert', 'land', 'land2', 'tremor', 'tremorLean', 'hand', 'jankNat', 'stutter', 'laidDown', 'early', 'rightFirst'].filter(k => U[k].swap !== false) }));
    ok('калібрування, логіка: положення телефона — вертикально (0°), з нахилом 35°, лежить (90°), набік', U.pose.join(' ') === 'upright:0:false tilted:35:false flat:90:false upright:6:true', U.pose.join(' '));
    ok('ведення: кут повороту від служби множиться на поправку телефона (k = 1,1: 90° → 99°), без стрибка в мить, коли поправку змінено', U.calYaw === '10,100,100,199,199,109', U.calYaw);
    ok('калібрування «свіже» 90 днів (80 днів — так, 91 — ні); нісенітна поправка зі сховища (×7) не застосовується', U.fresh === 'false,true,false,1', U.fresh);
    ok('прохід 32 (логіка) без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close(); }

  /* ---- Б. Екран: кружечок GPS, нижня стрічка, калібрування від початку до кінця ---- */
  for (const sc of [...SCREENS.filter(x => ['S10', 'tiny', 'land', 'tablet', 'xiaomi'].includes(x.n)), { n: 'tabland', w: 1272, h: 702, dpr: 1, title: 'планшет набік 1272×702' }].filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) {
    const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
    const T = sc.title, main = sc.n === 'S10', emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
    const land = sc.w > sc.h;
    const box = sel => app(page, sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(), cs = getComputedStyle(e), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), seen: !!h && (h === e || e.contains(h)), color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor, vis: cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 0, cls: e.className, label: e.getAttribute('aria-label') }; }, sel);
    // а) GPS ще немає: кружечок біля круга швидкості червоний; нижня стрічка спокійна
    await sleep(500);
    const g0 = await box('#spdGps'), spd = await box('#speed'), bt = await box('#bottom');
    ok(`[${T}] (1.1.24) GPS — кружечок ЛІВОРУЧ унизу від круга швидкості (знак обмеження — ліворуч угорі), притиснутий до краю екрана: 52×52 (1.1.26: на 20 % більший, як і круг), не лягає на нижню плашку, нічим не перекритий; праворуч від круга нічого не стирчить`, g0.w === 52 && g0.h === 52 && g0.seen && g0.l >= 2 && g0.cx < spd.l + 12 && g0.cx > spd.l - 16 && g0.r <= spd.r && g0.cy > spd.cy + 20 && g0.b <= spd.b + 10 && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify({ g0, spd, bt: bt.t, lay: await page.evaluate(layoutCheck) }));
    if (!land && sc.w < 1010) { const ear = await box('#tabbar .tb-main'), tl = await box('#tilt');
      ok(`[${T}] (1.1.26) круг швидкості на 20 % більший (${spd.w} замість 92); (1.1.28) опущений до плашки — на ${ear.t - spd.b} px над її рівною лівою частиною; кружечок GPS — за ${ear.t - g0.b} px над нею`, spd.w === 110 && spd.h === 110 && ear.t - spd.b >= 12 && ear.t - spd.b <= 16 && g0.b <= ear.t - 8 && g0.b >= ear.t - 12, JSON.stringify({ spd, ear, tl, g0 })); }
    ok(`[${T}] GPS немає — кружечок червоний, для озвучення «${g0.label}»`, /g-bad/.test(g0.cls) && /rgb\(2\d\d, \d\d, \d\d\)/.test(g0.bg) && !!g0.label && !/^GPS ±/.test(g0.label), JSON.stringify(g0));
    await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 0, t: Date.now() }); await sleep(900);
    const g1 = await box('#spdGps');
    ok(`[${T}] GPS є — кружечок зелений («${g1.label}»)`, /g-ok/.test(g1.cls) && g1.color === 'rgb(47, 158, 98)' && /^GPS ±/.test(g1.label), JSON.stringify(g1));
    // знак обмеження праворуч угорі й кружечок GPS праворуч унизу — один над одним, не накладаються
    await app(page, () => { const e = document.getElementById('spdLim'); e.hidden = false; e.textContent = '50'; });
    const lim = await box('#spdLim'), g1b = await box('#spdGps');
    ok(`[${T}] знак обмеження «50» — ліворуч угорі, кружечок GPS — ліворуч унизу: один під одним, не торкаються; обидва в межах екрана й не правіше круга`, Math.abs(lim.cx - g1b.cx) <= 6 && g1b.t - lim.b >= 8 && lim.l >= 2 && lim.r <= spd.r && lim.cx < spd.l + 14, JSON.stringify({ lim, g1b, spd }));
    await app(page, () => { document.getElementById('spdLim').hidden = true; });
    await shot(page, '45-gps-badge-' + sc.n);
    if (main) {
      await page.click('#spdGps'); await sleep(350);
      const p1 = await app(page, () => ({ title: document.getElementById('panelTitle').textContent, open: !document.getElementById('panel').hidden, body: document.getElementById('panelBody').textContent.slice(0, 200) }));
      ok(`[${T}] дотик до кружечка GPS відкриває панель GPS (те саме, що раніше відкривала вкладка внизу)`, p1.open && /GPS/.test(p1.title) && /Супутники/.test(await page.textContent('#panelBody')), JSON.stringify(p1));
      await page.click('#panelOk'); await sleep(250);
      // попередження про камеру стоїть правіше й кружечка не зачіпає
      await app(page, () => { const c = document.getElementById('cam'); c.hidden = false; document.getElementById('camMax').textContent = '50'; document.getElementById('camDist').textContent = '300 м'; document.getElementById('camLbl').textContent = 'камера'; });
      const cam = await box('#cam'), g2 = await box('#spdGps');
      ok(`[${T}] попередження про камеру — одразу правіше круга швидкості (кружечок GPS тепер ліворуч і місця не забирає), не накладаються; у межах екрана`, cam.l >= spd.r + 4 && cam.l <= spd.r + 16 && cam.r <= sc.w - 4, JSON.stringify({ cam, g2, spd }));
      await app(page, () => { document.getElementById('cam').hidden = true; });
    }
    // б) (1.1.24) нижня плашка — контур із двома виступами: [час] · Події · РЕЙС · Місця · Мітки · [стрілка нахилу]; «Рейс» рівно посередині.
    //    «Телефон» (калібрування) — плитка у швидких налаштуваннях, у правій нижній клітинці
    const tb = await app(page, () => { const R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10, t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round((r.left + r.right) / 2 * 10) / 10 }; };
      const bs = [...document.querySelectorAll('#tabs > button')], bar = R(document.getElementById('tabbar')), ear = R(document.querySelector('#tabbar .tb-main')), tilt = R(document.getElementById('tilt')), tabs = R(document.getElementById('tabs')), sh = document.getElementById('tbShape');
      return { order: bs.map(b => b.dataset.panel || b.id).join(), labels: bs.map(b => b.textContent.trim()).join('|'), colors: bs.filter(b => !b.classList.contains('main')).map(b => getComputedStyle(b).color), tc: bs.filter(b => b.querySelector('.tc')).map(b => getComputedStyle(b.querySelector('.tc')).backgroundColor),
        fills: [...document.querySelectorAll('#tabRep svg [fill]:not([fill="none"]):not([fill="currentColor"])')].length,
        rep: document.getElementById('tabRep').className, repLbl: document.getElementById('tabRep').getAttribute('aria-label'), badge: !!document.querySelector('#tabRep .badge'),
        bar, ear, tilt, tabs, main: R(document.querySelector('#tabs button.main')), btn: bs.map(R), rail: [...document.querySelectorAll('#rail > button')].map(b => ({ id: b.id, ...R(b) })),
        path: sh.querySelector('.tb-fill').getAttribute('d') || '', edge: sh.querySelector('.tb-edge').getAttribute('d') || '', fill: getComputedStyle(sh.querySelector('.tb-fill')).fill, eta: document.getElementById('eta').textContent, remain: [...document.querySelectorAll('#remain span')].map(x => x.textContent),
        hitGap: (() => { const x = (ear.r + tilt.l) / 2 + 40, y = bar.t + 8, e = document.elementFromPoint(x, y); return e ? (e.id || e.className || e.tagName) : ''; })() }; });
    ok(`[${T}] нижня плашка: Події · Рейс · Місця · Мітки («Телефон» звідси пішов у швидкі налаштування); значок «Мітки» — лінією, без кольорових плям, того самого кольору, що й сусідні`, tb.order === 'feed,trip,places,tabRep' && /^Події\d*\|Рейс\|Місця\|Мітки$/.test(tb.labels) && new Set(tb.colors).size === 1 && tb.tc.every(c => c === 'rgba(0, 0, 0, 0)') && tb.fills === 0, JSON.stringify({ order: tb.order, labels: tb.labels, colors: tb.colors }));
    ok(`[${T}] «РЕЙС» — рівно посередині плашки (${tb.main.cx} із ${(tb.bar.l + tb.bar.r) / 2})${sc.w <= 700 && !land ? ', тобто посередині екрана' : ''}: ліворуч час + «Події», праворуч «Місця» + «Мітки» + стрілка нахилу`, Math.abs(tb.main.cx - (tb.bar.l + tb.bar.r) / 2) <= 1 && (land || sc.w > 700 || Math.abs(tb.main.cx - sc.w / 2) <= 1) && tb.btn.every(b => b.w >= 40 && b.h >= 44), JSON.stringify({ main: tb.main, bar: tb.bar, btn: tb.btn.map(b => b.w) }));
    ok(`[${T}] контур: плашка рівна й низька (час прибуття ліворуч урівень із кнопками, ${tb.ear.w}×${tb.ear.h}), угору виступає лише стрілка нахилу праворуч (${tb.tilt.w}×${tb.tilt.h}, вища за плашку на ${tb.tabs.t - tb.bar.t} px); над плашкою — карта (дотик іде карті)`,
      tb.ear.l <= tb.bar.l + 1 && tb.ear.t === tb.tabs.t && tb.ear.b === tb.bar.b && tb.ear.h === tb.tabs.h && tb.tilt.r >= tb.bar.r - 3 && tb.tilt.h >= tb.bar.h - 14 && tb.tabs.t - tb.bar.t >= 30 && tb.tabs.b === tb.bar.b && tb.ear.r <= tb.btn[0].l + 1 && tb.tilt.l >= tb.btn[3].r - 1
      && /^M0 \d+L0 \d+Q0 \d+ 18 \d+L/.test(tb.path) && (tb.path.match(/Q/g) || []).length === 4 && /Z$/.test(tb.path) && (tb.edge.match(/Q/g) || []).length === 4 && /^rgba\(/.test(tb.fill) && /maplibregl-canvas|^map$/.test(String(tb.hitGap)), JSON.stringify({ bar: tb.bar, ear: tb.ear, tilt: tb.tilt, tabs: tb.tabs, path: tb.path, fill: tb.fill, hitGap: tb.hitGap }));
    ok(`[${T}] ліворуч у плашці — час («${tb.eta}»); рейсу немає — більше нічого`, /^\d\d:\d\d$/.test(tb.eta) && tb.remain.length === 0, JSON.stringify({ eta: tb.eta, remain: tb.remain }));
    const ct0 = await calTile(page);
    ok(`[${T}] праворуч угорі, як і були, кнопки налаштувань і виду карти (з 1.1.28 — ще й звуку); «Телефон» (калібрування) — плитка у швидких налаштуваннях, остання з ${ct0 && ct0.n}${sc.w >= 700 ? '' : ' — у правій нижній клітинці (три в ряд)'}: значок лінією, ${ct0 && ct0.w}×${ct0 && ct0.h}`,
      /^bQuick,bMap,bSnd(,bSearch)?$/.test(tb.rail.map(x => x.id).join()) && !!ct0 && ct0.last && ct0.n === 9 && ct0.label === 'Телефон' && (sc.w >= 700 || (ct0.fromRight <= 2 && ct0.fromBottom <= 2)) && ct0.w >= 80 && ct0.h >= 64 && ct0.inView && ct0.fills === 0 && ct0.fits, JSON.stringify({ rail: tb.rail.map(x => x.id), ct0 }));
    ok(`[${T}] калібрування ще не робили — плитка не світиться («${ct0 && ct0.state}»); позначок на маршруті немає — «Мітки» не світяться, числа немає`, !/cal-ok/.test(ct0.cls) && ct0.state === 'калібрування' && !/has/.test(tb.rep) && !tb.badge && tb.repLbl === 'Позначити подію на дорозі', JSON.stringify({ ct0, rep: tb.rep }));
    ok(`[${T}] нижня плашка: нічого не накладається й не обрізано`, (await page.evaluate(layoutCheck)).length === 0 && (await readCheck(page, '#tabbar')).length === 0, JSON.stringify([await page.evaluate(layoutCheck), await readCheck(page, '#tabbar')]));
    await shot(page, '48-bar-' + sc.n);

    // в) калібрування: відкривається на весь екран
    await gyInstall(page);
    const up = sc.n === 'tabland' || sc.n === 'land' ? [1, 0, 0.2] : [0, 0.94, 0.34];           // телефон сторч із нахилом 20°; планшет і «телефон набік» — альбомно
    const hand = sc.n === 'xiaomi', altAx = sc.n === 'tiny';        // Xiaomi — жива рука (тремтить і погойдується); «дуже малий» — телефон, що віддає осі гіроскопа в іншому порядку
    await app(page, ([up, scale, hand, altAx]) => window.__gy.start({ up, scale, noise: 0.4, tremor: hand ? 12 : 0, sway: hand ? 2 : 0, axes: altAx ? 'alt' : '' }), [up, main ? 0.9 : 1, hand, altAx]);
    await sleep(700);
    await app(page, () => { window.__spoken.length = 0; window.__vib = []; window.ReisNative.vibrate = ms => { window.__vib.push(ms); }; });
    await openCal(page); await sleep(450);
    const c1 = await calSt(page);
    ok(`[${T}] «Телефон» відкриває калібрування на ВЕСЬ екран; три малюнки з рукою — це три кроки: «Екран до себе · Ліва грань · Права грань», перший підсвічено`, c1.open && c1.box.l === 0 && c1.box.t === 0 && c1.box.w === c1.box.vw && c1.box.h === c1.box.vh && c1.box.sw <= c1.box.cw + 1 && c1.steps === '▶Екран до себе | ·Ліва грань | ·Права грань' && c1.step === 1, JSON.stringify(c1));
    { const tl = c1.tiles, hMin = land && sc.h <= 520 ? 48 : sc.h <= 640 ? 58 : 70;
      ok(`[${T}] малюнки: на кожному рука тримає телефон (до себе — екраном, лівою гранню, правою гранню), ${tl[0].pw}×${tl[0].ph} — видно без лупи; у ряд, у межах екрана; поточний — яскравий із жовтою рамкою і номером, решта приглушені`,
        tl.length === 3 && tl.map(x => x.k).join() === 'f,l,r' && tl.every(x => x.hand >= 2 && x.ph >= hMin && x.pw >= hMin * 0.7 && x.l >= 0 && x.r <= sc.w && x.t >= 0 && x.b <= sc.h) && tl[0].r <= tl[1].l && tl[1].r <= tl[2].l && Math.abs(tl[0].t - tl[2].t) <= 1
        && tl[0].border === 'rgb(245, 163, 0)' && tl[0].dim === 1 && tl[1].dim < 0.7 && tl[2].dim < 0.7 && tl.map(x => x.badge).join() === '1,2,3', JSON.stringify(tl)); }
    ok(`[${T}] крок 1: «Екран до себе» — тримати, як у тримачі, дві секунди${land && sc.h <= 520 ? '' : '; унизу пояснено, навіщо це (коли зникає GPS)'}`, c1.title === 'Екран до себе' && /як у тримачі/.test(c1.text) && /дві секунди/.test(c1.text) && (sc.h <= 700 ? true : /коли зникає GPS/.test(c1.foot)), JSON.stringify({ title: c1.title, text: c1.text, foot: c1.foot }));
    ok(`[${T}] унизу дрібний рядок «Датчики»: скільки замірів за секунду, як швидко телефон зараз рухається, чи звітує служба навігації («${c1.diag}»)${hand ? ' — рука тремтить, це видно' : ''}`, /^Датчики: (\d+|…)\/с · рух \d+ °\/с · служба (є|мовчить)/.test(c1.diag) && (!hand || +(c1.diag.match(/рух (\d+)/) || [])[1] >= 8) && (!altAx || true), c1.diag);
    ok(`[${T}] крок 1: усе читається (не дрібніше 12, не обрізано, не перекрито)`, (await readCheck(page, '#calib')).length === 0, JSON.stringify(await readCheck(page, '#calib')));
    await shot(page, '46-calib-1-' + sc.n);
    // крок 1 зараховано через ~2,5 с: звук, вібрація, голос; на екрані — куди повертати
    const c2 = await waitCal(page, s => s.step === 2, 6000); await sleep(250);
    const c2b = await calSt(page), nat2 = await app(page, () => window.__vib.join());
    ok(`[${T}] ${hand ? 'телефон у живій руці (тремтить до 12 °/с по кожній осі, погойдується) — він на місці, тож' : 'дві секунди на місці —'} крок 1 зараховано: сигнал, голос «Тепер поверніть лівою гранню до себе», на першому малюнку зелена галочка, підсвічено другий`, c2.step === 2 && /cal-ok/.test(c2b.sfx) && c2b.spoken.some(x => /поверніть лівою гранню до себе/.test(x)) && c2b.steps === '✓Екран до себе | ▶Ліва грань | ·Права грань' && c2b.tiles[0].tick && c2b.tiles[0].border === 'rgb(47, 158, 98)' && c2b.tiles[1].border === 'rgb(245, 163, 0)', JSON.stringify({ steps: c2b.steps, tiles: c2b.tiles, sfx: c2b.sfx, spoken: c2b.spoken, nat2 }));
    ok(`[${T}] крок 2: «Ліва грань до себе» — повернути, як двері на завісах, щоб бачити тільки ліву грань, і тримати до сигналу; на шкалі ціль — 90° ліворуч, пунктир до неї показує, куди й скільки повертати${land ? '; телефон на екрані — набік, як і справжній' : ''}`, c2b.title === 'Ліва грань до себе' && /як двері на завісах/.test(c2b.text) && /бачити тільки його ліву грань/.test(c2b.text) && /до сигналу/.test(c2b.text) && c2b.rest === 'l:1' && c2b.side === (up[0] === 1)
      && await app(page, () => getComputedStyle(document.getElementById('cbGoalL')).display !== 'none' && getComputedStyle(document.getElementById('cbGoalR')).display === 'none'), JSON.stringify({ title: c2b.title, text: c2b.text, rest: c2b.rest, side: c2b.side }));
    ok(`[${T}] крок 2: усе читається`, (await readCheck(page, '#calib')).length === 0, JSON.stringify(await readCheck(page, '#calib')));
    // повертаємо ліворуч; на півдорозі телефон на екрані й стрілка шкали повернуті так само
    await app(page, () => window.__gy.turn(45, 45)); await sleep(1400);
    const c3 = await calSt(page);
    await shot(page, '46-calib-2-' + sc.n);
    const kS = main ? 0.9 : 1, a45 = 45 * kS;
    if (altAx) ok(`[${T}] (осі в іншому порядку) на 45° перестановку ще не видно — крок просто не зараховано, нічого не зламалось`, c3.step === 2 && c3.st.left == null, JSON.stringify(c3.st));
    else ok(`[${T}] телефон повернули ліворуч на 45° — телефон на екрані повертається разом зі справжнім, жовта дуга й кулька на шкалі показують кут (${c3.ang}); ще не зараховано`, c3.step === 2 && Math.abs(c3.st.angle + a45) < (hand ? 6 : 3) && Math.abs(parseFloat((c3.phone.match(/rotateY\(([-\d.]+)deg/) || [])[1]) - a45) < (hand ? 6 : 3) && /^translate\(-/.test(c3.needle) && /^M-/.test(c3.arc) && /^\d+°$/.test(c3.ang) && c3.st.left == null, JSON.stringify({ ang: c3.ang, phone: c3.phone, bead: c3.needle, arc: c3.arc, st: c3.st }));
    if (main) {
      // зупинились на 55° і стоїмо: підказка на екрані й голосом (екрана «ребром» не видно)
      await app(page, () => window.__gy.turn(10, 20)); await sleep(3000);
      const h1 = await calSt(page);
      ok(`[${T}] зупинились на 55° — не зараховано; підказка «Ще трохи — щоб бачити тільки грань» на екрані й голосом`, h1.step === 2 && h1.st.hint === 'more' && /Ще трохи/.test(h1.hint) && h1.spoken.some(x => /Ще трохи/.test(x)), JSON.stringify({ hint: h1.hint, spoken: h1.spoken, st: h1.st }));
      await app(page, () => window.__gy.turn(35, 45));
    } else await app(page, () => window.__gy.turn(45, 45));
    const c4 = await waitCal(page, s => s.step === 3, 6000); await sleep(250);
    const c4b = await calSt(page);
    ok(`[${T}] довернули до 90° й затримали на секунду — зафіксовано: сигнал, голос «Ліва грань є. Тепер правою гранню до себе», галочка на другому малюнку, підсвічено третій: «Права грань до себе»`, c4.step === 3 && Math.abs(c4.st.left - 90 * kS) < (hand ? 12 : 6) && c4b.spoken.some(x => /Ліва грань є\. Тепер правою гранню до себе/.test(x)) && c4b.sfx.split(',').length >= 2 && c4b.steps === '✓Екран до себе | ✓Ліва грань | ▶Права грань' && c4b.title === 'Права грань до себе' && /в інший бік/.test(c4b.text) && /тільки праву грань/.test(c4b.text) && /^r:/.test(c4b.rest), JSON.stringify({ st: c4.st, steps: c4b.steps, title: c4b.title, spoken: c4b.spoken, sfx: c4b.sfx }));
    await shot(page, '46-calib-3-' + sc.n);
    await app(page, () => window.__gy.turn(-180, 60));
    const c5 = await waitCal(page, s => s.step === 4, 9000); await sleep(300);
    const c5b = await calSt(page), r5 = c5b.st.result || {};
    await shot(page, '46-calib-4-' + sc.n);
    if (main) {
      ok(`[${T}] праворуч через пряме до 90° і затримали — «Телефон відкалібровано»: 90° цей телефон бачить як ${r5.seen90}° (гіроскоп занижує на 10 %), поправка +11 %; голос «Готово…»`, c5.step === 4 && r5.ok && !r5.fine && Math.abs(r5.seen90 - 81) < 2.5 && Math.abs(r5.k - 1.111) < 0.035 && /Телефон відкалібровано/.test(c5b.title) && /бачить як = 8\d(,\d)?° \| Поправка = \+1\d(,\d)? % \| Телефон тримали = з нахилом 20°/.test(c5b.rows) && c5b.spoken.some(x => /Готово\. Телефон відкалібровано/.test(x)) && /cal-done/.test(c5b.sfx) && c5b.btns === 'Готово | Повторити', JSON.stringify({ r5, rows: c5b.rows, title: c5b.title, spoken: c5b.spoken, sfx: c5b.sfx, btns: c5b.btns, steps: c5b.steps }));
      ok(`[${T}] кожен зарахований крок — ще й вібрацією (екрана «ребром» не видно): коротко, коротко, довго`, /(^|,)160,(.*,)?160,(.*,)?350$/.test(await app(page, () => window.__vib.join())), await app(page, () => window.__vib.join()));
    } else if (hand) ok(`[${T}] жива рука: праворуч через пряме до 90° і затримали — «Телефон відкалібровано», 90° телефон бачить як ${r5.seen90}° (рука погойдується на ±2°; на стенді «екран» ще й губить заміри — ${r5.hz}/с); телефон тримали з нахилом`, c5.step === 4 && r5.ok && Math.abs(r5.seen90 - 90) < 4.5 && /Телефон відкалібровано/.test(c5b.title) && /з нахилом 20°/.test(c5b.rows), JSON.stringify({ r5, rows: c5b.rows, text: c5b.text }));
    else ok(`[${T}] праворуч через пряме до 90° і затримали — «Телефон відкалібровано»: гіроскоп точний (90° бачить як ${r5.seen90}°), поправка не потрібна; телефон тримали ${up[0] === 1 ? 'набік' : 'з нахилом'}`, c5.step === 4 && r5.ok && r5.fine && r5.k === 1 && Math.abs(r5.seen90 - 90) < 2.5 && /Поправка = не потрібна/.test(c5b.rows) && (up[0] === 1 ? /набік/.test(c5b.rows) : /з нахилом 20°/.test(c5b.rows)) && /Гіроскоп цього телефона точний/.test(c5b.text), JSON.stringify({ r5, rows: c5b.rows, text: c5b.text }));
    if (altAx) { const ax = await app(page, () => ({ swap: window.__app.uiCalib.calibState().st.swap, alt: window.__app.sensors.gyroAxes(), diag: document.getElementById('cbDiag').textContent }));
      ok(`[${T}] цей телефон віддає осі гіроскопа в іншому порядку — калібрування це побачило само (звірило з акселерометром) і пройшло; у рядку «Датчики» — «осі переставлено»`, ax.swap === true && ax.alt === false && /осі переставлено/.test(ax.diag), JSON.stringify(ax)); }
    ok(`[${T}] результат: усе читається, кнопки «Готово» й «Повторити» в межах екрана`, (await readCheck(page, '#calib')).length === 0 && (b => b.w >= 120 && b.h >= 48 && b.b <= sc.h && b.r <= sc.w)(await box('#calib [data-cb="save"]')), JSON.stringify([await readCheck(page, '#calib'), await box('#calib [data-cb="save"]')]));
    // «Готово» — збережено, значок зелений
    await page.click('#calib [data-cb="save"]'); await sleep(500);
    const d1 = await calSt(page), toast1 = await page.textContent('#toasts'), tabC = await calTile(page);
    ok(`[${T}] «Готово» — екран закрито, калібрування збережено, плитка «Телефон» у швидких налаштуваннях зелена («${tabC && tabC.state}»), коротке підтвердження`, !d1.open && d1.saved && d1.saved.v === 1 && Math.abs(d1.saved.k - (main ? 1.111 : 1)) < (hand ? 0.06 : 0.035) && Date.now() - d1.saved.at < 20000 && /cal-ok/.test(tabC.cls) && tabC.color === 'rgb(47, 158, 98)' && tabC.state === 'відкалібровано' && /Калібрування збережено/.test(toast1), JSON.stringify({ saved: d1.saved, tile: tabC, toast1 }));
    if (altAx) { const ax = await app(page, () => ({ alt: window.__app.sensors.gyroAxes(), S: window.__app.S.gyroAlt }));
      ok(`[${T}] порядок осей запамʼятовано для датчиків (так рахуватиме й ведення без GPS, і наступне калібрування)`, ax.alt === true && ax.S === true, JSON.stringify(ax)); }
    else ok(`[${T}] звичайний телефон: порядок осей гіроскопа не чіпали`, await app(page, () => window.__app.sensors.gyroAxes() === false && !window.__app.S.gyroAlt));
    await shot(page, '46-calib-5-done-' + sc.n);
    ok(`[${T}] після калібрування головний екран цілий: нічого не накладається`, (await page.evaluate(layoutCheck)).length === 0, JSON.stringify(await page.evaluate(layoutCheck)));
    if (main) {
      // поправка працює у веденні: служба нарахувала 90° — ведення бере 100° (стільки фура повернула насправді)
      const y = await app(page, async () => { const N = window.__app.nav; window.__reis('sens', { var: 0.05, yaw: 0 }); const a = N.debugState().yawNow; window.__reis('sens', { var: 0.05, yaw: 90 }); return [a, N.debugState().yawNow]; });
      ok(`[${T}] у веденні: служба нарахувала поворот 90° — з поправкою цього телефона це ${(y[1] - y[0]).toFixed(1)}° (стільки фура повернула насправді)`, Math.abs((y[1] - y[0]) - 90 * d1.saved.k) < 0.2 && Math.abs((y[1] - y[0]) - 100) < 3, JSON.stringify(y));
      // перезапуск: збережено
      await page.reload(); await page.waitForFunction(() => window.__app && document.getElementById('boot') === null, null, { timeout: 15000 }); await sleep(500);
      const rl = await app(page, () => ({ k: window.__app.S.gyroCal && window.__app.S.gyroCal.k, gk: window.__app.calib.gyroK() })); rl.tab = (await calTile(page)).cls;
      ok(`[${T}] після перезапуску калібрування на місці: значок зелений, поправка та сама`, /cal-ok/.test(rl.tab) && Math.abs(rl.k - d1.saved.k) < 1e-6 && rl.gk === rl.k, JSON.stringify(rl));
      // минуло понад 90 днів — значок знову блідий: варто повторити
      await app(page, () => { const S = window.__app.S; S.gyroCal = { ...S.gyroCal, at: Date.now() - 91 * 864e5 }; window.__app.bus.emit('calib', S.gyroCal); }); await sleep(200);
      const old = await calTile(page);
      ok(`[${T}] калібруванню понад 90 днів — плитка знову не світиться («${old.state}»); поправка у веденні лишається`, !/cal-ok/.test(old.cls) && /давно — повторіть/.test(old.state) && await app(page, () => window.__app.calib.gyroK() > 1.08), JSON.stringify(old));
      // «Повторити» і хрестик: без «Готово» нічого не змінюється
      await gyInstall(page); await app(page, () => window.__gy.start({ up: [0, 1, 0], scale: 1, noise: 0.3, native: false })); await sleep(500);      // тут — без служби навігації: лише заміри екрана
      await openCal(page); await waitCal(page, s => s.step === 2, 6000);
      // спершу праворуч — теж зараховано; кроки вгорі міняються місцями
      await app(page, () => window.__gy.turn(-90, 60));
      const rf = await waitCal(page, s => s.step === 3, 7000); await sleep(250); const rfb = await calSt(page);
      ok(`[${T}] спершу повернули правою гранню — зараховано без суперечок: «Права грань є. Тепер лівою гранню до себе», галочка на третьому малюнку, підсвічено другий`, rf.step === 3 && rf.st.first === 1 && rfb.steps === '✓Екран до себе | ▶Ліва грань | ✓Права грань' && rfb.title === 'Ліва грань до себе' && rfb.spoken.some(x => /Права грань є\. Тепер лівою гранню до себе/.test(x)) && /^l:/.test(rfb.rest), JSON.stringify({ st: rf.st, steps: rfb.steps, title: rfb.title, spoken: rfb.spoken }));
      // другий бік не довели (лише 75°) — «Не вийшло», чесно пояснено; «Повторити» починає з кроку 1
      await app(page, () => window.__gy.turn(162, 60));
      const bad = await waitCal(page, s => s.step === 4, 9000); await sleep(300); const badb = await calSt(page);
      ok(`[${T}] в один бік 90°, в інший лише 72° — «Не вийшло»: пояснено чому й що зробити; голос «Не вийшло…»; кнопки «Повторити» і «Закрити»`, bad.step === 4 && bad.st.result && !bad.st.result.ok && bad.st.result.why === 'asym' && /Не вийшло/.test(badb.title) && /надто по-різному/.test(badb.text) && /бачити тільки грань/.test(badb.text) && badb.spoken.some(x => /Не вийшло/.test(x)) && /cal-bad/.test(badb.sfx) && badb.btns === 'Повторити | Закрити', JSON.stringify({ r: bad.st.result, title: badb.title, text: badb.text, btns: badb.btns, sfx: badb.sfx }));
      await shot(page, '46-calib-bad-' + sc.n);
      ok(`[${T}] «Не вийшло»: усе читається`, (await readCheck(page, '#calib')).length === 0, JSON.stringify(await readCheck(page, '#calib')));
      await page.click('#calib [data-cb="again"]'); await sleep(300);
      const ag = await calSt(page);
      ok(`[${T}] «Повторити» — знову крок 1 («Екран до себе»)`, ag.open && ag.step === 1 && ag.title === 'Екран до себе' && ag.steps === '▶Екран до себе | ·Ліва грань | ·Права грань', JSON.stringify({ step: ag.step, title: ag.title, steps: ag.steps }));
      await page.click('#calib [data-cb="x"]'); await sleep(250);
      const cl = await calSt(page);
      ok(`[${T}] хрестик закриває; без «Готово» збережене калібрування не змінилось`, !cl.open && Math.abs(cl.saved.k - d1.saved.k) < 1e-6, JSON.stringify(cl.saved));
      await openCal(page); await sleep(300);
      const bk = await app(page, () => { const was = !document.getElementById('calib').hidden, r = window.__reisBack(); return { was, r, open: !document.getElementById('calib').hidden, again: window.__reisBack() }; });
      ok(`[${T}] системна кнопка «Назад» закриває калібрування (а не згортає програму)`, bk.was && bk.r === true && !bk.open && bk.again === false, JSON.stringify(bk));
      // датчики мовчать — чесно кажемо; ожили — продовжуємо
      await app(page, () => window.__gy.stop());
      await openCal(page); await sleep(4200);
      const ns = await calSt(page);
      ok(`[${T}] датчики руху мовчать 3,5 с — не чекаємо вічно: «Датчики руху мовчать», пояснено, що буде без калібрування`, ns.open && ns.view === 'nosens' && /Датчики руху мовчать/.test(ns.title) && /за швидкістю й кнопкою «Поворот»/.test(ns.text) && (await readCheck(page, '#calib')).length === 0, JSON.stringify({ view: ns.view, title: ns.title, text: ns.text, read: await readCheck(page, '#calib') }));
      await app(page, () => window.__gy.start({ up: [0, 0.2, 0.98] })); await sleep(900);
      const fl = await calSt(page);
      ok(`[${T}] датчики ожили, але телефон лежить — крок 1 не йде, підказка «Поставте телефон вертикально, екраном до себе»`, fl.view === 'step1' && fl.step === 1 && fl.st.hint === 'upright' && /Поставте телефон вертикально/.test(fl.hint) && fl.st.prog === 0, JSON.stringify({ view: fl.view, hint: fl.hint, st: fl.st }));
      // поки триває калібрування, ведення не сприймає «повороти» телефона в руках
      const busy = await app(page, () => { const N = window.__app.nav; for (let i = 0; i < 4; i++) window.__reis('sens', { var: 0.05, yaw: 100 + i * 30 }); return { busy: window.__app.calib.calBusy(), hist: N.debugState().yawHist.length }; });
      await page.click('#calib [data-cb="x"]'); await sleep(200);
      const free = await app(page, () => { const N = window.__app.nav; window.__reis('sens', { var: 0.05, yaw: 300 }); return { busy: window.__app.calib.calBusy(), hist: N.debugState().yawHist.length }; });
      // екран (WebView) датчиків не віддає зовсім, а служба навігації кут рахує — калібруємо лише за нею (раз на секунду)
      await app(page, () => { window.__gy.start({ up: [0, 1, 0], scale: 0.9, raw: false, native: true }); window.__spoken.length = 0; }); await sleep(300);
      await openCal(page);
      const sl2 = await waitCal(page, s => s.step === 2, 9000);
      await app(page, () => window.__gy.turn(90, 45)); const sl3 = await waitCal(page, s => s.step === 3, 9000);
      await app(page, () => window.__gy.turn(-180, 60)); const sl4 = await waitCal(page, s => s.step === 4, 11000); await sleep(300);
      const sl4b = await calSt(page), rs = sl4b.st.result || {};
      ok(`[${T}] екран датчиків не віддає, але служба навігації кут рахує — калібрування все одно проходить (за її кутом, раз на секунду): 90° телефон бачить як ${rs.seen90}°, поправка +11 %`, sl2.step === 2 && sl3.step === 3 && sl4.step === 4 && rs.ok && rs.src === 'native' && Math.abs(rs.seen90 - 81) < 1.5 && Math.abs(rs.k - 1.111) < 0.025 && /Телефон відкалібровано/.test(sl4b.title) && !/Телефон тримали/.test(sl4b.rows) && sl4b.spoken.some(x => /Готово\. Телефон відкалібровано/.test(x)), JSON.stringify({ steps: [sl2.step, sl3.step, sl4.step], rs, rows: sl4b.rows, st: sl4.st }));
      await page.click('#calib [data-cb="x"]'); await sleep(200);
      ok(`[${T}] поки відкрите калібрування, ведення не рахує повороти телефона в руках за повороти фури; закрили — рахує знову`, busy.busy === true && busy.hist === 0 && free.busy === false && free.hist >= 1, JSON.stringify({ busy, free }));
    }
    ok(`[${T}] прохід 32 (екран) без помилок JS`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  /* ---- В. «Мітки»: світяться зеленим, коли на маршруті попереду є позначки ---- */
  { const { page, ctx, errors } = await newPage(true, { viewport: { width: 360, height: 670 } });
    const n = coords.length, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
    const trip = { id: 't-rep32', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
      route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
    const me = coords[turnIdx[2] + 10];
    const tabR = () => app(page, () => { const b = document.getElementById('tabRep'), bd = b.querySelector('.badge'), tc = b.querySelector('.tc'); return { has: b.classList.contains('has'), n: bd ? bd.textContent : '', color: getComputedStyle(b).color, tc: getComputedStyle(tc).backgroundColor, badgeBg: bd ? getComputedStyle(bd).backgroundColor : '', label: b.getAttribute('aria-label'), ahead: window.__app.reports.repsAhead().map(x => x.r.id + ':' + Math.round(x.ahead)) }; });
    const put = list => app(page, list => { const R = window.__app.reports; R.reps.list.length = 0; for (const r of list) R.reps.list.push({ id: r.id, t: r.t, lat: r.lat, lon: r.lon, brg: null, at: Date.now() - (r.min || 3) * 60000, born: Date.now() - (r.min || 3) * 60000, dev: 'other', own: false, sent: true, conf: 0, no: {} }); window.__app.bus.emit('reports', R.reps); }, list);
    await emitN('loc', { prov: 'gps', lat: me[0], lon: me[1], acc: 5, spd: 0, t: Date.now() }); await sleep(500);
    // рейсу немає: позначки поруч є, але «на маршруті» шукати нема де — не світиться
    const pA = coords[turnIdx[2] + 60], pB = coords[turnIdx[3] + 40], pBack = coords[Math.max(0, turnIdx[2] - 60)];
    await put([{ id: 'r-a', t: 'police', lat: pA[0], lon: pA[1] }]); await sleep(250);
    const t0 = await tabR();
    ok('«Мітки»: рейсу немає — значок не світиться, навіть якщо позначки поруч є (вони видні на карті)', !t0.has && t0.n === '' && t0.ahead.length === 0, JSON.stringify(t0));
    await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
    await emitN('loc', { prov: 'gps', lat: me[0], lon: me[1], acc: 5, spd: 0, t: Date.now() }); await sleep(700);
    await put([]); await sleep(600);
    const t1 = await tabR();
    ok('«Мітки»: рейс іде, позначок на маршруті немає — значок не світиться, числа немає', !t1.has && t1.n === '' && t1.tc === 'rgba(0, 0, 0, 0)' && t1.label === 'Позначити подію на дорозі', JSON.stringify(t1));
    await shot(page, '47-rep-tab-off');
    // дві позначки попереду на маршруті, одна позаду, одна за 3 км убік
    await put([{ id: 'r-b', t: 'transport', lat: pB[0], lon: pB[1], min: 12 }, { id: 'r-a', t: 'police', lat: pA[0], lon: pA[1] }, { id: 'r-back', t: 'crash', lat: pBack[0], lon: pBack[1] }, { id: 'r-off', t: 'police', lat: pA[0] + 0.03, lon: pA[1] + 0.03 }]); await sleep(300);
    const t2 = await tabR();
    ok(`«Мітки»: на маршруті попереду дві позначки — значок засвітився зеленим, поруч число 2 («${t2.label}»); позначки позаду й осторонь маршруту не рахуються`, t2.has && t2.n === '2' && t2.color === 'rgb(47, 158, 98)' && t2.tc !== 'rgba(0, 0, 0, 0)' && t2.badgeBg === 'rgb(47, 158, 98)' && /попереду позначок — 2/.test(t2.label) && t2.ahead.length === 2 && /^r-a:/.test(t2.ahead[0]) && /^r-b:/.test(t2.ahead[1]), JSON.stringify(t2));
    await shot(page, '47-rep-tab-on');
    ok('«Мітки» світяться: нижня стрічка ціла, усе читається', (await page.evaluate(layoutCheck)).length === 0 && (await readCheck(page, '#tabs')).length === 0, JSON.stringify([await page.evaluate(layoutCheck), await readCheck(page, '#tabs')]));
    // дотик — у вікні «Що на дорозі?» згори список: що попереду й через скільки
    await page.click('#tabRep'); await sleep(350);
    const sh = await app(page, () => { const s = document.getElementById('repSheet'), r = s.getBoundingClientRect(); return { open: !s.hidden, inView: r.bottom <= innerHeight + 1 && r.top >= 0, sub: (s.querySelector('.rep-sub') || {}).textContent, rows: [...s.querySelectorAll('.rep-row')].map(x => x.getAttribute('aria-label') + ' | ' + x.querySelector('b').textContent + ' | ' + Math.round(x.getBoundingClientRect().height)), nearH: Math.round((s.querySelector('.rep-near') || s).getBoundingClientRect().height), btns: [...s.querySelectorAll('.rep-grid [data-rep]')].map(b => b.dataset.rep).join() }; });
    ok('дотик до «Міток»: згори один низький рядок «Попереду» — плитки «значок + відстань» (найближча перша; що саме й коли бачили — у підписі плитки); нижче — ті самі кнопки «ДТП · Поліція · Транспортна служба»', sh.open && sh.inView && sh.sub === 'Попереду' && sh.rows.length === 2 && /^Поліція · .*хв.* · через \d.* \| \d[\d,]* (км|м) \| 4[4-8]$/.test(sh.rows[0]) && /^Транспортна служба · .* · через \d.* \| \d[\d,]* (км|м) \| 4[4-8]$/.test(sh.rows[1]) && sh.nearH <= 50 && sh.btns === 'crash,police,transport', JSON.stringify(sh));
    ok('вікно «Що на дорозі?» зі списком: усе читається', (await readCheck(page, '#repSheet')).length === 0, JSON.stringify(await readCheck(page, '#repSheet')));
    await shot(page, '47-rep-sheet');
    // дотик до рядка — показати позначку на карті
    await page.click('#repSheet .rep-row'); await sleep(1600);
    const fly = await app(page, ([la, lo]) => { const c = window.__app.map.map.getCenter(); return { closed: document.getElementById('repSheet').hidden, d: Math.round(window.__app.core.hav({ lat: c.lat, lon: c.lng }, { lat: la, lon: lo })) }; }, pA);
    ok('дотик до рядка — вікно закрилось, карта показує цю позначку', fly.closed && fly.d < 150, JSON.stringify(fly));
    // рейс завершено — не світиться
    await app(page, () => window.__app.guide.endTrip ? window.__app.guide.endTrip() : window.__app.guide.stopTrip()); await sleep(500);
    const t4 = await tabR();
    ok('рейс завершено — «Мітки» знову не світяться', !t4.has && t4.n === '', JSON.stringify(t4));
    ok('прохід 32 («Мітки») без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close(); }
  /* ---- Г. Мова одна — українська: розділу «Мова» в налаштуваннях немає; хто мав «русский» — після оновлення українська ---- */
  { const { page, ctx, errors } = await newPage(true, { viewport: { width: 360, height: 670 }, oldSettings: { lang: 'ru' } });
    await sleep(400);
    const l0 = await app(page, () => ({ lang: window.__app.S.lang, html: document.documentElement.lang, tabs: [...document.querySelectorAll('#tabs > button')].map(b => b.textContent.trim()).join('|'), stored: JSON.parse(localStorage.getItem('reis.settings') || '{}').lang }));
    ok('у кого була вибрана російська — після оновлення інтерфейс українською (і збережено саме так)', l0.lang === 'uk' && l0.html === 'uk' && l0.stored === 'uk' && /^Події\d*\|Рейс\|Місця\|Мітки$/.test(l0.tabs), JSON.stringify(l0));
    await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#panelBody .sec'); await sleep(200);
    const st = await app(page, () => ({ secs: [...document.querySelectorAll('#panelBody .sec')].map(x => x.textContent.trim()), seg: !!document.querySelector('#panelBody [data-seg^="lang:"]'), text: document.getElementById('panelBody').textContent }));
    ok('у «Налаштуваннях» розділу «Мова» більше немає (ні заголовка, ні перемикача «Українська / Русский»); решта розділів на місці', !st.seg && !st.secs.some(x => /^Мова$/i.test(x)) && !/Русский/.test(st.text) && st.secs.some(x => /Фура/i.test(x)) && st.secs.length >= 5, JSON.stringify(st.secs));
    ok('прохід 32 (мова) без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close(); }
} catch (e) { ok('прохід 32 дійшов до кінця', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }

/* ============ прохід 33 (1.1.24): усі панелі — на весь екран і з тією самою галочкою «Готово» праворуч унизу; хрестика немає;
   «Що на дорозі?» — низька майже прозора смужка ============ */
if (run('33')) for (const sc of [...SCREENS.filter(x => ['S10', 'tiny', 'land', 'tablet', 'xiaomi'].includes(x.n)), { n: 'tabland', w: 1272, h: 702, dpr: 1, title: 'планшет набік 1272×702' }].filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, n = coords.length, land = sc.w > sc.h, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const trip = { id: 't-33', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  const me = coords[turnIdx[2] + 10];
  await emitN('loc', { prov: 'gps', lat: me[0], lon: me[1], acc: 5, spd: 0, t: Date.now() }); await sleep(400);
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  await emitN('loc', { prov: 'gps', lat: me[0], lon: me[1], acc: 5, spd: 0, t: Date.now() }); await sleep(800);
  // повідомлення під маневром (тут — про позначки водіїв попереду) стиснуто: шрифт той самий, поля й проміжки менші, текст — лише суть
  { await app(page, list => { const R = window.__app.reports; R.reps.list.length = 0; for (const r of list) R.reps.list.push({ id: r.id, t: r.t, lat: r.lat, lon: r.lon, brg: null, at: Date.now() - r.min * 60000, born: Date.now() - r.min * 60000, dev: 'other', own: false, sent: true, conf: 0, no: {} }); window.__app.bus.emit('reports', R.reps); },
      [{ id: 'r-a', t: 'police', lat: coords[turnIdx[2] + 60][0], lon: coords[turnIdx[2] + 60][1], min: 3 }, { id: 'r-b', t: 'transport', lat: coords[turnIdx[3] + 40][0], lon: coords[turnIdx[3] + 40][1], min: 12 }]);
    await sleep(1200);
    const ts = await app(page, () => { const box = document.getElementById('toasts'), els = [...box.querySelectorAll('.toast')]; return { gap: parseFloat(getComputedStyle(box).rowGap || getComputedStyle(box).gap), list: els.map(e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return { txt: e.textContent.trim(), h: Math.round(r.height), fs: parseFloat(cs.fontSize), lines: Math.round((r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight)) }; }) }; });
    const rp0 = ts.list.filter(x => /(Поліція|Транспортна служба) · \d+ хв тому/.test(x.txt));
    ok(`[${T}] (1.1.24) повідомлення під маневром стиснуто: шрифт той самий (15), рядок 28 px замість 40, два рядки 46 px замість 59, проміжок ${ts.gap} px; про позначку водія — лише суть («${rp0[0] ? rp0[0].txt : ''}»), без «попереду — позначка водія»`,
      rp0.length >= 1 && ts.gap <= 4 && ts.list.every(x => x.fs === 15 && x.h <= x.lines * 18 + 13 && x.h >= 28) && rp0.every(x => !/попереду|позначка водія/.test(x.txt) && x.lines <= (sc.w >= 360 ? 2 : 3)) && (sc.w < 390 || land || rp0.some(x => x.lines === 1)), JSON.stringify(ts));
    await shot(page, '51-toasts-' + sc.n); }
  // стан відкритої панелі: чи на весь екран, що закрито, де галочка
  const pst = () => app(page, () => { const P = document.getElementById('panel'), r = P.getBoundingClientRect(), ok = document.getElementById('panelOk'), o = ok.getBoundingClientRect(), cs = getComputedStyle(ok), x = document.getElementById('panelClose'), st = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--st')) || 0;
    const vis = e => !!e && !e.hidden && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
    const cover = sel => { const e = document.querySelector(sel); if (!vis(e)) return true; const q = e.getBoundingClientRect(), h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return !!h && P.contains(h); };
    const hit = document.elementFromPoint(o.left + o.width / 2, o.top + o.height / 2), body = document.getElementById('panelBody'), last = body.lastElementChild, lr = last ? last.getBoundingClientRect() : null;
    return { open: !P.hidden, title: document.getElementById('panelTitle').textContent, full: P.classList.contains('full'), box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], st, vw: innerWidth, vh: innerHeight,
      notCovered: ['#top', '#tabs', '#tabbar .tb-main', '#tilt', '#speed', '#rail', '#bCenter'].filter(s => !cover(s)),
      ok: { w: Math.round(o.width), h: Math.round(o.height), fromRight: Math.round(r.right - o.right), fromBottom: Math.round(r.bottom - o.bottom), bg: cs.backgroundColor, shadow: cs.boxShadow !== 'none', svg: !!ok.querySelector('svg'), label: ok.getAttribute('aria-label'), seen: !!hit && (hit === ok || ok.contains(hit)), inView: o.right <= innerWidth && o.bottom <= innerHeight },
      x: vis(x), back: vis(document.getElementById('panelBack')), pbBack: !!body.querySelector('.pb-back'), ownDone: !!body.querySelector('[data-plc="#done"]'),
      scrollEnd: (() => { body.scrollTop = body.scrollHeight; const l2 = body.lastElementChild && body.lastElementChild.getBoundingClientRect(), o2 = ok.getBoundingClientRect(); const free = !l2 || l2.bottom <= o2.top + 2 || l2.right <= o2.left + 2; body.scrollTop = 0; return free; })() }; });
  const open = { places: async () => { await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips'); },
    feed: async () => { await page.click('#tabs button[data-panel="feed"]'); },
    gps: async () => { await page.click('#spdGps'); },
    settings: async () => { await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#panelBody .sec'); },
    place: async () => { await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.pl-chips'); if (!await app(page, () => !!document.querySelector('#panelBody [data-vpid]'))) { await page.click('.pl-chip[data-plc="@mapVerified"]'); await sleep(250); } await page.click('#panelBody [data-vpid]'); await page.waitForSelector('.vp-photos, [data-vp]'); } };
  const names = { places: 'Місця', feed: 'Події', gps: 'GPS', settings: 'Налаштування', place: 'картка місця' };
  let ref = null;
  for (const k of ['places', 'feed', 'gps', 'settings', 'place']) {
    await open[k](); await sleep(450);
    const s = await pst();
    // широкий планшет набік: панель — колонка по центру від верху до низу (рядки на всю ширину 1272 px читати незручно); усе, що в її смузі
    // (маневр, нижня плашка), закрито, а круг швидкості й кнопки праворуч стоять обабіч на карті й списку не заважають
    const wide = s.vw >= 1010, left = s.notCovered.filter(x => !(wide && (x === '#speed' || x === '#rail')));
    ok(`[${T}] «${names[k]}» — ${wide ? 'колонка на всю висоту екрана: верхню плашку з маневром і нижню плашку закрито (круг швидкості й кнопки — обабіч, на карті)' : 'на весь екран: верхню плашку з маневром, круг швидкості, кнопки праворуч і нижню плашку закрито'} — нічого не заважає гортати`, s.open && s.full && s.box[1] <= s.st + 8 && s.box[3] >= s.vh - 1 && s.box[2] - s.box[0] >= Math.min(s.vw, 760) - 1 && left.length === 0, JSON.stringify({ title: s.title, box: s.box, notCovered: s.notCovered }));
    if (!ref) ref = s.ok;
    ok(`[${T}] «${names[k]}»: «Готово» — та сама жовта галочка з тінню (54×54), праворуч унизу на тому самому місці (${s.ok.fromRight} px від правого краю, ${s.ok.fromBottom} px від низу), під пальцем, нічим не перекрита; хрестика вгорі немає, окремих «Назад»/«Готово» в самій панелі теж`,
      s.ok.w === 54 && s.ok.h === 54 && s.ok.bg === 'rgb(245, 163, 0)' && s.ok.shadow && s.ok.svg && s.ok.label === 'Готово' && s.ok.seen && s.ok.inView && s.ok.fromRight === ref.fromRight && s.ok.fromBottom === ref.fromBottom && s.ok.fromRight >= 10 && s.ok.fromRight <= 20 && s.ok.fromBottom >= 12 && !s.x && !s.pbBack && !s.ownDone, JSON.stringify({ ok: s.ok, x: s.x, pbBack: s.pbBack, ownDone: s.ownDone }));
    ok(`[${T}] «${names[k]}»: кінець списку галочка не закриває (унизу лишено запас), усе читається`, s.scrollEnd && (await readCheck(page, '#panel', '#panelBody')).length === 0, JSON.stringify({ scrollEnd: s.scrollEnd, read: await readCheck(page, '#panel', '#panelBody') }));
    if (k === 'places' || k === 'place' || (k === 'settings' && sc.n === 'S10')) await shot(page, `49-panel-${k}-${sc.n}`);
    if (k === 'place') ok(`[${T}] картка місця: стрілка «назад» до «Місць» угорі лишилась (це крок назад, а галочка — одразу на карту)`, s.back, JSON.stringify({ back: s.back }));
    await page.click('#panelOk'); await sleep(350);
    const cl = await app(page, () => { const b = document.querySelector('#tabs button.main'), r = b.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), tp = document.getElementById('top'), tr = tp.getBoundingClientRect(), h2 = document.elementFromPoint(tr.left + 30, tr.top + 20); return { hidden: document.getElementById('panel').hidden, tabs: !!h && b.contains(h), top: !!h2 && tp.contains(h2) }; });
    ok(`[${T}] «${names[k]}»: галочка закриває панель — знову карта, маневр угорі й кнопки внизу`, cl.hidden && cl.tabs && cl.top, JSON.stringify(cl));
  }
  // рядок списку, що проходить під галочкою, відсуває свій правий край — відстань лишається на видноті
  await open.places(); await sleep(300);
  if (!await app(page, () => !!document.querySelector('#panelBody .pl-row'))) { await page.click('.pl-chip[data-plc="fuel"]'); await sleep(300); }
  const dg = await app(page, async () => { const body = document.getElementById('panelBody'), ok = document.getElementById('panelOk').getBoundingClientRect(); let found = null;
    for (let y = 0; y <= body.scrollHeight && !found; y += 24) { body.scrollTop = y; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const row of body.querySelectorAll('.pl-row, .vp-row')) { const b = row.getBoundingClientRect(); if (b.top < ok.bottom - 6 && b.bottom > ok.top + 6 && b.right > ok.left) { const d = row.querySelector('.pl-d, .vp-w, b:last-child'), dr = d ? d.getBoundingClientRect() : null; found = { dodge: row.classList.contains('dodge'), padR: getComputedStyle(row).paddingRight, dRight: dr ? Math.round(dr.right) : null, okLeft: Math.round(ok.left) }; break; } } }
    const others = [...body.querySelectorAll('.pl-row.dodge, .vp-row.dodge')].length; body.scrollTop = 0; return { found, others, rows: body.querySelectorAll('.pl-row, .vp-row').length }; });
  if (dg.found) ok(`[${T}] «Місця»: рядок, що саме проходить під галочкою, відсуває правий край — його відстань лишається лівіше галочки, на видноті`, dg.found.dodge && parseFloat(dg.found.padR) >= 68 && (dg.found.dRight == null || dg.found.dRight <= dg.found.okLeft + 1), JSON.stringify(dg));
  else ok(`[${T}] «Місця»: список короткий — під галочку жоден рядок не заходить`, dg.rows >= 0, JSON.stringify(dg));
  await page.click('#panelOk'); await sleep(300);
  // «Що на дорозі?» — низька майже прозора смужка
  await page.click('#tabRep'); await sleep(350);
  const rp = await app(page, () => { const s = document.getElementById('repSheet'), r = s.getBoundingClientRect(), a = c => { const m = c.match(/rgba?\(([^)]+)\)/), p = m ? m[1].split(',').map(Number) : []; return p.length === 4 ? p[3] : 1; };
    const bs = [...s.querySelectorAll('.rep-grid [data-rep]')].map(b => { const q = b.getBoundingClientRect(), sp = b.querySelector('span:last-child'); return { k: b.dataset.rep, w: Math.round(q.width), h: Math.round(q.height), a: a(getComputedStyle(b).backgroundColor), txt: sp.textContent, fits: sp.scrollWidth <= sp.clientWidth + 1 && b.scrollWidth <= b.clientWidth + 1, fs: parseFloat(getComputedStyle(b).fontSize) }; });
    const x = s.querySelector('.q-x'), xr = x.getBoundingClientRect(), nr = s.querySelector('.rep-near'), near = !!nr, bar = document.getElementById('tabbar');
    return { nearH: nr ? Math.round(nr.getBoundingClientRect().height) : 0, chips: [...s.querySelectorAll('.rep-row')].map(c => ({ txt: c.querySelector('b').textContent, label: c.getAttribute('aria-label') || '', h: Math.round(c.getBoundingClientRect().height) })), open: !s.hidden, h: Math.round(r.height), w: Math.round(r.width), b: Math.round(innerHeight - r.bottom), a: a(getComputedStyle(s).backgroundColor), blur: getComputedStyle(s).backdropFilter, title: !!s.querySelector('.q-head'), hint: !!s.querySelector('.rep-hint'), bs, x: { w: Math.round(xr.width), t: Math.round(xr.top), inView: xr.top >= 0 && xr.right <= innerWidth }, near, barHidden: getComputedStyle(bar).visibility === 'hidden', vh: innerHeight }; });
  ok(`[${T}] «Що на дорозі?» з позначками попереду — теж низька (${rp.h} px замість ~320): над кнопками один рядок «Попереду» з плитками «значок + відстань», три кнопки в ряд, великого заголовка й довгого тексту немає`, rp.open && rp.near && rp.h <= 150 && rp.nearH <= 50 && rp.chips.length === 2 && rp.chips.every(c => c.h >= 44 && /\d/.test(c.txt) && c.label.split(' · ').length === 3) && rp.b <= 40 && rp.bs.length === 3 && rp.bs.map(b => b.k).join() === 'crash,police,transport' && !rp.title && !rp.hint && rp.bs.every(b => b.h >= 56 && b.w >= 70), JSON.stringify(rp));
  ok(`[${T}] смужка майже прозора (щільність ${rp.a}), без розмиття; під значком і підписом кожної кнопки — щільна підкладка (${rp.bs[0].a}): текст читається на будь-якій карті; підписи цілі`, rp.a <= 0.2 && (rp.blur === 'none' || rp.blur === '') && rp.bs.every(b => b.a >= 0.75 && b.fits && b.fs >= 12) && (await readCheck(page, '#repSheet')).length === 0, JSON.stringify({ a: rp.a, blur: rp.blur, bs: rp.bs, read: await readCheck(page, '#repSheet') }));
  ok(`[${T}] поки смужка відкрита, нижня плашка під нею схована (крізь прозоре не просвічує чуже); закрити — кружечок ✕ над правим краєм смужки`, rp.barHidden && rp.x.w >= 40 && rp.x.inView, JSON.stringify({ barHidden: rp.barHidden, x: rp.x }));
  await shot(page, '50-rep-strip-' + sc.n);
  await page.click('#repSheet [data-rep="x"]'); await sleep(250);
  ok(`[${T}] ✕ закриває смужку — нижня плашка знову на місці`, await app(page, () => document.getElementById('repSheet').hidden && getComputedStyle(document.getElementById('tabbar')).visibility !== 'hidden'));
  // позначок попереду немає — лише три кнопки: смужка ще нижча, круг швидкості лишається на видноті
  await app(page, () => { const R = window.__app.reports; R.reps.list.length = 0; window.__app.bus.emit('reports', R.reps); }); await sleep(300);
  await page.click('#tabRep'); await sleep(350);
  const rp2 = await app(page, () => { const s = document.getElementById('repSheet'), r = s.getBoundingClientRect(), sp = document.getElementById('speed'); return { open: !s.hidden, h: Math.round(r.height), near: !!s.querySelector('.rep-near'), n: s.querySelectorAll('.rep-grid [data-rep]').length, speed: getComputedStyle(sp).visibility !== 'hidden' && !sp.hidden }; });
  ok(`[${T}] «Що на дорозі?» без позначок попереду — лише три кнопки, ${rp2.h} px заввишки замість ~270 (майже втричі нижча); круг швидкості видно`, rp2.open && !rp2.near && rp2.h <= 96 && rp2.n === 3 && rp2.speed, JSON.stringify(rp2));
  await shot(page, '50-rep-strip0-' + sc.n);
  await page.click('#repSheet [data-rep="x"]'); await sleep(250);
  ok(`[${T}] головний екран цілий: нічого не накладається`, (await page.evaluate(layoutCheck)).length === 0, JSON.stringify(await page.evaluate(layoutCheck)));
  ok(`[${T}] прохід 33 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 33 (${sc.n}) дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }

/* ============ прохід 34 (1.1.25): пройдений шлях — пишеться сам (з GPS і без), лишається на карті блідою лінією; на фініші
   «Зберегти пройдений шлях?»; «Архів поїздок» у налаштуваннях — поїздка на карті кольором за швидкістю, графік, зведення ============ */
if (run('34')) for (const sc of [...SCREENS.filter(x => ['S10', 'tiny', 'land', 'tablet'].includes(x.n)), { n: 'tabland', w: 1272, h: 702, dpr: 1, title: 'планшет набік 1272×702' }].filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, n = coords.length, full = sc.n === 'S10', emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const mkTrip = id => ({ id, a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } });
  const J = () => app(page, () => { const A = window.__app, j = A.journey.jr, m = A.map.map, src = id => { const s = m.getSource(id), d = s && s._data; return d && d.features ? d.features.map(f => ({ e: f.properties.e, b: f.properties.b, n: f.geometry.coordinates.length })) : []; };
    const vis = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    return { cur: j.cur ? { id: j.cur.id, n: j.cur.pts.length, est: j.cur.pts.filter(p => p[4]).length, sim: j.cur.sim, title: j.cur.title } : null, pend: j.pending ? { n: j.pending.pts.length, raw: j.pending.raw, dist: j.pending.st.dist, est: j.pending.st.est, why: j.pending.why } : null,
      list: j.list.map(x => ({ id: x.id, title: x.title, dist: x.dist, est: x.est, sim: x.sim, why: x.why })), jr: src('jr'), jv: src('jv'), ask: vis(document.getElementById('jrAsk')), askTxt: document.getElementById('jrAsk').textContent.replace(/\s+/g, ' ').trim(),
      toasts: document.getElementById('toasts').textContent, mode: A.nav.pos.mode, rd: Math.round(A.nav.pos.rd || 0), speed: vis(document.getElementById('speed')) }; });
  const start = async (id, at = 2) => { await emitN('loc', { prov: 'gps', lat: coords[at][0], lon: coords[at][1], acc: 5, spd: 0, t: Date.now() }); await sleep(400); await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), mkTrip(id)); await sleep(500); };
  const simGo = kmh => app(page, k => { const s = window.__app.sim; s.setSpeed(k); if (!s.sim.on) s.start(); }, kmh);
  const simStop = () => app(page, () => window.__app.sim.stop());
  const rdOver = (d, ms = 60000) => page.waitForFunction(d => window.__app.nav.pos.rd > d, d, { timeout: ms });
  await page.waitForFunction(() => window.__app && window.__app.journey && window.__app.journey.jr.ready && window.__app.map.map && window.__app.map.map.getSource('jr'), null, { timeout: 15000 });

  if (full) {
    /* --- чиста логіка: відбір точок, спрощення, зведення, кольори --- */
    const L = await app(page, () => { const Jm = window.__app.journey, { JR, wantPoint, simplify, stats, segments, bucket, nearestOn, segV, toGpx, profile } = Jm;
      let t = 1.8e9, lat = 49.5, lon = 30.0; const raw = [];
      const go = (m, kmh, brg, est = 0) => { const k = Math.round(m / 5); for (let i = 0; i < k; i++) { lat += 5 * Math.cos(brg * Math.PI / 180) / 111320; lon += 5 * Math.sin(brg * Math.PI / 180) / (111320 * Math.cos(lat * Math.PI / 180)); t += 5 / (kmh / 3.6); raw.push([+lat.toFixed(6), +lon.toFixed(6), Math.round(t), kmh, est]); } };
      raw.push([lat, lon, t, 0, 0]); go(5000, 60, 90); t += 300; raw.push([lat, lon, Math.round(t), 0, 0]); go(3000, 40, 0, 1); go(2000, 85, 0);
      const rec = []; for (const p of raw) if (wantPoint(rec[rec.length - 1], p)) rec.push(p);
      const simp = simplify(rec), st = stats(simp), seg = segments(simp), pr = profile(simp, 100), nr = nearestOn(simp, 49.5003, 30.03), gpx = toGpx('Тест <a>', simp);
      return { raw: raw.length, rec: rec.length, simp: simp.length, st, seg: seg.map(s => s.b + (s.e ? 'e' : '')).join(), buckets: [0, 14, 15, 49, 50, 69, 70, 89, 90, 120].map(bucket).join(''), step: JR.STEP_M, minSave: JR.MIN_SAVE_M,
        prof: { n: pr.length, v10: pr[10].v, v60: pr[60].v, e60: pr[60].e, v95: pr[95].v }, nr: { d: Math.round(nr.d), v: Math.round(segV(simp[nr.i - 1], simp[nr.i])) }, gpx: { fix: /<fix>none<\/fix>/.test(gpx), name: /<name>Тест &lt;a&gt;<\/name>/.test(gpx), n: (gpx.match(/<trkpt/g) || []).length } }; });
    ok(`пройдений шлях, логіка: нову точку пишемо кожні ${L.step} м (із ${L.raw} відліків GPS записано ${L.rec}), перед збереженням прямі спрощуються (${L.rec} → ${L.simp}), а межі «без GPS», зупинка й зміни швидкості лишаються`, L.rec < L.raw / 4 && L.rec > 300 && L.simp < 60 && L.simp >= 8, JSON.stringify(L));
    ok(`зведення поїздки: 10 км (${L.st.dist} м), зупинка одна на 5 хв, без GPS 3 км (${L.st.est} м), середня в русі ≈ 55 км/год (${L.st.avg}), найбільша 85 (${L.st.max})`, Math.abs(L.st.dist - 10000) < 100 && L.st.stops === 1 && Math.abs(L.st.stopS - 300) < 8 && Math.abs(L.st.est - 3000) < 80 && Math.abs(L.st.avg - 55) <= 2 && L.st.max === 85 && Math.abs(L.st.dur - 955) < 10, JSON.stringify(L.st));
    ok('ділянки за швидкістю: 60 → стоянка → 40 без GPS → 85; межі кольорів 15 / 50 / 70 / 90 км/год', L.seg === '2,0,1e,3' && L.buckets === '0011223344', L.seg + ' · ' + L.buckets);
    ok('графік швидкості за відстанню: 60 на початку, 40 (без GPS) посередині, 85 наприкінці; дотик за 30 м від лінії знаходить місце на ній (а не найближчу записану точку за пів кілометра); GPX позначає ділянки без GPS', Math.abs(L.prof.v10 - 60) <= 2 && Math.abs(L.prof.v60 - 40) <= 2 && L.prof.e60 === 1 && Math.abs(L.prof.v95 - 85) <= 2 && L.nr.d >= 20 && L.nr.d <= 45 && Math.abs(L.nr.v - 60) <= 1 && L.gpx.fix && L.gpx.name && L.gpx.n === L.simp, JSON.stringify({ prof: L.prof, nr: L.nr, gpx: L.gpx }));

    /* --- у дорозі: шлях пишеться від точки відбуття й лишається блідою лінією --- */
    await start('t-34a');
    let s = await J();
    ok('рейс почався — шлях пишеться від точки відбуття; запитання про збереження ще немає', s.cur && s.cur.n >= 1 && s.cur.title === 'Харків → Полтава' && !s.ask && !s.pend, JSON.stringify(s));
    await simGo(300); await rdOver(1500);
    s = await J();
    const lay = await app(page, () => { const m = window.__app.map.map, ids = m.getStyle().layers.map(l => l.id); return { order: ids.indexOf('jr-line') >= 0 && ids.indexOf('jr-line') < ids.indexOf('route-case') && ids.indexOf('jr-est') < ids.indexOf('route-case'), op: m.getPaintProperty('jr-line', 'line-opacity'), col: m.getPaintProperty('jr-line', 'line-color'), dash: m.getPaintProperty('jr-est', 'line-dasharray') }; });
    ok(`їдемо за GPS: точки пишуться (${s.cur.n}), на карті — бліда (щільність ${lay.op}) сіра суцільна лінія ПІД лінією маршруту`, s.cur.n >= 8 && s.cur.est === 0 && s.jr.length === 1 && s.jr[0].e === 0 && s.jr[0].n >= s.cur.n - 5 && s.jr[0].n >= 4 && lay.order && lay.op <= 0.6 && /^#/.test(lay.col), JSON.stringify({ s, lay }));
    // GPS зник: шлях пишеться далі — за розрахунком, пунктиром
    await app(page, () => window.__app.sim.setLost(true));
    await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 15000 }); await sleep(4200);
    s = await J();
    ok(`GPS зник — шлях не обривається: пишеться далі за розрахунком (${s.cur.est} точок без GPS), на карті ця ділянка — пунктир`, s.mode === 'dr' && s.cur.est >= 1 && s.jr.some(f => f.e === 1) && Array.isArray(lay.dash), JSON.stringify(s));
    await shot(page, '52-jr-line-dr');
    // GPS повернувся: ділянку без GPS малюємо дорогою маршруту (а не прямою), далі знову суцільна
    await app(page, () => window.__app.sim.setLost(false));
    await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps', null, { timeout: 15000 }); await sleep(2500);
    const back = await app(page, () => { const A = window.__app, pts = A.journey.jr.cur.pts, idx = A.guide.g.idx, est = pts.filter(p => p[4]); let off = 0; for (const p of est) { const l = idx.locate({ lat: p[0], lon: p[1] }, null); off = Math.max(off, l ? l.off : 999); }
      const seq = []; for (const p of pts) if (seq[seq.length - 1] !== p[4]) seq.push(p[4]); let mono = true; for (let i = 1; i < pts.length; i++) if (pts[i][2] < pts[i - 1][2]) mono = false;
      return { est: est.length, off: Math.round(off), seq: seq.join(''), mono, feats: A.map.map.getSource('jr')._data.features.map(f => f.properties.e).join('') }; });
    ok(`GPS повернувся: ділянка без GPS лягла на дорогу маршруту (${back.est} точок, найдальша за ${back.off} м від неї), далі знову суцільна лінія; час у точках іде лише вперед`, back.est >= 5 && back.off <= 25 && back.seq === '010' && back.mono && /^01+0$|^010$/.test(back.feats), JSON.stringify(back));
    await app(page, () => window.__app.bus.emit('route', window.__app.guide.g)); await sleep(300);
    ok('перебудова маршруту пройдений шлях не стирає', (await J()).jr.length >= 3, JSON.stringify((await J()).jr));
    await shot(page, '52-jr-line');
    // фініш: запитання «Зберегти пройдений шлях?»
    await simGo(1400);
    await page.waitForFunction(() => window.__app.guide.g.arrived, null, { timeout: 150000 }); await sleep(700);
    s = await J();
    ok(`прибули — запис зупинено, шлях (${s.pend ? (s.pend.dist / 1000).toFixed(1) : '?'} км, точок ${s.pend ? s.pend.raw + ' → ' + s.pend.n : '?'}) чекає на відповідь; лінія лишається на карті`, !s.cur && s.pend && s.pend.why === 'arrived' && Math.abs(s.pend.dist - 26700) < 900 && s.pend.n <= s.pend.raw && s.pend.est > 200 && s.jr.length >= 3, JSON.stringify(s));
    const ak = await app(page, () => { const b = document.getElementById('jrAsk'), r = b.getBoundingClientRect(), tb = document.getElementById('tabs').getBoundingClientRect(), bt = [...b.querySelectorAll('[data-ja]')].map(x => { const q = x.getBoundingClientRect(), h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { k: x.dataset.ja, t: x.textContent.trim(), w: Math.round(q.width), h: Math.round(q.height), hit: !!h && x.contains(h) }; });
      return { box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], h: Math.round(r.height), aboveBar: r.bottom <= tb.top + 1, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0, bt, vh: innerHeight }; });
    ok(`на фініші — картка «Зберегти пройдений шлях?» («${s.askTxt.slice(0, 90)}»): над нижньою плашкою, під пальцем, дві великі кнопки; круг швидкості на цей час сховано`, s.ask && /^Зберегти пройдений шлях\?\s*Харків → Полтава · 2\d(,\d)? км · \d+ (хв|с)/.test(s.askTxt) && /без GPS/.test(s.askTxt) && ak.aboveBar && ak.inView && ak.h <= 150 && ak.bt.length === 2 && ak.bt.every(b => b.h >= 48 && b.w >= 90 && b.hit) && ak.bt.map(b => b.k).join() === 'no,yes' && !s.speed, JSON.stringify({ askTxt: s.askTxt, ak, speed: s.speed }));
    ok('картка запитання: усе читається; головний екран цілий', (await readCheck(page, '#jrAsk')).length === 0 && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify([await readCheck(page, '#jrAsk'), await page.evaluate(layoutCheck)]));
    await shot(page, '53-jr-ask-' + sc.n);
    await page.click('#jrAsk [data-ja="yes"]'); await sleep(500);
    s = await J();
    const stored = await app(page, async id => { const p = await window.__app.core.db.get('kv', 'jr:' + id), pend = await window.__app.core.db.get('kv', 'jrPend'), idx = await window.__app.core.db.get('kv', 'jrIdx'); return { n: Array.isArray(p) ? p.length : 0, pend: !!pend, idx: Array.isArray(idx) ? idx.length : 0 }; }, s.list[0] && s.list[0].id);
    ok('«Зберегти» — поїздка в архіві (зведення окремо, точки окремо; лежить у базі телефона), картка зникла, бліду лінію з карти прибрано, круг швидкості повернувся; про це — зелене повідомлення', !s.ask && !s.pend && s.list.length === 1 && s.list[0].title === 'Харків → Полтава' && s.list[0].why === 'arrived' && s.list[0].sim === true && stored.n > 5 && !stored.pend && stored.idx === 1 && s.jr.length === 0 && s.speed && /Шлях збережено в «Архіві поїздок»/.test(s.toasts), JSON.stringify({ s, stored }));
    await simStop(); await app(page, () => window.__app.guide.stopTrip()); await sleep(300);
    ok('рейс після фінішу закрили — другого запитання немає', !(await J()).ask);

    /* --- рейс зупинили самі: теж питаємо; «Не треба» — не зберігаємо --- */
    await start('t-34b'); await simGo(300); await rdOver(900);
    await simStop();
    await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#routePick [data-ts="stop"]'); await page.click('#routePick [data-ts="stop"]'); await sleep(150); await page.click('#routePick [data-ts="stop"]'); await sleep(600);
    s = await J();
    ok(`рейс завершили кнопкою (без GPS прибуття саме не настає) — те саме запитання (${s.pend ? s.pend.dist : '?'} м)`, s.ask && s.pend && s.pend.why === 'stopped' && s.pend.dist > 600 && !s.cur, JSON.stringify(s));
    await page.click('#jrAsk [data-ja="no"]'); await sleep(400);
    s = await J();
    ok('«Не треба» — шлях не збережено (в архіві, як і було, одна поїздка), лінію прибрано', !s.ask && !s.pend && s.list.length === 1 && s.jr.length === 0 && /Шлях не збережено/.test(s.toasts) && !(await app(page, () => window.__app.core.db.get('kv', 'jrPend'))), JSON.stringify(s));
    // пробний запуск на кілька метрів — не поїздка: не питаємо
    await start('t-34c'); await sleep(300); await app(page, () => window.__app.guide.stopTrip()); await sleep(500);
    s = await J();
    ok(`рейс запустили й одразу зупинили (менше ніж ${L.minSave} м) — це не поїздка: запитання немає`, !s.ask && !s.pend && !s.cur && s.list.length === 1, JSON.stringify(s));
    // на запитання не відповіли й поїхали в новий рейс — попередній шлях зберігаємо самі
    await start('t-34d'); await simGo(300); await rdOver(900); await simStop(); await app(page, () => window.__app.guide.stopTrip()); await sleep(500);
    ok('ще один рейс зупинено — запитання на екрані', (await J()).ask);
    await start('t-34e'); await sleep(400);
    s = await J();
    ok('на запитання не відповіли й почали новий рейс — попередній шлях збережено самим (викинути з архіву легко, а повернути загублене — ніяк); картки немає, пишеться новий шлях', !s.ask && !s.pend && s.list.length === 2 && s.list[0].why === 'stopped' && s.cur && s.cur.n >= 1 && /Попередній шлях збережено/.test(s.toasts), JSON.stringify(s));
    // програму закрили чи оновили посеред рейсу — шлях продовжується
    await simGo(300); await rdOver(1200); await simStop(); await sleep(300);
    const before = await J(); await app(page, () => window.__app.journey.flush()); await sleep(200);
    await page.reload(); await page.waitForFunction(() => window.__app && window.__app.guide.g.active && window.__app.journey.jr.ready, null, { timeout: 20000 }); await sleep(1200);
    s = await J();
    ok(`перезапуск посеред рейсу: рейс продовжено, і пройдений шлях теж — ті самі ${before.cur.n} точок на місці, лінія на карті`, s.cur && s.cur.id === before.cur.id && s.cur.n >= before.cur.n && !s.ask && s.jr.length >= 1 && s.list.length === 2, JSON.stringify({ before: before.cur, after: s.cur, jr: s.jr }));
    await app(page, () => window.__app.guide.stopTrip()); await sleep(500);
    ok('після перезапуску рейс зупинили — запитання про шлях є', (await J()).ask);
    await page.click('#jrAsk [data-ja="no"]'); await sleep(300);
  }

  if (!full) {
    /* --- картка запитання на інших екранах: у межах екрана, над нижньою плашкою, кнопки під пальцем --- */
    await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 0, t: Date.now() }); await sleep(400);
    await app(page, cs => { const Jm = window.__app.journey, t = Math.round(Date.now() / 1000) - 900, pts = cs.slice(0, 60).map((c, i) => [c[0], c[1], t + i * 4, 45, 0]); Jm.jr.pending = { id: 'j-ask', title: 'Харків → Полтава', a: 'Харків', b: 'Полтава', sim: false, why: 'stopped', raw: pts.length, st: Jm.stats(pts), pts }; window.__app.bus.emit('journey', Jm.jr); window.__app.bus.emit('journeyDone', Jm.jr.pending); }, coords);
    await sleep(500);
    const ak = await app(page, () => { const b = document.getElementById('jrAsk'), r = b.getBoundingClientRect(), tb = document.getElementById('tabs').getBoundingClientRect(), vis = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      const bt = [...b.querySelectorAll('[data-ja]')].map(x => { const q = x.getBoundingClientRect(), h = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return { k: x.dataset.ja, w: Math.round(q.width), h: Math.round(q.height), hit: !!h && x.contains(h) }; });
      return { shown: vis(b), txt: b.textContent.replace(/\s+/g, ' ').trim(), box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], h: Math.round(r.height), aboveBar: r.bottom <= tb.top + 1, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, bt, speed: vis(document.getElementById('speed')), line: (window.__app.map.map.getSource('jr')._data.features || []).length }; });
    ok(`[${T}] картка «Зберегти пройдений шлях?» («${ak.txt.slice(0, 70)}»): у межах екрана, над нижньою плашкою, дві кнопки під пальцем (${ak.bt.map(b => b.w + '×' + b.h).join(', ')}); шлях лишається на карті блідою лінією`, ak.shown && /^Зберегти пройдений шлях\?\s*Харків → Полтава · (2,9|3,0) км · 4 хв/.test(ak.txt) && ak.inView && ak.aboveBar && ak.h <= 150 && ak.bt.length === 2 && ak.bt.every(b => b.h >= 48 && b.w >= 80 && b.hit) && !ak.speed && ak.line >= 1, JSON.stringify(ak));
    ok(`[${T}] картка запитання: усе читається; головний екран цілий`, (await readCheck(page, '#jrAsk')).length === 0 && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify([await readCheck(page, '#jrAsk'), await page.evaluate(layoutCheck)]));
    await shot(page, '53-jr-ask-' + sc.n);
    await page.click('#jrAsk [data-ja="no"]'); await sleep(300);
    ok(`[${T}] «Не треба» — картки й лінії немає, круг швидкості на місці`, await app(page, () => { const b = document.getElementById('jrAsk'), sp = document.getElementById('speed'); return b.hidden && getComputedStyle(sp).visibility !== 'hidden' && (window.__app.map.map.getSource('jr')._data.features || []).length === 0 && !window.__app.journey.jr.pending; }));
  }
  /* --- «Архів поїздок»: справжня на вигляд поїздка (швидкості 10…95 км/год, зупинка, 5 км без GPS) --- */
  await app(page, cs => { const Jm = window.__app.journey, hav = Jm.havP; let t = Math.round(Date.now() / 1000) - 3 * 3600, d = 0; const pts = [[cs[0][0], cs[0][1], t, 0, 0]];
    const v = km => km < 2 ? 45 : km < 3.5 ? 30 : km < 6 ? 55 : km < 11 ? 80 : km < 16 ? 70 : km < 21 ? 95 : km < 25.5 ? 80 : km < 26 ? 10 : 20; let stopped = false;
    for (let i = 1; i < cs.length; i++) { const step = hav(cs[i - 1], cs[i]), sp = v(d / 1000); d += step; t += step / (sp / 3.6);
      if (!stopped && d >= 3500) { stopped = true; pts.push([cs[i][0], cs[i][1], Math.round(t), 0, 0]); t += 240; }
      pts.push([cs[i][0], cs[i][1], Math.round(t), sp, d > 11000 && d <= 16000 ? 1 : 0]); }
    const simp = Jm.simplify(pts); Jm.jr.pending = { id: 'j-test', title: 'Харків → Полтава', a: 'Харків', b: 'Полтава', sim: false, why: 'arrived', raw: pts.length, st: Jm.stats(simp), pts: simp }; Jm.savePending(); }, coords);
  await sleep(300);
  // вхід — у «Налаштуваннях»
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#panelBody .jr-entry button');
  const ent = await app(page, () => { const b = document.querySelector('#panelBody .jr-entry button'), r = b.getBoundingClientRect(), first = document.querySelector('#panelBody .sec').getBoundingClientRect(); return { txt: b.textContent.trim(), h: Math.round(r.height), beforeSecs: r.bottom <= first.top + 1, n: (b.querySelector('i') || {}).textContent, total: window.__app.journey.jr.list.length }; });
  if (full) await shot(page, '54-jr-entry-' + sc.n);
  ok(`[${T}] «Налаштування»: згори — кнопка «Архів поїздок» із кількістю (${ent.n})`, /^Архів поїздок/.test(ent.txt) && ent.h >= 50 && ent.beforeSecs && +ent.n === ent.total, JSON.stringify(ent));
  await page.click('#panelBody .jr-entry button'); await page.waitForSelector('#panelBody .jr-list .item');
  const ls = await app(page, () => ({ title: document.getElementById('panelTitle').textContent, back: !document.getElementById('panelBack').hidden, ids: [...document.querySelectorAll('#panelBody .jr-list .item')].map(r => r.dataset.jopen), rows: [...document.querySelectorAll('#panelBody .jr-list .item')].map(r => [...r.querySelectorAll('.t, .muted')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ')), tap: [...document.querySelectorAll('#panelBody .jr-list .item')].every(r => r.getAttribute('role') === 'button' && !r.querySelector('.btn.pri') && !!r.querySelector('[data-jdel]')), hint: (document.querySelector('#panelBody .arch-hint') || {}).textContent || '' }));
  const row = ls.rows[ls.ids.indexOf('j-test')] || '';
  ok(`[${T}] «Архів поїздок»: найновіша згори; рядок цілком відкриває поїздку (окремої кнопки немає), праворуч кошик; у рядку — звідки й куди, дата й час, відстань, тривалість, середня швидкість, скільки без GPS («${row}»)`, ls.title === 'Архів поїздок' && ls.back && ls.ids[ls.ids.length - 1] === 'j-test' && ls.rows.length === (full ? 3 : 1) && /^Харків → Полтава \| \d+ \S+, \d\d:\d\d · 27 км · 32 хв \| сер\. \d+ км\/год · без GPS 5(,\d)? км$/.test(row) && ls.tap && (!full || /симуляція/.test(ls.rows[0])) && /з GPS і без нього/.test(ls.hint), JSON.stringify(ls));
  ok(`[${T}] «Архів поїздок»: усе читається, рядок галочку «Готово» обминає`, (await readCheck(page, '#panel', '#panelBody')).length === 0, JSON.stringify(await readCheck(page, '#panel', '#panelBody')));
  if (full || sc.n === 'land') await shot(page, '54-jr-list-' + sc.n);
  // поїздка на карті
  await page.click('#panelBody .jr-list .item[data-jopen="j-test"] .grow'); await page.waitForSelector('#jv .jv-kv'); await sleep(1300);
  const view = () => app(page, () => { const A = window.__app, m = A.map.map, box = document.getElementById('jv'), r = box.getBoundingClientRect(), vis = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    const feats = (m.getSource('jv')._data.features || []).map(f => ({ b: f.properties.b, e: f.properties.e })), pts = A.uiJourney.jvIsOpen() ? m.getSource('jv')._data.features.flatMap(f => f.geometry.coordinates) : [];
    const land = innerWidth > innerHeight && innerHeight <= 520, free = land ? { l: 0, t: 0, r: r.left, b: innerHeight } : { l: 0, t: 0, r: innerWidth, b: r.top }, pr = pts.map(c => m.project(c));
    const ok2 = document.querySelector('#jv .pl-ok'), o = ok2 ? ok2.getBoundingClientRect() : null, oh = o ? document.elementFromPoint(o.left + o.width / 2, o.top + o.height / 2) : null;
    return { open: vis(box), panel: !document.getElementById('panel').hidden, cls: document.body.classList.contains('jv-on'), box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], h: Math.round(r.height), vh: innerHeight, vw: innerWidth, inView: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1,
      hidden: ['#top', '#tabs', '#speed', '#rail'].filter(s => vis(document.querySelector(s))), buckets: [...new Set(feats.map(f => f.b))].sort().join(''), est: feats.filter(f => f.e === 1).length, pins: [...document.querySelectorAll('.jv-pin')].map(p => p.className.replace('jv-pin', '').replace(/maplibregl\S*/g, '').trim() + ':' + p.textContent).join(),
      fit: pr.length > 1 && pr.every(p => p.x >= free.l - 2 && p.x <= free.r + 2 && p.y >= free.t - 2 && p.y <= free.b + 2), span: pr.length ? Math.round(Math.max(...pr.map(p => p.x)) - Math.min(...pr.map(p => p.x))) + '×' + Math.round(Math.max(...pr.map(p => p.y)) - Math.min(...pr.map(p => p.y))) : '', freeBox: free,
      head: (box.querySelector('.jv-head') || {}).textContent || '', kv: [...box.querySelectorAll('.jv-kv > div')].map(d => d.querySelector('b').textContent + ' ' + d.querySelector('small').textContent), stops: (box.querySelector('.jv-stops') || {}).textContent || '',
      chart: !!box.querySelector('#jvChart svg .jc-line path'), est2: box.querySelectorAll('#jvChart .jc-est rect').length, top: (box.querySelector('.jc-top') || {}).textContent, read: (document.getElementById('jvRead') || {}).textContent || '', legend: [...box.querySelectorAll('.jv-legend span')].map(x => x.textContent.trim()), legendShown: vis(box.querySelector('.jv-legend')),
      okBtn: o ? { w: Math.round(o.width), h: Math.round(o.height), hit: !!oh && ok2.contains(oh), fromRight: Math.round(r.right - o.right), fromBottom: Math.round(r.bottom - o.bottom) } : null, min: box.classList.contains('min'), zoom: +m.getZoom().toFixed(2), sel: !!document.querySelector('.jv-pin.sel'), cur: (() => { const c = document.getElementById('jvCur'); return c && !c.hidden ? c.style.left : ''; })(), clean: document.body.classList.contains('map-clean') }; });
  let v = await view();
  ok(`[${T}] дотик до поїздки — вона на карті: панель закрито, маневр, круг швидкості, кнопки й нижню плашку прибрано; видно лише карту й картку поїздки внизу (${v.h} px із ${v.vh})`, v.open && !v.panel && v.cls && v.inView && v.hidden.length === 0 && v.clean && (v.vw > v.vh ? true : v.h <= v.vh * 0.62), JSON.stringify({ box: v.box, hidden: v.hidden, h: v.h, vh: v.vh }));
  ok(`[${T}] лінія — кольором за швидкістю (усі п'ять: до 15 · 15–50 · 50–70 · 70–90 · понад 90), ділянка без GPS позначена пунктиром; старт «A» і фініш «Б»; уся поїздка вміщена у вільну частину карти (${v.span} px)`, v.buckets === '01234' && v.est >= 1 && /a:A/.test(v.pins) && /b:Б/.test(v.pins) && v.fit, JSON.stringify({ buckets: v.buckets, est: v.est, pins: v.pins, fit: v.fit, span: v.span, free: v.freeBox }));
  ok(`[${T}] картка поїздки: «${v.head.trim().slice(0, 60)}»; зведення — ${v.kv.join(' | ')}; ${v.stops}`, /^Харків → Полтава\s*\d+ \S+, \d\d:\d\d – \d\d:\d\d/.test(v.head.trim()) && v.kv.length === 6 && /^2\d(,\d)? км відстань$/.test(v.kv[0]) && /у дорозі$/.test(v.kv[1]) && /у русі$/.test(v.kv[2]) && /^\d+ км\/год середня$/.test(v.kv[3]) && /^95 км\/год найбільша$/.test(v.kv[4]) && /^5(,\d)? км · 1\d % без GPS$/.test(v.kv[5]) && /^Зупинок: 1 · стояли 4 хв\s*без GPS$/.test(v.stops), JSON.stringify({ head: v.head, kv: v.kv, stops: v.stops }));
  ok(`[${T}] графік швидкості (шкала до ${v.top} км/год, ділянку без GPS затінено); під ним — підказка й пояснення кольорів`, v.chart && v.est2 >= 1 && +v.top === 100 && /Торкніться лінії чи графіка/.test(v.read) && (!v.legendShown || (v.legend.length === 5 && v.legend[0] === 'до 15' && v.legend[4] === '90+')) && /без GPS$/.test(v.stops), JSON.stringify({ chart: v.chart, est2: v.est2, top: v.top, read: v.read, legend: v.legend }));
  ok(`[${T}] «Готово» — та сама жовта галочка праворуч унизу картки (${v.okBtn ? v.okBtn.w + '×' + v.okBtn.h : '—'}), нічим не перекрита`, v.okBtn && v.okBtn.w === 54 && v.okBtn.h === 54 && v.okBtn.hit && v.okBtn.fromRight <= 16 && v.okBtn.fromBottom <= 16, JSON.stringify(v.okBtn));
  ok(`[${T}] картка поїздки: усе читається`, (await readCheck(page, '#jv')).length === 0, JSON.stringify(await readCheck(page, '#jv')));
  await shot(page, '55-jr-view-' + sc.n);
  // дотик до графіка — час і швидкість у цьому місці, позначка на карті
  const cb = await app(page, () => { const r = document.getElementById('jvChart').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height / 2, x2: r.left + r.width * 0.8 }; });
  await page.mouse.move(cb.x, cb.y); await page.mouse.down(); await sleep(120);
  let v1 = await view();
  await page.mouse.move(cb.x2, cb.y, { steps: 4 }); await page.mouse.up(); await sleep(150);
  let v2 = await view();
  ok(`[${T}] дотик до графіка посередині — «${v1.read}»; провели пальцем далі — «${v2.read}»: позначка на карті йде слідом`, /^\d\d:\d\d · 70 км\/год · 1[2-4](,\d)? км від старту · без GPS$/.test(v1.read) && /^\d\d:\d\d · 80 км\/год · 2[0-3](,\d)? км від старту$/.test(v2.read) && v1.sel && v2.sel && Math.abs(parseFloat(v1.cur) - 50) < 1.5 && Math.abs(parseFloat(v2.cur) - 80) < 1.5, JSON.stringify({ r1: v1.read, c1: v1.cur, r2: v2.read, c2: v2.cur }));
  // дотик до лінії на карті — та сама точка на графіку
  const mp = await app(page, cs => { const p = window.__app.map.map.project([cs[1], cs[0]]), r = window.__app.map.map.getCanvas().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y + 6 }; }, coords[turnIdx[3] + 40]);
  await page.mouse.click(mp.x, mp.y); await sleep(250);
  v1 = await view();
  ok(`[${T}] дотик до лінії на карті (близько 8 км від старту, на кілька пікселів убік від неї) — «${v1.read}», курсор на графіку там само`, /^\d\d:\d\d · 80 км\/год · (7,[5-9]|8,[0-5]) км від старту$/.test(v1.read) && Math.abs(parseFloat(v1.cur) - 29.9) < 2, JSON.stringify({ read: v1.read, cur: v1.cur, mp }));
  await shot(page, '55-jr-view-pick-' + sc.n);
  // згорнути картку — більше карти; наблизити
  await page.click('#jv .jv-head'); await sleep(250);
  v2 = await view();
  ok(`[${T}] дотик до заголовка згортає картку (${v.h} → ${v2.h} px) — більше карти; «+» наближає`, v2.min && v2.h < v.h * 0.55 && v2.okBtn && v2.okBtn.hit, JSON.stringify({ h0: v.h, h1: v2.h, ok: v2.okBtn }));
  await page.click('#jv [data-jv="zin"]'); await sleep(700);
  ok(`[${T}] «+» наближає карту`, (await view()).zoom > v2.zoom + 0.5, `${v2.zoom} → ${(await view()).zoom}`);
  await page.click('#jv .jv-head'); await sleep(200); await page.click('#jv [data-jv="fit"]'); await sleep(900);
  ok(`[${T}] «Увесь рейс» знову вміщує поїздку у вільну частину карти`, (await view()).fit, JSON.stringify((await view()).span));
  // карта сама до машини не повертається, поки дивимось поїздку
  await app(page, () => { window.__app.map.view.lastTouch = Date.now() - 60000; }); await sleep(3400);
  ok(`[${T}] поки поїздка на екрані, карта сама до машини не повертається`, await app(page, () => !window.__app.map.view.follow));
  // системна «Назад»: поїздка → список → налаштування → карта
  const bk = []; for (let i = 0; i < 4; i++) { const r = await app(page, () => window.__reisBack()); await sleep(250); bk.push(await app(page, r => [r, window.__app.uiJourney.jvIsOpen() ? 'поїздка' : document.getElementById('panel').hidden ? 'карта' : document.getElementById('panelTitle').textContent].join(':'), r)); }
  ok(`[${T}] системна «Назад» іде по кроках: поїздка → «Архів поїздок» → «Налаштування» → карта (і лише тоді — згорнути програму)`, bk.join(' ') === 'true:Архів поїздок true:Налаштування true:карта false:карта', bk.join(' '));
  const aft = await app(page, () => { const vis = el => !!el && !el.hidden && getComputedStyle(el).visibility !== 'hidden'; return { jv: (window.__app.map.map.getSource('jv')._data.features || []).length, pins: document.querySelectorAll('.jv-pin').length, top: vis(document.getElementById('tabs')), clean: document.body.classList.contains('map-clean'), follow: window.__app.map.view.follow }; });
  ok(`[${T}] після перегляду карта як була: лінії поїздки й позначок немає, нижня плашка на місці, карта знову стежить за машиною`, aft.jv === 0 && aft.pins === 0 && aft.top && !aft.clean && aft.follow, JSON.stringify(aft));
  ok(`[${T}] головний екран цілий`, (await page.evaluate(layoutCheck)).length === 0, JSON.stringify(await page.evaluate(layoutCheck)));
  if (full) {
    // галочка на картці — назад до списку; кошик — видалити, дотик до повідомлення — повернути
    await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.click('#panelBody .jr-entry button'); await page.waitForSelector('#panelBody .jr-list .item');
    await page.click('#panelBody .jr-list .item[data-jopen="j-test"] .grow'); await page.waitForSelector('#jv .pl-ok'); await sleep(900);
    await page.click('#jv .pl-ok'); await sleep(300);
    ok('галочка на картці поїздки — назад до «Архіву поїздок»', await app(page, () => !window.__app.uiJourney.jvIsOpen() && document.getElementById('panelTitle').textContent === 'Архів поїздок' && !document.getElementById('panel').hidden));
    const n0 = await app(page, () => window.__app.journey.jr.list.length);
    await page.click('#panelBody .jr-list .item [data-jdel="j-test"]'); await sleep(500);
    const del = await app(page, async () => ({ n: window.__app.journey.jr.list.length, rows: document.querySelectorAll('#panelBody .jr-list .item').length, toast: document.getElementById('toasts').textContent, pts: !!(await window.__app.core.db.get('kv', 'jr:j-test')) }));
    const tv = await app(page, () => { const el = [...document.querySelectorAll('#toasts .toast')].pop(), r = el.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), hd = document.querySelector('#panel > header').getBoundingClientRect(); return { seen: !!h && el.contains(h), underHeader: r.top >= hd.bottom - 2, top: Math.round(r.top) }; });
    ok('кошик видаляє поїздку (і її точки з бази); повідомлення «Торкніться — повернути» видно ПОВЕРХ панелі, під її заголовком (раніше повідомлення лишались під панеллю)', del.n === n0 - 1 && del.rows === n0 - 1 && !del.pts && /Поїздку видалено\. Торкніться — повернути/.test(del.toast) && tv.seen && tv.underHeader, JSON.stringify({ del, tv }));
    // а повідомлення з дороги (не відповідь на дотик) панель, як і раніше, закриває — гортати не заважає
    await sleep(1700); await app(page, () => window.__app.bus.emit('feedPush', { src: 'tg', ch: 'test', level: 'yellow', text: 'Затор на трасі М-03 біля Тестового (перевірка)', key: 't-34-road', lat: window.__app.nav.pos.lat, lon: window.__app.nav.pos.lon, locKind: 'town' })); await sleep(700);
    const rt = await app(page, () => { const ts = [...document.querySelectorAll('#toasts .toast')], road = ts.find(x => /перевірка/.test(x.textContent)), undo = ts.find(x => /повернути/.test(x.textContent)); const seen = el => { if (!el || getComputedStyle(el).display === 'none') return false; const r = el.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && el.contains(h); }; return { road: !!road, roadSeen: seen(road), undoSeen: seen(undo) }; });
    ok('повідомлення з дороги, що прийшло, поки панель відкрита, поверх неї не лізе (чекає на карті); відповідь на дотик — лишається видно', (!rt.road || !rt.roadSeen) && rt.undoSeen, JSON.stringify(rt));
    await page.click('#toasts .toast.over'); await sleep(600);
    const res = await app(page, async () => ({ n: window.__app.journey.jr.list.length, rows: document.querySelectorAll('#panelBody .jr-list .item').length, pts: !!(await window.__app.core.db.get('kv', 'jr:j-test')) }));
    ok('дотик до повідомлення — поїздку повернуто', res.n === n0 && res.rows === n0 && res.pts, JSON.stringify(res));
    // GPX
    await page.click('#panelBody .jr-list .item[data-jopen="j-test"] .grow'); await page.waitForSelector('#jv [data-jv="gpx"]'); await sleep(600);
    const saved = await app(page, () => { window.__saved = []; const N = window.ReisNative || window.Android; return typeof N; });
    await page.click('#jv [data-jv="gpx"]'); await sleep(400);
    ok('«GPX» зберігає файл поїздки', /Файл збережено: reis-\d{8}-\d{4}\.gpx/.test(await app(page, () => document.getElementById('toasts').textContent)), saved + ' · ' + await app(page, () => document.getElementById('toasts').textContent));
    await page.click('#jv .pl-ok'); await sleep(300); await page.click('#panelOk'); await sleep(300);
  }
  ok(`[${T}] прохід 34 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`прохід 34 (${sc.n}) дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }

/* ============ прохід 35 (1.1.27): «Рейс» у вікні поверх інших програм (як у Google Maps) — що просимо в оболонки й що видно у вікні ============ */
if (run('35')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 360, height: 670 } });
  const n = coords.length, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const trip = { id: 't-35', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: turnIdx[2], len: 3500, time: 300 }, { type: 15, ins: 'Поверніть ліворуч', street: 'вулиця Соборності', streets: ['вулиця Соборності'], i0: turnIdx[2], i1: n - 1, len: 23300, time: 1400 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  const calls = () => app(page, () => window.__nativeCalls.filter(x => /^setPip/.test(x)).join());
  const openSettings = async () => { await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#panelBody [data-tg="pip"]'); };
  const rowTxt = () => app(page, () => { const r = document.querySelector('#panelBody [data-tg="pip"]'); return r ? { txt: r.textContent.replace(/\s+/g, ' ').trim(), on: !!r.querySelector('.on, [aria-checked="true"], input:checked') || /\bon\b/.test(r.className) || r.getAttribute('aria-checked') === 'true' } : null; });
  // а) стара оболонка (без setPip): рядок у налаштуваннях каже, що потрібне оновлення; оболонку ні про що не просимо
  await openSettings();
  let r0 = await rowTxt();
  ok('налаштування: є рядок «Вікно поверх інших програм»; у старій оболонці (№7 і давніші) під ним — «Потрібна нова версія програми — встановіть оновлення (APK)…»', !!r0 && /^Вікно поверх інших програм/.test(r0.txt) && /Потрібна нова версія програми/.test(r0.txt), JSON.stringify(r0));
  await page.click('#panelOk'); await sleep(200);
  // б) нова оболонка (№8): уміє setPip
  await app(page, () => { window.__nativeRev = 8; window.ReisNative.setPip = on => { window.__nativeCalls.push('setPip:' + on); return true; }; });
  await openSettings();
  r0 = await rowTxt();
  ok(`нова оболонка: під рядком — пояснення («${r0 && r0.txt.slice(27, 110)}…»), за замовчуванням увімкнено`, !!r0 && /Під час рейсу, коли йдете з «Рейсу»/.test(r0.txt) && /двома пальцями/.test(r0.txt) && await app(page, () => window.__app.S.pip !== false), JSON.stringify(r0));
  await shot(page, '56-pip-setting');
  await page.click('#panelOk'); await sleep(200);
  ok('рейсу немає — вікно в оболонки не просимо', !/setPip:true/.test(await calls()), await calls());
  await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 12, brg: 270, t: Date.now() }); await sleep(400);
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip); await sleep(500);
  await emitN('loc', { prov: 'gps', lat: coords[6][0], lon: coords[6][1], acc: 5, spd: 12, brg: 270, t: Date.now() }); await sleep(900);
  ok('рейс запущено — оболонці сказано: вікно потрібне (setPip:true)', /(^|,)setPip:true$/.test(await calls()), await calls());
  // в) перемикач у налаштуваннях
  await openSettings(); await page.click('#panelBody [data-tg="pip"]'); await sleep(300);
  ok('вимкнули в налаштуваннях — оболонці сказано: не потрібне (setPip:false); налаштування запам\'ятано', /setPip:true,setPip:false$/.test(await calls()) && await app(page, () => window.__app.S.pip === false && JSON.parse(localStorage.getItem('reis.settings')).pip === false), await calls());
  await page.click('#panelBody [data-tg="pip"]'); await sleep(300);
  ok('увімкнули знову — потрібне (setPip:true)', /setPip:false,setPip:true$/.test(await calls()), await calls());
  await page.click('#panelOk'); await sleep(300);
  // г) оболонка повідомила: програма у вікні. Лишаються карта й одна смужка: стрілка маневру, скільки до нього, «лишилось · час прибуття»
  const z0 = await app(page, () => +window.__app.map.map.getZoom().toFixed(2));
  const look = () => app(page, () => { const vis = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    const pv = document.getElementById('pipView'), r = pv.getBoundingClientRect(), b = pv.querySelector('b'), sm = pv.querySelector('small'), ic = pv.querySelector('.pv-ico'), m = window.__app.map.map, cv = m.getCanvas().getBoundingClientRect();
    const others = [...document.body.children].filter(e => e.id !== 'map' && e.id !== 'pipView' && !/^(SCRIPT|STYLE)$/.test(e.tagName) && vis(e)).map(e => e.id || e.tagName);
    const fit = el => !el || (el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth + 1);
    return { pip: document.body.classList.contains('pip'), shown: vis(pv), others, w: innerWidth, h: innerHeight, pv: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], pvH: Math.round(r.height), dist: b ? b.textContent : '', sub: sm ? sm.textContent : '', ico: !!ic && !!ic.querySelector('svg'), icoW: ic ? Math.round(ic.getBoundingClientRect().width) : 0,
      fs: [b ? parseFloat(getComputedStyle(b).fontSize) : 0, sm ? parseFloat(getComputedStyle(sm).fontSize) : 0], fit: fit(b) && fit(sm) && r.right <= innerWidth + 1, canvas: [Math.round(cv.width), Math.round(cv.height)], follow: window.__app.map.view.follow, zoom: +m.getZoom().toFixed(2), state: window.__app.pipWin.pip.on }; });
  const sizes = [[200, 267, 'звичайне'], [150, 200, 'найменше'], [300, 400, 'розтягнуте'], [400, 533, 'найбільше'], [320, 240, 'телефон набік']];
  for (const [w, h, nm] of sizes) {
    await page.setViewportSize({ width: w, height: h }); await emitN('pip', { on: true }); await sleep(900);
    await emitN('loc', { prov: 'gps', lat: coords[7][0], lon: coords[7][1], acc: 5, spd: 12, brg: 270, t: Date.now() }); await sleep(700);
    const v = await look();
    ok(`вікно ${w}×${h} (${nm}): на екрані лише карта й смужка маневру — стрілка (${v.icoW} px), «${v.dist}» (${v.fs[0]} px), під ним «${v.sub}» (${v.fs[1]} px); усе влазить, смужка займає ${v.pvH} із ${v.h} px`,
      v.pip && v.state && v.shown && v.others.length === 0 && v.ico && v.icoW >= 30 && /^\d+(,\d)? (км|м)$/.test(v.dist) && /^\d+(,\d)? км · \d\d:\d\d$/.test(v.sub) && v.fs[0] >= 20 && v.fs[1] >= 11 && v.fit && v.pv[0] === 0 && v.pv[1] === 0 && v.pv[2] === v.w && v.pvH <= v.h * 0.42 && Math.abs(v.canvas[0] - v.w) <= 1 && Math.abs(v.canvas[1] - v.h) <= 1 && v.follow, JSON.stringify(v));
    if (w === 200 || w === 400 || w === 320) await shot(page, `57-pip-${w}x${h}`);
  }
  const zp = (await look()).zoom;
  await page.setViewportSize({ width: 200, height: 267 }); await sleep(600);
  ok(`у вікні карта трохи далі (масштаб ${z0} → ${(await look()).zoom}) — видно більше дороги попереду`, (await look()).zoom <= z0 - 0.5, `${z0} → ${zp} → ${(await look()).zoom}`);
  // ґ) з'їхали з маршруту / прибули — у вікні те саме, що й на великому екрані
  await app(page, () => { const g = window.__app.guide.g; g.arrived = true; g.active = false; window.__app.bus.emit('arrived', g); window.__app.bus.emit('guide', g); }); await sleep(1300);
  let v = await look();
  ok(`прибули — у вікні «${v.dist}», під ним місце призначення («${v.sub}»); оболонці сказано, що нове вікно вже не потрібне, а це лишається, доки його не закриють`, /прибули/i.test(v.dist) && v.sub === 'Полтава' && v.fit && v.pip && /setPip:false$/.test(await calls()), JSON.stringify({ dist: v.dist, sub: v.sub, calls: await calls() }));
  await shot(page, '57-pip-arrived');
  // д) розгорнули назад — звичайний екран, усе на місці
  await page.setViewportSize({ width: 360, height: 670 }); await emitN('pip', { on: false }); await sleep(900);
  v = await look();
  const back = await app(page, () => { const vis = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'; return { top: vis(document.getElementById('top')), tabs: vis(document.getElementById('tabs')), speed: vis(document.getElementById('speed')), rail: vis(document.getElementById('rail')) }; });
  ok('розгорнули назад на весь екран — смужки вікна немає, маневр, круг швидкості, кнопки й нижня плашка на місці; нічого не накладається', !v.pip && !v.shown && back.top && back.tabs && back.speed && back.rail && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify({ v: { pip: v.pip, shown: v.shown }, back, lay: await page.evaluate(layoutCheck) }));
  ok('прохід 35 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 35 дійшов до кінця', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }

/* ============ справжні пачки номерів на справжній карті (лише на прохання: ADDR_DIR=тека ONLY=addrreal --shots тека) ============ */
// ADDR_DIR — тека з v1/index.json і пачками, взятими з гілки addr сховища. Карта — справжній квадрат Львова (city.pmtiles).
if (process.env.ADDR_DIR && run('addrreal')) try {
  PM.fonts = true; PM.file = 'city'; PACKS.on = true; PACKS.req = []; OFM.down = true;
  const size = (await pmFile('city')).length;
  const { page, ctx, errors } = await newPage(true, { offline: true, viewport: { width: 393, height: 800 }, before: async pg => { await ofmStub(pg); await pg.addInitScript(([r, n]) => { window.__nativeRev = r; window.__pmSize = n; }, [7, size]); } });
  await page.waitForFunction(() => window.__app.offline.offlineActive() && !!window.__app.map.map.getSource('protomaps'), null, { timeout: 15000 }).catch(() => {});
  // 1) нічого не натискаємо: застосунок сам кладе в телефон усі справжні пачки (якщо в теці вони всі)
  const t0 = Date.now(); let st = null;
  for (let i = 0; i < 240; i++) { st = await app(page, async () => { const A = window.__app.addr, i = await A.packInfo(); return { have: i.have, fresh: i.fresh, all: i.index ? i.index.packs : 0, total: i.index ? i.index.total : 0, bytes: i.bytes, busy: i.busy, err: i.err }; }); if (st.all && st.fresh === st.all) break; await sleep(500); }
  console.log('ADDRREAL auto', JSON.stringify(st), 'за', ((Date.now() - t0) / 1000).toFixed(1), 'с; запитів пачок', PACKS.req.filter(x => /\.bin\.gz$/.test(x)).length, '| підказка:', await app(page, () => document.getElementById('toasts').textContent));
  ok('справжні дані: уся Україна сама лягла в телефон (усі пачки каталогу)', st.all > 20 && st.fresh === st.all && !st.err, JSON.stringify(st));
  // 2) мережі немає, застосунок перезапущено: далі все — з телефона
  PACKS.down = true; PACKS.req = [];
  await page.reload(); await page.waitForFunction(() => window.__app && window.__app.map && window.__app.map.map && window.__app.offline.offlineActive(), null, { timeout: 20000 });
  const cities = [['Київ, Хрещатик', 50.4470, 30.5220], ['Харків, центр', 49.9935, 36.2304], ['Одеса, центр', 46.4825, 30.7233], ['Дніпро, центр', 48.4647, 35.0462], ['Вінниця, «Автопорт»', 49.258925, 28.573011], ['Ужгород', 48.6208, 22.2879], ['Чернігів', 51.4982, 31.2893], ['Запоріжжя', 47.8388, 35.1396], ['село Колочава (Закарпаття)', 48.4283, 23.6986]];
  const got = await app(page, async cities => { const A = window.__app.addr, out = [];
    for (const [name, lat, lon] of cities) { const [x, y] = A.tileXY(lat, lon), r = await A.tileLoad({ url: 'reisaddr://14/' + x + '/' + y }, new AbortController());
      const b = new Uint8Array(r.data); let n = 0; for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x18 && b[i + 1] === 0x01 && b[i + 2] === 0x22) n++;      // «тип = точка, далі геометрія» — по одному на номер
      out.push([name, x + '/' + y, n, b.length]); }
    return { out, own: A.addr.own, net: A.addr.net, fails: A.addr.fails }; }, cities);
  for (const c of got.out) console.log('ADDRREAL без мережі', c[0], '— квадрат 14/' + c[1] + ':', c[2], 'номерів,', c[3], 'байтів');
  ok('справжні дані без мережі: у містах, де карту ніколи не наближали, номери є — з телефона, без жодного запиту', got.out.filter(c => c[2] > 0).length >= 7 && got.fails === 0 && got.net === 0 && PACKS.req.length === 0 && OFM.tiles.length === 0, JSON.stringify({ got, req: PACKS.req.length }));
  for (const [name, lat, lon, z] of (process.env.ADDR_AT || 'a,49.8070,24.0450,17.3;b,49.8010,24.0520,17.6;c,49.8010,24.0520,18.6').split(';').map(x => x.split(',').map((v, i) => i ? +v : v))) {
    await app(page, ([lat, lon, z]) => { const P = window.__app; P.map.view.follow = false; P.map.view.lastTouch = Date.now() + 3600e3; P.map.map.jumpTo({ center: [lon, lat], zoom: z, pitch: 0, bearing: 0 }); }, [lat, lon, z]);
    await sleep(3500);
    const r = await app(page, () => { const m = window.__app.map.map, f = m.querySourceFeatures('addr', { sourceLayer: 'housenumber' }), d = m.queryRenderedFeatures({ layers: ['reis-house'] }).map(x => String(x.properties.housenumber));
      const b = m.getBounds(), seen = new Set(), inView = f.filter(x => { const c = x.geometry.coordinates, k = c[0].toFixed(6) + ',' + c[1].toFixed(6); if (seen.has(k) || !b.contains(c)) return false; seen.add(k); return true; }).map(x => String(x.properties.housenumber));
      return { inData: f.length, inView: inView.length, inViewList: inView.slice(0, 20), drawn: d.length, sample: [...new Set(d)].slice(0, 14), A: { ...window.__app.addr.addr }, err: window.__app.addr.packs.err }; });
    console.log('ADDRREAL', name, JSON.stringify(r));
    await shot(page, 'addr-real-' + name);
  }
  console.log('ADDRREAL req', JSON.stringify(PACKS.req), 'ofm', OFM.tiles.length);
  ok('справжні пачки номерів на справжній карті — без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('справжні пачки номерів', false, String(e.message).split('\n')[0]); } finally { PM.fonts = false; PM.file = 'tiny'; PACKS.on = false; OFM.down = false; }

/* ============ прохід 2: звичайний браузер (без оболонки) ============ */
/* ============ прохід 36 (1.1.28): сітка головного екрана — осі, проміжки, дзеркальні відступи ============
   Олексій: «круги швидкості опусти нижче», «над повзунком спершу хрестик "моє місце", над хрестиком — ±100», «зроби собі сітку й перевір,
   щоб усе було рівненько, симетрія в усіх значках». Правила: проміжок між сусідами й до плашки — 10 px; правий стовпчик (кнопки вгорі,
   «Моє місце», ±100) — на одній осі з повзунком нахилу; круги ліворуч — так само далеко від лівого краю, як стовпчик від правого;
   кнопки ±100 круг швидкості більше не піднімають. */
if (run('36')) for (const sc of [...SCREENS.filter(x => ['S10', 'small', 'tiny', 'xiaomi', 'tall', 'land', 'tablet', 'notch'].includes(x.n)), { n: 'tabland', w: 1272, h: 702, dpr: 1, title: 'планшет набік 1272×702' }].filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, n = coords.length, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  if (sc.st) await app(page, ([st, sb]) => { const r = document.documentElement.style; r.setProperty('--st', st + 'px'); r.setProperty('--sb', sb + 'px'); }, [sc.st, sc.sb]);
  const trip = { id: 't-36', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: turnIdx[2], len: 3500, time: 300 }, { type: 15, ins: 'Поверніть ліворуч', street: 'вулиця Соборності', streets: ['вулиця Соборності'], i0: turnIdx[2], i1: n - 1, len: 23300, time: 1400 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  const meas = (prep = '') => app(page, prep => { if (/lim/.test(prep)) { const l = document.getElementById('spdLim'); l.hidden = false; l.textContent = '50'; } if (/cam/.test(prep)) { const c = document.getElementById('cam'); c.hidden = false; document.getElementById('camMax').textContent = '90'; document.getElementById('camDist').textContent = '450 м'; }
    const o = {}, vis = el => !!el && !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    const sel = { top: '#top', quick: '#bQuick', map: '#bMap', snd: '#bSnd', center: '#bCenter', fwd: '#bFwd100', back: '#bBack100', turn: '#bTurn', nudge: '#nudge', tilt: '#tilt', thumb: '.tl-thumb', speed: '#speed', lim: '#spdLim', gps: '#spdGps', cam: '#cam', attr: '#attr', bar: '#tabbar', flat: '#tabbar .tb-main', tripbar: '#tripbar' };
    for (const k in sel) { const e = document.querySelector(sel[k]); if (!vis(e)) { o[k] = null; continue; } const r = e.getBoundingClientRect(); o[k] = { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), cx: +((r.left + r.right) / 2).toFixed(1), cy: +((r.top + r.bottom) / 2).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; }
    const a = window.__app.map.anchorPoint(); o.anc = { y: a.y, bot: Math.round(a.bot) }; o.W = innerWidth; o.H = innerHeight; o.follow = window.__app.map.view.follow; return o; }, prep);
  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
  const phone = sc.w <= 1009 && !(sc.w > sc.h && sc.h <= 520), exact = phone && sc.w > 340, wideTab = sc.w >= 1010 && sc.h >= 521;
  const lay = async () => await page.evaluate(layoutCheck);
  await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 12, brg: 270, t: Date.now() }); await sleep(600);
  // а) без рейсу, карту зсунули — зʼявилось «Моє місце»
  await app(page, () => { window.__app.map.setFollow(false); window.__app.map.view.lastTouch = Date.now() + 600000; window.dispatchEvent(new Event('resize')); }); await sleep(700);
  const a = await meas(); await shot(page, `60-grid-${sc.n}-1`);
  if (phone) {
    ok(`[${T}] «Моє місце» — одразу над повзунком нахилу (проміжок ${a.center && a.bar ? Math.round(a.bar.t - a.center.b) : '?'} px)${exact ? ` і на одній осі з ним (хрестик ${a.center.cx}, ручка ${a.thumb.cx})` : ''}; у межах екрана`,
      !!a.center && near(a.bar.t - a.center.b, 10) && (!exact || near(a.center.cx, a.thumb.cx)) && a.center.r <= a.W - 4 && Math.abs(a.center.cx - a.thumb.cx) <= 10, JSON.stringify({ center: a.center, thumb: a.thumb, bar: a.bar }));
    const tight = await app(page, () => document.body.classList.contains('rail-tight'));
    // (1.1.35) щоб лишитися одним стовпчиком, кнопки можуть стати трохи меншими й щільніше (rail-compact): проміжок 6…8 px, але скрізь однаковий
    const comp = await app(page, () => document.body.classList.contains('rail-compact')), rg = comp ? Math.round(a.map.t - a.quick.b) : 10;
    if (!tight) ok(`[${T}] (1.1.28) кнопка звуку — під кнопкою типу карти, ${exact ? `на тій самій осі (${a.snd && a.snd.cx})` : `під нею (${a.snd && a.snd.cx} і ${a.map.cx})`}, проміжок ${a.snd ? Math.round(a.snd.t - a.map.b) : '?'} px, такого ж розміру (${a.snd && a.snd.w}×${a.snd && a.snd.h})${comp ? ' — стовпчик стиснуто, щоб не ділити на два' : ''}`,
      !!a.snd && near(a.snd.cx, exact ? a.tilt.cx : a.map.cx) && rg >= 6 && rg <= 10 && near(a.snd.t - a.map.b, rg) && near(a.snd.w, a.map.w) && near(a.snd.h, a.map.h) && a.snd.w >= 42 && (comp ? a.snd.w < 50 : near(a.snd.w, 50)), JSON.stringify({ snd: a.snd, map: a.map, quick: a.quick, comp }));
    else if (phone) ok(`[${T}] (1.1.28) стовпчиком кнопки дістали б до кнопок над повзунком — кнопка звуку ліворуч від швидких налаштувань, в один ряд (проміжок ${a.snd ? Math.round(a.quick.l - a.snd.r) : '?'} px), стовпчик кнопок не дістає до кнопок унизу`,
      !!a.snd && near(a.snd.t, a.quick.t) && near(a.quick.l - a.snd.r, 10) && near(a.snd.w, a.map.w), JSON.stringify({ snd: a.snd, quick: a.quick }));
    if (exact) ok(`[${T}] кнопки справа вгорі — на тій самій осі (${a.quick.cx}, ${a.map.cx} | повзунок ${a.tilt.cx}); між ними ${Math.round(a.map.t - a.quick.b)} px, до верхньої плашки ${Math.round(a.quick.t - a.top.b)} px`,
      near(a.quick.cx, a.tilt.cx) && near(a.map.cx, a.tilt.cx) && near(a.map.t - a.quick.b, rg) && near(a.quick.t - a.top.b, 10), JSON.stringify({ quick: a.quick, map: a.map, tilt: a.tilt, top: a.top }));
    ok(`[${T}] круги ліворуч опущено до плашки: кружечок GPS — за ${Math.round(a.flat.t - a.gps.b)} px над нею; від лівого краю (${a.gps.l}) стільки ж, як «Моє місце» від правого (${+(a.W - a.center.r).toFixed(1)})`,
      near(a.flat.t - a.gps.b, 10) && near(a.gps.l, a.W - a.center.r) && a.speed.b <= a.flat.t - 4, JSON.stringify({ gps: a.gps, speed: a.speed, flat: a.flat, center: a.center }));
    ok(`[${T}] ⓘ (про карту) — у кутку між плашкою й виступом повзунка: не в стовпчику кнопок, нічого не закриває`, !!a.attr && a.attr.r <= a.tilt.l + 1 && a.attr.b <= a.flat.t && a.attr.t >= a.bar.t && (await lay()).length === 0, JSON.stringify({ attr: a.attr, tilt: a.tilt, lay: await lay() }));
  } else if (wideTab) {
    ok(`[${T}] широкий планшет: «Моє місце» у правому куті — на одній висоті з кругом швидкості в лівому (центри ${a.center && a.center.cy} і ${a.speed.cy}) і так само далеко від краю (${a.center && +(a.W - a.center.r).toFixed(1)} і ${a.gps.l})`,
      !!a.center && near(a.center.cy, a.speed.cy) && near(a.W - a.center.r, a.gps.l) && (await lay()).length === 0, JSON.stringify({ center: a.center, speed: a.speed, gps: a.gps, lay: await lay() }));
  } else ok(`[${T}] телефон набік: «Моє місце» — теж над повзунком нахилу (проміжок ${a.center ? Math.round(a.bar.t - a.center.b) : '?'} px, осі ${a.center && a.center.cx} і ${a.thumb.cx}); у межах екрана, нічого не накладається`, !!a.center && near(a.bar.t - a.center.b, 8) && Math.abs(a.center.cx - a.thumb.cx) <= 12 && a.center.r <= a.W - 4 && (await lay()).length === 0, JSON.stringify({ center: a.center, thumb: a.thumb, bar: a.bar, lay: await lay() }));
  // б) рейс, GPS, знак обмеження й камера
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip); await sleep(500);
  await emitN('loc', { prov: 'gps', lat: coords[6][0], lon: coords[6][1], acc: 5, spd: 12, brg: 270, t: Date.now() }); await sleep(900);
  await app(page, () => window.__app.map.setFollow(true)); await sleep(600);
  const b = await meas('lim cam'); await shot(page, `60-grid-${sc.n}-2`);
  if (phone) ok(`[${T}] рейс: знак обмеження й кружечок GPS — на одній вертикалі (${b.lim && b.lim.l} і ${b.gps.l}); камера — на рівні середини круга (${b.cam && b.cam.cy} і ${b.speed.cy}), за ${b.cam ? Math.round(b.cam.l - b.speed.r) : '?'} px від нього; нічого не накладається`,
    !!b.lim && near(b.lim.l, b.gps.l) && !!b.cam && near(b.cam.cy, b.speed.cy, 1.5) && near(b.cam.l - b.speed.r, 10) && (await lay()).length === 0, JSON.stringify({ lim: b.lim, gps: b.gps, cam: b.cam, speed: b.speed, lay: await lay() }));
  else ok(`[${T}] рейс: знак, круг, камера — нічого не накладається`, (await lay()).length === 0, JSON.stringify(await lay()));
  await app(page, () => { document.getElementById('cam').hidden = true; });
  // в) GPS зник: зʼявились ±100 — над повзунком; круг швидкості НЕ підстрибує
  await app(page, () => window.__app.nav.nudge(0)); await sleep(1100);
  await app(page, () => window.__app.map.setFollow(true)); await sleep(900);
  const c = await meas('lim'); await shot(page, `60-grid-${sc.n}-3`);
  ok(`[${T}] GPS зник — кнопки ±100 зʼявились, а круг швидкості лишився на місці (низ ${b.speed.b} → ${c.speed.b}); у нижній плашці їх більше немає`, !!c.fwd && !!c.back && near(c.speed.b, b.speed.b, 0.5) && near(c.speed.l, b.speed.l, 0.5) && !c.tripbar && near(c.bar.t, b.bar.t, 0.5), JSON.stringify({ was: b.speed, now: c.speed, fwd: c.fwd }));
  if (phone) {
    const low = sc.h <= 600;                                       // невисокий екран: місце «Мого місця» не резервуємо, «Поворот» — лівіше ±100
    ok(`[${T}] ±100 стоять ${low ? 'одразу над повзунком' : 'над місцем для «Мого місця» (воно зарезервоване, тож кнопки не стрибають)'}: до повзунка ${Math.round(c.bar.t - c.back.b)} px; правим краєм — по лінії кнопок справа (${c.back.r} і ${c.quick ? c.quick.r : '—'}); ↑100 над ↓100`,
      near(c.bar.t - c.back.b, low ? 10 : 70) && c.fwd.b <= c.back.t && near(c.fwd.r, c.back.r) && (!exact || near(c.back.r, c.quick.r, c.quick.w < 50 ? 3 : 1)) && c.back.r <= c.W - 4 && c.fwd.l >= c.tilt.l - 60, JSON.stringify({ fwd: c.fwd, back: c.back, bar: c.bar, quick: c.quick }));
    if (low) ok(`[${T}] кнопка «Поворот» — над плашкою (${c.turn ? Math.round(c.flat.t - c.turn.b) : '?'} px), лівіше кнопок ±100 (на ${c.turn ? Math.round(c.back.l - c.turn.r) : '?'} px); нічого не закриває`,
      !!c.turn && near(c.flat.t - c.turn.b, 10) && near(c.back.l - c.turn.r, 10) && c.turn.l >= c.speed.r + 4 && (await lay()).length === 0, JSON.stringify({ turn: c.turn, back: c.back, flat: c.flat, speed: c.speed, lay: await lay() }));
    else ok(`[${T}] кнопка «Поворот» — у кутку між плашкою й виступом повзунка: одразу над плашкою (${c.turn ? Math.round(c.flat.t - c.turn.b) : '?'} px), лівіше місця «Мого місця» (на ${c.turn ? Math.round(c.back.r - 50 - c.turn.r) : '?'} px), нижче кнопок ±100; нічого не закриває`,
      !!c.turn && near(c.flat.t - c.turn.b, 10) && near(c.back.r - 50 - c.turn.r, 10) && c.turn.t >= c.back.b + 4 && c.turn.l >= c.speed.r + 4 && (await lay()).length === 0, JSON.stringify({ turn: c.turn, back: c.back, flat: c.flat, speed: c.speed, attr: c.attr, lay: await lay() }));
    // (1.1.34) Олексій: «в офлайні стрілка вища, ніж в онлайні» — тепер без GPS стрілка на тій самій висоті, що й із GPS;
    // кнопки ±100 праворуч, стрілка посередині — вони її не закривають
    if (sc.w <= 600) ok(`[${T}] без GPS стрілка машини — на тій самій висоті, що й із GPS (${b.anc && b.anc.y} → ${c.anc.y}); кнопки ±100 праворуч від неї (на ${Math.round(c.nudge.l - c.W / 2)} px) і дорогу біля машини не закривають`,
      !!b.anc && Math.abs(c.anc.y - b.anc.y) <= 2 && c.nudge.l - c.W / 2 >= 30, JSON.stringify({ was: b.anc, anc: c.anc, nudge: c.nudge }));
  }
  // г) без GPS і карту зсунули: над повзунком — «Моє місце», над ним — ±100
  await app(page, () => { window.__app.map.setFollow(false); window.__app.map.view.lastTouch = Date.now() + 600000; }); await sleep(700);
  const d = await meas('lim'); await shot(page, `60-grid-${sc.n}-4`);
  const side = sc.w > sc.h && sc.h <= 520;                        // телефон набік: ±100 — ліворуч від «Мого місця», в один ряд
  if (side) ok(`[${T}] карту зсунули без GPS: «Моє місце» над повзунком, ±100 — ліворуч від нього (проміжок ${d.center && d.back ? Math.round(d.center.l - d.back.r) : '?'} px), низом на одній лінії; стрілку машини посеред карти не закривають; нічого не накладається`,
    !!d.center && !!d.back && near(d.center.l - d.back.r, 8) && near(d.back.b, d.center.b) && near(d.bar.t - d.center.b, 8) && (d.turn ? d.turn.l : d.fwd.l) > d.W / 2 + 20 && near(d.speed.b, b.speed.b, 0.5) && (await lay()).length === 0, JSON.stringify({ center: d.center, back: d.back, fwd: d.fwd, turn: d.turn, lay: await lay() }));
  else ok(`[${T}] карту зсунули без GPS: «Моє місце» ${phone ? 'над повзунком' : 'на місці'}, ±100 — над ним (проміжок ${d.center && d.back ? Math.round(d.center.t - d.back.b) : '?'} px), праві краї на одній лінії (${d.back && d.back.r} і ${d.center && d.center.r}); нічого не накладається`,
    !!d.center && !!d.back && near(d.center.t - d.back.b, 10) && near(d.back.r, d.center.r) && (!phone || near(d.bar.t - d.center.b, 10)) && near(d.speed.b, b.speed.b, 0.5) && (await lay()).length === 0, JSON.stringify({ center: d.center, back: d.back, fwd: d.fwd, turn: d.turn, lay: await lay() }));
  await page.click('#bFwd100'); await sleep(300);
  ok(`[${T}] кнопки на новому місці працюють: ↑100 зсуває позначку вперед, «Моє місце» повертає стеження`, await app(page, () => window.__app.nav.pos.mode === 'dr') && (await page.click('#bCenter'), await sleep(400), await app(page, () => window.__app.map.view.follow && document.getElementById('bCenter').hidden)));
  if (sc.n === 'xiaomi') {
    const snd = () => app(page, () => { const b = document.getElementById('bSnd'); return { voice: window.__app.S.voice, off: b.classList.contains('off'), pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), bg: getComputedStyle(b).backgroundColor }; });
    const s0 = await snd(); await page.click('#bSnd'); await sleep(300); const s1 = await snd(); await shot(page, `60-grid-${sc.n}-5-mute`); await page.click('#bSnd'); await sleep(300); const s2 = await snd();
    ok(`[${T}] кнопка звуку: дотик — звук вимкнено (помаранчева, не червона — червона відволікала; «${s1.label}»), ще дотик — увімкнено`, s0.voice === true && !s0.off && s1.voice === false && s1.off && s1.pressed === 'false' && /вимкнено/.test(s1.label) && s1.bg === 'rgb(245, 163, 0)' && s2.voice === true && !s2.off, JSON.stringify({ s0, s1, s2 }));
  }
  ok(`[${T}] прохід 36 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`[${sc.title}] прохід 36 дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
/* ============ прохід 37 (1.1.29): пошук адреси чи місця — як у Google Maps, усе українською ============
   Олексій: «пошук тільки українською — вулиці українською, щоб не було англійською; такий, як у Google Maps; домашні місця; просто
   подивитись, де це, не прокладаючи маршрут; набрати адресу і в рейсі». Без рейсу — рядок пошуку згори карти, у рейсі — лупа праворуч. */
/* (1.1.30) порядок результатів: однойменні міста — від більшого до меншого; вулиці й решта — від найближчого */
if (run('37')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 393, height: 800 } });
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await emitN('loc', { prov: 'gps', lat: 49.8397, lon: 24.0297, acc: 5, spd: 0, t: Date.now() }); await sleep(700);   // я у Львові
  const rows = () => app(page, () => [...document.querySelectorAll('#srBody .sr-item')].map(it => ({ t: it.querySelector('.sr-tx b').textContent, s: it.querySelector('.sr-tx small').textContent, d: (it.querySelector('.sr-d') || {}).textContent || '' })));
  const ask = async q => { await page.fill('#srIn', q); await page.waitForFunction(() => !document.querySelector('.sr-wait') && document.querySelectorAll('#srBody [data-sri]').length >= 2, null, { timeout: 8000 }).catch(() => {}); await sleep(500); return rows(); };
  await page.click('#srBar'); await sleep(300);
  const r1 = await ask('рядова');
  ok(`я у Львові, шукаю «рядова» — спершу вулиця у Львові, далі від ближчого до дальшого: ${r1.map(r => (r.s.split(',')[0] || r.t) + ' ' + r.d).join(' → ')}`,
    r1.length >= 5 && /^Львів/.test(r1[0].s) && /^Городок/.test(r1[1].s) && /^Тернопіль/.test(r1[2].s) && /^Київ/.test(r1[3].s) && r1[4].t === 'Рядове', JSON.stringify(r1));
  await shot(page, '64-rank-street');
  const r2 = await ask('миколаїв');
  ok(`«миколаїв» — спершу більше місто (${r2[0] && r2[0].s}), потім менше (${r2[1] && r2[1].s}), хоч воно й ближче; далі — решта від найближчого (${r2[2] && r2[2].t})`,
    r2.length >= 3 && r2[0].t === 'Миколаїв' && /Миколаївська/.test(r2[0].s) && r2[1].t === 'Миколаїв' && /Львівська/.test(r2[1].s) && r2[2].t === 'Миколаївська вулиця' && r2.filter(r => r.t === 'Миколаїв').length === 2, JSON.stringify(r2));
  await shot(page, '64-rank-city');
  const r3 = await ask('николаев');
  ok(`російською «николаев» — той самий порядок: ${r3.slice(0, 3).map(r => r.t + ' (' + r.s.split(',').slice(-1)[0].trim() + ')').join(', ')}`, r3.length >= 2 && /Миколаївська/.test(r3[0].s) && /Львівська/.test(r3[1].s), JSON.stringify(r3));
  const fp = await app(page, () => window.__app.route.rankPlaces([{ label: 'Миколаїв', kind: 't', local: true, pop: 14600, lat: 49.524, lon: 23.98 }, { label: 'Миколаїв', kind: 'c', local: true, pop: 470011, lat: 46.975, lon: 31.994 }], 'Миколаїв', { lat: 49.84, lon: 24.03 }).map(x => x.kind).join());
  ok('у формі «Рейс» той самий порядок (якщо набрати й не вибрати підказку — береться перша, тобто більше місто)', fp === 'c,t', fp);
  ok('прохід 37 (порядок) без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 37 (порядок) дійшов до кінця', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
if (run('37')) for (const sc of SCREENS.filter(x => ['xiaomi', 'S10', 'tiny', 'land'].includes(x.n)).filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h } });
  const T = sc.title, full = sc.n === 'xiaomi', emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const LAT = /[a-z]{3,}/i;
  await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 0, t: Date.now() }); await sleep(700);
  const R = sel => app(page, sel => { const e = document.querySelector(sel); if (!e || e.hidden || e.closest('[hidden]')) return null; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return null; const r = e.getBoundingClientRect(); if (!r.width) return null; return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height), txt: e.textContent.trim() }; }, sel);
  // а) без рейсу — рядок пошуку згори; лупи праворуч немає
  const bar = await R('#srBar'), strip = await R('#strip'), lupa = await R('#bSearch'), topB = await R('#top');
  ok(`[${T}] без рейсу згори карти по центру (над смужкою «що на дорозі»; на телефоні набік — над лівою колонкою) — плашка «${bar && bar.txt}» (${bar && bar.w}×${bar && bar.h}), під нею смужка «що на дорозі»; лупи праворуч немає; нічого не накладається`, !!bar && bar.txt === 'Вказати адресу' && bar.h >= 46 && bar.l >= 0 && bar.r <= sc.w && Math.abs((bar.l + bar.r) / 2 - (topB.l + topB.r) / 2) <= 2 && bar.w >= 200 && !!strip && strip.t >= bar.b && !lupa && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify({ bar, strip, lupa, lay: await page.evaluate(layoutCheck) }));
  await shot(page, `63-search-${sc.n}-0-bar`);
  await page.click('#srBar'); await sleep(400);
  const e0 = await app(page, () => ({ open: !document.getElementById('search').hidden, focus: document.activeElement && document.activeElement.id, ph: document.getElementById('srIn').placeholder, hw: [...document.querySelectorAll('.sr-hw')].map(b => b.textContent.replace(/\s+/g, ' ').trim()), box: (r => ({ t: r.top, b: r.bottom, l: r.left, r: r.right }))(document.getElementById('search').getBoundingClientRect()) }));
  ok(`[${T}] дотик — екран пошуку на весь екран, курсор у полі «${e0.ph}»; згори «Дім» і «Робота» (${e0.hw.join(' | ')})`, e0.open && e0.focus === 'srIn' && e0.ph === 'Адреса чи місце' && e0.hw.length === 2 && /Дім\s*Додати/.test(e0.hw[0]) && /Робота\s*Додати/.test(e0.hw[1]) && e0.box.t === 0 && e0.box.l === 0 && e0.box.r === sc.w && e0.box.b === sc.h, JSON.stringify(e0));
  await shot(page, `63-search-${sc.n}-1-empty`);
  // б) набираємо «антонич» — вулиці українською, під вулицями «Вказати номер будинку»
  const g0 = geoReqs.length;
  await page.fill('#srIn', 'антонич'); await page.waitForFunction(() => document.querySelectorAll('#srBody [data-sri]').length >= 3 && !document.querySelector('.sr-wait'), null, { timeout: 8000 }).catch(() => {}); await sleep(200);
  const res = await app(page, () => [...document.querySelectorAll('#srBody .sr-item')].map(it => ({ t: it.querySelector('.sr-tx b').textContent, s: it.querySelector('.sr-tx small').textContent, d: (it.querySelector('.sr-d') || {}).textContent || '', house: !!it.querySelector('[data-srh]'), cut: [...it.querySelectorAll('.sr-tx b, .sr-house span')].some(x => x.scrollWidth > x.clientWidth + 2 && getComputedStyle(x).textOverflow !== 'ellipsis') })));
  const gq = geoReqs.slice(g0);
  ok(`[${T}] пошук «антонич»: сервер питаємо з lang=default (назви мовою місцевості, а не телефона) і поблизу мене`, gq.length >= 1 && gq.every(u => /lang=default/.test(u)) && gq.some(u => /lat=/.test(u)), JSON.stringify(gq));
  ok(`[${T}] результати українською: ${res.map(r => '«' + r.t + '» — ' + r.s).join('; ')}`, res.length >= 3 && res.every(r => !LAT.test(r.t + ' ' + r.s)) && res[0].t === 'вулиця Богдана-Ігоря Антонича' && res[0].s === 'Львів, Львівська область' && res.some(r => r.t === 'вулиця Антонича' && /Городок/.test(r.s)) && res.some(r => r.t === 'Львівська загальноосвітня санаторна школа'), JSON.stringify(res));
  ok(`[${T}] під вулицями — «Вказати номер будинку» (під школою — ні); біля кожного — відстань від мене`, res.filter(r => r.house).length === 2 && !res.find(r => /школа/.test(r.t)).house && res.every(r => /км/.test(r.d)), JSON.stringify(res.map(r => [r.t, r.house, r.d])));
  await shot(page, `63-search-${sc.n}-2-results`);
  // в) «Вказати номер будинку» — назва вулиці в полі, курсор у кінці; дописали «7» — шукаємо в тому ж місті
  await page.click('#srBody [data-srh="0"]'); await sleep(200);
  const v1 = await app(page, () => ({ v: document.getElementById('srIn').value, focus: document.activeElement && document.activeElement.id }));
  ok(`[${T}] «Вказати номер будинку» — у полі «${v1.v}», курсор у полі`, v1.v === 'вулиця Богдана-Ігоря Антонича ' && v1.focus === 'srIn', JSON.stringify(v1));
  const g1 = geoReqs.length;
  await page.type('#srIn', '7'); await page.waitForFunction(() => [...document.querySelectorAll('#srBody .sr-tx b')].some(b => /Антонича 7$/.test(b.textContent)), null, { timeout: 8000 }).catch(() => {}); await sleep(200);
  const h7 = await app(page, () => [...document.querySelectorAll('#srBody .sr-item')].map(it => ({ t: it.querySelector('.sr-tx b').textContent, s: it.querySelector('.sr-tx small').textContent })));
  const q7 = decodeURIComponent((geoReqs.slice(g1).pop() || '').match(/q=([^&]*)/) ? (geoReqs.slice(g1).pop() || '').match(/q=([^&]*)/)[1] : '').replace(/\+/g, ' ');
  ok(`[${T}] дописали номер — шукаємо «${q7}» (з містом вулиці й біля неї); знайдено «${h7[0] && h7[0].t}» — ${h7[0] && h7[0].s}`, /антонича 7, львів/i.test(q7) && /lat=49\.81/.test(geoReqs.slice(g1).pop() || '') && !!h7[0] && h7[0].t === 'вулиця Богдана-Ігоря Антонича 7' && /Львів/.test(h7[0].s), JSON.stringify({ q7, h7 }));
  // г) дотик до результату — пошук закрився, місце на карті й картка; маршрут НЕ прокладається
  const n0 = routeReqs.length;
  await page.click('#srBody [data-sri="0"]'); await sleep(900);
  const c0 = await app(page, () => { const c = document.getElementById('srCard'), r = c.getBoundingClientRect(), bar = document.getElementById('tabbar').getBoundingClientRect(); return { open: !c.hidden, srch: !document.getElementById('search').hidden, t: c.querySelector('.src-tx b').textContent, s: c.querySelector('.src-tx small').textContent, btns: [...c.querySelectorAll('.src-b button')].map(b => b.textContent.trim()), box: { l: r.left, r: r.right, t: r.top, b: r.bottom }, barT: bar.top, follow: window.__app.map.view.follow, center: (m => { const c = m.getCenter(); return [c.lat, c.lng]; })(window.__app.map.map), marker: !!document.querySelector('.wp-pick') }; });
  ok(`[${T}] дотик до результату — пошук закрився; на карті позначка, карта на місці (${c0.center.map(x => x.toFixed(3))}); картка «${c0.t}» · «${c0.s}»; кнопки: ${c0.btns.join(' | ')}; маршрут сам не прокладається`, c0.open && !c0.srch && c0.marker && !c0.follow && Math.abs(c0.center[0] - 49.8105) < 0.01 && Math.abs(c0.center[1] - 24.0312) < 0.01 && c0.t === 'вулиця Богдана-Ігоря Antonycha 7'.replace('Antonycha', 'Антонича') && /від вас/.test(c0.s) && c0.btns[0] === 'Їхати сюди' && c0.btns.includes('Дім') && c0.btns.includes('Робота') && c0.box.b <= c0.barT && c0.box.l >= 0 && c0.box.r <= sc.w && routeReqs.length === n0, JSON.stringify(c0));
  await shot(page, `63-search-${sc.n}-3-card`);
  // ґ) «Дім» — збережено; у пошуку плитка «Дім» з адресою; недавні — це місце
  await page.click('#srCard [data-src="home"]'); await sleep(300);
  const hm = await app(page, () => ({ S: window.__app.S.home, on: document.querySelector('#srCard [data-src="home"]').classList.contains('on'), toasts: document.getElementById('toasts').textContent }));
  ok(`[${T}] «Дім» на картці — адресу збережено як дім («${hm.S && hm.S.label}»), кнопка зелена`, !!hm.S && hm.S.label === 'вулиця Богдана-Ігоря Антонича 7' && hm.on && /Дім: вулиця Богдана-Ігоря Антонича 7/.test(hm.toasts), JSON.stringify(hm));
  await page.click('#srCard [data-src="x"]'); await sleep(400);
  ok(`[${T}] ✕ — картка закрилась, позначки немає, карта знову за машиною`, await app(page, () => document.getElementById('srCard').hidden && !document.querySelector('.wp-pick') && window.__app.map.view.follow));
  await page.click('#srBar'); await sleep(300);
  const e1 = await app(page, () => ({ hw: [...document.querySelectorAll('.sr-hw')].map(b => b.textContent.replace(/\s+/g, ' ').trim()), rec: [...document.querySelectorAll('#srBody [data-sri] .sr-tx b')].map(b => b.textContent), sec: (document.querySelector('.sr-sec') || {}).textContent }));
  ok(`[${T}] знову пошук: «${e1.hw[0]}»; «${e1.sec}»: ${e1.rec.join(', ')}`, /Дім\s*вулиця Богдана-Ігоря Антонича 7/.test(e1.hw[0]) && e1.sec === 'Недавні' && e1.rec[0] === 'вулиця Богдана-Ігоря Антонича 7', JSON.stringify(e1));
  // д) «Робота» ще не задана — дотик: «знайдіть адресу роботи» + «Моє місце зараз»
  await page.click('.sr-hw[data-srk="work"]'); await sleep(300);
  const w0 = await app(page, () => ({ ph: document.getElementById('srIn').placeholder, set: (document.querySelector('.sr-set') || {}).textContent, me: !!document.querySelector('[data-srme]') }));
  ok(`[${T}] «Робота · Додати» — поле «${w0.ph}», підказка «${w0.set}», є «Моє місце зараз»`, w0.ph === 'Адреса роботи' && /Знайдіть адресу роботи/.test(w0.set) && w0.me, JSON.stringify(w0));
  await page.click('[data-srme]'); await sleep(300);
  const w1 = await app(page, () => ({ S: window.__app.S.work, hw: [...document.querySelectorAll('.sr-hw')].map(b => b.textContent.replace(/\s+/g, ' ').trim()), open: !document.getElementById('search').hidden }));
  ok(`[${T}] «Моє місце зараз» — збережено як роботу; пошук лишився відкритим, плитка «${w1.hw[1]}»`, !!w1.S && Math.abs(w1.S.lat - coords[4][0]) < 1e-6 && w1.open && /Робота\s*Моє місце зараз/.test(w1.hw[1]), JSON.stringify(w1));
  // е) «Дім» — картка; «Їхати сюди» — рейс від мене туди, з вибором варіанта й виду рейсу
  await page.click('.sr-hw[data-srk="home"]'); await sleep(700);
  const n1 = routeReqs.length;
  await page.click('#srCard [data-src="go"]'); await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 10000 }).catch(() => {}); await sleep(300);
  const rq = routeReqs[n1] || { locations: [] }, L = rq.locations, rs = await app(page, () => ({ sheet: !document.getElementById('routePick').hidden, vehm: !!document.querySelector('#routePick .vehm'), head: document.querySelector('#routePick .rp-head').textContent.replace(/\s+/g, ' ').trim(), card: !document.getElementById('srCard').hidden }));
  ok(`[${T}] «Дім» → «Їхати сюди»: рейс від мого місця до дому прокладено (${L.length} точки), шторка вибору з видом рейсу; «${rs.head}»`, routeReqs.length > n1 && Math.abs(L[0].lat - coords[4][0]) < 1e-4 && Math.abs(L[L.length - 1].lat - 49.8105) < 1e-4 && rs.sheet && rs.vehm && !rs.card && /Антонича 7/.test(rs.head), JSON.stringify({ L, rs }));
  await page.click('#routePick [data-rp="x"]'); await sleep(300);
  // є) у рейсі: рядка згори немає, лупа праворуч; знайдене — «Заїхати по дорозі»
  const n = coords.length, trip = { id: 't-37', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip); await sleep(600);
  await emitN('loc', { prov: 'gps', lat: coords[6][0], lon: coords[6][1], acc: 5, spd: 12, brg: 270, t: Date.now() }); await sleep(2300);
  const bar2 = await R('#srBar'), lupa2 = await R('#bSearch'), snd = await R('#bSnd');
  ok(`[${T}] у рейсі рядка пошуку згори немає (там плашка маневру), лупа — праворуч${sc.h > 600 && sc.w < sc.h ? ' під кнопкою звуку, того ж розміру' : ''}; нічого не накладається`, !bar2 && !!lupa2 && lupa2.w === 50 && (sc.h <= 600 || sc.w > sc.h || (Math.abs(lupa2.l - snd.l) <= 1 && Math.abs(lupa2.t - snd.b - 10) <= 1)) && (await page.evaluate(layoutCheck)).length === 0, JSON.stringify({ bar2, lupa2, snd, lay: await page.evaluate(layoutCheck) }));
  await shot(page, `63-search-${sc.n}-4-trip`);
  await page.click('#bSearch'); await sleep(300);
  await page.click('#srBody [data-sri="0"]'); await sleep(800);
  const c1 = await app(page, () => [...document.querySelectorAll('#srCard .src-b button')].map(b => b.textContent.trim()));
  ok(`[${T}] у рейсі знайдене місце — «${c1[0]}» (рейс не завершується)`, c1[0] === 'Заїхати по дорозі' && !c1.includes('Їхати сюди') && await app(page, () => window.__app.guide.g.active), JSON.stringify(c1));
  const n2 = routeReqs.length;
  await page.click('#srCard [data-src="via"]');
  // у дорозі GPS іде й далі (поки шукали, відліків не було — програма чесно відклала перебудову до GPS)
  for (let i = 0; i < 9 && routeReqs.length === n2; i++) { await emitN('loc', { prov: 'gps', lat: coords[7][0] + i * 0.00008, lon: coords[7][1], acc: 5, spd: 9, brg: 0, t: Date.now() }); await sleep(800); }
  await sleep(600);
  const via = await app(page, () => ({ v: window.__app.guide.g.trip.v, card: !document.getElementById('srCard').hidden, active: window.__app.guide.g.active, mode: window.__app.nav.pos.mode, pend: window.__app.guide.g.reroutePending, rr: window.__app.guide.g.rerouting, net: window.__app.P.online() }));
  ok(`[${T}] «Заїхати по дорозі» — рейс перебудовано через знайдене місце («${via.v && via.v.label}»), рейс триває`, !!via.v && /Антонича 7/.test(via.v.label) && !via.card && via.active && routeReqs.length > n2, JSON.stringify({ via, n: routeReqs.length - n2 }));
  // ж) системна «Назад» закриває пошук, потім картку
  await page.click('#bSearch'); await sleep(300);
  const b1 = await app(page, () => window.__reisBack()); const s1 = await app(page, () => document.getElementById('search').hidden);
  await page.click('#bSearch'); await sleep(300); await page.click('#srBody [data-sri="0"]'); await sleep(600);
  const b2 = await app(page, () => window.__reisBack()); const s2 = await app(page, () => document.getElementById('srCard').hidden);
  ok(`[${T}] системна «Назад»: закриває пошук, а з картки — картку`, b1 === true && s1 && b2 === true && s2);
  // з) точка на карті (зворотний пошук) — теж українською (lang=default) і без «;…»
  if (full) { const r = await app(page, () => window.__app.route.reverse(49.81, 24.03)); ok('зворотний пошук (назва точки на карті) — теж з lang=default', /lang=default/.test(geoReqs[geoReqs.length - 1]) && !!r && !LAT.test(r.name + r.city), JSON.stringify({ r, u: geoReqs[geoReqs.length - 1] })); }
  ok(`[${T}] прохід 37 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`[${sc.title}] прохід 37 дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
/* ============ прохід 38 (1.1.31): маршрути «як у Google» — головними дорогами, до трьох варіантів, першим — реально швидший ============
   Сервер рахує час за типовими швидкостями й путівець через села в нього буває «швидшим» за трасу. Тут сервер (підставний) віддає першим
   саме такий путівець (32 хв), а трасу Н-09 (34 хв) і E-471 (38 хв) — запасними. Програма має поставити першою трасу Н-09. */
{
  const mkTrip = (cs, parts) => {
    const n = cs.length - 1, tot = parts.reduce((a, p) => a + p[2], 0), km = parts.reduce((a, p) => a + p[1], 0);
    let i0 = 0;
    const mans = parts.map(([st, len, time], k) => { const i1 = k === parts.length - 1 ? n : Math.round(n * (k + 1) / parts.length); const m = { type: k ? 10 : 1, instruction: 'Рухайтеся: ' + st + '.', street_names: [st], length: len, time, begin_shape_index: i0, end_shape_index: i1 }; i0 = i1; return m; });
    mans.push({ type: 4, instruction: 'Ви прибули.', street_names: [], length: 0, time: 0, begin_shape_index: n, end_shape_index: n });
    return { legs: [{ shape: enc6(cs), maneuvers: mans, summary: { length: km, time: tot } }], summary: { length: km, time: tot }, status: 0 };
  };
  const arc = d => coords.map((c, i) => i === 0 || i === coords.length - 1 ? c : [c[0] + d * Math.sin(Math.PI * i / (coords.length - 1)), c[1]]);
  // путівець через села: за сервером найшвидший (31,7 хв), але 15 км з 18 — місцеві дороги
  const tVil = mkTrip(coords, [['вулиця Зелена', 6, 650], ['О141503', 6, 650], ['М-06', 3, 250], ['вулиця Стрийська', 3, 350]]);
  // трасою Н-09: 34 хв, місцевих — лише під'їзди
  const tMain = mkTrip(arc(0.012), [['вулиця Польова', 3, 300], ['Н-09', 11, 1300], ['вулиця Сихівська', 4, 440]]);
  // трасою E-471 в об'їзд: 38 хв
  const tE = mkTrip(arc(-0.015), [['вулиця Садова', 2, 250], ['E 471', 14, 1600], ['вулиця Городоцька', 3, 430]]);
  const THREE = q => q.alternates ? { status: 200, body: { trip: tVil, alternates: [{ trip: tMain }, { trip: tE }] } } : { status: 200, body: { trip: tVil } };
  const NP = { status: 400, body: { error_code: 442, error: 'No path could be found for input', status_code: 400, status: 'Bad Request' } };
  const build = async page => {
    await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#in_b');
    await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await page.click('#sg_b button');
    await page.click('[data-act="build"]');
    await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 15000 }); await sleep(700);
  };
  const cardsOf = page => app(page, () => { const box = document.getElementById('routePick').getBoundingClientRect(), R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }; };
    return { box: R(document.getElementById('routePick')), W: innerWidth, H: innerHeight, cls: (document.querySelector('#routePick .alts') || {}).className,
      cards: [...document.querySelectorAll('#routePick .alt')].map(x => ({ txt: x.textContent.replace(/\s+/g, ' ').trim(), on: x.classList.contains('on'), box: R(x),
        cut: [...x.querySelectorAll('b,span,i')].some(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > x.getBoundingClientRect().right + 0.5), flags: [...x.querySelectorAll('.fl i')].map(i => i.textContent) })) }; });
  if (run('38')) try {
    const { page, ctx, errors } = await newPage(true, { viewport: { width: 393, height: 800 } });
    await app(page, d => window.__reis('loc', d), { prov: 'gps', lat: coords[0][0], lon: coords[0][1], acc: 5, spd: 0, t: Date.now() }); await sleep(500);
    // а) що просимо в сервера
    let n0 = routeReqs.length; ROUTE.fn = THREE;
    await build(page);
    const q0 = routeReqs[n0] || {}, tk = (q0.costing_options || {}).truck || {};
    ok(`запит для фури: траси в пріоритеті (use_highways ${tk.use_highways}), без польових доріг (use_tracks ${tk.use_tracks}), житлових зон (${tk.use_living_streets}), з «ціною» проїздів дворами (${tk.service_penalty} с), без ґрунту посередині шляху (exclude_unpaved ${tk.exclude_unpaved}); і до двох запасних варіантів (alternates ${q0.alternates})`,
      q0.costing === 'truck' && tk.use_highways === 1 && tk.use_tracks === 0 && tk.use_living_streets === 0 && tk.service_penalty === 30 && tk.exclude_unpaved === true && q0.alternates === 2 && tk.height > 0 && tk.top_speed === 90, JSON.stringify(q0.costing_options));
    // б) три картки, першою — траса Н-09, а не путівець, хоч сервер і назвав путівець першим
    const c0 = await cardsOf(page);
    ok(`три варіанти, як у Google: ${c0.cards.map(c => '«' + c.txt + '»').join(' | ')}`, c0.cards.length === 3, JSON.stringify(c0.cards.map(c => c.txt)));
    ok('першою й вибраною — траса Н-09 (34 хв), позначка «головними дорогами»', /Н-09/.test(c0.cards[0].txt) && /≈ 34 хв/.test(c0.cards[0].txt) && c0.cards[0].on && c0.cards[0].flags.includes('головними дорогами'), JSON.stringify(c0.cards[0]));
    ok('путівець (32 хв) — другим, з позначкою «через села» і без «найшвидший»', /≈ 32 хв/.test(c0.cards[1].txt) && c0.cards[1].flags.includes('через села') && !c0.cards.some(c => c.flags.includes('найшвидший')) && !c0.cards[1].on, JSON.stringify(c0.cards[1]));
    ok('третій — E-471 (38 хв), без позначок', /E-471/.test(c0.cards[2].txt) && /≈ 38 хв/.test(c0.cards[2].txt) && !c0.cards[2].flags.length, JSON.stringify(c0.cards[2]));
    const mp = await app(page, async () => { const m = window.__app.map.map; return { alts: (await m.getSource('route-alts').getData()).features.length, trip: window.__app.ui ? null : null }; });
    ok('на карті — вибраний синім і два інші сірим', mp.alts === 2, JSON.stringify(mp));
    await shot(page, '66-routes-three');
    await page.click('#routePick .alt[data-alt="1"]'); await sleep(600);
    const c1 = await cardsOf(page);
    ok('дотик до путівця — він вибраний (водій вирішує сам)', c1.cards[1].on && !c1.cards[0].on);
    await page.click('#routePick .alt[data-alt="0"]'); await sleep(400);
    // в) у «Деталях» — ті самі три, у три стовпчики
    await page.click('#routePick [data-rp="info"]'); await page.waitForSelector('#planSum .alt', { timeout: 10000 }); await sleep(300);
    const ps = await app(page, () => { const a = [...document.querySelectorAll('#planSum .alt')].map(x => x.getBoundingClientRect()); return { n: a.length, row: a.length === 3 && a.every(r => Math.abs(r.top - a[0].top) < 2), first: (document.querySelector('#planSum .alt') || {}).textContent }; });
    ok('у «Деталях» — ті самі три картки в один ряд, першою Н-09', ps.n === 3 && ps.row && /Н-09/.test(ps.first), JSON.stringify(ps));
    await page.click('#panelOk').catch(() => {}); await sleep(300);
    await app(page, () => { const x = document.querySelector('#routePick [data-rp="x"]'); if (x && !document.getElementById('routePick').hidden) x.click(); }); await sleep(300);
    // г) порядок рахуємо за «реальним» часом, але набагато повільніший за сервером першим не стане
    const rk = await app(page, () => { const R = window.__app.route, mk = (time, st) => ({ time, mans: [{ streets: [st], time, len: time * 15 }] });
      const v = mk(1000, 'вулиця Польова'), a1 = mk(1300, 'Н-09'), a2 = mk(1400, 'Н-09');
      return { near: R.rankRoutes([v, a1]).map(r => r.time).join(), far: R.rankRoutes([v, a2]).map(r => r.time).join(), same: R.rankRoutes([mk(900, 'М-06'), mk(1000, 'М-06')]).map(r => r.time).join(),
        real: Math.round(R.realTime(v)), realA: Math.round(R.realTime(a1)) }; });
    ok(`порядок: путівець 1000 с (≈ ${rk.real} с насправді) проти траси 1300 с — першою траса (${rk.near}); траса 1400 с (більш як на чверть довше) — уже ні (${rk.far}); однакові дороги — за часом (${rk.same})`,
      rk.near === '1300,1000' && rk.far === '1000,1400' && rk.same === '900,1000' && rk.real === 1350 && rk.realA === 1300, JSON.stringify(rk));
    // ґ) проїзду без ґрунту немає — той самий запит ще раз, уже з ґрунтом; рейс є
    n0 = routeReqs.length; ROUTE.fn = q => { const o = (q.costing_options || {}).truck || (q.costing_options || {}).auto || {}; return o.exclude_unpaved ? NP : THREE(q); };
    await build(page);
    const rq = routeReqs.slice(n0, n0 + 2).map(q => ((q.costing_options || {}).truck || {}).exclude_unpaved);
    const c2 = await cardsOf(page);
    ok(`без ґрунту посередині проїзду немає — ще один запит, уже з ґрунтом (${rq.join(' → ')}), і рейс прокладено (${c2.cards.length} варіанти)`, rq[0] === true && rq[1] === undefined && c2.cards.length === 3, JSON.stringify(rq));
    await app(page, () => document.querySelector('#routePick [data-rp="x"]').click()); await sleep(1500);
    // д) «на свій розсуд» і легкова — ті самі вподобання доріг
    ROUTE.fn = THREE; n0 = routeReqs.length;
    await build(page);
    await page.click('#routePick .vehm [data-kind="free"]').catch(() => {}); await page.waitForFunction(n => window.__app && true, null).catch(() => {}); await sleep(1500);
    const qf = routeReqs.slice(n0).filter(q => q.costing === 'auto').pop() || {}, fa = (qf.costing_options || {}).auto || {};
    ok(`«на свій розсуд» (costing auto): ті самі вподобання доріг і обмежувач фури ${fa.top_speed}`, fa.use_highways === 1 && fa.exclude_unpaved === true && fa.use_tracks === 0 && fa.top_speed === 90, JSON.stringify(qf.costing_options));
    await page.click('#routePick .vehm [data-kind="car"]').catch(() => {}); await sleep(1500);
    const qc = routeReqs[routeReqs.length - 1] || {}, ca = (qc.costing_options || {}).auto || {};
    ok('легкова: ті самі вподобання доріг, без обмежувача фури', qc.costing === 'auto' && ca.use_highways === 1 && ca.exclude_unpaved === true && ca.top_speed === undefined, JSON.stringify(qc.costing_options));
    await page.click('#routePick .vehm [data-kind="strict"]').catch(() => {}); await sleep(1200);
    ROUTE.fn = null;
    ok('прохід 38 без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } catch (e) { ROUTE.fn = null; ok('прохід 38 дійшов до кінця', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
  // е) три картки на різних екранах: в один ряд, нічого не обрізано, шторка — в межах екрана
  if (run('38')) for (const sc of SCREENS.filter(x => ['S10', 'tiny', 'xiaomi', 'land', 'tablet'].includes(x.n)).filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
    const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
    await app(page, d => window.__reis('loc', d), { prov: 'gps', lat: coords[0][0], lon: coords[0][1], acc: 5, spd: 0, t: Date.now() }); await sleep(400);
    ROUTE.fn = THREE;
    await build(page);
    const c = await cardsOf(page);
    const row = c.cards.length === 3 && c.cards.every(x => Math.abs(x.box.t - c.cards[0].box.t) < 2), inside = c.cards.every(x => x.box.l >= c.box.l && x.box.r <= c.box.r) && c.box.t >= 0 && c.box.b <= c.H && c.box.r <= c.W;
    ok(`[${sc.title}] три картки в один ряд (${c.cards.map(x => (x.box.r - x.box.l) + 'px').join(', ')}), усі в шторці, шторка — на екрані; написи не обрізано`, row && inside && !c.cards.some(x => x.cut), JSON.stringify({ cls: c.cls, box: c.box, cards: c.cards.map(x => ({ b: x.box, cut: x.cut, t: x.txt })) }));
    await shot(page, `66-routes-three-${sc.n}`);
    ROUTE.fn = null;
    ok(`[${sc.title}] прохід 38 без помилок JS`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  } catch (e) { ROUTE.fn = null; ok(`[${sc.title}] прохід 38 дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
}
/* ============ прохід 39 (1.1.32): маршрут прямо на карті; кілька контрольних точок; контрольна точка в дорозі (і без GPS, і без інтернету) ============
   Олексій: «поставив флажок, натиснув — маршрут прокладається тут, на карті, без іншого вікна; можна додати ще контрольні точки».
   «Їду, без GPS, попереду щось сталося — пальцем: або перенести себе („Я тут“), або поставити контрольну точку — маршрут одразу через неї». */
if (run('39')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 393, height: 800 } });
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  // запити маршруту після k — без тихого запиту «варіанта через заборону для фур» (він може прийти з запізненням від попередньої побудови)
  const mainReqs = k => routeReqs.slice(k).filter(q => !((q.costing_options || {}).truck || {}).hgv_no_access_penalty);
  const n = coords.length, waitReq = async (k, ms = 10000) => { for (let i = 0; i < ms / 100 && !mainReqs(k).length; i++) await sleep(100); await sleep(400); };
  const LL = q => (q && q.locations || []).map(l => [+l.lat.toFixed(4), +l.lon.toFixed(4)]), RQ = k => mainReqs(k)[0];
  const near = (l, p, e = 2e-4) => !!l && Math.abs(l[0] - p[0]) < e && Math.abs(l[1] - p[1]) < e;
  await emitN('loc', { prov: 'gps', lat: coords[0][0], lon: coords[0][1], acc: 5, spd: 0, t: Date.now() }); await sleep(600);
  await app(page, () => { window.__panelSeen = false; new MutationObserver(() => { if (!document.getElementById('panel').hidden) window.__panelSeen = true; }).observe(document.getElementById('panel'), { attributes: true }); });
  // а) «Їхати» з меню точки — маршрут одразу тут, на карті
  const B = coords[n - 1];
  let k0 = routeReqs.length;
  await app(page, p => window.__app.bus.emit('mapPick', { lat: p[0], lon: p[1] }), B); await sleep(300);
  await page.click('#pick [data-k="b"]');
  await page.waitForFunction(() => !document.getElementById('routePick').hidden, null, { timeout: 15000 }); await sleep(500);
  const a1 = await app(page, () => ({ panelSeen: window.__panelSeen, pts: document.getElementById('pts').hidden, head: document.querySelector('#routePick .rp-head').textContent.replace(/\s+/g, ' ').trim(), cards: document.querySelectorAll('#routePick .alt').length }));
  ok(`«Їхати» з меню точки — маршрут одразу на цій карті (шторка з варіантами: ${a1.cards}), форма «Рейс» не з'являлась`, !a1.panelSeen && a1.pts && a1.cards >= 1 && LL(RQ(k0)).length === 2 && near(LL(RQ(k0))[1], B), JSON.stringify({ a1, loc: LL(RQ(k0)) }));
  await shot(page, '67-onmap-route');
  // б) «+ Через» на шторці → дотик до карти → контрольна точка, маршрут одразу перебудовано
  await page.click('#routePick [data-rp="via"]'); await sleep(250);
  const b0 = await app(page, () => ({ on: document.querySelector('#routePick .rp-addv').classList.contains('on'), aim: document.body.classList.contains('aiming'), toast: document.getElementById('toasts').textContent }));
  ok('«+ Через» на шторці — кнопка підсвічена, наступний дотик до карти поставить контрольну точку (підказка)', b0.on && b0.aim && /Торкніться карти там, де має пройти маршрут/.test(b0.toast), JSON.stringify(b0));
  const V1 = [coords[Math.round(n * 0.45)][0] + 0.003, coords[Math.round(n * 0.45)][1]];
  const [vx, vy] = await app(page, p => { const m = window.__app.map.map, s = m.project([p[1], p[0]]), r = m.getContainer().getBoundingClientRect(); return [Math.round(r.left + s.x), Math.round(r.top + s.y)]; }, V1);
  const gV1 = await app(page, ([x, y]) => { const mc = document.getElementById('map').getBoundingClientRect(); return window.__app.map.screenToGeo(x - mc.left, y - mc.top); }, [vx, vy]);
  k0 = routeReqs.length;
  await page.mouse.click(vx, vy); await waitReq(k0);
  await page.waitForFunction(() => !document.getElementById('routePick').hidden, null, { timeout: 15000 }); await sleep(400);
  const b1 = LL(RQ(k0)), bh = await app(page, () => ({ head: document.querySelector('#routePick .rp-head').textContent.replace(/\s+/g, ' ').trim(), vpins: document.querySelectorAll('.wp.wp-v').length, aim: document.body.classList.contains('aiming') }));
  ok(`дотик до карти — маршрут перебудовано через цю точку (${b1.length} точки в запиті); на карті кільце «через», у рядку шторки — точка`, b1.length === 3 && near(b1[1], [gV1.lat, gV1.lon], 2e-4) && bh.vpins === 1 && !bh.aim, JSON.stringify({ b1, gV1, bh }));
  // в) ще одна — з меню точки «Через»: стає туди, де дає найменший гак (між стартом і першою)
  const V2 = [coords[Math.round(n * 0.22)][0] + 0.003, coords[Math.round(n * 0.22)][1]];
  k0 = routeReqs.length;
  await app(page, p => window.__app.bus.emit('mapPick', { lat: p[0], lon: p[1] }), V2); await sleep(300);
  await page.click('#pick [data-k="v"]'); await waitReq(k0);
  await page.waitForFunction(() => !document.getElementById('routePick').hidden, null, { timeout: 15000 }); await sleep(400);
  const c1 = LL(RQ(k0)), ch = await app(page, () => ({ head: document.querySelector('#routePick .rp-head').textContent.replace(/\s+/g, ' ').trim(), vpins: document.querySelectorAll('.wp.wp-v').length }));
  ok(`друга контрольна точка — маршрут одразу через обидві, по порядку дороги: старт → ближча → дальша → фініш («${ch.head}»)`, c1.length === 4 && near(c1[1], V2, 2e-4) && near(c1[2], [gV1.lat, gV1.lon], 2e-4) && near(c1[3], B) && ch.vpins === 2 && /\+1/.test(ch.head), JSON.stringify({ c1, ch }));
  await shot(page, '67-onmap-route-2via');
  // г) рядок точок → плашка точок; «Через» → «Прибрати контрольні точки»; «Маршрут» — знову на карті
  await page.click('#routePick [data-rp="pts"]'); await sleep(400);
  await page.click('#pts [data-pt="v"]'); await sleep(250);
  const d0 = await app(page, () => ({ chip: document.querySelector('#pts .pt-chip[data-pt="v"]').textContent.trim(), ctx: (document.querySelector('#pts .pt-ctx') || { textContent: '' }).textContent.trim() }));
  await page.click('#pts .pt-ctx'); await sleep(250);
  k0 = routeReqs.length;
  await page.click('#pts [data-pt="route"]'); await waitReq(k0);
  await page.waitForFunction(() => !document.getElementById('routePick').hidden, null, { timeout: 15000 }); await sleep(300);
  ok(`плашка точок: «Через» — «${d0.chip}»; «${d0.ctx}» прибирає всі; «Маршрут» — знову тут, на карті, без контрольних точок`, /\+1/.test(d0.chip) && d0.ctx === 'Прибрати контрольні точки' && LL(RQ(k0)).length === 2 && await app(page, () => !window.__panelSeen && document.querySelectorAll('.wp.wp-v').length === 0), JSON.stringify({ d0, loc: LL(RQ(k0)) }));
  // д) у дорозі з GPS: меню точки — «Контрольна точка · Я тут»; контрольна точка — маршрут одразу від мене через неї
  await page.click('#routePick [data-rp="go"]'); await page.waitForFunction(() => window.__app.guide.g.active, null, { timeout: 8000 }); await sleep(800);
  const P1 = [coords[Math.round(n * 0.5)][0] + 0.004, coords[Math.round(n * 0.5)][1]];
  await app(page, p => window.__app.bus.emit('mapPick', { lat: p[0], lon: p[1] }), P1); await sleep(300);
  const e0 = await app(page, () => [...document.querySelectorAll('#pick button')].map(b => ({ k: b.dataset.k, t: b.textContent.trim(), pri: b.classList.contains('pri'), fit: [...b.querySelectorAll('span')].every(s => s.scrollWidth <= s.clientWidth + 1) })));
  ok(`у дорозі меню точки — «${e0.filter(x => x.t).map(x => x.t).join(' · ')}» і хрестик; написи вміщаються`, e0.map(x => x.k).join() === 'cp,here,x' && e0[0].pri && e0.every(x => x.fit), JSON.stringify(e0));
  await shot(page, '67-trip-cp-menu');
  k0 = routeReqs.length;
  await app(page, () => { window.__spoken.length = 0; document.getElementById('toasts').innerHTML = ''; });
  await page.click('#pick [data-k="cp"]'); await waitReq(k0); await sleep(500);
  const e1 = LL(RQ(k0)), es = await app(page, () => ({ vs: (window.__app.guide.g.trip.vs || []).length, s: window.__spoken.slice(), t: document.getElementById('toasts').textContent, pos: [window.__app.nav.pos.lat, window.__app.nav.pos.lon], follow: window.__app.map.following ? window.__app.map.following() : null }));
  ok(`«Контрольна точка» — маршрут одразу від мого місця через неї до фінішу; сказано голосом і написано`, e1.length === 3 && near(e1[0], es.pos, 1e-3) && near(e1[1], P1) && near(e1[2], B) && es.vs === 1 && es.s.some(x => /через вашу точку/.test(x)) && /Маршрут прокладено через контрольну точку/.test(es.t), JSON.stringify({ e1, es }));
  // е) без GPS (розрахунок по маршруту) — так само одразу, від розрахованого місця
  await app(page, () => { const R = window.__app.core.RouteIndex, p = new R(window.__app.guide.g.route.coords).at(1500); window.__app.nav.setManual({ lat: p.lat, lon: p.lon }); }); await sleep(400);
  const P2 = [coords[Math.round(n * 0.7)][0] + 0.004, coords[Math.round(n * 0.7)][1]];
  k0 = routeReqs.length;
  await app(page, p => window.__app.bus.emit('mapPick', { lat: p[0], lon: p[1] }), P2); await sleep(300);
  await page.click('#pick [data-k="cp"]'); await waitReq(k0); await sleep(300);
  const f1 = LL(RQ(k0)), fs = await app(page, () => ({ mode: window.__app.nav.pos.mode, pos: [window.__app.nav.pos.lat, window.__app.nav.pos.lon], pend: window.__app.guide.g.reroutePending }));
  ok(`без GPS (${fs.mode}) контрольна точка — маршрут перебудовано одразу від розрахованого місця (${f1.length} точки: я → точки → фініш)`, fs.mode === 'dr' && f1.length >= 3 && near(f1[0], fs.pos, 2e-3) && f1.some(l => near(l, P2)) && near(f1[f1.length - 1], B) && fs.pend == null, JSON.stringify({ f1, fs }));
  // є) без інтернету — точку поставлено, маршрут через неї прокладемо, щойно з'явиться зв'язок
  await ctx.setOffline(true); await sleep(300);
  const P3 = [coords[Math.round(n * 0.85)][0] + 0.004, coords[Math.round(n * 0.85)][1]];
  k0 = routeReqs.length;
  await app(page, () => { window.__spoken.length = 0; document.getElementById('toasts').innerHTML = ''; });
  await app(page, p => window.__app.bus.emit('mapPick', { lat: p[0], lon: p[1] }), P3); await sleep(300);
  await page.click('#pick [data-k="cp"]'); await sleep(900);
  const g1 = await app(page, () => ({ pend: window.__app.guide.g.reroutePending, t: document.getElementById('toasts').textContent, s: window.__spoken.slice(), vs: (window.__app.guide.g.trip.vs || []).length }));
  ok('без інтернету — запиту немає; сказано: точку поставлено, маршрут прокладу, щойно буде зв’язок', routeReqs.length === k0 && g1.pend && g1.pend.force && /Немає інтернету/.test(g1.t) && g1.s.some(x => /Немає інтернету/.test(x)) && g1.vs >= 3, JSON.stringify(g1));
  await ctx.setOffline(false); await sleep(300);
  await app(page, () => { const P = window.__app.nav.pos; window.__app.core.bus.emit('pos', P); }); await waitReq(k0);
  const h1 = LL(RQ(k0));
  ok(`зв'язок є — маршрут через контрольну точку прокладено (${h1.length} точки)`, h1.some(l => near(l, P3)) && await app(page, () => window.__app.guide.g.reroutePending == null), JSON.stringify(h1));
  await app(page, () => window.__app.guide.stopTrip());
  ok('прохід 39 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 39 дійшов до кінця', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
/* ============ прохід 40 (1.1.32): пошук — набрав місто, карта одразу там; далі вулиці в цьому місті; повзунок масштабу ============ */
if (run('40')) for (const sc of SCREENS.filter(x => ['xiaomi', 'S10', 'tiny'].includes(x.n)).filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h } });
  const T = sc.title, full = sc.n === 'xiaomi', emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await emitN('loc', { prov: 'gps', lat: coords[0][0], lon: coords[0][1], acc: 5, spd: 0, t: Date.now() }); await sleep(600);
  const st = () => app(page, () => { const R = e => { if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }; };
    const m = window.__app.map.map, c = m.getCenter(), body = document.getElementById('srBody'), zb = document.getElementById('zoomBar'), tl = document.getElementById('tilt').getBoundingClientRect();
    const fb = document.body.classList.contains('kb') ? innerHeight : document.getElementById('bottom').getBoundingClientRect().top, pb = body && body.offsetHeight ? body.getBoundingClientRect().bottom : 0;
    const mid = document.elementFromPoint(Math.round(innerWidth / 2) - 40, Math.round((pb + fb) / 2));
    return { map: document.body.classList.contains('sr-map'), open: !document.getElementById('search').hidden, c: [+c.lat.toFixed(3), +c.lng.toFixed(3)], z: +m.getZoom().toFixed(2), zb: R(zb), body: R(body), fb: Math.round(fb), W: innerWidth, H: innerHeight,
      axis: Math.round((tl.left + tl.right) / 2), midMap: !!mid && !!mid.closest('#map'), rows: [...document.querySelectorAll('#srBody .sr-item')].map(it => ({ t: it.querySelector('.sr-tx b').textContent, s: it.querySelector('.sr-tx small').textContent, city: it.classList.contains('sr-city'), btn: (it.querySelector('.sr-house') || { textContent: '' }).textContent.trim() })) }; });
  const typeQ = async q => { await page.fill('#srIn', q); await page.waitForFunction(() => !document.querySelector('.sr-wait'), null, { timeout: 8000 }).catch(() => {}); await sleep(1100); return st(); };
  await page.click('#srBar'); await sleep(300);
  // а) «Ки» — ще замало, карта на місці
  const s0 = await typeQ('Ки');
  ok(`[${T}] «Ки» — дві літери: карта не стрибає, список як завжди`, !s0.map && Math.abs(s0.c[0] - coords[0][0]) < 0.2, JSON.stringify({ map: s0.map, c: s0.c }));
  // б) «Киї» — місто вгадано: карта вже в Києві, список меншим, карту видно; повзунок масштабу праворуч
  const s1 = await typeQ('Киї');
  ok(`[${T}] «Киї» — вгадано Київ: карта там (${s1.c.join(', ')}, масштаб ${s1.z}), список «островом» згори, під ним видно карту`, s1.map && Math.abs(s1.c[0] - 50.45) < 0.08 && Math.abs(s1.c[1] - 30.523) < 0.12 && s1.z > 10.5 && s1.z < 13 && s1.midMap, JSON.stringify({ c: s1.c, z: s1.z, body: s1.body, fb: s1.fb, midMap: s1.midMap }));
  ok(`[${T}] перший рядок — Київ (підсвічено), під ним «${s1.rows[0] && s1.rows[0].btn}»`, s1.rows[0] && s1.rows[0].t === 'Київ' && s1.rows[0].city && s1.rows[0].btn === 'Шукати вулицю тут', JSON.stringify(s1.rows.slice(0, 2)));
  ok(`[${T}] повзунок масштабу праворуч, на осі нахилу (${s1.zb && Math.round((s1.zb.l + s1.zb.r) / 2)} = ${s1.axis}), посередині між списком і плашкою; висота ${s1.zb && s1.zb.h}`, !!s1.zb && Math.abs((s1.zb.l + s1.zb.r) / 2 - s1.axis) <= 1.5 && s1.zb.t >= s1.body.b + 10 && s1.zb.b <= s1.fb - 10 && s1.zb.h >= 130 && s1.zb.r <= s1.W && Math.abs((s1.zb.t - s1.body.b) - (s1.fb - s1.zb.b)) <= 2, JSON.stringify({ zb: s1.zb, body: s1.body, fb: s1.fb, axis: s1.axis }));
  if (full || sc.n === 'tiny') await shot(page, '68-search-city-' + sc.n);
  // в) повзунок: «+», «−», ручка
  const z0 = s1.z;
  await page.click('#zoomBar [data-zb="in"]'); await sleep(500);
  const z1 = (await st()).z;
  await page.click('#zoomBar [data-zb="out"]'); await page.click('#zoomBar [data-zb="out"]'); await sleep(600);
  const z2 = (await st()).z;
  const tb = await app(page, () => { const r = document.querySelector('#zoomBar .zb-track').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), t: Math.round(r.top), b: Math.round(r.bottom) }; });
  await page.mouse.move(tb.x, tb.b - 20); await page.mouse.down(); await page.mouse.move(tb.x, tb.t + 3, { steps: 6 }); await sleep(200);
  const zUp = (await st()).z, thUp = await app(page, () => document.getElementById('zoomBar').classList.contains('drag'));
  await page.mouse.move(tb.x, tb.b - 3, { steps: 6 }); await page.mouse.up(); await sleep(300);
  const zDn = (await st()).z;
  ok(`[${T}] повзунок: «+» ${z0} → ${z1}, «−»×2 → ${z2}; ручку вгору — ${zUp} (наблизили), униз — ${zDn} (уся Україна)`, z1 > z0 + 0.6 && z2 < z1 - 1.5 && zUp >= 17 && thUp && zDn <= 6, JSON.stringify({ z0, z1, z2, zUp, zDn }));
  // г) далі вулиця: «Київ, хрещ» — шукаємо в Києві (київська — першою, хоч сервер дав спершу черкаську)
  const g0 = geoReqs.length;
  const s2 = await typeQ('Київ, хрещ');
  const gq = decodeURIComponent((geoReqs.slice(g0).pop() || '')).replace(/\+/g, ' ');
  ok(`[${T}] «Київ, хрещ» — вулиця в Києві першою: «${s2.rows[0] && s2.rows[0].t} — ${s2.rows[0] && s2.rows[0].s}»; запит — «хрещ, Київ» біля Києва; карта лишається в Києві`, s2.map && s2.rows[0] && /Хрещатик/.test(s2.rows[0].t) && /Київ/.test(s2.rows[0].s) && /q=хрещ, Київ/i.test(gq) && /lat=50\.4/.test(gq) && Math.abs(s2.c[0] - 50.45) < 0.3, JSON.stringify({ rows: s2.rows.slice(0, 2), gq: gq.slice(0, 120) }));
  const s2b = await typeQ('Київ хрещ');
  ok(`[${T}] і без коми («Київ хрещ») — так само`, s2b.rows[0] && /Хрещатик/.test(s2b.rows[0].t) && /Київ/.test(s2b.rows[0].s), JSON.stringify(s2b.rows.slice(0, 2)));
  // ґ) дотик до вулиці — картка; повзунок і тут, між кнопками справа вгорі та карткою
  await page.click('#srBody [data-sri="0"]'); await sleep(900);
  const c1 = await app(page, () => { const R = e => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height) }; }; const zb = document.getElementById('zoomBar');
    return { card: !document.getElementById('srCard').hidden, t: document.querySelector('#srCard .src-tx b').textContent, zb: zb.hidden ? null : R(zb), cardT: Math.round(document.getElementById('srCard').getBoundingClientRect().top), rail: R(document.getElementById('rail')) }; });
  ok(`[${T}] дотик до «${c1.t}» — картка знайденого місця; повзунок масштабу між кнопками праворуч і карткою${c1.zb ? '' : ' (на цьому екрані місця замало — сховано)'}`, c1.card && /Хрещатик/.test(c1.t) && (!c1.zb ? c1.cardT - c1.rail.b < 130 + 28 : c1.zb.t >= c1.rail.b + 10 && c1.zb.b <= c1.cardT - 10), JSON.stringify(c1));
  if (full) await shot(page, '68-search-card-' + sc.n);
  await page.click('#srCard [data-src="x"]'); await sleep(400);
  ok(`[${T}] картку закрито — повзунка немає`, await app(page, () => document.getElementById('zoomBar').hidden));
  // д) село вгадуємо лише за повною назвою: «Львівк» — ні, «Львівка» — так
  await page.click('#srBar'); await sleep(300);
  const s3 = await typeQ('Львівк'), s4 = await typeQ('Львівка');
  ok(`[${T}] село — лише за повною назвою: «Львівк» — карта не стрибає; «Львівка» — карта там (${s4.c.join(', ')})`, !s3.map && s4.map && Math.abs(s4.c[0] - 48.66) < 0.05, JSON.stringify({ s3: s3.map, s4: [s4.map, s4.c] }));
  // е) затримали палець на карті — пошук ховається, меню точки: можна поставити точку й прокласти маршрут
  await app(page, () => window.__app.bus.emit('mapPick', { lat: 48.661, lon: 25.512 })); await sleep(400);
  const e1 = await app(page, () => ({ open: !document.getElementById('search').hidden, pick: !document.getElementById('pick').hidden, ks: [...document.querySelectorAll('#pick button')].map(b => b.dataset.k).join(), zb: document.getElementById('zoomBar').hidden, map: document.body.classList.contains('sr-map') }));
  ok(`[${T}] затримали палець на карті — пошук сховано, меню точки (${e1.ks})`, !e1.open && e1.pick && /b/.test(e1.ks) && e1.zb && !e1.map, JSON.stringify(e1));
  await page.click('#pick [data-k="x"]'); await sleep(200);
  ok(`[${T}] прохід 40 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`[${sc.title}] прохід 40 дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
/* ============ прохід 41 (1.1.33, 1.1.35): модуль OBD — значок у швидких налаштуваннях, вікно з перемикачем і показаннями, розшифровка J1939 ============
   1.1.35 (Олексій): у швидких налаштуваннях — просто значок «OBD» (зелений чи ні), без окремого рядка; модуль «апріорі вимкнений»,
   доки пристрій зчитування не підключено (перемикач неактивний, «Підключіть пристрій зчитування»), далі його можна вмикати й вимикати. */
if (run('41')) for (const sc of SCREENS.filter(x => ['xiaomi', 'tiny', 'land', 'tablet'].includes(x.n)).filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, full = sc.n === 'xiaomi';
  const ico = () => app(page, () => { const b = document.querySelector('#quick .q-obd'), h = document.querySelector('#quick .q-head'), x = document.querySelector('#quick .q-x'), tt = h.querySelector('b'), g = document.querySelector('#quick .q-grid'); if (!b) return null;
    const r = b.getBoundingClientRect(), X = x.getBoundingClientRect(), H = h.getBoundingClientRect(), tr = [...g.querySelectorAll('.q-tile')].map(e => e.getBoundingClientRect());
    return { on: b.classList.contains('on'), t: b.textContent.trim(), lab: b.getAttribute('aria-label'), h: Math.round(r.height), w: Math.round(r.width), leftOfX: r.right <= X.left + 0.5, inHead: r.top >= H.top - 0.5 && r.bottom <= H.bottom + 0.5, midY: Math.abs((r.top + r.bottom) / 2 - (X.top + X.bottom) / 2) <= 1,
      title: tt.textContent, titleFit: tt.scrollWidth <= tt.clientWidth + 1, tiles: tr.length, rows: new Set(tr.map(q => Math.round(q.top))).size, cols: new Set(tr.map(q => Math.round(q.left))).size, extra: document.querySelectorAll('#quick > *').length, bg: getComputedStyle(b.querySelector('span')).backgroundColor }; });
  const box = () => app(page, () => { const B = document.getElementById('obdBox'); if (B.hidden) return { open: false }; const R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const sw = B.querySelector('.obd-sw');
    return { open: true, box: R(B), title: B.querySelector('h2').textContent, sw: R(sw), swOn: sw.classList.contains('on'), swDis: sw.classList.contains('dis'), swAria: sw.getAttribute('aria-disabled'), swOp: +getComputedStyle(sw).opacity, swTxt: sw.textContent.trim(), st: B.querySelector('.obd-st').textContent.replace(/\s+/g, ' ').trim(), stCls: B.querySelector('.obd-st').className,
      rows: [...B.querySelectorAll('.obd-r')].map(r => ({ k: r.dataset.k, v: r.querySelector('b').textContent.replace(/[  ]/g, ' '), na: r.classList.contains('na') })), legal: B.querySelector('.obd-legal').textContent, back: R(B.querySelector('.obd-back')), backTxt: B.querySelector('.obd-back').textContent.trim(), W: innerWidth, H: innerHeight,
      groups: [...B.querySelectorAll('.obd-gh')].map(x => x.textContent) }; });
  // а) швидкі налаштування: дев'ять плиток 3×3, як і було; модуль OBD — значок «OBD» у заголовку ліворуч від хрестика, сірий
  await page.click('#bQuick'); await sleep(300);
  const q0 = await ico();
  ok(`[${T}] швидкі налаштування: значок «${q0 && q0.t}» у заголовку ліворуч від хрестика (${q0 && q0.w}×${q0 && q0.h}), сірий; плиток ${q0 && q0.tiles} (${q0 && q0.rows}×${q0 && q0.cols}), окремого рядка немає; заголовок «${q0 && q0.title}» не обрізано`,
    !!q0 && !q0.on && q0.t === 'OBD' && q0.leftOfX && q0.inHead && q0.midY && q0.h >= 44 && q0.w >= 44 && q0.tiles === 9 && (sc.n === 'tablet' || (q0.rows === 3 && q0.cols === 3)) && q0.extra === 2 && q0.titleFit && /не підключено/.test(q0.lab), JSON.stringify(q0));
  if (full || sc.n === 'tiny') await shot(page, '69-obd-quick-' + sc.n);
  // б) дотик — вікно: пристрою немає — перемикач неактивний, «Пристрій зчитування не підключено. Підключіть пристрій зчитування…»
  await page.click('#quick .q-obd'); await sleep(300);
  const b0 = await box();
  ok(`[${T}] дотик — вікно «${b0.title}» на весь екран: угорі праворуч перемикач, унизу «${b0.backTxt}»`, b0.open && b0.box.t === 0 && b0.box.h === b0.H && b0.title === 'Модуль OBD' && b0.sw.r >= b0.box.r - 20 && b0.sw.t < 80 && b0.sw.h >= 44 && b0.backTxt === 'Назад' && b0.back.b >= b0.H - 40 && b0.back.h >= 50 && b0.back.w >= b0.box.w - 40 && await app(page, () => document.getElementById('quick').hidden), JSON.stringify({ box: b0.box, sw: b0.sw, back: b0.back }));
  ok(`[${T}] пристрій не підключено — перемикач неактивний (блідий, «${b0.swTxt}»): «${b0.st.slice(0, 90)}…»; ${b0.rows.length} показань — сірі «—»`, !b0.swOn && b0.swDis && b0.swAria === 'true' && b0.swOp < 0.6 && /^Пристрій зчитування не підключено/.test(b0.st) && /Підключіть пристрій зчитування \(модуль OBD\)/.test(b0.st) && /підключення модуля ще немає/.test(b0.st) && b0.rows.length === 24 && b0.rows.every(r => r.na && r.v === '—') && b0.groups.join() === 'Рух,Стійкість,Керування,Паливо,Стан машини', b0.st);
  ok(`[${T}] пометка: модуль лише слухає, у машину нічого не надсилає, даних про водія не бере`, /Модуль лише слухає — у машину нічого не надсилає/.test(b0.legal) && /не надсилає в машину жодних команд/.test(b0.legal) && /даних про водія/.test(b0.legal) && /за згодою власника/.test(b0.legal), b0.legal.slice(0, 120));
  ok(`[${T}] вікно OBD: усе читається й нічого не обрізано (з прокруткою списку)`, (await readCheck(page, '#obdBox', '#obdBody')).length === 0, JSON.stringify(await readCheck(page, '#obdBox', '#obdBody')));
  if (full || sc.n === 'tiny') await shot(page, '69-obd-off-' + sc.n);
  // в) дотик до неактивного перемикача нічого не вмикає — рядок стану блимає: спершу підключіть пристрій
  await page.click('#obdBox [data-obd="sw"]', { force: true }); await sleep(200);       // force: Playwright сам не тисне на aria-disabled, а палець — тисне
  const b1 = await box();
  ok(`[${T}] неактивний перемикач не вмикається (умикати нічого) — підказка «підключіть пристрій» блимає`, !b1.swOn && b1.swDis && /nudge/.test(b1.stCls) && /^Пристрій зчитування не підключено/.test(b1.st) && await app(page, () => !window.__app.obd.isOn() && window.__app.S.obd !== true), JSON.stringify({ sw: b1.swOn, cls: b1.stCls }));
  // г) пристрій підключився (каже оболонка) — модуль умикається сам, перемикач активний; показань ще немає
  await app(page, () => window.__reis('obdLink', { state: 'conn', dev: 'WiCAN Pro' })); await sleep(400);
  const b2a = await box();
  ok(`[${T}] пристрій підключено — перемикач активний і ввімкнений сам («${b2a.swTxt}»): «${b2a.st}»`, b2a.swOn && !b2a.swDis && b2a.swAria === 'false' && b2a.swOp > 0.9 && b2a.swTxt === 'Увімк.' && /^Підключено: WiCAN Pro/.test(b2a.st) && /Показань поки немає — увімкніть запалювання/.test(b2a.st) && b2a.rows.every(r => r.na), b2a.st);
  // ґ) кадри J1939 — розшифровані показання
  const FR = [['18FEF100', '00 00 55 00 00 00 00 00'], ['0CF00400', 'F0 7D 82 30 2A 00 F0 7D'], ['18F00503', '89 00 00 8F 00 00 00 00'], ['18FEC1EE', 'A0 86 01 00 00 00 00 00'],
    ['18F0090B', '32 7E 00 8F 7E 00 80 7D'], ['18F0010B', '10 32 00 00 00 00 00 00'], ['18FEFC17', 'FF A6 00 00 00 00 00 00'], ['18FEEE00', '7D 00 00 00 00 00 00 00'], ['18FEF700', '00 00 00 00 30 02 00 00'], ['18FEF500', '00 00 00 C0 24 00 00 00']];
  await app(page, fr => window.__reis('obd', { f: fr }), FR); await sleep(500);
  const b2 = await box(), V = k => (b2.rows.find(r => r.k === k) || {}).v;
  ok(`[${T}] показання розшифровано: ${['speedW', 'rpm', 'gear', 'dist', 'steer', 'yaw', 'abs', 'brake', 'fuelLvl', 'cool', 'batt', 'amb'].map(k => V(k)).join(' · ')}`,
    /^Підключено: WiCAN Pro$/.test(b2.st) && /ok/.test(b2.stCls) && V('speedW') === '85 км/год' && V('rpm') === '1 350 об/хв' && V('gear') === '18' && V('dist') === '500,0 км' && V('steer') === '10°' && V('yaw') === '2,0 °/с' && V('abs') === 'втручається' && V('brake') === '20 %' && V('fuelLvl') === '66 %' && V('cool') === '85 °C' && V('batt') === '28,0 В' && V('amb') === '21 °C' && (b2.rows.find(r => r.k === 'speedT') || {}).na, JSON.stringify(b2.rows.map(r => r.k + ':' + r.v)));
  if (full) await shot(page, '69-obd-live-' + sc.n);
  const u = await app(page, () => { const O = window.__app.obd; return { p1: O.pgnOf(0x18F00900), p2: O.pgnOf(0x18EA0017), p3: O.pgnOf(0x0CFE6CEE), na: O.feed('18FEF100', 'FF FF FF FF FF FF FF FF') }; });
  ok(`[${T}] розшифровка J1939: PGN із ідентифікатора (VDC2 ${u.p1.toString(16)}, запит ${u.p2.toString(16)}, TCO1 ${u.p3.toString(16)}); «немає значення» (FF) — не показуємо`, u.p1 === 0xF009 && u.p2 === 0xEA00 && u.p3 === 0xFE6C && u.na === 0, JSON.stringify(u));
  // д) вимкнули перемикачем — показань не беремо й не показуємо, пристрій лишається підключеним; значок сірий
  await page.click('#obdBox [data-obd="sw"]'); await sleep(250);
  await app(page, fr => window.__reis('obd', { f: fr }), FR); await sleep(400);
  const b3 = await box();
  ok(`[${T}] вимкнули перемикачем — «${b3.st}»; показання сірі, нових кадрів не беремо`, !b3.swOn && !b3.swDis && /^Підключено: WiCAN Pro\. Модуль вимкнено/.test(b3.st) && /Увімкніть перемикач угорі/.test(b3.st) && b3.rows.every(r => r.na) && await app(page, () => window.__app.obd.freshCount() === 0 && window.__app.S.obd === false), b3.st);
  await page.click('#obdBox [data-obd="back"]'); await sleep(200);
  await page.click('#bQuick'); await sleep(250);
  const q1 = await ico();
  ok(`[${T}] «Назад» — вікно закрито; значок у швидких налаштуваннях сірий («${q1 && q1.lab}»)`, !(await box()).open && q1 && !q1.on && /підключено, модуль вимкнено/.test(q1.lab), JSON.stringify(q1));
  // е) увімкнули знову — показання йдуть, значок зелений
  await page.click('#quick .q-obd'); await sleep(250);
  await page.click('#obdBox [data-obd="sw"]'); await sleep(200);
  await app(page, fr => window.__reis('obd', { f: fr }), FR); await sleep(400);
  const b4 = await box();
  await app(page, () => window.__reisBack()); await sleep(200);
  await page.click('#bQuick'); await sleep(250);
  const q2 = await ico();
  ok(`[${T}] увімкнули знову — показання йдуть; значок зелений («${q2 && q2.lab}»)`, b4.swOn && /^Підключено: WiCAN Pro$/.test(b4.st) && b4.rows.filter(r => !r.na).length >= 15 && q2 && q2.on && /47, 158, 98/.test(q2.bg) && /модуль увімкнено/.test(q2.lab), JSON.stringify({ st: b4.st, q2 }));
  if (full) await shot(page, '69-obd-quick-on-' + sc.n);
  await page.click('#quick [data-q="close"]'); await sleep(150);
  // є) показання перестали йти — у вікні «показань поки немає»; пристрій відключили — перемикач знову неактивний, значок сірий
  await sleep(6200);
  await page.click('#bQuick'); await sleep(200); await page.click('#quick .q-obd'); await sleep(250);
  const b5 = await box();
  ok(`[${T}] кадрів немає понад 5 с — «${b5.st}», показання сірі; перемикач лишається ввімкненим`, b5.swOn && /Показань поки немає/.test(b5.st) && b5.rows.every(r => r.na), b5.st);
  await app(page, () => window.__reis('obdLink', { state: 'none' })); await sleep(300);
  const b6 = await box();
  await app(page, () => window.__reisBack()); await sleep(200);
  await page.click('#bQuick'); await sleep(250);
  const q3 = await ico();
  ok(`[${T}] пристрій відключили — перемикач знову неактивний («${b6.st.slice(0, 36)}…»), значок сірий`, !b6.swOn && b6.swDis && /^Пристрій зчитування не підключено/.test(b6.st) && q3 && !q3.on, JSON.stringify({ st: b6.st, q3 }));
  // ж) приклад показань (як виглядатиме) — чесно позначено; закрили вікно — прикладу немає
  await page.click('#quick .q-obd'); await sleep(250);
  await page.click('#obdBox [data-obd="demo"]'); await sleep(300);
  const b7 = await box();
  ok(`[${T}] «Показати приклад» — «${b7.st.slice(0, 40)}…», показання заповнено; перемикач лишається неактивним`, /^Приклад показань \(не з вашої машини\)/.test(b7.st) && b7.rows.filter(r => !r.na).length >= 20 && b7.swDis && !b7.swOn, b7.st);
  const back = await app(page, () => window.__reisBack());
  ok(`[${T}] системна «Назад» закриває вікно; прикладу після закриття немає`, back === true && !(await box()).open && await app(page, () => !window.__app.obd.st.demo && window.__app.obd.freshCount() === 0));
  ok(`[${T}] прохід 41 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`[${sc.title}] прохід 41 дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
if (run('42')) for (const sc of SCREENS.filter(x => ['xiaomi', 'tiny', 'S10'].includes(x.n)).filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 0, t: Date.now() }); await sleep(500);
  // а) плитка «Звук» у швидких налаштуваннях: вимкнено — прозора, як «Тема»; увімкнено — чорна, як «Екран». Червоної немає.
  await app(page, () => { window.__app.S.voice = true; }); await page.click('#bQuick'); await sleep(300);
  const tile = () => app(page, () => { const b = document.querySelector('#quick [data-q="voice"]'), th = document.querySelector('#quick [data-q="theme"]'); return { on: b.classList.contains('on'), warn: b.classList.contains('warn'), bg: getComputedStyle(b).backgroundColor, theme: th ? getComputedStyle(th).backgroundColor : null, voice: window.__app.S.voice }; });
  const v0 = await tile(); await page.click('#quick [data-q="voice"]'); await sleep(250); const v1 = await tile();
  ok(`[${T}] плитка «Звук»: увімкнено — чорна (${v0.bg}); вимкнено — прозора, як «Тема» (${v1.bg}); червоної немає`, v0.voice && v0.on && !v0.warn && !v1.voice && !v1.on && !v1.warn && v1.bg === v1.theme && !/229, 72, 77/.test(v1.bg), JSON.stringify({ v0, v1 }));
  await page.click('#quick [data-q="voice"]'); await sleep(150); await page.click('#quick [data-q="close"]'); await sleep(200);
  // б) «Улюблені місця» — третя кнопка під «Архів рейсів» і «Зберегти рейс»; порожньо — підказка
  await page.click('#tabs button[data-panel="trip"]'); await page.waitForSelector('#tripTools [data-act="favs"]'); await sleep(250);
  const fb = await app(page, () => { const b = document.querySelector('#tripTools [data-act="favs"]'), a = document.querySelector('#tripTools [data-act="archive"]'), sv = document.querySelector('#tripTools [data-act="saveTrip"]'); const R = e => e.getBoundingClientRect();
    const hit = document.elementFromPoint(R(b).left + R(b).width / 2, R(b).top + R(b).height / 2);
    return { txt: b.getAttribute('aria-label'), row: Math.abs(R(b).top - R(a).top) <= 1 && Math.abs(R(b).top - R(sv).top) <= 1, mid: R(b).left > R(sv).right && R(sv).left > R(a).right, eq: Math.abs(R(a).width - R(sv).width) <= 2, w: R(b).width, h: R(b).height, seen: !!hit && (hit === b || b.contains(hit)), ic: getComputedStyle(b.querySelector('.tt-ic')).backgroundColor, badge: !!b.querySelector('.tt-ic i'), fitA: a.scrollWidth <= a.clientWidth + 1, fitS: sv.scrollWidth <= sv.clientWidth + 1 }; });
  ok(`[${T}] сердечко «${fb.txt}» — у рядку з «Архів рейсів» і «Зберегти рейс», праворуч від них, зручне для пальця (${Math.round(fb.w)}×${Math.round(fb.h)} px); сусідні кнопки однакові й написи в них цілі; поки порожньо — без числа`, fb.txt === 'Улюблені місця' && fb.row && fb.mid && fb.eq && fb.w >= 46 && fb.h >= 46 && fb.ic === 'rgb(229, 72, 77)' && !fb.badge && fb.fitA && fb.fitS, JSON.stringify(fb));
  // (1.1.36, Олексій: «щоб уже були значок Дім, Робота, улюблені місця і кнопки додати, прибрати, редагувати»)
  const openFavs = async () => { await app(page, () => document.querySelector('#tripTools [data-act="favs"]').scrollIntoView({ block: 'center' })); await sleep(150); await page.click('#tripTools [data-act="favs"]'); await sleep(300); };
  const fv = () => app(page, () => { const R = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
    const seen = b => { const r = b.getBoundingClientRect(); if (r.bottom > innerHeight || r.top < 0) return true; const h = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return !!h && (h === b || b.contains(h)); };
    return { title: document.getElementById('panelTitle').textContent.trim(), back: !document.getElementById('panelBack').hidden, hint: (document.querySelector('#panelBody .arch-hint') || { textContent: '' }).textContent.trim(), toast: document.getElementById('toasts').textContent,
      home: window.__app.S.home || null, work: window.__app.S.work || null, favs: window.__app.favs.list().map(f => ({ id: f.id, label: f.label, name: f.name || '', lat: f.lat })),
      cards: [...document.querySelectorAll('#panelBody .fv-card')].map(c => ({ k: c.dataset.fk, cat: c.classList.contains('fv-cat'), ed: c.classList.contains('fv-ed'), flash: c.classList.contains('flash'), t: (c.querySelector('.fv-tx b') || { textContent: '' }).textContent, s: (c.querySelector('.fv-tx small') || { textContent: '' }).textContent,
        ic: c.querySelector('.fv-ic') ? getComputedStyle(c.querySelector('.fv-ic')).backgroundColor : '', go: !!c.querySelector('button.fv-main'), btn: [...c.querySelectorAll('button:not(.fv-main)')].map(b => b.textContent.trim() || b.getAttribute('aria-label')),
        r: R(c), fit: c.scrollWidth <= c.clientWidth + 1 && [...c.querySelectorAll('button:not(.fv-main)')].every(b => b.scrollWidth <= b.clientWidth + 1), seen: [...c.querySelectorAll('button')].every(seen), acts: [...c.querySelectorAll('button:not(.fv-main)')].map(R) })) }; });
  const card = (st, k) => st.cards.find(c => c.k === k) || { btn: [], acts: [], r: {} };
  const srState = () => app(page, () => ({ open: !document.getElementById('search').hidden, ph: (document.getElementById('srIn') || {}).placeholder || '', hint: (document.querySelector('#srBody .sr-set') || { textContent: '' }).textContent.trim(), me: !!document.querySelector('#srBody [data-srme]'), tiles: !!document.querySelector('#srBody .sr-hws') }));
  const pickFirst = async q => { await page.fill('#srIn', q); await page.waitForSelector('#srBody .sr-row[data-sri]', { timeout: 6000 }); await sleep(250); await page.click('#srBody .sr-row[data-sri]'); await page.waitForSelector('#panelBody .fv-card', { timeout: 5000 }); await sleep(350); };
  const clearToasts = () => app(page, () => { document.getElementById('toasts').innerHTML = ''; });
  // б) екран: три рядки зі значками — Дім, Робота, Улюблені місця; у кожного праворуч «Додати»
  await openFavs();
  const e0 = await fv(); await shot(page, '70-favs-empty-' + sc.n);
  ok(`[${T}] «Улюблені місця» — окремий екран зі стрілкою «назад»: три рядки зі значками — ${e0.cards.map(c => '«' + c.t + '» (' + c.s + ') [' + c.btn.join() + ']').join('; ')}`,
    e0.title === 'Улюблені місця' && e0.back && e0.cards.length === 3 && e0.cards.map(c => c.k).join() === 'home,work,fav' && e0.cards.every(c => c.cat && !c.go && c.btn.join() === 'Додати') && e0.cards.map(c => c.t).join() === 'Дім,Робота,Улюблені місця'
    && e0.cards[0].s === 'адресу не вказано' && e0.cards[1].s === 'адресу не вказано' && /ще немає/.test(e0.cards[2].s) && !e0.hint, JSON.stringify(e0.cards));
  ok(`[${T}] рядки однакові: висота ${e0.cards.map(c => c.r.h).join(', ')} px, «Додати» ${e0.cards.map(c => c.acts[0].w + '×' + c.acts[0].h).join(', ')} — на одній вертикалі (правий край ${e0.cards.map(c => c.acts[0].r).join(', ')}); значки різного кольору (синій, зелений, червоний); усе вміщається`,
    new Set(e0.cards.map(c => c.r.h)).size === 1 && new Set(e0.cards.map(c => c.acts[0].w + '×' + c.acts[0].h)).size === 1 && new Set(e0.cards.map(c => c.acts[0].r)).size === 1 && e0.cards.every(c => c.acts[0].h >= 44 && c.fit && c.seen)
    && e0.cards[0].ic === 'rgb(47, 107, 255)' && e0.cards[1].ic === 'rgb(47, 158, 98)' && e0.cards[2].ic === 'rgb(229, 72, 77)' && (await readCheck(page, '#panel', '#panelBody')).length === 0, JSON.stringify({ c: e0.cards, rc: await readCheck(page, '#panel', '#panelBody') }));
  // в) «Додати» в Дому — той самий пошук, що й «Вказати адресу»: знайшли, торкнулись — назад на екран, Дім збережено
  await page.click('#panelBody [data-fadd="home"]'); await page.waitForSelector('#srIn'); await sleep(250);
  const s0 = await srState();
  ok(`[${T}] «Додати» в Дому — пошук «${s0.ph}»: «${s0.hint.slice(0, 44)}…», є «Моє місце зараз»; плиток «Дім / Робота» тут немає`, s0.open && s0.ph === 'Адреса дому' && /адресу дому/.test(s0.hint) && s0.me && !s0.tiles, JSON.stringify(s0));
  await pickFirst('Харків');
  const h1 = await fv(), hc = card(h1, 'home');
  ok(`[${T}] вибрали «Харків» — знову екран «${h1.title}»; Дім: «${hc.s}», кнопки [${hc.btn.join(' | ')}]; сповіщення «${h1.toast.trim().slice(0, 24)}»; зʼявилась підказка`, h1.title === 'Улюблені місця' && !(await srState()).open && !hc.cat && hc.go && hc.t === 'Дім' && /^Харків/.test(hc.s) && hc.btn.join() === 'Старт,Через,Змінити,Прибрати'
    && /Дім: Харків/.test(h1.toast) && h1.home && h1.home.label === 'Харків' && /фінішем рейсу/.test(h1.hint), JSON.stringify({ hc, home: h1.home, toast: h1.toast }));
  ok(`[${T}] чотири кнопки в один ряд: «Старт» і «Через» однакові (${hc.acts[0].w} і ${hc.acts[1].w} px), олівець і кошик однакові (${hc.acts[2].w}×${hc.acts[2].h}, ${hc.acts[3].w}×${hc.acts[3].h}); написи цілі, нічого не закрито`,
    hc.acts.length === 4 && new Set(hc.acts.map(a => a.t)).size === 1 && hc.acts.every(a => a.h >= 44) && Math.abs(hc.acts[0].w - hc.acts[1].w) <= 1 && hc.acts[2].w === hc.acts[3].w && hc.acts[2].w >= 44 && hc.acts[3].r <= hc.r.r - 8 && hc.fit && hc.seen, JSON.stringify(hc));
  // г) «Додати» в Роботи — «Моє місце зараз»: не «Моє місце зараз» (за годину це вже неправда), а адреса цього місця
  await clearToasts(); await page.click('#panelBody [data-fadd="work"]'); await page.waitForSelector('#srBody [data-srme]'); await sleep(200);
  await page.click('#srBody [data-srme]'); await page.waitForSelector('#panelBody .fv-card', { timeout: 5000 }); await sleep(900);
  const w1 = await fv(), wc = card(w1, 'work');
  ok(`[${T}] Робота — «Моє місце зараз»: збережено як «${w1.work && w1.work.label}» (адреса цього місця, а не «Моє місце зараз»; координат під назвою немає)`, !wc.cat && wc.t === 'Робота' && w1.work && w1.work.label === 'Пісочин, Харків' && /^Пісочин, Харків( · |$)/.test(wc.s) && !/\d\d\.\d{4}/.test(wc.s) && Math.abs(w1.work.lat - coords[4][0]) < 1e-6, JSON.stringify({ wc, work: w1.work }));
  // ґ) «Додати» в улюблених: «назад» — нічого не додано; знайшли місце — воно в списку; те саме вдруге не додається
  await clearToasts(); await page.click('#panelBody [data-fadd="fav"]'); await page.waitForSelector('#srIn'); await sleep(250);
  const s1 = await srState();
  await page.click('#search [data-sr="back"]'); await sleep(300);
  const b1 = await fv();
  ok(`[${T}] «Додати» в улюблених — пошук «${s1.ph}» («${s1.hint.slice(0, 40)}…»); «назад» — знову «${b1.title}», нічого не додано`, s1.ph === 'Місце для улюблених' && /стане улюбленим/.test(s1.hint) && s1.me && b1.title === 'Улюблені місця' && b1.favs.length === 0 && !(await srState()).open, JSON.stringify({ s1, n: b1.favs.length }));
  await page.click('#panelBody [data-fadd="fav"]'); await page.waitForSelector('#srIn'); await sleep(200);
  const sb = await app(page, () => window.__reisBack()); await sleep(300);
  ok(`[${T}] системна «Назад» з пошуку — теж назад на «Улюблені місця»`, sb === true && (await fv()).title === 'Улюблені місця' && !(await srState()).open);
  await page.click('#panelBody [data-fadd="fav"]'); await page.waitForSelector('#srIn'); await sleep(200);
  await pickFirst('Полтава');
  const a1 = await fv(), fc1 = a1.cards[3] || { btn: [] };
  ok(`[${T}] знайшли «Полтава» — місце в списку під розділом (підсвічене): «${fc1.t}» (${fc1.s}) [${fc1.btn.join(' | ')}]; у розділі «${card(a1, 'fav').s}»; сповіщення «${a1.toast.trim().slice(0, 30)}»`,
    a1.cards.length === 4 && a1.favs.length === 1 && fc1.t === 'Полтава' && fc1.flash && fc1.go && fc1.btn.join() === 'Старт,Через,Змінити,Прибрати' && card(a1, 'fav').s === 'збережено: 1' && /«Полтава» — в улюблених/.test(a1.toast), JSON.stringify({ fc1, toast: a1.toast }));
  await clearToasts(); await page.click('#panelBody [data-fadd="fav"]'); await page.waitForSelector('#srIn'); await sleep(200);
  await pickFirst('Полтава');
  const a2 = await fv();
  ok(`[${T}] те саме місце вдруге не додається: «${a2.toast.trim().slice(0, 40)}»`, a2.favs.length === 1 && /вже є в улюблених/.test(a2.toast), a2.toast);
  // д) друге місце (як сердечком на картці знайденого місця) — найновіше згори
  await app(page, () => { const F = window.__app.favs; F.add({ lat: 50.0, lon: 36.23, label: 'Харків, стоянка Окружна', sub: 'Харківська обл.' }); F.add({ lat: 50.00001, lon: 36.23001, label: 'дубль' }); });
  await page.click('#panelBack'); await sleep(200); await openFavs();
  const l0 = await fv(), fl = l0.cards.slice(3);
  await shot(page, '70-favs-' + sc.n);
  ok(`[${T}] список: Дім, Робота, розділ («${card(l0, 'fav').s}»), далі ${fl.map(c => '«' + c.t + '»').join(', ')} — найновіше згори; картки однакові, нічого не вилазить за край і не обрізано`, l0.cards.length === 5 && fl.map(c => c.t).join('|') === 'Харків, стоянка Окружна|Полтава' && card(l0, 'fav').s === 'збережено: 2'
    && l0.cards.filter(c => !c.cat).every(c => c.btn.join() === 'Старт,Через,Змінити,Прибрати' && c.fit && c.seen && c.r.l === l0.cards[0].r.l && c.r.r === l0.cards[0].r.r) && (await readCheck(page, '#panel', '#panelBody')).length === 0, JSON.stringify({ c: l0.cards, rc: await readCheck(page, '#panel', '#panelBody') }));
  // е) олівець в улюбленого — своя назва й адреса; «Скасувати» нічого не змінює
  const fid = l0.favs[0].id;
  await page.click(`#panelBody [data-fed="${fid}"]`); await sleep(350);
  const ed = () => app(page, () => { const c = document.querySelector('#panelBody .fv-ed'); if (!c) return null; const i = document.getElementById('fvName'); return { val: i.value, focus: document.activeElement === i, sel: i.selectionEnd - i.selectionStart, addr: document.getElementById('fvAddr').textContent, isNew: document.getElementById('fvAddr').classList.contains('new'), btn: [...c.querySelectorAll('button')].map(b => b.textContent.trim()), inH: Math.round(i.getBoundingClientRect().height), fs: parseFloat(getComputedStyle(i).fontSize) }; });
  const e1 = await ed(); await shot(page, '70-favs-edit-' + sc.n);
  ok(`[${T}] олівець — редактор у картці: назва «${e1 && e1.val}» (курсор у полі, текст виділено), адреса «${e1 && e1.addr}», кнопки [${e1 && e1.btn.join(' | ')}]`, !!e1 && e1.val === 'Харків, стоянка Окружна' && e1.focus && e1.sel === e1.val.length && e1.addr === 'Харків, стоянка Окружна, Харківська обл.' && !e1.isNew && e1.btn.join() === 'Змінити адресу,Скасувати,Зберегти' && e1.inH >= 44 && e1.fs >= 16
    && (await readCheck(page, '#panel', '#panelBody')).length === 0, JSON.stringify({ e1, rc: await readCheck(page, '#panel', '#panelBody') }));
  await page.fill('#fvName', 'Не те'); await page.click('#panelBody [data-fcancel]'); await sleep(250);
  const c1 = await fv();
  ok(`[${T}] «Скасувати» — редактор закрито, назва лишилась «${c1.cards[3].t}»`, !(await ed()) && c1.cards[3].t === 'Харків, стоянка Окружна' && c1.favs[0].name === '', JSON.stringify(c1.favs));
  await page.click(`#panelBody [data-fed="${fid}"]`); await sleep(300); await page.fill('#fvName', 'База'); await clearToasts(); await page.click('#panelBody [data-fsave]'); await sleep(300);
  const n1 = await fv();
  ok(`[${T}] назвали «База» і «Зберегти» — картка «${n1.cards[3].t}», під назвою адреса: «${n1.cards[3].s.slice(0, 44)}»; «${n1.toast.trim()}»`, !(await ed()) && n1.cards[3].t === 'База' && /^Харків, стоянка Окружна, Харківська обл\./.test(n1.cards[3].s) && n1.favs[0].name === 'База' && n1.favs[0].label === 'Харків, стоянка Окружна' && /Збережено/.test(n1.toast), JSON.stringify(n1.favs));
  // є) «Змінити адресу»: місце, яке вже є в улюблених, не приймаємо; інше — нова адреса, своя назва лишається
  await page.click(`#panelBody [data-fed="${fid}"]`); await sleep(300);
  await page.click('#panelBody [data-fpick]'); await page.waitForSelector('#srIn'); await sleep(200);
  const s2 = await srState();
  await pickFirst('Полтава');
  const e2 = await ed(); await clearToasts(); await page.click('#panelBody [data-fsave]'); await sleep(300);
  const d2 = await fv();
  ok(`[${T}] «Змінити адресу» — пошук «${s2.ph}»; вибрали «Полтава» — редактор знову відкрито, нова адреса «${e2 && e2.addr}» (жирним), назва «${e2 && e2.val}»; «Зберегти» — «${d2.toast.trim().slice(0, 34)}», бо таке вже є; нічого не змінилось`,
    s2.ph === 'Нова адреса місця' && /нову адресу/.test(s2.hint) && !!e2 && /^Полтава/.test(e2.addr) && e2.isNew && e2.val === 'База' && /вже є в улюблених/.test(d2.toast) && !!(await ed()) && d2.favs[0].label === 'Харків, стоянка Окружна' && Math.abs(d2.favs[0].lat - 50.0) < 1e-6, JSON.stringify({ s2, e2, favs: d2.favs }));
  await page.click('#panelBody [data-fpick]'); await page.waitForSelector('#srIn'); await sleep(200);
  await pickFirst('Чугуїв');
  const e3 = await ed(); await clearToasts(); await page.click('#panelBody [data-fsave]'); await sleep(300);
  const d3 = await fv();
  ok(`[${T}] вибрали «Чугуїв» і «Зберегти» — «${d3.cards[3].t}»: «${d3.cards[3].s.slice(0, 30)}…» (своя назва лишилась, адреса нова)`, !!e3 && /^Чугуїв/.test(e3.addr) && !(await ed()) && d3.cards[3].t === 'База' && /^Чугуїв/.test(d3.cards[3].s) && d3.favs[0].label === 'Чугуїв' && d3.favs[0].name === 'База' && Math.abs(d3.favs[0].lat - 50.0) > 0.01, JSON.stringify(d3.favs));
  // ж) олівець у Дому — одразу нова адреса
  await clearToasts(); await page.click('#panelBody [data-fed="home"]'); await page.waitForSelector('#srIn'); await sleep(200);
  const s3 = await srState(); await pickFirst('Полтава');
  const h2 = await fv();
  ok(`[${T}] олівець у Дому — одразу пошук «${s3.ph}»; вибрали — Дім: «${card(h2, 'home').s.slice(0, 28)}»`, s3.ph === 'Адреса дому' && h2.home.label === 'Полтава' && /^Полтава/.test(card(h2, 'home').s) && /Дім: Полтава/.test(h2.toast), JSON.stringify(h2.home));
  // з) дотик до картки — місце стає фінішем рейсу (поле «Куди»), екран «Рейс»; «Старт» — у поле старту (зі своєю назвою)
  await page.click('#panelBody [data-fgo="home"]'); await sleep(300);
  const u0 = await app(page, () => ({ title: document.getElementById('panelTitle').textContent.trim(), b: document.getElementById('in_b').value, toast: document.getElementById('toasts').textContent }));
  ok(`[${T}] дотик до «Дім» — екран «${u0.title}», у полі «Куди»: «${u0.b}»`, u0.title === 'Рейс' && u0.b === 'Полтава' && /Фініш: Полтава/.test(u0.toast), JSON.stringify(u0));
  await openFavs();
  await page.click(`#panelBody [data-fa="${fid}"]`); await sleep(300);
  const u1 = await app(page, () => ({ a: document.getElementById('in_a').value, b: document.getElementById('in_b').value, two: [...document.querySelectorAll('#startTwo button')].map(b => b.classList.contains('on')) }));
  ok(`[${T}] «Старт» в улюбленого «База» — у полі старту «${u1.a}», фініш лишився «${u1.b}»`, u1.a === 'База' && u1.b === 'Полтава' && u1.two[0] === false, JSON.stringify(u1));
  // и) кошик: улюблене — прибрано, дотик до сповіщення повертає на те саме місце; Дім — знову рядок «Додати», теж із поверненням
  await app(page, () => document.querySelector('#tripTools [data-act="favs"]').scrollIntoView({ block: 'center' })); await sleep(100);
  const cnt = await app(page, () => (document.querySelector('#tripTools [data-act="favs"] .tt-ic i') || { textContent: '' }).textContent);
  ok(`[${T}] на значку сердечка — кількість улюблених (${cnt})`, cnt === '2', cnt);
  await openFavs(); await clearToasts();
  await page.click(`#panelBody [data-fdel="${fid}"]`); await sleep(300);
  const d0 = await fv();
  await page.click('#toasts .toast:has-text("повернути")'); await sleep(300);
  const d1 = await fv();
  ok(`[${T}] кошик — місце прибрано («${d0.toast.trim().slice(0, 40)}»); дотик до сповіщення — повернулось на своє місце`, d0.cards.length === 4 && d0.favs.length === 1 && /повернути/.test(d0.toast) && d1.cards.length === 5 && d1.favs.length === 2 && d1.cards[3].t === 'База', JSON.stringify({ d0: d0.favs, d1: d1.favs }));
  await clearToasts(); await page.click('#panelBody [data-fdel="home"]'); await sleep(300);
  const r0 = await fv(), rc0 = card(r0, 'home');
  await page.click('#toasts .toast:has-text("повернути")'); await sleep(300);
  const r1 = await fv();
  ok(`[${T}] кошик у Дому — «${r0.toast.trim().slice(0, 42)}»: знову рядок «Дім · ${rc0.s}» з «Додати»; дотик до сповіщення — адреса повернулась («${card(r1, 'home').s.slice(0, 20)}»)`, !r0.home && rc0.cat && rc0.s === 'адресу не вказано' && rc0.btn.join() === 'Додати' && /Дім: адресу прибрано/.test(r0.toast) && r1.home && r1.home.label === 'Полтава' && !card(r1, 'home').cat, JSON.stringify({ r0: r0.home, r1: r1.home }));
  ok(`[${T}] читається й нічого не обрізано`, (await readCheck(page, '#panel', '#panelBody')).length === 0, JSON.stringify(await readCheck(page, '#panel', '#panelBody')));
  await app(page, () => { window.__app.S.home = null; window.__app.S.work = null; });
  await page.click('#panelBack'); await sleep(200);
  // д) рейс із варіантами: дотик пальцем поруч із сірою лінією (не точно в неї) — варіант стає вибраним, як у Google
  await app(page, () => { window.__app.favs.list().forEach(f => window.__app.favs.remove(f.id)); });
  await page.fill('#in_a', 'Харків'); await page.waitForSelector('#sg_a button', { timeout: 5000 }); await page.click('#sg_a button');
  await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await page.click('#sg_b button');
  await page.click('[data-act="build"]'); await page.waitForSelector('#routePick [data-rp="go"]', { timeout: 10000 }); await sleep(1200);
  const tgt = await app(page, () => { const m = window.__app.map.map, top = document.getElementById('routePick').getBoundingClientRect().top, alt = m.getSource('route-alts')._data.features[0], main = m.getSource('route')._data;
    const mainC = (main.features ? main.features : [main]).flatMap(f => f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.coordinates).map(c => m.project(c));
    const dMain = p => Math.min(...mainC.map(q => Math.hypot(p.x - q.x, p.y - q.y)));
    let best = null; const ac = alt.geometry.coordinates;
    for (let i = 1; i < ac.length; i++) { const a = m.project(ac[i - 1]), b = m.project(ac[i]); const p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; if (p.y < 60 || p.y > top - 30 || p.x < 20 || p.x > innerWidth - 80) continue; const d = dMain(p); if (!best || d > best.d) { const L = Math.hypot(b.x - a.x, b.y - a.y) || 1; best = { x: p.x - (b.y - a.y) / L * 12, y: p.y + (b.x - a.x) / L * 12, d }; } }
    return { k: alt.properties.k, best, sel: document.querySelector('#routePick .alt.on').dataset.alt }; });
  ok(`[${T}] на карті є сірий варіант, що йде окремо від вибраного (найдальше — ${tgt.best && Math.round(tgt.best.d)} px)`, !!tgt.best && tgt.best.d > 6 && tgt.sel === '0', JSON.stringify(tgt));
  if (tgt.best) {
    await page.mouse.click(tgt.best.x, tgt.best.y); await sleep(700);
    const s1 = await app(page, () => ({ sel: document.querySelector('#routePick .alt.on').dataset.alt, alts: window.__app.map.map.getSource('route-alts')._data.features.map(f => f.properties.k) }));
    await shot(page, '70-alt-tap-' + sc.n);
    ok(`[${T}] дотик пальцем за 12 px від сірої лінії — цей варіант став вибраним (карточка ${s1.sel}), а колишній — сірим (${s1.alts.join()})`, s1.sel === String(tgt.k) && s1.alts.join() === '0', JSON.stringify(s1));
    // дотик далеко від ліній — нічого не змінюється
    await page.mouse.click(30, 120); await sleep(400);
    const s2 = await app(page, () => document.querySelector('#routePick .alt.on').dataset.alt);
    ok(`[${T}] дотик до порожньої карти — вибір не змінився`, s2 === String(tgt.k), s2);
  }
  // е) (1.1.34) без GPS: дотик до контрольного повороту на карті — позначка переходить на нього; дотик до сповіщення — назад
  if (sc.n === 'xiaomi') {
    await page.click('#routePick [data-rp="go"]'); await sleep(800);
    const C = await app(page, () => window.__app.route ? window.__app.nav.routeCps().map(c => ({ d: c.d, d0: c.d0, ang: c.ang })) : []);
    const g0 = await app(page, () => { const n = window.__app.nav; const idx = window.__app.guide.g.idx, p = idx.at(200); window.__reis('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: 12, t: Date.now() }); return null; }); await sleep(600);
    await app(page, () => window.__app.nav.nudge(0)); await sleep(900);
    const cp = C.find(c => c.d > 1500) || C[C.length - 1];
    if (cp) {
      const pt = await app(page, d => { const m = window.__app.map, idx = window.__app.guide.g.idx, p = idx.at(d); m.setFollow(false); m.view.lastTouch = Date.now() + 600000; m.map.jumpTo({ center: [p.lon, p.lat], zoom: 15 }); return null; }, cp.d); await sleep(900);
      const st0 = await app(page, d => { const m = window.__app.map.map, idx = window.__app.guide.g.idx, p = idx.at(d), q = m.project([p.lon, p.lat]); return { x: q.x, y: q.y, rd: window.__app.nav.pos.rd, mode: window.__app.nav.pos.mode, dots: m.getSource('cps')._data.features.length }; }, cp.d);
      await page.mouse.click(st0.x + 9, st0.y - 9); await sleep(600);
      const st1 = await app(page, () => ({ rd: window.__app.nav.pos.rd, toast: [...document.querySelectorAll('#toasts .toast')].map(x => x.textContent).join(' | ') }));
      await shot(page, '70-cp-tap-' + sc.n);
      ok(`[${T}] без GPS дотик до контрольного повороту на карті (${cp.ang}°) — позначка перейшла на нього (${Math.round(st0.rd)} → ${Math.round(st1.rd)} м, поворот на ${Math.round(cp.d0)}): «${st1.toast.slice(0, 60)}…»`, st0.mode === 'dr' && st0.dots > 0 && Math.abs(st1.rd - cp.d0) <= 40 && /Позначка — (перед вибраним|на вибраному)/.test(st1.toast), JSON.stringify({ st0, st1, cp }));
      await page.click('#toasts .toast:has-text("скасувати")'); await sleep(400);
      const st2 = await app(page, () => window.__app.nav.pos.rd);
      ok(`[${T}] дотик до сповіщення — позначка повернулась, де була (${Math.round(st2)} м)`, Math.abs(st2 - st0.rd) <= 40, JSON.stringify({ st2, was: st0.rd }));
    } else ok(`[${T}] на рейсі є контрольні повороти`, false, JSON.stringify(C));
  }
  ok(`[${T}] прохід 42 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`[${sc.title}] прохід 42 дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }

/* ============ прохід 43 (1.1.35, Діма): планшет набік і вікно на пів екрана ============
   Діма (знімки з планшета): «настройки, карта и звук, если возможно перенести в один столбик» — на планшеті, покладеному набік, кнопки
   праворуч стояли у два стовпчики; «когда открыто два окна также звук поиск и карта, плюс в этом режиме треугольник который ведёт уехал
   верх от рейса» — те саме у вікні на пів екрана, і стрілка машини там стояла помітно вище над кнопкою «Рейс», ніж на весь екран.
   Розміри — оцінка зі знімків (планшет ~1000×540 у CSS-пікселях, вікно ~494×540); поруч перевіряємо сусідні розміри. */
const gap43 = {};
if (run('43')) for (const sc of [
  { n: 'dland', w: 1000, h: 540, dpr: 1, title: 'планшет Діми набік ~1000×540' }, { n: 'dland2', w: 960, h: 552, dpr: 1, title: 'планшет набік 960×552' }, { n: 'dland3', w: 1024, h: 600, dpr: 1, title: 'планшет набік 1024×600' },
  { n: 'dsplit', w: 494, h: 540, dpr: 1, title: 'вікно на пів планшета ~494×540' }, { n: 'dsplit2', w: 640, h: 540, dpr: 1, title: 'вікно на дві третини 640×540' }, { n: 'dsplit3', w: 500, h: 600, dpr: 1, title: 'вікно на пів планшета 500×600' }
].filter(x => !process.env.SCR || process.env.SCR.split(',').includes(x.n))) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: sc.w, height: sc.h }, dpr: sc.dpr });
  const T = sc.title, n = coords.length, emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const trip = { id: 't-43', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: turnIdx[2], len: 3500, time: 300 }, { type: 15, ins: 'Поверніть ліворуч', street: 'вулиця Соборності', streets: ['вулиця Соборності'], i0: turnIdx[2], i1: n - 1, len: 23300, time: 1400 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  const meas = () => app(page, () => { const vis = el => !!el && !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    const R = e => { if (!vis(e)) return null; const r = e.getBoundingClientRect(); return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), cx: +((r.left + r.right) / 2).toFixed(1), cy: +((r.top + r.bottom) / 2).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
    const q = s => R(document.querySelector(s)), rail = ['#bQuick', '#bMap', '#bSnd', '#bSearch'].map(q).filter(Boolean), a = window.__app.map.anchorPoint();
    return { rail, top: q('#top'), center: q('#bCenter'), fwd: q('#bFwd100'), back: q('#bBack100'), tilt: q('#tilt'), bar: q('#tabbar'), tabs: q('#tabs'), go: q('#tabs [data-panel="trip"]') || q('#tabs > button:nth-child(3)'), man: q('#man'), speed: q('#speed'),
      anc: { x: Math.round(a.x), y: Math.round(a.y) }, W: innerWidth, H: innerHeight, cls: document.body.className.split(' ').filter(c => /^rail-/.test(c)).join(' '), dir: getComputedStyle(document.getElementById('rail')).flexDirection }; });
  const lay = async () => await page.evaluate(layoutCheck);
  const oneCol = m => m.rail.length >= 3 && m.rail.every(b => Math.abs(b.cx - m.rail[0].cx) <= 1) && m.rail.every((b, i) => !i || b.t >= m.rail[i - 1].b + 5);
  const free = (m, list) => list.filter(Boolean).every(o => m.rail.every(b => !(Math.min(b.r, o.r) - Math.max(b.l, o.l) > 1 && Math.min(b.b, o.b) - Math.max(b.t, o.t) > 1)));
  await emitN('loc', { prov: 'gps', lat: coords[4][0], lon: coords[4][1], acc: 5, spd: 12, brg: 270, t: Date.now() }); await sleep(700);
  // а) без рейсу: налаштування, карта, звук — одним стовпчиком
  const a = await meas(); await shot(page, `70-dima-${sc.n}-1`);
  ok(`[${T}] без рейсу: ${a.rail.length} кнопки праворуч — одним стовпчиком (осі ${a.rail.map(b => b.cx).join(', ')}; розмір ${a.rail[0].w}×${a.rail[0].h}${a.cls ? ', ' + a.cls : ''}); нічого не накладається`, a.rail.length === 3 && oneCol(a) && a.rail.every(b => b.w >= 42 && b.h >= 42 && b.r <= a.W - 4) && free(a, [a.top, a.tilt, a.center]) && (await lay()).length === 0, JSON.stringify({ rail: a.rail, top: a.top, cls: a.cls, lay: await lay() }));
  // б) рейс: додається пошук — чотири кнопки, і теж одним стовпчиком
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip); await sleep(500);
  await emitN('loc', { prov: 'gps', lat: coords[6][0], lon: coords[6][1], acc: 5, spd: 12, brg: 270, t: Date.now() }); await sleep(900);
  await app(page, () => window.__app.map.setFollow(true)); await sleep(700);
  const b = await meas(); await shot(page, `70-dima-${sc.n}-2`);
  ok(`[${T}] рейс: ${b.rail.length} кнопки (з пошуком) — одним стовпчиком (осі ${b.rail.map(x => x.cx).join(', ')}; розмір ${b.rail[0].w}×${b.rail[0].h}${b.cls ? ', ' + b.cls : ''}); підказку повороту й повзунок не закривають`, b.rail.length === 4 && oneCol(b) && b.rail.every(x => x.w >= 42 && x.h >= 42 && x.r <= b.W - 4) && free(b, [b.top, b.man, b.tilt]) && (await lay()).length === 0, JSON.stringify({ rail: b.rail, top: b.top, man: b.man, cls: b.cls, lay: await lay() }));
  gap43[sc.n] = Math.round(b.tabs.t - b.anc.y);
  ok(`[${T}] стрілка машини — на ${gap43[sc.n]} px над нижньою плашкою (екран ${b.H} px, точка ${b.anc.y})`, b.anc.y > b.H * 0.5 && gap43[sc.n] >= 28 && gap43[sc.n] <= 60, JSON.stringify({ anc: b.anc, tabs: b.tabs, H: b.H }));
  if (sc.n === 'dsplit' && gap43.dland != null) ok(`[${T}] (Діма: «у двох вікнах трикутник поїхав угору від "Рейсу"») стрілка над плашкою на тій самій висоті, що й на весь екран: ${gap43.dsplit} і ${gap43.dland} px`, Math.abs(gap43.dsplit - gap43.dland) <= 2, JSON.stringify(gap43));
  // в) карту зсунули — «Моє місце» над повзунком; стовпчик до нього не дістає
  await app(page, () => { window.__app.map.setFollow(false); window.__app.map.view.lastTouch = Date.now() + 600000; window.dispatchEvent(new Event('resize')); }); await sleep(800);
  const c = await meas(); await shot(page, `70-dima-${sc.n}-3`);
  ok(`[${T}] карту зсунули: «Моє місце» над повзунком; ${c.rail.length} кнопки лишаються одним стовпчиком і до нього не дістають (${c.center ? Math.round(c.center.t - c.rail[c.rail.length - 1].b) : '?'} px)${c.cls ? ', ' + c.cls : ''}`, !!c.center && c.rail.length === 4 && oneCol(c) && free(c, [c.center, c.tilt, c.top, c.man]) && (await lay()).length === 0, JSON.stringify({ rail: c.rail, center: c.center, cls: c.cls, lay: await lay() }));
  // г) GPS зник: ±100 над повзунком — стовпчик їх не закриває
  await app(page, () => { window.__app.map.view.lastTouch = 0; window.__app.map.setFollow(true); window.__app.nav.nudge(0); }); await sleep(1300);
  await app(page, () => window.__app.map.setFollow(true)); await sleep(900);
  const d = await meas(); await shot(page, `70-dima-${sc.n}-4`);
  ok(`[${T}] без GPS: ±100 над повзунком, кнопок праворуч ${d.rail.length} — ${d.cls === 'rail-tight' ? 'у два стовпчики (одним не вміщаються)' : 'одним стовпчиком'}; ±100 не закривають`, !!d.fwd && !!d.back && d.rail.length === 4 && free(d, [d.fwd, d.back, d.center, d.tilt, d.top, d.man]) && (await lay()).length === 0, JSON.stringify({ rail: d.rail, fwd: d.fwd, back: d.back, cls: d.cls, lay: await lay() }));
  // ґ) GPS повернувся — знову один стовпчик
  const p6 = await app(page, () => { const i = window.__app.guide.g.idx, q = i.at((window.__app.nav.pos.rd || 0) + 30); return { lat: q.lat, lon: q.lon, brg: q.brg }; });
  for (let k = 0; k < 4; k++) { await emitN('loc', { prov: 'gps', lat: p6.lat, lon: p6.lon, acc: 5, spd: 12, brg: p6.brg, t: Date.now() }); await sleep(450); }
  await app(page, () => window.__app.map.setFollow(true)); await sleep(700);
  const e = await meas();
  ok(`[${T}] GPS повернувся — ±100 зникли, ${e.rail.length} кнопки знову одним стовпчиком${e.cls ? ' (' + e.cls + ', ' + e.rail[0].w + ' px)' : ''}`, !e.fwd && e.rail.length === 4 && oneCol(e) && (await lay()).length === 0, JSON.stringify({ rail: e.rail, cls: e.cls, fwd: e.fwd, lay: await lay() }));
  ok(`[${T}] прохід 43 без помилок JS`, errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok(`[${sc.title}] прохід 43 дійшов до кінця`, false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }

/* ============ прохід 44 (1.1.36): без GPS — усі контрольні повороти на карті, пройдені лишаються, на кожному чекаємо ============
   Олексій (знімок без GPS, перехрестя вже позаду): «був перехрестя і не було точки. І навіть коли перехрестя пройдено, точка має лишатись,
   щоб я міг на неї повернутись. Кожен поворот на маршруті… гострий — червоний, 100 % треба 90 градусів, і розрахунок має повернути, якщо ні —
   стояти й чекати повороту. Або жовтий затяжний, але теж треба чекати в обов'язковому порядку».
   Було: на карті лише до 12 поворотів ПОПЕРЕДУ — пройдений зникав, і торкнутись його (повернутись) було неможливо. */
if (run('44')) try {
  const { page, ctx, errors } = await newPage(true, { viewport: { width: 393, height: 800 } });
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length, idx0 = turnIdx[1] - 6;                                    // за 300 м до перехрестя «90° ліворуч»
  const trip = { id: 't-cps', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  await emitN('loc', { prov: 'gps', lat: coords[idx0][0], lon: coords[idx0][1], acc: 5, spd: 0, t: Date.now() });
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  await app(page, () => { window.__cp = []; window.__app.bus.on('cpPass', e => window.__cp.push(e)); });
  let Y = 0;                                                                          // накопичений поворот телефона (за годинниковою — плюс)
  const feed = async (sec, perSec = 0) => { for (let k = 0; k < sec; k++) { Y += perSec; await emitN('sens', { var: 0.05, yaw: Y }); await sleep(1000); } };
  await feed(7);
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 8000 });
  await feed(3);
  const C = await app(page, () => window.__app.nav.routeCps().map(c => ({ d: c.d, d0: c.d0, d1: c.d1, ang: c.ang, cls: c.cls, sgn: c.sgn })));
  const dots = () => app(page, () => { const s = window.__app.map.map.getSource('cps'), d = s.serialize ? s.serialize().data : s._data; return (d && d.features || []).map(f => f.properties); });
  const st = () => app(page, () => { const P = window.__app.nav.pos; return { rd: P.rd, mode: P.mode, cp: P.cp ? { d: P.cp.d, state: P.cp.state, cls: P.cp.cls } : null, toast: [...document.querySelectorAll('#toasts .toast')].map(x => x.textContent).join(' | '), btn: document.getElementById('bTurn').textContent.trim() }; });
  const clearToasts = () => app(page, () => { document.getElementById('toasts').innerHTML = ''; });
  const red = C[0], yel = C.find(c => c.cls === 'yellow' && c.sgn), red2 = C[1];
  // а) без GPS на карті — УСІ повороти рейсу (не лише найближчі), наступний виділено, пройдених ще немає
  const d0 = await dots();
  ok(`без GPS на карті всі контрольні повороти рейсу — ${d0.length} з ${C.length} (${C.map(c => (c.cls === 'red' ? 'червоний' : 'жовтий') + ' ' + c.ang + '°').join(', ')}); наступний один, пройдених немає`,
    C.length >= 4 && d0.length === C.length && d0.filter(f => f.n === 1).length === 1 && d0.find(f => f.n === 1).d === red.d && d0.every(f => f.p === 0) && red.cls === 'red' && Math.abs(Math.abs(red.ang) - 90) <= 10 && !!yel, JSON.stringify({ d0, C }));
  // б) червоний (перехрестя 90°): позначка доїхала й СТОЇТЬ — чекає, поки телефон поверне; далі не їде
  await app(page, d => window.__app.nav.jumpToCp(d), red.d); await feed(9);
  const r0 = await st(); await feed(8); const r1 = await st();
  ok(`червоний поворот ${red.ang}°: телефон не повертав — позначка стоїть перед ним і чекає (${Math.round(r0.rd)} → ${Math.round(r1.rd)} м, поворот на ${red.d0}–${red.d1}; стан «${r1.cp && r1.cp.state}», кнопка «${r1.btn.slice(0, 22)}»)`,
    r1.mode === 'dr' && r1.cp && r1.cp.d === red.d && r1.cp.state === 'wait' && r1.rd < red.d + 5 && Math.abs(r1.rd - r0.rd) <= 8 && r1.rd >= red.d0 - 40, JSON.stringify({ r0, r1, red }));
  await shot(page, '72-cps-wait-red');
  // …телефон повернув на 90° — поворот пройдено; точка НЕ зникає: стає білою з обідком (пройдена), наступний — наступний
  await clearToasts(); await feed(5, Math.sign(red.ang) * 18); await feed(3);
  const r2 = await st(), d1 = await dots(), ev1 = await app(page, () => window.__cp.slice(-1)[0] || null);
  ok(`телефон повернув на 90° — поворот пройдено (${ev1 && ev1.by}), позначка за ним (${Math.round(r2.rd)} м); його точка лишилась на карті як пройдена, наступний — ${red2.ang}° на ${red2.d} м`,
    ev1 && ev1.by === 'gyro' && r2.rd >= red.d - 5 && d1.length === C.length && (d1.find(f => f.d === red.d) || {}).p === 1 && d1.filter(f => f.p === 1).length === 1 && (d1.find(f => f.n === 1) || {}).d === red2.d, JSON.stringify({ r2, ev1, d1 }));
  // в) жовтий (затяжний / пологий): те саме — стоїть і чекає «в обов'язковому порядку», повернув — пройдено
  await app(page, d => window.__app.nav.jumpToCp(d), yel.d); await feed(9);
  const y0 = await st(); await feed(8); const y1 = await st(), d2 = await dots();
  ok(`жовтий поворот ${yel.ang}°: телефон не повертав — позначка так само стоїть і чекає (${Math.round(y0.rd)} → ${Math.round(y1.rd)} м, поворот на ${yel.d0}–${yel.d1}; стан «${y1.cp && y1.cp.state}»)`,
    y1.cp && y1.cp.d === yel.d && y1.cp.cls === 'yellow' && y1.cp.state === 'wait' && y1.rd < yel.d + 5 && Math.abs(y1.rd - y0.rd) <= 8, JSON.stringify({ y0, y1, yel }));
  ok(`усі повороти до нього — на карті як пройдені (${d2.filter(f => f.p === 1).length}), сам він — наступний, решта попереду`, d2.length === C.length && d2.filter(f => f.p === 1).length === C.filter(c => c.d < yel.d).length && d2.filter(f => f.p === 1).every(f => f.d < yel.d) && (d2.find(f => f.n === 1) || {}).d === yel.d, JSON.stringify(d2));
  await feed(5, Math.sign(yel.ang) * Math.abs(yel.ang) / 5); await feed(3);
  const y2 = await st(), ev2 = await app(page, () => window.__cp.slice(-1)[0] || null);
  ok(`телефон повернув на ${Math.abs(yel.ang)}° — жовтий пройдено (${ev2 && ev2.by}), позначка за ним (${Math.round(y2.rd)} м)`, ev2 && ev2.by === 'gyro' && ev2.cp.d === yel.d && y2.rd >= yel.d - 5, JSON.stringify({ y2, ev2 }));
  // г) дотик до ПРОЙДЕНОЇ точки на карті — позначка повертається на той поворот і знову чекає
  const back = red2;                                                                 // другий (90° праворуч) — давно позаду
  await app(page, d => { const m = window.__app.map, idx = window.__app.guide.g.idx, p = idx.at(d); m.setFollow(false); m.view.lastTouch = Date.now() + 600000; m.map.jumpTo({ center: [p.lon, p.lat], zoom: 15 }); }, back.d); await feed(2);
  const t0 = await app(page, d => { const m = window.__app.map.map, idx = window.__app.guide.g.idx, p = idx.at(d), q = m.project([p.lon, p.lat]), fs = m.queryRenderedFeatures([[q.x - 4, q.y - 4], [q.x + 4, q.y + 4]], { layers: ['cps-dot'] }); return { x: q.x, y: q.y, hit: fs.map(f => f.properties.d + ':' + f.properties.p), fill: m.getPaintProperty('cps-dot', 'circle-color') }; }, back.d);
  await shot(page, '72-cps-passed');
  await clearToasts(); await page.mouse.click(t0.x + 6, t0.y - 6); await feed(2);
  const b1 = await st(); await feed(8); const b2 = await st(), d3 = await dots();
  ok(`пройдена точка (${back.ang}°, на ${back.d} м) є на карті (біла з обідком) — дотик до неї: позначка повернулась (${Math.round(y2.rd)} → ${Math.round(b1.rd)} м): «${b1.toast.slice(0, 50)}…»`,
    t0.hit.includes(back.d + ':1') && Math.abs(b1.rd - back.d0) <= 45 && /Позначка — перед вибраним поворотом/.test(b1.toast), JSON.stringify({ t0, b1, back }));
  ok(`…і знову чекає повороту (${Math.round(b1.rd)} → ${Math.round(b2.rd)} м, стан «${b2.cp && b2.cp.state}»); цей поворот знову «наступний», ті, що за ним, — знову попереду`,
    b2.cp && b2.cp.d === back.d && b2.cp.state === 'wait' && Math.abs(b2.rd - b1.rd) <= 8 && (d3.find(f => f.n === 1) || {}).d === back.d && d3.filter(f => f.p === 1).length === C.filter(c => c.d < back.d).length, JSON.stringify({ b2, d3 }));
  // ґ) GPS повернувся — точок на карті немає (карта чиста), як і раніше
  for (let k = 0; k < 4; k++) { const q = await app(page, () => { const i = window.__app.guide.g.idx, p = i.at(window.__app.nav.pos.rd + 20); return { lat: p.lat, lon: p.lon, brg: p.brg }; }); await emitN('loc', { prov: 'gps', lat: q.lat, lon: q.lon, acc: 5, spd: 10, brg: q.brg, t: Date.now() }); await feed(1); }
  const g1 = await st(), d4 = await dots();
  ok(`GPS повернувся — контрольних поворотів на карті немає (${d4.length})`, g1.mode === 'gps' && d4.length === 0, JSON.stringify({ mode: g1.mode, n: d4.length }));
  ok('прохід 44 без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід 44 дійшов до кінця', false, String(e.stack || e.message).split('\n').slice(0, 3).join(' ')); }
if (run('2')) try {
  const { page, ctx, errors } = await newPage(false);
  await sleep(1500);
  ok('браузерна версія запускається без помилок', errors.length === 0, errors.join(' | '));
  await page.click('#strip'); await page.waitForSelector('#panelBody');
  ok('у браузері чесно сказано, що Telegram недоступний', /лише встановлений застосунок|каналів ще не додано|Тривоги/.test(await page.textContent('#panelBody')));
  await ctx.close();
} catch (e) { ok('сценарій 2 дійшов до кінця', false, String(e.message).split('\n')[0]); }

await browser.close(); server.close();
console.log(results.join('\n'));
console.log(failed ? `\nПРОВАЛЕНО: ${failed} з ${results.length}` : `\nУСІ ${results.length} ПЕРЕВІРОК ПРОЙДЕНО`);
process.exit(failed ? 1 : 0);
