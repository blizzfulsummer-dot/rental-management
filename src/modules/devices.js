import { parseJsonBody, validateId } from '../lib/validation.js';
import { canManageHouse, isHouseOwnedByUser, userHasDeviceAccess } from './access-control.js';

async function getDeviceColumns(env) {
  const result = await env.DB.prepare('PRAGMA table_info(devices)').all();
  return new Set((result.results || []).map(column => column.name));
}

function getDeviceColumn(columns, currentName, legacyName) {
  if (columns.has(currentName)) return currentName;
  if (legacyName && columns.has(legacyName)) return legacyName;
  return null;
}

function normalizeDevice(device) {
  const { device_key_hash, ...visibleDevice } = device;
  return {
    ...visibleDevice,
    device_name: visibleDevice.device_name ?? visibleDevice.name ?? `Device ${visibleDevice.id}`,
    device_type: visibleDevice.device_type ?? visibleDevice.type ?? null,
    pairing_configured: Boolean(device_key_hash)
  };
}

function generateDeviceKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hashDeviceKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}


export async function listHouseDevices(request, env, authUser, houseId) {
  const validation = validateId(houseId);

  if (!validation.ok) {
    return json({ error: 'Invalid house ID' }, 400);
  }

  const id = validation.value;

  try {
    // Admin: all devices.
    if (authUser.role === 'admin') {
      const devices = await env.DB.prepare(`
        SELECT d.*
        FROM devices d
        WHERE d.house_id = ?
        ORDER BY d.created_at DESC
      `).bind(id).all();

      return json({ devices: (devices.results || []).map(normalizeDevice) });
    }

    // Owner: all devices in their own property, or only explicitly assigned devices in a property they were granted.
    if (authUser.role === 'owner') {
      const house = await env.DB.prepare('SELECT id FROM houses WHERE id = ? AND owner_id = ?').bind(id, authUser.id).first();

      if (house) {
        const devices = await env.DB.prepare(`
          SELECT d.*
          FROM devices d
          WHERE d.house_id = ?
          ORDER BY d.created_at DESC
        `).bind(id).all();

        return json({ devices: (devices.results || []).map(normalizeDevice) });
      }

      const access = await env.DB.prepare(`
        SELECT 1
        FROM user_house_access
        WHERE user_id = ? AND house_id = ?
        LIMIT 1
      `).bind(authUser.id, id).first();

      if (!access) {
        return json({ error: 'Forbidden' }, 403);
      }

      const devices = await env.DB.prepare(`
        SELECT d.*
        FROM devices d
        JOIN user_device_access uda ON uda.device_id = d.id
        WHERE d.house_id = ?
          AND uda.user_id = ?
        ORDER BY d.created_at DESC
      `).bind(id, authUser.id).all();

      return json({ devices: (devices.results || []).map(normalizeDevice) });
    }

    // Regular users and tenants must have property access
    // or explicit access to at least one device in the property.
    const access = await env.DB.prepare(`
      SELECT 1
      FROM user_house_access
      WHERE user_id = ? AND house_id = ?

      UNION

      SELECT 1
      FROM user_device_access uda
      JOIN devices d ON d.id = uda.device_id
      WHERE uda.user_id = ? AND d.house_id = ?

      LIMIT 1
    `).bind(authUser.id, id, authUser.id, id).first();

    if (!access) {
      return json({ error: 'Forbidden' }, 403);
    }

    // Only explicitly authorized devices are returned.
    const devices = await env.DB.prepare(`
      SELECT d.*
      FROM devices d
      JOIN user_device_access uda ON uda.device_id = d.id
      WHERE d.house_id = ?
        AND uda.user_id = ?
      ORDER BY d.created_at DESC
    `).bind(id, authUser.id).all();

    return json({ devices: (devices.results || []).map(normalizeDevice) });
  } catch (error) {
    console.error('List house devices error:', error);
    return json({ error: 'Failed to fetch devices' }, 500);
  }
}

export async function createDevice(request, env, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const propertyId = parsed.data?.property_id ?? parsed.data?.house_id;
  if (!propertyId) return json({ error: 'property_id is required' }, 400);

  const idValidation = validateId(propertyId);
  if (!idValidation.ok) return json({ error: 'Invalid property ID' }, 400);

  const canManage = await canManageHouse(env, authUser, idValidation.value);
  if (!canManage) return json({ error: 'Forbidden' }, 403);

  const deviceName = typeof (parsed.data?.name ?? parsed.data?.device_name) === 'string'
    ? (parsed.data.name ?? parsed.data.device_name).trim()
    : '';
  const deviceType = typeof (parsed.data?.type ?? parsed.data?.device_type) === 'string'
    ? (parsed.data.type ?? parsed.data.device_type).trim()
    : 'sensor';

  if (!deviceName) return json({ error: 'device_name is required' }, 400);

  try {
    const columns = await getDeviceColumns(env);
    const nameColumn = getDeviceColumn(columns, 'name', 'device_name');
    const typeColumn = getDeviceColumn(columns, 'type', 'device_type');
    if (!nameColumn || !typeColumn || !columns.has('house_id')) {
      throw new Error('The device table is missing required house, name, or type columns');
    }
    if (!columns.has('device_key_hash')) {
      throw new Error('Apply migration 0007 before creating paired devices');
    }

    const insertColumns = ['house_id', nameColumn, typeColumn];
    const values = [idValidation.value, deviceName, deviceType];
    const pairingKey = generateDeviceKey();
    insertColumns.push('device_key_hash');
    values.push(await hashDeviceKey(pairingKey));
    if (columns.has('status')) {
      insertColumns.push('status');
      values.push(typeof parsed.data?.status === 'string' ? parsed.data.status : 'offline');
    }
    if (columns.has('created_at')) {
      insertColumns.push('created_at');
      values.push(new Date().toISOString());
    }

    const result = await env.DB
      .prepare(`INSERT INTO devices (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`)
      .bind(...values)
      .run();

    const device = await env.DB
      .prepare('SELECT * FROM devices WHERE id = ?')
      .bind(result.meta?.last_row_id)
      .first();

    return json({
      success: true,
      device: device ? normalizeDevice(device) : null,
      pairing_key: pairingKey
    }, 201);
  } catch (error) {
    console.error('Create device error:', error);
    return json({ error: 'Failed to create device' }, 500);
  }
}

export async function rotateDevicePairingKey(request, env, authUser, deviceId) {
  const idValidation = validateId(deviceId);
  if (!idValidation.ok) return json({ error: 'Invalid device ID' }, 400);

  try {
    const device = await env.DB
      .prepare('SELECT * FROM devices WHERE id = ?')
      .bind(idValidation.value)
      .first();
    if (!device) return json({ error: 'Device not found' }, 404);

    if (!(await canManageHouse(env, authUser, device.house_id))) {
      return json({ error: 'Forbidden' }, 403);
    }

    const columns = await getDeviceColumns(env);
    if (!columns.has('device_key_hash')) {
      throw new Error('Apply migration 0007 before pairing devices');
    }

    const pairingKey = generateDeviceKey();
    await env.DB
      .prepare('UPDATE devices SET device_key_hash = ? WHERE id = ?')
      .bind(await hashDeviceKey(pairingKey), idValidation.value)
      .run();

    return json({ success: true, pairing_key: pairingKey });
  } catch (error) {
    console.error('Rotate device pairing key error:', error);
    return json({ error: 'Failed to rotate device pairing key' }, 500);
  }
}

export async function getDevice(request, env, authUser, deviceId) {
  const idValidation = validateId(deviceId);
  if (!idValidation.ok) {
    return json({ error: 'Invalid device ID' }, 400);
  }

  try {
    const row = await env.DB
      .prepare('SELECT * FROM devices WHERE id = ?')
      .bind(idValidation.value)
      .first();

    if (!row) {
      return json({ error: 'Device not found' }, 404);
    }

    let canAccess = false;

    if (authUser.role === 'admin') {
      canAccess = true;
    } else if (authUser.role === 'owner') {
      canAccess = await isHouseOwnedByUser(
        env,
        authUser.id,
        row.house_id
      );
    } else {
      canAccess = await userHasDeviceAccess(
        env,
        authUser.id,
        row.id
      );
    }

    if (!canAccess) {
      return json({ error: 'Forbidden' }, 403);
    }

    return json({
      device: normalizeDevice(row)
    });

  } catch (error) {
    console.error('Get device error:', error);
    return json({ error: 'Failed to fetch device' }, 500);
  }
}
export async function updateDevice(request, env, authUser, deviceId) {
  const idValidation = validateId(deviceId);
  if (!idValidation.ok) return json({ error: 'Invalid device ID' }, 400);

  try {
    const device = await env.DB
      .prepare('SELECT * FROM devices WHERE id = ?')
      .bind(idValidation.value)
      .first();

    if (!device) return json({ error: 'Device not found' }, 404);
    const canManage = await canManageHouse(env, authUser, device.house_id);
    if (!canManage) return json({ error: 'Forbidden' }, 403);

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    const columns = await getDeviceColumns(env);
    const nameColumn = getDeviceColumn(columns, 'name', 'device_name');
    const typeColumn = getDeviceColumn(columns, 'type', 'device_type');
    if (!nameColumn || !typeColumn) {
      throw new Error('The device table is missing required name or type columns');
    }

    const updates = [];
    const values = [];
    const requestedName = parsed.data?.name ?? parsed.data?.device_name;
    const requestedType = parsed.data?.type ?? parsed.data?.device_type;
    if (requestedName !== undefined) {
      if (typeof requestedName !== 'string' || !requestedName.trim()) {
        return json({ error: 'Device name cannot be empty' }, 400);
      }
      updates.push(`${nameColumn} = ?`);
      values.push(requestedName.trim());
    }
    if (requestedType !== undefined) {
      if (typeof requestedType !== 'string' || !requestedType.trim()) {
        return json({ error: 'Device type cannot be empty' }, 400);
      }
      updates.push(`${typeColumn} = ?`);
      values.push(requestedType.trim());
    }
    if (typeof parsed.data?.status === 'string' && columns.has('status')) {
      updates.push('status = ?');
      values.push(parsed.data.status);
    }
    if (updates.length) {
      await env.DB
        .prepare(`UPDATE devices SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...values, idValidation.value)
        .run();
    }

    return json({ success: true });
  } catch (error) {
    console.error('Update device error:', error);
    return json({ error: 'Failed to update device' }, 500);
  }
}

export async function deleteDevice(request, env, authUser, deviceId) {
  const idValidation = validateId(deviceId);
  if (!idValidation.ok) return json({ error: 'Invalid device ID' }, 400);

  try {
    const device = await env.DB
      .prepare('SELECT * FROM devices WHERE id = ?')
      .bind(idValidation.value)
      .first();

    if (!device) return json({ error: 'Device not found' }, 404);
    const canManage = await canManageHouse(env, authUser, device.house_id);
    if (!canManage) return json({ error: 'Forbidden' }, 403);

    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(idValidation.value).run();
    return json({ success: true });
  } catch (error) {
    console.error('Delete device error:', error);
    return json({ error: 'Failed to delete device' }, 500);
  }
}


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
