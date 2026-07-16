// pacing — per-host concurrency ceiling + circuit breaker, applied BEFORE the
// cache-miss path (ADR 0001). This is the fix that keeps the TunisieBooking
// throttling bug ("false no-availability under parallel bursts") from
// reappearing: no caller, however many concurrent HTTP requests the webapp is
// serving, can push more than N simultaneous requests to a given outbound
// host. `find-best-rate.mjs` already caps its OWN internal sweep at
// mapLimit(stays, 2, …); this module caps the same host GLOBALLY across every
// concurrent API request the webapp itself is serving (multiple users/tabs),
// which the CLI tool alone cannot do since each invocation is a fresh process.

// Ceilings from ADR 0001 / docs/api/openapi.yaml x-outbound-allowlist. Every
// outbound host has an explicit, numbered limit — not just TunisieBooking.
export const DEFAULT_LIMITS = Object.freeze({
  "tn.tunisiebooking.com": 2,
  "www.booking.com": 1,
  "api.apify.com": 1,
  "www.google.com": 2,
  "serpapi.com": 2,
  "open.er-api.com": 2,
  "nominatim.openstreetmap.org": 1,
});

const DEFAULT_LIMIT = 1;

/**
 * A weighted counting semaphore per host. `acquire(host, weight)` resolves
 * once `weight` units of the host's concurrency budget are free, and returns
 * a `release()` function that MUST be called (use try/finally).
 */
export class HostLimiter {
  #limits;
  #inUse = new Map(); // host -> number in flight
  #queue = new Map(); // host -> [{weight, resolve}]

  constructor(limits = DEFAULT_LIMITS, defaultLimit = DEFAULT_LIMIT) {
    this.#limits = limits;
    this.defaultLimit = defaultLimit;
  }

  limitFor(host) {
    return this.#limits[host] ?? this.defaultLimit;
  }

  inFlight(host) {
    return this.#inUse.get(host) ?? 0;
  }

  async acquire(host, weight = 1) {
    const limit = this.limitFor(host);
    const w = Math.max(1, Math.min(weight, limit));
    await new Promise((resolve) => {
      const tryEnter = () => {
        const cur = this.#inUse.get(host) ?? 0;
        if (cur + w <= limit) {
          this.#inUse.set(host, cur + w);
          resolve();
          return true;
        }
        return false;
      };
      if (tryEnter()) return;
      const q = this.#queue.get(host) ?? [];
      q.push({ weight: w, tryEnter });
      this.#queue.set(host, q);
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.#inUse.get(host) ?? 0;
      this.#inUse.set(host, Math.max(0, cur - w));
      this.#drain(host);
    };
  }

  #drain(host) {
    const q = this.#queue.get(host);
    if (!q || !q.length) return;
    // FIFO: try the head; if it now fits, remove and let it enter.
    while (q.length && q[0].tryEnter()) q.shift();
    if (!q.length) this.#queue.delete(host);
  }
}

/**
 * Per-host circuit breaker: after `threshold` consecutive failures
 * (blocked/drift/timeout), the circuit "opens" for `cooldownMs` and further
 * calls fail fast (no network hit) — this is the backoff half of ADR 0001,
 * protecting the outbound IP from being hammered while a channel is down.
 */
export class CircuitBreaker {
  #state = new Map(); // host -> {failures, openUntil}

  constructor({ threshold = 3, cooldownMs = 60_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  isOpen(host) {
    const s = this.#state.get(host);
    if (!s || !s.openUntil) return false;
    if (Date.now() >= s.openUntil) {
      // Half-open: allow the next attempt through, resetting failures.
      s.openUntil = null;
      s.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(host) {
    this.#state.set(host, { failures: 0, openUntil: null });
  }

  recordFailure(host) {
    const s = this.#state.get(host) ?? { failures: 0, openUntil: null };
    s.failures += 1;
    if (s.failures >= this.threshold) {
      s.openUntil = Date.now() + this.cooldownMs;
    }
    this.#state.set(host, s);
  }
}

/**
 * Run `fn` under both the concurrency ceiling and the circuit breaker for
 * `host`. Throws a CircuitOpenError immediately (no network call) if the
 * breaker is open; otherwise acquires the pacing slot, runs `fn`, and records
 * success/failure for the breaker based on `classifyOutcome(result|error)`.
 */
export class CircuitOpenError extends Error {
  constructor(host, cooldownMs) {
    super(`Circuit open for ${host} — too many recent failures, cooling down.`);
    this.name = "CircuitOpenError";
    this.host = host;
    this.cooldownMs = cooldownMs;
  }
}

export async function withPacing(limiter, breaker, host, weight, fn, {
  classifyOutcome = () => "success",
} = {}) {
  if (breaker?.isOpen(host)) {
    throw new CircuitOpenError(host, breaker.cooldownMs);
  }
  const release = await limiter.acquire(host, weight);
  try {
    const result = await fn();
    const outcome = classifyOutcome(result, null);
    if (breaker) (outcome === "failure" ? breaker.recordFailure : breaker.recordSuccess).call(breaker, host);
    return result;
  } catch (e) {
    if (breaker) breaker.recordFailure(host);
    throw e;
  } finally {
    release();
  }
}
