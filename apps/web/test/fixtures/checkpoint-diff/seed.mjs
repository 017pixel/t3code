#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const [command, directory, turn] = process.argv.slice(2);
if (!directory || !NodePath.isAbsolute(directory))
  throw new Error("Supply an absolute isolated fixture root");
const root = NodePath.resolve(directory);
const marker = NodePath.join(root, ".checkpoint-diff-fixture");
const manifest = JSON.parse(NodeFS.readFileSync(new URL("./scenarios.json", import.meta.url)));
if (command === "init") {
  NodeFS.mkdirSync(root, { recursive: true });
  if (NodeFS.readdirSync(root).length)
    throw new Error("Initialization requires an empty directory");
  NodeFS.writeFileSync(marker, "checkpoint-diff-fixture-v1\n");
  NodeFS.mkdirSync(NodePath.join(root, "gates"));
  const cwd = NodePath.join(root, "project");
  NodeFS.mkdirSync(cwd);
  for (const [name, text] of Object.entries(manifest.files))
    NodeFS.writeFileSync(NodePath.join(cwd, name), text);
  const git = (args) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: manifest.clock,
        GIT_COMMITTER_DATE: manifest.clock,
      },
    });
  git(["init", "-b", "main"]);
  git(["add", "notes.md", "other.md"]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "Synthetic checkpoint diff seed"]);
  console.log(cwd);
} else if (command === "release") {
  if (!NodeFS.existsSync(marker) || !Object.hasOwn(manifest.turns, turn ?? ""))
    throw new Error("Unknown fixture or turn");
  if (!NodeFS.existsSync(NodePath.join(root, "gates", `${turn}.ready`)))
    throw new Error("Turn has not emitted its edit");
  NodeFS.writeFileSync(NodePath.join(root, "gates", `${turn}.release`), `${turn}\n`);
} else {
  throw new Error("Usage: seed.mjs init <root> | release <root> <turn>");
}
