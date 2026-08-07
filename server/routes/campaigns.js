/**
 * Email campaigns — /api/campaigns
 *
 * A campaign is a list of blocks, never HTML. The composer edits that list; the
 * server is the only thing that turns it into markup, which is what keeps every
 * email on-brand regardless of who assembled it.
 */

import express from 'express';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';
import { renderBody, renderEmail } from '../lib/email/render.js';

const router = express.Router();
const cid = (req) => req.companyId;

/**
 * Starting skeletons. A type pre-fills blocks and then gets out of the way —
 * it deliberately does not restrict what can be added afterwards. The day
 * someone needs one wine in an event email, a restriction becomes a workaround,
 * and workarounds are how off-brand HTML gets pasted in.
 */
export const CAMPAIGN_KINDS = {
  general: { label: 'General', sections: [
    { type: 'hero', eyebrow: '', heading: '', sub: '' },
    { type: 'letter', body: '' },
  ]},
  event: { label: 'Event notification', sections: [
    { type: 'hero', eyebrow: 'Coming up', heading: '', sub: '' },
    { type: 'letter', body: '' },
    { type: 'event', date: '', title: '', detail: '' },
    { type: 'button', label: 'Reserve a table', url: '' },
    { type: 'hours', heading: 'Visit us', rows: [] },
  ]},
  release: { label: 'Club release', sections: [
    { type: 'hero', eyebrow: 'The release', heading: '', sub: '' },
    { type: 'letter', body: '' },
    { type: 'wine', name: '', meta: '', note: '' },
    { type: 'button', label: 'Reserve your pickup', url: '' },
  ]},
  recipe: { label: 'Recipe and pairing', sections: [
    { type: 'hero', eyebrow: 'From the kitchen', heading: '', sub: '' },
    { type: 'letter', body: '' },
    { type: 'wine', name: '', meta: '', note: '' },
  ]},
};

// ── GET /api/campaigns ───────────────────────────────────────────────────────
router.get('/', requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, subject, kind, status, sent_at, updated_at,
              jsonb_array_length(sections) AS block_count
         FROM email_campaigns WHERE company_id = $1
        ORDER BY updated_at DESC LIMIT 100`, [cid(req)]);
    res.json({ campaigns: r.rows, kinds: CAMPAIGN_KINDS });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/campaigns ──────────────────────────────────────────────────────
router.post('/', requireManager, async (req, res) => {
  try {
    const { name, kind = 'general' } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'A name is required.' });
    const skeleton = CAMPAIGN_KINDS[kind]?.sections || CAMPAIGN_KINDS.general.sections;
    const r = await query(
      `INSERT INTO email_campaigns (company_id, name, kind, sections, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [cid(req), name.trim(), kind, JSON.stringify(skeleton), req.userId || null]);
    res.status(201).json({ campaign: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/campaigns/:id ───────────────────────────────────────────────────
router.get('/:id', requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM email_campaigns WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ campaign: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/campaigns/:id ───────────────────────────────────────────────────
router.put('/:id', requireManager, async (req, res) => {
  try {
    const { name, subject, preheader, sections } = req.body || {};
    // Render before saving. A section list that cannot render — a missing alt,
    // an unknown block — is rejected here rather than discovered at send.
    if (sections) {
      try { renderBody(sections); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }
    const r = await query(
      `UPDATE email_campaigns
          SET name      = COALESCE($3, name),
              subject   = COALESCE($4, subject),
              preheader = COALESCE($5, preheader),
              sections  = COALESCE($6, sections),
              updated_at = NOW()
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, cid(req), name ?? null, subject ?? null,
       preheader ?? null, sections ? JSON.stringify(sections) : null]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ campaign: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/campaigns/preview ──────────────────────────────────────────────
// Full document, so the preview shows the real shell and footer rather than a
// prettier fiction of it.
router.post('/preview', requireManager, async (req, res) => {
  try {
    const { sections = [], subject = '', preheader = '' } = req.body || {};
    const html = renderEmail(sections, {
      subject, preheader,
      unsubscribeUrl: '#preview-unsubscribe',
      browserUrl: '#preview-browser',
    });
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (err) {
    res.status(400).set('Content-Type', 'text/html; charset=utf-8')
      .send(`<p style="font:14px system-ui;color:#b3261e;padding:16px">${err.message}</p>`);
  }
});

// ── POST /api/campaigns/:id/duplicate ────────────────────────────────────────
// Copying a campaign IS the template mechanism. A separate "save as template"
// concept would mean two things to keep in sync and two places to look for the
// one you half-remember; a copy is editable, disposable, and already
// understood.
router.post('/:id/duplicate', requireManager, async (req, res) => {
  try {
    const src = await query(
      `SELECT * FROM email_campaigns WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    if (!src.rows.length) return res.status(404).json({ error: 'Not found' });
    const c = src.rows[0];

    // "name-copy", then "name-copy-2" and so on. Suffixing a busy name blindly
    // gives you three identical rows and no way to tell them apart.
    const base = `${c.name}-copy`;
    const taken = (await query(
      `SELECT name FROM email_campaigns WHERE company_id = $1 AND name LIKE $2`,
      [cid(req), `${base}%`])).rows.map((r) => r.name);
    let name = base;
    for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;

    // Everything about the copy is a draft: no listmonk campaign, nothing sent,
    // no sent_html. Carrying those over would make a copy look like it had
    // already gone out.
    const r = await query(
      `INSERT INTO email_campaigns
         (company_id, name, subject, preheader, kind, sections, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7) RETURNING *`,
      [cid(req), name, c.subject, c.preheader, c.kind,
       JSON.stringify(c.sections), req.userId || null]);
    res.status(201).json({ campaign: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireManager, async (req, res) => {
  try {
    await query(`DELETE FROM email_campaigns WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { router as campaignsRouter };
