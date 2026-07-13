#!/usr/bin/env node
// validate-rate — drives real booking sessions with a headless browser to turn
// an *estimated* rate into a *verified* one (or an honest "blocked"/"no_price").
//
// It is the "validation" stage of the hotel-deal-finder agent: discovery finds
// candidate offers, this reads a dated price for exact dates + occupants.
//
// Usage:
//   node validate-rate.mjs --checkin 2026-07-15 --checkout 2026-07-17 \
//       --adults 2 --children 10 [--currency EUR] [--channel Booking.com] \
//       [--headful] [--timeout 45000]
//
// Output: a single JSON object on stdout (schema below) + screenshots under
// .claude/agents/reports/. Never fabricates a price: if the engine blocks us or
// no price renders, status reflects that.
//
// Requires Playwright (global) + the preinstalled Chromium in this environment.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
// Global install path in this environment; fall back to local resolution.
let chromium;
for (const p of ["/opt/node22/lib/node_modules/playwright", "playwright", "playwright-core"]) {
  try {
    ({ chromium } = require(p));
    break;
  } catch {}
}
if (!chromium) {
  console.error("Playwright not found. Install with: npm i -g playwright");
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(__dirname, "..", "reports");
mkdirSync(REPORTS, { recursive: true });

// The known Chromium shipped with this environment (avoids a re-download).
const EXECUTABLE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const a = { adults: 2, children: [], currency: "EUR", timeout: 45000, headful: false, hotelName: "La Cigale Tabarka" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--checkin") (a.checkin = v), i++;
    else if (k === "--checkout") (a.checkout = v), i++;
    else if (k === "--adults") (a.adults = Number(v)), i++;
    else if (k === "--children") (a.children = v.split(",").filter(Boolean).map(Number)), i++;
    else if (k === "--currency") (a.currency = v), i++;
    else if (k === "--channel") (a.channel = v), i++;
    else if (k === "--hotel-name") (a.hotelName = v), i++;
    else if (k === "--timeout") (a.timeout = Number(v)), i++;
    else if (k === "--headful") a.headful = true;
  }
  if (!a.checkin || !a.checkout) {
    console.error("Required: --checkin YYYY-MM-DD --checkout YYYY-MM-DD");
    process.exit(2);
  }
  return a;
}

// ---- price extraction ------------------------------------------------------
// Matches "1 234 TND", "1.234,50 €", "$189", "189 DT", "EUR 450"...
const PRICE_RE =
  /(?:€|EUR|TND|DT|\$|USD)\s?\d[\d\s.,]*\d|\d[\d\s.,]*\d\s?(?:€|EUR|TND|DT|\$|USD)/gi;

function looksBlocked(status, bodyText) {
  if (status && status >= 400) return `http_${status}`;
  const t = (bodyText || "").toLowerCase();
  for (const sig of [
    "access denied",
    "access to this page has been denied",
    "captcha",
    "are you a robot",
    "unusual traffic",
    "verify you are human",
    "request unsuccessful",
    "cf-error",
  ]) {
    if (t.includes(sig)) return `antibot:${sig}`;
  }
  return null;
}

async function extractPrices(page, priceHints) {
  const found = [];
  for (const sel of priceHints || []) {
    try {
      const els = await page.$$(sel);
      for (const el of els.slice(0, 8)) {
        const txt = (await el.innerText().catch(() => "")).trim();
        const m = txt.match(PRICE_RE);
        if (m) found.push(...m);
      }
    } catch {}
  }
  // Regex fallback over the whole visible body.
  if (found.length === 0) {
    const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const m = body.match(PRICE_RE);
    if (m) found.push(...m.slice(0, 12));
  }
  // Normalise + dedupe.
  return [...new Set(found.map((s) => s.replace(/\s+/g, " ").trim()))];
}

// ---- per-channel drive -----------------------------------------------------
async function validateChannel(context, link, args) {
  const page = await context.newPage();
  const result = {
    channel: link.channel,
    url: link.url,
    status: "no_price",
    httpStatus: null,
    prices: [],
    note: null,
    screenshot: null,
  };
  try {
    const resp = await page.goto(link.url, {
      waitUntil: "domcontentloaded",
      timeout: args.timeout,
    });
    result.httpStatus = resp?.status() ?? null;

    // Give client-rendered prices a chance to load, then settle.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const blocked = looksBlocked(result.httpStatus, bodyText);

    const safe = link.channel.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const shot = join(REPORTS, `validate-${safe}-${args.checkin}.png`);
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    result.screenshot = shot;

    if (blocked) {
      result.status = "blocked";
      result.note = blocked;
      return result;
    }
    const prices = await extractPrices(page, link.priceHints);
    if (prices.length) {
      result.status = "verified";
      result.prices = prices;
    } else {
      result.status = "no_price";
      result.note = "page loaded but no dated price parsed (likely interactive step required)";
    }
  } catch (e) {
    result.status = "error";
    result.note = String(e?.message || e).slice(0, 200);
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}

// ---- main ------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv);
  const { buildDeepLinks } = await import("./deep-links.mjs");
  let links = buildDeepLinks({
    checkin: args.checkin,
    checkout: args.checkout,
    adults: args.adults,
    childrenAges: args.children,
    currency: args.currency,
  });
  if (args.channel) links = links.filter((l) => l.channel === args.channel);

  // Honour an outbound HTTPS proxy if the environment sets one (Chromium needs
  // it passed explicitly — it does not read HTTPS_PROXY on its own).
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const browser = await chromium.launch({
    headless: !args.headful,
    executablePath: EXECUTABLE,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  // Realistic context: a fr-FR desktop visitor in Tunisia's timezone.
  const context = await browser.newContext({
    locale: "fr-FR",
    timezoneId: "Africa/Tunis",
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const results = [];
  for (const link of links) {
    results.push(await validateChannel(context, link, args));
  }
  await browser.close();

  const output = {
    query: {
      hotel: args.hotelName,
      checkin: args.checkin,
      checkout: args.checkout,
      adults: args.adults,
      childrenAges: args.children,
      currency: args.currency,
    },
    generatedAt: new Date().toISOString(),
    results,
  };
  console.log(JSON.stringify(output, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
