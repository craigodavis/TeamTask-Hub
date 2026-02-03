import React, { useState } from 'react';
import { login, forgotPassword } from '../api';
import './Login.css';

export function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [companySlug, setCompanySlug] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user, token } = await login(email, password, companySlug || undefined);
      localStorage.setItem('teamtask_token', token);
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setForgotMessage('');
    setLoading(true);
    try {
      await forgotPassword(email || undefined, companySlug || undefined);
      setForgotMessage('If that email exists, we sent a reset link.');
    } catch (err) {
      setError(err.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>TeamTask Hub</h1>
        <form onSubmit={handleSubmit}>
          <label>
            Company (optional)
            <input
              type="text"
              placeholder="company-slug"
              value={companySlug}
              onChange={(e) => setCompanySlug(e.target.value)}
            />
          </label>
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
        <p style={{ marginTop: '0.75rem', fontSize: '0.9rem' }}>
          <button type="button" className="link-button" onClick={() => setShowForgot(!showForgot)}>
            Forgot password?
          </button>
        </p>
        {showForgot && (
          <form onSubmit={handleForgotSubmit} style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
            <p className="hint">Enter your email (and company if you use one) to receive a reset link.</p>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Company (optional)
              <input type="text" placeholder="company-slug" value={companySlug} onChange={(e) => setCompanySlug(e.target.value)} />
            </label>
            {forgotMessage && <p className="login-message">{forgotMessage}</p>}
            <button type="submit" disabled={loading}>Send reset link</button>
          </form>
        )}
      </div>
    </div>
  );
}
