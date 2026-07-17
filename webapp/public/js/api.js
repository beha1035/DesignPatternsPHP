// api — thin client for the hotel-deal-finder backend (docs/api/openapi.yaml).
// `buildHeaders`/`friendlyErrorMessage` are pure and unit-tested directly;
// `apiRequest` wraps the browser `fetch` (same-origin only — the page is
// served by this same Express app, and the CSP `connect-src 'self'` forbids
// anything else) and is exercised end-to-end (Playwright), not under
// node:test, since it needs a real network stack.

export function buildHeaders(token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// Turns an HTTP status + parsed body (webapp `Error` schema) into a short,
// honest, French message. Never invents specifics we don't have.
export function friendlyErrorMessage(status, body) {
  const serverMessage = body && typeof body.message === "string" ? body.message : null;
  if (status === 401) return "Jeton API manquant ou invalide. Renseignez-le dans « Réglages ».";
  if (status === 429) return "Trop de requêtes envoyées à l'API. Réessayez dans un instant.";
  if (status === 404) return serverMessage || "Hôtel introuvable pour cette recherche.";
  if (status === 502) return serverMessage || "Canal de prix indisponible pour le moment (anti-bot ou dérive détectée).";
  if (status === 400) return serverMessage || "Requête invalide.";
  if (status != null && status >= 500) return "Erreur interne du serveur. Réessayez plus tard.";
  return serverMessage || "Une erreur inattendue est survenue.";
}

export class ApiRequestError extends Error {
  constructor(status, body) {
    super(friendlyErrorMessage(status, body));
    this.status = status;
    this.body = body;
  }
}

export async function apiRequest(path, { method = "GET", token, body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: buildHeaders(token),
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network-level failure (server down, CORS, offline): no HTTP status at all.
    throw new ApiRequestError(null, null);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) throw new ApiRequestError(res.status, json);
  return json;
}
