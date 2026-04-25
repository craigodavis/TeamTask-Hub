import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getQBOStatus, syncQBO, uploadReceipts, getReceipts, getReceipt, saveReceiptItems } from '../api';
import './Quickbooks.css';

export function Quickbooks({ user }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // Receipt list
  const [receipts, setReceipts] = useState([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);

  // Upload
  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState(null);
  const fileInputRef = useRef();

  // Review modal
  const [reviewing, setReviewing] = useState(null); // full receipt object
  const [reviewLoading, setReviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const isOwner = user?.role === 'owner';

  const loadStatus = useCallback(() => {
    setLoading(true);
    setError('');
    getQBOStatus()
      .then(setStatus)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const loadReceipts = useCallback(() => {
    setReceiptsLoading(true);
    getReceipts()
      .then(setReceipts)
      .catch(() => {})
      .finally(() => setReceiptsLoading(false));
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { if (status?.connected) loadReceipts(); }, [status, loadReceipts]);

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    setMessage('');
    try {
      const r = await syncQBO();
      setMessage(`Synced ${r.accounts} accounts and ${r.classes} classes from QuickBooks.`);
      loadStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setUploading(true);
    setUploadResults(null);
    setError('');
    setMessage('');
    try {
      const result = await uploadReceipts(files);
      setUploadResults(result.results);
      loadReceipts();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      fileInputRef.current.value = '';
    }
  };

  const openReview = async (receiptId) => {
    setReviewLoading(true);
    setReviewing(null);
    try {
      const r = await getReceipt(receiptId);
      setReviewing(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setReviewLoading(false);
    }
  };

  const handleItemChange = (itemId, field, value) => {
    setReviewing((prev) => ({
      ...prev,
      items: prev.items.map((it) => it.id === itemId ? { ...it, [field]: value } : it),
    }));
  };

  const handleSaveReview = async () => {
    setSaving(true);
    try {
      await saveReceiptItems(reviewing.id, reviewing.items);
      setReviewing(null);
      loadReceipts();
      setMessage('Receipt review saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!isOwner) {
    return (
      <div className="qb-page">
        <p>Owner access required.</p>
        <Link to="/">Back to dashboard</Link>
      </div>
    );
  }

  return (
    <div className="qb-page">
      <div className="qb-header">
        <h2>QuickBooks</h2>
      </div>

      {error && <p className="qb-error">{error}</p>}
      {message && <p className="qb-message">{message}</p>}

      {loading ? (
        <p className="qb-loading">Loading…</p>
      ) : !status?.connected ? (
        <div className="qb-not-connected">
          <p>QuickBooks is not connected.</p>
          <Link to="/settings">Connect in Settings → Integrations</Link>
        </div>
      ) : (
        <>
          {/* ── Connection card ── */}
          <div className="qb-status-card">
            <div className="qb-status-row">
              <span className="qb-status-dot connected" />
              <span>Connected — Realm {status.realm_id}</span>
              <span className="qb-env-badge">{status.environment}</span>
            </div>
            <div className="qb-sync-info">
              {status.last_synced ? (
                <span>Last synced: {new Date(status.last_synced).toLocaleString()}</span>
              ) : (
                <span className="qb-sync-never">Never synced — run a sync to import accounts and classes.</span>
              )}
              <div className="qb-counts">
                <span>{status.accounts} accounts</span>
                <span>{status.classes} classes</span>
              </div>
            </div>
            <button type="button" className="qb-btn-sync" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>

          {/* ── Receipt import ── */}
          <div className="qb-section-header">
            <h3>Receipt Import</h3>
            <p className="qb-section-sub">Upload Amazon order PDFs. Claude will extract line items and suggest accounts &amp; classes.</p>
          </div>

          <div className="qb-upload-area">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              multiple
              id="pdf-upload"
              className="qb-file-input"
              onChange={handleFileChange}
              disabled={uploading}
            />
            <label htmlFor="pdf-upload" className={`qb-upload-label ${uploading ? 'uploading' : ''}`}>
              {uploading ? (
                <>⏳ Processing PDFs…</>
              ) : (
                <>📄 Click to upload Amazon order PDFs</>
              )}
            </label>
          </div>

          {uploadResults && (
            <div className="qb-upload-results">
              {uploadResults.map((r, i) => (
                <div key={i} className={`qb-upload-result ${r.error ? 'error' : r.skipped ? 'skipped' : 'ok'}`}>
                  <span className="qb-result-file">{r.filename}</span>
                  {r.error && <span>❌ {r.error}</span>}
                  {r.skipped && <span>⚠️ Duplicate — order {r.order_number} already imported ({r.existing_status})</span>}
                  {!r.error && !r.skipped && (
                    <span>✅ {r.order_number} · {r.items} items · ${r.total?.toFixed(2)}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Receipt list ── */}
          <div className="qb-receipts-header">
            <h3>Imported Receipts</h3>
          </div>

          {receiptsLoading ? (
            <p className="qb-loading">Loading receipts…</p>
          ) : receipts.length === 0 ? (
            <p className="qb-empty">No receipts imported yet. Upload a PDF above to get started.</p>
          ) : (
            <div className="qb-receipt-list">
              {receipts.map((r) => (
                <div key={r.id} className="qb-receipt-row">
                  <div className="qb-receipt-meta">
                    <span className="qb-receipt-order">{r.order_number}</span>
                    <span className="qb-receipt-vendor">{r.vendor}</span>
                    {r.order_date && <span className="qb-receipt-date">{new Date(r.order_date).toLocaleDateString()}</span>}
                    <span className={`qb-receipt-status qb-status-${r.status}`}>{r.status}</span>
                  </div>
                  <div className="qb-receipt-right">
                    {r.total != null && <span className="qb-receipt-total">${parseFloat(r.total).toFixed(2)}</span>}
                    <span className="qb-receipt-items">{r.item_count} items</span>
                    <button
                      type="button"
                      className="qb-btn-review"
                      onClick={() => openReview(r.id)}
                      disabled={reviewLoading}
                    >
                      Review
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Review modal ── */}
          {(reviewLoading || reviewing) && (
            <div className="qb-modal-overlay" onClick={(e) => { if (e.target.classList.contains('qb-modal-overlay')) setReviewing(null); }}>
              <div className="qb-modal">
                {reviewLoading ? (
                  <p className="qb-loading">Loading receipt…</p>
                ) : (
                  <>
                    <div className="qb-modal-header">
                      <div>
                        <h3>{reviewing.vendor} — {reviewing.order_number}</h3>
                        <p className="qb-modal-sub">
                          {reviewing.order_date && new Date(reviewing.order_date).toLocaleDateString()} &nbsp;·&nbsp;
                          Total: ${parseFloat(reviewing.total || 0).toFixed(2)}
                        </p>
                      </div>
                      <button type="button" className="qb-modal-close" onClick={() => setReviewing(null)}>✕</button>
                    </div>

                    <div className="qb-review-table-wrap">
                      <table className="qb-review-table">
                        <thead>
                          <tr>
                            <th>Item</th>
                            <th>Total</th>
                            <th>Account</th>
                            <th>Class</th>
                            <th>Decision</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reviewing.items.map((item) => (
                            <tr key={item.id} className={`qb-item-row qb-item-${item.item_status}`}>
                              <td>
                                <div className="qb-item-desc">{item.description}</div>
                                {item.ai_confidence != null && (
                                  <div className="qb-item-confidence">AI confidence: {Math.round(item.ai_confidence * 100)}%</div>
                                )}
                              </td>
                              <td className="qb-item-total">
                                {item.total != null ? `$${parseFloat(item.total).toFixed(2)}` : '—'}
                              </td>
                              <td>
                                <div className="qb-item-account">
                                  {item.account_full_name || item.account_name || (item.qbo_account_id ? `ID: ${item.qbo_account_id}` : '—')}
                                </div>
                              </td>
                              <td>{item.class_name || '—'}</td>
                              <td>
                                <div className="qb-decision-btns">
                                  <button
                                    type="button"
                                    className={`qb-btn-accept ${item.item_status === 'accepted' ? 'active' : ''}`}
                                    onClick={() => handleItemChange(item.id, 'item_status', 'accepted')}
                                  >✓</button>
                                  <button
                                    type="button"
                                    className={`qb-btn-reject ${item.item_status === 'rejected' ? 'active' : ''}`}
                                    onClick={() => handleItemChange(item.id, 'item_status', 'rejected')}
                                  >✕</button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="qb-modal-footer">
                      <button type="button" className="qb-btn-cancel" onClick={() => setReviewing(null)}>Cancel</button>
                      <button type="button" className="qb-btn-save" onClick={handleSaveReview} disabled={saving}>
                        {saving ? 'Saving…' : 'Save Review'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
