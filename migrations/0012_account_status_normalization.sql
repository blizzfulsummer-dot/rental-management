-- ============================================================
-- 0012_account_status_normalization.sql
-- Normalize account state across the users table.
--
-- Some environments have is_active, while others have status.
-- This migration harmonizes both to the active/suspended model used
-- by the application logic.
-- ============================================================

PRAGMA foreign_keys = OFF;

ALTER TABLE users ADD COLUMN status TEXT;

UPDATE users
SET status = CASE
  WHEN LOWER(COALESCE(status, 'active')) = 'suspended' THEN 'suspended'
  WHEN COALESCE(is_active, 1) = 0 THEN 'suspended'
  ELSE 'active'
END
WHERE status IS NULL
   OR status NOT IN ('active', 'suspended');

UPDATE users
SET is_active = CASE
  WHEN LOWER(COALESCE(status, 'active')) = 'suspended' THEN 0
  ELSE 1
END
WHERE is_active IS NULL
   OR is_active NOT IN (0, 1)
   OR (LOWER(COALESCE(status, 'active')) = 'suspended' AND is_active <> 0)
   OR (LOWER(COALESCE(status, 'active')) <> 'suspended' AND is_active = 0);

UPDATE users
SET status = CASE
  WHEN is_active = 0 THEN 'suspended'
  ELSE 'active'
END
WHERE status IS NULL
   OR status NOT IN ('active', 'suspended');

CREATE INDEX IF NOT EXISTS idx_users_status
ON users(status);

PRAGMA foreign_keys = ON;
