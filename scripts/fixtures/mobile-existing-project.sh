#!/usr/bin/env bash
set -euo pipefail

# Register through the CLI so fixtures have coherent project events, even with a running server.
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
fixture_home=${1:?Usage: mobile-existing-project.sh ISOLATED_T3_HOME [FIXTURE_ROOT]}
fixture_home=$(realpath -m "$fixture_home")
if [[ "$fixture_home" == "$(realpath -m "$HOME/.t3")" ]]; then
  echo 'Use an isolated T3 home.' >&2
  exit 1
fi
fixture_root=${2:-$(mktemp -d "${TMPDIR:-/tmp}/t3-mobile-existing-project.XXXXXX")}
mkdir -p "$fixture_root"
fixture_root=$(cd "$fixture_root" && pwd)

# The original script's empty initial commit also identifies fixtures recorded before this guard.
for name in bike-documents unregistered-local; do
  folder="$fixture_root/$name"
  if [[ -e "$folder" || -L "$folder" ]]; then
    if [[ -L "$folder" || ! -d "$folder/.git" ]] ||
      [[ "$(git -C "$folder" log --max-parents=0 --format='%s%n%an%n%ae' 2>/dev/null)" != $'Initialize mobile project fixture\nMobile fixture\nfixture@example.invalid' ]] ||
      [[ -n "$(git -C "$folder" ls-tree "$(git -C "$folder" rev-list --max-parents=0 HEAD)" 2>/dev/null)" ]]; then
      printf 'Refusing to modify non-fixture folder: %s\n' "$folder" >&2
      exit 1
    fi
  fi
done

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
