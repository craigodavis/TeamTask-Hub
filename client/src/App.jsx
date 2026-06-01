import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Manager } from './pages/Manager';
import { WasteEntry } from './pages/WasteEntry';
import { WasteList } from './pages/WasteList';
import { Settings } from './pages/Settings';
import { Quickbooks } from './pages/Quickbooks';
import { Square } from './pages/Square';
import { ResetPassword } from './pages/ResetPassword';
import { FoodLayout } from './pages/FoodLayout';
import { FoodIngredients } from './pages/FoodIngredients';
import { ShoppingInventory } from './pages/ShoppingInventory';
import { ShoppingCatalog } from './pages/ShoppingCatalog';
import ReportView from './pages/ReportView';
import { Products } from './pages/Products';
import { getGeneralSettings } from './api';
import { ProductDetail } from './pages/ProductDetail';
import { BettyComparison } from './pages/BettyComparison';
import { Gateway } from './pages/Gateway';
import { Skynet } from './pages/Skynet';
import { AppShell } from './components/AppShell';
import { appHubTitle } from './appHubTitle';
import { GroundControl } from './pages/GroundControl';

function LegacyWasteEntryRedirect() {
  const { entryId } = useParams();
  return <Navigate to={`/food/waste/${entryId}`} replace />;
}

function AuthGate({ user }) {
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function AppShellLayout({ user, onLogout, timezone }) {
  const [emulateRole, setEmulateRole] = useState(null);
  const [availableRoles, setAvailableRoles] = useState([]);
  return (
    <AppShell
      user={user}
      onLogout={onLogout}
      emulateRole={emulateRole}
      setEmulateRole={setEmulateRole}
      availableRoles={availableRoles}
    >
      <Outlet context={{ user, onLogout, emulateRole, setEmulateRole, availableRoles, setAvailableRoles, timezone }} />
    </AppShell>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [timezone, setTimezone] = useState('America/Denver');
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
      .then((data) => {
        setUser(data.user);
        // Load company timezone immediately after auth
        return getGeneralSettings();
      })
      .then((settings) => {
        if (settings?.timezone) setTimezone(settings.timezone);
      })
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
      {/* Public routes — no auth required */}
      <Route path="/r/:token" element={<ReportView />} />
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={onLogin} />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<AuthGate user={user} />}>
        <Route element={<AppShellLayout user={user} onLogout={onLogout} timezone={timezone} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/manage" element={<Manager />} />
          <Route path="/food" element={<FoodLayout />}>
            <Route index element={<Navigate to="inventory" replace />} />
            <Route path="inventory" element={<ShoppingInventory />} />
            <Route path="catalog" element={<ShoppingCatalog />} />
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
              user?.role === 'owner' || user?.role === 'manager' ? (
                <Quickbooks user={user} />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/square"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <Square />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <Products />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products/new"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <ProductDetail />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products/:id"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <ProductDetail />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/betty"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <BettyComparison />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/gateway"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <Gateway />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/skynet"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <Skynet />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/ground-control"
            element={
              user?.role === 'gc' || user?.role === 'manager' || user?.role === 'owner' ? (
                <GroundControl />
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
