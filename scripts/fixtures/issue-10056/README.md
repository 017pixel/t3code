# Synthetic composer recall fixture

Use a fresh isolated server home under `/tmp/issue-10056-evidence/` on each revision.
Never use a live home or a copied personal database. Start the server through the
normal development runner and pair a browser. Evaluate `setup.js` in that browser,
then call `setupIssue10056({home, providerPath, suffix})`, where `providerPath` is
the absolute path to this directory's executable `provider.sh`. Navigate to the
returned path. Use a unique suffix for each capture envelope.

The setup creates only a synthetic project/thread through authenticated supported
commands and configures a deterministic Codex protocol peer. It does not send
messages or import composer helpers. Type the strings from `strings.json` in the
real composer in S,U,R,W,P,B,B order. Wait for each turn's persisted completion,
reload, and exercise ArrowUp/ArrowDown at editor boundaries. Inspect escaped text
and persisted context separately to establish whitespace preservation.

The provider simulates completion with no generated output. This establishes client
send/persistence/recall, not real model execution or provider rewind. It reuses the
repository's existing Codex protocol fixture. No screenshots, databases, secrets,
or capture output belong in this directory. The setup guard requires the caller
to identify its isolated home; it cannot attest which home a running server uses.

For the attachment supplement, upload `synthetic.png` through the real composer.
With an empty draft and pending attachment, ArrowUp must not replace the draft.
Remove the attachment to resume recall. Reattach and send with an empty draft;
inspect the persisted empty authoredPrompt separately from the visible recall.
