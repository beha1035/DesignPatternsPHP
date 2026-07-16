// cache — in-memory TTL cache (ADR 0001 §1). One composite key per
// (channel, hotelId/slug, checkin, checkout, adults, childrenAges, board,
// currency); childrenAges are sorted so [10,4] and [4,10] share an entry.
// TTL depends on the RESULT KIND, never the same duration for a technical
// failure as for a business answer (that would silently freeze an outage into
// a fake "verified" or fake "no_price" — the honesty invariant carries into
// caching, not just into the schema).

import { createHash } from "node:crypto";

export const TTL_MS = Object.freeze({
  verified: 30 * 60 * 1000, // 30 min
  no_price: 10 * 60 * 1000, // 10 min
  fx: 6 * 60 * 60 * 1000, // 6 h
  geo: 24 * 60 * 60 * 1000, // 24 h — near-static city -> country mapping
  // blocked / drift / error are intentionally ABSENT: never cached as if they
  // were a business answer. See ttlForStatus().
});

// Returns the TTL (ms) to use for a given offer/channel status, or `null` if
// the result must NOT be cached at all.
export function ttlForStatus(status) {
  if (status === "verified") return TTL_MS.verified;
  if (status === "no_price") return TTL_MS.no_price;
  return null; // blocked | drift | error | anything unknown -> never cached
}

// Deterministic composite key, sha1 hex. childrenAges are sorted so ordering
// never fragments the cache.
export function offerCacheKey({
  channel,
  hotelId,
  checkin,
  checkout,
  adults,
  childrenAges = [],
  board = "any",
  currency = "EUR",
}) {
  const sortedAges = [...childrenAges].sort((a, b) => a - b).join(",");
  const raw = [channel, hotelId, checkin, checkout, adults, sortedAges, board, currency]
    .map((v) => String(v ?? ""))
    .join("|");
  return createHash("sha1").update(raw).digest("hex");
}

class Entry {
  constructor(value, expiresAt) {
    this.value = value;
    this.expiresAt = expiresAt;
  }
}

export class TTLCache {
  #store = new Map();
  #hits = 0;
  #misses = 0;

  get size() {
    return this.#store.size;
  }
  get hits() {
    return this.#hits;
  }
  get misses() {
    return this.#misses;
  }

  set(key, value, ttlMs) {
    if (!ttlMs || ttlMs <= 0) return; // never cache non-positive TTL (failure results)
    this.#store.set(key, new Entry(value, Date.now() + ttlMs));
    return value;
  }

  get(key) {
    const e = this.#store.get(key);
    if (!e) {
      this.#misses += 1;
      return undefined;
    }
    if (Date.now() >= e.expiresAt) {
      this.#store.delete(key);
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    return e.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.#store.delete(key);
  }

  clear() {
    this.#store.clear();
  }

  // Remove all expired entries (housekeeping; not required for correctness
  // since get() self-evicts, but keeps long-running processes' memory tidy).
  prune(now = Date.now()) {
    for (const [k, e] of this.#store) {
      if (now >= e.expiresAt) this.#store.delete(k);
    }
  }
}
