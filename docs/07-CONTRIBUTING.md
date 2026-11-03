# Contributing Guide

Guidelines for contributing to the Rental Management API project.

## Code of Conduct

- Be respectful and professional
- Provide constructive feedback
- Welcome diverse perspectives
- Focus on code quality and user experience

## Getting Started

### 1. Fork & Clone

```bash
git clone https://github.com/your-username/rental-management-api.git
cd rental-management-api
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Create Feature Branch

```bash
git checkout -b feature/your-feature-name
```

Use descriptive branch names:
- `feature/add-email-validation`
- `fix/tenant-update-bug`
- `docs/api-endpoints`
- `refactor/crypto-module`

### 4. Set Up Development Environment

```bash
npm run dev
```

Test your changes locally before committing.

---

## Where Code Belongs

- Worker routing and request-level middleware: `src/worker.js`
- Authentication and session lifecycle: `src/auth.js`
- Account provisioning and account administration: `src/modules/accounts.js`
- Tenant profile and rental records: `src/modules/tenants.js`
- Property handlers: `src/modules/properties.js`
- Device handlers and pairing: `src/modules/devices.js`
- Property/device access management: `src/modules/access.js`
- Shared access and property-name compatibility: `src/modules/access-control.js` and `src/modules/property-compat.js`
- Durable Object/WebSocket behavior: `src/houseRoom.js`, `src/deviceRoom.js`, and `src/lib/websocketTicket.js`
- Browser frontend reference: `public/public/`
- Cloudflare deployment assets: `dist/`

Read [Project Architecture](./ARCHITECTURE.md) before adding a new domain or changing legacy house/property compatibility. Keep existing import facades and API behavior intact unless a change explicitly includes migration and compatibility coverage.

## Development Workflow

## Development Workflow

### 1. Make Changes

Edit files in `src/`, `migrations/`, or `docs/`

### 2. Run Tests

```bash
npm test
```

All tests must pass before committing.

### 3. Build & Verify

```bash
npm run build
```

Verify build completes with no errors.

### 4. Commit Changes

Follow commit message convention:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Code style (no logic change)
- `refactor`: Code refactoring
- `test`: Test addition/modification
- `chore`: Build process, dependencies

**Examples:**
```
feat(auth): add password reset functionality

Implement password reset flow with email verification
- Add /api/request_reset endpoint
- Add /api/reset_password endpoint
- Add password_resets table to schema
- Add tests for reset flow

Closes #123
```

```
fix(tenant): validate numeric fields on update

Prevent NaN values from being stored in database
by adding strict numeric validation

Fixes #456
```

### 5. Push Changes

```bash
git push origin feature/your-feature-name
```

### 6. Create Pull Request

On GitHub:
1. Click "New Pull Request"
2. Select your branch
3. Fill in PR template
4. Describe changes and testing

**PR Template:**

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Changes Made
- Item 1
- Item 2
- Item 3

## Testing
- [ ] Tests added/updated
- [ ] All tests passing
- [ ] Tested locally

## Breaking Changes
None / Description if applicable

## Related Issues
Closes #123
```

---

## Code Style Guidelines

### JavaScript Standards

**File Structure:**
```javascript
// 1. Imports at top
import { function } from './module.js';

// 2. Constants
const CONSTANT_VALUE = 'value';

// 3. Functions (exported)
export async function myFunction(params) {
  // Implementation
}

// 4. Helper functions (not exported)
function helperFunction() {
  // Implementation
}
```

**Naming Conventions:**
- Constants: `UPPER_SNAKE_CASE`
- Functions: `camelCase`
- Classes: `PascalCase`
- Private functions: prefix with `_`

```javascript
const MAX_RETRIES = 3;
const API_TIMEOUT = 5000;

function handleRequest(request) {}
function validateEmail(email) {}

class UserService {}
class _InternalHelper {} // Private
```

**Formatting:**
- Use 2-space indentation
- Use semicolons
- Use single quotes for strings
- Use template literals for multi-line strings

```javascript
// ✓ Good
const message = 'User created successfully';
const query = `
  SELECT * FROM users
  WHERE email = ?
`;

// ✗ Bad
const message = "User created successfully"
const query = "SELECT * FROM users WHERE email = ?"
```

### Comments & Documentation

**Function Comments:**
```javascript
/**
 * Hash password using PBKDF2-SHA256
 * @param {string} password - The password to hash
 * @returns {Promise<Object>} Object with hash and salt as hex strings
 * @throws {Error} If password hashing fails
 */
export async function hashPBKDF2(password) {
  // Implementation
}
```

**Inline Comments:**
```javascript
// ✓ Explain WHY, not WHAT
// Iterate in reverse to avoid index shifting during deletion
for (let i = items.length - 1; i >= 0; i--) {
  if (items[i].shouldDelete) items.splice(i, 1);
}

// ✗ Obvious comments are noise
// Loop through items
for (let i = 0; i < items.length; i++) {
  // Do something
}
```

### Error Handling

**Always use try-catch for async operations:**

```javascript
// ✓ Good
try {
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(email)
    .first();
  if (!user) {
    return json({ error: 'User not found' }, 404);
  }
  return json(user);
} catch (error) {
  console.error('Database error:', error);
  return json({ error: 'Internal server error' }, 500);
}

// ✗ Bad - no error handling
const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
  .bind(email)
  .first();
return json(user);
```

**Return appropriate HTTP status codes:**

```javascript
// 400 Bad Request - client error
return json({ error: 'Invalid input' }, 400);

// 401 Unauthorized - authentication required
return json({ error: 'Authentication required' }, 401);

// 403 Forbidden - insufficient permissions
return json({ error: 'Insufficient permissions' }, 403);

// 404 Not Found - resource doesn't exist
return json({ error: 'Resource not found' }, 404);

// 409 Conflict - duplicate resource
return json({ error: 'Email already exists' }, 409);

// 429 Too Many Requests - rate limited
return json({ error: 'Too many requests' }, 429);

// 500 Internal Server Error - server error
return json({ error: 'Internal server error' }, 500);
```

---

## Testing Guidelines

### Test Structure

```javascript
// tests/validation.test.js
import test from 'node:test';
import assert from 'node:assert';
import { validateEmail } from '../src/lib/validation.js';

test('validateEmail should accept valid emails', () => {
  assert.doesNotThrow(() => {
    validateEmail('user@example.com');
  });
});

test('validateEmail should reject invalid emails', () => {
  assert.throws(() => {
    validateEmail('invalid-email');
  });
});
```

### What to Test

**Unit Tests:**
- Input validation functions
- Crypto functions
- Utility functions
- Error handling

**Integration Tests:**
- API endpoints
- Database operations
- Authentication flow
- Authorization checks

**Example Integration Test:**
```javascript
test('tenant can fetch their own profile', async () => {
  // Setup
  const tenantId = 1;
  const token = 'valid-jwt-token';
  
  // Execute
  const response = await fetch(`/api/tenants/${tenantId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  // Assert
  assert.strictEqual(response.status, 200);
  const data = await response.json();
  assert.strictEqual(data.id, tenantId);
});
```

### Running Tests

```bash
npm test
```

All tests must pass before submitting PR.

---

## Pull Request Review Process

### Self-Review

Before requesting review:

- [ ] Code follows style guidelines
- [ ] All tests pass
- [ ] Build successful
- [ ] No console errors
- [ ] Comments added where needed
- [ ] README updated if needed
- [ ] Documentation updated
- [ ] No hardcoded secrets
- [ ] No debug code left
- [ ] Performance acceptable

### Reviewer Responsibilities

Reviewers check for:

- **Correctness**: Does it work as intended?
- **Design**: Is it the best approach?
- **Testing**: Are tests adequate?
- **Security**: Any vulnerabilities?
- **Performance**: Any issues?
- **Style**: Follows guidelines?
- **Documentation**: Clear and complete?

### Approval & Merge

Requirements to merge:

- ✓ At least 1 approval
- ✓ All tests passing
- ✓ No merge conflicts
- ✓ CI checks passed
- ✓ All conversations resolved

---

## Release Process

### Version Numbering

Use Semantic Versioning: `MAJOR.MINOR.PATCH`

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes

Examples:
- `1.0.0` - Initial release
- `1.1.0` - New password reset feature
- `1.1.1` - Bug fix in validation

### Release Steps

1. **Update version** in package.json
2. **Update CHANGELOG.md**
3. **Create release tag**
4. **Deploy to production**
5. **Announce release**

**Example CHANGELOG entry:**
```markdown
## [1.1.0] - 2026-08-19

### Added
- Password reset functionality
- Email validation enhancements

### Fixed
- Tenant update authorization bug
- Rate limiter edge case

### Changed
- Improved error messages
- Updated documentation
```

---

## Documentation Standards

### Code Documentation

**README.md** should include:
- Project description
- Quick start guide
- Installation instructions
- Development workflow
- Testing
- Deployment
- Contributing guidelines
- License

**API Documentation** (docs/02-API.md):
- Endpoint descriptions
- Request/response formats
- Error codes
- Authentication requirements
- Rate limiting info

**Architecture Documentation** (docs/03-ARCHITECTURE.md):
- System design
- Component descriptions
- Data flow diagrams
- Dependency graphs
- Performance considerations

### Commit Messages

Write clear, descriptive commit messages:

```
feat(auth): add JWT token refresh endpoint

Implement token refresh mechanism to allow users to get new
access tokens using their refresh token, improving security
by allowing short-lived access tokens.

- Add /api/refresh_token endpoint
- Store refresh tokens in database
- Validate token expiration before refresh
- Return new access token on success

Closes #456
```

**Guidelines:**
- First line: descriptive summary (50 chars max)
- Blank line
- Detailed explanation (72 chars per line)
- Reference related issues
- Explain WHY, not WHAT

---

## Common Contribution Types

### Adding New Endpoint

1. **Add route** in `src/worker.js`
2. **Implement handler** in appropriate module
3. **Add validation** in `src/lib/validation.js`
4. **Add error handling** with try-catch
5. **Add tests** for endpoint
6. **Update docs** (API.md)
7. **Write commit message**

### Fixing Bug

1. **Create test** that reproduces bug
2. **Fix issue**
3. **Verify test passes**
4. **Add regression test**
5. **Update CHANGELOG.md**
6. **Write commit message** with "fix:"

### Adding Feature

1. **Plan feature** and discuss in issue
2. **Implement feature** with tests
3. **Add documentation**
4. **Update README if needed**
5. **Write commit message** with "feat:"

### Improving Documentation

1. **Edit doc file**
2. **Build docs** (if applicable)
3. **Verify links work**
4. **Write commit message** with "docs:"

---

## Useful Resources

### Project Structure
- See [Architecture Documentation](03-ARCHITECTURE.md)

### API Reference
- See [API Documentation](02-API.md)

### Development Setup
- See [Getting Started](01-GETTING_STARTED.md)

### Security Guidelines
- See [Security Guide](05-SECURITY.md)

### Deployment Info
- See [Deployment Guide](06-DEPLOYMENT.md)

---

## Questions?

- Check existing [GitHub Issues](https://github.com/blizzfulsummer-dot/rental-management-api/issues)
- Review [Discussions](https://github.com/blizzfulsummer-dot/rental-management-api/discussions)
- Open new issue if needed

## Thank You!

Thank you for contributing to Rental Management API! Your efforts make this project better.
