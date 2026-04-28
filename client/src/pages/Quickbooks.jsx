import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  getQBOStatus, syncQBO,
  uploadReceipts, getReceipts, getReceipt, saveReceiptItems, acceptAllItems, deleteReceipt,
  getPaymentAccounts, savePaymentAccount, previewExport, confirmExport, searchQBOPurchases,
  getRules, createRule, updateRule, deleteRule, reapplyRules, reapplyAllRules, suggestRule,
  uploadAmazonCSV, getAmazonPayments, getAmazonStats,
  getCardMappings, saveCardMapping, deleteCardMapping,
} from '../api';
import './Quickbooks.css';

// Classifications relevant to purchase categorization — exclude Revenue, Liability, Equity
const EXPENSE_CLASSIFICATIONS = ['Expense', 'Cost of Goods Sold', 'Asset'];

/**
 * Searchable account picker. Filters by any substring of the account name.
 * Only shows Expense / COGS / Asset accounts (plus unclassified as fallback).
 */
function AccountSelect({ value, onChange, accounts, placeholder = 'Search accounts…', warn = false, emptyLabel = null }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dropdownStyle, setDropdownStyle] = useState({});
  const btnRef = useRef(null);
  const inputRef = useRef(null);

  // Build the display label for the currently selected account
  const selected = accounts.find((a) => a.qbo_id === value);
  const displayLabel = selected ? (selected.fully_qualified_name || selected.name) : '';

  // All active accounts, expense-relevant ones first
  const expenseAccounts = accounts.filter(
    (a) => a.active && EXPENSE_CLASSIFICATIONS.includes(a.classification)
  );
  const otherAccounts = accounts.filter(
    (a) => a.active && !EXPENSE_CLASSIFICATIONS.includes(a.classification)
  );

  const q = search.trim().toLowerCase();
  const filterFn = (a) => !q || (a.fully_qualified_name || a.name).toLowerCase().includes(q);

  const filteredExpense = expenseAccounts.filter(filterFn);
  const filteredOther = otherAccounts.filter(filterFn);

  // Group expense accounts by classification
  const grouped = EXPENSE_CLASSIFICATIONS.map((cls) => ({
    cls,
    items: filteredExpense.filter((a) => a.classification === cls),
  })).filter((g) => g.items.length > 0);

  // Unclassified expense accounts + non-expense accounts go in "Other"
  const unclassifiedExpense = filteredExpense.filter((a) => !a.classification);
  const otherGroupItems = [...unclassifiedExpense, ...filteredOther];

  const openDropdown = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Position below the button; if too close to bottom, open upward
      const spaceBelow = window.innerHeight - r.bottom;
      const dropH = Math.min(300, window.innerHeight * 0.5);
      const top = spaceBelow >= dropH ? r.bottom + 2 : r.top - dropH - 2;
      setDropdownStyle({
        position: 'fixed',
        top,
        left: r.left,
        width: Math.max(r.width, 280),
        zIndex: 9999,
      });
    }
    setOpen(true);
  };

  // Focus the search input when dropdown opens
  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  // Close on outside click or scroll
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (btnRef.current && !btnRef.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const handleSelect = (qboId) => {
    onChange(qboId || null);
    setOpen(false);
    setSearch('');
  };

  const dropdown = open && createPortal(
    <div className="acct-select-dropdown" style={dropdownStyle}>
      <div className="acct-select-search-wrap">
        <input
          ref={inputRef}
          className="acct-select-search"
          placeholder={placeholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="acct-select-list">
        <div className="acct-select-option acct-select-none" onMouseDown={() => handleSelect(null)}>
          {emptyLabel ?? '⚠ No account'}
        </div>
        {grouped.map(({ cls, items }) => (
          <div key={cls}>
            <div className="acct-select-group-label">{cls}</div>
            {items.map((a) => (
              <div
                key={a.qbo_id}
                className={`acct-select-option${a.qbo_id === value ? ' acct-select-active' : ''}`}
                onMouseDown={() => handleSelect(a.qbo_id)}
              >
                {a.fully_qualified_name || a.name}
              </div>
            ))}
          </div>
        ))}
        {otherGroupItems.length > 0 && (
          <div>
            <div className="acct-select-group-label">Other</div>
            {otherGroupItems.map((a) => (
              <div
                key={a.qbo_id}
                className={`acct-select-option${a.qbo_id === value ? ' acct-select-active' : ''}`}
                onMouseDown={() => handleSelect(a.qbo_id)}
              >
                {a.fully_qualified_name || a.name}
              </div>
            ))}
          </div>
        )}
        {filteredExpense.length === 0 && filteredOther.length === 0 && (
          <div className="acct-select-empty">No accounts match "{search}"</div>
        )}
      </div>
    </div>,
    document.body
  );

  return (
    <div className={`acct-select-wrap${warn ? ' acct-select-warn' : ''}`}>
      <button
        ref={btnRef}
        type="button"
        className={`acct-select-btn${!value ? ' acct-select-btn-empty' : ''}`}
        onClick={() => open ? (setOpen(false), setSearch('')) : openDropdown()}
      >
        <span className="acct-select-btn-label">
          {displayLabel || <span className="acct-select-placeholder">{emptyLabel ?? '⚠ No account'}</span>}
        </span>
        <span className="acct-select-caret">{open ? '▴' : '▾'}</span>
      </button>
      {dropdown}
    </div>
  );
}

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

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkAccepting, setBulkAccepting] = useState(false);

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
  const [reapplyingAll, setReapplyingAll] = useState(false);

  // Rule suggestions (generated after user corrects categories)
  const [ruleSuggestions, setRuleSuggestions] = useState([]); // [{name, if_description_contains, then_account_id, ...}]
  const [suggestingRules, setSuggestingRules] = useState(false);

  // Card mappings (Settings tab)
  const [cardMappings, setCardMappings] = useState([]);
  const [cardForm, setCardForm] = useState({ card_last4: '', card_label: '', qbo_account_id: '', personal_use: false });
  const [cardSaving, setCardSaving] = useState(false);

  // Amazon order history
  const [amazonPayments, setAmazonPayments] = useState([]);
  const [amazonStats, setAmazonStats] = useState(null);
  const [amazonUploading, setAmazonUploading] = useState(false);
  const [amazonUploadResult, setAmazonUploadResult] = useState(null);
  const amazonCsvRef = useRef();

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

  // Reload when tab changes and clear selections
  useEffect(() => {
    if (!status?.connected) return;
    if (activeTab === 'amazon') {
      getAmazonPayments().then((d) => setAmazonPayments(d.payments || [])).catch(() => {});
      getAmazonStats().then(setAmazonStats).catch(() => {});
    } else if (activeTab === 'settings') {
      getCardMappings().then((d) => setCardMappings(d.mappings || [])).catch(() => {});
    } else {
      loadReceipts(activeTab); // works for pending/reviewed/imported/excluded
    }
    setSelectedIds(new Set());
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
    // Load Amazon order history stats
    getAmazonPayments().then((d) => setAmazonPayments(d.payments || [])).catch(() => {});
    getAmazonStats().then(setAmazonStats).catch(() => {});
    // Load card mappings
    getCardMappings().then((d) => setCardMappings(d.mappings || [])).catch(() => {});
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
  const [uploadProgress, setUploadProgress] = useState(null); // null | { done, total }

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setUploading(true); setUploadResults(null); setError(''); setMessage('');
    setUploadProgress({ done: 0, total: files.length });

    const BATCH = 25;
    const allResults = [];
    try {
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const result = await uploadReceipts(batch);
        allResults.push(...result.results);
        setUploadProgress({ done: Math.min(i + BATCH, files.length), total: files.length });
      }
      setUploadResults(allResults);
      loadReceipts();
    } catch (e) { setError(e.message); }
    finally { setUploading(false); setUploadProgress(null); fileInputRef.current.value = ''; }
  };

  // ── Review ──
  const [reviewingOriginal, setReviewingOriginal] = useState(null); // snapshot of items at open time

  const openReview = async (receiptId) => {
    setReviewLoading(true); setReviewing(null); setReviewingOriginal(null);
    try {
      const r = await getReceipt(receiptId);
      setReviewing(r);
      setReviewingOriginal(r.items.map((it) => ({ id: it.id, qbo_account_id: it.qbo_account_id, qbo_class_id: it.qbo_class_id })));
    }
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

      // Detect any item where the user assigned or changed the account
      // (regardless of item_status — pending items manually edited count too)
      const corrections = reviewing.items
        .map((it) => {
          const orig = reviewingOriginal?.find((o) => o.id === it.id);
          if (!orig) return null;
          const accountChanged = orig.qbo_account_id !== it.qbo_account_id;
          const classChanged = orig.qbo_class_id !== it.qbo_class_id;
          if (!accountChanged && !classChanged) return null;
          if (!it.qbo_account_id) return null; // user cleared the account — no rule to make
          return {
            description: it.description,
            total: it.total,
            old_account_id: orig.qbo_account_id,
            new_account_id: it.qbo_account_id,
            new_class_id: it.qbo_class_id || null,
          };
        })
        .filter(Boolean);

      setReviewing(null);
      loadReceipts(activeTab);
      setMessage('Receipt review saved.');

      // If the user changed any categories, ask the AI to suggest rules
      if (corrections.length > 0) {
        setSuggestingRules(true);
        try {
          const { suggestions } = await suggestRule(corrections);
          if (suggestions?.length) {
            setRuleSuggestions(suggestions);
          } else {
            setMessage('Receipt review saved. (No rule suggestions generated for these changes.)');
          }
        } catch (err) {
          console.error('Rule suggestion failed:', err);
          setMessage('Receipt review saved. (Rule suggestion unavailable — check console for details.)');
        } finally { setSuggestingRules(false); }
      }
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  // ── Export to QBO ──
  const handleManualSearch = async (shipmentKey, searchDate) => {
    setManualLinks((m) => ({ ...m, [shipmentKey]: { searching: true, results: null, selectedQboId: null } }));
    try {
      const { purchases } = await searchQBOPurchases(defaultAccountId, searchDate);
      setManualLinks((m) => ({ ...m, [shipmentKey]: { searching: false, results: purchases, selectedQboId: null } }));
    } catch (e) {
      setManualLinks((m) => ({ ...m, [shipmentKey]: { searching: false, results: [], selectedQboId: null } }));
      setError(e.message);
    }
  };

  const handleManualSelect = (shipmentKey, qboId) => {
    setManualLinks((m) => ({ ...m, [shipmentKey]: { ...m[shipmentKey], selectedQboId: qboId } }));
    setExportSelections((s) => ({ ...s, [shipmentKey]: !!qboId }));
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
      // Default: check everything that has a match, keyed by shipment_key
      const sel = {};
      previews.forEach((p) => { sel[p.shipment_key] = !!p.match; });
      setExportSelections(sel);
      setExportPreviewing(true);
    } catch (e) { setError(e.message); }
    finally { setExportLoading(false); }
  };

  const handleConfirmExport = async () => {
    const toExport = exportPreviews
      .filter((p) => exportSelections[p.shipment_key])
      .map((p) => {
        const manualQboId = manualLinks[p.shipment_key]?.selectedQboId;
        const qboId = manualQboId || p.match?.qbo_id;
        if (!qboId) return null;
        return {
          receipt_id: p.receipt.id,
          qbo_transaction_id: qboId,
          is_first_shipment: p.is_first_shipment !== false,
          // Pass pre-computed line items for Amazon-backed shipments
          line_items: p.shipment?.line_items || null,
        };
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
        setError(`${failed.length} export(s) failed: ${failed.map((f) => f.error).join('; ')}`);
      }
      setMessage(`Updated ${ok} QBO transaction(s).`);
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

  // ── Bulk accept ──
  const handleBulkAccept = async () => {
    if (!selectedIds.size) return;
    setBulkAccepting(true); setError(''); setMessage('');
    let accepted = 0;
    for (const id of selectedIds) {
      try {
        const r = await acceptAllItems(id);
        accepted += r.accepted;
      } catch (e) {
        console.error('bulk accept failed for', id, e.message);
      }
    }
    setSelectedIds(new Set());
    loadReceipts(activeTab);
    setMessage(`Accepted ${accepted} items across ${selectedIds.size} receipts.`);
    setBulkAccepting(false);
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === receipts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(receipts.map((r) => r.id)));
    }
  };

  // ── Delete receipt ──
  const handleDeleteReceipt = async (receipt) => {
    try {
      await deleteReceipt(receipt.id);
      loadReceipts(activeTab);
      setMessage(`Receipt ${receipt.order_number} removed.`);
    } catch (e) { setError(e.message); }
  };

  // ── Bulk reapply all rules ──
  const handleReapplyAllRules = async () => {
    setReapplyingAll(true); setError(''); setMessage('');
    try {
      const r = await reapplyAllRules();
      setMessage(`Rules re-applied across all receipts — ${r.items_updated} item${r.items_updated !== 1 ? 's' : ''} updated across ${r.receipts_affected} receipt${r.receipts_affected !== 1 ? 's' : ''} (${r.receipts_checked} checked).`);
      loadReceipts(activeTab);
    } catch (e) { setError(e.message); }
    finally { setReapplyingAll(false); }
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

  const handleSaveCardMapping = async (e) => {
    e.preventDefault();
    if (!cardForm.card_last4 || (!cardForm.personal_use && !cardForm.qbo_account_id)) return;
    setCardSaving(true);
    try {
      await saveCardMapping(cardForm);
      const d = await getCardMappings();
      setCardMappings(d.mappings || []);
      setCardForm({ card_last4: '', card_label: '', qbo_account_id: '', personal_use: false });
      setMessage('Card mapping saved.');
    } catch (err) { setError(err.message); }
    finally { setCardSaving(false); }
  };

  const handleDeleteCardMapping = async (id) => {
    try {
      await deleteCardMapping(id);
      setCardMappings((m) => m.filter((c) => c.id !== id));
    } catch (err) { setError(err.message); }
  };

  const handleAmazonCSVUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAmazonUploading(true);
    setAmazonUploadResult(null);
    try {
      const result = await uploadAmazonCSV(file);
      setAmazonUploadResult({ ok: true, ...result });
      // Refresh data
      const [payments, stats] = await Promise.all([getAmazonPayments(), getAmazonStats()]);
      setAmazonPayments(payments.payments || []);
      setAmazonStats(stats);
    } catch (err) {
      setAmazonUploadResult({ ok: false, error: err.message });
    } finally {
      setAmazonUploading(false);
      e.target.value = '';
    }
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
              {uploading
                ? uploadProgress && uploadProgress.total > 25
                  ? <>⏳ Processing… {uploadProgress.done} of {uploadProgress.total}</>
                  : <>⏳ Processing PDFs…</>
                : <>📄 Click to upload Amazon order PDFs (up to 100 at a time)</>}
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
              <button type="button" className={`qb-tab qb-tab-excluded ${activeTab === 'excluded' ? 'active' : ''}`} onClick={() => setActiveTab('excluded')}>Excluded</button>
              <button type="button" className={`qb-tab ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>Settings</button>
              <button type="button" className={`qb-tab ${activeTab === 'amazon' ? 'active' : ''}`} onClick={() => setActiveTab('amazon')}>
                Amazon
                {amazonStats && amazonStats.receipts_total > 0 && (
                  <span className={`qb-tab-badge ${amazonStats.receipts_covered === amazonStats.receipts_total ? 'badge-green' : 'badge-yellow'}`}>
                    {amazonStats.receipts_covered}/{amazonStats.receipts_total}
                  </span>
                )}
              </button>
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

          {activeTab === 'pending' && (
            <div className="qb-bulk-bar">
              {receipts.length > 0 && (
                <label className="qb-bulk-select-all">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === receipts.length && receipts.length > 0}
                    onChange={toggleSelectAll}
                  />
                  {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
                </label>
              )}
              {selectedIds.size > 0 && (
                <button type="button" className="qb-btn-bulk-accept" onClick={handleBulkAccept} disabled={bulkAccepting}>
                  {bulkAccepting ? 'Accepting…' : `✓ Accept Selected (${selectedIds.size})`}
                </button>
              )}
              <button type="button" className="qb-btn-reapply-all" onClick={handleReapplyAllRules} disabled={reapplyingAll}>
                {reapplyingAll ? 'Re-applying…' : '⚙ Reapply All Rules'}
              </button>
            </div>
          )}

          {activeTab === 'settings' ? (
            /* ── Settings Tab ── */
            <div className="qb-settings-section">
              <h3 className="qb-settings-heading">Card → Payment Account Mapping</h3>
              <p className="qb-settings-hint">
                Map each card's last 4 digits to its QuickBooks payment account.
                When exporting, each receipt will automatically search the correct account
                instead of requiring a manual selection.
              </p>

              {/* Existing mappings */}
              {cardMappings.length > 0 && (
                <table className="qb-card-table">
                  <thead>
                    <tr>
                      <th>Last 4</th>
                      <th>Label</th>
                      <th>QBO Payment Account</th>
                      <th>Type</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cardMappings.map((m) => (
                      <tr key={m.id} className={m.personal_use ? 'qb-card-row-personal' : ''}>
                        <td className="qb-card-last4">····{m.card_last4}</td>
                        <td>{m.card_label || <span style={{ color: '#aaa' }}>—</span>}</td>
                        <td className="qb-card-account">
                          {m.personal_use
                            ? <span style={{ color: '#aaa' }}>—</span>
                            : (m.account_full_name || m.account_name || m.qbo_account_id)}
                        </td>
                        <td>
                          {m.personal_use
                            ? <span className="qb-personal-badge">Personal</span>
                            : <span className="qb-business-badge">Business</span>}
                        </td>
                        <td>
                          <button type="button" className="qb-btn-rule-del" onClick={() => handleDeleteCardMapping(m.id)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Add new mapping form */}
              <form className="qb-card-form" onSubmit={handleSaveCardMapping}>
                <h4 className="qb-card-form-heading">{cardMappings.length === 0 ? 'Add your first card' : 'Add another card'}</h4>
                <div className="qb-card-form-row">
                  <div className="qb-form-row">
                    <label>Last 4 digits</label>
                    <input
                      type="text" maxLength={4} placeholder="e.g. 4376"
                      value={cardForm.card_last4}
                      onChange={(e) => setCardForm((f) => ({ ...f, card_last4: e.target.value.replace(/\D/g, '') }))}
                    />
                  </div>
                  <div className="qb-form-row">
                    <label>Label (optional)</label>
                    <input
                      type="text" placeholder="e.g. Craig Visa"
                      value={cardForm.card_label}
                      onChange={(e) => setCardForm((f) => ({ ...f, card_label: e.target.value }))}
                    />
                  </div>
                  {!cardForm.personal_use && (
                    <div className="qb-form-row">
                      <label>QBO Payment Account</label>
                      <select
                        value={cardForm.qbo_account_id}
                        onChange={(e) => setCardForm((f) => ({ ...f, qbo_account_id: e.target.value }))}
                      >
                        <option value="">— select account —</option>
                        {paymentAccounts.map((a) => (
                          <option key={a.qbo_id} value={a.qbo_id}>{a.fully_qualified_name || a.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <button type="submit" className="qb-btn-save"
                    disabled={cardSaving || !cardForm.card_last4 || (!cardForm.personal_use && !cardForm.qbo_account_id)}>
                    {cardSaving ? 'Saving…' : 'Add'}
                  </button>
                </div>
                <label className="qb-checkbox-label">
                  <input
                    type="checkbox"
                    checked={cardForm.personal_use}
                    onChange={(e) => setCardForm((f) => ({ ...f, personal_use: e.target.checked, qbo_account_id: e.target.checked ? '' : f.qbo_account_id }))}
                  />
                  Personal use
                </label>
              </form>

              {/* Show which receipts have card data */}
              <div className="qb-settings-card-coverage">
                <h4>Card Data on Receipts</h4>
                <p className="qb-settings-hint">
                  Card last 4 is extracted from PDFs during upload. Receipts uploaded before this
                  feature was added won't have card data — re-upload them to get it.
                </p>
              </div>
            </div>
          ) : activeTab === 'amazon' ? (
            /* ── Amazon Order History Tab ── */
            <div className="qb-amazon-section">
              {amazonStats && (
                <div className="qb-amazon-stats">
                  <div className="qb-amazon-stat">
                    <span className="qb-amazon-stat-value">{amazonStats.payments_imported}</span>
                    <span className="qb-amazon-stat-label">payments imported</span>
                  </div>
                  <div className="qb-amazon-stat">
                    <span className={`qb-amazon-stat-value ${amazonStats.receipts_covered === amazonStats.receipts_total && amazonStats.receipts_total > 0 ? 'stat-green' : 'stat-yellow'}`}>
                      {amazonStats.receipts_covered}/{amazonStats.receipts_total}
                    </span>
                    <span className="qb-amazon-stat-label">receipts have payment data</span>
                  </div>
                </div>
              )}

              <div className="qb-amazon-upload-row">
                <div>
                  <p className="qb-amazon-hint">
                    Import your Amazon Business order history CSV to enable accurate QBO matching.
                    Amazon charges by shipment, not by order — this data lets us find the exact
                    transaction date and amount in QuickBooks.
                  </p>
                  <p className="qb-amazon-hint">
                    In Amazon Business → Reports → Order History → download a CSV with date range set to cover your receipts.
                  </p>
                </div>
                <div className="qb-amazon-upload-btn-group">
                  <input
                    ref={amazonCsvRef}
                    type="file"
                    accept=".csv"
                    style={{ display: 'none' }}
                    onChange={handleAmazonCSVUpload}
                  />
                  <button
                    type="button"
                    className="qb-btn-amazon-upload"
                    onClick={() => amazonCsvRef.current?.click()}
                    disabled={amazonUploading}
                  >
                    {amazonUploading ? 'Importing…' : '⬆ Import CSV'}
                  </button>
                </div>
              </div>

              {amazonUploadResult && (
                <div className={`qb-amazon-upload-result ${amazonUploadResult.ok ? 'result-ok' : 'result-err'}`}>
                  {amazonUploadResult.ok
                    ? `✓ Imported ${amazonUploadResult.payments_imported} payments from ${amazonUploadResult.rows_parsed} rows`
                    : `Error: ${amazonUploadResult.error}`}
                </div>
              )}

              {amazonPayments.length > 0 && (
                <div className="qb-amazon-table-wrap">
                  <table className="qb-amazon-table">
                    <thead>
                      <tr>
                        <th>Payment Date</th>
                        <th>Amount</th>
                        <th>Card</th>
                        <th>Orders</th>
                        <th>Imported</th>
                      </tr>
                    </thead>
                    <tbody>
                      {amazonPayments.map((p) => (
                        <tr key={p.id}>
                          <td>{p.payment_date ? new Date(p.payment_date.slice(0, 10) + 'T12:00:00').toLocaleDateString() : '—'}</td>
                          <td className="qb-amazon-amount">{p.payment_amount != null ? `$${parseFloat(p.payment_amount).toFixed(2)}` : '—'}</td>
                          <td className="qb-amazon-card">
                            {p.payment_instrument || ''}{p.card_last4 ? ` ····${p.card_last4}` : ''}
                          </td>
                          <td className="qb-amazon-orders">
                            {(p.order_ids || []).map((id) => (
                              <span key={id} className="qb-amazon-order-chip">{id}</span>
                            ))}
                          </td>
                          <td className="qb-amazon-imported">{p.imported_at ? new Date(p.imported_at).toLocaleDateString() : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {amazonPayments.length === 0 && !amazonUploading && (
                <p className="qb-empty">No Amazon payment data imported yet. Upload your order history CSV above.</p>
              )}
            </div>
          ) : receiptsLoading ? (
            <p className="qb-loading">Loading receipts…</p>
          ) : receipts.length === 0 ? (
            <p className="qb-empty">
              {activeTab === 'pending'  && 'No pending receipts. Upload a PDF above or check the Reviewed tab.'}
              {activeTab === 'reviewed' && 'No reviewed receipts. Accept some from the Pending tab.'}
              {activeTab === 'imported' && 'No receipts exported to QuickBooks yet.'}
              {activeTab === 'excluded' && 'No excluded receipts. Mark a card as "Personal use" in Settings to exclude its receipts.'}
            </p>
          ) : (
            <div className="qb-receipt-list">
              {receipts.map((r) => (
                <div key={r.id} className={`qb-receipt-row ${selectedIds.has(r.id) ? 'selected' : ''}`}>
                  {activeTab === 'pending' && (
                    <input type="checkbox" className="qb-row-checkbox"
                      checked={selectedIds.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                    />
                  )}
                  <div className="qb-receipt-main">
                    <div className="qb-receipt-meta">
                      <span className="qb-receipt-order">{r.order_number}</span>
                      <span className="qb-receipt-vendor">{r.vendor}</span>
                      {r.order_date && <span className="qb-receipt-date">{new Date(String(r.order_date).slice(0,10) + 'T12:00:00').toLocaleDateString()}</span>}
                      {activeTab === 'excluded' && r.card_last4 && (
                        <span className="qb-personal-badge" title="This card is marked personal use">
                          Personal ····{r.card_last4}
                        </span>
                      )}
                    </div>
                    {r.descriptions && (
                      <div className="qb-receipt-descs">{r.descriptions}</div>
                    )}
                    {parseInt(r.uncategorized_count) > 0 && (
                      <div className="qb-uncategorized-warning">
                        ⚠ {r.uncategorized_count} item{r.uncategorized_count > 1 ? 's' : ''} missing account
                      </div>
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
                    {(activeTab === 'pending' || activeTab === 'reviewed' || activeTab === 'imported') && (
                      <button type="button" className="qb-btn-reapply" onClick={() => handleReapplyRules(r.id)} disabled={!!reapplying || !!accepting} title="Re-apply categorization rules to all items on this receipt">
                        {reapplying === r.id ? '…' : '⚙'}
                      </button>
                    )}
                    {(activeTab === 'pending' || activeTab === 'reviewed' || activeTab === 'excluded') &&
                      <button type="button" className="qb-btn-delete-receipt" onClick={() => handleDeleteReceipt(r)} title="Remove this receipt">
                        ✕
                      </button>
                    }
                    <button type="button" className="qb-btn-review" onClick={() => openReview(r.id)} disabled={reviewLoading}>
                      {activeTab === 'reviewed' || activeTab === 'excluded' ? 'View' : 'Review'}
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

          {/* ── Rule suggestions from corrections ── */}
          {suggestingRules && (
            <div className="qb-rule-suggestion-banner">
              ✨ Analyzing your corrections to suggest rules…
            </div>
          )}
          {ruleSuggestions.length > 0 && (
            <div className="qb-rule-suggestions">
              <div className="qb-rule-suggestions-header">
                <div>
                  <strong>💡 Suggested rules based on your corrections</strong>
                  <span className="qb-rule-suggestions-sub"> — review and add any that look right</span>
                </div>
                <button type="button" className="qb-btn-dismiss" onClick={() => setRuleSuggestions([])}>Dismiss</button>
              </div>
              {ruleSuggestions.map((s, i) => (
                <div key={i} className="qb-rule-suggestion-row">
                  <div className="qb-rule-suggestion-details">
                    <div className="qb-rule-suggestion-name">{s.name}</div>
                    <div className="qb-rule-suggestion-desc">
                      IF description contains <code>{s.if_description_contains}</code>
                      {s.then_account_id && (
                        <> → <strong>{accounts.find((a) => a.qbo_id === s.then_account_id)?.fully_qualified_name || s.then_account_id}</strong></>
                      )}
                    </div>
                    {s.notes && <div className="qb-rule-suggestion-notes">{s.notes}</div>}
                  </div>
                  <button
                    type="button" className="qb-btn-add-suggestion"
                    onClick={async () => {
                      try {
                        await createRule({ ...s, active: true });
                        setRuleSuggestions((prev) => prev.filter((_, j) => j !== i));
                        loadRules();
                        setMessage(`Rule "${s.name}" added.`);
                      } catch (e) { setError(e.message); }
                    }}
                  >
                    + Add Rule
                  </button>
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
                    <AccountSelect
                      value={ruleForm.then_account_id || null}
                      onChange={(v) => handleRuleFormChange('then_account_id', v || '')}
                      accounts={accounts}
                      placeholder="Search accounts…"
                      emptyLabel="— no override —"
                    />
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

                <div className="qb-export-table-wrap">
                  <table className="qb-export-table">
                    <colgroup>
                      <col className="col-check" />
                      <col className="col-receipt" />
                      <col className="col-date" />
                      <col className="col-total" />
                      <col className="col-match" />
                      <col className="col-cat" />
                      <col className="col-conf" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th></th>
                        <th>Receipt</th>
                        <th>Date</th>
                        <th>Total</th>
                        <th>QBO Match</th>
                        <th>Current Category</th>
                        <th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exportPreviews.map((p) => {
                        const key = p.shipment_key;
                        const checked = !!exportSelections[key];
                        const hasMatch = !!p.match;
                        const ml = manualLinks[key];
                        const searchDate = p.shipment?.payment_date || p.receipt.order_date;
                        const displayDate = p.shipment
                          ? (p.shipment.payment_date
                              ? new Date(String(p.shipment.payment_date).slice(0,10) + 'T12:00:00').toLocaleDateString()
                              : '—')
                          : (p.receipt.order_date
                              ? new Date(String(p.receipt.order_date).slice(0,10) + 'T12:00:00').toLocaleDateString()
                              : '—');
                        const displayAmount = p.shipment
                          ? `$${p.shipment.payment_amount.toFixed(2)}`
                          : `$${parseFloat(p.receipt.total || 0).toFixed(2)}`;

                        return (
                          <tr key={key} className={`qb-export-row ${!hasMatch ? 'no-match' : ''} ${p.shipment && !p.is_first_shipment ? 'shipment-continuation' : ''}`}>
                            <td>
                              <input
                                type="checkbox"
                                checked={checked && (hasMatch || !!ml?.selectedQboId)}
                                disabled={!hasMatch && !ml?.selectedQboId}
                                onChange={(e) => setExportSelections((s) => ({ ...s, [key]: e.target.checked }))}
                              />
                            </td>
                            <td>
                              {p.is_first_shipment !== false && (
                                <div className="qb-receipt-order">{p.receipt.order_number}</div>
                              )}
                              {p.shipment && (
                                <div className="qb-shipment-label">
                                  {p.total_shipments > 1
                                    ? `Shipment ${exportPreviews.filter(x => x.receipt.id === p.receipt.id).indexOf(p) + 1} of ${p.total_shipments}`
                                    : 'Shipment'}
                                  {p.is_first_shipment && p.total_shipments > 1 && (
                                    <span className="qb-pdf-badge" title="PDF will be attached to this shipment">📎</span>
                                  )}
                                </div>
                              )}
                              {p.shipment?.line_items?.length > 0 && (
                                <div className="qb-shipment-items">
                                  {p.shipment.line_items.map((li, i) => (
                                    <div key={i} className="qb-shipment-item">
                                      <span className="qb-shipment-item-desc" title={li.description}>{li.description}</span>
                                      <span className="qb-shipment-item-acct">{li.account_name || '—'}</span>
                                      <span className="qb-shipment-item-amt">${li.item_total.toFixed(2)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                              {displayDate}
                            </td>
                            <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                              {displayAmount}
                            </td>
                            <td style={{ fontSize: '0.85rem' }}>
                              {hasMatch ? (
                                <>
                                  <div>
                                    {new Date(p.match.txn_date).toLocaleDateString()}
                                    {p.days_diff > 0 && <span style={{ color: '#888', marginLeft: 4 }}>({p.days_diff}d off)</span>}
                                    <span style={{ marginLeft: 6, fontWeight: 600 }}>${parseFloat(p.match.total || 0).toFixed(2)}</span>
                                  </div>
                                  {p.match.vendor && <div className="qb-export-cell-truncate" style={{ color: '#777', fontSize: '0.78rem' }} title={p.match.vendor}>{p.match.vendor}</div>}
                                  {p.match.account_match === false && p.match.qbo_account_name && (
                                    <div style={{ color: '#e65100', fontSize: '0.75rem', marginTop: 2 }}>
                                      ⚠ In QBO account: {p.match.qbo_account_name}
                                    </div>
                                  )}
                                </>
                              ) : (() => {
                                const sel = ml?.selectedQboId;
                                const selTxn = sel && ml.results?.find((r) => r.qbo_id === sel);
                                return sel && selTxn ? (
                                  <div>
                                    <div style={{ color: '#1976d2', fontSize: '0.8rem', fontWeight: 600 }}>✓ Linked manually</div>
                                    <div>{new Date(selTxn.txn_date).toLocaleDateString()} · ${parseFloat(selTxn.total).toFixed(2)}</div>
                                  </div>
                                ) : (
                                  <div>
                                    <span className="qb-no-match-label">No match found</span>
                                    {p.reason && <div style={{ fontSize: '0.75rem', color: '#999' }}>{p.reason}</div>}
                                    <div style={{ fontSize: '0.72rem', color: '#b26a00', marginTop: 3 }}>
                                      Tip: accept "For Review" transactions in QBO first.
                                    </div>
                                    <button
                                      type="button" className="qb-btn-manual-link"
                                      onClick={() => handleManualSearch(key, searchDate)}
                                      disabled={ml?.searching}
                                    >
                                      {ml?.searching ? 'Searching…' : ml?.results ? 'Retry' : 'Link manually'}
                                    </button>
                                    {ml?.results && (
                                      <select
                                        className="qb-manual-select"
                                        value={ml.selectedQboId || ''}
                                        onChange={(e) => handleManualSelect(key, e.target.value)}
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
                            <td>
                              {(() => {
                                const cat = hasMatch ? p.match.current_categories
                                  : (ml?.selectedQboId
                                      ? ml.results?.find(r => r.qbo_id === ml.selectedQboId)?.current_categories || '—'
                                      : '—');
                                return <span className="qb-export-cell-truncate" style={{ fontSize: '0.8rem', color: '#555' }} title={cat}>{cat}</span>;
                              })()}
                            </td>
                            <td>
                              {hasMatch ? (
                                <span className={`qb-confidence qb-conf-${p.confidence}`}>
                                  {p.confidence}
                                </span>
                              ) : ml?.selectedQboId ? (
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
                      : `Update ${Object.values(exportSelections).filter(Boolean).length} transaction(s) in QuickBooks`}
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
                          {reviewing.order_date && new Date(String(reviewing.order_date).slice(0,10) + 'T12:00:00').toLocaleDateString()} &nbsp;·&nbsp;
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
                            <tr key={item.id} className={`qb-item-row qb-item-${item.item_status}${!item.qbo_account_id ? ' qb-item-no-account' : ''}`}>
                              <td>
                                <div className="qb-item-desc">{item.description}</div>
                                {item.rule_applied && <div className="qb-item-rule">⚙ Rule: {item.rule_applied}</div>}
                                {!item.rule_applied && item.ai_confidence != null && (
                                  <div className="qb-item-confidence">AI: {Math.round(item.ai_confidence * 100)}%</div>
                                )}
                              </td>
                              <td className="qb-item-total">{item.total != null ? `$${parseFloat(item.total).toFixed(2)}` : '—'}</td>
                              <td>
                                <AccountSelect
                                  value={item.qbo_account_id}
                                  onChange={(v) => handleItemChange(item.id, 'qbo_account_id', v)}
                                  accounts={accounts}
                                  warn={!item.qbo_account_id}
                                />
                              </td>
                              <td>
                                <select
                                  className="qb-item-select"
                                  value={item.qbo_class_id || ''}
                                  onChange={(e) => handleItemChange(item.id, 'qbo_class_id', e.target.value || null)}
                                >
                                  <option value="">— no class —</option>
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
