// smart-fetch — a browserless HTTP fetch that defeats the naive "403" many
// booking sites return to bare curl. The block is almost always just a missing
// User-Agent / Accept-Language, NOT a real JS challenge: with realistic browser
// headers, sites like TunisieBooking answer 200 in ~1.6s. This is Tier 1 of the
// rate cascade — fast and free, tried before any managed unblocker or browser.
//
// Network: Node global fetch honours HTTPS_PROXY only with NODE_USE_ENV_PROXY=1
// (Node >= 22.21) plus the proxy CA via NODE_EXTRA_CA_CERTS. The SessionStart
// hook sets both; we also default NODE_USE_ENV_PROXY here.

if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

// A plausible desktop-Chrome header set. Sites fingerprint on these; sending
// them is the whole trick.
export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
    "image/webp,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Chromium";v="126", "Not(A:Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

// Classify a failure the honest way: a proxy/egress denial (blocked) is not the
// same as a site error, and must never be dressed up as "no price".
export function classifyError(msg) {
  return /403|407|ENOTFOUND|ECONNREFUSED|fetch failed|tunnel|allowlist|ERR_TUNNEL/i.test(
    String(msg)
  )
    ? "blocked"
    : "error";
}

/**
 * GET a URL with browser-like headers.
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.headers]  extra/override headers
 * @param {number} [opts.timeoutMs=20000]
 * @param {boolean} [opts.xhr=false]  send X-Requested-With (for AJAX endpoints)
 * @param {string} [opts.referer]
 * @returns {Promise<{status:number, ok:boolean, text:string}>}
 */
export async function smartGet(url, opts = {}) {
  const { headers = {}, timeoutMs = 20000, xhr = false, referer } = opts;
  const h = { ...BROWSER_HEADERS, ...headers };
  if (xhr) h["X-Requested-With"] = "XMLHttpRequest";
  if (referer) h.Referer = referer;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: h, signal: ctl.signal, redirect: "follow" });
    const text = await resp.text();
    return { status: resp.status, ok: resp.ok, text };
  } finally {
    clearTimeout(timer);
  }
}
