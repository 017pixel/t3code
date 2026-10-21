# Issue 13622 visual proof fixture

Evidence only. `seed.py` uses the documented stopped-server SQLite projection
fixture path, not orchestration events. It does not run a provider and cannot
prove event processing, streaming, or backend business behavior. All text is
synthetic. No credentials or live data are inputs.

From the repository root (Node 24, Python 3, installed dependencies):

1. `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" node scripts/dev-runner.ts dev --home-dir "$PWD/.evidence-r3-home"`
2. Wait for startup/migrations. Pair your test browser with that startup URL.
3. Stop that captured server process/session.
4. `python3 apps/web/test/fixtures/rtl-proof/seed.py --home-dir "$PWD/.evidence-r3-home" --server-stopped`
5. Restart with the command in step 1. Open the synthetic RTL proof project.
   Threads are `rtl-proof-F1-r3`, `rtl-proof-F2-r3`, `rtl-proof-F3-r3`,
   `rtl-proof-F4-r3`, `rtl-proof-F5-r3`, `rtl-proof-F7-r3`, `rtl-proof-F8-r3`. Workspace file is
   `.evidence-r3-home/synthetic-project/rtl-tasks.md`.

F1: headings/prose/inline code/fence/table. F2: list and task variants.
F3: quotes, all five alerts, aligned and overflow tables. F5: user opt-out.
F7 contains static completed thought and plan items only. Remaining JSON
fields are committed replay/model source, not a claim of integrated coverage.

Before production revision: e27a03e94d43b504cfc3933282af913763312afd.
After production revision: 560f00f72e466aecdc42ac11f2da3b9c086cc49c.
Apply this fixture directory identically to either revision. The capture used
one newly initialized isolated home across both builds (these production
revisions have identical server schemas), preserving the exact seeded database.
Never use live userdata. Screenshots/diffs belong outside git.

Capture environment setup: install Ubuntu `fonts-noto-core`, then run
`python3 apps/web/test/fixtures/rtl-proof/browser-setup.py` and evaluate its
printed expression with the collaborative browser after each navigation. It
freezes browser Date at 2026-10-21T11:00:00Z and supplies Noto Naskh Arabic as
an explicit missing-glyph fallback. This is a disclosed test font override,
not default-font proof; all other app text/font sizes and zoom remain default.
The generated font stays in the ignored isolated home and is not shipped.
Use freeform CSS viewports 1440×1000 or 390×844, DPR 2, browser scale 1,
light/dark prefers-color-scheme emulation (desktop UA, no mobile emulation).

Final fixture thread IDs append `-r3` (for example `rtl-proof-F2-r3`). This
avoids stale client snapshots left by earlier fixture iterations. Rebuilding
starts from a clean isolated home/browser origin; do not reuse older fixture
IDs when changing their contents.

Secondary caller gallery (Vite only, never bundled as a product route):
`http://localhost:<webPort>/test/fixtures/rtl-proof/gallery.html?view=question`.
Views: `question`, `thought`, `secondary`, `contexts`, `pr`, `workflow`,
`attachment`. Every gallery screen is labeled HARNESS ONLY. It imports the real
callers and styles with synthetic props, default permission behavior, and local
callbacks; it does not replace authentication or permissions, register a
provider, create a scheduler task, or contact a forge. The pending question and
active thought are component proofs, not claims of a live provider request.
The secondary view mounts the todo_list non-error and error V2EventTimelineRow detail branches and the
V2ItemInspector reasoning text branch. Contexts mounts both real review-context
popover wrappers. Attachment uses a synthetic Blob in the real read-only
attachment caller. Workflow uses the real folded script caller but never runs.

The JSON streamChunks are source data only; no integrated provider replay is
implemented by this fixture. Do not describe a gallery rerender as streaming
through the real application timeline.

Screenshot recipe: apply the browser setup expression after each navigation,
move the pointer to (0,0), and wait for fonts and two animation frames. Capture
the whole viewport, scrolling the timeline/file/gallery in overlapping frames.
For source previews, wait for `diffs-container pre` through the browser's
shadow-piercing locator before capture; a loading placeholder is not source proof.
The public manifest records exact frame offsets, caller, viewport and theme.
The Browser tool exports 1440×1000 CSS views as 1280×889 PNGs, and 390×844 views
as 780×1688 PNGs. Do not infer native pixel density from the wide export.

`python3 apps/web/test/fixtures/rtl-proof/compare.py /absolute/evidence/directory`
rebuilds both unmasked diff sets and sheets from `manifest-final.json` and its
PNG files (Pillow/numpy required). Thresholds are max absolute RGB channel delta
strictly greater than 0 and 16 on 8-bit channels. Magenta is delta×32, clipped to
255 and raised to at least 64 for every changed pixel, so a one-level change is
visible. The comparison performs no registration, resampling or masking.
