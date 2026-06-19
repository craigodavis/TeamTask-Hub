import React, { useState, useRef } from 'react';
import { uploadReceipts, getQboImportVendors, previewQboImport, importFromQbo } from '../api';
import './ScanReceipt.css';

// Manual receipt capture for any vendor — PDF or photo. Claude extracts line
// items and suggests accounts & classes, the same pipeline the Amazon email
// sync uses. Moved out of the Receipts page into its own Kitchen item.
export function ScanReceipt() {
  const [uploading, setUploading]         = useState(false);
  const [uploadResults, setUploadResults] = useState(null);
  const [uploadProgress, setProgress]     = useState(null); // null | { done, total }
  const [error, setError]                 = useState('');
  const fileInputRef = useRef();

  // ── QBO Scan Import ──
  const [qboOpen, setQboOpen]                 = useState(false);
  const [qboVendors, setQboVendors]           = useState([]);
  const [qboVendorsLoading, setQboVendorsLoading] = useState(false);
  const [qboVendorId, setQboVendorId]         = useState('');
  const [qboStart, setQboStart]               = useState('');
  const [qboEnd, setQboEnd]                   = useState('');
  const [qboPurchases, setQboPurchases]       = useState(null); // null = not yet searched
  const [qboPurchasesLoading, setQboPurchasesLoading] = useState(false);
  const [qboSelectedIds, setQboSelectedIds]   = useState(new Set());
  const [qboImporting, setQboImporting]       = useState(false);
  const [qboResults, setQboResults]           = useState(null);

  const handleQboToggle = async () => {
    const next = !qboOpen;
    setQboOpen(next);
    if (next && !qboVendors.length) {
      setQboVendorsLoading(true);
      try { setQboVendors(await getQboImportVendors()); }
      catch (e) { setError(e.message); }
      finally { setQboVendorsLoading(false); }
    }
  };

  const handleQboPreview = async () => {
    if (!qboStart || !qboEnd) return setError('Select a date range first');
    setQboPurchasesLoading(true); setQboPurchases(null); setQboSelectedIds(new Set()); setQboResults(null);
    try { setQboPurchases(await previewQboImport({ vendorId: qboVendorId || null, startDate: qboStart, endDate: qboEnd })); }
    catch (e) { setError(e.message); }
    finally { setQboPurchasesLoading(false); }
  };

  const handleQboImport = async () => {
    const ids = [...qboSelectedIds];
    if (!ids.length) return setError('Select at least one transaction to import');
    setQboImporting(true); setQboResults(null);
    try { setQboResults(await importFromQbo(ids)); }
    catch (e) { setError(e.message); }
    finally { setQboImporting(false); }
  };

  const toggleQboPurchase = (id) => {
    setQboSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAllQboPurchases = () => {
    const eligible = (qboPurchases || []).filter((p) => !p.already_imported);
    if (qboSelectedIds.size === eligible.length) setQboSelectedIds(new Set());
    else setQboSelectedIds(new Set(eligible.map((p) => p.id)));
  };

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setUploading(true); setUploadResults(null); setError('');
    setProgress({ done: 0, total: files.length });

    const BATCH = 25;
    const allResults = [];
    try {
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const result = await uploadReceipts(batch);
        allResults.push(...result.results);
        setProgress({ done: Math.min(i + BATCH, files.length), total: files.length });
      }
      setUploadResults(allResults);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      setProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="scan-page">
      <p className="scan-sub">
        Upload a receipt from any vendor — PDF or a photo (JPG/PNG). Claude reads the
        line items and suggests accounts &amp; classes. Good for one-off scans;
        Amazon orders are captured automatically by email.
      </p>

      {error && <p className="scan-error">{error}</p>}

      <div className="scan-upload-area">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          multiple
          id="receipt-upload"
          className="scan-file-input"
          onChange={handleFileChange}
          disabled={uploading}
        />
        <label htmlFor="receipt-upload" className={`scan-upload-label ${uploading ? 'uploading' : ''}`}>
          {uploading
            ? uploadProgress && uploadProgress.total > 25
              ? <>⏳ Processing… {uploadProgress.done} of {uploadProgress.total}</>
              : <>⏳ Processing…</>
            : <>📄 Click to upload receipts — PDF or photo (up to 100 at a time)</>}
        </label>
      </div>

      {uploadResults && (
        <div className="scan-upload-results">
          {uploadResults.map((r, i) => (
            <div key={i} className={`scan-upload-result ${r.error ? 'error' : r.skipped ? 'skipped' : 'ok'}`}>
              <span className="scan-result-file">{r.filename}</span>
              {r.error && <span>❌ {r.error}</span>}
              {r.skipped && <span>⚠️ Duplicate — order {r.order_number} already imported ({r.existing_status})</span>}
              {!r.error && !r.skipped && <span>✅ {r.order_number} · {r.items} items · ${r.total?.toFixed(2)}</span>}
            </div>
          ))}
        </div>
      )}

      {/* ── Import scanned receipts already attached in QuickBooks ── */}
      <div className="qb-section-header" style={{ marginTop: '1.5rem' }}>
        <button type="button" className="qb-btn-toggle" onClick={handleQboToggle}>
          {qboOpen ? '▾' : '▸'} Import Scanned Receipts from QuickBooks
        </button>
      </div>
      {qboOpen && (
        <div className="qb-qbo-import-panel">
          <div className="qbo-import-controls">
            <select
              className="qbo-import-vendor-select"
              value={qboVendorId}
              onChange={(e) => { setQboVendorId(e.target.value); setQboPurchases(null); }}
              disabled={qboVendorsLoading}
            >
              <option value="">{qboVendorsLoading ? 'Loading vendors…' : 'All vendors'}</option>
              {qboVendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            <input type="date" className="qbo-import-date" value={qboStart}
              onChange={(e) => { setQboStart(e.target.value); setQboPurchases(null); }} />
            <span style={{ alignSelf: 'center' }}>to</span>
            <input type="date" className="qbo-import-date" value={qboEnd}
              onChange={(e) => { setQboEnd(e.target.value); setQboPurchases(null); }} />
            <button type="button" className="qb-btn-sync" onClick={handleQboPreview} disabled={qboPurchasesLoading}>
              {qboPurchasesLoading ? 'Searching…' : 'Find Receipts'}
            </button>
          </div>

          {qboPurchases !== null && (
            <>
              {qboPurchases.length === 0 ? (
                <p className="qbo-import-empty">No QBO transactions found for that vendor and date range.</p>
              ) : (
                <>
                  <table className="qbo-import-table">
                    <thead>
                      <tr>
                        <th>
                          <input type="checkbox"
                            checked={qboSelectedIds.size > 0 && qboSelectedIds.size === qboPurchases.filter(p => !p.already_imported).length}
                            onChange={toggleAllQboPurchases} />
                        </th>
                        <th>Date</th>
                        <th>Vendor</th>
                        <th>Total</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {qboPurchases.map((p) => (
                        <tr key={p.id} className={p.already_imported ? 'qbo-row-imported' : ''}>
                          <td>
                            {!p.already_imported && (
                              <input type="checkbox" checked={qboSelectedIds.has(p.id)}
                                onChange={() => toggleQboPurchase(p.id)} />
                            )}
                          </td>
                          <td>{p.date}</td>
                          <td>{p.vendor}{p.memo ? <span className="qbo-memo"> · {p.memo}</span> : null}</td>
                          <td>${p.total.toFixed(2)}</td>
                          <td>{p.already_imported ? <span className="qbo-badge-imported">Imported</span> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {qboSelectedIds.size > 0 && (
                    <button type="button" className="qb-btn-ai-categorize" onClick={handleQboImport} disabled={qboImporting}
                      style={{ marginTop: '0.75rem' }}>
                      {qboImporting ? 'Importing…' : `Import ${qboSelectedIds.size} Receipt${qboSelectedIds.size > 1 ? 's' : ''}`}
                    </button>
                  )}
                </>
              )}
              {qboResults && (
                <div className="scan-upload-results" style={{ marginTop: '0.75rem' }}>
                  {qboResults.map((r, i) => (
                    <div key={i} className={`scan-upload-result ${r.error ? 'error' : r.skipped ? 'skipped' : 'ok'}`}>
                      <span className="scan-result-file">{r.filename || `QBO-${r.purchaseId}`}</span>
                      {r.error && <span>❌ {r.error}</span>}
                      {r.skipped && <span>⚠️ {r.message || 'Skipped'}</span>}
                      {!r.error && !r.skipped && <span>✅ {r.order_number} · {r.items} items · ${r.total?.toFixed(2)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
