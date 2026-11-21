// Запис треку (REC) і стабілізація: після повернення GPS розрахункову ділянку замінюємо геометрією маршруту.
import { bus, S, db, hav, pad2 } from './core.js';
import { pos } from './nav.js';
import { g } from './guide.js';
import { saveText } from './platform.js';

export const track = { pts: [] };
let lossIdx = -1, lossRd = null, lossT = 0, dirty = false;

function onPos() {
  if (!S.rec || pos.lat == null || pos.sim) return;
  const last = track.pts[track.pts.length - 1], now = Date.now();
  if (last && hav(last, pos) < 6 && now - last.t < 20000) return;
  track.pts.push({ lat: +pos.lat.toFixed(6), lon: +pos.lon.toFixed(6), t: now, e: pos.mode === 'dr' ? 1 : 0 });
  if (track.pts.length > 60000) track.pts.splice(0, 5000);
  dirty = true;
}
export function init() {
  db.get('kv', 'track').then(p => { if (Array.isArray(p) && !track.pts.length) track.pts = p; bus.emit('track', track); });
  bus.on('pos', onPos);
  bus.on('gpsLost', () => { lossIdx = track.pts.length; lossRd = pos.onRoute ? pos.rd : null; lossT = Date.now(); });
  bus.on('gpsBack', () => {
    if (!S.rec || lossIdx < 0) return;
    // Був на маршруті до втрати і повернувся на нього далі — заповнюємо прогалину дорогою, а не прямою.
    if (g.idx && lossRd != null && pos.onRoute && pos.rd > lossRd + 30) {
      const seg = g.idx.slice(lossRd, pos.rd), now = Date.now();
      track.pts.splice(lossIdx);
      seg.forEach((c, i) => track.pts.push({ lat: +c[1].toFixed(6), lon: +c[0].toFixed(6), t: Math.round(lossT + (now - lossT) * (i / Math.max(1, seg.length - 1))), e: 2 }));
      dirty = true;
    }
    lossIdx = -1;
  });
  setInterval(() => { if (dirty) { dirty = false; db.set('kv', 'track', track.pts); } }, 30000);
}
export function clearTrack() { track.pts = []; db.set('kv', 'track', []); bus.emit('track', track); }
export function trackKm() { let d = 0; for (let i = 1; i < track.pts.length; i++) d += hav(track.pts[i - 1], track.pts[i]); return d / 1000; }
export function exportGpx() {
  if (!track.pts.length) return null;
  const d = new Date(track.pts[0].t), name = `reis-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.gpx`;
  const body = track.pts.map(p => `<trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.t).toISOString()}</time>${p.e ? '<fix>none</fix>' : ''}</trkpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Reis" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${name}</name><trkseg>\n${body}\n</trkseg></trk>\n</gpx>\n`;
  return saveText(name, 'application/gpx+xml', gpx) ? name : null;
}
