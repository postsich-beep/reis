// Тихі звуки інтерфейсу (WebAudio, без файлів). Зараз один: ледь чутний «дзинь» на пройденому контрольному повороті —
// спокійний, двома м'якими нотами, набагато тихіший за голос; водій чує, що поворот відпрацьовано, не дивлячись на екран.
import { S } from './core.js';
let ctx = null;
function ac() {
  if (ctx) return ctx;
  const C = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext); if (!C) return null;
  try { ctx = new C(); } catch (_) { ctx = null; }
  return ctx;
}
// WebView може тримати звук «приспаним» до першого дотику — будимо його на першому ж торканні екрана
export function initSfx() {
  if (typeof window === 'undefined' || !window.addEventListener) return;
  const wake = () => { const c = ac(); if (c && c.state === 'suspended') c.resume().catch(() => {}); };
  window.addEventListener('pointerdown', wake, { passive: true });
}
function note(c, f, t0, dur, gain) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = f;
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02);
}
export const sfxLog = [];                       // для перевірок: що й коли зіграло
export function chime(kind = 'pass') {
  sfxLog.push({ kind, t: Date.now() }); if (sfxLog.length > 30) sfxLog.shift();
  if (S.cpSound === false) return false;
  const c = ac(); if (!c) return false;
  try {
    if (c.state === 'suspended') c.resume().catch(() => {});
    const t0 = c.currentTime + 0.01, v = 0.05;                   // дуже тихо: голос підказок не перебиває
    if (kind === 'pass') { note(c, 660, t0, 0.22, v); note(c, 880, t0 + 0.12, 0.32, v); }
    else note(c, 520, t0, 0.25, v);
    return true;
  } catch (_) { return false; }
}
