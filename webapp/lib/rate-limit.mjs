// rate-limit — per-CLIENT rate limiting (distinct from lib/pacing.mjs, which
// paces OUTBOUND requests per external host). This protects the webapp's
// outbound budget from being exhausted by a single noisy client (ADR 0001,
// threat #4): if callers could fire unlimited /api/rank requests, the
// per-host outbound ceiling would just turn into an ever-growing queue
// instead of a real limit on egress traffic.

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 30;

export class ClientRateLimiter {
  #hits = new Map(); // clientKey -> array of timestamps (ms)

  constructor({ windowMs = DEFAULT_WINDOW_MS, max = DEFAULT_MAX } = {}) {
    this.windowMs = windowMs;
    this.max = max;
  }

  // Returns { allowed:boolean, retryAfterSeconds:number }.
  check(clientKey, now = Date.now()) {
    const arr = (this.#hits.get(clientKey) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      const oldest = arr[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
      this.#hits.set(clientKey, arr);
      return { allowed: false, retryAfterSeconds };
    }
    arr.push(now);
    this.#hits.set(clientKey, arr);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

// Express middleware factory. Client key = bearer token if present, else IP —
// so unauthenticated flows are still bounded, and each authenticated caller
// gets its own budget.
export function rateLimitMiddleware(limiter) {
  return (req, res, next) => {
    const auth = req.headers.authorization || "";
    const key = auth.startsWith("Bearer ") ? `tok:${auth.slice(7, 23)}` : `ip:${req.ip}`;
    const { allowed, retryAfterSeconds } = limiter.check(key);
    if (!allowed) {
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: "rate_limited",
        message: "Trop de requêtes ; réessayez plus tard.",
      });
    }
    next();
  };
}
