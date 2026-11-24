// Запуск застосунку.
import { bus, log, S, VERSION } from './core.js';
import * as core from './core.js';
import * as P from './platform.js';
import * as nav from './nav.js';
import * as guide from './guide.js';
import * as poi from './poi.js';
import * as feed from './feed.js';
import * as track from './track.js';
import * as sim from './sim.js';
import * as weather from './weather.js';
import * as roads from './roads.js';
import * as rough from './rough.js';
import * as showers from './showers.js';
import * as offline from './offline.js';
import * as addr from './addr.js';
import * as stopsdb from './stopsdb.js';
import * as mapM from './map.js';
import * as route from './route.js';
import * as vplaces from './vplaces.js';
import * as reports from './reports.js';
import * as limits from './limits.js';
import { initUI, ptsState } from './ui.js';
import { initLab } from './ui_lab.js';
import * as lab from './lab.js';
import { resumeTrip } from './ui.js';
import * as sfx from './sfx.js';
import * as sensors from './sensors.js';
import * as calib from './calib.js';
import * as uiCalib from './ui_calib.js';

async function boot() {
  log('info', `Рейс ${VERSION.name}, web ${VERSION.web}, ${P.isNative ? 'застосунок' : 'браузер'}`);
  document.documentElement.lang = S.lang;
  offline.init(); addr.init();
  await offline.whenChecked(1500);        // файл офлайн-карти перевірено — карта одразу стартує з правильним джерелом
  try { mapM.initMap(); } catch (e) { log('err', 'карта не запустилась: ' + (e && e.message)); }
  bus.on('offlineReady', () => { if (mapM.map) mapM.applyMapSource(); });
  bus.on('offlineBad', () => { if (mapM.map) mapM.applyMapSource(); });
  nav.start(); guide.init(); poi.init(); track.init(); weather.init(); roads.init(); rough.init();
  initUI(); initLab(); lab.initLabApp();
  await route.loadTrips();
  await feed.init();
  stopsdb.load(); vplaces.init(); reports.init(); limits.init();
  P.nativeReady(); P.startLocation(); P.keepAwake(S.keepAwake !== false);
  resumeTrip();
  const b = document.getElementById('boot');
  setTimeout(() => b.classList.add('gone'), 500); setTimeout(() => b.remove(), 1200);
  if ('serviceWorker' in navigator && !P.isNative && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.__app = { bus, S, P, core, roads, rough, showers, nav, guide, poi, feed, track, sim, map: mapM, route, weather, offline, addr, stopsdb, vplaces, reports, limits, sfx, sensors, calib, uiCalib, lab, ui: { ptsState } };   // для діагностики й автотестів
boot().catch(e => log('err', 'запуск: ' + (e && e.stack || e)));
