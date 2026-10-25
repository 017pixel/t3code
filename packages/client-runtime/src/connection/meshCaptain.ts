/**
 * EXPERIMENTAL mesh v1, client side of the captain route. Reads the relay's mesh, mints a via
 * handle over the client's live session to the captain, and publishes each member's path through
 * it. A captain route is one more route in the walk; if it fails, the member falls back.
 */
import {
  EnvironmentId,
  MESH_VIA_NOT_CAPTAIN_STATUS,
  MESH_VIA_PATH,
  MeshViaResponse,
  meshViaBasePath,
  type RelayMeshResponse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { PreparedConnection } from "./model.ts";
import type { CaptainPath } from "./routes.ts";
import * as ConnectionWakeups from "./wakeups.ts";

/** What a cold start needs to race the captain route before the first relay read. */
export const SavedMeshCaptain = Schema.Struct({
  accountId: Schema.String,
  captain: EnvironmentId,
  /**
   * The client's route to the captain when the handle was minted. Only member routes race it at
   * cold start; those check the member's descriptor before any credential goes out.
   */
  address: Schema.String,
  handle: Schema.String,
  /** Members the captain could forward to. */
  routes: Schema.Array(EnvironmentId),
});
export type SavedMeshCaptain = typeof SavedMeshCaptain.Type;

export interface MeshCaptainStoreShape {
  readonly load: Effect.Effect<Option.Option<SavedMeshCaptain>>;
  readonly save: (saved: Option.Option<SavedMeshCaptain>) => Effect.Effect<void>;
}

/** In memory unless the platform keeps it in its connection catalog. */
export class MeshCaptainStore extends Context.Reference<MeshCaptainStoreShape>(
  "@t3tools/client-runtime/connection/meshCaptain/MeshCaptainStore",
  {
    defaultValue: () => {
      let saved = Option.none<SavedMeshCaptain>();
      return {
        load: Effect.sync(() => saved),
        save: (next) =>
          Effect.sync(() => {
            saved = next;
          }),
      };
    },
  },
) {}

export interface MeshCaptainState {
  /** The last relay read for the signed-in account. */
  readonly mesh: RelayMeshResponse | null;
  readonly saved: SavedMeshCaptain | null;
}

/**
 * A captain route exists while the relay names a gateway captain (or, before the first read, the
 * saved one) and the captain listed the member when it minted the handle.
 */
function captainPaths(state: MeshCaptainState): ReadonlyMap<EnvironmentId, CaptainPath> {
  const { mesh, saved } = state;
  if (saved === null) return new Map();
  const online = (environmentId: EnvironmentId) =>
    mesh === null ||
    mesh.members.some((member) => member.environmentId === environmentId && member.online);
  if (mesh !== null) {
    const captain = mesh.members.find((member) => member.environmentId === saved.captain);
    if (
      !mesh.available ||
      mesh.captain !== saved.captain ||
      captain?.online !== true ||
      captain.capabilities.meshGateway !== true
    ) {
      return new Map();
    }
  }
  return new Map(
    saved.routes
      .filter((environmentId) => environmentId !== saved.captain && online(environmentId))
      .map((environmentId) => [
        environmentId,
        {
          captain: saved.captain,
          httpBaseUrl: environmentEndpointUrl(
            saved.address,
            meshViaBasePath(saved.handle, environmentId),
          ),
        },
      ]),
  );
}

/**
 * `refused` is the captain's 421 (the handle or member is unknown to it); `not-captain` its 410.
 * A silent captain is not reported: a crashed one is found by the better-route tick.
 */
export type CaptainRouteFailure = "refused" | "not-captain";

/** A member's live session, as one better-route tick sees it. */
export interface BetterRouteTickSession {
  readonly onCaptainRoute: boolean;
  /** The server's config says it can join a mesh. */
  readonly meshMember: boolean;
}

export class MeshCaptain extends Context.Service<
  MeshCaptain,
  {
    readonly state: SubscriptionRef.SubscriptionRef<MeshCaptainState>;
    /** Each member's path through the captain. Empty off the mesh. */
    readonly paths: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, CaptainPath>>;
    /**
     * The client's live session to an environment, or none once it ended. Handles are minted only
     * over a live session to the captain, whose descriptor was checked when it connected.
     */
    readonly observeConnection: (
      environmentId: EnvironmentId,
      live: Option.Option<PreparedConnection>,
    ) => Effect.Effect<void>;
    /** Returns at once; the re-read (and re-mint) runs in the background. */
    readonly reportRouteFailure: (
      path: CaptainPath,
      reason: CaptainRouteFailure,
    ) => Effect.Effect<void>;
    /**
     * Called once per member per better-route tick. While a mesh member is off its captain
     * route, this reads the mesh at most once per tick for the whole client, which is how a
     * crashed captain's replacement is found without another timer.
     */
    readonly betterRouteTick: (
      environmentId: EnvironmentId,
      session: BetterRouteTickSession,
    ) => Effect.Effect<void>;
    readonly refresh: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/meshCaptain") {}

// Below the 60 s better-route interval, so every member's tick in one interval shares a read.
const TICK_READ_SPACING_MS = 50_000;
const UNLISTED_READ_SPACING_MS = 5 * 60_000;
const MINT_TIMEOUT = Duration.seconds(10);

type MintResult =
  | { readonly _tag: "Minted"; readonly via: MeshViaResponse }
  | { readonly _tag: "NotCaptain" }
  | { readonly _tag: "Failed" };

function pathsSignature(paths: ReadonlyMap<EnvironmentId, CaptainPath>): string {
  return [...paths]
    .map(([environmentId, path]) => `${environmentId} ${path.httpBaseUrl}`)
    .sort()
    .join("\n");
}

function sameSaved(left: SavedMeshCaptain | null, right: SavedMeshCaptain | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A saved captain from another Connect account never routes this one's connections. */
function savedFor(
  saved: SavedMeshCaptain | null,
  identity: Option.Option<ClientCapabilities.CloudSessionIdentity>,
): SavedMeshCaptain | null {
  return Option.isSome(identity) && saved?.accountId === identity.value.accountId ? saved : null;
}

/** An online member the captain could forward to but did not list when it minted the handle. */
const hasUnlistedMember = (mesh: RelayMeshResponse, saved: SavedMeshCaptain) =>
  mesh.members.some(
    (member) =>
      member.online &&
      member.connectHostname !== null &&
      member.environmentId !== saved.captain &&
      !saved.routes.includes(member.environmentId),
  );

/** The relay's member list as one comparable value. */
const meshMemberKey = (mesh: RelayMeshResponse): string =>
  mesh.members
    .map((member) => member.environmentId)
    .sort()
    .join(",");

/** Only a Connect session can mint a handle; a desktop on the captain machine uses a cookie. */
const mintAddress = (live: PreparedConnection | undefined): string | null =>
  live?.httpAuthorization?._tag === "Dpop" ? live.httpBaseUrl : null;

/** @public */
export const make = Effect.gen(function* () {
  const serviceScope = yield* Scope.Scope;
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const authorization = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const cloudSession = yield* ClientCapabilities.CloudSession;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const httpClient = yield* HttpClient.HttpClient;
  const store = yield* MeshCaptainStore;

  // An identity still loading hides the saved captain until `credentials-changed` restores it.
  const initial: MeshCaptainState = {
    mesh: null,
    saved: savedFor(Option.getOrNull(yield* store.load), yield* cloudSession.identity),
  };
  const state = yield* SubscriptionRef.make(initial);
  const paths = yield* SubscriptionRef.make(captainPaths(initial));
  const liveConnections = new Map<EnvironmentId, PreparedConnection>();
  const unlistedReads = new Map<EnvironmentId, { members: string; readAt: number }>();
  // An account reset cannot interleave with saving and publishing a read's result.
  const accountLock = yield* Semaphore.make(1);
  let accountGeneration = 0;
  // Set by a 421 or 410 on the saved handle's paths, so the next read mints instead of keeping it.
  let refusedHandle: string | null = null;
  const reads = yield* Ref.make<{
    readonly inFlight: Deferred.Deferred<void> | null;
    readonly lastReadAt: number | null;
  }>({ inFlight: null, lastReadAt: null });

  const publish = Effect.fn("MeshCaptain.publish")(function* (next: MeshCaptainState) {
    yield* SubscriptionRef.set(state, next);
    const nextPaths = captainPaths(next);
    if (pathsSignature(yield* SubscriptionRef.get(paths)) !== pathsSignature(nextPaths)) {
      yield* SubscriptionRef.set(paths, nextPaths);
    }
  });

  /** Saves a read's captain for the next cold start, then publishes it. */
  const commit = Effect.fn("MeshCaptain.commit")(function* (
    generation: number,
    next: MeshCaptainState,
  ) {
    if (generation !== accountGeneration) return;
    if (!sameSaved((yield* SubscriptionRef.get(state)).saved, next.saved)) {
      yield* store.save(Option.fromNullOr(next.saved));
    }
    yield* publish(next);
  }, accountLock.withPermit);

  /** Uses the captain session's Connect credential, so only Connect clients get a handle. */
  const mint = Effect.fn("MeshCaptain.mint")(function* (
    captain: EnvironmentId,
    address: string,
  ): Effect.fn.Return<MintResult> {
    const url = environmentEndpointUrl(address, MESH_VIA_PATH);
    const result = yield* Effect.gen(function* () {
      const authorized = yield* authorization.authorizeDpopHttp({ expectedEnvironmentId: captain });
      const accessToken = authorized.httpAuthorization.accessToken;
      const proof = yield* signer.createProof({ method: "POST", url, accessToken });
      const response = yield* httpClient.execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({ authorization: `DPoP ${accessToken}`, dpop: proof }),
        ),
      );
      if (response.status === MESH_VIA_NOT_CAPTAIN_STATUS) {
        return { _tag: "NotCaptain" } as const;
      }
      const via = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(MeshViaResponse)),
      );
      return { _tag: "Minted", via } as const;
    }).pipe(Effect.timeoutOption(MINT_TIMEOUT), Effect.result);
    if (result._tag === "Failure") {
      yield* Effect.logWarning("Could not mint a mesh captain handle.", {
        captain,
        error: result.failure,
      });
      return { _tag: "Failed" };
    }
    return Option.getOrElse(result.success, (): MintResult => ({ _tag: "Failed" }));
  });

  /** The next state, or null to keep the current one. */
  const read = Effect.fn("MeshCaptain.read")(function* (
    generation: number,
  ): Effect.fn.Return<MeshCaptainState | null> {
    const identity = yield* cloudSession.identity;
    // No identity yet may be a session still loading, so a saved captain stays until it resolves.
    if (generation !== accountGeneration || Option.isNone(identity)) return null;
    const accountId = identity.value.accountId;
    const current = yield* SubscriptionRef.get(state);
    let saved = current.saved?.accountId === accountId ? current.saved : null;
    const mesh = yield* cloudSession.clerkToken.pipe(
      Effect.flatMap((clerkToken) => relay.getMesh({ clerkToken })),
      Effect.tapError((error) => Effect.logWarning("Could not read the mesh.", { error })),
      Effect.option,
    );
    if (generation !== accountGeneration) return null;
    if (Option.isNone(mesh)) return { mesh: current.mesh, saved };
    const captain = mesh.value.available ? mesh.value.captain : null;
    const gateway =
      captain !== null &&
      mesh.value.members.some(
        (member) => member.environmentId === captain && member.capabilities.meshGateway === true,
      );
    if (captain === null || !gateway) return { mesh: mesh.value, saved: null };
    // A handle belongs to the captain that minted it.
    if (saved?.captain !== captain) saved = null;
    const refused = saved !== null && saved.handle === refusedHandle;
    // Never the saved address: nothing checked that it still answers as the captain.
    const address = mintAddress(liveConnections.get(captain));
    // A member that joined after the mint needs a new one to be listed. While the captain
    // cannot reach it, each read mints again, which the better-route tick spaces out.
    const unlisted = saved !== null && hasUnlistedMember(mesh.value, saved);
    if (address === null || (saved?.address === address && !refused && !unlisted)) {
      return { mesh: mesh.value, saved: refused ? null : saved };
    }
    const minted = yield* mint(captain, address);
    if (generation !== accountGeneration) return null;
    if (minted._tag === "Minted") {
      refusedHandle = null;
      saved = {
        accountId,
        captain,
        address,
        handle: minted.via.handle,
        routes: minted.via.routes,
      };
    } else if (minted._tag === "NotCaptain" || refused) {
      saved = null;
    }
    return { mesh: mesh.value, saved };
  });

  /**
   * Starts a read unless one is in flight (which it joins) or, with `spacingMs`, the last one is
   * that recent. Returns what to await, or null when skipped.
   */
  const startRead = Effect.fn("MeshCaptain.startRead")(function* (spacingMs: number | null) {
    const generation = accountGeneration;
    const now = yield* Clock.currentTimeMillis;
    const started = yield* Deferred.make<void>();
    const decision = yield* Ref.modify(reads, (current) => {
      if (current.inFlight !== null) return [current.inFlight, current] as const;
      if (
        spacingMs !== null &&
        current.lastReadAt !== null &&
        now - current.lastReadAt < spacingMs
      ) {
        return [null, current] as const;
      }
      return [started, { inFlight: started, lastReadAt: now }] as const;
    });
    if (decision === started) {
      // Cleared before the result is published, so a refresh by someone who saw the result
      // reads again instead of joining a finished read.
      const finish = Ref.update(reads, (current) =>
        current.inFlight === started ? { ...current, inFlight: null } : current,
      );
      // The read belongs to the service, so one caller's interruption cannot cancel it.
      yield* read(generation).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Mesh read failed.", { cause }).pipe(Effect.as(null)),
        ),
        Effect.tap((next) =>
          finish.pipe(Effect.andThen(next === null ? Effect.void : commit(generation, next))),
        ),
        Effect.ensuring(finish.pipe(Effect.andThen(Deferred.succeed(started, undefined)))),
        Effect.forkIn(serviceScope),
      );
    }
    return decision;
  }, accountLock.withPermit);

  const refreshWith = Effect.fn("MeshCaptain.refresh")(function* (spacingMs: number | null) {
    const pending = yield* startRead(spacingMs);
    if (pending !== null) yield* Deferred.await(pending);
  });

  const refreshInBackground = startRead(null).pipe(Effect.asVoid);

  const currentCaptain = (current: MeshCaptainState) =>
    current.mesh === null ? (current.saved?.captain ?? null) : current.mesh.captain;

  const observeConnection = Effect.fn("MeshCaptain.observeConnection")(function* (
    environmentId: EnvironmentId,
    live: Option.Option<PreparedConnection>,
  ) {
    if (Option.isNone(live)) {
      liveConnections.delete(environmentId);
      return;
    }
    liveConnections.set(environmentId, live.value);
    const current = yield* SubscriptionRef.get(state);
    const address = mintAddress(live.value);
    // The captain route follows the client's own route to the captain.
    if (
      environmentId === currentCaptain(current) &&
      address !== null &&
      address !== current.saved?.address
    ) {
      yield* refreshInBackground;
    }
  });

  const reportRouteFailure = Effect.fn("MeshCaptain.reportRouteFailure")(function* (
    path: CaptainPath,
    reason: CaptainRouteFailure,
  ) {
    yield* Effect.annotateCurrentSpan({ "mesh.route_failure": reason });
    const { saved } = yield* SubscriptionRef.get(state);
    if (saved?.captain !== path.captain) return;
    // A path from an older handle says nothing about the saved one.
    const published = [...(yield* SubscriptionRef.get(paths)).values()].some(
      (current) => current.httpBaseUrl === path.httpBaseUrl,
    );
    if (!published) return;
    refusedHandle = saved.handle;
    yield* refreshInBackground;
  });

  const betterRouteTick = Effect.fn("MeshCaptain.betterRouteTick")(function* (
    environmentId: EnvironmentId,
    session: BetterRouteTickSession,
  ) {
    if (session.onCaptainRoute) return;
    const { mesh, saved } = yield* SubscriptionRef.get(state);
    if (mesh === null || !mesh.available || environmentId === mesh.captain) return;
    // Reads go on with nothing saved and no live session to the cached captain: that captain may
    // have died during its offline grace, and only a read names its replacement. Minting still
    // needs a live session to the captain. A read that named no captain reads again too.
    const member = mesh.members.find((candidate) => candidate.environmentId === environmentId);
    if (member === undefined) {
      // A member that joined after the last read is listed, and gets a captain path, only by a
      // read. Servers outside this account's mesh also advertise `meshMember`, so space their
      // reads while still discovering later joins without another member causing a read.
      if (!session.meshMember) return;
      const members = meshMemberKey(mesh);
      const now = yield* Clock.currentTimeMillis;
      const previous = unlistedReads.get(environmentId);
      if (previous?.members === members && now - previous.readAt < UNLISTED_READ_SPACING_MS) return;
      unlistedReads.set(environmentId, { members, readAt: now });
    } else if (!member.online) {
      return;
    }
    yield* refreshWith(TICK_READ_SPACING_MS);
  });

  // Reads the store, not the state, so an identity that loaded after start restores its captain.
  // Never writes it: signing out and back in to the same account keeps the cold-start captain.
  const resetForAccount = Effect.fn("MeshCaptain.resetForAccount")(function* () {
    accountGeneration += 1;
    yield* Ref.set(reads, { inFlight: null, lastReadAt: null });
    unlistedReads.clear();
    refusedHandle = null;
    yield* publish({
      mesh: null,
      saved: savedFor(Option.getOrNull(yield* store.load), yield* cloudSession.identity),
    });
  }, accountLock.withPermit);

  // An account without the mesh reads again only when its credentials change or the Mesh
  // section opens (`refresh`), not on every foreground or network change.
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) =>
      reason === "credentials-changed"
        ? resetForAccount().pipe(Effect.andThen(refreshInBackground))
        : SubscriptionRef.get(state).pipe(
            Effect.flatMap(({ mesh }) =>
              mesh?.available === false ? Effect.void : refreshInBackground,
            ),
          ),
    ),
    Effect.forkScoped,
  );
  yield* refreshInBackground;

  return MeshCaptain.of({
    state,
    paths,
    observeConnection,
    reportRouteFailure,
    betterRouteTick,
    refresh: refreshWith(null),
  });
});

export const layer = Layer.effect(MeshCaptain, make);
