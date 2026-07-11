#!/usr/bin/env node
// google-hotels-rate — verified dated hotel prices via SerpApi's Google Hotels
// engine. This is the PREFERRED validation path (Amadeus Self-Service is being
// decommissioned 2026-07-17). Google Hotels aggregates OTA + direct rates for
// exact dates + occupancy, with no anti-bot 403.
//
// Setup (self-service): create a key at https://serpapi.com (free trial, then
// paid), then:
//   export SERPAPI_KEY=xxxx           # or pass --api-key xxxx
//
// Usage:
//   node google-hotels-rate.mjs --checkin 2026-07-15 --checkout 2026-07-17 \
//     --adults 2 --children 10 [--currency EUR] [--query "La Cigale Tabarka"] \
//     [--location "Tabarka"] [--gl tn] [--hl fr] [--property-token TOKEN]
//
// If the exact --query returns no property, we retry with "<query> hotel" and a
// "hotels <place>" destination search (place = --location or the query's last
// word), then fuzzy-match by name. Note: Google Hotels rejects some currencies
// (e.g. TND) — use EUR/USD. TND-only resorts may also have no dated rate at all.
//
// Output: one JSON object on stdout matching the agent's offer schema, with
// status "verified" for live-read prices. Never fabricates: missing key /
// network / no-match are reported as status error|blocked|no_price.
//
// Network: Node global fetch honours HTTPS_PROXY only with NODE_USE_ENV_PROXY=1
// (Node >= 22.21) and needs the proxy CA via NODE_EXTRA_CA_CERTS. The
// SessionStart hook sets both; we also default NODE_USE_ENV_PROXY here.

if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

const BASE = "https://serpapi.com/search.json";

function parseArgs(argv) {
  const a = {
    adults: 2, children: [], currency: "EUR",
    query: "La Cigale Tabarka", location: null, gl: "tn", hl: "fr",
    apiKey: process.env.SERPAPI_KEY || null, propertyToken: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--checkin") (a.checkin = v), i++;
    else if (k === "--checkout") (a.checkout = v), i++;
    else if (k === "--adults") (a.adults = Number(v)), i++;
    else if (k === "--children") (a.children = v.split(",").filter(Boolean).map(Number)), i++;
    else if (k === "--currency") (a.currency = v), i++;
    else if (k === "--query") (a.query = v), i++;
    else if (k === "--location") (a.location = v), i++;
    else if (k === "--gl") (a.gl = v), i++;
    else if (k === "--hl") (a.hl = v), i++;
    else if (k === "--api-key") (a.apiKey = v), i++;
    else if (k === "--property-token") (a.propertyToken = v), i++;
  }
  if (!a.checkin || !a.checkout) {
    console.error("Required: --checkin YYYY-MM-DD --checkout YYYY-MM-DD");
    process.exit(2);
  }
  return a;
}

const emit = (o) => console.log(JSON.stringify(o, null, 2));
const fail = (query, note, status = "error") => {
  emit({ query, generatedAt: new Date().toISOString(), status, note, offers: [] });
  process.exit(status === "error" ? 1 : 0);
};

function buildParams(a, extra = {}) {
  const p = new URLSearchParams({
    engine: "google_hotels",
    check_in_date: a.checkin,
    check_out_date: a.checkout,
    adults: String(a.adults),
    currency: a.currency,
    gl: a.gl,
    hl: a.hl,
    api_key: a.apiKey,
    ...extra,
  });
  if (a.children.length) {
    p.set("children", String(a.children.length));
    p.set("children_ages", a.children.join(","));
  }
  return p;
}

async function call(params) {
  const resp = await fetch(`${BASE}?${params}`);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`serpapi ${resp.status}: ${text.slice(0, 250)}`);
  const json = JSON.parse(text);
  if (json.error) throw new Error(`serpapi error: ${json.error}`);
  return json;
}

const num = (x) =>
  typeof x === "number" ? x : x && typeof x.extracted_lowest === "number" ? x.extracted_lowest : null;

// Significant (accent-folded, >2 char) words for fuzzy name/query matching.
const sig = (s) =>
  ((s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 2);

// How many query words appear in a property name.
function matchScore(name, qWords) {
  const nameWords = new Set(sig(name));
  return qWords.reduce((n, w) => n + (nameWords.has(w) ? 1 : 0), 0);
}

// Find the property. Google Hotels is picky: an exact hotel-name query often
// returns 0 results while a broader ("... hotel") or destination ("hotels
// <place>") query returns it. Try each in turn, fuzzy-matching by query words.
async function findProperty(a) {
  const qWords = sig(a.query);
  const place = a.location || a.query.split(/\s+/).slice(-1)[0]; // last token as a hint
  const seen = new Set();
  const candidates = [a.query, `${a.query} hotel`, `hotels ${place}`].filter(
    (q) => q && !seen.has(q) && seen.add(q)
  );
  for (const q of candidates) {
    const props = (await call(buildParams(a, { q }))).properties || [];
    if (!props.length) continue;
    let best = null, bestScore = 0;
    for (const p of props) {
      const s = matchScore(p.name, qWords);
      if (s > bestScore) (best = p), (bestScore = s);
    }
    // A positive word-overlap means a real match; otherwise widen the query.
    if (best && bestScore > 0) return { match: best, via: q };
    // Exact single-candidate case with no overlap: accept the top result.
    if (candidates.length === 1) return { match: props[0], via: q };
  }
  return { match: null, via: null };
}

// Map a Google Hotels property's per-source prices to the agent's offer schema.
function normalize(prop, a) {
  const offers = [];
  const verifiedAt = new Date().toISOString();
  const push = (source, total, extra = {}) => {
    if (total == null) return;
    offers.push({
      channel: source || "Google Hotels",
      hotel: prop.name || a.query,
      room: extra.room || "",
      board: "unknown", // Google Hotels rarely exposes meal plan
      checkin: a.checkin, checkout: a.checkout,
      total, currency: a.currency,
      totalEUR: a.currency === "EUR" ? total : null,
      totalTND: a.currency === "TND" ? total : null,
      cancellation: extra.free_cancellation ? "free" : "unknown",
      status: "verified", confidence: 0.9,
      sourceUrl: extra.link || prop.link || "https://www.google.com/travel/hotels",
      verifiedAt,
    });
  };
  // Featured (usually direct + top OTAs) with room-level totals.
  for (const fp of prop.featured_prices || []) {
    const t = num(fp.total_rate) ?? num((fp.rooms || [])[0]?.total_rate);
    push(fp.source, t, { link: fp.link, free_cancellation: fp.free_cancellation });
  }
  // All aggregated sources.
  for (const p of prop.prices || []) {
    push(p.source, num(p.total_rate) ?? num(p.rate_per_night), {
      link: p.link, free_cancellation: p.free_cancellation,
    });
  }
  // Fallback: the property headline total.
  if (offers.length === 0) push("Google Hotels", num(prop.total_rate), { link: prop.link });
  // Dedupe by channel keeping the lowest total.
  const best = new Map();
  for (const o of offers) {
    const cur = best.get(o.channel);
    if (!cur || (o.total ?? 1e12) < (cur.total ?? 1e12)) best.set(o.channel, o);
  }
  return [...best.values()].sort((x, y) => (x.total ?? 1e12) - (y.total ?? 1e12));
}

(async () => {
  const a = parseArgs(process.argv);
  const query = {
    hotel: a.query, checkin: a.checkin, checkout: a.checkout,
    adults: a.adults, childrenAges: a.children, currency: a.currency,
  };
  if (!a.apiKey) {
    fail(query, "Missing SERPAPI_KEY (or --api-key). Create a key at https://serpapi.com", "error");
  }
  try {
    let property;
    if (a.propertyToken) {
      // The google_hotels engine requires `q` even alongside property_token.
      property = await call(buildParams(a, { q: a.query, property_token: a.propertyToken }));
    } else {
      const { match, via } = await findProperty(a);
      if (!match) {
        fail(
          query,
          `No property found for "${a.query}" (tried the exact name, "… hotel", and a "hotels <place>" fallback). Try --query with the full hotel name, or --location "<city>".`,
          "no_price"
        );
      }
      // Re-query with the property_token (plus the q that surfaced it) for full
      // per-source pricing.
      property = match.property_token
        ? await call(buildParams(a, { q: via, property_token: match.property_token }))
        : match;
    }
    const offers = normalize(property, a);
    emit({
      query, generatedAt: new Date().toISOString(),
      status: offers.length ? "verified" : "no_price",
      source: "SerpApi/Google Hotels",
      hotel: property.name || a.query,
      offers,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Unsupported .* for currency/i.test(msg)) {
      fail(
        query,
        `Google Hotels does not support currency "${a.currency}" (e.g. TND is unsupported). Re-run with --currency EUR or USD and convert afterwards.`,
        "error"
      );
    }
    const blocked = /403|407|ENOTFOUND|ECONNREFUSED|fetch failed|tunnel|allowlist/i.test(msg);
    fail(query, msg, blocked ? "blocked" : "error");
  }
})();
