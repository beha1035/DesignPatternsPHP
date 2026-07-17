// e2e: recherche -> /api/rank -> tableau de résultats classé par prix rendu
// correctement, contre un service MOCK déterministe (aucun réseau externe).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { startApp } from "./helpers/server.mjs";
import { makeService, verifiedOffer } from "./helpers/mock-service.mjs";
import { searchAndSelectFirstHotel } from "./helpers/ui.mjs";

let browser;
let app;
let service;

before(async () => {
  browser = await launchBrowser();
  service = makeService({
    rankOffers: async () => ({
      query: { hotel: "La Cigale Tabarka", window: "2026-07-14..2026-07-20", nights: 2, adults: 2, childrenAges: [], childPolicy: null },
      generatedAt: new Date().toISOString(),
      status: "verified",
      fx: { pair: "EUR/TND", rate: 3.37, stale: false, asOf: new Date().toISOString(), source: "open.er-api.com" },
      geo: null,
      channelPlan: { country: "TN", region: "North Africa", matched: true, countrySource: "cache", pricedNow: ["TunisieBooking"], alsoCheck: [], globalApi: null, note: null },
      tiersRun: ["tier1:tunisiebooking"],
      shortCircuited: false,
      best: { channel: "TunisieBooking", room: "Chambre Double", board: "breakfast", window: "2026-07-14→2026-07-16", totalEUR: 241, totalTND: 812, sourceUrl: "https://tn.tunisiebooking.com/detail_hotel_354/", corroborated: false, corroboratedBy: null },
      ranking: [
        verifiedOffer({ channel: "TunisieBooking (séjour long)", totalEUR: 390, totalTND: 1314, window: "2026-07-18→2026-07-20" }),
        verifiedOffer({ channel: "TunisieBooking", totalEUR: 241, totalTND: 812, window: "2026-07-14→2026-07-16" }),
      ],
      unverifiedOccupancy: [],
      browserObserved: [],
      channels: ["TunisieBooking"],
      escalation: [],
    }),
  });
  app = await startApp({ service });
});

after(async () => {
  await app.close();
  await browser.close();
});

test("recherche -> sélection hôtel -> classement rendu, trié par prix croissant", async () => {
  const page = await browser.newPage();
  try {
    await searchAndSelectFirstHotel(page, app.url, app.bearerToken, { city: "Tabarka", country: "TN" });

    await page.waitForSelector(".rank-table tbody tr");
    const rows = page.locator(".rank-table tbody tr");
    assert.equal(await rows.count(), 2, "both ranking offers should render as rows");

    // Sorted ascending by price: 241 before 390.
    const prices = await page.locator(".rank-table tbody tr td.price-cell").allTextContents();
    assert.match(prices[0], /241,00/);
    assert.match(prices[1], /390,00/);

    // The cheapest row is the honest verified one and carries the "best" marker.
    const firstRowClass = await rows.nth(0).getAttribute("class");
    assert.match(firstRowClass || "", /row-best/);
    const firstBadges = await rows.nth(0).locator(".badge").allTextContents();
    assert.ok(firstBadges.includes("Vérifié"));
    assert.ok(firstBadges.some((b) => b.includes("meilleur prix")));

    // The summary callout names the actually-cheapest verified channel.
    const summary = await page.locator(".table-summary").textContent();
    assert.match(summary, /241,00/);
    assert.match(summary, /TunisieBooking/);

    // fx block is shown.
    const fxText = await page.locator("#fx-info").textContent();
    assert.match(fxText, /3,37/);
  } finally {
    await page.close();
  }
});
