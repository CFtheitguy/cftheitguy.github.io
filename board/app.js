/* =============================================================================
 * Linear Board — board.linearit.co
 * =============================================================================
 * A blank board two people can draw on at the same time from different
 * devices. One person opens the page and gets a link; whoever they send it to
 * lands on the same board. No app, no account, no password.
 *
 * HOW A STROKE TRAVELS
 *   You put the pen down. This file collects the points as you move, paints
 *   them on your canvas immediately, and about every 50ms sends the ones
 *   collected so far up the socket. The room relays them to everyone else,
 *   whose browsers paint the same segment. You lift the pen and a
 *   "stroke finished" message closes the item off.
 *
 *   The points go up *while the pen is still moving* on purpose. Waiting for
 *   the pen to lift means the other person sees nothing for two seconds and
 *   then a whole line appears at once, which feels broken.
 *
 * WHY EVERYTHING IS A FRACTION
 *   Coordinates and font sizes are stored as numbers between 0 and 1, so 0.5,
 *   0.5 is the middle of the board on every device. The board itself is a
 *   fixed square fitted into whatever space the window has. Fitting it rather
 *   than stretching it is what keeps a circle a circle on both a phone and a
 *   27-inch monitor, and it means both people always see the whole board
 *   instead of one of them getting a cropped piece of it. A square is the
 *   shape that wastes the least on both — a landscape board leaves a portrait
 *   phone showing a thin strip. It is also what lets the PNG export happen at
 *   three times the screen resolution without recalculating a thing.
 *
 * WHAT IS DELIBERATELY MISSING
 *   No shapes, no image upload, no accounts, no private rooms, no chat, no
 *   pointer showing where the other person is. Every one of those is a
 *   reasonable request and every one of them is out of scope for version 1.
 * ========================================================================== */
(function () {
  "use strict";

  /* ---- Where the room lives ---------------------------------------------
   * The app is served two ways: by the Worker at board.linearit.co, where the
   * socket is same-origin, and from the GitHub Pages copy at
   * www.linearit.co/board/, which has to reach across to the Worker.
   * ---------------------------------------------------------------------- */
  var PAGES_HOSTS = ["www.linearit.co", "linearit.co", "cftheitguy.github.io"];
  var onPages = PAGES_HOSTS.indexOf(location.hostname.toLowerCase()) >= 0;
  var WS_BASE = onPages
    ? "wss://board.linearit.co"
    : (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

  /* ---- Tuning ---------------------------------------------------------- */
  var AR = 1;                     // the board's shape, everywhere, always
  var SEND_MS = 50;               // how often points go up while drawing
  var MIN_STEP = 0.0008;          // ignore pen movement smaller than this
  var MAX_DPR = 2.5;              // cap the backing store on very dense screens
  var EXPORT_MIN = 2000;          // narrowest PNG we will write
  var EXPORT_MAX = 4096;          // and the widest
  var LINE = 1.25;                // text line height, as a multiple of font size
  var RETRY_MAX_MS = 15000;       // longest gap between reconnect attempts
  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

  var COLORS = ["#111827", "#dc2626", "#ea580c", "#16a34a", "#0091c9", "#7c3aed", "#db2777", "#78716c"];
  var PEN_WIDTHS = [0.0018, 0.0042, 0.0100];   // fractions of the board's width
  var TEXT_SIZES = [0.020, 0.032, 0.052];
  var DOT_PX = [6, 9, 13];                     // how the three sizes look in the toolbar

  /* Room names are read aloud down a phone line, so they are made of words
     rather than characters: "quiet-blue-otter", not "k7f2p9". */
  var ADJ = ["quiet", "brave", "sunny", "clever", "gentle", "swift", "bright", "calm", "eager", "happy",
             "keen", "lucky", "merry", "neat", "proud", "rapid", "sharp", "steady", "tidy", "warm",
             "witty", "bold", "crisp", "fair", "glad", "kind", "lively", "noble", "plain", "spry"];
  var COL = ["blue", "green", "amber", "coral", "violet", "teal", "olive", "rust", "indigo", "silver",
             "crimson", "azure", "copper", "jade", "ivory", "slate"];
  var ANI = ["otter", "heron", "falcon", "badger", "marten", "ibex", "lynx", "puffin", "raven", "salmon",
             "sparrow", "tapir", "walrus", "wombat", "gecko", "kestrel", "magpie", "narwhal", "osprey",
             "panda", "quail", "robin", "seal", "tern", "vole", "wren", "yak", "zebra", "beaver", "curlew"];

  /* ============================================================
   * Bits of the page
   * ============================================================ */
  function $(id) { return document.getElementById(id); }
  var el = {
    stage: $("stage"), paper: $("paper"), canvas: $("board"),
    roomBtn: $("roomBtn"), roomName: $("roomName"),
    status: $("status"), statusText: $("statusText"),
    themeBtn: $("themeBtn"), toast: $("toast"), note: $("note"),
    toolPen: $("toolPen"), toolText: $("toolText"),
    colors: $("colors"), sizes: $("sizes"),
    undoBtn: $("undoBtn"), clearBtn: $("clearBtn"), saveBtn: $("saveBtn")
  };
  var ctx = el.canvas.getContext("2d");
  var mctx = document.createElement("canvas").getContext("2d");  // only ever used to measure text

  /* ============================================================
   * Theme (same key style as the other Linear apps)
   * ============================================================ */
  var THEME_KEY = "lboard_theme";
  (function () {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
    if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
    paintThemeButton();
  })();
  function paintThemeButton() {
    var set = document.documentElement.getAttribute("data-theme");
    var light = set === "light" ||
      (!set && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    el.themeBtn.textContent = light ? "☀️" : "🌙";
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", light ? "#f4f6fb" : "#0f1117");
  }
  el.themeBtn.addEventListener("click", function () {
    var set = document.documentElement.getAttribute("data-theme");
    var light = set === "light" ||
      (!set && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    var next = light ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    paintThemeButton();
  });

  /* ============================================================
   * Who you are, and which board you are on
   * ============================================================
   * The client id is kept in localStorage rather than made fresh each visit,
   * so that closing the tab and coming back still lets you undo the things
   * *you* drew — undo removes your own last item, not the room's.
   * ========================================================================= */
  var CID = (function () {
    var k = "lboard_cid", v = null;
    try { v = localStorage.getItem(k); } catch (_) {}
    if (!v || !/^[a-z0-9]{6,32}$/.test(v)) {
      v = randomId(16);
      try { localStorage.setItem(k, v); } catch (_) {}
    }
    return v;
  })();

  var room = "";
  var itemSeq = 0;

  function randomId(n) {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var bytes = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
    return out;
  }
  function pick(list) {
    var b = new Uint32Array(1);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return list[b[0] % list.length];
  }
  function newItemId() { return CID.slice(0, 8) + "-" + (++itemSeq).toString(36) + "-" + randomId(4); }

  /* The room name lives in the URL fragment. A fragment never reaches a
     server, which is why the socket passes it along as a query parameter. */
  function roomFromHash() {
    var h = "";
    try { h = decodeURIComponent((location.hash || "").replace(/^#/, "")); } catch (_) { h = ""; }
    h = h.toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
    return /^[a-z0-9][a-z0-9-]{1,63}$/.test(h) ? h : "";
  }
  function adoptRoom() {
    var name = roomFromHash();
    if (!name) {
      name = pick(ADJ) + "-" + pick(COL) + "-" + pick(ANI);
      try { history.replaceState(null, "", "#" + name); } catch (_) { location.hash = name; }
    }
    room = name;
    el.roomName.textContent = name;
    document.title = "Linear Board — " + name;
  }

  /* ============================================================
   * The board's contents
   * ============================================================
   * One ordered list holds strokes and text together, so undo, clear and
   * replaying history all work on either with no special cases.
   *   stroke: {id, kind:"stroke", by, color, width, pts:[x,y,x,y,…]}
   *   text:   {id, kind:"text",   by, color, x, y, size, text}
   * ========================================================================= */
  var items = [];
  var byId = new Map();
  var mine = [];            // ids I drew, oldest first — the undo stack
  var painted = new Map();  // id -> how many points of that stroke are on screen
  var unsent = new Set();   // ids created while the socket was down

  var BW = 0, BH = 0;       // the board's size in CSS pixels
  var rect = null;          // its position, cached for the length of a stroke

  var tool = "pen";
  var colorIdx = 0;
  var sizeIdx = 1;
  function color() { return COLORS[colorIdx]; }

  function resetBoard() {
    items = []; byId = new Map(); mine = []; painted = new Map(); unsent = new Set();
    redraw(); updateUndo();
  }
  function addItem(it) {
    items.push(it); byId.set(it.id, it);
    if (it.by === CID) { mine.push(it.id); updateUndo(); }
  }
  function removeItem(id) {
    var it = byId.get(id);
    if (!it) return;
    byId.delete(id); painted.delete(id); unsent.delete(id);
    var at = items.indexOf(it);
    if (at >= 0) items.splice(at, 1);
    var mi = mine.indexOf(id);
    if (mi >= 0) mine.splice(mi, 1);
    updateUndo();
  }
  function updateUndo() { el.undoBtn.disabled = mine.length === 0; }

  /* ============================================================
   * Layout — fit the paper, size the canvas
   * ============================================================ */
  function layout() {
    commitText();   // a half-typed box has nowhere sensible to go when the board moves

    var sw = el.stage.clientWidth, sh = el.stage.clientHeight;
    var w = sw, h = sw / AR;
    if (h > sh) { h = sh; w = sh * AR; }
    BW = Math.max(160, Math.floor(w));
    BH = Math.max(120, Math.floor(h));

    el.paper.style.width = BW + "px";
    el.paper.style.height = BH + "px";

    var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    el.canvas.width = Math.round(BW * dpr);
    el.canvas.height = Math.round(BH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // so we can keep thinking in CSS pixels

    rect = el.canvas.getBoundingClientRect();
    redraw();
  }
  if (window.ResizeObserver) new ResizeObserver(layout).observe(el.stage);
  window.addEventListener("resize", layout);
  window.addEventListener("orientationchange", function () { setTimeout(layout, 120); });

  /* ============================================================
   * Painting
   * ============================================================
   * Two paths into the same drawing code:
   *   redraw()  repaints everything — used after undo, clear, history
   *   paintNew() paints only the part of a stroke that is not on screen yet,
   *              which is what keeps a live line cheap to follow
   * ========================================================================= */
  function redraw() {
    paintAll(ctx, BW, BH);
    painted = new Map();
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === "stroke") painted.set(items[i].id, items[i].pts.length / 2);
    }
  }

  function paintAll(c, W, H) {
    // White first, always. A canvas with nothing on it is transparent, and a
    // transparent PNG shows up black in a lot of viewers.
    c.save();
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, W, H);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === "stroke") paintStroke(c, it, W, H, 0);
      else paintText(c, it, W, H);
    }
    c.restore();
  }

  function paintStroke(c, it, W, H, from) {
    var p = it.pts;
    var pairs = p.length / 2;
    if (pairs < 1) return;

    c.save();
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = it.color;
    c.fillStyle = it.color;
    c.lineWidth = Math.max(0.7, it.width * W);

    if (pairs === 1) {                      // a tap, not a drag: leave a dot
      c.beginPath();
      c.arc(p[0] * W, p[1] * H, c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
    } else if (from < pairs - 1) {
      c.beginPath();
      c.moveTo(p[from * 2] * W, p[from * 2 + 1] * H);
      for (var i = from + 1; i < pairs; i++) c.lineTo(p[i * 2] * W, p[i * 2 + 1] * H);
      c.stroke();
    }
    c.restore();
  }

  function paintText(c, it, W, H) {
    var px = it.size * W;
    c.save();
    c.font = "600 " + px + "px " + FONT;   // a system stack, so the export can't fall back to something else
    c.fillStyle = it.color;
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(it.text, it.x * W, it.y * H + (px * LINE) / 2);
    c.restore();
  }

  /* Paint only what has arrived since last time. */
  function paintNew(it) {
    var pairs = it.pts.length / 2;
    var from = painted.has(it.id) ? painted.get(it.id) : 0;
    if (pairs === from) return;
    paintStroke(ctx, it, BW, BH, Math.max(0, from - 1));
    painted.set(it.id, pairs);
  }

  /* ============================================================
   * Drawing with a pen, a finger or a mouse
   * ============================================================ */
  var active = null;     // the stroke currently under the pen
  var penSeen = false;   // a stylus has been used on this device

  function norm(e) {
    var r = rect || el.canvas.getBoundingClientRect();
    return [
      round4(clamp01((e.clientX - r.left) / r.width)),
      round4(clamp01((e.clientY - r.top) / r.height))
    ];
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function round4(v) { return Math.round(v * 10000) / 10000; }

  el.canvas.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;

    // Palm rejection: once a stylus has been seen on this device, plain touch
    // stops drawing, so a hand resting on a tablet doesn't leave a stray line.
    // On a finger-only tablet there is no clean way to tell the two apart.
    if (e.pointerType === "pen") penSeen = true;
    else if (e.pointerType === "touch" && penSeen) return;

    rect = el.canvas.getBoundingClientRect();

    if (tool === "text") { e.preventDefault(); openTextBox(norm(e)); return; }
    if (active) return;                      // one stroke at a time

    e.preventDefault();
    commitText();
    try { el.canvas.setPointerCapture(e.pointerId); } catch (_) {}

    var p = norm(e);
    var it = {
      id: newItemId(), kind: "stroke", by: CID,
      color: color(), width: PEN_WIDTHS[sizeIdx], pts: [p[0], p[1]]
    };
    addItem(it);
    paintNew(it);

    active = { id: it.id, item: it, pointerId: e.pointerId, pending: [], lastSend: Date.now() };
    if (!send({ t: "stroke_start", id: it.id, color: it.color, width: it.width, pts: [p[0], p[1]] })) {
      unsent.add(it.id);
    }
  });

  el.canvas.addEventListener("pointermove", function (e) {
    if (!active || e.pointerId !== active.pointerId) return;
    e.preventDefault();

    // Coalesced events give every sample the device actually took between
    // frames, which is the difference between a smooth curve and a polygon.
    var moves = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
    var it = active.item;
    for (var i = 0; i < moves.length; i++) {
      var p = norm(moves[i]);
      var n = it.pts.length;
      if (n >= 2 && Math.abs(p[0] - it.pts[n - 2]) < MIN_STEP && Math.abs(p[1] - it.pts[n - 1]) < MIN_STEP) continue;
      it.pts.push(p[0], p[1]);
      active.pending.push(p[0], p[1]);
    }
    paintNew(it);

    if (Date.now() - active.lastSend >= SEND_MS) flushPoints();
  });

  function endStroke(e) {
    if (!active || (e && e.pointerId !== active.pointerId)) return;
    flushPoints();
    if (!send({ t: "stroke_end", id: active.id })) unsent.add(active.id);
    try { el.canvas.releasePointerCapture(active.pointerId); } catch (_) {}
    active = null;
  }
  el.canvas.addEventListener("pointerup", endStroke);
  el.canvas.addEventListener("pointercancel", endStroke);
  el.canvas.addEventListener("lostpointercapture", endStroke);
  el.canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  function flushPoints() {
    if (!active || !active.pending.length) return;
    var pts = active.pending;
    active.pending = [];
    active.lastSend = Date.now();
    if (!send({ t: "stroke_points", id: active.id, pts: pts })) unsent.add(active.id);
  }

  /* ============================================================
   * The text tool
   * ============================================================
   * A real input box is placed on top of the canvas at the spot you tapped.
   * Nothing is painted, and nothing is sent, until you finish — the other
   * person sees the finished text arrive in one piece. Streaming every
   * keystroke is noisy and almost never what anyone wants.
   *
   * Once placed, text is a finished item like a stroke: it can be undone or
   * cleared, not edited, and two people can never be inside the same piece of
   * text at once. Live collaborative text editing is an entire category of
   * hard problem and has no business in version 1.
   * ========================================================================= */
  var textEl = null, textAt = null, textPx = 0, textColor = "#111827";

  function openTextBox(p) {
    commitText();
    textAt = p;
    textPx = TEXT_SIZES[sizeIdx] * BW;
    textColor = color();

    var input = document.createElement("input");
    input.type = "text";
    input.className = "textbox";
    input.maxLength = 400;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "sentences");
    input.setAttribute("aria-label", "Type text for the board");
    input.spellcheck = false;
    input.style.left = (p[0] * BW) + "px";
    input.style.top = (p[1] * BH) + "px";
    input.style.fontSize = textPx + "px";
    input.style.lineHeight = (textPx * LINE) + "px";
    input.style.height = (textPx * LINE) + "px";
    input.style.color = textColor;
    el.paper.appendChild(input);
    textEl = input;
    growTextBox();

    input.addEventListener("input", growTextBox);
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === "Escape") { ev.preventDefault(); commitText(); }
    });
    input.addEventListener("blur", commitText);

    // Focused inside the pointer event itself: iOS only raises the keyboard
    // for a focus() that is still part of the user's gesture.
    try { input.focus(); } catch (_) {}
    setTimeout(keyboardFit, 0);
  }

  function growTextBox() {
    if (!textEl) return;
    mctx.font = "600 " + textPx + "px " + FONT;
    var w = mctx.measureText(textEl.value || " ").width + textPx * 0.7;
    var avail = BW - textAt[0] * BW - 4;
    textEl.style.width = Math.max(textPx, Math.min(w, avail)) + "px";
    keyboardFit();
  }

  function commitText() {
    var input = textEl;
    if (!input) return;
    textEl = null;
    input.removeEventListener("blur", commitText);
    var value = (input.value || "").trim();
    input.remove();
    liftPage(0);
    if (!value) return;

    var it = {
      id: newItemId(), kind: "text", by: CID, color: textColor,
      x: textAt[0], y: textAt[1], size: round4(textPx / BW), text: value
    };
    addItem(it);
    paintText(ctx, it, BW, BH);
    if (!send({ t: "text_add", id: it.id, x: it.x, y: it.y, size: it.size, color: it.color, text: it.text })) {
      unsent.add(it.id);
    }
  }

  /* Tapping to place text opens the phone keyboard, which covers half the
     screen. Nothing on this page scrolls, so the page itself is lifted just
     far enough to keep the insertion point above the keyboard. */
  var lifted = 0;
  function liftPage(px) {
    if (px === lifted) return;
    lifted = px;
    document.body.style.transform = px ? "translateY(" + (-px) + "px)" : "";
  }
  function keyboardFit() {
    if (!textEl || !window.visualViewport) return;
    liftPage(0);                                   // measure unshifted, then decide
    var vv = window.visualViewport;
    var box = textEl.getBoundingClientRect();
    var overlap = box.bottom + 16 - (vv.height + vv.offsetTop);
    if (overlap > 0) liftPage(Math.round(overlap));
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", keyboardFit);
    window.visualViewport.addEventListener("scroll", keyboardFit);
  }

  /* ============================================================
   * Undo, clear, save
   * ============================================================ */
  el.undoBtn.addEventListener("click", function () {
    // Your own last item, not the room's. If you draw, then I draw, then you
    // press undo, taking yours back is far less surprising than reaching
    // across and deleting mine.
    while (mine.length) {
      var id = mine[mine.length - 1];
      if (!byId.has(id)) { mine.pop(); continue; }
      removeItem(id);
      redraw();
      if (!send({ t: "undo", id: id })) unsent.delete(id);
      return;
    }
  });

  el.clearBtn.addEventListener("click", function () {
    if (!items.length) { toast("The board is already empty."); return; }
    if (!window.confirm("Erase the whole board for everyone in this room?")) return;
    resetBoard();
    send({ t: "clear" });
  });

  el.saveBtn.addEventListener("click", function () {
    commitText();
    // Drawn to an off-screen canvas at roughly three times the display size,
    // so the saved file isn't a blurry screenshot of a phone.
    var W = Math.min(EXPORT_MAX, Math.max(EXPORT_MIN, Math.round(BW * 3)));
    var H = Math.round(W / AR);
    var out = document.createElement("canvas");
    out.width = W; out.height = H;
    paintAll(out.getContext("2d"), W, H);

    var name = room + "-" + new Date().toISOString().slice(0, 10) + ".png";
    out.toBlob(function (blob) {
      if (!blob) { toast("Could not build the image."); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast("Saved " + name);
    }, "image/png");
  });

  /* ============================================================
   * Toolbar
   * ============================================================ */
  function setTool(next) {
    tool = next;
    if (next !== "text") commitText();
    el.toolPen.setAttribute("aria-pressed", String(next === "pen"));
    el.toolText.setAttribute("aria-pressed", String(next === "text"));
    el.paper.classList.toggle("text-tool", next === "text");
  }
  el.toolPen.addEventListener("click", function () { setTool("pen"); });
  el.toolText.addEventListener("click", function () { setTool("text"); });

  (function buildColors() {
    COLORS.forEach(function (hex, i) {
      var b = document.createElement("button");
      b.className = "swatch";
      b.style.background = hex;
      b.setAttribute("aria-pressed", String(i === colorIdx));
      b.setAttribute("aria-label", "Colour " + (i + 1));
      b.title = "Colour " + (i + 1);
      b.addEventListener("click", function () {
        colorIdx = i;
        var all = el.colors.children;
        for (var k = 0; k < all.length; k++) all[k].setAttribute("aria-pressed", String(k === i));
        if (textEl) { textColor = hex; textEl.style.color = hex; }
      });
      el.colors.appendChild(b);
    });
  })();

  (function buildSizes() {
    DOT_PX.forEach(function (px, i) {
      var b = document.createElement("button");
      b.className = "size";
      b.setAttribute("aria-pressed", String(i === sizeIdx));
      b.setAttribute("aria-label", ["Thin", "Medium", "Thick"][i]);
      b.title = ["Thin", "Medium", "Thick"][i] + " — line width and text size";
      var dot = document.createElement("i");
      dot.style.width = px + "px";
      dot.style.height = px + "px";
      b.appendChild(dot);
      b.addEventListener("click", function () {
        sizeIdx = i;
        var all = el.sizes.children;
        for (var k = 0; k < all.length; k++) all[k].setAttribute("aria-pressed", String(k === i));
      });
      el.sizes.appendChild(b);
    });
  })();

  el.roomBtn.addEventListener("click", function () {
    var link = location.href;
    var done = function () { toast("Link copied — send it to whoever you want on this board."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { fallbackCopy(link, done); });
    } else {
      fallbackCopy(link, done);
    }
  });
  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove();
    if (ok) done(); else toast("Copy the address bar and send that link.");
  }

  document.addEventListener("keydown", function (e) {
    if (textEl || !e.key) return;             // typing on the board wins
    var meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); el.undoBtn.click(); }
    else if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); el.saveBtn.click(); }
    else if (e.key === "p" && !meta) setTool("pen");
    else if (e.key === "t" && !meta) setTool("text");
  });

  // iOS ignores user-scalable=no; this keeps a two-finger pinch from zooming
  // the page out from under a drawing.
  ["gesturestart", "gesturechange"].forEach(function (name) {
    document.addEventListener(name, function (e) { e.preventDefault(); });
  });

  /* ============================================================
   * The connection
   * ============================================================ */
  var ws = null, ready = false, retries = 0, retryTimer = null, peers = 1;
  var hist = null, expiresAt = 0;

  function setStatus(kind, text) {
    el.status.className = "status " + kind;
    el.statusText.textContent = text;
  }
  function liveStatus() {
    setStatus("live", peers > 1 ? "Live · " + peers + " here" : "Live · just you");
  }

  function send(msg) {
    if (ws && ready && ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); return true; } catch (_) {}
    }
    return false;
  }

  function connect() {
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close(); } catch (_) {} ws = null; }
    ready = false;
    setStatus("wait", "Connecting…");

    var url = WS_BASE + "/ws?room=" + encodeURIComponent(room) + "&cid=" + encodeURIComponent(CID);
    try { ws = new WebSocket(url); } catch (_) { scheduleRetry(); return; }

    ws.onopen = function () { retries = 0; ready = true; setStatus("wait", "Loading board…"); };
    ws.onmessage = onMessage;
    ws.onerror = function () { /* a close always follows */ };
    ws.onclose = function () {
      ready = false;
      if (active) endStroke();
      setStatus("down", "Reconnecting…");
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    // Phones close sockets every time the screen locks, so this has to be
    // routine rather than exceptional: back off, but never give up.
    var wait = Math.min(RETRY_MAX_MS, 800 * Math.pow(2, retries)) * (0.75 + Math.random() * 0.5);
    retries++;
    retryTimer = setTimeout(connect, wait);
  }

  function onMessage(ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }

    switch (m.t) {
      case "history_start":
        hist = [];
        expiresAt = m.expiresAt || 0;
        break;

      case "history":
        if (hist) hist = hist.concat(m.items || []);
        break;

      case "history_end":
        if (hist) { applyHistory(hist); hist = null; }
        break;

      case "stroke_start": {
        if (byId.has(m.id) || !Array.isArray(m.pts)) break;
        var s = { id: m.id, kind: "stroke", by: m.by, color: m.color, width: m.width, pts: m.pts.slice() };
        addItem(s);
        paintNew(s);
        break;
      }

      case "stroke_points": {
        var it = byId.get(m.id);
        if (!it || it.kind !== "stroke" || !Array.isArray(m.pts)) break;
        for (var i = 0; i < m.pts.length; i++) it.pts.push(m.pts[i]);
        paintNew(it);
        break;
      }

      case "stroke_end":
        break;      // already on screen; nothing left to do

      case "text_add": {
        if (byId.has(m.id)) break;
        var t = { id: m.id, kind: "text", by: m.by, color: m.color, x: m.x, y: m.y, size: m.size, text: m.text };
        addItem(t);
        paintText(ctx, t, BW, BH);
        break;
      }

      case "undo":
        if (byId.has(m.id)) { removeItem(m.id); redraw(); }
        break;

      case "clear":
        resetBoard();
        toast("Someone cleared the board.");
        break;

      case "peers":
        peers = m.n || 1;
        if (ready && hist === null) liveStatus();
        break;

      case "reject":
        // The room would not take that item — usually because the board is as
        // full as it is allowed to get. Take it back off the canvas rather
        // than showing something the room never kept.
        if (byId.has(m.id)) { removeItem(m.id); redraw(); }
        toast("This board is full. Save it, then start a new one.");
        break;

      case "expired":
        resetBoard();
        toast("This board passed 24 hours without a change and was deleted.");
        break;
    }
  }

  /* The room's list is the truth. Replacing what we hold with it — rather
   * than merging into it — is what stops a phone that reconnected from
   * drawing everything twice, and it also picks up an undo or a clear that
   * happened while we were away.
   *
   * The one exception: anything *I* drew while the socket was down was never
   * seen by the room, so it is kept and sent up again. */
  function applyHistory(list) {
    var serverIds = new Set();
    for (var i = 0; i < list.length; i++) serverIds.add(list[i].id);

    var recover = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (it.by === CID && unsent.has(it.id) && !serverIds.has(it.id)) recover.push(it);
    }

    items = list.slice();
    byId = new Map();
    mine = [];
    unsent = new Set();
    for (var j = 0; j < items.length; j++) {
      byId.set(items[j].id, items[j]);
      if (items[j].by === CID) mine.push(items[j].id);
    }

    for (var r = 0; r < recover.length && r < 200; r++) addItem(recover[r]);

    redraw();
    updateUndo();
    liveStatus();
    showExpiry();

    for (var s = 0; s < recover.length && s < 200; s++) resend(recover[s]);
  }

  function resend(it) {
    var ok;
    if (it.kind === "text") {
      ok = send({ t: "text_add", id: it.id, x: it.x, y: it.y, size: it.size, color: it.color, text: it.text });
    } else {
      ok = send({ t: "stroke_start", id: it.id, color: it.color, width: it.width, pts: it.pts.slice(0, 2) });
      if (ok && it.pts.length > 2) ok = send({ t: "stroke_points", id: it.id, pts: it.pts.slice(2) });
      if (ok) ok = send({ t: "stroke_end", id: it.id });
    }
    if (!ok) unsent.add(it.id);   // try again on the next reconnect
  }

  /* The countdown is rolling — every change pushes it out — so the exact time
     is only worth showing as a tooltip on the note that explains the rule. */
  function showExpiry() {
    if (!expiresAt) return;
    var when = new Date(expiresAt);
    el.note.title = "As things stand, this board deletes at " + when.toLocaleString() +
      ". Every change pushes that back another 24 hours.";
  }

  // Keeps a quiet connection from being dropped by something in the middle.
  setInterval(function () { if (ready) send({ t: "ping" }); }, 45000);

  // A phone coming back from a locked screen, or a laptop coming back onto
  // Wi-Fi, should not sit there waiting out a backoff timer.
  function nudge() {
    if (!ws || ws.readyState > 1) { retries = 0; connect(); }
  }
  window.addEventListener("online", nudge);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) nudge(); });

  window.addEventListener("hashchange", function () {
    var next = roomFromHash();
    if (!next || next === room) { if (!next) adoptRoom(); return; }
    adoptRoom();
    resetBoard();
    retries = 0;
    connect();
  });

  /* ============================================================
   * Toast
   * ============================================================ */
  var toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove("on"); }, 2600);
  }

  /* ============================================================
   * Go
   * ============================================================ */
  adoptRoom();
  layout();
  updateUndo();
  connect();
})();
