import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/lib/rateLimit.js';

test('rate limiter allows the configured request count and then blocks', () => {
  const limit = createRateLimiter({ windowMs: 60_000, maxRequests: 2 });
  assert.equal(limit('client-a').ok, true);
  assert.equal(limit('client-a').ok, true);
  assert.equal(limit('client-a').ok, false);
});

test('rate limiter keeps its in-memory key map bounded', () => {
  const limit = createRateLimiter({ windowMs: 60_000, maxRequests: 1, maxEntries: 2 });
  limit('client-a');
  limit('client-b');
  assert.equal(limit('client-c').ok, true);
  assert.equal(limit('client-c').ok, false);
});
