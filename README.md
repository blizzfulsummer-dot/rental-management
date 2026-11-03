# 🏠 Rental Management API with Smart Home WebSocket System

A complete Cloudflare Workers API for rental property management with real-time smart home IoT device communication.

## 🌟 Features

### Core API
- ✅ User authentication with JWT (HS256)
- ✅ Tenant management (create, read, update, delete)
- ✅ Password reset system with secure tokens
- ✅ User signup with invite codes
- ✅ Request validation and error handling
- ✅ Rate limiting on sensitive endpoints
- ✅ CORS support for frontend integration

### Real-time Smart Home (NEW!)
- ✅ **WebSocket Room System** - Per-house Durable Objects for real-time communication
- ✅ **Secure Tickets** - Short-lived, single-use tokens for WebSocket access
- ✅ **Device Commands** - Web clients send commands to IoT devices
- ✅ **ESP32 Pairing** - One-time device keys are hashed in D1 and exchanged for device-bound tickets
- ✅ **Status Updates** - Devices broadcast real-time status to web clients
- ✅ **Session Management** - Track authenticated users and devices
- ✅ **Admin Monitoring** - See all active sessions in a house room
- ✅ **Keep-alive** - Ping/pong mechanism for connection stability

### Frontend (NEW!)
- ✅ **Dashboard UI** - Modern, responsive smart home control panel
- ✅ **Real-time Updates** - Live device status display
- ✅ **Device Control** - Send commands (turn on/off) to devices
- ✅ **Activity Log** - Real-time events and system messages
- ✅ **Multi-client** - Support multiple simultaneous users

### Testing Tools (NEW!)
- ✅ **Device Simulator** - Node.js IoT device for testing
- ✅ **Test Documentation** - Complete testing scenarios
- ✅ **API Examples** - curl and wscat commands

## 🚀 Quick Start

### 1. Install & Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

To try the different account types against your **local** D1 database, run `npm run db:seed:local`, then sign in using the credentials documented in [Getting Started](docs/01-GETTING_STARTED.md). The seeded password for all four demo accounts is `DemoPass123!`. This command is local-only and must not be changed to use a remote database.

The worker will:
- Start on `http://localhost:8787`
- Auto-apply database migrations
- Serve the frontend at `/`

### 2. Access Frontend

Open browser:
```
http://localhost:8787/
```

Login with demo credentials:
```
Email: admin.demo@example.test
Password: DemoPass123!
```

### 3. Test with Device Simulator

In a new terminal:
```bash
npm run device:sim
```

You'll see:
- Device connects to WebSocket room
- Device appears in dashboard
- Simulate sending/receiving commands

## 📁 Project Structure

```
rental-management-api/
├── src/
│   ├── worker.js                  # Worker entry point and route dispatch
│   ├── auth.js                    # Signup and authentication/session flows
│   ├── tenant.js                  # Legacy tenant-domain import facade
│   ├── user.js                    # Legacy account-domain import facade
│   ├── modules/
│   │   ├── accounts.js            # Provisioning and managed accounts
│   │   ├── account-status.js      # Shared active/suspended state handling
│   │   ├── access-control.js      # Ownership and device-access checks
│   │   ├── property-compat.js     # House/property compatibility helpers
│   │   ├── tenants.js             # Tenant profile and rental records
│   │   ├── properties.js          # Property CRUD and legacy route aliases
│   │   ├── devices.js             # Device CRUD, pairing, and property listings
│   │   ├── access.js              # Property/device access management
│   │   ├── tenant.js              # Domain compatibility barrel
│   │   └── user.js                # Account compatibility re-export
│   ├── lib/                       # Validation, crypto, email, rate limiting, tickets
│   ├── houseRoom.js               # Property-room Durable Object
│   ├── deviceRoom.js              # Device-room Durable Object
│   └── fingerprints.js            # Fingerprint enrollment API
├── public/public/                 # Newer modular frontend reference
├── dist/                          # Wrangler static-assets directory
├── migrations/                    # Ordered D1 SQL migrations
├── tests/                         # Node.js built-in test suite
├── docs/                          # API, architecture, deployment, and contributor docs
├── wrangler.jsonc                 # Cloudflare Worker configuration
└── package.json
```

See [Project Architecture](docs/ARCHITECTURE.md) for module responsibilities, compatibility rules, and the current frontend/deployment workflow.

## 📖 Documentation

### Getting Started
- **[01-GETTING_STARTED.md](docs/01-GETTING_STARTED.md)** - Setup and basic usage
- **[FRONTEND_TESTING.md](FRONTEND_TESTING.md)** - Frontend dashboard walkthrough

### API & Architecture
- **[02-API.md](docs/02-API.md)** - Complete API reference
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** - Current system design and module map
- **[04-DATABASE.md](docs/04-DATABASE.md)** - Database schema

### Smart Home & WebSocket
- **[08-WEBSOCKET.md](docs/08-WEBSOCKET.md)** - WebSocket protocol details
- **[09-WEBSOCKET_SETUP.md](docs/09-WEBSOCKET_SETUP.md)** - Integration guide
- **[WEBSOCKET_INTEGRATION_SUMMARY.md](WEBSOCKET_INTEGRATION_SUMMARY.md)** - Quick overview

### Security & Deployment
- **[05-SECURITY.md](docs/05-SECURITY.md)** - Security best practices
- **[06-DEPLOYMENT.md](docs/06-DEPLOYMENT.md)** - Production deployment

### Testing & Contributing
- **[TESTING_COMPLETE_SYSTEM.md](TESTING_COMPLETE_SYSTEM.md)** - Full testing guide
- **[07-CONTRIBUTING.md](docs/07-CONTRIBUTING.md)** - Contributing guidelines

## 🧪 Testing Guide

### Basic Frontend Test (5 minutes)

```bash
# Terminal 1: Start server
npm run dev

# Browser: http://localhost:8787/
# Login with admin.demo@example.test / DemoPass123!
```

### Full System Test (15 minutes)

```bash
# Terminal 1: Start server
npm run dev

# Browser: http://localhost:8787/
# Login with admin.demo@example.test / DemoPass123!

# Terminal 2 (PowerShell): Start device simulator using the one-time pairing key
$env:DEVICE_ID = "1"
$env:DEVICE_API_KEY = "<64-character-pairing-key>"
npm run device:sim

# Browser: Watch device appear and respond to commands

The simulator now uses the same device pairing-key flow as the ESP32. Copy the pairing key shown when creating/rotating a device and pass it through `DEVICE_API_KEY`; do not use an administrator password or a demo API key.
```

### API Testing (curl/wscat)

See [TESTING_COMPLETE_SYSTEM.md](TESTING_COMPLETE_SYSTEM.md) for:
- JWT token requests
- WebSocket ticket generation
- WebSocket message testing
- Load testing scenarios

## 🔒 Security Features

### Authentication
- ✅ JWT tokens (HS256 with secret)
- ✅ Secure password hashing (Argon2)
- ✅ Password reset tokens (single-use)
- ✅ Rate limiting (10 requests/15 min per IP)

### WebSocket
- ✅ Short-lived tickets (60 seconds)
- ✅ Single-use enforcement
- ✅ Permission validation
- ✅ No sensitive data in URLs
- ✅ House-bound sessions

### Database
- ✅ D1 SQLite with Cloudflare
- ✅ Prepared statements (SQL injection prevention)
- ✅ Indexed queries for performance
- ✅ Automatic backups

## 🛠️ Available Commands

```bash
npm run dev              # Start development server
npm run build            # Build for production
npm run deploy           # Deploy to Cloudflare
npm test                 # Run test suite
npm run device:sim       # Run IoT device simulator
```

## 🔧 Configuration

### Environment Variables

```bash
# In .env file
JWT_SCRT=your_jwt_secret_here
```

### Cloudflare Secrets

Store production secrets in Cloudflare:
```bash
wrangler secret put JWT_SCRT
```

## 📊 Database Schema

### Core Tables
- `users` - User accounts
- `tenants` - Property tenant records
- `refresh_tokens` - Session tokens
- `password_resets` - Reset token storage

### Smart Home Tables
- `houses` - Property/house records
- `devices` - IoT device registry
- `user_house_access` - Permission mappings
- `websocket_tickets` - Ticket lifecycle
- `device_key_hash` - SHA-256 hash for ESP32 pairing keys (migration `0007_device_pairing_keys.sql`)
- `device_fingerprint_enrollments` - User-to-device fingerprint slots and enrollment state (migration `0008_fingerprint_enrollments.sql`)

## 🚀 Deployment

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm run deploy
```

See [06-DEPLOYMENT.md](docs/06-DEPLOYMENT.md) for detailed steps.

## 🤝 Contributing

See [07-CONTRIBUTING.md](docs/07-CONTRIBUTING.md) for:
- Code style guidelines
- Testing requirements
- PR process
- Release procedures

## 📝 What's New

### Version 2.0.0 (Smart Home Release)

Added complete real-time WebSocket infrastructure:
- ✅ Per-house Durable Objects
- ✅ Secure ticket-based authentication
- ✅ Device command routing
- ✅ Real-time status updates
- ✅ Session management
- ✅ Frontend dashboard
- ✅ Device simulator
- ✅ Comprehensive documentation

See [WEBSOCKET_INTEGRATION_SUMMARY.md](WEBSOCKET_INTEGRATION_SUMMARY.md) for details.

## 📞 Support

### Common Questions

**Q: How do I add and pair an ESP32 device?**
A: Create it from the owner/admin Devices dashboard and follow the one-time
pairing instructions. Apply migration `0007_device_pairing_keys.sql` before
deploying the updated Worker. See [08-WEBSOCKET.md](docs/08-WEBSOCKET.md).

**Q: How do I enable dashboard door and fingerprint access?**
A: Apply migration `0008_fingerprint_enrollments.sql` and deploy the updated
Worker and dashboard. Users with device access can enroll or replace their own
fingerprint; owners/admins can disable or delete enrollment records. The door
unlock command pulses Relay 1 for five seconds, and a fingerprint unlock is
allowed only for an active enrollment whose user still has access to that
device. Update and flash the ESP32 firmware before enabling these controls.

**Q: Can I use real IoT devices (ESP32)?**  
A: Yes! See [09-WEBSOCKET_SETUP.md](docs/09-WEBSOCKET_SETUP.md) for device authentication options.

**Q: Is this production-ready?**  
A: Yes, but customize the permission model and device types for your use case. See integration guide.

**Q: How do I test without IoT devices?**  
A: Use the device simulator: `npm run device:sim`. Fully functional testing without hardware.

### Getting Help

1. **Read the docs** - Start with [01-GETTING_STARTED.md](docs/01-GETTING_STARTED.md)
2. **Run tests** - Follow [TESTING_COMPLETE_SYSTEM.md](TESTING_COMPLETE_SYSTEM.md)
3. **Check examples** - See example code in documentation
4. **Review logs** - Use `wrangler tail` for debugging

## 📄 License

Property of rental management system

## ✨ Key Features Summary

| Feature | Status | Details |
|---------|--------|---------|
| User Authentication | ✅ | JWT with Argon2 hashing |
| Tenant Management | ✅ | Full CRUD operations |
| Password Reset | ✅ | Secure token system |
| WebSocket Rooms | ✅ | Per-house Durable Objects |
| Device Commands | ✅ | Real-time message routing |
| Status Updates | ✅ | Broadcast to all clients |
| Session Management | ✅ | Authenticated tracking |
| Frontend Dashboard | ✅ | Modern React-free UI |
| Device Simulator | ✅ | Node.js test tool |
| API Documentation | ✅ | Complete with examples |
| Deployment Guide | ✅ | Production ready |

---

**Ready to manage your rental properties with real-time smart home control!** 🏠✨


## Fresh-start security notes (refactored baseline)

- Production migrations no longer seed demo users or demo administrator keys. Local demo accounts are created only by `npm run db:seed:local`.
- Administrator signup requires an unused row in `signup_keys`; an arbitrary non-empty code is rejected. Create a one-time bootstrap key yourself and insert it into the target D1 database through the Cloudflare dashboard or `wrangler d1 execute` (SQL: `INSERT INTO signup_keys (code, used) VALUES ('<your-random-key>', 0);`). Never commit the key or place it in frontend code.
- Migration `0014_revoke_legacy_demo_credentials.sql` revokes the historical `admin-demo-key` and suspends only the exact legacy seeded account/password hash. Review the effect against your live database before applying it.
- The in-memory auth limiter is only a per-isolate best-effort guard. Configure Cloudflare Rate Limiting/WAF rules for reliable production-wide enforcement.
- `npm run dev` now builds the frontend before starting Wrangler. `npm run build:frontend` recreates `dist` from the canonical `public/public` source, removing stale generated files first.

Example one-time key generation (run locally; keep the output private):

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Insert the generated value as a bound SQL literal using the Cloudflare D1 console, or use a carefully quoted `wrangler d1 execute` command. Do not use the example demo key.


For the isolated local-first setup and test workflow, see [LOCAL_TEST_GUIDE.md](LOCAL_TEST_GUIDE.md) and [AUDIT_REPORT.md](AUDIT_REPORT.md).
