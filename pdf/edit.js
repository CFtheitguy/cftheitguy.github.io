/* Linear PDF — the page editor.
 *
 * This is the part that changes what a page *says*, rather than which pages
 * there are: type text, white something out, highlight it, or draw on it.
 *
 * Annotations are stored in PDF user space (points, origin bottom-left), never
 * in screen pixels. pdf.js's viewport.convertToPdfPoint does that conversion,
 * which means the maths survives zooming, high-DPI screens and pages that
 * carry a /Rotate — the same numbers go straight to pdf-lib at save time.
 *
 * Like the rest of this app it touches no network: the file is read into
 * memory, edited there, and handed back as a download.
 */
(function () {
  "use strict";

  var PDFLib = window.PDFLib;
  var pdfjsLib = window.pdfjsLib;

  var MAX_W = 820;          // widest we render a page, in CSS pixels
  var HANDLE = 6;           // click slop when hit-testing, in points

  var COLOURS = [
    ["#000000", "Black"], ["#d32f2f", "Red"], ["#1565c0", "Blue"],
    ["#f5c518", "Yellow"], ["#ffffff", "White"]
  ];

  var TEXT_SIZES = [[10, "Small"], [14, "Normal"], [20, "Large"], [32, "Huge"]];
  var PEN_SIZES = [[1, "Fine"], [2.5, "Normal"], [5, "Thick"], [9, "Marker"]];

  /* How far above and below its baseline a run of text is assumed to reach.
     Used both to draw the cover box and to hit-test, so they always agree. */
  var ASC = 0.82, DESC = 0.25;

  /* A PDF's own fonts are usually subset — they embed only the glyphs the
     document already uses — so a letter the user newly types often has no
     glyph to draw with. Rather than fail on that, a run is redrawn in the
     closest standard font, matched from the real font name pdf.js reports. */
  function mapFont(realName) {
    var n = String(realName || "").toLowerCase();
    var bold = /bold|black|heavy|semibold|demi/.test(n);
    var ital = /italic|oblique/.test(n);
    if (/times|serif|roman|georgia|garamond/.test(n)) {
      return bold && ital ? "TimesRomanBoldItalic" : bold ? "TimesRomanBold"
        : ital ? "TimesRomanItalic" : "TimesRoman";
    }
    if (/courier|mono/.test(n)) {
      return bold && ital ? "CourierBoldOblique" : bold ? "CourierBold"
        : ital ? "CourierOblique" : "Courier";
    }
    return bold && ital ? "HelveticaBoldOblique" : bold ? "HelveticaBold"
      : ital ? "HelveticaOblique" : "Helvetica";
  }

  function cssFont(key, px) {
    var fam = /Times/.test(key) ? '"Times New Roman",Times,serif'
      : /Courier/.test(key) ? '"Courier New",Courier,monospace'
      : "Helvetica,Arial,sans-serif";
    var w = /Bold/.test(key) ? "bold " : "";
    var s = /(Italic|Oblique)/.test(key) ? "italic " : "";
    return s + w + px + "px " + fam;
  }

  /* ---- state ---- */
  var S = null;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  /* The standard PDF fonts encode WinAnsi, so a curly quote pasted out of Word
     would otherwise throw at save time with a message no one can act on.
     The common offenders are folded to their plain equivalents; anything still
     unencodable is dropped and the user is told, rather than losing the save. */
  var FOLD = {
    "‘": "'", "’": "'", "‚": ",", "“": '"', "”": '"',
    "„": '"', "–": "-", "—": "-", "…": "...", "•": "-",
    " ": " ", "′": "'", "″": '"', "−": "-"
  };
  function toWinAnsi(str) {
    var dropped = false, out = "";
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (FOLD[c]) { out += FOLD[c]; continue; }
      if (c.charCodeAt(0) <= 255) { out += c; continue; }
      dropped = true;
    }
    return { text: out, dropped: dropped };
  }

  /* ---- build the editor UI ---- */
  function buildUI(host) {
    host.innerHTML = "";

    var bar = el("div", "edbar");

    var toolWrap = el("div", "edgroup");
    S.toolBtns = {};
    [
      ["retype", "✎", "Retype"],
      ["select", "✋", "Move"],
      ["text", "T", "Text"],
      ["draw", "✏️", "Draw"],
      ["highlight", "🖍️", "Highlight"],
      ["white", "⬜", "Whiteout"],
      ["erase", "🧽", "Erase"]
    ].forEach(function (t) {
      var b = el("button", "edtool");
      b.type = "button";
      b.title = t[2];
      b.innerHTML = '<span class="i"></span><span class="l"></span>';
      b.querySelector(".i").textContent = t[1];
      b.querySelector(".l").textContent = t[2];
      b.addEventListener("click", function () { setTool(t[0]); });
      S.toolBtns[t[0]] = b;
      toolWrap.appendChild(b);
    });
    bar.appendChild(toolWrap);

    var opt = el("div", "edgroup edopt");
    S.swatches = el("div", "edswatch");
    COLOURS.forEach(function (c) {
      var b = el("button", "edcol");
      b.type = "button";
      b.title = c[1];
      b.style.background = c[0];
      b.dataset.c = c[0];
      b.addEventListener("click", function () {
        S.colour = c[0];
        /* Remember the pen/text colour separately, so it survives a trip
           through the highlighter and comes back as the user left it. */
        if (S.tool === "text" || S.tool === "draw") S.markColour = c[0];
        paintChrome();
      });
      S.swatches.appendChild(b);
    });
    opt.appendChild(S.swatches);

    S.sizeSel = el("select", "edsize");
    S.sizeSel.addEventListener("change", function () { S.size = parseFloat(S.sizeSel.value); });
    opt.appendChild(S.sizeSel);
    bar.appendChild(opt);

    var nav = el("div", "edgroup ednav");
    S.prevBtn = el("button", "edbtn", "‹");
    S.prevBtn.type = "button";
    S.prevBtn.title = "Previous page";
    S.prevBtn.addEventListener("click", function () { goPage(S.pageNo - 1); });
    S.pageLbl = el("span", "edpg", "");
    S.nextBtn = el("button", "edbtn", "›");
    S.nextBtn.type = "button";
    S.nextBtn.title = "Next page";
    S.nextBtn.addEventListener("click", function () { goPage(S.pageNo + 1); });
    nav.appendChild(S.prevBtn);
    nav.appendChild(S.pageLbl);
    nav.appendChild(S.nextBtn);
    bar.appendChild(nav);

    var acts = el("div", "edgroup edacts");
    /* Covering words does not delete them: the originals stay in the file's
       text and come straight back out with copy-paste or any extraction tool.
       Flattening re-renders each page as a picture, which genuinely removes
       them — the choice belongs to the user, so it is offered here rather
       than decided for them. */
    S.flatSel = el("select", "edsize");
    [["keep", "Keep text selectable"], ["flat", "Flatten (removes old text)"]]
      .forEach(function (o) {
        var op = el("option", null, o[1]);
        op.value = o[0];
        S.flatSel.appendChild(op);
      });
    S.flatSel.title = "How to save";
    S.flatSel.addEventListener("change", paintChrome);
    acts.appendChild(S.flatSel);

    S.undoBtn = el("button", "edbtn", "Undo");
    S.undoBtn.type = "button";
    S.undoBtn.addEventListener("click", undo);
    var save = el("button", "edbtn primary", "Save PDF");
    save.type = "button";
    save.addEventListener("click", save_);
    var close = el("button", "edbtn", "Close");
    close.type = "button";
    close.addEventListener("click", function () { S.onClose(); });
    acts.appendChild(S.undoBtn);
    acts.appendChild(save);
    acts.appendChild(close);
    bar.appendChild(acts);

    host.appendChild(bar);

    S.stage = el("div", "edstage");
    S.pageCanvas = el("canvas", "edpage");
    S.overCanvas = el("canvas", "edover");
    S.stage.appendChild(S.pageCanvas);
    S.stage.appendChild(S.overCanvas);
    host.appendChild(S.stage);

    S.tip = el("div", "edtip", "");
    host.appendChild(S.tip);

    S.warn = el("div", "edwarn", "");
    host.appendChild(S.warn);

    bindPointer();
  }

  var TIPS = {
    retype: "Click any text on the page to change the words. Boxes show what can be retyped.",
    select: "Drag any text on the page to move it, including the page's own. Delete removes what you added.",
    text: "Click where you want the words to start, then type. Enter adds it; Escape cancels.",
    draw: "Drag to draw — good for a quick signature or circling something.",
    highlight: "Drag across text to highlight it.",
    white: "Drag a box over anything you want covered up, then type over it if you like.",
    erase: "Click anything you've added to remove it. The original page is untouched."
  };

  function setTool(t) {
    S.tool = t;
    commitInput();
    /* Whiteout and highlight have a colour that is the whole point of them,
       so picking the tool picks the sensible colour too — and going back to
       the pen or the text box restores whatever the user was marking in,
       rather than leaving them writing in highlighter yellow. */
    if (t === "white") S.colour = "#ffffff";
    else if (t === "highlight") S.colour = "#f5c518";
    else if (t === "text" || t === "draw") S.colour = S.markColour;
    fillSizes();
    paintChrome();
  }

  function fillSizes() {
    var list = (S.tool === "text") ? TEXT_SIZES : PEN_SIZES;
    var keep = S.tool === "text" ? S.textSize : S.penSize;
    S.sizeSel.innerHTML = "";
    list.forEach(function (p) {
      var o = el("option", null, p[1]);
      o.value = p[0];
      S.sizeSel.appendChild(o);
    });
    S.sizeSel.value = String(keep);
    S.size = parseFloat(S.sizeSel.value);
    S.sizeSel.disabled = noStyle();
  }

  /* Move, erase and retype all take their look from what is already there,
     so the colour and size controls do not apply to them. */
  function noStyle() {
    return S.tool === "select" || S.tool === "erase" || S.tool === "retype";
  }

  function paintChrome() {
    Object.keys(S.toolBtns).forEach(function (k) {
      S.toolBtns[k].classList.toggle("on", k === S.tool);
    });
    Array.prototype.forEach.call(S.swatches.children, function (b) {
      b.classList.toggle("on", b.dataset.c === S.colour);
    });
    S.swatches.style.opacity = noStyle() ? ".4" : "1";
    S.tip.textContent = TIPS[S.tool] || "";
    S.pageLbl.textContent = "Page " + S.pageNo + " of " + S.pageCount;
    S.prevBtn.disabled = S.pageNo <= 1;
    S.nextBtn.disabled = S.pageNo >= S.pageCount;
    S.undoBtn.disabled = S.items.length === 0;
    S.stage.dataset.tool = S.tool;

    /* The warning only earns its place once something is actually covered. */
    var covers = S.items.some(function (o) {
      return o.type === "edit" || (o.type === "rect" && o.opacity === 1);
    });
    var flat = S.flatSel && S.flatSel.value === "flat";
    S.warn.className = "edwarn" + (covers ? " show" : "");
    S.warn.textContent = !covers ? "" : flat
      ? "Saving flattened: pages become images, so the words you covered are genuinely gone — and no text on those pages stays selectable."
      : "Heads up: covered words are hidden, not deleted — they can still be copied out of the saved file. Switch to “Flatten” above if you are hiding something that matters.";
    if (S.tool === "text") S.sizeSel.value = String(S.textSize);
  }

  /* ---- page rendering ---- */
  function goPage(n) {
    if (n < 1 || n > S.pageCount || n === S.pageNo) return;
    commitInput();
    S.pageNo = n;
    renderPage();
  }

  function renderPage() {
    var thePage = null;
    return S.doc.getPage(S.pageNo).then(function (page) {
      thePage = page;
      var base = page.getViewport({ scale: 1 });
      var avail = Math.min(MAX_W, S.stage.parentNode.clientWidth || MAX_W);
      var scale = Math.min(avail / base.width, 1.6);
      var vp = page.getViewport({ scale: scale });
      var dpr = window.devicePixelRatio || 1;

      S.vp = vp;
      [S.pageCanvas, S.overCanvas].forEach(function (c) {
        c.width = Math.floor(vp.width * dpr);
        c.height = Math.floor(vp.height * dpr);
        c.style.width = vp.width + "px";
        c.style.height = vp.height + "px";
      });
      S.stage.style.width = vp.width + "px";
      S.dpr = dpr;

      var ctx = S.pageCanvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, S.pageCanvas.width, S.pageCanvas.height);
      return page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      }).promise;
    }).then(function () {
      /* Runs are found after the render, because the colours they carry are
         sampled from the pixels that render produced. */
      if (S.runs[S.pageNo]) return null;
      return buildRuns(thePage).then(function (runs) { S.runs[S.pageNo] = runs; });
    }).then(function () {
      paintOverlay();
      paintChrome();
    });
  }

  /* ---- finding the text already on the page ---------------------------- */

  /* pdf.js hands back text in fragments that may be split mid-line, so runs
     that share a baseline, a font and a size get stitched back together —
     editing a whole line is what someone actually wants, not editing "Inv"
     and "oice" separately. */
  function buildRuns(page) {
    return page.getTextContent().then(function (tc) {
      var runs = [];
      tc.items.forEach(function (it) {
        var t = it.transform;
        if (!it.str || !it.str.trim()) return;
        /* Rotated or skewed text can't be redrawn reliably, so it is left
           alone rather than half-handled. */
        if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) return;
        var size = Math.abs(t[0]) || Math.abs(t[3]) || 10;
        var real = null;
        try { var f = page.commonObjs.get(it.fontName); real = f && f.name; } catch (e) {}

        var r = {
          str: it.str, x: t[4], y: t[5], w: it.width, size: size,
          fontKey: mapFont(real), rawFont: it.fontName
        };
        var prev = runs[runs.length - 1];
        var joins = prev &&
          prev.rawFont === r.rawFont &&
          Math.abs(prev.size - r.size) < 0.1 &&
          Math.abs(prev.y - r.y) < 0.5 &&
          (r.x - (prev.x + prev.w)) < r.size * 0.4 &&
          (r.x - (prev.x + prev.w)) > -r.size * 0.4;
        if (joins) {
          var gap = r.x - (prev.x + prev.w);
          prev.str += (gap > r.size * 0.12 ? " " : "") + r.str;
          prev.w = (r.x + r.w) - prev.x;
        } else {
          runs.push(r);
        }
      });
      runs.forEach(function (r) {
        var c = sampleRun(r);
        r.fg = c.fg;
        r.bg = c.bg;
      });
      return runs;
    });
  }

  /* The replacement has to sit on the same background and be the same colour
     as what it replaces, and a PDF does not hand those over — so they are read
     straight off the pixels that were just rendered. The most common colour in
     the run's box is the background; the one furthest from it in brightness
     (and common enough not to be an anti-aliasing fringe) is the ink. */
  function sampleRun(r) {
    var plain = { fg: "#000000", bg: "#ffffff" };
    var a = toView(r.x, r.y + r.size * ASC);
    var b = toView(r.x + r.w, r.y - r.size * DESC);
    var x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) * S.dpr));
    var y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) * S.dpr));
    var x1 = Math.min(S.pageCanvas.width, Math.ceil(Math.max(a.x, b.x) * S.dpr));
    var y1 = Math.min(S.pageCanvas.height, Math.ceil(Math.max(a.y, b.y) * S.dpr));
    var w = x1 - x0, h = y1 - y0;
    if (w < 1 || h < 1) return plain;

    var data;
    try {
      data = S.pageCanvas.getContext("2d").getImageData(x0, y0, w, h).data;
    } catch (e) {
      return plain;
    }

    var counts = {}, total = 0;
    for (var i = 0; i < data.length; i += 4) {
      var k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts[k] = (counts[k] || 0) + 1;
      total++;
    }
    var keys = Object.keys(counts).sort(function (p, q) { return counts[q] - counts[p]; });
    if (!keys.length) return plain;

    var bgKey = keys[0];
    var bgL = lumOf(bgKey);
    var fgKey = null, best = -1;
    for (var j = 0; j < keys.length && j < 48; j++) {
      if (counts[keys[j]] < total * 0.01) continue;
      var d = Math.abs(lumOf(keys[j]) - bgL);
      if (d > best) { best = d; fgKey = keys[j]; }
    }
    /* No real contrast means the box is blank or a solid block; black ink on
       the sampled background is the safe reading. */
    if (fgKey === null || best < 24) fgKey = null;

    return {
      bg: exactAverage(data, bgKey),
      fg: fgKey === null ? "#000000" : exactAverage(data, fgKey)
    };
  }

  function lumOf(key) {
    var k = parseInt(key, 10);
    var r = ((k >> 10) & 31) << 3, g = ((k >> 5) & 31) << 3, b = (k & 31) << 3;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /* The bucket key is quantised to 5 bits a channel, which is fine for
     grouping but would visibly shift a colour. Averaging the real pixels in
     the chosen bucket gives the true value back. */
  function exactAverage(data, key) {
    var want = parseInt(key, 10), r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < data.length; i += 4) {
      var k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      if (k !== want) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    if (!n) return "#000000";
    return "#" + [r / n, g / n, b / n].map(function (v) {
      return ("0" + Math.round(v).toString(16)).slice(-2);
    }).join("");
  }

  /* Turn a run of the page's own text into something the user owns: the same
     words, colours and font, with the patch anchored where they came from so
     dragging carries the text away and leaves clean background behind. */
  function materialiseRun(run, runId) {
    for (var i = 0; i < S.items.length; i++) {
      var it = S.items[i];
      if (it.type === "edit" && it.page === S.pageNo && it.runId === runId) return it;
    }
    var o = {
      type: "edit", page: S.pageNo, runId: runId, run: run,
      ox: run.x, oy: run.y, ow: run.w,
      x: run.x, y: run.y, size: run.size,
      fontKey: run.fontKey, fg: run.fg, bg: run.bg, text: run.str
    };
    S.items.push(o);
    return o;
  }

  function runAt(pt) {
    var list = S.runs[S.pageNo] || [];
    for (var i = list.length - 1; i >= 0; i--) {
      var r = list[i];
      if (pt.x >= r.x - 1 && pt.x <= r.x + r.w + 1 &&
          pt.y >= r.y - r.size * DESC && pt.y <= r.y + r.size * ASC) return r;
    }
    return null;
  }

  /* ---- coordinate helpers ---- */
  function toPdf(cssX, cssY) {
    var p = S.vp.convertToPdfPoint(cssX, cssY);
    return { x: p[0], y: p[1] };
  }
  function toView(x, y) {
    var p = S.vp.convertToViewportPoint(x, y);
    return { x: p[0], y: p[1] };
  }
  function stageXY(ev) {
    var r = S.overCanvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  /* Lengths (font size, pen width) are stored in points and only scaled for
     display; S.vp.scale is the single source of truth for that factor. */
  function pxPerPt() { return S.vp.scale; }

  /* ---- overlay painting ---- */
  function paintOverlay() {
    var ctx = S.overCanvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S.overCanvas.width, S.overCanvas.height);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);

    if (S.tool === "retype" || S.tool === "select") drawRunHints(ctx);

    S.items.forEach(function (o) {
      if (o.page !== S.pageNo) return;
      drawItem(ctx, o, o === S.selected);
    });
    if (S.live) drawItem(ctx, S.live, false);
  }

  /* Showing which text is retypeable is the whole affordance — without it the
     user is clicking blindly to find out what the tool can reach. */
  function drawRunHints(ctx) {
    var edited = {};
    S.items.forEach(function (o) {
      if (o.type === "edit" && o.page === S.pageNo) edited[o.runId] = true;
    });
    (S.runs[S.pageNo] || []).forEach(function (r, i) {
      if (edited[i]) return;
      var a = toView(r.x, r.y + r.size * ASC);
      var b = toView(r.x + r.w, r.y - r.size * DESC);
      ctx.save();
      ctx.strokeStyle = "rgba(0,176,236,.55)";
      ctx.fillStyle = "rgba(0,176,236,.07)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
    });
  }

  function drawItem(ctx, o, selected) {
    ctx.save();
    if (o.type === "rect") {
      var a = toView(o.x, o.y + o.h), b = toView(o.x + o.w, o.y);
      ctx.globalAlpha = o.opacity;
      ctx.fillStyle = o.colour;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.globalAlpha = 1;
      if (o.colour === "#ffffff") {
        /* A white box on a white page is invisible while you work, so it gets
           a faint outline on screen only — it is never drawn into the PDF. */
        ctx.strokeStyle = "rgba(120,130,160,.55)";
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.setLineDash([]);
      }
      if (selected) outline(ctx, a.x, a.y, b.x - a.x, b.y - a.y);
    } else if (o.type === "ink") {
      ctx.strokeStyle = o.colour;
      ctx.lineWidth = Math.max(1, o.width * pxPerPt());
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = o.opacity == null ? 1 : o.opacity;
      ctx.beginPath();
      o.pts.forEach(function (p, i) {
        var v = toView(p[0], p[1]);
        if (i === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (selected) {
        var bb = inkBounds(o);
        var p1 = toView(bb.x, bb.y + bb.h), p2 = toView(bb.x + bb.w, bb.y);
        outline(ctx, p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      }
    } else if (o.type === "edit") {
      /* The cover stays anchored to the original words even if the
         replacement is dragged elsewhere, so moving it never uncovers
         what it was meant to replace. */
      var ca = toView(o.ox - 0.5, o.oy + o.size * ASC);
      var cb = toView(o.ox + o.ow + 1, o.oy - o.size * DESC);
      ctx.fillStyle = o.bg;
      ctx.fillRect(ca.x, ca.y, cb.x - ca.x, cb.y - ca.y);

      var epx = o.size * pxPerPt();
      var ev = toView(o.x, o.y);
      ctx.font = cssFont(o.fontKey, epx);
      ctx.fillStyle = o.fg;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(o.text, ev.x, ev.y);
      if (selected) {
        var ew = ctx.measureText(o.text).width;
        outline(ctx, ev.x - 2, ev.y - epx * ASC, ew + 4, epx * (ASC + DESC));
      }
    } else if (o.type === "text") {
      var px = o.size * pxPerPt();
      var v = toView(o.x, o.y);
      ctx.font = px + "px Helvetica, Arial, sans-serif";
      ctx.fillStyle = o.colour;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(o.text, v.x, v.y);
      if (selected) {
        var w = ctx.measureText(o.text).width;
        outline(ctx, v.x - 2, v.y - px, w + 4, px * 1.25);
      }
    }
    ctx.restore();
  }

  function outline(ctx, x, y, w, h) {
    ctx.save();
    ctx.strokeStyle = "#00b0ec";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function inkBounds(o) {
    var xs = o.pts.map(function (p) { return p[0]; });
    var ys = o.pts.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /* ---- hit testing (all in PDF points) ---- */
  function hit(pt) {
    for (var i = S.items.length - 1; i >= 0; i--) {
      var o = S.items[i];
      if (o.page !== S.pageNo) continue;
      if (o.type === "rect") {
        if (pt.x >= o.x - HANDLE && pt.x <= o.x + o.w + HANDLE &&
            pt.y >= o.y - HANDLE && pt.y <= o.y + o.h + HANDLE) return o;
      } else if (o.type === "text" || o.type === "edit") {
        var w = measurePt(o);
        if (pt.x >= o.x - HANDLE && pt.x <= o.x + w + HANDLE &&
            pt.y >= o.y - o.size * 0.28 && pt.y <= o.y + o.size) return o;
        /* A retyped run is also grabbable by the patch covering the old
           words, which is where the eye expects it to be. */
        if (o.type === "edit" &&
            pt.x >= o.ox - HANDLE && pt.x <= o.ox + o.ow + HANDLE &&
            pt.y >= o.oy - o.size * DESC && pt.y <= o.oy + o.size * ASC) return o;
      } else if (o.type === "ink") {
        var tol = Math.max(o.width, 3) + HANDLE / 2;
        for (var j = 1; j < o.pts.length; j++) {
          if (distToSeg(pt, o.pts[j - 1], o.pts[j]) <= tol) return o;
        }
        if (o.pts.length === 1 && distToSeg(pt, o.pts[0], o.pts[0]) <= tol) return o;
      }
    }
    return null;
  }

  function measurePt(o) {
    var ctx = S.overCanvas.getContext("2d");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = o.fontKey ? cssFont(o.fontKey, o.size * pxPerPt())
      : (o.size * pxPerPt()) + "px Helvetica, Arial, sans-serif";
    var w = ctx.measureText(o.text).width / pxPerPt();
    ctx.restore();
    return w;
  }

  function distToSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = dx * dx + dy * dy;
    var t = len ? ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = a[0] + t * dx, cy = a[1] + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  }

  function translate(o, dx, dy) {
    if (o.type === "ink") {
      o.pts = o.pts.map(function (p) { return [p[0] + dx, p[1] + dy]; });
    } else {
      o.x += dx;
      o.y += dy;
    }
  }

  /* ---- pointer interaction ---- */
  function bindPointer() {
    var down = null;

    S.overCanvas.addEventListener("pointerdown", function (ev) {
      if (S.input) { commitInput(); return; }
      ev.preventDefault();
      S.overCanvas.setPointerCapture(ev.pointerId);
      var s = stageXY(ev);
      var pt = toPdf(s.x, s.y);
      down = { start: pt, last: pt, moved: false };

      if (S.tool === "text") {
        openInput(s, pt);
        down = null;
        return;
      }
      if (S.tool === "retype") {
        down = null;
        /* Clicking an already-changed run reopens that change rather than
           stacking a second cover on top of the first. */
        var existing = null;
        for (var q = 0; q < S.items.length; q++) {
          var it = S.items[q];
          if (it.type === "edit" && it.page === S.pageNo &&
              pt.x >= it.ox - 1 && pt.x <= it.ox + it.ow + 1 &&
              pt.y >= it.oy - it.size * DESC && pt.y <= it.oy + it.size * ASC) { existing = it; break; }
        }
        if (existing) { openRetype(existing.run, existing.runId, existing); return; }
        var run = runAt(pt);
        if (run) openRetype(run, (S.runs[S.pageNo] || []).indexOf(run), null);
        return;
      }
      if (S.tool === "erase") {
        var t = hit(pt);
        if (t) { remove(t); }
        down = null;
        return;
      }
      if (S.tool === "select") {
        S.selected = hit(pt);
        if (!S.selected) {
          /* Text that is part of the page can be dragged too. It is only
             turned into an editable run once the drag actually starts, so a
             stray click does not litter the document with no-op changes. */
          var pending = runAt(pt);
          if (pending) {
            down.pendingRun = pending;
            down.pendingId = (S.runs[S.pageNo] || []).indexOf(pending);
          } else {
            down = null;
          }
        }
        paintOverlay();
        return;
      }
      if (S.tool === "draw") {
        S.live = { type: "ink", page: S.pageNo, colour: S.colour, width: S.size, pts: [[pt.x, pt.y]] };
      } else {
        var op = S.tool === "highlight" ? 0.35 : 1;
        S.live = { type: "rect", page: S.pageNo, colour: S.colour, opacity: op, x: pt.x, y: pt.y, w: 0, h: 0 };
      }
    });

    S.overCanvas.addEventListener("pointermove", function (ev) {
      if (!down) return;
      var s = stageXY(ev);
      var pt = toPdf(s.x, s.y);
      down.moved = true;

      if (S.tool === "select") {
        if (!S.selected && down.pendingRun) {
          S.selected = materialiseRun(down.pendingRun, down.pendingId);
          down.pendingRun = null;
        }
        if (S.selected) {
          translate(S.selected, pt.x - down.last.x, pt.y - down.last.y);
          down.last = pt;
          paintOverlay();
        }
        return;
      }
      if (!S.live) return;
      if (S.live.type === "ink") {
        S.live.pts.push([pt.x, pt.y]);
      } else {
        S.live.x = Math.min(down.start.x, pt.x);
        S.live.y = Math.min(down.start.y, pt.y);
        S.live.w = Math.abs(pt.x - down.start.x);
        S.live.h = Math.abs(pt.y - down.start.y);
      }
      paintOverlay();
    });

    function finish() {
      if (S.live) {
        var o = S.live;
        S.live = null;
        /* A stray click should not leave an invisible speck behind. */
        var real = o.type === "ink" ? o.pts.length > 1 : (o.w > 1.5 && o.h > 1.5);
        if (real) { S.items.push(o); S.selected = null; }
      }
      down = null;
      paintOverlay();
      paintChrome();
    }
    S.overCanvas.addEventListener("pointerup", finish);
    S.overCanvas.addEventListener("pointercancel", finish);

    S.keyHandler = function (ev) {
      if (S.input) return;
      if ((ev.key === "Delete" || ev.key === "Backspace") && S.selected) {
        ev.preventDefault();
        remove(S.selected);
      }
    };
    document.addEventListener("keydown", S.keyHandler);
  }

  function remove(o) {
    var i = S.items.indexOf(o);
    if (i >= 0) S.items.splice(i, 1);
    if (S.selected === o) S.selected = null;
    paintOverlay();
    paintChrome();
  }

  function undo() {
    S.items.pop();
    S.selected = null;
    paintOverlay();
    paintChrome();
  }

  /* ---- the floating text box ---- */
  function openInput(screenPt, pdfPt) {
    commitInput();
    var inp = el("input", "edinput");
    inp.type = "text";
    inp.setAttribute("aria-label", "Text to add to the page");
    var px = S.textSize * pxPerPt();
    inp.style.left = screenPt.x + "px";
    inp.style.top = (screenPt.y - px) + "px";
    inp.style.fontSize = px + "px";
    inp.style.color = S.colour;
    S.stage.appendChild(inp);
    S.input = { el: inp, at: pdfPt, size: S.textSize, colour: S.colour };
    /* Focus synchronously. Deferring it by even a tick loses the first
       characters of anyone who starts typing straight away — the pointerdown
       that got us here already called preventDefault, so nothing steals it. */
    inp.focus();

    inp.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); commitInput(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancelInput(); }
      ev.stopPropagation();
    });
    inp.addEventListener("blur", function () { commitInput(); });
  }

  /* Taking the box off the page blurs it, and the blur handler commits — so
     both of these claim S.input before touching the DOM, or the re-entrant
     call would try to remove an element that has already gone. */
  /* Editing existing words: the box is placed over them, prefilled and
     pre-selected, and styled to match — so it reads as changing that text
     rather than typing something new on top of it. */
  function openRetype(run, runId, existing) {
    commitInput();
    var px = run.size * pxPerPt();
    var a = toView(run.x, run.y + run.size * ASC);
    var b = toView(run.x + run.w, run.y - run.size * DESC);

    var inp = el("input", "edinput edretype");
    inp.type = "text";
    inp.setAttribute("aria-label", "Change this text");
    inp.value = existing ? existing.text : run.str;
    inp.style.left = a.x + "px";
    inp.style.top = a.y + "px";
    inp.style.height = (b.y - a.y) + "px";
    inp.style.minWidth = Math.max(60, b.x - a.x) + "px";
    inp.style.font = cssFont(run.fontKey, px);
    inp.style.color = run.fg;
    inp.style.background = run.bg;
    S.stage.appendChild(inp);
    inp.focus();
    inp.select();

    S.input = { el: inp, retype: true, run: run, runId: runId, existing: existing };

    inp.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); commitInput(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancelInput(); }
      ev.stopPropagation();
    });
    inp.addEventListener("input", function () { warnIfWide(inp.value, run); });
    inp.addEventListener("blur", function () { commitInput(); });
    warnIfWide(inp.value, run);
  }

  /* Longer replacement text has nowhere to go — the words after it are part
     of the page, not something we can push along — so say so while typing
     instead of letting it silently overlap at save time. */
  function warnIfWide(text, run) {
    var ctx = S.overCanvas.getContext("2d");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = cssFont(run.fontKey, run.size * pxPerPt());
    var w = ctx.measureText(text).width / pxPerPt();
    ctx.restore();
    S.tip.textContent = w > run.w * 1.04
      ? "That is longer than the original — it may run into whatever follows it on the page."
      : TIPS.retype;
  }

  function cancelInput() {
    if (!S.input) return;
    var box = S.input;
    S.input = null;
    if (box.el.parentNode) box.el.remove();
  }

  function commitInput() {
    if (!S.input) return;
    var box = S.input;
    S.input = null;
    var v = box.el.value;
    if (box.el.parentNode) box.el.remove();

    if (box.retype) {
      var run = box.run;
      var prev = box.existing;
      /* Retyping something that was dragged must not snap it home again, so
         the position carries over from the change being replaced. */
      var px = prev ? prev.x : run.x;
      var py = prev ? prev.y : run.y;
      var moved = px !== run.x || py !== run.y;
      if (prev) remove(prev);
      /* Putting the original words back where they started is the same as
         never having changed them, so no cover is left behind. */
      if (v !== run.str || moved) {
        S.items.push({
          type: "edit", page: S.pageNo, runId: box.runId, run: run,
          ox: run.x, oy: run.y, ow: run.w,
          x: px, y: py, size: run.size,
          fontKey: run.fontKey, fg: run.fg, bg: run.bg, text: v
        });
      }
      S.tip.textContent = TIPS[S.tool] || "";
      paintOverlay();
      paintChrome();
      return;
    }

    var at = box.at, size = box.size, colour = box.colour;
    if (v && v.trim()) {
      S.items.push({
        type: "text", page: S.pageNo, x: at.x, y: at.y,
        size: size, colour: colour, text: v
      });
      paintOverlay();
      paintChrome();
    }
  }

  /* ---- saving ---- */
  function save_() {
    commitInput();
    if (!S.items.length) {
      S.report("busy", "Nothing has been added yet — draw or type something first.");
      return;
    }
    if (S.flatSel && S.flatSel.value === "flat") return saveFlat();

    S.report("busy", "Saving your changes…");

    return PDFLib.PDFDocument.load(S.bytes).then(function (out) {
      /* Every standard font a retyped run needs is embedded up front, so the
         drawing pass below stays synchronous and ordered. */
      var need = { Helvetica: true };
      S.items.forEach(function (o) { if (o.type === "edit") need[o.fontKey] = true; });
      var keys = Object.keys(need);

      return Promise.all(keys.map(function (k) {
        return out.embedFont(PDFLib.StandardFonts[k]);
      })).then(function (embedded) {
        var fonts = {};
        keys.forEach(function (k, i) { fonts[k] = embedded[i]; });
        var font = fonts.Helvetica;
        var pages = out.getPages();
        var dropped = false;

        S.items.forEach(function (o) {
          var page = pages[o.page - 1];
          if (!page) return;
          if (o.type === "edit") {
            page.drawRectangle({
              x: o.ox - 0.5, y: o.oy - o.size * DESC,
              width: o.ow + 1.5, height: o.size * (ASC + DESC),
              color: hexToRgb(o.bg)
            });
            var safeE = toWinAnsi(o.text);
            if (safeE.dropped) dropped = true;
            if (safeE.text) {
              page.drawText(safeE.text, {
                x: o.x, y: o.y, size: o.size,
                font: fonts[o.fontKey] || font, color: hexToRgb(o.fg)
              });
            }
          } else if (o.type === "rect") {
            page.drawRectangle({
              x: o.x, y: o.y, width: o.w, height: o.h,
              color: hexToRgb(o.colour), opacity: o.opacity
            });
          } else if (o.type === "ink") {
            for (var i = 1; i < o.pts.length; i++) {
              page.drawLine({
                start: { x: o.pts[i - 1][0], y: o.pts[i - 1][1] },
                end: { x: o.pts[i][0], y: o.pts[i][1] },
                thickness: o.width,
                color: hexToRgb(o.colour),
                lineCap: PDFLib.LineCapStyle.Round
              });
            }
          } else if (o.type === "text") {
            var safe = toWinAnsi(o.text);
            if (safe.dropped) dropped = true;
            if (!safe.text) return;
            page.drawText(safe.text, {
              x: o.x, y: o.y, size: o.size,
              font: font, color: hexToRgb(o.colour)
            });
          }
        });
        return out.save().then(function (bytes) { return { bytes: bytes, dropped: dropped }; });
      });
    }).then(function (res) {
      S.onSave(res.bytes);
      S.report(res.dropped ? "busy" : "ok",
        res.dropped
          ? "Saved — but a few characters your font can't show were left out. Plain letters, numbers and punctuation always work."
          : "Saved your edited PDF.");
    }).catch(function (err) {
      S.report("err", (err && err.message) || "Could not save those changes.");
    });
  }

  /* Flattened save: every page is re-rendered as a picture with the edits
     painted on, so nothing underneath survives. Slower and heavier than the
     normal save, and it costs text selection — which is exactly the trade the
     user is asked to make before choosing it. */
  function saveFlat() {
    var DPI = 150;
    var keepVp = S.vp, keepDpr = S.dpr;
    S.report("busy", "Flattening page 1…");

    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      for (var n = 1; n <= S.pageCount; n++) {
        (function (pageNo) {
          chain = chain.then(function () {
            S.report("busy", "Flattening page " + pageNo + " of " + S.pageCount + "…");
            return S.doc.getPage(pageNo).then(function (page) {
              var pt = page.getViewport({ scale: 1 });
              var vp = page.getViewport({ scale: DPI / 72 });
              var canvas = document.createElement("canvas");
              canvas.width = Math.floor(vp.width);
              canvas.height = Math.floor(vp.height);
              var ctx = canvas.getContext("2d");
              ctx.fillStyle = "#fff";
              ctx.fillRect(0, 0, canvas.width, canvas.height);

              return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
                /* drawItem works off S.vp, so it is pointed at this page's
                   full-size viewport for the duration of the paint. */
                S.vp = vp;
                S.dpr = 1;
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                S.items.forEach(function (o) {
                  if (o.page === pageNo) drawItem(ctx, o, false);
                });
                return new Promise(function (res, rej) {
                  canvas.toBlob(function (bl) {
                    bl ? res(bl) : rej(new Error("Your browser could not flatten that page."));
                  }, "image/jpeg", 0.88);
                });
              }).then(function (blob) {
                return blob.arrayBuffer();
              }).then(function (ab) {
                return out.embedJpg(ab);
              }).then(function (img) {
                var pg = out.addPage([pt.width, pt.height]);
                pg.drawImage(img, { x: 0, y: 0, width: pt.width, height: pt.height });
              });
            });
          });
        })(n);
      }
      return chain.then(function () { return out.save(); });
    }).then(function (bytes) {
      S.vp = keepVp;
      S.dpr = keepDpr;
      paintOverlay();
      S.onSave(bytes);
      S.report("ok", "Saved flattened — the words you covered are gone for good, and the pages are now images.");
    }).catch(function (err) {
      S.vp = keepVp;
      S.dpr = keepDpr;
      paintOverlay();
      S.report("err", (err && err.message) || "Could not flatten that file.");
    });
  }

  /* ---- entry point ---- */
  function open(opts) {
    var file = opts.file;
    close();

    S = {
      tool: "retype", colour: "#000000", markColour: "#000000",
      textSize: 14, penSize: 2.5, size: 14,
      items: [], selected: null, live: null, input: null, runs: {},
      pageNo: 1, pageCount: 0,
      onClose: opts.onClose, onSave: opts.onSave, report: opts.report
    };

    /* pdf.js consumes the buffer it is handed, so pdf-lib gets its own copy
       to re-open at save time. */
    return readBuffer(file).then(function (buf) {
      S.bytes = buf.slice(0);
      return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (doc) {
      S.doc = doc;
      S.pageCount = doc.numPages;
      buildUI(opts.host);
      /* Keep the size selects honest about which tool they belong to. */
      S.sizeSel.addEventListener("change", function () {
        if (S.tool === "text") S.textSize = parseFloat(S.sizeSel.value);
        else S.penSize = parseFloat(S.sizeSel.value);
      });
      setTool("retype");
      return renderPage();
    });
  }

  function close() {
    if (S && S.keyHandler) document.removeEventListener("keydown", S.keyHandler);
    if (S && S.doc && S.doc.destroy) { try { S.doc.destroy(); } catch (e) {} }
    S = null;
  }

  function readBuffer(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("Could not read " + file.name)); };
      r.readAsArrayBuffer(file);
    });
  }

  window.LinearPDFEditor = { open: open, close: close };
})();
