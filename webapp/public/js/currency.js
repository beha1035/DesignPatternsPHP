// currency — EUR/TND display helpers. Pure functions, no DOM, no network.
// Mirrors the conversion direction used server-side (webapp/service.mjs /
// .claude/agents/tools/lib/fx.mjs): `fx.rate` is TND-per-EUR (pair "EUR/TND"),
// so EUR = TND / rate and TND = EUR * rate.

export const SUPPORTED_CURRENCIES = ["EUR", "TND"];

const SYMBOLS = { EUR: "€", TND: "DT", USD: "$", GBP: "£" };

export function eurToTnd(eurAmount, rate) {
  if (eurAmount == null || !rate) return null;
  return Math.round(eurAmount * rate * 100) / 100;
}

export function tndToEur(tndAmount, rate) {
  if (tndAmount == null || !rate) return null;
  return Math.round((tndAmount / rate) * 100) / 100;
}

// Pick (or derive) the amount to display for `currency`, given an offer/row
// carrying both totalEUR and totalTND (either may be null/absent — honest
// nullability per docs/api/data-model.md). Falls back to converting via
// `rate` when only the other currency is known; returns null (never a
// fabricated number) when neither is available.
export function amountForCurrency({ eur = null, tnd = null }, currency, rate) {
  if (currency === "EUR") return eur ?? tndToEur(tnd, rate);
  if (currency === "TND") return tnd ?? eurToTnd(eur, rate);
  return null;
}

// Deterministic fr-FR-style formatting without relying on ICU currency data
// for less common codes (e.g. TND behaves inconsistently across ICU builds):
// we format the number ourselves and append a stable symbol.
export function formatMoney(amount, currency) {
  if (amount == null || Number.isNaN(amount)) return "—";
  const formatted = new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  const symbol = SYMBOLS[currency] || currency;
  return `${formatted} ${symbol}`;
}

export function formatFxRate(fx) {
  if (!fx || fx.rate == null) return "Taux de change indisponible.";
  const rate = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(fx.rate);
  const suffix = fx.stale ? " (approximatif — repli hors-ligne)" : "";
  return `1 EUR = ${rate} TND${suffix}`;
}
