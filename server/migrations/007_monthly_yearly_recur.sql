-- Monthly: recur on a day of the month (1-31).
-- Yearly: recur on a given date (month 1-12, day 1-31).
-- Run against your schema first if needed (e.g. SET search_path TO teamtask_hub;).

ALTER TABLE task_list_templates
  ADD COLUMN IF NOT EXISTS day_of_month INTEGER,
  ADD COLUMN IF NOT EXISTS recur_month INTEGER,
  ADD COLUMN IF NOT EXISTS recur_day INTEGER;
