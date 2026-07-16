// POST /api/rank
import { Router } from "express";
import { parseRankRequest } from "../lib/validate.mjs";
import { ValidationError } from "../lib/errors.mjs";

export function rankRouter({ rankOffers }) {
  const router = Router();
  router.post("/rank", async (req, res, next) => {
    try {
      const parsed = parseRankRequest(req.body);
      if (!parsed.ok) throw new ValidationError(parsed.message, parsed.details);
      const result = await rankOffers(parsed.data);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
