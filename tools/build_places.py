#!/usr/bin/env python3
"""Довідник населених пунктів України для миттєвих підказок без інтернету.

Запускає GitHub Actions (робочий процес «Населені пункти»). По одній області з OpenStreetMap:
міста, селища, села. Результат — web/data/places.json:
  {"v": 1, "date": "YYYYMMDD", "rows": [[lat, lon, kind, name_uk, name_ru, oblast, population], ...]}
kind: c — місто, t — селище (town), v — село
"""
import json, sys, time, urllib.request, urllib.parse, datetime

MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
OBLASTS = {
    'UA-05': 'vinnytsia', 'UA-07': 'volyn', 'UA-09': 'luhansk', 'UA-12': 'dnipro', 'UA-14': 'donetsk', 'UA-18': 'zhytomyr',
    'UA-21': 'zakarpattia', 'UA-23': 'zaporizhzhia', 'UA-26': 'ivano-frankivsk', 'UA-30': 'kyiv', 'UA-32': 'kyiv', 'UA-35': 'kirovohrad',
    'UA-46': 'lviv', 'UA-48': 'mykolaiv', 'UA-51': 'odesa', 'UA-53': 'poltava', 'UA-56': 'rivne', 'UA-59': 'sumy', 'UA-61': 'ternopil',
    'UA-63': 'kharkiv', 'UA-65': 'kherson', 'UA-68': 'khmelnytskyi', 'UA-71': 'cherkasy', 'UA-74': 'chernihiv', 'UA-77': 'chernivtsi',
    'UA-43': 'crimea', 'UA-40': 'crimea',
}
KIND = {'city': 'c', 'town': 't', 'village': 'v'}


def overpass(q):
    last = None
    for attempt in range(4):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(),
                                             headers={'User-Agent': 'Reis-truck-nav/1.0 (github.com/postsich-beep/reis)'})
                with urllib.request.urlopen(req, timeout=400) as r:
                    data = json.load(r)
                if 'error' in str(data.get('remark', '')).lower():
                    raise RuntimeError(data['remark'][:200])
                return data
            except Exception as e:
                last = e
                print('overpass', url, e, file=sys.stderr)
        time.sleep(45)
    raise SystemExit(f'Overpass недоступний: {last}')


def pop(v):
    try:
        return int(str(v).replace(' ', '').split(';')[0])
    except Exception:
        return 0


def main(out):
    rows, seen = [], set()
    for code, ob in OBLASTS.items():
        q = f'''[out:json][timeout:300];area["ISO3166-2"="{code}"]->.a;node["place"~"^(city|town|village)$"](area.a);out body qt;'''
        data = overpass(q)
        n = 0
        for el in data.get('elements', []):
            if el['id'] in seen:
                continue
            seen.add(el['id'])
            t = el.get('tags', {})
            uk = (t.get('name:uk') or t.get('name') or '').strip()
            if not uk:
                continue
            ru = (t.get('name:ru') or '').strip()
            rows.append([round(el['lat'], 5), round(el['lon'], 5), KIND[t['place']], uk, ru if ru != uk else '', ob, pop(t.get('population'))])
            n += 1
        print(f'{code} {ob}: {n}', file=sys.stderr)
        time.sleep(3)
    from collections import Counter
    print('усього', len(rows), dict(Counter(r[2] for r in rows)), file=sys.stderr)
    if len(rows) < 10000:
        raise SystemExit('підозріло мало населених пунктів — не зберігаю')
    order = {'c': 0, 't': 1, 'v': 2}
    rows.sort(key=lambda r: (order[r[2]], -r[6], r[3]))
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump({'v': 1, 'date': datetime.date.today().strftime('%Y%m%d'), 'rows': rows}, fh, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'web/data/places.json')
