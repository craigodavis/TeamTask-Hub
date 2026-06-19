-- Add raw_item_id to receipt_items so each line item links back to its shopping_item_raw catalog entry.
-- This enables indexed spend queries: "how much did we spend on X?" without string scanning.

ALTER TABLE receipt_items
  ADD COLUMN IF NOT EXISTS raw_item_id UUID REFERENCES shopping_item_raw(id);

CREATE INDEX IF NOT EXISTS receipt_items_raw_item_id_idx ON receipt_items(raw_item_id);

-- Backfill: match by vendor_item_number first (Sysco / structured vendors — most stable key)
UPDATE receipt_items ri
SET raw_item_id = sir.id
FROM receipts r
JOIN shopping_item_raw sir
  ON  sir.company_id        = r.company_id
  AND sir.vendor            = r.vendor
  AND sir.vendor_item_number IS NOT NULL
  AND sir.vendor_item_number = ri.vendor_item_number
WHERE ri.receipt_id   = r.id
  AND ri.raw_item_id  IS NULL
  AND ri.vendor_item_number IS NOT NULL;

-- Backfill: match remaining rows by normalized description + vendor
UPDATE receipt_items ri
SET raw_item_id = sir.id
FROM receipts r
JOIN shopping_item_raw sir
  ON  sir.company_id    = r.company_id
  AND sir.vendor        = r.vendor
  AND sir.description_raw = lower(trim(ri.description))
WHERE ri.receipt_id  = r.id
  AND ri.raw_item_id IS NULL;
