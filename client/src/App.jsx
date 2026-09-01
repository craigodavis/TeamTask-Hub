import React, { useState, useEffect } from 'react';
import { can } from './utils/can';
import { Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Manager } from './pages/Manager';
import { Policies } from './pages/Policies';
import Crew from './pages/Crew';
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
import { Overview } from './pages/Overview';
import { Campaigns } from './pages/Campaigns';
import { Menus } from './pages/Menus';
import Reservations from './pages/Reservations';
import EventRequests from './pages/EventRequests';
import { Loyalty } from './pages/Loyalty';
import { KindredApp } from './pages/KindredApp';
import Scheduling from './pages/Scheduling';
import ShiftFeedback from './pages/ShiftFeedback';
import Events from './pages/Events';
import { getGeneralSettings } from './api';
import { ProductDetail } from './pages/ProductDetail';
import { ProductLines } from './pages/ProductLines';
import { ProductLineDetail } from './pages/ProductLineDetail';
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
import { MediaHub } from './pages/MediaHub';
import { HoursEditor } from './pages/HoursEditor';
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
          {/* Anyone who can see the overview lands there; everyone else keeps
              the task list. Dashboard.jsx is that task list despite its name.
              Keyed off the same capability that guards /dashboard, so the
              landing page can never send someone where they are bounced out. */}
          <Route
            path="/"
            element={
              can(user, 'dashboard.view')
                ? <Navigate to="/dashboard" replace />
                : <Dashboard />
            }
          />
          <Route path="/tasks" element={<Dashboard />} />
          <Route
            path="/marketing/campaigns"
            element={
              can(user, 'marketing.campaigns')
                ? <Campaigns /> : <Navigate to="/" replace />
            }
          />
          <Route
            path="/tasting-room/menus"
            element={
              can(user, 'tastingroom.menus') ? (
                <Menus />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/tasting-room/reservations"
            element={
              can(user, 'tastingroom.reservations') ? (
                <Reservations />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/dashboard"
            element={
              can(user, 'dashboard.view') ? (
                <Overview />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route path="/manage" element={<Manager />} />
          <Route path="/scheduling" element={
            can(user, 'scheduling.manage')
              ? <Scheduling /> : <Navigate to="/" replace />} />
          <Route path="/events" element={
            can(user, 'marketing.events')
              ? <Events /> : <Navigate to="/" replace />} />
          <Route
            path="/marketing/event-requests"
            element={
              user?.role === 'owner' || user?.role === 'manager'
                ? <EventRequests /> : <Navigate to="/" replace />
            }
          />
          <Route path="/policies" element={<Policies />} />
          {/* Open to every signed-in user — the server decides what you may edit
              by whose profile it is, not by role. No ternary here on purpose. */}
          <Route path="/crew" element={<Crew />} />
          <Route path="/food" element={<FoodLayout />}>
            <Route
              index
              element={
                <Navigate
                  to={can(user, 'kitchen.inventory') ? 'lists' : 'waste'}
                  replace
                />
              }
            />
            <Route
              path="lists"
              element={
                can(user, 'kitchen.inventory')
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
              can(user, 'users.assist') ? (
                <Settings />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/media"
            element={
              can(user, 'marketing.media') ? (
                <MediaHub />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/hours"
            element={
              can(user, 'marketing.hours') ? (
                <HoursEditor />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/images"
            element={
              can(user, 'marketing.media') ? (
                <MediaHub initialTab="pages" />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/loyalty"
            element={
              can(user, 'marketing.loyalty') ? (
                <Loyalty />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/marketing/settings"
            element={
              can(user, 'marketing.website') ? (
                <WebsiteSettings />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/quickbooks"
            element={
              can(user, 'kitchen.receipts') ? (
                <Quickbooks user={user} />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/square"
            element={
              can(user, 'ai.use') ? (
                <Square />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/square/reconcile"
            element={
              can(user, 'ai.use') ? (
                <SquareReconcile />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/product-lines"
            element={
              can(user, 'wine.lines') ? (
                <ProductLines />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/product-lines/new"
            element={
              can(user, 'wine.lines') ? (
                <ProductLineDetail />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/product-lines/:id"
            element={
              can(user, 'wine.lines') ? (
                <ProductLineDetail />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products"
            element={
              can(user, 'wine.products') ? (
                <Products />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products/new"
            element={
              can(user, 'wine.products') ? (
                <ProductDetail />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products/:id"
            element={
              can(user, 'wine.products') ? (
                <ProductDetail />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products/inventory"
            element={
              can(user, 'wine.inventory') ? (
                <WineInventory />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/products/inventory/report"
            element={
              can(user, 'wine.reports') ? (
                <WineInventoryReport />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/kindred-app"
            element={
              can(user, 'kindredapp.manage') ? (
                <KindredApp />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/abc"
            element={
              can(user, 'reports.operational') ? (
                <AbcFiling />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/betty"
            element={
              can(user, 'betty.use') ? (
                <BettyComparison />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/gateway"
            element={
              can(user, 'gateway.use') ? (
                <Gateway />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/skynet"
            element={
              can(user, 'skynet.view') ? (
                <Skynet />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/ground-control"
            element={
              can(user, 'groundcontrol.use') ? (
                <GroundControl />
              ) : (
                <Navigate to="/" replace />
              )
            }
          />
          <Route
            path="/recipes"
            element={
              can(user, 'kitchen.recipes') ? (
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
              can(user, 'kitchen.inventory')
                ? <KitchenInventory />
                : <Navigate to="/" replace />
            }
          />
          <Route
            path="/kitchen/sources"
            element={
              can(user, 'kitchen.receipt_sources')
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
