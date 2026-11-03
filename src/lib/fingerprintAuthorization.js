async function getAccountStatusColumns(env) {
  const result = await env.DB.prepare('PRAGMA table_info(users)').all();
  return new Set((result.results || []).map(column => column.name));
}

export async function getAllowedFingerprintIds(env, deviceId, houseId) {
  const columns = await getAccountStatusColumns(env);
  const activeClause = columns.has('is_active')
    ? 'AND COALESCE(u.is_active, 1) = 1'
    : '';
  const statusClause = columns.has('status')
    ? "AND LOWER(COALESCE(u.status, 'active')) != 'suspended'"
    : '';
  const rows = await env.DB.prepare(`
    SELECT e.fingerprint_id
    FROM device_fingerprint_enrollments e
    JOIN users u ON u.id = e.user_id
    JOIN devices d ON d.id = e.device_id
    JOIN houses h ON h.id = d.house_id
    WHERE e.device_id = ?
      AND d.house_id = ?
      AND e.status = 'active'
      AND e.enrollment_pending = 0
      ${activeClause}
      ${statusClause}
      AND (
        u.role = 'admin'
        OR (u.role = 'owner' AND h.owner_id = u.id)
        OR EXISTS (
          SELECT 1
          FROM user_device_access a
          WHERE a.user_id = e.user_id
            AND a.device_id = e.device_id
        )
      )
    ORDER BY e.fingerprint_id
  `).bind(deviceId, houseId).all();

  return (rows.results || []).map(row => Number(row.fingerprint_id));
}

export async function syncFingerprintAuthorizations(env, deviceId, houseId) {
  if (!env.HOUSE_ROOM) return false;
  try {
    const durableObjectId = env.HOUSE_ROOM.idFromName(`house-${houseId}`);
    const durableObject = env.HOUSE_ROOM.get(durableObjectId);
    const response = await durableObject.fetch('https://house-room.internal/authorization-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId })
    });
    if (!response.ok) {
      throw new Error(`Fingerprint authorization sync failed with status ${response.status}`);
    }
    const result = await response.json();
    return result.delivered === true;
  } catch (error) {
    console.error(`Fingerprint authorization sync failed for device ${deviceId}:`, error);
    return false;
  }
}

export async function syncUserFingerprintAuthorizations(env, userId) {
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT DISTINCT d.id AS device_id, d.house_id
      FROM device_fingerprint_enrollments e
      JOIN devices d ON d.id = e.device_id
      WHERE e.user_id = ?
    `).bind(userId).all();
  } catch (error) {
    console.error(`Could not find devices for fingerprint authorization sync for user ${userId}:`, error);
    return false;
  }
  const results = await Promise.all((rows.results || []).map(async row => {
    try {
      return await syncFingerprintAuthorizations(
        env,
        Number(row.device_id),
        Number(row.house_id)
      );
    } catch (error) {
      console.error(`Could not sync device ${row.device_id} fingerprint authorizations:`, error);
      return false;
    }
  }));
  return results.every(Boolean);
}
