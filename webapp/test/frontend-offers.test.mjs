// Unit tests for webapp/public/js/offers.js — pure row-building/sorting and,
// crucially, the honesty guard that ensures a `signal` (occupancyVerified:false)
// price can NEVER be picked as "meilleur prix" even if it's cheaper than a
// verified offer (docs/adr/0003-price-scope.md, data-model.md invariant #2).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  statusLabel,
  statusBadgeClass,
  buildUnifiedRows,
  sortRowsByPrice,
  isHonestVerifiedRow,
  pickBestRowIndex,
} from "../public/js/offers.js";

test("statusLabel: honest French labels for every OfferStatus enum value", () => {
  assert.equal(statusLabel("verified"), "Vérifié");
  assert.equal(statusLabel("signal"), "Signal");
  assert.equal(statusLabel("no_price"), "Indisponible");
  assert.equal(statusLabel("blocked"), "Indisponible");
  assert.equal(statusLabel("drift"), "Indisponible");
  assert.equal(statusLabel("garbage"), "Indisponible");
});

test("statusBadgeClass: verified/signal get distinct classes, everything else is 'unavailable'", () => {
  assert.equal(statusBadgeClass("verified"), "badge badge-verified");
  assert.equal(statusBadgeClass("signal"), "badge badge-signal");
  assert.equal(statusBadgeClass("no_price"), "badge badge-unavailable");
});

test("isHonestVerifiedRow: true only for status:verified AND occupancyVerified !== false", () => {
  assert.equal(isHonestVerifiedRow({ status: "verified", occupancyVerified: true }), true);
  assert.equal(isHonestVerifiedRow({ status: "verified" }), true); // occupancyVerified absent/null is fine
  assert.equal(isHonestVerifiedRow({ status: "verified", occupancyVerified: false }), false);
  assert.equal(isHonestVerifiedRow({ status: "signal", occupancyVerified: false }), false);
  assert.equal(isHonestVerifiedRow({ status: "no_price" }), false);
  assert.equal(isHonestVerifiedRow(null), false);
});

test("buildUnifiedRows: ranking offers keep their real status/occupancyVerified", () => {
  const rows = buildUnifiedRows({
    ranking: [
      { channel: "TunisieBooking", room: "Double", board: "breakfast", totalEUR: 241, totalTND: 812, status: "verified", occupancyVerified: true, sourceUrl: "https://tn.tunisiebooking.com/x" },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "verified");
  assert.equal(rows[0].occupancyVerified, true);
  assert.equal(rows[0].priceEUR, 241);
  assert.equal(rows[0].sourceUrl, "https://tn.tunisiebooking.com/x");
});

test("buildUnifiedRows: unverifiedOccupancy/browserObserved rows are FORCED to status:signal, occupancyVerified:false", () => {
  const rows = buildUnifiedRows({
    ranking: [],
    unverifiedOccupancy: [{ channel: "Apify/Booking.com", priceEUR: 190, note: "headline price" }],
    browserObserved: [{ channel: "Booking.com (browser)", priceEUR: 175, note: "candidate price" }],
  });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "signal");
    assert.equal(row.occupancyVerified, false);
  }
});

test("buildUnifiedRows: never fabricates a price — a row with no derivable amount stays null", () => {
  const rows = buildUnifiedRows({ ranking: [{ channel: "X", status: "no_price" }] });
  assert.equal(rows[0].priceEUR, null);
  assert.equal(rows[0].priceTND, null);
});

test("sortRowsByPrice: ascending by priceEUR, rows with no price sink to the end", () => {
  const sorted = sortRowsByPrice([
    { channel: "B", priceEUR: 300 },
    { channel: "C", priceEUR: null },
    { channel: "A", priceEUR: 100 },
  ]);
  assert.deepEqual(sorted.map((r) => r.channel), ["A", "B", "C"]);
});

test("pickBestRowIndex: THE critical guard — a cheaper `signal` row is never chosen over a pricier `verified` row", () => {
  // Deliberately adversarial ordering: cheapest row is a `signal`
  // (occupancyVerified:false); a `verified` row is second/pricier.
  const rows = sortRowsByPrice(
    buildUnifiedRows({
      ranking: [{ channel: "TunisieBooking", totalEUR: 241, status: "verified", occupancyVerified: true }],
      unverifiedOccupancy: [{ channel: "Booking.com (signal)", priceEUR: 100, note: "vitrine, non confirmé" }],
    })
  );
  // Cheapest-first order is the signal row...
  assert.equal(rows[0].channel, "Booking.com (signal)");
  assert.equal(rows[0].status, "signal");
  // ...but the picked "best" index must be the honest verified one, not index 0.
  const bestIndex = pickBestRowIndex(rows);
  assert.equal(rows[bestIndex].channel, "TunisieBooking");
  assert.equal(rows[bestIndex].status, "verified");
});

test("pickBestRowIndex: even a mislabelled row (status:verified but occupancyVerified:false) is never picked", () => {
  // Guards against a malformed/adversarial upstream payload, not just the
  // well-behaved shape the real API is documented to send.
  const rows = [
    { channel: "Suspicious", status: "verified", occupancyVerified: false, priceEUR: 50 },
    { channel: "Honest", status: "verified", occupancyVerified: true, priceEUR: 300 },
  ];
  const bestIndex = pickBestRowIndex(rows);
  assert.equal(rows[bestIndex].channel, "Honest");
});

test("pickBestRowIndex: returns -1 when no row qualifies (all signals / no_price)", () => {
  const rows = buildUnifiedRows({ unverifiedOccupancy: [{ channel: "X", priceEUR: 50 }] });
  assert.equal(pickBestRowIndex(rows), -1);
});
