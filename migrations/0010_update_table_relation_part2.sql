-- ReMan D1 migration: fix user-related foreign keys and billing.user_id.
-- Review and back up the remote D1 database before applying this migration.
-- This migration preserves existing rows and payment-to-billing links.

PRAGMA defer_foreign_keys = TRUE;

-- 1. Snapshot tables that need rebuilding. These snapshots intentionally have
-- no foreign-key constraints, so the original tables can be replaced safely.
CREATE TABLE _mig_password_resets AS
SELECT id, user_id, token, expires_at, used, created_at FROM password_resets;

CREATE TABLE _mig_user_house_access AS
SELECT id, user_id, house_id, access_level, created_at FROM user_house_access;

CREATE TABLE _mig_websocket_tickets AS
SELECT id, ticket_id, user_id, house_id, client_type, device_id,
       expires_at, consumed, created_at
FROM websocket_tickets;

CREATE TABLE _mig_billing AS
SELECT id, tenant_id, user_id, amount, status, created_at, due_date, paid_at
FROM billing;

CREATE TABLE _mig_payments AS
SELECT id, tenant_id, billing_id, amount, paid_at, method, note
FROM payments;

-- 2. Drop dependent tables before their parents.
DROP TABLE payments;
DROP TABLE billing;
DROP TABLE websocket_tickets;
DROP TABLE user_house_access;
DROP TABLE password_resets;

-- 3. Recreate billing with nullable user_id, making ON DELETE SET NULL valid.
CREATE TABLE billing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    due_date DATETIME,
    paid_at DATETIME,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO billing (id, tenant_id, user_id, amount, status, created_at, due_date, paid_at)
SELECT id, tenant_id, user_id, amount, status, created_at, due_date, paid_at
FROM _mig_billing;

-- 4. Recreate payments with the same tenant and billing deletion behavior.
CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    billing_id INTEGER,
    amount INTEGER NOT NULL,
    paid_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    method TEXT DEFAULT 'cash',
    note TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (billing_id) REFERENCES billing(id) ON DELETE SET NULL
);

INSERT INTO payments (id, tenant_id, billing_id, amount, paid_at, method, note)
SELECT id, tenant_id, billing_id, amount, paid_at, method, note
FROM _mig_payments;

-- 5. Recreate account-owned rows with cascading user deletion.
CREATE TABLE password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO password_resets (id, user_id, token, expires_at, used, created_at)
SELECT id, user_id, token, expires_at, used, created_at
FROM _mig_password_resets;

CREATE TABLE user_house_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    house_id INTEGER NOT NULL,
    access_level TEXT DEFAULT 'viewer',
    created_at TEXT NOT NULL,
    UNIQUE (user_id, house_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE CASCADE
);

INSERT INTO user_house_access (id, user_id, house_id, access_level, created_at)
SELECT id, user_id, house_id, access_level, created_at
FROM _mig_user_house_access;

-- 6. Tickets are temporary credentials; remove them when their user, house,
-- or device is deleted.
CREATE TABLE websocket_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    house_id INTEGER NOT NULL,
    client_type TEXT DEFAULT 'web',
    device_id INTEGER,
    expires_at TEXT NOT NULL,
    consumed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

INSERT INTO websocket_tickets
    (id, ticket_id, user_id, house_id, client_type, device_id, expires_at, consumed, created_at)
SELECT id, ticket_id, user_id, house_id, client_type, device_id, expires_at, consumed, created_at
FROM _mig_websocket_tickets;

-- 7. Restore indexes from the supplied schema.
CREATE INDEX idx_user_house_access_user_id ON user_house_access(user_id);
CREATE INDEX idx_user_house_access_house_id ON user_house_access(house_id);
CREATE INDEX idx_user_house_access_user_house ON user_house_access(user_id, house_id);
CREATE INDEX idx_websocket_tickets_ticket_id ON websocket_tickets(ticket_id);
CREATE INDEX idx_websocket_tickets_expires ON websocket_tickets(expires_at);

-- 8. Remove snapshots only after all replacement rows and indexes exist.
DROP TABLE _mig_password_resets;
DROP TABLE _mig_user_house_access;
DROP TABLE _mig_websocket_tickets;
DROP TABLE _mig_billing;
DROP TABLE _mig_payments;

-- Note: logs, signup_keys, and refresh_tokens have no declared user foreign key
-- in the supplied schema. They therefore do not currently block user deletion.
-- They are deliberately left unchanged; logs should generally remain historical.
