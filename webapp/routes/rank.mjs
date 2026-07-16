// POST /api/rank
import { Router } from "express";
import { parseRankRequest } from "../lib/validate.mjs";
import { ValidationError } from "../lib/errors.mjs";
import { CACHE_HIT } from "../lib/cache.mjs";

export function rankRouter({ rankOffers }) {
  const router = Router();
  router.post("/rank", async (req, res, next) => {
    try {
      const parsed = parseRankRequest(req.body);
      if (!parsed.ok) throw new ValidationError(parsed.message, parsed.details);
      const result = await rankOffers(parsed.data);
      res.set("X-Cache", result[CACHE_HIT] ? "HIT" : "MISS");
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
