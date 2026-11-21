// Запуск застосунку.
import { bus, log, S, VERSION } from './core.js';
import * as P from './platform.js';
import * as nav from './nav.js';
import * as guide from './guide.js';
import * as poi from './poi.js';
import * as feed from './feed.js';
import * as track from './track.js';
import * as sim from './sim.js';
import * as weather from './weather.js';
import * as mapM from './map.js';
import * as route from './route.js';
import { initUI } from './ui.js';
import { initLab } from './ui_lab.js';

async function boot() {
  log('info', `Рейс ${VERSION.name}, web ${VERSION.web}, ${P.isNative ? 'застосунок' : 'браузер'}`);
  document.documentElement.lang = S.lang;
  try { mapM.initMap(); } catch (e) { log('err', 'карта не запустилась: ' + (e && e.message)); }
  nav.start(); guide.init(); poi.init(); track.init(); weather.init();
  initUI(); initLab();
  await route.loadTrips();
  await feed.init();
  P.nativeReady(); P.startLocation(); P.keepAwake(S.keepAwake !== false);
  const b = document.getElementById('boot');
  setTimeout(() => b.classList.add('gone'), 500); setTimeout(() => b.remove(), 1200);
  if ('serviceWorker' in navigator && !P.isNative && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.__app = { bus, S, P, nav, guide, poi, feed, track, sim, map: mapM, route, weather };   // для діагностики й автотестів
boot().catch(e => log('err', 'запуск: ' + (e && e.stack || e)));
