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
    // 0. The private dashboard. Handled entirely here and never proxied, so
    //    /visits does not exist on GitHub Pages at all — if this Worker is ever
    //    removed the path simply 404s rather than falling open to the public.
    //    Wrapped so a dashboard bug can never affect the rest of the site.
    try {
      const path = new URL(request.url).pathname;
      if (path === "/visits" || path === "/visits/") {
        return await handleVisits(request, env);
      }
    } catch (err) {
      return new Response("Dashboard error", { status: 500 });
    }

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

/* ========================================================================== *
 *  /visits — the private dashboard
 * ========================================================================== */

/**
 * Serves the dashboard behind HTTP Basic auth.
 *
 * The credentials are checked HERE, at the edge, before any HTML is generated.
 * That matters: a username and password embedded in the page's own markup would
 * be readable by anyone who hits View Source, which is no protection at all.
 * Nothing but a 401 leaves this Worker until the caller authenticates.
 *
 * Credentials come from VISITS_USER / VISITS_PASS if those are set as encrypted
 * Worker secrets, otherwise from the defaults below. Because this repo is
 * PUBLIC, the defaults are readable by anyone on GitHub — see the README. To
 * make them private, and without changing any code:
 *
 *   npx wrangler secret put VISITS_USER
 *   npx wrangler secret put VISITS_PASS
 */
async function handleVisits(request, env) {
  const user = env.VISITS_USER || "yes";
  const pass = env.VISITS_PASS || "no";

  if (!authorized(request, user, pass)) {
    return new Response("Authentication required.", {
      status: 401,
      headers: {
        // Makes the browser show its own username/password prompt. Keep the
        // realm plain ASCII: header values are Latin-1, and a stray em dash
        // here throws while building the response — which would turn every
        // unauthenticated request into a 500 instead of a login box.
        "www-authenticate": 'Basic realm="Linear IT site visitors", charset="UTF-8"',
        "content-type": "text/plain; charset=utf-8",
        // Never let this page be cached or indexed anywhere.
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow, noarchive",
      },
    });
  }

  if (!env.DB) return dash("No database bound to this Worker yet.", "");

  const url = new URL(request.url);
  const days = clampDays(url.searchParams.get("days"));
  const showBots = url.searchParams.get("bots") === "1";
  const botClause = showBots ? "" : "AND is_bot = 0";
  const since = `-${days} days`;

  const q = (sql) => env.DB.prepare(sql).bind(since).all();

  const [summary, recent, orgs, pages, referrers] = await Promise.all([
    q(`SELECT COUNT(*) AS views, COUNT(DISTINCT ip) AS people,
              SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) AS bots
       FROM visits WHERE ts > datetime('now', ?)`),
    q(`SELECT ts, path, city, region, country, org, ip, referer, ua, status, is_bot
       FROM visits WHERE ts > datetime('now', ?) ${botClause}
       ORDER BY id DESC LIMIT 200`),
    q(`SELECT org, country, COUNT(*) AS hits, COUNT(DISTINCT ip) AS people,
              MAX(ts) AS last_seen
       FROM visits WHERE ts > datetime('now', ?) ${botClause} AND org != ''
       GROUP BY org ORDER BY hits DESC LIMIT 25`),
    q(`SELECT path, COUNT(*) AS views, COUNT(DISTINCT ip) AS people
       FROM visits WHERE ts > datetime('now', ?) ${botClause}
       GROUP BY path ORDER BY views DESC LIMIT 25`),
    q(`SELECT referer, COUNT(*) AS hits FROM visits
       WHERE ts > datetime('now', ?) ${botClause}
         AND referer != '' AND referer NOT LIKE '%linearit.co%'
       GROUP BY referer ORDER BY hits DESC LIMIT 15`),
  ]);

  const s = (summary.results && summary.results[0]) || {};
  return dash(null, renderDash(s, recent, orgs, pages, referrers, days, showBots));
}

/** Constant-time-ish check of the Basic auth header. */
function authorized(request, user, pass) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch (_) {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass);
}

/** Compares without leaking the answer through how long it took. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clampDays(raw) {
  const n = Number(raw);
  return [1, 7, 30, 90, 365].includes(n) ? n : 30;
}

function dash(message, html) {
  return new Response(message ? layout(`<p class="empty">${esc(message)}</p>`) : html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow, noarchive",
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Escapes text before it goes into the page.
 *
 * This is not cosmetic. User agents, referrers and paths are chosen by the
 * visitor, so a crawler could send a User-Agent containing a <script> tag and
 * have it run in YOUR browser when you open this dashboard. Everything that
 * came from a request gets escaped on the way out.
 */
function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDash(s, recent, orgs, pages, referrers, days, showBots) {
  const rows = (r) => (r && r.results) || [];
  const where = (v) =>
    [v.city, v.region, v.country].filter(Boolean).join(", ") || "—";

  const rangeLinks = [1, 7, 30, 90, 365]
    .map(
      (d) =>
        `<a class="${d === days ? "on" : ""}" href="?days=${d}${showBots ? "&bots=1" : ""}">${
          d === 1 ? "24h" : d === 365 ? "1y" : d + "d"
        }</a>`,
    )
    .join("");

  return layout(`
    <header>
      <h1>Site visitors</h1>
      <div class="controls">
        <nav class="range">${rangeLinks}</nav>
        <a class="toggle" href="?days=${days}${showBots ? "" : "&bots=1"}">${
          showBots ? "Hide bots" : "Show bots"
        }</a>
      </div>
    </header>

    <section class="stats">
      <div class="stat"><b>${esc(s.views || 0)}</b><span>page views</span></div>
      <div class="stat"><b>${esc(s.people || 0)}</b><span>unique visitors</span></div>
      <div class="stat"><b>${esc(s.bots || 0)}</b><span>bot hits</span></div>
      <div class="stat"><b>${esc(days === 1 ? "24h" : days + "d")}</b><span>range</span></div>
    </section>

    ${table(
      "Who — organisations",
      ["Organisation", "Country", "Views", "People", "Last seen"],
      rows(orgs).map((o) => [esc(o.org), esc(o.country), esc(o.hits), esc(o.people), esc(o.last_seen)]),
      "Nothing recorded yet in this range.",
    )}

    ${table(
      "Most-read pages",
      ["Path", "Views", "People"],
      rows(pages).map((p) => [esc(p.path), esc(p.views), esc(p.people)]),
      "No page views recorded yet.",
    )}

    ${table(
      "Referrers",
      ["Came from", "Hits"],
      rows(referrers).map((r) => [esc(r.referer), esc(r.hits)]),
      "No external referrers yet.",
    )}

    ${table(
      "Recent visits",
      ["When", "Path", "Where", "Organisation", "IP", "Status"],
      rows(recent).map((v) => [
        esc(v.ts),
        esc(v.path),
        esc(where(v)),
        esc(v.org) + (v.is_bot ? ' <span class="bot">bot</span>' : ""),
        esc(v.ip),
        esc(v.status),
      ]),
      "No visits recorded yet. Open the site in another tab and refresh this page.",
      true,
    )}
  `);
}

function table(title, headers, bodyRows, emptyMsg, raw = false) {
  if (!bodyRows.length) {
    return `<section><h2>${esc(title)}</h2><p class="empty">${esc(emptyMsg)}</p></section>`;
  }
  return `<section>
    <h2>${esc(title)}</h2>
    <div class="scroll"><table>
      <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${bodyRows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("")}</tbody>
    </table></div>
  </section>`;
}

function layout(inner) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Site visitors — Linear IT</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:#0e1116; color:#e6edf3;
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center;
           justify-content:space-between; margin-bottom:20px; }
  h1 { font-size:20px; margin:0; letter-spacing:-.01em; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em;
       color:#8b949e; margin:28px 0 10px; font-weight:600; }
  .controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .range { display:flex; gap:2px; background:#161b22; padding:3px;
           border-radius:8px; border:1px solid #26303b; }
  .range a, .toggle { color:#8b949e; text-decoration:none; padding:4px 10px;
                      border-radius:6px; font-size:13px; }
  .range a.on { background:#1f6feb; color:#fff; }
  .range a:hover:not(.on), .toggle:hover { color:#e6edf3; }
  .toggle { border:1px solid #26303b; background:#161b22; }
  .stats { display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); }
  .stat { background:#161b22; border:1px solid #26303b; border-radius:10px; padding:14px 16px; }
  .stat b { display:block; font-size:24px; font-weight:600; letter-spacing:-.02em; }
  .stat span { color:#8b949e; font-size:12px; }
  .scroll { overflow-x:auto; border:1px solid #26303b; border-radius:10px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th { text-align:left; padding:9px 12px; background:#161b22; color:#8b949e;
       font-weight:600; white-space:nowrap; border-bottom:1px solid #26303b; }
  td { padding:8px 12px; border-top:1px solid #1c2430; vertical-align:top;
       max-width:340px; overflow-wrap:anywhere; }
  tbody tr:hover { background:#12171e; }
  td:first-child { white-space:nowrap; color:#8b949e; font-variant-numeric:tabular-nums; }
  .bot { font-size:10px; background:#2d2413; color:#d29922; padding:1px 5px;
         border-radius:4px; text-transform:uppercase; letter-spacing:.05em; }
  .empty { color:#8b949e; background:#161b22; border:1px solid #26303b;
           border-radius:10px; padding:16px; margin:0; }
</style>
</head><body>${inner}</body></html>`;
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
