// fx — live currency conversion with an honest fallback. A hardcoded EUR/TND
// rate silently rots; this fetches a current rate and, when the network/API is
// unavailable, returns a pinned rate clearly flagged `stale` so callers can label
// converted prices as approximate instead of pretending they're current.

if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

// Pinned fallbacks (update occasionally); only used when the live fetch fails.
const PINNED = { TND: 3.37, USD: 1.08, GBP: 0.84, MAD: 10.8 };

/**
 * @param {string} base  e.g. "EUR"
 * @param {string} quote e.g. "TND"
 * @returns {Promise<{rate:number, stale:boolean, asOf:string, source:string}>}
 */
export async function getRate(base = "EUR", quote = "TND", { timeoutMs = 6000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://open.er-api.com/v6/latest/${base}`, { signal: ctl.signal });
    if (!resp.ok) throw new Error(`fx HTTP ${resp.status}`);
    const j = await resp.json();
    const rate = j?.rates?.[quote];
    if (typeof rate !== "number") throw new Error(`no ${quote} rate in response`);
    return { rate, stale: false, asOf: j.time_last_update_utc || new Date().toISOString(), source: "open.er-api.com" };
  } catch {
    const rate = base === "EUR" ? PINNED[quote] : null;
    return { rate, stale: true, asOf: null, source: "pinned-fallback" };
  } finally {
    clearTimeout(timer);
  }
}

// Convert an amount, returning null if we have no usable rate.
export function convert(amount, rate) {
  if (amount == null || !rate) return null;
  return Math.round((amount / rate) * 100) / 100;
}
