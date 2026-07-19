#!/usr/bin/env node
import "./lib/net-guard.mjs"; // SSRF guard — installs in THIS process (incl. execFile children)
// find-best-rate — the cascade orchestrator. Runs the rate tiers cheapest-first
// and only escalates when needed, so the browser (or a paid unblocker) is the
// LAST resort, not the default:
//
//   Tier 0  structured APIs   google-hotels-rate.mjs  (+ apify-hotel-rates.mjs if APIFY_TOKEN)
//   Tier 1  browserless HTTP  tunisiebooking-rate.mjs (proven ~2s, free)
//   Tier 2  managed unblocker brightdata-unlock.mjs   (only for gaps; needs key)
//   Tier 3  self-hosted browser browser-rate.mjs      (occupancy-pinned Booking, via --escalate)
//
// It sweeps every N-night window in a flexible date range in parallel, normalizes
// to EUR, ranks comparable offers, and SHORT-CIRCUITS: once two independent
// channels agree on the leader within tolerance, it stops and does not suggest
// escalation. Gaps (0–1 sources) are reported with the exact next tier to run.
//
//   node find-best-rate.mjs --hotel la-cigale-tabarka \
//     --window 2026-07-14..2026-07-20 --nights 2 --adults 2 --children 10 [--eur-rate 3.37]
//
// Output: one ranked JSON report on stdout. Never fabricates; every offer keeps
// its source tool's status/confidence.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getRate } from "./lib/fx.mjs";
import { planForCountry } from "./lib/country-router.mjs";
import { resolveCity } from "./lib/geo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGREE_TOLERANCE = 0.03; // 3% -> two channels "agree" on the leader.

// Two offers are "comparable" (safe to corroborate) only if they're the same
// board and a similar room class — not just a coincidentally close price.
const roomClass = (s = "") => {
  const t = s.toLowerCase();
  if (/suite|villa/.test(t)) return "suite";
  if (/deluxe|delux|premium/.test(t)) return "deluxe";
  if (/triple|famil|family/.test(t)) return "triple";
  if (/double|twin|standard|classic|superior|sup/.test(t)) return "standard";
  return "any";
};
const comparable = (a, b) =>
  (a.board || "unknown") === (b.board || "unknown") &&
  (roomClass(a.room) === roomClass(b.room) || roomClass(a.room) === "any" || roomClass(b.room) === "any");

function parseArgs(argv) {
  const a = { adults: 2, children: [], nights: 2, eurRate: 3.37, hotel: "la-cigale-tabarka" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--hotel") (a.hotel = v), i++;
    else if (k === "--window") (a.window = v), i++;           // START..END (ISO)
    else if (k === "--checkin") (a.checkin = v), i++;         // single window alt.
    else if (k === "--checkout") (a.checkout = v), i++;
    else if (k === "--nights") (a.nights = Number(v)), i++;
    else if (k === "--adults") (a.adults = Number(v)), i++;
    else if (k === "--children") (a.children = v.split(",").filter(Boolean).map(Number)), i++;
    else if (k === "--eur-rate") (a.eurRate = Number(v)), i++;
    else if (k === "--escalate") a.escalate = true;
    else if (k === "--name") (a.name = v), i++;   // for on-the-fly discovery
    else if (k === "--city") (a.city = v), i++;
    else if (k === "--country") (a.country = v), i++;
  }
  return a;
}

const emit = (o) => console.log(JSON.stringify(o, null, 2));
const addDays = (iso, d) => {
  const t = Date.parse(iso) + d * 86400000;
  return new Date(t).toISOString().slice(0, 10);
};

// Expand a flexible window into the list of consecutive N-night stays.
function windows(a) {
  if (a.checkin && a.checkout) return [{ checkin: a.checkin, checkout: a.checkout }];
  if (!a.window) throw new Error("Provide --window START..END or --checkin/--checkout");
  const [start, end] = a.window.split("..");
  const out = [];
  for (let ci = start; addDays(ci, a.nights) <= end; ci = addDays(ci, 1)) {
    out.push({ checkin: ci, checkout: addDays(ci, a.nights) });
  }
  return out;
}

function run(script, args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath, [join(HERE, script), ...args],
      { env: process.env, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout) => {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ status: "error", offers: [], note: `bad output from ${script}${err ? ": " + err.message : ""}` }); }
      }
    );
  });
}

// Concurrency-limited map. TunisieBooking throttles bulk parallel requests and
// then returns false "no availability", so we cap how many date-windows are
// priced at once instead of firing Promise.all over every window.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const toEUR = (o, rate) => {
  if (o.currency === "EUR" || o.totalEUR != null) return o.totalEUR ?? o.total;
  if (o.currency === "TND") return Math.round((o.total / rate) * 100) / 100;
  return null; // unknown currency: drop it rather than mis-rank a non-EUR total as EUR
};

(async () => {
  const a = parseArgs(process.argv);
  const cachePath = join(HERE, "cache", "hotel-ids.json");
  let cache = {};
  try { cache = JSON.parse(await readFile(cachePath, "utf8")); } catch {}
  // Generic discovery: if the hotel isn't cached but a --name/--city was given,
  // resolve and persist its channel IDs first, then continue.
  const discovered = [];
  if (!cache[a.hotel] && a.name && a.city) {
    await run("discover-hotel.mjs", ["--name", a.name, "--city", a.city, "--slug", a.hotel, "--write"]);
    try { cache = JSON.parse(await readFile(cachePath, "utf8")); } catch {}
    if (cache[a.hotel]) discovered.push(`discovered:${a.hotel}`);
  }
  const ids = cache[a.hotel] || {};

  // Detect the country from the request: explicit --country wins, else the cached
  // country, else geo-resolve it from the city (--city or the cached city). This
  // is what makes channel selection automatic "en fonction de la demande".
  let country = a.country || ids.country || null;
  let geo = null;
  const cityQ = a.city || ids.city || null;
  if (!country && cityQ) {
    geo = await resolveCity(cityQ, { countryHint: a.country || null });
    if (geo?.country) country = geo.country;
  }

  // Country-aware channel plan (cited config): which channels to prioritise for
  // this country, split into what we can price now vs. what to check.
  const plan = await planForCountry(country);
  const tb = ids.tunisiebooking || {};
  const gh = ids.googleHotels || {};

  let stays;
  try { stays = windows(a); } catch (e) { emit({ status: "error", note: String(e.message) }); process.exit(2); }

  // Live EUR/TND unless the user pinned one; fall back honestly with a flag.
  let fx = { rate: a.eurRate, stale: true, source: "cli --eur-rate" };
  if (!process.argv.includes("--eur-rate")) fx = await getRate("EUR", "TND");
  const rate = fx.rate || a.eurRate;

  const childArgs = (extra) => [
    "--adults", String(a.adults),
    ...(a.children.length ? ["--children", a.children.join(",")] : []),
    ...extra,
  ];

  const tiersRun = new Set();
  // Cap concurrency to avoid TunisieBooking throttling (false "no availability").
  const perStay = await mapLimit(stays, 2, async (s) => {
    const jobs = [];
    // Tier 1 — free browserless, the workhorse for this hotel.
    if (tb.hotelId) {
      tiersRun.add("tier1:tunisiebooking");
      jobs.push(run("tunisiebooking-rate.mjs", childArgs([
        "--checkin", s.checkin, "--checkout", s.checkout,
        "--hotel-id", tb.hotelId, "--ville", tb.ville || "",
      ])));
    }
    // Tier 0 — Google Hotels (structured, may be empty for regional hotels).
    tiersRun.add("tier0:google-hotels");
    jobs.push(run("google-hotels-rate.mjs", childArgs([
      "--checkin", s.checkin, "--checkout", s.checkout,
      "--query", gh.query || ids.displayName || a.hotel, "--currency", "EUR",
    ])));
    // Tier 0 breadth — Apify (only if a token is configured; else it self-skips).
    // A direct Booking start-url (from the cached slug) is far more reliable than
    // a name search, so build one when we have the slug.
    if (process.env.APIFY_TOKEN) {
      tiersRun.add("tier0:apify");
      const apifyArgs = [
        "--query", gh.query || ids.displayName || a.hotel,
        "--checkin", s.checkin, "--checkout", s.checkout, "--currency", "EUR",
      ];
      if (ids.booking?.slug) {
        const ages = a.children.map((age) => `&age=${age}`).join("");
        apifyArgs.push("--start-url",
          `https://www.booking.com/hotel/${ids.booking.slug}.html?checkin=${s.checkin}` +
          `&checkout=${s.checkout}&group_adults=${a.adults}&group_children=${a.children.length}` +
          `${ages}&selected_currency=EUR`);
      }
      jobs.push(run("apify-hotel-rates.mjs", childArgs(apifyArgs), 300000)); // Apify run-sync is slow
    }
    const results = await Promise.all(jobs);
    const offers = results
      .filter((r) => r && r.status === "verified")
      .flatMap((r) => r.offers || [])
      .map((o) => ({ ...o, eur: toEUR(o, rate), window: `${s.checkin}→${s.checkout}` }))
      .filter((o) => o.eur != null)
      .sort((x, y) => x.eur - y.eur);
    return { window: `${s.checkin}→${s.checkout}`, offers };
  });

  // Global ranking across all windows. Offers whose occupancy could NOT be
  // verified as our exact party (e.g. Apify's headline hotel price) are kept as
  // SIGNAL, not ranked — otherwise a cheaper 2-adult rate would masquerade as the
  // best 2-adults-plus-child quote.
  const rawAll = perStay.flatMap((p) => p.offers);
  const unverifiedOccupancy = rawAll.filter((o) => o.occupancyVerified === false);
  let all = rawAll.filter((o) => o.occupancyVerified !== false).sort((x, y) => x.eur - y.eur);

  // Leader + does an independent, comparable channel corroborate it (≤ tol)?
  const evaluate = (list) => {
    const b = list[0] || null;
    const corr = b
      ? list.some((o) => o.channel !== b.channel && comparable(o, b) &&
          Math.abs(o.eur - b.eur) / b.eur <= AGREE_TOLERANCE)
      : false;
    return { best: b, corroborated: corr };
  };
  let { best, corroborated } = evaluate(all);

  // Auto-escalation (opt-in --escalate): when the leader is single-sourced, RUN
  // the browser (Tier 3) to CONFIRM it — not to invent a cheaper one. We use
  // browser-rate.mjs with THIS hotel's own Booking slug (never La Cigale's
  // hardcoded deep links), so the observed prices belong to the right property.
  // The prices are room-unlabelled signal, so they only corroborate: does any
  // observed Booking price land within tolerance of our leader? That confirms
  // without lying, and never lowers the ranked best.
  const escalationRan = [];
  let browserObserved = [];
  let corroboratedBy = null;
  if (a.escalate && best && !corroborated) {
    if (ids.booking?.slug) {
      const [ci, co] = best.window.split("→");
      escalationRan.push("tier3:browser-rate");
      const br = await run("browser-rate.mjs",
        childArgs(["--booking-slug", ids.booking.slug, "--checkin", ci, "--checkout", co, "--currency", "EUR"]),
        150000); // browser is slow; give it room, unlike the default 45s
      browserObserved = (br?.offers || [])
        .flatMap((o) => [o.total, ...(o.candidates || [])])
        .filter((x) => typeof x === "number" && x > 0)
        .map((eur) => ({ channel: "Booking.com (browser)", eur }));
      const match = browserObserved.find(
        (o) => o.channel !== best.channel &&
          Math.abs(o.eur - best.eur) / best.eur <= AGREE_TOLERANCE
      );
      if (match) { corroborated = true; corroboratedBy = match; }
    } else {
      escalationRan.push("tier3:skipped-no-booking-url");
    }
  }

  const distinctChannels = new Set(all.map((o) => o.channel));
  const escalation = [];
  if (!best) {
    escalation.push(a.escalate
      ? "No verified rate even after Tier 3 escalation. The hotel may be unavailable for these dates on every reachable channel."
      : "No verified rate from Tier 0/1. Re-run with --escalate to auto-run the browser (browser-rate.mjs, needs a cached Booking slug), or fetch a channel via brightdata-unlock.mjs.");
  } else if (!corroborated) {
    escalation.push(a.escalate
      ? `Leader ${best.channel} @ €${best.eur} stayed single-sourced after escalation — trust it as the best FOUND price, but no second channel confirmed it.`
      : `Leader ${best.channel} @ €${best.eur} is single-sourced. Re-run with --escalate to auto-corroborate via the browser, or run brightdata-unlock.mjs on a second channel.`);
  }

  emit({
    query: {
      hotel: ids.displayName || a.hotel,
      window: a.window || `${a.checkin}→${a.checkout}`,
      nights: a.nights, adults: a.adults, childrenAges: a.children,
      childPolicy: ids.childPolicy || null,
    },
    generatedAt: new Date().toISOString(),
    fx: { pair: "EUR/TND", rate, stale: fx.stale, source: fx.source },
    geo: geo && { detectedCity: geo.city, country: geo.country, countryName: geo.countryName, source: geo.source },
    channelPlan: {
      country: plan.country, region: plan.region, matched: plan.matched,
      countrySource: a.country ? "explicit" : ids.country ? "cache" : geo ? "geo-detected" : "default",
      pricedNow: plan.actionable.map((c) => c.channel),
      alsoCheck: plan.recommended.map((c) => ({ channel: c.channel, tier: c.tier, note: c.note || null })),
      globalApi: process.env.APIFY_TOKEN
        ? "Apify active — recommended channels are also priced globally."
        : "Set APIFY_TOKEN (or BRIGHTDATA_API_KEY) to price the 'alsoCheck' channels worldwide.",
      note: plan.matched
        ? "Country-specific priorities (cited config). No single site is always cheapest — compare these."
        : "No country match — using the global default plan.",
      sources: plan.sources,
    },
    tiersRun: [...discovered, ...tiersRun, ...escalationRan],
    shortCircuited: corroborated,
    escalationRan,
    status: best ? "verified" : "no_price",
    best: best && {
      channel: best.channel, room: best.room, board: best.board,
      window: best.window, totalEUR: best.eur,
      totalTND: best.currency === "TND" ? best.total : null,
      sourceUrl: best.sourceUrl, corroborated,
      corroboratedBy: corroboratedBy && { channel: corroboratedBy.channel, priceEUR: corroboratedBy.eur },
    },
    browserObserved: browserObserved.length
      ? browserObserved.slice(0, 8).map((o) => ({ channel: o.channel, priceEUR: o.eur, note: "room-unlabelled scrape — signal only" }))
      : undefined,
    unverifiedOccupancy: unverifiedOccupancy.length
      ? unverifiedOccupancy.slice(0, 8).map((o) => ({ channel: o.channel, priceEUR: o.eur, note: o.occupancyNote || "occupancy not verified — signal only" }))
      : undefined,
    // Ranking rows carry the full priced-offer shape (not a 5-field digest):
    // the webapp contract (docs/api/openapi.yaml `Offer`) — and the UI's
    // honesty guard (public/js/offers.js `isHonestVerifiedRow`) — REQUIRE
    // status/checkin/checkout/total/currency, and the TND toggle needs the
    // native totalTND. These rows are all occupancy-verified by construction
    // (`all` filtered out occupancyVerified===false above), so status is
    // "verified"; occupancyVerified defaults to true when the channel left it
    // unset (TunisieBooking's exact-party quote).
    ranking: all.slice(0, 12).map((o) => ({
      channel: o.channel, hotel: o.hotel ?? null, room: o.room ?? "",
      board: o.board, checkin: o.checkin ?? null, checkout: o.checkout ?? null,
      nights: o.nights ?? a.nights, window: o.window,
      total: o.total, currency: o.currency,
      totalTND: o.totalTND ?? (o.currency === "TND" ? o.total : null),
      totalEUR: o.totalEUR ?? o.eur ?? null, eur: o.eur,
      status: o.status ?? "verified",
      occupancyVerified: o.occupancyVerified ?? true,
      sourceUrl: o.sourceUrl ?? null,
    })),
    channels: [...distinctChannels],
    escalation,
  });
})();
