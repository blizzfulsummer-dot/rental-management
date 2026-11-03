# Feature modules

All feature factories receive shared application dependencies from `app.js`.

- `auth/` — signup, session lifecycle, password policy, and email-code reset.
- `dashboard/` — data orchestration, role-aware view dispatch, and dashboard presentation.
- `properties/` — property cards and house access.
- `accounts/` — account search/filter, role-aware editing, and account provisioning.
- `devices/` — device UI/CRUD/access/pairing, WebSocket transport, and fingerprint interactions.

Tenant rent/deposit/balance fields are still managed through the account workflow. A separate billing ledger/payment feature is not present in the supplied frontend and should only be added when its backend contract is defined.
