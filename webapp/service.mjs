// service — glues the OpenAPI-shaped requests to the REUSED tool modules in
// .claude/agents/tools/. Two integration strategies are used deliberately:
//
//  * /api/search and /api/hotels/{id}/price call the tool modules' PURE
//    exported functions IN-PROCESS (extractPairs/bestMatch/citySlug,
//    analyze/parseOffers, resolveCity, getRate) and make their own outbound
//    HTTP call via the shared `smartGet` — so these calls run through this
//    process's guarded `fetch` (webapp/lib/ssrf-guard.mjs) and this process's
//    pacing/circuit-breaker (webapp/lib/pacing.mjs) directly. "Import over
//    spawn" is possible here because the pure pieces we need are exported.
//
//  * /api/rank shells out to `find-best-rate.mjs` via `execFile` with a
//    VALIDATED ARRAY OF ARGS (never a shell, never a client-supplied string
//    used as a URL) — see the long comment above `runFindBestRate()` for why
//    this is the deliberate choice over refactoring the orchestrator: it is
//    already a tested, ADR-documented cascade (tier fallback, mapLimit(2)
//    pacing, corroboration, discovery-on-the-fly) and re-implementing it
//    in-process risks silently breaking behaviour the existing test fixtures
//    already pin down. The webapp still adds an OUTER layer of protection
//    (validation before spawn, a server-wide pacing slot so concurrent
//    /api/rank calls from different clients can't multiply the ceiling, a
//    hard timeout, and its own response cache).
//
// Every function here takes an already-validated request (webapp/lib/validate.mjs
// ran first) and an optional `deps` object for dependency injection, so unit
// tests can run with zero network (see webapp/test/*).

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { smartGet, classifyError } from "../.claude/agents/tools/lib/smart-fetch.mjs";
import { getRate, convert } from "../.claude/agents/tools/lib/fx.mjs";
import { resolveCity } from "../.claude/agents/tools/lib/geo.mjs";
import { extractPairs, bestMatch, citySlug, slugify } from "../.claude/agents/tools/discover-hotel.mjs";
import { analyze } from "../.claude/agents/tools/tunisiebooking-rate.mjs";

import { HostLimiter, CircuitBreaker, withPacing, DEFAULT_LIMITS } from "./lib/pacing.mjs";
import { TTLCache, offerCacheKey, ttlForStatus, TTL_MS, CACHE_HIT } from "./lib/cache.mjs";
import { NotFoundError, UpstreamBlockedError } from "./lib/errors.mjs";
import { parseSlugParts } from "./lib/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(HERE, "..", ".claude", "agents", "tools");
const CACHE_FILE = join(TOOLS_DIR, "cache", "hotel-ids.json");
const TB_HOST = "https://tn.tunisiebooking.com";
const TB_ENDPOINT = `${TB_HOST}/theme/traitement_detailv_contre_proposition_new_v4.php`;

// ---- shared, process-wide pacing/breaker/caches ----------------------------
// Exported so server.mjs / tests can inspect state; a single instance backs
// every request the process serves, which is exactly what makes the
// concurrency ceiling GLOBAL rather than per-request.

export const limiter = new HostLimiter(DEFAULT_LIMITS);
export const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 });
export const priceCache = new TTLCache();
export const rankCache = new TTLCache();
export const fxCache = new TTLCache();
export const geoCache = new TTLCache();

// ---- default (production) dependencies -------------------------------------

function defaultDeps() {
  return {
    smartGet,
    classifyError,
    getRate,
    convert,
    resolveCity,
    extractPairs,
    bestMatch,
    citySlug,
    slugify,
    analyze,
    execFileAsync: runChildTool,
    readCacheFile,
    writeCacheFile,
    limiter,
    breaker,
    priceCache,
    rankCache,
    fxCache,
    geoCache,
    now: () => Date.now(),
  };
}

async function readCacheFile() {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeCacheFile(cache) {
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
}

// Spawn a tool script with an ARRAY of args (never a shell string). Every
// argument passed in by callers below is already strictly validated
// (numbers, ISO dates, regex-checked slugs) before it reaches this function —
// see lib/validate.mjs — so nothing resembling a URL, a flag injection, or a
// shell metacharacter can reach `execFile`.
function runChildTool(script, args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(TOOLS_DIR, script), ...args],
      { env: process.env, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout) => {
        if (!stdout) return reject(err || new Error(`${script}: no output`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`${script}: could not parse JSON output${err ? `: ${err.message}` : ""}`));
        }
      }
    );
  });
}

// ---- cached FX rate ---------------------------------------------------------

async function cachedFx(deps) {
  const key = "EUR/TND";
  const hit = deps.fxCache.get(key);
  if (hit) return hit;
  const fx = await deps.getRate("EUR", "TND");
  deps.fxCache.set(key, fx, TTL_MS.fx);
  return fx;
}

// =============================================================================
// /api/search
// =============================================================================

// Resolve hotel candidates from a TunisieBooking city listing page. The URL
// is built ENTIRELY from a hardcoded host + a citySlug() derived from the
// validated `city` string (citySlug folds to [a-z0-9] only) — no client input
// ever reaches a hostname or a path segment beyond that filtered slug.
async function fetchCityListing(deps, tbCitySlug) {
  const url = `${TB_HOST}/hotels_${tbCitySlug}.html`;
  const release = await deps.limiter.acquire("tn.tunisiebooking.com", 1);
  try {
    const { status, text } = await deps.smartGet(url, { referer: `${TB_HOST}/` });
    if (status !== 200) return { ok: false, note: `city list HTTP ${status}` };
    return { ok: true, text };
  } finally {
    release();
  }
}

export async function searchHotels(req, deps = defaultDeps()) {
  const { name = null, city = null, country: countryHint = null } = req;

  let geo = null;
  let country = countryHint;
  if (!country && (city || name)) {
    const cacheKey = `${(city || name).toLowerCase()}|${countryHint || ""}`;
    const hit = deps.geoCache.get(cacheKey);
    if (hit !== undefined) {
      geo = hit;
    } else {
      geo = await deps.resolveCity(city || name, { countryHint });
      deps.geoCache.set(cacheKey, geo, TTL_MS.geo);
    }
    if (geo?.country) country = geo.country;
  }

  const hotels = [];
  const effectiveCity = city || geo?.city || null;

  if (effectiveCity && country === "TN") {
    const tbSlug = deps.citySlug(effectiveCity);
    const listing = await fetchCityListing(deps, tbSlug);
    if (listing.ok) {
      const pairs = deps.extractPairs(listing.text);
      if (name) {
        const match = deps.bestMatch(pairs, name, effectiveCity);
        if (match) {
          hotels.push(await toHotelCandidate(deps, { name: match.name, city: effectiveCity, country, hotelId: match.id }));
        }
      } else {
        for (const [id, hotelName] of pairs) {
          if (!hotelName) continue;
          hotels.push(await toHotelCandidate(deps, { name: hotelName, city: effectiveCity, country, hotelId: id }, { persist: false }));
          if (hotels.length >= 20) break;
        }
      }
    }
  } else if (name) {
    // No confirmed Tunisia city context: we cannot safely resolve a
    // TunisieBooking id (ADR 0003 — verified pricing is Tunisia-only). Return
    // an unresolved candidate rather than guessing.
    hotels.push({
      slug: `${(country || "xx").toLowerCase()}/${deps.slugify(name)}`,
      displayName: name,
      city: effectiveCity,
      country: country || null,
      hotelId: null,
      channels: [],
      childPolicy: null,
      resolution: "partial",
    });
  }

  return {
    query: { name, city, country: countryHint },
    geo: geo && { detectedCity: geo.city, country: geo.country, countryName: geo.countryName, source: geo.source },
    hotels,
    generatedAt: new Date().toISOString(),
  };
}

// Build a Hotel candidate AND persist it into the shared discovery cache
// (same file find-best-rate.mjs reads), so an immediate follow-up /api/rank
// or /api/hotels/{id}/price for the same hotel is instant. Mirrors
// discover-hotel.mjs's own --write behaviour.
async function toHotelCandidate(deps, { name, city, country, hotelId }, { persist = true } = {}) {
  const key = deps.slugify(name);
  const slug = `${country.toLowerCase()}/${key}`;
  if (persist) {
    const cache = await deps.readCacheFile();
    cache[key] = {
      ...(cache[key] || {}),
      displayName: name,
      city,
      country,
      tunisiebooking: { hotelId: String(hotelId), ville: city },
      googleHotels: cache[key]?.googleHotels || { query: name },
      booking: cache[key]?.booking ?? null,
      trip: cache[key]?.trip ?? null,
      childPolicy: cache[key]?.childPolicy ?? null,
    };
    await deps.writeCacheFile(cache);
  }
  return {
    slug,
    displayName: name,
    city,
    country,
    hotelId: Number(hotelId),
    channels: ["tunisiebooking"],
    childPolicy: null,
    resolution: "resolved",
  };
}

// =============================================================================
// /api/hotels/{id}/price
// =============================================================================

const MEAL_BOARDS = ["lpd", "dp"]; // same default as tunisiebooking-rate.mjs

const toFr = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const nightsBetween = (ci, co) => Math.round((Date.parse(co) - Date.parse(ci)) / 86_400_000);

// Mirrors tunisiebooking-rate.mjs's own (unexported) buildUrl/occupancyParams:
// URL ASSEMBLY only (not scraping/parsing — that stays 100% delegated to the
// imported `analyze()`). Kept here so /price can run in-process, guarded by
// this server's ssrf-guard + pacing, instead of spawning a subprocess.
function buildTbUrl({ hotelId, ville, checkin, checkout, adults, childrenAges, nights, board }) {
  const p = new URLSearchParams({
    id_hotel_xml: String(hotelId), formule: board, integrateur: "", token: "",
    session: "", type_chambre: "", testmodif: "0", ville: ville || "",
    chambres: "1", DOPBookingSystem_CheckIn1: toFr(checkin), nbr_nuit: String(nights),
  });
  p.set("adultes1", String(adults));
  p.set("enfants1", String(childrenAges.length));
  childrenAges.forEach((age, i) => p.set(`age1_${i + 1}`, String(age)));
  return `${TB_ENDPOINT}?${p}`;
}

async function findVilleForHotelId(deps, hotelId) {
  const cache = await deps.readCacheFile();
  for (const entry of Object.values(cache)) {
    if (String(entry?.tunisiebooking?.hotelId) === String(hotelId)) {
      return { ville: entry.city || "", country: entry.country || null };
    }
  }
  // Not in the seeded cache. TunisieBooking's priced endpoint REQUIRES the exact
  // ville (empty/wrong -> silent no_price), so resolve it from the hotel's own
  // detail page (which carries a hidden `ville` field). Memoised so it costs at
  // most one extra request per uncached hotel.
  const memoKey = `ville:${hotelId}`;
  const memo = deps.geoCache.get(memoKey);
  if (memo !== undefined) return memo;
  let resolved = { ville: "", country: null };
  // Guarded by the SAME host limiter as the priced calls, so this extra request
  // counts toward the TunisieBooking concurrency ceiling (ADR 0001), not around it.
  const release = await deps.limiter.acquire("tn.tunisiebooking.com", 1);
  try {
    const { status, text } = await deps.smartGet(`${TB_HOST}/detail_hotel_${hotelId}/`, { referer: `${TB_HOST}/` });
    if (status === 200) {
      const m = text.match(/(?:name|id)="ville"[^>]*\svalue="([^"]+)"/i);
      if (m) resolved = { ville: m[1].trim(), country: "TN" };
    }
  } catch { /* leave unresolved -> honest no_price downstream */ }
  finally { release(); }
  deps.geoCache.set(memoKey, resolved, TTL_MS.geo);
  return resolved;
}

export async function priceHotel(req, deps = defaultDeps()) {
  const { hotelId, checkin, checkout, adults, childrenAges = [], currency = "EUR" } = req;
  const nights = nightsBetween(checkin, checkout);

  const cacheKey = offerCacheKey({
    channel: "tunisiebooking", hotelId, checkin, checkout, adults, childrenAges, board: "any", currency,
  });
  const cached = deps.priceCache.get(cacheKey);
  if (cached) return Object.assign({ ...cached, generatedAt: new Date().toISOString() }, { [CACHE_HIT]: true });

  const host = "tn.tunisiebooking.com";
  if (deps.breaker.isOpen(host)) {
    throw new UpstreamBlockedError(
      `Canal TunisieBooking bloqué (circuit ouvert après échecs répétés).`,
      "blocked"
    );
  }

  const { ville } = await findVilleForHotelId(deps, hotelId);

  const release = await deps.limiter.acquire(host, Math.min(MEAL_BOARDS.length, deps.limiter.limitFor(host)));
  let results;
  try {
    results = await Promise.all(
      MEAL_BOARDS.map(async (board) => {
        const url = buildTbUrl({ hotelId, ville, checkin, checkout, adults, childrenAges, nights, board });
        const { status: http, text } = await deps.smartGet(url, {
          xhr: true, referer: `${TB_HOST}/detail_hotel_${hotelId}/`,
        });
        if (http !== 200) return { status: deps.classifyError(String(http)), offers: [] };
        return deps.analyze(text, { hotelId: String(hotelId), children: childrenAges, adults }, nights);
      })
    );
    deps.breaker.recordSuccess(host);
  } catch (e) {
    deps.breaker.recordFailure(host);
    throw new UpstreamBlockedError(`Canal TunisieBooking indisponible: ${e.message}`, deps.classifyError(e.message) === "blocked" ? "blocked" : "error");
  } finally {
    release();
  }

  const offers = results.flatMap((r) => r.offers).sort((a, b) => a.total - b.total);
  const drift = results.some((r) => r.status === "drift");
  const status = offers.length ? "verified" : drift ? "drift" : "no_price";

  if (status === "drift") {
    deps.breaker.recordFailure(host);
    throw new UpstreamBlockedError("Dérive de markup détectée — parser à mettre à jour.", "drift");
  }

  const fx = await cachedFx(deps);
  const enrichedOffers = offers.map((o) => {
    const totalEUR = o.currency === "TND" ? deps.convert(o.total, fx.rate) : o.currency === "EUR" ? o.total : null;
    return { ...o, totalTND: o.currency === "TND" ? o.total : o.totalTND ?? null, totalEUR, eur: totalEUR };
  });

  const body = {
    query: { hotelId, checkin, checkout, nights, adults, childrenAges, currency },
    generatedAt: new Date().toISOString(),
    status,
    source: status === "verified" ? "TunisieBooking (browserless)" : null,
    fx: { pair: "EUR/TND", rate: fx.rate, stale: fx.stale, asOf: fx.asOf ?? null, source: fx.source },
    note: status === "verified" ? `Totals include booking fee. Boards: ${MEAL_BOARDS.join(", ")}.` : "No priced room for these dates/occupancy.",
    offers: enrichedOffers,
  };

  const ttl = ttlForStatus(status);
  if (ttl) deps.priceCache.set(cacheKey, body, ttl);
  return body;
}

// =============================================================================
// /api/rank
// =============================================================================

// Why execFile(array-args) here and not an in-process import: find-best-rate.mjs
// is the tested cascade orchestrator (tier fallback, mapLimit(2) TunisieBooking
// pacing, corroboration threshold, discovery-on-the-fly, channel-plan
// assembly). Re-implementing that logic in-process to make it "importable"
// would duplicate — and risk silently diverging from — behaviour the existing
// ADRs and test fixtures already pin down. `execFile` with a plain array of
// args (built ONLY from already-validated numbers/enums/regex-checked slugs,
// see lib/validate.mjs) matches the exact pattern the tool itself already uses
// internally to call its own sub-tools (ADR 0002 rule 5) — no shell, no
// interpolation, no client-controlled string ever becomes part of a path or a
// URL. The webapp adds an OUTER safety layer around the opaque call: existence
// check against the shared hotel cache (404 before ever spawning a process),
// a process-wide pacing slot + circuit breaker for the 'tn.tunisiebooking.com'
// host (protects against concurrent /api/rank calls from DIFFERENT clients
// collectively exceeding the ADR ceiling — a gap a single CLI invocation's
// internal mapLimit(2) cannot see), a hard timeout, and a response cache.
async function runFindBestRate(deps, { hotelKey, window, checkin, checkout, nights, adults, childrenAges, escalate }) {
  const args = ["--hotel", hotelKey, "--adults", String(adults)];
  if (childrenAges.length) args.push("--children", childrenAges.join(","));
  if (window) args.push("--window", window, "--nights", String(nights));
  else args.push("--checkin", checkin, "--checkout", checkout);
  if (escalate) args.push("--escalate");

  const host = "tn.tunisiebooking.com";
  if (deps.breaker.isOpen(host)) {
    throw new UpstreamBlockedError("Canal TunisieBooking bloqué (circuit ouvert après échecs répétés).", "blocked");
  }
  // Reserve the FULL TunisieBooking budget for the duration of this run: the
  // child process itself fans out up to `limit` concurrent stay-windows
  // against TunisieBooking (mapLimit(stays, 2, …)), so from this process'
  // point of view a single rank run already consumes the whole ceiling.
  const weight = deps.limiter.limitFor(host);
  const release = await deps.limiter.acquire(host, weight);
  try {
    const result = await deps.execFileAsync("find-best-rate.mjs", args, { timeoutMs: 180_000 });
    if (result?.status === "error") {
      deps.breaker.recordFailure(host);
      throw new UpstreamBlockedError(result.note || "find-best-rate.mjs failed.", "error");
    }
    deps.breaker.recordSuccess(host);
    return result;
  } catch (e) {
    if (!(e instanceof UpstreamBlockedError)) deps.breaker.recordFailure(host);
    throw e instanceof UpstreamBlockedError ? e : new UpstreamBlockedError(`find-best-rate.mjs invocation failed: ${e.message}`, "error");
  } finally {
    release();
  }
}

// Merge N per-hotel find-best-rate reports into one RankResponse-shaped
// object: rankings concatenated and re-sorted by totalEUR, `best` = overall
// minimum, tiersRun/channels unioned. Pure — unit-testable without network.
export function mergeRankReports(reports) {
  const allRanking = reports.flatMap((r) => r.ranking || []).sort((a, b) => (a.totalEUR ?? Infinity) - (b.totalEUR ?? Infinity));
  const bests = reports.map((r) => r.best).filter(Boolean).sort((a, b) => (a.totalEUR ?? Infinity) - (b.totalEUR ?? Infinity));
  const best = bests[0] || null;
  const tiersRun = [...new Set(reports.flatMap((r) => r.tiersRun || []))];
  const channels = [...new Set(reports.flatMap((r) => r.channels || []))];
  const escalation = reports.flatMap((r) => r.escalation || []);
  const unverifiedOccupancy = reports.flatMap((r) => r.unverifiedOccupancy || []);
  const browserObserved = reports.flatMap((r) => r.browserObserved || []);
  return {
    status: best ? "verified" : "no_price",
    best,
    ranking: allRanking,
    tiersRun,
    channels,
    escalation,
    unverifiedOccupancy: unverifiedOccupancy.length ? unverifiedOccupancy : undefined,
    browserObserved: browserObserved.length ? browserObserved : undefined,
    shortCircuited: reports.some((r) => r.shortCircuited),
    // fx / channelPlan / geo: take the first report's (same FX pair and
    // country-driven plan across a slug list is a reasonable simplification
    // for this personal-use API; each hotel's own report is still fully
    // available for a per-slug follow-up call).
    fx: reports[0]?.fx,
    channelPlan: reports[0]?.channelPlan,
    geo: reports[0]?.geo,
  };
}

export async function rankOffers(req, deps = defaultDeps()) {
  const slugs = req.slugs || [req.slug];
  const { occupants, window, checkin, checkout, nights, currency, escalate } = req;

  const cache = await deps.readCacheFile();
  const resolvedKeys = [];
  for (const slug of slugs) {
    const { countryPart, key } = parseSlugParts(slug);
    const entry = cache[key];
    if (!entry) throw new NotFoundError(`Aucun hôtel pour ce slug: ${slug}`);
    if (entry.country && entry.country.toLowerCase() !== countryPart) {
      throw new NotFoundError(`Aucun hôtel pour ce slug: ${slug}`);
    }
    resolvedKeys.push({ slug, key, displayName: entry.displayName || key });
  }

  const cacheKey = offerCacheKey({
    channel: "rank",
    hotelId: resolvedKeys.map((r) => r.key).join(","),
    checkin: window || checkin,
    checkout: window ? "" : checkout,
    adults: occupants.adults,
    childrenAges: occupants.childrenAges,
    board: escalate ? "escalate" : "no-escalate",
    currency,
  });
  const cached = deps.rankCache.get(cacheKey);
  if (cached) return Object.assign({ ...cached, generatedAt: new Date().toISOString() }, { [CACHE_HIT]: true });

  const reports = [];
  for (const { key } of resolvedKeys) {
    // Sequential across hotels (not just within one) — keeps the SAME
    // process-wide TunisieBooking ceiling honoured even for `slugs[]` fan-out.
    const r = await runFindBestRate(deps, {
      hotelKey: key, window, checkin, checkout, nights, adults: occupants.adults,
      childrenAges: occupants.childrenAges, escalate,
    });
    reports.push(r);
  }

  const merged = reports.length > 1 ? mergeRankReports(reports) : reports[0];

  const body = {
    query: {
      hotel: resolvedKeys.map((r) => r.displayName).join(", "),
      window: window || null,
      nights: window ? nights : nightsBetween(checkin, checkout),
      adults: occupants.adults,
      childrenAges: occupants.childrenAges,
      childPolicy: cache[resolvedKeys[0].key]?.childPolicy || null,
    },
    generatedAt: new Date().toISOString(),
    status: merged.status,
    fx: merged.fx,
    geo: merged.geo,
    channelPlan: merged.channelPlan,
    tiersRun: merged.tiersRun,
    shortCircuited: merged.shortCircuited,
    best: merged.best,
    ranking: merged.ranking,
    unverifiedOccupancy: merged.unverifiedOccupancy,
    browserObserved: merged.browserObserved,
    channels: merged.channels,
    escalation: merged.escalation,
  };

  const ttl = ttlForStatus(body.status);
  if (ttl) deps.rankCache.set(cacheKey, body, ttl);
  return body;
}

export { defaultDeps, TOOLS_DIR, CACHE_FILE };
