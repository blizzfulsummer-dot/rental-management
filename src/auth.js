import { SignJWT, jwtVerify } from 'jose';
import { parseJsonBody, validateEmail, validateId, validateLoginPayload, validatePassword, validateSignupPayload, validateTenantPayload, sanitizeString } from './lib/validation.js';
import { hashPBKDF2, verifyPBKDF2, verifyLegacy, fakeVerify, arrayBufferToHex, hexToArrayBuffer, generateTempPassword } from './lib/crypto.js';
import { sendTemporaryPasswordEmail, sendPasswordResetCodeEmail } from './lib/email.js';
import { getSecretBytes, getSecretString } from './lib/secrets.js';

import { getUserAccountState } from './modules/account-status.js';
import { writeAuditLog } from './lib/auditLog.js';

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
  let adminSignupKeyId = null;

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

      const tenantPropertyId = payload.property_id ?? payload.house_id;
      if (tenantPropertyId !== undefined && tenantPropertyId !== null && tenantPropertyId !== '') {
        const propertyValidation = validateId(tenantPropertyId);
        if (!propertyValidation.ok) return json({ error: 'Invalid property ID' }, 400);
        tenantHouseId = propertyValidation.value;
      }

      if (tenantCreator.role === 'owner' && !tenantHouseId) {
        return json({ error: 'property_id is required for owner-created tenants' }, 400);
      }
    }

    tempPassword = generateTempPassword();
    finalPassword = tempPassword;
    mustChangePassword = 1;
    tempPasswordExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  } else if (role === 'admin') {
    if (typeof payload.code !== 'string' || !payload.code.trim()) return json({ error: 'A valid administrator registration code is required' }, 403);
    if (!payload.password) return json({ error: 'Password is required' }, 400);
    const passwordValidation = validatePassword(payload.password);
    if (!passwordValidation.ok) return json({ error: 'Password is too weak' }, 400);
    // Admin creation is intentionally public only when a real, unused one-time
    // registration key exists. A non-empty arbitrary string is not sufficient.
    const signupKey = await env.DB.prepare(
      'SELECT id FROM signup_keys WHERE code = ? AND used = 0'
    ).bind(payload.code.trim()).first();
    if (!signupKey) return json({ error: 'Invalid or already-used administrator registration code' }, 403);
    adminSignupKeyId = signupKey.id;
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
            : 'Property not found'
        }, tenantCreator.role === 'owner' ? 403 : 404);
      }
    }

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normalizedEmail).first();
    if (existing) return json({ error: 'Email already exists' }, 400);

    const { hash: derivedBits, salt } = await hashPBKDF2(finalPassword);
    const hashHex = arrayBufferToHex(derivedBits);
    const saltHex = arrayBufferToHex(salt);

    if (adminSignupKeyId !== null) {
      const consumed = await env.DB.prepare(
        'UPDATE signup_keys SET used = 1 WHERE id = ? AND used = 0'
      ).bind(adminSignupKeyId).run();
      if (consumed.meta?.changes !== 1) {
        return json({ error: 'Administrator registration code has already been used' }, 409);
      }
    }

    const userInsert = await env.DB
      .prepare('INSERT INTO users (email, password_hash, password_salt, role, created_at, name, requires_change_password, temp_password_expiration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(normalizedEmail, hashHex, saltHex, role, new Date().toISOString(), sanitizedName, mustChangePassword, tempPasswordExpires)
      .run();

    const userId = userInsert.meta?.last_row_id;
    if (!userId) return json({ error: 'Failed to create user' }, 500);

    if (adminSignupKeyId !== null) {
      await env.DB.prepare('UPDATE signup_keys SET user_id = ? WHERE id = ?')
        .bind(userId, adminSignupKeyId).run();
    }

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

 //if (role === 'admin') {
 // await env.DB.prepare(
  //  'UPDATE signup_keys SET used = 1, user_id = ? WHERE id = ?'
 // ).bind(userId, registrationCode.id).run();
//}

let emailSent = false;

if (tempPassword) {
  try {
    const emailResult = await sendTemporaryPasswordEmail({
      env,
      name: sanitizedName || normalizedEmail,
      email: normalizedEmail,
      role,
      tempPassword
    });

    emailSent = Boolean(emailResult);
  } catch (emailError) {
    console.error('Temporary password email failed:', emailError);
  }
}

return json({
    success: true,
    message: emailSent
      ? 'Account created and credentials emailed successfully'
      : tempPassword
        ? 'Account created, but email sending failed. Use the temporary password below.'
        : 'User registered successfully',
    emailSent,
    tempPassword
  });

  } catch (error) {
    console.error('Signup error:', error);
    return json({ error: 'Failed to create user', details: error.message }, 500);
  }
}


export async function login(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const validation = validateLoginPayload(parsed.data);
  if (!validation.ok) return json({ error: 'Invalid login payload', details: validation.errors }, 400);

  try {
    const normalizedEmail = String(parsed.data.email).trim().toLowerCase();
   const user = await env.DB.prepare(`
  SELECT
    id,
    name,
    email,
    role,
    password_hash,
    password_salt,
    requires_change_password,
    temp_password_expiration
  FROM users
  WHERE email = ?
`).bind(normalizedEmail).first();

    if (!user) {
      await fakeVerify();
      await writeAuditLog(env, {
        action: 'auth.login',
        outcome: 'failed',
        source: 'web',
        details: { email: normalizedEmail, reason: 'invalid_credentials' }
      });
      return json({ error: 'Invalid email or password' }, 401);
    }

    const valid = user.password_hash && user.password_salt
      ? await verifyPBKDF2(user.password_hash, user.password_salt, parsed.data.password)
      : await verifyLegacy(parsed.data.password, user.password_salt, user.password_hash);

    if (!valid) {
      await writeAuditLog(env, {
        userId: user.id,
        action: 'auth.login',
        outcome: 'failed',
        source: 'web',
        details: { email: normalizedEmail, reason: 'invalid_credentials' }
      });
      return json({ error: 'Invalid email or password' }, 401);
    }

    const accountState = await getUserAccountState(env, user.id);
    if (!accountState.active) {
      await writeAuditLog(env, {
        userId: user.id,
        action: 'auth.login',
        outcome: 'denied',
        source: 'web',
        details: { reason: 'account_suspended' }
      });
      return json({ error: 'This account has been suspended', code: 'ACCOUNT_SUSPENDED' }, 403);
    }

    if (Number(user.requires_change_password) === 1) {
  const expiration = user.temp_password_expiration
    ? Date.parse(user.temp_password_expiration)
    : NaN;

  if (!Number.isFinite(expiration) || expiration <= Date.now()) {
    await writeAuditLog(env, {
      userId: user.id,
      action: 'auth.login',
      outcome: 'denied',
      source: 'web',
      details: { reason: 'temporary_password_expired' }
    });
    return json({
      error: 'Your temporary password has expired. Please contact your administrator or property owner to reset it.',
      code: 'TEMP_PASSWORD_EXPIRED'
    }, 403);
  }
}

    const accessToken = await new SignJWT({ sub: user.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(await getSecretBytes(env, 'JWT_SCRT'));

    const refreshTokenRaw = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').bind(user.id, refreshTokenRaw, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()).run();

    await writeAuditLog(env, {
      userId: user.id,
      action: 'auth.login',
      outcome: 'success',
      source: 'web'
    });

   return json({
  success: true,
  accessToken,
  refreshToken: refreshTokenRaw,
  requiresChangePassword: Number(user.requires_change_password) === 1,
  user: {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: accountState.status
  }
});
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
      ({ payload } = await jwtVerify(token, await getSecretBytes(env, 'JWT_SCRT')));
    } catch {
      return json({ error: 'Invalid or expired token' }, 401);
    }

    const user = await env.DB.prepare('SELECT id, password_hash, password_salt FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) return json({ error: 'User not found' }, 404);

    const accountState = await getUserAccountState(env, user.id);
    if (!accountState.active) {
      return json({ error: 'This account has been suspended', code: 'ACCOUNT_SUSPENDED' }, 403);
    }

    const valid = await verifyPBKDF2(user.password_hash, user.password_salt, oldPassword);
    if (!valid) return json({ error: 'Old password is incorrect' }, 401);

    const { hash: derivedBits, salt } = await hashPBKDF2(newPassword);
    await env.DB.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?, requires_change_password = 0, temp_password_expiration = NULL
      WHERE id = ?
    `).bind(arrayBufferToHex(derivedBits), arrayBufferToHex(salt), user.id).run();

    await env.DB.prepare(`
  DELETE FROM refresh_tokens
  WHERE user_id = ?
`).bind(user.id).run();

    return json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Update password error:', error);
    return json({ error: 'Failed to update password' }, 500);
  }
}

async function hashPasswordResetCode(env, userId, code) {
  const secret = await getSecretString(env, 'JWT_SCRT');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${userId}:${code}`)
  );
  return arrayBufferToHex(signature);
}

export async function requestPasswordResetCode(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const emailResult = validateEmail(parsed.data?.email);
  if (!emailResult.ok) return json({ error: 'Invalid email' }, 400);

  const genericResponse = () => json({
    success: true,
    message: 'If the account exists, a verification code has been sent.'
  });

  try {
    const email = String(parsed.data.email).trim().toLowerCase();
    const user = await env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
    if (!user) return genericResponse();
    const accountState = await getUserAccountState(env, user.id);
    if (!accountState.active) return genericResponse();

    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const code = String(random[0] % 1_000_000).padStart(6, '0');
    const tokenHash = await hashPasswordResetCode(env, user.id, code);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

    await env.DB.prepare('DELETE FROM password_resets WHERE user_id = ? AND used = 0')
      .bind(user.id).run();
    await env.DB.prepare(
      'INSERT INTO password_resets (user_id, token, expires_at, used) VALUES (?, ?, ?, 0)'
    ).bind(user.id, tokenHash, expiresAt).run();

    try {
      await sendPasswordResetCodeEmail({
        env, name: user.name || email, email, code
      });
    } catch (emailError) {
      console.error('[Auth] Password reset email delivery failed:', emailError);
    }
    return genericResponse();
  } catch (error) {
    console.error('[Auth] Password reset code request failed:', error);
    // Keep account-existence responses indistinguishable.
    return genericResponse();
  }
}

export async function confirmPasswordResetCode(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const emailResult = validateEmail(parsed.data?.email);
  if (!emailResult.ok) return json({ error: 'Invalid email or verification code' }, 400);

  const { code, newPassword } = parsed.data;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return json({ error: 'Invalid or expired verification code' }, 400);
  }
  if (typeof newPassword !== 'string' || !validatePassword(newPassword).ok) {
    return json({ error: 'Password is too weak' }, 400);
  }

  try {
    const email = String(parsed.data.email).trim().toLowerCase();
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (!user) return json({ error: 'Invalid or expired verification code' }, 400);
    const accountState = await getUserAccountState(env, user.id);
    if (!accountState.active) return json({ error: 'This account has been suspended', code: 'ACCOUNT_SUSPENDED' }, 403);

    const tokenHash = await hashPasswordResetCode(env, user.id, code);
    const reset = await env.DB.prepare(`
      SELECT id FROM password_resets
      WHERE user_id = ? AND token = ? AND used = 0 AND expires_at > ?
      ORDER BY id DESC LIMIT 1
    `).bind(user.id, tokenHash, new Date().toISOString()).first();
    if (!reset) return json({ error: 'Invalid or expired verification code' }, 400);

    const consumed = await env.DB.prepare(`
      UPDATE password_resets SET used = 1
      WHERE id = ? AND used = 0 AND expires_at > ?
    `).bind(reset.id, new Date().toISOString()).run();
    if (consumed.meta?.changes !== 1) {
      return json({ error: 'This verification code has already been used or expired' }, 400);
    }

    const { hash: derivedBits, salt } = await hashPBKDF2(newPassword);
    await env.DB.prepare(`
      UPDATE users SET password_hash = ?, password_salt = ?,
        requires_change_password = 0, temp_password_expiration = NULL
      WHERE id = ?
    `).bind(arrayBufferToHex(derivedBits), arrayBufferToHex(salt), user.id).run();
    await env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(user.id).run();
    return json({ success: true, message: 'Password reset successfully. Please sign in.' });
  } catch (error) {
    console.error('[Auth] Password reset confirmation failed:', error);
    return json({ error: 'Unable to reset password. Please request a new verification code.' }, 500);
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

    const accountState = await getUserAccountState(env, user.id);
    if (!accountState.active) {
      return json({ success: true, message: 'If your email exists, a reset link has been sent' });
    }

    const token = await new SignJWT({ sub: user.id }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(await getSecretBytes(env, 'JWT_SCRT'));
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
      ({ payload } = await jwtVerify(token, await getSecretBytes(env, 'JWT_SCRT')));
    } catch {
      return json({ error: 'Invalid or expired token' }, 400);
    }

    const reset = await env.DB.prepare('SELECT id, user_id, used, expires_at FROM password_resets WHERE token = ?').bind(token).first();
    if (!reset || reset.used || Number(reset.user_id) !== Number(payload.sub) || new Date(reset.expires_at) <= new Date()) {
      return json({ error: 'Invalid or expired token' }, 400);
    }

    const accountState = await getUserAccountState(env, reset.user_id ?? payload.sub);
    if (!accountState.active) {
      return json({ error: 'This account has been suspended', code: 'ACCOUNT_SUSPENDED' }, 403);
    }

    const { hash: derivedBits, salt } = await hashPBKDF2(newPassword);
    const consumed = await env.DB.prepare(`
      UPDATE password_resets SET used = 1
      WHERE id = ? AND used = 0 AND expires_at > ?
    `).bind(reset.id, new Date().toISOString()).run();
    if (consumed.meta?.changes !== 1) {
      return json({ error: 'Invalid or expired token' }, 400);
    }

    await env.DB.prepare(`
      UPDATE users
      SET password_hash = ?, password_salt = ?,
          requires_change_password = 0, temp_password_expiration = NULL
      WHERE id = ?
    `).bind(arrayBufferToHex(derivedBits), arrayBufferToHex(salt), reset.user_id ?? payload.sub).run();

    await env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?')
      .bind(reset.user_id ?? payload.sub).run();

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
    ({ payload } = await jwtVerify(auth.slice(7), await getSecretBytes(env, 'JWT_SCRT')));
  } catch {
    return json({ error: 'Invalid or expired token' }, 401);
  }

  try {
    const user = await env.DB.prepare('SELECT id, email, role, name FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) return json({ error: 'User not found' }, 401);

    const passwordState = await env.DB.prepare('SELECT requires_change_password, temp_password_expiration FROM users WHERE id = ?').bind(payload.sub).first();
    const userWithPasswordState = { ...user, ...(passwordState || {}) };

    const accountState = await getUserAccountState(env, user.id);
    if (!accountState.active) {
      return json({ error: 'This account has been suspended', code: 'ACCOUNT_SUSPENDED' }, 403);
    }

    if (Number(userWithPasswordState.requires_change_password) === 1) {
  const expiration = userWithPasswordState.temp_password_expiration
    ? Date.parse(userWithPasswordState.temp_password_expiration)
    : NaN;

  if (Number.isFinite(expiration) && expiration <= Date.now()) {
    return json({
      error: 'Your temporary password has expired. Contact your administrator or property owner.',
      code: 'TEMP_PASSWORD_EXPIRED'
    }, 403);
  }
}

    const assignedHouses = await getAssignedHouses(env, userWithPasswordState);
    const assignedHouse = assignedHouses[0] || null;

    return json({
      valid: true,
      user: {
        ...userWithPasswordState,
        status: accountState.status,
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
    const row = await env.DB.prepare(`
  SELECT user_id, expires_at
  FROM refresh_tokens
  WHERE token = ?
`).bind(refreshToken).first();

if (!row || new Date(row.expires_at) <= new Date()) {
  return json({ error: 'Invalid or expired refresh token' }, 401);
}

const user = await env.DB.prepare(`
  SELECT requires_change_password, temp_password_expiration
  FROM users
  WHERE id = ?
`).bind(row.user_id).first();

if (!user) {
  return json({ error: 'User not found' }, 401);
}

const accountState = await getUserAccountState(env, user.id);
if (!accountState.active) {
  return json({ error: 'This account has been suspended', code: 'ACCOUNT_SUSPENDED' }, 403);
}

if (Number(user.requires_change_password) === 1) {
  const expiration = user.temp_password_expiration
    ? Date.parse(user.temp_password_expiration)
    : NaN;

  if (!Number.isFinite(expiration) || expiration <= Date.now()) {
    return json({
      error: 'Your temporary password has expired. Please contact your administrator or property owner.',
      code: 'TEMP_PASSWORD_EXPIRED'
    }, 403);
  }
}

    const newAccessToken = await new SignJWT({ sub: row.user_id }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('15m').sign(await getSecretBytes(env, 'JWT_SCRT'));
    return json({ success: true, accessToken: newAccessToken });
  } catch (error) {
    console.error('Refresh token error:', error);
    return json({ error: 'Failed to refresh token' }, 500);
  }
}

export async function getAuthUser(request, env) {
  const auth = request.headers.get('Authorization');

  if (!auth) {
    return { error: 'Authorization header missing', status: 401 };
  }

  if (!auth.startsWith('Bearer ')) {
    return { error: 'Invalid Authorization format', status: 401 };
  }

  try {
    let payload;

    try {
      ({ payload } = await jwtVerify(auth.slice(7), await getSecretBytes(env, 'JWT_SCRT')));
    } catch {
      return { error: 'Invalid or expired token', status: 401 };
    }

    const user = await env.DB.prepare('SELECT id, email, role, name FROM users WHERE id = ?').bind(payload.sub).first();

    if (!user) {
      return { error: 'User not found', status: 404 };
    }

    const passwordState = await env.DB.prepare('SELECT requires_change_password, temp_password_expiration FROM users WHERE id = ?').bind(payload.sub).first();
    const userWithPasswordState = { ...user, ...(passwordState || {}) };

    const accountState = await getUserAccountState(env, user.id);
    if (!accountState.active) {
      return {
        error: 'This account has been suspended',
        status: 403,
        code: 'ACCOUNT_SUSPENDED'
      };
    }

    if (Number(userWithPasswordState.requires_change_password) === 1) {
      const expiration = userWithPasswordState.temp_password_expiration
        ? Date.parse(userWithPasswordState.temp_password_expiration)
        : NaN;

      if (!Number.isFinite(expiration) || expiration <= Date.now()) {
        return {
          error: 'Your temporary password has expired. Contact your administrator or property owner.',
          status: 403,
          code: 'TEMP_PASSWORD_EXPIRED'
        };
      }

      return {
        error: 'You must change your temporary password before accessing this resource.',
        status: 403,
        code: 'PASSWORD_CHANGE_REQUIRED'
      };
    }

    return {
      user: {
        ...userWithPasswordState,
        status: accountState.status
      }
    };

  } catch (error) {
    console.error('Auth user error:', error);
    return { error: 'Authentication failed', status: 500 };
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export {
  registerProvisionedAccount,
  listManagedAccounts,
  suspendAccount,
  reactivateAccount,
  deleteManagedAccount,
  updateManagedAccount,
  resetManagedAccountPassword
} from './modules/accounts.js';
