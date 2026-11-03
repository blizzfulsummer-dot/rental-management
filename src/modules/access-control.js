export async function isTenantOwnedByUser(env, userId, tenantUserId) {
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

export async function isHouseOwnedByUser(env, userId, houseId) {
  const row = await env.DB
    .prepare('SELECT id FROM houses WHERE id = ? AND owner_id = ?')
    .bind(houseId, userId)
    .first();

  return Boolean(row);
}

export async function canManageHouse(env, authUser, houseId) {
  return authUser.role === 'admin' || (
    authUser.role === 'owner' &&
    await isHouseOwnedByUser(env, authUser.id, houseId)
  );
}

export async function userHasDeviceAccess(env, userId, deviceId) {
  const row = await env.DB
    .prepare('SELECT 1 FROM user_device_access WHERE user_id = ? AND device_id = ?')
    .bind(userId, deviceId)
    .first();

  return Boolean(row);
}

