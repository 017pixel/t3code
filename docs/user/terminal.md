# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

## fish

T3 Code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3 Code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3 Code. A shell export applies
when you launch T3 Code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.

## Saved scripts through agents

Ask an agent to list or run your saved project scripts. `t3_project_script_list`
returns bounded command previews and preview URLs. `t3_project_script_run` takes a
saved `scriptId` and a fresh `terminalId`, using the target thread’s workspace.
It reports whether terminal input was accepted, not whether the script succeeded.
If input fails, inspect the terminal before retrying: some input may have arrived.
Preview URLs are returned for discovery and never opened automatically.

`t3_project_script_stop` stops that exact run, including after its saved definition
is deleted or renamed. Closing, restarting, or exiting the terminal ends ownership.
Run and stop require a live full-access/default caller and a full-access/default
target thread. An external full-access MCP client can pass an explicit `threadId`.
