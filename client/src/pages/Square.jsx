import React, { useState, useEffect, useCallback } from 'react';
import './Square.css';

// ── Table metadata ──────────────────────────────────────────────────────────
// Maps raw DB table names to display labels and categories.
const TABLE_META = {
  // Core
  merchant:                       { label: 'Merchant',                      category: 'Core' },
  location:                       { label: 'Locations',                     category: 'Core' },
  location_capability:            { label: 'Location Capabilities',         category: 'Core' },

  // Catalog
  catalog_item:                   { label: 'Catalog Items',                 category: 'Catalog' },
  catalog_item_variation:         { label: 'Item Variations',               category: 'Catalog' },
  catalog_category:               { label: 'Categories',                    category: 'Catalog' },
  catalog_item_category:          { label: 'Item–Category Links',           category: 'Catalog' },
  catalog_discount:               { label: 'Discounts',                     category: 'Catalog' },
  catalog_tax:                    { label: 'Taxes',                         category: 'Catalog' },
  catalog_item_tax:               { label: 'Item Tax Links',                category: 'Catalog' },
  catalog_object:                 { label: 'Catalog Objects',               category: 'Catalog' },
  catalog_v_1_id:                 { label: 'Catalog V1 IDs',                category: 'Catalog' },
  item_variation_location_override: { label: 'Variation Location Overrides', category: 'Catalog' },

  // Orders
  order:                          { label: 'Orders',                        category: 'Orders' },
  order_line_item:                { label: 'Order Line Items',              category: 'Orders' },
  order_fulfillment:              { label: 'Fulfillments',                  category: 'Orders' },
  order_service_charge:           { label: 'Service Charges',               category: 'Orders' },
  order_line_item_discount:       { label: 'Line Item Discounts',           category: 'Orders' },
  order_line_item_tax:            { label: 'Line Item Taxes',               category: 'Orders' },
  order_return:                   { label: 'Order Returns',                 category: 'Orders' },
  order_return_line_item:         { label: 'Return Line Items',             category: 'Orders' },
  order_return_discount:          { label: 'Return Discounts',              category: 'Orders' },
  order_return_tax:               { label: 'Return Taxes',                  category: 'Orders' },
  order_return_service_charge:    { label: 'Return Service Charges',        category: 'Orders' },

  // Payments
  payment:                        { label: 'Payments',                      category: 'Payments' },
  payment_processing_fee:         { label: 'Processing Fees',               category: 'Payments' },
  tender:                         { label: 'Tenders',                       category: 'Payments' },
  transaction:                    { label: 'Transactions',                  category: 'Payments' },
  card:                           { label: 'Cards',                         category: 'Payments' },
  card_payment_details:           { label: 'Card Payment Details',          category: 'Payments' },
  refund:                         { label: 'Refunds',                       category: 'Payments' },
  additional_refund_recipient:    { label: 'Refund Recipients',             category: 'Payments' },
  dispute:                        { label: 'Disputes',                      category: 'Payments' },
  bank_account:                   { label: 'Bank Accounts',                 category: 'Payments' },

  // Invoices
  invoice:                        { label: 'Invoices',                      category: 'Invoices' },
  invoice_payment_request:        { label: 'Payment Requests',              category: 'Invoices' },
  invoice_payment_reminder:       { label: 'Payment Reminders',             category: 'Invoices' },
  invoice_recipient:              { label: 'Invoice Recipients',            category: 'Invoices' },

  // Gift Cards
  gift_card:                      { label: 'Gift Cards',                    category: 'Gift Cards' },
  gift_card_activity:             { label: 'Gift Card Activity',            category: 'Gift Cards' },
  gift_card_customer:             { label: 'Gift Card Customers',           category: 'Gift Cards' },

  // Inventory
  inventory_count_history:        { label: 'Inventory Count History',       category: 'Inventory' },

  // Team
  employee:                       { label: 'Employees',                     category: 'Team' },
  employee_elaboration:           { label: 'Employee Details',              category: 'Team' },
  employee_location:              { label: 'Employee Locations',            category: 'Team' },
  employee_wage:                  { label: 'Employee Wages',                category: 'Team' },
  break_type:                     { label: 'Break Types',                   category: 'Team' },
  shift:                          { label: 'Shifts',                        category: 'Team' },
  shift_break:                    { label: 'Shift Breaks',                  category: 'Team' },
  workweek_history:               { label: 'Workweek History',              category: 'Team' },
  x_employee_contact:             { label: 'Employee Contacts',             category: 'Team' },

  // Other
  excise_tax_values:              { label: 'Excise Tax Values',             category: 'Other' },
  custom_make_catalog_w_categories: { label: 'Custom Catalog (Categories)', category: 'Other' },
  x_item_categories:              { label: 'Item Categories (Custom)',      category: 'Other' },
  september:                      { label: 'September (Legacy)',            category: 'Other' },
  untitled_spreadsheet_items:     { label: 'Spreadsheet Import (Legacy)',   category: 'Other' },
};

const CATEGORY_ORDER = ['Core', 'Catalog', 'Orders', 'Payments', 'Invoices', 'Gift Cards', 'Inventory', 'Team', 'Other'];

const CATEGORY_ICONS = {
  Core:       '🏢',
  Catalog:    '📦',
  Orders:     '🧾',
  Payments:   '💳',
  Invoices:   '📄',
  'Gift Cards': '🎁',
  Inventory:  '📊',
  Team:       '👥',
  Other:      '⚙️',
};

function formatCount(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function ninetyDaysAgoStr() {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
}

export function Square() {
  const token = localStorage.getItem('teamtask_token');

  const [tables, setTables]         = useState([]);  // [{ table_name, row_count }]
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [checked, setChecked]       = useState({});  // { table_name: bool }
  const [dateFrom, setDateFrom]     = useState(ninetyDaysAgoStr);
  const [dateTo, setDateTo]         = useState(todayStr);

  // ── Fetch table list ───────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    fetch('/api/square/tables', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) => {
        setTables(data.tables || []);
        // Default: check Core + Orders + Payments
        const defaults = {};
        (data.tables || []).forEach(({ table_name }) => {
          const cat = TABLE_META[table_name]?.category;
          defaults[table_name] = ['Core', 'Orders', 'Payments'].includes(cat);
        });
        setChecked(defaults);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [token]);

  // ── Group tables by category ───────────────────────────────────────────────
  const grouped = React.useMemo(() => {
    const map = {};
    tables.forEach((t) => {
      const cat = TABLE_META[t.table_name]?.category || 'Other';
      if (!map[cat]) map[cat] = [];
      map[cat].push(t);
    });
    return map;
  }, [tables]);

  // ── Checkbox helpers ───────────────────────────────────────────────────────
  const toggleTable = (name) =>
    setChecked((prev) => ({ ...prev, [name]: !prev[name] }));

  const toggleCategory = useCallback((cat) => {
    const catTables = (grouped[cat] || []).map((t) => t.table_name);
    const allOn = catTables.every((n) => checked[n]);
    setChecked((prev) => {
      const next = { ...prev };
      catTables.forEach((n) => (next[n] = !allOn));
      return next;
    });
  }, [grouped, checked]);

  const toggleAll = () => {
    const all = tables.map((t) => t.table_name);
    const allOn = all.every((n) => checked[n]);
    const next = {};
    all.forEach((n) => (next[n] = !allOn));
    setChecked(next);
  };

  const selectedCount = Object.values(checked).filter(Boolean).length;
  const allChecked    = tables.length > 0 && selectedCount === tables.length;
  const anyChecked    = selectedCount > 0;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="sq-page">
      {/* ── Page header ── */}
      <div className="sq-page-header">
        <div className="sq-page-title">
          <span className="sq-logo">◼</span>
          <div>
            <h1>Square Sync</h1>
            <p className="sq-subtitle">Select tables and a date range, then sync data from Square into your database.</p>
          </div>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="sq-toolbar">
        <div className="sq-toolbar-left">
          <div className="sq-date-group">
            <label className="sq-label" htmlFor="sq-date-from">From</label>
            <input
              id="sq-date-from"
              type="date"
              className="sq-date-input"
              value={dateFrom}
              max={dateTo}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <span className="sq-date-sep">→</span>
          <div className="sq-date-group">
            <label className="sq-label" htmlFor="sq-date-to">To</label>
            <input
              id="sq-date-to"
              type="date"
              className="sq-date-input"
              value={dateTo}
              min={dateFrom}
              max={todayStr()}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
        </div>

        <div className="sq-toolbar-right">
          {anyChecked && (
            <span className="sq-selected-badge">{selectedCount} table{selectedCount !== 1 ? 's' : ''} selected</span>
          )}
          <button
            className="sq-sync-btn"
            disabled={true}
            title="Sync capability coming soon"
          >
            ↻ Sync Selected
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      {loading && <div className="sq-state">Loading tables…</div>}
      {error   && <div className="sq-state sq-state-error">⚠ {error}</div>}

      {!loading && !error && (
        <div className="sq-content">
          {/* Select-all row */}
          <div className="sq-select-all-row">
            <label className="sq-check-label">
              <input
                type="checkbox"
                className="sq-checkbox"
                checked={allChecked}
                onChange={toggleAll}
              />
              <span className="sq-select-all-text">
                {allChecked ? 'Deselect all' : 'Select all'} ({tables.length} tables)
              </span>
            </label>
          </div>

          {/* Category groups */}
          {CATEGORY_ORDER.filter((cat) => grouped[cat]?.length > 0).map((cat) => {
            const catTables = grouped[cat];
            const catChecked = catTables.filter((t) => checked[t.table_name]).length;
            const allCatOn   = catChecked === catTables.length;
            const someCatOn  = catChecked > 0 && !allCatOn;

            return (
              <div key={cat} className="sq-group">
                {/* Group header */}
                <div className="sq-group-header">
                  <label className="sq-check-label sq-group-label">
                    <input
                      type="checkbox"
                      className="sq-checkbox"
                      checked={allCatOn}
                      ref={(el) => { if (el) el.indeterminate = someCatOn; }}
                      onChange={() => toggleCategory(cat)}
                    />
                    <span className="sq-group-icon">{CATEGORY_ICONS[cat]}</span>
                    <span className="sq-group-name">{cat}</span>
                    <span className="sq-group-count">{catTables.length} tables</span>
                  </label>
                </div>

                {/* Table rows */}
                <div className="sq-group-body">
                  {catTables.map(({ table_name, row_count }) => {
                    const meta = TABLE_META[table_name];
                    return (
                      <label key={table_name} className={`sq-row ${checked[table_name] ? 'sq-row-checked' : ''}`}>
                        <input
                          type="checkbox"
                          className="sq-checkbox"
                          checked={!!checked[table_name]}
                          onChange={() => toggleTable(table_name)}
                        />
                        <span className="sq-row-label">{meta?.label || table_name}</span>
                        <span className="sq-row-raw">{table_name}</span>
                        <span className="sq-row-count" title="Rows currently in database">
                          {formatCount(row_count)}
                        </span>
                        <span className="sq-row-synced" title="Last synced">—</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
