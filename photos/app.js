/* Linear Photos — a layered photo editor that runs entirely in the tab.
 *
 * Model: a document is a stack of layers, each a document-sized canvas with an
 * x/y offset. Layer canvases are never drawn on in place. Every edit renders a
 * new canvas and swaps it in, so history entries can share the canvases of
 * layers an edit didn't touch — undo costs one canvas per changed layer, not a
 * copy of the whole document per step.
 *
 * The selection is an alpha mask (a document-sized canvas), which is what lets
 * rectangles, ellipses, lassos and the magic wand combine, invert and feather
 * the same way. Anything that paints goes through editedCanvas(), which clips
 * the change to that mask.
 */
'use strict';
(() => {

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const MAX_PIXELS = 16777216;   // iOS Safari's canvas ceiling; applied everywhere so a file behaves the same on every device
const HISTORY_MAX = 40;

function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }
function cx(c) { return c.getContext('2d'); }
function clone(c) { const n = mk(c.width, c.height); cx(n).drawImage(c, 0, 0); return n; }

// ---------------------------------------------------------------- state
let doc = null;                 // {w, h, layers:[], active}
let sel = null;                 // {mask, bounds:{x,y,w,h}, segs}
let history = [], hIndex = -1;
let dirty = false;
let uid = 1;
let fg = '#000000', bg = '#ffffff';
let tool = 'brush';
let live = null;                // {id, canvas} or {id, draw(ctx)} — a layer rendered differently while an edit is in progress
let clipboard = null;
const view = { zoom: 1, px: 0, py: 0 };
const opt = {
  brush: { size: 24, hard: 80, opacity: 100 },
  eraser: { size: 40, hard: 80, opacity: 100 },
  clone: { size: 40, hard: 50, opacity: 100 },
  marquee: { shape: 'rect', feather: 0 },
  lasso: { feather: 0 },
  wand: { tol: 32, contiguous: true, all: false },
  fill: { tol: 32, contiguous: true, all: false, opacity: 100 },
  gradient: { kind: 'linear', toClear: false, opacity: 100 },
  shape: { kind: 'rect', fill: true, stroke: 4 },
  text: { family: 'Arial', size: 64, bold: false, italic: false },
  eyedropper: { all: true },
  move: { auto: false },
};
let selMode = 'new';            // new | add | sub | int

const layerById = id => doc && doc.layers.find(l => l.id === id);
const active = () => doc && layerById(doc.active);

// ---------------------------------------------------------------- toasts
function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 5200 : 2800);
}

// ---------------------------------------------------------------- history
function snapshot() {
  return {
    w: doc.w, h: doc.h, active: doc.active, sel,
    layers: doc.layers.map(l => ({ ...l, text: l.text ? { ...l.text } : null })),
  };
}
function restore(s) {
  const resized = !doc || doc.w !== s.w || doc.h !== s.h;
  doc = { w: s.w, h: s.h, active: s.active, layers: s.layers.map(l => ({ ...l, text: l.text ? { ...l.text } : null })) };
  sel = s.sel;
  if (resized) sizeStage();
  refreshAll();
}
function push(label) {
  history = history.slice(0, hIndex + 1);
  history.push({ label, state: snapshot() });
  if (history.length > HISTORY_MAX) history.shift();
  hIndex = history.length - 1;
  dirty = history.length > 1 || dirty;
  refreshAll();
}
function undo() { if (busyTool()) return; if (hIndex > 0) { hIndex--; restore(history[hIndex].state); } }
function redo() { if (busyTool()) return; if (hIndex < history.length - 1) { hIndex++; restore(history[hIndex].state); } }
function goHistory(i) { if (busyTool()) return; hIndex = i; restore(history[i].state); }

// ---------------------------------------------------------------- document lifecycle
function newLayer(name, canvas) {
  return { id: uid++, name, canvas: canvas || mk(doc.w, doc.h), visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, text: null };
}
function newDoc(w, h, fill, firstLabel) {
  w = Math.round(w); h = Math.round(h);
  if (w * h > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / (w * h)); w = Math.floor(w * k); h = Math.floor(h * k); }
  doc = { w, h, layers: [], active: 0 };
  const base = newLayer('Background');
  if (fill) { const c = cx(base.canvas); c.fillStyle = fill; c.fillRect(0, 0, w, h); }
  doc.layers.push(base); doc.active = base.id;
  sel = null; history = []; hIndex = -1; dirty = false;
  $('welcome').hidden = true; $('stage').hidden = false;
  sizeStage(); fit();
  push(firstLabel || 'New');
  dirty = false;
}
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
function fitPixels(w, h) {
  if (w * h <= MAX_PIXELS) return [w, h, false];
  const k = Math.sqrt(MAX_PIXELS / (w * h));
  return [Math.floor(w * k), Math.floor(h * k), true];
}
async function openFile(file) {
  if (!file) return;
  if (dirty && !confirm('Open a new image? Changes to the current one will be lost — export it first if you want to keep it.')) return;
  let img;
  try { img = await loadImageFile(file); }
  catch { return toast(/hei[cf]/i.test(file.name) ? 'This browser can’t read HEIC photos. Export it as JPEG from your phone, or open it in Safari.' : 'That file couldn’t be opened as an image.', true); }
  const [w, h, shrunk] = fitPixels(img.naturalWidth, img.naturalHeight);
  newDoc(w, h, null, 'Open');
  const L = doc.layers[0];
  const c = mk(w, h); const g = cx(c); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
  L.canvas = c;
  history[0].state = snapshot();
  docName = file.name.replace(/\.[^.]+$/, '') || 'image';
  refreshAll();
  if (shrunk) toast(`Scaled to ${w}×${h} — browsers can’t hold a larger picture in memory.`);
}
async function placeImage(source, name) {
  if (!doc) {
    const [w, h] = fitPixels(source.width || source.naturalWidth, source.height || source.naturalHeight);
    newDoc(w, h, null, 'Paste');
    const c = mk(w, h); cx(c).drawImage(source, 0, 0, w, h); doc.layers[0].canvas = c; doc.layers[0].name = name || 'Pasted';
    history[0].state = snapshot(); refreshAll();
    return;
  }
  const sw = source.width || source.naturalWidth, sh = source.height || source.naturalHeight;
  const k = Math.min(1, doc.w / sw, doc.h / sh);
  const w = Math.round(sw * k), h = Math.round(sh * k);
  const L = newLayer(name || 'Placed');
  const g = cx(L.canvas); g.imageSmoothingQuality = 'high';
  g.drawImage(source, Math.round((doc.w - w) / 2), Math.round((doc.h - h) / 2), w, h);
  insertLayer(L);
  push(name === 'Pasted' ? 'Paste' : 'Place Image');
  setTool('move');
}
let docName = 'untitled';

// ---------------------------------------------------------------- stage & view
const work = $('work'), stage = $('stage'), viewC = $('view'), uiC = $('ui');
function sizeStage() {
  viewC.width = doc.w; viewC.height = doc.h;
  stage.style.width = doc.w + 'px'; stage.style.height = doc.h + 'px';
  applyView();
}
function applyView() {
  stage.style.transform = `translate(${view.px}px,${view.py}px) scale(${view.zoom})`;
  const s = 8 / view.zoom;
  stage.style.backgroundSize = `${s * 2}px ${s * 2}px`;
  stage.style.backgroundPosition = `0 0,${s}px ${s}px`;
  stage.classList.toggle('px', view.zoom >= 2);
  $('stZoom').textContent = Math.round(view.zoom * 1000) / 10 + '%';
  requestUI();
  if (textEditing) positionTextEdit();
}
function fit() {
  if (!doc) return;
  const r = work.getBoundingClientRect();
  const z = Math.min((r.width - 48) / doc.w, (r.height - 48) / doc.h, 1);
  view.zoom = Math.max(z, 0.01);
  view.px = Math.round((r.width - doc.w * view.zoom) / 2);
  view.py = Math.round((r.height - doc.h * view.zoom) / 2);
  applyView();
}
function zoomAt(z, sx, sy) {
  if (!doc) return;
  const r = work.getBoundingClientRect();
  if (sx == null) { sx = r.width / 2; sy = r.height / 2; }
  z = clamp(z, 0.02, 32);
  const dx = (sx - view.px) / view.zoom, dy = (sy - view.py) / view.zoom;
  view.zoom = z; view.px = sx - dx * z; view.py = sy - dy * z;
  applyView();
}
const ZSTEPS = [0.02, 0.03, 0.05, 0.0667, 0.083, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
function zoomStep(dir, sx, sy) {
  const z = view.zoom;
  const next = dir > 0 ? ZSTEPS.find(s => s > z * 1.001) : [...ZSTEPS].reverse().find(s => s < z / 1.001);
  if (next) zoomAt(next, sx, sy);
}
function toDoc(e) {
  const r = work.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.px) / view.zoom, y: (e.clientY - r.top - view.py) / view.zoom };
}

// ---------------------------------------------------------------- rendering
let renderQueued = false, uiQueued = false;
function requestRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderNow); } }
function requestUI() { if (!uiQueued) { uiQueued = true; requestAnimationFrame(drawUI); } }
function renderNow() {
  renderQueued = false;
  if (!doc) return;
  composite(cx(viewC), live);
  requestUI();
}
function composite(g, lv) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, doc.w, doc.h);
  for (const l of doc.layers) {
    if (!l.visible) continue;
    if (textEditing && textEditing.layerId === l.id) continue;
    g.globalAlpha = l.opacity;
    g.globalCompositeOperation = l.blend === 'normal' ? 'source-over' : l.blend;
    if (lv && lv.id === l.id) {
      if (lv.draw) lv.draw(g, l); else g.drawImage(lv.canvas, l.x, l.y);
    } else g.drawImage(l.canvas, l.x, l.y);
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
}
function flatCanvas() { const c = mk(doc.w, doc.h); composite(cx(c), null); return c; }
// The active layer placed at its offset in a document-sized canvas: what the wand and bucket sample.
function layerInDoc(l) { const c = mk(doc.w, doc.h); cx(c).drawImage(l.canvas, l.x, l.y); return c; }

// Pooled scratch canvases for previews, so dragging a slider doesn't allocate two full-size canvases a frame.
const pool = [mk(1, 1), mk(1, 1)];
function scratch(i, w, h) { const c = pool[i]; if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } else cx(c).clearRect(0, 0, w, h); return c; }

/* The one path every pixel edit takes. paint() draws onto a copy of the layer
 * (it may also replace it wholesale); if something is selected, the result is
 * kept only inside the mask and the original everywhere else. The two halves
 * are summed with 'lighter', which on premultiplied colour is exactly
 * orig·(1−m) + edit·m, so feathered edges blend rather than darken. */
function editedCanvas(l, paint, fresh) {
  const W = l.canvas.width, H = l.canvas.height;
  const a = fresh ? mk(W, H) : scratch(0, W, H), ag = cx(a);
  ag.drawImage(l.canvas, 0, 0);
  ag.save(); paint(ag); ag.restore();
  if (!sel) return a;
  ag.globalCompositeOperation = 'destination-in'; ag.drawImage(sel.mask, -l.x, -l.y); ag.globalCompositeOperation = 'source-over';
  const b = fresh ? mk(W, H) : scratch(1, W, H), bg_ = cx(b);
  bg_.drawImage(l.canvas, 0, 0);
  bg_.globalCompositeOperation = 'destination-out'; bg_.drawImage(sel.mask, -l.x, -l.y);
  bg_.globalCompositeOperation = 'lighter'; bg_.drawImage(a, 0, 0);
  bg_.globalCompositeOperation = 'source-over';
  return b;
}
function commitPaint(l, paint, label, keepText) {
  l.canvas = editedCanvas(l, paint, true);
  if (!keepText) l.text = null;
  live = null;
  push(label);
}
function requireLayer() {
  const l = active();
  if (!l) return null;
  if (!l.visible) { toast('That layer is hidden — show it to edit it.'); return null; }
  return l;
}

// ---------------------------------------------------------------- selection
function setSelection(mask, label) {
  sel = mask ? buildSel(mask) : null;
  push(label);
}
function buildSel(mask) {
  const W = mask.width, H = mask.height;
  const a = cx(mask).getImageData(0, 0, W, H).data;
  const inside = new Uint8Array(W * H);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;       // extent of the outline (pixels at least half selected)
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1;   // extent of anything selected at all, for crops and filters
  for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
    const v = a[i * 4 + 3];
    if (!v) continue;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    if (v >= 128) { inside[i] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (bx1 < 0) return null;
  const bounds = { x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
  if (x1 < 0) return { mask, bounds, segs: [] };
  // Outline as merged unit edges between inside and outside pixels — drawn as marching ants.
  const segs = [];
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H ? inside[y * W + x] : 0;
  for (let y = y0; y <= y1 + 1; y++) {
    let s = -1;
    for (let x = x0; x <= x1 + 1; x++) {
      const e = x <= x1 && at(x, y - 1) !== at(x, y);
      if (e && s < 0) s = x; else if (!e && s >= 0) { segs.push(s, y, x, y); s = -1; }
    }
  }
  for (let x = x0; x <= x1 + 1; x++) {
    let s = -1;
    for (let y = y0; y <= y1 + 1; y++) {
      const e = y <= y1 && at(x - 1, y) !== at(x, y);
      if (e && s < 0) s = y; else if (!e && s >= 0) { segs.push(x, s, x, y); s = -1; }
    }
  }
  return { mask, bounds, segs };
}
// Combine a freshly drawn shape mask with the current selection per the mode.
function combineSel(shape, mode, feather) {
  if (feather > 0) shape = featherMask(shape, feather);
  if (mode === 'new' || !sel) {
    if (mode === 'sub' || mode === 'int') return sel ? sel.mask : null;
    return shape;
  }
  const m = clone(sel.mask), g = cx(m);
  g.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'sub' ? 'destination-out' : 'destination-in';
  g.drawImage(shape, 0, 0);
  return m;
}
function featherMask(m, r) {
  const img = cx(m).getImageData(0, 0, m.width, m.height);
  blurRGBA(img.data, m.width, m.height, r, true);
  const n = mk(m.width, m.height); cx(n).putImageData(img, 0, 0); return n;
}
function selectAll() { if (!doc) return; const m = mk(doc.w, doc.h); const g = cx(m); g.fillStyle = '#fff'; g.fillRect(0, 0, doc.w, doc.h); setSelection(m, 'Select All'); }
function deselect() { if (sel) setSelection(null, 'Deselect'); }
function invertSel() {
  if (!doc) return;
  const m = mk(doc.w, doc.h), g = cx(m); g.fillStyle = '#fff'; g.fillRect(0, 0, doc.w, doc.h);
  if (sel) { g.globalCompositeOperation = 'destination-out'; g.drawImage(sel.mask, 0, 0); }
  setSelection(m, 'Inverse');
}

// ---------------------------------------------------------------- UI overlay (ants, handles, cursors)
let antPhase = 0;
setInterval(() => { if (sel && sel.segs.length && sel.segs.length < 400000) { antPhase = (antPhase + 1) % 8; requestUI(); } }, 130);
let cursorPos = null;
function drawUI() {
  uiQueued = false;
  const dpr = window.devicePixelRatio || 1;
  const r = work.getBoundingClientRect();
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (uiC.width !== W || uiC.height !== H) { uiC.width = W; uiC.height = H; }
  const g = cx(uiC);
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
  if (!doc) return;
  const z = view.zoom;
  g.setTransform(dpr * z, 0, 0, dpr * z, dpr * view.px, dpr * view.py);
  const lw = 1 / z;
  if (sel && sel.segs.length) {
    const s = sel.segs;
    g.beginPath();
    for (let i = 0; i < s.length; i += 4) { g.moveTo(s[i], s[i + 1]); g.lineTo(s[i + 2], s[i + 3]); }
    g.lineWidth = lw; g.strokeStyle = '#fff'; g.setLineDash([]); g.stroke();
    g.strokeStyle = '#000'; g.setLineDash([4 / z, 4 / z]); g.lineDashOffset = -antPhase / z; g.stroke();
    g.setLineDash([]);
  }
  const T = TOOLS[tool];
  if (T && T.drawUI) T.drawUI(g, z);
  if (xf) drawTransformUI(g, z);
  if (cursorPos && T && T.brushSize && !panState && !spaceDown) {
    const rad = T.brushSize() / 2;
    g.beginPath(); g.arc(cursorPos.x, cursorPos.y, Math.max(rad, 1 / z), 0, Math.PI * 2);
    g.lineWidth = 2 * lw; g.strokeStyle = 'rgba(0,0,0,.6)'; g.stroke();
    g.lineWidth = lw; g.strokeStyle = 'rgba(255,255,255,.95)'; g.stroke();
  }
}
function dashRect(g, x, y, w, h, z) {
  g.lineWidth = 1 / z; g.strokeStyle = '#fff'; g.setLineDash([]); g.strokeRect(x, y, w, h);
  g.strokeStyle = '#000'; g.setLineDash([4 / z, 4 / z]); g.strokeRect(x, y, w, h); g.setLineDash([]);
}

// ---------------------------------------------------------------- brush engine
function stampFor(color, size, hard) {
  const d = Math.max(1, Math.ceil(size));
  const c = mk(d + 2, d + 2), g = cx(c);
  const r = d / 2, m = d / 2 + 1;
  if (hard >= 99) { g.fillStyle = color; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill(); return c; }
  const grad = g.createRadialGradient(m, m, 0, m, m, r);
  const h = clamp(hard / 100, 0, 0.98);
  grad.addColorStop(0, color); grad.addColorStop(h, color);
  grad.addColorStop(1, color.length === 7 ? color + '00' : 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill();
  return c;
}
/* A stroke is stamped onto its own document-sized canvas at full strength and
 * only then laid onto the layer at the chosen opacity. That's what keeps a
 * 50% stroke at 50% where it crosses itself, the way Photoshop's brush does. */
function makeStroke(color, o) {
  const c = mk(doc.w, doc.h);
  return { c, g: cx(c), stamp: stampFor(color, o.size, o.hard), size: o.size, last: null, pts: 0 };
}
function strokeTo(st, p, pressure) {
  const pr = pressure == null ? 1 : clamp(pressure, 0.05, 1);
  if (!st.last) { const d = st.stamp.width * pr; st.g.drawImage(st.stamp, p.x - d / 2, p.y - d / 2, d, d); st.last = p; return; }
  const from = st.last;
  const spacing = Math.max(0.5, st.size * 0.1);
  const dx = p.x - from.x, dy = p.y - from.y, dist = Math.hypot(dx, dy);
  const n = Math.max(1, Math.floor(dist / spacing));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = from.x + dx * t, y = from.y + dy * t;
    const d = st.stamp.width * pr;
    st.g.drawImage(st.stamp, x - d / 2, y - d / 2, d, d);
  }
  st.last = p;
}

// ---------------------------------------------------------------- flood fill
function colorMatch(data, W, H, sx, sy, tol, contiguous) {
  const out = new Uint8Array(W * H);
  const i0 = (sy * W + sx) * 4;
  const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
  const ok = i => {
    const p = i * 4;
    return Math.abs(data[p] - r0) <= tol && Math.abs(data[p + 1] - g0) <= tol && Math.abs(data[p + 2] - b0) <= tol && Math.abs(data[p + 3] - a0) <= tol;
  };
  if (!contiguous) { for (let i = 0; i < W * H; i++) if (ok(i)) out[i] = 1; return out; }
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop(); let x = stack.pop();
    let i = y * W + x;
    while (x >= 0 && !out[i] && ok(i)) { x--; i--; }
    x++; i++;
    let up = false, dn = false;
    while (x < W && !out[i] && ok(i)) {
      out[i] = 1;
      if (y > 0) { const u = i - W; if (!out[u] && ok(u)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false; }
      if (y < H - 1) { const d = i + W; if (!out[d] && ok(d)) { if (!dn) { stack.push(x, y + 1); dn = true; } } else dn = false; }
      x++; i++;
    }
  }
  return out;
}
function maskCanvas(bits, W, H) {
  const c = mk(W, H), img = cx(c).createImageData(W, H), d = img.data;
  for (let i = 0, p = 0; i < bits.length; i++, p += 4) if (bits[i]) { d[p] = d[p + 1] = d[p + 2] = 255; d[p + 3] = 255; }
  cx(c).putImageData(img, 0, 0); return c;
}

// ---------------------------------------------------------------- pixel filters
function lut(fn) { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = fn(i); return t; }
function applyLut(d, tr, tg, tb) { for (let p = 0; p < d.length; p += 4) { d[p] = tr[d[p]]; d[p + 1] = tg[d[p + 1]]; d[p + 2] = tb[d[p + 2]]; } }
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hue2(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
function hsl2rgb(h, s, l) {
  if (!s) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue2(p, q, h + 1 / 3) * 255, hue2(p, q, h) * 255, hue2(p, q, h - 1 / 3) * 255];
}
// Three passes of a running-sum box blur ≈ a Gaussian. Colour is premultiplied first so
// transparent pixels don't bleed black into the edges.
function blurRGBA(d, W, H, r, alphaOnly) {
  r = Math.round(r);
  if (r < 1) return;
  const n = W * H;
  const ch = alphaOnly ? [3] : [0, 1, 2, 3];
  if (!alphaOnly) for (let p = 0; p < d.length; p += 4) { const a = d[p + 3] / 255; d[p] *= a; d[p + 1] *= a; d[p + 2] *= a; }
  const buf = new Float32Array(n), tmp = new Float32Array(n);
  const box = Math.max(1, Math.round(r / Math.sqrt(3)));
  for (const c of ch) {
    for (let i = 0; i < n; i++) buf[i] = d[i * 4 + c];
    for (let pass = 0; pass < 3; pass++) { boxH(buf, tmp, W, H, box); boxV(tmp, buf, W, H, box); }
    for (let i = 0; i < n; i++) d[i * 4 + c] = buf[i];
  }
  if (!alphaOnly) for (let p = 0; p < d.length; p += 4) { const a = d[p + 3]; if (a) { const k = 255 / a; d[p] *= k; d[p + 1] *= k; d[p + 2] *= k; } }
}
function boxH(src, dst, W, H, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < H; y++) {
    const o = y * W, fv = src[o];
    let v = (r + 1) * fv;
    for (let j = 0; j < r; j++) v += src[o + Math.min(j, W - 1)];
    for (let x = 0; x < W; x++) {
      v += src[o + Math.min(x + r, W - 1)] - (x - r - 1 >= 0 ? src[o + x - r - 1] : fv);
      dst[o + x] = v * iarr;
    }
  }
}
function boxV(src, dst, W, H, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < W; x++) {
    const fv = src[x];
    let v = (r + 1) * fv;
    for (let j = 0; j < r; j++) v += src[Math.min(j, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      v += src[Math.min(y + r, H - 1) * W + x] - (y - r - 1 >= 0 ? src[(y - r - 1) * W + x] : fv);
      dst[y * W + x] = v * iarr;
    }
  }
}

/* Each adjustment: fields for its dialog, and run(imageData, values, W, H) that edits
 * pixels in place. `canvas` variants work with the 2D context instead. */
const ADJ = {
  brightness: {
    title: 'Brightness / Contrast', fields: [
      { k: 'b', label: 'Brightness', min: -100, max: 100, v: 0 },
      { k: 'c', label: 'Contrast', min: -100, max: 100, v: 0 }],
    run(img, o) {
      const c = o.c * 2.55, f = (259 * (c + 255)) / (255 * (259 - c)), b = o.b * 1.5;
      const t = lut(v => f * (v - 128) + 128 + b); applyLut(img.data, t, t, t);
    }
  },
  levels: {
    title: 'Levels', fields: [
      { k: 'lo', label: 'Shadows', min: 0, max: 254, v: 0 },
      { k: 'gm', label: 'Midtones', min: 10, max: 300, v: 100, fmt: v => (v / 100).toFixed(2) },
      { k: 'hi', label: 'Highlights', min: 1, max: 255, v: 255 },
      { k: 'olo', label: 'Output black', min: 0, max: 255, v: 0 },
      { k: 'ohi', label: 'Output white', min: 0, max: 255, v: 255 }],
    run(img, o) {
      const hi = Math.max(o.hi, o.lo + 1), g = 1 / (o.gm / 100);
      const t = lut(v => { const n = clamp((v - o.lo) / (hi - o.lo), 0, 1); return o.olo + Math.pow(n, g) * (o.ohi - o.olo); });
      applyLut(img.data, t, t, t);
    }
  },
  exposure: {
    title: 'Exposure', fields: [
      { k: 'ev', label: 'Exposure', min: -300, max: 300, v: 0, fmt: v => (v > 0 ? '+' : '') + (v / 100).toFixed(2) },
      { k: 'off', label: 'Offset', min: -50, max: 50, v: 0 },
      { k: 'gm', label: 'Gamma', min: 20, max: 300, v: 100, fmt: v => (v / 100).toFixed(2) }],
    run(img, o) {
      const k = Math.pow(2, o.ev / 100), g = 1 / (o.gm / 100);
      const t = lut(v => 255 * Math.pow(clamp((v / 255) * k + o.off / 255, 0, 1), g)); applyLut(img.data, t, t, t);
    }
  },
  hsl: {
    title: 'Hue / Saturation', fields: [
      { k: 'h', label: 'Hue', min: -180, max: 180, v: 0 },
      { k: 's', label: 'Saturation', min: -100, max: 100, v: 0 },
      { k: 'l', label: 'Lightness', min: -100, max: 100, v: 0 },
      { k: 'col', label: 'Colorize', type: 'check', v: false }],
    run(img, o) {
      const d = img.data, dh = o.h / 360, ds = o.s / 100, dl = o.l / 100;
      for (let p = 0; p < d.length; p += 4) {
        if (!d[p + 3]) continue;
        let [h, s, l] = rgb2hsl(d[p], d[p + 1], d[p + 2]);
        if (o.col) { h = ((o.h + 360) % 360) / 360; s = clamp(0.25 + ds * 0.75, 0, 1); }
        else { h = (h + dh + 1) % 1; s = ds > 0 ? s + (1 - s) * ds : s * (1 + ds); }
        l = dl > 0 ? l + (1 - l) * dl : l * (1 + dl);
        const c = hsl2rgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
        d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2];
      }
    }
  },
  vibrance: {
    title: 'Vibrance', fields: [
      { k: 'v', label: 'Vibrance', min: -100, max: 100, v: 0 },
      { k: 's', label: 'Saturation', min: -100, max: 100, v: 0 }],
    run(img, o) {
      const d = img.data, vib = o.v / 100, sat = 1 + o.s / 100;
      for (let p = 0; p < d.length; p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        const amt = sat * (1 + vib * (1 - (Math.max(r, g, b) - Math.min(r, g, b)) / 255) * (vib > 0 ? 1 : 0.8));
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        d[p] = L + (r - L) * amt; d[p + 1] = L + (g - L) * amt; d[p + 2] = L + (b - L) * amt;
      }
    }
  },
  temperature: {
    title: 'Temperature & Tint', fields: [
      { k: 't', label: 'Temperature', min: -100, max: 100, v: 0 },
      { k: 'n', label: 'Tint', min: -100, max: 100, v: 0 }],
    run(img, o) {
      const t = o.t * 0.6, n = o.n * 0.5;
      applyLut(img.data, lut(v => v + t), lut(v => v - n), lut(v => v - t));
    }
  },
  colorBalance: {
    title: 'Color Balance', fields: [
      { k: 'r', label: 'Cyan ↔ Red', min: -100, max: 100, v: 0 },
      { k: 'g', label: 'Magenta ↔ Green', min: -100, max: 100, v: 0 },
      { k: 'b', label: 'Yellow ↔ Blue', min: -100, max: 100, v: 0 }],
    run(img, o) {
      const f = k => lut(v => v + k * 0.8 * Math.sin(Math.PI * v / 255) + k * 0.2);
      applyLut(img.data, f(o.r), f(o.g), f(o.b));
    }
  },
  bw: {
    title: 'Black & White', fields: [
      { k: 'r', label: 'Reds', min: -100, max: 200, v: 40 },
      { k: 'g', label: 'Greens', min: -100, max: 200, v: 40 },
      { k: 'b', label: 'Blues', min: -100, max: 200, v: 20 }],
    run(img, o) {
      const d = img.data, sum = (o.r + o.g + o.b) || 1, wr = o.r / sum, wg = o.g / sum, wb = o.b / sum;
      for (let p = 0; p < d.length; p += 4) { const v = d[p] * wr + d[p + 1] * wg + d[p + 2] * wb; d[p] = d[p + 1] = d[p + 2] = v; }
    }
  },
  sepia: {
    title: 'Sepia', fields: [{ k: 'a', label: 'Amount', min: 0, max: 100, v: 80 }],
    run(img, o) {
      const d = img.data, a = o.a / 100;
      for (let p = 0; p < d.length; p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        d[p] = r + ((0.393 * r + 0.769 * g + 0.189 * b) - r) * a;
        d[p + 1] = g + ((0.349 * r + 0.686 * g + 0.168 * b) - g) * a;
        d[p + 2] = b + ((0.272 * r + 0.534 * g + 0.131 * b) - b) * a;
      }
    }
  },
  posterize: {
    title: 'Posterize', fields: [{ k: 'n', label: 'Levels', min: 2, max: 32, v: 5 }],
    run(img, o) { const s = 255 / (o.n - 1), t = lut(v => Math.round(v / s) * s); applyLut(img.data, t, t, t); }
  },
  threshold: {
    title: 'Threshold', fields: [{ k: 't', label: 'Level', min: 1, max: 255, v: 128 }],
    run(img, o) {
      const d = img.data;
      for (let p = 0; p < d.length; p += 4) { const v = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) >= o.t ? 255 : 0; d[p] = d[p + 1] = d[p + 2] = v; }
    }
  },
  blur: {
    title: 'Gaussian Blur', fields: [{ k: 'r', label: 'Radius', min: 1, max: 100, v: 6, unit: 'px' }],
    run(img, o, W, H) { blurRGBA(img.data, W, H, o.r); }
  },
  sharpen: {
    title: 'Unsharp Mask', fields: [
      { k: 'a', label: 'Amount', min: 0, max: 300, v: 80, unit: '%' },
      { k: 'r', label: 'Radius', min: 1, max: 20, v: 2, unit: 'px' },
      { k: 't', label: 'Threshold', min: 0, max: 60, v: 2 }],
    run(img, o, W, H) {
      const d = img.data, b = new Uint8ClampedArray(d);
      blurRGBA(b, W, H, o.r);
      const a = o.a / 100;
      for (let p = 0; p < d.length; p += 4) for (let c = 0; c < 3; c++) {
        const diff = d[p + c] - b[p + c];
        if (Math.abs(diff) >= o.t) d[p + c] = d[p + c] + diff * a;
      }
    }
  },
  noise: {
    title: 'Add Noise', fields: [
      { k: 'a', label: 'Amount', min: 1, max: 100, v: 12, unit: '%' },
      { k: 'm', label: 'Monochrome', type: 'check', v: true }],
    run(img, o) {
      const d = img.data, s = o.a * 2.55;
      let seed = 1234567;   // seeded, so the preview doesn't shimmer as you drag
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
      for (let p = 0; p < d.length; p += 4) {
        if (o.m) { const n = rnd() * s; d[p] += n; d[p + 1] += n; d[p + 2] += n; }
        else { d[p] += rnd() * s; d[p + 1] += rnd() * s; d[p + 2] += rnd() * s; }
      }
    }
  },
  pixelate: {
    title: 'Pixelate', fields: [{ k: 's', label: 'Cell size', min: 2, max: 120, v: 12, unit: 'px' }],
    canvas(src, o) {
      const W = src.width, H = src.height, sw = Math.max(1, Math.ceil(W / o.s)), sh = Math.max(1, Math.ceil(H / o.s));
      const small = mk(sw, sh); cx(small).drawImage(src, 0, 0, sw, sh);
      const out = mk(W, H), g = cx(out); g.imageSmoothingEnabled = false; g.drawImage(small, 0, 0, sw * o.s, sh * o.s);
      return out;
    }
  },
  vignette: {
    title: 'Vignette', fields: [
      { k: 'a', label: 'Amount', min: -100, max: 100, v: 50 },
      { k: 's', label: 'Size', min: 10, max: 100, v: 60, unit: '%' }],
    canvas(src, o, l) {
      const out = clone(src), g = cx(out);
      const cxp = doc.w / 2 - l.x, cyp = doc.h / 2 - l.y, R = Math.hypot(doc.w, doc.h) / 2;
      const grad = g.createRadialGradient(cxp, cyp, R * o.s / 100 * 0.6, cxp, cyp, R);
      const col = o.a >= 0 ? '0,0,0' : '255,255,255';
      grad.addColorStop(0, `rgba(${col},0)`); grad.addColorStop(1, `rgba(${col},${Math.abs(o.a) / 100})`);
      g.globalCompositeOperation = 'source-atop'; g.fillStyle = grad; g.fillRect(0, 0, out.width, out.height);
      return out;
    }
  },
  invert: { title: 'Invert', instant: true, run(img) { const t = lut(v => 255 - v); applyLut(img.data, t, t, t); } },
  desaturate: {
    title: 'Desaturate', instant: true,
    run(img) { const d = img.data; for (let p = 0; p < d.length; p += 4) { const v = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; d[p] = d[p + 1] = d[p + 2] = v; } }
  },
  autoTone: {
    title: 'Auto Tone', instant: true,
    // Stretch each channel so its darkest and brightest 0.5% become black and white.
    run(img) {
      const d = img.data, hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      let n = 0;
      for (let p = 0; p < d.length; p += 4) if (d[p + 3] > 8) { hist[0][d[p]]++; hist[1][d[p + 1]]++; hist[2][d[p + 2]]++; n++; }
      if (!n) return;
      const cut = n * 0.005;
      const t = hist.map(h => {
        let lo = 0, hi = 255, acc = 0;
        while (lo < 255 && (acc += h[lo]) <= cut) lo++;
        acc = 0; while (hi > 0 && (acc += h[hi]) <= cut) hi--;
        if (hi <= lo) return lut(v => v);
        return lut(v => (v - lo) * 255 / (hi - lo));
      });
      applyLut(d, t[0], t[1], t[2]);
    }
  },
};
function runAdj(key, l, o) {
  const A = ADJ[key];
  if (A.canvas) return A.canvas(l.canvas, o, l);
  const W = l.canvas.width, H = l.canvas.height;
  // Only the selected area needs processing; for a blur, take a margin so the edge samples real neighbours.
  let x = 0, y = 0, w = W, h = H;
  if (sel) {
    const m = key === 'blur' || key === 'sharpen' ? (o.r || 0) * 3 + 2 : 0;
    x = clamp(sel.bounds.x - l.x - m, 0, W); y = clamp(sel.bounds.y - l.y - m, 0, H);
    w = clamp(sel.bounds.x - l.x + sel.bounds.w + m, 0, W) - x; h = clamp(sel.bounds.y - l.y + sel.bounds.h + m, 0, H) - y;
  }
  const out = clone(l.canvas);
  if (w < 1 || h < 1) return out;
  const img = cx(l.canvas).getImageData(x, y, w, h);
  A.run(img, o, w, h);
  cx(out).putImageData(img, x, y);
  return out;
}
function adjustment(key) {
  if (!doc) return;
  const l = requireLayer(); if (!l) return;
  const A = ADJ[key];
  const replace = c => g => { g.globalCompositeOperation = 'copy'; g.drawImage(c, 0, 0); };
  if (A.instant) { const c = runAdj(key, l, {}); commitPaint(l, replace(c), A.title); return; }
  let pending = 0;
  const preview = vals => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const c = runAdj(key, l, vals);
      live = { id: l.id, canvas: clone(editedCanvas(l, replace(c), false)) };
      requestRender();
    });
  };
  dialog({
    title: A.title, fields: A.fields, preview: true,
    onChange: preview,
    onOk: vals => { cancelAnimationFrame(pending); const c = runAdj(key, l, vals); commitPaint(l, replace(c), A.title); },
    onCancel: () => { cancelAnimationFrame(pending); live = null; requestRender(); },
  });
}

// ---------------------------------------------------------------- dialogs
let openDlg = null;
function dialog({ title, fields, onChange, onOk, onCancel, okLabel, preview, note, build }) {
  closeMenus();
  if (openDlg) openDlg.cancel();
  const scrim = document.createElement('div');
  scrim.className = 'scrim' + (preview ? ' nodim' : '');
  const box = document.createElement('div'); box.className = 'dlg'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', title);
  const h = document.createElement('h2'); h.textContent = title; box.appendChild(h);
  const body = document.createElement('div'); body.className = 'body'; box.appendChild(body);
  const vals = {}, inputs = {};
  const changed = () => onChange && onChange({ ...vals });
  for (const f of fields || []) {
    vals[f.k] = f.v;
    const row = document.createElement('label'); row.className = 'row';
    const s = document.createElement('span'); s.textContent = f.label; row.appendChild(s);
    let inp;
    if (f.type === 'check') {
      row.classList.add('two');
      inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!f.v;
      const wrap = document.createElement('span'); wrap.appendChild(inp); row.appendChild(wrap);
      inp.onchange = () => { vals[f.k] = inp.checked; changed(); };
    } else if (f.type === 'select') {
      row.classList.add('two');
      inp = document.createElement('select');
      for (const [v, t] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; inp.appendChild(o); }
      inp.value = f.v; row.appendChild(inp);
      inp.onchange = () => { vals[f.k] = inp.value; changed(); };
    } else if (f.type === 'number' || f.type === 'text') {
      row.classList.add('two');
      inp = document.createElement('input'); inp.type = f.type; inp.value = f.v;
      if (f.min != null) inp.min = f.min; if (f.max != null) inp.max = f.max;
      inp.style.width = '100%'; row.appendChild(inp);
      inp.oninput = () => { vals[f.k] = f.type === 'number' ? +inp.value : inp.value; changed(); };
    } else {
      inp = document.createElement('input'); inp.type = 'range'; inp.min = f.min; inp.max = f.max; inp.step = f.step || 1; inp.value = f.v;
      const out = document.createElement('output');
      const show = () => out.textContent = (f.fmt ? f.fmt(+inp.value) : inp.value) + (f.unit && !f.fmt ? f.unit : '');
      show(); row.appendChild(inp); row.appendChild(out);
      inp.oninput = () => { vals[f.k] = +inp.value; show(); changed(); };
      row.ondblclick = () => { inp.value = f.v; vals[f.k] = f.v; show(); changed(); };
    }
    inputs[f.k] = inp;
    body.appendChild(row);
  }
  if (build) build(body, vals, inputs, changed);
  if (note) { const n = document.createElement('p'); n.className = 'note'; n.textContent = note; body.appendChild(n); }
  const foot = document.createElement('div'); foot.className = 'foot';
  let pv = null;
  if (preview) {
    const lab = document.createElement('label'); pv = document.createElement('input'); pv.type = 'checkbox'; pv.checked = true;
    lab.appendChild(pv); lab.append('Preview'); foot.appendChild(lab);
  }
  const cancelB = document.createElement('button'); cancelB.type = 'button'; cancelB.textContent = 'Cancel';
  const okB = document.createElement('button'); okB.type = 'button'; okB.className = 'ok'; okB.textContent = okLabel || 'OK';
  foot.appendChild(cancelB); foot.appendChild(okB); box.appendChild(foot);
  scrim.appendChild(box); document.body.appendChild(scrim);
  const close = () => { scrim.remove(); openDlg = null; };
  const api = {
    cancel() { close(); onCancel && onCancel(); },
    ok() { close(); onOk && onOk({ ...vals }); },
  };
  openDlg = api;
  cancelB.onclick = api.cancel; okB.onclick = api.ok;
  if (pv) pv.onchange = () => { if (pv.checked) changed(); else { live = null; requestRender(); } };
  if (!preview) scrim.onpointerdown = e => { if (e.target === scrim) api.cancel(); };
  // Drag by the title bar, so the dialog can be moved off the part of the photo you're judging.
  let drag = null, off = { x: 0, y: 0 };
  h.onpointerdown = e => { drag = { x: e.clientX - off.x, y: e.clientY - off.y }; h.setPointerCapture(e.pointerId); };
  h.onpointermove = e => { if (!drag) return; off = { x: e.clientX - drag.x, y: e.clientY - drag.y }; box.style.transform = `translate(${off.x}px,${off.y}px)`; };
  h.onpointerup = () => drag = null;
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); api.ok(); }
    if (e.key === 'Escape') { e.preventDefault(); api.cancel(); }
    e.stopPropagation();
  });
  const first = box.querySelector('input,select');
  setTimeout(() => (first || okB).focus(), 0);
  changed();
  return api;
}

// ---------------------------------------------------------------- layer operations
function insertLayer(L) {
  const i = doc.layers.findIndex(l => l.id === doc.active);
  doc.layers.splice(i + 1, 0, L); doc.active = L.id;
}
function addLayer() { if (!doc) return; const L = newLayer(`Layer ${uid}`); insertLayer(L); push('New Layer'); }
function duplicateLayer() {
  const l = active(); if (!l) return;
  // With a selection, Ctrl+J makes a layer of just the selected pixels, like Photoshop's "Layer via Copy".
  let c;
  if (sel) { c = clone(l.canvas); const g = cx(c); g.globalCompositeOperation = 'destination-in'; g.drawImage(sel.mask, -l.x, -l.y); }
  else c = clone(l.canvas);
  const L = { ...l, id: uid++, canvas: c, name: sel ? 'Layer via Copy' : l.name + ' copy', text: sel ? null : l.text && { ...l.text } };
  insertLayer(L); push(sel ? 'Layer via Copy' : 'Duplicate Layer');
}
function deleteLayer() {
  if (!doc) return;
  if (doc.layers.length < 2) { toast('An image needs at least one layer.'); return; }
  const i = doc.layers.findIndex(l => l.id === doc.active);
  doc.layers.splice(i, 1);
  doc.active = doc.layers[Math.max(0, i - 1)].id;
  push('Delete Layer');
}
function moveLayer(dir) {
  const i = doc.layers.findIndex(l => l.id === doc.active), j = i + dir;
  if (j < 0 || j >= doc.layers.length) return;
  const [L] = doc.layers.splice(i, 1); doc.layers.splice(j, 0, L); push(dir > 0 ? 'Bring Forward' : 'Send Backward');
}
function mergeDown() {
  const i = doc.layers.findIndex(l => l.id === doc.active);
  if (i < 1) { toast('There’s no layer below to merge into.'); return; }
  const up = doc.layers[i], lo = doc.layers[i - 1];
  const c = mk(doc.w, doc.h), g = cx(c);
  if (lo.visible) g.drawImage(lo.canvas, lo.x, lo.y);
  if (up.visible) { g.globalAlpha = up.opacity; g.globalCompositeOperation = up.blend === 'normal' ? 'source-over' : up.blend; g.drawImage(up.canvas, up.x, up.y); }
  doc.layers.splice(i - 1, 2, { ...lo, canvas: c, x: 0, y: 0, text: null, visible: true });
  doc.active = lo.id; push('Merge Down');
}
function flatten() {
  if (!doc) return;
  const c = flatCanvas();
  const L = newLayer('Background', c);
  doc.layers = [L]; doc.active = L.id; push('Flatten Image');
}
function clearSelected() {
  const l = requireLayer(); if (!l) return;
  if (!sel) { toast('Select an area first — or use Layer › Delete for the whole layer.'); return; }
  commitPaint(l, g => { g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.fillRect(0, 0, g.canvas.width, g.canvas.height); }, 'Clear');
}
function fillWith(color, label) {
  const l = requireLayer(); if (!l) return;
  commitPaint(l, g => { g.fillStyle = color; g.fillRect(0, 0, g.canvas.width, g.canvas.height); }, label);
}
function flipLayer(horiz) {
  const l = requireLayer(); if (!l) return;
  // Flip about the centre of the document, so a layer that fills the canvas stays where it is.
  commitPaint(l, g => {
    const src = clone(g.canvas);
    g.globalCompositeOperation = 'copy';
    const tx = horiz ? doc.w - 2 * l.x : 0, ty = horiz ? 0 : doc.h - 2 * l.y;
    g.setTransform(horiz ? -1 : 1, 0, 0, horiz ? 1 : -1, tx, ty); g.drawImage(src, 0, 0);
  }, horiz ? 'Flip Layer Horizontal' : 'Flip Layer Vertical');
}

// ---------------------------------------------------------------- image operations
function remapDoc(w, h, drawLayer, label, keepSel) {
  const layers = doc.layers.map(l => {
    const c = mk(w, h), g = cx(c); g.imageSmoothingQuality = 'high';
    drawLayer(g, l);
    return { ...l, canvas: c, x: 0, y: 0, text: null };
  });
  let mask = null;
  if (sel && keepSel) { mask = mk(w, h); const g = cx(mask); drawLayer(g, { canvas: sel.mask, x: 0, y: 0 }); }
  doc.w = w; doc.h = h; doc.layers = layers;
  sel = mask ? buildSel(mask) : null;
  sizeStage(); fit(); push(label);
}
function cropTo(x, y, w, h, label) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  if (w < 1 || h < 1) return;
  const texts = doc.layers.map(l => l.text && { ...l.text, x: l.text.x - x, y: l.text.y - y });
  remapDoc(w, h, (g, l) => g.drawImage(l.canvas, l.x - x, l.y - y), label || 'Crop', false);
  doc.layers.forEach((l, i) => { if (texts[i]) l.text = texts[i]; });
  history[hIndex].state = snapshot();
}
function cropToSelection() {
  if (!sel) { toast('Make a selection first, or use the Crop tool (C).'); return; }
  const b = sel.bounds; cropTo(b.x, b.y, b.w, b.h, 'Crop');
}
function trim() {
  const c = flatCanvas(), d = cx(c).getImageData(0, 0, doc.w, doc.h).data;
  let x0 = doc.w, y0 = doc.h, x1 = -1, y1 = -1;
  for (let y = 0; y < doc.h; y++) for (let x = 0; x < doc.w; x++) if (d[(y * doc.w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) { toast('The image is empty — nothing to trim to.'); return; }
  if (x0 === 0 && y0 === 0 && x1 === doc.w - 1 && y1 === doc.h - 1) { toast('There’s no transparent border to trim.'); return; }
  cropTo(x0, y0, x1 - x0 + 1, y1 - y0 + 1, 'Trim');
}
function rotateCanvas(deg) {
  const w = deg === 180 ? doc.w : doc.h, h = deg === 180 ? doc.h : doc.w;
  const W = doc.w, H = doc.h;
  remapDoc(w, h, (g, l) => {
    g.translate(w / 2, h / 2); g.rotate(deg * Math.PI / 180); g.translate(-W / 2, -H / 2);
    g.drawImage(l.canvas, l.x, l.y);
  }, deg === 180 ? 'Rotate 180°' : deg === 90 ? 'Rotate 90° Clockwise' : 'Rotate 90° Counter Clockwise', true);
}
function flipCanvas(horiz) {
  const W = doc.w, H = doc.h;
  remapDoc(W, H, (g, l) => { g.setTransform(horiz ? -1 : 1, 0, 0, horiz ? 1 : -1, horiz ? W : 0, horiz ? 0 : H); g.drawImage(l.canvas, l.x, l.y); },
    horiz ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical', true);
}
function imageSizeDialog() {
  if (!doc) return;
  const ratio = doc.w / doc.h;
  dialog({
    title: 'Image Size', okLabel: 'Resize',
    fields: [
      { k: 'w', label: 'Width (px)', type: 'number', v: doc.w, min: 1 },
      { k: 'h', label: 'Height (px)', type: 'number', v: doc.h, min: 1 },
      { k: 'lock', label: 'Keep proportions', type: 'check', v: true }],
    build(body, vals, inputs) {
      inputs.w.addEventListener('input', () => { if (vals.lock) { vals.h = Math.max(1, Math.round(vals.w / ratio)); inputs.h.value = vals.h; } });
      inputs.h.addEventListener('input', () => { if (vals.lock) { vals.w = Math.max(1, Math.round(vals.h * ratio)); inputs.w.value = vals.w; } });
      const p = document.createElement('div'); p.className = 'presets';
      for (const pc of [25, 50, 75, 200]) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = pc + '%';
        b.onclick = () => { vals.w = Math.max(1, Math.round(doc.w * pc / 100)); vals.h = Math.max(1, Math.round(doc.h * pc / 100)); inputs.w.value = vals.w; inputs.h.value = vals.h; };
        p.appendChild(b);
      }
      body.appendChild(p);
    },
    onOk(v) {
      let w = Math.round(v.w), h = Math.round(v.h);
      if (!(w > 0 && h > 0)) return toast('Enter a width and height.', true);
      if (w * h > MAX_PIXELS) return toast(`That’s larger than a browser can hold (${Math.round(MAX_PIXELS / 1e6)} megapixels).`, true);
      const W = doc.w, H = doc.h;
      remapDoc(w, h, (g, l) => g.drawImage(l.canvas, 0, 0, l.canvas.width, l.canvas.height, l.x * w / W, l.y * h / H, l.canvas.width * w / W, l.canvas.height * h / H), 'Image Size', true);
    },
  });
}
function canvasSizeDialog() {
  if (!doc) return;
  let ax = 1, ay = 1;
  dialog({
    title: 'Canvas Size', okLabel: 'Apply',
    fields: [
      { k: 'w', label: 'Width (px)', type: 'number', v: doc.w, min: 1 },
      { k: 'h', label: 'Height (px)', type: 'number', v: doc.h, min: 1 }],
    note: 'New area is transparent. Fill it on a layer below if you want a colour.',
    build(body) {
      const row = document.createElement('div'); row.className = 'row two';
      const s = document.createElement('span'); s.textContent = 'Anchor'; row.appendChild(s);
      const grid = document.createElement('div'); grid.className = 'anchor';
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
        const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', `Anchor ${x},${y}`);
        if (x === 1 && y === 1) b.classList.add('on');
        b.onclick = () => { ax = x; ay = y; grid.querySelectorAll('button').forEach(e => e.classList.remove('on')); b.classList.add('on'); };
        grid.appendChild(b);
      }
      row.appendChild(grid); body.appendChild(row);
    },
    onOk(v) {
      const w = Math.round(v.w), h = Math.round(v.h);
      if (!(w > 0 && h > 0)) return toast('Enter a width and height.', true);
      if (w * h > MAX_PIXELS) return toast('That’s larger than a browser can hold.', true);
      const dx = Math.round((w - doc.w) * ax / 2), dy = Math.round((h - doc.h) * ay / 2);
      const texts = doc.layers.map(l => l.text && { ...l.text, x: l.text.x + dx, y: l.text.y + dy });
      remapDoc(w, h, (g, l) => g.drawImage(l.canvas, l.x + dx, l.y + dy), 'Canvas Size', true);
      doc.layers.forEach((l, i) => { if (texts[i]) l.text = texts[i]; });
      history[hIndex].state = snapshot();
    },
  });
}
function newDialog() {
  dialog({
    title: 'New Image', okLabel: 'Create',
    fields: [
      { k: 'w', label: 'Width (px)', type: 'number', v: 1920, min: 1 },
      { k: 'h', label: 'Height (px)', type: 'number', v: 1080, min: 1 },
      { k: 'bg', label: 'Background', type: 'select', v: 'white', options: [['white', 'White'], ['black', 'Black'], ['fg', 'Foreground colour'], ['clear', 'Transparent']] }],
    onOk(v) {
      if (!(v.w > 0 && v.h > 0)) return toast('Enter a width and height.', true);
      if (dirty && !confirm('Start a new image? Changes to the current one will be lost — export it first if you want to keep it.')) return;
      newDoc(v.w, v.h, v.bg === 'clear' ? null : v.bg === 'fg' ? fg : v.bg === 'black' ? '#000' : '#fff');
      docName = 'untitled';
    },
  });
}
function exportDialog() {
  if (!doc) return toast('Open or create an image first.');
  dialog({
    title: 'Export', okLabel: 'Download',
    fields: [
      { k: 'name', label: 'File name', type: 'text', v: docName },
      { k: 'fmt', label: 'Format', type: 'select', v: 'png', options: [['png', 'PNG — lossless, keeps transparency'], ['jpeg', 'JPEG — smaller, for photos'], ['webp', 'WebP — smallest, keeps transparency']] },
      { k: 'q', label: 'Quality', min: 10, max: 100, v: 90, unit: '%' },
      { k: 's', label: 'Scale', min: 5, max: 100, v: 100, unit: '%' }],
    note: 'The file is made on this device and saved straight to your downloads.',
    onOk(v) {
      const w = Math.max(1, Math.round(doc.w * v.s / 100)), h = Math.max(1, Math.round(doc.h * v.s / 100));
      const flat = flatCanvas();
      const out = mk(w, h), g = cx(out); g.imageSmoothingQuality = 'high';
      if (v.fmt === 'jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }   // JPEG has no transparency; white beats black
      g.drawImage(flat, 0, 0, w, h);
      const type = 'image/' + v.fmt;
      out.toBlob(blob => {
        if (!blob) return toast('Export failed — try PNG, or a smaller scale.', true);
        if (blob.type !== type) toast('This browser can’t write ' + v.fmt.toUpperCase() + ', so it was saved as PNG.');
        const ext = blob.type.split('/')[1].replace('jpeg', 'jpg');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (v.name || 'image').replace(/[\\/:*?"<>|]+/g, '-') + '.' + ext;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        dirty = false; docName = v.name || docName;
        toast(`Saved ${a.download} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
      }, type, v.q / 100);
    },
  });
}

// ---------------------------------------------------------------- clipboard
function copySel(cut) {
  const l = requireLayer(); if (!l) return;
  const b = sel ? sel.bounds : { x: 0, y: 0, w: doc.w, h: doc.h };
  const c = mk(b.w, b.h), g = cx(c);
  g.drawImage(l.canvas, l.x - b.x, l.y - b.y);
  if (sel) { g.globalCompositeOperation = 'destination-in'; g.drawImage(sel.mask, -b.x, -b.y); }
  clipboard = c;
  // Also hand it to the system clipboard where allowed, so it pastes into other apps.
  try {
    if (navigator.clipboard && window.ClipboardItem) c.toBlob(blob => { navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {}); });
  } catch { /* the internal copy still works */ }
  if (cut) { if (sel) clearSelected(); else fillWith('rgba(0,0,0,0)', 'Cut'); }
  toast(cut ? 'Cut' : 'Copied');
}
async function pasteFromMenu() {
  try {
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const t = it.types.find(x => x.startsWith('image/'));
        if (t) { const blob = await it.getType(t); const img = await loadImageFile(blob); return placeImage(img, 'Pasted'); }
      }
    }
  } catch { /* fall back to the internal clipboard */ }
  if (clipboard) placeImage(clipboard, 'Pasted');
  else toast('Nothing to paste. Copy an image first, or press Ctrl/⌘ + V.');
}
document.addEventListener('paste', async e => {
  if (e.target.closest && e.target.closest('input,textarea')) return;
  const f = [...(e.clipboardData ? e.clipboardData.files : [])].find(f => f.type.startsWith('image/'));
  if (f) { e.preventDefault(); try { placeImage(await loadImageFile(f), 'Pasted'); } catch { toast('That clipboard image couldn’t be read.', true); } return; }
  if (clipboard) { e.preventDefault(); placeImage(clipboard, 'Pasted'); }
});

// ---------------------------------------------------------------- free transform
let xf = null;
function contentBounds(c) {
  const W = c.width, H = c.height, d = cx(c).getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) { const row = y * W * 4; for (let x = 0; x < W; x++) if (d[row + x * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function startTransform() {
  if (!doc || xf) return;
  const l = requireLayer(); if (!l) return;
  let src = l.canvas, rest = null, b;
  if (sel) {
    // Transform just the selected pixels, leaving a hole behind — like Photoshop.
    src = clone(l.canvas); const g = cx(src); g.globalCompositeOperation = 'destination-in'; g.drawImage(sel.mask, -l.x, -l.y);
    rest = clone(l.canvas); const r = cx(rest); r.globalCompositeOperation = 'destination-out'; r.drawImage(sel.mask, -l.x, -l.y);
  }
  b = contentBounds(src);
  if (!b) { toast('That layer is empty — there’s nothing to transform.'); return; }
  xf = { l, src, rest, b, cx: l.x + b.x + b.w / 2, cy: l.y + b.y + b.h / 2, sx: 1, sy: 1, rot: 0, drag: null };
  live = { id: l.id, draw: (g, L) => { if (xf.rest) g.drawImage(xf.rest, L.x, L.y); drawXf(g); } };
  setTool('move', true);
  renderOptions(); requestRender();
}
function drawXf(g) {
  g.save();
  g.imageSmoothingQuality = 'high';
  g.translate(xf.cx, xf.cy); g.rotate(xf.rot); g.scale(xf.sx, xf.sy);
  g.translate(-(xf.l.x + xf.b.x + xf.b.w / 2), -(xf.l.y + xf.b.y + xf.b.h / 2));
  g.drawImage(xf.src, xf.l.x, xf.l.y);
  g.restore();
}
function commitTransform() {
  if (!xf) return;
  const l = xf.l, c = mk(doc.w, doc.h), g = cx(c);
  if (xf.rest) g.drawImage(xf.rest, l.x, l.y);
  drawXf(g);
  l.canvas = c; l.x = 0; l.y = 0; l.text = null;
  if (sel) {
    // Carry the selection along with the pixels.
    const m = mk(doc.w, doc.h), mg = cx(m), s = xf;
    mg.translate(s.cx, s.cy); mg.rotate(s.rot); mg.scale(s.sx, s.sy); mg.translate(-(s.l.x + s.b.x + s.b.w / 2), -(s.l.y + s.b.y + s.b.h / 2));
    mg.drawImage(sel.mask, 0, 0);
    sel = buildSel(m);
  }
  xf = null; live = null; push('Free Transform'); renderOptions();
}
function cancelTransform() { if (!xf) return; xf = null; live = null; requestRender(); renderOptions(); }
function xfCorners() {
  const hw = xf.b.w * xf.sx / 2, hh = xf.b.h * xf.sy / 2, c = Math.cos(xf.rot), s = Math.sin(xf.rot);
  const P = (lx, ly) => ({ x: xf.cx + lx * c - ly * s, y: xf.cy + lx * s + ly * c });
  const pts = [];
  for (const [ix, iy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) pts.push({ ix, iy, ...P(ix * hw, iy * hh) });
  return pts;
}
function toLocal(p) {
  const c = Math.cos(-xf.rot), s = Math.sin(-xf.rot), dx = p.x - xf.cx, dy = p.y - xf.cy;
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}
function drawTransformUI(g, z) {
  const pts = xfCorners();
  g.beginPath(); [0, 2, 4, 6].forEach((i, k) => { const p = pts[i]; k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }); g.closePath();
  g.lineWidth = 1 / z; g.strokeStyle = '#00b0ec'; g.stroke();
  const hs = 8 / z;
  for (const p of pts) { g.fillStyle = '#fff'; g.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs); g.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs); }
}
function xfDown(p, e) {
  const z = view.zoom, pts = xfCorners();
  const hit = pts.find(q => Math.abs(q.x - p.x) < 10 / z && Math.abs(q.y - p.y) < 10 / z);
  const loc = toLocal(p), hw = xf.b.w * xf.sx / 2, hh = xf.b.h * xf.sy / 2;
  if (hit) xf.drag = { kind: 'scale', ix: hit.ix, iy: hit.iy, free: e.shiftKey };
  else if (Math.abs(loc.x) <= hw && Math.abs(loc.y) <= hh) xf.drag = { kind: 'move', p0: p, c0: { x: xf.cx, y: xf.cy } };
  else xf.drag = { kind: 'rot', a0: Math.atan2(p.y - xf.cy, p.x - xf.cx), r0: xf.rot };
}
function xfMove(p, e) {
  const d = xf.drag; if (!d) return;
  if (d.kind === 'move') { xf.cx = d.c0.x + p.x - d.p0.x; xf.cy = d.c0.y + p.y - d.p0.y; }
  else if (d.kind === 'rot') {
    let r = d.r0 + Math.atan2(p.y - xf.cy, p.x - xf.cx) - d.a0;
    if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
    xf.rot = r;
  } else {
    const hw = xf.b.w * xf.sx / 2, hh = xf.b.h * xf.sy / 2, loc = toLocal(p);
    const ax = -d.ix * hw, ay = -d.iy * hh;          // the opposite handle stays put
    let w = d.ix ? Math.max(1, Math.abs(loc.x - ax)) : hw * 2;
    let h = d.iy ? Math.max(1, Math.abs(loc.y - ay)) : hh * 2;
    if (d.ix && d.iy && !e.shiftKey) {               // corners keep proportions unless Shift is held
      const k = Math.max(w / (hw * 2), h / (hh * 2)); w = hw * 2 * k; h = hh * 2 * k;
    }
    xf.sx = w / xf.b.w; xf.sy = h / xf.b.h;
    const ncx = ax + (d.ix ? Math.sign(loc.x - ax || d.ix) * w / 2 : 0), ncy = ay + (d.iy ? Math.sign(loc.y - ay || d.iy) * h / 2 : 0);
    const c = Math.cos(xf.rot), s = Math.sin(xf.rot);
    const lx = d.ix ? ncx : 0, ly = d.iy ? ncy : 0;
    xf.cx += lx * c - ly * s; xf.cy += lx * s + ly * c;
  }
  requestRender();
}

// ---------------------------------------------------------------- text
let textEditing = null;   // {layerId|null, x, y, t}
const textEl = $('textEdit');
function fontCss(t, z = 1) { return `${t.italic ? 'italic ' : ''}${t.bold ? 700 : 400} ${t.size * z}px ${t.family}`; }
function rasterText(t) {
  const c = mk(doc.w, doc.h), g = cx(c);
  g.font = fontCss(t); g.fillStyle = t.color; g.textBaseline = 'top';
  t.str.split('\n').forEach((ln, i) => g.fillText(ln, t.x, t.y + t.size * 0.1 + i * t.size * 1.2));
  return c;
}
function textBox(t) {
  const g = cx(mk(1, 1)); g.font = fontCss(t);
  const lines = t.str.split('\n');
  return { x: t.x, y: t.y, w: Math.max(...lines.map(s => g.measureText(s).width), t.size * 0.5), h: lines.length * t.size * 1.2 };
}
function beginText(p) {
  const l = active();
  if (l && l.text && l.visible) {
    const b = textBox(l.text);
    if (p.x >= b.x + l.x - 6 && p.x <= b.x + l.x + b.w + 6 && p.y >= b.y + l.y - 6 && p.y <= b.y + l.y + b.h + 6) {
      textEditing = { layerId: l.id, t: { ...l.text, x: l.text.x + l.x, y: l.text.y + l.y } };
      Object.assign(opt.text, { family: l.text.family, size: l.text.size, bold: l.text.bold, italic: l.text.italic });
      renderOptions();
      showTextEdit(); requestRender(); return;
    }
  }
  const o = opt.text;
  textEditing = { layerId: null, t: { str: '', x: Math.round(p.x), y: Math.round(p.y - o.size * 0.6), family: o.family, size: o.size, bold: o.bold, italic: o.italic, color: fg } };
  showTextEdit();
}
function showTextEdit() {
  const t = textEditing.t;
  textEl.hidden = false; textEl.value = t.str;
  positionTextEdit();
  textEl.focus();
  setTimeout(() => textEl.focus(), 0);
  renderOptions();
}
function positionTextEdit() {
  const t = textEditing.t, z = view.zoom;
  Object.assign(t, { family: opt.text.family, size: opt.text.size, bold: opt.text.bold, italic: opt.text.italic });
  textEl.style.font = fontCss(t, z);
  textEl.style.lineHeight = '1.2';
  textEl.style.color = t.color;
  textEl.style.left = (view.px + t.x * z) + 'px';
  textEl.style.top = (view.py + t.y * z) + 'px';
  textEl.style.width = '0px'; textEl.style.height = '0px';
  textEl.style.width = (textEl.scrollWidth + t.size * z * 0.6) + 'px';
  textEl.style.height = textEl.scrollHeight + 'px';
}
textEl.addEventListener('input', () => { if (textEditing) { textEditing.t.str = textEl.value; positionTextEdit(); } });
textEl.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); endText(false); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); endText(true); }
});
function endText(commit) {
  if (!textEditing) return;
  const te = textEditing; textEditing = null;
  textEl.hidden = true; textEl.blur();
  const t = te.t; t.str = textEl.value.replace(/\s+$/, '');
  Object.assign(t, { family: opt.text.family, size: opt.text.size, bold: opt.text.bold, italic: opt.text.italic });
  if (commit) {
    const existing = te.layerId && layerById(te.layerId);
    if (!t.str) {
      if (existing) { doc.layers = doc.layers.filter(l => l !== existing); if (!doc.layers.length) doc.layers.push(newLayer('Background')); doc.active = doc.layers[doc.layers.length - 1].id; push('Delete Text'); }
    } else if (existing) {
      existing.canvas = rasterText(t); existing.x = 0; existing.y = 0; existing.text = t;
      existing.name = t.str.split('\n')[0].slice(0, 28); push('Edit Text');
    } else {
      const L = newLayer(t.str.split('\n')[0].slice(0, 28), rasterText(t)); L.text = t; insertLayer(L); push('Type Layer');
    }
  }
  renderOptions(); requestRender();
}

// ---------------------------------------------------------------- tools
const ICON = {
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  marquee: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.5"/>',
  lasso: '<path d="M7 17c-3-2-3.5-6 0-9s10-3 12 0-1 8-7 8c-2 0-3.5-.5-5-1"/><path d="M7 17c-1 1.5-.5 3.5 1.5 3.5"/>',
  wand: '<path d="M4 20 15 9M14 4v3M19 9h-3M17.5 5.5l-2 2M11 6.5l1.5 1.5M17 12l-1.5-1.5"/>',
  crop: '<path d="M6 2v16h16M2 6h16v16"/>',
  eyedropper: '<path d="m14 4 6 6M17 7l-10 10-4 1 1-4L14 4"/>',
  brush: '<path d="M9.5 14.5 19 5a1.4 1.4 0 0 1 2 2l-9.5 9.5"/><path d="M9.5 14.5c-2 0-3.5 1.5-3.5 3.5 0 1-1 2-2.5 2 1.5 1 6 1 7.5-1 1-1.3.5-3-1.5-4.5z"/>',
  eraser: '<path d="m8 20-4-4a1.5 1.5 0 0 1 0-2L14 4a1.5 1.5 0 0 1 2 0l4 4a1.5 1.5 0 0 1 0 2l-9 10H8zM20 20h-9M7 11l6 6"/>',
  clone: '<circle cx="12" cy="7" r="3.5"/><path d="M12 10.5V14M6 14h12v3H6zM8 17v3h8v-3"/>',
  fill: '<path d="m5 11 7-7 7 7-7 7zM19 11c0 0 2 2.5 2 4a2 2 0 0 1-4 0c0-1.5 2-4 2-4zM5 11h14"/>',
  gradient: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14M13 5v14" stroke-dasharray="2 2"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  shape: '<rect x="3" y="10" width="11" height="11" rx="1"/><circle cx="15.5" cy="8.5" r="5.5"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.5 16a1.5 1.5 0 0 1 2.4-1.8L8 16"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.5-4.5M8 10.5h5M10.5 8v5"/>',
};
let drag = null;           // current tool gesture
let panState = null, spaceDown = false;

function sizeOpt(o) { return () => o.size * view.zoom >= 3 ? o.size : 3 / view.zoom; }
function paintTool(name, erase) {
  const o = opt[name];
  return {
    label: erase ? 'Eraser' : 'Brush', key: erase ? 'e' : 'b', cursor: 'none', brushSize: sizeOpt(o),
    hint: erase ? 'Drag to erase. Shift-click draws a straight line. [ ] change size.' : 'Drag to paint. Alt-click picks a colour. Shift-click draws a straight line. [ ] change size.',
    down(p, e) {
      if (!erase && e.altKey) { pickColor(p, false); return; }
      const l = requireLayer(); if (!l) return;
      const st = makeStroke(erase ? '#000000' : fg, o);
      if (e.shiftKey && this.lastPt) strokeTo(st, this.lastPt);
      strokeTo(st, p, e.pointerType === 'pen' ? e.pressure : null);
      drag = { l, st };
      this.preview();
    },
    move(p, e) {
      if (!drag) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) strokeTo(drag.st, toDoc(ev), ev.pointerType === 'pen' ? ev.pressure : null);
      this.preview();
    },
    paint(g) {
      const { l, st } = drag;
      g.globalAlpha = o.opacity / 100;
      g.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      g.drawImage(st.c, -l.x, -l.y);
    },
    preview() { live = { id: drag.l.id, canvas: editedCanvas(drag.l, g => this.paint(g), false) }; requestRender(); },
    up() {
      if (!drag) return;
      this.lastPt = drag.st.last;
      commitPaint(drag.l, g => this.paint(g), erase ? 'Eraser' : 'Brush');
      drag = null;
    },
    options: () => [range('Size', o, 'size', 1, 500, 'px'), range('Hardness', o, 'hard', 0, 100, '%'), range('Opacity', o, 'opacity', 1, 100, '%')],
  };
}
const TOOLS = {
  move: {
    label: 'Move', key: 'v', cursor: 'move',
    hint: 'Drag to move the layer (or the selected pixels). Arrow keys nudge. Ctrl/⌘+T to scale and rotate.',
    down(p, e) {
      if (xf) { xfDown(p, e); return; }
      let l = active();
      if (opt.move.auto || e.ctrlKey || e.metaKey) {
        const hit = pickLayerAt(p); if (hit) { l = hit; doc.active = hit.id; refreshLayers(); }
      }
      if (!l) return;
      if (!l.visible) return toast('That layer is hidden — show it to move it.');
      if (sel) {
        // Float the selected pixels: cut them out, drag them, drop them back in.
        const f = clone(l.canvas), fg_ = cx(f); fg_.globalCompositeOperation = 'destination-in'; fg_.drawImage(sel.mask, -l.x, -l.y);
        const base = clone(l.canvas), bg2 = cx(base); bg2.globalCompositeOperation = 'destination-out'; bg2.drawImage(sel.mask, -l.x, -l.y);
        drag = { l, p0: p, dx: 0, dy: 0, f, base, copy: e.altKey };
        live = { id: l.id, draw: (g, L) => { g.drawImage(drag.copy ? L.canvas : drag.base, L.x, L.y); g.drawImage(drag.f, L.x + drag.dx, L.y + drag.dy); } };
      } else drag = { l, p0: p, x0: l.x, y0: l.y };
    },
    move(p, e) {
      if (xf) { xfMove(p, e); return; }
      if (!drag) return;
      let dx = Math.round(p.x - drag.p0.x), dy = Math.round(p.y - drag.p0.y);
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (drag.f) { drag.dx = dx; drag.dy = dy; }
      else { drag.l.x = drag.x0 + dx; drag.l.y = drag.y0 + dy; }
      requestRender();
    },
    up() {
      if (xf) { if (xf.drag) { xf.drag = null; renderOptions(); } return; }
      if (!drag) return;
      const d = drag; drag = null;
      if (d.f) {
        live = null;
        if (!d.dx && !d.dy) { requestRender(); return; }
        const c = mk(d.l.canvas.width, d.l.canvas.height), g = cx(c);
        g.drawImage(d.copy ? d.l.canvas : d.base, 0, 0); g.drawImage(d.f, d.dx, d.dy);
        d.l.canvas = c; d.l.text = null;
        const m = mk(doc.w, doc.h); cx(m).drawImage(sel.mask, d.dx, d.dy); sel = buildSel(m);
        push('Move');
      } else if (d.l.x !== d.x0 || d.l.y !== d.y0) push('Move');
    },
    options() {
      if (xf) {
        return [el('span', 'hint', 'Drag inside to move, a handle to scale (Shift frees the ratio), outside to rotate.'),
          numIn('W', Math.round(xf.sx * 100), v => { xf.sx = v / 100; requestRender(); }, '%'),
          numIn('H', Math.round(xf.sy * 100), v => { xf.sy = v / 100; requestRender(); }, '%'),
          numIn('∠', Math.round(xf.rot * 180 / Math.PI * 10) / 10, v => { xf.rot = v * Math.PI / 180; requestRender(); }, '°'),
          btn('Apply ✓', commitTransform), btn('Cancel', cancelTransform)];
      }
      return [check('Auto-select layer', opt.move, 'auto'), btn('Free Transform', startTransform), btn('Flip ↔', () => flipLayer(true)), btn('Flip ↕', () => flipLayer(false))];
    },
  },
  marquee: {
    label: 'Marquee', key: 'm', cursor: 'crosshair',
    hint: 'Drag to select. Shift adds, Alt subtracts. Delete clears, Ctrl/⌘+J copies to a new layer.',
    down(p, e) { drag = { p0: p, p1: p, mode: modeFrom(e) }; },
    move(p, e) {
      if (!drag) return;
      if (e.shiftKey && drag.mode === 'new') { const s = Math.max(Math.abs(p.x - drag.p0.x), Math.abs(p.y - drag.p0.y)); p = { x: drag.p0.x + Math.sign(p.x - drag.p0.x) * s, y: drag.p0.y + Math.sign(p.y - drag.p0.y) * s }; }
      drag.p1 = p; requestUI();
    },
    up() {
      if (!drag) return;
      const r = normRect(drag.p0, drag.p1), mode = drag.mode; drag = null;
      if (r.w < 2 && r.h < 2) { if (mode === 'new') deselect(); requestUI(); return; }
      const m = mk(doc.w, doc.h), g = cx(m); g.fillStyle = '#fff';
      if (opt.marquee.shape === 'ellipse') { g.beginPath(); g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); g.fill(); }
      else g.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      setSelection(combineSel(m, mode, opt.marquee.feather), opt.marquee.shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
    },
    drawUI(g, z) {
      if (!drag) return;
      const r = normRect(drag.p0, drag.p1);
      if (opt.marquee.shape === 'ellipse') {
        g.beginPath(); g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 || 0.1, r.h / 2 || 0.1, 0, 0, Math.PI * 2);
        g.lineWidth = 1 / z; g.strokeStyle = '#fff'; g.stroke(); g.setLineDash([4 / z, 4 / z]); g.strokeStyle = '#000'; g.stroke(); g.setLineDash([]);
      } else dashRect(g, r.x, r.y, r.w, r.h, z);
    },
    options: () => [selModes(), seg('Shape', opt.marquee, 'shape', [['rect', 'Rectangle'], ['ellipse', 'Ellipse']]), range('Feather', opt.marquee, 'feather', 0, 100, 'px'), btn('Select All', selectAll), btn('Deselect', deselect), btn('Inverse', invertSel)],
  },
  lasso: {
    label: 'Lasso', key: 'l', cursor: 'crosshair',
    hint: 'Draw around what you want. Shift adds, Alt subtracts.',
    down(p, e) { drag = { pts: [p], mode: modeFrom(e) }; },
    move(p) { if (drag) { drag.pts.push(p); requestUI(); } },
    up() {
      if (!drag) return;
      const { pts, mode } = drag; drag = null;
      if (pts.length < 3) { if (mode === 'new') deselect(); return; }
      const m = mk(doc.w, doc.h), g = cx(m); g.fillStyle = '#fff'; g.beginPath();
      pts.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)); g.closePath(); g.fill();
      setSelection(combineSel(m, mode, opt.lasso.feather), 'Lasso');
    },
    drawUI(g, z) {
      if (!drag) return;
      g.beginPath(); drag.pts.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y));
      g.lineWidth = 1 / z; g.strokeStyle = '#fff'; g.stroke(); g.setLineDash([4 / z, 4 / z]); g.strokeStyle = '#000'; g.stroke(); g.setLineDash([]);
    },
    options: () => [selModes(), range('Feather', opt.lasso, 'feather', 0, 100, 'px'), btn('Deselect', deselect)],
  },
  wand: {
    label: 'Magic Wand', key: 'w', cursor: 'crosshair',
    hint: 'Click an area of similar colour to select it. Shift adds, Alt subtracts.',
    down(p, e) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
      const l = active();
      const src = opt.wand.all || !l ? flatCanvas() : layerInDoc(l);
      const d = cx(src).getImageData(0, 0, doc.w, doc.h).data;
      const bits = colorMatch(d, doc.w, doc.h, x, y, opt.wand.tol, opt.wand.contiguous);
      setSelection(combineSel(maskCanvas(bits, doc.w, doc.h), modeFrom(e), 0), 'Magic Wand');
    },
    options: () => [selModes(), range('Tolerance', opt.wand, 'tol', 0, 255, ''), check('Contiguous', opt.wand, 'contiguous'), check('Sample all layers', opt.wand, 'all'), btn('Deselect', deselect)],
  },
  crop: {
    label: 'Crop', key: 'c', cursor: 'crosshair',
    hint: 'Drag the area to keep, then press Enter or Apply. Esc cancels.',
    rect: null,
    down(p) {
      const r = this.rect, z = view.zoom;
      if (r && p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h && !(Math.abs(p.x - r.x - r.w) < 12 / z && Math.abs(p.y - r.y - r.h) < 12 / z)) drag = { move: true, p0: p, r0: { ...r } };
      else if (r && Math.abs(p.x - r.x - r.w) < 12 / z && Math.abs(p.y - r.y - r.h) < 12 / z) drag = { corner: true };
      else { drag = { p0: p }; this.rect = { x: p.x, y: p.y, w: 0, h: 0 }; }
      renderOptions();
    },
    move(p) {
      if (!drag) return;
      const r = this.rect;
      if (drag.move) { r.x = drag.r0.x + p.x - drag.p0.x; r.y = drag.r0.y + p.y - drag.p0.y; }
      else if (drag.corner) { r.w = Math.max(1, p.x - r.x); r.h = Math.max(1, p.y - r.y); }
      else this.rect = normRect(drag.p0, p);
      requestUI();
    },
    up() {
      drag = null;
      const r = this.rect;
      if (r) {
        const x0 = clamp(Math.round(r.x), 0, doc.w), y0 = clamp(Math.round(r.y), 0, doc.h);
        const x1 = clamp(Math.round(r.x + r.w), 0, doc.w), y1 = clamp(Math.round(r.y + r.h), 0, doc.h);
        this.rect = x1 - x0 >= 2 && y1 - y0 >= 2 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
      }
      requestUI(); renderOptions();
    },
    apply() { const r = this.rect; if (!r) return; this.rect = null; cropTo(r.x, r.y, r.w, r.h, 'Crop'); renderOptions(); },
    cancel() { this.rect = null; requestUI(); renderOptions(); },
    drawUI(g, z) {
      const r = this.rect; if (!r) return;
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.beginPath(); g.rect(-1e5, -1e5, 2e5, 2e5); g.rect(r.x, r.y + r.h, r.w, -r.h); g.fill('evenodd');
      g.lineWidth = 1 / z; g.strokeStyle = '#fff'; g.strokeRect(r.x, r.y, r.w, r.h);
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath();
      for (let i = 1; i < 3; i++) { g.moveTo(r.x + r.w * i / 3, r.y); g.lineTo(r.x + r.w * i / 3, r.y + r.h); g.moveTo(r.x, r.y + r.h * i / 3); g.lineTo(r.x + r.w, r.y + r.h * i / 3); }
      g.stroke();
      const hs = 9 / z; g.fillStyle = '#fff'; g.fillRect(r.x + r.w - hs / 2, r.y + r.h - hs / 2, hs, hs);
    },
    options() {
      const r = this.rect;
      return [el('span', 'hint', r ? `${r.w} × ${r.h} px` : 'Drag across the image'),
        btn('Apply ✓', () => this.apply(), !r), btn('Cancel', () => this.cancel(), !r), btn('Crop to Selection', cropToSelection), btn('Trim Transparent', trim)];
    },
  },
  eyedropper: {
    label: 'Eyedropper', key: 'i', cursor: 'crosshair',
    hint: 'Click to pick the foreground colour. Alt-click picks the background colour.',
    down(p, e) { pickColor(p, e.altKey); drag = { alt: e.altKey }; },
    move(p) { if (drag) pickColor(p, drag.alt); },
    up() { drag = null; },
    options: () => [check('Sample all layers', opt.eyedropper, 'all')],
  },
  brush: paintTool('brush', false),
  eraser: paintTool('eraser', true),
  clone: {
    label: 'Clone Stamp', key: 's', cursor: 'none', brushSize: sizeOpt(opt.clone),
    hint: 'Alt-click (or tap “Set source”) where to copy from, then paint where it should go.',
    src: null, off: null, arming: false,
    down(p, e) {
      if (e.altKey || this.arming) { this.src = p; this.off = null; this.arming = false; renderOptions(); toast('Source set — now paint where you want it copied.'); return; }
      if (!this.src) { toast('Alt-click, or tap “Set source”, to choose where to copy from first.'); return; }
      const l = requireLayer(); if (!l) return;
      if (!this.off) this.off = { x: this.src.x - p.x, y: this.src.y - p.y };   // aligned: the offset holds for later strokes
      const st = makeStroke('#ffffff', opt.clone);
      strokeTo(st, p, e.pointerType === 'pen' ? e.pressure : null);
      drag = { l, st, srcC: clone(l.canvas), tmp: mk(doc.w, doc.h) };
      this.preview();
    },
    move(p, e) {
      if (!drag) { if (this.src && this.off) requestUI(); return; }
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) strokeTo(drag.st, toDoc(ev), ev.pointerType === 'pen' ? ev.pressure : null);
      this.preview();
    },
    paint(g) {
      const { l, st, srcC, tmp } = drag, t = cx(tmp);
      t.globalCompositeOperation = 'copy'; t.drawImage(srcC, l.x - this.off.x, l.y - this.off.y);
      t.globalCompositeOperation = 'destination-in'; t.drawImage(st.c, 0, 0);
      g.globalAlpha = opt.clone.opacity / 100; g.drawImage(tmp, -l.x, -l.y);
    },
    preview() { live = { id: drag.l.id, canvas: editedCanvas(drag.l, g => this.paint(g), false) }; requestRender(); },
    up() { if (!drag) return; commitPaint(drag.l, g => this.paint(g), 'Clone Stamp'); drag = null; },
    drawUI(g, z) {
      if (!this.src) return;
      let s = this.src;
      if (this.off && cursorPos) s = { x: cursorPos.x + this.off.x, y: cursorPos.y + this.off.y };
      g.lineWidth = 1 / z; g.strokeStyle = '#fff';
      g.beginPath(); g.moveTo(s.x - 8 / z, s.y); g.lineTo(s.x + 8 / z, s.y); g.moveTo(s.x, s.y - 8 / z); g.lineTo(s.x, s.y + 8 / z); g.stroke();
      g.beginPath(); g.arc(s.x, s.y, opt.clone.size / 2, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,255,255,.5)'; g.stroke();
    },
    options() {
      return [btn(this.arming ? 'Tap the source…' : 'Set source', () => { this.arming = !this.arming; renderOptions(); }, false, this.arming),
        range('Size', opt.clone, 'size', 1, 500, 'px'), range('Hardness', opt.clone, 'hard', 0, 100, '%'), range('Opacity', opt.clone, 'opacity', 1, 100, '%')];
    },
  },
  fill: {
    label: 'Paint Bucket', key: 'g', cursor: 'crosshair',
    hint: 'Click to fill an area of similar colour with the foreground colour.',
    down(p) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
      const l = requireLayer(); if (!l) return;
      const src = opt.fill.all ? flatCanvas() : layerInDoc(l);
      const bits = colorMatch(cx(src).getImageData(0, 0, doc.w, doc.h).data, doc.w, doc.h, x, y, opt.fill.tol, opt.fill.contiguous);
      const m = maskCanvas(bits, doc.w, doc.h), mg = cx(m);
      mg.globalCompositeOperation = 'source-in'; mg.fillStyle = fg; mg.fillRect(0, 0, doc.w, doc.h);
      commitPaint(l, g => { g.globalAlpha = opt.fill.opacity / 100; g.drawImage(m, -l.x, -l.y); }, 'Paint Bucket');
    },
    options: () => [range('Tolerance', opt.fill, 'tol', 0, 255, ''), range('Opacity', opt.fill, 'opacity', 1, 100, '%'), check('Contiguous', opt.fill, 'contiguous'), check('Sample all layers', opt.fill, 'all'), btn('Fill Selection', () => fillWith(fg, 'Fill'))],
  },
  gradient: {
    label: 'Gradient', key: 'G', cursor: 'crosshair',
    hint: 'Drag to lay a gradient from the foreground to the background colour. Shift snaps the angle.',
    down(p) { const l = requireLayer(); if (!l) return; drag = { l, p0: p, p1: p }; },
    move(p, e) {
      if (!drag) return;
      if (e.shiftKey) { const a = Math.round(Math.atan2(p.y - drag.p0.y, p.x - drag.p0.x) / (Math.PI / 4)) * Math.PI / 4, d = Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y); p = { x: drag.p0.x + Math.cos(a) * d, y: drag.p0.y + Math.sin(a) * d }; }
      drag.p1 = p;
      live = { id: drag.l.id, canvas: editedCanvas(drag.l, g => this.paint(g), false) }; requestRender();
    },
    paint(g) {
      const { l, p0, p1 } = drag, o = opt.gradient;
      const a = { x: p0.x - l.x, y: p0.y - l.y }, b = { x: p1.x - l.x, y: p1.y - l.y };
      const gr = o.kind === 'radial' ? g.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) : g.createLinearGradient(a.x, a.y, b.x, b.y);
      gr.addColorStop(0, fg); gr.addColorStop(1, o.toClear ? fg + '00' : bg);
      g.globalAlpha = o.opacity / 100; g.fillStyle = gr; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    },
    up() {
      if (!drag) return;
      if (Math.hypot(drag.p1.x - drag.p0.x, drag.p1.y - drag.p0.y) < 2) { drag = null; live = null; requestRender(); return; }
      commitPaint(drag.l, g => this.paint(g), 'Gradient'); drag = null;
    },
    drawUI(g, z) {
      if (!drag) return;
      g.beginPath(); g.moveTo(drag.p0.x, drag.p0.y); g.lineTo(drag.p1.x, drag.p1.y);
      g.lineWidth = 3 / z; g.strokeStyle = 'rgba(0,0,0,.5)'; g.stroke(); g.lineWidth = 1 / z; g.strokeStyle = '#fff'; g.stroke();
    },
    options: () => [seg('Type', opt.gradient, 'kind', [['linear', 'Linear'], ['radial', 'Radial']]), check('Fade to transparent', opt.gradient, 'toClear'), range('Opacity', opt.gradient, 'opacity', 1, 100, '%')],
  },
  text: {
    label: 'Type', key: 't', cursor: 'text',
    hint: 'Click to add text, or click existing text on the selected layer to edit it. Ctrl/⌘+Enter to finish.',
    down(p) { if (textEditing) { endText(true); return; } beginText(p); },
    options() {
      const o = opt.text, fonts = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'system-ui'];
      const upd = () => { if (textEditing) positionTextEdit(); };
      const out = [selectIn(fonts.map(f => [f, f]), o.family, v => { o.family = v; upd(); }),
        numIn('Size', o.size, v => { o.size = clamp(v, 4, 2000); upd(); }, 'px'),
        btn('B', () => { o.bold = !o.bold; upd(); renderOptions(); }, false, o.bold),
        btn('I', () => { o.italic = !o.italic; upd(); renderOptions(); }, false, o.italic)];
      if (textEditing) out.push(btn('Done ✓', () => endText(true)), btn('Cancel', () => endText(false)));
      else out.push(el('span', 'hint', 'Colour = foreground swatch'));
      return out;
    },
  },
  shape: {
    label: 'Shape', key: 'u', cursor: 'crosshair',
    hint: 'Drag to draw a shape on a new layer. Shift keeps it square, or snaps a line’s angle.',
    down(p) { drag = { p0: p, p1: p }; },
    move(p, e) {
      if (!drag) return;
      if (e.shiftKey) {
        if (opt.shape.kind === 'line') { const a = Math.round(Math.atan2(p.y - drag.p0.y, p.x - drag.p0.x) / (Math.PI / 4)) * Math.PI / 4, d = Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y); p = { x: drag.p0.x + Math.cos(a) * d, y: drag.p0.y + Math.sin(a) * d }; }
        else { const s = Math.max(Math.abs(p.x - drag.p0.x), Math.abs(p.y - drag.p0.y)); p = { x: drag.p0.x + Math.sign(p.x - drag.p0.x || 1) * s, y: drag.p0.y + Math.sign(p.y - drag.p0.y || 1) * s }; }
      }
      drag.p1 = p; requestUI();
    },
    draw(g, p0, p1) {
      const o = opt.shape, r = normRect(p0, p1);
      g.fillStyle = fg; g.strokeStyle = fg; g.lineWidth = o.stroke; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      if (o.kind === 'line') { g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke(); return; }
      if (o.kind === 'ellipse') g.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w / 2, 0.5), Math.max(r.h / 2, 0.5), 0, 0, Math.PI * 2);
      else g.rect(r.x, r.y, r.w, r.h);
      if (o.fill) g.fill(); else g.stroke();
    },
    up() {
      if (!drag) return;
      const { p0, p1 } = drag; drag = null;
      if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 2) { requestUI(); return; }
      const L = newLayer({ rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' }[opt.shape.kind]);
      this.draw(cx(L.canvas), p0, p1);
      insertLayer(L); push('Shape');
    },
    drawUI(g) { if (drag) { g.globalAlpha = 0.85; this.draw(g, drag.p0, drag.p1); g.globalAlpha = 1; } },
    options: () => [seg('Shape', opt.shape, 'kind', [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line']]),
      seg('Style', opt.shape, 'fill', [[true, 'Filled'], [false, 'Outline']]), range('Stroke', opt.shape, 'stroke', 1, 200, 'px')],
  },
  hand: {
    label: 'Hand', key: 'h', cursor: 'grab', hint: 'Drag to scroll around. Hold Space with any tool to do the same.',
    down() {}, options: () => [btn('Fit on Screen', fit), btn('100%', () => zoomAt(1))],
  },
  zoom: {
    label: 'Zoom', key: 'z', cursor: 'zoom-in', hint: 'Click to zoom in, Alt-click to zoom out. Ctrl/⌘ + scroll zooms anywhere.',
    down(p, e) { const r = work.getBoundingClientRect(); zoomStep(e.altKey ? -1 : 1, e.clientX - r.left, e.clientY - r.top); },
    options: () => [btn('Zoom In', () => zoomStep(1)), btn('Zoom Out', () => zoomStep(-1)), btn('Fit on Screen', fit), btn('100%', () => zoomAt(1))],
  },
};
const TOOL_ORDER = ['move', 'marquee', 'lasso', 'wand', 'crop', 'eyedropper', '|', 'brush', 'eraser', 'clone', 'fill', 'gradient', '|', 'text', 'shape', '|', 'hand', 'zoom'];

function busyTool() { return !!(drag || xf || textEditing); }
function modeFrom(e) { return e.shiftKey && e.altKey ? 'int' : e.shiftKey ? 'add' : e.altKey ? 'sub' : selMode; }
function normRect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; }
function pickLayerAt(p) {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.visible) continue;
    const lx = x - l.x, ly = y - l.y;
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) continue;
    if (cx(l.canvas).getImageData(lx, ly, 1, 1).data[3] > 10) return l;
  }
  return null;
}
function pickColor(p, toBg) {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return;
  let d;
  if (opt.eyedropper.all || !active()) d = cx(viewC).getImageData(x, y, 1, 1).data;
  else { const l = active(); d = cx(l.canvas).getImageData(x - l.x, y - l.y, 1, 1).data; }
  if (!d[3]) return;
  const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  if (toBg) bg = hex; else fg = hex;
  refreshSwatches();
}

// ---------------------------------------------------------------- options-bar widgets
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function btn(label, fn, disabled, on) { const b = el('button', on ? 'on' : '', label); b.type = 'button'; b.disabled = !!disabled; b.onclick = fn; return b; }
function range(label, o, k, min, max, unit) {
  const lab = el('label'); lab.append(label + ' ');
  const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.value = o[k];
  const v = el('span', 'val', o[k] + unit);
  r.oninput = () => { o[k] = +r.value; v.textContent = o[k] + unit; requestUI(); };
  r.id = 'opt-' + label.toLowerCase();
  lab.append(r, v); return lab;
}
function check(label, o, k) {
  const lab = el('label'); const c = el('input'); c.type = 'checkbox'; c.checked = !!o[k];
  c.onchange = () => { o[k] = c.checked; }; lab.append(c, label); return lab;
}
function seg(label, o, k, items) {
  const w = el('span', 'seg'); w.setAttribute('role', 'group'); w.setAttribute('aria-label', label);
  for (const [v, t] of items) w.appendChild(btn(t, () => { o[k] = v; renderOptions(); }, false, o[k] === v));
  return w;
}
function selModes() {
  const w = el('span', 'seg'); w.setAttribute('aria-label', 'Selection mode');
  for (const [v, t, tip] of [['new', 'New', 'New selection'], ['add', '+', 'Add (Shift)'], ['sub', '−', 'Subtract (Alt)'], ['int', '∩', 'Intersect (Shift+Alt)']]) {
    const b = btn(t, () => { selMode = v; renderOptions(); }, false, selMode === v); b.title = tip; w.appendChild(b);
  }
  return w;
}
function numIn(label, val, fn, unit) {
  const lab = el('label'); lab.append(label + ' ');
  const i = el('input'); i.type = 'number'; i.value = val; i.oninput = () => { if (i.value !== '' && isFinite(+i.value)) fn(+i.value); };
  lab.append(i); if (unit) lab.append(unit); return lab;
}
function selectIn(items, val, fn) {
  const s = el('select'); for (const [v, t] of items) { const o = el('option', null, t); o.value = v; s.appendChild(o); }
  s.value = val; s.onchange = () => fn(s.value); return s;
}
function renderOptions() {
  const bar = $('opts'); bar.innerHTML = '';
  const T = TOOLS[tool];
  bar.appendChild(el('span', 'tname', xf ? 'Free Transform' : T.label));
  for (const w of (T.options ? T.options.call(T) : [])) bar.appendChild(w);
  $('stHint').textContent = xf ? 'Enter applies, Esc cancels.' : T.hint || '';
}

// ---------------------------------------------------------------- tool bar
function buildTools() {
  const bar = $('tools');
  for (const k of TOOL_ORDER) {
    if (k === '|') { bar.appendChild(el('div', 'tsep')); continue; }
    const T = TOOLS[k], b = el('button', 'tool');
    b.type = 'button'; b.dataset.tool = k;
    const key = T.key === 'G' ? 'Shift+G' : T.key.toUpperCase();
    b.title = `${T.label} (${key})`; b.setAttribute('aria-label', T.label);
    b.innerHTML = `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;
    b.onclick = () => setTool(k);
    bar.appendChild(b);
  }
  const sw = el('div', 'swatches');
  sw.innerHTML = '<button type="button" class="sw" id="bgSw" title="Background colour"></button><button type="button" class="sw" id="fgSw" title="Foreground colour"></button>' +
    '<button type="button" class="swx" id="swapSw" title="Swap colours (X)">⇄</button><button type="button" class="swd" id="defSw" title="Default colours (D)">◩</button>' +
    '<input type="color" id="fgIn" aria-label="Foreground colour"><input type="color" id="bgIn" aria-label="Background colour">';
  bar.appendChild(sw);
  $('fgSw').onclick = () => { $('fgIn').value = fg; $('fgIn').click(); };
  $('bgSw').onclick = () => { $('bgIn').value = bg; $('bgIn').click(); };
  $('fgIn').oninput = e => { fg = e.target.value; refreshSwatches(); };
  $('bgIn').oninput = e => { bg = e.target.value; refreshSwatches(); };
  $('swapSw').onclick = swapColors; $('defSw').onclick = defaultColors;
}
function swapColors() { [fg, bg] = [bg, fg]; refreshSwatches(); }
function defaultColors() { fg = '#000000'; bg = '#ffffff'; refreshSwatches(); }
function refreshSwatches() {
  $('fgSw').style.background = fg; $('bgSw').style.background = bg;
  if (textEditing) { textEditing.t.color = fg; textEl.style.color = fg; }
}
function setTool(k, keepXf) {
  if (drag) return;
  if (xf && !keepXf) commitTransform();
  if (textEditing && k !== 'text') endText(true);
  if (tool === 'crop' && k !== 'crop') TOOLS.crop.rect = null;
  tool = k;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === k));
  work.style.cursor = TOOLS[k].cursor;
  renderOptions(); requestUI();
}

// ---------------------------------------------------------------- layers panel
const BLENDS = [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['color-dodge', 'Color Dodge'], ['color-burn', 'Color Burn'], ['hard-light', 'Hard Light'], ['soft-light', 'Soft Light'], ['difference', 'Difference'],
  ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']];
const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
let dragLayerId = null;
function refreshLayers() {
  const box = $('layers'); box.innerHTML = '';
  if (!doc) return;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i], row = el('div', 'layer' + (l.id === doc.active ? ' on' : ''));
    row.draggable = true;
    const eye = el('button', 'eye' + (l.visible ? '' : ' off')); eye.type = 'button'; eye.innerHTML = EYE; eye.title = l.visible ? 'Hide layer' : 'Show layer';
    eye.onclick = e => { e.stopPropagation(); l.visible = !l.visible; push(l.visible ? 'Show Layer' : 'Hide Layer'); };
    const th = mk(40, 32); th.width = 80; th.height = 64;
    const tg = cx(th), k = Math.min(80 / doc.w, 64 / doc.h), tw = doc.w * k, thh = doc.h * k;
    tg.drawImage(l.canvas, (80 - tw) / 2 + l.x * k, (64 - thh) / 2 + l.y * k, l.canvas.width * k, l.canvas.height * k);
    const nm = el('div', 'nm', l.name);
    if (l.text) nm.appendChild(el('small', null, 'T'));
    if (l.blend !== 'normal' || l.opacity < 1) nm.appendChild(el('small', null, `${l.opacity < 1 ? Math.round(l.opacity * 100) + '%' : ''} ${l.blend !== 'normal' ? BLENDS.find(b => b[0] === l.blend)[1] : ''}`.trim()));
    nm.title = 'Double-click to rename';
    nm.ondblclick = () => {
      const inp = el('input'); inp.type = 'text'; inp.value = l.name; nm.replaceWith(inp); inp.focus(); inp.select();
      const done = ok => { if (ok && inp.value.trim() && inp.value !== l.name) { l.name = inp.value.trim(); push('Rename Layer'); } else refreshLayers(); };
      inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      inp.onblur = () => done(true);
    };
    row.append(eye, th, nm);
    row.onclick = () => { if (doc.active !== l.id) { if (xf) commitTransform(); doc.active = l.id; refreshLayers(); } };
    row.ondragstart = e => { dragLayerId = l.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); };
    row.ondragover = e => { if (dragLayerId == null) return; e.preventDefault(); row.classList.add('drop'); };
    row.ondragleave = () => row.classList.remove('drop');
    row.ondrop = e => {
      e.preventDefault(); e.stopPropagation(); row.classList.remove('drop');
      if (dragLayerId == null || dragLayerId === l.id) return;
      const from = doc.layers.findIndex(x => x.id === dragLayerId), [L] = doc.layers.splice(from, 1);
      const to = doc.layers.findIndex(x => x.id === l.id);
      doc.layers.splice(to + 1, 0, L);    // dropped on a row = placed just above it
      dragLayerId = null; push('Reorder Layers');
    };
    row.ondragend = () => dragLayerId = null;
    box.appendChild(row);
  }
  const a = active();
  $('blend').value = a ? a.blend : 'normal';
  $('lop').value = a ? Math.round(a.opacity * 100) : 100;
}
function refreshHistory() {
  const box = $('history'); box.innerHTML = '';
  history.forEach((h, i) => {
    const b = el('button', i === hIndex ? 'on' : i > hIndex ? 'future' : '', h.label); b.type = 'button';
    b.onclick = () => goHistory(i); box.appendChild(b);
  });
  // Scroll only the list: scrollIntoView would also scroll the off-screen panel into view on phones.
  const on = box.querySelector('.on');
  if (on && (on.offsetTop < box.scrollTop || on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight)) box.scrollTop = on.offsetTop - box.clientHeight + on.offsetHeight;
}
function refreshAll() {
  requestRender(); refreshLayers(); refreshHistory(); refreshMenusState();
  $('stSize').textContent = doc ? `${doc.w} × ${doc.h} px` : 'No image';
}

// ---------------------------------------------------------------- menus
const K = navigator.platform && /Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl+';
const ALT = K === '⌘' ? '⌥' : 'Alt+';
const MENUS = {
  File: [
    ['New…', `${K}N`, newDialog, true],
    ['Open…', `${K}O`, () => $('fileOpen').click(), true],
    ['Place Image as Layer…', '', () => $('filePlace').click()],
    '-',
    ['Export…', `${K}S`, exportDialog],
  ],
  Edit: [
    ['Undo', `${K}Z`, undo, () => hIndex > 0],
    ['Redo', `${K}Shift+Z`, redo, () => hIndex < history.length - 1],
    '-',
    ['Cut', `${K}X`, () => copySel(true)],
    ['Copy', `${K}C`, () => copySel(false)],
    ['Paste', `${K}V`, pasteFromMenu, true],
    ['Clear', 'Delete', clearSelected, () => !!sel],
    '-',
    ['Fill with Foreground', `${ALT}⌫`, () => fillWith(fg, 'Fill')],
    ['Fill with Background', `${K}⌫`, () => fillWith(bg, 'Fill')],
    ['Free Transform', `${K}T`, startTransform],
  ],
  Image: [
    '#Adjustments',
    ['Auto Tone', `${K}Shift+L`, () => adjustment('autoTone')],
    ['Brightness / Contrast…', '', () => adjustment('brightness')],
    ['Levels…', `${K}L`, () => adjustment('levels')],
    ['Exposure…', '', () => adjustment('exposure')],
    ['Hue / Saturation…', `${K}U`, () => adjustment('hsl')],
    ['Vibrance…', '', () => adjustment('vibrance')],
    ['Temperature & Tint…', '', () => adjustment('temperature')],
    ['Color Balance…', `${K}B`, () => adjustment('colorBalance')],
    ['Black & White…', '', () => adjustment('bw')],
    ['Sepia…', '', () => adjustment('sepia')],
    ['Desaturate', `${K}Shift+U`, () => adjustment('desaturate')],
    ['Invert', `${K}I`, () => adjustment('invert')],
    ['Posterize…', '', () => adjustment('posterize')],
    ['Threshold…', '', () => adjustment('threshold')],
    '-',
    ['Image Size…', `${K}${ALT}I`, imageSizeDialog],
    ['Canvas Size…', `${K}${ALT}C`, canvasSizeDialog],
    ['Crop to Selection', '', cropToSelection],
    ['Trim Transparent Pixels', '', trim],
    '-',
    ['Rotate 90° Clockwise', '', () => rotateCanvas(90)],
    ['Rotate 90° Counter Clockwise', '', () => rotateCanvas(-90)],
    ['Rotate 180°', '', () => rotateCanvas(180)],
    ['Flip Canvas Horizontal', '', () => flipCanvas(true)],
    ['Flip Canvas Vertical', '', () => flipCanvas(false)],
  ],
  Layer: [
    ['New Layer', `${K}Shift+N`, addLayer],
    ['Duplicate / Layer via Copy', `${K}J`, duplicateLayer],
    ['Delete Layer', '', deleteLayer],
    '-',
    ['Bring Forward', `${K}]`, () => moveLayer(1)],
    ['Send Backward', `${K}[`, () => moveLayer(-1)],
    '-',
    ['Merge Down', `${K}E`, mergeDown],
    ['Flatten Image', `${K}Shift+E`, flatten],
    '-',
    ['Flip Layer Horizontal', '', () => flipLayer(true)],
    ['Flip Layer Vertical', '', () => flipLayer(false)],
  ],
  Select: [
    ['All', `${K}A`, selectAll],
    ['Deselect', `${K}D`, deselect, () => !!sel],
    ['Inverse', `${K}Shift+I`, invertSel],
    '-',
    ['Feather…', `Shift+F6`, featherDialog, () => !!sel],
    ['Grow / Shrink…', '', growDialog, () => !!sel],
    ['Select Layer Pixels', '', selectLayerPixels],
  ],
  Filter: [
    ['Gaussian Blur…', '', () => adjustment('blur')],
    ['Unsharp Mask…', '', () => adjustment('sharpen')],
    ['Add Noise…', '', () => adjustment('noise')],
    ['Pixelate…', '', () => adjustment('pixelate')],
    ['Vignette…', '', () => adjustment('vignette')],
  ],
  View: [
    ['Zoom In', `${K}+`, () => zoomStep(1)],
    ['Zoom Out', `${K}−`, () => zoomStep(-1)],
    ['Fit on Screen', `${K}0`, fit],
    ['Actual Pixels', `${K}1`, () => zoomAt(1)],
  ],
  Help: [
    ['Keyboard Shortcuts', '?', shortcutsDialog, true],
    ['About Linear Photos', '', aboutDialog, true],
  ],
};
function featherDialog() {
  dialog({ title: 'Feather Selection', fields: [{ k: 'r', label: 'Radius', min: 1, max: 200, v: 10, unit: 'px' }],
    onOk: v => setSelection(featherMask(sel.mask, v.r), 'Feather') });
}
function growDialog() {
  dialog({ title: 'Grow / Shrink Selection', fields: [{ k: 'r', label: 'Pixels', min: -100, max: 100, v: 8 }],
    note: 'Positive grows the selection outward, negative shrinks it.',
    onOk: v => {
      if (!v.r) return;
      // Blur the mask, then cut it at a threshold offset from 50%: a cheap morphological grow/shrink.
      const r = Math.abs(v.r), img = cx(sel.mask).getImageData(0, 0, doc.w, doc.h);
      blurRGBA(img.data, doc.w, doc.h, r, true);
      const d = img.data, t = v.r > 0 ? 8 : 247;
      for (let p = 3; p < d.length; p += 4) d[p] = d[p] > t ? 255 : 0;
      const m = mk(doc.w, doc.h); cx(m).putImageData(img, 0, 0);
      setSelection(m, v.r > 0 ? 'Expand' : 'Contract');
    } });
}
function selectLayerPixels() {
  const l = active(); if (!l) return;
  setSelection(layerInDoc(l), 'Select Layer Pixels');
}
function shortcutsDialog() {
  dialog({ title: 'Keyboard Shortcuts', okLabel: 'Close', build(body) {
    const rows = [
      ['V M L W C I', 'Move, Marquee, Lasso, Wand, Crop, Eyedropper'], ['B E S G ⇧G', 'Brush, Eraser, Clone, Bucket, Gradient'], ['T U H Z', 'Type, Shape, Hand, Zoom'],
      ['[  ]', 'Brush smaller / larger'], ['⇧[  ⇧]', 'Softer / harder'], ['1 … 0', 'Brush opacity 10 … 100%'],
      ['X / D', 'Swap / default colours'], ['Space-drag', 'Pan'], [`${K}scroll`, 'Zoom'],
      [`${K}Z / ${K}⇧Z`, 'Undo / Redo'], [`${K}J`, 'Duplicate / layer via copy'], [`${K}T`, 'Free transform'],
      [`${K}A / ${K}D`, 'Select all / deselect'], ['Delete', 'Clear selection'], [`${K}0 / ${K}1`, 'Fit / 100%']];
    for (const [k, v] of rows) { const r = el('div', 'row two'); r.append(el('span', null, k), el('div', null, v)); body.appendChild(r); }
  } });
}
function aboutDialog() {
  dialog({ title: 'About Linear Photos', okLabel: 'Close', note: 'Made by Linear IT in Monroe, NY. Free, no account, no ads.', build(body) {
    body.appendChild(el('p', null, 'Everything here — opening, editing and exporting — happens inside this browser tab. Your photos are never uploaded, and this page is locked so it can’t send them anywhere even if it tried.'));
  } });
}
let openMenu = null;
function buildMenubar() {
  const bar = $('menubar');
  for (const name of Object.keys(MENUS)) {
    const b = el('button', null, name); b.type = 'button';
    b.onclick = e => { e.stopPropagation(); openMenu && openMenu.name === name ? closeMenus() : showMenu(name, b); };
    b.onpointerenter = () => { if (openMenu && openMenu.name !== name) showMenu(name, b); };
    bar.appendChild(b);
  }
}
function showMenu(name, anchor) {
  closeMenus();
  const m = el('div', 'menu'); m.setAttribute('role', 'menu');
  for (const it of MENUS[name]) {
    if (it === '-') { m.appendChild(el('hr')); continue; }
    if (typeof it === 'string') { m.appendChild(el('div', 'sub', it.slice(1))); continue; }
    const [label, key, fn, enabled] = it;
    const b = el('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.append(el('span', null, label), el('kbd', null, key));
    const ok = enabled === true || (doc && !busyTool() && (typeof enabled === 'function' ? enabled() : true));
    b.disabled = !ok;
    b.onclick = () => { closeMenus(); fn(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(r.left, innerWidth - m.offsetWidth - 4)) + 'px';
  m.style.top = r.bottom + 4 + 'px';
  anchor.classList.add('open');
  openMenu = { name, m, anchor };
}
function closeMenus() { if (openMenu) { openMenu.m.remove(); openMenu.anchor.classList.remove('open'); openMenu = null; } }
function refreshMenusState() { /* menus compute their state when opened */ }
document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.m.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenus(); });

// ---------------------------------------------------------------- pointer input on the canvas
const pointers = new Map();
let pinch = null;
work.addEventListener('pointerdown', e => {
  if (e.target === textEl || e.target.closest('.welcome')) return;
  if (!doc) return;
  closeMenus();
  work.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // Second finger: whatever the first one started becomes a pinch instead.
    cancelGesture();
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, z: view.zoom, px: view.px, py: view.py };
    return;
  }
  if (pointers.size > 2) return;
  e.preventDefault();
  if (e.button === 1 || spaceDown || tool === 'hand') {
    panState = { x: e.clientX, y: e.clientY, px: view.px, py: view.py }; work.style.cursor = 'grabbing'; return;
  }
  if (e.button !== 0 || openDlg) return;
  TOOLS[tool].down(toDoc(e), e);
});
work.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!doc) return;
  const p = toDoc(e);
  cursorPos = e.pointerType === 'touch' ? null : p;
  $('stPos').textContent = p.x >= 0 && p.y >= 0 && p.x < doc.w && p.y < doc.h ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : '';
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()], r = work.getBoundingClientRect();
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const z = clamp(pinch.z * d / pinch.d, 0.02, 32);
    const dx = (pinch.mx - r.left - pinch.px) / pinch.z, dy = (pinch.my - r.top - pinch.py) / pinch.z;
    view.zoom = z; view.px = mx - r.left - dx * z; view.py = my - r.top - dy * z;
    applyView(); return;
  }
  if (panState) { view.px = panState.px + e.clientX - panState.x; view.py = panState.py + e.clientY - panState.y; applyView(); return; }
  if (TOOLS[tool].move) TOOLS[tool].move(p, e);
  requestUI();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; return; }
  if (panState) { panState = null; work.style.cursor = spaceDown ? 'grab' : TOOLS[tool].cursor; return; }
  if (doc && TOOLS[tool].up) TOOLS[tool].up(toDoc(e), e);
}
work.addEventListener('pointerup', endPointer);
work.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); if (!pointers.size) pinch = null; cancelGesture(); panState = null; });
work.addEventListener('pointerleave', () => { cursorPos = null; requestUI(); });
function cancelGesture() {
  if (xf) { xf.drag = null; }
  else if (drag) { drag = null; live = null; requestRender(); }
  panState = null;
}
work.addEventListener('wheel', e => {
  if (!doc) return;
  e.preventDefault();
  const r = work.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse wheels as big ones.
    zoomAt(view.zoom * Math.exp(-clamp(e.deltaY, -60, 60) * 0.01), e.clientX - r.left, e.clientY - r.top);
  } else {
    view.px -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX; view.py -= e.shiftKey && !e.deltaX ? 0 : e.deltaY; applyView();
  }
}, { passive: false });
work.addEventListener('dblclick', e => { if (tool === 'hand' && doc) fit(); void e; });
new ResizeObserver(() => { requestUI(); if (textEditing) positionTextEdit(); }).observe(work);

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  if (openDlg) { if (e.key === 'Escape') openDlg.cancel(); return; }
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.key === 'Escape') {
    closeMenus();
    if (xf) cancelTransform(); else if (tool === 'crop' && TOOLS.crop.rect) TOOLS.crop.cancel(); else if (drag) cancelGesture();
    return;
  }
  if (e.key === ' ' && !spaceDown) { spaceDown = true; work.style.cursor = 'grab'; e.preventDefault(); requestUI(); return; }
  if (mod) {
    const run = fn => { e.preventDefault(); if (doc || fn === newDialog || fn === openDialogFn) fn(); };
    if (k === 'z' && e.shiftKey) return run(redo);
    if (k === 'z') return run(undo);
    if (k === 'y') return run(redo);
    if (k === 'n' && e.shiftKey) return run(addLayer);
    if (k === 'n') return run(newDialog);
    if (k === 'o') return run(openDialogFn);
    if (k === 's') return run(exportDialog);
    if (k === 'a') return run(selectAll);
    if (k === 'd') return run(deselect);
    if (k === 'i' && e.shiftKey) return run(invertSel);
    if (k === 'i' && e.altKey) return run(imageSizeDialog);
    if (k === 'c' && e.altKey) return run(canvasSizeDialog);
    if (k === 'i') return run(() => adjustment('invert'));
    if (k === 'u' && e.shiftKey) return run(() => adjustment('desaturate'));
    if (k === 'u') return run(() => adjustment('hsl'));
    if (k === 'l' && e.shiftKey) return run(() => adjustment('autoTone'));
    if (k === 'l') return run(() => adjustment('levels'));
    if (k === 'b') return run(() => adjustment('colorBalance'));
    if (k === 'j') return run(duplicateLayer);
    if (k === 'e' && e.shiftKey) return run(flatten);
    if (k === 'e') return run(mergeDown);
    if (k === 't') return run(startTransform);
    if (k === 'c') { if (doc) { e.preventDefault(); copySel(false); } return; }
    if (k === 'x') { if (doc) { e.preventDefault(); copySel(true); } return; }
    if (k === ']') return run(() => moveLayer(1));
    if (k === '[') return run(() => moveLayer(-1));
    if (k === '0') return run(fit);
    if (k === '1') return run(() => zoomAt(1));
    if (k === '=' || k === '+') return run(() => zoomStep(1));
    if (k === '-') return run(() => zoomStep(-1));
    if (e.key === 'Backspace') return run(() => fillWith(bg, 'Fill'));
    return;   // leave Ctrl+V to the paste event
  }
  if (!doc) return;
  if (e.key === 'Enter') { if (xf) { e.preventDefault(); commitTransform(); } else if (tool === 'crop' && TOOLS.crop.rect) { e.preventDefault(); TOOLS.crop.apply(); } return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (e.altKey) fillWith(fg, 'Fill'); else clearSelected(); return; }
  if (e.key === 'F6' && e.shiftKey && sel) { e.preventDefault(); featherDialog(); return; }
  if (e.key.startsWith('Arrow') && tool === 'move' && !xf) {
    e.preventDefault();
    const l = active(); if (!l) return;
    const s = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
    l.x += dx; l.y += dy; push('Nudge'); return;
  }
  if (e.altKey) return;
  const T = TOOLS[tool];
  if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') {
    const o = opt[tool]; if (!o || o.size == null) return;
    if (e.shiftKey) { o.hard = clamp(o.hard + (e.key === '}' || e.key === ']' ? 25 : -25), 0, 100); }
    else { const step = o.size < 10 ? 1 : o.size < 50 ? 5 : o.size < 100 ? 10 : 25; o.size = clamp(o.size + (e.key === ']' ? step : -step), 1, 500); }
    renderOptions(); requestUI(); return;
  }
  if (/^[0-9]$/.test(e.key) && T.brushSize) { const o = opt[tool]; o.opacity = e.key === '0' ? 100 : +e.key * 10; renderOptions(); return; }
  if (k === 'x') return swapColors();
  if (k === 'd') return defaultColors();
  if (e.key === '?') return shortcutsDialog();
  if (e.key === 'G') return setTool('gradient');
  for (const [name, T2] of Object.entries(TOOLS)) if (T2.key === k && !e.shiftKey) return setTool(name);
});
document.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceDown = false; if (!panState) work.style.cursor = TOOLS[tool].cursor; requestUI(); }
});
window.addEventListener('blur', () => { spaceDown = false; });
function openDialogFn() { $('fileOpen').click(); }

// ---------------------------------------------------------------- files: pickers and drag-and-drop
$('fileOpen').onchange = e => { const f = e.target.files[0]; e.target.value = ''; openFile(f); };
$('filePlace').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { placeImage(await loadImageFile(f), f.name.replace(/\.[^.]+$/, '')); } catch { toast('That file couldn’t be opened as an image.', true); }
};
let dragDepth = 0;
document.addEventListener('dragenter', e => { if (dragLayerId != null || !e.dataTransfer.types.includes('Files')) return; e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
document.addEventListener('dragleave', () => { if (dragDepth && --dragDepth === 0) document.body.classList.remove('dropping'); });
document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', async e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
  const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/') || /\.(hei[cf]|avif|webp)$/i.test(f.name));
  if (!f) return toast('That isn’t an image file.', true);
  // Into an open image it becomes a new layer; otherwise it opens.
  if (doc) { try { placeImage(await loadImageFile(f), f.name.replace(/\.[^.]+$/, '')); } catch { toast('That file couldn’t be opened as an image.', true); } }
  else openFile(f);
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- panel wiring & start
function initPanels() {
  const sel_ = $('blend');
  for (const [v, t] of BLENDS) { const o = el('option', null, t); o.value = v; sel_.appendChild(o); }
  sel_.onchange = () => { const l = active(); if (l) { l.blend = sel_.value; push('Blend Mode'); } };
  const op = $('lop');
  op.oninput = () => { const l = active(); if (l) { l.opacity = op.value / 100; requestRender(); } };
  op.onchange = () => { const l = active(); if (l) push('Layer Opacity'); };
  $('lbNew').onclick = () => doc && addLayer();
  $('lbDup').onclick = () => doc && duplicateLayer();
  $('lbUp').onclick = () => doc && moveLayer(1);
  $('lbDown').onclick = () => doc && moveLayer(-1);
  $('lbMerge').onclick = () => doc && mergeDown();
  $('lbDel').onclick = () => doc && deleteLayer();
  $('openBtn').onclick = openDialogFn;
  $('exportBtn').onclick = exportDialog;
  $('panelToggle').onclick = () => document.body.classList.toggle('panels');
  $('wOpen').onclick = openDialogFn;
  $('wNew').onclick = newDialog;
  const presets = [['Square 1080', 1080, 1080], ['HD 1920×1080', 1920, 1080], ['Story 1080×1920', 1080, 1920], ['A4 300dpi', 2480, 3508], ['Banner 1500×500', 1500, 500]];
  for (const [t, w, h] of presets) { const b = btn(t, () => newDoc(w, h, '#ffffff')); $('presets').appendChild(b); }
}
buildMenubar(); buildTools(); initPanels(); refreshSwatches(); setTool('brush'); refreshAll();
applyView();
// Handy for testing and for anyone poking at the page from the console.
window.linearPhotos = { get doc() { return doc; }, get sel() { return sel; }, get history() { return history.map(h => h.label); }, flat: () => doc && flatCanvas(), newDoc, setTool };
})();
