# Product Data Architecture

TeamHub as the master product record, pushing to Commerce7, Square and Vinoshipper.
Design only — no migration written yet.

## The problem, measured

`product.products` today is a flat 1:1 mirror of Commerce7: 104 rows, one per vintage,
84 of them wine. Everything that is true of a *wine* rather than a *vintage of a wine*
is duplicated on every row, and therefore filled in inconsistently:

| Field | Wine rows missing it (of 84) |
|---|---:|
| `alcohol_pct` | **84 — all of them** |
| `description` | 70 |
| `appellation` | 25 |
| `wine_style` | 18 |
| `varietal` | 16 |

Nobody is going to retype the Snake River Valley appellation and the winemaker notes
on every new vintage forever, so they don't. That is the whole argument for the split.

`alcohol_pct` being empty on all 84 matters beyond tidiness: ABV is required on the
TTB label and on the ABC filing.

## Three levels

```
product_lines      "Summer Silhouette"        — the wine, forever
  └── products     "23 Summer Silhouette"     — one vintage of it
        └── product_variants  750ml / 1.5L    — a sellable unit, has the SKU and price
```

### `product_lines` (new, TeamHub only)

Never leaves TeamHub. Not pushed anywhere — it exists so the vintage rows can inherit
from it. Its SKU is the product SKU minus the vintage prefix and hyphen.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | pk |
| `company_id` | uuid | |
| `name` | varchar | "Summer Silhouette" — no vintage |
| `sku_base` | varchar | `summer-silhouette`, lowercase, hyphens. **Required, unique per company** |
| `upc` | varchar | **Required for wine.** Vintage-agnostic |
| `ttb_label_id` | varchar | **Required for wine.** From Vinoshipper. Vintage-agnostic — see note |
| `product_type` | varchar | Wine / Reservation / General Merchandise / Event Ticket |
| `varietal` | varchar | from Vintly varietals |
| `origin_project` | varchar | new field, per your note |
| `wine_style` | varchar | Red / White / Rosé / Sparkling |
| `appellation` | varchar | from the Vintly vineyard record |
| `region` | varchar | from the Vintly vineyard record |
| `country` | varchar | from the Vintly vineyard record |
| `description` | text | the long marketing copy |
| `teaser` | text | from `c7_products` |
| `winemaker_notes` | text | from `c7_products` |
| `food_pairings` | text[] | from `c7_products` |
| `images` | jsonb | bottle shot rarely changes by vintage |
| `seo_title` / `seo_description` | varchar / text | |
| `tags` | text[] | |
| `club_eligible` | boolean | |
| `is_archived` | boolean | discontinued line (11 Sails) |
| `display_order` | integer | |
| `created_at` / `updated_at` / `created_by` / `updated_by` | | |

### `products` — what changes

Stays vintage-level. **Moves out** to `product_lines`: `varietal`, `wine_style`,
`appellation`, `region`, `country`, `description`, `images`, `product_type`, and the
whole marketing half of `c7_products`.

**Stays**, because it genuinely varies by vintage:

| Column | Why |
|---|---|
| `product_line_id` | **new fk** |
| `vintage` | |
| `alcohol_pct` | varies by vintage — needs populating, currently 100% null |
| `residual_sugar` | varies by vintage |
| `awards` | won by a specific vintage (Peacemaker's Double Gold) |
| `internal_notes` | |
| `is_available`, `is_archived` | this vintage sold out ≠ line discontinued |

### `product_variants` — what changes

Unchanged in shape. `sku` stays here because it carries the vintage: `23-summer-silhouette`
= line `sku_base` + vintage prefix. Keep `price_cents` here (see open decision).

### `product_channels` (new)

Solves the "24 Pinot is a club release before it hits Square" problem. One row per
variant per channel.

| Column | Type | Notes |
|---|---|---|
| `variant_id` | uuid | fk |
| `channel` | varchar | `commerce7` / `square` / `vinoshipper` |
| `is_published` | boolean | push only when true |
| `publish_at` | timestamptz | optional scheduled release |
| `external_id` | varchar | that channel's own id, for updates |
| `price_cents_override` | integer | nullable — channel-specific price if ever needed |
| `last_pushed_at` | timestamptz | |
| `last_push_error` | text | |

Without this, "master record pushes everywhere" means every new wine appears in Square
the moment it's created, which you explicitly don't want.

## Glass pours, tasting wines, and menu generation

Requested 2026-08-04. Square currently owns glass pours as *separate items*
("23 Glass Gypsy Soul"), disconnected from the bottle. They move into TeamHub as
variants of the same product.

### Glass as a variant, not a product

`product_variants.volume_format` already exists — use it. A wine gets up to three rows:

| volume_format | price_tier | SKU | Example |
|---|---|---|---|
| `750ml` | retail | `<vv>-<name>` | `23-gypsy-soul` |
| `750ml` | wholesale | `<vv>-<name>-w` | `23-gypsy-soul-w` |
| `glass` | retail | `<vv>-glass-<name>` | `23-glass-gypsy-soul` |

This means variants now vary on two axes — **format** (bottle/glass) and **channel**
(retail/wholesale) — so `price_tier` belongs on the variant, not only the line.

**Glass defaults to `is_available = false`.** Not every wine can be poured; opening a
bottle for a pour is a decision, not a default. Creating a wine creates the glass row
unavailable, and someone turns it on deliberately.

**Glass price defaults to ¼ of the bottle price**, overridable per variant.

> ⚠ The ¼ default does not match current pricing. Today's pours run about **⅓**:
> $13 glass on a $36 bottle (36%), $9 on $26 (35%), $15 on $45 (33%). A ¼ default would
> generate $9.00 where the approved menu says $13.00, and $6.50 where it says $9.00 —
> roughly a 30% cut. Fine as a starting number that gets overridden, wrong as a rule.
> Confirm which is intended before the default is used to price anything real.

### Tasting wines — needs history, not a boolean

The ask is to designate tasting wines so we can "track a history of sales versus
tasting menu". A boolean on the product cannot do that: the moment the flight lineup
changes, the past is gone. Gypsy Soul was pulled from the flight on 2026-08-01 — with a
flag we'd no longer be able to say it was ever on it, which is exactly the comparison
being asked for.

Use an effective-dated table instead:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | pk |
| `product_id` | uuid | fk |
| `started_on` | date | when it joined the flight |
| `ended_on` | date | null = currently on the flight |
| `note` | text | why it was added or pulled |

"On the tasting menu today" is `ended_on IS NULL`. "Was it on the menu when this sale
happened" is a date-range join — which is what makes the sales-vs-tasting comparison
possible. See [[project-tasting-flight-experiment]].

### Menu generation

Template: `Wine Menu 080426.docx`. Structure to reproduce:

- **US Letter portrait**, 12240 × 15840 DXA
- **Two columns**, 5040 DXA each, 720 gutter
- Margins: 720 left/right (0.5"), 360 top/bottom (0.25"), header/footer 216
- Header + footer parts, two PNGs, embedded **Arimo** and **Roboto**
- **Tasting table**: 3 cols `[2896, 886, 1195]`; row 0 spans the fee blurb
  ("4 (2oz) tastings - $15 / Tasting fees are waived with each bottle purchase"),
  row 1 is `['', 'Glass', 'Club']`, then one row per tasting wine
- **Bottle table**: 3 cols `[3167, 914, 1171]`; section header rows
  (`['White & Rosé','Bottle','Club']`, `['Red','Bottle','Club']`) interleaved with wines
- Wine row: `"{vintage} {name} {varietal}"` | `"${price}"` | `"${club}"`
- Club price = 15% off, 2dp
- Two empty 3-col spacer tables sit between the sections

Selection rules for generation:

- **Tasting section** — products with an open `product_tasting_periods` row, glass price
- **White & Rosé / Red** — `wine_style`, bottle variant, `is_available`, stock > 0
- Excluded automatically: zero-stock wines (today that correctly drops Legacy and Estate
  Moonlit Cello) and library-only wines (11 Sails)
- Order within section: current menu runs high price → low

Generate with docx-js against these measurements rather than editing the template, so
the output is reproducible.

## Open decision — price from tier, or per variant?

The Voyager tiers (Low $36 / Mid $39 / High $45) are a pricing *policy*; `price_cents`
is a *fact about a variant*. Recommendation: add `price_tier` to `product_lines` and
keep `price_cents` on the variant, with the tier authoritative and the variant free to
override. That way a tier change reprices the portfolio in one edit, but a one-off
(library bottle, magnum, closeout) doesn't fight the model.

## Note on `ttb_label_id`

You said COLA is not per vintage and asked to be told if that's wrong — it isn't wrong
in practice here. A COLA covers a brand/label; vintage-only changes generally ride on
the existing approval. Putting it on `product_lines` is right. If a label is ever
re-approved for one vintage specifically, that's the case for a nullable
`ttb_label_id_override` on `products` — not worth building until it happens.

## Migration gotchas

- **Old SKUs are still un-normalized.** The cleanup covered live wines only. Deriving
  lines from SKU today yields 40 groups, most of them junk from legacy vintages —
  `18cabsauv`, `2019orpinot`, `2019summersilhouettesangiovese`. The real line count is
  ~16. Lines must be seeded by hand, not regex-derived.
- **`vintage` is null on many older rows**, so it can't be trusted to split name from line.
- `summer-silhouette` shows three variants all stamped 2023 — needs a look before migrating.
- `product.products` includes non-wine types. `upc` / `ttb_label_id` are required for
  wine only; enforce with a partial constraint, not `NOT NULL`.
