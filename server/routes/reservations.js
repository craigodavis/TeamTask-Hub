/**
 * Reservations — Tasting Room → Reservations.
 *
 * Read-only view over ResOS, which owns the bookings. Team adds the two things
 * ResOS is awkward for: seeing both venues at once, and getting the newsletter
 * opt-ins back out.
 *
 * That second one is the point. Guests have been ticking "Receive Newsletter"
 * at booking for over a year and the answers have only ever lived on individual
 * ResOS bookings — visible one at a time, as a red badge, and not exportable as
 * a mailing list. This turns them into a list.
 *
 * Nothing is written back to ResOS and nothing is cached in our database: a
 * stale reservation is worse than a slow one, and staff will have ResOS open in
 * the next tab.
 */
import express from 'express';
import { query } from '../db.js';
import {requireCapability} from '../middleware/auth.js';
import { listBookings, answerText } from '../lib/resosClient.js';

const router = express.Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d) => d.toISOString().slice(0, 10);
const daysFromToday = (n) => iso(new Date(Date.now() + n * 86400000));

/** A field is the newsletter question if it says so — matched on both names. */
const isNewsletter = (f) => /newsletter/i.test(`${f.name || ''} ${f.label || ''}`);
/** "No" is the only answer that isn't consent; blank means unanswered. */
const optedIn = (text) => Boolean(text) && !/^no$/i.test(text.trim());

async function venues(companyId) {
  const { rows } = await query(
    `SELECT l.id, l.name, l.web_slug, c.api_key, c.api_base, c.active
       FROM kindred_web.resos_config c
       JOIN locations l ON l.id = c.location_id
      WHERE l.company_id = $1
      ORDER BY l.name`,
    [companyId],
  );
  return rows.filter((r) => r.api_key && r.active !== false);
}

/** One ResOS booking, flattened to what the screen and the export both need. */
function shape(b, venue) {
  const fields = (b.customFields || []).map((f) => ({
    name: f.name,
    label: f.label || f.name,
    answer: answerText(f),
  }));
  const newsletter = fields.find(isNewsletter);
  return {
    id: b._id,
    venue: venue.web_slug,
    venueName: venue.name,
    date: b.date,
    time: b.time,
    people: b.people,
    status: b.status,
    // A booking made by phone has no email, so it can never be an opt-in. Worth
    // showing anyway: staff read this screen as the day's list, not as a export.
    name: b.guest?.name || '',
    email: b.guest?.email || '',
    phone: b.guest?.phone || '',
    comment: b.comment || '',
    source: b.source || '',
    fields,
    optedIn: newsletter ? optedIn(newsletter.answer) : false,
  };
}

/** Bookings across every configured venue, oldest first. */
async function collect(companyId, from, to, wanted) {
  const list = await venues(companyId);
  const chosen = wanted ? list.filter((v) => v.web_slug === wanted) : list;

  const perVenue = await Promise.all(
    chosen.map(async (v) => {
      try {
        const raw = await listBookings(v.api_base || 'https://api.resos.com', v.api_key, { from, to });
        return raw.map((b) => shape(b, v));
      } catch (e) {
        // One venue's key being wrong shouldn't blank the whole screen.
        console.warn(`[reservations] ${v.web_slug}:`, e.message);
        return { error: `${v.name}: ${e.message}` };
      }
    }),
  );

  const errors = perVenue.filter((r) => !Array.isArray(r)).map((r) => r.error);
  const bookings = perVenue.filter(Array.isArray).flat()
    // A deleted booking is one ResOS no longer counts, so neither do we.
    // Cancellations and no-shows stay: they happened, and a guest who ticked the
    // newsletter box still consented even if they never turned up.
    .filter((b) => b.status !== 'deleted')
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return { bookings, errors, venues: list.map((v) => ({ slug: v.web_slug, name: v.name })) };
}

function range(req) {
  const from = DATE.test(req.query.from || '') ? req.query.from : daysFromToday(-30);
  const to = DATE.test(req.query.to || '') ? req.query.to : daysFromToday(60);
  return { from, to };
}

// GET /api/reservations?from=&to=&venue=
router.get('/', requireCapability('tastingroom.reservations'), async (req, res) => {
  try {
    const { from, to } = range(req);
    const data = await collect(req.companyId, from, to, req.query.venue);
    res.json({ from, to, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reservations/opt-ins.csv?from=&to=&venue=
// The newsletter opt-ins, deduplicated by email, ready to import into a mailing
// platform. Most recent booking wins, so the name is the one they gave last.
router.get('/opt-ins.csv', requireCapability('tastingroom.reservations'), async (req, res) => {
  try {
    const { from, to } = range(req);
    const { bookings } = await collect(req.companyId, from, to, req.query.venue);

    const byEmail = new Map();
    for (const b of bookings) {
      if (!b.optedIn || !b.email) continue;
      byEmail.set(b.email.trim().toLowerCase(), b);      // later booking overwrites
    }

    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Email', 'Name', 'Venue', 'Last booking', 'Source'].join(',')];
    for (const [email, b] of byEmail) {
      rows.push([email, b.name, b.venueName, `${b.date} ${b.time}`, b.source].map(cell).join(','));
    }

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="newsletter-opt-ins-${from}-to-${to}.csv"`);
    // A CSV opened in Excel needs the BOM or accented names arrive mangled.
    res.send('﻿' + rows.join('\r\n') + '\r\n');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
