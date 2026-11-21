// Імітація руху для перевірки без виїзду: їде маршрутом, уміє «втратити» GPS і «підмінити» його.
import { bus } from './core.js';
import { pos, setSim } from './nav.js';
import { g } from './guide.js';

export const sim = { on: false, kmh: 70, lost: false, spoof: false, d: 0 };
let timer = null, last = 0;

function step() {
  if (!g.idx) { stop(); return; }
  const now = Date.now(), dt = Math.min(3, (now - last) / 1000); last = now;
  let v = sim.kmh / 3.6;
  if (g.next && g.distNext < 90) v = Math.min(v, 9);           // перед поворотом пригальмовуємо
  else if (g.next && g.distNext < 700) v = Math.min(v, 40);     // на підході — не швидше 145 км/год, щоб прозвучали підказки
  sim.d = Math.min(g.idx.total, sim.d + v * dt);
  const p = g.idx.at(sim.d);
  bus.emit('sens', { var: 0.6, hdg: p.brg });
  if (sim.lost) return;
  if (sim.spoof) { bus.emit('gps', { lat: -12.0219, lon: -77.1143, acc: 6, spd: 0, brg: 0, t: now, prov: 'gps', sim: true, spoofSim: true }); return; }   // «Ліма»
  bus.emit('gps', { lat: p.lat, lon: p.lon, acc: 5, spd: v, brg: p.brg, t: now, prov: 'gps', sim: true });
  if (sim.d >= g.idx.total) stop();
}
export function start() {
  if (!g.idx || sim.on) return false;
  sim.on = true; sim.lost = false; sim.spoof = false; sim.d = pos.onRoute && pos.rd != null ? pos.rd : 0;
  setSim(true); last = Date.now();
  timer = setInterval(step, 1000); step();
  bus.emit('sim', sim); return true;
}
export function stop() {
  if (!sim.on) return;
  sim.on = false; clearInterval(timer); timer = null; setSim(false);
  bus.emit('sim', sim);
}
export function setLost(v) { sim.lost = v; if (v) sim.spoof = false; bus.emit('sim', sim); }
export function setSpoof(v) { sim.spoof = v; if (v) sim.lost = false; bus.emit('sim', sim); }
export function setSpeed(k) { sim.kmh = k; bus.emit('sim', sim); }
