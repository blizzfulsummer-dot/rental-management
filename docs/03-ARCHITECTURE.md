# Architecture Overview

> **Current structure:** This page contains the original architecture description. For the maintained module map and current contribution guidance, see [Project Architecture](./ARCHITECTURE.md).

## System Architecture

The Rental Management API is built on **Cloudflare Workers** with **D1 SQLite database** for serverless, edge-computed functionality.

```
┌─────────────────────────────────────────────────────────────┐
│                     Client Applications                      │
│        (Frontend, Mobile Apps, Third-party integrations)    │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS Requests
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloudflare Workers (Edge Network)              │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              src/worker.js (Router)                  │  │
│  │  • Request routing                                   │  │
│  │  • CORS handling                                     │  │
│  │  • Rate limiting                                     │  │
│  └──────────────────────────────────────────────────────┘  │
│           │                         │                        │
│           ▼                         ▼                        │
│  ┌──────────────────────┐  ┌──────────────────────────┐    │
│  │   src/auth.js        │  │   src/tenant.js          │    │
│  │ (Authentication)     │  │ (Tenant Management)      │    │
│  │ • Signup             │  │ • Create tenant          │    │
│  │ • Login              │  │ • List tenants           │    │
│  │ • Token refresh      │  │ • Get tenant             │    │
│  │ • Password reset     │  │ • Update tenant          │    │
│  │ • JWT verification   │  │ • Delete tenant          │    │
│  └──────────────────────┘  └──────────────────────────┘    │
│           │                         │                        │
│           └──────────────┬──────────┘                        │
│                          ▼                                   │
│          ┌────────────────────────────────┐                 │
│          │   src/lib/ (Utilities)         │                 │
│          │ • crypto.js                    │                 │
│          │ • validation.js                │                 │
│          │ • rateLimit.js                 │                 │
│          └────────────────────────────────┘                 │
│                          │                                   │
│                          ▼                                   │
│          ┌────────────────────────────────┐                 │
│          │   D1 Database (SQLite)         │                 │
│          └────────────────────────────────┘                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Module Breakdown

### 1. **src/worker.js** - Request Router & Middleware

**Responsibilities:**
- Route incoming HTTP requests to appropriate handlers
- Handle CORS headers and preflight requests
- Apply rate limiting to sensitive endpoints
- Top-level error handling and JSON response formatting

**Key Functions:**
- `fetch(request, env)` - Main entry point for Cloudflare Workers
- `withCors(response, allowOrigin)` - Add CORS headers
- `getAllowOrigin(request)` - Determine allowed origin
- `shouldRateLimit(pathname)` - Check if endpoint needs rate limiting

**Dependencies:**
- `crypto.js`, `validation.js`, `rateLimit.js` (from lib/)
- `auth.js`, `tenant.js` (handlers)

### 2. **src/auth.js** - Authentication & Authorization

**Responsibilities:**
- Handle user signup with validation and invitation codes
- Authenticate users via email/password
- Issue and validate JWT tokens
- Manage password resets and updates
- Implement refresh token mechanism

**Key Functions:**
- `signup(request, env)` - Create new user account
- `login(request, env)` - Authenticate and issue tokens
- `updatePassword(request, env)` - Change password
- `requestReset(request, env)` - Initiate password reset
- `resetPassword(request, env)` - Complete password reset
- `refreshToken(request, env)` - Issue new access token
- `verifyJwt(token, secret)` - Validate JWT token
- `getAuthUser(request, env)` - Extract user from Authorization header

**Dependencies:**
- `jose` - JWT operations
- `crypto.js` - Password hashing and validation
- `validation.js` - Input validation

### 3. **src/tenant.js** - Tenant CRUD Operations

**Responsibilities:**
- Create, read, update, and delete tenant records
- Enforce authorization (admin-only or own records)
- Manage tenant-user relationships
- Handle financial data (balance, deposit, rent)

**Key Functions:**
- `createTenant(request, env)` - Admin creates tenant
- `listTenants(request, env)` - Admin lists all tenants
- `getTenant(request, env)` - Fetch single tenant
- `updateTenant(request, env)` - Update tenant or own password
- `deleteTenant(request, env)` - Admin deletes tenant

**Authorization Rules:**
- Admin: Full access to all operations
- Tenant/User: Can only view/update their own record

**Dependencies:**
- `crypto.js` - Password handling
- `validation.js` - Input validation and ID validation

### 4. **src/lib/crypto.js** - Cryptographic Utilities

**Responsibilities:**
- Centralized password hashing and verification
- Legacy password migration support
- Secure temporary password generation
- Base64 and hex encoding/decoding

**Key Functions:**
- `hashPBKDF2(password)` - Hash password using PBKDF2
  - 100,000 iterations
  - SHA-256 algorithm
  - Random salt per password
  - Returns: `{hash, salt}` as hex strings
  
- `verifyPBKDF2(storedHex, saltHex, password)` - Verify PBKDF2 password
  - Timing-safe comparison
  - Returns: boolean
  
- `verifyLegacy(password, salt, hash)` - Support legacy SHA-256 hashes
  - For migration from old system
  - Returns: boolean
  
- `fakeVerify()` - Dummy verification
  - Prevents timing attacks
  - Consistent execution time
  
- `generateTempPassword(length)` - Generate random password
  - Used for admin-created accounts
  - Default: 10 characters
  
- `arrayBufferToHex(buffer)` / `hexToArrayBuffer(hex)` - Encoding utilities

**Cryptographic Standards:**
- PBKDF2-SHA256
- 100,000 key derivation iterations (NIST recommendation)
- Cryptographically secure random salts
- Base16 (hex) encoding for storage

**Dependencies:**
- Web Crypto API (Global)
- TextEncoder (Global)

### 5. **src/lib/validation.js** - Input Validation & Sanitization

**Responsibilities:**
- Validate all user inputs before database operations
- Prevent injection attacks through sanitization
- Enforce password strength requirements
- Validate numeric and ID parameters

**Key Functions:**
- `validateEmail(value)` - Email format validation
- `validatePassword(value)` - Password strength requirements
  - Minimum 8 characters
  - Uppercase letter required
  - Lowercase letter required
  - Number required
  - Symbol required
  
- `validateNumber(value, fieldName, allowNegative)` - Strict numeric validation
  - Prevents NaN values
  - Type checking
  - Range validation
  
- `validateId(value)` - ID parameter validation
  - Positive integers only
  - Prevents injection attacks
  - Ensures database safe values
  
- `sanitizeString(value, fieldName, maxLength)` - String sanitization
  - Trim whitespace
  - Length enforcement
  - Type validation
  
- `validateTenantPayload(payload)` - Comprehensive tenant field validation
- `validateSignupPayload(payload)` - Signup form validation
- `validateLoginPayload(payload)` - Login form validation
- `parseJsonBody(request)` - Safe JSON parsing with error handling

**Security Features:**
- Rejects NaN in numeric fields
- Whitelist validation (strict checks)
- Length limits on string fields
- SQL injection prevention (parameterized queries + validation)

**Dependencies:**
- None (pure utility module)

### 6. **src/lib/rateLimit.js** - Rate Limiting Middleware

**Responsibilities:**
- Prevent brute force attacks on authentication endpoints
- Track requests per IP address
- Enforce rate limit windows

**Configuration:**
- Window: 15 minutes
- Max requests: 10 per window
- Scope: Per IP address

**Function:**
- `createRateLimiter(options)` - Returns rate limiting function
  - Tracks requests in memory (note: doesn't persist across worker instances)
  - Suitable for production with load balancing

**Limitations & Future Improvements:**
- In-memory storage (consider: Redis, KV Store for persistence)
- Per-worker instance (consider: Durable Objects for global state)

### 7. **migrations/0001_initial.sql** - Database Schema

**Tables:**

#### users
- Primary storage for user accounts
- Fields: id, email, password_hash, password_salt, role, created_at, name, requires_change_password, temp_password_expiration
- Indexes: UNIQUE on email

#### tenants
- Rental tenant records with financial data
- Fields: id, user_id, balance, deposit, rent_amount, billing_cycle, leased_unit, onboard_date, created_at
- Foreign key: user_id → users.id

#### refresh_tokens
- Store valid refresh tokens for token refresh mechanism
- Fields: id, user_id, token, expires_at, created_at
- Foreign key: user_id → users.id

#### password_resets
- Track password reset tokens
- Fields: id, user_id, token, expires_at, used, created_at
- Foreign key: user_id → users.id

#### signup_keys
- Invitation codes for user registration
- Fields: id, code (UNIQUE), used, user_id
- Prevents open registration

---

## Data Flow Diagrams

### Authentication Flow: Login
```
Client          Worker          Database
  │                │                │
  ├─ POST /login──→│                │
  │              (validate)          │
  │                │─ Query user────→│
  │                │←─ User data ────│
  │            (verify password)     │
  │            (create JWT)          │
  │            (save refresh token)  │
  │←─ Tokens ─────│─ Save token ────→│
  │                │                │
```

### Tenant Creation Flow
```
Client          Worker          Database
  │                │                │
  ├─ POST /tenants→│                │
  │            (verify JWT)          │
  │            (check admin role)    │
  │            (validate payload)    │
  │                │─ Create tenant─→│
  │                │←─ Tenant ID ────│
  │←─ Created ─────│                │
  │                │                │
```

---

## Request Lifecycle

1. **Request arrives at Cloudflare Edge**
   - Route to appropriate Worker

2. **src/worker.js processes request**
   - Check CORS preflight
   - Apply rate limiting if needed
   - Route to handler (auth or tenant)

3. **Handler (auth.js or tenant.js) processes**
   - Authenticate request (if required)
   - Validate input using validation.js
   - Execute database operation with error handling
   - Return JSON response

4. **Database operations**
   - Use parameterized queries
   - D1 handles SQLite execution
   - Return results to handler

5. **Response sent back**
   - Add CORS headers
   - Return JSON with appropriate status code

---

## Dependency Graph

```
worker.js
├── auth.js
│   ├── crypto.js
│   ├── validation.js
│   └── jose (external)
├── tenant.js
│   ├── crypto.js
│   └── validation.js
├── rateLimit.js
└── CORS/error handling

Database (D1)
└── All database operations from auth.js & tenant.js
```

---

## Security Architecture

### Authentication
- JWT-based with access + refresh token pattern
- PBKDF2-SHA256 password hashing (100k iterations)
- Legacy password migration support
- Token expiration enforcement

### Authorization
- Role-based access control (admin, tenant, user)
- Tenant data isolation (users see only their records)
- Admin-only endpoints clearly marked

### Input Validation
- Strict type checking
- Whitelist validation
- SQL injection prevention (parameterized queries)
- Length limits on string fields

### Rate Limiting
- Per-IP rate limiting on auth endpoints
- Prevents brute force attacks
- 10 requests per 15 minutes

### CORS
- Whitelist-based origin validation
- Only specified origins can access API
- Configurable in src/worker.js

---

## Performance Considerations

### Edge Computing
- Cloudflare Workers run on edge network
- Reduced latency for global users
- Distributed execution

### Database
- D1 SQLite provides quick local queries
- Suitable for small-to-medium datasets
- Vertical scaling options available

### Caching Opportunities
- JWT validation results (short TTL)
- User role/permissions (session-based)
- Rate limiter state (in-memory)

---

## Scalability Notes

### Current Limitations
- In-memory rate limiting (not shared across workers)
- Single D1 database instance
- No persistent session store

### Future Improvements
- Use Cloudflare KV Store for distributed rate limiting
- Use Durable Objects for global state management
- Implement caching strategy for frequently accessed data
- Consider database replication for high availability
