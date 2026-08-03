/* =============================================================================
 * Linear Vault — client app (vault.linearit.co / www.linearit.co/vault/)
 * -----------------------------------------------------------------------------
 * ZERO-KNOWLEDGE. The master password never leaves this browser. It is stretched
 * with PBKDF2-SHA256 into a key-encryption key (KEK). A random 256-bit data key
 * (DEK) actually encrypts the vault (AES-256-GCM); the DEK is wrapped by the KEK
 * so changing the master password only re-wraps the DEK (no re-encrypt). The
 * server only ever receives ciphertext + a separate "auth verifier" used to log
 * in — never the KEK, DEK, or any plaintext.
 *
 * Nothing sensitive is persisted: the DEK and decrypted items live only in memory
 * and are wiped on lock, sign-out, or 10 minutes of inactivity. Refreshing the
 * page requires signing in again — by design.
 * ============================================================================= */
(function () {
  "use strict";

  /* ---- Anti-clickjacking: never allow this app to run inside a frame ---- */
  if (window.top !== window.self) {
    try { window.top.location = window.self.location; } catch (_) { document.documentElement.textContent = ""; }
  }

  /* ---- Config ---- */
  // Served from GitHub Pages -> talk to the Worker; served by the Worker -> same-origin.
  var API_BASE = location.hostname === "vault.linearit.co" ? "" : "https://vault.linearit.co";
  var IDLE_MS = 10 * 60 * 1000;      // auto sign-out after 10 min idle
  var IDLE_WARN_MS = 45 * 1000;      // warn this long before the cut-off
  var DEFAULT_ITERS = 310000;        // PBKDF2 iterations for new/rekeyed accounts

  var FOLDERS = [
    { id: "pc", name: "PC", icon: "monitor" },
    { id: "online", name: "Online Accounts", icon: "globe" },
    { id: "passwords", name: "Passwords", icon: "key" },
  ];
  function folderName(id) { for (var i = 0; i < FOLDERS.length; i++) if (FOLDERS[i].id === id) return FOLDERS[i].name; return "Passwords"; }

  /* ---- Runtime state (all cleared on lock) ---- */
  var S = null;
  function freshState() {
    return {
      token: null, email: "", mode: null,     // mode: 'login' | 'register' | 'admin'
      kek: null, authVerifier: "",             // derived from master password (login/register in progress)
      salt: "", iters: 0, wrappedDek: "",      // current account key material (kept to allow rekey)
      dek: null, items: [], vaultVer: 0,       // decrypted vault (memory only)
      folder: "pc", query: "", isAdmin: false, // UI
    };
  }
  S = freshState();

  /* ---- Tiny DOM helpers ---- */
  function $(sel) { return document.querySelector(sel); }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;                 // safe: user data goes here
      else if (k === "html") e.innerHTML = v;                   // ONLY trusted constant SVG
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
      if (c == null || c === false) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }
  var SCREENS = ["email", "password", "register", "code", "vault", "admin"];
  function show(name) { SCREENS.forEach(function (s) { $("#screen-" + s).classList.toggle("hidden", s !== name); }); }

  var toastTimer;
  function toast(msg, kind) {
    var t = $("#toast"); t.textContent = msg; t.className = "show " + (kind || "");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = ""; }, 2600);
  }

  /* ---- Trusted inline icons (constants only) ---- */
  var IC = {
    monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 4 9 15 15 0 0 1-4 9 15 15 0 0 1-4-9 15 15 0 0 1 4-9Z"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.8 12.2 8-8"/><path d="m16 5 3 3"/><path d="m19 2 3 3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeoff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.2A11 11 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2M6.1 6.1A18 18 0 0 0 1 12s4 8 11 8a11 11 0 0 0 5.9-1.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M1 1l22 22"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
    gen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };
  function icon(name) { return h("span", { html: IC[name] }); }

  /* =========================================================================
   * Crypto (Web Crypto only)
   * ========================================================================= */
  var enc = new TextEncoder(), dec = new TextDecoder();
  function b64(buf) { var b = new Uint8Array(buf), s = "", i; for (i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function unb64(str) { var bin = atob(str), u = new Uint8Array(bin.length), i; for (i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  // master password + salt -> { kek (AES-GCM key), authVerifier (b64 proof) }
  async function deriveKeys(password, saltU8, iters) {
    var base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    var bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: saltU8, iterations: iters, hash: "SHA-256" }, base, 512);
    var raw = new Uint8Array(bits);
    var kekRaw = raw.slice(0, 32);       // first half -> encryption key (stays here)
    var authRaw = raw.slice(32, 64);     // second half -> proof sent to the server
    var kek = await crypto.subtle.importKey("raw", kekRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return { kek: kek, authVerifier: b64(authRaw) };
  }
  async function aesEncrypt(key, dataU8) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, dataU8);
    return JSON.stringify({ iv: b64(iv), ct: b64(ct) });
  }
  async function aesDecrypt(key, blobStr) {
    var o = JSON.parse(blobStr);
    var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(o.iv) }, key, unb64(o.ct));
    return new Uint8Array(pt);
  }
  async function newDek() { return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); }
  async function wrapDek(kek, dek) { return aesEncrypt(kek, new Uint8Array(await crypto.subtle.exportKey("raw", dek))); }
  async function unwrapDek(kek, wrapped) {
    var raw = await aesDecrypt(kek, wrapped);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }
  async function encryptVault(dek, items) { return aesEncrypt(dek, enc.encode(JSON.stringify(items))); }
  async function decryptVault(dek, blob) { if (!blob) return []; return JSON.parse(dec.decode(await aesDecrypt(dek, blob))); }
  function randSalt() { return b64(crypto.getRandomValues(new Uint8Array(16))); }
  function uuid() { return (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + "-" + Math.random().toString(16).slice(2)); }

  /* =========================================================================
   * API
   * ========================================================================= */
  async function api(path, method, body) {
    var headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (S.token) headers["Authorization"] = "Bearer " + S.token;
    var res;
    try {
      res = await fetch(API_BASE + path, { method: method || "GET", headers: headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { var ne = new Error("Can't reach the server. Check your connection and try again."); ne.status = 0; throw ne; }
    var data = {};
    try { data = await res.json(); } catch (_) {}
    if (data && data.token) S.token = data.token;   // sliding session refresh
    if (!res.ok) { var err = new Error((data && data.error) || ("Error " + res.status)); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  /* =========================================================================
   * Auth flow
   * ========================================================================= */
  function setBusy(btn, busy, labelWhenBusy) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = labelWhenBusy || "Please wait…"; }
    else { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
  }

  async function onEmailContinue() {
    var email = $("#email-input").value.trim().toLowerCase();
    $("#email-err").textContent = "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("#email-err").textContent = "Enter a valid email address."; return; }
    var btn = $("#email-continue"); setBusy(btn, true, "Checking…");
    try {
      var r = await api("/api/auth/start", "POST", { email: email });
      S.email = email;
      if (r.admin) { await startAdmin(); }
      else if (r.registered) { S.salt = r.salt; S.iters = r.iters || DEFAULT_ITERS; showPassword(); }
      else if (r.authorized) { S.iters = r.iters || DEFAULT_ITERS; showRegister(); }
      else { $("#email-err").textContent = "This email isn't set up yet. Contact Linear IT to get access."; }
    } catch (e) { $("#email-err").textContent = e.message; }
    finally { setBusy(btn, false); }
  }

  function showPassword() {
    S.mode = "login"; $("#pw-email").textContent = S.email; $("#pw-input").value = ""; $("#pw-err").textContent = "";
    show("password"); setTimeout(function () { $("#pw-input").focus(); }, 30);
  }
  async function onPasswordContinue() {
    var pw = $("#pw-input").value; $("#pw-err").textContent = "";
    if (!pw) { $("#pw-err").textContent = "Enter your master password."; return; }
    var btn = $("#pw-continue"); setBusy(btn, true, "Unlocking…");
    try {
      var keys = await deriveKeys(pw, unb64(S.salt), S.iters);
      S.kek = keys.kek; S.authVerifier = keys.authVerifier;
      await api("/api/auth/login", "POST", { email: S.email, auth_verifier: S.authVerifier }); // phase 1 -> emails a code
      showCode();
    } catch (e) { $("#pw-err").textContent = e.message; S.kek = null; }
    finally { setBusy(btn, false); }
  }

  function showRegister() {
    S.mode = "register";
    $("#reg-email").textContent = S.email; $("#reg-pw").value = ""; $("#reg-pw2").value = "";
    $("#reg-err").textContent = ""; updateRegMeter();
    show("register"); setTimeout(function () { $("#reg-pw").focus(); }, 30);
  }
  async function onRegisterContinue() {
    var pw = $("#reg-pw").value, pw2 = $("#reg-pw2").value; $("#reg-err").textContent = "";
    if (pw.length < 10) { $("#reg-err").textContent = "Use a master password of at least 10 characters."; return; }
    if (pw !== pw2) { $("#reg-err").textContent = "The two passwords don't match."; return; }
    var btn = $("#reg-continue"); setBusy(btn, true, "Setting up…");
    try {
      // Build all key material locally, then ask for an email code to finish.
      S.salt = randSalt(); S.iters = DEFAULT_ITERS;
      var keys = await deriveKeys(pw, unb64(S.salt), S.iters);
      S.kek = keys.kek; S.authVerifier = keys.authVerifier;
      S.dek = await newDek();
      S.wrappedDek = await wrapDek(S.kek, S.dek);
      S.items = [];
      S.pendingVaultBlob = await encryptVault(S.dek, S.items);
      await api("/api/auth/code", "POST", { email: S.email, purpose: "register" });
      showCode();
    } catch (e) { $("#reg-err").textContent = e.message; }
    finally { setBusy(btn, false); }
  }

  async function startAdmin() {
    S.mode = "admin";
    await api("/api/auth/code", "POST", { email: S.email, purpose: "admin" });
    showCode();
  }

  function showCode() {
    $("#code-email").textContent = S.email; $("#code-input").value = ""; $("#code-err").textContent = "";
    show("code"); setTimeout(function () { $("#code-input").focus(); }, 30);
  }
  async function onCodeVerify() {
    var code = $("#code-input").value.trim(); $("#code-err").textContent = "";
    if (!/^\d{4,8}$/.test(code)) { $("#code-err").textContent = "Enter the 6-digit code from your email."; return; }
    var btn = $("#code-verify"); setBusy(btn, true, "Verifying…");
    try {
      if (S.mode === "admin") {
        await api("/api/admin/login", "POST", { email: S.email, code: code });
        S.isAdmin = true; openAdmin();
      } else if (S.mode === "register") {
        var rr = await api("/api/auth/register", "POST", {
          email: S.email, code: code, salt: S.salt, iters: S.iters,
          auth_verifier: S.authVerifier, wrapped_dek: S.wrappedDek, vault_blob: S.pendingVaultBlob,
        });
        S.vaultVer = rr.vault_ver || 1; S.pendingVaultBlob = null;
        openVault();
      } else { // login phase 2
        var lr = await api("/api/auth/login", "POST", { email: S.email, auth_verifier: S.authVerifier, code: code });
        S.salt = lr.salt; S.iters = lr.iters; S.wrappedDek = lr.wrapped_dek; S.vaultVer = lr.vault_ver || 0;
        S.dek = await unwrapDek(S.kek, lr.wrapped_dek);
        S.items = await decryptVault(S.dek, lr.vault_blob);
        openVault();
      }
    } catch (e) { $("#code-err").textContent = e.message; }
    finally { setBusy(btn, false); }
  }
  async function onCodeResend() {
    $("#code-err").textContent = "";
    try {
      if (S.mode === "login") await api("/api/auth/login", "POST", { email: S.email, auth_verifier: S.authVerifier });
      else await api("/api/auth/code", "POST", { email: S.email, purpose: S.mode });
      toast("New code sent", "ok");
    } catch (e) { $("#code-err").textContent = e.message; }
  }

  /* ---- Sign out / lock (wipe everything sensitive from memory) ---- */
  function lock(message) {
    disarmIdle(); closeModal();
    S = freshState();
    show("email");
    $("#email-input").value = ""; $("#email-err").textContent = "";
    if (message) toast(message, "");
  }

  /* =========================================================================
   * Vault UI
   * ========================================================================= */
  function openVault() {
    S.isAdmin = false; $("#who").textContent = S.email; $("#search").value = ""; S.query = ""; S.folder = "pc";
    show("vault"); renderFolders(); renderEntries(); armIdle();
  }
  function renderFolders() {
    var wrap = $("#folders"); wrap.textContent = "";
    FOLDERS.forEach(function (f) {
      var count = S.items.filter(function (it) { return it.folder === f.id; }).length;
      var node = h("button", { class: "folder" + (S.folder === f.id ? " active" : ""), onclick: function () { S.folder = f.id; renderFolders(); renderEntries(); } }, [
        h("span", { class: "ico", html: IC[f.icon] }),
        h("span", { class: "fname", text: f.name }),
        h("span", { class: "fcount", text: count + (count === 1 ? " item" : " items") }),
      ]);
      wrap.appendChild(node);
    });
  }
  function currentList() {
    var q = S.query.trim().toLowerCase();
    return S.items
      .filter(function (it) { return it.folder === S.folder; })
      .filter(function (it) {
        if (!q) return true;
        return (it.title + " " + it.username + " " + (it.url || "") + " " + (it.notes || "")).toLowerCase().indexOf(q) >= 0;
      })
      .sort(function (a, b) { return (a.title || "").localeCompare(b.title || ""); });
  }
  function renderEntries() {
    $("#folder-title").textContent = folderName(S.folder);
    var box = $("#entries"); box.textContent = "";
    var list = currentList();
    if (!list.length) {
      box.appendChild(h("div", { class: "empty" }, [
        h("div", { html: IC.key }),
        h("div", { text: S.query ? "No items match your search." : "No items here yet. Tap + to add one." }),
      ]));
      return;
    }
    list.forEach(function (it) { box.appendChild(entryCard(it)); });
  }
  function entryCard(it) {
    var initial = (it.title || "?").trim().charAt(0).toUpperCase() || "?";
    var card = h("div", { class: "entry" });
    var pwShown = false;

    var pwVal = h("span", { class: "v mono", text: "••••••••••" });
    var revealBtn = h("button", { class: "iconbtn", title: "Show/hide" }, [icon("eye")]);
    revealBtn.addEventListener("click", function (e) {
      e.stopPropagation(); pwShown = !pwShown;
      pwVal.textContent = pwShown ? (it.password || "") : "••••••••••";
      revealBtn.textContent = ""; revealBtn.appendChild(icon(pwShown ? "eyeoff" : "eye"));
    });

    var row1 = h("div", { class: "row1" }, [
      h("span", { class: "avatar", text: initial }),
      h("div", {}, [h("div", { class: "etitle", text: it.title || "(untitled)" }), h("div", { class: "euser", text: it.username || "" })]),
      h("div", { class: "acts" }, [
        actBtn("copy", "Copy password", function (e) { e.stopPropagation(); copy(it.password, "Password"); }),
        actBtn("edit", "Edit", function (e) { e.stopPropagation(); openEntryModal(it); }),
      ]),
    ]);
    row1.addEventListener("click", function () { card.classList.toggle("open"); });

    var detail = h("div", { class: "detail" }, [
      kv("User", it.username || "—", it.username ? function () { copy(it.username, "Username"); } : null),
      h("div", { class: "kv" }, [
        h("span", { class: "k", text: "Pass" }), pwVal,
        h("div", { class: "miniacts" }, [revealBtn, actBtn("copy", "Copy", function (e) { e.stopPropagation(); copy(it.password, "Password"); })]),
      ]),
      it.url ? h("div", { class: "kv" }, [
        h("span", { class: "k", text: "URL" }),
        h("a", { class: "v", href: safeUrl(it.url), target: "_blank", rel: "noopener noreferrer", text: it.url }),
        h("div", { class: "miniacts" }, [actBtn("ext", "Open", function (e) { e.stopPropagation(); openUrl(it.url); })]),
      ]) : null,
      it.notes ? kv("Notes", it.notes, null) : null,
      h("div", { style: "display:flex;gap:8px;margin-top:4px" }, [
        h("button", { class: "btn ghost sm", onclick: function (e) { e.stopPropagation(); openEntryModal(it); } }, [icon("edit"), " Edit"]),
        h("button", { class: "btn ghost sm", style: "color:var(--danger)", onclick: function (e) { e.stopPropagation(); confirmDelete(it); } }, [icon("trash"), " Delete"]),
      ]),
    ]);
    card.appendChild(row1); card.appendChild(detail);
    return card;
  }
  function actBtn(ic, title, fn) { var b = h("button", { class: "iconbtn", title: title, onclick: fn }, [icon(ic)]); return b; }
  function kv(k, v, copyFn) {
    return h("div", { class: "kv" }, [
      h("span", { class: "k", text: k }),
      h("span", { class: "v", text: v }),
      copyFn ? h("div", { class: "miniacts" }, [actBtn("copy", "Copy", function (e) { e.stopPropagation(); copyFn(); })]) : null,
    ]);
  }

  /* ---- Add / edit entry ---- */
  function openEntryModal(existing) {
    var it = existing || { id: null, folder: S.folder, title: "", username: "", password: "", url: "", notes: "" };
    var isNew = !existing;
    var pwInput = h("input", { type: "password", autocomplete: "off", value: it.password || "", placeholder: "Password" });
    var folderSel = h("select", {}, FOLDERS.map(function (f) { var o = h("option", { value: f.id, text: f.name }); if (f.id === it.folder) o.selected = true; return o; }));
    var titleInput = h("input", { type: "text", autocomplete: "off", value: it.title || "", placeholder: "e.g. Office 365, Dell laptop, Router" });
    var userInput = h("input", { type: "text", autocomplete: "off", value: it.username || "", placeholder: "Username / email" });
    var urlInput = h("input", { type: "text", autocomplete: "off", value: it.url || "", placeholder: "https:// (optional)" });
    var notesInput = h("textarea", { autocomplete: "off", placeholder: "Notes (optional)" }); notesInput.value = it.notes || "";
    var err = h("div", { class: "err" });

    var revealBtn = h("button", { class: "iconbtn", type: "button", title: "Show" }, [icon("eye")]);
    revealBtn.addEventListener("click", function () { var s = pwInput.type === "password"; pwInput.type = s ? "text" : "password"; revealBtn.textContent = ""; revealBtn.appendChild(icon(s ? "eyeoff" : "eye")); });
    var genBtn = h("button", { class: "iconbtn", type: "button", title: "Generate strong password" }, [icon("gen")]);
    genBtn.addEventListener("click", function () { pwInput.value = genPassword(18); pwInput.type = "text"; revealBtn.textContent = ""; revealBtn.appendChild(icon("eyeoff")); });

    var modal = h("div", { class: "modal" }, [
      h("h3", { text: isNew ? "Add item" : "Edit item" }),
      h("div", { class: "msub", text: "Stored encrypted — only you can read it." }),
      field("Folder", folderSel),
      field("Name", titleInput),
      field("Username", userInput),
      field("Password", h("div", { class: "pw-wrap" }, [pwInput, h("div", { class: "pw-btns" }, [genBtn, revealBtn])])),
      field("Website", urlInput),
      field("Notes", notesInput),
      err,
      h("div", { class: "actions" }, [
        h("button", { class: "btn ghost", onclick: closeModal }, "Cancel"),
        h("button", { class: "btn", onclick: async function (e) {
          if (!titleInput.value.trim() && !userInput.value.trim() && !pwInput.value) { err.textContent = "Add at least a name or a password."; return; }
          var btn = e.currentTarget; setBusy(btn, true, "Saving…");
          var rec = {
            id: it.id || uuid(), folder: folderSel.value,
            title: titleInput.value.trim(), username: userInput.value.trim(),
            password: pwInput.value, url: urlInput.value.trim(), notes: notesInput.value,
            updated: Date.now(),
          };
          if (isNew) S.items.push(rec);
          else S.items = S.items.map(function (x) { return x.id === rec.id ? rec : x; });
          try { await persist(); closeModal(); S.folder = rec.folder; renderFolders(); renderEntries(); toast("Saved", "ok"); }
          catch (er) { err.textContent = er.message; setBusy(btn, false); }
        } }, isNew ? "Add item" : "Save"),
      ]),
    ]);
    openModal(modal);
    setTimeout(function () { titleInput.focus(); }, 30);
  }
  function field(label, control) { return h("label", { class: "field" }, [h("span", { class: "lbl", text: label }), control]); }

  function confirmDelete(it) {
    openModal(h("div", { class: "modal" }, [
      h("h3", { text: "Delete this item?" }),
      h("div", { class: "msub", text: (it.title || "This item") + " will be permanently removed from your vault." }),
      h("div", { class: "actions" }, [
        h("button", { class: "btn ghost", onclick: closeModal }, "Cancel"),
        h("button", { class: "btn danger", onclick: async function (e) {
          setBusy(e.currentTarget, true, "Deleting…");
          S.items = S.items.filter(function (x) { return x.id !== it.id; });
          try { await persist(); closeModal(); renderFolders(); renderEntries(); toast("Deleted", "ok"); }
          catch (er) { toast(er.message, "bad"); closeModal(); }
        } }, "Delete"),
      ]),
    ]));
  }

  /* ---- Persist (encrypt + upload, with conflict guard) ---- */
  async function persist() {
    var blob = await encryptVault(S.dek, S.items);
    try {
      var r = await api("/api/vault", "PUT", { vault_blob: blob, base_ver: S.vaultVer });
      S.vaultVer = r.vault_ver;
    } catch (e) {
      if (e.status === 409) {
        // Vault changed on another device since we loaded it — reload to be safe.
        var g = await api("/api/vault", "GET");
        S.vaultVer = g.vault_ver; S.items = await decryptVault(S.dek, g.vault_blob);
        renderFolders(); renderEntries();
        throw new Error("Your vault was updated on another device, so it was reloaded. Please redo your last change.");
      }
      throw e;
    }
  }

  /* =========================================================================
   * Import / Export (CSV — opens in Excel)
   * ========================================================================= */
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function toCSV(items) {
    var head = ["folder", "title", "username", "password", "url", "notes"];
    var lines = [head.join(",")];
    items.forEach(function (it) {
      lines.push([folderName(it.folder), it.title, it.username, it.password, it.url, it.notes].map(csvCell).join(","));
    });
    return "﻿" + lines.join("\r\n"); // BOM so Excel reads UTF-8 correctly
  }
  function exportCSV() {
    if (!S.items.length) { toast("Nothing to export yet", "bad"); return; }
    var csv = toCSV(S.items);
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = h("a", { href: url, download: "linear-vault-" + new Date().toISOString().slice(0, 10) + ".csv" });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast(S.items.length + " items exported", "ok");
  }
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    var rows = [], row = [], field = "", i = 0, inQ = false;
    while (i < text.length) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function mapFolder(f, url) {
    f = (f || "").toLowerCase();
    if (/\bpc\b|device|computer|desktop|laptop|server|workstation/.test(f)) return "pc";
    if (/online|website|web|account/.test(f)) return "online";
    if (f === "passwords" || f === "password") return "passwords";
    if (url && /https?:|www\.|\.[a-z]{2,}/i.test(url)) return "online";
    return "passwords";
  }
  function importRows(rows) {
    if (!rows.length) return [];
    var header = rows[0].map(function (x) { return String(x || "").trim().toLowerCase(); });
    function idx(names) { for (var n = 0; n < names.length; n++) { var k = header.indexOf(names[n]); if (k >= 0) return k; } return -1; }
    var iF = idx(["folder", "category", "group", "type"]);
    var iT = idx(["title", "name", "account", "item", "service", "login_name"]);
    var iU = idx(["username", "user", "login", "login_username", "email", "user name", "e-mail"]);
    var iP = idx(["password", "pass", "pwd", "login_password"]);
    var iL = idx(["url", "website", "web site", "site", "login_uri", "uri", "link"]);
    var iN = idx(["notes", "note", "comment", "comments", "extra"]);
    var hasHeader = iT >= 0 || iP >= 0 || iU >= 0;
    var out = [];
    for (var r = hasHeader ? 1 : 0; r < rows.length; r++) {
      var row = rows[r]; if (!row || row.every(function (c) { return !String(c || "").trim(); })) continue;
      var get = function (k) { return k >= 0 && row[k] != null ? String(row[k]) : ""; };
      var url = get(iL);
      out.push({
        id: uuid(), folder: mapFolder(get(iF), url),
        title: (get(iT) || get(iU) || "(untitled)").trim(),
        username: get(iU).trim(), password: get(iP), url: url.trim(), notes: get(iN), updated: Date.now(),
      });
    }
    return out;
  }
  function onImportFile(ev) {
    var file = ev.target.files && ev.target.files[0]; ev.target.value = "";
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try { incoming = importRows(parseCSV(String(reader.result))); }
      catch (e) { toast("Couldn't read that file", "bad"); return; }
      if (!incoming.length) { toast("No rows found in that file", "bad"); return; }
      openModal(h("div", { class: "modal" }, [
        h("h3", { text: "Import " + incoming.length + " item" + (incoming.length === 1 ? "" : "s") + "?" }),
        h("div", { class: "msub", text: "They'll be added to your vault, sorted into PC / Online Accounts / Passwords automatically. Existing items are kept." }),
        h("div", { class: "actions" }, [
          h("button", { class: "btn ghost", onclick: closeModal }, "Cancel"),
          h("button", { class: "btn", onclick: async function (e) {
            setBusy(e.currentTarget, true, "Importing…");
            S.items = S.items.concat(incoming);
            try { await persist(); closeModal(); renderFolders(); renderEntries(); toast("Imported " + incoming.length + " items", "ok"); }
            catch (er) { toast(er.message, "bad"); closeModal(); }
          } }, "Import"),
        ]),
      ]));
    };
    reader.onerror = function () { toast("Couldn't read that file", "bad"); };
    reader.readAsText(file);
  }

  /* =========================================================================
   * Settings — change master password
   * ========================================================================= */
  function openSettings() {
    var cur = h("input", { type: "password", autocomplete: "off", placeholder: "Current master password" });
    var np = h("input", { type: "password", autocomplete: "new-password", placeholder: "New master password" });
    var np2 = h("input", { type: "password", autocomplete: "new-password", placeholder: "Confirm new password" });
    var meter = h("i"); var meterWrap = h("div", { class: "meter" }, [meter]);
    np.addEventListener("input", function () { setMeter(meter, strength(np.value)); });
    var err = h("div", { class: "err" });
    openModal(h("div", { class: "modal" }, [
      h("h3", { text: "Change master password" }),
      h("div", { class: "msub", text: "Your saved items are re-secured with the new password. It never leaves this device." }),
      field("Current password", cur),
      field("New password", np), meterWrap,
      field("Confirm new password", np2),
      err,
      h("div", { class: "actions" }, [
        h("button", { class: "btn ghost", onclick: closeModal }, "Cancel"),
        h("button", { class: "btn", onclick: async function (e) {
          err.textContent = "";
          if (np.value.length < 10) { err.textContent = "New password must be at least 10 characters."; return; }
          if (np.value !== np2.value) { err.textContent = "The new passwords don't match."; return; }
          var btn = e.currentTarget; setBusy(btn, true, "Updating…");
          try {
            var check = await deriveKeys(cur.value, unb64(S.salt), S.iters);
            if (check.authVerifier !== S.authVerifier) { err.textContent = "Current password is incorrect."; setBusy(btn, false); return; }
            var newSalt = randSalt(), iters = DEFAULT_ITERS;
            var keys = await deriveKeys(np.value, unb64(newSalt), iters);
            var wrapped = await wrapDek(keys.kek, S.dek);
            await api("/api/account/rekey", "POST", { salt: newSalt, iters: iters, auth_verifier: keys.authVerifier, wrapped_dek: wrapped });
            S.salt = newSalt; S.iters = iters; S.kek = keys.kek; S.authVerifier = keys.authVerifier; S.wrappedDek = wrapped;
            closeModal(); toast("Master password changed", "ok");
          } catch (er) { err.textContent = er.message; setBusy(btn, false); }
        } }, "Change password"),
      ]),
    ]));
    setTimeout(function () { cur.focus(); }, 30);
  }

  /* =========================================================================
   * Admin panel
   * ========================================================================= */
  function openAdmin() {
    disarmIdle(); $("#admin-who").textContent = S.email; show("admin"); armIdle(); loadClients();
  }
  async function loadClients() {
    var tb = $("#admin-rows"); tb.textContent = ""; $("#admin-err").textContent = "";
    try {
      var r = await api("/api/admin/clients", "GET");
      if (!r.clients.length) { tb.appendChild(h("tr", {}, [h("td", { colspan: "3", text: "No clients yet. Approve an email above to get started." })])); return; }
      r.clients.forEach(function (c) {
        tb.appendChild(h("tr", {}, [
          h("td", { text: c.email }),
          h("td", {}, [h("span", { class: "badge " + (c.registered ? "on" : "off"), text: c.registered ? "Active" : "Approved" })]),
          h("td", { style: "text-align:right;white-space:nowrap" }, [
            c.registered ? h("button", { class: "btn ghost sm", title: "Wipe their vault so they can set a new master password", onclick: function () { adminReset(c.email); } }, "Reset") : null,
            h("button", { class: "btn ghost sm", style: "color:var(--danger);margin-left:6px", onclick: function () { adminRevoke(c.email); } }, "Revoke"),
          ]),
        ]));
      });
    } catch (e) { $("#admin-err").textContent = e.message; }
  }
  async function adminAdd() {
    var email = $("#admin-new-email").value.trim().toLowerCase(); $("#admin-err").textContent = "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("#admin-err").textContent = "Enter a valid email address."; return; }
    try { await api("/api/admin/clients", "POST", { email: email }); $("#admin-new-email").value = ""; toast("Approved " + email, "ok"); loadClients(); }
    catch (e) { $("#admin-err").textContent = e.message; }
  }
  function adminReset(email) {
    openModal(h("div", { class: "modal" }, [
      h("h3", { text: "Reset this client?" }),
      h("div", { class: "msub", text: email + " will lose their saved items and set a brand-new master password next time they sign in. You cannot see their current items. This can't be undone." }),
      h("div", { class: "actions" }, [
        h("button", { class: "btn ghost", onclick: closeModal }, "Cancel"),
        h("button", { class: "btn danger", onclick: async function () { try { await api("/api/admin/reset", "POST", { email: email }); closeModal(); toast("Client reset", "ok"); loadClients(); } catch (e) { toast(e.message, "bad"); } } }, "Reset vault"),
      ]),
    ]));
  }
  function adminRevoke(email) {
    openModal(h("div", { class: "modal" }, [
      h("h3", { text: "Revoke access?" }),
      h("div", { class: "msub", text: email + " will be removed from the allowlist and their vault deleted. This can't be undone." }),
      h("div", { class: "actions" }, [
        h("button", { class: "btn ghost", onclick: closeModal }, "Cancel"),
        h("button", { class: "btn danger", onclick: async function () { try { await api("/api/admin/clients", "DELETE", { email: email }); closeModal(); toast("Access revoked", "ok"); loadClients(); } catch (e) { toast(e.message, "bad"); } } }, "Revoke"),
      ]),
    ]));
  }

  /* =========================================================================
   * Helpers: clipboard, generator, strength, url, modal, theme
   * ========================================================================= */
  async function copy(text, label) {
    if (!text) { toast("Nothing to copy", "bad"); return; }
    try { await navigator.clipboard.writeText(text); toast((label || "Value") + " copied", "ok"); }
    catch (_) {
      var ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = text; document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); toast((label || "Value") + " copied", "ok"); } catch (e) { toast("Couldn't copy", "bad"); }
      document.body.removeChild(ta);
    }
  }
  function genPassword(len) {
    len = len || 18;
    var U = "ABCDEFGHJKLMNPQRSTUVWXYZ", L = "abcdefghijkmnpqrstuvwxyz", D = "23456789", Sy = "!@#$%^&*()-_=+?";
    var all = U + L + D + Sy, out = [], pick = function (set) { return set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length]; };
    out.push(pick(U), pick(L), pick(D), pick(Sy));
    while (out.length < len) out.push(pick(all));
    for (var i = out.length - 1; i > 0; i--) { var j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); var t = out[i]; out[i] = out[j]; out[j] = t; }
    return out.join("");
  }
  function strength(pw) {
    if (!pw) return 0;
    var sets = 0; if (/[a-z]/.test(pw)) sets++; if (/[A-Z]/.test(pw)) sets++; if (/\d/.test(pw)) sets++; if (/[^A-Za-z0-9]/.test(pw)) sets++;
    var pool = sets >= 4 ? 90 : sets === 3 ? 62 : sets === 2 ? 52 : 26;
    var bits = pw.length * (Math.log(pool) / Math.log(2));
    if (bits < 40) return 1; if (bits < 60) return 2; if (bits < 90) return 3; return 4;
  }
  function setMeter(el, score) {
    var pct = [0, 25, 50, 75, 100][score] || 0;
    var col = ["", "var(--danger)", "var(--warn)", "#38bdf8", "var(--success)"][score] || "var(--danger)";
    el.style.width = pct + "%"; el.style.background = col;
  }
  function updateRegMeter() {
    var pw = $("#reg-pw").value, sc = strength(pw);
    setMeter($("#reg-meter"), sc);
    var labels = ["Use at least 10 characters. This is the ONLY key to your vault.", "Weak — add length and variety.", "Fair — a bit longer would help.", "Good password.", "Strong password."];
    $("#reg-strength").textContent = labels[sc];
  }
  function safeUrl(u) { u = String(u || ""); if (/^https?:\/\//i.test(u)) return u; if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return "https://" + u; return "#"; }
  function openUrl(u) { var s = safeUrl(u); if (s !== "#") window.open(s, "_blank", "noopener,noreferrer"); else toast("No valid web address", "bad"); }

  function openModal(node) { var root = $("#modal-root"); root.textContent = ""; var bg = h("div", { class: "modal-bg", onclick: function (e) { if (e.target === bg) closeModal(); } }, [node]); root.appendChild(bg); }
  function closeModal() { $("#modal-root").textContent = ""; }

  function applyTheme(t) { document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem("vault-theme", t); } catch (_) {} }
  function toggleTheme() { applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"); }

  /* =========================================================================
   * Idle auto-logout (10 minutes)
   * ========================================================================= */
  var idleTimer = null, warnTimer = null, warnInterval = null;
  function signedIn() { return !!S.token && (S.isAdmin || !!S.dek); }
  function disarmIdle() { clearTimeout(idleTimer); clearTimeout(warnTimer); clearInterval(warnInterval); idleTimer = warnTimer = warnInterval = null; }
  function armIdle() {
    disarmIdle();
    if (!signedIn()) return;
    warnTimer = setTimeout(showIdleWarning, Math.max(0, IDLE_MS - IDLE_WARN_MS));
    idleTimer = setTimeout(function () { lock("Signed out after 10 minutes of inactivity."); }, IDLE_MS);
  }
  function onActivity() {
    if (!signedIn()) return;
    // If the warning modal is up, activity dismisses it and re-arms.
    if ($("#modal-root").dataset.idle === "1") { closeIdleWarning(); }
    armIdle();
  }
  function showIdleWarning() {
    var left = Math.round(IDLE_WARN_MS / 1000);
    var count = h("b", { text: String(left) });
    var root = $("#modal-root"); root.dataset.idle = "1";
    openModal(h("div", { class: "modal" }, [
      h("h3", { text: "Still there?" }),
      h("div", { class: "msub" }, ["For your security you'll be signed out in ", count, " seconds."]),
      h("div", { class: "actions" }, [
        h("button", { class: "btn full", onclick: function () { closeIdleWarning(); armIdle(); } }, "Stay signed in"),
      ]),
    ]));
    warnInterval = setInterval(function () { left--; count.textContent = String(Math.max(0, left)); if (left <= 0) clearInterval(warnInterval); }, 1000);
  }
  function closeIdleWarning() { clearInterval(warnInterval); warnInterval = null; var root = $("#modal-root"); delete root.dataset.idle; closeModal(); }

  /* =========================================================================
   * Wire up
   * ========================================================================= */
  function onEnter(el, fn) { el.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); fn(); } }); }
  function initReveal(btnSel, inputSel) {
    $(btnSel).addEventListener("click", function () {
      var inp = $(inputSel), s = inp.type === "password"; inp.type = s ? "text" : "password";
      $(btnSel).textContent = ""; $(btnSel).appendChild(icon(s ? "eyeoff" : "eye"));
    });
  }

  function init() {
    try { var t = localStorage.getItem("vault-theme"); if (t) document.documentElement.setAttribute("data-theme", t); } catch (_) {}

    $("#email-continue").addEventListener("click", onEmailContinue);
    onEnter($("#email-input"), onEmailContinue);

    $("#pw-continue").addEventListener("click", onPasswordContinue);
    onEnter($("#pw-input"), onPasswordContinue);
    initReveal("#pw-reveal", "#pw-input");
    $("#pw-back").addEventListener("click", function () { lock(); });

    $("#reg-continue").addEventListener("click", onRegisterContinue);
    onEnter($("#reg-pw2"), onRegisterContinue);
    initReveal("#reg-reveal", "#reg-pw");
    $("#reg-pw").addEventListener("input", updateRegMeter);
    $("#reg-back").addEventListener("click", function () { lock(); });

    $("#code-verify").addEventListener("click", onCodeVerify);
    onEnter($("#code-input"), onCodeVerify);
    $("#code-input").addEventListener("input", function () { this.value = this.value.replace(/\D/g, "").slice(0, 6); });
    $("#code-resend").addEventListener("click", onCodeResend);
    $("#code-back").addEventListener("click", function () { lock(); });

    $("#search").addEventListener("input", function () { S.query = this.value; renderEntries(); });
    $("#btn-add").addEventListener("click", function () { openEntryModal(null); });
    $("#btn-import").addEventListener("click", function () { $("#import-file").click(); });
    $("#import-file").addEventListener("change", onImportFile);
    $("#btn-export").addEventListener("click", exportCSV);
    $("#btn-settings").addEventListener("click", openSettings);
    $("#btn-theme").addEventListener("click", toggleTheme);
    $("#btn-lock").addEventListener("click", function () { lock("Vault locked."); });

    $("#admin-add").addEventListener("click", adminAdd);
    onEnter($("#admin-new-email"), adminAdd);
    $("#admin-theme").addEventListener("click", toggleTheme);
    $("#admin-lock").addEventListener("click", function () { lock("Signed out."); });

    ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"].forEach(function (ev) {
      window.addEventListener(ev, onActivity, { passive: true });
    });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") onActivity(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && $("#modal-root").dataset.idle !== "1") closeModal(); });

    show("email");
    setTimeout(function () { $("#email-input").focus(); }, 50);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
