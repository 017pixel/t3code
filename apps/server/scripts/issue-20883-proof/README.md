# Public notification evidence fixture

This is capture tooling for issue 20883, not production behavior. It drives the
real Codex adapter and orchestration through a local deterministic protocol peer.
No subscription, credential, permission, sandbox, or MCP changes are needed.
The peer never executes the approval's command. All fixture text is public.

From the worktree, with the existing dev server stopped:

```sh
mkdir -p /tmp/issue-20883-public-project
git init /tmp/issue-20883-public-project
git -C /tmp/issue-20883-public-project -c user.name=Proof -c user.email=proof@example.invalid commit --allow-empty -m 'Public evidence fixture'
printf '1792670400000' > /tmp/issue-20883-clock
T3_PROOF_CLOCK=/tmp/issue-20883-clock \
NODE_OPTIONS="--import=$PWD/apps/server/scripts/issue-20883-proof/clock.mjs" \
T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false \
./node_modules/.bin/vp run dev --home-dir /tmp/issue-20883-capture-home
```

Use a new T3 preview tab, pair through the startup URL, and evaluate `browser.js`
in that tab. Its absolute worktree paths must match the capture checkout.
Run `await proof.seed()` once in a fresh home. It uses supported project and
thread commands and settings updates. Wait for the shell to contain six public
threads. Navigate to `/<proof.env>/proof-other`, then run `proof.freeze()`.
Capture light/dark at freeform 1440×900 and 390×844. No device preset/emulation.
Read and report the actual browser DPR and zoom; do not override those properties.

Stop the retained server session and copy the fresh **public fixture** home to a
private local baseline. Restore that baseline only with the server stopped.
Never upload the home: it includes browser auth even though its thread data is public.
For each SHA/cell restore the same baseline. Preserve the evidence scripts outside
the checkout before switching to a base SHA that predates this fixture commit.
Pass the external clock script path in NODE_OPTIONS on base as necessary.

For a lifecycle, call `await proof.send('proof-complete','complete')`, wait for
`/tmp/issue-20883-gate.ready`, and verify the real UI running state. Start the T3
preview recording, then `touch /tmp/issue-20883-gate` to release the native turn.
The supported peer variants are `complete`, `input`, `approval`, `failed`, `limited`;
use their corresponding thread IDs. Wait for the actual expected toast rather
than inferring that the protocol event was accepted. Unsupported classifications
remain unverified. Advance the server clock file by 1000ms before later runs so
successive completion timestamps are distinct; match that sequence on both SHAs.

Capture pre-action; open the target through its real sidebar DIV role=button
(accessible name includes `, Public notification proof`) or the configured
previous/next keyboard shortcut. On narrow web open the drawer first. Capture
post-action after the 500ms exit animation and before normal toast expiration.
Keep the recording running throughout; record action/checkpoint offsets. No
toast-manager calls, coordinator mocks, projection writes, or DOM toast injection.
Clock freezing changes Date only; timers and CSS animation run normally.

Generate matched PNG diffs with `python3 diff.py before.png after.png prefix`.
Images are converted to RGB with Pillow, same-size comparison, no registration,
resizing or cropping. Diff0 amplifies absolute per-channel deltas 16×, clipped at
255; Diff8 marks pixels magenta when maximum channel delta >8/255, black otherwise.
Always report actual differences and all unverified matrix subcases. Restore
`fix/issue-20883` after base captures and stop only retained server sessions.
