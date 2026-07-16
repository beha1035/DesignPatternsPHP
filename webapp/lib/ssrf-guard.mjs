// ssrf-guard — the CENTRAL anti-SSRF control point for every outbound request
// the webapp makes. Nothing in this codebase is allowed to call the network
// fetch layer directly in production: `server.mjs` installs this guard over
// `globalThis.fetch` before any route/service/tool module is imported, so the
// existing tool modules (lib/smart-fetch.mjs, lib/fx.mjs, lib/geo.mjs,
// apify-hotel-rates.mjs) — which all call the bare global `fetch` — are
// automatically routed through the same allowlist + private-IP check without
// having to be modified (contract modules are reused, not reimplemented).
//
// Two independent controls, both required to pass:
//   1. Host allowlist (`x-outbound-allowlist` in openapi.yaml) — exact
//      hostname match, https only, no userinfo tricks (the URL parser already
//      resolves `user@host` to the real `host`), no IP-literal targets.
//   2. DNS-resolved IP must not be private/loopback/link-local/reserved —
//      defense in depth against a compromised/rebound DNS answer for an
//      allowlisted name. The resolver is injectable so tests never touch the
//      network (see test/ssrf-guard.test.mjs).
//
// This module NEVER receives a client-supplied URL: every caller builds URLs
// from hardcoded hosts + validated path/query fragments (see webapp/service.mjs
// and the tool modules themselves). The guard is defense in depth, not the
// only control — the API surface has no `url` field to begin with (see
// lib/validate.mjs).

import dns from "node:dns";

const lookup = dns.promises ? dns.promises.lookup : dns.promises;

// Mirrors docs/api/openapi.yaml `x-outbound-allowlist`. Keep in sync with the
// OpenAPI contract; do not add a host here without updating the spec (ADR).
export const ALLOWLIST_HOSTS = Object.freeze([
  "tn.tunisiebooking.com", // Tier 1 — verified Tunisia price (free)
  "www.google.com", // Tier 0 — Google Hotels (google-hotels-rate)
  "serpapi.com", // Tier 0 — API key (metasearch)
  "api.apify.com", // Tier 0 — API key (breadth OTA)
  "open.er-api.com", // FX EUR/TND
  "nominatim.openstreetmap.org", // geo city -> country
  "www.booking.com", // Tier 3 — browser (signal), internal slug only
]);

const ALLOWLIST_SET = new Set(ALLOWLIST_HOSTS);

export class SSRFError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "SSRFError";
    this.reason = reason; // 'scheme' | 'host' | 'ip-literal' | 'private-ip' | 'dns'
  }
}

// ---- pure IP classification (no I/O, fully unit-testable) -----------------

function ipv4ToInt(parts) {
  return (
    (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  ) >>> 0;
}

const IPV4_PRIVATE_RANGES = [
  ["0.0.0.0", "0.255.255.255"], // "this" network
  ["10.0.0.0", "10.255.255.255"], // RFC1918
  ["100.64.0.0", "100.127.255.255"], // CGNAT
  ["127.0.0.0", "127.255.255.255"], // loopback
  ["169.254.0.0", "169.254.255.255"], // link-local (cloud metadata!)
  ["172.16.0.0", "172.31.255.255"], // RFC1918
  ["192.0.0.0", "192.0.0.255"], // IETF protocol assignments
  ["192.0.2.0", "192.0.2.255"], // TEST-NET-1
  ["192.168.0.0", "192.168.255.255"], // RFC1918
  ["198.18.0.0", "198.19.255.255"], // benchmark
  ["198.51.100.0", "198.51.100.255"], // TEST-NET-2
  ["203.0.113.0", "203.0.113.255"], // TEST-NET-3
  ["224.0.0.0", "239.255.255.255"], // multicast
  ["240.0.0.0", "255.255.255.255"], // reserved / broadcast
];

function parseIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts;
}

export function isPrivateIPv4(ip) {
  const parts = parseIPv4(ip);
  if (!parts) return false;
  const n = ipv4ToInt(parts);
  return IPV4_PRIVATE_RANGES.some(([lo, hi]) => {
    const loN = ipv4ToInt(parseIPv4(lo));
    const hiN = ipv4ToInt(parseIPv4(hi));
    return n >= loN && n <= hiN;
  });
}

// IPv6 mapped-v4 (::ffff:a.b.c.d) is unwrapped and re-checked as IPv4.
function unwrapMappedV4(ip) {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  return m ? m[1] : null;
}

export function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  const mapped = unwrapMappedV4(lower);
  if (mapped) return isPrivateIPv4(mapped);
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
  if (lower.startsWith("2001:db8:")) return true; // documentation range
  return false;
}

export function isPrivateIp(ip) {
  if (!ip) return true; // fail closed
  return ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

// ---- URL / allowlist validation --------------------------------------------

// Validate a URL string against scheme + host allowlist. Does NOT resolve DNS
// (pure, synchronous, testable without I/O). Throws SSRFError on any failure.
export function assertAllowedUrlShape(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new SSRFError(`Malformed URL: ${urlString}`, "malformed");
  }
  if (url.protocol !== "https:") {
    throw new SSRFError(`Scheme not allowed: ${url.protocol}`, "scheme");
  }
  if (isIpLiteral(url.hostname)) {
    throw new SSRFError(`IP-literal hosts are never allowed: ${url.hostname}`, "ip-literal");
  }
  if (!ALLOWLIST_SET.has(url.hostname)) {
    throw new SSRFError(`Host not in outbound allowlist: ${url.hostname}`, "host");
  }
  return url;
}

// (kept tiny — avoids importing node:net just for a bracket check)
function isIpLiteral(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "");
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

// Full check: shape + allowlist + DNS-resolved IP not private. `resolveHostname`
// is injectable so unit tests never touch the network.
export async function assertSafeUrl(urlString, { resolveHostname = defaultResolve } = {}) {
  const url = assertAllowedUrlShape(urlString);
  let addresses;
  try {
    addresses = await resolveHostname(url.hostname);
  } catch (e) {
    throw new SSRFError(`DNS resolution failed for ${url.hostname}: ${e.message}`, "dns");
  }
  if (!addresses || !addresses.length) {
    throw new SSRFError(`DNS resolution returned no address for ${url.hostname}`, "dns");
  }
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new SSRFError(
        `Resolved IP for ${url.hostname} is private/loopback/link-local: ${addr}`,
        "private-ip"
      );
    }
  }
  return url;
}

async function defaultResolve(hostname) {
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}

// ---- guarded fetch ----------------------------------------------------------

/**
 * Wrap a fetch implementation so every call is validated by assertSafeUrl
 * first. Non-string/URL input (e.g. a Request object with a forbidden URL) is
 * also validated by resolving its `.url`.
 */
export function createGuardedFetch(baseFetch, { resolveHostname } = {}) {
  if (typeof baseFetch !== "function") {
    throw new TypeError("createGuardedFetch requires a base fetch implementation");
  }
  return async function guardedFetch(input, init) {
    const urlString = typeof input === "string" ? input : input?.url ?? String(input);
    await assertSafeUrl(urlString, { resolveHostname });
    return baseFetch(input, init);
  };
}

const ORIGINAL_FETCH = globalThis.fetch;

// Idempotent: replaces globalThis.fetch with the guarded version exactly once
// (calling it again is a no-op so tests/dev reload don't double-wrap).
let installed = false;
export function installGlobalFetchGuard(opts = {}) {
  if (installed) return globalThis.fetch;
  const guarded = createGuardedFetch(ORIGINAL_FETCH, opts);
  globalThis.fetch = guarded;
  installed = true;
  return guarded;
}

// For tests only: allows resetting the "installed" flag between test files
// that want to exercise installGlobalFetchGuard() itself.
export function __resetForTests() {
  installed = false;
  globalThis.fetch = ORIGINAL_FETCH;
}
