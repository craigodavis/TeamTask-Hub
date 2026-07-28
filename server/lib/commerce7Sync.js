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

// Runs one item's upsert in isolation — a single bad record (unexpected
// null, constraint violation, etc.) is logged and skipped instead of
// aborting the whole page/entity sync for every other record.
async function safely(fn, label, failed) {
  try {
    await fn();
  } catch (err) {
    console.error(`[c7-sync] item "${label}" failed:`, err.message);
    failed.push({ label: String(label), error: err.message });
  }
}

function failureNote(failed) {
  return failed.length ? `${failed.length} item(s) failed: ${failed.map((f) => f.label).join(', ')}` : null;
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
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (since) params.set('updatedAt', `gte:${new Date(since).toISOString()}`);

      const data = await c7.get(`/customer?${params}`);
      total = data.total ?? 0;

      for (const customer of data.customers ?? []) {
        await safely(() => upsertCustomer(companyId, customer), customer.id, failed);
      }

      synced += (data.customers ?? []).length;
      console.log(`[c7-sync] customers page ${page}/${Math.ceil(total / PAGE_SIZE)} — ${synced}/${total}`);
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'customers', failed };
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
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (since) params.set('updatedAt', `gte:${new Date(since).toISOString()}`);

      const data = await c7.get(`/order?${params}`);
      total = data.total ?? 0;

      for (const order of data.orders ?? []) {
        await safely(async () => {
          await upsertOrder(companyId, order);
          await upsertOrderItems(companyId, order.id, order.items);
        }, order.orderNumber || order.id, failed);
      }

      synced += (data.orders ?? []).length;
      console.log(`[c7-sync] orders page ${page}/${Math.ceil(total / PAGE_SIZE)} — ${synced}/${total}`);
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'orders', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Products + Variants ───────────────────────────────────────────────────────

async function upsertProduct(companyId, p) {
  await query(
    `INSERT INTO commerce7.product
       (id, company_id, title, slug, type, admin_status, web_status,
        price, compare_price, short_description, description,
        image, images, tags, vendor_id, collection_ids,
        wine_varietal_ids, wine_appellation_id,
        vintage, alcohol_percentage, volume_in_ml, weight,
        country_code, region, metadata, c7_created_at, c7_updated_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,NOW())
     ON CONFLICT (id) DO UPDATE SET
       title               = EXCLUDED.title,
       slug                = EXCLUDED.slug,
       type                = EXCLUDED.type,
       admin_status        = EXCLUDED.admin_status,
       web_status          = EXCLUDED.web_status,
       price               = EXCLUDED.price,
       compare_price       = EXCLUDED.compare_price,
       short_description   = EXCLUDED.short_description,
       description         = EXCLUDED.description,
       image               = EXCLUDED.image,
       images              = EXCLUDED.images,
       tags                = EXCLUDED.tags,
       vendor_id           = EXCLUDED.vendor_id,
       collection_ids      = EXCLUDED.collection_ids,
       wine_varietal_ids   = EXCLUDED.wine_varietal_ids,
       wine_appellation_id = EXCLUDED.wine_appellation_id,
       vintage             = EXCLUDED.vintage,
       alcohol_percentage  = EXCLUDED.alcohol_percentage,
       volume_in_ml        = EXCLUDED.volume_in_ml,
       weight              = EXCLUDED.weight,
       country_code        = EXCLUDED.country_code,
       region              = EXCLUDED.region,
       metadata            = EXCLUDED.metadata,
       c7_updated_at       = EXCLUDED.c7_updated_at,
       synced_at           = NOW()`,
    [
      p.id, companyId,
      p.title      ?? null,
      p.slug       ?? null,
      p.type       ?? null,
      p.adminStatus ?? null,
      p.webStatus  ?? null,
      p.price      ?? null,
      p.comparePrice ?? null,
      p.shortDescription ?? null,
      p.description ?? null,
      p.image  ? JSON.stringify(p.image)  : null,
      p.images ? JSON.stringify(p.images) : null,
      JSON.stringify(p.tags ?? []),
      p.vendorId ?? null,
      JSON.stringify(p.collectionIds ?? p.collections?.map(c => c.id) ?? []),
      JSON.stringify(p.wineVarietalIds ?? p.wineVarietals?.map(v => v.id) ?? []),
      p.wineAppellationId ?? p.wineAppellation?.id ?? null,
      p.vintage ?? null,
      p.alcoholPercentage ?? null,
      p.volumeInML ?? null,
      p.weight ?? null,
      p.countryCode ?? null,
      p.region ?? null,
      p.metaData ? JSON.stringify(p.metaData) : null,
      p.createdAt ?? null,
      p.updatedAt ?? null,
    ]
  );
}

async function upsertProductVariants(companyId, productId, variants) {
  if (!variants?.length) return 0;
  await query(`DELETE FROM commerce7.product_variant WHERE product_id = $1`, [productId]);
  for (const v of variants) {
    await query(
      `INSERT INTO commerce7.product_variant
         (id, company_id, product_id, title, sku, price, compare_price,
          on_hand_count, reserve_count, allocated_count, available_count,
          is_default, attributes, metadata, c7_created_at, c7_updated_at, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        v.id, companyId, productId,
        v.title     ?? null,
        v.sku       ?? null,
        v.price     ?? null,
        v.comparePrice ?? null,
        v.onHandCount    ?? null,
        v.reserveCount   ?? null,
        v.allocatedCount ?? null,
        v.availableCount ?? null,
        v.isDefault ?? false,
        v.attributes ? JSON.stringify(v.attributes) : null,
        v.metaData   ? JSON.stringify(v.metaData)   : null,
        v.createdAt  ?? null,
        v.updatedAt  ?? null,
      ]
    );
  }
  return variants.length;
}

export async function syncProducts(companyId, integration, { mode = 'incremental' } = {}) {
  const since = mode === 'full' ? null : await getWatermark(companyId, 'product');
  const logId = await logStart(companyId, 'products', mode, since);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (since) params.set('updatedAt', `gte:${new Date(since).toISOString().slice(0, 10)}`);

      const data = await c7.get(`/product?${params}`);
      total = data.total ?? 0;

      for (const product of data.products ?? []) {
        await safely(async () => {
          await upsertProduct(companyId, product);
          await upsertProductVariants(companyId, product.id, product.variants);
        }, product.title || product.id, failed);
      }

      synced += (data.products ?? []).length;
      console.log(`[c7-sync] products page ${page}/${Math.ceil(total / PAGE_SIZE)} — ${synced}/${total}`);
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'products', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Collections ───────────────────────────────────────────────────────────────

export async function syncCollections(companyId, integration) {
  const logId = await logStart(companyId, 'collections', 'full', null);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const data = await c7.get(`/collection?page=${page}&limit=${PAGE_SIZE}`);
      total = data.total ?? 0;

      for (const col of data.collections ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.collection
             (id, company_id, title, slug, is_published, description, image, metadata, c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
           ON CONFLICT (id) DO UPDATE SET
             title        = EXCLUDED.title,
             slug         = EXCLUDED.slug,
             is_published = EXCLUDED.is_published,
             description  = EXCLUDED.description,
             image        = EXCLUDED.image,
             metadata     = EXCLUDED.metadata,
             c7_updated_at = EXCLUDED.c7_updated_at,
             synced_at    = NOW()`,
          [
            col.id, companyId,
            col.title       ?? null,
            col.slug        ?? null,
            col.isPublished ?? false,
            col.description ?? null,
            col.image  ? JSON.stringify(col.image)  : null,
            col.metaData ? JSON.stringify(col.metaData) : null,
            col.createdAt ?? null,
            col.updatedAt ?? null,
          ]
        ), col.title || col.id, failed);
      }

      synced += (data.collections ?? []).length;
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'collections', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Vendors ───────────────────────────────────────────────────────────────────

export async function syncVendors(companyId, integration) {
  const logId = await logStart(companyId, 'vendors', 'full', null);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const data = await c7.get(`/vendor?page=${page}&limit=${PAGE_SIZE}`);
      total = data.total ?? 0;

      for (const v of data.vendors ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.vendor
             (id, company_id, title, c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (id) DO UPDATE SET
             title         = EXCLUDED.title,
             c7_updated_at = EXCLUDED.c7_updated_at,
             synced_at     = NOW()`,
          [v.id, companyId, v.title ?? null, v.createdAt ?? null, v.updatedAt ?? null]
        ), v.title || v.id, failed);
      }

      synced += (data.vendors ?? []).length;
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'vendors', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Wine Varietals ────────────────────────────────────────────────────────────

export async function syncWineVarietals(companyId, integration) {
  const logId = await logStart(companyId, 'wine_varietals', 'full', null);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const data = await c7.get(`/wine-varietal?page=${page}&limit=${PAGE_SIZE}`);
      total = data.total ?? 0;

      for (const v of data.wineVarietals ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.wine_varietal
             (id, company_id, title, c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (id) DO UPDATE SET
             title         = EXCLUDED.title,
             c7_updated_at = EXCLUDED.c7_updated_at,
             synced_at     = NOW()`,
          [v.id, companyId, v.title ?? null, v.createdAt ?? null, v.updatedAt ?? null]
        ), v.title || v.id, failed);
      }

      synced += (data.wineVarietals ?? []).length;
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'wine_varietals', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Wine Appellations ─────────────────────────────────────────────────────────

export async function syncWineAppellations(companyId, integration) {
  const logId = await logStart(companyId, 'wine_appellations', 'full', null);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const data = await c7.get(`/wine-appellation?page=${page}&limit=${PAGE_SIZE}`);
      total = data.total ?? 0;

      for (const a of data.wineAppellations ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.wine_appellation
             (id, company_id, title, c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (id) DO UPDATE SET
             title         = EXCLUDED.title,
             c7_updated_at = EXCLUDED.c7_updated_at,
             synced_at     = NOW()`,
          [a.id, companyId, a.title ?? null, a.createdAt ?? null, a.updatedAt ?? null]
        ), a.title || a.id, failed);
      }

      synced += (data.wineAppellations ?? []).length;
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'wine_appellations', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Clubs ─────────────────────────────────────────────────────────────────────

export async function syncClubs(companyId, integration) {
  const logId = await logStart(companyId, 'clubs', 'full', null);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const data = await c7.get(`/club?page=${page}&limit=${PAGE_SIZE}`);
      total = data.total ?? 0;

      for (const club of data.clubs ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.club
             (id, company_id, title, slug, status, admin_status, description, image, metadata, c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT (id) DO UPDATE SET
             title         = EXCLUDED.title,
             slug          = EXCLUDED.slug,
             status        = EXCLUDED.status,
             admin_status  = EXCLUDED.admin_status,
             description   = EXCLUDED.description,
             image         = EXCLUDED.image,
             metadata      = EXCLUDED.metadata,
             c7_updated_at = EXCLUDED.c7_updated_at,
             synced_at     = NOW()`,
          [
            club.id, companyId,
            club.title        ?? null,
            club.slug         ?? null,
            club.webStatus    ?? null,   // C7 field is webStatus, not status
            club.adminStatus  ?? null,
            club.description  ?? null,
            club.image   ? JSON.stringify(club.image)   : null,
            club.metaData ? JSON.stringify(club.metaData) : null,
            club.createdAt ?? null,
            club.updatedAt ?? null,
          ]
        ), club.title || club.id, failed);
      }

      synced += (data.clubs ?? []).length;
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'clubs', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Club Packages (wine releases) ─────────────────────────────────────────────

// One package = one club tier's release. The two email dates C7 exposes here are
// what drives wine-release push; see docs and migration 114. Full sync every time:
// there are only ~131 of them and the email dates get edited in place, so an
// incremental watermark on updatedAt would miss a date change on an old row.
export async function syncClubPackages(companyId, integration) {
  const logId = await logStart(companyId, 'club_packages', 'full', null);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const data = await c7.get(`/club-package?page=${page}&limit=${PAGE_SIZE}`);
      total = data.total ?? 0;

      for (const pkg of data.clubPackages ?? []) {
        await safely(async () => {
          const em = pkg.email || {};
          await query(
            `INSERT INTO commerce7.club_package
               (id, company_id, club_id, title, status, process_date, auto_process_status,
                requested_ship_date, two_week_send_date, two_week_send_status,
                two_day_send_date, two_day_send_status, is_send_credit_card_decline,
                pre_shipment_email_instructions, item_choice, min_quantity_in_shipment,
                min_order_value_of_shipment, club_member_shipment_count,
                allow_customers_to_ship_early, stats, c7_created_at, c7_updated_at, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
             ON CONFLICT (id) DO UPDATE SET
               club_id                         = EXCLUDED.club_id,
               title                           = EXCLUDED.title,
               status                          = EXCLUDED.status,
               process_date                    = EXCLUDED.process_date,
               auto_process_status             = EXCLUDED.auto_process_status,
               requested_ship_date             = EXCLUDED.requested_ship_date,
               two_week_send_date              = EXCLUDED.two_week_send_date,
               two_week_send_status            = EXCLUDED.two_week_send_status,
               two_day_send_date               = EXCLUDED.two_day_send_date,
               two_day_send_status             = EXCLUDED.two_day_send_status,
               is_send_credit_card_decline     = EXCLUDED.is_send_credit_card_decline,
               pre_shipment_email_instructions = EXCLUDED.pre_shipment_email_instructions,
               item_choice                     = EXCLUDED.item_choice,
               min_quantity_in_shipment        = EXCLUDED.min_quantity_in_shipment,
               min_order_value_of_shipment     = EXCLUDED.min_order_value_of_shipment,
               club_member_shipment_count      = EXCLUDED.club_member_shipment_count,
               allow_customers_to_ship_early   = EXCLUDED.allow_customers_to_ship_early,
               stats                           = EXCLUDED.stats,
               c7_updated_at                   = EXCLUDED.c7_updated_at,
               synced_at                       = NOW()`,
            [
              pkg.id, companyId,
              pkg.clubId ?? null,
              pkg.title ?? null,
              pkg.status ?? null,
              pkg.processDate ?? null,
              pkg.autoProcessStatus ?? null,
              pkg.requestedShipDate ?? null,
              em.twoWeekSendDate ?? null,
              em.twoWeekSendStatus ?? null,
              em.twoDaySendDate ?? null,
              em.twoDaySendStatus ?? null,
              em.isSendCreditCardDecline ?? null,
              pkg.preShipmentEmailInstructions ?? null,
              pkg.itemChoice ?? null,
              pkg.minQuantityInShipment ?? null,
              pkg.minOrderValueOfShipment ?? null,
              pkg.clubMemberShipmentCount ?? null,
              pkg.allowCustomersToShipEarly ?? null,
              pkg.stats ? JSON.stringify(pkg.stats) : null,
              pkg.createdAt ?? null,
              pkg.updatedAt ?? null,
            ]
          );

          // Items are replaced wholesale — a package's wine list is edited as a
          // set, so upserting would strand rows for wines that were removed.
          await query(`DELETE FROM commerce7.club_package_item WHERE package_id = $1`, [pkg.id]);
          for (const it of pkg.items ?? []) {
            await query(
              `INSERT INTO commerce7.club_package_item
                 (id, package_id, company_id, product_id, product_title, product_variant_id,
                  product_variant_title, sku, product_type, item_type, default_quantity,
                  price, sort_order, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
               ON CONFLICT (id) DO NOTHING`,
              [
                it.id, pkg.id, companyId,
                it.productId ?? null, it.productTitle ?? null,
                it.productVariantId ?? null, it.productVariantTitle ?? null,
                it.sku ?? null, it.productType ?? null, it.itemType ?? null,
                it.defaultQuantity ?? null, it.price ?? null, it.sortOrder ?? null,
              ]
            );
          }
        }, pkg.title || pkg.id, failed);
      }

      synced += (data.clubPackages ?? []).length;
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'club_packages', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Club Memberships ──────────────────────────────────────────────────────────

export async function syncClubMemberships(companyId, integration, { mode = 'incremental' } = {}) {
  const since = mode === 'full' ? null : await getWatermark(companyId, 'club_membership');
  const logId = await logStart(companyId, 'club_memberships', mode, since);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (since) params.set('updatedAt', `gte:${new Date(since).toISOString().slice(0, 10)}`);

      const data = await c7.get(`/club-membership?${params}`);
      total = data.total ?? 0;

      for (const m of data.clubMemberships ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.club_membership
             (id, company_id, customer_id, club_id, status,
              signup_date, cancel_date, next_process_date, frequency,
              shipment_count, tags, metadata, c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
           ON CONFLICT (id) DO UPDATE SET
             customer_id       = EXCLUDED.customer_id,
             club_id           = EXCLUDED.club_id,
             status            = EXCLUDED.status,
             signup_date       = EXCLUDED.signup_date,
             cancel_date       = EXCLUDED.cancel_date,
             next_process_date = EXCLUDED.next_process_date,
             frequency         = EXCLUDED.frequency,
             shipment_count    = EXCLUDED.shipment_count,
             tags              = EXCLUDED.tags,
             metadata          = EXCLUDED.metadata,
             c7_updated_at     = EXCLUDED.c7_updated_at,
             synced_at         = NOW()`,
          [
            m.id, companyId,
            m.customerId    ?? null,
            m.clubId        ?? null,
            m.status        ?? null,
            m.signupDate    ?? null,
            m.cancelDate    ?? null,
            m.nextProcessDate ?? null,
            m.frequency     ?? null,
            m.shipmentCount ?? null,
            JSON.stringify(m.tags ?? []),
            m.metaData ? JSON.stringify(m.metaData) : null,
            m.createdAt ?? null,
            m.updatedAt ?? null,
          ]
        ), m.id, failed);
      }

      synced += (data.clubMemberships ?? []).length;
      console.log(`[c7-sync] club-memberships page ${page}/${Math.ceil(total / PAGE_SIZE)} — ${synced}/${total}`);
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'club_memberships', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Reservations ──────────────────────────────────────────────────────────────

export async function syncReservations(companyId, integration, { mode = 'incremental' } = {}) {
  const since = mode === 'full' ? null : await getWatermark(companyId, 'reservation');
  const logId = await logStart(companyId, 'reservations', mode, since);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const params = new URLSearchParams({ page, limit: PAGE_SIZE });
      if (since) params.set('updatedAt', `gte:${new Date(since).toISOString().slice(0, 10)}`);

      const data = await c7.get(`/reservation?${params}`);
      total = data.total ?? 0;

      for (const r of data.reservations ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.reservation
             (id, company_id, customer_id, reservation_type_id, reservation_date,
              start_time, end_time, party_size, status, payment_status, channel,
              sub_total, tax_total, total, notes, tags, tenders, metadata,
              c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
           ON CONFLICT (id) DO UPDATE SET
             customer_id         = EXCLUDED.customer_id,
             reservation_type_id = EXCLUDED.reservation_type_id,
             reservation_date    = EXCLUDED.reservation_date,
             start_time          = EXCLUDED.start_time,
             end_time            = EXCLUDED.end_time,
             party_size          = EXCLUDED.party_size,
             status              = EXCLUDED.status,
             payment_status      = EXCLUDED.payment_status,
             channel             = EXCLUDED.channel,
             sub_total           = EXCLUDED.sub_total,
             tax_total           = EXCLUDED.tax_total,
             total               = EXCLUDED.total,
             notes               = EXCLUDED.notes,
             tags                = EXCLUDED.tags,
             tenders             = EXCLUDED.tenders,
             metadata            = EXCLUDED.metadata,
             c7_updated_at       = EXCLUDED.c7_updated_at,
             synced_at           = NOW()`,
          [
            r.id, companyId,
            r.customerId         ?? null,
            r.reservationTypeId  ?? null,
            r.reservationDate    ?? null,
            r.startTime          ?? null,
            r.endTime            ?? null,
            r.partySize          ?? null,
            r.status             ?? null,
            r.paymentStatus      ?? null,
            r.channel            ?? null,
            r.subTotal           ?? null,
            r.taxTotal           ?? null,
            r.total              ?? null,
            r.notes              ?? null,
            JSON.stringify(r.tags ?? []),
            r.tenders ? JSON.stringify(r.tenders) : null,
            r.metaData ? JSON.stringify(r.metaData) : null,
            r.createdAt ?? null,
            r.updatedAt ?? null,
          ]
        ), r.id, failed);
      }

      synced += (data.reservations ?? []).length;
      console.log(`[c7-sync] reservations page ${page}/${Math.ceil(total / PAGE_SIZE)} — ${synced}/${total}`);
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'reservations', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Gift Cards ────────────────────────────────────────────────────────────────

export async function syncGiftCards(companyId, integration) {
  const logId = await logStart(companyId, 'gift_cards', 'full', null);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const data = await c7.get(`/gift-card?page=${page}&limit=${PAGE_SIZE}`);
      total = data.total ?? 0;

      for (const gc of data.giftCards ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.gift_card
             (id, company_id, customer_id, code, status, balance, original_balance, currency,
              c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
           ON CONFLICT (id) DO UPDATE SET
             customer_id      = EXCLUDED.customer_id,
             code             = EXCLUDED.code,
             status           = EXCLUDED.status,
             balance          = EXCLUDED.balance,
             original_balance = EXCLUDED.original_balance,
             currency         = EXCLUDED.currency,
             c7_updated_at    = EXCLUDED.c7_updated_at,
             synced_at        = NOW()`,
          [
            gc.id, companyId,
            gc.customerId      ?? null,
            gc.code            ?? null,
            gc.status          ?? null,
            gc.balance         ?? null,
            gc.originalBalance ?? null,
            gc.currency        ?? null,
            gc.createdAt       ?? null,
            gc.updatedAt       ?? null,
          ]
        ), gc.code || gc.id, failed);
      }

      synced += (data.giftCards ?? []).length;
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'gift_cards', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Promotions ────────────────────────────────────────────────────────────────

export async function syncPromotions(companyId, integration) {
  const logId = await logStart(companyId, 'promotions', 'full', null);
  const c7 = makeC7Client(integration);

  let page = 1, total = Infinity, synced = 0;
  const failed = [];

  try {
    while ((page - 1) * PAGE_SIZE < total) {
      const data = await c7.get(`/promotion?page=${page}&limit=${PAGE_SIZE}`);
      total = data.total ?? 0;

      for (const p of data.promotions ?? []) {
        await safely(() => query(
          `INSERT INTO commerce7.promotion
             (id, company_id, title, type, status, discount_type, discount_value,
              start_date, end_date, metadata, c7_created_at, c7_updated_at, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
           ON CONFLICT (id) DO UPDATE SET
             title          = EXCLUDED.title,
             type           = EXCLUDED.type,
             status         = EXCLUDED.status,
             discount_type  = EXCLUDED.discount_type,
             discount_value = EXCLUDED.discount_value,
             start_date     = EXCLUDED.start_date,
             end_date       = EXCLUDED.end_date,
             metadata       = EXCLUDED.metadata,
             c7_updated_at  = EXCLUDED.c7_updated_at,
             synced_at      = NOW()`,
          [
            p.id, companyId,
            p.title         ?? null,
            p.type          ?? null,
            p.status        ?? null,
            p.discountType  ?? null,
            p.discountValue ?? null,
            p.startDate     ?? null,
            p.endDate       ?? null,
            p.metaData ? JSON.stringify(p.metaData) : null,
            p.createdAt ?? null,
            p.updatedAt ?? null,
          ]
        ), p.title || p.id, failed);
      }

      synced += (data.promotions ?? []).length;
      page++;
    }

    await logFinish(logId, synced, failureNote(failed));
    return { synced, entity: 'promotions', failed };
  } catch (err) {
    await logFinish(logId, synced, err.message);
    throw err;
  }
}

// ── Full company sync (all objects) ──────────────────────────────────────────

export async function syncCompany(companyId, integration, opts = {}) {
  console.log(`[c7-sync] starting sync for company ${companyId} (mode=${opts.mode ?? 'incremental'})`);
  const results = {};

  // Settings → Commerce7 reads teamtask_hub.commerce7_sync_objects, but only the
  // manual "Sync now" button used to write it — so the screen showed the last time
  // someone clicked a button (May) while the scheduler had in fact been running
  // every 4 hours the whole time. Stamp it here too, or the dashboard lies.
  const stamp = async (objectType, ok, count, errMsg) => {
    try {
      await query(
        `UPDATE teamtask_hub.commerce7_sync_objects
            SET last_synced_at   = NOW(),
                last_sync_status = $3,
                last_sync_count  = $4,
                last_sync_error  = $5
          WHERE company_id = $1 AND object_type = $2`,
        [companyId, objectType, ok ? 'ok' : 'error', count, errMsg]
      );
    } catch (e) {
      console.warn(`[c7-sync] could not stamp ${objectType}:`, e.message);
    }
  };

  const run = async (name, fn) => {
    try {
      results[name] = await fn();
      const r = results[name];
      await stamp(name, true, r?.synced ?? 0,
        r?.failed?.length ? `${r.failed.length} item(s) failed: ${r.failed.map((f) => f.label).join(', ')}` : null);
    } catch (err) {
      console.error(`[c7-sync] ${name} sync failed for ${companyId}:`, err.message);
      results[name] = { error: err.message };
      await stamp(name, false, 0, err.message);
    }
  };

  await run('customers',        () => syncCustomers(companyId, integration, opts));
  await run('orders',           () => syncOrders(companyId, integration, opts));
  await run('products',         () => syncProducts(companyId, integration, opts));
  await run('collections',      () => syncCollections(companyId, integration));
  await run('vendors',          () => syncVendors(companyId, integration));
  await run('wine_varietals',   () => syncWineVarietals(companyId, integration));
  await run('wine_appellations',() => syncWineAppellations(companyId, integration));
  await run('clubs',            () => syncClubs(companyId, integration));
  await run('club_packages',    () => syncClubPackages(companyId, integration));
  await run('club_memberships', () => syncClubMemberships(companyId, integration, opts));
  await run('reservations',     () => syncReservations(companyId, integration, opts));
  await run('gift_cards',       () => syncGiftCards(companyId, integration));
  await run('promotions',       () => syncPromotions(companyId, integration));

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
