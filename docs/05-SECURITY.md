# Security Guide

Comprehensive security practices and guidelines for the Rental Management API.

## Table of Contents

1. [Authentication & Authorization](#authentication--authorization)
2. [Password Security](#password-security)
3. [Token Management](#token-management)
4. [Input Validation](#input-validation)
5. [Database Security](#database-security)
6. [API Security](#api-security)
7. [Deployment Security](#deployment-security)
8. [Incident Response](#incident-response)
9. [Security Checklist](#security-checklist)

---

## Authentication & Authorization

### Role-Based Access Control (RBAC)

The API implements three user roles with different permission levels:

#### 1. **Admin Role**
- Full system access
- Can create, read, update, delete any tenant
- Can manage user accounts
- Can access all API endpoints

#### 2. **Tenant Role**
- Limited to own tenant records
- Can view own profile
- Can update own password
- Cannot access other tenant records
- Cannot create or delete tenant records

#### 3. **User Role**
- Similar restrictions as Tenant
- Intended for support/staff accounts
- Can be extended for additional features

### Authorization Implementation

```javascript
// In auth.js
const authUser = await getAuthUser(request, env);
if (!authUser || authUser.role !== 'admin') {
  return json({ error: 'Unauthorized' }, 401);
}
```

**Key Points:**
- Every protected endpoint requires JWT verification
- Role checking happens after authentication
- Implement principle of least privilege
- Always check authorization before database access

### JWT Token Structure

Access tokens contain:
```json
{
  "id": 1,
  "email": "user@example.com",
  "role": "tenant"
}
```

- **Issued by**: Login endpoint
- **Expires in**: 1 hour (configurable)
- **Signed with**: JWT_SCRT from Cloudflare Secrets
- **Validation**: Done via jose library

---

## Password Security

### Password Hashing: PBKDF2-SHA256

**Algorithm Details:**
```
PBKDF2-SHA256(password, salt, iterations=100000)
Output: 256-bit (32 bytes) hash
```

**Why PBKDF2?**
- NIST approved algorithm
- Computationally expensive (100k iterations prevent brute force)
- Well-tested and widely supported
- Better than MD5 or SHA1

**Implementation (src/lib/crypto.js):**

```javascript
async function hashPBKDF2(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  // Returns {hash: hexString, salt: hexString}
}
```

### Password Strength Requirements

Users must provide passwords meeting these criteria:

✓ Minimum 8 characters
✓ At least one uppercase letter (A-Z)
✓ At least one lowercase letter (a-z)
✓ At least one digit (0-9)
✓ At least one special character (!@#$%^&*)

**Validation Code:**
```javascript
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,}$/;
if (!passwordRegex.test(password)) {
  throw new Error('Password does not meet strength requirements');
}
```

### Password Reset Security

**Token Generation:**
- JWT-based reset tokens
- 1-hour expiration time
- One-time use only (marked as `used` in database)
- Tokens never sent in URLs (only in request body)

**Best Practices:**
- Send reset links via email in production
- Include additional security questions if possible
- Log password reset requests
- Invalidate old reset tokens on new request

**Example Reset Flow:**
1. User requests reset → `/api/request_reset`
2. Token generated and stored
3. Token sent to user (via email in production)
4. User submits token + new password → `/api/reset_password`
5. Validate token, hash new password, mark token as used
6. Invalidate all existing refresh tokens for security

### Temporary Passwords

When admins create users, temporary passwords are generated:

```javascript
function generateTempPassword(length = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}
```

**Security Features:**
- Uses cryptographically secure random values
- Mixed character set (uppercase, lowercase, digits, symbols)
- 10 characters default (configurable)
- User must change on first login (`requires_change_password` flag)

---

## Token Management

### Access Token (JWT)

**Characteristics:**
- Short-lived (1 hour)
- Contains user info in claims
- Signed with JWT_SCRT
- Used for API authentication

**Usage:**
```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Validation:**
```javascript
const verified = await jwtVerify(token, secret);
// Returns payload: {id, email, role}
```

### Refresh Token

**Characteristics:**
- Long-lived (30 days, configurable)
- Stored in database
- Used to issue new access tokens
- Rotatable for security

**Refresh Flow:**
1. Client sends refresh_token → `/api/refresh_token`
2. Server validates token exists and not expired
3. Server generates new access_token
4. Optional: invalidate old refresh_token, issue new one (token rotation)

**Refresh Token Rotation (Recommended):**
```javascript
// Issue new refresh token with each refresh
// Mark old token as invalidated
// Limits token reuse if compromised
```

### Token Storage

**Server-Side (Production):**
- Store refresh tokens in database with:
  - User association
  - Expiration timestamp
  - Creation timestamp
  - Optional: issuer info, IP address

**Client-Side:**
- Access token: Store in memory or secure HttpOnly cookie
- Refresh token: Store in HttpOnly, Secure cookie
- Never store tokens in localStorage (XSS vulnerability)

### Token Expiration

**Configuration:**
- Access token: 1 hour (configurable in jose)
- Refresh token: 30 days (set in database)
- Password reset token: 1 hour

**Implementation:**
```javascript
// Issue token with expiration
await new SignJWT(payload)
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(secret);

// Validate expiration
const verified = await jwtVerify(token, secret);
// Throws error if expired
```

---

## Input Validation

### Validation Strategy

**Three layers of defense:**
1. **Type checking** - Ensure correct data types
2. **Format validation** - Email, password, numbers
3. **Injection prevention** - SQL injection, XSS

### Email Validation

```javascript
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
  throw new Error('Invalid email format');
}
```

**Additional checks:**
- Maximum length: 255 characters
- Must be unique in database
- Lowercase normalization recommended

### Numeric Validation

**Critical for financial data:**

```javascript
function validateNumber(value, fieldName, allowNegative = false) {
  const num = Number(value);
  
  // Check for NaN
  if (isNaN(num)) {
    throw new Error(`${fieldName} must be a valid number`);
  }
  
  // Check for negative
  if (!allowNegative && num < 0) {
    throw new Error(`${fieldName} cannot be negative`);
  }
  
  // Check for reasonable bounds
  if (num > 999999999) {
    throw new Error(`${fieldName} exceeds maximum value`);
  }
  
  return num;
}
```

**Why this is important:**
- Prevents NaN from being stored in database
- Protects financial calculations
- Ensures data integrity

### ID Validation

```javascript
function validateId(value) {
  const id = parseInt(value);
  
  // Must be positive integer
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid ID format');
  }
  
  return id;
}
```

**Prevents:**
- SQL injection via id parameter
- Invalid database queries
- XSS through URL manipulation

### String Sanitization

```javascript
function sanitizeString(value, fieldName, maxLength = 255) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be string`);
  }
  
  const trimmed = value.trim();
  
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} cannot be empty`);
  }
  
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} exceeds ${maxLength} characters`);
  }
  
  return trimmed;
}
```

### Validation in Practice

**Tenant Creation:**
```javascript
validateTenantPayload({
  user_id: validateId(payload.user_id),
  balance: validateNumber(payload.balance, 'balance'),
  deposit: validateNumber(payload.deposit, 'deposit'),
  rent_amount: validateNumber(payload.rent_amount, 'rent_amount'),
  leased_unit: sanitizeString(payload.leased_unit, 'leased_unit'),
  onboard_date: validateDateFormat(payload.onboard_date)
});
```

---

## Database Security

### Parameterized Queries

**Always use prepared statements:**

```javascript
// ✓ SAFE - Parameterized query
const stmt = env.DB.prepare('SELECT * FROM users WHERE email = ?');
const user = stmt.bind(email).first();

// ✗ DANGEROUS - String concatenation
const user = env.DB.prepare(`SELECT * FROM users WHERE email = '${email}'`).first();
```

**Why parameterized queries matter:**
- SQL injection prevention
- Parameters properly escaped
- Type-safe binding

### Error Handling

**Never expose database errors to clients:**

```javascript
// ✗ DANGEROUS - Leaks database structure
if (error) {
  return json({ error: error.message }, 500);
}

// ✓ SAFE - Generic error message
if (error) {
  console.error('Database error:', error);
  return json({ error: 'Internal server error' }, 500);
}
```

**Best Practice:**
- Log full errors server-side
- Return generic messages to clients
- Use error codes if additional info needed

### Database Credentials

**Secure Storage:**

✓ Cloudflare Secrets Manager:
- Stored encrypted at rest
- Never transmitted to client
- Rotatable without code changes

✓ Environment variables:
- Set in wrangler.jsonc
- Loaded at runtime
- Never committed to git

```bash
# Add secret to Cloudflare
wrangler secret put JWT_SCRT

# In code - access securely
const secret = env.JWT_SCRT;
```

**What NOT to do:**
- ✗ Hardcode credentials
- ✗ Store in comments
- ✗ Commit to git
- ✗ Log sensitive values

---

## API Security

### CORS (Cross-Origin Resource Sharing)

**Whitelist Approach:**

```javascript
const ALLOWED_ORIGINS = [
  'https://test-front-env.pages.dev',
  'https://my-other-site.pages.dev',
  'https://rental-management.ehexibit.com'
];

function getAllowOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  return '*'; // or null for stricter policy
}
```

**Security Points:**
- Use whitelist, not blacklist
- Include protocol and domain
- Update list when adding frontends
- Consider restricting to HTTPS only

### Rate Limiting

**Current Implementation:**
- Limit: 10 requests per 15 minutes
- Scope: Per IP address
- Applies to: Auth endpoints

**Endpoints protected:**
- /api/signup
- /api/login
- /api/update_password
- /api/request_reset
- /api/reset_password

**Limitations:**
- In-memory storage (not persistent)
- Per-worker instance (not global)

**Future Improvements:**
- Use Cloudflare KV Store for global state
- Use Durable Objects for rate limit coordination
- Implement per-user rate limits

### HTTPS Enforcement

**In production:**
- All traffic must be HTTPS
- Set HSTS header (HTTP Strict-Transport-Security)
- Redirect HTTP to HTTPS

```javascript
response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
```

### Headers Security

**Recommended security headers:**

```javascript
// Content Security Policy
response.headers.set('Content-Security-Policy', "default-src 'self'");

// Prevent MIME sniffing
response.headers.set('X-Content-Type-Options', 'nosniff');

// Prevent clickjacking
response.headers.set('X-Frame-Options', 'DENY');

// XSS Protection
response.headers.set('X-XSS-Protection', '1; mode=block');

// Referrer Policy
response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
```

---

## Deployment Security

### Environment Configuration

**Use Cloudflare Secrets for:**
- JWT_SCRT (JWT signing key)
- Database credentials
- API keys for external services

**Never include in code:**
- Credentials
- API keys
- Sensitive configuration

### Deployment Checklist

- [ ] All dependencies up to date
- [ ] No hardcoded secrets in code
- [ ] Secrets configured in Cloudflare
- [ ] CORS origins restricted
- [ ] HTTPS enforced
- [ ] Security headers set
- [ ] Rate limiting enabled
- [ ] Error logging configured
- [ ] Database backups configured
- [ ] Access logs enabled

### Monitoring

**What to monitor:**
- Failed login attempts (rate limit triggers)
- Failed password resets
- Unauthorized access attempts
- Database errors
- Performance degradation

**Set up alerts for:**
- Multiple failed auth attempts
- Unusual traffic patterns
- Database connection failures
- High error rates

---

## Incident Response

### Password Compromise

**Immediate Actions:**
1. Force password reset for affected user
2. Invalidate all refresh tokens
3. Invalidate all active sessions
4. Log incident
5. Notify user

**Implementation:**
```javascript
// Mark user for forced password change
UPDATE users SET requires_change_password = 1 WHERE id = ?;

// Invalidate all tokens
DELETE FROM refresh_tokens WHERE user_id = ?;
```

### Token Leakage

**Immediate Actions:**
1. Rotate JWT_SCRT
2. Invalidate all tokens in database
3. Force re-login for all users
4. Review access logs
5. Check for unauthorized access

**Implementation:**
```javascript
// Invalidate all tokens
DELETE FROM refresh_tokens;

// Update secret
wrangler secret put JWT_SCRT
```

### Unauthorized Access

**Investigation Steps:**
1. Check access logs for suspicious activity
2. Identify affected users/data
3. Review authorization code
4. Check for code vulnerabilities
5. Implement additional validation

**Containment:**
1. Temporarily restrict access if needed
2. Force password reset for affected users
3. Reset refresh tokens
4. Monitor for further incidents

---

## Security Checklist

### Development

- [ ] Input validation on all endpoints
- [ ] Parameterized queries everywhere
- [ ] Error handling without leaking info
- [ ] No hardcoded secrets
- [ ] Rate limiting implemented
- [ ] CORS properly configured
- [ ] Authentication required on protected endpoints
- [ ] Authorization checks in place
- [ ] SQL injection prevention
- [ ] XSS prevention

### Testing

- [ ] Password strength validation tested
- [ ] Invalid input rejected
- [ ] Unauthorized access prevented
- [ ] Token expiration enforced
- [ ] Rate limiting working
- [ ] Database errors handled
- [ ] CORS headers correct
- [ ] SSL/TLS working

### Deployment

- [ ] Secrets configured in Cloudflare
- [ ] HTTPS enforced
- [ ] Security headers set
- [ ] Logging configured
- [ ] Monitoring set up
- [ ] Backups configured
- [ ] Access controls in place
- [ ] Fire wall rules configured
- [ ] DDoS protection enabled
- [ ] Regular updates scheduled

### Operations

- [ ] Regular security audits
- [ ] Dependency updates scheduled
- [ ] Security patches applied
- [ ] Access logs reviewed
- [ ] Incidents documented
- [ ] Disaster recovery tested
- [ ] Compliance verified
- [ ] Third-party assessments done

---

## Resources

### External Security References

- OWASP Top 10: https://owasp.org/www-project-top-ten/
- NIST Password Guidelines: https://pages.nist.gov/800-63-3/
- PBKDF2 Standard: https://tools.ietf.org/html/rfc2898
- JWT Best Practices: https://tools.ietf.org/html/rfc7519

### Libraries Used

- **jose** (v6.1.3): JWT handling
- **Web Crypto API**: Native cryptographic operations
- **Cloudflare Workers**: Secure execution environment

---

## Contact & Reporting

For security issues:
- Do not open public issues
- Email: security@example.com
- Provide detailed description
- Include steps to reproduce
- Allow time for patch before disclosure


## Cloudflare Secrets Store binding handling

Bindings declared in `secrets_store_secrets` are objects and their values must be read with `await binding.get()`. ReMan now resolves `JWT_SCRT`, `EMAIL_SERVICE_KEY`, and `RESEND_FROM_EMAIL` through a shared helper that also supports local string values from `.dev.vars`. Use a unique random JWT secret of at least 32 characters. Never place production secret values in source control or frontend assets.
