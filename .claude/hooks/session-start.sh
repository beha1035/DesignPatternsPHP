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
    # 2. Surface the price-API key(s) (set as environment secrets) to the tools.
    #    SerpApi/Google Hotels is the preferred path (Amadeus SS closes 2026-07-17).
    [ -n "${SERPAPI_KEY:-}" ] && echo "export SERPAPI_KEY=${SERPAPI_KEY}"
    if [ -n "${AMADEUS_CLIENT_ID:-}" ] && [ -n "${AMADEUS_CLIENT_SECRET:-}" ]; then
      echo "export AMADEUS_CLIENT_ID=${AMADEUS_CLIENT_ID}"       # Enterprise only
      echo "export AMADEUS_CLIENT_SECRET=${AMADEUS_CLIENT_SECRET}"
    fi
    # Optional cascade keys (key-gated tiers self-skip when unset).
    [ -n "${APIFY_TOKEN:-}" ] && echo "export APIFY_TOKEN=${APIFY_TOKEN}"                     # Tier 0 breadth
    [ -n "${APIFY_HOTEL_ACTOR:-}" ] && echo "export APIFY_HOTEL_ACTOR=${APIFY_HOTEL_ACTOR}"
    [ -n "${BRIGHTDATA_API_KEY:-}" ] && echo "export BRIGHTDATA_API_KEY=${BRIGHTDATA_API_KEY}" # Tier 2 unblocker
    [ -n "${BRIGHTDATA_ZONE:-}" ] && echo "export BRIGHTDATA_ZONE=${BRIGHTDATA_ZONE}"
  } >> "$CLAUDE_ENV_FILE"
fi

# --- 3. Report readiness (non-fatal) ----------------------------------------
if [ -n "${SERPAPI_KEY:-}" ]; then
  log "SERPAPI_KEY detected — verified-price validation via Google Hotels enabled."
else
  log "No SERPAPI_KEY set. Add it as an environment secret to enable verified"
  log "prices (key at https://serpapi.com). The free browserless Tier 1"
  log "(tunisiebooking-rate) + web-search estimates still work without it."
fi
[ -n "${APIFY_TOKEN:-}" ] && log "APIFY_TOKEN detected — Tier 0 multi-OTA breadth enabled."
[ -n "${BRIGHTDATA_API_KEY:-}" ] && log "BRIGHTDATA_API_KEY detected — Tier 2 managed unblocker enabled (browser demoted to last resort)."

# --- 4. Network preflight to the price-API host (informative only) ----------
if command -v curl >/dev/null 2>&1; then
  cacert=""
  [ -f /root/.ccr/ca-bundle.crt ] && cacert="--cacert /root/.ccr/ca-bundle.crt"
  # Relies on HTTPS_PROXY from the environment (as configured for this session).
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 $cacert \
    "https://serpapi.com/search.json?engine=google_hotels" 2>/dev/null)
  code=${code:-000}
  case "$code" in
    000) log "Preflight: serpapi.com unreachable (network/egress). Allowlist"
         log "           serpapi.com in this environment, or run tools locally." ;;
    403|407) log "Preflight: egress policy blocks serpapi.com (HTTP $code)."
             log "           Allowlist serpapi.com in this environment or run locally." ;;
    *)   log "Preflight: serpapi.com reachable (HTTP $code)." ;;
  esac
fi

exit 0
