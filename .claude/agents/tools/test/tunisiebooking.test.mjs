// Parser reliability tests for tunisiebooking-rate. These run against SAVED HTML
// fixtures (no network), so they catch site-markup drift the moment it breaks the
// parser instead of letting a wrong/empty price slip through in production.
//
//   node --test .claude/agents/tools/test/
//
// Refresh fixtures with tools/test/refresh-fixtures.sh when the site legitimately
// changes and the parser has been updated to match.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyze, parseOffers } from "../tunisiebooking-rate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(HERE, "fixtures", name), { encoding: "latin1" });
const A = { hotelId: "354", ville: "Tabarka", adults: 2, children: [10], rooms: 1,
  checkin: "2026-07-14", checkout: "2026-07-16" };

test("verified fixture -> the known La Cigale rate", () => {
  const { status, offers } = analyze(fixture("tunisiebooking-354-verified.html"), A, 2);
  assert.equal(status, "verified");
  assert.ok(offers.length >= 1, "expected at least one offer");
  const best = offers[0];
  // 2682 TND base + 2% booking fee = 2736; the room is the Triple Superieure.
  assert.equal(best.baseBeforeFee, 2682);
  assert.equal(best.total, 2736);
  assert.equal(best.currency, "TND");
  assert.match(best.room, /triple sup/i);
  assert.equal(best.board, "breakfast");
  assert.equal(best.status, "verified");
});

test("sold-out fixture -> honest no_price, no fabricated offer", () => {
  const { status, offers } = analyze(fixture("tunisiebooking-354-nodispo.html"), A, 2);
  assert.equal(status, "no_price");
  assert.equal(offers.length, 0);
});

test("markup drift -> loud 'drift', never a silent no_price", () => {
  // Rooms still render but price_* fields were renamed: the canary must fire.
  const { status, offers } = analyze(fixture("tunisiebooking-354-drift.html"), A, 2);
  assert.equal(status, "drift");
  assert.equal(offers.length, 0);
});

test("parseOffers is pure and returns sorted-by-total offers", () => {
  const offers = parseOffers(fixture("tunisiebooking-354-verified.html"), A, 2);
  for (let i = 1; i < offers.length; i++) {
    assert.ok(offers[i].total >= offers[i - 1].total, "offers must be ascending");
  }
});
