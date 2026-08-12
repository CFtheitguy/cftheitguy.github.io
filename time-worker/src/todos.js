/**
 * todos.js — Linear To-Do
 * =============================================================================
 * The to-do half of the linear-time Worker: lists, tasks, steps, reminders and
 * the two remote front doors (email + SMS). It shares the Worker's D1 database,
 * its email-code sign-in and its Web Push plumbing — a to-do is keyed by the
 * person's email address, so workers, company admins and super admins all get
 * their own list with the same sign-in they already use.
 *
 * WHAT A TASK CARRIES
 *   title · notes · list · due date (with or without a time) · reminder ·
 *   repeat · priority · important star · #tags · steps (sub-tasks) · My Day
 *
 * SMART VIEWS (computed, not stored)
 *   myday · today · overdue · planned · important · all · completed · list:<id>
 *
 * HOW TASKS ARRIVE
 *   1. The app — a quick-add box that speaks the same language as everything else.
 *   2. Email  — send/forward to task@linearit.co. Subject becomes the task,
 *               body becomes the notes, task+groceries@ files it in a list.
 *   3. Text   — text the Linear number. Reply comes back on the same thread.
 * =============================================================================
 */

import {
  parseTask, nextOccurrence, describeDue, repeatLabel,
  localParts, localDayStr, localMidnight,
} from "./parse.js";

const MAX_TITLE = 300;
const MAX_NOTES = 8000;
const MAX_TASKS_PER_USER = 20000;
// A reminder stays "showable" for this long after it's marked delivered, so the
// service worker can still fetch what to display after the push wakes it.
// Deliberately shorter than the tracker's minimum nudge throttle (4 minutes):
// that way a later push can never land inside this window and re-show a
// reminder the person has already seen.
export const REMINDER_GRACE_MS = 2 * 60 * 1000;

/* ============================================================
 * Schema — created alongside the tracker's tables on first request
 * ============================================================ */
export async function ensureTodoSchema(env) {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS todo_lists (" +
      "id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT, color TEXT, " +
      "position REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS todos (" +
      "id TEXT PRIMARY KEY, email TEXT NOT NULL, company_id TEXT, list_id TEXT, " +
      "title TEXT NOT NULL, notes TEXT, " +
      "due_at INTEGER, due_all_day INTEGER NOT NULL DEFAULT 0, " +
      "remind_at INTEGER, reminded_at INTEGER, " +
      "priority INTEGER NOT NULL DEFAULT 0, important INTEGER NOT NULL DEFAULT 0, " +
      "myday TEXT, repeat_json TEXT, tags TEXT, " +
      "status TEXT NOT NULL DEFAULT 'open', completed_at INTEGER, " +
      "position REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'app', " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS todo_steps (" +
      "id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, email TEXT NOT NULL, title TEXT NOT NULL, " +
      "done INTEGER NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"
    ),
    // Per-person to-do settings: timezone, default list, the verified mobile
    // number that may text tasks in, and extra email addresses allowed to send.
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS todo_prefs (" +
      "email TEXT PRIMARY KEY, tz_offset INTEGER NOT NULL DEFAULT 0, default_list TEXT, " +
      "phone TEXT, phone_pending TEXT, phone_code TEXT, phone_verified_at INTEGER, " +
      "alt_emails TEXT, feed_key TEXT, quick_key TEXT, intake_receipt INTEGER NOT NULL DEFAULT 1, " +
      "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    ),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_todos_email_status ON todos(email, status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_todos_email_due ON todos(email, due_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_todos_remind ON todos(status, remind_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_steps_todo ON todo_steps(todo_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_lists_email ON todo_lists(email)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_prefs_phone ON todo_prefs(phone) WHERE phone IS NOT NULL"),
  ]);
  // Columns added after the first release; no-ops on a fresh database.
  for (const alt of ["ALTER TABLE todo_prefs ADD COLUMN quick_key TEXT"]) {
    try { await env.DB.prepare(alt).run(); } catch (_) { /* already there */ }
  }
}

/* ============================================================
 * Router — every path under /api/todo/…
 * `ctx` gives us the host's helpers: { json, readBody, requireAnyone, reissue }
 * ============================================================ */
export async function handleTodoApi(request, env, url, p, method, ctx) {
  if (p === "/api/todo/state" && method === "GET") return todoState(request, env, url, ctx);
  if (p === "/api/todo/add" && method === "POST") return todoAdd(request, env, ctx);
  if (p === "/api/todo/update" && method === "POST") return todoUpdate(request, env, ctx);
  if (p === "/api/todo/complete" && method === "POST") return todoComplete(request, env, ctx);
  if (p === "/api/todo/delete" && method === "POST") return todoDelete(request, env, ctx);
  if (p === "/api/todo/step" && method === "POST") return stepWrite(request, env, ctx);
  if (p === "/api/todo/list" && method === "POST") return listWrite(request, env, ctx);
  if (p === "/api/todo/prefs" && method === "GET") return prefsGet(request, env, ctx);
  if (p === "/api/todo/prefs" && method === "POST") return prefsSet(request, env, ctx);
  if (p === "/api/todo/phone" && method === "POST") return phoneSetup(request, env, ctx);
  if (p === "/api/todo/parse" && method === "POST") return parsePreview(request, env, ctx);
  return null;   // not ours — let the caller fall through to its own 404
}

/* ============================================================
 * Read the whole board in one call: lists, tasks, steps, counts.
 * Small data by nature (one person's to-dos), so one round trip beats five.
 * ============================================================ */
async function todoState(request, env, url, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const email = claims.email;
  // The browser sends its offset on every load. Without it a fresh account would
  // work out "today" in UTC, which puts My Day on the wrong date after 8pm.
  await touchPrefs(env, email, { tz_offset: url.searchParams.get("tz_offset") });
  const prefs = await getPrefs(env, email);
  const tz = prefs.tz_offset;
  const now = Date.now();

  const showCompleted = url.searchParams.get("completed") === "1";
  const lists = await getLists(env, email);

  // Completed tasks are only fetched when asked for, and only recent ones —
  // an old to-do list shouldn't get slower every week.
  const rows = (await env.DB.prepare(
    "SELECT * FROM todos WHERE email=? AND (status='open' OR (status='done' AND completed_at > ?)) " +
    "ORDER BY position, created_at"
  ).bind(email, showCompleted ? 0 : now - 14 * 86400000).all()).results || [];

  const ids = rows.map((r) => r.id);
  const steps = ids.length
    ? (await env.DB.prepare(
        "SELECT * FROM todo_steps WHERE email=? ORDER BY position, created_at"
      ).bind(email).all()).results || []
    : [];
  const byTodo = {};
  steps.forEach((s) => { (byTodo[s.todo_id] = byTodo[s.todo_id] || []).push(cleanStep(s)); });

  const todos = rows.map((r) => cleanTodo(r, byTodo[r.id] || []));
  return ctx.json({
    token: await ctx.reissue(env, claims),
    now,
    tz,
    today: localDayStr(now, tz),
    lists,
    todos,
    counts: countViews(todos, tz, now),
    prefs: publicPrefs(prefs),
    // Where to email / text tasks in, so the settings screen shows the real
    // addresses this deployment is wired to rather than hard-coded ones.
    intake: {
      email: env.TODO_EMAIL || "task@linearit.co",
      sms: env.SMS_NUMBER || "",
      sms_enabled: !!(env.TWILIO_AUTH_TOKEN || env.SMS_INTAKE_SECRET),
    },
  });
}

// The badge numbers next to each smart view.
function countViews(todos, tz, now) {
  const today = localDayStr(now, tz);
  const endOfToday = localMidnight(now, tz) + 86400000;
  const c = { myday: 0, today: 0, overdue: 0, planned: 0, important: 0, all: 0, lists: {} };
  todos.forEach((t) => {
    if (t.status !== "open") return;
    c.all++;
    if (t.myday === today) c.myday++;
    if (t.due_at != null && t.due_at < endOfToday) c.today++;
    if (t.due_at != null && isOverdue(t, now)) c.overdue++;
    if (t.due_at != null) c.planned++;
    if (t.important) c.important++;
    if (t.list_id) c.lists[t.list_id] = (c.lists[t.list_id] || 0) + 1;
  });
  return c;
}
function isOverdue(t, now) {
  if (t.due_at == null || t.status !== "open") return false;
  // An all-day task isn't late until the day is over; a timed one is late at its time.
  return t.due_all_day ? t.due_at + 86400000 <= now : t.due_at <= now;
}

/* ============================================================
 * Add a task. `text` runs through the quick-add parser; explicit fields win.
 * ============================================================ */
async function todoAdd(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  await touchPrefs(env, claims.email, body);
  const prefs = await getPrefs(env, claims.email);
  const created = await createTodo(env, claims.email, body, {
    tz: prefs.tz_offset, source: "app", company_id: claims.company_id || null, prefs,
  });
  if (created.error) return ctx.json({ error: created.error }, created.status || 400);
  return ctx.json({ token: await ctx.reissue(env, claims), todo: created.todo });
}

/**
 * The one place a task gets born — the app, an email and a text all land here.
 * `input` may carry a raw `text` to parse and/or explicit fields that override it.
 */
export async function createTodo(env, email, input, opts) {
  const tz = Number((opts && opts.tz) || 0);
  const now = Date.now();
  const raw = String(input.text || input.title || "").trim();
  if (!raw) return { error: "Type something to add." };

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM todos WHERE email=? AND status='open'").bind(email).first();
  if (count && Number(count.n) >= MAX_TASKS_PER_USER) {
    return { error: "You've hit the limit of open tasks. Complete or delete a few first.", status: 409 };
  }

  const parsed = input.parse === false
    ? { title: raw, tags: [], list_hint: null, priority: 0, important: 0, due_at: null, due_all_day: 0, remind_at: null, repeat: null, matched: [] }
    : parseTask(raw, { tz, now });

  // Where does it go? An explicit list wins, then "@list" from the text, then
  // the person's default list, then the built-in Tasks list.
  let listId = input.list_id != null ? String(input.list_id) : null;
  if (listId) {
    const owned = await env.DB.prepare("SELECT id FROM todo_lists WHERE id=? AND email=?").bind(listId, email).first();
    if (!owned) listId = null;
  }
  if (!listId && parsed.list_hint) listId = await findOrCreateList(env, email, parsed.list_hint);
  if (!listId && opts && opts.listHint) listId = await findOrCreateList(env, email, opts.listHint);
  if (!listId && opts && opts.prefs && opts.prefs.default_list) {
    const owned = await env.DB.prepare("SELECT id FROM todo_lists WHERE id=? AND email=?").bind(opts.prefs.default_list, email).first();
    if (owned) listId = opts.prefs.default_list;
  }

  const title = String(input.title != null && input.parse === false ? input.title : parsed.title).slice(0, MAX_TITLE).trim() || "Task";
  let notes = String(input.notes || parsed.notes || "").slice(0, MAX_NOTES);

  // Parsing is a guess; the words someone actually sent are the record. When a
  // task arrived from outside the app and the parser changed the wording, keep
  // the original with it — on a keypad every character cost something, and a
  // misread date must never be the only thing left of what they wrote.
  if (opts && opts.source && opts.source !== "app" && input.parse !== false) {
    const original = raw.replace(/\s+/g, " ").trim();
    if (original && original.toLowerCase() !== title.toLowerCase()) {
      const line = "Original: " + original;
      notes = (notes ? line + "\n\n" + notes : line).slice(0, MAX_NOTES);
    }
  }
  const dueAt = pick(input.due_at, parsed.due_at);
  const allDay = input.due_at !== undefined ? (input.due_all_day ? 1 : 0) : parsed.due_all_day;
  let remindAt = pick(input.remind_at, parsed.remind_at);
  // Don't fire a reminder for a moment that has already passed.
  if (remindAt != null && remindAt < now - 60000) remindAt = null;

  const repeat = input.repeat !== undefined ? normalizeRepeat(input.repeat) : parsed.repeat;
  const tags = Array.isArray(input.tags) ? input.tags.map(cleanTag).filter(Boolean) : parsed.tags;
  const priority = clampInt(pick(input.priority, parsed.priority), 0, 4);
  const important = (input.important !== undefined ? input.important : parsed.important) ? 1 : 0;
  const myday = input.myday ? localDayStr(now, tz) : null;

  const id = genId();
  const position = now;   // newest last; the UI can reorder later
  await env.DB.prepare(
    "INSERT INTO todos (id, email, company_id, list_id, title, notes, due_at, due_all_day, remind_at, reminded_at, " +
    "priority, important, myday, repeat_json, tags, status, completed_at, position, source, created_at, updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,'open',NULL,?,?,?,?)"
  ).bind(
    id, email, (opts && opts.company_id) || null, listId, title, notes,
    dueAt, allDay ? 1 : 0, remindAt, priority, important, myday,
    repeat ? JSON.stringify(repeat) : null, tags.join(","),
    position, (opts && opts.source) || "app", now, now
  ).run();

  // Steps can come along with the task (the email intake turns "- item" lines
  // in the body into steps).
  if (Array.isArray(input.steps)) {
    let pos = now;
    for (const s of input.steps.slice(0, 100)) {
      const st = String(s || "").trim().slice(0, MAX_TITLE);
      if (!st) continue;
      await env.DB.prepare(
        "INSERT INTO todo_steps (id, todo_id, email, title, done, position, created_at) VALUES (?,?,?,?,0,?,?)"
      ).bind(genId(), id, email, st, pos++, now).run();
    }
  }

  const row = await env.DB.prepare("SELECT * FROM todos WHERE id=?").bind(id).first();
  const steps = (await env.DB.prepare("SELECT * FROM todo_steps WHERE todo_id=? ORDER BY position").bind(id).all()).results || [];
  return { todo: cleanTodo(row, steps.map(cleanStep)), parsed };
}

/* ============================================================
 * Update — only the fields present in the body are touched.
 * ============================================================ */
async function todoUpdate(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  await touchPrefs(env, claims.email, body);
  const prefs = await getPrefs(env, claims.email);
  const tz = prefs.tz_offset;

  const row = await env.DB.prepare("SELECT * FROM todos WHERE id=? AND email=?").bind(String(body.id || ""), claims.email).first();
  if (!row) return ctx.json({ error: "Task not found." }, 404);

  const sets = [], args = [];
  const set = (col, val) => { sets.push(col + "=?"); args.push(val); };

  if (body.title !== undefined) {
    const t = String(body.title).trim().slice(0, MAX_TITLE);
    if (!t) return ctx.json({ error: "A task needs a name." }, 400);
    set("title", t);
  }
  if (body.notes !== undefined) set("notes", String(body.notes || "").slice(0, MAX_NOTES));
  if (body.due_at !== undefined) {
    const due = body.due_at == null ? null : Number(body.due_at);
    set("due_at", due != null && Number.isFinite(due) ? due : null);
    set("due_all_day", body.due_all_day ? 1 : 0);
    if (due == null) { set("remind_at", null); set("reminded_at", null); }
  }
  if (body.remind_at !== undefined) {
    const r = body.remind_at == null ? null : Number(body.remind_at);
    set("remind_at", r != null && Number.isFinite(r) ? r : null);
    set("reminded_at", null);            // a re-set reminder gets to fire again
  }
  if (body.priority !== undefined) set("priority", clampInt(body.priority, 0, 4));
  if (body.important !== undefined) set("important", body.important ? 1 : 0);
  if (body.myday !== undefined) set("myday", body.myday ? localDayStr(Date.now(), tz) : null);
  if (body.repeat !== undefined) {
    const rep = normalizeRepeat(body.repeat);
    set("repeat_json", rep ? JSON.stringify(rep) : null);
  }
  if (body.tags !== undefined) {
    const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || "").split(","))
      .map(cleanTag).filter(Boolean);
    set("tags", tags.join(","));
  }
  if (body.list_id !== undefined) {
    let lid = body.list_id == null || body.list_id === "" ? null : String(body.list_id);
    if (lid) {
      const owned = await env.DB.prepare("SELECT id FROM todo_lists WHERE id=? AND email=?").bind(lid, claims.email).first();
      if (!owned) lid = null;
    }
    set("list_id", lid);
  }
  if (body.position !== undefined && Number.isFinite(Number(body.position))) set("position", Number(body.position));

  if (!sets.length) return ctx.json({ error: "Nothing to change." }, 400);
  set("updated_at", Date.now());
  args.push(row.id, claims.email);
  await env.DB.prepare("UPDATE todos SET " + sets.join(", ") + " WHERE id=? AND email=?").bind(...args).run();

  return ctx.json({ token: await ctx.reissue(env, claims), todo: await readTodo(env, row.id) });
}

/* ============================================================
 * Complete / reopen. Completing a repeating task rolls it forward instead of
 * closing it out, the way Microsoft To Do does — the streak never breaks.
 * ============================================================ */
async function todoComplete(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  const prefs = await getPrefs(env, claims.email);
  const out = await completeTodo(env, claims.email, String(body.id || ""), body.done !== false, prefs.tz_offset);
  if (out.error) return ctx.json({ error: out.error }, out.status || 400);
  return ctx.json(Object.assign({ token: await ctx.reissue(env, claims) }, out));
}

export async function completeTodo(env, email, id, done, tz) {
  const row = await env.DB.prepare("SELECT * FROM todos WHERE id=? AND email=?").bind(id, email).first();
  if (!row) return { error: "Task not found.", status: 404 };
  const now = Date.now();

  if (!done) {
    await env.DB.prepare("UPDATE todos SET status='open', completed_at=NULL, updated_at=? WHERE id=?").bind(now, id).run();
    return { todo: await readTodo(env, id), rolled: null };
  }

  const repeat = parseJson(row.repeat_json);
  let rolled = null;
  if (repeat && row.due_at != null) {
    // Roll the due date (and the reminder with it) to the next occurrence.
    const nextDue = nextOccurrence(repeat, Number(row.due_at), tz);
    if (nextDue) {
      const shift = nextDue - Number(row.due_at);
      const nextRemind = row.remind_at == null ? null : Number(row.remind_at) + shift;
      await env.DB.prepare(
        "UPDATE todos SET due_at=?, remind_at=?, reminded_at=NULL, myday=NULL, updated_at=? WHERE id=?"
      ).bind(nextDue, nextRemind, now, id).run();
      // Un-tick the steps so the next round starts clean.
      await env.DB.prepare("UPDATE todo_steps SET done=0 WHERE todo_id=?").bind(id).run();
      rolled = { due_at: nextDue, label: describeDue(nextDue, Number(row.due_all_day) ? 1 : 0, tz, now) };
      return { todo: await readTodo(env, id), rolled };
    }
  }

  await env.DB.prepare("UPDATE todos SET status='done', completed_at=?, updated_at=? WHERE id=?").bind(now, now, id).run();
  return { todo: await readTodo(env, id), rolled: null };
}

async function todoDelete(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  const id = String(body.id || "");
  const row = await env.DB.prepare("SELECT id FROM todos WHERE id=? AND email=?").bind(id, claims.email).first();
  if (!row) return ctx.json({ error: "Task not found." }, 404);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM todo_steps WHERE todo_id=?").bind(id),
    env.DB.prepare("DELETE FROM todos WHERE id=? AND email=?").bind(id, claims.email),
  ]);
  return ctx.json({ token: await ctx.reissue(env, claims), ok: true });
}

/* ============================================================
 * Steps (sub-tasks): add / rename / toggle / delete
 * ============================================================ */
async function stepWrite(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  const action = String(body.action || "add");
  const now = Date.now();

  if (action === "add") {
    const todo = await env.DB.prepare("SELECT id FROM todos WHERE id=? AND email=?").bind(String(body.todo_id || ""), claims.email).first();
    if (!todo) return ctx.json({ error: "Task not found." }, 404);
    const title = String(body.title || "").trim().slice(0, MAX_TITLE);
    if (!title) return ctx.json({ error: "Type a step." }, 400);
    await env.DB.prepare(
      "INSERT INTO todo_steps (id, todo_id, email, title, done, position, created_at) VALUES (?,?,?,?,0,?,?)"
    ).bind(genId(), todo.id, claims.email, title, now, now).run();
    return ctx.json({ token: await ctx.reissue(env, claims), todo: await readTodo(env, todo.id) });
  }

  const step = await env.DB.prepare("SELECT * FROM todo_steps WHERE id=? AND email=?").bind(String(body.id || ""), claims.email).first();
  if (!step) return ctx.json({ error: "Step not found." }, 404);

  if (action === "toggle") {
    await env.DB.prepare("UPDATE todo_steps SET done=? WHERE id=?").bind(body.done ? 1 : 0, step.id).run();
  } else if (action === "rename") {
    const title = String(body.title || "").trim().slice(0, MAX_TITLE);
    if (!title) return ctx.json({ error: "A step needs a name." }, 400);
    await env.DB.prepare("UPDATE todo_steps SET title=? WHERE id=?").bind(title, step.id).run();
  } else if (action === "delete") {
    await env.DB.prepare("DELETE FROM todo_steps WHERE id=?").bind(step.id).run();
  } else {
    return ctx.json({ error: "Unknown step action." }, 400);
  }
  return ctx.json({ token: await ctx.reissue(env, claims), todo: await readTodo(env, step.todo_id) });
}

/* ============================================================
 * Lists: create / rename / restyle / delete / reorder
 * ============================================================ */
async function listWrite(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  const action = String(body.action || "create");
  const now = Date.now();

  if (action === "create") {
    const name = String(body.name || "").trim().slice(0, 60);
    if (!name) return ctx.json({ error: "Name the list." }, 400);
    const id = await findOrCreateList(env, claims.email, name, body.emoji, body.color);
    return ctx.json({ token: await ctx.reissue(env, claims), lists: await getLists(env, claims.email), id });
  }

  const list = await env.DB.prepare("SELECT * FROM todo_lists WHERE id=? AND email=?").bind(String(body.id || ""), claims.email).first();
  if (!list) return ctx.json({ error: "List not found." }, 404);

  if (action === "update") {
    const sets = [], args = [];
    if (body.name !== undefined) {
      const n = String(body.name).trim().slice(0, 60);
      if (!n) return ctx.json({ error: "A list needs a name." }, 400);
      sets.push("name=?"); args.push(n);
    }
    if (body.emoji !== undefined) { sets.push("emoji=?"); args.push(String(body.emoji || "").slice(0, 8) || null); }
    if (body.color !== undefined) { sets.push("color=?"); args.push(validColor(body.color)); }
    if (body.position !== undefined && Number.isFinite(Number(body.position))) { sets.push("position=?"); args.push(Number(body.position)); }
    if (!sets.length) return ctx.json({ error: "Nothing to change." }, 400);
    args.push(list.id);
    await env.DB.prepare("UPDATE todo_lists SET " + sets.join(", ") + " WHERE id=?").bind(...args).run();
  } else if (action === "delete") {
    // Deleting a list keeps its tasks — they fall back to the inbox rather than
    // disappearing with it. Losing work to a mis-click isn't a feature.
    await env.DB.batch([
      env.DB.prepare("UPDATE todos SET list_id=NULL, updated_at=? WHERE list_id=? AND email=?").bind(now, list.id, claims.email),
      env.DB.prepare("UPDATE todo_prefs SET default_list=NULL WHERE email=? AND default_list=?").bind(claims.email, list.id),
      env.DB.prepare("DELETE FROM todo_lists WHERE id=? AND email=?").bind(list.id, claims.email),
    ]);
  } else {
    return ctx.json({ error: "Unknown list action." }, 400);
  }
  return ctx.json({ token: await ctx.reissue(env, claims), lists: await getLists(env, claims.email) });
}

export async function getLists(env, email) {
  const rows = (await env.DB.prepare(
    "SELECT id, name, emoji, color, position FROM todo_lists WHERE email=? ORDER BY position, name"
  ).bind(email).all()).results || [];
  return rows.map((r) => ({ id: r.id, name: r.name, emoji: r.emoji || "", color: r.color || null, position: Number(r.position) || 0 }));
}

// Match a list by name (case-insensitive) or make one. This is what lets
// "@groceries" in a text message and "task+groceries@linearit.co" agree.
export async function findOrCreateList(env, email, name, emoji, color) {
  const clean = String(name || "").trim().slice(0, 60);
  if (!clean) return null;
  const existing = await env.DB.prepare(
    "SELECT id FROM todo_lists WHERE email=? AND lower(name)=lower(?)"
  ).bind(email, clean).first();
  if (existing) return existing.id;
  const id = genId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO todo_lists (id, email, name, emoji, color, position, created_at) VALUES (?,?,?,?,?,?,?)"
  ).bind(id, email, clean, String(emoji || "").slice(0, 8) || null, validColor(color), now, now).run();
  return id;
}

/* ============================================================
 * Preferences (timezone, default list, intake receipts, calendar feed key)
 * ============================================================ */
async function prefsGet(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const prefs = await getPrefs(env, claims.email);
  return ctx.json({ token: await ctx.reissue(env, claims), prefs: publicPrefs(prefs), email: claims.email });
}

async function prefsSet(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  await touchPrefs(env, claims.email, body);
  const sets = [], args = [];
  if (body.default_list !== undefined) {
    let lid = body.default_list ? String(body.default_list) : null;
    if (lid) {
      const owned = await env.DB.prepare("SELECT id FROM todo_lists WHERE id=? AND email=?").bind(lid, claims.email).first();
      if (!owned) lid = null;
    }
    sets.push("default_list=?"); args.push(lid);
  }
  if (body.intake_receipt !== undefined) { sets.push("intake_receipt=?"); args.push(body.intake_receipt ? 1 : 0); }
  // Rotating a key immediately retires the old one — that's the point of it.
  if (body.rotate === "quick_key" || body.rotate === "feed_key") {
    sets.push(body.rotate + "=?"); args.push(genFeedKey());
  }
  if (body.alt_emails !== undefined) {
    const list = (Array.isArray(body.alt_emails) ? body.alt_emails : String(body.alt_emails || "").split(/[,\s]+/))
      .map((e) => String(e || "").trim().toLowerCase())
      .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
      .slice(0, 10);
    sets.push("alt_emails=?"); args.push(list.join(","));
  }
  if (sets.length) {
    sets.push("updated_at=?"); args.push(Date.now(), claims.email);
    await env.DB.prepare("UPDATE todo_prefs SET " + sets.join(", ") + " WHERE email=?").bind(...args).run();
  }
  return ctx.json({ token: await ctx.reissue(env, claims), prefs: publicPrefs(await getPrefs(env, claims.email)) });
}

/**
 * Phone setup, without needing to send an SMS.
 * The person types their mobile number here; we mint a short code and tell them
 * to text it to the Linear number. The inbound webhook sees the code arrive from
 * that number and marks it verified — which also proves the number is really
 * theirs and really can reach us. No outbound SMS credits required.
 */
async function phoneSetup(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  const action = String(body.action || "start");
  const now = Date.now();
  await touchPrefs(env, claims.email, body);

  if (action === "remove") {
    await env.DB.prepare(
      "UPDATE todo_prefs SET phone=NULL, phone_pending=NULL, phone_code=NULL, phone_verified_at=NULL, updated_at=? WHERE email=?"
    ).bind(now, claims.email).run();
    return ctx.json({ token: await ctx.reissue(env, claims), prefs: publicPrefs(await getPrefs(env, claims.email)) });
  }

  const phone = normalizePhone(body.phone);
  if (!phone) return ctx.json({ error: "Enter your mobile number, e.g. (845) 604-1462." }, 400);

  const taken = await env.DB.prepare("SELECT email FROM todo_prefs WHERE phone=? AND email<>?").bind(phone, claims.email).first();
  if (taken) return ctx.json({ error: "That number is already linked to another account." }, 409);

  // Two ways to own a number, depending on what's actually wired up.
  //
  // If there's a real SMS number to text (a paid provider), we can prove
  // ownership properly: they text a one-time code in from the handset.
  //
  // If there isn't — the free setup — the number is only ever used to recognise
  // texts arriving through a carrier's text-to-email gateway, where the
  // carrier itself puts the sending number in the From address and the message
  // still has to pass SPF/DMARC. There's nothing to text a code to, so we save
  // the number directly. Claiming a number you don't own gains you nothing: no
  // mail is routed anywhere, it only stops the real owner from claiming it,
  // which is why the number stays unique across accounts.
  const canTextUs = !!(env.SMS_NUMBER && (env.TWILIO_AUTH_TOKEN || env.SMS_INTAKE_SECRET));
  if (!canTextUs) {
    await env.DB.prepare(
      "UPDATE todo_prefs SET phone=?, phone_pending=NULL, phone_code=NULL, phone_verified_at=NULL, updated_at=? WHERE email=?"
    ).bind(phone, now, claims.email).run();
    return ctx.json({
      token: await ctx.reissue(env, claims),
      phone,
      gateway_only: true,
      prefs: publicPrefs(await getPrefs(env, claims.email)),
    });
  }

  const code = "LT-" + String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
  await env.DB.prepare(
    "UPDATE todo_prefs SET phone_pending=?, phone_code=?, updated_at=? WHERE email=?"
  ).bind(phone, code, now, claims.email).run();

  return ctx.json({
    token: await ctx.reissue(env, claims),
    code,
    phone,
    sms_to: env.SMS_NUMBER || "",
    prefs: publicPrefs(await getPrefs(env, claims.email)),
  });
}

/* ---- Show what the parser makes of a line, live, as they type it ---- */
async function parsePreview(request, env, ctx) {
  const claims = await ctx.requireAnyone(request, env);
  const body = await ctx.readBody(request);
  const prefs = await getPrefs(env, claims.email);
  const tz = Number.isFinite(Number(body.tz_offset)) ? Number(body.tz_offset) : prefs.tz_offset;
  const now = Date.now();
  const p = parseTask(String(body.text || ""), { tz, now });
  return ctx.json({
    title: p.title,
    due_at: p.due_at, due_all_day: p.due_all_day, remind_at: p.remind_at,
    priority: p.priority, important: p.important, tags: p.tags,
    list_hint: p.list_hint, repeat: p.repeat,
    summary: p.matched,
    due_label: p.due_at ? describeDue(p.due_at, p.due_all_day, tz, now) : "",
    repeat_label: p.repeat ? repeatLabel(p.repeat) : "",
  });
}

/* ============================================================
 * Reminders — which tasks should nudge this person right now.
 * Called by the cron sender and by the service worker's /api/push/pending.
 * ============================================================ */
export async function dueReminders(env, email, now, limit) {
  const rows = (await env.DB.prepare(
    "SELECT id, title, due_at, due_all_day, remind_at, reminded_at, priority FROM todos " +
    "WHERE email=? AND status='open' AND remind_at IS NOT NULL AND remind_at <= ? " +
    "AND (reminded_at IS NULL OR reminded_at > ?) ORDER BY remind_at LIMIT ?"
  ).bind(email, now, now - REMINDER_GRACE_MS, Math.max(1, limit || 5)).all()).results || [];
  return rows;
}

// Mark them fired so they nudge once, not every cron tick.
export async function markReminded(env, ids, now) {
  if (!ids || !ids.length) return;
  const marks = ids.map((id) => env.DB.prepare("UPDATE todos SET reminded_at=? WHERE id=?").bind(now, id));
  await env.DB.batch(marks);
}

// Everyone with a reminder ready to fire — the cron's work list.
export async function usersWithDueReminders(env, now) {
  const rows = (await env.DB.prepare(
    "SELECT DISTINCT email FROM todos WHERE status='open' AND remind_at IS NOT NULL AND remind_at <= ? AND reminded_at IS NULL LIMIT 500"
  ).bind(now).all()).results || [];
  return rows.map((r) => r.email);
}

// Turn a set of due tasks into the one notification the push will show.
export function reminderNotification(rows, tz, now) {
  if (!rows || !rows.length) return null;
  const first = rows[0];
  const label = first.due_at != null ? describeDue(Number(first.due_at), Number(first.due_all_day) ? 1 : 0, tz, now) : "";
  if (rows.length === 1) {
    return { show: true, type: "todo", title: first.title, body: label ? "Due " + label : "Linear To-Do reminder", ids: [first.id] };
  }
  return {
    show: true, type: "todo",
    title: rows.length + " tasks need you",
    body: first.title + " · and " + (rows.length - 1) + " more",
    ids: rows.map((r) => r.id),
  };
}

/**
 * Quick-add by link — the free way to add a task from a phone.
 * ---------------------------------------------------------------------------
 * One personal URL that adds a task, with no session and no SMS provider:
 *
 *   GET  /api/todo/quick?key=…&text=Buy+milk+tomorrow+9am
 *   POST /api/todo/quick?key=…      body: raw text, form `text=`, or {"text":…}
 *
 * That's all an iOS Shortcut, a Siri phrase, an Android HTTP shortcut or a
 * smartwatch button needs. It speaks the same commands the SMS door does, so
 * LIST / DONE 2 / HELP work here too, and it answers in plain text so a
 * Shortcut can show the reply as-is (add &format=json for a JSON body).
 *
 * The key IS the credential — it's long, random, per-person and regenerable.
 */
export async function quickAdd(request, env, url, runCommand) {
  const key = url.searchParams.get("key") || "";
  const wantsJson = url.searchParams.get("format") === "json";
  const reply = (msg, status) => wantsJson
    ? new Response(JSON.stringify({ reply: msg }), {
        status: status || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
    : new Response(msg + "\n", {
        status: status || 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

  if (!/^[A-Za-z0-9_-]{20,80}$/.test(key)) return reply("Not found.", 404);
  const row = await env.DB.prepare("SELECT email FROM todo_prefs WHERE quick_key=?").bind(key).first();
  if (!row) return reply("Not found.", 404);

  let text = url.searchParams.get("text") || url.searchParams.get("q") || "";
  if (!text && request.method === "POST") {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    const raw = await request.text();
    if (ct.indexOf("application/json") !== -1) {
      try { const b = JSON.parse(raw || "{}"); text = b.text || b.task || b.body || ""; } catch (_) { text = ""; }
    } else if (ct.indexOf("application/x-www-form-urlencoded") !== -1) {
      text = new URLSearchParams(raw).get("text") || new URLSearchParams(raw).get("body") || "";
    } else {
      text = raw;                                        // a plain-text body is fine too
    }
  }
  text = String(text || "").trim().slice(0, 1200);
  if (!text) return reply("Send some text and I'll add it to your list.", 400);

  return reply(await runCommand(env, row.email, text));
}

/* ============================================================
 * Calendar feed — subscribe to your dated tasks from Outlook / Google / Apple.
 * Read-only, and keyed by a secret only the owner can see.
 * ============================================================ */
export async function icsFeed(env, url) {
  const key = url.searchParams.get("key") || "";
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(key)) return new Response("Not found", { status: 404 });
  const pref = await env.DB.prepare("SELECT email, tz_offset FROM todo_prefs WHERE feed_key=?").bind(key).first();
  if (!pref) return new Response("Not found", { status: 404 });

  const rows = (await env.DB.prepare(
    "SELECT id, title, notes, due_at, due_all_day, status, priority FROM todos " +
    "WHERE email=? AND due_at IS NOT NULL AND due_at > ? ORDER BY due_at LIMIT 1000"
  ).bind(pref.email, Date.now() - 180 * 86400000).all()).results || [];

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Linear IT//Linear To-Do//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Linear To-Do", "X-WR-TIMEZONE:UTC",
  ];
  rows.forEach((r) => {
    const due = Number(r.due_at);
    const allDay = Number(r.due_all_day) === 1;
    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + r.id + "@todo.linearit.co");
    lines.push("DTSTAMP:" + icsStamp(Date.now()));
    if (allDay) {
      const p = localParts(due, Number(pref.tz_offset) || 0);
      const d = p.y + String(p.mo + 1).padStart(2, "0") + String(p.d).padStart(2, "0");
      lines.push("DTSTART;VALUE=DATE:" + d);
    } else {
      lines.push("DTSTART:" + icsStamp(due));
      lines.push("DTEND:" + icsStamp(due + 30 * 60000));
    }
    lines.push("SUMMARY:" + icsEscape((r.status === "done" ? "✓ " : "") + r.title));
    if (r.notes) lines.push("DESCRIPTION:" + icsEscape(String(r.notes).slice(0, 500)));
    if (Number(r.priority) >= 3) lines.push("PRIORITY:1");
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="linear-todo.ics"',
      "Cache-Control": "no-store",
    },
  });
}
function icsStamp(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0") +
    "T" + String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + String(d.getUTCSeconds()).padStart(2, "0") + "Z";
}
function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/* ============================================================
 * Prefs helpers
 * ============================================================ */
export async function getPrefs(env, email) {
  let row = await env.DB.prepare("SELECT * FROM todo_prefs WHERE email=?").bind(email).first();
  if (!row) {
    const now = Date.now();
    // Start from the timezone the tracker already knows for this person.
    const w = await env.DB.prepare("SELECT tz_offset FROM workers WHERE email=?").bind(email).first();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO todo_prefs (email, tz_offset, feed_key, quick_key, intake_receipt, created_at, updated_at) VALUES (?,?,?,?,1,?,?)"
    ).bind(email, w ? Number(w.tz_offset) || 0 : 0, genFeedKey(), genFeedKey(), now, now).run();
    row = await env.DB.prepare("SELECT * FROM todo_prefs WHERE email=?").bind(email).first();
  }
  // Backfill keys for rows created before a key existed.
  for (const col of ["feed_key", "quick_key"]) {
    if (row && !row[col]) {
      const key = genFeedKey();
      await env.DB.prepare("UPDATE todo_prefs SET " + col + "=? WHERE email=?").bind(key, email).run();
      row[col] = key;
    }
  }
  return {
    email: email,
    tz_offset: Number(row.tz_offset) || 0,
    default_list: row.default_list || null,
    phone: row.phone || null,
    phone_pending: row.phone_pending || null,
    phone_code: row.phone_code || null,
    phone_verified_at: row.phone_verified_at ? Number(row.phone_verified_at) : null,
    alt_emails: String(row.alt_emails || "").split(",").filter(Boolean),
    feed_key: row.feed_key,
    quick_key: row.quick_key,
    intake_receipt: Number(row.intake_receipt) !== 0,
  };
}

// Keep the stored timezone in step with the browser (it moves with DST).
export async function touchPrefs(env, email, body) {
  const tz = Number(body && body.tz_offset);
  if (!Number.isFinite(tz) || tz < -900 || tz > 900) { await getPrefs(env, email); return; }
  await getPrefs(env, email);
  await env.DB.prepare("UPDATE todo_prefs SET tz_offset=?, updated_at=? WHERE email=?")
    .bind(Math.round(tz), Date.now(), email).run();
}

function publicPrefs(p) {
  return {
    tz_offset: p.tz_offset,
    default_list: p.default_list,
    phone: p.phone ? maskPhone(p.phone) : null,
    phone_raw: p.phone || null,
    phone_verified: !!p.phone_verified_at,
    phone_pending: p.phone_pending ? maskPhone(p.phone_pending) : null,
    phone_code: p.phone_pending ? p.phone_code : null,
    alt_emails: p.alt_emails,
    feed_key: p.feed_key,
    quick_key: p.quick_key,
    intake_receipt: p.intake_receipt,
  };
}

/* ============================================================
 * Small shared helpers
 * ============================================================ */
export function cleanTodo(r, steps) {
  return {
    id: r.id,
    list_id: r.list_id || null,
    title: r.title,
    notes: r.notes || "",
    due_at: r.due_at == null ? null : Number(r.due_at),
    due_all_day: Number(r.due_all_day) === 1,
    remind_at: r.remind_at == null ? null : Number(r.remind_at),
    priority: Number(r.priority) || 0,
    important: Number(r.important) === 1,
    myday: r.myday || null,
    repeat: parseJson(r.repeat_json),
    repeat_label: repeatLabel(parseJson(r.repeat_json)),
    tags: String(r.tags || "").split(",").filter(Boolean),
    status: r.status,
    completed_at: r.completed_at == null ? null : Number(r.completed_at),
    position: Number(r.position) || 0,
    source: r.source || "app",
    created_at: Number(r.created_at),
    steps: steps || [],
  };
}
function cleanStep(s) {
  return { id: s.id, todo_id: s.todo_id, title: s.title, done: Number(s.done) === 1, position: Number(s.position) || 0 };
}
async function readTodo(env, id) {
  const row = await env.DB.prepare("SELECT * FROM todos WHERE id=?").bind(id).first();
  if (!row) return null;
  const steps = (await env.DB.prepare("SELECT * FROM todo_steps WHERE todo_id=? ORDER BY position").bind(id).all()).results || [];
  return cleanTodo(row, steps.map(cleanStep));
}

export function normalizeRepeat(r) {
  if (!r) return null;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch (_) { return null; } }
  if (!r || typeof r !== "object") return null;
  const kind = String(r.kind || "");
  if (["day", "week", "month", "year", "weekday"].indexOf(kind) === -1) return null;
  const out = { kind, n: clampInt(r.n, 1, 365) || 1 };
  if (kind === "week" && Array.isArray(r.days)) {
    const days = r.days.map((d) => clampInt(d, 0, 6)).filter((d) => d != null);
    if (days.length) out.days = [...new Set(days)].sort();
  }
  return out;
}

// A phone number reduced to E.164-ish digits so two spellings of the same
// number ("845-604-1462", "+18456041462") match each other.
export function normalizePhone(v) {
  let s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const plus = s.charAt(0) === "+";
  s = s.replace(/[^\d]/g, "");
  if (!s) return null;
  if (!plus && s.length === 10) s = "1" + s;          // bare US number
  if (!plus && s.length === 11 && s.charAt(0) === "1") { /* already 1NPANXXXXXX */ }
  if (s.length < 8 || s.length > 15) return null;
  return "+" + s;
}
function maskPhone(p) {
  const s = String(p || "");
  return s.length > 4 ? "•••• " + s.slice(-4) : s;
}

function cleanTag(t) {
  return String(t || "").trim().replace(/^#/, "").toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 30);
}
function validColor(c) {
  const s = String(c || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}
function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
function pick(a, b) { return a !== undefined && a !== null ? a : b; }
function parseJson(s) { if (!s) return null; try { return JSON.parse(s); } catch (_) { return null; } }
export function genId() {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function genFeedKey() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
