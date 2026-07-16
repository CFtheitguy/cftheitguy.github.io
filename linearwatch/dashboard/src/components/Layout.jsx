// App shell for authenticated pages: top nav + a persistent compliance footer
// reminding admins this is disclosed monitoring.

import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";

function EyeLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="text-brand-600">
      <path d="M12 5c-5 0-8.5 4.5-9.5 6.4a1.3 1.3 0 000 1.2C3.5 14.5 7 19 12 19s8.5-4.5 9.5-6.4a1.3 1.3 0 000-1.2C20.5 9.5 17 5 12 5z" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export default function Layout({ children }) {
  const { user, org, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user && (user.role === "admin" || user.role === "owner");

  const navItem = ({ isActive }) =>
    `px-3 py-2 rounded-md text-sm font-medium ${isActive ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"}`;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-2">
          <div className="flex items-center gap-2 mr-2">
            <EyeLogo />
            <span className="font-semibold text-slate-900">LinearWatch</span>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink to="/devices" className={navItem}>Devices</NavLink>
            {isAdmin && <NavLink to="/settings" className={navItem}>Settings</NavLink>}
            {isAdmin && <NavLink to="/users" className={navItem}>Users</NavLink>}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right leading-tight hidden sm:block">
              <div className="text-sm font-medium text-slate-800">{org?.name}</div>
              <div className="text-xs text-slate-500">{user?.email} · {user?.role}</div>
            </div>
            <button
              onClick={async () => { await logout(); navigate("/login"); }}
              className="text-sm text-slate-600 hover:text-slate-900 border border-slate-300 rounded-md px-3 py-1.5"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6">{children}</main>

      <footer className="bg-white border-t border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3 text-xs text-slate-500 flex flex-wrap gap-x-2 gap-y-1 items-center">
          <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5">
            Disclosed monitoring
          </span>
          <span>
            Use only on company-owned devices with monitored users notified and consented per your local laws.
            Covert or non-consensual use is prohibited.
          </span>
        </div>
      </footer>
    </div>
  );
}
