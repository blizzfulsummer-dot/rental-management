function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function listAuditLogs(request, env, authUser) {
  const role = String(authUser?.role || '').toLowerCase();
  if (!['admin', 'owner'].includes(role)) return json({ error: 'Forbidden' }, 403);

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get('limit') || 100);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 200))
    : 100;

  try {
    const ownerScope = role === 'owner' ? `
      WHERE (
        l.device_id IN (
          SELECT d.id
          FROM devices d
          JOIN houses h ON h.id = d.house_id
          WHERE h.owner_id = ?
        )
        OR l.user_id IN (
          SELECT uha.user_id
          FROM user_house_access uha
          JOIN houses h ON h.id = uha.house_id
          WHERE h.owner_id = ?
          UNION
          SELECT uda.user_id
          FROM user_device_access uda
          JOIN devices d ON d.id = uda.device_id
          JOIN houses h ON h.id = d.house_id
          WHERE h.owner_id = ?
        )
      )
    ` : '';
    const bindings = role === 'owner'
      ? [authUser.id, authUser.id, authUser.id, limit]
      : [limit];
    const rows = await env.DB.prepare(`
      SELECT l.id, l.user_id, l.device_id, l.action, l.timestamp,
             l.outcome, l.source, l.details_json, l.command_id,
             u.name AS user_name, u.email AS user_email
      FROM logs l
      LEFT JOIN users u ON u.id = l.user_id
      ${ownerScope}
      ORDER BY datetime(l.timestamp) DESC, l.id DESC
      LIMIT ?
    `).bind(...bindings).all();

    return json({ logs: rows.results || [] });
  } catch (error) {
    console.error('List audit logs error:', error);
    return json({ error: 'Failed to load activity logs' }, 500);
  }
}
