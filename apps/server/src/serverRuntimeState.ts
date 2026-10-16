// @effect-diagnostics nodeBuiltinImport:off - Linux procfs is a direct read. The startup preflight cannot shell out: a container that reused this pid often has no `ps`, and a failed lookup must not decide that this process is another server.
import * as NodeFS from "node:fs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import packageJson from "../package.json" with { type: "json" };
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  ownerId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export class ServerRuntimeStateError extends Schema.TaggedError<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "host" | "devUrl">;
  readonly port: number;
  readonly serviceManaged?: boolean;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
    ...(input.serviceManaged ? { serviceManaged: true } : {}),
    serverVersion: packageJson.version,
  }));

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "persist",
          statePath: input.path,
          cause,
        }),
    ),
  );

export const clearPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(path, { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "clear",
            statePath: path,
            cause,
          }),
      ),
      Effect.catchTags({
        ServerRuntimeStateError: (error) =>
          Effect.logWarning(error.message).pipe(
            Effect.annotateLogs({
              operation: error.operation,
              statePath: error.statePath,
              cause: error,
            }),
          ),
      }),
    );
  });

/**
 * Signal 0 delivers nothing; it only reports whether the pid exists. EPERM
 * means it exists but belongs to another user, which still counts as alive.
 */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

// Linux reports starttime in USER_HZ ticks. That clock is 100 Hz on every architecture.
const LINUX_USER_HZ = 100;

const SERVER_PROCESS_NAMES = new Set([
  "node",
  "nodejs",
  "bun",
  "deno",
  "t3",
  "t3.exe",
  "t3.mjs",
  "bin.mjs",
  "bin.ts",
]);

const processBaseName = (value: string) => {
  const normalized = value.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return (slash < 0 ? normalized : normalized.slice(slash + 1)).toLowerCase();
};

const readProc = (path: string) => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** Wall-clock start from `/proc/<pid>/stat` field 22. Undefined off Linux or when the record cannot be read. */
const linuxProcessStartMs = (pid: number, platform: NodeJS.Platform): number | undefined => {
  if (platform !== "linux") return undefined;
  const stat = readProc(`/proc/${pid}/stat`);
  const procStat = readProc("/proc/stat");
  if (stat === undefined || procStat === undefined) return undefined;
  const commEnd = stat.lastIndexOf(")");
  const btime = /^btime\s+(\d+)/m.exec(procStat);
  if (commEnd < 0 || btime === null) return undefined;
  const startTicks = Number(
    stat
      .slice(commEnd + 2)
      .trim()
      .split(/\s+/)[19],
  );
  const bootSec = Number(btime[1]);
  if (!Number.isFinite(startTicks) || !Number.isFinite(bootSec)) return undefined;
  return bootSec * 1_000 + (startTicks * 1_000) / LINUX_USER_HZ;
};

/**
 * True when the command line cannot be a T3 server. An unreadable command line
 * stays false so an uninspected process is still treated as a possible server.
 * `node` and `bun` stay possible servers even for an unrecognized script.
 */
const linuxCmdlineCannotBeServer = (pid: number, platform: NodeJS.Platform): boolean => {
  if (platform !== "linux") return false;
  const cmdline = readProc(`/proc/${pid}/cmdline`);
  if (cmdline === undefined) return false;
  const args = cmdline.split("\0").filter((arg) => arg.length > 0);
  if (args.length === 0) return false;
  return args.every((arg) => !SERVER_PROCESS_NAMES.has(processBaseName(arg)));
};

/**
 * The manual startup preflight blocks only for a different process that could
 * still be the server that wrote this record. This process is never that
 * server: after an unclean container restart it is often the same pid. A later
 * start time means the pid was reused. A command line that is not a server
 * host is a different program that inherited the pid.
 */
export const recordedServerBlocksStartup = (
  state: Pick<PersistedServerRuntimeState, "pid" | "startedAt">,
  platform: NodeJS.Platform,
): boolean => {
  if (state.pid === process.pid || !isProcessAlive(state.pid)) return false;
  const startedMs = linuxProcessStartMs(state.pid, platform);
  const recordedAt = Date.parse(state.startedAt);
  if (startedMs !== undefined && Number.isFinite(recordedAt) && startedMs > recordedAt + 1_000) {
    return false;
  }
  if (linuxCmdlineCannotBeServer(state.pid, platform)) return false;
  return true;
};

export const readPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeedSome(contents),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.asSome,
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
          Effect.as(Option.none<PersistedServerRuntimeState>()),
        ),
    }),
  );
