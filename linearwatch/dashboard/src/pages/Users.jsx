import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { formatDateTime } from "../lib.js";

const ROLES = ["viewer", "admin", "owner"];

export default function Users() {
  const { user } = useAuth();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ email: "", password: "", role: "viewer" });
  const [busy, setBusy] = useState(false);

  const reload = () => api("/v1/users").then((d) => setUsers(d.users)).catch((e) => setError(e.message));
  useEffect(() => { reload(); }, []);

  const addUser = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/v1/users", { method: "POST", body: form });
      setForm({ email: "", password: "", role: "viewer" });
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (u, role) => {
    try {
      await api(`/v1/users/${u.id}`, { method: "PATCH", body: { role } });
      reload();
    } catch (e) {
      alert(e.message);
    }
  };

  const remove = async (u) => {
    if (!confirm(`Delete ${u.email}? This signs them out and removes access.`)) return;
    try {
      await api(`/v1/users/${u.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      alert(e.message);
    }
  };

  const isOwner = user?.role === "owner";

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-900">Users &amp; roles</h1>

      <form onSubmit={addUser} className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
        <h2 className="font-medium text-slate-900">Add user</h2>
        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}
        <div className="grid sm:grid-cols-3 gap-3">
          <input type="email" required placeholder="email@company.com" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm sm:col-span-1" />
          <input type="password" required placeholder="temp password (8+ chars)" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm" />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            {ROLES.filter((r) => r !== "owner" || isOwner).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button type="submit" disabled={busy} className="bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-md px-4 py-2">
          {busy ? "Adding…" : "Add user"}
        </button>
      </form>

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium hidden sm:table-cell">Added</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(users || []).map((u) => {
              const self = u.id === user?.id;
              const canManageRole = isOwner || (u.role !== "owner");
              return (
                <tr key={u.id}>
                  <td className="px-4 py-2 text-slate-800">{u.email}{self && <span className="text-xs text-slate-400"> (you)</span>}</td>
                  <td className="px-4 py-2">
                    <select
                      value={u.role}
                      disabled={!canManageRole}
                      onChange={(e) => changeRole(u, e.target.value)}
                      className="rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                    >
                      {ROLES.filter((r) => r !== "owner" || isOwner).map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-slate-500 hidden sm:table-cell">{formatDateTime(u.created_at)}</td>
                  <td className="px-4 py-2 text-right">
                    {canManageRole && !self && (
                      <button onClick={() => remove(u)} className="text-xs text-red-600 hover:text-red-700">Delete</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {users && users.length === 0 && (
              <tr><td colSpan="4" className="px-4 py-4 text-slate-500">No users.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
