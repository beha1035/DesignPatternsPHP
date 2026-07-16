// validate — strict, schema-first input validation mirroring
// docs/api/openapi.yaml exactly (types, patterns, additionalProperties:false,
// min/max). This is the FIRST anti-SSRF gate: no field resembling a URL is
// ever declared in these schemas, unknown fields are rejected outright
// (`.strict()`), and hotelId/slug are constrained to shapes that can never be
// (or contain) a URL, a path-traversal, or a host override.
//
// Every exported `*Schema` is a zod schema; `parseX(input)` returns
// `{ ok:true, data }` or `{ ok:false, error, details }` (never throws) so
// route handlers can build the OpenAPI `Error` response directly.

import { z } from "zod";

export const MAX_WINDOW_DAYS = 30; // x-max-window-days

// ---- primitives -------------------------------------------------------------

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must match YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a real calendar date");

export const CurrencySchema = z.enum(["EUR", "TND", "USD", "GBP"]);

export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, "ISO-3166 alpha-2");

// Country ISO2 + '/' + [a-z0-9-]+. A single slash only: path traversal
// (`../`), extra segments, and absolute/relative URLs are structurally
// impossible to express in this pattern.
export const SlugSchema = z
  .string()
  .max(80)
  .regex(/^[a-z]{2}\/[a-z0-9-]+$/, "must match ^[a-z]{2}/[a-z0-9-]+$");

// hotelId: strictly a positive integer — never a free string, never a URL.
export const HotelIdSchema = z.coerce.number().int().min(1);

export const OccupantsSchema = z
  .object({
    adults: z.number().int().min(1).max(8),
    childrenAges: z.array(z.number().int().min(0).max(17)).max(6).default([]),
  })
  .strict();

// ---- request bodies ----------------------------------------------------------

const NAME_PATTERN = /^[\p{L}0-9 '&.,-]+$/u;
const CITY_PATTERN = /^[\p{L} '-]+$/u;

export const SearchRequestSchema = z
  .object({
    name: z.string().min(2).max(120).regex(NAME_PATTERN, "no URLs / forbidden characters").optional(),
    city: z.string().min(2).max(80).regex(CITY_PATTERN, "no URLs / forbidden characters").optional(),
    country: CountryCodeSchema.optional(),
  })
  .strict()
  .refine((v) => v.name != null || v.city != null, {
    message: "one of `name` or `city` is required",
  });

const WINDOW_PATTERN = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;

const RankRequestBase = z
  .object({
    slug: SlugSchema.optional(),
    slugs: z.array(SlugSchema).min(1).max(10).optional(),
    window: z.string().regex(WINDOW_PATTERN, "must match START..END (ISO)").optional(),
    nights: z.number().int().min(1).max(30).default(2),
    checkin: IsoDateSchema.optional(),
    checkout: IsoDateSchema.optional(),
    occupants: OccupantsSchema,
    currency: CurrencySchema.default("EUR"),
    escalate: z.boolean().default(false),
  })
  .strict();

export const RankRequestSchema = RankRequestBase.superRefine((v, ctx) => {
  const hasSlug = v.slug != null;
  const hasSlugs = v.slugs != null;
  if (hasSlug === hasSlugs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slug"], message: "exactly one of `slug` or `slugs` is required" });
  }
  const hasWindow = v.window != null;
  const hasFixed = v.checkin != null && v.checkout != null;
  if (!hasWindow && !hasFixed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window"], message: "one of `window` or `checkin`+`checkout` is required" });
  }
  // Reject providing BOTH — ambiguous which date source drives the sweep.
  if (hasWindow && (v.checkin != null || v.checkout != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window"], message: "provide EITHER `window` OR `checkin`+`checkout`, not both" });
  }
  if ((v.checkin != null) !== (v.checkout != null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checkout"], message: "checkin and checkout must be provided together" });
  }
  if (hasWindow) {
    const [start, end] = v.window.split("..");
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window"], message: "window contains an invalid date" });
      return;
    }
    if (startMs >= endMs) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window"], message: "window START must be strictly before END" });
      return;
    }
    const spanDays = Math.round((endMs - startMs) / 86_400_000);
    if (spanDays > MAX_WINDOW_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window"],
        message: `window span (${spanDays}d) exceeds x-max-window-days (${MAX_WINDOW_DAYS})`,
      });
    }
  }
  if (hasFixed) {
    const ci = Date.parse(v.checkin);
    const co = Date.parse(v.checkout);
    if (co <= ci) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checkout"], message: "checkout must be after checkin" });
    } else {
      const spanDays = Math.round((co - ci) / 86_400_000);
      if (spanDays > MAX_WINDOW_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checkout"],
          message: `stay span (${spanDays}d) exceeds x-max-window-days (${MAX_WINDOW_DAYS})`,
        });
      }
    }
  }
});

// ---- /api/hotels/{id}/price -------------------------------------------------

export const PricePathSchema = z
  .object({
    id: HotelIdSchema,
  })
  .strict();

export const PriceQuerySchema = z
  .object({
    checkin: IsoDateSchema,
    checkout: IsoDateSchema,
    adults: z.coerce.number().int().min(1).max(8),
    childrenAges: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((v) => {
        if (v == null) return [];
        const raw = Array.isArray(v) ? v.join(",") : v;
        return raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number);
      })
      .pipe(z.array(z.number().int().min(0).max(17)).max(6)),
    currency: CurrencySchema.optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.checkout) > Date.parse(v.checkin), {
    message: "checkout must be after checkin",
    path: ["checkout"],
  });

// ---- helpers -----------------------------------------------------------------

function formatZodIssues(zodError) {
  return zodError.issues.map((i) => ({
    field: i.path.join(".") || "(root)",
    issue: i.message,
  }));
}

export function parseWith(schema, input) {
  const res = schema.safeParse(input);
  if (res.success) return { ok: true, data: res.data };
  return {
    ok: false,
    message: res.error.issues[0]?.message || "validation failed",
    details: formatZodIssues(res.error),
  };
}

export const parseSearchRequest = (body) => parseWith(SearchRequestSchema, body);
export const parseRankRequest = (body) => parseWith(RankRequestSchema, body);
export const parsePricePath = (params) => parseWith(PricePathSchema, params);
export const parsePriceQuery = (query) => parseWith(PriceQuerySchema, query);

// Split "tn/la-cigale-tabarka" -> { countryPart: "tn", key: "la-cigale-tabarka" }.
// Already guaranteed shape-safe by SlugSchema; this never touches the network
// or the filesystem — pure string work.
export function parseSlugParts(slug) {
  const [countryPart, ...rest] = slug.split("/");
  return { countryPart, key: rest.join("/") };
}
