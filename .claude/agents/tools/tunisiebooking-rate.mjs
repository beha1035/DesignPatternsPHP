#!/usr/bin/env node
import "./lib/net-guard.mjs"; // SSRF guard — installs in THIS process (incl. execFile children)
// tunisiebooking-rate — verified dated hotel prices from TunisieBooking WITHOUT a
// browser. TunisieBooking is a top channel for Tunisian resorts (it carried the
// cheapest verified rate for La Cigale Tabarka) yet is invisible to Google
// Hotels. Its "403 anti-bot" is a myth: with realistic headers its own pricing
// endpoint answers in ~2s and embeds every room's total in hidden <input>s.
//
// Flow (all plain HTTP GET, no JS engine):
//   traitement_detailv_contre_proposition_new_v4.php
//     ?id_hotel_xml=<id>&ville=<ville>&chambres=1&session=   (empty -> bootstrap)
//     &DOPBookingSystem_CheckIn1=DD/MM/YYYY&nbr_nuit=N
//     &adultes1=A&enfants1=C&age1_1=..  (occupancy for room 1)
//   -> "sucess###<html>" whose hidden inputs price_<meal>_<opt>_<room> = TND total
//      per room option; the page's own JS just sums the cheapest per room + 2% fee.
//
// Usage:
//   node tunisiebooking-rate.mjs --checkin 2026-07-14 --checkout 2026-07-16 \
//     --adults 2 --children 10 [--hotel-id 354] [--ville Tabarka] [--rooms 1]
//
// Output: one JSON object on stdout in the agent's offer schema. Honest status:
// verified | no_price | blocked | error. Never fabricates a price.

import { smartGet, classifyError } from "./lib/smart-fetch.mjs";

const HOST = "https://tn.tunisiebooking.com";
const ENDPOINT = `${HOST}/theme/traitement_detailv_contre_proposition_new_v4.php`;
// Meal codes TunisieBooking uses; lpd = Logement Petit Déjeuner (B&B).
const MEAL = { lpd: "breakfast", dp: "half-board", pension: "full-board", ai: "all-inclusive" };
const BOOKING_FEE = 0.02; // 2% "frais de dossier" the site adds on top.

function parseArgs(argv) {
  const a = { adults: 2, children: [], hotelId: "354", ville: "Tabarka", rooms: 1, boards: ["lpd", "dp"] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--checkin") (a.checkin = v), i++;
    else if (k === "--checkout") (a.checkout = v), i++;
    else if (k === "--adults") (a.adults = Number(v)), i++;
    else if (k === "--children") (a.children = v.split(",").filter(Boolean).map(Number)), i++;
    else if (k === "--hotel-id") (a.hotelId = v), i++;
    else if (k === "--ville") (a.ville = v), i++;
    else if (k === "--rooms") (a.rooms = Number(v)), i++;
    else if (k === "--boards") (a.boards = v.split(",").filter(Boolean)), i++;
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

// ISO YYYY-MM-DD -> DD/MM/YYYY (the format the endpoint expects).
const toFr = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const nights = (ci, co) =>
  Math.round((Date.parse(co) - Date.parse(ci)) / 86400000);

// Build the occupancy params. All guests go into room 1 by default; children 2+
// are billed as adults here but the engine still wants their real ages.
function occupancyParams(a) {
  const p = new URLSearchParams();
  p.set("adultes1", String(a.adults));
  p.set("enfants1", String(a.children.length));
  a.children.forEach((age, i) => p.set(`age1_${i + 1}`, String(age)));
  return p;
}

function buildUrl(a, n, formule = "") {
  const p = new URLSearchParams({
    id_hotel_xml: a.hotelId, formule, integrateur: "", token: "",
    session: "", type_chambre: "", testmodif: "0", ville: a.ville,
    chambres: String(a.rooms),
    DOPBookingSystem_CheckIn1: toFr(a.checkin), nbr_nuit: String(n),
  });
  for (const [k, v] of occupancyParams(a)) p.set(k, v);
  return `${ENDPOINT}?${p}`;
}

// Parse the hidden price_<meal>_<opt>_<room> inputs and the room labels the
// radio buttons carry (value="meal@@opt@@Label@@..@@code@@offerId").
export function parseOffers(htmlText, a, n) {
  const rooms = new Map(); // opt -> {label}
  const roomRe =
    /value="(lpd|dp|pension|ai)@@(\d+)@@([^@]+?)@@[^"]*"/gi;
  let m;
  while ((m = roomRe.exec(htmlText))) {
    if (!rooms.has(m[2])) rooms.set(m[2], m[3].trim());
  }
  const priceRe = /name="price_(lpd|dp|pension|ai)_(\d+)_(\d+)"\s+value="([0-9.]+)"/gi;
  // total[meal][roomIndex] = min option price for that room under that meal.
  const totals = {};
  while ((m = priceRe.exec(htmlText))) {
    const meal = m[1], opt = m[2], roomIdx = m[3], val = Number(m[4]);
    if (!val) continue;
    totals[meal] ??= {};
    const cur = totals[meal][roomIdx];
    if (cur == null || val < cur.price) totals[meal][roomIdx] = { price: val, opt };
  }
  const offers = [];
  const verifiedAt = new Date().toISOString();
  for (const meal of Object.keys(totals)) {
    // Sum the cheapest option across all rooms for a whole-stay total.
    const perRoom = Object.values(totals[meal]);
    if (!perRoom.length) continue;
    const base = perRoom.reduce((s, r) => s + r.price, 0);
    const total = Math.round(base * (1 + BOOKING_FEE));
    // Label from room 1's cheapest option (rooms default to 1; for multi-room
    // this is the first room's type — the total above still sums all rooms).
    const cheapestOpt = totals[meal]["1"]?.opt;
    offers.push({
      channel: "TunisieBooking",
      hotel: `hotel_${a.hotelId}`,
      room: rooms.get(cheapestOpt) || "",
      board: MEAL[meal] || meal,
      checkin: a.checkin, checkout: a.checkout, nights: n,
      total, currency: "TND",
      totalTND: total, totalEUR: null,
      baseBeforeFee: base, feePct: BOOKING_FEE * 100,
      cancellation: "unknown",
      status: "verified", confidence: 0.9,
      sourceUrl: `${HOST}/detail_hotel_${a.hotelId}/`,
      verifiedAt,
    });
  }
  return offers.sort((x, y) => x.total - y.total);
}

// Canary: the endpoint said "sucess" and rendered room radios, yet we parsed no
// price. That is almost always the site changing its markup — a DRIFT we must
// shout about, not a silent "no_price" that would hide a broken parser.
const SUCCESS_RE = /sucess###/i;
const ROOM_ANY_RE = /value="(?:lpd|dp|pension|ai)@@\d+@@/i;
export function classify(text, offers) {
  if (/failure###/i.test(text.slice(0, 80))) return "no_price";
  if (offers.length) return "verified";
  if (SUCCESS_RE.test(text) && ROOM_ANY_RE.test(text)) return "drift";
  return "no_price";
}

// Pure, testable core: HTML text -> normalized result. No network, no process.
export function analyze(text, a, n) {
  const offers = parseOffers(text, a, n);
  const status = classify(text, offers);
  const note =
    status === "drift"
      ? "DRIFT: TunisieBooking returned rooms but no parseable price_* field — markup likely changed. Do NOT trust a missing price as sold-out; update the parser."
      : status === "verified"
      ? `Totals include ${BOOKING_FEE * 100}% booking fee.`
      : status === "no_price"
      ? "No priced room for these dates/occupancy."
      : "";
  return { status, note, offers };
}

async function main() {
  const a = parseArgs(process.argv);
  const n = nights(a.checkin, a.checkout);
  const query = {
    hotel: `TunisieBooking hotel ${a.hotelId} (${a.ville})`,
    checkin: a.checkin, checkout: a.checkout, nights: n,
    adults: a.adults, childrenAges: a.children, currency: "TND",
  };
  if (!(n > 0)) fail(query, "checkout must be after checkin", "error");
  try {
    // One request per board (lpd=B&B, dp=half-board, …); merge the offers.
    const results = await Promise.all(
      a.boards.map(async (b) => {
        const { status: http, text } = await smartGet(buildUrl(a, n, b), {
          xhr: true, referer: `${HOST}/detail_hotel_${a.hotelId}/`,
        });
        if (http !== 200) return { status: classifyError(http), offers: [] };
        return analyze(text, a, n);
      })
    );
    const offers = results.flatMap((r) => r.offers).sort((x, y) => x.total - y.total);
    const drift = results.some((r) => r.status === "drift");
    const status = offers.length ? "verified" : drift ? "drift" : "no_price";
    emit({
      query, generatedAt: new Date().toISOString(),
      status, source: "TunisieBooking (browserless)",
      note: status === "drift"
        ? "DRIFT: rooms rendered but no parseable price — TunisieBooking markup likely changed."
        : status === "verified"
        ? `Totals include ${BOOKING_FEE * 100}% booking fee. Boards: ${a.boards.join(", ")}.`
        : "No priced room for these dates/occupancy.",
      offers,
    });
    if (status === "drift") process.exit(3); // non-zero so callers/CI notice.
  } catch (e) {
    const msg = String(e?.message || e);
    fail(query, msg, classifyError(msg));
  }
}

// Only run when executed directly, so tests can import analyze()/parseOffers().
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
