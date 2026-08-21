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
| Aggregate labour cost and labour % | no | **open — see below** | yes |
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

### The one to decide: labour % is not a wage

Wage *per person* and *aggregate labour cost* are different questions. "What
does Elisha earn?" is payroll. "What was labour % on Saturday?" is how a
manager decides whether to send someone home early, and it is the number the
emailed reports are built on (`v_labor_pct_daily`, and see
`project_labor_pct_definition`).

Cutting `ai.manage` off from `v_labor*` entirely removes a tool they use to run
shifts. The alternative is to allow the aggregate views while denying anything
per-person — the split being *identifiable individual* rather than *topic*.
That is more work and probably the right answer. **Needs your call.**

## The three rules, expressed durably

### Past announcements, read and search

New `announcements.read` in the member preset; `announcements.manage` stays
manager-only for authoring. The list and search endpoints already carry no role
gate — what is missing is an archive view, since staff currently only see
unread items on the task screen.

Open: does an archive show announcements targeted at other locations or roles?
A feed hides that targeting; an archive reveals it.

### "No pricing" is really "no revenue"

Retail prices are public — the menu, the website, and the POS the crew read all
day. AiRon refusing "how much is the 24 Summer Silhouette?" reads as broken.
The line is **list price yes, money-in-aggregate no**: revenue, margin, volumes
sold, discounting, club economics.

### "No lists over 10" is a row cap, not an instruction

Asking the model to write `LIMIT 10` is asking it to police itself. Enforce it
on the result set: when returned rows carry customer identity, truncate at ten
and say so plainly.

The rule is about **identity, not topic**. "How many club members do we have?"
is one number and fine. "List them" is not. Aggregates stay open; rows about
named people do not.

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

1. Does `ai.manage` keep aggregate labour % while losing per-person wages?
2. Do crew see announcements targeted at other locations or roles?
3. May crew ask about colleagues at all, or only themselves?
4. Does the restricted Postgres role get built now, or does crew AI wait for it?

Question 4 is the one that decides whether this is a security feature or a
politeness. Everything else is scope.
