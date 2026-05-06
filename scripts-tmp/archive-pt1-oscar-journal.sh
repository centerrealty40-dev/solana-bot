#!/usr/bin/env bash
# One-off: reset paper Oscar dashboard history before a new experiment week.
# Run on VPS as the same user that owns the file (typically salpha), from repo root or any cwd.
set -euo pipefail
ROOT="${SA_ROOT:-/opt/solana-alpha}"
J="${1:-$ROOT/data/paper2/pt1-oscar.jsonl}"
if [[ ! -f "$J" ]]; then
  echo "no file: $J (nothing to archive)"
  exit 0
fi
TS="$(date -u +%Y%m%dT%H%MZ)"
BAK="${J}.bak-${TS}"
mv "$J" "$BAK"
touch "$J"
chmod 664 "$BAK" "$J" 2>/dev/null || true
echo "archived -> $BAK, empty -> $J"
