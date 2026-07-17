// Unit tests for webapp/public/js/validate.js — pure client-side mirror of
// webapp/lib/validate.mjs. The API stays the authority; these tests only
// pin down the UX-layer mirror.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSearchForm,
  validateOccupants,
  validateDates,
  buildSearchRequestBody,
  buildRankRequestBody,
  MAX_WINDOW_DAYS,
} from "../public/js/validate.js";

// ---- validateSearchForm --------------------------------------------------------

test("validateSearchForm: requires at least one of name/city", () => {
  const res = validateSearchForm({ name: "", city: "" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.query);
});

test("validateSearchForm: accepts a valid name-only or city-only query", () => {
  assert.equal(validateSearchForm({ name: "La Cigale Tabarka" }).ok, true);
  assert.equal(validateSearchForm({ city: "Tabarka" }).ok, true);
});

test("validateSearchForm: rejects a name/city carrying URL-ish/forbidden characters", () => {
  const res = validateSearchForm({ name: "http://169.254.169.254" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.name);
});

test("validateSearchForm: normalises a lowercase-but-valid ISO2 country before validating (mirrors buildSearchRequestBody)", () => {
  assert.equal(validateSearchForm({ city: "Tabarka", country: "tn" }).ok, true);
  assert.equal(validateSearchForm({ city: "Tabarka", country: "TN" }).ok, true);
});

test("validateSearchForm: rejects a country code that isn't 2 letters even after normalising", () => {
  const res = validateSearchForm({ city: "Tabarka", country: "TUN" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.country);
  assert.equal(validateSearchForm({ city: "Tabarka", country: "12" }).ok, false);
});

// ---- validateOccupants ----------------------------------------------------------

test("validateOccupants: adults must be an integer in [1,8]", () => {
  assert.equal(validateOccupants({ adults: 2, childrenAges: [] }).ok, true);
  assert.equal(validateOccupants({ adults: 0, childrenAges: [] }).ok, false);
  assert.equal(validateOccupants({ adults: 9, childrenAges: [] }).ok, false);
  assert.equal(validateOccupants({ adults: 2.5, childrenAges: [] }).ok, false);
});

test("validateOccupants: at most 6 children, each age in [0,17]", () => {
  assert.equal(validateOccupants({ adults: 2, childrenAges: [10, 4] }).ok, true);
  assert.equal(validateOccupants({ adults: 2, childrenAges: new Array(7).fill(5) }).ok, false);
  assert.equal(validateOccupants({ adults: 2, childrenAges: [18] }).ok, false);
  assert.equal(validateOccupants({ adults: 2, childrenAges: [-1] }).ok, false);
});

// ---- validateDates ---------------------------------------------------------------

test("validateDates: valid flexible window within the max span", () => {
  const res = validateDates({ mode: "window", window: "2026-07-14..2026-07-20", nights: 2 });
  assert.equal(res.ok, true);
});

test("validateDates: window START must be strictly before END", () => {
  const res = validateDates({ mode: "window", window: "2026-07-20..2026-07-14", nights: 2 });
  assert.equal(res.ok, false);
  assert.ok(res.errors.window);
});

test(`validateDates: window span > ${MAX_WINDOW_DAYS}d is rejected`, () => {
  const res = validateDates({ mode: "window", window: "2026-07-01..2026-09-01", nights: 2 });
  assert.equal(res.ok, false);
  assert.match(res.errors.window, /maximum/);
});

test("validateDates: fixed checkin/checkout — checkout must be after checkin", () => {
  const res = validateDates({ mode: "fixed", checkin: "2026-07-16", checkout: "2026-07-14" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.checkout);
});

test("validateDates: fixed dates within the max span are accepted", () => {
  const res = validateDates({ mode: "fixed", checkin: "2026-07-14", checkout: "2026-07-16" });
  assert.equal(res.ok, true);
});

test("validateDates: rejects an unknown mode", () => {
  const res = validateDates({ mode: "" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.mode);
});

// ---- request builders -------------------------------------------------------------

test("buildSearchRequestBody: trims and only includes provided fields (mirrors additionalProperties:false)", () => {
  assert.deepEqual(buildSearchRequestBody({ name: "  La Cigale  ", city: "", country: "" }), { name: "La Cigale" });
  assert.deepEqual(buildSearchRequestBody({ city: "Tabarka", country: "tn" }), { city: "Tabarka", country: "TN" });
});

test("buildRankRequestBody: window mode never includes checkin/checkout (API rejects both together)", () => {
  const body = buildRankRequestBody({
    slug: "tn/la-cigale-tabarka",
    mode: "window",
    window: "2026-07-14..2026-07-20",
    nights: 2,
    adults: 2,
    childrenAges: [10],
  });
  assert.equal(body.slug, "tn/la-cigale-tabarka");
  assert.equal(body.window, "2026-07-14..2026-07-20");
  assert.equal(body.nights, 2);
  assert.equal("checkin" in body, false);
  assert.equal("checkout" in body, false);
  assert.deepEqual(body.occupants, { adults: 2, childrenAges: [10] });
});

test("buildRankRequestBody: fixed mode never includes window/nights", () => {
  const body = buildRankRequestBody({
    slug: "tn/la-cigale-tabarka",
    mode: "fixed",
    checkin: "2026-07-14",
    checkout: "2026-07-16",
    adults: 2,
    childrenAges: [],
  });
  assert.equal(body.checkin, "2026-07-14");
  assert.equal(body.checkout, "2026-07-16");
  assert.equal("window" in body, false);
  assert.equal("nights" in body, false);
});

test("buildRankRequestBody: defaults currency to EUR and escalate to false", () => {
  const body = buildRankRequestBody({ slug: "tn/x", mode: "fixed", checkin: "2026-07-14", checkout: "2026-07-16", adults: 2 });
  assert.equal(body.currency, "EUR");
  assert.equal(body.escalate, false);
});
