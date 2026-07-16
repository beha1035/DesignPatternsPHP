// errors — typed errors mapped 1:1 onto the OpenAPI `Error` schema and HTTP
// status codes (`components.responses.*` in openapi.yaml). Route handlers
// throw these; a single Express error middleware (see server.mjs) renders
// them. No route ever hand-builds an ad-hoc error JSON shape.

export class ApiError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message);
    this.status = status;
    this.error = error; // validation_error | not_found | rate_limited | upstream_blocked | internal_error
    this.extra = extra; // { details?, channelStatus?, retryAfterSeconds? }
  }

  toBody() {
    const body = { error: this.error, message: this.message };
    if (this.extra.details) body.details = this.extra.details;
    if (this.extra.channelStatus) body.channelStatus = this.extra.channelStatus;
    return body;
  }
}

export class ValidationError extends ApiError {
  constructor(message, details) {
    super(400, "validation_error", message, { details });
  }
}

export class NotFoundError extends ApiError {
  constructor(message) {
    super(404, "not_found", message);
  }
}

export class RateLimitedError extends ApiError {
  constructor(message, retryAfterSeconds) {
    super(429, "rate_limited", message, { retryAfterSeconds });
  }
}

export class UpstreamBlockedError extends ApiError {
  constructor(message, channelStatus = "blocked") {
    super(502, "upstream_blocked", message, { channelStatus });
  }
}

export class InternalError extends ApiError {
  constructor(message) {
    super(500, "internal_error", message);
  }
}

// Express error-handling middleware (must have 4 args to be recognised).
// Secrets never appear in `message` (callers must not interpolate env vars);
// unexpected errors are logged server-side but rendered with a generic
// message to the client.
export function errorMiddleware(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof ApiError) {
      if (err.extra.retryAfterSeconds) {
        res.set("Retry-After", String(err.extra.retryAfterSeconds));
      }
      logger.warn(`${err.error} ${req.method} ${req.path}: ${err.message}`);
      return res.status(err.status).json(err.toBody());
    }
    logger.error(`unhandled error on ${req.method} ${req.path}: ${err?.stack || err}`);
    return res.status(500).json({ error: "internal_error", message: "Internal server error." });
  };
}
