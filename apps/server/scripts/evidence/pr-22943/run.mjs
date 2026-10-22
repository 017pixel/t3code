// Evidence driver for PR #22943 (issue #22920): runs the real T3 server from <server-checkout>
// once per fixture row and drives git.runStackedAction create_pr against a stubbed forge.
//   node apps/server/scripts/evidence/pr-22943/run.mjs --server <checkout> --out <dir> [--rows R1,R3]
//   node apps/server/scripts/evidence/pr-22943/run.mjs --smoke --out <dir>
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import { startForgeStub } from "./forge-stub.mjs";

const here = import.meta.dirname;
const { values } = NodeUtil.parseArgs({
  options: {
    server: { type: "string" },
    out: { type: "string" },
    rows: { type: "string", default: "R1,R2a,R2b,R3,R4a,R4b" },
    smoke: { type: "boolean", default: false },
  },
});
NodeAssert.ok(values.out, "--out is required");
const out = NodePath.resolve(values.out);
const caDir = NodePath.join(out, "ca");
NodeFS.mkdirSync(out, { recursive: true });

function isolatedEnv(logDir, stubPort) {
  const fakeHome = NodePath.join(out, "fakehome");
  NodeFS.mkdirSync(fakeHome, { recursive: true });
  const gitconfig = NodePath.join(out, "gitconfig");
  NodeFS.writeFileSync(gitconfig, "");
  return {
    PATH: `${NodePath.join(here, "bin")}:/usr/bin:/bin`,
    HOME: fakeHome,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: `http://127.0.0.1:${stubPort}`,
    HTTP_PROXY: `http://127.0.0.1:${stubPort}`,
    NO_PROXY: "127.0.0.1,localhost",
    NODE_EXTRA_CA_CERTS: NodePath.join(caDir, "ca.pem"),
    EV_LOG_DIR: logDir,
  };
}

if (values.smoke) {
  const logDir = NodePath.join(out, "smoke");
  NodeFS.mkdirSync(logDir, { recursive: true });
  const stub = await startForgeStub({
    caDir,
    logFile: NodePath.join(logDir, "forge.jsonl"),
    repoInfo: "ok",
  });
  const probe = `for (const u of ["https://github.invalid/api/v3/repos/acme/demo","https://example.com/"]) {
    try { const r = await fetch(u); console.log(u, r.status, (await r.text()).slice(0, 80)); }
    catch (e) { console.log(u, "ERR", e.cause?.message ?? e.message); } }`;
  // Async spawn: the stub lives in this process and must keep serving while the probe runs.
  const probeChild = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "-e", probe],
    {
      env: isolatedEnv(logDir, stub.port),
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await new Promise((done) => probeChild.once("exit", done));
  console.log(NodeFS.readFileSync(NodePath.join(logDir, "forge.jsonl"), "utf8"));
  await stub.close();
  process.exit(0);
}

NodeAssert.ok(values.server, "--server is required");
const serverRoot = NodePath.resolve(values.server);
const git = (cwd, ...args) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
const serverSha = git(serverRoot, "rev-parse", "HEAD").trim();

function dumpRefs(rowDir) {
  const W = NodePath.join(rowDir, "work");
  const B = NodePath.join(rowDir, "remote.git");
  const tryGit = (cwd, ...args) => {
    try {
      return git(cwd, ...args).trim();
    } catch {
      return "(none)";
    }
  };
  return [
    "# bare remote (local bare repo acting as the remote): for-each-ref",
    tryGit(B, "for-each-ref", "--format=%(objectname:short) %(refname)"),
    `# bare remote HEAD: ${tryGit(B, "symbolic-ref", "HEAD")}`,
    "# work: for-each-ref refs/heads refs/remotes",
    tryGit(
      W,
      "for-each-ref",
      "--format=%(objectname:short) %(refname)",
      "refs/heads",
      "refs/remotes",
    ),
    `# work: symbolic-ref refs/remotes/origin/HEAD: ${tryGit(W, "symbolic-ref", "-q", "refs/remotes/origin/HEAD")}`,
    "# work: branch.child.* config",
    tryGit(W, "config", "--get-regexp", "^branch\\.child\\."),
  ].join("\n");
}

async function freePort() {
  const server = NodeHttp.createServer().listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  const { port } = server.address();
  await new Promise((done) => server.close(() => done()));
  return port;
}

async function runRow(row) {
  const rowDir = NodePath.join(out, row);
  NodeChildProcess.execFileSync(NodePath.join(here, "fixture.sh"), [rowDir, row], {
    stdio: "pipe",
  });
  const logDir = NodePath.join(rowDir, "logs");
  NodeFS.mkdirSync(logDir, { recursive: true });
  const work = NodePath.join(rowDir, "work");
  const refsBefore = dumpRefs(rowDir);
  NodeFS.writeFileSync(NodePath.join(logDir, "refs-before.txt"), refsBefore + "\n");

  const stub = await startForgeStub({
    caDir,
    logFile: NodePath.join(logDir, "forge.jsonl"),
    repoInfo: row.startsWith("R4") ? "404" : "ok",
  });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const bootstrap = NodeCrypto.randomUUID();
  const home = NodePath.join(rowDir, "t3home");
  const server = NodeChildProcess.spawn(
    process.execPath,
    ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
    {
      cwd: serverRoot,
      env: isolatedEnv(logDir, stub.port),
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  server.stdio[3].end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      t3Home: home,
      host: "127.0.0.1",
      desktopBootstrapToken: bootstrap,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      // Skip login-shell PATH hydration, which would put the machine's real codex/gh ahead of the fakes.
      shellEnvironmentPrepared: true,
    }),
  );
  const ready = Promise.withResolvers();
  let tail = "";
  for (const pipe of [server.stdout, server.stderr])
    pipe.on("data", (data) => {
      const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
      NodeFS.appendFileSync(NodePath.join(logDir, "server.log"), text);
      tail = (tail + text).slice(-8192);
      if (tail.includes("startup phase: complete")) ready.resolve();
    });
  server.once("exit", (code) => ready.reject(new Error(`server exited ${code}`)));
  const deadline = setTimeout(() => ready.reject(new Error("server startup timed out")), 90_000);

  const events = [];
  let outcome;
  try {
    await ready.promise;
    clearTimeout(deadline);
    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: bootstrap,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    });
    NodeAssert.ok(tokenResponse.ok, `token exchange failed: ${tokenResponse.status}`);
    const { access_token } = await tokenResponse.json();
    const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
      },
    });
    NodeAssert.ok(ticketResponse.ok, `websocket ticket failed: ${ticketResponse.status}`);
    const { ticket } = await ticketResponse.json();
    const layer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
        ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        yield* client["git.runStackedAction"]({
          actionId: NodeCrypto.randomUUID(),
          cwd: work,
          action: "create_pr",
        }).pipe(Stream.runForEach((event) => Effect.sync(() => events.push(event))));
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.timeout("120 seconds")),
    );
    outcome = Exit.isSuccess(exit) ? { ok: true } : { ok: false, cause: String(exit.cause) };
  } catch (error) {
    outcome = { ok: false, cause: String(error?.stack ?? error) };
  } finally {
    clearTimeout(deadline);
    if (server.exitCode === null) {
      const exited = new Promise((done) => server.once("exit", done));
      server.kill("SIGTERM");
      const forced = setTimeout(() => server.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(forced);
    }
    await stub.close();
  }

  const refsAfter = dumpRefs(rowDir);
  NodeFS.writeFileSync(NodePath.join(logDir, "refs-after.txt"), refsAfter + "\n");
  NodeFS.writeFileSync(NodePath.join(logDir, "events.json"), JSON.stringify(events, null, 2));
  const forge = NodeFS.readFileSync(NodePath.join(logDir, "forge.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const posts = forge
    .filter((entry) => entry.kind === "forge-create-pr")
    .map((entry) => entry.body);
  const promptFiles = NodeFS.readdirSync(logDir).filter((name) => name.startsWith("prompt-"));
  const promptRange = promptFiles.map((name) => {
    const prompt = NodeFS.readFileSync(NodePath.join(logDir, name), "utf8");
    const base = prompt.match(/^Base branch: .*$/m)?.[0] ?? null;
    const commits = prompt.match(/^Commits:\n([\s\S]*?)\n\n/m)?.[1]?.split("\n") ?? [];
    return { file: name, base, commits };
  });
  const summary = {
    row,
    serverSha,
    posts,
    promptRange,
    phaseLabels: events
      .filter((e) => e.kind === "phase_started")
      .map((e) => `${e.phase}: ${e.label}`),
    result: events.find((e) => e.kind === "action_finished")?.result ?? null,
    failure: events.find((e) => e.kind === "action_failed") ?? null,
    outcome,
    refusedConnects: forge.filter((e) => e.kind === "connect-refused").map((e) => e.target),
    refsUnchanged: refsBefore === refsAfter,
  };
  NodeFS.writeFileSync(NodePath.join(logDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

for (const row of values.rows.split(",")) {
  const summary = await runRow(row);
  console.log(JSON.stringify(summary));
}
