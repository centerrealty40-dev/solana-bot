#!/usr/bin/env bash
set -uo pipefail
APPS="dashboard-organizer-paper sa-raydium sa-meteora sa-orca sa-moonshot sa-jupiter sa-direct-lp pt1-diprunner pt1-oscar pt1-dno"
ANY=0
for app in $APPS; do
  out=$(pm2 logs "$app" --err --lines 20 --nostream 2>/dev/null | grep -Ei 'error|failed|fatal|throw' | grep -v 'last 20 lines' | head -5 || true)
  if [ -n "$out" ]; then
    ANY=1
    echo "== $app =="
    echo "$out"
  fi
done
if [ "$ANY" = "0" ]; then
  echo "no errors in any app stderr (last 20 lines)"
fi
