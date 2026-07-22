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

  const owners = (await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'owner'`,
    [companyId]
  )).rows.map((r) => r.id);

  const detail = flagged.slice(0, 6)
    .map((p) => `${p.TxnDate} ${p.EntityRef?.name || '?'} "${(p.Line?.[0]?.Description || '').slice(0, 22)}" (id ${p.Id})`)
    .join('; ');
  const msg = `⚠️ QBO canary: ${flagged.length} expense(s) posted at $0 in the last ${LOOKBACK_HOURS}h — possible transaction corruption. ${detail}`;

  let notified = 0;
  if (owners.length) {
    const res = await sendSmsToUsers(companyId, owners, msg, owners[0]);
    notified = res.sent;
  }
  console.warn(`[zeroCanary] ${companyId}: flagged ${flagged.length} $0 expense(s), notified ${notified}`);
  return { ok: true, flagged: flagged.length, notified, ids: flagged.map((p) => p.Id) };
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
