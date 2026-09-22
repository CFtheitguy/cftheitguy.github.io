/* Linear PDF — an offline PDF toolkit.
 *
 * Everything here runs against ArrayBuffers held in memory. There is no fetch,
 * no XHR and no form post anywhere in this file, and the page's CSP forbids
 * them regardless, so a document a customer opens cannot leave their machine.
 *
 * pdf-lib does the structural work (merge, extract, rotate, stamp); pdf.js
 * does the rendering work (thumbnails, and the raster passes that shrinking
 * and image export need).
 */
(function () {
  "use strict";

  var PDFLib = window.PDFLib;
  var pdfjsLib = window.pdfjsLib;
  if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf/vendor/pdf.worker.min.js";

  var $ = function (id) { return document.getElementById(id); };
  var drop = $("drop"), fileInput = $("file"), msg = $("msg");
  var panel = $("panel"), panelLabel = $("panelLabel");
  var filesEl = $("files"), pagesGrid = $("pagesGrid"), optsEl = $("opts");
  var goBtn = $("go"), resetBtn = $("reset"), hintEl = $("hint");

  /* ---- theme (shared convention with the other Linear apps) ---------- */
  var saved = null;
  try { saved = localStorage.getItem("linear-theme"); } catch (e) {}
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  $("theme").addEventListener("click", function () {
    var prefersDark = !matchMedia("(prefers-color-scheme: light)").matches;
    var cur = document.documentElement.getAttribute("data-theme") || (prefersDark ? "dark" : "light");
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("linear-theme", next); } catch (e) {}
  });

  /* ---- tiny helpers -------------------------------------------------- */
  function show(kind, text) {
    msg.className = "msg show " + kind;
    msg.textContent = text;
  }
  function clearMsg() { msg.className = "msg"; msg.textContent = ""; }

  function niceSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function baseName(name) { return String(name).replace(/\.[^.]+$/, ""); }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function readBuffer(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("Could not read " + file.name)); };
      r.readAsArrayBuffer(file);
    });
  }

  /* A password-protected PDF is the one failure worth naming precisely —
     pdf-lib cannot open it, and "something went wrong" would send the user
     hunting for a problem with their file that isn't there. */
  function loadPdf(bytes, name) {
    return PDFLib.PDFDocument.load(bytes).catch(function (err) {
      if (/encrypt/i.test(String(err && err.message))) {
        throw new Error(
          (name ? '"' + name + '" is' : "That PDF is") +
          " password-protected, so it can't be edited here. Open it in your PDF reader, " +
          "save an unprotected copy, then try again."
        );
      }
      throw new Error(
        (name ? '"' + name + '"' : "That file") +
        " could not be opened — it may be damaged or not really a PDF."
      );
    });
  }

  /* Lets someone type "1-3, 7" instead of clicking twenty thumbnails. */
  function parseRanges(text, max) {
    var out = [];
    String(text).split(",").forEach(function (part) {
      part = part.trim();
      if (!part) return;
      var m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) return;
      var a = parseInt(m[1], 10);
      var b = m[2] ? parseInt(m[2], 10) : a;
      if (b < a) { var t = a; a = b; b = t; }
      for (var i = a; i <= b; i++) if (i >= 1 && i <= max) out.push(i - 1);
    });
    return out;
  }

  /* ---- state --------------------------------------------------------- */
  var state = {
    tool: null,
    files: [],        // File objects, in the order the user arranged them
    pageCount: 0,
    selected: null,   // Set of 0-based page indices
    rotation: null,   // index -> extra degrees
    thumbsFor: null   // the File thumbnails were drawn from
  };

  /* ---- tool definitions ---------------------------------------------- */
  var TOOLS = [
    {
      id: "merge",
      ic: "🔗",
      nm: "Combine",
      ds: "Several PDFs into one",
      accept: "application/pdf",
      multiple: true,
      grid: false,
      dropBig: "Choose your PDFs, or drop them here",
      dropSmall: "Pick two or more — you can reorder them before saving",
      label: "Files to combine, top to bottom",
      go: "Combine and save",
      hint: "Use the arrows to change the order.",
      ready: function () { return state.files.length >= 2; },
      run: mergeRun
    },
    {
      id: "organise",
      ic: "🗂️",
      nm: "Organise",
      ds: "Rotate or delete pages",
      accept: "application/pdf",
      multiple: false,
      grid: true,
      dropBig: "Choose a PDF, or drop one here",
      dropSmall: "Then pick the pages you want to turn or remove",
      label: "Click the pages you want to change",
      go: "Save PDF",
      hint: "",
      opts: [
        { kind: "button", id: "rotL", text: "Rotate left" },
        { kind: "button", id: "rotR", text: "Rotate right" },
        { kind: "button", id: "del", text: "Delete selected" },
        { kind: "text", id: "range", label: "…or select by number", placeholder: "e.g. 1-3, 7" }
      ],
      ready: function () { return state.files.length === 1; },
      run: organiseRun
    },
    {
      id: "split",
      ic: "✂️",
      nm: "Split",
      ds: "Pull out the pages you need",
      accept: "application/pdf",
      multiple: false,
      grid: true,
      dropBig: "Choose a PDF, or drop one here",
      dropSmall: "Then pick the pages you want to keep",
      label: "Click the pages you want to keep",
      go: "Save selected pages",
      hint: "",
      opts: [
        { kind: "text", id: "range", label: "…or select by number", placeholder: "e.g. 1-3, 7" },
        { kind: "select", id: "mode", label: "Save as", options: [
          ["one", "One PDF with those pages"],
          ["each", "A separate PDF per page"]
        ] }
      ],
      ready: function () { return state.files.length === 1 && state.selected && state.selected.size > 0; },
      run: splitRun
    },
    {
      id: "shrink",
      ic: "🗜️",
      nm: "Shrink",
      ds: "Make a big file emailable",
      accept: "application/pdf",
      multiple: false,
      grid: false,
      dropBig: "Choose a PDF, or drop one here",
      dropSmall: "Best for scans and photo-heavy files",
      label: "File to shrink",
      go: "Shrink and save",
      hint: "Pages become images, so text will no longer be selectable.",
      opts: [
        { kind: "select", id: "quality", label: "Quality", options: [
          ["0.5", "Smallest file"],
          ["0.7", "Balanced (recommended)"],
          ["0.85", "Best looking"]
        ], value: "0.7" },
        { kind: "select", id: "dpi", label: "Detail", options: [
          ["96", "Screen (96 dpi)"],
          ["150", "Good print (150 dpi)"],
          ["200", "High (200 dpi)"]
        ], value: "150" }
      ],
      ready: function () { return state.files.length === 1; },
      run: shrinkRun
    },
    {
      id: "images",
      ic: "🖼️",
      nm: "Images to PDF",
      ds: "Photos or scans into one file",
      accept: "image/*",
      multiple: true,
      grid: false,
      dropBig: "Choose your images, or drop them here",
      dropSmall: "JPG, PNG, and anything else your browser can open",
      label: "Images, in page order",
      go: "Make PDF",
      hint: "Use the arrows to change the order.",
      opts: [
        { kind: "select", id: "size", label: "Page size", options: [
          ["fit", "Fit each page to its image"],
          ["letter", "US Letter"],
          ["a4", "A4"]
        ] },
        { kind: "select", id: "margin", label: "Margin", options: [
          ["0", "None"],
          ["18", "Small"],
          ["36", "Roomy"]
        ] }
      ],
      ready: function () { return state.files.length >= 1; },
      run: imagesRun
    },
    {
      id: "export",
      ic: "📸",
      nm: "PDF to images",
      ds: "Save pages as pictures",
      accept: "application/pdf",
      multiple: false,
      grid: true,
      dropBig: "Choose a PDF, or drop one here",
      dropSmall: "Then pick the pages you want as pictures",
      label: "Click the pages you want to export",
      go: "Save images",
      hint: "Your browser may ask permission to save several files.",
      opts: [
        { kind: "text", id: "range", label: "…or select by number", placeholder: "e.g. 1-3, 7" },
        { kind: "select", id: "fmt", label: "Format", options: [["png", "PNG"], ["jpeg", "JPG"]] },
        { kind: "select", id: "dpi", label: "Detail", options: [
          ["96", "Screen (96 dpi)"],
          ["150", "Good print (150 dpi)"],
          ["300", "Very high (300 dpi)"]
        ], value: "150" }
      ],
      ready: function () { return state.files.length === 1 && state.selected && state.selected.size > 0; },
      run: exportRun
    },
    {
      id: "stamp",
      ic: "💧",
      nm: "Watermark",
      ds: "Stamp text on every page",
      accept: "application/pdf",
      multiple: false,
      grid: false,
      dropBig: "Choose a PDF, or drop one here",
      dropSmall: "Good for DRAFT, CONFIDENTIAL or a copyright line",
      label: "File to stamp",
      go: "Stamp and save",
      hint: "",
      opts: [
        { kind: "text", id: "text", label: "Text", placeholder: "CONFIDENTIAL", value: "CONFIDENTIAL" },
        { kind: "select", id: "style", label: "Placement", options: [
          ["diagonal", "Large, across the page"],
          ["footer", "Small, along the bottom"]
        ] },
        { kind: "select", id: "opacity", label: "Strength", options: [
          ["0.12", "Faint"],
          ["0.22", "Medium"],
          ["0.4", "Strong"]
        ], value: "0.22" },
        { kind: "select", id: "colour", label: "Colour", options: [
          ["grey", "Grey"], ["red", "Red"], ["blue", "Blue"]
        ] }
      ],
      ready: function () { return state.files.length === 1 && optValue("text").trim() !== ""; },
      run: stampRun
    }
  ];

  function currentTool() { return state.tool; }

  /* ---- tool picker ---------------------------------------------------- */
  var toolsEl = $("tools");
  TOOLS.forEach(function (t) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "tool";
    b.setAttribute("aria-pressed", "false");
    b.dataset.id = t.id;
    b.innerHTML = '<span class="ic" aria-hidden="true"></span><span class="nm"></span><span class="ds"></span>';
    b.querySelector(".ic").textContent = t.ic;
    b.querySelector(".nm").textContent = t.nm;
    b.querySelector(".ds").textContent = t.ds;
    b.addEventListener("click", function () { selectTool(t.id); });
    toolsEl.appendChild(b);
  });

  function selectTool(id) {
    var t = TOOLS.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var changed = !state.tool || state.tool.id !== id;
    state.tool = t;
    Array.prototype.forEach.call(toolsEl.children, function (b) {
      b.setAttribute("aria-pressed", b.dataset.id === id ? "true" : "false");
    });
    fileInput.accept = t.accept;
    fileInput.multiple = !!t.multiple;
    $("dropBig").textContent = t.dropBig;
    $("dropSmall").textContent = t.dropSmall;
    /* Switching tools mid-file would silently carry a PDF into a tool that
       wants images, so clear the tray and say so rather than guess. */
    if (changed) resetFiles();
  }

  /* ---- options rendering ---------------------------------------------- */
  function renderOpts() {
    optsEl.innerHTML = "";
    var t = currentTool();
    if (!t || !t.opts) return;
    t.opts.forEach(function (o) {
      if (o.kind === "button") {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn";
        b.id = "opt-" + o.id;
        b.textContent = o.text;
        b.addEventListener("click", function () { optButton(o.id); });
        optsEl.appendChild(b);
        return;
      }
      var wrap = document.createElement("div");
      wrap.className = "opt";
      var lab = document.createElement("label");
      lab.textContent = o.label;
      lab.htmlFor = "opt-" + o.id;
      wrap.appendChild(lab);

      var el;
      if (o.kind === "select") {
        el = document.createElement("select");
        o.options.forEach(function (pair) {
          var op = document.createElement("option");
          op.value = pair[0];
          op.textContent = pair[1];
          el.appendChild(op);
        });
        el.value = o.value || o.options[0][0];
      } else {
        el = document.createElement("input");
        el.type = "text";
        el.placeholder = o.placeholder || "";
        if (o.value) el.value = o.value;
      }
      el.id = "opt-" + o.id;
      el.addEventListener("input", function () { onOptInput(o.id); });
      el.addEventListener("change", function () { onOptInput(o.id); });
      wrap.appendChild(el);
      optsEl.appendChild(wrap);
    });
  }

  function optValue(id) {
    var el = $("opt-" + id);
    return el ? el.value : "";
  }

  function onOptInput(id) {
    if (id === "range") {
      var idx = parseRanges(optValue("range"), state.pageCount);
      state.selected = new Set(idx);
      paintSelection();
    }
    refreshGo();
  }

  function optButton(id) {
    if (!state.selected || state.selected.size === 0) {
      show("err", "Pick at least one page first.");
      return;
    }
    clearMsg();
    if (id === "rotL" || id === "rotR") {
      var delta = id === "rotL" ? -90 : 90;
      state.selected.forEach(function (i) {
        state.rotation[i] = (((state.rotation[i] || 0) + delta) % 360 + 360) % 360;
      });
      paintRotation();
    } else if (id === "del") {
      if (state.selected.size >= state.pageCount) {
        show("err", "That would delete every page — keep at least one.");
        return;
      }
      /* Deleting is recorded, not applied, so it can be undone by reloading
         and so the thumbnails stay valid until save time. */
      state.deleted = state.deleted || new Set();
      state.selected.forEach(function (i) { state.deleted.add(i); });
      state.selected.clear();
      paintSelection();
      paintDeleted();
    }
    refreshGo();
  }

  /* ---- file intake ---------------------------------------------------- */
  drop.addEventListener("click", function () {
    if (!currentTool()) { show("err", "Pick a tool above first."); return; }
    fileInput.click();
  });
  drop.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); drop.click(); }
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    if (!currentTool()) { show("err", "Pick a tool above first."); return; }
    if (e.dataTransfer && e.dataTransfer.files) takeFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files) takeFiles(fileInput.files);
    fileInput.value = "";
  });

  function takeFiles(list) {
    var t = currentTool();
    if (!t) return;
    clearMsg();
    var wantImages = t.accept.indexOf("image/") === 0;
    var accepted = [], rejected = 0;

    Array.prototype.forEach.call(list, function (f) {
      var isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      var isImg = f.type.indexOf("image/") === 0;
      if (wantImages ? isImg : isPdf) accepted.push(f); else rejected++;
    });

    if (!accepted.length) {
      show("err", wantImages ? "Those don't look like images." : "That doesn't look like a PDF.");
      return;
    }
    if (t.multiple) {
      state.files = state.files.concat(accepted);
    } else {
      state.files = [accepted[0]];
      if (accepted.length > 1) rejected += accepted.length - 1;
    }
    if (rejected) {
      show("busy", rejected + (rejected === 1 ? " file was" : " files were") + " skipped — this tool takes " +
        (wantImages ? "images" : "PDFs") + " only.");
    }
    afterFiles();
  }

  function resetFiles() {
    state.files = [];
    state.pageCount = 0;
    state.selected = new Set();
    state.rotation = {};
    state.deleted = new Set();
    state.thumbsFor = null;
    pagesGrid.innerHTML = "";
    filesEl.innerHTML = "";
    panel.classList.remove("show");
    clearMsg();
  }

  resetBtn.addEventListener("click", function () {
    resetFiles();
    if (currentTool()) renderOpts();
  });

  function afterFiles() {
    var t = currentTool();
    panel.classList.add("show");
    panelLabel.textContent = t.label;
    goBtn.textContent = t.go;
    hintEl.textContent = t.hint || "";
    renderOpts();
    renderFileList();

    if (t.grid) {
      filesEl.style.display = "none";
      renderThumbs();
    } else {
      filesEl.style.display = "";
      pagesGrid.innerHTML = "";
      refreshGo();
    }
  }

  function renderFileList() {
    filesEl.innerHTML = "";
    state.files.forEach(function (f, i) {
      var row = document.createElement("div");
      row.className = "file";

      var nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = f.name;

      var sz = document.createElement("span");
      sz.className = "sz";
      sz.textContent = niceSize(f.size);

      row.appendChild(nm);
      row.appendChild(sz);

      if (currentTool().multiple) {
        [["↑", -1], ["↓", 1], ["✕", 0]].forEach(function (pair) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "mv";
          b.textContent = pair[0];
          b.title = pair[1] === 0 ? "Remove" : (pair[1] < 0 ? "Move up" : "Move down");
          if (pair[1] === -1 && i === 0) b.disabled = true;
          if (pair[1] === 1 && i === state.files.length - 1) b.disabled = true;
          b.addEventListener("click", function () {
            if (pair[1] === 0) state.files.splice(i, 1);
            else {
              var j = i + pair[1];
              var tmp = state.files[i];
              state.files[i] = state.files[j];
              state.files[j] = tmp;
            }
            if (!state.files.length) { resetFiles(); return; }
            renderFileList();
            refreshGo();
          });
          row.appendChild(b);
        });
      }
      filesEl.appendChild(row);
    });
  }

  /* ---- thumbnails ------------------------------------------------------ */
  function renderThumbs() {
    var f = state.files[0];
    if (!f) return;
    pagesGrid.innerHTML = "";
    state.selected = new Set();
    state.rotation = {};
    state.deleted = new Set();
    goBtn.disabled = true;
    show("busy", "Opening " + f.name + "…");

    readBuffer(f).then(function (buf) {
      return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (doc) {
      state.pageCount = doc.numPages;
      state.thumbsFor = f;
      var chain = Promise.resolve();
      for (var p = 1; p <= doc.numPages; p++) chain = chain.then(thumbStep(doc, p));
      return chain.then(function () {
        clearMsg();
        refreshGo();
      });
    }).catch(function (err) {
      var pw = /password/i.test(String(err && (err.name + err.message)));
      show("err", pw
        ? '"' + f.name + '" is password-protected, so it can\'t be opened here. Save an unprotected copy from your PDF reader and try again.'
        : ('Could not open "' + f.name + '" — it may be damaged or not really a PDF.'));
      resetFiles();
    });
  }

  function thumbStep(doc, num) {
    return function () {
      return doc.getPage(num).then(function (page) {
        var base = page.getViewport({ scale: 1 });
        var scale = 150 / base.width;
        var vp = page.getViewport({ scale: scale });

        var cell = document.createElement("div");
        cell.className = "page";
        cell.dataset.i = num - 1;

        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(vp.width));
        canvas.height = Math.max(1, Math.floor(vp.height));

        var n = document.createElement("div");
        n.className = "n";
        n.textContent = "Page " + num;

        cell.appendChild(canvas);
        cell.appendChild(n);
        cell.addEventListener("click", function () { togglePage(num - 1); });
        pagesGrid.appendChild(cell);

        return page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      });
    };
  }

  function togglePage(i) {
    if (state.deleted && state.deleted.has(i)) return;
    if (state.selected.has(i)) state.selected.delete(i); else state.selected.add(i);
    var r = $("opt-range");
    if (r) r.value = "";
    paintSelection();
    refreshGo();
  }

  function paintSelection() {
    Array.prototype.forEach.call(pagesGrid.children, function (cell) {
      var i = parseInt(cell.dataset.i, 10);
      cell.classList.toggle("sel", state.selected.has(i));
    });
  }

  function paintRotation() {
    Array.prototype.forEach.call(pagesGrid.children, function (cell) {
      var i = parseInt(cell.dataset.i, 10);
      var deg = state.rotation[i] || 0;
      var tag = cell.querySelector(".rot");
      if (deg) {
        if (!tag) {
          tag = document.createElement("span");
          tag.className = "rot";
          cell.appendChild(tag);
        }
        tag.textContent = deg + "°";
      } else if (tag) {
        tag.remove();
      }
      var c = cell.querySelector("canvas");
      if (!c) return;
      if (!deg) { c.style.transform = ""; return; }
      /* A quarter turn swaps the canvas's width and height, which would spill
         it out of the cell, so it is scaled back down to fit on the way round.
         The cell keeps its portrait footprint and the grid stays even. */
      var quarter = deg === 90 || deg === 270;
      var fit = quarter ? Math.min(c.clientWidth / c.clientHeight, 1) : 1;
      c.style.transform = "rotate(" + deg + "deg)" + (fit !== 1 ? " scale(" + fit + ")" : "");
    });
  }

  function paintDeleted() {
    Array.prototype.forEach.call(pagesGrid.children, function (cell) {
      var i = parseInt(cell.dataset.i, 10);
      if (state.deleted.has(i)) {
        cell.style.opacity = ".3";
        var n = cell.querySelector(".n");
        if (n && n.textContent.indexOf("removed") === -1) n.textContent = "Page " + (i + 1) + " — removed";
      }
    });
  }

  function refreshGo() {
    var t = currentTool();
    goBtn.disabled = !(t && t.ready());
  }

  /* ---- shared raster helper -------------------------------------------- */
  function renderToCanvas(page, dpi) {
    var vp = page.getViewport({ scale: dpi / 72 });
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    var ctx = canvas.getContext("2d");
    /* pdf.js draws transparent where a page is blank; JPEG has no alpha, so
       without this the empty areas come out black. */
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () { return canvas; });
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (b) resolve(b); else reject(new Error("Your browser could not create the image."));
      }, type, quality);
    });
  }

  /* ---- the tools ------------------------------------------------------- */
  function mergeRun() {
    show("busy", "Combining " + state.files.length + " files…");
    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      state.files.forEach(function (f) {
        chain = chain.then(function () {
          return readBuffer(f)
            .then(function (buf) { return loadPdf(buf, f.name); })
            .then(function (src) { return out.copyPages(src, src.getPageIndices()); })
            .then(function (pages) { pages.forEach(function (p) { out.addPage(p); }); });
        });
      });
      return chain.then(function () { return out.save(); }).then(function (bytes) {
        download(new Blob([bytes], { type: "application/pdf" }), "combined.pdf");
        show("ok", "Saved combined.pdf — " + out.getPageCount() + " pages.");
      });
    });
  }

  function organiseRun() {
    var f = state.files[0];
    show("busy", "Saving…");
    return readBuffer(f)
      .then(function (buf) { return loadPdf(buf, f.name); })
      .then(function (doc) {
        var keep = [];
        for (var i = 0; i < doc.getPageCount(); i++) if (!state.deleted.has(i)) keep.push(i);
        if (!keep.length) throw new Error("Every page was removed — keep at least one.");

        return PDFLib.PDFDocument.create().then(function (out) {
          return out.copyPages(doc, keep).then(function (pages) {
            pages.forEach(function (p, n) {
              var deg = state.rotation[keep[n]] || 0;
              if (deg) p.setRotation(PDFLib.degrees((p.getRotation().angle + deg) % 360));
              out.addPage(p);
            });
            return out.save();
          }).then(function (bytes) {
            download(new Blob([bytes], { type: "application/pdf" }), baseName(f.name) + "-edited.pdf");
            var removed = state.deleted.size;
            show("ok", "Saved " + keep.length + " pages" + (removed ? " (" + removed + " removed)" : "") + ".");
          });
        });
      });
  }

  function splitRun() {
    var f = state.files[0];
    var each = optValue("mode") === "each";
    var idx = Array.from(state.selected).sort(function (a, b) { return a - b; });
    show("busy", "Saving…");

    return readBuffer(f)
      .then(function (buf) { return loadPdf(buf, f.name); })
      .then(function (doc) {
        if (!each) {
          return PDFLib.PDFDocument.create().then(function (out) {
            return out.copyPages(doc, idx).then(function (pages) {
              pages.forEach(function (p) { out.addPage(p); });
              return out.save();
            });
          }).then(function (bytes) {
            download(new Blob([bytes], { type: "application/pdf" }), baseName(f.name) + "-pages.pdf");
            show("ok", "Saved " + idx.length + (idx.length === 1 ? " page." : " pages."));
          });
        }
        var chain = Promise.resolve();
        idx.forEach(function (i) {
          chain = chain.then(function () {
            return PDFLib.PDFDocument.create().then(function (out) {
              return out.copyPages(doc, [i]).then(function (pages) {
                out.addPage(pages[0]);
                return out.save();
              });
            }).then(function (bytes) {
              download(new Blob([bytes], { type: "application/pdf" }),
                baseName(f.name) + "-page-" + (i + 1) + ".pdf");
              /* Browsers throttle or drop a burst of downloads fired in the
                 same tick, so the files are spaced out deliberately. */
              return new Promise(function (r) { setTimeout(r, 350); });
            });
          });
        });
        return chain.then(function () {
          show("ok", "Saved " + idx.length + " separate files.");
        });
      });
  }

  function shrinkRun() {
    var f = state.files[0];
    var quality = parseFloat(optValue("quality"));
    var dpi = parseInt(optValue("dpi"), 10);
    var original = f.size;
    show("busy", "Shrinking…");

    return readBuffer(f).then(function (buf) {
      return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (doc) {
      return PDFLib.PDFDocument.create().then(function (out) {
        var chain = Promise.resolve();
        for (var p = 1; p <= doc.numPages; p++) {
          (function (num) {
            chain = chain.then(function () {
              show("busy", "Shrinking page " + num + " of " + doc.numPages + "…");
              return doc.getPage(num).then(function (page) {
                var pt = page.getViewport({ scale: 1 });
                return renderToCanvas(page, dpi)
                  .then(function (c) { return canvasBlob(c, "image/jpeg", quality); })
                  .then(function (blob) { return blob.arrayBuffer(); })
                  .then(function (ab) { return out.embedJpg(ab); })
                  .then(function (img) {
                    var pg = out.addPage([pt.width, pt.height]);
                    pg.drawImage(img, { x: 0, y: 0, width: pt.width, height: pt.height });
                  });
              });
            });
          })(p);
        }
        return chain.then(function () { return out.save(); });
      });
    }).then(function (bytes) {
      var blob = new Blob([bytes], { type: "application/pdf" });
      download(blob, baseName(f.name) + "-small.pdf");
      if (blob.size >= original) {
        show("busy", "Saved, but it came out " + niceSize(blob.size) + " — no smaller than the original " +
          niceSize(original) + ". This file was probably mostly text, which is already compact. Try a lower detail setting, or keep the original.");
      } else {
        var pct = Math.round((1 - blob.size / original) * 100);
        show("ok", "Saved at " + niceSize(blob.size) + " — " + pct + "% smaller than " + niceSize(original) + ".");
      }
    });
  }

  function imagesRun() {
    var sizeMode = optValue("size");
    var margin = parseInt(optValue("margin"), 10) || 0;
    var SIZES = { letter: [612, 792], a4: [595.28, 841.89] };
    show("busy", "Building your PDF…");

    return PDFLib.PDFDocument.create().then(function (out) {
      var chain = Promise.resolve();
      state.files.forEach(function (f, n) {
        chain = chain.then(function () {
          show("busy", "Adding image " + (n + 1) + " of " + state.files.length + "…");
          return normaliseImage(f).then(function (res) {
            var embed = res.type === "png" ? out.embedPng(res.data) : out.embedJpg(res.data);
            return Promise.resolve(embed).then(function (img) {
              var pw, ph;
              if (sizeMode === "fit") {
                pw = img.width + margin * 2;
                ph = img.height + margin * 2;
              } else {
                pw = SIZES[sizeMode][0];
                ph = SIZES[sizeMode][1];
              }
              var page = out.addPage([pw, ph]);
              var availW = pw - margin * 2, availH = ph - margin * 2;
              var scale = Math.min(availW / img.width, availH / img.height);
              var w = img.width * scale, h = img.height * scale;
              page.drawImage(img, {
                x: (pw - w) / 2,
                y: (ph - h) / 2,
                width: w,
                height: h
              });
            });
          });
        });
      });
      return chain.then(function () { return out.save(); });
    }).then(function (bytes) {
      download(new Blob([bytes], { type: "application/pdf" }), "images.pdf");
      show("ok", "Saved images.pdf — " + state.files.length +
        (state.files.length === 1 ? " page." : " pages."));
    });
  }

  /* pdf-lib embeds only JPEG and PNG. Anything else the browser can display
     (HEIC on Safari, WebP, GIF, BMP…) is repainted through a canvas first, so
     the user never has to care what their phone produced. */
  function normaliseImage(file) {
    var lower = file.name.toLowerCase();
    var isJpg = file.type === "image/jpeg" || /\.jpe?g$/.test(lower);
    var isPng = file.type === "image/png" || /\.png$/.test(lower);

    if (isJpg || isPng) {
      return readBuffer(file).then(function (buf) {
        return { data: buf, type: isPng ? "png" : "jpg" };
      });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvasBlob(c, "image/jpeg", 0.92)
          .then(function (b) { return b.arrayBuffer(); })
          .then(function (ab) { resolve({ data: ab, type: "jpg" }); })
          .catch(reject);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not open "' + file.name + '" as an image.'));
      };
      img.src = url;
    });
  }

  function exportRun() {
    var f = state.files[0];
    var fmt = optValue("fmt");
    var dpi = parseInt(optValue("dpi"), 10);
    var mime = fmt === "png" ? "image/png" : "image/jpeg";
    var ext = fmt === "png" ? "png" : "jpg";
    var idx = Array.from(state.selected).sort(function (a, b) { return a - b; });
    show("busy", "Rendering…");

    return readBuffer(f).then(function (buf) {
      return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    }).then(function (doc) {
      var chain = Promise.resolve();
      idx.forEach(function (i, n) {
        chain = chain.then(function () {
          show("busy", "Rendering page " + (i + 1) + " (" + (n + 1) + " of " + idx.length + ")…");
          return doc.getPage(i + 1)
            .then(function (page) { return renderToCanvas(page, dpi); })
            .then(function (c) { return canvasBlob(c, mime, 0.92); })
            .then(function (blob) {
              download(blob, baseName(f.name) + "-page-" + (i + 1) + "." + ext);
              return new Promise(function (r) { setTimeout(r, 350); });
            });
        });
      });
      return chain.then(function () {
        show("ok", "Saved " + idx.length + (idx.length === 1 ? " image." : " images."));
      });
    });
  }

  function stampRun() {
    var f = state.files[0];
    var text = optValue("text").trim();
    var style = optValue("style");
    var opacity = parseFloat(optValue("opacity"));
    var COLOURS = {
      grey: PDFLib.rgb(0.45, 0.45, 0.5),
      red: PDFLib.rgb(0.85, 0.15, 0.15),
      blue: PDFLib.rgb(0.1, 0.4, 0.8)
    };
    var colour = COLOURS[optValue("colour")] || COLOURS.grey;
    show("busy", "Stamping…");

    return readBuffer(f)
      .then(function (buf) { return loadPdf(buf, f.name); })
      .then(function (doc) {
        return doc.embedFont(PDFLib.StandardFonts.HelveticaBold).then(function (font) {
          doc.getPages().forEach(function (page) {
            var w = page.getWidth(), h = page.getHeight();
            if (style === "footer") {
              var fs = Math.min(14, w / 34);
              var tw = font.widthOfTextAtSize(text, fs);
              page.drawText(text, {
                x: (w - tw) / 2,
                y: 22,
                size: fs,
                font: font,
                color: colour,
                opacity: Math.min(1, opacity * 2.4)
              });
            } else {
              /* Size the text so the diagonal run fits the page's own diagonal,
                 whatever the page shape, then centre it on that diagonal. */
              var diag = Math.sqrt(w * w + h * h);
              var fs2 = diag / (text.length * 0.62 + 2);
              fs2 = Math.max(12, Math.min(fs2, h / 2));
              var tw2 = font.widthOfTextAtSize(text, fs2);
              var angle = Math.atan2(h, w);
              page.drawText(text, {
                x: w / 2 - (tw2 / 2) * Math.cos(angle) + (fs2 / 3) * Math.sin(angle),
                y: h / 2 - (tw2 / 2) * Math.sin(angle) - (fs2 / 3) * Math.cos(angle),
                size: fs2,
                font: font,
                color: colour,
                opacity: opacity,
                rotate: PDFLib.radians(angle)
              });
            }
          });
          return doc.save();
        });
      })
      .then(function (bytes) {
        download(new Blob([bytes], { type: "application/pdf" }), baseName(f.name) + "-stamped.pdf");
        show("ok", "Saved your stamped PDF.");
      });
  }

  /* ---- run ------------------------------------------------------------- */
  goBtn.addEventListener("click", function () {
    var t = currentTool();
    if (!t || goBtn.disabled) return;
    goBtn.disabled = true;
    var label = goBtn.textContent;
    goBtn.textContent = "Working…";

    Promise.resolve()
      .then(function () { return t.run(); })
      .catch(function (err) {
        show("err", (err && err.message) || "Something went wrong with that file.");
      })
      .then(function () {
        goBtn.textContent = label;
        refreshGo();
      });
  });

  /* Start on the tool people come for most. */
  selectTool("merge");
})();
