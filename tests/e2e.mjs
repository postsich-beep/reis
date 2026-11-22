// Наскрізна перевірка веб-шару в безголовому Chromium. Усі зовнішні сервіси підмінені:
// маршрут, пошук, Overpass, Telegram, тривоги. Перевіряється логіка, а не живі сервери.
// Запуск:  node tests/e2e.mjs [--shots dir]
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
// ONLY=1,2д node tests/e2e.mjs — лише вибрані проходи (для налагодження)
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean), run = id => !ONLY.length || ONLY.includes(id);
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let rangeHits = 0;
const server = createServer(async (rq, rs) => {
  try {
    const p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
    if (p === '/offline/ukraine.pmtiles') {                     // як оболонка: файл карти шматками за заголовком Range
      const b = await readFile(join(ROOT, '..', 'tests', 'fixtures', 'tiny.pmtiles'));
      const m = /bytes=(\d+)-(\d*)/.exec(rq.headers.range || '');
      if (!m) { rs.writeHead(200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' }); rs.end(b); return; }
      const s = +m[1], e = Math.min(m[2] ? +m[2] : b.length - 1, b.length - 1); rangeHits++;
      rs.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${s}-${e}/${b.length}`, 'content-length': e - s + 1, 'accept-ranges': 'bytes' });
      rs.end(b.subarray(s, e + 1)); return;
    }
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
  { id: 'test-noloc', kind: 'food', name: 'Без точки', rating: 5, checked: '2026-11', photos: ['verified/bistro-6.jpg'], thumbs: ['verified/bistro-6-s.jpg'], say: { uk: 'Тест', ru: 'Тест' } }] };

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
  [48.66, 25.51, 'v', 'Львівка', '', 'chernivtsi', 0], [50.02, 30.12, 'v', 'Харківці', '', 'kyiv', 0], [B[0], B[1], 'c', 'Полтава-тест', '', 'poltava', 1]
] };
// проблемні для фури місця (як web/data/hazards.json, формат 2): міст 20 т на М-03 уздовж маршруту,
// низький проїзд на вулиці навхрест (має ігноруватися), ґрунт 1,2 км, міст 55 т (фурі не заважає)
const HAZ_JSON = (() => {
  const groups = [['w', 20, 'М-03', 300, 1], ['h', 3.8, 'вулиця Навхрест', 50, 0], ['u', 2, 'Т-2101', 1200, 0], ['w', 55, 'М-03', 100, 1]];
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
const results = [], routeReqs = []; let failed = 0;
const ok = (name, cond, extra = '') => { results.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  — ' + extra : '')); if (!cond) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newPage(native, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 412, height: 892 }, deviceScaleFactor: opts.dpr || 2, isMobile: true, hasTouch: true, locale: 'uk-UA' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await page.route('**/data/stops.json', r => json(r, STOPS_JSON));
  await page.route('**/data/places.json', r => json(r, PLACES_JSON));
  await page.route('**/data/hazards.json', r => json(r, HAZ_JSON));
  await page.route('**/styles/liberty', r => json(r, { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dde5d8' } }] }));
  await page.route('**/route?json=*', r => { const q = JSON.parse(new URL(r.request().url()).searchParams.get('json')); routeReqs.push(q); json(r, q.alternates ? { ...tripJson, alternates: [{ trip: altTrip }] } : tripJson); });
  await page.route('**/data/verified.json', r => json(r, VP_JSON));
  await page.route('**/v1/forecast*', r => {
    const u = new URL(r.request().url()), n = u.searchParams.get('latitude').split(',').length, t0 = Math.floor(Date.now() / 3600e3) * 3600;
    const time = Array.from({ length: 48 }, (_, i) => t0 + i * 3600), z = v => time.map(() => v);
    json(r, Array.from({ length: n }, (_, i) => ({ hourly: { time, temperature_2m: z(-2), precipitation: z(i === 0 ? 1.1 : 0), snowfall: z(i === 0 ? 1.2 : 0), weather_code: z(i === 0 ? 73 : 3), wind_gusts_10m: z(20), visibility: z(20000) } })));
  });
  await page.route('**/api/?q=*', r => { const q = decodeURIComponent(new URL(r.request().url()).searchParams.get('q')).toLowerCase();
    if (q.includes('львов')) return json(r, { features: [
      { geometry: { coordinates: [36.70, 50.98] }, properties: { name: 'Львов', osm_key: 'place', osm_value: 'village', county: 'Прохоровский муниципальный округ', state: 'Belgorod Oblast', countrycode: 'RU' } },
      { geometry: { coordinates: [24.03, 49.84] }, properties: { name: 'Львів', osm_key: 'place', osm_value: 'city', state: 'Львівська область', countrycode: 'UA' } }] });
    if (q.includes('чугу')) { const c = coords[turnIdx[3] + 100]; return json(r, { features: [{ geometry: { coordinates: [c[1], c[0]] }, properties: { name: 'Чугуїв', state: 'Харківська область', countrycode: 'UA' } }] }); }
    const p = q.includes('полт') ? B : A;
    json(r, { features: [{ geometry: { coordinates: [p[1], p[0]] }, properties: { name: q.includes('полт') ? 'Полтава' : 'Харків', osm_key: 'place', osm_value: 'city', state: q.includes('полт') ? 'Полтавська область' : 'Харківська область', countrycode: 'UA' } }] }); });
  await page.route('**/reverse?*', r => { const lon = +new URL(r.request().url()).searchParams.get('lon'); const kh = lon > 36.1;
    json(r, { features: [{ properties: { name: kh ? 'Пісочин' : 'Чутове', city: kh ? 'Харків' : 'Полтава', state: kh ? 'Харківська область' : 'Полтавська область' } }] }); });
  await page.route('**/api/interpreter', r => json(r, { elements: [
    { type: 'node', id: 1, lat: camPt[0], lon: camPt[1], tags: { highway: 'speed_camera', maxspeed: '50' } },
    { type: 'node', id: 2, lat: stopPt[0], lon: stopPt[1], tags: { amenity: 'fuel', brand: 'OKKO', hgv: 'yes', shower: 'yes', toilets: 'yes', opening_hours: '24/7' } },
    { type: 'node', id: 3, lat: coords[turnIdx[3] + 60][0], lon: coords[turnIdx[3] + 60][1], tags: { amenity: 'fuel', name: 'АЗС' } }] }));
  if (opts.motion) await page.addInitScript(m => { try { localStorage.setItem('reis.motion', JSON.stringify(m)); } catch (_) {} }, opts.motion);
  if (native) await page.addInitScript(({ tg, air, offline }) => {
    const cb = (t, d) => setTimeout(() => window.__reis && window.__reis(t, d), 20);
    window.__spoken = []; window.__nativeCalls = [];
    window.ReisNative = {
      info: () => JSON.stringify({ app: '1.0.0-test', code: 1, native: true }), ready() {}, startTracking() { window.__nativeCalls.push('startTracking'); }, stopTracking() {},
      speak(text, lang, rate, id) { window.__spoken.push(text); cb('tts', { id, state: 'done' }); }, stopSpeak() {}, listen() { cb('stt', { state: 'final', text: 'Що попереду на дорозі?' }); }, stopListen() {},
      http(id, method, url) {
        let status = 200, body = '';
        if (url.includes('t.me/s/kharkiv_roads')) body = tg;
        else if (url.includes('alerts.in.ua')) body = air;
        else if (url.includes('api.anthropic.com')) body = JSON.stringify({ content: [{ type: 'text', text: 'Попереду ДТП на М-03, раджу об’їзд.' }] });
        else status = 404;
        cb('http', { id, status, body });
      },
      offlineStatus: () => JSON.stringify({ installed: !!offline, size: 505, date: '20261120', free: 5e9, dl: { state: 'none' } }),
      offlineCheck() { cb('offline', { remote: { date: '20261120', size: 1100000000, maxzoom: 14 } }); }, offlineDownload() {}, offlineCancel() {}, offlineDelete() {},
      keepAwake(on) { window.__nativeCalls.push('keepAwake:' + on); }, openLocationSettings() { window.__nativeCalls.push('locSettings'); }, openAppSettings() {}, saveFile(n, m, txt) { window.__nativeCalls.push('saveFile:' + n); window.__savedText = txt; }, openUrl(u) { window.__nativeCalls.push('openUrl:' + u); }, postNotice() {}, vibrate() {}, checkUpdate() {}, applyWebUpdate() {}, installApk() {}, reloadUi() { window.__nativeCalls.push('reloadUi'); }
    };
  }, { tg: TG_HTML('kharkiv_roads', ['Перекрито рух на трасі М-03 біля Чугуєва через ДТП за участі фури. Об’їзд через Кам’яну Яругу.', 'На заводі «Турбоатом» тимчасово зупинили виробництво.', 'Рух на мосту через Уди відновлено, дорогу відкрили.', 'Можливо, перекриють проїзд вулицею Сумською ввечері, уточнюється.', 'Знижки до 50% у нашому магазині! Підписуйтесь!']), air: AIR_MD, offline: !!opts.offline });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__app && document.getElementById('boot') === null, null, { timeout: 15000 });
  return { page, ctx, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') }); };
const app = (page, fn, arg) => page.evaluate(fn, arg);

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
  await page.click('#gpsChip'); await page.waitForSelector('#panelBody .item');
  ok('панель GPS: стан і супутники', /Приблизно/.test(await page.textContent('#panelBody')) && /Супутники/.test(await page.textContent('#panelBody')));
  await page.click('#panelClose');
  // підміна «в Бєлгород»: усередині старого прямокутника, але за кордоном — тепер ловиться за контуром України
  await emitN('loc', { prov: 'gps', lat: 50.6, lon: 36.59, acc: 4, spd: 0, t: Date.now() });
  await sleep(150);
  ok('підміна в Бєлгород відкинута як «за межами України»', await app(page, () => window.__app.nav.pos.spoofWhy === 'bounds' && window.__app.nav.pos.lat < 50.1));
  ok('Крим і прикордонні міста — Україна, Бєлгород і Гомель — ні', await app(page, () => {
    const u = window.__app.core.inUkraine;
    return u({ lat: 44.95, lon: 34.1 }) && u({ lat: 50.91, lon: 34.8 }) && u({ lat: 48.43, lon: 22.2 }) && u({ lat: 45.35, lon: 28.84 }) && !u({ lat: 50.6, lon: 36.59 }) && !u({ lat: 52.44, lon: 30.99 }) && !u({ lat: 47.01, lon: 28.86 });
  }));
  await page.click('#gpsChip'); await page.waitForSelector('[data-act="journal"]');
  await page.click('[data-act="journal"]'); await sleep(200);
  const jr = await app(page, () => { const n = window.__nativeCalls.find(x => /^saveFile:reis-gps-\d{8}-\d{4}\.json$/.test(x)); let j = null; try { j = JSON.parse(window.__savedText); } catch (_) {} return { n, cnt: j ? j.entries.length : 0, rej: j ? j.entries.filter(e => /^rej:/.test(e.v)).map(e => e.v) : [] }; });
  ok('журнал GPS зберігається файлом і показує, що відкинуто й чому', !!jr.n && jr.cnt >= 4 && jr.rej.includes('rej:bounds'), JSON.stringify(jr));
  await page.click('#panelClose');
  ok('база піт-стопів завантажена й намальована на карті', await page.waitForFunction(() => { const s = window.__app.stopsdb.sdb; const m = window.__app.map.map; return s.ready && s.count === 7 && m.getLayer('stops-all') && m.getLayer('stops-major'); }, null, { timeout: 8000 }).then(() => true, () => false), await app(page, () => JSON.stringify({ c: window.__app.stopsdb.sdb.count, r: window.__app.stopsdb.sdb.ready, l: !!window.__app.map.map.getLayer('stops-all') })));
  await app(page, () => window.__app.bus.emit('stopTap', { i: 1 }));
  const card = await page.textContent('#pick');
  ok('торкання точки: картка з назвою й зручностями', /OKKO/.test(card) && /душ/.test(card) && /для фур/.test(card), card.slice(0, 120));
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
  ok('«Рейс» без маршруту: найближчий душ', /Найближчий душ/.test(await page.textContent('#panelBody')) && /ваша позначка/.test(await page.textContent('#panelBody')));
  await shot(page, '01b-shower');
  await page.click('#panelClose');
  // шари карти: галочки, «вимкнути все» — чиста карта, вибірково лише АЗС
  await page.click('#bQuick'); await page.click('#quick [data-q="layers"]');
  ok('швидкі налаштування → «Шари»: 10 галочок і «вимкнути все»', await page.$$eval('#quick .ly-row', e => e.length) === 10 && /Вимкнути все/.test(await page.textContent('#quick')));
  await shot(page, '01d-layers');
  const feats = () => app(page, async () => { const m = window.__app.map.map; const s = await m.getSource('stops').getData(), k = await m.getSource('marks').getData(); return { stops: s.features.map(f => f.properties.t).join(''), marks: k.features.length }; });
  await page.click('#quick [data-ly="#off"]'); await sleep(200);
  const f0 = await feats();
  ok('«Вимкнути все» — на карті жодної точки й позначки', f0.stops === '' && f0.marks === 0, JSON.stringify(f0));
  await page.click('#quick [data-ly="fuel"]'); await sleep(200);
  const f1 = await feats();
  ok('галочка «АЗС» — лише заправки', /^f+$/.test(f1.stops) && f1.marks === 0, JSON.stringify(f1));
  await page.click('#quick [data-ly="#off"]'); await page.click('#quick [data-ly="#on"]'); await sleep(200);
  const f2 = await feats();
  ok('«Увімкнути все» — усі точки повернулися', f2.stops.length === 7 && f2.marks === 1, JSON.stringify(f2));
  await page.mouse.click(4, 450); await sleep(150);       // шари займають майже весь екран — торкаємось карти збоку
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
  ok('«Місця»: список перевірених місць, без точки — з поясненням', await page.$$eval('.vp-row', e => e.length) === 2 && /Точки на карті ще немає/.test(await page.textContent('#panelBody')));
  await shot(page, '16-places');
  await page.click('.vp-row[data-vpid="test-bistro"]'); await page.waitForSelector('.vp-photos img');
  await page.waitForFunction(() => [...document.querySelectorAll('.vp-photos img')].slice(0, 1).every(i => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).catch(() => {});
  const vpc = await app(page, () => ({ title: document.getElementById('panelTitle').textContent, imgs: [...document.querySelectorAll('.vp-photos img')].map(i => i.naturalWidth), stars: document.querySelector('.vp-stars').textContent, menu: document.querySelectorAll('.vp-menu div').length, txt: document.getElementById('panelBody').textContent }));
  ok('картка місця: фото завантажились, ★★★★★, «Перевірено нами», меню з цінами', vpc.imgs.length === 2 && vpc.imgs[0] > 0 && vpc.stars === '★★★★★' && /Перевірено нами/.test(vpc.txt) && vpc.menu === 2 && /65 грн/.test(vpc.txt), JSON.stringify({ ...vpc, txt: vpc.txt.slice(0, 120) }));
  await shot(page, '17-place');
  await page.click('.vp-photos img'); await sleep(200);
  ok('дотик по фото — на весь екран, ✕ закриває', await app(page, () => !document.getElementById('photoView').hidden));
  await shot(page, '17b-photo');
  await page.click('#photoView [data-pv="x"]');
  await page.click('[data-vp="go"]'); await page.waitForSelector('#in_b');
  ok('«Маршрут сюди» — місце стає точкою Б', await app(page, () => document.getElementById('in_b').value === 'Бістро (тест)'));
  await app(page, () => { document.getElementById('in_b').value = ''; }); await page.click('[data-clear="b"]');
  // місцю без координат водій ставить точку сам
  await page.click('#tabs button[data-panel="places"]'); await page.waitForSelector('.vp-row');
  await page.click('.vp-row[data-vpid="test-noloc"]'); await page.click('[data-vp="setloc"]');
  await app(page, p => window.__app.bus.emit('mapPick', { lat: p[0], lon: p[1] }), coords[500]); await sleep(300);
  ok('«Поставити на карту»: довге натискання ставить точку місцю', await app(page, () => { const x = window.__app.vplaces.byId('test-noloc'); return x && x.lat != null && document.querySelectorAll('.vpm').length === 2; }));
  await page.click('#panelClose');
  await page.click('#bQuick'); await page.click('#quick [data-q="layers"]'); await page.click('#quick [data-ly="@mapVerified"]');
  ok('«Шари» → «Перевірені місця» ховає значки', await app(page, () => document.querySelectorAll('.vpm').length === 0));
  await page.click('#quick [data-ly="@mapVerified"]'); await page.click('#quick [data-q="close"]');

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
  await page.fill('#in_b', ''); await page.click('#panelClose');
  // планування рейсу
  await page.click('#tabs button[data-panel="trip"]');
  await page.fill('#in_a', 'Харків'); await page.waitForSelector('#sg_a button', { timeout: 5000 }); await page.click('#sg_a button');
  await page.fill('#in_b', 'Полтава'); await page.waitForSelector('#sg_b button', { timeout: 5000 }); await page.click('#sg_b button');
  await page.click('[data-act="build"]');
  await page.waitForSelector('[data-act="go"]', { timeout: 10000 });
  ok('маршрут побудовано і показано зведення', /26,8 км|27 км/.test(await page.textContent('#planSum')), (await page.textContent('#planSum')).slice(0, 80));
  await page.waitForFunction(() => document.querySelectorAll('#planSum .pill').length >= 2, null, { timeout: 30000 }).catch(() => {});
  ok('області на шляху визначено', (await page.$$eval('#planSum .pill', e => e.map(x => x.textContent))).join(',').includes('Полтавська'));
  // дороги очима фури
  await page.waitForFunction(() => /Міст до 20 т/.test(document.getElementById('panelBody').textContent), null, { timeout: 8000 }).catch(() => {});
  const tk = await page.textContent('#panelBody');
  ok('план: частка доріг за категоріями (М-03 ≈ 75%)', /траси М і Н 7[45]%/.test(tk) && /місцеві й вулиці 2[56]%/.test(tk), (tk.match(/траси М і Н \d+%|місцеві й вулиці \d+%/g) || []).join(' '));
  ok('план: міст 20 т на маршруті — червоним, з вагою фури', /Міст до 20 т/.test(tk) && /ваша фура 40 т/.test(tk) && await page.$$eval('.hz-item.red', e => e.some(x => /Міст до 20 т/.test(x.textContent))));
  ok('план: душ попереду — OKKO і окремий душ, з відстанню', /Душ попереду/.test(tk) && /OKKO/.test(tk) && /Душ для водіїв/.test(tk), (tk.match(/Душ попереду.{0,120}/) || [''])[0]);
  ok('план: ґрунт ≈ 1,2 км', /Ґрунт або щебінь — 1,[12] км/.test(tk), (tk.match(/Ґрунт[^·]*?км/) || [''])[0]);
  ok('проїзд на вулиці навхрест і міст 55 т не вважаються проблемою', !/3,8 м/.test(tk) && !/55 т/.test(tk));
  const rmap = await app(page, async () => { const m = window.__app.map.map; const d = await m.getSource('route').getData(); const bad = await m.getSource('route-bad').getData();
    return { cats: (d.features || []).map(f => f.properties.c).join(''), bad: bad.features.length, marks: [...document.querySelectorAll('.hzm')].map(x => x.textContent + ':' + x.className) }; });
  ok('карта: маршрут розфарбовано за категоріями, ґрунт — пунктиром, на мосту значок «20т»', /a/.test(rmap.cats) && /c/.test(rmap.cats) && rmap.bad === 1 && rmap.marks.some(x => /^20т:.*red/.test(x)), JSON.stringify(rmap));
  await shot(page, '02-plan');
  // варіанти маршруту карточками; вибір — сірий інший варіант на карті; повертаємось до першого
  const alts = await page.$$eval('#planSum .alt', e => e.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('варіанти маршруту: 2 карточки — час, км, дороги; перший найшвидший', alts.length === 2 && /М-03/.test(alts[0]) && /найшвидший/.test(alts[0]) && /Н-31/.test(alts[1]), JSON.stringify(alts));
  ok('запит маршруту просить запасні варіанти', routeReqs.some(q => q.alternates === 2));
  ok('на карті сірим — інший варіант', await app(page, async () => (await window.__app.map.map.getSource('route-alts').getData()).features.length === 1));
  await page.click('#planSum .alt[data-alt="1"]'); await sleep(700);
  const pick1 = await app(page, async () => ({ on: document.querySelector('#planSum .alt.on') && document.querySelector('#planSum .alt.on').dataset.alt, alts: (await window.__app.map.map.getSource('route-alts').getData()).features.map(f => f.properties.k) }));
  ok('вибрав другий варіант — він основний, перший став сірим', pick1.on === '1' && pick1.alts.join() === '0', JSON.stringify(pick1));
  await shot(page, '02c-alts');
  await page.click('#planSum .alt[data-alt="0"]'); await sleep(700);
  // фура / легкова
  ok('перемикач «Фура / Легкова»: за замовчуванням фура', await app(page, () => document.querySelector('.seg.veh .on').dataset.veh === 'truck'));
  await page.click('.seg.veh [data-veh="auto"]'); await page.waitForSelector('[data-act="go"]', { timeout: 10000 }); await sleep(300);
  ok('легкова: маршрут без обмежень для фур (costing auto)', routeReqs[routeReqs.length - 1].costing === 'auto' && await app(page, () => window.__app.S.vehicle === 'auto'), routeReqs[routeReqs.length - 1].costing);
  await page.click('.seg.veh [data-veh="truck"]'); await page.waitForSelector('[data-act="go"]', { timeout: 10000 }); await sleep(300);
  ok('знову фура: профіль truck з обмежувачем 90', routeReqs[routeReqs.length - 1].costing === 'truck' && routeReqs[routeReqs.length - 1].costing_options.truck.top_speed === 90);
  ok('після вибору підказки список не відкривається знову', await app(page, () => ['a', 'b'].every(k => document.getElementById('sg_' + k).hidden)));
  if (SHOTS) { await app(page, () => { const b = document.getElementById('panelBody'), h = [...b.querySelectorAll('.sec')].find(x => /фури/i.test(x.textContent)); if (h) b.scrollTop = h.offsetTop - 8; }); await sleep(200); await shot(page, '02b-truck');
    await app(page, () => { document.getElementById('panelBody').scrollTop = 0; }); }

  // додаємо канал Telegram і їдемо
  await app(page, () => { window.__app.S.channels = [{ name: 'kharkiv_roads', region: 'kharkiv', on: true }]; window.__app.S.offline = false; });
  await page.click('[data-act="go"]');
  await page.waitForFunction(() => window.__app.guide.g.active && window.__app.guide.g.idx, null, { timeout: 8000 });
  ok('рейс активний', true);
  { const q = routeReqs.find(x => x.costing === 'truck') || {}, tk = (q.costing_options || {}).truck || {};
    ok('запит маршруту: профіль фури з габаритами, мова підказок українська', q.costing === 'truck' && tk.height === 4 && tk.weight === 40 && q.language === 'uk-UA' && q.locations.length === 2 && q.locations[0].type === 'break', JSON.stringify({ c: q.costing, tk, l: q.language })); }
  // черга голосу могла бути зайнята (тривога, подія) — даємо їй договорити; на CI це бувало повільніше
  ok('сказано «маршрут побудовано»', await page.waitForFunction(() => window.__spoken.some(s => /Маршрут побудовано/.test(s)), null, { timeout: 8000 }).then(() => true, () => false), JSON.stringify(await app(page, () => window.__spoken.slice(-5))));

  // імітація руху
  await app(page, () => { window.__app.sim.setSpeed(60); window.__app.sim.start(); });
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps' && window.__app.nav.pos.onRoute, null, { timeout: 8000 });
  await sleep(2500);
  const s1 = await app(page, () => ({ next: window.__app.guide.g.next && window.__app.guide.g.next.type, dist: window.__app.guide.g.distNext, man: document.getElementById('manDist').textContent, text: document.getElementById('manText').textContent, spd: document.getElementById('spdVal').textContent }));
  ok('картка маневру: поворот ліворуч попереду', s1.next === 15 && /км|м/.test(s1.man) && /Пушкінськ/.test(s1.text), JSON.stringify(s1));
  ok('швидкість на екрані', +s1.spd > 40 && +s1.spd < 70, s1.spd);
  await shot(page, '03-drive');
  // пройдене: за замовчуванням ховаємо — на карті лише шлях попереду; за налаштуванням — блідо
  const pr = await app(page, async () => { const m = window.__app.map.map, g = window.__app.guide.g;
    const r = await m.getSource('route').getData(), dn = await m.getSource('route-done').getData();
    const first = (r.features || [r])[0].geometry.coordinates[0], here = window.__app.nav.pos;
    const off = window.__app.core.hav({ lat: first[1], lon: first[0] }, here);
    return { off: Math.round(off), rd: Math.round(here.rd), done: dn.geometry ? dn.geometry.coordinates.length : (dn.features || []).length }; });
  ok('пройдена частина маршруту схована: лінія починається від машини', pr.rd > 20 && pr.off < 60 && pr.done === 0, JSON.stringify(pr));
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
  // оцінка «не потрібно» прибирає подію зі шторки і вчить фільтр
  const redId = await app(page, () => window.__app.feed.feed.items.find(i => i.text.includes('Перекрито рух')).id);
  const base = await app(page, () => window.__app.feed.classify('Перекрито рух на трасі М-03 біля Чугуєва через ДТП за участі фури', 'kharkiv_roads').score);
  await page.click(`button[data-v="${redId}:-1"]`); await sleep(600);
  ok('після «Не потрібно» шторка вже не червона', (await app(page, () => document.getElementById('strip').dataset.level)) !== 'red');
  const sc = await app(page, () => { const f = window.__app.feed; return { again: f.classify('Перекрито рух на трасі М-03 біля Чугуєва через ДТП за участі фури', 'kharkiv_roads').score, other: f.classify('ДТП на перехресті, рух ускладнено', 'x').score }; });
  ok('схоже повідомлення тепер оцінюється нижче (на ≥1 бал)', sc.again <= base - 1, `було ${base.toFixed(2)}, стало ${sc.again.toFixed(2)}`);
  await page.click('[data-tab="rest"]'); await page.click(`button[data-v="${redId}:1"]`); await sleep(500);
  ok('після «Потрібно» подія повернулась', (await app(page, () => document.getElementById('strip').dataset.level)) === 'red');
  await page.click('#panelClose');

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
  const dr = await app(page, () => ({ mode: window.__app.nav.pos.mode, reason: window.__app.nav.pos.reason, rd: window.__app.nav.pos.rd, lostHidden: document.getElementById('lostLine').hidden, nudge: !document.getElementById('nudge').hidden, chip: document.getElementById('lostLine').textContent }));
  ok('GPS зник → режим розрахунку, компактні кнопки ±100', dr.mode === 'dr' && dr.reason === 'timeout' && !dr.lostHidden && dr.nudge && dr.chip.startsWith('GPS ✕'), JSON.stringify(dr));
  ok('без GPS позиція рухається маршрутом і надолужує паузу', dr.rd > rd0 + 110, `rd ${Math.round(rd0)} → ${Math.round(dr.rd)}`);
  ok('сказано про втрату сигналу', await app(page, () => window.__spoken.some(s => /Сигнал GPS втрачено/.test(s))));
  await shot(page, '06-gps-lost');
  const before = await app(page, () => window.__app.nav.pos.rd);
  await page.click('#bFwd100'); const up = await app(page, () => window.__app.nav.pos.rd);
  await page.click('#bBack100'); await page.click('#bBack100'); const dn = await app(page, () => window.__app.nav.pos.rd);
  ok('↑100 зсуває вперед (100 м + рух за час натискання)', up - before >= 99 && up - before < 150, `${Math.round(up - before)} м`);
  ok('↓100 двічі зсуває назад (200 м мінус рух)', up - dn > 140 && up - dn <= 201, `${Math.round(up - dn)} м`);
  await app(page, () => window.__app.sim.setLost(false));
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'gps', null, { timeout: 12000 });
  ok('GPS повернувся → знову веде GPS, кнопки ±100 сховано', await app(page, () => document.getElementById('nudge').hidden && !document.getElementById('gpsChip').hidden));

  // підміна GPS («Ліма»)
  await app(page, () => window.__app.sim.setSpoof(true));
  await page.waitForFunction(() => window.__app.nav.pos.mode === 'dr', null, { timeout: 8000 });
  const sp = await app(page, () => ({ reason: window.__app.nav.pos.reason, lat: window.__app.nav.pos.lat, why: document.getElementById('lostLine').textContent }));
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
  ok('стоянку для фур OKKO запропоновано заздалегідь', fin.feed.some(x => /OKKO/.test(x)), fin.feed.join(' | '));
  ok('перевірене місце на маршруті попереду — у стрічці й голосом', fin.feed.some(x => /Перевірене місце «Бістро \(тест\)»/.test(x)) && fin.spoken.some(s => /перевірене кафе/.test(s)), fin.feed.join(' | '));
  ok('прибуття оголошено', fin.spoken.some(s => /Ви прибули/.test(s)) && /прибули/i.test(fin.man), fin.man);
  await shot(page, '07-arrived');

  // нижня панель: «Маршрут» посередині, чату й мікрофона немає
  ok('нижня панель: Події · Місця · Маршрут · Лаб · Параметри; чату й мікрофона немає', await app(page, () => [...document.querySelectorAll('#tabs button')].map(b => b.dataset.panel).join() === 'feed,places,trip,lab,settings' && !document.getElementById('bMic') && !document.querySelector('[data-panel="chat"]')));

  // лабораторія, ніч
  await page.click('#tabs button[data-panel="lab"]'); await page.waitForSelector('[data-tg="tg"]');
  await shot(page, '09-lab');
  await page.click('[data-tg="tg"]');
  ok('перемикач у Лабораторії змінює налаштування', await app(page, () => window.__app.S.tg === false));
  await page.click('#panelClose');
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('[data-seg="theme:night"]');
  await shot(page, '11-settings');
  await page.click('[data-seg="theme:day"]'); await sleep(300);
  ok('швидкі налаштування → «Налаштування» → тема «День»', await app(page, () => document.body.dataset.theme === 'day' && window.__app.S.theme === 'day'));
  // прозорість плашок: за замовчуванням нижня панель і кнопки напівпрозорі, без розмиття
  const alpha = sel => app(page, s => { const m = getComputedStyle(document.querySelector(s)).backgroundColor.match(/rgba?\(([^)]+)\)/); const p = m ? m[1].split(',').map(Number) : []; return p.length === 4 ? p[3] : 1; }, sel);
  const aBottom = await alpha('#bottom'), aRail = await alpha('#bQuick'), aSpeed = await alpha('#speed');
  ok('нижня панель, кнопки і швидкість прозорі (≤ 0,5)', aBottom <= 0.5 && aRail <= 0.5 && aSpeed <= 0.5, `низ ${aBottom}, кнопка ${aRail}, швидкість ${aSpeed}`);
  ok('нижня панель без розмиття', await app(page, () => ['none', ''].includes(getComputedStyle(document.getElementById('bottom')).backdropFilter || 'none')));
  await page.click('[data-seg="glass:low"]'); await sleep(200);
  const aLow = await alpha('#bottom');
  await page.click('[data-seg="glass:max"]'); await sleep(200);
  const aMax = await alpha('#bottom');
  ok('перемикач «Прозорість плашок» міняє щільність', aLow > 0.75 && aMax < 0.3, `слабка ${aLow}, максимум ${aMax}`);
  await page.click('[data-seg="glass:high"]'); await sleep(200);
  if (SHOTS) {
    // знімок для очей: денна тема поверх намальованої «карти» з дорогами й підписами під нижньою панеллю
    await page.click('#panelClose');
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
  ok('вночі нижня панель теж прозора і темна', await app(page, () => { const c = getComputedStyle(document.getElementById('bottom')).backgroundColor; const p = c.match(/[\d.]+/g).map(Number); return p[0] < 60 && p[3] <= 0.5; }));
  await page.click('[data-tg="vibrate"]');
  ok('перемикач вібрації', await app(page, () => window.__app.S.vibrate === false));
  await page.click('#panelClose');
  await shot(page, '10-night');
  ok('у дорозі голосом попереджено про міст 20 т', await app(page, () => window.__spoken.some(s => /Міст до 20 т/.test(s))), (await app(page, () => window.__spoken.filter(s => /Міст|Ґрунт/.test(s)).join(' | '))));
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
    const h = await W.heatAlong(route); const heavy = W.heatApplies(); S.heatExempt = true; const ex = W.heatApplies(); S.heatExempt = false;
    return { maxT: h && h.maxT, first: !!(h && h.first), heavy, ex };
  });
  ok('спека: прогноз +31 °C на маршруті, обмеження для фури 40 т, пільговий вантаж — без обмеження', heat.maxT === 31 && heat.first && heat.heavy === true && heat.ex === false, JSON.stringify(heat));
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
  ok('у зоні підміни інтерфейс не перезавантажується сам', await app(page, () => !window.__nativeCalls.includes('reloadUi') && /підміна GPS/.test(document.getElementById('toasts').textContent)));
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
  await page.click('[data-open="t-auto"]'); await page.click('#panelClose');
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
  ok('підміна посеред рейсу: розрахунок по маршруту, без «поза маршрутом»', r2.mode === 'dr' && r2.on && r2.rd > 15900 && !/поза маршрутом/i.test(r2.man), JSON.stringify(r2));
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
    await emitN('sens', { var: 0.05, yaw: 0 });
    await sleep(9500);
    const held = await app(page, () => window.__app.nav.pos.rd);
    ok('перед поворотом позначка чекає на гіроскоп', held < tr0.d && held > tr0.d - 40, `rd ${Math.round(held)}, поворот ${Math.round(tr0.d)}`);
    await emitN('sens', { var: 0.05, yaw: 0 });
    await app(page, () => { window.__realNow = Date.now; const b = Date.now(); Date.now = () => b + 8000; });
    await emitN('sens', { var: 0.05, yaw: tr0.ang });
    await app(page, () => { Date.now = window.__realNow; });
    await sleep(300);
    const after = await app(page, () => window.__app.nav.pos.rd);
    ok('гіроскоп відчув поворот — позначка за поворотом, похибка скинута', after > tr0.d && after < tr0.d + 450 && await app(page, () => window.__app.nav.pos.acc <= 60), `rd ${Math.round(after)}, поворот ${Math.round(tr0.d)}`);
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
  ok('«На маршрут» → «Де ви зараз?»: початок маршруту й місця вздовж нього', wp.open && wp.rows.length >= 1 && /Початок маршруту/.test(wp.rows.join('|')), JSON.stringify(wp));
  await shot(page, '14b-where');
  await page.click('#wherePop [data-d]');
  await sleep(300);
  const s2 = await app(page, () => ({ mode: window.__app.nav.pos.mode, on: window.__app.nav.pos.onRoute, rd: Math.round(window.__app.nav.pos.rd || -1) }));
  ok('«На маршрут» — позначка на маршруті, ведення без GPS', s2.mode === 'dr' && s2.on && s2.rd >= 0, JSON.stringify(s2));
  // довге натискання біля маршруту (за 50 м від лінії) без GPS = «я тут, на маршруті» — без меню
  { const pt = await app(page, () => { const R = window.__app.core.RouteIndex, c = window.__app.guide.g.route.coords; const p = new R(c).at(9000); return { lat: p.lat + 0.00045, lon: p.lon }; });
    await app(page, p => window.__app.bus.emit('mapPick', p), pt); await sleep(250);
    const s3 = await app(page, () => ({ rd: Math.round(window.__app.nav.pos.rd), pick: !document.getElementById('pick').hidden, toast: document.getElementById('toasts').textContent }));
    ok('довге натискання поруч із маршрутом ставить позначку на маршрут (без меню)', Math.abs(s3.rd - 9000) < 150 && !s3.pick && /на маршруті/.test(s3.toast), JSON.stringify({ ...s3, toast: s3.toast.slice(-60) })); }
  ok('прохід «На маршрут» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «На маршрут» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 6: з'їхали з маршруту — повертаємо на вибраний, а не будуємо зовсім інший ============ */
if (run('6')) try {
  const { page, ctx, errors } = await newPage(true);
  const emitN = (type, d) => app(page, ([type, d]) => window.__reis(type, d), [type, d]);
  const n = coords.length;
  const trip = { id: 't-keep', a: { lat: coords[0][0], lon: coords[0][1], label: 'Харків' }, b: { lat: coords[n - 1][0], lon: coords[n - 1][1], label: 'Полтава' },
    route: { coords, mans: [{ type: 1, ins: 'Рушайте', street: '', streets: [], i0: 0, i1: n - 1, len: 26800, time: 1700 }, { type: 4, ins: 'Прибуття', street: '', streets: [], i0: n - 1, i1: n - 1, len: 0, time: 0 }], dist: 26800, time: 1700, aD: null, viaD: null } };
  await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
  const at = d => app(page, d => { const R = window.__app.core.RouteIndex, c = window.__app.guide.g.route.coords; const p = new R(c).at(d); return { lat: p.lat, lon: p.lon, brg: p.brg }; }, d);
  for (let d = 7000; d <= 7200; d += 50) { const p = await at(d); await emitN('loc', { prov: 'gps', lat: p.lat, lon: p.lon, acc: 5, spd: 20, brg: p.brg, t: Date.now() }); await sleep(250); }
  ok('вибраний маршрут запам’ятовано (спрощено)', await app(page, () => Array.isArray(window.__app.guide.g.trip.chosen) && window.__app.guide.g.trip.chosen.length > 40));
  const n0 = routeReqs.length;
  // з'їхали на паралельну дорогу: 400 м убік, 10 с
  for (let i = 0; i < 24; i++) { const p = await at(7250 + i * 20); await emitN('loc', { prov: 'gps', lat: p.lat + Math.min(0.0036, 0.0002 * (i + 1)), lon: p.lon, acc: 5, spd: 20, brg: p.brg, t: Date.now() }); await sleep(1000); }
  await page.waitForFunction(n0 => window.__app.guide.g.trip && window.__app.guide.g.rerouting === false && performance.now() > 0, n0, { timeout: 3000 }).catch(() => {});
  await sleep(1500);
  const rq = routeReqs.slice(n0).pop() || { locations: [] };
  ok('з’їхали: маршрут повертає на вибраний — точки вздовж нього (through) з напрямком руху', rq.locations.length >= 3 && rq.locations.slice(1, -1).every(l => l.type === 'through' && l.heading != null) && !rq.alternates, JSON.stringify(rq.locations.map(l => l.type + (l.heading != null ? '@' + l.heading : ''))));
  ok('сказано «Повертаю на вибраний маршрут»', await app(page, () => window.__spoken.some(s => /Повертаю на вибраний маршрут/.test(s))));
  // «Новий шлях від мене» — без прив'язки до старого
  await page.click('#tabs button[data-panel="trip"]'); await page.click('[data-act="rerouteFresh"]'); await sleep(1500);
  const rq2 = routeReqs[routeReqs.length - 1];
  ok('«Новий шлях від мене» — звичайний маршрут від поточного місця до Б', rq2.locations.length === 2, JSON.stringify(rq2.locations.map(l => l.type)));
  ok('прохід «з’їзд з маршруту» без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('прохід «з’їзд з маршруту» дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 5: без GPS — усі варіанти збою (як на Samsung S10: «завис на першій точці», «завис на повороті») ============ */
// Час прискорено: кожен крок — 10 с життя телефона. «Правда» — де машина насправді; порівнюємо з позначкою.
const FAILS = [
  { n: 'cells', title: 'лише вишки ±1,5 км, датчиків руху немає, 80 км/год', v: 22.2, net: 1500, every: 2, steps: 36, noSens: true, check: r => Math.abs(r.err) < 1500 && r.kmh >= 55 && r.kmh <= 95 },
  { n: 'nonet', title: 'мережевого місця немає взагалі, остання точка 2 год тому', v: 22.2, net: 0, steps: 18, lastGoodAgo: 7200e3, check: r => r.rd > 1500 && r.kind === 'plan' && r.kmh >= 45 },
  { n: 'wifi', title: 'Wi-Fi ±250 м', v: 22.2, net: 250, every: 2, steps: 18, check: r => Math.abs(r.err) < 700 },
  { n: 'stop', title: 'стоїмо (акселерометр: спокій), вишки ±1,5 км', v: 0, net: 1500, every: 2, steps: 14, still: true, check: r => r.moved60 < 300 && r.kmh === 0 },
  { n: 'behind', title: 'поставили на початок, а машина вже на 5 км далі — вишки підтягують', v: 22.2, net: 1500, every: 2, steps: 36, placeAt: 0, head: 5000, check: r => Math.abs(r.err) < 1500 },
  { n: 'outlier', title: 'одна вишка «стрибнула» на 20 км — позначка не стрибає', v: 22.2, net: 1500, every: 2, steps: 24, outlierAt: 16, check: r => Math.abs(r.err) < 1500 && r.maxJump < 3000 },
  { n: 'turn', title: 'різкий поворот, гіроскоп живий, поворот не відчув — не «зависає»', v: 11.1, manual: 40, net: 0, steps: 6, placeAt: 1700, yaw: true, check: r => r.rd > 2150 },
  { n: 'manual', title: 'водій сказав 80 км/год — їдемо за нею', v: 22.2, manual: 80, net: 1500, every: 2, steps: 12, placeAt: 0, check: r => r.kind === 'manual' && r.kmh === 80 && r.rd > 2000 }
];
if (run('5')) for (const sc of FAILS) {
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
    const st = () => app(page, v => { const P = window.__app.nav.pos, sv = window.__app.nav.speedView(); return { rd: P.rd == null ? 0 : P.rd, mode: P.mode, kmh: sv.kmh == null ? null : Math.round(sv.kmh), kind: sv.kind, tt: (Date.now() - window.__t0) / 1000 }; }, sc.v);
    if (sc.placeAt != null) {
      await app(page, d => { window.__app.nav.placeAtD(d); }, sc.placeAt);
      if (sc.manual) await app(page, k => window.__app.nav.setManualSpeed(k), sc.manual);
    }
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
    const at = d => app(page, d => { const R = window.__app.core.RouteIndex, c = window.__app.guide.g.route.coords; const p = new R(c).at(Math.max(0, Math.min(d, 26700))); return { lat: p.lat, lon: p.lon }; }, d);
    let prevRd = null, maxJump = 0, last = null, hist = [];
    for (let i = 0; i < sc.steps; i++) {
      await app(page, () => { window.__off += 10000; });
      const tt = await app(page, () => (Date.now() - window.__t0) / 1000), truth = (sc.head || 0) + (sc.placeAt != null && !sc.head ? sc.placeAt : 0) + sc.v * tt;
      if (!sc.noSens) await emitN('sens', { var: sc.still ? 0.0005 : 0.08, yaw: sc.yaw ? 0 : undefined });
      if (sc.net && i % (sc.every || 1) === (sc.every || 1) - 1) {
        const p = await at(i === sc.outlierAt ? truth + 20000 : truth), e = sc.net;
        await emitN('loc', { prov: 'network', lat: p.lat + rnd() * e / 111320, lon: p.lon + rnd() * e / 71500, acc: e, t: Date.now() + i });
      }
      await sleep(1100);
      last = await st(); last.truth = truth;
      if (prevRd != null) maxJump = Math.max(maxJump, Math.abs(last.rd - prevRd) - sc.v * 12);
      prevRd = last.rd; hist.push(last.rd);
    }
    const r = { ...last, err: Math.round(last.rd - last.truth), maxJump: Math.round(maxJump), moved60: Math.round(Math.abs(hist[hist.length - 1] - hist[Math.max(0, hist.length - 7)])), rd: Math.round(last.rd), truth: Math.round(last.truth) };
    ok(T, sc.check(r), JSON.stringify(r));
    ok(T + ' — без помилок JS', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } catch (e) { ok('без GPS: ' + sc.title + ' — дійшло до кінця', false, String(e.message).split('\n')[0]); }
}

/* ============ прохід 4: різні екрани — нічого не накладається, кожна кнопка натискається й робить своє ============ */
// Перевірка в самій сторінці: плашки в межах екрана й одна на одну не налазять; кнопки не перекриті й не замалі для пальця.
const layoutCheck = () => {
  const W = innerWidth, H = innerHeight, out = [];
  const vis = el => !!el && !el.hidden && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
  const R = el => el.getBoundingClientRect();
  const nm = el => el.id ? '#' + el.id : (el.getAttribute('data-panel') ? 'tab:' + el.getAttribute('data-panel') : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName);
  const inter = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const top = ['#top', '#rail', '#bCenter', '#speed', '#cam', '#bottom', '#attr', '#spdPop', '#pick'].map(s => document.querySelector(s)).filter(vis);
  for (const el of top) { const r = R(el); if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) out.push('за межами екрана: ' + nm(el) + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ']'); }
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) if (inter(R(top[i]), R(top[j]))) out.push('накладаються: ' + nm(top[i]) + ' і ' + nm(top[j]));
  for (const sel of ['#tripbar > *', '#tripbar .tb-main > *', '#tabs > button', '#man > *', '#nudge > button']) {
    const els = [...document.querySelectorAll(sel)].filter(vis);
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) if (inter(R(els[i]), R(els[j]))) out.push('накладаються: ' + nm(els[i]) + ' і ' + nm(els[j]));
  }
  for (const b of [...document.querySelectorAll('#bQuick,#bCenter,#speed,#strip,#tabs > button,#bFwd100,#bBack100,#gpsChip,#manSnap,#lostLine,#bAcceptGps')].filter(vis)) {
    const r = R(b), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    if (!hit || !(b === hit || b.contains(hit))) out.push('перекрита: ' + nm(b) + ' ← ' + (hit ? nm(hit) : '—'));
    if (!((r.width >= 40 && r.height >= 36) || (r.width >= 120 && r.height >= 28))) out.push('замала для пальця: ' + nm(b) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));   // широка смуга може бути нижчою
  }
  for (const s of ['#tripbar', '#top', '#tabs', '#man']) { const el = document.querySelector(s); if (vis(el) && el.scrollWidth > el.clientWidth + 2) out.push('не влазить по ширині: ' + s); }
  return out;
};
// Справжній дотик пальцем (через протокол DevTools): карта тягнеться так само, як на телефоні
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
    await app(page, tr => window.__app.guide.startTrip(tr, { onRoute: true }), trip);
    const p0 = coords[40];
    await emitN('loc', { prov: 'gps', lat: p0[0], lon: p0[1], acc: 5, spd: 24, brg: 270, t: Date.now() });
    await sleep(900);
    // найтісніший стан: їдемо без GPS (кнопки ±100), камера попереду, на маневрі довгий текст
    await app(page, () => { window.__app.nav.nudge(0); const c = document.getElementById('cam'); c.hidden = false; document.getElementById('camMax').textContent = '90'; document.getElementById('camDist').textContent = '350 м'; });
    await sleep(250);
    await app(page, () => { const c = document.getElementById('cam'); c.hidden = false; });
    const L1 = await app(page, layoutCheck);
    ok(`${T}: у дорозі без GPS нічого не накладається й не перекрите`, L1.length === 0, L1.join('; '));
    if (sc.st) {
      const ins = await app(page, () => { const R = s => document.querySelector(s).getBoundingClientRect(); return { top: R('#top').top, rail: R('#rail').top, tabs: R('#tabs').bottom, H: innerHeight }; });
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
    ok(`${T}: швидкі налаштування відкрились, 9 плиток, у межах екрана й не під нижньою панеллю`, qb.open && qb.tiles === 9 && qb.top >= 0 && qb.left >= 0 && qb.right <= qb.W && (qb.land ? qb.bottom <= qb.H : qb.bottom <= qb.bt + 1), JSON.stringify(qb));
    await shot(page, `a-${sc.n}-2-quick`);
    const st = () => app(page, () => { const A = window.__app; return { voice: A.S.voice, v3d: A.S.view3d, north: A.map.view.north, follow: A.map.view.follow, rec: !!A.S.rec, theme: A.S.theme, awake: A.S.keepAwake !== false, zb: A.map.view.zoomBias, open: !document.getElementById('quick').hidden, panel: A.ui ? null : document.getElementById('panel').hidden ? '' : document.getElementById('panelTitle').textContent, badge: !!document.querySelector('#bQuick .q-badge') }; });
    const tap = async k => { await page.click(`#quick [data-q="${k}"]`); await sleep(120); return st(); };
    const s0 = await st();
    let s1 = await tap('voice'); ok(`${T}: плитка «Звук» вимикає голос, на кнопці значок`, s1.voice === !s0.voice && s1.badge === !s1.voice && s1.open, JSON.stringify(s1));
    s1 = await tap('voice'); ok(`${T}: «Звук» знову вмикає`, s1.voice === s0.voice && !s1.badge);
    s1 = await tap('3d'); ok(`${T}: плитка «Вигляд» 3D ↔ 2D`, s1.v3d === !s0.v3d); await tap('3d');
    s1 = await tap('north'); ok(`${T}: плитка «Карта» північ ↔ за рухом`, s1.north === !s0.north); await tap('north');
    s1 = await tap('rec'); ok(`${T}: плитка «Запис треку» вмикає запис, на кнопці червона крапка`, s1.rec && s1.badge, JSON.stringify(s1)); s1 = await tap('rec'); ok(`${T}: і вимикає`, !s1.rec);
    const th = [(await tap('theme')).theme, (await tap('theme')).theme, (await tap('theme')).theme];
    ok(`${T}: плитка «Тема» по колу: день → ніч → авто`, th.join() === 'day,night,auto', th.join());
    s1 = await tap('awake'); ok(`${T}: плитка «Екран» — гасне сам / не гасне (команда оболонці)`, s1.awake === !s0.awake && await app(page, v => window.__nativeCalls.includes('keepAwake:' + v), s1.awake)); await tap('awake');
    const z0 = s0.zb; s1 = await tap('zin'); const z1 = s1.zb; s1 = await tap('zout'); s1 = await tap('zout');
    ok(`${T}: масштаб + і −`, z1 === z0 + 1 && s1.zb === z0 - 1, `${z0} → ${z1} → ${s1.zb}`); await tap('zin');
    await page.click('#quick [data-q="layers"]');
    ok(`${T}: «Шари» — 10 галочок, у межах екрана`, await app(page, () => { const q = document.getElementById('quick'); return q.querySelectorAll('.ly-row').length === 10 && q.getBoundingClientRect().bottom <= innerHeight; }));
    await page.click('#quick [data-ly="fuel"]'); ok(`${T}: галочка в «Шарах» працює`, await app(page, () => window.__app.S.mapStopTypes.fuel === false));
    await page.click('#quick [data-ly="fuel"]');
    await page.click('#quick [data-q="back"]'); ok(`${T}: «Назад» із шарів — до плиток`, await app(page, () => document.querySelectorAll('#quick .q-tile').length === 9));
    await app(page, () => { window.__app.map.view.lastTouch = Date.now(); window.__app.map.setFollow(false); });
    s1 = await tap('center'); ok(`${T}: плитка «Моє місце» — стежить і шторка закрилась`, s1.follow && !s1.open, JSON.stringify(s1));
    await page.click('#bQuick'); await page.click('#quick [data-q="settings"]');
    ok(`${T}: плитка «Налаштування» відкриває налаштування`, await app(page, () => !document.getElementById('panel').hidden && /Налаштування/.test(document.getElementById('panelTitle').textContent) && document.getElementById('quick').hidden));
    const Lp = await app(page, () => { const p = document.getElementById('panel').getBoundingClientRect(); return { top: p.top, bottom: p.bottom, H: innerHeight, W: innerWidth, right: p.right }; });
    ok(`${T}: панель у межах екрана`, Lp.top >= 0 && Lp.bottom <= Lp.H + 1 && Lp.right <= Lp.W + 1, JSON.stringify(Lp));
    await page.click('#panelClose');
    await page.click('#bQuick'); await page.click('#quick [data-q="close"]'); ok(`${T}: ✕ закриває шторку`, await app(page, () => document.getElementById('quick').hidden));
    await page.click('#bQuick'); ok(`${T}: системна «Назад» закриває шторку`, await app(page, () => window.__reisBack() && document.getElementById('quick').hidden));
    // вкладки внизу: кожна відкриває свою панель і закривається
    for (const [tab, re] of [['trip', /Маршрут/], ['feed', /Події/], ['places', /Місця/], ['lab', /Лаб/], ['settings', /Налаштування/]]) {
      await page.click(`#tabs button[data-panel="${tab}"]`);
      const ttl = await app(page, () => document.getElementById('panel').hidden ? '' : document.getElementById('panelTitle').textContent);
      ok(`${T}: вкладка «${tab}» відкриває панель`, re.test(ttl), ttl);
      await page.click(`#tabs button[data-panel="${tab}"]`);
      ok(`${T}: повторний дотик закриває «${tab}»`, await app(page, () => document.getElementById('panel').hidden));
    }
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
      await longPress(px, py);
      ok(`${T}: без GPS довге натискання біля маршруту — «ви тут, на маршруті», без меню`, await app(page, () => document.getElementById('pick').hidden && /на маршруті/.test(document.getElementById('toasts').textContent)));
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

/* ============ прохід 3: офлайн-карта України з файлу в телефоні ============ */
if (run('3')) try {
  const { page, ctx, errors } = await newPage(true, { offline: true });
  const okSrc = await page.waitForFunction(() => { const m = window.__app.map.map; return m && m.getSource && m.getSource('protomaps') && m.isSourceLoaded('protomaps'); }, null, { timeout: 20000 }).then(() => true, () => false);
  ok('офлайн-карта: стиль Protomaps із файлу PMTiles завантажився', okSrc && rangeHits > 0, 'запитів шматками: ' + rangeHits);
  ok('офлайн-карта: шари маршруту на місці', await app(page, () => !!window.__app.map.map.getLayer('route-line') && !!window.__app.map.map.getLayer('route-done')));
  await page.click('#bQuick'); await page.click('#quick [data-q="settings"]'); await page.waitForSelector('#offSec');
  const offTxt = await page.textContent('#offSec');
  ok('налаштування: розділ офлайн-карти показує стан і вибір карти', /У телефоні/.test(offTxt) && /Онлайн/.test(offTxt), offTxt.slice(0, 120));
  await shot(page, '12-offline');
  await page.click('[data-seg="mapMode:online"]'); await sleep(500);
  ok('режим «Онлайн» повертає онлайн-карту', await app(page, () => !window.__app.map.map.getSource('protomaps')));
  await sleep(1500);
  ok('після зміни карти шари маршруту й пит-стопів на місці', await app(page, () => { const m = window.__app.map.map; return !!m.getLayer('route-line') && !!m.getLayer('route-done') && !!m.getSource('route'); }));
  await page.click('[data-seg="mapMode:offline"]'); await sleep(1500);
  ok('і назад на офлайн — шари маршруту на місці', await app(page, () => { const m = window.__app.map.map; return !!m.getSource('protomaps') && !!m.getLayer('route-line'); }));
  ok('прохід офлайн-карти без помилок JS', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) { ok('сценарій 3 дійшов до кінця', false, String(e.message).split('\n')[0]); }

/* ============ прохід 2: звичайний браузер (без оболонки) ============ */
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
