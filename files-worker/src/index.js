/**
 * Linear Tech — File Portal
 * =========================
 * Cloudflare Worker: serves the UI + API for files.linearit.co
 *
 * Bindings (set in wrangler.toml):
 *   DB     — D1 database (users, sessions, files, shares)
 *   FILES  — R2 bucket  (file contents)
 *
 * Secrets (set via `wrangler secret put` or dashboard):
 *   SESSION_SECRET — random 32+ char string for HMAC session tokens
 */

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return corsHeaders(new Response(null, { status: 204 }));

    try {
      // ── Static UI ──────────────────────────────────────────────────
      if (method === "GET" && (path === "/" || path === "/files" || path === "/files/")) {
        return htmlResponse(renderApp());
      }
      if (method === "GET" && path === "/app.js") {
        return new Response(clientScript(), { status: 200, headers: { "Content-Type": "application/javascript" } });
      }
      if (method === "GET" && path.startsWith("/view/")) {
        return htmlResponse(renderViewPage(path.slice(6)));
      }

      // ── Auth API ───────────────────────────────────────────────────
      if (path === "/api/signup"  && method === "POST") return corsHeaders(await signup(request, env));
      if (path === "/api/login"   && method === "POST") return corsHeaders(await loginUser(request, env));
      if (path === "/api/logout"  && method === "POST") return corsHeaders(await logout(request, env));
      if (path === "/api/me"      && method === "GET")  return corsHeaders(await me(request, env));

      // ── File API ───────────────────────────────────────────────────
      if (path === "/api/files"        && method === "GET")    return corsHeaders(await listFiles(request, env));
      if (path === "/api/files/upload" && method === "POST")   return corsHeaders(await uploadFile(request, env));
      if (path === "/api/files/delete" && method === "POST")   return corsHeaders(await deleteFile(request, env));
      if (path === "/api/files/download" && method === "GET")  return await downloadFile(request, env, url);

      // ── Share API ──────────────────────────────────────────────────
      if (path === "/api/share/create" && method === "POST")   return corsHeaders(await createShare(request, env));
      if (path === "/api/share/view"   && method === "POST")   return corsHeaders(await viewShare(request, env, ctx));

      // ── Cron: purge burned/expired shares ──────────────────────────
      // (also callable via GET /api/cron for manual runs during setup)
      if (path === "/api/cron" && method === "GET") {
        await purgeExpired(env);
        return new Response("purged", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return corsHeaders(json({ error: String(err?.message || err) }, 500));
    }
  },

  async scheduled(_event, env) {
    await purgeExpired(env);
  }
};

/* ================================================================
 * HTML — single-page app rendered by the worker
 * ================================================================ */
function renderApp() {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Linear Tech · File Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}

/* ── Dark theme (default) ── */
:root,[data-theme="dark"]{
  --bg:#0f1117;--bg2:#1a1d27;--bg3:#222536;
  --text:#eef0f6;--muted:#7c85a2;--muted2:#4e5571;
  --accent:#4f7ef8;--accent-h:#3b6cf5;--accent-bg:rgba(79,126,248,.12);
  --border:#2a2f45;--border2:#353b56;
  --card:#181c2a;--card2:#1e2235;
  --danger:#f06464;--danger-bg:rgba(240,100,100,.12);
  --success:#4ade80;--success-bg:rgba(74,222,128,.12);
  --shadow:0 2px 16px rgba(0,0,0,.4);
  --input-bg:#0f1117;
}

/* ── Light theme ── */
[data-theme="light"]{
  --bg:#f4f6fb;--bg2:#ffffff;--bg3:#eef0f8;
  --text:#1a1d2e;--muted:#5a6080;--muted2:#9aa0bc;
  --accent:#3b6cf5;--accent-h:#2955d8;--accent-bg:rgba(59,108,245,.08);
  --border:#dde1ee;--border2:#c8cee0;
  --card:#ffffff;--card2:#f8f9fd;
  --danger:#e03e3e;--danger-bg:rgba(224,62,62,.08);
  --success:#16a34a;--success-bg:rgba(22,163,74,.08);
  --shadow:0 2px 16px rgba(0,0,0,.08);
  --input-bg:#f4f6fb;
}

body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;transition:background .2s,color .2s}

/* ── Header ── */
header{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 28px;height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:var(--shadow)}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:32px;height:32px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center}
.logo-icon svg{width:18px;height:18px;stroke:#fff;fill:none;stroke-width:2}
.logo-text{font-size:1.05rem;font-weight:700;color:var(--text);letter-spacing:-.02em}
.logo-text span{color:var(--accent)}
.header-right{display:flex;align-items:center;gap:10px}
#theme-toggle{background:var(--bg3);border:1px solid var(--border);color:var(--muted);width:36px;height:36px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
#theme-toggle:hover{border-color:var(--accent);color:var(--accent)}
#nav-user{display:flex;align-items:center;gap:8px;font-size:.85rem;color:var(--muted)}
.nav-name{font-weight:600;color:var(--text);font-size:.88rem}
.btn-signout{background:transparent;border:1px solid var(--border);color:var(--muted);padding:5px 14px;border-radius:20px;cursor:pointer;font-size:.8rem;font-family:inherit;transition:all .15s}
.btn-signout:hover{border-color:var(--danger);color:var(--danger)}

/* ── Layout ── */
main{max-width:880px;margin:0 auto;padding:36px 20px}

/* ── Cards ── */
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;box-shadow:var(--shadow);transition:background .2s,border-color .2s}
.card-title{font-size:1.15rem;font-weight:700;margin-bottom:6px;color:var(--text)}
.card-desc{font-size:.85rem;color:var(--muted);margin-bottom:24px;line-height:1.6}

/* ── Alerts ── */
#alert{padding:13px 18px;border-radius:10px;margin-bottom:24px;display:none;font-size:.88rem;font-weight:500}
.alert-err{background:var(--danger-bg);border:1px solid var(--danger);color:var(--danger)}
.alert-ok{background:var(--success-bg);border:1px solid var(--success);color:var(--success)}

/* ── Tabs ── */
.tabs{display:flex;gap:4px;margin-bottom:28px;background:var(--bg3);border-radius:12px;padding:4px;border:1px solid var(--border)}
.tab{flex:1;text-align:center;padding:9px 16px;border-radius:9px;cursor:pointer;font-size:.88rem;font-weight:600;color:var(--muted);transition:all .15s;user-select:none}
.tab.active{background:var(--card);color:var(--text);box-shadow:0 1px 6px rgba(0,0,0,.15)}
.tab:hover:not(.active){color:var(--text)}

/* ── Form fields ── */
.field{margin-bottom:18px}
label{display:block;font-size:.82rem;color:var(--muted);margin-bottom:7px;font-weight:600;letter-spacing:.01em}
input[type=text],input[type=email],input[type=password],input[type=date]{
  width:100%;background:var(--input-bg);border:1px solid var(--border2);color:var(--text);
  padding:11px 15px;border-radius:10px;font-size:.92rem;outline:none;font-family:inherit;
  transition:border-color .15s,box-shadow .15s
}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
input::placeholder{color:var(--muted2)}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:var(--accent);color:#fff;border:none;padding:11px 24px;
  border-radius:10px;cursor:pointer;font-size:.92rem;font-weight:600;font-family:inherit;transition:all .15s;letter-spacing:-.01em}
.btn:hover{background:var(--accent-h);transform:translateY(-1px);box-shadow:0 4px 12px rgba(79,126,248,.3)}
.btn:active{transform:none}
.btn-outline{background:transparent;border:1px solid var(--border2);color:var(--muted)}
.btn-outline:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-bg);box-shadow:none;transform:none}
.btn-danger{background:var(--danger)}
.btn-danger:hover{background:#d95555;box-shadow:0 4px 12px rgba(240,100,100,.3)}
.btn-sm{padding:6px 14px;font-size:.8rem;border-radius:8px}
.btn-full{width:100%}

/* ── Drop zones ── */
.drop-zone{border:2px dashed var(--border2);border-radius:12px;padding:44px 20px;text-align:center;
  color:var(--muted);cursor:pointer;transition:all .2s;margin-bottom:20px}
.drop-zone:hover,.drop-zone.over{border-color:var(--accent);background:var(--accent-bg);color:var(--accent)}
.drop-zone:hover svg,.drop-zone.over svg{stroke:var(--accent)}
.drop-zone p{margin-top:10px;font-size:.88rem;font-weight:500}
.drop-zone .hint{font-size:.78rem;color:var(--muted2);margin-top:4px;font-weight:400}

/* ── File table ── */
.file-table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.87rem}
th{text-align:left;padding:10px 14px;color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border)}
td{padding:12px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--bg3)}
.file-name{font-weight:600;word-break:break-all;color:var(--text)}
.file-meta{color:var(--muted);font-size:.78rem;margin-top:2px}
.actions{display:flex;gap:6px;justify-content:flex-end}
.empty-state{text-align:center;padding:48px 20px;color:var(--muted)}
.empty-state svg{margin:0 auto 16px;display:block;opacity:.4}
.empty-state p{font-size:.92rem}

/* ── Share result box ── */
.share-box{background:var(--success-bg);border:1px solid var(--success);border-radius:12px;padding:18px;margin-top:20px}
.share-box-label{font-size:.78rem;font-weight:600;color:var(--success);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em}
.share-url-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.share-url{font-size:.82rem;color:var(--text);word-break:break-all;flex:1;background:var(--card2);border:1px solid var(--border);padding:8px 12px;border-radius:8px;font-family:monospace}

/* ── Progress ── */
progress{width:100%;height:5px;border-radius:3px;appearance:none;margin-top:14px;display:none}
progress::-webkit-progress-bar{background:var(--border);border-radius:3px}
progress::-webkit-progress-value{background:var(--accent);border-radius:3px;transition:width .3s}

/* ── Misc ── */
#section-auth,#section-portal{display:none}
.auth-wrap{max-width:420px;margin:0 auto}
.section-label{font-size:.75rem;font-weight:700;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
hr{border:none;border-top:1px solid var(--border);margin:24px 0}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 2v7h7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <span class="logo-text">Linear<span>Tech</span> Files</span>
  </div>
  <div class="header-right">
    <button id="theme-toggle" title="Toggle light/dark mode" onclick="toggleTheme()">
      <svg id="icon-moon" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <svg id="icon-sun" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="display:none"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke-linecap="round"/></svg>
    </button>
    <div id="nav-user"></div>
  </div>
</header>
<main>
  <div id="alert"></div>

  <!-- AUTH SECTION -->
  <div id="section-auth">
    <div class="auth-wrap">
      <div class="tabs">
        <div class="tab active" id="tab-login" onclick="switchTab('login')">Sign in</div>
        <div class="tab" id="tab-signup" onclick="switchTab('signup')">Create account</div>
      </div>

      <div class="card" id="form-login">
        <div class="card-title">Welcome back</div>
        <div class="card-desc">Sign in to access your files.</div>
        <div class="field"><label>Username or Email</label><input id="li-user" type="text" placeholder="you@example.com" autocomplete="username"/></div>
        <div class="field"><label>Password</label><input id="li-pass" type="password" placeholder="••••••••" autocomplete="current-password"/></div>
        <button class="btn btn-full" onclick="doLogin()">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Sign in
        </button>
      </div>

      <div class="card" id="form-signup" style="display:none">
        <div class="card-title">Create your account</div>
        <div class="card-desc">It only takes a moment to get started.</div>
        <div class="field"><label>Username</label><input id="su-user" type="text" placeholder="yourname" autocomplete="username"/></div>
        <div class="field"><label>Email address</label><input id="su-email" type="email" placeholder="you@example.com" autocomplete="email"/></div>
        <div class="field"><label>Password</label><input id="su-pass" type="password" placeholder="At least 8 characters" autocomplete="new-password"/></div>
        <div class="field"><label>Confirm password</label><input id="su-pass2" type="password" placeholder="Repeat password" autocomplete="new-password"/></div>
        <button class="btn btn-full" onclick="doSignup()">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8zM19 8v6M22 11h-6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Create account
        </button>
      </div>
    </div>
  </div>

  <!-- PORTAL SECTION -->
  <div id="section-portal">
    <div class="tabs">
      <div class="tab active" id="ptab-files" onclick="showPane('files')">
        My Files
      </div>
      <div class="tab" id="ptab-send" onclick="showPane('send')">
        Secure Send
      </div>
    </div>

    <!-- My Files pane -->
    <div id="pane-files">
      <div class="card" style="margin-bottom:20px">
        <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-input').click()">
          <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
            <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12M8 8l4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <p>Drop files here, or click to browse</p>
          <div class="hint">Any file type &nbsp;·&nbsp; Multiple files supported</div>
        </div>
        <input id="file-input" type="file" multiple style="display:none" onchange="uploadFiles(this.files)"/>
        <progress id="upload-progress" value="0" max="100"></progress>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom:20px">Your Files</div>
        <div class="file-table-wrap">
          <div id="file-list">
            <div class="empty-state">
              <svg width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.3" viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M13 2v7h7"/></svg>
              <p>No files yet — upload something above</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Secure Send pane -->
    <div id="pane-send" style="display:none">
      <div class="card">
        <div class="card-title">Secure Send</div>
        <div class="card-desc">
          Send a file to anyone with a one-time password-protected link. Once they download it, the link is gone for good.
        </div>

        <div class="field">
          <label>Choose a file to send</label>
          <div class="drop-zone" id="share-drop" style="padding:28px;margin-bottom:0" onclick="document.getElementById('share-file-input').click()">
            <svg width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83l8.49-8.48" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <p id="share-file-name">Click to choose a file</p>
          </div>
          <input id="share-file-input" type="file" style="display:none" onchange="shareFileSelected(this)"/>
        </div>

        <hr/>

        <div class="field"><label>Password &nbsp;<span style="font-weight:400;color:var(--muted2)">(the recipient will need to enter this)</span></label><input id="share-pw" type="password" placeholder="Choose a strong password"/></div>
        <div class="field"><label>Recipient email &nbsp;<span style="font-weight:400;color:var(--muted2)">(optional)</span></label><input id="share-email" type="email" placeholder="recipient@example.com"/></div>
        <div class="field"><label>Link expires on &nbsp;<span style="font-weight:400;color:var(--muted2)">(optional)</span></label><input id="share-exp" type="date"/></div>
        <div class="field">
          <label>How many times can this link be downloaded?</label>
          <select id="share-max-views" style="width:100%;background:var(--input-bg);border:1px solid var(--border2);color:var(--text);padding:11px 15px;border-radius:10px;font-size:.92rem;font-family:inherit;outline:none;cursor:pointer">
            <option value="1">1 time (one-time link)</option>
            <option value="2">2 times</option>
            <option value="3">3 times</option>
            <option value="5">5 times</option>
            <option value="10">10 times</option>
            <option value="999">Unlimited</option>
          </select>
        </div>

        <button class="btn" onclick="createShare()">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Generate secure link
        </button>
        <progress id="share-progress" value="0" max="100"></progress>

        <div id="share-result" style="display:none" class="share-box">
          <div class="share-box-label">Your one-time link is ready</div>
          <div class="share-url-row">
            <span id="share-url" class="share-url"></span>
            <button class="btn btn-sm" onclick="copyShare()">Copy link</button>
          </div>
          <p id="share-uses-label" style="font-size:.78rem;color:var(--muted);margin-top:10px">This link allows 1 download.</p>
        </div>
      </div>
    </div>
  </div>
</main>

<script src="/app.js"></script>
</body>
</html>`;
}

function renderViewPage(token) {
  const safeToken = token.replace(/[^a-zA-Z0-9_-]/g, '');
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Linear Tech · Secure File</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root,[data-theme="dark"]{
  --bg:#0f1117;--bg2:#1a1d27;--text:#eef0f6;--muted:#7c85a2;
  --accent:#4f7ef8;--accent-h:#3b6cf5;--accent-bg:rgba(79,126,248,.12);
  --border:#2a2f45;--border2:#353b56;--card:#181c2a;
  --danger:#f06464;--danger-bg:rgba(240,100,100,.12);
  --success:#4ade80;--success-bg:rgba(74,222,128,.12);
  --input-bg:#0f1117;--shadow:0 2px 16px rgba(0,0,0,.4);
}
[data-theme="light"]{
  --bg:#f4f6fb;--bg2:#ffffff;--text:#1a1d2e;--muted:#5a6080;
  --accent:#3b6cf5;--accent-h:#2955d8;--accent-bg:rgba(59,108,245,.08);
  --border:#dde1ee;--border2:#c8cee0;--card:#ffffff;
  --danger:#e03e3e;--danger-bg:rgba(224,62,62,.08);
  --success:#16a34a;--success-bg:rgba(22,163,74,.08);
  --input-bg:#f4f6fb;--shadow:0 2px 16px rgba(0,0,0,.08);
}
body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;transition:background .2s,color .2s}
header{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 28px;height:64px;display:flex;align-items:center;justify-content:space-between;box-shadow:var(--shadow)}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:32px;height:32px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center}
.logo-icon svg{width:18px;height:18px;stroke:#fff;fill:none;stroke-width:2}
.logo-text{font-size:1.05rem;font-weight:700;color:var(--text)}
.logo-text span{color:var(--accent)}
#theme-toggle{background:transparent;border:1px solid var(--border);color:var(--muted);width:36px;height:36px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center}
#theme-toggle:hover{border-color:var(--accent);color:var(--accent)}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:40px 36px;max-width:440px;width:100%;text-align:center;box-shadow:var(--shadow)}
.lock-ring{width:72px;height:72px;background:var(--accent-bg);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 24px}
h2{font-size:1.4rem;font-weight:700;margin-bottom:8px}
.desc{color:var(--muted);font-size:.88rem;margin-bottom:28px;line-height:1.6}
input[type=password]{width:100%;background:var(--input-bg);border:1px solid var(--border2);color:var(--text);
  padding:12px 15px;border-radius:10px;font-size:.92rem;outline:none;font-family:inherit;
  margin-bottom:14px;display:block;text-align:left;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.btn{width:100%;background:var(--accent);color:#fff;border:none;padding:12px;border-radius:10px;cursor:pointer;font-size:.95rem;font-weight:600;font-family:inherit;transition:all .15s}
.btn:hover{background:var(--accent-h);transform:translateY(-1px);box-shadow:0 4px 14px rgba(79,126,248,.35)}
#msg{margin-top:18px;font-size:.88rem;display:none;padding:12px 16px;border-radius:10px;text-align:left}
.err{background:var(--danger-bg);border:1px solid var(--danger);color:var(--danger)}
.ok{background:var(--success-bg);border:1px solid var(--success);color:var(--success)}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 2v7h7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
    <span class="logo-text">Linear<span>Tech</span> Files</span>
  </div>
  <button id="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark">
    <svg id="icon-moon" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <svg id="icon-sun" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="display:none"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke-linecap="round"/></svg>
  </button>
</header>
<main>
<div class="card">
  <div class="lock-ring">
    <svg width="32" height="32" fill="none" stroke="var(--accent)" stroke-width="2" viewBox="0 0 24 24">
      <rect x="5" y="11" width="14" height="10" rx="2"/>
      <path d="M8 11V7a4 4 0 018 0v4" stroke-linecap="round"/>
    </svg>
  </div>
  <h2>Secure File</h2>
  <p class="desc">Someone shared a file with you. Enter the password to download it. This link works <strong>one time only</strong>.</p>
  <input type="password" id="pw" placeholder="Enter the password" autofocus/>
  <button class="btn" onclick="unlock()">Download file</button>
  <div id="msg"></div>
</div>
</main>
<script>
var TOKEN = ${JSON.stringify(safeToken)};
function toggleTheme() {
  var t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('icon-moon').style.display = t === 'dark' ? 'block' : 'none';
  document.getElementById('icon-sun').style.display = t === 'light' ? 'block' : 'none';
  try { localStorage.setItem('theme', t); } catch(e) {}
}
(function() {
  var saved = null; try { saved = localStorage.getItem('theme'); } catch(e) {}
  var t = saved || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  if (t === 'light') { document.getElementById('icon-moon').style.display = 'none'; document.getElementById('icon-sun').style.display = 'block'; }
})();
async function unlock() {
  var pw = document.getElementById('pw').value;
  if (!pw) return;
  var msg = document.getElementById('msg');
  msg.style.display = 'none';
  var r = await fetch('/api/share/view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, password: pw })
  });
  if (!r.ok) {
    var data = await r.json().catch(function() { return {}; });
    msg.className = 'err';
    msg.textContent = data.error || 'Incorrect password or link already used.';
    msg.style.display = 'block';
    return;
  }
  msg.className = 'ok';
  msg.textContent = 'Downloading… this link is now burned.';
  msg.style.display = 'block';
  var blob = await r.blob();
  var blobUrl = URL.createObjectURL(blob);
  var cd = r.headers.get('content-disposition') || '';
  var m = cd.match(/filename="([^"]+)"/);
  var filename = m ? m[1] : 'file';
  var a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 10000);
}
document.getElementById('pw').addEventListener('keydown', function(e) { if (e.key === 'Enter') unlock(); });
</script>
</body>
</html>`;
}

/* ================================================================
 * Client-side JavaScript — served as /app.js
 * ================================================================ */
function clientScript() {
  return [
    'var SESSION = null;',
    'var CURRENT_USER = null;',
    '',
    'function lsGet(k) { try { return localStorage.getItem(k); } catch(e) { return null; } }',
    '',
    'function toggleTheme() {',
    '  var t = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";',
    '  document.documentElement.setAttribute("data-theme", t);',
    '  document.getElementById("icon-moon").style.display = t === "dark" ? "block" : "none";',
    '  document.getElementById("icon-sun").style.display = t === "light" ? "block" : "none";',
    '  lsSet("theme", t);',
    '}',
    '(function() {',
    '  var t = lsGet("theme") || "dark";',
    '  document.documentElement.setAttribute("data-theme", t);',
    '  if (t === "light") {',
    '    var m = document.getElementById("icon-moon"); if (m) m.style.display = "none";',
    '    var s = document.getElementById("icon-sun"); if (s) s.style.display = "block";',
    '  }',
    '})();',
    'function lsSet(k,v) { try { localStorage.setItem(k,v); } catch(e) {} }',
    'function lsDel(k) { try { localStorage.removeItem(k); } catch(e) {} }',
    '',
    'async function api(path, opts) {',
    '  if (!opts) opts = {};',
    '  if (!opts.headers) opts.headers = {};',
    '  if (SESSION) opts.headers["Authorization"] = "Bearer " + SESSION;',
    '  var r = await fetch(path, opts);',
    '  var ct = r.headers.get("content-type") || "";',
    '  var data = ct.indexOf("application/json") >= 0 ? await r.json() : {};',
    '  return { ok: r.ok, status: r.status, data: data };',
    '}',
    '',
    'function showAlert(msg, type) {',
    '  if (!type) type = "err";',
    '  var el = document.getElementById("alert");',
    '  el.textContent = msg;',
    '  el.className = type === "ok" ? "alert-ok" : "alert-err";',
    '  el.style.display = "block";',
    '  setTimeout(function() { el.style.display = "none"; }, 5000);',
    '}',
    '',
    'function showSection(id) {',
    '  document.getElementById("section-auth").style.display = "none";',
    '  document.getElementById("section-portal").style.display = "none";',
    '  document.getElementById(id).style.display = "block";',
    '}',
    '',
    'function showAuth() {',
    '  SESSION = null; CURRENT_USER = null; lsDel("sess");',
    '  document.getElementById("nav-user").innerHTML = "";',
    '  showSection("section-auth");',
    '}',
    '',
    'function showPortal(user) {',
    '  CURRENT_USER = user;',
    '  var name = user && user.username ? user.username : "";',
    '  document.getElementById("nav-user").innerHTML =',
    '    "<span>" + name + "</span>" +',
    '    "<button onclick=\\"doLogout()\\">Sign out</button>";',
    '  showSection("section-portal");',
    '  loadFiles();',
    '}',
    '',
    'function switchTab(tab) {',
    '  document.getElementById("form-login").style.display = tab === "login" ? "block" : "none";',
    '  document.getElementById("form-signup").style.display = tab === "signup" ? "block" : "none";',
    '  document.getElementById("tab-login").className = "tab" + (tab === "login" ? " active" : "");',
    '  document.getElementById("tab-signup").className = "tab" + (tab === "signup" ? " active" : "");',
    '}',
    '',
    'function showPane(pane) {',
    '  document.getElementById("pane-files").style.display = pane === "files" ? "block" : "none";',
    '  document.getElementById("pane-send").style.display = pane === "send" ? "block" : "none";',
    '  document.getElementById("ptab-files").className = "tab" + (pane === "files" ? " active" : "");',
    '  document.getElementById("ptab-send").className = "tab" + (pane === "send" ? " active" : "");',
    '}',
    '',
    'async function doSignup() {',
    '  var u = document.getElementById("su-user").value.trim();',
    '  var e = document.getElementById("su-email").value.trim();',
    '  var p = document.getElementById("su-pass").value;',
    '  var p2 = document.getElementById("su-pass2").value;',
    '  if (!u || !e || !p) return showAlert("All fields required");',
    '  if (p !== p2) return showAlert("Passwords do not match");',
    '  var r = await api("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, email: e, password: p }) });',
    '  if (!r.ok) return showAlert(r.data.error || "Signup failed");',
    '  SESSION = r.data.token; lsSet("sess", SESSION);',
    '  showPortal(r.data.user);',
    '}',
    '',
    'async function doLogin() {',
    '  var u = document.getElementById("li-user").value.trim();',
    '  var p = document.getElementById("li-pass").value;',
    '  if (!u || !p) return showAlert("Username and password required");',
    '  var r = await api("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }) });',
    '  if (!r.ok) return showAlert(r.data.error || "Login failed");',
    '  SESSION = r.data.token; lsSet("sess", SESSION);',
    '  showPortal(r.data.user);',
    '}',
    '',
    'async function doLogout() {',
    '  await api("/api/logout", { method: "POST" });',
    '  lsDel("sess"); showAuth();',
    '}',
    '',
    'async function loadFiles() {',
    '  var r = await api("/api/files");',
    '  var el = document.getElementById("file-list");',
    '  if (!r.ok) { el.innerHTML = "<p style=\'color:var(--muted)\'>Failed to load files.</p>"; return; }',
    '  var files = r.data.files || [];',
    '  if (!files.length) { el.innerHTML = "<p style=\'color:var(--muted);margin-top:12px\'>No files yet — upload something above.</p>"; return; }',
    '  var rows = "";',
    '  for (var i = 0; i < files.length; i++) {',
    '    var f = files[i];',
    '    rows += "<tr>" +',
    '      "<td><div class=\'file-name\'>" + esc(f.name) + "</div><div class=\'file-size\'>" + fmtSize(f.size) + "</div></td>" +',
    '      "<td style=\'color:var(--muted);font-size:.8rem\'>" + (f.created_at ? f.created_at.slice(0,10) : "") + "</td>" +',
    '      "<td><div class=\'actions\'>" +',
    '        "<button class=\'btn btn-sm btn-ghost\' onclick=\'downloadFile(" + f.id + ")\'>Download</button>" +',
    '        "<button class=\'btn btn-sm btn-danger\' onclick=\'deleteFile(" + f.id + ")\'>Delete</button>" +',
    '      "</div></td></tr>";',
    '  }',
    '  el.innerHTML = "<table><thead><tr><th>Name</th><th>Uploaded</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>";',
    '}',
    '',
    'async function uploadFiles(files) {',
    '  if (!files || !files.length) return;',
    '  var prog = document.getElementById("upload-progress");',
    '  prog.style.display = "block"; prog.value = 0;',
    '  for (var i = 0; i < files.length; i++) {',
    '    var fd = new FormData();',
    '    fd.append("file", files[i]);',
    '    var r = await api("/api/files/upload", { method: "POST", body: fd });',
    '    if (!r.ok) { showAlert("Upload failed: " + (r.data.error || "unknown error")); }',
    '    prog.value = Math.round((i + 1) / files.length * 100);',
    '  }',
    '  prog.style.display = "none";',
    '  showAlert("Upload complete!", "ok");',
    '  loadFiles();',
    '}',
    '',
    'async function downloadFile(id) {',
    '  var headers = {};',
    '  if (SESSION) headers["Authorization"] = "Bearer " + SESSION;',
    '  var r = await fetch("/api/files/download?id=" + id, { headers: headers });',
    '  if (!r.ok) { var d = await r.json().catch(function() { return {}; }); return showAlert(d.error || "Download failed"); }',
    '  var blob = await r.blob();',
    '  var blobUrl = URL.createObjectURL(blob);',
    '  var cd = r.headers.get("content-disposition") || "";',
    '  var m = cd.match(/filename="([^"]+)"/);',
    '  var filename = m ? m[1] : "file";',
    '  var a = document.createElement("a");',
    '  a.href = blobUrl; a.download = filename;',
    '  document.body.appendChild(a); a.click(); document.body.removeChild(a);',
    '  setTimeout(function() { URL.revokeObjectURL(blobUrl); }, 10000);',
    '}',
    '',
    'async function deleteFile(id) {',
    '  if (!confirm("Delete this file? This cannot be undone.")) return;',
    '  var r = await api("/api/files/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id }) });',
    '  if (!r.ok) return showAlert(r.data.error || "Delete failed");',
    '  showAlert("File deleted.", "ok"); loadFiles();',
    '}',
    '',
    '(function setupDrop() {',
    '  var zone = document.getElementById("drop-zone");',
    '  if (!zone) return;',
    '  zone.addEventListener("dragover", function(e) { e.preventDefault(); zone.classList.add("over"); });',
    '  zone.addEventListener("dragleave", function() { zone.classList.remove("over"); });',
    '  zone.addEventListener("drop", function(e) {',
    '    e.preventDefault(); zone.classList.remove("over");',
    '    uploadFiles(e.dataTransfer.files);',
    '  });',
    '})();',
    '',
    'var SHARE_FILE = null;',
    'function shareFileSelected(input) {',
    '  SHARE_FILE = input.files[0] || null;',
    '  document.getElementById("share-file-name").textContent = SHARE_FILE ? SHARE_FILE.name : "Click to choose a file";',
    '}',
    '',
    'async function createShare() {',
    '  if (!SHARE_FILE) return showAlert("Please choose a file");',
    '  var pw = document.getElementById("share-pw").value;',
    '  if (!pw) return showAlert("Password is required");',
    '  var email = document.getElementById("share-email").value;',
    '  var exp = document.getElementById("share-exp").value;',
    '  var maxViews = document.getElementById("share-max-views").value;',
    '  var prog = document.getElementById("share-progress");',
    '  prog.style.display = "block"; prog.value = 50;',
    '  var fd = new FormData();',
    '  fd.append("file", SHARE_FILE);',
    '  fd.append("password", pw);',
    '  fd.append("max_views", maxViews);',
    '  if (email) fd.append("recipient_email", email);',
    '  if (exp) fd.append("expires_at", exp);',
    '  var r = await api("/api/share/create", { method: "POST", body: fd });',
    '  prog.style.display = "none";',
    '  if (!r.ok) return showAlert(r.data.error || "Failed to create share link");',
    '  var link = window.location.origin + "/view/" + r.data.token;',
    '  document.getElementById("share-url").textContent = link;',
    '  var usesLabel = maxViews === "999" ? "unlimited downloads" : (maxViews === "1" ? "1 download" : maxViews + " downloads");',
    '  document.getElementById("share-uses-label").textContent = "This link allows " + usesLabel + ".";',
    '  document.getElementById("share-result").style.display = "block";',
    '}',
    '',
    'function copyShare() {',
    '  var url = document.getElementById("share-url").textContent;',
    '  navigator.clipboard.writeText(url).then(function() {',
    '    showAlert("Link copied!", "ok");',
    '  }).catch(function() {',
    '    showAlert("Copy failed — select the link manually");',
    '  });',
    '}',
    '',
    'function esc(s) {',
    '  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");',
    '}',
    '',
    'function fmtSize(b) {',
    '  if (!b) return "0 B";',
    '  var units = ["B","KB","MB","GB"];',
    '  var i = 0;',
    '  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }',
    '  return b.toFixed(i ? 1 : 0) + " " + units[i];',
    '}',
    '',
    '(async function init() {',
    '  var saved = lsGet("sess");',
    '  if (saved) {',
    '    SESSION = saved;',
    '    var r = await api("/api/me");',
    '    if (r.ok) { showPortal(r.data); return; }',
    '    lsDel("sess"); SESSION = null;',
    '  }',
    '  showAuth();',
    '})();'
  ].join('\n');
}

/* ================================================================
 * API handlers
 * ================================================================ */

// ── Signup ────────────────────────────────────────────────────────
async function signup(request, env) {
  const { username, email, password } = await request.json();
  if (!username || !email || !password) return json({ error: 'All fields required' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);

  const { hash, salt } = await hashPassword(password);
  try {
    const row = await env.DB.prepare(
      'INSERT INTO users (username, email, pw_hash, pw_salt) VALUES (?,?,?,?) RETURNING id, username, email'
    ).bind(username.trim(), email.trim().toLowerCase(), hash, salt).first();

    const token = await makeSessionToken(env, row.id);
    return json({ token, user: { id: row.id, username: row.username, email: row.email } });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return json({ error: 'Username or email already taken' }, 409);
    throw e;
  }
}

// ── Login ─────────────────────────────────────────────────────────
async function loginUser(request, env) {
  const { username, password } = await request.json();
  if (!username || !password) return json({ error: 'Username and password required' }, 400);

  const row = await env.DB.prepare(
    'SELECT id, username, email, pw_hash, pw_salt FROM users WHERE username=? OR email=?'
  ).bind(username.trim(), username.trim().toLowerCase()).first();

  if (!row) return json({ error: 'Invalid username or password' }, 401);
  const ok = await verifyPassword(password, row.pw_hash, row.pw_salt);
  if (!ok) return json({ error: 'Invalid username or password' }, 401);

  const token = await makeSessionToken(env, row.id);
  return json({ token, user: { id: row.id, username: row.username, email: row.email } });
}

// ── Logout ────────────────────────────────────────────────────────
async function logout(request, env) {
  const token = getBearerToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run().catch(() => {});
  return json({ ok: true });
}

// ── Me ────────────────────────────────────────────────────────────
async function me(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  return json({ id: user.id, username: user.username, email: user.email });
}

// ── List files ────────────────────────────────────────────────────
async function listFiles(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);
  const rows = await env.DB.prepare(
    'SELECT id, name, size, mime, created_at FROM files WHERE user_id=? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return json({ files: rows.results || [] });
}

// ── Upload file ───────────────────────────────────────────────────
async function uploadFile(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400);

  const r2Key = `users/${user.id}/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
  await env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' }
  });

  await env.DB.prepare(
    'INSERT INTO files (user_id, r2_key, name, size, mime) VALUES (?,?,?,?,?)'
  ).bind(user.id, r2Key, file.name, file.size, file.type || null).run();

  return json({ ok: true });
}

// ── Download file (stream directly from R2) ───────────────────────
async function downloadFile(request, env, url) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(url.searchParams.get('id'));
  const row = await env.DB.prepare(
    'SELECT r2_key, name, mime FROM files WHERE id=? AND user_id=?'
  ).bind(id, user.id).first();
  if (!row) return json({ error: 'File not found' }, 404);

  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return json({ error: 'File not found in storage' }, 404);

  const safeName = row.name.replace(/"/g, '');
  return corsHeaders(new Response(obj.body, {
    headers: {
      'Content-Type': row.mime || obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + safeName + '"',
    }
  }));
}

// ── Delete file ───────────────────────────────────────────────────
async function deleteFile(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { id } = await request.json();
  const row = await env.DB.prepare(
    'SELECT r2_key FROM files WHERE id=? AND user_id=?'
  ).bind(id, user.id).first();
  if (!row) return json({ error: 'File not found' }, 404);

  await env.FILES.delete(row.r2_key);
  await env.DB.prepare('DELETE FROM files WHERE id=?').bind(id).run();
  return json({ ok: true });
}

// ── Create share ──────────────────────────────────────────────────
async function createShare(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const form = await request.formData();
  const file = form.get('file');
  const password = form.get('password');
  const recipientEmail = form.get('recipient_email') || null;
  const expiresAt = form.get('expires_at') || null;
  const maxViewsRaw = parseInt(form.get('max_views') || '1', 10);
  const maxViews = (!maxViewsRaw || maxViewsRaw < 1) ? 1 : Math.min(maxViewsRaw, 999);

  if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400);
  if (!password) return json({ error: 'Password required' }, 400);

  // Store the file in R2 under shares/
  const r2Key = `shares/${user.id}/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
  await env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' }
  });

  // Save the file record (owned by the sender)
  const fileRow = await env.DB.prepare(
    'INSERT INTO files (user_id, r2_key, name, size, mime) VALUES (?,?,?,?,?) RETURNING id'
  ).bind(user.id, r2Key, file.name, file.size, file.type || null).first();

  const { hash, salt } = await hashPassword(password);
  const token = crypto.randomUUID().replace(/-/g, '');

  await env.DB.prepare(
    'INSERT INTO shares (token, file_id, pw_hash, pw_salt, recipient_email, expires_at, max_views) VALUES (?,?,?,?,?,?,?)'
  ).bind(token, fileRow.id, hash, salt, recipientEmail, expiresAt || null, maxViews).run();

  return json({ token });
}

// ── View share (burn after first successful view) ──────────────────
async function viewShare(request, env, ctx) {
  const { token, password } = await request.json();
  if (!token || !password) return json({ error: 'Token and password required' }, 400);

  const share = await env.DB.prepare(
    `SELECT s.id, s.token, s.pw_hash, s.pw_salt, s.viewed, s.max_views, s.expires_at,
            f.r2_key, f.name
     FROM shares s JOIN files f ON f.id = s.file_id
     WHERE s.token=?`
  ).bind(token).first();

  if (!share) return json({ error: 'Link not found or already used' }, 404);
  if (share.viewed >= share.max_views) return json({ error: 'This link has reached its download limit' }, 410);
  if (share.expires_at && new Date(share.expires_at) < new Date()) return json({ error: 'This link has expired' }, 410);

  const ok = await verifyPassword(password, share.pw_hash, share.pw_salt);
  if (!ok) return json({ error: 'Incorrect password' }, 401);

  // Fetch the R2 object BEFORE burning the link so a storage failure
  // doesn't permanently destroy access.
  const obj = await env.FILES.get(share.r2_key);
  if (!obj) return json({ error: 'File not found in storage' }, 404);

  // Atomically increment the view counter — if another request beat us to the limit, bail
  const result = await env.DB.prepare(
    'UPDATE shares SET viewed=viewed+1 WHERE id=? AND viewed<max_views'
  ).bind(share.id).run();

  if (result.meta && result.meta.changes === 0) {
    return json({ error: 'This link has reached its download limit' }, 410);
  }

  const newViewed = share.viewed + 1;
  // Clean up R2 only when the last allowed download is used
  if (newViewed >= share.max_views) {
    if (ctx && ctx.waitUntil) ctx.waitUntil(env.FILES.delete(share.r2_key).catch(() => {}));
  }

  const safeName = share.name.replace(/"/g, '');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + safeName + '"',
    }
  });
}

// ── Cron: purge expired shares + burned shares older than 7 days ───
async function purgeExpired(env) {
  const now = new Date().toISOString().slice(0, 10);
  // Get R2 keys to delete
  const expired = await env.DB.prepare(
    `SELECT f.r2_key FROM shares s JOIN files f ON f.id=s.file_id
     WHERE s.viewed=1 OR (s.expires_at IS NOT NULL AND s.expires_at < ?)`
  ).bind(now).all();

  for (const row of (expired.results || [])) {
    await env.FILES.delete(row.r2_key).catch(() => {});
  }

  await env.DB.prepare(
    `DELETE FROM shares WHERE viewed=1 OR (expires_at IS NOT NULL AND expires_at < ?)`
  ).bind(now).run();
}

/* ================================================================
 * Auth helpers
 * ================================================================ */
async function hashPassword(password) {
  const salt = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', enc(password + salt), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(salt), iterations: 100000 }, key, 256);
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return { hash, salt };
}

async function verifyPassword(password, hash, salt) {
  const key = await crypto.subtle.importKey('raw', enc(password + salt), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(salt), iterations: 100000 }, key, 256);
  const candidate = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return candidate === hash;
}

async function makeSessionToken(env, userId) {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').bind(token, userId, expiresAt).run();
  return token;
}

async function requireAuth(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at > datetime("now")'
  ).bind(token).first();
  return row || null;
}

function getBearerToken(request) {
  return (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim() || null;
}

/* ================================================================
 * Misc helpers
 * ================================================================ */
const enc = s => new TextEncoder().encode(s);
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function corsHeaders(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  return new Response(res.body, { status: res.status, headers: h });
}

function htmlResponse(html) {
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function sanitizeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}
