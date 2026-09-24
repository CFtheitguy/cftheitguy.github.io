// Local tests for design-worker with the Pexels API mocked out.
// Run: npm test   (no keys, no network needed)
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const calls = [];
const store = new Map();
globalThis.caches = { default: { match: async k => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } } };
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : {}));
  calls.push({ url, auth: headers.get('authorization'), key: headers.get('x-api-key'), body: init.body });
  if (url.startsWith('https://api.pexels.com/')) {
    return new Response(JSON.stringify({ page: 1, next_page: 'x', photos: [{ id: 1, width: 4000, height: 3000, alt: 'Coffee', avg_color: '#8a6', photographer: 'Ana', photographer_url: 'https://www.pexels.com/@ana', url: 'https://www.pexels.com/photo/1/', src: { medium: 'https://images.pexels.com/1-m.jpg', large2x: 'https://images.pexels.com/1-l.jpg' } }] }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://images.pexels.com/')) return new Response(new Uint8Array([255, 216, 255]), { headers: { 'Content-Type': 'image/jpeg' } });
  throw new Error('unexpected fetch ' + url);
};
const env = { ALLOWED_ORIGINS: 'https://www.linearit.co,https://linearit.co', PEXELS_KEY: 'pk-test' };
const ctx = { waitUntil: p => p };
const O = 'https://www.linearit.co';
const req = (path, o = {}) => new Request('https://design-api.linearit.co' + path, Object.assign({ headers: Object.assign({ Origin: O, 'CF-Connecting-IP': '1.2.3.4' }, o.headers) }, o.init));

let r, d;
// health
r = await worker.fetch(req('/health'), env, ctx); d = await r.json();
assert.equal(d.photos, true); assert.equal(d.write, undefined); console.log('ok health');
r = await worker.fetch(req('/health'), { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS }, ctx); d = await r.json();
assert.equal(d.photos, false); console.log('ok health without key');
// other origins refused, preflight
r = await worker.fetch(req('/photos/search?q=cat', { headers: { Origin: 'https://evil.example' } }), env, ctx); assert.equal(r.status, 403); console.log('ok foreign origin refused');
r = await worker.fetch(req('/photos/search', { init: { method: 'OPTIONS' } }), env, ctx); assert.equal(r.status, 204); assert.equal(r.headers.get('Access-Control-Allow-Origin'), O); console.log('ok preflight');
// photo search: key sent as Authorization, slimmed result, cached
r = await worker.fetch(req('/photos/search?q=coffee shop'), env, ctx); d = await r.json();
assert.equal(r.status, 200); assert.equal(d.photos[0].by, 'Ana'); assert.equal(d.photos[0].large, 'https://images.pexels.com/1-l.jpg'); assert.equal(r.headers.get('Access-Control-Allow-Origin'), O);
assert.equal(calls.at(-1).auth, 'pk-test'); assert.match(calls.at(-1).url, /search\?query=coffee%20shop/);
const n = calls.length; await worker.fetch(req('/photos/search?q=coffee shop'), env, ctx); assert.equal(calls.length, n, 'second identical search served from cache'); console.log('ok photo search + cache');
r = await worker.fetch(req('/photos/search'), env, ctx); assert.match(calls.at(-1).url, /curated/); console.log('ok curated');
// image proxy only for images.pexels.com
r = await worker.fetch(req('/photos/image?u=' + encodeURIComponent('https://images.pexels.com/1-l.jpg')), env, ctx); assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Type'), 'image/jpeg'); assert.equal(r.headers.get('Access-Control-Allow-Origin'), O);
r = await worker.fetch(req('/photos/image?u=' + encodeURIComponent('https://example.com/x.jpg')), env, ctx); assert.equal(r.status, 400); console.log('ok image proxy (and refuses other hosts)');
// not configured
r = await worker.fetch(req('/photos/search?q=x'), { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS }, ctx); assert.equal(r.status, 503); console.log('ok 503 when no Pexels key');
// the old AI endpoint is gone
r = await worker.fetch(req('/write', { init: { method: 'POST', body: '{}' } }), env, ctx); assert.equal(r.status, 404); console.log('ok no /write endpoint');
// rate limit binding honoured
const deny = { limit: async () => ({ success: false }) };
r = await worker.fetch(req('/photos/search?q=x'), Object.assign({}, env, { PHOTO_LIMIT: deny }), ctx); assert.equal(r.status, 429); console.log('ok rate limited → 429');
console.log('\nall worker tests passed');
