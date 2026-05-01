#!/usr/bin/env bash
set -uo pipefail
cd /opt/solana-alpha

echo '===== git HEAD on server ====='
sudo -u salpha git log -1 --oneline
echo
echo '===== pt1-dno process details (start time / restarts) ====='
sudo -u salpha pm2 describe pt1-dno 2>/dev/null | grep -E 'created at|status|restarts|uptime' | head -10
echo
echo '===== heartbeat counters last 5 ====='
tail -200 /home/salpha/.pm2/logs/pt1-dno-out.log 2>/dev/null | grep heartbeat | tail -5 \
  | python3 /tmp/_w74_parse_hb.py
echo
echo '===== last 8 open events with priceVerify (full chronology) ====='
tail -3000 /opt/solana-alpha/data/paper2/pt1-dno.jsonl > /tmp/_w74_pt1dno_full.jsonl
python3 - <<'PY'
import json
opens=[]
with open('/tmp/_w74_pt1dno_full.jsonl') as f:
    for ln in f:
        try: o=json.loads(ln)
        except: continue
        if o.get('kind')=='open' and isinstance(o.get('priceVerify'), dict):
            opens.append(o)
print(f'total opens with priceVerify: {len(opens)}')
import datetime as dt
for o in opens[-10:]:
    ts=o.get('ts',0)
    when=dt.datetime.utcfromtimestamp(ts/1000).strftime('%H:%M:%S')
    pv=o.get('priceVerify',{})
    print(f"  {when}Z mint={o.get('mint','')[:8]}  pv.kind={pv.get('kind')}  pv.reason={pv.get('reason','-')}  ageMs={pv.get('ageMs','-')}")
PY
echo
echo '===== fetch test from inside pt1-dno via salpha shell (CHECK URL is new) ====='
sudo -u salpha node -e "
import('dotenv/config').then(async () => {
  const url = process.env.PAPER_PRICE_VERIFY_QUOTE_URL || 'https://lite-api.jup.ag/swap/v1/quote';
  console.log('PAPER_PRICE_VERIFY_QUOTE_URL=', process.env.PAPER_PRICE_VERIFY_QUOTE_URL ?? '(unset)');
  console.log('using URL=', url);
  const test = url + '?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=400';
  try {
    const r = await fetch(test);
    console.log('http=', r.status, ' bytes=', (await r.text()).length);
  } catch(e) {
    console.log('ERROR:', e?.name, e?.message, e?.cause?.message);
  }
});
" 2>&1 | head -10
echo
echo '===== price-verify warnings in pt1-dno logs after 18:38 (5bdc5a3 reload) ====='
awk '/2026-05-01T18:3[8-9]|2026-05-01T18:[4-5][0-9]|2026-05-01T19:|2026-05-01T2[0-9]:/' \
  /home/salpha/.pm2/logs/pt1-dno-out.log /home/salpha/.pm2/logs/pt1-dno-error.log 2>/dev/null \
  | grep -iE 'price-verify|jupiter|verifyEntry|fetch.fail|abort|ENOTFOUND|getaddrinfo' | tail -20 || echo '(no log matches)'
