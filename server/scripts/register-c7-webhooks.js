/**
 * Registers the Commerce7 webhooks that keep the public website current.
 *
 * The website is a static build, so a club renamed or a product published in
 * Commerce7 is invisible until something rebuilds. Team's own content already
 * triggers a rebuild on write (lib/websiteDeploy.js); Commerce7 is a separate
 * system Team never sees edits to, so it has to tell us.
 *
 * Idempotent — it lists what's already registered and only creates what's
 * missing, so running it twice is safe and running it after adding an object to
 * the list does the right thing.
 *
 *   node server/scripts/register-c7-webhooks.js            # dry run, shows the plan
 *   node server/scripts/register-c7-webhooks.js --apply    # actually creates them
 *
 * Reads TEAM_PUBLIC_URL (or APP_BASE_URL) for the callback, and C7_WEBHOOK_SECRET
 * if set — that has to match what the receiving server has, so register from the
 * same environment whose .env the webhook will be answered by.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { makeC7Client } from '../lib/commerce7Client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// What the site actually builds from. Club drives /club and /club/[slug];
// Product and Collection drive the shop's pre-rendered routes.
const OBJECTS = ['Club', 'Product', 'Collection'];
const ACTIONS = ['Create', 'Update', 'Delete'];

const apply = process.argv.includes('--apply');

async function main() {
  const base = (process.env.TEAM_PUBLIC_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('Set APP_BASE_URL (or TEAM_PUBLIC_URL) so Commerce7 knows where to call.');
  const secret = process.env.C7_WEBHOOK_SECRET;
  const url = `${base}/api/website/commerce7-hook${secret ? `?key=${encodeURIComponent(secret)}` : ''}`;

  const cr = await query(`SELECT id FROM companies WHERE lower(name) LIKE '%kindred%' ORDER BY created_at LIMIT 1`);
  const companyId = cr.rows[0]?.id;
  if (!companyId) throw new Error('No Kindred company row found.');

  const ir = await query(
    `SELECT company_id, c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
       FROM company_integrations WHERE company_id = $1`, [companyId]);
  const integration = ir.rows[0];
  if (!integration?.c7_api_key) throw new Error('No Commerce7 API key stored for Kindred.');
  const c7 = makeC7Client(integration);

  // Commerce7's own API reference is behind a login, so the key holding the list
  // isn't something I could confirm — take whichever array comes back rather than
  // betting on a name. Getting this wrong silently would mean "nothing exists",
  // and we'd create a duplicate set on every run.
  const listed = await c7.get('/web-hook');
  const existing = Array.isArray(listed)
    ? listed
    : Object.values(listed || {}).find(Array.isArray) || [];
  if (!Array.isArray(listed) && !Object.values(listed || {}).some(Array.isArray)) {
    throw new Error(`Could not find the webhook list in Commerce7's reply: ${JSON.stringify(listed).slice(0, 200)}`);
  }
  console.log(`Tenant ${integration.c7_tenant_slug} — ${existing.length} webhook(s) already registered.`);
  for (const w of existing) console.log(`  have: ${w.object}/${w.action} → ${String(w.url).split('?')[0]}`);

  const want = [];
  for (const object of OBJECTS) {
    for (const action of ACTIONS) {
      // Match on object+action+path, ignoring the query string, so rotating the
      // secret doesn't look like a different hook and create a duplicate.
      const hit = existing.find(
        (w) => w.object === object && w.action === action && String(w.url).split('?')[0] === url.split('?')[0]
      );
      if (!hit) want.push({ object, action, url });
    }
  }

  if (!want.length) return console.log('\nNothing to do — all webhooks already point here.');

  console.log(`\n${apply ? 'Creating' : 'Would create'} ${want.length}:`);
  for (const w of want) console.log(`  ${w.object}/${w.action} → ${url.split('?')[0]}${secret ? '?key=…' : ''}`);
  if (!apply) return console.log('\nDry run. Re-run with --apply to create them.');

  for (const w of want) {
    try {
      await c7.post('/web-hook', w);
      console.log(`  created ${w.object}/${w.action}`);
    } catch (e) {
      console.error(`  FAILED ${w.object}/${w.action}: ${e.message}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
