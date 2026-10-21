// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetchInEffect:off schemaSyncInEffect:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Development-only process boundary captures raw synthetic wire evidence and owns server deadlines.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  CommandId,
  MessageId,
  ThreadId,
  WsRpcGroup,
  OrchestrationV2ThreadShellJson,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { limitRecoveryCommand } from "../src/orchestration-v2/UsageLimitRecoveryWorker.ts";
import { offline } from "./usage-limit-evidence.fixture.ts";
import recipe from "./usage-limit-evidence.fixture.json" with { type: "json" };

// Run from the checkout under test. Use identical files at each revision.
// node apps/server/scripts/usage-limit-evidence.ts --home /tmp/t3-limit-evidence-UNIQUE --row R1 --runner-commit <fixture-commit>
// Run R1..R5 at both revisions, redirecting stdout/stderr to evidence outside the repo.
// Offline EventSink staging is explicitly labeled. Only LIVE records are dev-server evidence.
// R4 active-wake rejection is offline harness evidence; its completed-wake Resume is live.
// Raw logs remain in the disposable home. Stop completes before the final offline event dump.
// No provider quota is real, and no UI or Claude adapter behavior is claimed.
const { values } = NodeUtil.parseArgs({
  options: {
    home: { type: "string" },
    row: { type: "string" },
    offline: { type: "string" },
    "runner-commit": { type: "string" },
  },
});
NodeAssert.ok(
  values.home && values.row && recipe.rows.includes(values.row),
  "Explicit disposable --home and --row R1..R5 required",
);
const home = NodePath.resolve(values.home);
NodeAssert.ok(
  home.startsWith(`${NodeOS.tmpdir()}/t3-limit-evidence-`) &&
    NodePath.dirname(home) === NodeOS.tmpdir() &&
    !NodeFS.lstatSync(NodePath.dirname(home)).isSymbolicLink(),
  "Home must be /tmp/t3-limit-evidence-* (never live T3 state)",
);
NodeAssert.ok(
  !NodeFS.existsSync(home) || !NodeFS.lstatSync(home).isSymbolicLink(),
  "Home must not be a symlink",
);
const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }));
const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));
const decodeShellSnapshot = Schema.decodeUnknownSync(
  Schema.Struct({ threads: Schema.Array(OrchestrationV2ThreadShellJson) }),
);
const root = NodePath.resolve(import.meta.dirname, "../../..");
const row = values.row;
const log = (kind: string, data: unknown) =>
  console.log(JSON.stringify({ kind, row, at: new Date().toISOString(), data }));
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
if (values.offline) {
  NodeAssert.ok(NodeFS.existsSync(`${home}/DISPOSABLE`), "Runner marker required");
  await offline(home, row, values.offline);
} else {
  NodeAssert.ok(!NodeFS.existsSync(home), "Fresh disposable home required");
  NodeFS.mkdirSync(`${home}/workspace`, { recursive: true });
  NodeFS.writeFileSync(
    `${home}/DISPOSABLE`,
    "Synthetic usage-limit evidence; safe to delete after capture\n",
  );
  NodeFS.mkdirSync(`${home}/os-home`);
  NodeChildProcess.execFileSync("git", ["init", "-q", `${home}/workspace`]);
  NodeChildProcess.execFileSync("git", [
    "-C",
    `${home}/workspace`,
    "-c",
    "user.name=Evidence",
    "-c",
    "user.email=evidence@localhost",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  log("manifest", {
    codeSha: git("rev-parse", "HEAD"),
    status: git("status", "--porcelain"),
    runnerCommitSha: values["runner-commit"] ?? null,
    runnerBlobSha: git("hash-object", import.meta.filename),
    runnerFiles: Object.fromEntries(
      [
        "usage-limit-evidence.ts",
        "usage-limit-evidence.fixture.ts",
        "usage-limit-evidence.fixture.json",
      ].map((name) => [name, hash(`${import.meta.dirname}/${name}`)]),
    ),
    workspaceDependencies: Object.fromEntries(
      ["shared", "contracts", "provider-core"].map((name) => [
        name,
        NodeFS.realpathSync(`${root}/apps/server/node_modules/@t3tools/${name}`),
      ]),
    ),
    fixtureVersion: recipe.version,
    home,
    root,
    node: process.version,
    platform: NodeChildProcess.execFileSync("uname", ["-sm"], { encoding: "utf8" }).trim(),
    provider: recipe.provider,
    noRealCredentials: true,
  });
  // An allowlist prevents ambient provider credentials, proxy config, and T3 origins leaking in.
  const environment = {
    PATH: process.env.PATH,
    HOME: `${home}/os-home`,
    TMPDIR: NodeOS.tmpdir(),
    LANG: "C.UTF-8",
    CODEX_HOME: `${home}/codex-home`,
    T3_CODEX_COLLAB_SCRIPT: `${home}/mock.json`,
  };
  const wireFixture = JSON.parse(
    NodeFS.readFileSync(
      `${root}/apps/server/src/provider/testFixtures/codexMultiAgentWire.json`,
      "utf8",
    ),
  );
  NodeFS.writeFileSync(
    `${home}/mock.json`,
    JSON.stringify({
      rootThreadId: wireFixture.rootThreadId,
      notifications: [],
      holdTurnOpen: true,
    }),
  );
  NodeFS.mkdirSync(`${home}/userdata`, { recursive: true });
  NodeFS.writeFileSync(
    `${home}/userdata/settings.json`,
    JSON.stringify({
      autoResumeLimitedThreads: false,
      snoozeLimitedThreads: false,
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          displayName: "Synthetic fixture",
          config: {
            binaryPath: `${root}/apps/server/src/provider/testFixtures/codexCollabMockPeer.sh`,
            homePath: `${home}/codex-home`,
          },
        },
      },
    }),
  );
  const disk = () => {
    NodeChildProcess.execFileSync("df", ["-h", "/"], { stdio: ["ignore", "inherit", "inherit"] });
    const stats = NodeFS.statfsSync("/");
    NodeAssert.ok(
      stats.bavail * stats.bsize >= 2 * 1024 ** 3,
      "Less than 2 GB free; stop and clean only owned artifacts",
    );
  };
  const seed = (stage: string) => {
    disk();
    NodeChildProcess.execFileSync(
      process.execPath,
      [import.meta.filename, "--home", home, "--row", row, "--offline", stage],
      { cwd: root, env: environment, stdio: ["ignore", "inherit", "inherit"], timeout: 60000 },
    );
  };
  seed("init");
  const manifest = JSON.parse(NodeFS.readFileSync(`${home}/fixture.json`, "utf8"));
  if (["R1", "R2", "R3", "R4"].includes(row)) seed("wake");
  if (row === "R5") {
    log("wall-clock-reset-wait", {
      resetAt: manifest.resetAt,
      until: new Date(Date.parse(manifest.resetAt) + 2000).toISOString(),
    });
    await new Promise((done) =>
      setTimeout(done, Math.max(0, Date.parse(manifest.resetAt) + 2000 - Date.now())),
    );
    seed("wake");
  }
  let server: NodeChildProcess.ChildProcess | undefined;
  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const child = server;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(deadline);
    log("server-stopped", { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode });
  };
  const abort = new AbortController();
  const onSignal = () => {
    abort.abort();
    void stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  async function live(phase: string) {
    disk();
    const reservation = NodeHttp.createServer();
    reservation.listen(0, "127.0.0.1");
    await new Promise<void>((done) => reservation.once("listening", done));
    const address = reservation.address();
    NodeAssert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((done) => reservation.close(() => done()));
    const origin = `http://127.0.0.1:${port}`;
    const bootstrap = NodeCrypto.randomUUID();
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
      { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    server = child;
    log("actual-dev-server-start", {
      phase,
      pid: child.pid,
      port,
      home,
      command: `${process.execPath} apps/server/src/bin.ts start --bootstrap-fd 3 --log-level debug`,
      bootstrap: "existing desktop bootstrap protocol; ephemeral token redacted",
    });
    const pipe = child.stdio[3];
    NodeAssert.ok(pipe && "write" in pipe);
    pipe.end(
      JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port,
        t3Home: home,
        host: "127.0.0.1",
        desktopBootstrapToken: bootstrap,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }),
    );
    const ready = Promise.withResolvers<void>();
    let output = "";
    for (const pipe of [child.stdout, child.stderr])
      pipe?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().replaceAll(bootstrap, "[REDACTED]");
        NodeFS.appendFileSync(`${home}/server.log`, text);
        output = (output + text).slice(-16000);
        if (output.includes("startup phase: complete")) ready.resolve();
      });
    child.once("error", ready.reject);
    child.once("exit", (code) => ready.reject(new Error(`Server exited ${code}: ${output}`)));
    const deadline = setTimeout(
      () => ready.reject(new Error(`Startup deadline: ${output}`)),
      60000,
    );
    try {
      await ready.promise;
    } finally {
      clearTimeout(deadline);
    }
    log("actual-dev-server-ready", {
      phase,
      pid: child.pid,
      port,
      readiness: "startup phase: complete",
    });
    const tokenResponse = await fetch(`${origin}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: bootstrap,
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      }),
    });
    NodeAssert.ok(tokenResponse.ok, `Existing bootstrap failed ${tokenResponse.status}`);
    const { access_token } = decodeToken(await tokenResponse.json());
    const headers = {
      Authorization: `Bearer ${access_token}`,
      [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
    };
    const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers,
    });
    NodeAssert.ok(ticketResponse.ok, `Existing ticket failed ${ticketResponse.status}`);
    const { ticket } = decodeTicket(await ticketResponse.json());
    const layerProtocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
        ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
      ),
      Layer.provide(RpcSerialization.layerJson),
    );
    const threadId = ThreadId.make(manifest.threadId);
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        const observe = Effect.fnUntraced(function* (label: string) {
          const projection = yield* client["orchestration.getThreadProjection"]({ threadId });
          const response = yield* Effect.promise(() =>
            fetch(`${origin}/api/orchestration/shell`, { headers }),
          );
          const shellSnapshot = yield* Effect.promise(() => response.json());
          log("LIVE-observables", {
            phase,
            label,
            projection,
            shellSnapshot,
            blockedRunId:
              usageLimitBlockedRun(projection.runs, projection.turnItems, null)?.id ?? null,
          });
          return projection;
        });
        const dispatch = Effect.fnUntraced(function* (command: OrchestrationV2Command) {
          log("LIVE-command", command);
          const result = yield* client["orchestration.dispatchCommand"](command).pipe(Effect.exit);
          log("LIVE-command-result", result);
          return result;
        });
        const waitFor = Effect.fnUntraced(function* (
          label: string,
          predicate: (p: OrchestrationV2ThreadProjection) => boolean,
        ) {
          yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
            Stream.mapEffect(
              Effect.fnUntraced(function* (item) {
                log("LIVE-ordered-stream", item);
                return item.kind === "snapshot"
                  ? item.projection
                  : yield* client["orchestration.getThreadProjection"]({ threadId });
              }),
            ),
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.timeout(90000),
          );
          return yield* observe(label);
        });
        const manual = (source: string, suffix: string): OrchestrationV2Command => ({
          type: "message.dispatch",
          commandId: CommandId.make(`proof:manual:${row}:${suffix}`),
          messageId: MessageId.make(`proof:manual:${row}:${suffix}`),
          threadId,
          manualContinuationOfRunId: source as typeof manifest.sourceRunId,
          text: recipe.manualText,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const waitForSweep = Effect.fnUntraced(function* () {
          const after = BigInt(Date.now()) * 1000000n;
          const tracePath = `${home}/userdata/logs/server.trace.ndjson`;
          const span = yield* Effect.promise(
            () =>
              new Promise<unknown>((resolve, reject) => {
                const deadline = setTimeout(() => {
                  watcher.close();
                  reject(new Error("No completed recovery sweep within 20 seconds"));
                }, 20000);
                let offset = NodeFS.statSync(tracePath).size;
                let pending = "";
                let totalBytes = 0;
                const inspect = () => {
                  try {
                    const size = NodeFS.statSync(tracePath).size;
                    const bytes = Buffer.alloc(size - offset);
                    totalBytes += bytes.length;
                    NodeAssert.ok(
                      totalBytes < 4 * 1024 * 1024,
                      "Trace observation exceeds 4 MB capture bound",
                    );
                    const file = NodeFS.openSync(tracePath, "r");
                    try {
                      NodeFS.readSync(file, bytes, 0, bytes.length, offset);
                    } finally {
                      NodeFS.closeSync(file);
                    }
                    offset = size;
                    const lines = (pending + bytes.toString("utf8")).split("\n");
                    pending = lines.pop()!;
                    for (const line of lines) {
                      if (!line) continue;
                      const event = JSON.parse(line);
                      if (
                        event.name === "UsageLimitRecoveryWorker.sweep" &&
                        BigInt(event.startTimeUnixNano) > after &&
                        event.exit?._tag === "Success"
                      ) {
                        clearTimeout(deadline);
                        watcher.close();
                        resolve(event);
                        return;
                      }
                    }
                  } catch (error) {
                    clearTimeout(deadline);
                    watcher.close();
                    reject(error);
                  }
                };
                const watcher = NodeFS.watch(NodePath.dirname(tracePath), inspect);
                inspect();
              }),
          );
          log("LIVE-worker-sweep-completed", span);
        });
        let projection = yield* observe("initial");
        if (row === "R4") {
          log("wall-clock-reset-wait", {
            resetAt: manifest.resetAt,
            until: new Date(Date.parse(manifest.resetAt) + 2000).toISOString(),
          });
          yield* Effect.promise(
            () =>
              new Promise((done) =>
                setTimeout(done, Math.max(0, Date.parse(manifest.resetAt) + 2000 - Date.now())),
              ),
          );
          const selected =
            usageLimitBlockedRun(projection.runs, projection.turnItems, null) ??
            latestExecutedRun(projection.runs);
          log("client-selector-expression (not rendered UI)", { selectedRunId: selected?.id });
          if (selected) yield* dispatch(manual(selected.id, "selected"));
          yield* observe("manual-selected-result");
          yield* dispatch(manual(manifest.sourceRunId, "duplicate-new-identity"));
          yield* dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`proof:queue-resume:${row}`),
            threadId,
          });
          yield* observe("queue-after-manual");
          return;
        }
        if (row === "R5") {
          yield* dispatch(manifest.savedDue);
          yield* dispatch(manual(manifest.sourceRunId, "stale"));
          yield* observe("stale-auto-and-manual-result");
          return;
        }
        if (row === "R3") {
          yield* dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`proof:stop:${row}`),
            threadId,
          });
          projection = yield* observe("stopped-before-arm");
        }
        if (row === "R1" || row === "R3") {
          log("LIVE-settings-command", { patch: { autoResumeLimitedThreads: true } });
          yield* client["server.updateSettings"]({ patch: { autoResumeLimitedThreads: true } });
          yield* waitForSweep();
          projection = yield* observe("automatic-arm-sweep-result");
          if (row === "R1" && usageLimitBlockedRun(projection.runs, projection.turnItems, null)) {
            projection = yield* waitFor(
              "automatically-armed",
              (p) => p.thread.limitRecovery?.autoResume === true,
            );
          } else if (row === "R3") {
            // Explicit rearm is a user command; the worker cannot replace Stop's request identity.
            yield* dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`proof:rearm:${row}`),
              threadId,
              limitRecovery: {
                runId: manifest.sourceRunId,
                resetAt: manifest.resetAt,
                autoResume: true,
                snooze: false,
              },
            });
            projection = yield* observe("explicitly-rearmed");
          }
          yield* client["server.updateSettings"]({ patch: { autoResumeLimitedThreads: false } });
        }
        // The scheduler and this dispatch use the same existing limitRecoveryCommand helper.
        const shellResponse = yield* Effect.promise(() =>
          fetch(`${origin}/api/orchestration/shell`, { headers }),
        );
        const shell = decodeShellSnapshot(yield* Effect.promise(() => shellResponse.json()));
        const candidate = shell.threads.find((t) => t.id === threadId)!;
        const due = limitRecoveryCommand(candidate, true, Date.parse(manifest.resetAt), false);
        log("due-selection", { due, resetAt: manifest.resetAt });
        if (due?.type === "message.dispatch") {
          log("wall-clock-reset-wait", { resetAt: manifest.resetAt });
          yield* Effect.promise(
            () =>
              new Promise((done) =>
                setTimeout(done, Math.max(0, Date.parse(manifest.resetAt) - Date.now())),
              ),
          );
          yield* dispatch(due);
          yield* dispatch(due);
        }
        yield* observe("final");
      }).pipe(Effect.scoped, Effect.provide(layerProtocol), Effect.timeout(180000)),
      { signal: abort.signal },
    );
  }
  try {
    await live("capture");
    await stop();
    seed("inspect");
    log("finished", { home, codeSha: git("rev-parse", "HEAD") });
  } finally {
    await stop();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
