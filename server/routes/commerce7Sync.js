/**
 * Commerce7 Sync routes — /api/commerce7/sync
 *
 *   GET    /api/commerce7/sync/objects           list sync objects (auto-seeds defaults)
 *   PATCH  /api/commerce7/sync/objects/:id       update enabled / frequency
 *   POST   /api/commerce7/sync/objects/:id/run   trigger immediately
 */

import express from 'express';
import { query } from '../db.js';
import {
  syncCustomers, syncOrders,
  syncProducts, syncCollections, syncVendors,
  syncWineVarietals, syncWineAppellations,
  syncClubs, syncClubMemberships,
  syncReservations, syncGiftCards, syncPromotions,
} from '../lib/commerce7Sync.js';

const router = express.Router();
function cid(req) { return req.companyId || req.user?.company_id; }

// Default object types seeded per company on first load
const DEFAULT_OBJECTS = [
  { object_type: 'customers',        label: 'Customers'        },
  { object_type: 'orders',           label: 'Orders'           },
  { object_type: 'products',         label: 'Products'         },
  { object_type: 'collections',      label: 'Collections'      },
  { object_type: 'vendors',          label: 'Vendors'          },
  { object_type: 'wine_varietals',   label: 'Wine Varietals'   },
  { object_type: 'wine_appellations',label: 'Wine Appellations'},
  { object_type: 'clubs',            label: 'Clubs'            },
  { object_type: 'club_memberships', label: 'Club Memberships' },
  { object_type: 'reservations',     label: 'Reservations'     },
  { object_type: 'gift_cards',       label: 'Gift Cards'       },
  { object_type: 'promotions',       label: 'Promotions'       },
];

// Table that holds live records for each object type
const TABLE_MAP = {
  customers:         'commerce7.customers',
  orders:            'commerce7.orders',
  products:          'commerce7.product',
  collections:       'commerce7.collection',
  vendors:           'commerce7.vendor',
  wine_varietals:    'commerce7.wine_varietal',
  wine_appellations: 'commerce7.wine_appellation',
  clubs:             'commerce7.club',
  club_memberships:  'commerce7.club_membership',
  reservations:      'commerce7.reservation',
  gift_cards:        'commerce7.gift_card',
  promotions:        'commerce7.promotion',
};

function computeNextSync(frequency) {
  const now = new Date();
  switch (frequency) {
    case 'hourly':    return new Date(now.getTime() + 60 * 60 * 1000);
    case 'every_6h':  return new Date(now.getTime() + 6  * 60 * 60 * 1000);
    case 'every_12h': return new Date(now.getTime() + 12 * 60 * 60 * 1000);
    case 'nightly': {
      const d = new Date(now);
      d.setHours(2, 0, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    }
    default: return null;
  }
}

// ── GET /api/commerce7/sync/objects ─────────────────────────────────────────
router.get('/objects', async (req, res) => {
  try {
    const companyId = cid(req);

    // Seed defaults for this company if they don't exist yet
    for (const obj of DEFAULT_OBJECTS) {
      await query(
        `INSERT INTO teamtask_hub.commerce7_sync_objects (company_id, object_type, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (company_id, object_type) DO NOTHING`,
        [companyId, obj.object_type, obj.label]
      );
    }

    const r = await query(
      `SELECT * FROM teamtask_hub.commerce7_sync_objects WHERE company_id = $1 ORDER BY label`,
      [companyId]
    );

    // Attach live DB row counts via UNION ALL
    const unionParts = Object.entries(TABLE_MAP).map(
      ([key, tbl]) => `SELECT '${key}' AS k, COUNT(*)::BIGINT AS n FROM ${tbl}`
    );
    const countRes = await query(unionParts.join(' UNION ALL '));
    const countMap = {};
    for (const row of countRes.rows) countMap[row.k] = Number(row.n);

    // Attach recent sync log entries per entity
    const logRes = await query(
      `SELECT entity, mode, records_synced, error_message, started_at, finished_at
       FROM commerce7.sync_log
       WHERE company_id = $1 AND finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 20`,
      [companyId]
    );
    // Last completed entry per entity
    const lastLog = {};
    for (const row of logRes.rows) {
      if (!lastLog[row.entity]) lastLog[row.entity] = row;
    }

    const objects = r.rows.map((obj) => ({
      ...obj,
      record_count: countMap[obj.object_type] ?? null,
      last_log:     lastLog[obj.object_type]  ?? null,
    }));

    res.json({ objects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/commerce7/sync/objects/:id ────────────────────────────────────
router.patch('/objects/:id', async (req, res) => {
  const { enabled, sync_frequency } = req.body;
  const fields = [];
  const vals   = [];
  let i = 1;

  if (enabled !== undefined) {
    fields.push(`enabled = $${i++}`);
    vals.push(enabled);
  }
  if (sync_frequency !== undefined) {
    fields.push(`sync_frequency = $${i++}`);
    vals.push(sync_frequency);
    const nextAt = computeNextSync(sync_frequency);
    fields.push(`next_sync_at = $${i++}`);
    vals.push(nextAt);
  } else if (enabled === true) {
    const r0 = await query(
      `SELECT sync_frequency FROM teamtask_hub.commerce7_sync_objects WHERE id = $1`,
      [req.params.id]
    );
    if (r0.rows[0]) {
      const nextAt = computeNextSync(r0.rows[0].sync_frequency);
      fields.push(`next_sync_at = $${i++}`);
      vals.push(nextAt);
    }
  } else if (enabled === false) {
    fields.push(`next_sync_at = $${i++}`);
    vals.push(null);
  }

  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    const r = await query(
      `UPDATE teamtask_hub.commerce7_sync_objects SET ${fields.join(', ')}
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

// ── POST /api/commerce7/sync/objects/:id/run ─────────────────────────────────
router.post('/objects/:id/run', async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM teamtask_hub.commerce7_sync_objects WHERE id = $1 AND company_id = $2`,
      [req.params.id, cid(req)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const obj = r.rows[0];

    // Fetch credentials
    const credRow = await query(
      `SELECT c7_tenant_slug, c7_tenant_id, c7_api_base_url, c7_api_key
       FROM company_integrations WHERE company_id = $1`,
      [cid(req)]
    );
    const integration = credRow.rows[0];
    if (!integration?.c7_api_key) {
      return res.status(400).json({ error: 'Commerce7 is not configured. Add credentials in Settings → Integrations.' });
    }

    // Mark as running
    await query(
      `UPDATE teamtask_hub.commerce7_sync_objects SET last_sync_status = 'running' WHERE id = $1`,
      [obj.id]
    );

    const companyId = cid(req);
    const opts = { mode: 'incremental' };
    let result;

    switch (obj.object_type) {
      case 'customers':         result = await syncCustomers(companyId, integration, opts); break;
      case 'orders':            result = await syncOrders(companyId, integration, opts); break;
      case 'products':          result = await syncProducts(companyId, integration, opts); break;
      case 'collections':       result = await syncCollections(companyId, integration); break;
      case 'vendors':           result = await syncVendors(companyId, integration); break;
      case 'wine_varietals':    result = await syncWineVarietals(companyId, integration); break;
      case 'wine_appellations': result = await syncWineAppellations(companyId, integration); break;
      case 'clubs':             result = await syncClubs(companyId, integration); break;
      case 'club_memberships':  result = await syncClubMemberships(companyId, integration, opts); break;
      case 'reservations':      result = await syncReservations(companyId, integration, opts); break;
      case 'gift_cards':        result = await syncGiftCards(companyId, integration); break;
      case 'promotions':        result = await syncPromotions(companyId, integration); break;
      default:
        return res.status(400).json({ error: `No sync handler for object_type: ${obj.object_type}` });
    }

    const count = result.synced ?? 0;
    const nextAt = computeNextSync(obj.sync_frequency);

    await query(
      `UPDATE teamtask_hub.commerce7_sync_objects
       SET last_synced_at   = NOW(),
           last_sync_status = 'ok',
           last_sync_count  = $1,
           last_sync_error  = NULL,
           next_sync_at     = CASE WHEN enabled THEN $2 ELSE next_sync_at END
       WHERE id = $3`,
      [count, nextAt, obj.id]
    );

    const updated = await query(
      `SELECT * FROM teamtask_hub.commerce7_sync_objects WHERE id = $1`,
      [obj.id]
    );
    res.json({ ok: true, object: updated.rows[0], ...result });
  } catch (err) {
    await query(
      `UPDATE teamtask_hub.commerce7_sync_objects
       SET last_sync_status = 'error', last_sync_error = $1
       WHERE id = $2`,
      [err.message, req.params.id]
    );
    res.status(500).json({ error: err.message });
  }
});

export { router as commerce7SyncRouter };
