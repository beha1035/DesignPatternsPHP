// validate — client-side mirror of webapp/lib/validate.mjs (zod schemas
// against docs/api/openapi.yaml). This is a UX convenience layer ONLY: it
// lets the form fail fast with French, field-level messages. The API remains
// the single source of truth and re-validates everything server-side
// (webapp/lib/validate.mjs) — a client bypass can never reach an unvalidated
// request.

export const MAX_WINDOW_DAYS = 30;

const NAME_PATTERN = /^[\p{L}0-9 '&.,-]+$/u;
const CITY_PATTERN = /^[\p{L} '-]+$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_PATTERN = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;

function noErrors(errors) {
  return Object.keys(errors).length === 0;
}

// name/city: exactly one of the two conceptually drives the query, but the
// API only requires >=1 of them (SearchRequest `anyOf`/`minProperties:1`), so
// mirror that rather than being stricter than the server.
export function validateSearchForm({ name, city, country } = {}) {
  const errors = {};
  const n = (name || "").trim();
  const c = (city || "").trim();
  const co = (country || "").trim().toUpperCase();

  if (!n && !c) {
    errors.query = "Indiquez un nom d'hôtel ou une ville.";
  }
  if (n && (n.length < 2 || n.length > 120)) {
    errors.name = "Nom d'hôtel : entre 2 et 120 caractères.";
  } else if (n && !NAME_PATTERN.test(n)) {
    errors.name = "Nom d'hôtel : caractères non autorisés (pas d'URL).";
  }
  if (c && (c.length < 2 || c.length > 80)) {
    errors.city = "Ville : entre 2 et 80 caractères.";
  } else if (c && !CITY_PATTERN.test(c)) {
    errors.city = "Ville : caractères non autorisés.";
  }
  if (co && !COUNTRY_PATTERN.test(co)) {
    errors.country = "Pays : code ISO2 en majuscules (ex. TN).";
  }
  return { ok: noErrors(errors), errors };
}

export function validateOccupants({ adults, childrenAges } = {}) {
  const errors = {};
  const a = Number(adults);
  if (!Number.isInteger(a) || a < 1 || a > 8) {
    errors.adults = "Adultes : un nombre entier entre 1 et 8.";
  }
  const ages = Array.isArray(childrenAges) ? childrenAges : [];
  if (ages.length > 6) {
    errors.childrenAges = "6 enfants maximum.";
  }
  ages.forEach((age, i) => {
    const v = Number(age);
    if (!Number.isInteger(v) || v < 0 || v > 17) {
      errors[`child${i}`] = `Âge de l'enfant ${i + 1} : entre 0 et 17 ans.`;
    }
  });
  return { ok: noErrors(errors), errors };
}

// mode: "window" | "fixed" — mirrors the API's `anyOf` (window XOR
// checkin+checkout); the two are mutually exclusive by construction here
// (the UI only ever submits one mode at a time), matching the server's
// explicit rejection of "both provided".
export function validateDates({ mode, window, nights, checkin, checkout } = {}) {
  const errors = {};

  if (mode === "window") {
    if (!window || !WINDOW_PATTERN.test(window)) {
      errors.window = "Fenêtre invalide (attendu AAAA-MM-JJ..AAAA-MM-JJ).";
      return { ok: false, errors };
    }
    const [start, end] = window.split("..");
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      errors.window = "La fenêtre contient une date invalide.";
    } else if (startMs >= endMs) {
      errors.window = "La date de début doit précéder la date de fin.";
    } else {
      const spanDays = Math.round((endMs - startMs) / 86_400_000);
      if (spanDays > MAX_WINDOW_DAYS) {
        errors.window = `Fenêtre trop large (${spanDays} j) — maximum ${MAX_WINDOW_DAYS} jours.`;
      }
    }
    const n = Number(nights);
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      errors.nights = "Nuits par séjour : un nombre entier entre 1 et 30.";
    }
  } else if (mode === "fixed") {
    if (!checkin || !ISO_DATE_PATTERN.test(checkin)) errors.checkin = "Date d'arrivée invalide.";
    if (!checkout || !ISO_DATE_PATTERN.test(checkout)) errors.checkout = "Date de départ invalide.";
    if (!errors.checkin && !errors.checkout) {
      const ci = Date.parse(checkin);
      const co = Date.parse(checkout);
      if (co <= ci) {
        errors.checkout = "La date de départ doit être après l'arrivée.";
      } else {
        const spanDays = Math.round((co - ci) / 86_400_000);
        if (spanDays > MAX_WINDOW_DAYS) {
          errors.checkout = `Séjour trop long (${spanDays} j) — maximum ${MAX_WINDOW_DAYS} jours.`;
        }
      }
    }
  } else {
    errors.mode = "Choisissez un mode de dates.";
  }
  return { ok: noErrors(errors), errors };
}

export function buildSearchRequestBody({ name, city, country } = {}) {
  const body = {};
  const n = (name || "").trim();
  const c = (city || "").trim();
  const co = (country || "").trim().toUpperCase();
  if (n) body.name = n;
  if (c) body.city = c;
  if (co) body.country = co;
  return body;
}

export function buildRankRequestBody({
  slug,
  mode,
  window,
  nights,
  checkin,
  checkout,
  adults,
  childrenAges,
  currency,
  escalate,
} = {}) {
  const body = {
    slug,
    occupants: {
      adults: Number(adults),
      childrenAges: (Array.isArray(childrenAges) ? childrenAges : []).map(Number),
    },
    currency: currency || "EUR",
    escalate: !!escalate,
  };
  if (mode === "window") {
    body.window = window;
    body.nights = Number(nights);
  } else {
    body.checkin = checkin;
    body.checkout = checkout;
  }
  return body;
}
