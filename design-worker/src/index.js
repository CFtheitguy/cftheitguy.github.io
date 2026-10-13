/* design-worker — stock photos for Linear Design (design-api.linearit.co).
 *
 *   GET  /health                  whether the Pexels key is set
 *   GET  /photos/search?q=&page=  Pexels search (or curated photos when q is empty)
 *   GET  /photos/image?u=         one Pexels image, re-served with CORS so the
 *                                 editor can put it in a canvas and export it
 *   GET  /videos/search?q=&page=  Pexels video search (or popular videos) for Linear Motion
 *   GET  /videos/file?u=          one Pexels video file, streamed with CORS (Range supported)
 *
 * The Pexels key lives only here, as an encrypted Worker secret. Browsers on
 * other sites are refused (CORS + an Origin check), and each visitor is
 * rate-limited.
 */

const PEXELS = 'https://api.pexels.com/v1';
const PEXELS_VIDEOS = 'https://api.pexels.com/videos';

function allowedOrigin(req, env) {
  const origin = req.headers.get('Origin') || '';
  // Defaults to linearit.co, so a Worker pasted into the Cloudflare dashboard
  // needs no settings besides the PEXELS_KEY secret.
  const list = String(env.ALLOWED_ORIGINS || 'https://www.linearit.co,https://linearit.co').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}
function cors(origin) {
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range', 'Access-Control-Max-Age': '86400' } : {};
}
function json(body, status, origin, extra) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors(origin), extra) });
}
async function limited(binding, req) {
  if (!binding) return false;   // no binding (e.g. local tests) -> no limit
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await binding.limit({ key: ip });
  return !success;
}

// ---------------------------------------------------------------- videos
function slimVideo(v) {
  const files = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && f.link);
  // Prefer an HD file around 1280-1920 px: sharp enough, not huge.
  files.sort((a, b) => Math.abs((Math.max(a.width, a.height) || 0) - 1600) - Math.abs((Math.max(b.width, b.height) || 0) - 1600));
  const f = files[0];
  const pic = (v.video_pictures || [])[0];
  return f && { id: v.id, w: f.width || v.width, h: f.height || v.height, dur: v.duration, by: v.user && v.user.name, byUrl: v.user && v.user.url, url: v.url, thumb: v.image || (pic && pic.picture), file: f.link };
}
async function searchVideos(url, env, ctx, origin) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const orient = ['landscape', 'portrait', 'square'].includes(url.searchParams.get('orientation')) ? url.searchParams.get('orientation') : '';
  const api = q ? `${PEXELS_VIDEOS}/search?query=${encodeURIComponent(q)}&per_page=24&page=${page}${orient ? '&orientation=' + orient : ''}` : `${PEXELS_VIDEOS}/popular?per_page=24&page=${page}`;
  const cache = caches.default, key = new Request(api);
  let res = await cache.match(key);
  if (!res) {
    const r = await fetch(api, { headers: { Authorization: env.PEXELS_KEY } });
    if (!r.ok) return json({ error: r.status === 429 ? 'The video library is busy — try again in a minute.' : 'Video search failed.' }, r.status === 429 ? 429 : 502, origin);
    const d = await r.json();
    res = new Response(JSON.stringify({ videos: (d.videos || []).map(slimVideo).filter(Boolean), page, more: !!d.next_page }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return new Response(res.body, { headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors(origin)) });
}
async function proxyVideo(req, url, origin) {
  let target;
  try { target = new URL(url.searchParams.get('u') || ''); } catch { return json({ error: 'Bad video address.' }, 400, origin); }
  if (target.protocol !== 'https:' || !/(^|\.)pexels\.com$/.test(target.hostname)) return json({ error: 'Only Pexels videos can be fetched.' }, 400, origin);
  const h = {}; const range = req.headers.get('Range'); if (range) h.Range = range;
  const r = await fetch(target.toString(), { headers: h });
  if (!r.ok || !/^video\//.test(r.headers.get('Content-Type') || '')) return json({ error: 'Couldn’t fetch that video.' }, 502, origin);
  const out = { 'Content-Type': r.headers.get('Content-Type'), 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' };
  for (const k of ['Content-Length', 'Content-Range']) if (r.headers.get(k)) out[k] = r.headers.get(k);
  return new Response(r.body, { status: r.status, headers: Object.assign(out, cors(origin)) });
}

// ---------------------------------------------------------------- photos
function slimPhoto(p) {
  return { id: p.id, w: p.width, h: p.height, alt: p.alt || '', color: p.avg_color || '#cccccc', by: p.photographer, byUrl: p.photographer_url, url: p.url, thumb: p.src.medium, large: p.src.large2x };
}
async function searchPhotos(url, env, ctx, origin) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get('page') || '1', 10) || 1));
  const orient = ['landscape', 'portrait', 'square'].includes(url.searchParams.get('orientation')) ? url.searchParams.get('orientation') : '';
  const api = q ? `${PEXELS}/search?query=${encodeURIComponent(q)}&per_page=30&page=${page}${orient ? '&orientation=' + orient : ''}` : `${PEXELS}/curated?per_page=30&page=${page}`;
  // Identical searches are answered from Cloudflare's cache for an hour, which
  // keeps well inside Pexels' free quota.
  const cache = caches.default, key = new Request(api);
  let res = await cache.match(key);
  if (!res) {
    const r = await fetch(api, { headers: { Authorization: env.PEXELS_KEY } });
    if (!r.ok) return json({ error: r.status === 429 ? 'The photo library is busy — try again in a minute.' : 'Photo search failed.' }, r.status === 429 ? 429 : 502, origin);
    const d = await r.json();
    res = new Response(JSON.stringify({ photos: (d.photos || []).map(slimPhoto), page, more: !!d.next_page }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return new Response(res.body, { headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors(origin)) });
}
async function proxyImage(url, ctx, origin) {
  let target;
  try { target = new URL(url.searchParams.get('u') || ''); } catch { return json({ error: 'Bad image address.' }, 400, origin); }
  if (target.protocol !== 'https:' || target.hostname !== 'images.pexels.com') return json({ error: 'Only Pexels images can be fetched.' }, 400, origin);
  const cache = caches.default, key = new Request(target.toString());
  let res = await cache.match(key);
  if (!res) {
    const r = await fetch(target.toString());
    if (!r.ok || !/^image\//.test(r.headers.get('Content-Type') || '')) return json({ error: 'Couldn’t fetch that image.' }, 502, origin);
    res = new Response(r.body, { headers: { 'Content-Type': r.headers.get('Content-Type'), 'Cache-Control': 'public, max-age=86400' } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return new Response(res.body, { headers: Object.assign({ 'Content-Type': res.headers.get('Content-Type'), 'Cache-Control': 'public, max-age=86400' }, cors(origin)) });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = allowedOrigin(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: cors(origin) });
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, photos: !!env.PEXELS_KEY, videos: !!env.PEXELS_KEY }, 200, origin);
    // Everything else is for the design app only.
    if (!origin) return json({ error: 'This service is only for linearit.co apps.' }, 403, null);
    if (url.pathname === '/photos/search' && req.method === 'GET') {
      if (!env.PEXELS_KEY) return json({ error: 'Stock photos aren’t set up yet.' }, 503, origin);
      if (await limited(env.PHOTO_LIMIT, req)) return json({ error: 'Slow down a little — try again in a minute.' }, 429, origin);
      return searchPhotos(url, env, ctx, origin);
    }
    if (url.pathname === '/photos/image' && req.method === 'GET') {
      if (await limited(env.PHOTO_LIMIT, req)) return json({ error: 'Slow down a little — try again in a minute.' }, 429, origin);
      return proxyImage(url, ctx, origin);
    }
    if (url.pathname === '/videos/search' && req.method === 'GET') {
      if (!env.PEXELS_KEY) return json({ error: 'Stock videos aren’t set up yet.' }, 503, origin);
      if (await limited(env.PHOTO_LIMIT, req)) return json({ error: 'Slow down a little — try again in a minute.' }, 429, origin);
      return searchVideos(url, env, ctx, origin);
    }
    if (url.pathname === '/videos/file' && req.method === 'GET') return proxyVideo(req, url, origin);
    return json({ error: 'Not found.' }, 404, origin);
  },
};
