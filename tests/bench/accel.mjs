// (1.1.37) Окремо оцінювач швидкості з акселерометра (web/js/accel.js): наскільки вона сходиться зі справжньою через 10…80 с
// після зупинки — без ведення по рейсу. Фізика датчиків — та сама, що у стенді (accSim у drbench.mjs).
//   node tests/bench/accel.mjs [сценарій] [сид] [хвилин прогріву з GPS містом] [-v]
//   напр.: node tests/bench/accel.mjs mix 7 16     — після 16 хв їзди містом із GPS (вісь руху й зсув нуля вивчено)
//          node tests/bench/accel.mjs mix 7 0      — «свіжий» телефон: нічого не вивчено
const { accSim, truth, ROADS, SCEN } = await import('./drbench.mjs');
const { AccelSpeed } = await import('../../web/js/accel.js');
const name = process.argv[2] || 'city', seed = +process.argv[3] || 7, warm = +process.argv[4] || 0, verbose = process.argv.includes('-v');
const fr = x => x - Math.floor(x), drv = sd => ({ zoneK: 0.92 + 0.14 * fr(sd * 0.618), aLat: 1.2 + 0.5 * fr(sd * 0.414), acc: 0.35 + 0.15 * fr(sd * 0.732) });
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2], ang = (p, q) => Math.acos(Math.min(1, dot(p, q) / Math.hypot(...p) / Math.hypot(...q))) * 180 / Math.PI;
const E = new AccelSpeed();
const drive = (road, o, leg, gpsOn, errs) => {
  const tr = truth(road, seed + leg, o), AS = accSim(tr, seed, { ...o, leg });
  for (let q = 0; q < 6; q++) E.step({ a: AS[0].a, w: AS[0].w, quiet: true }, gpsOn ? { v: 0 } : null);
  tr.out.forEach((s, k) => {
    const r = E.step({ a: AS[k].a, w: AS[k].w, quiet: s.v <= 0.3 }, gpsOn ? { v: s.v + (Math.random() - 0.5) * 0.3 } : null);
    if (errs && r && r.age > 0) for (const T of Object.keys(errs)) if (Math.round(r.age) === +T) errs[T].push({ e: r.v - s.v, sig: r.sig });
    if (errs && verbose && k % 5 === 0) console.log(String(s.t).padStart(5), 'v', s.v.toFixed(1).padStart(5), 'acc', r ? r.v.toFixed(1).padStart(5) + ' ±' + r.sig.toFixed(1) + ' age ' + r.age : '    -', (E.fL || E.axis()) ? 'вісь ' + ang(E.axis() || E.fL, AS[k].f).toFixed(1) + '°' : '');
  });
};
for (let leg = 1; leg <= Math.ceil(warm / 8); leg++) drive(ROADS.city(), drv(seed + leg), leg, true, null);       // прогрів: місто з GPS (~8 хв коло)
const o = { ...drv(seed), ...(SCEN[name] || {}) }, errs = { 10: [], 20: [], 30: [], 45: [], 60: [], 80: [] };
drive(ROADS[o.road || name.split(':')[0]](), o, 0, false, errs);
console.log(`${name}#${seed}, прогрів ${warm} хв:`, JSON.stringify(E.stats()), 'зсув нуля знайдено', JSON.stringify(E.cal.b || null));
for (const T of Object.keys(errs)) { const a = errs[T]; if (!a.length) continue; const m = a.reduce((x, y) => x + y.e, 0) / a.length, rms = Math.sqrt(a.reduce((x, y) => x + y.e * y.e, 0) / a.length), sg = a.reduce((x, y) => x + y.sig, 0) / a.length; console.log(`  через ${String(T).padStart(2)} с після зупинки: зсув ${m.toFixed(2).padStart(6)}, розкид ${rms.toFixed(2)} м/с (оцінка каже ±${sg.toFixed(2)}), рушань ${a.length}`); }
