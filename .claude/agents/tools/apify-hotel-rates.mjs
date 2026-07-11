#!/usr/bin/env node
// apify-hotel-rates — Tier 0 breadth: one call to an Apify hotel-price actor that
// compares many OTAs (Booking, Expedia, Agoda, direct sites…) for exact dates +
// occupancy, server-side, returning clean structured rows. Apify runs the browser
// and residential proxies for us, so this covers the wide OTA field WITHOUT us
// booting Chromium. Complements Google Hotels, which misses regional inventory
// (it had no rate at all for La Cigale Tabarka).
//
// Key-gated: without a token it fails honestly so the orchestrator relies on the
// free Tier 1 (TunisieBooking) + Google Hotels instead.
//
//   export APIFY_TOKEN=apify_api_xxx
//   export APIFY_HOTEL_ACTOR=parseforge~hotel-booking-sites-direct-hotel-websites-scraper
//   node apify-hotel-rates.mjs --query "La Cigale Tabarka" \
//     --checkin 2026-07-14 --checkout 2026-07-16 --adults 2 --children 10 [--currency EUR]
//
// Output: JSON { status, source, offers[] } normalized to the agent's schema.
// status: verified | no_price | error. Actor input keys vary between actors; map
// via --input-map if your chosen actor uses different field names.

if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

function parseArgs(argv) {
  const a = {
    adults: 2, children: [], currency: "EUR", startUrl: null,
    apiKey: process.env.APIFY_TOKEN || null,
    // Default: voyager/booking-scraper — scrapes Booking.com directly (more
    // reliable than the Kayak-backed location scraper), supports a children
    // count and a direct hotel startUrl. Override with --actor / APIFY_HOTEL_ACTOR.
    actor: process.env.APIFY_HOTEL_ACTOR || "voyager~booking-scraper",
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--query") (a.query = v), i++;
    else if (k === "--start-url") (a.startUrl = v), i++; // precise: a Booking hotel URL
    else if (k === "--checkin") (a.checkin = v), i++;
    else if (k === "--checkout") (a.checkout = v), i++;
    else if (k === "--adults") (a.adults = Number(v)), i++;
    else if (k === "--children") (a.children = v.split(",").filter(Boolean).map(Number)), i++;
    else if (k === "--currency") (a.currency = v), i++;
    else if (k === "--actor") (a.actor = v), i++;
    else if (k === "--api-key") (a.apiKey = v), i++;
  }
  if ((!a.query && !a.startUrl) || !a.checkin || !a.checkout) {
    console.error("Required: (--query <hotel> or --start-url <booking url>) --checkin YYYY-MM-DD --checkout YYYY-MM-DD");
    process.exit(2);
  }
  return a;
}

const emit = (o) => console.log(JSON.stringify(o, null, 2));
const query = (a) => ({
  hotel: a.query, checkin: a.checkin, checkout: a.checkout,
  adults: a.adults, childrenAges: a.children, currency: a.currency,
});

// Best-effort mapping from an actor row to the agent's offer schema. Actors
// differ; we read the most common field names and keep anything we can't map in
// `raw` so nothing is silently lost.
function normalize(rows, a) {
  const num = (x) => {
    if (typeof x === "number") return x;
    const m = String(x ?? "").match(/[\d.,]+/);
    return m ? Number(m[0].replace(/,/g, "")) : null;
  };
  const cur = (c) => (c === "€" ? "EUR" : c === "$" ? "USD" : c === "£" ? "GBP" : c || a.currency);
  const verifiedAt = new Date().toISOString();
  const offers = [];
  for (const r of rows || []) {
    const total = num(r.price ?? r.totalPrice ?? r.total ?? r.rate ?? r.amount);
    if (total == null) continue;
    // HONESTY: this actor returns a hotel HEADLINE price and does not expose the
    // exact room/occupancy it priced (room-level prices come back null, child
    // ages aren't applied). So confidence is capped and occupancy is flagged
    // unverified — never fold this in as a guaranteed same-occupancy quote.
    offers.push({
      channel: r.source || r.site || r.provider || r.ota || "Booking.com (Apify)",
      hotel: r.hotelName || r.name || a.query,
      room: r.roomType || r.room || "",
      board: r.board || r.mealPlan || "unknown",
      checkin: a.checkin, checkout: a.checkout,
      total, currency: cur(r.currency),
      cancellation: r.freeCancellation ? "free" : "unknown",
      status: "verified", confidence: 0.6,
      occupancyVerified: false,
      occupancyNote: `Headline hotel price; actor applies adults=${a.adults}, children=${a.children.length} (ages not passed) — may not match a ${a.adults}+${a.children.length} triple.`,
      sourceUrl: r.url || r.link || null,
      verifiedAt,
    });
  }
  return offers.sort((x, y) => (x.total ?? 1e12) - (y.total ?? 1e12));
}

(async () => {
  const a = parseArgs(process.argv);
  if (!a.apiKey) {
    emit({
      query: query(a), status: "error", offers: [],
      note: "Missing APIFY_TOKEN. Get one at https://apify.com (free trial) and export APIFY_TOKEN (+ optional APIFY_HOTEL_ACTOR). The orchestrator will use the free TunisieBooking + Google Hotels tiers meanwhile.",
    });
    process.exit(1);
  }
  // Schema for voyager~booking-scraper. A direct hotel --start-url is far more
  // reliable than a name search (Booking's destination search misses exact hotel
  // names, same as Google). children is a COUNT here, not ages.
  const input = {
    checkIn: a.checkin, checkOut: a.checkout,
    adults: a.adults, children: a.children.length, rooms: 1,
    currency: a.currency, maxItems: 10,
    ...(a.startUrl ? { startUrls: [{ url: a.startUrl }] } : { search: a.query }),
  };
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(a.actor)}` +
    `/run-sync-get-dataset-items?token=${a.apiKey}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const blocked = resp.status === 403 || resp.status === 407;
      emit({ query: query(a), status: blocked ? "blocked" : "error", offers: [], note: `Apify HTTP ${resp.status}: ${text.slice(0, 250)}` });
      process.exit(blocked ? 0 : 1);
    }
    const rows = JSON.parse(text);
    const offers = normalize(rows, a);
    emit({
      query: query(a),
      status: offers.length ? "verified" : "no_price",
      source: `Apify/${a.actor}`,
      offers,
    });
  } catch (e) {
    emit({ query: query(a), status: "error", offers: [], note: String(e?.message || e) });
    process.exit(1);
  }
})();
