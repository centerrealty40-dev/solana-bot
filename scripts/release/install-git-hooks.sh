#!/usr/bin/env bash
# Install local git hooks that enforce release gates (typecheck, import graph, hygiene).
# Idempotent. Run from repo root: bash scripts/release/install-git-hooks.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
RELEASE_DIR="$REPO_ROOT/scripts/release"

mkdir -p "$HOOKS_DIR"

cat > "$HOOKS_DIR/pre-commit" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [[ "${SKIP_RELEASE_HOOKS:-}" == "1" ]]; then
  echo "[pre-commit] SKIP_RELEASE_HOOKS=1 — hooks skipped (log this override)"
  exit 0
fi

echo "[pre-commit] staged import graph..."
node scripts/release/check-staged-imports.mjs

echo "[pre-commit] typecheck..."
npm run typecheck

echo "[pre-commit] OK"
EOF

cat > "$HOOKS_DIR/pre-push" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [[ "${SKIP_RELEASE_HOOKS:-}" == "1" ]]; then
  echo "[pre-push] SKIP_RELEASE_HOOKS=1 — hooks skipped (log this override)"
  exit 0
fi

while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/v2|refs/heads/main)
      echo "[pre-push] release gate for ${remote_ref#refs/heads/}..."
      bash scripts/release/pre-push-release.sh
      ;;
    *)
      echo "[pre-push] skip release gate for ${remote_ref:-<delete>}"
      ;;
  esac
done
EOF

chmod +x "$HOOKS_DIR/pre-commit" "$HOOKS_DIR/pre-push"
chmod +x "$RELEASE_DIR/pre-push-release.sh" "$RELEASE_DIR/post-deploy-smoke.sh" 2>/dev/null || true

echo "[install-git-hooks] installed:"
echo "  $HOOKS_DIR/pre-commit  -> check-staged-imports + npm run typecheck"
echo "  $HOOKS_DIR/pre-push    -> pre-push-release.sh on push to v2/main"
echo ""
echo "Override (incident only): SKIP_RELEASE_HOOKS=1 git commit|push"
