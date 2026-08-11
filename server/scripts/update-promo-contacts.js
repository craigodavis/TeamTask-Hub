/**
 * Fill in the promotion contacts' emails, phones, and submission links.
 *
 * Every row had a website and nothing else. Sources are public contact pages
 * (see docs/EVENT_DISTRIBUTION.md); none of it has been confirmed by actually
 * contacting anyone, so treat a first send as a test.
 *
 * `website` is set to the link you'd actually click to submit where one exists
 * (Idaho Press's Submit News form, Eventbrite's create page) rather than the
 * org's homepage, since that's the actionable destination.
 *
 * Dry run by default; pass --apply to write.
 *   DB_HOST=localhost node scripts/update-promo-contacts.js [--apply]
 */
import { query } from '../db.js';

const APPLY = process.argv.includes('--apply');

// Matched on `name`. null means "leave whatever is there"; a string overwrites.
const UPDATES = [
  { name: 'Idaho Press',
    email: 'community@idahopress.com', phone: '(208) 465-8106',
    website: 'https://www.idahopress.com/site/forms/online_services/submit_news/',
    note: 'Submit via the Submit News form (link above) — faster than email for a recurring series. Main site: idahopress.com' },

  { name: 'Idaho Wine Commission',
    email: 'info@idahowines.org', phone: '(208) 332-1538',
    website: 'https://idahowines.org/contact-us/',
    note: '821 W. State St, Boise ID 83702.' },

  { name: 'Sunnyslope Wine Trail',
    email: 'hello@sunnyslopewinetrail.com', phone: null,
    website: 'https://sunnyslopewinetrail.com/contact/',
    note: 'Non-profit, ~19-21 member wineries. Kindred is on the trail — check whether member events get listed automatically.' },

  { name: 'Destination Caldwell / Indian Creek Plaza',
    email: 'info@destinationcaldwell.com', phone: null,
    website: 'https://www.indiancreekplaza.com/contact',
    note: null },

  { name: 'BoiseDev',
    email: null, phone: '(208) 960-0321',
    website: 'https://boisedev.com/about-boisedev/',
    note: 'Email not verified — their About page blocks automated fetch. Editor/publisher: Don Day. Email is their preferred channel; get the address off the About page.' },

  // Stored URL was .com, which is not their site.
  { name: 'Visit Southwest Idaho',
    email: null, phone: null,
    website: 'https://www.visitsouthwestidaho.org/contact-us/',
    note: 'Contact form only — no published email or phone. Corrected from .com to .org.' },

  { name: 'Eventbrite',
    email: null, phone: null,
    website: 'https://www.eventbrite.com/create',
    note: 'Self-serve — no contact needed. Free listings for free events. Candidate for API automation.' },

  { name: 'Google Business Profile',
    email: null, phone: null,
    website: 'https://business.google.com/',
    note: 'Self-serve — post each event as an Event post on the Kindred listing. Highest leverage: shows in Search and Maps. Candidate for API automation.' },

  { name: 'Bandsintown',
    email: null, phone: null,
    website: 'https://www.bandsintown.com/',
    note: 'Artist-side, not venue-side. Listings come from the performer\'s own account, so the action is asking the talent to add the Kindred date — it reaches their followers. Claim the venue page too.' },

  { name: 'Idaho Statesman',
    email: null, phone: null,
    website: 'https://www.idahostatesman.com/',
    note: 'No event-submission path found — McClatchy papers largely dropped community calendars. Low priority.' },
];

async function run() {
  console.log(APPLY ? '*** APPLYING ***\n' : '*** DRY RUN — nothing will be written (pass --apply) ***\n');
  let changed = 0;

  for (const u of UPDATES) {
    const cur = (await query(`SELECT * FROM promo_contacts WHERE name = $1`, [u.name])).rows[0];
    if (!cur) { console.log(`WARN  no contact named "${u.name}" — skipping`); continue; }

    const diffs = [];
    if (u.email && cur.email !== u.email) diffs.push(`email: ${cur.email ?? '—'} -> ${u.email}`);
    if (u.phone && cur.phone !== u.phone) diffs.push(`phone: ${cur.phone ?? '—'} -> ${u.phone}`);
    if (u.website && cur.website !== u.website) diffs.push(`website: ${cur.website ?? '—'} -> ${u.website}`);
    // Append rather than replace, so anything already written by hand survives.
    const note = u.note && !(cur.notes || '').includes(u.note)
      ? [cur.notes, u.note].filter(Boolean).join(' ').trim() : null;
    if (note) diffs.push(`notes += "${u.note.slice(0, 60)}${u.note.length > 60 ? '…' : ''}"`);

    if (!diffs.length) { console.log(`  = ${u.name} — already current`); continue; }
    console.log(`  ~ ${u.name}`);
    for (const d of diffs) console.log(`      ${d}`);
    changed++;

    if (APPLY) {
      await query(
        `UPDATE promo_contacts
            SET email   = COALESCE($2, email),
                phone   = COALESCE($3, phone),
                website = COALESCE($4, website),
                notes   = COALESCE($5, notes)
          WHERE id = $1`,
        [cur.id, u.email, u.phone, u.website, note]);
    }
  }

  console.log(`\n${changed} contact(s) ${APPLY ? 'updated' : 'would change'}.`);
  if (!APPLY) { console.log('Dry run complete — nothing written. Re-run with --apply.'); process.exit(0); }

  const after = (await query(
    `SELECT count(*) n, count(email) with_email, count(phone) with_phone FROM promo_contacts`)).rows[0];
  console.log(`Now: ${after.n} contacts, ${after.with_email} with email, ${after.with_phone} with phone.`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
