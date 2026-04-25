#!/bin/bash
# Universal Dune API runner.
# Usage:
#   bash dune-run.sh "<SQL>" "<name>" [output_csv_path]   # SQL inline
#   bash dune-run.sh @path/to/query.sql "<name>" [out.csv] # SQL from file
# Always writes full JSON result to /tmp/dune-last-result.json
# Reads DUNE_API_KEY from /opt/solana-alpha/.env

set -e

DUNE_KEY=$(grep "^DUNE_API_KEY=" /opt/solana-alpha/.env | cut -d= -f2-)
if [ -z "$DUNE_KEY" ]; then
  echo "ERROR: DUNE_API_KEY not found in /opt/solana-alpha/.env" >&2
  exit 1
fi

ARG1="$1"
NAME="${2:-dune-query-$(date +%s)}"
OUT_CSV="$3"
LAST_JSON=/tmp/dune-last-result.json

if [ -z "$ARG1" ]; then
  echo "Usage: bash dune-run.sh \"<SQL>\" \"<name>\" [out.csv]" >&2
  echo "       bash dune-run.sh @path/to/query.sql \"<name>\" [out.csv]" >&2
  exit 1
fi

if [[ "$ARG1" == @* ]]; then
  SQL_FILE="${ARG1:1}"
  if [ ! -f "$SQL_FILE" ]; then echo "ERROR: file not found: $SQL_FILE" >&2; exit 1; fi
  SQL=$(cat "$SQL_FILE")
else
  SQL="$ARG1"
fi

echo "=== [1/4] creating query: $NAME ==="
echo "  SQL preview (first 200 chars):"
echo "    $(echo "$SQL" | tr '\n' ' ' | cut -c1-200)..."
CREATE_BODY=$(python3 -c "
import json, sys
print(json.dumps({
  'query_sql': sys.argv[1],
  'name': sys.argv[2],
  'is_private': True
}))
" "$SQL" "$NAME")

CREATE_RESP=$(curl -sS -X POST "https://api.dune.com/api/v1/query" \
  -H "X-Dune-API-Key: $DUNE_KEY" \
  -H "Content-Type: application/json" \
  -d "$CREATE_BODY")
echo "  create response: $CREATE_RESP"
QID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('query_id') or r.get('queryId') or '')")
if [ -z "$QID" ]; then echo "ERROR: no query_id" >&2; exit 1; fi
echo "  QUERY_ID=$QID  (https://dune.com/queries/$QID)"

echo "=== [2/4] executing ==="
EXEC_RESP=$(curl -sS -X POST "https://api.dune.com/api/v1/query/$QID/execute" \
  -H "X-Dune-API-Key: $DUNE_KEY")
echo "  $EXEC_RESP"
EID=$(echo "$EXEC_RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('execution_id') or '')")
if [ -z "$EID" ]; then echo "ERROR: no execution_id" >&2; exit 1; fi

echo "=== [3/4] polling status (max 5 min) ==="
for i in $(seq 1 60); do
  STATUS_RESP=$(curl -sS "https://api.dune.com/api/v1/execution/$EID/status" \
    -H "X-Dune-API-Key: $DUNE_KEY")
  STATUS=$(echo "$STATUS_RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('state',''))")
  echo "  [$i/60] state=$STATUS"
  case "$STATUS" in
    QUERY_STATE_COMPLETED) break ;;
    QUERY_STATE_FAILED|QUERY_STATE_CANCELLED|QUERY_STATE_EXPIRED)
      echo "ERROR: query ended with state=$STATUS" >&2
      curl -sS "https://api.dune.com/api/v1/execution/$EID/results" -H "X-Dune-API-Key: $DUNE_KEY" \
        | python3 -m json.tool > "$LAST_JSON"
      echo "  full error written to: $LAST_JSON"
      tail -30 "$LAST_JSON" >&2
      exit 1 ;;
  esac
  sleep 5
done

if [ "$STATUS" != "QUERY_STATE_COMPLETED" ]; then echo "ERROR: timeout" >&2; exit 1; fi

echo "=== [4/4] fetching results ==="
if [ -n "$OUT_CSV" ]; then
  curl -sS "https://api.dune.com/api/v1/execution/$EID/results/csv" \
    -H "X-Dune-API-Key: $DUNE_KEY" > "$OUT_CSV"
  ROWS=$(($(wc -l < "$OUT_CSV") - 1))
  SIZE=$(wc -c < "$OUT_CSV")
  echo "  CSV: $OUT_CSV ($ROWS rows, $SIZE bytes)"
  echo "  header: $(head -1 "$OUT_CSV")"
  echo "  first data row: $(sed -n '2p' "$OUT_CSV")"
  echo "  last data row:  $(tail -1 "$OUT_CSV")"
else
  curl -sS "https://api.dune.com/api/v1/execution/$EID/results" \
    -H "X-Dune-API-Key: $DUNE_KEY" > "$LAST_JSON"
  ROWS=$(python3 -c "import json; d=json.load(open('$LAST_JSON')); print(d.get('result',{}).get('metadata',{}).get('total_row_count',0))")
  COLS=$(python3 -c "import json; d=json.load(open('$LAST_JSON')); print(','.join(d.get('result',{}).get('metadata',{}).get('column_names',[])))")
  echo "  rows: $ROWS"
  echo "  cols: $COLS"
  echo "  first row preview:"
  python3 -c "import json; d=json.load(open('$LAST_JSON')); rows=d.get('result',{}).get('rows',[]); 
print('    (no data)' if not rows else json.dumps(rows[0], indent=2, default=str)[:1500])"
  echo
  echo "  full JSON written to: $LAST_JSON"
fi
