/**
 * Build validated QBO Purchase line items for an itemization update.
 *
 * Guards against the export-corruption bug: qboUpdatePurchase REPLACES all of a
 * transaction's lines, and the old code wrote `Amount: parseFloat(total) || 0`,
 * so a missing line amount (parseFloat(undefined|null|'') -> NaN) was silently
 * written as $0. Because all lines are replaced, that wiped the transaction's
 * real total to $0 (when every line was missing) or understated it (when only
 * some were). This function refuses to produce bad lines instead of writing them.
 *
 * Throws (rather than corrupting the books) when:
 *   - any line amount is missing / non-numeric,
 *   - any line amount is negative,
 *   - the lines sum to <= $0 (would wipe the transaction),
 *   - the lines' sum falls short of the transaction's real total beyond a small
 *     tolerance (a correct itemization preserves the total; a shortfall means
 *     dropped amounts). Tolerance = max($0.05, 1% of total) to allow tax rounding.
 *
 * @param {object} existing  current QBO Purchase (needs Id + TotalAmt)
 * @param {Array}  items     [{ description, total, qbo_account_id, qbo_class_id }]
 * @param {number|string|null} expectedTotal  authoritative total to preserve;
 *                            defaults to existing.TotalAmt when omitted.
 * @returns {Array} validated QBO Line array
 */
export function buildPurchaseUpdateLines(existing, items, expectedTotal = null) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('qboUpdatePurchase: no line items provided — refusing to write.');
  }

  const lines = items.map((item) => {
    const amount = parseFloat(item.total);
    if (!Number.isFinite(amount)) {
      throw new Error(
        `qboUpdatePurchase: line "${item.description ?? ''}" has no valid amount ` +
        `(got ${JSON.stringify(item.total)}). Refusing to write — this would zero the transaction.`
      );
    }
    if (amount < 0) {
      throw new Error(
        `qboUpdatePurchase: line "${item.description ?? ''}" has a negative amount (${amount}).`
      );
    }
    const line = {
      Amount: amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: item.description,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: item.qbo_account_id },
        BillableStatus: 'NotBillable',
      },
    };
    if (item.qbo_class_id) {
      line.AccountBasedExpenseLineDetail.ClassRef = { value: item.qbo_class_id };
    }
    return line;
  });

  const newTotal = lines.reduce((sum, l) => sum + l.Amount, 0);
  if (!(newTotal > 0)) {
    throw new Error(
      `qboUpdatePurchase: itemized lines sum to $${newTotal.toFixed(2)} for purchase ` +
      `${existing?.Id ?? '(new)'} — refusing to write (would wipe the transaction).`
    );
  }

  const target = parseFloat(expectedTotal != null ? expectedTotal : existing?.TotalAmt);
  if (Number.isFinite(target) && target > 0) {
    // PENNIES ONLY — never a percentage. A 1% tolerance previously let real
    // shortfalls through (e.g. $4.99 of un-itemized Sysco tax on a $613 invoice
    // is 0.8%), silently understating the books. The written amount must equal
    // the invoice/bank total exactly; anything else is refused, not adjusted.
    const tolerance = 0.02;
    if (Math.abs(newTotal - target) > tolerance) {
      throw new Error(
        `qboUpdatePurchase: itemized lines sum to $${newTotal.toFixed(2)} but purchase ` +
        `${existing?.Id ?? '(new)'} total is $${target.toFixed(2)} ` +
        `(off by $${(target - newTotal).toFixed(2)}). Refusing to write — line amounts are likely missing.`
      );
    }
  }

  return lines;
}

/** QBO entities whose writes carry monetary Line[] amounts and must never post as $0. */
const MONETARY_TXN_ENTITIES = new Set([
  'purchase', 'bill', 'invoice', 'journalentry', 'salesreceipt',
  'creditmemo', 'refundreceipt', 'vendorcredit', 'deposit', 'estimate', 'purchaseorder',
]);

/**
 * Safety net for the generic gateway write path (gatewayExecutor). The receipt
 * export isn't the only thing that can POST a purchase — the agent gateway can
 * write any entity. This rejects a create/update whose Line array would post a
 * non-numeric amount or sum to $0 (the same corruption signature), from that door.
 * Only inspects amount-bearing transaction entities; leaves Account/Vendor/etc. alone.
 *
 * @param {string} entityLower  lowercased QBO entity name (e.g. 'purchase')
 * @param {object} body         the request body about to be POSTed
 */
export function assertSafeQboLineWrite(entityLower, body) {
  if (!MONETARY_TXN_ENTITIES.has(entityLower)) return;
  if (!body || typeof body !== 'object' || !Array.isArray(body.Line)) return; // nothing to validate
  for (const l of body.Line) {
    if (l && l.Amount !== undefined && !Number.isFinite(parseFloat(l.Amount))) {
      throw new Error(
        `Gateway refused ${entityLower} write: a line has a non-numeric Amount ` +
        `(${JSON.stringify(l.Amount)}) — would corrupt the transaction.`
      );
    }
  }
  const sum = body.Line.reduce((s, l) => s + (parseFloat(l?.Amount) || 0), 0);
  if (!(sum > 0)) {
    throw new Error(
      `Gateway refused ${entityLower} write: line amounts sum to $${sum.toFixed(2)} — ` +
      `would create/wipe a $0 transaction.`
    );
  }
}
