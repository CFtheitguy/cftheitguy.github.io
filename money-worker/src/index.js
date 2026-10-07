/**
 * Money API — single-user sync backend for www.linearit.co/money/
 *
 * Auth: POST /api/login {password} is checked against the APP_PASSWORD secret;
 * returns an HMAC-signed token (AUTH_SECRET) valid for 30 days.
 * Data: transactions + monthly budgets in D1.
 */
const TOKEN_DAYS = 30;
const enc = new TextEncoder();

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tx (id TEXT PRIMARY KEY, descr TEXT NOT NULL, amount REAL NOT NULL, type TEXT NOT NULL, cat TEXT NOT NULL, date TEXT NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS budgets (month TEXT PRIMARY KEY, amount REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_fails (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, first INTEGER NOT NULL)`,
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(request, env, new Response(null, { status: 204 }));
    try {
      await ensureSchema(env);
      return cors(request, env, await route(request, env, url));
    } catch (e) {
      return cors(request, env, json({ error: "server_error" }, 500));
    }
  },
};

async function route(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "");
  const m = request.method;
  if (p === "/api/health") return new Response("ok");
  if (p === "/api/login" && m === "POST") return login(request, env);

  if (!(await verifyToken(env, bearer(request)))) return json({ error: "unauthorized" }, 401);

  if (p === "/api/data" && m === "GET") return getData(env);
  if (p === "/api/data" && m === "PUT") return replaceData(env, await request.json());

  let mt = p.match(/^\/api\/tx\/([\w.-]{1,64})$/);
  if (mt && m === "PUT") {
    const t = cleanTx({ ...(await request.json()), id: mt[1] });
    if (!t) return json({ error: "invalid" }, 400);
    await upsertTx(env, t).run();
    return json({ ok: true });
  }
  if (mt && m === "DELETE") {
    await env.DB.prepare("DELETE FROM tx WHERE id = ?").bind(mt[1]).run();
    return json({ ok: true });
  }
  mt = p.match(/^\/api\/budget\/(\d{4}-\d{2})$/);
  if (mt && m === "PUT") {
    const { amount } = await request.json();
    if (amount === null || amount === "" || amount === undefined) {
      await env.DB.prepare("DELETE FROM budgets WHERE month = ?").bind(mt[1]).run();
    } else {
      const a = Number(amount);
      if (!isFinite(a) || a < 0) return json({ error: "invalid" }, 400);
      await env.DB.prepare("INSERT INTO budgets (month, amount) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET amount = excluded.amount").bind(mt[1], a).run();
    }
    return json({ ok: true });
  }
  return json({ error: "not_found" }, 404);
}

// ---------- auth ----------
async function login(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, first FROM login_fails WHERE ip = ?").bind(ip).first();
  if (row && now - row.first < 15 * 60e3 && row.count >= 10) return json({ error: "too_many_attempts" }, 429);

  let body = {};
  try { body = await request.json(); } catch {}
  const ok = env.APP_PASSWORD && typeof body.password === "string" && (await safeEqual(body.password, env.APP_PASSWORD));
  if (!ok) {
    if (!row || now - row.first >= 15 * 60e3) {
      await env.DB.prepare("INSERT INTO login_fails (ip, count, first) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET count = 1, first = excluded.first").bind(ip, now).run();
    } else {
      await env.DB.prepare("UPDATE login_fails SET count = count + 1 WHERE ip = ?").bind(ip).run();
    }
    return json({ error: "wrong_password" }, 401);
  }
  await env.DB.prepare("DELETE FROM login_fails WHERE ip = ?").bind(ip).run();
  const exp = now + TOKEN_DAYS * 864e5;
  return json({ token: `${exp}.${await sign(env, String(exp))}`, exp });
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

async function verifyToken(env, token) {
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEqual(sig, await sign(env, exp));
}

async function hmacKey(env) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error("AUTH_SECRET missing or too short");
  return crypto.subtle.importKey("raw", enc.encode(env.AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function sign(env, msg) {
  const s = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function safeEqual(a, b) {
  // Compare digests so length differences don't leak through timing.
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest("SHA-256", enc.encode(v))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

// ---------- data ----------
function cleanTx(t) {
  if (!t || typeof t !== "object") return null;
  const id = String(t.id || "");
  const amount = Number(t.amount);
  if (!/^[\w.-]{1,64}$/.test(id) || !isFinite(amount) || amount <= 0) return null;
  if (t.type !== "in" && t.type !== "out") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.date))) return null;
  return { id, desc: String(t.desc || "").slice(0, 200), amount, type: t.type, cat: String(t.cat || "Other").slice(0, 50), date: t.date };
}
function upsertTx(env, t) {
  return env.DB.prepare(
    "INSERT INTO tx (id, descr, amount, type, cat, date, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET descr=excluded.descr, amount=excluded.amount, type=excluded.type, cat=excluded.cat, date=excluded.date, updated=excluded.updated"
  ).bind(t.id, t.desc, t.amount, t.type, t.cat, t.date, Date.now());
}

async function getData(env) {
  const [tx, b] = await env.DB.batch([
    env.DB.prepare("SELECT id, descr AS desc, amount, type, cat, date FROM tx ORDER BY date DESC"),
    env.DB.prepare("SELECT month, amount FROM budgets"),
  ]);
  const budgets = {};
  for (const r of b.results) budgets[r.month] = r.amount;
  return json({ tx: tx.results, budgets });
}

async function replaceData(env, d) {
  if (!d || !Array.isArray(d.tx)) return json({ error: "invalid" }, 400);
  const txs = d.tx.map(cleanTx).filter(Boolean);
  const stmts = [env.DB.prepare("DELETE FROM tx"), env.DB.prepare("DELETE FROM budgets")];
  for (const t of txs) stmts.push(upsertTx(env, t));
  for (const [month, amount] of Object.entries(d.budgets || {})) {
    if (/^\d{4}-\d{2}$/.test(month) && isFinite(Number(amount)) && Number(amount) >= 0)
      stmts.push(env.DB.prepare("INSERT INTO budgets (month, amount) VALUES (?, ?)").bind(month, Number(amount)));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, count: txs.length });
}

// ---------- helpers ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
function cors(request, env, res) {
  const origin = request.headers.get("Origin");
  const h = new Headers(res.headers);
  const allowed = [env.ALLOW_ORIGIN, "https://linearit.co"];
  if (origin && allowed.includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    h.set("Access-Control-Max-Age", "86400");
  }
  return new Response(res.body, { status: res.status, headers: h });
}
