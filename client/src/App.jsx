import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Manager } from './pages/Manager';
import { WasteEntry } from './pages/WasteEntry';
import { WasteList } from './pages/WasteList';
import { Settings } from './pages/Settings';
import { Quickbooks } from './pages/Quickbooks';
import { ResetPassword } from './pages/ResetPassword';
import { FoodLayout } from './pages/FoodLayout';
import { FoodIngredients } from './pages/FoodIngredients';
import { AppShell } from './components/AppShell';
import { appHubTitle } from './appHubTitle';

function LegacyWasteEntryRedirect() {
  const { entryId } = useParams();
  return <Navigate to={`/food/waste/${entryId}`} replace />;
}

function AuthGate({ user }) {
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function AppShellLayout({ user, onLogout }) {
  return (
    <AppShell user={user} onLogout={onLogout}>
      <Outlet context={{ user, onLogout }} />
    </AppShell>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('teamtask_token');
    if (!token) {
      setLoading(false);
      return;
    }
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => setUser(data.user))
      .catch(() => localStorage.removeItem('teamtask_token'))
      .finally(() => setLoading(false));
  }, []);

  const onLogin = (u) => setUser(u);
  const onLogout = () => {
    localStorage.removeItem('teamtask_token');
    setUser(null);
  };

  useEffect(() => {
    document.title = appHubTitle(user);
  }, [user]);

  if (loading) return <div className="app-loading">Loading…</div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={onLogin} />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<AuthGate user={user} />}>
        <Route element={<AppShellLayout user={user} onLogout={onLogout} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/manage" element={<Manager />} />
          <Route path="/food" element={<FoodLayout />}>
            <Route index element={<Navigate to="waste" replace />} />
            <Route path="ingredients" element={<FoodIngredients />} />
            <Route path="waste" element={<WasteList />} />
            <Route path="waste/:entryId" element={<WasteEntry />} />
          </Route>
          <Route path="/waste" element={<Navigate to="/food/waste" replace />} />
          <Route path="/waste/:entryId" element={<LegacyWasteEntryRedirect />} />
          <Route path="/sync-users" element={<Navigate to="/settings?tab=square" replace />} />
          <Route
            path="/settings"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <Settings />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/quickbooks"
            element={
              user?.role === 'owner' ? (
                <Quickbooks user={user} />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
    </Routes>
  );
}

export default App;
