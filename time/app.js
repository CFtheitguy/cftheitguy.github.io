/* =============================================================================
 * Linear Time — client app  (time.linearit.co / www.linearit.co/time/)
 * -----------------------------------------------------------------------------
 * An installable PWA. Three roles share one sign-in (email + a one-time code):
 *   • Worker       tracks their own day: pick a task, a 30-min check-in nudges
 *                  "still on this?", end it and it asks for the next one.
 *   • Company admin  reads the reports for their one company.
 *   • Super admin    reads every company + creates companies / appoints admins.
 *
 * The session token is kept in localStorage so the app can reopen straight into
 * your day when your computer launches it at login. Nothing else is stored except
 * a per-task "next check-in" time so reminders survive a reload.
 * ============================================================================= */
(function () {
  "use strict";

  /* ---- Config ---- */
  // Served from GitHub Pages -> talk to the Worker; served by the Worker -> same-origin.
  var API_BASE = location.hostname === "time.linearit.co" ? "" : "https://time.linearit.co";
  var CHECKIN_MS = (parseInt(localStorage.getItem("lt_checkin_min"), 10) || 30) * 60 * 1000;
  var PRESET_META = {
    breakfast: { emoji: "🍳", label: "Breakfast", sub: "Grab a bite" },
    exercise:  { emoji: "🏃", label: "Exercise",  sub: "Move a little" },
    break:     { emoji: "☕", label: "Break",     sub: "Recharge" },
  };

  /* ---- Persisted session ---- */
  function getToken() { return localStorage.getItem("lt_token") || ""; }
  function setToken(t) { if (t) localStorage.setItem("lt_token", t); }
  function getProfile() { try { return JSON.parse(localStorage.getItem("lt_profile") || "null"); } catch (_) { return null; } }
  function setProfile(p) { localStorage.setItem("lt_profile", JSON.stringify(p)); }
  function clearSession() {
    localStorage.removeItem("lt_token");
    localStorage.removeItem("lt_profile");
  }

  /* ---- Runtime state ---- */
  var authHints = null;    // {isSuper,isAdmin,isWorker} from /auth/start
  var pendingEmail = "";
  var T = null;            // tracker state
  function freshTracker() {
    return { day: todayStr(), entries: [], running: null, presetsUsed: [], presets: ["breakfast", "exercise", "break"],
      skew: 0, picking: false, modalOpen: false, dayEnded: false, wrapHour: 17, wrapSnoozeUntil: 0 };
  }
  var A = null;            // admin state
  var ticker = null;
  var swReg = null;       // service-worker registration (for notifications)

  /* ============================================================
   * Tiny DOM helpers
   * ============================================================ */
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function show(id) { $(id).classList.remove("hidden"); }
  function hide(id) { $(id).classList.add("hidden"); }
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* ============================================================
   * Time formatting
   * ============================================================ */
  function now() { return Date.now() + (T ? T.skew : 0); }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtClock(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }
  function fmtDur(ms) {
    if (ms < 0) ms = 0;
    var m = Math.round(ms / 60000), h = Math.floor(m / 60);
    m = m % 60;
    return h > 0 ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
  }
  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function fmtLongDate(d) {
    return (d || new Date()).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  }
  function greetWord(d) {
    var h = (d || new Date()).getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }
  function firstName(name) { return (name || "").trim().split(/\s+/)[0] || ""; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ============================================================
   * API
   * ============================================================ */
  async function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (opts.auth !== false) {
      var tk = getToken();
      if (tk) headers.Authorization = "Bearer " + tk;
    }
    var res;
    try {
      res = await fetch(API_BASE + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      throw { status: 0, error: "Network error. Check your connection." };
    }
    var data = {};
    try { data = await res.json(); } catch (_) {}
    if (data && data.token) setToken(data.token); // sliding session
    if (!res.ok) {
      if (res.status === 401 && opts.auth !== false) { clearSession(); routeToAuth(); }
      throw { status: res.status, error: (data && data.error) || ("HTTP " + res.status), need: data && data.need };
    }
    return data;
  }

  /* ============================================================
   * View switching
   * ============================================================ */
  function showView(which) {
    ["view-auth", "view-tracker", "view-admin"].forEach(function (v) {
      $(v).classList.toggle("hidden", v !== "view-" + which);
    });
  }
  function routeToAuth() {
    stopTicker(); T = null; A = null;
    showView("auth");
    $("auth-code").classList.add("hidden");
    $("auth-email").classList.remove("hidden");
    $("err-email").textContent = ""; $("err-code").textContent = "";
    $("in-code").value = "";
  }
  function routeAfterLogin() {
    var p = getProfile();
    if (!p) return routeToAuth();
    if (p.role === "worker") startTracker();
    else startAdmin();
  }

  /* ============================================================
   * AUTH
   * ============================================================ */
  async function sendCode() {
    var email = $("in-email").value.trim().toLowerCase();
    $("err-email").textContent = "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("err-email").textContent = "Enter a valid email address."; return; }
    var btn = $("btn-sendcode"); btn.disabled = true; var old = btn.innerHTML; btn.innerHTML = '<span class="spin"></span>';
    try {
      authHints = await api("/api/auth/start", { method: "POST", auth: false, body: { email: email } });
      await api("/api/auth/code", { method: "POST", auth: false, body: { email: email } });
      pendingEmail = email;
      $("code-dest").textContent = email;
      var known = authHints.isSuper || authHints.isAdmin || authHints.isWorker;
      $("new-worker").classList.toggle("hidden", !!known); // brand-new worker must add name + company code
      $("auth-email").classList.add("hidden");
      $("auth-code").classList.remove("hidden");
      setTimeout(function () { $("in-code").focus(); }, 50);
    } catch (e) {
      $("err-email").textContent = e.error || "Something went wrong.";
    } finally { btn.disabled = false; btn.innerHTML = old; }
  }

  async function verifyCode() {
    var code = $("in-code").value.trim();
    $("err-code").textContent = "";
    if (!/^\d{4,8}$/.test(code)) { $("err-code").textContent = "Enter the 6-digit code from your email."; return; }
    var body = { email: pendingEmail, code: code, tz_offset: new Date().getTimezoneOffset() };
    if (!$("new-worker").classList.contains("hidden")) {
      body.name = $("in-name").value.trim();
      body.company_code = $("in-company").value.trim().toUpperCase();
    }
    var btn = $("btn-verify"); btn.disabled = true; var old = btn.innerHTML; btn.innerHTML = '<span class="spin"></span>';
    try {
      var out = await api("/api/auth/verify", { method: "POST", auth: false, body: body });
      setToken(out.token); setProfile(out.profile);
      routeAfterLogin();
    } catch (e) {
      if (e.need === "profile") $("new-worker").classList.remove("hidden");
      $("err-code").textContent = e.error || "Couldn't sign you in.";
    } finally { btn.disabled = false; btn.innerHTML = old; }
  }

  /* ============================================================
   * TRACKER (worker)
   * ============================================================ */
  async function startTracker() {
    showView("tracker");
    T = freshTracker();
    maybeShowNotifyBanner();
    await loadDay();
    startTicker();
  }

  async function loadDay() {
    try {
      var d = await api("/api/day?day=" + todayStr());
      T.skew = (d.serverNow || Date.now()) - Date.now();
      T.day = d.day;
      T.entries = d.entries || [];
      T.running = d.running || null;
      T.presetsUsed = d.presetsUsed || [];
      T.presets = d.presets || T.presets;
      T.dayEnded = !!d.dayEnded;
      T.wrapHour = d.wrapHour || 17;
      if (d.profile && d.profile.name) {
        var p = getProfile() || {}; p.name = d.profile.name; setProfile(p);
      }
      // A task still running from a previous day → close it and start fresh today.
      if (T.running && T.running.day && T.running.day !== todayStr()) {
        await api("/api/task/end", { method: "POST" });
        notify("New day", "Yesterday's last task was closed automatically.");
        return loadDay();
      }
      refreshSWAuth();       // keep the service worker's token fresh for push
      renderTracker();
      maybeWrapUp();
    } catch (e) { if (e.status !== 401) toast(e.error || "Couldn't load your day."); }
  }

  function renderTracker() {
    var p = getProfile() || {};
    $("who-tracker").innerHTML = "<b>" + esc(p.name || p.email) + "</b><br>" + esc(p.company_name || "");
    $("greeting").innerHTML = greetWord() + (firstName(p.name) ? ", " + esc(firstName(p.name)) : "") + ' <span class="wave">👋</span>';
    $("today-date").textContent = fmtLongDate();

    // Day is over → show a wrap-up summary instead of the picker/timer.
    if (T.dayEnded) {
      $("picker").classList.add("hidden");
      $("runbox").classList.add("hidden");
      $("dayend-box").classList.remove("hidden");
      $("btn-endday").classList.add("hidden");
      renderDayEnd();
      renderLog();
      return;
    }
    $("dayend-box").classList.add("hidden");
    $("btn-endday").classList.remove("hidden");

    var running = T.running;
    var showPicker = !running || T.picking;
    $("picker").classList.toggle("hidden", !showPicker);
    $("runbox").classList.toggle("hidden", showPicker);

    if (showPicker) renderPicker();
    if (running) renderRunning();
    renderLog();
  }

  function renderDayEnd() {
    var box = $("dayend-box"); clear(box);
    var total = 0, count = T.entries.length;
    T.entries.forEach(function (e) { total += (e.ended_at || e.started_at) - e.started_at; });
    box.appendChild(el("div", { class: "emoji", style: "font-size:40px", text: "🌙" }, []));
    box.appendChild(el("h3", { style: "font-size:22px;margin:6px 0 2px", text: "Day complete — nice work!" }, []));
    box.appendChild(el("p", { class: "sub", style: "margin:2px 0 18px",
      text: count + (count === 1 ? " task" : " tasks") + " · " + fmtDur(total) + " tracked today" }, []));
    box.appendChild(el("button", { class: "btn lg", text: "Start working again", onclick: resumeDay }, []));
  }

  function renderPicker() {
    var hasStuff = T.entries.length > 0 || T.running;
    $("prompt-title").textContent = T.picking ? "Switch to…" : (hasStuff ? "What's next?" : "What's your first task?");
    var tiles = $("preset-tiles"); clear(tiles);
    T.presets.forEach(function (key) {
      if (T.presetsUsed.indexOf(key) !== -1) return; // once-a-day: hide if already logged today
      var m = PRESET_META[key] || { emoji: "•", label: cap(key), sub: "" };
      tiles.appendChild(el("button", { class: "tile", onclick: function () { startTask(m.label, key); } }, [
        el("span", { class: "emoji", text: m.emoji }),
        el("span", { class: "t", text: m.label }),
        el("span", { class: "s", text: m.sub }),
      ]));
    });
    // If switching, offer a way back to the current task.
    var backHost = $("prompt-title");
    var existingBack = $("btn-keep-current");
    if (existingBack) existingBack.remove();
    if (T.picking && T.running) {
      backHost.appendChild(el("button", {
        id: "btn-keep-current", class: "btn ghost sm", style: "margin-left:12px;vertical-align:middle",
        text: "Keep current", onclick: function () { T.picking = false; renderTracker(); }
      }, []));
    }
    $("in-task").value = "";
    $("err-task").textContent = "";
  }

  function renderRunning() {
    var r = T.running;
    $("run-name").textContent = r.task;
    $("run-since").textContent = "Started " + fmtTime(r.started_at);
    tickClock();
    var due = checkinAt(r);
    $("checkin-note").textContent = "Next check-in around " + fmtTime(due);
  }

  function renderLog() {
    var host = $("log-wrap"); clear(host);
    var rows = T.entries.slice();
    // include a running task that may not be in entries list yet
    if (T.running && !rows.some(function (e) { return e.id === T.running.id; })) rows.push(T.running);
    rows.sort(function (a, b) { return a.started_at - b.started_at; });
    if (!rows.length) { host.appendChild(el("div", { class: "empty", text: "No tasks yet today — pick one above to start the clock." }, [])); return; }
    var total = 0;
    var table = el("table", {}, [el("thead", {}, [el("tr", {}, [
      th("Task"), th("From"), th("To"), thNum("Duration"),
    ])])]);
    var tb = el("tbody", {}, []);
    rows.forEach(function (e) {
      var end = e.ended_at || now();
      var dur = end - e.started_at; total += dur;
      var live = e.ended_at == null;
      tb.appendChild(el("tr", {}, [
        el("td", {}, [document.createTextNode(e.task + " "), e.preset ? el("span", { class: "badge", text: e.preset }, []) : null]),
        el("td", { class: "mono", text: fmtTime(e.started_at) }, []),
        el("td", {}, [live ? el("span", { class: "badge live", text: "running" }, []) : document.createTextNode(fmtTime(e.ended_at))]),
        el("td", { class: "num mono", text: fmtDur(dur) }, []),
      ]));
    });
    tb.appendChild(el("tr", { class: "total-row" }, [
      el("td", { colspan: "3", text: "Total" }, []), el("td", { class: "num mono", text: fmtDur(total) }, []),
    ]));
    table.appendChild(tb);
    host.appendChild(el("div", { class: "tablewrap" }, [table]));
  }

  /* ---- start / switch / end ---- */
  async function startTask(task, preset) {
    task = (task || "").trim();
    $("err-task").textContent = "";
    if (!task) { $("err-task").textContent = "Type what you're doing, or pick one above."; return; }
    try {
      await api("/api/task/start", { method: "POST", body: { day: todayStr(), task: task, preset: preset || null, tz_offset: new Date().getTimezoneOffset() } });
      T.picking = false;
      closeModal();
      await loadDay();
    } catch (e) { $("err-task").textContent = e.error || "Couldn't start the task."; }
  }
  async function endTask() {
    try {
      await api("/api/task/end", { method: "POST" });
      T.picking = false;
      await loadDay(); // running becomes null → picker shows "What's next?"
    } catch (e) { toast(e.error || "Couldn't end the task."); }
  }

  /* ---- end / resume the whole day ---- */
  async function endDay() {
    try {
      closeModal();
      await api("/api/day/end", { method: "POST", body: { day: todayStr() } });
      await loadDay(); // dayEnded → summary
    } catch (e) { toast(e.error || "Couldn't end the day."); }
  }
  async function resumeDay() {
    try {
      await api("/api/day/resume", { method: "POST", body: { day: todayStr() } });
      T.wrapSnoozeUntil = now() + 60 * 60 * 1000; // don't immediately re-ask to wrap up
      await loadDay();
    } catch (e) { toast(e.error || "Couldn't reopen the day."); }
  }

  /* ---- 30-minute check-in (scheduled on the server, mirrored here) ---- */
  function checkinAt(r) { return r && r.checkin_at ? r.checkin_at : (r ? r.started_at + CHECKIN_MS : 0); }
  function maybeCheckin() {
    if (!T || !T.running || T.modalOpen || T.dayEnded) return;
    if (now() >= checkinAt(T.running)) openCheckin();
  }
  function openCheckin() {
    var r = T.running; if (!r) return;
    T.modalOpen = true;
    notify("Still working on “" + r.task + "”?", "You've been on this about " + fmtDur(now() - r.started_at) + ". Keep going or switch?");
    var root = $("modal-root"); clear(root);
    root.appendChild(el("div", { class: "scrim" }, [
      el("div", { class: "modal" }, [
        el("div", { class: "emoji", text: "⏱️" }, []),
        el("h3", { text: "Still on this task?" }, []),
        el("p", { html: "You've been working on <b>" + esc(r.task) + "</b> for about " + fmtDur(now() - r.started_at) + "." }, []),
        el("div", { class: "actions" }, [
          el("button", { class: "btn success lg", text: "Yes, keep going", onclick: async function () {
            closeModal();
            try { await api("/api/task/checkin", { method: "POST" }); } catch (_) {}
            await loadDay(); // picks up the new checkin_at
          } }, []),
          el("button", { class: "btn ghost lg", text: "No, I'll pick something else", onclick: function () {
            closeModal(); endTask();
          } }, []),
        ]),
      ]),
    ]));
  }

  /* ---- after-5pm wrap-up prompt ---- */
  function maybeWrapUp() {
    if (!T || T.dayEnded || T.modalOpen) return;
    if (now() < T.wrapSnoozeUntil) return;
    if (new Date().getHours() < (T.wrapHour || 17)) return;
    openWrap();
  }
  function openWrap() {
    T.modalOpen = true;
    notify("Wrap up your day?", "It's after 5:00 PM. End your day or keep going.");
    var root = $("modal-root"); clear(root);
    root.appendChild(el("div", { class: "scrim" }, [
      el("div", { class: "modal" }, [
        el("div", { class: "emoji", text: "🌇" }, []),
        el("h3", { text: "Wrapping up for the day?" }, []),
        el("p", { text: "It's after 5:00 PM. You can end your day now, or keep working." }, []),
        el("div", { class: "actions" }, [
          el("button", { class: "btn lg", text: "End my day", onclick: endDay }, []),
          el("button", { class: "btn ghost lg", text: "Keep working", onclick: function () {
            T.wrapSnoozeUntil = now() + 60 * 60 * 1000; closeModal();
          } }, []),
        ]),
      ]),
    ]));
  }
  function closeModal() { if (T) T.modalOpen = false; clear($("modal-root")); }

  /* ---- clock / rollover ticker ---- */
  function tickClock() {
    if (!T || !T.running) return;
    var elapsed = now() - T.running.started_at;
    $("run-clock").textContent = fmtClock(elapsed);
  }
  function startTicker() {
    stopTicker();
    ticker = setInterval(function () {
      if (!T) return;
      if (todayStr() !== T.day) { loadDay(); return; }   // midnight rollover
      if (T.running) { tickClock(); maybeCheckin(); }
      maybeWrapUp();                                      // after-5pm wrap-up, even when idle
    }, 1000);
  }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  /* ---- notifications + background push ---- */
  function maybeShowNotifyBanner() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") { setupPush(); return; }
    if (localStorage.getItem("lt_notify_dismiss")) return;
    show("notify-banner");
  }
  async function enableNotify() {
    hide("notify-banner");
    try { await Notification.requestPermission(); } catch (_) {}
    if (Notification.permission === "granted") { toast("Reminders on ✓"); setupPush(); }
  }
  function notify(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var opts = { body: body, icon: "/time/assets/icon.png", badge: "/time/assets/icon.png", tag: "linear-time-checkin", renotify: true };
    if (swReg && swReg.showNotification) {
      swReg.showNotification(title, opts).catch(function () { plainNote(title, opts); });
    } else { plainNote(title, opts); }
  }
  function plainNote(title, opts) { try { new Notification(title, opts); } catch (_) {} }

  // Subscribe this device to Web Push so the server can nudge it even when the
  // app window is closed. Safe to call repeatedly (it reuses an existing sub).
  async function setupPush() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (Notification.permission !== "granted") return;
      var reg = swReg || (await navigator.serviceWorker.getRegistration("/time/"));
      if (!reg) return;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        var kr = await api("/api/push/key", { auth: false });
        if (!kr.key) return; // push not configured on the server yet
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(kr.key) });
      }
      await api("/api/push/subscribe", { method: "POST", body: { sub: sub.toJSON(), tz_offset: new Date().getTimezoneOffset() } });
      await refreshSWAuth();
    } catch (_) { /* push is best-effort; in-app reminders still work */ }
  }
  // Hand the service worker a token + API base it can use to fetch /api/push/pending.
  async function refreshSWAuth() {
    try {
      if (!("caches" in window)) return;
      var c = await caches.open("lt-auth");
      await c.put("/time/__auth", new Response(JSON.stringify({ base: API_BASE, token: getToken() }),
        { headers: { "content-type": "application/json" } }));
    } catch (_) {}
  }
  function urlB64ToBytes(base64) {
    var pad = "=".repeat((4 - (base64.length % 4)) % 4);
    var b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(b64), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /* ============================================================
   * ADMIN / REPORTS
   * ============================================================ */
  async function startAdmin() {
    showView("admin");
    A = { role: null, companies: [], tab: "reports", workers: [], selCompany: "", selDate: todayStr(), selWorker: "" };
    try {
      var s = await api("/api/admin/scope");
      A.role = s.role; A.companies = s.companies || [];
      var p = getProfile() || {};
      $("who-admin").innerHTML = "<b>" + esc(p.email) + "</b><br>" + (A.role === "super" ? "Super admin" : esc((A.companies[0] || {}).name || "Company admin"));
      if (A.role !== "super" && A.companies[0]) A.selCompany = A.companies[0].id;
      renderAdminTabs();
      selectTab("reports");
    } catch (e) { toast(e.error || "Couldn't load."); }
  }

  function renderAdminTabs() {
    var host = $("admin-tabs"); clear(host);
    var tabs = A.role === "super"
      ? [["reports", "Reports"], ["workers", "People"], ["companies", "Companies"], ["admins", "Admins"]]
      : [["reports", "Reports"], ["workers", "People"]];
    tabs.forEach(function (t) {
      host.appendChild(el("button", { class: "tab" + (A.tab === t[0] ? " active" : ""), text: t[1], onclick: function () { selectTab(t[0]); } }, []));
    });
  }
  function selectTab(name) {
    A.tab = name; renderAdminTabs();
    if (name === "reports") renderReports();
    else if (name === "workers") renderWorkersTab();
    else if (name === "companies") renderCompaniesTab();
    else if (name === "admins") renderAdminsTab();
  }

  function companyOptions(includeAll) {
    var opts = [];
    if (includeAll && A.role === "super") opts.push(el("option", { value: "", text: "All companies" }, []));
    A.companies.forEach(function (c) { opts.push(el("option", { value: c.id, text: c.name }, [])); });
    return opts;
  }

  /* ---- Reports tab ---- */
  function renderReports() {
    var body = $("admin-body"); clear(body);
    var companySel = el("select", { onchange: function () { A.selCompany = this.value; A.selWorker = ""; loadWorkersInto(); } }, companyOptions(true));
    companySel.value = A.selCompany;
    if (A.role !== "super") companySel.disabled = true;
    var dateInput = el("input", { type: "date", value: A.selDate, onchange: function () { A.selDate = this.value; } }, []);
    var workerSel = el("select", { id: "rep-worker", onchange: function () { A.selWorker = this.value; } }, [el("option", { value: "", text: "Everyone" }, [])]);

    var controls = el("div", { class: "panel" }, [
      el("div", { class: "row" }, [
        el("label", { class: "field grow0", style: "min-width:180px" }, [el("span", { class: "lbl", text: "Company" }, []), companySel]),
        el("label", { class: "field grow0", style: "min-width:160px" }, [el("span", { class: "lbl", text: "Date" }, []), dateInput]),
        el("label", { class: "field grow0", style: "min-width:180px" }, [el("span", { class: "lbl", text: "Person" }, []), workerSel]),
        el("div", { class: "grow0" }, [el("button", { class: "btn", text: "Load", onclick: loadReport }, [])]),
        el("div", { class: "grow0" }, [el("button", { class: "btn ghost", text: "Export CSV", onclick: exportCsv }, [])]),
      ]),
    ]);
    body.appendChild(controls);
    body.appendChild(el("div", { class: "panel", id: "report-out" }, [el("div", { class: "empty", text: "Choose a day and press Load." }, [])]));
    loadWorkersInto();
    loadReport();
  }

  async function loadWorkersInto() {
    try {
      var q = A.selCompany ? "?company_id=" + encodeURIComponent(A.selCompany) : "";
      var w = await api("/api/admin/workers" + q);
      A.workers = w.workers || [];
      var sel = $("rep-worker");
      if (sel) {
        var cur = sel.value; clear(sel);
        sel.appendChild(el("option", { value: "", text: "Everyone" }, []));
        A.workers.forEach(function (p) { sel.appendChild(el("option", { value: p.email, text: p.name + " · " + p.email }, [])); });
        sel.value = cur;
      }
    } catch (_) {}
  }

  var lastReport = null;
  async function loadReport() {
    var out = $("report-out"); if (out) clear(out), out.appendChild(el("div", { class: "empty", text: "Loading…" }, []));
    try {
      var q = "?day=" + encodeURIComponent(A.selDate);
      if (A.selCompany) q += "&company_id=" + encodeURIComponent(A.selCompany);
      if (A.selWorker) q += "&email=" + encodeURIComponent(A.selWorker);
      var rep = await api("/api/admin/report" + q);
      lastReport = rep;
      renderReportTables(rep);
    } catch (e) { if (out) clear(out), out.appendChild(el("div", { class: "empty", text: e.error || "Couldn't load." }, [])); }
  }

  function renderReportTables(rep) {
    var out = $("report-out"); clear(out);
    var rows = rep.rows || [];
    out.appendChild(el("h2", { text: "Report · " + fmtLongDate(new Date(rep.day + "T12:00:00")) }, []));
    if (!rows.length) { out.appendChild(el("div", { class: "empty", text: "No time logged for this day." }, [])); return; }
    // group by worker email
    var groups = {}, order = [];
    rows.forEach(function (r) { if (!groups[r.email]) { groups[r.email] = []; order.push(r.email); } groups[r.email].push(r); });
    var grand = 0;
    order.forEach(function (email) {
      var list = groups[email].sort(function (a, b) { return a.started_at - b.started_at; });
      var wtot = 0;
      var tb = el("tbody", {}, []);
      list.forEach(function (r) {
        var end = r.ended_at || rep.serverNow || Date.now();
        var dur = end - r.started_at; wtot += dur;
        tb.appendChild(el("tr", {}, [
          el("td", {}, [document.createTextNode(r.task + " "), r.preset ? el("span", { class: "badge", text: r.preset }, []) : null]),
          el("td", { class: "mono", text: fmtTime(r.started_at) }, []),
          el("td", {}, [r.ended_at == null ? el("span", { class: "badge live", text: "running" }, []) : document.createTextNode(fmtTime(r.ended_at))]),
          el("td", { class: "num mono", text: fmtDur(dur) }, []),
        ]));
      });
      tb.appendChild(el("tr", { class: "total-row" }, [el("td", { colspan: "3", text: "Subtotal" }, []), el("td", { class: "num mono", text: fmtDur(wtot) }, [])]));
      grand += wtot;
      var head = el("div", { class: "worker-head" }, [
        el("h3", { text: list[0].worker || email }, []),
        el("span", { class: "em", text: email + (A.role === "super" && list[0].company ? " · " + list[0].company : "") }, []),
        el("span", { class: "tot", text: fmtDur(wtot) }, []),
      ]);
      out.appendChild(head);
      out.appendChild(el("div", { class: "tablewrap" }, [
        el("table", {}, [el("thead", {}, [el("tr", {}, [th("Task"), th("From"), th("To"), thNum("Duration")])]), tb]),
      ]));
    });
    if (order.length > 1) {
      out.appendChild(el("div", { class: "worker-head", style: "border-top:1px solid var(--border);padding-top:14px;margin-top:26px" }, [
        el("h3", { text: "All people" }, []), el("span", { class: "tot", text: fmtDur(grand) }, []),
      ]));
    }
  }

  function exportCsv() {
    if (!lastReport || !(lastReport.rows || []).length) { toast("Load a report first."); return; }
    var lines = [["Worker", "Email", "Company", "Date", "Task", "Type", "Start", "End", "Duration", "Minutes"]];
    lastReport.rows.slice().sort(function (a, b) { return (a.email + a.started_at).localeCompare(b.email + b.started_at); }).forEach(function (r) {
      var end = r.ended_at || lastReport.serverNow || Date.now();
      var mins = Math.round((end - r.started_at) / 60000);
      lines.push([
        r.worker || r.email, r.email, r.company || "", lastReport.day, r.task, r.preset || "task",
        fmtTime(r.started_at), r.ended_at == null ? "in progress" : fmtTime(r.ended_at), fmtDur(end - r.started_at), String(mins),
      ]);
    });
    var csv = lines.map(function (row) { return row.map(csvCell).join(","); }).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = el("a", { href: url, download: "linear-time-" + lastReport.day + ".csv" }, []);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function csvCell(v) { v = String(v == null ? "" : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  /* ---- People tab ---- */
  async function renderWorkersTab() {
    var body = $("admin-body"); clear(body);
    var panel = el("div", { class: "panel" }, [el("h2", { text: "People" }, []), el("div", { class: "empty", text: "Loading…" }, [])]);
    body.appendChild(panel);
    try {
      var q = A.selCompany ? "?company_id=" + encodeURIComponent(A.selCompany) : "";
      var w = await api("/api/admin/workers" + q);
      var list = w.workers || [];
      clear(panel); panel.appendChild(el("h2", { text: "People (" + list.length + ")" }, []));
      if (!list.length) { panel.appendChild(el("div", { class: "empty", text: "No one has signed in yet. Share the company code from the Companies tab." }, [])); return; }
      var tb = el("tbody", {}, []);
      list.forEach(function (p) {
        tb.appendChild(el("tr", {}, [
          el("td", { text: p.name }, []), el("td", { class: "em", text: p.email }, []),
          A.role === "super" ? el("td", { text: p.company || "" }, []) : null,
          el("td", { text: p.last_seen_at ? new Date(p.last_seen_at).toLocaleString() : "—" }, []),
          el("td", { class: "num" }, [el("button", { class: "btn ghost sm", text: "Rename", onclick: function () { renameWorker(p); } }, [])]),
        ].filter(Boolean)));
      });
      var head = [th("Name"), th("Email")]; if (A.role === "super") head.push(th("Company")); head.push(th("Last seen"), thNum(""));
      panel.appendChild(el("div", { class: "tablewrap" }, [el("table", {}, [el("thead", {}, [el("tr", {}, head)]), tb])]));
    } catch (e) { clear(panel); panel.appendChild(el("div", { class: "empty", text: e.error || "Couldn't load." }, [])); }
  }

  async function renameWorker(p) {
    var nn = prompt("New name for " + p.email + ":", p.name || "");
    if (nn == null) return;               // cancelled
    nn = nn.trim();
    if (!nn) { toast("Name can't be empty."); return; }
    if (nn === p.name) return;            // unchanged
    try {
      await api("/api/admin/worker/rename", { method: "POST", body: { email: p.email, name: nn } });
      toast("Renamed to " + nn);
      renderWorkersTab();
    } catch (e) { toast(e.error || "Couldn't rename."); }
  }

  /* ---- Companies tab (super only) ---- */
  async function renderCompaniesTab() {
    var body = $("admin-body"); clear(body);
    var addName = el("input", { type: "text", placeholder: "New company name" }, []);
    body.appendChild(el("div", { class: "panel" }, [
      el("h2", { text: "Add a company" }, []),
      el("div", { class: "row" }, [
        el("div", {}, [addName]),
        el("div", { class: "grow0" }, [el("button", { class: "btn", text: "Create + get code", onclick: async function () {
          var name = addName.value.trim(); if (!name) { toast("Enter a name."); return; }
          try { var r = await api("/api/admin/companies", { method: "POST", body: { name: name } });
            toast("Created. Code: " + r.company.code); await refreshCompanies(); renderCompaniesTab();
          } catch (e) { toast(e.error || "Couldn't create."); }
        } }, [])]),
      ]),
      el("p", { class: "hint", text: "Share a company's code with its workers — they enter it once, the first time they sign in." }, []),
    ]));
    var listPanel = el("div", { class: "panel" }, [el("h2", { text: "Companies" }, []), el("div", { class: "empty", text: "Loading…" }, [])]);
    body.appendChild(listPanel);
    try {
      var c = await api("/api/admin/companies");
      A.companies = c.companies || [];
      clear(listPanel); listPanel.appendChild(el("h2", { text: "Companies (" + A.companies.length + ")" }, []));
      if (!A.companies.length) { listPanel.appendChild(el("div", { class: "empty", text: "No companies yet — add your first one above." }, [])); return; }
      var tb = el("tbody", {}, []);
      A.companies.forEach(function (co) {
        var pill = el("span", { class: "codepill" }, [document.createTextNode(co.code), el("button", { class: "iconbtn", title: "Copy", style: "width:24px;height:24px", text: "⧉", onclick: function () { copy(co.code); } }, [])]);
        tb.appendChild(el("tr", {}, [
          el("td", { text: co.name }, []),
          el("td", {}, [pill]),
          el("td", { class: "num", text: String(co.workers != null ? co.workers : "") }, []),
          el("td", { class: "num" }, [el("button", { class: "btn ghost sm", text: "New code", onclick: async function () {
            if (!confirm("Regenerate the code for " + co.name + "? The old code stops working for new sign-ups.")) return;
            try { var r = await api("/api/admin/company/code", { method: "POST", body: { company_id: co.id } }); toast("New code: " + r.code); await refreshCompanies(); renderCompaniesTab(); }
            catch (e) { toast(e.error || "Couldn't regenerate."); }
          } }, [])]),
        ]));
      });
      listPanel.appendChild(el("div", { class: "tablewrap" }, [el("table", {}, [el("thead", {}, [el("tr", {}, [th("Company"), th("Join code"), thNum("People"), thNum("")])]), tb])]));
    } catch (e) { clear(listPanel); listPanel.appendChild(el("div", { class: "empty", text: e.error || "Couldn't load." }, [])); }
  }
  async function refreshCompanies() { try { var c = await api("/api/admin/companies"); A.companies = c.companies || []; } catch (_) {} }

  /* ---- Admins tab (super only) ---- */
  async function renderAdminsTab() {
    var body = $("admin-body"); clear(body);
    await refreshCompanies();
    var emailIn = el("input", { type: "email", placeholder: "manager@company.com" }, []);
    var compSel = el("select", {}, companyOptions(false));
    body.appendChild(el("div", { class: "panel" }, [
      el("h2", { text: "Appoint a company admin" }, []),
      el("div", { class: "row" }, [
        el("label", { class: "field", style: "margin:0" }, [el("span", { class: "lbl", text: "Their email" }, []), emailIn]),
        el("label", { class: "field grow0", style: "margin:0;min-width:200px" }, [el("span", { class: "lbl", text: "Company they'll see" }, []), compSel]),
        el("div", { class: "grow0", style: "align-self:flex-end" }, [el("button", { class: "btn", text: "Add admin", onclick: async function () {
          var email = emailIn.value.trim().toLowerCase(); var cid = compSel.value;
          if (!email || !cid) { toast("Email and company required."); return; }
          try { await api("/api/admin/company-admins", { method: "POST", body: { email: email, company_id: cid } }); toast("Admin added."); renderAdminsTab(); }
          catch (e) { toast(e.error || "Couldn't add."); }
        } }, [])]),
      ]),
      el("p", { class: "hint", text: "A company admin signs in with their email and sees only that company's reports." }, []),
    ]));
    var listPanel = el("div", { class: "panel" }, [el("h2", { text: "Company admins" }, []), el("div", { class: "empty", text: "Loading…" }, [])]);
    body.appendChild(listPanel);
    try {
      var r = await api("/api/admin/company-admins");
      var admins = r.admins || [];
      clear(listPanel); listPanel.appendChild(el("h2", { text: "Company admins (" + admins.length + ")" }, []));
      if (!admins.length) { listPanel.appendChild(el("div", { class: "empty", text: "No company admins yet." }, [])); return; }
      var tb = el("tbody", {}, []);
      admins.forEach(function (ad) {
        tb.appendChild(el("tr", {}, [
          el("td", { text: ad.email }, []),
          el("td", { text: ad.company_name || "" }, []),
          el("td", { class: "num" }, [el("button", { class: "btn ghost sm", text: "Remove", onclick: async function () {
            if (!confirm("Remove " + ad.email + " as admin?")) return;
            try { await api("/api/admin/company-admins", { method: "DELETE", body: { email: ad.email } }); toast("Removed."); renderAdminsTab(); }
            catch (e) { toast(e.error || "Couldn't remove."); }
          } }, [])]),
        ]));
      });
      listPanel.appendChild(el("div", { class: "tablewrap" }, [el("table", {}, [el("thead", {}, [el("tr", {}, [th("Email"), th("Company"), thNum("")])]), tb])]));
    } catch (e) { clear(listPanel); listPanel.appendChild(el("div", { class: "empty", text: e.error || "Couldn't load." }, [])); }
  }

  /* ============================================================
   * Misc helpers
   * ============================================================ */
  function th(t) { return el("th", { text: t }, []); }
  function thNum(t) { return el("th", { class: "num", text: t }, []); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast("Copied " + text); }, function () { toast(text); });
    else toast(text);
  }

  /* ============================================================
   * Wire up + boot
   * ============================================================ */
  function bind() {
    $("btn-sendcode").addEventListener("click", sendCode);
    $("in-email").addEventListener("keydown", function (e) { if (e.key === "Enter") sendCode(); });
    $("btn-verify").addEventListener("click", verifyCode);
    $("in-code").addEventListener("keydown", function (e) { if (e.key === "Enter") verifyCode(); });
    $("btn-back").addEventListener("click", routeToAuth);
    $("btn-start-custom").addEventListener("click", function () { startTask($("in-task").value, null); });
    $("in-task").addEventListener("keydown", function (e) { if (e.key === "Enter") startTask($("in-task").value, null); });
    $("btn-end").addEventListener("click", endTask);
    $("btn-switch").addEventListener("click", function () { T.picking = true; renderTracker(); });
    $("btn-endday").addEventListener("click", endDay);
    $("btn-signout-1").addEventListener("click", signout);
    $("btn-signout-2").addEventListener("click", signout);
    $("btn-enable-notify").addEventListener("click", enableNotify);
    $("btn-dismiss-notify").addEventListener("click", function () { hide("notify-banner"); localStorage.setItem("lt_notify_dismiss", "1"); });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden || !T) return;
      if (todayStr() !== T.day) { loadDay(); return; }
      tickClock(); maybeCheckin(); maybeWrapUp();
    });
  }
  function signout() { clearSession(); routeToAuth(); }

  async function boot() {
    bind();
    // Ask the browser to keep our saved sign-in even under storage pressure, so the
    // session survives restarts (installed PWAs are usually granted this silently).
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
    // Register the service worker (offline shell + reminder notifications).
    // On time.linearit.co the Worker sends Service-Worker-Allowed:/ so we can take
    // the whole origin as scope — that makes the site installable from the root
    // URL (not just /time/). Elsewhere (GitHub Pages) fall back to /time/.
    if ("serviceWorker" in navigator) {
      var swScope = location.hostname === "time.linearit.co" ? "/" : "/time/";
      try { swReg = await navigator.serviceWorker.register("/time/sw.js", { scope: swScope }); }
      catch (_) { try { swReg = await navigator.serviceWorker.register("/time/sw.js", { scope: "/time/" }); } catch (_2) {} }
      try { navigator.serviceWorker.getRegistration(swScope).then(function (r) { if (r) swReg = r; }); } catch (_) {}
    }
    if (getToken() && getProfile()) routeAfterLogin();
    else routeToAuth();
    setTimeout(function () { var e = $("in-email"); if (e && !getToken()) e.focus(); }, 60);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
