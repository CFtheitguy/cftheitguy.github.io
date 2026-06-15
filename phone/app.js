// Linear Phone — UI controller
(function () {
  const CFG = window.LINEAR_PHONE_CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  // ---------- helpers ----------
  const fmtNumber = (n) => {
    const d = (n || "").replace(/[^\d]/g, "").replace(/^1(?=\d{10}$)/, "");
    return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : (n || "");
  };
  const e164 = (n) => {
    let d = (n || "").replace(/[^\d+]/g, "");
    if (d.startsWith("+")) return d;
    d = d.replace(/\D/g, "");
    if (d.length === 10) return "+1" + d;
    if (d.length === 11 && d.startsWith("1")) return "+" + d;
    return "+" + d;
  };
  const timeAgo = (iso) => {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s/60) + "m";
    if (s < 86400) return Math.floor(s/3600) + "h";
    if (s < 604800) return Math.floor(s/86400) + "d";
    return new Date(iso).toLocaleDateString();
  };
  const esc = (s) => (s||"").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const toast = (msg) => {
    const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), 2600);
  };

  let CONTACTS = [];
  const contactFor = (number) => {
    const k = e164(number);
    return CONTACTS.find(c => e164(c.number) === k);
  };
  const displayName = (number) => { const c = contactFor(number); return c ? c.name : fmtNumber(number); };

  // ====================================================================
  // LOGIN
  // ====================================================================
  async function doLogin() {
    const pw = $("#loginPassword").value;
    if (!pw) return;
    $("#loginMsg").textContent = "Signing in…";
    try {
      await API.login(pw);
      $("#loginMsg").textContent = "";
      enterApp();
    } catch (e) {
      $("#loginMsg").textContent = "❌ " + e.message;
    }
  }
  $("#loginBtn").onclick = doLogin;
  $("#loginPassword").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  window.addEventListener("linphone:unauthorized", () => location.reload());

  function enterApp() {
    $("#loginScreen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#myNumberLabel").textContent = fmtNumber(CFG.MY_NUMBER);
    initVoice();
    refreshAll();
    startPolling();
    showPanel("messages");
  }

  $("#logoutBtn").onclick = () => { API.logout(); location.reload(); };

  // ====================================================================
  // NAVIGATION
  // ====================================================================
  function showPanel(name) {
    $$(".panel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== name));
    $$(".navbtn").forEach(b => b.classList.toggle("tab-active", b.dataset.nav === name));
    if (name === "messages") closeThread();
  }
  $$(".navbtn").forEach(b => b.onclick = () => showPanel(b.dataset.nav));

  // ====================================================================
  // MESSAGES
  // ====================================================================
  let currentThread = null;

  async function loadThreads() {
    try {
      const { threads } = await API.threads();
      const list = $("#threadList");
      if (!threads.length) { list.innerHTML = `<div class="p-8 text-center text-slate-400">No conversations yet</div>`; return; }
      list.innerHTML = threads.map(t => {
        const name = displayName(t.number);
        const unread = t.unread ? `<span class="ml-2 w-2.5 h-2.5 rounded-full bg-brand inline-block"></span>` : "";
        return `<button class="thread-item w-full text-left px-4 py-3 hover:bg-slate-50 flex items-center gap-3 border-b" data-number="${esc(t.number)}">
          <div class="w-11 h-11 rounded-full bg-slate-200 grid place-items-center font-semibold text-slate-600 shrink-0">${esc(name[0]||"#")}</div>
          <div class="flex-1 min-w-0">
            <div class="flex justify-between"><span class="font-semibold truncate">${esc(name)}</span><span class="text-[11px] text-slate-400 shrink-0 ml-2">${timeAgo(t.last_at)}</span></div>
            <div class="text-sm text-slate-500 truncate ${t.unread?'font-semibold text-slate-800':''}">${t.last_dir==='out'?'You: ':''}${esc(t.last_body||'')}${unread}</div>
          </div>
        </button>`;
      }).join("");
      $$(".thread-item", list).forEach(el => el.onclick = () => openThread(el.dataset.number));
    } catch (e) { /* offline / not ready */ }
  }

  async function openThread(number) {
    currentThread = number;
    $("#threadTitle").textContent = displayName(number);
    $("#threadSub").textContent = contactFor(number) ? fmtNumber(number) : "";
    $("#threadView").classList.remove("hidden");
    $("#threadMessages").innerHTML = `<div class="text-center text-slate-400 text-sm">Loading…</div>`;
    try {
      const { messages } = await API.thread(number);
      renderThreadMessages(messages);
      API.markRead(number).catch(()=>{});
    } catch (e) { $("#threadMessages").innerHTML = `<div class="text-center text-red-400 text-sm">${esc(e.message)}</div>`; }
  }

  function renderThreadMessages(messages) {
    const box = $("#threadMessages");
    box.innerHTML = messages.map(m => {
      const out = m.direction === "out";
      return `<div class="flex ${out?'justify-end':'justify-start'}">
        <div class="max-w-[78%] px-3 py-2 ${out?'bg-brand text-white bubble-out':'bg-white border bubble-in'}">
          <div class="whitespace-pre-wrap break-words text-[15px]">${esc(m.body)}</div>
          <div class="text-[10px] ${out?'text-blue-100':'text-slate-400'} text-right mt-0.5">${new Date(m.created_at).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}</div>
        </div></div>`;
    }).join("");
    box.scrollTop = box.scrollHeight;
  }

  function closeThread() { currentThread = null; $("#threadView").classList.add("hidden"); }
  $("#threadBack").onclick = () => { closeThread(); loadThreads(); };
  $("#threadCall").onclick = () => { if (currentThread) startCall(currentThread); };

  // composer
  const composerInput = $("#composerInput");
  composerInput.addEventListener("input", () => {
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(composerInput.scrollHeight, 128) + "px";
  });
  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = composerInput.value.trim();
    if (!body || !currentThread) return;
    composerInput.value = ""; composerInput.style.height = "auto";
    // optimistic
    const box = $("#threadMessages");
    box.insertAdjacentHTML("beforeend", `<div class="flex justify-end"><div class="max-w-[78%] px-3 py-2 bg-brand/70 text-white bubble-out"><div class="text-[15px]">${esc(body)}</div></div></div>`);
    box.scrollTop = box.scrollHeight;
    try { await API.sendSms(currentThread, body); openThread(currentThread); loadThreads(); }
    catch (err) { toast("Send failed: " + err.message); }
  });

  // ====================================================================
  // CALLS
  // ====================================================================
  async function loadCalls() {
    try {
      const { calls } = await API.calls();
      const list = $("#callList");
      if (!calls.length) { list.innerHTML = `<div class="p-8 text-center text-slate-400">No calls yet</div>`; return; }
      list.innerHTML = calls.map(c => {
        const missed = c.direction === "in" && c.status === "missed";
        const arrow = c.direction === "out" ? "↗" : (missed ? "↙" : "↘");
        const color = missed ? "text-red-500" : "text-slate-400";
        return `<div class="px-4 py-3 flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-slate-200 grid place-items-center ${color}">${arrow}</div>
          <div class="flex-1 min-w-0">
            <div class="font-medium truncate ${missed?'text-red-500':''}">${esc(displayName(c.number))}</div>
            <div class="text-xs text-slate-500">${c.direction==='out'?'Outgoing':missed?'Missed':'Incoming'}${c.duration?` · ${Math.floor(c.duration/60)}:${String(c.duration%60).padStart(2,'0')}`:''} · ${timeAgo(c.created_at)}</div>
          </div>
          <button class="callback text-brand text-xl px-2" data-number="${esc(c.number)}">📞</button>
        </div>`;
      }).join("");
      $$(".callback", list).forEach(b => b.onclick = () => startCall(b.dataset.number));
    } catch (e) {}
  }

  // ====================================================================
  // VOICEMAIL
  // ====================================================================
  async function loadVoicemail() {
    try {
      const { voicemail } = await API.voicemail();
      const list = $("#vmList");
      if (!voicemail.length) { list.innerHTML = `<div class="p-8 text-center text-slate-400">No voicemail</div>`; return; }
      list.innerHTML = voicemail.map(v => `
        <div class="px-4 py-3">
          <div class="flex justify-between items-center mb-1">
            <span class="font-medium">${esc(displayName(v.number))}</span>
            <span class="text-[11px] text-slate-400">${timeAgo(v.created_at)}</span>
          </div>
          ${v.transcript ? `<div class="text-sm text-slate-600 mb-2">“${esc(v.transcript)}”</div>` : ""}
          ${v.recording_url ? `<audio controls preload="none" class="w-full h-9" src="${esc(v.recording_url)}"></audio>` : ""}
        </div>`).join("");
    } catch (e) {}
  }

  // ====================================================================
  // CONTACTS
  // ====================================================================
  async function loadContacts() {
    try {
      const { contacts } = await API.contacts();
      CONTACTS = contacts || [];
      renderContacts($("#contactSearch").value);
    } catch (e) {}
  }
  function renderContacts(filter = "") {
    const f = filter.trim().toLowerCase();
    const items = CONTACTS.filter(c => !f || c.name.toLowerCase().includes(f) || c.number.includes(f))
                          .sort((a,b) => a.name.localeCompare(b.name));
    const list = $("#contactList");
    if (!items.length) { list.innerHTML = `<div class="p-8 text-center text-slate-400">No contacts</div>`; return; }
    list.innerHTML = items.map(c => `
      <div class="px-4 py-3 flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-slate-200 grid place-items-center font-semibold text-slate-600">${esc(c.name[0]||'#')}</div>
        <div class="flex-1 min-w-0"><div class="font-medium truncate">${esc(c.name)}</div><div class="text-xs text-slate-500">${esc(fmtNumber(c.number))}</div></div>
        <button class="c-text text-brand px-2" data-number="${esc(c.number)}">💬</button>
        <button class="c-call text-brand px-2" data-number="${esc(c.number)}">📞</button>
        <button class="c-edit text-slate-400 px-2" data-id="${esc(c.id)}">✎</button>
      </div>`).join("");
    $$(".c-call", list).forEach(b => b.onclick = () => startCall(b.dataset.number));
    $$(".c-text", list).forEach(b => b.onclick = () => { showPanel("messages"); openThread(b.dataset.number); });
    $$(".c-edit", list).forEach(b => b.onclick = () => openContactModal(CONTACTS.find(c => String(c.id) === b.dataset.id)));
  }
  $("#contactSearch").addEventListener("input", e => renderContacts(e.target.value));
  $("#contactAdd").onclick = () => openContactModal(null);

  function openContactModal(c) {
    $("#contactModalTitle").textContent = c ? "Edit contact" : "New contact";
    $("#cId").value = c ? c.id : "";
    $("#cName").value = c ? c.name : "";
    $("#cNumber").value = c ? c.number : "";
    $("#cDelete").classList.toggle("hidden", !c);
    $("#contactModal").classList.remove("hidden");
  }
  $("#cCancel").onclick = () => $("#contactModal").classList.add("hidden");
  $("#cSave").onclick = async () => {
    const name = $("#cName").value.trim(), number = $("#cNumber").value.trim();
    if (!name || !number) return toast("Name and number required");
    try {
      await API.saveContact({ id: $("#cId").value || undefined, name, number: e164(number) });
      $("#contactModal").classList.add("hidden"); loadContacts();
    } catch (e) { toast(e.message); }
  };
  $("#cDelete").onclick = async () => {
    if (!$("#cId").value) return;
    try { await API.deleteContact($("#cId").value); $("#contactModal").classList.add("hidden"); loadContacts(); }
    catch (e) { toast(e.message); }
  };

  // ====================================================================
  // DIALER
  // ====================================================================
  const dialInput = $("#dialInput");
  const keys = ["1","2","3","4","5","6","7","8","9","*","0","#"];
  const keypadGrid = $('[data-panel="dialer"] .grid');
  keypadGrid.innerHTML = keys.map(k => {
    const sub = {2:"ABC",3:"DEF",4:"GHI",5:"JKL",6:"MNO",7:"PQRS",8:"TUV",9:"WXYZ"}[k] || (k==="0"?"+":"");
    return `<button class="dialkey w-18 h-18 rounded-full bg-slate-100 hover:bg-slate-200 grid place-items-center" data-k="${k}" style="width:4.5rem;height:4.5rem">
      <div class="text-center leading-none"><div class="text-2xl">${k}</div><div class="text-[10px] text-slate-400 tracking-widest">${sub}</div></div></button>`;
  }).join("");
  $$(".dialkey", keypadGrid).forEach(b => b.onclick = () => {
    let k = b.dataset.k;
    if (k === "0" && b._long) return;
    dialInput.value += k; updateDialMatch();
    if (window.Voice && Voice.inCall()) Voice.sendDigit(k);
  });
  // long-press 0 → +
  let zeroTimer;
  const zeroBtn = $('[data-k="0"]', keypadGrid);
  zeroBtn.addEventListener("pointerdown", () => { zeroTimer = setTimeout(() => { dialInput.value += "+"; zeroBtn._long = true; updateDialMatch(); }, 500); });
  zeroBtn.addEventListener("pointerup", () => { clearTimeout(zeroTimer); setTimeout(()=>zeroBtn._long=false, 50); });

  function updateDialMatch() {
    const c = contactFor(dialInput.value);
    $("#dialMatch").textContent = c ? c.name : "";
  }
  dialInput.addEventListener("input", updateDialMatch);
  $("#dialBack").onclick = () => { dialInput.value = dialInput.value.slice(0, -1); updateDialMatch(); };
  $("#dialCall").onclick = () => { if (dialInput.value.trim()) startCall(dialInput.value.trim()); };

  // ====================================================================
  // CALLING (delegates to Voice module in voice.js)
  // ====================================================================
  let callTimerInt, callStart;
  function startCall(number) {
    const num = e164(number);
    showCallOverlay({ name: displayName(num), state: "Calling…", incoming: false });
    try { Voice.call(num); }
    catch (e) { toast("Call failed: " + e.message); hideCallOverlay(); }
  }

  function showCallOverlay({ name, state, incoming }) {
    $("#callName").textContent = name;
    $("#callState").textContent = state;
    $("#callTimer").textContent = "";
    $("#incomingActions").classList.toggle("hidden", !incoming);
    $("#activeActions").classList.toggle("hidden", incoming);
    $("#callControls").classList.toggle("hidden", incoming);
    const o = $("#callOverlay"); o.classList.remove("hidden"); o.classList.add("flex");
  }
  function hideCallOverlay() {
    const o = $("#callOverlay"); o.classList.add("hidden"); o.classList.remove("flex");
    clearInterval(callTimerInt);
  }
  function startCallTimer() {
    callStart = Date.now();
    callTimerInt = setInterval(() => {
      const s = Math.floor((Date.now() - callStart) / 1000);
      $("#callTimer").textContent = `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;
    }, 1000);
  }

  $("#hangupBtn").onclick = () => Voice.hangup();
  $("#declineBtn").onclick = () => Voice.hangup();
  $("#acceptBtn").onclick = () => Voice.answer();
  $$("#callControls .cc").forEach(b => b.onclick = () => {
    const a = b.dataset.cc;
    if (a === "mute") { const m = Voice.toggleMute(); b.classList.toggle("opacity-50", m); }
    if (a === "speaker") { const sp = Voice.toggleSpeaker(); b.classList.toggle("opacity-50", !sp); }
    if (a === "keypad") { const k = prompt("Send digit(s):"); if (k) [...k].forEach(d => Voice.sendDigit(d)); }
  });

  // Voice module callbacks
  function initVoice() {
    Voice.init({
      remoteAudio: $("#remoteAudio"),
      getRtcToken: () => API.rtcToken(),
      myNumber: CFG.MY_NUMBER,
      onStatus: (status) => {
        const el = $("#phoneStatus");
        const map = { ready: ["Online","bg-green-100 text-green-700"], connecting: ["connecting…","bg-slate-100 text-slate-500"], offline: ["Offline","bg-red-100 text-red-600"] };
        const [txt, cls] = map[status] || map.offline;
        el.textContent = txt; el.className = "text-[11px] px-2 py-1 rounded-full " + cls;
      },
      onIncoming: (number) => {
        showCallOverlay({ name: displayName(number), state: "Incoming call…", incoming: true });
      },
      onConnected: () => {
        $("#callState").textContent = "Connected";
        $("#incomingActions").classList.add("hidden");
        $("#activeActions").classList.remove("hidden");
        $("#callControls").classList.remove("hidden");
        startCallTimer();
      },
      onEnded: () => { hideCallOverlay(); loadCalls(); },
    });
  }

  // ====================================================================
  // POLLING / REFRESH
  // ====================================================================
  function refreshAll() { loadContacts().then(() => { loadThreads(); loadCalls(); loadVoicemail(); }); }
  let pollInt;
  function startPolling() {
    clearInterval(pollInt);
    pollInt = setInterval(() => {
      if (document.hidden) return;
      loadThreads();
      if (currentThread) openThread(currentThread);
      loadCalls();
    }, CFG.POLL_INTERVAL_MS || 5000);
  }

  // ====================================================================
  // BOOT
  // ====================================================================
  if (API.isLoggedIn()) enterApp();
})();
