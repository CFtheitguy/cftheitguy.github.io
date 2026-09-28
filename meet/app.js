/* Linear Meet — front-end
 * ---------------------------------------------------------------------------
 * One RTCPeerConnection per person, talking to the Cloudflare Realtime SFU
 * through meet-worker (which holds the app secret). The flow:
 *
 *   1. Lobby: camera/mic preview, name, device pickers.
 *   2. Join: WebSocket to the room's Durable Object -> `hello` -> `welcome`
 *      (with a ticket that unlocks the SFU proxy).
 *   3. Publish: add local tracks as sendonly transceivers, offer -> SFU
 *      tracks/new -> answer. Tell the room our sessionId + track names.
 *   4. Subscribe: for every track anyone else publishes, ask the SFU to pull
 *      it into our session; the SFU sends an offer, we answer via renegotiate.
 *
 * Every SDP exchange runs through one promise queue (`negotiate`), because two
 * offers in flight on one peer connection will corrupt its state.
 * ------------------------------------------------------------------------- */
(function () {
  "use strict";

  var API = (location.host === "meet.linearit.co" || location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ? location.origin : "https://meet.linearit.co";
  var WS_BASE = API.replace(/^http/, "ws");
  var SHARE_BASE = "https://meet.linearit.co/#";
  var REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮"];
  var COLORS = ["#0ea5e9", "#8b5cf6", "#ec4899", "#f97316", "#10b981", "#eab308", "#6366f1", "#14b8a6", "#ef4444", "#84cc16"];

  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  var ICON = {
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24"><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5 2.2M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.5 2.6M12 18v3M3 3l18 18"/></svg>',
    cam: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>',
    camOff: '<svg viewBox="0 0 24 24"><path d="M16 16v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1M10 5h4a2 2 0 0 1 2 2v3l5-3v10M3 3l18 18"/></svg>'
  };

  /* ---------------- state ---------------- */
  var room = "";
  var cid = store("meet.cid") || randId(16);
  store("meet.cid", cid);
  var local = { audio: null, video: null, screen: null };  // MediaStreamTracks
  var want = { mic: store("meet.mic") !== "0", cam: store("meet.cam") !== "0" };
  var ws = null, ticket = "", wsRetry = 0, pingTimer = null, leaving = false;
  var pc = null, sessionId = null, iceServers = [{ urls: "stun:stun.cloudflare.com:3478" }];
  var queue = Promise.resolve();
  var pub = {};           // kind -> { transceiver, trackName }
  var subs = {};          // key(sessionId|trackName) -> { mid, cid, kind }
  var midOwner = {};      // mid -> { cid, kind }
  var tiles = {};         // cid (or cid+":screen") -> tile record
  var people = [];        // latest roster
  var me = { host: false, hand: false };
  var locked = false;
  var shareN = 0;
  var unread = 0;
  var audioCtx = null;

  function randId(n) {
    var a = new Uint8Array(n), s = "", c = "abcdefghijklmnopqrstuvwxyz0123456789";
    crypto.getRandomValues(a);
    for (var i = 0; i < n; i++) s += c[a[i] % 36];
    return s;
  }
  function newRoomName() {
    var c = "abcdefghjkmnpqrstuvwxyz", a = new Uint8Array(10), s = "";
    crypto.getRandomValues(a);
    for (var i = 0; i < 10; i++) { s += c[a[i] % c.length]; if (i === 2 || i === 6) s += "-"; }
    return s;
  }
  function parseRoom(s) {
    s = String(s || "").trim().toLowerCase();
    var i = s.lastIndexOf("#"); if (i >= 0) s = s.slice(i + 1);
    s = s.replace(/[^a-z0-9-]/g, "");
    return /^[a-z0-9][a-z0-9-]{2,63}$/.test(s) ? s : "";
  }
  function colorFor(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; }
  function initials(n) { var p = String(n || "?").trim().split(/\s+/); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); }

  function toast(msg) {
    var t = el("div", null, msg); $("toasts").appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }
  function show(id) { ["lobby", "meeting", "ended"].forEach(function (s) { $(s).classList.toggle("hidden", s !== id); }); }

  /* =============== lobby =============== */
  var previewStream = new MediaStream();
  var meterStop = null;

  async function getTrack(kind) {
    var dev = store(kind === "audio" ? "meet.micId" : "meet.camId");
    var c = kind === "audio"
      ? { audio: dev ? { deviceId: { ideal: dev }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true } }
      : { video: dev ? { deviceId: { ideal: dev }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } };
    var s = await navigator.mediaDevices.getUserMedia(c);
    return kind === "audio" ? s.getAudioTracks()[0] : s.getVideoTracks()[0];
  }

  async function lobbyMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      lobbyMsg("This browser can't use a camera or microphone. Try Chrome, Edge, Safari or Firefox.", true);
      want.mic = want.cam = false; paintLobby(); return;
    }
    try { if (want.mic && !local.audio) local.audio = await getTrack("audio"); }
    catch (e) { want.mic = false; lobbyMsg("Microphone blocked or not found. You can still join and listen.", false); }
    try { if (want.cam && !local.video) local.video = await getTrack("video"); }
    catch (e) { want.cam = false; }
    refreshPreview(); fillDevices(); paintLobby();
  }

  function refreshPreview() {
    previewStream.getTracks().forEach(function (t) { previewStream.removeTrack(t); });
    if (local.video) previewStream.addTrack(local.video);
    $("pv").srcObject = previewStream;
    $("pvOff").classList.toggle("hidden", !!local.video);
    startMeter();
  }

  function startMeter() {
    if (meterStop) meterStop();
    meterStop = null;
    if (!local.audio) { Array.prototype.forEach.call($("meter").children, function (b) { b.style.height = "3px"; }); return; }
    meterStop = analyse(local.audio, function (lvl) {
      var bars = $("meter").children;
      for (var i = 0; i < bars.length; i++) bars[i].style.height = (lvl * 18 > i * 3.6 ? 3 + Math.min(15, lvl * 40) : 3) + "px";
    });
  }

  // Calls fn(level 0..1) ~10 times a second. Returns a stop function.
  function analyse(track, fn) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
      var src = audioCtx.createMediaStreamSource(new MediaStream([track]));
      var an = audioCtx.createAnalyser(); an.fftSize = 512; src.connect(an);
      var buf = new Uint8Array(an.fftSize);
      var iv = setInterval(function () {
        an.getByteTimeDomainData(buf);
        var sum = 0; for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
        fn(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      }, 100);
      return function () { clearInterval(iv); try { src.disconnect(); } catch (e) {} };
    } catch (e) { return function () {}; }
  }

  async function fillDevices() {
    try {
      var list = await navigator.mediaDevices.enumerateDevices();
      [["audioinput", "selMic", "meet.micId", local.audio], ["videoinput", "selCam", "meet.camId", local.video]].forEach(function (d) {
        var sel = $(d[1]); sel.innerHTML = "";
        var cur = d[3] && d[3].getSettings ? d[3].getSettings().deviceId : store(d[2]);
        var n = 0;
        list.filter(function (x) { return x.kind === d[0]; }).forEach(function (x) {
          var o = el("option", null, x.label || (d[0] === "audioinput" ? "Microphone " : "Camera ") + (++n));
          o.value = x.deviceId; if (x.deviceId === cur) o.selected = true; sel.appendChild(o);
        });
        sel.classList.toggle("hidden", !sel.options.length);
      });
    } catch (e) {}
  }

  async function switchDevice(kind, id) {
    store(kind === "audio" ? "meet.micId" : "meet.camId", id);
    var old = local[kind];
    if (!old) return;
    try {
      var t = await getTrack(kind);
      t.enabled = old.enabled;
      local[kind] = t;
      var p = pub[kind === "audio" ? "mic" : "cam"];
      if (p) await p.transceiver.sender.replaceTrack(t);
      old.stop();
      refreshPreview(); refreshSelfTile();
    } catch (e) { toast("Couldn't switch device."); }
  }

  function paintLobby() {
    var m = $("lMic"), c = $("lCam");
    m.innerHTML = want.mic ? ICON.mic : ICON.micOff; m.classList.toggle("off", !want.mic);
    c.innerHTML = want.cam ? ICON.cam : ICON.camOff; c.classList.toggle("off", !want.cam);
  }
  function lobbyMsg(t, err) { var b = $("lobbyMsg"); b.textContent = t; b.classList.toggle("err", !!err); b.classList.toggle("hidden", !t); }

  async function lobbyToggle(kind) {
    if (kind === "mic") {
      want.mic = !want.mic; store("meet.mic", want.mic ? "1" : "0");
      if (want.mic && !local.audio) { try { local.audio = await getTrack("audio"); } catch (e) { want.mic = false; toast("Microphone blocked or not found."); } }
      if (local.audio) local.audio.enabled = want.mic;
      startMeter();
    } else {
      want.cam = !want.cam; store("meet.cam", want.cam ? "1" : "0");
      if (want.cam) { try { local.video = await getTrack("video"); } catch (e) { want.cam = false; toast("Camera blocked or not found."); } }
      else if (local.video) { local.video.stop(); local.video = null; }
      refreshPreview();
    }
    fillDevices(); paintLobby();
  }

  function setupLobby() {
    room = parseRoom(location.hash);
    $("name").value = store("meet.name") || "";
    if (room) {
      $("jTitle").textContent = "Ready to join?";
      $("jSub").textContent = "Meeting " + room;
      $("newBtn").classList.add("hidden");
      $("codeRow").classList.add("hidden");
      $("joinBtn").classList.remove("hidden");
      peek();
    } else {
      $("jTitle").textContent = "Linear Meet";
      $("jSub").textContent = "Video and voice meetings you join with a link. No signup, no app.";
      $("newBtn").classList.remove("hidden");
      $("codeRow").classList.remove("hidden");
      $("joinBtn").classList.add("hidden");
      $("inside").textContent = "";
    }
    checkService();
    show("lobby");
    lobbyMedia();
  }

  async function checkService() {
    try {
      var r = await fetch(API + "/api/status", { cache: "no-store" });
      var s = await r.json();
      if (!s.configured) lobbyMsg("Meetings aren't switched on yet — the server still needs its Realtime key. You can look around, but joining won't connect.", true);
      else if (!s.ok) lobbyMsg("The call service rejected the server's key. Please let Linear IT know.", true);
    } catch (e) {
      lobbyMsg("Can't reach meet.linearit.co right now. Check your connection and try again.", true);
    }
  }

  // Open a socket without joining, just to see how many are inside.
  var peekWs = null;
  function peek() {
    try {
      if (peekWs) peekWs.close();
      peekWs = new WebSocket(WS_BASE + "/ws?room=" + room + "&cid=" + randId(12));
      peekWs.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m.t === "lobby") {
          $("inside").textContent = m.locked ? "🔒 This meeting is locked." : (m.count ? m.count + (m.count === 1 ? " person is" : " people are") + " in this meeting." : "Nobody else is here yet.");
        }
      };
    } catch (e) {}
  }

  /* =============== join / signaling =============== */
  function join() {
    var name = $("name").value.trim();
    if (!name) { $("name").focus(); lobbyMsg("Please enter your name.", false); return; }
    store("meet.name", name);
    if (!room) { room = newRoomName(); history.replaceState(null, "", "#" + room); }
    if (peekWs) { try { peekWs.close(); } catch (e) {} peekWs = null; }
    if (meterStop) { meterStop(); meterStop = null; }
    $("joinBtn").disabled = true;
    leaving = false;
    connect();
  }

  function connect() {
    ws = new WebSocket(WS_BASE + "/ws?room=" + room + "&cid=" + cid);
    ws.onopen = function () {
      wsRetry = 0;
      send({ t: "hello", name: store("meet.name"), muted: !isMicOn(), camOff: !isCamOn() });
      clearInterval(pingTimer);
      pingTimer = setInterval(function () { send({ t: "ping" }); }, 25000);
    };
    ws.onmessage = function (e) { var m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(m); };
    ws.onclose = function (e) {
      clearInterval(pingTimer);
      if (leaving || e.code === 4000 || e.code === 4001) return;
      if ($("meeting").classList.contains("hidden") && !sessionId) { $("joinBtn").disabled = false; lobbyMsg("Couldn't connect to the meeting. Try again.", true); return; }
      var wait = Math.min(10000, 500 * Math.pow(2, wsRetry++));
      toast("Connection lost — reconnecting…");
      setTimeout(function () { if (!leaving) connect(); }, wait);
    };
  }
  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  async function onMsg(m) {
    switch (m.t) {
      case "welcome":
        ticket = m.ticket;
        if (!pc) { enterMeeting(); try { await startMedia(); } catch (e) { toast("Couldn't start audio/video: " + (e.message || e)); } }
        else sendState();
        break;
      case "denied":
        leaving = true; try { ws.close(); } catch (e) {}
        $("joinBtn").disabled = false;
        lobbyMsg(m.reason === "locked" ? "The host has locked this meeting." : "This meeting is full.", true);
        break;
      case "roster": onRoster(m.people, m.locked); break;
      case "chat": addChat(m); break;
      case "notice": toast(m.text); sysChat(m.text); break;
      case "react": showReaction(m.from, m.emoji); break;
      case "force-mute":
        if (isMicOn()) { setMic(false); toast(m.by + " muted you"); }
        break;
      case "removed":
        leaving = true; teardown();
        ended("You were removed from the meeting", "The host removed you.");
        break;
    }
  }

  function sendState() {
    var tracks = [];
    Object.keys(pub).forEach(function (k) { if (pub[k]) tracks.push({ trackName: pub[k].trackName, kind: k }); });
    send({ t: "state", sessionId: sessionId, tracks: tracks, muted: !isMicOn(), camOff: !isCamOn(), hand: me.hand });
  }

  /* =============== SFU =============== */
  async function sfu(path, body, method) {
    var r = await fetch(API + "/api/sfu" + path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json", "X-Meet-Ticket": ticket },
      body: JSON.stringify(body || {})
    });
    var d = {}; try { d = await r.json(); } catch (e) {}
    if (!r.ok || d.errorCode) throw new Error(d.error || d.errorDescription || ("Call service error " + r.status));
    return d;
  }
  function negotiate(fn) { var p = queue.then(fn); queue = p.catch(function (e) { console.warn("[meet]", e); }); return p; }

  async function startMedia() {
    try {
      var r = await fetch(API + "/api/ice", { headers: { "X-Meet-Ticket": ticket } });
      var d = await r.json(); if (d.iceServers) iceServers = d.iceServers;
    } catch (e) {}
    pc = new RTCPeerConnection({ iceServers: iceServers, bundlePolicy: "max-bundle" });
    pc.ontrack = onTrack;
    pc.onconnectionstatechange = function () {
      if (pc && pc.connectionState === "failed") toast("Media connection failed — try leaving and rejoining.");
    };
    var s = await sfu("/sessions/new", {});
    sessionId = s.sessionId;
    var list = [];
    if (local.audio) list.push({ track: local.audio, kind: "mic" });
    if (local.video) list.push({ track: local.video, kind: "cam" });
    if (list.length) await publish(list);
    sendState();
    onRoster(people, locked);   // subscribe to anyone who was already here
  }

  function publish(list) {
    return negotiate(async function () {
      var items = list.map(function (x) {
        var tr = pc.addTransceiver(x.track, { direction: "sendonly" });
        var name = cid + "-" + x.kind + (x.kind === "screen" ? "-" + (++shareN) : "");
        pub[x.kind] = { transceiver: tr, trackName: name };
        return { tr: tr, name: name };
      });
      await pc.setLocalDescription(await pc.createOffer());
      var res = await sfu("/sessions/" + sessionId + "/tracks/new", {
        sessionDescription: { type: "offer", sdp: pc.localDescription.sdp },
        tracks: items.map(function (i) { return { location: "local", mid: i.tr.mid, trackName: i.name }; })
      });
      await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
    });
  }

  function unpublish(kind) {
    var p = pub[kind]; if (!p) return Promise.resolve();
    delete pub[kind];
    return negotiate(async function () {
      var mid = p.transceiver.mid;
      try { p.transceiver.sender.replaceTrack(null); } catch (e) {}
      p.transceiver.direction = "inactive";
      await pc.setLocalDescription(await pc.createOffer());
      var res = await sfu("/sessions/" + sessionId + "/tracks/close", {
        tracks: [{ mid: mid }], sessionDescription: { type: "offer", sdp: pc.localDescription.sdp }, force: false
      }, "PUT");
      if (res.sessionDescription) await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
    });
  }

  function subscribe(person, tracks) {
    return negotiate(async function () {
      if (!pc || !sessionId) return;
      var res = await sfu("/sessions/" + sessionId + "/tracks/new", {
        tracks: tracks.map(function (t) { return { location: "remote", sessionId: person.sessionId, trackName: t.trackName }; })
      });
      (res.tracks || []).forEach(function (rt) {
        var t = tracks.filter(function (x) { return x.trackName === rt.trackName; })[0];
        if (!t) return;
        var key = person.sessionId + "|" + t.trackName;
        if (rt.errorCode || !rt.mid) { delete subs[key]; return; }
        subs[key].mid = rt.mid;
        midOwner[rt.mid] = { cid: person.cid, kind: t.kind };
      });
      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
        await pc.setLocalDescription(await pc.createAnswer());
        await sfu("/sessions/" + sessionId + "/renegotiate", { sessionDescription: { type: "answer", sdp: pc.localDescription.sdp } }, "PUT");
      }
    }).catch(function () {
      tracks.forEach(function (t) { delete subs[person.sessionId + "|" + t.trackName]; });
    });
  }

  function unsubscribe(mids) {
    return negotiate(async function () {
      if (!pc || !mids.length) return;
      var res = await sfu("/sessions/" + sessionId + "/tracks/close", { tracks: mids.map(function (m) { return { mid: m }; }), force: true }, "PUT");
      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(res.sessionDescription));
        await pc.setLocalDescription(await pc.createAnswer());
        await sfu("/sessions/" + sessionId + "/renegotiate", { sessionDescription: { type: "answer", sdp: pc.localDescription.sdp } }, "PUT");
      }
    });
  }

  function onTrack(e) {
    var mid = e.transceiver && e.transceiver.mid;
    var own = mid && midOwner[mid];
    if (!own) return;
    var t = own.kind === "screen" ? screenTile(own.cid) : tileFor(own.cid);
    if (!t) return;
    t.stream.getTracks().filter(function (x) { return x.kind === e.track.kind; }).forEach(function (x) { t.stream.removeTrack(x); });
    t.stream.addTrack(e.track);
    t.video.srcObject = t.stream;
    t.video.play().catch(function () {});
    if (e.track.kind === "audio" && own.kind === "mic") watchSpeaking(t, e.track);
    if (e.track.kind === "video") { t.hasVideo = true; paintTile(own.cid); }
  }

  /* =============== roster =============== */
  function onRoster(list, isLocked) {
    people = list; locked = isLocked;
    var mine = list.filter(function (p) { return p.cid === cid; })[0];
    var wasHost = me.host;
    me.host = !!(mine && mine.host);
    if (me.host && !wasHost && list.length > 1) toast("You're the host now");

    var present = {};
    var toClose = [];
    list.forEach(function (p) {
      present[p.cid] = true;
      if (p.cid === cid) return;
      tileFor(p.cid);
      var want = [];
      (p.tracks || []).forEach(function (t) {
        var key = p.sessionId + "|" + t.trackName;
        if (sessionId && p.sessionId && !subs[key]) { subs[key] = { cid: p.cid, kind: t.kind, mid: null }; want.push(t); }
      });
      if (want.length) subscribe(p, want);
      // Drop subscriptions this person no longer publishes (e.g. stopped sharing).
      Object.keys(subs).forEach(function (key) {
        var s = subs[key]; if (s.cid !== p.cid) return;
        var still = (p.tracks || []).some(function (t) { return key === p.sessionId + "|" + t.trackName; });
        if (!still) { if (s.mid) { toClose.push(s.mid); delete midOwner[s.mid]; } delete subs[key]; if (s.kind === "screen") removeTile(p.cid + ":screen"); }
      });
    });
    Object.keys(subs).forEach(function (key) {
      var s = subs[key];
      if (!present[s.cid]) { if (s.mid) { toClose.push(s.mid); delete midOwner[s.mid]; } delete subs[key]; }
    });
    Object.keys(tiles).forEach(function (k) {
      var c = k.split(":")[0];
      if (c !== cid && !present[c]) removeTile(k);
    });
    if (toClose.length) unsubscribe(toClose);
    list.forEach(function (p) { paintTile(p.cid); });
    $("count").textContent = list.length;
    renderPeople();
    layout();
  }

  /* =============== tiles =============== */
  function personOf(c) { return people.filter(function (p) { return p.cid === c; })[0]; }

  function makeTile(key, isSelf, isScreen) {
    var d = el("div", "tile" + (isSelf ? " self" : "") + (isScreen ? " screen" : ""));
    var v = el("video"); v.autoplay = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.muted = !!isSelf;
    var av = el("div", "av"); var b = el("b"); av.appendChild(b);
    var nm = el("div", "nm"); var badge = el("div", "badge");
    d.appendChild(v); if (!isScreen) d.appendChild(av); d.appendChild(nm); d.appendChild(badge);
    var t = { key: key, el: d, video: v, av: av, avB: b, nm: nm, badge: badge, stream: new MediaStream(), hasVideo: false, stop: null, isScreen: !!isScreen };
    v.srcObject = t.stream;
    tiles[key] = t;
    (isScreen ? $("screenArea") : $("grid")).appendChild(d);
    return t;
  }
  function tileFor(c) { return tiles[c] || makeTile(c, c === cid, false); }
  function screenTile(c) { return tiles[c + ":screen"] || makeTile(c + ":screen", c === cid, true); }
  function removeTile(k) {
    var t = tiles[k]; if (!t) return;
    if (t.stop) t.stop();
    t.el.remove(); delete tiles[k];
  }

  function paintTile(c) {
    var t = tiles[c]; var p = personOf(c);
    if (t && p) {
      var video = c === cid ? isCamOn() : (t.hasVideo && !p.camOff);
      t.av.style.display = video ? "none" : "flex";
      t.avB.textContent = initials(p.name); t.avB.style.background = colorFor(c);
      t.nm.textContent = p.name + (c === cid ? " (you)" : "") + (p.host ? " · host" : "");
      t.badge.innerHTML = "";
      if (p.hand) t.badge.appendChild(el("span", null, "✋"));
      if (p.muted) t.badge.appendChild(el("span", null, "🔇"));
    }
    var s = tiles[c + ":screen"];
    if (s && p) s.nm.textContent = p.name + (c === cid ? " (you)" : "") + " is presenting";
  }

  function refreshSelfTile() {
    var t = tileFor(cid);
    t.stream.getTracks().forEach(function (x) { t.stream.removeTrack(x); });
    if (local.video) t.stream.addTrack(local.video);
    t.video.srcObject = t.stream;
    if (t.stop) t.stop();
    t.stop = local.audio ? analyse(local.audio, function (l) { t.el.classList.toggle("speaking", isMicOn() && l > 0.12); }) : null;
    paintTile(cid);
  }
  function watchSpeaking(t, track) {
    if (t.stop) t.stop();
    t.stop = analyse(track, function (l) { t.el.classList.toggle("speaking", l > 0.12); });
  }

  function layout() {
    var grid = $("grid"), stage = $("stage"), sa = $("screenArea");
    var presenting = sa.children.length > 0;
    stage.classList.toggle("presenting", presenting);
    sa.style.display = presenting ? "flex" : "none";
    var n = grid.children.length || 1;
    if (presenting) { grid.style.gridTemplateColumns = ""; grid.style.width = ""; return; }
    var W = grid.parentNode.clientWidth - 24, H = grid.parentNode.clientHeight - 24;
    var best = { cols: 1, w: 0 };
    for (var cols = 1; cols <= n; cols++) {
      var rows = Math.ceil(n / cols);
      var w = Math.min((W - (cols - 1) * 10) / cols, ((H - (rows - 1) * 10) / rows) * 16 / 9);
      if (w > best.w) best = { cols: cols, w: w };
    }
    grid.style.gridTemplateColumns = "repeat(" + best.cols + ", " + Math.floor(best.w) + "px)";
  }
  window.addEventListener("resize", function () { if (!$("meeting").classList.contains("hidden")) layout(); });

  /* =============== controls =============== */
  function isMicOn() { return !!(local.audio && local.audio.enabled && want.mic); }
  function isCamOn() { return !!(local.video && want.cam); }

  function paintBar() {
    var m = $("bMic"), c = $("bCam");
    m.innerHTML = isMicOn() ? ICON.mic : ICON.micOff; m.classList.toggle("off", !isMicOn());
    c.innerHTML = isCamOn() ? ICON.cam : ICON.camOff; c.classList.toggle("off", !isCamOn());
    $("bShare").classList.toggle("on", !!local.screen);
    $("bHand").classList.toggle("on", me.hand);
  }

  async function setMic(on) {
    want.mic = on;
    if (on && !local.audio) {
      try { local.audio = await getTrack("audio"); } catch (e) { want.mic = false; toast("Microphone blocked or not found."); paintBar(); return; }
      if (pub.mic) await pub.mic.transceiver.sender.replaceTrack(local.audio);
      else await publish([{ track: local.audio, kind: "mic" }]);
      refreshSelfTile();
    }
    if (local.audio) local.audio.enabled = on;
    paintBar(); sendState();
  }

  async function setCam(on) {
    want.cam = on;
    if (on) {
      try { local.video = await getTrack("video"); } catch (e) { want.cam = false; toast("Camera blocked or not found."); paintBar(); return; }
      if (pub.cam) await pub.cam.transceiver.sender.replaceTrack(local.video);
      else await publish([{ track: local.video, kind: "cam" }]);
    } else if (local.video) {
      if (pub.cam) await pub.cam.transceiver.sender.replaceTrack(null);
      local.video.stop(); local.video = null;
    }
    refreshSelfTile(); paintBar(); sendState();
  }

  async function toggleShare() {
    if (local.screen) return stopShare();
    if (!navigator.mediaDevices.getDisplayMedia) { toast("Screen sharing isn't supported on this device."); return; }
    try {
      var s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
      local.screen = s.getVideoTracks()[0];
      try { local.screen.contentHint = "detail"; } catch (e) {}
      local.screen.onended = stopShare;
      var t = screenTile(cid); t.stream.addTrack(local.screen); t.video.srcObject = t.stream;
      paintTile(cid); layout(); paintBar();
      await publish([{ track: local.screen, kind: "screen" }]);
      sendState();
    } catch (e) { if (e && e.name !== "NotAllowedError") toast("Couldn't share your screen."); local.screen = null; removeTile(cid + ":screen"); layout(); paintBar(); }
  }
  async function stopShare() {
    if (!local.screen) return;
    local.screen.onended = null; local.screen.stop(); local.screen = null;
    removeTile(cid + ":screen"); layout(); paintBar();
    await unpublish("screen").catch(function () {});
    sendState();
  }

  function toggleHand() { me.hand = !me.hand; paintBar(); sendState(); }

  function showReaction(from, emoji) {
    var t = tiles[from]; if (!t) return;
    var r = el("div", "react", emoji); t.el.appendChild(r);
    setTimeout(function () { r.remove(); }, 2300);
  }

  /* =============== panel: chat & people =============== */
  function openPanel(tab) {
    var p = $("panel");
    if (!p.classList.contains("hidden") && p.dataset.tab === tab) { p.classList.add("hidden"); layout(); return; }
    p.classList.remove("hidden"); p.dataset.tab = tab;
    $("tabChat").classList.toggle("act", tab === "chat"); $("tabPeople").classList.toggle("act", tab === "people");
    $("chatBody").classList.toggle("hidden", tab !== "chat"); $("compose").classList.toggle("hidden", tab !== "chat");
    $("peopleBody").classList.toggle("hidden", tab !== "people");
    if (tab === "chat") { unread = 0; paintUnread(); $("chatIn").focus(); var b = $("chatBody"); b.scrollTop = b.scrollHeight; }
    layout();
  }
  function chatOpen() { var p = $("panel"); return !p.classList.contains("hidden") && p.dataset.tab === "chat"; }
  function paintUnread() { var u = $("unread"); u.textContent = unread > 9 ? "9+" : unread; u.classList.toggle("hidden", !unread); }

  function addChat(m) {
    var d = el("div", "m" + (m.from === cid ? " me" : ""));
    var time = new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    d.appendChild(el("div", "who", (m.from === cid ? "You" : m.name) + " · " + time));
    var tx = el("div", "tx");
    // Linkify plain URLs, built as DOM nodes (never innerHTML).
    String(m.text).split(/(https?:\/\/[^\s<]+)/g).forEach(function (part, i) {
      if (i % 2) { var a = el("a", null, part); a.href = part; a.target = "_blank"; a.rel = "noopener noreferrer"; a.style.color = "var(--accent)"; tx.appendChild(a); }
      else if (part) tx.appendChild(document.createTextNode(part));
    });
    d.appendChild(tx);
    appendMsg(d);
    if (m.from !== cid && !chatOpen()) { unread++; paintUnread(); toast(m.name + ": " + String(m.text).slice(0, 60)); }
  }
  function sysChat(t) { appendMsg(el("div", "sys", t)); }
  function appendMsg(d) {
    var b = $("chatBody"); var atEnd = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
    $("msgs").appendChild(d);
    if (atEnd) b.scrollTop = b.scrollHeight;
  }
  function sendChat() {
    var i = $("chatIn"); var t = i.value.trim(); if (!t) return;
    send({ t: "chat", text: t }); i.value = "";
  }

  function renderPeople() {
    var box = $("people"); box.innerHTML = "";
    $("hostbar").classList.toggle("hidden", !me.host);
    $("lockBtn").textContent = locked ? "Unlock meeting" : "Lock meeting";
    people.forEach(function (p) {
      var r = el("div", "person");
      var a = el("div", "pa", initials(p.name)); a.style.background = colorFor(p.cid); r.appendChild(a);
      var n = el("div", "pn", p.name + (p.cid === cid ? " (you)" : ""));
      if (p.host) n.appendChild(el("small", null, " · host"));
      r.appendChild(n);
      if (p.hand) r.appendChild(el("span", "ic", "✋"));
      r.appendChild(el("span", "ic", p.muted ? "🔇" : "🎤"));
      if (me.host && p.cid !== cid) {
        if (!p.muted) { var mu = el("button", "pm", "Mute"); mu.onclick = function () { send({ t: "host", action: "mute", target: p.cid }); }; r.appendChild(mu); }
        var more = el("button", "pm", "⋯"); more.title = "More";
        more.onclick = function () { hostMenu(p); };
        r.appendChild(more);
      }
      box.appendChild(r);
    });
  }

  function modal(title, text, buttons) {
    var m = el("div", "modal"); var b = el("div", "box");
    b.appendChild(el("h2", null, title)); if (text) b.appendChild(el("p", null, text));
    var act = el("div", "actions");
    buttons.forEach(function (x) {
      var btn = el("button", "btn" + (x.primary ? " primary" : ""), x.label);
      btn.onclick = function () { m.remove(); if (x.fn) x.fn(); };
      act.appendChild(btn);
    });
    b.appendChild(act); m.appendChild(b);
    m.onclick = function (e) { if (e.target === m) m.remove(); };
    document.body.appendChild(m);
  }
  function hostMenu(p) {
    modal(p.name, "What would you like to do?", [
      { label: "Make host", fn: function () { send({ t: "host", action: "make-host", target: p.cid }); } },
      { label: "Remove from meeting", fn: function () {
        modal("Remove " + p.name + "?", "They can rejoin with the link unless you lock the meeting.", [
          { label: "Cancel" }, { label: "Remove", primary: true, fn: function () { send({ t: "host", action: "remove", target: p.cid }); } }]);
      } },
      { label: "Cancel", primary: true }
    ]);
  }

  /* =============== enter / leave =============== */
  function enterMeeting() {
    show("meeting");
    $("roomLabel").textContent = "meet.linearit.co/#" + room;
    document.title = "Linear Meet · " + room;
    if (local.audio) local.audio.enabled = want.mic;
    refreshSelfTile(); paintBar(); layout();
    if (!sessionStorage.getItem("meet.invited." + room)) {
      try { sessionStorage.setItem("meet.invited." + room, "1"); } catch (e) {}
      if (people.length <= 1) toast("You're the first one here — copy the link to invite people");
    }
  }

  function teardown() {
    clearInterval(pingTimer);
    if (ws) { try { ws.close(1000); } catch (e) {} ws = null; }
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    ["audio", "video", "screen"].forEach(function (k) { if (local[k]) { local[k].stop(); local[k] = null; } });
    Object.keys(tiles).forEach(removeTile);
    sessionId = null; ticket = ""; pub = {}; subs = {}; midOwner = {}; people = []; queue = Promise.resolve();
    me = { host: false, hand: false }; unread = 0; paintUnread();
    $("msgs").innerHTML = ""; $("panel").classList.add("hidden");
    $("joinBtn").disabled = false;
    document.title = "Linear Meet";
  }
  function leave() { leaving = true; teardown(); ended("You left the meeting", "Thanks for joining."); }
  function ended(title, sub) { $("endTitle").textContent = title; $("endSub").textContent = sub; show("ended"); }

  function copyLink() {
    var link = SHARE_BASE + room;
    if (navigator.share && /Mobi|iPad|Android/i.test(navigator.userAgent)) {
      navigator.share({ title: "Join my Linear Meet", url: link }).catch(function () {});
      return;
    }
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
      function () { toast("Invite link copied"); },
      function () { modal("Invite link", link, [{ label: "Done", primary: true }]); });
  }

  /* =============== wire up =============== */
  $("lMic").onclick = function () { lobbyToggle("mic"); };
  $("lCam").onclick = function () { lobbyToggle("cam"); };
  $("selMic").onchange = function () { switchDevice("audio", this.value); };
  $("selCam").onchange = function () { switchDevice("video", this.value); };
  $("joinBtn").onclick = join;
  $("name").onkeydown = function (e) { if (e.key === "Enter") join(); };
  $("newBtn").onclick = function () { room = newRoomName(); history.replaceState(null, "", "#" + room); join(); };
  $("codeBtn").onclick = function () {
    var r = parseRoom($("code").value);
    if (!r) { lobbyMsg("That doesn't look like a meeting code.", false); return; }
    location.hash = r;
  };
  $("code").onkeydown = function (e) { if (e.key === "Enter") $("codeBtn").click(); };

  $("bMic").onclick = function () { setMic(!isMicOn()); };
  $("bCam").onclick = function () { setCam(!isCamOn()); };
  $("bShare").onclick = toggleShare;
  $("bHand").onclick = toggleHand;
  $("bChat").onclick = function () { openPanel("chat"); };
  $("bPeople").onclick = function () { openPanel("people"); };
  $("tabChat").onclick = function () { openPanel("chat"); };
  $("tabPeople").onclick = function () { openPanel("people"); };
  $("closePanel").onclick = function () { $("panel").classList.add("hidden"); layout(); };
  $("chatSend").onclick = sendChat;
  $("chatIn").onkeydown = function (e) { if (e.key === "Enter") sendChat(); };
  $("bLink").onclick = copyLink;
  $("bLeave").onclick = leave;
  $("muteAll").onclick = function () { send({ t: "host", action: "mute-all" }); };
  $("lockBtn").onclick = function () { send({ t: "host", action: locked ? "unlock" : "lock" }); };
  $("rejoin").onclick = function () { setupLobby(); };
  $("home").onclick = function () { history.replaceState(null, "", location.pathname); setupLobby(); };

  var menu = $("reactMenu");
  REACTIONS.forEach(function (r) {
    var b = el("button", null, r);
    b.onclick = function () { send({ t: "react", emoji: r }); menu.classList.add("hidden"); };
    menu.appendChild(b);
  });
  $("bReact").onclick = function (e) { e.stopPropagation(); menu.classList.toggle("hidden"); };
  document.addEventListener("click", function (e) { if (!menu.contains(e.target)) menu.classList.add("hidden"); });

  document.addEventListener("keydown", function (e) {
    if ($("meeting").classList.contains("hidden") || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "m" || e.key === "M") setMic(!isMicOn());
    else if (e.key === "v" || e.key === "V") setCam(!isCamOn());
  });

  window.addEventListener("hashchange", function () {
    if ($("meeting").classList.contains("hidden")) setupLobby();
  });
  window.addEventListener("pagehide", function () { if (ws) { leaving = true; try { ws.close(1000); } catch (e) {} } });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", fillDevices);

  setupLobby();
})();
