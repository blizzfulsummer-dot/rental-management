import { parseJsonBody, validateId } from '../lib/validation.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { syncFingerprintAuthorizations } from '../lib/fingerprintAuthorization.js';

export async function listProvisionableUsers(request, env, authUser) {
  if (authUser.role !== 'admin' && authUser.role !== 'owner') {
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    if (authUser.role === 'admin') {
      const rows = await env.DB.prepare(`
        SELECT id, email, name, role
        FROM users
        WHERE role IN ('tenant', 'user')
        ORDER BY name, email
      `).all();

      return json({ users: rows.results || [] });
    }

    const rows = await env.DB.prepare(`
      SELECT DISTINCT u.id, u.email, u.name, u.role
      FROM users u
      JOIN user_house_access uha ON uha.user_id = u.id
      JOIN houses h ON h.id = uha.house_id
      WHERE u.role IN ('tenant', 'user')
        AND h.owner_id = ?
      ORDER BY u.name, u.email
    `).bind(authUser.id).all();

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
      return json({ error: 'Property not found' }, 404);
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
        message: 'User assigned to property',
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
      let authorizationSyncPending = false;
      if (env.HOUSE_ROOM) {
        try {
          authorizationSyncPending = !(await syncFingerprintAuthorizations(
            env,
            deviceIdValidation.value,
            Number(device.house_id)
          ));
        } catch (error) {
          authorizationSyncPending = true;
          console.error('Device access fingerprint sync failed:', error);
        }
      }
      await writeAuditLog(env, {
        userId: user.id,
        deviceId: deviceIdValidation.value,
        action: 'device.access_granted',
        outcome: 'success',
        source: 'dashboard',
        details: { changedBy: authUser.id }
      });
      return json({ success: true, user, authorizationSyncPending });
    }

    if (request.method === 'DELETE') {
      const targetIdValidation = validateId(targetUserId);
      if (!targetIdValidation.ok) return json({ error: 'Invalid user ID' }, 400);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM user_device_access WHERE user_id = ? AND device_id = ?')
          .bind(targetIdValidation.value, deviceIdValidation.value),
        env.DB.prepare('DELETE FROM device_fingerprint_enrollments WHERE user_id = ? AND device_id = ?')
          .bind(targetIdValidation.value, deviceIdValidation.value)
      ]);
      let authorizationSyncPending = false;
      if (env.HOUSE_ROOM) {
        try {
          authorizationSyncPending = !(await syncFingerprintAuthorizations(
            env,
            deviceIdValidation.value,
            Number(device.house_id)
          ));
        } catch (error) {
          authorizationSyncPending = true;
          console.error('Device access fingerprint sync failed:', error);
        }
      }
      await writeAuditLog(env, {
        userId: targetIdValidation.value,
        deviceId: deviceIdValidation.value,
        action: 'device.access_revoked',
        outcome: 'success',
        source: 'dashboard',
        details: { changedBy: authUser.id }
      });
      return json({ success: true, authorizationSyncPending });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('Manage device access error:', error);
    return json({ error: 'Failed to manage device access' }, 500);
  }
}


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
