# Deployment Guide

Complete guide for deploying Rental Management API to production on Cloudflare Workers.

## Prerequisites

Before deploying, ensure you have:

- ✓ Cloudflare account with Workers and D1 enabled
- ✓ Wrangler CLI installed (`npm install -g wrangler`)
- ✓ Git repository set up
- ✓ All tests passing locally
- ✓ Environment variables configured

## Deployment Checklist

### Pre-Deployment Tasks

- [ ] All tests passing (`npm test`)
- [ ] Build successful (`npm run build`)
- [ ] No console errors or warnings
- [ ] Security review completed
- [ ] Database migrations tested
- [ ] Environment variables verified
- [ ] Dependencies up to date
- [ ] Code reviewed and merged to main

### Configuration Tasks

- [ ] Cloudflare Secrets configured
- [ ] D1 database created
- [ ] Database bindings configured
- [ ] Environment variables set
- [ ] CORS origins updated
- [ ] Rate limiting reviewed
- [ ] Monitoring configured
- [ ] Backups configured

### Testing Tasks

- [ ] Integration tests passing
- [ ] API endpoints tested
- [ ] Authentication flows tested
- [ ] Error handling verified
- [ ] Performance acceptable
- [ ] Database queries optimized

---

## Step 1: Local Preparation

### 1.1 Install Wrangler CLI

```bash
npm install -g wrangler
```

Verify installation:
```bash
wrangler --version
```

### 1.2 Authenticate with Cloudflare

```bash
wrangler login
```

This opens a browser to authenticate and save your credentials.

### 1.3 Verify Local Build

```bash
npm run build
```

Should create `dist/worker.js` (71 KB or similar).

### 1.4 Test Locally

```bash
npm run dev
```

Test endpoints with curl or Postman:
```bash
curl -X POST http://localhost:8787/api/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "Test123!"}'
```

---

## Step 2: Cloudflare Setup

### 2.1 Create/Configure D1 Database

**Option A: Create new database**
```bash
wrangler d1 create rental-db
```

**Option B: Use existing database**

Copy the database_id from your Cloudflare dashboard.

### 2.2 Update wrangler.jsonc

Add database configuration:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_id": "your-database-id-here",
      "database_name": "rental-db"
    }
  ]
}
```

### 2.3 Configure Secrets

Add JWT secret to Cloudflare:

```bash
wrangler secret put JWT_SCRT
```

Enter your JWT secret (should be a long random string):
```
your-random-secret-key-minimum-32-characters
```

Verify secret was stored:
```bash
wrangler secret list
```

### 2.4 Test Database Connection

```bash
wrangler d1 execute rental-db --remote -- "SELECT 1"
```

Should return successfully.

---

## Step 3: Database Migrations

### 3.1 Apply Migrations Locally

```bash
npm run dev
```

This applies migrations from `migrations/` folder to local D1.

### 3.2 Apply Migrations to Production

**Option A: Automatic with first deploy**

If database is empty, migrations auto-apply.

**Option B: Manual application**

```bash
wrangler d1 execute rental-db --remote -- "
CREATE TABLE IF NOT EXISTS users (...)
CREATE TABLE IF NOT EXISTS tenants (...)
..."
```

Or use the migration file:
```bash
wrangler d1 execute rental-db --remote < migrations/0001_initial.sql
```

### 3.3 Verify Schema

```bash
wrangler d1 execute rental-db --remote -- ".schema"
```

Should show all tables:
- users
- tenants
- refresh_tokens
- password_resets
- signup_keys

---

## Step 4: Environment Configuration

### 4.1 Update CORS Origins

Edit `src/worker.js` and update `ALLOWED_ORIGINS`:

```javascript
const ALLOWED_ORIGINS = [
  'https://your-frontend-domain.com',
  'https://app.your-domain.com',
  'https://admin.your-domain.com'
];
```

### 4.2 Review Rate Limiting

Default settings (src/worker.js):
```javascript
const authRateLimiter = createRateLimiter({ 
  windowMs: 15 * 60 * 1000,  // 15 minutes
  maxRequests: 10              // 10 requests
});
```

Adjust if needed for your use case.

### 4.3 Configure Logging

Ensure observability is enabled in `wrangler.jsonc`:

```jsonc
{
  "observability": {
    "enabled": true,
    "logs": {
      "enabled": true
    }
  }
}
```

### 4.4 Set Environment for Production

Add build-time variables if needed:

```jsonc
{
  "env": {
    "production": {
      "vars": {
        "ENVIRONMENT": "production",
        "API_BASE_URL": "https://api.your-domain.com"
      }
    }
  }
}
```

---

## Step 5: Pre-Deployment Testing

### 5.1 Final Local Build

```bash
npm run build
```

Verify no errors.

### 5.2 Run Full Test Suite

```bash
npm test
```

All tests must pass.

### 5.3 Code Quality Check

```bash
# Check for unused imports
npm run build 2>&1 | grep -i warning

# Verify no console.log in production code
grep -r "console.log" src/ || echo "✓ No console.log found"
```

### 5.4 Security Review

- [ ] No hardcoded secrets
- [ ] All inputs validated
- [ ] All queries parameterized
- [ ] Error handling in place
- [ ] CORS configured correctly
- [ ] Rate limiting enabled
- [ ] HTTPS only (wrangler handles this)

---

## Step 6: Deploy to Production

### 6.1 Automatic Deployment (Recommended)

Using Wrangler:

```bash
npm run deploy
```

Or:
```bash
wrangler deploy src/worker.js
```

**Output should show:**
```
✓ Successfully published your Worker
  https://rental-management.YOUR_ACCOUNT.workers.dev
```

### 6.2 Manual Deployment

If needed:

```bash
wrangler publish --env production
```

### 6.3 Route to Custom Domain

In Cloudflare dashboard:

1. Go to Workers & Pages → Rental Management
2. Click "Settings" tab
3. Go to "Domains & Routes"
4. Add custom domain: `api.your-domain.com`
5. Route: `api.your-domain.com/*`

---

## Step 7: Post-Deployment Verification

### 7.1 Health Check

Test deployed API:

```bash
curl https://api.your-domain.com/health

# Or test auth endpoint
curl -X POST https://api.your-domain.com/api/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "Test123!"}'
```

### 7.2 Verify Database Connection

```bash
wrangler d1 execute rental-db --remote -- "SELECT COUNT(*) FROM users"
```

### 7.3 Check Logs

View worker logs:

```bash
wrangler tail
```

Or in Cloudflare dashboard:
- Workers → Rental Management → Logs

### 7.4 Test Key Endpoints

**Signup:**
```bash
curl -X POST https://api.your-domain.com/api/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "password": "SecurePass123!",
    "code": "INVITE123ABC",
    "role": "tenant"
  }'
```

**Login:**
```bash
curl -X POST https://api.your-domain.com/api/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin.demo@example.test",
    "password": "DemoPass123!"
  }'
```

**Protected Endpoint:**
```bash
curl https://api.your-domain.com/api/tenants \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### 7.5 Monitor Metrics

In Cloudflare dashboard:
- Check request rates
- Monitor error rates
- Review CPU usage
- Check database queries

---

## Step 8: Post-Deployment Configuration

### 8.1 Set Up Monitoring & Alerts

Configure alerts for:
- High error rate (>1%)
- High latency (>500ms)
- Database connection failures
- Rate limit triggers

### 8.2 Enable Analytics

In Cloudflare dashboard:
- Enable Workers Analytics
- Set up custom event logging
- Configure dashboards for key metrics

### 8.3 Configure Backups

**Database backups:**
```bash
# Schedule daily export
0 2 * * * wrangler d1 export rental-db > backup-$(date +\%Y\%m\%d).sql
```

Store backups securely (S3, Google Cloud Storage, etc.)

### 8.4 Set Up Logging

Log important events:
- Successful logins
- Failed login attempts
- Account creation
- Permission denials
- Database errors

Example:
```javascript
console.error('[AUTH]', 'Failed login for:', email, 'Reason:', reason);
console.info('[TENANT]', 'Created tenant', tenantId, 'for user', userId);
```

---

## Rollback Procedures

### Quick Rollback (Last Version)

If critical issue found:

```bash
wrangler rollback
```

### Manual Rollback

Deploy previous version:

```bash
git checkout <previous-commit>
npm run build
npm run deploy
```

### Database Rollback

If migrations caused issues:

1. Restore from backup
2. Apply only necessary migrations
3. Test thoroughly
4. Re-deploy worker

---

## Updating & Maintenance

### Regular Updates

**Weekly:**
- Review logs for errors
- Monitor performance metrics
- Check for security updates

**Monthly:**
- Update dependencies
- Review rate limiting effectiveness
- Audit access patterns
- Backup database

**Quarterly:**
- Security audit
- Performance optimization
- Capacity planning
- Disaster recovery test

### Dependency Updates

```bash
# Check for updates
npm outdated

# Update all dependencies
npm update

# Update specific package
npm install jose@latest

# Run tests after update
npm test

# Deploy if tests pass
npm run deploy
```

### Zero-Downtime Deployment

Cloudflare Workers handles zero-downtime:
1. Deploy new version
2. Workers automatically switch traffic
3. Old instances wind down gracefully
4. No service interruption

---

## Troubleshooting

### Issue: "Database not found"

**Solution:**
```bash
# Verify database exists
wrangler d1 list

# Check database_id in wrangler.jsonc
wrangler d1 info rental-db
```

### Issue: "JWT_SCRT not found"

**Solution:**
```bash
# Add secret
wrangler secret put JWT_SCRT

# Verify secret exists
wrangler secret list

# Re-deploy
npm run deploy
```

### Issue: "CORS error from frontend"

**Solution:**
1. Check frontend origin in browser console
2. Add origin to ALLOWED_ORIGINS in src/worker.js
3. Rebuild and deploy
4. Clear browser cache

### Issue: "Migrations not applying"

**Solution:**
```bash
# Manual migration application
wrangler d1 execute rental-db --remote < migrations/0001_initial.sql

# Verify tables
wrangler d1 execute rental-db --remote -- ".schema"
```

### Issue: "High error rates after deploy"

**Solution:**
1. Check logs: `wrangler tail`
2. Identify error pattern
3. Rollback: `wrangler rollback`
4. Fix issue locally
5. Verify with `npm test`
6. Re-deploy

---

## Performance Optimization

### Database Query Optimization

Add indexes for frequently queried fields:

```sql
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_tenants_user_id ON tenants(user_id);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
```

### Caching Strategy

Implement caching for:
- User roles/permissions
- User profile data
- Public settings

Use Cloudflare Cache API:

```javascript
const cache = caches.default;
const response = await cache.match(request);
if (!response) {
  // Fetch and cache
  const newResponse = await fetch(...);
  cache.put(request, newResponse.clone());
  return newResponse;
}
return response;
```

### Connection Pooling

D1 handles connection pooling automatically. For custom connections:

```javascript
// D1 auto-manages connections
const result = await env.DB.prepare(query).bind(...args).first();
```

---

## Security Hardening

### HTTPS & TLS

Cloudflare handles TLS automatically.

### Security Headers

Add to worker response:

```javascript
response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
response.headers.set('X-Content-Type-Options', 'nosniff');
response.headers.set('X-Frame-Options', 'DENY');
```

### Rate Limiting Advanced

Consider upgrading to Durable Objects for global rate limiting:

```javascript
// Use Durable Objects for distributed rate limiting
const stub = env.RATE_LIMITER.get(...);
```

### WAF Rules

In Cloudflare dashboard → Security → WAF:
1. Enable OWASP ruleset
2. Configure rate limiting rules
3. Set up IP allowlist/blocklist
4. Enable bot management

---

## Disaster Recovery

### Backup Strategy

Daily encrypted backups to secure storage:

```bash
#!/bin/bash
DATE=$(date +%Y%m%d)
wrangler d1 export rental-db | gzip > backup-$DATE.sql.gz
# Upload to S3, Google Cloud, etc.
```

### Recovery Procedure

1. Stop worker if necessary
2. Restore database from backup
3. Apply any missing migrations
4. Verify data integrity
5. Resume worker
6. Test all endpoints
7. Monitor for issues

### Testing Recovery

Quarterly:
1. Create test database
2. Restore from backup
3. Run full test suite
4. Verify all data present
5. Document issues found

---

## Summary

**Deployment Checklist:**
1. ✓ Tests passing
2. ✓ Build successful  
3. ✓ Secrets configured
4. ✓ Database created
5. ✓ Migrations applied
6. ✓ CORS configured
7. ✓ Deploy: `npm run deploy`
8. ✓ Verify endpoints
9. ✓ Monitor logs
10. ✓ Set up backups

After deployment, visit your API at: `https://api.your-domain.com`

For support, check logs: `wrangler tail`
