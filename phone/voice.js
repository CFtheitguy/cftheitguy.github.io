// Linear Phone — WebRTC voice module (SignalWire RELAY browser SDK)
// Uses the RELAY v2 browser client which dials PSTN numbers directly with
// caller ID. Texting still works even if this module can't connect.
window.Voice = (function () {
  let client = null;
  let currentCall = null;
  let cbs = {};
  let muted = false;
  let speaker = true;
  let callStartedAt = 0;
  let callNumber = "";
  let callDirection = "out";

  // The RELAY SDK exposes itself differently depending on the build.
  function getRelay() {
    if (window.Relay) return window.Relay;
    if (window.SignalWire && window.SignalWire.Relay) return window.SignalWire.Relay;
    return null;
  }

  async function init(options) {
    cbs = options || {};
    const Relay = getRelay();
    if (!Relay) {
      console.warn("[Voice] RELAY SDK not loaded — calling disabled, texting still works.");
      status("offline");
      return;
    }
    status("connecting");
    try {
      const { token, project } = await cbs.getRtcToken();
      client = new Relay({ project, token });
      // Where the remote party's audio plays:
      if (cbs.remoteAudio) client.remoteElement = cbs.remoteAudio.id || "remoteAudio";
      client.iceServers = client.iceServers; // keep defaults

      client.on("signalwire.ready", () => status("ready"));
      client.on("signalwire.error", (e) => { console.error("[Voice] error", e); status("offline"); });
      client.on("signalwire.socket.close", () => status("offline"));
      client.on("signalwire.notification", handleNotification);

      await client.connect();
    } catch (e) {
      console.error("[Voice] init failed", e);
      status("offline");
    }
  }

  function handleNotification(n) {
    if (n.type !== "callUpdate" || !n.call) return;
    const call = n.call;
    currentCall = call;
    switch (call.state) {
      case "ringing":
        if (call.direction === "inbound") {
          callDirection = "in";
          callNumber = call.options.remoteCallerNumber || call.from || "";
          cbs.onIncoming && cbs.onIncoming(callNumber);
        }
        break;
      case "active":
        callStartedAt = Date.now();
        cbs.onConnected && cbs.onConnected();
        break;
      case "hangup":
      case "destroy":
        finishCall(call);
        break;
    }
  }

  function finishCall(call) {
    const duration = callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0;
    const number = callNumber || (call && call.options && (call.options.destinationNumber || call.options.remoteCallerNumber)) || "";
    if (number && window.API) {
      const status = duration > 0 ? "completed" : (callDirection === "in" ? "missed" : "no-answer");
      window.API.logCall({ number, direction: callDirection, status, duration }).catch(() => {});
    }
    callStartedAt = 0; callNumber = ""; muted = false; currentCall = null;
    cbs.onEnded && cbs.onEnded();
  }

  function status(s) { cbs.onStatus && cbs.onStatus(s); }

  // ---- public API ----
  function call(number) {
    if (!client) throw new Error("Phone not connected");
    callDirection = "out";
    callNumber = number;
    currentCall = client.newCall({
      destinationNumber: number,
      callerNumber: cbs.myNumber,
      audio: true,
      video: false,
    });
  }
  function answer() { if (currentCall) currentCall.answer(); }
  function hangup() { if (currentCall) currentCall.hangup(); else cbs.onEnded && cbs.onEnded(); }
  function toggleMute() {
    if (!currentCall) return muted;
    muted = !muted;
    muted ? currentCall.muteAudio() : currentCall.unmuteAudio();
    return muted;
  }
  function toggleSpeaker() { speaker = !speaker; return speaker; }
  function sendDigit(d) { if (currentCall && currentCall.dtmf) currentCall.dtmf(d); }
  function inCall() { return !!currentCall; }

  return { init, call, answer, hangup, toggleMute, toggleSpeaker, sendDigit, inCall };
})();
