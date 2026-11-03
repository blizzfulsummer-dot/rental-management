-- LOCAL ONLY: apply with `npm run db:seed:local`.
-- Never apply this fixture to a remote D1 database.
-- All demo accounts use the password: DemoPass123!

INSERT OR IGNORE INTO users (
  email,
  password_hash,
  password_salt,
  role,
  created_at,
  name,
  requires_change_password,
  temp_password_expiration
)
VALUES
  (
    'admin.demo@example.test',
    '75fdfbe5306f48e556b03957c86fb490abfdc1b64e3d27ba93cf5999d8a1c72d',
    'f84570b98d4e9bd1b2b0d886affc163b',
    'admin',
    datetime('now'),
    'Local Demo Admin',
    0,
    NULL
  ),
  (
    'owner.demo@example.test',
    'e19866b6e1f3775db3f157cb6b23d92ccd30dbab5262d414ea118fa63e944b45',
    '0bb07d776618c56209596bd4b481409c',
    'owner',
    datetime('now'),
    'Local Demo Owner',
    0,
    NULL
  ),
  (
    'user.demo@example.test',
    '48a2c87ab5d264bb4bbb11d2ed355926bdb2a7145a48df0536933b53b0fc7cca',
    '5e4e7e457807932c9506bbfefb2be0a7',
    'user',
    datetime('now'),
    'Local Demo User',
    0,
    NULL
  ),
  (
    'tenant.demo@example.test',
    'adf5049ab9275e9ee4df325191c4c2e485c1c2757e5792b2527bce1a92398f79',
    'da4c997b594af308eea0315bee9be3fb',
    'tenant',
    datetime('now'),
    'Local Demo Tenant',
    0,
    NULL
  );

INSERT OR IGNORE INTO houses (name, location, owner_id, created_at, house_uid)
SELECT
  'Local Demo Property',
  '100 Demo Street',
  owner.id,
  datetime('now'),
  'LOCAL-DEMO-PROPERTY-001'
FROM users owner
WHERE owner.email = 'owner.demo@example.test';

INSERT OR IGNORE INTO user_house_access (user_id, house_id, access_level, created_at)
SELECT demo_user.id, property.id, 'viewer', datetime('now')
FROM users demo_user
CROSS JOIN houses property
WHERE demo_user.email = 'user.demo@example.test'
  AND property.house_uid = 'LOCAL-DEMO-PROPERTY-001';

INSERT OR IGNORE INTO user_house_access (user_id, house_id, access_level, created_at)
SELECT demo_tenant.id, property.id, 'tenant', datetime('now')
FROM users demo_tenant
CROSS JOIN houses property
WHERE demo_tenant.email = 'tenant.demo@example.test'
  AND property.house_uid = 'LOCAL-DEMO-PROPERTY-001';

INSERT INTO tenants (
  user_id,
  balance,
  deposit,
  rent_amount,
  billing_cycle,
  leased_unit,
  onboard_date,
  created_at
)
SELECT
  demo_tenant.id,
  0,
  500,
  1200,
  'monthly',
  'Unit A',
  date('now'),
  datetime('now')
FROM users demo_tenant
WHERE demo_tenant.email = 'tenant.demo@example.test'
  AND NOT EXISTS (
    SELECT 1
    FROM tenants existing
    WHERE existing.user_id = demo_tenant.id
  );
