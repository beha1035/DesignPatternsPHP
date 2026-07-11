// geo — detect a city's country from a free-form request, so the agent picks the
// right country channel plan automatically ("en fonction de la demande") instead
// of the user passing --country. Uses OpenStreetMap Nominatim (free, global, no
// key). City names are ambiguous ("Djerba" exists in Algeria too), so we rank
// candidates by Nominatim's `importance` and let an optional country hint filter
// — the famous place wins, not the first row.

if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Per Nominatim policy, send a descriptive UA (not a spoofed browser one).
const UA = "hotel-deal-finder/1.0 (Claude Code agent)";
const PLACE_TYPES = new Set(["city", "town", "village", "municipality", "island", "county", "state", "administrative"]);

const fold = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const primaryName = (r) => {
  const a = r.address || {};
  return a.city || a.town || a.village || a.municipality || a.island || a.county || r.name || "";
};
// How well a row's place name matches the query: 2 exact (accent-folded), 1
// prefix/substring, 0 none. Stops Nominatim's fuzzy matcher from returning
// "Changchun" for "Cancun" just because it's a bigger city.
function nameMatch(row, queryName) {
  if (!queryName) return 1; // no query name to check -> neutral
  const q = fold(queryName).split(/\s+/)[0]; // first token = the city word
  const n = fold(primaryName(row));
  if (!n || !q) return 0;
  if (n === q) return 2;
  if (n.startsWith(q) || q.startsWith(n) || n.includes(q)) return 1;
  return 0;
}

// Pure: choose the best place from Nominatim rows. Rank by (name-match desc,
// importance desc), after filtering to place-like results and an optional country
// hint. Exported for testing without the network.
export function pickBestPlace(rows, countryHint = null, queryName = null) {
  const hint = (countryHint || "").toLowerCase() || null;
  let cand = (rows || []).filter((r) => {
    const isPlace = PLACE_TYPES.has(r.addresstype) || PLACE_TYPES.has(r.type) || r.address?.city || r.address?.town;
    const okCountry = !hint || r.address?.country_code === hint;
    return isPlace && okCountry;
  });
  if (!cand.length && hint) cand = (rows || []).filter((r) => r.address?.country_code === hint);
  if (!cand.length) cand = rows || [];
  // Drop rows whose name doesn't match the query at all (when we have a query).
  const named = cand.filter((r) => nameMatch(r, queryName) > 0);
  if (named.length) cand = named;
  cand.sort((a, b) =>
    nameMatch(b, queryName) - nameMatch(a, queryName) ||
    Number(b.importance || 0) - Number(a.importance || 0)
  );
  const top = cand[0];
  if (!top) return null;
  const a = top.address || {};
  return {
    city: primaryName(top) || null,
    country: (a.country_code || "").toUpperCase() || null,
    countryName: a.country || null,
    displayName: top.display_name || null,
    importance: Number(top.importance || 0),
  };
}

/**
 * Resolve a free-form location to a country.
 * @param {string} query e.g. "Tabarka", "Cancun", "Marrakech Morocco"
 * @param {object} [opts]
 * @param {string} [opts.countryHint] ISO2 to disambiguate
 * @returns {Promise<{city,country,countryName,displayName,importance,source}|null>}
 */
export async function resolveCity(query, { countryHint = null, timeoutMs = 8000 } = {}) {
  if (!query) return null;
  const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "5", addressdetails: "1" });
  if (countryHint) params.set("countrycodes", countryHint.toLowerCase());
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${NOMINATIM}?${params}`, {
      headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: ctl.signal,
    });
    if (!resp.ok) return null;
    const rows = await resp.json();
    const best = pickBestPlace(rows, countryHint, query);
    return best ? { ...best, source: "nominatim" } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
