// Текст для якісного українського голосу (Piper «ukrainian_tts»): модель читає лише літери, тож
// числа, одиниці, номери трас, скорочення й латиницю переписуємо словами. Системний голос телефону
// таке теж прочитає правильно, тож якщо якісний голос не спрацює, нічого не зламається.

const ONES_M = ['нуль', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const ONES_F = ['нуль', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const TEENS = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
const TENS = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"];
const HUNDREDS = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"];

// 1 — перша форма, 2–4 — друга, 5–20 і решта — третя (кілометр / кілометри / кілометрів)
export const plural = (n, f) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? f[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? f[1] : f[2]; };

function upTo999(n, fem) {
  const out = [], h = Math.floor(n / 100), r = n % 100;
  if (h) out.push(HUNDREDS[h]);
  if (r >= 10 && r < 20) out.push(TEENS[r - 10]);
  else { const t = Math.floor(r / 10), o = r % 10; if (t) out.push(TENS[t]); if (o) out.push((fem ? ONES_F : ONES_M)[o]); }
  return out.join(' ');
}
export function numWords(n, fem = false) {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'нуль';
  if (n >= 1e9) return String(n).split('').map(d => ONES_M[+d]).join(' ');
  const out = [], mil = Math.floor(n / 1e6), th = Math.floor(n / 1000) % 1000, rest = n % 1000;
  if (mil) out.push(upTo999(mil, false), plural(mil, ['мільйон', 'мільйони', 'мільйонів']));
  if (th) out.push(th === 1 ? 'тисяча' : upTo999(th, true) + ' ' + plural(th, ['тисяча', 'тисячі', 'тисяч']));
  if (rest) out.push(upTo999(rest, fem));
  return out.join(' ');
}

// одиниці: [форми для 1 / 2–4 / 5+, родовий однини (після дробу), жіночий рід]
const NL = '(?![\\p{L}])';                                     // кінець слова (з кирилицею \\b не працює)
const UNITS = [
  [new RegExp('^км\\/(?:год|ч)' + NL, 'iu'), ['кілометр на годину', 'кілометри на годину', 'кілометрів на годину'], 'кілометра на годину', false],
  [new RegExp('^км' + NL, 'iu'), ['кілометр', 'кілометри', 'кілометрів'], 'кілометра', false],
  [new RegExp('^м' + NL + '(?!\\.)', 'iu'), ['метр', 'метри', 'метрів'], 'метра', false],
  [new RegExp('^т' + NL, 'iu'), ['тонна', 'тонни', 'тонн'], 'тонни', true],
  [new RegExp('^хв' + NL, 'iu'), ['хвилина', 'хвилини', 'хвилин'], 'хвилини', true],
  [new RegExp('^год' + NL, 'iu'), ['година', 'години', 'годин'], 'години', true],
  [/^°/u, ['градус', 'градуси', 'градусів'], 'градуса', false],
  [/^%/u, ['відсоток', 'відсотки', 'відсотків'], 'відсотка', false],
  [new RegExp('^грн' + NL, 'iu'), ['гривня', 'гривні', 'гривень'], 'гривні', true]
];
const FEM_NEXT = /^\s*(хвилин|годин|тонн|тисяч|гривн|доб|секунд|машин|фур)/iu;
const ACC_NEXT = /^\s*(хвилину|годину|тонну|добу|секунду|машину|фуру)(?![\p{L}])/iu;   // «через 21 хвилину» — «одну»

// назви літер для номерів доріг і скорочень
const LETTER = { А: 'а', Б: 'бе', В: 'ве', Г: 'ге', Ґ: 'ґе', Д: 'де', Е: 'е', Є: 'є', Ж: 'же', З: 'зе', И: 'и', І: 'і', Ї: 'ї', Й: 'й', К: 'ка', Л: 'ел', М: 'ем', Н: 'ен', О: 'о', П: 'пе', Р: 'ер', С: 'ес', Т: 'те', У: 'у', Ф: 'еф', Х: 'ха', Ц: 'це', Ч: 'че', Ш: 'ша', Щ: 'ща', Ю: 'ю', Я: 'я',
  A: 'а', B: 'бі', C: 'сі', D: 'ді', E: 'і', F: 'еф', G: 'джі', H: 'ейч', I: 'ай', J: 'джей', K: 'кей', L: 'ел', M: 'ем', N: 'ен', O: 'о', P: 'пі', Q: "к'ю", R: 'ар', S: 'ес', T: 'ті', U: 'ю', V: 'ві', W: 'дабл ю', X: 'екс', Y: 'вай', Z: 'зет' };
const ABBR = { 'ДТП': 'де те пе', 'АЗС': 'а зе ес', 'СТО': 'ес те о', 'ЗСУ': 'зе ес у', 'ППО': 'пе пе о', 'БПЛА': 'бе пе ел а', 'ДСНС': 'де ес ен ес', 'ДАІ': 'да і', 'ПММ': 'пе ем ем', 'БРСМ': 'бе ер ес ем',
  'вул.': 'вулиця', 'просп.': 'проспект', 'пров.': 'провулок', 'пл.': 'площа', 'обл.': 'область', 'р-н': 'район', 'бульв.': 'бульвар', 'с-ще': 'селище', 'смт': 'селище міського типу', '№': 'номер' };
const BRANDS = { okko: 'окко', wog: 'вог', upg: 'ю пі джі', socar: 'сокар', shell: 'шелл', klo: 'кло', amic: 'амік', avias: 'авіас', glusco: 'глуско', motto: 'мотто', anp: 'а ен пе', brsm: 'бе ер ес ем', ovis: 'овіс', marshal: 'маршал', parallel: 'паралель', ukrnafta: 'укрнафта' };
const LAT = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'і', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'і', z: 'з' };

// номер траси: М-03 → «ем нуль три», Н-31 → «ен тридцять один», Т-2101 → «те двадцять один нуль один», E40 → «е сорок»
function roadNum(d) {
  if (d.length === 4) return roadNum(d.slice(0, 2)) + ' ' + roadNum(d.slice(2));
  if (d[0] === '0') return 'нуль ' + (d.length > 1 ? roadNum(d.slice(1)) : '').trim();
  return numWords(+d);
}

export function ukSpeech(input) {
  let s = String(input || '');
  // траси
  s = s.replace(/(^|[^\p{L}])([МНРТЕEMH])\s?-?\s?(\d{1,4})(?!\d)/gu, (m, pre, L, d) => `${pre}${LETTER[L === 'E' ? 'Е' : L === 'M' ? 'М' : L === 'H' ? 'Н' : L]} ${roadNum(d)}`);
  // час 18:05 → «вісімнадцять нуль п'ять»
  s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (m, h, mi) => `${numWords(+h, true)} ${mi === '00' ? 'нуль нуль' : mi[0] === '0' ? 'нуль ' + numWords(+mi[1]) : numWords(+mi)}`);
  // скорочення
  for (const [k, v] of Object.entries(ABBR)) s = s.replace(new RegExp((/^[\p{L}]/u.test(k) ? '(?<![\\p{L}])' : '') + k.replace(/\./g, '\\.') + '(?![\\p{L}])', 'gu'), v);
  // числа з одиницями (дробові: 1,5 км → «півтора кілометра», 2,5 → «два з половиною кілометри», 3,2 → «три кома два кілометра»)
  s = s.replace(/(\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[,.](\d+))?(\s*)([^\s\d]*)/gu, (m, a, frac, sp, rest) => {
    const n = +a.replace(/\s/g, ''); let unit = null, tail = rest;
    for (const [re, forms, gen, fem] of UNITS) { const mm = rest.match(re); if (mm) { unit = { forms, gen, fem }; tail = rest.slice(mm[0].length); break; } }
    const femNext = !unit && FEM_NEXT.test(sp + rest);
    let words;
    if (frac != null) {
      if (frac === '5' && n === 1) words = unit ? (unit.fem ? 'півтори ' : 'півтора ') + unit.gen : 'півтора';
      else if (frac === '5') words = numWords(n, unit ? unit.fem : femNext) + ' з половиною' + (unit ? ' ' + plural(n, unit.forms) : '');
      else words = numWords(n, true) + ' кома ' + (frac.length <= 2 ? numWords(+frac) : frac.split('').map(x => ONES_M[+x]).join(' ')) + (unit ? ' ' + unit.gen : '');
    } else words = numWords(n, unit ? unit.fem : femNext) + (unit ? ' ' + plural(n, unit.forms) : '');
    if (!unit && frac == null && ACC_NEXT.test(sp + rest)) words = words.replace(/одна$/, 'одну');
    return words + (unit ? tail : sp + rest);
  });
  // одиниці без числа
  s = s.replace(/(?<![\p{L}])км\/год(?![\p{L}])/gu, 'кілометрів на годину').replace(/(?<![\p{L}])км(?![\p{L}])/gu, 'кілометрів');
  // абревіатури великими літерами (2–4 літери) — по літерах; латиниця — назви мереж або транслітерація
  s = s.replace(/(?<![\p{L}])([А-ЯҐЄІЇ]{2,4})(?![\p{L}])/gu, (m, w) => ABBR[w] || (/[АЕЄИІЇОУЮЯ]/.test(w.slice(1, -1)) && w.length > 3 ? w : w.split('').map(c => LETTER[c] || c).join(' ')));
  s = s.replace(/[A-Za-z]+/g, w => BRANDS[w.toLowerCase()] || (w.length <= 3 && w === w.toUpperCase() ? w.split('').map(c => LETTER[c] || c).join(' ') : w.toLowerCase().split('').map(c => LAT[c] || '').join('')));
  // що лишилось із цифр — по одній
  s = s.replace(/\d/g, d => ' ' + ONES_M[+d] + ' ');
  // розділові знаки й лапки, апостроф, нижній регістр, NFD (модель вчилась на розкладених «й» = «и» + ̆, «ї» = «і» + ̈)
  s = s.replace(/[«»"„“”()\[\]]/g, '').replace(/[’ʼ`´]/g, "'").replace(/[–]/g, '—').replace(/\s*\/\s*/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s+([,.!?:;])/g, '$1');
  s = s.replace(/[^\p{L}\p{M}'\s,.!?:;—-]/gu, ' ').replace(/\s+/g, ' ').replace(/\s+([,.!?:;])/g, '$1');   // зірочки, значки — геть
  return s.trim().toLowerCase().normalize('NFD');
}
