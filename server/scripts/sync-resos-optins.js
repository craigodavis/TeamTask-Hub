/**
 * Carry ResOS newsletter opt-ins into the mailing lists.
 *
 * Guests tick "Receive Newsletter/Event Notifications" when they book. The
 * answer has always been stored on the booking and never went anywhere — 769
 * people asked to hear from us over two years and none of them reached a
 * mailing list. This closes that.
 *
 * Run from cron, not from an in-process timer. The Campaign Monitor reservation
 * sync was a setInterval inside a Passenger app that only acted in a two-minute
 * window at local midnight; Passenger stops idle apps, so it silently did
 * nothing from March onward and nobody noticed until the subscriber count was
 * examined. Cron does not care whether a web app is awake.
 *
 *   *\/15 * * * * cd ~/teamhub && node server/scripts/sync-resos-optins.js
 *
 * No watermark is kept. Every run re-reads a few days of bookings and re-offers
 * them; adding someone already subscribed is a no-op on both platforms. State
 * you have to maintain is state that can be wrong, and a missed window would
 * lose opt-ins permanently.
 *
 * Consent routes by venue, because where someone agreed is part of what they
 * agreed to: the Creek and the Winery are different rooms and different lists.
 */

import { query } from '../db.js';
import { listBookings, answerText, isNewsletter, optedIn } from '../lib/resosClient.js';
import { subscribeEverywhere } from '../lib/newsletterSubscribe.js';

const DAYS_BACK = Number(process.env.RESOS_OPTIN_DAYS || 3);

/** Venue -> list. Matched loosely so a rename to "Kindred by the Creek" still lands. */
const listFor = (venueName) => (/creek/i.test(venueName || '') ? 'Resos Creek' : 'Resos Winery');

const iso = (d) => d.toISOString().slice(0, 10);

async function venues() {
  const { rows } = await query(
    `SELECT l.name, c.api_key, c.api_base, c.active
       FROM kindred_web.resos_config c
       JOIN locations l ON l.id = c.location_id`,
  );
  return rows.filter((r) => r.api_key && r.active !== false);
}

async function main() {
  const to = new Date();
  const from = new Date(to.getTime() - DAYS_BACK * 86400_000);
  const vs = await venues();
  if (!vs.length) { console.log('[resos-optins] no configured venues'); return; }

  for (const v of vs) {
    const list = listFor(v.name);
    let bookings;
    try {
      bookings = await listBookings(v.api_base || 'https://api.resos.com', v.api_key,
        { from: iso(from), to: iso(to) });
    } catch (e) {
      // One venue's API being unreachable must not stop the other's opt-ins.
      console.error(`[resos-optins] ${v.name}: could not read bookings — ${e.message}`);
      continue;
    }

    // Collapse to one entry per address first. A regular who books three times
    // in the window is one person, not three writes to two platforms.
    const seen = new Map();
    for (const b of bookings || []) {
      const email = String(b.guest?.email || '').trim().toLowerCase();
      if (!email) continue;
      const field = (b.customFields || []).find(isNewsletter);
      if (!field || !optedIn(answerText(field))) continue;
      if (!seen.has(email)) seen.set(email, b.guest?.name || '');
    }

    let added = 0, already = 0, held = 0, failed = 0, nowhere = 0;
    for (const [email, name] of seen) {
      // deliberate: the guest ticked the box themselves. That is fresh consent
      // and may lift an earlier unsubscribe -- unlike the old sync, which
      // resubscribed everyone who merely booked a table.
      const r = await subscribeEverywhere(email, name, list, { deliberate: true });
      const states = [r.listmonk, r.campaignMonitor];
      // "not configured" counted separately from "already subscribed": both mean
      // nothing was written, but only one of them means the work is done. Folding
      // them together made an entirely unwired run read as success.
      if (states.every((s) => s === 'not configured')) nowhere++;
      else if (states.some((s) => /^failed/.test(s))) failed++;
      else if (states.some((s) => s === 'suppressed — not added')) held++;
      else if (states.every((s) => s === 'already subscribed' || s === 'not configured')) already++;
      else added++;
    }
    console.log(`[resos-optins] ${v.name} -> ${list}: ${seen.size} opted in `
      + `(${added} added/restored, ${already} already, ${held} suppressed, ${failed} failed)`);
    if (nowhere) {
      console.warn(`[resos-optins] ${nowhere} opt-in(s) went NOWHERE — no mailing platform is `
        + `configured. Set LISTMONK_* / CAMPAIGN_MONITOR_API_KEY in the app's env.`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('[resos-optins] failed:', e); process.exit(1); });
