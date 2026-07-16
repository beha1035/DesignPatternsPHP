// Test-only HTTP client built on node:http (NOT `fetch`) — the webapp
// installs a GUARDED global `fetch` at import time (webapp/lib/ssrf-guard.mjs)
// that only allows the fixed outbound allowlist, so tests must not rely on
// `fetch` to reach their own local ephemeral test server (127.0.0.1 is
// correctly a private IP, and would be rejected — which is the guard doing
// its job, not a bug). This mirrors how a real client (curl, the frontend)
// talks to the API: over a plain socket, unrelated to server-side egress.

import http from "node:http";

export function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => server.close(r)),
        request: (method, path, { body, headers = {} } = {}) => requestJson(port, method, path, body, headers),
      });
    });
  });
}

function requestJson(port, method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
