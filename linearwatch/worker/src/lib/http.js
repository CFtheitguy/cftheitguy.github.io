// HTTP helpers: JSON responses, CORS, and a small typed error for clean control flow.

export const json = (obj, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });

// Thrown by handlers to short-circuit with a specific status + message.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const bad = (msg) => new HttpError(400, msg);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const tooMany = (msg = "Too many requests") => new HttpError(429, msg);

// Resolve the allowed CORS origin for this request. ALLOW_ORIGIN is either "*"
// or a comma-separated allow-list; we echo the request's Origin only if allowed.
export function corsOrigin(env, request) {
  const allow = (env.ALLOW_ORIGIN || "*").trim();
  if (allow === "*") return "*";
  const origin = request.headers.get("Origin") || "";
  const list = allow.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : list[0] || "*";
}

export function withCors(env, request, res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", corsOrigin(env, request));
  h.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Device-Token");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

export function preflight(env, request) {
  return withCors(env, request, new Response(null, { status: 204 }));
}

// Parse the Bearer token from Authorization (used for dashboard sessions).
export function bearer(request) {
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

// Read a JSON body defensively (returns {} on empty/invalid).
export async function readJson(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
