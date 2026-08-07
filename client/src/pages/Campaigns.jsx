import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  getCampaigns, createCampaign, getCampaign, saveCampaign, previewCampaign,
  duplicateCampaign,
} from '../api';
import './Campaigns.css';

/**
 * The fields each block exposes. This is the whole editing surface — there is
 * no colour, no font and no size anywhere in it, because those come from the
 * brand tokens. A composer that offers a colour picker eventually produces an
 * off-brand email; offering only content makes that unreachable.
 */
const BLOCK_FIELDS = {
  hero:    { label: 'Hero',    fields: [['eyebrow', 'Eyebrow'], ['heading', 'Heading'], ['sub', 'Subheading']] },
  letter:  { label: 'Letter',  fields: [['heading', 'Heading (optional)'], ['body', 'Body', 'area']] },
  wine:    { label: 'Wine',    fields: [['name', 'Wine'], ['meta', 'Detail line'], ['note', 'Tasting note', 'area']] },
  event:   { label: 'Event',   fields: [['date', 'When'], ['title', 'Title'], ['detail', 'Detail', 'area']] },
  button:  { label: 'Button',  fields: [['label', 'Label'], ['url', 'Link']] },
  image:   { label: 'Image',   fields: [['src', 'Image URL'], ['alt', 'Alt text (required)'], ['caption', 'Caption']] },
  divider: { label: 'Divider', fields: [] },
  hours:   { label: 'Hours',   fields: [['heading', 'Heading']] },
};

const BLOCK_ORDER = ['hero', 'letter', 'wine', 'event', 'image', 'button', 'divider', 'hours'];

export function Campaigns() {
  const [list, setList] = useState([]);
  const [kinds, setKinds] = useState({});
  const [openId, setOpenId] = useState(null);
  const [c, setC] = useState(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [dialog, setDialog] = useState(null);   // { name, kind } while open
  const saveTimer = useRef(null);

  const load = useCallback(() => {
    getCampaigns().then((d) => { setList(d.campaigns || []); setKinds(d.kinds || {}); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!openId) { setC(null); return; }
    getCampaign(openId).then(async (d) => {
      setC(d.campaign); setSelected(0);
      setPreviewHtml(await previewCampaign({
        sections: d.campaign.sections, subject: d.campaign.subject,
        preheader: d.campaign.preheader }));
    }).catch((e) => setError(e.message));
  }, [openId]);

  /** Save on a debounce, then refresh the preview from the saved state. */
  const persist = useCallback((next) => {
    setC(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      setError('');
      try {
        await saveCampaign(next.id, {
          name: next.name, subject: next.subject,
          preheader: next.preheader, sections: next.sections,
        });
        setPreviewHtml(await previewCampaign({
          sections: next.sections, subject: next.subject, preheader: next.preheader }));
      } catch (e) {
        // A render failure — a missing alt, say — surfaces here rather than at
        // send. Keep the edit on screen so it can be fixed.
        setError(e.message);
      } finally { setSaving(false); }
    }, 600);
  }, []);

  const setField = (i, key, val) => {
    const sections = c.sections.map((s, n) => (n === i ? { ...s, [key]: val } : s));
    persist({ ...c, sections });
  };
  const addBlock = (type) => {
    const sections = [...c.sections, { type }];
    persist({ ...c, sections });
    setSelected(sections.length - 1);
  };
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= c.sections.length) return;
    const sections = [...c.sections];
    [sections[i], sections[j]] = [sections[j], sections[i]];
    persist({ ...c, sections });
    setSelected(j);
  };
  const remove = (i) => {
    const sections = c.sections.filter((_, n) => n !== i);
    persist({ ...c, sections });
    setSelected(Math.max(0, i - 1));
  };

  const duplicate = async (id, e) => {
    e?.stopPropagation();
    try {
      const d = await duplicateCampaign(id);
      load();
      setOpenId(d.campaign.id);   // open the copy so it can be renamed at once
    } catch (err) { setError(err.message); }
  };

  const submitNew = async (e) => {
    e.preventDefault();
    if (!dialog?.name?.trim()) return;
    try {
      const d = await createCampaign({ name: dialog.name.trim(), kind: dialog.kind });
      setDialog(null);
      load(); setOpenId(d.campaign.id);
    } catch (err) { setError(err.message); }
  };

  // ── list ──────────────────────────────────────────────────────────────────
  if (!openId) {
    return (
      <div className="cmp-page">
        <div className="cmp-head">
          <div>
            <h2 className="cmp-title">Campaigns</h2>
            <p className="cmp-sub">Emails are built from blocks. Brand comes from the tokens, not from you.</p>
          </div>
          <button className="cmp-primary"
                  onClick={() => setDialog({ name: '', kind: 'general' })}>New campaign</button>
        </div>
        {error && <p className="cmp-error">{error}</p>}

        {dialog && (
          <div className="cmp-scrim" onClick={() => setDialog(null)}>
            <form className="cmp-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitNew}>
              <h3>New campaign</h3>
              <label className="cmp-field">
                <span>Name</span>
                <input autoFocus value={dialog.name} placeholder="June release — club"
                       onChange={(e) => setDialog({ ...dialog, name: e.target.value })} />
              </label>
              <label className="cmp-field">
                <span>Type</span>
                <select value={dialog.kind}
                        onChange={(e) => setDialog({ ...dialog, kind: e.target.value })}>
                  {Object.entries(kinds).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </label>
              <p className="cmp-dialognote">
                The type fills in a starting set of blocks. You can add or remove
                any of them afterwards.
              </p>
              <div className="cmp-dialogbtns">
                <button type="button" className="cmp-ghost"
                        onClick={() => setDialog(null)}>Cancel</button>
                <button type="submit" className="cmp-primary"
                        disabled={!dialog.name.trim()}>Create</button>
              </div>
            </form>
          </div>
        )}

        {!list.length && <p className="cmp-empty">Nothing yet. Start one.</p>}
        <table className="cmp-table">
          <tbody>
            {list.map((x) => (
              <tr key={x.id} onClick={() => setOpenId(x.id)}>
                <td>
                  <span className="cmp-name">{x.name}</span>
                  <em>{kinds[x.kind]?.label || x.kind} · {x.block_count} blocks</em>
                </td>
                <td className="right">
                  <span className={`cmp-status cmp-${x.status}`}>{x.status}</span>
                  <button className="cmp-dup" title="Duplicate"
                          onClick={(e) => duplicate(x.id, e)}>Duplicate</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!c) return <div className="cmp-page"><p className="cmp-empty">Loading…</p></div>;

  const sel = c.sections[selected];
  const spec = sel ? BLOCK_FIELDS[sel.type] : null;

  // ── composer ──────────────────────────────────────────────────────────────
  return (
    <div className="cmp-page">
      <div className="cmp-head">
        <div className="cmp-headline">
          <button className="cmp-back" onClick={() => { setOpenId(null); load(); }}>← Campaigns</button>
          <input className="cmp-nameinput" value={c.name}
                 onChange={(e) => persist({ ...c, name: e.target.value })} />
        </div>
        <span className="cmp-headactions">
          <button className="cmp-dup" onClick={(e) => duplicate(c.id, e)}>Duplicate</button>
          <span className="cmp-saving">{saving ? 'Saving…' : 'Saved'}</span>
        </span>
      </div>

      {error && <p className="cmp-error">{error}</p>}

      <div className="cmp-meta">
        <label>Subject
          <input value={c.subject} onChange={(e) => persist({ ...c, subject: e.target.value })} />
        </label>
        <label>Preheader
          <input value={c.preheader} placeholder="The line shown after the subject"
                 onChange={(e) => persist({ ...c, preheader: e.target.value })} />
        </label>
      </div>

      <div className="cmp-grid">
        <div className="cmp-col">
          <p className="cmp-coltitle">Blocks</p>
          <ol className="cmp-blocks">
            {c.sections.map((s, i) => (
              <li key={i} className={i === selected ? 'on' : ''} onClick={() => setSelected(i)}>
                <span>{BLOCK_FIELDS[s.type]?.label || s.type}</span>
                <span className="cmp-rowbtns">
                  <button onClick={(e) => { e.stopPropagation(); move(i, -1); }} aria-label="Move up">↑</button>
                  <button onClick={(e) => { e.stopPropagation(); move(i, 1); }} aria-label="Move down">↓</button>
                  <button onClick={(e) => { e.stopPropagation(); remove(i); }} aria-label="Remove">×</button>
                </span>
              </li>
            ))}
          </ol>
          <p className="cmp-coltitle">Add</p>
          <div className="cmp-add">
            {BLOCK_ORDER.map((t) => (
              <button key={t} onClick={() => addBlock(t)}>{BLOCK_FIELDS[t].label}</button>
            ))}
          </div>
        </div>

        <div className="cmp-col">
          <p className="cmp-coltitle">{spec ? spec.label : 'Nothing selected'}</p>
          {spec && spec.fields.length === 0 && <p className="cmp-empty">No settings.</p>}
          {spec && spec.fields.map(([key, label, kind]) => (
            <label key={key} className="cmp-field">
              <span>{label}</span>
              {kind === 'area'
                ? <textarea rows={5} value={sel[key] || ''}
                            onChange={(e) => setField(selected, key, e.target.value)} />
                : <input value={sel[key] || ''}
                         onChange={(e) => setField(selected, key, e.target.value)} />}
            </label>
          ))}
        </div>

        <div className="cmp-col cmp-previewcol">
          <p className="cmp-coltitle">Preview</p>
          <iframe title="Email preview" className="cmp-preview" srcDoc={previewHtml} />
          <p className="cmp-note">
            Renders in a browser, not in Outlook. Send yourself a test before a campaign goes out.
          </p>
        </div>
      </div>
    </div>
  );
}
