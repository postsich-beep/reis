// Чат із Claude: текст, голосове повідомлення, жива розмова. Claude бачить рейс, позицію і стрічку подій.
import { bus, S, log, fmtDist, fmtDur, fmtClock } from './core.js';
import { askClaude, hasKey } from './ai.js';
import { listen, stopListen, canListen, speak, stopSpeak } from './platform.js';
import { pos } from './nav.js';
import { g } from './guide.js';
import { feed, regionsAhead } from './feed.js';
import { poi, stopsAhead, stopLabel } from './poi.js';
import { oblastName, tripTitle } from './route.js';
import { t } from './i18n.js';

export const chat = { msgs: [], busy: false, live: false, listening: false, partial: '', error: '' };
const cut = (s, n = 160) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

function context() {
  const L = ['Час: ' + new Date().toLocaleString('uk-UA')];
  if (pos.lat != null) L.push(`Позиція: ${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)}; швидкість ${Math.round(pos.spd * 3.6)} км/год; GPS: ${pos.mode === 'gps' ? 'працює' : 'немає сигналу, позиція розрахункова ±' + pos.acc + ' м'}`);
  else L.push('Позиція ще не визначена.');
  if (g.trip) {
    L.push('Рейс: ' + tripTitle(g.trip));
    if (g.active) L.push(`Залишилось ${fmtDist(g.remain)}, приблизно ${fmtDur(g.remTime)}, прибуття о ${fmtClock(new Date(g.eta))}`);
    if (g.active && g.next) L.push('Наступний маневр через ' + fmtDist(g.distNext) + ': ' + g.next.ins);
    if (g.arrived) L.push('Рейс завершено, водій прибув.');
  } else L.push('Активного рейсу немає.');
  const ra = regionsAhead();
  if (ra.length) L.push('Області на шляху: ' + ra.map(r => oblastName(r.id) + (r.eta > 60 ? ' (через ' + fmtDur(r.eta) + ')' : ' (зараз)')).join(', '));
  const air = Object.keys(feed.air || {});
  L.push(feed.airAt ? ('Повітряна тривога зараз: ' + (air.length ? air.map(oblastName).join(', ') : 'немає даних про активні тривоги на маршруті')) : 'Дані про повітряні тривоги не завантажені.');
  const ev = feed.items.filter(i => !i.filtered && i.level && Date.now() - i.time < 3 * 3600e3).slice(-8);
  L.push(ev.length ? 'Події у стрічці за 3 години:\n' + ev.map(i => `- [${i.level}] ${cut(i.sum || i.text)}`).join('\n') : 'У стрічці подій немає нових записів.');
  const st = stopsAhead(3).slice(0, 4);
  if (st.length) L.push('Стоянки для фур попереду: ' + st.map(s => stopLabel(s).title + ' через ' + fmtDist(s.d - (pos.rd || 0))).join('; '));
  if (poi.drive > 600) L.push('За кермом без перерви: ' + fmtDur(poi.drive));
  const tr = S.truck; L.push(`Фура: висота ${tr.height} м, довжина ${tr.length} м, маса ${tr.weight} т.`);
  return L.join('\n');
}

function system() {
  return `Ти Claude, штурман-помічник водія фури в застосунку «Рейс» (Україна). Водій за кермом, тому відповідай коротко: одне–три речення, без списків і розмітки, відповідь буде озвучена. Відповідай тією мовою, якою звертається водій (${S.lang === 'ru' ? 'зазвичай російською' : 'зазвичай українською'}).
Спирайся на дані застосунку нижче. Якщо даних бракує, скажи про це прямо і не вигадуй дорожню обстановку, затори чи перекриття. Не радь порушувати правила руху та режим праці й відпочинку.

Дані застосунку на цю мить:
${context()}`;
}

export async function send(text, { spoken = false } = {}) {
  text = (text || '').trim(); if (!text || chat.busy) return null;
  chat.error = '';
  chat.msgs.push({ role: 'user', content: text, t: Date.now() });
  if (!hasKey()) { chat.error = 'nokey'; bus.emit('chat', chat); return null; }
  chat.busy = true; bus.emit('chat', chat);
  let ans = null;
  try {
    const hist = chat.msgs.slice(-12).map(m => ({ role: m.role, content: m.content }));
    while (hist.length && hist[0].role !== 'user') hist.shift();
    ans = await askClaude({ system: system(), messages: hist, maxTokens: 500 });
    chat.msgs.push({ role: 'assistant', content: ans, t: Date.now() });
    if (chat.msgs.length > 60) chat.msgs.splice(0, 20);
  } catch (e) {
    chat.error = e.status === 401 ? 'badkey' : (e.message || 'error'); log('warn', 'чат: ' + e.message);
    chat.msgs.pop();                                            // питання не збереглося в історії — можна повторити
  }
  chat.busy = false; bus.emit('chat', chat);
  if (ans && (spoken || chat.live)) { stopSpeak(); await speak(ans); }
  return ans;
}

// Голосове повідомлення: натиснув мікрофон — сказав — відправилось.
export async function voiceOnce() {
  if (chat.listening || chat.busy) { stopListen(); return; }
  if (!canListen()) { chat.error = 'nostt'; bus.emit('chat', chat); return; }
  chat.listening = true; chat.partial = ''; chat.error = ''; bus.emit('chat', chat);
  stopSpeak();
  let text = '';
  try { text = await listen(p => { chat.partial = p; bus.emit('chat', chat); }); }
  catch (e) { chat.error = 'stt:' + e.message; }
  chat.listening = false; chat.partial = ''; bus.emit('chat', chat);
  if (text) await send(text, { spoken: true });
  return text;
}

// Жива розмова: слухаю → відповідаю голосом → знову слухаю, доки водій не зупинить або не замовкне двічі.
export async function toggleLive() {
  if (chat.live) { chat.live = false; stopListen(); stopSpeak(); bus.emit('chat', chat); return; }
  if (!canListen()) { chat.error = 'nostt'; bus.emit('chat', chat); return; }
  if (!hasKey()) { chat.error = 'nokey'; bus.emit('chat', chat); return; }
  chat.live = true; bus.emit('chat', chat);
  let misses = 0;
  while (chat.live) {
    const text = await voiceOnce();
    if (!chat.live) break;
    if (chat.error) break;
    if (!text) { if (++misses >= 2) break; } else misses = 0;
  }
  chat.live = false; bus.emit('chat', chat);
}
export const clearChat = () => { chat.msgs = []; chat.error = ''; bus.emit('chat', chat); };
export const errorText = e => e === 'nokey' ? t('chatNoKey') : e === 'badkey' ? t('chatBadKey') : e === 'nostt' ? t('chatNoStt') : e.startsWith('stt:') ? t('chatSttErr') : t('chatErr') + ' ' + e;
