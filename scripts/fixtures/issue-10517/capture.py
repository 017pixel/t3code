#!/usr/bin/env python3
"""Capture real Linux Electron startup. Run inside an isolated X/DBus session.
See README.md for prerequisites and fixture provenance. No production hooks.
"""

import fcntl
import textwrap
import argparse, hashlib, json, os, pathlib, signal, sqlite3, subprocess, time

p = argparse.ArgumentParser()
p.add_argument("--worktree", required=True)
p.add_argument("--output", required=True)
p.add_argument("--seed", required=True)
p.add_argument(
    "--variant",
    choices=[
        "missing-column",
        "invalid",
        "unavailable",
        "unavailable-parent",
        "healthy",
        "missing-entry",
    ],
    required=True,
)
p.add_argument("--revision", choices=["base", "head"], required=True)
p.add_argument(
    "--action", choices=["copy", "click", "escape", "close", "none"], default="copy"
)
p.add_argument("--seconds", type=int, default=33)
p.add_argument("--xclip", default="xclip")
a = p.parse_args()
w = pathlib.Path(a.worktree).resolve()
out = pathlib.Path(a.output).resolve()
if (out.parent / ".stop-captures").exists():
    raise SystemExit("capture stop marker present")
out.mkdir(parents=True, exist_ok=False)
home = out / "home"
(home / "userdata").mkdir(parents=True)
if a.variant in ["invalid", "unavailable", "unavailable-parent"]:
    (home / "userdata/statev2.sqlite").write_bytes(b"not a SQLite database\n")
else:
    src = sqlite3.connect(
        "file:" + str(pathlib.Path(a.seed).resolve()) + "?mode=ro", uri=True
    )
    dst = sqlite3.connect(home / "userdata/statev2.sqlite")
    src.backup(dst)
    src.close()
    if a.variant == "missing-column":
        cols = [r[1] for r in dst.execute("pragma table_info(projection_threads)")]
        if "branch_pull_request_json" in cols:
            dst.execute(
                "alter table projection_threads drop column branch_pull_request_json"
            )
        assert "branch_pull_request_json" not in [
            r[1] for r in dst.execute("pragma table_info(projection_threads)")
        ]
    dst.commit()
    dst.close()
if a.variant == "unavailable-parent":
    (home / "userdata/logs").write_text(
        "capture fixture blocks log directory creation\n"
    )
if a.variant == "unavailable":
    (home / "userdata/logs/server-child.log").mkdir(parents=True)
lock = open(w / ".t3/evidence-capture.lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX)
main = w / "apps/desktop/dist-electron/main.cjs"
original = main.read_bytes()
base = w / ".t3/evidence-base/main.cjs"
electron = w / "apps/desktop/node_modules/electron/dist/electron"
entry = w / "apps/server/dist/bin.mjs"
moved = False
helper = out / "clipboard.cjs"
helper.write_text(
    "const {app}=require('electron');const fs=require('fs');app.whenReady().then(()=>{fs.writeFileSync(process.env.CLIP_VERSION,JSON.stringify(process.versions));app.quit();});"
)
env = os.environ.copy()
env.pop("ELECTRON_RUN_AS_NODE", None)
env["T3CODE_HOME"] = str(home)
env["CLIP_VERSION"] = str(out / "versions.json")
env["XDG_DATA_HOME"] = str(w / ".t3/keyring-data")
for key in ["VITE_HTTP_URL", "VITE_WS_URL", "ELECTRON_RENDERER_URL"]:
    env.pop(key, None)
procs = []
start = time.monotonic()
events = []
caption_columns = max(
    24,
    int(
        subprocess.check_output(["xdotool", "getdisplaygeometry"], text=True).split()[0]
    )
    // 9,
)


def event(s):
    events.append({"seconds": round(time.monotonic() - start, 3), "event": s})
    (out / "timeline.json").write_text(json.dumps(events, indent=2))
    (out / "caption.txt").write_text(
        textwrap.fill(
            f'{a.revision} {a.variant} | {events[-1]["seconds"]}s {s}',
            width=caption_columns,
        )
    )


def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=6)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def windows():
    r = subprocess.run(
        ["xdotool", "search", "--name", "T3 Code's backend"],
        capture_output=True,
        text=True,
    )
    return r.stdout.split()


try:
    main.write_bytes(
        base.read_bytes()
        if a.revision == "base"
        else (w / ".t3/evidence-head/main.cjs").read_bytes()
    )
    if a.variant == "missing-entry":
        entry.rename(entry.with_suffix(".mjs.evidence-save"))
        moved = True
    manifest = {
        "revision": a.revision,
        "headSource": "ef5a77d2f16e5612a97e1e388afbcafe4f7c1422",
        "baseSource": "52c2b38ea4",
        "variant": a.variant,
        "display": os.environ.get("DISPLAY"),
        "gtkTheme": os.environ.get("GTK_THEME"),
        "mainSha256": hashlib.sha256(main.read_bytes()).hexdigest(),
        "artifacts": {
            str(f.relative_to(w)): hashlib.sha256(f.read_bytes()).hexdigest()
            for f in (w / "apps/desktop/dist-electron").glob("*.cjs")
        },
        "command": [
            str(electron),
            str(w / "apps/desktop/dist-electron/boot.cjs"),
            "--no-sandbox",
            "--disable-gpu",
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    event("recording starts; whole X display; captions are capture instrumentation")
    geo = (
        subprocess.check_output(["xdotool", "getdisplaygeometry"], text=True)
        .strip()
        .split()
    )
    size = "x".join(geo)
    manifest["screen"] = size
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    log = open(out / "app.log", "w")
    hl = open(out / "helper.log", "w")
    ff = open(out / "ffmpeg.log", "w")
    clip = subprocess.Popen(
        [str(electron), str(helper), "--no-sandbox", "--disable-gpu"],
        env=env,
        stdout=hl,
        stderr=hl,
    )
    procs.append(clip)
    owner = subprocess.Popen(
        [a.xclip, "-selection", "clipboard", "-in", "-quiet"],
        stdin=subprocess.PIPE,
        stdout=hl,
        stderr=hl,
    )
    owner.stdin.write(b"ISSUE10517-SENTINEL")
    owner.stdin.close()
    procs.append(owner)
    rec = subprocess.Popen(
        [
            "ffmpeg",
            "-y",
            "-f",
            "x11grab",
            "-framerate",
            "10",
            "-video_size",
            size,
            "-i",
            os.environ["DISPLAY"],
            "-vf",
            f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile={out}/caption.txt:reload=1:fontcolor=white:fontsize=16:box=1:boxcolor=black:x=8:y=h-text_h-10",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "24",
            "-pix_fmt",
            "yuv420p",
            str(out / "recording.mp4"),
        ],
        stdout=ff,
        stderr=ff,
    )
    app = subprocess.Popen(manifest["command"], env=env, stdout=log, stderr=log)
    procs.append(app)
    (out / "pids.json").write_text(
        json.dumps(
            {
                "app": app.pid,
                "versionHelper": clip.pid,
                "clipboardOwner": owner.pid,
                "recorder": rec.pid,
            }
        )
    )
    event("native application launched")
    deadline = time.monotonic() + a.seconds
    seen_retries = 0
    seen_windows = []
    while time.monotonic() < deadline:
        content = (out / "app.log").read_text(errors="replace")
        count = content.count("restart scheduled")
        ids_now = windows()
        if count != seen_retries:
            event("restart schedule count=" + str(count))
            seen_retries = count
        if ids_now != seen_windows:
            event("native dialog window change=" + str(ids_now))
            seen_windows = ids_now
        time.sleep(0.2)
    ids = windows()
    event("dialog windows=" + str(ids))
    (out / "windows.txt").write_text(
        subprocess.run(
            ["xdotool", "search", "--name", "."], capture_output=True, text=True
        ).stdout
    )
    if ids:
        (out / "geometry.txt").write_text(
            subprocess.check_output(
                ["xdotool", "getwindowgeometry", "--shell", ids[-1]], text=True
            )
        )
    subprocess.run(
        ["import", "-window", "root", str(out / "before-action.png")], check=True
    )
    if ids and a.action != "none":
        wid = ids[-1]
        subprocess.run(["xdotool", "windowfocus", wid])
        event("action " + a.action)
        if a.action == "click":
            geometry = dict(
                line.split("=", 1)
                for line in subprocess.check_output(
                    ["xdotool", "getwindowgeometry", "--shell", wid], text=True
                ).splitlines()
            )
            subprocess.run(
                [
                    "xdotool",
                    "mousemove",
                    "--window",
                    wid,
                    str(int(geometry["WIDTH"]) // 4),
                    str(int(geometry["HEIGHT"]) - 18),
                    "click",
                    "1",
                ]
            )
        elif a.action == "close":
            subprocess.run(["xdotool", "key", "Tab", "Return"])
        else:
            subprocess.run(
                ["xdotool", "key", "Return" if a.action == "copy" else "Escape"]
            )
        time.sleep(2)
        text = subprocess.check_output(
            [a.xclip, "-selection", "clipboard", "-out"], text=True, timeout=4
        )
        (out / "clipboard.txt").write_text(text)
        event("same-X-session clipboard readback: " + text.replace("\n", " | "))
        time.sleep(3)
        event("post-action windows=" + str(windows()))
        time.sleep(8)
    else:
        event("no dialog action target; matched observation")
        time.sleep(5)
    subprocess.run(
        ["import", "-window", "root", str(out / "after-action.png")], check=True
    )
    event(
        "final restart schedules="
        + str((out / "app.log").read_text(errors="replace").count("restart scheduled"))
        + "; dialog windows="
        + str(windows())
    )
    time.sleep(2)
    event("capture completed")
    rec.send_signal(signal.SIGINT)
    rec.wait(timeout=15)
finally:
    for proc in reversed(procs):
        stop(proc)
    if "rec" in locals() and rec.poll() is None:
        stop(rec)
    main.write_bytes(original)
    if moved:
        entry.with_suffix(".mjs.evidence-save").rename(entry)

    (out / "cleanup.json").write_text(
        json.dumps(
            {
                str(proc.pid): proc.poll()
                for proc in procs + ([rec] if "rec" in locals() else [])
            }
        )
    )
