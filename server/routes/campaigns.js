/**
 * Email campaigns — /api/campaigns
 *
 * A campaign is a list of blocks, never HTML. The composer edits that list; the
 * server is the only thing that turns it into markup, which is what keeps every
 * email on-brand regardless of who assembled it.
 */

import express from 'express';
import { query } from '../db.js';
import {requireCapability} from '../middleware/auth.js';
import { renderBody, renderEmail } from '../lib/email/render.js';
import {
  listmonkConfigured, getLists, kindredTemplateId, upsertCampaign, sendTest,
} from '../lib/listmonk.js';

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
router.get('/', requireCapability('marketing.campaigns'), async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, subject, kind, status, sent_at, updated_at,
              jsonb_array_length(sections) AS block_count
         FROM email_campaigns WHERE company_id = $1
        ORDER BY updated_at DESC LIMIT 100`, [cid(req)]);
    // Surfaced so the page can link out to subscriber management without
    // anyone having to remember where listmonk lives.
    res.json({
      campaigns: r.rows,
      kinds: CAMPAIGN_KINDS,
      listmonkUrl: (process.env.LISTMONK_URL || '').replace(/\/+$/, ''),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/campaigns ──────────────────────────────────────────────────────
router.post('/', requireCapability('marketing.campaigns'), async (req, res) => {
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

// ── GET /api/campaigns/lists ─────────────────────────────────────────────────
// Above /:id deliberately: Express matches in order, and /:id would otherwise
// capture "lists" as an id and 404.
router.get('/lists', requireCapability('marketing.campaigns'), async (req, res) => {
  try {
    if (!listmonkConfigured()) return res.json({ configured: false, lists: [] });
    const lists = await getLists();
    res.json({
      configured: true,
      // The client links through to listmonk to press send. The base URL comes
      // from the server so there is one place it is configured, not two.
      adminUrl: (process.env.LISTMONK_URL || '').replace(/\/+$/, ''),
      lists: (lists?.results || lists || []).map((l) => ({
        id: l.id, name: l.name, count: l.subscriber_count ?? null,
      })),
    });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── GET /api/campaigns/:id ───────────────────────────────────────────────────
router.get('/:id', requireCapability('marketing.campaigns'), async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM email_campaigns WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ campaign: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/campaigns/:id ───────────────────────────────────────────────────
router.put('/:id', requireCapability('marketing.campaigns'), async (req, res) => {
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

// ── GET /api/campaigns/sources/:kind ─────────────────────────────────────────
/**
 * Records you can drop into a campaign, already shaped into block fields.
 *
 * The picker returns `fields` alongside each option so choosing one fills the
 * block in a single step — no second lookup, and no chance of the composer and
 * the server disagreeing about how a wine's detail line is composed.
 *
 * Populate-then-edit, not reference-at-render: the chosen values are copied
 * into the campaign and stay editable. Resolving live at send would mean an
 * edit to an event in September silently rewriting an email sent in August,
 * including in its archive.
 *
 * Unpublished and archived records are excluded. Emailing five thousand people
 * about a dish pulled from the menu last week is the failure worth designing
 * out.
 */
router.get('/sources/:kind', requireCapability('marketing.campaigns'), async (req, res) => {
  try {
    const tz = 'America/Denver';

    if (req.params.kind === 'events') {
      const r = await query(
        `SELECT id, title, start_at, description, event_url
           FROM events
          WHERE company_id = $1 AND status = 'published'
            AND start_at > NOW() - INTERVAL '7 days'
          ORDER BY start_at LIMIT 200`, [cid(req)]);
      return res.json({ options: r.rows.map((e) => {
        // Date and time formatted separately and joined, rather than patching a
        // combined locale string with a regex — the shape of that string is not
        // ours to rely on. Both in the winery's timezone, not UTC: an 8pm
        // Saturday event reads as Sunday otherwise.
        const d = new Date(e.start_at);
        const day = d.toLocaleDateString('en-US', {
          timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
        const time = d.toLocaleTimeString('en-US', {
          timeZone: tz, hour: 'numeric', minute: '2-digit' })
          .replace(':00', '').toLowerCase().replace(' ', '');
        const when = `${day} · ${time}`;
        return {
          id: e.id,
          label: `${new Date(e.start_at).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' })} — ${e.title}`,
          fields: { date: when, title: e.title, detail: (e.description || '').trim().slice(0, 400) },
          extra: { url: e.event_url || '' },
        };
      })});
    }

    if (req.params.kind === 'products') {
      const r = await query(
        `SELECT id, name, vintage, varietal, alcohol_pct, appellation, description
           FROM product.products
          WHERE company_id = $1 AND is_available = true AND is_archived = false
            AND (product_type = 'Wine' OR product_type IS NULL)
          ORDER BY display_order, name LIMIT 300`, [cid(req)]);
      return res.json({ options: r.rows.map((p) => ({
        id: p.id,
        label: p.name,
        fields: {
          name: p.name,
          // Only the parts that exist — a trailing " · " on a wine with no ABV
          // looks like something failed to load.
          meta: [p.appellation, p.varietal, p.alcohol_pct ? `${p.alcohol_pct}%` : null]
            .filter(Boolean).join(' · '),
          note: (p.description || '').trim().slice(0, 400),
        },
      }))});
    }

    res.status(404).json({ error: 'Unknown source' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/campaigns/preview ──────────────────────────────────────────────
// Full document, so the preview shows the real shell and footer rather than a
// prettier fiction of it.
router.post('/preview', requireCapability('marketing.campaigns'), async (req, res) => {
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
router.post('/:id/duplicate', requireCapability('marketing.campaigns'), async (req, res) => {
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

// ── POST /api/campaigns/:id/push ─────────────────────────────────────────────
/**
 * Hand the campaign to listmonk as a DRAFT.
 *
 * Never sends. The composer deliberately cannot reach five thousand inboxes:
 * pressing send is a separate act, in listmonk, after looking at the thing. An
 * email has no recall, so the gap between "I finished writing" and "it is gone"
 * should be a decision, not a keystroke.
 *
 * Only the block HTML crosses over — listmonk wraps it in the Kindred template
 * so it, not TeamHub, writes the unsubscribe and archive URLs. TeamHub cannot
 * honour those URLs, and a broken unsubscribe link is worse than an ugly email.
 */
router.post('/:id/push', requireCapability('marketing.campaigns'), async (req, res) => {
  try {
    const { listIds } = req.body || {};
    if (!Array.isArray(listIds) || !listIds.length) {
      return res.status(400).json({ error: 'Choose at least one list to send to.' });
    }

    const r = await query(
      `SELECT * FROM email_campaigns WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const c = r.rows[0];

    // A campaign with no subject is a campaign nobody opens. Catch it here
    // rather than letting listmonk accept an empty string.
    if (!c.subject?.trim()) {
      return res.status(400).json({ error: 'Give the campaign a subject before sending it.' });
    }

    const body = renderBody(c.sections);
    const templateId = await kindredTemplateId();
    const pushed = await upsertCampaign({
      listmonkId: c.listmonk_id,
      name: c.name,
      subject: c.subject,
      body,
      listIds: listIds.map(Number),
      templateId,
    });

    await query(
      `UPDATE email_campaigns
          SET listmonk_id = $3, sent_html = $4, status = 'ready', updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [c.id, cid(req), pushed.id, body]);

    res.json({ ok: true, listmonkId: pushed.id });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── POST /api/campaigns/:id/test ─────────────────────────────────────────────
// listmonk only sends tests to addresses that already exist as subscribers,
// which is worth surfacing plainly — otherwise a test that goes nowhere reads
// as a broken send path rather than a missing subscriber.
router.post('/:id/test', requireCapability('marketing.campaigns'), async (req, res) => {
  try {
    const emails = (req.body?.emails || []).map((e) => String(e).trim()).filter(Boolean);
    if (!emails.length) return res.status(400).json({ error: 'Give at least one address.' });

    const r = await query(
      `SELECT listmonk_id FROM email_campaigns WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    if (!r.rows[0].listmonk_id) {
      return res.status(400).json({ error: 'Push the campaign to listmonk before testing it.' });
    }

    await sendTest(r.rows[0].listmonk_id, emails);
    res.json({ ok: true, sent: emails.length });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

router.delete('/:id', requireCapability('marketing.campaigns'), async (req, res) => {
  try {
    await query(`DELETE FROM email_campaigns WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { router as campaignsRouter };
