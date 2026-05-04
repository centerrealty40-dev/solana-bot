#!/usr/bin/env bash
# scripts/platform/install-pre-commit.sh
#
# Installs a pre-commit hook in the current product's git repository
# that runs the platform-level boundary checker. Idempotent.
#
# Usage:
#   cd <product-repo>     # e.g. cd meteora-dash
#   bash <workspace>/scripts/platform/install-pre-commit.sh
#
# After install, every `git commit` in this repo will run the
# boundary checks. Override with: CHECK_BOUNDARIES=skip git commit ...

set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[install-pre-commit] not inside a git repo (cwd=$(pwd))" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_PATH="$REPO_ROOT/.git/hooks/pre-commit"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/check-boundaries.sh"

if [[ ! -x "$CHECKER" ]]; then
  chmod +x "$CHECKER" 2>/dev/null || true
fi

mkdir -p "$REPO_ROOT/.git/hooks"

cat > "$HOOK_PATH" <<EOF
#!/usr/bin/env bash
# Auto-installed by scripts/platform/install-pre-commit.sh
# Runs the multi-product boundary checker before every commit.
# Override (use sparingly): CHECK_BOUNDARIES=skip git commit ...
exec "$CHECKER" "\$@"
EOF
chmod +x "$HOOK_PATH"

echo "[install-pre-commit] installed: $HOOK_PATH"
echo "[install-pre-commit] -> delegates to: $CHECKER"
