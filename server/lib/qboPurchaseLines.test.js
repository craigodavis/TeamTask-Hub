import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPurchaseUpdateLines, assertSafeQboLineWrite } from './qboPurchaseLines.js';

const existing = { Id: '999', TotalAmt: '16.36' };
const good = [
  { description: 'A', total: 10.0, qbo_account_id: '1' },
  { description: 'B', total: 6.36, qbo_account_id: '2' },
];

test('valid items summing to the total → returns correct lines', () => {
  const lines = buildPurchaseUpdateLines(existing, good);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].Amount, 10.0);
  assert.equal(lines[1].Amount, 6.36);
  assert.equal(lines[0].AccountBasedExpenseLineDetail.AccountRef.value, '1');
});

test('a null line total → throws instead of writing $0', () => {
  const items = [
    { description: 'A', total: null, qbo_account_id: '1' },
    { description: 'B', total: 6.36, qbo_account_id: '2' },
  ];
  assert.throws(() => buildPurchaseUpdateLines(existing, items), /no valid amount/);
});

test('a missing total field (undefined) → throws', () => {
  const items = [
    { description: 'A', qbo_account_id: '1' },
    { description: 'B', total: 6.36, qbo_account_id: '2' },
  ];
  assert.throws(() => buildPurchaseUpdateLines(existing, items), /no valid amount/);
});

test('empty-string total → throws', () => {
  const items = [{ description: 'A', total: '', qbo_account_id: '1' }];
  assert.throws(() => buildPurchaseUpdateLines(existing, items), /no valid amount/);
});

test('every line $0 → throws (would wipe transaction)', () => {
  const items = [{ description: 'A', total: 0, qbo_account_id: '1' }];
  assert.throws(() => buildPurchaseUpdateLines({ Id: '1', TotalAmt: '0' }, items), /wipe the transaction/);
});

test('partial shortfall beyond tolerance → throws', () => {
  // existing total $16.36, lines sum to $10.00 → off $6.36 (tol ~$0.16)
  const items = [{ description: 'A', total: 10.0, qbo_account_id: '1' }];
  assert.throws(() => buildPurchaseUpdateLines(existing, items), /off by/);
});

test('Sysco un-itemized tax shortfall → REFUSED (penny-exact, no % slack)', () => {
  // The real incident: invoice $668.48, lines sum $663.51 — short by the $4.97 tax.
  // That is 0.74%, which the old max($0.05, 1%) tolerance let through, silently
  // understating the books. Penny-exact must now refuse it.
  const sysco = { Id: '2', TotalAmt: '668.48' };
  const items = [{ description: 'X', total: 663.51, qbo_account_id: '1' }];
  assert.throws(() => buildPurchaseUpdateLines(sysco, items), /off by/);
});

test('exact match to the penny → passes', () => {
  const sysco = { Id: '2', TotalAmt: '668.48' };
  const items = [
    { description: 'goods', total: 663.51, qbo_account_id: '1' },
    { description: 'Sales Tax', total: 4.97, qbo_account_id: '2' },
  ];
  const lines = buildPurchaseUpdateLines(sysco, items);
  assert.equal(lines.length, 2);
});

test('one cent of rounding still allowed', () => {
  const sysco = { Id: '2', TotalAmt: '100.00' };
  const items = [{ description: 'X', total: 100.01, qbo_account_id: '1' }];
  assert.doesNotThrow(() => buildPurchaseUpdateLines(sysco, items));
});

test('Sysco shortfall just over tolerance → throws (the real damage case)', () => {
  // total $618.56, lines sum $548.93 → off $69.63 (a dropped line)
  const sysco = { Id: '2', TotalAmt: '618.56' };
  const items = [{ description: 'X', total: 548.93, qbo_account_id: '1' }];
  assert.throws(() => buildPurchaseUpdateLines(sysco, items), /off by/);
});

test('negative amount → throws', () => {
  const items = [{ description: 'A', total: -5, qbo_account_id: '1' }];
  assert.throws(() => buildPurchaseUpdateLines(existing, items), /negative/);
});

test('explicit expectedTotal overrides existing.TotalAmt', () => {
  // existing says 16.36 but caller asserts the real total is 10.00
  const items = [{ description: 'A', total: 10.0, qbo_account_id: '1' }];
  const lines = buildPurchaseUpdateLines(existing, items, 10.0);
  assert.equal(lines.length, 1);
});

test('recovers an already-$0 transaction: good lines, existing total $0 → passes', () => {
  // target skipped (existing TotalAmt 0), zero-sum guard passes since lines > 0
  const corrupt = { Id: '3', TotalAmt: '0' };
  const items = [{ description: 'A', total: 16.36, qbo_account_id: '1' }];
  const lines = buildPurchaseUpdateLines(corrupt, items);
  assert.equal(lines[0].Amount, 16.36);
});

test('empty items array → throws', () => {
  assert.throws(() => buildPurchaseUpdateLines(existing, []), /no line items/);
});

test('class ref is passed through when present', () => {
  const items = [{ description: 'A', total: 16.36, qbo_account_id: '1', qbo_class_id: '55' }];
  const lines = buildPurchaseUpdateLines(existing, items);
  assert.equal(lines[0].AccountBasedExpenseLineDetail.ClassRef.value, '55');
});

// ── gateway guard (assertSafeQboLineWrite) ──────────────────────────────────
test('gateway: valid purchase write passes', () => {
  assert.doesNotThrow(() => assertSafeQboLineWrite('purchase', { Line: [{ Amount: 10 }, { Amount: 5 }] }));
});

test('gateway: purchase with a $0-summing Line[] is refused', () => {
  assert.throws(() => assertSafeQboLineWrite('purchase', { Line: [{ Amount: 0 }] }), /wipe a \$0/);
});

test('gateway: purchase with a non-numeric line amount is refused', () => {
  assert.throws(() => assertSafeQboLineWrite('purchase', { Line: [{ Amount: null }, { Amount: 5 }] }), /non-numeric/);
});

test('gateway: invoice is also guarded', () => {
  assert.throws(() => assertSafeQboLineWrite('invoice', { Line: [{ Amount: 0 }] }), /wipe a \$0/);
});

test('gateway: non-transaction entities (vendor/account) are not restricted', () => {
  assert.doesNotThrow(() => assertSafeQboLineWrite('vendor', { DisplayName: 'X' }));
  assert.doesNotThrow(() => assertSafeQboLineWrite('account', { Name: 'Y' }));
});

test('gateway: metadata-only update with no Line[] is allowed', () => {
  assert.doesNotThrow(() => assertSafeQboLineWrite('purchase', { Id: '5', PrivateNote: 'memo' }));
});
