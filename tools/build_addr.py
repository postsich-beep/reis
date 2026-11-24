#!/usr/bin/env python3
"""Номери будинків України для роботи БЕЗ мережі — компактні «пачки» з вивантаження OpenStreetMap.

Навіщо. У файлі офлайн-карти (Protomaps, масштаб до 14) адрес немає; із мережі номери беруться лише коли вона є.
Тут з усіх об'єктів OSM із тегом addr:housenumber робимо власні маленькі файли, які застосунок кладе в телефон.

Вхід — GeoJSON-рядки від osmium (робочий процес «Номери будинків»):
  osmium tags-filter ukraine.osm.pbf nwr/addr:housenumber -o addr.osm.pbf
  osmium export addr.osm.pbf -f geojsonseq -x print_record_separator=false -o addr.geojsonseq
  python3 tools/build_addr.py addr.geojsonseq out_dir [YYYYMMDD]

Вихід (out_dir/v1/):
  index.json            {"v":1,"date":"YYYYMMDD","z":14,"pz":8,"total":N,"bytes":B,"packs":{"X_Y":[номерів, байтів gz], ...}}
  X_Y.bin.gz            пачка — квадрат масштабу 8 (≈100×100 км), усередині 64×64 квадрати масштабу 14

Формат пачки (до gzip), усі числа little-endian:
  'RAD1' · u16 N — скільки квадратів масштабу 14 мають номери
  N × 8 байтів покажчика (за зростанням ty, tx): u8 tx, u8 ty (0..63 у межах пачки), u16 кількість, u32 зсув у даних
  дані: для кожного номера — 3 байти місця в квадраті (x і y по 12 бітів, 0..4095), 1 байт довжини, сам номер (UTF-8)
Той самий розбір — у web/js/addr.js (readPack); спільна перевірка — tests/fixtures/addr.
"""
import gzip, json, math, os, re, struct, sys, datetime
from collections import defaultdict

Z, PZ, EXT = 14, 8, 4096
BOX = (22.0, 44.0, 40.5, 52.5)             # захід, південь, схід, північ — усе поза межами відкидаємо
MAX_LEN, NEAR = 12, 48                     # номер довший за 12 знаків — це вже не номер; ближче 48 одиниць (~30 м) той самий номер — дублікат
SP = re.compile(r'\s+')


def clean(v):
    """Номер будинку, як його писати на карті: без зайвих пробілів; порожнє, задовге чи «сміття» — None."""
    if not isinstance(v, str):
        return None
    s = SP.sub(' ', v).strip().strip(',;')
    if not s or len(s) > MAX_LEN or not any(c.isdigit() for c in s):
        return None
    return s


def center(geom):
    """Одна точка для об'єкта: сама точка, або середина контуру будинку / лінії."""
    t, c = geom.get('type'), geom.get('coordinates')
    if t == 'Point':
        return c[0], c[1]
    if t == 'Polygon':
        ring = c[0]
    elif t == 'MultiPolygon':
        ring = max((p[0] for p in c), key=len)
    elif t == 'LineString':
        ring = c
    else:
        return None
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


def tile_xy(lon, lat):
    """Квадрат масштабу 14 і місце в ньому (0..4095)."""
    n = 1 << Z
    fx = (lon + 180.0) / 360.0 * n
    r = math.radians(lat)
    fy = (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n
    tx, ty = int(fx), int(fy)
    return tx, ty, min(EXT - 1, int((fx - tx) * EXT)), min(EXT - 1, int((fy - ty) * EXT))


def read(path):
    """tiles[(tx, ty)] = [(x, y, номер), ...] без дублікатів; друге значення — лічильники для журналу."""
    tiles, stat = defaultdict(list), defaultdict(int)
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip().lstrip('\x1e')
            if not line:
                continue
            try:
                ft = json.loads(line)
            except ValueError:
                stat['не JSON'] += 1
                continue
            num = clean((ft.get('properties') or {}).get('addr:housenumber'))
            if num is None:
                stat['без номера'] += 1
                continue
            c = center(ft.get('geometry') or {})
            if c is None:
                stat['без місця'] += 1
                continue
            lon, lat = c
            if not (BOX[0] <= lon <= BOX[2] and BOX[1] <= lat <= BOX[3]):
                stat['поза межами'] += 1
                continue
            tx, ty, x, y = tile_xy(lon, lat)
            lst = tiles[(tx, ty)]
            if any(n == num and abs(px - x) < NEAR and abs(py - y) < NEAR for px, py, n in lst[-400:]):
                stat['дублікат'] += 1
                continue
            if len(lst) >= 65535:
                stat['понад 65535 у квадраті'] += 1
                continue
            lst.append((x, y, num))
            stat['номерів'] += 1
    return tiles, stat


def pack_bytes(entries):
    """entries: [(tx, ty у межах пачки, [(x, y, номер)])] → байти пачки (до gzip)."""
    entries = sorted(entries, key=lambda e: (e[1], e[0]))
    index, data = bytearray(), bytearray()
    for tx, ty, pts in entries:
        index += struct.pack('<BBHI', tx, ty, len(pts), len(data))
        for x, y, num in sorted(pts, key=lambda p: (p[1], p[0])):
            b = num.encode('utf-8')
            data += bytes(((x >> 4) & 0xff, ((x & 15) << 4) | ((y >> 8) & 15), y & 0xff, len(b))) + b
    return b'RAD1' + struct.pack('<H', len(entries)) + bytes(index) + bytes(data)


def build(src, out, date):
    tiles, stat = read(src)
    packs = defaultdict(list)
    sh = Z - PZ
    for (tx, ty), pts in tiles.items():
        packs[(tx >> sh, ty >> sh)].append((tx & 63, ty & 63, pts))
    d = os.path.join(out, 'v1')
    os.makedirs(d, exist_ok=True)
    idx, total, size = {}, 0, 0
    for (px, py), entries in sorted(packs.items()):
        raw = pack_bytes(entries)
        gz = gzip.compress(raw, 9, mtime=0)
        with open(os.path.join(d, f'{px}_{py}.bin.gz'), 'wb') as f:
            f.write(gz)
        n = sum(len(e[2]) for e in entries)
        idx[f'{px}_{py}'] = [n, len(gz)]
        total += n
        size += len(gz)
    with open(os.path.join(d, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'v': 1, 'date': date, 'z': Z, 'pz': PZ, 'total': total, 'bytes': size, 'packs': idx}, f, separators=(',', ':'))
    return {'packs': len(idx), 'total': total, 'bytes': size, 'tiles': len(tiles), 'stat': dict(stat)}


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    r = build(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else datetime.datetime.utcnow().strftime('%Y%m%d'))
    print(json.dumps(r, ensure_ascii=False))
    big = sorted(((v[1], k) for k, v in json.load(open(os.path.join(sys.argv[2], 'v1', 'index.json')))['packs'].items()), reverse=True)[:5]
    print('найбільші пачки (байтів, квадрат):', big)
