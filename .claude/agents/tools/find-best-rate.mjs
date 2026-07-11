#!/usr/bin/env node
// find-best-rate — the cascade orchestrator. Runs the rate tiers cheapest-first
// and only escalates when needed, so the browser (or a paid unblocker) is the
// LAST resort, not the default:
//
//   Tier 0  structured APIs   google-hotels-rate.mjs  (+ apify-hotel-rates.mjs if APIFY_TOKEN)
//   Tier 1  browserless HTTP  tunisiebooking-rate.mjs (proven ~2s, free)
//   Tier 2  managed unblocker brightdata-unlock.mjs   (only for gaps; needs key)
//   Tier 3  self-hosted browser validate-rate.mjs     (offline last resort — not spawned here)
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

const HERE = dirname(fileURLToPath(import.meta.url));
const AGREE_TOLERANCE = 0.03; // 3% -> two channels "agree" on the leader.

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

function run(script, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath, [join(HERE, script), ...args],
      { env: process.env, maxBuffer: 8 * 1024 * 1024, timeout: 45000 },
      (err, stdout) => {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ status: "error", offers: [], note: `bad output from ${script}${err ? ": " + err.message : ""}` }); }
      }
    );
  });
}

const toEUR = (o, rate) => {
  if (o.currency === "EUR" || o.totalEUR != null) return o.totalEUR ?? o.total;
  if (o.currency === "TND") return Math.round((o.total / rate) * 100) / 100;
  return o.total; // assume already comparable
};

(async () => {
  const a = parseArgs(process.argv);
  let cache = {};
  try { cache = JSON.parse(await readFile(join(HERE, "cache", "hotel-ids.json"), "utf8")); } catch {}
  const ids = cache[a.hotel] || {};
  const tb = ids.tunisiebooking || {};
  const gh = ids.googleHotels || {};

  let stays;
  try { stays = windows(a); } catch (e) { emit({ status: "error", note: String(e.message) }); process.exit(2); }

  const childArgs = (extra) => [
    "--adults", String(a.adults),
    ...(a.children.length ? ["--children", a.children.join(",")] : []),
    ...extra,
  ];

  const tiersRun = new Set();
  const perStay = await Promise.all(stays.map(async (s) => {
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
    if (process.env.APIFY_TOKEN) {
      tiersRun.add("tier0:apify");
      jobs.push(run("apify-hotel-rates.mjs", childArgs([
        "--query", gh.query || ids.displayName || a.hotel,
        "--checkin", s.checkin, "--checkout", s.checkout, "--currency", "EUR",
      ])));
    }
    const results = await Promise.all(jobs);
    const offers = results
      .filter((r) => r && r.status === "verified")
      .flatMap((r) => r.offers || [])
      .map((o) => ({ ...o, eur: toEUR(o, a.eurRate), window: `${s.checkin}→${s.checkout}` }))
      .filter((o) => o.eur != null)
      .sort((x, y) => x.eur - y.eur);
    return { window: `${s.checkin}→${s.checkout}`, offers };
  }));

  // Global ranking across all windows.
  const all = perStay.flatMap((p) => p.offers).sort((x, y) => x.eur - y.eur);
  const best = all[0] || null;

  // Short-circuit test: does a second, independent channel corroborate the
  // leader's price within tolerance? If so, no escalation needed.
  let corroborated = false;
  if (best) {
    corroborated = all.some(
      (o) => o.channel !== best.channel &&
        Math.abs(o.eur - best.eur) / best.eur <= AGREE_TOLERANCE
    );
  }

  const distinctChannels = new Set(all.map((o) => o.channel));
  const escalation = [];
  if (!best) {
    escalation.push("No verified rate from Tier 0/1. Run Tier 2 (brightdata-unlock.mjs on Booking/Agoda deep links) or the self-hosted browser (validate-rate.mjs).");
  } else if (!corroborated) {
    escalation.push(`Leader ${best.channel} @ €${best.eur} is single-sourced. Corroborate with Tier 2 (brightdata-unlock.mjs) on a second channel before trusting it.`);
  }

  emit({
    query: {
      hotel: ids.displayName || a.hotel,
      window: a.window || `${a.checkin}→${a.checkout}`,
      nights: a.nights, adults: a.adults, childrenAges: a.children,
      eurRate: a.eurRate, childPolicy: ids.childPolicy || null,
    },
    generatedAt: new Date().toISOString(),
    tiersRun: [...tiersRun],
    shortCircuited: corroborated,
    status: best ? "verified" : "no_price",
    best: best && {
      channel: best.channel, room: best.room, board: best.board,
      window: best.window, totalEUR: best.eur,
      totalTND: best.currency === "TND" ? best.total : null,
      sourceUrl: best.sourceUrl, corroborated,
    },
    ranking: all.slice(0, 12).map((o) => ({
      window: o.window, channel: o.channel, board: o.board,
      totalEUR: o.eur, room: o.room,
    })),
    channels: [...distinctChannels],
    escalation,
  });
})();
