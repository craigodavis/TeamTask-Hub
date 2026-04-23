import React, { useState, useEffect } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { getIntegrationSettings, putIntegrationSettings, testSquareConnection, testTwilioConnection, testMail, getLocations, createLocation, updateLocation, deleteLocation, getQBOConnectUrl, disconnectQBO } from '../api';
import { SquareUsersPanel } from '../components/SquareUsersPanel';
import './Settings.css';

const OWNER_TABS = ['integrations', 'mail', 'locations', 'square'];

export function Settings() {
  const { user } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const isOwner = user?.role === 'owner';
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const tab = (() => {
    if (!isOwner) return 'square';
    if (!tabParam) return 'integrations';
    return OWNER_TABS.includes(tabParam) ? tabParam : 'integrations';
  })();

  const setSettingsTab = (next) => {
    if (next === 'integrations' && isOwner) {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: next }, { replace: true });
    }
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

  useEffect(() => {
    if (!isOwner && isManager && tabParam && tabParam !== 'square') {
      setSearchParams({ tab: 'square' }, { replace: true });
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
    getIntegrationSettings()
      .then((r) => {
        setSettings(r);
        setSquareApplicationId(r.square_application_id || '');
        setSquareEnv(r.square_env || 'production');
        setTwilioPhoneNumber(r.twilio_phone_number || '');
        setMailHost(r.mail_host || '');
        setMailPort(r.mail_port != null ? String(r.mail_port) : '');
        setMailUser(r.mail_user || '');
        setMailFrom(r.mail_from || '');
        setMailSecure(r.mail_secure || false);
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
            <button type="button" className={tab === 'integrations' ? 'active' : ''} onClick={() => setSettingsTab('integrations')}>Integrations</button>
            <button type="button" className={tab === 'mail' ? 'active' : ''} onClick={() => setSettingsTab('mail')}>Mail</button>
            <button type="button" className={tab === 'locations' ? 'active' : ''} onClick={() => { setSettingsTab('locations'); if (tab !== 'locations') loadLocations(); }}>Locations</button>
          </>
        )}
        <button type="button" className={tab === 'square' ? 'active' : ''} onClick={() => setSettingsTab('square')}>Square users</button>
      </nav>
      {error && <p className="settings-error">{error}</p>}
      {message && <p className="settings-message">{message}</p>}

      {tab === 'integrations' && (
        <>
          <p className="settings-intro">Configure Square, Twilio, and Campaign Monitor for this company. Values are stored per company and used when managers sync Square or send SMS. Leave a field blank to keep the current value.</p>
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
        </>
      )}

      {tab === 'mail' && (
        <>
          <p className="settings-intro">SMTP settings for this company (e.g. password reset emails). Leave password blank to keep the current value.</p>
          <form onSubmit={handleMailSubmit} className="settings-form">
            <fieldset>
              <legend>Mail (SMTP)</legend>
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
              <button type="button" className="btn-test" onClick={handleTestMail} disabled={testingMail} title="Send a test email to your account using current mail settings">
                {testingMail ? 'Sending…' : 'Test email'}
              </button>
              {mailTestResult && <p className="test-result success">{mailTestResult}</p>}
            </fieldset>
            <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </form>
        </>
      )}

      {tab === 'square' && <SquareUsersPanel />}

      {tab === 'locations' && (
        <>
          <p className="settings-intro">Locations for this company. Assign users, announcements, and task templates to one or many locations from the Manager page.</p>
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
        </>
      )}
    </div>
  );
}
