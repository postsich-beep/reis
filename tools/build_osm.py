#!/usr/bin/env python3
"""Піт-стопи й населені пункти України з вивантаження OpenStreetMap (Geofabrik) — без Overpass.

Публічні сервери Overpass часто перевантажені (502/504), тому дані беремо з готового файлу країни.
Запуск (робочий процес «Дані OpenStreetMap»):
  python3 tools/build_osm.py filtered.osm.pbf web/data/stops.json web/data/places.json web/data/hazards.json
Формат піт-стопів і населених пунктів той самий, що й раніше (див. build_stops.py і build_places.py).
hazards.json — проблемні для фури ділянки доріг:
  {"v": 2, "date": "YYYYMMDD", "groups": [[kind, value, name, length_m, bridge], ...], "pts": [dlat, dlon, bearing/5, dgroup, ...]}
  pts — плаский масив по 4 числа на точку; широта й довгота в 1e-5 градуса як різниця з попередньою точкою.
  kind: w — обмеження маси (т), a — навантаження на вісь (т), h — висота проїзду (м),
        g — вантажівкам заборонено (0) або лише під'їзд (1), u — ґрунт / щебінь на дорозі з номером,
        s — погане покриття за OSM (smoothness)
  Точки йдуть уздовж ділянки (обмеження — кожні 150 м, покриття — кожні 300 м) з напрямком дороги,
  щоб не плутати з дорогою, що перетинає маршрут. Ґрунт і покриття — лише на дорогах від третинних і вище.
"""
import datetime, json, math, os, re, sys
from collections import Counter

import osmium
from shapely import wkb as swkb
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_stops import row as stop_row, has_shower   # noqa: E402  — та сама класифікація АЗС, стоянок, мотелів, камер, душів
from build_places import OBLASTS, KIND, pop      # noqa: E402

FOOD = {'restaurant', 'cafe', 'fast_food'}
ROADS = {'motorway', 'trunk', 'primary'}
FOOD_NEAR_M = 120                                 # їжа — лише в 120 м від великої дороги
KX, KY = 111320 * 0.66, 111320                    # метри на градус для середньої широти України (~48.5°)

VEH = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
       'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'road'}
ROUGH_CLASSES = {'trunk', 'primary', 'secondary', 'tertiary'}
UNPAVED = ['unpaved', 'dirt', 'ground', 'gravel', 'fine_gravel', 'compacted', 'sand', 'earth', 'grass', 'mud', 'pebblestone', 'rock', 'clay']
BAD_SMOOTH = ['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable']
SAMPLE_M = 150
SAMPLE_SURF_M = 300


def num(v):
    """«20», «20 t», «7,5», «3.8 m» → число; «none», «default» → None."""
    if not v:
        return None
    v = str(v).strip().lower().replace(',', '.')
    m = re.match(r"^(\d+)'\s*(\d+)?\"?$", v)                         # фути й дюйми
    if m:
        return round((int(m.group(1)) * 12 + int(m.group(2) or 0)) * 0.0254, 2)
    m = re.match(r'^(\d+(?:\.\d+)?)\s*(t|т|m|м)?$', v)
    return float(m.group(1)) if m else None


def hazards_of(t):
    hw = t.get('highway')
    if hw not in VEH:
        return []
    out = []
    w = num(t.get('maxweight:hgv') or t.get('maxweight'))
    if w and 0 < w < 60:
        out.append(('w', w))
    a = num(t.get('maxaxleload'))
    if a and 0 < a < 20:
        out.append(('a', a))
    h = num(t.get('maxheight:physical') or t.get('maxheight'))
    if h and 1.5 < h < 5.0:
        out.append(('h', h))
    g = t.get('hgv')
    if g == 'no':
        out.append(('g', 0))
    elif g in ('destination', 'delivery', 'private'):
        out.append(('g', 1))
    base = hw.replace('_link', '')
    if base in ROUGH_CLASSES and t.get('surface') in UNPAVED:
        out.append(('u', UNPAVED.index(t['surface'])))
    if base in ROUGH_CLASSES and t.get('smoothness') in BAD_SMOOTH:
        out.append(('s', BAD_SMOOTH.index(t['smoothness'])))
    return out


def samples(pts, step=SAMPLE_M):
    """Точки вздовж лінії кожні step метрів (для коротких — середина) з напрямком дороги."""
    seg = []
    for (la1, lo1), (la2, lo2) in zip(pts, pts[1:]):
        kx = 111320 * math.cos(math.radians(la1))
        dx, dy = (lo2 - lo1) * kx, (la2 - la1) * 111320
        seg.append((la1, lo1, la2, lo2, math.hypot(dx, dy), (math.degrees(math.atan2(dx, dy)) + 360) % 360))
    total = sum(x[4] for x in seg)
    if not seg or total <= 0:
        return [], 0
    marks = [total / 2] if total < step else [i * step for i in range(int(total // step) + 1)]
    out, acc, i = [], 0.0, 0
    for m in marks:
        while i < len(seg) - 1 and acc + seg[i][4] < m:
            acc += seg[i][4]; i += 1
        la1, lo1, la2, lo2, L, brg = seg[i]
        f = 0 if L == 0 else min(1, max(0, (m - acc) / L))
        out.append([round(la1 + (la2 - la1) * f, 5), round(lo1 + (lo2 - lo1) * f, 5), int(brg)])
    return out, total


# Що є поруч із зоною сервісу, стоянкою, АЗС чи мотелем (окремі об'єкти OSM у радіусі) — коротким кодом.
def fac_of(t):
    a, s, tr = t.get('amenity'), t.get('shop'), t.get('tourism')
    if a == 'toilets':
        return 'wc'
    if a in ('drinking_water', 'water_point'):
        return 'water'
    if t.get('leisure') == 'picnic_table' or tr == 'picnic_site' or a == 'bbq':
        return 'picnic'
    if s in ('convenience', 'supermarket', 'kiosk', 'general'):
        return 'shop'
    if a == 'car_wash':
        return 'wash'
    if a in ('atm', 'bank'):
        return 'atm'
    if s == 'tyres':
        return 'tyres'
    if s in ('car_repair', 'truck_repair'):
        return 'repair'
    if a == 'compressed_air':
        return 'air'
    if tr in ('hotel', 'guest_house', 'hostel'):
        return 'hotel'
    return None


# Те саме, але з тегів самої точки («toilets=yes» на АЗС тощо)
def own_facs(t):
    out = set()
    if t.get('toilets') in ('yes', 'customers'):
        out.add('wc')
    if t.get('drinking_water') == 'yes':
        out.add('water')
    if t.get('compressed_air') == 'yes':
        out.add('air')
    if t.get('car_wash') == 'yes':
        out.add('wash')
    if t.get('shop') in ('yes', 'convenience', 'kiosk'):
        out.add('shop')
    if t.get('atm') == 'yes':
        out.add('atm')
    return out


FAC_R = {'sv': 350, 'ra': 200, 'p': 200, 'f': 120, 'm': 150, 'h': 120}


def info_of(typ, oid, tags):
    """Довідка для картки точки: сайт, телефон, години, оператор, посилання на OSM, вид зони."""
    t, i = tags, {}
    w = (t.get('website') or t.get('contact:website') or t.get('url') or '').strip()
    if w.startswith(('http://', 'https://')) or (w and '.' in w and ' ' not in w):
        i['w'] = (w if w.startswith('http') else 'https://' + w)[:200]
    p = (t.get('phone') or t.get('contact:phone') or t.get('contact:mobile') or '').split(';')[0].strip()
    if p:
        i['p'] = p[:30]
    h = (t.get('opening_hours') or '').strip()
    if h and h != '24/7':
        i['h'] = h[:60]
    o = (t.get('operator') or t.get('brand') or '').strip()
    name = (t.get('name:uk') or t.get('name') or '').strip()
    if o and o.lower() not in name.lower():
        i['o'] = o[:40]
    if t.get('highway') == 'services':
        i['k'] = 'sv'
    elif t.get('highway') == 'rest_area':
        i['k'] = 'ra'
    i['id'] = ('n' if typ == 'n' else 'w') + str(oid)
    return i


def stop_kind(t, is_node):
    a = t.get('amenity')
    if a == 'fuel' or a in FOOD:
        return a
    if a == 'parking' and t.get('hgv') in ('yes', 'designated'):
        return a
    if t.get('highway') in ('services', 'rest_area') or t.get('tourism') == 'motel':
        return 'stop'
    if is_node and t.get('highway') == 'speed_camera':
        return 'cam'
    if has_shower(t):                              # окремий душ або інше місце з душем (туалет, кемпінг, база)
        return 'shower'
    return None


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.items, self.roads, self.places, self.oblasts = [], [], [], []
        self.hz_groups, self.hz_pts = [], []
        self.facs = []
        self.wkb = osmium.geom.WKBFactory()

    def node(self, n):
        t = n.tags
        if stop_kind(t, True):
            self.items.append(('n', n.id, {x.k: x.v for x in t}, n.location.lat, n.location.lon))
        fc = fac_of(t)
        if fc:
            self.facs.append((n.location.lat, n.location.lon, fc))
        if t.get('place') in KIND:
            self.places.append((n.id, {x.k: x.v for x in t}, n.location.lat, n.location.lon))

    def way(self, w):
        t = w.tags
        road = t.get('highway') in ROADS
        kind = stop_kind(t, False)
        hz = hazards_of(t)
        fc = fac_of(t)
        if not road and not kind and not hz and not fc:
            return
        pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        if not pts:
            return
        if fc:
            self.facs.append((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), fc))
        if hz and len(pts) >= 2:
            name = (t.get('ref') or t.get('name:uk') or t.get('name') or '').strip()[:40]
            cache = {}
            for k, v in hz:
                step = SAMPLE_SURF_M if k in ('u', 's') else SAMPLE_M
                if step not in cache:
                    cache[step] = samples(pts, step)
                sm, length = cache[step]
                gid = len(self.hz_groups)
                self.hz_groups.append([k, v, name, int(length), 1 if t.get('bridge') not in (None, 'no') else 0])
                self.hz_pts.extend([p[0], p[1], p[2], gid] for p in sm)
        if road and len(pts) >= 2:
            self.roads.append(LineString([(lon * KX, lat * KY) for lat, lon in pts]))
        if kind:
            ring = pts[:-1] if len(pts) > 2 and pts[0] == pts[-1] else pts
            lat = sum(p[0] for p in ring) / len(ring)
            lon = sum(p[1] for p in ring) / len(ring)
            self.items.append(('w', w.id, {x.k: x.v for x in t}, lat, lon))

    def area(self, a):
        t = a.tags
        code = t.get('ISO3166-2')
        if a.from_way() or t.get('admin_level') != '4' or code not in OBLASTS:
            return
        try:
            self.oblasts.append((code, swkb.loads(self.wkb.create_multipolygon(a), hex=True)))
        except Exception as e:  # битий контур — пропускаємо, але кажемо
            print('контур', code, e, file=sys.stderr)


def main(pbf, stops_out, places_out, hazards_out=None):
    r = Reader()
    r.apply_file(pbf, locations=True, idx='flex_mem')
    print(f'прочитано: точок {len(r.items)}, доріг {len(r.roads)}, населених пунктів {len(r.places)}, областей {len(r.oblasts)}', file=sys.stderr)
    if len(r.oblasts) < int(os.environ.get('REIS_MIN_OBLASTS', 20)):
        raise SystemExit('у файлі замало областей — не зберігаю')

    otree = STRtree([g for _, g in r.oblasts])
    def oblast(lat, lon):
        hit = otree.query(Point(lon, lat), predicate='within')
        return r.oblasts[int(hit[0])][0] if len(hit) else None

    rtree = STRtree(r.roads)
    def near_road(lat, lon):
        return len(rtree.query(Point(lon * KX, lat * KY), predicate='dwithin', distance=FOOD_NEAR_M)) > 0

    # піт-стопи
    rows, food_far = [], 0
    for typ, oid, tags, lat, lon in r.items:
        if oblast(lat, lon) is None:
            continue
        if tags.get('amenity') in FOOD and not near_road(lat, lon):
            food_far += 1
            continue
        x = stop_row({'type': 'node' if typ == 'n' else 'way', 'id': oid, 'tags': tags, 'lat': lat, 'lon': lon})
        if x:
            rows.append(x)
            if x[2] != 'c':
                x.append((typ, oid, tags))          # тимчасово: для довідки нижче
    # довідка: що поруч, сайт, телефон, години — для зон сервісу, стоянок, мотелів, душів і АЗС
    ftree = STRtree([Point(lo * KX, la * KY) for la, lo, _ in r.facs]) if r.facs else None
    with_info = 0
    for x in rows:
        if len(x) < 7:
            continue
        typ, oid, tags = x.pop()
        inf = info_of(typ, oid, tags)
        facs = own_facs(tags)
        rad = FAC_R.get(inf.get('k') or x[2])
        if ftree is not None and rad:
            for j in ftree.query(Point(x[1] * KX, x[0] * KY), predicate='dwithin', distance=rad):
                facs.add(r.facs[int(j)][2])
        if facs:
            inf['fa'] = sorted(facs)
        useful = x[2] in ('s', 'p', 'm', 'h') or any(k in inf for k in ('w', 'p', 'h', 'fa'))
        if not useful:
            continue
        if x[2] in ('e', 'f'):
            inf.pop('id', None)                     # для кафе й АЗС посилання на OSM не тягнемо — їх тисячі
        x.append(inf); with_info += 1
    rows.sort(key=lambda x: (x[2], x[0], x[1]))
    print('з довідкою:', with_info, 'зон сервісу з переліком зручностей:', sum(1 for x in rows if x[2] == 's' and len(x) > 6 and x[6].get('fa')), file=sys.stderr)
    print('піт-стопи:', len(rows), dict(Counter(x[2] for x in rows)), f'(їжа далеко від трас відкинута: {food_far})', file=sys.stderr)
    print('з душем:', sum(1 for x in rows if x[3] & 2), dict(Counter(x[2] for x in rows if x[3] & 2)), file=sys.stderr)

    # населені пункти
    prow = []
    for oid, t, lat, lon in r.places:
        code = oblast(lat, lon)
        if code is None:
            continue
        uk = (t.get('name:uk') or t.get('name') or '').strip()
        if not uk:
            continue
        ru = (t.get('name:ru') or '').strip()
        prow.append([round(lat, 5), round(lon, 5), KIND[t['place']], uk, ru if ru != uk else '', OBLASTS[code], pop(t.get('population'))])
    order = {'c': 0, 't': 1, 'v': 2}
    prow.sort(key=lambda x: (order[x[2]], -x[6], x[3]))
    print('населені пункти:', len(prow), dict(Counter(x[2] for x in prow)), file=sys.stderr)

    date = datetime.date.today().strftime('%Y%m%d')
    ok = True
    # проблемні ділянки — лише в Україні
    keep, remap, pts = set(), {}, []
    for la, lo, brg, gid in r.hz_pts:
        if gid in keep or oblast(la, lo) is not None:
            keep.add(gid)
    groups = []
    for gid, gr in enumerate(r.hz_groups):
        if gid in keep:
            remap[gid] = len(groups); groups.append(gr)
    pts = [[la, lo, brg, remap[gid]] for la, lo, brg, gid in r.hz_pts if gid in remap]
    print('проблемні ділянки:', len(groups), dict(Counter(g[0] for g in groups)), 'точок', len(pts), file=sys.stderr)
    if hazards_out and len(groups) >= int(os.environ.get('REIS_MIN_HAZARDS', 500)):
        flat, pla, plo, pg = [], 0, 0, 0
        for la, lo, brg, gid in pts:
            a, b = round(la * 1e5), round(lo * 1e5)
            flat += [a - pla, b - plo, brg // 5, gid - pg]
            pla, plo, pg = a, b, gid
        with open(hazards_out, 'w', encoding='utf-8') as fh:
            json.dump({'v': 2, 'date': date, 'groups': groups, 'pts': flat}, fh, ensure_ascii=False, separators=(',', ':'))
        print('hazards.json', os.path.getsize(hazards_out) // 1024, 'КБ', file=sys.stderr)
    if len(rows) >= int(os.environ.get('REIS_MIN_STOPS', 3000)):
        with open(stops_out, 'w', encoding='utf-8') as fh:
            json.dump({'v': 1, 'date': date, 'rows': rows}, fh, ensure_ascii=False, separators=(',', ':'))
    else:
        print('підозріло мало піт-стопів — базу не чіпаю', file=sys.stderr); ok = False
    if len(prow) >= int(os.environ.get('REIS_MIN_PLACES', 10000)):
        with open(places_out, 'w', encoding='utf-8') as fh:
            json.dump({'v': 1, 'date': date, 'rows': prow}, fh, ensure_ascii=False, separators=(',', ':'))
    else:
        print('підозріло мало населених пунктів — довідник не чіпаю', file=sys.stderr); ok = False
    if not ok and os.environ.get('REIS_STRICT') == '1':
        raise SystemExit(1)


if __name__ == '__main__':
    main(*sys.argv[1:5])
