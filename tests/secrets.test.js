import test from 'node:test';
import assert from 'node:assert/strict';
import { getSecretBytes, getSecretString } from '../src/lib/secrets.js';

const secret = 'unit-test-secret-value-with-at-least-32-characters';

test('secret resolver supports plain local string values', async () => {
  assert.equal(await getSecretString({ JWT_SCRT: secret }, 'JWT_SCRT'), secret);
  assert.equal(new TextDecoder().decode(await getSecretBytes({ JWT_SCRT: secret }, 'JWT_SCRT')), secret);
});

test('secret resolver reads Cloudflare Secrets Store get() bindings', async () => {
  const binding = { async get() { return secret; } };
  assert.equal(await getSecretString({ JWT_SCRT: binding }, 'JWT_SCRT'), secret);
});

test('secret resolver rejects missing and weak values', async () => {
  await assert.rejects(() => getSecretString({}, 'JWT_SCRT'), /missing or too short/);
  await assert.rejects(() => getSecretString({ JWT_SCRT: 'weak' }, 'JWT_SCRT'), /missing or too short/);
});
