#!/bin/bash
# Diagnose Dune API connectivity & permissions

DUNE_KEY=$(grep "^DUNE_API_KEY=" /opt/solana-alpha/.env | cut -d= -f2-)
echo "=== key length: ${#DUNE_KEY} (should be ~32) ==="
echo "=== key prefix: ${DUNE_KEY:0:6}... ==="
echo

echo "=== TEST 1: GET /api/v1/user/me (just auth check) ==="
curl -sS -w "\nHTTP_CODE: %{http_code}\n" \
  "https://api.dune.com/api/v1/user/me" \
  -H "X-Dune-API-Key: $DUNE_KEY"
echo
echo "----"
echo

echo "=== TEST 2: POST /api/v1/query/ (create query) ==="
curl -sS -w "\nHTTP_CODE: %{http_code}\n" \
  -X POST "https://api.dune.com/api/v1/query/" \
  -H "X-Dune-API-Key: $DUNE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query_sql":"SELECT 1 AS test","name":"diag-test","is_private":true}'
echo
echo "----"
echo

echo "=== TEST 3: POST /api/v1/query (no trailing slash) ==="
curl -sS -w "\nHTTP_CODE: %{http_code}\n" \
  -X POST "https://api.dune.com/api/v1/query" \
  -H "X-Dune-API-Key: $DUNE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query_sql":"SELECT 1 AS test","name":"diag-test"}'
echo
echo "----"
echo

echo "=== TEST 4: list user queries (read-only check) ==="
curl -sS -w "\nHTTP_CODE: %{http_code}\n" \
  "https://api.dune.com/api/v1/user/queries" \
  -H "X-Dune-API-Key: $DUNE_KEY"
echo
