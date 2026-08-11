/**
 * Event distribution — one announce action, every channel, tracked per channel.
 *
 * Stage 1 (this file) deliberately calls no external APIs. It tracks state and
 * prepares work for a human, because the real problem today isn't that posting
 * to Facebook is hard — it's that nobody remembers and nobody can tell
 * afterwards whether it happened.
 *
 * Channels sort into three tiers, and the tiering is the whole design:
 *
 *   auto      we can call an API and record the result
 *   assisted  we cannot post; we prepare copy + a deep link and track the click
 *   outreach  an email or web form to a contact in promo_contacts
 *
 * Two constraints drive that split and are not going to change:
 *
 *   - Facebook Events cannot be created through the Graph API. Meta removed it
 *     years ago and aggregators that claim otherwise post to the page *feed*,
 *     which is a different thing. Native Events are human-only, permanently.
 *   - Bandsintown listings originate from the *artist's* account, not the
 *     venue's, so the action is asking the performer to add the date.
 *
 * See docs/EVENT_DISTRIBUTION.md.
 */
import crypto from 'crypto';
import { query } from '../db.js';

// The catalogue. Seeded per company on first use, so adding one here is all it
// takes — no migration. `enabled` here is only the default for a new company.
// `lead` is days before the event to announce. Most share one value; the two
// exceptions are deliberate. Push six weeks out is noise that trains people to
// mute you — it wants to be a reminder. Google posts are deprioritised as they
// age, so posting months ahead wastes the slot.
export const DEFAULT_LEAD_DAYS = 21;

export const CHANNELS = [
  { key: 'website',         name: 'Kindred website',    tier: 'auto',     sort: 10, enabled: true,  lead: 21,
    note: 'Already automatic — the site rebuilds from /api/website when content changes.' },
  { key: 'app_push',        name: 'Kindred App push',   tier: 'auto',     sort: 20, enabled: false, lead: 2,
    note: 'Web push to members — a reminder, so it goes 2 days out, not weeks. Infrastructure exists (Club 77 notifications); not wired to events yet.' },
  { key: 'google_business', name: 'Google Business',    tier: 'auto',     sort: 30, enabled: false, lead: 7,
    note: 'Event post on the Google listing; posts age out, so 1 week out. Needs Business Profile API access (quota > 0). Posts live on the legacy v4.9 localPosts endpoint, not the newer split APIs.' },
  { key: 'eventbrite',      name: 'Eventbrite',         tier: 'auto',     sort: 40, enabled: false, lead: 21,
    note: 'REST API v3. Free listings for free events.' },

  { key: 'facebook_event',  name: 'Facebook Event',     tier: 'assisted', sort: 50, enabled: true,  lead: 21,
    note: 'Human-only — Meta removed event creation from the API. We prepare the copy.',
    link: 'https://www.facebook.com/events/create/' },
  { key: 'instagram',       name: 'Instagram post',     tier: 'assisted', sort: 60, enabled: true,  lead: 21,
    note: 'Feed post. Image-first — use the social image if one is set.' },
  { key: 'bandsintown',     name: 'Bandsintown',        tier: 'assisted', sort: 70, enabled: true,  lead: 21,
    note: 'Artist-side. Ask the performer to add the Kindred date — it reaches their followers.',
    link: 'https://www.bandsintown.com/' },

  { key: 'press',           name: 'Press & tourism',    tier: 'outreach', sort: 80, enabled: true,  lead: 21,
    note: 'Idaho Press, Idaho Wine Commission, Destination Caldwell, Sunnyslope, Visit SW Idaho, BoiseDev. Uses the existing promo_emails flow.' },
];

export const CHANNEL_BY_KEY = Object.fromEntries(CHANNELS.map((c) => [c.key, c]));

/** Insert any catalogue entries this company doesn't have yet. Idempotent. */
export async function ensureChannels(companyId) {
  for (const c of CHANNELS) {
    // lead_days is seeded but never overwritten — it's tunable per company.
    await query(
      `INSERT INTO promo_channels (company_id, key, name, tier, enabled, sort_order, lead_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, key) DO UPDATE
         SET name = EXCLUDED.name, tier = EXCLUDED.tier, sort_order = EXCLUDED.sort_order,
             updated_at = NOW()`,
      [companyId, c.key, c.name, c.tier, c.enabled, c.sort, c.lead ?? DEFAULT_LEAD_DAYS]
    );
  }
}

/**
 * The facts a channel needs. Hashing this is what makes re-announcing safe:
 * same hash means nothing worth re-posting changed. Internal notes and
 * checklists are deliberately absent — they are never promoted.
 */
export function buildPayload(ev) {
  return {
    title: ev.title ?? '',
    description: ev.description ?? '',
    start_at: ev.start_at instanceof Date ? ev.start_at.toISOString() : String(ev.start_at ?? ''),
    end_at: ev.end_at instanceof Date ? ev.end_at.toISOString() : String(ev.end_at ?? ''),
    venue: ev.venue ?? '',
    cost: ev.cost ?? null,
    // Social image wins when set — the featured photo is often square or portrait.
    image: ev.social_image_url || ev.image_url || '',
    url: ev.slug ? `https://kindredvineyards.com/events/${ev.slug}` : '',
  };
}

export function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

/** Wall-clock-labelled-UTC: 18:00Z means 6 PM. Never shift it into a zone. */
function whenText(payload) {
  if (!payload.start_at) return '';
  const d = new Date(payload.start_at);
  return d.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  });
}

/** Plain-text copy a human can paste. Kept short — every channel truncates. */
export function suggestedCopy(payload, channelKey) {
  const when = whenText(payload);
  const where = payload.venue === 'creek' ? 'Kindred by the Creek' : 'Kindred Vineyards';
  const base = `${payload.title}\n${when} · ${where}`;
  if (channelKey === 'bandsintown') {
    return `${base}\n\nAsk the performer to add this date to their Bandsintown profile — it notifies their followers.`;
  }
  const blurb = (payload.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base}\n\n${blurb.slice(0, 300)}${blurb.length > 300 ? '…' : ''}\n\n${payload.url}`.trim();
}

/** Every channel's current state for one event, catalogue order. */
export async function getDistribution(companyId, eventId) {
  await ensureChannels(companyId);
  const ev = (await query(
    `SELECT e.*, l.web_slug AS venue FROM events e
       LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = $1 AND e.company_id = $2`, [eventId, companyId])).rows[0];
  if (!ev) return null;

  const payload = buildPayload(ev);
  const hash = hashPayload(payload);

  const rows = (await query(
    `SELECT c.key, c.name, c.tier, c.enabled, c.sort_order, c.lead_days,
            p.id AS post_id, p.status, p.external_url, p.payload_hash,
            p.posted_at, p.scheduled_at, p.last_error, p.promo_task_id
       FROM promo_channels c
       LEFT JOIN event_channel_posts p
         ON p.channel_key = c.key AND p.event_id = $2
      WHERE c.company_id = $1
      ORDER BY c.sort_order`, [companyId, eventId])).rows;

  const channels = rows.map((r) => {
    const meta = CHANNEL_BY_KEY[r.key] ?? {};
    // Posted against an older payload — the event changed underneath it.
    const stale = r.status === 'posted' && r.payload_hash && r.payload_hash !== hash;
    return {
      key: r.key, name: r.name, tier: r.tier, enabled: r.enabled,
      status: stale ? 'stale' : (r.status ?? 'pending'),
      external_url: r.external_url, posted_at: r.posted_at, last_error: r.last_error,
      post_id: r.post_id, promo_task_id: r.promo_task_id,
      lead_days: r.lead_days, scheduled_at: r.scheduled_at,
      note: meta.note ?? null, link: meta.link ?? null,
      copy: r.tier === 'assisted' ? suggestedCopy(payload, r.key) : null,
    };
  });

  return {
    event_id: eventId, payload, payload_hash: hash, channels,
    start_at: ev.start_at, announce_lead_days: ev.announce_lead_days,
  };
}

/**
 * Set each channel's send time to (event start − lead days) and park it as
 * `scheduled`. A per-event override applies to every channel except the two
 * whose timing is the point (push is a reminder; Google posts age out), so
 * "announce everything 6 weeks out" doesn't accidentally push six weeks early.
 */
export async function scheduleAnnounce(companyId, eventId, { leadDays, channelKeys } = {}) {
  const dist = await getDistribution(companyId, eventId);
  if (!dist) throw new Error('Event not found');
  const start = new Date(dist.start_at);

  if (leadDays != null) {
    await query(`UPDATE events SET announce_lead_days = $2, updated_at = NOW() WHERE id = $1 AND company_id = $3`,
      [eventId, leadDays, companyId]);
  }
  const override = leadDays ?? dist.announce_lead_days ?? null;
  const KEEPS_OWN_TIMING = new Set(['app_push', 'google_business']);

  const wanted = dist.channels.filter((c) =>
    (channelKeys?.length ? channelKeys.includes(c.key) : c.enabled));

  const scheduled = [];
  for (const ch of wanted) {
    if (ch.status === 'posted') continue;
    const lead = (override != null && !KEEPS_OWN_TIMING.has(ch.key))
      ? override : (ch.lead_days ?? DEFAULT_LEAD_DAYS);
    const at = new Date(start.getTime() - lead * 86400000);

    await query(
      `INSERT INTO event_channel_posts
         (company_id, event_id, channel_key, status, scheduled_at, payload_hash)
       VALUES ($1,$2,$3,'scheduled',$4,$5)
       ON CONFLICT (event_id, channel_key) DO UPDATE
         SET status = 'scheduled', scheduled_at = EXCLUDED.scheduled_at,
             payload_hash = EXCLUDED.payload_hash, updated_at = NOW()`,
      [companyId, eventId, ch.key, at.toISOString(), dist.payload_hash]);
    scheduled.push({ key: ch.key, lead_days: lead, at: at.toISOString() });
  }
  return { ok: true, scheduled };
}

/**
 * Promote scheduled posts whose time has come. Runs on a timer; safe to run
 * often. Still posts nothing externally — it does what pressing Announce would
 * have done, so assisted channels become real tasks with escalating reminders
 * at the moment they're due rather than the moment they were planned.
 *
 * Past events are swept to `skipped`: a schedule that was missed while the
 * server was down should not fire an announcement for a show that has been and
 * gone.
 */
export async function runDueAnnouncements(companyId) {
  const due = (await query(
    `SELECT p.id, p.event_id, p.channel_key, e.start_at
       FROM event_channel_posts p
       JOIN events e ON e.id = p.event_id
      WHERE p.company_id = $1 AND p.status = 'scheduled'
        AND p.scheduled_at IS NOT NULL AND p.scheduled_at <= NOW()
      ORDER BY p.scheduled_at`, [companyId])).rows;

  let fired = 0, skipped = 0;
  for (const row of due) {
    if (new Date(row.start_at) < new Date()) {
      await query(`UPDATE event_channel_posts SET status = 'skipped', updated_at = NOW() WHERE id = $1`, [row.id]);
      skipped++;
      continue;
    }
    try {
      await announce(companyId, row.event_id, { channelKeys: [row.channel_key] });
      fired++;
    } catch (e) {
      await query(
        `UPDATE event_channel_posts SET status = 'failed', last_error = $2,
                attempts = attempts + 1, updated_at = NOW() WHERE id = $1`,
        [row.id, e.message]);
    }
  }
  return { fired, skipped, considered: due.length };
}

let schedulerStarted = false;
export function startDistributionScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const run = async () => {
    try {
      const cs = (await query(`SELECT DISTINCT company_id FROM promo_channels`)).rows;
      for (const c of cs) {
        await runDueAnnouncements(c.company_id)
          .catch((e) => console.error('distribution', c.company_id, e.message));
      }
    } catch (e) { console.error('distribution loop failed:', e.message); }
  };
  setTimeout(run, 200 * 1000);
  setInterval(run, 60 * 60 * 1000);
  console.log('Event distribution scheduler started (hourly).');
}

/**
 * Queue the given channels for this event. Assisted channels also get a
 * promo_task, which is what puts them into the existing escalating-reminder
 * flow (1mo/3wk/2wk/1wk, escalating at two weeks) rather than being a note
 * nobody reads.
 *
 * Never posts anything itself — stage 1 has no external calls.
 */
export async function announce(companyId, eventId, { channelKeys, userId } = {}) {
  const dist = await getDistribution(companyId, eventId);
  if (!dist) throw new Error('Event not found');

  const wanted = dist.channels.filter((c) =>
    (channelKeys?.length ? channelKeys.includes(c.key) : c.enabled));

  const touched = [];
  for (const ch of wanted) {
    // Already posted against this exact payload — nothing to do.
    if (ch.status === 'posted') { touched.push({ key: ch.key, action: 'skipped (already posted)' }); continue; }

    let taskId = ch.promo_task_id;
    if (ch.tier === 'assisted' && !taskId) {
      const t = await query(
        `INSERT INTO promo_tasks (company_id, event_id, title, channel)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [companyId, eventId, `${ch.name}: ${dist.payload.title}`, ch.key]);
      taskId = t.rows[0].id;
    }

    const status = ch.tier === 'auto' && ch.key !== 'website' ? 'needs_human' : 'queued';
    await query(
      `INSERT INTO event_channel_posts
         (company_id, event_id, channel_key, status, payload_hash, promo_task_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (event_id, channel_key) DO UPDATE
         SET status = EXCLUDED.status,
             payload_hash = EXCLUDED.payload_hash,
             promo_task_id = COALESCE(event_channel_posts.promo_task_id, EXCLUDED.promo_task_id),
             updated_at = NOW()`,
      [companyId, eventId, ch.key, status, dist.payload_hash, taskId]);
    touched.push({ key: ch.key, action: status });
  }

  return { ok: true, touched };
}

/** Record a human-completed post (or reset one). Also closes the linked task. */
export async function markPost(companyId, postId, { status, external_url, userId } = {}) {
  // $3 is cast explicitly: without it Postgres deduces varchar from the column
  // assignment and text from the CASE comparison, and refuses the query.
  const r = await query(
    `UPDATE event_channel_posts
        SET status = $3::text,
            external_url = COALESCE($4::text, external_url),
            posted_at = CASE WHEN $3::text = 'posted' THEN NOW() ELSE NULL END,
            posted_by = CASE WHEN $3::text = 'posted' THEN $5::uuid ELSE NULL END,
            updated_at = NOW()
      WHERE id = $2 AND company_id = $1
      RETURNING *`,
    [companyId, postId, status, external_url || null, userId || null]);
  const row = r.rows[0];
  if (!row) return null;

  if (row.promo_task_id) {
    await query(
      `UPDATE promo_tasks SET done = $2, done_at = CASE WHEN $2 THEN NOW() END, done_by = $3
        WHERE id = $1`,
      [row.promo_task_id, status === 'posted', status === 'posted' ? (userId || null) : null]);
  }
  return row;
}
