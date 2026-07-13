// fx — live currency conversion with an honest fallback. A hardcoded EUR/TND
// rate silently rots; this fetches a current rate and, when the network/API is
// unavailable, returns a pinned rate clearly flagged `stale` so callers can label
// converted prices as approximate instead of pretending they're current.

if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

// Pinned EUR->X fallbacks (update occasionally); only used when the live fetch
// fails. Cross rates for any pair among these currencies are derived from them.
const PINNED = { TND: 3.37, USD: 1.08, GBP: 0.84, MAD: 10.8 };

// Derive a base->quote rate from the EUR-anchored PINNED table (both directions
// and cross pairs), so the fallback works for more than just an EUR base.
function pinnedRate(base, quote) {
  if (base === quote) return 1;
  if (base === "EUR") return PINNED[quote] ?? null;
  if (quote === "EUR") return PINNED[base] ? 1 / PINNED[base] : null;
  if (PINNED[base] && PINNED[quote]) return PINNED[quote] / PINNED[base];
  return null;
}

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
    return { rate: pinnedRate(base, quote), stale: true, asOf: null, source: "pinned-fallback" };
  } finally {
    clearTimeout(timer);
  }
}

// Convert an amount, returning null if we have no usable rate.
export function convert(amount, rate) {
  if (amount == null || !rate) return null;
  return Math.round((amount / rate) * 100) / 100;
}
