// logger — tiny structured console logger with SECRET REDACTION. Every secret
// value present in process.env at startup (bearer token, API keys) is
// registered and stripped from any log line before it is written, so an
// accidental interpolation (e.g. an upstream error message that echoes back a
// query string containing a token) can never leak a secret into logs.

const SECRET_ENV_VARS = [
  "API_BEARER_TOKEN",
  "APIFY_TOKEN",
  "SERPAPI_KEY",
  "BRIGHTDATA_API_KEY",
];

function collectSecrets(env = process.env) {
  return SECRET_ENV_VARS.map((k) => env[k]).filter((v) => v && v.length >= 4); // ignore trivial/empty values
}

function redact(line, secrets) {
  let out = line;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("***REDACTED***");
  }
  return out;
}

export function createLogger(env = process.env, { stream = console } = {}) {
  const secrets = collectSecrets(env);
  const ts = () => new Date().toISOString();
  const write = (level, args) => {
    const line = `[${ts()}] ${level.toUpperCase()} ${args.map(String).join(" ")}`;
    stream[level === "warn" ? "warn" : level === "error" ? "error" : "log"](redact(line, secrets));
  };
  return {
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    // Re-scan env in case secrets were set after module load (tests).
    _refreshSecrets: () => {
      secrets.length = 0;
      secrets.push(...collectSecrets(env));
    },
  };
}

export const logger = createLogger();
