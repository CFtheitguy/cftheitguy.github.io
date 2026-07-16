import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { relativeTime } from "../lib.js";

function ConsentBadge({ device }) {
  if (device.revoked_at)
    return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">Revoked</span>;
  if (device.consent_acknowledged_at)
    return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Consented</span>;
  return <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Consent pending</span>;
}

function isOnline(device) {
  if (!device.last_seen_at || device.revoked_at) return false;
  const t = Date.parse(device.last_seen_at.replace(" ", "T") + (device.last_seen_at.includes("Z") ? "" : "Z"));
  return Number.isFinite(t) && Date.now() - t < 5 * 60 * 1000; // seen in last 5 min
}

function Stat({ label, value, tone = "slate" }) {
  const tones = { slate: "text-slate-900", emerald: "text-emerald-600", amber: "text-amber-600" };
  return (
    <div className="bg-white rounded-lg border border-slate-200 px-4 py-3">
      <div className={`text-2xl font-semibold ${tones[tone]}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

export default function Devices() {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/v1/devices")
        .then((d) => alive && setDevices(d.devices))
        .catch((e) => alive && setError(e.message));
    load();
    const id = setInterval(load, 15000); // light polling for live-ish status
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (error) return <div className="text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">{error}</div>;
  if (!devices) return <div className="text-slate-500">Loading devices…</div>;

  const online = devices.filter(isOnline).length;
  const pending = devices.filter((d) => !d.consent_acknowledged_at && !d.revoked_at).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Devices</h1>
        <p className="text-sm text-slate-500">Company-owned, monitored devices enrolled in your organization.</p>
      </div>

      <div className="grid grid-cols-3 gap-3 max-w-md">
        <Stat label="Devices" value={devices.length} />
        <Stat label="Online" value={online} tone="emerald" />
        <Stat label="Consent pending" value={pending} tone={pending ? "amber" : "slate"} />
      </div>

      {devices.length === 0 ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-500">
          No devices yet. Create an enrollment code in <span className="font-medium">Settings</span> and run the agent
          (or the mock device) to enroll one.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {devices.map((d) => (
            <button
              key={d.id}
              onClick={() => navigate(`/devices/${d.id}`)}
              className="text-left bg-white rounded-lg border border-slate-200 hover:border-brand-400 hover:shadow-sm transition p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${isOnline(d) ? "bg-emerald-500" : "bg-slate-300"}`} />
                  <span className="font-medium text-slate-900 truncate">{d.hostname}</span>
                </div>
                <ConsentBadge device={d} />
              </div>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-slate-500">User</dt><dd className="text-slate-800">{d.monitored_username}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Last seen</dt><dd className="text-slate-800">{relativeTime(d.last_seen_at)}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-500">Screenshots</dt><dd className="text-slate-800">{d.screenshot_count?.toLocaleString() ?? 0}</dd></div>
              </dl>
              {d.paused_reason && (
                <div className="mt-2 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">Paused: {d.paused_reason}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
