import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Manager } from './pages/Manager';
import { WasteEntry } from './pages/WasteEntry';
import { WasteList } from './pages/WasteList';
import { Settings } from './pages/Settings';
import { SyncUsers } from './pages/SyncUsers';
import { ResetPassword } from './pages/ResetPassword';

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

  if (loading) return <div className="app-loading">Loading…</div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login onLogin={onLogin} />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/" element={user ? <Dashboard user={user} onLogout={onLogout} /> : <Navigate to="/login" replace />} />
      <Route path="/manage" element={user ? <Manager user={user} onLogout={onLogout} /> : <Navigate to="/login" replace />} />
      <Route path="/sync-users" element={user ? <SyncUsers user={user} onLogout={onLogout} /> : <Navigate to="/login" replace />} />
      <Route path="/settings" element={user?.role === 'owner' ? <Settings user={user} onLogout={onLogout} /> : user ? <Navigate to="/" replace /> : <Navigate to="/login" replace />} />
      <Route path="/waste" element={user ? <WasteList user={user} /> : <Navigate to="/login" replace />} />
      <Route path="/waste/:entryId" element={user ? <WasteEntry user={user} /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
    </Routes>
  );
}

export default App;
