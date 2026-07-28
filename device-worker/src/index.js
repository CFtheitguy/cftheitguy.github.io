/**
 * Linear Device Report — device.linearit.co
 * =============================================================================
 * A thin Cloudflare Worker that serves the device-report page which is hosted on
 * the GitHub Pages site (https://www.linearit.co/device/) under the vanity
 * hostname device.linearit.co.
 *
 * It is a reverse proxy, not a copy: the page lives ONCE in this repo at
 * /device/index.html. Edit that file, push, and the change is live here with no
 * worker redeploy — the worker just fetches it from the site and returns it.
 *
 *   device.linearit.co/            ->  www.linearit.co/device/     (the report)
 *   device.linearit.co/logo.png    ->  www.linearit.co/logo.png    (assets)
 *   device.linearit.co/favicon.png ->  www.linearit.co/favicon.png
 *
 * The worker only ever receives device.linearit.co traffic (that's the only
 * route bound to it), and it fetches the plain GitHub Pages origin, so there is
 * no request loop.
 * =============================================================================
 */

const ORIGIN = "https://www.linearit.co"; // GitHub Pages custom domain (the site)
const APP_PATH = "/device/";              // where the report lives on the site
const EDGE_TTL = 300;                     // seconds Cloudflare may cache the page

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;

    // A static page only answers GET/HEAD.
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    // Map the incoming path onto the origin. The root becomes the report;
    // every other path (assets referenced with absolute URLs like /logo.png)
    // is proxied straight through.
    const path = url.pathname === "/" ? APP_PATH : url.pathname;
    const target = ORIGIN + path + url.search;

    let originResp;
    try {
      originResp = await fetch(target, {
        method: "GET",
        headers: {
          Accept: request.headers.get("Accept") || "*/*",
          "Accept-Encoding": "gzip",
          "User-Agent": request.headers.get("User-Agent") || "linear-device-worker",
        },
        redirect: "follow",
        cf: { cacheEverything: true, cacheTtl: EDGE_TTL },
      });
    } catch (e) {
      return fallback();
    }

    // Upstream problems: show the friendly fallback for the main page, but pass
    // a genuine 404 through for a missing asset.
    if (path === APP_PATH && !originResp.ok) return fallback();
    if (originResp.status === 404) {
      return new Response("Not found", { status: 404 });
    }

    // Rebuild the response with our own headers (strip hop-by-hop / cookies).
    const headers = new Headers(originResp.headers);
    headers.delete("set-cookie");
    headers.delete("transfer-encoding");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("X-Served-By", "linear-device");
    headers.set("Cache-Control", `public, max-age=${EDGE_TTL}`);

    const body = method === "HEAD" ? null : originResp.body;
    return new Response(body, {
      status: originResp.status,
      statusText: originResp.statusText,
      headers,
    });
  },
};

function fallback() {
  const html =
    "<!doctype html><html lang=en><head><meta charset=utf-8>" +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<title>Device Report — Linear IT</title></head>" +
    "<body style='font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#050507;" +
    "color:#eef2f7;text-align:center;padding:14vh 6vw;line-height:1.5'>" +
    "<h1 style='font-weight:600'>Device Report is briefly unavailable</h1>" +
    "<p>Please try again in a moment, or open " +
    "<a style='color:#70f2ff' href='https://www.linearit.co/device/'>www.linearit.co/device/</a>.</p>" +
    "<p style='opacity:.7;margin-top:24px'>Linear IT &middot; " +
    "<a style='color:#70f2ff' href='tel:+18456041462'>(845) 604-1462</a></p>" +
    "</body></html>";
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": "30",
      "cache-control": "no-store",
    },
  });
}
