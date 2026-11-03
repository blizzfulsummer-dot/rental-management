/**
 * Best-effort per-isolate limiter. This is not a distributed security boundary:
 * Cloudflare may run multiple isolates. Use Cloudflare Rate Limiting/WAF rules
 * for production-wide enforcement.
 */
export function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  maxRequests = 10,
  maxEntries = 10_000
} = {}) {
  const hits = new Map();

  return function check(identifier) {
    const now = Date.now();
    const key = String(identifier || 'anonymous');
    let entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      // Bound memory growth and opportunistically remove expired entries.
      if (hits.size >= maxEntries) {
        for (const [storedKey, storedEntry] of hits) {
          if (now >= storedEntry.resetAt) hits.delete(storedKey);
          if (hits.size < maxEntries) break;
        }
        if (hits.size >= maxEntries) hits.delete(hits.keys().next().value);
      }
      entry = { count: 1, resetAt: now + windowMs };
      hits.set(key, entry);
      return { ok: true, remaining: Math.max(0, maxRequests - 1), resetAt: entry.resetAt };
    }

    if (entry.count >= maxRequests) {
      return { ok: false, remaining: 0, resetAt: entry.resetAt };
    }

    entry.count += 1;
    return { ok: true, remaining: Math.max(0, maxRequests - entry.count), resetAt: entry.resetAt };
  };
}
