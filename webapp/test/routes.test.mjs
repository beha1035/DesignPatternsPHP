// Route-level tests against a REAL HTTP server (node:http), with the
// `service` layer fully mocked — zero network, zero child-process spawn.
// Covers: (a) response-shape conformance to openapi.yaml, (b) SSRF/URL
// payload rejection at the validation boundary (the mocked service functions
// must never even be called for a rejected payload), (c) auth + rate-limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { startTestServer } from "./helpers/http-client.mjs";

const BEARER = "test-token-xyz";
const AUTH = { Authorization: `Bearer ${BEARER}` };

function mockService(overrides = {}) {
  const calls = { searchHotels: 0, rankOffers: 0, priceHotel: 0 };
  return {
    calls,
    searchHotels: async (q) => {
      calls.searchHotels += 1;
      return (
        overrides.searchHotels?.(q) ?? {
          query: { name: q.name ?? null, city: q.city ?? null, country: q.country ?? null },
          geo: null,
          hotels: [
            {
              slug: "tn/la-cigale-tabarka",
              displayName: "La Cigale Tabarka Hôtel Thalasso, Spa & Golf",
              city: "Tabarka",
              country: "TN",
              hotelId: 354,
              channels: ["tunisiebooking"],
              childPolicy: null,
              resolution: "resolved",
            },
          ],
          generatedAt: new Date().toISOString(),
        }
      );
    },
    rankOffers: async (q) => {
      calls.rankOffers += 1;
      return (
        overrides.rankOffers?.(q) ?? {
          query: { hotel: "La Cigale Tabarka", window: q.window ?? null, nights: q.nights ?? 2, adults: q.occupants.adults, childrenAges: q.occupants.childrenAges, childPolicy: null },
          generatedAt: new Date().toISOString(),
          status: "verified",
          fx: { pair: "EUR/TND", rate: 3.37, stale: false, asOf: new Date().toISOString(), source: "open.er-api.com" },
          geo: null,
          channelPlan: { country: "TN", region: "North Africa", matched: true, countrySource: "cache", pricedNow: ["TunisieBooking"], alsoCheck: [], globalApi: null, note: null },
          tiersRun: ["tier1:tunisiebooking"],
          shortCircuited: false,
          best: { channel: "TunisieBooking", room: "Double", board: "breakfast", window: "2026-07-14→2026-07-16", totalEUR: 241, totalTND: 812, sourceUrl: "https://tn.tunisiebooking.com/detail_hotel_354/", corroborated: false, corroboratedBy: null },
          ranking: [{ window: "2026-07-14→2026-07-16", channel: "TunisieBooking", board: "breakfast", totalEUR: 241, room: "Double" }],
          channels: ["TunisieBooking"],
          escalation: [],
        }
      );
    },
    priceHotel: async (q) => {
      calls.priceHotel += 1;
      return (
        overrides.priceHotel?.(q) ?? {
          query: { hotelId: q.hotelId, checkin: q.checkin, checkout: q.checkout, nights: 2, adults: q.adults, childrenAges: q.childrenAges, currency: q.currency ?? "EUR" },
          generatedAt: new Date().toISOString(),
          status: "verified",
          source: "TunisieBooking (browserless)",
          fx: { pair: "EUR/TND", rate: 3.37, stale: false, asOf: new Date().toISOString(), source: "open.er-api.com" },
          note: null,
          offers: [
            {
              channel: "TunisieBooking", hotel: `hotel_${q.hotelId}`, room: "Triple Superieure", board: "breakfast",
              checkin: q.checkin, checkout: q.checkout, nights: 2, window: null, total: 2736, currency: "TND",
              totalTND: 2736, totalEUR: 812, eur: 812, baseBeforeFee: 2682, feePct: 2, cancellation: "unknown",
              status: "verified", confidence: 0.9, occupancyVerified: true, occupancyNote: null, priceRange: null,
              candidates: [], sourceUrl: `https://tn.tunisiebooking.com/detail_hotel_${q.hotelId}/`, verifiedAt: new Date().toISOString(),
            },
          ],
        }
      );
    },
  };
}

async function withServer(overrides, fn) {
  const service = mockService(overrides);
  const app = createApp({ bearerToken: BEARER, service, rateLimit: { windowMs: 60_000, max: 30 } });
  const server = await startTestServer(app);
  try {
    await fn(server, service);
  } finally {
    await server.close();
  }
}

// ---- health -------------------------------------------------------------------

test("GET /api/health requires no auth and matches the Health schema shape", async () => {
  await withServer({}, async (server) => {
    const res = await server.request("GET", "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
    assert.equal(typeof res.body.version, "string");
    assert.equal(typeof res.body.uptimeSeconds, "number");
    assert.equal(typeof res.body.checks, "object");
  });
});

// ---- auth ------------------------------------------------------------------

test("missing/invalid bearer token -> 401 on protected routes", async () => {
  await withServer({}, async (server) => {
    const noAuth = await server.request("POST", "/api/search", { body: { city: "Tabarka" } });
    assert.equal(noAuth.status, 401);
    const badAuth = await server.request("POST", "/api/search", { body: { city: "Tabarka" }, headers: { Authorization: "Bearer wrong" } });
    assert.equal(badAuth.status, 401);
  });
});

test("createApp refuses to build without a bearer token configured", () => {
  assert.throws(() => createApp({ bearerToken: undefined, service: mockService() }));
});

// ---- /api/search — shape + SSRF/URL rejection ---------------------------------

test("POST /api/search: valid body -> 200, SearchResponse shape", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("POST", "/api/search", { headers: AUTH, body: { name: "La Cigale Tabarka", city: "Tabarka" } });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.hotels));
    assert.equal(res.body.hotels[0].slug, "tn/la-cigale-tabarka");
    assert.equal(typeof res.body.generatedAt, "string");
    assert.equal(service.calls.searchHotels, 1);
  });
});

test("POST /api/search: empty body -> 400 validation_error, service never called", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("POST", "/api/search", { headers: AUTH, body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "validation_error");
    assert.equal(service.calls.searchHotels, 0);
  });
});

test("POST /api/search: rejects a payload carrying a `url` field (SSRF payload) — 400, service never called", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("POST", "/api/search", {
      headers: AUTH,
      body: { name: "Hotel X", url: "http://169.254.169.254" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "validation_error");
    assert.equal(service.calls.searchHotels, 0, "the SSRF payload must never reach the service layer");
  });
});

test("POST /api/search: rejects a `startUrl` Booking-deep-link payload", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("POST", "/api/search", {
      headers: AUTH,
      body: { city: "Tabarka", startUrl: "https://www.booking.com/hotel/tn/x.html" },
    });
    assert.equal(res.status, 400);
    assert.equal(service.calls.searchHotels, 0);
  });
});

// ---- /api/rank — shape + SSRF/path-traversal rejection -------------------------

test("POST /api/rank: valid body -> 200, RankResponse shape (verified/no_price only)", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("POST", "/api/rank", {
      headers: AUTH,
      body: { slug: "tn/la-cigale-tabarka", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2, childrenAges: [10] } },
    });
    assert.equal(res.status, 200);
    assert.ok(["verified", "no_price"].includes(res.body.status));
    assert.ok(Array.isArray(res.body.ranking));
    assert.equal(res.body.fx.pair, "EUR/TND");
    assert.equal(service.calls.rankOffers, 1);
  });
});

test("POST /api/rank: rejects a slug with path traversal — 400, service never called", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("POST", "/api/rank", {
      headers: AUTH,
      body: { slug: "tn/../../etc/passwd", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2 } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "validation_error");
    assert.equal(service.calls.rankOffers, 0);
  });
});

test("POST /api/rank: rejects a window whose span exceeds x-max-window-days", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("POST", "/api/rank", {
      headers: AUTH,
      body: { slug: "tn/x", window: "2026-07-01..2026-09-01", occupants: { adults: 2 } },
    });
    assert.equal(res.status, 400);
    assert.equal(service.calls.rankOffers, 0);
  });
});

test("POST /api/rank: rejects START >= END window", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("POST", "/api/rank", {
      headers: AUTH,
      body: { slug: "tn/x", window: "2026-07-20..2026-07-14", occupants: { adults: 2 } },
    });
    assert.equal(res.status, 400);
    assert.equal(service.calls.rankOffers, 0);
  });
});

test("POST /api/rank: 404 passthrough when the service reports the slug unresolved", async () => {
  const { NotFoundError } = await import("../lib/errors.mjs");
  await withServer(
    { rankOffers: () => { throw new NotFoundError("Aucun hôtel pour ce slug."); } },
    async (server) => {
      const res = await server.request("POST", "/api/rank", {
        headers: AUTH,
        body: { slug: "tn/unknown-hotel", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2 } },
      });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "not_found");
    }
  );
});

test("POST /api/rank: 502 upstream_blocked passthrough (distinct from 200 no_price)", async () => {
  const { UpstreamBlockedError } = await import("../lib/errors.mjs");
  await withServer(
    { rankOffers: () => { throw new UpstreamBlockedError("Canal TunisieBooking bloqué (anti-bot).", "blocked"); } },
    async (server) => {
      const res = await server.request("POST", "/api/rank", {
        headers: AUTH,
        body: { slug: "tn/x", checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2 } },
      });
      assert.equal(res.status, 502);
      assert.equal(res.body.error, "upstream_blocked");
      assert.equal(res.body.channelStatus, "blocked");
    }
  );
});

// ---- /api/hotels/{id}/price — shape + validation --------------------------------

test("GET /api/hotels/{id}/price: valid request -> 200, PriceResponse shape", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request(
      "GET",
      "/api/hotels/354/price?checkin=2026-07-14&checkout=2026-07-16&adults=2&childrenAges=10",
      { headers: AUTH }
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.query.hotelId, 354);
    assert.ok(Array.isArray(res.body.offers));
    assert.equal(service.calls.priceHotel, 1);
  });
});

test("GET /api/hotels/{id}/price: rejects a non-numeric id (e.g. injected string) — 400", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request("GET", "/api/hotels/abc/price?checkin=2026-07-14&checkout=2026-07-16&adults=2", { headers: AUTH });
    assert.equal(res.status, 400);
    assert.equal(service.calls.priceHotel, 0);
  });
});

test("GET /api/hotels/{id}/price: rejects id=0 and negative id", async () => {
  await withServer({}, async (server) => {
    const r1 = await server.request("GET", "/api/hotels/0/price?checkin=2026-07-14&checkout=2026-07-16&adults=2", { headers: AUTH });
    assert.equal(r1.status, 400);
    const r2 = await server.request("GET", "/api/hotels/-5/price?checkin=2026-07-14&checkout=2026-07-16&adults=2", { headers: AUTH });
    assert.equal(r2.status, 400);
  });
});

test("GET /api/hotels/{id}/price: rejects an unknown query param (e.g. `url`)", async () => {
  await withServer({}, async (server, service) => {
    const res = await server.request(
      "GET",
      "/api/hotels/354/price?checkin=2026-07-14&checkout=2026-07-16&adults=2&url=http%3A%2F%2F169.254.169.254",
      { headers: AUTH }
    );
    assert.equal(res.status, 400);
    assert.equal(service.calls.priceHotel, 0);
  });
});

test("GET /api/hotels/{id}/price: rejects checkout before checkin", async () => {
  await withServer({}, async (server) => {
    const res = await server.request("GET", "/api/hotels/354/price?checkin=2026-07-16&checkout=2026-07-14&adults=2", { headers: AUTH });
    assert.equal(res.status, 400);
  });
});

// ---- honesty invariant: verified never carries occupancyVerified:false --------

test("mocked verified offer respects the honesty invariant (occupancyVerified != false)", async () => {
  await withServer({}, async (server) => {
    const res = await server.request("GET", "/api/hotels/354/price?checkin=2026-07-14&checkout=2026-07-16&adults=2", { headers: AUTH });
    for (const offer of res.body.offers) {
      if (offer.status === "verified") {
        assert.notEqual(offer.occupancyVerified, false);
      }
    }
  });
});

// ---- rate limiting ------------------------------------------------------------

test("per-client rate limit -> 429 + Retry-After once the budget is exhausted", async () => {
  const service = mockService();
  const app = createApp({ bearerToken: BEARER, service, rateLimit: { windowMs: 60_000, max: 3 } });
  const server = await startTestServer(app);
  try {
    for (let i = 0; i < 3; i++) {
      const res = await server.request("GET", "/api/health");
      assert.equal(res.status, 200);
    }
    const limited = await server.request("GET", "/api/health");
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate_limited");
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
  } finally {
    await server.close();
  }
});

// ---- security headers -----------------------------------------------------------

test("responses carry hardened security headers (helmet)", async () => {
  await withServer({}, async (server) => {
    const res = await server.request("GET", "/api/health");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.ok(res.headers["content-security-policy"]);
  });
});
