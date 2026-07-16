// Unit tests for strict input validation (docs/api/openapi.yaml schemas). No
// network involved — pure schema parsing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchRequest,
  parseRankRequest,
  parsePricePath,
  parsePriceQuery,
  parseSlugParts,
  MAX_WINDOW_DAYS,
} from "../lib/validate.mjs";

// ---- SearchRequest -----------------------------------------------------------

test("search: accepts name-only and city-only payloads", () => {
  assert.equal(parseSearchRequest({ name: "La Cigale Tabarka" }).ok, true);
  assert.equal(parseSearchRequest({ city: "Tabarka" }).ok, true);
  assert.equal(parseSearchRequest({ city: "Tabarka", country: "TN" }).ok, true);
});

test("search: rejects an empty body (neither name nor city)", () => {
  const r = parseSearchRequest({});
  assert.equal(r.ok, false);
});

test("search: rejects an unrecognized field (additionalProperties:false) — the anti-SSRF net", () => {
  const r = parseSearchRequest({ name: "Hotel X", url: "http://169.254.169.254" });
  assert.equal(r.ok, false, "an `url` field must never be accepted");
});

test("search: rejects a bookingUrl-shaped field even though it is not a recognized name", () => {
  const r = parseSearchRequest({ city: "Tabarka", bookingUrl: "https://evil.com" });
  assert.equal(r.ok, false);
});

test("search: rejects a name/city containing forbidden characters", () => {
  assert.equal(parseSearchRequest({ name: "<script>alert(1)</script>" }).ok, false);
  assert.equal(parseSearchRequest({ city: "http://evil.com" }).ok, false);
});

// ---- Slug / RankRequest -------------------------------------------------------

test("slug pattern accepts the canonical example", () => {
  const r = parseRankRequest({
    slug: "tn/la-cigale-tabarka",
    checkin: "2026-07-14",
    checkout: "2026-07-16",
    occupants: { adults: 2, childrenAges: [10] },
  });
  assert.equal(r.ok, true);
});

test("slug pattern rejects path traversal", () => {
  const attempts = ["tn/../../etc/passwd", "../tn/x", "tn/..", "tn/./x", "TN/x", "t/xx"];
  for (const slug of attempts) {
    const r = parseRankRequest({
      slug, checkin: "2026-07-14", checkout: "2026-07-16",
      occupants: { adults: 2 },
    });
    assert.equal(r.ok, false, `slug "${slug}" must be rejected`);
  }
});

test("slug pattern rejects an embedded URL / scheme", () => {
  const attempts = [
    "tn/http://evil.com",
    "tn/https:--evil.com",
    "tn/evil.com",
  ];
  for (const slug of attempts) {
    // "evil.com" alone actually matches [a-z0-9-]+ (dots aren't allowed
    // though) — dots specifically must be rejected since a slug segment
    // must not be able to encode a hostname.
    const r = parseRankRequest({
      slug, checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2 },
    });
    assert.equal(r.ok, false, `slug "${slug}" must be rejected`);
  }
});

test("rank: requires exactly one of slug / slugs", () => {
  const base = { checkin: "2026-07-14", checkout: "2026-07-16", occupants: { adults: 2 } };
  assert.equal(parseRankRequest({ ...base }).ok, false, "neither slug nor slugs");
  assert.equal(
    parseRankRequest({ ...base, slug: "tn/a", slugs: ["tn/a", "tn/b"] }).ok,
    false,
    "both slug and slugs"
  );
  assert.equal(parseRankRequest({ ...base, slugs: ["tn/a", "tn/b"] }).ok, true);
});

test("rank: requires exactly one of window / (checkin+checkout)", () => {
  const base = { slug: "tn/x", occupants: { adults: 2 } };
  assert.equal(parseRankRequest({ ...base }).ok, false);
  assert.equal(
    parseRankRequest({ ...base, window: "2026-07-14..2026-07-20", checkin: "2026-07-14", checkout: "2026-07-16" }).ok,
    false
  );
});

test("rank: rejects window START >= END", () => {
  const r = parseRankRequest({
    slug: "tn/x", window: "2026-07-20..2026-07-14", occupants: { adults: 2 },
  });
  assert.equal(r.ok, false);
});

test("rank: rejects window START == END", () => {
  const r = parseRankRequest({
    slug: "tn/x", window: "2026-07-14..2026-07-14", occupants: { adults: 2 },
  });
  assert.equal(r.ok, false);
});

test(`rank: rejects a window spanning more than x-max-window-days (${MAX_WINDOW_DAYS})`, () => {
  const r = parseRankRequest({
    slug: "tn/x", window: "2026-07-01..2026-08-15", occupants: { adults: 2 }, // 45 days
  });
  assert.equal(r.ok, false);
});

test("rank: accepts a window exactly at the max-window-days boundary", () => {
  const r = parseRankRequest({
    slug: "tn/x", window: "2026-07-01..2026-07-31", occupants: { adults: 2 }, // 30 days
  });
  assert.equal(r.ok, true);
});

test("rank: rejects checkout <= checkin (fixed dates)", () => {
  assert.equal(
    parseRankRequest({ slug: "tn/x", checkin: "2026-07-16", checkout: "2026-07-14", occupants: { adults: 2 } }).ok,
    false
  );
  assert.equal(
    parseRankRequest({ slug: "tn/x", checkin: "2026-07-16", checkout: "2026-07-16", occupants: { adults: 2 } }).ok,
    false
  );
});

test("rank: rejects unknown fields, e.g. `bookingUrl`/`startUrl`", () => {
  const r = parseRankRequest({
    slug: "tn/x", checkin: "2026-07-14", checkout: "2026-07-16",
    occupants: { adults: 2 }, startUrl: "https://www.booking.com/hotel/whatever.html",
  });
  assert.equal(r.ok, false);
});

test("rank: occupants bounds enforced (adults 1..8, childrenAges 0..17, max 6)", () => {
  const base = { slug: "tn/x", checkin: "2026-07-14", checkout: "2026-07-16" };
  assert.equal(parseRankRequest({ ...base, occupants: { adults: 0 } }).ok, false);
  assert.equal(parseRankRequest({ ...base, occupants: { adults: 9 } }).ok, false);
  assert.equal(parseRankRequest({ ...base, occupants: { adults: 2, childrenAges: [18] } }).ok, false);
  assert.equal(
    parseRankRequest({ ...base, occupants: { adults: 2, childrenAges: [1, 2, 3, 4, 5, 6, 7] } }).ok,
    false
  );
});

// ---- /api/hotels/{id}/price ---------------------------------------------------

test("price path: accepts a positive integer id", () => {
  const r = parsePricePath({ id: "354" });
  assert.equal(r.ok, true);
  assert.equal(r.data.id, 354);
});

test("price path: rejects zero, negative, non-integer, and non-numeric ids", () => {
  for (const id of ["0", "-1", "1.5", "abc", "354; DROP TABLE", "354/../1"]) {
    assert.equal(parsePricePath({ id }).ok, false, `id "${id}" must be rejected`);
  }
});

test("price path: rejects an id that is actually a URL", () => {
  assert.equal(parsePricePath({ id: "https://evil.com" }).ok, false);
});

test("price query: valid example passes and normalizes childrenAges", () => {
  const r = parsePriceQuery({ checkin: "2026-07-14", checkout: "2026-07-16", adults: "2", childrenAges: "10,4" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.childrenAges, [10, 4]);
});

test("price query: rejects checkout before/equal checkin", () => {
  assert.equal(parsePriceQuery({ checkin: "2026-07-16", checkout: "2026-07-14", adults: "2" }).ok, false);
});

test("price query: rejects unknown query params", () => {
  const r = parsePriceQuery({ checkin: "2026-07-14", checkout: "2026-07-16", adults: "2", url: "http://evil.com" });
  assert.equal(r.ok, false);
});

// ---- parseSlugParts -----------------------------------------------------------

test("parseSlugParts splits the country prefix from the key", () => {
  assert.deepEqual(parseSlugParts("tn/la-cigale-tabarka"), { countryPart: "tn", key: "la-cigale-tabarka" });
});
