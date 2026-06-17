#!/usr/bin/env bash
# populate-codebase-node.sh — Auto-detect codebase section from git diff and write to TIM.
#
# Usage: ./scripts/populate-codebase-node.sh [--dry-run] [--commit SHA]
#   --dry-run: show what would be written, don't call MCP
#   --commit SHA: analyze a specific commit instead of unstaged diff
#   (default): analyze working tree changes (unstaged files)
#
# This script:
# 1. Reads git diff / commit to detect changed files
# 2. Maps file paths to codebaseSection values
# 3. Calls TIM MCP to write/update the corresponding codebase node
#
# Integration: can be called from post-commit hook.
#   .git/hooks/post-commit: exec scripts/populate-codebase-node.sh --commit HEAD
#
# Dependencies: git, node (for MCP transport)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_HELPER="$SCRIPT_DIR/populate-codebase-node.mjs"

# ---- Parse args ----
DRY_RUN=false
COMMIT_SHA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --commit) COMMIT_SHA="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---- Ignore patterns (git filters) ----
# These patterns are filtered out before classification
# Note: these are additional ignores on top of .gitignore
IGNORE_GLOB="node_modules|dist/|\.git|\.tsbuildinfo|\.js\.map|\.d\.ts"

# ---- Section mapping rules ----
# Pattern → codebaseSection
# Order matters: first match wins.
# shellcheck disable=SC2016
declare -A SECTION_MAP
SECTION_MAP=(
  # Package source files → modules (sub-categorised by package name)
  ["packages/tim-core/"]="modules"
  ["packages/tim-store/"]="modules"
  ["packages/tim-sync/"]="modules"
  ["packages/tim-sync-client/"]="modules"
  ["packages/tim-mcp/"]="modules"
  ["packages/tim-cli/"]="modules"
  ["packages/tim-search/"]="modules"
  ["packages/tim-summarizer/"]="modules"
  ["packages/tim-migrate/"]="modules"
  ["packages/tim-hooks/"]="modules"
  ["packages/tim-skills/"]="modules"

  # Test files → tests
  ["__tests__/"]="tests"
  [".test.ts"]="tests"
  [".spec.ts"]="tests"

  # Config files → config
  ["tsconfig.json"]="config"
  ["package.json"]="config"
  [".tim-project"]="config"
  ["config.ts"]="config"

  # Entry points → entry-points
  ["packages/tim-mcp/src/server.ts"]="entry-points"
  ["packages/tim-cli/src/cli.ts"]="entry-points"
  ["packages/tim-summarizer/src/summarize.ts"]="entry-points"

  # Conventions changes → conventions
  [".editorconfig"]="conventions"
  [".gitignore"]="conventions"
  [".prettierrc"]="conventions"
  ["eslintrc"]="conventions"

  # Pipeline scripts → pipeline
  ["scripts/"]="pipeline"
  ["github/"]="pipeline"

  # Default fallback for changed package src files
  ["packages/"]="modules"
)

# ---- Get changed files ----
get_changed_files() {
  if [[ -n "$COMMIT_SHA" ]]; then
    git -C "$REPO_ROOT" diff-tree --no-commit-id -r --name-only "$COMMIT_SHA" 2>/dev/null
  else
    # Unstaged changes (working tree)
    git -C "$REPO_ROOT" diff --name-only 2>/dev/null
    # Also include staged changes
    git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null
  fi
}

# ---- Classify files to section ----
classify_file() {
  local file="$1"
  for pattern in "${!SECTION_MAP[@]}"; do
    if [[ "$file" == *"$pattern"* ]]; then
      echo "${SECTION_MAP[$pattern]}"
      return
    fi
  done
  echo "modules"  # default fallback
}

# ---- Build section summary from changed files ----
declare -A SECTION_FILES
CHANGED_FILES=$(get_changed_files | sort -u | grep -v -E "$IGNORE_GLOB" | grep -v '^\s*$' || true)

if [[ -z "$CHANGED_FILES" ]]; then
  echo "[populate-codebase-node] No changed files detected."
  exit 0
fi

echo "[populate-codebase-node] Changed files:"
while IFS= read -r file; do
  section=$(classify_file "$file")
  SECTION_FILES["$section"]="${SECTION_FILES[$section]:-}$file"$'\n'
  echo "  → $section: $file"
done <<< "$CHANGED_FILES"

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "[populate-codebase-node] DRY RUN — no MCP calls made."
  echo "Would write codebase nodes for sections:"
  for section in "${!SECTION_FILES[@]}"; do
    count=$(echo "${SECTION_FILES[$section]}" | grep -c '[^[:space:]]' || true)
    echo "  $section ($count files)"
  done
  exit 0
fi

# ---- Write to TIM via MCP ----
for section in "${!SECTION_FILES[@]}"; do
  file_list="${SECTION_FILES[$section]}"
  file_count=$(echo "$file_list" | grep -c '[^[:space:]]' || true)
  title="${section}: ${file_count} file(s) changed"

  if [[ -n "$COMMIT_SHA" ]]; then
    commit_msg=$(git -C "$REPO_ROOT" log --format="%s" -1 "$COMMIT_SHA" 2>/dev/null || echo "")
    title="${section}: ${commit_msg}"
  fi

  echo ""
  echo "[populate-codebase-node] Writing: $title"
  echo "Files:"
  echo "$file_list" | while IFS= read -r fl; do [[ -n "$fl" ]] && echo "  - $fl"; done

  node "$MCP_HELPER" <<< "$(cat <<JSON
{
  "section": "$section",
  "title": "$title",
  "content": "Changed files for $section:\n\n$file_list",
  "tags": ["#codebase", "#$section"]
}
JSON
)"
done

echo ""
echo "[populate-codebase-node] Done."
