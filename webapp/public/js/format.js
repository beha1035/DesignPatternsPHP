// format — small date/text display helpers. Pure, no DOM.

export function formatIsoDate(iso) {
  if (typeof iso !== "string") return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

// `window` shows up either as "START..END" (request-shaped) or
// "checkin→checkout" (Offer.window, produced by the orchestrator). Handle
// both without guessing at anything not present.
export function formatWindow(window) {
  if (!window) return "—";
  if (window.includes("→")) {
    const [a, b] = window.split("→");
    return `${formatIsoDate(a)} → ${formatIsoDate(b)}`;
  }
  if (window.includes("..")) {
    const [a, b] = window.split("..");
    return `${formatIsoDate(a)} → ${formatIsoDate(b)}`;
  }
  return window;
}

const BOARD_LABELS = {
  breakfast: "Petit-déjeuner",
  "half-board": "Demi-pension",
  "full-board": "Pension complète",
  "all-inclusive": "Tout compris",
  "room-only": "Chambre seule",
  unknown: "Régime inconnu",
};

export function formatBoard(board) {
  return BOARD_LABELS[board] || BOARD_LABELS.unknown;
}
