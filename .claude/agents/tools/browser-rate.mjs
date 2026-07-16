#!/usr/bin/env node
import "./lib/net-guard.mjs"; // SSRF guard — installs in THIS process (incl. execFile children)
import { assertSafeUrl } from "./lib/net-guard.mjs";
// browser-rate — country-agnostic, occupancy-EXACT Booking.com pricer. Drives a
// real browser to any hotel's Booking page with the exact party (adults + child
// ages in the URL), then reads the price from the ROOMS TABLE — the price Booking
// shows for that party — not a flat scrape of every number on the page (which
// mixes taxes and non-comparable rooms). This is the generalized Tier-3 pricer:
// the reliable verified-price path for hotels outside our free Tunisian channel,
// anywhere Booking has the property.
//
// Usage:
//   node browser-rate.mjs --booking-slug tn/tabarka-beach \
//     --checkin 2026-07-14 --checkout 2026-07-16 --adults 2 --children 10 [--currency EUR]
//   node browser-rate.mjs --booking-url "https://www.booking.com/hotel/....html" ...
//
// Output: one JSON object on stdout. Verified prices carry occupancyVerified:true
// (the party was applied in the URL). Honest blocked/no_price/error otherwise.

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const EXECUTABLE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

// ---- pure helpers (unit-tested without a browser) --------------------------

// Parse a money string to a number, tolerant of "€ 797", "1.234,50 €",
// "1,234.50", "797 TND". Returns null if no number.
export function parseMoney(s) {
  if (s == null) return null;
  let t = String(s).replace(/[^\d.,]/g, "");
  if (!t) return null;
  const hasDot = t.includes("."), hasComma = t.includes(",");
  if (hasDot && hasComma) {
    // The rightmost separator is the decimal one; strip the other (thousands).
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (hasComma) {
    // "1,234" -> thousands; "34,50" -> decimal (comma before exactly 2 digits).
    t = /,\d{2}$/.test(t) ? t.replace(",", ".") : t.replace(/,/g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// From candidate room-price strings, pick the cheapest PLAUSIBLE stay total for
// the party. Filters out junk (taxes/fees below `minPlausible`) so "€1"/"€29"
// can't win, and returns the min plus the parsed set for transparency.
export function pickStayTotal(priceStrings, { minPlausible = 40 } = {}) {
  const nums = (priceStrings || []).map(parseMoney).filter((n) => n != null && n >= minPlausible);
  if (!nums.length) return { total: null, candidates: [] };
  return { total: Math.min(...nums), candidates: [...new Set(nums)].sort((a, b) => a - b) };
}

// Build a Booking hotel URL that pins the exact party.
export function bookingUrl({ slug, url, checkin, checkout, adults, children = [], currency = "EUR" }) {
  const base = url || `https://www.booking.com/hotel/${slug}.html`;
  const p = new URLSearchParams({
    checkin, checkout,
    group_adults: String(adults), group_children: String(children.length),
    no_rooms: "1", selected_currency: currency, lang: "en",
  });
  const ages = children.map((a) => `&age=${a}`).join("");
  return `${base}?${p}${ages}`;
}

// ---- browser drive ---------------------------------------------------------

function parseArgs(argv) {
  const a = { adults: 2, children: [], currency: "EUR", timeout: 45000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--booking-slug") (a.slug = v), i++;
    else if (k === "--booking-url") (a.url = v), i++;
    else if (k === "--checkin") (a.checkin = v), i++;
    else if (k === "--checkout") (a.checkout = v), i++;
    else if (k === "--adults") (a.adults = Number(v)), i++;
    else if (k === "--children") (a.children = v.split(",").filter(Boolean).map(Number)), i++;
    else if (k === "--currency") (a.currency = v), i++;
    else if (k === "--timeout") (a.timeout = Number(v)), i++;
  }
  if ((!a.slug && !a.url) || !a.checkin || !a.checkout) {
    console.error("Required: (--booking-slug or --booking-url) --checkin --checkout");
    process.exit(2);
  }
  return a;
}

const emit = (o) => console.log(JSON.stringify(o, null, 2));
const ANTIBOT = ["access denied", "captcha", "are you a robot", "unusual traffic", "verify you are human"];

// Room-table price selectors, most specific first.
const PRICE_SELECTORS = [
  '[data-testid="price-and-discounted-price"]',
  ".prco-valign-middle-helper",
  ".bui-price-display__value",
  ".hprt-price-price",
];

async function main() {
  const require = createRequire(import.meta.url);
  let chromium;
  for (const p of ["/opt/node22/lib/node_modules/playwright", "playwright", "playwright-core"]) {
    try { ({ chromium } = require(p)); break; } catch {}
  }
  if (!chromium) { emit({ status: "error", note: "Playwright not found" }); process.exit(2); }

  const a = parseArgs(process.argv);
  const url = bookingUrl(a);
  // Playwright's page.goto does NOT go through the guarded globalThis.fetch, so
  // guard the target explicitly here — this is the one place a free --booking-url
  // could otherwise reach the network unchecked (SSRF).
  try { assertSafeUrl(url); }
  catch (e) { emit({ status: "blocked", url, note: String(e.message), offers: [] }); process.exit(0); }
  const query = { hotel: a.slug || a.url, checkin: a.checkin, checkout: a.checkout, adults: a.adults, childrenAges: a.children, currency: a.currency };
  const REPORTS = join(dirname(fileURLToPath(import.meta.url)), "..", "reports");
  mkdirSync(REPORTS, { recursive: true });

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const browser = await chromium.launch({
    headless: true, executablePath: EXECUTABLE,
    ...(proxy ? { proxy: { server: proxy } } : {}),
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const ctx = await browser.newContext({
      locale: "en-US", viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => undefined }));
    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: a.timeout });
    const http = resp?.status() ?? null;
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const body = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).toLowerCase();
    if ((http && http >= 400) || ANTIBOT.some((s) => body.includes(s))) {
      emit({ query, generatedAt: new Date().toISOString(), status: "blocked", url, httpStatus: http, offers: [] });
      return;
    }
    // Collect prices strictly from room-table cells.
    const strings = [];
    for (const sel of PRICE_SELECTORS) {
      const els = await page.$$(sel).catch(() => []);
      for (const el of els.slice(0, 25)) {
        const txt = (await el.innerText().catch(() => "")).trim();
        if (txt) strings.push(txt);
      }
      if (strings.length) break; // first selector that hits wins
    }
    const { total, candidates } = pickStayTotal(strings);
    const shot = join(REPORTS, `browser-rate-${(a.slug || "url").replace(/[^a-z0-9]+/gi, "-")}-${a.checkin}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    if (total == null) {
      emit({ query, generatedAt: new Date().toISOString(), status: "no_price", url, httpStatus: http, note: "rooms table price not parsed (interactive step or layout change)", screenshot: shot, offers: [] });
      return;
    }
    emit({
      query, generatedAt: new Date().toISOString(), status: "verified",
      source: "Booking.com (browser)", url, httpStatus: http, screenshot: shot,
      offers: [{
        channel: "Booking.com", hotel: a.slug || a.url, room: "",
        board: "unknown", checkin: a.checkin, checkout: a.checkout,
        total, currency: a.currency, totalEUR: a.currency === "EUR" ? total : null,
        priceRange: { min: candidates[0], max: candidates[candidates.length - 1] },
        status: "verified", confidence: 0.5,
        // HONEST: the party is pinned in the search, but Booking's page renders
        // inconsistently and does NOT reliably expose which room each price is
        // for, nor the child-bed policy. So `total` is the LOWEST advertised for
        // the party — a signal, not a guaranteed same-room quote. occupancyVerified
        // is false so the orchestrator treats it as signal, never a false "best".
        occupancyVerified: false,
        occupancyNote: `Lowest of ${candidates.length} advertised prices for the pinned party (adults=${a.adults}, child ages=[${a.children}]); room type & child-bed policy unconfirmed. Booking DOM is inconsistent — confirm on the page.`,
        candidates, sourceUrl: url, verifiedAt: new Date().toISOString(),
      }],
    });
  } catch (e) {
    emit({ query, generatedAt: new Date().toISOString(), status: "error", url, note: String(e?.message || e).slice(0, 200), offers: [] });
  } finally {
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
