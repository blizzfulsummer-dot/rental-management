import test from 'node:test';
import assert from 'node:assert/strict';
import { HouseRoom } from '../src/houseRoom.js';

function createSession(role, deviceId) {
  const messages = [];
  return {
    messages,
    ws: { send(message) { messages.push(JSON.parse(message)); } },
    userId: 42,
    role,
    deviceId,
    clientType: 'web'
  };
}

test('house room refuses commands for devices other than the ticketed device', () => {
  const room = new HouseRoom({ id: 'house-10' }, {});
  const session = createSession('tenant', 7);
  room.sessions.set('web-session', session);

  room.handleDeviceCommand('web-session', session, {
    targetDeviceId: 8,
    command: 'on'
  });

  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].type, 'error');
  assert.match(session.messages[0].error, /not authorized/);
});

test('house room routes a command ID to the ticketed device session', async () => {
  const pendingCommands = new Map();
  const storage = {
    async put(key, value) { pendingCommands.set(key, value); },
    async get(key) { return pendingCommands.get(key); },
    async delete(key) { pendingCommands.delete(key); },
    async list({ prefix }) {
      return new Map([...pendingCommands].filter(([key]) => key.startsWith(prefix)));
    },
    async setAlarm() {}
  };
  const room = new HouseRoom({ id: 'house-10', storage }, {
    DB: {
      prepare(sql) {
        if (sql.includes('PRAGMA table_info(users)')) {
          return { all: async () => ({ results: [] }) };
        }
        return {
          bind() {
            return {
              first: async () => ({ id: 7 }),
              run: async () => ({ success: true })
            };
          }
        };
      }
    }
  });
  const sender = createSession('tenant', 7);
  const deviceMessages = [];
  const deviceSession = {
    clientType: 'device',
    deviceId: 7,
    ws: { send(message) { deviceMessages.push(JSON.parse(message)); } }
  };
  room.sessions.set('web-session', sender);
  room.sessions.set('device-session', deviceSession);

  await room.handleDeviceCommand('web-session', sender, {
    targetDeviceId: 7,
    command: 'io.set',
    id: 'relay2',
    state: true
  });

  assert.equal(deviceMessages[0].deviceId, 7);
  assert.equal(deviceMessages[0].command, 'io.set');
  assert.match(deviceMessages[0].commandId, /^[A-Za-z0-9._:-]{1,128}$/);
  assert.equal(deviceMessages[0].id, 'relay2');
  assert.equal(deviceMessages[0].state, true);
  assert.equal(sender.messages[0].type, 'command_routed');
  assert.equal(sender.messages[0].commandId, deviceMessages[0].commandId);
  assert.equal(pendingCommands.size, 1);

  await room.handleDeviceResponse('device-session', deviceSession, {
    deviceId: 7,
    commandId: 'different-command-id',
    command: 'io.set',
    success: true
  });
  assert.equal(pendingCommands.size, 1);
  assert.equal(sender.messages.some(message => message.type === 'command_result'), false);

  await room.handleDeviceResponse('device-session', deviceSession, {
    deviceId: 7,
    commandId: deviceMessages[0].commandId,
    command: 'io.set',
    success: true
  });

  assert.equal(pendingCommands.size, 0);
  assert.equal(sender.messages[2].type, 'command_result');
  assert.equal(sender.messages[2].commandId, deviceMessages[0].commandId);
  assert.equal(sender.messages[2].status, 'acknowledged');
});

test('house room blocks suspended accounts from issuing device commands', async () => {
  const commandSql = [];
  const room = new HouseRoom({ id: 'house-10' }, {
    DB: {
      prepare(sql) {
        commandSql.push(sql);
        if (sql.includes('INSERT INTO logs')) {
          return { bind() { return { run: async () => ({ success: true }) }; } };
        }
        if (sql.includes('PRAGMA table_info(users)')) {
          return {
            async all() {
              return { results: [{ name: 'status' }, { name: 'is_active' }] };
            }
          };
        }
        return {
          bind() {
            return {
              async first() {
                return null;
              }
            };
          }
        };
      }
    }
  });
  const sender = createSession('tenant', 7);
  const deviceMessages = [];
  room.sessions.set('web-session', sender);
  room.sessions.set('device-session', {
    clientType: 'device',
    deviceId: 7,
    houseId: 10,
    ws: { send(message) { deviceMessages.push(JSON.parse(message)); } }
  });

  await room.handleDeviceCommand('web-session', sender, {
    targetDeviceId: 7,
    command: 'door.unlock',
    commandId: 'suspended-account-command'
  });

  assert.match(commandSql.join('\n'), /COALESCE\(u\.is_active, 1\) = 1/);
  assert.match(commandSql.join('\n'), /u\.status, 'active'\)\) != 'suspended'/);
  assert.equal(deviceMessages.length, 0);
  assert.match(sender.messages[0].error, /not authorized/i);
});

test('house room echoes a device heartbeat request ID in its pong', () => {
  const room = new HouseRoom({ id: 'house-10' }, {});
  const device = createSession('device', 7);
  room.sessions.set('device-session', device);

  room.handlePing('device-session', device, { requestId: 123 });

  assert.equal(device.messages[0].type, 'pong');
  assert.equal(device.messages[0].requestId, 123);
});

test('house room only broadcasts a device response matching the paired device', () => {
  const room = new HouseRoom({ id: 'house-10' }, {
    DB: { prepare() { return { bind() { return { run: async () => ({ success: true }) }; } }; } }
  });
  const webSession = createSession('tenant', 7);
  const deviceSessionMessages = [];
  room.sessions.set('web-session', webSession);
  const deviceSession = {
    clientType: 'device',
    deviceId: 7,
    ws: { send(message) { deviceSessionMessages.push(JSON.parse(message)); } }
  };

  room.handleDeviceResponse('device-session', deviceSession, {
    deviceId: 8,
    success: true
  });
  assert.equal(deviceSessionMessages[0].type, 'error');
  assert.equal(webSession.messages.length, 0);

  room.handleDeviceResponse('device-session', deviceSession, {
    deviceId: 7,
    success: true
  });
  assert.equal(webSession.messages[0].type, 'device_response');
  assert.equal(webSession.messages[0].deviceId, 7);
});

test('authorized fingerprint recognition unlocks the paired door and stays device-scoped', async () => {
  const room = new HouseRoom({ id: 'house-10' }, {
    DB: {
      prepare(sql) {
        if (sql.includes('PRAGMA table_info(users)')) {
          return { all: async () => ({ results: [] }) };
        }
        if (sql.includes('INSERT INTO logs')) {
          return { bind() { return { run: async () => ({ success: true }) }; } };
        }
        assert.match(sql, /device_fingerprint_enrollments/);
        return {
          bind(deviceId, fingerprintId) {
            assert.equal(deviceId, 7);
            assert.equal(fingerprintId, 12);
            return { first: async () => ({ user_id: 42 }) };
          }
        };
      }
    }
  });
  const webSession = createSession('tenant', 7);
  const otherDeviceWeb = createSession('tenant', 8);
  const otherUserWeb = createSession('tenant', 7);
  otherUserWeb.userId = 99;
  const deviceMessages = [];
  const deviceSession = {
    clientType: 'device',
    deviceId: 7,
    ws: { send(message) { deviceMessages.push(JSON.parse(message)); } }
  };
  room.sessions.set('web-session', webSession);
  room.sessions.set('other-device-web', otherDeviceWeb);
  room.sessions.set('other-user-web', otherUserWeb);
  room.sessions.set('device-session', deviceSession);

  await room.handleFingerprintEvent('device-session', deviceSession, {
    event: 'recognized',
    success: true,
    id: 12
  });

  assert.equal(deviceMessages[0].command, 'door.unlock');
  assert.equal(webSession.messages[0].accessGranted, true);
  assert.equal(otherDeviceWeb.messages.length, 0);
  assert.equal(otherUserWeb.messages.length, 0);
});

test('unregistered fingerprint recognition never unlocks the door', async () => {
  const room = new HouseRoom({ id: 'house-10' }, {
    DB: {
      prepare(sql) {
        if (sql.includes('PRAGMA table_info(users)')) {
          return { all: async () => ({ results: [] }) };
        }
        if (sql.includes('INSERT INTO logs')) {
          return { bind() { return { run: async () => ({ success: true }) }; } };
        }
        return { bind() { return { first: async () => null }; } };
      }
    }
  });
  const webSession = createSession('owner', 7);
  const deviceMessages = [];
  const deviceSession = {
    clientType: 'device',
    deviceId: 7,
    ws: { send(message) { deviceMessages.push(JSON.parse(message)); } }
  };
  room.sessions.set('web-session', webSession);
  room.sessions.set('device-session', deviceSession);

  await room.handleFingerprintEvent('device-session', deviceSession, {
    event: 'recognized',
    success: true,
    id: 12
  });

  assert.equal(deviceMessages.length, 0);
  assert.equal(webSession.messages[0].accessGranted, false);
});

test('house room forwards enrollment progress to the enrolling user and device owners', async () => {
  const room = new HouseRoom({ id: 'house-10' }, {
    DB: {
      prepare(sql) {
        if (sql.includes('INSERT INTO logs')) {
          return { bind() { return { run: async () => ({ success: true }) }; } };
        }
        assert.match(sql, /enrollment_pending = 1/);
        return {
          bind(deviceId, fingerprintId) {
            assert.equal(deviceId, 7);
            assert.equal(fingerprintId, 12);
            return { first: async () => ({ user_id: 42 }) };
          }
        };
      }
    }
  });
  const enrollingUser = createSession('tenant', 7);
  const otherUser = createSession('tenant', 7);
  otherUser.userId = 99;
  const owner = createSession('owner', 7);
  const deviceSession = {
    clientType: 'device',
    deviceId: 7,
    ws: { send() { assert.fail('Progress events must not be sent back to the device'); } }
  };
  room.sessions.set('enrolling-user', enrollingUser);
  room.sessions.set('other-user', otherUser);
  room.sessions.set('owner', owner);
  room.sessions.set('device-session', deviceSession);

  await room.handleFingerprintEvent('device-session', deviceSession, {
    event: 'enrollment_remove_finger',
    success: true,
    id: 12,
    message: 'Pull your finger away from the sensor'
  });

  assert.equal(enrollingUser.messages[0].event, 'enrollment_remove_finger');
  assert.equal(enrollingUser.messages[0].deviceId, 7);
  assert.equal(otherUser.messages.length, 0);
  assert.equal(owner.messages[0].event, 'enrollment_remove_finger');
});


test('house room deduplicates restored sessions from socket and in-memory indexes', () => {
  const messages = [];
  const ws = {
    deserializeAttachment() { return { sessionId: 'same-session', userId: 42, clientType: 'web', deviceId: 7, houseId: 10 }; },
    serializeAttachment() {},
    send(message) { messages.push(JSON.parse(message)); }
  };
  const state = { id: 'house-10', getWebSockets: () => [ws] };
  const room = new HouseRoom(state, {});
  room.sessions.set('same-session', { sessionId: 'same-session', userId: 42, clientType: 'web', deviceId: 7, houseId: 10, ws });

  assert.equal(room.getAllSessions().length, 1);
  room.broadcastSystemMessage({ type: 'test' });
  assert.equal(messages.length, 1);
});

test('house room scopes device responses to browser sessions authorized for that device', () => {
  const room = new HouseRoom({ id: 'house-10' }, {});
  const allowed = createSession('tenant', 7);
  const unrelated = createSession('tenant', 8);
  room.sessions.set('allowed', { ...allowed, sessionId: 'allowed', deviceId: 7 });
  room.sessions.set('unrelated', { ...unrelated, sessionId: 'unrelated', deviceId: 8 });
  const device = { clientType: 'device', deviceId: 7, sessionId: 'device-7', ws: { send() {} } };

  room.handleDeviceResponse('device-7', device, { deviceId: 7, command: 'status', success: true });
  assert.equal(allowed.messages.length, 1);
  assert.equal(unrelated.messages.length, 0);
});


test('house room sends telemetry only to browser sessions for the reporting device', async () => {
  const room = new HouseRoom({ id: 'house-10' }, {
    DB: { prepare() { return { bind() { return { run: async () => ({ meta: { changes: 0 } }) }; } }; } }
  });
  const allowed = createSession('tenant', 7);
  const unrelated = createSession('tenant', 8);
  room.sessions.set('allowed', { ...allowed, sessionId: 'allowed', clientType: 'web', deviceId: 7 });
  room.sessions.set('unrelated', { ...unrelated, sessionId: 'unrelated', clientType: 'web', deviceId: 8 });
  const device = { clientType: 'device', deviceId: 7, sessionId: 'device-7', ws: { send() {} } };

  await room.handleDeviceUpdate('device-7', device, {
    deviceId: 7, status: 'online', data: { temperature: 24 }
  });

  assert.equal(allowed.messages.length, 1);
  assert.equal(allowed.messages[0].type, 'device_update');
  assert.equal(unrelated.messages.length, 0);
});


test('house room selects only the newest socket when a device reconnect overlaps', () => {
  const room = new HouseRoom({ id: 'house-10' }, {});
  const oldDevice = {
    clientType: 'device', deviceId: 7, sessionId: 'old-device',
    connectedAt: '2026-01-01T00:00:00.000Z', ws: { send() {} }
  };
  const newDevice = {
    clientType: 'device', deviceId: 7, sessionId: 'new-device',
    connectedAt: '2026-01-01T00:00:05.000Z', ws: { send() {} }
  };
  room.sessions.set('old-device', oldDevice);
  room.sessions.set('new-device', newDevice);

  const sessions = room.getAllSessions();
  assert.equal(sessions.filter(session => session.clientType === 'device').length, 1);
  assert.equal(sessions.find(session => session.clientType === 'device').sessionId, 'new-device');
});


test('house room limits connected-device listing to the requesting device for non-admin sessions', () => {
  const room = new HouseRoom({ id: 'house-10' }, {});
  const messages = [];
  const requestingSession = {
    sessionId: 'web-7', userId: 42, role: 'tenant', clientType: 'web', deviceId: 7,
    ws: { send(message) { messages.push(JSON.parse(message)); } }
  };
  room.sessions.set('device-7', { sessionId: 'device-7', clientType: 'device', deviceId: 7, ws: { send() {} } });
  room.sessions.set('device-8', { sessionId: 'device-8', clientType: 'device', deviceId: 8, ws: { send() {} } });

  room.handleGetDevices(requestingSession.ws, requestingSession);
  assert.deepEqual(messages[0].devices.map(device => device.deviceId), [7]);
});
