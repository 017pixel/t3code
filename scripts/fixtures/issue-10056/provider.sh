#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == "--version" ]]; then
  echo "codex-cli 0.159.0"
  exit 0
fi
fixture_dir=$(cd -- "$(dirname -- "$0")" && pwd)
export T3_CODEX_COLLAB_SCRIPT="$fixture_dir/provider.json"
exec node "$fixture_dir/../../../apps/server/src/provider/testFixtures/codexCollabMockPeer.mjs" "$@"
