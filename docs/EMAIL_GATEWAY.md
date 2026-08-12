# Email-list gateway

`POST /api/email/subscriber` — the one way another system puts a person on a
Kindred mailing list.

TeamHub owns Listmonk and Campaign Monitor. Everything else (today: ClubSteward)
posts a person here and stays out of both platforms, so *which list an audience
belongs on* is decided in one place, next to the campaign composer that uses it.

## Contract

```
POST /api/email/subscriber
Header: X-Sync-Secret: <SYNC_SECRET>
Body:   { email, firstName, lastName, audience, commerce7CustomerId, change, previousEmail? }
Return: { ok, listmonkId, listmonkResult, cmResult, audience, email, change, renamedFrom? }
```

| Status | When |
|---|---|
| 200 | both configured platforms handled the person (including `suppressed`) |
| 400 | missing/invalid `email`, or an `audience` that isn't in the map |
| 401 | bad or missing `X-Sync-Secret` |
| 502 | a configured platform errored — the body says which |
| 503 | `SYNC_SECRET` is not set on this server |

`listmonkResult` is one of `created`, `updated`, `renamed`, `already`,
`suppressed`, `not configured`, `failed: …`. `cmResult` is `ok`, `renamed`,
`suppressed`, `not configured` or `failed: …`.

The 502 is deliberate: ClubSteward records the HTTP status in `sync_log` and
nothing retries, so a 200 over a failed write would leave a log claiming
somebody was subscribed when they were not.

## Audiences

| audience | Listmonk list | Campaign Monitor list |
|---|---|---|
| `club-member` | `Wine Club` | `Wine Club` |

Lists are held by **name** and created if missing — a misconfigured destination
should be an obviously-empty new list somebody notices, not a silent write into
whatever list happened to match. Override either with an id via
`LISTMONK_LIST_CLUB_MEMBER` / `CM_LIST_CLUB_MEMBER` (listmonk numeric id,
Campaign Monitor 32-hex list id). New audiences: add a key to `AUDIENCES` in
`server/lib/subscriberGateway.js`; the env-var names follow from it.

## Rules it follows

- **Upsert, never duplicate.** `change` is logged, not branched on, so a retry
  or a wrong change-detection on the caller's side cannot create a second
  subscriber.
- **A previous unsubscribe is never undone here.** This endpoint never sets
  `Resubscribe` and never lifts a blocklist, including for `change: "created"` —
  joining the wine club is not a marketing opt-in. A suppressed person comes
  back as `suppressed` and is logged, so a human decides.
- **The platforms are independent.** One being down must not stop the other
  receiving the person.
- **An unconfigured platform is skipped, not failed** — during the Campaign
  Monitor migration only one may be set, and that is normal.
- **Existing list subscriptions survive.** listmonk's `PUT` replaces the record,
  so the update path sends back the subscriber's other lists and their attribs.

## Email changes

The listmonk subscriber carries `attribs.commerce7_customer_id`. When an address
arrives that listmonk has never seen but the Commerce7 id is known, the existing
record is **renamed** rather than duplicated (`listmonkResult: "renamed"`,
`renamedFrom` in the response).

**Campaign Monitor cannot do this today.** It keys subscribers by address and
has nowhere to keep a Commerce7 id, so it can only follow a change if the caller
says what the old address was. The endpoint accepts an optional `previousEmail`
and will rename when it is present; ClubSteward does not send it yet, so until
it does, an email change leaves the old address on the Campaign Monitor list.
The one-line fix lives in ClubSteward's `clubMemberSync.js`, which already has
the old address in hand as `prior.primary_email`.

## Configuration

```
SYNC_SECRET=            # must match TEAMHUB_SYNC_SECRET in ClubSteward's env
LISTMONK_URL= LISTMONK_API_USER= LISTMONK_API_TOKEN=
CAMPAIGN_MONITOR_API_KEY=   # blank it to retire Campaign Monitor
```

While `SYNC_SECRET` is unset the endpoint refuses everything with 503. It never
falls open.

## Files

- `server/routes/emailSubscriber.js` — the endpoint: secret, validation, status codes
- `server/lib/subscriberGateway.js` — audience map and the two upserts
- `server/lib/listmonk.js`, `server/lib/campaignMonitor.js` — the platform clients
- `server/lib/newsletterSubscribe.js` — the *website signup* path, which shares
  those clients but is a different consent story: a stranger typing their address
  into a form is fresh consent, and it may lift a soft unsubscribe. This gateway
  may not.
- Tests: `node --test server/lib/subscriberGateway.test.js`
