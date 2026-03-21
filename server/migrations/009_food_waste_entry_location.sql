-- Add location to food waste entries (one location per log).
-- Run in your app schema (e.g. SET search_path TO teamtask_hub; first).
-- Requires: locations table (migration 008).

ALTER TABLE food_waste_entries
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;
