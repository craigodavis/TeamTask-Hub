import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getIntegrationSettings, putIntegrationSettings, testSquareConnection, testMail } from '../api';
import './Settings.css';

export function Settings({ user, onLogout }) {
  const [tab, setTab] = useState('integrations');
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
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
  const [testingMail, setTestingMail] = useState(false);
  const [mailTestResult, setMailTestResult] = useState(null);

  const [mailHost, setMailHost] = useState('');
  const [mailPort, setMailPort] = useState('');
  const [mailUser, setMailUser] = useState('');
  const [mailPass, setMailPass] = useState('');
  const [mailFrom, setMailFrom] = useState('');
  const [mailSecure, setMailSecure] = useState(false);

  const isOwner = user?.role === 'owner';
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
      getIntegrationSettings().then((r) => {
        setSettings(r);
        setSquareApplicationId(r.square_application_id || '');
      });
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

  if (!isOwner) {
    return (
      <div className="settings-page">
        <p>Owner access required.</p>
        <Link to="/">Back to dashboard</Link>
      </div>
    );
  }

  if (loading) return <div className="settings-page"><p>Loading…</p></div>;

  return (
    <div className="settings-page">
      <header className="settings-header">
        <Link to="/" className="back">← Dashboard</Link>
        <span className="title">Settings</span>
        <button type="button" className="btn-logout" onClick={onLogout}>Out</button>
      </header>
      <nav className="settings-tabs">
        <button type="button" className={tab === 'integrations' ? 'active' : ''} onClick={() => setTab('integrations')}>Integrations</button>
        <button type="button" className={tab === 'mail' ? 'active' : ''} onClick={() => setTab('mail')}>Mail</button>
      </nav>
      {error && <p className="settings-error">{error}</p>}
      {message && <p className="settings-message">{message}</p>}

      {tab === 'integrations' && (
        <>
          <p className="settings-intro">Configure Twilio and Square for this company. Values are stored per company and used when managers sync Square or send SMS. Leave a field blank to keep the current value.</p>
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
              placeholder={settings?.twilio_configured ? 'Leave blank to keep current' : 'Twilio Account SID'}
              value={twilioAccountSid}
              onChange={(e) => setTwilioAccountSid(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Auth token
            <input
              type="password"
              placeholder={settings?.twilio_configured ? 'Leave blank to keep current' : 'Twilio Auth Token'}
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
        </fieldset>
            <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </form>
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
    </div>
  );
}
