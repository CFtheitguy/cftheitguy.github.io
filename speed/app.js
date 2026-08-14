/* =============================================================================
 * Linear Speed — speed.linearit.co
 * =============================================================================
 * A speed test that measures three things honestly and says so plainly:
 *
 *   ping / jitter  a dozen tiny round trips to the edge; median and average
 *                  swing between consecutive trips
 *   download       several parallel streams of incompressible random bytes,
 *                  counted as they arrive
 *   upload         several parallel posts of random bytes, counted by the
 *                  browser's own upload-progress events
 *
 * Both transfer phases throw away the first second and a half. That is the
 * connection ramping up — TCP slow start, Wi-Fi negotiating a rate — and
 * including it would report a number lower than the line actually delivers.
 *
 * The endpoints live in the `linear-speed` Worker (see /speed-worker). Nothing
 * about a test is stored anywhere: the bytes are generated on demand, thrown
 * away on arrival, and the result exists only in this tab.
 * ========================================================================== */
(function () {
  "use strict";

  /* ---- Tuning ------------------------------------------------------------ */
  // The app is served two ways: by the Worker at speed.linearit.co, where the
  // endpoints are same-origin, and from the GitHub Pages copy at
  // www.linearit.co/speed/, which has to call across to the Worker.
  var PAGES_HOSTS = ["www.linearit.co", "linearit.co", "cftheitguy.github.io"];
  var API = PAGES_HOSTS.indexOf(location.hostname.toLowerCase()) >= 0 ? "https://speed.linearit.co" : "";

  var PING_COUNT = 12;          // round trips to time (the first is discarded)
  var DL_MS = 10000;            // how long to pull down for
  var UL_MS = 9000;             // how long to push up for
  var RAMP_MS = 1500;           // ignored at the start of each transfer phase
  var DL_STREAMS = 4;           // parallel download connections
  var UL_STREAMS = 3;           // parallel upload connections
  var DL_REQUEST = 96 * 1024 * 1024; // bytes asked for per download request
  var UL_CHUNK = 6 * 1024 * 1024;    // bytes per upload post
  var TICK_MS = 100;            // how often the dial and the live number move
  var WINDOW_MS = 1200;         // sliding window behind the live number
  var QUOTE_MS = 11000;         // how long each quote stays on screen

  /* ---- Something to read while you wait ---------------------------------- */
  var QUOTES = [
    "Patience isn’t the ability to wait. It’s how well you behave while you’re waiting.",
    "No internet at all? Then today is a go-outside kind of day. Enjoy it.",
    "Somewhere out there a small router is doing its absolute best. Give it a moment.",
    "A watched progress bar never fills. Look out the window instead.",
    "Slow is smooth, and smooth is fast.",
    "Rivers cut through rock not by force, but by persistence.",
    "You are not stuck. You are downloading.",
    "Everything worth having takes a little buffering.",
    "The best time to reboot the router was ten minutes ago. The second best time is now.",
    "Wi-Fi is a shared road. At seven in the evening, everyone is driving.",
    "Nothing in the universe moves faster than light — and even light takes its time.",
    "Your data may be swimming under an ocean right now. Distance is real.",
    "Take a breath. The bits are on their way.",
    "Good things come to those who wait. Great things come to those who run a cable.",
    "If it comes back slower than you hoped, don’t shoot the messenger. Call us.",
    "One coffee’s worth of patience and we’ll have your number.",
    "“It feels slow” is a feeling. In a moment, it’ll be a number.",
    "Half of fixing anything is being willing to wait for it to tell you what’s wrong.",
    "Hurry is the enemy of accuracy — in networks and in most other things.",
    "The signal is invisible, travels at nearly light speed, and still needs a minute. Be gracious."
  ];

  /* ---- Elements ---------------------------------------------------------- */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    themeBtn: $("themeBtn"),
    ticks: $("ticks"), arcTrack: $("arcTrack"), arcFill: $("arcFill"),
    goBtn: $("goBtn"), live: $("live"), phase: $("phase"), bignum: $("bignum"), unit: $("unit"),
    progress: $("progress"), progressBar: $("progressBar"),
    quote: $("quote"), quoteText: $("quoteText"),
    results: $("results"),
    statPing: $("statPing"), statJitter: $("statJitter"), statDown: $("statDown"), statUp: $("statUp"),
    vPing: $("vPing"), vJitter: $("vJitter"), vDown: $("vDown"), vUp: $("vUp"),
    verdict: $("verdict"), meta: $("meta"), actions: $("actions"),
    againBtn: $("againBtn"), copyBtn: $("copyBtn"),
    trouble: $("trouble"), troubleEmoji: $("troubleEmoji"), troubleTitle: $("troubleTitle"),
    troubleText: $("troubleText"), retryBtn: $("retryBtn")
  };

  var now = function () { return performance.now(); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var rnd = function () { return Math.random().toString(36).slice(2) + Date.now().toString(36); };

  /* =========================================================================
   * Theme — dark by default, light when the device or the visitor asks for it
   * ======================================================================= */
  var THEME_KEY = "lspeed_theme";
  var prefersLight = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;

  function currentTheme() {
    var set = document.documentElement.getAttribute("data-theme");
    if (set === "light" || set === "dark") return set;
    return prefersLight && prefersLight.matches ? "light" : "dark";
  }
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute("data-theme", t);
    var light = currentTheme() === "light";
    el.themeBtn.textContent = light ? "☀️" : "🌙";
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", light ? "#f4f6fb" : "#0f1117");
  }
  try {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  } catch (_) {}
  applyTheme(null);
  el.themeBtn.addEventListener("click", function () {
    var next = currentTheme() === "light" ? "dark" : "light";
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyTheme(next);
  });
  // Follow the device if the visitor has never chosen for themselves.
  if (prefersLight && prefersLight.addEventListener) {
    prefersLight.addEventListener("change", function () {
      var chosen = null;
      try { chosen = localStorage.getItem(THEME_KEY); } catch (_) {}
      if (chosen !== "light" && chosen !== "dark") applyTheme(null);
    });
  }

  /* =========================================================================
   * The dial
   * ======================================================================= */
  // A 270° arc, open at the bottom: starts at 7-o'clock, sweeps clockwise to
  // 5-o'clock. The scale is piecewise so a 40 Mbps line and a 900 Mbps line
  // both land somewhere readable instead of both hugging one end.
  var STOPS = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000];
  var R = 82, CX = 100, CY = 100, SWEEP = 270, START = -135;
  var arcLen = 0;

  function polar(r, deg) {
    var a = (deg - 90) * Math.PI / 180;
    return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
  }
  function buildGauge() {
    var a = polar(R, START), b = polar(R, START + SWEEP);
    var d = "M " + a.x.toFixed(2) + " " + a.y.toFixed(2) +
            " A " + R + " " + R + " 0 1 1 " + b.x.toFixed(2) + " " + b.y.toFixed(2);
    el.arcTrack.setAttribute("d", d);
    el.arcFill.setAttribute("d", d);
    arcLen = el.arcFill.getTotalLength();
    el.arcFill.style.strokeDasharray = arcLen;
    el.arcFill.style.strokeDashoffset = arcLen;

    var svgNS = "http://www.w3.org/2000/svg", frag = document.createDocumentFragment();
    STOPS.forEach(function (v, i) {
      var deg = START + (SWEEP * i) / (STOPS.length - 1);
      var p1 = polar(R - 9, deg), p2 = polar(R - 14, deg), lp = polar(R - 23, deg);
      var line = document.createElementNS(svgNS, "line");
      line.setAttribute("class", "tick");
      line.setAttribute("x1", p1.x.toFixed(2)); line.setAttribute("y1", p1.y.toFixed(2));
      line.setAttribute("x2", p2.x.toFixed(2)); line.setAttribute("y2", p2.y.toFixed(2));
      frag.appendChild(line);
      var t = document.createElementNS(svgNS, "text");
      t.setAttribute("class", "ticklabel");
      t.setAttribute("x", lp.x.toFixed(2)); t.setAttribute("y", (lp.y + 3).toFixed(2));
      t.textContent = String(v);
      frag.appendChild(t);
    });
    el.ticks.appendChild(frag);
  }
  /** Where a speed sits on the dial, 0..1, interpolated between the printed stops. */
  function dialFraction(mbps) {
    if (!(mbps > 0)) return 0;
    if (mbps >= STOPS[STOPS.length - 1]) return 1;
    for (var i = 1; i < STOPS.length; i++) {
      if (mbps <= STOPS[i]) {
        var span = STOPS[i] - STOPS[i - 1];
        var within = span ? (mbps - STOPS[i - 1]) / span : 0;
        return (i - 1 + within) / (STOPS.length - 1);
      }
    }
    return 1;
  }
  function setDial(frac) {
    frac = Math.max(0, Math.min(1, frac || 0));
    el.arcFill.style.strokeDashoffset = arcLen * (1 - frac);
  }
  function setProgress(frac) {
    el.progressBar.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + "%";
  }

  function fmtSpeed(mbps) {
    if (!isFinite(mbps) || mbps <= 0) return "0.0";
    if (mbps >= 100) return String(Math.round(mbps));
    if (mbps >= 10) return mbps.toFixed(1);
    return mbps.toFixed(2);
  }

  /* =========================================================================
   * Quotes — one at a time, a fresh one every 11 seconds, no countdown
   * ======================================================================= */
  var quoteTimer = null, quoteOrder = [], quoteAt = 0, quoteToken = 0;
  var FADE_MS = 700; // matches the transition on .quote p

  function shuffled(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function showQuote(text) {
    var token = ++quoteToken;
    el.quoteText.classList.remove("in");
    // Let the old line fade out before the new one takes its place.
    setTimeout(function () {
      if (token !== quoteToken) return; // superseded while fading
      el.quoteText.textContent = text;
      // Next frame, so the browser animates the change instead of jumping to it.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (token === quoteToken) el.quoteText.classList.add("in");
        });
      });
    }, el.quoteText.textContent ? FADE_MS : 0);
  }
  function startQuotes() {
    stopQuotes();
    el.quote.classList.remove("done");
    quoteOrder = shuffled(QUOTES);
    quoteAt = 0;
    showQuote(quoteOrder[0]);
    quoteTimer = setInterval(function () {
      quoteAt = (quoteAt + 1) % quoteOrder.length;
      showQuote(quoteOrder[quoteAt]);
    }, QUOTE_MS);
  }
  function stopQuotes() {
    if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; }
  }
  function clearQuote() {
    stopQuotes();
    var token = ++quoteToken;
    el.quoteText.classList.remove("in");
    setTimeout(function () {
      if (token !== quoteToken) return;
      el.quoteText.textContent = "";
      el.quote.classList.add("done");
    }, FADE_MS);
  }

  /* =========================================================================
   * Transfer bookkeeping
   * ======================================================================= */
  // One counter shared by every stream in the current phase. `mark` is taken
  // once the ramp-up window has passed; the reported speed is measured from
  // there, not from the very first byte.
  var meter = null;

  function newMeter() {
    return { bytes: 0, t0: now(), mark: null, samples: [], live: 0 };
  }
  function meterTick() {
    if (!meter) return;
    var t = now();
    meter.samples.push({ t: t, bytes: meter.bytes });
    while (meter.samples.length > 2 && t - meter.samples[0].t > WINDOW_MS) meter.samples.shift();
    if (!meter.mark && t - meter.t0 >= RAMP_MS) meter.mark = { t: t, bytes: meter.bytes };
    var first = meter.samples[0], last = meter.samples[meter.samples.length - 1];
    var dt = last.t - first.t;
    meter.live = dt > 120 ? ((last.bytes - first.bytes) * 8) / (dt * 1000) : meter.live;
    return meter.live;
  }
  /** Mbps over the honest part of the phase — after the ramp, up to right now. */
  function meterResult() {
    if (!meter) return 0;
    var t = now();
    var from = meter.mark || { t: meter.t0, bytes: 0 };
    var dt = t - from.t, db = meter.bytes - from.bytes;
    if (dt < 250 || db <= 0) {
      // The phase was too short to have a settled window (a very slow line, or
      // a very fast one that finished early). Fall back to the whole phase.
      dt = t - meter.t0; db = meter.bytes;
    }
    return dt > 0 ? (db * 8) / (dt * 1000) : 0;
  }

  /* =========================================================================
   * The three measurements
   * ======================================================================= */
  function api(path, params) {
    var u = API + path + "?r=" + rnd();
    if (params) for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) {
      u += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    }
    return u;
  }

  /** A dozen small round trips. Median for ping, mean swing for jitter. */
  async function measureLatency(onSample) {
    var times = [];
    for (var i = 0; i < PING_COUNT; i++) {
      var t0 = now();
      var res = await fetch(api("/api/ping"), { cache: "no-store", mode: "cors" });
      if (!res.ok && res.status !== 204) throw new Error("ping failed (" + res.status + ")");
      var dt = now() - t0;
      // The first trip pays for DNS, TLS and the connection itself, which is
      // not what "ping" means to anyone asking the question.
      if (i > 0) {
        times.push(dt);
        if (onSample) onSample(times.slice(), (i + 1) / PING_COUNT);
      }
      await sleep(40);
    }
    if (!times.length) throw new Error("no ping samples");
    var sorted = times.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    var ping = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    var swing = 0;
    for (var j = 1; j < times.length; j++) swing += Math.abs(times[j] - times[j - 1]);
    var jitter = times.length > 1 ? swing / (times.length - 1) : 0;
    return { ping: ping, jitter: jitter };
  }

  /** Pull down for DL_MS on several connections at once. */
  async function measureDownload() {
    var ctl = new AbortController();
    var running = true;
    var failures = 0;

    async function stream() {
      while (running) {
        var res;
        try {
          res = await fetch(api("/api/down", { bytes: DL_REQUEST }), {
            cache: "no-store", mode: "cors", signal: ctl.signal
          });
        } catch (e) {
          if (!running || ctl.signal.aborted) return;
          failures++; return;
        }
        if (!res.ok || !res.body) { failures++; return; }
        var reader = res.body.getReader();
        try {
          for (;;) {
            var r = await reader.read();
            if (r.done) break;
            meter.bytes += r.value.byteLength;
            if (!running) break;
          }
        } catch (e) {
          if (!running || ctl.signal.aborted) return;
          failures++; return;
        }
        try { await reader.cancel(); } catch (_) {}
      }
    }

    var tasks = [];
    for (var i = 0; i < DL_STREAMS; i++) tasks.push(stream());
    await sleep(DL_MS);
    running = false;
    ctl.abort();
    await Promise.allSettled(tasks);
    if (meter.bytes === 0) throw new Error(failures ? "download blocked" : "no data received");
    return meterResult();
  }

  /** Build one blob of random bytes and post it over and over. */
  function makePayload(size) {
    var buf = new Uint8Array(size);
    // crypto.getRandomValues() fills at most 64 KB per call, so walk the buffer.
    for (var off = 0; off < size; off += 65536) {
      crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, size)));
    }
    return new Blob([buf]); // no type: keeps the request simple, no preflight
  }

  /**
   * Push up for UL_MS. XHR rather than fetch because `upload.onprogress` is the
   * only place a browser will tell you how much of a body has actually gone out.
   */
  async function measureUpload() {
    var payload = makePayload(UL_CHUNK);
    var running = true;
    var open = [];
    var failures = 0;

    function postOnce() {
      return new Promise(function (resolve) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", api("/api/up"), true);
        var last = 0;
        xhr.upload.onprogress = function (e) {
          var d = e.loaded - last;
          if (d > 0) meter.bytes += d;
          last = e.loaded;
        };
        xhr.onload = function () { if (xhr.status >= 400) failures++; resolve(); };
        xhr.onerror = function () { failures++; resolve(); };
        xhr.onabort = function () { resolve(); };
        xhr.ontimeout = function () { failures++; resolve(); };
        open.push(xhr);
        xhr.send(payload);
      });
    }
    async function stream() {
      while (running) {
        await postOnce();
        if (failures >= UL_STREAMS * 2) return; // the endpoint is not answering
      }
    }

    var tasks = [];
    for (var i = 0; i < UL_STREAMS; i++) tasks.push(stream());
    await sleep(UL_MS);
    running = false;
    open.forEach(function (x) { try { x.abort(); } catch (_) {} });
    await Promise.allSettled(tasks);
    if (meter.bytes === 0) throw new Error("upload blocked");
    return meterResult();
  }

  /** What the edge sees about this connection. Best effort — never fatal. */
  async function fetchInfo() {
    try {
      var res = await fetch(api("/api/info"), { cache: "no-store", mode: "cors" });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  /* =========================================================================
   * Running a test
   * ======================================================================= */
  var running = false;
  var ticker = null;
  var result = { ping: null, jitter: null, down: null, up: null, info: null, at: null };

  function setPhase(label, unit) {
    el.phase.innerHTML = label;
    el.unit.textContent = unit;
  }
  function markLive(node) {
    [el.statPing, el.statJitter, el.statDown, el.statUp].forEach(function (s) { s.classList.remove("live"); });
    if (node) node.classList.add("live");
  }
  function setStat(node, valueNode, text) {
    valueNode.textContent = text;
    valueNode.classList.remove("pending");
  }

  function startTicker(base, span) {
    stopTicker();
    ticker = setInterval(function () {
      var mbps = meterTick();
      el.bignum.textContent = fmtSpeed(mbps);
      setDial(dialFraction(mbps));
      var done = Math.min(1, (now() - meter.t0) / meter.window);
      setProgress(base + span * done);
    }, TICK_MS);
  }
  function stopTicker() {
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  async function runTest() {
    if (running) return;
    running = true;
    result = { ping: null, jitter: null, down: null, up: null, info: null, at: new Date() };

    el.trouble.classList.add("hidden");
    el.goBtn.classList.add("hidden");
    el.live.classList.remove("hidden");
    el.results.classList.remove("hidden");
    el.verdict.classList.add("hidden");
    el.meta.classList.add("hidden");
    el.actions.classList.add("hidden");
    el.progress.classList.add("on");
    [el.vPing, el.vJitter, el.vDown, el.vUp].forEach(function (v) {
      v.textContent = "—"; v.classList.add("pending");
    });
    setDial(0); setProgress(0);
    startQuotes();

    if (navigator.onLine === false) { offline(); return; }

    try {
      // --- Latency ---------------------------------------------------------
      markLive(el.statPing);
      setPhase("Checking latency", "ms");
      el.bignum.textContent = "—";
      var infoPromise = fetchInfo();
      var lat = await measureLatency(function (times, frac) {
        var lastMs = times[times.length - 1];
        el.bignum.textContent = String(Math.round(lastMs));
        setDial(Math.min(0.5, lastMs / 300));
        setProgress(0.1 * frac);
      });
      result.ping = lat.ping;
      result.jitter = lat.jitter;
      setStat(el.statPing, el.vPing, String(Math.round(lat.ping)));
      setStat(el.statJitter, el.vJitter, lat.jitter < 10 ? lat.jitter.toFixed(1) : String(Math.round(lat.jitter)));

      // --- Download --------------------------------------------------------
      markLive(el.statDown);
      setPhase('<span class="arrow">↓</span> Download', "Mbps");
      el.bignum.textContent = "0.0";
      setDial(0);
      meter = newMeter(); meter.window = DL_MS;
      startTicker(0.1, 0.5);
      result.down = await measureDownload();
      stopTicker();
      el.bignum.textContent = fmtSpeed(result.down);
      setDial(dialFraction(result.down));
      setProgress(0.6);
      setStat(el.statDown, el.vDown, fmtSpeed(result.down));

      // --- Upload ----------------------------------------------------------
      markLive(el.statUp);
      setPhase('<span class="arrow">↑</span> Upload', "Mbps");
      el.bignum.textContent = "0.0";
      setDial(0);
      meter = newMeter(); meter.window = UL_MS;
      startTicker(0.6, 0.4);
      result.up = await measureUpload();
      stopTicker();
      el.bignum.textContent = fmtSpeed(result.up);
      setDial(dialFraction(result.up));
      setProgress(1);
      setStat(el.statUp, el.vUp, fmtSpeed(result.up));

      result.info = await infoPromise;
      finish();
    } catch (err) {
      stopTicker();
      if (navigator.onLine === false) { offline(); return; }
      trouble("🛰️", "The test couldn’t finish",
        "We couldn’t reach the measurement server just now. Your connection may be up but heavily restricted — a work firewall or a captive Wi-Fi portal will do this. Try again in a moment.");
    }
  }

  function finish() {
    stopTicker();
    markLive(null);
    clearQuote();
    el.progress.classList.remove("on");
    setPhase("Result", "Mbps download");
    el.bignum.textContent = fmtSpeed(result.down);
    setDial(dialFraction(result.down));

    el.verdict.innerHTML = verdictFor(result.down, result.up, result.ping);
    el.verdict.classList.remove("hidden");

    var bits = [];
    if (result.info) {
      if (result.info.isp) bits.push("<span><b>" + esc(result.info.isp) + "</b></span>");
      if (result.info.ip) bits.push("<span>IP <b>" + esc(result.info.ip) + "</b></span>");
      var place = [result.info.city, result.info.country].filter(Boolean).join(", ");
      if (place) bits.push("<span>" + esc(place) + "</span>");
      if (result.info.colo) bits.push("<span>Server <b>" + esc(result.info.colo) + "</b></span>");
      if (result.info.protocol) bits.push("<span>" + esc(result.info.protocol) + "</span>");
    }
    if (bits.length) {
      el.meta.innerHTML = bits.join("");
      el.meta.classList.remove("hidden");
    }
    el.actions.classList.remove("hidden");
    el.copyBtn.textContent = "Copy result";
    running = false;
  }

  function verdictFor(down, up, ping) {
    var d = down || 0, line;
    if (d >= 500) line = "Plenty for anything you can throw at it — 4K on every screen, big uploads, no waiting.";
    else if (d >= 200) line = "A fast line. Comfortable for a busy office or a full house.";
    else if (d >= 100) line = "Solid. Streaming, video calls and cloud files all have room to breathe.";
    else if (d >= 50) line = "Fine for everyday work — HD streaming and video calls without a fight.";
    else if (d >= 25) line = "Enough for a couple of video calls at once. Large files will take a while.";
    else if (d >= 10) line = "Workable, but you’ll feel it on big downloads and busy evenings.";
    else if (d >= 3) line = "Tight. Video calls will struggle as soon as someone else joins the network.";
    else line = "Very slow. Worth looking into — this isn’t what most connections should do.";

    var extra = "";
    if (ping != null && ping >= 120) extra += " Latency is high, which makes calls feel laggy even when speed looks fine.";
    else if (result.jitter != null && result.jitter >= 30) extra += " Jitter is high, which is usually what makes calls break up.";
    if (up != null && down != null && down >= 50 && up < down / 15 && up < 15) {
      extra += " Upload is well behind download — that shows up when you're the one on camera or sending large files.";
    }
    return line + extra + ' <a href="https://www.linearit.co/contact">Something look off? Talk to us.</a>';
  }

  function offline() {
    trouble("📴", "No internet right now",
      "There is nothing to measure — so go and enjoy your day. We'll be here when you get back.");
  }
  function trouble(emoji, title, text) {
    stopTicker();
    clearQuote();
    running = false;
    el.progress.classList.remove("on");
    el.live.classList.add("hidden");
    el.results.classList.add("hidden");
    el.verdict.classList.add("hidden");
    el.meta.classList.add("hidden");
    el.actions.classList.add("hidden");
    el.goBtn.classList.remove("hidden");
    el.goBtn.disabled = false;
    setDial(0);
    el.troubleEmoji.textContent = emoji;
    el.troubleTitle.textContent = title;
    el.troubleText.textContent = text;
    el.trouble.classList.remove("hidden");
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* =========================================================================
   * Wiring
   * ======================================================================= */
  function resetForRetest() {
    el.trouble.classList.add("hidden");
    el.live.classList.add("hidden");
    el.goBtn.classList.remove("hidden");
    el.goBtn.disabled = false;
    el.results.classList.add("hidden");
    el.verdict.classList.add("hidden");
    el.meta.classList.add("hidden");
    el.actions.classList.add("hidden");
    setDial(0); setProgress(0);
  }

  el.goBtn.addEventListener("click", function () { el.goBtn.disabled = true; runTest(); });
  el.againBtn.addEventListener("click", function () { resetForRetest(); runTest(); });
  el.retryBtn.addEventListener("click", function () { resetForRetest(); runTest(); });

  el.copyBtn.addEventListener("click", function () {
    var lines = [
      "Linear Speed — " + (result.at ? result.at.toLocaleString() : ""),
      "Download: " + fmtSpeed(result.down) + " Mbps",
      "Upload:   " + fmtSpeed(result.up) + " Mbps",
      "Ping:     " + (result.ping == null ? "—" : Math.round(result.ping) + " ms"),
      "Jitter:   " + (result.jitter == null ? "—" : Math.round(result.jitter) + " ms")
    ];
    if (result.info) {
      if (result.info.isp) lines.push("ISP:      " + result.info.isp);
      if (result.info.ip) lines.push("IP:       " + result.info.ip);
      if (result.info.colo) lines.push("Server:   " + result.info.colo);
    }
    lines.push("https://speed.linearit.co");
    var text = lines.join("\n");
    var done = function () {
      el.copyBtn.textContent = "Copied ✓";
      setTimeout(function () { el.copyBtn.textContent = "Copy result"; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallbackCopy);
    } else fallbackCopy();

    function fallbackCopy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (_) {}
      document.body.removeChild(ta);
    }
  });

  window.addEventListener("offline", function () { if (running) offline(); });

  buildGauge();
  setDial(0);
})();
