import { parseJsonBody, validatePassword, validateTenantPayload, validateId, sanitizeString } from '../lib/validation.js';
import { hashPBKDF2, verifyPBKDF2, arrayBufferToHex, hexToArrayBuffer } from '../lib/crypto.js';
import { isTenantOwnedByUser, isHouseOwnedByUser } from './access-control.js';
import { getPropertyIdValue } from './property-compat.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
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

  const propertyIdValue = getPropertyIdValue(parsed.data);
  const {
    balance,
    deposit,
    rent_amount,
    billing_cycle,
    leased_unit,
    onboard_date
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
      const propertyIdValidation = validateId(propertyIdValue);

      if (!propertyIdValidation.ok) {
        return json({
          error: 'Valid property_id is required for owner-created tenants'
        }, 400);
      }

      const hasAccess = await isHouseOwnedByUser(
        env,
        authUser.id,
        propertyIdValidation.value
      );

      if (!hasAccess) {
        return json({ error: 'Forbidden' }, 403);
      }

      validatedHouseId = propertyIdValidation.value;
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
