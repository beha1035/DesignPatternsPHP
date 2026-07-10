#!/usr/bin/env node
// amadeus-rate — verified hotel prices via the Amadeus Self-Service Hotel Search
// API. This is the *preferred* validation path: structured data, taxes broken
// out, no anti-bot 403. Use it instead of scraping wherever the hotel is in
// Amadeus's inventory; fall back to validate-rate.mjs for channels without an API.
//
// Setup (one-time, free): create an app at https://developers.amadeus.com,
// then export credentials:
//   export AMADEUS_CLIENT_ID=xxxx
//   export AMADEUS_CLIENT_SECRET=xxxx
//
// Usage:
//   node amadeus-rate.mjs --checkin 2026-07-15 --checkout 2026-07-17 \
//     --adults 2 --children 10 [--currency EUR] [--city TBJ] \
//     [--hotel-ids XXXX,YYYY] [--prod]
//
// Occupancy: at La Cigale a child 2+ is billed as an adult, and the v3 offers
// endpoint keys pricing on `adults`, so children 2+ are folded into the adult
// count (the real ages are reported in the query echo).
//
// Output: one JSON object on stdout matching the agent's offer schema, with
// status "verified" and a high confidence for live-read prices. Never fabricates:
// network/credential/egress failures are reported as status "error"/"blocked".
//
// Network: Node's global fetch only honours HTTPS_PROXY when run with
// NODE_USE_ENV_PROXY=1 (Node >= 22.21), and the proxy CA must be trusted via
// NODE_EXTRA_CA_CERTS. This script sets sensible defaults if they are unset.

import { readFileSync } from "node:fs";

// --- proxy / TLS defaults for this class of environment ---------------------
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";
// (NODE_EXTRA_CA_CERTS must be set BEFORE node starts to take effect for TLS;
// we surface a hint if it is missing rather than pretend it is applied.)
const CA = "/root/.ccr/ca-bundle.crt";
let caHint = null;
if (!process.env.NODE_EXTRA_CA_CERTS) {
  try {
    readFileSync(CA);
    caHint = `Tip: re-run with NODE_EXTRA_CA_CERTS=${CA} if TLS verification fails.`;
  } catch {}
}

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { adults: 2, children: [], currency: "EUR", city: "TBJ", hotelIds: null, prod: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--checkin") (a.checkin = v), i++;
    else if (k === "--checkout") (a.checkout = v), i++;
    else if (k === "--adults") (a.adults = Number(v)), i++;
    else if (k === "--children") (a.children = v.split(",").filter(Boolean).map(Number)), i++;
    else if (k === "--currency") (a.currency = v), i++;
    else if (k === "--city") (a.city = v), i++;
    else if (k === "--hotel-ids") (a.hotelIds = v.split(",").filter(Boolean)), i++;
    else if (k === "--prod") a.prod = true;
  }
  if (!a.checkin || !a.checkout) {
    console.error("Required: --checkin YYYY-MM-DD --checkout YYYY-MM-DD");
    process.exit(2);
  }
  return a;
}

const fail = (query, note, status = "error") => {
  console.log(JSON.stringify({ query, generatedAt: new Date().toISOString(), status, note, offers: [] }, null, 2));
  process.exit(status === "error" ? 1 : 0);
};

// --- Amadeus client ---------------------------------------------------------
async function getToken(base, id, secret) {
  const resp = await fetch(`${base}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!resp.ok) throw new Error(`token ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return (await resp.json()).access_token;
}

async function hotelsByCity(base, token, cityCode) {
  const url = `${base}/v1/reference-data/locations/hotels/by-city?cityCode=${encodeURIComponent(cityCode)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`hotel-list ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()).data || [];
  // Prefer La Cigale if present; otherwise return all ids for the caller.
  const cigale = data.filter((h) => /cigale/i.test(h.name || ""));
  return (cigale.length ? cigale : data).map((h) => h.hotelId);
}

async function offers(base, token, q) {
  const foldedAdults = q.adults + q.children.filter((a) => a >= 2).length;
  const params = new URLSearchParams({
    hotelIds: q.hotelIds.join(","),
    checkInDate: q.checkin,
    checkOutDate: q.checkout,
    adults: String(foldedAdults),
    roomQuantity: "1",
    currency: q.currency,
    bestRateOnly: "true",
  });
  const resp = await fetch(`${base}/v3/shopping/hotel-offers?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`offers ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return (await resp.json()).data || [];
}

// Map Amadeus offers to the agent's normalized offer schema.
function normalize(rawList, q) {
  const boardMap = { ROOM_ONLY: "room_only", BREAKFAST: "breakfast", HALF_BOARD: "half_board",
                     FULL_BOARD: "full_board", ALL_INCLUSIVE: "all_inclusive" };
  const out = [];
  for (const entry of rawList) {
    const name = entry.hotel?.name || "";
    for (const o of entry.offers || []) {
      const total = Number(o.price?.total);
      const cur = o.price?.currency || q.currency;
      out.push({
        channel: "Amadeus",
        hotel: name,
        room: o.room?.typeEstimated?.category || o.room?.type || "",
        board: boardMap[o.boardType] || (o.boardType || "").toLowerCase() || "unknown",
        checkin: q.checkin,
        checkout: q.checkout,
        total, currency: cur,
        totalEUR: cur === "EUR" ? total : null,
        totalTND: cur === "TND" ? total : null,
        cancellation: o.policies?.cancellations?.length ? "has_policy" : "unknown",
        status: "verified",
        confidence: 0.95,
        sourceUrl: "https://developers.amadeus.com",
        offerId: o.id,
        verifiedAt: new Date().toISOString(),
      });
    }
  }
  return out.sort((a, b) => (a.total || 1e12) - (b.total || 1e12));
}

// --- main -------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv);
  const query = {
    hotel: "La Cigale Tabarka",
    checkin: args.checkin, checkout: args.checkout,
    adults: args.adults, childrenAges: args.children, currency: args.currency,
  };
  const id = process.env.AMADEUS_CLIENT_ID;
  const secret = process.env.AMADEUS_CLIENT_SECRET;
  if (!id || !secret) {
    fail(query, "Missing AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET. Create a free app at https://developers.amadeus.com", "error");
  }
  const base = args.prod ? "https://api.amadeus.com" : "https://test.api.amadeus.com";

  try {
    const token = await getToken(base, id, secret);
    let hotelIds = args.hotelIds;
    if (!hotelIds) hotelIds = await hotelsByCity(base, token, args.city);
    if (!hotelIds.length) fail(query, `No hotels found for city ${args.city}; pass --hotel-ids explicitly.`, "error");
    const raw = await offers(base, token, { ...args, hotelIds });
    const normalized = normalize(raw, args);
    console.log(JSON.stringify({
      query, generatedAt: new Date().toISOString(),
      status: normalized.length ? "verified" : "no_price",
      base, hotelIds, offers: normalized,
    }, null, 2));
  } catch (e) {
    const msg = String(e?.message || e);
    // A proxy 403 on CONNECT surfaces as a fetch failure; flag it as blocked.
    const blocked = /403|407|ENOTFOUND|ECONNREFUSED|fetch failed|tunnel/i.test(msg);
    fail(query, `${msg}${caHint ? " | " + caHint : ""}`, blocked ? "blocked" : "error");
  }
})();
