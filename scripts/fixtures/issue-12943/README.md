Stop the isolated dev server, then seed an existing empty thread:

```sh
python3 scripts/fixtures/issue-12943/seed.py .t3/userdata/statev2.sqlite '<thread-id>'
```

Restart `vp run dev` and pair a fresh browser profile so cached history does not hide
the fixture. The thread contains 120 alternating user/assistant messages. Load earlier
turns if needed, select across messages while holding the primary mouse button, and
scroll beyond the list buffer in both directions. Check that the highlight and copied
text remain continuous. Repeat immediately after scrolling, before the list's idle DOM
sort can run. Clear the selection and check that off-screen rows recycle again.

## Controlled streaming selection fixture

Uses the existing ACP mock, with one multiline assistant message split into two
chunks sharing the original message ID. No provider credentials are needed.
The proxy holds both ACP v2's terminal idle update and the matching prompt response.
Gate changes use filesystem events, so remote shell commands can release content
without moving focus away from a selection in the client.

Run only against a parent-approved isolated development server. These scripts do
not start servers, rebuild databases, or touch the installed T3 home. The RPC driver
creates one new empty thread in an existing isolated project and refuses dispatch
into a thread that already has messages or runs.

From the worktree root, check the real mock protocol without a server:

```sh
node scripts/fixtures/issue-12943/self-check.mjs
```

Use a fresh directory per capture. Set `FIXTURE_ORIGIN` privately to the parent's
existing isolated server origin, and `FIXTURE_PROJECT` to its isolated project ID.
Enter an access token (or that server's reusable dev token) without echoing it or
putting it in shell history. Do not enable shell tracing. Never save credentials,
WebSocket tickets, pairing links, or actual server origins in this directory.

```sh
read -rsp 'Private fixture access token: ' T3_FIXTURE_ACCESS_TOKEN
export T3_FIXTURE_ACCESS_TOKEN
FIXTURE_GATES=$(mktemp -d /tmp/t3-selection-gates.XXXXXX)
node apps/server/scripts/issue-12943-fixture.ts --isolated-server --origin "$FIXTURE_ORIGIN" --gate-dir "$FIXTURE_GATES" --action configure
node apps/server/scripts/issue-12943-fixture.ts --isolated-server --origin "$FIXTURE_ORIGIN" --gate-dir "$FIXTURE_GATES" --action seed --project "$FIXTURE_PROJECT"
```

Keep the printed fixture thread ID as `FIXTURE_THREAD`, navigate to that thread,
and start recording. Dispatch from the remote shell:

```sh
node apps/server/scripts/issue-12943-fixture.ts --isolated-server --origin "$FIXTURE_ORIGIN" --gate-dir "$FIXTURE_GATES" --action dispatch --thread "$FIXTURE_THREAD"
node scripts/fixtures/issue-12943/gate.mjs "$FIXTURE_GATES" ready
node scripts/fixtures/issue-12943/gate.mjs "$FIXTURE_GATES" append
```

After selecting text in the first half, run each remaining command from the remote
shell when the capture is ready for that transition:

```sh
node scripts/fixtures/issue-12943/gate.mjs "$FIXTURE_GATES" grow
node scripts/fixtures/issue-12943/gate.mjs "$FIXTURE_GATES" complete
unset T3_FIXTURE_ACCESS_TOKEN
```

Each gate command waits for its readiness or release marker without polling.
`configure` creates `selectionFixture`; it intentionally fails if that instance
already exists. For another capture, remove the fixture provider through Settings
before configuring a fresh directory and seed another empty fixture thread.
Paths are local to the server machine: run the driver with that machine's actual
Node executable so `process.execPath` remains valid for both provider and mock.

The proxy scans each byte once for newlines, assembles each line once, then parses
JSON once: O(n) work and O(maximum line size) storage, capped at 64 KiB per line.
Input pauses on mock stdin backpressure. One assistant chunk and one matching
response are retained; a second prompt or assistant chunk is rejected. Malformed
JSON and oversized/unterminated lines terminate with a short payload-free diagnostic.
The self-check includes a 3,000-word malformed input and checks bounded diagnostics.
