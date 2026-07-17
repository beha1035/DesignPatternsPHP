// e2e: le toggle EUR/TND recalcule l'affichage des prix côté client, SANS
// refaire d'appel réseau (le classement n'est demandé qu'une fois).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { startApp } from "./helpers/server.mjs";
import { makeService, verifiedOffer } from "./helpers/mock-service.mjs";
import { searchAndSelectFirstHotel } from "./helpers/ui.mjs";

let browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

test("le toggle EUR/TND recalcule les prix affichés sans appel réseau supplémentaire", async () => {
  const service = makeService({
    rankOffers: async () => ({
      query: { hotel: "La Cigale Tabarka", window: null, nights: 2, adults: 2, childrenAges: [], childPolicy: null },
      generatedAt: new Date().toISOString(),
      status: "verified",
      fx: { pair: "EUR/TND", rate: 3.37, stale: false, asOf: new Date().toISOString(), source: "open.er-api.com" },
      geo: null,
      channelPlan: { country: "TN", region: "North Africa", matched: true, countrySource: "cache", pricedNow: ["TunisieBooking"], alsoCheck: [], globalApi: null, note: null },
      tiersRun: ["tier1:tunisiebooking"],
      shortCircuited: false,
      best: { channel: "TunisieBooking", room: "Double", board: "breakfast", window: "2026-07-14→2026-07-16", totalEUR: 241, totalTND: 812, sourceUrl: null, corroborated: false, corroboratedBy: null },
      ranking: [verifiedOffer({ channel: "TunisieBooking", totalEUR: 241, totalTND: 812 })],
      unverifiedOccupancy: [],
      browserObserved: [],
      channels: ["TunisieBooking"],
      escalation: [],
    }),
  });
  const app = await startApp({ service });
  const page = await browser.newPage();
  try {
    await searchAndSelectFirstHotel(page, app.url, app.bearerToken, { city: "Tabarka", country: "TN" });
    await page.waitForSelector(".rank-table tbody tr");

    assert.equal(service.calls.rankOffers, 1);

    const eurPrice = await page.locator(".rank-table tbody tr td.price-cell").first().textContent();
    assert.match(eurPrice, /241,00 €/);
    assert.equal(await page.locator("#currency-eur").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#currency-tnd").getAttribute("aria-pressed"), "false");

    await page.click("#currency-tnd");
    const tndPrice = await page.locator(".rank-table tbody tr td.price-cell").first().textContent();
    assert.match(tndPrice, /812,00 DT/);
    assert.equal(await page.locator("#currency-tnd").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#currency-eur").getAttribute("aria-pressed"), "false");

    // Toggling currency must never re-fetch /api/rank.
    assert.equal(service.calls.rankOffers, 1, "currency toggle must be a pure client-side re-render");

    await page.click("#currency-eur");
    const eurAgain = await page.locator(".rank-table tbody tr td.price-cell").first().textContent();
    assert.match(eurAgain, /241,00 €/);
    assert.equal(service.calls.rankOffers, 1);
  } finally {
    await page.close();
    await app.close();
  }
});
