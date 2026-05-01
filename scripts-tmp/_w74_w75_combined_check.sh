#!/usr/bin/env bash
set -uo pipefail
cd /opt/solana-alpha
set -a; . /opt/solana-alpha/.env; set +a

echo '=================================================='
echo '===== A) git HEAD on server ====='
echo '=================================================='
sudo -u salpha git fetch origin v2 2>&1 | tail -3
sudo -u salpha git log -5 --oneline
echo
echo '===== local files for W7.5 (presence) ====='
ls -la src/papertrader/pricing/liq-watch.ts tests/papertrader-liq-watch.test.ts 2>&1 | head -5
echo
echo '===== W7.5 env keys in .env ====='
grep -E '^PAPER_LIQ_WATCH_' /opt/solana-alpha/.env || echo '(no W7.5 env keys)'
echo
echo '=================================================='
echo '===== B) W7.4 — fresh priceVerify events on pt1-dno (after 5bdc5a3 reload at 18:37Z) ====='
echo '=================================================='
echo 'reload was at 18:37 UTC; we want events with ts > 1777660620000 (18:37 UTC ms)'
RELOAD_MS=1777660620000
tail -3000 /opt/solana-alpha/data/paper2/pt1-dno.jsonl > /tmp/_pv_dno.jsonl
python3 - <<PY
import json, datetime as dt, collections
RELOAD_MS=$RELOAD_MS
total=0; fresh_total=0
fresh_kinds=collections.Counter(); fresh_reasons=collections.Counter()
fresh_slips=[]; samples=[]
with open('/tmp/_pv_dno.jsonl') as f:
    for ln in f:
        try: o=json.loads(ln)
        except: continue
        if o.get('kind')!='open': continue
        if not isinstance(o.get('priceVerify'), dict): continue
        total+=1
        if o.get('ts',0) < RELOAD_MS: continue
        fresh_total+=1
        pv=o['priceVerify']
        k=pv.get('kind','?')
        fresh_kinds[k]+=1
        if k in ('blocked','skipped'):
            fresh_reasons[k+':'+str(pv.get('reason','?'))] += 1
        if k=='ok' and isinstance(pv.get('slipPct'),(int,float)):
            fresh_slips.append(pv['slipPct'])
        if len(samples)<3:
            ts_str=dt.datetime.fromtimestamp(o.get('ts',0)/1000, dt.UTC).strftime('%H:%M:%S')
            samples.append(f"{ts_str}Z mint={o.get('mint','')[:8]} kind={k} reason={pv.get('reason','-')} slipPct={pv.get('slipPct','-')}")
print(f'total opens with priceVerify (whole tail): {total}')
print(f'fresh opens after reload (ts>{RELOAD_MS}): {fresh_total}')
print(f'fresh kind dist: {dict(fresh_kinds)}')
print(f'fresh skip/block reasons: {dict(fresh_reasons)}')
if fresh_slips:
    print(f'fresh slipPct: n={len(fresh_slips)} avg={sum(fresh_slips)/len(fresh_slips):.3f}')
print('first 3 fresh samples:')
for s in samples: print(' ', s)
PY
echo
echo '===== C) per-strategy heartbeat opened counts (ALL pt1-*) ====='
for s in pt1-dno pt1-diprunner pt1-oscar; do
  printf '  %-15s ' "$s"
  tail -100 "/home/salpha/.pm2/logs/$s-out.log" 2>/dev/null | grep heartbeat | tail -1 \
    | python3 /tmp/_w74_parse_hb.py 2>/dev/null || echo '(no heartbeat)'
done
echo
echo '===== D) smoke test verifyEntryPrice on REAL open positions of pt1-dno ====='
sudo -u salpha node --input-type=module -e "
import 'dotenv/config';
import fs from 'node:fs';
const lines = fs.readFileSync('/opt/solana-alpha/data/paper2/pt1-dno.jsonl','utf8').trim().split('\n');
const opens = new Map();
for (const ln of lines) {
  try { const o = JSON.parse(ln);
    if (o.kind==='open' && o.mint && typeof o.entryPriceUsd==='number') opens.set(o.mint, o);
    else if (o.kind==='close' && o.mint) opens.delete(o.mint);
  } catch {}
}
const arr = [...opens.values()].slice(-3);
console.log('testing', arr.length, 'live open positions');
const URL_BASE = process.env.PAPER_PRICE_VERIFY_QUOTE_URL?.trim() || 'https://lite-api.jup.ag/swap/v1/quote';
const SOL_USD = 84;
for (const o of arr) {
  const dec = o?.features?.token_decimals ?? 6;
  const lamports = Math.floor((100/SOL_USD)*1e9);
  const url = new URL(URL_BASE);
  url.searchParams.set('inputMint','So11111111111111111111111111111111111111112');
  url.searchParams.set('outputMint', o.mint);
  url.searchParams.set('amount', String(lamports));
  url.searchParams.set('slippageBps','400');
  try {
    const t0 = Date.now();
    const r = await fetch(url.toString());
    const elapsed = Date.now()-t0;
    const body = await r.text();
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = null; }
    const oa = Number(parsed?.outAmount ?? 0);
    let jp = null, slip = null;
    if (oa > 0) {
      const tokens = oa / Math.pow(10, dec);
      jp = (lamports/1e9)*SOL_USD/tokens;
      slip = +(((o.entryPriceUsd - jp)/o.entryPriceUsd)*100).toFixed(2);
    }
    console.log('  mint='+o.mint.slice(0,8)+' http='+r.status+' '+elapsed+'ms  entryPx='+o.entryPriceUsd+'  jupiterPx='+jp+'  slipPct='+slip);
  } catch (e) {
    console.log('  mint='+o.mint.slice(0,8)+'  ERROR='+e?.message);
  }
}
" 2>&1 | head -20
echo
echo '===== E) /api/paper2/price-verify-stats ====='
curl -sS -u "$DASHBOARD_BASIC_USER:$DASHBOARD_BASIC_PASSWORD" \
  'http://127.0.0.1:3008/api/paper2/price-verify-stats?windowMin=240' | python3 -m json.tool || echo '(error)'
