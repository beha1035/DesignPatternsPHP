// Unit tests for browser-rate's pure helpers: money parsing across locales, and
// picking the cheapest PLAUSIBLE stay total (junk taxes like €1/€29 must not win).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney, pickStayTotal, bookingUrl } from "../browser-rate.mjs";

test("parseMoney handles currencies and locale separators", () => {
  assert.equal(parseMoney("€ 797"), 797);
  assert.equal(parseMoney("797 TND"), 797);
  assert.equal(parseMoney("1.234,50 €"), 1234.5); // European
  assert.equal(parseMoney("1,234.50"), 1234.5);   // US
  assert.equal(parseMoney("2 736"), 2736);
  assert.equal(parseMoney("34,50"), 34.5);
  assert.equal(parseMoney("nope"), null);
});

test("pickStayTotal ignores junk below the plausibility floor", () => {
  // The real La Cigale scrape mixed these; €1 and €29 are taxes/fees, not stays.
  const r = pickStayTotal(["€ 341", "€ 797", "€ 456", "€ 1", "€ 29"]);
  assert.equal(r.total, 341); // cheapest PLAUSIBLE room for the party
  assert.ok(!r.candidates.includes(1));
  assert.ok(!r.candidates.includes(29));
});

test("pickStayTotal returns null when everything is junk", () => {
  assert.equal(pickStayTotal(["€1", "€5", ""]).total, null);
});

test("bookingUrl pins the exact party (adults, child ages, currency)", () => {
  const u = bookingUrl({ slug: "tn/tabarka-beach", checkin: "2026-07-14", checkout: "2026-07-16", adults: 2, children: [10], currency: "EUR" });
  assert.match(u, /hotel\/tn\/tabarka-beach\.html/);
  assert.match(u, /group_adults=2/);
  assert.match(u, /group_children=1/);
  assert.match(u, /age=10/);
  assert.match(u, /selected_currency=EUR/);
});
