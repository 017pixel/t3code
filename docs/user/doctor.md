# T3 Doctor

Run `t3 doctor` in a terminal to inspect your installation and choose repairs.
Recommended repairs are selected by default. Use Space to toggle a repair and
Enter to run the selection, or Ctrl+C to cancel. Selecting nothing makes no changes.

| Command               | What it does                                             |
| --------------------- | -------------------------------------------------------- |
| `t3 doctor`           | Inspect and choose repairs                               |
| `t3 doctor --dry-run` | Preview repairs without applying them, even with `--fix` |
| `t3 doctor --fix`     | Apply recommended repairs without prompting              |

Without an interactive terminal, inspection lists repairs without applying them.
Use `--fix` for scripts. During repairs, a stage bar shows the current operation
and elapsed time. Stages have different durations; the bar does not estimate time
remaining.

For another environment, add `--base-dir /path/to/t3-home`. Run the command on
the machine that hosts that environment.

## Repairs

### Reclaim database space

T3 Code cleans up old internal history automatically while preserving your
conversations. Older databases reuse the freed space but need a one-time repair
to return it to disk. New and repaired databases shrink automatically.

This repair compacts the database and enables automatic shrinking. It pauses
the matching running background service and restarts it afterward, including
if the repair fails. An already-stopped service stays stopped.

If you run T3 Code in the desktop app or a terminal instead of as a background
service, close that instance first. This repair does not stop unrelated processes.

This repair may take several minutes and need temporary disk space. Settings
recommends it when an older database has at least 1 GiB to reclaim. The result
includes the database size before and after the repair.
