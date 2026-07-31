/**
 * Daily watch on the Idaho ABC filing.
 *
 * Runs once a day and asks a simple question: is the month that has closed
 * still unfiled? If it is ready, put it on the portal for review. If it is
 * blocked, say why while there is still time to fix it — a stale inventory
 * count is recoverable on the 2nd and not on the 6th.
 *
 * Opt-in per company via company_integrations.abc_autofill_enabled, and it will
 * not fill the same month twice.
 *
 * Follows the shape of qboZeroCanary.js.
 */
import { query } from '../db.js';
import { computeFiling } from './abcFiling.js';
import { runAbcPortalFill } from './abcPortal.js';
import { sendSmsToUsers } from './smsHelper.js';

/** The month that has closed and should be on file. */
function targetMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

async function owners(companyId) {
  const r = await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'owner'`, [companyId]);
  return r.rows.map((x) => x.id);
}

async function notify(companyId, message) {
  const ids = await owners(companyId);
  if (!ids.length) return 0;
  const res = await sendSmsToUsers(companyId, ids, message, ids[0]);
  return res.sent;
}

export async function runAbcPortalWatch(companyId, opts = {}) {
  const month = opts.month || targetMonth();

  const filing = await query(
    `SELECT status, has_detail FROM abc_filings WHERE company_id = $1 AND period_month = $2`,
    [companyId, `${month}-01`]
  );
  if (filing.rows[0]?.status === 'filed') return { ok: true, month, action: 'already_filed' };

  // Don't refill a month that is already sitting on the portal awaiting review.
  const prior = await query(
    `SELECT status FROM abc_portal_runs
      WHERE company_id = $1 AND period_month = $2
        AND status IN ('saved', 'saved_with_mismatches')
      ORDER BY started_at DESC LIMIT 1`,
    [companyId, `${month}-01`]
  );
  if (prior.rows.length) return { ok: true, month, action: 'already_on_portal' };

  // A reconciled month is served as stored and skips preflight; a fresh month
  // must pass before anything is typed into a state form.
  if (!filing.rows[0]?.has_detail) {
    let computed;
    try {
      computed = await computeFiling(companyId, month);
    } catch (err) {
      return { ok: false, month, action: 'compute_failed', error: err.message };
    }
    if (!computed.readyToFile) {
      const why = computed.blocking.map((c) => c.detail || c.label).join(' ');
      const sent = await notify(companyId,
        `Idaho ABC ${month} is not ready to file: ${why}`.slice(0, 300));
      return { ok: true, month, action: 'blocked', blocking: computed.blocking, notified: sent };
    }
  }

  const result = await runAbcPortalFill(companyId, month, { trigger: 'scheduled' });

  if (result.status === 'failed') {
    await notify(companyId, `Idaho ABC ${month}: portal fill failed — ${result.error}`.slice(0, 300));
    return { ok: false, month, action: 'fill_failed', error: result.error };
  }

  const warn = result.mismatches?.length
    ? ` NOTE: ${result.mismatches.length} line(s) read back differently — check before submitting.`
    : '';
  const sent = await notify(companyId,
    `Idaho ABC ${month} is saved on the portal and ready for your review and submit.${warn}`.slice(0, 300));
  return { ok: true, month, action: 'filled', mismatches: result.mismatches, notified: sent };
}

let started = false;
export function startAbcPortalScheduler() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const cs = (await query(
        `SELECT company_id FROM company_integrations WHERE abc_autofill_enabled = true`)).rows;
      for (const c of cs) {
        await runAbcPortalWatch(c.company_id)
          .catch((e) => console.error('abcPortalWatch', c.company_id, e.message));
      }
    } catch (e) {
      console.error('ABC portal watch loop failed:', e.message);
    }
  };
  setTimeout(run, 240 * 1000);            // shortly after boot
  setInterval(run, 24 * 60 * 60 * 1000);  // then daily
  console.log('Idaho ABC portal scheduler started (daily).');
}

// Manual run:  node lib/abcPortalScheduler.js <companyId> [YYYY-MM]
if (process.argv[1]?.endsWith('abcPortalScheduler.js')) {
  (async () => {
    console.log(JSON.stringify(
      await runAbcPortalWatch(process.argv[2], { month: process.argv[3] }), null, 1));
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
