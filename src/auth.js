import { SignJWT, jwtVerify } from 'jose';
import { parseJsonBody, validateEmail, validateId, validateLoginPayload, validatePassword, validateSignupPayload, validateTenantPayload, sanitizeString } from './lib/validation.js';
import { hashPBKDF2, verifyPBKDF2, verifyLegacy, fakeVerify, arrayBufferToHex, hexToArrayBuffer, generateTempPassword } from './lib/crypto.js';


export async function signup(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const payload = parsed.data;
  const validation = validateSignupPayload(payload);
  if (!validation.ok) return json({ error: 'Invalid signup payload', details: validation.errors }, 400);

  const normalizedEmail = String(payload.email).trim().toLowerCase();
  const role = String(payload.role).trim().toLowerCase();

  if (role === 'owner') {
  return json({
    error: 'Owner accounts must be created by an administrator'
  }, 403);
}

  let sanitizedName = null;
  if (payload.name) {
    const nameResult = sanitizeString(payload.name, 'name', 100);
    if (nameResult.ok) {
      sanitizedName = nameResult.value;
    }
  }

  let finalPassword = 'default@1234';
  let tempPassword = null;
  let mustChangePassword = 0;
  let tempPasswordExpires = null;
  let tenantHouseId = null;
  let tenantCreator = null;

  if (role === 'tenant' || role === 'user') {
    const authResult = await getAuthUser(request, env);
    if (authResult.error) return json({ error: authResult.error }, authResult.status || 401);
    const creatorRole = String(authResult.user.role || '').toLowerCase();
    if (role === 'user' && creatorRole !== 'admin') return json({ error: 'Only admins can register users' }, 403);
    if (role === 'tenant' && creatorRole !== 'admin' && creatorRole !== 'owner') {
      return json({ error: 'Only owners and admins can register tenants' }, 403);
    }

    if (role === 'tenant') {
      tenantCreator = { ...authResult.user, role: creatorRole };
      const tenantValidation = validateTenantPayload(payload);
      if (!tenantValidation.ok) return json({ error: 'Invalid tenant fields', details: tenantValidation.errors }, 400);

      if (payload.house_id !== undefined && payload.house_id !== null && payload.house_id !== '') {
        const houseValidation = validateId(payload.house_id);
        if (!houseValidation.ok) return json({ error: 'Invalid house ID' }, 400);
        tenantHouseId = houseValidation.value;
      }

      if (tenantCreator.role === 'owner' && !tenantHouseId) {
        return json({ error: 'house_id is required for owner-created tenants' }, 400);
      }
    }

    tempPassword = generateTempPassword();
    finalPassword = tempPassword;
    mustChangePassword = 1;
    tempPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  } else if (role === 'admin') {
    if (!payload.code) return json({ error: 'Code is required for admin signup' }, 400);
    if (!payload.password) return json({ error: 'Password is required' }, 400);
    const passwordValidation = validatePassword(payload.password);
    if (!passwordValidation.ok) return json({ error: 'Password is too weak' }, 400);
    finalPassword = payload.password;
  } else {
    if (!payload.password) return json({ error: 'Password is required' }, 400);
    const passwordValidation = validatePassword(payload.password);
    if (!passwordValidation.ok) return json({ error: 'Password is too weak' }, 400);
    finalPassword = payload.password;
  }

  try {
    if (role === 'tenant' && tenantHouseId) {
      const house = tenantCreator.role === 'owner'
        ? await env.DB.prepare('SELECT id FROM houses WHERE id = ? AND owner_id = ?').bind(tenantHouseId, tenantCreator.id).first()
        : await env.DB.prepare('SELECT id FROM houses WHERE id = ?').bind(tenantHouseId).first();
      if (!house) {
        return json({
          error: tenantCreator.role === 'owner'
            ? 'You can only register tenants for houses you own'
            : 'House not found'
        }, tenantCreator.role === 'owner' ? 403 : 404);
      }
    }

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normalizedEmail).first();
    if (existing) return json({ error: 'Email already exists' }, 400);

    const { hash: derivedBits, salt } = await hashPBKDF2(finalPassword);
    const hashHex = arrayBufferToHex(derivedBits);
    const saltHex = arrayBufferToHex(salt);

    const userInsert = await env.DB
      .prepare('INSERT INTO users (email, password_hash, password_salt, role, created_at, name, requires_change_password, temp_password_expiration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(normalizedEmail, hashHex, saltHex, role, new Date().toISOString(), sanitizedName, mustChangePassword, tempPasswordExpires)
      .run();

    const userId = userInsert.meta?.last_row_id;
    if (!userId) return json({ error: 'Failed to create user' }, 500);

    if (role === 'tenant') {
      await env.DB
        .prepare(`
          INSERT INTO tenants (user_id, balance, deposit, rent_amount, billing_cycle, leased_unit, onboard_date, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          userId,
          Number(payload.balance),
          Number(payload.deposit),
          Number(payload.rent_amount),
          String(payload.billing_cycle),
          String(payload.leased_unit),
          new Date(payload.onboard_date).toISOString(),
          new Date().toISOString()
        )
        .run();

      if (tenantHouseId) {
        await env.DB
          .prepare(`
            INSERT OR IGNORE INTO user_house_access (user_id, house_id, access_level, created_at)
            VALUES (?, ?, 'tenant', ?)
          `)
          .bind(userId, tenantHouseId, new Date().toISOString())
          .run();
      }
    }

    if (role === 'admin') {
  await env.DB.prepare(
    'UPDATE signup_keys SET used = 1, user_id = ? WHERE id = ?'
  ).bind(userId, registrationCode.id).run();
}

    return json({ success: true, message: 'User registered successfully', tempPassword });
  } catch (error) {
    console.error('Signup error:', error);
    return json({ error: 'Failed to create user', details: error.message }, 500);
  }
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

    const houseValidation = validateId(payload.house_id);

    if (!houseValidation.ok) {
      return json({ error: 'A valid house is required for tenant registration' }, 400);
    }

    tenantHouseId = houseValidation.value;

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
          : 'House not found'
      }, creatorRole === 'owner' ? 403 : 404);
    }
  }

   let provisionedHouseIds = [];
  if (role === 'user') {
    provisionedHouseIds = Array.isArray(payload.house_ids)
      ? [...new Set(payload.house_ids.map(Number))]
      : (payload.house_id ? [Number(payload.house_id)] : []);
    if (!provisionedHouseIds.length || provisionedHouseIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      return json({ error: 'At least one valid property is required for a regular user' }, 400);
    }
    for (const houseId of provisionedHouseIds) {
      const house = creatorRole === 'owner'
        ? await env.DB.prepare('SELECT id FROM houses WHERE id = ? AND owner_id = ?').bind(houseId, authUser.id).first()
        : await env.DB.prepare('SELECT id FROM houses WHERE id = ?').bind(houseId).first();
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
      for (const houseId of provisionedHouseIds) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO user_house_access (user_id, house_id, access_level, created_at)
          VALUES (?, ?, 'viewer', ?)
        `).bind(createdUserId, houseId, now).run();
      }
    }

    return json({
      success: true,
      message: `${role.charAt(0).toUpperCase() + role.slice(1)} account registered successfully`,
      user: {
        id: createdUserId,
        name: nameResult.value,
        email: normalizedEmail,
        role
      },
      tempPassword
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
      accounts.push({
        ...row,
        house_ids: (access.results || []).map(h => h.id),
        house_names: (access.results || []).map(h => h.name)
      });
    }
    return json({ accounts });
  } catch (error) {
    console.error('List managed accounts error:', error);
    return json({ error: 'Failed to fetch accounts' }, 500);
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

    // Update house assignment only when the client explicitly sends house_ids/house_id.
    // Device-level permissions are intentionally untouched.
    const assignmentProvided = Array.isArray(payload.house_ids) || Object.prototype.hasOwnProperty.call(payload, 'house_id');
    if (assignmentProvided && targetRole !== 'owner') {
      let requested = Array.isArray(payload.house_ids) ? payload.house_ids : (payload.house_id ? [payload.house_id] : []);
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



export async function login(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const validation = validateLoginPayload(parsed.data);
  if (!validation.ok) return json({ error: 'Invalid login payload', details: validation.errors }, 400);

  try {
    const normalizedEmail = String(parsed.data.email).trim().toLowerCase();
    const user = await env.DB.prepare('SELECT id, password_hash, password_salt FROM users WHERE email = ?').bind(normalizedEmail).first();

    if (!user) {
      await fakeVerify();
      return json({ error: 'Invalid email or password' }, 401);
    }

    const valid = user.password_hash && user.password_salt
      ? await verifyPBKDF2(user.password_hash, user.password_salt, parsed.data.password)
      : await verifyLegacy(parsed.data.password, user.password_salt, user.password_hash);

    if (!valid) return json({ error: 'Invalid email or password' }, 401);

    const accessToken = await new SignJWT({ sub: user.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(getSecret(env));

    const refreshTokenRaw = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').bind(user.id, refreshTokenRaw, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()).run();

    return json({ success: true, accessToken, refreshToken: refreshTokenRaw });
  } catch (error) {
    console.error('Login error:', error);
    return json({ error: 'Authentication failed' }, 500);
  }
}

export async function updatePassword(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const { token, oldPassword, newPassword } = parsed.data;
  if (!token || !oldPassword || !newPassword) return json({ error: 'Missing fields' }, 400);

  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.ok) return json({ error: 'Password is too weak' }, 400);

  try {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, getSecret(env)));
    } catch {
      return json({ error: 'Invalid or expired token' }, 401);
    }

    const user = await env.DB.prepare('SELECT id, password_hash, password_salt FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) return json({ error: 'User not found' }, 404);

    const valid = await verifyPBKDF2(user.password_hash, user.password_salt, oldPassword);
    if (!valid) return json({ error: 'Old password is incorrect' }, 401);

    const { hash: derivedBits, salt } = await hashPBKDF2(newPassword);
    await env.DB.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?, requires_change_password = 0, temp_password_expiration = NULL
      WHERE id = ?
    `).bind(arrayBufferToHex(derivedBits), arrayBufferToHex(salt), user.id).run();

    return json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Update password error:', error);
    return json({ error: 'Failed to update password' }, 500);
  }
}

export async function requestReset(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const emailResult = validateEmail(parsed.data?.email);
  if (!emailResult.ok) return json({ error: 'Invalid email' }, 400);

  try {
    const normalizedEmail = String(parsed.data.email).trim().toLowerCase();
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normalizedEmail).first();
    if (!user) return json({ success: true, message: 'If your email exists, a reset link has been sent' });

    const token = await new SignJWT({ sub: user.id }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(getSecret(env));
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)').bind(user.id, token, expiresAt).run();

    return json({ success: true, message: 'If your email exists, a reset link has been sent' });
  } catch (error) {
    console.error('Request reset error:', error);
    return json({ success: true, message: 'If your email exists, a reset link has been sent' });
  }
}

export async function resetPassword(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const { token, newPassword } = parsed.data;
  if (!token || !newPassword) return json({ error: 'Missing fields' }, 400);

  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.ok) return json({ error: 'Password is too weak' }, 400);

  try {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, getSecret(env)));
    } catch {
      return json({ error: 'Invalid or expired token' }, 400);
    }

    const reset = await env.DB.prepare('SELECT id, used, expires_at FROM password_resets WHERE token = ?').bind(token).first();
    if (!reset || reset.used || new Date(reset.expires_at) < new Date()) return json({ error: 'Invalid or expired token' }, 400);

    const { hash: derivedBits, salt } = await hashPBKDF2(newPassword);
    await env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(arrayBufferToHex(derivedBits), arrayBufferToHex(salt), payload.sub).run();
    await env.DB.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').bind(reset.id).run();

    return json({ success: true, message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    return json({ error: 'Failed to reset password' }, 500);
  }
}

async function getAssignedHouses(env, user) {
  if (user.role === 'admin') {
    const rows = await env.DB.prepare(`
      SELECT h.*
      FROM houses h
      ORDER BY h.created_at DESC
    `).all();
    return (rows.results || []).map(normalizeHouseLocation);
  }

  const rows = await env.DB.prepare(`
    SELECT DISTINCT h.*
    FROM houses h
    LEFT JOIN user_house_access uha ON uha.house_id = h.id
    WHERE h.owner_id = ?
       OR uha.user_id = ?
       OR EXISTS (
         SELECT 1
         FROM devices d
         JOIN user_device_access uda ON uda.device_id = d.id
         WHERE d.house_id = h.id AND uda.user_id = ?
       )
    ORDER BY h.created_at DESC
  `).bind(user.id, user.id, user.id).all();

  return (rows.results || []).map(normalizeHouseLocation);
}

function normalizeHouseLocation(house) {
  return {
    ...house,
    location: house.location ?? house.address ?? null
  };
}

export async function verifyJwt(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);

  let payload;
  try {
    ({ payload } = await jwtVerify(auth.slice(7), getSecret(env)));
  } catch {
    return json({ error: 'Invalid or expired token' }, 401);
  }

  try {
    const user = await env.DB.prepare('SELECT id, email, role, name, requires_change_password FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) return json({ error: 'User not found' }, 401);

    const assignedHouses = await getAssignedHouses(env, user);
    const assignedHouse = assignedHouses[0] || null;

    return json({
      valid: true,
      user: {
        ...user,
        assigned_houses: assignedHouses,
        assigned_house: assignedHouse
      }
    });
  } catch (error) {
    console.error('Verify JWT profile error:', error);
    return json({ error: 'Failed to load user profile' }, 500);
  }
}

export async function refreshToken(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const { refreshToken } = parsed.data;
  if (!refreshToken) return json({ error: 'No refresh token' }, 400);

  try {
    const row = await env.DB.prepare('SELECT user_id, expires_at FROM refresh_tokens WHERE token = ?').bind(refreshToken).first();
    if (!row || new Date(row.expires_at) < new Date()) return json({ error: 'Invalid or expired refresh token' }, 401);

    const newAccessToken = await new SignJWT({ sub: row.user_id }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(getSecret(env));
    return json({ success: true, accessToken: newAccessToken });
  } catch (error) {
    console.error('Refresh token error:', error);
    return json({ error: 'Failed to refresh token' }, 500);
  }
}

export async function getAuthUser(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth) return { error: 'Authorization header missing', status: 401 };
  if (!auth.startsWith('Bearer ')) return { error: 'Invalid Authorization format', status: 401 };

  const token = auth.slice(7);
  try {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, getSecret(env)));
    } catch {
      return { error: 'Invalid or expired token', status: 401 };
    }

    const user = await env.DB.prepare('SELECT id, email, role, name FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) return { error: 'User not found', status: 404 };

    return { user };
  } catch (error) {
    console.error('Auth user error:', error);
    return { error: 'Authentication failed', status: 500 };
  }
}

function getSecret(env) {
  return new TextEncoder().encode(env.JWT_SCRT);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
