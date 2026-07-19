// Service-layer tests: exercise searchHotels/priceHotel/rankOffers with FULLY
// INJECTED dependencies (fake smartGet/execFileAsync/cache-file I/O) — no
// network, no child process, no real filesystem writes. Proves: (1) the
// cache actually short-circuits a second identical call, (2) the pacing
// limiter is actually consulted and bounds concurrency, (3) honesty routing
// (404 for unresolved slug, 502 for blocked/drift) happens before any
// outbound work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { searchHotels, priceHotel, rankOffers, mergeRankReports, normalizeRankingOffer, sanitizeChannelPlan } from "../service.mjs";
import { buildUnifiedRows, sortRowsByPrice, pickBestRowIndex, isHonestVerifiedRow } from "../public/js/offers.js";
import { CACHE_HIT } from "../lib/cache.mjs";
import { HostLimiter, CircuitBreaker } from "../lib/pacing.mjs";
import { TTLCache } from "../lib/cache.mjs";
import { NotFoundError, UpstreamBlockedError } from "../lib/errors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", ".claude", "agents", "tools", "test", "fixtures");
const verifiedHtml = readFileSync(join(FIXTURES, "tunisiebooking-354-verified.html"), "latin1");
const nodispoHtml = readFileSync(join(FIXTURES, "tunisiebooking-354-nodispo.html"), "latin1");
const driftHtml = readFileSync(join(FIXTURES, "tunisiebooking-354-drift.html"), "latin1");

// The real analyze()/parseOffers() are imported directly by service.mjs
// (reused, not reimplemented) — we only fake the NETWORK boundary (smartGet)
// and the filesystem/process boundaries (cache file, execFile).
import { analyze } from "../../.claude/agents/tools/tunisiebooking-rate.mjs";

function baseDeps(overrides = {}) {
  return {
    smartGet: async () => ({ status: 200, text: verifiedHtml }),
    classifyError: (s) => (/40[137]/.test(String(s)) ? "blocked" : "error"),
    getRate: async () => ({ rate: 3.37, stale: false, asOf: "2026-07-16T00:00:00Z", source: "open.er-api.com" }),
    convert: (amount, rate) => (amount == null || !rate ? null : Math.round((amount / rate) * 100) / 100),
    resolveCity: async () => ({ city: "Tabarka", country: "TN", countryName: "Tunisie", source: "nominatim" }),
    extractPairs: (html) => {
      const pairs = new Map();
      const re = /detail_hotel_(\d+)/g;
      let m;
      while ((m = re.exec(html))) {
        const alt = html.slice(m.index, m.index + 200).match(/alt="([^"]+)"/);
        pairs.set(m[1], alt ? alt[1] : null);
      }
      return pairs;
    },
    bestMatch: (pairs, name) => {
      for (const [id, nm] of pairs) if (nm && nm.toLowerCase().includes(name.toLowerCase())) return { id, name: nm };
      return null;
    },
    citySlug: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    slugify: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
    analyze,
    execFileAsync: async () => ({ status: "no_price" }),
    // Seed hotel 354 -> Tabarka so priceHotel(354) resolves the ville from cache
    // (no extra detail-page fetch) — mirrors the real seeded cache entry.
    readCacheFile: async () => ({ "la-cigale-tabarka": { tunisiebooking: { hotelId: "354" }, city: "Tabarka", country: "TN" } }),
    writeCacheFile: async () => {},
    limiter: new HostLimiter({ "tn.tunisiebooking.com": 2 }),
    breaker: new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 }),
    priceCache: new TTLCache(),
    rankCache: new TTLCache(),
    fxCache: new TTLCache(),
    geoCache: new TTLCache(),
    now: () => Date.now(),
    ...overrides,
  };
}

// ---- priceHotel: parsing reuse + honesty status mapping ------------------------

test("priceHotel: verified fixture -> verified status, EUR conversion applied", async () => {
  const deps = baseDeps();
  const res = await priceHotel({ hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, childrenAges: [10], currency: "EUR" }, deps);
  assert.equal(res.status, "verified");
  assert.ok(res.offers.length >= 1);
  assert.equal(res.offers[0].totalTND, 2736);
  assert.equal(res.offers[0].totalEUR, Math.round((2736 / 3.37) * 100) / 100);
  assert.equal(res.fx.pair, "EUR/TND");
});

test("priceHotel: no-availability fixture -> honest no_price, not an error", async () => {
  const deps = baseDeps({ smartGet: async () => ({ status: 200, text: nodispoHtml }) });
  const res = await priceHotel({ hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, childrenAges: [], currency: "EUR" }, deps);
  assert.equal(res.status, "no_price");
  assert.equal(res.offers.length, 0);
});

test("priceHotel: drift fixture -> 502 upstream_blocked (channelStatus=drift), never a fake no_price", async () => {
  const deps = baseDeps({ smartGet: async () => ({ status: 200, text: driftHtml }) });
  await assert.rejects(
    () => priceHotel({ hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, childrenAges: [], currency: "EUR" }, deps),
    (e) => e instanceof UpstreamBlockedError && e.extra.channelStatus === "drift"
  );
});

test("priceHotel: open circuit breaker fails fast without calling smartGet", async () => {
  let called = false;
  const deps = baseDeps({ smartGet: async () => { called = true; return { status: 200, text: verifiedHtml }; } });
  deps.breaker.recordFailure("tn.tunisiebooking.com");
  deps.breaker.recordFailure("tn.tunisiebooking.com");
  deps.breaker.recordFailure("tn.tunisiebooking.com"); // threshold=3 -> open
  await assert.rejects(
    () => priceHotel({ hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, childrenAges: [], currency: "EUR" }, deps),
    UpstreamBlockedError
  );
  assert.equal(called, false);
});

test("priceHotel: an UNCACHED hotel resolves its ville from the detail page (regression: empty ville -> false no_price)", async () => {
  // hotel 224 is not in the seeded cache. TunisieBooking needs the exact ville,
  // so the service must fetch the detail page to learn it, else it silently
  // returns no_price (the bug the live demo caught).
  const detailHtml = '<input type="hidden" name="ville" id="ville" value="Tabarka">';
  const deps = baseDeps({
    readCacheFile: async () => ({}), // nothing cached
    smartGet: async (url) =>
      url.includes("/detail_hotel_224/")
        ? { status: 200, text: detailHtml }         // ville lookup
        : { status: 200, text: verifiedHtml },       // priced endpoint
  });
  const res = await priceHotel(
    { hotelId: 224, checkin: "2026-10-03", checkout: "2026-10-05", adults: 2, childrenAges: [10], currency: "EUR" },
    deps
  );
  assert.equal(res.status, "verified");
  assert.ok(res.offers.length >= 1);
  // And the resolved ville reached the priced request (not empty).
  assert.ok(res.offers[0].total > 0);
});

// ---- cache proof ---------------------------------------------------------------

test("priceHotel: a second identical call is served from cache (smartGet not called again)", async () => {
  let calls = 0;
  const deps = baseDeps({ smartGet: async () => { calls += 1; return { status: 200, text: verifiedHtml }; } });
  const req = { hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, childrenAges: [10], currency: "EUR" };
  const first = await priceHotel(req, deps);
  const second = await priceHotel(req, deps);
  assert.equal(calls, 2, "one smartGet call per board (2 boards) on the FIRST request only");
  assert.equal(first.offers[0].total, second.offers[0].total);
  // Cache hit is signalled by a Symbol, not a body field...
  assert.equal(second[CACHE_HIT], true);
  // ...and MUST NOT leak into the serialized body (additionalProperties:false).
  assert.ok(!("fromCache" in JSON.parse(JSON.stringify(second))), "no fromCache field in the JSON body");
});

test("priceHotel: a different occupancy is NOT served from the other occupancy's cache entry", async () => {
  let calls = 0;
  const deps = baseDeps({ smartGet: async () => { calls += 1; return { status: 200, text: verifiedHtml }; } });
  await priceHotel({ hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, childrenAges: [], currency: "EUR" }, deps);
  const callsAfterFirst = calls;
  await priceHotel({ hotelId: 354, checkin: "2026-07-14", checkout: "2026-07-16", adults: 3, childrenAges: [], currency: "EUR" }, deps);
  assert.ok(calls > callsAfterFirst, "different adults count must be a cache MISS, not reuse a stale entry");
});

// ---- pacing proof ---------------------------------------------------------------

test("priceHotel: concurrent requests to different hotels never exceed the TunisieBooking ceiling (2)", async () => {
  let current = 0;
  let maxObserved = 0;
  const deps = baseDeps({
    smartGet: async () => {
      current += 1;
      maxObserved = Math.max(maxObserved, current);
      await new Promise((r) => setTimeout(r, 15));
      current -= 1;
      return { status: 200, text: verifiedHtml };
    },
  });
  const reqs = Array.from({ length: 6 }, (_, i) => ({
    hotelId: 354 + i, checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, childrenAges: [], currency: "EUR",
  }));
  await Promise.all(reqs.map((r) => priceHotel(r, deps)));
  assert.ok(maxObserved <= 2, `observed concurrency ${maxObserved} exceeded the ADR 0001 ceiling of 2`);
});

// ---- rankOffers: 404 before spawn, pass-through of find-best-rate.mjs output ---

test("rankOffers: unresolved slug -> NotFoundError, execFile never invoked", async () => {
  let spawned = false;
  const deps = baseDeps({
    readCacheFile: async () => ({}), // empty cache -> nothing resolves
    execFileAsync: async () => { spawned = true; return {}; },
  });
  await assert.rejects(
    () => rankOffers({ slug: "tn/unknown-hotel", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2, childrenAges: [] }, currency: "EUR", escalate: false }, deps),
    NotFoundError
  );
  assert.equal(spawned, false);
});

test("rankOffers: slug country prefix must match the cache entry's country (anti-confusion)", async () => {
  const deps = baseDeps({
    readCacheFile: async () => ({ "la-cigale-tabarka": { displayName: "La Cigale Tabarka", city: "Tabarka", country: "TN" } }),
  });
  await assert.rejects(
    () => rankOffers({ slug: "eg/la-cigale-tabarka", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2, childrenAges: [] }, currency: "EUR", escalate: false }, deps),
    NotFoundError
  );
});

test("rankOffers: resolved slug -> spawns find-best-rate.mjs with a validated args array, wraps the result", async () => {
  let capturedArgs = null;
  const deps = baseDeps({
    readCacheFile: async () => ({ "la-cigale-tabarka": { displayName: "La Cigale Tabarka", city: "Tabarka", country: "TN" } }),
    execFileAsync: async (script, args) => {
      capturedArgs = args;
      return {
        status: "verified",
        fx: { pair: "EUR/TND", rate: 3.37, stale: false, source: "open.er-api.com" },
        channelPlan: { country: "TN", region: "North Africa", matched: true, countrySource: "cache", pricedNow: ["TunisieBooking"], alsoCheck: [] },
        best: { channel: "TunisieBooking", totalEUR: 241, window: "2026-07-14→2026-07-16" },
        ranking: [{ channel: "TunisieBooking", totalEUR: 241 }],
        tiersRun: ["tier1:tunisiebooking"],
        channels: ["TunisieBooking"],
        escalation: [],
      };
    },
  });
  const res = await rankOffers({ slug: "tn/la-cigale-tabarka", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2, childrenAges: [10] }, currency: "EUR", escalate: false }, deps);
  assert.equal(res.status, "verified");
  assert.equal(res.best.channel, "TunisieBooking");
  // Every arg is a plain validated string — never an object, never a URL.
  assert.ok(capturedArgs.every((a) => typeof a === "string"));
  assert.ok(capturedArgs.includes("--hotel"));
  assert.ok(capturedArgs.includes("la-cigale-tabarka"));
  assert.ok(!capturedArgs.some((a) => /^https?:\/\//.test(a)), "no URL is ever passed as a spawn argument");
});

// ---- contract conformance of /api/rank ranking rows (P6 regression) ------------
// The reviewer's NO-GO: /api/rank returned find-best-rate.mjs's ranking rows
// RAW. Those rows lack 5 of the 7 REQUIRED Offer fields
// (status/checkin/checkout/total/currency), so the UI honesty guard
// (isHonestVerifiedRow -> pickBestRowIndex) never found a "best" row and the
// page falsely showed "Aucun prix vérifié" on a genuinely verified quote.
// Also channelPlan.sources leaked (additionalProperties:false violation).

const OFFER_REQUIRED = ["channel", "board", "checkin", "checkout", "total", "currency", "status"];

// The REAL shape find-best-rate.mjs now emits on stdout for one ranking row.
const realRankStdout = () => ({
  status: "verified",
  fx: { pair: "EUR/TND", rate: 3.37, stale: false, source: "open.er-api.com" },
  channelPlan: {
    country: "TN", region: "North Africa", matched: true, countrySource: "cache",
    pricedNow: ["TunisieBooking"], alsoCheck: [],
    globalApi: "Set APIFY_TOKEN ...", note: "Country-specific priorities.",
    sources: ["https://example.test/config-citation"], // NOT in the ChannelPlan contract
  },
  best: { channel: "TunisieBooking", room: "Double", board: "breakfast", window: "2026-07-14→2026-07-16", totalEUR: 241, totalTND: 812, sourceUrl: "https://tn.tunisiebooking.com/detail_hotel_354/", corroborated: false, corroboratedBy: null },
  ranking: [{
    channel: "TunisieBooking", hotel: "hotel_354", room: "Double", board: "breakfast",
    checkin: "2026-07-14", checkout: "2026-07-16", nights: 2, window: "2026-07-14→2026-07-16",
    total: 812, currency: "TND", totalTND: 812, totalEUR: 241, eur: 241,
    status: "verified", occupancyVerified: true, sourceUrl: "https://tn.tunisiebooking.com/detail_hotel_354/",
  }],
  tiersRun: ["tier1:tunisiebooking"], channels: ["TunisieBooking"], escalation: [],
});

test("rankOffers: ranking[0] satisfies the full Offer contract, and channelPlan.sources is stripped", async () => {
  const deps = baseDeps({
    readCacheFile: async () => ({ "la-cigale-tabarka": { displayName: "La Cigale Tabarka", city: "Tabarka", country: "TN" } }),
    execFileAsync: async () => realRankStdout(),
  });
  const res = await rankOffers({ slug: "tn/la-cigale-tabarka", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2, childrenAges: [10] }, currency: "EUR", escalate: false }, deps);

  const row = res.ranking[0];
  for (const f of OFFER_REQUIRED) {
    assert.ok(row[f] !== undefined && row[f] !== null, `ranking[0].${f} must be present (Offer required field)`);
  }
  assert.equal(row.status, "verified");
  assert.equal(row.total, 812);
  assert.equal(row.currency, "TND");
  // Honesty invariant: a verified row must not carry occupancyVerified:false.
  assert.notEqual(row.occupancyVerified, false);
  // channelPlan is sanitized to the contract (no `sources`, no stray keys).
  assert.ok(!("sources" in res.channelPlan), "channelPlan.sources must not leak (additionalProperties:false)");
  assert.equal(res.channelPlan.country, "TN");

  // And the FRONTEND honesty guard can now actually pick the verified best row.
  const rows = sortRowsByPrice(buildUnifiedRows(res));
  assert.ok(pickBestRowIndex(rows) >= 0, "UI must find a verified best row for a genuinely verified quote");
});

test("rankOffers: even a TRIMMED ranking row (only window/channel/board/totalEUR/room) is normalized to a conformant Offer", async () => {
  // Defence-in-depth: if the tool ever regresses to the old 5-field digest, the
  // webapp boundary still fills the required Offer fields (status defaults to
  // verified — ranking rows are occupancy-verified by construction — and
  // checkin/checkout are derived from `window`).
  const deps = baseDeps({
    readCacheFile: async () => ({ "la-cigale-tabarka": { displayName: "La Cigale Tabarka", city: "Tabarka", country: "TN" } }),
    execFileAsync: async () => ({
      status: "verified",
      fx: { pair: "EUR/TND", rate: 3.37, stale: false, source: "open.er-api.com" },
      channelPlan: { country: "TN", region: null, matched: true, countrySource: "cache", pricedNow: ["TunisieBooking"], alsoCheck: [] },
      best: { channel: "TunisieBooking", totalEUR: 241, window: "2026-07-14→2026-07-16" },
      ranking: [{ window: "2026-07-14→2026-07-16", channel: "TunisieBooking", board: "breakfast", totalEUR: 241, room: "Double" }],
      tiersRun: [], channels: ["TunisieBooking"], escalation: [],
    }),
  });
  const res = await rankOffers({ slug: "tn/la-cigale-tabarka", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2, childrenAges: [] }, currency: "EUR", escalate: false }, deps);
  const row = res.ranking[0];
  for (const f of OFFER_REQUIRED) assert.ok(row[f] !== undefined && row[f] !== null, `ranking[0].${f} derived`);
  assert.equal(row.checkin, "2026-07-14");
  assert.equal(row.checkout, "2026-07-16");
  assert.equal(row.status, "verified");
  assert.equal(pickBestRowIndex(sortRowsByPrice(buildUnifiedRows(res))), 0);
});

test("normalizeRankingOffer: derives checkin/checkout from window and defaults status to verified", () => {
  const o = normalizeRankingOffer({ channel: "X", board: "breakfast", window: "2026-08-01→2026-08-03", totalEUR: 300, room: "R" });
  assert.equal(o.checkin, "2026-08-01");
  assert.equal(o.checkout, "2026-08-03");
  assert.equal(o.status, "verified");
  assert.equal(o.occupancyVerified, true);
  assert.equal(o.total, 300); // falls back to totalEUR when native total absent
});

test("normalizeRankingOffer: never mints status:verified for an occupancyVerified:false row (honesty invariant)", () => {
  // The P6 re-gate's adversarial input: a row that explicitly says occupancy is
  // unconfirmed must NOT come out labelled verified (openapi Offer allOf).
  const o = normalizeRankingOffer({ channel: "Apify", board: "unknown", window: "2026-08-01→2026-08-03", totalEUR: 100, room: "R", occupancyVerified: false });
  assert.equal(o.occupancyVerified, false);
  assert.notEqual(o.status, "verified");
  // Downstream honesty guard agrees it is not a best-eligible row.
  assert.equal(isHonestVerifiedRow({ status: o.status, occupancyVerified: o.occupancyVerified }), false);
  // A row already carrying a non-verified status keeps it rather than "signal".
  const drift = normalizeRankingOffer({ channel: "X", board: "unknown", window: "2026-08-01→2026-08-03", totalEUR: 100, occupancyVerified: false, status: "drift" });
  assert.equal(drift.status, "drift");
});

test("normalizeRankingOffer: omits `hotel` when absent (schema: hotel is non-nullable), keeps it when present", () => {
  const without = normalizeRankingOffer({ channel: "X", board: "breakfast", window: "2026-08-01→2026-08-03", totalEUR: 100 });
  assert.ok(!("hotel" in without), "no null hotel key");
  const withHotel = normalizeRankingOffer({ channel: "X", hotel: "hotel_9", board: "breakfast", window: "2026-08-01→2026-08-03", totalEUR: 100 });
  assert.equal(withHotel.hotel, "hotel_9");
});

test("sanitizeChannelPlan: keeps only contract keys, drops sources", () => {
  const p = sanitizeChannelPlan({ country: "TN", matched: true, pricedNow: [], alsoCheck: [], sources: ["x"], secret: "y" });
  assert.ok(!("sources" in p));
  assert.ok(!("secret" in p));
  assert.equal(p.country, "TN");
});

// ---- mergeRankReports (pure) ----------------------------------------------------

test("mergeRankReports: picks the global minimum best across hotels and unions channels", () => {
  const r1 = { status: "verified", best: { channel: "A", totalEUR: 300 }, ranking: [{ channel: "A", totalEUR: 300 }], tiersRun: ["tier1:a"], channels: ["A"], escalation: [] };
  const r2 = { status: "verified", best: { channel: "B", totalEUR: 200 }, ranking: [{ channel: "B", totalEUR: 200 }], tiersRun: ["tier1:b"], channels: ["B"], escalation: [] };
  const merged = mergeRankReports([r1, r2]);
  assert.equal(merged.best.channel, "B");
  assert.equal(merged.status, "verified");
  assert.deepEqual(merged.channels.sort(), ["A", "B"]);
  assert.equal(merged.ranking[0].channel, "B");
});

test("mergeRankReports: no best anywhere -> status no_price", () => {
  const merged = mergeRankReports([{ status: "no_price", best: null, ranking: [], tiersRun: [], channels: [], escalation: [] }]);
  assert.equal(merged.status, "no_price");
  assert.equal(merged.best, null);
});
