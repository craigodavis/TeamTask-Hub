# Permissions — roles, capabilities, and the grant matrix

Status: **spec, not yet built.** Decisions below are settled unless marked OPEN.

## Why

Today a person holds one flat `role` string and the backend hardcodes what that
string may do — 57 `requireManager` checks and 62 owner checks scattered across
the routes. Consequences:

- Adding a capability means editing middleware and redeploying, which is why the
  `schedule` and `gc` roles exist in code and are held by **nobody**: they were
  designed and never became grantable.
- The role picker offers only *User* and *Manager*. The two `inventory` users
  had to be set directly in the database.
- There is no way to express "wine club and marketing, yes; payroll, no", so
  Elaine is a full `manager` and can see labor, hours and debt.

## Model

A person holds a **role** (a named preset) and a **set of capability grants**.

Picking a role **stamps** its capabilities onto the person. The grants are then
theirs, and editing the role definition later does **not** retroactively change
anyone — no surprise mass-changes, and the checkboxes on screen are always the
truth. The role name is remembered, and the person is badged **Customized** once
their grants diverge from it.

Roles: `member`, `marketing`, `manager`, `admin`, `owner`.

`owner` alone may change roles and grants, billing, company settings, and
integration credentials. `admin` gets everything operational.

### Parent menus are derived, never granted

Kitchen, Wine, Marketing and Tasting Room are containers — headers with no page
behind them. A container appears whenever the person holds **any** child in it.
So granting `marketing.campaigns` alone makes Marketing appear containing only
Campaigns. There is no checkbox for a container, because there is nothing to
protect and a container checkbox can only create the failure mode where a
granted child is invisible.

### Grants must bind the server, not the sidebar

The sidebar is cosmetic. `/food/ingredients` is hidden from members today and
still reachable by typing the URL. Every capability below is therefore a
server-side check on the route that serves it; the menu merely reflects it. A
matrix that only hides menu items is security theatre and is explicitly not what
this builds.

## Capabilities

Named `area.thing`. A member holds only the four marked ★.

| Capability | Menu | Today's gate |
|---|---|---|
| `tasks.own` ★ | Tasks | everyone |
| `policies.read` ★ | Policies | everyone |
| `crew.profile` ★ | The Crew | everyone (staff edit their own website profile) |
| `kitchen.shopping` ★ | Kitchen ▸ Shopping | everyone (members land on Food Waste) |
| `dashboard.view` | Dashboard | manager |
| `tasks.manage` | Tasks ▸ Manage Tasks | manager |
| `announcements.manage` | Announcements | manager |
| `scheduling.manage` | Scheduling | `schedule`, manager |
| `ai.use` | Kindred AI | manager |
| `kindredapp.manage` | Kindred App | manager |
| `skynet.view` | Skynet | manager |
| `marketing.events` | Marketing ▸ Events | `schedule`, manager |
| `marketing.campaigns` | Marketing ▸ Campaigns | manager |
| `marketing.media` | Marketing ▸ Media Library | manager |
| `marketing.hours` | Marketing ▸ Store Hours | manager |
| `marketing.loyalty` | Marketing ▸ Loyalty | manager |
| `marketing.website` | Marketing ▸ Website Settings | manager |
| `kitchen.receipts.scan` | Kitchen ▸ Scan Receipt | manager |
| `kitchen.receipts` | Kitchen ▸ Receipts | manager |
| `kitchen.receipt_sources` | Kitchen ▸ Receipt Sources | **owner** |
| `kitchen.catalog` | Kitchen ▸ Item Catalog | manager |
| `kitchen.ingredients` | Kitchen ▸ Ingredients | manager |
| `kitchen.inventory` | Kitchen ▸ Inventory | `inventory`, manager |
| `kitchen.recipes` | Kitchen ▸ Recipes | manager |
| `tastingroom.menus` | Tasting Room ▸ Menus | manager |
| `tastingroom.reservations` | Tasting Room ▸ Reservations | manager |
| `wine.lines` | Wine ▸ Product Lines | manager |
| `wine.products` | Wine ▸ Products | manager |
| `wine.inventory` | Wine ▸ Inventory | `inventory`, manager |
| `wine.reports` | Wine ▸ Reports | `inventory`, manager |
| `betty.use` | Betty Bookkeeper | manager |
| `gateway.use` | Gateway | manager |
| `groundcontrol.use` | Ground Control | `gc`, manager |
| `reports.scheduled` | Reports ▸ Scheduled reports | manager |
| `reports.operational` | Reports ▸ Food waste, Tasks, Debt, AI usage | manager |
| `sms.send` | SMS Send | manager |
| `users.manage` | Settings ▸ Users, role assignment | owner |

## Presets

- **member** — the four ★ only.
- **marketing** — member, plus `marketing.*` (events, campaigns, media, hours,
  loyalty, website), `announcements.manage`, `kindredapp.manage`, `ai.use`,
  `reports.scheduled`. Deliberately excludes `reports.operational`, `betty.use`,
  `gateway.use`, `groundcontrol.use`, and everything under Wine and Kitchen.

  Nobody holds this at launch. It exists to be granted when someone should own
  wine club and marketing without the rest of a manager's reach.
- **manager** — everything except owner-only (`kitchen.receipt_sources`,
  `users.manage`).
- **admin** — everything operational; same exclusions as manager.
- **owner** — everything.

## Reports

Reporting is standard for every role except `member`, but a non-manager sees
**only the Scheduled reports tab**, not Food waste / Task completion / Debt /
AI usage. That is the split between `reports.scheduled` and
`reports.operational`.

A scheduled report is visible to someone when it belongs to their role. This
needs a new column — `scheduled_reports` has no owning role today, and all four
existing reports have `created_by = NULL`, so there is nothing to filter on:

```sql
ALTER TABLE scheduled_reports ADD COLUMN owner_role varchar;  -- NULL = manager-only
```

Set from the creator's role at creation, editable afterwards by a manager. The
list filters to `owner_role = <viewer's role>` for non-managers; managers and
above see everything. The four existing reports (labor, wine volume, overtime,
rolling labor) become `owner_role = 'manager'`, which keeps them where they are.

## Kindred AI creates and deletes scheduled reports

Anyone holding `ai.use` can ask AiRon to schedule a query it just wrote — "send
me this every Monday at 8am" — and to delete a schedule. Two new tools alongside
the existing `save_fact`, following the same pattern in `routes/square.js`:

- `create_scheduled_report(name, sql_query, frequency, day_of_week, day_of_month,
  send_time, delivery_method, only_alert_if_rows)`
- `delete_scheduled_report(id)`

Rules:
- `owner_role` is stamped from the asking user's role. A marketing user's
  schedules are visible to marketing, not to everyone.
- Delete is allowed only for a report the user could see. AiRon must never
  delete another role's schedule.
- The SQL is whatever AiRon wrote, so it is bound by the same data scope the
  user has when asking — see OPEN below.
- Creating and deleting are stated back in the reply, with the resolved
  schedule in plain words ("every Monday at 8:00am, SMS"), because a scheduled
  job nobody remembers agreeing to is worse than no job.

## OPEN — Kindred AI is currently an escalation path

`ai.use` grants a natural-language reader over the whole database. AiRon builds
its own SQL against every live schema, so a `marketing` user with `ai.use` can
ask for labor, payroll or debt figures and get them — and can now schedule that
query to SMS itself on a cadence. The unchecked Payroll box would mean nothing.

**Not blocking the build.** Every user at launch is member, manager, inventory
or owner, and none of those is a scoped role, so nothing is being withheld from
anyone yet. This becomes live the first time a person is put in `marketing` —
decide it then, before that grant is made, not after.

Options:

1. **Scope AiRon's schemas by role** — a `marketing` user's schema index
   excludes labor, payroll and debt tables. Most faithful to the matrix, most
   work.
2. **Treat `ai.use` as high-trust** — only manager and above. Simplest, but a
   marketing user then has no AI, which is most of the reason to grant it.
3. **Split it** — anyone with `ai.use` may ask, but scheduling a report is
   restricted to the data areas they hold. Weakest: the data is still readable,
   just not automated.

Assumption used above: **option 1**, AiRon inherits the asking user's data
scope.

## Migration

18 users. **Nobody's access changes** — this is a pure re-plumbing, and every
person ends up able to do exactly what they can do today:

| Now | Becomes |
|---|---|
| `member` × 11 | `member` preset |
| `manager` × 4 (incl. Elaine) | `manager` preset |
| `inventory` × 2 (Tristan, Zoë) | `member` + `wine.inventory` + `kitchen.inventory`, badged Customized |
| `owner` × 1 | `owner` preset |

Elaine stays a manager. The `marketing` preset ships unused, ready to grant.

The `schedule` and `gc` roles are retired: nobody holds them, and their
capabilities (`scheduling.manage`, `groundcontrol.use`) become grants.

Ship order, so nothing breaks mid-deploy:

1. Add tables, backfill grants from today's roles, change no behaviour.
2. Convert server guards to capability checks, each one preserving today's
   outcome. Verify no user's effective access changes.
3. Ship the matrix UI.
4. Re-scope people only when you choose to — no one is re-scoped by this work.
