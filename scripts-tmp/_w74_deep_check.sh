#!/usr/bin/env bash
set -uo pipefail

echo '===== full pm2 describe pt1-dno ====='
sudo -u salpha pm2 describe pt1-dno 2>/dev/null
echo
echo '===== /proc env of pt1-dno node process ====='
PID=$(sudo -u salpha pm2 jlist 2>/dev/null | python3 -c "
import json, sys
arr = json.load(sys.stdin)
for a in arr:
    if a.get('name')=='pt1-dno':
        print(a.get('pid',0))
        break
" 2>/dev/null || echo 0)
echo "pt1-dno pid=$PID"
if [ "$PID" != "0" ] && [ -r "/proc/$PID/environ" ]; then
  sudo cat "/proc/$PID/environ" | tr '\0' '\n' | grep -E 'PAPER_PRICE_VERIFY|PAPER_SAFETY' | sort
fi
echo
echo '===== probe Jupiter from inside salpha shell ====='
sudo -u salpha node -e "
const url = process.env.PAPER_PRICE_VERIFY_QUOTE_URL || 'https://lite-api.jup.ag/swap/v1/quote';
console.log('test url=', url);
fetch(url + '?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=400').then(async r => {
  console.log('http=', r.status);
  console.log('body=', (await r.text()).slice(0, 200));
}).catch(e => console.log('ERROR:', e?.message, 'cause=', e?.cause?.message));
"
sleep 2
echo
echo '===== last 3 opens with priceVerify (full json) ====='
tail -2000 /opt/solana-alpha/data/paper2/pt1-dno.jsonl | python3 - <<'PY'
import json, sys, time
opens=[]
for ln in sys.stdin:
    try:
        o=json.loads(ln)
    except: continue
    if o.get('kind')=='open' and isinstance(o.get('priceVerify'), dict):
        opens.append(o)
print(f'total opens with priceVerify: {len(opens)}')
for o in opens[-3:]:
    print(f"  ts={o.get('ts')} mint={o.get('mint','')[:8]} pv={json.dumps(o.get('priceVerify'))}")
PY
echo
echo '===== last 5 heartbeats ====='
tail -200 /home/salpha/.pm2/logs/pt1-dno-out.log 2>/dev/null | grep heartbeat | tail -5 | python3 /tmp/_w74_parse_hb.py
echo
echo '===== price-verify log lines (look for warnings) ====='
tail -3000 /home/salpha/.pm2/logs/pt1-dno-out.log /home/salpha/.pm2/logs/pt1-dno-error.log 2>/dev/null \
  | grep -iE 'price-verify|verifyEntry|jupiter|quote-api|lite-api' | tail -20 || echo '(no matches)'
