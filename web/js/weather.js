// Погода на маршруті на той час, коли фура туди доїде (Open-Meteo, без ключа):
// ожеледиця, сніг, туман, сильний вітер, гроза. Події йдуть у стрічку й на карту.
import { bus, log, S, clamp, RouteIndex } from './core.js';
import * as places from './places.js';
import { getJson, online } from './platform.js';
import { pos } from './nav.js';
import { g } from './guide.js';
import { feed } from './feed.js';
import { townName } from './route.js';
import { t } from './i18n.js';

export const wx = { at: 0, err: '', points: 0 };

// Спека: понад +28 °C фурам з фактичною масою понад 24 т або навантаженням на вісь понад 7 т
// рух дорогами державного значення вдень обмежено (сезонне обмеження Агентства відновлення; у Києві — на всіх в'їздах).
// Не діє для швидкопсувних і небезпечних вантажів, живих тварин, військових перевезень і ліквідації НС.
export const HEAT_T = 28;
export const heatApplies = () => { const tr = S.truck || {}; return ((tr.weight || 40) > 24 || (tr.axle || 11.5) > 7) && !S.heatExempt; };

// Прогноз температури вздовж усього маршруту на час проїзду (для планування рейсу до «Поїхали»).
export async function heatAlong(route, startMs = Date.now()) {
  if (!S.weather || !online() || !route || !route.coords) return null;
  const idx = new RouteIndex(route.coords), spd = route.time > 0 ? route.dist / route.time : 18;
  const n = clamp(Math.ceil(idx.total / 40000), 1, 16), pts = [];
  for (let i = 0; i <= n; i++) { const d = idx.total * i / n, p = idx.at(d); pts.push({ lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3), d, eta: d / spd }); }
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + pts.map(p => p.lat).join(',') + '&longitude=' + pts.map(p => p.lon).join(',') +
    '&hourly=temperature_2m&forecast_days=3&timeformat=unixtime&timezone=GMT';
  try {
    let j = await getJson(url, { timeout: 20000 });
    if (!Array.isArray(j)) j = [j];
    let first = null, maxT = -99;
    pts.forEach((p, i) => {
      const hr = j[i] && j[i].hourly; if (!hr || !hr.time || !hr.temperature_2m) return;
      const when = startMs / 1000 + p.eta;
      let k = 0; for (let m = 0; m < hr.time.length; m++) if (Math.abs(hr.time[m] - when) < Math.abs(hr.time[k] - when)) k = m;
      const tmp = hr.temperature_2m[k]; if (tmp == null) return;
      if (tmp > maxT) maxT = tmp;
      if (tmp > HEAT_T && !first) first = { d: p.d, when: when * 1000, temp: tmp, town: places.nearest(p.lat, p.lon) };
    });
    return { maxT, first, at: Date.now() };
  } catch (e) { log('warn', 'спека на маршруті: ' + e.message); return null; }
}
let busy = false, lastRouteKey = '';

// Що загрожує фурі за прогнозом на годину: [рівень, код умови, текст] або null.
function judge(h) {
  const c = h.code, tmp = h.temp, snow = h.snow || 0, pr = h.prec || 0, gust = h.gust || 0, vis = h.vis;
  if (c === 66 || c === 67) return ['red', 'frz', t('wxFreezingRain')];
  if (c === 56 || c === 57) return ['yellow', 'ice', t('wxFreezingDrizzle')];
  if (snow >= 2.5 || c === 75 || c === 86) return ['red', 'snow', t('wxHeavySnow', snow.toFixed(1))];
  if (snow >= 0.7 || c === 73 || c === 85) return ['yellow', 'snow', t('wxSnow', snow.toFixed(1))];
  if (tmp != null && tmp <= 1 && tmp >= -4 && pr >= 0.2) return ['yellow', 'ice', t('wxIce')];
  if (gust >= 90) return ['red', 'wind', t('wxWind', Math.round(gust))];
  if (gust >= 70) return ['yellow', 'wind', t('wxWind', Math.round(gust))];
  if ((vis != null && vis < 300) || c === 45 || c === 48) return ['yellow', 'fog', t('wxFog', vis != null ? Math.round(vis) : 200)];
  if (c >= 95) return ['yellow', 'storm', t('wxStorm')];
  return null;
}

function nearestTown(p) {
  let best = null, bd = 30000;
  for (const x of feed.towns) {
    if (typeof x !== 'object' || x.lat == null) continue;
    const d = Math.hypot((x.lat - p.lat) * 111000, (x.lon - p.lon) * 71000);
    if (d < bd) { bd = d; best = x; }
  }
  return best ? townName(best) : '';
}

export async function checkWeather(force) {
  if (busy || !S.weather || !g.active || !g.idx || !online()) return;
  const key = g.idx.total.toFixed(0) + ':' + Math.floor(Date.now() / 3600e3);
  if (!force && key === lastRouteKey) return;              // той самий маршрут у ту саму годину — уже перевіряли
  busy = true; lastRouteKey = key;
  try {
    const rd = pos.rd || 0, rem = g.idx.total - rd;
    const spd = g.remTime > 0 ? g.remain / g.remTime : 18;    // м/с
    const horizon = Math.min(rem, spd * 14 * 3600);           // прогноз — на найближчі 14 годин руху
    const step = clamp(horizon / 20, 25000, 60000);
    const pts = [];
    for (let d = rd + 5000; d <= rd + horizon && pts.length < 24; d += step) { const p = g.idx.at(d); pts.push({ lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3), eta: (d - rd) / spd }); }
    if (!pts.length) { busy = false; return; }
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + pts.map(p => p.lat).join(',') + '&longitude=' + pts.map(p => p.lon).join(',') +
      '&hourly=temperature_2m,precipitation,snowfall,weather_code,wind_gusts_10m,visibility&forecast_days=2&timeformat=unixtime&timezone=GMT';
    let j = await getJson(url, { timeout: 20000 });
    if (!Array.isArray(j)) j = [j];
    const seen = new Set();
    pts.forEach((p, i) => {
      const hr = j[i] && j[i].hourly; if (!hr || !hr.time) return;
      const when = Date.now() / 1000 + p.eta;
      let k = 0; for (let n = 0; n < hr.time.length; n++) if (Math.abs(hr.time[n] - when) < Math.abs(hr.time[k] - when)) k = n;
      const tmpK = hr.temperature_2m[k];
      if (tmpK != null && tmpK > HEAT_T && heatApplies() && !seen.has('heat')) {     // спекотне обмеження для важких фур
        seen.add('heat');
        const town = nearestTown(p) || places.nearest(p.lat, p.lon);
        bus.emit('feedPush', {
          src: 'wx', level: 'yellow', text: t('wxEvent', town ? t('wxAt', town) : t('wxRoute'), '', t('wxHeat'), Math.round(tmpK)),
          lat: p.lat, lon: p.lon, locName: town, locKind: 'wx', key: 'wx:heat:' + p.lat.toFixed(1) + ':' + p.lon.toFixed(1) + ':' + Math.floor(when / 10800), quiet: true
        });
      }
      const res = judge({ code: hr.weather_code[k], temp: hr.temperature_2m[k], snow: hr.snowfall[k], prec: hr.precipitation[k], gust: hr.wind_gusts_10m[k], vis: hr.visibility ? hr.visibility[k] : null });
      if (!res) return;
      const [level, cond, what] = res;
      if (seen.has(cond)) return;                             // одна подія на тип умов — найближча попереду
      seen.add(cond);
      const town = nearestTown(p), temp = hr.temperature_2m[k];
      const text = t('wxEvent', town ? t('wxAt', town) : t('wxRoute'), '', what, temp != null ? Math.round(temp) : '?');   // «через N км» підставляє шторка — живе, а не на момент прогнозу
      bus.emit('feedPush', {
        src: 'wx', level, text, lat: p.lat, lon: p.lon, locName: town, locKind: 'wx',
        key: 'wx:' + cond + ':' + p.lat.toFixed(1) + ':' + p.lon.toFixed(1) + ':' + Math.floor(when / 10800),
        quiet: level !== 'red'
      });
    });
    wx.at = Date.now(); wx.err = ''; wx.points = pts.length;
  } catch (e) { wx.err = e.message; log('warn', 'погода: ' + e.message); lastRouteKey = ''; }
  busy = false;
}

export function init() {
  bus.on('route', () => setTimeout(() => checkWeather(true), 4000));
  setInterval(() => checkWeather(false), 10 * 60000);
}
