# Shopping Module Spec

**Purpose:** Track food/supply inventory across Kindred's two locations (Winery + Creek). Staff count inventory on their phones; managers see par-level alerts and generate shopping lists. Purchase history flows in automatically via the Harvester (Amazon invoices, Costco, etc.) and is matched to catalog items.

---

## Locations
- Kindred Vineyards (Winery)
- Kindred by the Creek

---

## User Roles
- **Members/Staff** — count inventory on mobile (Inventory tab)
- **Managers/Owners** — manage catalog, par levels, view history, generate shopping lists, manage raw purchase matching

---

## Pages (under /food)

### Inventory (`/food/inventory`) — default
Mobile-first. Staff select a location, then count items.
- Large numpad entry
- Items grouped by category
- Shows current count vs par level
- Drag-to-reorder within category
- Saves on blur/confirm

### Item Catalog (`/food/catalog`) — manager only
Full item management.
- Add/edit/delete items
- Set par level per location
- Toggle `is_routine` (appears on shopping list automatically)
- Merge duplicate items
- View purchase history per item
- Extract unit/quantity from raw purchase descriptions (AI)

### Shopping List (`/food/shopping-list`) — manager only
Generated from:
1. Items where current inventory < par level
2. Routine items (`is_routine = true`)
- Grouped by category/vendor
- Exportable (TBD — print/PDF)

### Raw Purchases (`/food/raw`) — manager only
Unmatched purchase line items from Harvester imports.
- Match raw line item → catalog item
- Ignore irrelevant items
- Fuzzy match suggestions (pg_trgm)
- Sync: pull in new unmatched items from receipts

---

## Database Tables
- `shopping_items` — the catalog (name, category, unit, par levels per location)
- `shopping_item_purchases` — historical purchase records (price, qty, vendor, date)
- `shopping_item_locations` — per-location par levels and stocked flag
- `shopping_inventory` — current count per item per location
- `shopping_inventory_log` — audit log of count changes
- `shopping_item_raw` — raw unmatched purchase descriptions from Harvester
  - `fuzzy_match_id` — AI/trgm suggested match (UUID → shopping_items)
  - `similarity_score` — 0-1 confidence
  - `ignored` — staff marked as irrelevant
  - `shopping_item_id` — confirmed match

---

## API Routes (`/api/shopping/`)
| Method | Path | Description |
|--------|------|-------------|
| GET | /items | List catalog items |
| POST | /items | Create item |
| PATCH | /items/:id | Update item |
| DELETE | /items/:id | Delete item |
| GET | /categories | List categories with counts |
| POST | /categories/merge | Merge two categories |
| GET | /items/:id/purchases | Purchase history for item |
| POST | /items/:id/match | Match a raw item to this catalog item |
| POST | /items/:keepId/merge/:mergeId | Merge duplicate catalog items |
| POST | /items/find-duplicates | AI duplicate detection |
| POST | /items/:id/extract-unit | AI unit extraction from description |
| GET | /raw | List unmatched raw purchases |
| POST | /raw/:id/match | Match raw → catalog |
| POST | /raw/:id/ignore | Ignore raw item |
| POST | /raw/sync | Pull new raw items from receipts |
| GET | /raw/fuzzy | Fuzzy match suggestions (pg_trgm) |
| GET | /inventory | Current inventory counts |
| PATCH | /inventory/:itemId/:locationId | Update a count |
| POST | /inventory/reorder | Save display order |
| GET | /shopping-list | Generate shopping list |
| GET | /unmatched | Items with no recent purchases |

---

## What's Built
- [x] DB schema (migrations 265-271)
- [x] All API routes above
- [x] ShoppingInventory page (mobile count screen)
- [x] ShoppingCatalog page (manager catalog)
- [x] FoodLayout with tabs: Inventory, Item Catalog

## What's TODO / In Progress
- [ ] Shopping List page (UI exists in spec, not yet built)
- [ ] Raw Purchases matching UI
- [ ] Par level per-location UI (currently global)
- [ ] Shopping list export (print/PDF)
- [ ] Harvester → shopping_item_raw auto-population (Harvester side)
- [ ] Unit/price tracking on inventory counts
- [ ] Low-stock notifications

---

## Notes
- The Food nav item was renamed to Shopping (sidebar label)
- `/food` redirects to `/food/inventory`
- Raw purchase dedup: a raw row with the same (company_id, vendor, description, order_date, total) is only inserted once
- pg_trgm extension is optional — fuzzy match gracefully degrades if unavailable
