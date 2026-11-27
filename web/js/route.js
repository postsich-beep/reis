// Рейси: пошук адрес, маршрут для фури (Valhalla), регіони на шляху, збереження.
import { bus, log, S, db, hav, decodePolyline6, RouteIndex, uid, sleep, TRUCK_MAX_T } from './core.js';
import { getJson, http } from './platform.js';
import { withGates } from './gates.js';

const PHOTON = 'https://photon.komoot.io';
const UA_BBOX = '22.0,44.0,40.5,52.7';

/* ---------- пошук місця ---------- */
export async function geocode(q, near) {
  q = q.trim(); if (!q) return [];
  const m = q.match(/^\s*(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)\s*$/);     // «49.99, 36.23»
  if (m) { const lat = +m[1].replace(',', '.'), lon = +m[2].replace(',', '.'); return [{ lat, lon, label: lat.toFixed(5) + ', ' + lon.toFixed(5), sub: '' }]; }
  let url = PHOTON + '/api/?q=' + encodeURIComponent(q) + '&limit=20&bbox=' + UA_BBOX;
  if (near) url += '&lat=' + near.lat.toFixed(4) + '&lon=' + near.lon.toFixed(4);
  const j = await photon(url);
  const nq = normName(q);
  const out = (j.features || []).map((f, i) => {
    const p = clean(f.properties || {}), c = f.geometry.coordinates;
    const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || '';
    const sub = [p.street && p.name ? [p.street, p.housenumber].filter(Boolean).join(' ') : '', p.city !== name ? p.city : '', p.county, p.state].filter(Boolean).join(', ');
    // лише Україна: у прямокутник пошуку потрапляють і шматки Росії та Білорусі
    const ua = p.countrycode ? p.countrycode === 'UA' : /укра|ukrain|украин/i.test(p.country || '');
    // великі міста — вище за однойменні села поблизу («Львов» = Львів, а не село під Бєлгородом)
    const kind = p.osm_key === 'place' ? ({ city: 50, town: 38, village: 22, suburb: 16, hamlet: 10 }[p.osm_value] || 12) : 6;
    const nn = normName(name), exact = nn === nq ? 30 : nn.startsWith(nq) ? 10 : 0;
    const close = near && Math.hypot((c[1] - near.lat) * 111, (c[0] - near.lon) * 71) < 40 ? 6 : 0;
    // (1.1.29) вулиця без номера — у пошуку під нею кнопка «Вказати номер будинку»; місто — щоб шукати номер саме там
    const street = (p.osm_key === 'highway' || p.type === 'street') && !p.housenumber, city = p.city || p.town || p.village || p.locality || '';
    const place = p.osm_key === 'place' ? p.osm_value || '' : '';
    return { lat: c[1], lon: c[0], label: name, sub, ua, street, city, place, score: kind + exact + close + (20 - i) * 0.5 };
  }).filter(x => x.label && x.ua);
  const top = out.sort((a, b) => b.score - a.score).slice(0, 12).map(({ lat, lon, label, sub, street, city, place }) => ({ lat, lon, label, sub, street, city, place }));
  return rankPlaces(top, q, near);
}
// (1.1.30) Порядок результатів пошуку, як просив Олексій:
//  1) міста й селища з такою назвою — від більшого до меншого: «Миколаїв, Миколаївська обл.» раніше за «Миколаїв, Львівська обл.»;
//  2) далі все інше — вулиці, адреси, села, місця — від найближчого до дальшого: «вулиця Рядова» спершу у Львові, де ви є,
//     потім у Городку, Тернополі, Києві.
// ref — від чого міряти (моє місце, місто вулиці, середина карти); без нього лишається порядок сервера.
export function rankPlaces(list, q, ref) {
  const w = normName(String(q || '').split(',')[0]).split(' ').filter(Boolean)[0] || '';
  const size = x => x.kind === 'c' || x.place === 'city' ? 3 : x.kind === 't' || x.place === 'town' ? 2 : 0;
  // з довідника в телефоні — це збіг назви (українською чи російською); із сервера — назва має починатися з набраного
  const big = x => size(x) && (x.local || (w && normName(x.label).startsWith(w))) ? size(x) : 0;
  const has = ref && ref.lat != null;
  return list.map((x, i) => ({ x, i, b: big(x), d: has ? hav(ref, x) : 0 }))
    .sort((a, b) => (b.b - a.b) || (a.b ? (b.x.pop || 0) - (a.x.pop || 0) : 0) || (a.d - b.d) || (a.i - b.i)).map(o => o.x);
}
// (1.1.29) Назви — мовою місцевості (в Україні — українською), а не мовою телефона: без lang сервер брав мову з налаштувань телефона й
// віддавав «Lviv», «Chukarina». Якщо сервер колись не прийме lang=default — питаємо без нього.
async function photon(url) {
  try { return await getJson(url + '&lang=default', { timeout: 12000 }); }
  catch (e) { if (e.status === 400) return getJson(url, { timeout: 12000 }); throw e; }
}
// У даних OSM буває кілька значень через «;» («Chukarina;School») — беремо перше
const CLEAN = ['name', 'street', 'city', 'town', 'village', 'locality', 'county', 'state', 'district'];
function clean(p) { const o = { ...p }; for (const k of CLEAN) if (typeof o[k] === 'string') o[k] = o[k].split(';')[0].trim(); return o; }
// Порівняння назв без різниці між українським і російським написанням (Львів/Львов, Київ/Киев).
export function normName(s) {
  return String(s || '').toLowerCase().replace(/[ʼ'’`\-ьъ]/g, '')
    .replace(/їв(?=\s|$)/g, 'ев').replace(/ів(?=\s|$)/g, 'ов')
    .replace(/[іїиый]/g, 'и').replace(/[еєэё]/g, 'е').replace(/ґ/g, 'г')
    .replace(/(.)\1+/g, '$1').replace(/\s+/g, ' ').trim();
}

export async function reverse(lat, lon) {
  const j = await photon(PHOTON + '/reverse?lat=' + lat.toFixed(5) + '&lon=' + lon.toFixed(5));
  const p = j.features && j.features[0] && clean(j.features[0].properties || {});
  return p ? { name: p.name || '', city: p.city || p.town || p.village || p.name || '', county: p.county || '', state: p.state || '', cc: p.countrycode || '' } : null;
}

/* ---------- області України ---------- */
export const OBLASTS = [
  ['vinnytsia', 'Вінницька', 'Винницкая', 'вінни|винниц|vinny|вінничч'], ['volyn', 'Волинська', 'Волынская', 'волин|волын|volyn'],
  ['dnipro', 'Дніпропетровська', 'Днепропетровская', 'дніпроп|днепроп|dnipro|дніпровщ|дніпр(о|і|а)(\\s|,|\\.|$)'], ['donetsk', 'Донецька', 'Донецкая', 'донец|донеч|donet'],
  ['zhytomyr', 'Житомирська', 'Житомирская', 'житомир|zhytomyr'], ['zakarpattia', 'Закарпатська', 'Закарпатская', 'закарпат|zakarpat'],
  ['zaporizhzhia', 'Запорізька', 'Запорожская', 'запоріз|запоріж|запорож|zapori'], ['ivano-frankivsk', 'Івано-Франківська', 'Ивано-Франковская', 'франків|франков|frankiv|прикарпат'],
  ['kyiv', 'Київська', 'Киевская', 'київ|киев|kyiv|kiev'], ['kirovohrad', 'Кіровоградська', 'Кировоградская', 'кіровоград|кировоград|kirovo|кропивниц'],
  ['luhansk', 'Луганська', 'Луганская', 'луган|luhan'], ['lviv', 'Львівська', 'Львовская', 'львів|львов|lviv'],
  ['mykolaiv', 'Миколаївська', 'Николаевская', 'миколаїв|николаев|mykola'], ['odesa', 'Одеська', 'Одесская', 'одес|odes'],
  ['poltava', 'Полтавська', 'Полтавская', 'полтав|poltav'], ['rivne', 'Рівненська', 'Ровенская', 'рівнен|ровен|rivne|рівне|рівного'],
  ['sumy', 'Сумська', 'Сумская', 'сумськ|сумск|sumy|sumsk|сумщ|суми|сумах'], ['ternopil', 'Тернопільська', 'Тернопольская', 'терноп|ternop'],
  ['kharkiv', 'Харківська', 'Харьковская', 'харків|харьков|khark'], ['kherson', 'Херсонська', 'Херсонская', 'херсон|kherson'],
  ['khmelnytskyi', 'Хмельницька', 'Хмельницкая', 'хмельн|khmel'], ['cherkasy', 'Черкаська', 'Черкасская', 'черкас|черкащ|cherkas'],
  ['chernivtsi', 'Чернівецька', 'Черновицкая', 'чернівец|черновиц|chernivts|буковин'], ['chernihiv', 'Чернігівська', 'Черниговская', 'чернігів|чернигов|chernihiv'],
  ['crimea', 'АР Крим', 'АР Крым', 'крим|крым|crimea']
].map(([id, uk, ru, re]) => ({ id, uk, ru, re: new RegExp(re, 'i') }));
// Обласні центри: куди ставити позначку, якщо подія стосується всієї області.
export const OBLAST_CENTER = {
  vinnytsia: [49.233, 28.468], volyn: [50.747, 25.325], dnipro: [48.464, 35.046], donetsk: [48.723, 37.556], zhytomyr: [50.254, 28.658],
  zakarpattia: [48.621, 22.288], zaporizhzhia: [47.838, 35.139], 'ivano-frankivsk': [48.922, 24.711], kyiv: [50.45, 30.523], kirovohrad: [48.508, 32.262],
  luhansk: [48.948, 38.49], lviv: [49.839, 24.029], mykolaiv: [46.975, 31.994], odesa: [46.482, 30.723], poltava: [49.588, 34.551], rivne: [50.619, 26.252],
  sumy: [50.907, 34.798], ternopil: [49.553, 25.594], kharkiv: [49.993, 36.23], kherson: [46.635, 32.616], khmelnytskyi: [49.422, 26.996],
  cherkasy: [49.444, 32.059], chernivtsi: [48.292, 25.935], chernihiv: [51.498, 31.289], crimea: [44.952, 34.102]
};
// Пошук населеного пункту (не вулиці, не магазину) в межах України.
export async function placeSearch(q) {
  const url = PHOTON + '/api/?q=' + encodeURIComponent(q) + '&limit=4&bbox=' + UA_BBOX +
    '&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village&osm_tag=place:hamlet&osm_tag=place:suburb';
  const j = await photon(url);
  return (j.features || []).map(f => ({ name: (f.properties || {}).name || '', state: (f.properties || {}).state || '', lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] })).filter(x => x.name);
}
export const townName = x => typeof x === 'string' ? x : (x && x.name) || '';
export const oblastOf = s => { if (!s) return null; const o = OBLASTS.find(o => o.re.test(s)); return o ? o.id : null; };
export const oblastName = id => { const o = OBLASTS.find(o => o.id === id); return o ? (S.lang === 'ru' ? o.ru : o.uk) : id; };

/* ---------- маршрут ---------- */
// Дороги зі знаком «рух вантажівок заборонено» (hgv=no в OpenStreetMap). Буває, що знак є, а іншої дороги немає — і всі фури
// їздять саме нею (Івано-Франківськ). «М'який» рейс (1.1.12): такі дороги дозволені, але кожен в'їзд на них «коштує» кілька хвилин,
// тож сервер веде ними лише тоді, коли об'їзд справді довгий. Висота, маса, довжина й небезпечний вантаж перевіряються, як і завжди.
export const HGV_SOFT = { ask: 600, go: 120 };            // «ціна» в'їзду під знак, секунд: варіант на вибір / «їхати завжди»
// (1.1.31) Дороги «як у Google»: траси М і Е — у пріоритеті (use_highways 1; за замовчуванням сервер їм переваги не дає),
// польові дороги (track), житлові зони (living street) і проїзди дворами/до заправок (service) — лише коли інакше ніяк,
// ґрунт і щебінь — лише на початку чи в кінці шляху (exclude_unpaved), коли без них не під'їхати.
export const ROAD_PREF = { use_highways: 1, use_tracks: 0, use_living_streets: 0, service_penalty: 30, exclude_unpaved: true };
// (1.1.39) ЧОМУ ШЛЯХ БУВ НЕ ТАКИЙ, ЯК У GOOGLE. Обмежувач швидкості фури (90) ми передавали серверу як top_speed — щоб час у дорозі
// був для фури. Але сервер (Valhalla) цим параметром ще й ВИБИРАЄ дороги: кожній дорозі, де їздять швидше за top_speed, він
// додає до «ціни» 5 % за кожен км/год понад нього (SpeedPenalty у sif/dynamiccost.h: (швидкість − top_speed) × 0,05).
// Дорога 110 км/год при обмежувачі 90 ставала вдвічі «дорожчою», автомагістраль 130 — утричі. Тобто найкращі траси (М-05, М-06,
// об'їзні з розділювачем) програма обминала старими дорогами через села — «гіршими й довшими», як і писав Діма. Google так
// не робить: він веде найшвидшим шляхом для легковика, головними трасами.
// Тепер top_speed серверу не передаємо взагалі: дороги він вибирає, як для звичайної машини, — так само, як Google.
// А час у дорозі для фури з обмежувачем рахуємо самі (truckTime нижче).
export function truckOptions(soft = 0) {
  const t = S.truck, o = { height: +t.height, width: +t.width, length: +t.length, weight: Math.min(+t.weight, TRUCK_MAX_T), axle_load: +t.axle, hazmat: !!t.hazmat };
  if (soft > 0) o.hgv_no_access_penalty = soft;            // менше 43200 — сервер дозволяє дороги без доступу для фур, із цим штрафом
  return { ...ROAD_PREF, ...o };
}
// (1.1.28) «Як Google» (було «на свій розсуд»): фура їде дорогами загального користування — обмежень для фур сервер не враховує
// (costing auto). (1.1.39) Дороги вибираються точно як для легковика — без top_speed; час для фури рахуємо самі.
function autoOptions() { return { auto: { ...ROAD_PREF } }; }
// Обмежувач фури, км/год (0 — легковик або вимкнено)
export const limiterKmh = () => { if (S.vehicle === 'auto') return 0; const v = +((S.truck || {}).vmax); return v > 0 ? v : 0; };
/* (1.1.39) Час у дорозі для фури з обмежувачем — на маршруті, вибраному «як для легковика».
   Сервер дає для кожного відрізка (маневру) довжину й час, тобто середню швидкість легковика v. Фура їде не швидше за обмежувач L.
   Просто обрізати середню не можна: на відрізку «80 км трасою 110 + 20 км селами 50» середня 89 — нібито нижча за 90, а фура
   насправді їде його на 14 % довше. Тому «м'який мінімум»: vф = (v⁻⁶ + L⁻⁶)^(−1/6). Він дає 88 замість 90 на чистій магістралі
   (130), 80 на мішаному відрізку із середньою 89 і майже не чіпає повільні (50 → 49,8). Похибка проти точного розрахунку — кілька %. */
export function truckTime(r, kmh = limiterKmh()) {
  if (!r || !(kmh > 0) || r.timeSrv != null) return r;
  const L = kmh / 3.6; let add = 0;
  for (const m of r.mans || []) {
    if (!(m.len > 0) || !(m.time > 0)) continue;
    const v = m.len / m.time, vt = Math.pow(Math.pow(v, -6) + Math.pow(L, -6), -1 / 6), t2 = m.len / vt;
    add += t2 - m.time; m.timeSrv = m.time; m.time = t2;
  }
  r.timeSrv = r.time; r.time = Math.round(r.time + add);
  return r;
}
// pts: [{lat,lon,type}], перший і останній — зупинки, проміжні — «through» (маршрут проходить крізь точку)
// snap — «чіпляти» точки лише за дороги не нижче цього класу ('unclassified' — без дворів, заправок, житлових вуличок;
// 'tertiary' — лише траси й проспекти) і лише за добре з'єднані ділянки
// paved — спершу без ґрунтових доріг посередині шляху; якщо так проїзду немає (442) — ще раз, уже з ними (у глушині буває лише ґрунт)
export async function requestRoute(pts, heading, costing = 'truck', alternates = 0, snap = null, soft = 0, paved = true) {
  const locations = pts.map((p, i) => {
    const l = { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), type: (i === 0 || i === pts.length - 1) ? 'break' : 'through' };
    if (snap) { l.search_filter = { min_road_class: snap }; l.minimum_reachability = 300; }
    if (i === 0 && heading != null) { l.heading = Math.round(heading); l.heading_tolerance = 60; }
    // точка на вибраному маршруті: з напрямком руху, щоб на трасі з розділювачем не «прилипла» до зустрічної смуги
    else if (p.brg != null) { l.heading = Math.round(p.brg); l.heading_tolerance = 45; }
    return l;
  });
  const body = {
    locations, costing, costing_options: costing === 'truck' ? { truck: truckOptions(soft) } : costing === 'auto' ? autoOptions() : {},
    units: 'kilometers', language: S.lang === 'ru' ? 'ru-RU' : 'uk-UA', directions_type: 'instructions'
  };
  if (!paved) for (const k in body.costing_options) delete body.costing_options[k].exclude_unpaved;
  if (alternates > 0 && pts.length === 2) body.alternates = alternates;      // запасні варіанти — лише для А → Б без проміжних
  // GET із параметром json — «простий» запит, сервер відповідає сторінкам без попередньої перевірки CORS.
  const r = await http(S.routeUrl.replace(/\/+$/, '') + '/route?json=' + encodeURIComponent(JSON.stringify(body)), { timeout: 45000 });
  let j; try { j = JSON.parse(r.text); } catch (_) { throw new Error('HTTP ' + r.status); }
  if (r.status !== 200 || !j.trip) {
    const e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.error_code;
    if (paved && e.code === 442 && (costing === 'truck' || costing === 'auto')) { await sleep(1100); return requestRoute(pts, heading, costing, alternates, snap, soft, false); }
    throw e;
  }
  const main = truckTime(parseTrip(j.trip));
  main.alts = [];
  for (const a of j.alternates || []) { try { if (a && a.trip) main.alts.push(truckTime(parseTrip(a.trip))); } catch (_) {} }
  return main;
}
// Головні дороги маршруту для картки варіанта: «М-06, Н-01» — за довжиною
export function mainRoads(r, n = 3) {
  const m = new Map();
  for (const x of r.mans || []) for (const s of x.streets || []) {
    const ref = String(s).match(/^\s*([МНРТEМHPTE])\s*-?\s*(\d{1,3}(?:-\d{2})?)\s*$/i);
    if (ref) { const k = ref[1].toUpperCase().replace('M', 'М').replace('H', 'Н').replace('P', 'Р').replace('T', 'Т') + '-' + ref[2].padStart(2, '0'); m.set(k, (m.get(k) || 0) + (x.len || 0)); }
  }
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}
/* ---------- (1.1.31) котрий варіант показати першим ----------
   Сервер рахує час за типовими швидкостями доріг і не знає, що дорога через села — це ями, «лежачі поліцейські», трактори й люди
   на узбіччі. Тому путівець через села в нього буває «швидшим» за трасу, хоча Google (і водій) знає, що трасою швидше.
   Перед показом перераховуємо: час на місцевих дорогах (без номера М/Н/Е/Р/Т) — на третину довший, на Р і Т — на десяту.
   Показуємо й далі час сервера; цей «реальний» — лише щоб вибрати, котрий варіант першим (вибраним). */
export const ROAD_SLOW = { a: 1, b: 1.1, c: 1.35 };
export function roadCat(names) {
  const n = (names || []).map(x => String(x).trim());
  if (n.some(x => /^(?:[МM]|[НH]|[ЕE])\s?-?\s?\d/.test(x))) return 'a';
  if (n.some(x => /^(?:[РP]|[ТT])\s?-?\s?\d/.test(x))) return 'b';
  return 'c';
}
// частки довжини маршруту за категоріями доріг: a — М, Н, Е; b — Р, Т; c — місцеві дороги й вулиці
export function roadShare(r) {
  const len = { a: 0, b: 0, c: 0 };
  for (const m of (r && r.mans) || []) len[roadCat(m.streets)] += m.len || 0;
  const tot = len.a + len.b + len.c;
  return tot > 0 ? { a: len.a / tot, b: len.b / tot, c: len.c / tot } : null;
}
// (1.1.39) Порядок варіантів рахуємо за часом СЕРВЕРА (timeSrv — як для легковика): Google теж ставить першим найшвидший для
// легковика. Час для фури з обмежувачем (time) — те, що показуємо на картці; на порядок він не впливає.
const srvT = x => x.timeSrv != null ? x.timeSrv : x.time;
export function realTime(r) {
  let t = 0, w = 0;
  for (const m of (r && r.mans) || []) { const mt = srvT(m); if (mt > 0) { t += mt; w += mt * ROAD_SLOW[roadCat(m.streets)]; } }
  return t > 0 ? srvT(r) * w / t : srvT(r);
}
// Перший — найменший «реальний» час; але не той, що за сервером набагато (на чверть і більше) повільніший за найшвидший.
export function rankRoutes(list) {
  const fast = Math.min(...list.map(srvT)), cap = fast * 1.25 + 120;
  return list.map((r, i) => ({ r, i, far: srvT(r) > cap ? 1 : 0, e: realTime(r) }))
    .sort((x, y) => (x.far - y.far) || (x.e - y.e) || (x.i - y.i)).map(o => o.r);
}
// Варіант помітно більше йде місцевими дорогами, ніж рекомендований, — «через села»
export const viaVillages = (r, rec) => { if (!r || !rec || r === rec) return false; const a = roadShare(r), b = roadShare(rec); return !!(a && b && a.c - b.c >= 0.15); };
export function parseTrip(trip) {
  const coords = [], mans = [];
  let dist = 0, time = 0;
  for (const leg of trip.legs || []) {
    const shape = decodePolyline6(leg.shape), base = coords.length ? coords.length - 1 : 0;
    if (coords.length) shape.shift();                       // стик ділянок: без дубля точки
    for (const c of shape) coords.push(c);
    for (const m of leg.maneuvers || []) {
      mans.push({
        type: m.type, ins: m.instruction || '', alert: m.verbal_transition_alert_instruction || '',
        pre: m.verbal_pre_transition_instruction || m.instruction || '', post: m.verbal_post_transition_instruction || '',
        street: (m.street_names || [])[0] || '', streets: m.street_names || [], len: (m.length || 0) * 1000, time: m.time || 0,
        i0: base + m.begin_shape_index, i1: base + m.end_shape_index, exits: m.roundabout_exit_count || 0
      });
    }
    dist += (leg.summary && leg.summary.length || 0) * 1000; time += (leg.summary && leg.summary.time || 0);
  }
  if (coords.length < 2) throw new Error('empty route');
  return { coords, mans, dist, time };
}

/* ---------- регіони вздовж маршруту (для аналізу наперед) ---------- */
export async function regionsAlong(idx, onStep) {
  const regions = [], towns = [], foreign = [];
  const stepM = Math.max(15000, Math.min(30000, idx.total / 12)), n = Math.floor(idx.total / stepM);
  let last = null, prevD = null;
  for (let i = 0; i <= n; i++) {
    const d = Math.min(idx.total, i * stepM), p = idx.at(d);
    try {
      const r = await reverse(p.lat, p.lon);
      const id = r && oblastOf(r.state);
      if (r && r.city && !towns.some(x => x.name === r.city)) towns.push({ name: r.city, lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), d: Math.round(d) });
      if (id && id !== last) { regions.push(prevD == null ? { id, d } : { id, d, d0: prevD }); last = id; }   // d0 — попередня точка: межа десь між ними
      if (r && r.cc && r.cc !== 'UA' && !foreign.includes(r.cc)) foreign.push(r.cc);     // маршрут виходить за кордон
    } catch (e) { log('warn', 'reverse: ' + e.message); }
    prevD = d;
    if (onStep) onStep(i, n);
    await sleep(350);
  }
  return { regions, towns, foreign };
}

/* ---------- сховище рейсів ---------- */
let trips = [];
export const getTrips = () => trips;
export async function loadTrips() {
  const t = await db.get('kv', 'trips');
  trips = Array.isArray(t) ? t : [];
  return trips;
}
const persist = () => db.set('kv', 'trips', trips);
export function saveTrip(trip) {
  const i = trips.findIndex(t => t.id === trip.id);
  if (i >= 0) trips[i] = trip; else trips.push(trip);
  persist(); bus.emit('trips');
}
export function deleteTrip(id) { trips = trips.filter(t => t.id !== id); persist(); bus.emit('trips'); }
export function newTrip(a, v, b) {   // costing: 'truck' — фура, 'auto' — легковик (вибір на екрані маршруту)
  const tr = { id: uid(), created: Date.now(), a, v: null, vs: [], b, route: null, regions: [], towns: [], cams: [], stops: [], tiles: 0 };
  setVias(tr, Array.isArray(v) ? v : v ? [v] : []);
  return tr;
}
/* ---------- (1.1.32) контрольні точки: їх може бути кілька ----------
   trip.vs — усі контрольні точки по порядку; trip.v — перша з них (для старих збережених рейсів і для місць, де видно лише одну). */
export const VIA_MAX = 5;
export const viasOf = t => !t ? [] : Array.isArray(t.vs) ? t.vs.filter(Boolean) : t.v ? [t.v] : [];
export function setVias(t, list) { t.vs = (list || []).filter(Boolean).slice(0, VIA_MAX); t.v = t.vs[0] || null; return t.vs; }
// Куди вставити нову точку, щоб шлях вийшов найкоротшим (по прямій): між сусідами, де вона дає найменший гак.
// from — звідки шлях (старт чи поточне місце), min — раніше якого місця не вставляти (уже пройдені точки).
export function viaSlot(from, list, to, p, min = 0) {
  const seq = [from, ...list, to]; let best = min, bestAdd = Infinity;
  for (let i = min; i <= list.length; i++) {
    const a = seq[i], b = seq[i + 1]; if (!b) continue;
    const add = (a ? hav(a, p) : 0) + hav(p, b) - (a ? hav(a, b) : 0);
    if (add < bestAdd - 1) { bestAdd = add; best = i; }
  }
  return best;
}
export const tripTitle = t => (t.a.label || '?') + ' → ' + viasOf(t).map(v => v.label + ' → ').join('') + (t.b.label || '?');

// Сервер не знайшов проїзду для фури: 442 — шляху немає, 170 — точки в не з'єднаних частинах дороги, 171 — біля точки немає дороги для фури.
// Найчастіше точка «прилипла» до двору, заправки, стоянки чи центру міста із забороною або обмеженням мосту для фур.
export const NO_PATH = new Set([170, 171, 442]);
async function truckRoute(pts, heading, alternates, soft = 0) {
  let first;
  try { return await requestRoute(pts, heading, 'truck', alternates, null, soft); } catch (e) { if (!NO_PATH.has(e.code)) throw e; first = e; }
  for (const snap of ['unclassified', 'tertiary']) {
    await sleep(1100);                                   // публічний сервер — не частіше запиту на секунду
    try { const r = await requestRoute(pts, heading, 'truck', alternates, snap, soft, false); r.snapped = snap; log('info', 'рейс для фури знайдено, точки — на дорогах від «' + snap + '»'); return r; }
    catch (e) { if (!NO_PATH.has(e.code)) throw e; }
  }
  throw first;
}
// Будує маршрут рейсу. from — поточна позиція; skipA/skipVia — точки, які вже пройдено (skipVia — скільки контрольних точок: true — усі).
// altsFrom — просити запасні варіанти й тоді, коли маршрут будується від поточного місця (1.1.28: «новий маршрут» у дорозі — на вибір)
export async function buildRoute(trip, { from = null, heading = null, skipA = false, skipVia = false, through = null, alternates = 0, altsFrom = false } = {}) {
  const nAlt = from && !altsFrom ? 0 : alternates;
  const pts = [from || trip.a];
  if (through && through.length) pts.push(...through);              // повернення на вибраний маршрут: точки вздовж нього (проміжна — серед них)
  const vAll = viasOf(trip), nSkip = skipVia === true ? vAll.length : Math.max(0, Math.min(vAll.length, +skipVia || 0)), vLeft = vAll.slice(nSkip);
  if (!(through && through.length)) {
    if (from && !skipA) pts.push(trip.a);
    pts.push(...vLeft);
  }
  pts.push(trip.b);
  const costing = trip.costing || 'truck';
  // Знак «фурам заборонено»: водій уже вибрав варіант через таку дорогу (trip.soft) або дозволив їх у налаштуваннях («Їхати»)
  const soft0 = costing !== 'truck' ? 0 : trip.soft ? HGV_SOFT.ask : S.hgvBan === 'go' ? HGV_SOFT.go : 0;
  let r;
  if (costing === 'truck') {
    try { r = await truckRoute(pts, heading, nAlt, soft0); r.costing = 'truck'; if (soft0) r.soft = trip.soft ? (trip.soft === 'only' ? 'only' : 'chosen') : 'go'; }
    catch (e) {
      if (!NO_PATH.has(e.code)) throw e;
      // 1.1.12: суворого шляху для фури немає — спершу пробуємо дорогами зі знаком «фурам заборонено» (висота, маса, довжина — дотримані).
      // Це краще за звичайний маршрут для легковика, який не знає про фуру нічого.
      if (!soft0) {
        await sleep(1100);
        try { r = await requestRoute(pts, heading, 'truck', nAlt, null, HGV_SOFT.ask, false); r.costing = 'truck'; r.soft = 'only'; trip.soft = 'only'; log('warn', 'для фури шлях є лише дорогою зі знаком «фурам заборонено» — показую його з попередженням'); }
        catch (e2) { if (!NO_PATH.has(e2.code)) throw e2; }
      }
      if (!r) {
        // для фури проїзду немає навіть так — даємо звичайний маршрут із червоним попередженням, водій вирішує сам;
        // у дорозі (уже з GPS) наступна перебудова знову спробує для фури
        log('warn', 'для фури шляху немає (' + e.code + '), показую без обмежень для фур');
        await sleep(1100);
        r = await requestRoute(pts, heading, 'auto', nAlt); r.costing = 'auto'; r.truckFail = e.code;
      }
    }
  } else { r = await requestRoute(pts, heading, costing, nAlt); r.costing = costing; }
  const dress = a => { a.costing = r.costing; a.aD = null; a.viaD = null; a.viaDs = []; a.viaBase = 0; a.detour = 1; if (r.soft) a.soft = r.soft; if (r.truckFail) a.truckFail = r.truckFail; if (r.snapped) a.snapped = r.snapped; };
  for (const a of r.alts) dress(a);
  // (1.1.39) «Ворота»: сервер у місто заходить об'їзною й дворами, а головною вулицею — ні (здорожчує забудову й перехрестя).
  // Коли рейс планують (А → Б, просять варіанти), додаємо варіанти «проїдь головною дорогою» біля фінішу й старту і самі
  // вибираємо перший за класом доріг. У дорозі (перебудова від поточного місця) цього не робимо — там потрібна швидкість.
  let gated = null;
  if (nAlt > 0 && pts.length === 2 && !r.truckFail) {
    const cs = r.costing, softG = r.soft ? HGV_SOFT.ask : soft0, snapG = r.snapped || null, base = [r, ...r.alts];
    try {
      const g = await withGates(pts[0], pts[1], base, G => requestRoute([pts[0], G, pts[1]], heading, cs, 0, snapG, softG), { pause: () => sleep(1100) });
      if (g.list && g.list.length) { gated = g.list.slice(0, 3); for (const x of gated) { if (!base.includes(x)) dress(x); x.alts = []; } r = gated[0]; r.alts = gated.slice(1); r.gateInfo = g.info; }
      else log('info', 'ворота: ' + g.info);
    } catch (e) { log('warn', 'ворота: ' + (e && e.message || e)); }
  }
  // (1.1.31) першим — варіант, що насправді швидший (місцеві дороги сервер рахує заоптимістично), а не той, що «швидший» за типовими швидкостями
  if (!gated && r.alts.length) { const list = rankRoutes([r, ...r.alts]); r.alts = []; r = list[0]; r.alts = list.slice(1); }
  // Маршрут для фури набагато довший за пряму: швидше за все, мости чи дороги з обмеженням маси.
  // Рахуємо й варіант без обмежень для фур, щоб водій вирішив сам.
  const straight = hav(pts[0], pts[pts.length - 1]);
  r.detour = straight > 30000 ? r.dist / (straight * 1.3) : 1;
  if (r.costing === 'truck' && !from && r.detour > 1.4) {
    try { const alt = await requestRoute(pts, heading, 'auto'); if (alt.dist < r.dist * 0.75) { alt.costing = 'auto'; r.alt = alt; } }
    catch (e) { log('warn', 'запасний маршрут: ' + e.message); }
  }
  const idx = new RouteIndex(r.coords);
  const at = p => { const loc = idx.locate(p, null); return loc && loc.off < 400 ? loc.d : null; };
  r.aD = from && !skipA ? at(trip.a) : null;            // де на маршруті точка А і проміжна
  r.viaBase = nSkip; r.viaDs = vLeft.map(at);           // де на маршруті кожна ще не пройдена контрольна точка (null — не на лінії)
  r.viaD = r.viaDs.find(d => d != null) ?? null;
  return r;
}
/** Варіант «дорогою зі знаком "фурам заборонено"» до вже побудованого рейсу для фури.
 *  Повертає маршрут, лише якщо він помітно коротший (об'їзд справді великий); інакше null — це той самий рейс. */
export async function softVariant(trip, strict) {
  if ((trip.costing || 'truck') !== 'truck' || !strict || strict.costing !== 'truck' || strict.soft || (S.hgvBan || 'ask') !== 'ask') return null;
  const vs = viasOf(trip), pts = [trip.a, ...vs, trip.b];
  const r = await requestRoute(pts, null, 'truck', 0, strict.snapped || null, HGV_SOFT.ask);
  const km = (strict.dist - r.dist) / 1000, min = (strict.time - r.time) / 60;
  if (!((km >= 3 && r.dist <= strict.dist * 0.9) || min >= 8)) return null;
  const idx = new RouteIndex(r.coords), at = p => { const l = idx.locate(p, null); return l && l.off < 400 ? l.d : null; };
  r.costing = 'truck'; r.soft = 'alt'; r.alts = []; r.aD = null; r.viaBase = 0; r.viaDs = vs.map(at); r.viaD = r.viaDs.find(d => d != null) ?? null; r.detour = 1;
  r.saves = { km: Math.max(0, Math.round(km)), min: Math.max(0, Math.round(min)) };
  if (strict.snapped) r.snapped = strict.snapped;
  return r;
}
export const distToStart = (trip, p) => hav(p, trip.a);
