/* Linear Design — on-device photo tools. Everything runs in the page; photos
 * are never uploaded. Models and engines are served from /design/vendor and
 * fetched the first time a tool is used.
 *   erase(img, mask)  — magic eraser: MI-GAN inpainting (MIT)
 *   upscale(img, k)   — 2× / 4× enlarge: Real-ESRGAN general-x4v3 (BSD-3)
 *   blurBackground()  — keeps the subject sharp using the background-remover mask
 *   ocr(img)          — text from a picture: Tesseract.js (Apache-2.0)
 */
'use strict';
(() => {
const BASE = '/design/vendor/';
let ortP = null;
const sessions = {};
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Couldn’t load ' + src)); document.head.append(s); }); }
function ort() {
  if (!ortP) ortP = (window.ort ? Promise.resolve() : loadScript(BASE + 'ort/ort.wasm.min.js')).then(() => {
    const o = window.ort;
    o.env.wasm.wasmPaths = BASE + 'ort/';
    o.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    o.env.wasm.proxy = false;
    return o;
  }).catch(e => { ortP = null; throw e; });
  return ortP;
}
async function session(name, progress) {
  const o = await ort();
  if (!sessions[name]) sessions[name] = (async () => {
    const r = await fetch(BASE + 'models/' + name + '.onnx');
    if (!r.ok) throw new Error('Couldn’t download the model.');
    const total = +r.headers.get('Content-Length') || 0;
    let bytes;
    if (r.body && r.body.getReader) {
      const rd = r.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; progress && progress('download', got, total); }
      bytes = new Uint8Array(got); let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; }
    } else bytes = new Uint8Array(await r.arrayBuffer());
    return o.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })().catch(e => { delete sessions[name]; throw e; });
  return sessions[name];
}
const yieldUI = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
function canvasOf(src, maxSide) {
  const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
  const k = Math.min(1, (maxSide || 1e9) / Math.max(iw, ih));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(iw * k)); c.height = Math.max(1, Math.round(ih * k));
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// ---------------------------------------------------------------- magic eraser
// mask: canvas the same size as img; painted (alpha > 0) pixels are removed.
// Only a padded square around the painted area goes through the model, so big
// photos stay fast and everything outside the mask is left byte-for-byte alone.
async function erase(img, mask, progress) {
  const sess = await session('migan', progress);
  progress && progress('run', 0, 1); await yieldUI();
  const W = img.width, H = img.height;
  const md = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (md[(y * W + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return img;
  // square crop, 3× the painted area (context for the model), clamped to the photo
  const side = Math.min(Math.max(W, H), Math.max(96, Math.round(Math.max(x1 - x0, y1 - y0) * 3)));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const cw = Math.min(W, side), ch = Math.min(H, side);
  const sx = Math.round(Math.max(0, Math.min(W - cw, cx - cw / 2))), sy = Math.round(Math.max(0, Math.min(H - ch, cy - ch / 2)));
  const S = 512, k = Math.min(1, S / Math.max(cw, ch)), tw = Math.max(8, Math.round(cw * k)), th = Math.max(8, Math.round(ch * k));
  const crop = document.createElement('canvas'); crop.width = tw; crop.height = th;
  const cg = crop.getContext('2d', { willReadFrequently: true }); cg.imageSmoothingQuality = 'high'; cg.drawImage(img, sx, sy, cw, ch, 0, 0, tw, th);
  const mc = document.createElement('canvas'); mc.width = tw; mc.height = th;
  const mg = mc.getContext('2d', { willReadFrequently: true }); mg.drawImage(mask, sx, sy, cw, ch, 0, 0, tw, th);
  const id = cg.getImageData(0, 0, tw, th).data, mdd = mg.getImageData(0, 0, tw, th).data, n = tw * th;
  const imgT = new Uint8Array(3 * n), maskT = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    imgT[i] = id[i * 4]; imgT[n + i] = id[i * 4 + 1]; imgT[2 * n + i] = id[i * 4 + 2];
    maskT[i] = mdd[i * 4 + 3] > 20 ? 0 : 255;   // MI-GAN: 255 = keep, 0 = fill in
  }
  const o = window.ort;
  const out = await sess.run({ image: new o.Tensor('uint8', imgT, [1, 3, th, tw]), mask: new o.Tensor('uint8', maskT, [1, 1, th, tw]) });
  const r = out[sess.outputNames[0]].data;
  const res = cg.createImageData(tw, th);
  for (let i = 0; i < n; i++) { res.data[i * 4] = r[i]; res.data[i * 4 + 1] = r[n + i]; res.data[i * 4 + 2] = r[2 * n + i]; res.data[i * 4 + 3] = 255; }
  cg.putImageData(res, 0, 0);
  // paste back only where the mask was painted (feathered), at full resolution
  const patch = document.createElement('canvas'); patch.width = cw; patch.height = ch;
  const pg = patch.getContext('2d'); pg.imageSmoothingQuality = 'high'; pg.drawImage(crop, 0, 0, cw, ch);
  pg.globalCompositeOperation = 'destination-in';
  const soft = document.createElement('canvas'); soft.width = cw; soft.height = ch;
  const sg = soft.getContext('2d'); sg.filter = 'blur(2px)'; sg.drawImage(mask, sx, sy, cw, ch, 0, 0, cw, ch);
  sg.filter = 'none'; sg.drawImage(mask, sx, sy, cw, ch, 0, 0, cw, ch);
  pg.drawImage(soft, 0, 0);
  const outC = document.createElement('canvas'); outC.width = W; outC.height = H;
  const og = outC.getContext('2d'); og.drawImage(img, 0, 0); og.drawImage(patch, sx, sy);
  progress && progress('done', 1, 1);
  return outC;
}

// ---------------------------------------------------------------- upscaler
async function upscale(img, factor, progress) {
  const sess = await session('realesr-general-x4v3', progress);
  const src = canvasOf(img);
  const W = src.width, H = src.height;
  const data = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const T = 160, P = 10;   // tile size and overlap, in input pixels
  const out = document.createElement('canvas'); out.width = W * 4; out.height = H * 4;
  const og = out.getContext('2d');
  const o = window.ort;
  const tiles = []; for (let y = 0; y < H; y += T) for (let x = 0; x < W; x += T) tiles.push([x, y]);
  let done = 0;
  for (const [tx, ty] of tiles) {
    const x0 = Math.max(0, tx - P), y0 = Math.max(0, ty - P), x1 = Math.min(W, tx + T + P), y1 = Math.min(H, ty + T + P);
    const w = x1 - x0, h = y1 - y0, n = w * h, t = new Float32Array(3 * n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = ((y0 + y) * W + x0 + x) * 4, i = y * w + x; t[i] = data[s] / 255; t[n + i] = data[s + 1] / 255; t[2 * n + i] = data[s + 2] / 255; }
    const r = (await sess.run({ [sess.inputNames[0]]: new o.Tensor('float32', t, [1, 3, h, w]) }))[sess.outputNames[0]].data;
    const W4 = w * 4, H4 = h * 4, n4 = W4 * H4, tile = new ImageData(W4, H4);
    for (let i = 0; i < n4; i++) { tile.data[i * 4] = r[i] * 255; tile.data[i * 4 + 1] = r[n4 + i] * 255; tile.data[i * 4 + 2] = r[2 * n4 + i] * 255; tile.data[i * 4 + 3] = 255; }
    const tc = document.createElement('canvas'); tc.width = W4; tc.height = H4; tc.getContext('2d').putImageData(tile, 0, 0);
    // keep only the tile's own area; the overlap just gives the edges context
    const cx = (tx - x0) * 4, cy = (ty - y0) * 4, cw = (Math.min(W, tx + T) - tx) * 4, ch = (Math.min(H, ty + T) - ty) * 4;
    og.drawImage(tc, cx, cy, cw, ch, tx * 4, ty * 4, cw, ch);
    done++; progress && progress('run', done, tiles.length);
    await yieldUI();
  }
  // keep the photo's transparency (e.g. after Remove background)
  const a = document.createElement('canvas'); a.width = out.width; a.height = out.height;
  const ag = a.getContext('2d'); ag.imageSmoothingQuality = 'high'; ag.drawImage(src, 0, 0, a.width, a.height);
  og.globalCompositeOperation = 'destination-in'; og.drawImage(a, 0, 0); og.globalCompositeOperation = 'source-over';
  if (factor === 4) return out;
  const half = document.createElement('canvas'); half.width = W * factor; half.height = H * factor;
  const hg = half.getContext('2d'); hg.imageSmoothingQuality = 'high'; hg.drawImage(out, 0, 0, half.width, half.height);
  return half;
}

// ---------------------------------------------------------------- background blur
async function blurBackground(img, amount, progress) {
  if (!window.LDBg) await loadScript('/design/bgremove.js');
  const { canvas, alpha } = await window.LDBg.run(img, 'object', progress);
  const W = canvas.width, H = canvas.height;
  // blur by shrinking and enlarging a few times (works without ctx.filter)
  const r = Math.max(2, Math.round(Math.max(W, H) * amount / 100 * .03));
  let b = canvas;
  for (let pass = 0; pass < 3; pass++) {
    const s = document.createElement('canvas'); s.width = Math.max(1, Math.round(W / r)); s.height = Math.max(1, Math.round(H / r));
    const sg = s.getContext('2d'); sg.imageSmoothingQuality = 'high'; sg.drawImage(b, 0, 0, s.width, s.height);
    const u = document.createElement('canvas'); u.width = W; u.height = H;
    const ug = u.getContext('2d'); ug.imageSmoothingQuality = 'high'; ug.drawImage(s, 0, 0, W, H); b = u;
  }
  const subject = document.createElement('canvas'); subject.width = W; subject.height = H;
  const sg = subject.getContext('2d', { willReadFrequently: true }); sg.drawImage(canvas, 0, 0);
  const d = sg.getImageData(0, 0, W, H);
  for (let i = 0; i < alpha.length; i++) d.data[i * 4 + 3] = Math.round(Math.min(1, alpha[i] * 1.15) * 255);
  sg.putImageData(d, 0, 0);
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const og = out.getContext('2d'); og.drawImage(b, 0, 0); og.drawImage(subject, 0, 0);
  return out;
}

// ---------------------------------------------------------------- OCR
let ocrWorker = null;
async function ocr(img, progress) {
  if (!window.Tesseract) await loadScript(BASE + 'ocr/tesseract.min.js');
  if (!ocrWorker) ocrWorker = window.Tesseract.createWorker('eng', 1, {
    workerPath: BASE + 'ocr/worker.min.js', corePath: BASE + 'ocr/', langPath: BASE + 'ocr/', gzip: true, workerBlobURL: false, cacheMethod: 'none',
    logger: m => progress && progress(m.status, m.progress || 0, 1),
  }).catch(e => { ocrWorker = null; throw e; });
  const w = await ocrWorker;
  const c = canvasOf(img, 2400);
  const { data } = await w.recognize(c);
  return (data.text || '').replace(/\n{3,}/g, '\n\n').trim();
}

window.LDAI = { erase, upscale, blurBackground, ocr };
})();
