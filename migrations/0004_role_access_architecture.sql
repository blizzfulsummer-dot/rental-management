-- ============================================================
-- 0004_role_access_architecture.sql
-- ReMan Role & Access Architecture
-- ============================================================

-- The smart-room migration creates houses without house_uid. Add this
-- column before normalizing existing properties and building its index.
ALTER TABLE houses ADD COLUMN house_uid TEXT;

-- Initial tenant schema predates room assignments, but this migration
-- creates the index that depends on the column.
ALTER TABLE tenants ADD COLUMN room_id INTEGER;

-- ============================================================
-- 1. POPULATE HOUSE UID
-- ============================================================

UPDATE houses
SET house_uid = 'HSE-' || printf('%06d', id)
WHERE house_uid IS NULL
   OR house_uid = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_houses_house_uid
ON houses(house_uid);


-- ============================================================
-- 2. TENANT -> ROOM INDEX
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tenants_room_id
ON tenants(room_id);


-- ============================================================
-- 3. USER -> HOUSE ACCESS INDEX
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_user_house_access_user_house
ON user_house_access(user_id, house_id);


-- ============================================================
-- 4. NORMALIZE EXISTING TEST OWNER
-- ============================================================

UPDATE users
SET role = 'owner'
WHERE id = 1
  AND role IN ('user', 'owner');