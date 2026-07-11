// country-router — turn a hotel's country into an ordered channel plan, from the
// cited config/country-channels.json. It does NOT claim a single cheapest site
// (no such thing per the 2026 sources); it says which channels to check first for
// that country, and splits them into what we can price automatically now
// (implemented tools) vs. what to check manually / with a key (recommended).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, "..", "config", "country-channels.json");

let _cfg = null;
async function load() {
  if (!_cfg) _cfg = JSON.parse(await readFile(CONFIG, "utf8"));
  return _cfg;
}

/**
 * @param {string|null} country ISO-3166 alpha-2 (e.g. "TN"); null -> default plan
 * @returns {Promise<{country:string|null, matched:boolean, region:string|null,
 *   actionable:Array, recommended:Array, sources:Array}>}
 * actionable = channels with an implemented browserless/API tool (run now).
 * recommended = strong local channels without a tool yet (check manually/keyed).
 */
export async function planForCountry(country) {
  const cfg = await load();
  const cc = (country || "").toUpperCase();
  const entry = cfg.countries[cc] || cfg.default;
  const matched = Boolean(cfg.countries[cc]);
  const channels = entry.channels || [];
  return {
    country: cc || null,
    matched,
    region: entry.region || null,
    note: entry.note || null,
    actionable: channels.filter((c) => c.implemented && c.tool),
    recommended: channels.filter((c) => !c.implemented),
    sources: cfg._sources || [],
  };
}

// Sync variant for callers that already hold the parsed config.
export function planFromConfig(cfg, country) {
  const cc = (country || "").toUpperCase();
  const entry = cfg.countries[cc] || cfg.default;
  const channels = entry.channels || [];
  return {
    country: cc || null,
    matched: Boolean(cfg.countries[cc]),
    region: entry.region || null,
    actionable: channels.filter((c) => c.implemented && c.tool),
    recommended: channels.filter((c) => !c.implemented),
  };
}
