import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  getQBOStatus, syncQBO,
  uploadReceipts, getReceipts, getReceipt, saveReceiptItems, acceptAllItems, deleteReceipt,
  getPaymentAccounts, savePaymentAccount, previewExport, confirmExport, searchQBOPurchases,
  getRules, createRule, updateRule, deleteRule, reapplyRules,
} from '../api';
import './Quickbooks.css';

const BLANK_RULE = {
  name: '', priority: 100,
  if_description_contains: '', if_vendor: '', if_account_type_contains: '',
  then_account_id: '', then_class_id: '', then_clear: false,
  notes: '', active: true,
};

export function Quickbooks({ user }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // QBO reference data (for rule dropdowns)
  const [accounts, setAccounts] = useState([]);
  const [classes, setClasses] = useState([]);

  // Receipt list
  const [receipts, setReceipts] = useState([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);

  // Upload
  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState(null);
  const fileInputRef = useRef();

  // Review modal
  const [reviewing, setReviewing] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState('pending');

  // Export
  const [paymentAccounts, setPaymentAccounts] = useState([]);
  const [defaultAccountId, setDefaultAccountId] = useState('');
  const [exportPreviewing, setExportPreviewing] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportPreviews, setExportPreviews] = useState(null); // null | array
  const [exportSelections, setExportSelections] = useState({}); // receipt_id → bool
  const [exportConfirming, setExportConfirming] = useState(false);
  // Manual link: { [receipt_id]: { searching, results, selectedQboId } }
  const [manualLinks, setManualLinks] = useState({});

  // Accept all
  const [accepting, setAccepting] = useState(null); // receipt id being accepted

  // Re-apply rules
  const [reapplying, setReapplying] = useState(null); // receipt id being reapplied

  // Rules
  const [rules, setRules] = useState([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null); // null | 'new' | rule object
  const [ruleForm, setRuleForm] = useState(BLANK_RULE);
  const [ruleSaving, setRuleSaving] = useState(false);

  const isOwner = user?.role === 'owner';

  const loadStatus = useCallback(() => {
    setLoading(true);
    setError('');
    getQBOStatus()
      .then(setStatus)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const loadReceipts = useCallback((tab) => {
    setReceiptsLoading(true);
    getReceipts(tab || activeTab)
      .then(setReceipts)
      .catch(() => {})
      .finally(() => setReceiptsLoading(false));
  }, [activeTab]);

  const loadRules = useCallback(() => {
    getRules().then(setRules).catch(() => {});
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Reload when tab changes
  useEffect(() => {
    if (!status?.connected) return;
    loadReceipts(activeTab);
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!status?.connected) return;
    loadReceipts();
    loadRules();
    // Load accounts + classes for rule dropdowns
    fetch('/api/integrations/qbo/reference', {
      headers: { Authorization: `Bearer ${localStorage.getItem('teamtask_token')}` },
    })
      .then((r) => r.json())
      .then((d) => { setAccounts(d.accounts || []); setClasses(d.classes || []); })
      .catch(() => {});
    // Load payment accounts for export
    getPaymentAccounts()
      .then((d) => { setPaymentAccounts(d.accounts || []); setDefaultAccountId(d.default_account_id || ''); })
      .catch((e) => setError(`Could not load payment accounts: ${e.message}`));
  }, [status, loadReceipts, loadRules]);

  // ── Sync ──
  const handleSync = async () => {
    setSyncing(true); setError(''); setMessage('');
    try {
      const r = await syncQBO();
      setMessage(`Synced ${r.accounts} accounts and ${r.classes} classes from QuickBooks.`);
      loadStatus();
    } catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  };

  // ── Upload ──
  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setUploading(true); setUploadResults(null); setError(''); setMessage('');
    try {
      const result = await uploadReceipts(files);
      setUploadResults(result.results);
      loadReceipts();
    } catch (e) { setError(e.message); }
    finally { setUploading(false); fileInputRef.current.value = ''; }
  };

  // ── Review ──
  const openReview = async (receiptId) => {
    setReviewLoading(true); setReviewing(null);
    try { const r = await getReceipt(receiptId); setReviewing(r); }
    catch (e) { setError(e.message); }
    finally { setReviewLoading(false); }
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
      loadReceipts(activeTab);
      setMessage('Receipt review saved.');
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  // ── Export to QBO ──
  const handleManualSearch = async (receiptId, orderDate) => {
    setManualLinks((m) => ({ ...m, [receiptId]: { searching: true, results: null, selectedQboId: null } }));
    try {
      const { purchases } = await searchQBOPurchases(defaultAccountId, orderDate);
      setManualLinks((m) => ({ ...m, [receiptId]: { searching: false, results: purchases, selectedQboId: null } }));
    } catch (e) {
      setManualLinks((m) => ({ ...m, [receiptId]: { searching: false, results: [], selectedQboId: null } }));
      setError(e.message);
    }
  };

  const handleManualSelect = (receiptId, qboId) => {
    setManualLinks((m) => ({ ...m, [receiptId]: { ...m[receiptId], selectedQboId: qboId } }));
    // Also check the row's checkbox
    setExportSelections((s) => ({ ...s, [receiptId]: !!qboId }));
  };

  const handleOpenExport = async () => {
    if (!defaultAccountId) {
      setError('Please select a payment account before exporting.');
      return;
    }
    setExportLoading(true); setError(''); setMessage('');
    try {
      const { previews } = await previewExport(defaultAccountId);
      setExportPreviews(previews);
      // Default: check everything that has a match
      const sel = {};
      previews.forEach((p) => { sel[p.receipt.id] = !!p.match; });
      setExportSelections(sel);
      setExportPreviewing(true);
    } catch (e) { setError(e.message); }
    finally { setExportLoading(false); }
  };

  const handleConfirmExport = async () => {
    const toExport = exportPreviews
      .filter((p) => exportSelections[p.receipt.id])
      .map((p) => {
        const manualQboId = manualLinks[p.receipt.id]?.selectedQboId;
        const qboId = manualQboId || p.match?.qbo_id;
        return qboId ? { receipt_id: p.receipt.id, qbo_transaction_id: qboId } : null;
      })
      .filter(Boolean);

    if (!toExport.length) { setError('No receipts selected for export.'); return; }

    setExportConfirming(true); setError('');
    try {
      const { results } = await confirmExport(toExport);
      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      setExportPreviewing(false);
      setExportPreviews(null);
      setManualLinks({});
      loadReceipts(activeTab);
      if (failed.length) {
        setError(`${failed.length} receipt(s) failed to export. ${failed.map((f) => f.error).join('; ')}`);
      }
      setMessage(`Exported ${ok} receipt(s) to QuickBooks.`);
    } catch (e) { setError(e.message); }
    finally { setExportConfirming(false); }
  };

  // ── Accept All ──
  const handleAcceptAll = async (receiptId) => {
    setAccepting(receiptId);
    setError(''); setMessage('');
    try {
      const r = await acceptAllItems(receiptId);
      setMessage(`Accepted ${r.accepted} items.`);
      loadReceipts(activeTab);
    } catch (e) { setError(e.message); }
    finally { setAccepting(null); }
  };

  // ── Delete receipt ──
  const handleDeleteReceipt = async (receipt) => {
    if (!window.confirm(`Remove "${receipt.order_number}" from the list? This cannot be undone.`)) return;
    try {
      await deleteReceipt(receipt.id);
      loadReceipts(activeTab);
      setMessage(`Receipt ${receipt.order_number} removed.`);
    } catch (e) { setError(e.message); }
  };

  // ── Rules ──
  const handleReapplyRules = async (receiptId) => {
    setReapplying(receiptId);
    setError(''); setMessage('');
    try {
      const r = await reapplyRules(receiptId);
      setMessage(`Rules re-applied — ${r.updated} of ${r.total} pending items updated.`);
    } catch (e) { setError(e.message); }
    finally { setReapplying(null); }
  };

  const openNewRule = () => { setRuleForm(BLANK_RULE); setEditingRule('new'); setRulesOpen(true); };
  const openEditRule = (rule) => { setRuleForm({ ...rule }); setEditingRule(rule); };
  const closeRuleForm = () => setEditingRule(null);

  const handleRuleFormChange = (field, value) => setRuleForm((f) => ({ ...f, [field]: value }));

  const handleSaveRule = async () => {
    if (!ruleForm.name.trim()) return;
    setRuleSaving(true);
    try {
      if (editingRule === 'new') {
        await createRule(ruleForm);
      } else {
        await updateRule(editingRule.id, ruleForm);
      }
      loadRules();
      closeRuleForm();
      setMessage('Rule saved.');
    } catch (e) { setError(e.message); }
    finally { setRuleSaving(false); }
  };

  const handleToggleRule = async (rule) => {
    try {
      await updateRule(rule.id, { active: !rule.active });
      loadRules();
    } catch (e) { setError(e.message); }
  };

  const handleDeleteRule = async (rule) => {
    if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
    try { await deleteRule(rule.id); loadRules(); setMessage('Rule deleted.'); }
    catch (e) { setError(e.message); }
  };

  const describeRule = (r) => {
    const conds = [];
    if (r.if_description_contains) conds.push(`description contains "${r.if_description_contains}"`);
    if (r.if_vendor) conds.push(`vendor is "${r.if_vendor}"`);
    if (r.if_account_type_contains) conds.push(`account type contains "${r.if_account_type_contains}"`);
    const acts = [];
    if (r.then_clear) acts.push('clear suggestion');
    if (r.then_account_name || r.then_account_full_name) acts.push(`account → ${r.then_account_full_name || r.then_account_name}`);
    if (r.then_class_name) acts.push(`class → ${r.then_class_name}`);
    return `IF ${conds.join(' AND ') || '(any)'} → THEN ${acts.join(', ') || '(no action)'}`;
  };

  if (!isOwner) {
    return <div className="qb-page"><p>Owner access required.</p><Link to="/">Back to dashboard</Link></div>;
  }

  return (
    <div className="qb-page">
      <div className="qb-header"><h2>QuickBooks</h2></div>

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
              {status.last_synced
                ? <span>Last synced: {new Date(status.last_synced).toLocaleString()}</span>
                : <span className="qb-sync-never">Never synced — run a sync to import accounts and classes.</span>}
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
            <input ref={fileInputRef} type="file" accept="application/pdf" multiple id="pdf-upload"
              className="qb-file-input" onChange={handleFileChange} disabled={uploading} />
            <label htmlFor="pdf-upload" className={`qb-upload-label ${uploading ? 'uploading' : ''}`}>
              {uploading ? <>⏳ Processing PDFs…</> : <>📄 Click to upload Amazon order PDFs</>}
            </label>
          </div>

          {uploadResults && (
            <div className="qb-upload-results">
              {uploadResults.map((r, i) => (
                <div key={i} className={`qb-upload-result ${r.error ? 'error' : r.skipped ? 'skipped' : 'ok'}`}>
                  <span className="qb-result-file">{r.filename}</span>
                  {r.error && <span>❌ {r.error}</span>}
                  {r.skipped && <span>⚠️ Duplicate — order {r.order_number} already imported ({r.existing_status})</span>}
                  {!r.error && !r.skipped && <span>✅ {r.order_number} · {r.items} items · ${r.total?.toFixed(2)}</span>}
                </div>
              ))}
            </div>
          )}

          {/* ── Receipt tabs ── */}
          <div className="qb-tabs-row">
            <div className="qb-tabs">
              <button type="button" className={`qb-tab ${activeTab === 'pending' ? 'active' : ''}`} onClick={() => setActiveTab('pending')}>Pending</button>
              <button type="button" className={`qb-tab ${activeTab === 'reviewed' ? 'active' : ''}`} onClick={() => setActiveTab('reviewed')}>Reviewed</button>
              <button type="button" className={`qb-tab ${activeTab === 'imported' ? 'active' : ''}`} onClick={() => setActiveTab('imported')}>Imported</button>
            </div>
            {activeTab === 'reviewed' && (
              <div className="qb-export-bar">
                <select
                  className="qb-export-account-select"
                  value={defaultAccountId}
                  onChange={async (e) => {
                    setDefaultAccountId(e.target.value);
                    await savePaymentAccount(e.target.value).catch(() => {});
                  }}
                >
                  <option value="">— select payment account —</option>
                  {paymentAccounts.map((a) => (
                    <option key={a.qbo_id} value={a.qbo_id}>{a.fully_qualified_name || a.name}</option>
                  ))}
                </select>
                <button type="button" className="qb-btn-export" onClick={handleOpenExport} disabled={exportLoading || !defaultAccountId}>
                  {exportLoading ? 'Searching QBO…' : 'Export to QuickBooks'}
                </button>
              </div>
            )}
          </div>

          {receiptsLoading ? (
            <p className="qb-loading">Loading receipts…</p>
          ) : receipts.length === 0 ? (
            <p className="qb-empty">
              {activeTab === 'pending'  && 'No pending receipts. Upload a PDF above or check the Reviewed tab.'}
              {activeTab === 'reviewed' && 'No reviewed receipts. Accept some from the Pending tab.'}
              {activeTab === 'imported' && 'No receipts exported to QuickBooks yet.'}
            </p>
          ) : (
            <div className="qb-receipt-list">
              {receipts.map((r) => (
                <div key={r.id} className="qb-receipt-row">
                  <div className="qb-receipt-main">
                    <div className="qb-receipt-meta">
                      <span className="qb-receipt-order">{r.order_number}</span>
                      <span className="qb-receipt-vendor">{r.vendor}</span>
                      {r.order_date && <span className="qb-receipt-date">{new Date(r.order_date).toLocaleDateString()}</span>}
                    </div>
                    {r.descriptions && (
                      <div className="qb-receipt-descs">{r.descriptions}</div>
                    )}
                    {(r.accounts_used || r.classes_used) && (
                      <div className="qb-receipt-cats">
                        {r.accounts_used && <span className="qb-receipt-accounts">📂 {r.accounts_used}</span>}
                        {r.classes_used  && <span className="qb-receipt-classes">🏷 {r.classes_used}</span>}
                      </div>
                    )}
                  </div>
                  <div className="qb-receipt-right">
                    {r.total != null && <span className="qb-receipt-total">${parseFloat(r.total).toFixed(2)}</span>}
                    <span className="qb-receipt-items">{r.item_count} items</span>
                    {activeTab === 'pending' && <>
                      <button type="button" className="qb-btn-reapply" onClick={() => handleReapplyRules(r.id)} disabled={!!reapplying || !!accepting} title="Re-apply categorization rules to pending items">
                        {reapplying === r.id ? '…' : '⚙'}
                      </button>
                    </>}
                    {(activeTab === 'pending' || activeTab === 'reviewed') &&
                      <button type="button" className="qb-btn-delete-receipt" onClick={() => handleDeleteReceipt(r)} title="Remove this receipt">
                        ✕
                      </button>
                    }
                    <button type="button" className="qb-btn-review" onClick={() => openReview(r.id)} disabled={reviewLoading}>
                      {activeTab === 'reviewed' ? 'View' : 'Review'}
                    </button>
                    {activeTab === 'pending' &&
                      <button type="button" className="qb-btn-accept-all" onClick={() => handleAcceptAll(r.id)} disabled={!!accepting || !!reapplying} title="Accept all suggested categorizations">
                        {accepting === r.id ? '…' : 'Accept'}
                      </button>
                    }
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Categorization Rules ── */}
          <div className="qb-rules-header" onClick={() => setRulesOpen((o) => !o)}>
            <h3>⚙️ Categorization Rules <span className="qb-rules-count">{rules.length}</span></h3>
            <span className="qb-rules-toggle">{rulesOpen ? '▲' : '▼'}</span>
          </div>

          {rulesOpen && (
            <div className="qb-rules-body">
              <p className="qb-section-sub" style={{ marginBottom: '0.75rem' }}>
                Rules run after AI categorization, in priority order (lower number = runs first). First match wins.
              </p>

              {rules.length === 0 && <p className="qb-empty">No rules yet. Add one below.</p>}

              {rules.map((r) => (
                <div key={r.id} className={`qb-rule-row ${r.active ? '' : 'inactive'}`}>
                  <div className="qb-rule-left">
                    <label className="qb-toggle" title={r.active ? 'Active — click to disable' : 'Disabled — click to enable'}>
                      <input type="checkbox" checked={r.active} onChange={() => handleToggleRule(r)} />
                      <span className="qb-toggle-slider" />
                    </label>
                    <div>
                      <div className="qb-rule-name">{r.name} <span className="qb-rule-priority">#{r.priority}</span></div>
                      <div className="qb-rule-desc">{describeRule(r)}</div>
                      {r.notes && <div className="qb-rule-notes">{r.notes}</div>}
                    </div>
                  </div>
                  <div className="qb-rule-actions">
                    <button type="button" className="qb-btn-rule-edit" onClick={() => openEditRule(r)}>Edit</button>
                    <button type="button" className="qb-btn-rule-del" onClick={() => handleDeleteRule(r)}>Delete</button>
                  </div>
                </div>
              ))}

              <button type="button" className="qb-btn-add-rule" onClick={openNewRule}>+ Add Rule</button>
            </div>
          )}

          {/* ── Rule form modal ── */}
          {editingRule && (
            <div className="qb-modal-overlay" onClick={(e) => { if (e.target.classList.contains('qb-modal-overlay')) closeRuleForm(); }}>
              <div className="qb-modal qb-rule-modal">
                <div className="qb-modal-header">
                  <h3>{editingRule === 'new' ? 'Add Rule' : 'Edit Rule'}</h3>
                  <button type="button" className="qb-modal-close" onClick={closeRuleForm}>✕</button>
                </div>

                <div className="qb-rule-form">
                  <div className="qb-form-row">
                    <label>Rule Name *</label>
                    <input type="text" value={ruleForm.name} onChange={(e) => handleRuleFormChange('name', e.target.value)} placeholder="e.g. No Asset accounts for Amazon" />
                  </div>
                  <div className="qb-form-row">
                    <label>Priority (lower runs first)</label>
                    <input type="number" value={ruleForm.priority} onChange={(e) => handleRuleFormChange('priority', parseInt(e.target.value) || 100)} min={1} />
                  </div>

                  <div className="qb-form-section">IF (conditions — all must match)</div>

                  <div className="qb-form-row">
                    <label>Description contains</label>
                    <input type="text" value={ruleForm.if_description_contains} onChange={(e) => handleRuleFormChange('if_description_contains', e.target.value)} placeholder='e.g. food   or   food AND (label OR container)' />
                    <span className="qb-form-hint">Words are AND'd by default. Use AND, OR, and ( ) for logic.</span>
                  </div>
                  <div className="qb-form-row">
                    <label>Vendor is</label>
                    <input type="text" value={ruleForm.if_vendor} onChange={(e) => handleRuleFormChange('if_vendor', e.target.value)} placeholder="e.g. Amazon" />
                  </div>
                  <div className="qb-form-row">
                    <label>AI-suggested account type contains</label>
                    <input type="text" value={ruleForm.if_account_type_contains} onChange={(e) => handleRuleFormChange('if_account_type_contains', e.target.value)} placeholder="e.g. Asset, Other Asset, Fixed Asset" />
                  </div>

                  <div className="qb-form-section">THEN (actions)</div>

                  <div className="qb-form-row">
                    <label>
                      <input type="checkbox" checked={ruleForm.then_clear} onChange={(e) => handleRuleFormChange('then_clear', e.target.checked)} />
                      {' '}Clear account/class suggestion (use for "never" rules)
                    </label>
                  </div>
                  <div className="qb-form-row">
                    <label>Use account</label>
                    <select value={ruleForm.then_account_id} onChange={(e) => handleRuleFormChange('then_account_id', e.target.value)}>
                      <option value="">— no override —</option>
                      {accounts.filter((a) => a.active).map((a) => (
                        <option key={a.qbo_id} value={a.qbo_id}>{a.fully_qualified_name || a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="qb-form-row">
                    <label>Use class</label>
                    <select value={ruleForm.then_class_id} onChange={(e) => handleRuleFormChange('then_class_id', e.target.value)}>
                      <option value="">— no override —</option>
                      {classes.filter((c) => c.active).map((c) => (
                        <option key={c.qbo_id} value={c.qbo_id}>{c.fully_qualified_name || c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="qb-form-row">
                    <label>Notes</label>
                    <textarea value={ruleForm.notes} onChange={(e) => handleRuleFormChange('notes', e.target.value)} rows={2} placeholder="Optional explanation" />
                  </div>
                </div>

                <div className="qb-modal-footer">
                  <button type="button" className="qb-btn-cancel" onClick={closeRuleForm}>Cancel</button>
                  <button type="button" className="qb-btn-save" onClick={handleSaveRule} disabled={ruleSaving || !ruleForm.name.trim()}>
                    {ruleSaving ? 'Saving…' : 'Save Rule'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Export preview modal ── */}
          {exportPreviewing && exportPreviews && (
            <div className="qb-modal-overlay">
              <div className="qb-modal qb-export-modal">
                <div className="qb-modal-header">
                  <div>
                    <h3>Export to QuickBooks — Preview</h3>
                    <p className="qb-modal-sub">Uncheck any rows that don't look right. Only checked rows will be updated in QBO.</p>
                  </div>
                  <button type="button" className="qb-modal-close" onClick={() => setExportPreviewing(false)}>✕</button>
                </div>

                <div className="qb-review-table-wrap">
                  <table className="qb-review-table">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}></th>
                        <th>Receipt</th>
                        <th>Date</th>
                        <th>Total</th>
                        <th>QBO Transaction Found</th>
                        <th>Current Category</th>
                        <th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exportPreviews.map((p) => {
                        const checked = !!exportSelections[p.receipt.id];
                        const hasMatch = !!p.match;
                        return (
                          <tr key={p.receipt.id} className={`qb-export-row ${!hasMatch ? 'no-match' : ''}`}>
                            <td>
                              <input
                                type="checkbox"
                                checked={checked && hasMatch}
                                disabled={!hasMatch}
                                onChange={(e) => setExportSelections((s) => ({ ...s, [p.receipt.id]: e.target.checked }))}
                              />
                            </td>
                            <td>
                              <div className="qb-receipt-order">{p.receipt.order_number}</div>
                              <div style={{ fontSize: '0.78rem', color: '#777' }}>{p.receipt.vendor}</div>
                            </td>
                            <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                              {p.receipt.order_date ? new Date(p.receipt.order_date).toLocaleDateString() : '—'}
                            </td>
                            <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                              ${parseFloat(p.receipt.total || 0).toFixed(2)}
                            </td>
                            <td style={{ fontSize: '0.85rem' }}>
                              {hasMatch ? (
                                <>
                                  <div>{new Date(p.match.txn_date).toLocaleDateString()}
                                    {p.days_diff > 0 && <span style={{ color: '#888', marginLeft: 4 }}>({p.days_diff}d off)</span>}
                                  </div>
                                  {p.match.vendor && <div style={{ color: '#777', fontSize: '0.78rem' }}>{p.match.vendor}</div>}
                                </>
                              ) : (() => {
                                const ml = manualLinks[p.receipt.id];
                                const sel = ml?.selectedQboId;
                                const selTxn = sel && ml.results?.find((r) => r.qbo_id === sel);
                                return sel && selTxn ? (
                                  <div>
                                    <div style={{ color: '#1976d2', fontSize: '0.8rem', fontWeight: 600 }}>
                                      ✓ Linked manually
                                    </div>
                                    <div>{new Date(selTxn.txn_date).toLocaleDateString()} · ${parseFloat(selTxn.total).toFixed(2)}</div>
                                  </div>
                                ) : (
                                  <div>
                                    <span className="qb-no-match-label">No match found</span>
                                    <button
                                      type="button" className="qb-btn-manual-link"
                                      onClick={() => handleManualSearch(p.receipt.id, p.receipt.order_date)}
                                      disabled={ml?.searching}
                                    >
                                      {ml?.searching ? 'Searching…' : ml?.results ? 'Retry' : 'Link manually'}
                                    </button>
                                    {ml?.results && (
                                      <select
                                        className="qb-manual-select"
                                        value={ml.selectedQboId || ''}
                                        onChange={(e) => handleManualSelect(p.receipt.id, e.target.value)}
                                      >
                                        <option value="">— pick a transaction —</option>
                                        {ml.results.map((r) => (
                                          <option key={r.qbo_id} value={r.qbo_id}>
                                            {new Date(r.txn_date).toLocaleDateString()} · ${parseFloat(r.total).toFixed(2)}{r.vendor ? ` · ${r.vendor}` : ''}
                                          </option>
                                        ))}
                                        {ml.results.length === 0 && <option disabled>No transactions found</option>}
                                      </select>
                                    )}
                                  </div>
                                );
                              })()}
                            </td>
                            <td style={{ fontSize: '0.85rem', color: '#555' }}>
                              {hasMatch ? p.match.current_categories
                                : (manualLinks[p.receipt.id]?.selectedQboId
                                    ? manualLinks[p.receipt.id].results?.find(r => r.qbo_id === manualLinks[p.receipt.id].selectedQboId)?.current_categories || '—'
                                    : '—')}
                            </td>
                            <td>
                              {hasMatch ? (
                                <span className={`qb-confidence qb-conf-${p.confidence}`}>
                                  {p.confidence}
                                </span>
                              ) : manualLinks[p.receipt.id]?.selectedQboId ? (
                                <span className="qb-confidence qb-conf-medium">manual</span>
                              ) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="qb-modal-footer">
                  <button type="button" className="qb-btn-cancel" onClick={() => setExportPreviewing(false)}>Cancel</button>
                  <button type="button" className="qb-btn-save" onClick={handleConfirmExport} disabled={exportConfirming}>
                    {exportConfirming
                      ? 'Updating QBO…'
                      : `Update ${Object.values(exportSelections).filter(Boolean).length} in QuickBooks`}
                  </button>
                </div>
              </div>
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
                                {item.rule_applied && <div className="qb-item-rule">⚙ Rule: {item.rule_applied}</div>}
                                {!item.rule_applied && item.ai_confidence != null && (
                                  <div className="qb-item-confidence">AI: {Math.round(item.ai_confidence * 100)}%</div>
                                )}
                              </td>
                              <td className="qb-item-total">{item.total != null ? `$${parseFloat(item.total).toFixed(2)}` : '—'}</td>
                              <td>
                                <select
                                  className="qb-item-select"
                                  value={item.qbo_account_id || ''}
                                  onChange={(e) => handleItemChange(item.id, 'qbo_account_id', e.target.value || null)}
                                >
                                  <option value="">— none —</option>
                                  {accounts.filter((a) => a.active).map((a) => (
                                    <option key={a.qbo_id} value={a.qbo_id}>{a.fully_qualified_name || a.name}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <select
                                  className="qb-item-select"
                                  value={item.qbo_class_id || ''}
                                  onChange={(e) => handleItemChange(item.id, 'qbo_class_id', e.target.value || null)}
                                >
                                  <option value="">— none —</option>
                                  {classes.filter((c) => c.active).map((c) => (
                                    <option key={c.qbo_id} value={c.qbo_id}>{c.fully_qualified_name || c.name}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <div className="qb-decision-btns">
                                  <button type="button" className={`qb-btn-accept ${item.item_status === 'accepted' ? 'active' : ''}`} onClick={() => handleItemChange(item.id, 'item_status', 'accepted')} title="Accept">✓</button>
                                  <button type="button" className={`qb-btn-reject ${item.item_status === 'rejected' ? 'active' : ''}`} onClick={() => handleItemChange(item.id, 'item_status', 'rejected')} title="Reject">✕</button>
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
