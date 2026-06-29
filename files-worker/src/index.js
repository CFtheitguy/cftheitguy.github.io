/**
 * Linear Tech — File Portal
 * =========================
 * Cloudflare Worker: serves the UI + API for files.linearit.co
 *
 * Bindings:  DB (D1), FILES (R2)
 * Secrets:   SESSION_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 * Vars:      STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, STRIPE_PRICE_BUSINESS, SITE_ORIGIN
 */

// Plan definitions — storage limits in bytes
const PLANS = {
  starter:  { name: 'Starter',  price: '$5/mo',  gb: 10,  bytes: 10  * 1024 * 1024 * 1024 },
  pro:      { name: 'Pro',      price: '$15/mo', gb: 50,  bytes: 50  * 1024 * 1024 * 1024 },
  business: { name: 'Business', price: '$40/mo', gb: 200, bytes: 200 * 1024 * 1024 * 1024 },
};

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
      if (method === "GET" && path === "/signup-complete") {
        return htmlResponse(renderSignupComplete());
      }

      // ── Auth API ───────────────────────────────────────────────────
      if (path === "/api/signup/checkout" && method === "POST") return corsHeaders(await signupCheckout(request, env));
      if (path === "/api/signup/complete"  && method === "POST") return corsHeaders(await signupComplete(request, env));
      if (path === "/api/signup/invite"    && method === "POST") return corsHeaders(await signupInvite(request, env));
      if (path === "/api/login"   && method === "POST") return corsHeaders(await loginUser(request, env));
      if (path === "/api/logout"  && method === "POST") return corsHeaders(await logout(request, env));
      if (path === "/api/me"      && method === "GET")  return corsHeaders(await me(request, env));

      // ── Billing API ────────────────────────────────────────────────
      if (path === "/api/billing/portal" && method === "POST") return corsHeaders(await billingPortal(request, env));
      if (path === "/api/stripe/webhook" && method === "POST") return await stripeWebhook(request, env);

      // ── File API ───────────────────────────────────────────────────
      if (path === "/api/files"        && method === "GET")    return corsHeaders(await listFiles(request, env));
      if (path === "/api/files/upload" && method === "POST")   return corsHeaders(await uploadFile(request, env));
      if (path === "/api/files/delete" && method === "POST")   return corsHeaders(await deleteFile(request, env));
      if (path === "/api/files/download" && method === "GET")  return await downloadFile(request, env, url);

      // ── Share API ──────────────────────────────────────────────────
      if (path === "/api/share/create" && method === "POST")   return corsHeaders(await createShare(request, env));
      if (path === "/api/share/view"   && method === "POST")   return corsHeaders(await viewShare(request, env, ctx));

      // ── Cron ───────────────────────────────────────────────────────
      if (path === "/api/cron" && method === "GET") {
        await purgeExpired(env);
        await syncSubscriptions(env);
        return new Response("done", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return corsHeaders(json({ error: String(err?.message || err) }, 500));
    }
  },

  async scheduled(_event, env) {
    await purgeExpired(env);
    await syncSubscriptions(env);
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

/* ── Plan cards ── */
.plan-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.plan-card{border:2px solid var(--border2);border-radius:12px;padding:16px 12px;cursor:pointer;text-align:center;transition:all .15s;position:relative;user-select:none;display:block}
.plan-card:hover{border-color:var(--accent);background:var(--accent-bg)}
.plan-card.selected{border-color:var(--accent);background:var(--accent-bg);box-shadow:0 0 0 3px var(--accent-bg)}
.plan-name{font-weight:700;font-size:.88rem;margin-bottom:4px}
.plan-price{font-size:1.3rem;font-weight:700;color:var(--accent);line-height:1}
.plan-price span{font-size:.72rem;font-weight:500;color:var(--muted)}
.plan-gb{font-size:.75rem;color:var(--muted);margin-top:4px;font-weight:500}
.plan-badge{position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:.65rem;font-weight:700;padding:2px 8px;border-radius:20px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}

/* ── Storage bar ── */
.storage-bar-wrap{margin-bottom:20px}
.storage-bar-label{display:flex;justify-content:space-between;font-size:.78rem;color:var(--muted);margin-bottom:6px;font-weight:500}
.storage-bar-label strong{color:var(--text)}
.storage-bar-bg{background:var(--border);border-radius:4px;height:6px;overflow:hidden}
.storage-bar-fill{height:100%;border-radius:4px;background:var(--accent);transition:width .4s}
.storage-bar-fill.warn{background:#f59e0b}
.storage-bar-fill.danger{background:var(--danger)}

/* ── Misc ── */
#section-auth,#section-portal{display:none}
.auth-wrap{max-width:460px;margin:0 auto}
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
        <div class="card-desc">Choose a plan and enter your details. You'll be taken to secure checkout to complete payment.</div>
        <div class="field"><label>Username</label><input id="su-user" type="text" placeholder="yourname" autocomplete="username"/></div>
        <div class="field"><label>Email address</label><input id="su-email" type="email" placeholder="you@example.com" autocomplete="email"/></div>
        <div class="field"><label>Password</label><input id="su-pass" type="password" placeholder="At least 8 characters" autocomplete="new-password"/></div>
        <div class="field"><label>Confirm password</label><input id="su-pass2" type="password" placeholder="Repeat password" autocomplete="new-password"/></div>

        <div class="field">
          <label>Choose a plan</label>
          <div class="plan-grid">
            <label class="plan-card" id="plan-starter">
              <input type="radio" name="plan" value="starter" checked style="display:none"/>
              <div class="plan-name">Starter</div>
              <div class="plan-price">$5 <span>/mo</span></div>
              <div class="plan-gb">10 GB storage</div>
            </label>
            <label class="plan-card" id="plan-pro">
              <input type="radio" name="plan" value="pro" style="display:none"/>
              <div class="plan-name">Pro</div>
              <div class="plan-price">$15 <span>/mo</span></div>
              <div class="plan-gb">50 GB storage</div>
              <div class="plan-badge">Popular</div>
            </label>
            <label class="plan-card" id="plan-business">
              <input type="radio" name="plan" value="business" style="display:none"/>
              <div class="plan-name">Business</div>
              <div class="plan-price">$40 <span>/mo</span></div>
              <div class="plan-gb">200 GB storage</div>
            </label>
          </div>
        </div>

        <button class="btn btn-full" onclick="doSignup()">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Continue to secure payment
        </button>
        <p style="text-align:center;font-size:.75rem;color:var(--muted2);margin-top:12px">Payments processed securely by Stripe. Cancel any time.</p>

        <hr/>
        <div class="field" style="margin-bottom:8px">
          <label>Have an invite code? &nbsp;<span style="font-weight:400;color:var(--muted2)">(start a 14-day free trial — no payment)</span></label>
          <input id="su-invite" type="text" placeholder="Enter invite code (optional)" autocomplete="off"/>
        </div>
        <button class="btn btn-outline btn-full" onclick="doInvite()">Start 14-day free trial</button>
        <p style="text-align:center;font-size:.72rem;color:var(--muted2);margin-top:10px">Free trial includes 10&nbsp;GB storage and stops working after 14 days unless you subscribe.</p>
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
        <div id="storage-bar" style="display:none" class="storage-bar-wrap">
          <div class="storage-bar-label"><span id="storage-text">Loading…</span><button class="btn btn-sm btn-outline" onclick="manageBilling()" style="padding:3px 10px;font-size:.75rem">Manage plan</button></div>
          <div class="storage-bar-bg"><div class="storage-bar-fill" id="storage-fill" style="width:0%"></div></div>
        </div>
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

function renderSignupComplete() {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Linear Tech · Setting up your account…</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root,[data-theme="dark"]{--bg:#0f1117;--card:#181c2a;--text:#eef0f6;--muted:#7c85a2;--accent:#4f7ef8;--border:#2a2f45;--success:#4ade80;--success-bg:rgba(74,222,128,.12);--danger:#f06464;--danger-bg:rgba(240,100,100,.12)}
[data-theme="light"]{--bg:#f4f6fb;--card:#fff;--text:#1a1d2e;--muted:#5a6080;--accent:#3b6cf5;--border:#dde1ee;--success:#16a34a;--success-bg:rgba(22,163,74,.08);--danger:#e03e3e;--danger-bg:rgba(224,62,62,.08)}
body{font-family:'Plus Jakarta Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:48px 40px;max-width:420px;width:100%;text-align:center}
.spin{width:48px;height:48px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 24px}
@keyframes spin{to{transform:rotate(360deg)}}
h2{font-size:1.3rem;font-weight:700;margin-bottom:8px}
p{color:var(--muted);font-size:.9rem;line-height:1.6}
.ok-icon{width:56px;height:56px;background:var(--success-bg);border-radius:50%;display:none;align-items:center;justify-content:center;margin:0 auto 24px}
.err-icon{width:56px;height:56px;background:var(--danger-bg);border-radius:50%;display:none;align-items:center;justify-content:center;margin:0 auto 24px}
</style>
</head>
<body>
<div class="card">
  <div class="spin" id="spinner"></div>
  <div class="ok-icon" id="ok-icon"><svg width="28" height="28" fill="none" stroke="var(--success)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  <div class="err-icon" id="err-icon"><svg width="28" height="28" fill="none" stroke="var(--danger)" stroke-width="2.5" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  <h2 id="title">Setting up your account…</h2>
  <p id="msg">Please wait while we confirm your payment.</p>
</div>
<script>
(function() {
  try { var t = localStorage.getItem('theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch(e) {}
  var params = new URLSearchParams(window.location.search);
  var sessionId = params.get('session_id');
  if (!sessionId) { showErr('No session found. Please try signing up again.'); return; }
  fetch('/api/signup/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId })
  })
  .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
  .then(function(r) {
    if (!r.ok) { showErr(r.data.error || 'Something went wrong.'); return; }
    try { localStorage.setItem('sess', r.data.token); } catch(e) {}
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('ok-icon').style.display = 'flex';
    document.getElementById('title').textContent = 'You are all set!';
    document.getElementById('msg').textContent = 'Welcome aboard. Taking you to your files…';
    setTimeout(function() { window.location.href = '/'; }, 1800);
  })
  .catch(function() { showErr('Network error. Please try again.'); });
  function showErr(msg) {
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('err-icon').style.display = 'flex';
    document.getElementById('title').textContent = 'Something went wrong';
    document.getElementById('msg').textContent = msg;
  }
})();
</script>
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
    '// Plan card selection',
    '(function() {',
    '  document.querySelectorAll(".plan-card").forEach(function(card) {',
    '    card.addEventListener("click", function() {',
    '      document.querySelectorAll(".plan-card").forEach(function(c) { c.classList.remove("selected"); });',
    '      card.classList.add("selected");',
    '      var radio = card.querySelector("input[type=radio]");',
    '      if (radio) radio.checked = true;',
    '    });',
    '  });',
    '  var first = document.querySelector(".plan-card");',
    '  if (first) first.classList.add("selected");',
    '})();',
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
    '  var planLabel = user && user.plan ? (user.plan.charAt(0).toUpperCase() + user.plan.slice(1)) : "";',
    '  document.getElementById("nav-user").innerHTML =',
    '    "<span class=\'nav-name\'>" + name + "</span>" +',
    '    (planLabel ? "<span style=\'font-size:.72rem;color:var(--accent);font-weight:600;background:var(--accent-bg);padding:2px 8px;border-radius:20px\'>" + planLabel + "</span>" : "") +',
    '    "<button class=\'btn-signout\' onclick=\'doLogout()\'>Sign out</button>";',
    '  showSection("section-portal");',
    '  loadFiles();',
    '  loadStorage(user);',
    '}',
    '',
    'function loadStorage(user) {',
    '  var bar = document.getElementById("storage-bar");',
    '  var fill = document.getElementById("storage-fill");',
    '  var text = document.getElementById("storage-text");',
    '  if (!bar || !user) return;',
    '  bar.style.display = "block";',
    '  var used = user.storage_used || 0;',
    '  var limit = user.storage_limit || 1;',
    '  var pct = Math.min(100, Math.round(used / limit * 100));',
    '  fill.style.width = pct + "%";',
    '  fill.className = "storage-bar-fill" + (pct >= 90 ? " danger" : pct >= 75 ? " warn" : "");',
    '  text.innerHTML = "<strong>" + fmtSize(used) + "</strong> of " + fmtSize(limit) + " used (" + pct + "%)";',
    '}',
    '',
    'async function manageBilling() {',
    '  var r = await api("/api/billing/portal", { method: "POST" });',
    '  if (!r.ok) return showAlert(r.data.error || "Could not open billing portal");',
    '  window.location.href = r.data.url;',
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
    '  var planRadio = document.querySelector("input[name=plan]:checked");',
    '  var plan = planRadio ? planRadio.value : "starter";',
    '  if (!u || !e || !p) return showAlert("All fields required");',
    '  if (p !== p2) return showAlert("Passwords do not match");',
    '  var r = await api("/api/signup/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, email: e, password: p, plan: plan }) });',
    '  if (!r.ok) return showAlert(r.data.error || "Signup failed");',
    '  window.location.href = r.data.url;',
    '}',
    '',
    'async function doInvite() {',
    '  var u = document.getElementById("su-user").value.trim();',
    '  var e = document.getElementById("su-email").value.trim();',
    '  var p = document.getElementById("su-pass").value;',
    '  var p2 = document.getElementById("su-pass2").value;',
    '  var code = document.getElementById("su-invite").value.trim();',
    '  if (!u || !e || !p) return showAlert("Fill in username, email and password first");',
    '  if (p !== p2) return showAlert("Passwords do not match");',
    '  if (!code) return showAlert("Enter your invite code to start a free trial");',
    '  var r = await api("/api/signup/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, email: e, password: p, code: code }) });',
    '  if (!r.ok) return showAlert(r.data.error || "Could not start trial");',
    '  SESSION = r.data.token; lsSet("sess", SESSION);',
    '  showAlert("Free trial started! You have 14 days.", "ok");',
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

// ── Signup step 1: validate → create Stripe Checkout session ──────
async function signupCheckout(request, env) {
  const { username, email, password, plan } = await request.json();
  if (!username || !email || !password) return json({ error: 'All fields required' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
  if (!PLANS[plan]) return json({ error: 'Invalid plan' }, 400);

  // Check availability before sending to Stripe
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE username=? OR email=?'
  ).bind(username.trim(), email.trim().toLowerCase()).first();
  if (existing) return json({ error: 'Username or email already taken' }, 409);

  const { hash, salt } = await hashPassword(password);
  const priceId = { starter: env.STRIPE_PRICE_STARTER, pro: env.STRIPE_PRICE_PRO, business: env.STRIPE_PRICE_BUSINESS }[plan];
  if (!priceId) return json({ error: 'Stripe price not configured for this plan' }, 500);

  const origin = env.SITE_ORIGIN || 'https://files.linearit.co';
  const session = await stripeApi(env, 'POST', '/checkout/sessions', {
    'mode': 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'success_url': origin + '/signup-complete?session_id={CHECKOUT_SESSION_ID}',
    'cancel_url': origin + '/',
    'allow_promotion_codes': 'true',
    'customer_email': email.trim().toLowerCase(),
    'subscription_data[metadata][plan]': plan,
    'metadata[username]': username.trim(),
    'metadata[email]': email.trim().toLowerCase(),
    'metadata[pw_hash]': hash,
    'metadata[pw_salt]': salt,
    'metadata[plan]': plan,
  });

  if (session.error) return json({ error: session.error.message || 'Stripe error' }, 500);
  return json({ url: session.url });
}

// ── Signup step 2: verify payment → create account ────────────────
async function signupComplete(request, env) {
  const { session_id } = await request.json();
  if (!session_id) return json({ error: 'Missing session_id' }, 400);

  const session = await stripeApi(env, 'GET', '/checkout/sessions/' + session_id + '?expand[]=subscription', null);
  if (!session || session.error) return json({ error: 'Could not verify payment' }, 400);
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return json({ error: 'Payment not completed' }, 402);

  const meta = session.metadata || {};
  const { username, email, pw_hash, pw_salt, plan } = meta;
  if (!username || !email || !pw_hash || !plan) return json({ error: 'Missing account details' }, 400);
  if (!PLANS[plan]) return json({ error: 'Invalid plan' }, 400);

  const stripeCustomerId = session.customer;
  const stripeSubId = session.subscription && (session.subscription.id || session.subscription);

  // Idempotent: if user already exists (page refresh), just log them in
  let row = await env.DB.prepare('SELECT id, username, email FROM users WHERE email=?')
    .bind(email).first();

  if (!row) {
    row = await env.DB.prepare(
      'INSERT INTO users (username, email, pw_hash, pw_salt, stripe_customer_id, stripe_sub_id, plan, storage_limit, status) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id, username, email'
    ).bind(username, email, pw_hash, pw_salt, stripeCustomerId, stripeSubId || null, plan, PLANS[plan].bytes, 'active').first();
  }

  const token = await makeSessionToken(env, row.id);
  return json({ token, user: { id: row.id, username: row.username, email: row.email, plan } });
}

// ── Signup via invite code: free 14-day trial, no payment ─────────
async function signupInvite(request, env) {
  const { username, email, password, code } = await request.json();
  if (!username || !email || !password) return json({ error: 'All fields required' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);

  // The invite code is configured as a Worker var/secret named INVITE_CODE.
  if (!env.INVITE_CODE) return json({ error: 'Invite codes are not enabled' }, 403);
  if (!code || code.trim() !== env.INVITE_CODE) return json({ error: 'Invalid invite code' }, 403);

  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE username=? OR email=?'
  ).bind(username.trim(), email.trim().toLowerCase()).first();
  if (existing) return json({ error: 'Username or email already taken' }, 409);

  const { hash, salt } = await hashPassword(password);
  // Trial lasts 14 days from now.
  const trialUntil = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const row = await env.DB.prepare(
    "INSERT INTO users (username, email, pw_hash, pw_salt, plan, storage_limit, status, trial_until) VALUES (?,?,?,?,?,?,?,?) RETURNING id, username, email"
  ).bind(username.trim(), email.trim().toLowerCase(), hash, salt, 'starter', PLANS.starter.bytes, 'active', trialUntil).first();

  const token = await makeSessionToken(env, row.id);
  return json({ token, user: { id: row.id, username: row.username, email: row.email, plan: 'starter' } });
}

// ── Billing: Stripe Customer Portal link ──────────────────────────
async function billingPortal(request, env) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const u = await env.DB.prepare('SELECT stripe_customer_id FROM users WHERE id=?').bind(user.id).first();
  if (!u || !u.stripe_customer_id) return json({ error: 'No billing account found' }, 404);

  const origin = env.SITE_ORIGIN || 'https://files.linearit.co';
  const portal = await stripeApi(env, 'POST', '/billing_portal/sessions', {
    customer: u.stripe_customer_id,
    return_url: origin + '/',
  });
  if (portal.error) return json({ error: portal.error.message || 'Stripe error' }, 500);
  return json({ url: portal.url });
}

// ── Stripe webhook ────────────────────────────────────────────────
async function stripeWebhook(request, env) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature') || '';
  const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET || '');
  if (!valid) return new Response('Bad signature', { status: 400 });

  const event = JSON.parse(body);
  const sub = event.data && event.data.object;

  if (event.type === 'customer.subscription.deleted') {
    await env.DB.prepare("UPDATE users SET status='cancelled' WHERE stripe_customer_id=?")
      .bind(sub.customer).run();
  }
  if (event.type === 'customer.subscription.updated') {
    // Plan change: find new price and update storage limit
    const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
    const plan = priceId ? priceIdToPlan(env, priceId) : null;
    if (plan && PLANS[plan]) {
      await env.DB.prepare("UPDATE users SET plan=?, storage_limit=?, status='active' WHERE stripe_customer_id=?")
        .bind(plan, PLANS[plan].bytes, sub.customer).run();
    }
    if (sub.status === 'active' || sub.status === 'trialing') {
      await env.DB.prepare("UPDATE users SET status='active' WHERE stripe_customer_id=?").bind(sub.customer).run();
    }
  }
  if (event.type === 'invoice.payment_failed') {
    await env.DB.prepare("UPDATE users SET status='past_due' WHERE stripe_customer_id=?")
      .bind(sub.customer).run();
  }

  return new Response('ok', { status: 200 });
}

function priceIdToPlan(env, priceId) {
  if (priceId === env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId === env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId === env.STRIPE_PRICE_BUSINESS) return 'business';
  return null;
}

// ── Cron: sync subscription statuses from Stripe ──────────────────
async function syncSubscriptions(env) {
  const pastDue = await env.DB.prepare(
    "SELECT stripe_sub_id FROM users WHERE status='active' AND stripe_sub_id IS NOT NULL"
  ).all();
  // Lightweight: just trust webhooks; this is a fallback safety net
  // A full sync would query Stripe for each subscription — skip for now to stay within CPU limits
}

// ── Stripe API helper ─────────────────────────────────────────────
async function stripeApi(env, method, path, params) {
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY },
  };
  if (params && method !== 'GET') {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch('https://api.stripe.com/v1' + path, opts);
  return r.json();
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret || !sigHeader) return false;
  try {
    const ts = (sigHeader.split(',').find(p => p.startsWith('t=')) || '').slice(2);
    const v1 = (sigHeader.split(',').find(p => p.startsWith('v1=')) || '').slice(3);
    if (!ts || !v1) return false;
    const payload = ts + '.' + rawBody;
    const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc(payload));
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === v1;
  } catch(e) { return false; }
}

// ── Signup (kept for backward compat — not used in new flow) ──────
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
    'SELECT id, username, email, pw_hash, pw_salt, trial_until FROM users WHERE username=? OR email=?'
  ).bind(username.trim(), username.trim().toLowerCase()).first();

  if (!row) return json({ error: 'Invalid username or password' }, 401);
  const ok = await verifyPassword(password, row.pw_hash, row.pw_salt);
  if (!ok) return json({ error: 'Invalid username or password' }, 401);
  if (row.trial_until && new Date(row.trial_until) < new Date()) {
    return json({ error: 'Your 14-day free trial has ended. Please subscribe to keep using your account.' }, 403);
  }

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
  const usage = await env.DB.prepare('SELECT SUM(size) as total FROM files WHERE user_id=?').bind(user.id).first();
  return json({
    id: user.id, username: user.username, email: user.email,
    plan: user.plan || 'starter',
    status: user.status || 'active',
    storage_limit: user.storage_limit || PLANS.starter.bytes,
    storage_used: usage ? (usage.total || 0) : 0,
  });
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

  // Enforce storage limit
  const limit = user.storage_limit || PLANS.starter.bytes;
  const usage = await env.DB.prepare('SELECT SUM(size) as total FROM files WHERE user_id=?').bind(user.id).first();
  const used = usage ? (usage.total || 0) : 0;

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400);
  if (used + file.size > limit) {
    const plan = user.plan || 'starter';
    const info = PLANS[plan] || PLANS.starter;
    return json({ error: 'Storage limit reached (' + info.gb + ' GB on your ' + info.name + ' plan). Upgrade your plan to upload more files.' }, 413);
  }

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
    'SELECT u.id, u.username, u.email, u.plan, u.status, u.storage_limit, u.stripe_customer_id, u.trial_until FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at > datetime("now")'
  ).bind(token).first();
  if (!row) return null;
  // If this is a trial account and the trial has ended, deny access.
  if (row.trial_until && new Date(row.trial_until) < new Date()) return null;
  return row;
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
