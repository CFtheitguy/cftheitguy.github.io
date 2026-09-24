/* Linear Design — background remover.
 *
 * Runs a segmentation model in the page with ONNX Runtime Web (WebAssembly),
 * so the photo never leaves the machine. Two models, both Apache-2.0:
 *   object — U²-Net-p (320×320 saliency; products, pets, people, logos)
 *   person — MODNet (portrait matting; better hair edges on people)
 * The model's low-resolution mask is upscaled and snapped to the photo's real
 * edges with a guided filter. Everything is served from /design/vendor and
 * only fetched the first time someone uses it.
 */
'use strict';
(() => {
const BASE = '/design/vendor/';
const MODELS = {
  object: { url: BASE + 'models/u2netp.onnx', bytes: 4574861 },
  person: { url: BASE + 'models/modnet.onnx', bytes: 6632188 },
};
const WASM_BYTES = 14239897;
let ortP = null;
const sessions = {};

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Couldn’t load ' + src)); document.head.append(s); });
}
async function fetchBytes(url, total, onBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  if (!r.body || !r.body.getReader) { const b = new Uint8Array(await r.arrayBuffer()); onBytes(b.length); return b; }
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onBytes(got); }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  void total;
  return out;
}
async function ensureOrt(progress) {
  if (!ortP) ortP = (async () => {
    await loadScript(BASE + 'ort/ort.wasm.min.js');
    const ort = window.ort;
    ort.env.wasm.wasmPaths = BASE + 'ort/';
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ort.env.wasm.proxy = false;
    // Pre-fetch the runtime so the progress bar covers it; the browser cache serves ORT's own request.
    await fetchBytes(BASE + 'ort/ort-wasm-simd-threaded.wasm', WASM_BYTES, n => progress && progress('runtime', n, WASM_BYTES));
    return ort;
  })().catch(e => { ortP = null; throw e; });
  return ortP;
}
async function session(kind, progress) {
  const ort = await ensureOrt(progress);
  if (!sessions[kind]) sessions[kind] = (async () => {
    const m = MODELS[kind];
    const bytes = await fetchBytes(m.url, m.bytes, n => progress && progress('model', n, m.bytes));
    return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })().catch(e => { delete sessions[kind]; throw e; });
  return sessions[kind];
}

// Draw the source into a canvas of at most maxSide on its long edge.
function toCanvas(src, maxSide) {
  const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
  const k = Math.min(1, maxSide / Math.max(iw, ih));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(iw * k)); c.height = Math.max(1, Math.round(ih * k));
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function tensorFrom(canvas, w, h, mean, std, maxNorm) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, n = w * h, out = new Float32Array(3 * n);
  let mx = 255;
  if (maxNorm) { mx = 1; for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i + 1], d[i + 2]); }
  for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) out[ch * n + i] = (d[i * 4 + ch] / mx - mean[ch]) / std[ch];
  return out;
}
// Resize a single-channel float map with the canvas's bilinear scaler.
function resizeMap(map, w, h, W, H) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); const im = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const v = Math.max(0, Math.min(255, Math.round(map[i] * 255))); im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
  g.putImageData(im, 0, 0);
  const o = document.createElement('canvas'); o.width = W; o.height = H;
  const og = o.getContext('2d', { willReadFrequently: true }); og.imageSmoothingQuality = 'high'; og.drawImage(c, 0, 0, W, H);
  const d = og.getImageData(0, 0, W, H).data, out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = d[i * 4] / 255;
  return out;
}
// O(N) box mean via a summed-area table.
function boxMean(src, w, h, r) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += src[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; } }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}
// He et al.'s guided filter: the mask follows the photo's own edges.
function guided(I, p, w, h, r, eps) {
  const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i]; a[i] = (mIp[i] - mI[i] * mp[i]) / (v + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.max(0, Math.min(1, ma[i] * I[i] + mb[i]));
  return q;
}

/* Returns {canvas: working-size copy of the photo, alpha: Float32Array (0..1)}. */
async function run(img, kind, progress) {
  kind = MODELS[kind] ? kind : 'object';
  const sess = await session(kind, progress);
  progress && progress('run', 0, 1);
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));   // let the "working" state paint
  const work = toCanvas(img, 1600), W = work.width, H = work.height;
  const ort = window.ort;
  let mask, mw, mh;
  if (kind === 'object') {
    mw = mh = 320;
    const t = new ort.Tensor('float32', tensorFrom(work, 320, 320, [.485, .456, .406], [.229, .224, .225], true), [1, 3, 320, 320]);
    const out = await sess.run({ [sess.inputNames[0]]: t });
    const d = out[sess.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < d.length; i++) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
    mask = new Float32Array(320 * 320); for (let i = 0; i < mask.length; i++) mask[i] = (d[i] - lo) / (hi - lo || 1);
  } else {
    const k = 512 / Math.max(W, H);
    mw = Math.max(32, Math.round(W * k / 32) * 32); mh = Math.max(32, Math.round(H * k / 32) * 32);
    const t = new ort.Tensor('float32', tensorFrom(work, mw, mh, [.5, .5, .5], [.5, .5, .5], false), [1, 3, mh, mw]);
    const out = await sess.run({ [sess.inputNames[0]]: t });
    mask = Float32Array.from(out[sess.outputNames[0]].data);
  }
  const up = resizeMap(mask, mw, mh, W, H);
  const d = work.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const I = new Float32Array(W * H); for (let i = 0; i < W * H; i++) I[i] = (d[i * 4] * .299 + d[i * 4 + 1] * .587 + d[i * 4 + 2] * .114) / 255;
  const r = Math.max(2, Math.round(Math.max(W, H) / (kind === 'object' ? 180 : 320)));
  const alpha = guided(I, up, W, H, r, kind === 'object' ? 1e-3 : 4e-4);
  progress && progress('done', 1, 1);
  return { canvas: work, alpha };
}
function isLoaded(kind) { return !!sessions[kind]; }
window.LDBg = { run, isLoaded, MODELS };
})();
