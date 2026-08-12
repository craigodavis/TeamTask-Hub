/**
 * Tests for the ClubSteward email-list gateway.
 *
 * The platform clients are injected, so these exercise the decisions that
 * actually matter here — dedupe, rename-instead-of-duplicate, not resurrecting
 * a suppression, not dropping other list subscriptions — without touching
 * Listmonk or Campaign Monitor.
 *
 * Run: node --test server/lib/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncSubscriber, displayName, isKnownAudience } from './subscriberGateway.js';

/** Records every call so a test can assert what the platforms were asked to do. */
function makeDeps(overrides = {}) {
  const calls = { added: [], updated: [], addedToLists: [], cmAdded: [], cmUpdated: [] };
  const deps = {
    calls,
    listmonkConfigured: () => true,
    listmonkListId: async () => 7,
    findSubscriber: async () => null,
    findSubscriberByAttrib: async () => null,
    addSubscriber: async (p) => { calls.added.push(p); return { id: 101 }; },
    updateSubscriber: async (id, p) => { calls.updated.push({ id, ...p }); },
    addToLists: async (ids, listIds) => { calls.addedToLists.push({ ids, listIds }); },
    cmConfigured: () => true,
    cmListId: async () => 'af214e69cefa40aa1deabf516759ea4e',
    addCmSubscriber: async (p) => { calls.cmAdded.push(p); },
    updateCmSubscriber: async (p) => { calls.cmUpdated.push(p); },
    isCmSuppression: (e) => /unsubscrib/i.test(e.message),
    ...overrides,
  };
  return deps;
}

const member = {
  email: 'Nina@Example.com',
  firstName: 'Nina',
  lastName: 'Vance',
  audience: 'club-member',
  commerce7CustomerId: 'c7-123',
  change: 'created',
};

test('a new club member is created on both platforms', async () => {
  const deps = makeDeps();
  const r = await syncSubscriber(member, deps);

  assert.equal(r.ok, true);
  assert.equal(r.listmonkResult, 'created');
  assert.equal(r.listmonkId, 101);
  assert.equal(r.cmResult, 'ok');

  const [added] = deps.calls.added;
  assert.equal(added.email, 'nina@example.com');   // normalised, as listmonk stores it
  assert.equal(added.name, 'Nina Vance');
  assert.deepEqual(added.lists, [7]);
  assert.equal(added.attribs.commerce7_customer_id, 'c7-123');
  assert.deepEqual(added.attribs.sources, ['club-member']);
  assert.equal(deps.calls.cmAdded[0].email, 'nina@example.com');
});

test('a repeat call for an unchanged member adds no duplicate', async () => {
  const deps = makeDeps({
    findSubscriber: async () => ({
      id: 55, email: 'nina@example.com', name: 'Nina Vance', status: 'enabled',
      lists: [{ id: 7 }], attribs: { commerce7_customer_id: 'c7-123', sources: ['club-member'] },
    }),
  });
  const r = await syncSubscriber(member, deps);

  assert.equal(r.listmonkResult, 'already');
  assert.equal(r.listmonkId, 55);
  assert.equal(deps.calls.added.length, 0);
  assert.equal(deps.calls.updated.length, 0);
  // Still asserted onto the list — being known is not the same as being on it.
  assert.deepEqual(deps.calls.addedToLists[0], { ids: [55], listIds: [7] });
});

test('a name change updates in place and keeps their other lists', async () => {
  const deps = makeDeps({
    findSubscriber: async () => ({
      id: 55, email: 'nina@example.com', name: 'Nina Marsh', status: 'enabled',
      lists: [{ id: 2 }, { id: 9 }],
      attribs: { commerce7_customer_id: 'c7-123', sources: ['club-member'], reason: 'kept' },
    }),
  });
  const r = await syncSubscriber({ ...member, change: 'name' }, deps);

  assert.equal(r.listmonkResult, 'updated');
  const [put] = deps.calls.updated;
  assert.equal(put.name, 'Nina Vance');
  assert.deepEqual(put.lists.sort(), [2, 7, 9]);   // existing kept, target added
  assert.equal(put.attribs.reason, 'kept');        // history survives the replace
  assert.equal(deps.calls.added.length, 0);
});

test('an email change follows the Commerce7 id instead of creating a second record', async () => {
  const deps = makeDeps({
    findSubscriber: async () => null,              // the new address is unknown
    findSubscriberByAttrib: async (k, v) => (
      k === 'commerce7_customer_id' && v === 'c7-123'
        ? { id: 55, email: 'old@example.com', name: 'Nina Vance', status: 'enabled', lists: [{ id: 7 }], attribs: { commerce7_customer_id: 'c7-123', sources: ['club-member'] } }
        : null
    ),
  });
  const r = await syncSubscriber({ ...member, change: 'email' }, deps);

  assert.equal(r.listmonkResult, 'renamed');
  assert.equal(r.renamedFrom, 'old@example.com');
  assert.equal(deps.calls.added.length, 0);
  assert.equal(deps.calls.updated[0].email, 'nina@example.com');
});

test('previousEmail lets Campaign Monitor rename rather than leave the old address', async () => {
  const deps = makeDeps();
  await syncSubscriber({ ...member, change: 'email', previousEmail: 'old@example.com' }, deps);

  assert.equal(deps.calls.cmUpdated[0].oldEmail, 'old@example.com');
  assert.equal(deps.calls.cmUpdated[0].email, 'nina@example.com');
  assert.equal(deps.calls.cmAdded.length, 0);
});

test('a Campaign Monitor rename for someone not on the list falls back to adding', async () => {
  const deps = makeDeps({
    updateCmSubscriber: async () => { throw new Error('400: Subscriber not in list'); },
  });
  const r = await syncSubscriber({ ...member, previousEmail: 'old@example.com' }, deps);

  assert.equal(r.cmResult, 'ok');
  assert.equal(deps.calls.cmAdded.length, 1);
});

test('a blocklisted person is reported, not resurrected', async () => {
  const deps = makeDeps({
    findSubscriber: async () => ({
      id: 55, email: 'nina@example.com', name: 'Nina Vance', status: 'blocklisted',
      lists: [], attribs: { reason: 'complaint' },
    }),
  });
  const r = await syncSubscriber(member, deps);

  assert.equal(r.listmonkResult, 'suppressed');
  assert.equal(r.ok, true);                        // not an error — a decision
  assert.equal(deps.calls.updated.length, 0);
  assert.equal(deps.calls.addedToLists.length, 0);
});

test('never sets Resubscribe — a club record changing is not fresh consent', async () => {
  const deps = makeDeps();
  await syncSubscriber(member, deps);
  assert.equal(deps.calls.cmAdded[0].resubscribe ?? false, false);
});

test('one platform failing does not stop the other, and ok goes false', async () => {
  const deps = makeDeps({
    addSubscriber: async () => { throw new Error('listmonk POST /api/subscribers -> 500'); },
  });
  const r = await syncSubscriber(member, deps);

  assert.equal(r.ok, false);
  assert.match(r.listmonkResult, /^failed:/);
  assert.equal(r.cmResult, 'ok');                  // Campaign Monitor still got them
  assert.equal(deps.calls.cmAdded.length, 1);
});

test('an unconfigured platform is skipped, not failed', async () => {
  const deps = makeDeps({ cmConfigured: () => false });
  const r = await syncSubscriber(member, deps);

  assert.equal(r.ok, true);
  assert.equal(r.cmResult, 'not configured');
  assert.equal(r.listmonkResult, 'created');
});

test('a Campaign Monitor suppression is reported rather than thrown', async () => {
  const deps = makeDeps({
    addCmSubscriber: async () => { throw new Error('400: subscriber has unsubscribed'); },
  });
  const r = await syncSubscriber(member, deps);

  assert.equal(r.cmResult, 'suppressed');
  assert.equal(r.ok, true);
});

test('a member with no name falls back to the address local part', () => {
  assert.equal(displayName(null, null, 'Nina@Example.com'), 'nina');
  assert.equal(displayName('Nina', null, 'nina@example.com'), 'Nina');
});

test('only known audiences are accepted', () => {
  assert.equal(isKnownAudience('club-member'), true);
  assert.equal(isKnownAudience('everyone'), false);
  assert.equal(isKnownAudience('toString'), false);   // not inherited from Object
});
