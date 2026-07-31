import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Manager } from './pages/Manager';
import { Policies } from './pages/Policies';
import { WasteEntry } from './pages/WasteEntry';
import { WasteList } from './pages/WasteList';
import { Settings } from './pages/Settings';
import { Quickbooks } from './pages/Quickbooks';
import { Square } from './pages/Square';
import { SquareReconcile } from './pages/SquareReconcile';
import { ResetPassword } from './pages/ResetPassword';
import { FoodLayout } from './pages/FoodLayout';
import { FoodIngredients } from './pages/FoodIngredients';
import { ShoppingLists } from './pages/ShoppingLists';
import ReportView from './pages/ReportView';
import { Products } from './pages/Products';
import { WineInventory } from './pages/WineInventory';
import { WineInventoryReport } from './pages/WineInventoryReport';
import { AbcFiling } from './pages/AbcFiling';
import { Loyalty } from './pages/Loyalty';
import { KindredApp } from './pages/KindredApp';
import Scheduling from './pages/Scheduling';
import ShiftFeedback from './pages/ShiftFeedback';
import Events from './pages/Events';
import { getGeneralSettings } from './api';
import { ProductDetail } from './pages/ProductDetail';
import { BettyComparison } from './pages/BettyComparison';
import { Gateway } from './pages/Gateway';
import { Skynet } from './pages/Skynet';
import { AppShell } from './components/AppShell';
import { appHubTitle } from './appHubTitle';
import { GroundControl } from './pages/GroundControl';
import { RecipesLayout } from './pages/RecipesLayout';
import { RecipesCatalog } from './pages/RecipesCatalog';
import { RecipesIngredients } from './pages/RecipesIngredients';
import { RecipesList } from './pages/RecipesList';
import { RecipeDetail } from './pages/RecipeDetail';
import { KitchenInventory } from './pages/KitchenInventory';
import { KitchenSources } from './pages/KitchenSources';
import { ScanReceipt } from './pages/ScanReceipt';
import { MediaLibrary } from './pages/MediaLibrary';
import { HoursEditor } from './pages/HoursEditor';
import { WebsiteImages } from './pages/WebsiteImages';
import { WebsiteSettings } from './pages/WebsiteSettings';

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
        // Load company timezone separately — a failure here (e.g. permissions,
        // transient error) must NEVER clear the auth token. Swallow its errors.
        getGeneralSettings()
          .then((settings) => { if (settings?.timezone) setTimezone(settings.timezone); })
          .catch(() => {});
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
      <Route path="/feedback/:token" element={<ShiftFeedback />} />
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={onLogin} />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<AuthGate user={user} />}>
        <Route element={<AppShellLayout user={user} onLogout={onLogout} timezone={timezone} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/manage" element={<Manager />} />
          <Route path="/scheduling" element={
            (user?.role === 'schedule' || user?.role === 'manager' || user?.role === 'owner')
              ? <Scheduling /> : <Navigate to="/" replace />} />
          <Route path="/events" element={
            (user?.role === 'schedule' || user?.role === 'manager' || user?.role === 'owner')
              ? <Events /> : <Navigate to="/" replace />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/food" element={<FoodLayout />}>
            <Route
              index
              element={
                <Navigate
                  to={(user?.role === 'inventory' || user?.role === 'manager' || user?.role === 'owner') ? 'lists' : 'waste'}
                  replace
                />
              }
            />
            <Route
              path="lists"
              element={
                (user?.role === 'inventory' || user?.role === 'manager' || user?.role === 'owner')
                  ? <ShoppingLists />
                  : <Navigate to="/food/waste" replace />
              }
            />
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
            path="/marketing/media"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <MediaLibrary />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/hours"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <HoursEditor />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/images"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <WebsiteImages />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/loyalty"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <Loyalty />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/settings"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <WebsiteSettings />
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
            path="/square/reconcile"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <SquareReconcile />
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
            path="/products/inventory"
            element={
              user?.role === 'owner' || user?.role === 'manager' || user?.role === 'inventory' ? (
                <WineInventory />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products/inventory/report"
            element={
              user?.role === 'owner' || user?.role === 'manager' || user?.role === 'inventory' ? (
                <WineInventoryReport />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/kindred-app"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <KindredApp />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/abc"
            element={
              user?.role === 'owner' || user?.role === 'manager' ? (
                <AbcFiling />
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
          <Route
            path="/recipes"
            element={
              user?.role === 'manager' || user?.role === 'owner' ? (
                <RecipesLayout />
              ) : (
                <Navigate to="/" replace />
              )
            }
          >
            <Route index element={<Navigate to="list" replace />} />
            <Route path="scan"        element={<ScanReceipt />} />
            <Route path="catalog"     element={<RecipesCatalog />} />
            <Route path="ingredients" element={<RecipesIngredients />} />
            <Route path="inventory"   element={<Navigate to="/kitchen/inventory" replace />} />
            <Route path="list"        element={<RecipesList />} />
            <Route path=":id"         element={<RecipeDetail />} />
          </Route>
          <Route
            path="/kitchen/inventory"
            element={
              (user?.role === 'inventory' || user?.role === 'manager' || user?.role === 'owner')
                ? <KitchenInventory />
                : <Navigate to="/" replace />
            }
          />
          <Route
            path="/kitchen/sources"
            element={
              user?.role === 'owner'
                ? <KitchenSources />
                : <Navigate to="/" replace />
            }
          />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
    </Routes>
  );
}

export default App;
