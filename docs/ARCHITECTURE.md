# Project Architecture

This document describes the current code layout and is the starting point for developers making changes. The refactor is intentionally incremental: existing route behavior, the D1 schema, and old import paths remain supported while responsibilities are separated.

## What the application does

ReMan is a property and rental-management application hosted on Cloudflare Workers. It provides account and tenant management, property assignments, smart-device provisioning and access control, and realtime device communication. Cloudflare D1 stores application data; Durable Objects and WebSockets coordinate property/device sessions.

## Runtime flow

1. `src/worker.js` receives HTTP requests, handles CORS/rate limiting, routes API paths, and serves the configured asset binding.
2. Domain handlers validate request input, apply role/access rules, and read or write D1.
3. WebSocket ticket endpoints validate a short-lived ticket before forwarding a connection to a Durable Object.
4. `src/houseRoom.js` and `src/deviceRoom.js` own realtime room behavior.

Keep `worker.js` focused on transport and dispatch. Business rules belong in the domain modules, not duplicated in route branches.

## Backend layout

```text
src/
  worker.js                  # Cloudflare Worker entry point and route dispatch
  auth.js                    # Signup, login, password lifecycle, JWT/session checks
  tenant.js                  # Legacy import facade for tenant/property/device domain exports
  user.js                    # Legacy import facade for account-management exports
  modules/
    accounts.js              # Account provisioning, administration, suspension, deletion
    account-status.js        # Shared active/suspended account-state persistence
    access-control.js        # Shared property ownership and device-access checks
    property-compat.js       # Legacy house/property ID and record normalization
    tenants.js               # Tenant profile and rental record operations
    properties.js            # Property CRUD and legacy house route aliases
    devices.js               # Device CRUD, pairing keys, and property device lists
    access.js                # Property and device user-access management
    tenant.js                # Compatibility barrel for the domain handlers above
    user.js                  # Compatibility re-export for account-management callers
  lib/
    crypto.js                # Password and cryptographic helpers
    email.js                 # Temporary-password email delivery
    validation.js            # Request validation and sanitization
    rateLimit.js             # Rate limiter
    websocketTicket.js       # Ticket issue and validation
  houseRoom.js               # Property-room Durable Object
  deviceRoom.js              # Device-room Durable Object
  fingerprints.js            # Fingerprint enrollment endpoints
```

### Where a change belongs

- Login, token refresh, password reset, and authenticated request checks: `src/auth.js`.
- Account provisioning and admin/owner account management: `src/modules/accounts.js`.
- Tenant records and tenant profile rules: `src/modules/tenants.js`.
- Property endpoints: `src/modules/properties.js`.
- Device endpoints and pairing-key operations: `src/modules/devices.js`.
- Property/device user-access management: `src/modules/access.js`.
- Shared property ownership/access checks: `src/modules/access-control.js`.
- House/property compatibility mapping: `src/modules/property-compat.js`.
- HTTP route matching, CORS, and Worker bindings: `src/worker.js`.
- WebSocket messages and Durable Object state: `src/houseRoom.js` and `src/deviceRoom.js`.
- Database changes: a new, ordered SQL migration under `migrations/`; do not edit an already-applied migration.

`src/auth.js`, `src/tenant.js`, `src/user.js`, and `src/modules/tenant.js` are retained as stable import surfaces. Prefer the focused modules for new code; do not remove or rename the compatibility surfaces without verifying all callers.

## Property and database compatibility

The current database still uses legacy `houses` and `house_id` names. API routes and payloads support both property- and house-oriented names for compatibility with existing clients. A code-organization refactor must not rename those tables, columns, routes, or response fields. Schema changes require a separate migration and compatibility plan.

## Frontend and deployment assets

The frontend source is organized under `public/public/`. Wrangler serves the static output in `dist/` through the `ASSETS` binding. `npm run build:frontend` copies the source assets into `dist/`; both `npm run build` and `npm run deploy` run this step first. Keep frontend edits in the source tree rather than editing generated output directly.

## Tests and local verification

Tests use Node's built-in test runner and live under `tests/`. Run:

```sh
node --test
npm run build
```

When working on an existing behavior, add or update a test that captures the behavior before changing implementation. Run the focused test while iterating, then the full suite and deployment dry run before handing off.
