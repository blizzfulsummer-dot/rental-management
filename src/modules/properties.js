import { parseJsonBody, validateId } from '../lib/validation.js';

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

    const rows = await env.DB
      .prepare(`
        SELECT DISTINCT h.*
        FROM houses h
        LEFT JOIN user_house_access uha ON uha.house_id = h.id
        LEFT JOIN devices d ON d.house_id = h.id
        LEFT JOIN user_device_access uda ON uda.device_id = d.id
        WHERE h.owner_id = ?
           OR uha.user_id = ?
           OR uda.user_id = ?
        ORDER BY h.created_at DESC
      `)
      .bind(authUser.id, authUser.id, authUser.id)
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
    return json({ error: 'Property name is required' }, 400);
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

    if (!row) return json({ error: 'Property not found' }, 404);

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

    if (!house) return json({ error: 'Property not found' }, 404);

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
      return json({ error: 'Property name is required' }, 400);
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

    if (!house) return json({ error: 'Property not found' }, 404);

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

export async function listProperties(request, env, authUser) {
  return listHouses(request, env, authUser);
}

export async function createProperty(request, env, authUser) {
  return createHouse(request, env, authUser);
}

export async function getProperty(request, env, authUser, houseId) {
  return getHouse(request, env, authUser, houseId);
}

export async function updateProperty(request, env, authUser, houseId) {
  return updateHouse(request, env, authUser, houseId);
}

export async function deleteProperty(request, env, authUser, houseId) {
  return deleteHouse(request, env, authUser, houseId);
}


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
