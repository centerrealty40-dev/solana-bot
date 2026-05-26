#!/usr/bin/env bash
# scripts/platform/check-boundaries.sh
#
# Cross-product change guard. Run as a git pre-commit hook in any product's
# repository, or invoke manually before pushing.
#
# Reads docs/platform/products.yaml to learn which dirs/prefixes belong to
# which product, then inspects the staged diff (or HEAD diff if no stage).
#
# Fails (exit 1) if:
#   - the diff touches files belonging to more than one product without
#     an explicit "Cross-product:" line in the commit message;
#   - the diff introduces an env var that doesn't carry any known
#     product prefix or whitelisted shared prefix;
#   - the diff modifies docs/platform/PRODUCT_REGISTRY.md by hand
#     (it must be regenerated from products.yaml);
#   - the diff modifies docs/platform/** without bumping VERSION and
#     adding a CHANGELOG entry.
#
# Pass (exit 0) silently if all checks succeed.
#
# Override: set CHECK_BOUNDARIES=skip in env to bypass (use sparingly,
# meant for emergency hotfixes; the override is logged).

set -euo pipefail

# ---- locate platform root -------------------------------------------------

# Walk up from CWD looking for docs/platform/products.yaml. Works whether
# this script is invoked from a per-product subrepo or from the workspace
# root. Falls back to the script's own ancestors if needed.
find_platform_root() {
  local dir
  dir="$(pwd)"
  while [[ "$dir" != "/" && "$dir" != "" ]]; do
    if [[ -f "$dir/docs/platform/products.yaml" ]]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  # fallback: relative to this script
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  dir="$script_dir"
  while [[ "$dir" != "/" && "$dir" != "" ]]; do
    if [[ -f "$dir/docs/platform/products.yaml" ]]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

PLATFORM_ROOT="$(find_platform_root || true)"
if [[ -z "$PLATFORM_ROOT" ]]; then
  echo "[check-boundaries] WARNING: docs/platform/products.yaml not found upwards; skipping checks." >&2
  exit 0
fi

YAML="$PLATFORM_ROOT/docs/platform/products.yaml"

# ---- escape hatch ---------------------------------------------------------

if [[ "${CHECK_BOUNDARIES:-}" == "skip" ]]; then
  echo "[check-boundaries] SKIPPED via CHECK_BOUNDARIES=skip — log this." >&2
  exit 0
fi

# ---- gather diff ----------------------------------------------------------

# Staged files (pre-commit). If nothing staged, fall back to last commit.
CHANGED_FILES="$(git diff --cached --name-only 2>/dev/null || true)"
DIFF_BODY="$(git diff --cached -U0 2>/dev/null || true)"
SCOPE="staged"
if [[ -z "$CHANGED_FILES" ]]; then
  CHANGED_FILES="$(git diff HEAD~1 HEAD --name-only 2>/dev/null || true)"
  DIFF_BODY="$(git diff HEAD~1 HEAD -U0 2>/dev/null || true)"
  SCOPE="HEAD~1..HEAD"
fi
if [[ -z "$CHANGED_FILES" ]]; then
  exit 0
fi

# Commit message (HEAD's, if exists).
COMMIT_MSG="$(git log -1 --format=%B 2>/dev/null || true)"

# ---- parse products.yaml --------------------------------------------------

# Extract product_key + repo_dirs and env_prefix lists. Hand-rolled to avoid
# yq/python dependencies. We rely on the strict shape we control in yaml.
declare -A PROD_DIRS=()
declare -a ALL_ENV_PREFIXES=()

current_key=""
in_repo_dirs=0
in_env_prefix=0
while IFS= read -r line; do
  if [[ "$line" =~ ^\ \ -\ product_key:\ (.+)$ ]]; then
    current_key="${BASH_REMATCH[1]}"
    in_repo_dirs=0
    in_env_prefix=0
    continue
  fi
  if [[ "$line" =~ ^\ \ \ \ repo_dirs:\ ?$ ]]; then
    in_repo_dirs=1
    in_env_prefix=0
    continue
  fi
  if [[ "$line" =~ ^\ \ \ \ env_prefix:\ ?$ ]]; then
    in_env_prefix=1
    in_repo_dirs=0
    continue
  fi
  # leaving a list block when next field at same or shallower indent
  if [[ $in_repo_dirs -eq 1 || $in_env_prefix -eq 1 ]]; then
    if [[ "$line" =~ ^\ \ \ \ \ \ -\ (.+)$ ]]; then
      val="${BASH_REMATCH[1]}"
      if [[ $in_repo_dirs -eq 1 ]]; then
        PROD_DIRS["$current_key"]="${PROD_DIRS[$current_key]:-} $val"
      else
        ALL_ENV_PREFIXES+=("$val")
      fi
      continue
    elif [[ "$line" =~ ^\ \ \ \ [a-z] ]]; then
      in_repo_dirs=0
      in_env_prefix=0
    fi
  fi
done < "$YAML"

# ---- 1) detect manual edits to PRODUCT_REGISTRY.md -----------------------

if echo "$CHANGED_FILES" | grep -qE '^docs/platform/PRODUCT_REGISTRY\.md$'; then
  if ! echo "$CHANGED_FILES" | grep -qE '^docs/platform/products\.yaml$'; then
    echo "[check-boundaries] FAIL: docs/platform/PRODUCT_REGISTRY.md was edited but docs/platform/products.yaml was not." >&2
    echo "  PRODUCT_REGISTRY.md is generated. Edit products.yaml and run:" >&2
    echo "    node docs/platform/generate-registry.mjs" >&2
    exit 1
  fi
fi

# ---- 2) platform changes require VERSION bump + CHANGELOG entry ----------

PLATFORM_FILES_CHANGED=$(echo "$CHANGED_FILES" | grep -cE '^(docs/platform/|docs/agents/|\.cursor/rules/multi-product-platform\.mdc|scripts/platform/)' || true)
PLATFORM_FILES_CHANGED=${PLATFORM_FILES_CHANGED:-0}

if [[ "$PLATFORM_FILES_CHANGED" -gt 0 ]]; then
  if ! echo "$CHANGED_FILES" | grep -qE '^docs/platform/VERSION$'; then
    echo "[check-boundaries] FAIL: platform files changed but docs/platform/VERSION was not bumped." >&2
    echo "  Bump VERSION (semver) and add an entry to docs/platform/PLATFORM_CHANGELOG.md." >&2
    exit 1
  fi
  if ! echo "$CHANGED_FILES" | grep -qE '^docs/platform/PLATFORM_CHANGELOG\.md$'; then
    echo "[check-boundaries] FAIL: platform files changed but docs/platform/PLATFORM_CHANGELOG.md was not updated." >&2
    echo "  Append a new entry at the top per the template in that file." >&2
    exit 1
  fi
fi

# ---- 3) cross-product touch detection ------------------------------------

declare -A TOUCHED_PRODUCTS=()
for f in $CHANGED_FILES; do
  for key in "${!PROD_DIRS[@]}"; do
    for d in ${PROD_DIRS[$key]}; do
      # match if file path starts with the dir (or equals it)
      if [[ "$f" == "$d" || "$f" == "$d/"* ]]; then
        TOUCHED_PRODUCTS["$key"]=1
      fi
    done
  done
done

TOUCHED_COUNT=${#TOUCHED_PRODUCTS[@]}
if [[ $TOUCHED_COUNT -gt 1 ]]; then
  if ! echo "$COMMIT_MSG" | grep -qiE '^[Cc]ross-product:'; then
    echo "[check-boundaries] FAIL: $SCOPE diff touches multiple products: ${!TOUCHED_PRODUCTS[*]}" >&2
    echo "  Add a 'Cross-product: <reason>' line to your commit message, or split the change." >&2
    exit 1
  fi
fi

# ---- 4) env var prefix discipline ----------------------------------------
# Look at lines ADDED in the diff that introduce assignments like
#   FOO_BAR=...
# in code/config. Allow shared prefixes (NEXT_PUBLIC_, NODE_), and core
# system vars (DATABASE_URL, PORT, HOSTNAME, LOG_LEVEL, NODE_ENV).
SHARED_OK_REGEX='^(NEXT_PUBLIC_|NODE_)'
SYSTEM_OK_REGEX='^(DATABASE_URL|PORT|HOSTNAME|LOG_LEVEL|NODE_ENV|PATH|HOME|USER|PWD|LANG|TZ|TERM)$'

# Build a regex of all known product prefixes.
KNOWN_PREFIX_REGEX=""
for ep in "${ALL_ENV_PREFIXES[@]}"; do
  if [[ -z "$KNOWN_PREFIX_REGEX" ]]; then
    KNOWN_PREFIX_REGEX="^${ep}"
  else
    KNOWN_PREFIX_REGEX="${KNOWN_PREFIX_REGEX}|^${ep}"
  fi
done

violations=()
while IFS= read -r line; do
  # only consider added lines outside diff metadata
  [[ "$line" =~ ^\+[A-Z][A-Z0-9_]*= ]] || continue
  varname="${line#+}"
  varname="${varname%%=*}"
  # checks
  if [[ "$varname" =~ $SYSTEM_OK_REGEX ]]; then continue; fi
  if [[ -n "$SHARED_OK_REGEX" && "$varname" =~ $SHARED_OK_REGEX ]]; then continue; fi
  if [[ -n "$KNOWN_PREFIX_REGEX" && "$varname" =~ $KNOWN_PREFIX_REGEX ]]; then continue; fi
  violations+=("$varname")
done <<< "$DIFF_BODY"

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "[check-boundaries] FAIL: env var(s) introduced without a known product prefix:" >&2
  for v in "${violations[@]}"; do echo "    $v" >&2; done
  echo "  Allowed prefixes (from products.yaml): ${ALL_ENV_PREFIXES[*]}" >&2
  echo "  Allowed shared: NEXT_PUBLIC_*, NODE_*, plus standard system vars." >&2
  exit 1
fi

# ---- success -------------------------------------------------------------
exit 0
