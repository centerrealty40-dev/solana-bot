#!/bin/bash
# Delete all private queries created by us to free slots
DUNE_KEY=$(grep "^DUNE_API_KEY=" /opt/solana-alpha/.env | cut -d= -f2-)

# query IDs созданные нами в этой сессии
QUERIES=(7373740 7373742 7373760 7373765 7373766 7373770 7373780)

for QID in "${QUERIES[@]}"; do
  echo -n "deleting query $QID ... "
  RESP=$(curl -sS -w "%{http_code}" -X POST \
    "https://api.dune.com/api/v1/query/$QID/archive" \
    -H "X-Dune-API-Key: $DUNE_KEY" -o /tmp/_d.txt)
  echo "HTTP $RESP"
done

echo "DONE. Проверь в Dune UI — Private queries должно сократиться."
