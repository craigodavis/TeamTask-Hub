/**
 * QBO $0 canary — detection safety net.
 *
 * A recurring check that flags any credit-card / cash EXPENSE that posted at $0
 * in the recent window. That is the signature of the export-corruption bug (a
 * missing line amount written as $0). If the guards ever fail on any write path,
 * this catches it within a day and texts the owner — instead of it going unnoticed
 * for months, as the original incident did.
 *
 * Scope is deliberately narrow (PaymentType CreditCard/Cash, recently modified) so
 * it won't fire on legitimate $0 checks or the old known artifacts still being
 * cleaned up in QBO.
 */
import { query } from '../db.js';
import { qboQueryAll } from '../qboClient.js';
import { sendSmsToUsers } from './smsHelper.js';

const LOOKBACK_HOURS = 26; // a daily run, with margin

export async function runZeroCanary(companyId, { force = false } = {}) {
  let all;
  try {
    all = await qboQueryAll(companyId, `SELECT * FROM Purchase WHERE TotalAmt = '0'`);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const flagged = all.filter((p) => {
    // Only expense-type payments (the corruption pattern); skip $0 checks etc.
    if (!['CreditCard', 'Cash'].includes(p.PaymentType)) return false;
    if (force) return true;
    const ts = Date.parse(p.MetaData?.LastUpdatedTime || p.MetaData?.CreateTime || '');
    return Number.isFinite(ts) && ts >= cutoff;
  });

  if (!flagged.length) return { ok: true, flagged: 0 };

  // Every server restart re-runs this ~200s after boot regardless of the "daily"
  // interval below — and a redeploy-heavy day (5 restarts in one hour, in
  // practice) turned that into the same 12 already-known $0 records getting
  // re-texted every time. An id is only worth alerting again if QBO's own
  // LastUpdatedTime has actually advanced since we last recorded it — that is a
  // real new event, not the process rebooting.
  const seen = (await query(
    `SELECT purchase_id, last_updated_time FROM qbo_zero_canary_seen WHERE company_id = $1`,
    [companyId]
  )).rows.reduce((m, r) => (m[r.purchase_id] = r.last_updated_time, m), {});

  const newlyFlagged = force ? flagged : flagged.filter((p) => {
    const ts = Date.parse(p.MetaData?.LastUpdatedTime || p.MetaData?.CreateTime || '');
    const known = seen[p.Id];
    return !known || (Number.isFinite(ts) && ts > new Date(known).getTime());
  });

  // Record every flagged id's current LastUpdatedTime regardless of whether it
  // was newly alerted — this is what makes the next run's comparison correct.
  for (const p of flagged) {
    const ts = Date.parse(p.MetaData?.LastUpdatedTime || p.MetaData?.CreateTime || '');
    if (!Number.isFinite(ts)) continue;
    await query(
      `INSERT INTO qbo_zero_canary_seen (company_id, purchase_id, last_updated_time, last_alerted_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, purchase_id) DO UPDATE SET
         last_updated_time = EXCLUDED.last_updated_time,
         last_alerted_at   = COALESCE(EXCLUDED.last_alerted_at, qbo_zero_canary_seen.last_alerted_at)`,
      [companyId, p.Id, new Date(ts), newlyFlagged.includes(p) ? new Date() : null]
    );
  }

  if (!newlyFlagged.length) {
    console.warn(`[zeroCanary] ${companyId}: ${flagged.length} $0 expense(s) still outstanding, none new — not re-alerting.`);
    return { ok: true, flagged: flagged.length, newlyFlagged: 0, notified: 0 };
  }

  const owners = (await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'owner'`,
    [companyId]
  )).rows.map((r) => r.id);

  const detail = newlyFlagged.slice(0, 6)
    .map((p) => `${p.TxnDate} ${p.EntityRef?.name || '?'} "${(p.Line?.[0]?.Description || '').slice(0, 22)}" (id ${p.Id})`)
    .join('; ');
  const msg = `⚠️ QBO canary: ${newlyFlagged.length} new expense(s) posted at $0 in the last ${LOOKBACK_HOURS}h — possible transaction corruption. ${detail}`;

  let notified = 0;
  if (owners.length) {
    const res = await sendSmsToUsers(companyId, owners, msg, owners[0]);
    notified = res.sent;
  }
  console.warn(`[zeroCanary] ${companyId}: flagged ${flagged.length} $0 expense(s), ${newlyFlagged.length} new, notified ${notified}`);
  return { ok: true, flagged: flagged.length, newlyFlagged: newlyFlagged.length, notified, ids: newlyFlagged.map((p) => p.Id) };
}

let started = false;
export function startZeroCanaryScheduler() {
  if (started) return;
  started = true;
  const run = async () => {
    try {
      const cs = (await query(`SELECT company_id FROM company_integrations WHERE qbo_realm_id IS NOT NULL`)).rows;
      for (const c of cs) {
        await runZeroCanary(c.company_id).catch((e) => console.error('zeroCanary', c.company_id, e.message));
      }
    } catch (e) {
      console.error('zero canary loop failed:', e.message);
    }
  };
  setTimeout(run, 200 * 1000);            // once shortly after boot
  setInterval(run, 24 * 60 * 60 * 1000);  // then daily
  console.log('QBO $0 canary scheduler started (daily).');
}

// Manual run:  node lib/qboZeroCanary.js <companyId> [force]
if (process.argv[1]?.endsWith('qboZeroCanary.js')) {
  (async () => {
    console.log(JSON.stringify(await runZeroCanary(process.argv[2], { force: process.argv[3] === 'force' }), null, 1));
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
