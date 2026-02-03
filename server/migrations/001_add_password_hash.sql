-- Add password hash for email/password login.
-- Run against your TeamTask Hub schema (e.g. teamtask_hub or public).

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
