import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { Spinner } from './ui.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Devices from './pages/Devices.jsx';
import DeviceDetail from './pages/DeviceDetail.jsx';
import DeviceReport from './pages/DeviceReport.jsx';
import Policies from './pages/Policies.jsx';
import Alerts from './pages/Alerts.jsx';
import AuditLogs from './pages/AuditLogs.jsx';
import Enrollment from './pages/Enrollment.jsx';
import Users from './pages/Users.jsx';
import Manual from './pages/Manual.jsx';

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Overview />} />
        <Route path="devices" element={<Devices />} />
        <Route path="devices/:id" element={<DeviceDetail />} />
        <Route path="devices/:id/report" element={<DeviceReport />} />
        <Route path="policies" element={<Policies />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="audit" element={<AuditLogs />} />
        <Route path="enrollment" element={<Enrollment />} />
        <Route path="users" element={<Users />} />
        <Route path="manual" element={<Manual />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
