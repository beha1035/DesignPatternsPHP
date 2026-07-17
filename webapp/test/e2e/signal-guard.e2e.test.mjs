// e2e: un prix `signal` (occupancyVerified:false, via unverifiedOccupancy)
// n'est JAMAIS présenté comme le meilleur prix, même s'il est moins cher que
// l'offre vérifiée — docs/adr/0003-price-scope.md.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { startApp } from "./helpers/server.mjs";
import { makeService, verifiedOffer } from "./helpers/mock-service.mjs";
import { searchAndSelectFirstHotel } from "./helpers/ui.mjs";

let browser;
let app;

before(async () => {
  browser = await launchBrowser();
  const service = makeService({
    rankOffers: async () => ({
      query: { hotel: "La Cigale Tabarka", window: "2026-07-14..2026-07-20", nights: 2, adults: 2, childrenAges: [], childPolicy: null },
      generatedAt: new Date().toISOString(),
      status: "verified",
      fx: { pair: "EUR/TND", rate: 3.37, stale: false, asOf: new Date().toISOString(), source: "open.er-api.com" },
      geo: null,
      channelPlan: { country: "TN", region: "North Africa", matched: true, countrySource: "cache", pricedNow: ["TunisieBooking"], alsoCheck: [], globalApi: null, note: null },
      tiersRun: ["tier1:tunisiebooking", "tier0:google-hotels"],
      shortCircuited: false,
      best: {
        channel: "TunisieBooking",
        room: "Chambre Double",
        board: "breakfast",
        window: "2026-07-14→2026-07-16",
        totalEUR: 241,
        totalTND: 812,
        sourceUrl: "https://tn.tunisiebooking.com/detail_hotel_354/",
        corroborated: false,
        corroboratedBy: null,
      },
      // Deliberately adversarial: the ONLY verified offer is pricier than the
      // unverified "signal" — the UI must never let the cheaper signal win.
      ranking: [verifiedOffer({ channel: "TunisieBooking", totalEUR: 241, totalTND: 812 })],
      unverifiedOccupancy: [
        { channel: "Booking.com (headline)", priceEUR: 99, note: "Prix vitrine — occupation non confirmée." },
      ],
      browserObserved: [],
      channels: ["TunisieBooking", "Google Hotels"],
      escalation: [],
    }),
  });
  app = await startApp({ service });
});

after(async () => {
  await app.close();
  await browser.close();
});

test("un prix Signal moins cher n'est jamais marqué comme meilleur prix", async () => {
  const page = await browser.newPage();
  try {
    await searchAndSelectFirstHotel(page, app.url, app.bearerToken, { city: "Tabarka", country: "TN" });
    await page.waitForSelector(".rank-table tbody tr");

    const rows = page.locator(".rank-table tbody tr");
    assert.equal(await rows.count(), 2);

    // Cheapest-first sort: the 99€ signal row comes first...
    const firstPrice = await rows.nth(0).locator("td.price-cell").textContent();
    assert.match(firstPrice, /99,00/);
    const firstBadges = await rows.nth(0).locator(".badge").allTextContents();
    assert.ok(firstBadges.includes("Signal"), `expected a Signal badge, got: ${firstBadges}`);
    assert.ok(!firstBadges.includes("Vérifié"), "the cheap signal row must never be badged Vérifié");
    const firstRowClass = await rows.nth(0).getAttribute("class");
    assert.ok(!firstRowClass || !firstRowClass.includes("row-best"), "the signal row must not carry row-best");
    assert.ok(!firstBadges.some((b) => b.includes("meilleur prix")), "the signal row must not claim to be the best price");

    // ...but the SECOND (pricier, verified) row is the one marked best.
    const secondPrice = await rows.nth(1).locator("td.price-cell").textContent();
    assert.match(secondPrice, /241,00/);
    const secondBadges = await rows.nth(1).locator(".badge").allTextContents();
    assert.ok(secondBadges.includes("Vérifié"));
    assert.ok(secondBadges.some((b) => b.includes("meilleur prix")));
    assert.match(await rows.nth(1).getAttribute("class"), /row-best/);

    // The summary callout must reference the honest (241) price, never 99.
    const summary = await page.locator(".table-summary").textContent();
    assert.match(summary, /241,00/);
    assert.doesNotMatch(summary, /99,00/);
  } finally {
    await page.close();
  }
});
