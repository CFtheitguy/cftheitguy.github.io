/* Linear Video — a multi-track video editor that runs entirely in the tab.
 *
 * Model: a project is a list of tracks and a flat list of clips. A clip is a
 * window onto a source: it sits at `start` on the timeline for `dur` seconds
 * and reads its media from `in` onwards at `speed`. Nothing is decoded or
 * re-encoded while editing. Each media clip owns a <video>/<audio> element
 * that is kept in step with the playhead, and the preview is a canvas that
 * composites whatever is under the playhead, bottom track first.
 *
 * Export is that same preview played in real time into a MediaRecorder: the
 * canvas's captureStream() for the picture and a Web Audio mix for the sound.
 * That's why a two-minute video takes two minutes to export, and why the tab
 * has to stay in front while it runs — browsers stop animating hidden tabs.
 *
 * Undo is a stack of JSON snapshots of the project. Media (the files, their
 * elements and thumbnails) lives outside the snapshot, so a step costs a few
 * kilobytes however large the footage is.
 */
'use strict';
(() => {

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN_DUR = 0.1;
const HISTORY_MAX = 100;
const IMAGE_DUR = 5, TITLE_DUR = 4;
const FORMATS = [
  { id: '16:9', w: 1920, h: 1080, label: 'Landscape 16:9', sub: 'YouTube, TV, laptops' },
  { id: '9:16', w: 1080, h: 1920, label: 'Vertical 9:16', sub: 'Reels, TikTok, Shorts' },
  { id: '1:1', w: 1080, h: 1080, label: 'Square 1:1', sub: 'Feed posts' },
  { id: '4:5', w: 1080, h: 1350, label: 'Portrait 4:5', sub: 'Instagram feed' },
  { id: '4:3', w: 1440, h: 1080, label: 'Classic 4:3', sub: 'Slides, older footage' },
];
const FONTS = {
  sans: ['Sans', '"Helvetica Neue", Helvetica, Arial, sans-serif'],
  serif: ['Serif', 'Georgia, "Times New Roman", serif'],
  display: ['Display', 'Impact, "Arial Black", "Helvetica Neue", sans-serif'],
  rounded: ['Rounded', '"Trebuchet MS", "Avenir Next", Verdana, sans-serif'],
  mono: ['Typewriter', '"Courier New", Courier, monospace'],
  script: ['Script', '"Brush Script MT", "Segoe Script", "Snell Roundhand", cursive'],
};
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const VISUAL = new Set(['video', 'image', 'text', 'color']);

// ---------------------------------------------------------------- state
let uid = 1;
const nid = p => p + (uid++);
let P = newProject();
let projName = 'My video';
const media = new Map();        // id → {id, name, type, file, url, dur, w, h, thumb, wave, hasAudio, img}
const els = new Map();          // clip id → {el, mediaId, gain}
let sel = null;                 // selected clip id
let time = 0, playing = false, looping = false;
let dirty = true;
let pps = 60;                   // timeline pixels per second
let snapOn = true;
let undoStack = [], redoStack = [];
let pend = null;                // snapshot taken when a continuous edit (slider, drag) began
let boxes = [];                 // on-screen boxes of visual clips from the last render, bottom first
let exporting = null;

function newProject() {
  return {
    fmt: '16:9', w: 1920, h: 1080, fps: 30, bg: '#000000',
    tracks: [
      { id: nid('t'), kind: 'video', hidden: false, muted: false },
      { id: nid('t'), kind: 'video', hidden: false, muted: false },
      { id: nid('t'), kind: 'audio', hidden: false, muted: false },
      { id: nid('t'), kind: 'audio', hidden: false, muted: false },
    ],
    clips: [],
  };
}

function baseClip(o) {
  return Object.assign({
    id: nid('c'), type: 'video', mediaId: null, track: null, start: 0, dur: 5, in: 0, speed: 1,
    volume: 1, mute: false, opacity: 1, fadeIn: 0, fadeOut: 0,
    x: 0, y: 0, scale: 1, rot: 0, flip: false, fit: 'fit', motion: 'none',
    bright: 0, contrast: 0, sat: 0, bw: false, blur: 0,
  }, o);
}

const clipById = id => P.clips.find(c => c.id === id);
const trackById = id => P.tracks.find(t => t.id === id);
const selClip = () => sel ? clipById(sel) : null;
const kindOf = type => type === 'audio' ? 'audio' : 'video';
const endOf = c => c.start + c.dur;
const isActive = (c, t) => t >= c.start && t < endOf(c);
const hasSource = c => c.type === 'video' || c.type === 'audio';
const projectEnd = () => P.clips.reduce((m, c) => Math.max(m, endOf(c)), 0);
const frameDur = () => 1 / P.fps;

// ---------------------------------------------------------------- small helpers
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const pad = n => String(n).padStart(2, '0');
function tc(t) {
  const f = Math.floor(Math.max(0, t) * P.fps + 1e-6);
  const s = Math.floor(f / P.fps);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(f % P.fps)}`;
}
function short(t) {
  if (!isFinite(t)) return '—';
  if (t < 60) return (Math.round(t * 10) / 10) + 's';
  const s = Math.round(t);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
function toast(msg, err) {
  const t = h('div', 'toast' + (err ? ' err' : ''), msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3200);
}
const hint = msg => { $('stHint').textContent = msg; };
function once(el, evs, ms) {
  return new Promise(res => {
    let timer;
    const done = e => { clearTimeout(timer); evs.forEach(ev => el.removeEventListener(ev, done)); res(e); };
    evs.forEach(ev => el.addEventListener(ev, done));
    timer = setTimeout(() => done(null), ms);
  });
}
function download(blob, name) {
  const a = h('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const fileBase = () => (projName.trim() || 'video').replace(/[\\/:*?"<>|]+/g, '-');

// ---------------------------------------------------------------- history
const snap = () => JSON.stringify(P);
function pushUndo(s, label) {
  if (s === snap()) return;
  undoStack.push({ s, label });
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack = [];
  updateButtons();
}
function begin() { if (!pend) pend = snap(); }
function end(label) { if (pend) { pushUndo(pend, label); pend = null; } }
function edit(label, fn) {
  const s = snap();
  fn();
  pushUndo(s, label);
  renderAll();
}
function restore(s) {
  P = JSON.parse(s);
  if (sel && !clipById(sel)) sel = null;
  gcEls();
  renderAll();
}
function undo() {
  const e = undoStack.pop();
  if (!e) return;
  redoStack.push({ s: snap(), label: e.label });
  restore(e.s);
  hint('Undid ' + (e.label || 'edit').toLowerCase());
}
function redo() {
  const e = redoStack.pop();
  if (!e) return;
  undoStack.push({ s: snap(), label: e.label });
  restore(e.s);
  hint('Redid ' + (e.label || 'edit').toLowerCase());
}

// ---------------------------------------------------------------- audio
// Every media element is routed through Web Audio as soon as a context exists,
// so the same mix reaches the speakers and, during export, the recorder.
let actx = null, master = null, speakers = null;
function audio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
    master = actx.createGain();
    speakers = actx.createGain();
    master.connect(speakers).connect(actx.destination);
    for (const e of els.values()) hookAudio(e);
  }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
function hookAudio(e) {
  if (!actx || e.gain) return;
  try {
    const src = actx.createMediaElementSource(e.el);
    e.gain = actx.createGain();
    src.connect(e.gain).connect(master);
    e.el.volume = 1;
  } catch (err) { /* already routed, or the browser refused: fall back to el.volume */ }
}

// ---------------------------------------------------------------- media elements
function elFor(c) {
  let e = els.get(c.id);
  if (e && e.mediaId === c.mediaId) return e;
  if (e) dropEl(c.id);
  const m = media.get(c.mediaId);
  const el = document.createElement(c.type === 'audio' ? 'audio' : 'video');
  el.preload = 'auto';
  el.playsInline = true;
  el.setAttribute('playsinline', '');
  el.src = m.url;
  el.addEventListener('seeked', () => { dirty = true; });
  el.addEventListener('loadeddata', () => { dirty = true; });
  $('pool').append(el);
  e = { el, mediaId: c.mediaId, gain: null };
  hookAudio(e);
  els.set(c.id, e);
  return e;
}
function dropEl(id) {
  const e = els.get(id);
  if (!e) return;
  e.el.pause();
  e.el.removeAttribute('src');
  try { e.el.load(); } catch (err) {}
  e.el.remove();
  if (e.gain) e.gain.disconnect();
  els.delete(id);
}
function gcEls() {
  for (const id of [...els.keys()]) {
    const c = clipById(id);
    if (!c || c.mediaId !== els.get(id).mediaId) dropEl(id);
  }
}
function fadeAt(c, t) {
  let a = 1;
  if (c.fadeIn > 0) a = Math.min(a, (t - c.start) / c.fadeIn);
  if (c.fadeOut > 0) a = Math.min(a, (endOf(c) - t) / c.fadeOut);
  return clamp(a, 0, 1);
}

// Keep every media element where the playhead says it should be. Elements
// play on their own while the project plays and are only nudged back when they
// drift, because seeking a playing video on every frame makes it stutter.
function syncMedia() {
  for (const c of P.clips) {
    if (!hasSource(c) || !media.has(c.mediaId)) continue;
    const { el, gain } = elFor(c);
    const on = isActive(c, time);
    const want = c.in + (time - c.start) * c.speed;
    if (on) {
      if (el.playbackRate !== c.speed) { el.playbackRate = c.speed; el.defaultPlaybackRate = c.speed; }
      if (playing) {
        if (el.paused) {
          if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want;
          el.play().catch(() => {});
        } else if (!el.seeking && Math.abs(el.currentTime - want) > 0.3) {
          el.currentTime = want;
        }
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && Math.abs(el.currentTime - want) > 0.5 / P.fps) el.currentTime = want;
      }
    } else {
      if (!el.paused) el.pause();
      const ahead = c.start - time;
      // Park the element on its first frame shortly before it's needed.
      if (ahead > 0 && ahead < 2 && !el.seeking && Math.abs(el.currentTime - c.in) > 0.05) el.currentTime = c.in;
    }
    const tr = trackById(c.track);
    const vol = on && !c.mute && !(tr && tr.muted) ? c.volume * fadeAt(c, time) : 0;
    if (gain) {
      if (Math.abs(gain.gain.value - vol) > 1e-4) gain.gain.setTargetAtTime(vol, actx.currentTime, 0.012);
    } else {
      el.volume = clamp(vol, 0, 1);
    }
  }
}

// ---------------------------------------------------------------- preview rendering
const view = $('view');
const vctx = view.getContext('2d');
const even = n => Math.max(2, Math.round(n / 2) * 2);
function sizeCanvas(scale) {
  const s = scale || Math.min(1, 1280 / Math.max(P.w, P.h));
  const w = even(P.w * s), hh = even(P.h * s);
  if (view.width !== w || view.height !== hh) { view.width = w; view.height = hh; }
  fitView();
  dirty = true;
}
function fitView() {
  const scr = $('screen');
  const aw = Math.max(40, scr.clientWidth - 28), ah = Math.max(40, scr.clientHeight - 28);
  const k = Math.min(aw / P.w, ah / P.h);
  view.style.width = Math.floor(P.w * k) + 'px';
  view.style.height = Math.floor(P.h * k) + 'px';
}

function filterFor(c, rs) {
  const f = [];
  if (c.bright) f.push(`brightness(${1 + c.bright / 100})`);
  if (c.contrast) f.push(`contrast(${1 + c.contrast / 100})`);
  if (c.bw) f.push('grayscale(1)');
  else if (c.sat) f.push(`saturate(${1 + c.sat / 100})`);
  if (c.blur) f.push(`blur(${(c.blur * rs).toFixed(2)}px)`);
  return f.length ? f.join(' ') : 'none';
}

function render(ui = true) {
  const W = P.w, H = P.h;
  const rs = view.width / W;
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.globalAlpha = 1;
  vctx.filter = 'none';
  vctx.fillStyle = P.bg;
  vctx.fillRect(0, 0, view.width, view.height);
  vctx.setTransform(rs, 0, 0, view.height / H, 0, 0);
  boxes = [];
  const vt = P.tracks.filter(t => t.kind === 'video').reverse();
  for (const tr of vt) {
    if (tr.hidden) continue;
    for (const c of P.clips) if (c.track === tr.id && isActive(c, time)) drawClip(c, rs);
  }
  const s = selClip();
  if (ui && s && !playing && !exporting) {
    const b = boxes.find(b => b.id === s.id);
    if (b) {
      vctx.save();
      vctx.translate(b.cx, b.cy);
      vctx.rotate(b.rot);
      vctx.lineWidth = 2 / rs;
      vctx.setLineDash([8 / rs, 6 / rs]);
      vctx.strokeStyle = '#00b0ec';
      vctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      vctx.restore();
    }
  }
}

function drawClip(c, rs) {
  const W = P.w, H = P.h;
  const lt = time - c.start;
  const alpha = c.opacity * fadeAt(c, time);
  if (alpha <= 0) return;
  vctx.save();
  vctx.globalAlpha = alpha;
  vctx.filter = filterFor(c, rs);
  const cx = W / 2 + c.x * W, cy = H / 2 + c.y * H;
  const rot = c.rot * Math.PI / 180;
  if (c.type === 'color') {
    vctx.fillStyle = c.color;
    vctx.fillRect(0, 0, W, H);
    boxes.push({ id: c.id, cx: W / 2, cy: H / 2, w: W, h: H, rot: 0 });
  } else if (c.type === 'text') {
    drawText(c, lt, rs, cx, cy, rot);
  } else {
    const m = media.get(c.mediaId);
    let src = null, sw = 0, sh = 0;
    if (m && c.type === 'image' && m.img) { src = m.img; sw = m.w; sh = m.h; }
    if (m && c.type === 'video') {
      const e = els.get(c.id);
      if (e && e.el.readyState >= 2 && e.el.videoWidth) { src = e.el; sw = e.el.videoWidth; sh = e.el.videoHeight; }
      else { sw = m.w; sh = m.h; }
    }
    if (sw && sh) {
      const base = c.fit === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
      const k = clamp(lt / c.dur, 0, 1);
      const zoom = c.motion === 'in' ? 1 + 0.18 * k : c.motion === 'out' ? 1.18 - 0.18 * k : 1;
      const dw = sw * base * c.scale * zoom, dh = sh * base * c.scale * zoom;
      vctx.translate(cx, cy);
      vctx.rotate(rot);
      if (c.flip) vctx.scale(-1, 1);
      if (src) vctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
      boxes.push({ id: c.id, cx, cy, w: dw, h: dh, rot });
    }
  }
  vctx.restore();
}

const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeBack = k => { const s = 1.7; k -= 1; return k * k * ((s + 1) * k + s) + 1; };
function drawText(c, lt, rs, cx, cy, rot) {
  const H = P.h;
  const size = c.size / 100 * H;
  const lines = (c.text || ' ').split('\n');
  const lineH = size * 1.2;
  let sc = c.scale, dy = 0, a = 1, shown = Infinity;
  if (c.anim === 'rise') { const k = easeOut(clamp(lt / 0.7, 0, 1)); dy = (1 - k) * size * 0.8; a = k; }
  if (c.anim === 'pop') sc *= 0.5 + 0.5 * easeBack(clamp(lt / 0.45, 0, 1));
  if (c.anim === 'type') {
    const n = lines.join('').length;
    shown = Math.ceil(n * clamp(lt / Math.min(c.dur * 0.7, n * 0.06 + 0.15), 0, 1));
  }
  vctx.globalAlpha *= a;
  vctx.font = `${c.italic ? 'italic ' : ''}${c.bold ? '700' : '400'} ${size}px ${FONTS[c.font] ? FONTS[c.font][1] : FONTS.sans[1]}`;
  vctx.textBaseline = 'middle';
  vctx.textAlign = c.align;
  const widths = lines.map(l => vctx.measureText(l).width);
  const maxW = Math.max(...widths, size * 0.3);
  const totalH = lines.length * lineH;
  const pad = size * 0.35;
  vctx.translate(cx, cy + dy);
  vctx.rotate(rot);
  vctx.scale(sc, sc);
  if (c.style === 'box') {
    vctx.save();
    vctx.filter = 'none';
    vctx.fillStyle = c.boxColor;
    vctx.globalAlpha *= 0.85;
    const bw = maxW + pad * 2, bh = totalH + pad * 1.2, r = size * 0.18;
    vctx.beginPath();
    if (vctx.roundRect) vctx.roundRect(-bw / 2, -bh / 2, bw, bh, r); else vctx.rect(-bw / 2, -bh / 2, bw, bh);
    vctx.fill();
    vctx.restore();
  }
  if (c.style === 'shadow') {
    vctx.shadowColor = 'rgba(0,0,0,.65)';
    vctx.shadowBlur = size * 0.18 * rs * sc;
    vctx.shadowOffsetY = size * 0.05 * rs * sc;
  }
  const x = c.align === 'left' ? -maxW / 2 : c.align === 'right' ? maxW / 2 : 0;
  let left = shown;
  lines.forEach((l, i) => {
    if (left <= 0) return;
    const txt = l.length > left ? l.slice(0, left) : l;
    left -= l.length;
    const y = -totalH / 2 + lineH * (i + 0.5);
    if (c.style === 'outline') {
      vctx.lineJoin = 'round';
      vctx.lineWidth = size * 0.14;
      vctx.strokeStyle = c.boxColor;
      vctx.strokeText(txt, x, y);
    }
    vctx.fillStyle = c.color;
    vctx.fillText(txt, x, y);
  });
  const bw = (maxW + pad * 2) * sc, bh = (totalH + pad * 1.2) * sc;
  boxes.push({ id: c.id, cx, cy: cy + dy, w: bw, h: bh, rot });
}

// ---------------------------------------------------------------- playback
function play() {
  if (exporting) return;
  if (!P.clips.length) return;
  audio();
  if (time >= projectEnd() - 1e-3) time = 0;
  playing = true;
  lastTs = 0;
  updatePlayBtn();
}
function pause() {
  playing = false;
  for (const e of els.values()) e.el.pause();
  lastTs = 0;
  dirty = true;
  updatePlayBtn();
}
const toggle = () => playing ? pause() : play();
function seek(t) {
  time = clamp(t, 0, Math.max(0, projectEnd()));
  dirty = true;
}
function updatePlayBtn() {
  $('playIco').innerHTML = playing
    ? '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>'
    : '<path d="M7 4v16l13-8z" fill="currentColor"/>';
  $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

let lastTs = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (playing) {
    const dt = lastTs ? Math.min(1, (ts - lastTs) / 1000) : 0;
    time += dt;
    const e = projectEnd();
    if (time >= e) {
      if (exporting) { time = e; finishExport(); }
      else if (looping && e > 0) time = 0;
      else { time = e; pause(); }
    }
    dirty = true;
    if (!exporting) follow();
  }
  lastTs = ts;
  syncMedia();
  if (dirty) {
    dirty = false;
    render();
    updatePlayhead();
    updateTC();
    if (!exporting) $('tSplit').disabled = !P.clips.some(x => isActive(x, time));
  }
}
function updateTC() {
  $('tc').innerHTML = `${tc(time)} <span>/ ${tc(projectEnd())}</span>`;
  if (exporting && exporting.progress) exporting.progress(time / Math.max(1e-3, projectEnd()));
}

// ---------------------------------------------------------------- import
const fileIn = $('fileIn');
function typeOf(file) {
  const t = file.type || '';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'flac', 'opus'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'svg'].includes(ext)) return 'image';
  return null;
}

async function importFiles(list) {
  const files = [...list];
  if (!files.length) return;
  audio();
  const wasEmpty = !P.clips.length;
  const added = [];
  hint(`Importing ${files.length} file${files.length > 1 ? 's' : ''}…`);
  for (const file of files) {
    const type = typeOf(file);
    if (!type) { toast(`${file.name}: not a video, audio or image file.`, true); continue; }
    const m = { id: nid('m'), name: file.name, type, file, url: URL.createObjectURL(file), dur: 0, w: 0, h: 0, thumb: null, wave: null, hasAudio: type !== 'image', img: null };
    try {
      if (type === 'image') await probeImage(m);
      else if (type === 'video') await probeVideo(m);
      else await probeAudio(m);
    } catch (err) {
      URL.revokeObjectURL(m.url);
      toast(`${file.name} couldn’t be opened here. ${type === 'video' ? 'This browser may not play that format — MP4 (H.264) and WebM work everywhere.' : type === 'image' ? 'HEIC photos only open in Safari; try JPG or PNG.' : 'Try MP3, M4A or WAV.'}`, true);
      continue;
    }
    media.set(m.id, m);
    added.push(m);
    renderBin();
    if (m.type !== 'image') makeWave(m).then(() => { renderBin(); renderTimeline(); });
  }
  if (!added.length) { hint(''); return; }
  showWelcome();
  if (wasEmpty) {
    // First import into an empty project: lay everything out in order, so
    // there's something to play straight away.
    const s = snap();
    time = 0;
    for (const m of added) if (m.type !== 'audio') addMediaClip(m, null, null, true);
    time = 0;
    for (const m of added) if (m.type === 'audio') addMediaClip(m, null, null, true);
    time = 0;
    pushUndo(s, 'Add clips');
    fitTimeline();
    renderAll();
  }
  hint(`Imported ${added.length} file${added.length > 1 ? 's' : ''}. Drag from Media onto the timeline, or press + on a thumbnail.`);
}

function thumbFrom(src, sw, sh) {
  const c = document.createElement('canvas');
  const k = Math.min(1, 240 / Math.max(sw, sh));
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75);
}
async function probeImage(m) {
  const img = new Image();
  img.src = m.url;
  await img.decode();
  m.img = img;
  m.w = img.naturalWidth || 1920;
  m.h = img.naturalHeight || 1080;
  m.dur = Infinity;
  m.hasAudio = false;
  m.thumb = thumbFrom(img, m.w, m.h);
}
async function probeVideo(m) {
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = m.url;
  const ev = await once(v, ['loadedmetadata', 'error'], 20000);
  if (!ev || ev.type === 'error') throw new Error('unreadable');
  // Recordings straight out of MediaRecorder often report an infinite
  // duration until the browser has been made to look at the end of the file.
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await once(v, ['durationchange', 'seeked'], 6000);
    if (!isFinite(v.duration)) await once(v, ['durationchange'], 4000);
    v.currentTime = 0;
    await once(v, ['seeked'], 3000);
  }
  if (!isFinite(v.duration) || !(v.duration > 0)) throw new Error('no duration');
  m.dur = v.duration;
  if (!v.videoWidth) { m.type = 'audio'; v.removeAttribute('src'); v.load(); return; }
  m.w = v.videoWidth;
  m.h = v.videoHeight;
  v.currentTime = Math.min(1, m.dur * 0.1);
  await once(v, ['seeked'], 5000);
  if (v.readyState < 2) await once(v, ['loadeddata', 'canplay'], 3000);
  try { m.thumb = thumbFrom(v, m.w, m.h); } catch (err) {}
  v.removeAttribute('src');
  v.load();
}
async function probeAudio(m) {
  const a = document.createElement('audio');
  a.preload = 'metadata';
  a.src = m.url;
  const ev = await once(a, ['loadedmetadata', 'error'], 20000);
  if (!ev || ev.type === 'error') throw new Error('unreadable');
  if (!isFinite(a.duration)) {
    a.currentTime = 1e7;
    await once(a, ['durationchange', 'seeked'], 6000);
  }
  if (!isFinite(a.duration) || !(a.duration > 0)) throw new Error('no duration');
  m.dur = a.duration;
  a.removeAttribute('src');
  a.load();
}
// A waveform picture of the whole file, which timeline clips crop into by
// background position. Also tells us whether a video has any sound at all.
async function makeWave(m) {
  if (m.file.size > 400e6 || !actx) return;
  let ab;
  try {
    const buf = await m.file.arrayBuffer();
    ab = await new Promise((res, rej) => {
      const p = actx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  } catch (err) {
    if (m.type === 'video') m.hasAudio = false;
    return;
  }
  const cols = clamp(Math.round(ab.duration * 40), 60, 8000);
  const ch = [];
  for (let i = 0; i < ab.numberOfChannels; i++) ch.push(ab.getChannelData(i));
  const per = ab.length / cols;
  const peaks = new Float32Array(cols);
  let top = 0;
  for (let x = 0; x < cols; x++) {
    let mx = 0;
    const a = Math.floor(x * per), b = Math.min(ab.length, Math.floor((x + 1) * per));
    const step = Math.max(1, Math.floor((b - a) / 400));
    for (const d of ch) for (let i = a; i < b; i += step) { const v = Math.abs(d[i]); if (v > mx) mx = v; }
    peaks[x] = mx;
    if (mx > top) top = mx;
  }
  m.hasAudio = top > 0.002;
  if (!m.hasAudio) return;
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = 60;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,.55)';
  for (let x = 0; x < cols; x++) {
    const hh = Math.max(1, Math.sqrt(peaks[x] / top) * 26);
    g.fillRect(x, 32 - hh, 1, hh * 2);
  }
  m.wave = c.toDataURL('image/png');
}

// ---------------------------------------------------------------- placing clips
function othersOn(trackId, exceptId) {
  return P.clips.filter(c => c.track === trackId && c.id !== exceptId).sort((a, b) => a.start - b.start);
}
// The nearest start to `want` on `trackId` where `c` fits without overlapping
// anything. There's always an answer: the gap after the last clip is endless.
function fitOnTrack(c, trackId, want) {
  const others = othersOn(trackId, c.id);
  let best = null, lo = 0;
  const consider = (a, b) => {
    if (b - a < c.dur - 1e-6) return;
    const s = clamp(want, a, b - c.dur);
    if (best === null || Math.abs(s - want) < Math.abs(best - want)) best = s;
  };
  for (const o of others) { consider(lo, o.start); lo = Math.max(lo, endOf(o)); }
  consider(lo, Infinity);
  return best;
}
const freeAt = (trackId, a, b, exceptId) => othersOn(trackId, exceptId).every(o => endOf(o) <= a + 1e-6 || o.start >= b - 1e-6);
function addTrack(kind, top) {
  const t = { id: nid('t'), kind, hidden: false, muted: false };
  if (kind === 'video') P.tracks.splice(top ? 0 : P.tracks.filter(x => x.kind === 'video').length, 0, t);
  else P.tracks.push(t);
  return t;
}
function bottomVideo() { const v = P.tracks.filter(t => t.kind === 'video'); return v[v.length - 1] || addTrack('video'); }
function firstAudio() { return P.tracks.find(t => t.kind === 'audio') || addTrack('audio'); }

function addMediaClip(m, trackId, start, quiet) {
  const tr = trackId || (m.type === 'audio' ? firstAudio().id : bottomVideo().id);
  const c = baseClip({ type: m.type, mediaId: m.id, track: tr, dur: m.type === 'image' ? IMAGE_DUR : m.dur });
  if (m.type === 'image' && m.w && m.h && Math.abs(m.w / m.h - P.w / P.h) < 0.25) c.fit = 'fill';
  P.clips.push(c);
  c.start = fitOnTrack(c, tr, start == null ? time : start);
  if (!quiet) { sel = c.id; }
  time = endOf(c);
  return c;
}
function addFromBin(m, trackId, start) {
  edit('Add clip', () => {
    const c = addMediaClip(m, trackId, start);
    sel = c.id;
    if (start != null) time = c.start;
  });
  showWelcome();
}
// Overlays (titles) go on the lowest video track above the bottom one that's
// free under the playhead; a new track is made when every one is taken.
function overlayTrack(a, b) {
  const v = P.tracks.filter(t => t.kind === 'video');
  for (let i = v.length - 2; i >= 0; i--) if (freeAt(v[i].id, a, b)) return v[i].id;
  return addTrack('video', true).id;
}
function addTitle() {
  edit('Add title', () => {
    const c = baseClip({ type: 'text', dur: TITLE_DUR, text: 'Your title here', font: 'sans', size: 9, color: '#ffffff', bold: true, italic: false, align: 'center', style: 'shadow', boxColor: '#000000', anim: 'rise', fadeOut: 0.4 });
    c.track = P.clips.length ? overlayTrack(time, time + c.dur) : bottomVideo().id;
    P.clips.push(c);
    c.start = fitOnTrack(c, c.track, time);
    sel = c.id;
    time = c.start;
  });
  showWelcome();
  focusText();
}
function addColor() {
  edit('Add colour', () => {
    const c = baseClip({ type: 'color', dur: 3, color: '#1d2433' });
    c.track = bottomVideo().id;
    P.clips.push(c);
    c.start = fitOnTrack(c, c.track, time);
    sel = c.id;
    time = c.start;
  });
  showWelcome();
}

// ---------------------------------------------------------------- clip operations
function splitClip(c, t) {
  if (t <= c.start + MIN_DUR / 2 || t >= endOf(c) - MIN_DUR / 2) return null;
  const r = Object.assign({}, c, { id: nid('c'), start: t, dur: endOf(c) - t, fadeIn: 0 });
  if (hasSource(c)) r.in = c.in + (t - c.start) * c.speed;
  c.dur = t - c.start;
  c.fadeOut = 0;
  P.clips.push(r);
  return r;
}
function doSplit() {
  const s = selClip();
  const targets = s && isActive(s, time) ? [s] : P.clips.filter(c => isActive(c, time));
  if (!targets.length) { hint('Move the playhead over a clip to split it.'); return; }
  edit('Split', () => {
    let last = null;
    for (const c of targets) last = splitClip(c, time) || last;
    if (last) sel = last.id;
  });
}
function doDelete(ripple) {
  const c = selClip();
  if (!c) return;
  edit(ripple ? 'Ripple delete' : 'Delete', () => {
    P.clips = P.clips.filter(x => x !== c);
    if (ripple) for (const o of P.clips) if (o.track === c.track && o.start >= endOf(c) - 1e-6) o.start -= c.dur;
    sel = null;
  });
  gcEls();
  seek(time);
}
function doDuplicate() {
  const c = selClip();
  if (!c) return;
  edit('Duplicate', () => {
    const d = Object.assign({}, c, { id: nid('c') });
    P.clips.push(d);
    d.start = fitOnTrack(d, d.track, endOf(c));
    sel = d.id;
  });
}
function detachAudio() {
  const c = selClip();
  if (!c || c.type !== 'video') return;
  edit('Detach audio', () => {
    let tr = P.tracks.find(t => t.kind === 'audio' && freeAt(t.id, c.start, endOf(c)));
    if (!tr) tr = addTrack('audio');
    const a = Object.assign({}, c, { id: nid('c'), type: 'audio', track: tr.id });
    P.clips.push(a);
    c.mute = true;
    sel = a.id;
  });
  hint('The sound is now its own clip on an audio track; the video clip was muted.');
}
function sourceLimit(c) {
  if (!hasSource(c)) return Infinity;
  const m = media.get(c.mediaId);
  return m ? (m.dur - c.in) / c.speed : Infinity;
}
function nextStart(c) {
  let n = Infinity;
  for (const o of othersOn(c.track, c.id)) if (o.start >= c.start + 1e-6) n = Math.min(n, o.start);
  return n;
}
function prevEnd(c) {
  let p = 0;
  for (const o of othersOn(c.track, c.id)) if (endOf(o) <= c.start + 1e-6) p = Math.max(p, endOf(o));
  return p;
}
function setDur(c, d) {
  c.dur = clamp(d, MIN_DUR, Math.min(sourceLimit(c), nextStart(c) - c.start));
  c.fadeIn = Math.min(c.fadeIn, c.dur / 2);
  c.fadeOut = Math.min(c.fadeOut, c.dur / 2);
}
function setSpeed(c, s) {
  const d = c.dur * c.speed / s;
  c.speed = s;
  setDur(c, d);
}

// ---------------------------------------------------------------- media bin
const ICONS = {
  video: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
  audio: '<svg class="i" viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  image: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/></svg>',
};
function renderBin() {
  const box = $('media');
  box.textContent = '';
  if (!media.size) {
    const e = h('div', 'binempty', 'Your videos, photos and music appear here.');
    e.append(h('br'));
    const b = h('button', null, 'Import media');
    b.type = 'button';
    b.onclick = () => fileIn.click();
    e.append(b);
    box.append(e);
    return;
  }
  for (const m of media.values()) {
    const it = h('div', 'mitem');
    it.dataset.id = m.id;
    it.title = `${m.name} — drag onto the timeline, or double-click to add at the playhead`;
    const th = h('div', 'th');
    if (m.thumb) th.style.backgroundImage = `url("${m.thumb}")`;
    else if (m.wave) { th.style.backgroundImage = `url("${m.wave}")`; th.style.backgroundSize = '100% 60%'; th.style.backgroundColor = '#12402c'; }
    else th.innerHTML = ICONS[m.type];
    const nm = h('div', 'nm', m.name);
    const meta = h('div', 'meta');
    meta.append(h('span', null, m.type === 'image' ? 'Photo' : m.type === 'audio' ? 'Audio' : 'Video'), h('span', null, m.type === 'image' ? `${m.w}×${m.h}` : short(m.dur)));
    const add = h('button', 'add');
    add.type = 'button';
    add.title = 'Add at the playhead';
    add.setAttribute('aria-label', `Add ${m.name} to the timeline`);
    add.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    add.onclick = e => { e.stopPropagation(); addFromBin(m); };
    it.ondblclick = () => addFromBin(m);
    it.append(th, nm, meta, add);
    it.addEventListener('pointerdown', e => binDrag(e, m));
    box.append(it);
  }
}

function laneAt(x, y) {
  const e = document.elementFromPoint(x, y);
  return e && e.closest ? e.closest('.lane') : null;
}
function binDrag(e, m) {
  if (e.button !== 0 || e.target.closest('.add')) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost = null, over = null;
  const kind = kindOf(m.type);
  const move = ev => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      ghost = h('div', null, m.name);
      ghost.id = 'ghost';
      document.body.append(ghost);
      document.body.classList.remove('show-bin');
    }
    ghost.style.left = ev.clientX + 'px';
    ghost.style.top = ev.clientY + 'px';
    const l = laneAt(ev.clientX, ev.clientY);
    const ok = l && trackById(l.dataset.track) && trackById(l.dataset.track).kind === kind ? l : null;
    if (over !== ok) { if (over) over.classList.remove('drop'); over = ok; if (over) over.classList.add('drop'); }
  };
  const up = ev => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!ghost) return;
    ghost.remove();
    if (over) {
      over.classList.remove('drop');
      const t = (ev.clientX - over.getBoundingClientRect().left) / pps;
      addFromBin(m, over.dataset.track, Math.max(0, t));
    } else if (ev.type === 'pointerup' && ev.target.closest && ev.target.closest('#screen')) {
      addFromBin(m);
    }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

// ---------------------------------------------------------------- timeline
const tlScroll = $('tlScroll'), tlInner = $('tlInner'), tracksEl = $('tracks');
const ruler = $('ruler'), rctx = ruler.getContext('2d');
let HEAD = 112;
const headPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head')) || 112;
const zoomToPps = v => 4 * Math.pow(100, v / 1000);
const ppsToZoom = p => Math.round(Math.log(p / 4) / Math.log(100) * 1000);

const SVG_EYE = '<svg class="i" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const SVG_EYE_OFF = '<svg class="i" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>';
const SVG_SPK = '<svg class="i" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
const SVG_SPK_OFF = '<svg class="i" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m17 9 5 6M22 9l-5 6"/></svg>';
const SVG_X = '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function trackName(t) {
  const same = P.tracks.filter(x => x.kind === t.kind);
  const i = same.indexOf(t);
  return t.kind === 'video' ? 'V' + (same.length - i) : 'A' + (i + 1);
}
function iconBtn(svg, title, on, fn) {
  const b = h('button', on ? 'off' : null);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg;
  b.onclick = e => { e.stopPropagation(); fn(); };
  return b;
}
function clipLabel(c) {
  if (c.type === 'text') return (c.text || '').split('\n')[0] || 'Title';
  if (c.type === 'color') return 'Colour';
  const m = media.get(c.mediaId);
  return m ? m.name : 'Missing media';
}

let dragId = null;
function renderTimeline() {
  HEAD = headPx();
  const end = projectEnd();
  const laneW = Math.max(tlScroll.clientWidth - HEAD, (end + 30) * pps);
  tlInner.style.width = HEAD + laneW + 'px';
  tracksEl.textContent = '';
  for (const t of P.tracks) {
    const row = h('div', 'trow ' + t.kind);
    const head = h('div', 'thead');
    head.append(h('span', 'tn', trackName(t)));
    if (t.kind === 'video') {
      head.append(iconBtn(t.hidden ? SVG_EYE_OFF : SVG_EYE, t.hidden ? 'Show track' : 'Hide track', t.hidden, () => edit(t.hidden ? 'Show track' : 'Hide track', () => { t.hidden = !t.hidden; })));
    }
    head.append(iconBtn(t.muted ? SVG_SPK_OFF : SVG_SPK, t.muted ? 'Unmute track' : 'Mute track', t.muted, () => edit(t.muted ? 'Unmute track' : 'Mute track', () => { t.muted = !t.muted; })));
    const empty = !P.clips.some(c => c.track === t.id);
    if (empty && P.tracks.filter(x => x.kind === t.kind).length > 1) {
      const rm = iconBtn(SVG_X, 'Remove this empty track', false, () => edit('Remove track', () => { P.tracks = P.tracks.filter(x => x !== t); }));
      rm.classList.add('rm');
      head.append(rm);
    }
    const lane = h('div', 'lane');
    lane.dataset.track = t.id;
    for (const c of P.clips) if (c.track === t.id) lane.append(clipEl(c, t));
    row.append(head, lane);
    tracksEl.append(row);
  }
  if (!P.clips.length) tracksEl.append(h('div', 'tlempty', 'Drag media here, or press + on a thumbnail. Titles and colour cards are under the Media panel.'));
  drawRuler();
  updatePlayhead();
  updateButtons();
}
function clipEl(c, t) {
  const m = media.get(c.mediaId);
  const e = h('div', `clip ${c.type}${c.id === sel ? ' sel' : ''}${c.id === dragId ? ' dragging' : ''}${t.hidden ? ' hidden' : ''}`);
  e.dataset.id = c.id;
  e.style.left = c.start * pps + 'px';
  e.style.width = Math.max(2, c.dur * pps) + 'px';
  if ((c.type === 'video' || c.type === 'image') && m && m.thumb) e.style.backgroundImage = `url("${m.thumb}")`;
  if (c.type === 'audio' && m && m.wave) {
    e.style.backgroundImage = `url("${m.wave}")`;
    e.style.backgroundSize = `${m.dur / c.speed * pps}px 100%`;
    e.style.backgroundPosition = `${-c.in / c.speed * pps}px 0`;
  }
  if (c.type === 'color') e.style.backgroundColor = c.color;
  const lbl = h('div', 'lbl', clipLabel(c));
  const extra = [short(c.dur)];
  if (c.speed !== 1) extra.push(c.speed + '×');
  if (c.mute) extra.push('muted');
  lbl.append(h('small', null, extra.join(' · ')));
  e.append(lbl);
  if (c.fadeIn > 0) { const f = h('div', 'fade in'); f.style.width = c.fadeIn * pps + 'px'; e.append(f); }
  if (c.fadeOut > 0) { const f = h('div', 'fade out'); f.style.width = c.fadeOut * pps + 'px'; e.append(f); }
  e.append(h('div', 'h l'), h('div', 'h r'));
  e.title = `${clipLabel(c)} — drag to move, drag the edges to trim`;
  return e;
}

function drawRuler() {
  const w = Math.max(1, tlScroll.clientWidth - HEAD);
  const dpr = window.devicePixelRatio || 1;
  if (ruler.width !== Math.round(w * dpr)) { ruler.width = Math.round(w * dpr); ruler.height = Math.round(26 * dpr); }
  ruler.style.width = w + 'px';
  ruler.style.height = '26px';
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.clearRect(0, 0, w, 26);
  const steps = [1 / P.fps, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  const step = steps.find(s => s * pps >= 64) || 1200;
  const minor = step >= 1 && step % 5 === 0 ? step / 5 : step / 2;
  const sl = tlScroll.scrollLeft;
  const t0 = sl / pps, t1 = (sl + w) / pps;
  rctx.strokeStyle = '#4a5062';
  rctx.fillStyle = '#99a0b4';
  rctx.font = '10.5px -apple-system, "Segoe UI", Roboto, sans-serif';
  rctx.textBaseline = 'top';
  rctx.beginPath();
  for (let i = Math.floor(t0 / minor); i * minor <= t1; i++) {
    const t = i * minor;
    const x = Math.round(t * pps - sl) + 0.5;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    rctx.moveTo(x, major ? 12 : 19);
    rctx.lineTo(x, 26);
    if (major) {
      const s = Math.floor(t + 1e-6);
      rctx.fillText(step < 1 ? `${Math.floor(s / 60)}:${(t % 60 + 1e-6).toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, '0')}` : `${Math.floor(s / 60)}:${pad(s % 60)}`, x + 3, 2);
    }
  }
  rctx.stroke();
  const e = projectEnd();
  if (e > 0) {
    const x = e * pps - sl;
    rctx.fillStyle = 'rgba(0,176,236,.18)';
    rctx.fillRect(Math.max(0, -sl), 22, Math.max(0, x - Math.max(0, -sl)), 4);
  }
}
function updatePlayhead() {
  $('playhead').style.transform = `translateX(${time * pps}px)`;
}
function follow() {
  const x = time * pps;
  const w = tlScroll.clientWidth - HEAD;
  if (x < tlScroll.scrollLeft || x > tlScroll.scrollLeft + w - 30) tlScroll.scrollLeft = Math.max(0, x - 60);
}
function setZoom(p, anchorTime) {
  const at = anchorTime == null ? time : anchorTime;
  const screenX = at * pps - tlScroll.scrollLeft;
  pps = clamp(p, 4, 400);
  $('zoom').value = ppsToZoom(pps);
  renderTimeline();
  tlScroll.scrollLeft = Math.max(0, at * pps - screenX);
  drawRuler();
}
function fitTimeline() {
  const e = projectEnd();
  const w = tlScroll.clientWidth - HEAD - 40;
  setZoom(e > 0 ? w / e : 60, 0);
  tlScroll.scrollLeft = 0;
  drawRuler();
}
const timeAtX = x => (x - tlInner.getBoundingClientRect().left - HEAD) / pps;

function scrub(e) {
  if (playing) pause();
  const go = ev => { seek(timeAtX(ev.clientX)); };
  go(e);
  const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  addEventListener('pointermove', go);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}
ruler.addEventListener('pointerdown', e => { e.preventDefault(); scrub(e); });

function snapPoints(exceptId) {
  const pts = [0, time];
  for (const c of P.clips) if (c.id !== exceptId) pts.push(c.start, endOf(c));
  return pts;
}
function snapTo(cands, pts) {
  if (!snapOn) return null;
  const thr = 8 / pps;
  let best = null;
  for (const v of cands) for (const p of pts) {
    const d = p - v;
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t: p };
  }
  return best;
}
function showSnap(t) {
  const s = $('snapline');
  if (t == null) { s.hidden = true; return; }
  s.hidden = false;
  s.style.left = HEAD + t * pps + 'px';
}

tracksEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('.thead')) return;
  const ce = e.target.closest('.clip');
  if (ce) {
    e.preventDefault();
    const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
    clipDrag(e, clipById(ce.dataset.id), mode);
    return;
  }
  if (e.target.closest('.lane')) {
    e.preventDefault();
    if (sel) { sel = null; renderTimeline(); renderInspector(); }
    scrub(e);
  }
});

function clipDrag(e, c, mode) {
  if (!c) return;
  if (playing && mode !== 'move') pause();
  if (sel !== c.id) { sel = c.id; renderTimeline(); renderInspector(); dirty = true; }
  const s0 = snap();
  const o = { start: c.start, dur: c.dur, in: c.in, track: c.track };
  const lo = prevEnd(c), hi = nextStart(c);
  const srcLo = hasSource(c) ? o.start - o.in / c.speed : -Infinity;
  const srcHi = hasSource(c) ? o.start + sourceLimit(c) : Infinity;
  const pts = snapPoints(c.id);
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  const move = ev => {
    if (!moved) {
      if (Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      moved = true;
      dragId = c.id;
    }
    const dx = (ev.clientX - x0) / pps;
    let sn = null;
    if (mode === 'move') {
      const l = laneAt(ev.clientX, ev.clientY);
      const t = l && trackById(l.dataset.track);
      if (t && t.kind === kindOf(c.type)) c.track = t.id;
      let st = Math.max(0, o.start + dx);
      sn = snapTo([st, st + o.dur], pts);
      if (sn) st = Math.max(0, st + sn.d);
      c.start = fitOnTrack(c, c.track, st);
      if (sn && Math.abs(c.start - st) > 1e-6) sn = null;
    } else if (mode === 'l') {
      let st = o.start + dx;
      sn = snapTo([st], pts);
      if (sn) st += sn.d;
      st = clamp(st, Math.max(lo, srcLo, 0), o.start + o.dur - MIN_DUR);
      if (sn && Math.abs(st - sn.t) > 1e-6) sn = null;
      c.start = st;
      c.dur = o.start + o.dur - st;
      if (hasSource(c)) c.in = o.in + (st - o.start) * c.speed;
      time = c.start;
    } else {
      let en = o.start + o.dur + dx;
      sn = snapTo([en], pts);
      if (sn) en += sn.d;
      en = clamp(en, o.start + MIN_DUR, Math.min(hi, srcHi));
      if (sn && Math.abs(en - sn.t) > 1e-6) sn = null;
      c.dur = en - o.start;
      time = Math.max(c.start, en - frameDur());
    }
    c.fadeIn = Math.min(c.fadeIn, c.dur / 2);
    c.fadeOut = Math.min(c.fadeOut, c.dur / 2);
    showSnap(sn ? sn.t : null);
    renderTimeline();
    dirty = true;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    dragId = null;
    showSnap(null);
    if (moved) pushUndo(s0, mode === 'move' ? 'Move clip' : 'Trim clip');
    renderAll();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

tlScroll.addEventListener('scroll', drawRuler);
tlScroll.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(pps * Math.exp(-e.deltaY * 0.004), timeAtX(e.clientX));
}, { passive: false });
$('zoom').addEventListener('input', e => setZoom(zoomToPps(+e.target.value)));
$('tFit').onclick = fitTimeline;

// ---------------------------------------------------------------- dragging in the preview
function toProject(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * P.w, y: (e.clientY - r.top) / r.height * P.h };
}
function hitTest(p) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    const dx = p.x - b.cx, dy = p.y - b.cy;
    const lx = dx * Math.cos(-b.rot) - dy * Math.sin(-b.rot), ly = dx * Math.sin(-b.rot) + dy * Math.cos(-b.rot);
    if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return clipById(b.id);
  }
  return null;
}
view.addEventListener('pointerdown', e => {
  if (e.button !== 0 || exporting) return;
  const p0 = toProject(e);
  const c = hitTest(p0);
  if (!c) { if (sel) { sel = null; renderAll(); } return; }
  e.preventDefault();
  if (sel !== c.id) { sel = c.id; renderAll(); }
  if (c.type === 'color') return;
  const s0 = snap(), ox = c.x, oy = c.y;
  let moved = false;
  const move = ev => {
    const p = toProject(ev);
    moved = true;
    let x = ox + (p.x - p0.x) / P.w, y = oy + (p.y - p0.y) / P.h;
    if (Math.abs(x) < 0.012) x = 0;
    if (Math.abs(y) < 0.012) y = 0;
    c.x = x; c.y = y;
    dirty = true;
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (moved) { pushUndo(s0, 'Move in frame'); renderInspector(); }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
});
let wheelTimer = 0;
view.addEventListener('wheel', e => {
  const c = selClip();
  if (!c || !VISUAL.has(c.type) || c.type === 'color' || !isActive(c, time)) return;
  e.preventDefault();
  begin();
  c.scale = clamp(c.scale * Math.exp(-e.deltaY * 0.0015), 0.05, 8);
  dirty = true;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { end('Resize'); renderInspector(); }, 350);
}, { passive: false });
view.addEventListener('dblclick', e => {
  const c = hitTest(toProject(e));
  if (c && c.type === 'text') focusText();
});
function focusText() {
  document.body.classList.add('show-insp');
  setTimeout(() => { const t = $('txtIn'); if (t) { t.focus(); t.select(); } }, 30);
}

// ---------------------------------------------------------------- inspector
function section(box, title) {
  const s = h('div', 'sec');
  if (title) s.append(h('h3', null, title));
  box.append(s);
  return s;
}
function row(s, label, ...kids) {
  const r = h('label', 'row' + (kids.length < 2 ? ' two' : ''));
  r.append(h('span', null, label), ...kids);
  s.append(r);
  return r;
}
function slider(s, label, get, set, { min, max, step = 1, fmt = v => v, def, tl, lbl }) {
  const r = h('input');
  r.type = 'range';
  r.min = min; r.max = max; r.step = step;
  r.value = get();
  const o = h('output', null, fmt(get()));
  r.oninput = () => { begin(); set(+r.value); o.textContent = fmt(+r.value); dirty = true; if (tl) renderTimeline(); };
  r.onchange = () => end(lbl || label);
  if (def != null) {
    r.title = 'Double-click to reset';
    r.ondblclick = () => { begin(); set(def); r.value = def; o.textContent = fmt(def); dirty = true; end(lbl || label); if (tl) renderTimeline(); };
  }
  row(s, label, r, o);
  return r;
}
function seg(s, label, opts, get, set) {
  const g = h('div', 'seg');
  for (const [v, t] of opts) {
    const b = h('button', get() === v ? 'on' : null, t);
    b.type = 'button';
    b.onclick = e => { e.preventDefault(); edit(label, () => set(v)); };
    g.append(b);
  }
  if (label) row(s, label, g); else s.append(g);
  return g;
}
function select(s, label, opts, get, set) {
  const sel_ = h('select');
  for (const [v, t] of opts) { const o = h('option', null, t); o.value = v; sel_.append(o); }
  sel_.value = String(get());
  sel_.onchange = () => edit(label, () => set(sel_.value));
  row(s, label, sel_);
  return sel_;
}
function color(s, label, get, set) {
  const i = h('input');
  i.type = 'color';
  i.value = get();
  i.oninput = () => { begin(); set(i.value); dirty = true; if (label === 'Colour') renderTimeline(); };
  i.onchange = () => end(label);
  row(s, label, i);
  return i;
}
function buttons(s, list) {
  const b = h('div', 'ibtns');
  for (const [t, fn, cls, title] of list) {
    const x = h('button', cls || null, t);
    x.type = 'button';
    if (title) x.title = title;
    x.onclick = fn;
    b.append(x);
  }
  s.append(b);
}
const pct = v => Math.round(v * 100) + '%';
const secs = v => (+v).toFixed(1) + 's';

function renderInspector() {
  const box = $('insp');
  const keep = box.scrollTop;
  box.textContent = '';
  const c = selClip();
  if (!c) { $('inspHead').textContent = 'Project'; projectPanel(box); return; }
  const m = media.get(c.mediaId);
  $('inspHead').textContent = { video: 'Video clip', image: 'Photo', audio: 'Audio clip', text: 'Title', color: 'Colour card' }[c.type];

  if (c.type === 'text') {
    const s = section(box, 'Text');
    const ta = h('textarea');
    ta.id = 'txtIn';
    ta.rows = 3;
    ta.value = c.text;
    ta.spellcheck = true;
    ta.oninput = () => { begin(); c.text = ta.value; dirty = true; renderTimeline(); };
    ta.onchange = () => end('Edit text');
    ta.onblur = () => end('Edit text');
    s.append(ta);
    select(s, 'Font', Object.entries(FONTS).map(([k, v]) => [k, v[0]]), () => c.font, v => { c.font = v; });
    slider(s, 'Size', () => c.size, v => { c.size = v; }, { min: 2, max: 30, step: 0.5, fmt: v => (+v).toFixed(1), def: 9 });
    color(s, 'Colour', () => c.color, v => { c.color = v; });
    seg(s, 'Weight', [[false, 'Regular'], [true, 'Bold']], () => c.bold, v => { c.bold = v; });
    seg(s, 'Slant', [[false, 'Upright'], [true, 'Italic']], () => c.italic, v => { c.italic = v; });
    seg(s, 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], () => c.align, v => { c.align = v; });
    seg(s, 'Style', [['plain', 'Plain'], ['shadow', 'Shadow'], ['outline', 'Outline'], ['box', 'Box']], () => c.style, v => { c.style = v; });
    if (c.style === 'outline' || c.style === 'box') color(s, c.style === 'box' ? 'Box colour' : 'Outline', () => c.boxColor, v => { c.boxColor = v; });
    select(s, 'Animation', [['none', 'None'], ['rise', 'Rise in'], ['pop', 'Pop in'], ['type', 'Typewriter']], () => c.anim, v => { c.anim = v; });
  }
  if (c.type === 'color') {
    const s = section(box, 'Colour');
    color(s, 'Colour', () => c.color, v => { c.color = v; });
  }

  // timing
  {
    const s = section(box, 'Timing');
    const d = h('input');
    d.type = 'number';
    d.min = MIN_DUR; d.step = 0.1;
    d.value = c.dur.toFixed(2);
    d.onchange = () => { const v = parseFloat(d.value); if (v > 0) edit('Duration', () => setDur(c, v)); };
    row(s, 'Duration', d);
    row(s, 'Starts at', h('span', null, tc(c.start)));
    if (hasSource(c)) {
      select(s, 'Speed', SPEEDS.map(v => [String(v), v + '×']), () => String(c.speed), v => setSpeed(c, +v));
      if (m) row(s, 'Source', h('span', null, `${short(c.in)} – ${short(c.in + c.dur * c.speed)} of ${short(m.dur)}`));
    }
    const fmax = Math.max(0.1, Math.min(5, c.dur / 2));
    slider(s, 'Fade in', () => c.fadeIn, v => { c.fadeIn = Math.min(v, c.dur / 2); }, { min: 0, max: fmax, step: 0.1, fmt: secs, def: 0, tl: true });
    slider(s, 'Fade out', () => c.fadeOut, v => { c.fadeOut = Math.min(v, c.dur / 2); }, { min: 0, max: fmax, step: 0.1, fmt: secs, def: 0, tl: true });
  }

  if (c.type === 'video' || c.type === 'audio') {
    const s = section(box, 'Sound');
    if (c.type === 'video' && m && m.hasAudio === false) {
      s.append(h('div', 'inote', 'This video has no sound track.'));
    } else {
      slider(s, 'Volume', () => c.volume, v => { c.volume = v; }, { min: 0, max: 2, step: 0.01, fmt: pct, def: 1 });
      if (c.type === 'video') {
        seg(s, 'Sound', [[false, 'On'], [true, 'Muted']], () => c.mute, v => { c.mute = v; });
        buttons(s, [['Detach audio', detachAudio, null, 'Move this clip’s sound to its own audio track']]);
      }
    }
  }

  if (VISUAL.has(c.type) && c.type !== 'color') {
    const s = section(box, 'Position');
    if (c.type !== 'text') seg(s, 'Frame', [['fit', 'Fit'], ['fill', 'Fill']], () => c.fit, v => { c.fit = v; });
    slider(s, 'Scale', () => c.scale, v => { c.scale = v; }, { min: 0.1, max: 4, step: 0.01, fmt: pct, def: 1 });
    slider(s, 'Left/right', () => c.x, v => { c.x = v; }, { min: -1, max: 1, step: 0.005, fmt: v => Math.round(v * 100), def: 0, lbl: 'Move' });
    slider(s, 'Up/down', () => c.y, v => { c.y = v; }, { min: -1, max: 1, step: 0.005, fmt: v => Math.round(v * 100), def: 0, lbl: 'Move' });
    slider(s, 'Rotate', () => c.rot, v => { c.rot = v; }, { min: -180, max: 180, step: 1, fmt: v => v + '°', def: 0 });
    if (c.type !== 'text') {
      seg(s, 'Mirror', [[false, 'Off'], [true, 'Flipped']], () => c.flip, v => { c.flip = v; });
      select(s, 'Motion', [['none', 'None'], ['in', 'Slow zoom in'], ['out', 'Slow zoom out']], () => c.motion, v => { c.motion = v; });
    }
    buttons(s, [['Reset position', () => edit('Reset position', () => Object.assign(c, { x: 0, y: 0, scale: 1, rot: 0, flip: false }))]]);
    s.append(h('div', 'inote', 'Tip: drag it in the preview to move it, scroll over the preview to resize.'));
  }

  if (VISUAL.has(c.type)) {
    const s = section(box, 'Look');
    slider(s, 'Opacity', () => c.opacity, v => { c.opacity = v; }, { min: 0, max: 1, step: 0.01, fmt: pct, def: 1 });
    if (c.type === 'video' || c.type === 'image') {
      slider(s, 'Brightness', () => c.bright, v => { c.bright = v; }, { min: -100, max: 100, fmt: v => v, def: 0 });
      slider(s, 'Contrast', () => c.contrast, v => { c.contrast = v; }, { min: -100, max: 100, fmt: v => v, def: 0 });
      slider(s, 'Saturation', () => c.sat, v => { c.sat = v; }, { min: -100, max: 100, fmt: v => v, def: 0 });
      slider(s, 'Blur', () => c.blur, v => { c.blur = v; }, { min: 0, max: 30, step: 0.5, fmt: v => v, def: 0 });
      seg(s, 'Colour', [[false, 'Colour'], [true, 'Black & white']], () => c.bw, v => { c.bw = v; });
      buttons(s, [
        ['Warm', () => edit('Look', () => Object.assign(c, { bright: 4, contrast: 8, sat: 18, bw: false })), null, 'A little brighter and richer'],
        ['Punchy', () => edit('Look', () => Object.assign(c, { bright: 0, contrast: 25, sat: 30, bw: false }))],
        ['Faded', () => edit('Look', () => Object.assign(c, { bright: 8, contrast: -22, sat: -30, bw: false }))],
        ['Noir', () => edit('Look', () => Object.assign(c, { bright: -4, contrast: 35, sat: 0, bw: true }))],
        ['Reset', () => edit('Look', () => Object.assign(c, { bright: 0, contrast: 0, sat: 0, blur: 0, bw: false }))],
      ]);
    }
  }

  const s = section(box, 'Clip');
  buttons(s, [
    ['Split at playhead', doSplit, null, 'S'],
    ['Duplicate', doDuplicate, null, 'Ctrl+D'],
    ['Delete', () => doDelete(false), 'danger', 'Delete'],
  ]);
  if (m) s.append(h('div', 'inote', m.name + (m.w ? ` · ${m.w}×${m.h}` : '')));
  box.scrollTop = keep;
}

function projectPanel(box) {
  const s = section(box, 'Frame');
  select(s, 'Size', FORMATS.map(f => [f.id, `${f.label} — ${f.w}×${f.h}`]), () => P.fmt, v => setFormat(v));
  select(s, 'Frame rate', [['24', '24 fps — film'], ['25', '25 fps'], ['30', '30 fps — standard'], ['60', '60 fps — smooth']], () => String(P.fps), v => { P.fps = +v; });
  color(s, 'Background', () => P.bg, v => { P.bg = v; });
  const n = h('div', 'inote');
  n.innerHTML = 'Select a clip on the timeline to trim it, change its speed, volume, fades, position and colour. <b>Nothing is uploaded</b> — the whole edit happens on this device.';
  box.append(n);
  const k = section(box, 'Shortcuts');
  const g = h('div', 'keys');
  for (const [a, b] of [['Space', 'Play / pause'], ['S', 'Split at playhead'], ['Del', 'Delete clip'], ['⇧ Del', 'Delete and close the gap'], ['Ctrl D', 'Duplicate'], ['Ctrl Z', 'Undo'], ['← →', 'One frame (⇧ one second)'], ['↑ ↓', 'Previous / next cut'], ['Home End', 'Start / end'], ['+ −', 'Zoom timeline'], ['N', 'Snapping on/off']]) {
    g.append(h('kbd', null, a), h('span', null, b));
  }
  k.append(g);
}
function setFormat(id) {
  const f = FORMATS.find(x => x.id === id);
  if (!f) return;
  P.fmt = f.id; P.w = f.w; P.h = f.h;
}

// ---------------------------------------------------------------- menus
function menu(anchor, items) {
  closeMenu();
  const m = h('div', 'menu');
  m.id = 'menu';
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    if (it.sub) { m.append(h('div', 'sub', it.sub)); continue; }
    const b = h('button', it.on ? 'on' : null);
    b.type = 'button';
    const l = h('span', null, it.label);
    if (it.note) { l.append(h('br')); const s = h('small', null, it.note); s.style.color = 'var(--faint)'; l.append(s); }
    b.append(l);
    b.onclick = () => { closeMenu(); it.fn(); };
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = r.bottom + 6 + 'px';
  m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
  setTimeout(() => addEventListener('pointerdown', outside), 0);
}
function outside(e) { if (!e.target.closest('#menu')) closeMenu(); }
function closeMenu() { const m = $('menu'); if (m) m.remove(); removeEventListener('pointerdown', outside); }
$('formatBtn').onclick = e => menu(e.currentTarget, FORMATS.map(f => ({ label: `${f.label}`, note: `${f.w}×${f.h} · ${f.sub}`, on: P.fmt === f.id, fn: () => edit('Frame size', () => setFormat(f.id)) })));

// ---------------------------------------------------------------- export
const FORMATS_OUT = [
  { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264)' },
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4', label: 'MP4 (H.264)' },
  { mime: 'video/mp4;codecs=avc1,mp4a', ext: 'mp4', label: 'MP4 (H.264)' },
  { mime: 'video/mp4', ext: 'mp4', label: 'MP4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm', label: 'WebM (VP9)' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm', label: 'WebM (VP8)' },
  { mime: 'video/webm', ext: 'webm', label: 'WebM' },
];
function outFormats() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return [];
  const got = [];
  for (const f of FORMATS_OUT) {
    if (got.some(g => g.ext === f.ext)) continue;
    try { if (MediaRecorder.isTypeSupported(f.mime)) got.push(f); } catch (err) {}
  }
  return got;
}
function dialog(title) {
  const scrim = h('div', 'scrim');
  const d = h('div', 'dlg');
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-label', title);
  d.append(h('h2', null, title));
  const body = h('div', 'body');
  const foot = h('div', 'foot');
  d.append(body, foot);
  scrim.append(d);
  document.body.append(scrim);
  return { scrim, body, foot, close: () => scrim.remove() };
}
function openExport() {
  if (exporting) return;
  if (!P.clips.length) { toast('Add something to the timeline first.'); return; }
  pause();
  const fmts = outFormats();
  const canvasOk = !!view.captureStream;
  const d = dialog('Export video');
  if (!fmts.length || !canvasOk) {
    d.body.append(h('p', 'note', 'This browser can’t record video from a web page. Export works in current Chrome, Edge, Firefox and Safari — please open this page in one of those.'));
    const b = h('button', null, 'Close'); b.onclick = d.close; d.foot.append(b);
    return;
  }
  const f = h('select');
  fmts.forEach((x, i) => { const o = h('option', null, x.label); o.value = i; f.append(o); });
  const r = h('select');
  const short_ = Math.min(P.w, P.h);
  const res = [[1, `Full — ${P.w}×${P.h}`]];
  if (short_ > 720) res.push([720 / short_, `720p — ${even(P.w * 720 / short_)}×${even(P.h * 720 / short_)}`]);
  if (short_ > 480) res.push([480 / short_, `480p — ${even(P.w * 480 / short_)}×${even(P.h * 480 / short_)}`]);
  res.forEach(([v, t]) => { const o = h('option', null, t); o.value = v; r.append(o); });
  const q = h('select');
  [['8', 'Standard'], ['16', 'High — bigger file'], ['4', 'Small — for email']].forEach(([v, t]) => { const o = h('option', null, t); o.value = v; q.append(o); });
  const len = projectEnd();
  const rows = [['Format', f], ['Size', r], ['Quality', q]];
  for (const [l, e] of rows) { const x = h('label', 'row'); x.append(h('span', null, l), e); d.body.append(x); }
  d.body.append(h('p', 'note', `Your ${short(len)} video is recorded by playing it through once, so export takes ${short(len)}. Keep this tab open and in front until it finishes — switching away stops it. Speakers are muted while it records.`));
  if (!fmts.some(x => x.ext === 'mp4')) d.body.append(h('p', 'note', 'This browser can only make WebM files. They play in Chrome, Firefox, VLC and on YouTube; for an MP4, export from Chrome, Edge or Safari.'));
  const cancel = h('button', null, 'Cancel'); cancel.type = 'button'; cancel.onclick = d.close;
  const go = h('button', 'ok', 'Export'); go.type = 'button';
  go.onclick = () => { d.close(); runExport(fmts[+f.value], +r.value, +q.value); };
  d.foot.append(cancel, go);
}

async function waitReady(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    syncMedia();
    const busy = P.clips.some(c => {
      const e = els.get(c.id);
      return e && isActive(c, time) && (e.el.seeking || e.el.readyState < 2);
    });
    if (!busy) return;
    await sleep(40);
  }
}

async function runExport(fmt, scale, mbps) {
  const len = projectEnd();
  const d = dialog('Exporting…');
  const bar = h('div', 'bar'); const fill = h('i'); bar.append(fill);
  const info = h('p', 'note', 'Getting ready…');
  d.body.append(bar, info);
  const stopBtn = h('button', null, 'Cancel'); stopBtn.type = 'button';
  d.foot.append(stopBtn);
  const ex = exporting = { cancelled: false };
  sel = null;
  renderAll();
  audio();
  for (const e of els.values()) hookAudio(e);
  sizeCanvas(scale);
  const pixels = view.width * view.height;
  const stream = view.captureStream(P.fps);
  let dest = null;
  if (actx) {
    dest = actx.createMediaStreamDestination();
    master.connect(dest);
    speakers.gain.value = 0;
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  }
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: Math.round(mbps * 1e6 * Math.max(0.25, pixels / 2073600)), audioBitsPerSecond: 192000 });
  } catch (err) {
    cleanup();
    d.close();
    toast('The browser refused to start recording: ' + err.message, true);
    return;
  }
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  const t0 = performance.now();
  ex.progress = k => {
    fill.style.width = (k * 100).toFixed(1) + '%';
    const left = Math.max(0, len - time);
    info.textContent = `Recording ${tc(time)} of ${tc(len)} — about ${short(left)} to go.`;
  };
  const hide = () => { if (document.hidden && exporting === ex) { ex.cancelled = 'hidden'; finishExport(); } };
  document.addEventListener('visibilitychange', hide);
  stopBtn.onclick = () => { ex.cancelled = true; finishExport(); };
  ex.finish = async () => {
    document.removeEventListener('visibilitychange', hide);
    playing = false;
    for (const e of els.values()) e.el.pause();
    if (rec.state !== 'inactive') { try { rec.requestData(); } catch (err) {} rec.stop(); }
    await stopped;
    cleanup();
    d.close();
    if (ex.cancelled) {
      if (ex.cancelled === 'hidden') toast('Export stopped because the tab was switched away. Keep it in front while it records.', true);
      else hint('Export cancelled.');
      return;
    }
    let blob = new Blob(chunks, { type: rec.mimeType || fmt.mime });
    if (fmt.ext === 'webm') blob = await fixWebmDuration(blob, len * 1000);
    done(blob, fmt, performance.now() - t0);
  };
  function cleanup() {
    if (dest) { try { master.disconnect(dest); } catch (err) {} }
    if (speakers) speakers.gain.value = 1;
    stream.getTracks().forEach(t => t.stop());
    exporting = null;
    sizeCanvas();
    seek(0);
    renderAll();
  }

  time = 0;
  dirty = true;
  await waitReady(4000);
  if (ex.cancelled) return;
  render(false);
  rec.start(1000);
  playing = true;
  lastTs = 0;
  updatePlayBtn();
}
function finishExport() {
  const ex = exporting;
  if (!ex || ex.finishing) return;
  ex.finishing = true;
  playing = false;
  updatePlayBtn();
  if (ex.finish) ex.finish();
}
function done(blob, fmt, ms) {
  const d = dialog('Your video is ready');
  const name = `${fileBase()}.${fmt.ext}`;
  const a = h('a', 'dl', `Download ${name}`);
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  d.body.append(a, h('p', 'note', `${(blob.size / 1048576).toFixed(1)} MB · ${fmt.label} · made on this device in ${short(ms / 1000)}. The file only exists in this tab until you download it.`));
  const close = h('button', null, 'Close');
  close.type = 'button';
  close.onclick = () => { d.close(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  d.foot.append(close);
}

// MediaRecorder writes WebM without a duration, so many players can't show
// the length or seek. This adds a Duration element to the Segment Info, which
// sits in the first few hundred bytes; the rest of the file is left untouched.
// If anything about the layout isn't what's expected, the original is kept.
async function fixWebmDuration(blob, ms) {
  try {
    const headLen = Math.min(blob.size, 65536);
    const b = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
    const vint = (p, keepMarker) => {
      const first = b[p];
      let len = 1, mask = 0x80;
      while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
      if (len > 8) throw new Error('bad vint');
      let v = keepMarker ? first : first & (mask - 1);
      for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
      return { v, len };
    };
    let p = 0;
    let id = vint(p, true);
    if (id.v !== 0x1A45DFA3) throw new Error('not EBML');
    p += id.len;
    let sz = vint(p);
    p += sz.len + sz.v;
    id = vint(p, true);
    if (id.v !== 0x18538067) throw new Error('no segment');
    p += id.len;
    p += vint(p).len;
    while (p < headLen - 12) {
      id = vint(p, true);
      const szp = p + id.len;
      sz = vint(szp);
      const cs = szp + sz.len;
      if (id.v === 0x114D9B74) throw new Error('seek head would need rewriting');
      if (id.v === 0x1F43B675) break;
      if (id.v === 0x1549A966) {
        const infoEnd = cs + sz.v;
        if (infoEnd > headLen) throw new Error('info too long');
        let scale = 1e6, durAt = -1, durLen = 0;
        for (let q = cs; q < infoEnd;) {
          const cid = vint(q, true), csz = vint(q + cid.len), dp = q + cid.len + csz.len;
          if (cid.v === 0x2AD7B1) { let s = 0; for (let i = 0; i < csz.v; i++) s = s * 256 + b[dp + i]; scale = s || 1e6; }
          if (cid.v === 0x4489) { durAt = dp; durLen = csz.v; }
          q = dp + csz.v;
        }
        const val = ms * 1e6 / scale;
        if (durAt >= 0) {
          const dv = new DataView(b.buffer);
          if (durLen === 8) dv.setFloat64(durAt, val); else if (durLen === 4) dv.setFloat32(durAt, val); else throw new Error('odd duration');
          return new Blob([b, blob.slice(headLen)], { type: blob.type });
        }
        const newSize = sz.v + 11;
        if (newSize >= Math.pow(2, 7 * sz.len) - 1) throw new Error('size field too short');
        const sb = new Uint8Array(sz.len);
        let v = newSize;
        for (let i = sz.len - 1; i >= 0; i--) { sb[i] = v % 256; v = Math.floor(v / 256); }
        sb[0] |= 0x80 >> (sz.len - 1);
        const du = new Uint8Array(11);
        du[0] = 0x44; du[1] = 0x89; du[2] = 0x88;
        new DataView(du.buffer).setFloat64(3, val);
        return new Blob([b.subarray(0, szp), sb, b.subarray(cs, infoEnd), du, b.subarray(infoEnd), blob.slice(headLen)], { type: blob.type });
      }
      p = cs + sz.v;
    }
  } catch (err) { /* leave the file as recorded */ }
  return blob;
}

function saveFrame() {
  if (!P.clips.length) return;
  pause();
  sizeCanvas(1);
  render(false);
  view.toBlob(b => {
    if (b) download(b, `${fileBase()} ${tc(time).replace(/:/g, '-')}.png`);
    sizeCanvas();
    render();
  }, 'image/png');
}

// ---------------------------------------------------------------- chrome
function updateButtons() {
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
  const c = selClip();
  $('tDel').disabled = $('tRipple').disabled = $('tDup').disabled = !c;
  $('tSplit').disabled = !P.clips.some(x => isActive(x, time));
  $('tMagnet').classList.toggle('on', snapOn);
  $('loopBtn').style.color = looping ? 'var(--accent)' : '';
  $('formatBtn').textContent = P.fmt;
  $('stFmt').textContent = `${P.w} × ${P.h} · ${P.fps} fps`;
}
function showWelcome() {
  $('welcome').hidden = !!(P.clips.length || media.size);
}
function renderAll() {
  if (!exporting) sizeCanvas();
  renderTimeline();
  renderInspector();
  showWelcome();
  dirty = true;
}

$('importBtn').onclick = $('wOpen').onclick = () => fileIn.click();
fileIn.onchange = () => { importFiles(fileIn.files); fileIn.value = ''; };
$('wTitle').onclick = addTitle;
$('addTitle').onclick = addTitle;
$('addColor').onclick = addColor;
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
$('exportBtn').onclick = openExport;
$('playBtn').onclick = toggle;
$('toStart').onclick = () => seek(0);
$('toEnd').onclick = () => seek(projectEnd());
$('stepBack').onclick = () => { pause(); seek(time - frameDur()); };
$('stepFwd').onclick = () => { pause(); seek(time + frameDur()); };
$('loopBtn').onclick = () => { looping = !looping; updateButtons(); hint(looping ? 'Playback will loop.' : 'Loop off.'); };
$('snapBtn').onclick = saveFrame;
$('tSplit').onclick = doSplit;
$('tDel').onclick = () => doDelete(false);
$('tRipple').onclick = () => doDelete(true);
$('tDup').onclick = doDuplicate;
$('tMagnet').onclick = () => { snapOn = !snapOn; updateButtons(); };
$('tAddV').onclick = () => edit('Add track', () => addTrack('video', true));
$('tAddA').onclick = () => edit('Add track', () => addTrack('audio'));
$('projName').onchange = e => { projName = e.target.value; };
$('binToggle').onclick = () => { document.body.classList.remove('show-insp'); document.body.classList.toggle('show-bin'); };
$('inspToggle').onclick = () => { document.body.classList.remove('show-bin'); document.body.classList.toggle('show-insp'); };

// Resizable timeline
$('splitter').addEventListener('pointerdown', e => {
  e.preventDefault();
  const tl = $('timeline');
  const y0 = e.clientY, h0 = tl.offsetHeight;
  const move = ev => { tl.style.height = clamp(h0 - (ev.clientY - y0), 120, innerHeight - 220) + 'px'; fitView(); drawRuler(); };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); renderTimeline(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

// Drop files anywhere
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  importFiles(e.dataTransfer.files);
});

function cutPoints() {
  const s = new Set([0]);
  for (const c of P.clips) { s.add(+c.start.toFixed(4)); s.add(+endOf(c).toFixed(4)); }
  return [...s].sort((a, b) => a - b);
}

addEventListener('keydown', e => {
  if (exporting) return;
  const tag = e.target.tagName;
  const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && !['range', 'checkbox', 'color'].includes(e.target.type)) || tag === 'SELECT';
  if (e.key === 'Escape') { closeMenu(); if (typing) e.target.blur(); else if (sel) { sel = null; renderAll(); } return; }
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'd') { e.preventDefault(); doDuplicate(); return; }
  if (mod && k === 'b') { e.preventDefault(); doSplit(); return; }
  if (mod && k === 'e') { e.preventDefault(); openExport(); return; }
  if (mod && k === 'i') { e.preventDefault(); fileIn.click(); return; }
  if (mod) return;
  if (e.key === ' ') { e.preventDefault(); toggle(); }
  else if (k === 's') doSplit();
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doDelete(e.shiftKey); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); seek(time - (e.shiftKey ? 1 : frameDur())); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); seek(time + (e.shiftKey ? 1 : frameDur())); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pause(); const p = cutPoints().filter(t => t < time - 1e-3).pop(); seek(p || 0); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); pause(); const n = cutPoints().find(t => t > time + 1e-3); if (n != null) seek(n); }
  else if (e.key === 'Home') { e.preventDefault(); seek(0); }
  else if (e.key === 'End') { e.preventDefault(); seek(projectEnd()); }
  else if (k === 'n') { snapOn = !snapOn; updateButtons(); hint(snapOn ? 'Snapping on.' : 'Snapping off.'); }
  else if (e.key === '+' || e.key === '=') setZoom(pps * 1.4);
  else if (e.key === '-' || e.key === '_') setZoom(pps / 1.4);
  else if (k === 'z' && e.shiftKey) fitTimeline();
  else if (k === 't') addTitle();
  else return;
  updateButtons();
});

addEventListener('resize', () => { fitView(); renderTimeline(); });
addEventListener('beforeunload', e => { if (P.clips.length) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- start
$('zoom').value = ppsToZoom(pps);
sizeCanvas();
renderBin();
renderAll();
updatePlayBtn();
requestAnimationFrame(frame);
if (!view.captureStream || !window.MediaRecorder) hint('Heads up: this browser can edit but not export. Use current Chrome, Edge, Firefox or Safari to export.');
else hint('Import media to begin — or drop files anywhere on this page.');

})();
