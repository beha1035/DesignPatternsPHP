#!/usr/bin/env node
import "./lib/net-guard.mjs"; // SSRF guard — installs in THIS process (incl. execFile children)
// discover-hotel — resolve a hotel's per-channel identifiers from just its name +
// city, then cache them so the agent works for ANY hotel, not only hand-seeded
// ones. Focuses on the two PROVEN tiers:
//   • TunisieBooking hotelId  — parsed from the city hotel-list page (id ↔ name).
//   • Google Hotels query     — the hotel name itself (google-hotels-rate searches).
// Booking slug / Trip id are left null (best-effort, resolved manually if needed);
// we never guess an id that would silently query the wrong hotel.
//
//   node discover-hotel.mjs --name "La Cigale Tabarka" --city Tabarka [--slug la-cigale-tabarka]
//   node discover-hotel.mjs --name "..." --city "..." --write   # persist to cache
//
// Output: JSON of the resolved cache entry. With --write, merges it into
// tools/cache/hotel-ids.json under the slug (never clobbering other hotels).

import { smartGet } from "./lib/smart-fetch.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache", "hotel-ids.json");
const TB = "https://tn.tunisiebooking.com";

const emit = (o) => console.log(JSON.stringify(o, null, 2));
const fold = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const sig = (s) => (fold(s).match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2);
const slugify = (s) => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
// TunisieBooking city pages are hotels_<city>.html with an accent-folded slug.
const citySlug = (s) => fold(s).replace(/[^a-z0-9]+/g, "");

function parseArgs(argv) {
  const a = { write: false, ville: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--name") (a.name = v), i++;
    else if (k === "--city") (a.city = v), i++;
    else if (k === "--slug") (a.slug = v), i++;
    else if (k === "--tb-city-slug") (a.tbCitySlug = v), i++;
    else if (k === "--write") a.write = true;
  }
  if (!a.name || !a.city) {
    console.error("Required: --name <hotel> --city <city>");
    process.exit(2);
  }
  a.slug ??= slugify(a.name);
  a.ville = a.city;
  a.tbCitySlug ??= citySlug(a.city);
  return a;
}

// Pull (hotelId -> name) pairs from a TunisieBooking city list page. The hotel
// name follows its detail_hotel_<id> link (in the img alt/title), so search
// FORWARD from the id first — a backward window would bleed into the previous
// hotel's markup and mislabel the id.
function extractPairs(htmlText) {
  const pairs = new Map();
  const re = /detail_hotel_(\d+)/g;
  const find = (win) => {
    for (const pat of [/alt="([^"]{4,60})"/, /title="([^"]{4,60})"/, />([A-Za-zÀ-Ü][^<>]{4,50})</]) {
      const mm = win.match(pat);
      if (mm) return mm[1].trim();
    }
    return null;
  };
  let m;
  while ((m = re.exec(htmlText))) {
    if (pairs.has(m[1])) continue;
    const name = find(htmlText.slice(m.index, m.index + 300)) ||
      find(htmlText.slice(Math.max(0, m.index - 200), m.index));
    pairs.set(m[1], name);
  }
  return pairs;
}

// Match on DISTINCTIVE words only: the city name appears in every hotel on a
// city page, so counting it would tie the wrong hotel (e.g. "La Cigale Tabarka"
// vs "Residence Mehari Tabarka"). Strip city tokens from the wanted set.
// Generic hospitality/article words that must NOT serve as the match anchor —
// otherwise "The Residence" matches "The Penthouse" on "the", or "Dar El Jeld"
// matches "Ezzahra Dar" on "dar". The anchor must be a real brand/name token.
const STOP = new Set([
  "the", "dar", "res", "hotel", "hotels", "resort", "spa", "thalasso", "thalassa",
  "palace", "royal", "grand", "beach", "club", "prestige", "selection", "blu",
  "plaza", "suites", "bay", "and", "les", "des", "sur", "mer", "golf", "aqua",
]);

function bestMatch(pairs, name, city = "") {
  const cityWords = new Set(sig(city));
  const distinct = sig(name).filter((w) => !cityWords.has(w));
  const want = new Set(distinct.length ? distinct : sig(name));
  // Anchor = the query's first DISTINCTIVE, non-generic word (brand/name), e.g.
  // "riu", "cigale", "marhaba", "residence". The matched hotel MUST contain it —
  // otherwise a shared generic word resolves the WRONG hotel. If every word is
  // generic, fall back to the first so we still gate on something.
  const anchor = distinct.find((w) => !STOP.has(w)) || distinct[0] || [...want][0] || null;
  let best = null, bestScore = 0;
  for (const [id, nm] of pairs) {
    if (!nm) continue;
    const words = new Set(sig(nm));
    if (anchor && !words.has(anchor)) continue; // hard gate on the anchor word
    const score = [...want].reduce((n, w) => n + (words.has(w) ? 1 : 0), 0);
    if (score > bestScore) { best = { id, name: nm }; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

async function resolveTunisiebooking(a) {
  const url = `${TB}/hotels_${a.tbCitySlug}.html`;
  const { status, text } = await smartGet(url, { referer: `${TB}/` });
  if (status !== 200) return { ok: false, note: `city list HTTP ${status} at ${url}` };
  const match = bestMatch(extractPairs(text), a.name, a.city);
  if (!match) return { ok: false, note: `no name match for "${a.name}" on ${url}` };
  return { ok: true, hotelId: match.id, matchedName: match.name, ville: a.city, url };
}

async function main() {
  const a = parseArgs(process.argv);
  const tb = await resolveTunisiebooking(a);
  const entry = {
    displayName: a.name,
    city: a.city,
    country: "TN",
    tunisiebooking: tb.ok ? { hotelId: tb.hotelId, ville: tb.ville } : null,
    googleHotels: { query: a.name },
    booking: null,
    trip: null,
    _discovery: { tunisiebooking: tb.ok ? `matched "${tb.matchedName}" (id ${tb.hotelId})` : tb.note },
  };
  if (a.write) {
    let cache = {};
    try { cache = JSON.parse(await readFile(CACHE, "utf8")); } catch {}
    cache[a.slug] = { ...(cache[a.slug] || {}), ...entry };
    await writeFile(CACHE, JSON.stringify(cache, null, 2) + "\n");
  }
  emit({ slug: a.slug, status: tb.ok ? "resolved" : "partial", written: a.write, entry });
  if (!tb.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
export { extractPairs, bestMatch, slugify, citySlug };
