/**
 * Loyalty points — an append-only ledger.
 *
 * A balance is SUM(points) over the ledger, never a stored number. That costs a
 * little at read time and buys the thing that matters: every balance can be
 * explained by the rows that produced it, and a wrong award is undone with a
 * compensating entry rather than an edit that erases the evidence.
 *
 * Members are keyed by Commerce7 customer UUID — the id that club_members.id
 * and pickup_signatures.customer_id already share, and that member_accounts
 * links an app login to.
 *
 * Every write carries an idempotency key. Awarding is therefore safe to retry:
 * a replayed webhook, a re-run backfill or a double-scanned redemption lands
 * once. This is deliberate — points that quietly double are very hard to
 * notice and very awkward to take back.
 */
import { query } from '../db.js';

/** Active earn rules, in display order. */
export async function getRules(companyId, { includeInactive = false } = {}) {
  const r = await query(
    `SELECT rule_key, label, description, points, icon, active, one_time, sort_order
       FROM loyalty_rules
      WHERE company_id = $1 ${includeInactive ? '' : 'AND active = true'}
      ORDER BY sort_order, rule_key`,
    [companyId]
  );
  return r.rows;
}

export async function getBalance(companyId, customerId) {
  const r = await query(
    `SELECT COALESCE(SUM(points), 0)::int AS balance
       FROM loyalty_ledger WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
  );
  return r.rows[0].balance;
}

/** A member's balance plus their recent entries, for the app's Rewards screen. */
export async function getMemberSummary(companyId, customerId, { limit = 25 } = {}) {
  const [balance, rules, history] = await Promise.all([
    getBalance(companyId, customerId),
    getRules(companyId),
    query(
      `SELECT points, rule_key, reason, occurred_at
         FROM loyalty_ledger
        WHERE company_id = $1 AND customer_id = $2
        ORDER BY occurred_at DESC, id DESC LIMIT $3`,
      [companyId, customerId, limit]
    ).then((r) => r.rows),
  ]);
  return { balance, rules, history };
}

/**
 * Write one ledger entry. Returns {awarded:false} if the idempotency key has
 * already been used, so callers can retry freely.
 */
export async function award(companyId, customerId, {
  points, ruleKey = null, reason = null, sourceKind = 'manual', sourceId = null,
  idempotencyKey, batch = null, occurredAt = null, createdBy = null,
}) {
  if (!idempotencyKey) throw new Error('idempotencyKey is required for every ledger write.');
  if (!Number.isInteger(points) || points === 0) throw new Error('points must be a non-zero integer.');

  const r = await query(
    `INSERT INTO loyalty_ledger
       (company_id, customer_id, points, rule_key, reason, source_kind, source_id,
        idempotency_key, batch, occurred_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, NOW()),$11)
     ON CONFLICT (company_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [companyId, customerId, points, ruleKey, reason, sourceKind, sourceId,
      idempotencyKey, batch, occurredAt, createdBy]
  );
  return r.rows.length ? { awarded: true, id: r.rows[0].id } : { awarded: false, duplicate: true };
}

/** Points for a rule, or null when the rule is missing or switched off. */
async function rulePoints(companyId, ruleKey) {
  const r = await query(
    `SELECT points FROM loyalty_rules
      WHERE company_id = $1 AND rule_key = $2 AND active = true`,
    [companyId, ruleKey]
  );
  return r.rows.length ? r.rows[0].points : null;
}

/**
 * Award history that already happened.
 *
 * Only rules with real evidence behind them are backfilled. Event attendance,
 * the profile-photo bonus and referrals are all live rules, but nothing in the
 * database records who attended, who uploaded or who referred whom, so awarding
 * them retroactively would be inventing history rather than recording it.
 *
 * Re-runnable: entries are keyed on the source record, so a second run adds
 * nothing. `batch` tags the lot, so a backfill can be dropped wholesale.
 */
export async function runBackfill(companyId, {
  months = 12, batch = null, dryRun = false,
} = {}) {
  const tag = batch || `backfill-${months}mo`;
  const summary = { batch: tag, dryRun, months, rules: {}, totalPoints: 0, totalEntries: 0, members: 0 };

  // ── Club pickups ───────────────────────────────────────────────────────────
  const pickupPts = await rulePoints(companyId, 'club_pickup');
  if (pickupPts) {
    const rows = (await query(
      `SELECT p.id, p.customer_id, p.signed_at, p.customer_name
         FROM club_steward.pickup_signatures p
        WHERE p.company_id = $1
          AND p.signed_at >= NOW() - ($2 || ' months')::interval
          AND EXISTS (SELECT 1 FROM club_steward.club_members m
                       WHERE m.id::text = p.customer_id)
        ORDER BY p.signed_at`,
      [companyId, String(months)]
    )).rows;

    let awarded = 0;
    for (const row of rows) {
      if (dryRun) { awarded++; continue; }
      const res = await award(companyId, row.customer_id, {
        points: pickupPts, ruleKey: 'club_pickup',
        reason: 'Picked up a release', sourceKind: 'pickup_signature',
        sourceId: String(row.id), idempotencyKey: `club_pickup:${row.id}`,
        batch: tag, occurredAt: row.signed_at,
      });
      if (res.awarded) awarded++;
    }
    summary.rules.club_pickup = {
      points: pickupPts, matched: rows.length, awarded,
      totalPoints: awarded * pickupPts,
    };
    summary.totalEntries += awarded;
    summary.totalPoints += awarded * pickupPts;
  }

  // ── Purchases (only if the rule is switched on) ────────────────────────────
  const perDollar = await rulePoints(companyId, 'purchase');
  if (perDollar) {
    const rows = (await query(
      `SELECT o.id, o.customer_id, o.order_submitted_date, o.total
         FROM commerce7.orders o
        WHERE o.company_id = $1
          AND o.order_submitted_date >= NOW() - ($2 || ' months')::interval
          AND o.customer_id IS NOT NULL
          AND COALESCE(o.total, 0) > 0
          AND EXISTS (SELECT 1 FROM club_steward.club_members m
                       WHERE m.id::text = o.customer_id::text)
        ORDER BY o.order_submitted_date`,
      [companyId, String(months)]
    )).rows;

    let awarded = 0; let pts = 0;
    for (const row of rows) {
      const p = Math.floor(Number(row.total) * perDollar);
      if (p <= 0) continue;
      if (dryRun) { awarded++; pts += p; continue; }
      const res = await award(companyId, row.customer_id, {
        points: p, ruleKey: 'purchase', reason: 'Purchase',
        sourceKind: 'c7_order', sourceId: String(row.id),
        idempotencyKey: `purchase:${row.id}`, batch: tag,
        occurredAt: row.order_submitted_date,
      });
      if (res.awarded) { awarded++; pts += p; }
    }
    summary.rules.purchase = { pointsPerDollar: perDollar, matched: rows.length, awarded, totalPoints: pts };
    summary.totalEntries += awarded;
    summary.totalPoints += pts;
  }

  const m = await query(
    `SELECT count(DISTINCT customer_id)::int n FROM loyalty_ledger
      WHERE company_id = $1 ${dryRun ? '' : 'AND batch = $2'}`,
    dryRun ? [companyId] : [companyId, tag]
  );
  summary.members = m.rows[0].n;
  return summary;
}

/** Remove a backfill batch. Points granted in error should not need surgery. */
export async function dropBatch(companyId, batch) {
  const r = await query(
    `DELETE FROM loyalty_ledger WHERE company_id = $1 AND batch = $2`,
    [companyId, batch]
  );
  return { deleted: r.rowCount };
}

/** Leaderboard / admin view: balances with member names attached. */
export async function getBalances(companyId, { limit = 100, offset = 0 } = {}) {
  const r = await query(
    `SELECT l.customer_id,
            COALESCE(SUM(l.points), 0)::int AS balance,
            count(*)::int                   AS entries,
            max(l.occurred_at)              AS last_activity,
            m.first_name, m.last_name
       FROM loyalty_ledger l
       LEFT JOIN club_steward.club_members m ON m.id::text = l.customer_id::text
      WHERE l.company_id = $1
      GROUP BY l.customer_id, m.first_name, m.last_name
      ORDER BY balance DESC
      LIMIT $2 OFFSET $3`,
    [companyId, limit, offset]
  );
  return r.rows;
}

/** Programme-wide totals — the cost model. */
export async function getProgramStats(companyId) {
  const r = await query(
    `SELECT COALESCE(SUM(points) FILTER (WHERE points > 0), 0)::int AS points_awarded,
            COALESCE(SUM(-points) FILTER (WHERE points < 0), 0)::int AS points_redeemed,
            COALESCE(SUM(points), 0)::int                            AS outstanding,
            count(DISTINCT customer_id)::int                         AS members,
            count(*)::int                                            AS entries
       FROM loyalty_ledger WHERE company_id = $1`,
    [companyId]
  );
  const byRule = await query(
    `SELECT rule_key, count(*)::int entries, COALESCE(SUM(points),0)::int points
       FROM loyalty_ledger WHERE company_id = $1
      GROUP BY rule_key ORDER BY points DESC`,
    [companyId]
  );
  return { ...r.rows[0], byRule: byRule.rows };
}
