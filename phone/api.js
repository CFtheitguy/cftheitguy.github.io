// Linear Phone — API client (Bearer-token auth, no cookies → Safari/iPad friendly)
(function () {
  const CFG = window.LINEAR_PHONE_CONFIG;
  const TOKEN_KEY = "linphone_token";

  const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
  const setToken = (t) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

  async function req(path, { method = "GET", body, auth = true } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) headers["Authorization"] = "Bearer " + getToken();
    const res = await fetch(CFG.API_BASE + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { setToken(""); window.dispatchEvent(new Event("linphone:unauthorized")); }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  window.API = {
    getToken, setToken,
    isLoggedIn: () => !!getToken(),

    login: async (password) => {
      const j = await req("/api/login", { method: "POST", body: { password }, auth: false });
      if (j && j.token) setToken(j.token);
      return j;
    },
    logout: () => setToken(""),

    // SIP credentials for the browser WebRTC softphone
    sipCreds: () => req("/api/sip-creds"),

    // Messaging
    threads: () => req("/api/threads"),
    thread: (number) => req("/api/thread?number=" + encodeURIComponent(number)),
    sendSms: (to, body) => req("/api/sms/send", { method: "POST", body: { to, body } }),
    markRead: (number) => req("/api/thread/read", { method: "POST", body: { number } }),

    // Calls
    calls: () => req("/api/calls"),
    logCall: (rec) => req("/api/calls", { method: "POST", body: rec }),

    // Voicemail
    voicemail: () => req("/api/voicemail"),

    // Contacts
    contacts: () => req("/api/contacts"),
    saveContact: (c) => req("/api/contacts", { method: "POST", body: c }),
    deleteContact: (id) => req("/api/contacts/delete", { method: "POST", body: { id } }),
  };
})();
