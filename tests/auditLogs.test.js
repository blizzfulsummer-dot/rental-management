import test from 'node:test';
import assert from 'node:assert/strict';
import { getAllowedFingerprintIds, syncFingerprintAuthorizations } from '../src/lib/fingerprintAuthorization.js';
import { writeAuditLog } from '../src/lib/auditLog.js';
import { listAuditLogs } from '../src/modules/auditLogs.js';

test('audit log details stay valid JSON when truncated', async () => {
  let inserted;
  const DB = {
    prepare() {
      return {
        bind(...values) {
          inserted = values;
          return { run: async () => ({ success: true }) };
        }
      };
    }
  };

  assert.equal(await writeAuditLog({ DB }, {
    userId: 5,
    action: 'device.command',
    outcome: 'success',
    source: 'web',
    details: { message: 'x'.repeat(5000) },
    commandId: 'command-1'
  }), true);
  assert.equal(inserted[0], 5);
  assert.equal(inserted[2], 'device.command');
  assert.deepEqual(JSON.parse(inserted[6]).truncated, true);
  assert.equal(inserted[7], 'command-1');
});

test('fingerprint authorization list is scoped to the requested house and device', async () => {
  const statements = [];
  const DB = {
    prepare(sql) {
      if (sql.includes('PRAGMA table_info(users)')) {
        return {
          all: async () => ({ results: [{ name: 'status' }, { name: 'is_active' }] })
        };
      }
      return {
        bind(...values) {
          statements.push({ sql, values });
          return {
            all: async () => ({ results: [{ fingerprint_id: 4 }, { fingerprint_id: 9 }] })
          };
        }
      };
    }
  };

  const ids = await getAllowedFingerprintIds({ DB }, 12, 3);

  assert.deepEqual(ids, [4, 9]);
  assert.match(statements[0].sql, /d\.house_id = \?/);
  assert.deepEqual(statements[0].values, [12, 3]);
  assert.match(statements[0].sql, /u\.is_active/);
  assert.match(statements[0].sql, /u\.status/);
});

test('fingerprint authorization sync forwards to the matching HouseRoom', async () => {
  let roomName;
  let requestBody;
  const env = {
    HOUSE_ROOM: {
      idFromName(name) {
        roomName = name;
        return name;
      },
      get() {
        return {
          async fetch(_url, init) {
            requestBody = JSON.parse(init.body);
            return Response.json({ success: true, delivered: true });
          }
        };
      }
    }
  };

  assert.equal(await syncFingerprintAuthorizations(env, 15, 6), true);
  assert.equal(roomName, 'house-6');
  assert.deepEqual(requestBody, { deviceId: 15 });
});

test('owners receive only audit activity scoped to their properties', async () => {
  let query;
  let bindings;
  const DB = {
    prepare(sql) {
      query = sql;
      return {
        bind(...values) {
          bindings = values;
          return { all: async () => ({ results: [{ id: 2, action: 'device.command' }] }) };
        }
      };
    }
  };
  const response = await listAuditLogs(
    new Request('https://api.example/api/logs?limit=250'),
    { DB },
    { id: 7, role: 'owner' }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.logs.length, 1);
  assert.match(query, /h\.owner_id = \?/);
  assert.match(query, /LIMIT \?/);
  assert.deepEqual(bindings, [7, 7, 7, 200]);
});

test('regular users cannot list audit logs', async () => {
  const response = await listAuditLogs(
    new Request('https://api.example/api/logs'),
    { DB: {} },
    { id: 8, role: 'user' }
  );

  assert.equal(response.status, 403);
});
