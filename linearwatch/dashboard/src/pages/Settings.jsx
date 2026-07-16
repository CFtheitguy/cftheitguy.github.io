import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { formatDateTime } from "../lib.js";

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="text-xs text-brand-600 hover:text-brand-700 border border-brand-200 rounded px-2 py-0.5"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function Settings() {
  const { org, setOrg } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [interval, setIntervalVal] = useState(120);
  const [retention, setRetention] = useState(30);

  const reload = () =>
    api("/v1/settings")
      .then((d) => {
        setData(d);
        setIntervalVal(d.org.capture_interval_seconds);
        setRetention(d.org.retention_days);
      })
      .catch((e) => setError(e.message));

  useEffect(() => { reload(); }, []);

  const saveOrg = async (e) => {
    e.preventDefault();
    setError("");
    setSaved(false);
    try {
      const d = await api("/v1/settings", {
        method: "PATCH",
        body: { capture_interval_seconds: Number(interval), retention_days: Number(retention) },
      });
      setOrg((o) => ({ ...o, ...d.org }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const createCode = async () => {
    const label = prompt("Label for this enrollment code (optional):", "");
    if (label === null) return;
    try {
      await api("/v1/enrollment-codes", { method: "POST", body: { label: label || undefined } });
      reload();
    } catch (e) {
      alert(e.message);
    }
  };

  const revokeCode = async (codeId) => {
    if (!confirm("Revoke this enrollment code? Existing devices keep working; the code can no longer enroll new ones.")) return;
    try {
      await api(`/v1/enrollment-codes/${codeId}/revoke`, { method: "POST" });
      reload();
    } catch (e) {
      alert(e.message);
    }
  };

  if (error && !data) return <div className="text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">{error}</div>;
  if (!data) return <div className="text-slate-500">Loading settings…</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-slate-900">Settings</h1>

      <form onSubmit={saveOrg} className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
        <h2 className="font-medium text-slate-900">Capture &amp; retention</h2>
        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Capture interval (seconds)</label>
            <input type="number" min="15" max="3600" value={interval} onChange={(e) => setIntervalVal(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <p className="text-xs text-slate-500 mt-1">How often each agent captures a frame (15–3600s).</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Retention (days)</label>
            <input type="number" min="1" max="365" value={retention} onChange={(e) => setRetention(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <p className="text-xs text-slate-500 mt-1">Screenshots older than this are auto-deleted (1–365 days).</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-md px-4 py-2">
            Save
          </button>
          {saved && <span className="text-sm text-emerald-600">Saved ✓</span>}
        </div>
      </form>

      <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-medium text-slate-900">Enrollment codes</h2>
            <p className="text-xs text-slate-500">Give a code to an agent on first run to enroll a device into this org.</p>
          </div>
          <button onClick={createCode} className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-md px-3 py-1.5">
            + New code
          </button>
        </div>
        <div className="divide-y divide-slate-100">
          {(data.enrollment_codes || []).length === 0 && (
            <div className="text-sm text-slate-500 py-3">No enrollment codes yet.</div>
          )}
          {(data.enrollment_codes || []).map((c) => (
            <div key={c.id} className="py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <code className={`font-mono text-sm px-2 py-1 rounded ${c.revoked_at ? "bg-slate-100 text-slate-400 line-through" : "bg-slate-900 text-slate-50"}`}>
                {c.code}
              </code>
              {!c.revoked_at && <CopyButton text={c.code} />}
              {c.label && <span className="text-sm text-slate-600">{c.label}</span>}
              <span className="text-xs text-slate-400">
                used {c.uses}{c.max_uses ? `/${c.max_uses}` : ""}{c.expires_at ? ` · expires ${formatDateTime(c.expires_at)}` : ""}
              </span>
              <div className="ml-auto">
                {c.revoked_at ? (
                  <span className="text-xs text-slate-400">revoked</span>
                ) : (
                  <button onClick={() => revokeCode(c.id)} className="text-xs text-red-600 hover:text-red-700">Revoke</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
