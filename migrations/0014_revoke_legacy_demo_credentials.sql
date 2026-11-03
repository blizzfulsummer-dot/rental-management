-- Revoke the publicly documented demo administrator bootstrap credentials
-- from databases that already applied the historical 0003 migration.
-- The exact password hash predicate prevents touching a legitimate account
-- that later reused the same email with a new password.
UPDATE signup_keys
SET used = 1
WHERE code = 'admin-demo-key';

UPDATE users
SET is_active = 0,
    status = 'suspended'
WHERE id = 1
  AND email = 'admin@example.com'
  AND password_hash = 'd92ab3717b7ad3bf6ccf593ebf11473f50231417a3aa80471164a39f8844b65f';
