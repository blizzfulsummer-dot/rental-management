import test from 'node:test';
import assert from 'node:assert/strict';
import { listProvisionableUsers, manageDeviceAccess } from '../src/tenant.js';

function createDb({ houseManaged = true, userInOwnerScope = true } = {}) {
  const statements = [];
  const tenant = { id: 42, email: 'tenant@example.com', name: 'Tenant User', role: 'tenant' };
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('FROM devices d') && sql.includes('JOIN houses h')) {
                return houseManaged ? { id: 5, house_id: 2 } : null;
              }
              if (sql.includes('FROM users u') && sql.includes('WHERE u.id = ?')) {
                return userInOwnerScope ? { 1: 1 } : null;
              }
              if (sql.includes('SELECT id, email, name, role FROM users WHERE id = ?')) {
                return Number(values[0]) === tenant.id ? tenant : null;
              }
              return null;
            },
            async all() {
              if (sql.includes('FROM user_device_access uda') && sql.includes('JOIN users u')) {
                return { results: [tenant] };
              }
              if (sql.includes('FROM users u') && sql.includes('WHERE u.role IN')) {
                return { results: [tenant] };
              }
              return { results: [] };
            },
            async run() {
              statements.push({ sql, values });
              return { success: true };
            }
          };
        }
      };
    }
  };
  return { DB, statements };
}

test('owner can grant and revoke a device to an eligible tenant', async () => {
  const { DB, statements } = createDb();
  const owner = { id: 7, role: 'owner' };
  const grant = await manageDeviceAccess(
    new Request('https://example.com/api/devices/5/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 42 })
    }),
    { DB },
    owner,
    '5'
  );
  const grantPayload = await grant.json();

  assert.equal(grant.status, 200);
  assert.deepEqual(grantPayload.user, { id: 42, email: 'tenant@example.com', name: 'Tenant User', role: 'tenant' });
  assert.ok(statements.some(({ sql, values }) =>
    sql.includes('INSERT OR IGNORE INTO user_device_access') && values[0] === 42 && values[1] === 5
  ));

  const revoke = await manageDeviceAccess(
    new Request('https://example.com/api/devices/5/access/42', { method: 'DELETE' }),
    { DB },
    owner,
    '5',
    '42'
  );
  assert.equal(revoke.status, 200);
  assert.ok(statements.some(({ sql, values }) =>
    sql.includes('DELETE FROM user_device_access') && values[0] === 42 && values[1] === 5
  ));
});

test('owner cannot grant a device to a user outside their property scope', async () => {
  const { DB, statements } = createDb({ userInOwnerScope: false });
  const response = await manageDeviceAccess(
    new Request('https://example.com/api/devices/5/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 42 })
    }),
    { DB },
    { id: 7, role: 'owner' },
    '5'
  );

  assert.equal(response.status, 403);
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT OR IGNORE INTO user_device_access')), false);
});

test('owner can list only device-provisionable users in their property scope', async () => {
  const { DB } = createDb();
  const response = await listProvisionableUsers({}, { DB }, { id: 7, role: 'owner' });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.users, [{ id: 42, email: 'tenant@example.com', name: 'Tenant User', role: 'tenant' }]);
});
