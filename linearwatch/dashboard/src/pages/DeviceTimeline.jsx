import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { relativeTime, formatDateTime, formatTime, todayLocal, bytesToKb } from "../lib.js";

// Full-image lightbox. Fetches a fresh short-lived signed URL on open (which also
// writes the audit-log "view" entry server-side).
function Lightbox({ shot, onClose }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const requested = useRef(false);
  useEffect(() => {
    // Guard against React StrictMode's double-invoke so a view logs exactly once.
    if (requested.current) return;
    requested.current = true;
    let alive = true;
    api(`/v1/screenshots/${shot.id}/full-url`)
      .then((d) => alive && setUrl(d.url))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [shot.id]);

  return (
    <div className="fixed inset-0 z-30 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200">
          <div className="text-sm text-slate-700">
            Captured <span className="font-medium">{formatDateTime(shot.captured_at)}</span>
            {shot.width ? <span className="text-slate-400"> · {shot.width}×{shot.height} · {bytesToKb(shot.bytes)}</span> : null}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 text-sm px-2 py-1">Close ✕</button>
        </div>
        <div className="bg-slate-900 flex-1 grid place-items-center overflow-auto min-h-[300px]">
          {error && <div className="text-red-300 text-sm p-6">{error}</div>}
          {!error && !url && <div className="text-slate-400 text-sm p-6">Loading full image…</div>}
          {url && <img src={url} alt="screenshot" className="max-w-full max-h-[80vh] object-contain" />}
        </div>
      </div>
    </div>
  );
}

export default function DeviceTimeline() {
  const { id } = useParams();
  const { user } = useAuth();
  const isAdmin = user && (user.role === "admin" || user.role === "owner");

  const [device, setDevice] = useState(null);
  const [from, setFrom] = useState(todayLocal());
  const [to, setTo] = useState(todayLocal());
  const [shots, setShots] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api(`/v1/devices/${id}`).then((d) => setDevice(d.device)).catch((e) => setError(e.message));
  }, [id]);

  const load = useCallback(
    async (reset) => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ from, to, limit: "60" });
        if (!reset && cursor) params.set("before", cursor);
        const d = await api(`/v1/devices/${id}/screenshots?${params}`);
        setShots((prev) => (reset ? d.screenshots : [...prev, ...d.screenshots]));
        setCursor(d.next_cursor);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [id, from, to, cursor],
  );

  // Reload whenever the date range changes.
  useEffect(() => {
    setShots([]);
    setCursor(null);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, from, to]);

  const revoke = async () => {
    if (!confirm("Revoke this device's token? The agent will stop being able to upload until re-enrolled.")) return;
    try {
      await api(`/v1/devices/${id}/revoke`, { method: "POST" });
      const d = await api(`/v1/devices/${id}`);
      setDevice(d.device);
    } catch (e) {
      alert(e.message);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <Link to="/devices" className="text-sm text-brand-600 hover:text-brand-700">← Devices</Link>
      </div>

      {device && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{device.hostname}</h1>
            <div className="text-sm text-slate-500 mt-1">
              Monitored user <span className="font-medium text-slate-700">{device.monitored_username}</span> ·
              last seen {relativeTime(device.last_seen_at)}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              {device.revoked_at ? (
                <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">Revoked</span>
              ) : device.consent_acknowledged_at ? (
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                  Consent acknowledged {formatDateTime(device.consent_acknowledged_at)}
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Consent pending</span>
              )}
            </div>
          </div>
          {isAdmin && !device.revoked_at && (
            <button onClick={revoke} className="text-sm text-red-600 border border-red-200 hover:bg-red-50 rounded-md px-3 py-1.5">
              Revoke device token
            </button>
          )}
        </div>
      )}

      <div className="bg-white rounded-lg border border-slate-200 p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">From</label>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">To</label>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setFrom(todayLocal()); setTo(todayLocal()); }}
            className="text-sm text-slate-600 border border-slate-300 rounded-md px-3 py-1.5 hover:bg-slate-50">Today</button>
        </div>
        <div className="ml-auto text-sm text-slate-500">{shots.length} shown</div>
      </div>

      {error && <div className="text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">{error}</div>}

      {shots.length === 0 && !loading ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-500">
          No screenshots in this date range.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {shots.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s)}
              className="group bg-white rounded-lg border border-slate-200 overflow-hidden hover:border-brand-400 hover:shadow-sm transition text-left"
            >
              <div className="aspect-[16/10] bg-slate-100 overflow-hidden">
                <img src={s.thumb_url} alt="" loading="lazy" className="w-full h-full object-cover group-hover:scale-[1.02] transition" />
              </div>
              <div className="px-2 py-1.5 text-xs text-slate-600">{formatTime(s.captured_at)}</div>
            </button>
          ))}
        </div>
      )}

      {loading && <div className="text-center text-slate-500 text-sm py-2">Loading…</div>}
      {cursor && !loading && (
        <div className="text-center">
          <button onClick={() => load(false)} className="text-sm text-brand-600 border border-brand-200 hover:bg-brand-50 rounded-md px-4 py-2">
            Load more
          </button>
        </div>
      )}

      {selected && <Lightbox shot={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
