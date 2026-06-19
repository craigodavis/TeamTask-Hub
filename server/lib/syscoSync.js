/**
 * syscoSync — Playwright-based Sysco Shop catalog lookup.
 *
 * Sysco's catalog/pricing is per-customer and gated behind login, so there is
 * no public product API. This module logs into shop.sysco.com with the
 * company's stored credentials, persists the session, and looks up product
 * details (name, pack, UOM) by Sysco item number.
 *
 * Because Sysco commonly enforces MFA, the bootstrap/test flow runs HEADED so
 * the owner can complete any 2FA challenge once on their machine; the resulting
 * session is saved and reused HEADLESS for subsequent enrichment runs.
 *
 * Entry points:
 *   testSyscoLogin(companyId, username, password)  — headed bootstrap, saves session
 *   lookupSyscoItem(companyId, itemNumber)         — headless, returns product data
 *
 * Mirrors the architecture of amazonSync.js (session dir, load/save/clear).
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persistent Playwright browser profile per company. A persistent profile (vs a
// copied storageState blob) preserves cookies, localStorage, and the browser
// fingerprint across runs — essential for Sysco, whose session does not survive
// being transplanted into a fresh headless browser.
const PROFILE_DIR = path.join(__dirname, '..', 'uploads', 'sysco_profiles');
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const SYSCO_BASE     = 'https://shop.sysco.com';
const LOGIN_TIMEOUT  = 30_000;   // ms — for an individual selector to appear
const NAV_TIMEOUT    = 45_000;
const MFA_WAIT       = 180_000;  // up to 3 min for the user to finish MFA in the headed window
const LOOKUP_WAIT    = 20_000;   // how long to collect catalog API responses

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Persistent profile management ─────────────────────────────────────────────

function profileDir(companyId) {
  return path.join(PROFILE_DIR, companyId);
}

/**
 * Launch a persistent browser context for this company. Reuses the on-disk
 * profile so a previously-established Sysco session carries over.
 */
async function launchContext(companyId, { headed }) {
  return chromium.launchPersistentContext(profileDir(companyId), {
    headless: !headed,
    acceptDownloads: false,
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
}

export function hasSyscoSession(companyId) {
  // A profile dir with cookies present means we've logged in at least once.
  return fs.existsSync(profileDir(companyId));
}

// ── Login detection ───────────────────────────────────────────────────────────

/**
 * Heuristic: we're logged in if the page is on a shop.sysco.com app route and
 * there's no visible username/password field. Sysco's authenticated app shell
 * renders the catalog; the unauthenticated flow shows a login form.
 */
async function isLoggedIn(page) {
  try {
    const url = page.url();
    if (!url.includes('sysco.com')) return false;
    if (/\/(login|signin|sign-in|auth)/i.test(url)) return false;

    // Any visible password field means we're still on a login/challenge screen
    const pw = page.locator('input[type="password"]');
    if (await pw.first().isVisible({ timeout: 1500 }).catch(() => false)) return false;

    // A username/email field visible on an auth route also means not logged in
    const user = page.locator('#username, #okta-signin-username, input[name="username"], input[name="email"], input[type="email"]');
    if (await user.first().isVisible({ timeout: 1000 }).catch(() => false)
        && /\/(login|signin|sign-in|auth)/i.test(url)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll until logged in or timeout — covers the user completing MFA manually in
 * a headed window. Returns true on success.
 */
async function waitForLogin(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Best-effort automated credential entry. Sysco's exact login markup may vary
 * (Okta / Ping / custom), so every step is defensive: if a selector isn't found
 * we simply skip it and let waitForLogin handle the rest (including the user
 * typing manually in the headed window).
 */
async function attemptLogin(page, username, password) {
  console.log('[sysco-sync] Navigating to Sysco Shop…');
  await page.goto(`${SYSCO_BASE}/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

  // Some flows land on a marketing page with a "Log In" entry point
  const loginEntry = page.locator('a:has-text("Log In"), a:has-text("Sign In"), button:has-text("Log In"), button:has-text("Sign In")').first();
  if (await loginEntry.isVisible({ timeout: 4000 }).catch(() => false)) {
    await loginEntry.click().catch(() => {});
  }

  // Username / email step
  const userInput = page.locator(
    '#username, #okta-signin-username, input[name="username"], input[name="email"], input[type="email"], input[autocomplete="username"]'
  ).first();
  if (await userInput.isVisible({ timeout: LOGIN_TIMEOUT }).catch(() => false)) {
    await userInput.fill(username).catch(() => {});
    // Some flows reveal the password field only after "Next"
    const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), #okta-signin-submit, button[type="submit"]').first();
    if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nextBtn.click().catch(() => {});
    }
  }

  // Password step
  const pwInput = page.locator('input[type="password"], #password, input[name="password"], input[autocomplete="current-password"]').first();
  if (await pwInput.isVisible({ timeout: LOGIN_TIMEOUT }).catch(() => false)) {
    await pwInput.fill(password).catch(() => {});
    const submitBtn = page.locator('button:has-text("Log In"), button:has-text("Sign In"), button:has-text("Login"), #okta-signin-submit, button[type="submit"]').first();
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click().catch(() => {});
    } else {
      await page.keyboard.press('Enter').catch(() => {});
    }
  }
}

// ── Product lookup via Sysco's GraphQL "SearchProducts" operation ─────────────
//
// Sysco's catalog SPA calls a single GraphQL endpoint. We capture one real
// SearchProducts request from the authenticated page to harvest its headers
// (auth token + syy-* + apollo client headers) and query string, then replay
// that request per item number — far faster than re-navigating the SPA each time.

const GQL_ENDPOINT = 'https://gateway-api.shop.sysco.com/graphql';

/**
 * Trigger a real SearchProducts request and capture its headers + body so we
 * can replay it. Returns { headers, operationName, query, variables } or null.
 */
async function captureSearchTemplate(page) {
  let tmpl = null;
  const grab = (req) => {
    if (tmpl) return;
    if (req.url().includes('/graphql') && req.method() === 'POST') {
      let pd = null;
      try { pd = req.postDataJSON(); } catch { /* ignore */ }
      if (pd && pd.operationName === 'SearchProducts') {
        tmpl = { headers: req.headers(), operationName: pd.operationName, query: pd.query, variables: pd.variables };
      }
    }
  };
  page.on('request', grab);
  try {
    await page.goto(`${SYSCO_BASE}/app/catalog?q=4069870`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: LOOKUP_WAIT }).catch(() => {});
    await page.waitForTimeout(2500);
  } finally {
    page.off('request', grab);
  }
  return tmpl;
}

/**
 * Normalize a SearchProducts result row into our enrichment shape.
 * Picks the row whose productId matches the queried item number.
 */
function parseSearchResult(body, itemNumber) {
  const results = body?.data?.searchProducts?.results || [];
  const hit = results.find((r) => String(r.productId) === String(itemNumber)) || results[0];
  if (!hit) return null;
  const pi = hit.productInfo || {};
  const ps = pi.packSize || {};
  // Compose a readable container UOM. Avoid redundancy when size already carries
  // the unit, e.g. size "10LB" + uom "LB" → "10LB" (not "10LB LB"); "#10" + "CAN" → "#10 CAN".
  let size = (ps.size || '').trim();
  const uomTok = (ps.uom || '').trim();
  if (uomTok && !new RegExp(uomTok + '\\b', 'i').test(size)) {
    size = [size, uomTok].filter(Boolean).join(' ').trim();
  }
  return {
    productId:    hit.productId,
    name:         pi.name || null,
    description:  pi.description || null,
    brand:        pi.brand?.name || null,
    category:     pi.category?.majorName || pi.category?.name || null,
    pack:         ps.pack != null ? String(ps.pack) : null,
    size:         ps.size || null,
    uom:          size || ps.uom || null,            // human-readable container UOM
    isCatchWeight: !!pi.isCatchWeight,
    unitsPerCase: hit.availableStockInfo?.unitsPerCase ?? null,
  };
}

/** Replay the captured SearchProducts request for one item number. */
async function replayLookup(page, tmpl, itemNumber) {
  const variables = JSON.parse(JSON.stringify(tmpl.variables));
  if (variables?.params) variables.params.q = String(itemNumber);
  const headers = { ...tmpl.headers };
  delete headers['content-length'];
  const resp = await page.request.post(GQL_ENDPOINT, {
    headers,
    data: { operationName: tmpl.operationName, query: tmpl.query, variables },
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status(), parsed: parseSearchResult(body, itemNumber) };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Bootstrap / test Sysco login. Runs HEADED so the owner can complete MFA.
 * Saves the session on success for later headless reuse.
 *
 * @param {string} companyId
 * @param {string} username
 * @param {string} password
 * @param {{ headed?: boolean }} [opts]  default headed:true (MFA-friendly)
 * @returns {{ ok: true, message: string }}
 */
export async function testSyscoLogin(companyId, username, password, opts = {}) {
  const headed = opts.headed !== false;

  const context = await launchContext(companyId, { headed });
  const page = context.pages()[0] || await context.newPage();

  try {
    // If the persistent profile is already logged in, we're done.
    await page.goto(`${SYSCO_BASE}/app/catalog`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    if (await isLoggedIn(page)) {
      return { ok: true, message: 'Already logged in to Sysco Shop — session is active.' };
    }

    await attemptLogin(page, username, password);

    // Wait for login to complete — automated, or manual MFA in the headed window
    const ok = await waitForLogin(page, headed ? MFA_WAIT : LOGIN_TIMEOUT);
    if (!ok) {
      throw new Error(
        headed
          ? 'Timed out waiting for Sysco login. Complete any 2FA in the opened window, then retry.'
          : 'Sysco login failed (possibly MFA or wrong credentials). Try the headed bootstrap to complete 2FA.'
      );
    }

    return { ok: true, message: 'Logged in to Sysco Shop — session saved.' };
  } finally {
    // Persistent context writes the profile to disk on close.
    await context.close().catch(() => {});
  }
}

/**
 * Look up a single Sysco item number, reusing the persistent profile.
 *
 * @param {string} companyId
 * @param {string} itemNumber
 * @returns {{ ok, itemNumber, parsed, loggedIn }}
 */
export async function lookupSyscoItem(companyId, itemNumber) {
  const out = await enrichSyscoItems(companyId, [itemNumber]);
  const r = out.results[0];
  return { ok: !!r?.parsed, itemNumber, parsed: r?.parsed || null, loggedIn: out.loggedIn };
}

/**
 * Batch-enrich a list of Sysco item numbers. Opens the persistent profile once,
 * captures the SearchProducts template, then replays it per item.
 *
 * @param {string} companyId
 * @param {string[]} itemNumbers
 * @returns {{ loggedIn, results: [{ itemNumber, parsed|null, error? }] }}
 */
export async function enrichSyscoItems(companyId, itemNumbers) {
  if (!hasSyscoSession(companyId)) {
    throw new Error('No Sysco session. Save credentials and run the login bootstrap in Settings → Integrations first.');
  }

  const context = await launchContext(companyId, { headed: false });
  const page = context.pages()[0] || await context.newPage();

  try {
    const tmpl = await captureSearchTemplate(page);
    const loggedIn = await isLoggedIn(page);

    if (!tmpl) {
      if (!loggedIn) {
        throw new Error('Sysco session expired or login required. Re-run the login bootstrap in Settings → Integrations.');
      }
      throw new Error('Could not capture Sysco catalog request — the page layout may have changed.');
    }

    const results = [];
    for (const itemNumber of itemNumbers) {
      try {
        const { status, parsed } = await replayLookup(page, tmpl, itemNumber);
        if (status !== 200) results.push({ itemNumber, error: `HTTP ${status}` });
        else results.push({ itemNumber, parsed });
      } catch (err) {
        results.push({ itemNumber, error: err.message });
      }
      // Gentle pacing to avoid hammering the gateway
      await page.waitForTimeout(250);
    }

    return { loggedIn, results };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Convenience: load stored Sysco creds and run a headed login bootstrap.
 */
export async function bootstrapSyscoFromDb(companyId, opts = {}) {
  const r = await query(
    `SELECT sysco_username, sysco_password FROM company_integrations WHERE company_id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  if (!row?.sysco_username || !row?.sysco_password) {
    throw new Error('Sysco credentials not configured. Add them in Settings → Integrations.');
  }
  return testSyscoLogin(companyId, row.sysco_username, row.sysco_password, opts);
}
