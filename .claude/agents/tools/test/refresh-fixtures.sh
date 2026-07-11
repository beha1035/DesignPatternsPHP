#!/usr/bin/env bash
# Regenerate the TunisieBooking parser fixtures from the live site. Run this ONLY
# when the site legitimately changed and you've updated the parser to match — the
# whole point of committed fixtures is that they DON'T move on their own.
#
#   bash .claude/agents/tools/test/refresh-fixtures.sh
#
# Needs the open network (proxy CONNECT allowed for tn.tunisiebooking.com) and the
# proxy CA env already set by the SessionStart hook.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/fixtures"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
BASE="https://tn.tunisiebooking.com/theme/traitement_detailv_contre_proposition_new_v4.php"

fetch() { # <checkin DD/MM/YYYY> <out>
  curl -sS --compressed -G -H "User-Agent: $UA" -H "Accept-Language: fr-FR,fr;q=0.9" \
    -H "X-Requested-With: XMLHttpRequest" -H "Referer: https://tn.tunisiebooking.com/detail_hotel_354/" \
    --data-urlencode "id_hotel_xml=354" --data-urlencode "formule=" --data-urlencode "session=" \
    --data-urlencode "testmodif=0" --data-urlencode "ville=Tabarka" --data-urlencode "chambres=1" \
    --data-urlencode "integrateur=" --data-urlencode "token=" --data-urlencode "type_chambre=" \
    --data-urlencode "DOPBookingSystem_CheckIn1=$1" --data-urlencode "nbr_nuit=2" \
    --data-urlencode "adultes1=2" --data-urlencode "enfants1=1" --data-urlencode "age1_1=10" \
    "$BASE" -o "$2"
  echo "wrote $2 ($(wc -c < "$2") bytes)"
}

fetch "14/07/2026" "$DIR/tunisiebooking-354-verified.html"
# Drift fixture is derived, not fetched: rename price_* so rooms render but no price parses.
sed 's/name="price_/name="prixNEW_/g' "$DIR/tunisiebooking-354-verified.html" > "$DIR/tunisiebooking-354-drift.html"
echo "derived drift fixture"
echo "NOTE: the sold-out fixture (tunisiebooking-354-nodispo.html) is hand-authored with the real failure### marker; leave it as-is."
