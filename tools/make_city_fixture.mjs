// Тестовий файл офлайн-карти зі СПРАВЖНІМ квадратом міста (Львів, Сихів): tests/fixtures/city.pmtiles.
// Навіщо: у крихітному tiny.pmtiles квадрати порожні — на ньому не видно, чи карта справді малюється
// (дороги, будинки, підписи). Саме тому в 1.1.13–1.1.14 проскочила «сіра карта» через брак наборів літер.
// Запуск (потрібна мережа):  node tools/make_city_fixture.mjs
// Дані: © OpenStreetMap (ODbL), схема Protomaps — ті самі, що в релізі offline-map.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_PM = 'https://github.com/postsich-beep/reis/releases/download/offline-map/ukraine.pmtiles';
const TILES = [[14, 9286, 5570]];      // Львів, Сихів: Луганська вулиця — проспект Червоної Калини (найдрібніший масштаб файлу — 14)

const ctx = { console, TextDecoder, TextEncoder, fetch, AbortController, Uint8Array, DecompressionStream, Response, Blob, setTimeout, clearTimeout };
ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(HERE, '..', 'web', 'vendor', 'pmtiles.js'), 'utf8') + '\n;globalThis.__pm = pmtiles;', ctx);
const pm = ctx.__pm;

const curl = (s, e) => new Promise((res, rej) => execFile('curl', ['-sL', '-r', s + '-' + e, URL_PM], { encoding: 'buffer', maxBuffer: 64e6 }, (err, out) => err ? rej(err) : res(out)));
class Src { getKey() { return URL_PM; } async getBytes(o, l) { const b = await curl(o, o + l - 1); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; } }
const p = new pm.PMTiles(new Src()), h = await p.getHeader();
console.log('файл:', JSON.stringify({ minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat], tileCompression: h.tileCompression, tileType: h.tileType }));

const varint = n => { const o = []; let x = BigInt(n); do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; o.push(b); } while (x > 0n); return o; };
const ents = [];
for (const [z, x, y] of TILES) {
  const t = await p.getZxy(z, x, y); if (!t || !t.data || !t.data.byteLength) throw new Error(`немає квадрата ${z}/${x}/${y}`);
  const gz = gzipSync(Buffer.from(t.data), { level: 9 });
  ents.push({ id: pm.zxyToTileId(z, x, y), data: gz }); console.log(`квадрат ${z}/${x}/${y}: ${t.data.byteLength} → ${gz.length} байтів`);
}
ents.sort((a, b) => a.id - b.id);
let off = 0; for (const e of ents) { e.off = off; off += e.data.length; }
// каталог (без стиснення): кількість, різниці номерів, довжини серій, довжини, зсуви (+1; 0 — «одразу за попереднім»)
const dir = [...varint(ents.length)]; let last = 0;
for (const e of ents) { dir.push(...varint(e.id - last)); last = e.id; }
for (const e of ents) dir.push(...varint(1));
for (const e of ents) dir.push(...varint(e.data.length));
ents.forEach((e, i) => dir.push(...varint(i > 0 && e.off === ents[i - 1].off + ents[i - 1].data.length ? 0 : e.off + 1)));
const meta = Buffer.from(JSON.stringify({ name: 'Рейс — тестовий квадрат міста', attribution: '© OpenStreetMap', vector_layers: [] }));
const H = Buffer.alloc(127), rootOff = 127, metaOff = rootOff + dir.length, dataOff = metaOff + meta.length;
H.write('PMTiles', 0, 'latin1'); H[7] = 3;
const u64 = (o, v) => H.writeBigUInt64LE(BigInt(v), o);
u64(8, rootOff); u64(16, dir.length); u64(24, metaOff); u64(32, meta.length); u64(40, dataOff); u64(48, 0); u64(56, dataOff); u64(64, off);
u64(72, ents.length); u64(80, ents.length); u64(88, ents.length);
H[96] = 1; H[97] = 1 /* каталог і метадані — без стиснення */; H[98] = 2 /* квадрати — gzip */; H[99] = 1 /* MVT */;
H[100] = h.minZoom; H[101] = h.maxZoom;
const e7 = v => Math.round(v * 1e7);
H.writeInt32LE(e7(h.minLon), 102); H.writeInt32LE(e7(h.minLat), 106); H.writeInt32LE(e7(h.maxLon), 110); H.writeInt32LE(e7(h.maxLat), 114);
H[118] = 14; H.writeInt32LE(e7(24.045), 119); H.writeInt32LE(e7(49.807), 123);
const out = Buffer.concat([H, Buffer.from(dir), meta, ...ents.map(e => e.data)]);
writeFileSync(join(HERE, '..', 'tests', 'fixtures', 'city.pmtiles'), out);
console.log('tests/fixtures/city.pmtiles:', out.length, 'байтів');
