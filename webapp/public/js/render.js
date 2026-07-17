// render — ALL DOM writes for hotel-deal-finder live here, and ALL of them go
// through `textContent` / `createElement` / `setAttribute`. Never `innerHTML`
// with data. This is what keeps scraped hotel/room names (docs/adr/0003,
// ARCHITECTURE §7 risk #3 "XSS stocké") inert even if they contain literal
// `<img onerror=...>` markup: the browser only ever sees them as text nodes,
// never re-parses them as HTML.
//
// DOM-heavy -> not unit-tested under node:test (no DOM there); exercised by
// the Playwright e2e suite (webapp/test/e2e/).

import { statusLabel, statusBadgeClass, isHonestVerifiedRow } from "./offers.js";
import { amountForCurrency, formatMoney, formatFxRate } from "./currency.js";
import { formatWindow, formatBoard } from "./format.js";
import { sanitizeUrl } from "./escape.js";

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // SAFE: textContent, never innerHTML
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

export function renderLoading(container, message) {
  clear(container);
  container.appendChild(el("p", { className: "state state-loading", text: message, attrs: { "aria-busy": "true" } }));
}

export function renderError(container, message) {
  clear(container);
  container.appendChild(el("p", { className: "state state-error", text: message, attrs: { role: "alert" } }));
}

export function renderEmpty(container, message) {
  clear(container);
  container.appendChild(el("p", { className: "state state-empty", text: message }));
}

// ---- hotel search results ---------------------------------------------------

export function renderHotelList(container, hotels, { onSelect } = {}) {
  clear(container);
  if (!hotels || hotels.length === 0) {
    renderEmpty(container, "Aucun hôtel trouvé pour cette recherche.");
    return;
  }
  const list = el("ul", { className: "hotel-list" });
  for (const hotel of hotels) {
    const label = [hotel.displayName, hotel.city, hotel.country].filter(Boolean).join(" — ");
    const item = el("li", { className: "hotel-item" });
    item.appendChild(el("span", { className: "hotel-name", text: hotel.displayName || "(nom inconnu)" }));
    if (hotel.city || hotel.country) {
      item.appendChild(el("span", { className: "hotel-location", text: [hotel.city, hotel.country].filter(Boolean).join(", ") }));
    }
    if (hotel.resolution === "partial" || !hotel.hotelId) {
      item.appendChild(
        el("span", {
          className: "hotel-note",
          text: "Résolution partielle — prix vérifié disponible uniquement pour la Tunisie (voir ADR 0003).",
        })
      );
    }
    const button = el("button", { className: "btn btn-select-hotel", text: "Voir les prix", attrs: { type: "button" } });
    button.setAttribute("aria-label", `Voir les prix pour ${label}`);
    button.addEventListener("click", () => onSelect?.(hotel));
    item.appendChild(button);
    list.appendChild(item);
  }
  container.appendChild(list);
}

// ---- fx / channel plan -------------------------------------------------------

export function renderFx(container, fx) {
  clear(container);
  if (!fx) return;
  const p = el("p", { className: "fx-line" });
  p.appendChild(el("span", { text: formatFxRate(fx) }));
  if (fx.stale) {
    p.appendChild(el("span", { className: "badge badge-stale", text: "taux approximatif" }));
  }
  container.appendChild(p);
}

export function renderChannelPlan(container, channelPlan) {
  clear(container);
  if (!channelPlan) return;
  const wrap = el("div", { className: "channel-plan" });
  wrap.appendChild(
    el("p", {
      className: "channel-plan-heading",
      text: `Canaux pour ${channelPlan.country || "ce pays"}${channelPlan.matched ? "" : " (plan par défaut)"} :`,
    })
  );
  if (channelPlan.pricedNow?.length) {
    const chips = el("ul", { className: "chip-list" });
    for (const c of channelPlan.pricedNow) chips.appendChild(el("li", { className: "chip chip-priced", text: c }));
    wrap.appendChild(chips);
  }
  if (channelPlan.alsoCheck?.length) {
    wrap.appendChild(el("p", { className: "channel-plan-subheading", text: "À vérifier manuellement (pas de prix ferme) :" }));
    const chips = el("ul", { className: "chip-list" });
    for (const entry of channelPlan.alsoCheck) {
      const label = entry.note ? `${entry.channel} — ${entry.note}` : entry.channel;
      chips.appendChild(el("li", { className: "chip chip-also-check", text: label }));
    }
    wrap.appendChild(chips);
  }
  container.appendChild(wrap);
}

// ---- ranked results table -----------------------------------------------------

// `rows` / `bestIndex` are produced by the PURE logic in js/offers.js
// (buildUnifiedRows/sortRowsByPrice/pickBestRowIndex) — this function only
// turns that already-decided data into DOM. It never re-derives "best" on
// its own, so there is a single, testable source of truth for the honesty
// guard.
export function renderRankTable(container, { rows, bestIndex, currency, fxRate }) {
  clear(container);
  if (!rows || rows.length === 0) {
    renderEmpty(container, "Aucune offre disponible pour ces dates et ces occupants.");
    return;
  }

  const summary = el("p", { className: "table-summary" });
  const bestRow = bestIndex >= 0 ? rows[bestIndex] : null;
  if (bestRow) {
    const amount = amountForCurrency({ eur: bestRow.priceEUR, tnd: bestRow.priceTND }, currency, fxRate);
    summary.appendChild(
      el("span", {
        className: "best-callout",
        text: `Meilleur prix vérifié : ${formatMoney(amount, currency)} — ${bestRow.channel}.`,
      })
    );
  } else {
    summary.appendChild(
      el("span", {
        className: "best-callout best-callout-none",
        text: "Aucun prix vérifié pour l'instant — seuls des signaux (non fermes) sont disponibles ci-dessous.",
      })
    );
  }
  container.appendChild(summary);

  const wrap = el("div", { className: "table-scroll" });
  const table = el("table", { className: "rank-table" });
  table.appendChild(
    el("caption", {
      className: "sr-only",
      text: "Offres classées par prix. Le badge Vérifié désigne un prix daté réel ; Signal, un prix à corroborer, jamais un prix ferme.",
    })
  );

  const thead = el("thead");
  const headRow = el("tr");
  for (const h of ["Rang", "Canal", "Chambre", "Régime", "Dates", "Statut", "Prix", "Note"]) {
    headRow.appendChild(el("th", { text: h, attrs: { scope: "col" } }));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  rows.forEach((row, i) => {
    const tr = el("tr", { className: i === bestIndex ? "row-best" : "" });
    tr.appendChild(el("td", { text: String(i + 1) }));

    const channelCell = el("td");
    channelCell.appendChild(el("span", { text: row.channel || "—" }));
    const safeUrl = sanitizeUrl(row.sourceUrl);
    if (safeUrl) {
      const link = el("a", { text: "source", attrs: { href: safeUrl, target: "_blank", rel: "noopener noreferrer" } });
      channelCell.appendChild(document.createTextNode(" — "));
      channelCell.appendChild(link);
    }
    tr.appendChild(channelCell);

    tr.appendChild(el("td", { text: row.room || "—" }));
    tr.appendChild(el("td", { text: formatBoard(row.board) }));
    tr.appendChild(el("td", { text: formatWindow(row.window) }));

    const statusCell = el("td");
    statusCell.appendChild(el("span", { className: statusBadgeClass(row.status), text: statusLabel(row.status) }));
    if (i === bestIndex && isHonestVerifiedRow(row)) {
      statusCell.appendChild(el("span", { className: "badge badge-best", text: "★ meilleur prix" }));
    }
    tr.appendChild(statusCell);

    const amount = amountForCurrency({ eur: row.priceEUR, tnd: row.priceTND }, currency, fxRate);
    tr.appendChild(el("td", { className: "price-cell", text: formatMoney(amount, currency) }));
    tr.appendChild(el("td", { className: "note-cell", text: row.note || "" }));

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}
