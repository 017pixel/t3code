// EXPERIMENTAL mesh v1: `t3 mesh`. Every command asks the running server over its RPC socket,
// so the CLI and the app share one path. `status` reports the server's cached state only.
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  MeshStatus,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class MeshCliError extends Schema.TaggedError<MeshCliError>()("MeshCliError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const isMeshCliError = Schema.is(MeshCliError);

/** Expected outcomes print as one line on stderr instead of a stack trace. */
const reportMeshErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isMeshCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

const toCliError = (error: { readonly message: string }) =>
  new MeshCliError({ detail: error.message });

const makeMeshClient = RpcClient.make(WsRpcGroup);
type MeshClient = Effect.Success<typeof makeMeshClient>;

/**
 * Signs in to the running server with a short-lived session, as `t3 thread` does, and revokes
 * it when the command ends.
 */
const withMeshClient = Effect.fn("cli.mesh.withClient")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (client: MeshClient) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new MeshCliError({
        detail: `No running T3 Code server uses ${config.baseDir}. Start T3 Code, then retry.`,
      });
    }
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueSession({
        label: "t3 mesh cli",
        scopes: [AuthOrchestrationReadScope, AuthSettingsWriteScope],
        ttl: Duration.minutes(5),
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const ticket = yield* environmentAuth.issueWebSocketTicket(issued, { use: "rpc" });
    const socketUrl = new URL("/ws", runtimeState.value.origin);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    socketUrl.searchParams.set("wsTicket", ticket.ticket);
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(socketUrl.href).pipe(
              Layer.provide(Socket.layerWebSocketConstructorGlobal),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    const client = yield* makeMeshClient.pipe(Effect.provide(protocol));
    return yield* run(client);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const readStatus = (client: MeshClient) =>
  client[WS_METHODS.meshStatus]({}).pipe(Effect.mapError(toCliError));

/** Finds a member by exact id, else by label ignoring case. */
export const resolveMeshMember = (
  status: MeshStatus,
  idOrLabel: string,
): Effect.Effect<EnvironmentId, MeshCliError> => {
  const wanted = idOrLabel.trim();
  const byId = status.members.find((member) => member.environmentId === wanted);
  if (byId !== undefined) return Effect.succeed(byId.environmentId);
  const byLabel = status.members.filter(
    (member) => member.label.toLowerCase() === wanted.toLowerCase(),
  );
  if (byLabel.length === 1) return Effect.succeed(byLabel[0]!.environmentId);
  return Effect.fail(
    new MeshCliError({
      detail:
        byLabel.length === 0
          ? `No mesh member is called '${wanted}'. Run \`t3 mesh status\` to list members.`
          : `More than one member is called '${wanted}'. Pin it by id: ${byLabel
              .map((member) => member.environmentId)
              .join(", ")}.`,
    }),
  );
};

const formatMeshStatus = (status: MeshStatus, now: DateTime.Utc): string => {
  const labelOf = (environmentId: EnvironmentId | null) =>
    environmentId === null
      ? "none"
      : (status.members.find((member) => member.environmentId === environmentId)?.label ??
        environmentId);
  const lines = [
    `Mesh: ${status.enabled ? "joined" : "left"}`,
    `This machine: ${status.selfRole}${
      status.unavailableReason === undefined ? "" : ` (${status.unavailableReason})`
    }`,
    `Captain: ${labelOf(status.captain)}`,
    `Pin: ${labelOf(status.pin)}`,
  ];
  if (status.members.length > 0) {
    lines.push("", "Members:");
    for (const member of status.members) {
      const notes = [
        member.online ? "online" : "offline",
        ...(member.environmentId === status.captain ? ["captain"] : []),
        ...(member.ineligibleReason === undefined
          ? []
          : [`cannot be captain: ${member.ineligibleReason}`]),
      ];
      lines.push(`  ${member.label}  ${member.environmentId}  ${notes.join(", ")}`);
    }
  }
  const sessions = status.sessions ?? [];
  if (sessions.length > 0) {
    lines.push("", "Sessions:");
    for (const session of sessions) {
      const minutes = Math.max(
        0,
        Math.round((session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 60_000),
      );
      lines.push(
        `  ${labelOf(session.environmentId)}  via ${session.route.kind} ${session.route.httpBaseUrl}  expires in ${minutes} min`,
      );
    }
  }
  return lines.join("\n");
};

const encodeStatusJson = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(MeshStatus)));

const meshStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the status as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show this machine's mesh state and its cached sessions."),
  Command.withHandler((flags) =>
    withMeshClient(
      flags,
      Effect.fn("cli.mesh.status")(function* (client: MeshClient) {
        const status = yield* readStatus(client);
        if (flags.json) {
          return yield* Console.log(encodeStatusJson(status));
        }
        yield* Console.log(formatMeshStatus(status, yield* DateTime.now));
      }),
    ).pipe(reportMeshErrors),
  ),
);

const setEnabledCommand = (name: "join" | "leave") =>
  Command.make(name, { ...projectLocationFlags }).pipe(
    Command.withDescription(
      name === "join"
        ? "Join this machine to its T3 Connect account's mesh."
        : "Take this machine out of the mesh and end other members' sessions on it.",
    ),
    Command.withHandler((flags) =>
      withMeshClient(flags, (client) =>
        client[WS_METHODS.meshSetEnabled]({ enabled: name === "join" }).pipe(
          Effect.mapError(toCliError),
          Effect.andThen(Console.log(name === "join" ? "Joined the mesh." : "Left the mesh.")),
        ),
      ).pipe(reportMeshErrors),
    ),
  );

const meshPinCommand = Command.make("pin", {
  ...projectLocationFlags,
  member: Argument.String("id-or-label").pipe(
    Argument.withDescription("The member to keep as captain while it can be one."),
  ),
}).pipe(
  Command.withDescription("Pin a member as captain."),
  Command.withHandler((flags) =>
    withMeshClient(
      flags,
      Effect.fn("cli.mesh.pin")(function* (client: MeshClient) {
        const resolved = yield* resolveMeshMember(yield* readStatus(client), flags.member);
        yield* client[WS_METHODS.meshSetPin]({ environmentId: resolved }).pipe(
          Effect.mapError(toCliError),
        );
        yield* Console.log(`Pinned ${resolved} as captain.`);
      }),
    ).pipe(reportMeshErrors),
  ),
);

const meshUnpinCommand = Command.make("unpin", { ...projectLocationFlags }).pipe(
  Command.withDescription("Let the relay choose the captain again."),
  Command.withHandler((flags) =>
    withMeshClient(flags, (client) =>
      client[WS_METHODS.meshSetPin]({ environmentId: null }).pipe(
        Effect.mapError(toCliError),
        Effect.andThen(Console.log("Removed the captain pin.")),
      ),
    ).pipe(reportMeshErrors),
  ),
);

export const meshCommand = Command.make("mesh").pipe(
  Command.withDescription("EXPERIMENTAL: this machine's place in its T3 Connect mesh."),
  Command.withSubcommands([
    meshStatusCommand,
    setEnabledCommand("join"),
    setEnabledCommand("leave"),
    meshPinCommand,
    meshUnpinCommand,
  ]),
);
