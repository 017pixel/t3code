#!/bin/bash
# Builds one row's git fixture: a local bare repo acting as the remote, and a work clone
# whose origin URL is https://github.invalid/acme/demo.git (pushes rewritten to the bare repo).
# Usage: fixture.sh <row-dir> <R1|R2a|R2b|R3|R4a|R4b>
set -euo pipefail
R=$1; ROW=$2
B=$R/remote.git; W=$R/work; U=https://github.invalid/acme/demo.git
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
rm -rf "$R"; mkdir -p "$R"
DEF=main; case $ROW in R4*) DEF=trunk ;; esac
git init -q --bare -b main "$B"
git init -q -b "$DEF" "$W"; cd "$W"
git config user.name Fixture; git config user.email fixture@example.invalid
git remote add origin "$U"
git config url."$B".pushInsteadOf "$U"
F() { git -c url."$B".insteadOf="$U" "$@"; }
echo m > m; git add m; git commit -qm "Main commit"; git push -q -u origin "$DEF"
case $ROW in R4*) ;; *) git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main ;; esac
git switch -qc parent; echo p > p; git add p; git commit -qm "Parent commit"
case $ROW in R1|R2a|R2b) git push -q -u origin parent ;; esac
git switch -qc child; echo c > c; git add c; git commit -qm "Child commit"; git push -q -u origin child
git config branch.child.gh-merge-base parent
case $ROW in
  R2a) git -C "$B" branch -q -D parent; F fetch -q --prune origin ;;
  R2b) git -C "$B" branch -q -D parent ;;
  R4b) git config --unset branch.child.gh-merge-base ;;
esac
