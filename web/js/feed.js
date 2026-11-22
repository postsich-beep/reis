// Стрічка подій: Telegram-канали регіонів попереду, повітряні тривоги, фільтр «дорожньо важливе», навчання від оцінок.
import { bus, log, S, db, uid, sleep, hav } from './core.js';
import { http, isNative, online, notify, vibrate } from './platform.js';
import { pos } from './nav.js';
import { g, say, distWords } from './guide.js';
import { oblastOf, oblastName, reverse, OBLASTS, OBLAST_CENTER, placeSearch, townName } from './route.js';
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
  [/вибух|взрыв|приліт|прилет|обстріл|обстрел|влучан|попадани/, 3],
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
  [/бпла|дрон|шахед|балістик|баллистик|ракет|крилат|крылат/, 2],
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
const HARD = /вибух|взрыв|приліт|прилет|обстріл|обстрел|теракт|ракет|шахед|бпла|дрон|балістик|баллистик/;
// Довгі перешкоди, про які варто знати й за сотні кілометрів: перекриття, зруйнований чи закритий міст, ремонт з обмеженням руху, заборона для фур
const IMPORTANT = /перекри|перекры|рух (заблок|закрит|зупин)|движение (заблок|закрыт|останов)|проїзд (неможлив|заборон|закрит)|проезд (невозмож|запрещ|закрыт)|(міст|мост|шляхопровід|путепровод)\S* (зруйн|разруш|закрит|закрыт|пошкодж|поврежд)|(зруйн|разруш|пошкодж|поврежд)\S* (міст|мост|шляхопровід|путепровод)|ремонт\S* (дорог|мост|міст|траси|трассы|шляхопровод|путепровод|покритт|покрыт|полотн)|капітальн\S* ремонт|капитальн\S* ремонт|реверсивн|(обмежен|заборон)\S* (рух|проїзд|в['’ʼ]їзд)\S* (для )?(вантаж|фур)|(ограничен|запрещ)\S* (движен|проезд|въезд)\S* (для )?(груз|фур)/;
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
  const town = feed.towns.some(x => { const n = townName(x); return n.length > 3 && s.includes(n.toLowerCase().slice(0, Math.max(4, n.length - 2))); });
  if (town) score += 1.5;
  score += learned(s, ch);
  const imp = !!level && level !== 'green' && IMPORTANT.test(s) && !UNSURE.test(s);
  return { level, score, road: road || hard, imp };
}
const VISIBLE = 1.2;

/* ---------- оцінки водія: 👍 потрібно, 👎 не потрібно, ? не вирішив ---------- */
/* ---------- де сталася подія: місто на маршруті, назва з тексту, або вся область ---------- */
const STOPW = new Set(['україна', 'україни', 'україні', 'україну', 'украина', 'украины', 'росія', 'росії', 'россия', 'дснс', 'дтп', 'зсу', 'бпла', 'увага', 'внимание',
  'терміново', 'срочно', 'оновлено', 'сьогодні', 'вчора', 'завтра', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота', 'неділя',
  'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня', 'поліція', 'патрульні', 'рятувальники', 'водіїв', 'водії']);
const norm = s => s.toLowerCase().replace(/[ʼ'’]/g, '').replace(/[іїи]/g, 'і').replace(/[єе]/g, 'е');
const geoCache = new Map();
try { for (const [k, v] of JSON.parse(localStorage.getItem('reis.geo') || '[]')) geoCache.set(k, v); } catch (_) {}
const saveGeo = () => { try { localStorage.setItem('reis.geo', JSON.stringify([...geoCache].slice(-400))); } catch (_) {} };
function nearRoute(p) {
  if (g.idx) { const l = g.idx.locate(p, null); return l && l.off < 40000; }
  return pos.lat == null || hav(p, pos) < 200000;
}
async function findPlace(word) {
  const key = norm(word);
  if (geoCache.has(key)) return geoCache.get(key);
  const vars = [...new Set([word, word.replace(/ова$/, 'ів'), word.replace(/єва$/, 'їв'), word.replace(/ові$/, 'ів'), word.replace(/(ою|ому|ого|ах|ах|і|у|а)$/, '')])].filter(v => v.length >= 4);
  let hit = null;
  for (const v of vars) {
    let res = [];
    try { res = await placeSearch(v); } catch (_) { return null; }        // немає мережі — не кешуємо
    hit = res.find(r => norm(r.name).slice(0, 4) === key.slice(0, 4) && nearRoute(r));
    if (hit) break;
    await sleep(300);
  }
  geoCache.set(key, hit || 0); saveGeo();
  return hit;
}
const locQueue = [], pendAlert = new Map(); let locBusy = false, locCur = null;
// Про подію з Telegram говоримо, лише коли зрозуміло, де вона: позаду — мовчимо, далеко — скажемо, коли під'їдемо.
function placeThenAlert(it, silent) {
  if (it.lat != null || (it.locTried && !locQueue.includes(it) && locCur !== it && !pendAlert.has(it.id))) { alertUser(it, silent); return; }
  pendAlert.set(it.id, !!silent);
  if (!it.locTried) locate(it);
}
export function locate(it) {
  if (!it || it.lat != null || it.locTried) return;
  it.locTried = true; locQueue.push(it);
  if (!locBusy) runLocate();
}
async function runLocate() {
  locBusy = true;
  while (locQueue.length) {
    const it = locCur = locQueue.shift(), s = norm(it.text);
    let p = null, kind = 'town';
    // 1) місто з маршруту
    for (const x of feed.towns) { if (typeof x !== 'object' || x.lat == null) continue; const n = norm(x.name); if (n.length > 3 && s.includes(n.slice(0, Math.max(4, n.length - 2)))) { p = x; break; } }
    // 2) назва від ШІ або великі літери в тексті
    if (!p && online()) {
      const words = it.place ? [it.place] : [...new Set(it.text.split(/[^\p{L}ʼ'’-]+/u).filter(w => /^[А-ЯІЇЄҐ][а-яіїєґʼ'’-]{3,}$/.test(w) && !STOPW.has(w.toLowerCase()) && !/ськ|цьк|щин/.test(w.toLowerCase())))].slice(0, 3);
      for (const w of words) { p = await findPlace(w); if (p) break; }
    }
    // 3) лише область — позначка в обласному центрі
    if (!p) { const o = OBLASTS.find(x => x.re.test(it.text.toLowerCase())); if (o && OBLAST_CENTER[o.id]) { p = { name: oblastName(o.id), lat: OBLAST_CENTER[o.id][0], lon: OBLAST_CENTER[o.id][1] }; kind = 'area'; it.oblast = o.id; } }
    if (p) { it.lat = p.lat; it.lon = p.lon; it.locName = p.name; it.locKind = kind; save(); bus.emit('feed', feed); }
    locCur = null;
    if (pendAlert.has(it.id)) { const silent = pendAlert.get(it.id); pendAlert.delete(it.id); alertUser(it, silent); }
  }
  locBusy = false;
}

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
  delete item.quiet;
  if (quiet && item.src !== 'tg') item.hush = true;           // тихе з самого початку (погода «жовта», спека): лише шторка й карта
  feed.items.push(item); if (feed.items.length > 300) feed.items.splice(0, 50);
  if (!item.filtered && item.level && !quiet) alertUser(item);
  save(); bus.emit('feed', feed);
  if (item.src === 'tg' && !item.filtered && item.level) locate(item);
  return item;
}
// Єдині ворота для тостів і голосу. silent — показати, але не говорити (перше опитування після запуску).
function alertUser(item, silent) {
  const r = relevance(item);
  if (!r.show) return;                                       // позаду, застаріло чи ще далеко — скажемо, коли буде до 100 км
  const lbl = relLabel(item, r), body = item.sum || item.text;
  if (r.tier === 'far') {                                    // важливе далеко попереду: один тихий тост без голосу, голос — на підʼїзді
    if (!item.farSaid) { item.farSaid = true; if (!silent && !item.hush) bus.emit('toast', { level: item.level, text: (lbl ? lbl + ' · ' : '') + body, id: item.id }); }
    return;
  }
  item.said = Date.now(); item.saidAt = r.ahead == null ? null : Math.round(r.ahead);
  if (silent || item.hush) return;
  const text = item.voice || item.sum || item.text;
  const pre = r.ahead != null && r.ahead >= 2000 && item.src !== 'stop' && item.src !== 'drive' ? t('voiceInEv', distWords(r.ahead)) + ' ' : '';
  if (r.tier === 'unknown' && item.level !== 'red') { bus.emit('toast', { level: item.level, text: body, id: item.id }); return; }   // невідомо де — без голосу
  bus.emit('toast', { level: item.level, text: (lbl ? lbl + ' · ' : '') + body, id: item.id });
  if (item.level === 'red') { say(t('voiceAttention') + ' ' + pre + short(text, 220)); vibrate(400); if (document.hidden && S.notify !== false) notify(t('appName'), (lbl ? lbl + ' · ' : '') + short(text, 160)); }
  else if (item.level === 'yellow') say(pre + short(text, 200));
  else if (item.voice) say(item.voice);
}

/* ---------- доречність: лише тут і попереду ---------- */
// Водію потрібне те, що буде на його шляху найближчим часом, а не те, що вже позаду.
// Збираємо заздалегідь (канали областей попереду), а говоримо вчасно: коли до події ≤ S.nearKm (100 км).
// Далі цієї межі — лише довгі перешкоди (перекриття, міст, ремонт з обмеженням): тихо в шторці, голосом — на підʼїзді.
const BEHIND = 3000, OFF_MAX = 20000, REMIND = 20000;
export const nearM = () => Math.max(20, +S.nearKm || 100) * 1000;
function ttl(it) {
  if (it.src === 'air') return it.level === 'green' ? 20 * 60e3 : 12 * 3600e3;   // жовта тривога живе, поки тривога триває
  if (it.imp) return 12 * 3600e3;
  if (it.src === 'stop') return 40 * 60e3;
  if (it.src === 'wx' || it.src === 'drive') return 3 * 3600e3;
  return it.level === 'red' ? 3 * 3600e3 : it.level === 'green' ? 3600e3 : 2 * 3600e3;
}
const onTrip = () => g.active && g.idx && pos.rd != null;
// Межа області — посередині між точкою, де вже інша область, і попередньою (області визначаємо що 15–30 км)
const regStart = (R, i) => i === 0 ? 0 : R[i].d0 != null ? (R[i].d0 + R[i].d) / 2 : R[i].d;
// Області на шляху: та, де машина, і ті, куди вʼїдемо в межах near. Без рейсу — лише та, де машина.
export function zoneRegions(near = nearM()) {
  if (onTrip() && feed.regions.length) {
    const rd = pos.rd, R = feed.regions, out = [];
    for (let i = 0; i < R.length; i++) {
      const s = regStart(R, i), e = i + 1 < R.length ? regStart(R, i + 1) : Infinity;
      if (e <= rd || s - rd > near) continue;
      if (!out.some(o => o.id === R[i].id)) out.push({ id: R[i].id, dist: Math.max(0, s - rd) });
    }
    return out;
  }
  return feed.here ? [{ id: feed.here, dist: 0 }] : [];
}
function regionPos(id) {
  if (!(onTrip() && feed.regions.length)) return feed.here ? (id === feed.here ? { ahead: 0 } : null) : { unknown: true };
  const rd = pos.rd, R = feed.regions; let best = null, passed = false;
  for (let i = 0; i < R.length; i++) {
    if (R[i].id !== id) continue;
    const s = regStart(R, i), e = i + 1 < R.length ? regStart(R, i + 1) : Infinity;
    if (e <= rd) { passed = true; continue; }
    const a = Math.max(0, s - rd); if (!best || a < best.ahead) best = { ahead: a };
  }
  return best || (passed ? { behind: true } : null);
}
const locCache = new WeakMap();
function routePos(it) {
  let c = locCache.get(it);
  if (!c || c.idx !== g.idx || c.lat !== it.lat || c.lon !== it.lon) {
    const l = g.idx.locate({ lat: it.lat, lon: it.lon }, null);
    c = { idx: g.idx, lat: it.lat, lon: it.lon, d: l ? l.d : null, off: l ? l.off : Infinity }; locCache.set(it, c);
  }
  return c;
}
function tierOf(a, it, area) {
  if (a < -BEHIND) return { show: false, tier: 'behind', ahead: a };
  if (a <= 1500) return { show: true, tier: 'here', ahead: Math.max(0, a), area };
  if (a <= nearM()) return { show: true, tier: 'near', ahead: a, area };
  return it.imp ? { show: true, tier: 'far', ahead: a, area } : { show: false, tier: 'later', ahead: a };
}
function byRegion(id, it) {
  const r = regionPos(id);
  if (!r) return { show: false, tier: 'away' };
  if (r.unknown) return { show: true, tier: 'unknown' };
  if (r.behind) return { show: false, tier: 'behind' };
  return tierOf(r.ahead, it, true);
}
// → { show, tier: here|near|far|unknown (видно) або behind|later|away|old|off (не видно), ahead — метрів до події по маршруту }
export function relevance(it, now = Date.now()) {
  if (!it || !it.level || it.filtered || it.vote === -1) return { show: false, tier: 'off' };
  if (now - it.time > ttl(it)) return { show: false, tier: 'old' };
  if (it.src === 'air') {
    if (it.level === 'yellow' && feed.airAt && !feed.air[it.region]) return { show: false, tier: 'old' };   // тривога вже скінчилась
    return byRegion(it.region, it);
  }
  if (it.src === 'drive') return { show: true, tier: 'here', ahead: 0 };
  if (it.lat != null && it.locKind !== 'area') {
    if (onTrip()) {
      const c = routePos(it);
      if (c.d == null || c.off > (it.src === 'tg' ? OFF_MAX : 3000)) return { show: false, tier: 'away' };
      return tierOf(c.d - pos.rd, it, false);
    }
    if (pos.lat != null) {                                   // без рейсу напрямку не знаємо — лише довкола машини
      const dd = hav(it, pos), near = nearM() / 2;
      if (dd <= near) return { show: true, tier: dd < 1500 ? 'here' : 'near', ahead: dd, around: true };
      return it.imp && dd <= nearM() * 3 ? { show: true, tier: 'far', ahead: dd, around: true } : { show: false, tier: 'away' };
    }
    return { show: true, tier: 'unknown' };
  }
  const reg = it.oblast || it.region;
  if (reg) return byRegion(reg, it);
  return { show: true, tier: 'unknown' };
}
// Підпис відстані для шторки й тостів: «Тут», «через 34 км», «за 12 км» (без рейсу, по прямій)
export function relLabel(it, r) {
  if (!r || r.ahead == null || it.src === 'stop' || it.src === 'drive') return '';
  if (r.tier === 'here' || r.ahead < 1500) return r.area ? '' : t('evHere');
  const km = Math.max(1, Math.round(r.ahead / 1000));
  return r.around ? t('evAround', km) : t('evIn', km);
}
const RANK = { red: 3, yellow: 2, green: 1 };
const relRank = (i, r) => r.tier === 'far' ? 1.5 : RANK[i.level] || 0;
// Головне (тут і попереду) та інше (відсіяне, позаду, далеко) — для шторки й панелі стрічки
export function feedLists(now = Date.now()) {
  const main = [], rest = [];
  const airNew = {};                                          // тривога області — одна, найсвіжіша (після перезапусків не множиться)
  for (const i of feed.items) if (i.src === 'air' && i.region && (!airNew[i.region] || airNew[i.region].time < i.time)) airNew[i.region] = i;
  for (const i of feed.items) {
    const r = i.src === 'air' && airNew[i.region] !== i ? { show: false, tier: 'old' } : relevance(i, now);
    (r.show ? main : rest).push([i, r]);
  }
  main.sort((a, b) => (relRank(b[0], b[1]) - relRank(a[0], a[1])) || ((a[1].ahead ?? 5e4) - (b[1].ahead ?? 5e4)) || (b[0].time - a[0].time));
  rest.sort((a, b) => b[0].time - a[0].time);
  return { main, rest };
}
// Раз на 10 с: подія, до якої під'їхали ближче 100 км, озвучується; червона — ще раз за 20 км; тривоги областей попереду — так само
let relSig = '';
export function watch() {
  if (!S.lookahead) return;
  airCheck();
  const now = Date.now(); let sig = '';
  for (const it of feed.items) {
    const r = relevance(it, now);
    if (!r.show) continue;
    sig += it.id + r.tier[0];
    if (it.hush || it.aiWait || pendAlert.has(it.id)) continue;
    if (!it.said && r.tier !== 'far') alertUser(it);
    else if (it.said && it.level === 'red' && !it.rem && it.saidAt > 2 * REMIND && r.ahead != null && r.ahead <= REMIND && !r.area) {
      it.rem = true;
      say(t('voiceAttention') + ' ' + t('voiceInEv', distWords(r.ahead)) + ' ' + short(it.voice || it.sum || it.text, 200));
      bus.emit('toast', { level: 'red', text: relLabel(it, r) + ' · ' + (it.sum || it.text), id: it.id });
    }
  }
  if (sig !== relSig) { relSig = sig; save(); bus.emit('feed', feed); }
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
export const tgAvailable = () => isNative;

// Перевірені публічні канали (листопад 2026). Загальноукраїнські показують лише те, де згадано області чи міста на шляху.
export const DEFAULT_CHANNELS = [
  { name: 'kpszsu', region: 'all', on: true },                       // Повітряні сили ЗСУ: ракети, БпЛА
  { name: 'dsns_telegram', region: 'all', on: true },                // ДСНС України
  { name: 'UA_National_Police', region: 'all', on: true },           // Національна поліція
  { name: 'truexanewsua', region: 'all', on: true },                 // Труха Україна: швидкі новини
  { name: 'Agency_for_restoration', region: 'all', on: true },       // Агентство відновлення: ремонти, мости, обмеження для фур (спека)
  { name: 'kyivoda', region: 'kyiv', on: true },
  { name: 'synegubov', region: 'kharkiv', on: true },
  { name: 'dnipropetrovskaODA', region: 'dnipro', on: true },
  { name: 'odeskaODA', region: 'odesa', on: true },
  { name: 'zoda_gov_ua', region: 'zaporizhzhia', on: true },
  { name: 'kozytskyy_maksym_official', region: 'lviv', on: true },
  { name: 'chernigivskaODA', region: 'chernihiv', on: true },
  { name: 'zhytomyrskaODA', region: 'zhytomyr', on: true },
  { name: 'volynskaODA', region: 'volyn', on: true },
  { name: 'cherkaskaODA', region: 'cherkasy', on: true },
  { name: 'khersonskaODA', region: 'kherson', on: true },
  { name: 'kirovogradskaODA', region: 'kirovohrad', on: true },
  { name: 'ternopilskaODA', region: 'ternopil', on: true },
  { name: 'khmelnytskaODA', region: 'khmelnytskyi', on: true },
  { name: 'zakarpatskaODA', region: 'zakarpattia', on: true },
  { name: 'chernivetskaODA', region: 'chernivtsi', on: true }
];
const CH_DEF_VER = 3;                  // збільшується, коли список поповнюється: нові канали додаються й тим, у кого вже є список
export function addDefaultChannels() {
  const have = new Set((S.channels || []).map(c => c.name.toLowerCase()));
  const add = DEFAULT_CHANNELS.filter(c => !have.has(c.name.toLowerCase())).map(c => ({ ...c }));
  S.channels = (S.channels || []).concat(add);
  return add.length;
}
// Чи стосується повідомлення загальноукраїнського каналу нашого шляху: згадано область попереду або місто на маршруті.
// Номери трас на маршруті («М-03», «Н-31») у вигляді, стійкому до написання: «м03», «н31».
const refKey = x => x.toLowerCase().replace(/[\s-]/g, '').replace(/m/g, 'м').replace(/h/g, 'н').replace(/p/g, 'р').replace(/t/g, 'т').replace(/e/g, 'е');
function routeRefs() {
  const out = new Set();
  for (const m of (g.route && g.route.mans) || []) for (const n of m.streets || []) if (/^[МMНHРPТTЕE]\s?-?\s?\d/.test(n)) out.add(refKey(n));
  return out;
}
function mentionsRoute(text) {
  const s = text.toLowerCase();
  const refs = routeRefs();
  if (refs.size) for (const m of s.matchAll(/(?:^|[^а-яa-z])([мmнhрpтtеe])\s?-?\s?(\d{1,4})(?!\d)/g)) if (refs.has(refKey(m[1] + m[2]))) return true;
  const ids = regionsAhead().map(r => r.id);
  if (ids.some(id => { const o = OBLASTS.find(x => x.id === id); return o && o.re.test(s); })) return true;
  return feed.towns.some(x => { const n = townName(x); return n.length > 3 && s.includes(n.toLowerCase().slice(0, Math.max(4, n.length - 2))); });
}      // у браузерній версії сайт Telegram не відповідає сторінкам (CORS)
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
// Якщо опитування вже йде, а водій щойно рушив чи змінив канали, — після поточного кола робимо ще одне
// і віддаємо той самий проміс, щоб той, хто просив, дочекався свіжих даних.
let tgAgain = false, tgWait = null;
export async function pollTelegram(manual) {
  if (tgRunning) { if (manual) { tgAgain = true; return tgWait; } return; }
  if (!S.tg || !S.lookahead && !manual) return;
  if (!tgAvailable()) { feed.tgErr = 'web'; return; }
  if (!online()) { feed.tgErr = 'offline'; return; }
  tgRunning = true; feed.tgErr = '';
  let done; tgWait = new Promise(r => { done = r; });
  try { do { tgAgain = false; await pollRound(); } while (tgAgain); }
  finally { tgRunning = false; done(); }
  bus.emit('feed', feed);
  runAi();
}
async function pollRound() {
  const chans = activeChannels(), first = feed.tgAt === 0, names = chans.map(c => c.name).join();
  for (const c of chans) {
    if (activeChannels().map(x => x.name).join() !== names) { tgAgain = true; return; }   // список каналів змінився — почнемо заново
    try {
      const msgs = await pollChannel(c.name);
      feed.chStatus[c.name] = msgs.length ? 'ok' : 'empty';
      const fresh = msgs.filter(m => Date.now() - m.time < 3 * 3600e3 && !seenKeys.has(m.key));
      for (const m of fresh) {
        const c2 = classify(m.text, m.ch);
        const filtered = !c2.level || c2.score < VISIBLE || (c.region === 'all' && !mentionsRoute(m.text));
        const ai = S.aiFilter && hasKey() && (c2.road || c2.level);
        const it = add({ src: 'tg', ...m, region: c.region !== 'all' ? c.region : undefined, level: c2.level, score: c2.score, imp: c2.imp, filtered, start: first || undefined, aiWait: ai || undefined }, true);
        if (!it) continue;
        if (ai) aiQueue.push(it);
        else if (!filtered && c2.level) placeThenAlert(it, first);
      }
    } catch (e) { feed.chStatus[c.name] = 'err'; feed.tgErr = e.message; log('warn', 'Telegram @' + c.name + ': ' + e.message); }
    await sleep(1500);
  }
  feed.tgAt = Date.now();
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
imp: true — лише для довгих перешкод, про які варто знати й за сотні кілометрів (перекриття траси, зруйнований чи закритий міст, ремонт з обмеженням руху, заборона для вантажівок); ДТП, затор, тривога — false.
Відповідай лише JSON-масивом без пояснень: [{"i":номер,"level":"red|yellow|green|none","imp":true|false,"sum":"суть до 12 слів ${lang}","place":"назва населеного пункту в називному відмінку, де сталася подія, або порожньо"}]`;
  const user = `Населені пункти на маршруті: ${feed.towns.slice(0, 25).map(townName).join(', ') || 'невідомо'}.
${liked.length ? 'Водій позначив корисним: ' + JSON.stringify(liked) + '\n' : ''}${disliked.length ? 'Водій позначив непотрібним: ' + JSON.stringify(disliked) + '\n' : ''}Повідомлення:
${JSON.stringify(batch.map((b, i) => ({ i, ch: b.ch, text: short(b.text, 600) })))}`;
  try {
    const out = await askClaude({ system, messages: [{ role: 'user', content: user }], model: 'claude-haiku-5-5', maxTokens: 900 });
    const arr = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
    for (const r of arr) {
      const it = batch[r.i]; if (!it) continue;
      it.aiWait = false;
      if (r.level === 'none') { it.filtered = true; }
      else if (['red', 'yellow', 'green'].includes(r.level)) {
        it.level = r.level; it.filtered = it.vote === -1; it.sum = r.sum || ''; it.ai = true; it.imp = r.level !== 'green' && (r.imp === true || (r.imp == null && it.imp));
        if (r.place && it.lat == null) { it.place = String(r.place).slice(0, 60); it.locTried = false; }
        if (!it.filtered) placeThenAlert(it, it.start);
      }
    }
    for (const it of batch) if (it.aiWait) { it.aiWait = false; if (!it.filtered && it.level) placeThenAlert(it, it.start); }
  } catch (e) {
    log('warn', 'ШІ-фільтр: ' + e.message);
    for (const it of batch) { it.aiWait = false; if (!it.filtered && it.level) placeThenAlert(it, it.start); }      // ШІ недоступний — за словником
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
// Тривога цікава лише там, де машина, і в областях, куди вʼїдемо за ≤ 100 км. Тривогу області далі попереду
// скажемо, коли до неї лишиться 100 км (якщо ще триватиме); відбій — лише для областей, про тривогу в яких казали.
const airSaid = {};
function airCheck() {
  if (!S.air || !feed.airAt) return;
  const zone = zoneRegions(), now = Date.now();
  for (const z of zone) {
    const on = feed.air[z.id];
    if (on && !airSaid[z.id]) {
      airSaid[z.id] = true;
      if (feed.items.some(i => i.src === 'air' && i.region === z.id && i.level === 'yellow' && now - i.time < 12 * 3600e3 && !feed.items.some(j => j.src === 'air' && j.region === z.id && j.level === 'green' && j.time > i.time))) continue;   // та сама тривога, застосунок перезапускали
      add({ src: 'air', level: 'yellow', region: z.id, key: 'air:' + z.id + ':' + Math.floor(now / 6e5), text: t('airOn', oblastName(z.id)) + (on.part ? ' ' + t('airPart') : '') });
    }
  }
  for (const id of Object.keys(airSaid)) if (!feed.air[id]) {
    delete airSaid[id];
    if (zone.some(z => z.id === id)) add({ src: 'air', level: 'green', region: id, key: 'airoff:' + id + ':' + Math.floor(now / 6e5), text: t('airOff', oblastName(id)) });
  }
}
let airBusy = false;
export async function pollAir() {
  if (airBusy || !S.air || !online()) return;
  if (!isNative && !S.alertsToken) { feed.airErr = 'web'; return; }
  airBusy = true;
  try {
    feed.air = await fetchAir(); feed.airAt = Date.now(); feed.airErr = '';
    airCheck();
  } catch (e) { feed.airErr = e.message; log('warn', 'тривоги: ' + e.message); }
  airBusy = false; bus.emit('feed', feed);
}

/* ---------- стан для шторки ---------- */
export function strip() {
  const { main } = feedLists();
  const c = { red: 0, yellow: 0, green: 0 }; for (const [i] of main) c[i.level]++;
  const [top, r] = main[0] || [null, null];
  return { top, label: top ? relLabel(top, r) : '', counts: c, unseen: main.filter(([i]) => !i.seen).length };
}
export function markSeen() { let ch = false; for (const i of feed.items) if (!i.seen) { i.seen = true; ch = true; } if (ch) { save(); bus.emit('feed', feed); } }
export function clearFeed() { feed.items = []; save(); bus.emit('feed', feed); }

export async function init() {
  const st = await db.get('kv', 'feed');
  if (st) { feed.items = (st.items || []).filter(i => Date.now() - i.time < 24 * 3600e3); seenKeys = new Set(st.seen || []); }
  for (const i of feed.items) { if (i.said === undefined) i.said = i.time; i.aiWait = false; }    // записи з попередніх версій уже сказані
  bus.on('route', () => { relSig = ''; setTimeout(watch, 1500); });
  setInterval(watch, 10000);
  bus.on('feedPush', it => add(it, it.quiet));
  if ((S.chDefVer || 0) < CH_DEF_VER) { addDefaultChannels(); S.chDefVer = CH_DEF_VER; S.channelsSeeded = true; }
  bus.emit('feed', feed);
  const loop = async () => {
    if (S.lookahead) { await updateHere(); if (S.air) await pollAir(); if (S.tg) await pollTelegram(); }
  };
  setTimeout(loop, 8000);
  setInterval(loop, 180000);
}
