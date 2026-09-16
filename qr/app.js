/* Linear QR — decode a QR code image entirely in the browser.
   The picture is drawn to an off-screen canvas and handed to jsQR; no
   part of it is ever sent anywhere. */
(function () {
  "use strict";

  var drop = document.getElementById("drop");
  var file = document.getElementById("file");
  var msg = document.getElementById("msg");
  var result = document.getElementById("result");
  var kindEl = document.getElementById("kind");
  var valueEl = document.getElementById("value");
  var noteEl = document.getElementById("note");
  var openBtn = document.getElementById("open");
  var copyBtn = document.getElementById("copy");
  var preview = document.getElementById("preview");
  var previewImg = document.getElementById("previewImg");

  /* ---- theme -------------------------------------------------------- */
  var saved = null;
  try { saved = localStorage.getItem("linear-theme"); } catch (e) {}
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("theme").addEventListener("click", function () {
    var dark = !matchMedia("(prefers-color-scheme: light)").matches;
    var cur = document.documentElement.getAttribute("data-theme") || (dark ? "dark" : "light");
    var next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("linear-theme", next); } catch (e) {}
  });

  /* ---- small helpers ------------------------------------------------ */
  function show(el, cls) { el.className = cls ? el.className.split(" ")[0] + " " + cls + " show" : el.className + " show"; }
  function say(text, kind) {
    msg.textContent = text;
    msg.className = "msg " + kind + " show";
  }
  function clearSay() { msg.className = "msg"; msg.textContent = ""; }

  /* What kind of payload is this? Enough of a guess to label it and to
     decide whether offering an "Open link" button is safe. */
  function classify(text) {
    var t = text.trim();
    if (/^https?:\/\//i.test(t)) return { kind: "Link", url: t };
    if (/^mailto:/i.test(t)) return { kind: "Email address", url: t };
    if (/^tel:/i.test(t)) return { kind: "Phone number", url: t };
    if (/^smsto?:/i.test(t)) return { kind: "Text message" };
    if (/^WIFI:/i.test(t)) return { kind: "Wi-Fi network" };
    if (/^BEGIN:VCARD/i.test(t)) return { kind: "Contact card" };
    if (/^BEGIN:VEVENT/i.test(t)) return { kind: "Calendar event" };
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return { kind: "Link" };
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return { kind: "Web address", url: "https://" + t };
    return { kind: "Text" };
  }

  /* jsQR wants raw pixels. Very large photos are slow and, past a point,
     no more accurate — so shrink anything oversized, and if the first
     pass misses, retry at a couple of other scales before giving up. */
  function scan(img) {
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var scales = [1, 0.5, 2];

    for (var i = 0; i < scales.length; i++) {
      var w = Math.round(img.naturalWidth * scales[i]);
      var h = Math.round(img.naturalHeight * scales[i]);
      var cap = 1600;
      if (Math.max(w, h) > cap) {
        var f = cap / Math.max(w, h);
        w = Math.round(w * f); h = Math.round(h * f);
      }
      if (w < 8 || h < 8) continue;

      canvas.width = w; canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      var data;
      try {
        data = ctx.getImageData(0, 0, w, h);
      } catch (e) {
        return { error: "That image could not be read by the browser." };
      }
      var code = jsQR(data.data, w, h, { inversionAttempts: "attemptBoth" });
      if (code && code.data) return { text: code.data };
    }
    return { error: "No QR code found in that image. Try a sharper or more closely cropped picture." };
  }

  function render(text) {
    var info = classify(text);
    kindEl.textContent = info.kind;
    valueEl.textContent = text;

    if (info.url) {
      openBtn.href = info.url;
      openBtn.hidden = false;
      openBtn.textContent = info.kind === "Link" || info.kind === "Web address" ? "Open link" : "Open";
    } else {
      openBtn.hidden = true;
      openBtn.removeAttribute("href");
    }

    /* A QR code is unreadable to a person, which is exactly what makes a
       misleading one effective. Say where the link actually goes. */
    noteEl.className = "note";
    if (info.url && /^https?:/i.test(info.url)) {
      var host = "";
      try { host = new URL(info.url).hostname; } catch (e) {}
      if (host) {
        noteEl.textContent = "This opens " + host + ". Check that it is who you expect before signing in or paying.";
        noteEl.className = "note show";
      }
    }

    result.className = "result show";
    clearSay();
  }

  function handleImage(src) {
    result.className = "result";
    say("Reading…", "busy");
    var img = new Image();
    img.onload = function () {
      previewImg.src = src;
      preview.className = "show";
      var out = scan(img);
      if (out.text) render(out.text);
      else say(out.error, "err");
    };
    img.onerror = function () { say("That file is not an image the browser can open.", "err"); };
    img.src = src;
  }

  function handleFile(f) {
    if (!f) return;
    if (!/^image\//.test(f.type)) {
      say("Please choose an image file (PNG, JPG, GIF, WebP…).", "err");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { handleImage(reader.result); };
    reader.onerror = function () { say("That file could not be read.", "err"); };
    reader.readAsDataURL(f);
  }

  /* ---- the three ways in -------------------------------------------- */
  drop.addEventListener("click", function () { file.click(); });
  drop.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); }
  });
  file.addEventListener("change", function () { handleFile(file.files[0]); file.value = ""; });

  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    var dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) handleFile(dt.files[0]);
  });
  // Dropping anywhere else shouldn't navigate away from the page.
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  window.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image/") === 0) {
        handleFile(items[i].getAsFile());
        e.preventDefault();
        return;
      }
    }
  });

  copyBtn.addEventListener("click", function () {
    var text = valueEl.textContent;
    var done = function () {
      copyBtn.textContent = "Copied";
      setTimeout(function () { copyBtn.textContent = "Copy"; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { copyBtn.textContent = "Press Ctrl+C"; });
    } else {
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(valueEl);
      sel.removeAllRanges(); sel.addRange(range);
      try { document.execCommand("copy"); done(); } catch (e) { copyBtn.textContent = "Press Ctrl+C"; }
    }
  });
})();
