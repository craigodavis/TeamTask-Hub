import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { todayInTimezone } from '../utils/dateUtils';
import './Square.css';

// ── Table metadata ──────────────────────────────────────────────────────────
const TABLE_META = {
  merchant:                         { label: 'Merchant',                      category: 'Core' },
  location:                         { label: 'Locations',                     category: 'Core' },
  location_capability:              { label: 'Location Capabilities',         category: 'Core' },
  catalog_item:                     { label: 'Catalog Items',                 category: 'Catalog' },
  catalog_item_variation:           { label: 'Item Variations',               category: 'Catalog' },
  catalog_category:                 { label: 'Categories',                    category: 'Catalog' },
  catalog_item_category:            { label: 'Item–Category Links',           category: 'Catalog' },
  catalog_discount:                 { label: 'Discounts',                     category: 'Catalog' },
  catalog_tax:                      { label: 'Taxes',                         category: 'Catalog' },
  catalog_item_tax:                 { label: 'Item Tax Links',                category: 'Catalog' },
  catalog_object:                   { label: 'Catalog Objects',               category: 'Catalog' },
  catalog_v_1_id:                   { label: 'Catalog V1 IDs',                category: 'Catalog' },
  item_variation_location_override: { label: 'Variation Location Overrides',  category: 'Catalog' },
  order:                            { label: 'Orders',                        category: 'Orders' },
  order_line_item:                  { label: 'Order Line Items',              category: 'Orders' },
  order_fulfillment:                { label: 'Fulfillments',                  category: 'Orders' },
  order_service_charge:             { label: 'Service Charges',               category: 'Orders' },
  order_line_item_discount:         { label: 'Line Item Discounts',           category: 'Orders' },
  order_line_item_tax:              { label: 'Line Item Taxes',               category: 'Orders' },
  order_return:                     { label: 'Order Returns',                 category: 'Orders' },
  order_return_line_item:           { label: 'Return Line Items',             category: 'Orders' },
  order_return_discount:            { label: 'Return Discounts',              category: 'Orders' },
  order_return_tax:                 { label: 'Return Taxes',                  category: 'Orders' },
  order_return_service_charge:      { label: 'Return Service Charges',        category: 'Orders' },
  payment:                          { label: 'Payments',                      category: 'Payments' },
  payment_processing_fee:           { label: 'Processing Fees',               category: 'Payments' },
  tender:                           { label: 'Tenders',                       category: 'Payments' },
  transaction:                      { label: 'Transactions',                  category: 'Payments' },
  card:                             { label: 'Cards',                         category: 'Payments' },
  card_payment_details:             { label: 'Card Payment Details',          category: 'Payments' },
  refund:                           { label: 'Refunds',                       category: 'Payments' },
  additional_refund_recipient:      { label: 'Refund Recipients',             category: 'Payments' },
  dispute:                          { label: 'Disputes',                      category: 'Payments' },
  bank_account:                     { label: 'Bank Accounts',                 category: 'Payments' },
  invoice:                          { label: 'Invoices',                      category: 'Invoices' },
  invoice_payment_request:          { label: 'Payment Requests',              category: 'Invoices' },
  invoice_payment_reminder:         { label: 'Payment Reminders',             category: 'Invoices' },
  invoice_recipient:                { label: 'Invoice Recipients',            category: 'Invoices' },
  gift_card:                        { label: 'Gift Cards',                    category: 'Gift Cards' },
  gift_card_activity:               { label: 'Gift Card Activity',            category: 'Gift Cards' },
  gift_card_customer:               { label: 'Gift Card Customers',           category: 'Gift Cards' },
  inventory_count_history:          { label: 'Inventory Count History',       category: 'Inventory' },
  employee:                         { label: 'Employees',                     category: 'Team' },
  employee_elaboration:             { label: 'Employee Details',              category: 'Team' },
  employee_location:                { label: 'Employee Locations',            category: 'Team' },
  employee_wage:                    { label: 'Employee Wages',                category: 'Team' },
  break_type:                       { label: 'Break Types',                   category: 'Team' },
  shift:                            { label: 'Shifts',                        category: 'Team' },
  shift_break:                      { label: 'Shift Breaks',                  category: 'Team' },
  workweek_history:                 { label: 'Workweek History',              category: 'Team' },
  x_employee_contact:               { label: 'Employee Contacts',             category: 'Team' },
  excise_tax_values:                { label: 'Excise Tax Values',             category: 'Other' },
  custom_make_catalog_w_categories: { label: 'Custom Catalog (Categories)',   category: 'Other' },
  x_item_categories:                { label: 'Item Categories (Custom)',      category: 'Other' },
  september:                        { label: 'September (Legacy)',            category: 'Other' },
  untitled_spreadsheet_items:       { label: 'Spreadsheet Import (Legacy)',   category: 'Other' },
};

const CATEGORY_ORDER = ['Core', 'Catalog', 'Orders', 'Payments', 'Invoices', 'Gift Cards', 'Inventory', 'Team', 'Other'];
const CATEGORY_ICONS = {
  Core: '🏢', Catalog: '📦', Orders: '🧾', Payments: '💳',
  Invoices: '📄', 'Gift Cards': '🎁', Inventory: '📊', Team: '👥', Other: '⚙️',
};

function formatCount(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}
function ninetyDaysAgoStr(timezone) {
  const d = new Date(); d.setDate(d.getDate() - 90);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}-${parts.find(p=>p.type==='day').value}`;
  } catch { return d.toISOString().slice(0, 10); }
}

// ── Ask Tab ──────────────────────────────────────────────────────────────────
const SUGGESTED = [
  'How many 750ml bottles were sold this year by wine name?',
  'What were total sales by category last month?',
  'Who are our top 10 customers by total spend?',
  'Show me daily revenue for the last 30 days',
  'What is the average order value by month this year?',
];

function formatCell(field, value) {
  if (value == null) return <span className="sq-null">null</span>;
  // Format dollar columns to 2 decimal places
  if (field.endsWith('_dollars') || (field.endsWith('_amount') && !field.includes('currency'))) {
    const n = parseFloat(value);
    if (!isNaN(n)) return `$${n.toFixed(2)}`;
  }
  // Format quantity columns as whole numbers
  if (field === 'quantity' || field.startsWith('quantity') || field.endsWith('_qty') || field.endsWith('_count') || field.endsWith('_quantity')) {
    const n = parseFloat(value);
    if (!isNaN(n)) return Math.round(n).toLocaleString();
  }
  // Format date/timestamp columns as mm/dd/yyyy
  if (field.endsWith('_at') || field.endsWith('_date') || field === 'date' || field.startsWith('date_')) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    }
  }
  return String(value);
}

function ResultTable({ fields, rows }) {
  const [copied, setCopied] = useState(false);

  if (!rows?.length) return <p className="sq-no-results">No results returned.</p>;

  const handleCopy = () => {
    const text = rows
      .map((row) => fields.map((f) => {
        const v = row[f];
        if (v == null) return '';
        return String(v).includes('\t') || String(v).includes('\n') ? `"${v}"` : String(v);
      }).join('\t'))
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="sq-result-table-wrap">
      <table className="sq-result-table">
        <thead>
          <tr>{fields.map((f) => <th key={f}>{f}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {fields.map((f) => <td key={f}>{formatCell(f, row[f])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sq-result-footer">
        <span className="sq-result-count">{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
        <button className="sq-copy-btn" onClick={handleCopy}>
          {copied ? '✓ Copied' : '⎘ Copy'}
        </button>
      </div>
    </div>
  );
}

// ── Voice input hook ─────────────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function useSpeech({ onResult, onError }) {
  const [listening, setListening] = useState(false);
  const recogRef = useRef(null);

  const supported = !!SpeechRecognition;

  const start = useCallback(() => {
    if (!supported || listening) return;
    const recog = new SpeechRecognition();
    recog.lang = 'en-US';
    recog.interimResults = false;
    recog.maxAlternatives = 1;
    recog.continuous = false;

    recog.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      onResult(transcript);
    };
    recog.onerror = (e) => {
      if (e.error !== 'no-speech') onError(e.error);
      setListening(false);
    };
    recog.onend = () => setListening(false);

    recogRef.current = recog;
    recog.start();
    setListening(true);
  }, [supported, listening, onResult, onError]);

  const stop = useCallback(() => {
    recogRef.current?.stop();
    setListening(false);
  }, []);

  return { supported, listening, start, stop };
}

// Minimal, safe Markdown → HTML for AI answers. HTML is escaped first, then only
// our own tags are injected (no raw model HTML survives), so it's XSS-safe.
function mdEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function mdInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');
}
function renderMarkdown(md) {
  const lines = mdEscape(md || '').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lvl = Math.min(h[1].length + 2, 6); out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${mdInline(ul[1])}</li>`); continue; }
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${mdInline(ol[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${mdInline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

const AI_MODELS = [
  { id: 'claude-fable-5',  label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
];

// Which models each role may pick (server enforces this too). Tier: Fable > Opus > Sonnet.
function modelsForRole(role) {
  if (role === 'owner')   return AI_MODELS;
  if (role === 'manager') return AI_MODELS.filter((m) => m.id !== 'claude-fable-5');
  return AI_MODELS.filter((m) => m.id === 'claude-sonnet-5');
}

function AskTab({ token, role }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [messages, setMessages] = useState([]); // { role, content, sql, rows, fields, error }
  const [input, setInput]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [showSql, setShowSql]   = useState({});
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [micError, setMicError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionId, setSessionId] = useState(null);
  const [model, setModel]       = useState('claude-sonnet-5'); // every session starts on Sonnet
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice]     = useState('');
  const [attachments, setAttachments] = useState([]);  // uploaded, awaiting a question
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging]   = useState(false);
  const fileRef   = useRef(null);
  const bottomRef = useRef(null);
  const abortRef  = useRef(null);

  const authFetch = useCallback((url, opts = {}) =>
    fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } }),
  [token]);

  // Ten at a time, newest first. Every chat ever opened used to render at once,
  // which pushed the rest of the page off the bottom of the screen.
  const SESSION_PAGE = 10;

  const loadSessions = useCallback(async (offset = sessionOffset) => {
    try {
      const r = await authFetch(`/api/square/sessions?limit=${SESSION_PAGE}&offset=${offset}`);
      const d = await r.json();
      if (!r.ok) return;
      // A page that has gone empty -- the last chat on it was deleted -- steps
      // back rather than showing an empty sidebar with a live Prev button.
      if (offset > 0 && (d.sessions || []).length === 0) {
        setSessionOffset(Math.max(offset - SESSION_PAGE, 0));
        return;
      }
      setSessions(d.sessions || []);
      setSessionTotal(d.total || 0);
      setSessionOffset(offset);
    } catch { /* ignore */ }
  }, [authFetch, sessionOffset]);

  useEffect(() => { loadSessions(sessionOffset); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [authFetch, sessionOffset]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  const openSession = useCallback(async (id) => {
    try {
      const r = await authFetch(`/api/square/sessions/${id}`);
      const d = await r.json();
      if (!r.ok) return;
      setSessionId(id);
      setMessages((d.messages || []).map((m) => ({ role: m.role, content: m.content, sql: m.sql, rows: m.rows, fields: m.fields })));
      setSidebarOpen(false);
    } catch { /* ignore */ }
  }, [authFetch]);

  // Accept an invite link (?join=<token>)
  useEffect(() => {
    const joinTok = searchParams.get('join');
    if (!joinTok) return;
    (async () => {
      try {
        const r = await authFetch(`/api/square/sessions/join/${joinTok}`, { method: 'POST' });
        const d = await r.json();
        if (r.ok && d.session_id) { await loadSessions(); await openSession(d.session_id); }
      } catch { /* ignore */ }
      const next = new URLSearchParams(searchParams); next.delete('join'); setSearchParams(next, { replace: true });
    })();
  }, [searchParams, authFetch, loadSessions, openSession, setSearchParams]);

  const newChat = () => { setSessionId(null); setMessages([]); setInput(''); setSidebarOpen(false); setModel('claude-sonnet-5'); };

  /**
   * Upload one file and show it as a pending chip.
   *
   * A session is created first when there isn't one, so the file belongs to the
   * conversation from the start -- otherwise a follow-up question would arrive
   * with nothing attached and Claude would be answering about a file it can no
   * longer see.
   */
  const uploadFiles = useCallback(async (files) => {
    const list = [...files];
    if (!list.length) return;
    setNotice('');
    setUploading(true);
    let sid = sessionId;
    if (!sid) {
      try {
        const r = await authFetch('/api/square/sessions', { method: 'POST', body: JSON.stringify({}) });
        const d = await r.json();
        if (r.ok) { sid = d.session.id; setSessionId(sid); }
      } catch { /* fall through — upload still works, just unattached */ }
    }
    for (const file of list) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        if (sid) fd.append('session_id', sid);
        // No Content-Type header: the browser must set the multipart boundary.
        const r = await fetch('/api/square/attachments', {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
        });
        const d = await r.json();
        if (!r.ok) { setNotice(d.error || `Could not upload ${file.name}`); continue; }
        setAttachments((prev) => [...prev, d.attachment]);
      } catch (err) {
        setNotice(`Could not upload ${file.name}: ${err.message}`);
      }
    }
    setUploading(false);
  }, [sessionId, token, authFetch]);

  const removeAttachment = useCallback(async (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try { await authFetch(`/api/square/attachments/${id}`, { method: 'DELETE' }); } catch { /* chip is gone either way */ }
  }, [authFetch]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  // Pasting a screenshot straight into the box is how people actually share one.
  const onPaste = useCallback((e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  }, [uploadFiles]);

  const handleAsk = useCallback(async (question) => {
    const q = (question || input).trim();
    // A file by itself is a question. Only block when there is neither.
    if ((!q && !attachments.length) || loading) return;
    setInput('');
    setLoading(true);

    // Ensure a session exists so the conversation persists.
    let sid = sessionId;
    if (!sid) {
      try {
        const r = await authFetch('/api/square/sessions', { method: 'POST', body: JSON.stringify({}) });
        const d = await r.json();
        if (r.ok) { sid = d.session.id; setSessionId(sid); }
      } catch { /* ignore — ask without persistence */ }
    }

    const sent = attachments;
    setAttachments([]);
    setMessages((prev) => [...prev, { role: 'user', content: q, attachments: sent }]);
    const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const r = await authFetch('/api/square/ask', {
        method: 'POST',
        body: JSON.stringify({ question: q, history, session_id: sid, model: model || null,
                                attachment_ids: sent.map((a) => a.id) }),
        signal: controller.signal,
      });
      const data = await r.json();
      if (!r.ok) {
        setMessages((prev) => [...prev, { role: 'assistant', content: data.error || 'Error', error: data.details, sql: data.sql }]);
      } else {
        let content = data.text || '';
        if (!content && data.rows) content = `${data.count} row${data.count !== 1 ? 's' : ''} returned`;
        setMessages((prev) => [...prev, { role: 'assistant', content, sql: data.sql, rows: data.rows, fields: data.fields, facts_saved: data.facts_saved }]);
      }
      // Asking bumps this chat to newest, so jump to the first page where it
      // now lives rather than leaving the sidebar on a stale page.
      loadSessions(0);
    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages((prev) => [...prev, { role: 'assistant', content: '⏹ Canceled.' }]);
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: 'Request failed', error: err.message }]);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [input, loading, messages, model, sessionId, authFetch, loadSessions]);

  const cancel = () => { abortRef.current?.abort(); };

  const renameSession = async (id, currentTitle) => {
    const title = window.prompt('Rename chat', currentTitle || '');
    if (title == null) return;
    await authFetch(`/api/square/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) });
    loadSessions();
  };
  const deleteSession = async (id) => {
    if (!window.confirm('Delete this chat?')) return;
    await authFetch(`/api/square/sessions/${id}`, { method: 'DELETE' });
    if (id === sessionId) newChat();
    loadSessions();
  };
  const shareSession = async (id) => {
    try {
      const r = await authFetch(`/api/square/sessions/${id}/share`, { method: 'POST' });
      const d = await r.json();
      if (r.ok && d.share_token) {
        const link = `${window.location.origin}/square?join=${d.share_token}`;
        try { await navigator.clipboard.writeText(link); setNotice('Invite link copied to clipboard'); }
        catch { setNotice(link); }
        setTimeout(() => setNotice(''), 5000);
      }
    } catch { /* ignore */ }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(); }
  };

  const toggleSql = (i) => setShowSql((prev) => ({ ...prev, [i]: !prev[i] }));

  const onSpeechResult = useCallback((transcript) => {
    setMicError('');
    setInput(transcript);
  }, []);

  const onSpeechError = useCallback((err) => {
    if (err === 'not-allowed') {
      setMicError('Microphone access denied. Allow mic access in your browser settings.');
    } else {
      setMicError(`Mic error: ${err}`);
    }
  }, []);

  const { supported: micSupported, listening, start: startListening, stop: stopListening } = useSpeech({
    onResult: onSpeechResult,
    onError: onSpeechError,
  });

  const handleMic = () => {
    setMicError('');
    if (listening) stopListening();
    else startListening();
  };

  return (
    <div className="sq-ask-layout">
      <aside className={`sq-sessions${sidebarOpen ? ' open' : ''}`}>
        <button className="sq-new-chat" onClick={newChat}>+ New Session</button>
        <ul className="sq-session-list">
          {sessions.length === 0 && <li className="sq-session-empty">No saved chats yet</li>}
          {sessions.map((s) => (
            <li key={s.id} className={`sq-session-item${s.id === sessionId ? ' active' : ''}`}>
              <button className="sq-session-title" onClick={() => openSession(s.id)}>
                {s.title || 'Untitled chat'}
                {!s.is_owner && <span className="sq-session-shared"> · shared by {s.owner_name}</span>}
              </button>
              {s.is_owner && (
                <span className="sq-session-actions">
                  <button title="Copy invite link" onClick={() => shareSession(s.id)}>🔗</button>
                  <button title="Rename" onClick={() => renameSession(s.id, s.title)}>✎</button>
                  <button title="Delete" onClick={() => deleteSession(s.id)}>🗑</button>
                </span>
              )}
            </li>
          ))}
        </ul>

        {sessionTotal > SESSION_PAGE && (
          <div className="sq-session-pager">
            <button
              type="button"
              disabled={sessionOffset === 0}
              onClick={() => loadSessions(Math.max(sessionOffset - SESSION_PAGE, 0))}
            >
              ‹ Newer
            </button>
            <span className="sq-session-range">
              {sessionOffset + 1}–{Math.min(sessionOffset + SESSION_PAGE, sessionTotal)} of {sessionTotal}
            </span>
            <button
              type="button"
              disabled={sessionOffset + SESSION_PAGE >= sessionTotal}
              onClick={() => loadSessions(sessionOffset + SESSION_PAGE)}
            >
              Older ›
            </button>
          </div>
        )}
      </aside>

      <div className="sq-ask-wrap">
        <div className="sq-ask-toolbar">
          <button className="sq-sessions-toggle" onClick={() => setSidebarOpen((v) => !v)}>☰ Chats</button>
          <select className="sq-model-select" value={model} onChange={(e) => setModel(e.target.value)} title="AI model">
            {modelsForRole(role).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        {notice && <p className="sq-notice">{notice}</p>}
      {/* Suggestions (shown when no messages) */}
      {messages.length === 0 && (
        <div className="sq-suggestions">
          <p className="sq-suggestions-label">Try asking…</p>
          <div className="sq-suggestions-grid">
            {SUGGESTED.map((s) => (
              <button key={s} className="sq-suggestion-btn" onClick={() => handleAsk(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      {/* Message thread */}
      <div className="sq-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`sq-msg sq-msg-${msg.role}`}>
            <div className="sq-msg-bubble">
              {/* What was handed over with this question. Images show; anything
                  else is a link, so a PDF can be reopened from the transcript. */}
              {msg.attachments?.length > 0 && (
                <div className="sq-msg-files">
                  {msg.attachments.map((a) => (
                    a.kind === 'image' ? (
                      <a key={a.id} href={`/api/square/attachments/${a.id}`} target="_blank" rel="noreferrer">
                        <img className="sq-msg-thumb" src={`/api/square/attachments/${a.id}`} alt={a.filename} />
                      </a>
                    ) : (
                      <a key={a.id} className="sq-chip sq-chip-sent"
                         href={`/api/square/attachments/${a.id}`} target="_blank" rel="noreferrer">
                        <span aria-hidden>{a.kind === 'document' ? '📄' : '📃'}</span>
                        <span className="sq-chip-name">{a.filename}</span>
                      </a>
                    )
                  ))}
                </div>
              )}
              {msg.content && (msg.role === 'assistant' ? (
                <div className="sq-msg-text sq-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
              ) : (
                <p className="sq-msg-text">{msg.content}</p>
              ))}
              {msg.role === 'assistant' && msg.content && (
                <button
                  className="sq-copy-btn"
                  title="Copy answer"
                  onClick={() => {
                    navigator.clipboard?.writeText(msg.content);
                    setCopiedIdx(i);
                    setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1500);
                  }}
                >
                  {copiedIdx === i ? '✓ Copied' : '⧉ Copy'}
                </button>
              )}
              {msg.error && <p className="sq-msg-error">{msg.error}</p>}
              {msg.facts_saved?.length > 0 && (
                <div className="sq-facts-saved">
                  <span className="sq-facts-saved-icon">🧠</span>
                  <div>
                    <p className="sq-facts-saved-label">Saved to Knowledge Base:</p>
                    {msg.facts_saved.map((f, fi) => (
                      <p key={fi} className="sq-facts-saved-item">
                        <span className="sq-facts-saved-cat">{f.category}</span> — {f.content}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {msg.sql && (
                <div className="sq-sql-block">
                  <button className="sq-sql-toggle" onClick={() => toggleSql(i)}>
                    {showSql[i] ? '▲ Hide SQL' : '▼ Show SQL'}
                  </button>
                  {showSql[i] && <pre className="sq-sql-pre">{msg.sql}</pre>}
                </div>
              )}
              {msg.rows && <ResultTable fields={msg.fields} rows={msg.rows} />}
            </div>
          </div>
        ))}
        {loading && (
          <div className="sq-msg sq-msg-assistant">
            <div className="sq-msg-bubble sq-msg-thinking">
              <span className="sq-dot" /><span className="sq-dot" /><span className="sq-dot" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Mic error */}
      {micError && <p className="sq-mic-error">{micError}</p>}

      {/* Files waiting to be sent with the next question */}
      {attachments.length > 0 && (
        <div className="sq-attach-tray">
          {attachments.map((a) => (
            <span key={a.id} className="sq-chip" title={`${a.filename} · ${(a.size_bytes/1024).toFixed(0)}KB`}>
              <span className="sq-chip-icon" aria-hidden>
                {a.kind === 'image' ? '🖼' : a.kind === 'document' ? '📄' : '📃'}
              </span>
              <span className="sq-chip-name">{a.filename}</span>
              <button type="button" className="sq-chip-x" onClick={() => removeAttachment(a.id)}
                      title="Remove">×</button>
            </span>
          ))}
          {uploading && <span className="sq-chip sq-chip-busy">Uploading…</span>}
        </div>
      )}

      {/* Input */}
      <div className={`sq-input-row${dragging ? ' sq-dropping' : ''}`}
           onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
           onDragLeave={() => setDragging(false)}
           onDrop={onDrop}>
        <textarea
          className={`sq-input${listening ? ' sq-input-listening' : ''}`}
          rows={2}
          placeholder={dragging ? 'Drop the file here…'
            : listening ? 'Listening…' : 'Ask AiRon anything about Kindred…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          onPaste={onPaste}
          disabled={loading}
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,text/markdown,application/json"
          style={{ display: 'none' }}
          onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
        />
        <button
          className="sq-attach-btn"
          onClick={() => fileRef.current?.click()}
          disabled={loading || uploading}
          title="Attach an image, PDF or text file"
        >📎</button>
        {micSupported && (
          <button
            className={`sq-mic-btn${listening ? ' sq-mic-btn-active' : ''}`}
            onClick={handleMic}
            disabled={loading}
            title={listening ? 'Stop listening' : 'Speak your question'}
          >
            {listening ? '🔴' : '🎤'}
          </button>
        )}
        {loading ? (
          <button className="sq-send-btn sq-cancel-btn" onClick={cancel} title="Cancel query">■</button>
        ) : (
          <button className="sq-send-btn" onClick={() => handleAsk()}
                  disabled={!input.trim() && !attachments.length}>↑</button>
        )}
      </div>
      </div>
    </div>
  );
}

// ── Mappings Tab ─────────────────────────────────────────────────────────────
function MappingsTab({ token }) {
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [seeding, setSeeding]   = useState(false);
  const [seedResult, setSeedResult] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/square/mappings', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => setMappings(d.mappings || []))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleSeed = async () => {
    setSeeding(true); setSeedResult(null);
    try {
      const r = await fetch('/api/square/mappings/seed', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      setSeedResult(d.message || d.error);
      load();
    } catch (err) {
      setSeedResult('Seed failed: ' + err.message);
    } finally {
      setSeeding(false);
    }
  };

  const handleDelete = async (id) => {
    await fetch(`/api/square/mappings/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setMappings((prev) => prev.filter((m) => m.id !== id));
  };

  // Group by category
  const grouped = React.useMemo(() => {
    const map = {};
    mappings.forEach((m) => {
      if (!map[m.category_name]) map[m.category_name] = [];
      map[m.category_name].push(m);
    });
    return map;
  }, [mappings]);

  return (
    <div className="sq-mappings-wrap">
      <div className="sq-mappings-header">
        <div>
          <p className="sq-mappings-desc">
            Pre-2023 catalog items were organized by vintage year rather than format (750ml Bottle, Glass Pour, etc.).
            This table corrects those categories so all historical queries work consistently.
          </p>
        </div>
        <div className="sq-mappings-actions">
          {seedResult && <span className="sq-seed-result">{seedResult}</span>}
          <button className="sq-seed-btn" onClick={handleSeed} disabled={seeding}>
            {seeding ? 'Seeding…' : '⚡ Auto-seed from AiRon data'}
          </button>
        </div>
      </div>

      {loading && <div className="sq-state">Loading mappings…</div>}

      {!loading && mappings.length === 0 && (
        <div className="sq-state">
          No mappings yet. Click <strong>Auto-seed</strong> to populate from AiRon data.
        </div>
      )}

      {!loading && mappings.length > 0 && (
        <div className="sq-mappings-content">
          <p className="sq-mappings-total">{mappings.length} mappings across {Object.keys(grouped).length} categor{Object.keys(grouped).length !== 1 ? 'ies' : 'y'}</p>
          {Object.entries(grouped).map(([cat, items]) => (
            <div key={cat} className="sq-group">
              <div className="sq-group-header">
                <span className="sq-group-name">{cat}</span>
                <span className="sq-group-count">{items.length} items</span>
              </div>
              <div className="sq-group-body">
                {items.map((m) => (
                  <div key={m.id} className="sq-map-row">
                    <div className="sq-map-item-name">{m.item_name || '—'}</div>
                    <div className="sq-map-item-id">{m.catalog_item_id}</div>
                    <div className="sq-map-notes">{m.notes || ''}</div>
                    <button className="sq-map-delete" onClick={() => handleDelete(m.id)} title="Remove mapping">✕</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Journal Tab ──────────────────────────────────────────────────────────────
function JournalTab({ token }) {
  const [entries, setEntries]   = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(true);
  const [offset, setOffset]     = useState(0);
  const [expandSql, setExpandSql]   = useState({});
  const [editNotes, setEditNotes]   = useState({}); // id → draft string
  const [promoting, setPromoting]   = useState({}); // id → bool
  const [promoted, setPromoted]     = useState({}); // id → bool (done)
  const LIMIT = 50;

  const load = useCallback((off = 0) => {
    setLoading(true);
    fetch(`/api/square/journal?limit=${LIMIT}&offset=${off}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        setEntries(d.entries || []);
        setTotal(d.total || 0);
        setOffset(off);
      })
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(0); }, [load]);

  const patch = async (id, body) => {
    const r = await fetch(`/api/square/journal/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const d = await r.json();
      setEntries((prev) => prev.map((e) => (e.id === id ? d.entry : e)));
    }
  };

  const toggleThumb = (entry, val) => {
    // Toggle: clicking same thumb again clears it
    patch(entry.id, { thumbs_up: entry.thumbs_up === val ? null : val });
  };

  const saveNotes = (id) => {
    const notes = editNotes[id] ?? '';
    patch(id, { notes });
    setEditNotes((prev) => { const n = { ...prev }; delete n[id]; return n; });
  };

  const toggleSql = (id) => setExpandSql((prev) => ({ ...prev, [id]: !prev[id] }));

  const promoteToLesson = async (entry) => {
    const content = entry.notes?.trim();
    if (!content) return;
    setPromoting((prev) => ({ ...prev, [entry.id]: true }));
    try {
      const r = await fetch('/api/square/lessons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content, journal_id: entry.id }),
      });
      if (r.ok) setPromoted((prev) => ({ ...prev, [entry.id]: true }));
    } finally {
      setPromoting((prev) => ({ ...prev, [entry.id]: false }));
    }
  };

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="sq-journal-wrap">
      <div className="sq-journal-header">
        <p className="sq-journal-desc">
          Every query is logged here. Use 👍/👎 to rate responses. Add a correction note then hit <strong>⬆ Promote to lesson</strong> to save it permanently to the AI's memory.
        </p>
        {total > 0 && <span className="sq-journal-total">{total} total entries</span>}
      </div>

      {loading && <div className="sq-state">Loading journal…</div>}

      {!loading && entries.length === 0 && (
        <div className="sq-state">No journal entries yet. Ask a question in the Ask tab to get started.</div>
      )}

      {!loading && entries.length > 0 && (
        <>
          <div className="sq-journal-list">
            {entries.map((entry) => {
              const noteDraft = editNotes[entry.id];
              const noteValue = noteDraft !== undefined ? noteDraft : (entry.notes || '');
              const isEditing = noteDraft !== undefined;
              const ts = new Date(entry.created_at).toLocaleString();

              return (
                <div key={entry.id} className={`sq-journal-entry ${entry.success ? 'sq-j-ok' : 'sq-j-fail'}`}>
                  <div className="sq-j-top">
                    <span className={`sq-j-badge ${entry.success ? 'sq-j-badge-ok' : 'sq-j-badge-fail'}`}>
                      {entry.success ? '✓' : '✕'}
                    </span>
                    <span className="sq-j-question">{entry.question}</span>
                    <span className="sq-j-meta">
                      {entry.success && entry.row_count != null && (
                        <span className="sq-j-rows">{entry.row_count} rows</span>
                      )}
                      <span className="sq-j-ts">{ts}</span>
                    </span>
                  </div>

                  {entry.error_message && (
                    <p className="sq-j-error">{entry.error_message}</p>
                  )}

                  {entry.generated_sql && (
                    <div className="sq-sql-block">
                      <button className="sq-sql-toggle" onClick={() => toggleSql(entry.id)}>
                        {expandSql[entry.id] ? '▲ Hide SQL' : '▼ Show SQL'}
                      </button>
                      {expandSql[entry.id] && <pre className="sq-sql-pre">{entry.generated_sql}</pre>}
                    </div>
                  )}

                  <div className="sq-j-bottom">
                    <div className="sq-j-thumbs">
                      <button
                        className={`sq-thumb-btn ${entry.thumbs_up === true ? 'sq-thumb-active-up' : ''}`}
                        onClick={() => toggleThumb(entry, true)}
                        title="Good response"
                      >👍</button>
                      <button
                        className={`sq-thumb-btn ${entry.thumbs_up === false ? 'sq-thumb-active-down' : ''}`}
                        onClick={() => toggleThumb(entry, false)}
                        title="Bad response"
                      >👎</button>
                    </div>
                    <div className="sq-j-notes-area">
                      <textarea
                        className="sq-j-notes"
                        rows={2}
                        placeholder="Add a correction note, then click Promote to save it permanently to the AI's memory…"
                        value={noteValue}
                        onChange={(e) => setEditNotes((prev) => ({ ...prev, [entry.id]: e.target.value }))}
                      />
                      <div className="sq-j-note-actions">
                        {isEditing && (
                          <button className="sq-j-save-btn" onClick={() => saveNotes(entry.id)}>Save</button>
                        )}
                        {entry.notes && !promoted[entry.id] && (
                          <button
                            className="sq-j-promote-btn"
                            onClick={() => promoteToLesson(entry)}
                            disabled={promoting[entry.id]}
                            title="Add this note as a permanent lesson in the Knowledge tab"
                          >
                            {promoting[entry.id] ? '…' : '⬆ Promote to lesson'}
                          </button>
                        )}
                        {promoted[entry.id] && (
                          <span className="sq-j-promoted-badge">✓ Promoted</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="sq-j-pagination">
              <button
                className="sq-j-page-btn"
                disabled={offset === 0}
                onClick={() => load(Math.max(0, offset - LIMIT))}
              >← Prev</button>
              <span className="sq-j-page-info">Page {currentPage} of {totalPages}</span>
              <button
                className="sq-j-page-btn"
                disabled={offset + LIMIT >= total}
                onClick={() => load(offset + LIMIT)}
              >Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Knowledge Tab ────────────────────────────────────────────────────────────
const FACT_CATEGORIES = ['Products', 'Locations', 'Team', 'Seasons & Hours', 'Business Rules', 'General'];

function KnowledgeTab({ token }) {
  const [facts, setFacts]       = useState([]);
  const [lessons, setLessons]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [newCategory, setNewCategory] = useState('Products');
  const [newContent, setNewContent]   = useState('');
  const [adding, setAdding]     = useState(false);
  const [editId, setEditId]     = useState(null);
  const [editContent, setEditContent] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/square/facts',   { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()),
      fetch('/api/square/lessons', { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()),
    ]).then(([fd, ld]) => {
      setFacts(fd.facts || []);
      setLessons(ld.lessons || []);
    }).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const addFact = async () => {
    if (!newContent.trim()) return;
    setAdding(true);
    try {
      const r = await fetch('/api/square/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ category: newCategory, content: newContent.trim() }),
      });
      if (r.ok) {
        const d = await r.json();
        setFacts((prev) => [...prev, d.fact]);
        setNewContent('');
      }
    } finally {
      setAdding(false);
    }
  };

  const toggleFact = async (fact) => {
    const r = await fetch(`/api/square/facts/${fact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ active: !fact.active }),
    });
    if (r.ok) {
      const d = await r.json();
      setFacts((prev) => prev.map((f) => (f.id === fact.id ? d.fact : f)));
    }
  };

  const deleteFact = async (id) => {
    await fetch(`/api/square/facts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setFacts((prev) => prev.filter((f) => f.id !== id));
  };

  const saveEditFact = async (id) => {
    const r = await fetch(`/api/square/facts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: editContent }),
    });
    if (r.ok) {
      const d = await r.json();
      setFacts((prev) => prev.map((f) => (f.id === id ? d.fact : f)));
    }
    setEditId(null);
  };

  const toggleLesson = async (lesson) => {
    const r = await fetch(`/api/square/lessons/${lesson.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ active: !lesson.active }),
    });
    if (r.ok) {
      const d = await r.json();
      setLessons((prev) => prev.map((l) => (l.id === lesson.id ? d.lesson : l)));
    }
  };

  const deleteLesson = async (id) => {
    await fetch(`/api/square/lessons/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setLessons((prev) => prev.filter((l) => l.id !== id));
  };

  // Group facts by category
  const grouped = React.useMemo(() => {
    const map = {};
    facts.forEach((f) => {
      if (!map[f.category]) map[f.category] = [];
      map[f.category].push(f);
    });
    return map;
  }, [facts]);

  const activeFacts   = facts.filter((f) => f.active).length;
  const activeLessons = lessons.filter((l) => l.active).length;

  return (
    <div className="sq-knowledge-wrap">

      {/* ── Add fact ── */}
      <div className="sq-knowledge-add">
        <div className="sq-knowledge-add-title">
          <span className="sq-knowledge-brain">🧠</span>
          <div>
            <h3>Business Knowledge</h3>
            <p>Facts added here are <strong>always</strong> in the AI's context — it will never forget them.</p>
          </div>
        </div>
        <div className="sq-knowledge-form">
          <select
            className="sq-knowledge-cat-select"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
          >
            {FACT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <textarea
            className="sq-knowledge-input"
            rows={2}
            placeholder={`e.g. "Red wines: Mama's Merlot, Canyon Cabernet, Syrah Reserve, Petit Verdot"`}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addFact(); }}
          />
          <button
            className="sq-knowledge-add-btn"
            onClick={addFact}
            disabled={adding || !newContent.trim()}
          >
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
      </div>

      {loading && <div className="sq-state">Loading…</div>}

      {!loading && (
        <div className="sq-knowledge-body">

          {/* ── Facts list ── */}
          <div className="sq-knowledge-section">
            <div className="sq-knowledge-section-header">
              <span className="sq-knowledge-section-title">Facts</span>
              <span className="sq-knowledge-section-count">{activeFacts} active / {facts.length} total</span>
            </div>

            {facts.length === 0 && (
              <p className="sq-knowledge-empty">No facts yet. Add one above to get started.</p>
            )}

            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat} className="sq-knowledge-group">
                <div className="sq-knowledge-group-label">{cat}</div>
                {items.map((f) => (
                  <div key={f.id} className={`sq-knowledge-row ${!f.active ? 'sq-knowledge-row-inactive' : ''}`}>
                    {editId === f.id ? (
                      <>
                        <textarea
                          className="sq-knowledge-edit-input"
                          rows={2}
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          autoFocus
                        />
                        <div className="sq-knowledge-row-actions">
                          <button className="sq-knowledge-save-btn" onClick={() => saveEditFact(f.id)}>Save</button>
                          <button className="sq-knowledge-cancel-btn" onClick={() => setEditId(null)}>Cancel</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className={`sq-knowledge-active-dot ${f.active ? 'sq-dot-on' : 'sq-dot-off'}`} title={f.active ? 'Active' : 'Disabled'} />
                        <span className="sq-knowledge-content">{f.content}</span>
                        <div className="sq-knowledge-row-actions">
                          <button className="sq-knowledge-icon-btn" onClick={() => { setEditId(f.id); setEditContent(f.content); }} title="Edit">✎</button>
                          <button className="sq-knowledge-icon-btn" onClick={() => toggleFact(f)} title={f.active ? 'Disable' : 'Enable'}>
                            {f.active ? '○' : '●'}
                          </button>
                          <button className="sq-knowledge-icon-btn sq-knowledge-delete-btn" onClick={() => deleteFact(f.id)} title="Delete">✕</button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* ── Lessons list ── */}
          {lessons.length > 0 && (
            <div className="sq-knowledge-section">
              <div className="sq-knowledge-section-header">
                <span className="sq-knowledge-section-title">Curated Lessons</span>
                <span className="sq-knowledge-section-count">{activeLessons} active / {lessons.length} total · promoted from Journal</span>
              </div>
              {lessons.map((l) => (
                <div key={l.id} className={`sq-knowledge-row ${!l.active ? 'sq-knowledge-row-inactive' : ''}`}>
                  <span className={`sq-knowledge-active-dot ${l.active ? 'sq-dot-on' : 'sq-dot-off'}`} />
                  <div className="sq-knowledge-lesson-body">
                    <span className="sq-knowledge-content">{l.content}</span>
                    {l.source_question && (
                      <span className="sq-knowledge-lesson-source">from: "{l.source_question.slice(0, 80)}"</span>
                    )}
                  </div>
                  <div className="sq-knowledge-row-actions">
                    <button className="sq-knowledge-icon-btn" onClick={() => toggleLesson(l)} title={l.active ? 'Disable' : 'Enable'}>
                      {l.active ? '○' : '●'}
                    </button>
                    <button className="sq-knowledge-icon-btn sq-knowledge-delete-btn" onClick={() => deleteLesson(l.id)} title="Delete">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Square Page ─────────────────────────────────────────────────────────
export function Square() {
  const { user, timezone } = useOutletContext();
  const token = localStorage.getItem('teamtask_token');
  const [tab, setTab] = useState('ask');

  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const ALL_TABS = [
    { id: 'ask',       label: '✦ Ask AiRon',   managerOnly: false },
    { id: 'knowledge', label: '🧠 Knowledge',   managerOnly: true  },
    { id: 'mappings',  label: '⟳ Mappings',     managerOnly: true  },
    { id: 'journal',   label: '📓 Journal',     managerOnly: true  },
  ];

  const TABS = ALL_TABS.filter((t) => !t.managerOnly || isManager);

  return (
    <div className="sq-page">
      <div className="sq-page-header">
        <div className="sq-page-title">
          <span className="sq-logo">✨</span>
          <div>
            <h1>Kindred AI</h1>
            <p className="sq-subtitle">Ask AiRon anything about Kindred.</p>
          </div>
        </div>
        <div className="sq-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`sq-tab ${tab === t.id ? 'sq-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sq-tab-body">
        {tab === 'ask'       && <AskTab       token={token} role={user?.role} />}
        {tab === 'knowledge' && <KnowledgeTab token={token} />}
        {tab === 'mappings'  && <MappingsTab  token={token} />}
        {tab === 'journal'   && <JournalTab   token={token} />}
      </div>
    </div>
  );
}
