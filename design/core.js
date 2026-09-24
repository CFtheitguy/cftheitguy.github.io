/* Linear Design — core: the document model's drawing code, shared by the
 * editor, the template thumbnails and export, so what you see is what you get.
 *
 * A page is {bg, els}. Every element has a box (x, y, w, h in page pixels)
 * plus a rotation about the box centre; each type draws itself inside
 * 0..w × 0..h. Text boxes have no free height: h is always what the text
 * wraps to, recomputed by syncText() whenever anything that affects it changes.
 */
'use strict';
(() => {

// ---------------------------------------------------------------- fonts
// System fonts only. The page's CSP names no remote host, so there is nothing
// to download; every stack falls back to something close on every OS.
const FONTS = [
  ['Sans', 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'],
  ['Helvetica', '"Helvetica Neue", Helvetica, Arial, sans-serif'],
  ['Arial Black', '"Arial Black", "Helvetica Neue", Arial, sans-serif'],
  ['Impact', 'Impact, Haettenschweiler, "Arial Narrow Bold", "Arial Black", sans-serif'],
  ['Futura', 'Futura, "Century Gothic", "Avenir Next", "Trebuchet MS", sans-serif'],
  ['Gill Sans', '"Gill Sans", "Gill Sans MT", Calibri, "Trebuchet MS", sans-serif'],
  ['Trebuchet', '"Trebuchet MS", "Segoe UI", Tahoma, sans-serif'],
  ['Verdana', 'Verdana, Geneva, Tahoma, sans-serif'],
  ['Optima', 'Optima, Candara, "Segoe UI", sans-serif'],
  ['Georgia', 'Georgia, "Times New Roman", serif'],
  ['Palatino', '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif'],
  ['Didot', 'Didot, "Bodoni 72", "Bodoni MT", "Times New Roman", serif'],
  ['Garamond', 'Garamond, "EB Garamond", Baskerville, "Times New Roman", serif'],
  ['Rockwell', 'Rockwell, "Rockwell Nova", "Roboto Slab", "Courier New", serif'],
  ['Copperplate', 'Copperplate, "Copperplate Gothic Light", "Palatino Linotype", serif'],
  ['Typewriter', '"American Typewriter", "Courier New", Courier, monospace'],
  ['Mono', 'ui-monospace, Menlo, Consolas, "Courier New", monospace'],
  ['Script', '"Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", cursive'],
  ['Brush', '"Brush Script MT", "Bradley Hand", "Segoe Print", cursive'],
  ['Marker', '"Marker Felt", "Comic Sans MS", "Chalkboard SE", "Segoe Print", cursive'],
];
const fontStack = name => (FONTS.find(f => f[0] === name) || FONTS[0])[1];
const custom = new Map();   // fonts the user loaded from a file: name -> family
function fontFamily(name) { return custom.has(name) ? `"${custom.get(name)}", sans-serif` : fontStack(name); }

// ---------------------------------------------------------------- utils
let uidN = Date.now() % 1e6;
const uid = () => 'e' + (uidN++).toString(36);
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function hexRgb(h) {
  h = String(h || '#000').replace('#', '');
  if (h.length === 3) h = h.replace(/./g, c => c + c);
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function rgba(h, a) { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; }
function lum(h) { const [r, g, b] = hexRgb(h).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * r + .7152 * g + .0722 * b; }
function mix(a, b, t) { const A = hexRgb(a), B = hexRgb(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); }

// ---------------------------------------------------------------- text
const mctx = document.createElement('canvas').getContext('2d');
function fontCss(el, size) {
  return `${el.italic ? 'italic ' : ''}${el.weight || 400} ${size || el.size}px ${fontFamily(el.font)}`;
}
function measure(ctx, s, ls) {
  const w = ctx.measureText(s).width;
  return ls ? w + ls * Math.max(0, [...s].length - 1) : w;
}
// Wrap text to the box width. Paragraphs split on \n; a word wider than the
// box is broken by character so nothing ever spills out sideways.
function textLines(el, w) {
  const ctx = mctx; ctx.font = fontCss(el);
  const ls = (el.ls || 0) * el.size;
  const maxW = Math.max(1, w == null ? el.w : w);
  const src = el.upper ? String(el.text).toUpperCase() : String(el.text);
  const out = [];
  for (const para of src.split('\n')) {
    const words = para.split(/ +/);
    let line = '';
    for (let word of words) {
      const trial = line ? line + ' ' + word : word;
      if (measure(ctx, trial, ls) <= maxW || !line && measure(ctx, word, ls) <= maxW) { line = trial; continue; }
      if (line) out.push(line);
      line = '';
      while (measure(ctx, word, ls) > maxW && word.length > 1) {
        let i = word.length - 1;
        while (i > 1 && measure(ctx, word.slice(0, i), ls) > maxW) i--;
        out.push(word.slice(0, i)); word = word.slice(i);
      }
      line = word;
    }
    out.push(line);
  }
  return out;
}
function textHeight(el, lines) { return Math.max(1, (lines || textLines(el)).length * el.size * (el.lh || 1.2)); }
function syncText(el) { if (el.type === 'text') el.h = textHeight(el); return el; }
// Widest line — used to shrink a box to its text.
function textWidth(el) {
  mctx.font = fontCss(el);
  const ls = (el.ls || 0) * el.size;
  return Math.max(...textLines(el, 1e6).map(l => measure(mctx, l, ls)));
}
// Largest size (≤ el.size) at which the text fits maxW without breaking a
// word, in at most maxLines lines and maxH height. Used by the templates.
function fitText(el, maxW, maxH, maxLines, minSize) {
  el.w = maxW;
  let s = el.size;
  const floor = minSize || 8;
  for (let guard = 0; guard < 60; guard++) {
    el.size = s;
    const lines = textLines(el);
    const words = (el.upper ? el.text.toUpperCase() : el.text).split(/\s+/);
    mctx.font = fontCss(el);
    const ls = (el.ls || 0) * s;
    const broke = words.some(wd => measure(mctx, wd, ls) > maxW);
    if (!broke && (!maxLines || lines.length <= maxLines) && (!maxH || textHeight(el, lines) <= maxH)) break;
    if (s <= floor) break;
    s = Math.max(floor, s * 0.92);
  }
  el.size = Math.round(el.size * 10) / 10;
  return syncText(el);
}

// ---------------------------------------------------------------- paint
// A fill is a colour string, 'none', or a gradient {g:'linear'|'radial', a:deg, c:[c1,c2(,c3)]}.
function paint(ctx, fill, w, h) {
  if (!fill || fill === 'none') return null;
  if (typeof fill === 'string') return fill;
  const c = fill.c || ['#000', '#fff'];
  let g;
  if (fill.g === 'radial') {
    g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
  } else {
    const a = (fill.a || 0) * Math.PI / 180, dx = Math.cos(a), dy = Math.sin(a);
    const len = Math.abs(w * dx) + Math.abs(h * dy);
    g = ctx.createLinearGradient(w / 2 - dx * len / 2, h / 2 - dy * len / 2, w / 2 + dx * len / 2, h / 2 + dy * len / 2);
  }
  c.forEach((col, i) => g.addColorStop(c.length === 1 ? 0 : i / (c.length - 1), col));
  return g;
}
function fillColor(fill) { return !fill || fill === 'none' ? '#000000' : typeof fill === 'string' ? fill : fill.c[0]; }

// ---------------------------------------------------------------- shapes
function roundRect(p, x, y, w, h, r) {
  r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  p.moveTo(x + r, y); p.lineTo(x + w - r, y); p.arcTo(x + w, y, x + w, y + r, r);
  p.lineTo(x + w, y + h - r); p.arcTo(x + w, y + h, x + w - r, y + h, r);
  p.lineTo(x + r, y + h); p.arcTo(x, y + h, x, y + h - r, r);
  p.lineTo(x, y + r); p.arcTo(x, y, x + r, y, r); p.closePath();
}
function poly(p, pts) { pts.forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y)); p.closePath(); }
function regular(w, h, n, rot) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = rot + i * 2 * Math.PI / n; pts.push([Math.cos(a), Math.sin(a)]); }
  return fitPts(pts, w, h);
}
function fitPts(pts, w, h) {   // stretch unit points to fill the box exactly
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return pts.map(([x, y]) => [(x - x0) / (x1 - x0 || 1) * w, (y - y0) / (y1 - y0 || 1) * h]);
}
function starPts(w, h, n, inner) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) { const r = i % 2 ? inner : 1, a = -Math.PI / 2 + i * Math.PI / n; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return fitPts(pts, w, h);
}
function smoothClosed(p, pts) {   // Catmull-Rom through the points, closed
  const n = pts.length;
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    p.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  p.closePath();
}
const SHAPES = [
  ['rect', 'Square'], ['round', 'Rounded'], ['ellipse', 'Circle'], ['triangle', 'Triangle'], ['rtriangle', 'Right triangle'],
  ['diamond', 'Diamond'], ['pentagon', 'Pentagon'], ['hexagon', 'Hexagon'], ['octagon', 'Octagon'], ['star', 'Star'],
  ['star4', 'Sparkle'], ['burst', 'Burst'], ['badge', 'Seal'], ['heart', 'Heart'], ['arrow', 'Arrow'], ['chevron', 'Chevron'],
  ['plus', 'Plus'], ['bubble', 'Speech bubble'], ['arch', 'Arch'], ['half', 'Half circle'], ['quarter', 'Quarter circle'],
  ['parallelogram', 'Slant'], ['trapezoid', 'Trapezoid'], ['ribbon', 'Ribbon'], ['blob', 'Blob'], ['wave', 'Wave'],
  ['ring', 'Ring'], ['frame', 'Frame'], ['line', 'Line'], ['dashed', 'Dashed line'], ['arrowline', 'Arrow line'], ['cloud', 'Cloud'],
];
function shapePath(el) {
  const { w, h } = el, p = new Path2D(), k = el.shape;
  switch (k) {
    case 'rect': roundRect(p, 0, 0, w, h, el.radius || 0); break;
    case 'round': roundRect(p, 0, 0, w, h, el.radius != null ? el.radius : Math.min(w, h) * .18); break;
    case 'ellipse': case 'ring': p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'triangle': poly(p, [[w / 2, 0], [w, h], [0, h]]); break;
    case 'rtriangle': poly(p, [[0, 0], [w, h], [0, h]]); break;
    case 'diamond': poly(p, [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]); break;
    case 'pentagon': poly(p, regular(w, h, 5, -Math.PI / 2)); break;
    case 'hexagon': poly(p, regular(w, h, 6, 0)); break;
    case 'octagon': poly(p, regular(w, h, 8, Math.PI / 8)); break;
    case 'star': poly(p, starPts(w, h, el.points || 5, el.inner || .45)); break;
    case 'star4': poly(p, starPts(w, h, 4, .28)); break;
    case 'burst': poly(p, starPts(w, h, el.points || 16, .8)); break;
    case 'badge': {
      const n = 28, pts = [];
      for (let i = 0; i < n * 2; i++) { const a = i * Math.PI / n, r = i % 2 ? .93 : 1; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
      smoothClosed(p, fitPts(pts, w, h)); break;
    }
    case 'heart':
      p.moveTo(w / 2, h * .28);
      p.bezierCurveTo(w * .5, h * .08, w * .08, 0, w * .02, h * .3);
      p.bezierCurveTo(-w * .04, h * .58, w * .3, h * .76, w / 2, h);
      p.bezierCurveTo(w * .7, h * .76, w * 1.04, h * .58, w * .98, h * .3);
      p.bezierCurveTo(w * .92, 0, w * .5, h * .08, w / 2, h * .28); p.closePath(); break;
    case 'arrow': poly(p, [[0, h * .3], [w * .62, h * .3], [w * .62, 0], [w, h / 2], [w * .62, h], [w * .62, h * .7], [0, h * .7]]); break;
    case 'chevron': poly(p, [[0, 0], [w * .7, 0], [w, h / 2], [w * .7, h], [0, h], [w * .3, h / 2]]); break;
    case 'plus': { const t = Math.min(w, h) * .32; poly(p, [[w / 2 - t / 2, 0], [w / 2 + t / 2, 0], [w / 2 + t / 2, h / 2 - t / 2], [w, h / 2 - t / 2], [w, h / 2 + t / 2], [w / 2 + t / 2, h / 2 + t / 2], [w / 2 + t / 2, h], [w / 2 - t / 2, h], [w / 2 - t / 2, h / 2 + t / 2], [0, h / 2 + t / 2], [0, h / 2 - t / 2], [w / 2 - t / 2, h / 2 - t / 2]]); break; }
    case 'bubble': {
      const bh = h * .8, r = Math.min(w, bh) * .2;
      p.moveTo(r, 0); p.lineTo(w - r, 0); p.arcTo(w, 0, w, r, r); p.lineTo(w, bh - r); p.arcTo(w, bh, w - r, bh, r);
      p.lineTo(w * .38, bh); p.lineTo(w * .18, h); p.lineTo(w * .22, bh); p.lineTo(r, bh); p.arcTo(0, bh, 0, bh - r, r);
      p.lineTo(0, r); p.arcTo(0, 0, r, 0, r); p.closePath(); break;
    }
    case 'arch': { const r = w / 2; p.moveTo(0, h); p.lineTo(0, Math.min(r, h)); p.ellipse(w / 2, Math.min(r, h), r, Math.min(r, h), 0, Math.PI, 0); p.lineTo(w, h); p.closePath(); break; }
    case 'half': p.moveTo(0, h); p.ellipse(w / 2, h, w / 2, h, 0, Math.PI, 0); p.closePath(); break;
    case 'quarter': p.moveTo(0, h); p.lineTo(0, 0); p.ellipse(0, h, w, h, 0, -Math.PI / 2, 0); p.closePath(); break;
    case 'parallelogram': poly(p, [[w * .22, 0], [w, 0], [w * .78, h], [0, h]]); break;
    case 'trapezoid': poly(p, [[w * .2, 0], [w * .8, 0], [w, h], [0, h]]); break;
    case 'ribbon': { const e = Math.min(w * .12, h * .8); poly(p, [[0, 0], [w, 0], [w - e, h / 2], [w, h], [0, h], [e, h / 2]]); break; }
    case 'blob': {
      const r = rng(el.seed || 7), n = 7, pts = [];
      for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n, d = .72 + r() * .28; pts.push([Math.cos(a) * d, Math.sin(a) * d]); }
      smoothClosed(p, fitPts(pts, w, h)); break;
    }
    case 'wave': {
      const n = el.points || 2, amp = h * .18;
      p.moveTo(0, h); p.lineTo(0, amp);
      for (let i = 0; i < n; i++) { const x0 = i * w / n, x1 = (i + 1) * w / n; p.bezierCurveTo(x0 + (x1 - x0) * .35, -amp * .6, x0 + (x1 - x0) * .65, amp * 2.6, x1, amp); }
      p.lineTo(w, h); p.closePath(); break;
    }
    case 'frame': { const t = Math.min(w, h) * (el.inner || .12); p.rect(0, 0, w, h); p.rect(t, t, w - 2 * t, h - 2 * t); break; }
    case 'cloud': {
      const bumps = [[.25, .62, .22], [.45, .42, .28], [.7, .5, .24], [.84, .68, .16], [.5, .7, .25]];
      bumps.forEach(([cx0, cy0, r]) => { p.moveTo(cx0 * w + r * w, cy0 * h); p.ellipse(cx0 * w, cy0 * h, r * w, r * h * 1.3, 0, 0, Math.PI * 2); });
      break;
    }
    case 'line': case 'dashed': case 'arrowline': p.moveTo(0, h / 2); p.lineTo(w, h / 2); break;
    default: p.rect(0, 0, w, h);
  }
  return p;
}
const isLine = el => el.type === 'shape' && (el.shape === 'line' || el.shape === 'dashed' || el.shape === 'arrowline');

// ---------------------------------------------------------------- icons (24×24 stroke paths)
const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  heart: 'M12 20s-7-4.4-9.2-8.6C1.4 8.6 3 5 6.5 5c2 0 3.5 1.2 5.5 3.2C14 6.2 15.5 5 17.5 5 21 5 22.6 8.6 21.2 11.4 19 15.6 12 20 12 20z',
  phone: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  pin: 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12zM14.5 9a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v5M16 3v5',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2',
  check: 'M4 12.5l5 5L20 6.5',
  checkcircle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8 12.5l2.8 2.8L16.5 9.5',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M4 12h16M14 6l6 6-6 6',
  arrowupright: 'M7 17L17 7M8 7h9v9',
  cart: 'M3 4h2.5l2.2 11h10.8l2-8H6.4M10 20a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0zM18.5 20a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0z',
  bag: 'M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2',
  tag: 'M3 12V3h9l9 9-9 9zM9 7.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  gift: 'M4 10h16v11H4zM3 7h18v3H3zM12 7v14M12 7c-1.5-3-5-3.5-5-1.2C7 7 9.5 7 12 7zM12 7c1.5-3 5-3.5 5-1.2C17 7 14.5 7 12 7z',
  cake: 'M4 21h16M5 21v-8h14v8M5 16.5c2 1.5 4.7 1.5 7 0s5 1.5 7 0M8 13V9.5M12 13V9.5M16 13V9.5M8 5.5c.8.8.8 1.8 0 2.5-.8-.7-.8-1.7 0-2.5zM12 5.5c.8.8.8 1.8 0 2.5-.8-.7-.8-1.7 0-2.5zM16 5.5c.8.8.8 1.8 0 2.5-.8-.7-.8-1.7 0-2.5z',
  balloon: 'M18 9.5c0 3.8-3 6.5-6 6.5s-6-2.7-6-6.5a6 6 0 0 1 12 0zM11 16l-1 2h4l-1-2M12 18c0 2-2 2-2 4',
  sparkle: 'M12 3c.6 4.5 2.5 6.4 7 7-4.5.6-6.4 2.5-7 7-.6-4.5-2.5-6.4-7-7 4.5-.6 6.4-2.5 7-7zM19 16c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5z',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M8 21h8',
  headphones: 'M4 18v-6a8 8 0 0 1 16 0v6M4 14h3v6H4zM17 14h3v6h-3z',
  camera: 'M3 8h4l2-3h6l2 3h4v12H3zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
  video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3z',
  film: 'M3 4h18v16H3zM7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4',
  play: 'M7 4l13 8-13 8z',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M17 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  palette: 'M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.9 1.4-1.8-.4-1.2.3-2.2 1.6-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10zM8 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM11 7.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM16 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0z',
  pencil: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3',
  coffee: 'M4 9h13v5a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3v3M12 3v3',
  utensils: 'M7 3v18M4 3v5a3 3 0 0 0 6 0V3M17 21V3c-2.5 1-4 3.5-4 7v4h4',
  pizza: 'M12 21L3 6c5.5-3 12.5-3 18 0zM5 9c4.4-2 9.6-2 14 0M11.5 12a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0zM15 15a1 1 0 1 1-2 0 1 1 0 0 1 2 0z',
  apple: 'M12 7c-1-2-5-2.5-6.5.5C4 11 6 20 9 20c1.3 0 1.8-.7 3-.7s1.7.7 3 .7c3 0 5-9 3.5-12.5C17 4.5 13 5 12 7zM12 7c0-2 1-3.5 3-4',
  leaf: 'M5 19c0-9 6-14 15-14 0 9-5 15-14 15zM5 19l8-8',
  sprout: 'M12 21v-9M12 12c0-4-3-6-7-6 0 4 3 6 7 6zM12 10c0-3.5 2.5-6 7-6 0 4-3 6-7 6z',
  tree: 'M12 3l6 8h-3l4 6H5l4-6H6zM12 17v4',
  flower: 'M12 20c-4 0-8-2-9-6 3-1 6 0 9 3 3-3 6-4 9-3-1 4-5 6-9 6zM12 17c-2-2-3-5-3-8 1.5-1 2.5-2.5 3-5 .5 2.5 1.5 4 3 5 0 3-1 6-3 8z',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  cloud: 'M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1 0 9z',
  snowflake: 'M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 3 3-3M9 20l3-3 3 3',
  umbrella: 'M3 12a9 9 0 0 1 18 0zM12 12v7a2 2 0 0 0 4 0',
  waves: 'M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2',
  mountain: 'M2 20l7-11 4 6 3-4 6 9z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  fire: 'M12 22c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5.5-5 8 0 4 3 7 7 7z',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  send: 'M21 3L3 10.5l7 3 3 7.5zM10 13.5L21 3',
  plane: 'M2 13.5l3-1 3 2 4-2.5-6-5 2.5-1 8 3.5 3.5-1.6a1.5 1.5 0 0 1 1.2 2.8L6.5 17z',
  car: 'M3 17v-5l2.5-5h13L21 12v5zM3 12h18M7 17v2M17 17v2M6 14.5h2.5M15.5 14.5H18',
  truck: 'M2 6h12v10H2zM14 10h4l3 3v3h-7zM8 17.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0zM19 17.5a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0z',
  map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15',
  dumbbell: 'M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a4 4 0 0 0 4 4M16 6h4a4 4 0 0 1-4 4M12 13v4M8 21h8M9 17h6v4H9z',
  medal: 'M8 3l2 6M16 3l-2 6M17 15a5 5 0 1 1-10 0 5 5 0 0 1 10 0zM12 12.5l.8 1.6 1.7.2-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.2z',
  ball: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 3v18M3 12h18M5.6 5.6c3.5 3.5 3.5 9.3 0 12.8M18.4 5.6c-3.5 3.5-3.5 9.3 0 12.8',
  target: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0zM13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0z',
  flag: 'M5 21V4M5 4h13l-3 4.5L18 13H5',
  cap: 'M2 9l10-5 10 5-10 5zM6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6',
  book: 'M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM4 21a2 2 0 0 1 2-2h14',
  briefcase: 'M3 8h18v12H3zM9 8V5h6v3M3 13h18',
  building: 'M4 21V3h11v18M15 9h5v12M2 21h20M8 7h3M8 11h3M8 15h3',
  store: 'M3 9l2-5h14l2 5M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM5 13v8h14v-8M10 21v-5h4v5',
  chart: 'M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  dollar: 'M12 2v20M17 6.5C16 5 14.3 4.5 12 4.5c-3 0-5 1.3-5 3.5 0 5 10 2.5 10 8 0 2.2-2 3.5-5 3.5-2.4 0-4.2-.7-5-2.3',
  percent: 'M19 5L5 19M9 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM19 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  shieldcheck: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10.5 10.5 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M13 19.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z',
  laptop: 'M5 5h14v10H5zM2 19h20l-2-4H4z',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  mobile: 'M7 2h10v20H7zM11 18h2',
  wrench: 'M15 4a5 5 0 0 0-5.6 6.6L3 17v4h4l6.4-6.4A5 5 0 0 0 20 9l-3 3-3-1-1-3z',
  user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21a8 8 0 0 1 16 0',
  users: 'M13 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM2.5 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a7 7 0 0 1 3.5 6.5',
  smile: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8 14c1 1.5 2.3 2 4 2s3-.5 4-2M10 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0zM16 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z',
  thumbsup: 'M7 10v11H3V10zM7 10l4-8c1.7 0 3 1.3 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.1 21H7',
  chat: 'M4 5h16v11H9l-5 4z',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  megaphone: 'M3 10v4h4l9 5V5l-9 5zM19 9a4 4 0 0 1 0 6M7 14l1.5 6h3L10 14',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  rocket: 'M12 15l-3-3c1.5-5 5-8.5 11-9-.5 6-4 9.5-9 11zM9 12H5l3-4h4M12 15v4l4-3v-4M6 16c-1.5 1.5-2 4-2 4s2.5-.5 4-2',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  gem: 'M6 3h12l4 6-10 12L2 9zM2 9h20M9 3l3 6 3-6M8.5 9L12 21l3.5-12',
  paw: 'M12 13c-3 0-5.5 3.5-5.5 5.5 0 1.5 1.2 2.5 2.7 2.5 1.2 0 1.8-.6 2.8-.6s1.6.6 2.8.6c1.5 0 2.7-1 2.7-2.5 0-2-2.5-5.5-5.5-5.5zM4 10.5a2 2.5 0 1 0 4 0 2 2.5 0 1 0-4 0zM7.5 6a2 2.5 0 1 0 4 0 2 2.5 0 1 0-4 0zM12.5 6a2 2.5 0 1 0 4 0 2 2.5 0 1 0-4 0zM16 10.5a2 2.5 0 1 0 4 0 2 2.5 0 1 0-4 0z',
  scissors: 'M9 7.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM9 16.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM8.5 9L20 19M8.5 15L20 5',
  scale: 'M12 3v18M7 21h10M4 7h16M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z',
  medical: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
  tshirt: 'M8 3l-5 3 2 4 2-1v12h10V9l2 1 2-4-5-3c0 1.7-1.3 3-4 3S8 4.7 8 3z',
  ticket: 'M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4zM14 7v10',
  quote: 'M4 17c3-1 5-3.5 5-7V7H4v6h3M14 17c3-1 5-3.5 5-7V7h-5v6h3',
  key: 'M14.5 4a5.5 5.5 0 1 1-3.4 9.8L4 21H2v-3l7.2-7.2A5.5 5.5 0 0 1 14.5 4zM17 8.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  spray: 'M8 9h6v12H8zM9 9V6h4v3M13 6l3-2M16 7h3M16 10l3 1M5 6h1',
  clipboard: 'M8 4h8v3H8zM6 5H5v16h14V5h-1M8 12l2.5 2.5L16 9',
  heartpulse: 'M12 20s-7-4.4-9.2-8.6C1.4 8.6 3 5 6.5 5c2 0 3.5 1.2 5.5 3.2C14 6.2 15.5 5 17.5 5 21 5 22.6 8.6 21.2 11.4 19 15.6 12 20 12 20zM3 12h5l2-3 3 6 2-3h6',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4a1.5 1.5 0 0 1 3 0v6M14 10.5V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 7-6.5 7S5 18.5 4 16l-1.2-3a1.5 1.5 0 0 1 2.7-1.3L8 15',
};
const iconCache = new Map();
function iconPath(name) {
  if (!iconCache.has(name)) iconCache.set(name, new Path2D(ICONS[name] || ICONS.star));
  return iconCache.get(name);
}

// ---------------------------------------------------------------- patterns
const PATTERNS = [['dots', 'Dots'], ['grid', 'Grid'], ['stripes', 'Stripes'], ['checker', 'Checks'], ['waves', 'Waves'], ['rings', 'Rings'],
  ['triangles', 'Triangles'], ['plus', 'Plus'], ['confetti', 'Confetti'], ['zigzag', 'Zigzag'], ['halftone', 'Halftone'], ['diagonal', 'Pinstripe']];
function drawPattern(ctx, pat, W, H) {
  if (!pat || !pat.kind) return;
  const s = (pat.scale || 1) * Math.min(W, H) / 18, col = pat.color || '#000';
  ctx.save();
  ctx.globalAlpha = pat.opacity == null ? .15 : pat.opacity;
  ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, s * .08);
  const cols = Math.ceil(W / s) + 2, rows = Math.ceil(H / s) + 2;
  const R = rng(pat.seed || 11);
  switch (pat.kind) {
    case 'dots': for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { ctx.beginPath(); ctx.arc(x * s + (y % 2) * s / 2, y * s, s * .12, 0, 7); ctx.fill(); } break;
    case 'grid': ctx.beginPath(); for (let x = 0; x < cols; x++) { ctx.moveTo(x * s, 0); ctx.lineTo(x * s, H); } for (let y = 0; y < rows; y++) { ctx.moveTo(0, y * s); ctx.lineTo(W, y * s); } ctx.stroke(); break;
    case 'stripes': ctx.lineWidth = s * .35; ctx.beginPath(); for (let i = -rows; i < cols + rows; i++) { ctx.moveTo(i * s, 0); ctx.lineTo(i * s - H, H); } ctx.stroke(); break;
    case 'diagonal': ctx.beginPath(); for (let i = -rows * 2; i < (cols + rows) * 2; i++) { ctx.moveTo(i * s / 2, 0); ctx.lineTo(i * s / 2 + H, H); } ctx.stroke(); break;
    case 'checker': for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if ((x + y) % 2) ctx.fillRect(x * s, y * s, s, s); break;
    case 'waves': ctx.lineWidth = s * .1; for (let y = 0; y < rows; y++) { ctx.beginPath(); for (let x = -1; x <= cols; x++) { const x0 = x * s; ctx.moveTo(x0, y * s); ctx.quadraticCurveTo(x0 + s / 4, y * s - s / 4, x0 + s / 2, y * s); ctx.quadraticCurveTo(x0 + 3 * s / 4, y * s + s / 4, x0 + s, y * s); } ctx.stroke(); } break;
    case 'rings': ctx.lineWidth = s * .08; for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { ctx.beginPath(); ctx.arc(x * s, y * s, s * .3, 0, 7); ctx.stroke(); } break;
    case 'triangles': for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const ox = x * s + (y % 2) * s / 2, oy = y * s; ctx.beginPath(); ctx.moveTo(ox, oy - s * .2); ctx.lineTo(ox + s * .2, oy + s * .15); ctx.lineTo(ox - s * .2, oy + s * .15); ctx.fill(); } break;
    case 'plus': ctx.lineWidth = s * .08; ctx.beginPath(); for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const ox = x * s + (y % 2) * s / 2, oy = y * s; ctx.moveTo(ox - s * .15, oy); ctx.lineTo(ox + s * .15, oy); ctx.moveTo(ox, oy - s * .15); ctx.lineTo(ox, oy + s * .15); } ctx.stroke(); break;
    case 'confetti': {
      const n = Math.round(cols * rows * .9);
      for (let i = 0; i < n; i++) { ctx.save(); ctx.translate(R() * W, R() * H); ctx.rotate(R() * 6.3); const k = R(); if (k < .4) ctx.fillRect(-s * .18, -s * .05, s * .36, s * .1); else if (k < .7) { ctx.beginPath(); ctx.arc(0, 0, s * .08, 0, 7); ctx.fill(); } else { ctx.beginPath(); ctx.moveTo(0, -s * .12); ctx.lineTo(s * .1, s * .08); ctx.lineTo(-s * .1, s * .08); ctx.fill(); } ctx.restore(); }
      break;
    }
    case 'zigzag': ctx.lineWidth = s * .1; for (let y = 0; y < rows; y++) { ctx.beginPath(); for (let x = -1; x <= cols * 2; x++) ctx[x < 0 ? 'moveTo' : 'lineTo'](x * s / 2, y * s + (x % 2 ? s * .2 : -s * .2)); ctx.stroke(); } break;
    case 'halftone': for (let y = 0; y < rows * 2; y++) for (let x = 0; x < cols * 2; x++) { const t = (x * s / 2) / W; ctx.beginPath(); ctx.arc(x * s / 2 + (y % 2) * s / 4, y * s / 2, Math.max(0, s * .2 * (1 - t)), 0, 7); ctx.fill(); } break;
  }
  ctx.restore();
}

// ---------------------------------------------------------------- images
// Filters are done on pixels rather than with ctx.filter, which older Safari
// ignores — so exports look the same everywhere. Results are cached.
const filtered = new WeakMap();
function hasFilter(f) { return f && (f.bright || f.contrast || f.sat || f.warm || f.gray || f.sepia || f.blur || f.fade || f.vignette); }
function filterKey(f) { return [f.bright, f.contrast, f.sat, f.warm, f.gray, f.sepia, f.blur, f.fade, f.vignette].join(','); }
function filteredImage(img, f) {
  if (!hasFilter(f)) return img;
  let m = filtered.get(img); if (!m) filtered.set(img, m = new Map());
  const key = filterKey(f);
  if (m.has(key)) return m.get(key);
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const k = Math.min(1, 1600 / Math.max(iw, ih));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(iw * k)); c.height = Math.max(1, Math.round(ih * k));
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  if (f.blur) boxBlur(g, c.width, c.height, Math.round(f.blur / 100 * Math.max(c.width, c.height) * .02));
  const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
  const br = (f.bright || 0) / 100 * 255 * .6, ct = 1 + (f.contrast || 0) / 100, sat = 1 + (f.sat || 0) / 100, wm = (f.warm || 0) / 100 * 40;
  const gray = (f.gray || 0) / 100, sep = (f.sepia || 0) / 100, fade = (f.fade || 0) / 100;
  for (let i = 0; i < p.length; i += 4) {
    let r = p[i], gg = p[i + 1], b = p[i + 2];
    r += br; gg += br; b += br;
    r = (r - 128) * ct + 128; gg = (gg - 128) * ct + 128; b = (b - 128) * ct + 128;
    const l = .299 * r + .587 * gg + .114 * b;
    r = l + (r - l) * sat * (1 - gray); gg = l + (gg - l) * sat * (1 - gray); b = l + (b - l) * sat * (1 - gray);
    r += wm; b -= wm;
    if (sep) { const sr = .393 * r + .769 * gg + .189 * b, sg = .349 * r + .686 * gg + .168 * b, sb = .272 * r + .534 * gg + .131 * b; r += (sr - r) * sep; gg += (sg - gg) * sep; b += (sb - b) * sep; }
    if (fade) { r = r + (200 - r) * fade * .35; gg = gg + (200 - gg) * fade * .35; b = b + (200 - b) * fade * .35; }
    p[i] = r; p[i + 1] = gg; p[i + 2] = b;
  }
  g.putImageData(d, 0, 0);
  if (f.vignette) {
    const vg = g.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * .3, c.width / 2, c.height / 2, Math.hypot(c.width, c.height) / 2);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, `rgba(0,0,0,${f.vignette / 100 * .85})`);
    g.fillStyle = vg; g.fillRect(0, 0, c.width, c.height);
  }
  m.set(key, c);
  return c;
}
function boxBlur(g, w, h, r) {
  if (r < 1) return;
  // three downscale/upscale passes approximate a gaussian without ctx.filter
  const t = document.createElement('canvas'), k = Math.max(1, r);
  t.width = Math.max(1, Math.round(w / k)); t.height = Math.max(1, Math.round(h / k));
  const tg = t.getContext('2d'); tg.imageSmoothingQuality = 'high';
  tg.drawImage(g.canvas, 0, 0, t.width, t.height);
  g.clearRect(0, 0, w, h); g.imageSmoothingQuality = 'high';
  g.drawImage(t, 0, 0, w, h);
}
const MASKS = [['none', 'None'], ['round', 'Rounded'], ['ellipse', 'Circle'], ['arch', 'Arch'], ['hexagon', 'Hexagon'], ['blob', 'Blob'], ['heart', 'Heart'], ['star', 'Star'], ['diamond', 'Diamond'], ['triangle', 'Triangle']];

// ---------------------------------------------------------------- draw
function drawElement(ctx, el, env) {
  if (el.hidden) return;
  ctx.save();
  ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
  if (el.rot) ctx.rotate(el.rot * Math.PI / 180);
  ctx.scale(el.flipX ? -1 : 1, el.flipY ? -1 : 1);
  ctx.translate(-el.w / 2, -el.h / 2);
  ctx.globalAlpha *= el.opacity == null ? 1 : el.opacity;
  if (el.shadow) {
    ctx.shadowColor = rgba(el.shadow.color || '#000', el.shadow.alpha == null ? .35 : el.shadow.alpha);
    ctx.shadowBlur = (el.shadow.blur || 0) * env.scale;
    ctx.shadowOffsetX = (el.shadow.x || 0) * env.scale; ctx.shadowOffsetY = (el.shadow.y || 0) * env.scale;
  }
  if (el.type === 'text') drawText(ctx, el, env);
  else if (el.type === 'shape') drawShape(ctx, el);
  else if (el.type === 'icon') drawIcon(ctx, el);
  else if (el.type === 'image') drawImage(ctx, el, env);
  ctx.restore();
}
function drawShape(ctx, el) {
  const path = shapePath(el);
  if (isLine(el)) {
    ctx.strokeStyle = fillColor(el.fill); ctx.lineWidth = el.sw || 4; ctx.lineCap = 'round';
    if (el.shape === 'dashed') ctx.setLineDash([el.sw * 2.5, el.sw * 2]);
    ctx.stroke(path);
    if (el.shape === 'arrowline') {
      const a = Math.max(el.sw * 3, 10); ctx.setLineDash([]); ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(el.w, el.h / 2); ctx.lineTo(el.w - a, el.h / 2 - a * .6); ctx.lineTo(el.w - a, el.h / 2 + a * .6); ctx.closePath(); ctx.fill();
    }
    return;
  }
  const f = paint(ctx, el.fill, el.w, el.h);
  const ring = el.shape === 'ring';
  if (f && !ring) { ctx.fillStyle = f; ctx.fill(path, el.shape === 'frame' ? 'evenodd' : 'nonzero'); }
  if ((el.sw && el.stroke && el.stroke !== 'none') || ring) {
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = ring ? (el.sw || Math.min(el.w, el.h) * .08) : el.sw;
    ctx.strokeStyle = ring ? (f || '#000') : el.stroke;
    ctx.lineJoin = 'round';
    if (el.dash) ctx.setLineDash([ctx.lineWidth * 2, ctx.lineWidth * 1.5]);
    ctx.save(); ctx.clip(path); ctx.lineWidth *= 2; ctx.stroke(path); ctx.restore();   // inside stroke: stays within the box
  }
}
function drawIcon(ctx, el) {
  const k = Math.min(el.w, el.h) / 24;
  ctx.translate((el.w - 24 * k) / 2, (el.h - 24 * k) / 2); ctx.scale(k, k);
  const p = iconPath(el.icon);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (el.solid) { ctx.fillStyle = el.color; ctx.fill(p); }
  ctx.strokeStyle = el.color; ctx.lineWidth = el.sw || 1.8; ctx.stroke(p);
}
function drawText(ctx, el, env) {
  if (env.editing && env.editing === el.id) return;
  const lines = textLines(el), lh = el.size * (el.lh || 1.2), ls = (el.ls || 0) * el.size;
  ctx.font = fontCss(el); ctx.textBaseline = 'middle';
  const widths = lines.map(l => measure(ctx, l, ls));
  if (el.box) {   // highlight box behind the text
    const pad = el.size * (el.box.pad == null ? .3 : el.box.pad);
    ctx.save(); ctx.fillStyle = el.box.color || '#ff0'; ctx.globalAlpha *= el.box.alpha == null ? 1 : el.box.alpha;
    if (el.box.full) { const p = new Path2D(); roundRect(p, -pad, -pad * .6, el.w + pad * 2, el.h + pad * 1.2, el.size * (el.box.r || 0)); ctx.fill(p); }
    else lines.forEach((l, i) => { if (!l) return; const lw = widths[i], x = el.align === 'center' ? (el.w - lw) / 2 : el.align === 'right' ? el.w - lw : 0; const p = new Path2D(); roundRect(p, x - pad, i * lh + (lh - el.size * 1.15) / 2 - pad * .25, lw + pad * 2, el.size * 1.15 + pad * .5, el.size * (el.box.r || 0)); ctx.fill(p); });
    ctx.restore();
  }
  const fill = paint(ctx, el.color, el.w, el.h) || '#000';
  lines.forEach((line, i) => {
    const lw = widths[i];
    let x = el.align === 'center' ? (el.w - lw) / 2 : el.align === 'right' ? el.w - lw : 0;
    const y = i * lh + lh / 2 + el.size * .04;
    const draw = fn => {
      if (!ls) { ctx[fn](line, x, y); return; }
      let cx0 = x; for (const ch of line) { ctx[fn](ch, cx0, y); cx0 += ctx.measureText(ch).width + ls; }
    };
    if (el.outline && el.outline.w) {
      ctx.save(); ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.strokeStyle = el.outline.color || '#000'; ctx.lineWidth = el.outline.w * el.size / 50;
      draw('strokeText'); ctx.restore();
      if (el.outline.only) return;
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = fill; draw('fillText');
    if (el.underline) { ctx.fillRect(x, y + el.size * .45, lw, Math.max(1, el.size * .06)); }
  });
}
function drawImage(ctx, el, env) {
  const mask = el.mask && el.mask !== 'none' ? shapePath({ shape: el.mask, w: el.w, h: el.h, seed: el.seed, radius: Math.min(el.w, el.h) * .12, inner: .5 }) : null;
  const img = el.src && env.images && env.images(el.src);
  if (!img) {
    // empty photo frame: a soft placeholder the user drops a photo into
    const g = ctx.createLinearGradient(0, 0, el.w, el.h); g.addColorStop(0, el.ph || '#d9dde6'); g.addColorStop(1, mix(el.ph || '#d9dde6', '#ffffff', .45));
    ctx.fillStyle = g;
    if (mask) ctx.fill(mask); else ctx.fillRect(0, 0, el.w, el.h);
    ctx.shadowColor = 'transparent';
    if (env.editor) {
      const k = Math.min(el.w, el.h) * .22 / 24;
      ctx.save(); if (mask) ctx.clip(mask);
      ctx.translate(el.w / 2 - 12 * k, el.h / 2 - 12 * k); ctx.scale(k, k);
      ctx.strokeStyle = 'rgba(40,48,66,.45)'; ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(iconPath('image'));
      ctx.restore();
    }
    return;
  }
  const src = filteredImage(img, el.filter);
  const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
  // cover the frame, then zoom and pan inside it
  const zoom = Math.max(1, el.zoom || 1);
  const k = Math.max(el.w / iw, el.h / ih) * zoom;
  const dw = iw * k, dh = ih * k;
  const dx = (el.w - dw) / 2 + (el.px || 0) * (dw - el.w) / 2, dy = (el.h - dh) / 2 + (el.py || 0) * (dh - el.h) / 2;
  if (mask) {
    if (el.shadow) { ctx.fillStyle = '#000'; ctx.fill(mask); ctx.shadowColor = 'transparent'; }
    ctx.clip(mask);
  } else if (el.shadow) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, el.w, el.h); ctx.shadowColor = 'transparent'; }
  if (!mask) { ctx.beginPath(); ctx.rect(0, 0, el.w, el.h); ctx.clip(); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, dx, dy, dw, dh);
  if (el.border && el.border.w) { ctx.lineWidth = el.border.w * 2; ctx.strokeStyle = el.border.color; ctx.stroke(mask || rectPath(el.w, el.h)); }
}
function rectPath(w, h) { const p = new Path2D(); p.rect(0, 0, w, h); return p; }

function drawBackground(ctx, bg, W, H, env) {
  bg = bg || {};
  const f = paint(ctx, bg.fill || '#ffffff', W, H);
  if (f && !(env && env.transparent)) { ctx.fillStyle = f; ctx.fillRect(0, 0, W, H); }
  if (bg.image && env && env.images) {
    const img = env.images(bg.image);
    if (img) {
      const src = filteredImage(img, bg.filter);
      const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height, k = Math.max(W / iw, H / ih);
      ctx.drawImage(src, (W - iw * k) / 2, (H - ih * k) / 2, iw * k, ih * k);
      if (bg.tint) { ctx.fillStyle = rgba(bg.tint, bg.tintA == null ? .35 : bg.tintA); ctx.fillRect(0, 0, W, H); }
    }
  }
  drawPattern(ctx, bg.pattern, W, H);
}
// env: {scale, images(id)->img, editor, editing, transparent, skip:Set}
function renderPage(ctx, page, W, H, env) {
  env = Object.assign({ scale: 1 }, env);
  ctx.save();
  drawBackground(ctx, page.bg, W, H, env);
  for (const el of page.els) if (!(env.skip && env.skip.has(el.id))) drawElement(ctx, el, env);
  ctx.restore();
}

window.LDCore = {
  FONTS, fontStack, fontFamily, custom, uid, rng, rgba, lum, mix, hexRgb,
  fontCss, textLines, textHeight, syncText, textWidth, fitText, measure,
  paint, fillColor, SHAPES, shapePath, isLine, ICONS, PATTERNS, MASKS,
  drawElement, drawBackground, renderPage, filteredImage,
};
})();
