// Auth context: holds the logged-in user/org, exposes login/logout, and restores
// the session from a stored token on load.

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, setToken, getToken } from "./api.js";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const { user, org } = await api("/v1/auth/me");
      setUser(user);
      setOrg(org);
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
    const onUnauth = () => {
      setUser(null);
      setOrg(null);
    };
    window.addEventListener("lw:unauthorized", onUnauth);
    return () => window.removeEventListener("lw:unauthorized", onUnauth);
  }, [loadMe]);

  const login = async (email, password) => {
    const data = await api("/v1/auth/login", { method: "POST", auth: false, body: { email, password } });
    setToken(data.token);
    setUser(data.user);
    setOrg(data.org);
    return data.user;
  };

  const logout = async () => {
    try {
      await api("/v1/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setToken(null);
    setUser(null);
    setOrg(null);
  };

  return (
    <AuthCtx.Provider value={{ user, org, setOrg, loading, login, logout }}>{children}</AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
