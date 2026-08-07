/**
 * Linear Time — time.linearit.co
 * =============================================================================
 * A tiny time-tracking backend for Linear IT and its client companies.
 *
 * WHAT IT DOES
 * ------------
 * Workers run a small "what are you doing right now?" app (an installable PWA
 * served from the GitHub Pages site at /time/). Each task they start/stop is one
 * row here, stamped with the exact start and end time. At the end of the day an
 * admin opens time.linearit.co and sees a per-day spreadsheet: task, from, to,
 * duration and the daily total — per worker and per company.
 *
 * WHO SIGNS IN (all sign-in is email + a one-time code, sent via Resend)
 *   - Worker       first launch: email + their company's join code + their name.
 *                  After that, just email + code. Tracks their own day only.
 *   - Company admin an email a super-admin added to the `admins` table. Sees the
 *                  reports for that ONE company.
 *   - Super admin  an email in the ADMIN_EMAILS secret. Sees every company,
 *                  creates companies + join codes, and appoints company admins.
 *
 * ROUTES
 *   Non-/api paths              -> reverse-proxied from the GitHub Pages app
 *                                  (APP_ORIGIN + APP_PATH) so time.linearit.co
 *                                  serves the same app as www.linearit.co/time/.
 *   POST /api/auth/start        -> {isSuper,isAdmin,isWorker,name?,company?}
 *   POST /api/auth/code         -> email a one-time sign-in code
 *   POST /api/auth/verify       -> code (+ name & company_code for a new worker)
 *                                  -> { token, profile }
 *   GET  /api/day?day=YYYY-MM-DD  (worker) today's rows + running task + presets
 *   POST /api/task/start          (worker) begin a task (ends any running one)
 *   POST /api/task/end            (worker) end the running task
 *   GET  /api/admin/scope         (admin)  who am I / which companies can I see
 *   GET  /api/admin/report        (admin)  a day's rows for a company (+worker)
 *   GET  /api/admin/workers       (admin)  people in a company
 *   POST /api/admin/worker/rename (admin)  rename a person (scoped to company)
 *   GET  /api/admin/companies     (super)  list companies + join codes
 *   POST /api/admin/companies     (super)  create a company (mints a join code)
 *   POST /api/admin/company/code  (super)  regenerate a company's join code
 *   GET  /api/admin/company-admins  (super) list company admins
 *   POST /api/admin/company-admins  (super) appoint a company admin
 *   DELETE /api/admin/company-admins (super) remove a company admin
 *   GET  /api/health              -> "ok"
 *
 * ENV (secrets, except the [vars] in wrangler.toml)
 *   DB              D1 database binding (required)
 *   AUTH_SECRET     long random string — pepper for hashes, signs session tokens
 *   RESEND_API_KEY  send the code email via Resend (same key linear-chat uses)
 *   EMAIL_FROM      From: address, e.g.  Linear IT <alert@linearit.co>
 *   ADMIN_EMAILS    comma-separated super-admin addresses
 *   ALLOW_ORIGIN    CORS origin for the API (default https://www.linearit.co)
 *   APP_ORIGIN      where the app is hosted (default https://www.linearit.co)
 *   APP_PATH        path of the app on that origin (default /time/)
 *   DEV_MODE = "1"  return the code in the API response (LOCAL TESTING ONLY)
 *
 * BACKGROUND REMINDERS (optional — enables nudges when the app is closed)
 *   VAPID_PUBLIC       Web Push public key, base64url of the raw 65-byte P-256 point
 *   VAPID_PRIVATE_JWK  the matching private key as a JWK JSON string
 *   VAPID_SUBJECT      contact URL, e.g. mailto:admin@linearit.co
 *   (generate all three with: node ../time-worker/gen-vapid.mjs)
 *   A Cron Trigger (see wrangler.toml [triggers]) runs every 5 min and pushes the
 *   30-min check-in / after-5pm wrap-up to whoever is due. If these are unset,
 *   reminders simply fall back to in-app only (the app must be open).
 * =============================================================================
 */

// Sessions are effectively permanent: the worker signs in once at setup and the
// token re-issues on every authed call, so it never expires in normal daily use.
const TOKEN_TTL_MS = 400 * 24 * 60 * 60 * 1000; // ~13 months, sliding
const CODE_TTL_MS = 10 * 60 * 1000;       // one-time code lifetime
const CODE_RESEND_MS = 45 * 1000;         // min gap between code emails to one address
const MAX_CODE_ATTEMPTS = 5;              // wrong codes before a code is burned
const PRESETS = ["breakfast", "exercise", "break"]; // the once-a-day quick picks
const CHECKIN_MS = 30 * 60 * 1000;        // "still on this?" interval
const WRAP_HOUR = 17;                     // 5pm: start asking to wrap up the day
const PUSH_THROTTLE_MS = 25 * 60 * 1000;  // don't re-push a worker more often than this

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return cors(request, env, new Response(null, { status: 204 }));

    try {
      if (p === "/api/health") return cors(request, env, new Response("ok", { status: 200 }));
      if (p.startsWith("/api/")) {
        return cors(request, env, await handleApi(request, env, url, p, method));
      }
      // Everything else: serve the app by reverse-proxying the GitHub Pages copy.
      return proxyApp(request, env, url, method);
    } catch (err) {
      const status = (err && err.status) || 500;
      return cors(request, env, json({ error: String((err && err.message) || err) }, status));
    }
  },

  // Cloudflare Cron Trigger (every 5 min): send background reminders (30-min
  // check-ins + the after-5pm wrap-up) via Web Push, so nudges arrive even when
  // the app window is closed. Configured by `[triggers] crons` in wrangler.toml.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};

/* ============================================================
 * API router
 * ============================================================ */
async function handleApi(request, env, url, p, method) {
  await ensureSchema(env);

  if (p === "/api/auth/start" && method === "POST") return authStart(request, env);
  if (p === "/api/auth/code" && method === "POST") return authCode(request, env);
  if (p === "/api/auth/verify" && method === "POST") return authVerify(request, env);

  // --- worker (tracker) ---
  if (p === "/api/day" && method === "GET") return dayGet(request, env, url);
  if (p === "/api/task/start" && method === "POST") return taskStart(request, env);
  if (p === "/api/task/end" && method === "POST") return taskEnd(request, env);
  if (p === "/api/task/checkin" && method === "POST") return taskCheckin(request, env);
  if (p === "/api/day/end" && method === "POST") return dayEnd(request, env);
  if (p === "/api/day/resume" && method === "POST") return dayResume(request, env);

  // --- background reminders (Web Push) ---
  if (p === "/api/push/key" && method === "GET") return pushKey(request, env);
  if (p === "/api/push/subscribe" && method === "POST") return pushSubscribe(request, env);
  if (p === "/api/push/pending" && method === "POST") return pushPending(request, env);

  // --- admin / reports ---
  if (p === "/api/admin/scope" && method === "GET") return adminScope(request, env);
  if (p === "/api/admin/report" && method === "GET") return adminReport(request, env, url);
  if (p === "/api/admin/workers" && method === "GET") return adminWorkers(request, env, url);
  if (p === "/api/admin/worker/rename" && method === "POST") return renameWorker(request, env);

  // --- super-admin only ---
  if (p === "/api/admin/companies" && method === "GET") return listCompanies(request, env);
  if (p === "/api/admin/companies" && method === "POST") return createCompany(request, env);
  if (p === "/api/admin/company/code" && method === "POST") return regenCode(request, env);
  if (p === "/api/admin/company-admins" && method === "GET") return listAdmins(request, env);
  if (p === "/api/admin/company-admins" && method === "POST") return addAdmin(request, env);
  if (p === "/api/admin/company-admins" && method === "DELETE") return removeAdmin(request, env);

  return json({ error: "Not found" }, 404);
}

/* ============================================================
 * Auth — start: tell the browser what this email is (so it knows whether to
 * ask a new worker for their name + company join code on the code screen).
 * ============================================================ */
async function authStart(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);

  const isSuper = isAdminEmail(env, email);
  const adminRow = await env.DB.prepare(
    "SELECT a.company_id AS cid, c.name AS cname FROM admins a LEFT JOIN companies c ON c.id=a.company_id WHERE a.email=?"
  ).bind(email).first();
  const worker = await env.DB.prepare(
    "SELECT w.name AS name, c.name AS cname FROM workers w LEFT JOIN companies c ON c.id=w.company_id WHERE w.email=?"
  ).bind(email).first();

  return json({
    isSuper,
    isAdmin: !!adminRow,
    isWorker: !!worker,
    name: worker ? worker.name : null,
    company: worker ? worker.cname : (adminRow ? adminRow.cname : null),
  });
}

/* ============================================================
 * Auth — email a one-time sign-in code (proves the address is theirs).
 * Any well-formed email may request one; what it unlocks is decided at verify.
 * ============================================================ */
async function authCode(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);

  const r = await issueCode(env, email);
  if (r.error) return json({ error: r.error }, r.status);
  const out = { ok: true };
  if (r.dev_code) out.dev_code = r.dev_code;
  return json(out);
}

// Generate, store (peppered hash) and email a fresh code. Enforces a resend gap.
async function issueCode(env, email) {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(now).run();

  const recent = await env.DB
    .prepare("SELECT created_at FROM login_codes WHERE email=? AND consumed=0 ORDER BY id DESC LIMIT 1")
    .bind(email).first();
  if (recent && now - Number(recent.created_at) < CODE_RESEND_MS) {
    return { error: "A code was just sent. Please wait a moment before requesting another.", status: 429 };
  }

  await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE email=? AND consumed=0").bind(email).run();

  const code = genCode();
  const codeHash = await hashCode(env, email, code);
  await env.DB
    .prepare("INSERT INTO login_codes (email, code_hash, expires_at, attempts, consumed, created_at) VALUES (?,?,?,0,0,?)")
    .bind(email, codeHash, now + CODE_TTL_MS, now).run();

  const sent = await sendCodeEmail(env, email, code);
  if (env.DEV_MODE === "1") return { ok: true, dev_code: code };
  if (!sent.ok) return { error: "Couldn't send the email — email delivery isn't configured yet.", status: 502 };
  return { ok: true };
}

// Verify (and burn) a fresh code for the email. Returns { ok:true } or { error, status }.
async function consumeCode(env, email, code) {
  if (!/^\d{4,8}$/.test(String(code || ""))) return { error: "Invalid code.", status: 400 };
  const now = Date.now();
  const row = await env.DB
    .prepare("SELECT * FROM login_codes WHERE email=? AND consumed=0 ORDER BY id DESC LIMIT 1")
    .bind(email).first();
  if (!row) return { error: "No active code. Request a new one.", status: 400 };
  if (Number(row.expires_at) < now) return { error: "That code expired. Request a new one.", status: 400 };
  if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) {
    await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE id=?").bind(row.id).run();
    return { error: "Too many attempts. Request a new code.", status: 429 };
  }
  const hash = await hashCode(env, email, code);
  if (!timingSafeEqual(hash, row.code_hash)) {
    await env.DB.prepare("UPDATE login_codes SET attempts=attempts+1 WHERE id=?").bind(row.id).run();
    return { error: "Incorrect code.", status: 401 };
  }
  await env.DB.prepare("UPDATE login_codes SET consumed=1 WHERE id=?").bind(row.id).run();
  return { ok: true };
}

/* ============================================================
 * Auth — verify the code and hand back a session token + profile.
 * Role precedence: super admin (env) > company admin (row) > worker.
 * A brand-new worker must include their name + a valid company join code.
 * ============================================================ */
async function authVerify(request, env) {
  const body = await readBody(request);
  const email = normEmail(body.email);
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);

  const cr = await consumeCode(env, email, body.code);
  if (cr.error) return json({ error: cr.error }, cr.status);

  // Super admin — appointed by the ADMIN_EMAILS secret; sees everything.
  if (isAdminEmail(env, email)) {
    return json({ token: await makeToken(env, { email, kind: "super" }), profile: { email, role: "super" } });
  }

  // Company admin — an email a super-admin added to `admins`.
  const adminRow = await env.DB.prepare(
    "SELECT a.company_id AS cid, c.name AS cname FROM admins a LEFT JOIN companies c ON c.id=a.company_id WHERE a.email=?"
  ).bind(email).first();
  if (adminRow) {
    const claims = { email, kind: "admin", company_id: adminRow.cid };
    return json({
      token: await makeToken(env, claims),
      profile: { email, role: "admin", company_id: adminRow.cid, company_name: adminRow.cname || "" },
    });
  }

  // Existing worker — welcome back.
  let worker = await env.DB.prepare(
    "SELECT w.name AS name, w.company_id AS cid, c.name AS cname FROM workers w LEFT JOIN companies c ON c.id=w.company_id WHERE w.email=?"
  ).bind(email).first();

  // New worker — must supply their name + a valid company join code.
  if (!worker) {
    const name = String(body.name || "").trim().slice(0, 80);
    const code = String(body.company_code || "").trim().toUpperCase();
    if (!name) return json({ error: "Please enter your name.", need: "profile" }, 400);
    if (!code) return json({ error: "Enter your company code (ask your manager).", need: "profile" }, 400);
    const company = await env.DB.prepare("SELECT id, name FROM companies WHERE code=?").bind(code).first();
    if (!company) return json({ error: "That company code isn't valid. Check with your manager.", need: "profile" }, 404);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO workers (email, name, company_id, tz_offset, created_at, last_seen_at) VALUES (?,?,?,?,?,?)"
    ).bind(email, name, company.id, tzOffset(body), now, now).run();
    worker = { name, cid: company.id, cname: company.name };
  } else {
    await env.DB.prepare("UPDATE workers SET last_seen_at=?, tz_offset=? WHERE email=?")
      .bind(Date.now(), tzOffset(body), email).run();
  }

  const claims = { email, kind: "user", company_id: worker.cid, name: worker.name };
  return json({
    token: await makeToken(env, claims),
    profile: { email, role: "worker", name: worker.name, company_id: worker.cid, company_name: worker.cname || "" },
  });
}

/* ============================================================
 * Worker — the tracker's day: rows for `day`, the running task (if any, even
 * from a previous day), and which once-a-day presets are already used today.
 * ============================================================ */
async function dayGet(request, env, url) {
  const claims = await requireUser(request, env);
  const day = validDay(url.searchParams.get("day"));
  if (!day) return json({ error: "Bad day." }, 400);

  const rows = (await env.DB.prepare(
    "SELECT id, task, preset, started_at, ended_at, checkin_at FROM entries WHERE email=? AND day=? ORDER BY started_at"
  ).bind(claims.email, day).all()).results || [];

  const running = await env.DB.prepare(
    "SELECT id, task, preset, started_at, ended_at, checkin_at, day FROM entries WHERE email=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
  ).bind(claims.email).first();

  const ended = await env.DB.prepare("SELECT 1 FROM day_end WHERE email=? AND day=?").bind(claims.email, day).first();
  const presetsUsed = rows.filter((r) => r.preset).map((r) => r.preset);
  return json({
    token: await reissue(env, claims),
    profile: { email: claims.email, name: claims.name || "", company_id: claims.company_id, role: "worker" },
    day,
    entries: rows.map(cleanEntry),
    running: running ? cleanEntry(running) : null,
    presetsUsed: [...new Set(presetsUsed)],
    presets: PRESETS,
    dayEnded: !!ended,
    wrapHour: WRAP_HOUR,
    serverNow: Date.now(),
  });
}

async function taskStart(request, env) {
  const claims = await requireUser(request, env);
  const body = await readBody(request);
  const day = validDay(body.day);
  const task = String(body.task || "").trim().slice(0, 120);
  let preset = body.preset ? String(body.preset).toLowerCase() : null;
  if (!day) return json({ error: "Bad day." }, 400);
  if (preset && !PRESETS.includes(preset)) preset = null;
  if (!task) return json({ error: "Please name the task." }, 400);

  const now = Date.now();
  // A preset is a once-a-day pick — refuse a duplicate (the UI also hides it).
  if (preset) {
    const dupe = await env.DB.prepare(
      "SELECT 1 FROM entries WHERE email=? AND day=? AND preset=? LIMIT 1"
    ).bind(claims.email, day, preset).first();
    if (dupe) return json({ error: "You've already logged " + preset + " today." }, 409);
  }

  // End any task still running before starting the next (a shift has one active task).
  await env.DB.prepare("UPDATE entries SET ended_at=? WHERE email=? AND ended_at IS NULL")
    .bind(now, claims.email).run();
  // Starting work reopens the day if it had been ended earlier.
  await env.DB.prepare("DELETE FROM day_end WHERE email=? AND day=?").bind(claims.email, day).run();

  const res = await env.DB.prepare(
    "INSERT INTO entries (email, company_id, day, task, preset, started_at, ended_at, checkin_at, created_at) VALUES (?,?,?,?,?,?,NULL,?,?)"
  ).bind(claims.email, claims.company_id, day, task, preset, now, now + CHECKIN_MS, now).run();

  return json({ token: await reissue(env, claims), id: res.meta && res.meta.last_row_id, startedAt: now, checkinAt: now + CHECKIN_MS });
}

async function taskEnd(request, env) {
  const claims = await requireUser(request, env);
  const now = Date.now();
  const res = await env.DB.prepare("UPDATE entries SET ended_at=? WHERE email=? AND ended_at IS NULL")
    .bind(now, claims.email).run();
  return json({ token: await reissue(env, claims), endedAt: now, ended: (res.meta && res.meta.changes) || 0 });
}

// "Yes, keep going" — push the next check-in out another interval.
async function taskCheckin(request, env) {
  const claims = await requireUser(request, env);
  const next = Date.now() + CHECKIN_MS;
  const res = await env.DB.prepare("UPDATE entries SET checkin_at=? WHERE email=? AND ended_at IS NULL")
    .bind(next, claims.email).run();
  return json({ token: await reissue(env, claims), checkinAt: next, updated: (res.meta && res.meta.changes) || 0 });
}

// End the whole day: close any running task and mark the day done (so the
// after-5pm nudges stop). The worker can always reopen it by starting a task.
async function dayEnd(request, env) {
  const claims = await requireUser(request, env);
  const body = await readBody(request);
  const day = validDay(body.day);
  if (!day) return json({ error: "Bad day." }, 400);
  const now = Date.now();
  await env.DB.prepare("UPDATE entries SET ended_at=? WHERE email=? AND ended_at IS NULL").bind(now, claims.email).run();
  await env.DB.prepare("INSERT OR REPLACE INTO day_end (email, day, ended_at) VALUES (?,?,?)").bind(claims.email, day, now).run();
  return json({ token: await reissue(env, claims), endedAt: now });
}

async function dayResume(request, env) {
  const claims = await requireUser(request, env);
  const body = await readBody(request);
  const day = validDay(body.day);
  if (!day) return json({ error: "Bad day." }, 400);
  await env.DB.prepare("DELETE FROM day_end WHERE email=? AND day=?").bind(claims.email, day).run();
  return json({ token: await reissue(env, claims), ok: true });
}

/* ============================================================
 * Background reminders — Web Push subscriptions + what's "due"
 * ============================================================ */
async function pushKey(request, env) {
  return json({ key: env.VAPID_PUBLIC || "" });
}

async function pushSubscribe(request, env) {
  const claims = await requireUser(request, env);
  const body = await readBody(request);
  const sub = body.sub;
  if (!sub || !sub.endpoint) return json({ error: "Bad subscription." }, 400);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO push_subs (email, endpoint, sub, tz_offset, last_push_at, updated_at) VALUES (?,?,?,?,0,?) " +
    "ON CONFLICT(email) DO UPDATE SET endpoint=excluded.endpoint, sub=excluded.sub, tz_offset=excluded.tz_offset, updated_at=excluded.updated_at"
  ).bind(claims.email, String(sub.endpoint), JSON.stringify(sub), tzOffset(body), now).run();
  await env.DB.prepare("UPDATE workers SET tz_offset=? WHERE email=?").bind(tzOffset(body), claims.email).run();
  return json({ token: await reissue(env, claims), ok: true });
}

// The service worker calls this after a (payload-less) push to learn what to show.
async function pushPending(request, env) {
  const claims = await requireUser(request, env);
  const w = await env.DB.prepare("SELECT tz_offset FROM workers WHERE email=?").bind(claims.email).first();
  const pend = await computePending(env, claims.email, Date.now(), w ? Number(w.tz_offset) || 0 : 0);
  return json(Object.assign({ token: await reissue(env, claims) }, pend));
}

// Decide whether a worker is due for a nudge right now (shared by the SW endpoint
// and the cron sender). Returns { show, type, title, body }.
async function computePending(env, email, now, tzOff) {
  const running = await env.DB.prepare(
    "SELECT task, checkin_at FROM entries WHERE email=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
  ).bind(email).first();

  if (running && running.checkin_at && now >= Number(running.checkin_at)) {
    return { show: true, type: "checkin", title: "Still working on “" + running.task + "”?",
      body: "Open Linear Time to keep going or switch tasks." };
  }

  const localMs = now - (tzOff || 0) * 60000;
  const hour = new Date(localMs).getUTCHours();
  const localDay = ymdUTC(localMs);
  const ended = await env.DB.prepare("SELECT 1 FROM day_end WHERE email=? AND day=?").bind(email, localDay).first();
  if (!ended && hour >= WRAP_HOUR) {
    return { show: true, type: "wrap", title: "Wrap up your day?",
      body: "It’s after 5:00 PM — end your day in Linear Time, or keep going." };
  }
  return { show: false };
}

/* ============================================================
 * Cron sender — walk subscriptions, push a reminder to anyone due
 * ============================================================ */
async function runReminders(env) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE_JWK) return; // push not configured yet
  await ensureSchema(env);
  const subs = (await env.DB.prepare("SELECT email, endpoint, tz_offset, last_push_at FROM push_subs").all()).results || [];
  const now = Date.now();
  for (const s of subs) {
    try {
      if (now - Number(s.last_push_at || 0) < PUSH_THROTTLE_MS) continue;
      const pend = await computePending(env, s.email, now, Number(s.tz_offset) || 0);
      if (!pend.show) continue;
      const status = await sendPush(env, s.endpoint);
      if (status === 404 || status === 410) {
        await env.DB.prepare("DELETE FROM push_subs WHERE email=?").bind(s.email).run();
      } else {
        await env.DB.prepare("UPDATE push_subs SET last_push_at=? WHERE email=?").bind(now, s.email).run();
      }
    } catch (_) { /* one bad subscription shouldn't stop the rest */ }
  }
}

// Send a payload-less Web Push (a "tickle"); the service worker then fetches
// /api/push/pending to learn the message. Payload-less avoids RFC 8291 body
// encryption — we only need the VAPID (RFC 8292) auth JWT.
let vapidKeyPromise = null;
async function importVapidKey(env) {
  if (!vapidKeyPromise) {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    vapidKeyPromise = crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  return vapidKeyPromise;
}
async function vapidJWT(env, audience) {
  const key = await importVapidKey(env);
  const header = b64urlStr(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64urlStr(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:admin@linearit.co",
  }));
  const input = header + "." + payload;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return input + "." + b64url(sig);
}
async function sendPush(env, endpoint) {
  const jwt = await vapidJWT(env, new URL(endpoint).origin);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC,
      TTL: "1800",
      Urgency: "normal",
    },
  });
  return res.status;
}

/* ============================================================
 * Admin — scope: who am I and which companies can I see.
 * ============================================================ */
async function adminScope(request, env) {
  const claims = await requireAdmin(request, env);
  if (claims.kind === "super") {
    const companies = (await env.DB.prepare(
      "SELECT c.id, c.name, c.code, (SELECT COUNT(*) FROM workers w WHERE w.company_id=c.id) AS workers " +
      "FROM companies c ORDER BY c.name"
    ).all()).results || [];
    return json({ token: await reissue(env, claims), role: "super", email: claims.email, companies });
  }
  const company = await env.DB.prepare("SELECT id, name FROM companies WHERE id=?").bind(claims.company_id).first();
  return json({
    token: await reissue(env, claims),
    role: "admin",
    email: claims.email,
    companies: company ? [{ id: company.id, name: company.name }] : [],
  });
}

// A company_id the caller is actually allowed to read. Super: any (or all if blank).
// Company admin: always forced to their own company.
function scopeCompany(claims, requested) {
  if (claims.kind === "super") return requested ? String(requested) : null; // null = all companies
  return claims.company_id;
}

async function adminReport(request, env, url) {
  const claims = await requireAdmin(request, env);
  const day = validDay(url.searchParams.get("day"));
  if (!day) return json({ error: "Bad day." }, 400);
  const companyId = scopeCompany(claims, url.searchParams.get("company_id"));
  const emailFilter = normEmail(url.searchParams.get("email") || "");

  const where = ["e.day=?"];
  const args = [day];
  if (companyId) { where.push("e.company_id=?"); args.push(companyId); }
  if (emailFilter && validEmail(emailFilter)) { where.push("e.email=?"); args.push(emailFilter); }

  const rows = (await env.DB.prepare(
    "SELECT e.id, e.email, e.company_id, e.task, e.preset, e.started_at, e.ended_at, " +
    "w.name AS worker_name, c.name AS company_name " +
    "FROM entries e LEFT JOIN workers w ON w.email=e.email LEFT JOIN companies c ON c.id=e.company_id " +
    "WHERE " + where.join(" AND ") + " ORDER BY e.email, e.started_at"
  ).bind(...args).all()).results || [];

  return json({
    token: await reissue(env, claims),
    day,
    rows: rows.map((r) => ({
      id: r.id, email: r.email, worker: r.worker_name || r.email,
      company_id: r.company_id, company: r.company_name || "",
      task: r.task, preset: r.preset || null,
      started_at: Number(r.started_at), ended_at: r.ended_at == null ? null : Number(r.ended_at),
    })),
    serverNow: Date.now(),
  });
}

async function adminWorkers(request, env, url) {
  const claims = await requireAdmin(request, env);
  const companyId = scopeCompany(claims, url.searchParams.get("company_id"));
  const where = companyId ? "WHERE w.company_id=?" : "";
  const stmt = env.DB.prepare(
    "SELECT w.email, w.name, w.company_id, w.last_seen_at, c.name AS company_name " +
    "FROM workers w LEFT JOIN companies c ON c.id=w.company_id " + where + " ORDER BY w.name"
  );
  const rows = (await (companyId ? stmt.bind(companyId) : stmt).all()).results || [];
  return json({
    token: await reissue(env, claims),
    workers: rows.map((r) => ({
      email: r.email, name: r.name, company_id: r.company_id,
      company: r.company_name || "", last_seen_at: Number(r.last_seen_at) || 0,
    })),
  });
}

// Rename a worker's display name. Company admins may only rename someone in
// their own company; a super admin may rename anyone. Reports read the name live
// from this row, so the change shows up everywhere at once.
async function renameWorker(request, env) {
  const claims = await requireAdmin(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  const name = String(body.name || "").trim().slice(0, 80);
  if (!validEmail(email)) return json({ error: "Invalid email." }, 400);
  if (!name) return json({ error: "Enter a name." }, 400);
  const worker = await env.DB.prepare("SELECT company_id FROM workers WHERE email=?").bind(email).first();
  if (!worker) return json({ error: "Worker not found." }, 404);
  if (claims.kind !== "super" && worker.company_id !== claims.company_id) {
    return json({ error: "That person isn't in your company." }, 403);
  }
  await env.DB.prepare("UPDATE workers SET name=? WHERE email=?").bind(name, email).run();
  return json({ token: await reissue(env, claims), ok: true });
}

/* ============================================================
 * Super-admin — companies & join codes
 * ============================================================ */
async function listCompanies(request, env) {
  const claims = await requireSuper(request, env);
  const rows = (await env.DB.prepare(
    "SELECT c.id, c.name, c.code, c.created_at, " +
    "(SELECT COUNT(*) FROM workers w WHERE w.company_id=c.id) AS workers, " +
    "(SELECT COUNT(*) FROM admins a WHERE a.company_id=c.id) AS admins " +
    "FROM companies c ORDER BY c.name"
  ).all()).results || [];
  return json({ token: await reissue(env, claims), companies: rows });
}

async function createCompany(request, env) {
  const claims = await requireSuper(request, env);
  const body = await readBody(request);
  const name = String(body.name || "").trim().slice(0, 100);
  if (!name) return json({ error: "Enter a company name." }, 400);
  const id = genId();
  const code = await uniqueCode(env);
  await env.DB.prepare("INSERT INTO companies (id, name, code, created_at) VALUES (?,?,?,?)")
    .bind(id, name, code, Date.now()).run();
  return json({ token: await reissue(env, claims), company: { id, name, code } });
}

async function regenCode(request, env) {
  const claims = await requireSuper(request, env);
  const body = await readBody(request);
  const id = String(body.company_id || "");
  const exists = await env.DB.prepare("SELECT 1 FROM companies WHERE id=?").bind(id).first();
  if (!exists) return json({ error: "Company not found." }, 404);
  const code = await uniqueCode(env);
  await env.DB.prepare("UPDATE companies SET code=? WHERE id=?").bind(code, id).run();
  return json({ token: await reissue(env, claims), code });
}

async function listAdmins(request, env) {
  const claims = await requireSuper(request, env);
  const rows = (await env.DB.prepare(
    "SELECT a.email, a.company_id, a.created_at, c.name AS company_name " +
    "FROM admins a LEFT JOIN companies c ON c.id=a.company_id ORDER BY c.name, a.email"
  ).all()).results || [];
  return json({ token: await reissue(env, claims), admins: rows });
}

async function addAdmin(request, env) {
  const claims = await requireSuper(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  const companyId = String(body.company_id || "");
  if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
  if (isAdminEmail(env, email)) return json({ error: "That address is already a super-admin." }, 409);
  const company = await env.DB.prepare("SELECT 1 FROM companies WHERE id=?").bind(companyId).first();
  if (!company) return json({ error: "Pick a company first." }, 404);
  await env.DB.prepare(
    "INSERT INTO admins (email, company_id, added_by, created_at) VALUES (?,?,?,?) " +
    "ON CONFLICT(email) DO UPDATE SET company_id=excluded.company_id"
  ).bind(email, companyId, claims.email, Date.now()).run();
  return json({ token: await reissue(env, claims), ok: true });
}

async function removeAdmin(request, env) {
  const claims = await requireSuper(request, env);
  const body = await readBody(request);
  const email = normEmail(body.email);
  await env.DB.prepare("DELETE FROM admins WHERE email=?").bind(email).run();
  return json({ token: await reissue(env, claims), ok: true });
}

/* ============================================================
 * Auth token helpers (HMAC-signed, sliding expiry)
 * ============================================================ */
async function requireUser(request, env) {
  const c = await authClaims(request, env);
  if (!c || c.kind !== "user") throw httpError("Please sign in again.", 401);
  return c;
}
async function requireAdmin(request, env) {
  const c = await authClaims(request, env);
  if (!c || (c.kind !== "admin" && c.kind !== "super")) throw httpError("Admin sign-in required.", 401);
  if (c.kind === "super" && !isAdminEmail(env, c.email)) throw httpError("Admin sign-in required.", 401);
  return c;
}
async function requireSuper(request, env) {
  const c = await authClaims(request, env);
  if (!c || c.kind !== "super" || !isAdminEmail(env, c.email)) throw httpError("Super-admin sign-in required.", 401);
  return c;
}
async function reissue(env, claims) {
  const { exp, ...rest } = claims; // drop the old exp; makeToken stamps a fresh one
  return makeToken(env, rest);
}
async function makeToken(env, claims) {
  const payload = b64urlStr(JSON.stringify(Object.assign({ exp: Date.now() + TOKEN_TTL_MS }, claims)));
  return payload + "." + (await hmacSign(env, payload));
}
async function authClaims(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(await hmacSign(env, payload), sig)) return null;
  try {
    const claims = JSON.parse(b64urlDecodeToStr(payload));
    if (!claims.exp || claims.exp < Date.now() || !claims.email) return null;
    return claims;
  } catch (_) { return null; }
}

/* ============================================================
 * Crypto / encoding
 * ============================================================ */
async function hmacSign(env, data) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.AUTH_SECRET || "dev-secret"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(sig);
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hashCode(env, email, code) {
  return sha256Hex((env.AUTH_SECRET || "dev-secret") + "|code|" + email + "|" + code);
}
function genCode() { return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0"); }
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function b64url(bytes) {
  const s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlStr(str) { return b64url(new TextEncoder().encode(str)); }
function b64urlDecodeToStr(b64) {
  let s = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
// Short opaque company id, e.g. "k3f9a1c2".
function genId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// Human-friendly join code: 6 chars, no ambiguous 0/O/1/I/L.
function genCompanyCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => alphabet[x % alphabet.length]).join("");
}
async function uniqueCode(env) {
  for (let i = 0; i < 8; i++) {
    const code = genCompanyCode();
    const clash = await env.DB.prepare("SELECT 1 FROM companies WHERE code=?").bind(code).first();
    if (!clash) return code;
  }
  return genCompanyCode() + genCompanyCode().slice(0, 2);
}

/* ============================================================
 * Email (Resend) — same provider linear-chat / linear-vault use
 * ============================================================ */
async function sendCodeEmail(env, email, code) {
  return sendEmail(env, {
    to: email,
    subject: "Your Linear Time code: " + code,
    text: "Your Linear Time sign-in code is " + code +
      "\n\nThis code expires in 10 minutes. If you didn't request it, you can ignore this email.",
    html: codeEmailHtml(code),
  });
}
function codeEmailHtml(code) {
  return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:440px;margin:auto;padding:24px">' +
    '<h2 style="margin:0 0 4px;color:#111">Linear IT — Time Tracker</h2>' +
    '<p style="color:#444;margin:0 0 16px">Use this code to sign in:</p>' +
    '<div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f3f4f6;border-radius:12px;padding:16px;text-align:center;color:#111">' + code + "</div>" +
    '<p style="color:#888;font-size:13px;margin:16px 0 0">This code expires in 10 minutes. If you didn\'t request it, you can ignore this email.</p>' +
    '<p style="color:#aab;font-size:12px;margin:14px 0 0">Linear IT · (845) 604-1462</p>' +
    "</div>";
}
async function sendEmail(env, msg) {
  if (!env.RESEND_API_KEY) return { ok: false, reason: "RESEND_API_KEY is not set on the Worker" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "Linear IT <alert@linearit.co>",
        to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html,
      }),
    });
    if (res.ok) return { ok: true };
    let body = "";
    try { body = JSON.stringify(await res.json()); } catch (_) { try { body = await res.text(); } catch (_2) { body = ""; } }
    console.error("Resend send failed", res.status, body);
    return { ok: false, reason: "Resend HTTP " + res.status + " " + body };
  } catch (e) {
    console.error("Resend fetch error", e);
    return { ok: false, reason: "fetch error: " + String((e && e.message) || e) };
  }
}

/* ============================================================
 * Reverse-proxy the app from GitHub Pages (so time.linearit.co serves it)
 * ============================================================ */
async function proxyApp(request, env, url, method) {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const origin = env.APP_ORIGIN || "https://www.linearit.co";
  const appPath = env.APP_PATH || "/time/";
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
    return new Response("Linear Time is briefly unavailable. Please try again in a moment.", {
      status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "20" },
    });
  }
  if (originResp.status === 404) return new Response("Not found", { status: 404 });

  const headers = new Headers(originResp.headers);
  headers.delete("set-cookie");
  headers.delete("transfer-encoding");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store, must-revalidate");
  headers.set("X-Served-By", "linear-time");
  // The service worker must be allowed to control the app root when installed.
  if (url.pathname.endsWith("/sw.js")) headers.set("Service-Worker-Allowed", "/");
  const body = method === "HEAD" ? null : originResp.body;
  return new Response(body, { status: originResp.status, statusText: originResp.statusText, headers });
}

/* ============================================================
 * Small helpers
 * ============================================================ */
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
function validDay(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) ? String(d) : null; }
function cleanEntry(r) {
  return {
    id: r.id, task: r.task, preset: r.preset || null,
    started_at: Number(r.started_at),
    ended_at: r.ended_at == null ? null : Number(r.ended_at),
    checkin_at: r.checkin_at == null ? null : Number(r.checkin_at),
    day: r.day,
  };
}
// Client sends its UTC offset in minutes (Date.getTimezoneOffset()); clamp it.
function tzOffset(body) {
  const n = Number(body && body.tz_offset);
  return Number.isFinite(n) && n >= -900 && n <= 900 ? Math.round(n) : 0;
}
function ymdUTC(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function adminEmailSet(env) {
  return String(env.ADMIN_EMAILS || "").split(",").map((e) => normEmail(e)).filter(Boolean);
}
function isAdminEmail(env, email) { return adminEmailSet(env).includes(normEmail(email)); }
function httpError(message, status) { const e = new Error(message); e.status = status; return e; }
async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) { try { return await request.json(); } catch (_) { return {}; } }
  try { const fd = await request.formData(); return Object.fromEntries(fd.entries()); } catch (_) { return {}; }
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// CORS: allow the GitHub Pages app origin (and same-origin time.linearit.co).
function cors(request, env, res) {
  const allowed = [
    env.ALLOW_ORIGIN || "https://www.linearit.co",
    "https://www.linearit.co",
    "https://cftheitguy.github.io",
    "https://time.linearit.co",
  ];
  const origin = request.headers.get("Origin") || "";
  const allow = allowed.includes(origin) ? origin : (env.ALLOW_ORIGIN || "https://www.linearit.co");
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", allow);
  h.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

/* ============================================================
 * Schema — created on first request (no manual migration step)
 * ============================================================ */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS companies (" +
      "id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS admins (" +
      "email TEXT PRIMARY KEY, company_id TEXT NOT NULL, added_by TEXT, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS workers (" +
      "email TEXT PRIMARY KEY, name TEXT NOT NULL, company_id TEXT NOT NULL, tz_offset INTEGER NOT NULL DEFAULT 0, " +
      "created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS entries (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, company_id TEXT NOT NULL, " +
      "day TEXT NOT NULL, task TEXT NOT NULL, preset TEXT, " +
      "started_at INTEGER NOT NULL, ended_at INTEGER, checkin_at INTEGER, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS login_codes (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL, " +
      "expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, " +
      "consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS day_end (" +
      "email TEXT NOT NULL, day TEXT NOT NULL, ended_at INTEGER NOT NULL, PRIMARY KEY (email, day))"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS push_subs (" +
      "email TEXT PRIMARY KEY, endpoint TEXT NOT NULL, sub TEXT NOT NULL, " +
      "tz_offset INTEGER NOT NULL DEFAULT 0, last_push_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_entries_email_day ON entries(email, day)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_entries_company_day ON entries(company_id, day)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_entries_running ON entries(email, ended_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_codes_email ON login_codes(email)"),
  ]);
  // Add columns that may be missing on a database created by an earlier version.
  // (On a fresh DB the CREATEs above already include them, so these ALTERs no-op.)
  for (const alt of [
    "ALTER TABLE workers ADD COLUMN tz_offset INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE entries ADD COLUMN checkin_at INTEGER",
  ]) { try { await env.DB.prepare(alt).run(); } catch (_) { /* already exists */ } }
  schemaReady = true;
}
