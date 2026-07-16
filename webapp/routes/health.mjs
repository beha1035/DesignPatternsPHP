// GET /api/health — no auth (security: [] in openapi.yaml), no external calls.
import { Router } from "express";

const START = Date.now();
const VERSION = "1.0.0";

export function healthRouter({ cacheOk = () => true, fxOk = () => true } = {}) {
  const router = Router();
  router.get("/health", (req, res) => {
    const checks = {
      cache: cacheOk() ? "ok" : "fail",
      fx: fxOk() ? "ok" : "fail",
    };
    const status = Object.values(checks).every((v) => v === "ok") ? "ok" : "degraded";
    res.json({
      status,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - START) / 1000),
      checks,
    });
  });
  return router;
}
