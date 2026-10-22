# Checkpoint diff fixture

Synthetic ACP edits for replaying checkpoint availability in a real app. This
fixture never reads or writes a T3 database and never logs incoming ACP messages.
Use a separate empty root for every replay and submit each turn token once.

From this directory:

```sh
node seed.mjs init /tmp/issue-15843-replay-example
```

Configure the isolated server's Grok executable to run `grok.mjs`, with
`T3_DIFF_FIXTURE_ROOT=/tmp/issue-15843-replay-example` in its environment.
Register the printed project path through the app. The provider accepts marked
`project` directories inside that explicit root, including separately initialized
nested replay roots. It rejects projects outside the root. Do not configure this
executable on a production environment.

Submit a prompt containing a token below. The edit emits immediately; the
provider response stays pending until its gate is released. Q emits a failed edit;
the other tokens emit completed edits. Wait for `gates/<turn>.ready` before
observing the running state. Release with:

```sh
node seed.mjs release /tmp/issue-15843-replay-example A
```

After release, await the app's checkpoint summary before advancing. The ready
file proves only the edit milestone. Q returns a provider error after release;
inspect checkpoint availability rather than assuming failure prevents checkpointing.
The last token in a prompt wins so context handoffs can contain older tokens.

| Token           | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `FIXTURE:FIRST` | First active run with no earlier checkpoint; use a fresh project/thread |
| `FIXTURE:A`     | First completed checkpoint, editing two files                           |
| `FIXTURE:B`     | Later active edit in `other.md`, then checkpoint arrival                |
| `FIXTURE:Q`     | Failed edit with patch text, followed by a provider error               |
| `FIXTURE:F`     | Local edit after the app's genuine fork operation on A                  |
| `FIXTURE:C`     | Third completed checkpoint for historical selection                     |

In an authenticated isolated Vite browser, load the driver through the app origin:

```js
const proof = await import("/test/fixtures/checkpoint-diff/browser-driver.mjs");
await proof.create("/tmp/issue-15843-replay-example", "checkpoint-example");
await proof.start("checkpoint-example", "A");
```

The driver uses normal app commands and the existing browser session; it contains
no credentials. `state(threadId)` reads checkpoint summaries and item ownership.
After releasing A, await `checkpoint(threadId, runId)` using the actual run ID from
`state`. Then submit B and keep it gated. Use `fork(sourceThreadId, targetThreadId,
runId)` for real lineage. After completing a local fork turn, expand the ancestor
work group and its file group to load inherited tool details.

`scenarios.json` fixes file contents and the initial git commit timestamp. App
run IDs and event timestamps remain app-generated. `freezeVisibleClock()` fixes
the browser clock at 2026-10-22T08:00:00Z without changing server clocks or timers.
Use the same backend and synthetic state for before/after web revisions when the
server is unchanged. Keep viewport, theme, panel surfaces, details-panel visibility
and file-collapse choices identical. Wait for fonts and finite transitions before
capturing. Absolute ACP paths may need manual file expansion in the diff panel.

`selectUnavailable(threadId, runId, filePath)` is **harness selection injection**,
not a user action. Open the diff panel and await its mount before injecting: the
normal panel-open layout effect can reset selection to the branch scope. Label
such recordings and stills explicitly. Null contexts, environment collisions and
arbitrary summary removal need separate harness proof; do not present them as
ordinary app lifecycles. Never commit recordings, screenshots, databases or auth.
