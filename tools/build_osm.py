#!/usr/bin/env python3
"""Піт-стопи й населені пункти України з вивантаження OpenStreetMap (Geofabrik) — без Overpass.

Публічні сервери Overpass часто перевантажені (502/504), тому дані беремо з готового файлу країни.
Запуск (робочий процес «Дані OpenStreetMap»):
  python3 tools/build_osm.py filtered.osm.pbf web/data/stops.json web/data/places.json
Формат рядків той самий, що й раніше (див. build_stops.py і build_places.py).
"""
import datetime, json, os, sys
from collections import Counter

import osmium
from shapely import wkb as swkb
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_stops import row as stop_row          # noqa: E402  — та сама класифікація АЗС, стоянок, мотелів, камер
from build_places import OBLASTS, KIND, pop      # noqa: E402

FOOD = {'restaurant', 'cafe', 'fast_food'}
ROADS = {'motorway', 'trunk', 'primary'}
FOOD_NEAR_M = 120                                 # їжа — лише в 120 м від великої дороги
KX, KY = 111320 * 0.66, 111320                    # метри на градус для середньої широти України (~48.5°)


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
    return None


class Reader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.items, self.roads, self.places, self.oblasts = [], [], [], []
        self.wkb = osmium.geom.WKBFactory()

    def node(self, n):
        t = n.tags
        if stop_kind(t, True):
            self.items.append(('n', n.id, {x.k: x.v for x in t}, n.location.lat, n.location.lon))
        if t.get('place') in KIND:
            self.places.append((n.id, {x.k: x.v for x in t}, n.location.lat, n.location.lon))

    def way(self, w):
        t = w.tags
        road = t.get('highway') in ROADS
        kind = stop_kind(t, False)
        if not road and not kind:
            return
        pts = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        if not pts:
            return
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


def main(pbf, stops_out, places_out):
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
    rows.sort(key=lambda x: (x[2], x[0], x[1]))
    print('піт-стопи:', len(rows), dict(Counter(x[2] for x in rows)), f'(їжа далеко від трас відкинута: {food_far})', file=sys.stderr)

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
    main(*sys.argv[1:4])
