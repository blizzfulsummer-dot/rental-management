import { parseJsonBody, validatePassword, validateTenantPayload, validateId, sanitizeString } from './lib/validation.js';
import { hashPBKDF2, verifyPBKDF2, arrayBufferToHex, hexToArrayBuffer } from './lib/crypto.js';

async function isTenantOwnedByUser(env, userId, tenantUserId) {
  const row = await env.DB
    .prepare(`
      SELECT 1
      FROM user_house_access uha
      JOIN houses h ON h.id = uha.house_id
      WHERE uha.user_id = ? AND h.owner_id = ?
      LIMIT 1
    `)
    .bind(tenantUserId, userId)
    .first();

  return Boolean(row);
}

async function isHouseOwnedByUser(env, userId, houseId) {
  const row = await env.DB
    .prepare('SELECT id FROM houses WHERE id = ? AND owner_id = ?')
    .bind(houseId, userId)
    .first();

  return Boolean(row);
}

async function canManageHouse(env, authUser, houseId) {
  return authUser.role === 'admin' || (
    authUser.role === 'owner' &&
    await isHouseOwnedByUser(env, authUser.id, houseId)
  );
}

async function userHasDeviceAccess(env, userId, deviceId) {
  const row = await env.DB
    .prepare('SELECT 1 FROM user_device_access WHERE user_id = ? AND device_id = ?')
    .bind(userId, deviceId)
    .first();

  return Boolean(row);
}

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


export async function createTenant(request, env, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const validation = validateTenantPayload(parsed.data);
  if (!validation.ok) {
    return json({
      error: 'Invalid tenant payload',
      details: validation.errors
    }, 400);
  }

  const {
    balance,
    deposit,
    rent_amount,
    billing_cycle,
    leased_unit,
    onboard_date,
    house_id
  } = parsed.data;

  const userIdValidation = validateId(parsed.data.user_id);

  if (!userIdValidation.ok) {
    return json({ error: 'Valid user_id is required' }, 400);
  }

  try {
    // Verify the target account exists and has an eligible role.
    const tenantUser = await env.DB
      .prepare(`
        SELECT id, role
        FROM users
        WHERE id = ?
      `)
      .bind(userIdValidation.value)
      .first();

    if (!tenantUser) {
      return json({ error: 'User not found' }, 404);
    }

    if (!['user', 'tenant'].includes(tenantUser.role)) {
      return json({
        error: 'Only regular users or tenant accounts can be assigned as tenants'
      }, 400);
    }

    let validatedHouseId = null;

    if (authUser.role === 'owner') {
      const houseIdValidation = validateId(house_id);

      if (!houseIdValidation.ok) {
        return json({
          error: 'Valid house_id is required for owner-created tenants'
        }, 400);
      }

      const hasAccess = await isHouseOwnedByUser(
        env,
        authUser.id,
        houseIdValidation.value
      );

      if (!hasAccess) {
        return json({ error: 'Forbidden' }, 403);
      }

      validatedHouseId = houseIdValidation.value;
    }

    await env.DB
      .prepare(`
        INSERT INTO tenants
          (user_id, balance, deposit, rent_amount, billing_cycle, leased_unit, onboard_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        tenantUser.id,
        balance ?? 0,
        deposit ?? 0,
        rent_amount,
        billing_cycle ?? 'monthly',
        leased_unit,
        onboard_date,
        new Date().toISOString()
      )
      .run();

    // Give the tenant access only to the Owner's property.
    if (validatedHouseId !== null) {
      await env.DB
        .prepare(`
          INSERT OR IGNORE INTO user_house_access
            (user_id, house_id, access_level, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .bind(
          tenantUser.id,
          validatedHouseId,
          'tenant',
          new Date().toISOString()
        )
        .run();
    }

    return json({ success: true });

  } catch (error) {
    console.error('Create tenant error:', error);
    return json({ error: 'Failed to create tenant' }, 500);
  }
}


export async function listTenants(request, env, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    let rows;

    if (authUser.role === 'admin') {
      rows = await env.DB
        .prepare(`
          SELECT
            t.id,
            u.email,
            u.name,
            u.role,
            t.balance,
            t.rent_amount,
            t.leased_unit,
            t.onboard_date
          FROM tenants t
          JOIN users u ON u.id = t.user_id
          ORDER BY t.created_at DESC
        `)
        .all();
    } else {
      rows = await env.DB
        .prepare(`
          SELECT DISTINCT
            t.id,
            u.email,
            u.name,
            u.role,
            t.balance,
            t.rent_amount,
            t.leased_unit,
            t.onboard_date
          FROM tenants t
          JOIN users u ON u.id = t.user_id
          JOIN user_house_access uha ON uha.user_id = t.user_id
          JOIN houses h ON h.id = uha.house_id
          WHERE h.owner_id = ?
          ORDER BY t.created_at DESC
        `)
        .bind(authUser.id)
        .all();
    }

    return json({ tenants: rows.results });
  } catch (error) {
    console.error('List tenants error:', error);
    return json({ error: 'Failed to fetch tenants' }, 500);
  }
}

export async function getTenant(request, env, authUser, tenantId) {
  const idValidation = validateId(tenantId);
  if (!idValidation.ok) return json({ error: 'Invalid tenant ID' }, 400);

  try {
    const row = await env.DB
      .prepare(`
        SELECT t.*, u.email, u.name, u.role
        FROM tenants t
        JOIN users u ON u.id = t.user_id
        WHERE t.id = ?
      `)
      .bind(idValidation.value)
      .first();

    if (!row) return json({ error: 'Tenant not found' }, 404);

    const canAccess = authUser.role === 'admin' || row.user_id === authUser.id || (authUser.role === 'owner' && await isTenantOwnedByUser(env, authUser.id, row.user_id));
    if (!canAccess) {
      return json({ error: 'Forbidden' }, 403);
    }

    if (authUser.role === 'admin' || authUser.role === 'owner') {
      return json({ tenant: row });
    }

    return json({
      tenant: {
        id: row.id,
        user_id: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
        leased_unit: row.leased_unit,
        onboard_date: row.onboard_date,
        billing_cycle: row.billing_cycle
      }
    });
  } catch (error) {
    console.error('Get tenant error:', error);
    return json({ error: 'Failed to fetch tenant' }, 500);
  }
}

export async function updateTenant(request, env, authUser, tenantId) {
  const idValidation = validateId(tenantId);
  if (!idValidation.ok) return json({ error: 'Invalid tenant ID' }, 400);

  try {
    const tenant = await env.DB
      .prepare('SELECT id, user_id FROM tenants WHERE id = ?')
      .bind(idValidation.value)
      .first();

    if (!tenant) return json({ error: 'Tenant not found' }, 404);

    const canManage = authUser.role === 'admin' || tenant.user_id === authUser.id || (authUser.role === 'owner' && await isTenantOwnedByUser(env, authUser.id, tenant.user_id));
    if (!canManage) {
      return json({ error: 'Forbidden' }, 403);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    if (authUser.role === 'admin' || authUser.role === 'owner') {
      await env.DB
        .prepare(`
          UPDATE tenants SET
            balance = ?,
            deposit = ?,
            rent_amount = ?,
            billing_cycle = ?,
            leased_unit = ?
          WHERE id = ?
        `)
        .bind(
          parsed.data.balance,
          parsed.data.deposit,
          parsed.data.rent_amount,
          parsed.data.billing_cycle,
          parsed.data.leased_unit,
          idValidation.value
        )
        .run();

      return json({ success: true });
    }

    const currentPassword = parsed.data?.currentPassword ?? parsed.data?.oldPassword;
    const newPassword = parsed.data?.newPassword ?? parsed.data?.password;

    if (!currentPassword || !newPassword) {
      return json({ error: 'Missing password fields' }, 400);
    }

    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.ok) {
      return json({ error: 'Password is too weak' }, 400);
    }

    const userRow = await env.DB
      .prepare('SELECT id, password_hash, password_salt FROM users WHERE id = ?')
      .bind(tenant.user_id)
      .first();

    if (!userRow) return json({ error: 'User not found' }, 404);

    const valid = await verifyPBKDF2(userRow.password_hash, userRow.password_salt, currentPassword);
    if (!valid) return json({ error: 'Current password is incorrect' }, 401);

    const { hash: derivedBits, salt } = await hashPBKDF2(newPassword);
    await env.DB
      .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .bind(arrayBufferToHex(derivedBits), arrayBufferToHex(salt), userRow.id)
      .run();

    return json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Update tenant error:', error);
    return json({ error: 'Failed to update tenant' }, 500);
  }
}


export async function deleteTenant(request, env, authUser, tenantId) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  const idValidation = validateId(tenantId);
  if (!idValidation.ok) {
    return json({ error: 'Invalid tenant ID' }, 400);
  }

  try {
    const tenant = await env.DB
      .prepare('SELECT user_id FROM tenants WHERE id = ?')
      .bind(idValidation.value)
      .first();

    if (!tenant) {
      return json({ error: 'Tenant not found' }, 404);
    }

    if (authUser.role === 'owner') {
      const isOwner = await isTenantOwnedByUser(
        env,
        authUser.id,
        tenant.user_id
      );

      if (!isOwner) {
        return json({ error: 'Forbidden' }, 403);
      }
    }

    await env.DB
      .prepare('DELETE FROM tenants WHERE id = ?')
      .bind(idValidation.value)
      .run();

    // Only remove property access belonging to this Owner.
    // Admin deletion preserves access assignments across properties.
    if (authUser.role === 'owner') {
      await env.DB
        .prepare(`
          DELETE FROM user_house_access
          WHERE user_id = ?
            AND house_id IN (
              SELECT id
              FROM houses
              WHERE owner_id = ?
            )
        `)
        .bind(tenant.user_id, authUser.id)
        .run();
    }

    return json({ success: true });

  } catch (error) {
    console.error('Delete tenant error:', error);
    return json({ error: 'Failed to delete tenant' }, 500);
  }
}

async function userHasHouseAccess(env, userId, houseId) {
  if (!userId || !houseId) return false;

  const row = await env.DB
    .prepare(`
      SELECT 1
      FROM user_house_access
      WHERE user_id = ? AND house_id = ?
      LIMIT 1
    `)
    .bind(userId, houseId)
    .first();

  return Boolean(row);
}

export async function listHouses(request, env, authUser) {
  try {
    const normalizeHouse = (house) => ({
      ...house,
      location: house.location ?? house.address ?? null
    });

    if (authUser.role === 'admin') {
      const rows = await env.DB
        .prepare(`
          SELECT h.*
          FROM houses h
          ORDER BY h.created_at DESC
        `)
        .all();

      return json({ houses: (rows.results || []).map(normalizeHouse) });
    }

    if (authUser.role === 'owner') {
      const rows = await env.DB
        .prepare(`
          SELECT h.*
          FROM houses h
          WHERE h.owner_id = ?
          ORDER BY h.created_at DESC
        `)
        .bind(authUser.id)
        .all();

      return json({ houses: (rows.results || []).map(normalizeHouse) });
    }

    const rows = await env.DB
      .prepare(`
        SELECT DISTINCT h.*
        FROM houses h
        LEFT JOIN user_house_access uha ON uha.house_id = h.id
        WHERE uha.user_id = ?
           OR EXISTS (
             SELECT 1
             FROM devices d
             JOIN user_device_access uda ON uda.device_id = d.id
             WHERE d.house_id = h.id AND uda.user_id = ?
           )
        ORDER BY h.created_at DESC
      `)
      .bind(authUser.id, authUser.id)
      .all();

    return json({ houses: (rows.results || []).map(normalizeHouse) });

  } catch (error) {
    console.error('List houses error:', error);
    return json({ error: 'Failed to fetch houses' }, 500);
  }
}

export async function createHouse(request, env, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const name = typeof parsed.data?.name === 'string'
    ? parsed.data.name.trim()
    : '';

  const addressValue = parsed.data?.address ?? parsed.data?.location;
  const address = typeof addressValue === 'string'
    ? addressValue.trim()
    : null;

  if (!name) {
    return json({ error: 'House name is required' }, 400);
  }

  try {
    let ownerId = authUser.id;

    // Only Admin can assign a property to another Owner.
    if (authUser.role === 'admin' && parsed.data?.owner_id != null) {
      const ownerIdValidation = validateId(parsed.data.owner_id);

      if (!ownerIdValidation.ok) {
        return json({ error: 'Invalid owner ID' }, 400);
      }

      const owner = await env.DB
        .prepare(`
          SELECT id
          FROM users
          WHERE id = ? AND role = 'owner'
        `)
        .bind(ownerIdValidation.value)
        .first();

      if (!owner) {
        return json({ error: 'Owner account not found' }, 404);
      }

      ownerId = owner.id;
    }

    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

    const houseUid = `HSE-${Array.from(
      crypto.getRandomValues(new Uint8Array(5))
    ).map(byte => alphabet[byte % alphabet.length]).join('')}`;

    const result = await env.DB
      .prepare(`
        INSERT INTO houses (name, address, owner_id, house_uid, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(name, address, ownerId, houseUid, new Date().toISOString())
      .run();

    const house = await env.DB
      .prepare('SELECT * FROM houses WHERE id = ?')
      .bind(result.meta?.last_row_id)
      .first();

    return json({
      success: true,
      house: {
        ...house,
        location: house.address ?? null
      }
    }, 201);

  } catch (error) {
    console.error('Create house error:', error);
    return json({ error: 'Failed to create house' }, 500);
  }
}

export async function getHouse(request, env, authUser, houseId) {
  const idValidation = validateId(houseId);
  if (!idValidation.ok) return json({ error: 'Invalid house ID' }, 400);

  try {
    const row = await env.DB
      .prepare('SELECT * FROM houses WHERE id = ?')
      .bind(idValidation.value)
      .first();

    if (!row) return json({ error: 'House not found' }, 404);

    let canAccess = false;

    if (authUser.role === 'admin') {
      canAccess = true;
    } else if (authUser.role === 'owner') {
      canAccess = Number(row.owner_id) === Number(authUser.id);
    } else {
      canAccess = await userHasHouseAccess(
        env,
        authUser.id,
        row.id
      );
    }

    if (!canAccess) {
      return json({ error: 'Forbidden' }, 403);
    }

    return json({
      house: {
        ...row,
        location: row.address ?? null
      }
    });

  } catch (error) {
    console.error('Get house error:', error);
    return json({ error: 'Failed to fetch house' }, 500);
  }
}

export async function updateHouse(request, env, authUser, houseId) {
  const idValidation = validateId(houseId);
  if (!idValidation.ok) return json({ error: 'Invalid house ID' }, 400);

  try {
    const house = await env.DB
      .prepare('SELECT * FROM houses WHERE id = ?')
      .bind(idValidation.value)
      .first();

    if (!house) return json({ error: 'House not found' }, 404);

    if (
      authUser.role !== 'admin' &&
      (
        authUser.role !== 'owner' ||
        Number(house.owner_id) !== Number(authUser.id)
      )
    ) {
      return json({ error: 'Forbidden' }, 403);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    const name = typeof parsed.data?.name === 'string'
      ? parsed.data.name.trim()
      : house.name;

    const addressValue = parsed.data?.address ?? parsed.data?.location;

    const address = typeof addressValue === 'string'
      ? addressValue.trim()
      : house.address;

    if (!name) {
      return json({ error: 'House name is required' }, 400);
    }

    await env.DB
      .prepare('UPDATE houses SET name = ?, address = ? WHERE id = ?')
      .bind(name, address, idValidation.value)
      .run();

    return json({ success: true });

  } catch (error) {
    console.error('Update house error:', error);
    return json({ error: 'Failed to update house' }, 500);
  }
}

export async function deleteHouse(request, env, authUser, houseId) {
  const idValidation = validateId(houseId);
  if (!idValidation.ok) return json({ error: 'Invalid house ID' }, 400);

  try {
    const house = await env.DB
      .prepare('SELECT * FROM houses WHERE id = ?')
      .bind(idValidation.value)
      .first();

    if (!house) return json({ error: 'House not found' }, 404);

    if (
      authUser.role !== 'admin' &&
      (
        authUser.role !== 'owner' ||
        Number(house.owner_id) !== Number(authUser.id)
      )
    ) {
      return json({ error: 'Forbidden' }, 403);
    }

    await env.DB
      .prepare('DELETE FROM devices WHERE house_id = ?')
      .bind(idValidation.value)
      .run();

    await env.DB
      .prepare('DELETE FROM user_house_access WHERE house_id = ?')
      .bind(idValidation.value)
      .run();

    await env.DB
      .prepare('DELETE FROM houses WHERE id = ?')
      .bind(idValidation.value)
      .run();

    return json({ success: true });

  } catch (error) {
    console.error('Delete house error:', error);
    return json({ error: 'Failed to delete house' }, 500);
  }
}



export async function listHouseDevices(env, authUser, houseId) {
  const validation = validateId(houseId);

  if (!validation.ok) {
    return { status: 400, error: 'Invalid house ID' };
  }

  const id = validation.value;

  // Admin: all devices.
  if (authUser.role === 'admin') {
    const devices = await env.DB.prepare(`
      SELECT *, name AS device_name
      FROM devices
      WHERE house_id = ?
      ORDER BY created_at DESC
    `).bind(id).all();

    return { status: 200, data: devices.results || [] };
  }

  // Owner: all devices in their own property.
  if (authUser.role === 'owner') {
    const house = await env.DB.prepare(`
      SELECT id
      FROM houses
      WHERE id = ? AND owner_id = ?
    `).bind(id, authUser.id).first();

    if (!house) {
      return { status: 403, error: 'Forbidden' };
    }

    const devices = await env.DB.prepare(`
      SELECT *, name AS device_name
      FROM devices
      WHERE house_id = ?
      ORDER BY created_at DESC
    `).bind(id).all();

    return { status: 200, data: devices.results || [] };
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
    return { status: 403, error: 'Forbidden' };
  }

  // Only explicitly authorized devices are returned.
  const devices = await env.DB.prepare(`
    SELECT d.*, d.name AS device_name
    FROM devices d
    JOIN user_device_access uda ON uda.device_id = d.id
    WHERE d.house_id = ?
      AND uda.user_id = ?
    ORDER BY d.created_at DESC
  `).bind(id, authUser.id).all();

  return { status: 200, data: devices.results || [] };
}

export async function listProvisionableUsers(request, env, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    const rows = await env.DB.prepare(`
      SELECT id, email, name, role
      FROM users
      WHERE role = 'user'
      ORDER BY name, email
    `).all();

    return json({ users: rows.results || [] });
  } catch (error) {
    console.error('List provisionable users error:', error);
    return json({ error: 'Failed to fetch provisionable users' }, 500);
  }
}

export async function manageHouseAccess(
  request,
  env,
  authUser,
  houseId,
  targetUserId = null
) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  const houseIdValidation = validateId(houseId);
  if (!houseIdValidation.ok) {
    return json({ error: 'Invalid house ID' }, 400);
  }

  try {
    // Verify the house exists and enforce ownership for owners.
    const house = await env.DB
      .prepare('SELECT id, owner_id, name FROM houses WHERE id = ?')
      .bind(houseIdValidation.value)
      .first();

    if (!house) {
      return json({ error: 'House not found' }, 404);
    }

    if (
      authUser.role === 'owner' &&
      Number(house.owner_id) !== Number(authUser.id)
    ) {
      return json({ error: 'Forbidden' }, 403);
    }

    // GET: List regular users assigned to this house.
    if (request.method === 'GET') {
      const rows = await env.DB
        .prepare(`
          SELECT
            u.id,
            u.email,
            u.name,
            u.role,
            uha.access_level,
            uha.created_at AS assigned_at
          FROM user_house_access uha
          JOIN users u ON u.id = uha.user_id
          WHERE uha.house_id = ?
            AND u.role = 'user'
          ORDER BY u.name, u.email
        `)
        .bind(houseIdValidation.value)
        .all();

      return json({
        house: {
          id: house.id,
          name: house.name
        },
        users: rows.results || []
      });
    }

    // POST: Assign a regular user to this house.
    if (request.method === 'POST') {
      const parsed = await parseJsonBody(request);
      if (!parsed.ok) {
        return json({ error: parsed.error }, 400);
      }

      const userIdValidation = validateId(parsed.data?.user_id);
      if (!userIdValidation.ok) {
        return json({ error: 'Valid user_id is required' }, 400);
      }

      const user = await env.DB
        .prepare(`
          SELECT id, email, name, role
          FROM users
          WHERE id = ? AND role = 'user'
        `)
        .bind(userIdValidation.value)
        .first();

      if (!user) {
        return json({
          error: 'User not found or account is not a regular user'
        }, 404);
      }

      await env.DB
        .prepare(`
          INSERT OR IGNORE INTO user_house_access
            (user_id, house_id, access_level, created_at)
          VALUES (?, ?, 'viewer', ?)
        `)
        .bind(
          user.id,
          houseIdValidation.value,
          new Date().toISOString()
        )
        .run();

      return json({
        success: true,
        message: 'User assigned to house',
        user
      });
    }

    // DELETE: Remove only this user's access to this house.
    // DELETE: Remove only this regular user's access to this house.
if (request.method === 'DELETE') {
  const userIdValidation = validateId(targetUserId);
  if (!userIdValidation.ok) {
    return json({ error: 'Invalid user ID' }, 400);
  }

  const result = await env.DB
    .prepare(`
      DELETE FROM user_house_access
      WHERE user_id = ?
        AND house_id = ?
        AND user_id IN (
          SELECT id FROM users WHERE role = 'user'
        )
    `)
    .bind(
      userIdValidation.value,
      houseIdValidation.value
    )
    .run();

  return json({
    success: true,
    removed: (result.meta?.changes ?? 0) > 0
  });
}

    return json({ error: 'Method not allowed' }, 405);

  } catch (error) {
    console.error('Manage house access error:', error);
    return json({ error: 'Failed to manage house access' }, 500);
  }
}


async function isUserProvisionableToOwner(env, ownerId, userId) {
  const row = await env.DB.prepare(`
    SELECT 1
    FROM users u
    WHERE u.id = ?
      AND u.role IN ('tenant', 'user')
      AND (
        EXISTS (
          SELECT 1
          FROM user_house_access uha
          JOIN houses h ON h.id = uha.house_id
          WHERE uha.user_id = u.id AND h.owner_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM user_device_access uda
          JOIN devices d ON d.id = uda.device_id
          JOIN houses h ON h.id = d.house_id
          WHERE uda.user_id = u.id AND h.owner_id = ?
        )
      )
  `).bind(userId, ownerId, ownerId).first();
  return Boolean(row);
}

export async function manageDeviceAccess(request, env, authUser, deviceId, targetUserId = null) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  const deviceIdValidation = validateId(deviceId);
  if (!deviceIdValidation.ok) return json({ error: 'Invalid device ID' }, 400);

  try {
    const device = await env.DB.prepare(`
      SELECT d.id, d.house_id
      FROM devices d
      JOIN houses h ON h.id = d.house_id
      WHERE d.id = ? ${authUser.role === 'owner' ? 'AND h.owner_id = ?' : ''}
    `).bind(...(authUser.role === 'owner' ? [deviceIdValidation.value, authUser.id] : [deviceIdValidation.value])).first();
    if (!device) return json({ error: 'Device not found or not managed by this account' }, 404);

    if (request.method === 'GET') {
      const rows = await env.DB.prepare(`
        SELECT u.id, u.email, u.name, u.role
        FROM user_device_access uda
        JOIN users u ON u.id = uda.user_id
        WHERE uda.device_id = ?
        ORDER BY u.name, u.email
      `).bind(deviceIdValidation.value).all();
      return json({ users: rows.results || [] });
    }

    if (request.method === 'POST') {
      const parsed = await parseJsonBody(request);
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const targetIdValidation = validateId(parsed.data?.user_id);
      if (!targetIdValidation.ok) return json({ error: 'Valid user_id is required' }, 400);

      let user;
      if (authUser.role === 'admin' || await isUserProvisionableToOwner(env, authUser.id, targetIdValidation.value)) {
        user = await env.DB.prepare("SELECT id, email, name, role FROM users WHERE id = ? AND role IN ('tenant', 'user')")
          .bind(targetIdValidation.value).first();
      }
      if (!user) return json({ error: 'User is not eligible for device access' }, 403);

      await env.DB.prepare(`
        INSERT OR IGNORE INTO user_device_access (user_id, device_id)
        VALUES (?, ?)
      `).bind(user.id, deviceIdValidation.value).run();
      return json({ success: true, user });
    }

    if (request.method === 'DELETE') {
      const targetIdValidation = validateId(targetUserId);
      if (!targetIdValidation.ok) return json({ error: 'Invalid user ID' }, 400);
      await env.DB.prepare('DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?')
        .bind(targetIdValidation.value, deviceIdValidation.value).run();
      return json({ success: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('Manage device access error:', error);
    return json({ error: 'Failed to manage device access' }, 500);
  }
}

export async function createDevice(request, env, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const houseId = parsed.data?.house_id;
  if (!houseId) return json({ error: 'house_id is required' }, 400);

  const idValidation = validateId(houseId);
  if (!idValidation.ok) return json({ error: 'Invalid house ID' }, 400);

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
