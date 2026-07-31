/**
 * Idaho ABC portal — fill and save the monthly Beer/Wine report.
 *
 * Prepares and SAVES. Never submits: there is no code path here that clicks
 * the portal's submit control, because the attestation is the licensee's.
 *
 * After saving, this reads every value back off the portal and records what it
 * actually observed alongside what it meant to enter. Callers should trust
 * `observed`, not `entered` — an agent previously reported a portal save that
 * had never happened, and read-back is what makes the claim checkable.
 *
 * Browser use follows the pattern already proven in amazonSync.js.
 */
import { chromium } from 'playwright';
import { query } from '../db.js';
import { computeFiling } from './abcFiling.js';

const BASE = 'https://apps.isp.idaho.gov/AbcReporting';
const NAV_TIMEOUT = 45000;

/**
 * TeamHub's filing lines -> the portal's row labels.
 *
 * Beginning and Ending Inventory are deliberately absent: the portal carries
 * beginning forward from the last accepted report and derives ending from the
 * lines. Both are read back and checked, never typed.
 */
const LINE_LABELS = [
  ['purchases',       'Purchases/In-State Production Transfer'],
  ['production',      'Production'],
  ['spoilageSamples', 'Spoilage/Loss'],
  ['salesWholesale',  'Sales/Transfers to In-State Wholesalers'],
  ['salesOther',      'Sales/Transfers to Out-of-State Wholesalers'],
  ['salesRetail',     'Sales/Transfers to Idaho Retailers'],
  ['salesConsumers',  'Sales to Consumers'],
  ['returnedProduct', 'Returned Product'],
];

const n2 = (v) => (v === null || v === undefined || v === '' ? null
  : Number(String(v).replace(/[$,\s]/g, '')));

async function getCredentials(companyId) {
  const r = await query(
    `SELECT isp_username, isp_password FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  if (!row?.isp_username || !row?.isp_password) {
    throw new Error('ISP portal credentials are not configured in Settings.');
  }
  return { username: row.isp_username, password: row.isp_password };
}

/** The lines to file, from storage for reconciled months, else computed. */
async function linesFor(companyId, month) {
  const stored = await query(
    `SELECT * FROM abc_filings WHERE company_id = $1 AND period_month = $2`,
    [companyId, `${month}-01`]
  );
  const row = stored.rows[0];

  if (row?.has_detail) {
    if (row.status === 'filed') throw new Error(`${month} is already marked filed.`);
    return {
      source: 'stored',
      lines: {
        beginningInventory: n2(row.beginning_inventory), purchases: n2(row.purchases),
        production: n2(row.production), spoilageSamples: n2(row.spoilage_samples),
        salesWholesale: n2(row.sales_wholesale), salesRetail: n2(row.sales_retail),
        salesOther: n2(row.sales_other), salesConsumers: n2(row.sales_consumers),
        returnedProduct: n2(row.returned_product), endingInventory: n2(row.ending_inventory),
      },
    };
  }

  const filing = await computeFiling(companyId, month);
  if (!filing.readyToFile) {
    const e = new Error(`Preflight failed for ${month} — not touching the portal.`);
    e.blocking = filing.blocking;
    throw e;
  }
  return { source: 'computed', lines: filing.lines };
}

/** Month label as the portal writes it, e.g. "May 2026". */
function portalMonthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${y}`;
}

/** Set one numeric field, located by its row label. */
async function fillByLabel(page, label, value) {
  const input = page.locator('tr', { hasText: label }).locator('input[type="text"]').first();
  if (!(await input.count())) throw new Error(`No input found for portal line "${label}"`);
  await input.fill(String(value ?? 0));
}

/** Read one field back, located the same way. */
async function readByLabel(page, label) {
  const row = page.locator('tr', { hasText: label }).first();
  if (!(await row.count())) return null;
  const input = row.locator('input[type="text"]').first();
  if (await input.count()) return n2(await input.inputValue());
  return n2((await row.innerText()).split('\n').pop());
}

/**
 * Fill and save `month` on the portal.
 *
 * @param {string}  companyId
 * @param {string}  month              'YYYY-MM'
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun]      navigate and read, change nothing
 * @param {string}  [opts.trigger]     'manual' | 'scheduled'
 */
export async function runAbcPortalFill(companyId, month, opts = {}) {
  const { dryRun = false, trigger = 'manual' } = opts;
  const started = new Date();

  const run = await query(
    `INSERT INTO abc_portal_runs (company_id, period_month, status, trigger, started_at)
     VALUES ($1, $2, 'running', $3, $4) RETURNING id`,
    [companyId, `${month}-01`, trigger, started]
  );
  const runId = run.rows[0].id;

  const finish = async (status, patch = {}) => {
    await query(
      `UPDATE abc_portal_runs
          SET status = $2, entered = $3, observed = $4, mismatches = $5,
              screenshot = $6, error = $7, finished_at = NOW()
        WHERE id = $1`,
      [runId, status,
        patch.entered ? JSON.stringify(patch.entered) : null,
        patch.observed ? JSON.stringify(patch.observed) : null,
        patch.mismatches ? JSON.stringify(patch.mismatches) : null,
        patch.screenshot || null, patch.error || null]
    );
    return { ok: status === 'saved' || status === 'dry_run', runId, month, status, ...patch };
  };

  let browser;
  try {
    const { lines, source } = await linesFor(companyId, month);
    const creds = await getCredentials(companyId);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1600 } });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    // ── Sign in ──────────────────────────────────────────────────────────────
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', creds.username);
    await page.fill('input[name="password"]', creds.password);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]'),
    ]);
    if (/\/login/i.test(page.url())) throw new Error('Portal login failed — check the credentials in Settings.');

    // ── Open the outstanding report ──────────────────────────────────────────
    // The portal holds one report in progress at a time and exposes it as
    // "Continue Report", so the link is discovered rather than a URL guessed.
    const cont = page.locator('a[href*="bwReport/continue"]').first();
    if (!(await cont.count())) {
      throw new Error('No outstanding Beer/Wine report on the portal — nothing to continue.');
    }
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      cont.click(),
    ]);

    // Refuse to touch a report for a different period than asked for.
    const want = portalMonthLabel(month);
    const heading = (await page.locator('h1, h2').first().innerText().catch(() => '')) || '';
    if (!heading.includes(want)) {
      throw new Error(
        `Portal's outstanding report is not ${want} (page reads "${heading.trim().slice(0, 90)}"). `
        + `Months must be filed in order — file the earlier one first.`
      );
    }

    // ── Step 1: report Wine only ─────────────────────────────────────────────
    const wine = page.locator('#chk-WINE');
    if (await wine.count()) {
      for (const id of ['#chk-BEER', '#chk-STRONG_BEER', '#chk-CONTRACTED_BEER_PRODUCTION', '#chk-COCKTAILS']) {
        const box = page.locator(id);
        if ((await box.count()) && (await box.isChecked()) && !dryRun) await box.uncheck();
      }
      if (!(await wine.isChecked()) && !dryRun) await wine.check();
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.locator('button:has-text("Next"), a:has-text("Next")').first().click(),
      ]);
    }

    // ── Step 2: amounts ──────────────────────────────────────────────────────
    const entered = {};
    for (const [key, label] of LINE_LABELS) {
      entered[key] = lines[key] ?? 0;
      if (!dryRun) await fillByLabel(page, label, entered[key]);
    }

    if (!dryRun) {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.locator('a:has-text("Save"), button:has-text("Save")').first().click(),
      ]);
      await page.waitForTimeout(1500);
    }

    // ── Read back what the portal now holds ──────────────────────────────────
    const observed = {};
    for (const [key, label] of LINE_LABELS) observed[key] = await readByLabel(page, label);
    observed.beginningInventory = await readByLabel(page, 'Beginning Inventory');
    observed.endingInventory = await readByLabel(page, 'Ending Inventory');

    const mismatches = [];
    for (const [key] of LINE_LABELS) {
      const want2 = Number(entered[key] ?? 0);
      const got = observed[key];
      if (got === null || Math.abs(got - want2) > 0.005) {
        mismatches.push({ line: key, entered: want2, observed: got });
      }
    }
    // Beginning and ending are the portal's own arithmetic; disagreement there
    // means our books and the state's differ, which is worth surfacing loudly.
    for (const key of ['beginningInventory', 'endingInventory']) {
      const want2 = lines[key];
      const got = observed[key];
      if (want2 != null && got != null && Math.abs(got - want2) > 0.005) {
        mismatches.push({ line: key, entered: want2, observed: got, note: 'portal-derived' });
      }
    }

    const shot = `abc-portal-${month}-${started.toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`;
    await page.screenshot({ path: `uploads/${shot}`, fullPage: true }).catch(() => {});

    await browser.close();
    browser = null;

    return finish(dryRun ? 'dry_run' : (mismatches.length ? 'saved_with_mismatches' : 'saved'),
      { entered, observed, mismatches, source, screenshot: shot });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return finish('failed', { error: err.blocking ? `${err.message} ${err.blocking.join('; ')}` : err.message });
  }
}

/** Most recent portal run for a month (or the company's latest overall). */
export async function lastPortalRun(companyId, month) {
  const r = await query(
    `SELECT * FROM abc_portal_runs
      WHERE company_id = $1 ${month ? 'AND period_month = $2' : ''}
      ORDER BY started_at DESC LIMIT 1`,
    month ? [companyId, `${month}-01`] : [companyId]
  );
  return r.rows[0] || null;
}
