// Thin API client for the LinearWatch Worker. Bearer session token in localStorage.
// On any 401 we clear the token and bounce to /login (handled by the auth layer via
// the "lw:unauthorized" event).

const API_BASE = (import.meta.env.VITE_API_BASE || "http://127.0.0.1:8787").replace(/\/$/, "");

const TOKEN_KEY = "lw_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (auth && getToken()) headers.Authorization = `Bearer ${getToken()}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new Event("lw:unauthorized"));
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

export const apiBase = () => API_BASE;
