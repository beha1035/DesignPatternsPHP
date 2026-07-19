// net-guard — outbound SSRF guard that installs ITSELF on import, in EVERY
// process. A parent monkey-patch of globalThis.fetch does NOT reach execFile
// children (each child has its own globalThis), so the webapp's central guard
// alone left every child of /api/rank (find-best-rate.mjs and the channel tools
// it spawns) unguarded. Fix: every CLI entry script does a side-effect import
// `import "./lib/net-guard.mjs";` so the allowlist is enforced in-process too.
//
// Policy: HTTPS only, host must be in the allowlist, and IP-literal hosts are
// rejected outright (metadata 169.254.169.254, loopback, private ranges can
// never be reached because they are never hostnames in the allowlist).
//
// This subprocess allowlist is the SUPERSET of webapp/lib/ssrf-guard.mjs's
// in-process list: the /api/rank cascade runs here and reaches the Tier 2/3
// channels (api.brightdata.com, fr.trip.com) that the server process itself
// never calls. The full union is documented in docs/api/openapi.yaml
// `x-outbound-allowlist` (each host annotated in-process vs subprocess). Adding
// a host here means adding it there too (and to the in-process guard only if
// the server itself will call it).

const ALLOWED = new Set([
  "tn.tunisiebooking.com",        // Tier 1 — verified Tunisia price (also in-process)
  "www.google.com",               // Tier 0 — Google Hotels (also in-process)
  "serpapi.com",                  // Tier 0 — metasearch key (also in-process)
  "api.apify.com",                // Tier 0 — breadth OTA key (also in-process)
  "api.brightdata.com",           // Tier 2 — unlock (subprocess-only)
  "open.er-api.com",              // FX EUR/TND (also in-process)
  "nominatim.openstreetmap.org",  // geo city -> country (also in-process)
  "www.booking.com",              // Tier 3 — browser signal (also in-process)
  "fr.trip.com",                  // Trip.com channel (subprocess-only)
]);

const isIpLiteral = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");

// Throws if the URL is not a safe, allowlisted outbound target. Exported so
// non-fetch callers (e.g. a Playwright page.goto) can guard explicitly.
export function assertSafeUrl(raw) {
  let u;
  try { u = new URL(typeof raw === "string" ? raw : raw?.url ?? String(raw)); }
  catch { throw new Error(`net-guard: invalid URL: ${String(raw).slice(0, 80)}`); }
  if (u.protocol !== "https:") throw new Error(`net-guard: non-https blocked (${u.protocol})`);
  const host = u.hostname.toLowerCase();
  if (isIpLiteral(host)) throw new Error(`net-guard: IP-literal host blocked (${host})`);
  if (!ALLOWED.has(host)) throw new Error(`net-guard: host not in allowlist (${host})`);
  return u;
}

export function isAllowedHost(host) {
  return ALLOWED.has(String(host || "").toLowerCase()) && !isIpLiteral(String(host || ""));
}

// Wrap globalThis.fetch once per process (idempotent across imports).
export function installNetGuard() {
  if (globalThis.__NET_GUARD__) return;
  globalThis.__NET_GUARD__ = true;
  const orig = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    assertSafeUrl(url);
    return orig(input, init);
  };
}

// Install on import — the whole point is that merely importing this file guards
// the current process.
installNetGuard();
