import React, { useState, useEffect } from 'react';
import { login, forgotPassword, pinLogin } from '../api';
import { PinPad } from '../components/PinPad';
import { SetPinModal } from '../components/SetPinModal';
import './Login.css';

export function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');

  // Remembered user / PIN flow — only offer the PIN pad if this device's
  // last user actually has a PIN set (teamtask_has_pin), otherwise it would
  // reject every entry and trap the user on the pad.
  const [rememberedEmail, setRememberedEmail] = useState(() => localStorage.getItem('teamtask_last_email') || '');
  const [rememberedName, setRememberedName] = useState(() => localStorage.getItem('teamtask_last_name') || '');
  const hasPinFlag = () => !!localStorage.getItem('teamtask_has_pin');
  const [showPinPad, setShowPinPad] = useState(!!(rememberedEmail) && hasPinFlag());
  const [pinError, setPinError] = useState('');
  const [usePinPad, setUsePinPad] = useState(!!(rememberedEmail) && hasPinFlag());

  // Post-login PIN setup prompt
  const [pendingUser, setPendingUser] = useState(null);
  const [showSetPin, setShowSetPin] = useState(false);

  const finishLogin = (user) => {
    onLogin(user);
  };

  const afterLogin = (user) => {
    // Save last user for PIN quick-login
    localStorage.setItem('teamtask_last_email', user.email);
    localStorage.setItem('teamtask_last_name', user.display_name || user.email);
    // Keep the has-pin flag in sync with server truth
    if (user.has_pin) localStorage.setItem('teamtask_has_pin', '1');
    else localStorage.removeItem('teamtask_has_pin');

    if (!user.has_pin) {
      // Prompt to set a PIN before going to the dashboard
      setPendingUser(user);
      setShowSetPin(true);
    } else {
      finishLogin(user);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user, token } = await login(email, password);
      localStorage.setItem('teamtask_token', token);
      afterLogin(user);
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handlePinComplete = async (pin) => {
    setPinError('');
    try {
      const { user, token } = await pinLogin(rememberedEmail, pin);
      localStorage.setItem('teamtask_token', token);
      afterLogin(user);
    } catch (err) {
      setPinError(err.message || 'Invalid PIN');
    }
  };

  const handleForgotSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setForgotMessage('');
    setLoading(true);
    try {
      await forgotPassword(email || undefined);
      setForgotMessage('If that email exists, we sent a reset link.');
    } catch (err) {
      setError(err.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const clearRemembered = () => {
    localStorage.removeItem('teamtask_last_email');
    localStorage.removeItem('teamtask_last_name');
    localStorage.removeItem('teamtask_has_pin');
    setRememberedEmail('');
    setRememberedName('');
    setShowPinPad(false);
    setUsePinPad(false);
    setPinError('');
  };

  // If a PIN setup modal is showing, render that
  if (showSetPin && pendingUser) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>Team Hub</h1>
          <SetPinModal
            required={false}
            onClose={() => finishLogin(pendingUser)}
            onSuccess={() => finishLogin(pendingUser)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Team Hub</h1>

        {usePinPad && rememberedEmail ? (
          <div className="login-pin-section">
            <p className="login-pin-greeting">
              Welcome back, <strong>{rememberedName || rememberedEmail}</strong>
            </p>
            <PinPad
              label="Enter your PIN"
              onComplete={handlePinComplete}
              error={pinError}
            />
            <div className="login-pin-links">
              <button type="button" className="link-button" onClick={clearRemembered}>
                Not you?
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setUsePinPad(false);
                  setShowPinPad(false);
                  setPinError('');
                  setEmail(rememberedEmail);
                }}
              >
                Use password instead
              </button>
            </div>
          </div>
        ) : (
          <>
            <form onSubmit={handleSubmit}>
              <label>
                Email
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {error && <p className="login-error">{error}</p>}
              <button type="submit" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            {rememberedEmail && (
              <p style={{ marginTop: '0.5rem', fontSize: '0.9rem', textAlign: 'center' }}>
                <button type="button" className="link-button" onClick={() => {
                  setUsePinPad(true);
                  setShowPinPad(true);
                }}>
                  Use PIN instead
                </button>
              </p>
            )}
            <p style={{ marginTop: '0.75rem', fontSize: '0.9rem' }}>
              <button type="button" className="link-button" onClick={() => setShowForgot(!showForgot)}>
                Forgot password?
              </button>
            </p>
            {showForgot && (
              <form onSubmit={handleForgotSubmit} style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
                <p className="hint">Enter your email to receive a reset link.</p>
                <label>
                  Email
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </label>
                {forgotMessage && <p className="login-message">{forgotMessage}</p>}
                <button type="submit" disabled={loading}>Send reset link</button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
