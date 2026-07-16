import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./auth.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Devices from "./pages/Devices.jsx";
import DeviceTimeline from "./pages/DeviceTimeline.jsx";
import Settings from "./pages/Settings.jsx";
import Users from "./pages/Users.jsx";

function Protected({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return <div className="min-h-screen grid place-items-center text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Navigate to="/devices" replace />} />
      <Route path="/devices" element={<Protected><Devices /></Protected>} />
      <Route path="/devices/:id" element={<Protected><DeviceTimeline /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="/users" element={<Protected><Users /></Protected>} />
      <Route path="*" element={<Navigate to="/devices" replace />} />
    </Routes>
  );
}
