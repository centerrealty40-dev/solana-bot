#!/usr/bin/env bash
set -uo pipefail

echo '===== DNS resolve ====='
getent hosts quote-api.jup.ag || echo 'DNS FAIL'
echo
echo '===== TCP/HTTPS handshake (with verbose) ====='
curl -v --max-time 8 -sS -o /tmp/_jq_body.json -w 'HTTP=%{http_code} TIME=%{time_total}\n' \
  'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=400&onlyDirectRoutes=false&asLegacyTransaction=false' 2>&1 | head -40
echo
echo '===== body sample (first 600 chars) ====='
head -c 600 /tmp/_jq_body.json 2>/dev/null
echo
echo
echo '===== same call, different mint (real meme coin example, BONK) ====='
curl --max-time 8 -sS -w '\nHTTP=%{http_code} TIME=%{time_total}\n' \
  'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263&amount=625000000&slippageBps=400&onlyDirectRoutes=false&asLegacyTransaction=false' \
  | head -c 800
echo
echo
echo '===== outbound HTTP via system curl, verify CA bundle works ====='
curl -sS --max-time 5 -w 'gh=%{http_code}\n' https://api.github.com/zen | head -c 200
echo
echo
echo '===== node fetch test (matches our runtime) ====='
sudo -u salpha node -e "
const main = async () => {
  const url = 'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=400';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    console.log('node-fetch status=', r.status);
    console.log('body=', (await r.text()).slice(0, 400));
  } catch (e) {
    console.log('node-fetch ERROR:', e?.name, e?.message, '\\ncause=', e?.cause?.message);
  } finally { clearTimeout(t); }
};
main();
"
echo
echo '===== look at recent papertrader logs for jupiter / price-verify entries ====='
tail -2000 /home/salpha/.pm2/logs/pt1-dno-out.log /home/salpha/.pm2/logs/pt1-dno-error.log 2>/dev/null \
  | grep -iE 'jupiter|price-verify|quote-api|priceVerify|verifyEntry|fetch-fail|abort' | tail -25 || echo '(no log matches)'
