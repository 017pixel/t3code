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
  parentIdentity: Schema.optional(Schema.NullOr(Schema.String)),
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
  try {
    NodeFS.writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 });
    NodeFS.renameSync(temp, file);
  } finally {
    NodeFS.rmSync(temp, { force: true });
  }
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

const failedResult = (error: unknown) => ({
  stdout: "",
  stderr: error instanceof Error ? error.message : String(error),
  exitCode: null,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
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
        parentIdentity: HostLock.readProcessIdentity(process.pid),
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
          let progress: string | undefined;
          while (true) {
            const current = yield* readCurrent;
            if (current.result) return current.result;
            if (current.progress && current.progress !== progress) {
              progress = current.progress;
              if (input.onProgress) yield* input.onProgress(progress);
            }
            if (!(yield* Effect.sync(() => HostLock.installIsAlive(host.directory)))) {
              const finished = yield* readCurrent;
              if (finished.result) return finished.result;
              return yield* Effect.fail(
                new ProviderInstallError({
                  message: "Provider install supervisor exited without a result.",
                }),
              );
            }
            yield* Effect.sleep("1 second");
          }
        }),
        // Authorize immediately after stopping the server heartbeat, before cancellation can interrupt polling.
        Effect.try(() => NodeFS.writeFileSync(`${file}.start`, receipt.id, { mode: 0o600 })),
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
    const outputs: number[] = [];
    try {
      outputs.push(NodeFS.openSync(`${file}.stdout`, "a", 0o600));
      outputs.push(NodeFS.openSync(`${file}.stderr`, "a", 0o600));
      const child = NodeChildProcess.spawn(
        invocation.command,
        [
          ...selfInvocationArgs(invocation, [
            "__provider-install",
            file,
            String(process.pid),
            HostLock.readProcessIdentity(process.pid) ?? "",
          ]),
        ],
        {
          detached: true,
          stdio: ["ignore", outputs[0]!, outputs[1]!],
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      try {
        if (outputs[1] !== undefined) NodeFS.closeSync(outputs[1]);
      } finally {
        if (outputs[0] !== undefined) NodeFS.closeSync(outputs[0]);
      }
    }
    return;
  }
  let receipt = readReceipt(file);
  const relayPid = Number(args[1]);
  // The live relay is the only link into the desktop/server's Windows tree.
  while (HostLock.isProcessAlive(relayPid, args[2] || undefined))
    await new Promise((resolve) => setTimeout(resolve, 25));
  const lease = HostLock.installLeasePath(receipt.directory);
  const candidate = `${lease}.${process.pid}`;
  const identity = HostLock.readProcessIdentity(process.pid);
  const descendants: HostLock.InstallDescendants = new Map();
  const job = `t3-provider-install-${NodeCrypto.randomUUID()}`;
  let registered = false;
  try {
    NodeFS.writeFileSync(candidate, JSON.stringify({ pid: process.pid, identity }), {
      flag: "wx",
      mode: 0o600,
    });
    // A delayed relay must never overwrite an already running install's owner.
    NodeFS.linkSync(candidate, lease);
    registered = true;
    NodeFS.rmSync(candidate, { force: true });
  } catch (error) {
    try {
      if (registered) NodeFS.rmSync(lease, { force: true });
    } finally {
      NodeFS.rmSync(candidate, { force: true });
    }
    throw error;
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
  const childrenAreAlive = () =>
    HostLock.installChildrenAreAlive(process.pid, identity, descendants, job);
  const persistChildren = () => {
    const temp = `${candidate}.tmp`;
    try {
      NodeFS.writeFileSync(
        temp,
        JSON.stringify({
          pid: process.pid,
          identity,
          job,
          descendants: Array.from(descendants, ([pid, identity]) => ({ pid, identity })),
        }),
        { mode: 0o600 },
      );
      NodeFS.renameSync(temp, lease);
    } finally {
      NodeFS.rmSync(temp, { force: true });
    }
  };
  const beat = (format: (line: string) => string | null) => {
    NodeFS.utimesSync(lease, new Date(), new Date());
    NodeFS.utimesSync(NodePath.join(receipt.directory, "gate.lock"), new Date(), new Date());
    const stderr = output(".stderr");
    const stdout = output(".stdout");
    const text = stderr.text || stdout.text;
    const progress = text
      .split(/\r?\n|\r/)
      .map(format)
      .findLast((line) => line !== null);
    if (progress) {
      receipt = { ...receipt, progress };
      writeReceipt(file, receipt);
    }
  };
  let result: ProviderMaintenanceCommandResult | undefined;
  try {
    HostLock.createInstallJob(process.pid, job);
    persistChildren();
    // Once readiness is durable the server or desktop can replace these files.
    // Load every installer dependency before allowing that handoff.
    const { runProviderMaintenanceCommandWithSpawner, toProgressLine } =
      await import("./providerMaintenanceRunner.ts");
    const { ChildProcessSpawner } = await import("effect/process");
    receipt = { ...receipt, pid: process.pid };
    writeReceipt(file, receipt);
    const deadline = Date.now() + 30_000;
    while (!NodeFS.existsSync(`${file}.start`)) {
      if (
        !HostLock.isProcessAlive(receipt.parentPid, receipt.parentIdentity) ||
        Date.now() >= deadline
      ) {
        throw new Error("Server exited before authorizing provider installation.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (NodeFS.readFileSync(`${file}.start`, "utf8") !== receipt.id)
      throw new Error("Provider install receipt replaced");
    ownsGate = true;
    NodeFS.rmSync(`${file}.start`, { force: true });
    heartbeat = setInterval(() => {
      try {
        childrenAreAlive();
        persistChildren();
      } catch {
        // Retry failed observation/persistence while the supervisor keeps admission closed.
      }
      try {
        beat(toProgressLine);
      } catch {
        // The live PID/process group still holds admission when disk writes fail.
      }
    }, 1_000);
    result = await Effect.runPromise(
      Effect.gen(function* () {
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
  } catch (error) {
    result = failedResult(error);
  } finally {
    try {
      if (ownsGate) {
        while (true) {
          try {
            if (!childrenAreAlive()) break;
          } catch {
            // An unavailable process table cannot authorize admission.
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      clearInterval(heartbeat);
      if (result) {
        if (result.exitCode !== null) {
          try {
            const stdout = output(".stdout");
            const stderr = output(".stderr");
            result = {
              ...result,
              stdout: stdout.text,
              stderr: stderr.text,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
            };
          } catch (error) {
            result = failedResult(error);
          }
        }
        writeReceipt(file, { ...receipt, finishedAt: new Date().toISOString(), result });
      }
    } finally {
      clearInterval(heartbeat);
      try {
        if (ownsGate)
          NodeFS.rmSync(NodePath.join(receipt.directory, "gate.lock"), {
            recursive: true,
            force: true,
          });
      } finally {
        NodeFS.rmSync(lease, { force: true });
      }
    }
  }
}
