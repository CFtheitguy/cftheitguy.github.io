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

    bindPointer();
  }

  var TIPS = {
    select: "Drag anything you've added to move it. Click it and press Delete to remove it.",
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
    S.sizeSel.disabled = (S.tool === "select" || S.tool === "erase");
  }

  function paintChrome() {
    Object.keys(S.toolBtns).forEach(function (k) {
      S.toolBtns[k].classList.toggle("on", k === S.tool);
    });
    Array.prototype.forEach.call(S.swatches.children, function (b) {
      b.classList.toggle("on", b.dataset.c === S.colour);
    });
    var sizeMatters = S.tool !== "select" && S.tool !== "erase";
    S.swatches.style.opacity = sizeMatters ? "1" : ".4";
    S.tip.textContent = TIPS[S.tool] || "";
    S.pageLbl.textContent = "Page " + S.pageNo + " of " + S.pageCount;
    S.prevBtn.disabled = S.pageNo <= 1;
    S.nextBtn.disabled = S.pageNo >= S.pageCount;
    S.undoBtn.disabled = S.items.length === 0;
    S.stage.dataset.tool = S.tool;
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
    return S.doc.getPage(S.pageNo).then(function (page) {
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
      paintOverlay();
      paintChrome();
    });
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

    S.items.forEach(function (o) {
      if (o.page !== S.pageNo) return;
      drawItem(ctx, o, o === S.selected);
    });
    if (S.live) drawItem(ctx, S.live, false);
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
      } else if (o.type === "text") {
        var w = measurePt(o);
        if (pt.x >= o.x - HANDLE && pt.x <= o.x + w + HANDLE &&
            pt.y >= o.y - o.size * 0.28 && pt.y <= o.y + o.size) return o;
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
    ctx.font = (o.size * pxPerPt()) + "px Helvetica, Arial, sans-serif";
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
      if (S.tool === "erase") {
        var t = hit(pt);
        if (t) { remove(t); }
        down = null;
        return;
      }
      if (S.tool === "select") {
        S.selected = hit(pt);
        paintOverlay();
        if (!S.selected) down = null;
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

      if (S.tool === "select" && S.selected) {
        translate(S.selected, pt.x - down.last.x, pt.y - down.last.y);
        down.last = pt;
        paintOverlay();
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
    var at = box.at, size = box.size, colour = box.colour;
    if (box.el.parentNode) box.el.remove();
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
    S.report("busy", "Saving your changes…");

    return PDFLib.PDFDocument.load(S.bytes).then(function (out) {
      return out.embedFont(PDFLib.StandardFonts.Helvetica).then(function (font) {
        var pages = out.getPages();
        var dropped = false;

        S.items.forEach(function (o) {
          var page = pages[o.page - 1];
          if (!page) return;
          if (o.type === "rect") {
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

  /* ---- entry point ---- */
  function open(opts) {
    var file = opts.file;
    close();

    S = {
      tool: "text", colour: "#000000", markColour: "#000000",
      textSize: 14, penSize: 2.5, size: 14,
      items: [], selected: null, live: null, input: null,
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
      setTool("text");
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
