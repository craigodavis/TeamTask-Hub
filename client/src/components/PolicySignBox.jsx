import React, { useState } from 'react';
import { signPolicy } from '../api';

// Signature capture used by both the Dashboard task gate and the Policies page.
// Renders "I agree to said policy" + a typed-name signature + a Sign button.
export function PolicySignBox({ policy, currentUserName, onSigned }) {
  const [agreed, setAgreed] = useState(false);
  const [name, setName] = useState(currentUserName || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const handleSign = async () => {
    setErr('');
    setSaving(true);
    try {
      const result = await signPolicy(policy.id, name.trim());
      onSigned(result.signed_at || new Date().toISOString());
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="policy-sign-box">
      <label className="policy-agree-checkbox">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        I agree to said policy
      </label>
      <input
        type="text"
        className="policy-sign-name-input"
        placeholder="Type your full name to sign"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {err && <p className="form-error">{err}</p>}
      <button
        type="button"
        className="btn-primary btn-sign-policy"
        disabled={!agreed || !name.trim() || saving}
        onClick={handleSign}
      >
        {saving ? 'Signing…' : 'Sign'}
      </button>
    </div>
  );
}
