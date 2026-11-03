# ReMan Source Audit & Refactor Report

**Scope:** Frontend, Cloudflare Worker API, authentication, D1 schema/migrations, Durable Objects, WebSocket device transport, fingerprint enrollment, build/development workflow.

**Approach:** Preserve the existing vanilla-JS frontend, API route conventions, D1 data model, HouseRoom protocol, device pairing-key flow, and ESP32 JSON command/event contract. Apply focused fixes where a larger rewrite would create unnecessary compatibility risk.

## Executive summary

The supplied source had several high-impact security and reliability defects. The most serious were the incorrect resolution of Cloudflare Secrets Store bindings for JWT signing, an administrator signup-code check that did not validate the code, publicly seeded demo credentials in the production migration chain, and duplicated WebSocket session enumeration. The password-reset UI also called API routes that did not exist in the Worker.

The refactored baseline addresses these issues and adds regression tests. It is prepared as a local-first project so `npm run dev` and the local database scripts use a separate `reman-local` D1 database configuration rather than the production database binding.

## Findings and changes

### Critical / high severity

1. **JWT secret binding was treated as a string.**
   - `wrangler.jsonc` declares `JWT_SCRT` as a Cloudflare Secrets Store binding, whose value must be read with `.get()`.
   - The previous authentication and WebSocket code encoded the binding object directly. That can produce a predictable string representation rather than the configured secret.
   - Added `src/lib/secrets.js` to support both Secrets Store bindings and local string secrets, and applied it consistently to JWT signing, JWT verification, and password-reset HMAC generation.
   - Weak or missing JWT secrets now fail instead of silently becoming usable keys.

2. **Administrator signup did not validate the registration code.**
   - The old implementation only checked that `payload.code` was non-empty. It did not verify that the code existed or was unused.
   - Admin signup now looks up an unused key and atomically consumes it before creating the account. Arbitrary strings are rejected.

3. **A known demo administrator identity and bootstrap key were in the production migration chain.**
   - Migration `0003_seed_test_data.sql` is now intentionally a no-op for fresh databases. Demo identities belong only in `scripts/local-demo-accounts.sql`.
   - New migration `0014_revoke_legacy_demo_credentials.sql` marks the historical `admin-demo-key` as used and suspends only the exact seeded account/password-hash combination. It does not suspend an account that has since changed its password hash.
   - Local demo accounts remain available through `npm run db:seed:local`.

4. **WebSocket session enumeration duplicated every live session.**
   - `HouseRoom.getAllSessions()` first collected active sockets and then appended the in-memory index, causing duplicate entries.
   - It now uses accepted WebSockets as the authoritative source after hibernation and deduplicates by `sessionId`.
   - Added regression coverage for duplicate restoration and broadcast behavior.

5. **Device telemetry, responses, and command results were broadcast too broadly.**
   - Browser tickets are bound to a specific device, but the old response fan-out used only the `web` client type. The connected-device list also ignored the requesting session.
   - Added device-scoped delivery for telemetry, device status, command result/timeout, and device response messages. Non-admin sessions can list only their own connected device; admins retain the room-wide list.

6. **The device simulator used obsolete credentials and an incompatible protocol.**
   - It attempted to log in as a demo administrator, used the wrong response field, sent `device_update.status` as `on/off` (the server requires `online`), and did not send `device_response` acknowledgements with command IDs.
   - It now uses the device pairing key and `/ws/device-ticket`, uses the house ID returned by the server, sends the current telemetry envelope, and acknowledges relay/door/fingerprint commands. The pairing key is never printed.

7. **Legacy DeviceRoom inferred identity from User-Agent.**
   - The old class accepted sockets and inferred device/browser roles from a User-Agent string.
   - The active Worker route already uses ticket-bound HouseRoom connections. The unused legacy `DeviceRoom` class now rejects connections with HTTP 410 while remaining exported/bound to preserve Durable Object migration history.

### Medium severity / reliability

8. **Reconnects could leave multiple active sockets for one physical device.**
   - A new device session now closes and cleans up an older session for the same device before registering the new connection. This avoids duplicate command delivery after reconnects.

9. **Fingerprint reservations could remain stuck after a browser crash or disconnect.**
   - Added `pending_expires_at` in migration `0015_fingerprint_pending_expiry.sql`.
   - Reservations expire after two minutes and are recoverable on the next enrollment attempt.
   - Completion, cancellation, failure, and disable flows clear the pending expiry.
   - Unique-slot races return HTTP 409 rather than an opaque 500.

10. **Fingerprint enrollment could leave listeners/timers behind.**
   - The frontend enrollment promise now has one settlement path, removes message/close/error listeners, clears its timeout, and catches synchronous send failures.

11. **The password-reset UI used missing backend routes and its entry link stayed hidden.**
    - The frontend called `/api/password-reset/request` and `/api/password-reset/confirm`, while the Worker exposed only the older `/api/request_reset` and `/api/reset_password` routes.
    - The login UI previously waited for an `INVALID_PASSWORD` code that the API never returned, so the forgot-password link stayed hidden. It now appears for any generic 401 login failure without disclosing whether the email exists.
    - Implemented the two OTP routes expected by the frontend.
    - Codes are six digits, stored as HMACs keyed by the JWT secret, expire after ten minutes, and are consumed atomically once.
    - Password reset invalidates refresh tokens. Email delivery uses the existing Resend Secrets Store bindings and an eight-second timeout.
    - Responses do not reveal whether an email address exists.

12. **Account-status checks failed open on database errors.**
    - Account status and HouseRoom permission schema lookups now propagate database errors so authentication/commands are denied when status cannot be verified.

13. **The per-isolate rate limiter was unbounded and incomplete.**
    - Added opportunistic expired-entry cleanup and a maximum map size.
    - Added the refresh, password-reset OTP, and WebSocket ticket endpoints to the local limiter.
    - This remains a per-isolate best-effort limiter, not a distributed Cloudflare-wide security boundary. Production should also use Cloudflare Rate Limiting/WAF rules.

14. **CORS defaulted to wildcard for unrecognized origins.**
    - CORS now allows the configured application origins and localhost development origins, rejects other browser origins, and emits `Vary: Origin`.
    - Requests without an Origin header (such as device-to-Worker requests) remain supported without an ACAO header.

15. **Unknown routes returned HTTP 200 and internal exception messages were exposed.**
    - Unknown routes now return JSON 404.
    - Unhandled errors return a generic JSON 500 while the detailed exception remains in server logs.
    - JSON responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

16. **WebSocket house IDs used permissive `parseInt`.**
    - The route now requires an exact positive integer path segment and a safe integer.

17. **Frontend API requests could wait indefinitely.**
    - Added a default 20-second request timeout and support for caller-provided `AbortSignal` cancellation.
    - Dashboard loads abort prior loads, ignore stale results, and tolerate an isolated property-device request failure without discarding the entire dashboard.

18. **Build output could retain deleted/stale frontend files.**
    - The frontend build now deletes `dist` before copying the canonical `public/public` source.
    - Local `dev` and `start` scripts build the frontend first.
    - Added `wrangler.local.jsonc`; local dev and local D1 scripts use a separate `reman-local` database name and do not target the production D1 binding.

19. **Unknown-email login timing differed from wrong-password timing.**
    - `fakeVerify()` now performs PBKDF2 work rather than a single SHA-256 digest to reduce account-enumeration timing differences.

20. **Legacy password-reset token consumption was race-prone.**
    - The legacy reset endpoint now atomically marks a reset token used before applying the password update.

## Validation performed

- **JavaScript syntax:** `node --check` is run across the project source and tests before packaging.
- **Frontend build:** `npm run build:frontend` completed successfully.
- **SQLite migration validation:** all 15 migrations applied in order to a clean in-memory SQLite database. The local demo seed SQL also applied successfully after the migrations.
- **Automated tests:** 37 selected tests passed, including HouseRoom routing/session tests, fingerprint tests, account/provisioning tests, validation tests, and secret-binding tests.
- **Full test suite limitation:** the dependency installation in the review environment did not complete; the `jose` package was absent from the partial `node_modules` directory. Therefore tests that import `jose` could not be executed here. Run `npm ci` followed by `npm test` in your environment before accepting the baseline.
- **Not performed:** Cloudflare remote deployment, live D1 migration, browser end-to-end test, and physical ESP32-C3/R558S/relay test. These require your Cloudflare account and actual hardware.

## Deployment and compatibility notes

- The local-first scripts use `wrangler.local.jsonc` and the `reman-local` local D1 database. They are the recommended starting point for testing.
- The production `wrangler.jsonc` retains the original D1 and Secrets Store identifiers. `npm run deploy` still targets that configured production environment. Do not run remote migrations or deploy until you have reviewed the configuration and backed up D1.
- Migrations `0014` and `0015` are additive/safety migrations for an existing installation. Review migration `0014` against your production users before applying it; it intentionally suspends the exact known seeded account if it still has the original seeded hash.
- Fixing JWT secret retrieval can invalidate access tokens that were previously signed using the incorrect object-string value. Existing refresh tokens may still be used to obtain new access tokens if they remain valid in D1.
- The ESP32 command names, device pairing-key exchange, HouseRoom WebSocket route, and existing JSON message structures were retained. The legacy DeviceRoom is disabled; firmware must use the paired `/ws/house/:houseId` flow.
- Administrator bootstrap keys must be created privately in D1. Never commit a key or expose it in frontend source. The old public demo key is revoked by migration 0014.

## Remaining recommendations

- Configure Cloudflare Rate Limiting/WAF rules for authentication and ticket endpoints.
- Set up a production alert for Durable Object errors, repeated device reconnects, and command timeouts.
- Add end-to-end tests against a local Wrangler/D1/DO environment and run a physical test matrix with the ESP32-C3 and fingerprint sensor.
- Consider refresh-token rotation and hashed refresh-token storage in a separately tested migration, because this changes cross-tab session behavior and should be rolled out deliberately.
- Add a proper email delivery/verification status UI for password-reset requests. The endpoint deliberately returns a generic response even if email delivery is not configured or fails.
