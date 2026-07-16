// GET /api/hotels/{id}/price
import { Router } from "express";
import { parsePricePath, parsePriceQuery } from "../lib/validate.mjs";
import { ValidationError } from "../lib/errors.mjs";
import { CACHE_HIT } from "../lib/cache.mjs";

export function priceRouter({ priceHotel }) {
  const router = Router();
  router.get("/hotels/:id/price", async (req, res, next) => {
    try {
      const path = parsePricePath(req.params);
      if (!path.ok) throw new ValidationError(path.message, path.details);
      const query = parsePriceQuery(req.query);
      if (!query.ok) throw new ValidationError(query.message, query.details);
      const result = await priceHotel({ hotelId: path.data.id, ...query.data });
      res.set("X-Cache", result[CACHE_HIT] ? "HIT" : "MISS");
      res.json(result);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
