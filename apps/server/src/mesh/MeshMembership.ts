// EXPERIMENTAL mesh v1: this machine's socket to its account's mesh object on the relay. It
// reports presence and score inputs, receives the member snapshot, and asks for member grants.
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  isPermanentMeshCloseCode,
  type MeshCapabilities,
  MeshCloseCode,
  type MeshMemberHello,
  MeshMemberMessage,
  type MeshMemberUpdate,
  MESH_PING_INTERVAL_MS,
  MESH_PING_MESSAGE,
  type MeshSnapshot,
  type MeshStatus,
  type MeshUnavailableReason,
  ReceivedMeshRelayMessage,
  RELAY_MESH_SOCKET_PATH,
  UnknownUnionMember,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import WebSocket from "ws";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import * as ConnectReachability from "../cloud/ConnectReachability.ts";
import * as CloudManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import { CLOUD_LINK_REVOKED, readRelayConnection } from "../cloud/config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MeshGrantRefusedError, MeshMembership, MeshUnavailableError } from "./Services.ts";

export class MeshRelaySocketError extends Schema.TaggedError<MeshRelaySocketError>()(
  "MeshRelaySocketError",
  { status: Schema.NullOr(Schema.Int), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.status === null
      ? "Could not open the mesh relay socket."
      : `The relay refused the mesh socket (HTTP ${this.status}).`;
  }
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = Duration.toMillis(Duration.minutes(5));
const GRANT_TIMEOUT = Duration.seconds(10);
// Direct endpoints and tunnel facts have no change stream of their own.
const RECHECK_INTERVAL = Duration.minutes(2);
// ConnectReachability debounces readiness by 3 s before it rechecks.
const READINESS_SETTLE = Duration.seconds(5);
// Refusals of the socket upgrade that retrying cannot change: the credential or link is gone, the
// relay wants another protocol, or (404) the relay has no mesh route at all. Every linked server
// runs this loop, so a relay without the mesh hears from each once per link change or restart.
const PERMANENT_UPGRADE_REFUSALS: ReadonlyMap<number, MeshUnavailableReason> = new Map([
  [401, "not-linked"],
  [403, "not-linked"],
  [426, "not-linked"],
  [404, "not-allowlisted"],
]);
// Set when this machine leaves and cleared once the relay answers its `left` close, so a machine
// that leaves while its relay socket is down, or dead without a close, still drops out of the
// mesh on its next contact.
const LEAVE_PENDING_SECRET = "mesh-leave-pending";
const LEAVE_ANSWER_TIMEOUT = Duration.seconds(10);

type HelloFields = Omit<MeshMemberHello, "type">;

interface MeshRelayLink {
  readonly socketUrl: string;
  readonly environmentCredential: string;
}

/** How one socket session ended. `joined` means the relay sent a snapshot first. */
export interface MeshSessionEnd {
  readonly code: number;
  readonly joined: boolean;
}

interface RelayConnection {
  readonly send: (text: string) => Effect.Effect<void>;
}

interface PendingGrant {
  readonly targetEnvironmentId: EnvironmentId;
  readonly deferred: Deferred.Deferred<string, MeshGrantRefusedError | MeshUnavailableError>;
}

const encodeMemberMessage = Schema.encodeSync(Schema.fromJsonString(MeshMemberMessage));
const decodeRelayMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ReceivedMeshRelayMessage),
);

const relaySocketUrl = (relayUrl: string): string => {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${RELAY_MESH_SOCKET_PATH}`;
  url.search = "";
  url.hash = "";
  return url.href;
};

const meshCapabilitiesOf = ({
  meshMember,
  meshAgents,
  meshGateway,
}: MeshCapabilities): MeshCapabilities => ({
  ...(meshMember === undefined ? {} : { meshMember }),
  ...(meshAgents === undefined ? {} : { meshAgents }),
  ...(meshGateway === undefined ? {} : { meshGateway }),
});

const same = Equal.equals;

/** The fields that changed since `previous`, or null when none did. */
export const helloUpdate = (previous: HelloFields, next: HelloFields): MeshMemberUpdate | null => {
  const update: MeshMemberUpdate = {
    type: "update",
    ...(same(previous.label, next.label) ? {} : { label: next.label }),
    ...(same(previous.serverVersion, next.serverVersion)
      ? {}
      : { serverVersion: next.serverVersion }),
    ...(same(previous.capabilities, next.capabilities) ? {} : { capabilities: next.capabilities }),
    ...(same(previous.score, next.score) ? {} : { score: next.score }),
    ...(same(previous.connectHostname, next.connectHostname)
      ? {}
      : { connectHostname: next.connectHostname }),
    ...(same(previous.directEndpoints, next.directEndpoints)
      ? {}
      : { directEndpoints: next.directEndpoints }),
  };
  return Object.keys(update).length > 1 ? update : null;
};

// The relay closes with `left` when it removed this member because its link was revoked. A member
// that left on its own reads as `disabled` from the setting.
const permanentCloseReason = (code: number): MeshUnavailableReason =>
  code === MeshCloseCode.sharedKey
    ? "shared-key"
    : code === MeshCloseCode.left
      ? "not-linked"
      : "not-allowlisted";

/** Full jitter over an exponential backoff, capped at five minutes. */
const reconnectDelay = (attempt: number) => {
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 20));
  return Random.nextIntBetween(Math.floor(ceiling / 2), ceiling).pipe(Effect.map(Duration.millis));
};

/**
 * Runs `session` until the relay ends it for good, with a permanent close code or a permanent
 * refusal of the upgrade, and returns why. Between tries it waits a jittered backoff, which starts
 * over after a session the relay accepted.
 */
export const reconnectUntilPermanent = Effect.fn("MeshMembership.reconnectUntilPermanent")(
  function* (session: Effect.Effect<MeshSessionEnd, MeshRelaySocketError>) {
    let attempt = 0;
    while (true) {
      // A defect ends this session only; the loop keeps the machine in the mesh.
      const exit = yield* Effect.exit(session);
      if (Exit.isSuccess(exit)) {
        if (isPermanentMeshCloseCode(exit.value.code)) {
          return permanentCloseReason(exit.value.code);
        }
        if (exit.value.joined) attempt = 0;
      } else {
        const status = Option.getOrNull(Cause.findErrorOption(exit.cause))?.status ?? null;
        const refusal = status === null ? undefined : PERMANENT_UPGRADE_REFUSALS.get(status);
        if (refusal !== undefined) {
          yield* Effect.logInfo("The relay refused this machine's mesh socket", { status });
          return refusal;
        }
        yield* Effect.logDebug("Mesh relay socket failed", { cause: exit.cause });
      }
      yield* Effect.sleep(yield* reconnectDelay(attempt));
      attempt += 1;
    }
  },
);

const rawDataText = (data: WebSocket.RawData): string =>
  Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data).toString("utf8");

// Effect's socket client cannot set headers; the relay authenticates the upgrade like any other
// environment call, with the environment credential as a bearer token.
const openRelaySocket = (link: MeshRelayLink) =>
  Effect.callback<WebSocket, MeshRelaySocketError>((resume) => {
    const socket = new WebSocket(link.socketUrl, {
      headers: { authorization: `Bearer ${link.environmentCredential}` },
    });
    socket.once("open", () => resume(Effect.succeed(socket)));
    socket.once("unexpected-response", (request, response) => {
      request.destroy();
      resume(Effect.fail(new MeshRelaySocketError({ status: response.statusCode ?? null })));
    });
    socket.once("error", (cause) =>
      resume(Effect.fail(new MeshRelaySocketError({ status: null, cause }))),
    );
    return Effect.sync(() => socket.terminate());
  });

/**
 * Closes with `left` and returns the code the socket closed with. Only the relay's answering close
 * frame carries `left`; a socket that died without a close ends as 1006 after a timeout.
 */
const closeAsLeft = (socket: WebSocket) =>
  Effect.callback<number>((resume) => {
    // Every error is followed by a close.
    socket.on("error", () => {});
    if (socket.readyState === WebSocket.CLOSED) return resume(Effect.succeed(1006));
    socket.once("close", (code) => resume(Effect.succeed(code)));
    socket.close(MeshCloseCode.left);
  }).pipe(
    Effect.timeoutOrElse({ duration: LEAVE_ANSWER_TIMEOUT, orElse: () => Effect.succeed(1006) }),
  );

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostPower = yield* HostPowerMonitor.HostPowerMonitor;
  const reachability = yield* ConnectReachability.ConnectReachability;
  const endpointRuntime = yield* CloudManagedEndpointRuntime.CloudManagedEndpointRuntime;
  const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const cloudLink = yield* CloudLink.CloudLink;

  const selfEnvironmentId = yield* environment.getEnvironmentId;
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const initialSettings = yield* serverSettings.getSettings;

  // The setting as the session loop last applied it.
  const enabledRef = yield* Ref.make(initialSettings.meshEnabled);
  // The setting as last written or streamed, so per-request checks never read settings.
  const settingRef = yield* Ref.make(initialSettings.meshEnabled);
  const snapshotRef = yield* SubscriptionRef.make<MeshSnapshot | null>(null);
  const reasonRef = yield* Ref.make<MeshUnavailableReason>("connecting");
  const connectionRef = yield* Ref.make<RelayConnection | null>(null);
  const pendingRef = yield* Ref.make(new Map<string, PendingGrant>());
  const requestCounter = yield* Ref.make(0);
  // Survives reconnects, so a member removed while this machine was away still loses its sessions.
  const memberIdsRef = yield* Ref.make<string | null>(null);
  const recheck = yield* PubSub.unbounded<void>();

  const isEnabled = Ref.get(settingRef);

  const unavailableReason = Effect.gen(function* () {
    return (yield* isEnabled) ? yield* Ref.get(reasonRef) : ("disabled" as const);
  });

  const selfRole = SubscriptionRef.get(snapshotRef).pipe(
    Effect.map((snapshot) =>
      snapshot === null
        ? ("off" as const)
        : snapshot.captain === selfEnvironmentId
          ? ("captain" as const)
          : ("member" as const),
    ),
  );

  const revokeMeshSessions = (keepCallers: ReadonlyArray<EnvironmentId>) =>
    environmentAuth
      .revokeMeshMemberSessions({ keepCallers })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not revoke mesh member sessions", { cause }),
        ),
      );

  const readLink = Effect.gen(function* () {
    const connection = yield* readRelayConnection;
    const revoked = yield* secrets.get(CLOUD_LINK_REVOKED);
    return connection === null || Option.isSome(revoked)
      ? null
      : {
          socketUrl: relaySocketUrl(connection.url),
          environmentCredential: connection.environmentCredential,
        };
  }).pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the T3 Connect link for the mesh", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

  const setLeavePending = (pending: boolean) =>
    (pending
      ? secrets.set(LEAVE_PENDING_SECRET, new TextEncoder().encode("true"))
      : secrets.remove(LEAVE_PENDING_SECRET)
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record whether the relay knows this machine left", { cause }),
      ),
    );

  /** Opens the relay socket only to close it as `left`, so the relay removes this machine. */
  const sendLeave = Effect.fn("MeshMembership.sendLeave")(function* (link: MeshRelayLink) {
    const answered = yield* Ref.make(false);
    // An unanswered close tries again after a backoff; a permanent refusal keeps the marker for
    // the next restart or link change.
    yield* reconnectUntilPermanent(
      Effect.acquireUseRelease(
        openRelaySocket(link),
        (socket) =>
          closeAsLeft(socket).pipe(
            Effect.tap((code) => Ref.set(answered, code === MeshCloseCode.left)),
            Effect.map((code): MeshSessionEnd => ({ code, joined: false })),
          ),
        (socket) => Effect.sync(() => socket.terminate()),
      ),
    );
    if (yield* Ref.get(answered)) yield* setLeavePending(false);
  });

  const helloFields = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => initialSettings),
    );
    const power = yield* hostPower.snapshot;
    const latestReachability = yield* reachability.latest;
    const connector = yield* endpointRuntime.inspectConnector;
    const machineKind: EnvironmentMachineKind | null =
      settings.environmentIcon ?? descriptor.platform.machine ?? null;
    return {
      label: descriptor.label,
      serverVersion: descriptor.serverVersion,
      capabilities: meshCapabilitiesOf(descriptor.capabilities),
      score: {
        backgroundService: descriptor.capabilities.serverSelfUpdate === "boot-service",
        onBattery: power.onBattery,
        lowPowerMode: power.lowPowerMode,
        machineKind,
        startedAt,
        tunnelReady: Option.exists(latestReachability, (latest) => latest.status === "reachable"),
      },
      // The relay sets the tunnel's ingress to the hostname it builds client bootstrap endpoint
      // URLs from, so the captain's `Host` matches what clients sign proofs for.
      connectHostname: connector?.hostname ?? null,
      directEndpoints: yield* directEndpoints.resolve(),
    } satisfies HelloFields;
  });

  const settlePending = (
    requestId: string,
    outcome: (pending: PendingGrant) => Effect.Effect<string, MeshGrantRefusedError>,
  ) =>
    Ref.get(pendingRef).pipe(
      Effect.flatMap((pending) => {
        const entry = pending.get(requestId);
        return entry === undefined
          ? Effect.void
          : Deferred.completeWith(entry.deferred, outcome(entry)).pipe(Effect.asVoid);
      }),
    );

  const failPendingGrants = Ref.getAndSet(pendingRef, new Map()).pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(
        pending.values(),
        ({ deferred }) =>
          Deferred.fail(deferred, new MeshUnavailableError({ reason: "connecting" })),
        { discard: true },
      ),
    ),
  );

  const applySnapshot = Effect.fn("MeshMembership.applySnapshot")(function* (
    snapshot: MeshSnapshot,
  ) {
    const memberIds = snapshot.members.map((member) => member.environmentId);
    const key = memberIds.toSorted().join("\n");
    // Revoke before publishing, so nothing sees the new members while a removed one still has access.
    if ((yield* Ref.getAndSet(memberIdsRef, key)) !== key) {
      yield* revokeMeshSessions(memberIds);
    }
    yield* SubscriptionRef.set(snapshotRef, snapshot);
  }, environmentAuth.withMeshSessionLock);

  /* Per frame on a long-lived socket; the session span already covers it. */
  const handleRelayMessage = Effect.fnUntraced(function* (text: string, joined: Ref.Ref<boolean>) {
    const decoded = decodeRelayMessage(text);
    if (Option.isNone(decoded) || decoded.value instanceof UnknownUnionMember) return;
    const message = decoded.value;
    switch (message.type) {
      case "snapshot": {
        const { type: _type, ...snapshot } = message;
        yield* Ref.set(joined, true);
        return yield* applySnapshot(snapshot);
      }
      case "credentialGrant":
        return yield* settlePending(message.requestId, () => Effect.succeed(message.grant));
      case "credentialError":
        return yield* settlePending(message.requestId, ({ targetEnvironmentId }) =>
          Effect.fail(new MeshGrantRefusedError({ targetEnvironmentId, code: message.code })),
        );
      case "pong":
        return;
    }
  });

  const sendUpdate = Effect.fn("MeshMembership.sendUpdate")(function* (
    connection: RelayConnection,
    lastSent: Ref.Ref<HelloFields>,
  ) {
    const next = yield* helloFields;
    const update = helloUpdate(yield* Ref.get(lastSent), next);
    if (update === null) return;
    yield* Ref.set(lastSent, next);
    yield* connection.send(encodeMemberMessage(update));
  });

  const runSession = Effect.fn("MeshMembership.session")(function* (link: MeshRelayLink) {
    const socket = yield* Effect.acquireRelease(openRelaySocket(link), (socket) =>
      Effect.gen(function* () {
        const enabled = yield* Ref.get(enabledRef);
        socket.removeAllListeners();
        socket.on("error", () => {});
        if (socket.readyState !== WebSocket.OPEN) {
          socket.terminate();
          return;
        }
        if (enabled) {
          socket.close(1000);
          return;
        }
        // The relay removes a member at once when it closes with `left`. A socket that looks open
        // but is dead never answers, so the marker stays for the next contact.
        const code = yield* closeAsLeft(socket);
        socket.terminate();
        if (code === MeshCloseCode.left) yield* setLeavePending(false);
      }),
    );
    const closed = yield* Deferred.make<number>();
    const received = yield* Queue.unbounded<string>();
    socket.on("message", (data, isBinary) => {
      if (!isBinary) Queue.offerUnsafe(received, rawDataText(data));
    });
    socket.on("close", (code) => {
      Deferred.doneUnsafe(closed, Effect.succeed(code));
    });
    // Every error is followed by a close.
    socket.on("error", () => {});
    if (socket.readyState !== WebSocket.OPEN) Deferred.doneUnsafe(closed, Effect.succeed(1006));

    const connection: RelayConnection = {
      send: (text) =>
        Effect.sync(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        }),
    };
    yield* Effect.acquireRelease(Ref.set(connectionRef, connection), () =>
      Ref.set(connectionRef, null).pipe(
        Effect.andThen(SubscriptionRef.set(snapshotRef, null)),
        Effect.andThen(failPendingGrants),
      ),
    );

    const joined = yield* Ref.make(false);
    const recheckChanges = yield* PubSub.subscribe(recheck);
    yield* connection
      .send(MESH_PING_MESSAGE)
      .pipe(Effect.delay(MESH_PING_INTERVAL_MS), Effect.forever, Effect.forkScoped);
    yield* Stream.fromQueue(received).pipe(
      Stream.runForEach((text) => handleRelayMessage(text, joined)),
      Effect.forkScoped,
    );

    const hello = yield* helloFields;
    const lastSent = yield* Ref.make(hello);
    yield* connection.send(encodeMemberMessage({ type: "hello", ...hello }));
    yield* Stream.mergeAll(
      [
        Stream.fromSubscription(recheckChanges),
        hostPower.streamChanges.pipe(Stream.map(() => undefined)),
        endpointRuntime.readinessChanged.pipe(Stream.debounce(READINESS_SETTLE)),
        Stream.tick(RECHECK_INTERVAL).pipe(Stream.drop(1)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.runForEach(() => sendUpdate(connection, lastSent)),
      Effect.forkScoped,
    );

    const code = yield* Deferred.await(closed);
    return { code, joined: yield* Ref.get(joined) } satisfies MeshSessionEnd;
  }, Effect.scoped);

  const runMembership = Effect.gen(function* () {
    if (!(yield* Ref.get(enabledRef))) {
      yield* environmentAuth.withMeshSessionLock(revokeMeshSessions([]));
      const leavePending = yield* secrets.get(LEAVE_PENDING_SECRET).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      );
      const link = leavePending ? yield* readLink : null;
      if (link !== null) yield* sendLeave(link);
      return;
    }
    const link = yield* readLink;
    if (link === null) {
      yield* environmentAuth.withMeshSessionLock(
        revokeMeshSessions([]).pipe(Effect.andThen(Ref.set(reasonRef, "not-linked"))),
      );
      return;
    }
    yield* Ref.set(reasonRef, "connecting");
    const reason = yield* reconnectUntilPermanent(runSession(link));
    yield* environmentAuth.withMeshSessionLock(
      revokeMeshSessions([]).pipe(Effect.andThen(Ref.set(reasonRef, reason))),
    );
    yield* Effect.logInfo("The relay ended this machine's mesh socket", { reason });
  });

  // Leaving or rejoining, and a Connect link change, restart the session; a permanent close
  // stays closed until one of them happens.
  const settingsChanges = yield* serverSettings.subscribeChanges;
  const restarts = Stream.merge(
    settingsChanges.pipe(
      Stream.tap((settings) =>
        Ref.set(settingRef, settings.meshEnabled).pipe(
          Effect.andThen(PubSub.publish(recheck, undefined)),
        ),
      ),
      Stream.filterEffect((settings) =>
        Ref.getAndSet(enabledRef, settings.meshEnabled).pipe(
          Effect.map((previous) => previous !== settings.meshEnabled),
        ),
      ),
      // Before the switch below ends the open session, whose answered `left` close clears it.
      Stream.tap((settings) => setLeavePending(!settings.meshEnabled)),
      Stream.map(() => undefined),
    ),
    cloudLink.linkChanges,
  );
  yield* forkParked(
    Stream.concat(Stream.make(undefined), restarts).pipe(
      Stream.switchMap(() => Stream.fromEffect(runMembership)),
      Stream.runDrain,
    ),
  );

  const requireConnection = Effect.gen(function* () {
    const connection = yield* Ref.get(connectionRef);
    if (connection === null) {
      return yield* new MeshUnavailableError({ reason: yield* unavailableReason });
    }
    return connection;
  });

  return MeshMembership.of({
    snapshot: SubscriptionRef.get(snapshotRef).pipe(Effect.map(Option.fromNullishOr)),
    snapshots: SubscriptionRef.changes(snapshotRef).pipe(
      Stream.filterMap((snapshot) =>
        snapshot === null ? Result.failVoid : Result.succeed(snapshot),
      ),
    ),
    status: Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(snapshotRef);
      const role = yield* selfRole;
      return {
        enabled: yield* isEnabled,
        selfRole: role,
        ...(role === "off" ? { unavailableReason: yield* unavailableReason } : {}),
        captain: snapshot?.captain ?? null,
        pin: snapshot?.pin ?? null,
        members: snapshot?.members ?? [],
      } satisfies MeshStatus;
    }),
    selfRole,
    isEnabled,
    setEnabled: Effect.fn("MeshMembership.setEnabled")(function* (enabled) {
      yield* serverSettings.updateSettings({ meshEnabled: enabled });
      yield* environmentAuth.withMeshSessionLock(
        Ref.set(settingRef, enabled).pipe(
          Effect.andThen(enabled ? Effect.void : revokeMeshSessions([])),
        ),
      );
    }),
    setPin: Effect.fn("MeshMembership.setPin")(function* (environmentId) {
      const connection = yield* requireConnection;
      yield* connection.send(encodeMemberMessage({ type: "setPin", environmentId }));
    }),
    requestGrant: Effect.fn("MeshMembership.requestGrant")(function* ({
      targetEnvironmentId,
      jkt,
    }) {
      const connection = yield* requireConnection;
      const requestId = String(yield* Ref.updateAndGet(requestCounter, (count) => count + 1));
      const deferred = yield* Deferred.make<string, MeshGrantRefusedError | MeshUnavailableError>();
      yield* Ref.update(pendingRef, (pending) =>
        new Map(pending).set(requestId, { targetEnvironmentId, deferred }),
      );
      yield* connection.send(
        encodeMemberMessage({ type: "credentialRequest", requestId, targetEnvironmentId, jkt }),
      );
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: GRANT_TIMEOUT,
          orElse: () =>
            Effect.fail(new MeshGrantRefusedError({ targetEnvironmentId, code: "internal" })),
        }),
        Effect.ensuring(
          Ref.update(pendingRef, (pending) => {
            const next = new Map(pending);
            next.delete(requestId);
            return next;
          }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(MeshMembership, make);
