export async function hashPBKDF2(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, keyMaterial, 256);
  return { hash: derivedBits, salt };
}

export async function verifyPBKDF2(storedHex, saltHex, password) {
  const salt = hexToArrayBuffer(saltHex);
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, keyMaterial, 256);
  return arrayBufferToHex(derivedBits) === storedHex;
}

export async function verifyLegacy(password, salt, hash) {
  if (!salt) return false;
  const data = new TextEncoder().encode(password + salt);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return arrayBufferToHex(digest) === hash;
}

export async function fakeVerify() {
  // Match the PBKDF2 work factor used for a real password check to reduce
  // account-enumeration timing differences for unknown email addresses.
  await hashPBKDF2('constant-dummy-password-for-timing-equalization');
}

export function arrayBufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToArrayBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function generateTempPassword(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  let password = '';
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    password += chars[array[i] % chars.length];
  }
  return password;
}
