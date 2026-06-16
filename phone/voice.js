// Linear Phone — WebRTC voice module (SignalWire Call Fabric, @signalwire/js v4)
// The browser logs in as a Call Fabric "Subscriber" with a short-lived token
// (no SIP registration), so it can both place and receive PSTN calls over
// WebSocket. Inbound calls reach it via SWML `connect` to /private/<subscriber>.
window.Voice = (function () {
  let client = null;
  let rootEl = null;
  let currentCall = null;   // active Call object
  let pendingInvite = null; // incoming invite awaiting answer
  let cbs = {};
  let muted = false;
  let callStartedAt = 0;
  let callNumber = "";
  let callDirection = "out";

  function getSDK() {
    // CDN build exposes window.SignalWire.SignalWire(...)
    if (window.SignalWire && window.SignalWire.SignalWire) return window.SignalWire.SignalWire;
    if (typeof window.SignalWire === "function") return window.SignalWire;
    return null;
  }

  // Call objects across SDK builds expose slightly different method names;
  // call the first one that exists so we don't break on minor version drift.
  function invoke(obj, names, args) {
    for (const n of names) {
      if (obj && typeof obj[n] === "function") { try { return obj[n].apply(obj, args || []); } catch (_) {} }
    }
  }

  async function init(options) {
    cbs = options || {};
    rootEl = cbs.rootElement || cbs.remoteAudio || null;
    const onStatus = (s) => cbs.onStatus && cbs.onStatus(s);
    const onError = (m) => { console.warn("[Voice]", m); cbs.onError && cbs.onError(m); };

    const SignalWire = getSDK();
    if (!SignalWire) { onError("Calling SDK not loaded."); onStatus("offline"); return; }
    onStatus("connecting");
    try {
      const { token } = await cbs.getRtcToken();
      if (!token) throw new Error("No token returned (check SignalWire project/token + Subscriber).");

      client = await SignalWire({ token });

      // Go online to receive inbound call invites.
      await client.online({
        incomingCallHandlers: {
          all: (notification) => handleInvite(notification),
        },
      });
      onStatus("ready");
    } catch (e) {
      onError("Voice connect failed: " + (e && e.message || e));
      onStatus("offline");
    }
  }

  function handleInvite(notification) {
    const invite = (notification && notification.invite) || notification;
    pendingInvite = invite;
    const d = (invite && invite.details) || invite || {};
    callDirection = "in";
    callNumber = d.callerIdNumber || d.caller_id_number || d.from || "";
    if (callNumber && !String(callNumber).startsWith("+") && /^\d+$/.test(callNumber)) callNumber = "+" + callNumber;
    cbs.onIncoming && cbs.onIncoming(callNumber);
  }

  function attachCall(call) {
    currentCall = call;
    const onActive = () => { if (!callStartedAt) { callStartedAt = Date.now(); cbs.onConnected && cbs.onConnected(); } };
    // Cover the various state event shapes emitted by the SDK.
    if (call && typeof call.on === "function") {
      call.on("call.state", (p) => {
        const st = (p && (p.call_state || p.state)) || "";
        if (st === "answered" || st === "active") onActive();
        if (st === "ended" || st === "hangup" || st === "destroy") finishCall();
      });
      call.on("active", onActive);
      call.on("destroy", () => finishCall());
      call.on("ended", () => finishCall());
    }
  }

  function finishCall() {
    if (!currentCall && !callDirection) return;
    const duration = callStartedAt ? Math.round((Date.now() - callStartedAt) / 1000) : 0;
    const number = callNumber || "";
    if (number && window.API) {
      const st = duration > 0 ? "completed" : (callDirection === "in" ? "missed" : "no-answer");
      window.API.logCall({ number, direction: callDirection, status: st, duration }).catch(() => {});
    }
    callStartedAt = 0; callNumber = ""; muted = false; currentCall = null; pendingInvite = null;
    cbs.onEnded && cbs.onEnded();
  }

  // ---- public API ----
  async function call(number) {
    if (!client) throw new Error("Phone not connected");
    if (currentCall) throw new Error("Already in a call");
    callDirection = "out";
    callNumber = number;
    try {
      const c = await client.dial({ to: number, audio: true, video: false, rootElement: rootEl });
      attachCall(c);
      await invoke(c, ["start"]);
    } catch (e) {
      cbs.onError && cbs.onError("Call failed: " + (e && e.message || e));
      finishCall();
    }
  }

  async function answer() {
    if (!pendingInvite) return;
    try {
      const accept = pendingInvite.accept || (pendingInvite.invite && pendingInvite.invite.accept);
      const target = pendingInvite.accept ? pendingInvite : pendingInvite.invite;
      const c = await accept.call(target, { rootElement: rootEl, audio: true, video: false });
      attachCall(c || target);
    } catch (e) {
      cbs.onError && cbs.onError("Answer failed: " + (e && e.message || e));
      finishCall();
    }
  }

  function hangup() {
    if (currentCall) { invoke(currentCall, ["hangup", "leave"]); }
    else if (pendingInvite) {
      const reject = pendingInvite.reject || (pendingInvite.invite && pendingInvite.invite.reject);
      const target = pendingInvite.reject ? pendingInvite : pendingInvite.invite;
      if (reject) try { reject.call(target); } catch (_) {}
      finishCall();
    } else { cbs.onEnded && cbs.onEnded(); }
  }

  function toggleMute() {
    if (!currentCall) return muted;
    muted = !muted;
    if (muted) invoke(currentCall, ["audioMute", "muteAudio"]);
    else invoke(currentCall, ["audioUnmute", "unmuteAudio"]);
    return muted;
  }

  function toggleSpeaker() { return true; }
  function sendDigit(d) { if (currentCall) invoke(currentCall, ["sendDigits", "dtmf"], [d]); }
  function inCall() { return !!(currentCall || pendingInvite); }

  return { init, call, answer, hangup, toggleMute, toggleSpeaker, sendDigit, inCall };
})();
