#!/usr/bin/env node
// brightdata-unlock — Tier 2 of the rate cascade: a MANAGED anti-bot unblocker
// that replaces our self-hosted Playwright for the sites that genuinely fight
// back (Agoda's date-SPA, Hotels.com's lazy price micro-service, Expedia's 429).
// Bright Data's Web Unlocker rotates proxies, solves CAPTCHAs, and renders JS
// server-side (~98% success), returning the final HTML/markdown in one call — so
// "last resort" becomes a fast API hit, not a 30s browser boot we maintain.
//
// This is invoked only when Tier 0/1 leave a gap. It needs a key; without one it
// fails honestly (never silently) so the orchestrator can fall back to the
// self-hosted browser instead.
//
//   export BRIGHTDATA_API_KEY=...            # API token
//   export BRIGHTDATA_ZONE=web_unlocker1     # your Web Unlocker zone name
//   node brightdata-unlock.mjs --url "https://www.agoda.com/..." [--format raw]
//
// Output: JSON { status, url, httpStatus, body } on stdout. status:
// verified (fetched) | error (missing key / API error) | blocked.

if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

const API = "https://api.brightdata.com/request";

function parseArgs(argv) {
  const a = {
    apiKey: process.env.BRIGHTDATA_API_KEY || null,
    zone: process.env.BRIGHTDATA_ZONE || "web_unlocker1",
    format: "raw",
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--url") (a.url = v), i++;
    else if (k === "--zone") (a.zone = v), i++;
    else if (k === "--format") (a.format = v), i++;
    else if (k === "--api-key") (a.apiKey = v), i++;
  }
  return a;
}

const emit = (o) => console.log(JSON.stringify(o, null, 2));

(async () => {
  const a = parseArgs(process.argv);
  if (!a.url) {
    console.error("Required: --url <target URL>");
    process.exit(2);
  }
  if (!a.apiKey) {
    emit({
      status: "error", url: a.url,
      note: "Missing BRIGHTDATA_API_KEY. Create a Web Unlocker zone at https://brightdata.com (5,000 free requests/month) and export BRIGHTDATA_API_KEY + BRIGHTDATA_ZONE. Falling back to the self-hosted browser is the orchestrator's job.",
    });
    process.exit(1);
  }
  try {
    const resp = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.apiKey}` },
      body: JSON.stringify({ zone: a.zone, url: a.url, format: a.format }),
    });
    const body = await resp.text();
    if (!resp.ok) {
      const blocked = resp.status === 403 || resp.status === 407;
      emit({ status: blocked ? "blocked" : "error", url: a.url, httpStatus: resp.status, note: body.slice(0, 300) });
      process.exit(blocked ? 0 : 1);
    }
    emit({ status: "verified", url: a.url, httpStatus: 200, body });
  } catch (e) {
    emit({ status: "error", url: a.url, note: String(e?.message || e) });
    process.exit(1);
  }
})();
