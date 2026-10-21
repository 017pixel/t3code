# HTML preview evidence fixture

With the isolated worktree dev server stopped, run `python3 apps/server/test/fixtures/issue-16099/seed.py` from the worktree root. It generates A/B/C (line-80 marker), a deterministic >1 MB document, an external host document and a second workspace. It replaces only isolated presentation project/thread/message projections with synthetic records; it does not represent coherent backend history. Never run against live data. Generated workspace files are intentionally untracked evidence inputs, not application code. Captures use the real app and real file APIs.
