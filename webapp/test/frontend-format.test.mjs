// Unit tests for webapp/public/js/format.js — pure, no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIsoDate, formatWindow, formatBoard } from "../public/js/format.js";

test("formatIsoDate: YYYY-MM-DD -> DD/MM/YYYY", () => {
  assert.equal(formatIsoDate("2026-07-14"), "14/07/2026");
});

test("formatIsoDate: passthrough for non-ISO input, em dash for nullish", () => {
  assert.equal(formatIsoDate("garbage"), "garbage");
  assert.equal(formatIsoDate(null), "—");
  assert.equal(formatIsoDate(undefined), "—");
});

test("formatWindow: handles the orchestrator's arrow form (checkin→checkout)", () => {
  assert.equal(formatWindow("2026-07-14→2026-07-16"), "14/07/2026 → 16/07/2026");
});

test("formatWindow: handles the request's START..END form", () => {
  assert.equal(formatWindow("2026-07-14..2026-07-20"), "14/07/2026 → 20/07/2026");
});

test("formatWindow: em dash for null/empty", () => {
  assert.equal(formatWindow(null), "—");
  assert.equal(formatWindow(""), "—");
});

test("formatBoard: maps known enum values to French labels", () => {
  assert.equal(formatBoard("all-inclusive"), "Tout compris");
  assert.equal(formatBoard("half-board"), "Demi-pension");
  assert.equal(formatBoard("breakfast"), "Petit-déjeuner");
});

test("formatBoard: unknown/garbage falls back to the honest 'unknown' label", () => {
  assert.equal(formatBoard("unknown"), "Régime inconnu");
  assert.equal(formatBoard("something-else"), "Régime inconnu");
});
