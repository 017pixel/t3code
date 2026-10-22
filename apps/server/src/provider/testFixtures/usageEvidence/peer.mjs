#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import readline from "node:readline";
const data = JSON.parse(fs.readFileSync(new URL("./data.json", import.meta.url)));
const control = () =>
  JSON.parse(
    fs.readFileSync(
      process.env.T3_USAGE_EVIDENCE_CONTROL || "/tmp/issue-11873-evidence/control.json",
    ),
  );
const limits = (used) => ({
  limitId: "codex",
  planType: "plus",
  primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1792684800 },
  secondary: { usedPercent: 38, windowDurationMins: 10080, resetsAt: 1793275200 },
  credits: null,
});
if (process.argv.includes("--source")) {
  http
    .createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/auth-files")) return res.end(JSON.stringify({ files: data.accounts }));
      const q = JSON.parse(body || "{}");
      const result = q.url?.endsWith("/rate-limit-reset-credits")
        ? { credits: [] }
        : {
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: q.auth_index === "a" ? 12 : 38,
                reset_at: 1792684800,
                limit_window_seconds: 18000,
              },
              secondary_window: {
                used_percent: 38,
                reset_at: 1793275200,
                limit_window_seconds: 604800,
              },
            },
          };
      res.end(JSON.stringify({ status_code: 200, body: JSON.stringify(result) }));
    })
    .listen(18317, "127.0.0.1");
} else if (process.argv.includes("--version")) console.log("codex-cli 0.163.0");
else {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const q = JSON.parse(line);
    if (q.id === undefined) return;
    const c = control();
    let result = {};
    let error;
    switch (q.method) {
      case "initialize":
        result = {
          userAgent: "codex-evidence-fixture/0.163.0",
          codexHome: process.env.CODEX_HOME,
          platformFamily: "unix",
          platformOs: "linux",
        };
        break;
      case "account/read":
        result = {
          account:
            c.scenario === "R2"
              ? { type: "chatgpt", email: "native@example.test", planType: "plus" }
              : null,
          requiresOpenaiAuth: false,
        };
        break;
      case "model/list":
        result = { data: [data.model], nextCursor: null };
        break;
      case "skills/list":
        result = { data: [] };
        break;
      case "config/read":
        result = { config: {}, origins: {}, layers: [] };
        break;
      case "account/rateLimits/read":
        if (c.phase === "auth")
          error = {
            code: -32600,
            message: "codex account authentication required to read rate limits",
          };
        else if (c.phase === "transient")
          error = { code: -32000, message: "temporary evidence upstream outage" };
        else
          result = {
            rateLimits: limits(c.phase === "recovered" ? 23 : 12),
            accountId: c.scenario === "R2" ? "native-demo" : null,
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
          };
        fs.appendFileSync(
          (process.env.T3_USAGE_EVIDENCE_CONTROL || "/tmp/issue-11873-evidence/control.json") +
            ".milestones",
          JSON.stringify({
            scenario: c.scenario,
            phase: c.phase,
            method: q.method,
            error: error ?? null,
            result,
          }) + "\n",
        );
        break;
      default:
        result = {};
    }
    process.stdout.write(JSON.stringify({ id: q.id, ...(error ? { error } : { result }) }) + "\n");
  });
}
