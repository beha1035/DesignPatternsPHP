// Unit tests for the pure discovery helpers — the fuzzy match must pick the
// RIGHT hotel even when the city name is shared by every listing (the bug that
// once matched "La Cigale Tabarka" to "Residence Mehari Tabarka").

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPairs, bestMatch, slugify, citySlug } from "../discover-hotel.mjs";

const LIST = `
  <a href="detail_hotel_224/"><img alt="Dar Ismail"></a>
  <a href="detail_hotel_314/"><img alt="Residence Mehari Tabarka"></a>
  <a href="detail_hotel_354/"><img alt="La Cigale"></a>
  <a href="detail_hotel_980/"><img alt="Mehari Tabarka"></a>
`;

test("extractPairs maps hotel id -> name", () => {
  const p = extractPairs(LIST);
  assert.equal(p.get("354"), "La Cigale");
  assert.equal(p.get("224"), "Dar Ismail");
});

test("bestMatch ignores the shared city word and picks La Cigale (354)", () => {
  const m = bestMatch(extractPairs(LIST), "La Cigale Tabarka", "Tabarka");
  assert.equal(m.id, "354");
});

test("bestMatch resolves a distinct hotel correctly", () => {
  const m = bestMatch(extractPairs(LIST), "Dar Ismail", "Tabarka");
  assert.equal(m.id, "224");
});

test("bestMatch returns null when nothing overlaps", () => {
  assert.equal(bestMatch(extractPairs(LIST), "Four Seasons Paris", "Paris"), null);
});

test("slug/citySlug normalize accents and spaces", () => {
  assert.equal(slugify("La Cigale Tabarka"), "la-cigale-tabarka");
  assert.equal(citySlug("Hammamet"), "hammamet");
});
