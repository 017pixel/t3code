// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - Detached runtime boundary; receipts survive their server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as HostLock from "./ProviderMaintenanceHostLock.ts";
import type { ProviderMaintenanceCommandResult } from "./providerMaintenanceRunner.ts";

const Result = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
const Receipt = Schema.Struct({
  id: Schema.String,
  provider: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  instanceIds: Schema.Array(ProviderInstanceId),
  origin: Schema.optional(Schema.Literals(["manual", "background"])),
  targetVersion: Schema.optional(Schema.String),
  exactVersion: Schema.optional(Schema.Boolean),
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))),
  parentPid: Schema.Number,
  directory: Schema.String,
  pid: Schema.optional(Schema.Number),
  progress: Schema.optional(Schema.String),
  result: Schema.optional(Result),
});
export type InstallReceipt = typeof Receipt.Type;
const decodeReceipt = Schema.decodeSync(Schema.fromJsonString(Receipt));
export const readReceipt = (file: string) => decodeReceipt(NodeFS.readFileSync(file, "utf8"));
const writeReceipt = (file: string, receipt: InstallReceipt) => {
  const temp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 });
  NodeFS.renameSync(temp, file);
};

type InstallInput = Pick<
  InstallReceipt,
  | "provider"
  | "instanceId"
  | "instanceIds"
  | "origin"
  | "targetVersion"
  | "exactVersion"
  | "startedAt"
  | "command"
  | "args"
  | "env"
> & {
  readonly onProgress?: (line: string) => Effect.Effect<void>;
};

export class ProviderInstallError extends Data.TaggedError("ProviderInstallError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const installError = (cause: unknown) =>
  new ProviderInstallError({
    message: cause instanceof Error ? cause.message : "Provider installer could not run.",
    cause,
  });

export class ProviderInstallSupervisor extends Context.Service<
  ProviderInstallSupervisor,
  {
    readonly run: (
      input: InstallInput,
    ) => Effect.Effect<ProviderMaintenanceCommandResult, ProviderInstallError>;
    readonly receipts: Effect.Effect<ReadonlyArray<InstallReceipt>, ProviderInstallError>;
  }
>()("t3/provider/ProviderInstallSupervisor") {}

export const layer = Layer.effect(
  ProviderInstallSupervisor,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const host = yield* HostLock.ProviderMaintenanceHostLock;
    const invocation = yield* resolveSelfInvocation();
    const root = NodePath.join(config.stateDir, "provider-updates");
    const run: ProviderInstallSupervisor["Service"]["run"] = Effect.fn(
      "ProviderInstallSupervisor.run",
    )(function* (input) {
      const file = NodePath.join(root, `${encodeURIComponent(input.instanceId)}.json`);
      const receipt: InstallReceipt = {
        ...input,
        id: NodeCrypto.randomUUID(),
        parentPid: process.pid,
        directory: host.directory,
      };
      yield* Effect.try(() => {
        NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
        NodeFS.rmSync(`${file}.start`, { force: true });
        writeReceipt(file, receipt);
      });
      yield* Effect.tryPromise(
        () =>
          new Promise<void>((resolve, reject) => {
            // The relay exits before the supervisor starts the installer. On Windows,
            // detached alone does not remove a process from taskkill /t's parent tree.
            const relay = NodeChildProcess.spawn(
              invocation.command,
              [...selfInvocationArgs(invocation, ["__provider-install-relay", file])],
              {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
                env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              },
            );
            relay.once("error", reject);
            relay.once("spawn", () => {
              relay.unref();
              resolve();
            });
          }),
      );
      const readCurrent = Effect.try(() => {
        const current = readReceipt(file);
        if (current.id !== receipt.id)
          throw new ProviderInstallError({ message: "Provider install receipt replaced." });
        return current;
      });
      const deadline = (yield* Clock.currentTimeMillis) + 30_000;
      while (true) {
        const current = yield* readCurrent;
        if (current.result) return current.result;
        if (current.pid !== undefined) break;
        if ((yield* Clock.currentTimeMillis) >= deadline)
          return yield* Effect.fail(
            new ProviderInstallError({ message: "Provider install supervisor did not start." }),
          );
        yield* Effect.sleep("100 millis");
      }
      return yield* host.handoff(
        Effect.gen(function* () {
          let started = false;
          let progress: string | undefined;
          while (true) {
            const current = yield* readCurrent;
            if (current.result) return current.result;
            if (current.pid !== undefined && !started) {
              // Only acknowledge after the durable lease is visible. A server dying
              // before this write cannot authorize a late installer to start.
              yield* Effect.try(() =>
                NodeFS.writeFileSync(`${file}.start`, receipt.id, { mode: 0o600 }),
              );
              started = true;
            }
            if (current.progress && current.progress !== progress) {
              progress = current.progress;
              if (input.onProgress) yield* input.onProgress(progress);
            }
            if (!started && (yield* Clock.currentTimeMillis) >= deadline)
              return yield* Effect.fail(
                new ProviderInstallError({ message: "Provider install supervisor did not start." }),
              );
            if (started && !(yield* Effect.sync(() => HostLock.installIsAlive(host.directory)))) {
              return yield* Effect.fail(
                new ProviderInstallError({
                  message: "Provider install supervisor exited without a result.",
                }),
              );
            }
            yield* Effect.sleep("1 second");
          }
        }),
      );
    }, Effect.mapError(installError));
    return ProviderInstallSupervisor.of({
      run,
      receipts: Effect.try(() =>
        NodeFS.existsSync(root)
          ? NodeFS.readdirSync(root)
              .filter((file) => file.endsWith(".json"))
              .map((file) => readReceipt(NodePath.join(root, file)))
          : [],
      ).pipe(Effect.mapError(installError)),
    });
  }),
);

/** The server holds the gate until the supervisor has registered its own install lease. */
export async function runInstallSubcommand(command: string, args: ReadonlyArray<string>) {
  const file = args[0];
  if (!file) throw new Error("Missing provider install receipt");
  if (command === "__provider-install-relay") {
    const invocation = await Effect.runPromise(
      resolveSelfInvocation().pipe(Effect.provide(NodeServices.layer)),
    );
    NodeFS.writeFileSync(`${file}.stdout`, "", { mode: 0o600 });
    NodeFS.writeFileSync(`${file}.stderr`, "", { mode: 0o600 });
    const stdout = NodeFS.openSync(`${file}.stdout`, "a", 0o600);
    const stderr = NodeFS.openSync(`${file}.stderr`, "a", 0o600);
    const child = NodeChildProcess.spawn(
      invocation.command,
      [...selfInvocationArgs(invocation, ["__provider-install", file, String(process.pid)])],
      {
        detached: true,
        stdio: ["ignore", stdout, stderr],
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    NodeFS.closeSync(stdout);
    NodeFS.closeSync(stderr);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return;
  }
  let receipt = readReceipt(file);
  const relayPid = Number(args[1]);
  // The live relay is the only link into the desktop/server's Windows tree.
  while (HostLock.isProcessAlive(relayPid)) await new Promise((resolve) => setTimeout(resolve, 25));
  const lease = HostLock.installLeasePath(receipt.directory);
  const candidate = `${lease}.${process.pid}`;
  NodeFS.writeFileSync(candidate, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    // A delayed relay must never overwrite an already running install's owner.
    NodeFS.linkSync(candidate, lease);
  } finally {
    NodeFS.rmSync(candidate, { force: true });
  }
  // Quit signals must never interrupt an install. SIGKILL still leaves the
  // process group in the lease, which other servers inspect before reclaiming.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  const truncated = new Set<string>();
  const output = (suffix: string) => {
    const fd = NodeFS.openSync(file + suffix, "r+");
    try {
      const size = NodeFS.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(size, 10_000));
      NodeFS.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      if (size > buffer.length) truncated.add(suffix);
      if (size > 20_000) {
        NodeFS.ftruncateSync(fd, 0);
        NodeFS.writeSync(fd, buffer, 0, buffer.length, 0);
      }
      return { text: buffer.toString("utf8"), truncated: truncated.has(suffix) };
    } finally {
      NodeFS.closeSync(fd);
    }
  };
  let heartbeat: NodeJS.Timeout | undefined;
  let ownsGate = false;
  const beat = (format: (line: string) => string | null) => {
    NodeFS.utimesSync(lease, new Date(), new Date());
    NodeFS.utimesSync(NodePath.join(receipt.directory, "gate.lock"), new Date(), new Date());
    const text = output(".stderr").text || output(".stdout").text;
    const progress = text
      .split(/\r?\n|\r/)
      .map(format)
      .findLast((line) => line !== null);
    if (progress) {
      receipt = { ...receipt, progress };
      writeReceipt(file, receipt);
    }
  };
  try {
    receipt = { ...receipt, pid: process.pid };
    writeReceipt(file, receipt);
    const deadline = Date.now() + 30_000;
    while (!NodeFS.existsSync(`${file}.start`)) {
      if (!HostLock.isProcessAlive(receipt.parentPid) || Date.now() >= deadline) {
        throw new Error("Server exited before authorizing provider installation.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (NodeFS.readFileSync(`${file}.start`, "utf8") !== receipt.id)
      throw new Error("Provider install receipt replaced");
    ownsGate = true;
    NodeFS.rmSync(`${file}.start`, { force: true });
    const { runProviderMaintenanceCommandWithSpawner, toProgressLine } =
      await import("./providerMaintenanceRunner.ts");
    heartbeat = setInterval(() => beat(toProgressLine), 1_000);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { ChildProcessSpawner } = yield* Effect.promise(() => import("effect/process"));
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* runProviderMaintenanceCommandWithSpawner({
          spawner,
          command: receipt.command,
          args: receipt.args,
          ...(receipt.env ? { env: receipt.env } : {}),
          inheritOutput: true,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const stdout = output(".stdout");
    const stderr = output(".stderr");
    writeReceipt(file, {
      ...receipt,
      finishedAt: new Date().toISOString(),
      result: {
        ...result,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      },
    });
  } catch (error) {
    writeReceipt(file, {
      ...receipt,
      finishedAt: new Date().toISOString(),
      result: {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });
  } finally {
    clearInterval(heartbeat);
    if (ownsGate)
      NodeFS.rmSync(NodePath.join(receipt.directory, "gate.lock"), {
        recursive: true,
        force: true,
      });
    NodeFS.rmSync(lease, { force: true });
  }
}
