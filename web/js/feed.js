// Стрічка подій: Telegram-канали регіонів попереду, повітряні тривоги, фільтр «дорожньо важливе», навчання від оцінок.
import { bus, log, S, db, uid, fmtDur, sleep } from './core.js';
import { http, isNative, online, notify, vibrate } from './platform.js';
import { pos } from './nav.js';
import { g, say } from './guide.js';
import { oblastOf, oblastName, reverse } from './route.js';
import { askClaude, hasKey } from './ai.js';
import { t } from './i18n.js';

export const feed = {
  items: [],            // {id,key,src,ch,level,score,text,sum,time,seen,vote,filtered,url,region}
  regions: [], towns: [], here: null,
  air: {}, airAt: 0, airErr: '', tgAt: 0, tgErr: '', chStatus: {}
};
let seenKeys = new Set(), W = {}, aiQueue = [], aiBusy = false;
try { W = JSON.parse(localStorage.getItem('reis.weights') || '{}'); } catch (_) {}

/* ---------- словник дорожніх подій (українською та російською) ---------- */
const RED = [
  [/перекри|перекры|перекро|рух (заблок|закрит|зупин)|движение (заблок|закрыт|останов)|закрит[оа]? (рух|проїзд)|закрыт[оа]? (движен|проезд)/, 3],
  [/(^|[^а-яіїєґ])дтп([^а-яіїєґ]|$)|аварі[яїю]|авари[яию]|зіткнен|столкновен|перекинул|опрокинул|перевернул/, 3],
  [/вибух|взрыв|приліт|прилет|обстріл|обстрел|влучан|попадани|ракетн|шахед/, 3],
  [/зруйнован|разрушен|пошкоджен\S* (міст|дорог)|поврежден\S* (мост|дорог)|обвал|провал/, 3],
  [/теракт|замінуван|заминирован|мінн\S+ небезпек|минн\S+ опасн/, 3],
  [/проїзд (неможлив|заборон)|проезд (невозмож|запрещ)|рух заборон|движение запрещ/, 3],
  [/пожеж|пожар|горить|горит|займан|возгоран/, 2],
  [/затоплен|підтоплен|подтоплен/, 2]
];
const YELLOW = [
  [/затор|пробк|тягнучк|тянучк|черг[аиу]|очеред/, 2],
  [/ускладнен|затруднен|обмежен\S* (рух|проїзд)|ограничен\S* (движен|проезд)/, 2],
  [/об['’ʼ]їзд|объезд|об['’ʼ]їжджа|объезжа/, 2],
  [/ремонт\S* (робот|работ|дорог|мост|міст)|реверсивн/, 2],
  [/ожеледиц|гололед|гололёд|слизьк|скользк|туман|снігопад|снегопад|замет|занос|хуртовин|метель|злив|ливень/, 2],
  [/блокпост|перевірк\S+ документ|проверк\S+ документ|комендантськ|комендантск/, 1.5],
  [/тривог|тревог|загроз|угроз/, 1.5],
  [/обережно|осторожно|будьте уважн|будьте вниматель/, 1]
];
const GREEN = [
  [/рух (відновлен|відкрит)|движение (восстановлен|открыт)|відновили рух|восстановили движение/, 3],
  [/(дорог|міст|мост|проїзд|проезд|трас)\S* (відкри|откры|розблок|разблок)|розблокован|разблокирован/, 3],
  [/відбій|отбой/, 2.5],
  [/затор\S* (немає|розсмокт)|пробк\S* (нет|рассос)|проїзд вільн|проезд свобод/, 2]
];
const UNSURE = /можлив|возможн|попередньо|предварительно|ймовірно|вероятно|за неперевірен|по непроверен|уточнюєть|уточняет|нібито|якобы/;
const ROAD = /дорог|трас|шосе|шоссе|автодор|міст|мост|рух|движен|проїзд|проезд|вулиц|улиц|перехрест|перекрест|розв['’ʼ]язк|развязк|кільцев|кольцев|об['’ʼ]їзд|объезд|блокпост|кпп|пункт\S* пропуск|в['’ʼ]їзд|въезд|виїзд|выезд|фур|вантаж|грузов|затор|пробк|дтп|[мнртmhpt][-– ]?\d{2}(\D|$)|(^|\s)e\s?\d{2,3}/;
const HARD = /вибух|взрыв|приліт|прилет|обстріл|обстрел|теракт|ракетн|шахед/;
const SPAM = /реклам|знижк|скидк|розіграш|розыгрыш|вакансі|ваканси|продам|купл[юя]|підпис(атися|уйтесь)|подпис(аться|ывайтесь)|промокод|казино|курс валют|гороскоп/;

const stems = s => [...new Set((s.toLowerCase().match(/[a-zа-яіїєґё']{4,}/g) || []).map(w => w.slice(0, 5)))];
function learned(s, ch) {
  let sum = 0, n = 0;
  for (const st of stems(s)) if (W[st]) { sum += W[st]; n++; }
  let v = n ? sum / Math.sqrt(n) : 0;
  if (ch && W['#' + ch]) v += W['#' + ch];
  return Math.max(-4, Math.min(4, v));
}
export function classify(text, ch) {
  const s = text.toLowerCase();
  const sum = arr => arr.reduce((a, [re, w]) => a + (re.test(s) ? w : 0), 0);
  const red = sum(RED), yel = sum(YELLOW), grn = sum(GREEN);
  const road = ROAD.test(s), hard = HARD.test(s);
  let level = null, score = 0;
  if (grn >= 2.5 && grn >= red) { level = 'green'; score = grn; }
  else if (red >= 3) { level = UNSURE.test(s) ? 'yellow' : 'red'; score = red + yel * 0.3; }
  else if (yel >= 2 || red >= 2) { level = 'yellow'; score = yel + red; }
  if (level && !road && !hard) level = null;                 // закрився завод — нам не цікаво; дорога — цікаво
  if (SPAM.test(s)) score -= 3;
  const town = feed.towns.some(n => n.length > 3 && s.includes(n.toLowerCase().slice(0, Math.max(4, n.length - 2))));
  if (town) score += 1.5;
  score += learned(s, ch);
  return { level, score, road: road || hard };
}
const VISIBLE = 1.2;

/* ---------- оцінки водія: 👍 потрібно, 👎 не потрібно, ? не вирішив ---------- */
export function vote(id, v) {
  const it = feed.items.find(x => x.id === id); if (!it) return;
  const prev = it.vote; it.vote = v;
  const dir = v === 1 ? 1 : v === -1 ? -1 : 0, undo = prev === 1 ? -1 : prev === -1 ? 1 : 0;
  const delta = dir + undo;
  if (delta) {
    const st = stems(it.text), lr = 0.9 / Math.sqrt(Math.max(4, st.length));
    for (const x of st) W[x] = Math.max(-3, Math.min(3, (W[x] || 0) + delta * lr));
    if (it.ch) W['#' + it.ch] = Math.max(-2, Math.min(2, (W['#' + it.ch] || 0) + delta * 0.4));
    try { localStorage.setItem('reis.weights', JSON.stringify(W)); } catch (_) {}
  }
  if (v === 1) { it.filtered = false; it.level = it.level || 'yellow'; }     // «потрібно» повертає відсіяне у шторку
  else if (v === -1) it.filtered = true;
  save(); bus.emit('feed', feed);
}
export function resetLearning() { W = {}; try { localStorage.removeItem('reis.weights'); } catch (_) {} }

/* ---------- додавання подій ---------- */
function save() { db.set('kv', 'feed', { items: feed.items.slice(-250), seen: [...seenKeys].slice(-1500) }); }
function add(it, quiet) {
  if (it.key && seenKeys.has(it.key)) return null;
  if (it.key) seenKeys.add(it.key);
  const item = { id: uid(), time: Date.now(), seen: false, vote: null, filtered: false, sum: '', ...it };
  feed.items.push(item); if (feed.items.length > 300) feed.items.splice(0, 50);
  if (!item.filtered && item.level && !quiet) alertUser(item);
  save(); bus.emit('feed', feed);
  return item;
}
function alertUser(item) {
  const text = item.voice || item.sum || item.text;
  bus.emit('toast', { level: item.level, text: item.sum || item.text, id: item.id });
  if (item.level === 'red') { say(t('voiceAttention') + ' ' + short(text, 220)); vibrate(400); if (document.hidden) notify(t('appName'), short(text, 160)); }
  else if (item.level === 'yellow') say(short(text, 200));
  else if (item.voice) say(item.voice);
}
const short = (s, n) => { s = String(s).replace(/\s+/g, ' ').replace(/https?:\S+/g, '').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s\S*$/, '') + '…' : s; };

/* ---------- регіони попереду ---------- */
export function regionsAhead() {
  // [{id, eta(сек до в'їзду, 0 — вже тут)}] у межах вікна аналізу
  const out = [], win = S.aheadH * 3600;
  if (g.active && g.idx && feed.regions.length) {
    const rd = pos.rd || 0, spd = g.remain > 0 && g.remTime > 0 ? g.remain / g.remTime : 18;
    let cur = null;
    for (const r of feed.regions) {
      if (r.d <= rd) { cur = r; continue; }
      const eta = (r.d - rd) / spd;
      if (eta <= win && !out.some(o => o.id === r.id)) out.push({ id: r.id, eta });
    }
    if (cur) out.unshift({ id: cur.id, eta: 0 }); else if (feed.regions[0]) out.unshift({ id: feed.regions[0].id, eta: 0 });
  } else if (feed.here) out.push({ id: feed.here, eta: 0 });
  return out;
}
export function setRouteContext(regions, towns) { feed.regions = regions || []; feed.towns = towns || []; bus.emit('feed', feed); }

let hereAt = 0, herePos = null;
async function updateHere() {
  if (pos.lat == null || !online()) return;
  const now = Date.now();
  if (herePos && now - hereAt < 30 * 60000 && Math.abs(herePos.lat - pos.lat) < 0.3 && Math.abs(herePos.lon - pos.lon) < 0.4) return;
  hereAt = now; herePos = { lat: pos.lat, lon: pos.lon };
  try { const r = await reverse(pos.lat, pos.lon); const id = r && oblastOf(r.state); if (id) feed.here = id; } catch (_) {}
}

/* ---------- Telegram: публічні канали через веб-перегляд t.me/s ---------- */
export const tgAvailable = () => isNative;      // у браузерній версії сайт Telegram не відповідає сторінкам (CORS)
async function pollChannel(name) {
  const r = await http('https://t.me/s/' + encodeURIComponent(name), { viaNative: true, timeout: 20000, headers: { 'Accept-Language': 'uk,ru;q=0.8' } });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const doc = new DOMParser().parseFromString(r.text, 'text/html'), out = [];
  doc.querySelectorAll('.tgme_widget_message').forEach(m => {
    const post = m.getAttribute('data-post'), tx = m.querySelector('.tgme_widget_message_text'), tm = m.querySelector('time[datetime]');
    if (!post || !tx) return;
    tx.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    const text = tx.textContent.trim(); if (!text) return;
    out.push({ key: 'tg:' + post, ch: name, text, time: tm ? Date.parse(tm.getAttribute('datetime')) : Date.now(), url: 'https://t.me/' + post });
  });
  return out;
}
export function activeChannels() {
  const ahead = regionsAhead().map(r => r.id);
  return (S.channels || []).filter(c => c.on !== false && (c.region === 'all' || !ahead.length || ahead.includes(c.region)));
}
let tgRunning = false;
export async function pollTelegram(manual) {
  if (tgRunning || !S.tg || !S.lookahead && !manual) return;
  if (!tgAvailable()) { feed.tgErr = 'web'; return; }
  if (!online()) { feed.tgErr = 'offline'; return; }
  tgRunning = true; feed.tgErr = '';
  const chans = activeChannels(), first = feed.tgAt === 0;
  for (const c of chans) {
    try {
      const msgs = await pollChannel(c.name);
      feed.chStatus[c.name] = msgs.length ? 'ok' : 'empty';
      const fresh = msgs.filter(m => Date.now() - m.time < 3 * 3600e3 && !seenKeys.has(m.key));
      for (const m of fresh) {
        const c2 = classify(m.text, m.ch);
        const filtered = !c2.level || c2.score < VISIBLE;
        const it = add({ src: 'tg', ...m, level: c2.level, score: c2.score, filtered }, first || S.aiFilter && hasKey() && c2.road);
        if (it && S.aiFilter && hasKey() && (c2.road || c2.level)) aiQueue.push(it);
      }
    } catch (e) { feed.chStatus[c.name] = 'err'; feed.tgErr = e.message; log('warn', 'Telegram @' + c.name + ': ' + e.message); }
    await sleep(1500);
  }
  feed.tgAt = Date.now(); tgRunning = false;
  bus.emit('feed', feed);
  runAi();
}

/* ---------- ШІ-фільтр: Claude перечитує кандидатів і вирішує, що справді стосується дороги ---------- */
async function runAi() {
  if (aiBusy || !aiQueue.length || !hasKey()) return;
  aiBusy = true;
  const batch = aiQueue.splice(0, 8);
  const liked = feed.items.filter(i => i.vote === 1).slice(-5).map(i => short(i.text, 140));
  const disliked = feed.items.filter(i => i.vote === -1).slice(-5).map(i => short(i.text, 140));
  const lang = S.lang === 'ru' ? 'російською' : 'українською';
  const system = `Ти фільтр дорожніх новин для водія вантажівки в Україні. Для кожного повідомлення визнач, чи впливає воно на проїзд дорогами: перекриття, ДТП, затори, мости, об'їзди, вибухи й обстріли біля доріг, погода на дорозі, блокпости.
Рівні: red — підтверджена перешкода руху; yellow — попередження або непідтверджене; green — проїзд відновлено чи корисна для водія новина; none — доріг не стосується (виробництво, політика, реклама).
Відповідай лише JSON-масивом без пояснень: [{"i":номер,"level":"red|yellow|green|none","sum":"суть до 12 слів ${lang}"}]`;
  const user = `Населені пункти на маршруті: ${feed.towns.slice(0, 25).join(', ') || 'невідомо'}.
${liked.length ? 'Водій позначив корисним: ' + JSON.stringify(liked) + '\n' : ''}${disliked.length ? 'Водій позначив непотрібним: ' + JSON.stringify(disliked) + '\n' : ''}Повідомлення:
${JSON.stringify(batch.map((b, i) => ({ i, ch: b.ch, text: short(b.text, 600) })))}`;
  try {
    const out = await askClaude({ system, messages: [{ role: 'user', content: user }], model: 'claude-haiku-5-5', maxTokens: 900 });
    const arr = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
    for (const r of arr) {
      const it = batch[r.i]; if (!it) continue;
      if (r.level === 'none') { it.filtered = true; }
      else if (['red', 'yellow', 'green'].includes(r.level)) { it.level = r.level; it.filtered = it.vote === -1; it.sum = r.sum || ''; it.ai = true; alertUser(it); }
    }
  } catch (e) {
    log('warn', 'ШІ-фільтр: ' + e.message);
    for (const it of batch) if (!it.filtered && it.level) alertUser(it);      // ШІ недоступний — показуємо за словником
  }
  aiBusy = false; save(); bus.emit('feed', feed);
  if (aiQueue.length) setTimeout(runAi, 1500);
}

/* ---------- повітряні тривоги ---------- */
async function fetchAir() {
  if (S.alertsToken) {
    const r = await http('https://api.alerts.in.ua/v1/alerts/active.json?token=' + encodeURIComponent(S.alertsToken.trim()), { viaNative: true, timeout: 15000 });
    if (r.status === 200) {
      const out = {}; for (const a of JSON.parse(r.text).alerts || []) {
        if (a.alert_type && a.alert_type !== 'air_raid') continue;
        const id = oblastOf(a.location_oblast || a.location_title); if (!id) continue;
        const whole = a.location_type === 'oblast' || a.location_type === 'city';
        if (whole || !out[id]) out[id] = { part: !whole };
      }
      return out;
    }
    log('warn', 'alerts.in.ua: HTTP ' + r.status);
  }
  // Без токена: відкрите зведення alerts.in.ua (текст, рядок на регіон)
  const r = await http('https://api.alerts.in.ua/v3/alerts/active.md', { viaNative: true, timeout: 15000 });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const out = {}; let hits = 0;
  for (const line of r.text.split('\n')) {
    if (!/in effect|триває|активна/i.test(line)) continue;
    hits++;
    const id = oblastOf(line); if (!id) continue;
    const part = /raion|hromada|район|громад/i.test(line);
    if (!part || !out[id]) out[id] = { part };
  }
  if (!hits && !/WARNING STATUS|no active|немає/i.test(r.text)) log('warn', 'тривоги: формат зведення змінився');
  return out;
}
let airBusy = false;
export async function pollAir() {
  if (airBusy || !S.air || !online()) return;
  if (!isNative && !S.alertsToken) { feed.airErr = 'web'; return; }
  airBusy = true;
  try {
    const now = await fetchAir(), prev = feed.air, first = feed.airAt === 0;
    const rel = regionsAhead();
    for (const r of rel) {
      const on = !!now[r.id], was = !!prev[r.id];
      if (on && (!was || first)) add({ src: 'air', level: 'yellow', region: r.id, key: 'air:' + r.id + ':' + Math.floor(Date.now() / 6e5),
        text: t('airOn', oblastName(r.id)) + (now[r.id].part ? ' ' + t('airPart') : '') + (r.eta > 60 ? ' ' + t('airEta', fmtDur(r.eta)) : '') });
      else if (!on && was && !first) add({ src: 'air', level: 'green', region: r.id, key: 'airoff:' + r.id + ':' + Math.floor(Date.now() / 6e5), text: t('airOff', oblastName(r.id)) });
    }
    feed.air = now; feed.airAt = Date.now(); feed.airErr = '';
  } catch (e) { feed.airErr = e.message; log('warn', 'тривоги: ' + e.message); }
  airBusy = false; bus.emit('feed', feed);
}

/* ---------- стан для шторки ---------- */
export function strip() {
  const now = Date.now();
  const act = feed.items.filter(i => !i.filtered && i.level && i.vote !== -1 && now - i.time < 2 * 3600e3);
  const c = { red: 0, yellow: 0, green: 0 }; for (const i of act) c[i.level]++;
  const rank = { red: 3, yellow: 2, green: 1 };
  const top = act.slice().sort((a, b) => (rank[b.level] - rank[a.level]) || (b.time - a.time))[0] || null;
  return { top, counts: c, unseen: act.filter(i => !i.seen).length };
}
export function markSeen() { let ch = false; for (const i of feed.items) if (!i.seen) { i.seen = true; ch = true; } if (ch) { save(); bus.emit('feed', feed); } }
export function clearFeed() { feed.items = []; save(); bus.emit('feed', feed); }

export async function init() {
  const st = await db.get('kv', 'feed');
  if (st) { feed.items = (st.items || []).filter(i => Date.now() - i.time < 24 * 3600e3); seenKeys = new Set(st.seen || []); }
  bus.on('feedPush', it => add(it));
  bus.emit('feed', feed);
  const loop = async () => {
    if (S.lookahead) { await updateHere(); if (S.air) await pollAir(); if (S.tg) await pollTelegram(); }
  };
  setTimeout(loop, 8000);
  setInterval(loop, 180000);
}
