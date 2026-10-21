// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a small `gh` wrapper that prints for agents; plain Node keeps it short.
/**
 * Prints the failed CI jobs of a pull request, each tagged [new] or [also on main], with a short
 * summary: failing tests, lint errors (not warnings), and TS errors as file:line.
 *
 *   vp run ci:failed                  the current branch's pull request
 *   vp run ci:failed 123              pull request #123
 *   vp run ci:failed --run <id>       a specific CI run
 *   vp run ci:failed --main-run <id>  compare against a specific main run, not the latest one
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const WORKFLOW = "ci.yml";
const MAX_ITEMS = 12;

const gh = (command: string) =>
  NodeChildProcess.execFileSync("gh", command.split(" ").filter(Boolean), {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
const ghJson = <T>(command: string): T => JSON.parse(gh(command)) as T;

interface Run {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly headSha: string;
}
interface Job {
  readonly databaseId: number;
  readonly name: string;
  readonly conclusion: string;
  readonly url: string;
}

const RUN_FIELDS = "databaseId,status,conclusion,headSha";
const isFailed = (job: Job) => job.conclusion === "failure" || job.conclusion === "timed_out";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const clean = (line: string) =>
  line
    .replace(ANSI, "")
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
    .trimEnd();

/** The lines an agent needs from a job log. Falls back to the end of the failed step. */
export function summarize(log: string): Array<string> {
  const lines = log.split("\n").map(clean);
  const items = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const test = /^\s*FAIL\s+(.*)$/.exec(line)?.[1];
    if (test !== undefined) {
      // Drop the project label ("browser (chromium)", "|server|") before the test file.
      const at = test.search(/\S+\.(test|spec)\.[cm]?[jt]sx?\b/);
      items.add(
        (at === -1 ? test : test.slice(at))
          .replace(/\s+\[ .* \]$/, "")
          .replace(/\s+\d+(\.\d+)?m?s$/, "")
          .replaceAll(/\s+/g, " "),
      );
      continue;
    }
    // tsc prints "file(line,col): error" plain and "file:line:col - error" when pretty.
    const ts = /(\S+\.[cm]?tsx?)(?:\((\d+),\d+\):|:(\d+):\d+ -) error (TS\d+): (.*)$/.exec(line);
    if (ts !== null) {
      items.add(`${ts[1]}:${ts[2] ?? ts[3]} ${ts[4]} ${ts[5]!.slice(0, 100)}`);
      continue;
    }
    // oxlint: "× rule(name): message", then "╭─[file:line:col]" a line or two later. "⚠" is a warning.
    const lint = /^\s*× (\S+?\(\S+?\))/.exec(line);
    if (lint !== null) {
      const where = lines
        .slice(index + 1, index + 6)
        .map((next) => /╭─\[(.+?):(\d+):\d+\]/.exec(next))
        .find((match) => match !== null);
      items.add(where ? `${where[1]}:${where[2]} ${lint[1]}` : `lint ${lint[1]}`);
    }
  }
  if (items.size > 0) return [...items];
  // Nothing recognized (knip, a crash, an aggregate job): the step's last useful lines.
  const found = lines.findIndex((line) => line.startsWith("##[error]Process completed"));
  const end = found === -1 ? lines.length : found;
  const start = lines.findLastIndex((line, index) => index < end && line === "##[endgroup]");
  return lines
    .slice(start + 1, end)
    .filter(
      (line) =>
        !/^\s*(---)?$/.test(line) &&
        !/^(##\[|\$ |vp run: )/.test(line) &&
        // JSON dumps and the passing jobs an aggregate job lists.
        !/^\s*["{}[\]]/.test(line) &&
        !/: (success|skipped)$/.test(line),
    )
    .slice(-6)
    .map((line) => line.trim().slice(0, 160));
}

// The pull request may move the same error to another line.
const withoutLine = (item: string) => item.replace(/:\d+\b/g, "");

const jobsOf = (runId: number) =>
  ghJson<{ jobs: Array<Job> }>(`run view ${runId} --json jobs`).jobs;
const jobLog = (job: Job) =>
  gh(`api --allow-escape-sequences repos/{owner}/{repo}/actions/jobs/${job.databaseId}/logs`);

function main() {
  const { values, positionals } = NodeUtil.parseArgs({
    // `vp run ci:failed -- --run 1` passes the `--` through.
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    allowPositionals: true,
    options: { run: { type: "string" }, "main-run": { type: "string" } },
  });
  let run: Run;
  if (values.run !== undefined) {
    run = ghJson<Run>(`run view ${values.run} --json ${RUN_FIELDS}`);
  } else {
    const pr = ghJson<{ number: number; headRefOid: string }>(
      `pr view ${positionals[0] ?? ""} --json number,headRefOid`,
    );
    const runs = ghJson<Array<Run>>(
      `run list --workflow ${WORKFLOW} --commit ${pr.headRefOid} --limit 1 --json ${RUN_FIELDS}`,
    );
    if (runs[0] === undefined) {
      console.log(`No ${WORKFLOW} run for #${pr.number} at ${pr.headRefOid.slice(0, 7)} yet.`);
      return;
    }
    run = runs[0];
  }
  // A cancelled main run was superseded, so it says nothing about main.
  const mainRun =
    values["main-run"] === undefined
      ? ghJson<Array<Run>>(
          `run list --branch main --workflow ${WORKFLOW} --event push --status completed --limit 10 --json ${RUN_FIELDS}`,
        ).find((candidate) => candidate.conclusion !== "cancelled")
      : ghJson<Run>(`run view ${values["main-run"]} --json ${RUN_FIELDS}`);

  const failed = jobsOf(run.databaseId).filter(isFailed);
  const mainFailed = new Map(
    (mainRun === undefined ? [] : jobsOf(mainRun.databaseId).filter(isFailed)).map((job) => [
      job.name,
      job,
    ]),
  );
  console.log(
    `Run ${run.databaseId} (${run.headSha.slice(0, 7)}, ${run.status === "completed" ? run.conclusion : run.status})` +
      (mainRun === undefined
        ? ", no completed main run to compare."
        : ` vs main run ${mainRun.databaseId} (${mainRun.headSha.slice(0, 7)}, ${mainRun.conclusion}).`),
  );
  if (failed.length === 0) return console.log("No failed jobs.");

  let fresh = 0;
  for (const job of failed) {
    const items = summarize(jobLog(job));
    const onMain = mainFailed.get(job.name);
    // A job failing on main may still fail here for a new reason: compare what each one reports.
    const mainItems = new Set(
      onMain === undefined ? [] : summarize(jobLog(onMain)).map(withoutLine),
    );
    const newItems = items.filter((item) => !mainItems.has(withoutLine(item)));
    const isNew = onMain === undefined || newItems.length > 0;
    if (isNew) fresh += 1;
    const shown = isNew ? newItems : items;
    const note =
      onMain !== undefined && isNew
        ? ` (job also fails on main; ${newItems.length} of ${items.length} items are new)`
        : "";
    console.log(`\n[${isNew ? "new" : "also on main"}] ${job.name}${note} ${job.url}`);
    for (const item of shown.slice(0, MAX_ITEMS)) console.log(`  ${item}`);
    if (shown.length > MAX_ITEMS) console.log(`  ... and ${shown.length - MAX_ITEMS} more`);
  }
  console.log(`\n${failed.length} failed: ${fresh} new, ${failed.length - fresh} also on main.`);
}

if (import.meta.main) main();
