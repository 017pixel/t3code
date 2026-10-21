const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { test } = require("node:test");

const script = join(__dirname, "vercel-deployment-url.sh");
const url = "https://t3code-6zgs2h4tl-pinglabs.vercel.app";
const warning =
  'Error while parsing config file: "/home/runner/_work/t3code/t3code/pnpm-lock.yaml"';

const parse = (stdout) => spawnSync("bash", [script], { input: stdout, encoding: "utf8" });

for (const [label, stdout] of [
  ["a bare URL", url],
  ["a lockfile warning", `${warning}\n${url}\n`],
  ["a trailing diagnostic", `${url}\nDone`],
]) {
  test(`prints the deployment URL after ${label}`, () => {
    const result = parse(stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${url}\n`);
  });
}

for (const [label, stdout] of [
  ["no URL", warning],
  ["a non-Vercel URL", "https://example.invalid/deployment"],
  ["multiple URLs", `${url}\nhttps://other.vercel.app`],
]) {
  test(`fails on ${label}`, () => {
    const result = parse(stdout);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  });
}
