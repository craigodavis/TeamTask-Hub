-- Weekly tasks: show only on a selected day of the week.
-- day_of_week: 0 = Sunday, 1 = Monday, ... 6 = Saturday (JavaScript Date.getDay()).
-- Run against your schema first if needed (e.g. SET search_path TO teamtask_hub;).

ALTER TABLE task_list_templates
  ADD COLUMN IF NOT EXISTS day_of_week INTEGER;
