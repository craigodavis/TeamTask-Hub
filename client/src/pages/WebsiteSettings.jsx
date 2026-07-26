import React, { useState, useEffect } from 'react';
import { getWebsiteSettings, saveWebsiteSettings } from '../api';

export function WebsiteSettings() {
  const [count, setCount] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    getWebsiteSettings()
      .then((s) => setCount(String(s.events_list_count ?? 10)))
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true); setErr(''); setMsg('');
    try {
      const s = await saveWebsiteSettings({ events_list_count: Number(count) });
      setCount(String(s.events_list_count));
      setMsg('Saved. The website will reflect this within a minute.');
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '20px 24px 60px' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 4px' }}>Website Settings</h1>
      <p style={{ color: '#6b7280', margin: '0 0 24px', fontSize: '0.9rem' }}>
        Marketing → Website. These control how the public kindredvineyards.com site behaves.
      </p>

      {err && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '.86rem' }}>{err}</div>}
      {msg && <div style={{ background: '#dcfce7', color: '#166534', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '.86rem' }}>{msg}</div>}

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 22 }}>
        <label style={{ display: 'block', fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.05em', color: '#6b7280', marginBottom: 6 }}>
          Events shown per list
        </label>
        <input
          type="number" min="1" max="100" value={count}
          onChange={(e) => setCount(e.target.value)}
          style={{ width: 120, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '.95rem' }}
        />
        <p style={{ fontSize: '.78rem', color: '#9ca3af', margin: '8px 0 0' }}>
          How many upcoming events the Estate and Creek event pages show before “calendar view.” 1–100.
        </p>
      </div>

      <div style={{ marginTop: 20 }}>
        <button
          onClick={save} disabled={saving}
          style={{ background: '#111827', color: '#fff', border: 0, borderRadius: 8, padding: '10px 20px', fontSize: '.9rem', cursor: 'pointer', opacity: saving ? 0.5 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
