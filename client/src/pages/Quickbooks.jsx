import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  getQBOStatus,
  getReceipts, getReceipt, openReceiptPdf, saveReceiptItems, acceptAllItems, deleteReceipt, processReceiptWithAI,
  getPaymentAccounts, savePaymentAccount, previewExport, confirmExport, searchQBOPurchases,
  getRules, createRule, updateRule, deleteRule, reapplyRules, reapplyAllRules, suggestRule, categorizeAllReceipts,
  uploadAmazonCSV, getAmazonPayments, getAmazonStats,
  getCardMappings, saveCardMapping, deleteCardMapping,
  getHarvesterSources, updateHarvesterSource, runHarvesterSource,
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
  is_ai_rule: false, ai_condition: '',
  if_description_contains: '', if_vendor: '', if_account_type_contains: '',
  then_account_id: '', then_class_id: '', then_clear: false,
  notes: '', active: true,
};

export function Quickbooks({ user }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // QBO reference data (for rule dropdowns)
  const [accounts, setAccounts] = useState([]);
  const [classes, setClasses] = useState([]);

  // Receipt list
  const [receipts, setReceipts] = useState([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);

  // Upload

  // Review modal
  const [reviewing, setReviewing] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState('pending');

  // Pending tab filters
  const [pendingSource, setPendingSource] = useState('');
  const [pendingVendor, setPendingVendor] = useState('');

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
  // Editable line items per shipment key (populated from preview, edited inline)
  const [exportLineEdits, setExportLineEdits] = useState({});

  // Accept all
  const [accepting, setAccepting] = useState(null); // receipt id being accepted

  // Re-apply rules
  const [reapplying, setReapplying] = useState(null); // receipt id being reapplied
  const [reapplyingAll, setReapplyingAll] = useState(false);
  const [categorizingAll, setCategorizingAll] = useState(false);

  // Rule suggestions (generated after user corrects categories)
  const [ruleSuggestions, setRuleSuggestions] = useState([]); // [{name, if_description_contains, then_account_id, ...}]
  const [ruleConflicts, setRuleConflicts] = useState(null); // { conflicts, pendingRule, source: 'form'|'suggestion', suggestionIndex }
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
    const resolvedTab = tab || activeTab;
    setReceiptsLoading(true);
    const filters = resolvedTab === 'pending' ? { source: pendingSource, vendor: pendingVendor } : {};
    getReceipts(resolvedTab, filters)
      .then(setReceipts)
      .catch(() => {})
      .finally(() => setReceiptsLoading(false));
  }, [activeTab, pendingSource, pendingVendor]);

  const loadRules = useCallback(() => {
    getRules().then(setRules).catch(() => {});
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Reload pending when filters change
  useEffect(() => {
    if (activeTab === 'pending') loadReceipts('pending');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSource, pendingVendor]);

  // Reload when tab changes and clear selections
  useEffect(() => {
    if (activeTab === 'amazon') {
      if (!status?.connected) return;
      getAmazonPayments().then((d) => setAmazonPayments(d.payments || [])).catch(() => {});
      getAmazonStats().then(setAmazonStats).catch(() => {});
    } else if (activeTab === 'settings') {
      getCardMappings().then((d) => setCardMappings(d.mappings || [])).catch(() => {});
    } else if (activeTab === 'rules') {
      getRules().then((d) => setRules(d.rules || [])).catch(() => {});
    } else if (activeTab === 'harvester') {
      // HarvesterTab loads its own data
    } else {
      // Receipt tabs (pending/reviewed/imported/excluded) don't require QBO to be connected
      loadReceipts(activeTab);
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

  // ── Review ──
  const [reviewingOriginal, setReviewingOriginal] = useState(null); // snapshot of items at open time
  const [processingAI, setProcessingAI] = useState(false);

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

  const WEIGHT_UNITS = { lb: 453.592, oz: 28.3495, g: 1, kg: 1000 };

  function computeGrams(quantity, unit) {
    const factor = WEIGHT_UNITS[unit];
    if (!factor || quantity == null || quantity === '') return null;
    const g = parseFloat(quantity) * factor;
    return isNaN(g) ? null : Math.round(g * 1000) / 1000;
  }

  const handleItemChange = (itemId, field, value) => {
    setReviewing((prev) => ({
      ...prev,
      items: prev.items.map((it) => {
        if (it.id !== itemId) return it;
        const updated = { ...it, [field]: value };
        if (field === 'quantity' || field === 'quantity_unit') {
          updated.quantity_grams = computeGrams(
            field === 'quantity' ? value : it.quantity,
            field === 'quantity_unit' ? value : it.quantity_unit,
          );
        }
        return updated;
      }),
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
  const handleLineAccountChange = (shipmentKey, idx, accountId) => {
    const acct = accounts.find((a) => a.qbo_id === accountId);
    setExportLineEdits((prev) => {
      const items = (prev[shipmentKey] || []).map((li, i) =>
        i === idx ? { ...li, qbo_account_id: accountId || null, account_name: acct?.name || null } : li
      );
      return { ...prev, [shipmentKey]: items };
    });
  };

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
      // Seed editable line items from preview data
      const edits = {};
      previews.forEach((p) => {
        const items = p.shipment?.line_items || p.line_items || [];
        edits[p.shipment_key] = items.map((li) => ({ ...li }));
      });
      setExportLineEdits(edits);
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
          line_items: exportLineEdits[p.shipment_key]?.length
            ? exportLineEdits[p.shipment_key]
            : (p.shipment?.line_items || p.line_items || null),
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

  // ── Bulk AI categorization ──
  const handleCategorizeAll = async () => {
    if (!confirm('Run AI categorization on all pending uncategorized receipts? This may take a minute and will use your Anthropic API credits.')) return;
    setCategorizingAll(true); setError(''); setMessage('');
    try {
      const r = await categorizeAllReceipts();
      setMessage(`AI categorization complete — ${r.items_updated} item${r.items_updated !== 1 ? 's' : ''} categorized across ${r.receipts_processed} receipt${r.receipts_processed !== 1 ? 's' : ''}.`);
      loadReceipts(activeTab);
    } catch (e) { setError(e.message); }
    finally { setCategorizingAll(false); }
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

  const handleSaveRule = async (force = false) => {
    if (!ruleForm.name.trim()) return;
    setRuleSaving(true);
    try {
      if (editingRule === 'new') {
        await createRule({ ...ruleForm, force });
      } else {
        await updateRule(editingRule.id, ruleForm);
      }
      loadRules();
      closeRuleForm();
      setMessage('Rule saved.');
    } catch (e) {
      if (e.conflict) {
        setRuleConflicts({ conflicts: e.conflicts, pendingRule: ruleForm, source: 'form' });
      } else {
        setError(e.message);
      }
    }
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
    const acts = [];
    if (r.then_clear) acts.push('clear suggestion');
    if (r.then_account_name || r.then_account_full_name) acts.push(`account → ${r.then_account_full_name || r.then_account_name}`);
    if (r.then_class_name) acts.push(`class → ${r.then_class_name}`);
    const actStr = acts.join(', ') || '(no action)';
    if (r.is_ai_rule) return `✨ AI: "${r.ai_condition}" → ${actStr}`;
    const conds = [];
    if (r.if_description_contains) conds.push(`description contains "${r.if_description_contains}"`);
    if (r.if_vendor) conds.push(`vendor is "${r.if_vendor}"`);
    if (r.if_account_type_contains) conds.push(`account type contains "${r.if_account_type_contains}"`);
    return `IF ${conds.join(' AND ') || '(any)'} → THEN ${actStr}`;
  };

  if (!isOwner) {
    return <div className="qb-page"><p>Owner access required.</p><Link to="/">Back to dashboard</Link></div>;
  }

  return (
    <div className="qb-page">
      <div className="qb-header"><h2>Receipts</h2></div>

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
          {/* ── Receipt tabs ── */}
          <div className="qb-tabs-row">
            <div className="qb-tabs">
              <button type="button" className={`qb-tab ${activeTab === 'pending' ? 'active' : ''}`} onClick={() => setActiveTab('pending')}>Pending</button>
              <button type="button" className={`qb-tab ${activeTab === 'reviewed' ? 'active' : ''}`} onClick={() => setActiveTab('reviewed')}>Reviewed</button>
              <button type="button" className={`qb-tab ${activeTab === 'imported' ? 'active' : ''}`} onClick={() => setActiveTab('imported')}>Imported</button>
              <button type="button" className={`qb-tab qb-tab-excluded ${activeTab === 'excluded' ? 'active' : ''}`} onClick={() => setActiveTab('excluded')}>Excluded</button>
              <button type="button" className={`qb-tab ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>Payment Mapping</button>
              <button type="button" className={`qb-tab ${activeTab === 'rules' ? 'active' : ''}`} onClick={() => setActiveTab('rules')}>Rules</button>
              <button type="button" className={`qb-tab ${activeTab === 'harvester' ? 'active' : ''}`} onClick={() => setActiveTab('harvester')}>Harvester</button>
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
                  {exportLoading ? 'Searching QBO…' : 'Find QBO Matches'}
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
              <button type="button" className="qb-btn-ai-categorize" onClick={handleCategorizeAll} disabled={categorizingAll}>
                {categorizingAll ? '✨ Categorizing…' : '✨ Run AI Categorization'}
              </button>
              <div className="qb-pending-filters">
                <select
                  className="qb-filter-source"
                  value={pendingSource}
                  onChange={(e) => setPendingSource(e.target.value)}
                >
                  <option value="">All sources</option>
                  <option value="email">Email (Amazon)</option>
                  <option value="upload">Manual upload</option>
                  <option value="csv">CSV import</option>
                  <option value="qbo">QBO import</option>
                </select>
                <input
                  type="text"
                  className="qb-filter-vendor"
                  placeholder="Filter by vendor…"
                  value={pendingVendor}
                  onChange={(e) => setPendingVendor(e.target.value)}
                />
                {(pendingSource || pendingVendor) && (
                  <button
                    type="button"
                    className="qb-filter-clear"
                    onClick={() => { setPendingSource(''); setPendingVendor(''); }}
                  >✕ Clear</button>
                )}
              </div>
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
          ) : activeTab === 'harvester' ? (
            <HarvesterTab />
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
              {activeTab === 'imported' && 'No receipts matched to QuickBooks yet.'}
              {activeTab === 'excluded' && 'No excluded receipts. Mark a card as "Personal use" in Settings to exclude its receipts.'}
            </p>
          ) : (
            <>
              <div className="qb-tab-summary">
                {(() => {
                  const counts = {};
                  for (const r of receipts) {
                    const v = /amazon/i.test(r.vendor) ? 'Amazon'
                            : /sysco/i.test(r.vendor)  ? 'Sysco'
                            : /chef|cash.{0,3}carry/i.test(r.vendor) ? 'Chef Store'
                            : r.vendor || 'Other';
                    counts[v] = (counts[v] || 0) + 1;
                  }
                  const parts = Object.entries(counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([v, n]) => <span key={v} className="qb-summary-vendor">{n} {v}</span>);
                  return (
                    <>
                      <span className="qb-summary-total">{receipts.length} receipts</span>
                      {parts}
                    </>
                  );
                })()}
              </div>
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
                      {(() => {
                        const orderUrl = r.order_number && (
                          r.vendor === 'Amazon'
                            ? `https://www.amazon.com/your-orders/order-details?orderID=${encodeURIComponent(r.order_number)}&ref=ab_ppx_yo_dt_b_fed_order_details`
                          : r.source === 'instacart'
                            ? `https://www.instacart.com/store/orders/${encodeURIComponent(r.order_number)}`
                          : null
                        );
                        return orderUrl ? (
                          <a
                            className="qb-receipt-order qb-receipt-order-link"
                            href={orderUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title={`View this order on ${r.vendor === 'Amazon' ? 'Amazon' : 'Instacart'}`}
                          >
                            {r.order_number}
                          </a>
                        ) : (
                          <span className="qb-receipt-order">{r.order_number}</span>
                        );
                      })()}
                      <span className="qb-receipt-vendor">{r.vendor}</span>
                      {r.source === 'instacart' && (
                        <span
                          className="qb-receipt-channel"
                          title="Purchased through Instacart"
                          style={{ background: '#FF7009', color: '#fff', borderRadius: '4px', padding: '1px 6px', fontSize: '0.72em', fontWeight: 600, whiteSpace: 'nowrap' }}
                        >
                          via Instacart
                        </span>
                      )}
                      {r.order_date && <span className="qb-receipt-date">{new Date(String(r.order_date).slice(0,10) + 'T12:00:00').toLocaleDateString()}</span>}
                      {r.card_last4 && activeTab !== 'excluded' && (
                        <span className="qb-receipt-card">····{r.card_last4}</span>
                      )}
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
                    {r.has_pdf &&
                      <button
                        type="button"
                        className="qb-btn-pdf"
                        onClick={() => openReceiptPdf(r.id).catch((e) => setError(e.message))}
                        title="View the original PDF"
                      >
                        📄 PDF
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
            </>
          )}

          {/* ── Rule suggestions from corrections ── */}
          {suggestingRules && (
            <div className="qb-rule-suggestion-banner">
              ✨ Analyzing your corrections to suggest rules…
            </div>
          )}
          {ruleConflicts && (
            <div className="qb-rule-conflict-banner">
              <div className="qb-rule-conflict-header">
                <strong>⚠ Keyword conflict — existing rule already covers these terms</strong>
                <button type="button" className="qb-btn-dismiss" onClick={() => setRuleConflicts(null)}>✕</button>
              </div>
              {ruleConflicts.conflicts.map((c) => (
                <div key={c.id} className="qb-rule-conflict-row">
                  <span>Rule <strong>"{c.name}"</strong> already matches: <code>{c.shared_keywords.join(', ')}</code></span>
                </div>
              ))}
              <div className="qb-rule-conflict-actions">
                <button type="button" className="qb-btn-secondary" onClick={() => setRuleConflicts(null)}>
                  Cancel — edit the existing rule instead
                </button>
                <button type="button" className="qb-btn-warning" onClick={async () => {
                  try {
                    await createRule({ ...ruleConflicts.pendingRule, force: true });
                    if (ruleConflicts.source === 'suggestion') {
                      setRuleSuggestions((prev) => prev.filter((_, j) => j !== ruleConflicts.suggestionIndex));
                    } else {
                      closeRuleForm();
                    }
                    loadRules();
                    setMessage(`Rule "${ruleConflicts.pendingRule.name}" added.`);
                  } catch (e) { setError(e.message); }
                  finally { setRuleConflicts(null); }
                }}>
                  Add Anyway
                </button>
              </div>
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
                      } catch (e) {
                        if (e.conflict) {
                          setRuleConflicts({ conflicts: e.conflicts, pendingRule: { ...s, active: true }, source: 'suggestion', suggestionIndex: i });
                        } else {
                          setError(e.message);
                        }
                      }
                    }}
                  >
                    + Add Rule
                  </button>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'rules' && (
            <div className="qb-rules-body">
              <p className="qb-section-sub" style={{ marginBottom: '0.75rem' }}>
                Rules run after AI categorization, in priority order (lower number = runs first). First match wins.
              </p>
              <button type="button" className="qb-btn-add-rule" onClick={openNewRule} style={{ marginBottom: '1rem' }}>+ Add Rule</button>
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

                  {/* Rule type toggle */}
                  <div className="qb-form-row">
                    <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
                      <input type="checkbox" checked={!!ruleForm.is_ai_rule} onChange={(e) => handleRuleFormChange('is_ai_rule', e.target.checked)} />
                      <span>✨ AI condition rule <span className="qb-form-hint">(Claude evaluates a natural language question)</span></span>
                    </label>
                  </div>

                  {ruleForm.is_ai_rule ? (
                    <>
                      <div className="qb-form-section">IF (AI condition)</div>
                      <div className="qb-form-row">
                        <label>Ask Claude</label>
                        <input type="text" value={ruleForm.ai_condition} onChange={(e) => handleRuleFormChange('ai_condition', e.target.value)}
                          placeholder='e.g. Is this a food ingredient or food product?' />
                        <span className="qb-form-hint">Claude answers YES/NO for each item. YES → apply the THEN actions below.</span>
                      </div>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}

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
                    <h3>Find QBO Matches — Preview</h3>
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
                                <div className="qb-export-receipt-header">
                                  <span className="qb-export-receipt-vendor">{p.receipt.vendor}</span>
                                  {p.receipt.source === 'instacart' && (
                                    <span style={{ background: '#FF7009', color: '#fff', borderRadius: '4px', padding: '0 5px', fontSize: '0.7em', fontWeight: 600 }}>Instacart</span>
                                  )}
                                  {(() => {
                                    const u = p.receipt.order_number && (
                                      p.receipt.vendor === 'Amazon'
                                        ? `https://www.amazon.com/your-orders/order-details?orderID=${encodeURIComponent(p.receipt.order_number)}&ref=ab_ppx_yo_dt_b_fed_order_details`
                                      : p.receipt.source === 'instacart'
                                        ? `https://www.instacart.com/store/orders/${encodeURIComponent(p.receipt.order_number)}`
                                      : null
                                    );
                                    return u
                                      ? <a className="qb-export-order-num" href={u} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{p.receipt.order_number}</a>
                                      : <span className="qb-export-order-num">{p.receipt.order_number}</span>;
                                  })()}
                                </div>
                              )}
                              {p.shipment && p.total_shipments > 1 && (
                                <div className="qb-shipment-label">
                                  {`Shipment ${exportPreviews.filter(x => x.receipt.id === p.receipt.id).indexOf(p) + 1} of ${p.total_shipments}`}
                                  {p.is_first_shipment && (
                                    <span className="qb-pdf-badge" title="PDF will be attached to this shipment">📎</span>
                                  )}
                                </div>
                              )}
                              {(exportLineEdits[key] || []).length > 0 && (
                                <div className="qb-shipment-items">
                                  {(exportLineEdits[key] || []).map((li, i) => (
                                    <div key={i} className="qb-shipment-item qb-shipment-item-edit">
                                      <div className="qb-shipment-item-desc" title={li.description}>{li.description || '—'}</div>
                                      <div className="qb-shipment-item-controls">
                                        <span className="qb-shipment-item-amt">${parseFloat(li.item_total || 0).toFixed(2)}</span>
                                        <AccountSelect
                                          value={li.qbo_account_id}
                                          onChange={(v) => handleLineAccountChange(key, i, v)}
                                          accounts={accounts}
                                          placeholder="Account…"
                                          warn={!li.qbo_account_id}
                                        />
                                      </div>
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
                        <h3>{reviewing.vendor} — {(() => {
                          const u = reviewing.order_number && (
                            reviewing.vendor === 'Amazon'
                              ? `https://www.amazon.com/your-orders/order-details?orderID=${encodeURIComponent(reviewing.order_number)}&ref=ab_ppx_yo_dt_b_fed_order_details`
                            : reviewing.source === 'instacart'
                              ? `https://www.instacart.com/store/orders/${encodeURIComponent(reviewing.order_number)}`
                            : null
                          );
                          return u
                            ? <a href={u} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>{reviewing.order_number}</a>
                            : reviewing.order_number;
                        })()}{reviewing.source === 'instacart' && <span style={{ background: '#FF7009', color: '#fff', borderRadius: '4px', padding: '1px 6px', fontSize: '0.6em', fontWeight: 600, marginLeft: '8px', verticalAlign: 'middle' }}>via Instacart</span>}</h3>
                        <p className="qb-modal-sub">
                          {reviewing.order_date && new Date(String(reviewing.order_date).slice(0,10) + 'T12:00:00').toLocaleDateString()} &nbsp;·&nbsp;
                          Total: ${parseFloat(reviewing.total || 0).toFixed(2)}
                        </p>
                      </div>
                      <button type="button" className="qb-modal-close" onClick={() => setReviewing(null)}>✕</button>
                    </div>

                    {reviewing.items.length === 0 && (
                      <div className="qb-no-items">
                        <p>No line items extracted yet.</p>
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={processingAI}
                          onClick={async () => {
                            setProcessingAI(true);
                            try {
                              const updated = await processReceiptWithAI(reviewing.id);
                              setReviewing(updated);
                              setReviewingOriginal(updated.items.map((it) => ({ id: it.id, qbo_account_id: it.qbo_account_id, qbo_class_id: it.qbo_class_id })));
                            } catch (e) { setError(e.message); }
                            finally { setProcessingAI(false); }
                          }}
                        >
                          {processingAI ? 'Processing…' : '✨ Process with AI'}
                        </button>
                      </div>
                    )}

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
                                <div className="qb-item-qty-row">
                                  <input
                                    type="number"
                                    className="qb-item-qty-input"
                                    value={item.quantity ?? 1}
                                    min="0"
                                    step="any"
                                    onChange={(e) => handleItemChange(item.id, 'quantity', e.target.value)}
                                  />
                                  <select
                                    className="qb-item-unit-select"
                                    value={item.quantity_unit || 'each'}
                                    onChange={(e) => handleItemChange(item.id, 'quantity_unit', e.target.value)}
                                  >
                                    <option value="each">each</option>
                                    <option value="case">case</option>
                                    <option value="lb">lb</option>
                                    <option value="oz">oz</option>
                                    <option value="g">g</option>
                                    <option value="kg">kg</option>
                                  </select>
                                  {item.quantity_grams != null && (
                                    <span className="qb-item-grams">
                                      = {parseFloat(item.quantity_grams).toLocaleString(undefined, { maximumFractionDigits: 1 })}g
                                    </span>
                                  )}
                                </div>
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

// ── Harvester Tab ─────────────────────────────────────────────────────────────

const SCHEDULE_OPTIONS = [
  { label: 'Every hour',    cron: '0 * * * *' },
  { label: 'Every 2 hours', cron: '0 */2 * * *' },
  { label: 'Every 4 hours', cron: '0 */4 * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours',cron: '0 */12 * * *' },
  { label: 'Daily at 3am',  cron: '0 3 * * *' },
  { label: 'Daily at 6am',  cron: '0 6 * * *' },
];

function HarvesterTab() {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const d = await getHarvesterSources();
      setSources(d.sources || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Refresh status every 15s while a source is running
  useEffect(() => {
    const interval = setInterval(() => {
      if (sources.some(s => s.last_status === 'running' || s.run_requested_at)) {
        load();
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [sources]);

  const handleScheduleChange = async (source, cron) => {
    try {
      const updated = await updateHarvesterSource(source.id, { cron_schedule: cron });
      setSources(prev => prev.map(s => s.id === source.id ? { ...s, ...updated } : s));
      setMessage(`Schedule updated for ${source.name}`);
    } catch (e) { setError(e.message); }
  };

  const handleRunNow = async (source) => {
    setRunning(prev => ({ ...prev, [source.id]: true }));
    setMessage('');
    try {
      const r = await runHarvesterSource(source.id);
      setMessage(r.message);
      setTimeout(load, 5000); // refresh after 5s
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(prev => ({ ...prev, [source.id]: false }));
    }
  };

  const formatTime = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const scheduleLabel = (cron) => {
    const opt = SCHEDULE_OPTIONS.find(o => o.cron === cron);
    return opt ? opt.label : cron;
  };

  if (loading) return <div className="qb-loading">Loading harvester sources…</div>;

  return (
    <div className="harvester-tab">
      <h3>Harvester — Automated Receipt Collection</h3>
      <p className="harvester-desc">Harvester runs on skynet and automatically collects invoices from your email and vendor websites.</p>
      {message && <div className="harvester-message">{message}</div>}
      {error && <div className="harvester-error">{error}</div>}

      <div className="harvester-sources">
        {sources.length === 0 && <p className="hint">No harvester sources configured.</p>}
        {sources.map(source => (
          <div key={source.id} className={`harvester-source-card harvester-status-${source.last_status || 'idle'}`}>
            <div className="harvester-source-header">
              <div>
                <span className="harvester-source-name">{source.name}</span>
                <span className="harvester-source-type">{source.connector_type}</span>
              </div>
              <div className={`harvester-status-badge harvester-status-${source.last_status || 'idle'}`}>
                {source.last_status === 'running' ? '⏳ Running…' :
                 source.run_requested_at ? '⏳ Queued…' :
                 source.last_status === 'ok' ? '✓ OK' :
                 source.last_status === 'error' ? '✗ Error' : 'Idle'}
              </div>
            </div>

            <div className="harvester-source-meta">
              <span>Last run: {formatTime(source.last_run_at)}</span>
              <span>Last success: {formatTime(source.last_success_at)}</span>
              {source.last_records != null && <span>Records: {source.last_records}</span>}
            </div>

            {source.last_error && (
              <div className="harvester-error-detail">{source.last_error}</div>
            )}

            <div className="harvester-source-controls">
              <label className="harvester-schedule-label">
                Schedule:
                <select
                  value={source.cron_schedule}
                  onChange={e => handleScheduleChange(source, e.target.value)}
                >
                  {SCHEDULE_OPTIONS.map(opt => (
                    <option key={opt.cron} value={opt.cron}>{opt.label}</option>
                  ))}
                  {!SCHEDULE_OPTIONS.find(o => o.cron === source.cron_schedule) && (
                    <option value={source.cron_schedule}>{source.cron_schedule}</option>
                  )}
                </select>
              </label>

              <button
                type="button"
                className="btn-primary harvester-run-btn"
                disabled={!!running[source.id] || source.last_status === 'running' || !!source.run_requested_at}
                onClick={() => handleRunNow(source)}
              >
                {running[source.id] ? 'Requesting…' : '▶ Run Now'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
