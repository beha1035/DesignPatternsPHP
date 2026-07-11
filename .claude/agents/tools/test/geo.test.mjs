// Tests for the pure geo ranking — the ambiguous-city trap ("Djerba" also exists
// in Algeria) must resolve to the famous place by importance, and a country hint
// must filter. No network: we feed Nominatim-shaped rows to pickBestPlace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBestPlace } from "../lib/geo.mjs";

const ROWS = [
  { display_name: "Djerba, Bejaia, Algeria", addresstype: "village", importance: 0.21,
    address: { village: "Djerba", country: "Algeria", country_code: "dz" } },
  { display_name: "Djerba Island, Medenine, Tunisia", addresstype: "island", importance: 0.54,
    address: { island: "Djerba", country: "Tunisia", country_code: "tn" } },
];

test("ambiguous city resolves to the higher-importance place (Tunisia, not Algeria)", () => {
  const b = pickBestPlace(ROWS);
  assert.equal(b.country, "TN");
  assert.match(b.countryName, /Tunisia/);
});

test("a country hint filters to the hinted country", () => {
  const b = pickBestPlace(ROWS, "dz");
  assert.equal(b.country, "DZ");
});

test("returns null on empty input", () => {
  assert.equal(pickBestPlace([]), null);
  assert.equal(pickBestPlace(null), null);
});

test("uppercases the ISO country code", () => {
  const b = pickBestPlace([ROWS[1]]);
  assert.equal(b.country, "TN");
  assert.equal(b.city, "Djerba");
});

test("name gate beats importance: 'Cancun' is not fuzzy-matched to 'Changchun'", () => {
  const rows = [
    { display_name: "Changchun City, Jilin, China", addresstype: "city", importance: 0.615,
      address: { city: "Changchun", country: "China", country_code: "cn" } },
    { display_name: "Cancún, Quintana Roo, Mexico", addresstype: "city", importance: 0.594,
      address: { city: "Cancún", country: "Mexico", country_code: "mx" } },
  ];
  const b = pickBestPlace(rows, null, "Cancun");
  assert.equal(b.country, "MX");
});
