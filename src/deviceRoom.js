/**
 * Deprecated legacy Durable Object.
 *
 * All device and browser WebSockets must use the authenticated, ticket-bound
 * HouseRoom route (`/ws/house/:houseId`). The old implementation inferred
 * device identity from User-Agent and accepted unauthenticated sockets. Keep
 * the class exported for the existing Durable Object migration history, but
 * reject connections so it cannot accidentally become a security bypass.
 */
import { DurableObject } from 'cloudflare:workers';

export class DeviceRoom extends DurableObject {
  async fetch() {
    return new Response('This legacy endpoint is disabled. Use the authenticated HouseRoom connection flow.', {
      status: 410,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}
