import { test } from "node:test";
import assert from "node:assert/strict";
import { HostLimiter, CircuitBreaker, withPacing, CircuitOpenError, DEFAULT_LIMITS } from "../lib/pacing.mjs";

test("DEFAULT_LIMITS matches ADR 0001: TunisieBooking<=2, Booking<=1, Apify<=1", () => {
  assert.equal(DEFAULT_LIMITS["tn.tunisiebooking.com"], 2);
  assert.equal(DEFAULT_LIMITS["www.booking.com"], 1);
  assert.equal(DEFAULT_LIMITS["api.apify.com"], 1);
});

test("HostLimiter: never lets concurrency exceed the configured ceiling", async () => {
  const limiter = new HostLimiter({ "tn.tunisiebooking.com": 2 });
  let current = 0;
  let maxObserved = 0;
  const task = async () => {
    const release = await limiter.acquire("tn.tunisiebooking.com", 1);
    current += 1;
    maxObserved = Math.max(maxObserved, current);
    await new Promise((r) => setTimeout(r, 15));
    current -= 1;
    release();
  };
  await Promise.all(Array.from({ length: 10 }, task));
  assert.equal(maxObserved <= 2, true, `observed concurrency ${maxObserved} exceeded ceiling of 2`);
});

test("HostLimiter: a weighted acquire reserves that many units", async () => {
  const limiter = new HostLimiter({ h: 2 });
  const release1 = await limiter.acquire("h", 2); // takes the whole budget
  assert.equal(limiter.inFlight("h"), 2);
  let secondEntered = false;
  const p = limiter.acquire("h", 1).then((release2) => {
    secondEntered = true;
    release2();
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(secondEntered, false, "second acquire must wait while the budget is fully reserved");
  release1();
  await p;
  assert.equal(secondEntered, true);
});

test("HostLimiter: independent hosts do not share a budget", async () => {
  const limiter = new HostLimiter({ a: 1, b: 1 });
  const r1 = await limiter.acquire("a", 1);
  const r2 = await limiter.acquire("b", 1); // must not block on `a`'s budget
  assert.equal(limiter.inFlight("a"), 1);
  assert.equal(limiter.inFlight("b"), 1);
  r1();
  r2();
});

test("CircuitBreaker: opens after `threshold` consecutive failures, then fails fast", () => {
  const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 50 });
  assert.equal(breaker.isOpen("h"), false);
  breaker.recordFailure("h");
  breaker.recordFailure("h");
  assert.equal(breaker.isOpen("h"), false, "still under threshold");
  breaker.recordFailure("h");
  assert.equal(breaker.isOpen("h"), true, "threshold reached -> open");
});

test("CircuitBreaker: half-opens (allows a probe) after the cooldown elapses", async () => {
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 20 });
  breaker.recordFailure("h");
  assert.equal(breaker.isOpen("h"), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(breaker.isOpen("h"), false, "cooldown elapsed -> half-open");
});

test("CircuitBreaker: a success resets the failure count", () => {
  const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 50 });
  breaker.recordFailure("h");
  breaker.recordFailure("h");
  breaker.recordSuccess("h");
  breaker.recordFailure("h");
  breaker.recordFailure("h");
  assert.equal(breaker.isOpen("h"), false, "success reset the streak, so 2 more failures is not enough");
});

test("withPacing: fails fast (no fn call) when the circuit is open", async () => {
  const limiter = new HostLimiter({ h: 2 });
  const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 10_000 });
  breaker.recordFailure("h");
  let called = false;
  await assert.rejects(
    () => withPacing(limiter, breaker, "h", 1, async () => { called = true; }),
    CircuitOpenError
  );
  assert.equal(called, false);
});

test("withPacing: records a breaker failure and rethrows when fn throws", async () => {
  const limiter = new HostLimiter({ h: 2 });
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 10_000 });
  await assert.rejects(() => withPacing(limiter, breaker, "h", 1, async () => { throw new Error("boom"); }));
  await assert.rejects(() => withPacing(limiter, breaker, "h", 1, async () => { throw new Error("boom"); }));
  assert.equal(breaker.isOpen("h"), true);
});
