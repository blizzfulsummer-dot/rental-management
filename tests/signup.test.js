import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { signup } from '../src/auth.js';

const secret = 'test-secret';

async function createOwnerToken() {
  return new SignJWT({ sub: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret));
}

function createDb({ ownedHouse = true } = {}) {
  const statements = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('SELECT id, email, role, name FROM users WHERE id = ?')) {
                return { id: 1, email: 'owner@example.com', role: 'owner', name: 'Owner' };
              }
              if (sql.includes('SELECT id FROM houses WHERE id = ? AND owner_id = ?')) {
                return ownedHouse ? { id: 10 } : null;
              }
              if (sql.includes('SELECT id FROM users WHERE email = ?')) return null;
              return null;
            },
            async run() {
              statements.push({ sql, values });
              if (sql.includes('INSERT INTO users')) return { meta: { last_row_id: 42 } };
              return { success: true };
            }
          };
        }
      };
    }
  };
  return { DB, statements };
}

function tenantRegistrationRequest(token, overrides = {}) {
  return new Request('https://example.com/api/signup', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      role: 'tenant',
      name: 'New Tenant',
      email: 'tenant@example.com',
      house_id: 10,
      balance: 0,
      deposit: 500,
      rent_amount: 1500,
      billing_cycle: 'monthly',
      leased_unit: 'A1',
      onboard_date: '2026-10-01',
      ...overrides
    })
  });
}

test('owner can register a tenant in an owned house', async () => {
  const token = await createOwnerToken();
  const { DB, statements } = createDb();
  const response = await signup(tenantRegistrationRequest(token), { DB, JWT_SCRT: secret });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.ok(payload.tempPassword);
  assert.ok(statements.some(({ sql }) => sql.includes('INSERT INTO tenants')));
  assert.ok(statements.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO user_house_access')));
});

test('owner cannot register a tenant in a house they do not own', async () => {
  const token = await createOwnerToken();
  const { DB, statements } = createDb({ ownedHouse: false });
  const response = await signup(tenantRegistrationRequest(token), { DB, JWT_SCRT: secret });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.error, 'Forbidden');
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO users')), false);
});
