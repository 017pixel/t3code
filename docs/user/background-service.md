# Running T3 Code in the background

On Linux and macOS, T3 Code can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the `t3` CLI first ([Install T3 Code](./install.md#command-line)), then
run these commands on the machine that will host T3 Code:

| Task                            | Command                |
| ------------------------------- | ---------------------- |
| Install and start               | `t3 service install`   |
| Inspect status and log location | `t3 service status`    |
| Move to a newer release         | `t3 update`            |
| Restart                         | `t3 service restart`   |
| Stop and remove from startup    | `t3 service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.
Running `t3 service install` again repairs a service that `t3 service status`
reports as broken.

`t3 update` downloads the newest release on your channel and switches `t3`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `t3 service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating T3 Code](./updating.md).

Pass an exact version (`t3 update 0.0.42`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `t3 update` ask for confirmation before
installing one.

`t3 uninstall` removes the background service, the `t3` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.t3/userdata` are kept. Pass `--yes` from a
script.

## Platform support

Linux needs systemd user services. Setup enables lingering so T3 Code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

T3 Connect can offer service installation during setup, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Troubleshooting

Start with `t3 service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running T3 Code as root creates a separate installation and Connect
identity. Without administrator access, run `t3 serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status t3code.service`, then use the repair command printed by T3 Code.                     |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `t3 service restart`.                            |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `t3` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For failures after signing in to T3 Connect, see
[connection troubleshooting](./remote-access.md#t3-connect-troubleshooting).

## Reclaim database space

T3 Code periodically removes superseded event history while keeping conversation
history and current state. SQLite reuses that freed space for future writes, but
older databases keep their allocated file size until converted. New databases
return unused space to disk automatically in small background batches.

Run `t3 doctor` to inspect the database and see recommended repairs without
changing anything. `t3 doctor --dry-run` also previews repairs without applying them,
even when combined with `--fix`.

To apply the database repair and return freed space to the operating system, quit the desktop app and stop any
server using the same data directory. If you installed the background service,
run `t3 service stop`. Then run:

```sh
t3 doctor --fix
```

For a separate environment, pass `--base-dir /path/to/t3-home`. The command refuses
to run while the database is in use and reports its size before and after
compaction. This one-time maintenance also enables automatic shrinking for an
older database. Settings > Storage recommends it when at least 1 GB can be
reclaimed. Run the displayed command on the machine named in the notice.

It can take time and require additional free disk space. Restart the
server or background service when it finishes.
