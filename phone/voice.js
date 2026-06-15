// Linear Phone — WebRTC voice module (SIP-over-WebSocket via JsSIP)
// Registers the browser as the "ipad1" SIP endpoint on SignalWire.
// Inbound PSTN calls reach the browser via <Dial><Sip>sip:ipad1@domain</Sip></Dial> in the IVR.
window.Voice = (function () {
  let ua = null;
  let sipDomain = "";
  let currentSession = null;
  let cbs = {};
  let muted = false;
  let callStartedAt = 0;
  let callNumber = "";
  let callDirection = "out";

  async function init(options) {
    cbs = options || {};
    const onStatus = (s) => cbs.onStatus && cbs.onStatus(s);
    if (!window.JsSIP) {
      console.warn("[Voice] JsSIP not loaded — calling disabled.");
      onStatus("offline");
      return;
    }
    onStatus("connecting");
    try {
      const creds = await cbs.getSipCreds();
      if (!creds || !creds.domain || !creds.user || !creds.password) {
        throw new Error("SIP credentials not configured (WEBPHONE_SIP_USER/DOMAIN/WEBRTC_PASSWORD)");
      }
      sipDomain = creds.domain;
      JsSIP.debug.disable("JsSIP:*");

      const socket = new JsSIP.WebSocketInterface("wss://" + sipDomain);
      ua = new JsSIP.UA({
        sockets: [socket],
        uri: "sip:" + creds.user + "@" + sipDomain,
        password: creds.password,
        register: true,
        register_expires: 300,
        connection_recovery_min_interval: 4,
        connection_recovery_max_interval: 30,
        session_timers: false,
      });

      ua.on("registered",          () => onStatus("ready"));
      ua.on("unregistered",        () => onStatus("offline"));
      ua.on("registrationFailed",  (e) => { console.error("[Voice] reg failed:", e.cause); onStatus("offline"); });
      ua.on("disconnected",        () => onStatus("offline"));
      ua.on("newRTCSession",       handleSession);
      ua.start();
    } catch (e) {
      console.error("[Voice] init failed:", e);
      cbs.onStatus && cbs.onStatus("offline");
    }
  }

  function wireAudio(pc) {
    pc.addEventListener("track", (ev) => {
      const audio = cbs.remoteAudio;
      if (audio && ev.streams && ev.streams[0]) {
        audio.srcObject = ev.streams[0];
        audio.play().catch(() => {});
      }
    });
  }

  function handleSession(e) {
    const session = e.session;
    if (currentSession) {
      session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
      return;
    }
    currentSession = session;

    if (session.direction === "incoming") {
      callDirection = "in";
      const uri = session.remote_identity && session.remote_identity.uri;
      callNumber = uri ? (uri.user || "") : "";
      if (callNumber && !callNumber.startsWith("+")) callNumber = "+" + callNumber;
      cbs.onIncoming && cbs.onIncoming(callNumber);
    }

    session.on("peerconnection", (data) => wireAudio(data.peerconnection));
    session.on("accepted",  () => { if (!callStartedAt) { callStartedAt = Date.now(); cbs.onConnected && cbs.onConnected(); } });
    session.on("confirmed", () => { if (!callStartedAt) { callStartedAt = Date.now(); cbs.onConnected && cbs.onConnected(); } });
    session.on("failed",    () => finishCall());
    session.on("ended",     () => finishCall());
  }

  function finishCall() {
    const duration = callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0;
    const number = callNumber || "";
    if (number && window.API) {
      const st = duration > 0 ? "completed" : (callDirection === "in" ? "missed" : "no-answer");
      window.API.logCall({ number, direction: callDirection, status: st, duration }).catch(() => {});
    }
    callStartedAt = 0; callNumber = ""; muted = false; currentSession = null;
    cbs.onEnded && cbs.onEnded();
  }

  // ---- public API ----
  function call(number) {
    if (!ua || !ua.isRegistered()) throw new Error("Phone not connected");
    if (currentSession) throw new Error("Already in a call");
    callDirection = "out";
    callNumber = number;
    const target = "sip:" + number.replace(/[^+\d]/g, "") + "@" + sipDomain;
    ua.call(target, {
      mediaConstraints: { audio: true, video: false },
      rtcOfferConstraints: { offerToReceiveAudio: 1, offerToReceiveVideo: 0 },
    });
  }

  function answer() {
    if (currentSession && currentSession.direction === "incoming") {
      currentSession.answer({ mediaConstraints: { audio: true, video: false } });
    }
  }

  function hangup() {
    if (currentSession) {
      try { currentSession.terminate(); } catch (_) {}
    } else {
      cbs.onEnded && cbs.onEnded();
    }
  }

  function toggleMute() {
    if (!currentSession) return muted;
    muted = !muted;
    if (muted) currentSession.mute({ audio: true });
    else currentSession.unmute({ audio: true });
    return muted;
  }

  function toggleSpeaker() { return true; }
  function sendDigit(d) { if (currentSession) currentSession.sendDTMF(d); }
  function inCall() { return !!currentSession; }

  return { init, call, answer, hangup, toggleMute, toggleSpeaker, sendDigit, inCall };
})();
