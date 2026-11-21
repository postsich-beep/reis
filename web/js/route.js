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
  let url = PHOTON + '/api/?q=' + encodeURIComponent(q) + '&limit=7&bbox=' + UA_BBOX;
  if (near) url += '&lat=' + near.lat.toFixed(4) + '&lon=' + near.lon.toFixed(4);
  const j = await getJson(url, { timeout: 12000 });
  return (j.features || []).map(f => {
    const p = f.properties || {}, c = f.geometry.coordinates;
    const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || '';
    const sub = [p.street && p.name ? [p.street, p.housenumber].filter(Boolean).join(' ') : '', p.city !== name ? p.city : '', p.county, p.state].filter(Boolean).join(', ');
    return { lat: c[1], lon: c[0], label: name, sub };
  }).filter(x => x.label);
}
export async function reverse(lat, lon) {
  const j = await getJson(PHOTON + '/reverse?lat=' + lat.toFixed(5) + '&lon=' + lon.toFixed(5), { timeout: 10000 });
  const p = j.features && j.features[0] && j.features[0].properties;
  return p ? { name: p.name || '', city: p.city || p.town || p.village || p.name || '', county: p.county || '', state: p.state || '' } : null;
}

/* ---------- області України ---------- */
export const OBLASTS = [
  ['vinnytsia', 'Вінницька', 'Винницкая', 'вінни|винниц|vinny'], ['volyn', 'Волинська', 'Волынская', 'волин|волын|volyn'],
  ['dnipro', 'Дніпропетровська', 'Днепропетровская', 'дніпроп|днепроп|dnipro'], ['donetsk', 'Донецька', 'Донецкая', 'донец|donet'],
  ['zhytomyr', 'Житомирська', 'Житомирская', 'житомир|zhytomyr'], ['zakarpattia', 'Закарпатська', 'Закарпатская', 'закарпат|zakarpat'],
  ['zaporizhzhia', 'Запорізька', 'Запорожская', 'запоріз|запорож|zapori'], ['ivano-frankivsk', 'Івано-Франківська', 'Ивано-Франковская', 'франків|франков|frankiv'],
  ['kyiv', 'Київська', 'Киевская', 'київ|киев|kyiv|kiev'], ['kirovohrad', 'Кіровоградська', 'Кировоградская', 'кіровоград|кировоград|kirovo'],
  ['luhansk', 'Луганська', 'Луганская', 'луган|luhan'], ['lviv', 'Львівська', 'Львовская', 'львів|львов|lviv'],
  ['mykolaiv', 'Миколаївська', 'Николаевская', 'миколаїв|николаев|mykola'], ['odesa', 'Одеська', 'Одесская', 'одес|odes'],
  ['poltava', 'Полтавська', 'Полтавская', 'полтав|poltav'], ['rivne', 'Рівненська', 'Ровенская', 'рівнен|ровен|rivne'],
  ['sumy', 'Сумська', 'Сумская', 'сумськ|сумск|sumy|sumsk'], ['ternopil', 'Тернопільська', 'Тернопольская', 'терноп|ternop'],
  ['kharkiv', 'Харківська', 'Харьковская', 'харків|харьков|khark'], ['kherson', 'Херсонська', 'Херсонская', 'херсон|kherson'],
  ['khmelnytskyi', 'Хмельницька', 'Хмельницкая', 'хмельн|khmel'], ['cherkasy', 'Черкаська', 'Черкасская', 'черкас|cherkas'],
  ['chernivtsi', 'Чернівецька', 'Черновицкая', 'чернівец|черновиц|chernivts'], ['chernihiv', 'Чернігівська', 'Черниговская', 'чернігів|чернигов|chernihiv'],
  ['crimea', 'АР Крим', 'АР Крым', 'крим|крым|crimea']
].map(([id, uk, ru, re]) => ({ id, uk, ru, re: new RegExp(re, 'i') }));
export const oblastOf = s => { if (!s) return null; const o = OBLASTS.find(o => o.re.test(s)); return o ? o.id : null; };
export const oblastName = id => { const o = OBLASTS.find(o => o.id === id); return o ? (S.lang === 'ru' ? o.ru : o.uk) : id; };

/* ---------- маршрут ---------- */
function truckOptions() {
  const t = S.truck;
  return { height: +t.height, width: +t.width, length: +t.length, weight: +t.weight, axle_load: +t.axle, hazmat: !!t.hazmat };
}
// pts: [{lat,lon,type}], перший і останній — зупинки, проміжні — «through» (маршрут проходить крізь точку)
export async function requestRoute(pts, heading) {
  const locations = pts.map((p, i) => {
    const l = { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), type: (i === 0 || i === pts.length - 1) ? 'break' : 'through' };
    if (i === 0 && heading != null) { l.heading = Math.round(heading); l.heading_tolerance = 60; }
    return l;
  });
  const body = {
    locations, costing: 'truck', costing_options: { truck: truckOptions() },
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
        street: (m.street_names || [])[0] || '', len: (m.length || 0) * 1000, time: m.time || 0,
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
  const regions = [], towns = [];
  const stepM = Math.max(15000, Math.min(30000, idx.total / 12)), n = Math.floor(idx.total / stepM);
  let last = null;
  for (let i = 0; i <= n; i++) {
    const d = Math.min(idx.total, i * stepM), p = idx.at(d);
    try {
      const r = await reverse(p.lat, p.lon);
      const id = r && oblastOf(r.state);
      if (r && r.city && !towns.includes(r.city)) towns.push(r.city);
      if (id && id !== last) { regions.push({ id, d }); last = id; }
    } catch (e) { log('warn', 'reverse: ' + e.message); }
    if (onStep) onStep(i, n);
    await sleep(350);
  }
  return { regions, towns };
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
  const r = await requestRoute(pts, heading);
  const idx = new RouteIndex(r.coords);
  const at = p => { const loc = idx.locate(p, null); return loc && loc.off < 400 ? loc.d : null; };
  r.aD = from && !skipA ? at(trip.a) : null;            // де на маршруті точка А і проміжна
  r.viaD = trip.v && !skipVia ? at(trip.v) : null;
  return r;
}
export const distToStart = (trip, p) => hav(p, trip.a);
