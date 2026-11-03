# ReMan Fresh Local Test Guide

This package is configured to start locally against a separate `reman-local` D1 database. It does not use the production D1 binding for the local commands below.

## 1. Install dependencies

```sh
npm ci
```

## 2. Configure local secrets

Copy `.dev.vars.example` to `.dev.vars`, then replace `JWT_SCRT` with a random value of at least 32 characters. The Resend values are optional unless you want to test temporary-password and password-reset emails.

Do not commit `.dev.vars`.

## 3. Create the local database and demo accounts

```sh
npm run db:setup:local
```

This applies the migrations to the local `reman-local` database and then inserts the local-only demo accounts.

All four local demo accounts use:

```text
DemoPass123!
```

Their emails are:

- `admin.demo@example.test`
- `owner.demo@example.test`
- `user.demo@example.test`
- `tenant.demo@example.test`

## 4. Start the local app

```sh
npm run dev
```

Open the local Wrangler URL shown in the terminal (normally `http://localhost:8787`). The dev command rebuilds `dist` from `public/public` before starting Wrangler.

## 5. Run tests

```sh
npm test
```

## 6. Test device flows

1. Create a property and device from the local admin account.
2. Generate a device pairing key and configure the ESP32 with the device ID and key.
3. Ensure the ESP32 connects through the paired `/ws/house/:houseId` flow.
4. Test status, door lock/unlock, relay control, fingerprint status, enrollment, deletion, and reconnect behavior.
5. Disconnect Wi-Fi during a command and verify the UI reports a timeout/failure instead of showing a false success.

For the Node simulator on Windows PowerShell, set `$env:DEVICE_ID` and `$env:DEVICE_API_KEY` to the device ID and the 64-character pairing key from the dashboard, then run `npm run device:sim`. The simulator resolves the property ID from the pairing service and does not need an administrator login.

A browser-only run cannot verify electrical safety, relay timing, sensor UART stability, or actual ESP32 reconnect behavior. Test those on the physical hardware before deployment.

## 7. Production warning

`wrangler.jsonc` retains the original production D1 and Secrets Store identifiers. `npm run deploy` uses that production configuration. Do not run remote migrations or deploy from this test copy unless you intentionally want to update that configured production environment and have a current D1 backup.
