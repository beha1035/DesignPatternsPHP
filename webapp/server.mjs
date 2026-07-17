#!/usr/bin/env node
// server — hotel-deal-finder backend, conforming to docs/api/openapi.yaml.
// Bind localhost only (see openapi.yaml `servers` + ARCHITECTURE §7); auth is
// defense in depth, NOT the perimeter.

import express from "express";
import helmet from "helmet";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { installGlobalFetchGuard } from "./lib/ssrf-guard.mjs";
import { createLogger } from "./lib/logger.mjs";
import { errorMiddleware } from "./lib/errors.mjs";
import { ClientRateLimiter, rateLimitMiddleware } from "./lib/rate-limit.mjs";

import { healthRouter } from "./routes/health.mjs";
import { searchRouter } from "./routes/search.mjs";
import { rankRouter } from "./routes/rank.mjs";
import { priceRouter } from "./routes/price.mjs";

// Install the guard BEFORE any route/service module makes an outbound call.
// (Tool modules resolve the `fetch` identifier at CALL time, not import time,
// so this is effective as long as it runs before the server starts serving —
// but we do it first regardless, for clarity and to fail fast in tests that
// import this file directly.)
installGlobalFetchGuard();

const logger = createLogger();
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = join(HERE, "public");

export function createApp({ bearerToken = process.env.API_BEARER_TOKEN, service, rateLimit, publicDir = DEFAULT_PUBLIC_DIR } = {}) {
  if (!bearerToken) {
    throw new Error(
      "API_BEARER_TOKEN is not set. Set it in the environment (never hardcode it) before starting the server."
    );
  }
  // Lazy import so tests can inject a mock `service` without pulling in the
  // real tool modules (and therefore the real network) at all.
  const svc = service;

  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      // Strict CSP covering BOTH the JSON API and the static frontend
      // (webapp/public/): same-origin only, no inline scripts/styles, no
      // plugins/frames. See webapp/public/js/render.js — the frontend never
      // needs 'unsafe-inline' because it never builds HTML strings, only
      // DOM nodes via textContent/createElement.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: true,
      referrerPolicy: { policy: "no-referrer" },
      frameguard: { action: "deny" },
      noSniff: true,
    })
  );
  app.use(express.json({ limit: "64kb" }));

  // Static frontend (webapp/public/) — served WITHOUT auth/rate-limit (it's
  // just HTML/CSS/JS shell, no data); the UI itself supplies a bearer token
  // (kept in the browser's localStorage, see js/app.js) on every /api call.
  app.use(
    express.static(publicDir, {
      index: "index.html",
      extensions: false,
      dotfiles: "ignore",
      setHeaders: (res) => res.set("X-Content-Type-Options", "nosniff"),
    })
  );

  const clientLimiter = new ClientRateLimiter(rateLimit || { windowMs: 60_000, max: 30 });
  app.use("/api", rateLimitMiddleware(clientLimiter));

  // Bearer auth on everything under /api EXCEPT /api/health (security: [] in
  // the OpenAPI spec).
  app.use("/api", (req, res, next) => {
    if (req.path === "/health") return next();
    const auth = req.headers.authorization || "";
    const [scheme, token] = auth.split(" ");
    if (scheme !== "Bearer" || token !== bearerToken) {
      return res.status(401).json({ error: "internal_error", message: "Unauthorized." });
    }
    next();
  });

  app.use("/api", healthRouter());
  app.use("/api", searchRouter(svc));
  app.use("/api", rankRouter(svc));
  app.use("/api", priceRouter(svc));

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: "No such route." });
  });

  app.use(errorMiddleware(logger));
  return app;
}

// Only actually import the real tool-backed service and start listening when
// run directly — importing this file for tests never touches the network.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { searchHotels, rankOffers, priceHotel } = await import("./service.mjs");
  const app = createApp({ service: { searchHotels, rankOffers, priceHotel } });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1"; // localhost only, per threat model
  app.listen(port, host, () => {
    logger.info(`hotel-deal-finder listening on http://${host}:${port}`);
  });
}
