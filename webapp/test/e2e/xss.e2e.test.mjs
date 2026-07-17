// e2e: un payload XSS renvoyé par le mock (comme un scraper amont pourrait en
// produire un) dans un nom d'hôtel / une chambre / un canal est rendu comme
// TEXTE (échappé par construction : textContent partout, jamais innerHTML) —
// jamais exécuté. ARCHITECTURE-MULTIAGENT.md §7 risque #3.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { startApp } from "./helpers/server.mjs";
import { makeService, verifiedOffer } from "./helpers/mock-service.mjs";
import { setToken, fillSearchForm, submitSearch, selectHotel } from "./helpers/ui.mjs";

const XSS_HOTEL_NAME = `<img src=x onerror="window.__xssFired = (window.__xssFired||0) + 1">La Cigale`;
const XSS_ROOM_NAME = `"><script>window.__xssFired = (window.__xssFired||0) + 1</script>Suite Vue Mer`;
const XSS_CHANNEL = `<svg onload="window.__xssFired = (window.__xssFired||0) + 1">TunisieBooking</svg>`;

let browser;
let app;

before(async () => {
  browser = await launchBrowser();
  const service = makeService({
    searchHotels: async () => ({
      query: { name: null, city: "Tabarka", country: "TN" },
      geo: null,
      hotels: [
        {
          slug: "tn/xss-hotel",
          displayName: XSS_HOTEL_NAME,
          city: "Tabarka",
          country: "TN",
          hotelId: 999,
          channels: ["tunisiebooking"],
          childPolicy: null,
          resolution: "resolved",
        },
      ],
      generatedAt: new Date().toISOString(),
    }),
    rankOffers: async () => ({
      query: { hotel: XSS_HOTEL_NAME, window: null, nights: 2, adults: 2, childrenAges: [], childPolicy: null },
      generatedAt: new Date().toISOString(),
      status: "verified",
      fx: { pair: "EUR/TND", rate: 3.37, stale: false, asOf: new Date().toISOString(), source: "open.er-api.com" },
      geo: null,
      channelPlan: { country: "TN", region: "North Africa", matched: true, countrySource: "cache", pricedNow: ["TunisieBooking"], alsoCheck: [], globalApi: null, note: null },
      tiersRun: ["tier1:tunisiebooking"],
      shortCircuited: false,
      best: null,
      ranking: [verifiedOffer({ channel: XSS_CHANNEL, room: XSS_ROOM_NAME, totalEUR: 241, totalTND: 812 })],
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

test("un nom d'hôtel scrapé contenant un payload XSS est affiché comme texte, jamais exécuté", async () => {
  const page = await browser.newPage();
  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  try {
    await page.goto(`${app.url}/`);
    await setToken(page, app.bearerToken);
    await fillSearchForm(page, { city: "Tabarka", country: "TN" });
    await submitSearch(page);
    await page.waitForSelector(".btn-select-hotel");

    // The raw payload is present as literal TEXT in the hotel list...
    const hotelListText = await page.locator("#hotels-results").textContent();
    assert.ok(hotelListText.includes(XSS_HOTEL_NAME), "the raw payload should appear as visible text");

    // ...but was never parsed as markup: no <img>/<svg> element was created
    // from it, and its onerror/onload handler never ran.
    const imgCount = await page.locator("#hotels-results img").count();
    const svgCount = await page.locator("#hotels-results svg").count();
    assert.equal(imgCount, 0, "the scraped <img> markup must not become a real DOM element");
    assert.equal(svgCount, 0);

    await selectHotel(page, 0);
    await page.waitForSelector(".rank-table tbody tr");

    const tableText = await page.locator(".rank-table").textContent();
    assert.ok(tableText.includes("Suite Vue Mer"), "room name text content is present");
    assert.ok(tableText.includes("TunisieBooking"), "channel name text content is present");

    const scriptCount = await page.locator(".rank-table script").count();
    const svgCount2 = await page.locator(".rank-table svg").count();
    assert.equal(scriptCount, 0, "a scraped <script> payload must not become a real, executing <script> element");
    assert.equal(svgCount2, 0);

    // No dialog (alert/confirm/prompt) was ever triggered by the payload.
    assert.deepEqual(dialogs, []);
    // The onerror/onload/script handlers never executed.
    const xssFired = await page.evaluate(() => window.__xssFired);
    assert.equal(xssFired, undefined, "no injected handler should ever have run");
  } finally {
    await page.close();
  }
});
