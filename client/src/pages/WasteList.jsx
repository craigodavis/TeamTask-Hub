import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getFoodWasteEntries, createFoodWasteEntry } from '../api';
import './WasteList.css';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function thirtyDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export function WasteList({ user }) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createTitle, setCreateTitle] = useState('Waste log');
  const [createDate, setCreateDate] = useState(todayStr());
  const [creating, setCreating] = useState(false);

  const loadEntries = useCallback(() => {
    setLoading(true);
    getFoodWasteEntries(thirtyDaysAgo(), todayStr())
      .then((r) => setEntries(r.entries || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    if (!createDate || !createDate.trim()) {
      setError('Date is required.');
      return;
    }
    setCreating(true);
    try {
      const created = await createFoodWasteEntry(createTitle.trim() || 'Waste log', createDate.trim());
      loadEntries();
      setCreateTitle('Waste log');
      setCreateDate(todayStr());
      navigate(`/waste/${created.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="waste-list-page">
      <header className="waste-list-header">
        <Link to="/">← Dashboard</Link>
        <h1>Food waste</h1>
      </header>
      {error && <p className="waste-list-error">{error}</p>}

      <section className="waste-list-create">
        <h2>New waste log</h2>
        <form onSubmit={handleCreate} className="waste-create-form">
          <label>
            Name
            <input
              type="text"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="Waste log"
            />
          </label>
          <label>
            Date <span className="required">*</span>
            <input
              type="date"
              value={createDate}
              onChange={(e) => setCreateDate(e.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create waste log'}</button>
        </form>
      </section>

      <section className="waste-list-entries">
        <h2>Waste logs</h2>
        {loading ? (
          <p>Loading…</p>
        ) : entries.length === 0 ? (
          <p className="empty">No waste logs yet. Create one above.</p>
        ) : (
          <ul className="waste-list">
            {entries.map((e) => (
              <li key={e.id}>
                <Link to={`/waste/${e.id}`}>
                  {e.title} – {e.entry_date}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
