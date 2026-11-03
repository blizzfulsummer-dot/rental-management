
-- =========================================================
-- ReMan: Initial Database Schema
-- Migration: 0001_initial_schema.sql
-- Intended for a fresh, empty SQLite / Cloudflare D1 database
-- =========================================================

-- ---------------------------------------------------------
-- 1. USERS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT CHECK (role IN ('admin', 'owner', 'user', 'tenant')),
    name TEXT,
    email TEXT UNIQUE,
    password_hash TEXT,
    password_salt TEXT,
    created_at TEXT,
    requires_change_password INTEGER NOT NULL DEFAULT 0,
    temp_password_expiration DATETIME,
    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1))
);

ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_users_is_active
ON users(is_active);


-- ---------------------------------------------------------
-- 2. HOUSES
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS houses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    owner_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    rent_amount INTEGER,
    date_occupied DATE NULL,
    house_uid TEXT,

    FOREIGN KEY (owner_id)
        REFERENCES users(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_houses_owner_id
ON houses(owner_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_houses_house_uid
ON houses(house_uid);


-- ---------------------------------------------------------
-- 3. ROOMS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    rent_amount INTEGER NOT NULL,
    date_occupied DATE NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (house_id)
        REFERENCES houses(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rooms_house_id
ON rooms(house_id);


-- ---------------------------------------------------------
-- 4. DEVICES
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    status TEXT DEFAULT 'offline',
    last_seen TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    timer_offset TEXT,
    state TEXT,
    default_state TEXT,
    device_key_hash TEXT,

    FOREIGN KEY (house_id)
        REFERENCES houses(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_devices_house_id
ON devices(house_id);


-- ---------------------------------------------------------
-- 5. TENANTS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    balance REAL DEFAULT 0,
    deposit REAL DEFAULT 0,
    rent_amount REAL NOT NULL,
    billing_cycle TEXT DEFAULT 'monthly',
    leased_unit TEXT NOT NULL,
    onboard_date DATE NOT NULL,
    next_cycle DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    room_id INTEGER,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,

    FOREIGN KEY (room_id)
        REFERENCES rooms(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenants_room_id
ON tenants(room_id);

CREATE INDEX IF NOT EXISTS idx_tenants_user_id
ON tenants(user_id);


-- ---------------------------------------------------------
-- 6. REFRESH TOKENS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);


-- ---------------------------------------------------------
-- 7. SIGNUP KEYS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS signup_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    used INTEGER DEFAULT 0,
    user_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);


-- ---------------------------------------------------------
-- 8. AUDIT LOGS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    device_id INTEGER,
    action TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE,

    FOREIGN KEY (device_id)
        REFERENCES devices(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_logs_user_id
ON logs(user_id);

CREATE INDEX IF NOT EXISTS idx_logs_device_id
ON logs(device_id);


-- ---------------------------------------------------------
-- 9. USER HOUSE ACCESS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_house_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    house_id INTEGER NOT NULL,
    access_level TEXT DEFAULT 'viewer',
    created_at TEXT NOT NULL,

    UNIQUE (user_id, house_id),

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    FOREIGN KEY (house_id)
        REFERENCES houses(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_house_access_user_id
ON user_house_access(user_id);

CREATE INDEX IF NOT EXISTS idx_user_house_access_house_id
ON user_house_access(house_id);

CREATE INDEX IF NOT EXISTS idx_user_house_access_user_house
ON user_house_access(user_id, house_id);


-- ---------------------------------------------------------
-- 10. USER DEVICE ACCESS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_device_access (
    user_id INTEGER NOT NULL,
    device_id INTEGER NOT NULL,

    PRIMARY KEY (user_id, device_id),

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    FOREIGN KEY (device_id)
        REFERENCES devices(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);


-- ---------------------------------------------------------
-- 11. DEVICE FINGERPRINT ENROLLMENTS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS device_fingerprint_enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    fingerprint_id INTEGER NOT NULL
        CHECK (fingerprint_id BETWEEN 1 AND 127),
    status TEXT NOT NULL
        CHECK (status IN ('pending', 'active', 'disabled')),
    enrollment_pending INTEGER NOT NULL DEFAULT 0
        CHECK (enrollment_pending IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    UNIQUE (device_id, user_id),
    UNIQUE (device_id, fingerprint_id),

    FOREIGN KEY (device_id)
        REFERENCES devices(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fingerprint_enrollments_device_status
ON device_fingerprint_enrollments(
    device_id,
    status,
    enrollment_pending
);


-- ---------------------------------------------------------
-- 12. BILLING
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    due_date DATETIME,
    paid_at DATETIME,

    FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_billing_tenant_id
ON billing(tenant_id);

CREATE INDEX IF NOT EXISTS idx_billing_user_id
ON billing(user_id);


-- ---------------------------------------------------------
-- 13. PAYMENTS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    billing_id INTEGER,
    amount INTEGER NOT NULL,
    paid_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    method TEXT DEFAULT 'cash',
    note TEXT,

    FOREIGN KEY (tenant_id)
        REFERENCES tenants(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE,

    FOREIGN KEY (billing_id)
        REFERENCES billing(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant_id
ON payments(tenant_id);

CREATE INDEX IF NOT EXISTS idx_payments_billing_id
ON payments(billing_id);


-- ---------------------------------------------------------
-- 14. PASSWORD RESETS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);


-- ---------------------------------------------------------
-- 15. WEBSOCKET TICKETS
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS websocket_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    house_id INTEGER NOT NULL,
    client_type TEXT DEFAULT 'web',
    device_id INTEGER,
    expires_at TEXT NOT NULL,
    consumed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    FOREIGN KEY (house_id)
        REFERENCES houses(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,

    FOREIGN KEY (device_id)
        REFERENCES devices(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_websocket_tickets_ticket_id
ON websocket_tickets(ticket_id);

CREATE INDEX IF NOT EXISTS idx_websocket_tickets_expires
ON websocket_tickets(expires_at);


-- ---------------------------------------------------------
-- 16. D1 MIGRATION TRACKING
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- =========================================================
-- END OF INITIAL SCHEMA
-- =========================================================
