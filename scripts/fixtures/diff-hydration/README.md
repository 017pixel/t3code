# Diff hydration visual fixture

Start an isolated T3 dev server once with
`vp run dev --home-dir <isolated-home>` to run database migrations, then stop
that terminal session with Ctrl-C.
Never target the shared T3 home or a running server's home.

From this checkout, with `<isolated-home>` already initialized and stopped:

```sh
node scripts/fixtures/diff-hydration/seed.mjs --directory /tmp/diff-hydration-repro --supplementary --oversized
node scripts/fixtures/diff-hydration/seed-app.mjs --base-dir <isolated-home> --directory /tmp/diff-hydration-repro --server-stopped
```

Restart the same isolated server. Open thread `11739000-0000-4000-8000-000000000002`
in the **Diff hydration fixture** project, then Changes or Latest turn and
`docstring.py`. Changes contains both edits; Latest turn compares saved ordinal
1 to 2, changing documentation line 11. Turn 1 compares saved ordinal 0 to 1.
All providers remain stopped. Use Turn 1 or Changes for the supplementary files.

The app seeder inserts only visual projections, using the same approach as the
app testing fixture helper. It does not construct event history or prove backend
command behavior. Re-running it updates only this fixture's fixed identifiers.
For matched before/after evidence, register the same repository in both isolated
homes while **both servers are stopped**, then restart both.
