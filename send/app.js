/* Linear Send — front-end.
 *
 * Two screens in one page:
 *   no ?t=     the sender: pick files, upload, get a link
 *   ?t=<id>    the person the link was sent to: see the files, download them
 *
 * Files are uploaded exactly as the browser reads them off disk. Nothing here
 * resizes, re-encodes or compresses anything — the bytes that leave are the
 * bytes that arrive. While each file streams up, its CRC-32 is worked out
 * along the way; the server uses those to build the "Download all" ZIP
 * without having to read every byte back.
 */
(() => {
  "use strict";

  // The API lives on send.linearit.co. When the page is opened from the
  // GitHub Pages copy, talk to it cross-origin; anywhere else (the vanity
  // domain itself, or `wrangler dev`) it is the same origin.
  const PAGES_HOSTS = ["www.linearit.co", "linearit.co", "cftheitguy.github.io"];
  const API = PAGES_HOSTS.includes(location.hostname) ? "https://send.linearit.co" : "";
  const SHARE_BASE = API || location.origin;

  const CONCURRENCY = 4;     // requests in flight at once
  const MAX_TRIES = 6;       // per request, before giving up and offering "Try again"

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };

  /* ---------------- theme ---------------- */
  const root = document.documentElement;
  const saved = store.get("send-theme", null);
  if (saved) root.dataset.theme = saved;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches);
  const paintThemeBtn = () => { $("themeBtn").textContent = isDark() ? "☀️" : "🌙"; };
  $("themeBtn").onclick = () => { root.dataset.theme = isDark() ? "light" : "dark"; store.set("send-theme", root.dataset.theme); paintThemeBtn(); };
  paintThemeBtn();

  /* ---------------- helpers ---------------- */
  function fmtBytes(n) {
    const u = ["bytes", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
  }
  function fmtLeft(ms) {
    if (ms <= 0) return "now";
    const m = Math.round(ms / 60000);
    if (m < 60) return m + (m === 1 ? " minute" : " minutes");
    const h = Math.round(m / 60);
    if (h < 48) return h + (h === 1 ? " hour" : " hours");
    const d = Math.round(h / 24);
    return d + " days";
  }
  const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  function icon(name, type) {
    type = type || "";
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (type.startsWith("image/") || /^(heic|heif|raw|cr2|nef|arw|dng)$/.test(ext)) return "🖼️";
    if (type.startsWith("video/")) return "🎬";
    if (type.startsWith("audio/")) return "🎵";
    if (ext === "pdf") return "📕";
    if (/^(zip|rar|7z|gz|tar)$/.test(ext)) return "🗜️";
    if (/^(doc|docx|txt|rtf|odt|pages)$/.test(ext)) return "📄";
    if (/^(xls|xlsx|csv|numbers)$/.test(ext)) return "📊";
    if (/^(ppt|pptx|key)$/.test(ext)) return "📽️";
    return "📎";
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  let toastT;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800); }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast("Link copied"); }
    catch (_) { const i = $("shareLink"); i.select(); document.execCommand("copy"); toast("Link copied"); }
  }
  const shareUrl = (id) => SHARE_BASE + "/?t=" + id;

  /* CRC-32 (the ZIP one), fed chunk by chunk in file order. */
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  function crcUpdate(crc, bytes) {
    let c = crc ^ -1;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return c ^ -1;
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) { const e = new Error((data && data.error) || "Request failed (" + res.status + ")"); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  const params = new URLSearchParams(location.search);
  const tid = params.get("t");
  if (tid) receive(tid); else sender();

  /* ====================================================================
   * SENDER
   * ================================================================== */
  function sender() {
    $("sendView").hidden = false;
    const MAX_BYTES = 10 * 1024 ** 3;
    let picked = [];   // {file, path}
    let job = null;    // the upload in progress / just finished

    /* ---- picking ---- */
    $("addFiles").onclick = () => $("fileInput").click();
    $("addFolder").onclick = () => $("folderInput").click();
    $("fileInput").onchange = (e) => { add([...e.target.files].map((f) => ({ file: f, path: f.name }))); e.target.value = ""; };
    $("folderInput").onchange = (e) => { add([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))); e.target.value = ""; };

    const drop = $("drop");
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    // Stop a file dropped beside the box from navigating away from the page.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
    drop.addEventListener("drop", async (e) => {
      const items = [...(e.dataTransfer.items || [])];
      const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
      if (entries.length) {
        const out = [];
        for (const en of entries) await walk(en, "", out);
        add(out);
      } else {
        add([...e.dataTransfer.files].map((f) => ({ file: f, path: f.name })));
      }
    });

    // Read a dropped folder all the way down, keeping the folder names.
    async function walk(entry, prefix, out) {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, path: prefix + file.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, prefix + entry.name + "/", out);
        } while (batch.length);
      }
    }

    function add(list) {
      const seen = new Set(picked.map((p) => p.path + "|" + p.file.size));
      for (const p of list) {
        if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(p.path)) continue;
        const k = p.path + "|" + p.file.size;
        if (!seen.has(k)) { seen.add(k); picked.push(p); }
      }
      renderPicked();
    }

    function renderPicked() {
      const ul = $("fileList");
      ul.textContent = "";
      picked.forEach((p, i) => {
        const li = el("li");
        li.append(el("span", "fic", icon(p.path, p.file.type)));
        const m = el("div", "fmeta");
        m.append(el("div", "fname", p.path), el("div", "fsize", fmtBytes(p.file.size)));
        const x = el("button", "x", "×");
        x.title = "Remove";
        x.setAttribute("aria-label", "Remove " + p.path);
        x.onclick = () => { picked.splice(i, 1); renderPicked(); };
        li.append(m, x);
        ul.append(li);
      });
      const total = picked.reduce((s, p) => s + p.file.size, 0);
      $("summary").hidden = !picked.length;
      $("sumCount").textContent = picked.length + (picked.length === 1 ? " file" : " files");
      $("sumSize").textContent = fmtBytes(total) + " of " + fmtBytes(MAX_BYTES);
      $("sumSize").className = total > MAX_BYTES ? "over" : "";
      $("sendBtn").disabled = !picked.length || total > MAX_BYTES || picked.length > 500;
    }

    /* ---- the upload key, only if this server asks for one ---- */
    const savedKey = store.get("send-key", "");
    if (savedKey) $("uploadKey").value = savedKey;
    if (store.get("send-needs-key", false)) $("keyField").hidden = false;

    $("sendBtn").onclick = start;

    async function start() {
      const err = $("sendErr");
      err.hidden = true;
      $("sendBtn").disabled = true;
      $("sendBtn").textContent = "Starting…";
      const key = $("uploadKey").value.trim();
      const headers = { "Content-Type": "application/json" };
      if (key) headers["X-Upload-Key"] = key;
      try {
        const created = await api("/api/t", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: $("title").value,
            message: $("message").value,
            hours: Number($("expiry").value),
            files: picked.map((p) => ({ name: p.path, size: p.file.size, type: p.file.type, modified: p.file.lastModified })),
          }),
        });
        if (key) store.set("send-key", key);
        job = {
          id: created.id,
          owner: created.ownerToken,
          partSize: created.partSize,
          expiresAt: created.expiresAt,
          title: $("title").value.trim(),
          files: picked.map((p, n) => ({ n, file: p.file, name: created.files[n], size: p.file.size, sent: 0, crc: null, done: false })),
        };
        showUpload();
        runUpload();
      } catch (e) {
        if (e.data && e.data.needKey) {
          store.set("send-needs-key", true);
          $("keyField").hidden = false;
          $("uploadKey").focus();
          err.textContent = key ? "That upload key isn't right." : "Enter the upload key to send files.";
        } else {
          err.textContent = e.message;
        }
        err.hidden = false;
        $("sendBtn").disabled = false;
        $("sendBtn").textContent = "Get a link";
      }
    }

    /* ---- uploading ---- */
    function showUpload() {
      $("pickStep").hidden = true;
      $("recent").hidden = true;
      $("uploadStep").hidden = false;
      const ul = $("upList");
      ul.textContent = "";
      for (const f of job.files) {
        const li = el("li");
        li.append(el("span", "fic", icon(f.name, f.file.type)));
        const m = el("div", "fmeta");
        const bar = el("div", "fbar");
        f.bar = el("i");
        bar.append(f.bar);
        f.barWrap = bar;
        m.append(el("div", "fname", f.name), el("div", "fsize", fmtBytes(f.size)), bar);
        li.append(m);
        ul.append(li);
      }
    }

    // A tiny semaphore so at most CONCURRENCY requests are in flight.
    function slots(n) {
      let free = n;
      const waiting = [];
      return {
        acquire() { if (free > 0) { free--; return Promise.resolve(); } return new Promise((r) => waiting.push(r)); },
        release() { const next = waiting.shift(); if (next) next(); else free++; },
      };
    }

    let speedSamples = [];
    let ticker = null;

    async function runUpload() {
      $("upErr").hidden = true;
      $("upActions").hidden = true;
      job.failed = false;
      window.addEventListener("beforeunload", guard);
      let wake = null;
      try { wake = await navigator.wakeLock.request("screen"); } catch (_) {}
      ticker = setInterval(paintProgress, 400);
      const pool = slots(CONCURRENCY);
      try {
        const pending = [];
        for (const f of job.files) {
          if (f.done) continue;
          f.sent = 0;
          pending.push(await dispatchFile(f, pool)); // reads in order, uploads in parallel
          if (job.failed) break;
        }
        await Promise.all(pending);
        if (job.failed) throw job.failed;
        await api(`/api/t/${job.id}/finish`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Owner-Token": job.owner },
          body: JSON.stringify({ crcs: job.files.map((f) => f.crc) }),
        });
        remember();
        showDone();
      } catch (e) {
        $("upErr").textContent = (e && e.message ? e.message : "The upload stopped.") + " Nothing you've already sent is lost.";
        $("upErr").hidden = false;
        $("upActions").hidden = false;
      } finally {
        clearInterval(ticker);
        paintProgress();
        window.removeEventListener("beforeunload", guard);
        try { wake && wake.release(); } catch (_) {}
      }
    }
    const guard = (e) => { e.preventDefault(); e.returnValue = ""; };

    $("retryBtn").onclick = () => runUpload();
    $("cancelBtn").onclick = () => {
      if (job) fetch(API + "/api/t/" + job.id, { method: "DELETE", headers: { "X-Owner-Token": job.owner } }).catch(() => {});
      location.href = location.pathname;
    };

    // Returns a promise for when this file is fully up. Reading happens here,
    // in order, so the CRC can be carried from one part to the next; each
    // read waits for a free slot, which keeps memory to CONCURRENCY parts.
    async function dispatchFile(f, pool) {
      const hdr = { "X-Owner-Token": job.owner };
      const base = `/api/t/${job.id}/f/${f.n}`;

      if (f.size <= job.partSize) {
        await pool.acquire();
        let buf;
        try { buf = new Uint8Array(await f.file.arrayBuffer()); }
        catch (e) { pool.release(); job.failed = unreadable(f); return Promise.resolve(); }
        const crc = crcUpdate(0, buf);
        return send("PUT", API + base, buf, hdr, (n) => { f.sent = n; })
          .then(() => { f.crc = crc >>> 0; finishFile(f); })
          .catch((e) => { job.failed = job.failed || e; })
          .finally(() => pool.release());
      }

      // Large file: in parts. A retry of the whole transfer re-sends this
      // file from its first part, because the CRC needs every byte in order.
      const { upload } = await api(base + "/start", { method: "POST", headers: hdr });
      const count = Math.ceil(f.size / job.partSize);
      const partSent = new Array(count).fill(0);
      const etags = new Array(count);
      const inflight = [];
      let crc = 0;
      for (let p = 0; p < count; p++) {
        if (job.failed) break;
        await pool.acquire();
        const start = p * job.partSize;
        let buf;
        try { buf = new Uint8Array(await f.file.slice(start, Math.min(f.size, start + job.partSize)).arrayBuffer()); }
        catch (e) { pool.release(); job.failed = unreadable(f); break; }
        crc = crcUpdate(crc, buf);
        const url = `${API}${base}?upload=${encodeURIComponent(upload)}&part=${p + 1}`;
        inflight.push(
          send("PUT", url, buf, hdr, (n) => { partSent[p] = n; f.sent = partSent.reduce((a, b) => a + b, 0); })
            .then((r) => { etags[p] = { partNumber: p + 1, etag: r.etag }; })
            .catch((e) => { job.failed = job.failed || e; })
            .finally(() => pool.release()),
        );
      }
      return Promise.all(inflight).then(async () => {
        if (job.failed) return;
        await api(base + "/complete", {
          method: "POST",
          headers: { ...hdr, "Content-Type": "application/json" },
          body: JSON.stringify({ upload, parts: etags }),
        });
        f.crc = crc >>> 0;
        finishFile(f);
      }).catch((e) => { job.failed = job.failed || e; });
    }

    function unreadable(f) {
      return new Error(`Couldn't read "${f.name}" — was it moved or deleted?`);
    }

    function finishFile(f) {
      f.done = true;
      f.sent = f.size;
      f.barWrap.classList.add("done");
    }

    // XHR rather than fetch, because only XHR reports upload progress.
    // Retries with backoff on network errors and 5xx / 429.
    async function send(method, url, body, headers, onProgress) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open(method, url);
            for (const k in headers) x.setRequestHeader(k, headers[k]);
            x.upload.onprogress = (e) => onProgress(e.loaded);
            x.onload = () => {
              let data = null;
              try { data = JSON.parse(x.responseText); } catch (_) {}
              if (x.status >= 200 && x.status < 300) { onProgress(body.byteLength); resolve(data); }
              else { const e = new Error((data && data.error) || "Upload failed (" + x.status + ")"); e.status = x.status; reject(e); }
            };
            x.onerror = () => reject(new Error("Connection lost."));
            x.ontimeout = () => reject(new Error("Connection timed out."));
            x.send(body);
          });
        } catch (e) {
          onProgress(0);
          const retryable = !e.status || e.status >= 500 || e.status === 429 || e.status === 408;
          if (!retryable || attempt >= MAX_TRIES) throw e;
          await new Promise((r) => setTimeout(r, Math.min(16000, 1000 * 2 ** (attempt - 1))));
        }
      }
    }

    function paintProgress() {
      const total = job.files.reduce((s, f) => s + f.size, 0);
      const sent = job.files.reduce((s, f) => s + Math.min(f.sent, f.size), 0);
      const pct = total ? Math.floor((sent / total) * 100) : 100;
      $("pct").textContent = pct + "%";
      $("bigbar").style.width = pct + "%";
      for (const f of job.files) f.bar.style.width = (f.size ? (Math.min(f.sent, f.size) / f.size) * 100 : f.done ? 100 : 0) + "%";
      $("upBytes").textContent = fmtBytes(sent) + " of " + fmtBytes(total);
      const now = Date.now();
      speedSamples.push([now, sent]);
      speedSamples = speedSamples.filter(([t]) => now - t < 8000);
      const [t0, s0] = speedSamples[0];
      const rate = now > t0 ? ((sent - s0) / (now - t0)) * 1000 : 0;
      $("upSpeed").textContent = rate > 0 && sent < total ? fmtBytes(rate) + "/s · about " + fmtLeft(((total - sent) / rate) * 1000) + " left" : "";
    }

    /* ---- done ---- */
    function showDone() {
      $("uploadStep").hidden = true;
      $("doneStep").hidden = false;
      const link = shareUrl(job.id);
      const total = job.files.reduce((s, f) => s + f.size, 0);
      $("shareLink").value = link;
      $("openLink").href = link;
      $("doneInfo").textContent = `${job.files.length} ${job.files.length === 1 ? "file" : "files"}, ${fmtBytes(total)} — at full original quality.`;
      $("doneExp").textContent = "⏳ Link expires " + fmtDate(job.expiresAt);
      $("copyBtn").onclick = () => copy(link);
      if (navigator.share) {
        $("shareBtn").hidden = false;
        $("shareBtn").onclick = () => navigator.share({ title: job.title || "Files for you", url: link }).catch(() => {});
      }
      $("deleteBtn").onclick = async () => {
        if (!confirm("Delete these files now? The link will stop working straight away.")) return;
        await del(job.id, job.owner);
        location.href = location.pathname;
      };
      $("againBtn").onclick = () => { location.href = location.pathname; };
    }

    /* ---- links sent from this browser ---- */
    function remember() {
      const list = store.get("send-recent", []).filter((r) => r.expiresAt > Date.now());
      list.unshift({
        id: job.id, owner: job.owner, expiresAt: job.expiresAt,
        title: job.title || job.files[0].name + (job.files.length > 1 ? ` + ${job.files.length - 1} more` : ""),
        count: job.files.length, total: job.files.reduce((s, f) => s + f.size, 0),
      });
      store.set("send-recent", list.slice(0, 30));
    }

    async function del(id, owner) {
      try { await api("/api/t/" + id, { method: "DELETE", headers: { "X-Owner-Token": owner } }); }
      catch (e) { if (e.status !== 404 && e.status !== 410) { alert(e.message); return; } }
      store.set("send-recent", store.get("send-recent", []).filter((r) => r.id !== id));
      toast("Deleted");
    }

    function renderRecent() {
      const list = store.get("send-recent", []).filter((r) => r.expiresAt > Date.now());
      store.set("send-recent", list);
      $("recent").hidden = !list.length;
      const ul = $("recentList");
      ul.textContent = "";
      for (const r of list) {
        const li = el("li");
        const t = el("div", "rt");
        t.append(el("b", null, r.title), el("span", null, `${r.count} ${r.count === 1 ? "file" : "files"} · ${fmtBytes(r.total)} · expires in ${fmtLeft(r.expiresAt - Date.now())}`));
        const c = el("button", "btn sm", "Copy");
        c.onclick = () => copy(shareUrl(r.id));
        const d = el("button", "btn sm danger", "Delete");
        d.onclick = async () => { if (confirm(`Delete "${r.title}" now?`)) { await del(r.id, r.owner); renderRecent(); } };
        li.append(t, c, d);
        ul.append(li);
      }
    }

    renderPicked();
    renderRecent();
  }

  /* ====================================================================
   * RECEIVER
   * ================================================================== */
  async function receive(id) {
    $("getView").hidden = false;
    document.title = "Files for you — Linear Send";
    let t;
    try {
      t = await api("/api/t/" + encodeURIComponent(id));
    } catch (e) {
      $("getLoading").hidden = true;
      $("getGone").hidden = false;
      if (e.status === 410) return;
      if (e.status === 409) { $("goneTitle").textContent = "Almost there"; $("goneText").textContent = e.message; return; }
      $("goneTitle").textContent = e.status === 404 ? "This link doesn't work" : "Couldn't load this link";
      $("goneText").textContent = e.message;
      return;
    }
    $("getLoading").hidden = true;
    $("getBody").hidden = false;
    $("getTitle").textContent = t.title || (t.files.length === 1 ? t.files[0].name.split("/").pop() : "Files for you");
    if (t.title) document.title = t.title + " — Linear Send";
    if (t.message) { $("getMsg").hidden = false; $("getMsg").textContent = t.message; }

    const paintExpiry = () => {
      const left = t.expiresAt - Date.now();
      if (left <= 0) { $("getBody").hidden = true; $("getGone").hidden = false; return; }
      $("getExpire").textContent = "";
      $("getExpire").append("Available for ", el("b", null, fmtLeft(left)), " · until " + fmtDate(t.expiresAt));
    };
    paintExpiry();
    setInterval(paintExpiry, 30000);

    const ul = $("getList");
    for (const f of t.files) {
      const li = el("li");
      li.append(el("span", "fic", icon(f.name, f.type)));
      const m = el("div", "fmeta");
      m.append(el("div", "fname", f.name), el("div", "fsize", fmtBytes(f.size)));
      const a = el("a", "btn sm", "⬇");
      a.href = `${API}/dl/${t.id}/${f.n}`;
      a.title = "Download " + f.name;
      a.setAttribute("aria-label", "Download " + f.name);
      li.append(m, a);
      ul.append(li);
    }
    $("getCount").textContent = t.files.length + (t.files.length === 1 ? " file" : " files");
    $("getSize").textContent = fmtBytes(t.total);

    const zip = $("zipBtn");
    if (t.files.length === 1) {
      zip.textContent = "⬇ Download (" + fmtBytes(t.total) + ")";
      zip.href = `${API}/dl/${t.id}/0`;
    } else if (t.zip) {
      zip.textContent = "⬇ Download all (" + fmtBytes(t.total) + ")";
      zip.href = `${API}/dl/${t.id}/all`;
    } else {
      zip.hidden = true;
    }
  }
})();
