/**
 * `analytics-worker` — Cloudflare Worker for www.linearit.co
 * ==========================================================
 *
 * Answers the question "who actually visited my site?" for the GitHub Pages
 * site at www.linearit.co. GitHub Pages keeps no logs and gives you no
 * analytics, but every request already passes through Cloudflare, so this
 * Worker sits on that path and writes one row per page view into D1.
 *
 * For each page view it records what the edge already knows — no third-party
 * tracker, no cookie, no consent banner:
 *
 *   path, timestamp, status        what they looked at, and when
 *   IP, country, city, region      where from
 *   ASN + network organisation     WHO — for business visitors this is often
 *                                  the actual company name ("Hudson Valley
 *                                  Dental"), which is the closest thing to a
 *                                  name you can get without a paid tool
 *   user agent, referrer           how they got here
 *
 * It can also inject a Cloudflare Web Analytics beacon into every HTML page
 * (see WEB_ANALYTICS_TOKEN below) so all 88 pages get covered without editing
 * 88 files. If you switched on Web Analytics' *automatic* setup in the
 * dashboard, leave that empty — Cloudflare injects the beacon for you.
 *
 * ---- THE ONE RULE THIS WORKER FOLLOWS -------------------------------------
 * It must never be able to take the site down. It sits in front of the whole
 * of www.linearit.co, so every single code path here fails OPEN: the visitor's
 * response is fetched first and returned no matter what, logging happens after
 * the response is already on its way (ctx.waitUntil), and every optional step
 * is wrapped so that a thrown error degrades to "plain proxy" rather than an
 * error page. If D1 is down, the site still serves. If this script throws, the
 * site still serves.
 *
 * ---- ONE-TIME SETUP (run from this folder) --------------------------------
 *   cd analytics-worker && npm install
 *   npx wrangler d1 create linear_analytics    # paste the id into wrangler.toml
 *   npx wrangler d1 execute linear_analytics --remote --file=./schema.sql
 *   npx wrangler deploy
 *
 * This Worker is completely separate from linear-chat / linear-vault /
 * linear-time / linear-sign / speed-worker: its own folder, its own config,
 * its own database. It shares nothing with them.
 */

// Requests for these are page *furniture*, not page views. Logging them would
// bury the real visits under twenty rows of icons and stylesheets per page.
const SKIP_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|mp3|pdf|zip|txt|xml|json)$/i;

// Crawlers, monitors and preview-link fetchers. They are still logged (you may
// want to see them) but flagged, so the interesting queries can exclude them.
const BOT_UA = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|preview|monitor|uptime|curl|wget|python-requests|headless|lighthouse|pingdom|semrush|ahrefs|dataprovider|scrapy/i;

// Ensure-schema runs at most once per isolate, not once per request.
let schemaReady = false;

export default {
  async fetch(request, env, ctx) {
    // 1. Get the real response first. A same-zone fetch() bypasses this Worker
    //    and goes straight to the GitHub Pages origin, so there is no loop.
    let response;
    try {
      response = await fetch(request);
    } catch (err) {
      // Origin itself failed — nothing to do but let the failure through.
      return new Response("Upstream error", { status: 502 });
    }

    // 2. Optionally inject the Web Analytics beacon into HTML. Wrapped: if the
    //    rewrite throws, the visitor gets the untouched original response.
    try {
      response = injectBeacon(response, env);
    } catch (_) {
      /* keep the original response */
    }

    // 3. Log the visit *after* the response is on its way. Never blocks, and a
    //    failure here is invisible to the visitor.
    try {
      if (shouldLog(request, response)) {
        ctx.waitUntil(logVisit(request, response, env).catch(() => {}));
      }
    } catch (_) {
      /* logging is best-effort, always */
    }

    return response;
  },

  /**
   * Nightly tidy-up so the table cannot grow without bound. D1's free tier is
   * generous but not infinite, and a year-old hit is not worth keeping.
   */
  async scheduled(event, env, ctx) {
    const days = Number(env.RETENTION_DAYS || 90);
    if (!env.DB || !Number.isFinite(days) || days <= 0) return;
    ctx.waitUntil(
      env.DB.prepare(`DELETE FROM visits WHERE ts < datetime('now', ?)`)
        .bind(`-${Math.floor(days)} days`)
        .run()
        .catch(() => {}),
    );
  },
};

/** Only log real page views: GETs for HTML, not assets, not preflights. */
function shouldLog(request, response) {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname;
  if (SKIP_EXT.test(path)) return false;
  const type = response.headers.get("content-type") || "";
  // Count HTML pages, and 404s/redirects too — a burst of 404s is worth seeing.
  return type.includes("text/html") || response.status >= 300;
}

/** Write one row describing this visit. Runs after the response is sent. */
async function logVisit(request, response, env) {
  if (!env.DB) return;
  await ensureSchema(env);

  const url = new URL(request.url);
  const cf = request.cf || {};
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = request.headers.get("user-agent") || "";

  await env.DB.prepare(
    `INSERT INTO visits
       (path, query, ip, country, city, region, asn, org, ua, referer, status, is_bot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      url.pathname.slice(0, 512),
      url.search.slice(0, 512),
      await maybeHash(ip, env),
      cf.country || "",
      cf.city || "",
      cf.region || "",
      Number(cf.asn) || null,
      cf.asOrganization || "",
      ua.slice(0, 512),
      (request.headers.get("referer") || "").slice(0, 512),
      response.status,
      BOT_UA.test(ua) ? 1 : 0,
    )
    .run();
}

/**
 * Storing raw IPs is personal data in most places. Set HASH_IPS = "true" in
 * wrangler.toml to store a salted one-way hash instead: you can still tell
 * "same visitor came back four times" without holding the address itself.
 */
async function maybeHash(ip, env) {
  if (!ip || String(env.HASH_IPS) !== "true") return ip;
  const data = new TextEncoder().encode(`${env.IP_SALT || "linearit"}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Create the table if the schema step was never run. Once per isolate. */
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (datetime('now')), path TEXT NOT NULL, query TEXT, ip TEXT, country TEXT, city TEXT, region TEXT, asn INTEGER, org TEXT, ua TEXT, referer TEXT, status INTEGER, is_bot INTEGER NOT NULL DEFAULT 0)",
  );
  schemaReady = true;
}

/**
 * Add the Cloudflare Web Analytics beacon to every HTML page, so the whole site
 * is covered without touching any of the 88 HTML files in the repo. No-op
 * unless WEB_ANALYTICS_TOKEN is set.
 */
function injectBeacon(response, env) {
  const token = env.WEB_ANALYTICS_TOKEN;
  if (!token) return response;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;

  return new HTMLRewriter()
    .on("head", {
      element(head) {
        head.append(
          `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${token}"}'></script>`,
          { html: true },
        );
      },
    })
    .transform(response);
}
