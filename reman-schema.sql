PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE houses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  owner_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
, "rent_amount" INTEGER, "date_occupied" DATE NULL, house_uid TEXT);
CREATE TABLE devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  house_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  status TEXT DEFAULT 'offline',
  last_seen TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
, "timer_offset" TEXT, "state" TEXT, "default_state" TEXT, device_key_hash TEXT);
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  device_id INTEGER,
  action TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE signup_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    used INTEGER DEFAULT 0, -- 0 = not used, 1 = used
    user_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    balance REAL DEFAULT 0,
    deposit REAL DEFAULT 0,
    rent_amount REAL NOT NULL,
    billing_cycle TEXT DEFAULT 'monthly',
    leased_unit TEXT NOT NULL,
    onboard_date DATE NOT NULL,
    next_cycle DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, room_id INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house_id INTEGER NOT NULL,
  	name TEXT NOT NULL,
    rent_amount INTEGER NOT NULL,
    date_occupied DATE NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(house_id) REFERENCES houses(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE user_device_access (
    user_id INT NOT NULL,
    device_id INT NOT NULL,
    PRIMARY KEY (user_id, device_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS "users" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT CHECK(role IN ('admin','owner','user','tenant')),
    name TEXT,
    email TEXT UNIQUE,
    password_hash TEXT,
    password_salt TEXT,
    created_at TEXT,
    requires_change_password INTEGER NOT NULL DEFAULT 0,
    temp_password_expiration DATETIME
);
CREATE TABLE device_fingerprint_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  fingerprint_id INTEGER NOT NULL CHECK (fingerprint_id BETWEEN 1 AND 127),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  enrollment_pending INTEGER NOT NULL DEFAULT 0 CHECK (enrollment_pending IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, user_id),
  UNIQUE (device_id, fingerprint_id),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
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
CREATE TABLE password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
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
DELETE FROM sqlite_sequence;
CREATE INDEX idx_houses_owner_id ON houses(owner_id);
CREATE INDEX idx_devices_house_id ON devices(house_id);
CREATE UNIQUE INDEX idx_houses_house_uid
ON houses(house_uid);
CREATE INDEX idx_tenants_room_id
ON tenants(room_id);
CREATE UNIQUE INDEX idx_users_email
ON users(email);
CREATE INDEX idx_fingerprint_enrollments_device_status
  ON device_fingerprint_enrollments(device_id, status, enrollment_pending);
CREATE INDEX idx_user_house_access_user_id ON user_house_access(user_id);
CREATE INDEX idx_user_house_access_house_id ON user_house_access(house_id);
CREATE INDEX idx_user_house_access_user_house ON user_house_access(user_id, house_id);
CREATE INDEX idx_websocket_tickets_ticket_id ON websocket_tickets(ticket_id);
CREATE INDEX idx_websocket_tickets_expires ON websocket_tickets(expires_at);
