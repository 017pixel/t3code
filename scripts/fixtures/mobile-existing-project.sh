#!/usr/bin/env bash
set -euo pipefail

# Register through the CLI so fixtures have coherent project events, even with a running server.
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
fixture_home=${1:?Usage: mobile-existing-project.sh ISOLATED_T3_HOME [FIXTURE_ROOT]}
fixture_root=${2:-"$HOME/t3-23246-repro"}
fixture_home=$(realpath -m "$fixture_home")
if [[ "$fixture_home" == "$(realpath -m "$HOME/.t3")" ]]; then
  echo 'Use an isolated T3 home.' >&2
  exit 1
fi
mkdir -p "$fixture_root"
fixture_root=$(cd "$fixture_root" && pwd)

for name in bike-documents unregistered-local; do
  folder="$fixture_root/$name"
  mkdir -p "$folder"
  if [[ ! -d "$folder/.git" ]]; then
    git init --quiet "$folder"
    git -C "$folder" -c user.name='Mobile fixture' -c user.email='fixture@example.invalid' \
      commit --quiet --allow-empty -m 'Initialize mobile project fixture'
  fi
done

cd "$repo_root"
if result=$(node apps/server/src/bin.ts project add --base-dir "$fixture_home" \
  --title 'Bike documents repro' "$fixture_root/bike-documents" 2>&1); then
  printf '%s\n' "$result"
elif [[ "$result" == *"An active project already exists for '$fixture_root/bike-documents'."* ]]; then
  printf 'Reusing registered project at %s\n' "$fixture_root/bike-documents"
else
  printf '%s\n' "$result" >&2
  exit 1
fi

printf 'P=%s\nQ=%s\nR=%s\nS=%s\n' \
  "$fixture_root/bike-documents" "$fixture_root/unregistered-local" \
  "$fixture_root/tracked-clone" "$fixture_root/legacy-clone"
# R/S remain absent. Re-running never removes a project or a completed clone.
