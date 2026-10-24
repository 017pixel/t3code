#!/usr/bin/env python3
"""Create an isolated Bash/mod reproduction; configure provider credentials separately."""

import argparse
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path, help="new disposable directory")
args = parser.parse_args()
root = args.directory.resolve()
root.mkdir(parents=True, exist_ok=False)
project = root / "project"
(project / "build").mkdir(parents=True)
(project / "build" / "sample.txt").write_text("fixture\n")
subprocess.run(["git", "init", str(project)], check=True)
config = root / "claude"
config.mkdir(mode=0o700)
source = root / "playground"
subprocess.run(["git", "clone", "--no-checkout", "https://github.com/anthropics/claude-code-playground.git", str(source)], check=True)
subprocess.run(["git", "-C", str(source), "checkout", "569c5283d9a0a7ee7938df85bb32e4f48cbb8c86"], check=True)
environment = {**os.environ, "CLAUDE_CONFIG_DIR": str(config)}
subprocess.run(["claude", "plugin", "marketplace", "add", str(source / "claude-code" / "mods")], env=environment, check=True)
subprocess.run(["claude", "plugin", "install", "blast-radius@claude-code-playground-mods", "--scope", "user"], env=environment, check=True)
print(f"Project: {project}\nCLAUDE_CONFIG_DIR: {config}")
print("In T3, select this Claude config and ask: Use Bash to run exactly rm -r build. Do not add -f.")
