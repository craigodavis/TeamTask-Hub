# Kindred AI — access tiers

Status: **design, nothing built.** Companion to `PERMISSIONS.md`, which this
resolves the OPEN question in.

## Why now

`ai.use` today means a natural-language reader over the entire database. That
was tolerable while only managers and the owner held it. Giving it to eleven
crew members changes what it is: the thing standing between staff and payroll.

### The current guard will not carry that weight

`aiSqlPolicy()` in `routes/square.js` blocks non-managers by **searching the
generated SQL text** for table and column names — `wage_hourly_rate`,
`team_square.shift`, `v_labor`, and so on — and separately caps sales queries
at seven days.

It is evadable by a view, a CTE, an alias, `SELECT *`, quoted identifiers, or
deriving the same figure from a table nobody thought to list. That is fine for
nudging a model; it is not a boundary.

**Prompt rules and SQL string matching are UX. The database is enforcement.**
Crew queries should run as a restricted Postgres role holding `SELECT` on
exactly the views they may read. Then "can they see wages?" is answered by a
`GRANT`, not by whether we anticipated every spelling. Everything below assumes
that substrate.

## Three tiers

| | `ai.use` | `ai.manage` | `ai.full` |
|---|---|---|---|
| Who | crew | managers | owner |
| Wages, hours, tips, timeclock, per-person labour | no | **no** | yes |
| Aggregate labour cost and labour % | no | **yes** | yes |
| Revenue, margin, volumes | no | yes | yes |
| Cost of goods, vendor and invoice pricing | no | yes | yes |
| List price of a wine | yes | yes | yes |
| Customer/club rows returned | ≤ 10 | uncapped | uncapped |
| Customer and staff email | no | yes | yes |
| Customer and staff phone | yes | yes | yes |
| `save_fact` | no | yes | yes |
| `describe_tables` | allowlisted views only | full | full |
| Knowledge base | internal-only facts | all | all |

`ai.manage` seeing no wage data for anybody is a **deliberate reduction** from
today, where managers are unrestricted. Four people are affected: Elaine,
Elisha, Jack and Macy. Payroll becomes the owner's alone.

### Labour % is not a wage — SETTLED

`ai.manage` keeps aggregate labour cost and labour %, and loses anything
per-person. "What was labour % on Saturday?" is how a manager decides whether
to send someone home, and it is what the emailed reports are built on
(`v_labor_pct_daily`, see `project_labor_pct_definition`). "What does Elisha
earn?" is payroll and belongs to the owner.

The split is therefore **identifiable individual, not topic** — the same line
drawn for customers below. In practice that means granting `ai.manage` the
aggregate views while withholding `team_square.shift`,
`team_member_job_assignment` and any per-person row of `v_labor_daily`. A
grouped query that returns one row per employee is still per-person, however
it is spelled, which is another reason the grant has to live in the database
rather than in a pattern match.

## The three rules, expressed durably

### Past announcements, read and search

New `announcements.read` in the member preset; `announcements.manage` stays
manager-only for authoring. The list and search endpoints already carry no role
gate — what is missing is an archive view, since staff currently only see
unread items on the task screen.

Open: does an archive show announcements targeted at other locations or roles?
A feed hides that targeting; an archive reveals it.

### "No pricing" is really "no revenue" — SETTLED

List price is fine at every tier: it is on the menu, the website, and the POS
the crew read all day. The line is **list price yes, money-in-aggregate no** —
revenue, margin, volumes sold, discounting, club economics.

### "No lists over 10" is a row cap, not an instruction

Asking the model to write `LIMIT 10` is asking it to police itself. Enforce it
on the result set: when returned rows carry customer identity, truncate at ten
and say so plainly.

The rule is about **identity, not topic**. "How many club members do we have?"
is one number and fine. "List them" is not. Aggregates stay open; rows about
named people do not.

### Crew and the wine club: their own members, not the club

Crew may ask about the members **they personally signed up**:

- how many they have signed up, and over what period
- which of theirs have cancelled, and when
- when one of theirs was last in
- that member's club tier, status, and how long they have been in

Club-wide figures are declined: total membership, overall churn, club revenue
or economics, the full roster, and anybody else's signups. The test is the same
one used everywhere else — **your own rows yes, the aggregate no** — with the
ten-row cap still applying to any list.

This is a retention tool, and it only works if someone can see the people they
brought in. It is also the strongest argument for getting the identity link
right, because the failure mode is showing a crew member somebody else's book.

#### The attribution is real but the join is not — BLOCKER

`public.customers.salesassociate` is populated, and the useful columns are all
there: `signupdate`, `canceldate`, `cancellationreason`, `lastactivitydate`,
`status` (586 Cancelled, 20 On Hold), `currentclubtitle`, `daysinclub`.

But it is a **free-text name typed at signup**, not an identity. Of 26 distinct
values only 6 match a TeamHub `display_name` exactly. The rest are past staff,
plus the kind of variation free text always produces:

| In Commerce7 | Problem |
|---|---|
| `Amy howdyshell` | case differs from `Amy Howdyshell` — she would see none of her own |
| `Craig Davis` **and** `Craig O Davis` | one person, two names, count silently split |
| `Talon Sudbeck` **and** `Talon Sudbexk` | typo, 30 members orphaned from 146 |
| `Alicia` | first name only |
| `alicevinson13@gmail.com` | an email address in the name field |

Matching on `display_name` therefore fails two ways at once: a crew member is
told they have signed up nobody, or — if two people ever share a name — is
shown somebody else's members. Neither is acceptable for a feature whose whole
purpose is "these are mine".

#### The deeper problem: the attribution lives on stale data

`public.customers` is a **one-off export, frozen at 2026-03-14** — 1,541 rows,
five months old, and nothing refreshes it. It is also the only place
`salesassociate` exists.

The live table is `commerce7.customers`: synced today, 3,704 customers, 749
holding clubs, with a `clubs` jsonb carrying `status`, `signupDate`,
`cancelDate`, `clubTitle` and `clubMembershipId` — everything the feature needs
**except who signed them up**.

So the two halves are in different places:

| | attribution | club status | current |
|---|---|---|---|
| `public.customers` | yes | yes | **no — March** |
| `commerce7.customers` | **no** | yes | yes, daily |

Tidying the spellings in the export therefore buys correctly-named answers
drawn from five-month-old data. A crew member asks how many they have signed
up and is told twelve when it is twenty; asks which of theirs cancelled and
hears nothing about anyone who left since March; asks when a member was last in
and gets a date frozen in spring. Confidently wrong is worse than absent,
especially for a retention tool whose whole job is to prompt a follow-up.

**The durable fix is to carry the associate through the live sync.** Commerce7
records a sales associate on the club membership; `commerce7Sync.js` does not
currently capture it. Once it does, attribution and status arrive together,
daily, and the export can be retired rather than repaired.

#### On rewriting the names in place

Safe, but not what I would do.

Safe because nothing writes `public.customers` back to Commerce7 — the sync
writes `commerce7.customers`, a different table — so there is no path for a
corrected name to reach the storefront. The concern is already structurally
satisfied rather than resting on anyone remembering.

Not what I would do because an in-place `UPDATE` destroys the original value.
The typed string is the evidence of what actually happened at signup; once
`Talon Sudbexk` becomes `Talon Sudbeck` there is no way to audit the merge or
undo it if it was wrong. And it fixes only the six names that map to current
staff, leaving the majority — Becky, Nikolette, Alicia, Erin, Josiah and the
rest, all former staff with no username to match — exactly as they were.

Prefer a **mapping table**: alias text to TeamHub user, many aliases per user,
with an explicit "former staff, no current user" outcome so their members are
attributed to nobody rather than silently to whoever shares a first name. It
survives a re-import, it is reversible, it is auditable, and it cannot travel
back to Commerce7 because it never touches a synced column.

**This needs a real link before the feature can ship.** `club_steward.users`
already has `c7_associate_number`, which is the right shape. The fix is a
mapping from a TeamHub user to the `salesassociate` values they own — one user
to many strings, since the historical spellings have to keep resolving — owned
by the owner and edited in the same place as permissions. Fuzzy-matching names
at query time is not a substitute; it makes the leak intermittent rather than
absent.

Also on that table: `email` must stay hidden per the rule below, and
`lifetimevalue` is revenue and belongs with the aggregates crew do not see —
even for their own member.

### Phone yes, email no

Right instinct, and the harder half is customers rather than staff. A phone
number is operational — you ring someone about their pickup. An email list is
the asset a departing employee walks out with. The rule should cover customer
email as much as staff email.

## What else to restrict

**The knowledge base, which is the leak nobody expects.** All 30 facts are
injected into *every* prompt. They currently include the unreleased Fall 2026
release plan, its incentive structure, club economics, and a customer
conversion analysis naming Gina Ramani as the top visitor. Ship crew AI as it
stands and every crew member gets that in the system prompt of every question.
Facts need an audience flag — internal vs management — before this goes out.

**`save_fact`.** AiRon can write permanent facts that every future chat, for
every user, then reads. A crew member could poison shared business knowledge,
accidentally or otherwise. Manager and above.

**Scheduled reports, when they exist.** Not built — they are specced in
`PERMISSIONS.md` as two AiRon tools. When they land, a crew member scheduling a
nightly SMS of something they may see once is a slow export. Scope them to the
data the asker can reach, and keep creation off `ai.use`.

**Cost, which is more sensitive than price.** Sysco invoices, COGS, vendor
pricing and bottle costs. What a bottle sells for is public; what it costs is
not.

**Employee data beyond wages** — home address, date of birth, emergency
contacts, PIN and password hashes, shift feedback, anything disciplinary. Just
as personal as pay and absent from today's blocklist.

**Cross-employee comparison.** Even with wages gone, "who sold the most", "who
has the fewest hours", "whose drawer came up short" turns AiRon into a tool for
grading colleagues. Decide deliberately whether crew may ask about anyone but
themselves.

**Credentials and infrastructure** — `company_integrations`, `service_tokens`,
API keys, and `user_capabilities` itself. Reading who holds what is
reconnaissance for asking to be granted it.

**Schema reconnaissance.** `describe_tables` and the schema index currently
expose ten schemas including payroll. The allowlist should shape what crew can
see *exists*, not only what they can query.

**Bulk export in any form** — CSV, "give me all", pagination loops. A ten-row
cap means nothing if it can be walked ten at a time. Cap the session, not just
the query.

**Web search.** AiRon holds `web_search` and `web_fetch`. That is
company-attributed browsing by eleven more people. Probably fine — but a
decision, not a side effect.

## Decisions needed

1. Do crew see announcements targeted at other locations or roles?
2. May crew ask about colleagues at all, or only themselves?
3. Does the restricted Postgres role get built now, or does crew AI wait for it?
4. Who owns the associate-to-user mapping, and does someone reconcile the
   historical spellings once, or do orphaned signups stay orphaned?

Question 3 decides whether this is a security feature or a politeness.
Question 4 decides whether the club piece works at all.

Settled: aggregate labour % stays with `ai.manage`; list price is fine at every
tier; crew see their own club signups but no club aggregate.
