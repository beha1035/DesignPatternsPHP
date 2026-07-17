// Small, shared Playwright actions for driving the hotel-deal-finder form —
// kept here so each e2e scenario file stays focused on what it's asserting.

export async function setToken(page, token) {
  await page.evaluate((t) => window.localStorage.setItem("hdf_api_token", t), token);
}

export async function fillSearchForm(
  page,
  { name = "", city = "", country = "", windowStart = "2026-07-14", windowEnd = "2026-07-20", nights = "2", adults = "2" } = {}
) {
  if (name) await page.fill("#name-input", name);
  if (city) await page.fill("#city-input", city);
  if (country) await page.fill("#country-input", country);
  await page.fill("#window-start", windowStart);
  await page.fill("#window-end", windowEnd);
  await page.fill("#nights-input", nights);
  await page.fill("#adults-input", adults);
}

export async function submitSearch(page) {
  await page.click("#search-submit");
}

export async function selectHotel(page, index = 0) {
  await page.locator(".btn-select-hotel").nth(index).click();
}

// Full happy-path flow: navigate, set token, search, pick the first hotel.
export async function searchAndSelectFirstHotel(page, baseUrl, token, formOverrides = {}) {
  await page.goto(`${baseUrl}/`);
  await setToken(page, token);
  await fillSearchForm(page, formOverrides);
  await submitSearch(page);
  await page.waitForSelector(".btn-select-hotel");
  await selectHotel(page, 0);
}
