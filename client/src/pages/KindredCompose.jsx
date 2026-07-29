import React, { useState, useEffect } from 'react';
import { getGroupAudience, sendNotification, getEvents } from '../api';

// What phones actually show. Not enforced — just made visible, because the
// truncation happens on the lock screen where nobody is checking.
const TITLE_LIMIT = 40;
const BODY_LIMIT = 120;

/**
 * Compose and send. The form follows the group's source, because the three kinds
 * genuinely differ: a broadcast is free text, an event send builds its own deep
 * link from the event, and a wine release isn't composed at all — it fires off
 * Commerce7's dates.
 */
export default function KindredCompose({ groups, onSent, onClose }) {
  const sendable = groups.filter((g) => g.active && g.source !== 'club_release');
  const [groupId, setGroupId] = useState(sendable[0]?.id || '');
  const group = groups.find((g) => g.id === groupId);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [eventId, setEventId] = useState('');
  const [events, setEvents] = useState([]);
  const [when, setWhen] = useState('now');       // now | schedule
  const [at, setAt] = useState('');
  const [audience, setAudience] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  // Nobody should send blind. Load the reach for whichever lane is selected.
  useEffect(() => {
    if (!groupId) return;
    setAudience(null);
    getGroupAudience(groupId).then(setAudience).catch(() => setAudience(null));
  }, [groupId]);

  useEffect(() => {
    if (group?.source !== 'event') return;
    // getEvents takes a range STRING; passing an object yields ?range=[object Object].
    getEvents()
      .then((d) => setEvents((d.events || [])
        .filter((e) => new Date(e.start_at) > new Date())
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))))
      .catch(() => setEvents([]));
  }, [group?.source]);

  const titleOver = title.length > TITLE_LIMIT;
  const bodyOver = body.length > BODY_LIMIT;

  async function send() {
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await sendNotification({
        groupId,
        eventId: group?.source === 'event' ? (eventId || undefined) : undefined,
        title: title.trim(),
        body: body.trim(),
        url: url.trim() || undefined,
        ...(when === 'now' ? { sendNow: true } : { scheduledFor: new Date(at).toISOString() }),
      });
      setResult(r.result || { scheduled: true });
      onSent && onSent();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (result) {
    return (
      <div className="kc-done">
        <h3>{result.scheduled ? 'Scheduled' : 'Sent'}</h3>
        {result.scheduled ? (
          <p className="ka-muted">It'll go out at the time you set. You can cancel it until then.</p>
        ) : (
          <p className="ka-muted">
            Delivered to <strong>{result.delivered}</strong> of {result.recipients} device
            {result.recipients === 1 ? '' : 's'}
            {result.pruned ? ` · ${result.pruned} dead subscription${result.pruned === 1 ? '' : 's'} cleaned up` : ''}
            {result.failed ? ` · ${result.failed} failed` : ''}.
          </p>
        )}
        <button className="ka-save" onClick={onClose}>Done</button>
      </div>
    );
  }

  return (
    <div className="kc">
      <div className="kc-head">
        <h3>Send a notification</h3>
        <button className="ka-tab" onClick={onClose}>Cancel</button>
      </div>

      {error && <p className="ka-error">{error}</p>}

      <label className="kc-fld">
        <span>Lane</span>
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          {sendable.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}{g.location_name ? ` — ${g.location_name}` : ''}
            </option>
          ))}
        </select>
      </label>

      {audience && (
        <p className="kc-reach">
          Goes to <strong>{audience.subscriptions}</strong> device
          {audience.subscriptions === 1 ? '' : 's'}
          {audience.subscriptions === 0 && ' — nobody has this lane switched on yet.'}
        </p>
      )}

      {group?.source === 'event' && (
        <label className="kc-fld">
          <span>Event</span>
          <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">— pick one —</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {new Date(ev.start_at).toLocaleDateString()} · {ev.title}
              </option>
            ))}
          </select>
          <small>The link builds itself from the event, straight to its reservation screen.</small>
        </label>
      )}

      <label className="kc-fld">
        <span>Title</span>
        <input type="text" value={title} maxLength={80}
               onChange={(e) => setTitle(e.target.value)} placeholder="Friday: Dusty Rhodes at the Creek" />
        <span className={`kc-count${titleOver ? ' over' : ''}`}>{title.length}/{TITLE_LIMIT}</span>
      </label>

      <label className="kc-fld">
        <span>Message</span>
        <textarea value={body} maxLength={200} onChange={(e) => setBody(e.target.value)}
                  placeholder="6pm, no cover. Tap to reserve a table." />
        <span className={`kc-count${bodyOver ? ' over' : ''}`}>{body.length}/{BODY_LIMIT}</span>
      </label>

      {group?.source !== 'event' && (
        <label className="kc-fld">
          <span>Link <em>(optional)</em></span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
                 placeholder={group?.default_url || 'https://friend.kindredvineyards.com/…'} />
          {group?.default_url && !url && <small>Defaults to {group.default_url}</small>}
        </label>
      )}

      {/* What it will actually look like, since that's where the truncation bites. */}
      <div className="kc-preview">
        <div className="kc-phone">
          <div className="kc-notif">
            <span className="kc-notif-app">Kindred · now</span>
            <div className="kc-notif-title">{title.slice(0, TITLE_LIMIT) || 'Title'}{titleOver && '…'}</div>
            <div className="kc-notif-body">{body.slice(0, BODY_LIMIT) || 'Your message'}{bodyOver && '…'}</div>
          </div>
        </div>
        {(titleOver || bodyOver) && (
          <p className="kc-warn">
            Anything past the cut is hidden until they expand the notification. Most never do.
          </p>
        )}
      </div>

      <div className="kc-when">
        <label><input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} /> Send now</label>
        <label><input type="radio" checked={when === 'schedule'} onChange={() => setWhen('schedule')} /> Schedule</label>
        {when === 'schedule' && (
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        )}
      </div>

      <div className="ka-actions">
        <button className="ka-save" onClick={send}
                disabled={busy || !title.trim() || !body.trim() || (when === 'schedule' && !at)
                          || (group?.source === 'event' && !eventId)}>
          {busy ? 'Sending…' : when === 'now' ? 'Send now' : 'Schedule it'}
        </button>
      </div>
    </div>
  );
}
