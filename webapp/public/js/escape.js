// escape — defense-in-depth helpers for handling content that ultimately came
// from a scraped/third-party source (hotel names, room names, sourceUrl).
//
// The UI's PRIMARY defense against XSS is architectural: every DOM write in
// render.js uses `textContent` / `createElement`, never `innerHTML`, so raw
// HTML in scraped strings can never be parsed as markup in the first place.
// `escapeHtml` below exists as a second line of defense (e.g. if a future
// change ever needs to compose an HTML string) and is unit-tested on its own
// merits. `sanitizeUrl` is a *real, actively used* guard: `Offer.sourceUrl` is
// an informative string coming straight from the scraped page and is never
// validated server-side as an http(s) URL — a `javascript:`/`data:` payload
// there must never become a clickable link.

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

// Returns a normalised absolute http(s) URL, or null if `raw` is missing,
// relative, or uses a dangerous/unexpected scheme (javascript:, data:,
// vbscript:, file:, ...). Never throws.
export function sanitizeUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!SAFE_URL_PROTOCOLS.has(parsed.protocol)) return null;
  return parsed.href;
}
