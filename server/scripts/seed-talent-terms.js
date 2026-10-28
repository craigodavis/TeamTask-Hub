/**
 * Seeds the first version of the performer terms.
 *
 * The wording is Craig's, written out — one pizza and one drink, promotion
 * expected, paid by deposit or cheque with those details taken by phone, and a
 * line about photos appearing on the website. It is stored as a record rather
 * than living in an email template so an acceptance can be read back verbatim.
 *
 * To change the terms, add a NEW version. Never edit one that has been
 * accepted: the whole point is that "what did they agree to" has an answer.
 *   DB_HOST=localhost node scripts/seed-talent-terms.js
 */
import { query } from '../db.js';

const VERSION = '2026-11';
const BODY = `## Playing at Kindred

**What we provide**

One pizza and one drink for you during your performance.

**What we ask**

That you actively promote the show — a post on your socials, a mention to your
mailing list, and your own event listings. The people who come because you told
them are the ones who make the night work.

**How we pay**

Direct deposit or a mailed cheque, whichever you prefer. We will take those
details from you over the phone.

Never send bank details or your Social Security / tax ID by email, by text, or
through this form. We will not ask you to. If anything claiming to be from
Kindred asks you to, it is not us.

**Your photos and links**

The photo, bio and links you send may appear on our website and in how we
promote the show. Tell us any time if you want something changed or taken down.`;

async function run() {
  const co = (await query(
    `SELECT id FROM companies WHERE slug ILIKE 'kindred%' OR name ILIKE '%kindred%'
      ORDER BY created_at LIMIT 1`)).rows[0];
  if (!co) throw new Error('no company found');

  const existing = (await query(`SELECT version FROM terms_versions WHERE version = $1`, [VERSION])).rows[0];
  if (existing) {
    const used = (await query(
      `SELECT count(*)::int AS n FROM talent_terms_acceptances WHERE terms_version = $1`, [VERSION])).rows[0].n;
    console.log(`"${VERSION}" already exists (${used} acceptance${used === 1 ? '' : 's'}) — left untouched.`);
    console.log(used ? 'Accepted terms are never edited. Add a new version instead.' : 'Delete it first if you want to reseed.');
    process.exit(0);
  }

  await query(
    `INSERT INTO terms_versions (version, company_id, body_md) VALUES ($1,$2,$3)`,
    [VERSION, co.id, BODY]);
  console.log(`Seeded terms version "${VERSION}" (${BODY.length} chars).`);
  process.exit(0);
}
run().catch((e) => { console.error(e); process.exit(1); });
