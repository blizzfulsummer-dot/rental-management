import { parseJsonBody, validateEmail, validateId, validateTenantPayload, sanitizeString } from '../lib/validation.js';
import { hashPBKDF2, arrayBufferToHex, generateTempPassword } from '../lib/crypto.js';
import { sendTemporaryPasswordEmail } from '../lib/email.js';
import { getUserAccountState, setUserAccountState } from './account-status.js';
import { writeAuditLog } from '../lib/auditLog.js';
import {
  syncFingerprintAuthorizations,
  syncUserFingerprintAuthorizations
} from '../lib/fingerprintAuthorization.js';

async function runDbBatch(env, statements) {
  if (typeof env.DB.batch === 'function') {
    return env.DB.batch(statements);
  }

  const results = [];
  for (const statement of statements) {
    results.push(await statement.run());
  }
  return results;
}


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function registerProvisionedAccount(request, env, authUser) {


  if (!authUser?.id || !['admin', 'owner'].includes(String(authUser.role).toLowerCase())) {
    return json({ error: 'You are not authorized to register accounts' }, 403);
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const payload = parsed.data || {};
  const creatorRole = String(authUser.role).toLowerCase();
  const role = String(payload.role || '').trim().toLowerCase();

  if (!['user', 'tenant', 'owner'].includes(role)) {
    return json({ error: 'Invalid account role' }, 400);
  }

  if (role === 'owner' && creatorRole !== 'admin') {
    return json({ error: 'Only admins can register owners' }, 403);
  }

  const nameResult = sanitizeString(payload.name, 'name', 100);
  if (!nameResult.ok) {
    return json({ error: nameResult.error }, 400);
  }

  const emailResult = validateEmail(payload.email);
  if (!emailResult.ok) {
    return json({ error: 'Invalid email address' }, 400);
  }

  const normalizedEmail = String(payload.email).trim().toLowerCase();
  let tenantHouseId = null;

  if (role === 'tenant') {
    const tenantValidation = validateTenantPayload(payload);

    if (!tenantValidation.ok) {
      return json({
        error: 'Invalid tenant information',
        details: tenantValidation.errors
      }, 400);
    }

    const propertyIdValue = payload.property_id ?? payload.house_id;
    const propertyValidation = validateId(propertyIdValue);

    if (!propertyValidation.ok) {
      return json({ error: 'A valid property is required for tenant registration' }, 400);
    }

    tenantHouseId = propertyValidation.value;

    const onboardDate = new Date(payload.onboard_date);
    if (Number.isNaN(onboardDate.getTime())) {
      return json({ error: 'Invalid tenant move-in date' }, 400);
    }

    const house = creatorRole === 'owner'
      ? await env.DB.prepare(
          'SELECT id FROM houses WHERE id = ? AND owner_id = ?'
        ).bind(tenantHouseId, authUser.id).first()
      : await env.DB.prepare(
          'SELECT id FROM houses WHERE id = ?'
        ).bind(tenantHouseId).first();

    if (!house) {
      return json({
        error: creatorRole === 'owner'
          ? 'You can only register tenants for houses you own'
          : 'Property not found'
      }, creatorRole === 'owner' ? 403 : 404);
    }
  }

  let provisionedPropertyIds = [];
  if (role === 'user') {
    const rawPropertyIds = Array.isArray(payload.property_ids)
      ? payload.property_ids
      : Array.isArray(payload.house_ids)
        ? payload.house_ids
        : (payload.property_id ?? payload.house_id ? [payload.property_id ?? payload.house_id] : []);

    provisionedPropertyIds = [...new Set(rawPropertyIds.map(value => Number(value)).filter(value => Number.isSafeInteger(value) && value > 0))];
    if (!provisionedPropertyIds.length) {
      return json({ error: 'At least one valid property is required for a regular user' }, 400);
    }

    for (const propertyId of provisionedPropertyIds) {
      const house = creatorRole === 'owner'
        ? await env.DB.prepare('SELECT id FROM houses WHERE id = ? AND owner_id = ?').bind(propertyId, authUser.id).first()
        : await env.DB.prepare('SELECT id FROM houses WHERE id = ?').bind(propertyId).first();
      if (!house) return json({ error: creatorRole === 'owner'
        ? 'You can only assign users to properties you own'
        : 'Property not found' }, creatorRole === 'owner' ? 403 : 404);
    }
  }

  let createdUserId = null;

  try {
    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).bind(normalizedEmail).first();

    if (existing) {
      return json({ error: 'Email already exists' }, 409);
    }

    const tempPassword = generateTempPassword();
    const { hash, salt } = await hashPBKDF2(tempPassword);

    const now = new Date().toISOString();
    const expiration = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const userInsert = await env.DB.prepare(`
      INSERT INTO users (
        email,
        password_hash,
        password_salt,
        role,
        created_at,
        name,
        requires_change_password,
        temp_password_expiration
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      normalizedEmail,
      arrayBufferToHex(hash),
      arrayBufferToHex(salt),
      role,
      now,
      nameResult.value,
      expiration
    ).run();

    createdUserId = userInsert.meta?.last_row_id;

    if (!createdUserId) {
      throw new Error('Could not retrieve the newly created user ID');
    }

    if (role === 'tenant') {
      await env.DB.prepare(`
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        createdUserId,
        Number(payload.balance),
        Number(payload.deposit),
        Number(payload.rent_amount),
        String(payload.billing_cycle).trim(),
        String(payload.leased_unit).trim(),
        new Date(payload.onboard_date).toISOString(),
        now
      ).run();

      // Both admins and owners must create the tenant's house access.
      await env.DB.prepare(`
        INSERT INTO user_house_access (
          user_id,
          house_id,
          access_level,
          created_at
        )
        VALUES (?, ?, 'tenant', ?)
      `).bind(createdUserId, tenantHouseId, now).run();
    }

    if (role === 'user') {
      for (const houseId of provisionedPropertyIds) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO user_house_access (user_id, house_id, access_level, created_at)
          VALUES (?, ?, 'viewer', ?)
        `).bind(createdUserId, houseId, now).run();
      }
    }

    let emailSent = false;

try {
  const emailResult = await sendTemporaryPasswordEmail({
    env,
    name: nameResult.value,
    email: normalizedEmail,
    role,
    tempPassword
  });

  emailSent = Boolean(emailResult);
} catch (emailError) {
  console.error('Temporary password email failed:', emailError.message);
}

    return json({
  success: true,
  message: emailSent
    ? `${role.charAt(0).toUpperCase() + role.slice(1)} account created and credentials emailed successfully`
    : 'Account created, but email delivery failed. Use the temporary password below.',
  emailSent,
  tempPassword,
  user: {
    id: createdUserId,
    name: nameResult.value,
    email: normalizedEmail,
    role
  }
});

  } catch (error) {
    console.error('Account provisioning error:', error);

    // Remove partial records if tenant creation or access assignment failed.
    if (createdUserId) {
      try {
        await env.DB.prepare(
          'DELETE FROM user_house_access WHERE user_id = ?'
        ).bind(createdUserId).run();

        await env.DB.prepare(
          'DELETE FROM tenants WHERE user_id = ?'
        ).bind(createdUserId).run();

        await env.DB.prepare(
          'DELETE FROM users WHERE id = ?'
        ).bind(createdUserId).run();
      } catch (cleanupError) {
        console.error('Provisioning cleanup error:', cleanupError);
      }
    }

    return json({ error: 'Failed to register account' }, 500);
  }
}

export async function listManagedAccounts(request, env, authUser) {
  const actorRole = String(authUser?.role || '').toLowerCase();
  if (!['admin', 'owner'].includes(actorRole)) {
    return json({ error: 'Forbidden' }, 403);
  }

  try {
    const rows = actorRole === 'admin'
      ? await env.DB.prepare(`
          SELECT u.id, u.name, u.email, u.role,
                 t.id AS tenant_id, t.balance, t.deposit, t.rent_amount,
                 t.billing_cycle, t.leased_unit, t.onboard_date
          FROM users u
          LEFT JOIN tenants t ON t.user_id = u.id
          WHERE u.role IN ('owner', 'tenant', 'user')
          ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'tenant' THEN 1 ELSE 2 END,
                   COALESCE(u.name, u.email)
        `).all()
      : await env.DB.prepare(`
          SELECT DISTINCT u.id, u.name, u.email, u.role,
                 t.id AS tenant_id, t.balance, t.deposit, t.rent_amount,
                 t.billing_cycle, t.leased_unit, t.onboard_date
          FROM users u
          LEFT JOIN tenants t ON t.user_id = u.id
          WHERE u.role IN ('tenant', 'user')
            AND (
              EXISTS (
                SELECT 1 FROM user_house_access uha
                JOIN houses h ON h.id = uha.house_id
                WHERE uha.user_id = u.id AND h.owner_id = ?
              ) OR EXISTS (
                SELECT 1 FROM user_device_access uda
                JOIN devices d ON d.id = uda.device_id
                JOIN houses h ON h.id = d.house_id
                WHERE uda.user_id = u.id AND h.owner_id = ?
              )
            )
          ORDER BY CASE u.role WHEN 'tenant' THEN 0 ELSE 1 END,
                   COALESCE(u.name, u.email)
        `).bind(authUser.id, authUser.id).all();

    const accounts = [];
    for (const row of rows.results || []) {
      const access = await env.DB.prepare(`
        SELECT h.id, h.name
        FROM user_house_access uha
        JOIN houses h ON h.id = uha.house_id
        WHERE uha.user_id = ?
        ORDER BY h.name
      `).bind(row.id).all();
      const accountState = await getUserAccountState(env, row.id);
      const propertyIds = (access.results || []).map(h => h.id);
      accounts.push({
        ...row,
        status: accountState.status,
        is_active: accountState.active ? 1 : 0,
        property_ids: propertyIds,
        house_ids: propertyIds,
        property_names: (access.results || []).map(h => h.name),
        house_names: (access.results || []).map(h => h.name)
      });
    }
    return json({ accounts });
  } catch (error) {
    console.error('List managed accounts error:', error);
    return json({ error: 'Failed to fetch accounts' }, 500);
  }
}

export async function setManagedAccountStatus(env, authUser, targetUserId, nextStatus) {
  const actorRole = String(authUser?.role || '').toLowerCase();
  if (!['admin', 'owner'].includes(actorRole)) return json({ error: 'Forbidden' }, 403);

  const id = Number(targetUserId);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'Invalid account ID' }, 400);

  const normalizedStatus = String(nextStatus || '').trim().toLowerCase();
  if (!['active', 'suspended'].includes(normalizedStatus)) {
    return json({ error: 'Status must be either active or suspended' }, 400);
  }

  try {
    const target = await env.DB.prepare('SELECT id, role, email FROM users WHERE id = ?').bind(id).first();
    if (!target) return json({ error: 'Account not found' }, 404);

    if (actorRole === 'owner') {
      if (String(target.role || '').toLowerCase() === 'owner') {
        return json({ error: 'Owners cannot change owner account status' }, 403);
      }

      const managed = await env.DB.prepare(`
        SELECT 1
        FROM user_house_access uha
        JOIN houses h ON h.id = uha.house_id
        WHERE uha.user_id = ? AND h.owner_id = ?
        UNION
        SELECT 1
        FROM user_device_access uda
        JOIN devices d ON d.id = uda.device_id
        JOIN houses h ON h.id = d.house_id
        WHERE uda.user_id = ? AND h.owner_id = ?
        LIMIT 1
      `).bind(id, authUser.id, id, authUser.id).first();

      if (!managed) {
        return json({ error: 'You can only manage accounts assigned to your properties' }, 403);
      }
    }

    const applied = await setUserAccountState(env, id, normalizedStatus);
    if (!applied) {
      return json({ error: 'Account status storage is not available in the current schema' }, 500);
    }

    await env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(id).run();

    const authorizationSyncPending = env.HOUSE_ROOM
      ? !(await syncUserFingerprintAuthorizations(env, id))
      : false;
    await writeAuditLog(env, {
      userId: id,
      action: 'account.status_changed',
      outcome: 'success',
      source: 'dashboard',
      details: { status: normalizedStatus, changedBy: authUser.id }
    });

    return json({
      success: true,
      userId: id,
      status: normalizedStatus,
      authorizationSyncPending
    });
  } catch (error) {
    console.error('Account status update error:', error);
    return json({ error: 'Failed to update account status' }, 500);
  }
}

export async function suspendAccount(request, env, authUser, targetUserId) {
  return setManagedAccountStatus(env, authUser, targetUserId, 'suspended');
}

export async function reactivateAccount(request, env, authUser, targetUserId) {
  return setManagedAccountStatus(env, authUser, targetUserId, 'active');
}

export async function deleteManagedAccount(request, env, authUser, targetUserId) {
  const actorRole = String(authUser?.role || '').toLowerCase();
  if (!['admin', 'owner'].includes(actorRole)) return json({ error: 'Forbidden' }, 403);

  const id = Number(targetUserId);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'Invalid account ID' }, 400);

  try {
    const target = await env.DB.prepare('SELECT id, role, email FROM users WHERE id = ?').bind(id).first();
    if (!target) return json({ error: 'Account not found' }, 404);

    if (actorRole === 'owner') {
      if (String(target.role || '').toLowerCase() === 'owner') {
        return json({ error: 'Owners cannot permanently delete owner accounts' }, 403);
      }

      const managed = await env.DB.prepare(`
        SELECT 1 FROM user_house_access uha
        JOIN houses h ON h.id = uha.house_id
        WHERE uha.user_id = ? AND h.owner_id = ?
        UNION
        SELECT 1 FROM user_device_access uda
        JOIN devices d ON d.id = uda.device_id
        JOIN houses h ON h.id = d.house_id
        WHERE uda.user_id = ? AND h.owner_id = ?
        LIMIT 1
      `).bind(id, authUser.id, id, authUser.id).first();

      if (!managed) {
        return json({ error: 'You can only delete accounts assigned to your properties' }, 403);
      }
    }

    if (String(target.role || '').toLowerCase() === 'owner') {
      const owned = await env.DB.prepare('SELECT id FROM houses WHERE owner_id = ? LIMIT 1').bind(id).first();
      if (owned) {
        return json({ error: 'Reassign or delete properties before removing this owner account' }, 409);
      }
    }

    const fingerprintDevices = await env.DB.prepare(`
      SELECT DISTINCT device_id, house_id
      FROM device_fingerprint_enrollments e
      JOIN devices d ON d.id = e.device_id
      WHERE e.user_id = ?
    `).bind(id).all();
    const statements = [
      env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM user_house_access WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM user_device_access WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM device_fingerprint_enrollments WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM tenants WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM signup_keys WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM logs WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
    ];

    await runDbBatch(env, statements);
    if (env.HOUSE_ROOM) {
      await Promise.all((fingerprintDevices.results || []).map(device =>
        syncFingerprintAuthorizations(
          env,
          Number(device.device_id),
          Number(device.house_id)
        )
      ));
    }

    return json({ success: true, deletedUserId: id });
  } catch (error) {
    console.error('Permanent account deletion error:', error);
    return json({ error: 'Failed to delete account' }, 500);
  }
}

export async function updateManagedAccount(request, env, authUser, targetUserId) {
  const actorRole = String(authUser?.role || '').toLowerCase();
  if (!['admin', 'owner'].includes(actorRole)) return json({ error: 'Forbidden' }, 403);

  const id = Number(targetUserId);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'Invalid account ID' }, 400);

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const payload = parsed.data || {};

  if (payload.status !== undefined) {
    return setManagedAccountStatus(env, authUser, id, payload.status);
  }

  try {
    const target = await env.DB.prepare(
      'SELECT id, name, email, role FROM users WHERE id = ?'
    ).bind(id).first();
    if (!target) return json({ error: 'Account not found' }, 404);

    const targetRole = String(target.role || '').toLowerCase();
    if (!['owner', 'tenant', 'user'].includes(targetRole)) {
      return json({ error: 'This account role cannot be edited here' }, 403);
    }
    if (actorRole === 'owner') {
      if (targetRole === 'owner') return json({ error: 'Owners cannot edit owner accounts' }, 403);
      const managed = await env.DB.prepare(`
        SELECT 1 FROM user_house_access uha
        JOIN houses h ON h.id = uha.house_id
        WHERE uha.user_id = ? AND h.owner_id = ?
        UNION
        SELECT 1 FROM user_device_access uda
        JOIN devices d ON d.id = uda.device_id
        JOIN houses h ON h.id = d.house_id
        WHERE uda.user_id = ? AND h.owner_id = ?
        LIMIT 1
      `).bind(id, authUser.id, id, authUser.id).first();
      if (!managed) return json({ error: 'You can only edit accounts assigned to your properties' }, 403);
    }

    // Role changes are intentionally not supported: converting tenant/user/owner
    // can invalidate tenant records and access semantics.
    if (payload.role !== undefined && String(payload.role).toLowerCase() !== targetRole) {
      return json({ error: 'Account role cannot be changed while editing' }, 400);
    }

    const name = typeof payload.name === 'string' ? payload.name.trim() : target.name;
    if (!name || name.length > 100) return json({ error: 'A valid name is required' }, 400);
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : target.email;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required' }, 400);
    const duplicate = await env.DB.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').bind(email, id).first();
    if (duplicate) return json({ error: 'Email already exists' }, 409);

    await env.DB.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').bind(name, email, id).run();

    if (targetRole === 'tenant') {
      const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE user_id = ?').bind(id).first();
      if (!tenant) return json({ error: 'Tenant profile is missing for this account' }, 409);
      const numberField = (key, fallback) => {
        if (payload[key] === undefined || payload[key] === null || payload[key] === '') return fallback;
        const value = Number(payload[key]);
        return Number.isFinite(value) && value >= 0 ? value : NaN;
      };
      const balance = numberField('balance', tenant.balance ?? 0);
      const deposit = numberField('deposit', tenant.deposit ?? 0);
      const rent = numberField('rent_amount', tenant.rent_amount ?? 0);
      if (![balance, deposit, rent].every(Number.isFinite)) return json({ error: 'Tenant amounts must be valid non-negative numbers' }, 400);
      const billingCycle = payload.billing_cycle === undefined ? tenant.billing_cycle : String(payload.billing_cycle).trim().toLowerCase();
      if (!['monthly', 'weekly', 'biweekly'].includes(billingCycle)) return json({ error: 'Invalid billing cycle' }, 400);
      const leasedUnit = payload.leased_unit === undefined ? tenant.leased_unit : String(payload.leased_unit).trim();
      const onboardDate = payload.onboard_date === undefined ? tenant.onboard_date : String(payload.onboard_date);
      if (onboardDate && Number.isNaN(new Date(onboardDate).getTime())) return json({ error: 'Invalid move-in date' }, 400);
      await env.DB.prepare(`
        UPDATE tenants SET balance = ?, deposit = ?, rent_amount = ?,
          billing_cycle = ?, leased_unit = ?, onboard_date = ?
        WHERE user_id = ?
      `).bind(balance, deposit, rent, billingCycle, leasedUnit, onboardDate, id).run();
    }

    // Update property assignment only when the client explicitly sends property_ids/property_id
    // or legacy house_ids/house_id values. Device-level permissions are intentionally untouched.
    const assignmentProvided = Array.isArray(payload.property_ids)
      || Array.isArray(payload.house_ids)
      || Object.prototype.hasOwnProperty.call(payload, 'property_id')
      || Object.prototype.hasOwnProperty.call(payload, 'house_id');
    if (assignmentProvided && targetRole !== 'owner') {
      let requested = Array.isArray(payload.property_ids)
        ? payload.property_ids
        : (Array.isArray(payload.house_ids)
          ? payload.house_ids
          : ((payload.property_id ?? payload.house_id) != null && (payload.property_id ?? payload.house_id) !== ''
            ? [payload.property_id ?? payload.house_id]
            : []));
      requested = [...new Set(requested.map(Number))];
      if (targetRole === 'tenant' && requested.length > 1) return json({ error: 'A tenant can be assigned to one property at a time' }, 400);
      if (requested.some(value => !Number.isSafeInteger(value) || value <= 0)) return json({ error: 'Invalid property assignment' }, 400);
      if (targetRole === 'tenant' && requested.length !== 1) return json({ error: 'A tenant must have one assigned property' }, 400);

      for (const houseId of requested) {
        const house = actorRole === 'owner'
          ? await env.DB.prepare('SELECT id FROM houses WHERE id = ? AND owner_id = ?').bind(houseId, authUser.id).first()
          : await env.DB.prepare('SELECT id FROM houses WHERE id = ?').bind(houseId).first();
        if (!house) return json({ error: actorRole === 'owner' ? 'You can only assign accounts to properties you own' : 'Property not found' }, actorRole === 'owner' ? 403 : 404);
      }

      if (actorRole === 'admin') {
        await env.DB.prepare('DELETE FROM user_house_access WHERE user_id = ?').bind(id).run();
      } else {
        await env.DB.prepare(`
          DELETE FROM user_house_access
          WHERE user_id = ? AND house_id IN (SELECT id FROM houses WHERE owner_id = ?)
        `).bind(id, authUser.id).run();
      }
      for (const houseId of requested) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO user_house_access (user_id, house_id, access_level, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(id, houseId, targetRole === 'tenant' ? 'tenant' : 'viewer', new Date().toISOString()).run();
      }
    }

    return json({ success: true, message: 'Account updated successfully' });
  } catch (error) {
    console.error('Update managed account error:', error);
    return json({ error: 'Failed to update account' }, 500);
  }
}


export async function resetManagedAccountPassword(request, env, authUser, targetUserId) {
  const actorRole = String(authUser?.role || '').toLowerCase();

  if (!['admin', 'owner'].includes(actorRole)) {
    return json({ error: 'Forbidden' }, 403);
  }

  const id = Number(targetUserId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return json({ error: 'Invalid account ID' }, 400);
  }

  try {
    const target = await env.DB.prepare(`
      SELECT id, name, email, role
      FROM users
      WHERE id = ?
    `).bind(id).first();

    if (!target) {
      return json({ error: 'Account not found' }, 404);
    }

    const targetRole = String(target.role || '').toLowerCase();

    // Only managed account types can be reset here.
    if (!['owner', 'tenant', 'user'].includes(targetRole)) {
      return json({ error: 'This account cannot be reset here' }, 403);
    }

    // Owners may reset only tenant/user accounts assigned to their properties.
    if (actorRole === 'owner') {
      if (targetRole === 'owner') {
        return json({ error: 'Owners cannot reset other owner accounts' }, 403);
      }

      const managed = await env.DB.prepare(`
        SELECT 1
        FROM user_house_access uha
        JOIN houses h ON h.id = uha.house_id
        WHERE uha.user_id = ?
          AND h.owner_id = ?

        UNION

        SELECT 1
        FROM user_device_access uda
        JOIN devices d ON d.id = uda.device_id
        JOIN houses h ON h.id = d.house_id
        WHERE uda.user_id = ?
          AND h.owner_id = ?

        LIMIT 1
      `).bind(id, authUser.id, id, authUser.id).first();

      if (!managed) {
        return json({
          error: 'You can only reset accounts assigned to your properties'
        }, 403);
      }
    }

    const tempPassword = generateTempPassword();
    const { hash, salt } = await hashPBKDF2(tempPassword);

    const now = new Date().toISOString();
    const expiration = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Update the password and invalidate existing refresh sessions.
    const results = await runDbBatch(env, [
  env.DB.prepare(`
    UPDATE users
    SET password_hash = ?,
        password_salt = ?,
        requires_change_password = 1,
        temp_password_expiration = ?
    WHERE id = ?
  `).bind(
    arrayBufferToHex(hash),
    arrayBufferToHex(salt),
    expiration,
    id
  ),

  env.DB.prepare(`
    DELETE FROM refresh_tokens
    WHERE user_id = ?
  `).bind(id)
]);

if (!results[0] || results[0].meta?.changes !== 1) {
  throw new Error('Password reset did not update the account');
}

    let emailSent = false;

    try {
      const emailResult = await sendTemporaryPasswordEmail({
        env,
        name: target.name || target.email,
        email: target.email,
        role: targetRole,
        tempPassword
      });

      emailSent = Boolean(emailResult);
    } catch (emailError) {
      console.error('Password reset email failed:', emailError);
    }

    return json({
      success: true,
      message: emailSent
        ? 'Password reset successfully. Temporary password emailed.'
        : 'Password reset successfully, but email delivery failed. Use the temporary password below.',
      emailSent,
      tempPassword,
      expiresAt: expiration,
      user: {
        id: target.id,
        name: target.name,
        email: target.email,
        role: targetRole
      }
    });

  } catch (error) {
    console.error('Managed account password reset error:', error);
    return json({ error: 'Failed to reset account password' }, 500);
  }
}
