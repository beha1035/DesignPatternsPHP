// offers — pure, DOM-free logic for turning a RankResponse (docs/api/openapi.yaml
// `RankResponse`) into a single, price-sorted list of display rows, and for
// picking which row (if any) is allowed to be shown as "meilleur prix".
//
// Honesty invariant (docs/adr/0003-price-scope.md, docs/api/data-model.md
// §Invariants transverses #2): a row is only ever a legitimate "best price"
// if it is `status:"verified"` AND `occupancyVerified` is not `false`. Rows
// sourced from `unverifiedOccupancy`/`browserObserved` are ALWAYS forced to
// `status:"signal"` here, regardless of what a (buggy/malicious) upstream
// might have put in a nearby field, so a cheaper unverified price can never
// visually outrank a verified one.

export const STATUS_LABELS = {
  verified: "Vérifié",
  signal: "Signal",
  no_price: "Indisponible",
  blocked: "Indisponible",
  drift: "Indisponible",
  error: "Indisponible",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || "Indisponible";
}

export function statusBadgeClass(status) {
  if (status === "verified") return "badge badge-verified";
  if (status === "signal") return "badge badge-signal";
  return "badge badge-unavailable";
}

// Normalise the three RankResponse arrays (`ranking`, `unverifiedOccupancy`,
// `browserObserved`) into one flat list of display rows with a consistent
// shape. Nothing here fabricates a price: a row with no derivable price
// keeps `priceEUR`/`priceTND` as null (rendered as "—", never as 0).
export function buildUnifiedRows(rankResponse) {
  const rows = [];

  for (const o of rankResponse?.ranking || []) {
    rows.push({
      channel: o.channel ?? "",
      room: o.room || "",
      board: o.board || "unknown",
      window: o.window || null,
      priceEUR: o.totalEUR ?? o.eur ?? null,
      priceTND: o.totalTND ?? null,
      status: o.status,
      occupancyVerified: o.occupancyVerified ?? true,
      note: o.occupancyNote || null,
      sourceUrl: o.sourceUrl || null,
    });
  }
  for (const o of rankResponse?.unverifiedOccupancy || []) {
    rows.push({
      channel: o.channel ?? "",
      room: "",
      board: "unknown",
      window: null,
      priceEUR: o.priceEUR ?? null,
      priceTND: null,
      status: "signal", // forced: this array is signal-by-definition (ADR 0003)
      occupancyVerified: false,
      note: o.note || "Prix vitrine — occupation non confirmée, à vérifier sur le site.",
      sourceUrl: null,
    });
  }
  for (const o of rankResponse?.browserObserved || []) {
    rows.push({
      channel: o.channel ?? "",
      room: "",
      board: "unknown",
      window: null,
      priceEUR: o.priceEUR ?? null,
      priceTND: null,
      status: "signal", // forced: browser-observed prices are corroboration signals only
      occupancyVerified: false,
      note: o.note || "Observation navigateur — non étiqueté comme prix ferme.",
      sourceUrl: null,
    });
  }
  return rows;
}

export function sortRowsByPrice(rows) {
  return [...(rows || [])].sort((a, b) => {
    const av = a.priceEUR ?? Infinity;
    const bv = b.priceEUR ?? Infinity;
    return av - bv;
  });
}

// The core honesty guard: never true for a `signal`/non-classable row, even
// if it happens to carry `status:"verified"` by mistake without a proper
// occupancyVerified flag — both conditions are required.
export function isHonestVerifiedRow(row) {
  return !!row && row.status === "verified" && row.occupancyVerified !== false;
}

// Index (within an already price-sorted array) of the first row allowed to
// be marked "meilleur prix" — i.e. the cheapest HONEST row, not simply the
// cheapest row. Returns -1 when no row qualifies (e.g. Tunisia no_price /
// only signals).
export function pickBestRowIndex(sortedRows) {
  return (sortedRows || []).findIndex(isHonestVerifiedRow);
}
