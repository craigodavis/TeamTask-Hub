/**
 * Square Sync routes — /api/square/sync
 *
 *   GET    /api/square/sync/objects           list sync objects (auto-seeds defaults)
 *   PATCH  /api/square/sync/objects/:id       update enabled / frequency
 *   POST   /api/square/sync/objects/:id/run   trigger immediately
 */

import express from 'express';
import { query } from '../db.js';
import { requireAuth, requireManager } from '../middleware/auth.js';
import { runCatalogSync } from '../lib/squareCatalogSync.js';
import { runOrdersSync } from '../lib/squareOrdersSync.js';
import { runShiftSync } from '../lib/squareShiftSync.js';
import { runScheduledShiftSync } from '../lib/squareScheduledShiftSync.js';
import { runTeamMemberSync } from '../lib/squareTeamMemberSync.js';
import { runLocationSync } from '../lib/squareLocationSync.js';
import { runCustomerSync } from '../lib/squareCustomerSync.js';
import { runPaymentSync } from '../lib/squarePaymentSync.js';
import { runInvoiceSync } from '../lib/squareInvoiceSync.js';
import { runGiftCardSync } from '../lib/squareGiftCardSync.js';
import { runInventorySync } from '../lib/squareInventorySync.js';
import { runPayoutSync } from '../lib/squarePayoutSync.js';

const router = express.Router();
function cid(req) { return req.companyId || req.user?.company_id; }

// Default object types seeded per company on first load
const DEFAULT_OBJECTS = [
  { object_type: 'catalog_item',     label: 'Catalog Items'      },
  { object_type: 'catalog_category', label: 'Catalog Categories' },
  { object_type: 'orders',           label: 'Orders'             },
  { object_type: 'shifts',           label: 'Shifts'             },
  { object_type: 'scheduled_shifts', label: 'Scheduled Shifts'   },
  { object_type: 'team_members',     label: 'Team Members'       },
  { object_type: 'locations',        label: 'Locations'          },
  { object_type: 'customers',        label: 'Customers'          },
  { object_type: 'payments',         label: 'Payments'           },
  { object_type: 'invoices',         label: 'Invoices'           },
  { object_type: 'gift_cards',       label: 'Gift Cards'         },
  { object_type: 'inventory',        label: 'Inventory'          },
  { object_type: 'payouts',          label: 'Payouts'            },
];

function computeNextSync(frequency) {
  const now = new Date();
  switch (frequency) {
    case 'hourly':   return new Date(now.getTime() + 60 * 60 * 1000);
    case 'every_6h': return new Date(now.getTime() + 6  * 60 * 60 * 1000);
    case 'every_12h':return new Date(now.getTime() + 12 * 60 * 60 * 1000);
    case 'nightly':  {
      const d = new Date(now);
      d.setHours(2, 0, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
    default: return null;
  }
}

// ── GET /api/square/sync/objects ─────────────────────────────────────────────
router.get('/objects', requireAuth, requireManager, async (req, res) => {
  try {
    const companyId = cid(req);

    // Seed defaults for this company if they don't exist yet
    for (const obj of DEFAULT_OBJECTS) {
      await query(
        `INSERT INTO square_sync_objects (company_id, object_type, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, object_type) DO NOTHING`,
        [companyId, obj.object_type, obj.label]
      );
    }

    const r = await query(
      `SELECT * FROM square_sync_objects WHERE company_id = $1 ORDER BY label`,
      [companyId]
    );

    // Attach live DB row counts. Use exact COUNT(*) per table — fast on small-to-mid
    // tables and avoids reltuples being stale on freshly-populated tables.
    const TABLE_MAP = {
      catalog_item:     'team_square.catalog_item',
      catalog_category: 'team_square.catalog_category',
      orders:           'team_square.order',
      shifts:           'team_square.shift',
      scheduled_shifts: 'team_square.scheduled_shift',
      team_members:     'team_square.team_member',
      locations:        'team_square.location',
      customers:        'team_square.customer',
      payments:         'team_square.payment',
      invoices:         'team_square.invoice',
      gift_cards:       'team_square.gift_card',
      inventory:        'team_square.inventory_count',
      payouts:          'team_square.payout',
    };
    // Build a single query with one COUNT per table via UNION ALL
    const unionParts = Object.entries(TABLE_MAP).map(
      ([key, tbl]) => `SELECT '${key}' AS k, COUNT(*)::BIGINT AS n FROM ${tbl}`
    );
    const countRes = await query(unionParts.join(' UNION ALL '));
    const countMap = {};
    for (const row of countRes.rows) countMap[row.k] = Number(row.n);

    const objects = r.rows.map((obj) => ({
      ...obj,
      record_count: countMap[obj.object_type] ?? null,
    }));

    res.json({ objects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/square/sync/objects/:id ───────────────────────────────────────
router.patch('/objects/:id', requireAuth, requireManager, async (req, res) => {
  const { enabled, sync_frequency } = req.body;
  const fields = [];
  const vals   = [];
  let i = 1;

  if (enabled       !== undefined) { fields.push(`enabled = $${i++}`);        vals.push(enabled); }
  if (sync_frequency !== undefined) {
    fields.push(`sync_frequency = $${i++}`); vals.push(sync_frequency);
    // Recompute next_sync_at when frequency changes (or when enabling)
    const nextAt = computeNextSync(sync_frequency);
    fields.push(`next_sync_at = $${i++}`); vals.push(nextAt);
  } else if (enabled === true) {
    // Enabling without changing frequency — compute next_sync_at from current frequency
    const r0 = await query(`SELECT sync_frequency FROM square_sync_objects WHERE id = $1`, [req.params.id]);
    if (r0.rows[0]) {
      const nextAt = computeNextSync(r0.rows[0].sync_frequency);
      fields.push(`next_sync_at = $${i++}`); vals.push(nextAt);
    }
  } else if (enabled === false) {
    fields.push(`next_sync_at = $${i++}`); vals.push(null);
  }

  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const r = await query(
      `UPDATE square_sync_objects SET ${fields.join(', ')}
       WHERE id = $${i++} AND company_id = $${i++}
       RETURNING *`,
      [...vals, req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ object: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/square/sync/objects/:id/run ────────────────────────────────────
router.post('/objects/:id/run', requireAuth, requireManager, async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM square_sync_objects WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const obj = r.rows[0];

    // Mark as running
    await query(
      `UPDATE square_sync_objects SET last_sync_status = 'running' WHERE id = $1`,
      [obj.id]
    );

    let result;
    if (obj.object_type === 'catalog_item' || obj.object_type === 'catalog_category') {
      result = await runCatalogSync(cid(req));
    } else if (obj.object_type === 'orders') {
      result = await runOrdersSync(cid(req), obj.last_synced_at);
    } else if (obj.object_type === 'shifts') {
      result = await runShiftSync(cid(req), obj.last_synced_at);
    } else if (obj.object_type === 'scheduled_shifts') {
      result = await runScheduledShiftSync(cid(req), obj.last_synced_at);
    } else if (obj.object_type === 'team_members') {
      result = await runTeamMemberSync(cid(req), obj.last_synced_at);
    } else if (obj.object_type === 'locations') {
      result = await runLocationSync(cid(req));
    } else if (obj.object_type === 'customers') {
      result = await runCustomerSync(cid(req), obj.last_synced_at);
    } else if (obj.object_type === 'payments') {
      result = await runPaymentSync(cid(req), obj.last_synced_at);
    } else if (obj.object_type === 'invoices') {
      result = await runInvoiceSync(cid(req));
    } else if (obj.object_type === 'gift_cards') {
      result = await runGiftCardSync(cid(req));
    } else if (obj.object_type === 'inventory') {
      result = await runInventorySync(cid(req));
    } else if (obj.object_type === 'payouts') {
      result = await runPayoutSync(cid(req), obj.last_synced_at);
    } else {
      return res.status(400).json({ error: `No sync handler for object_type: ${obj.object_type}` });
    }

    const count = (result.items || 0) + (result.variations || 0)
                + (result.categories || 0) + (result.taxes || 0)
                + (result.ordersUpserted || 0) + (result.lineItemsUpserted || 0)
                + (result.shiftsUpserted || 0) + (result.breaksUpserted || 0)
                + (result.scheduledShiftsUpserted || 0)
                + (result.teamMembersUpserted || 0) + (result.jobAssignmentsUpserted || 0)
                + (result.locationsUpserted || 0)
                + (result.customersUpserted || 0)
                + (result.paymentsUpserted || 0)
                + (result.invoicesUpserted || 0) + (result.paymentRequestsUpserted || 0)
                + (result.giftCardsUpserted || 0)
                + (result.inventoryCountsUpserted || 0)
                + (result.payoutsUpserted || 0) + (result.payoutFeesUpserted || 0);
    const nextAt = computeNextSync(obj.sync_frequency);

    await query(
      `UPDATE square_sync_objects
       SET last_synced_at    = NOW(),
           last_sync_status  = 'ok',
           last_sync_count   = $1,
           last_sync_error   = NULL,
           next_sync_at      = CASE WHEN enabled THEN $2 ELSE next_sync_at END
       WHERE id = $3`,
      [count, nextAt, obj.id]
    );

    const updated = await query(`SELECT * FROM square_sync_objects WHERE id = $1`, [obj.id]);
    res.json({ ok: true, object: updated.rows[0], ...result });
  } catch (err) {
    await query(
      `UPDATE square_sync_objects SET last_sync_status = 'error', last_sync_error = $1 WHERE id = $2`,
      [err.message, req.params.id]
    );
    res.status(500).json({ error: err.message });
  }
});

// ── Scheduled sync runner ─────────────────────────────────────────────────────
// Checks every 10 minutes for any sync objects whose next_sync_at has passed.
async function runDueSquareSyncs() {
  try {
    const due = await query(
      `SELECT sso.*, ci.square_access_token, ci.square_env
       FROM square_sync_objects sso
       JOIN company_integrations ci ON ci.company_id = sso.company_id
       WHERE sso.enabled = true
         AND sso.next_sync_at IS NOT NULL
         AND sso.next_sync_at <= NOW()
         AND (sso.last_sync_status IS NULL OR sso.last_sync_status != 'running')`
    );

    for (const obj of due.rows) {
      console.log(`[square-sync-scheduler] Running ${obj.object_type} for company ${obj.company_id}`);
      await query(`UPDATE square_sync_objects SET last_sync_status = 'running' WHERE id = $1`, [obj.id]);
      try {
        let result;
        const companyId = obj.company_id;
        if (obj.object_type === 'catalog_item' || obj.object_type === 'catalog_category') {
          result = await runCatalogSync(companyId);
        } else if (obj.object_type === 'orders') {
          result = await runOrdersSync(companyId, obj.last_synced_at);
        } else if (obj.object_type === 'shifts') {
          result = await runShiftSync(companyId, obj.last_synced_at);
        } else if (obj.object_type === 'scheduled_shifts') {
          result = await runScheduledShiftSync(companyId, obj.last_synced_at);
        } else if (obj.object_type === 'team_members') {
          result = await runTeamMemberSync(companyId, obj.last_synced_at);
        } else if (obj.object_type === 'locations') {
          result = await runLocationSync(companyId);
        } else if (obj.object_type === 'customers') {
          result = await runCustomerSync(companyId, obj.last_synced_at);
        } else if (obj.object_type === 'payments') {
          result = await runPaymentSync(companyId, obj.last_synced_at);
        } else if (obj.object_type === 'invoices') {
          result = await runInvoiceSync(companyId);
        } else if (obj.object_type === 'gift_cards') {
          result = await runGiftCardSync(companyId);
        } else if (obj.object_type === 'inventory') {
          result = await runInventorySync(companyId);
        } else if (obj.object_type === 'payouts') {
          result = await runPayoutSync(companyId, obj.last_synced_at);
        } else {
          throw new Error(`No sync handler for object_type: ${obj.object_type}`);
        }

        const count = (result.items || 0) + (result.variations || 0)
                    + (result.categories || 0) + (result.taxes || 0)
                    + (result.ordersUpserted || 0) + (result.lineItemsUpserted || 0)
                    + (result.shiftsUpserted || 0) + (result.breaksUpserted || 0)
                    + (result.scheduledShiftsUpserted || 0)
                    + (result.teamMembersUpserted || 0) + (result.jobAssignmentsUpserted || 0)
                    + (result.locationsUpserted || 0)
                    + (result.customersUpserted || 0)
                    + (result.paymentsUpserted || 0)
                    + (result.invoicesUpserted || 0) + (result.paymentRequestsUpserted || 0)
                    + (result.giftCardsUpserted || 0)
                    + (result.inventoryCountsUpserted || 0)
                    + (result.payoutsUpserted || 0) + (result.payoutFeesUpserted || 0);

        const nextAt = computeNextSync(obj.sync_frequency);
        await query(
          `UPDATE square_sync_objects
           SET last_synced_at   = NOW(),
               last_sync_status = 'ok',
               last_sync_count  = $1,
               last_sync_error  = NULL,
               next_sync_at     = CASE WHEN enabled THEN $2 ELSE next_sync_at END
           WHERE id = $3`,
          [count, nextAt, obj.id]
        );
        console.log(`[square-sync-scheduler] ${obj.object_type} done — ${count} records, next at ${nextAt?.toISOString()}`);
      } catch (err) {
        console.error(`[square-sync-scheduler] ${obj.object_type} failed:`, err.message);
        await query(
          `UPDATE square_sync_objects SET last_sync_status = 'error', last_sync_error = $1 WHERE id = $2`,
          [err.message, obj.id]
        );
      }
    }
  } catch (err) {
    console.error('[square-sync-scheduler] loop error:', err.message);
  }
}

export function startSquareSyncScheduler() {
  // Run once shortly after startup (catches any overdue syncs from downtime)
  setTimeout(runDueSquareSyncs, 60 * 1000);
  // Then check every 10 minutes
  setInterval(runDueSquareSyncs, 10 * 60 * 1000);
  console.log('[square-sync-scheduler] started — checking every 10 minutes');
}

export { router as squareSyncRouter };
