// Unit tests for webapp/public/js/currency.js — pure, no DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eurToTnd, tndToEur, amountForCurrency, formatMoney, formatFxRate } from "../public/js/currency.js";

const RATE = 3.37; // TND per EUR, matches webapp/service.mjs's convention

test("eurToTnd / tndToEur are (rounded) inverses of each other", () => {
  assert.equal(eurToTnd(100, RATE), 337);
  assert.equal(tndToEur(337, RATE), 100);
});

test("eurToTnd / tndToEur: null amount or missing rate yields null (never a fabricated number)", () => {
  assert.equal(eurToTnd(null, RATE), null);
  assert.equal(eurToTnd(100, 0), null);
  assert.equal(eurToTnd(100, null), null);
  assert.equal(tndToEur(null, RATE), null);
  assert.equal(tndToEur(100, 0), null);
});

test("amountForCurrency: prefers the directly-known amount over converting", () => {
  assert.equal(amountForCurrency({ eur: 241, tnd: 812 }, "EUR", RATE), 241);
  assert.equal(amountForCurrency({ eur: 241, tnd: 812 }, "TND", RATE), 812);
});

test("amountForCurrency: derives the missing side via the fx rate", () => {
  assert.equal(amountForCurrency({ eur: 100, tnd: null }, "TND", RATE), 337);
  assert.equal(amountForCurrency({ eur: null, tnd: 337 }, "EUR", RATE), 100);
});

test("amountForCurrency: returns null (not 0/NaN) when nothing is derivable", () => {
  assert.equal(amountForCurrency({ eur: null, tnd: null }, "EUR", RATE), null);
  assert.equal(amountForCurrency({ eur: null, tnd: null }, "TND", RATE), null);
});

test("formatMoney: fr-FR formatting with a stable currency symbol, 2 decimals", () => {
  assert.equal(formatMoney(241, "EUR"), "241,00 €");
  assert.equal(formatMoney(812, "TND"), "812,00 DT");
  assert.equal(formatMoney(1234.5, "EUR"), "1 234,50 €");
});

test("formatMoney: null/NaN render as an em dash, never as 0 or a fabricated value", () => {
  assert.equal(formatMoney(null, "EUR"), "—");
  assert.equal(formatMoney(NaN, "EUR"), "—");
});

test("formatFxRate: shows the pair and flags a stale (fallback) rate", () => {
  assert.match(formatFxRate({ rate: 3.37, stale: false }), /3,37/);
  assert.doesNotMatch(formatFxRate({ rate: 3.37, stale: false }), /approximatif/);
  assert.match(formatFxRate({ rate: 3.37, stale: true }), /approximatif/);
});

test("formatFxRate: handles a missing fx block", () => {
  assert.equal(formatFxRate(null), "Taux de change indisponible.");
});
