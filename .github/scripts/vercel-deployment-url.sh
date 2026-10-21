#!/usr/bin/env bash
# Reads `vercel deploy` stdout and prints its one deployment URL.
# Vercel can print warnings to stdout too, such as lockfile parse errors, so the
# full output goes to stderr for the job log.
set -euo pipefail

output="$(cat)"
printf '%s\n' "$output" >&2
urls="$(grep -E '^https://[[:alnum:].-]+\.vercel\.app$' <<<"$output" || true)"
if [[ -z "$urls" || "$urls" == *$'\n'* ]]; then
  echo "Expected one Vercel deployment URL in the deploy output." >&2
  exit 1
fi
printf '%s\n' "$urls"
