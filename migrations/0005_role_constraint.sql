-- The current 0001_initial.sql defines users.role without a restrictive
-- CHECK constraint, so all supported roles (including owner) are already
-- accepted. Keep this migration as a no-op for clean local installations.
SELECT 1;
