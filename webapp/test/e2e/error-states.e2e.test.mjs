// e2e: états d'erreur (401, 500) et état vide, affichés explicitement à
// l'utilisateur (jamais un écran blanc / une table vide silencieuse).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { launchBrowser } from "./helpers/browser.mjs";
import { startApp } from "./helpers/server.mjs";
import { makeService } from "./helpers/mock-service.mjs";
import { setToken, fillSearchForm, submitSearch, selectHotel } from "./helpers/ui.mjs";

let browser;

before(async () => {
  browser = await launchBrowser();
});

after(async () => {
  await browser.close();
});

test("401 : jeton absent -> message d'erreur explicite invitant à configurer le jeton", async () => {
  const app = await startApp({ service: makeService() });
  const page = await browser.newPage();
  try {
    await page.goto(`${app.url}/`);
    // Deliberately do NOT call setToken(): the request goes out with no
    // Authorization header, so the real server-side bearer check (server.mjs)
    // rejects it with a genuine 401 — this is not a mocked error path.
    await fillSearchForm(page, { city: "Tabarka", country: "TN" });
    await submitSearch(page);

    const errorText = await page.locator("#hotels-results .state-error").textContent();
    assert.match(errorText, /Jeton API/);
  } finally {
    await page.close();
    await app.close();
  }
});

test("500 : erreur interne inattendue -> message générique, jamais la stack brute", async () => {
  const service = makeService({
    rankOffers: async () => {
      throw new Error("boom: unexpected upstream shape (not an ApiError)");
    },
  });
  const app = await startApp({ service });
  const page = await browser.newPage();
  try {
    await page.goto(`${app.url}/`);
    await setToken(page, app.bearerToken);
    await fillSearchForm(page, { city: "Tabarka", country: "TN" });
    await submitSearch(page);
    await page.waitForSelector(".btn-select-hotel");
    await selectHotel(page, 0);

    await page.waitForSelector("#rank-results .state-error");
    const errorText = await page.locator("#rank-results .state-error").textContent();
    assert.match(errorText, /Erreur interne du serveur/);
    assert.doesNotMatch(errorText, /boom/, "the raw error message must never leak to the client");
  } finally {
    await page.close();
    await app.close();
  }
});

test("recherche sans résultat -> état vide explicite (pas un écran blanc)", async () => {
  const service = makeService({
    searchHotels: async (q) => ({
      query: { name: null, city: q.city ?? null, country: q.country ?? null },
      geo: null,
      hotels: [],
      generatedAt: new Date().toISOString(),
    }),
  });
  const app = await startApp({ service });
  const page = await browser.newPage();
  try {
    await page.goto(`${app.url}/`);
    await setToken(page, app.bearerToken);
    await fillSearchForm(page, { city: "Nulle-Part", country: "TN" });
    await submitSearch(page);

    await page.waitForSelector("#hotels-results .state-empty");
    const emptyText = await page.locator("#hotels-results .state-empty").textContent();
    assert.match(emptyText, /Aucun hôtel trouvé/);
  } finally {
    await page.close();
    await app.close();
  }
});

test("classement sans prix vérifié (no_price) -> état vide explicite dans le tableau", async () => {
  const service = makeService({
    rankOffers: async () => ({
      query: { hotel: "La Cigale Tabarka", window: null, nights: 2, adults: 2, childrenAges: [], childPolicy: null },
      generatedAt: new Date().toISOString(),
      status: "no_price",
      fx: { pair: "EUR/TND", rate: 3.37, stale: false, asOf: new Date().toISOString(), source: "open.er-api.com" },
      geo: null,
      channelPlan: { country: "MA", region: "North Africa", matched: false, countrySource: "default", pricedNow: [], alsoCheck: [{ channel: "Booking.com", tier: 3, note: "navigateur" }], globalApi: null, note: null },
      tiersRun: [],
      shortCircuited: false,
      best: null,
      ranking: [],
      unverifiedOccupancy: [],
      browserObserved: [],
      channels: [],
      escalation: ["Aucun canal vérifié pour ce pays."],
    }),
  });
  const app = await startApp({ service });
  const page = await browser.newPage();
  try {
    await page.goto(`${app.url}/`);
    await setToken(page, app.bearerToken);
    await fillSearchForm(page, { city: "Marrakech", country: "MA" });
    await submitSearch(page);
    await page.waitForSelector(".btn-select-hotel");
    await selectHotel(page, 0);

    await page.waitForSelector("#rank-results .state-empty");
    const emptyText = await page.locator("#rank-results .state-empty").textContent();
    assert.match(emptyText, /Aucune offre disponible/);

    // Guidance (alsoCheck) is still shown instead of a dead end.
    const planText = await page.locator("#channel-plan-info").textContent();
    assert.match(planText, /Booking\.com/);
  } finally {
    await page.close();
    await app.close();
  }
});
