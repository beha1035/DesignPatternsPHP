import { test } from "node:test";
import assert from "node:assert/strict";
import { TTLCache, offerCacheKey, ttlForStatus, TTL_MS } from "../lib/cache.mjs";

test("TTLCache: set/get round-trips a value", () => {
  const c = new TTLCache();
  c.set("k", { a: 1 }, 1000);
  assert.deepEqual(c.get("k"), { a: 1 });
});

test("TTLCache: expired entries are evicted on read", async () => {
  const c = new TTLCache();
  c.set("k", "v", 5);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.get("k"), undefined);
  assert.equal(c.size, 0);
});

test("TTLCache: a non-positive TTL is never stored (failure results are never cached)", () => {
  const c = new TTLCache();
  c.set("k", "v", 0);
  c.set("k2", "v", null);
  assert.equal(c.size, 0);
});

test("TTLCache: tracks hits/misses", () => {
  const c = new TTLCache();
  c.get("missing");
  c.set("k", "v", 1000);
  c.get("k");
  assert.equal(c.misses, 1);
  assert.equal(c.hits, 1);
});

test("ttlForStatus: verified=30min, no_price=10min, others uncached", () => {
  assert.equal(ttlForStatus("verified"), TTL_MS.verified);
  assert.equal(ttlForStatus("no_price"), TTL_MS.no_price);
  assert.equal(ttlForStatus("blocked"), null);
  assert.equal(ttlForStatus("drift"), null);
  assert.equal(ttlForStatus("error"), null);
  assert.equal(ttlForStatus("signal"), null);
});

test("offerCacheKey: stable across childrenAges order (sorted before hashing)", () => {
  const base = { channel: "tunisiebooking", hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, currency: "EUR" };
  const k1 = offerCacheKey({ ...base, childrenAges: [10, 4] });
  const k2 = offerCacheKey({ ...base, childrenAges: [4, 10] });
  assert.equal(k1, k2);
});

test("offerCacheKey: differs when any query dimension differs", () => {
  const base = { channel: "tunisiebooking", hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, currency: "EUR", childrenAges: [] };
  const k1 = offerCacheKey(base);
  const k2 = offerCacheKey({ ...base, adults: 3 });
  const k3 = offerCacheKey({ ...base, hotelId: 355 });
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
});
