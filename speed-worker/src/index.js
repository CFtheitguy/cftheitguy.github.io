/**
 * `speed-worker` — Cloudflare Worker for speed.linearit.co
 * ========================================================
 *
 * The measurement backend for **Linear Speed**, the branded speed test. It does
 * three small things and nothing else:
 *
 *   GET  /api/ping            tiny empty response, used to time round trips
 *   GET  /api/down?bytes=N    streams N bytes of incompressible random data
 *   POST /api/up              swallows the uploaded body and reports the size
 *   GET  /api/info            what the edge sees: IP, city, ISP, colo, protocol
 *
 * Everything else is the app itself, reverse-proxied from the GitHub Pages copy
 * at https://www.linearit.co/speed/ so there is only ever one copy to maintain.
 *
 * This Worker is **completely separate** from linear-chat / linear-vault /
 * linear-time / linear-sign: its own folder, its own config, no shared bindings,
 * no database, no secrets. It cannot affect the other subdomains.
 *
 * ---- ONE-TIME SETUP (run from this folder) --------------------------------
 *   cd speed-worker && npm install && npx wrangler deploy
 *
 * That single deploy also creates the speed.linearit.co Custom Domain and its
 * DNS record, because wrangler.toml marks the route `custom_domain = true`.
 */

// Cap on a single download request. Enough for a gigabit line to stay busy for
// a couple of seconds; the client asks for several of these in parallel.
const MAX_DOWN_BYTES = 100 * 1024 * 1024;
const DEFAULT_DOWN_BYTES = 8 * 1024 * 1024;
// Chunk the download stream in 64 KB pieces — the largest single block
// crypto.getRandomValues() will fill, and a comfortable size for the network.
const CHUNK = 64 * 1024;
// Cap on a single upload request, so nobody can use this as free storage-shaped
// bandwidth. The client sends several smaller posts instead of one huge one.
const MAX_UP_BYTES = 64 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return cors(request, env, preflight());

    try {
      if (p === "/api/health") return cors(request, env, text("ok"));
      if (p === "/api/ping") return cors(request, env, ping());
      if (p === "/api/info") return cors(request, env, info(request));
      if (p === "/api/down") return cors(request, env, down(url, method));
      if (p === "/api/up") return cors(request, env, await up(request, method));
      if (p.startsWith("/api/")) return cors(request, env, json({ error: "Not found" }, 404));
      // Everything else: serve the app by reverse-proxying the GitHub Pages copy.
      return proxyApp(request, env, url, method);
    } catch (err) {
      return cors(request, env, json({ error: String((err && err.message) || err) }, 500));
    }
  },
};

/* ============================================================
 * Measurement endpoints
 * ============================================================ */

/** Empty 204 — the smallest honest round trip we can offer. */
function ping() {
  return new Response(null, { status: 204, headers: noStore() });
}

/** What the edge sees about this connection. Nothing is stored. */
function info(request) {
  const cf = request.cf || {};
  return json({
    ip: request.headers.get("CF-Connecting-IP") || null,
    city: cf.city || null,
    region: cf.region || null,
    country: cf.country || null,
    isp: cf.asOrganization || null,
    asn: cf.asn || null,
    colo: cf.colo || null,
    protocol: cf.httpProtocol || null,
    server_time: Date.now(),
  });
}

/**
 * Stream `bytes` of random data.
 *
 * Random rather than zeros on purpose: zeros compress to nothing, and a
 * compressed response would measure the compressor instead of the line. Random
 * bytes are incompressible, so what the browser counts is what crossed the wire.
 */
function down(url, method) {
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");
  let bytes = Number(url.searchParams.get("bytes"));
  if (!Number.isFinite(bytes) || bytes <= 0) bytes = DEFAULT_DOWN_BYTES;
  bytes = Math.min(Math.floor(bytes), MAX_DOWN_BYTES);

  const headers = noStore();
  headers.set("content-type", "application/octet-stream");
  headers.set("content-length", String(bytes));
  headers.set("content-disposition", 'attachment; filename="speedtest.bin"');
  if (method === "HEAD") return new Response(null, { status: 200, headers });

  // One buffer of random bytes, reused for every chunk. Filling 64 KB afresh
  // hundreds of times would measure this Worker's CPU, not the network.
  const block = new Uint8Array(CHUNK);
  crypto.getRandomValues(block);

  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= bytes) { controller.close(); return; }
      const n = Math.min(CHUNK, bytes - sent);
      controller.enqueue(n === CHUNK ? block : block.subarray(0, n));
      sent += n;
    },
  });
  return new Response(body, { status: 200, headers });
}

/**
 * Drain an upload and report how much arrived.
 *
 * The body is read to the end and thrown away — the point is the time the
 * browser spent pushing it, which the browser itself measures. Nothing is
 * stored, logged or forwarded.
 */
async function up(request, method) {
  if (method !== "POST" && method !== "PUT") return methodNotAllowed("POST, PUT");
  let received = 0;
  const body = request.body;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_UP_BYTES) {
        await reader.cancel();
        return json({ error: "Too large", limit: MAX_UP_BYTES }, 413);
      }
    }
  }
  return json({ bytes: received });
}

/* ============================================================
 * Reverse-proxy the app from GitHub Pages (so speed.linearit.co serves it)
 * ============================================================ */
async function proxyApp(request, env, url, method) {
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");

  const origin = env.APP_ORIGIN || "https://www.linearit.co";
  const appPath = env.APP_PATH || "/speed/";
  const path = url.pathname === "/" ? appPath : url.pathname;
  const target = origin + path + url.search;

  let originResp;
  try {
    originResp = await fetch(target, {
      method: "GET",
      headers: { Accept: request.headers.get("Accept") || "*/*", "Accept-Encoding": "gzip" },
      redirect: "follow",
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } catch (_) {
    return new Response("Linear Speed is briefly unavailable. Please try again in a moment.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "20" },
    });
  }
  if (originResp.status === 404) return new Response("Not found", { status: 404 });

  const headers = new Headers(originResp.headers);
  headers.delete("set-cookie");
  headers.delete("transfer-encoding");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store, must-revalidate");
  headers.set("X-Served-By", "speed-worker");
  const body = method === "HEAD" ? null : originResp.body;
  return new Response(body, { status: originResp.status, statusText: originResp.statusText, headers });
}

/* ============================================================
 * Small helpers
 * ============================================================ */
function noStore() {
  const h = new Headers();
  h.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  h.set("pragma", "no-cache");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "no-referrer");
  return h;
}
function json(obj, status) {
  const h = noStore();
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}
function text(s, status) {
  const h = noStore();
  h.set("content-type", "text/plain; charset=utf-8");
  return new Response(s, { status: status || 200, headers: h });
}
function methodNotAllowed(allow) {
  const h = noStore();
  h.set("allow", allow);
  return new Response("Method Not Allowed", { status: 405, headers: h });
}
function preflight() {
  return new Response(null, { status: 204, headers: noStore() });
}

/**
 * CORS. The app is also served from the GitHub Pages site, so a browser sitting
 * on https://www.linearit.co has to be allowed to call these endpoints. Requests
 * from speed.linearit.co itself are same-origin and never need a header.
 */
function cors(request, env, response) {
  const allowed = (env.ALLOW_ORIGIN || "https://www.linearit.co")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("Origin");
  const headers = new Headers(response.headers);
  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
