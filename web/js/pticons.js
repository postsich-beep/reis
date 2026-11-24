// Значки точок рейсу (1.1.12) замість літер А · Б · С: старт — зелений прапорець, через — кільце, фініш — картатий прапор.
// Окремий файл без залежностей: значки потрібні і карті (мітки), і панелям.
const S = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const PT_SVG = {
  a: S('<path d="M7 21V3.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M7 4.2 19.5 9 7 13.8Z" fill="#fff"/>'),
  v: S('<circle cx="12" cy="12" r="6.2" fill="none" stroke="#fff" stroke-width="2.8"/><circle cx="12" cy="12" r="2" fill="#fff"/>'),
  b: S('<path d="M5.5 21V3.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M5.5 4h14v10h-14Z" fill="#fff"/>'
    + '<path d="M5.5 4h3.5v3.3H5.5ZM12.5 4H16v3.3h-3.5ZM9 7.3h3.5v3.4H9ZM16 7.3h3.5v3.4H16ZM5.5 10.7H9V14H5.5ZM12.5 10.7H16V14h-3.5Z" fill="#13171c"/>'),
  // «Я тут» (1.1.22) — та сама стрілка, якою машину показано на карті: «поставити мене сюди»
  me: S('<path d="M12 3 19.8 20.6 12 16.6 4.2 20.6Z" fill="#fff"/>')
};
export const PT_KEYS = ['a', 'v', 'b'];
/** Кольорова табличка зі значком: cls — розмір/місце (tag, rp-t…). */
export const ptTag = (k, cls = 'pt') => `<i class="${cls} ${k}">${PT_SVG[k]}</i>`;
