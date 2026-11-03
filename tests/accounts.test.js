import test from 'node:test';
import assert from 'node:assert/strict';
import { registerProvisionedAccount, setManagedAccountStatus } from '../src/modules/accounts.js';

test('provisioned regular users receive all requested property assignments', async () => {
  const statements = [];
  const DB = {
    prepare(sql) {
      if (sql.includes('PRAGMA table_info(users)')) {
        return {
          async all() {
            return { results: [{ name: 'status' }, { name: 'is_active' }] };
          }
        };
      }
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('FROM houses WHERE id = ?')) return { id: values[0] };
              return null;
            },
            async run() {
              statements.push({ sql, values });
              return sql.includes('INSERT INTO users')
                ? { meta: { last_row_id: 42, changes: 1 } }
                : { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  const request = new Request('https://example.com/api/provisioning/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Regular User',
      email: 'user@example.com',
      role: 'user',
      property_ids: [3, 5]
    })
  });

  const response = await registerProvisionedAccount(request, { DB }, { id: 1, role: 'admin' });
  const payload = await response.json();
  const assignments = statements.filter(({ sql }) => sql.includes('INSERT OR IGNORE INTO user_house_access'));

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.emailSent, false);
  assert.deepEqual(assignments.map(({ values }) => values.slice(0, 2)), [
    [42, 3],
    [42, 5]
  ]);
  assert.ok(assignments.every(({ sql }) => sql.includes("'viewer'")));
});

test('suspending an account preserves device grants and fingerprint enrollments', async () => {
  const statements = [];
  const DB = {
    prepare(sql) {
      if (sql.includes('PRAGMA table_info(users)')) {
        return {
          async all() {
            return { results: [{ name: 'status' }, { name: 'is_active' }] };
          }
        };
      }
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('SELECT id, role, email FROM users')) {
                return { id: 42, role: 'tenant', email: 'tenant@example.com' };
              }
              return null;
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

  const response = await setManagedAccountStatus(
    { DB },
    { role: 'admin' },
    42,
    'suspended'
  );

  assert.equal(response.status, 200);
  assert.ok(statements.some(({ sql, values }) =>
    sql.includes('UPDATE users SET') && values.includes('suspended')
  ));
  assert.ok(statements.some(({ sql }) => sql.includes('DELETE FROM refresh_tokens')));
  assert.equal(statements.some(({ sql }) =>
    sql.includes('DELETE FROM user_device_access') ||
    sql.includes('DELETE FROM user_house_access') ||
    sql.includes('device_fingerprint_enrollments')
  ), false);
});
