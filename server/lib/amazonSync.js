/**
 * amazonSync — Playwright-based Amazon Business order automation.
 *
 * Logs into Amazon Business, downloads the Order History CSV for a rolling
 * date window, imports payment records, then downloads a PDF invoice for each
 * new order and feeds it through the shared receipt ingestion pipeline.
 *
 * Entry point: runAmazonSync(companyId)
 * Returns: { orders_imported, receipts_created, receipts_skipped, pdfs_failed, errors[] }
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOTP, Secret } from 'otpauth';
import { query } from '../db.js';
import { loadReceiptContext, processReceiptPDF } from './processReceiptPDF.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Generate a current 6-digit TOTP code from an Amazon authenticator-app secret
// (the base32 key Amazon shows under "Can't scan the barcode?"). Spaces ok.
function generateOtp(secret) {
  const clean = String(secret).replace(/\s+/g, '').toUpperCase();
  const totp = new TOTP({ issuer: 'Amazon', algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(clean) });
  return totp.generate();
}

// Where Playwright session state is persisted per company
const SESSION_DIR = path.join(__dirname, '..', 'uploads', 'amazon_sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

const AMAZON_BASE = 'https://business.amazon.com';
const LOGIN_TIMEOUT  = 30_000;  // ms
const NAV_TIMEOUT    = 45_000;
const DOWNLOAD_WAIT  = 60_000;  // CSV can be slow to generate

// ── CSV helpers (same format as the manual upload route) ────────────────────

function parseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current); current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function cleanValue(v) {
  if (typeof v !== 'string') return v;
  v = v.trim();
  if (v.startsWith('="') && v.endsWith('"')) v = v.slice(2, -1);
  return v;
}

function parseDate(str) {
  if (!str || str === 'N/A') return null;
  const parts = str.split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts;
  if (!m || !d || !y || y.length !== 4) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parseCSVText(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseLine(lines[0]).map(cleanValue);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseLine(line);
    const row = {};
    headers.forEach((h, idx) => { row[h] = cleanValue(vals[idx] || ''); });
    rows.push(row);
  }
  return rows;
}

// ── Session management ───────────────────────────────────────────────────────

function sessionPath(companyId) {
  return path.join(SESSION_DIR, `${companyId}.json`);
}

async function loadSession(companyId) {
  const sp = sessionPath(companyId);
  if (fs.existsSync(sp)) {
    try {
      return JSON.parse(fs.readFileSync(sp, 'utf-8'));
    } catch { /* ignore corrupt file */ }
  }
  return null;
}

async function saveSession(companyId, state) {
  fs.writeFileSync(sessionPath(companyId), JSON.stringify(state));
}

function clearSession(companyId) {
  try { fs.unlinkSync(sessionPath(companyId)); } catch { /* ok */ }
}

// ── Login ────────────────────────────────────────────────────────────────────

/**
 * Check whether the current page indicates we're signed in to Amazon Business.
 * Amazon Business shows a "Hello, <name>" or a sign-in button in the nav.
 */
async function isLoggedIn(page) {
  try {
    // Amazon Business nav shows the account name when signed in
    const signInBtn = await page.$('#nav-signin-tooltip');
    if (signInBtn) return false;
    const accountSpan = await page.$('#nav-link-accountList-nav-line-1');
    if (accountSpan) {
      const text = await accountSpan.textContent();
      return !text?.toLowerCase().includes('sign in') && !text?.toLowerCase().includes('hello, sign in');
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Perform a full login to Amazon Business.
 * Throws if login fails or if MFA/CAPTCHA is encountered.
 */
async function login(page, email, password, otpSecret) {
  console.log('[amazon-sync] Starting login flow…');

  const debugDir = path.join(__dirname, '..', 'uploads', 'debug');
  fs.mkdirSync(debugDir, { recursive: true });

  // Go STRAIGHT to Amazon's sign-in form (robust) rather than landing on
  // business.amazon.com and hunting for a sign-in link. This is the flow the
  // harvester connector uses and it reliably renders the email field.
  await page.goto(
    'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0',
    { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
  );
  await page.screenshot({ path: path.join(debugDir, 'amazon-login-1.png') }).catch(() => {});

  // Email step — tolerate both classic (#ap_email) and newer sign-in forms.
  const emailInput = page.locator('#ap_email, input[type="email"], input[name="email"], input[placeholder*="email" i], input[placeholder*="mobile" i]').first();
  try {
    await emailInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT });
  } catch (e) {
    await page.screenshot({ path: path.join(debugDir, 'amazon-login-noemail.png') }).catch(() => {});
    throw new Error(`Amazon sign-in form did not load (no email field). Amazon may be showing a bot check. URL: ${page.url()}`);
  }
  await emailInput.fill(email);

  const continueBtn = page.locator('#continue, input[type="submit"], button[type="submit"]').first();
  if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await continueBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: LOGIN_TIMEOUT }).catch(() => {});

  // Password step
  const passwordInput = page.locator('#ap_password, input[type="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT });
  await passwordInput.fill(password);

  const signInBtn = page.locator('#signInSubmit, input[type="submit"], button[type="submit"]').first();
  await signInBtn.click();

  // Wait for navigation — success, captcha, or MFA prompt
  await page.waitForLoadState('domcontentloaded', { timeout: LOGIN_TIMEOUT });

  const url = page.url();

  // Check for CAPTCHA
  if (url.includes('validateCaptcha') || await page.$('#captchacharacters')) {
    throw new Error('Amazon is showing a CAPTCHA — manual login required. Visit Amazon Business and complete the CAPTCHA, then retry.');
  }

  // ax/claim — secondary password confirmation page.
  if (url.includes('ax/claim')) {
    console.log('[amazon-sync] ax/claim re-auth page — entering password again…');
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const claimPassword = page.locator('input[type="password"]').first();
    if (await claimPassword.isVisible({ timeout: 8000 }).catch(() => false)) {
      await claimPassword.fill(password);
      await page.locator('button:has-text("Sign in"), input[type="submit"], button[type="submit"]').first().click().catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: LOGIN_TIMEOUT }).catch(() => {});
    }
  }

  // CVF ("Verify it's you" device check) — click "This was me" / Continue to
  // proceed. Afterward Amazon usually shows the authenticator OTP field, which
  // the MFA handler below then fills. (If CVF instead insists on an email/SMS
  // code we can't read, the login will fail clearly — that's Amazon's headless
  // bot check; the real harvester runs a non-headless browser and rarely hits it.)
  if (page.url().includes('ap/cvf')) {
    console.log('[amazon-sync] CVF verification page — attempting to continue…');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(debugDir, 'cvf-page.png') }).catch(() => {});
    const confirmBtn = page.locator(
      'input[value*="This was me" i], button:has-text("This was me"), a:has-text("This was me"), ' +
      'input[value*="Continue" i], button:has-text("Continue"), input[type="submit"]'
    ).first();
    if (await confirmBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      await confirmBtn.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: LOGIN_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  // MFA / OTP — enter the authenticator code automatically instead of bailing.
  const otpField = page.locator('#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code').first();
  if (await otpField.isVisible({ timeout: 5000 }).catch(() => false)) {
    if (!otpSecret) {
      throw new Error('Amazon requires a 2FA code but no authenticator secret is configured. Add it in Settings → Integrations.');
    }
    console.log('[amazon-sync] 2FA prompt detected — entering authenticator code…');
    const remember = page.locator('#auth-mfa-remember-device').first();
    if (await remember.isVisible({ timeout: 2000 }).catch(() => false)) await remember.check().catch(() => {});

    let ok = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const code = generateOtp(otpSecret);
      await otpField.fill('');
      await otpField.fill(code);
      const submit = page.locator('#auth-signin-button, input[type="submit"], button[type="submit"]').first();
      await submit.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: LOGIN_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(1500);
      const stillPrompting = await page.locator('#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code').first()
        .isVisible({ timeout: 2000 }).catch(() => false);
      if (!stillPrompting) { ok = true; break; }
      console.warn(`[amazon-sync] 2FA code rejected (attempt ${attempt}) — retrying…`);
      await page.waitForTimeout(2000);
    }
    if (!ok) throw new Error('Amazon 2FA failed — the authenticator secret may be wrong. Check Settings → Integrations.');
    console.log('[amazon-sync] 2FA passed.');
  }

  // Check for error message
  const errorMsg = await page.$('#auth-error-message-box, .a-alert-content');
  if (errorMsg) {
    const text = await errorMsg.textContent();
    if (text?.includes('password') || text?.includes('incorrect')) {
      throw new Error(`Amazon login failed: ${text.trim()}`);
    }
  }

  // Verify we're actually signed in
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    // May have landed on a post-login page — check URL
    if (!url.includes('business.amazon.com') && !url.includes('amazon.com/b2b')) {
      throw new Error(`Unexpected page after login: ${url}`);
    }
  }

  console.log('[amazon-sync] Login successful.');
}

// ── CSV download ─────────────────────────────────────────────────────────────

/**
 * Navigate to Amazon Business Order History Reports and download CSV.
 * Returns the CSV content as a string.
 */
async function downloadOrderHistoryCSV(page, fromDate, toDate) {
  console.log(`[amazon-sync] Downloading order history CSV (${fromDate} → ${toDate})…`);

  // Amazon Business analytics/reports
  await page.goto(`${AMAZON_BASE}/analytics/reports/order-history`, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT,
  });

  // If redirected away, try the legacy URL
  if (!page.url().includes('analytics')) {
    await page.goto(`${AMAZON_BASE}/b2b/reports/order-history`, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });
  }

  // Amazon Business typically has a date range form and a download/export button.
  // Strategy: look for date inputs, fill them, then click export/download.

  // Set start date
  const startInput = page.locator('input[name="startDate"], input[placeholder*="Start"], input[aria-label*="start date" i], #startDate').first();
  if (await startInput.isVisible({ timeout: 8000 }).catch(() => false)) {
    await startInput.triple_click?.() ?? await startInput.click({ clickCount: 3 });
    await startInput.fill(fromDate);
  }

  // Set end date
  const endInput = page.locator('input[name="endDate"], input[placeholder*="End"], input[aria-label*="end date" i], #endDate').first();
  if (await endInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await endInput.triple_click?.() ?? await endInput.click({ clickCount: 3 });
    await endInput.fill(toDate);
  }

  // Click the download/export button and wait for the file download
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_WAIT }),
    page.locator('button:has-text("Download"), button:has-text("Export"), a:has-text("Download CSV"), a:has-text("Export")').first().click(),
  ]);

  // Read the downloaded file
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('CSV download failed — no file path returned.');
  const csvText = fs.readFileSync(downloadPath, 'utf-8');
  return csvText;
}

// ── PDF invoice download ─────────────────────────────────────────────────────

/**
 * Download the invoice PDF for a single Amazon order.
 * Returns a Buffer, or null if no invoice link is found.
 */
async function downloadInvoicePDF(page, orderId) {
  try {
    // Navigate to order details page
    await page.goto(
      `${AMAZON_BASE}/orders/order-details?orderId=${orderId}`,
      { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
    );

    // Look for "Invoice" link (may say "View invoice" or just "Invoice")
    const invoiceLink = page.locator('a:has-text("Invoice"), a:has-text("View invoice"), a[href*="invoice"]').first();

    if (!await invoiceLink.isVisible({ timeout: 8000 }).catch(() => false)) {
      // Fallback: try the standard Amazon order detail page
      await page.goto(
        `https://www.amazon.com/gp/css/order-details?orderID=${orderId}`,
        { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }
      );
      const altLink = page.locator('a:has-text("Invoice"), a[href*="invoice"]').first();
      if (!await altLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        return null;
      }
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        altLink.click(),
      ]);
      const p = await download.path();
      return p ? fs.readFileSync(p) : null;
    }

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      invoiceLink.click(),
    ]);
    const p = await download.path();
    return p ? fs.readFileSync(p) : null;
  } catch (err) {
    console.error(`[amazon-sync] PDF download failed for order ${orderId}:`, err.message);
    return null;
  }
}

// ── CSV import (mirrors the upload route logic) ──────────────────────────────

async function importCSVRows(companyId, rows) {
  const paymentsMap = new Map();

  for (const row of rows) {
    const payRef = row['Payment Reference ID'];
    const orderId = row['Order ID'];
    if (!payRef || payRef === 'N/A' || !orderId) continue;

    if (!paymentsMap.has(payRef)) {
      paymentsMap.set(payRef, {
        payment_reference_id: payRef,
        payment_date: parseDate(row['Payment Date']),
        payment_amount: parseFloat(row['Payment Amount']) || null,
        payment_instrument: row['Payment Instrument Type'] || null,
        card_last4: row['Payment Identifier'] || null,
        order_ids: new Set(),
        items: [],
      });
    }

    const p = paymentsMap.get(payRef);
    p.order_ids.add(orderId);

    const title = row['Title'] || '';
    const itemSubtotal = parseFloat(row['Item Subtotal']) || 0;
    const itemTax = parseFloat(row['Item Tax']) || 0;
    const itemNetTotal = parseFloat(row['Item Net Total']) || null;
    const itemTotal = itemNetTotal != null ? itemNetTotal : itemSubtotal + itemTax;

    if (title) {
      p.items.push({
        order_id: orderId,
        asin: row['ASIN'] || null,
        title,
        item_subtotal: itemSubtotal,
        item_tax: itemTax,
        item_total: itemTotal,
      });
    }
  }

  let upserted = 0;
  const allOrderIds = new Set();

  for (const [, p] of paymentsMap) {
    const orderIds = [...p.order_ids];
    orderIds.forEach((id) => allOrderIds.add(id));

    const payRes = await query(
      `INSERT INTO amazon_payments
         (company_id, payment_reference_id, payment_date, payment_amount,
          payment_instrument, card_last4, order_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, payment_reference_id) DO UPDATE SET
         payment_date       = EXCLUDED.payment_date,
         payment_amount     = EXCLUDED.payment_amount,
         payment_instrument = EXCLUDED.payment_instrument,
         card_last4         = EXCLUDED.card_last4,
         order_ids          = EXCLUDED.order_ids,
         imported_at        = NOW()
       RETURNING id`,
      [companyId, p.payment_reference_id, p.payment_date, p.payment_amount,
       p.payment_instrument, p.card_last4, orderIds]
    );
    const paymentId = payRes.rows[0].id;

    await query(`DELETE FROM amazon_payment_items WHERE payment_id = $1`, [paymentId]);
    for (const item of p.items) {
      await query(
        `INSERT INTO amazon_payment_items
           (payment_id, order_id, asin, title, item_subtotal, item_tax, item_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [paymentId, item.order_id, item.asin, item.title,
         item.item_subtotal, item.item_tax, item.item_total]
      );
    }

    upserted++;
  }

  return { upserted, orderIds: [...allOrderIds] };
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function toDateString(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function subtractDays(d, n) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() - n);
  return dt;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the full Amazon Business sync for a company.
 *
 * @param {string} companyId
 * @returns {{ orders_imported, receipts_created, receipts_skipped, pdfs_failed, errors[] }}
 */
export async function runAmazonSync(companyId) {
  const result = {
    orders_imported: 0,
    receipts_created: 0,
    receipts_skipped: 0,
    pdfs_failed: 0,
    errors: [],
  };

  // 1. Load credentials
  const credRow = await query(
    `SELECT amazon_email, amazon_password, amazon_otp_secret FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const creds = credRow.rows[0];
  const otpSecret = process.env.AMAZON_OTP_SECRET || creds?.amazon_otp_secret || null;
  if (!creds?.amazon_email || !creds?.amazon_password) {
    throw new Error('Amazon Business credentials not configured. Add email and password in Settings → Integrations.');
  }

  // 2. Determine date range — since last payment date or 30 days back, whichever is more recent
  const lastPaymentRes = await query(
    `SELECT MAX(payment_date) AS last_date FROM amazon_payments WHERE company_id = $1`,
    [companyId]
  );
  const lastDate = lastPaymentRes.rows[0]?.last_date;
  const now = new Date();
  const fromDate = lastDate
    ? toDateString(subtractDays(new Date(lastDate), 3)) // 3-day overlap to catch stragglers
    : toDateString(subtractDays(now, 30));
  const toDate = toDateString(now);

  console.log(`[amazon-sync] Company ${companyId}: syncing ${fromDate} → ${toDate}`);

  // 3. Launch Playwright
  const savedSession = await loadSession(companyId);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let context;
  try {
    context = await browser.newContext({
      storageState: savedSession || undefined,
      acceptDownloads: true,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
  } catch {
    // If saved session is corrupt, start fresh
    clearSession(companyId);
    context = await browser.newContext({ acceptDownloads: true });
  }

  const page = await context.newPage();

  try {
    // 4. Check if already logged in; log in if not
    await page.goto(`${AMAZON_BASE}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const alreadyIn = await isLoggedIn(page);

    if (!alreadyIn) {
      console.log('[amazon-sync] Session expired or not found — logging in…');
      clearSession(companyId);
      await login(page, creds.amazon_email, creds.amazon_password, otpSecret);
      // Save new session
      const state = await context.storageState();
      await saveSession(companyId, state);
    } else {
      console.log('[amazon-sync] Reusing existing session.');
    }

    // 5. Download CSV
    let csvText;
    try {
      csvText = await downloadOrderHistoryCSV(page, fromDate, toDate);
    } catch (err) {
      // If CSV download fails after a session reuse, force re-login and try once more
      if (alreadyIn) {
        console.warn('[amazon-sync] CSV download failed with saved session — attempting fresh login…');
        clearSession(companyId);
        await login(page, creds.amazon_email, creds.amazon_password, otpSecret);
        const state = await context.storageState();
        await saveSession(companyId, state);
        csvText = await downloadOrderHistoryCSV(page, fromDate, toDate);
      } else {
        throw err;
      }
    }

    // 6. Parse and import CSV
    const rows = parseCSVText(csvText);
    const { upserted, orderIds } = await importCSVRows(companyId, rows);
    result.orders_imported = upserted;

    console.log(`[amazon-sync] Imported ${upserted} payment records covering ${orderIds.length} orders.`);

    // 7. Find orders not yet in receipts table
    if (orderIds.length > 0) {
      const placeholders = orderIds.map((_, i) => `$${i + 2}`).join(',');
      const existingRes = await query(
        `SELECT order_number FROM receipts
         WHERE company_id = $1 AND order_number IN (${placeholders})`,
        [companyId, ...orderIds]
      );
      const existingOrderIds = new Set(existingRes.rows.map((r) => r.order_number));
      const newOrderIds = orderIds.filter((id) => !existingOrderIds.has(id));

      console.log(`[amazon-sync] ${newOrderIds.length} new orders to process (${existingOrderIds.size} already imported).`);

      // 8. Load receipt processing context once for all PDFs
      const ctx = await loadReceiptContext(companyId);

      // 9. Download and process PDFs for new orders (sequential to avoid overwhelming Amazon)
      for (const orderId of newOrderIds) {
        try {
          const pdfBuffer = await downloadInvoicePDF(page, orderId);

          if (!pdfBuffer) {
            console.warn(`[amazon-sync] No invoice PDF found for order ${orderId}`);
            result.pdfs_failed++;
            result.errors.push({ orderId, error: 'No invoice PDF found' });
            continue;
          }

          const filename = `Amazon_${orderId}.pdf`;
          // processReceiptPDF returns an array — one entry per order found in the PDF
          const receiptResults = await processReceiptPDF(companyId, pdfBuffer, filename, ctx);

          for (const receiptResult of receiptResults) {
            if (receiptResult.skipped) {
              result.receipts_skipped++;
            } else if (receiptResult.error) {
              result.pdfs_failed++;
              result.errors.push({ orderId, error: receiptResult.error });
            } else {
              result.receipts_created++;
            }
          }

          const summary = receiptResults.map((r) => r.skipped ? 'skipped (duplicate)' : r.error ? `error: ${r.error}` : `imported ${r.order_number}`).join(', ');
          console.log(`[amazon-sync] Order ${orderId}: ${summary}`);
        } catch (err) {
          console.error(`[amazon-sync] Failed to process order ${orderId}:`, err.message);
          result.pdfs_failed++;
          result.errors.push({ orderId, error: err.message });
        }
      }
    }

    // Save session state for next run
    const finalState = await context.storageState();
    await saveSession(companyId, finalState);

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(`[amazon-sync] Done — orders: ${result.orders_imported}, receipts: ${result.receipts_created}, skipped: ${result.receipts_skipped}, failed: ${result.pdfs_failed}`);
  return result;
}

/**
 * Test Amazon Business credentials by attempting to log in.
 * Clears any saved session first to force a fresh login.
 *
 * @param {string} companyId
 * @param {string} email
 * @param {string} password
 * @returns {{ ok: true, message: string }}
 */
export async function testAmazonLogin(companyId, email, password) {
  clearSession(companyId);

  // Load the stored authenticator secret so the test exercises 2FA end-to-end.
  let otpSecret = process.env.AMAZON_OTP_SECRET || null;
  if (!otpSecret) {
    const r = await query(`SELECT amazon_otp_secret FROM company_integrations WHERE company_id = $1`, [companyId]);
    otpSecret = r.rows[0]?.amazon_otp_secret || null;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    acceptDownloads: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await login(page, email, password, otpSecret);
    // Save session so the next real sync doesn't need to log in again
    const state = await context.storageState();
    await saveSession(companyId, state);
    return { ok: true, message: 'Successfully logged in to Amazon Business.' };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
