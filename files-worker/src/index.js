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
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Linear Tech · File Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --navy:#0a1628;--navy2:#12223f;--accent:#2563eb;--accent2:#1d4ed8;
  --text:#e8edf5;--muted:#8fa3bf;--border:#1e3358;--card:#0f1e38;
  --danger:#ef4444;--success:#22c55e;
}
body{font-family:'Inter',sans-serif;background:var(--navy);color:var(--text);min-height:100vh}
header{background:var(--navy2);border-bottom:1px solid var(--border);padding:0 24px;height:60px;display:flex;align-items:center;justify-content:space-between}
header h1{font-family:'DM Serif Display',serif;font-size:1.4rem;color:#fff;letter-spacing:.02em}
header h1 span{color:var(--accent);font-family:'Inter',sans-serif;font-weight:600;font-size:.75rem;vertical-align:super;margin-left:4px}
#nav-user{display:flex;align-items:center;gap:12px;font-size:.85rem;color:var(--muted)}
#nav-user button{background:transparent;border:1px solid var(--border);color:var(--muted);padding:4px 12px;border-radius:6px;cursor:pointer;font-size:.8rem}
#nav-user button:hover{border-color:var(--accent);color:var(--text)}
main{max-width:860px;margin:0 auto;padding:32px 20px}
h2{font-family:'DM Serif Display',serif;font-size:1.5rem;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
.field{margin-bottom:16px}
label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:6px;font-weight:500}
input[type=text],input[type=email],input[type=password],input[type=date]{
  width:100%;background:#0a1628;border:1px solid var(--border);color:var(--text);
  padding:10px 14px;border-radius:8px;font-size:.9rem;outline:none
}
input:focus{border-color:var(--accent)}
.btn{display:inline-block;background:var(--accent);color:#fff;border:none;padding:10px 22px;
  border-radius:8px;cursor:pointer;font-size:.9rem;font-weight:500;transition:background .15s}
.btn:hover{background:var(--accent2)}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--muted)}
.btn-ghost:hover{border-color:var(--accent);color:var(--text)}
.btn-danger{background:var(--danger)}
.btn-danger:hover{background:#dc2626}
.btn-sm{padding:6px 14px;font-size:.8rem}
.tabs{display:flex;gap:4px;margin-bottom:24px}
.tab{padding:8px 18px;border-radius:8px;cursor:pointer;font-size:.88rem;color:var(--muted);border:1px solid transparent}
.tab.active{background:var(--accent);color:#fff}
.tab:hover:not(.active){border-color:var(--border);color:var(--text)}
#alert{padding:12px 16px;border-radius:8px;margin-bottom:20px;display:none;font-size:.88rem}
.alert-err{background:#1e0a0a;border:1px solid #7f1d1d;color:#fca5a5}
.alert-ok{background:#052e16;border:1px solid #14532d;color:#86efac}
table{width:100%;border-collapse:collapse;font-size:.87rem}
th{text-align:left;padding:10px 12px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:none}
.file-name{font-weight:500;word-break:break-all}
.file-size{color:var(--muted);font-size:.8rem}
.actions{display:flex;gap:8px;justify-content:flex-end}
.drop-zone{border:2px dashed var(--border);border-radius:10px;padding:40px;text-align:center;
  color:var(--muted);cursor:pointer;transition:border-color .2s,background .2s;margin-bottom:20px}
.drop-zone:hover,.drop-zone.over{border-color:var(--accent);background:#0d1f3c}
.drop-zone p{margin-top:8px;font-size:.85rem}
.share-box{background:#0a1628;border:1px solid var(--border);border-radius:8px;padding:14px;margin-top:14px}
.share-url{font-size:.8rem;color:var(--accent);word-break:break-all}
.copy-btn{margin-left:8px;padding:3px 10px;font-size:.75rem}
progress{width:100%;height:6px;border-radius:3px;appearance:none;margin-top:12px;display:none}
progress::-webkit-progress-bar{background:var(--border);border-radius:3px}
progress::-webkit-progress-value{background:var(--accent);border-radius:3px}
#section-auth,#section-portal{display:none}
.spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);
  border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<header>
  <h1>Linear Tech <span>FILES</span></h1>
  <div id="nav-user"></div>
</header>
<main>
  <div id="alert"></div>

  <!-- AUTH SECTION -->
  <div id="section-auth">
    <div class="tabs">
      <div class="tab active" id="tab-login" onclick="switchTab('login')">Sign in</div>
      <div class="tab" id="tab-signup" onclick="switchTab('signup')">Create account</div>
    </div>
    <div class="card" id="form-login">
      <h2>Sign in</h2>
      <div class="field"><label>Username or Email</label><input id="li-user" type="text" autocomplete="username"/></div>
      <div class="field"><label>Password</label><input id="li-pass" type="password" autocomplete="current-password"/></div>
      <button class="btn" onclick="doLogin()">Sign in</button>
    </div>
    <div class="card" id="form-signup" style="display:none">
      <h2>Create account</h2>
      <div class="field"><label>Username</label><input id="su-user" type="text" autocomplete="username"/></div>
      <div class="field"><label>Email</label><input id="su-email" type="email" autocomplete="email"/></div>
      <div class="field"><label>Password</label><input id="su-pass" type="password" autocomplete="new-password"/></div>
      <div class="field"><label>Confirm password</label><input id="su-pass2" type="password" autocomplete="new-password"/></div>
      <button class="btn" onclick="doSignup()">Create account</button>
    </div>
  </div>

  <!-- PORTAL SECTION -->
  <div id="section-portal">
    <div class="tabs">
      <div class="tab active" id="ptab-files" onclick="showPane('files')">My Files</div>
      <div class="tab" id="ptab-send" onclick="showPane('send')">Secure Send</div>
    </div>

    <!-- My Files pane -->
    <div id="pane-files">
      <div class="card" style="margin-bottom:20px">
        <div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-input').click()">
          <svg width="36" height="36" fill="none" stroke="#8fa3bf" stroke-width="1.5" viewBox="0 0 24 24">
            <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 0L8 8m4-4 4 4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <p>Click or drag files here to upload</p>
        </div>
        <input id="file-input" type="file" multiple style="display:none" onchange="uploadFiles(this.files)"/>
        <progress id="upload-progress" value="0" max="100"></progress>
      </div>
      <div class="card">
        <h2>Your Files</h2>
        <div id="file-list"><p style="color:var(--muted);margin-top:12px">Loading…</p></div>
      </div>
    </div>

    <!-- Secure Send pane -->
    <div id="pane-send" style="display:none">
      <div class="card">
        <h2>Secure Send</h2>
        <p style="color:var(--muted);font-size:.88rem;margin-bottom:20px">
          Upload a file, set a password, and get a one-time link. The recipient enters the password and can view it once — the link is then permanently burned.
        </p>
        <div class="field"><label>File</label>
          <div class="drop-zone" id="share-drop" style="padding:24px" onclick="document.getElementById('share-file-input').click()">
            <p id="share-file-name">Click to choose a file</p>
          </div>
          <input id="share-file-input" type="file" style="display:none" onchange="shareFileSelected(this)"/>
        </div>
        <div class="field"><label>Password (recipient must enter this)</label><input id="share-pw" type="password"/></div>
        <div class="field"><label>Recipient Email (optional — shown on download page)</label><input id="share-email" type="email"/></div>
        <div class="field"><label>Expires (optional)</label><input id="share-exp" type="date"/></div>
        <button class="btn" onclick="createShare()">Generate one-time link</button>
        <div id="share-result" style="display:none" class="share-box">
          <p style="font-size:.8rem;color:var(--muted);margin-bottom:6px">One-time link (share this):</p>
          <span id="share-url" class="share-url"></span>
          <button class="btn btn-sm copy-btn" onclick="copyShare()">Copy</button>
        </div>
        <progress id="share-progress" value="0" max="100"></progress>
      </div>
    </div>
  </div>
</main>

<script>
const API = '';   // same origin
let SESSION = localStorage.getItem('lt_session') || '';
let CURRENT_USER = null;

// ── Init ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  if (SESSION) {
    const r = await api('GET', '/api/me');
    if (r.ok) {
      CURRENT_USER = r.data;
      showPortal();
      return;
    }
    SESSION = '';
    localStorage.removeItem('lt_session');
  }
  showAuth();
});

// ── Helpers ──────────────────────────────────────────────────────
async function api(method, path, body, onProgress) {
  const opts = { method, headers: {} };
  if (SESSION) opts.headers['Authorization'] = 'Bearer ' + SESSION;
  if (body instanceof FormData) {
    // XHR for progress
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, path);
      if (SESSION) xhr.setRequestHeader('Authorization', 'Bearer ' + SESSION);
      xhr.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total * 100);
      xhr.onload = () => {
        try { resolve({ ok: xhr.status < 300, data: JSON.parse(xhr.responseText) }); }
        catch { resolve({ ok: false, data: {} }); }
      };
      xhr.onerror = () => resolve({ ok: false, data: { error: 'Network error' } });
      xhr.send(body);
    });
  }
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function showAlert(msg, type='err') {
  const el = document.getElementById('alert');
  el.className = 'alert-' + (type === 'ok' ? 'ok' : 'err');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', 6000);
}

function showSection(id) {
  ['section-auth','section-portal'].forEach(s => document.getElementById(s).style.display = 'none');
  document.getElementById(id).style.display = 'block';
}

function showAuth()   { showSection('section-auth'); }
function showPortal() {
  showSection('section-portal');
  document.getElementById('nav-user').innerHTML =
    '<span>' + (CURRENT_USER?.username || '') + '</span><button onclick="doLogout()">Sign out</button>';
  loadFiles();
}

function switchTab(tab) {
  document.getElementById('form-login').style.display  = tab === 'login'  ? 'block' : 'none';
  document.getElementById('form-signup').style.display = tab === 'signup' ? 'block' : 'none';
  document.getElementById('tab-login').classList.toggle('active',  tab === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
}

function showPane(name) {
  document.getElementById('pane-files').style.display = name === 'files' ? 'block' : 'none';
  document.getElementById('pane-send').style.display  = name === 'send'  ? 'block' : 'none';
  document.getElementById('ptab-files').classList.toggle('active', name === 'files');
  document.getElementById('ptab-send').classList.toggle('active',  name === 'send');
}

// ── Auth ─────────────────────────────────────────────────────────
async function doSignup() {
  const u = document.getElementById('su-user').value.trim();
  const e = document.getElementById('su-email').value.trim();
  const p = document.getElementById('su-pass').value;
  const p2 = document.getElementById('su-pass2').value;
  if (!u||!e||!p) return showAlert('All fields required');
  if (p !== p2) return showAlert('Passwords do not match');
  const r = await api('POST', '/api/signup', { username: u, email: e, password: p });
  if (!r.ok) return showAlert(r.data.error || 'Signup failed');
  SESSION = r.data.token;
  CURRENT_USER = r.data.user;
  localStorage.setItem('lt_session', SESSION);
  showPortal();
}

async function doLogin() {
  const u = document.getElementById('li-user').value.trim();
  const p = document.getElementById('li-pass').value;
  if (!u||!p) return showAlert('Username and password required');
  const r = await api('POST', '/api/login', { username: u, password: p });
  if (!r.ok) return showAlert(r.data.error || 'Login failed');
  SESSION = r.data.token;
  CURRENT_USER = r.data.user;
  localStorage.setItem('lt_session', SESSION);
  showPortal();
}

async function doLogout() {
  await api('POST', '/api/logout');
  SESSION = '';
  CURRENT_USER = null;
  localStorage.removeItem('lt_session');
  document.getElementById('nav-user').innerHTML = '';
  showAuth();
}

// ── Files ─────────────────────────────────────────────────────────
async function loadFiles() {
  const r = await api('GET', '/api/files');
  const el = document.getElementById('file-list');
  if (!r.ok) { el.innerHTML = '<p style="color:var(--danger)">Could not load files</p>'; return; }
  const files = r.data.files || [];
  if (!files.length) { el.innerHTML = '<p style="color:var(--muted);margin-top:12px">No files yet. Upload one above.</p>'; return; }
  el.innerHTML = '<table><thead><tr><th>Name</th><th>Size</th><th>Uploaded</th><th></th></tr></thead><tbody>' +
    files.map(f => `<tr>
      <td><span class="file-name">${esc(f.name)}</span></td>
      <td><span class="file-size">${fmtSize(f.size)}</span></td>
      <td style="color:var(--muted);font-size:.8rem">${f.created_at?.slice(0,10) || ''}</td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" onclick="downloadFile(${f.id},'${esc(f.name)}')">Download</button>
        <button class="btn btn-sm btn-danger" onclick="deleteFile(${f.id})">Delete</button>
      </td>
    </tr>`).join('') + '</tbody></table>';
}

async function uploadFiles(files) {
  if (!files.length) return;
  const prog = document.getElementById('upload-progress');
  prog.style.display = 'block';
  for (const file of Array.from(files)) {
    const fd = new FormData();
    fd.append('file', file);
    prog.value = 0;
    const r = await api('POST', '/api/files/upload', fd, pct => prog.value = pct);
    if (!r.ok) showAlert('Upload failed: ' + (r.data.error || 'unknown error'));
  }
  prog.style.display = 'none';
  document.getElementById('file-input').value = '';
  loadFiles();
}

async function downloadFile(id, name) {
  const r = await api('GET', '/api/files/download?id=' + id);
  if (!r.ok) return showAlert(r.data.error || 'Download failed');
  const a = document.createElement('a');
  a.href = r.data.url;
  a.download = name;
  a.click();
}

async function deleteFile(id) {
  if (!confirm('Delete this file? This cannot be undone.')) return;
  const r = await api('POST', '/api/files/delete', { id });
  if (!r.ok) return showAlert(r.data.error || 'Delete failed');
  loadFiles();
}

// ── Drag & drop ───────────────────────────────────────────────────
const dz = document.getElementById ? document.getElementById('drop-zone') : null;
if (dz) {
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); uploadFiles(e.dataTransfer.files); });
}

// ── Secure Send ───────────────────────────────────────────────────
let shareFileObj = null;

function shareFileSelected(input) {
  shareFileObj = input.files[0] || null;
  document.getElementById('share-file-name').textContent = shareFileObj ? shareFileObj.name : 'Click to choose a file';
}

async function createShare() {
  if (!shareFileObj) return showAlert('Choose a file first');
  const pw = document.getElementById('share-pw').value;
  if (!pw) return showAlert('Password required');
  const email = document.getElementById('share-email').value.trim();
  const exp   = document.getElementById('share-exp').value;

  const prog = document.getElementById('share-progress');
  prog.style.display = 'block';
  prog.value = 0;

  const fd = new FormData();
  fd.append('file', shareFileObj);
  fd.append('password', pw);
  if (email) fd.append('recipient_email', email);
  if (exp)   fd.append('expires_at', exp);

  const r = await api('POST', '/api/share/create', fd, pct => prog.value = pct);
  prog.style.display = 'none';

  if (!r.ok) return showAlert(r.data.error || 'Share failed');

  const link = location.origin + '/view/' + r.data.token;
  document.getElementById('share-url').textContent = link;
  document.getElementById('share-result').style.display = 'block';
  document.getElementById('share-pw').value = '';
  document.getElementById('share-email').value = '';
  document.getElementById('share-exp').value = '';
  shareFileObj = null;
  document.getElementById('share-file-name').textContent = 'Click to choose a file';
  document.getElementById('share-file-input').value = '';
}

function copyShare() {
  navigator.clipboard.writeText(document.getElementById('share-url').textContent)
    .then(() => showAlert('Link copied!', 'ok'));
}

// ── Utilities ─────────────────────────────────────────────────────
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(1) + ' MB';
}
</script>
</body>
</html>`;
}

function renderViewPage(token) {
  const safeToken = token.replace(/[^a-zA-Z0-9_-]/g, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Linear Tech · Secure File</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#0a1628;color:#e8edf5;min-height:100vh;display:flex;flex-direction:column}
header{background:#12223f;border-bottom:1px solid #1e3358;padding:0 24px;height:60px;display:flex;align-items:center}
header h1{font-family:'DM Serif Display',serif;font-size:1.4rem;color:#fff}
header h1 span{color:#2563eb;font-family:'Inter',sans-serif;font-weight:600;font-size:.75rem;vertical-align:super;margin-left:4px}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 20px}
.card{background:#0f1e38;border:1px solid #1e3358;border-radius:12px;padding:36px;max-width:420px;width:100%;text-align:center}
.card svg{margin:0 auto 16px;display:block}
h2{font-family:'DM Serif Display',serif;font-size:1.4rem;margin-bottom:8px}
p{color:#8fa3bf;font-size:.88rem;margin-bottom:20px}
input[type=password]{width:100%;background:#0a1628;border:1px solid #1e3358;color:#e8edf5;
  padding:10px 14px;border-radius:8px;font-size:.9rem;outline:none;margin-bottom:16px;display:block;text-align:left}
input:focus{border-color:#2563eb}
.btn{width:100%;background:#2563eb;color:#fff;border:none;padding:11px;border-radius:8px;cursor:pointer;font-size:.92rem;font-weight:500}
.btn:hover{background:#1d4ed8}
#msg{margin-top:14px;font-size:.85rem;display:none}
.err{color:#fca5a5}.ok{color:#86efac}
</style>
</head>
<body>
<header><h1>Linear Tech <span>FILES</span></h1></header>
<main>
<div class="card">
  <svg width="48" height="48" fill="none" stroke="#2563eb" stroke-width="1.5" viewBox="0 0 24 24">
    <rect x="5" y="11" width="14" height="10" rx="2"/>
    <path d="M8 11V7a4 4 0 018 0v4" stroke-linecap="round"/>
  </svg>
  <h2>Secure File</h2>
  <p>This file can be viewed once. Enter the password to download it.</p>
  <input type="password" id="pw" placeholder="Enter password" autofocus/>
  <button class="btn" onclick="unlock()">View file</button>
  <div id="msg"></div>
</div>
</main>
<script>
const TOKEN = ${JSON.stringify(safeToken)};
async function unlock() {
  const pw = document.getElementById('pw').value;
  if (!pw) return;
  const msg = document.getElementById('msg');
  msg.style.display = 'none';
  const r = await fetch('/api/share/view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, password: pw })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    msg.className = 'err'; msg.textContent = data.error || 'Incorrect password or link already used.';
    msg.style.display = 'block';
    return;
  }
  msg.className = 'ok'; msg.textContent = 'Downloading… this link is now burned.';
  msg.style.display = 'block';
  const a = document.createElement('a');
  a.href = data.url;
  a.download = data.filename || 'file';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
document.getElementById('pw').addEventListener('keydown', e => e.key === 'Enter' && unlock());
</script>
</body>
</html>`;
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

// ── Download file (presigned R2 URL, 15-min expiry) ───────────────
async function downloadFile(request, env, url) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const id = Number(url.searchParams.get('id'));
  const row = await env.DB.prepare(
    'SELECT r2_key, name FROM files WHERE id=? AND user_id=?'
  ).bind(id, user.id).first();
  if (!row) return json({ error: 'File not found' }, 404);

  const signed = await env.FILES.createSignedUrl(row.r2_key, { expiresIn: 900 });
  return corsHeaders(json({ url: signed, filename: row.name }));
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
    'INSERT INTO shares (token, file_id, pw_hash, pw_salt, recipient_email, expires_at) VALUES (?,?,?,?,?,?)'
  ).bind(token, fileRow.id, hash, salt, recipientEmail, expiresAt || null).run();

  return json({ token });
}

// ── View share (burn after first successful view) ──────────────────
async function viewShare(request, env, ctx) {
  const { token, password } = await request.json();
  if (!token || !password) return json({ error: 'Token and password required' }, 400);

  const share = await env.DB.prepare(
    `SELECT s.id, s.token, s.pw_hash, s.pw_salt, s.viewed, s.expires_at,
            f.r2_key, f.name
     FROM shares s JOIN files f ON f.id = s.file_id
     WHERE s.token=?`
  ).bind(token).first();

  if (!share) return json({ error: 'Link not found or already used' }, 404);
  if (share.viewed) return json({ error: 'This link has already been used' }, 410);
  if (share.expires_at && new Date(share.expires_at) < new Date()) return json({ error: 'This link has expired' }, 410);

  const ok = await verifyPassword(password, share.pw_hash, share.pw_salt);
  if (!ok) return json({ error: 'Incorrect password' }, 401);

  // Atomically mark as viewed — if another request beat us, bail
  const result = await env.DB.prepare(
    'UPDATE shares SET viewed=1 WHERE id=? AND viewed=0'
  ).bind(share.id).run();

  if (!result.meta?.changes && result.changes === 0) {
    return json({ error: 'This link has already been used' }, 410);
  }

  const signed = await env.FILES.createSignedUrl(share.r2_key, { expiresIn: 60 });
  // Schedule R2 cleanup in background (best-effort)
  if (ctx?.waitUntil) ctx.waitUntil(env.FILES.delete(share.r2_key).catch(() => {}));

  return json({ url: signed, filename: share.name });
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
