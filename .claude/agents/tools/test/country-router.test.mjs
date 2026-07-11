// Tests for the country channel router: the right local channels surface per
// country, implemented tools are separated from recommended manual checks, and
// an unknown country falls back to the global default (never an empty plan).

import { test } from "node:test";
import assert from "node:assert/strict";
import { planForCountry } from "../lib/country-router.mjs";

test("Tunisia prioritises TunisieBooking as an actionable Tier-1 channel", async () => {
  const p = await planForCountry("TN");
  assert.equal(p.matched, true);
  const tb = p.actionable.find((c) => c.channel === "TunisieBooking");
  assert.ok(tb, "TunisieBooking should be actionable for TN");
  assert.equal(tb.tier, 1);
  assert.equal(tb.tool, "tunisiebooking-rate.mjs");
});

test("Southeast Asia (Thailand) recommends Agoda / Traveloka", async () => {
  const p = await planForCountry("TH");
  const names = [...p.actionable, ...p.recommended].map((c) => c.channel);
  assert.ok(names.includes("Agoda"));
  assert.ok(names.includes("Traveloka"));
});

test("Brazil recommends Decolar (Despegar)", async () => {
  const p = await planForCountry("BR");
  assert.ok(p.recommended.some((c) => /decolar/i.test(c.channel)));
});

test("unknown country falls back to the default plan, never empty", async () => {
  const p = await planForCountry("ZZ");
  assert.equal(p.matched, false);
  assert.ok(p.actionable.length + p.recommended.length > 0);
  // Google Hotels is always an implemented baseline.
  assert.ok(p.actionable.some((c) => c.tool === "google-hotels-rate.mjs"));
});

test("lowercase / null inputs are handled", async () => {
  assert.equal((await planForCountry("tn")).matched, true);
  assert.equal((await planForCountry(null)).matched, false);
});

test("every plan carries citable sources", async () => {
  const p = await planForCountry("MA");
  assert.ok(Array.isArray(p.sources) && p.sources.length >= 3);
  assert.ok(p.sources.every((s) => s.url && s.title));
});
