/* design-worker — the online half of Linear Design (design-api.linearit.co).
 *
 *   GET  /health                  which features have their keys set
 *   GET  /photos/search?q=&page=  Pexels search (or curated photos when q is empty)
 *   GET  /photos/image?u=         one Pexels image, re-served with CORS so the
 *                                 editor can put it in a canvas and export it
 *   POST /write                   Magic Write: short copy suggestions from Claude
 *
 * The API keys live only here, as encrypted Worker secrets. Browsers on other
 * sites are refused (CORS + an Origin check), and each visitor is rate-limited.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const PEXELS = 'https://api.pexels.com/v1';

function allowedOrigin(req, env) {
  const origin = req.headers.get('Origin') || '';
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}
function cors(origin) {
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } : {};
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

// ---------------------------------------------------------------- Magic Write
const TASKS = {
  headline: 'Write 5 different headlines for this design. Short and punchy: at most 8 words each.',
  tagline: 'Write 5 different short taglines or subheadings (at most 12 words each).',
  cta: 'Write 5 different call-to-action button labels (2 to 4 words each).',
  caption: 'Write 3 different social media captions for posting this design (1 to 3 sentences each, may end with 2-4 relevant hashtags).',
  rewrite: 'Rewrite the given text 5 different ways, keeping the meaning and roughly the length.',
  shorter: 'Rewrite the given text 5 different ways, each noticeably shorter.',
  longer: 'Rewrite the given text 5 different ways, each a little longer and more descriptive (at most 40 words).',
  fix: 'Fix spelling, grammar and punctuation in the given text. Return the corrected text as the only suggestion, changing nothing else.',
  ideas: 'Suggest 5 different short text ideas for this design, based on the request.',
};
const TONES = ['friendly', 'professional', 'playful', 'bold', 'elegant', 'urgent', 'calm'];
const Suggestions = z.object({ suggestions: z.array(z.string()) });
const SYSTEM = 'You write copy for graphic designs made in a design app — flyers, posters, social posts, invitations, business cards and presentations. ' +
  'Write text that fits on a design: concise, concrete and ready to use as-is. Never use placeholder brackets like [Name]; if a detail is unknown, write around it. ' +
  'Return plain text only in each suggestion: no quotation marks around it, no markdown, no numbering. Write in the same language as the user’s text.';

async function write(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400, origin); }
  const task = TASKS[body.task] ? body.task : 'ideas';
  const tone = TONES.includes(body.tone) ? body.tone : 'friendly';
  const text = String(body.text || '').slice(0, 1000).trim();
  const context = String(body.context || '').slice(0, 600).trim();
  if (!text && !context) return json({ error: 'Type something first.' }, 400, origin);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_KEY });
  const user = [`Task: ${TASKS[task]}`, `Tone: ${tone}.`, context && `What the design is about: ${context}`, text && `Text:\n${text}`].filter(Boolean).join('\n\n');
  try {
    // Structured output: the reply is JSON matching Suggestions. stop_reason is
    // checked before reading it — a declined request comes back with no JSON.
    const response = await client.messages.create({
      model: env.MODEL || 'claude-opus-5',
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: zodOutputFormat(Suggestions) },
    });
    if (response.stop_reason === 'refusal') return json({ error: 'Magic Write can’t help with that one — try different wording.' }, 422, origin);
    const textBlock = response.content.find(b => b.type === 'text');
    let out = null;
    try { const parsed = Suggestions.safeParse(JSON.parse(textBlock ? textBlock.text : '')); if (parsed.success) out = parsed.data; } catch { /* handled below */ }
    if (!out) return json({ error: 'No suggestions came back — try again.' }, 502, origin);
    const suggestions = out.suggestions.map(s => String(s).trim()).filter(Boolean).slice(0, 6);
    return json({ suggestions }, 200, origin);
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: 'Magic Write is busy — try again in a minute.' }, 429, origin);
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return json({ error: 'Magic Write isn’t set up yet.' }, 503, origin);
    if (error instanceof Anthropic.BadRequestError) return json({ error: 'Magic Write couldn’t handle that request.' }, 400, origin);
    if (error instanceof Anthropic.APIError) return json({ error: 'Magic Write is unavailable right now.' }, 502, origin);
    return json({ error: 'Magic Write is unavailable right now.' }, 502, origin);
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = allowedOrigin(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: cors(origin) });
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, photos: !!env.PEXELS_KEY, write: !!env.ANTHROPIC_KEY }, 200, origin);
    // Everything else is for the design app only.
    if (!origin) return json({ error: 'This service is only for linearit.co/design.' }, 403, null);
    if (url.pathname === '/photos/search' && req.method === 'GET') {
      if (!env.PEXELS_KEY) return json({ error: 'Stock photos aren’t set up yet.' }, 503, origin);
      if (await limited(env.PHOTO_LIMIT, req)) return json({ error: 'Slow down a little — try again in a minute.' }, 429, origin);
      return searchPhotos(url, env, ctx, origin);
    }
    if (url.pathname === '/photos/image' && req.method === 'GET') {
      if (await limited(env.PHOTO_LIMIT, req)) return json({ error: 'Slow down a little — try again in a minute.' }, 429, origin);
      return proxyImage(url, ctx, origin);
    }
    if (url.pathname === '/write' && req.method === 'POST') {
      if (!env.ANTHROPIC_KEY) return json({ error: 'Magic Write isn’t set up yet.' }, 503, origin);
      if (await limited(env.WRITE_LIMIT, req)) return json({ error: 'That’s a lot of writing — wait a minute and try again.' }, 429, origin);
      return write(req, env, origin);
    }
    return json({ error: 'Not found.' }, 404, origin);
  },
};
