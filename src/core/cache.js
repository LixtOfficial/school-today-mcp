/**
 * Simple in-memory TTL cache with prefix invalidation.
 * Ensures fast repeated reads and batch operations while keeping data fresh after writes.
 */
class CacheManager {
  constructor(defaultTtlMs = 90 * 1000) {
    this.store = new Map();
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });
    return value;
  }

  async getOrFetch(key, fetcher, ttlMs = this.defaultTtlMs) {
    const cached = this.get(key);
    if (cached !== null) return cached;
    const fresh = await fetcher();
    this.set(key, fresh, ttlMs);
    return fresh;
  }

  invalidatePrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear() {
    this.store.clear();
  }
}

module.exports = { CacheManager };
