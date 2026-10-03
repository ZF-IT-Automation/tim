#!/usr/bin/env bash
# Install TIM into a throwaway node:22 container and exercise it like a new user.
#
#   scripts/sandbox/run.sh [ref] [scenario...]     scenarios: fresh installer (default: both)
#
# The repository is mounted read-only at /src and cloned at <ref> (default: HEAD's
# branch), so only committed work is tested. Nothing on the host is touched.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
common="$(cd "$(git -C "$repo" rev-parse --git-common-dir)/.." && pwd)"
ref="${1:-$(git -C "$repo" rev-parse --abbrev-ref HEAD)}"; shift || true
scenarios=("${@:-fresh installer}")
status=0
for s in ${scenarios[@]}; do
  echo "=== scenario $s @ $ref"
  docker run --rm -u node -e HOME=/home/node -e REF="$ref" -w /home/node \
    -v "$common":/src:ro -v "$here":/sb:ro node:22-bookworm \
    bash -c 'git config --global --add safe.directory "*"; bash /sb/'"$s"'.sh' 2>&1 | tee "/tmp/tim-sandbox-$s.log" \
    | grep -E '^(####|\[(OK |BAD)\]|.*(ALL OK|FAILED|exit=[1-9]))'
  grep -qE 'FAILED|\[BAD\]|exit=[1-9]' "/tmp/tim-sandbox-$s.log" && status=1
done
echo "full logs: /tmp/tim-sandbox-*.log"
exit $status
