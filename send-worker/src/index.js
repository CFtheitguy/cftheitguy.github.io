/* =============================================================================
 * Linear Send — send.linearit.co
 * =============================================================================
 * Send several files with one link, at their full original size, and have the
 * link stop working after a set time. The WeTransfer idea, on our own bucket.
 *
 * NOTHING IS RE-ENCODED
 *   Files are stored byte for byte in R2 and handed back byte for byte. There
 *   is no image resizing, no video transcoding and no compression anywhere in
 *   the path — a 40 MB photo comes out as the same 40 MB photo. "Download all"
 *   builds a ZIP with the *store* method (no compression), so even the bundle
 *   is the originals laid end to end with a few headers between them.
 *
 * HOW AN UPLOAD WORKS
 *   1. POST /api/t                       -> id, owner token, part size
 *   2. for each file:
 *        small  PUT  /api/t/:id/f/:n              (whole file, one request)
 *        large  POST /api/t/:id/f/:n/start        -> uploadId
 *               PUT  /api/t/:id/f/:n?upload=U&part=P   (16 MiB each, in parallel)
 *               POST /api/t/:id/f/:n/complete     {upload, parts}
 *   3. POST /api/t/:id/finish {crcs}     -> checks every file landed at its
 *                                           exact size, then opens the link
 *   Big files go up in parts because one Worker request is capped at 100 MB;
 *   parts also mean a dropped connection only costs one part, not the file.
 *   Nothing about the upload writes the manifest except steps 1 and 3, so
 *   parallel parts can never race each other.
 *
 * THE LINK EXPIRES
 *   Every request checks expiresAt first, so a link is dead the second it
 *   runs out. An hourly cron then deletes the bytes. It finds what to delete
 *   through an index of empty keys, exp/<13-digit ms>/<id>, which R2 lists in
 *   time order — the sweep reads only what is actually due.
 *
 * R2 LAYOUT
 *   t/<id>/meta.json     the manifest (names, sizes, CRCs, expiry, owner hash)
 *   t/<id>/f/<n>         file n, exactly as sent
 *   exp/<ms>/<id>        expiry index, zero bytes
 *
 * ENDPOINTS
 *   POST   /api/t                         create a transfer (needs UPLOAD_KEY if set)
 *   PUT    /api/t/:id/f/:n                upload a small file whole       (owner)
 *   POST   /api/t/:id/f/:n/start          begin a multipart upload        (owner)
 *   PUT    /api/t/:id/f/:n?upload&part    upload one part                 (owner)
 *   POST   /api/t/:id/f/:n/complete       finish a multipart upload       (owner)
 *   POST   /api/t/:id/finish              open the link                   (owner)
 *   DELETE /api/t/:id                     delete now                      (owner)
 *   GET    /api/t/:id                     what's in it (public, if the link is live)
 *   GET    /dl/:id/:n                     one file, Range supported
 *   GET    /dl/:id/all                    every file as one uncompressed ZIP
 *   GET    /api/health                    "ok"
 *   GET    /*                             reverse-proxy of APP_ORIGIN + APP_PATH
 *
 * ENV
 *   FILES            R2 bucket binding (required)
 *   UPLOAD_KEY       secret; when set, creating a transfer needs it
 *   MAX_TRANSFER_GB  cap on one transfer (default 10)
 *   MAX_DAYS         longest allowed expiry (default 14)
 *   APP_ORIGIN / APP_PATH   where the front-end lives
 * ========================================================================== */

const PART_SIZE = 16 * 1024 * 1024;     // multipart part size; every part but the last is exactly this
const MAX_FILES = 500;                  // files in one transfer
const MAX_NAME = 240;                   // characters in one file name (incl. folders)
const MAX_TITLE = 120;
const MAX_MESSAGE = 2000;
const HOUR = 3600 * 1000;
const EXPIRY_CHOICES = [1, 24, 72, 168, 336]; // hours offered to senders (clamped by MAX_DAYS)
const ID_RE = /^[A-Za-z0-9]{22}$/;

const ALLOWED_ORIGINS = [
  "https://www.linearit.co",
  "https://linearit.co",
  "https://send.linearit.co",
  "https://cftheitguy.github.io",
];

/* ============================================================
 * The Worker
 * ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return text("ok");
      if (path.startsWith("/api/")) {
        if (request.method === "OPTIONS") return preflight(request, url);
        const res = await api(request, env, ctx, url);
        return withCors(res, request, url);
      }
      if (path.startsWith("/dl/")) return await download(request, env, ctx, url);
      return await proxyApp(request, env, url);
    } catch (err) {
      console.error(err && err.stack || err);
      const res = json({ error: "Something went wrong on our side. Please try again." }, 500);
      return path.startsWith("/api/") ? withCors(res, request, url) : res;
    }
  },

  // Hourly: delete everything whose time is up.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};

/* ============================================================
 * API
 * ============================================================ */
async function api(request, env, ctx, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api","t",id,"f",n,"start"]
  if (parts[1] !== "t") return json({ error: "Not found" }, 404);
  const m = request.method;

  if (parts.length === 2) {
    if (m === "POST") return createTransfer(request, env);
    return json({ error: "Method not allowed" }, 405);
  }

  const id = parts[2];
  if (!ID_RE.test(id)) return json({ error: "That link isn't right." }, 404);
  const meta = await loadMeta(env, id);
  if (!meta) return json({ error: "This transfer doesn't exist, or it has already been deleted." }, 404);
  if (isExpired(meta)) {
    ctx.waitUntil(removeTransfer(env, meta));
    return json({ error: "This link has expired and the files have been deleted." }, 410);
  }

  if (parts.length === 3) {
    if (m === "GET") {
      if (meta.status !== "ready") return json({ error: "These files are still being uploaded. Try again in a moment." }, 409);
      return json(publicView(meta));
    }
    if (m === "DELETE") {
      if (!(await isOwner(request, meta))) return json({ error: "Only the sender can delete this." }, 403);
      await removeTransfer(env, meta);
      return json({ ok: true });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  // Everything below is the sender, mid-upload.
  if (!(await isOwner(request, meta))) return json({ error: "Only the sender can do that." }, 403);

  if (parts.length === 4 && parts[3] === "finish" && m === "POST") return finishTransfer(request, env, meta);

  if (parts[3] !== "f") return json({ error: "Not found" }, 404);
  const n = Number(parts[4]);
  const file = Number.isInteger(n) ? meta.files[n] : null;
  if (!file) return json({ error: "No such file in this transfer." }, 404);
  if (meta.status !== "uploading") return json({ error: "This transfer is already finished." }, 409);
  const key = fileKey(id, n);
  const opts = { httpMetadata: { contentType: file.type } };

  if (parts.length === 5 && m === "PUT") {
    const upload = url.searchParams.get("upload");
    if (!upload) {
      // Whole file in one go.
      if (file.size > PART_SIZE) return json({ error: "File too large for a single request." }, 400);
      if (contentLength(request) !== file.size) return json({ error: "Size doesn't match what was announced." }, 400);
      await env.FILES.put(key, request.body, opts);
      return json({ ok: true });
    }
    const part = Number(url.searchParams.get("part"));
    const count = Math.ceil(file.size / PART_SIZE);
    if (!Number.isInteger(part) || part < 1 || part > count) return json({ error: "Bad part number." }, 400);
    // R2 requires every part except the last to be the same size; enforce it
    // here so a bad part fails now rather than at the very end.
    const expected = Math.min(PART_SIZE, file.size - (part - 1) * PART_SIZE);
    if (contentLength(request) !== expected) return json({ error: "Part size doesn't match." }, 400);
    const mp = env.FILES.resumeMultipartUpload(key, upload);
    const done = await mp.uploadPart(part, request.body);
    return json({ partNumber: done.partNumber, etag: done.etag });
  }

  if (parts.length === 6 && parts[5] === "start" && m === "POST") {
    const mp = await env.FILES.createMultipartUpload(key, opts);
    return json({ upload: mp.uploadId, partSize: PART_SIZE });
  }

  if (parts.length === 6 && parts[5] === "complete" && m === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.upload !== "string" || !Array.isArray(body.parts)) return json({ error: "Bad request." }, 400);
    const list = body.parts
      .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || "") }))
      .sort((a, b) => a.partNumber - b.partNumber);
    const mp = env.FILES.resumeMultipartUpload(key, body.upload);
    await mp.complete(list);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

async function createTransfer(request, env) {
  if (env.UPLOAD_KEY) {
    const given = request.headers.get("X-Upload-Key") || "";
    if (!(await safeEqual(given, env.UPLOAD_KEY))) {
      return json({ error: "An upload key is needed to send files.", needKey: true }, 401);
    }
  }
  const body = await readJson(request);
  if (!body || !Array.isArray(body.files) || body.files.length === 0) return json({ error: "Add at least one file." }, 400);
  if (body.files.length > MAX_FILES) return json({ error: `Up to ${MAX_FILES} files per transfer.` }, 400);

  const maxBytes = num(env.MAX_TRANSFER_GB, 10) * 1024 ** 3;
  const maxHours = num(env.MAX_DAYS, 14) * 24;
  const hours = Number(body.hours);
  if (!EXPIRY_CHOICES.includes(hours) || hours > maxHours) return json({ error: "Pick how long the link should last." }, 400);

  const used = new Set();
  let total = 0;
  const files = [];
  for (const f of body.files) {
    const size = Number(f && f.size);
    if (!Number.isSafeInteger(size) || size < 0) return json({ error: "A file has an impossible size." }, 400);
    total += size;
    files.push({
      name: uniqueName(cleanName(f.name), used),
      size,
      type: cleanType(f.type),
      modified: Number.isSafeInteger(f.modified) ? f.modified : null,
    });
  }
  if (total > maxBytes) return json({ error: `That's ${fmtBytes(total)} — the limit is ${fmtBytes(maxBytes)} per transfer.` }, 413);

  const id = randomId(22);
  const ownerToken = randomId(32);
  const now = Date.now();
  const meta = {
    v: 1,
    id,
    status: "uploading",
    created: now,
    expiresAt: now + hours * HOUR,
    title: clip(body.title, MAX_TITLE),
    message: clip(body.message, MAX_MESSAGE),
    ownerHash: await sha256(ownerToken),
    total,
    files,
  };
  await saveMeta(env, meta);
  await env.FILES.put(expKey(meta), new Uint8Array(0));
  return json({ id, ownerToken, partSize: PART_SIZE, expiresAt: meta.expiresAt, files: files.map((f) => f.name) }, 201);
}

async function finishTransfer(request, env, meta) {
  if (meta.status === "ready") return json(publicView(meta));
  const body = (await readJson(request)) || {};
  const crcs = Array.isArray(body.crcs) ? body.crcs : [];
  // Check every file really landed, at exactly the size the sender announced.
  // This is the "nothing was lost" guarantee: a short or missing file stops
  // the link from ever opening.
  for (let n = 0; n < meta.files.length; n++) {
    const head = await env.FILES.head(fileKey(meta.id, n));
    const want = meta.files[n].size;
    if (!head || head.size !== want) {
      return json({ error: `"${meta.files[n].name}" didn't finish uploading. Please try again.`, file: n }, 409);
    }
    const c = Number(crcs[n]);
    meta.files[n].crc = Number.isInteger(c) && c >= 0 && c <= 0xffffffff ? c : null;
  }
  meta.status = "ready";
  meta.finished = Date.now();
  await saveMeta(env, meta);
  return json(publicView(meta));
}

/* ============================================================
 * Downloads
 * ============================================================ */
async function download(request, env, ctx, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return text("Method Not Allowed", 405);
  const [, , id, which] = url.pathname.split("/");
  if (!ID_RE.test(id || "")) return page("That link isn't right.", 404);
  const meta = await loadMeta(env, id);
  if (!meta || meta.status !== "ready") return page("This transfer doesn't exist, or it has already been deleted.", 404);
  if (isExpired(meta)) {
    ctx.waitUntil(removeTransfer(env, meta));
    return page("This link has expired and the files have been deleted.", 410);
  }
  if (which === "all") return zipAll(request, env, ctx, meta);

  const n = Number(which);
  const file = Number.isInteger(n) ? meta.files[n] : null;
  if (!file) return page("No such file in this transfer.", 404);

  const key = fileKey(id, n);
  const range = parseRange(request.headers.get("Range"), file.size);
  if (range === false) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
  }
  const headers = downloadHeaders(baseName(file.name), file.type || "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Last-Modified", new Date(meta.finished || meta.created).toUTCString());

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(file.size));
    return new Response(null, { status: 200, headers });
  }
  const obj = await env.FILES.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!obj) return page("This file is missing.", 404);
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(obj.body, { status: 200, headers });
}

/* One uncompressed (STORE) ZIP of every file, streamed straight from R2.
 * The Worker never looks at the file bytes — it writes a header, pipes the
 * object through untouched, writes the next header — so CPU cost is flat no
 * matter how big the transfer is. That only works because CRC-32s were worked
 * out in the sender's browser during upload; without them the Worker would
 * have to read every byte. The total length is known in advance, so the
 * browser shows a real progress bar. ZIP64 is used when anything passes 4 GB. */
async function zipAll(request, env, ctx, meta) {
  if (meta.files.some((f) => f.crc == null)) return page("This transfer can only be downloaded one file at a time.", 409);
  const plan = zipPlan(meta);
  const name = (safeFileName(meta.title) || "linear-send-" + meta.id.slice(0, 6)) + ".zip";
  const headers = downloadHeaders(name, "application/zip");
  headers.set("Content-Length", String(plan.total));
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const { readable, writable } = new FixedLengthStream(plan.total);
  ctx.waitUntil((async () => {
    let writer = writable.getWriter();
    try {
      for (let n = 0; n < meta.files.length; n++) {
        await writer.write(plan.entries[n].local);
        const obj = await env.FILES.get(fileKey(meta.id, n));
        if (!obj) throw new Error("missing file " + n);
        writer.releaseLock();
        await obj.body.pipeTo(writable, { preventClose: true });
        writer = writable.getWriter();
      }
      await writer.write(plan.tail);
      await writer.close();
    } catch (err) {
      console.error("zip failed", meta.id, err && err.message);
      try { await writable.abort(err); } catch (_) {}
    }
  })());
  return new Response(readable, { status: 200, headers });
}

function zipPlan(meta) {
  const enc = new TextEncoder();
  const d = new Date(meta.finished || meta.created);
  const dosTime = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const dosDate = (Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const MAX32 = 0xffffffff;
  const entries = [];
  const central = [];
  let offset = 0;

  for (const f of meta.files) {
    const name = enc.encode(f.name);
    const big = f.size >= MAX32;
    const bigOffset = offset >= MAX32;
    const zip64 = big || bigOffset;

    // Local header. When the file is big, both sizes go in a ZIP64 extra.
    const lextra = big ? 20 : 0;
    const local = new Uint8Array(30 + name.length + lextra);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, zip64 ? 45 : 20, true);
    lv.setUint16(6, 0x0800, true);           // names are UTF-8
    lv.setUint16(8, 0, true);                // STORE — no compression
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, f.crc >>> 0, true);
    lv.setUint32(18, big ? MAX32 : f.size, true);
    lv.setUint32(22, big ? MAX32 : f.size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, lextra, true);
    local.set(name, 30);
    if (big) {
      const p = 30 + name.length;
      lv.setUint16(p, 0x0001, true);
      lv.setUint16(p + 2, 16, true);
      setU64(lv, p + 4, f.size);
      setU64(lv, p + 12, f.size);
    }

    // Central directory entry. Only the fields that overflowed go in its extra.
    const cfields = (big ? 2 : 0) + (bigOffset ? 1 : 0);
    const cextra = cfields ? 4 + cfields * 8 : 0;
    const cen = new Uint8Array(46 + name.length + cextra);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 45, true);
    cv.setUint16(6, zip64 ? 45 : 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, f.crc >>> 0, true);
    cv.setUint32(20, big ? MAX32 : f.size, true);
    cv.setUint32(24, big ? MAX32 : f.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, cextra, true);
    cv.setUint32(42, bigOffset ? MAX32 : offset, true);
    cen.set(name, 46);
    if (cextra) {
      let p = 46 + name.length;
      cv.setUint16(p, 0x0001, true);
      cv.setUint16(p + 2, cfields * 8, true);
      p += 4;
      if (big) { setU64(cv, p, f.size); setU64(cv, p + 8, f.size); p += 16; }
      if (bigOffset) setU64(cv, p, offset);
    }

    entries.push({ local });
    central.push(cen);
    offset += local.length + f.size;
  }

  const cdOffset = offset;
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const count = meta.files.length;
  const zip64End = cdOffset >= MAX32 || cdSize >= MAX32 || count >= 0xffff;
  const endLen = (zip64End ? 56 + 20 : 0) + 22;
  const tail = new Uint8Array(cdSize + endLen);
  let p = 0;
  for (const c of central) { tail.set(c, p); p += c.length; }
  const tv = new DataView(tail.buffer);
  if (zip64End) {
    const recOffset = cdOffset + cdSize;
    tv.setUint32(p, 0x06064b50, true);
    setU64(tv, p + 4, 44);
    tv.setUint16(p + 12, 45, true);
    tv.setUint16(p + 14, 45, true);
    tv.setUint32(p + 16, 0, true);
    tv.setUint32(p + 20, 0, true);
    setU64(tv, p + 24, count);
    setU64(tv, p + 32, count);
    setU64(tv, p + 40, cdSize);
    setU64(tv, p + 48, cdOffset);
    p += 56;
    tv.setUint32(p, 0x07064b50, true);
    tv.setUint32(p + 4, 0, true);
    setU64(tv, p + 8, recOffset);
    tv.setUint32(p + 16, 1, true);
    p += 20;
  }
  tv.setUint32(p, 0x06054b50, true);
  tv.setUint16(p + 4, 0, true);
  tv.setUint16(p + 6, 0, true);
  tv.setUint16(p + 8, zip64End ? 0xffff : count, true);
  tv.setUint16(p + 10, zip64End ? 0xffff : count, true);
  tv.setUint32(p + 12, zip64End ? MAX32 : cdSize, true);
  tv.setUint32(p + 16, zip64End ? MAX32 : cdOffset, true);
  tv.setUint16(p + 20, 0, true);

  return { entries, tail, total: offset + tail.length };
}

function setU64(view, at, n) {
  view.setUint32(at, n % 0x100000000, true);
  view.setUint32(at + 4, Math.floor(n / 0x100000000), true);
}

/* ============================================================
 * Expiry
 * ============================================================ */
async function sweep(env) {
  const now = Date.now();
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: "exp/", cursor, limit: 500 });
    for (const obj of page.objects) {
      const [, ms, id] = obj.key.split("/");
      if (Number(ms) > now) return; // listed in time order: everything after this is still live
      await removeById(env, id);
      await env.FILES.delete(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function removeTransfer(env, meta) {
  await removeById(env, meta.id);
  await env.FILES.delete(expKey(meta));
}

async function removeById(env, id) {
  if (!ID_RE.test(id || "")) return;
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: `t/${id}/`, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.FILES.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/* ============================================================
 * Serve the app itself from the Pages copy, so send.linearit.co and
 * www.linearit.co/send/ are always the same build.
 * ============================================================ */
async function proxyApp(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const origin = env.APP_ORIGIN || "https://www.linearit.co";
  const appPath = env.APP_PATH || "/send/";
  const path = url.pathname === "/" ? appPath : url.pathname;
  let originResp;
  try {
    originResp = await fetch(origin + path, {
      method: "GET",
      headers: { Accept: request.headers.get("Accept") || "*/*", "Accept-Encoding": "gzip" },
      redirect: "follow",
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } catch (_) {
    return new Response("Linear Send is briefly unavailable. Please try again in a moment.", {
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
  headers.set("X-Served-By", "linear-send");
  return new Response(request.method === "HEAD" ? null : originResp.body, {
    status: originResp.status, statusText: originResp.statusText, headers,
  });
}

/* ============================================================
 * Helpers
 * ============================================================ */
const fileKey = (id, n) => `t/${id}/f/${n}`;
const metaKey = (id) => `t/${id}/meta.json`;
const expKey = (meta) => `exp/${String(meta.expiresAt).padStart(13, "0")}/${meta.id}`;
const isExpired = (meta) => Date.now() >= meta.expiresAt;

async function loadMeta(env, id) {
  const obj = await env.FILES.get(metaKey(id));
  if (!obj) return null;
  try { return await obj.json(); } catch (_) { return null; }
}
function saveMeta(env, meta) {
  return env.FILES.put(metaKey(meta.id), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });
}

function publicView(meta) {
  return {
    id: meta.id,
    title: meta.title,
    message: meta.message,
    created: meta.created,
    expiresAt: meta.expiresAt,
    total: meta.total,
    zip: meta.files.every((f) => f.crc != null),
    files: meta.files.map((f, n) => ({ n, name: f.name, size: f.size, type: f.type })),
  };
}

async function isOwner(request, meta) {
  const token = request.headers.get("X-Owner-Token") || "";
  if (!token) return false;
  return safeEqual(await sha256(token), meta.ownerHash);
}

// Compare two strings without leaking where they differ.
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId(len) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const out = [];
  const bytes = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) if (b < 248 && out.length < len) out.push(abc[b % 62]); // 248 = 4*62, no bias
  }
  return out.join("");
}

// Keep folder structure (from a dragged folder) but nothing that could escape it.
function cleanName(raw) {
  let s = String(raw || "").normalize("NFC").replace(/\\/g, "/");
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_");
  const segs = s.split("/").map((x) => x.trim()).filter((x) => x && x !== "." && x !== "..");
  s = segs.join("/") || "file";
  if (s.length > MAX_NAME) {
    const dot = s.lastIndexOf(".");
    const ext = dot > s.length - 12 && dot > 0 ? s.slice(dot) : "";
    s = s.slice(0, MAX_NAME - ext.length) + ext;
  }
  return s;
}

function uniqueName(name, used) {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  const slash = name.lastIndexOf("/");
  const stem = dot > slash + 1 ? name.slice(0, dot) : name;
  const ext = dot > slash + 1 ? name.slice(dot) : "";
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function cleanType(t) {
  t = String(t || "").toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) && t.length < 100 ? t : "application/octet-stream";
}

const baseName = (name) => name.slice(name.lastIndexOf("/") + 1);
const clip = (s, n) => String(s || "").trim().slice(0, n);
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const safeFileName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f\\/<>:"|?*]/g, "").trim().slice(0, 80);

function contentLength(request) {
  const v = request.headers.get("Content-Length");
  return v == null ? -1 : Number(v);
}

// Always "attachment": the browser saves the original bytes rather than
// trying to open them, and nothing uploaded can ever run as a page here.
function downloadHeaders(filename, type) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Headers({
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
  });
}

// Returns null (no range), false (unsatisfiable) or {start, end} inclusive.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) return false;
  return { start, end };
}

async function readJson(request) {
  try { return await request.json(); } catch (_) { return null; }
}

function fmtBytes(n) {
  const u = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function text(s, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
// A plain page for someone who clicked a dead download link directly.
function page(message, status) {
  const safe = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return new Response(
    `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Linear Send</title>` +
    `<body style="font:16px -apple-system,Segoe UI,Roboto,sans-serif;background:#0f1117;color:#eef0f6;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center">` +
    `<div><p style="font-size:40px;margin:0">⌛</p><p>${safe}</p><p><a style="color:#00b0ec" href="/">Send files with Linear Send</a></p></div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" } },
  );
}

function corsOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  try { if (new URL(origin).host === url.host) return origin; } catch (_) {}
  return null;
}
function withCors(res, request, url) {
  const origin = corsOrigin(request, url);
  if (!origin) return res;
  const r = new Response(res.body, res);
  r.headers.set("Access-Control-Allow-Origin", origin);
  r.headers.set("Vary", "Origin");
  return r;
}
function preflight(request, url) {
  const origin = corsOrigin(request, url);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Owner-Token, X-Upload-Key",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}
