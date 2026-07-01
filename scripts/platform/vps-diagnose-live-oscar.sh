#!/usr/bin/env bash
# Read-only Live Oscar + discovery diagnostics on VPS. Safe from iPhone Cloud Agent.
#
#   bash scripts/platform/vps-diagnose-live-oscar.sh
#
# Requires VPS SSH secrets — see docs/agents/CLOUD_AGENT_VPS_SSH.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_root() {
  bash "${SCRIPT_DIR}/vps-ssh.sh" "$@"
}

run_salpha() {
  bash "${SCRIPT_DIR}/vps-ssh.sh" --salpha "$@"
}

echo "=== vps-ssh connectivity ==="
run_root --test
echo

echo "=== git HEAD (prod clone) ==="
run_salpha 'git rev-parse HEAD && git status -sb | head -3'
echo

echo "=== pm2: live-oscar + collectors ==="
run_salpha 'pm2 jlist 2>/dev/null | node -e "
const apps=JSON.parse(require(\"fs\").readFileSync(0,\"utf8\"));
const names=new Set([\"live-oscar\",\"live-oscar-dashboard\",\"sa-raydium\",\"sa-meteora\",\"sa-orca\",\"sa-moonshot\",\"sa-pumpswap\",\"sa-wallet-orchestrator\"]);
for (const a of apps) {
  if (!names.has(a.name)) continue;
  const m=a.pm2_env?.status||\"?\";
  const s=(a.pm2_env?.pm_exec_path||a.pm2_env?.script||\"\").split(\"/\").pop();
  console.log(String(a.name).padEnd(26), m.padEnd(10), s||\"?\");
}
" 2>/dev/null || pm2 list | grep -E "live-oscar|sa-raydium|sa-meteora|sa-orca|sa-moonshot|sa-pumpswap|sa-wallet"'
echo

echo "=== last heartbeat (live JSONL) ==="
run_salpha 'tail -400 data/live/pt1-oscar-live.jsonl 2>/dev/null | grep "\"heartbeat\"" | tail -1 | node -e "
let l=\"\"; process.stdin.on(\"data\",d=>l+=d); process.stdin.on(\"end\",()=>{
  try {
    const j=JSON.parse(l.trim());
    console.log(JSON.stringify({
      ts: j.ts,
      openPositions: j.openPositions,
      closedTotal: j.closedTotal,
      reconcileBlocksNewExposure: j.reconcileBlocksNewExposure,
      nearReadyDipWait: j.nearReadyDipWaitCount,
    }, null, 2));
  } catch { console.log(l.slice(0,500)||\"(no heartbeat line)\"); }
});"'
echo

echo "=== discovery health snapshot ==="
run_salpha 'cat data/live-discovery-health.json 2>/dev/null || echo "(missing data/live-discovery-health.json)"'
echo

echo "=== recent blocks/skips (last ~300 JSONL lines) ==="
run_salpha 'tail -300 data/live/pt1-oscar-live.jsonl 2>/dev/null | grep -E "risk_block|execution_skip|parity_notional|btc_dump|data_coverage|phase5_skip" | tail -15 || echo "(none in tail)"'
echo

echo "=== collector scripts actually configured (ecosystem PM2) ==="
run_salpha 'node -e "
const c=require(\"./ecosystem.config.cjs\");
const pick=[\"sa-meteora\",\"sa-orca\",\"sa-pumpswap\",\"sa-raydium\"];
for (const a of c.apps) if (pick.includes(a.name)) console.log(a.name, \"->\", (a.script||\"\").split(\"/\").pop());
"'
echo
echo "=== done (read-only) ==="
