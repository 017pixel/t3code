import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

// Creates repository data only. Register its saved refs through the app's fixture
// mechanism with the server stopped; this script never opens a T3 database.
const { values } = NodeUtil.parseArgs({
  options: {
    directory: { type: "string" },
    supplementary: { type: "boolean", default: false },
    oversized: { type: "boolean", default: false },
  },
});
if (!values.directory)
  throw new Error("Pass --directory pointing to a new, empty fixture directory");
const directory = NodePath.resolve(values.directory);
NodeFS.mkdirSync(directory, { recursive: true });
if (NodeFS.readdirSync(directory).length)
  throw new Error(`Refusing nonempty directory: ${directory}`);
const git = (...args) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Diff fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Diff fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      },
    },
  ).trim();
const write = (name, contents) => NodeFS.writeFileSync(NodePath.resolve(directory, name), contents);
const base = NodeFS.readFileSync(new URL("./docstring.py", import.meta.url), "utf8");
const first = base.replace("    Documentation line 10:", "    Changed documentation line 10:");
const second = first.replace("    Documentation line 11:", "    Updated documentation line 11:");
const refs = [];
const checkpoint = (ordinal) => {
  git("add", "--all");
  git("commit", "--quiet", "-m", `Fixture checkpoint ${ordinal}`);
  const sha = git("rev-parse", "HEAD");
  const ref = `refs/t3-fixture/ordinal/${ordinal}`;
  git("update-ref", ref, sha);
  refs.push({ ordinal, ref, sha });
};
git("init", "--quiet", "--initial-branch=main");
write("docstring.py", base);
if (values.supplementary) {
  write("old name.py", base.repeat(4));
  write("pure old.py", base);
  write("deleted.py", '"""Removed file documentation."""\ndef removed():\n    return 0\n');
  write("ordinary.py", "# Ordinary code\ndef enabled(value):\n    return value and True\n");
  write("notes.txt", "plain text before\n");
  for (let index = 0; index < 32; index++)
    write(`context-${String(index).padStart(2, "0")}.py`, base);
  write(
    "multiple.py",
    `def multiple():\n    """Multiline context.\n${Array.from({ length: 100 }, (_, i) => `    Documentation ${i}: and in is not If True bool.\n`).join("")}    """\n    return True\n`,
  );
}
if (values.oversized)
  write("oversized.py", `"""\n${"Documentation and in is not If True bool.\n".repeat(27000)}"""\n`);
checkpoint(0);
write("docstring.py", first);
if (values.supplementary) {
  NodeFS.renameSync(
    NodePath.resolve(directory, "old name.py"),
    NodePath.resolve(directory, "new name.py"),
  );
  write(
    "new name.py",
    base.repeat(4).replace("Documentation line 10", "Renamed documentation line 10"),
  );
  NodeFS.renameSync(
    NodePath.resolve(directory, "pure old.py"),
    NodePath.resolve(directory, "pure new.py"),
  );
  NodeFS.rmSync(NodePath.resolve(directory, "deleted.py"));
  write("added.py", '"""New file documentation."""\ndef created():\n    return 42\n');
  write("ordinary.py", "# Ordinary code\ndef enabled(value):\n    return value and False\n");
  write("notes.txt", "plain text after\n");
  for (let index = 0; index < 32; index++)
    write(`context-${String(index).padStart(2, "0")}.py`, first);
  const multiple = NodeFS.readFileSync(NodePath.resolve(directory, "multiple.py"), "utf8");
  write(
    "multiple.py",
    multiple
      .replace("Documentation 10:", "Changed 10:")
      .replace("Documentation 80:", "Changed 80:"),
  );
}
if (values.oversized) {
  const contents = NodeFS.readFileSync(NodePath.resolve(directory, "oversized.py"), "utf8");
  const offset = contents.indexOf("Documentation", Math.floor(contents.length / 2));
  write(
    "oversized.py",
    `${contents.slice(0, offset)}Changed${contents.slice(offset + "Documentation".length)}`,
  );
}
checkpoint(1);
write("docstring.py", second);
checkpoint(2);
// Leave HEAD at the original revision and the final files dirty, like a thread
// with completed checkpoints whose edits have not been committed by its user.
git("reset", "--mixed", "--quiet", refs[0].sha);
process.stdout.write(
  `${JSON.stringify({ directory, supplementary: values.supplementary, oversized: values.oversized, refs }, null, 2)}\n`,
);
