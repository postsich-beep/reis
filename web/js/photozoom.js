// Перегляд фото перевіреного місця (1.1.24): збільшення двома пальцями, зсув одним, подвійний дотик — збільшити / повернути.
// Сторінка масштабуватись не вміє (так задумано — карта має свої жести), тому фото збільшуємо самі: рахуємо масштаб і зсув
// із дотиків і застосовуємо до картинки. Поки фото збільшене, стрічка фото не гортається (палець рухає фото);
// повернули до звичайного розміру — гортається знову.
export const ZOOM = { MAX: 5, DOUBLE: 2.6, TAP_MS: 320, TAP_PX: 28 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Чиста логіка одного фото: s — масштаб (1 — як є), tx/ty — зсув у пікселях від центру кадру розміром w×h. */
export function zoomState(w, h) {
  const z = { s: 1, tx: 0, ty: 0, w, h };
  const fit = () => { const mx = (z.s - 1) * z.w / 2, my = (z.s - 1) * z.h / 2; z.tx = clamp(z.tx, -mx, mx); z.ty = clamp(z.ty, -my, my); if (z.s <= 1.02) { z.s = 1; z.tx = z.ty = 0; } return z; };
  return {
    z,
    /** Щипок: s0, t0 — стан на початку жесту; m0 — середина між пальцями на початку, m — зараз (від центру кадру); k — у скільки разів розійшлись пальці. */
    pinch(s0, t0, m0, m, k) { const s = clamp(s0 * k, 1, ZOOM.MAX), cx = (m0[0] - t0[0]) / s0, cy = (m0[1] - t0[1]) / s0; z.s = s; z.tx = m[0] - cx * s; z.ty = m[1] - cy * s; return fit(); },
    /** Зсув одним пальцем (лише коли збільшено). */
    pan(t0, d) { if (z.s <= 1) return z; z.tx = t0[0] + d[0]; z.ty = t0[1] + d[1]; return fit(); },
    /** Подвійний дотик у точці p (від центру кадру): збільшити так, щоб ця точка лишилась під пальцем, або повернути. */
    dbl(p) { if (z.s > 1) { z.s = 1; z.tx = z.ty = 0; } else { z.s = ZOOM.DOUBLE; z.tx = p[0] * (1 - z.s); z.ty = p[1] * (1 - z.s); } return fit(); },
    reset() { z.s = 1; z.tx = z.ty = 0; return z; }
  };
}

/** Прив'язати жести до стрічки фото: root — #photoView, у ньому .pv-strip із кадрами .pv-slide > img. */
export function bindPhotoZoom(root) {
  const strip = root.querySelector('.pv-strip'); if (!strip) return;
  let cur = null, g = null, lastTap = null;
  const stOf = slide => slide._z || (slide._z = zoomState(slide.clientWidth, slide.clientHeight));
  const rel = (slide, t) => { const r = slide.getBoundingClientRect(); return [t.clientX - r.left - r.width / 2, t.clientY - r.top - r.height / 2]; };
  const draw = slide => { const z = stOf(slide).z, im = slide.querySelector('img'); im.style.transform = z.s === 1 ? '' : `translate(${z.tx.toFixed(1)}px,${z.ty.toFixed(1)}px) scale(${z.s.toFixed(3)})`;
    root.classList.toggle('zoomed', z.s > 1 || !!(g && g.two)); slide.dataset.zoom = z.s.toFixed(2); };
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  strip.addEventListener('touchstart', e => {
    const slide = e.target.closest('.pv-slide'); if (!slide) return;
    cur = slide; const S = stOf(slide); S.z.w = slide.clientWidth; S.z.h = slide.clientHeight;
    if (e.touches.length === 2) { const a = e.touches[0], b = e.touches[1]; g = { two: true, s0: S.z.s, t0: [S.z.tx, S.z.ty], d0: Math.max(1, dist(a, b)), m0: rel(slide, { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }) }; root.classList.add('zoomed'); e.preventDefault(); }      // два пальці — стрічка одразу стоїть
    else if (e.touches.length === 1) { const p = rel(slide, e.touches[0]); g = { two: false, t0: [S.z.tx, S.z.ty], p0: p, moved: false, at: Date.now() }; }
  }, { passive: false });
  strip.addEventListener('touchmove', e => {
    if (!cur || !g) return; const S = stOf(cur);
    if (g.two && e.touches.length >= 2) { const a = e.touches[0], b = e.touches[1]; S.pinch(g.s0, g.t0, g.m0, rel(cur, { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }), dist(a, b) / g.d0); draw(cur); e.preventDefault(); }
    else if (!g.two && e.touches.length === 1) { const p = rel(cur, e.touches[0]), d = [p[0] - g.p0[0], p[1] - g.p0[1]]; if (Math.hypot(d[0], d[1]) > 8) g.moved = true;
      if (S.z.s > 1) { S.pan(g.t0, d); draw(cur); e.preventDefault(); } }
  }, { passive: false });
  strip.addEventListener('touchend', e => {
    if (!cur || !g) return; const S = stOf(cur);
    if (e.touches.length === 1 && g.two) { const p = rel(cur, e.touches[0]); g = { two: false, t0: [S.z.tx, S.z.ty], p0: p, moved: true, at: 0 }; return; }      // один палець лишився — далі це зсув
    if (e.touches.length) return;
    if (!g.two && !g.moved && Date.now() - g.at < 300) {                 // короткий дотик без руху: другий поспіль у тому ж місці — подвійний
      const now = Date.now(), p = g.p0;
      if (lastTap && lastTap.slide === cur && now - lastTap.t < ZOOM.TAP_MS && Math.hypot(p[0] - lastTap.p[0], p[1] - lastTap.p[1]) < ZOOM.TAP_PX) { S.dbl(p); draw(cur); lastTap = null; e.preventDefault(); }
      else lastTap = { t: now, p, slide: cur };
    }
    g = null; draw(cur);
  }, { passive: false });
  // перегорнули на інше фото — попереднє повертаємо до звичайного розміру
  strip.addEventListener('scroll', () => { for (const sl of strip.querySelectorAll('.pv-slide')) if (sl !== cur && sl._z && sl._z.z.s > 1) { sl._z.reset(); draw(sl); } }, { passive: true });
}
