#!/usr/bin/env bash
set -uo pipefail

echo '===== DNS lite-api.jup.ag ====='
getent hosts lite-api.jup.ag || echo 'DNS FAIL lite-api'
echo
echo '===== DNS api.jup.ag ====='
getent hosts api.jup.ag || echo 'DNS FAIL api.jup.ag'
echo
echo '===== curl lite-api swap v1 quote (USDC) ====='
curl --max-time 8 -sS -w '\nHTTP=%{http_code} TIME=%{time_total}\n' \
  'https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=400&onlyDirectRoutes=false&asLegacyTransaction=false' \
  | head -c 1200
echo
echo
echo '===== curl lite-api swap v1 quote (BONK) ====='
curl --max-time 8 -sS -w '\nHTTP=%{http_code} TIME=%{time_total}\n' \
  'https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263&amount=625000000&slippageBps=400&onlyDirectRoutes=false&asLegacyTransaction=false' \
  | head -c 1200
