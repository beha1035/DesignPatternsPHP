// Unit tests for the pure parts of webapp/public/js/api.js (buildHeaders,
// friendlyErrorMessage, ApiRequestError). `apiRequest` itself wraps `fetch`
// and is exercised by the Playwright e2e suite instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHeaders, friendlyErrorMessage, ApiRequestError } from "../public/js/api.js";

test("buildHeaders: always sets JSON content-type; adds Authorization only when a token is present", () => {
  assert.deepEqual(buildHeaders(""), { "Content-Type": "application/json" });
  assert.deepEqual(buildHeaders(undefined), { "Content-Type": "application/json" });
  assert.deepEqual(buildHeaders("abc123"), { "Content-Type": "application/json", Authorization: "Bearer abc123" });
});

test("friendlyErrorMessage: 401 points the user at Réglages, never leaks internals", () => {
  assert.match(friendlyErrorMessage(401, null), /Jeton API/);
});

test("friendlyErrorMessage: 429 explains rate limiting", () => {
  assert.match(friendlyErrorMessage(429, null), /Trop de requêtes/);
});

test("friendlyErrorMessage: prefers the server's own message for 400/404/502 when present", () => {
  assert.equal(friendlyErrorMessage(404, { message: "Aucun hôtel pour ce slug." }), "Aucun hôtel pour ce slug.");
  assert.equal(friendlyErrorMessage(400, { message: "slug ne respecte pas le motif" }), "slug ne respecte pas le motif");
});

test("friendlyErrorMessage: 5xx never leaks a stack trace / raw error, always the generic message", () => {
  assert.equal(friendlyErrorMessage(500, { message: "TypeError: x is not a function\n  at ..." }), "Erreur interne du serveur. Réessayez plus tard.");
});

test("friendlyErrorMessage: unknown (non-5xx) status falls back to a generic message", () => {
  assert.equal(friendlyErrorMessage(418, null), "Une erreur inattendue est survenue.");
});

test("friendlyErrorMessage: any >=500 status (not just 500) gets the generic internal-error message", () => {
  assert.equal(friendlyErrorMessage(999, null), "Erreur interne du serveur. Réessayez plus tard.");
});

test("ApiRequestError: message matches friendlyErrorMessage and carries status/body", () => {
  const err = new ApiRequestError(401, { error: "internal_error", message: "Unauthorized." });
  assert.equal(err.status, 401);
  assert.match(err.message, /Jeton API/);
  assert.deepEqual(err.body, { error: "internal_error", message: "Unauthorized." });
});
