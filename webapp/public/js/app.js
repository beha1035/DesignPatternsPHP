// app — DOM wiring only. Pure logic lives in validate.js / offers.js /
// currency.js / format.js / escape.js (unit-tested under node:test); DOM
// construction lives in render.js (textContent-only, no innerHTML). This
// file glues user events -> validation -> api.js -> render.js.

import { apiRequest, ApiRequestError } from "./api.js";
import {
  validateSearchForm,
  validateOccupants,
  validateDates,
  buildSearchRequestBody,
  buildRankRequestBody,
} from "./validate.js";
import { buildUnifiedRows, sortRowsByPrice, pickBestRowIndex } from "./offers.js";
import {
  renderLoading,
  renderError,
  renderEmpty,
  renderHotelList,
  renderFx,
  renderChannelPlan,
  renderRankTable,
  clear,
} from "./render.js";

const TOKEN_KEY = "hdf_api_token";
const MAX_CHILDREN = 6;

const state = {
  currency: "EUR",
  lastRankResponse: null,
  childCount: 0,
};

// ---- elements ----------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const settingsToggle = $("settings-toggle");
const settingsPanel = $("settings-panel");
const settingsForm = $("settings-form");
const tokenInput = $("token-input");
const tokenStatus = $("token-status");

const searchForm = $("search-form");
const searchErrors = $("search-errors");
const nameInput = $("name-input");
const cityInput = $("city-input");
const countryInput = $("country-input");

const windowFields = $("window-fields");
const fixedFields = $("fixed-fields");
const windowStart = $("window-start");
const windowEnd = $("window-end");
const nightsInput = $("nights-input");
const checkinInput = $("checkin-input");
const checkoutInput = $("checkout-input");

const adultsInput = $("adults-input");
const childrenList = $("children-list");
const addChildBtn = $("add-child-btn");

const hotelsStatus = $("hotels-status");
const hotelsResults = $("hotels-results");

const fxInfo = $("fx-info");
const channelPlanInfo = $("channel-plan-info");
const rankStatus = $("rank-status");
const rankResults = $("rank-results");

const currencyEurBtn = $("currency-eur");
const currencyTndBtn = $("currency-tnd");

// ---- token (localStorage; never sent anywhere but this API's Authorization header) --

function loadToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function saveToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* localStorage unavailable (private mode, etc.) — degrade silently */
  }
}

function refreshTokenStatus() {
  const token = loadToken();
  tokenStatus.textContent = token ? "Jeton configuré." : "Aucun jeton configuré — les appels API échoueront (401).";
}

if (settingsToggle && settingsPanel) {
  settingsToggle.addEventListener("click", () => {
    const isHidden = settingsPanel.hasAttribute("hidden");
    if (isHidden) settingsPanel.removeAttribute("hidden");
    else settingsPanel.setAttribute("hidden", "");
    settingsToggle.setAttribute("aria-expanded", String(isHidden));
  });
}

if (settingsForm) {
  tokenInput.value = loadToken();
  refreshTokenStatus();
  settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    saveToken(tokenInput.value.trim());
    refreshTokenStatus();
  });
}

// ---- date mode toggle ----------------------------------------------------------

function currentDateMode() {
  const checked = searchForm.querySelector('input[name="dateMode"]:checked');
  return checked ? checked.value : "window";
}

function syncDateFieldsVisibility() {
  const mode = currentDateMode();
  const isWindow = mode === "window";
  windowFields.hidden = !isWindow;
  fixedFields.hidden = isWindow;
  for (const input of windowFields.querySelectorAll("input")) input.disabled = !isWindow;
  for (const input of fixedFields.querySelectorAll("input")) input.disabled = isWindow;
}

for (const radio of searchForm.querySelectorAll('input[name="dateMode"]')) {
  radio.addEventListener("change", syncDateFieldsVisibility);
}
syncDateFieldsVisibility();

// ---- dynamic children ages ------------------------------------------------------

function addChildRow() {
  if (state.childCount >= MAX_CHILDREN) return;
  const index = state.childCount++;
  const row = document.createElement("div");
  row.className = "child-row";
  row.dataset.childIndex = String(index);

  const label = document.createElement("label");
  label.textContent = `Âge de l'enfant ${index + 1}`;
  const inputId = `child-age-${index}`;
  label.setAttribute("for", inputId);

  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.max = "17";
  input.value = "0";
  input.id = inputId;
  input.name = `childAge${index}`;
  input.className = "child-age-input";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn btn-remove-child";
  removeBtn.textContent = "Supprimer";
  removeBtn.setAttribute("aria-label", `Supprimer l'enfant ${index + 1}`);
  removeBtn.addEventListener("click", () => {
    row.remove();
    state.childCount--;
    addChildBtn.disabled = false;
  });

  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(removeBtn);
  childrenList.appendChild(row);

  if (state.childCount >= MAX_CHILDREN) addChildBtn.disabled = true;
}

addChildBtn?.addEventListener("click", addChildRow);

function readChildrenAges() {
  return Array.from(childrenList.querySelectorAll(".child-age-input")).map((input) => Number(input.value));
}

// ---- form state -----------------------------------------------------------------

function readFormState() {
  return {
    name: nameInput.value,
    city: cityInput.value,
    country: countryInput.value,
    mode: currentDateMode(),
    window: windowStart.value && windowEnd.value ? `${windowStart.value}..${windowEnd.value}` : "",
    nights: nightsInput.value,
    checkin: checkinInput.value,
    checkout: checkoutInput.value,
    adults: adultsInput.value,
    childrenAges: readChildrenAges(),
  };
}

function showFieldErrors(errors) {
  clear(searchErrors);
  const messages = Object.values(errors);
  if (messages.length === 0) return;
  const list = document.createElement("ul");
  for (const msg of messages) {
    const li = document.createElement("li");
    li.textContent = msg;
    list.appendChild(li);
  }
  searchErrors.appendChild(list);
}

// ---- rank rendering (currency-toggle-aware; re-runs on toggle without refetch) ----

function renderCurrentRank() {
  if (!state.lastRankResponse) return;
  const r = state.lastRankResponse;
  renderFx(fxInfo, r.fx);
  renderChannelPlan(channelPlanInfo, r.channelPlan);
  const rows = sortRowsByPrice(buildUnifiedRows(r));
  const bestIndex = pickBestRowIndex(rows);
  renderRankTable(rankResults, { rows, bestIndex, currency: state.currency, fxRate: r.fx?.rate });

  if (r.status === "no_price" && rows.length === 0) {
    rankStatus.textContent = "Aucun prix vérifié pour ces dates/occupants en Tunisie.";
  } else {
    rankStatus.textContent = `${rows.length} offre(s) trouvée(s).`;
  }
}

function setCurrency(currency) {
  state.currency = currency;
  currencyEurBtn.setAttribute("aria-pressed", String(currency === "EUR"));
  currencyTndBtn.setAttribute("aria-pressed", String(currency === "TND"));
  renderCurrentRank();
}

currencyEurBtn?.addEventListener("click", () => setCurrency("EUR"));
currencyTndBtn?.addEventListener("click", () => setCurrency("TND"));

// ---- rank a selected hotel --------------------------------------------------------

async function rankHotel(hotel, formState) {
  const dateCheck = validateDates(formState);
  const occCheck = validateOccupants({ adults: formState.adults, childrenAges: formState.childrenAges });
  if (!dateCheck.ok || !occCheck.ok) {
    showFieldErrors({ ...dateCheck.errors, ...occCheck.errors });
    return;
  }

  const body = buildRankRequestBody({
    slug: hotel.slug,
    mode: formState.mode,
    window: formState.window,
    nights: formState.nights,
    checkin: formState.checkin,
    checkout: formState.checkout,
    adults: formState.adults,
    childrenAges: formState.childrenAges,
    currency: state.currency,
  });

  renderLoading(rankResults, "Classement des offres en cours…");
  rankStatus.textContent = "";
  clear(fxInfo);
  clear(channelPlanInfo);
  try {
    const result = await apiRequest("/api/rank", { method: "POST", token: loadToken(), body });
    state.lastRankResponse = result;
    renderCurrentRank();
  } catch (err) {
    state.lastRankResponse = null;
    const message = err instanceof ApiRequestError ? err.message : "Une erreur inattendue est survenue.";
    renderError(rankResults, message);
    rankStatus.textContent = "";
  }
}

// ---- search submit -----------------------------------------------------------------

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formState = readFormState();

  const searchCheck = validateSearchForm(formState);
  const dateCheck = validateDates(formState);
  const occCheck = validateOccupants({ adults: formState.adults, childrenAges: formState.childrenAges });
  const errors = { ...searchCheck.errors, ...dateCheck.errors, ...occCheck.errors };
  showFieldErrors(errors);
  if (!searchCheck.ok || !dateCheck.ok || !occCheck.ok) return;

  clear(rankResults);
  clear(fxInfo);
  clear(channelPlanInfo);
  rankStatus.textContent = "";
  state.lastRankResponse = null;

  renderLoading(hotelsResults, "Recherche en cours…");
  hotelsStatus.textContent = "";
  const body = buildSearchRequestBody(formState);
  try {
    const result = await apiRequest("/api/search", { method: "POST", token: loadToken(), body });
    const hotels = result?.hotels || [];
    renderHotelList(hotelsResults, hotels, {
      onSelect: (hotel) => rankHotel(hotel, readFormState()),
    });
    hotelsStatus.textContent = hotels.length ? `${hotels.length} hôtel(s) trouvé(s).` : "";
    if (hotels.length === 0) renderEmpty(hotelsResults, "Aucun hôtel trouvé pour cette recherche.");
  } catch (err) {
    const message = err instanceof ApiRequestError ? err.message : "Une erreur inattendue est survenue.";
    renderError(hotelsResults, message);
    hotelsStatus.textContent = "";
  }
});
