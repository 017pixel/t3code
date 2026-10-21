#!/usr/bin/env bash
set -euo pipefail
fixture_root=${1:?Usage: seed.sh DISPOSABLE_PROJECT_ROOT}
script_root=$(cd -- "$(dirname -- "$0")" && pwd)
python3 "$script_root/fixture.py" init "$fixture_root"
git -C "$fixture_root" rev-parse --git-dir >/dev/null 2>&1 || git init "$fixture_root"
# Add the printed root through the app's Add project > Local folder command.
# Choose Claude; ask Read of ROOT/evidence-public/repro.png. Wait for completion.
# Expand that Read, overwrite with blue-inplace, then ask a second Read in that thread.
printf 'Public fixture project: %s\n' "$fixture_root"
