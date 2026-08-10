/* =============================================================================
 * Linear Sign — front-end (sign.linearit.co)
 * A single-page app with three flows:
 *   1. Sender sign-in (email + emailed code)
 *   2. Dashboard + document editor (upload PDF, place fields, send, track)
 *   3. Signer view (opened from a per-recipient link: ?d=<docId>&t=<token>)
 * The API lives on sign.linearit.co; the same HTML is served both there
 * (same-origin) and from the GitHub Pages site (cross-origin), so we point the
 * API at sign.linearit.co unless we're already on it.
 * ========================================================================== */
(function () {
  "use strict";

  var API = (location.hostname === "sign.linearit.co") ? "" : "https://sign.linearit.co";
  var app = document.getElementById("app");
  var modalRoot = document.getElementById("modal-root");

  var state = {
    token: localStorage.getItem("lsign_token") || "",
    email: localStorage.getItem("lsign_email") || "",
    tab: "all",
  };

  /* ---- field type metadata (sizes are fractions of the page) ------------- */
  var FIELD_META = {
    signature: { label: "Signature", icon: "✍️", w: 0.24, h: 0.070, sign: true },
    initials:  { label: "Initials",  icon: "🔤", w: 0.11, h: 0.055, sign: true },
    date:      { label: "Date",      icon: "📅", w: 0.16, h: 0.038, auto: true },
    text:      { label: "Text",      icon: "📝", w: 0.20, h: 0.038 },
    name:      { label: "Name",      icon: "👤", w: 0.20, h: 0.038, auto: true },
    email:     { label: "Email",     icon: "✉️", w: 0.22, h: 0.038, auto: true },
    checkbox:  { label: "Checkbox",  icon: "☑️", w: 0.030, h: 0.030 },
  };

  /* =========================================================================
   * Tiny helpers
   * ======================================================================= */
  function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function qs(k) { return new URLSearchParams(location.search).get(k); }
  function toast(msg, isErr) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(t._t); t._t = setTimeout(function () { t.className = "toast"; }, 3200);
  }
  function fmtWhen(ms) {
    if (!ms) return "";
    var d = new Date(ms), now = Date.now(), diff = now - ms;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }
  function todayStr() { return new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); }

  async function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    var body = opts.body;
    if (body && !(body instanceof FormData)) { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
    if (opts.auth !== false && state.token) headers["Authorization"] = "Bearer " + state.token;
    var res = await fetch(API + path, { method: opts.method || "GET", headers: headers, body: body });
    if (opts.raw) return res;
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (data && data.token) { state.token = data.token; localStorage.setItem("lsign_token", data.token); }
    if (!res.ok) {
      if (res.status === 401 && opts.auth !== false) { logout(true); }
      throw new Error((data && data.error) || ("Something went wrong (" + res.status + ")"));
    }
    return data;
  }

  async function fetchPdf(path, withAuth) {
    var headers = {};
    if (withAuth && state.token) headers["Authorization"] = "Bearer " + state.token;
    var res = await fetch(API + path, { headers: headers });
    if (!res.ok) throw new Error("Couldn't load the PDF.");
    return await res.arrayBuffer();
  }

  function modal(node) {
    var back = el('<div class="backdrop"></div>');
    back.appendChild(node);
    back.addEventListener("mousedown", function (e) { if (e.target === back) close(); });
    modalRoot.appendChild(back);
    function close() { if (back.parentNode) back.parentNode.removeChild(back); }
    return close;
  }

  function logout(silent) {
    state.token = ""; state.email = "";
    localStorage.removeItem("lsign_token"); localStorage.removeItem("lsign_email");
    if (!silent) location.href = location.pathname;
    else renderLogin();
  }

  /* ---- Brand chrome (logo + light/dark theme, matching vault + time) ----- */
  function brandLogo(big) {
    return '<div class="logo' + (big ? " big" : "") + '"><span class="brandlogo"></span><span class="brandtag">Sign</span></div>';
  }
  function themeBtn() {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    return '<button class="iconbtn" data-act="theme" title="Toggle light / dark">' + (light ? "☀️" : "🌙") + '</button>';
  }
  function applyTheme() {
    var t = localStorage.getItem("lsign_theme") || "dark";
    document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "dark");
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    var nt = cur === "dark" ? "light" : "dark";
    localStorage.setItem("lsign_theme", nt);
    document.documentElement.setAttribute("data-theme", nt);
    document.querySelectorAll('[data-act="theme"]').forEach(function (b) { b.textContent = nt === "light" ? "☀️" : "🌙"; });
  }

  /* =========================================================================
   * Router
   * ======================================================================= */
  var themeReady = false;
  function boot() {
    if (!themeReady) {
      themeReady = true;
      applyTheme();
      document.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest('[data-act="theme"]')) toggleTheme();
      });
    }
    if (!window.pdfjsLib) {
      // Retry briefly in case the CDN script is still loading.
      return setTimeout(boot, 120);
    }
    var d = qs("d"), t = qs("t");
    if (d && t) return renderSigner(d, t);
    if (state.token) return renderDashboard();
    return renderLogin();
  }

  /* =========================================================================
   * Sender sign-in
   * ======================================================================= */
  function topBar(rightHtml) {
    return '<header class="top">' + brandLogo() +
      '<div class="spacer"></div>' + themeBtn() + (rightHtml || "") + '</header>';
  }

  function renderLogin() {
    app.innerHTML = topBar("") +
      '<div class="center-screen"><div class="card login-card">' +
      brandLogo(true) +
      '<h1 style="text-align:center">Sign in</h1><p class="sub" style="text-align:center">Enter your work email to receive a sign-in code.</p>' +
      '<div id="login-body"></div></div></div>';
    var body = document.getElementById("login-body");
    var email = state.email || "";
    stepEmail();

    function stepEmail() {
      body.innerHTML =
        '<label class="flbl">Email address</label>' +
        '<input id="li-email" type="email" placeholder="you@company.com" autocomplete="email" value="' + esc(email) + '" />' +
        '<div id="li-msg"></div>' +
        '<button class="btn primary" id="li-send" style="width:100%;justify-content:center;margin-top:14px">Send code</button>';
      var input = document.getElementById("li-email"); input.focus();
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
      document.getElementById("li-send").addEventListener("click", send);
      async function send() {
        email = input.value.trim().toLowerCase();
        var btn = document.getElementById("li-send"); var msg = document.getElementById("li-msg");
        msg.innerHTML = "";
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.innerHTML = '<div class="err">Enter a valid email address.</div>'; return; }
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Sending…';
        try {
          var r = await api("/api/auth/code", { method: "POST", auth: false, body: { email: email } });
          stepCode(r.dev_code);
        } catch (e) { msg.innerHTML = '<div class="err">' + esc(e.message) + "</div>"; btn.disabled = false; btn.textContent = "Send code"; }
      }
    }

    function stepCode(devCode) {
      body.innerHTML =
        '<p class="sub">We sent a 6-digit code to <b>' + esc(email) + '</b>.</p>' +
        '<input id="li-code" class="code-input" inputmode="numeric" maxlength="6" placeholder="000000" />' +
        (devCode ? '<div class="ok">Dev code: <b>' + esc(devCode) + '</b></div>' : "") +
        '<div id="li-msg"></div>' +
        '<button class="btn primary" id="li-verify" style="width:100%;justify-content:center;margin-top:14px">Verify &amp; sign in</button>' +
        '<button class="btn ghost sm" id="li-back" style="width:100%;justify-content:center;margin-top:8px">Use a different email</button>';
      var input = document.getElementById("li-code"); input.focus();
      if (devCode) input.value = devCode;
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") verify(); });
      document.getElementById("li-verify").addEventListener("click", verify);
      document.getElementById("li-back").addEventListener("click", stepEmail);
      async function verify() {
        var btn = document.getElementById("li-verify"); var msg = document.getElementById("li-msg");
        var code = input.value.replace(/\D/g, ""); msg.innerHTML = "";
        if (code.length < 4) { msg.innerHTML = '<div class="err">Enter the code from your email.</div>'; return; }
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Verifying…';
        try {
          var r = await api("/api/auth/login", { method: "POST", auth: false, body: { email: email, code: code } });
          state.token = r.token; state.email = r.email || email;
          state.role = r.role || "member"; state.isAdmin = !!r.is_admin;
          localStorage.setItem("lsign_token", state.token); localStorage.setItem("lsign_email", state.email);
          renderDashboard();
        } catch (e) { msg.innerHTML = '<div class="err">' + esc(e.message) + "</div>"; btn.disabled = false; btn.textContent = "Verify & sign in"; }
      }
    }
  }

  /* =========================================================================
   * Dashboard
   * ======================================================================= */
  async function renderDashboard() {
    app.innerHTML = topBar(
      '<div class="who">' + esc(state.email) +
      ' <button class="btn sm ghost" id="nav-logout">Sign out</button></div>'
    ) +
    '<div class="wrap">' +
      '<div class="dash-head">' +
        '<div><h1>Documents</h1><p class="sub" style="margin:0">Upload a PDF, place fields, and send it for signature.</p></div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<div class="tabs" id="dash-tabs">' +
            '<button class="tab active" data-tab="all">All</button>' +
            '<button class="tab" data-tab="draft">Drafts</button>' +
            '<button class="tab" data-tab="sent">Out for signature</button>' +
            '<button class="tab" data-tab="completed">Completed</button>' +
          '</div>' +
          '<button class="btn primary" id="new-doc">+ New document</button>' +
        '</div>' +
      '</div>' +
      '<div id="doc-list"><div class="loading"><span class="spin"></span>Loading…</div></div>' +
    '</div>';

    document.getElementById("nav-logout").addEventListener("click", function () { logout(); });
    document.getElementById("new-doc").addEventListener("click", openUpload);
    var tabs = document.getElementById("dash-tabs");
    tabs.addEventListener("click", function (e) {
      var b = e.target.closest(".tab"); if (!b) return;
      [].forEach.call(tabs.children, function (c) { c.classList.remove("active"); });
      b.classList.add("active"); state.tab = b.dataset.tab; paint();
    });

    var docs = [];
    try {
      var r = await api("/api/docs");
      docs = r.docs || [];
      state.role = r.role || "member";
      state.isAdmin = !!r.is_admin;
      if (r.me) { state.email = r.me; localStorage.setItem("lsign_email", r.me); }
      // Only the ADMIN_EMAILS administrators get a Team button; nobody else can
      // even see that an account list exists.
      if (state.isAdmin) {
        var who = document.querySelector("header.top .who");
        if (who && !document.getElementById("nav-team")) {
          var tb = el('<button class="btn sm ghost" id="nav-team">👥 Team</button>');
          who.insertBefore(tb, who.firstChild);
          tb.addEventListener("click", openTeam);
        }
      }
    }
    catch (e) { document.getElementById("doc-list").innerHTML = '<div class="err">' + esc(e.message) + "</div>"; return; }

    function paint() {
      var list = document.getElementById("doc-list");
      var filtered = docs.filter(function (d) {
        if (state.tab === "all") return true;
        if (state.tab === "sent") return d.status === "sent";
        return d.status === state.tab;
      });
      if (!filtered.length) {
        list.innerHTML = '<div class="empty"><div class="big">📄</div>' +
          (docs.length ? "No documents here yet." : "You haven’t created any documents yet.") +
          '<div style="margin-top:16px"><button class="btn primary" id="empty-new">+ New document</button></div></div>';
        var en = document.getElementById("empty-new"); if (en) en.addEventListener("click", openUpload);
        return;
      }
      list.innerHTML = '<div class="doclist"></div>';
      var dl = list.querySelector(".doclist");
      filtered.forEach(function (d) {
        var sub = [];
        if (d.recip_total) sub.push(d.recip_signed + "/" + d.recip_total + " signed");
        sub.push(d.page_count + (d.page_count === 1 ? " page" : " pages"));
        sub.push("Updated " + fmtWhen(d.updated_at));
        var row = el(
          '<div class="docrow">' +
            '<div class="ico">📄</div>' +
            '<div class="meta"><div class="ttl">' + esc(d.title) + '</div>' +
              '<div class="dsub">' + esc(sub.join(" · ")) + '</div></div>' +
            (d.status === "sent" ? '<div class="prog">' + progressBar(d) + '</div>' : "") +
            '<span class="pill ' + d.status + '">' + d.status + '</span>' +
          '</div>'
        );
        row.addEventListener("click", function () {
          if (d.status === "draft") openEditor(d.id);
          else openDocDetail(d.id);
        });
        dl.appendChild(row);
      });
    }
    paint();
  }

  function progressBar(d) {
    var pct = d.recip_total ? Math.round((d.recip_signed / d.recip_total) * 100) : 0;
    return '<div style="width:90px;height:6px;background:#2a2f4d;border-radius:4px;overflow:hidden">' +
      '<div style="height:100%;width:' + pct + '%;background:var(--brand)"></div></div>';
  }

  /* =========================================================================
   * Team management (owners only)
   * ======================================================================= */
  function openTeam() {
    var m = el(
      '<div class="modal" style="max-width:620px">' +
        '<div class="mhead"><h2 style="margin:0">👥 Team</h2><button class="x">×</button></div>' +
        '<div class="mbody">' +
          '<p class="sub" style="margin:0 0 14px">People who can sign in and send documents. ' +
          'There are no passwords — each person gets a 6-digit code by email when they sign in.</p>' +
          '<div id="team-list"><div class="loading" style="padding:30px"><span class="spin"></span></div></div>' +
          '<div class="sect-t">Add someone</div>' +
          '<div class="row" style="gap:8px">' +
            '<input id="tm-email" type="email" placeholder="name@company.com" style="flex:2" />' +
            '<input id="tm-name" type="text" placeholder="Name (optional)" style="flex:1.2" />' +
          '</div>' +
          '<div class="note">They can create and send their own documents. Only administrators ' +
          '(set in Cloudflare) can see or manage this list — staff can\'t see who else has an account.</div>' +
          '<div id="tm-msg"></div>' +
        '</div>' +
        '<div class="mfoot"><button class="btn ghost" id="tm-close">Close</button>' +
          '<button class="btn primary" id="tm-add">Add account</button></div>' +
      '</div>'
    );
    var close = modal(m);
    m.querySelector(".x").addEventListener("click", close);
    m.querySelector("#tm-close").addEventListener("click", close);
    var msg = m.querySelector("#tm-msg");

    load();
    async function load() {
      try {
        var r = await api("/api/users");
        paint(r.users || [], r.me);
      } catch (e) { m.querySelector("#team-list").innerHTML = '<div class="err">' + esc(e.message) + "</div>"; }
    }

    function paint(users, me) {
      var box = m.querySelector("#team-list");
      box.innerHTML = "";
      users.forEach(function (u) {
        var isMe = u.email === me;
        var tags = [];
        if (u.bootstrap) tags.push('<span class="pill completed" title="Set in the Cloudflare ADMIN_EMAILS secret">administrator</span>');
        if (u.disabled) tags.push('<span class="pill voided">disabled</span>');
        if (isMe) tags.push('<span class="pill sent">you</span>');
        var row = el(
          '<div class="recip-item">' +
            '<span class="dot" style="background:' + (u.role === "owner" ? "var(--brand)" : "var(--muted)") + '"></span>' +
            '<div class="rmeta"><b>' + esc(u.name || u.email) + '</b>' +
              '<span>' + esc(u.name ? u.email : "") + (u.last_login ? " · last in " + fmtWhen(u.last_login) : "") + '</span></div>' +
            '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' + tags.join("") +
              (u.bootstrap || isMe
                ? ''
                : '<button class="btn sm ghost" data-toggle="' + esc(u.email) + '">' + (u.disabled ? "Enable" : "Disable") + '</button>' +
                  '<button class="x" title="Remove" data-del="' + esc(u.email) + '">×</button>') +
            '</div>' +
          '</div>'
        );
        box.appendChild(row);
      });

      box.querySelectorAll("[data-toggle]").forEach(function (b) {
        b.addEventListener("click", function () {
          var u = users.filter(function (x) { return x.email === b.dataset.toggle; })[0];
          update({ email: b.dataset.toggle, disabled: !u.disabled }, u.disabled ? "Access restored." : "Access paused.");
        });
      });
      box.querySelectorAll("[data-del]").forEach(function (b) {
        b.addEventListener("click", function () {
          if (!confirm("Remove " + b.dataset.del + "? They will no longer be able to sign in. Their documents are kept.")) return;
          remove(b.dataset.del);
        });
      });
    }

    async function update(body, okMsg) {
      msg.innerHTML = "";
      try { await api("/api/users", { method: "PUT", body: body }); toast(okMsg); load(); }
      catch (e) { msg.innerHTML = '<div class="err">' + esc(e.message) + "</div>"; load(); }
    }
    async function remove(email) {
      msg.innerHTML = "";
      try { await api("/api/users", { method: "DELETE", body: { email: email } }); toast("Account removed."); load(); }
      catch (e) { msg.innerHTML = '<div class="err">' + esc(e.message) + "</div>"; }
    }

    m.querySelector("#tm-add").addEventListener("click", async function () {
      var btn = this;
      var email = m.querySelector("#tm-email").value.trim().toLowerCase();
      var name = m.querySelector("#tm-name").value.trim();
      msg.innerHTML = "";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.innerHTML = '<div class="err">Enter a valid email address.</div>'; return; }
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Adding…';
      try {
        await api("/api/users", { method: "POST", body: { email: email, name: name } });
        m.querySelector("#tm-email").value = ""; m.querySelector("#tm-name").value = "";
        toast("Account added — we emailed them an invite.");
        load();
      } catch (e) { msg.innerHTML = '<div class="err">' + esc(e.message) + "</div>"; }
      btn.disabled = false; btn.textContent = "Add account";
    });
  }

  /* ---- Upload new document ------------------------------------------------ */
  function openUpload() {
    var m = el(
      '<div class="modal"><div class="mhead"><h2 style="margin:0">New document</h2><button class="x">×</button></div>' +
      '<div class="mbody">' +
        '<label class="flbl">Document title</label>' +
        '<input id="up-title" type="text" placeholder="e.g. Service Agreement" />' +
        '<label class="flbl" style="margin-top:16px">PDF file</label>' +
        '<div id="up-drop" style="border:2px dashed var(--line2);border-radius:12px;padding:34px;text-align:center;cursor:pointer;color:var(--muted)">' +
          '<div style="font-size:34px">📄</div><div style="margin-top:8px">Click to choose a PDF, or drop it here</div>' +
          '<div id="up-fname" class="note"></div>' +
        '</div>' +
        '<input id="up-file" type="file" accept="application/pdf" class="hidden" />' +
        '<div id="up-msg"></div>' +
      '</div>' +
      '<div class="mfoot"><button class="btn ghost" id="up-cancel">Cancel</button>' +
        '<button class="btn primary" id="up-go" disabled>Upload &amp; continue</button></div></div>'
    );
    var close = modal(m);
    var file = null;
    var input = m.querySelector("#up-file");
    var drop = m.querySelector("#up-drop");
    var go = m.querySelector("#up-go");
    m.querySelector(".x").addEventListener("click", close);
    m.querySelector("#up-cancel").addEventListener("click", close);
    drop.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () { setFile(input.files[0]); });
    ["dragover", "dragenter"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.style.borderColor = "var(--brand)"; }); });
    ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.style.borderColor = "var(--line2)"; }); });
    drop.addEventListener("drop", function (e) { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

    function setFile(f) {
      if (!f) return;
      if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) { m.querySelector("#up-msg").innerHTML = '<div class="err">Please choose a PDF file.</div>'; return; }
      file = f; m.querySelector("#up-msg").innerHTML = "";
      m.querySelector("#up-fname").innerHTML = "Selected: <b>" + esc(f.name) + "</b> (" + (f.size / 1048576).toFixed(1) + " MB)";
      go.disabled = false;
      if (!m.querySelector("#up-title").value) m.querySelector("#up-title").value = f.name.replace(/\.pdf$/i, "");
    }

    go.addEventListener("click", async function () {
      if (!file) return;
      go.disabled = true; go.innerHTML = '<span class="spin"></span> Uploading…';
      try {
        var fd = new FormData();
        fd.append("file", file);
        fd.append("title", m.querySelector("#up-title").value.trim() || file.name);
        var r = await api("/api/docs", { method: "POST", body: fd });
        close(); openEditor(r.id);
      } catch (e) {
        m.querySelector("#up-msg").innerHTML = '<div class="err">' + esc(e.message) + "</div>";
        go.disabled = false; go.textContent = "Upload & continue";
      }
    });
  }

  /* =========================================================================
   * Editor — place fields on the PDF
   * ======================================================================= */
  async function openEditor(docId) {
    app.innerHTML = '<div class="loading"><span class="spin"></span>Opening editor…</div>';
    var doc, recipients, fields;
    try {
      var r = await api("/api/docs/" + docId);
      doc = r.doc; doc.message = r.message; doc.ordered = r.ordered;
      recipients = r.recipients; fields = r.fields;
    } catch (e) { app.innerHTML = '<div class="wrap"><div class="err">' + esc(e.message) + '</div><button class="btn" onclick="location.reload()">Back</button></div>'; return; }

    if (doc.status !== "draft") { return openDocDetail(docId); }

    var ed = {
      doc: doc,
      recipients: recipients.length ? recipients : [],
      fields: fields.slice(),
      active: recipients[0] ? recipients[0].id : null,
      tool: null,
      dirty: false,
    };
    ed.localSeq = 1;

    app.innerHTML =
      '<div class="editor">' +
        '<div class="etoolbar">' +
          '<button class="btn sm ghost" id="ed-back">← Documents</button>' +
          '<input class="etitle" id="ed-title" value="' + esc(doc.title) + '" />' +
          '<span class="pill draft">Draft</span>' +
          '<div class="zoombar">' +
            '<button id="z-fitp" title="Fit whole page">⤢ Fit</button>' +
            '<button id="z-out" title="Zoom out">−</button>' +
            '<span class="zpct" id="z-pct">100%</span>' +
            '<button id="z-in" title="Zoom in">+</button>' +
            '<button id="z-fitw" title="Fit width">↔</button>' +
          '</div>' +
          '<div class="spacer" style="flex:1"></div>' +
          '<span id="ed-saved" class="note" style="margin:0"></span>' +
          '<button class="btn sm" id="ed-save">Save draft</button>' +
          '<button class="btn primary sm" id="ed-send">Send →</button>' +
        '</div>' +
        '<div class="estage">' +
          '<div class="epages" id="ed-pages"><div class="loading"><span class="spin"></span>Rendering PDF…</div></div>' +
          '<div class="pagenav" id="ed-pagenav">' +
            '<button id="pn-prev" title="Previous page">‹</button>' +
            '<span class="pind" id="pn-ind">1 / 1</span>' +
            '<button id="pn-next" title="Next page">›</button>' +
          '</div>' +
          '<div class="eside">' +
            '<div class="sect-t">Recipients</div>' +
            '<div id="ed-recips"></div>' +
            '<button class="btn sm ghost" id="ed-addrecip" style="width:100%;justify-content:center;margin-top:4px">+ Add recipient</button>' +
            '<label style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px;color:var(--muted);cursor:pointer">' +
              '<input type="checkbox" id="ed-ordered" style="width:auto"' + (doc.ordered ? " checked" : "") + '> Sign in order</label>' +
            '<div class="sect-t">Fields</div>' +
            '<div class="note" style="margin:0 0 8px">Pick a recipient, choose a field, then click on the page to place it. Drag to move, corner to resize.</div>' +
            '<div class="palette" id="ed-palette"></div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById("ed-back").addEventListener("click", function () { location.href = location.pathname; });
    document.getElementById("ed-title").addEventListener("input", function () { ed.doc.title = this.value; markDirty(); });
    document.getElementById("ed-ordered").addEventListener("change", function () { ed.doc.ordered = this.checked; markDirty(); });
    document.getElementById("ed-addrecip").addEventListener("click", function () { addRecipient(); });
    document.getElementById("ed-save").addEventListener("click", function () { save(false); });
    document.getElementById("ed-send").addEventListener("click", function () { sendFlow(); });

    function markDirty() { ed.dirty = true; document.getElementById("ed-saved").textContent = "Unsaved changes"; }
    function markSaved() { ed.dirty = false; document.getElementById("ed-saved").textContent = "Saved"; setTimeout(function(){ var s=document.getElementById("ed-saved"); if(s&&!ed.dirty) s.textContent="";}, 2000); }

    function newLocalId() { return "L" + (ed.localSeq++) + "_" + Math.random().toString(36).slice(2, 7); }

    function addRecipient(email, name) {
      if (ed.recipients.length >= 25) return toast("That's a lot of recipients!", true);
      var colors = ["#00b0ec", "#4ade80", "#fbbf24", "#f87171", "#a78bfa", "#f472b6", "#22d3ee", "#34d399"];
      var rid = newLocalId();
      ed.recipients.push({ id: rid, email: email || "", name: name || "", color: colors[ed.recipients.length % colors.length], order_index: ed.recipients.length, role: "signer" });
      ed.active = rid; markDirty(); paintRecips(); paintPalette();
      if (!email) setTimeout(function () { var inp = document.querySelector('[data-remail="' + rid + '"]'); if (inp) inp.focus(); }, 30);
    }

    function paintRecips() {
      var box = document.getElementById("ed-recips");
      if (!ed.recipients.length) { box.innerHTML = '<div class="note" style="margin:0 0 8px">Add who needs to sign.</div>'; return; }
      box.innerHTML = "";
      ed.recipients.forEach(function (r, i) {
        var item = el(
          '<div class="recip-item" style="flex-direction:column;align-items:stretch;gap:6px">' +
            '<div style="display:flex;align-items:center;gap:8px">' +
              '<span class="dot" style="background:' + r.color + '"></span>' +
              '<b style="flex:1;font-size:12px">Signer ' + (i + 1) + '</b>' +
              '<button class="x" style="font-size:16px" data-del="' + r.id + '">×</button>' +
            '</div>' +
            '<input type="email" placeholder="email@company.com" value="' + esc(r.email) + '" data-remail="' + r.id + '" style="padding:7px 9px;font-size:13px" />' +
            '<input type="text" placeholder="Full name (optional)" value="' + esc(r.name) + '" data-rname="' + r.id + '" style="padding:7px 9px;font-size:13px" />' +
          '</div>'
        );
        item.querySelector('[data-remail="' + r.id + '"]').addEventListener("input", function () { r.email = this.value.trim(); markDirty(); });
        item.querySelector('[data-rname="' + r.id + '"]').addEventListener("input", function () { r.name = this.value; markDirty(); });
        item.querySelector('[data-del="' + r.id + '"]').addEventListener("click", function () {
          ed.recipients = ed.recipients.filter(function (x) { return x.id !== r.id; });
          ed.fields = ed.fields.filter(function (f) { return f.recipient_id !== r.id; });
          if (ed.active === r.id) ed.active = ed.recipients[0] ? ed.recipients[0].id : null;
          markDirty(); paintRecips(); paintPalette(); paintAllFields();
        });
        box.appendChild(item);
      });
    }

    function paintPalette() {
      var pal = document.getElementById("ed-palette");
      var picker = document.querySelector("#ed-recip-pick");
      // Recipient picker (which signer the new field belongs to)
      var pickHtml = '<div class="recip-pick" id="ed-recip-pick" style="grid-column:1/-1">';
      ed.recipients.forEach(function (r, i) {
        pickHtml += '<button class="chip' + (ed.active === r.id ? " active" : "") + '" data-pick="' + r.id + '" style="border-color:' + r.color + '">' +
          '<span class="dot" style="background:' + r.color + '"></span>Signer ' + (i + 1) + '</button>';
      });
      pickHtml += "</div>";
      var toolsHtml = "";
      Object.keys(FIELD_META).forEach(function (type) {
        var mta = FIELD_META[type];
        toolsHtml += '<div class="ptool' + (ed.tool === type ? " active" : "") + '" data-tool="' + type + '" draggable="false">' +
          '<span class="pi">' + mta.icon + '</span>' + mta.label + '</div>';
      });
      pal.innerHTML = pickHtml + toolsHtml;
      pal.querySelectorAll("[data-pick]").forEach(function (b) {
        b.addEventListener("click", function () { ed.active = b.dataset.pick; paintPalette(); });
      });
      pal.querySelectorAll("[data-tool]").forEach(function (b) {
        b.addEventListener("click", function () {
          if (!ed.active) return toast("Add a recipient first.", true);
          ed.tool = (ed.tool === b.dataset.tool) ? null : b.dataset.tool;
          paintPalette();
          document.getElementById("ed-pages").style.cursor = ed.tool ? "crosshair" : "";
        });
      });
    }

    // ---- render PDF pages ----
    var pageEls = [];      // 1-indexed DOM nodes
    var pageDims = [];     // 1-indexed {w,h} in PDF points
    var numPages = 0;
    var pagesBox = document.getElementById("ed-pages");
    try {
      var buf = await fetchPdf("/api/docs/" + docId + "/file", true);
      var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      numPages = pdf.numPages;
      pagesBox.innerHTML = "";
      var dpr = window.devicePixelRatio || 1;
      // Render the bitmap generously so zooming in stays crisp; display size is
      // controlled separately by applyWidth() (CSS), so we can zoom without re-render.
      var renderW = Math.min(1500, Math.max(1000, pagesBox.clientWidth));
      for (var pn = 1; pn <= numPages; pn++) {
        var page = await pdf.getPage(pn);
        var vp0 = page.getViewport({ scale: 1 });
        // Aspect (height / width) as actually rendered — the source of truth for layout.
        pageDims[pn] = { w: vp0.width, h: vp0.height, ratio: vp0.height / vp0.width };
        var scale = renderW / vp0.width;
        var vp = page.getViewport({ scale: scale * dpr });
        var pageEl = el('<div class="page" data-page="' + pn + '"><div class="flayer"></div></div>');
        pageEl.style.width = renderW + "px";
        var canvas = document.createElement("canvas");
        canvas.width = vp.width; canvas.height = vp.height;
        pageEl.insertBefore(canvas, pageEl.firstChild);
        pagesBox.appendChild(pageEl);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        attachPagePlacement(pageEl, pn);
        pageEls[pn] = pageEl;
      }
    } catch (e) {
      pagesBox.innerHTML = '<div class="err">' + esc(e.message) + "</div>";
    }

    setupZoomAndNav();
    paintRecips(); paintPalette(); paintAllFields();

    /* ---- Zoom + page navigation ------------------------------------------ */
    function fitWidthPx() { return Math.max(240, (pagesBox.clientWidth || 900) - 48); }
    // Widest the tallest page can be while still fitting the viewport height.
    function fitPagePx() {
      var maxRatio = 0;
      for (var i = 1; i <= numPages; i++) {
        var r = pageDims[i] && pageDims[i].ratio;
        if (r && r > maxRatio) maxRatio = r;
      }
      if (!maxRatio) maxRatio = 11 / 8.5;
      var availH = (pagesBox.clientHeight || 700) - 48;
      return Math.min(fitWidthPx(), availH / maxRatio);
    }
    // Only the width is set — each page's height follows its canvas aspect ratio,
    // so a page is never clipped even in mixed-size or rotated PDFs.
    function applyWidth(px) {
      px = Math.max(240, Math.min(2400, px));
      ed.dispW = px;
      for (var i = 1; i < pageEls.length; i++) {
        var pe = pageEls[i]; if (!pe) continue;
        pe.style.width = px + "px";
        pe.style.height = "auto";
      }
      var pctEl = document.getElementById("z-pct");
      if (pctEl) pctEl.textContent = Math.round((px / fitWidthPx()) * 100) + "%";
    }
    function setMode(mode) {
      ed.zoomMode = mode;
      if (mode === "fitw") applyWidth(fitWidthPx());
      else applyWidth(fitPagePx());
    }
    function setupZoomAndNav() {
      if (!numPages) return;
      document.getElementById("z-fitp").onclick = function () { setMode("fitp"); };
      document.getElementById("z-fitw").onclick = function () { setMode("fitw"); };
      document.getElementById("z-in").onclick = function () { ed.zoomMode = "manual"; applyWidth(ed.dispW * 1.2); };
      document.getElementById("z-out").onclick = function () { ed.zoomMode = "manual"; applyWidth(ed.dispW / 1.2); };

      var nav = document.getElementById("ed-pagenav");
      var ind = document.getElementById("pn-ind");
      ed.curPage = 1;
      if (numPages > 1) {
        nav.style.display = "flex";
        ind.textContent = "1 / " + numPages;
        var go = function (n) {
          n = Math.max(1, Math.min(numPages, n)); ed.curPage = n;
          if (pageEls[n]) pageEls[n].scrollIntoView({ behavior: "smooth", block: "start" });
          ind.textContent = n + " / " + numPages;
        };
        document.getElementById("pn-prev").onclick = function () { go(ed.curPage - 1); };
        document.getElementById("pn-next").onclick = function () { go(ed.curPage + 1); };
        pagesBox.addEventListener("scroll", function () {
          var boxTop = pagesBox.getBoundingClientRect().top, best = 1, bestd = 1e9;
          for (var i = 1; i < pageEls.length; i++) {
            if (!pageEls[i]) continue;
            var d = Math.abs(pageEls[i].getBoundingClientRect().top - boxTop - 10);
            if (d < bestd) { bestd = d; best = i; }
          }
          if (best !== ed.curPage) { ed.curPage = best; ind.textContent = best + " / " + numPages; }
        });
      }
      // Default: show the whole page so nothing runs off-screen.
      setMode("fitp");
      window.addEventListener("resize", function () {
        if (!document.body.contains(pagesBox)) return;
        if (ed.zoomMode === "fitw" || ed.zoomMode === "fitp") setMode(ed.zoomMode);
      });
    }

    function attachPagePlacement(pageEl, pageNum) {
      pageEl.querySelector(".flayer").addEventListener("mousedown", function (e) {
        if (!ed.tool) return;
        if (e.target.closest(".fld")) return;
        var rect = pageEl.getBoundingClientRect();
        var fx = (e.clientX - rect.left) / rect.width;
        var fy = (e.clientY - rect.top) / rect.height;
        var mta = FIELD_META[ed.tool];
        var f = {
          id: newLocalId(), recipient_id: ed.active, type: ed.tool, page: pageNum,
          x: Math.max(0, Math.min(1 - mta.w, fx - mta.w / 2)),
          y: Math.max(0, Math.min(1 - mta.h, fy - mta.h / 2)),
          w: mta.w, h: mta.h, required: true, font_size: 12,
        };
        ed.fields.push(f); markDirty(); renderField(f);
        // keep the tool selected for rapid placement
      });
    }

    function paintAllFields() {
      pageEls.forEach(function (pe) { if (pe) pe.querySelector(".flayer").innerHTML = ""; });
      ed.fields.forEach(renderField);
    }

    function renderField(f) {
      var pageEl = pageEls[f.page];
      if (!pageEl) return;
      var recip = ed.recipients.filter(function (r) { return r.id === f.recipient_id; })[0];
      var color = recip ? recip.color : "#00b0ec";
      var mta = FIELD_META[f.type];
      var node = el('<div class="fld"><span class="flabel">' + mta.icon + " " + mta.label + '</span>' +
        '<button class="fdel">×</button><span class="fres"></span></div>');
      node.style.borderColor = color; node.style.color = color;
      node.style.background = hexA(color, 0.14);
      place(node, f);
      pageEl.querySelector(".flayer").appendChild(node);

      node.querySelector(".fdel").addEventListener("mousedown", function (e) { e.stopPropagation(); });
      node.querySelector(".fdel").addEventListener("click", function (e) {
        e.stopPropagation();
        ed.fields = ed.fields.filter(function (x) { return x.id !== f.id; });
        node.remove(); markDirty();
      });

      // drag to move
      dragHandler(node, function (dx, dy, rect) {
        f.x = clamp(f.x + dx / rect.width, 0, 1 - f.w);
        f.y = clamp(f.y + dy / rect.height, 0, 1 - f.h);
        place(node, f);
      }, pageEl, node.querySelector(".fres"));

      // resize
      dragHandler(node.querySelector(".fres"), function (dx, dy, rect) {
        f.w = clamp(f.w + dx / rect.width, 0.03, 1 - f.x);
        f.h = clamp(f.h + dy / rect.height, 0.015, 1 - f.y);
        place(node, f);
      }, pageEl);
    }

    function place(node, f) {
      node.style.left = (f.x * 100) + "%";
      node.style.top = (f.y * 100) + "%";
      node.style.width = (f.w * 100) + "%";
      node.style.height = (f.h * 100) + "%";
    }

    function dragHandler(handle, onMove, pageEl, ignoreEl) {
      handle.addEventListener("mousedown", function (e) {
        if (ignoreEl && e.target === ignoreEl) return;
        if (e.target.classList && e.target.classList.contains("fdel")) return;
        e.preventDefault(); e.stopPropagation();
        var lastX = e.clientX, lastY = e.clientY;
        var rect = pageEl.getBoundingClientRect();
        function mv(ev) {
          onMove(ev.clientX - lastX, ev.clientY - lastY, rect);
          lastX = ev.clientX; lastY = ev.clientY;
        }
        function up() { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); markDirty(); }
        document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
      });
    }

    // ---- save + send ----
    function collect() {
      return {
        title: ed.doc.title.trim() || "Untitled document",
        message: ed.doc.message || "",
        ordered: !!ed.doc.ordered,
        recipients: ed.recipients.map(function (r, i) { return { id: r.id, email: r.email, name: r.name, order_index: i, role: r.role }; }),
        fields: ed.fields.map(function (f) { return { recipient_id: f.recipient_id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, font_size: f.font_size }; }),
      };
    }

    async function save(silent) {
      var payload = collect();
      var bad = payload.recipients.find(function (r) { return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email); });
      if (bad) { toast("Please give every recipient a valid email.", true); return false; }
      var btn = document.getElementById("ed-save"); if (!silent) { btn.disabled = true; btn.textContent = "Saving…"; }
      try {
        await api("/api/docs/" + docId, { method: "PUT", body: payload });
        markSaved(); if (!silent) toast("Draft saved.");
        return true;
      } catch (e) { toast(e.message, true); return false; }
      finally { if (!silent) { btn.disabled = false; btn.textContent = "Save draft"; } }
    }

    async function sendFlow() {
      if (!ed.recipients.length) return toast("Add at least one recipient.", true);
      var noEmail = ed.recipients.find(function (r) { return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email); });
      if (noEmail) return toast("Every recipient needs a valid email.", true);
      var signerNoField = ed.recipients.find(function (r) { return r.role === "signer" && !ed.fields.some(function (f) { return f.recipient_id === r.id; }); });
      if (signerNoField) return toast("Every signer needs at least one field.", true);
      openSendModal();
    }

    function openSendModal() {
      var m = el(
        '<div class="modal"><div class="mhead"><h2 style="margin:0">Send for signature</h2><button class="x">×</button></div>' +
        '<div class="mbody">' +
          '<p class="sub">Each recipient gets a private link to sign <b>' + esc(ed.doc.title) + '</b>.</p>' +
          '<label class="flbl">Message to recipients (optional)</label>' +
          '<textarea id="send-msg" rows="3" placeholder="Please review and sign at your earliest convenience.">' + esc(ed.doc.message || "") + '</textarea>' +
          '<div style="margin-top:14px">' + ed.recipients.map(function (r, i) {
            return '<div class="recip-item"><span class="dot" style="background:' + r.color + '"></span>' +
              '<div class="rmeta"><b>' + esc(r.name || r.email) + '</b><span>' + esc(r.email) +
              (ed.doc.ordered ? " · order " + (i + 1) : "") + " · " +
              ed.fields.filter(function (f) { return f.recipient_id === r.id; }).length + " field(s)</span></div></div>";
          }).join("") + '</div>' +
          '<div id="send-msg-box"></div>' +
        '</div>' +
        '<div class="mfoot"><button class="btn ghost" id="send-cancel">Cancel</button>' +
          '<button class="btn primary" id="send-go">Send now</button></div></div>'
      );
      var close = modal(m);
      m.querySelector(".x").addEventListener("click", close);
      m.querySelector("#send-cancel").addEventListener("click", close);
      m.querySelector("#send-go").addEventListener("click", async function () {
        ed.doc.message = m.querySelector("#send-msg").value;
        var go = m.querySelector("#send-go"); go.disabled = true; go.innerHTML = '<span class="spin"></span> Sending…';
        try {
          var ok = await save(true);
          if (!ok) throw new Error("Couldn't save the document.");
          await api("/api/docs/" + docId + "/send", { method: "POST" });
          close(); toast("Sent for signature ✓");
          location.href = location.pathname;
        } catch (e) {
          m.querySelector("#send-msg-box").innerHTML = '<div class="err">' + esc(e.message) + "</div>";
          go.disabled = false; go.textContent = "Send now";
        }
      });
    }
  }

  /* =========================================================================
   * Document detail (sent / completed) — status + audit + actions
   * ======================================================================= */
  async function openDocDetail(docId) {
    app.innerHTML = topBar('<div class="who">' + esc(state.email) + ' <button class="btn sm ghost" id="nav-logout">Sign out</button></div>') +
      '<div class="wrap"><div id="detail"><div class="loading"><span class="spin"></span>Loading…</div></div></div>';
    document.getElementById("nav-logout").addEventListener("click", function () { logout(); });
    var d;
    try { d = await api("/api/docs/" + docId); }
    catch (e) { document.getElementById("detail").innerHTML = '<div class="err">' + esc(e.message) + "</div>"; return; }
    var doc = d.doc, recips = d.recipients, events = d.events;

    var actions = "";
    if (doc.status === "sent") actions =
      '<button class="btn sm" id="d-remind">Send reminder</button>' +
      '<button class="btn sm danger" id="d-void">Void</button>';
    if (doc.status === "completed") actions =
      '<button class="btn primary sm" id="d-download">⬇ Download signed PDF</button>';
    if (doc.status === "voided" || doc.status === "declined") actions =
      '<button class="btn sm danger" id="d-delete">Delete</button>';

    document.getElementById("detail").innerHTML =
      '<button class="btn sm ghost" id="d-back" style="margin-bottom:16px">← Documents</button>' +
      '<div class="card">' +
        '<div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:200px"><h1 style="margin:0 0 6px">' + esc(doc.title) + '</h1>' +
            '<span class="pill ' + doc.status + '">' + doc.status + '</span> ' +
            '<span class="note" style="margin:0">' + doc.page_count + ' pages · ' +
            (doc.sent_at ? "sent " + fmtWhen(doc.sent_at) : "updated " + fmtWhen(doc.updated_at)) + '</span></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' + actions + '</div>' +
        '</div>' +
        '<div class="sect-t">Recipients</div>' +
        recips.map(function (r) {
          var when = r.status === "signed" ? "Signed " + fmtWhen(r.signed_at) : (r.status === "viewed" ? "Viewed " + fmtWhen(r.viewed_at) : (r.status === "declined" ? "Declined" : "Waiting"));
          var pillcls = r.status === "signed" ? "completed" : (r.status === "declined" ? "declined" : (r.status === "viewed" ? "sent" : "draft"));
          return '<div class="recip-item"><span class="dot" style="background:' + (r.color || "#00b0ec") + '"></span>' +
            '<div class="rmeta"><b>' + esc(r.name || r.email) + '</b><span>' + esc(r.email) + '</span></div>' +
            '<span class="pill ' + pillcls + '">' + esc(when) + '</span></div>';
        }).join("") +
        '<div class="sect-t">Activity</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px">' +
          events.map(function (e) {
            return '<div class="note" style="margin:0;display:flex;gap:10px"><span style="color:var(--faint);min-width:90px">' + fmtWhen(e.created_at) + '</span>' +
              '<span style="text-transform:capitalize;color:var(--text);font-weight:600">' + esc(e.type) + '</span>' +
              (e.detail ? '<span>' + esc(e.detail) + '</span>' : "") + '</div>';
          }).join("") +
        '</div>' +
      '</div>';

    document.getElementById("d-back").addEventListener("click", function () { location.href = location.pathname; });
    var dl = document.getElementById("d-download");
    if (dl) dl.addEventListener("click", function () { downloadWithAuth("/api/docs/" + docId + "/signed", doc.title + "-signed.pdf"); });
    var rem = document.getElementById("d-remind");
    if (rem) rem.addEventListener("click", async function () {
      rem.disabled = true; rem.textContent = "Sending…";
      try { var r = await api("/api/docs/" + docId + "/remind", { method: "POST" }); toast("Reminded " + r.reminded + " recipient(s)."); }
      catch (e) { toast(e.message, true); }
      rem.disabled = false; rem.textContent = "Send reminder";
    });
    var vd = document.getElementById("d-void");
    if (vd) vd.addEventListener("click", function () {
      if (!confirm("Void this document? Recipients will no longer be able to sign.")) return;
      api("/api/docs/" + docId + "/void", { method: "POST", body: { reason: "Voided by sender" } })
        .then(function () { toast("Document voided."); openDocDetail(docId); }).catch(function (e) { toast(e.message, true); });
    });
    var del = document.getElementById("d-delete");
    if (del) del.addEventListener("click", function () {
      if (!confirm("Delete this document permanently?")) return;
      api("/api/docs/" + docId, { method: "DELETE" }).then(function () { location.href = location.pathname; }).catch(function (e) { toast(e.message, true); });
    });
  }

  async function downloadWithAuth(path, filename) {
    toast("Preparing download…");
    try {
      var res = await fetch(API + path, { headers: { Authorization: "Bearer " + state.token } });
      if (!res.ok) throw new Error("Download failed.");
      var blob = await res.blob();
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    } catch (e) { toast(e.message, true); }
  }

  /* =========================================================================
   * Signer view (no login) — ?d=<docId>&t=<token>
   * ======================================================================= */
  async function renderSigner(docId, token) {
    app.innerHTML = '<div class="loading"><span class="spin"></span>Loading document…</div>';
    var info;
    try { info = await api("/api/sign/" + docId + "?token=" + encodeURIComponent(token), { auth: false }); }
    catch (e) { return signerError(e.message); }

    // mark viewed (fire and forget)
    api("/api/sign/" + docId + "/view", { method: "POST", auth: false, body: { token: token } }).catch(function () {});

    if (info.completed || info.recipient.status === "signed") return signerDone(docId, token, info, true);
    if (info.recipient.status === "declined") return signerError("You declined to sign this document.");
    if (!info.your_turn) return signerWaiting(info);

    var values = {}; // fieldId -> value (string) or dataURL for signatures
    var sigMemory = { signature: null, initials: null };

    app.innerHTML =
      '<div class="sign-top">' + brandLogo() +
        '<div class="spacer" style="flex:1"></div>' + themeBtn() +
        '<button class="btn ghost sm" id="sg-decline">Decline</button>' +
        '<button class="btn primary sm" id="sg-finish">Finish &amp; sign</button>' +
      '</div>' +
      '<div class="sbanner" id="sg-banner">📝 <b style="margin:0 6px">' + esc(info.doc.title) + '</b> — click each highlighted field to complete it.</div>' +
      (info.doc.message ? '<div style="max-width:860px;margin:14px auto 0;padding:0 20px"><div class="card" style="padding:14px 18px;color:var(--muted);font-size:14px">💬 ' + esc(info.doc.message) + '</div></div>' : "") +
      '<div class="epages" id="sg-pages" style="min-height:60vh"><div class="loading"><span class="spin"></span>Rendering…</div></div>';

    document.getElementById("sg-decline").addEventListener("click", openDecline);
    document.getElementById("sg-finish").addEventListener("click", finish);

    var pageEls = [];
    try {
      var buf = await fetchPdf("/api/sign/" + docId + "/file?token=" + encodeURIComponent(token), false);
      var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      var box = document.getElementById("sg-pages"); box.innerHTML = "";
      var width = Math.min(box.clientWidth - 40, 860);
      for (var pn = 1; pn <= pdf.numPages; pn++) {
        var page = await pdf.getPage(pn);
        var vp0 = page.getViewport({ scale: 1 });
        var scale = width / vp0.width;
        var vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
        var pageEl = el('<div class="page" data-page="' + pn + '"><div class="flayer"></div></div>');
        pageEl.style.width = width + "px"; // height follows the canvas aspect — never clipped
        var canvas = document.createElement("canvas"); canvas.width = vp.width; canvas.height = vp.height;
        pageEl.insertBefore(canvas, pageEl.firstChild);
        box.appendChild(pageEl);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        pageEls[pn] = pageEl;
      }
      info.fields.forEach(renderSignerField);
    } catch (e) { document.getElementById("sg-pages").innerHTML = '<div class="err" style="max-width:600px;margin:20px auto">' + esc(e.message) + "</div>"; }

    function renderSignerField(f) {
      var pageEl = pageEls[f.page]; if (!pageEl) return;
      var mta = FIELD_META[f.type];
      var node = el('<div class="sfld' + (f.required ? " req" : "") + '"></div>');
      node.style.left = (f.x * 100) + "%"; node.style.top = (f.y * 100) + "%";
      node.style.width = (f.w * 100) + "%"; node.style.height = (f.h * 100) + "%";
      node.dataset.fid = f.id;
      pageEl.querySelector(".flayer").appendChild(node);

      if (f.type === "signature" || f.type === "initials") {
        node.innerHTML = '<span style="pointer-events:none">' + mta.icon + " " + mta.label + "</span>";
        node.addEventListener("click", function () { openSignaturePad(f, node); });
      } else if (f.type === "date") {
        values[f.id] = todayStr();
        node.classList.add("done"); node.textContent = todayStr();
      } else if (f.type === "name") {
        if (info.recipient.name) {
          values[f.id] = info.recipient.name;
          node.classList.add("done"); node.textContent = info.recipient.name;
        } else {
          // No name on file — let the signer type it.
          var ni = el('<input type="text" placeholder="Your name" />');
          node.appendChild(ni);
          ni.addEventListener("input", function () { values[f.id] = ni.value; node.classList.toggle("done", !!ni.value); updateProgress(); });
        }
      } else if (f.type === "email") {
        values[f.id] = info.recipient.email;
        node.classList.add("done"); node.textContent = info.recipient.email;
      } else if (f.type === "checkbox") {
        node.textContent = "";
        node.addEventListener("click", function () {
          var on = !values[f.id]; values[f.id] = on ? "1" : "";
          node.classList.toggle("done", on); node.textContent = on ? "✓" : "";
          updateProgress();
        });
      } else { // text
        var input = el('<input type="text" placeholder="' + esc(mta.label) + '" />');
        node.appendChild(input);
        input.addEventListener("input", function () { values[f.id] = input.value; node.classList.toggle("done", !!input.value); updateProgress(); });
      }
    }

    function setSignature(f, node, dataUrl) {
      values[f.id] = dataUrl;
      node.innerHTML = '<img src="' + dataUrl + '" alt="signature" />';
      node.classList.add("done");
      updateProgress();
    }

    function openSignaturePad(f, node) {
      var kind = f.type; // signature | initials
      var existing = sigMemory[kind];
      var m = el(
        '<div class="modal" style="max-width:560px"><div class="mhead"><h2 style="margin:0">Your ' + FIELD_META[kind].label.toLowerCase() + '</h2><button class="x">×</button></div>' +
        '<div class="mbody">' +
          '<div class="sig-tabs"><button class="btn sm active" data-mode="draw">Draw</button><button class="btn sm ghost" data-mode="type">Type</button></div>' +
          '<div id="sig-draw"><canvas class="sigpad" id="sig-canvas" height="180"></canvas>' +
            '<div style="display:flex;justify-content:space-between;margin-top:8px"><span class="note" style="margin:0">Draw with your mouse or finger.</span>' +
            '<button class="btn sm ghost" id="sig-clear">Clear</button></div></div>' +
          '<div id="sig-type" class="hidden"><input type="text" class="tinput" id="sig-typed" placeholder="Type your ' + (kind === "initials" ? "initials" : "name") + '" value="' + esc(info.recipient.name || "") + '" /></div>' +
        '</div>' +
        '<div class="mfoot">' +
          (existing ? '<button class="btn ghost" id="sig-reuse" style="margin-right:auto">Reuse last</button>' : "") +
          '<button class="btn ghost" id="sig-cancel">Cancel</button><button class="btn primary" id="sig-apply">Apply</button></div></div>'
      );
      var close = modal(m);
      m.querySelector(".x").addEventListener("click", close);
      m.querySelector("#sig-cancel").addEventListener("click", close);

      var mode = "draw";
      var canvas = m.querySelector("#sig-canvas");
      canvas.width = canvas.clientWidth * 2; canvas.height = 360;
      var ctx = canvas.getContext("2d"); ctx.scale(2, 2);
      ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#12131a";
      var drawing = false, hasInk = false, last = null;
      function pos(e) { var r = canvas.getBoundingClientRect(); var p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; }
      function start(e) { e.preventDefault(); drawing = true; last = pos(e); }
      function move(e) { if (!drawing) return; e.preventDefault(); var p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; hasInk = true; }
      function end() { drawing = false; }
      canvas.addEventListener("mousedown", start); canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
      canvas.addEventListener("touchstart", start, { passive: false }); canvas.addEventListener("touchmove", move, { passive: false }); canvas.addEventListener("touchend", end);
      m.querySelector("#sig-clear").addEventListener("click", function () { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; });

      m.querySelectorAll("[data-mode]").forEach(function (b) {
        b.addEventListener("click", function () {
          mode = b.dataset.mode;
          m.querySelectorAll("[data-mode]").forEach(function (x) { x.classList.toggle("active", x === b); x.classList.toggle("ghost", x !== b); });
          m.querySelector("#sig-draw").classList.toggle("hidden", mode !== "draw");
          m.querySelector("#sig-type").classList.toggle("hidden", mode !== "type");
        });
      });

      var reuse = m.querySelector("#sig-reuse");
      if (reuse) reuse.addEventListener("click", function () { setSignature(f, node, existing); close(); });

      m.querySelector("#sig-apply").addEventListener("click", function () {
        var dataUrl = null;
        if (mode === "draw") { if (!hasInk) return toast("Draw your signature first.", true); dataUrl = trimCanvas(canvas); }
        else { var txt = m.querySelector("#sig-typed").value.trim(); if (!txt) return toast("Type your signature first.", true); dataUrl = typedSignature(txt); }
        if (!dataUrl) return toast("Signature looks empty.", true);
        sigMemory[kind] = dataUrl;
        setSignature(f, node, dataUrl);
        close();
      });
    }

    function updateProgress() {
      var req = info.fields.filter(function (f) { return f.required; });
      var done = req.filter(function (f) { return !!values[f.id]; }).length;
      var banner = document.getElementById("sg-banner");
      if (done >= req.length && req.length) banner.innerHTML = "✅ All required fields complete — click <b style='margin:0 4px'>Finish &amp; sign</b> when ready.";
    }

    async function finish() {
      var missing = info.fields.filter(function (f) { return f.required && !values[f.id]; });
      if (missing.length) {
        toast("Please complete all required fields (" + missing.length + " left).", true);
        var first = document.querySelector('[data-fid="' + missing[0].id + '"]');
        if (first) { first.scrollIntoView({ behavior: "smooth", block: "center" }); first.style.boxShadow = "0 0 0 3px rgba(239,68,68,.6)"; setTimeout(function () { first.style.boxShadow = ""; }, 1600); }
        return;
      }
      var btn = document.getElementById("sg-finish"); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Finishing…';
      try {
        var r = await api("/api/sign/" + docId + "/complete", { method: "POST", auth: false, body: { token: token, values: values } });
        signerDone(docId, token, info, r.completed);
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.innerHTML = "Finish &amp; sign"; }
    }

    function openDecline() {
      var m = el('<div class="modal"><div class="mhead"><h2 style="margin:0">Decline to sign</h2><button class="x">×</button></div>' +
        '<div class="mbody"><p class="sub">Let the sender know why (optional). This stops the signing process.</p>' +
        '<textarea id="dec-reason" rows="3" placeholder="Reason (optional)"></textarea></div>' +
        '<div class="mfoot"><button class="btn ghost" id="dec-cancel">Cancel</button><button class="btn danger" id="dec-go">Decline</button></div></div>');
      var close = modal(m);
      m.querySelector(".x").addEventListener("click", close); m.querySelector("#dec-cancel").addEventListener("click", close);
      m.querySelector("#dec-go").addEventListener("click", async function () {
        var b = m.querySelector("#dec-go"); b.disabled = true; b.textContent = "…";
        try { await api("/api/sign/" + docId + "/decline", { method: "POST", auth: false, body: { token: token, reason: m.querySelector("#dec-reason").value } });
          close(); signerError("You declined to sign this document. The sender has been notified.");
        } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = "Decline"; }
      });
    }
  }

  function signerWaiting(info) {
    app.innerHTML = signerShell(
      '<div class="stat-done"><div class="big">⏳</div><h1>Waiting on earlier signers</h1>' +
      '<p class="sub">This document uses a signing order. You’ll get an email when it’s your turn to sign <b>' + esc(info.doc.title) + '</b>.</p></div>'
    );
  }

  function signerDone(docId, token, info, completed) {
    app.innerHTML = signerShell(
      '<div class="stat-done"><div class="big">✅</div><h1>' + (completed ? "All done!" : "Thanks — you’re signed!") + '</h1>' +
      '<p class="sub">' + (completed
        ? "This document is fully executed. Download your signed copy below."
        : "Your signature was recorded. We’ll email everyone the completed document once the remaining signers finish.") + '</p>' +
      (completed ? '<button class="btn primary" id="sg-dl">⬇ Download signed PDF</button>' : "") +
      '</div>'
    );
    var dl = document.getElementById("sg-dl");
    if (dl) dl.addEventListener("click", async function () {
      toast("Preparing download…");
      try {
        var res = await fetch(API + "/api/sign/" + docId + "/signed?token=" + encodeURIComponent(token));
        if (!res.ok) throw new Error("Not ready yet — try again shortly.");
        var blob = await res.blob(); var a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = (info.doc.title || "document") + "-signed.pdf"; a.click();
      } catch (e) { toast(e.message, true); }
    });
  }

  function signerError(msg) {
    app.innerHTML = signerShell('<div class="stat-done"><div class="big">⚠️</div><h1>Can’t open this document</h1><p class="sub">' + esc(msg) + '</p></div>');
  }
  function signerShell(inner) {
    return '<div class="sign-top">' + brandLogo() + '<div class="spacer" style="flex:1"></div>' + themeBtn() + '</div>' +
      '<div class="wrap" style="max-width:560px">' + inner + '</div>';
  }

  /* =========================================================================
   * Signature image helpers
   * ======================================================================= */
  function trimCanvas(canvas) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var data = ctx.getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = 0, maxY = 0, found = false;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) { found = true; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (!found) return null;
    var pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(w, maxX + pad); maxY = Math.min(h, maxY + pad);
    var out = document.createElement("canvas");
    out.width = maxX - minX; out.height = maxY - minY;
    out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }
  function typedSignature(text) {
    var pad = 20, font = "48px 'Brush Script MT','Segoe Script',cursive";
    var meas = document.createElement("canvas").getContext("2d"); meas.font = font;
    var w = Math.ceil(meas.measureText(text).width) + pad * 2;
    var c = document.createElement("canvas"); c.width = w; c.height = 96;
    var ctx = c.getContext("2d"); ctx.font = font; ctx.fillStyle = "#12131a"; ctx.textBaseline = "middle";
    ctx.fillText(text, pad, 52);
    return c.toDataURL("image/png");
  }

  /* ---- misc ---- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function hexA(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return "rgba(0,176,236," + a + ")";
    var n = parseInt(m[1], 16); return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  boot();
})();
