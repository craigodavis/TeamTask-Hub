import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getLocations, getWineInventoryList, saveWineInventoryCount, transferWineInventory,
         undoWineInventoryCount } from '../api';
import { CASE_SIZE, CASES_PER_ROW } from '../utils/wineInventory';
import './WineInventory.css';

const STATUS_VIEWS = [
  { value: 'uncompleted', label: 'Uncompleted' },
  { value: 'completed',   label: 'Completed' },
  { value: 'all',         label: 'All' },
];

const LOCATION_STORAGE_KEY = 'wine_inventory_last_location';

function matchesSearch(item, term) {
  if (!term) return true;
  const t = term.toLowerCase();
  return (item.name || '').toLowerCase().includes(t) || (item.varietal || '').toLowerCase().includes(t);
}

// Cases/Bottles auto-save a draft in the background as you type (so nothing
// is lost if you navigate away), but that alone never marks a wine
// completed. Only pressing "Done" does — it also auto-normalizes any bottle
// overflow (>= 12) into cases first. This removes all the timing-based
// auto-complete logic that made items disappear unpredictably.
function WineCountCard({ item, locationId, allowsLibrary, onSaved, locations, onTransferred }) {
  // Start empty, not pre-filled with last month's count. A pre-filled box is
  // indistinguishable from one the counter has already filled in, so a wine that
  // was never actually counted silently re-saves last month's number as though it
  // were this month's. Last month's figures show as placeholders instead — visible
  // for reference, impossible to mistake for an entry.
  // Wine in the Winerage is stacked in rows of (usually) 16 cases, so counting
  // "4 rows and 14 cases" is far faster than counting 78 cases. Rows is just a
  // multiplier on the way in — nothing stores rows, so a row that holds 15 cases
  // is simply entered as fewer rows plus loose cases.
  const [rows, setRows] = useState('');
  const [cases, setCases] = useState('');
  const [bottles, setBottles] = useState('');
  // Library is its own pile, counted separately from sellable stock. Regular
  // can be zero while the library holds cases of a wine that has sold out.
  const [libCases, setLibCases] = useState('');
  const [libBottles, setLibBottles] = useState('');
  const [showLibrary, setShowLibrary] = useState(
    (item.library?.cases ?? 0) > 0 || (item.library?.bottles ?? 0) > 0);
  const canLibrary = allowsLibrary !== false;
  const [savedFlash, setSavedFlash] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [moveQty, setMoveQty]   = useState('');
  const [moveTo, setMoveTo]     = useState('');
  const [moving, setMoving]     = useState(false);
  const [moveErr, setMoveErr]   = useState('');
  const [undoing, setUndoing]   = useState(false);

  // Confirms because it rewrites history rather than adding to it: the popped
  // entry is removed from the log the ABC filing reads, so it cannot be dug back
  // out afterwards. Names the figure being discarded so the person can see they
  // are on the wine they think they are — the mistake it exists to fix was
  // counting one wine's cases onto a different wine's card.
  const doUndo = async () => {
    const now = item.last_counted_at
      ? `${item.cases} cases, ${item.bottles} btl (${new Date(item.last_counted_at).toLocaleDateString()})`
      : 'the current entry';
    if (!window.confirm(
      `Undo the last count for ${item.name}?\n\n`
      + `This discards ${now} and brings back whatever was recorded before it.`)) return;
    setUndoing(true);
    try {
      const r = await undoWineInventoryCount({ product_id: item.id, location_id: locationId });
      onTransferred?.();   // same full reload a Move does — the card's figures all moved
      window.alert(r.now_uncounted
        ? `Undone. ${item.name} is back to never counted here.`
        : `Undone. ${item.name} is back to ${r.restored.cases} cases, ${r.restored.bottles} btl`
          + ` from ${new Date(r.restored.counted_at).toLocaleDateString()}.`);
    } catch (e) {
      window.alert(`Could not undo: ${e.message}`);
    } finally { setUndoing(false); }
  };

  const doMove = async () => {
    const n = parseInt(moveQty, 10);
    if (!Number.isFinite(n) || n <= 0) { setMoveErr('How many bottles?'); return; }
    if (!moveTo) { setMoveErr('Pick a destination.'); return; }
    setMoving(true); setMoveErr('');
    try {
      await transferWineInventory({
        product_id: item.id, from_location_id: locationId, to_location_id: moveTo, bottles: n,
      });
      setShowMove(false); setMoveQty(''); setMoveTo('');
      onTransferred?.();
    } catch (e) {
      setMoveErr(e.message);
    } finally { setMoving(false); }
  };
  const timerRef = useRef(null);
  // True once the user actually presses a key in either field — distinguishes
  // "deliberately typed 0" (skip nothing) from "just tapped through without
  // typing anything" (skip the pointless background draft save).
  const touchedRef = useRef(false);

  useEffect(() => {
    setRows('');
    setCases('');
    setBottles('');
    setLibCases('');
    setLibBottles('');
    setShowLibrary((item.library?.cases ?? 0) > 0 || (item.library?.bottles ?? 0) > 0);
    touchedRef.current = false;
  }, [item.id]);

  const persistDraft = async (nextRows, nextCases, nextBottles) => {
    const rowsNum = parseInt(nextRows, 10) || 0;
    const casesNum = parseInt(nextCases, 10) || 0;
    const bottlesNum = parseInt(nextBottles, 10) || 0;
    if (!touchedRef.current && rowsNum === 0 && casesNum === 0 && bottlesNum === 0) return;
    try {
      await saveWineInventoryCount({
        product_id: item.id,
        location_id: locationId,
        rows: nextRows,
        cases: nextCases,
        bottles: nextBottles,
        // Same rule as Done: blank library means "not re-entered", so keep what
        // is stored rather than writing a zero over a standing holding.
        library_cases:   String(libCases).trim()   === '' ? (item.library?.cases   ?? 0) : libCases,
        library_bottles: String(libBottles).trim() === '' ? (item.library?.bottles ?? 0) : libBottles,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 900);
    } catch {
      // Leave the values as typed; the next edit (or Done) will retry.
    }
  };

  const scheduleSave = useCallback((nextRows, nextCases, nextBottles) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => persistDraft(nextRows, nextCases, nextBottles), 500);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const bottleCount = parseInt(bottles, 10) || 0;
  const caseCount = parseInt(cases, 10) || 0;
  const rowCount = parseInt(rows, 10) || 0;

  // The only path that marks a wine completed. Rolls any full case's worth
  // of loose bottles into the case count first, then saves and completes —
  // whatever the values are, even 0/0, since pressing this is unambiguous
  // deliberate intent.
  const handleDone = async () => {
    clearTimeout(timerRef.current);
    // Nothing entered anywhere means nobody counted this wine — save that and it
    // records a zero that looks like a real count. But library is its own pile
    // now, so "no sellable stock, eleven cases in the library" is a complete
    // count with both regular boxes legitimately empty. Only block when all four
    // are blank.
    const anyEntry = [rows, cases, bottles, libCases, libBottles]
      .some((v) => String(v).trim() !== '');
    if (!anyEntry) {
      window.alert(
        `No count entered for ${item.name}.\n\n`
        + `Enter a number — type 0 if there are none left.`);
      return;
    }
    // Rows collapse into cases here rather than being stored, so everything
    // downstream — the ABC filing, the estimate, the history — keeps seeing one
    // number of cases and never has to know how the stack was arranged.
    let finalCases = caseCount + rowCount * CASES_PER_ROW;
    let finalBottles = bottleCount;
    if (finalBottles >= CASE_SIZE) {
      finalCases += Math.floor(finalBottles / CASE_SIZE);
      finalBottles = finalBottles % CASE_SIZE;
    }
    if (finalCases !== caseCount || finalBottles !== bottleCount) {
      setRows('');
      setCases(finalCases);
      setBottles(finalBottles);
    }
    setFinishing(true);
    try {
      await saveWineInventoryCount({
        product_id: item.id,
        location_id: locationId,
        cases: finalCases,
        bottles: finalBottles,
        // Blank means "not re-entered", so keep what is already stored. Library
        // is a standing holding, not a figure recounted from scratch each month —
        // zeroing it because nobody retyped it would quietly lose the stock.
        library_cases:   String(libCases).trim()   === '' ? (item.library?.cases   ?? 0) : libCases,
        library_bottles: String(libBottles).trim() === '' ? (item.library?.bottles ?? 0) : libBottles,
      });
      onSaved(item.id, finalCases, finalBottles);
    } catch {
      setFinishing(false);
      // Leave as-is; user can press Done again to retry.
    }
  };

  return (
    <div className={`wine-count-card${item.counted_today ? ' completed' : ' uncompleted'}${savedFlash ? ' just-saved' : ''}`}>
      <div className="wine-count-info">
        <div className="wine-count-name">
          {item.name}{item.vintage ? ` (${item.vintage})` : ''}
        </div>
        <div className="wine-count-last">
          {item.last_counted_at
            ? `Last: ${item.cases} cases, ${item.bottles} btl — ${new Date(item.last_counted_at).toLocaleDateString()}${item.last_counted_by_name ? ` by ${item.last_counted_by_name}` : ''}`
            : 'Never counted'}
        </div>
        {/* What should be here now. Shown only when there is something to say: an
            estimate equal to the count tells you nothing the line above didn't. */}
        {item.estimate && item.estimate.matched && (
          item.estimate.over_sold ? (
            <div className="wine-est wine-est-over">
              Sold more than counted — {item.estimate.sold_bottles} btl
              {item.estimate.sold_glasses ? ` + ${item.estimate.sold_glasses} glasses` : ''}
              {item.estimate.sold_c7 ? ` + ${item.estimate.sold_c7} club` : ''} since the count
            </div>
          ) : (item.estimate.sold_bottles || item.estimate.sold_glasses || item.estimate.sold_c7) ? (
            <div className="wine-est">
              Should be <strong>{item.estimate.estimated}</strong> — sold {item.estimate.sold_bottles} btl
              {item.estimate.sold_glasses ? `, ${item.estimate.sold_glasses} glasses` : ''}
              {item.estimate.sold_c7 ? `, ${item.estimate.sold_c7} club` : ''} since
            </div>
          ) : null
        )}
        {item.estimate && !item.estimate.matched && item.last_counted_at && (
          <div className="wine-est wine-est-unmatched">
            No sales data — not matched to a Square item
          </div>
        )}
      </div>
      <div className="wine-count-inputs">
        {/* Rows sits first because that is the order you count in: whole rows,
            then the leftover cases, then loose bottles. Labelled with the 16 so
            nobody has to remember the multiplier, and deliberately NOT
            pre-filled from the last count — a stack gets rearranged. */}
        <label className="wine-count-field">
          <span>Rows ({CASES_PER_ROW})</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            placeholder="0"
            value={rows}
            onChange={(e) => { const v = e.target.value; setRows(v); scheduleSave(v, cases, bottles); }}
            onFocus={(e) => e.target.select()}
            onKeyDown={() => { touchedRef.current = true; }}
            onBlur={() => persistDraft(rows, cases, bottles)}
          />
        </label>
        <label className="wine-count-field">
          <span>Cases</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            placeholder={item.last_counted_at ? String(item.cases ?? 0) : '0'}
            value={cases}
            onChange={(e) => { const v = e.target.value; setCases(v); scheduleSave(rows, v, bottles); }}
            onFocus={(e) => e.target.select()}
            onKeyDown={() => { touchedRef.current = true; }}
            onBlur={() => persistDraft(rows, cases, bottles)}
          />
        </label>
        <label className="wine-count-field">
          <span>Bottles</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            placeholder={item.last_counted_at ? String(item.bottles ?? 0) : '0'}
            value={bottles}
            onChange={(e) => { const v = e.target.value; setBottles(v); scheduleSave(rows, cases, v); }}
            onFocus={(e) => e.target.select()}
            onKeyDown={() => { touchedRef.current = true; }}
            onBlur={() => persistDraft(rows, cases, bottles)}
          />
        </label>
        {canLibrary && (
        <button
          type="button"
          className={`wine-count-library-toggle${showLibrary ? ' on' : ''}`}
          onClick={() => setShowLibrary((v) => !v)}
          title="Mark some (or all) of this count as library stock"
        >
          Library
        </button>
        )}
        {/* 4 rows reads as a small number and lands as 768 bottles. Showing the
            total as it is typed is the only chance to notice a slipped digit
            before it becomes a saved count. */}
        {(rowCount > 0 || caseCount > 0 || bottleCount > 0) && (
          <span className="wine-count-total">
            = {rowCount * CASES_PER_ROW + caseCount + Math.floor(bottleCount / CASE_SIZE)} cases
            {(bottleCount % CASE_SIZE) ? ` + ${bottleCount % CASE_SIZE} btl` : ''}
            {' '}({rowCount * CASES_PER_ROW * CASE_SIZE + caseCount * CASE_SIZE + bottleCount} bottles)
          </span>
        )}
        <button
          type="button"
          className="wine-count-done"
          onClick={handleDone}
          disabled={finishing}
          title="Save this count and mark it done (auto-converts bottle overflow into cases)"
        >
          {finishing ? '…' : '✓ Done'}
        </button>
        {locations && locations.length > 1 && (
          <button
            type="button"
            className={`wine-count-library-toggle${showMove ? ' on' : ''}`}
            onClick={() => { setShowMove((v) => !v); setMoveErr(''); }}
            title="Move bottles of this wine to another location — a movement, not a count"
          >
            Move
          </button>
        )}
        {item.last_counted_at && (
          <button
            type="button"
            className="wine-count-undo"
            onClick={doUndo}
            disabled={undoing}
            title="Discard the last count for this wine here and bring back the one before it"
          >
            {undoing ? '…' : 'Undo'}
          </button>
        )}
        {savedFlash && <span className="wine-count-saved">saved</span>}
      </div>

      {showMove && (
        <div className="wine-move-row">
          <label className="wine-count-field">
            <span>Move</span>
            <input type="number" inputMode="numeric" min="1" placeholder="btl"
                   value={moveQty} onChange={(e) => setMoveQty(e.target.value)}
                   onFocus={(e) => e.target.select()} />
          </label>
          <label className="wine-count-field">
            <span>To</span>
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="">Choose…</option>
              {locations.filter((l) => l.id !== locationId)
                        .map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <button type="button" className="wine-count-done" disabled={moving} onClick={doMove}>
            {moving ? '…' : 'Move'}
          </button>
          {moveErr && <span className="wine-move-err">{moveErr}</span>}
          {/* Says plainly that this is not a count — the whole point of recording
              movements separately is that nobody later reads it as one. */}
          <span className="wine-move-hint">Records a movement. Neither location is marked counted.</span>
        </div>
      )}

      {/* Sits directly under the Library button that reveals it, tinted and
          smaller — it is a subset of the count above, not a second count. */}
      {canLibrary && showLibrary && (
        <div className="wine-count-library">
          <span className="wine-count-library-label">
            Library — counted separately, not part of the count above
          </span>
          <div className="wine-count-library-fields">
            <label className="wine-count-field wine-count-field-sm">
              <span>Cases</span>
              <input
                type="number" inputMode="numeric" min="0" value={libCases}
                placeholder={String(item.library?.cases ?? 0)}
                onChange={(e) => { setLibCases(e.target.value); touchedRef.current = true; }}
                onFocus={(e) => e.target.select()}
                onBlur={() => persistDraft(rows, cases, bottles)}
              />
            </label>
            <label className="wine-count-field wine-count-field-sm">
              <span>Bottles</span>
              <input
                type="number" inputMode="numeric" min="0" value={libBottles}
                placeholder={String(item.library?.bottles ?? 0)}
                onChange={(e) => { setLibBottles(e.target.value); touchedRef.current = true; }}
                onFocus={(e) => e.target.select()}
                onBlur={() => persistDraft(rows, cases, bottles)}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

export function WineInventory() {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusView, setStatusView] = useState('uncompleted');
  const [showEmpty, setShowEmpty] = useState(false);
  const [tastings, setTastings] = useState(null);
  const [locInfo, setLocInfo] = useState(null);
  // At a library location the list is the wines flagged as library. This lifts
  // that so a wine found on the racks but never flagged can still be counted —
  // and saving the count flags it, so it is on the list next time.
  const [allWines, setAllWines] = useState(false);

  useEffect(() => {
    getLocations('inventory')
      .then((d) => {
        const locs = d.locations || [];
        setLocations(locs);
        const remembered = localStorage.getItem(LOCATION_STORAGE_KEY);
        // A remembered choice wins — somebody mid-count at the Creek should not be
        // bounced. Otherwise open at the location holding most of the wine rather
        // than whichever sorts first, so the common case needs no click.
        const preferred = locs.find((l) => l.is_default_inventory)?.id || locs[0]?.id;
        const initial = (remembered && locs.some((l) => l.id === remembered)) ? remembered : preferred;
        if (initial) setLocationId(initial);
        else setLoading(false);
      })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const load = useCallback(() => {
    if (!locationId) return;
    setLoading(true);
    setError('');
    getWineInventoryList(locationId, { allWines })
      .then((d) => {
        setItems(d.items || []);
        setTastings(d.tastings || null);
        setLocInfo(d.location || null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [locationId, allWines]);

  useEffect(() => { load(); }, [load]);

  const handleLocationChange = (id) => {
    setLocationId(id);
    // Not carried between locations — it is a deliberate override for one shelf,
    // and leaving it on would quietly show the Winerage every archived vintage.
    setAllWines(false);
    localStorage.setItem(LOCATION_STORAGE_KEY, id);
  };

  const handleSaved = (productId, cases, bottles) => {
    setItems((prev) => prev.map((i) => (i.id === productId ? {
      ...i,
      counted_today: true,
      cases: parseInt(cases, 10) || 0,
      bottles: parseInt(bottles, 10) || 0,
      last_counted_at: new Date().toISOString(),
    } : i)));
  };

  const remaining = items.filter((i) => !i.counted_today).length;
  const counted = items.length - remaining;

  // Live-filtered — completing an item removes it from the Uncompleted view
  // immediately. This never touches which pill is selected (statusView only
  // changes from an explicit tab click), so it can't "flip tabs" on its own.
  const visible = items
    .filter((i) => matchesSearch(i, search))
    .filter((i) => {
      if (statusView === 'uncompleted') return !i.counted_today;
      if (statusView === 'completed') return i.counted_today;
      return true;
    })
    // A wine with no bottles at THIS location is noise on a count sheet. Never
    // hide one already touched today, or it would vanish the moment someone
    // typed a zero; never hide a never-counted wine, which is the opposite of
    // noise. Hidden, not gone — the pill says how many and brings them back.
    .filter((i) => showEmpty || i.counted_today || !i.last_counted_at
                || (i.cases || 0) > 0 || (i.bottles || 0) > 0);

  const emptyCount = items.filter((i) => !i.counted_today && i.last_counted_at
                && (i.cases || 0) === 0 && (i.bottles || 0) === 0).length;

  return (
    <div className="wine-inv-page">
      <h2 className="wine-inv-title">Wine Inventory</h2>

      <div className="wine-inv-header">
        <select value={locationId} onChange={(e) => handleLocationChange(e.target.value)}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input
          type="text"
          placeholder="Search name or varietal…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="wine-inv-status-pills">
          {STATUS_VIEWS.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`wine-inv-pill${statusView === s.value ? ' active' : ''}`}
              onClick={() => setStatusView(s.value)}
            >
              {s.label}
            </button>
          ))}
          {/* Zero-stock wines are hidden, not gone, and the count is on the button.
              Default-hiding stock without a visible way back is how it gets
              forgotten — 23 Homestead sat on this screen with 0 regular bottles
              and 126 in the cellar, which is what started this. */}
          {locInfo?.is_library_only && (
            <button
              type="button"
              className={`wine-inv-pill${allWines ? ' active' : ''}`}
              onClick={() => setAllWines((v) => !v)}
              title="The cellar lists library wines. Turn this on to count one that is not flagged yet — saving its count adds it."
            >
              {allWines ? 'Library only' : 'All wines'}
            </button>
          )}
          {emptyCount > 0 && (
            <button
              type="button"
              className={`wine-inv-pill${showEmpty ? ' active' : ''}`}
              onClick={() => setShowEmpty((v) => !v)}
              title="Wines recorded as zero at this location are hidden by default"
            >
              {showEmpty ? 'Hide empty' : `+${emptyCount} empty`}
            </button>
          )}
        </div>
      </div>

      {items.length > 0 && (
        <p className="wine-inv-progress">{remaining} of {items.length} remaining</p>
      )}

      {/* Says what this list IS, because at the Cellar it is a different list from
          every other location and that would otherwise look like a bug. */}
      {locInfo?.is_library_only && (
        <p className="wine-inv-note">
          {locInfo.name} holds library wine — this lists the {items.length} wine
          {items.length === 1 ? '' : 's'} marked as library
          {allWines ? ', plus every other wine while "All wines" is on' : ''}.
          {' '}Counting a wine here marks it as library.
        </p>
      )}

      {/* Tastings cannot be charged to a wine — "Wine Tasting" is one item and
          nothing records which wines were on the flight. Stated separately rather
          than spread across the estimates to look precise. */}
      {tastings && tastings.units > 0 && (
        <p className="wine-inv-tastings">
          Plus {tastings.units} tastings poured here since {new Date(tastings.since).toLocaleDateString()}
          {' '}(~{tastings.bottles} bottles) — not attributable to any one wine.
        </p>
      )}

      {/* Session summary. A wine that was skipped is invisible once the counter
          has moved past it — the Uncompleted tab shows cards, not a list you can
          scan at the end. Naming what's left is how a miss gets caught now
          rather than when physical stock disagrees months later.
          Hidden until something has been counted, so it isn't noise at the start. */}
      {items.length > 0 && counted > 0 && (
        remaining > 0 ? (
          <div className="wine-inv-summary">
            <p className="wine-inv-summary-head">
              {counted} of {items.length} counted — {remaining} still to go
            </p>
            <div className="wine-inv-summary-list">
              {items.filter((i) => !i.counted_today).map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="wine-inv-summary-chip"
                  onClick={() => { setSearch(i.name); setStatusView('all'); }}
                  title="Jump to this wine"
                >
                  {i.name}{i.vintage ? ` (${i.vintage})` : ''}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="wine-inv-summary wine-inv-summary-done">
            <p className="wine-inv-summary-head">
              All {items.length} wines counted for this location. Count complete.
            </p>
          </div>
        )
      )}

      {error && <p className="wine-inv-error">{error}</p>}

      {loading ? (
        <p className="wine-inv-loading">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="wine-inv-empty">
          {items.length === 0 ? 'No available-for-sale wines found.' : 'Nothing matches the current filters.'}
        </p>
      ) : (
        <div className="wine-count-list">
          {visible.map((item) => (
            <WineCountCard
              key={item.id}
              item={item}
              locationId={locationId}
              locations={locations}
              onTransferred={load}
              allowsLibrary={locations.find((l) => l.id === locationId)?.allows_library !== false}
              onSaved={handleSaved}
            />
          ))}
        </div>
      )}
    </div>
  );
}
