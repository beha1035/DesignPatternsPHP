// Starts a real hotel-deal-finder server (webapp/server.mjs's `createApp`)
// bound to 127.0.0.1 on an ephemeral port, with an injected MOCK service —
// exactly like webapp/test/routes.test.mjs, just driven by a real browser
// instead of an HTTP client. Zero network calls ever leave this process:
// `service` never touches `fetch`/`execFile`.

import { createApp } from "../../../server.mjs";

export function startApp({ bearerToken = "e2e-test-token", service, rateLimit } = {}) {
  const app = createApp({
    bearerToken,
    service,
    rateLimit: rateLimit || { windowMs: 60_000, max: 1000 },
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        bearerToken,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
