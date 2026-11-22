// Рейси: пошук адрес, маршрут для фури (Valhalla), регіони на шляху, збереження.
import { bus, log, S, db, hav, decodePolyline6, RouteIndex, uid, sleep } from './core.js';
import { getJson, http } from './platform.js';

const PHOTON = 'https://photon.komoot.io';
const UA_BBOX = '22.0,44.0,40.5,52.7';

/* ---------- пошук місця ---------- */
export async function geocode(q, near) {
  q = q.trim(); if (!q) return [];
  const m = q.match(/^\s*(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)\s*$/);     // «49.99, 36.23»
  if (m) { const lat = +m[1].replace(',', '.'), lon = +m[2].replace(',', '.'); return [{ lat, lon, label: lat.toFixed(5) + ', ' + lon.toFixed(5), sub: '' }]; }
  let url = PHOTON + '/api/?q=' + encodeURIComponent(q) + '&limit=20&bbox=' + UA_BBOX;
  if (near) url += '&lat=' + near.lat.toFixed(4) + '&lon=' + near.lon.toFixed(4);
  const j = await getJson(url, { timeout: 12000 });
  const nq = normName(q);
  const out = (j.features || []).map((f, i) => {
    const p = f.properties || {}, c = f.geometry.coordinates;
    const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || '';
    const sub = [p.street && p.name ? [p.street, p.housenumber].filter(Boolean).join(' ') : '', p.city !== name ? p.city : '', p.county, p.state].filter(Boolean).join(', ');
    // лише Україна: у прямокутник пошуку потрапляють і шматки Росії та Білорусі
    const ua = p.countrycode ? p.countrycode === 'UA' : /укра|ukrain|украин/i.test(p.country || '');
    // великі міста — вище за однойменні села поблизу («Львов» = Львів, а не село під Бєлгородом)
    const kind = p.osm_key === 'place' ? ({ city: 50, town: 38, village: 22, suburb: 16, hamlet: 10 }[p.osm_value] || 12) : 6;
    const nn = normName(name), exact = nn === nq ? 30 : nn.startsWith(nq) ? 10 : 0;
    const close = near && Math.hypot((c[1] - near.lat) * 111, (c[0] - near.lon) * 71) < 40 ? 6 : 0;
    return { lat: c[1], lon: c[0], label: name, sub, ua, score: kind + exact + close + (20 - i) * 0.5 };
  }).filter(x => x.label && x.ua);
  return out.sort((a, b) => b.score - a.score).slice(0, 7).map(({ lat, lon, label, sub }) => ({ lat, lon, label, sub }));
}
// Порівняння назв без різниці між українським і російським написанням (Львів/Львов, Київ/Киев).
export function normName(s) {
  return String(s || '').toLowerCase().replace(/[ʼ'’`\-ьъ]/g, '')
    .replace(/їв(?=\s|$)/g, 'ев').replace(/ів(?=\s|$)/g, 'ов')
    .replace(/[іїиый]/g, 'и').replace(/[еєэё]/g, 'е').replace(/ґ/g, 'г')
    .replace(/(.)\1+/g, '$1').replace(/\s+/g, ' ').trim();
}

export async function reverse(lat, lon) {
  const j = await getJson(PHOTON + '/reverse?lat=' + lat.toFixed(5) + '&lon=' + lon.toFixed(5), { timeout: 10000 });
  const p = j.features && j.features[0] && j.features[0].properties;
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
  const j = await getJson(url, { timeout: 12000 });
  return (j.features || []).map(f => ({ name: (f.properties || {}).name || '', state: (f.properties || {}).state || '', lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] })).filter(x => x.name);
}
export const townName = x => typeof x === 'string' ? x : (x && x.name) || '';
export const oblastOf = s => { if (!s) return null; const o = OBLASTS.find(o => o.re.test(s)); return o ? o.id : null; };
export const oblastName = id => { const o = OBLASTS.find(o => o.id === id); return o ? (S.lang === 'ru' ? o.ru : o.uk) : id; };

/* ---------- маршрут ---------- */
export function truckOptions() {
  const t = S.truck, o = { height: +t.height, width: +t.width, length: +t.length, weight: +t.weight, axle_load: +t.axle, hazmat: !!t.hazmat };
  if (+t.vmax > 0) o.top_speed = Math.round(+t.vmax);      // обмежувач: час у дорозі рахується для фури, а не для легковика
  return o;
}
// pts: [{lat,lon,type}], перший і останній — зупинки, проміжні — «through» (маршрут проходить крізь точку)
export async function requestRoute(pts, heading, costing = 'truck') {
  const locations = pts.map((p, i) => {
    const l = { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), type: (i === 0 || i === pts.length - 1) ? 'break' : 'through' };
    if (i === 0 && heading != null) { l.heading = Math.round(heading); l.heading_tolerance = 60; }
    return l;
  });
  const body = {
    locations, costing, costing_options: costing === 'truck' ? { truck: truckOptions() } : {},
    units: 'kilometers', language: S.lang === 'ru' ? 'ru-RU' : 'uk-UA', directions_type: 'instructions'
  };
  // GET із параметром json — «простий» запит, сервер відповідає сторінкам без попередньої перевірки CORS.
  const r = await http(S.routeUrl.replace(/\/+$/, '') + '/route?json=' + encodeURIComponent(JSON.stringify(body)), { timeout: 45000 });
  let j; try { j = JSON.parse(r.text); } catch (_) { throw new Error('HTTP ' + r.status); }
  if (r.status !== 200 || !j.trip) { const e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.error_code; throw e; }
  return parseTrip(j.trip);
}
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
export function newTrip(a, v, b) {
  return { id: uid(), created: Date.now(), a, v: v || null, b, route: null, regions: [], towns: [], cams: [], stops: [], tiles: 0 };
}
export const tripTitle = t => (t.a.label || '?') + ' → ' + (t.v ? t.v.label + ' → ' : '') + (t.b.label || '?');

// Будує маршрут рейсу. from — поточна позиція; skipA/skipVia — точки, які вже пройдено.
export async function buildRoute(trip, { from = null, heading = null, skipA = false, skipVia = false } = {}) {
  const pts = [from || trip.a];
  if (from && !skipA) pts.push(trip.a);
  if (trip.v && !skipVia) pts.push(trip.v);
  pts.push(trip.b);
  const costing = trip.costing || 'truck';
  const r = await requestRoute(pts, heading, costing);
  r.costing = costing;
  // Маршрут для фури набагато довший за пряму: швидше за все, мости чи дороги з обмеженням маси.
  // Рахуємо й варіант без обмежень для фур, щоб водій вирішив сам.
  const straight = hav(pts[0], pts[pts.length - 1]);
  r.detour = straight > 30000 ? r.dist / (straight * 1.3) : 1;
  if (costing === 'truck' && !from && r.detour > 1.4) {
    try { const alt = await requestRoute(pts, heading, 'auto'); if (alt.dist < r.dist * 0.75) { alt.costing = 'auto'; r.alt = alt; } }
    catch (e) { log('warn', 'запасний маршрут: ' + e.message); }
  }
  const idx = new RouteIndex(r.coords);
  const at = p => { const loc = idx.locate(p, null); return loc && loc.off < 400 ? loc.d : null; };
  r.aD = from && !skipA ? at(trip.a) : null;            // де на маршруті точка А і проміжна
  r.viaD = trip.v && !skipVia ? at(trip.v) : null;
  return r;
}
export const distToStart = (trip, p) => hav(p, trip.a);
