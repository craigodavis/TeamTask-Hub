/**
 * Commerce7 → PostgreSQL sync
 *
 * Syncs customers and orders (with items) from the C7 API into the
 * commerce7.* schema.  Supports both full and incremental modes.
 *
 * Incremental mode (default): uses the highest c7_updated_at already stored
 * to know where to resume.  Safe to run repeatedly — all writes are upserts.
 *
 * Full mode: ignores the stored watermark and pages through everything.
 * Use for the initial load or to repair gaps.
 */

import { query } from '../db.js';
import { makeC7Client } from './commerce7Client.js';

const PAGE_SIZE = 50;  // C7 API max is 50

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getIntegrations() {
  const { rows } = await query(
    `SELECT ci.company_id, ci.c7_api_key, ci.c7_tenant_slug, ci.c7_api_base_url
     FROM company_integrations ci
     WHERE ci.c7_api_key IS NOT NULL AND ci.c7_api_key <> ''`
  );
  return rows;
}

async function getWatermark(companyId, entity) {
  const { rows } = await query(
    `SELECT MAX(c7_updated_at) AS wm FROM commerce7.${entity} WHERE company_id = $1`,
    [companyId]
  );
  return rows[0]?.wm || null;
}

async function logStart(companyId, entity, mode, since) {
  const { rows } = await query(
    `INSERT INTO commerce7.sync_log (company_id, entity, mode, since)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, entity, mode, since]
  );
  return rows[0].id;
}

async function logFinish(logId, recordsSynced, errorMessage = null) {
  await query(
    `UPDATE commerce7.sync_log
     SET finished_at = NOW(), records_synced = $2, error_message = $3
     WHERE id = $1`,
    [logId, recordsSynced, errorMessage]
  );
}

// ── Customer sync ─────────────────────────────────────────────────────────────

async function upsertCustomer(companyId, c) {
  const primaryEmail = c.emails?.find(e => e.isPrimary)?.email
    ?? c.emails?.[0]?.email
    ?? null;

  await query(
    `INSERT INTO commerce7.customers
       (id, company_id, honorific, first_name, last_name, birth_date,
        city, state_code, zip_code, country_code,
        email_marketing_status, has_account, last_activity_date,
        emails, phones, clubs, order_information, tags, metadata,
        c7_created_at, c7_updated_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
     ON CONFLICT (id) DO UPDATE SET
       honorific              = EXCLUDED.honorific,
       first_name             = EXCLUDED.first_name,
       last_name              = EXCLUDED.last_name,
       birth_date             = EXCLUDED.birth_date,
       city                   = EXCLUDED.city,
       state_code             = EXCLUDED.state_code,
       zip_code               = EXCLUDED.zip_code,
       country_code           = EXCLUDED.country_code,
       email_marketing_status = EXCLUDED.email_marketing_status,
       has_account            = EXCLUDED.has_account,
       last_activity_date     = EXCLUDED.last_activity_date,
       emails                 = EXCLUDED.emails,
       phones                 = EXCLUDED.phones,
       clubs                  = EXCLUDED.clubs,
       order_information      = EXCLUDED.order_information,
       tags                   = EXCLUDED.tags,
       metadata               = EXCLUDED.metadata,
       c7_updated_at          = EXCLUDED.c7_updated_at,
       synced_at              = NOW()`,
    [
      c.id, companyId,
      c.honorific ?? null,
      c.firstName ?? null,
      c.lastName  ?? null,
      c.birthDate ?? null,
      c.city      ?? null,
      c.stateCode ?? null,
      c.zipCode   ?? null,
      c.countryCode ?? null,
      c.emailMarketingStatus ?? null,
      c.hasAccount ?? false,
      c.lastActivityDate ?? null,
      JSON.stringify(c.emails   ?? []),
      JSON.stringify(c.phones   ?? []),
      JSON.stringify(c.clubs    ?? []),
      c.orderInformation ? JSON.stringify(c.orderInformation) : null,
      JSON.stringify(c.tags     ?? []),
      c.metaData ? JSON.stringify(c.metaData) : null,
      c.createdAt ?? null,
      c.updatedAt ?? null,
    ]
  );
}

export async function syncCustomers(companyId, integration, { mode = 'incremental' } = {}) {
  const since = mode === 'full' ? null : await getWatermark(companyId, 'customers');
  const logId = await logStart(companyId, 'customers', mode, since);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (since) params.set('updatedAt', `gte:${new Date(since).toISOString()}`);

      const data = await c7.get(`/customer?${params}`);
      total = data.total ?? 0;

      for (const customer of data.customers ?? []) {
        await upsertCustomer(companyId, customer);
      }

      synced += (data.customers ?? []).length;
      console.log(`[c7-sync] customers page ${page}/${Math.ceil(total / PAGE_SIZE)} — ${synced}/${total}`);
      page++;
    }

    await logFinish(logId, synced);
    return { synced, entity: 'customers' };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Order + items sync ────────────────────────────────────────────────────────

async function upsertOrder(companyId, o) {
  const billTo = o.billTo ?? {};

  await query(
    `INSERT INTO commerce7.orders
       (id, company_id, order_number,
        order_submitted_date, order_paid_date, order_fulfilled_date,
        order_source, customer_type, purchase_type,
        previous_order_id, previous_order_number, refund_order_id,
        payment_status, compliance_status, fulfillment_status, shipping_status,
        channel, sales_attribute_code, pos_profile_id, customer_id,
        order_delivery_method, tax_sale_type,
        sub_total, ship_total, tax_total, duty_total,
        bottle_deposit_total, tip_total, total, total_after_tip,
        is_non_taxable, is_no_duty, loyalty_points_earned,
        bill_to_first_name, bill_to_last_name,
        bill_to_city, bill_to_state_code, bill_to_zip_code, bill_to_country_code,
        club, tenders, taxes, fulfillments, promotions, coupons, tags, metadata,
        c7_created_at, c7_updated_at, synced_at)
     VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
       $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
       $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,NOW())
     ON CONFLICT (id) DO UPDATE SET
       order_number          = EXCLUDED.order_number,
       order_submitted_date  = EXCLUDED.order_submitted_date,
       order_paid_date       = EXCLUDED.order_paid_date,
       order_fulfilled_date  = EXCLUDED.order_fulfilled_date,
       payment_status        = EXCLUDED.payment_status,
       compliance_status     = EXCLUDED.compliance_status,
       fulfillment_status    = EXCLUDED.fulfillment_status,
       shipping_status       = EXCLUDED.shipping_status,
       sub_total             = EXCLUDED.sub_total,
       ship_total            = EXCLUDED.ship_total,
       tax_total             = EXCLUDED.tax_total,
       total                 = EXCLUDED.total,
       total_after_tip       = EXCLUDED.total_after_tip,
       loyalty_points_earned = EXCLUDED.loyalty_points_earned,
       tenders               = EXCLUDED.tenders,
       taxes                 = EXCLUDED.taxes,
       fulfillments          = EXCLUDED.fulfillments,
       promotions            = EXCLUDED.promotions,
       coupons               = EXCLUDED.coupons,
       tags                  = EXCLUDED.tags,
       metadata              = EXCLUDED.metadata,
       c7_updated_at         = EXCLUDED.c7_updated_at,
       synced_at             = NOW()`,
    [
      o.id, companyId, o.orderNumber,
      o.orderSubmittedDate ?? null,
      o.orderPaidDate      ?? null,
      o.orderFulfilledDate ?? null,
      o.orderSource  ?? null,
      o.customerType ?? null,
      o.purchaseType ?? null,
      o.previousOrderId     ?? null,
      o.previousOrderNumber ?? null,
      o.refundOrderId       ?? null,
      o.paymentStatus     ?? null,
      o.complianceStatus  ?? null,
      o.fulfillmentStatus ?? null,
      o.shippingStatus    ?? null,
      o.channel              ?? null,
      o.salesAttributeCode   ?? null,
      o.posProfileId         ?? null,
      o.customerId           ?? null,
      o.orderDeliveryMethod  ?? null,
      o.taxSaleType          ?? null,
      o.subTotal          ?? 0,
      o.shipTotal         ?? 0,
      o.taxTotal          ?? 0,
      o.dutyTotal         ?? 0,
      o.bottleDepositTotal ?? 0,
      o.tipTotal          ?? 0,
      o.total             ?? 0,
      o.totalAfterTip     ?? 0,
      o.isNonTaxable ?? false,
      o.isNoDuty     ?? false,
      o.loyaltyPointsEarned ?? 0,
      billTo.firstName   ?? null,
      billTo.lastName    ?? null,
      billTo.city        ?? null,
      billTo.stateCode   ?? null,
      billTo.zipCode     ?? null,
      billTo.countryCode ?? null,
      o.club        ? JSON.stringify(o.club)        : null,
      JSON.stringify(o.tenders     ?? []),
      JSON.stringify(o.taxes       ?? []),
      JSON.stringify(o.fulfillments ?? []),
      JSON.stringify(o.promotions  ?? []),
      JSON.stringify(o.coupons     ?? []),
      JSON.stringify(o.tags        ?? []),
      o.metaData    ? JSON.stringify(o.metaData)    : null,
      o.createdAt ?? null,
      o.updatedAt ?? null,
    ]
  );
}

async function upsertOrderItems(companyId, orderId, items) {
  if (!items?.length) return;

  // Delete existing items for this order then re-insert (simpler than diffing)
  await query(`DELETE FROM commerce7.order_items WHERE order_id = $1`, [orderId]);

  for (const item of items) {
    await query(
      `INSERT INTO commerce7.order_items
         (id, company_id, order_id, purchase_type,
          product_title, product_slug, item_type,
          product_id, product_variant_id, product_variant_title, sku,
          cost_of_good, price, original_price, compare_price,
          quantity, quantity_fulfilled, tax, tax_type,
          bottle_deposit, weight, volume_in_ml, alcohol_percentage,
          department_code, department_id, allocation_id,
          is_price_override, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (id) DO NOTHING`,
      [
        item.id, companyId, orderId,
        item.purchaseType ?? null,
        item.productTitle ?? null,
        item.productSlug  ?? null,
        item.type         ?? null,
        item.productId        ?? null,
        item.productVariantId ?? null,
        item.productVariantTitle ?? null,
        item.sku ?? null,
        item.costOfGood    ?? null,
        item.price         ?? null,
        item.originalPrice ?? null,
        item.comparePrice  ?? null,
        item.quantity          ?? 1,
        item.quantityFulfilled ?? 0,
        item.tax           ?? 0,
        item.taxType       ?? null,
        item.bottleDeposit ?? 0,
        item.weight            ?? null,
        item.volumeInML        ?? null,
        item.alcoholPercentage ?? null,
        item.departmentCode ?? null,
        item.departmentId   ?? null,
        item.allocationId   ?? null,
        item.isPriceOverride ?? false,
        item.notes ?? null,
      ]
    );
  }
}

export async function syncOrders(companyId, integration, { mode = 'incremental' } = {}) {
  const since = mode === 'full' ? null : await getWatermark(companyId, 'orders');
  const logId = await logStart(companyId, 'orders', mode, since);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (since) params.set('updatedAt', `gte:${new Date(since).toISOString()}`);

      const data = await c7.get(`/order?${params}`);
      total = data.total ?? 0;

      for (const order of data.orders ?? []) {
        await upsertOrder(companyId, order);
        await upsertOrderItems(companyId, order.id, order.items);
      }

      synced += (data.orders ?? []).length;
      console.log(`[c7-sync] orders page ${page}/${Math.ceil(total / PAGE_SIZE)} — ${synced}/${total}`);
      page++;
    }

    await logFinish(logId, synced);
    return { synced, entity: 'orders' };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Full company sync (customers then orders) ────────────────────────────────

export async function syncCompany(companyId, integration, opts = {}) {
  console.log(`[c7-sync] starting sync for company ${companyId} (mode=${opts.mode ?? 'incremental'})`);
  const results = {};

  try {
    results.customers = await syncCustomers(companyId, integration, opts);
  } catch (err) {
    console.error(`[c7-sync] customer sync failed for ${companyId}:`, err.message);
    results.customers = { error: err.message };
  }

  try {
    results.orders = await syncOrders(companyId, integration, opts);
  } catch (err) {
    console.error(`[c7-sync] order sync failed for ${companyId}:`, err.message);
    results.orders = { error: err.message };
  }

  console.log(`[c7-sync] done for company ${companyId}`, results);
  return results;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

async function runScheduledSync() {
  const integrations = await getIntegrations();
  if (!integrations.length) return;

  console.log(`[c7-sync] scheduled incremental sync — ${integrations.length} company(s)`);
  for (const integration of integrations) {
    await syncCompany(integration.company_id, integration, { mode: 'incremental' });
  }
}

export function startC7SyncScheduler() {
  // First run 2 minutes after server start, then every 4 hours
  setTimeout(() => {
    runScheduledSync().catch((err) => console.error('[c7-sync] scheduler error:', err.message));
    setInterval(() => {
      runScheduledSync().catch((err) => console.error('[c7-sync] scheduler error:', err.message));
    }, 4 * 60 * 60 * 1000);
  }, 2 * 60 * 1000);

  console.log('[c7-sync] scheduler started (first run in 2 min, then every 4h)');
}
