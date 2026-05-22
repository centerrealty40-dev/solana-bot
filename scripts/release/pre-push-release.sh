#!/usr/bin/env bash
# Full release gate before push to v2/main. Called from pre-push hook.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "[pre-push-release] typecheck..."
npm run typecheck

echo "[pre-push-release] import graph (tracked files)..."
node scripts/release/check-import-graph.mjs --tracked-only

echo "[pre-push-release] release hygiene..."
npm run check:hygiene

BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [[ "$BR" == "v2" ]]; then
  echo "[pre-push-release] integration hygiene (clean tree on v2)..."
  npm run check:hygiene:integration
fi

echo "[pre-push-release] OK — safe to push; wait for GitHub CI green before VPS deploy"
