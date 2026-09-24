/* Linear Design — video and GIF export.
 *
 * Frames are drawn one at a time by the caller (so a 10-second video renders
 * as fast as the machine can go, not in real time) and encoded here:
 *   MP4 — WebCodecs VideoEncoder, H.264 in MP4 via mp4-muxer (vendored, MIT).
 *         Without an H.264 encoder: VP9 in WebM via webm-muxer (MIT). Without
 *         WebCodecs at all: the canvas is recorded in real time (MediaRecorder).
 *   GIF — our own encoder: one median-cut palette sampled across the frames,
 *         4×4 ordered dithering, LZW.
 */
'use strict';
(() => {
const muxers = {};
function loadMuxer(kind) {   // 'mp4' -> Mp4Muxer, 'webm' -> WebMMuxer (both vendored, MIT)
  const global = kind === 'webm' ? 'WebMMuxer' : 'Mp4Muxer';
  if (window[global]) return Promise.resolve(window[global]);
  if (!muxers[kind]) muxers[kind] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = `/design/vendor/mp4/${kind}-muxer.js`; s.onload = () => res(window[global]); s.onerror = () => { delete muxers[kind]; rej(new Error('Couldn’t load the video muxer')); }; document.head.append(s); });
  return muxers[kind];
}
const tick = () => new Promise(r => setTimeout(r, 0));

async function pickCodec(w, h, fps, bitrate) {
  if (!window.VideoEncoder) return null;
  const tries = [['avc1.640033', 'avc'], ['avc1.640028', 'avc'], ['avc1.4d0028', 'avc'], ['avc1.42001f', 'avc'], ['vp09.00.40.08', 'vp9'], ['vp09.00.10.08', 'vp9'], ['vp8', 'vp8']];
  for (const [codec, kind] of tries) {
    const config = { codec, width: w, height: h, bitrate, framerate: fps };
    if (kind === 'avc') config.avc = { format: 'avc' };
    try { const r = await VideoEncoder.isConfigSupported(config); if (r.supported) return { config: r.config, kind }; } catch { /* try the next */ }
  }
  return null;
}

/* opts: {width, height, fps, frames, draw(ctx, i) (sync or async), onProgress(p), signal} */
async function mp4(opts) {
  const { width: w, height: h, fps, frames } = opts;
  const bitrate = Math.round(Math.min(16e6, Math.max(2e6, w * h * fps * .12)));
  const codec = await pickCodec(w, h, fps, bitrate);
  if (!codec) return recordFallback(opts);
  // H.264 goes in MP4 (plays everywhere). Without an H.264 encoder we use VP9,
  // which belongs in WebM: VP9-in-MP4 doesn't play reliably.
  const webm = codec.kind !== 'avc';
  const M = await loadMuxer(webm ? 'webm' : 'mp4');
  const target = new M.ArrayBufferTarget();
  const muxer = webm
    ? new M.Muxer({ target, video: { codec: codec.kind === 'vp8' ? 'V_VP8' : 'V_VP9', width: w, height: h, frameRate: fps } })
    : new M.Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps }, fastStart: 'in-memory' });
  let failed = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failed = e; } });
  enc.configure(codec.config);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  for (let i = 0; i < frames; i++) {
    if (opts.signal && opts.signal.aborted) { enc.close(); throw new DOMException('Cancelled', 'AbortError'); }
    if (failed) throw failed;
    await opts.draw(ctx, i);
    const vf = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 4));
    if (i % 5 === 0) { opts.onProgress && opts.onProgress(i / frames); await tick(); }
  }
  await enc.flush();
  if (failed) throw failed;
  enc.close();
  muxer.finalize();
  opts.onProgress && opts.onProgress(1);
  return webm ? { blob: new Blob([target.buffer], { type: 'video/webm' }), ext: 'webm' } : { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4' };
}

// Older browsers: play the frames into a MediaRecorder in real time.
async function recordFallback(opts) {
  const { width: w, height: h, fps, frames } = opts;
  if (!window.MediaRecorder) throw new Error('This browser can’t make videos. Try current Chrome, Edge, Safari or Firefox.');
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
  if (!mime) throw new Error('This browser can’t record video.');
  await opts.draw(ctx, 0);
  const stream = c.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const parts = [];
  rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
  const done = new Promise(r => { rec.onstop = r; });
  rec.start(250);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    if (opts.signal && opts.signal.aborted) { rec.stop(); throw new DOMException('Cancelled', 'AbortError'); }
    const due = t0 + i * 1000 / fps;
    while (performance.now() < due) await new Promise(r => requestAnimationFrame(r));
    await opts.draw(ctx, i);
    opts.onProgress && opts.onProgress(i / frames);
  }
  await new Promise(r => setTimeout(r, 1000 / fps));
  rec.stop(); await done;
  stream.getTracks().forEach(t => t.stop());
  const mp4 = mime.startsWith('video/mp4');
  let blob = new Blob(parts, { type: mp4 ? 'video/mp4' : 'video/webm' });
  if (!mp4 && window.LDVideo.fixWebmDuration) blob = await window.LDVideo.fixWebmDuration(blob, frames * 1000 / fps);
  return { blob, ext: mp4 ? 'mp4' : 'webm' };
}

// ---------------------------------------------------------------- GIF
function medianCut(hist, n) {
  // hist: Map of 15-bit colour -> count. Returns palette [[r,g,b], ...].
  let boxes = [[...hist.keys()]];
  const ch = (c, k) => k === 0 ? (c >> 10) & 31 : k === 1 ? (c >> 5) & 31 : c & 31;
  while (boxes.length < n) {
    let bi = -1, best = -1, bk = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let k = 0; k < 3; k++) {
        let lo = 31, hi = 0; for (const c of b) { const v = ch(c, k); if (v < lo) lo = v; if (v > hi) hi = v; }
        const score = (hi - lo) * Math.log2(1 + b.reduce((s, c) => s + hist.get(c), 0));
        if (score > best) { best = score; bi = i; bk = k; }
      }
    });
    if (bi < 0 || best <= 0) break;
    const b = boxes[bi].sort((x, y) => ch(x, bk) - ch(y, bk));
    const total = b.reduce((s, c) => s + hist.get(c), 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < b.length - 1; i++) { acc += hist.get(b[i]); if (acc >= total / 2) { cut = i + 1; break; } }
    boxes.splice(bi, 1, b.slice(0, cut), b.slice(cut));
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0, t = 0;
    for (const c of b) { const k = hist.get(c); r += ch(c, 0) * k; g += ch(c, 1) * k; bl += ch(c, 2) * k; t += k; }
    return [Math.round(r / t * 255 / 31), Math.round(g / t * 255 / 31), Math.round(bl / t * 255 / 31)];
  });
}
function lzw(indices, minCode) {
  const out = [];
  let cur = 0, bits = 0;
  const emit = (code, size) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>= 8; bits -= 8; } };
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1;
  let dict = new Map();
  emit(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 256 + k;
    if (dict.has(key)) { prefix = dict.get(key); continue; }
    emit(prefix, size);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear, size); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    prefix = k;
  }
  emit(prefix, size);
  if (next >= (1 << size) && size < 12) size++;   // the decoder widens codes here too
  emit(eoi, size);
  if (bits > 0) out.push(cur & 255);
  return out;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v / 16 - .5) * 8);
async function gif(opts) {
  const { width: w, height: h, fps, frames } = opts;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // 1. palette from a sample of frames
  const hist = new Map();
  const samples = Math.min(frames, 12);
  for (let s = 0; s < samples; s++) {
    await opts.draw(ctx, Math.floor(s * (frames - 1) / Math.max(1, samples - 1)));
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i += 4 * 3) { const k = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | d[i + 2] >> 3; hist.set(k, (hist.get(k) || 0) + 1); }
    await tick();
  }
  const pal = medianCut(hist, 256);
  while (pal.length < 256) pal.push([0, 0, 0]);
  const lut = new Uint8Array(32768);
  for (let k = 0; k < 32768; k++) {
    const r = ((k >> 10) & 31) * 255 / 31, g = ((k >> 5) & 31) * 255 / 31, b = (k & 31) * 255 / 31;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) { const p = pal[i], dd = (p[0] - r) ** 2 * 2 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 3; if (dd < bd) { bd = dd; bi = i; } }
    lut[k] = bi;
  }
  // 2. header, global palette, loop forever
  let bytes = [];
  const parts = [];
  const flush = () => { parts.push(new Uint8Array(bytes)); bytes = []; };
  const str = s => { for (const ch of s) bytes.push(ch.charCodeAt(0)); };
  const u16 = v => bytes.push(v & 255, (v >> 8) & 255);
  str('GIF89a'); u16(w); u16(h); bytes.push(0xF7, 0, 0);
  for (const p of pal) bytes.push(p[0], p[1], p[2]);
  bytes.push(0x21, 0xFF, 11); str('NETSCAPE2.0'); bytes.push(3, 1, 0, 0, 0);
  const delay = Math.max(2, Math.round(100 / fps));
  const idx = new Uint8Array(w * h);
  for (let f = 0; f < frames; f++) {
    if (opts.signal && opts.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    await opts.draw(ctx, f);
    const d = ctx.getImageData(0, 0, w, h).data;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const o = BAYER[(y & 3) * 4 + (x & 3)], q = i * 4;
      const r = Math.max(0, Math.min(255, d[q] + o)), g = Math.max(0, Math.min(255, d[q + 1] + o)), b = Math.max(0, Math.min(255, d[q + 2] + o));
      idx[i] = lut[(r >> 3) << 10 | (g >> 3) << 5 | b >> 3];
    }
    bytes.push(0x21, 0xF9, 4, 0, delay & 255, delay >> 8, 0, 0);
    bytes.push(0x2C); u16(0); u16(0); u16(w); u16(h); bytes.push(0);
    bytes.push(8);
    const data = lzw(idx, 8);
    for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); bytes.push(n); for (let j = 0; j < n; j++) bytes.push(data[i + j]); }
    bytes.push(0);
    flush();
    opts.onProgress && opts.onProgress((f + 1) / frames);
    if (f % 2 === 0) await tick();
  }
  bytes.push(0x3B); flush();
  return { blob: new Blob(parts, { type: 'image/gif' }), ext: 'gif' };
}

window.LDVideo = { mp4, gif, pickCodec };
})();
