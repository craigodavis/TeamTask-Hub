/**
 * The Crew — everyone's own profile, and (for managers) everyone else's.
 *
 * Deliberately not a manager screen with a read-only mode bolted on. The default
 * view is "your profile", because for most of the staff that is the entire point
 * of the page; the roster underneath is context, not a management console. What a
 * manager gets is the ability to open somebody else's card and an Approve button.
 *
 * Publication needs three things to line up and the UI says so plainly, because
 * "I filled it in, why am I not on the website" is the obvious support question:
 * the person consents, a manager approves, and Square still lists them as active.
 */
import { useEffect, useState } from 'react';
import {
  getCrew, getMyCrewProfile, saveMyCrewProfile, setMyCrewConsent,
  uploadMyCrewPhoto, removeMyCrewPhoto, saveCrewProfile, approveCrewProfile,
} from '../api';

const wrap = { padding: '20px 24px 60px', maxWidth: 1080, margin: '0 auto' };
const card = { background: '#fff', border: '1px solid #e6e2da', borderRadius: 12, padding: 20, marginBottom: 20 };
const lbl = { display: 'block', fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase', color: '#7a736a', marginBottom: 6 };
const inp = { width: '100%', padding: '10px 12px', border: '1px solid #d9d3c9', borderRadius: 8, font: 'inherit', background: '#fff' };
const btn = (primary) => ({
  padding: '9px 16px', borderRadius: 8, border: primary ? 'none' : '1px solid #d9d3c9',
  background: primary ? '#0E4A57' : '#fff', color: primary ? '#fff' : '#3a352e',
  font: 'inherit', cursor: 'pointer',
});
const pill = (tone) => ({
  display: 'inline-block', padding: '3px 9px', borderRadius: 999, fontSize: 12,
  background: tone === 'live' ? '#e4f0e7' : tone === 'wait' ? '#fdf1dc' : '#f1efec',
  color: tone === 'live' ? '#2f6b45' : tone === 'wait' ? '#8a6212' : '#6b655c',
});

const firstName = (p) => p.nickname || p.given_name || '—';
const fullName = (p) => [p.given_name, p.family_name].filter(Boolean).join(' ');

/** The same three conditions the website applies, so the two never disagree. */
function publishState(p) {
  if (p.status !== 'ACTIVE') return { tone: 'off', text: 'Not on the site — no longer active in Square' };
  if (!p.consent_at) return { tone: 'off', text: 'Not on the site — awaiting their go-ahead' };
  if (!p.approved_at) return { tone: 'wait', text: 'Waiting for a manager to approve' };
  return { tone: 'live', text: 'On the website' };
}

export default function Crew() {
  const [data, setData] = useState(null);
  const [mine, setMine] = useState(null);
  const [form, setForm] = useState({ nickname: '', bio: '', education: '', square_job_id: '' });
  const [editing, setEditing] = useState(null); // a manager editing someone else
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const reload = async () => {
    const [list, me] = await Promise.all([getCrew(), getMyCrewProfile().catch((e) => ({ error: e.message }))]);
    setData(list);
    if (me.error) { setMine({ error: me.error }); return; }
    setMine(me);
    const p = me.profile || {};
    setForm({
      nickname: p.nickname || '', bio: p.bio || '',
      education: p.education || '', square_job_id: p.square_job_id || '',
    });
  };

  useEffect(() => { reload().catch((e) => setErr(e.message)); }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };
  const run = async (fn, okMsg) => {
    setBusy(true); setErr('');
    try { await fn(); await reload(); if (okMsg) flash(okMsg); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (err && !data) return <div style={wrap}><p style={{ color: '#b03a2e' }}>{err}</p></div>;
  if (!data) return <div style={wrap}><p style={{ opacity: 0.6 }}>Loading…</p></div>;

  const meRow = data.crew.find((c) => c.square_team_member_id === data.me);
  const jobOptions = mine?.jobOptions || [];

  return (
    <div style={wrap}>
      <h1 style={{ margin: '0 0 4px' }}>The Crew</h1>
      <p style={{ marginTop: 0, color: '#7a736a' }}>
        Your profile for the winery website. Fill in as much or as little as you like —
        nothing appears publicly until you say so and a manager approves it.
      </p>

      {msg && <p style={{ color: '#2f6b45' }}>{msg}</p>}
      {err && <p style={{ color: '#b03a2e' }}>{err}</p>}

      {/* ── My profile ─────────────────────────────────────────────── */}
      {mine?.error ? (
        <div style={card}><p style={{ margin: 0 }}>{mine.error}</p></div>
      ) : (
        <div style={card}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ width: 140 }}>
              <span style={lbl}>Photo</span>
              {meRow?.photo_url ? (
                <img src={meRow.photo_url} alt="" style={{ width: 140, height: 140, objectFit: 'cover', borderRadius: 10, border: '1px solid #e6e2da' }} />
              ) : (
                <div style={{ width: 140, height: 140, borderRadius: 10, background: '#f4f1ec', border: '1px dashed #d9d3c9', display: 'grid', placeItems: 'center', color: '#9c958a', fontSize: 13 }}>
                  No photo
                </div>
              )}
              <input type="file" accept="image/*" disabled={busy} style={{ marginTop: 8, width: 140, fontSize: 12 }}
                onChange={(e) => e.target.files[0] && run(() => uploadMyCrewPhoto(e.target.files[0]), 'Photo uploaded')} />
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4, lineHeight: 1.4 }}>
                A clear head-and-shoulders shot works best. Square or landscape, at least 800×800.
              </div>
              {meRow?.photo_url && (
                <button style={{ ...btn(false), padding: '4px 10px', marginTop: 6, fontSize: 12 }} disabled={busy}
                  onClick={() => run(removeMyCrewPhoto, 'Photo removed')}>Remove</button>
              )}
            </div>

            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={lbl}>Goes by</label>
                  <input style={inp} value={form.nickname} placeholder={meRow?.given_name || ''}
                    onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                    Leave blank to use {meRow?.given_name || 'your first name'}. Only your first name is ever shown publicly.
                  </div>
                </div>
                <div>
                  <label style={lbl}>Job title</label>
                  <select style={inp} value={form.square_job_id}
                    onChange={(e) => setForm({ ...form, square_job_id: e.target.value })}>
                    <option value="">— choose —</option>
                    {jobOptions.map((j) => <option key={j.job_id} value={j.job_id}>{(j.job_title || '').trim()}</option>)}
                  </select>
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                    {jobOptions.length > 1
                      ? `You hold ${jobOptions.length} roles in Square — pick the one to show.`
                      : 'Comes from Square.'}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <label style={lbl}>Bio</label>
                <textarea style={{ ...inp, minHeight: 110, resize: 'vertical' }} value={form.bio}
                  placeholder="A few sentences — how you got here, what you like pouring, what you'd tell someone visiting for the first time."
                  onChange={(e) => setForm({ ...form, bio: e.target.value })} />
              </div>

              <div style={{ marginTop: 14 }}>
                <label style={lbl}>Education <span style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.6 }}>(optional)</span></label>
                <input style={inp} value={form.education}
                  placeholder="Certifications, a course, a degree — anything you'd like mentioned."
                  onChange={(e) => setForm({ ...form, education: e.target.value })} />
              </div>

              <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button style={btn(true)} disabled={busy}
                  onClick={() => run(() => saveMyCrewProfile(form), 'Saved')}>Save my profile</button>
                {meRow && <span style={pill(publishState(meRow).tone)}>{publishState(meRow).text}</span>}
              </div>

              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16, padding: 12, background: '#faf8f5', borderRadius: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!meRow?.consent_at} disabled={busy} style={{ marginTop: 3 }}
                  onChange={(e) => run(() => setMyCrewConsent(e.target.checked), e.target.checked ? 'Thanks — a manager will review it' : 'Removed from the website')} />
                <span style={{ fontSize: 13, lineHeight: 1.5 }}>
                  <b>Happy to appear on the website.</b><br />
                  Your first name, photo, title and bio go on the public site. Your surname, email
                  and phone number never do. Untick this at any time and you come off at the next
                  update — you don't need to ask anyone.
                </span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* ── Everyone ──────────────────────────────────────────────── */}
      <h2 style={{ fontSize: 18, margin: '26px 0 10px' }}>Everyone</h2>
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        {data.crew.map((c, i) => {
          const st = publishState(c);
          const isMe = c.square_team_member_id === data.me;
          const open = editing === c.square_team_member_id;
          return (
            <div key={c.square_team_member_id}
              style={{ padding: '12px 16px', borderTop: i ? '1px solid #f0ece5' : 'none', background: isMe ? '#fcfbf9' : '#fff' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {c.photo_url
                  ? <img src={c.photo_url} alt="" style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover' }} />
                  : <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#f1efec' }} />}
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 600 }}>
                    {firstName(c)}{isMe && <span style={{ fontWeight: 400, opacity: 0.55 }}> — you</span>}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.65 }}>
                    {fullName(c)}{c.job_title ? ` · ${c.job_title.trim()}` : ''}
                  </div>
                </div>
                <span style={pill(st.tone)}>{st.text}</span>
                {data.canManage && (
                  <>
                    <button style={{ ...btn(false), padding: '5px 10px', fontSize: 12 }}
                      onClick={() => setEditing(open ? null : c.square_team_member_id)}>
                      {open ? 'Close' : 'Edit'}
                    </button>
                    <button style={{ ...btn(!c.approved_at), padding: '5px 10px', fontSize: 12 }} disabled={busy || !c.profile_id}
                      title={!c.profile_id ? 'Nothing written yet' : ''}
                      onClick={() => run(() => approveCrewProfile(c.square_team_member_id, !c.approved_at),
                        c.approved_at ? 'Approval withdrawn' : 'Approved')}>
                      {c.approved_at ? 'Un-approve' : 'Approve'}
                    </button>
                  </>
                )}
              </div>

              {open && data.canManage && <ManagerEdit row={c} busy={busy} onSave={(f) => run(() => saveCrewProfile(c.square_team_member_id, f), 'Saved')} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A manager editing somebody else's copy. Same fields, no consent checkbox —
 *  agreeing to appear is not a thing anyone can do on another person's behalf. */
function ManagerEdit({ row, busy, onSave }) {
  const [f, setF] = useState({
    nickname: row.nickname || '', bio: row.bio || '', education: row.education || '',
  });
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #e6e2da', display: 'grid', gap: 10 }}>
      <div>
        <label style={lbl}>Goes by</label>
        <input style={inp} value={f.nickname} onChange={(e) => setF({ ...f, nickname: e.target.value })} />
      </div>
      <div>
        <label style={lbl}>Bio</label>
        <textarea style={{ ...inp, minHeight: 90, resize: 'vertical' }} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} />
      </div>
      <div>
        <label style={lbl}>Education</label>
        <input style={inp} value={f.education} onChange={(e) => setF({ ...f, education: e.target.value })} />
      </div>
      <div>
        <button style={btn(true)} disabled={busy} onClick={() => onSave(f)}>Save</button>
        <span style={{ fontSize: 12, opacity: 0.6, marginLeft: 10 }}>
          Job title is theirs to pick from their own Square roles.
        </span>
      </div>
    </div>
  );
}
