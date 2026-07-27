import React, { useState, useEffect } from 'react';
import { getWebsiteSettings, saveWebsiteSettings, getReservationConfig, saveReservationConfig, testReservationConfig } from '../api';

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

      <ReservationsConfig />
    </div>
  );
}

function ReservationsConfig() {
  const [venues, setVenues] = useState(null);
  const [err, setErr] = useState('');

  const load = () => getReservationConfig().then((d) => setVenues(d.venues)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <div style={{ marginTop: 40, color: '#991b1b' }}>{err}</div>;
  if (!venues) return null;

  return (
    <div style={{ marginTop: 44 }}>
      <h2 style={{ fontSize: '1.15rem', margin: '0 0 4px' }}>Reservations (ResOS)</h2>
      <p style={{ color: '#6b7280', margin: '0 0 18px', fontSize: '0.86rem' }}>
        Each venue books through its own ResOS restaurant, so each needs its own API key
        (ResOS → Settings → Integrations → API). The key stays in Team and powers the website's booking.
      </p>
      {venues.map((v) => <VenueResos key={v.venue} v={v} onChanged={load} />)}
    </div>
  );
}

function VenueResos({ v, onChanged }) {
  const [key, setKey] = useState('');
  const [slot, setSlot] = useState(String(v.slot_minutes || 90));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [test, setTest] = useState(null);

  const save = async () => {
    setBusy(true); setMsg(''); setTest(null);
    try {
      await saveReservationConfig(v.venue, { api_key: key || undefined, slot_minutes: Number(slot) });
      setKey('');
      setMsg('Saved.');
      onChanged();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const runTest = async () => {
    setBusy(true); setTest(null); setMsg('');
    try { setTest(await testReservationConfig(v.venue)); }
    catch (e) { setTest({ ok: false, message: e.message }); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ fontSize: '.98rem' }}>{v.name}</strong>
        <span style={{ fontSize: '.75rem', color: v.configured ? '#166534' : '#9ca3af' }}>
          {v.configured ? `key set ••••${v.key_last4}` : 'no key yet'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <input
          type="password" value={key} onChange={(e) => setKey(e.target.value)}
          placeholder={v.configured ? 'Enter a new key to replace' : 'Paste ResOS API key'}
          style={{ flex: 1, minWidth: 220, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '.88rem' }}
        />
        <input
          type="number" min="15" max="240" value={slot} onChange={(e) => setSlot(e.target.value)}
          title="Booking length (minutes) used for availability" style={{ width: 90, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
        <button onClick={save} disabled={busy} style={{ background: '#111827', color: '#fff', border: 0, borderRadius: 8, padding: '8px 16px', fontSize: '.85rem', cursor: 'pointer' }}>Save</button>
        <button onClick={runTest} disabled={busy || !v.configured} style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 16px', fontSize: '.85rem', cursor: 'pointer' }}>Test connection</button>
        {msg && <span style={{ fontSize: '.82rem', color: '#6b7280' }}>{msg}</span>}
        {test && <span style={{ fontSize: '.82rem', color: test.ok ? '#166534' : '#991b1b' }}>{test.ok ? '✓ Connected to ResOS' : `✗ ${test.message || 'Failed'}`}</span>}
      </div>
      <p style={{ fontSize: '.72rem', color: '#9ca3af', margin: '10px 0 0' }}>Booking length: {slot} min (used to check table availability).</p>
    </div>
  );
}
