async function getUsersTableColumns(env) {
  try {
    const result = await env.DB.prepare('PRAGMA table_info(users)').all();
    return new Set((result.results || []).map(column => column.name));
  } catch (error) {
    // Fail closed on schema/database errors; silently assuming active can
    // bypass suspension checks during a transient D1 failure.
    throw error;
  }
}

function normalizeAccountState(user) {
  if (!user) {
    return { active: true, status: 'active' };
  }

  const hasStatus = Object.prototype.hasOwnProperty.call(user, 'status');
  const hasIsActive = Object.prototype.hasOwnProperty.call(user, 'is_active');

  let status = 'active';
  let active = true;

  if (hasStatus) {
    status = String(user.status || 'active').toLowerCase();
    active = status !== 'suspended';
  }

  if (hasIsActive) {
    active = Number(user.is_active) !== 0 && active;
    if (!active) {
      status = 'suspended';
    }
  }

  return {
    active,
    status: active ? 'active' : (status || 'suspended')
  };
}

export async function getUserAccountState(env, userId) {
  const columns = await getUsersTableColumns(env);
  const fields = [];

  if (columns.has('is_active')) fields.push('is_active');
  if (columns.has('status')) fields.push('status');

  if (!fields.length) {
    return { active: true, status: 'active' };
  }

  const row = await env.DB.prepare(`SELECT ${fields.join(', ')} FROM users WHERE id = ?`).bind(userId).first();
  return normalizeAccountState(row || { id: userId });
}

export async function setUserAccountState(env, userId, nextStatus) {
  const columns = await getUsersTableColumns(env);
  const updates = [];
  const values = [];

  if (columns.has('is_active')) {
    updates.push('is_active = ?');
    values.push(nextStatus === 'active' ? 1 : 0);
  }

  if (columns.has('status')) {
    updates.push('status = ?');
    values.push(nextStatus === 'active' ? 'active' : 'suspended');
  }

  if (!updates.length) {
    return false;
  }

  await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values, userId).run();
  return true;
}

