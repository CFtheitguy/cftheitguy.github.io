/* =============================================================================
 * Linear To-Do — client  (time.linearit.co/todo)
 * -----------------------------------------------------------------------------
 * The list itself: smart views down the left, a quick-add box that understands
 * plain English, and a detail drawer for everything a task can carry — due date
 * and time, a reminder, a repeat, steps, notes, priority, tags and a list.
 *
 * It shares the sign-in, the fetch wrapper and the notification plumbing with
 * the time tracker through the small `window.LT` bridge that app.js publishes,
 * so there's one session, one service worker and one set of helpers.
 *
 * Everything is optimistic where it's safe to be: ticking a task or starring it
 * redraws immediately and reconciles when the server answers, because a to-do
 * list that waits on the network for a checkbox feels broken.
 * ============================================================================= */
(function () {
  "use strict";

  var LT = window.LT;              // bridge from app.js
  var $ = LT.$, el = LT.el, clear = LT.clear, esc = LT.esc, toast = LT.toast, api = LT.api;

  /* ---- state ---- */
  var S = null;
  function fresh() {
    return {
      view: localStorage.getItem("lt_todo_view") || "myday",
      lists: [], todos: [], counts: {}, prefs: {}, tz: 0, now: Date.now(), today: "",
      search: "", sort: localStorage.getItem("lt_todo_sort") || "smart",
      selected: null, showCompleted: false, loading: false, notified: {},
    };
  }

  var VIEWS = [
    { key: "myday", ico: "☀️", name: "My Day" },
    { key: "today", ico: "📆", name: "Today" },
    { key: "overdue", ico: "⚠️", name: "Overdue" },
    { key: "planned", ico: "🗓️", name: "Planned" },
    { key: "important", ico: "⭐", name: "Important" },
    { key: "all", ico: "🗂️", name: "All tasks" },
    { key: "completed", ico: "✅", name: "Completed" },
  ];
  var PRIOS = [["None", 0], ["Low", 1], ["Med", 2], ["High", 3], ["Urgent", 4]];

  /* ============================================================
   * Boot / teardown — app.js calls these when it switches views
   * ============================================================ */
  async function open() {
    LT.showView("todo");
    if (!S) S = fresh();
    bindOnce();
    $("todo-sort").value = S.sort;
    await load();
  }
  function close() { closeDetail(); }

  async function load(quiet) {
    if (!quiet) S.loading = true;
    try {
      var d = await api("/api/todo/state?completed=1&tz_offset=" + new Date().getTimezoneOffset());
      S.lists = d.lists || [];
      S.todos = d.todos || [];
      S.counts = d.counts || {};
      S.prefs = d.prefs || {};
      S.tz = d.tz || 0;
      S.now = d.now || Date.now();
      S.today = d.today || "";
      S.intake = d.intake || {};
      S.loading = false;
      render();
    } catch (e) {
      S.loading = false;
      if (e.status !== 401) toast(e.error || "Couldn't load your tasks.");
    }
  }

  /* ============================================================
   * Which tasks belong in the current view
   * ============================================================ */
  function endOfToday() { return localMidnight(S.now) + 86400000; }
  function visible() {
    var v = S.view, q = S.search.trim().toLowerCase();
    var rows = S.todos.filter(function (t) {
      if (v === "completed") { if (t.status !== "done") return false; }
      else if (t.status !== "open") return false;

      if (v === "myday") { if (t.myday !== S.today) return false; }
      else if (v === "today") { if (!(t.due_at != null && t.due_at < endOfToday())) return false; }
      else if (v === "overdue") { if (!isLate(t)) return false; }
      else if (v === "planned") { if (t.due_at == null) return false; }
      else if (v === "important") { if (!t.important) return false; }
      else if (v.indexOf("list:") === 0) { if (t.list_id !== v.slice(5)) return false; }
      else if (v.indexOf("tag:") === 0) { if (t.tags.indexOf(v.slice(4)) === -1) return false; }

      if (q) {
        var hay = (t.title + " " + t.notes + " " + t.tags.join(" ") + " " +
          t.steps.map(function (s) { return s.title; }).join(" ")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    return sortRows(rows);
  }

  function sortRows(rows) {
    var s = S.sort;
    return rows.slice().sort(function (a, b) {
      if (s === "alpha") return a.title.localeCompare(b.title);
      if (s === "created") return b.created_at - a.created_at;
      if (s === "priority") return (b.priority - a.priority) || dueCmp(a, b);
      if (s === "due") return dueCmp(a, b);
      // smart: overdue first, then by due date, then starred, then position
      var la = isLate(a) ? 0 : 1, lb = isLate(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      var d = dueCmp(a, b);
      if (d !== 0) return d;
      if (a.important !== b.important) return a.important ? -1 : 1;
      return a.position - b.position;
    });
  }
  function dueCmp(a, b) {
    if (a.due_at == null && b.due_at == null) return 0;
    if (a.due_at == null) return 1;
    if (b.due_at == null) return -1;
    return a.due_at - b.due_at;
  }
  function isLate(t) {
    if (t.due_at == null || t.status !== "open") return false;
    return t.due_all_day ? t.due_at + 86400000 <= S.now : t.due_at <= S.now;
  }

  /* ============================================================
   * Render
   * ============================================================ */
  function render() {
    renderSide();
    renderHead();
    renderList();
  }

  function renderSide() {
    var host = $("todo-side"); clear(host);
    var g = el("div", { class: "navgroup" }, []);
    VIEWS.forEach(function (v) {
      var n = S.counts[v.key];
      g.appendChild(navItem(v.ico, v.name, v.key, v.key === "completed" ? null : n));
    });
    host.appendChild(g);

    host.appendChild(el("div", { class: "navsep" }, []));
    host.appendChild(el("div", { class: "navlabel", text: "Lists" }, []));
    var lg = el("div", { class: "navgroup" }, []);
    S.lists.forEach(function (l) {
      var key = "list:" + l.id;
      var item = navItem(l.emoji || null, l.name, key, (S.counts.lists || {})[l.id]);
      if (!l.emoji) {
        item.insertBefore(el("span", { class: "dot", style: "background:" + (l.color || "var(--accent)") }, []), item.firstChild);
      }
      lg.appendChild(item);
    });
    if (!S.lists.length) lg.appendChild(el("div", { class: "qa-tips", style: "padding:4px 10px", text: "No lists yet." }, []));
    host.appendChild(lg);
    host.appendChild(el("button", { class: "navitem", style: "color:var(--muted)", onclick: newList }, [
      el("span", { class: "ico", text: "＋" }, []), el("span", { class: "nm", text: "New list" }, []),
    ]));
  }

  function navItem(ico, name, key, count) {
    var kids = [];
    if (ico) kids.push(el("span", { class: "ico", text: ico }, []));
    kids.push(el("span", { class: "nm", text: name }, []));
    if (count) kids.push(el("span", { class: "ct", text: String(count) }, []));
    return el("button", {
      class: "navitem" + (S.view === key ? " active" : ""),
      onclick: function () { setView(key); },
    }, kids);
  }

  function setView(key) {
    S.view = key;
    localStorage.setItem("lt_todo_view", key);
    closeDetail();
    render();
  }

  function viewMeta() {
    var v = S.view;
    for (var i = 0; i < VIEWS.length; i++) if (VIEWS[i].key === v) return VIEWS[i];
    if (v.indexOf("list:") === 0) {
      var l = listById(v.slice(5));
      return l ? { key: v, ico: l.emoji || "📋", name: l.name, list: l } : VIEWS[0];
    }
    if (v.indexOf("tag:") === 0) return { key: v, ico: "#", name: v.slice(4) };
    return VIEWS[0];
  }

  function renderHead() {
    var m = viewMeta();
    $("todo-title").textContent = m.name;
    var sub = $("todo-sub");
    if (S.view === "myday") {
      sub.textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) +
        " — the short list of what you're actually doing today.";
    } else if (m.list) {
      sub.textContent = "";
    } else {
      sub.textContent = "";
    }
    // A list view gets rename/delete controls next to the heading.
    var old = $("list-actions");
    if (old) old.remove();
    if (m.list) {
      var wrap = el("span", { id: "list-actions", style: "display:inline-flex;gap:6px;margin-left:10px" }, [
        el("button", { class: "btn ghost sm", text: "Rename", onclick: function () { renameList(m.list); } }, []),
        el("button", { class: "btn ghost sm", text: "Delete", onclick: function () { deleteList(m.list); } }, []),
      ]);
      $("todo-title").appendChild(wrap);
    }
  }

  function renderList() {
    var host = $("todo-list"); clear(host);
    if (S.loading) { host.appendChild(el("div", { class: "empty", text: "Loading…" }, [])); return; }
    var rows = visible();
    if (!rows.length) { host.appendChild(el("div", { class: "empty", text: emptyLine() }, [])); return; }

    // In the dated views, break the list into Overdue / Today / Tomorrow / Later.
    var grouped = (S.sort === "smart" || S.sort === "due") && S.view !== "completed";
    if (!grouped) {
      host.appendChild(listOf(rows));
      return;
    }
    var buckets = [
      { name: "Overdue", rows: [] }, { name: "Today", rows: [] },
      { name: "Tomorrow", rows: [] }, { name: "Later", rows: [] }, { name: "No date", rows: [] },
    ];
    var eod = endOfToday();
    rows.forEach(function (t) {
      if (t.due_at == null) buckets[4].rows.push(t);
      else if (isLate(t)) buckets[0].rows.push(t);
      else if (t.due_at < eod) buckets[1].rows.push(t);
      else if (t.due_at < eod + 86400000) buckets[2].rows.push(t);
      else buckets[3].rows.push(t);
    });
    var shown = buckets.filter(function (b) { return b.rows.length; });
    if (shown.length === 1) { host.appendChild(listOf(rows)); return; }
    shown.forEach(function (b) {
      host.appendChild(el("div", { class: "groupname" }, [
        el("span", { text: b.name }, []), el("span", { class: "line" }, []),
        el("span", { text: String(b.rows.length) }, []),
      ]));
      host.appendChild(listOf(b.rows));
    });
  }

  function emptyLine() {
    if (S.search) return "Nothing matches “" + S.search + "”.";
    switch (S.view) {
      case "myday": return "Nothing in My Day yet. Open a task and tap “Add to My Day”, or add one above.";
      case "today": return "Nothing due today. 🎉";
      case "overdue": return "Nothing overdue — you're on top of it. 🎉";
      case "planned": return "No tasks with a date yet.";
      case "important": return "No starred tasks.";
      case "completed": return "Nothing completed in the last two weeks.";
      default: return "No tasks here yet — add one above.";
    }
  }

  function listOf(rows) {
    var box = el("div", { class: "tlist" }, []);
    rows.forEach(function (t) { box.appendChild(taskRow(t)); });
    return box;
  }

  function taskRow(t) {
    var done = t.status === "done";
    var meta = el("div", { class: "tmeta" }, []);

    if (t.due_at != null) {
      var cls = "m due" + (isLate(t) ? " late" : (t.due_at < endOfToday() ? " soon" : ""));
      meta.appendChild(el("span", { class: cls }, [
        el("span", { text: "🕘" }, []), el("span", { text: describeDue(t.due_at, t.due_all_day) }, []),
      ]));
    }
    if (t.repeat_label) meta.appendChild(el("span", { class: "m", text: "🔁 " + t.repeat_label }, []));
    if (t.steps.length) {
      var doneN = t.steps.filter(function (s) { return s.done; }).length;
      meta.appendChild(el("span", { class: "m", text: "☑ " + doneN + "/" + t.steps.length }, []));
    }
    if (t.notes) meta.appendChild(el("span", { class: "m", text: "📝" }, []));
    if (t.list_id && S.view.indexOf("list:") !== 0) {
      var l = listById(t.list_id);
      if (l) meta.appendChild(el("span", { class: "m", text: (l.emoji || "📋") + " " + l.name }, []));
    }
    t.tags.forEach(function (tag) {
      meta.appendChild(el("button", { class: "m tag", text: "#" + tag, onclick: function (e) { e.stopPropagation(); setView("tag:" + tag); } }, []));
    });
    if (t.source === "email") meta.appendChild(el("span", { class: "m", title: "Added by email", text: "✉️" }, []));
    if (t.source === "sms") meta.appendChild(el("span", { class: "m", title: "Added by text", text: "💬" }, []));
    if (t.myday === S.today && S.view !== "myday") meta.appendChild(el("span", { class: "m", title: "In My Day", text: "☀️" }, []));

    var row = el("div", { class: "titem" + (done ? " done" : "") + (S.selected === t.id ? " sel" : "") }, [
      t.priority ? el("span", { class: "prio p" + t.priority, title: PRIOS[t.priority][0] + " priority" }, []) : null,
      el("button", {
        class: "tcheck", text: "✓", title: done ? "Mark not done" : "Mark done",
        onclick: function (e) { e.stopPropagation(); toggleDone(t); },
      }, []),
      el("div", { class: "tbody", onclick: function () { openDetail(t.id); } }, [
        el("div", { class: "ttitle", text: t.title }, []),
        meta.childNodes.length ? meta : null,
      ]),
      el("button", {
        class: "tstar" + (t.important ? " on" : ""), text: t.important ? "★" : "☆",
        title: "Important", onclick: function (e) { e.stopPropagation(); toggleStar(t); },
      }, []),
    ].filter(Boolean));
    return row;
  }

  /* ============================================================
   * Actions
   * ============================================================ */
  async function addTask() {
    var input = $("qa-input");
    var text = input.value.trim();
    if (!text) return;
    var body = { text: text, tz_offset: new Date().getTimezoneOffset() };
    // Adding while looking at a list files it there; the same for My Day.
    if (S.view.indexOf("list:") === 0) body.list_id = S.view.slice(5);
    if (S.view === "myday") body.myday = true;
    if (S.view === "important") body.important = true;
    if (S.view.indexOf("tag:") === 0) body.tags = [S.view.slice(4)];

    input.value = "";
    hintFor("");
    try {
      var r = await api("/api/todo/add", { method: "POST", body: body });
      await load(true);
      if (r.todo) toast("Added: " + r.todo.title);
    } catch (e) {
      input.value = text;
      toast(e.error || "Couldn't add that.");
    }
  }

  async function toggleDone(t) {
    var done = t.status !== "done";
    t.status = done ? "done" : "open";            // optimistic
    render();
    try {
      var r = await api("/api/todo/complete", { method: "POST", body: { id: t.id, done: done } });
      if (r.rolled) toast("Done — next one " + r.rolled.label);
      await load(true);
    } catch (e) {
      t.status = done ? "open" : "done";
      render();
      toast(e.error || "Couldn't update that.");
    }
  }

  async function toggleStar(t) {
    t.important = !t.important;
    render();
    try { await api("/api/todo/update", { method: "POST", body: { id: t.id, important: t.important } }); await load(true); }
    catch (e) { t.important = !t.important; render(); toast(e.error || "Couldn't update that."); }
  }

  async function patch(id, body) {
    body.id = id;
    body.tz_offset = new Date().getTimezoneOffset();
    try {
      var r = await api("/api/todo/update", { method: "POST", body: body });
      var i = indexOf(id);
      if (i !== -1 && r.todo) S.todos[i] = r.todo;
      recount();
      render();
      if (S.selected === id) renderDetail();
      return r.todo;
    } catch (e) { toast(e.error || "Couldn't save."); return null; }
  }

  async function removeTask(id) {
    if (!confirm("Delete this task? This can't be undone.")) return;
    try {
      await api("/api/todo/delete", { method: "POST", body: { id: id } });
      closeDetail();
      await load(true);
      toast("Deleted.");
    } catch (e) { toast(e.error || "Couldn't delete."); }
  }

  /* ---- lists ---- */
  async function newList() {
    var name = prompt("Name the new list:", "");
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    try {
      var r = await api("/api/todo/list", { method: "POST", body: { action: "create", name: name } });
      S.lists = r.lists || [];
      if (r.id) setView("list:" + r.id); else render();
    } catch (e) { toast(e.error || "Couldn't create that list."); }
  }
  async function renameList(l) {
    var name = prompt("Rename “" + l.name + "” to:", l.name);
    if (name == null) return;
    name = name.trim();
    if (!name || name === l.name) return;
    try {
      var r = await api("/api/todo/list", { method: "POST", body: { action: "update", id: l.id, name: name } });
      S.lists = r.lists || [];
      render();
    } catch (e) { toast(e.error || "Couldn't rename."); }
  }
  async function deleteList(l) {
    if (!confirm("Delete the list “" + l.name + "”?\n\nIts tasks are kept — they just won't belong to a list any more.")) return;
    try {
      await api("/api/todo/list", { method: "POST", body: { action: "delete", id: l.id } });
      setView("all");
      await load(true);
      toast("List deleted — its tasks were kept.");
    } catch (e) { toast(e.error || "Couldn't delete."); }
  }

  /* ============================================================
   * Detail drawer
   * ============================================================ */
  function openDetail(id) {
    S.selected = id;
    render();
    renderDetail();
  }
  // Called by app.js on every view switch, including the one at boot before
  // anyone has signed in — so it must not assume there is any state yet.
  function closeDetail() {
    if (S) S.selected = null;
    clear($("detail-root"));
    var rows = document.querySelectorAll(".titem.sel");
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove("sel");
  }

  function renderDetail() {
    var t = byId(S.selected);
    var root = $("detail-root");
    clear(root);
    if (!t) return;

    var body = el("div", { class: "detail-body" }, []);

    /* title */
    var title = el("input", { class: "dtitle", type: "text", value: t.title, maxlength: "300" }, []);
    title.addEventListener("change", function () {
      var v = title.value.trim();
      if (v && v !== t.title) patch(t.id, { title: v });
    });
    body.appendChild(title);

    /* My Day + star + priority */
    var mydayOn = t.myday === S.today;
    body.appendChild(el("div", { class: "dgrid", style: "margin-top:10px" }, [
      el("button", {
        class: "btn " + (mydayOn ? "" : "ghost"), text: (mydayOn ? "☀️ In My Day" : "☀️ Add to My Day"),
        onclick: function () { patch(t.id, { myday: !mydayOn }); },
      }, []),
      el("button", {
        class: "btn " + (t.important ? "" : "ghost"), text: t.important ? "★ Important" : "☆ Important",
        onclick: function () { patch(t.id, { important: !t.important }); },
      }, []),
    ]));

    body.appendChild(el("div", { class: "dsec" }, [
      el("span", { class: "lbl", text: "Priority" }, []),
      el("div", { class: "prio-row" }, PRIOS.map(function (p) {
        return el("button", {
          class: t.priority === p[1] ? "on" : "", text: p[0],
          onclick: function () { patch(t.id, { priority: p[1] }); },
        }, []);
      })),
    ]));

    /* due date + time */
    var dueSec = el("div", { class: "dsec" }, [el("span", { class: "lbl", text: "Due" }, [])]);
    dueSec.appendChild(el("div", { class: "quickdays" }, [
      qd("Today", 0), qd("Tomorrow", 1), qd("Next week", 7),
      el("button", { class: "qd", text: "Clear", onclick: function () { patch(t.id, { due_at: null, due_all_day: false }); } }, []),
    ]));
    var dateIn = el("input", { type: "date", value: t.due_at != null ? ymdLocal(t.due_at) : "" }, []);
    var timeIn = el("input", { type: "time", value: (t.due_at != null && !t.due_all_day) ? hmLocal(t.due_at) : "" }, []);
    function commitDue() {
      if (!dateIn.value) { patch(t.id, { due_at: null, due_all_day: false }); return; }
      var parts = dateIn.value.split("-").map(Number);
      var allDay = !timeIn.value;
      var hm = allDay ? [0, 0] : timeIn.value.split(":").map(Number);
      var ms = fromLocal(parts[0], parts[1] - 1, parts[2], hm[0], hm[1]);
      patch(t.id, { due_at: ms, due_all_day: allDay });
    }
    dateIn.addEventListener("change", commitDue);
    timeIn.addEventListener("change", commitDue);
    dueSec.appendChild(el("div", { class: "dgrid" }, [dateIn, timeIn]));
    dueSec.appendChild(el("div", { class: "qa-tips", style: "padding-left:0",
      text: t.due_at == null ? "No date — it just sits on the list." :
        (t.due_all_day ? "All day. Add a time to get a reminder at that moment." : "") }, []));
    body.appendChild(dueSec);

    /* reminder */
    var remSec = el("div", { class: "dsec" }, [el("span", { class: "lbl", text: "Remind me" }, [])]);
    var remIn = el("input", { type: "datetime-local", value: t.remind_at != null ? dtLocal(t.remind_at) : "" }, []);
    remIn.addEventListener("change", function () {
      if (!remIn.value) { patch(t.id, { remind_at: null }); return; }
      var d = remIn.value.split("T"), ymd = d[0].split("-").map(Number), hm = d[1].split(":").map(Number);
      patch(t.id, { remind_at: fromLocal(ymd[0], ymd[1] - 1, ymd[2], hm[0], hm[1]) });
    });
    remSec.appendChild(remIn);
    remSec.appendChild(el("div", { class: "quickdays", style: "margin-top:8px" }, [
      remOff("At the due time", 0), remOff("10 min before", 10), remOff("1 hour before", 60), remOff("1 day before", 1440),
      el("button", { class: "qd", text: "None", onclick: function () { patch(t.id, { remind_at: null }); } }, []),
    ]));
    if (!hasPush()) {
      remSec.appendChild(el("div", { class: "qa-tips", style: "padding-left:0",
        text: "Turn on notifications in the time tracker to get reminders when the app is closed." }, []));
    }
    body.appendChild(remSec);

    /* repeat */
    var repSel = el("select", {}, [
      opt("", "Doesn't repeat"), opt("day:1", "Every day"), opt("weekday:1", "Every weekday"),
      opt("week:1", "Every week"), opt("week:2", "Every 2 weeks"),
      opt("month:1", "Every month"), opt("month:3", "Every 3 months"), opt("year:1", "Every year"),
    ]);
    repSel.value = t.repeat ? (t.repeat.kind + ":" + (t.repeat.n || 1)) : "";
    // A custom weekday pattern from the parser has no matching option; show it.
    if (t.repeat && repSel.value !== (t.repeat.kind + ":" + (t.repeat.n || 1))) {
      repSel.appendChild(opt(t.repeat.kind + ":" + (t.repeat.n || 1), t.repeat_label));
      repSel.value = t.repeat.kind + ":" + (t.repeat.n || 1);
    }
    repSel.addEventListener("change", function () {
      if (!repSel.value) { patch(t.id, { repeat: null }); return; }
      var b = repSel.value.split(":");
      patch(t.id, { repeat: { kind: b[0], n: Number(b[1]) || 1 } });
    });
    body.appendChild(el("div", { class: "dsec" }, [
      el("span", { class: "lbl", text: "Repeat" }, []), repSel,
      t.repeat ? el("div", { class: "qa-tips", style: "padding-left:0", text: "Ticking it off moves it to the next date instead of closing it." }, []) : null,
    ].filter(Boolean)));

    /* list + tags */
    var listSel = el("select", {}, [opt("", "No list")].concat(S.lists.map(function (l) {
      return opt(l.id, (l.emoji ? l.emoji + " " : "") + l.name);
    })));
    listSel.value = t.list_id || "";
    listSel.addEventListener("change", function () { patch(t.id, { list_id: listSel.value || null }); });
    body.appendChild(el("div", { class: "dsec" }, [el("span", { class: "lbl", text: "List" }, []), listSel]));

    var tagsIn = el("input", { type: "text", value: t.tags.join(", "), placeholder: "calls, billing" }, []);
    tagsIn.addEventListener("change", function () {
      patch(t.id, { tags: tagsIn.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean) });
    });
    body.appendChild(el("div", { class: "dsec" }, [el("span", { class: "lbl", text: "Tags" }, []), tagsIn]));

    /* steps */
    var stepsSec = el("div", { class: "dsec" }, [el("span", { class: "lbl", text: "Steps" }, [])]);
    var stepBox = el("div", { class: "steps" }, []);
    t.steps.forEach(function (s) {
      stepBox.appendChild(el("div", { class: "step" + (s.done ? " done" : "") }, [
        el("button", { class: "sc", text: "✓", onclick: function () { stepAction({ action: "toggle", id: s.id, done: !s.done }); } }, []),
        el("span", { class: "stx", text: s.title, onclick: function () {
          var v = prompt("Step:", s.title);
          if (v != null && v.trim() && v.trim() !== s.title) stepAction({ action: "rename", id: s.id, title: v.trim() });
        } }, []),
        el("button", { class: "sx", text: "✕", title: "Remove step", onclick: function () { stepAction({ action: "delete", id: s.id }); } }, []),
      ]));
    });
    stepsSec.appendChild(stepBox);
    var stepIn = el("input", { type: "text", placeholder: "Add a step", style: "margin-top:8px" }, []);
    stepIn.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var v = stepIn.value.trim();
      if (!v) return;
      stepIn.value = "";
      stepAction({ action: "add", todo_id: t.id, title: v });
    });
    stepsSec.appendChild(stepIn);
    body.appendChild(stepsSec);

    /* notes */
    var notes = el("textarea", { class: "notes", placeholder: "Notes" }, []);
    notes.value = t.notes || "";
    notes.addEventListener("change", function () { if (notes.value !== t.notes) patch(t.id, { notes: notes.value }); });
    body.appendChild(el("div", { class: "dsec" }, [el("span", { class: "lbl", text: "Notes" }, []), notes]));

    /* provenance */
    var srcWord = t.source === "email" ? "Added by email" : t.source === "sms" ? "Added by text message" : "Added in the app";
    body.appendChild(el("div", { class: "dmeta" }, [
      el("div", { text: srcWord + " · " + new Date(t.created_at).toLocaleString() }, []),
      t.completed_at ? el("div", { text: "Completed " + new Date(t.completed_at).toLocaleString() }, []) : null,
    ].filter(Boolean)));

    var panel = el("div", { class: "detail" }, [
      el("div", { class: "detail-head" }, [
        el("span", { class: "t", text: "Task details" }, []),
        el("button", { class: "iconbtn", text: "✕", title: "Close", onclick: closeDetail }, []),
      ]),
      body,
      el("div", { class: "detail-foot" }, [
        el("button", { class: "btn ghost sm", text: t.status === "done" ? "Reopen" : "Mark done", onclick: function () { toggleDone(t); closeDetail(); } }, []),
        el("span", { class: "spacer" }, []),
        el("button", { class: "btn danger sm", text: "Delete", onclick: function () { removeTask(t.id); } }, []),
      ]),
    ]);
    root.appendChild(panel);
    requestAnimationFrame(function () { panel.classList.add("open"); });

    /* helpers scoped to this task */
    function qd(label, plusDays) {
      return el("button", { class: "qd", text: label, onclick: function () {
        var base = new Date();
        base.setHours(0, 0, 0, 0);
        base.setDate(base.getDate() + plusDays);
        var keepTime = t.due_at != null && !t.due_all_day;
        if (keepTime) {
          var old = new Date(t.due_at);
          base.setHours(old.getHours(), old.getMinutes(), 0, 0);
        }
        patch(t.id, { due_at: base.getTime(), due_all_day: !keepTime });
      } }, []);
    }
    function remOff(label, minsBefore) {
      return el("button", { class: "qd", text: label, onclick: function () {
        if (t.due_at == null) { toast("Give it a due date first."); return; }
        var anchor = t.due_all_day ? t.due_at + 9 * 3600000 : t.due_at;
        patch(t.id, { remind_at: anchor - minsBefore * 60000 });
      } }, []);
    }
  }

  async function stepAction(body) {
    try {
      var r = await api("/api/todo/step", { method: "POST", body: body });
      var i = indexOf(r.todo ? r.todo.id : (body.todo_id || ""));
      if (i !== -1 && r.todo) S.todos[i] = r.todo;
      render();
      renderDetail();
    } catch (e) { toast(e.error || "Couldn't update the step."); }
  }

  /* ============================================================
   * Quick-add live hint — echoes back what the parser understood
   * ============================================================ */
  var hintTimer = null, lastHinted = "";
  function hintFor(text) {
    clearTimeout(hintTimer);
    if (!text.trim()) { clear($("qa-hint")); lastHinted = ""; return; }
    hintTimer = setTimeout(async function () {
      if (text === lastHinted) return;
      lastHinted = text;
      try {
        var p = await api("/api/todo/parse", { method: "POST", body: { text: text, tz_offset: new Date().getTimezoneOffset() } });
        var host = $("qa-hint"); clear(host);
        if (!p.summary || !p.summary.length) return;
        host.appendChild(el("span", { class: "pill g", text: p.title || "(untitled)" }, []));
        if (p.due_label) host.appendChild(el("span", { class: "pill", text: "🕘 " + p.due_label }, []));
        if (p.repeat_label) host.appendChild(el("span", { class: "pill", text: "🔁 " + p.repeat_label }, []));
        if (p.priority) host.appendChild(el("span", { class: "pill", text: "❗" + PRIOS[p.priority][0] }, []));
        if (p.important) host.appendChild(el("span", { class: "pill", text: "★" }, []));
        (p.tags || []).forEach(function (t) { host.appendChild(el("span", { class: "pill n", text: "#" + t }, [])); });
        if (p.list_hint) host.appendChild(el("span", { class: "pill n", text: "📋 " + p.list_hint }, []));
      } catch (_) { /* the hint is a nicety; never block typing on it */ }
    }, 220);
  }

  /* ============================================================
   * Settings
   * ============================================================ */
  function openSettings() {
    var p = S.prefs || {};
    var intake = S.intake || {};
    var root = $("modal-root"); clear(root);
    var body = el("div", {}, []);

    /* --- email intake --- */
    var addr = intake.email || "task@linearit.co";
    body.appendChild(section("✉️ Add tasks by email",
      "Email or forward anything to this address and it becomes a task — the subject is the task, the body becomes notes, and “- ” lines become steps.",
      [
        copyRow(addr),
        el("div", { class: "sdesc", style: "margin-top:8px", html:
          "Send to <b>" + esc(addr.replace("@", "+listname@")) + "</b> to file it straight into a list. " +
          "Only mail from an address below is accepted." }, []),
      ]));

    var altIn = el("input", { type: "text", value: (p.alt_emails || []).join(", "), placeholder: "personal@gmail.com, me@work.com" }, []);
    body.appendChild(section("Addresses allowed to send",
      "Your sign-in address always works. Add any other address you'd send from.",
      [altIn, el("button", { class: "btn sm", style: "margin-top:8px", text: "Save addresses", onclick: async function () {
        try {
          var r = await api("/api/todo/prefs", { method: "POST", body: { alt_emails: altIn.value, tz_offset: new Date().getTimezoneOffset() } });
          S.prefs = r.prefs; toast("Saved.");
        } catch (e) { toast(e.error || "Couldn't save."); }
      } }, [])]));

    /* --- SMS intake --- */
    var smsKids = [];
    if (p.phone) {
      smsKids.push(el("div", { class: "sdesc", html: "Linked: <b>" + esc(p.phone) + "</b>. Text a task any time. Reply <code>LIST</code> for today, <code>DONE 2</code> to tick one off, <code>HELP</code> for more." }, []));
      smsKids.push(el("button", { class: "btn ghost sm", style: "margin-top:8px", text: "Unlink this number", onclick: async function () {
        if (!confirm("Unlink " + p.phone + "? Texts from it will no longer create tasks.")) return;
        try { var r = await api("/api/todo/phone", { method: "POST", body: { action: "remove" } }); S.prefs = r.prefs; openSettings(); toast("Unlinked."); }
        catch (e) { toast(e.error || "Couldn't unlink."); }
      } }, []));
    } else if (p.phone_pending && p.phone_code) {
      smsKids.push(el("div", { class: "sdesc", html: "Almost there. From <b>" + esc(p.phone_pending) + "</b>, text this code to <b>" + esc(prettyPhone(intake.sms) || "the Linear number") + "</b>:" }, []));
      smsKids.push(el("div", { class: "bigcode", text: p.phone_code }, []));
      smsKids.push(el("button", { class: "btn sm", text: "I've sent it — check", onclick: async function () {
        await load(true); openSettings();
      } }, []));
    } else {
      var phoneIn = el("input", { type: "text", inputmode: "tel", placeholder: "(845) 604-1462" }, []);
      smsKids.push(phoneIn);
      smsKids.push(el("button", { class: "btn sm", style: "margin-top:8px", text: "Link this number", onclick: async function () {
        try {
          var r = await api("/api/todo/phone", { method: "POST", body: { phone: phoneIn.value, tz_offset: new Date().getTimezoneOffset() } });
          S.prefs = r.prefs;
          if (r.sms_to) S.intake = Object.assign({}, S.intake, { sms: r.sms_to });
          openSettings();
        } catch (e) { toast(e.error || "Couldn't start linking."); }
      } }, []));
    }
    body.appendChild(section("💬 Add tasks by text message",
      "Text a task to the Linear number and it lands on this list, with a reply confirming what was understood.",
      smsKids));

    /* --- default list --- */
    var defSel = el("select", {}, [opt("", "No list")].concat(S.lists.map(function (l) {
      return opt(l.id, (l.emoji ? l.emoji + " " : "") + l.name);
    })));
    defSel.value = p.default_list || "";
    defSel.addEventListener("change", async function () {
      try { var r = await api("/api/todo/prefs", { method: "POST", body: { default_list: defSel.value || null } }); S.prefs = r.prefs; toast("Saved."); }
      catch (e) { toast(e.error || "Couldn't save."); }
    });
    body.appendChild(section("Default list", "Where tasks land when nothing else says otherwise.", [defSel]));

    /* --- receipts --- */
    var rc = el("input", { type: "checkbox" }, []);
    rc.checked = !!p.intake_receipt;
    rc.addEventListener("change", async function () {
      try { var r = await api("/api/todo/prefs", { method: "POST", body: { intake_receipt: rc.checked } }); S.prefs = r.prefs; }
      catch (e) { toast(e.error || "Couldn't save."); }
    });
    body.appendChild(section("Email me a receipt", "Confirms each task that arrives by email.",
      [el("label", { style: "display:flex;align-items:center;gap:9px;font-size:14px" }, [rc, el("span", { text: "Send a confirmation email" }, [])])]));

    /* --- calendar feed --- */
    if (p.feed_key) {
      var feed = (location.hostname === "time.linearit.co" ? "https://time.linearit.co" : "https://time.linearit.co") +
        "/api/todo/feed.ics?key=" + p.feed_key;
      body.appendChild(section("📅 Calendar feed",
        "Subscribe in Outlook, Google or Apple Calendar to see dated tasks alongside your meetings. Read-only — keep the link private.",
        [copyRow(feed)]));
    }

    root.appendChild(el("div", { class: "scrim", onclick: function (e) { if (e.target === e.currentTarget) clear(root); } }, [
      el("div", { class: "modal wide" }, [
        el("div", { class: "detail-head", style: "padding:0 0 12px;margin-bottom:4px" }, [
          el("h3", { style: "flex:1;margin:0", text: "To-Do settings" }, []),
          el("button", { class: "iconbtn", text: "✕", onclick: function () { clear(root); } }, []),
        ]),
        el("div", { style: "max-height:70vh;overflow-y:auto" }, [body]),
      ]),
    ]));

    function section(name, desc, kids) {
      return el("div", { class: "setting" }, [
        el("div", { class: "sinfo" }, [
          el("div", { class: "sname", text: name }, []),
          el("div", { class: "sdesc", text: desc }, []),
          el("div", { style: "margin-top:9px" }, kids),
        ]),
      ]);
    }
    function copyRow(text) {
      return el("div", { class: "copyrow" }, [
        el("code", { text: text }, []),
        el("button", { class: "btn ghost sm", text: "Copy", onclick: function () {
          if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, function () {});
          else toast(text);
        } }, []),
      ]);
    }
  }

  /* ============================================================
   * In-app reminders — when the app is open, fire at the exact minute
   * rather than waiting for the server's push to come back around.
   * ============================================================ */
  function checkReminders() {
    if (!S) return;
    var now = Date.now();
    S.todos.forEach(function (t) {
      if (t.status !== "open" || t.remind_at == null) return;
      if (t.remind_at > now || now - t.remind_at > 10 * 60000) return;
      if (S.notified[t.id]) return;
      S.notified[t.id] = 1;
      LT.notify(t.title, t.due_at != null ? "Due " + describeDue(t.due_at, t.due_all_day) : "Linear To-Do reminder");
      toast("⏰ " + t.title);
    });
  }

  /* ============================================================
   * Local time helpers (mirrors of the ones on the server)
   * ============================================================ */
  function fromLocal(y, mo, d, h, mi) { return new Date(y, mo, d, h || 0, mi || 0, 0, 0).getTime(); }
  function localMidnight(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function ymdLocal(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function hmLocal(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function dtLocal(ms) { return ymdLocal(ms) + "T" + hmLocal(ms); }

  function describeDue(ms, allDay) {
    var d = new Date(ms), t = new Date();
    var days = Math.round((localMidnight(ms) - localMidnight(t.getTime())) / 86400000);
    var day;
    if (days === 0) day = "Today";
    else if (days === 1) day = "Tomorrow";
    else if (days === -1) day = "Yesterday";
    else if (days > 1 && days < 7) day = d.toLocaleDateString([], { weekday: "long" });
    else day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    if (allDay) return day;
    return day + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  /* ---- misc ---- */
  function byId(id) { for (var i = 0; i < S.todos.length; i++) if (S.todos[i].id === id) return S.todos[i]; return null; }
  function indexOf(id) { for (var i = 0; i < S.todos.length; i++) if (S.todos[i].id === id) return i; return -1; }
  function listById(id) { for (var i = 0; i < S.lists.length; i++) if (S.lists[i].id === id) return S.lists[i]; return null; }
  function opt(v, t) { return el("option", { value: v, text: t }, []); }
  function hasPush() { return "Notification" in window && Notification.permission === "granted"; }
  // "+18456041462" -> "(845) 604-1462" so the number is readable when someone
  // has to type it into their phone.
  function prettyPhone(p) {
    var s = String(p || "");
    var m = s.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
    return m ? "(" + m[1] + ") " + m[2] + "-" + m[3] : s;
  }
  // Recount the view badges locally so they don't lag a redraw.
  function recount() {
    var c = { myday: 0, today: 0, overdue: 0, planned: 0, important: 0, all: 0, lists: {} };
    var eod = endOfToday();
    S.todos.forEach(function (t) {
      if (t.status !== "open") return;
      c.all++;
      if (t.myday === S.today) c.myday++;
      if (t.due_at != null && t.due_at < eod) c.today++;
      if (isLate(t)) c.overdue++;
      if (t.due_at != null) c.planned++;
      if (t.important) c.important++;
      if (t.list_id) c.lists[t.list_id] = (c.lists[t.list_id] || 0) + 1;
    });
    S.counts = c;
  }

  /* ============================================================
   * Wiring
   * ============================================================ */
  var bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    $("qa-add").addEventListener("click", addTask);
    $("qa-input").addEventListener("keydown", function (e) { if (e.key === "Enter") addTask(); });
    $("qa-input").addEventListener("input", function () { hintFor(this.value); });
    $("todo-search").addEventListener("input", function () { S.search = this.value; renderList(); });
    $("todo-sort").addEventListener("change", function () {
      S.sort = this.value; localStorage.setItem("lt_todo_sort", S.sort); renderList();
    });
    $("btn-todo-settings").addEventListener("click", openSettings);
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if ($("detail-root").firstChild) closeDetail();
    });
    // Re-read the board when the tab comes back, so a task added by text or
    // email while the phone was in a pocket is already there.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && S && !$("view-todo").classList.contains("hidden")) load(true);
    });
    setInterval(function () {
      if (!S || $("view-todo").classList.contains("hidden")) return;
      S.now = Date.now();
      checkReminders();
    }, 20000);
  }

  window.LinearTodo = { open: open, close: close, reload: function () { if (S) load(true); } };
})();
