// Платформа: один інтерфейс поверх Android-оболонки (window.ReisNative) і звичайного браузера.
import { bus, log, S, uid } from './core.js';

const N = window.ReisNative || null;
export const isNative = !!N;

/* Події від оболонки приходять сюди: window.__reis(type, payload) */
const pendingHttp = new Map();
let ttsResolve = null, ttsId = null;
let sttHandler = null;
window.__reis = (type, d) => {
  try {
    if (type === 'loc') bus.emit('gps', d);
    else if (type === 'sens') bus.emit('sens', d);
    else if (type === 'gnss') bus.emit('gnss', d);
    else if (type === 'gnssq') bus.emit('gnssq', d);
    else if (type === 'http') {
      const p = pendingHttp.get(d.id); if (!p) return;
      pendingHttp.delete(d.id); clearTimeout(p.timer);
      if (d.error) p.rej(new Error(d.error)); else p.res({ status: d.status, text: d.body || '' });
    }
    else if (type === 'tts') { if (d.id === ttsId && ttsResolve) { const r = ttsResolve; ttsResolve = null; r(); } }
    else if (type === 'stt') { if (sttHandler) sttHandler(d); }
    else bus.emit('native:' + type, d);
  } catch (e) { log('err', 'native event ' + type + ': ' + e); }
};

/* ---------- геолокація ---------- */
let watchId = null;
export function startLocation() {
  if (N) { try { N.startTracking(); } catch (e) { log('err', 'startTracking ' + e); } return; }
  if (!navigator.geolocation || watchId != null) return;
  watchId = navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    bus.emit('gps', {
      lat: c.latitude, lon: c.longitude, acc: c.accuracy || 50,
      spd: c.speed == null || isNaN(c.speed) ? null : c.speed,
      brg: c.heading == null || isNaN(c.heading) ? null : c.heading,
      t: p.timestamp || Date.now(), prov: 'gps'
    });
  }, e => { log('warn', 'geolocation: ' + e.message); bus.emit('gpsError', e.code); },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  startBrowserSensors();
}
export function stopLocation() {
  if (N) { try { N.stopTracking(); } catch (_) {} return; }
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}

/* Датчики в браузері: компас і рівень вібрації (рух/стоянка). В оболонці це робить сервіс. */
let sensorsOn = false;
function startBrowserSensors() {
  if (sensorsOn) return; sensorsOn = true;
  let hdg = null; const win = [];
  const onOri = e => {
    if (e.webkitCompassHeading != null) hdg = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) hdg = (360 - e.alpha) % 360;
  };
  window.addEventListener('deviceorientationabsolute', onOri, true);
  window.addEventListener('deviceorientation', onOri, true);
  window.addEventListener('devicemotion', e => {
    const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
    win.push(Math.hypot(a.x, a.y, a.z)); if (win.length > 100) win.shift();
  });
  setInterval(() => {
    if (win.length < 20 && hdg == null) return;
    let v = null;
    if (win.length >= 20) { const m = win.reduce((s, x) => s + x, 0) / win.length; v = win.reduce((s, x) => s + (x - m) ** 2, 0) / win.length; }
    bus.emit('sens', { hdg, var: v, press: null });
  }, 1000);
}

/* ---------- голос: синтез ---------- */
const langTag = () => S.lang === 'ru' ? 'ru-RU' : 'uk-UA';
export function speak(text) {
  if (!text) return Promise.resolve();
  if (N) {
    return new Promise(res => {
      if (ttsResolve) { const r = ttsResolve; ttsResolve = null; r(); }
      ttsId = uid(); ttsResolve = res;
      try { N.speak(String(text), langTag(), S.ttsRate || 1, ttsId); } catch (e) { ttsResolve = null; res(); }
      setTimeout(() => { if (ttsResolve === res) { ttsResolve = null; res(); } }, 4000 + text.length * 120);
    });
  }
  return new Promise(res => {
    const ss = window.speechSynthesis; if (!ss) { res(); return; }
    try {
      ss.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = langTag(); u.rate = S.ttsRate || 1; u.onend = res; u.onerror = res;
      ss.speak(u);
      setTimeout(res, 4000 + text.length * 120);
    } catch (_) { res(); }
  });
}
export function stopSpeak() {
  if (N) { try { N.stopSpeak(); } catch (_) {} } else if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (ttsResolve) { const r = ttsResolve; ttsResolve = null; r(); }
}

/* ---------- голос: розпізнавання. Повертає текст або '' ---------- */
let browserRec = null;
export const canListen = () => !!N || !!(window.SpeechRecognition || window.webkitSpeechRecognition);
export function listen(onPartial) {
  return new Promise((res, rej) => {
    if (N) {
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; sttHandler = null; clearTimeout(guard); fn(v); };
      const guard = setTimeout(() => { try { N.stopListen(); } catch (_) {} finish(res, ''); }, 20000);
      sttHandler = d => {
        if (d.state === 'partial' && onPartial) onPartial(d.text || '');
        else if (d.state === 'final') finish(res, d.text || '');
        else if (d.state === 'error') (d.code === 'nomatch' || d.code === 'timeout') ? finish(res, '') : finish(rej, new Error(d.code || 'stt'));
      };
      try { N.listen(langTag()); } catch (e) { finish(rej, e); }
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { rej(new Error('nostt')); return; }
    const r = browserRec = new SR(); r.lang = langTag(); r.interimResults = !!onPartial; r.maxAlternatives = 1;
    let text = '';
    r.onresult = e => {
      let s = ''; for (const x of e.results) s += x[0].transcript;
      text = s; if (onPartial) onPartial(s);
    };
    r.onerror = e => { if (e.error === 'no-speech' || e.error === 'aborted') res(''); else rej(new Error(e.error)); };
    r.onend = () => res(text);
    try { r.start(); } catch (e) { rej(e); }
  });
}
export function stopListen() {
  if (N) { try { N.stopListen(); } catch (_) {} if (sttHandler) sttHandler({ state: 'final', text: '' }); }
  else if (browserRec) { try { browserRec.stop(); } catch (_) {} }
}

/* ---------- мережа ----------
   viaNative: запити до сайтів без CORS (Telegram, тривоги) йдуть через оболонку. */
export async function http(url, { method = 'GET', headers = {}, body = null, timeout = 20000, viaNative = false } = {}) {
  if (N && viaNative) {
    return new Promise((res, rej) => {
      const id = uid();
      const timer = setTimeout(() => { pendingHttp.delete(id); rej(new Error('timeout')); }, timeout + 2000);
      pendingHttp.set(id, { res, rej, timer });
      try { N.http(id, method, url, JSON.stringify(headers), body == null ? '' : String(body), timeout); }
      catch (e) { pendingHttp.delete(id); clearTimeout(timer); rej(e); }
    });
  }
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { method, headers, body: body == null ? undefined : body, signal: ac.signal });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(timer); }
}
export async function getJson(url, opts) {
  const r = await http(url, opts);
  if (r.status < 200 || r.status >= 300) { const e = new Error('HTTP ' + r.status); e.status = r.status; e.body = r.text; throw e; }
  return JSON.parse(r.text);
}

/* ---------- різне ---------- */
let wakeLock = null;
export async function keepAwake(on) {
  if (N) { try { N.keepAwake(!!on); } catch (_) {} return; }
  try {
    if (on && navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !N && !wakeLock && S.keepAwake !== false) keepAwake(true); });

export function saveText(name, mime, text) {
  if (N) { try { N.saveFile(name, mime, text); return true; } catch (e) { log('err', 'saveFile ' + e); return false; } }
  try {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  } catch (e) { return false; }
}
export function openUrl(url) { if (N) { try { N.openUrl(url); return; } catch (_) {} } window.open(url, '_blank', 'noopener'); }
export function notify(title, text) { if (N) { try { N.postNotice(String(title), String(text)); } catch (_) {} } }
export function vibrate(ms) { if (S.vibrate === false) return; if (N) { try { N.vibrate(ms); return; } catch (_) {} } if (navigator.vibrate) navigator.vibrate(ms); }
export function appInfo() {
  if (N) { try { return JSON.parse(N.info()); } catch (_) {} }
  return { app: 'web', code: 0, native: false };
}
export function openLocationSettings() { if (N && typeof N.openLocationSettings === 'function') { try { N.openLocationSettings(); return true; } catch (_) {} } return false; }
export function openAppSettings() { if (N && typeof N.openAppSettings === 'function') { try { N.openAppSettings(); return true; } catch (_) {} } return false; }
/* ---------- офлайн-карта (лише в застосунку) ---------- */
export const offlineSupported = () => !!N && typeof N.offlineStatus === 'function';
export function offlineStatus() { if (!offlineSupported()) return null; try { return JSON.parse(N.offlineStatus()); } catch (_) { return null; } }
export function offlineCheck() { if (offlineSupported()) { try { N.offlineCheck(); } catch (_) {} } }
export function offlineDownload(wifiOnly) { if (offlineSupported()) { try { N.offlineDownload(!!wifiOnly); return true; } catch (_) {} } return false; }
export function offlineCancel() { if (offlineSupported()) { try { N.offlineCancel(); } catch (_) {} } }
export function offlineDelete() { if (offlineSupported()) { try { N.offlineDelete(); } catch (_) {} } }
export function checkUpdate() { if (N) { try { N.checkUpdate(); return true; } catch (_) {} } return false; }
export const canReloadUi = () => !!(N && typeof N.reloadUi === 'function');
/** Перезавантажити інтерфейс на щойно встановлену версію (оболонка з 1.0.9). */
export function reloadUi() { if (N && typeof N.reloadUi === 'function') { try { N.reloadUi(); return true; } catch (_) {} } return false; }
export function applyWebUpdate() { if (N) { try { N.applyWebUpdate(); return true; } catch (_) {} } return false; }
export function installApk() { if (N) { try { N.installApk(); return true; } catch (_) {} } return false; }
export function nativeReady() { if (N) { try { N.ready(); } catch (_) {} } }
export const online = () => navigator.onLine !== false;
