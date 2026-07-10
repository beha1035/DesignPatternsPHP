#!/bin/bash
# SessionStart hook — readies the hotel-deal-finder agent's rate-validation
# tools at session start. Idempotent, non-interactive, never fails the session.
set -uo pipefail

log() { echo "[hotel-agent hook] $*" >&2; }

# --- 1. Make Node's fetch honour the outbound proxy + trust its CA ----------
# The validation tools (amadeus-rate.mjs) use global fetch, which only uses
# HTTPS_PROXY when NODE_USE_ENV_PROXY=1, and needs the proxy CA for TLS.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo 'export NODE_USE_ENV_PROXY=1'
    if [ -f /root/.ccr/ca-bundle.crt ]; then
      echo 'export NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt'
    fi
    # 2. Surface Amadeus credentials (set as environment secrets) to the tools.
    if [ -n "${AMADEUS_CLIENT_ID:-}" ] && [ -n "${AMADEUS_CLIENT_SECRET:-}" ]; then
      echo "export AMADEUS_CLIENT_ID=${AMADEUS_CLIENT_ID}"
      echo "export AMADEUS_CLIENT_SECRET=${AMADEUS_CLIENT_SECRET}"
    fi
  } >> "$CLAUDE_ENV_FILE"
fi

# --- 3. Report readiness (non-fatal) ----------------------------------------
if [ -n "${AMADEUS_CLIENT_ID:-}" ] && [ -n "${AMADEUS_CLIENT_SECRET:-}" ]; then
  log "Amadeus credentials detected — verified-price validation enabled."
else
  log "No AMADEUS_CLIENT_ID/SECRET set. Add them as environment secrets to enable"
  log "verified prices (free app at https://developers.amadeus.com). Falling back"
  log "to browser deep-link validation + web-search estimates."
fi

# --- 4. Network preflight to the Amadeus host (informative only) ------------
if command -v curl >/dev/null 2>&1; then
  cacert=""
  [ -f /root/.ccr/ca-bundle.crt ] && cacert="--cacert /root/.ccr/ca-bundle.crt"
  # Relies on HTTPS_PROXY from the environment (as configured for this session).
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 $cacert \
    https://test.api.amadeus.com/v1/security/oauth2/token 2>/dev/null)
  code=${code:-000}
  case "$code" in
    000) log "Preflight: Amadeus host unreachable (network/egress). Run locally with"
         log "           your key, or allowlist test.api.amadeus.com in egress." ;;
    403|407) log "Preflight: egress policy blocks test.api.amadeus.com (HTTP $code)."
             log "           Allowlist the host in this environment or run locally." ;;
    *)   log "Preflight: Amadeus host reachable (HTTP $code)." ;;
  esac
fi

exit 0
