// Local tests for design-worker with the Pexels and Anthropic APIs mocked out.
// Run: npm test   (no keys, no network needed)
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const calls = [];
const store = new Map();
globalThis.caches = { default: { match: async k => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } } };
let anthropicReply = null;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : {}));
  calls.push({ url, auth: headers.get('authorization'), key: headers.get('x-api-key'), body: init.body });
  if (url.startsWith('https://api.pexels.com/')) {
    return new Response(JSON.stringify({ page: 1, next_page: 'x', photos: [{ id: 1, width: 4000, height: 3000, alt: 'Coffee', avg_color: '#8a6', photographer: 'Ana', photographer_url: 'https://www.pexels.com/@ana', url: 'https://www.pexels.com/photo/1/', src: { medium: 'https://images.pexels.com/1-m.jpg', large2x: 'https://images.pexels.com/1-l.jpg' } }] }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://images.pexels.com/')) return new Response(new Uint8Array([255, 216, 255]), { headers: { 'Content-Type': 'image/jpeg' } });
  if (url.startsWith('https://api.anthropic.com/')) return anthropicReply();
  throw new Error('unexpected fetch ' + url);
};
const env = { ALLOWED_ORIGINS: 'https://www.linearit.co,https://linearit.co', MODEL: 'claude-opus-5', PEXELS_KEY: 'pk-test', ANTHROPIC_KEY: 'sk-test' };
const ctx = { waitUntil: p => p };
const O = 'https://www.linearit.co';
const req = (path, o = {}) => new Request('https://design-api.linearit.co' + path, Object.assign({ headers: Object.assign({ Origin: O, 'CF-Connecting-IP': '1.2.3.4' }, o.headers) }, o.init));
const msg = (text, stop = 'end_turn') => new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 } }), { headers: { 'Content-Type': 'application/json' } });

let r, d;
// health
r = await worker.fetch(req('/health'), env, ctx); d = await r.json();
assert.deepEqual([d.photos, d.write], [true, true]); console.log('ok health');
r = await worker.fetch(req('/health'), { ALLOWED_ORIGINS: env.ALLOWED_ORIGINS }, ctx); d = await r.json();
assert.deepEqual([d.photos, d.write], [false, false]); console.log('ok health without keys');
// other origins refused, preflight
r = await worker.fetch(req('/photos/search?q=cat', { headers: { Origin: 'https://evil.example' } }), env, ctx); assert.equal(r.status, 403); console.log('ok foreign origin refused');
r = await worker.fetch(req('/write', { init: { method: 'OPTIONS' } }), env, ctx); assert.equal(r.status, 204); assert.equal(r.headers.get('Access-Control-Allow-Origin'), O); console.log('ok preflight');
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
// write: structured output parsed, model + key used, effort low
anthropicReply = () => msg(JSON.stringify({ suggestions: ['Fresh Brew Friday', 'Coffee, Made Right', 'Your New Morning Ritual'] }));
r = await worker.fetch(req('/write', { init: { method: 'POST', body: JSON.stringify({ task: 'headline', tone: 'playful', context: 'coffee shop grand opening' }) } }), env, ctx); d = await r.json();
assert.equal(r.status, 200, JSON.stringify(d)); assert.deepEqual(d.suggestions, ['Fresh Brew Friday', 'Coffee, Made Right', 'Your New Morning Ritual']);
const sent = JSON.parse(calls.at(-1).body); assert.equal(calls.at(-1).key, 'sk-test'); assert.equal(sent.model, 'claude-opus-5'); assert.equal(sent.output_config.effort, 'low'); assert.equal(sent.output_config.format.type, 'json_schema');
console.log('ok write → suggestions (model', sent.model + ', effort', sent.output_config.effort + ', json_schema output)');
// refusal and API errors map to friendly messages
anthropicReply = () => msg('', 'refusal');
r = await worker.fetch(req('/write', { init: { method: 'POST', body: JSON.stringify({ task: 'rewrite', text: 'hi' }) } }), env, ctx); assert.equal(r.status, 422); console.log('ok refusal → 422');
anthropicReply = () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
r = await worker.fetch(req('/write', { init: { method: 'POST', body: JSON.stringify({ task: 'rewrite', text: 'hi' }) } }), env, ctx); assert.equal(r.status, 503); console.log('ok bad key → 503 "not set up"');
r = await worker.fetch(req('/write', { init: { method: 'POST', body: JSON.stringify({ task: 'rewrite' }) } }), env, ctx); assert.equal(r.status, 400); console.log('ok empty request → 400');
// rate limit binding honoured
const deny = { limit: async () => ({ success: false }) };
r = await worker.fetch(req('/write', { init: { method: 'POST', body: JSON.stringify({ text: 'x' }) } }), Object.assign({}, env, { WRITE_LIMIT: deny }), ctx); assert.equal(r.status, 429); console.log('ok rate limited → 429');
console.log('\nall worker tests passed');
