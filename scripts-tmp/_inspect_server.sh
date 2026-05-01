#!/usr/bin/env bash
set -e
cd /opt/solana-alpha
echo '=== src/papertrader/pricing/ on server ==='
sudo -u salpha ls -la src/papertrader/pricing/
echo
echo '=== tracker.ts liq-watch refs ==='
grep -n 'liq-watch\|loadCurrentPoolLiqUsd\|evaluateLiqDrainState' src/papertrader/executor/tracker.ts | head -10
echo
echo '=== pt1-dno out log last 20 ==='
tail -20 /home/salpha/.pm2/logs/pt1-dno-out.log
echo
echo '=== pt1-dno error log last 30 ==='
tail -30 /home/salpha/.pm2/logs/pt1-dno-error.log 2>&1
echo
echo '=== check if compiled JS exists ==='
ls -la src/papertrader/pricing/liq-watch* 2>&1 || echo '(none)'
ls -la dist/papertrader/pricing/liq-watch* 2>&1 || echo '(no dist)'
echo
echo '=== runtime: how is papertrader actually launched ==='
sudo -u salpha cat package.json | python3 -c "import json,sys; pkg=json.load(sys.stdin); print('papertrader script:', pkg.get('scripts',{}).get('papertrader','MISSING'))"
