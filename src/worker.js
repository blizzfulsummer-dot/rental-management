import {
  createDevice,
  createHouse,
  createTenant,
  deleteDevice,
  deleteHouse,
  deleteTenant,
  getDevice,
  getHouse,
  getTenant,
  listHouseDevices,
  listHouses,
  listProvisionableUsers,
  listTenants,
  manageDeviceAccess,
  manageHouseAccess,
  rotateDevicePairingKey,
  updateDevice,
  updateHouse,
  updateTenant
} from './tenant.js';
import { getAuthUser, login, refreshToken, requestReset, resetPassword, signup, updatePassword, verifyJwt, registerProvisionedAccount } from './auth.js';
import { createRateLimiter } from './lib/rateLimit.js';
import { issueDeviceWebSocketTicket, issueWebSocketTicket, validateWebSocketTicket } from './lib/websocketTicket.js';
import { HouseRoom } from './houseRoom.js';
import { DeviceRoom } from './deviceRoom.js';
import {
  cancelFingerprintEnrollment,
  listFingerprintEnrollments,
  removeFingerprintEnrollment,
  startFingerprintEnrollment
} from './fingerprints.js';

const ALLOWED_ORIGINS = [
  'https://test-front-env.pages.dev',
  'https://my-other-site.pages.dev',
  'https://rental-management.ehexibit.com'
];

const authRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 10 });

function withCors(response, allowOrigin = '*') {
  response.headers.set('Access-Control-Allow-Origin', allowOrigin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return response;
}

function getAllowOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  return '*';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function shouldRateLimit(pathname) {
  return ['/api/signup', '/api/login', '/api/update_password', '/api/request_reset', '/api/reset_password'].includes(pathname);
}

/**
 * Generate a UUID using Web Crypto API (works in Cloudflare Workers)
 */
function generateUUID() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Handle WebSocket upgrade for house room connections
 * URL: /ws/house/:houseId?ticket=SHORT_LIVED_TICKET
 */
async function handleHouseRoomWebSocket(request, env, url) {
  // Only allow WebSocket upgrade
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'Expected WebSocket' }, 400);
  }

  // Extract houseId from path
  const pathParts = url.pathname.split('/');
  const houseIdStr = pathParts[3]; // /ws/house/:houseId
  const houseId = parseInt(houseIdStr);

  if (!houseId || isNaN(houseId)) {
    return json({ error: 'Invalid house ID' }, 400);
  }

  // Extract and validate ticket from query parameters
  const ticket = url.searchParams.get('ticket');
  if (!ticket) {
    return json({ error: 'WebSocket ticket required' }, 401);
  }

  // Validate ticket
  const validation = await validateWebSocketTicket(env, ticket, houseId);
  if (!validation.valid) {
    return json({ error: validation.error || 'Invalid ticket' }, 401);
  }

  // Get Durable Object for this house
  const durableObjectId = env.HOUSE_ROOM.idFromName(`house-${houseId}`);
  const durableObject = env.HOUSE_ROOM.get(durableObjectId);

  // Build URL with session metadata for the Durable Object
  const sessionUrl = new URL(request.url);
  sessionUrl.searchParams.set('sessionId', validation.sessionId || generateUUID());
  sessionUrl.searchParams.set('userId', validation.userId);
  sessionUrl.searchParams.set('houseId', validation.houseId);
  sessionUrl.searchParams.set('clientType', validation.clientType);
  if (validation.deviceId) {
    sessionUrl.searchParams.set('deviceId', validation.deviceId);
  }
  sessionUrl.searchParams.set('role', validation.role);
  sessionUrl.pathname = '/';

  // Forward request to Durable Object
  return durableObject.fetch(new Request(sessionUrl, { 
    method: request.method,
    headers: request.headers
  }));
}

export { HouseRoom , DeviceRoom };

export default {
  async fetch(request, env) {
    const allowOrigin = getAllowOrigin(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    const url = new URL(request.url);

    // Serve static files (index.html, etc.)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        // Try ASSETS binding first (production)
       // Serve static files through the Cloudflare Assets binding.
      if (url.pathname === '/' || url.pathname === '/index.html') {
          if (env.ASSETS) {
              return env.ASSETS.fetch(request);
          }

        return new Response('Static Assets binding is unavailable.', {
          status: 500,
          headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store'
        }
        });
      }
      } catch (e) {
        // Fall through to serve fallback
      }
      
      // Fallback HTML for development (no ASSETS binding)
      const fallbackHTML = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Rental Management</title></head><body><h1>Internal server error!</h1></body></html>';
      
      return new Response(fallbackHTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-cache'
        }
      });
    }

    // Skip rate limiting in development (localhost)
    const isDevelopment = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    if (!isDevelopment && shouldRateLimit(url.pathname)) {
      const rateLimitKey = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'anonymous';
      const result = authRateLimiter(rateLimitKey);
      if (!result.ok) {
        return withCors(json({ error: 'Too many requests' }, 429), allowOrigin);
      }
    }

    try {
      if (url.pathname === '/api/signup' && request.method === 'POST') {
        return withCors(await signup(request, env), allowOrigin);
      }

      if (url.pathname === '/api/login' && request.method === 'POST') {
        return withCors(await login(request, env), allowOrigin);
      }

      if (url.pathname === '/api/update_password' && request.method === 'POST') {
        return withCors(await updatePassword(request, env), allowOrigin);
      }

      if (url.pathname === '/api/request_reset' && request.method === 'POST') {
        return withCors(await requestReset(request, env), allowOrigin);
      }

      if (url.pathname === '/api/reset_password' && request.method === 'POST') {
        return withCors(await resetPassword(request, env), allowOrigin);
      }

      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        return withCors(await refreshToken(request, env), allowOrigin);
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        return withCors(await verifyJwt(request, env), allowOrigin);
      }

      // WebSocket ticket endpoint
      if (url.pathname === '/ws/ticket' && request.method === 'POST') {
        return withCors(await issueWebSocketTicket(request, env), allowOrigin);
      }

      if (url.pathname === '/ws/device-ticket' && request.method === 'POST') {
        return withCors(await issueDeviceWebSocketTicket(request, env), allowOrigin);
      }

      // The legacy device endpoint has no device-bound ticket and must not be used.
      if (url.pathname === '/ws/device') {
        return withCors(json({ error: 'Use the paired /ws/house/:houseId connection flow' }, 410), allowOrigin);
      }

      // WebSocket handler for house rooms
      if (url.pathname.startsWith('/ws/house/')) {
        return handleHouseRoomWebSocket(request, env, url);
      }

      const authUser = await getAuthUser(request, env);
      if (authUser.error) return withCors(json({ error: authUser.error }, authUser.status || 401), allowOrigin);

      if (
  url.pathname === '/api/provisioning/register' &&
  request.method === 'POST'
) {
  return withCors(
    await registerProvisionedAccount(request, env, authUser.user),
    allowOrigin
  );
}

      if (url.pathname === '/api/provisioning/users' && request.method === 'GET') {
        return withCors(await listProvisionableUsers(request, env, authUser.user), allowOrigin);
      }

      if (url.pathname === '/api/houses' && request.method === 'POST') {
        return withCors(await createHouse(request, env, authUser.user), allowOrigin);
      }

      if (url.pathname === '/api/houses' && request.method === 'GET') {
        return withCors(await listHouses(request, env, authUser.user), allowOrigin);
      }

      if (url.pathname.startsWith('/api/houses/')) {

                // House access management
        const houseAccessMatch = url.pathname.match(
          /^\/api\/houses\/(\d+)\/access(?:\/(\d+))?$/
        );

        if (houseAccessMatch) {
          const houseId = houseAccessMatch[1];
          const targetUserId = houseAccessMatch[2] || null;

          if (
            request.method === 'GET' &&
            !targetUserId
          ) {
            return withCors(
              await manageHouseAccess(
                request,
                env,
                authUser.user,
                houseId
              ),
              allowOrigin
            );
          }

          if (
            request.method === 'POST' &&
            !targetUserId
          ) {
            return withCors(
              await manageHouseAccess(
                request,
                env,
                authUser.user,
                houseId
              ),
              allowOrigin
            );
          }

          if (
            request.method === 'DELETE' &&
            targetUserId
          ) {
            return withCors(
              await manageHouseAccess(
                request,
                env,
                authUser.user,
                houseId,
                targetUserId
              ),
              allowOrigin
            );
          }

          return withCors(
            json({ error: 'Method not allowed or invalid route' }, 405),
            allowOrigin
          );
        }


        const pathParts = url.pathname.split('/').filter(Boolean);
        const isHouseDevicesRoute = /^\/api\/houses\/\d+\/devices$/.test(url.pathname);

        if (isHouseDevicesRoute && request.method === 'GET') {
          const houseId = pathParts[2];
          return withCors(await listHouseDevices(request, env, authUser.user, houseId), allowOrigin);
        }

        if (isHouseDevicesRoute && request.method === 'POST') {
          const houseId = pathParts[2];
          const rawBody = await request.clone().text();
          let payload = {};

          if (rawBody) {
            try {
              payload = JSON.parse(rawBody);
            } catch {
              payload = {};
            }
          }

          const mergedRequest = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify({ ...payload, house_id: Number(houseId) })
          });

          return withCors(await createDevice(mergedRequest, env, authUser.user), allowOrigin);
        }

        const id = pathParts[pathParts.length - 1];

        if (request.method === 'GET') {
          return withCors(await getHouse(request, env, authUser.user, id), allowOrigin);
        }

        if (request.method === 'PUT') {
          return withCors(await updateHouse(request, env, authUser.user, id), allowOrigin);
        }

        if (request.method === 'DELETE') {
          return withCors(await deleteHouse(request, env, authUser.user, id), allowOrigin);
        }
      }



      if (url.pathname.startsWith('/api/devices/')) {
        const pathParts = url.pathname.split('/').filter(Boolean);
        const id = pathParts[2];

        if (pathParts.length === 4 && pathParts[3] === 'access' && request.method === 'GET') {
          return withCors(await manageDeviceAccess(request, env, authUser.user, id), allowOrigin);
        }

        if (pathParts.length === 4 && pathParts[3] === 'access' && request.method === 'POST') {
          return withCors(await manageDeviceAccess(request, env, authUser.user, id), allowOrigin);
        }

        if (pathParts.length === 5 && pathParts[3] === 'access' && request.method === 'DELETE') {
          return withCors(await manageDeviceAccess(request, env, authUser.user, id, pathParts[4]), allowOrigin);
        }

        if (pathParts.length === 4 && pathParts[3] === 'fingerprints' && request.method === 'GET') {
          return withCors(await listFingerprintEnrollments(env, authUser.user, id), allowOrigin);
        }

        if (pathParts.length === 5 && pathParts[3] === 'fingerprints' && pathParts[4] === 'enroll' && request.method === 'POST') {
          return withCors(await startFingerprintEnrollment(env, authUser.user, id), allowOrigin);
        }

        if (pathParts.length === 5 && pathParts[3] === 'fingerprints' && pathParts[4] === 'enroll' && request.method === 'DELETE') {
          return withCors(await cancelFingerprintEnrollment(env, authUser.user, id), allowOrigin);
        }

        if (pathParts.length === 5 && pathParts[3] === 'fingerprints' && request.method === 'DELETE') {
          return withCors(await removeFingerprintEnrollment(request, env, authUser.user, id, pathParts[4]), allowOrigin);
        }

        if (pathParts.length === 4 && pathParts[3] === 'pairing-key' && request.method === 'POST') {
          return withCors(await rotateDevicePairingKey(request, env, authUser.user, id), allowOrigin);
        }

        if (request.method === 'GET') {
          return withCors(await getDevice(request, env, authUser.user, id), allowOrigin);
        }

        if (request.method === 'PUT') {
          return withCors(await updateDevice(request, env, authUser.user, id), allowOrigin);
        }

        if (request.method === 'DELETE') {
          return withCors(await deleteDevice(request, env, authUser.user, id), allowOrigin);
        }
      }

      if (url.pathname === '/api/tenants' && request.method === 'POST') {
        return withCors(await createTenant(request, env, authUser.user), allowOrigin);
      }

      if (url.pathname === '/api/tenants' && request.method === 'GET') {
        return withCors(await listTenants(request, env, authUser.user), allowOrigin);
      }

      if (url.pathname.startsWith('/api/tenants/')) {
        const id = url.pathname.split('/').pop();

        if (request.method === 'GET') {
          return withCors(await getTenant(request, env, authUser.user, id), allowOrigin);
        }

        if (request.method === 'PUT') {
          return withCors(await updateTenant(request, env, authUser.user, id), allowOrigin);
        }

        if (request.method === 'DELETE') {
          return withCors(await deleteTenant(request, env, authUser.user, id), allowOrigin);
        }
      }

      return withCors(new Response('Rental Management Worker is running!', { status: 200 }), allowOrigin);
    } catch (error) {
      console.error(error);
      return withCors(json({ error: error.message }, 500), allowOrigin);
    }
  }
};
