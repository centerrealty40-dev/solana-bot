#!/usr/bin/env bash
KEY="$(cat /opt/solana-alpha/data/qn-admin-api-key.secret)"
NOW="$(date -u +%s)"
BASE='https://api.quicknode.com/v0/usage/rpc'
for H in 1800 7200 21600; do
  S=$((NOW - H))
  echo "--- last ${H}s ---"
  curl -sS "${BASE}?start_time=${S}&end_time=${NOW}" \
    -H 'accept: application/json' \
    -H "x-api-key: ${KEY}"
  echo
done
