import React, { useState, useEffect, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { getPolicies, getPolicySignatures } from '../api';
import { PolicySignBox } from '../components/PolicySignBox';
import './Policies.css';

function SignatureRoster({ policyId }) {
  const [signatures, setSignatures] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || signatures) return;
    getPolicySignatures(policyId)
      .then((r) => setSignatures(r.signatures || []))
      .catch((e) => setError(e.message));
  }, [open, policyId, signatures]);

  return (
    <div className="policy-roster">
      <button type="button" className="btn-small" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide signers' : 'Who has signed'}
      </button>
      {open && (
        error ? <p className="form-error">{error}</p> :
        !signatures ? <p className="hint">Loading…</p> :
        <ul className="policy-roster-list">
          {signatures.map((s) => (
            <li key={s.user_id} className={s.signed_at ? 'signed' : 'unsigned'}>
              <span>{s.display_name || s.email}</span>
              <span className="policy-roster-status">
                {s.signed_at ? `✓ Signed ${new Date(s.signed_at).toLocaleDateString()}` : 'Not signed'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Policies() {
  const { user } = useOutletContext();
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await getPolicies();
      setPolicies(r.policies || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSigned = (id, signedAt) => {
    setPolicies((prev) => prev.map((p) => (p.id === id ? { ...p, my_signed_at: signedAt, signed_count: (p.signed_count || 0) + 1 } : p)));
  };

  return (
    <div className="policies-page">
      <h2 className="policies-title">Policies</h2>
      <p className="hint">
        Policies you must read and sign appear here. They stay listed until you sign or the
        author marks them as no longer required.
      </p>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="dashboard-loading">Loading…</p>
      ) : policies.length === 0 ? (
        <p className="hint">No policies have been created yet.</p>
      ) : (
        <div className="policies-list">
          {policies.map((p) => {
            const signed = !!p.my_signed_at;
            return (
              <div key={p.id} className={`policy-card${signed ? ' policy-card-signed' : ''}`}>
                <div className="policy-header-banner">POLICY</div>
                <h3 className="policy-card-title">{p.title}</h3>
                {!p.policy_required && (
                  <span className="status-badge badge-policy-inactive">No longer required</span>
                )}
                {p.body && (
                  <div className="policy-card-body" dangerouslySetInnerHTML={{ __html: p.body }} />
                )}

                {signed ? (
                  <p className="hint">✓ You signed this on {new Date(p.my_signed_at).toLocaleDateString()}</p>
                ) : p.policy_required ? (
                  <PolicySignBox
                    policy={p}
                    currentUserName={user?.display_name}
                    onSigned={(signedAt) => handleSigned(p.id, signedAt)}
                  />
                ) : (
                  <p className="hint">This policy is no longer required and does not need a signature.</p>
                )}

                <p className="hint">{p.signed_count ?? 0} / {p.total_employees ?? '?'} employees signed</p>
                <SignatureRoster policyId={p.id} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
