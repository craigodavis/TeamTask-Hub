import React, { useState, useEffect } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { getIntegrationSettings, putIntegrationSettings, testSquareConnection, testTwilioConnection, testMail, getLocations, createLocation, updateLocation, deleteLocation, getQBOConnectUrl, disconnectQBO, getGeneralSettings, patchGeneralSettings, getC7Settings, putC7Settings, testC7Connection, getSquareEmployees, getAmazonSettings, putAmazonSettings, testAmazonLogin } from '../api';
import { SquareUsersPanel } from '../components/SquareUsersPanel';
import { SquareSyncPanel } from '../components/SquareSyncPanel';
import { Commerce7SyncPanel } from '../components/Commerce7SyncPanel';
import './Settings.css';

const OWNER_TABS = ['general', 'integrations', 'square', 'commerce7'];

// Common IANA timezone list — covers all US zones plus a broad international set
const TIMEZONES = [
  { group: 'United States',  zones: [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Phoenix',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
  ]},
  { group: 'Canada', zones: [
    'America/Toronto',
    'America/Vancouver',
    'America/Winnipeg',
    'America/Halifax',
  ]},
  { group: 'Europe', zones: [
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Amsterdam',
    'Europe/Rome',
    'Europe/Madrid',
    'Europe/Zurich',
    'Europe/Stockholm',
    'Europe/Helsinki',
    'Europe/Athens',
    'Europe/Istanbul',
  ]},
  { group: 'Asia / Pacific', zones: [
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Bangkok',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Asia/Seoul',
    'Asia/Shanghai',
    'Australia/Sydney',
    'Australia/Melbourne',
    'Pacific/Auckland',
  ]},
  { group: 'Other', zones: [
    'UTC',
    'America/Sao_Paulo',
    'America/Mexico_City',
    'America/Buenos_Aires',
    'Africa/Johannesburg',
    'Africa/Nairobi',
  ]},
];

function tzLabel(tz) {
  // e.g. "America/Los_Angeles" → "Los Angeles"
  // Show offset too so users can orient themselves
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    });
    const parts = formatter.formatToParts(now);
    const abbr = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    const name = tz.split('/').pop().replace(/_/g, ' ');
    return abbr ? `${name} (${abbr})` : name;
  } catch {
    return tz;
  }
}

function GeneralSettingsPanel({ timezone, opsManagerName, onSave, saving }) {
  const [localTz, setLocalTz] = useState(timezone);
  const [localManager, setLocalManager] = useState(opsManagerName || '');
  const [employees, setEmployees] = useState([]);
  const [empLoading, setEmpLoading] = useState(true);

  useEffect(() => { setLocalTz(timezone); }, [timezone]);
  useEffect(() => { setLocalManager(opsManagerName || ''); }, [opsManagerName]);

  useEffect(() => {
    getSquareEmployees()
      .then((d) => setEmployees(d.employees || []))
      .catch(() => setEmployees([]))
      .finally(() => setEmpLoading(false));
  }, []);

  const handleSave = (e) => {
    e.preventDefault();
    onSave({ timezone: localTz, ops_manager_name: localManager || null });
  };

  return (
    <div>
      <p className="settings-intro">
        General settings for this company. The timezone is used for scheduled report queries — <code>now()</code> and date expressions will be evaluated in this timezone.
      </p>
      <form onSubmit={handleSave} className="settings-form">
        <fieldset>
          <legend>Regional</legend>
          <label>
            Timezone
            <select value={localTz} onChange={(e) => setLocalTz(e.target.value)}>
              {TIMEZONES.map(({ group, zones }) => (
                <optgroup key={group} label={group}>
                  {zones.map((tz) => (
                    <option key={tz} value={tz}>{tzLabel(tz)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <small>Used by scheduled report date parameters (e.g. <code>now()</code>, <code>date_trunc('month', now())</code>).</small>
          </label>
        </fieldset>
        <fieldset>
          <legend>Operations</legend>
          <label>
            Ops Manager
            <select
              value={localManager}
              onChange={(e) => setLocalManager(e.target.value)}
              disabled={empLoading}
            >
              <option value="">— None —</option>
              {employees.map((emp) => (
                <option key={emp.full_name} value={emp.full_name}>{emp.full_name}</option>
              ))}
            </select>
            <small>Shown in task-completion SMS when not all tasks are finished.</small>
          </label>
        </fieldset>
        <div className="settings-actions">
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

export function Settings() {
  const { user } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const isOwner = user?.role === 'owner';
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const tab = (() => {
    if (!isOwner) return 'square';
    if (!tabParam) return 'general';
    return OWNER_TABS.includes(tabParam) ? tabParam : 'general';
  })();

  const setSettingsTab = (next) => {
    setSearchParams({ tab: next }, { replace: true });
  };
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(() => user?.role === 'owner');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [squareApplicationId, setSquareApplicationId] = useState('');
  const [squareAccessToken, setSquareAccessToken] = useState('');
  const [squareEnv, setSquareEnv] = useState('production');
  const [twilioAccountSid, setTwilioAccountSid] = useState('');
  const [twilioAuthToken, setTwilioAuthToken] = useState('');
  const [twilioPhoneNumber, setTwilioPhoneNumber] = useState('');
  const [testingSquare, setTestingSquare] = useState(false);
  const [squareTestResult, setSquareTestResult] = useState(null);
  const [testingTwilio, setTestingTwilio] = useState(false);
  const [twilioTestResult, setTwilioTestResult] = useState(null);
  const [testingMail, setTestingMail] = useState(false);
  const [mailTestResult, setMailTestResult] = useState(null);
  const [qboConnecting, setQboConnecting] = useState(false);
  const [qboDisconnecting, setQboDisconnecting] = useState(false);

  const [mailHost, setMailHost] = useState('');
  const [mailPort, setMailPort] = useState('');
  const [mailUser, setMailUser] = useState('');
  const [mailPass, setMailPass] = useState('');
  const [mailFrom, setMailFrom] = useState('');
  const [mailSecure, setMailSecure] = useState(false);

  const [locations, setLocations] = useState([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [newLocationName, setNewLocationName] = useState('');
  const [editingLocationId, setEditingLocationId] = useState(null);
  const [editingLocationName, setEditingLocationName] = useState('');

  const [timezone, setTimezone] = useState('UTC');
  const [opsManagerName, setOpsManagerName] = useState(null);
  const [generalSaving, setGeneralSaving] = useState(false);

  // Service tokens
  const [serviceTokens, setServiceTokens]     = useState([]);
  const [newTokenName, setNewTokenName]       = useState('');
  const [newTokenRole, setNewTokenRole]       = useState('manager');
  const [createdToken, setCreatedToken]       = useState(null); // shown once after creation
  const [tokenCreating, setTokenCreating]     = useState(false);

  // Commerce7
  const [c7Settings, setC7Settings]           = useState(null);
  const [c7TenantSlug, setC7TenantSlug]       = useState('');
  const [c7TenantId, setC7TenantId]           = useState('');
  const [c7ApiBaseUrl, setC7ApiBaseUrl]       = useState('');
  const [c7ApiKey, setC7ApiKey]               = useState('');
  const [c7Saving, setC7Saving]               = useState(false);
  const [c7Testing, setC7Testing]             = useState(false);
  const [c7TestResult, setC7TestResult]       = useState('');

  // Amazon Business
  const [amazonSettings, setAmazonSettings]   = useState(null);
  const [amazonEmail, setAmazonEmail]         = useState('');
  const [amazonPassword, setAmazonPassword]   = useState('');
  const [amazonSaving, setAmazonSaving]       = useState(false);
  const [amazonTesting, setAmazonTesting]     = useState(false);
  const [amazonTestResult, setAmazonTestResult] = useState('');

  useEffect(() => {
    // Managers can only see the square tab; owners see all tabs
    if (!isOwner && isManager && tabParam && tabParam !== 'square') {
      setSearchParams({ tab: 'square' }, { replace: true });
    }
    // Redirect stale links to removed tabs → general
    if (isOwner && (tabParam === 'mail' || tabParam === 'locations')) {
      setSearchParams({ tab: 'general' }, { replace: true });
    }
  }, [isOwner, isManager, tabParam, setSearchParams]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('qbo_connected')) {
      setMessage('QuickBooks connected successfully.');
      window.history.replaceState({}, '', '/settings');
    } else if (params.get('qbo_error')) {
      setError(`QuickBooks connection failed: ${params.get('qbo_error')}`);
      window.history.replaceState({}, '', '/settings');
    }
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    loadLocations();
    Promise.all([
      getIntegrationSettings(),
      getGeneralSettings(),
      getC7Settings(),
      getAmazonSettings(),
    ])
      .then(([r, g, c7, amz]) => {
        setSettings(r);
        setSquareApplicationId(r.square_application_id || '');
        setSquareEnv(r.square_env || 'production');
        setTwilioPhoneNumber(r.twilio_phone_number || '');
        setMailHost(r.mail_host || '');
        setMailPort(r.mail_port != null ? String(r.mail_port) : '');
        setMailUser(r.mail_user || '');
        setMailFrom(r.mail_from || '');
        setMailSecure(r.mail_secure || false);
        setTimezone(g.timezone || 'UTC');
        setOpsManagerName(g.ops_manager_name || null);
        setC7Settings(c7);
        setC7TenantSlug(c7.c7_tenant_slug || '');
        setC7TenantId(c7.c7_tenant_id || '');
        setC7ApiBaseUrl(c7.c7_api_base_url || '');
        setAmazonSettings(amz);
        setAmazonEmail(amz.amazon_email || '');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [isOwner]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setSaving(true);
    try {
      const body = {
        square_env: squareEnv,
        twilio_phone_number: twilioPhoneNumber.trim() || undefined,
      };
      if (squareApplicationId.trim()) body.square_application_id = squareApplicationId.trim();
      if (squareAccessToken.trim()) body.square_access_token = squareAccessToken.trim();
      if (twilioAccountSid.trim()) body.twilio_account_sid = twilioAccountSid.trim();
      if (twilioAuthToken.trim()) body.twilio_auth_token = twilioAuthToken.trim();
      await putIntegrationSettings(body);
      setMessage('Settings saved.');
      setSquareAccessToken('');
      setTwilioAccountSid('');
      setTwilioAuthToken('');
      getIntegrationSettings()
        .then((r) => {
          setSettings(r);
          setSquareApplicationId(r.square_application_id || '');
        })
        .catch((e) => setError(e.message || 'Failed to reload settings'));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTestSquare = async () => {
    setSquareTestResult(null);
    setError('');
    setTestingSquare(true);
    try {
      const body = {};
      if (squareAccessToken.trim()) body.square_access_token = squareAccessToken.trim();
      if (squareEnv) body.square_env = squareEnv;
      const r = await testSquareConnection(body);
      setSquareTestResult(r.ok ? (r.message || 'Connected.') : (r.error || 'Unknown'));
    } catch (e) {
      setSquareTestResult(null);
      setError(e.message);
    } finally {
      setTestingSquare(false);
    }
  };

  const handleTestTwilio = async () => {
    setTwilioTestResult(null);
    setError('');
    setTestingTwilio(true);
    try {
      const body = {};
      if (twilioAccountSid.trim()) body.twilio_account_sid = twilioAccountSid.trim();
      if (twilioAuthToken.trim()) body.twilio_auth_token = twilioAuthToken.trim();
      const r = await testTwilioConnection(body);
      const extra = r.friendly_name ? ` (${r.friendly_name})` : '';
      setTwilioTestResult(r.ok ? `${r.message || 'Connected.'}${extra}` : (r.error || 'Unknown'));
    } catch (e) {
      setTwilioTestResult(null);
      setError(e.message);
    } finally {
      setTestingTwilio(false);
    }
  };

  const handleQBOConnect = async () => {
    setQboConnecting(true);
    setError('');
    try {
      const { url } = await getQBOConnectUrl();
      window.location.href = url;
    } catch (e) {
      setError(e.message);
      setQboConnecting(false);
    }
  };

  const handleQBODisconnect = async () => {
    if (!window.confirm('Disconnect QuickBooks Online? This will remove stored tokens for this company.')) return;
    setQboDisconnecting(true);
    setError('');
    try {
      await disconnectQBO();
      setMessage('QuickBooks disconnected.');
      getIntegrationSettings().then((r) => setSettings(r)).catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setQboDisconnecting(false);
    }
  };

  // ── Service token handlers ────────────────────────────────────────────────
  const loadServiceTokens = async () => {
    try {
      const r = await fetch('/api/service-tokens', { headers: { Authorization: `Bearer ${localStorage.getItem('teamtask_token')}` } });
      const d = await r.json();
      setServiceTokens(d.tokens || []);
    } catch (_) {}
  };

  useEffect(() => { if (isOwner && tab === 'integrations') loadServiceTokens(); }, [tab]);

  const handleCreateToken = async (e) => {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    setTokenCreating(true);
    setCreatedToken(null);
    try {
      const r = await fetch('/api/service-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('teamtask_token')}` },
        body: JSON.stringify({ name: newTokenName.trim(), role: newTokenRole }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setCreatedToken(d.token.raw);
      setNewTokenName('');
      loadServiceTokens();
    } catch (e) {
      setError(e.message);
    } finally {
      setTokenCreating(false);
    }
  };

  const handleRevokeToken = async (id, name) => {
    if (!window.confirm(`Revoke token "${name}"? Any agent using it will immediately lose access.`)) return;
    try {
      await fetch(`/api/service-tokens/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('teamtask_token')}` },
      });
      setServiceTokens((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e.message);
    }
  };

  const handleMailSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setSaving(true);
    try {
      const body = {
        mail_host: mailHost.trim() || undefined,
        mail_port: mailPort !== '' ? (parseInt(mailPort, 10) || undefined) : undefined,
        mail_user: mailUser.trim() || undefined,
        mail_from: mailFrom.trim() || undefined,
        mail_secure: mailSecure,
      };
      if (mailPass.trim()) body.mail_pass = mailPass.trim();
      await putIntegrationSettings(body);
      setMessage('Mail settings saved.');
      setMailPass('');
      getIntegrationSettings().then((r) => {
        setSettings(r);
        setMailHost(r.mail_host || '');
        setMailPort(r.mail_port != null ? String(r.mail_port) : '');
        setMailUser(r.mail_user || '');
        setMailFrom(r.mail_from || '');
        setMailSecure(r.mail_secure || false);
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTestMail = async () => {
    setMailTestResult(null);
    setError('');
    setTestingMail(true);
    try {
      const r = await testMail();
      setMailTestResult(r.ok ? (r.message || 'Sent.') : (r.error || 'Unknown'));
    } catch (e) {
      setMailTestResult(null);
      setError(e.message);
    } finally {
      setTestingMail(false);
    }
  };

  const loadLocations = () => {
    setLocationsLoading(true);
    setError('');
    getLocations()
      .then((r) => setLocations(r.locations || []))
      .catch((e) => setError(e.message))
      .finally(() => setLocationsLoading(false));
  };

  const handleAddLocation = async (e) => {
    e.preventDefault();
    const name = newLocationName.trim();
    if (!name) return;
    setError('');
    setSaving(true);
    try {
      await createLocation(name);
      setNewLocationName('');
      loadLocations();
      setMessage('Location added.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateLocation = async (e) => {
    e.preventDefault();
    if (!editingLocationId) return;
    const name = editingLocationName.trim();
    if (!name) return;
    setError('');
    setSaving(true);
    try {
      await updateLocation(editingLocationId, { name });
      setEditingLocationId(null);
      setEditingLocationName('');
      loadLocations();
      setMessage('Location updated.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteLocation = async (id) => {
    if (!window.confirm('Delete this location? Users, announcements, and templates will no longer be assigned to it.')) return;
    setError('');
    setSaving(true);
    try {
      await deleteLocation(id);
      setEditingLocationId(null);
      setEditingLocationName('');
      loadLocations();
      setMessage('Location deleted.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!isManager) {
    return (
      <div className="settings-page">
        <p>Manager or owner access required.</p>
        <Link to="/">Back to dashboard</Link>
      </div>
    );
  }

  if (isOwner && loading) return <div className="settings-page"><p>Loading…</p></div>;

  return (
    <div className="settings-page">
      <h1 className="settings-page-title">Settings</h1>
      <nav className="settings-tabs" aria-label="Settings sections">
        {isOwner && (
          <>
            <button type="button" className={tab === 'general' ? 'active' : ''} onClick={() => setSettingsTab('general')}>General</button>
            <button type="button" className={tab === 'integrations' ? 'active' : ''} onClick={() => setSettingsTab('integrations')}>Integrations</button>
          </>
        )}
        <button type="button" className={tab === 'square' ? 'active' : ''} onClick={() => setSettingsTab('square')}>Square</button>
        {isOwner && (
          <button type="button" className={tab === 'commerce7' ? 'active' : ''} onClick={() => setSettingsTab('commerce7')}>Commerce7</button>
        )}
      </nav>
      {error && <p className="settings-error">{error}</p>}
      {message && <p className="settings-message">{message}</p>}

      {tab === 'general' && (
        <>
          <GeneralSettingsPanel
            timezone={timezone}
            opsManagerName={opsManagerName}
            saving={generalSaving}
            onSave={async ({ timezone: tz, ops_manager_name }) => {
              setGeneralSaving(true);
              setError('');
              setMessage('');
              try {
                await patchGeneralSettings({ timezone: tz, ops_manager_name });
                setTimezone(tz);
                setOpsManagerName(ops_manager_name || null);
                setMessage('Settings saved.');
              } catch (e) {
                setError(e.message);
              } finally {
                setGeneralSaving(false);
              }
            }}
          />

          {/* ── Locations ────────────────────────────────────────── */}
          <fieldset style={{ marginTop: '2rem' }}>
            <legend>Locations</legend>
            <p style={{ margin: '0 0 0.75rem', color: '#666', fontSize: '0.9em' }}>
              Assign users, announcements, and task templates to one or many locations from the Manager page.
            </p>
            <form onSubmit={handleAddLocation} className="settings-form" style={{ marginBottom: '1rem' }}>
              <label>
                New location
                <input
                  type="text"
                  placeholder="Location name"
                  value={newLocationName}
                  onChange={(e) => setNewLocationName(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <button type="submit" disabled={saving || !newLocationName.trim()}>{saving ? 'Adding…' : 'Add location'}</button>
            </form>
            {locationsLoading ? (
              <p>Loading locations…</p>
            ) : locations.length === 0 ? (
              <p className="empty">No locations yet. Add one above.</p>
            ) : (
              <ul className="settings-list">
                {locations.map((loc) => (
                  <li key={loc.id}>
                    {editingLocationId === loc.id ? (
                      <form onSubmit={handleUpdateLocation} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <input
                          type="text"
                          value={editingLocationName}
                          onChange={(e) => setEditingLocationName(e.target.value)}
                          autoFocus
                          autoComplete="off"
                        />
                        <button type="submit" disabled={saving}>Save</button>
                        <button type="button" onClick={() => { setEditingLocationId(null); setEditingLocationName(''); }}>Cancel</button>
                      </form>
                    ) : (
                      <>
                        <span>{loc.name}</span>
                        <button type="button" onClick={() => { setEditingLocationId(loc.id); setEditingLocationName(loc.name); }}>Edit</button>
                        <button type="button" onClick={() => handleDeleteLocation(loc.id)}>Delete</button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </>
      )}

      {tab === 'integrations' && (
        <>
          <p className="settings-intro">Configure API credentials for Square, Twilio, and Commerce7. Values are stored per company. Leave a field blank to keep the current value.</p>
          <p className="settings-help">Square: get an <strong>access token</strong> from the <a href="https://developer.squareup.com/apps" target="_blank" rel="noopener noreferrer">Square Developer Dashboard</a> (Open your app → Credentials → Access token). Use <strong>sandbox</strong> for testing.</p>
          <form onSubmit={handleSubmit} className="settings-form">
            <fieldset>
              <legend>Square</legend>
          <label>
            Application ID
            <input
              type="text"
              placeholder="Square Application ID (from your app)"
              value={squareApplicationId}
              onChange={(e) => setSquareApplicationId(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Access token
            <input
              type="password"
              placeholder={settings?.square_configured ? 'Leave blank to keep current' : 'Square access token'}
              value={squareAccessToken}
              onChange={(e) => setSquareAccessToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Environment
            <select value={squareEnv} onChange={(e) => setSquareEnv(e.target.value)}>
              <option value="production">production</option>
              <option value="sandbox">sandbox</option>
            </select>
          </label>
          <button type="button" className="btn-test" onClick={handleTestSquare} disabled={testingSquare || (!settings?.square_configured && !squareAccessToken.trim())} title="Test using saved token or the token entered above">
            {testingSquare ? 'Testing…' : 'Test Square connection'}
          </button>
          {squareTestResult && <p className="test-result success">{squareTestResult}</p>}
        </fieldset>
        <fieldset>
          <legend>Twilio</legend>
          <label>
            Account SID
            <input
              type="password"
              placeholder={settings?.twilio_api_configured ? 'Leave blank to keep current' : 'Twilio Account SID'}
              value={twilioAccountSid}
              onChange={(e) => setTwilioAccountSid(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Auth token
            <input
              type="password"
              placeholder={settings?.twilio_api_configured ? 'Leave blank to keep current' : 'Twilio Auth Token'}
              value={twilioAuthToken}
              onChange={(e) => setTwilioAuthToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Phone number (from)
            <input
              type="text"
              placeholder="E.164 e.g. +15551234567"
              value={twilioPhoneNumber}
              onChange={(e) => setTwilioPhoneNumber(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn-test"
            onClick={handleTestTwilio}
            disabled={
              testingTwilio ||
              (!settings?.twilio_api_configured &&
                (!twilioAccountSid.trim() || !twilioAuthToken.trim()))
            }
            title="Test using saved credentials or the SID and token entered above"
          >
            {testingTwilio ? 'Testing…' : 'Test Twilio connection'}
          </button>
          {twilioTestResult && <p className="test-result success">{twilioTestResult}</p>}
        </fieldset>
            <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </form>

          {/* ── Commerce7 credentials ─────────────────────────────── */}
          <fieldset style={{ marginTop: '1.5rem' }}>
            <legend>Commerce7</legend>
            <p style={{ margin: '0 0 0.75rem', color: '#666', fontSize: '0.9em' }}>
              API credentials for Commerce7. The key is stored securely and never returned after saving.
              Sync schedules and records are managed in the <strong>Commerce7</strong> tab.
            </p>
            <form
              className="settings-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setC7Saving(true); setError(''); setMessage(''); setC7TestResult('');
                try {
                  const body = {
                    c7_tenant_slug:  c7TenantSlug.trim()  || undefined,
                    c7_tenant_id:    c7TenantId.trim()    || undefined,
                    c7_api_base_url: c7ApiBaseUrl.trim()  || undefined,
                  };
                  if (c7ApiKey.trim()) body.c7_api_key = c7ApiKey.trim();
                  await putC7Settings(body);
                  setMessage('Commerce7 settings saved.');
                  setC7ApiKey('');
                  const fresh = await getC7Settings();
                  setC7Settings(fresh);
                  setC7TenantSlug(fresh.c7_tenant_slug || '');
                  setC7TenantId(fresh.c7_tenant_id || '');
                  setC7ApiBaseUrl(fresh.c7_api_base_url || '');
                } catch (e) { setError(e.message); }
                finally { setC7Saving(false); }
              }}
            >
              <label>
                Tenant Slug
                <input
                  type="text"
                  placeholder="e.g. kindredvineyards"
                  value={c7TenantSlug}
                  onChange={(e) => setC7TenantSlug(e.target.value)}
                  autoComplete="off"
                />
                <small>Found in your Commerce7 URL: <code>app.commerce7.com/<strong>slug</strong></code></small>
              </label>
              <label>
                Tenant ID
                <input
                  type="text"
                  placeholder="Commerce7 Tenant ID"
                  value={c7TenantId}
                  onChange={(e) => setC7TenantId(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                API Base URL <span style={{ fontWeight: 400, color: '#888' }}>(optional)</span>
                <input
                  type="text"
                  placeholder="https://api.commerce7.com/v1"
                  value={c7ApiBaseUrl}
                  onChange={(e) => setC7ApiBaseUrl(e.target.value)}
                  autoComplete="off"
                />
                <small>Leave blank to use the default endpoint.</small>
              </label>
              <label>
                API Key
                <input
                  type="password"
                  placeholder={c7Settings?.c7_configured ? 'Leave blank to keep current' : 'Commerce7 API key'}
                  value={c7ApiKey}
                  onChange={(e) => setC7ApiKey(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              {c7Settings?.c7_configured && (
                <p className="test-result success" style={{ marginBottom: 0 }}>✓ API key is configured</p>
              )}
              <div style={{ display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-test"
                  disabled={c7Testing || (!c7Settings?.c7_configured && !c7ApiKey.trim())}
                  onClick={async () => {
                    setC7Testing(true); setC7TestResult(''); setError('');
                    try {
                      const body = {};
                      if (c7TenantSlug.trim())  body.c7_tenant_slug  = c7TenantSlug.trim();
                      if (c7TenantId.trim())    body.c7_tenant_id    = c7TenantId.trim();
                      if (c7ApiBaseUrl.trim())  body.c7_api_base_url = c7ApiBaseUrl.trim();
                      if (c7ApiKey.trim())      body.c7_api_key      = c7ApiKey.trim();
                      const r = await testC7Connection(body);
                      setC7TestResult(r.message || 'Connected.');
                    } catch (e) { setError(e.message); }
                    finally { setC7Testing(false); }
                  }}
                >
                  {c7Testing ? 'Testing…' : 'Test connection'}
                </button>
                <button type="submit" disabled={c7Saving}>{c7Saving ? 'Saving…' : 'Save Commerce7'}</button>
              </div>
              {c7TestResult && <p className="test-result success">{c7TestResult}</p>}
            </form>
          </fieldset>
          <fieldset style={{ marginTop: '1.5rem' }}>
            <legend>QuickBooks Online</legend>
            {settings?.qbo_connected ? (
              <div>
                <p className="test-result success">Connected — Realm ID: {settings.qbo_realm_id} ({settings.qbo_environment})</p>
                <button type="button" className="btn-test" onClick={handleQBODisconnect} disabled={qboDisconnecting}>
                  {qboDisconnecting ? 'Disconnecting…' : 'Disconnect QuickBooks'}
                </button>
              </div>
            ) : (
              <div>
                <p style={{ margin: '0 0 0.75rem', color: '#666', fontSize: '0.9em' }}>Connect this company to QuickBooks Online to enable accounting data access.</p>
                <button type="button" className="btn-test" onClick={handleQBOConnect} disabled={qboConnecting}>
                  {qboConnecting ? 'Connecting…' : 'Connect QuickBooks'}
                </button>
              </div>
            )}
          </fieldset>

          {/* ── Mail (SMTP) ───────────────────────────────────────── */}
          <fieldset style={{ marginTop: '1.5rem' }}>
            <legend>Mail (SMTP)</legend>
            <p style={{ margin: '0 0 0.75rem', color: '#666', fontSize: '0.9em' }}>
              SMTP settings for this company (e.g. password reset emails). Leave password blank to keep the current value.
            </p>
            <form onSubmit={handleMailSubmit} className="settings-form">
              <label>
                Host
                <input
                  type="text"
                  placeholder="smtp.example.com"
                  value={mailHost}
                  onChange={(e) => setMailHost(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Port
                <input
                  type="text"
                  placeholder="587"
                  value={mailPort}
                  onChange={(e) => setMailPort(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                User
                <input
                  type="text"
                  placeholder="SMTP username"
                  value={mailUser}
                  onChange={(e) => setMailUser(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  placeholder={settings?.mail_configured ? 'Leave blank to keep current' : 'SMTP password'}
                  value={mailPass}
                  onChange={(e) => setMailPass(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                From address
                <input
                  type="text"
                  placeholder="noreply@yourdomain.com"
                  value={mailFrom}
                  onChange={(e) => setMailFrom(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={mailSecure}
                  onChange={(e) => setMailSecure(e.target.checked)}
                />
                Use TLS (secure)
              </label>
              <div style={{ display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
                <button type="button" className="btn-test" onClick={handleTestMail} disabled={testingMail} title="Send a test email to your account using current mail settings">
                  {testingMail ? 'Sending…' : 'Test email'}
                </button>
                <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save Mail'}</button>
              </div>
              {mailTestResult && <p className="test-result success">{mailTestResult}</p>}
            </form>
          </fieldset>

          {/* ── Amazon Business ───────────────────────────────────── */}
          <fieldset style={{ marginTop: '1.5rem' }}>
            <legend>Amazon Business</legend>
            <p style={{ margin: '0 0 0.75rem', color: '#666', fontSize: '0.9em' }}>
              Credentials for automated Amazon Business order sync. The server logs in on your behalf,
              downloads order history, and imports PDF receipts into the QuickBooks pipeline.
              Password is stored server-side and never returned.
            </p>
            <form
              className="settings-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setAmazonSaving(true); setError(''); setMessage(''); setAmazonTestResult('');
                try {
                  const body = {};
                  if (amazonEmail.trim()) body.amazon_email = amazonEmail.trim();
                  if (amazonPassword.trim()) body.amazon_password = amazonPassword.trim();
                  await putAmazonSettings(body);
                  setMessage('Amazon Business settings saved.');
                  setAmazonPassword('');
                  const fresh = await getAmazonSettings();
                  setAmazonSettings(fresh);
                  setAmazonEmail(fresh.amazon_email || '');
                } catch (e) { setError(e.message); }
                finally { setAmazonSaving(false); }
              }}
            >
              <label>
                Amazon Business email
                <input
                  type="email"
                  placeholder="your@amazon-business-account.com"
                  value={amazonEmail}
                  onChange={(e) => setAmazonEmail(e.target.value)}
                  autoComplete="username"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  placeholder={amazonSettings?.amazon_configured ? 'Leave blank to keep current' : 'Amazon Business password'}
                  value={amazonPassword}
                  onChange={(e) => setAmazonPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              {amazonSettings?.amazon_configured && (
                <p className="test-result success" style={{ marginBottom: 0 }}>✓ Password is configured</p>
              )}
              <p style={{ margin: '0.5rem 0 0', color: '#888', fontSize: '0.85em' }}>
                Note: if your account has two-factor authentication enabled, you'll need to complete a
                manual login first to establish a browser session, then the automated sync can reuse it.
              </p>
              <div style={{ display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn-test"
                  disabled={amazonTesting || (!amazonSettings?.amazon_configured && (!amazonEmail.trim() || !amazonPassword.trim()))}
                  onClick={async () => {
                    setAmazonTesting(true); setAmazonTestResult(''); setError('');
                    try {
                      const body = {};
                      if (amazonEmail.trim()) body.amazon_email = amazonEmail.trim();
                      if (amazonPassword.trim()) body.amazon_password = amazonPassword.trim();
                      const r = await testAmazonLogin(body);
                      setAmazonTestResult(r.message || 'Login successful.');
                    } catch (e) { setError(e.message); }
                    finally { setAmazonTesting(false); }
                  }}
                >
                  {amazonTesting ? 'Testing…' : 'Test login'}
                </button>
                <button type="submit" disabled={amazonSaving}>{amazonSaving ? 'Saving…' : 'Save Amazon'}</button>
              </div>
              {amazonTestResult && <p className="test-result success">{amazonTestResult}</p>}
            </form>
          </fieldset>

          {/* ── API Keys ───────────────────────────────────────────── */}
          <fieldset style={{ marginTop: '1.5rem' }}>
            <legend>API Keys</legend>
            <p style={{ margin: '0 0 1rem', color: '#666', fontSize: '0.9em' }}>
              Issue named tokens for agents and integrations (e.g. BookKeeper). Tokens are shown <strong>once</strong> at creation — copy it immediately.
            </p>

            {createdToken && (
              <div className="service-token-reveal">
                <p><strong>✓ Token created — copy it now. It will not be shown again.</strong></p>
                <code className="service-token-value">{createdToken}</code>
                <button type="button" className="btn-copy" onClick={() => { navigator.clipboard.writeText(createdToken); }}>Copy</button>
                <button type="button" className="btn-dismiss" onClick={() => setCreatedToken(null)}>Dismiss</button>
              </div>
            )}

            <form onSubmit={handleCreateToken} className="service-token-form">
              <input
                type="text"
                placeholder="Token name (e.g. BookKeeper Agent)"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                className="service-token-name-input"
              />
              <select value={newTokenRole} onChange={(e) => setNewTokenRole(e.target.value)} className="service-token-role-select">
                <option value="manager">Manager</option>
                <option value="owner">Owner</option>
              </select>
              <button type="submit" className="btn-test" disabled={tokenCreating || !newTokenName.trim()}>
                {tokenCreating ? 'Creating…' : '+ Create Token'}
              </button>
            </form>

            {serviceTokens.length > 0 && (
              <table className="service-token-table">
                <thead>
                  <tr><th>Name</th><th>Role</th><th>Created</th><th>Last used</th><th></th></tr>
                </thead>
                <tbody>
                  {serviceTokens.map((t) => (
                    <tr key={t.id} className={t.revoked_at ? 'token-revoked' : ''}>
                      <td>{t.name}</td>
                      <td><span className="token-role-badge">{t.role}</span></td>
                      <td>{new Date(t.created_at).toLocaleDateString()}</td>
                      <td>{t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : '—'}</td>
                      <td>
                        {!t.revoked_at && (
                          <button type="button" className="btn-revoke" onClick={() => handleRevokeToken(t.id, t.name)}>
                            Revoke
                          </button>
                        )}
                        {t.revoked_at && <span className="token-revoked-label">Revoked</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {serviceTokens.filter(t => !t.revoked_at).length === 0 && !createdToken && (
              <p style={{ color: '#aaa', fontSize: '0.85em', marginTop: '0.5rem' }}>No active tokens.</p>
            )}
          </fieldset>
        </>
      )}


      {tab === 'square' && (
        <>
          <SquareSyncPanel />
          <SquareUsersPanel />
        </>
      )}

      {tab === 'commerce7' && isOwner && (
        <Commerce7SyncPanel />
      )}

    </div>
  );
}
