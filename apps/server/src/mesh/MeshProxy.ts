// EXPERIMENTAL mesh v1: the captain side of the captain route. While this member is captain,
// a client signed in to the same Connect account reaches every other member through
// `/api/mesh/via/<handle>/<environmentId>/<path>`. The captain only relays: members check the
// client's own credentials, and the captain keeps no state beyond handles and open connections.
import {
  type EnvironmentId,
  isMeshForwardedPath,
  MESH_VIA_NOT_CAPTAIN_STATUS,
  MESH_VIA_PATH,
  MESH_VIA_REFUSED_STATUS,
  type MeshMemberView,
  type MeshRoute,
  type MeshSnapshot,
  MeshViaForbiddenError,
  MeshViaNotCaptainError,
  MeshViaRefusedError,
  MeshViaResponse,
  parseMeshViaPath,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MeshServices from "./Services.ts";
import * as MeshVia from "./MeshVia.ts";

const HANDLE_KEY_SECRET = "mesh-via-handle-key";
const HANDLE_KEY_BYTES = 32;

/** The key is bound to the Connect user it was made for, so an account change rotates it. */
const HandleKeyRecord = Schema.fromJsonString(
  Schema.Struct({ cloudUserId: Schema.String, key: Schema.String }),
);
const decodeHandleKeyRecord = Schema.decodeUnknownOption(HandleKeyRecord);
const encodeHandleKeyRecord = Schema.encodeSync(HandleKeyRecord);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface HandleKey {
  readonly cloudUserId: string;
  readonly handle: string;
}

/**
 * One stretch as captain. Demotion, leaving and a Connect link change end it and close everything
 * it holds.
 */
interface CaptainTerm {
  /** The last snapshot that named this member captain; serves while the relay socket is away. */
  snapshot: MeshSnapshot | null;
  /**
   * Members a probe or a forwarded request reached, which `mintVia` lists. The route itself stays
   * in MeshCredentials, which walks again when this machine's network or the member's addresses
   * change.
   */
  readonly reachable: Set<EnvironmentId>;
  readonly probes: Map<EnvironmentId, Fiber.Fiber<void>>;
  readonly agents: Map<
    EnvironmentId,
    { readonly route: MeshRoute; readonly agent: ReturnType<typeof MeshVia.makeMemberAgent> }
  >;
  /** Closes one open forwarded connection each. */
  readonly connections: Set<() => void>;
}

export class MeshProxy extends Context.Service<
  MeshProxy,
  {
    /** The caller's handle and the members this captain reaches. Only for `cloud-connect`. */
    readonly mintVia: (session: {
      readonly subject: string;
    }) => Effect.Effect<MeshViaResponse, MeshViaForbiddenError | MeshViaNotCaptainError>;
    /** Forwards one HTTP request or WebSocket upgrade below `/api/mesh/via/`. */
    readonly forward: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      MeshViaRefusedError | MeshViaNotCaptainError
    >;
  }
>()("t3/mesh/MeshProxy") {}

/** Online members other than this one that have a Connect hostname to send as `Host`. */
const forwardableMember = (snapshot: MeshSnapshot, environmentId: EnvironmentId) =>
  snapshot.members.find(
    (member): member is MeshMemberView & { readonly connectHostname: string } =>
      member.environmentId === environmentId &&
      member.environmentId !== snapshot.selfEnvironmentId &&
      member.online &&
      member.connectHostname !== null,
  );

const notFound = HttpServerResponse.text("Not Found", { status: 404 });
const badGateway = HttpServerResponse.text("Bad Gateway", { status: 502 });

const make = Effect.gen(function* () {
  const membership = yield* MeshServices.MeshMembership;
  const credentials = yield* MeshServices.MeshCredentials;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const cloudLink = yield* CloudLink.CloudLink;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;

  // Undefined until read; null when no key exists for the current Connect user.
  const handleKey = yield* Ref.make<HandleKey | null | undefined>(undefined);
  const handleKeyLock = yield* Semaphore.make(1);
  let term: CaptainTerm | null = null;

  /** Reads this machine's Connect user and its key. Creates a key only when `create`. */
  const loadHandleKey = Effect.fn("MeshProxy.loadHandleKey")(
    function* (create: boolean) {
      const cloudUserId = Option.map(yield* secrets.get(CLOUD_LINKED_USER_ID), (bytes) =>
        textDecoder.decode(bytes),
      );
      if (Option.isNone(cloudUserId)) {
        yield* Ref.set(handleKey, null);
        return null;
      }
      const record = Option.flatMap(yield* secrets.get(HANDLE_KEY_SECRET), (bytes) =>
        decodeHandleKeyRecord(textDecoder.decode(bytes)),
      ).pipe(Option.filter((stored) => stored.cloudUserId === cloudUserId.value));
      let key = Option.flatMap(record, (stored) =>
        Result.getSuccess(Base64Url.decode(stored.key)),
      ).pipe(Option.getOrNull);
      if (key === null) {
        if (!create) {
          // A key made for another account must not come back if that account links again.
          yield* secrets.remove(HANDLE_KEY_SECRET);
          yield* Ref.set(handleKey, null);
          return null;
        }
        key = yield* crypto.randomBytes(HANDLE_KEY_BYTES);
        yield* secrets.set(
          HANDLE_KEY_SECRET,
          textEncoder.encode(
            encodeHandleKeyRecord({ cloudUserId: cloudUserId.value, key: Base64Url.encode(key) }),
          ),
        );
      }
      const loaded = {
        cloudUserId: cloudUserId.value,
        handle: signPayload(`mesh-via:${cloudUserId.value}`, key),
      };
      yield* Ref.set(handleKey, loaded);
      return loaded;
    },
    handleKeyLock.withPermits(1),
    Effect.orDie,
  );

  const isCurrentHandle = Effect.fn("MeshProxy.isCurrentHandle")(function* (handle: string) {
    const cached = yield* Ref.get(handleKey);
    const key = cached === undefined ? yield* loadHandleKey(false) : cached;
    return key !== null && timingSafeEqualBase64Url(handle, key.handle);
  });

  const endTerm = Effect.gen(function* () {
    const ended = term;
    term = null;
    if (ended === null) return;
    for (const close of ended.connections) close();
    for (const { agent } of ended.agents.values()) agent.destroy();
    yield* Fiber.interruptAll(ended.probes.values());
  });

  /** Leaving the mesh rotates the key, so handles from before never work again. */
  const leave = Effect.fn("MeshProxy.leave")(function* () {
    if (term === null && (yield* Ref.get(handleKey)) === null) return;
    // Rotate first: a client that sees its socket close must not get back in with its old handle.
    yield* handleKeyLock.withPermits(1)(
      secrets
        .remove(HANDLE_KEY_SECRET)
        .pipe(Effect.orDie, Effect.andThen(Ref.set(handleKey, null))),
    );
    yield* endTerm;
  });

  const currentTerm = Effect.sync(
    () =>
      (term ??= {
        snapshot: null,
        reachable: new Set(),
        probes: new Map(),
        agents: new Map(),
        connections: new Set(),
      }),
  );

  /** The open term while this member is captain; otherwise names the captain to move to. */
  const captainTerm = Effect.gen(function* () {
    const role = yield* membership.selfRole;
    if (role === "captain") return yield* currentTerm;
    if (!(yield* membership.isEnabled)) {
      yield* leave();
    } else if (role === "off" && term !== null) {
      // A relay socket blip clears the snapshot: serve on until a snapshot names another captain.
      // A permanent close ends the term.
      if ((yield* membership.status).unavailableReason === "connecting") return term;
      yield* endTerm;
    }
    const snapshot = Option.getOrNull(yield* membership.snapshot);
    const captain =
      snapshot?.captain === snapshot?.selfEnvironmentId ? null : (snapshot?.captain ?? null);
    return yield* new MeshViaNotCaptainError({ captain });
  });

  /** Drops members that left or went offline, and probes the rest it has not reached yet. */
  const reconcile = Effect.fn("MeshProxy.reconcile")(function* (
    current: CaptainTerm,
    snapshot: MeshSnapshot,
  ) {
    current.snapshot = snapshot;
    for (const environmentId of current.reachable) {
      if (forwardableMember(snapshot, environmentId) === undefined) {
        current.reachable.delete(environmentId);
        current.agents.get(environmentId)?.agent.destroy();
        current.agents.delete(environmentId);
      }
    }
    for (const member of snapshot.members) {
      const environmentId = member.environmentId;
      if (
        forwardableMember(snapshot, environmentId) === undefined ||
        current.reachable.has(environmentId) ||
        current.probes.has(environmentId)
      ) {
        continue;
      }
      const probe = yield* credentials.route(environmentId).pipe(
        Effect.match({
          onSuccess: () => void current.reachable.add(environmentId),
          onFailure: () => void current.reachable.delete(environmentId),
        }),
        Effect.ensuring(Effect.sync(() => current.probes.delete(environmentId))),
        Effect.forkIn(scope),
      );
      current.probes.set(environmentId, probe);
    }
  });

  const onSnapshot = Effect.fn("MeshProxy.onSnapshot")(
    function* (snapshot: MeshSnapshot) {
      if ((yield* membership.selfRole) !== "captain") return yield* endTerm;
      // A new term rereads the Connect user, so an account change rotates the key here.
      if (term === null) yield* loadHandleKey(false);
      yield* reconcile(yield* currentTerm, snapshot);
    },
    // One bad snapshot must not stop the watcher; the next one reconciles again.
    Effect.catchCause((cause) => Effect.logWarning("mesh captain update failed", { cause })),
  );

  const mintVia: MeshProxy["Service"]["mintVia"] = Effect.fn("MeshProxy.mintVia")(
    function* (session) {
      // Desktop and paired sessions keep their direct routes; only Connect sign-ins use the captain.
      if (session.subject !== "cloud-connect") return yield* new MeshViaForbiddenError();
      const current = yield* captainTerm;
      const key = yield* loadHandleKey(true);
      if (key === null) return yield* new MeshViaForbiddenError();
      const snapshot = yield* membership.snapshot;
      if (Option.isSome(snapshot)) yield* reconcile(current, snapshot.value);
      // A client that asks right after a promotion still gets the full table.
      yield* Fiber.awaitAll([...current.probes.values()]);
      return { handle: key.handle, routes: [...current.reachable] };
    },
  );

  // A new route value means credentials walked again: this machine's network or the member's
  // addresses changed, or the route was forgotten. Pooled sockets from before may be half-open,
  // and a request sent on one hangs past the connect deadline, so the old agent retires. Requests
  // still in flight on it finish, so a walk never fails them.
  const agentFor = (current: CaptainTerm, environmentId: EnvironmentId, route: MeshRoute) => {
    const existing = current.agents.get(environmentId);
    if (existing?.route === route) return existing.agent;
    if (existing !== undefined) MeshVia.retireMemberAgent(existing.agent);
    const agent = MeshVia.makeMemberAgent(route.httpBaseUrl);
    current.agents.set(environmentId, { route, agent });
    return agent;
  };

  // Request middleware owns tracing for forwarded requests, including long-lived streams.
  const forward: MeshProxy["Service"]["forward"] = Effect.fnUntraced(function* (request) {
    const via = parseMeshViaPath(request.originalUrl);
    if (via === null) return notFound;
    // The handle comes first, so a caller without one learns nothing about the mesh.
    if (!(yield* isCurrentHandle(via.handle))) {
      return yield* new MeshViaRefusedError({ reason: "bad-handle" });
    }
    const current = yield* captainTerm;
    if (!isMeshForwardedPath(via.forwardedPath)) return notFound;
    const snapshot = Option.getOrElse(yield* membership.snapshot, () => current.snapshot);
    const member = snapshot && forwardableMember(snapshot, via.environmentId);
    if (!member) return yield* new MeshViaRefusedError({ reason: "unknown-environment" });
    const environmentId = member.environmentId;
    // A cache read unless this machine's network or the member's addresses changed, or the last
    // request failed upstream.
    const route = yield* credentials
      .route(environmentId)
      .pipe(
        Effect.catch(() =>
          Effect.sync(() => current.reachable.delete(environmentId)).pipe(
            Effect.andThen(new MeshViaRefusedError({ reason: "unknown-environment" })),
          ),
        ),
      );
    current.reachable.add(environmentId);
    const target = {
      environmentId,
      baseUrl: route.httpBaseUrl,
      host: member.connectHostname,
      path: via.forwardedPath,
    };
    const track: MeshVia.TrackConnection = (close) => {
      // The term ended while this request was on its way: close it at once.
      if (term !== current) {
        close();
        return () => undefined;
      }
      current.connections.add(close);
      return () => current.connections.delete(close);
    };
    const forwarded =
      request.headers.upgrade?.toLowerCase() === "websocket"
        ? MeshVia.forwardWebSocket({ request, target, track })
        : MeshVia.forwardHttp({
            request,
            target,
            agent: agentFor(current, environmentId, route),
            track,
          });
    return yield* forwarded.pipe(
      Effect.catchTags({
        // The route went bad, so the next request walks the routes again. A request that failed
        // on a route already replaced says nothing about the new one.
        MeshViaUpstreamError: () =>
          credentials.cachedRoute(environmentId).pipe(
            Effect.flatMap((cached) =>
              Option.isSome(cached) && cached.value === route
                ? credentials
                    .forgetRoute(environmentId)
                    .pipe(
                      Effect.andThen(Effect.sync(() => current.reachable.delete(environmentId))),
                    )
                : Effect.void,
            ),
            Effect.as(badGateway),
          ),
      }),
    );
  });

  // Off at boot: leaving already removed the key, so this process has nothing to rotate.
  if (!(yield* membership.isEnabled)) yield* Ref.set(handleKey, null);
  yield* membership.snapshots.pipe(Stream.runForEach(onSnapshot), Effect.forkScoped);
  // Another account, or none: the next term reads the Connect user and its key again.
  yield* cloudLink.linkChanges.pipe(
    Stream.runForEach(() =>
      handleKeyLock.withPermits(1)(Ref.set(handleKey, undefined)).pipe(Effect.andThen(endTerm)),
    ),
    Effect.forkScoped,
  );
  // Leaving persists `mesh.enabled`, and the relay sends nothing to a member that left.
  yield* settings.streamChanges.pipe(
    Stream.runForEach(() =>
      membership.isEnabled.pipe(
        Effect.flatMap((enabled) => (enabled ? Effect.void : leave())),
        Effect.catchCause((cause) => Effect.logWarning("mesh captain leave failed", { cause })),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Scope.addFinalizer(scope, endTerm);

  return MeshProxy.of({ mintVia, forward });
});

export const layer = Layer.effect(MeshProxy, make);

const MeshViaErrorBody = Schema.Union([
  MeshViaRefusedError,
  MeshViaNotCaptainError,
  MeshViaForbiddenError,
]);

const STATUS_BY_TAG = {
  MeshViaRefusedError: MESH_VIA_REFUSED_STATUS,
  MeshViaNotCaptainError: MESH_VIA_NOT_CAPTAIN_STATUS,
  MeshViaForbiddenError: 403,
} as const;

const errorResponse = (error: typeof MeshViaErrorBody.Type) =>
  HttpServerResponse.schemaJson(MeshViaErrorBody)(error, {
    status: STATUS_BY_TAG[error._tag],
  }).pipe(Effect.orDie);

const mint = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  const proxy = yield* MeshProxy;
  return yield* proxy.mintVia(session).pipe(
    Effect.flatMap((response) =>
      HttpServerResponse.schemaJson(MeshViaResponse)(response).pipe(Effect.orDie),
    ),
    Effect.catchTags({
      MeshViaForbiddenError: errorResponse,
      MeshViaNotCaptainError: errorResponse,
    }),
  );
});

const forward = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const proxy = yield* MeshProxy;
  return yield* proxy.forward(request).pipe(
    Effect.catchTags({
      MeshViaRefusedError: errorResponse,
      MeshViaNotCaptainError: errorResponse,
    }),
  );
});

/**
 * `POST /api/mesh/via` mints a handle; everything below it is forwarded. One route, because the
 * router also gives a `/*` route its bare prefix. Provide {@link layer} beside it.
 */
export const layerRoutes = HttpRouter.add(
  "*",
  `${MESH_VIA_PATH}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.originalUrl.split("?", 1)[0] !== MESH_VIA_PATH) return yield* forward;
    return request.method === "POST"
      ? yield* mint
      : HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }),
);
