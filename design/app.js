/* Linear Design — the editor.
 *
 * The document is plain data: {name, w, h, dpi, fmt, pages:[{id, bg, els}], cur}.
 * History is a list of JSON snapshots of it (photos live outside, in `images`,
 * keyed by id, so a snapshot is a few KB however many photos a design has).
 *
 * One canvas draws everything — pasteboard, page, selection — using the same
 * renderPage() that export and the template thumbnails use, so the preview is
 * the output. Text is edited in a textarea laid over the text box.
 */
'use strict';
(() => {
const C = window.LDCore, TP = window.LDTemplates;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const MAX_PIXELS = 16777216;   // iOS Safari's canvas ceiling
const DPI = { flyer: 150, poster: 100, a4: 150, invite: 210, postcard: 300, bcard: 300, cert: 150 };
const SWATCHES = ['#000000', '#545454', '#737373', '#a6a6a6', '#d9d9d9', '#ffffff', '#ff3131', '#ff5757', '#ff66c4', '#cb6ce6', '#8c52ff', '#5e17eb', '#0097b2', '#0cc0df', '#5ce1e6', '#38b6ff', '#5170ff', '#004aad', '#00bf63', '#7ed957', '#c1ff72', '#ffde59', '#ffbd59', '#ff914d', '#8b5e3c', '#f5e6d3', '#1b3a2f', '#00b0ec'];
const GRADIENTS = [['#ff9a9e', '#fad0c4'], ['#a18cd1', '#fbc2eb'], ['#f6d365', '#fda085'], ['#84fab0', '#8fd3f4'], ['#a1c4fd', '#c2e9fb'], ['#667eea', '#764ba2'], ['#f093fb', '#f5576c'], ['#4facfe', '#00f2fe'], ['#43e97b', '#38f9d7'], ['#fa709a', '#fee140'], ['#30cfd0', '#330867'], ['#5ee7df', '#b490ca'], ['#0f2027', '#2c5364'], ['#ee0979', '#ff6a00'], ['#fc466b', '#3f5efb'], ['#00c6ff', '#0072ff'], ['#f7971e', '#ffd200'], ['#11998e', '#38ef7d'], ['#8e2de2', '#4a00e0'], ['#141e30', '#243b55'], ['#ffecd2', '#fcb69f'], ['#e0c3fc', '#8ec5fc'], ['#d4fc79', '#96e6a1'], ['#232526', '#414345']];
const EMOJI = '🎉 🎈 🎁 🎂 🥳 ✨ ⭐ 🌟 💫 🔥 💯 ✅ ❌ ⚡ ☀️ 🌙 🌈 ☁️ ❄️ 🌊 🌸 🌺 🌻 🌷 🍀 🌿 🍃 🌴 🌵 🍎 🍋 🍓 🍉 🍕 🍔 🍟 🌮 🍩 🍪 🍰 🧁 ☕ 🍵 🥤 🍿 🎵 🎶 🎸 🎤 🎧 🎬 📸 🎨 📚 ✏️ 📌 📍 📅 ⏰ 💡 🔔 📣 💬 💼 💻 📱 🔒 🛡️ 🏆 🥇 🎯 🚀 ✈️ 🚗 🏠 🏢 🛒 🛍️ 💰 💵 💳 🏷️ 🎓 👋 👍 👏 🙌 💪 🐶 🐱 🐾 🦋 🐝 ⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🚴 🏃 🧘 🏖️ ⛰️ 🗺️ 🧳 🎟️ 🎮 🧩 ♻️ 🌍 🔑 🧹 🧼 🪴 🧸 😀 😂 😍 😎 🤩 🤔 😴 🥰 👀 💥 💎 👑 🎀'.split(' ');

// ---------------------------------------------------------------- state
let doc = null;
let sel = [];
let hist = [], hIdx = -1;
const images = new Map();      // id -> {src (data URL), img}
const uploads = [];            // image ids in the Uploads panel, newest first
const fontsData = new Map();   // custom font name -> data URL
const view = { zoom: 1, px: 0, py: 0 };
let editingId = null, hoverId = null, guides = [];
let clip = null;
let tab = 'templates';
let autosaveOK = true;
let brand = loadBrand();
let uidN = 1;

const page = () => doc.pages[doc.cur];
const byId = id => doc && page().els.find(e => e.id === id);
const selEls = () => sel.map(byId).filter(Boolean);
const clone = o => JSON.parse(JSON.stringify(o));
const S = () => Math.min(doc.w, doc.h);

// ---------------------------------------------------------------- DOM helper
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(3)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const svg = (d, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', cls || 'i'); s.innerHTML = d.split('|').map(p => `<path d="${p}"/>`).join(''); return s; };
const ICO = {
  templates: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  photos: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M17 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  elements: 'M12 3l4 7H8zM4 14h7v7H4zM21 17.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z',
  text: 'M5 7V4h14v3M12 4v16M9 20h6',
  uploads: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  background: C.ICONS.palette,
  brand: C.ICONS.crown,
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  copy: 'M8 8h12v12H8z|M16 8V4H4v12h4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  lock: C.ICONS.lock, unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  up: 'M12 19V5M6 11l6-6 6 6', down: 'M12 5v14M6 13l6 6 6-6',
  left: 'M19 12H5M11 6l-6 6 6 6', right: 'M5 12h14M13 6l6 6-6 6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  alL: 'M4 3v18M8 7h12v4H8zM8 14h7v4H8z', alC: 'M12 3v18M6 7h12v4H6zM8.5 14h7v4h-7z', alR: 'M20 3v18M4 7h12v4H4zM9 14h7v4H9z',
  alT: 'M3 4h18M7 8v12h4V8zM14 8v7h4V8z', alM: 'M3 12h18M7 6v12h4V6zM14 8.5v7h4v-7z', alB: 'M3 20h18M7 4v12h4V4zM14 9v7h4V9z',
  flipH: 'M12 3v18M8 7l-5 5 5 5zM16 7l5 5-5 5z', flipV: 'M3 12h18M7 8l5-5 5 5zM7 16l5 5 5-5z',
  fwd: 'M8 8h12v12H8z|M4 4h10v2M4 4v10h2', bwd: 'M4 4h12v12H4z|M20 8v12H8',
  distH: 'M4 3v18M20 3v18M9 8h6v8H9z', distV: 'M3 4h18M3 20h18M8 9h8v6H8z',
  brush: 'M18 3l3 3-9 9-3-3zM9 12l-2.5.5C4 13 4 16 3 20c3.5-1 7-1 7.5-3.5L11 14',
  paste: 'M8 4h8v3H8zM6 5H5v16h14V5h-1M9 14l2 2 4-4',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  table: 'M3 5h18v14H3zM3 10h18M3 14.5h18M9 5v14M15 5v14',
  wand: 'M4 20L15 9M13 7l2-2 4 4-2 2zM6 4v3M4.5 5.5h3M19 14v3M17.5 15.5h3',
  txtL: 'M4 6h16M4 10h10M4 14h16M4 18h10', txtC: 'M4 6h16M7 10h10M4 14h16M7 18h10', txtR: 'M4 6h16M10 10h10M4 14h16M10 18h10',
};

// ---------------------------------------------------------------- toasts
function toast(msg, err) {
  const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), err ? 5200 : 2600);
}

// ---------------------------------------------------------------- images
function addImage(src, id) {
  id = id || 'i' + Date.now().toString(36) + (uidN++);
  const img = new Image();
  img.onload = () => { requestRender(); thumbsSoon(); };
  img.src = src;
  images.set(id, { src, img });
  return id;
}
const getImg = id => { const r = images.get(id); return r && r.img.complete && r.img.naturalWidth ? r.img : null; };
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Big camera photos are scaled to 3000px: plenty for print, and it
      // keeps the design file and autosave a sensible size.
      const k = Math.min(1, 3000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const alpha = /png|webp|gif|svg/.test(file.type);
      resolve(c.toDataURL(alpha ? 'image/png' : 'image/jpeg', .92));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
async function uploadFiles(files, at) {
  const list = [...files].filter(f => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|gif|webp|svg)$/i.test(f.name));
  const keepSel = doc ? sel.slice() : [];
  if (!list.length) return toast('Those files aren’t images.', true);
  let added = 0;
  for (const f of list) {
    try {
      const src = await readImageFile(f);
      const id = addImage(src);
      uploads.unshift(id);
      await new Promise(r => { const im = images.get(id).img; im.complete ? r() : im.addEventListener('load', r, { once: true }); });
      const empties = doc ? keepSel.map(byId).filter(e => e && e.type === 'image' && !e.src && !e.locked) : [];
      if (empties.length && !at) { empties[0].src = id; }
      else if (doc && list.length <= 6) {
        const target = at && hitTest(at[0], at[1]);
        if (target && target.type === 'image' && !target.locked) { target.src = id; sel = [target.id]; }
        else addPhotoEl(id, at && added === 0 ? at : null, added * 30);
      }
      added++;
    } catch { toast(/hei[cf]/i.test(f.name) ? 'This browser can’t read HEIC photos — export it as JPEG, or open this page in Safari.' : `${f.name} couldn’t be opened.`, true); }
  }
  if (doc && added) commit();
  if (tab === 'uploads') showTab('uploads');
}
function addPhotoEl(id, at, off) {
  const img = getImg(id), s = S();
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const k = Math.min(doc.w * .6 / iw, doc.h * .6 / ih);
  const el = { id: nid(), type: 'image', src: id, x: 0, y: 0, w: iw * k, h: ih * k, rot: 0, opacity: 1, mask: 'none', zoom: 1, px: 0, py: 0 };
  place(el, at, off);
  page().els.push(el); sel = [el.id];
  void s;
}
const nid = () => C.uid();
function place(el, at, off) {
  off = off || 0;
  if (at) { el.x = at[0] - el.w / 2; el.y = at[1] - el.h / 2; }
  else { el.x = (doc.w - el.w) / 2 + off; el.y = (doc.h - el.h) / 2 + off; }
}

// ---------------------------------------------------------------- history
function snap() { return JSON.stringify({ w: doc.w, h: doc.h, dpi: doc.dpi, fmt: doc.fmt, pages: doc.pages, cur: doc.cur }); }
function commit(o) {
  if (!doc) return;
  if (!(o && o.keepClean)) page().clean = false;
  const s = snap();
  if (hist[hIdx] === s) { afterChange(); return; }
  hist = hist.slice(0, hIdx + 1); hist.push(s);
  if (hist.length > 100) hist.shift();
  hIdx = hist.length - 1;
  afterChange();
}
function restore(s) {
  const o = JSON.parse(s);
  Object.assign(doc, o);
  doc.cur = clamp(doc.cur, 0, doc.pages.length - 1);
  sel = sel.filter(id => byId(id));
  afterChange(true);
  fitIfNeeded();
}
function undo() { if (editingId) stopEdit(); if (hIdx > 0) { hIdx--; restore(hist[hIdx]); } }
function redo() { if (editingId) stopEdit(); if (hIdx < hist.length - 1) { hIdx++; restore(hist[hIdx]); } }
let lastSize = '';
function fitIfNeeded() { const k = doc.w + 'x' + doc.h; if (k !== lastSize) { lastSize = k; fit(); } }
function afterChange() {
  $('undoBtn').disabled = hIdx <= 0; $('redoBtn').disabled = hIdx >= hist.length - 1;
  buildProps();
  if (tab === 'layers') showTab('layers');
  thumbsSoon();
  saveSoon();
  requestRender();
}

// ---------------------------------------------------------------- new / open
function fmtById(id) { return TP.FORMATS.find(f => f.id === id); }
function newDoc(w, h, o) {
  o = o || {};
  doc = { name: o.name || 'Untitled design', w: Math.round(w), h: Math.round(h), dpi: o.dpi || DPI[o.fmt] || 96, fmt: o.fmt || null, pages: [blankPage()], cur: 0 };
  $('docName').value = doc.name;
  sel = []; hist = []; hIdx = -1; editingId = null;
  $('home').hidden = true;
  lastSize = ''; resizeCanvas(); fitIfNeeded();
  commit({ keepClean: true });
  showTab('templates');
}
function blankPage() { return { id: 'p' + Date.now().toString(36) + (uidN++), bg: { fill: '#ffffff' }, els: [] }; }
function sizeLabel() {
  const f = doc.fmt && fmtById(doc.fmt);
  return `${doc.w} × ${doc.h} px${f ? ' · ' + f.n : ''}`;
}

// ---------------------------------------------------------------- view
const work = $('work'), cv = $('view'), g = cv.getContext('2d');
let vw = 0, vh = 0, dpr = 1, raf = 0;
function resizeCanvas() {
  const r = work.getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  vw = r.width; vh = r.height;
  cv.width = Math.max(1, Math.round(vw * dpr)); cv.height = Math.max(1, Math.round(vh * dpr));
  requestRender();
}
function fit() {
  if (!doc || !vw) return;
  const m = vw < 500 ? 24 : 56;
  view.zoom = Math.min((vw - m * 2) / doc.w, (vh - m * 2) / doc.h);
  view.px = (vw - doc.w * view.zoom) / 2; view.py = (vh - doc.h * view.zoom) / 2;
  zoomUI(); requestRender(); placeEditor();
}
function zoomAt(z, sx, sy) {
  z = clamp(z, .03, 8);
  const x = (sx - view.px) / view.zoom, y = (sy - view.py) / view.zoom;
  view.zoom = z; view.px = sx - x * z; view.py = sy - y * z;
  zoomUI(); requestRender(); placeEditor();
}
function zoomUI() { const z = $('zoomR'); if (z) { z.value = Math.round(view.zoom * 100); $('zoomO').textContent = Math.round(view.zoom * 100) + '%'; } }
function requestRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
const toPage = (sx, sy) => [(sx - view.px) / view.zoom, (sy - view.py) / view.zoom];
const toScr = (x, y) => [view.px + x * view.zoom, view.py + y * view.zoom];

function render() {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#101116'; g.fillRect(0, 0, vw, vh);
  if (!doc) return;
  const { zoom, px, py } = view, W = doc.w * zoom, H = doc.h * zoom;
  g.save(); g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 28; g.fillStyle = '#fff'; g.fillRect(px, py, W, H); g.restore();
  g.save();
  g.beginPath(); g.rect(px, py, W, H); g.clip();
  // checkerboard shows through a transparent background
  g.fillStyle = '#e9ebef'; g.fillRect(px, py, W, H);
  g.translate(px, py); g.scale(zoom, zoom);
  C.renderPage(g, page(), doc.w, doc.h, playing ? { scale: zoom * dpr, images: getImg, t: playing.t, dur: pageDur(page()) } : { scale: zoom * dpr, images: getImg, editor: true, editing: editingId });
  g.restore();
  if (playing) { drawPlayBar(); return; }
  drawOverlay();
}
function corners(el) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2, a = (el.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => { const dx = sx * el.w / 2, dy = sy * el.h / 2; return [cx + dx * c - dy * s, cy + dx * s + dy * c]; });
}
function aabb(els) {
  let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
  for (const el of els) for (const [x, y] of corners(el)) { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); }
  return { l, t, r, b, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
}
function handles() {
  const els = selEls();
  if (!els.length || editingId) return [];
  if (els.length > 1) {
    if (els.some(e => e.locked)) return [];
    const B = aabb(els);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([hx, hy]) => ({ hx, hy, group: true, p: [hx < 0 ? B.l : B.r, hy < 0 ? B.t : B.b] }));
  }
  const el = els[0];
  if (el.locked) return [];
  let kinds;
  if (C.isLine(el)) kinds = [[-1, 0], [1, 0]];
  else if (el.type === 'text' || el.type === 'table') kinds = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, 0], [1, 0]];
  else if (el.type === 'icon' || el.type === 'qr') kinds = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  else kinds = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2, a = (el.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const loc = (lx, ly) => [cx + lx * c - ly * s, cy + lx * s + ly * c];
  const out = kinds.map(([hx, hy]) => ({ hx, hy, p: loc(hx * el.w / 2, hy * el.h / 2) }));
  const off = el.h / 2 + 30 / view.zoom;
  out.push({ rot: true, p: loc(0, C.isLine(el) ? Math.max(off, 30 / view.zoom) : off) });
  return out;
}
function drawOverlay() {
  g.save();
  const acc = '#00b0ec';
  const outline = (el, w, col) => {
    const pts = corners(el).map(p => toScr(p[0], p[1]));
    g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath();
    g.lineWidth = w; g.strokeStyle = col; g.stroke();
  };
  const hv = hoverId && !sel.includes(hoverId) && byId(hoverId);
  if (hv) outline(hv, 1.5, acc);
  const els = selEls();
  els.forEach(el => outline(el, els.length > 1 ? 1 : 1.5, el.locked ? '#f59e0b' : acc));
  if (els.length > 1) {
    const B = aabb(els); const [x0, y0] = toScr(B.l, B.t);
    g.setLineDash([4, 3]); g.strokeStyle = acc; g.lineWidth = 1; g.strokeRect(x0, y0, B.w * view.zoom, B.h * view.zoom); g.setLineDash([]);
  }
  for (const hd of handles()) {
    const [x, y] = toScr(hd.p[0], hd.p[1]);
    if (hd.rot) {
      g.beginPath(); g.arc(x, y, 9, 0, 7); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,.25)'; g.stroke();
      g.beginPath(); g.arc(x, y, 4.2, -.3, 4.4); g.strokeStyle = '#222'; g.lineWidth = 1.5; g.stroke();
      continue;
    }
    g.beginPath();
    const side = hd.hx === 0 || hd.hy === 0;
    const el = els[0];
    if (side && !hd.group) {
      const a = (el.rot || 0) * Math.PI / 180;
      g.save(); g.translate(x, y); g.rotate(a + (hd.hx === 0 ? Math.PI / 2 : 0));
      g.beginPath(); roundedRect(g, -3.5, -10, 7, 20, 3.5); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1; g.stroke(); g.restore();
    } else {
      g.arc(x, y, 6, 0, 7); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = 'rgba(0,0,0,.3)'; g.lineWidth = 1; g.stroke();
    }
  }
  // snapping guides
  g.strokeStyle = '#ff3fb4'; g.lineWidth = 1;
  for (const gd of guides) {
    g.beginPath();
    if (gd.x != null) { const [x] = toScr(gd.x, 0); g.moveTo(x, view.py); g.lineTo(x, view.py + doc.h * view.zoom); }
    else { const [, y] = toScr(0, gd.y); g.moveTo(view.px, y); g.lineTo(view.px + doc.w * view.zoom, y); }
    g.stroke();
  }
  if (drag && drag.mode === 'marquee' && drag.cur) {
    const [x0, y0] = toScr(Math.min(drag.p0[0], drag.cur[0]), Math.min(drag.p0[1], drag.cur[1]));
    const w = Math.abs(drag.cur[0] - drag.p0[0]) * view.zoom, hh = Math.abs(drag.cur[1] - drag.p0[1]) * view.zoom;
    g.fillStyle = 'rgba(0,176,236,.12)'; g.fillRect(x0, y0, w, hh); g.strokeStyle = acc; g.strokeRect(x0, y0, w, hh);
  }
  if (drag && drag.mode === 'rotate' && els[0]) {
    const [x, y] = toScr(els[0].x + els[0].w / 2, els[0].y);
    label(`${Math.round(els[0].rot || 0)}°`, x, y - 24);
  }
  if (drag && drag.mode === 'resize' && els[0]) {
    const [x, y] = toScr(els[0].x + els[0].w / 2, els[0].y + els[0].h);
    label(els[0].type === 'text' ? `${Math.round(els[0].size)} px` : `${Math.round(els[0].w)} × ${Math.round(els[0].h)}`, x, y + 28);
  }
  g.restore();
}
function roundedRect(c, x, y, w, hh, r) { c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + hh, r); c.arcTo(x + w, y + hh, x, y + hh, r); c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function label(t, x, y) {
  g.font = '600 12px ' + getComputedStyle(document.body).fontFamily;
  const w = g.measureText(t).width + 14;
  g.fillStyle = 'rgba(10,11,15,.88)'; g.beginPath(); roundedRect(g, x - w / 2, y - 11, w, 22, 6); g.fill();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, x, y); g.textAlign = 'start';
}

// ---------------------------------------------------------------- hit testing
function hitTest(x, y, all) {
  const els = page().els;
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (el.hidden) continue;
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2, a = -(el.rot || 0) * Math.PI / 180;
    const dx = x - cx, dy = y - cy, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
    const tol = 4 / view.zoom, hh = Math.max(el.h / 2, 8 / view.zoom);
    if (Math.abs(lx) <= el.w / 2 + tol && Math.abs(ly) <= hh + tol) { if (!all) return el; }
  }
  return null;
}
function hitHandle(sx, sy, touch) {
  const r = touch ? 18 : 10;
  for (const hd of handles()) { const [x, y] = toScr(hd.p[0], hd.p[1]); if (Math.hypot(sx - x, sy - y) <= r) return hd; }
  return null;
}

// ---------------------------------------------------------------- pointer
let drag = null;
const pointers = new Map();
let lastTap = { t: 0, id: null };
let spaceDown = false;
function evPos(e) { const r = work.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
cv.addEventListener('pointerdown', e => {
  if (!doc) return;
  if (playing) { stopPlay(); return; }
  // Stop the browser's own mousedown focus handling, which would immediately
  // blur the text editor a double-click just opened. Blur other fields by hand.
  e.preventDefault();
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae !== ta && ae.blur) ae.blur();
  closePop();
  if (editingId) stopEdit();
  cv.setPointerCapture(e.pointerId);
  const [sx, sy] = evPos(e);
  pointers.set(e.pointerId, [sx, sy]);
  if (pointers.size === 2) {   // pinch
    const [a, b] = [...pointers.values()];
    drag = { mode: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), z0: view.zoom, m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], px0: view.px, py0: view.py };
    return;
  }
  const p = toPage(sx, sy);
  const touch = e.pointerType === 'touch';
  if (e.button === 1 || spaceDown) { drag = { mode: 'pan', s0: [sx, sy], px0: view.px, py0: view.py }; return; }
  if (e.button === 2) return;
  const hd = hitHandle(sx, sy, touch);
  if (hd) {
    const els = selEls();
    drag = { mode: hd.rot ? 'rotate' : hd.group ? 'gscale' : 'resize', hd, p0: p, orig: new Map(els.map(el => [el.id, clone(el)])), B0: aabb(els), moved: false };
    return;
  }
  const el = hitTest(p[0], p[1]);
  if (el) {
    const now = performance.now();
    if (lastTap.id === el.id && now - lastTap.t < 380 && !e.shiftKey) { lastTap = { t: 0, id: null }; drag = null; onDouble(el); return; }
    lastTap = { t: now, id: el.id };
    const mates = groupOf(el);
    if (e.shiftKey || e.metaKey || e.ctrlKey) { sel = sel.includes(el.id) ? sel.filter(i => !mates.includes(i)) : [...sel, ...mates]; buildProps(); requestRender(); return; }
    if (!sel.includes(el.id)) { sel = mates; buildProps(); }
    const els = selEls();
    drag = { mode: 'move', p0: p, orig: new Map(els.map(x => [x.id, clone(x)])), moved: false };
    requestRender();
    return;
  }
  lastTap = { t: 0, id: null };
  if (touch) { drag = { mode: 'pan', s0: [sx, sy], px0: view.px, py0: view.py, tapClear: true }; return; }
  if (!e.shiftKey) sel = [];
  drag = { mode: 'marquee', p0: p, cur: p, base: [...sel] };
  buildProps(); requestRender();
});
cv.addEventListener('pointermove', e => {
  if (!doc) return;
  const [sx, sy] = evPos(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
  if (!drag) {
    const p = toPage(sx, sy);
    const hd = hitHandle(sx, sy, e.pointerType === 'touch');
    const el = hitTest(p[0], p[1]);
    const id = el ? el.id : null;
    if (id !== hoverId) { hoverId = id; requestRender(); }
    cv.style.cursor = spaceDown ? 'grab' : hd ? (hd.rot ? 'grab' : cursorFor(hd)) : el ? (el.locked ? 'default' : 'move') : 'default';
    return;
  }
  const p = toPage(sx, sy);
  if (drag.mode === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const z = clamp(drag.z0 * d / drag.d0, .03, 8);
    const x = (drag.m0[0] - drag.px0) / drag.z0, y = (drag.m0[1] - drag.py0) / drag.z0;
    view.zoom = z; view.px = m[0] - x * z; view.py = m[1] - y * z;
    zoomUI(); requestRender(); return;
  }
  if (drag.mode === 'pan') {
    view.px = drag.px0 + sx - drag.s0[0]; view.py = drag.py0 + sy - drag.s0[1];
    if (Math.hypot(sx - drag.s0[0], sy - drag.s0[1]) > 4) drag.tapClear = false;
    requestRender(); return;
  }
  if (drag.mode === 'marquee') {
    drag.cur = p;
    const l = Math.min(p[0], drag.p0[0]), r = Math.max(p[0], drag.p0[0]), t = Math.min(p[1], drag.p0[1]), b = Math.max(p[1], drag.p0[1]);
    const hit = page().els.filter(el => { if (el.hidden) return false; const B = aabb([el]); return B.l < r && B.r > l && B.t < b && B.b > t; }).map(el => el.id);
    sel = expandGroups([...new Set([...drag.base, ...hit])]);
    requestRender(); return;
  }
  const dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1];
  if (!drag.moved && Math.hypot(dx, dy) * view.zoom < 3) return;
  drag.moved = true;
  if (drag.mode === 'move') doMove(dx, dy, e.altKey);
  else if (drag.mode === 'resize') doResize(p, e.shiftKey);
  else if (drag.mode === 'rotate') doRotate(p, e.shiftKey);
  else if (drag.mode === 'gscale') doGroupScale(p);
  requestRender();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!drag) return;
  const d = drag;
  if (d.mode === 'pinch') { if (pointers.size < 2) drag = null; return; }
  drag = null; guides = [];
  if (d.mode === 'pan' && d.tapClear) { sel = []; buildProps(); }
  if (d.mode === 'marquee') { buildProps(); }
  if (d.moved) commit();
  requestRender();
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('pointerleave', () => { if (hoverId && !drag) { hoverId = null; requestRender(); } });
function cursorFor(hd) {
  const el = selEls()[0];
  let a = Math.atan2(hd.hy, hd.hx) * 180 / Math.PI + (el && !hd.group ? el.rot || 0 : 0);
  a = ((a % 180) + 180) % 180;
  return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
}
cv.addEventListener('wheel', e => {
  if (!doc) return;
  e.preventDefault();
  const [sx, sy] = evPos(e);
  if (e.ctrlKey || e.metaKey) zoomAt(view.zoom * Math.exp(-e.deltaY * .0025), sx, sy);
  else { view.px -= e.deltaX; view.py -= e.deltaY; requestRender(); placeEditor(); }
}, { passive: false });

function doMove(dx, dy, noSnap) {
  const els = selEls().filter(el => !el.locked);
  if (!els.length) return;
  guides = [];
  if (!noSnap) {
    const moved = els.map(el => { const o = drag.orig.get(el.id); return Object.assign({}, o, { x: o.x + dx, y: o.y + dy }); });
    const B = aabb(moved), th = 6 / view.zoom;
    const xs = [0, doc.w / 2, doc.w], ys = [0, doc.h / 2, doc.h];
    for (const o of page().els) if (!sel.includes(o.id) && !o.hidden) { const A = aabb([o]); xs.push(A.l, A.cx, A.r); ys.push(A.t, A.cy, A.b); }
    let bx = null, by = null;
    for (const v of [B.l, B.cx, B.r]) for (const t of xs) { const d = t - v; if (Math.abs(d) < th && (bx === null || Math.abs(d) < Math.abs(bx.d))) bx = { d, t }; }
    for (const v of [B.t, B.cy, B.b]) for (const t of ys) { const d = t - v; if (Math.abs(d) < th && (by === null || Math.abs(d) < Math.abs(by.d))) by = { d, t }; }
    if (bx) { dx += bx.d; guides.push({ x: bx.t }); }
    if (by) { dy += by.d; guides.push({ y: by.t }); }
  }
  for (const el of els) { const o = drag.orig.get(el.id); el.x = o.x + dx; el.y = o.y + dy; }
}
function doResize(p, shift) {
  const el = selEls()[0], o = drag.orig.get(el.id), { hx, hy } = drag.hd;
  const a = (o.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const cx0 = o.x + o.w / 2, cy0 = o.y + o.h / 2;
  const qx = p[0] - cx0, qy = p[1] - cy0;
  const d = [qx * c + qy * s, -qx * s + qy * c];   // pointer in the element's own frame
  const ax = -hx * o.w / 2, ay = -hy * o.h / 2;     // the corner/edge that stays put
  const corner = hx !== 0 && hy !== 0;
  const lock = el.type === 'icon' || el.type === 'qr' || (corner && (el.type === 'image' || el.type === 'text') ? !shift : corner && shift);
  let w = o.w, hh = o.h;
  const min = 6 / view.zoom;
  if (el.type === 'text' || el.type === 'table') {
    if (corner) {
      const dvx = d[0] - ax, dvy = d[1] - ay, gx = hx * o.w, gy = hy * o.h;
      const k = Math.max(.05, (dvx * gx + dvy * gy) / (gx * gx + gy * gy));
      el.size = Math.max(2, o.size * k); el.w = Math.max(min, o.w * k);
      if (o.shadow) el.shadow = Object.assign({}, o.shadow, { blur: o.shadow.blur * k, x: o.shadow.x * k, y: o.shadow.y * k });
    } else {
      el.w = Math.max(el.size * (el.type === 'table' ? 3 : .5), hx * d[0] + o.w / 2);
    }
    C.syncText(el);
    w = el.w; hh = el.h;
    const lcx = hx ? ax + hx * w / 2 : 0, lcy = hy ? ay + hy * hh / 2 : -o.h / 2 + hh / 2;
    el.x = cx0 + lcx * c - lcy * s - w / 2; el.y = cy0 + lcx * s + lcy * c - hh / 2;
    return;
  }
  if (hx) w = Math.max(min, hx * d[0] + o.w / 2);
  if (hy) hh = Math.max(min, hy * d[1] + o.h / 2);
  if (lock && corner) {
    const dvx = d[0] - ax, dvy = d[1] - ay, gx = hx * o.w, gy = hy * o.h;
    const k = Math.max(.02, (dvx * gx + dvy * gy) / (gx * gx + gy * gy));
    w = o.w * k; hh = o.h * k;
  }
  if (C.isLine(el)) hh = o.h;
  const lcx = hx ? ax + hx * w / 2 : 0, lcy = hy ? ay + hy * hh / 2 : 0;
  el.w = w; el.h = hh;
  el.x = cx0 + lcx * c - lcy * s - w / 2; el.y = cy0 + lcx * s + lcy * c - hh / 2;
}
function doRotate(p, shift) {
  const el = selEls()[0], o = drag.orig.get(el.id);
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  let deg = Math.atan2(p[1] - cy, p[0] - cx) * 180 / Math.PI + 90;
  if (shift) deg = Math.round(deg / 15) * 15;
  else for (const t of [0, 90, 180, 270, 360, -90]) if (Math.abs(deg - t) < 3) deg = t;
  deg = ((deg % 360) + 360) % 360; if (deg > 180) deg -= 360;
  el.rot = Math.round(deg * 10) / 10;
}
function doGroupScale(p) {
  const B = drag.B0, { hx, hy } = drag.hd;
  const ax = hx < 0 ? B.r : B.l, ay = hy < 0 ? B.b : B.t;
  const gx = (hx < 0 ? B.l : B.r) - ax, gy = (hy < 0 ? B.t : B.b) - ay;
  const k = Math.max(.02, ((p[0] - ax) * gx + (p[1] - ay) * gy) / (gx * gx + gy * gy));
  for (const el of selEls()) {
    const o = drag.orig.get(el.id);
    const cx = ax + (o.x + o.w / 2 - ax) * k, cy = ay + (o.y + o.h / 2 - ay) * k;
    scaleEl(el, o, k);
    el.x = cx - el.w / 2; el.y = cy - el.h / 2;
  }
}
function scaleEl(el, o, k) {
  el.w = o.w * k; el.h = o.h * k;
  if (el.type === 'text' || el.type === 'table') { el.size = o.size * k; C.syncText(el); }
  if (o.sw && el.type === 'shape') el.sw = o.sw * k;
  if (o.shadow) el.shadow = Object.assign({}, o.shadow, { blur: (o.shadow.blur || 0) * k, x: (o.shadow.x || 0) * k, y: (o.shadow.y || 0) * k });
}
function onDouble(el) {
  sel = [el.id]; buildProps();
  if (el.locked) return toast('This element is locked — unlock it to edit.');
  if (el.type === 'text') startEdit(el);
  else if (el.type === 'image') { replaceTarget = el.id; $('fileReplace').click(); }
  else if (el.type === 'qr') qrDialog(el);
  else if (el.type === 'chart' || el.type === 'table') dataDialog(el);
  else if (el.type === 'shape' && !C.isLine(el)) {   // double-click a shape to type in it
    const s = S();
    const t = { id: nid(), type: 'text', text: 'Your text', font: brand.head || 'Poppins', weight: 700, size: Math.max(12, Math.min(el.h * .22, s * .06)), color: C.lum(C.fillColor(el.fill)) > .55 ? '#111111' : '#ffffff', align: 'center', lh: 1.15, ls: 0, x: 0, y: 0, w: el.w * .8, h: 10, rot: el.rot || 0, opacity: 1 };
    C.syncText(t); t.x = el.x + (el.w - t.w) / 2; t.y = el.y + (el.h - t.h) / 2;
    const i = page().els.indexOf(el); page().els.splice(i + 1, 0, t);
    commit(); startEdit(t, true);
  }
}

// ---------------------------------------------------------------- text editing
const ta = $('textEdit');
function startEdit(el, selectAll) {
  editingId = el.id; sel = [el.id];
  ta.value = el.text; ta.hidden = false;
  placeEditor(); ta.focus({ preventScroll: true });
  if (selectAll || /^(Add|Your) /.test(el.text)) ta.select();
  else { ta.selectionStart = ta.selectionEnd = ta.value.length; }
  requestRender(); buildProps();
}
function placeEditor() {
  if (!editingId) return;
  const el = byId(editingId);
  if (!el) { stopEdit(); return; }
  const z = view.zoom;
  ta.style.left = view.px + el.x * z + 'px'; ta.style.top = view.py + el.y * z + 'px';
  ta.style.width = el.w * z + 2 + 'px';
  ta.style.font = C.fontCss(el, el.size * z);
  ta.style.lineHeight = String(el.lh || 1.2);
  ta.style.letterSpacing = (el.ls || 0) * el.size * z + 'px';
  ta.style.textAlign = el.align || 'left';
  ta.style.textTransform = el.upper ? 'uppercase' : 'none';
  ta.style.color = C.fillColor(el.color);
  ta.style.textDecoration = el.underline ? 'underline' : 'none';
  ta.style.transform = `rotate(${el.rot || 0}deg)`;
  ta.style.height = '0px';
  ta.style.height = Math.max(el.h * z, ta.scrollHeight) + 'px';
}
ta.addEventListener('input', () => {
  const el = byId(editingId); if (!el) return;
  el.text = ta.value; C.syncText(el); placeEditor(); requestRender();
});
ta.addEventListener('blur', () => { if (editingId) stopEdit(); });
ta.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
  e.stopPropagation();
});
function stopEdit() {
  const el = byId(editingId);
  editingId = null; ta.hidden = true;
  if (el && !el.text.trim()) { page().els = page().els.filter(x => x !== el); sel = []; }
  commit(); requestRender();
}

// ---------------------------------------------------------------- element factories
function addText(kind, text) {
  const s = S();
  const spec = { heading: [.1, 800, 'Add a heading'], sub: [.055, 600, 'Add a subheading'], body: [.032, 400, 'Add a little bit of body text'] }[kind] || [.05, 400, ''];
  const el = { id: nid(), type: 'text', text: text || spec[2], font: brand[kind === 'heading' ? 'head' : 'body'] || (kind === 'heading' ? 'Poppins' : 'Inter'), weight: spec[1], size: Math.round(s * spec[0]), color: '#111111', align: 'center', lh: 1.2, ls: 0, x: 0, y: 0, w: 10, h: 10, rot: 0, opacity: 1 };
  if (C.lum(C.fillColor(page().bg.fill)) < .35 && !page().bg.image) el.color = '#ffffff';
  el.w = 1e5; el.w = Math.min(doc.w * .86, Math.ceil(C.textWidth(el)) + 4); C.syncText(el);
  place(el, null, 0);
  page().els.push(el); sel = [el.id]; commit();
  return el;
}
function defaultFill() { return brand.colors[0] || '#00b0ec'; }
function addShape(kind, at) {
  const s = S(), sz = s * .3;
  let el;
  if (kind === 'line' || kind === 'dashed' || kind === 'arrowline') el = { id: nid(), type: 'shape', shape: kind, x: 0, y: 0, w: s * .45, h: Math.max(s * .03, 12), rot: 0, opacity: 1, fill: '#111111', sw: Math.max(2, s * .006) };
  else {
    const dims = { wave: [doc.w, s * .25], arch: [sz * .8, sz], ribbon: [sz * 1.6, sz * .4], parallelogram: [sz * 1.4, sz * .6], arrow: [sz * 1.2, sz * .7], bubble: [sz * 1.2, sz], frame: [sz * 1.3, sz], chevron: [sz, sz * .7] }[kind] || [sz, sz];
    el = { id: nid(), type: 'shape', shape: kind, x: 0, y: 0, w: dims[0], h: dims[1], rot: 0, opacity: 1, fill: defaultFill() };
    if (kind === 'ring') el.sw = sz * .08;
  }
  place(el, at);
  if (kind === 'wave' && !at) { el.x = 0; el.y = doc.h - el.h; }
  page().els.push(el); sel = [el.id]; commit();
}
function addIcon(name, at) {
  const sz = S() * .16;
  const el = { id: nid(), type: 'icon', icon: name, x: 0, y: 0, w: sz, h: sz, rot: 0, opacity: 1, color: brand.colors[0] || '#1f2937', sw: 1.8 };
  place(el, at); page().els.push(el); sel = [el.id]; commit();
}
function addFrame(mask, at) {
  const s = S();
  const w = mask === 'arch' ? s * .36 : s * .42, hh = mask === 'arch' ? s * .48 : mask === 'none' ? s * .3 : s * .42;
  const el = { id: nid(), type: 'image', src: null, x: 0, y: 0, w, h: hh, rot: 0, opacity: 1, mask, zoom: 1, px: 0, py: 0, seed: (Math.random() * 1000) | 0 };
  place(el, at); page().els.push(el); sel = [el.id]; commit();
}
function addEmoji(ch, at) {
  const el = { id: nid(), type: 'text', text: ch, font: 'Sans', weight: 400, size: Math.round(S() * .16), color: '#000000', align: 'center', lh: 1.15, ls: 0, x: 0, y: 0, w: 10, h: 10, rot: 0, opacity: 1 };
  el.w = 1e5; el.w = Math.ceil(C.textWidth(el)) + 4; C.syncText(el);
  place(el, at); page().els.push(el); sel = [el.id]; commit();
}

// ---------------------------------------------------------------- arrange
function reorder(dir) {
  const els = page().els, ids = new Set(sel);
  if (!ids.size) return;
  if (dir === 'front') page().els = [...els.filter(e => !ids.has(e.id)), ...els.filter(e => ids.has(e.id))];
  else if (dir === 'back') page().els = [...els.filter(e => ids.has(e.id)), ...els.filter(e => !ids.has(e.id))];
  else if (dir === 'fwd') { for (let i = els.length - 2; i >= 0; i--) if (ids.has(els[i].id) && !ids.has(els[i + 1].id)) [els[i], els[i + 1]] = [els[i + 1], els[i]]; }
  else if (dir === 'bwd') { for (let i = 1; i < els.length; i++) if (ids.has(els[i].id) && !ids.has(els[i - 1].id)) [els[i], els[i - 1]] = [els[i - 1], els[i]]; }
  commit();
}
function alignTo(how) {
  const els = selEls().filter(e => !e.locked);
  if (!els.length) return;
  const T = els.length > 1 ? aabb(els) : { l: 0, t: 0, r: doc.w, b: doc.h, cx: doc.w / 2, cy: doc.h / 2 };
  for (const el of els) {
    const B = aabb([el]);
    if (how === 'l') el.x += T.l - B.l; if (how === 'c') el.x += T.cx - B.cx; if (how === 'r') el.x += T.r - B.r;
    if (how === 't') el.y += T.t - B.t; if (how === 'm') el.y += T.cy - B.cy; if (how === 'b') el.y += T.b - B.b;
  }
  commit();
}
function distribute(axis) {
  const els = selEls().filter(e => !e.locked);
  if (els.length < 3) return toast('Select three or more elements to space them evenly.');
  const bs = els.map(el => ({ el, B: aabb([el]) })).sort((a, b) => axis === 'h' ? a.B.l - b.B.l : a.B.t - b.B.t);
  const total = bs.reduce((s, x) => s + (axis === 'h' ? x.B.w : x.B.h), 0);
  const first = bs[0].B, last = bs[bs.length - 1].B;
  const span = axis === 'h' ? last.r - first.l : last.b - first.t;
  const gap = (span - total) / (bs.length - 1);
  let pos = axis === 'h' ? first.l : first.t;
  for (const { el, B } of bs) {
    if (axis === 'h') { el.x += pos - B.l; pos += B.w + gap; } else { el.y += pos - B.t; pos += B.h + gap; }
  }
  commit();
}
function duplicate() {
  const els = selEls();
  if (!els.length) return;
  const off = S() * .03;
  const copies = regroup(els.map(el => Object.assign(clone(el), { id: nid(), x: el.x + off, y: el.y + off, locked: false })));
  page().els.push(...copies); sel = copies.map(c => c.id); commit();
}
function del() {
  const ids = new Set(selEls().filter(e => !e.locked).map(e => e.id));
  if (!ids.size) return selEls().length && toast('Locked elements can’t be deleted — unlock them first.');
  page().els = page().els.filter(e => !ids.has(e.id)); sel = []; commit();
}
function copySel(cut) {
  const els = selEls(); if (!els.length) return;
  clip = clone(els);
  if (cut) del();
}
function pasteClip() {
  if (!clip) return;
  const off = S() * .03;
  const copies = regroup(clip.map(el => Object.assign(clone(el), { id: nid(), x: el.x + off, y: el.y + off })));
  clip = copies.map(c => clone(c));
  page().els.push(...copies); sel = copies.map(c => c.id); commit();
}

// ---------------------------------------------------------------- photo grids
// Cells as [x, y, w, h] in 0..1 of the area; gaps are added when placed.
const GRIDS = [
  ['2 across', [[0, 0, .5, 1], [.5, 0, .5, 1]]],
  ['2 down', [[0, 0, 1, .5], [0, .5, 1, .5]]],
  ['1 + 2', [[0, 0, .6, 1], [.6, 0, .4, .5], [.6, .5, .4, .5]]],
  ['2 + 1', [[0, 0, .5, .55], [.5, 0, .5, .55], [0, .55, 1, .45]]],
  ['3 across', [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]]],
  ['4 grid', [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]]],
  ['1 + 3', [[0, 0, 1, .6], [0, .6, 1 / 3, .4], [1 / 3, .6, 1 / 3, .4], [2 / 3, .6, 1 / 3, .4]]],
  ['2 + 3', [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, 1 / 3, .5], [1 / 3, .5, 1 / 3, .5], [2 / 3, .5, 1 / 3, .5]]],
  ['6 grid', [[0, 0, 1 / 3, .5], [1 / 3, 0, 1 / 3, .5], [2 / 3, 0, 1 / 3, .5], [0, .5, 1 / 3, .5], [1 / 3, .5, 1 / 3, .5], [2 / 3, .5, 1 / 3, .5]]],
  ['9 grid', [0, 1, 2].flatMap(r => [0, 1, 2].map(c => [c / 3, r / 3, 1 / 3, 1 / 3]))],
  ['Big + 4', [[0, 0, .5, 1], [.5, 0, .25, .5], [.75, 0, .25, .5], [.5, .5, .25, .5], [.75, .5, .25, .5]]],
  ['Filmstrip', [[0, 0, .25, 1], [.25, 0, .25, 1], [.5, 0, .25, 1], [.75, 0, .25, 1]]],
];
function addGrid(cells, o) {
  o = o || {};
  const gap = o.gap != null ? o.gap : S() * .012, m = o.margin != null ? o.margin : 0;
  const W = doc.w - m * 2, H = doc.h - m * 2, g = 'g' + nid(), ids = [];
  const tints = ['#d9dde6', '#cfd6e3', '#dfe3ea', '#d3d9e4'];
  cells.forEach(([x, y, w, h2], i) => {
    const el = { id: nid(), type: 'image', src: null, x: m + x * W + gap / 2, y: m + y * H + gap / 2, w: w * W - gap, h: h2 * H - gap, rot: 0, opacity: 1, mask: 'none', zoom: 1, px: 0, py: 0, group: g, ph: tints[i % tints.length] };
    page().els.push(el); ids.push(el.id);
  });
  sel = ids; commit();
  toast('Photo grid added. Drop photos onto the frames, or upload several at once to fill them in order.');
}

// ---------------------------------------------------------------- copy / paste style
const STYLE_KEYS = {
  text: ['font', 'weight', 'italic', 'underline', 'upper', 'color', 'lh', 'ls', 'align', 'outline', 'box', 'shadow', 'opacity', 'curve'],
  shape: ['fill', 'stroke', 'sw', 'dash', 'radius', 'shadow', 'opacity'],
  icon: ['color', 'sw', 'solid', 'shadow', 'opacity'],
  image: ['filter', 'mask', 'border', 'shadow', 'opacity', 'stick'],
  qr: ['fg', 'bg', 'style', 'eye', 'eyeColor', 'radius', 'quiet'],
  chart: ['font', 'ink', 'bg', 'textScale', 'grid', 'legend', 'values', 'prefix', 'suffix'],
  table: ['font', 'size', 'weight', 'color', 'hcolor', 'hbg', 'bg', 'band', 'line', 'lines', 'lw', 'pad', 'radius', 'hupper', 'align'],
};
let styleClip = null;
function copyStyle() {
  const el = selEls()[0]; if (!el) return;
  styleClip = { type: el.type, v: clone(Object.fromEntries(STYLE_KEYS[el.type].map(k => [k, el[k]]))) };
  toast('Style copied — select something and paste it with Ctrl+Alt+V.'); buildProps();
}
function pasteStyle() {
  if (!styleClip) return toast('Copy a style first (Ctrl+Alt+C).');
  let n = 0;
  for (const el of selEls()) {
    if (el.locked) continue;
    if (el.type === styleClip.type) { for (const k of STYLE_KEYS[el.type]) { if (styleClip.v[k] === undefined) delete el[k]; else el[k] = clone(styleClip.v[k]); } n++; }
    else if (styleClip.type === 'text' && el.type === 'table') { el.font = styleClip.v.font; el.color = C.fillColor(styleClip.v.color); n++; }
    else { const col = styleClip.v.fill || styleClip.v.color; if (col && (el.type === 'shape' || el.type === 'icon' || el.type === 'text')) { el[el.type === 'shape' ? 'fill' : 'color'] = clone(col); n++; } }
    C.syncText(el);
  }
  if (n) commit(); else toast('Nothing selected that can take that style.');
}

// ---------------------------------------------------------------- groups
// A group is just a shared `group` id: clicking any member selects them all,
// and double-clicking still edits the one under the pointer.
function groupOf(el) { return el.group ? page().els.filter(x => x.group === el.group && !x.hidden).map(x => x.id) : [el.id]; }
function expandGroups(ids) {
  const gs = new Set(ids.map(byId).filter(e => e && e.group).map(e => e.group));
  return gs.size ? [...new Set([...ids, ...page().els.filter(e => gs.has(e.group) && !e.hidden).map(e => e.id)])] : ids;
}
function regroup(copies) {   // copies get their own group ids, so they don't join the originals
  const map = new Map();
  for (const c of copies) if (c.group) { if (!map.has(c.group)) map.set(c.group, 'g' + nid()); c.group = map.get(c.group); }
  return copies;
}
function isOneGroup(els) { return els.length > 1 && els[0].group && els.every(e => e.group === els[0].group); }
function groupSel() {
  const els = selEls();
  if (els.length < 2) return toast('Select two or more elements to group them.');
  const g = 'g' + nid(); els.forEach(e => e.group = g);
  // keep a group together in the stacking order, at the topmost member's position
  const arr = page().els, top = Math.max(...els.map(e => arr.indexOf(e)));
  const rest = arr.filter(e => e.group !== g), at = rest.indexOf(arr.slice(top + 1).find(e => e.group !== g));
  const members = arr.filter(e => e.group === g);
  page().els = at < 0 ? [...rest, ...members] : [...rest.slice(0, at), ...members, ...rest.slice(at)];
  commit(); toast('Grouped. Ctrl+Shift+G to ungroup.');
}
function ungroupSel() {
  const els = selEls().filter(e => e.group);
  if (!els.length) return;
  els.forEach(e => delete e.group); commit(); toast('Ungrouped.');
}

// ---------------------------------------------------------------- pages
function addPage(dup) {
  const p = dup ? Object.assign(clone(page()), { id: 'p' + Date.now().toString(36) + (uidN++) }) : blankPage();
  if (dup) { p.els.forEach(el => el.id = nid()); regroup(p.els); }
  if (!dup) p.bg = { fill: '#ffffff' };
  doc.pages.splice(doc.cur + 1, 0, p); doc.cur++; sel = []; commit({ keepClean: true });
}
function delPage() {
  if (doc.pages.length < 2) return toast('A design needs at least one page.');
  doc.pages.splice(doc.cur, 1); doc.cur = Math.min(doc.cur, doc.pages.length - 1); sel = []; commit({ keepClean: true });
}
function movePage(d) {
  const j = doc.cur + d; if (j < 0 || j >= doc.pages.length) return;
  [doc.pages[doc.cur], doc.pages[j]] = [doc.pages[j], doc.pages[doc.cur]]; doc.cur = j; commit({ keepClean: true });
}
function goPage(i) { if (editingId) stopEdit(); doc.cur = i; sel = []; buildProps(); buildPages(); requestRender(); if (tab === 'layers') showTab('layers'); }
let thumbT = 0;
function thumbsSoon() { clearTimeout(thumbT); thumbT = setTimeout(buildPages, 220); }
function pageThumb(pg, maxW, maxH) {
  const k = Math.min(maxW / doc.w, maxH / doc.h), d = 2;
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(doc.w * k * d)); c.height = Math.max(1, Math.round(doc.h * k * d));
  c.style.width = c.width / d + 'px'; c.style.height = c.height / d + 'px';
  const x = c.getContext('2d'); x.scale(k * d, k * d);
  C.renderPage(x, pg, doc.w, doc.h, { scale: k * d, images: getImg });
  return c;
}
function buildPages() {
  const bar = $('pages'); bar.textContent = '';
  if (!doc) return;
  const small = window.innerWidth < 640;
  doc.pages.forEach((pg, i) => {
    const b = h('button', { class: 'pthumb' + (i === doc.cur ? ' on' : ''), type: 'button', title: `Page ${i + 1}`, onclick: () => goPage(i) }, pageThumb(pg, 120, small ? 46 : 60), h('span', null, String(i + 1)));
    bar.append(b);
  });
  bar.append(h('button', { class: 'padd', type: 'button', title: 'Add a page', onclick: () => addPage(false) }, '+'));
  const act = (ic, t, fn, dis) => h('button', { class: 'tb icon', type: 'button', title: t, 'aria-label': t, onclick: fn, disabled: dis }, svg(ic));
  bar.append(h('div', { class: 'pactions' },
    h('span', { class: 'hide-sm', style: 'margin-right:6px' }, `Page ${doc.cur + 1} of ${doc.pages.length}`),
    act(ICO.left, 'Move page left', () => movePage(-1), doc.cur === 0),
    act(ICO.right, 'Move page right', () => movePage(1), doc.cur === doc.pages.length - 1),
    act(ICO.copy, 'Duplicate page', () => addPage(true)),
    act(ICO.trash, 'Delete page', delPage, doc.pages.length < 2)),
  h('div', { class: 'zoomctl' },
    h('input', { type: 'range', id: 'zoomR', min: 5, max: 400, value: Math.round(view.zoom * 100), 'aria-label': 'Zoom', oninput: e => zoomAt(+e.target.value / 100, vw / 2, vh / 2) }),
    h('output', { id: 'zoomO' }, Math.round(view.zoom * 100) + '%'),
    act(ICO.fit, 'Fit to screen', fit)));
}

// ---------------------------------------------------------------- colour picker popover
let pop = null;
function closePop() { if (pop) { pop.remove(); pop = null; } }
function cssFill(f) {
  if (!f || f === 'none') return 'transparent';
  if (typeof f === 'string') return f;
  return f.g === 'radial' ? `radial-gradient(${f.c.join(',')})` : `linear-gradient(${(f.a || 0) + 90}deg,${f.c.join(',')})`;
}
function docColors() {
  const set = new Set();
  const add = f => { if (!f || f === 'none') return; if (typeof f === 'string') { if (/^#/.test(f)) set.add(f.toLowerCase()); } else if (f.c) f.c.forEach(add); };
  for (const pg of doc.pages) { add(pg.bg.fill); for (const el of pg.els) { add(el.fill); add(el.color); add(el.stroke); if (el.box) add(el.box.color); if (el.outline) add(el.outline.color); } }
  return [...set].slice(0, 21);
}
function colorBtn(val, onSet, o) {
  o = o || {};
  const b = h('button', { class: 'csw' + (!val || val === 'none' ? ' none' : ''), type: 'button', title: o.title || 'Colour', style: `background:${cssFill(val)}` });
  b.addEventListener('click', e => { e.stopPropagation(); openPop(b, val, v => { onSet(v); b.style.background = cssFill(v); b.classList.toggle('none', !v || v === 'none'); }, o); });
  return b;
}
function openPop(anchor, val, onSet, o) {
  closePop();
  const apply = (v, final) => { onSet(v); requestRender(); if (final) commit(); };
  const cur = typeof val === 'string' && /^#/.test(val) ? val : C.fillColor(val);
  const hex = h('input', { type: 'text', value: cur, maxlength: 7, onchange: e => { const v = e.target.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) { const c = v[0] === '#' ? v : '#' + v; nat.value = c; apply(c, true); } } });
  const nat = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#000000', oninput: e => { hex.value = e.target.value; apply(e.target.value); }, onchange: () => commit() });
  const grid = (cols, list, fn) => h('div', { class: 'swgrid' }, list.map(c => h('button', { class: 'sw', type: 'button', title: Array.isArray(c) ? 'Gradient' : c, style: `background:${Array.isArray(c) ? `linear-gradient(135deg,${c.join(',')})` : c}`, onclick: () => fn(c) })));
  const kids = [h('div', { class: 'hexrow' }, nat, hex)];
  if (o.none) kids.push(h('div', { class: 'sec' }, 'No colour'), h('div', { class: 'swgrid' }, h('button', { class: 'sw csw none', type: 'button', title: 'None', onclick: () => apply('none', true) })));
  const dc = docColors();
  if (dc.length) kids.push(h('div', { class: 'sec' }, 'In this design'), grid(7, dc, c => { hex.value = c; apply(c, true); }));
  if (brand.colors.length) kids.push(h('div', { class: 'sec' }, 'Brand colours'), grid(7, brand.colors, c => { hex.value = c; apply(c, true); }));
  kids.push(h('div', { class: 'sec' }, 'Colours'), grid(7, SWATCHES, c => { hex.value = c; apply(c, true); }));
  if (o.gradient) {
    kids.push(h('div', { class: 'sec' }, 'Gradients'), grid(7, GRADIENTS, c => apply({ g: 'linear', a: 45, c: c.slice() }, true)));
    if (val && typeof val === 'object') {
      const gv = clone(val);
      kids.push(h('div', { class: 'sec' }, 'Edit gradient'),
        h('div', { class: 'prow' }, h('span', null, 'Colours'), ...gv.c.map((c, i) => h('input', { type: 'color', value: c, oninput: e => { gv.c[i] = e.target.value; apply(clone(gv)); }, onchange: () => commit() }))),
        h('div', { class: 'prow' }, h('span', null, 'Style'), h('select', { onchange: e => { gv.g = e.target.value; apply(clone(gv), true); } }, h('option', { value: 'linear', selected: gv.g !== 'radial' }, 'Linear'), h('option', { value: 'radial', selected: gv.g === 'radial' }, 'Radial'))),
        h('div', { class: 'prow' }, h('span', null, 'Angle'), h('input', { type: 'range', min: 0, max: 360, value: gv.a || 0, oninput: e => { gv.a = +e.target.value; apply(clone(gv)); }, onchange: () => commit() })));
    }
  }
  pop = h('div', { class: 'pop', onpointerdown: e => e.stopPropagation() }, kids);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect();
  let x = r.left - pr.width - 8; if (x < 8) x = Math.min(window.innerWidth - pr.width - 8, r.right + 8);
  let y = clamp(r.top - 20, 8, window.innerHeight - pr.height - 8);
  if (window.innerWidth < 640) { x = (window.innerWidth - pr.width) / 2; y = clamp(r.bottom + 6, 8, window.innerHeight - pr.height - 8); }
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
}
document.addEventListener('pointerdown', e => { if (pop && !pop.contains(e.target)) closePop(); if (menuEl && !menuEl.contains(e.target)) closeMenu(); });

// ---------------------------------------------------------------- properties panel
const P = $('props');
function prow(label, ...kids) { return h('div', { class: 'prow' }, h('span', null, label), ...kids); }
function slider(label, val, min, max, step, onInput, fmt) {
  const out = h('output', null, fmt ? fmt(val) : String(val));
  const inp = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label });
  inp.addEventListener('input', () => { const v = +inp.value; out.textContent = fmt ? fmt(v) : String(v); onInput(v); requestRender(); });
  inp.addEventListener('change', () => commit());
  return h('div', { class: 'prow' }, h('span', null, label), inp, out);
}
function num(label, val, onSet, step) {
  const inp = h('input', { type: 'number', value: Math.round(val * 10) / 10, step: step || 1 });
  inp.addEventListener('change', () => { if (inp.value === '') return; onSet(+inp.value); commit(); });
  return h('label', null, label, inp);
}
function pb(content, title, fn, on, cls) { return h('button', { class: 'pb' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), type: 'button', title, 'aria-label': title, onclick: fn }, typeof content === 'string' && content.startsWith('M') ? svg(content) : content); }
function group(title, ...kids) { return h('div', { class: 'pgroup' }, h('h3', null, ...[].concat(title)), ...kids); }
function fontSelect(val, onSet) {
  const s = h('select', { 'aria-label': 'Font' });
  const opt = n => h('option', { value: n, selected: n === val, style: `font-family:${C.fontFamily(n)}` }, n);
  if (C.custom.size) s.append(h('optgroup', { label: 'Your fonts' }, [...C.custom.keys()].map(opt)));
  for (const cat of ['Sans', 'Serif', 'Display', 'Script', 'Handwritten']) s.append(h('optgroup', { label: cat }, C.WEBFONTS.filter(f => f[1] === cat).map(f => opt(f[0]))));
  s.append(h('optgroup', { label: 'This device’s fonts' }, C.FONTS.map(f => opt(f[0]))));
  s.append(h('option', { value: '__upload' }, 'Upload a font…'));
  s.addEventListener('change', () => { if (s.value === '__upload') { s.value = val; fontTarget = onSet; $('fileFont').click(); return; } onSet(s.value); commit(); });
  return s;
}
let fontTarget = null;
function buildProps() {
  if (!doc) return;
  P.textContent = '';
  const els = selEls();
  if (!els.length) return buildPageProps();
  if (els.length > 1) return buildMultiProps(els);
  const el = els[0];
  const names = { text: 'Text', shape: 'Shape', icon: 'Icon', image: el.src ? 'Photo' : 'Photo frame', qr: 'QR code', chart: 'Chart', table: 'Table' };
  P.append(group([names[el.type], h('span', { class: 'btnrow' },
    pb(ICO.brush, 'Copy style (Ctrl+Alt+C)', copyStyle),
    styleClip ? pb(ICO.paste, 'Paste style (Ctrl+Alt+V)', pasteStyle) : null,
    pb(ICO.copy, 'Duplicate (Ctrl+D)', duplicate),
    pb(el.locked ? ICO.lock : ICO.unlock, el.locked ? 'Unlock' : 'Lock', () => { el.locked = !el.locked; commit(); }, el.locked),
    pb(ICO.trash, 'Delete', del, false, 'danger'))]));
  if (el.group) P.append(group('Group', h('button', { class: 'pb wide', type: 'button', style: 'width:100%', onclick: () => { sel = groupOf(el); buildProps(); requestRender(); } }, 'Select the whole group')));
  if (el.type === 'text') textProps(el);
  if (el.type === 'shape') shapeProps(el);
  if (el.type === 'icon') iconProps(el);
  if (el.type === 'image') imageProps(el);
  if (el.type === 'qr') qrProps(el);
  if (el.type === 'chart') chartProps(el);
  if (el.type === 'table') tableProps(el);
  animProps(el);
  commonProps(el);
}
function commonProps(el) {
  P.append(group('Arrange',
    h('div', { class: 'btnrow', style: 'margin-bottom:8px' },
      pb(ICO.fwd, 'Bring forward', () => reorder('fwd')), pb(ICO.bwd, 'Send backward', () => reorder('bwd')),
      pb('To front', 'Bring to front', () => reorder('front'), false, 'wide'), pb('To back', 'Send to back', () => reorder('back'), false, 'wide')),
    h('div', { class: 'btnrow', style: 'margin-bottom:8px' },
      pb(ICO.alL, 'Align left on page', () => alignTo('l')), pb(ICO.alC, 'Centre on page', () => alignTo('c')), pb(ICO.alR, 'Align right on page', () => alignTo('r')),
      pb(ICO.alT, 'Align top on page', () => alignTo('t')), pb(ICO.alM, 'Middle of page', () => alignTo('m')), pb(ICO.alB, 'Align bottom on page', () => alignTo('b')),
      pb(ICO.flipH, 'Flip horizontal', () => { el.flipX = !el.flipX; commit(); }, el.flipX), pb(ICO.flipV, 'Flip vertical', () => { el.flipY = !el.flipY; commit(); }, el.flipY)),
    h('div', { class: 'grid4' },
      num('X', el.x, v => el.x = v), num('Y', el.y, v => el.y = v),
      num('W', el.w, v => { v = Math.max(1, v); if (el.type === 'text' || el.type === 'table') { el.w = v; C.syncText(el); } else if (el.type === 'icon' || el.type === 'qr') { el.w = el.h = v; } else el.w = v; }),
      el.type === 'text' || el.type === 'table' ? num('Rot', el.rot || 0, v => el.rot = v) : num('H', el.h, v => { v = Math.max(1, v); if (el.type === 'icon' || el.type === 'qr') el.w = el.h = v; else el.h = v; })),
    el.type !== 'text' && el.type !== 'table' ? h('div', { class: 'grid4', style: 'margin-top:6px' }, num('Rot', el.rot || 0, v => el.rot = v)) : null,
    h('div', { style: 'margin-top:8px' }, slider('Opacity', Math.round((el.opacity == null ? 1 : el.opacity) * 100), 0, 100, 1, v => el.opacity = v / 100, v => v + '%'))));
  const sh = el.shadow;
  const s = S();
  P.append(group(['Shadow', h('label', null, h('input', { type: 'checkbox', checked: !!sh, onchange: e => { el.shadow = e.target.checked ? { color: '#000000', alpha: .35, blur: Math.round(s * .025), x: Math.round(s * .008), y: Math.round(s * .012) } : null; commit(); } }), 'On')],
    sh ? [prow('Colour', colorBtn(sh.color, v => sh.color = v)),
      slider('Blur', sh.blur, 0, Math.round(s * .15), 1, v => sh.blur = v),
      slider('Offset X', sh.x, -Math.round(s * .06), Math.round(s * .06), 1, v => sh.x = v),
      slider('Offset Y', sh.y, -Math.round(s * .06), Math.round(s * .06), 1, v => sh.y = v),
      slider('Strength', Math.round(sh.alpha * 100), 0, 100, 1, v => sh.alpha = v / 100, v => v + '%')] : null));
}
const EFFECTS = [
  ['none', 'Aa', 'None'], ['shadow', 'Aa', 'Shadow'], ['lift', 'Aa', 'Lift'], ['hollow', 'Aa', 'Hollow'], ['outline', 'Aa', 'Outline'],
  ['neon', 'Aa', 'Neon'], ['highlight', 'Aa', 'Highlight'], ['block', 'Aa', 'Block'], ['splice', 'Aa', 'Splice'],
];
function effectOf(el) {
  if (el.box) return el.box.full ? 'block' : 'highlight';
  if (el.outline && el.outline.only) return 'hollow';
  if (el.outline && el.shadow) return 'splice';
  if (el.outline) return 'outline';
  if (el.shadow && el.shadow.x === 0 && el.shadow.y === 0 && el.shadow.alpha >= .9) return 'neon';
  if (el.shadow && el.shadow.x === 0) return 'lift';
  if (el.shadow) return 'shadow';
  return 'none';
}
function setEffect(el, fx) {
  const col = C.fillColor(el.color), sz = el.size, dark = C.lum(col) < .5;
  el.shadow = null; el.outline = null; el.box = null;
  if (fx === 'shadow') el.shadow = { color: '#000000', alpha: .45, blur: Math.round(sz * .08), x: Math.round(sz * .04), y: Math.round(sz * .05) };
  if (fx === 'lift') el.shadow = { color: '#000000', alpha: .35, blur: Math.round(sz * .35), x: 0, y: Math.round(sz * .08) };
  if (fx === 'hollow') el.outline = { w: 3, color: col, only: true };
  if (fx === 'outline') el.outline = { w: 5, color: dark ? '#ffffff' : '#000000' };
  if (fx === 'neon') el.shadow = { color: col, alpha: 1, blur: Math.round(sz * .4), x: 0, y: 0 };
  if (fx === 'highlight') el.box = { color: dark ? '#ffde59' : '#111111', pad: .25, r: .12 };
  if (fx === 'block') el.box = { color: dark ? '#ffde59' : '#111111', pad: .45, r: .15, full: true };
  if (fx === 'splice') { el.outline = { w: 3, color: dark ? '#ffffff' : '#000000' }; el.shadow = { color: '#ff5757', alpha: 1, blur: 0, x: Math.round(sz * .06), y: Math.round(sz * .06) }; }
  commit();
}
function textProps(el) {
  const up = () => C.syncText(el);
  const W = [[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']];
  P.append(group('Font',
    h('div', { class: 'prow' }, fontSelect(el.font, v => { el.font = v; up(); })),
    h('div', { class: 'prow' },
      h('input', { type: 'number', value: Math.round(el.size * 10) / 10, min: 1, step: 1, 'aria-label': 'Font size', style: 'width:70px', onchange: e => { el.size = Math.max(1, +e.target.value); up(); commit(); } }),
      h('select', { 'aria-label': 'Weight', onchange: e => { el.weight = +e.target.value; up(); commit(); } }, W.map(([v, n]) => h('option', { value: v, selected: +el.weight === v }, n))),
      colorBtn(el.color, v => { el.color = v; }, { gradient: true, title: 'Text colour' })),
    h('div', { class: 'btnrow', style: 'margin-bottom:8px' },
      pb(h('b', null, 'B'), 'Bold', () => { el.weight = el.weight >= 700 ? 400 : 700; up(); commit(); }, el.weight >= 700),
      pb(h('i', null, 'I'), 'Italic', () => { el.italic = !el.italic; up(); commit(); }, el.italic),
      pb(h('u', null, 'U'), 'Underline', () => { el.underline = !el.underline; commit(); }, el.underline),
      pb('aA', 'Uppercase', () => { el.upper = !el.upper; up(); commit(); }, el.upper),
      pb(ICO.txtL, 'Align left', () => { el.align = 'left'; commit(); }, el.align === 'left'),
      pb(ICO.txtC, 'Align centre', () => { el.align = 'center'; commit(); }, el.align === 'center'),
      pb(ICO.txtR, 'Align right', () => { el.align = 'right'; commit(); }, el.align === 'right')),
    slider('Line height', el.lh || 1.2, .6, 3, .05, v => { el.lh = v; up(); }, v => (+v).toFixed(2)),
    slider('Spacing', Math.round((el.ls || 0) * 1000), -100, 800, 5, v => { el.ls = v / 1000; up(); }),
    slider('Curve', el.curve || 0, -100, 100, 1, v => { const cx = el.x + el.w / 2, cy = el.y + el.h / 2; if (!v && el.curve) { el.curve = 0; el.w = 1e5; el.w = Math.min(doc.w * .9, Math.ceil(C.textWidth(el)) + 4); } else el.curve = v; up(); el.x = cx - el.w / 2; el.y = cy - el.h / 2; }),
    h('div', { class: 'prow', style: 'margin-top:4px' }, h('button', { class: 'pb wide', type: 'button', onclick: () => { el.w = 1e5; el.w = Math.ceil(C.textWidth(el)) + 4; up(); commit(); } }, 'Fit box to text'), h('button', { class: 'pb wide', type: 'button', onclick: () => startEdit(el) }, 'Edit text'))));
  const cur = effectOf(el);
  const fxPrev = { none: '', shadow: 'text-shadow:2px 2px 2px #000', lift: 'text-shadow:0 3px 8px rgba(0,0,0,.6)', hollow: 'color:transparent;-webkit-text-stroke:1px #fff', outline: '-webkit-text-stroke:1px #000;color:#fff', neon: 'text-shadow:0 0 6px #0ff,0 0 10px #0ff', highlight: 'background:#ffde59;color:#111;padding:0 3px', block: 'background:#111;color:#fff;padding:1px 5px;border-radius:3px', splice: 'color:#fff;-webkit-text-stroke:1px #000;text-shadow:2px 2px 0 #ff5757' };
  P.append(group('Effects', h('div', { class: 'fxgrid' }, EFFECTS.map(([k, s, n]) => h('button', { type: 'button', class: k === cur ? 'on' : '', onclick: () => setEffect(el, k) }, h('b', { style: fxPrev[k] }, s), n))),
    el.outline ? h('div', { style: 'margin-top:10px' },
      prow('Outline', colorBtn(el.outline.color, v => el.outline.color = v)),
      slider('Thickness', el.outline.w, 1, 20, .5, v => el.outline.w = v)) : null,
    el.box ? h('div', { style: 'margin-top:10px' },
      prow('Box colour', colorBtn(el.box.color, v => el.box.color = v)),
      slider('Padding', Math.round((el.box.pad || 0) * 100), 0, 150, 1, v => el.box.pad = v / 100),
      slider('Roundness', Math.round((el.box.r || 0) * 100), 0, 60, 1, v => el.box.r = v / 100),
      slider('Box opacity', Math.round((el.box.alpha == null ? 1 : el.box.alpha) * 100), 0, 100, 1, v => el.box.alpha = v / 100, v => v + '%')) : null));
}
function shapeProps(el) {
  if (C.isLine(el)) {
    P.append(group('Line',
      prow('Colour', colorBtn(el.fill, v => el.fill = v)),
      slider('Thickness', el.sw || 4, 1, Math.max(40, Math.round(S() * .05)), 1, v => { el.sw = v; el.h = Math.max(el.h, v * 2); }),
      h('div', { class: 'btnrow' }, ['line', 'dashed', 'arrowline'].map((k, i) => pb(['Solid', 'Dashed', 'Arrow'][i], ['Solid', 'Dashed', 'Arrow'][i], () => { el.shape = k; commit(); }, el.shape === k, 'wide')))));
    return;
  }
  const s = S();
  P.append(group('Shape',
    h('div', { class: 'prow' }, h('span', null, 'Type'), h('select', { onchange: e => { el.shape = e.target.value; commit(); } }, C.SHAPES.filter(x => !['line', 'dashed', 'arrowline'].includes(x[0])).map(([k, n]) => h('option', { value: k, selected: el.shape === k }, n)))),
    prow('Fill', colorBtn(el.fill, v => el.fill = v, { gradient: true, none: true })),
    prow('Border', colorBtn(el.stroke || 'none', v => { el.stroke = v; if (v !== 'none' && !el.sw) el.sw = Math.max(2, Math.round(s * .006)); }, { none: true }), h('label', { style: 'display:flex;gap:5px;align-items:center;color:var(--muted)' }, h('input', { type: 'checkbox', checked: !!el.dash, onchange: e => { el.dash = e.target.checked; commit(); } }), 'Dashed')),
    slider(el.shape === 'ring' ? 'Ring width' : 'Border width', Math.round(el.sw || 0), 0, Math.round(Math.min(el.w, el.h) / 3), 1, v => el.sw = v),
    el.shape === 'rect' || el.shape === 'round' ? slider('Corners', Math.round(el.radius != null ? el.radius : el.shape === 'round' ? Math.min(el.w, el.h) * .18 : 0), 0, Math.round(Math.min(el.w, el.h) / 2), 1, v => el.radius = v) : null,
    el.shape === 'star' || el.shape === 'burst' || el.shape === 'wave' ? slider(el.shape === 'wave' ? 'Waves' : 'Points', el.points || (el.shape === 'star' ? 5 : el.shape === 'wave' ? 2 : 16), el.shape === 'wave' ? 1 : 3, el.shape === 'wave' ? 8 : 40, 1, v => el.points = v) : null,
    el.shape === 'star' || el.shape === 'frame' ? slider(el.shape === 'frame' ? 'Frame width' : 'Inner size', Math.round((el.inner || (el.shape === 'frame' ? .12 : .45)) * 100), 5, el.shape === 'frame' ? 45 : 95, 1, v => el.inner = v / 100, v => v + '%') : null,
    el.shape === 'blob' ? h('button', { class: 'pb wide', type: 'button', onclick: () => { el.seed = (Math.random() * 1e5) | 0; commit(); } }, 'New blob shape') : null));
}
function iconProps(el) {
  P.append(group('Icon',
    prow('Colour', colorBtn(el.color, v => el.color = v)),
    slider('Line width', el.sw || 1.8, .5, 4, .1, v => el.sw = v, v => (+v).toFixed(1)),
    h('div', { class: 'btnrow' }, pb('Outline', 'Outline icon', () => { el.solid = false; commit(); }, !el.solid, 'wide'), pb('Solid', 'Solid icon', () => { el.solid = true; commit(); }, el.solid, 'wide')),
    h('p', { class: 'hint', style: 'margin-top:8px' }, 'Pick another icon in Elements while this one is selected to swap it.')));
}
const FILTERS = [
  ['Original', {}], ['Vivid', { sat: 45, contrast: 12 }], ['Warm', { warm: 45, sat: 10 }], ['Cool', { warm: -45 }], ['Mono', { gray: 100 }],
  ['Noir', { gray: 100, contrast: 45, bright: -8 }], ['Vintage', { sepia: 60, fade: 40, vignette: 40 }], ['Fade', { fade: 70, contrast: -15 }],
  ['Dreamy', { blur: 12, bright: 10, fade: 30 }], ['Drama', { contrast: 50, sat: -20, vignette: 60 }], ['Sunny', { bright: 12, warm: 30, sat: 20 }], ['Moody', { bright: -18, sat: -30, contrast: 20, vignette: 50 }],
  ['Duo blue', { duo: ['#101a4a', '#7de3ff'] }], ['Duo pink', { duo: ['#2d0a52', '#ff8fc7'] }], ['Duo gold', { duo: ['#241400', '#ffd166'] }],
];
function imageProps(el) {
  const f = el.filter || (el.filter = {});
  P.append(group('Photo',
    h('div', { class: 'btnrow', style: 'margin-bottom:8px' },
      h('button', { class: 'pb wide', type: 'button', onclick: () => { replaceTarget = el.id; $('fileReplace').click(); } }, el.src ? 'Replace photo' : 'Add a photo'),
      el.src ? h('button', { class: 'pb wide', type: 'button', onclick: () => { page().bg.image = el.src; page().bg.filter = clone(f); page().els = page().els.filter(x => x !== el); sel = []; commit(); } }, 'Set as background') : null),
    el.src ? h('div', { class: 'btnrow', style: 'margin-bottom:8px' },
      h('button', { class: 'pb wide', type: 'button', style: 'background:var(--accent-bg);border-color:var(--accent)', onclick: () => bgDialog(el) }, svg(ICO.wand), 'Remove background'),
      el.srcOriginal ? h('button', { class: 'pb wide', type: 'button', onclick: () => { el.src = el.srcOriginal; el.srcOriginal = null; commit(); } }, 'Restore original') : null) : null,
    el.credit && el.src ? h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'Photo by ', h('a', { href: el.credit.url, target: '_blank', rel: 'noopener', style: 'color:var(--accent)' }, el.credit.by), ' on Pexels') : null,
    h('div', { class: 'prow' }, h('span', null, 'Shape'), h('select', { onchange: e => { el.mask = e.target.value; if (el.mask === 'blob' && !el.seed) el.seed = 7; commit(); } }, C.MASKS.map(([k, n]) => h('option', { value: k, selected: (el.mask || 'none') === k }, n)))),
    el.src ? [slider('Zoom', Math.round((el.zoom || 1) * 100), 100, 400, 1, v => el.zoom = v / 100, v => v + '%'),
      slider('Move X', Math.round((el.px || 0) * 100), -100, 100, 1, v => el.px = v / 100),
      slider('Move Y', Math.round((el.py || 0) * 100), -100, 100, 1, v => el.py = v / 100)] : h('p', { class: 'hint' }, 'Drag a photo from Uploads onto this frame, or drop one from your computer.'),
    el.src ? h('button', { class: 'pb wide', type: 'button', style: 'width:100%;margin-top:4px', onclick: () => { el.src = null; commit(); } }, 'Empty this frame') : null));
  if (!el.src) return;
  P.append(group('Filters', h('div', { class: 'fxgrid' }, FILTERS.map(([n, v]) => h('button', { type: 'button', class: JSON.stringify(v) === JSON.stringify(Object.fromEntries(Object.entries(f).filter(([, x]) => x))) ? 'on' : '', onclick: () => { el.filter = clone(v); commit(); } }, n)))));
  if (f.duo) P.append(group('Duotone', prow('Shadows', colorBtn(f.duo[0], v => { f.duo = [v, f.duo[1]]; })), prow('Highlights', colorBtn(f.duo[1], v => { f.duo = [f.duo[0], v]; }))));
  const st = el.stick;
  P.append(group(['Sticker outline', h('label', null, h('input', { type: 'checkbox', checked: !!(st && st.w), onchange: e => { el.stick = e.target.checked ? { w: Math.round(S() * .012), color: '#ffffff' } : null; commit(); } }), 'On')],
    st && st.w ? [prow('Colour', colorBtn(st.color, v => st.color = v)), slider('Thickness', st.w, 1, Math.round(S() * .05), 1, v => st.w = v)] : h('p', { class: 'hint' }, 'A border that follows the subject — best after Remove background.')));
  P.append(group('Adjust',
    slider('Brightness', f.bright || 0, -100, 100, 1, v => f.bright = v), slider('Contrast', f.contrast || 0, -100, 100, 1, v => f.contrast = v),
    slider('Saturation', f.sat || 0, -100, 100, 1, v => f.sat = v), slider('Warmth', f.warm || 0, -100, 100, 1, v => f.warm = v),
    slider('Fade', f.fade || 0, 0, 100, 1, v => f.fade = v), slider('Blur', f.blur || 0, 0, 100, 1, v => f.blur = v), slider('Vignette', f.vignette || 0, 0, 100, 1, v => f.vignette = v),
    h('button', { class: 'pb wide', type: 'button', style: 'width:100%', onclick: () => { el.filter = {}; commit(); } }, 'Reset adjustments')));
  const bd = el.border || { w: 0, color: '#ffffff' };
  P.append(group('Border', prow('Colour', colorBtn(bd.color, v => { el.border = Object.assign({}, bd, el.border, { color: v }); })), slider('Width', bd.w || 0, 0, Math.round(S() * .04), 1, v => { el.border = Object.assign({}, bd, el.border, { w: v }); })));
}
function buildMultiProps(els) {
  const grouped = isOneGroup(els);
  P.append(group([grouped ? `Group of ${els.length}` : `${els.length} elements`, h('span', { class: 'btnrow' }, pb(ICO.copy, 'Duplicate', duplicate), pb(ICO.trash, 'Delete', del, false, 'danger'))]),
    group('Group', h('button', { class: 'pb wide', type: 'button', style: 'width:100%', onclick: grouped ? ungroupSel : groupSel }, grouped ? 'Ungroup (Ctrl+Shift+G)' : 'Group (Ctrl+G)'), grouped ? h('p', { class: 'hint', style: 'margin-top:8px' }, 'Double-click a member to edit just that one.') : null),
    group('Align to each other', h('div', { class: 'btnrow' },
      pb(ICO.alL, 'Align left', () => alignTo('l')), pb(ICO.alC, 'Align centres', () => alignTo('c')), pb(ICO.alR, 'Align right', () => alignTo('r')),
      pb(ICO.alT, 'Align top', () => alignTo('t')), pb(ICO.alM, 'Align middles', () => alignTo('m')), pb(ICO.alB, 'Align bottom', () => alignTo('b')),
      pb(ICO.distH, 'Space evenly across', () => distribute('h')), pb(ICO.distV, 'Space evenly down', () => distribute('v')))),
    group('Arrange', h('div', { class: 'btnrow' }, pb('To front', 'Bring to front', () => reorder('front'), false, 'wide'), pb('To back', 'Send to back', () => reorder('back'), false, 'wide'))),
    group('Colour', h('p', { class: 'hint', style: 'margin-bottom:8px' }, 'Recolour everything selected at once.'), colorBtn(C.fillColor(els[0].fill || els[0].color), v => { for (const el of els) { if (el.type === 'text' || el.type === 'icon') el.color = v; else if (el.type === 'shape') el.fill = v; } })),
    group('Opacity', slider('Opacity', 100, 0, 100, 1, v => els.forEach(el => el.opacity = v / 100), v => v + '%')));
}
function buildPageProps() {
  const pg = page(), bg = pg.bg;
  P.append(group('Design', h('p', { class: 'hint', style: 'margin-bottom:8px;color:var(--muted)' }, sizeLabel()),
    h('div', { class: 'btnrow' }, h('button', { class: 'pb wide', type: 'button', onclick: resizeDialog }, 'Resize'), h('button', { class: 'pb wide', type: 'button', onclick: () => showTab('templates') }, 'Templates'))));
  P.append(group('Background',
    prow('Colour', colorBtn(bg.fill, v => bg.fill = v, { gradient: true })),
    h('div', { class: 'prow' }, h('span', null, 'Pattern'), h('select', { onchange: e => { const k = e.target.value; bg.pattern = k ? Object.assign({ color: C.lum(C.fillColor(bg.fill)) < .4 ? '#ffffff' : '#000000', opacity: .12, scale: 1, seed: 11 }, bg.pattern, { kind: k }) : null; commit(); } },
      h('option', { value: '' }, 'None'), C.PATTERNS.map(([k, n]) => h('option', { value: k, selected: bg.pattern && bg.pattern.kind === k }, n)))),
    bg.pattern ? [prow('Pattern colour', colorBtn(bg.pattern.color, v => bg.pattern.color = v)),
      slider('Strength', Math.round(bg.pattern.opacity * 100), 2, 100, 1, v => bg.pattern.opacity = v / 100, v => v + '%'),
      slider('Size', Math.round(bg.pattern.scale * 100), 20, 400, 5, v => bg.pattern.scale = v / 100, v => v + '%')] : null,
    bg.image ? [h('div', { class: 'sec' }, 'Photo background'),
      prow('Tint', colorBtn(bg.tint || '#000000', v => { bg.tint = v; if (bg.tintA == null) bg.tintA = .3; })),
      slider('Tint strength', Math.round((bg.tint ? (bg.tintA == null ? .35 : bg.tintA) : 0) * 100), 0, 95, 1, v => { if (!bg.tint) bg.tint = '#000000'; bg.tintA = v / 100; }, v => v + '%'),
      h('button', { class: 'pb wide', type: 'button', style: 'width:100%', onclick: () => { bg.image = null; bg.tint = null; commit(); } }, 'Remove photo background')] : null));
  pageAnimProps();
  P.append(group('Page', h('div', { class: 'btnrow' },
    h('button', { class: 'pb wide', type: 'button', onclick: () => addPage(false) }, 'Add page'),
    h('button', { class: 'pb wide', type: 'button', onclick: () => addPage(true) }, 'Duplicate'),
    h('button', { class: 'pb wide danger', type: 'button', onclick: delPage, disabled: doc.pages.length < 2 }, 'Delete'))));
  P.append(group('Tips', h('p', { class: 'hint' },
    'Double-click text to edit it, a photo to replace it, or a shape to type inside it. ', h('br'),
    'Drag photos onto frames. Shift-click to select several. Hold Shift to snap rotation; Alt to move without snapping. ', h('br'),
    'Ctrl+D duplicates, arrows nudge, Ctrl+scroll zooms, Space+drag pans.')));
}

// ---------------------------------------------------------------- drawer tabs
const TABS = [['templates', 'Templates'], ['elements', 'Elements'], ['photos', 'Photos'], ['text', 'Text'], ['uploads', 'Uploads'], ['background', 'Background'], ['brand', 'Brand'], ['layers', 'Layers']];
function buildRail() {
  const r = $('rail'); r.textContent = '';
  for (const [k, n] of TABS) r.append(h('button', { type: 'button', class: k === tab && !$('drawer').classList.contains('closed') ? 'on' : '', 'data-tab': k, onclick: () => { if (tab === k && !$('drawer').classList.contains('closed')) closeDrawer(); else showTab(k); } }, svg(ICO[k]), n));
}
function closeDrawer() { $('drawer').classList.add('closed'); buildRail(); setTimeout(resizeCanvas, 0); }
function showTab(k) {
  const wasClosed = $('drawer').classList.contains('closed');
  tab = k; $('drawer').classList.remove('closed');
  $('dTitle').textContent = TABS.find(t => t[0] === k)[1];
  const body = $('dBody');
  if (stopDrawerGrid) { stopDrawerGrid(); stopDrawerGrid = null; }
  const keepScroll = body.dataset.tab === k ? body.scrollTop : 0;
  body.textContent = ''; body.dataset.tab = k;
  ({ templates: tabTemplates, elements: tabElements, photos: tabPhotos, text: tabText, uploads: tabUploads, background: tabBackground, brand: tabBrand, layers: tabLayers })[k](body);
  body.scrollTop = keepScroll;
  buildRail();
  if (wasClosed) setTimeout(resizeCanvas, 0);
}

// ---- templates (lazy grid shared with the home screen)
const thumbQueue = [];
let thumbBusy = false;
function queueThumb(fn) { thumbQueue.push(fn); if (!thumbBusy) { thumbBusy = true; requestAnimationFrame(pumpThumbs); } }
function pumpThumbs() {
  const t0 = performance.now();
  while (thumbQueue.length && performance.now() - t0 < 14) { try { thumbQueue.shift()(); } catch (err) { console.error(err); } }
  if (thumbQueue.length) requestAnimationFrame(pumpThumbs); else thumbBusy = false;
}
function tplCard(d, W, H, tw, onPick) {
  const d2 = 2, th = Math.round(tw * H / W);
  const c = document.createElement('canvas'); c.width = tw * d2; c.height = th * d2;
  const card = h('button', { class: 'tcard', type: 'button', title: TP.describe(d), onclick: () => onPick(d) }, c, h('span', { class: 'tl' }, TP.describe(d)));
  card._draw = () => {
    const pg = TP.build(d, W, H);
    const x = c.getContext('2d'); const k = tw * d2 / W; x.scale(k, k);
    C.renderPage(x, pg, W, H, { scale: k, editor: true });
  };
  return card;
}
function lazyGrid(grid, sentinel, root, list, W, H, tw, onPick) {
  let shown = 0;
  const io = new IntersectionObserver(ents => {
    for (const en of ents) if (en.isIntersecting) { io.unobserve(en.target); const t = en.target; queueThumb(() => { if (t.isConnected) t._draw(); }); }
  }, { root, rootMargin: '400px' });
  const more = () => {
    const n = Math.min(list.length, shown + 36);
    for (; shown < n; shown++) { const card = tplCard(list[shown], W, H, tw, onPick); grid.append(card); io.observe(card); }
  };
  more();
  const so = new IntersectionObserver(ents => { if (ents.some(e => e.isIntersecting) && shown < list.length) more(); }, { root, rootMargin: '800px' });
  so.observe(sentinel);
  return () => { io.disconnect(); so.disconnect(); };
}
const tplFilter = { q: '', cat: '' };
let stopDrawerGrid = null;
function tabTemplates(body) {
  const q = h('input', { class: 'search', type: 'search', placeholder: 'Search 11,000+ templates', value: tplFilter.q, 'aria-label': 'Search templates' });
  const chips = h('div', { class: 'chips' }, ['', ...TP.CATEGORIES].map(c => h('button', { type: 'button', class: c === tplFilter.cat ? 'on' : '', onclick: () => { tplFilter.cat = c; showTab('templates'); } }, c || 'All')));
  const count = h('div', { class: 'count' });
  const grid = h('div', { class: 'tgrid' }), sent = h('div', { class: 'sentinel' });
  body.append(q, chips, count, grid, sent);
  let t = 0;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { tplFilter.q = q.value; fill(); }, 250); });
  const fill = () => {
    if (!fontsReadyFlag) { templateFonts.then(() => { fontsReadyFlag = true; if (body.isConnected && tab === 'templates') fill(); }); return; }
    if (stopDrawerGrid) stopDrawerGrid();
    grid.textContent = '';
    const list = TP.search(tplFilter.q, tplFilter.cat);
    count.textContent = `${list.length.toLocaleString()} designs for ${sizeLabel()}`;
    if (!list.length) grid.append(h('p', { class: 'note', style: 'grid-column:1/-1' }, 'Nothing matches that. Try a simpler word, like “sale”, “party” or “menu”.'));
    stopDrawerGrid = lazyGrid(grid, sent, body, list, doc.w, doc.h, 145, applyTemplate);
  };
  fill();
}
function applyTemplate(d) {
  if (!fontsReadyFlag) { templateFonts.then(() => { fontsReadyFlag = true; applyTemplate(d); }); return; }
  if (editingId) stopEdit();
  const pg = TP.build(d, doc.w, doc.h);
  const p = page();
  p.bg = pg.bg; p.els = pg.els; p.tpl = pg.tpl; p.clean = true;
  sel = [];
  commit({ keepClean: true });
  toast('Template applied — Ctrl+Z to undo. Double-click any text to change it.');
  if (window.innerWidth < 980) closeDrawer();
}

// ---- elements
function miniCanvas(draw, size) {
  const c = document.createElement('canvas'); c.width = c.height = (size || 56) * 2;
  const x = c.getContext('2d'); draw(x, c.width); return c;
}
function dragData(el, data) {
  el.draggable = true;
  el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-ld', JSON.stringify(data)); e.dataTransfer.effectAllowed = 'copy'; });
}
function tabElements(body) {
  const q = h('input', { class: 'search', type: 'search', placeholder: 'Search charts, tables, QR, shapes, icons…', 'aria-label': 'Search elements' });
  const box = h('div');
  body.append(q, box);
  const fill = () => {
    box.textContent = '';
    const w = q.value.trim().toLowerCase();
    const m = s => !w || s.toLowerCase().includes(w);
    if (m('qr code link wifi wi-fi contact scan barcode')) {
      box.append(h('div', { class: 'sec' }, 'QR code'),
        h('button', { class: 'bigbtn', type: 'button', style: 'display:flex;gap:10px;align-items:center', onclick: () => qrDialog(null) }, svg(ICO.qr), h('span', null, h('b', null, 'Add a QR code'), h('br'), h('small', { style: 'color:var(--muted)' }, 'Website, Wi-Fi, contact card, email, phone…'))));
    }
    if (m('photo grid collage frames layout')) {
      box.append(h('div', { class: 'sec' }, 'Photo grids'));
      box.append(h('div', { class: 'egrid' }, GRIDS.map(([n, cells]) => h('button', { class: 'eb', type: 'button', title: n + ' photo grid', onclick: () => addGrid(cells) }, miniCanvas((x, S2) => { const p0 = S2 * .12, w = S2 - p0 * 2, g = S2 * .035; cells.forEach(([cx, cy, cw, ch]) => { x.fillStyle = '#9aa6bf'; x.fillRect(p0 + cx * w + g / 2, p0 + cy * w + g / 2, cw * w - g, ch * w - g); }); })))));
    }
    const charts = C.CHART_KINDS.filter(([k, n]) => m(n + ' chart graph data'));
    if (charts.length) {
      box.append(h('div', { class: 'sec' }, 'Charts'));
      box.append(h('div', { class: 'egrid' }, charts.map(([k, n]) => { const b = h('button', { class: 'eb', type: 'button', title: n + ' chart', onclick: () => addChart(k) }, miniCanvas((x, S2) => { x.fillStyle = '#ffffff'; x.beginPath(); x.roundRect ? x.roundRect(2, 2, S2 - 4, S2 - 4, 10) : x.rect(2, 2, S2 - 4, S2 - 4); x.fill(); const round = k === 'pie' || k === 'donut'; C.drawElement(x, Object.assign({ type: 'chart', kind: k, x: 8, y: 10, w: S2 - 16, h: S2 - 20, surface: '#ffffff', values: false, legend: false, grid: round ? undefined : false, textScale: .01 }, chartDefaults(k)), { scale: 1 }); })); dragData(b, { kind: 'chart', k }); return b; })));
    }
    const tables = Object.keys(TABLE_STYLES).filter(k => m(k + ' table grid rows columns price list schedule'));
    if (tables.length) {
      box.append(h('div', { class: 'sec' }, 'Tables'));
      box.append(h('div', { class: 'egrid three' }, tables.map(k => { const b = h('button', { class: 'eb', type: 'button', title: k + ' table', onclick: () => addTable(k) }, miniCanvas((x, S2) => { x.fillStyle = '#ffffff'; x.fillRect(0, 0, S2, S2); const t = Object.assign({ type: 'table', rows: [['A', 'B', 'C'], ['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']], font: 'Sans', size: S2 * .1, x: S2 * .08, y: 0, w: S2 * .84 }, TABLE_STYLES[k]); C.syncText(t); t.y = (S2 - t.h) / 2; C.drawElement(x, t, { scale: 1 }); })); dragData(b, { kind: 'table', k }); return b; })));
    }
    const shapes = C.SHAPES.filter(([k, n]) => !['line', 'dashed', 'arrowline'].includes(k) && m(n + ' ' + k + ' shape'));
    if (shapes.length) {
      box.append(h('div', { class: 'sec' }, 'Shapes'));
      box.append(h('div', { class: 'egrid' }, shapes.map(([k, n]) => {
        const b = h('button', { class: 'eb', type: 'button', title: n, onclick: () => addShape(k) }, miniCanvas((x, S2) => {
          const el = { shape: k, w: S2 * .78, h: k === 'wave' || k === 'ribbon' || k === 'parallelogram' ? S2 * .45 : k === 'arch' ? S2 * .8 : S2 * .78, fill: '#9aa6bf', seed: 7, sw: S2 * .08 };
          x.translate((S2 - el.w) / 2, (S2 - el.h) / 2);
          const p = C.shapePath(el);
          if (k === 'ring') { x.lineWidth = el.sw; x.strokeStyle = el.fill; x.stroke(p); } else { x.fillStyle = el.fill; x.fill(p, k === 'frame' ? 'evenodd' : 'nonzero'); }
        }));
        dragData(b, { kind: 'shape', k }); return b;
      })));
    }
    const lines = [['line', 'Line'], ['dashed', 'Dashed line'], ['arrowline', 'Arrow']].filter(([k, n]) => m(n + ' line'));
    if (lines.length) {
      box.append(h('div', { class: 'sec' }, 'Lines'));
      box.append(h('div', { class: 'egrid' }, lines.map(([k, n]) => { const b = h('button', { class: 'eb', type: 'button', title: n, onclick: () => addShape(k) }, miniCanvas((x, S2) => { x.translate(S2 * .1, S2 * .5 - S2 * .05); C.drawElement(x, { type: 'shape', shape: k, x: 0, y: 0, w: S2 * .8, h: S2 * .1, fill: '#9aa6bf', sw: S2 * .05 }, { scale: 1 }); })); dragData(b, { kind: 'shape', k }); return b; })));
    }
    const frames = C.MASKS.filter(([k, n]) => m(n + ' frame photo picture image'));
    if (frames.length) {
      box.append(h('div', { class: 'sec' }, 'Photo frames'));
      box.append(h('div', { class: 'egrid' }, frames.map(([k, n]) => { const b = h('button', { class: 'eb', type: 'button', title: n + ' frame', onclick: () => addFrame(k) }, miniCanvas((x, S2) => { const w = S2 * .72, hh = k === 'arch' ? S2 * .85 : k === 'none' ? S2 * .55 : S2 * .72; C.drawElement(x, { type: 'image', src: null, x: (S2 - w) / 2, y: (S2 - hh) / 2, w, h: hh, mask: k, seed: 7, ph: '#aab4c8' }, { scale: 1, editor: true }); })); dragData(b, { kind: 'frame', k }); return b; })));
    }
    const icons = Object.keys(C.ICONS).filter(k => m(k + ' icon'));
    if (icons.length) {
      box.append(h('div', { class: 'sec' }, `Icons`));
      box.append(h('div', { class: 'egrid five' }, icons.map(k => {
        const b = h('button', { class: 'eb', type: 'button', title: k, onclick: () => { const cur = selEls()[0]; if (cur && cur.type === 'icon' && sel.length === 1) { cur.icon = k; commit(); } else addIcon(k); } },
          miniCanvas((x, S2) => { C.drawElement(x, { type: 'icon', icon: k, x: S2 * .15, y: S2 * .15, w: S2 * .7, h: S2 * .7, color: '#dfe4ee', sw: 1.6 }, { scale: 1 }); }, 40));
        dragData(b, { kind: 'icon', k }); return b;
      })));
    }
    if (!w || 'sticker emoji'.includes(w)) {
      box.append(h('div', { class: 'sec' }, 'Stickers'));
      box.append(h('div', { class: 'egrid five' }, EMOJI.map(ch => { const b = h('button', { class: 'eb emoji', type: 'button', title: 'Sticker', onclick: () => addEmoji(ch) }, ch); dragData(b, { kind: 'emoji', k: ch }); return b; })));
    }
    if (!box.children.length) box.append(h('p', { class: 'note' }, 'No elements match that search.'));
  };
  q.addEventListener('input', fill);
  fill();
}

// ---- text
const COMBOS = [
  { n: 'Sale', els: s => [T('BIG SALE', 'Anton', 400, s * .16, '#111111'), T('UP TO 50% OFF', 'Montserrat', 700, s * .05, '#ffffff', { box: { color: '#ff3131', pad: .35, r: .1, full: true }, ls: .1 })] },
  { n: 'Elegant', els: s => [T('Olivia & James', 'Great Vibes', 400, s * .12, '#2b2622'), T('ARE GETTING MARRIED', 'Josefin Sans', 400, s * .032, '#6d5d4b', { ls: .3 })] },
  { n: 'Headline + body', els: s => [T('Your Big Idea', 'Poppins', 800, s * .09, '#111111'), T('Add a short description that explains the idea in a sentence or two.', 'Poppins', 400, s * .032, '#444444', { w: s * .6 })] },
  { n: 'Hollow', els: s => [T('SUMMER', 'Archivo Black', 400, s * .14, '#ff66c4', { outline: { w: 3, color: '#ff66c4', only: true } }), T('SUMMER', 'Archivo Black', 400, s * .14, '#ff66c4')] },
  { n: 'Quote', els: s => [T('“Done is better than perfect.”', 'Playfair Display', 400, s * .075, '#1f1f1f', { italic: true, w: s * .7 }), T('— SHERYL SANDBERG', 'Montserrat', 700, s * .028, '#777777', { ls: .2 })] },
  { n: 'Neon', els: s => [T('OPEN LATE', 'Righteous', 400, s * .11, '#5ce1e6', { shadow: { color: '#5ce1e6', alpha: 1, blur: s * .04, x: 0, y: 0 } })] },
  { n: 'Retro', els: s => [T('Good Vibes', 'Alfa Slab One', 400, s * .12, '#ffbd59', { outline: { w: 4, color: '#1b1b3a' }, shadow: { color: '#ff5757', alpha: 1, blur: 0, x: s * .012, y: s * .012 } }), T('ONLY', 'Josefin Sans', 700, s * .04, '#1b1b3a', { ls: .5 })] },
  { n: 'Highlight', els: s => [T('Tips you’ll actually use', 'Permanent Marker', 400, s * .07, '#111111', { box: { color: '#ffde59', pad: .2, r: .1 }, w: s * .7 })] },
  { n: 'Event', els: s => [T('SATURDAY · JUNE 14', 'Josefin Sans', 700, s * .03, '#8c52ff', { ls: .2 }), T('Grand Opening', 'DM Serif Display', 400, s * .1, '#111111'), T('10 AM – 4 PM · 123 MAIN STREET', 'Josefin Sans', 400, s * .026, '#555555', { ls: .12 })] },
  { n: 'Price', els: s => [T('$29', 'Archivo Black', 400, s * .2, '#00bf63'), T('PER MONTH', 'Montserrat', 700, s * .03, '#111111', { ls: .3 })] },
  { n: 'Handwritten', els: s => [T('Thank you!', 'Caveat', 700, s * .12, '#3c2a1e'), T('We couldn’t have done it without you.', 'Caveat', 400, s * .045, '#3c2a1e', { w: s * .6 })] },
  { n: 'Stacked', els: s => [T('WORK', 'Bebas Neue', 400, s * .15, '#111111', { lh: .9 }), T('HARD', 'Bebas Neue', 400, s * .15, '#5e17eb', { lh: .9 }), T('PLAY', 'Bebas Neue', 400, s * .15, '#111111', { lh: .9 })] },
  { n: 'Fun', els: s => [T('Party Time!', 'Pacifico', 400, s * .11, '#ff66c4'), T('SATURDAY AT 7', 'Fredoka', 700, s * .04, '#5e17eb', { ls: .1 })] },
  { n: 'Classic', els: s => [T('THE GRAND', 'Cinzel', 700, s * .08, '#1d2a24', { ls: .1 }), T('Est. 1998 · Fine Dining', 'Cormorant Garamond', 500, s * .045, '#6b5a3e', { italic: true })] },
];
function T(text, font, weight, size, color, o) { return Object.assign({ type: 'text', text, font, weight, size, color, align: 'center', lh: 1.15, ls: 0, x: 0, y: 0, w: 0, h: 0, rot: 0, opacity: 1 }, o || {}); }
function comboEls(combo, s) {
  const els = combo.els(s);
  for (const el of els) { if (!el.w) { el.w = 1e5; el.w = Math.ceil(C.textWidth(el)) + 4; } C.syncText(el); }
  const W = Math.max(...els.map(e => e.w));
  let y = 0, prev = null;
  for (const el of els) {
    if (prev && !(prev.outline && prev.outline.only && prev.text === el.text)) y += s * .015;
    else if (prev) y -= prev.h + (s * .015) - s * .04;
    el.x = (W - el.w) / 2; el.y = y; y += el.h; prev = el;
  }
  return { els, w: W, h: y };
}
function tabText(body) {
  body.append(
    h('button', { class: 'bigbtn accent', type: 'button', onclick: () => addText('heading') }, 'Add a text box'),
    h('button', { class: 'bigbtn', type: 'button', style: 'font-size:22px;font-weight:800', onclick: () => addText('heading') }, 'Add a heading'),
    h('button', { class: 'bigbtn', type: 'button', style: 'font-size:16px;font-weight:600', onclick: () => addText('sub') }, 'Add a subheading'),
    h('button', { class: 'bigbtn', type: 'button', style: 'font-size:12.5px', onclick: () => addText('body') }, 'Add a little bit of body text'),
    h('div', { class: 'sec' }, 'Font combinations'));
  for (const combo of COMBOS) {
    const b = h('button', { class: 'combo', type: 'button', title: combo.n, onclick: () => {
      const s = S(), grp = comboEls(combo, s);
      const ox = (doc.w - grp.w) / 2, oy = (doc.h - grp.h) / 2;
      const ids = [];
      for (const el of grp.els) { el.id = nid(); el.x += ox; el.y += oy; page().els.push(el); ids.push(el.id); }
      sel = ids; commit();
    } });
    const c = miniCanvas(() => {}, 10);
    c.width = 560; c.height = 200; c.style.width = '100%'; c.style.height = 'auto';
    b.append(c); body.append(b);
    Promise.all(combo.els(100).map(e => C.loadFont(e.font, e.weight, e.italic))).then(() => {
      const x = c.getContext('2d');
      const grp = comboEls(combo, 1000);
      const k = Math.min(520 / grp.w, 170 / grp.h);
      x.translate((560 - grp.w * k) / 2, (200 - grp.h * k) / 2); x.scale(k, k);
      grp.els.forEach(el => C.drawElement(x, el, { scale: k }));
    });
  }
  body.append(h('div', { class: 'sec' }, 'Your fonts'),
    h('button', { class: 'bigbtn', type: 'button', onclick: () => { fontTarget = null; $('fileFont').click(); } }, 'Upload a font (.ttf, .otf, .woff)'),
    [...C.custom.keys()].length ? h('p', { class: 'note' }, 'Loaded: ' + [...C.custom.keys()].join(', ')) : h('p', { class: 'note' }, 'Fonts you upload stay on this device and are saved inside your design file.'));
}

// ---- uploads
let replaceTarget = null;
function tabUploads(body) {
  body.append(h('button', { class: 'bigbtn accent', type: 'button', onclick: () => $('fileImg').click() }, 'Upload photos'),
    h('p', { class: 'note', style: 'margin:0 0 12px' }, 'Or drag them onto the page, or paste a screenshot. Drag a photo onto a frame to fill it. Nothing is uploaded anywhere — photos stay on this device.'));
  if (!uploads.length) { body.append(h('p', { class: 'note' }, 'No photos yet.')); return; }
  body.append(h('div', { class: 'upgrid' }, uploads.filter(id => images.has(id)).map(id => {
    const b = h('button', { type: 'button', title: 'Add to design', onclick: () => {
      const cur = selEls()[0];
      if (cur && sel.length === 1 && cur.type === 'image' && !cur.locked) { cur.src = id; commit(); }
      else { addPhotoEl(id); commit(); }
    } }, h('img', { src: images.get(id).src, alt: '' }));
    dragData(b, { kind: 'img', k: id }); return b;
  })));
}

// ---- background
function tabBackground(body) {
  const bg = page().bg;
  const set = f => { bg.fill = f; commit(); };
  body.append(h('div', { class: 'sec' }, 'Colours'), h('div', { class: 'swgrid' }, [...new Set([...brand.colors, ...SWATCHES])].map(c => h('button', { class: 'sw sq', type: 'button', title: c, style: `background:${c}`, onclick: () => set(c) }))),
    h('div', { style: 'margin-top:8px' }, h('span', { class: 'note', style: 'margin-right:8px' }, 'Custom'), colorBtn(bg.fill, v => bg.fill = v, { gradient: true })));
  body.append(h('div', { class: 'sec' }, 'Gradients'), h('div', { class: 'swgrid' }, GRADIENTS.map(c => h('button', { class: 'sw sq', type: 'button', style: `background:linear-gradient(135deg,${c.join(',')})`, onclick: () => set({ g: 'linear', a: 45, c: c.slice() }) }))));
  body.append(h('div', { class: 'sec' }, 'Patterns', bg.pattern ? h('button', { type: 'button', onclick: () => { bg.pattern = null; commit(); showTab('background'); } }, 'Remove') : null),
    h('div', { class: 'egrid' }, C.PATTERNS.map(([k, n]) => h('button', { class: 'eb', type: 'button', title: n, style: bg.pattern && bg.pattern.kind === k ? 'border-color:var(--accent)' : '', onclick: () => {
      bg.pattern = Object.assign({ color: C.lum(C.fillColor(bg.fill)) < .4 ? '#ffffff' : '#000000', opacity: .14, scale: 1, seed: 11 }, bg.pattern, { kind: k }); commit(); showTab('background');
    } }, miniCanvas((x, S2) => { x.fillStyle = '#fff'; x.fillRect(0, 0, S2, S2); C.drawBackground(x, { fill: '#ffffff', pattern: { kind: k, color: '#333', opacity: .7, scale: 1.4 } }, S2, S2); })))));
  body.append(h('div', { class: 'sec' }, 'Photo background'));
  const ups = uploads.filter(id => images.has(id));
  if (!ups.length) body.append(h('p', { class: 'note' }, 'Upload a photo, then pick it here to fill the whole page.'), h('button', { class: 'bigbtn', type: 'button', onclick: () => { tab = 'uploads'; $('fileImg').click(); } }, 'Upload a photo'));
  else body.append(h('div', { class: 'upgrid' }, ups.map(id => h('button', { type: 'button', title: 'Use as background', onclick: () => { bg.image = id; commit(); } }, h('img', { src: images.get(id).src, alt: '' })))));
}

// ---- brand kit
function loadBrand() { try { return Object.assign({ colors: [], head: '', body: '', logo: null }, JSON.parse(localStorage.getItem('ld-brand') || '{}')); } catch { return { colors: [], head: '', body: '', logo: null }; } }
function saveBrand() { try { localStorage.setItem('ld-brand', JSON.stringify(brand)); } catch { toast('Couldn’t save the brand kit in this browser (storage is full or blocked).', true); } }
function tabBrand(body) {
  body.append(h('p', { class: 'note', style: 'margin:0 0 6px' }, 'Your brand kit is kept in this browser and used across every design.'));
  const nat = h('input', { type: 'color', value: '#00b0ec', style: 'width:0;height:0;opacity:0;position:absolute' });
  nat.addEventListener('change', () => { brand.colors.push(nat.value); saveBrand(); showTab('brand'); });
  body.append(h('div', { class: 'sec' }, 'Brand colours'), nat,
    h('div', { class: 'swgrid' }, brand.colors.map((c, i) => h('button', { class: 'sw', type: 'button', title: `${c} — click to remove`, style: `background:${c}`, onclick: () => { brand.colors.splice(i, 1); saveBrand(); showTab('brand'); } })),
      h('button', { class: 'sw', type: 'button', title: 'Add a colour', style: 'background:var(--panel2);color:var(--muted);font-size:18px', onclick: () => nat.click() }, '+')),
    h('p', { class: 'note' }, 'Click a colour to remove it.'));
  const fsel = (k) => { const s = fontSelect(brand[k] || 'Sans', v => { brand[k] = v; saveBrand(); }); return s; };
  body.append(h('div', { class: 'sec' }, 'Brand fonts'), prow('Headings', fsel('head')), prow('Body', fsel('body')));
  body.append(h('div', { class: 'sec' }, 'Logo'));
  if (brand.logo) {
    body.append(h('div', { class: 'upgrid' }, h('button', { type: 'button', title: 'Add logo to design', onclick: () => { const id = logoId(); addPhotoEl(id); const el = selEls()[0]; el.w *= .5; el.h *= .5; el.x = (doc.w - el.w) / 2; el.y = (doc.h - el.h) / 2; commit(); } }, h('img', { src: brand.logo, alt: 'Logo', style: 'object-fit:contain;background:#fff' }))),
      h('div', { class: 'btnrow', style: 'margin-top:6px' }, h('button', { class: 'pb wide', type: 'button', onclick: () => $('fileLogo').click() }, 'Replace'), h('button', { class: 'pb wide danger', type: 'button', onclick: () => { brand.logo = null; saveBrand(); showTab('brand'); } }, 'Remove')));
  } else body.append(h('button', { class: 'bigbtn', type: 'button', onclick: () => $('fileLogo').click() }, 'Upload your logo'));
  body.append(h('div', { class: 'sec' }, 'Apply'), h('button', { class: 'bigbtn accent', type: 'button', onclick: applyBrand }, 'Apply brand to this page'),
    h('p', { class: 'note' }, 'Swaps this page’s colours for your brand colours and its fonts for your brand fonts. Ctrl+Z undoes it.'));
}
let logoImgId = null;
function logoId() { if (!logoImgId || !images.has(logoImgId) || images.get(logoImgId).src !== brand.logo) logoImgId = addImage(brand.logo); return logoImgId; }
function applyBrand() {
  const p = page();
  if (!brand.colors.length && !brand.head && !brand.body) return toast('Add some brand colours or fonts first.');
  const texts = p.els.filter(e => e.type === 'text');
  const maxS = Math.max(0, ...texts.map(e => e.size));
  for (const el of texts) { const f = el.size >= maxS * .6 ? brand.head : brand.body; if (f) { el.font = f; C.syncText(el); } }
  if (brand.colors.length) {
    const freq = new Map();
    const count = c => { if (typeof c === 'string' && /^#/.test(c)) { const l = C.lum(c); if (l > .04 && l < .9) freq.set(c.toLowerCase(), (freq.get(c.toLowerCase()) || 0) + 1); } };
    const walk = (f, fn) => { if (!f || f === 'none') return f; if (typeof f === 'string') return fn(f); if (f.c) return Object.assign({}, f, { c: f.c.map(fn) }); return f; };
    walk(p.bg.fill, c => (count(c), c));
    for (const el of p.els) { walk(el.fill, c => (count(c), c)); walk(el.color, c => (count(c), c)); count(el.stroke); }
    const order = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const map = new Map(order.map((c, i) => [c, brand.colors[i % brand.colors.length]]));
    const sw = c => map.get(String(c).toLowerCase()) || c;
    p.bg.fill = walk(p.bg.fill, sw);
    for (const el of p.els) { el.fill = walk(el.fill, sw); el.color = walk(el.color, sw); if (el.stroke) el.stroke = sw(el.stroke); if (el.box) el.box.color = sw(el.box.color); }
  }
  commit(); toast('Brand applied — Ctrl+Z to undo.');
}

// ---- layers
function tabLayers(body) {
  const els = page().els.slice().reverse();
  if (!els.length) { body.append(h('p', { class: 'note' }, 'This page is empty. Add a template, text or elements and they’ll be listed here, top first.')); return; }
  body.append(h('p', { class: 'note', style: 'margin:0 0 8px' }, 'Top of the list is in front. Drag to reorder.'));
  let dragId = null;
  for (const el of els) {
    const name = el.type === 'qr' ? 'QR code' : el.type === 'chart' ? 'Chart' : el.type === 'table' ? 'Table' : el.type === 'text' ? el.text.split('\n')[0].slice(0, 40) || 'Text' : el.type === 'image' ? (el.src ? 'Photo' : 'Photo frame') : el.type === 'icon' ? 'Icon: ' + el.icon : (C.SHAPES.find(s => s[0] === el.shape) || [0, 'Shape'])[1];
    const tyIcon = { text: ICO.text, image: C.ICONS.image, icon: C.ICONS.star, shape: ICO.elements, qr: ICO.qr, chart: C.ICONS.chart, table: ICO.table }[el.type];
    const row = h('div', { class: 'layer' + (sel.includes(el.id) ? ' on' : ''), draggable: 'true', onclick: e => { if (e.shiftKey) sel = sel.includes(el.id) ? sel.filter(i => i !== el.id) : [...sel, el.id]; else sel = [el.id]; buildProps(); requestRender(); showTab('layers'); } },
      h('span', { class: 'ty', style: el.group ? 'box-shadow:inset 3px 0 0 var(--accent)' : '' }, svg(tyIcon)), h('span', { class: 'nm' }, name),
      h('button', { type: 'button', class: el.hidden ? 'off' : '', title: el.hidden ? 'Show' : 'Hide', onclick: e => { e.stopPropagation(); el.hidden = !el.hidden; if (el.hidden) sel = sel.filter(i => i !== el.id); commit(); } }, svg(ICO.eye)),
      h('button', { type: 'button', class: el.locked ? '' : 'off', title: el.locked ? 'Unlock' : 'Lock', onclick: e => { e.stopPropagation(); el.locked = !el.locked; commit(); } }, svg(el.locked ? ICO.lock : ICO.unlock)));
    row.addEventListener('dragstart', () => { dragId = el.id; });
    row.addEventListener('dragover', e => { e.preventDefault(); });
    row.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      if (!dragId || dragId === el.id) return;
      const arr = page().els, from = arr.findIndex(x => x.id === dragId), item = arr.splice(from, 1)[0];
      const to = arr.findIndex(x => x.id === el.id);
      arr.splice(to + 1, 0, item); commit();
    });
    body.append(row);
  }
}

// ---------------------------------------------------------------- drag & drop onto the page
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (!doc || $('home').hidden === false) return; if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dropping'); } });
window.addEventListener('dragleave', e => { if (e.dataTransfer.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
  if (!doc || !$('home').hidden) { if (e.dataTransfer.files.length) openFromHomeDrop(e.dataTransfer.files); return; }
  const r = work.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  const at = inside ? toPage(e.clientX - r.left, e.clientY - r.top) : null;
  const ld = e.dataTransfer.getData('text/x-ld');
  if (ld) {
    const d = JSON.parse(ld);
    if (d.kind === 'shape') addShape(d.k, at);
    if (d.kind === 'icon') addIcon(d.k, at);
    if (d.kind === 'frame') addFrame(d.k, at);
    if (d.kind === 'emoji') addEmoji(d.k, at);
    if (d.kind === 'chart') addChart(d.k, at);
    if (d.kind === 'table') addTable(d.k, at);
    if (d.kind === 'img') {
      const t = at && hitTest(at[0], at[1]);
      if (t && t.type === 'image' && !t.locked) { t.src = d.k; sel = [t.id]; } else addPhotoEl(d.k, at);
      commit();
    }
    return;
  }
  if (e.dataTransfer.files.length) {
    const f = e.dataTransfer.files[0];
    if (/\.(ldesign|json)$/i.test(f.name)) return openProjectFile(f);
    if (/\.(ttf|otf|woff2?)$/i.test(f.name)) return loadFontFile(f);
    uploadFiles(e.dataTransfer.files, at);
  }
});
function openFromHomeDrop(files) {
  const f = files[0];
  if (/\.(ldesign|json)$/i.test(f.name)) return openProjectFile(f);
  if (/^image\//.test(f.type)) {
    readImageFile(f).then(src => {
      const id = addImage(src); uploads.unshift(id);
      const im = images.get(id).img;
      im.addEventListener('load', () => { newDoc(im.naturalWidth, im.naturalHeight, { name: f.name.replace(/\.[^.]+$/, '') }); addPhotoEl(id); const el = selEls()[0]; el.x = 0; el.y = 0; el.w = doc.w; el.h = doc.h; commit(); }, { once: true });
    }).catch(() => toast('That image couldn’t be opened.', true));
  }
}

// ---------------------------------------------------------------- keyboard & clipboard
const typing = e => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };
window.addEventListener('keydown', e => {
  if (playing && !typing(e)) { e.preventDefault(); stopPlay(); return; }
  if (e.key === ' ' && !typing(e)) { spaceDown = true; if (doc) cv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (!doc || !$('home').hidden || typing(e) || document.querySelector('.scrim,.present')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
  if (mod && k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return; }
  if (mod && e.altKey && k === 'c') { e.preventDefault(); copyStyle(); return; }
  if (mod && e.altKey && k === 'v') { e.preventDefault(); pasteStyle(); return; }
  if (mod && k === 'c') { copySel(false); return; }
  if (mod && k === 'x') { copySel(true); return; }
  if (mod && k === 'a') { e.preventDefault(); sel = page().els.filter(x => !x.hidden).map(x => x.id); buildProps(); requestRender(); return; }
  if (mod && k === 's') { e.preventDefault(); saveProject(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomAt(view.zoom * 1.2, vw / 2, vh / 2); return; }
  if (mod && k === '-') { e.preventDefault(); zoomAt(view.zoom / 1.2, vw / 2, vh / 2); return; }
  if (mod && k === '0') { e.preventDefault(); fit(); return; }
  if (mod && k === ']') { e.preventDefault(); reorder(e.shiftKey ? 'front' : 'fwd'); return; }
  if (mod && k === '[') { e.preventDefault(); reorder(e.shiftKey ? 'back' : 'bwd'); return; }
  if (mod) return;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); del(); return; }
  if (k === 'escape') { sel = []; closePop(); closeMenu(); buildProps(); requestRender(); return; }
  if (k === 'enter' && sel.length === 1) { const el = selEls()[0]; if (el.type === 'text') { e.preventDefault(); startEdit(el); } return; }
  if (k.startsWith('arrow') && sel.length) {
    e.preventDefault();
    const st = e.shiftKey ? 10 : 1, dx = k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, dy = k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0;
    for (const el of selEls()) if (!el.locked) { el.x += dx; el.y += dy; }
    requestRender(); nudgeCommit(); return;
  }
  if (e.key === '?') { shortcutsDialog(); return; }
  if (k === 'p') { play(doc.pages.length > 1); return; }
  if (k === 't') { addText('heading'); return; }
  if (k === 'r') { addShape('rect'); return; }
  if (k === 'c' || k === 'o') { addShape('ellipse'); return; }
  if (k === 'l') { addShape('line'); return; }
});
window.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; cv.style.cursor = ''; } });
let nudgeT = 0;
function nudgeCommit() { clearTimeout(nudgeT); nudgeT = setTimeout(() => commit(), 350); }
window.addEventListener('paste', e => {
  if (!doc || !$('home').hidden || typing(e)) return;
  const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => /^image\//.test(f.type));
  if (files.length) { e.preventDefault(); uploadFiles(files); return; }
  if (clip) { e.preventDefault(); pasteClip(); return; }
  const t = e.clipboardData && e.clipboardData.getData('text/plain');
  if (t && t.trim()) { e.preventDefault(); const el = addText('body', t.trim().slice(0, 2000)); el.w = Math.min(doc.w * .8, el.w); C.syncText(el); commit(); }
});
cv.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (!doc) return;
  const [sx, sy] = evPos(e), p = toPage(sx, sy), el = hitTest(p[0], p[1]);
  if (el && !sel.includes(el.id)) { sel = [el.id]; buildProps(); requestRender(); }
  const has = sel.length > 0;
  openMenu(e.clientX, e.clientY, [
    ['Copy', 'Ctrl+C', () => copySel(false), !has], ['Paste', 'Ctrl+V', pasteClip, !clip], ['Duplicate', 'Ctrl+D', duplicate, !has], ['Delete', 'Del', del, !has], null,
    ['Bring forward', 'Ctrl+]', () => reorder('fwd'), !has], ['Send backward', 'Ctrl+[', () => reorder('bwd'), !has], ['Bring to front', '', () => reorder('front'), !has], ['Send to back', '', () => reorder('back'), !has], null,
    [selEls().some(x => x.locked) ? 'Unlock' : 'Lock', '', () => { const lk = !selEls().some(x => x.locked); selEls().forEach(x => x.locked = lk); commit(); }, !has],
    [isOneGroup(selEls()) ? 'Ungroup' : 'Group', isOneGroup(selEls()) ? 'Ctrl+Shift+G' : 'Ctrl+G', () => isOneGroup(selEls()) ? ungroupSel() : groupSel(), sel.length < 2],
    ['Select all', 'Ctrl+A', () => { sel = page().els.map(x => x.id); buildProps(); requestRender(); }],
  ]);
});

// ---------------------------------------------------------------- menus
let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function openMenu(x, y, items) {
  closeMenu();
  menuEl = h('div', { class: 'menu', role: 'menu' }, items.map(it => it ? h('button', { type: 'button', disabled: it[3], onclick: () => { closeMenu(); it[2](); } }, it[0], it[1] ? h('kbd', null, it[1]) : null) : h('hr')));
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = clamp(x, 8, window.innerWidth - r.width - 8) + 'px';
  menuEl.style.top = clamp(y, 8, window.innerHeight - r.height - 8) + 'px';
}
$('fileBtn').addEventListener('click', e => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [
    ['New design…', '', goHome], ['Open design file…', '', () => $('fileProject').click()], ['Save design file', 'Ctrl+S', saveProject], null,
    ['Resize…', '', resizeDialog], ['Download…', '', exportDialog], ['Mockups…', '', mockupDialog], ['Present', '', present], null,
    ['Upload photos…', '', () => $('fileImg').click()], ['Upload a font…', '', () => { fontTarget = null; $('fileFont').click(); }], null,
    ['Keyboard shortcuts', '?', shortcutsDialog], ['Install as an app…', '', installApp],
  ]);
});

// ---------------------------------------------------------------- animation
// A page lasts page.dur seconds, or — if unset — long enough for its last
// entrance animation to finish plus a beat to read it (never under 3 s).
function pageDur(pg) {
  if (pg.dur) return pg.dur;
  let end = 0;
  for (const el of pg.els) if (el.anim && el.anim.in && el.anim.in !== 'none') end = Math.max(end, (el.anim.delay || 0) + (el.anim.dur || .8));
  return Math.max(end ? end + 2 : 5, 3);
}
const hasAnim = pg => pg.els.some(e => e.anim && ((e.anim.in && e.anim.in !== 'none') || (e.anim.loop && e.anim.loop !== 'none')));
let playing = null;
function play(all) {
  if (!doc) return;
  if (playing) return stopPlay();
  if (editingId) stopEdit();
  closePop(); sel = []; buildProps();
  playing = { t: 0, t0: performance.now(), all: !!all, from: doc.cur };
  $('playBtn').classList.add('on'); $('playBtn').lastChild.textContent = 'Stop';
  const step = now => {
    if (!playing) return;
    playing.t = (now - playing.t0) / 1000;
    if (playing.t > pageDur(page())) {
      if (playing.all && doc.cur < doc.pages.length - 1) { doc.cur++; playing.t0 = now; playing.t = 0; buildPages(); }
      else { stopPlay(); return; }
    }
    render(); playing.raf = requestAnimationFrame(step);
  };
  playing.raf = requestAnimationFrame(step);
}
function stopPlay() {
  if (!playing) return;
  cancelAnimationFrame(playing.raf);
  playing = null;
  $('playBtn').classList.remove('on'); $('playBtn').lastChild.textContent = 'Play';
  buildPages(); buildProps(); requestRender();
}
function drawPlayBar() {
  const d = pageDur(page()), w = Math.min(1, playing.t / d) * doc.w * view.zoom;
  g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(view.px, view.py + doc.h * view.zoom + 8, doc.w * view.zoom, 3);
  g.fillStyle = '#00b0ec'; g.fillRect(view.px, view.py + doc.h * view.zoom + 8, w, 3);
}
const PAGE_ANIMS = [['rise', 'Rise'], ['fade', 'Fade'], ['pop', 'Pop'], ['slide', 'Slide'], ['typewriter', 'Typewriter'], ['mixed', 'Mix it up']];
function animatePage(kind) {
  const els = page().els.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const big = Math.max(0, ...els.map(e => e.w * e.h));
  let i = 0;
  for (const el of els) {
    if (el.locked && el.w * el.h >= big * .8) { delete el.anim; continue; }
    const background = el.w >= doc.w * .9 && el.h >= doc.h * .9;
    if (kind === 'none') { delete el.anim; continue; }
    let k = kind;
    if (kind === 'typewriter' && el.type !== 'text') k = 'fade';
    if (kind === 'mixed') k = background ? 'fade' : el.type === 'text' ? (el.size > S() * .08 ? 'rise' : 'fade') : el.type === 'image' ? 'zoom' : el.type === 'shape' ? 'pop' : 'rise';
    el.anim = Object.assign({}, el.anim, { in: k, dur: background ? .6 : k === 'typewriter' ? Math.min(2.5, .05 * String(el.text).length + .4) : .7, delay: background ? 0 : +(.15 + i * .18).toFixed(2) });
    if (!background) i++;
  }
  commit();
  play(false);
}
function animProps(el) {
  const a = el.anim || {};
  const set = (k, v) => { el.anim = Object.assign({}, el.anim, { [k]: v }); if (!el.anim.in && !el.anim.loop) delete el.anim; };
  P.append(group('Animate',
    h('div', { class: 'prow' }, h('span', null, 'Entrance'), h('select', { onchange: e => { set('in', e.target.value); commit(); if (e.target.value !== 'none') play(false); } }, h('option', { value: 'none' }, 'None'), C.ANIMS.map(([k, n]) => h('option', { value: k, selected: a.in === k }, n)))),
    a.in && a.in !== 'none' ? [slider('Speed', a.dur || .8, .2, 3, .1, v => set('dur', v), v => (+v).toFixed(1) + ' s'), slider('Delay', a.delay || 0, 0, 8, .1, v => set('delay', v), v => (+v).toFixed(1) + ' s')] : null,
    h('div', { class: 'prow' }, h('span', null, 'Loop'), h('select', { onchange: e => { set('loop', e.target.value); commit(); if (e.target.value !== 'none') play(false); } }, h('option', { value: 'none' }, 'None'), C.LOOPS.map(([k, n]) => h('option', { value: k, selected: a.loop === k }, n)))),
    h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--muted);margin-top:4px' }, h('input', { type: 'checkbox', checked: a.out === 'fade', onchange: e => { set('out', e.target.checked ? 'fade' : null); commit(); } }), 'Fade out at the end'),
    h('button', { class: 'pb wide', type: 'button', style: 'width:100%;margin-top:8px', onclick: () => play(false) }, '▶ Preview page')));
}
function pageAnimProps() {
  const pg = page();
  P.append(group('Animate page',
    h('div', { class: 'fxgrid' }, PAGE_ANIMS.map(([k, n]) => h('button', { type: 'button', onclick: () => animatePage(k) }, n))),
    slider('Page length', pg.dur || pageDur(pg), 1, 30, .5, v => { pg.dur = v; }, v => (+v).toFixed(1) + ' s'),
    h('div', { class: 'btnrow', style: 'margin-top:6px' },
      h('button', { class: 'pb wide', type: 'button', onclick: () => play(false) }, '▶ Play page'),
      h('button', { class: 'pb wide', type: 'button', disabled: !hasAnim(pg), onclick: () => animatePage('none') }, 'Remove')),
    h('p', { class: 'hint', style: 'margin-top:8px' }, 'Download as MP4 or GIF to keep the motion. PNG, JPG and PDF show the finished frame.')));
}

// Frames for video/GIF export: every page in order, each for its own length.
function timeline(pages, fps) {
  const spans = []; let f = 0;
  for (const pg of pages) { const n = Math.max(1, Math.round(pageDur(pg) * fps)); spans.push({ pg, from: f, n }); f += n; }
  return { spans, frames: f };
}
function frameAt(tl, i, fps) { for (const s of tl.spans) if (i < s.from + s.n) return { pg: s.pg, t: (i - s.from) / fps }; const s = tl.spans[tl.spans.length - 1]; return { pg: s.pg, t: s.n / fps }; }
function progressUI(title) {
  const ctl = new AbortController();
  const bar = h('i'), txt = h('div', null, title);
  const sc = h('div', { class: 'scrim' }, h('div', { class: 'dlg', role: 'dialog', 'aria-label': title }, h('h2', null, title), h('div', { class: 'body' }, txt, h('div', { class: 'bgbusy', style: 'position:static;background:none;padding:0' }, h('div', { class: 'bar', style: 'width:100%' }, bar))), h('div', { class: 'foot' }, h('button', { type: 'button', onclick: () => ctl.abort() }, 'Cancel'))));
  document.body.append(sc);
  return { signal: ctl.signal, set: (p, t) => { bar.style.width = Math.round(p * 100) + '%'; if (t) txt.textContent = t; }, close: () => sc.remove() };
}
let videoMod = null;
function loadVideoMod() {
  if (window.LDVideo) return Promise.resolve(window.LDVideo);
  if (!videoMod) videoMod = new Promise((res, rej) => { const s = h('script', { src: '/design/export-video.js' }); s.onload = () => res(window.LDVideo); s.onerror = () => { videoMod = null; rej(new Error('Couldn’t load the video exporter.')); }; document.head.append(s); });
  return videoMod;
}
async function exportMotion(kind, pages, longSide) {
  const V = await loadVideoMod();
  if (kind === 'mp4') V.fixWebmDuration = fixWebmDuration;
  const fps = kind === 'gif' ? 15 : 30;
  let k = Math.min(1, longSide / Math.max(doc.w, doc.h));
  let w = Math.round(doc.w * k), hh = Math.round(doc.h * k);
  if (kind === 'mp4') { w -= w % 2; hh -= hh % 2; }
  k = w / doc.w;
  const tl = timeline(pages, fps);
  const ui = progressUI(kind === 'gif' ? 'Making your GIF…' : 'Making your video…');
  try {
    await imagesReady();
    const draw = (ctx, i) => {
      const { pg, t } = frameAt(tl, i, fps);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, hh);
      ctx.setTransform(w / doc.w, 0, 0, hh / doc.h, 0, 0);
      C.renderPage(ctx, pg, doc.w, doc.h, { scale: k, images: getImg, t, dur: pageDur(pg) });
    };
    const out = await V[kind]({ width: w, height: hh, fps, frames: tl.frames, draw, signal: ui.signal, onProgress: p => ui.set(p, `${Math.round(p * 100)}% · ${(tl.frames / fps).toFixed(1)} s at ${w} × ${hh}`) });
    download(out.blob, safeName() + '.' + out.ext);
    toast(`Downloaded ${out.ext.toUpperCase()} — ${(out.blob.size / 1048576).toFixed(1)} MB.`);
  } catch (err) {
    if (err && err.name === 'AbortError') toast('Cancelled.');
    else { console.error(err); toast('Couldn’t make that: ' + (err.message || err), true); }
  } finally { ui.close(); }
}
// MediaRecorder writes WebM without a duration; add one so players can seek.
// (Same fix as Linear Video; only used by the real-time fallback.)
async function fixWebmDuration(blob, ms) {
  try {
    const headLen = Math.min(blob.size, 65536);
    const b = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
    const vint = (p, keep) => { const first = b[p]; let len = 1, mask = 0x80; while (len <= 8 && !(first & mask)) { len++; mask >>= 1; } if (len > 8) throw new Error('bad vint'); let v = keep ? first : first & (mask - 1); for (let i = 1; i < len; i++) v = v * 256 + b[p + i]; return { v, len }; };
    let p = 0, id = vint(p, true);
    if (id.v !== 0x1A45DFA3) throw new Error('not EBML');
    p += id.len; let sz = vint(p); p += sz.len + sz.v;
    id = vint(p, true); if (id.v !== 0x18538067) throw new Error('no segment');
    p += id.len; p += vint(p).len;
    while (p < headLen - 12) {
      id = vint(p, true); const szp = p + id.len; sz = vint(szp); const cs = szp + sz.len;
      if (id.v === 0x114D9B74) throw new Error('seek head');
      if (id.v === 0x1F43B675) break;
      if (id.v === 0x1549A966) {
        const infoEnd = cs + sz.v; if (infoEnd > headLen) throw new Error('info too long');
        let scale = 1e6, durAt = -1, durLen = 0;
        for (let q = cs; q < infoEnd;) { const cid = vint(q, true), csz = vint(q + cid.len), dp = q + cid.len + csz.len; if (cid.v === 0x2AD7B1) { let s2 = 0; for (let i = 0; i < csz.v; i++) s2 = s2 * 256 + b[dp + i]; scale = s2 || 1e6; } if (cid.v === 0x4489) { durAt = dp; durLen = csz.v; } q = dp + csz.v; }
        const val = ms * 1e6 / scale;
        if (durAt >= 0) { const dv = new DataView(b.buffer); if (durLen === 8) dv.setFloat64(durAt, val); else if (durLen === 4) dv.setFloat32(durAt, val); else throw new Error('odd'); return new Blob([b, blob.slice(headLen)], { type: blob.type }); }
        const newSize = sz.v + 11; if (newSize >= Math.pow(2, 7 * sz.len) - 1) throw new Error('size');
        const sb = new Uint8Array(sz.len); let v = newSize; for (let i = sz.len - 1; i >= 0; i--) { sb[i] = v % 256; v = Math.floor(v / 256); } sb[0] |= 0x80 >> (sz.len - 1);
        const du = new Uint8Array(11); du[0] = 0x44; du[1] = 0x89; du[2] = 0x88; new DataView(du.buffer).setFloat64(3, val);
        return new Blob([b.subarray(0, szp), sb, b.subarray(cs, infoEnd), du, b.subarray(infoEnd), blob.slice(headLen)], { type: blob.type });
      }
      p = cs + sz.v;
    }
  } catch { /* keep the recording as it is */ }
  return blob;
}

// ---------------------------------------------------------------- stock photos (design-api.linearit.co)
// Photo search goes through our own Worker, which holds the Pexels key.
// Everything else in the app works without it.
const API = 'https://design-api.linearit.co';
let health = null;
function apiHealth() {
  if (!health) health = fetch(API + '/health', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ ok: false, photos: false, offline: navigator.onLine === false }));
  // (Unreachable while online means the Worker isn't deployed yet: shown as "not switched on".)
  return health;
}
async function api(path, o) {
  let r;
  try { r = await fetch(API + path, o); }
  catch { throw new Error(navigator.onLine === false ? 'You’re offline — this feature needs the internet.' : 'Couldn’t reach the Linear Design service. Try again in a moment.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong — try again.');
  return d;
}
function notSetUp(what) {
  return h('div', { class: 'note', style: 'background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px;color:var(--muted)' },
    h('b', { style: 'color:var(--text);display:block;margin-bottom:4px' }, `${what} isn’t switched on yet`),
    'The site owner needs to finish a one-time setup (see design-worker/README.md in the website’s code). Everything else in Linear Design works without it.');
}

// ---- stock photos (Pexels)
const photoState = { q: '', orient: '', page: 0, more: true, items: [], loading: false };
function tabPhotos(body) {
  const q = h('input', { class: 'search', type: 'search', placeholder: 'Search free stock photos', value: photoState.q, 'aria-label': 'Search photos' });
  const chips = h('div', { class: 'chips' }, [['', 'Any shape'], ['landscape', 'Wide'], ['portrait', 'Tall'], ['square', 'Square']].map(([k, n]) => h('button', { type: 'button', class: photoState.orient === k ? 'on' : '', onclick: () => { photoState.orient = k; resetPhotos(); showTab('photos'); } }, n)));
  const status = h('div', { class: 'count' });
  const grid = h('div', { class: 'pgrid' }), sent = h('div', { class: 'sentinel' });
  const credit = h('p', { class: 'note', style: 'margin-top:4px' }, 'Photos provided by ', h('a', { href: 'https://www.pexels.com', target: '_blank', rel: 'noopener', style: 'color:var(--accent)' }, 'Pexels'), ' — free to use. Searches are sent to Pexels; your own uploads never are.');
  body.append(q, chips, status, grid, sent, credit);
  let t = 0;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { photoState.q = q.value.trim(); resetPhotos(); fill(true); }, 450); });
  const card = p => {
    const b = h('button', { type: 'button', title: `Photo by ${p.by} on Pexels`, style: `background:${p.color};aspect-ratio:${p.w}/${p.h}`, onclick: () => usePhoto(p, b) },
      h('img', { src: p.thumb, alt: p.alt || 'Stock photo', loading: 'lazy', width: 350, height: Math.round(350 * p.h / p.w) }), h('span', null, p.by));
    return b;
  };
  const fill = async (fresh) => {
    if (fresh) grid.textContent = '';
    const hs = await apiHealth();
    if (!hs.photos) { grid.replaceWith(hs.offline ? h('p', { class: 'note' }, 'Stock photos need an internet connection.') : notSetUp('Stock photo search')); sent.remove(); return; }
    photoState.items.forEach(p => grid.append(card(p)));
    status.textContent = photoState.q ? `Results for “${photoState.q}”` : 'Popular right now';
    more();
  };
  const more = async () => {
    if (photoState.loading || !photoState.more || !body.isConnected) return;
    if (!(await apiHealth()).photos) return;
    photoState.loading = true;
    try {
      const d = await api(`/photos/search?q=${encodeURIComponent(photoState.q)}&page=${photoState.page + 1}${photoState.orient ? '&orientation=' + photoState.orient : ''}`);
      photoState.page++; photoState.more = d.more && photoState.page < 20;
      d.photos.forEach(p => { photoState.items.push(p); grid.append(card(p)); });
      if (!photoState.items.length) status.textContent = 'No photos found — try another word.';
    } catch (err) { status.textContent = err.message; photoState.more = false; }
    photoState.loading = false;
  };
  const io = new IntersectionObserver(e => { if (e.some(x => x.isIntersecting)) more(); }, { root: body, rootMargin: '600px' });
  io.observe(sent);
  fill(false);
}
function resetPhotos() { Object.assign(photoState, { page: 0, more: true, items: [], loading: false }); }
async function usePhoto(p, btn) {
  if (btn) btn.style.opacity = .5;
  try {
    const r = await fetch(`${API}/photos/image?u=${encodeURIComponent(p.large)}`);
    if (!r.ok) throw new Error('Couldn’t download that photo.');
    const blob = await r.blob();
    const src = await readImageFile(new File([blob], 'pexels.jpg', { type: blob.type || 'image/jpeg' }));
    const id = addImage(src); uploads.unshift(id);
    await new Promise(res => { const im = images.get(id).img; im.complete ? res() : im.addEventListener('load', res, { once: true }); });
    const target = selEls().find(e => e.type === 'image' && !e.src && !e.locked) || (sel.length === 1 && selEls()[0].type === 'image' && !selEls()[0].locked ? selEls()[0] : null);
    if (target) { target.src = id; target.credit = { by: p.by, url: p.url }; }
    else { addPhotoEl(id); selEls()[0].credit = { by: p.by, url: p.url }; }
    commit();
    toast(`Photo by ${p.by} on Pexels`);
  } catch (err) { toast(err.message || 'Couldn’t add that photo.', true); }
  if (btn) btn.style.opacity = '';
}

// ---------------------------------------------------------------- mockups
let mockMod = null;
function loadMockups() {
  if (window.LDMock) return Promise.resolve(window.LDMock);
  if (!mockMod) mockMod = new Promise((res, rej) => { const s = h('script', { src: '/design/mockups.js' }); s.onload = () => res(window.LDMock); s.onerror = () => { mockMod = null; rej(new Error('Couldn’t load mockups.')); }; document.head.append(s); });
  return mockMod;
}
async function mockupDialog() {
  if (!doc) return;
  if (editingId) stopEdit();
  const M = await loadMockups();
  await imagesReady();
  const art = pageCanvas(page(), Math.min(2, 1400 / Math.max(doc.w, doc.h)), false);
  const o = { bg: '#e9edf3', item: '#ffffff', frame: '#1c1c1c' };
  let kind = doc.h > doc.w * 1.4 ? 'phone' : doc.w > doc.h * 1.2 ? 'laptop' : 'poster';
  const big = document.createElement('canvas'); big.style.cssText = 'width:100%;height:auto;border-radius:10px;display:block';
  const thumbs = h('div', { class: 'egrid three' });
  const paint = () => { const c = M.render(kind, art, o); big.width = c.width; big.height = c.height; big.getContext('2d').drawImage(c, 0, 0); };
  const drawThumbs = () => {
    thumbs.textContent = '';
    for (const [k, n] of M.KINDS) {
      const c = M.render(k, art, o), t = document.createElement('canvas'); t.width = 240; t.height = 180; t.getContext('2d').drawImage(c, 0, 0, 240, 180);
      t.style.cssText = 'width:100%;height:auto;border-radius:6px';
      thumbs.append(h('button', { class: 'eb', type: 'button', title: n, style: 'aspect-ratio:auto;padding:4px;display:grid;gap:4px;font-size:11px;color:var(--muted)' + (k === kind ? ';border-color:var(--accent)' : ''), onclick: () => { kind = k; paint(); drawThumbs(); } }, t, n));
    }
  };
  const colorRow = (label, key, list) => h('div', { class: 'prow' }, h('span', null, label), h('div', { class: 'btnrow' }, list.map(c => h('button', { class: 'sw', type: 'button', title: c, style: `background:${c};width:26px`, onclick: () => { o[key] = c; paint(); drawThumbs(); } })),
    h('input', { type: 'color', value: o[key], style: 'width:32px;height:26px;border:0;background:none', oninput: e => { o[key] = e.target.value; paint(); }, onchange: drawThumbs })));
  paint(); drawThumbs();
  const saveBlob = () => new Promise(r => big.toBlob(r, 'image/png'));
  const body = h('div', { class: 'bgwrap', style: 'grid-template-columns:1fr 300px' },
    h('div', null, big),
    h('div', { style: 'display:grid;gap:10px;align-content:start' }, thumbs,
      colorRow('Backdrop', 'bg', ['#e9edf3', '#f5efe6', '#1f2430', '#d8efe6', '#fde2e4']),
      colorRow('Shirt / mug', 'item', ['#ffffff', '#111111', '#1e3a8a', '#b91c1c', '#6b7280']),
      colorRow('Frame', 'frame', ['#1c1c1c', '#ffffff', '#8b5e3c', '#c9a227']),
      h('button', { class: 'pb wide', type: 'button', onclick: async () => { const b = await saveBlob(); download(b, `${safeName()}-${kind}-mockup.png`); } }, 'Download PNG')));
  dialog('Mockups', body, 'Add to design as a new page', async () => {
    const b = await saveBlob();
    const id = addImage(await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }));
    await new Promise(r => { const im = images.get(id).img; im.complete ? r() : im.addEventListener('load', r, { once: true }); });
    const pg = blankPage(); pg.bg = { fill: o.bg };
    const k = Math.max(doc.w / M.OUT_W, doc.h / M.OUT_H);
    pg.els.push({ id: nid(), type: 'image', src: id, x: (doc.w - M.OUT_W * k) / 2, y: (doc.h - M.OUT_H * k) / 2, w: M.OUT_W * k, h: M.OUT_H * k, rot: 0, opacity: 1, mask: 'none', zoom: 1, px: 0, py: 0 });
    doc.pages.splice(doc.cur + 1, 0, pg); doc.cur++; sel = []; commit({ keepClean: true });
    toast('Mockup added as a new page.');
  });
  const d = document.querySelector('.scrim:last-child .dlg'); if (d) d.classList.add('wide');
}

// ---------------------------------------------------------------- keyboard shortcuts sheet
function shortcutsDialog() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform), M = mac ? '⌘' : 'Ctrl';
  const rows = [
    ['Undo / redo', `${M}+Z / ${M}+Shift+Z`], ['Copy, cut, paste', `${M}+C / X / V`], ['Duplicate', `${M}+D`], ['Delete', 'Delete or Backspace'],
    ['Select all', `${M}+A`], ['Group / ungroup', `${M}+G / ${M}+Shift+G`], ['Copy / paste style', `${M}+Alt+C / ${M}+Alt+V`],
    ['Bring forward / send backward', `${M}+] / ${M}+[`], ['To front / to back', `${M}+Shift+] / [`], ['Nudge', 'Arrow keys (Shift = 10 px)'],
    ['Edit selected text', 'Enter or double-click'], ['Add text / rectangle / circle / line', 'T / R / C / L'],
    ['Zoom in / out / fit', `${M}+ + / ${M}+ − / ${M}+0`], ['Pan', 'Space + drag, or scroll'], ['Keep proportions / snap rotation', 'Shift while dragging'],
    ['Move without snapping', 'Alt while dragging'], ['Play animations', 'P (any key stops)'], ['Save design file', `${M}+S`], ['This list', '?'],
  ];
  dialog('Keyboard shortcuts', h('div', { style: 'display:grid;grid-template-columns:1fr auto;gap:8px 16px' }, rows.flatMap(([a, b]) => [h('span', { style: 'color:var(--muted)' }, a), h('kbd', { style: 'font:inherit;font-size:12px;background:var(--well);border:1px solid var(--line);border-radius:5px;padding:2px 7px;white-space:nowrap' }, b)])), 'Close');
}

// ---------------------------------------------------------------- dialogs
function dialog(title, body, okLabel, onOk) {
  return new Promise(resolve => {
    const close = v => { sc.remove(); resolve(v); };
    const sc = h('div', { class: 'scrim', onpointerdown: e => { if (e.target === sc) close(false); } },
      h('div', { class: 'dlg', role: 'dialog', 'aria-label': title }, h('h2', null, title), h('div', { class: 'body' }, body),
        h('div', { class: 'foot' }, h('button', { type: 'button', onclick: () => close(false) }, 'Cancel'), h('button', { type: 'button', class: 'ok', onclick: async () => { if (onOk && (await onOk()) === false) return; close(true); } }, okLabel))));
    sc.addEventListener('keydown', e => { if (e.key === 'Escape') close(false); e.stopPropagation(); });
    document.body.append(sc);
    const f = sc.querySelector('input,select,button.ok'); if (f) f.focus();
  });
}
function sizeInputs(w, hh) {
  const W = h('input', { type: 'number', value: w, min: 16, max: 8000, style: 'width:90px' });
  const H = h('input', { type: 'number', value: hh, min: 16, max: 8000, style: 'width:90px' });
  const U = h('select', null, h('option', { value: 'px' }, 'px'), h('option', { value: 'in' }, 'inches'), h('option', { value: 'mm' }, 'mm'));
  U.addEventListener('change', () => {
    if (U.value === 'in') { W.step = H.step = .25; W.value = 8.5; H.value = 11; } else if (U.value === 'mm') { W.step = H.step = 1; W.value = 210; H.value = 297; } else { W.step = H.step = 1; W.value = 1080; H.value = 1080; }
  });
  const read = () => {
    const u = U.value, k = u === 'in' ? 150 : u === 'mm' ? 150 / 25.4 : 1;
    const w2 = Math.round(+W.value * k), h2 = Math.round(+H.value * k);
    if (!(w2 >= 16 && h2 >= 16 && w2 <= 8000 && h2 <= 8000)) { toast('Pick a size between 16 and 8000 pixels on each side.', true); return null; }
    if (w2 * h2 > MAX_PIXELS) { toast('That’s too many pixels for a browser to hold — try a smaller size.', true); return null; }
    return { w: w2, h: h2, dpi: u === 'px' ? 96 : 150 };
  };
  return { el: h('div', { class: 'prow' }, W, h('span', { style: 'width:auto' }, '×'), H, U), read };
}
async function customSizeDialog() {
  const si = sizeInputs(1080, 1080);
  let out = null;
  const ok = await dialog('Custom size', [si.el, h('p', { class: 'hint' }, 'Print sizes in inches or mm are set up at 150 dots per inch.')], 'Create design', () => { out = si.read(); return !!out; });
  if (ok && out) newDoc(out.w, out.h, { dpi: out.dpi });
}
function resizeDialog() {
  if (!doc) return;
  let choice = doc.fmt || null;
  const si = sizeInputs(doc.w, doc.h);
  const list = h('div', { class: 'fmtlist' }, TP.FORMATS.map(f => h('button', { type: 'button', class: f.id === choice ? 'on' : '', onclick: e => { choice = f.id; list.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, f.n, h('small', null, `${f.w} × ${f.h}`))));
  const custom = h('label', { class: 'opt' }, h('input', { type: 'checkbox', onchange: e => { list.style.opacity = e.target.checked ? .4 : 1; } }), h('span', null, 'Custom size', h('small', null, 'Use the size below instead')));
  dialog('Resize design', [list, custom, si.el, h('p', { class: 'hint' }, 'Pages made from a template are laid out again for the new size. Anything you’ve changed is scaled to fit — check it over afterwards. Ctrl+Z undoes it.')], 'Resize', () => {
    let w, hh, dpi, fmt = null;
    if (custom.querySelector('input').checked) { const r = si.read(); if (!r) return false; ({ w, h: hh, dpi } = r); }
    else { const f = fmtById(choice); if (!f) { toast('Pick a size first.'); return false; } w = f.w; hh = f.h; dpi = DPI[f.id] || 96; fmt = f.id; }
    resizeDesign(w, hh, dpi, fmt);
  });
}
function resizeDesign(W2, H2, dpi, fmt) {
  const W = doc.w, H = doc.h, kx = W2 / W, ky = H2 / H, k = Math.min(kx, ky);
  for (const p of doc.pages) {
    if (p.tpl && p.clean) { const pg = TP.build(p.tpl, W2, H2); p.bg = pg.bg; p.els = pg.els; continue; }
    for (const el of p.els) {
      const o = clone(el);
      const cx = (el.x + el.w / 2) * kx, cy = (el.y + el.h / 2) * ky;
      scaleEl(el, o, k);
      if (el.type !== 'text' && el.type !== 'icon') { if (o.w >= W * .8) el.w = o.w * kx; if (o.h >= H * .8) el.h = o.h * ky; }
      el.x = cx - el.w / 2; el.y = cy - el.h / 2;
    }
  }
  doc.w = W2; doc.h = H2; doc.dpi = dpi; doc.fmt = fmt;
  sel = []; commit({ keepClean: true }); fitIfNeeded();
  toast(`Resized to ${W2} × ${H2}.`);
}

// ---------------------------------------------------------------- export
const safeName = () => (doc.name || 'design').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'design';
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
function docFonts() {
  const out = [];
  for (const pg of doc.pages) for (const el of pg.els) {
    if (el.type === 'text') out.push(C.loadFont(el.font, el.weight, el.italic));
    if (el.type === 'table') out.push(C.loadFont(el.font, el.weight || 400), C.loadFont(el.font, el.hweight || 700));
    if (el.type === 'chart') out.push(C.loadFont(el.font || 'Sans', 400), C.loadFont(el.font || 'Sans', 700));
  }
  return Promise.all(out);
}
async function imagesReady() {
  await docFonts(); await Promise.all([...images.values()].map(r => r.img.decode ? r.img.decode().catch(() => {}) : null)); }
function pageCanvas(pg, k, transparent) {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(doc.w * k)); c.height = Math.max(1, Math.round(doc.h * k));
  const x = c.getContext('2d'); x.scale(k, k);
  if (!transparent) { x.fillStyle = '#ffffff'; x.fillRect(0, 0, doc.w, doc.h); }
  C.renderPage(x, pg, doc.w, doc.h, { scale: k, images: getImg, transparent });
  return c;
}
// Print version of a page: 0.125 in bleed on every side plus a margin for crop
// marks. Shapes and photos that touch the page edge are stretched into the
// bleed so nothing white shows if the cut drifts.
function printGeom(k) {
  const dpi = doc.dpi || 96, b = .125 * dpi, m = .25 * dpi;
  const W = doc.w + 2 * (b + m), H = doc.h + 2 * (b + m);
  if (W * k * H * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (W * H));
  return { dpi, b, m, W, H, k };
}
function printCanvas(pg, k0) {
  const { b, m, W, H, k, dpi } = printGeom(k0);
  const c = document.createElement('canvas'); c.width = Math.round(W * k); c.height = Math.round(H * k);
  const x = c.getContext('2d'); x.scale(k, k);
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  x.save(); x.translate(m, m); x.beginPath(); x.rect(0, 0, doc.w + 2 * b, doc.h + 2 * b); x.clip();
  C.drawBackground(x, pg.bg, doc.w + 2 * b, doc.h + 2 * b, { images: getImg, scale: k });
  x.translate(b, b);
  const env = { scale: k, images: getImg };
  for (const el of pg.els) {
    let e = el;
    if (!el.rot && (el.type === 'shape' || el.type === 'image') && !C.isLine(el)) {
      e = Object.assign({}, el);
      if (el.x <= .5) { e.x -= b; e.w += b; }
      if (el.x + el.w >= doc.w - .5) e.w += b;
      if (el.y <= .5) { e.y -= b; e.h += b; }
      if (el.y + el.h >= doc.h - .5) e.h += b;
    }
    C.drawElement(x, e, env);
  }
  x.restore();
  // crop marks at the trim corners, kept out of the bleed
  x.strokeStyle = '#000000'; x.lineWidth = .25 / 72 * dpi;
  const t0 = m + b, tx = [t0, t0 + doc.w], ty = [t0, t0 + doc.h], a = m * .1, z = m * .9;
  x.beginPath();
  for (const X of tx) { x.moveTo(X, a); x.lineTo(X, z); x.moveTo(X, H - a); x.lineTo(X, H - z); }
  for (const Y of ty) { x.moveTo(a, Y); x.lineTo(z, Y); x.moveTo(W - a, Y); x.lineTo(W - z, Y); }
  x.stroke();
  return c;
}
let pdfLib = null;
function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (pdfLib) return pdfLib;
  return pdfLib = new Promise((res, rej) => { const s = h('script', { src: '/pdf/vendor/pdf-lib.min.js' }); s.onload = () => res(window.PDFLib); s.onerror = () => { pdfLib = null; rej(new Error('pdf-lib')); }; document.head.append(s); });
}
function exportDialog() {
  if (!doc) return;
  if (editingId) stopEdit();
  let type = 'png';
  const anim = doc.pages.some(hasAnim);
  const opts = [['png', 'PNG', 'Sharpest. Best for social media and anything with text.'], ['jpg', 'JPG', 'Smaller file. Best for photos.'], ['pdf', 'PDF', 'Best for printing and multi-page designs.'], ['mp4', 'MP4 video', anim ? 'Plays your animations — for Reels, TikTok, Stories, YouTube.' : 'A video of your pages. Add animations to make them move.'], ['gif', 'GIF', 'A short looping animation for emails, websites and chats.']];
  if (anim) type = 'mp4';
  const radios = h('div', { style: 'display:grid;gap:8px' }, opts.map(([k, n, d]) => h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'ft', value: k, checked: k === type, onchange: () => { type = k; upd(); } }), h('span', null, h('b', null, n), h('small', null, d)))));
  const scale = h('select', null, [.5, 1, 2, 3, 4].map(v => h('option', { value: v, selected: v === (doc.w < 1300 ? 2 : 1) }, v + '×')));
  const sizeOut = h('span', { class: 'hint' });
  const vres = h('select', null, [[720, 'Small (720p)'], [1080, 'HD (1080p)'], [1920, 'Full HD (long side 1920)']].map(([v, n]) => h('option', { value: v, selected: v === 1920 }, n)));
  const gres = h('select', null, [[480, 'Small (480 px)'], [720, 'Medium (720 px)'], [1080, 'Large (1080 px)']].map(([v, n]) => h('option', { value: v, selected: v === 720 }, n)));
  const vrow = prow('Size', vres), grow2 = prow('Size', gres), srow = prow('Size', scale, sizeOut);
  const which = h('select', null, h('option', { value: 'cur' }, `Current page (${doc.cur + 1})`), doc.pages.length > 1 ? h('option', { value: 'all', selected: true }, `All ${doc.pages.length} pages`) : null);
  const transp = h('label', { style: 'display:flex;gap:8px;align-items:center' }, h('input', { type: 'checkbox' }), 'Transparent background');
  const bleed = h('label', { style: 'display:flex;gap:8px;align-items:flex-start' }, h('input', { type: 'checkbox', style: 'margin-top:3px' }), h('span', null, 'Print-ready: add bleed and crop marks', h('small', { style: 'display:block;color:var(--faint)' }, 'Adds 0.125 in past each edge — what most print shops ask for.')));
  const upd = () => {
    let k = +scale.value; if (doc.w * k * doc.h * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (doc.w * doc.h));
    sizeOut.textContent = `${Math.round(doc.w * k)} × ${Math.round(doc.h * k)} px`;
    transp.hidden = type !== 'png';
    bleed.hidden = type !== 'pdf';
    vrow.hidden = type !== 'mp4'; grow2.hidden = type !== 'gif'; srow.hidden = type === 'mp4' || type === 'gif';
  };
  scale.addEventListener('change', upd); upd();
  const mockLink = h('button', { class: 'pb wide', type: 'button', onclick: () => { document.querySelector('.scrim:last-child').remove(); mockupDialog(); } }, 'See it as a mockup (phone, T-shirt, mug…)');
  dialog('Download', [radios, srow, vrow, grow2, prow('Pages', which), transp, bleed, mockLink], 'Download', async () => {
    if (type === 'mp4' || type === 'gif') { const pages = which.value === 'all' ? doc.pages : [page()]; setTimeout(() => exportMotion(type, pages, +(type === 'gif' ? gres : vres).value), 0); return; }
    let k = +scale.value; if (doc.w * k * doc.h * k > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (doc.w * doc.h));
    const pages = which.value === 'all' ? doc.pages : [page()];
    const tr = type === 'png' && transp.querySelector('input').checked;
    toast('Preparing your download…');
    await imagesReady();
    try {
      if (type === 'pdf') {
        const PL = await loadPdfLib();
        const pdf = await PL.PDFDocument.create();
        pdf.setTitle(doc.name || 'Design'); pdf.setCreator('Linear Design');
        const print = bleed.querySelector('input').checked, pt = 72 / (doc.dpi || 96);
        const G = printGeom(+scale.value);
        const pw = (print ? G.W : doc.w) * pt, ph = (print ? G.H : doc.h) * pt;
        for (const pg of pages) {
          const c = print ? printCanvas(pg, +scale.value) : pageCanvas(pg, k, false);
          const bytes = new Uint8Array(await (await toBlob(c, 'image/jpeg', .95)).arrayBuffer());
          const im = await pdf.embedJpg(bytes);
          const pp = pdf.addPage([pw, ph]);
          pp.drawImage(im, { x: 0, y: 0, width: pw, height: ph });
          if (print && pp.setTrimBox) {
            pp.setBleedBox(G.m * pt, G.m * pt, (doc.w + 2 * G.b) * pt, (doc.h + 2 * G.b) * pt);
            pp.setTrimBox((G.m + G.b) * pt, (G.m + G.b) * pt, doc.w * pt, doc.h * pt);
          }
        }
        download(new Blob([await pdf.save()], { type: 'application/pdf' }), safeName() + '.pdf');
      } else {
        const mime = type === 'png' ? 'image/png' : 'image/jpeg';
        for (let i = 0; i < pages.length; i++) {
          const c = pageCanvas(pages[i], k, tr);
          const b = await toBlob(c, mime, .93);
          download(b, safeName() + (pages.length > 1 ? `-${doc.pages.indexOf(pages[i]) + 1}` : '') + '.' + type);
          if (pages.length > 1) await new Promise(r => setTimeout(r, 350));
        }
      }
      toast('Downloaded.');
    } catch (err) { console.error(err); toast('The download failed: ' + (err.message || err), true); }
  });
}

// ---------------------------------------------------------------- present
function present() {
  if (!doc) return;
  if (editingId) stopEdit();
  let i = doc.cur;
  const c = document.createElement('canvas');
  const n = h('div', { class: 'pn' });
  const ov = h('div', { class: 'present', tabindex: '0' }, c, n);
  let t0 = performance.now(), raf = 0;
  const frame = () => {
    const pg = doc.pages[i], d = Math.min(2, window.devicePixelRatio || 1), k = Math.min(window.innerWidth / doc.w, window.innerHeight / doc.h);
    const W = Math.round(doc.w * k * d), H = Math.round(doc.h * k * d);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; c.style.width = W / d + 'px'; c.style.height = H / d + 'px'; }
    const x = c.getContext('2d'); x.setTransform(k * d, 0, 0, k * d, 0, 0); x.fillStyle = '#ffffff'; x.fillRect(0, 0, doc.w, doc.h);
    const t = (performance.now() - t0) / 1000, anim = hasAnim(pg);
    C.renderPage(x, pg, doc.w, doc.h, anim ? { scale: k * d, images: getImg, t, dur: 1e9 } : { scale: k * d, images: getImg });
    raf = anim && ov.isConnected ? requestAnimationFrame(frame) : 0;
  };
  const draw = () => { cancelAnimationFrame(raf); t0 = performance.now(); frame(); n.textContent = `${i + 1} / ${doc.pages.length} · Esc to exit`; };
  const go = d => { i = clamp(i + d, 0, doc.pages.length - 1); draw(); };
  const exit = () => { cancelAnimationFrame(raf); window.removeEventListener('resize', draw); ov.remove(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  ov.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') exit(); else if (['ArrowRight', 'ArrowDown', ' ', 'PageDown'].includes(e.key)) go(1); else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) go(-1); });
  ov.addEventListener('click', e => { if (e.clientX < window.innerWidth / 3) go(-1); else go(1); });
  document.addEventListener('fullscreenchange', function f() { if (!document.fullscreenElement) { document.removeEventListener('fullscreenchange', f); if (ov.isConnected) exit(); } });
  window.addEventListener('resize', draw);
  document.body.append(ov); ov.focus(); draw();
  if (ov.requestFullscreen) ov.requestFullscreen().catch(() => {});
}

// ---------------------------------------------------------------- save / open / autosave
function projectData() {
  const used = new Set(uploads);
  for (const p of doc.pages) { if (p.bg.image) used.add(p.bg.image); for (const el of p.els) if (el.src) used.add(el.src); }
  const imgs = {}; for (const id of used) { const r = images.get(id); if (r) imgs[id] = r.src; }
  return { app: 'linear-design', v: 1, name: doc.name, w: doc.w, h: doc.h, dpi: doc.dpi, fmt: doc.fmt, pages: doc.pages, cur: doc.cur, images: imgs, uploads: uploads.filter(id => imgs[id]), fonts: Object.fromEntries(fontsData), saved: Date.now() };
}
function saveProject() {
  if (!doc) return;
  if (editingId) stopEdit();
  download(new Blob([JSON.stringify(projectData())], { type: 'application/json' }), safeName() + '.ldesign');
  toast('Saved. Open the .ldesign file here any time to keep editing.');
}
async function loadProject(d) {
  if (!d || d.app !== 'linear-design' || !Array.isArray(d.pages) || !d.pages.length) throw new Error('not a Linear Design file');
  for (const [id, src] of Object.entries(d.images || {})) if (!images.has(id)) addImage(src, id);
  for (const id of (d.uploads || []).slice().reverse()) if (!uploads.includes(id)) uploads.unshift(id);
  for (const [name, src] of Object.entries(d.fonts || {})) { try { await registerFont(name, await (await fetch(src)).arrayBuffer(), src); } catch { /* font skipped */ } }
  doc = { name: d.name || 'Untitled design', w: d.w, h: d.h, dpi: d.dpi || 96, fmt: d.fmt || null, pages: d.pages, cur: clamp(d.cur || 0, 0, d.pages.length - 1) };
  for (const p of doc.pages) for (const el of p.els) if (el.type === 'text') C.syncText(el);
  $('docName').value = doc.name;
  sel = []; hist = []; hIdx = -1;
  $('home').hidden = true;
  lastSize = ''; resizeCanvas(); fitIfNeeded();
  commit({ keepClean: true });
  if (!tab || $('drawer').classList.contains('closed')) showTab('templates'); else showTab(tab);
}
function openProjectFile(f) {
  const r = new FileReader();
  r.onload = async () => { try { await loadProject(JSON.parse(r.result)); toast('Opened ' + f.name); } catch (err) { toast('That file isn’t a Linear Design file.', true); } };
  r.readAsText(f);
}
const IDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      try {
        const q = indexedDB.open('linear-design', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('kv');
        q.onsuccess = () => { this.db = q.result; res(this.db); };
        q.onerror = () => rej(q.error);
      } catch (err) { rej(err); }
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async put(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
};
let saveT = 0;
function saveSoon() { clearTimeout(saveT); saveT = setTimeout(async () => { if (!doc) return; try { await IDB.put('autosave', projectData()); autosaveOK = true; } catch { autosaveOK = false; } }, 1200); }
window.addEventListener('beforeunload', e => { if (doc && !autosaveOK && hist.length > 1) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- fonts
async function registerFont(name, buf, dataUrl) {
  const fam = 'ldf-' + name.replace(/[^a-z0-9]+/gi, '-');
  const ff = new FontFace(fam, buf);
  await ff.load(); document.fonts.add(ff);
  C.custom.set(name, fam);
  if (dataUrl) fontsData.set(name, dataUrl);
}
function loadFontFile(f) {
  const r = new FileReader();
  r.onload = async () => {
    const name = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
    try {
      await registerFont(name, await (await fetch(r.result)).arrayBuffer(), r.result);
      toast(`Font “${name}” added.`);
      const target = fontTarget; fontTarget = null;
      if (target) { target(name); commit(); }
      else if (sel.length === 1 && selEls()[0].type === 'text') { const el = selEls()[0]; el.font = name; C.syncText(el); commit(); }
      else buildProps();
      if (tab === 'text' || tab === 'brand') showTab(tab);
    } catch { toast('That font file couldn’t be read.', true); }
  };
  r.readAsDataURL(f);
}

// ---------------------------------------------------------------- home screen
const homeState = { fmt: 'ig-post', cat: '', q: '' };
let fontsReadyFlag = false;
let stopHomeGrid = null;
function goHome() {
  if (editingId) stopEdit();
  $('home').hidden = false;
  buildHome();
}
function buildHome() {
  const tiles = $('hFormats'); tiles.textContent = '';
  const pick = ['ig-post', 'ig-story', 'flyer', 'poster', 'present', 'yt-thumb', 'fb-post', 'invite', 'bcard', 'logo', 'li-banner', 'pin', 'cert', 'postcard'];
  for (const id of pick) {
    const f = fmtById(id), k = 44 / Math.max(f.w, f.h);
    tiles.append(h('button', { class: 'ftile', type: 'button', onclick: () => newDoc(f.w, f.h, { fmt: f.id, name: 'Untitled ' + f.n }) }, h('i', { style: `width:${Math.max(8, f.w * k)}px;height:${Math.max(8, f.h * k)}px` }), h('b', null, f.n), h('small', null, `${f.w} × ${f.h}`)));
  }
  const fc = $('hFmtChips'); fc.textContent = '';
  for (const f of TP.FORMATS) fc.append(h('button', { type: 'button', class: f.id === homeState.fmt ? 'on' : '', onclick: () => { homeState.fmt = f.id; buildHome(); } }, f.n));
  const cc = $('hCatChips'); cc.textContent = '';
  for (const c of ['', ...TP.CATEGORIES]) cc.append(h('button', { type: 'button', class: c === homeState.cat ? 'on' : '', onclick: () => { homeState.cat = c; buildHome(); } }, c || 'All categories'));
  fillHomeGrid();
}
function fillHomeGrid() {
  if (!fontsReadyFlag) { templateFonts.then(() => { fontsReadyFlag = true; fillHomeGrid(); }); return; }
  const f = fmtById(homeState.fmt);
  const list = TP.search(homeState.q, homeState.cat);
  $('hTplTitle').textContent = `${f.n} templates`;
  $('hTplCount').textContent = `${list.length.toLocaleString()} designs${homeState.q ? ` matching “${homeState.q}”` : ''} · every one also comes in the other ${TP.FORMATS.length - 1} sizes`;
  if (stopHomeGrid) stopHomeGrid();
  const grid = $('hGrid'); grid.textContent = '';
  if (!list.length) grid.append(h('p', { class: 'note' }, 'Nothing matches that. Try a simpler word, like “sale”, “party” or “menu”.'));
  const tw = window.innerWidth < 640 ? 170 : 200;
  stopHomeGrid = lazyGrid(grid, $('hSentinel'), $('home'), list, f.w, f.h, tw, d => {
    newDoc(f.w, f.h, { fmt: f.id, name: TP.TOPICS[d.t].n });
    applyTemplate(d);
  });
}
let hq = 0;
$('hSearch').addEventListener('input', e => { clearTimeout(hq); hq = setTimeout(() => { homeState.q = e.target.value.trim(); fillHomeGrid(); }, 250); });
$('hCustom').addEventListener('click', customSizeDialog);
$('hOpen').addEventListener('click', () => $('fileProject').click());
$('hCount').textContent = TP.COUNT.toLocaleString();
async function showContinue() {
  try {
    const d = await IDB.get('autosave');
    if (!d || !d.pages) return;
    const b = $('hContinue'); b.hidden = false;
    $('hContName').textContent = `Continue “${d.name || 'Untitled design'}” — ${d.pages.length} page${d.pages.length > 1 ? 's' : ''}`;
    const c = $('hContCv'), k = Math.min(140 / d.w, 80 / d.h);
    c.width = Math.round(d.w * k * 2); c.height = Math.round(d.h * k * 2); c.style.width = c.width / 2 + 'px'; c.style.height = c.height / 2 + 'px';
    for (const [id, src] of Object.entries(d.images || {})) if (!images.has(id)) addImage(src, id);
    setTimeout(() => { const x = c.getContext('2d'); x.setTransform(k * 2, 0, 0, k * 2, 0, 0); C.renderPage(x, d.pages[d.cur || 0] || d.pages[0], d.w, d.h, { scale: k * 2, images: getImg }); }, 300);
    b.onclick = () => loadProject(d).catch(() => toast('That design couldn’t be restored.', true));
  } catch { /* no saved design, or storage blocked */ }
}

// ---------------------------------------------------------------- QR codes, charts, tables
function pageSurface() { const f = page().bg.fill; return page().bg.image ? '#ffffff' : C.fillColor(f); }
function addQR(text, data, at) {
  const sz = S() * .3;
  const el = Object.assign({ id: nid(), type: 'qr', text, ecc: 'M', fg: '#000000', bg: '#ffffff', style: 'square', eye: 'square', quiet: 2, radius: 0, x: 0, y: 0, w: sz, h: sz, rot: 0, opacity: 1 }, data || {});
  place(el, at); page().els.push(el); sel = [el.id]; commit();
  return el;
}
const CHART_SAMPLE = {
  one: { labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], series: [{ name: 'Sales', values: [12, 19, 15, 24, 28, 33] }] },
  two: { labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '2025', values: [18, 24, 21, 30] }, { name: '2026', values: [22, 29, 31, 38] }] },
  pie: { labels: ['Social', 'Search', 'Email', 'Referral'], series: [{ name: 'Visitors', values: [42, 28, 18, 12] }] },
};
function chartDefaults(kind) {
  const d = kind === 'pie' || kind === 'donut' ? CHART_SAMPLE.pie : kind === 'stacked' || kind === 'line' ? CHART_SAMPLE.two : CHART_SAMPLE.one;
  return clone(d);
}
function addChart(kind, at) {
  const s = S(), round = kind === 'pie' || kind === 'donut';
  const el = Object.assign({ id: nid(), type: 'chart', kind, x: 0, y: 0, w: round ? s * .55 : s * .7, h: round ? s * .62 : s * .48, rot: 0, opacity: 1, bg: 'none', surface: pageSurface(), font: brand.body || 'Inter' }, chartDefaults(kind));
  place(el, at); page().els.push(el); sel = [el.id]; commit();
}
const TABLE_STYLES = {
  bold: { hbg: '#1f2937', hcolor: '#ffffff', band: '#f3f4f6', bg: '#ffffff', color: '#111827', line: '#e5e7eb', lines: 'rows', radius: .5 },
  lined: { hbg: 'none', hcolor: '#111827', band: 'none', bg: 'none', color: '#111827', line: '#9ca3af', lines: 'rows', radius: 0, hupper: true },
  grid: { hbg: '#e0f2fe', hcolor: '#0c4a6e', band: 'none', bg: '#ffffff', color: '#0f172a', line: '#94a3b8', lines: 'grid', radius: .3 },
};
function addTable(style, at) {
  const s = S();
  const el = Object.assign({ id: nid(), type: 'table', rows: [['Plan', 'Basic', 'Pro'], ['Help desk', 'Business hours', '24/7'], ['Backups', 'Weekly', 'Daily'], ['Price', '$99/mo', '$199/mo']], font: brand.body || 'Inter', size: Math.round(s * .03), header: true, x: 0, y: 0, w: s * .76, h: 10, rot: 0, opacity: 1 }, clone(TABLE_STYLES[style] || TABLE_STYLES.bold));
  C.syncText(el); place(el, at); page().els.push(el); sel = [el.id]; commit();
}

function qrProps(el) {
  P.append(group('QR code',
    h('button', { class: 'pb wide', type: 'button', style: 'width:100%;margin-bottom:10px', onclick: () => qrDialog(el) }, 'Edit link or content'),
    h('p', { class: 'hint', style: 'margin-bottom:10px;word-break:break-all' }, el.text.length > 90 ? el.text.slice(0, 90) + '…' : el.text),
    prow('Colour', colorBtn(el.fg, v => el.fg = v, { gradient: true })),
    prow('Background', colorBtn(el.bg, v => el.bg = v, { none: true })),
    prow('Corners', colorBtn(el.eyeColor || C.fillColor(el.fg), v => el.eyeColor = v)),
    h('div', { class: 'sec' }, 'Pattern'),
    h('div', { class: 'btnrow', style: 'margin-bottom:8px' }, [['square', 'Squares'], ['rounded', 'Rounded'], ['dots', 'Dots']].map(([k, n]) => pb(n, n, () => { el.style = k; commit(); }, (el.style || 'square') === k, 'wide'))),
    h('div', { class: 'sec' }, 'Corner markers'),
    h('div', { class: 'btnrow', style: 'margin-bottom:8px' }, [['square', 'Square'], ['rounded', 'Rounded'], ['circle', 'Circle']].map(([k, n]) => pb(n, n, () => { el.eye = k; commit(); }, (el.eye || 'square') === k, 'wide'))),
    h('div', { class: 'prow' }, h('span', null, 'Error fix'), h('select', { onchange: e => { el.ecc = e.target.value; commit(); } }, [['L', 'Low (7%)'], ['M', 'Medium (15%)'], ['Q', 'High (25%)'], ['H', 'Highest (30%)']].map(([k, n]) => h('option', { value: k, selected: el.ecc === k }, n)))),
    slider('Margin', el.quiet == null ? 2 : el.quiet, 0, 6, 1, v => el.quiet = v),
    slider('Rounding', Math.round((el.radius || 0) * 100), 0, 20, 1, v => el.radius = v / 100),
    qrWarning(el)));
}
function qrWarning(el) {
  const fg = C.fillColor(el.fg), bg = !el.bg || el.bg === 'none' ? pageSurface() : el.bg;
  const cr = (Math.max(C.lum(fg), C.lum(bg)) + .05) / (Math.min(C.lum(fg), C.lum(bg)) + .05);
  if (cr < 3) return h('p', { class: 'hint', style: 'color:#f59e0b;margin-top:6px' }, 'Low contrast — phones may not be able to scan this. Use a dark code on a light background.');
  if (C.lum(fg) > C.lum(bg)) return h('p', { class: 'hint', style: 'color:#f59e0b;margin-top:6px' }, 'Light-on-dark codes don’t scan on some phones. Dark on light is safest.');
  return h('p', { class: 'hint', style: 'margin-top:6px' }, 'Test it with your phone camera before you print.');
}
function chartProps(el) {
  const kinds = C.CHART_KINDS;
  const round = el.kind === 'pie' || el.kind === 'donut';
  P.append(group('Chart',
    h('button', { class: 'pb wide', type: 'button', style: 'width:100%;margin-bottom:10px', onclick: () => dataDialog(el) }, 'Edit data'),
    h('div', { class: 'prow' }, h('span', null, 'Type'), h('select', { onchange: e => { el.kind = e.target.value; commit(); } }, kinds.map(([k, n]) => h('option', { value: k, selected: el.kind === k }, n)))),
    h('div', { class: 'prow' }, fontSelect(el.font || 'Sans', v => { el.font = v; })),
    slider('Text size', Math.round((el.textScale || 1) * 100), 50, 250, 5, v => el.textScale = v / 100, v => v + '%'),
    prow('Text colour', colorBtn(el.ink || '#1f2328', v => el.ink = v)),
    prow('Background', colorBtn(el.bg || 'none', v => { el.bg = v; }, { none: true })),
    h('div', { class: 'grid4', style: 'margin-top:4px' },
      h('label', null, h('input', { type: 'text', value: el.prefix || '', placeholder: 'Before, e.g. $', style: 'width:100%', onchange: e => { el.prefix = e.target.value.slice(0, 4); commit(); } })),
      h('label', null, h('input', { type: 'text', value: el.suffix || '', placeholder: 'After, e.g. %', style: 'width:100%', onchange: e => { el.suffix = e.target.value.slice(0, 4); commit(); } }))),
    h('div', { class: 'btnrow', style: 'margin-top:8px' },
      pb('Values', 'Show values', () => { el.values = !(el.values != null ? el.values : round || (el.series.length === 1 && el.labels.length <= 12)); commit(); }, el.values != null ? el.values : round || (el.series.length === 1 && el.labels.length <= 12), 'wide'),
      round ? null : pb('Grid', 'Show gridlines', () => { el.grid = el.grid === false; commit(); }, el.grid !== false, 'wide'),
      pb('Legend', 'Show legend', () => { el.legend = el.legend === false; commit(); }, el.legend !== false, 'wide'))));
  const n = round ? el.labels.length : el.series.length;
  P.append(group(round ? 'Slice colours' : 'Series colours',
    h('div', { class: 'btnrow' }, Array.from({ length: n }, (_, i) => {
      const cur = C.seriesColor(el, i);
      return colorBtn(cur, v => { if (round) { el.colors = (el.colors || []).slice(); el.colors[i] = v; } else el.series[i].color = v; }, { title: round ? el.labels[i] : el.series[i].name });
    })),
    h('p', { class: 'hint', style: 'margin-top:8px' }, 'Default colours are picked in a fixed order that stays readable for colour-blind viewers.'),
    h('button', { class: 'pb wide', type: 'button', style: 'width:100%;margin-top:6px', onclick: () => { el.series.forEach(s => delete s.color); el.colors = null; commit(); } }, 'Reset colours')));
}
function tableProps(el) {
  const W = [[400, 'Regular'], [600, 'Semibold'], [700, 'Bold']];
  P.append(group('Table',
    h('button', { class: 'pb wide', type: 'button', style: 'width:100%;margin-bottom:10px', onclick: () => dataDialog(el) }, 'Edit cells'),
    h('div', { class: 'btnrow', style: 'margin-bottom:8px' }, Object.keys(TABLE_STYLES).map(k => pb(k[0].toUpperCase() + k.slice(1), k + ' style', () => { Object.assign(el, clone(TABLE_STYLES[k])); if (!TABLE_STYLES[k].hupper) el.hupper = false; C.syncText(el); commit(); }, false, 'wide'))),
    h('div', { class: 'prow' }, fontSelect(el.font || 'Sans', v => { el.font = v; C.syncText(el); })),
    h('div', { class: 'prow' },
      h('input', { type: 'number', value: Math.round(el.size), min: 4, 'aria-label': 'Text size', style: 'width:70px', onchange: e => { el.size = Math.max(4, +e.target.value); C.syncText(el); commit(); } }),
      h('select', { 'aria-label': 'Body weight', onchange: e => { el.weight = +e.target.value; C.syncText(el); commit(); } }, W.map(([v, n]) => h('option', { value: v, selected: (el.weight || 400) === v }, n)))),
    h('div', { class: 'btnrow', style: 'margin-bottom:8px' },
      pb('Header row', 'Header row', () => { el.header = el.header === false; C.syncText(el); commit(); }, el.header !== false, 'wide'),
      pb('AA', 'Uppercase header', () => { el.hupper = !el.hupper; C.syncText(el); commit(); }, el.hupper)),
    h('div', { class: 'prow' }, h('span', null, 'Align'), h('select', { onchange: e => { el.align = e.target.value; commit(); } }, [['auto', 'Auto (numbers right)'], ['left', 'Left'], ['center', 'Centre'], ['right', 'Right']].map(([k, n]) => h('option', { value: k, selected: (el.align || 'auto') === k }, n)))),
    prow('Text', colorBtn(el.color || '#111111', v => el.color = v)),
    prow('Header', colorBtn(el.hbg || 'none', v => el.hbg = v, { none: true }), colorBtn(el.hcolor || '#111111', v => el.hcolor = v, { title: 'Header text' })),
    prow('Fill', colorBtn(el.bg || 'none', v => el.bg = v, { none: true }), colorBtn(el.band || 'none', v => el.band = v, { none: true, title: 'Alternate rows' })),
    h('div', { class: 'prow' }, h('span', null, 'Lines'), h('select', { onchange: e => { el.lines = e.target.value; commit(); } }, [['rows', 'Between rows'], ['grid', 'Full grid'], ['none', 'None']].map(([k, n]) => h('option', { value: k, selected: (el.lines || 'rows') === k }, n))), colorBtn(el.line || '#d0d4dc', v => el.line = v)),
    slider('Cell padding', Math.round((el.pad == null ? .6 : el.pad) * 100), 10, 200, 5, v => { el.pad = v / 100; C.syncText(el); }),
    slider('Rounding', Math.round((el.radius || 0) * 100), 0, 150, 5, v => el.radius = v / 100)));
}

// A small spreadsheet: type, tab between cells, or paste straight from Excel/Sheets.
function gridEditor(rows, o) {
  o = o || {};
  let data = rows.map(r => r.map(v => v == null ? '' : String(v)));
  const wrap = h('div', { class: 'gridwrap' });
  const draw = () => {
    wrap.textContent = '';
    const nc = Math.max(1, ...data.map(r => r.length));
    data.forEach(r => { while (r.length < nc) r.push(''); });
    const t = h('table', { class: 'dgrid' });
    data.forEach((r, ri) => t.append(h('tr', null, r.map((v, ci) => {
      const inp = h('input', { type: 'text', value: v, 'aria-label': `Row ${ri + 1}, column ${ci + 1}`, placeholder: ri === 0 && ci === 0 && o.corner ? o.corner : '', inputmode: o.numeric && ri > 0 && ci > 0 ? 'decimal' : null });
      if (ri === 0 && ci === 0 && o.lockCorner) inp.disabled = true;
      inp.addEventListener('input', () => { data[ri][ci] = inp.value; o.onChange && o.onChange(); });
      inp.addEventListener('paste', e => {
        const txt = e.clipboardData.getData('text/plain');
        if (!/[\t\n]/.test(txt)) return;
        e.preventDefault();
        const lines = txt.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(l => l.includes('\t') ? l.split('\t') : l.split(','));
        lines.forEach((ln, i) => ln.forEach((v, j) => { const R = ri + i, Cc = ci + j; while (data.length <= R) data.push([]); while (data[R].length <= Cc) data[R].push(''); data[R][Cc] = v.trim(); }));
        draw(); o.onChange && o.onChange();
      });
      return h('td', { class: ci === 0 ? 'rh' : '' }, inp);
    }))));
    wrap.append(t);
  };
  draw();
  const btn = (t, fn) => h('button', { class: 'pb', type: 'button', onclick: () => { fn(); draw(); o.onChange && o.onChange(); } }, t);
  const bar = h('div', { class: 'btnrow' },
    btn('+ Row', () => data.push(new Array(data[0].length).fill(''))),
    btn('− Row', () => { if (data.length > (o.minRows || 2)) data.pop(); }),
    o.fixedCols ? null : btn('+ Column', () => data.forEach(r => r.push(''))),
    o.fixedCols ? null : btn('− Column', () => { if (data[0].length > (o.minCols || 2)) data.forEach(r => r.pop()); }));
  return { el: h('div', { style: 'display:grid;gap:8px' }, bar, wrap, h('p', { class: 'hint' }, 'Tip: copy cells from Excel or Google Sheets and paste into any box.')), get: () => data.map(r => r.slice()) };
}
function dataDialog(el) {
  if (el.type === 'table') {
    const g = gridEditor(el.rows, { minRows: 1, minCols: 1 });
    dialog('Edit table', [g.el], 'Done', () => {
      el.rows = g.get().filter((r, i) => i === 0 || r.some(v => v !== ''));
      el.colW = null; C.syncText(el); commit();
    });
    return;
  }
  const round = el.kind === 'pie' || el.kind === 'donut';
  const series = round ? [el.series[0]] : el.series;
  const rows = [[round ? 'Slice' : 'Label', ...series.map(s => s.name || '')], ...el.labels.map((l, i) => [l, ...series.map(s => s.values[i] == null ? '' : s.values[i])])];
  const g = gridEditor(rows, { corner: 'Label', lockCorner: true, fixedCols: round, numeric: true });
  dialog(round ? 'Edit slices' : 'Edit chart data', [h('p', { class: 'hint' }, round ? 'One row per slice: a name and a number.' : 'Rows are categories (the x-axis). Each extra column is a series — name it in the top row.'), g.el], 'Done', () => {
    const d = g.get();
    const body = d.slice(1).filter(r => r.some(v => String(v).trim() !== ''));
    if (!body.length) { toast('Add at least one row of data.', true); return false; }
    const num = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
    el.labels = body.map(r => r[0]);
    const cols = d[0].length - 1;
    el.series = Array.from({ length: Math.max(1, cols) }, (_, j) => Object.assign({}, el.series[j] || {}, { name: d[0][j + 1] || `Series ${j + 1}`, values: body.map(r => num(r[j + 1])) }));
    commit();
  });
}

// ---- QR builder
const QR_TYPES = [['url', 'Website'], ['wifi', 'Wi-Fi'], ['email', 'Email'], ['phone', 'Phone call'], ['sms', 'Text message'], ['vcard', 'Contact card'], ['text', 'Plain text']];
function qrString(type, f) {
  const esc = v => String(v || '').replace(/([\;,:"])/g, '\\$1');
  switch (type) {
    case 'url': { const u = (f.url || '').trim(); return !u ? '' : /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u; }
    case 'wifi': return `WIFI:T:${f.sec || 'WPA'};S:${esc(f.ssid)};${f.sec === 'nopass' ? '' : `P:${esc(f.pass)};`}${f.hidden ? 'H:true;' : ''};`;
    case 'email': { const q = [f.subject && 'subject=' + encodeURIComponent(f.subject), f.body && 'body=' + encodeURIComponent(f.body)].filter(Boolean).join('&'); return `mailto:${(f.to || '').trim()}${q ? '?' + q : ''}`; }
    case 'phone': return 'tel:' + (f.tel || '').replace(/[^\d+]/g, '');
    case 'sms': return `SMSTO:${(f.tel || '').replace(/[^\d+]/g, '')}:${f.msg || ''}`;
    case 'vcard': return ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(f.last)};${esc(f.first)};;;`, `FN:${esc([f.first, f.last].filter(Boolean).join(' '))}`, f.org && `ORG:${esc(f.org)}`, f.title && `TITLE:${esc(f.title)}`, f.tel && `TEL;TYPE=CELL:${f.tel}`, f.email && `EMAIL:${f.email}`, f.url && `URL:${f.url}`, 'END:VCARD'].filter(Boolean).join('\n');
    default: return f.text || '';
  }
}
function qrDialog(el) {
  let type = el ? el.qrType || 'text' : 'url';
  const f = el ? Object.assign({}, el.qrData || { text: el.text }) : { url: '' };
  const fieldsBox = h('div', { style: 'display:grid;gap:8px' });
  const pv = document.createElement('canvas'); pv.width = pv.height = 400;
  const info = h('p', { class: 'hint', style: 'text-align:center' });
  const upd = () => {
    const t = qrString(type, f), x = pv.getContext('2d');
    x.clearRect(0, 0, 400, 400);
    if (!t) { info.textContent = 'Fill in the details to see your code.'; return; }
    try {
      const q = window.LDQR.get(t, el ? el.ecc : 'M');
      C.drawElement(x, Object.assign({ type: 'qr', x: 0, y: 0, w: 400, h: 400, fg: '#000000', bg: '#ffffff', quiet: 2 }, el ? { fg: el.fg, bg: el.bg, style: el.style, eye: el.eye, eyeColor: el.eyeColor, ecc: el.ecc } : {}, { text: t }), { scale: 1 });
      info.textContent = `${q.size} × ${q.size} modules · ${t.length} characters`;
    } catch { info.textContent = 'That’s too much for one QR code — shorten it.'; }
  };
  const inp = (key, label, o) => {
    o = o || {};
    const e = o.area ? h('textarea', { 'aria-label': label, placeholder: o.ph || '' }) : h('input', { type: o.type || 'text', 'aria-label': label, placeholder: o.ph || '', style: 'width:100%' });
    e.value = f[key] || '';
    e.addEventListener('input', () => { f[key] = e.value; upd(); });
    return h('label', { style: 'display:grid;gap:4px;color:var(--muted)' }, label, e);
  };
  const fields = () => {
    fieldsBox.textContent = '';
    const add = (...k) => fieldsBox.append(...k);
    if (type === 'url') add(inp('url', 'Web address', { ph: 'www.yourbusiness.com' }));
    if (type === 'wifi') {
      const sec = h('select', { onchange: e => { f.sec = e.target.value; fields(); upd(); } }, [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP'], ['nopass', 'No password']].map(([k, n]) => h('option', { value: k, selected: (f.sec || 'WPA') === k }, n)));
      add(inp('ssid', 'Network name', { ph: 'Office-Guest' }), f.sec === 'nopass' ? null : inp('pass', 'Password'), h('label', { style: 'display:grid;gap:4px;color:var(--muted)' }, 'Security', sec),
        h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--muted)' }, h('input', { type: 'checkbox', checked: !!f.hidden, onchange: e => { f.hidden = e.target.checked; upd(); } }), 'Hidden network'));
    }
    if (type === 'email') add(inp('to', 'To', { type: 'email', ph: 'hello@yourbusiness.com' }), inp('subject', 'Subject'), inp('body', 'Message', { area: true }));
    if (type === 'phone') add(inp('tel', 'Phone number', { type: 'tel', ph: '+1 555 123 4567' }));
    if (type === 'sms') add(inp('tel', 'Phone number', { type: 'tel' }), inp('msg', 'Message', { area: true }));
    if (type === 'vcard') add(h('div', { class: 'grid4' }, inp('first', 'First name'), inp('last', 'Last name')), inp('org', 'Company'), inp('title', 'Job title'), inp('tel', 'Phone', { type: 'tel' }), inp('email', 'Email', { type: 'email' }), inp('url', 'Website'));
    if (type === 'text') add(inp('text', 'Text', { area: true }));
  };
  const typeSel = h('select', { onchange: e => { type = e.target.value; fields(); upd(); } }, QR_TYPES.map(([k, n]) => h('option', { value: k, selected: k === type }, n)));
  fields(); upd();
  dialog(el ? 'Edit QR code' : 'Add a QR code', h('div', { style: 'display:grid;grid-template-columns:1fr 200px;gap:16px;align-items:start' },
    h('div', { style: 'display:grid;gap:10px' }, h('label', { style: 'display:grid;gap:4px;color:var(--muted)' }, 'What should it open?', typeSel), fieldsBox),
    h('div', { style: 'display:grid;gap:8px' }, h('div', { class: 'qrprev' }, pv), info)), el ? 'Update' : 'Add to design', () => {
    const t = qrString(type, f);
    if (!t) { toast('Fill in the details first.', true); return false; }
    try { window.LDQR.get(t, el ? el.ecc : 'M'); } catch { toast('That’s too much for one QR code.', true); return false; }
    if (el) { el.text = t; el.qrType = type; el.qrData = clone(f); commit(); }
    else addQR(t, { qrType: type, qrData: clone(f) });
  }).then(() => {});
  const d = document.querySelector('.scrim:last-child .dlg'); if (d) d.style.width = '600px';
}

// ---- background remover
let bgModule = null;
function loadBgModule() {
  if (window.LDBg) return Promise.resolve(window.LDBg);
  if (!bgModule) bgModule = new Promise((res, rej) => { const s = h('script', { src: '/design/bgremove.js' }); s.onload = () => res(window.LDBg); s.onerror = () => { bgModule = null; rej(new Error('Couldn’t load the background remover.')); }; document.head.append(s); });
  return bgModule;
}
function bgDialog(el) {
  const img = getImg(el.src);
  if (!img) return toast('Add a photo first.', true);
  let kind = 'object', res = null, cleanup = 20, brush = null, bsize = 40, compare = false, busy = false;
  let edit = null, eg = null;   // user's erase/restore strokes: white = keep, black = remove, transparent = untouched
  const view = document.createElement('canvas');
  const stage = h('div', { class: 'bgstage' }, view);
  const bar = h('i'), msg = h('div', null, 'Loading…');
  const busyEl = h('div', { class: 'bgbusy' }, h('div', null, msg, h('div', { class: 'bar' }, bar)));
  stage.append(busyEl);
  let outCanvas = null;
  const compose = () => {
    if (!res) return;
    const { canvas, alpha } = res, W = canvas.width, H = canvas.height;
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
    const ed = eg ? eg.getImageData(0, 0, W, H).data : null;
    const lo = cleanup / 100 * .45;
    for (let i = 0; i < alpha.length; i++) {
      let a = alpha[i];
      a = lo ? Math.max(0, Math.min(1, (a - lo) / (1 - lo * 1.6))) : a;
      if (ed) { const ea = ed[i * 4 + 3] / 255; if (ea) a = a * (1 - ea) + (ed[i * 4] / 255) * ea; }
      src.data[i * 4 + 3] = Math.round(a * 255);
    }
    if (!outCanvas) { outCanvas = document.createElement('canvas'); outCanvas.width = W; outCanvas.height = H; }
    outCanvas.getContext('2d').putImageData(src, 0, 0);
    paintView();
  };
  const paintView = () => {
    if (!res) return;
    const W = res.canvas.width, H = res.canvas.height;
    view.width = W; view.height = H;
    const x = view.getContext('2d');
    for (let yy = 0; yy < H; yy += 24) for (let xx = 0; xx < W; xx += 24) { x.fillStyle = ((xx + yy) / 24) % 2 ? '#ffffff' : '#e3e6ec'; x.fillRect(xx, yy, 24, 24); }
    x.drawImage(compare ? res.canvas : outCanvas, 0, 0);
  };
  const run = async () => {
    busy = true; busyEl.hidden = false; bar.style.width = '0';
    const first = !window.LDBg || !window.LDBg.isLoaded(kind);
    msg.textContent = first ? 'Downloading the background remover (first time only)…' : 'Removing the background…';
    try {
      const mod = await loadBgModule();
      res = await mod.run(img, kind, (stage2, n, total) => {
        if (stage2 === 'runtime') { msg.textContent = 'Downloading the background remover (first time only)…'; bar.style.width = Math.round(n / total * 60) + '%'; }
        if (stage2 === 'model') { msg.textContent = 'Downloading the AI model (first time only)…'; bar.style.width = 60 + Math.round(n / total * 35) + '%'; }
        if (stage2 === 'run') { msg.textContent = 'Removing the background…'; bar.style.width = '97%'; }
      });
      edit = document.createElement('canvas'); edit.width = res.canvas.width; edit.height = res.canvas.height; eg = edit.getContext('2d', { willReadFrequently: true });
      outCanvas = null; compose(); busyEl.hidden = true;
    } catch (err) {
      console.error(err);
      msg.textContent = 'Sorry — the background remover couldn’t run in this browser. ' + (err.message || '');
      bar.parentNode.hidden = true;
    }
    busy = false;
  };
  // brush strokes on the preview
  let painting = false, lastPt = null, raf2 = 0;
  const toImg = e => { const r = view.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * view.width, (e.clientY - r.top) / r.height * view.height, view.width / r.width]; };
  const stroke = (p) => {
    const [x, y, k] = p;
    eg.globalCompositeOperation = 'source-over';
    eg.strokeStyle = eg.fillStyle = brush === 'erase' ? '#000000' : '#ffffff';
    eg.lineWidth = bsize * k; eg.lineCap = 'round'; eg.lineJoin = 'round';
    eg.beginPath(); if (lastPt) { eg.moveTo(lastPt[0], lastPt[1]); eg.lineTo(x, y); eg.stroke(); } else { eg.arc(x, y, bsize * k / 2, 0, Math.PI * 2); eg.fill(); }
    lastPt = p;
    if (!raf2) raf2 = requestAnimationFrame(() => { raf2 = 0; compose(); });
  };
  view.addEventListener('pointerdown', e => { if (!brush || !res || busy) return; e.preventDefault(); view.setPointerCapture(e.pointerId); painting = true; lastPt = null; stroke(toImg(e)); });
  view.addEventListener('pointermove', e => { if (painting) stroke(toImg(e)); });
  const endStroke = () => { painting = false; lastPt = null; };
  view.addEventListener('pointerup', endStroke); view.addEventListener('pointercancel', endStroke);
  const modeBtns = h('div', { class: 'btnrow' });
  const drawModes = () => { modeBtns.textContent = ''; modeBtns.append(...[['object', 'Anything'], ['person', 'Person']].map(([k, n]) => pb(n, n, () => { if (busy || kind === k) return; kind = k; drawModes(); run(); }, kind === k, 'wide'))); };
  drawModes();
  const brushBtns = h('div', { class: 'btnrow' });
  const drawBrush = () => { brushBtns.textContent = ''; brushBtns.append(...[[null, 'Off'], ['erase', 'Erase'], ['restore', 'Restore']].map(([k, n]) => pb(n, n + ' brush', () => { brush = k; view.style.cursor = k ? 'crosshair' : 'default'; drawBrush(); }, brush === k, 'wide'))); };
  drawBrush();
  const side = h('div', { style: 'display:grid;gap:12px' },
    h('div', null, h('div', { class: 'sec', style: 'margin-top:0' }, 'What’s in the photo?'), modeBtns, h('p', { class: 'hint', style: 'margin-top:6px' }, '“Anything” works for products, pets, logos and people. Try “Person” for fine hair.')),
    h('div', null, h('div', { class: 'sec' }, 'Clean up edges'), slider('Cleanup', cleanup, 0, 100, 1, v => { cleanup = v; compose(); })),
    h('div', null, h('div', { class: 'sec' }, 'Touch up by hand'), brushBtns, slider('Brush size', bsize, 5, 150, 1, v => { bsize = v; }),
      h('button', { class: 'pb wide', type: 'button', style: 'width:100%;margin-top:4px', onclick: () => { if (eg) { eg.clearRect(0, 0, edit.width, edit.height); compose(); } } }, 'Undo all touch-ups')),
    h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--muted)' }, h('input', { type: 'checkbox', onchange: e => { compare = e.target.checked; paintView(); } }), 'Show original'),
    h('p', { class: 'hint' }, 'Runs on this device — your photo isn’t uploaded.'));
  // the slider helper commits history on change; nothing to commit inside this dialog
  side.querySelectorAll('input[type=range]').forEach(r => r.addEventListener('change', e => e.stopImmediatePropagation(), true));
  dialog('Remove background', h('div', { class: 'bgwrap' }, stage, side), 'Apply', () => {
    if (!res || !outCanvas) { toast('Still working — give it a moment.'); return false; }
    // trim to the subject so the new image isn't mostly empty
    const id = addImage(outCanvas.toDataURL('image/png'));
    uploads.unshift(id);
    el.srcOriginal = el.srcOriginal || el.src;
    el.src = id;
    commit();
    toast('Background removed. “Restore original” brings it back.');
  });
  const d = document.querySelector('.scrim:last-child .dlg'); if (d) d.classList.add('wide');
  run();
}

// ---------------------------------------------------------------- wiring
$('homeBtn').addEventListener('click', goHome);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('resizeBtn').addEventListener('click', resizeDialog);
$('exportBtn').addEventListener('click', exportDialog);
$('presentBtn').addEventListener('click', present);
$('playBtn').addEventListener('click', () => play(doc && doc.pages.length > 1));
$('propsToggle').addEventListener('click', () => document.body.classList.toggle('showprops'));
$('dClose').addEventListener('click', closeDrawer);
$('docName').addEventListener('change', e => { if (doc) { doc.name = e.target.value.trim() || 'Untitled design'; saveSoon(); } });
$('docName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('fileImg').addEventListener('change', e => { const f = e.target.files; if (f.length) uploadFiles(f); e.target.value = ''; });
$('fileReplace').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const src = await readImageFile(f), id = addImage(src); uploads.unshift(id);
    const el = byId(replaceTarget);
    if (el) { el.src = id; el.zoom = 1; el.px = el.py = 0; sel = [el.id]; }
    replaceTarget = null; commit();
  } catch { toast('That image couldn’t be opened.', true); }
});
$('fileProject').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openProjectFile(f); });
$('fileFont').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFontFile(f); });
$('fileLogo').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const src = await readImageFile(f);
    const im = new Image(); im.src = src; await im.decode();
    const k = Math.min(1, 700 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    brand.logo = c.toDataURL('image/png'); saveBrand(); showTab('brand');
  } catch { toast('That image couldn’t be opened.', true); }
});
new ResizeObserver(() => { const had = vw; resizeCanvas(); if (doc && !had) fit(); placeEditor(); }).observe(work);
window.addEventListener('resize', () => { if (doc) thumbsSoon(); });
document.addEventListener('gesturestart', e => e.preventDefault());   // stop iOS page-zoom fighting the pinch

let fontT = 0;
C.onFontLoad(() => {
  clearTimeout(fontT);
  fontT = setTimeout(() => {
    if (!doc) return;
    for (const pg of doc.pages) for (const el of pg.els) if (el.type === 'text' || el.type === 'table') C.syncText(el);
    requestRender(); thumbsSoon(); placeEditor();
  }, 60);
});
buildRail();
if (window.innerWidth < 980) $('drawer').classList.add('closed');
resizeCanvas();
// Template thumbnails measure text to fit it, so their fonts must be loaded first.
const templateFonts = Promise.race([Promise.all(TP.faces().map(f => C.loadFont(f[0], f[1], f[2]))), new Promise(r => setTimeout(r, 6000))]);
buildHome();
showContinue();
// Deep links: /design/#new=ig-story or #t=search%20words
const hsh = new URLSearchParams(location.hash.slice(1));
if (hsh.get('new') && fmtById(hsh.get('new'))) { const f = fmtById(hsh.get('new')); newDoc(f.w, f.h, { fmt: f.id, name: 'Untitled ' + f.n }); }
else if (hsh.get('t')) { $('hSearch').value = homeState.q = hsh.get('t'); fillHomeGrid(); }

// ---------------------------------------------------------------- install & offline
let installPrompt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('hInstall').hidden = false; });
window.addEventListener('appinstalled', () => { installPrompt = null; $('hInstall').hidden = true; toast('Installed — Linear Design now opens like an app, even offline.'); });
function installApp() {
  if (installPrompt) { installPrompt.prompt(); installPrompt.userChoice.finally(() => { installPrompt = null; $('hInstall').hidden = true; }); return; }
  if (standalone()) return toast('You’re already using the installed app.');
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return toast('On iPhone or iPad: tap the Share button, then “Add to Home Screen”.');
  toast('Use your browser’s menu → “Install app” (or “Add to Home screen”).');
}
$('hInstall').addEventListener('click', installApp);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/design/sw.js', { scope: '/design/' }).catch(() => {}));
}

// Exposed for automated checks only.
window.__ld = { get doc() { return doc; }, get sel() { return sel; }, set sel(v) { sel = v; buildProps(); requestRender(); }, commit, undo, redo, applyTemplate, newDoc, view, toPage, toScr, exportDialog, resizeDesign, addText, addShape, addIcon, addFrame, addEmoji, projectData, loadProject, uploads, images, addImage };
})();
