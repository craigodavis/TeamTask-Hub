/**
 * The email-list gateway: one subscriber in, both mailing platforms updated.
 *
 * ClubSteward owns the club member; TeamHub owns Listmonk and Campaign Monitor.
 * So ClubSteward's fan-out (admin/server/lib/clubMemberSync.js) posts a person
 * here on add or name/email change and stays out of the mailing platforms
 * entirely — which list an audience belongs on is a decision that lives here,
 * next to the campaign composer that will use it, and nowhere else.
 *
 * Distinct from newsletterSubscribe.js, which is the *website signup* path: a
 * stranger typing their address into a form, which is fresh consent. This is a
 * sync of people we already have, and the difference matters — see "Consent"
 * below. Both share the same two platform clients.
 *
 * Rules, in order of importance:
 *
 *  - Upsert, never duplicate. Every call is treated as an upsert, because
 *    ClubSteward may legitimately send the same person twice and a retry must
 *    not create a second subscriber.
 *  - A previous unsubscribe is never undone here. See "Consent".
 *  - The platforms are independent: Campaign Monitor being down must not stop
 *    Listmonk receiving the person, and vice versa.
 *  - An unconfigured platform is skipped, not failed — during the Campaign
 *    Monitor migration exactly one of them may be set, and that is normal.
 *  - Nothing throws for a platform problem. The caller gets a per-platform
 *    result it can log, because ClubSteward writes every result to sync_log and
 *    a failure that reads as success is worse than no sync at all.
 *
 * Consent. This endpoint never sets Resubscribe / lifts a blocklist, even for
 * `change: "created"`. Joining the wine club is not a marketing opt-in, and the
 * one time this system did treat a record-level event as consent — the old
 * ResOS sync sending Campaign Monitor `Resubscribe: true` for every guest who
 * booked a table — it silently reversed people's opt-outs and is a likely
 * source of the 61 spam complaints now held back from re-subscription. A
 * suppressed person is reported as `suppressed` so a human can see it and
 * decide, rather than being quietly re-added or quietly dropped.
 */

import {
  listmonkConfigured, listmonkListId, addSubscriber, findSubscriber,
  findSubscriberByAttrib, updateSubscriber, addToLists,
} from './listmonk.js';
import {
  cmConfigured, cmListId, addCmSubscriber, updateCmSubscriber, isCmSuppression,
} from './campaignMonitor.js';

/**
 * Which list each audience lands on, per platform.
 *
 * Held by name, not id: a name survives a list being rebuilt, and it is what
 * whoever sends the campaign goes looking for. Either value may be overridden
 * with an id via the env vars named below — `LISTMONK_LIST_CLUB_MEMBER` /
 * `CM_LIST_CLUB_MEMBER` — for pinning to an existing list without renaming it.
 *
 * A listmonk list is created if missing; so is a Campaign Monitor one. That is
 * deliberate — a misconfigured destination should be an obviously-empty new
 * list somebody notices, not a silent write into whatever list happened to
 * match.
 */
export const AUDIENCES = {
  'club-member': { listmonk: 'Wine Club', campaignMonitor: 'Wine Club' },
};

export const isKnownAudience = (a) => Object.hasOwn(AUDIENCES, String(a));

/** `club-member` → `CLUB_MEMBER`, so one env convention covers future audiences. */
const envKey = (audience) => String(audience).toUpperCase().replace(/[^A-Z0-9]+/g, '_');

function audienceLists(audience) {
  const def = AUDIENCES[audience];
  const key = envKey(audience);
  return {
    listmonk: process.env[`LISTMONK_LIST_${key}`] || def.listmonk,
    campaignMonitor: process.env[`CM_LIST_${key}`] || def.campaignMonitor,
  };
}

/**
 * The Commerce7 id is stamped on the listmonk subscriber so a person survives
 * changing their address. Without it an email change is indistinguishable from
 * a new person, and the old address stays on the list forever.
 */
const C7_ATTRIB = 'commerce7_customer_id';

/** Every subscriber carries where they came from; a sync adds to that, never replaces it. */
function mergeAttribs(existing, { audience, commerce7CustomerId }) {
  const a = { ...(existing?.attribs || {}) };
  if (commerce7CustomerId) a[C7_ATTRIB] = String(commerce7CustomerId);
  const sources = new Set(
    Array.isArray(a.sources) ? a.sources : (a.sources ? [String(a.sources)] : []),
  );
  sources.add(audience);
  a.sources = [...sources];
  return a;
}

/** listmonk lowercases addresses on write; match that before looking one up. */
export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/** A display name from the parts ClubSteward sends, falling back the way listmonk does. */
export const displayName = (firstName, lastName, email) =>
  [firstName, lastName].filter(Boolean).join(' ').trim() || normalizeEmail(email).split('@')[0];

const suppressionReason = (sub) =>
  String(sub?.attribs?.reason || sub?.attribs?.suppressed_by || '') || 'unsubscribed';

/* ------------------------------------------------------------------ listmonk */

async function toListmonk({ email, name, audience, commerce7CustomerId, listName }, lm) {
  if (!lm.listmonkConfigured()) return { status: 'not configured', id: null };
  const listId = await lm.listmonkListId(listName);

  let existing = await lm.findSubscriber(email);
  let renamedFrom = null;

  // Not found by address, but we may still know this person: an email change
  // arrives as an address we have never seen attached to a Commerce7 id we have.
  if (!existing && commerce7CustomerId) {
    existing = await lm.findSubscriberByAttrib(C7_ATTRIB, String(commerce7CustomerId));
    if (existing) renamedFrom = existing.email;
  }

  if (!existing) {
    const created = await lm.addSubscriber({
      email,
      name,
      status: 'enabled',
      lists: [listId],
      // Our lists are single opt-in; a confirmation email would ask a question
      // this person already answered by joining the club.
      preconfirm_subscriptions: true,
      attribs: mergeAttribs(null, { audience, commerce7CustomerId }),
    });
    return { status: 'created', id: created?.id ?? null };
  }

  // They asked us to stop. A club record changing is not them asking us to start.
  if (existing.status === 'blocklisted') {
    return { status: 'suppressed', id: existing.id, reason: suppressionReason(existing) };
  }

  const attribs = mergeAttribs(existing, { audience, commerce7CustomerId });
  const attribsChanged = JSON.stringify(attribs) !== JSON.stringify(existing.attribs || {});
  const needsWrite = existing.email !== email
    || (name && existing.name !== name)
    || attribsChanged;

  if (!needsWrite) {
    // Nothing about the person changed, but they may not be on this list yet —
    // and stopping short here is exactly the bug that left everyone we already
    // had off the list they had just joined, while every counter said success.
    await lm.addToLists([existing.id], [listId]);
    return { status: 'already', id: existing.id };
  }

  // PUT replaces the record, so everything that must survive is sent back with
  // it: the existing list subscriptions (dropping them would silently
  // unsubscribe someone from lists this call has no business touching) and the
  // existing attribs (which hold the suppression history).
  const lists = [...new Set([...(existing.lists || []).map((l) => l.id), listId])];
  await lm.updateSubscriber(existing.id, {
    email,
    name: name || existing.name,
    status: existing.status,
    lists,
    preconfirm_subscriptions: true,
    attribs,
  });
  return {
    status: renamedFrom ? 'renamed' : 'updated',
    id: existing.id,
    ...(renamedFrom ? { renamedFrom } : {}),
  };
}

/* ---------------------------------------------------------- campaign monitor */

async function toCampaignMonitor({ email, name, previousEmail, listName }, cmc) {
  if (!cmc.cmConfigured()) return 'not configured';
  const listId = await cmc.cmListId(listName);

  try {
    // Campaign Monitor keys subscribers by address and has nowhere to keep a
    // Commerce7 id, so a changed address can only be followed if the caller
    // says what it used to be. ClubSteward does not send that today; when it
    // does, this path renames instead of leaving the old address on the list.
    if (previousEmail && previousEmail !== email) {
      try {
        await cmc.updateCmSubscriber({ listId, oldEmail: previousEmail, email, name });
        return 'renamed';
      } catch (e) {
        // The old address was never on this list — nothing to rename, so add.
        if (!/not\s*found|not in|does not exist|\b404\b/i.test(e.message)) throw e;
      }
    }
    // Campaign Monitor's add endpoint is an upsert: an address already on the
    // list has its name updated rather than being duplicated.
    await cmc.addCmSubscriber({ listId, email, name });
    return 'ok';
  } catch (e) {
    if (cmc.isCmSuppression(e)) return 'suppressed';
    throw e;
  }
}

/* ------------------------------------------------------------------ fan-out */

const DEFAULT_DEPS = {
  listmonkConfigured, listmonkListId, addSubscriber, findSubscriber,
  findSubscriberByAttrib, updateSubscriber, addToLists,
  cmConfigured, cmListId, addCmSubscriber, updateCmSubscriber, isCmSuppression,
};

/**
 * Upsert one person into every configured mailing platform. Never throws.
 *
 * @param {object} input
 * @param {string} input.email
 * @param {string} [input.firstName]
 * @param {string} [input.lastName]
 * @param {string} input.audience          a key of AUDIENCES
 * @param {string} [input.commerce7CustomerId]
 * @param {string} [input.change]          'created' | 'email' | 'name' — logged,
 *   not branched on. Every call is an upsert, so the endpoint stays correct if
 *   ClubSteward's change detection is ever wrong or a call is retried.
 * @param {string} [input.previousEmail]   optional; lets Campaign Monitor follow
 *   an address change instead of leaving the old one on the list.
 * @param {object} [deps]                  platform clients, injectable for tests
 * @returns {Promise<{ok, listmonkId, listmonkResult, cmResult, ...}>}
 */
export async function syncSubscriber(input, deps = DEFAULT_DEPS) {
  const email = normalizeEmail(input.email);
  const previousEmail = normalizeEmail(input.previousEmail) || null;
  const audience = String(input.audience);
  const name = displayName(input.firstName, input.lastName, email);
  const lists = audienceLists(audience);
  const commerce7CustomerId = input.commerce7CustomerId != null
    ? String(input.commerce7CustomerId) : null;

  const args = { email, name, audience, commerce7CustomerId, previousEmail };

  const [listmonk, cmResult] = await Promise.all([
    toListmonk({ ...args, listName: lists.listmonk }, deps)
      .catch((e) => {
        // Say who: the club member is already saved on ClubSteward's side, so
        // this is recoverable by hand — but only if the address is in the log.
        console.error(`[subscriber-gateway] listmonk failed for ${email}:`, e.message);
        return { status: `failed: ${e.message.slice(0, 160)}`, id: null, failed: true };
      }),
    toCampaignMonitor({ ...args, listName: lists.campaignMonitor }, deps)
      .catch((e) => {
        console.error(`[subscriber-gateway] Campaign Monitor failed for ${email}:`, e.message);
        return `failed: ${e.message.slice(0, 160)}`;
      }),
  ]);

  if (listmonk.status === 'suppressed' || cmResult === 'suppressed') {
    // Someone whose club record changed is on a suppression list. Not an error
    // and not something to undo automatically, but somebody should know.
    console.warn(
      `[subscriber-gateway] ${email} is suppressed — not added to "${lists.listmonk}"`
      + (listmonk.reason ? ` (${listmonk.reason})` : ''),
    );
  }

  return {
    ok: !listmonk.failed && !String(cmResult).startsWith('failed:'),
    listmonkId: listmonk.id,
    listmonkResult: listmonk.status,
    cmResult,
    audience,
    email,
    change: input.change ?? null,
    ...(listmonk.renamedFrom ? { renamedFrom: listmonk.renamedFrom } : {}),
  };
}
