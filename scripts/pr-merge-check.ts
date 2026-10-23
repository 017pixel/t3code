// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Checks that pull requests still pass together on current main, right before
// they merge. Main takes hundreds of merges a day, so the ruleset cannot require
// branches to be up to date, and GitHub reports CLEAN for a PR that is far
// behind. A PR's green CI can be days old. Most breaks on main were two changes
// that each passed alone: a renamed type, a removed dependency, a new request
// an older test did not stub.
//
//   vp run pr-merge-check <pr> [<pr>...]
//
// Merges origin/main and each PR head, in order, in a temporary worktree next
// to this checkout, then runs check:changed against origin/main. Pass every PR
// of a batch in one run. Exit 0 means merge them now, in the same order: each
// new commit on main makes the result older.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const prs = process.argv.slice(2);
if (prs.length === 0 || prs.some((pr) => !/^\d+$/.test(pr))) {
  console.error("usage: vp run pr-merge-check <pr> [<pr>...]");
  process.exit(1);
}

// `vp run` puts this checkout's node_modules/.bin first on PATH. Left there,
// the merged worktree would run this checkout's Vitest against its own test
// files, and two Vitest copies fail every suite.
const env = {
  ...process.env,
  PATH: (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .filter((entry) => !entry.startsWith(`${root}${NodePath.sep}`))
    .join(NodePath.delimiter),
};

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  NodeChildProcess.spawnSync(command, args, { cwd, env, stdio: "inherit" }).status === 0;

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

git(root, "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main");
const heads = prs.map((pr) => {
  git(root, "fetch", "--quiet", "origin", `pull/${pr}/head`);
  return { pr, sha: git(root, "rev-parse", "FETCH_HEAD") };
});

const dir = NodePath.resolve(root, "..", `${NodePath.basename(root)}-merge-check-${process.pid}`);
git(root, "worktree", "add", "--quiet", "--detach", dir, "origin/main");
// Ctrl-C reaches the running child too. Staying alive lets `finally` remove the worktree.
process.on("SIGINT", () => {});

let ok = false;
try {
  const conflict = heads.find(
    ({ pr, sha }) =>
      !run("git", ["merge", "--quiet", "--no-ff", "-m", `merge-check #${pr}`, sha], dir),
  );
  if (conflict) {
    console.error(`\npr-merge-check: #${conflict.pr} does not merge cleanly onto main.`);
  } else {
    // A lockfile that two PRs edited can merge as text and still not match
    // the manifests. The frozen install fails on that.
    ok =
      run("vp", ["i", "--frozen-lockfile", "--", "--yes"], dir) &&
      run("node", ["scripts/check-changed.ts", "origin/main"], dir);
  }
} finally {
  git(root, "worktree", "remove", "--force", dir);
  NodeFS.rmSync(dir, { recursive: true, force: true });
}

const list = prs.map((pr) => `#${pr}`).join(" ");
console.log(
  ok
    ? `\npr-merge-check: ${list} pass on main. Merge them now, in this order.`
    : `\npr-merge-check: ${list} fail on main. Do not merge.`,
);
if (!ok) process.exit(1);
