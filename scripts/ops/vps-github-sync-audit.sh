#!/usr/bin/env bash
# Audit: prod VPS git clone vs GitHub (read-only). Exit 0 = in sync, 1 = drift.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/solana-alpha}"
CANON_BRANCH="${CANON_BRANCH:-v2}"
FALLBACK_BRANCH="${FALLBACK_BRANCH:-release/sa-alpha-1.11.350}"

cd "$APP_DIR"

git fetch origin "$CANON_BRANCH" "$FALLBACK_BRANCH" 2>/dev/null || git fetch origin

HEAD_SHA="$(git rev-parse HEAD)"
CANON_SHA="$(git rev-parse "origin/${CANON_BRANCH}" 2>/dev/null || echo missing)"
FB_SHA="$(git rev-parse "origin/${FALLBACK_BRANCH}" 2>/dev/null || echo missing)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
DIRTY="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"

echo "=== VPS GitHub sync audit ==="
echo "app_dir:      $APP_DIR"
echo "local_branch: $BRANCH"
echo "HEAD:         $HEAD_SHA"
echo "origin/$CANON_BRANCH: $CANON_SHA"
echo "origin/$FALLBACK_BRANCH: $FB_SHA"
echo "tracked_dirty: $DIRTY file(s)"

if [[ "$HEAD_SHA" == "$CANON_SHA" && "$BRANCH" == "$CANON_BRANCH" && "$DIRTY" == "0" ]]; then
  echo "OK: prod matches origin/$CANON_BRANCH"
  exit 0
fi

if [[ "$HEAD_SHA" == "$FB_SHA" && "$DIRTY" == "0" ]]; then
  echo "WARN: prod matches origin/$FALLBACK_BRANCH but not origin/$CANON_BRANCH (merge release -> v2 pending?)"
  exit 0
fi

if [[ "$HEAD_SHA" == "$CANON_SHA" || "$HEAD_SHA" == "$FB_SHA" ]]; then
  echo "WARN: SHA matches GitHub but branch=$BRANCH or dirty=$DIRTY"
  exit 1
fi

echo "FAIL: prod HEAD not on origin/$CANON_BRANCH or origin/$FALLBACK_BRANCH"
git status -sb || true
exit 1
