#!/usr/bin/env python3
"""База піт-стопів для фур по всій Україні з OpenStreetMap (через Overpass).

Запускає GitHub Actions (робочий процес «Піт-стопи»). Результат — web/data/stops.json:
  {"v": 1, "date": "YYYYMMDD", "rows": [[lat, lon, type, flags, name, extra], ...]}
type:  f — АЗС, s — зона сервісу / майданчик відпочинку, p — стоянка для фур,
       e — їжа біля траси (кафе, ресторан), m — мотель, c — камера швидкості,
       h — душ (окремий душ або інше місце, де OSM каже, що є душ)
flags: 1 для фур, 2 душ, 4 їжа, 8 туалет, 16 цілодобово, 32 велика мережа
extra: для камер — обмеження швидкості
"""
import json, re, sys, time, urllib.request, urllib.parse, datetime

MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
UA = 'area["ISO3166-1"="UA"][admin_level=2]->.ua;'
QUERIES = {
    'base': f'''[out:json][timeout:900][maxsize:1073741824];{UA}
(
  nwr["amenity"="fuel"](area.ua);
  nwr["highway"~"^(services|rest_area)$"](area.ua);
  nwr["amenity"="parking"]["hgv"~"^(yes|designated)$"](area.ua);
  nwr["tourism"="motel"](area.ua);
  node["highway"="speed_camera"](area.ua);
);
out center tags;''',
}
# їжа лише біля великих доріг — шматками 3°×2°, щоб важкий запит «поруч із дорогою» не падав на сервері
for lo in range(22, 41, 3):
    for la in (44.3, 46.3, 48.3, 50.3):
        QUERIES[f'food {la},{lo}'] = f'''[out:json][timeout:600];{UA}
way["highway"~"^(motorway|trunk|primary)$"]({la},{lo},{la + 2},{lo + 3})->.roads;
nwr["amenity"~"^(restaurant|cafe|fast_food)$"](area.ua)(around.roads:120);
out center tags;'''
BIG = re.compile(r'okko|окко|wog|upg|socar|shell|amic|brsm|брсм|ukrnafta|укрнафта|klo|кло|avantage|авантаж|motto|мотто|glusco|chipo|ovis|катрал|katral', re.I)


def overpass(q):
    last = None
    for attempt in range(3):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'Reis-truck-nav/1.0 (github.com/postsich-beep/reis)'})
                with urllib.request.urlopen(req, timeout=1000) as r:
                    data = json.load(r)
                if 'error' in str(data.get('remark', '')).lower():   # сервер не встиг — це не порожня відповідь
                    raise RuntimeError(data['remark'][:200])
                return data
            except Exception as e:  # пробуємо інше дзеркало
                last = e
                print('overpass', url, e, file=sys.stderr)
        time.sleep(60)
    raise SystemExit(f'Overpass недоступний: {last}')


def yes(v):
    return str(v or '').lower() in ('yes', 'designated', '24/7')


SHOWER_YES = ('yes', 'paid', 'fee', 'free', 'hot', 'hot_water', 'customers', 'designated', 'public', 'outdoor', 'indoor')


def has_shower(t):
    return t.get('amenity') == 'shower' or any(str(t.get(k, '')).lower() in SHOWER_YES for k in ('shower', 'amenity:shower', 'shower:hgv'))


def row(el):
    t = el.get('tags', {})
    lat = el.get('lat', (el.get('center') or {}).get('lat'))
    lon = el.get('lon', (el.get('center') or {}).get('lon'))
    if lat is None or lon is None:
        return None
    name = (t.get('name:uk') or t.get('name') or t.get('brand') or t.get('operator') or '').strip()[:60]
    if t.get('highway') == 'speed_camera':
        m = re.match(r'\d+', t.get('maxspeed', ''))
        return [round(lat, 5), round(lon, 5), 'c', 0, '', int(m.group()) if m else 0]
    if t.get('amenity') == 'fuel':
        typ = 'f'
    elif t.get('highway') in ('services', 'rest_area'):
        typ = 's'
    elif t.get('amenity') == 'parking':
        typ = 'p'
    elif t.get('tourism') == 'motel':
        typ = 'm'
    elif t.get('amenity') in ('restaurant', 'cafe', 'fast_food'):
        typ = 'e'
    elif has_shower(t):
        typ = 'h'
    else:
        typ = 'e'
    f = 0
    if yes(t.get('hgv')) or t.get('fuel:HGV_diesel') == 'yes' or typ == 'p':
        f |= 1
    if has_shower(t):
        f |= 2
    if typ == 'e' or any(yes(t.get(k)) for k in ('restaurant', 'cafe', 'fast_food')) or t.get('shop') == 'convenience' or t.get('cuisine'):
        f |= 4
    if yes(t.get('toilets')):
        f |= 8
    if t.get('opening_hours') == '24/7':
        f |= 16
    if BIG.search(name + ' ' + t.get('brand', '') + ' ' + t.get('operator', '')):
        f |= 32
    return [round(lat, 5), round(lon, 5), typ, f, name, 0]


def main(out):
    rows, seen = [], set()
    for key, q in QUERIES.items():
        data = overpass(q)
        n = 0
        for el in data.get('elements', []):
            k = el['type'][0] + str(el['id'])
            if k in seen:
                continue
            seen.add(k)
            r = row(el)
            if r:
                rows.append(r)
                n += 1
        print(f'{key}: {n}', file=sys.stderr)
        time.sleep(3)
    rows.sort(key=lambda r: (r[2], r[0], r[1]))
    from collections import Counter
    print('усього', len(rows), dict(Counter(r[2] for r in rows)), file=sys.stderr)
    if len(rows) < 3000:
        raise SystemExit('підозріло мало точок — не зберігаю')
    doc = {'v': 1, 'date': datetime.date.today().strftime('%Y%m%d'), 'rows': rows}
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'web/data/stops.json')
