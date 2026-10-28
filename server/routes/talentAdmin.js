/**
 * Staff side of talent self-service: send a link, review what comes back.
 *
 * Submissions are proposals. A 1099 address or legal name is something you file
 * against, so nothing a performer typed on their phone reaches the record until
 * someone has seen it beside the current value.
 *
 * See docs/TALENT_SELF_SERVICE.md.
 */
import express from 'express';
import { query } from '../db.js';
import { issueLink, EDITABLE } from '../lib/talentLinks.js';
import { deliver, linkUrl } from './talentPublic.js';

export const talentAdminRouter = express.Router();
const cId = (req) => req.companyId || req.user?.company_id;

// ── POST /api/talent/:id/link { channel? } ───────────────────────────────────
// channel 'copy' issues a token without sending — for pasting into a DM, where
// we cannot observe delivery and should not pretend otherwise.
talentAdminRouter.post('/:id/link', async (req, res) => {
  try {
    const m = (await query(
      `SELECT id, company_id, name, phone, email FROM musicians
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, [req.params.id, cId(req)])).rows[0];
    if (!m) return res.status(404).json({ error: 'Not found' });

    const wants = req.body?.channel;
    const channel = wants || (m.email ? 'email' : m.phone ? 'sms' : null);
    if (!channel) return res.status(400).json({ error: `No email or phone on file for ${m.name}. Add one first.` });
    if (channel === 'email' && !m.email) return res.status(400).json({ error: `No email on file for ${m.name}.` });
    if (channel === 'sms' && !m.phone) return res.status(400).json({ error: `No phone on file for ${m.name}.` });

    const sentTo = channel === 'email' ? m.email : channel === 'sms' ? m.phone : null;
    const { token, expires_at } = await issueLink(cId(req), m.id, { channel, sentTo, userId: req.userId });

    if (channel === 'copy') {
      // The raw token is returned once, here, and never recoverable after.
      return res.json({ ok: true, channel, url: linkUrl(token), expires_at,
        note: 'Delivery is not tracked for a copied link.' });
    }
    try {
      await deliver(m, token, channel);
    } catch (e) {
      console.error('talent link send', e);
      return res.status(502).json({ error: `Could not send by ${channel}: ${e.message}` });
    }
    res.json({ ok: true, channel, sent_to: sentTo, expires_at });
  } catch (e) { console.error('talent link', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/talent/link-status ──────────────────────────────────────────────
// Where everyone stands, so there is something to chase from.
talentAdminRouter.get('/link-status', async (req, res) => {
  try {
    const r = await query(
      `SELECT m.id, m.name, m.email, m.phone,
              l.channel, l.sent_at, l.opened_at, l.submitted_at, l.expires_at, l.revoked_at,
              (SELECT count(*)::int FROM talent_submissions s
                WHERE s.musician_id = m.id AND s.status = 'pending') AS pending,
              (SELECT max(a.terms_version) FROM talent_terms_acceptances a
                WHERE a.musician_id = m.id) AS terms_version
         FROM musicians m
         LEFT JOIN LATERAL (
           SELECT * FROM talent_update_links x
            WHERE x.musician_id = m.id ORDER BY x.sent_at DESC LIMIT 1
         ) l ON true
        WHERE m.company_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.name`, [cId(req)]);

    const now = Date.now();
    res.json(r.rows.map((m) => ({
      ...m,
      reachable: !!(m.email || m.phone),
      state: m.pending ? 'awaiting_review'
        : m.submitted_at ? 'submitted'
        : !m.sent_at ? 'never_sent'
        : m.revoked_at ? 'superseded'
        : new Date(m.expires_at).getTime() < now ? 'expired'
        : m.opened_at ? 'opened' : 'sent',
    })));
  } catch (e) { console.error('link status', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/talent/submissions ──────────────────────────────────────────────
// Each pending submission as a field-by-field diff; the UI should never have to
// work out what changed, or it will work it out differently from the apply.
talentAdminRouter.get('/submissions', async (req, res) => {
  try {
    const r = await query(
      `SELECT s.id, s.musician_id, s.payload, s.status, s.terms_version, s.created_at,
              m.name AS musician_name, row_to_json(m) AS current
         FROM talent_submissions s JOIN musicians m ON m.id = s.musician_id
        WHERE s.company_id = $1 AND s.status = $2
        ORDER BY s.created_at`, [cId(req), req.query.status || 'pending']);

    res.json(r.rows.map((s) => ({
      id: s.id, musician_id: s.musician_id, musician_name: s.musician_name,
      terms_version: s.terms_version, created_at: s.created_at,
      changes: Object.entries(s.payload)
        .filter(([f]) => EDITABLE.includes(f))
        .map(([field, proposed]) => ({ field, current: s.current[field] ?? null, proposed }))
        // Unchanged fields are noise in a review screen.
        .filter((c) => String(c.current ?? '') !== String(c.proposed ?? '')),
    })));
  } catch (e) { console.error('submissions', e); res.status(500).json({ error: e.message }); }
});

// ── POST /api/talent/submissions/:id/apply { fields? } ───────────────────────
// Accept all of it, or name the fields to take. Per-field matters: a good photo
// should not have to wait on a misspelled address.
talentAdminRouter.post('/submissions/:id/apply', async (req, res) => {
  try {
    const s = (await query(
      `SELECT * FROM talent_submissions WHERE id = $1 AND company_id = $2`,
      [req.params.id, cId(req)])).rows[0];
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.status !== 'pending') return res.status(409).json({ error: `Already ${s.status}.` });

    const asked = Array.isArray(req.body?.fields) ? req.body.fields : null;
    const fields = Object.keys(s.payload)
      .filter((f) => EDITABLE.includes(f))
      .filter((f) => !asked || asked.includes(f));
    if (!fields.length) return res.status(400).json({ error: 'No fields to apply.' });

    await query(
      `UPDATE musicians SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')}, updated_at = NOW()
        WHERE id = $1`,
      [s.musician_id, ...fields.map((f) => s.payload[f])]);

    // A partial apply stays pending with the rest still to decide.
    const remaining = Object.keys(s.payload).filter((f) => EDITABLE.includes(f) && !fields.includes(f));
    if (remaining.length) {
      const kept = Object.fromEntries(remaining.map((f) => [f, s.payload[f]]));
      await query(`UPDATE talent_submissions SET payload = $2 WHERE id = $1`, [s.id, JSON.stringify(kept)]);
    } else {
      await query(
        `UPDATE talent_submissions SET status = 'applied', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
        [s.id, req.userId || null]);
    }
    res.json({ ok: true, applied: fields, remaining });
  } catch (e) { console.error('apply submission', e); res.status(500).json({ error: e.message }); }
});

talentAdminRouter.post('/submissions/:id/reject', async (req, res) => {
  try {
    const r = await query(
      `UPDATE talent_submissions SET status = 'rejected', reviewed_by = $3,
              reviewed_at = NOW(), review_notes = $4
        WHERE id = $1 AND company_id = $2 AND status = 'pending' RETURNING id`,
      [req.params.id, cId(req), req.userId || null, req.body?.notes || null]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or already reviewed' });
    res.json({ ok: true });
  } catch (e) { console.error('reject submission', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/talent/:id/terms — every version this performer accepted ────────
talentAdminRouter.get('/:id/terms', async (req, res) => {
  try {
    const r = await query(
      `SELECT a.terms_version, a.accepted_at, a.channel, v.body_md
         FROM talent_terms_acceptances a
         JOIN terms_versions v ON v.version = a.terms_version
        WHERE a.musician_id = $1 AND a.company_id = $2
        ORDER BY a.accepted_at DESC`, [req.params.id, cId(req)]);
    const cur = (await query(
      `SELECT version FROM terms_versions WHERE company_id = $1 AND effective_from <= NOW()
        ORDER BY effective_from DESC LIMIT 1`, [cId(req)])).rows[0];
    res.json({ current_version: cur?.version || null, acceptances: r.rows });
  } catch (e) { console.error('terms history', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/talent/terms-coverage — who is not on the current version ───────
talentAdminRouter.get('/terms-coverage', async (req, res) => {
  try {
    const cur = (await query(
      `SELECT version FROM terms_versions WHERE company_id = $1 AND effective_from <= NOW()
        ORDER BY effective_from DESC LIMIT 1`, [cId(req)])).rows[0];
    if (!cur) return res.json({ current_version: null, behind: [] });
    const r = await query(
      `SELECT m.id, m.name,
              (SELECT max(a.accepted_at) FROM talent_terms_acceptances a
                WHERE a.musician_id = m.id) AS last_accepted_at
         FROM musicians m
        WHERE m.company_id = $1 AND m.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM talent_terms_acceptances a
             WHERE a.musician_id = m.id AND a.terms_version = $2)
        ORDER BY m.name`, [cId(req), cur.version]);
    res.json({ current_version: cur.version, behind: r.rows });
  } catch (e) { console.error('terms coverage', e); res.status(500).json({ error: e.message }); }
});
