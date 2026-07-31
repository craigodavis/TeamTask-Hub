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

/**
 * The portal greets you with a "newsflash" announcement modal that sits over
 * the page and swallows clicks. Dismiss whatever is open before interacting.
 */
async function dismissModals(page) {
  await page.waitForSelector('body', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);           // let the modal actually render
  // Try the polite close first, then remove the backdrop outright. Waiting on a
  // click here races the modal's own fade-in, and a leftover backdrop silently
  // swallows every later click.
  const closer = page.locator(
    '.modal.in [data-dismiss="modal"], .modal.show [data-bs-dismiss="modal"], .modal.in .close, .modal.show .close'
  ).first();
  if (await closer.count().catch(() => 0)) {
    await closer.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => {
    document.querySelectorAll('.modal, .modal-backdrop').forEach((el) => el.remove());
    if (document.body) {
      document.body.classList.remove('modal-open');
      document.body.style.removeProperty('overflow');
      document.body.style.removeProperty('padding-right');
    }
  }).catch(() => {});
}

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

/**
 * Map each row label to the input name inside the WINE section only.
 *
 * The amounts page repeats identical row labels once per reported category, so
 * a document-wide "first row containing this label" lands on Beer. This walks
 * up from the "Wine Gallons" heading to its enclosing block and reads the field
 * names from there, giving exact selectors that do not depend on which
 * categories happen to be ticked or on a hardcoded category index.
 *
 * Returns { labelText: {name, value} } plus derived read-only figures.
 */
async function wineFieldMap(page) {
  return page.evaluate(() => {
    // Categories are COLUMNS, line items are ROWS, so the column position of the
    // "Wine Gallons" header is what identifies our fields. Matching a row label
    // alone would land on Beer, since every label repeats once per category.
    const th = Array.from(document.querySelectorAll('th'))
      .find((h) => /^\s*Wine Gallons\b/i.test(h.textContent || ''));
    if (!th || !th.parentElement) return null;

    const pos = Array.from(th.parentElement.children).indexOf(th);
    if (pos < 1) return null;                       // column 0 is the row label

    const table = th.closest('table');
    if (!table) return null;

    const out = { categoryIndex: pos - 1, fields: {}, readonly: {} };
    for (const row of Array.from(table.querySelectorAll('tr'))) {
      const cells = Array.from(row.children);
      if (cells.length <= pos) continue;
      const label = (cells[0].textContent || '').trim().replace(/\s+/g, ' ');
      if (!label) continue;
      const cell = cells[pos];
      const input = cell.querySelector('input');
      if (input && input.name) {
        out.fields[label] = { name: input.name, value: input.value };
      } else {
        const t = (cell.textContent || '').trim();
        if (t) out.readonly[label] = t;
      }
    }
    return out;
  });
}

/** Find the entry in a field map whose label starts with `label`. */
function pick(map, label) {
  const key = Object.keys(map || {}).find((k) => k.toLowerCase().startsWith(label.toLowerCase()));
  return key ? map[key] : null;
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
    await dismissModals(page);

    // ── Open the outstanding report ──────────────────────────────────────────
    // The portal holds one report in progress at a time and exposes it as
    // "Continue Report", so the link is discovered rather than a URL guessed.
    const cont = page.locator('a[href*="bwReport/continue"]').first();
    if (!(await cont.count())) {
      throw new Error('No outstanding Beer/Wine report on the portal — nothing to continue.');
    }
    // Navigate to the href rather than clicking it. The newsflash dialog can
    // re-open at any moment and float over the link, and no amount of dismissing
    // beforehand wins that race reliably. A goto cannot be intercepted.
    const contHref = await cont.getAttribute('href');
    await page.goto(new URL(contHref, BASE).toString(), { waitUntil: 'networkidle' });
    await dismissModals(page);

    // Refuse to touch a report for a different period than asked for.
    // Match against the whole page rather than a specific heading element —
    // the title is not reliably the first h1/h2 on the page.
    const want = portalMonthLabel(month);
    const pageText = (await page.locator('body').innerText().catch(() => '')) || '';
    if (!pageText.includes(want)) {
      const seen = (pageText.match(/Beer\/Wine Report[^\n]*/) || [''])[0]
        || pageText.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '(page unreadable)';
      throw new Error(
        `Portal's outstanding report is not ${want} — it reads "${seen.slice(0, 90)}". `
        + `Months must be filed in order; file the earlier one first.`
      );
    }

    // ── Step 1: report Wine only ─────────────────────────────────────────────
    const wine = page.locator('#chk-WINE');
    if (await wine.count()) {
      // Only ensure Wine is reportable. The other categories are left exactly as
      // the portal has them: which categories appear on a filed report is the
      // licensee's choice and matches how previous months were submitted.
      // Wine is located by column position later, so extra columns are harmless.
      if (!(await wine.isChecked()) && !dryRun) await wine.check();
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.locator('button:has-text("Next"), a:has-text("Next")').first()
          .click({ force: true }),
      ]);
      await dismissModals(page);
    }

    // ── Step 2: amounts ──────────────────────────────────────────────────────
    const map = await wineFieldMap(page);
    if (!map) throw new Error('Could not find the Wine Gallons section on the amounts page.');

    const entered = {};
    for (const [key, label] of LINE_LABELS) {
      entered[key] = lines[key] ?? 0;
      const f = pick(map.fields, label);
      if (!f) throw new Error(`No Wine input for portal line "${label}".`);
      if (!dryRun) await page.fill(`[name="${f.name}"]`, String(entered[key]));
    }

    if (!dryRun) {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.locator('a:has-text("Save"), button:has-text("Save")').first()
          .click({ force: true }),
      ]);
      await page.waitForTimeout(1500);
      await dismissModals(page);
    }

    // ── Read back what the portal now holds ──────────────────────────────────
    // Re-derive the map: after saving, the page has been re-rendered and the
    // earlier element handles are stale.
    const after = (await wineFieldMap(page)) || map;
    const observed = {};
    for (const [key, label] of LINE_LABELS) {
      const f = pick(after.fields, label);
      observed[key] = f ? n2(f.value) : null;
    }
    observed.beginningInventory = n2(pick(after.readonly, 'Beginning Inventory')
      ?? pick(after.fields, 'Beginning Inventory')?.value);
    observed.endingInventory = n2(pick(after.readonly, 'Ending Inventory')
      ?? pick(after.fields, 'Ending Inventory')?.value);

    const mismatches = [];
    for (const [key] of LINE_LABELS) {
      const want2 = Number(entered[key] ?? 0);
      const got = observed[key];
      // The portal renders a zero line as an empty box, so blank-for-zero is
      // agreement, not a discrepancy. Flagging it would put five false warnings
      // on every clean month and teach the reader to ignore the real one.
      if (got === null && want2 === 0) continue;
      if (got === null || Math.abs(got - want2) > 0.005) {
        mismatches.push({ line: key, entered: want2, observed: got });
      }
    }
    // Beginning and ending are the portal's own arithmetic; disagreement there
    // means our books and the state's differ, which is worth surfacing loudly.
    for (const key of ['beginningInventory', 'endingInventory']) {
      const want2 = lines[key];
      const got = observed[key];
      if (want2 != null && got != null && Math.abs(got - want2) > 1) {
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
