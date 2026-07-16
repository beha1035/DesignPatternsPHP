// POST /api/search
import { Router } from "express";
import { parseSearchRequest } from "../lib/validate.mjs";
import { ValidationError } from "../lib/errors.mjs";

export function searchRouter({ searchHotels }) {
  const router = Router();
  router.post("/search", async (req, res, next) => {
    try {
      const parsed = parseSearchRequest(req.body);
      if (!parsed.ok) throw new ValidationError(parsed.message, parsed.details);
      const result = await searchHotels(parsed.data);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
