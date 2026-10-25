import type { EnvironmentId, MeshRoute, MeshSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as MeshServices from "./Services.ts";

/**
 * In-memory MeshMembership. `setSnapshot` publishes to `snapshots`; `setPin` writes the pin into
 * the current snapshot and picks no captain. Grants default to `mesh-test-grant:<target>`.
 */
export const makeMembership = Effect.fn("MeshTestkit.makeMembership")(function* (
  options: {
    readonly snapshot?: MeshSnapshot;
    readonly enabled?: boolean;
    readonly requestGrant?: MeshServices.MeshMembership["Service"]["requestGrant"];
  } = {},
) {
  const snapshotRef = yield* SubscriptionRef.make<MeshSnapshot | null>(options.snapshot ?? null);
  const enabledRef = yield* SubscriptionRef.make(options.enabled ?? true);

  const selfRole = Effect.gen(function* () {
    const snapshot = yield* SubscriptionRef.get(snapshotRef);
    if (!(yield* SubscriptionRef.get(enabledRef)) || snapshot === null) return "off" as const;
    return snapshot.captain === snapshot.selfEnvironmentId ? ("captain" as const) : "member";
  });

  const service = MeshServices.MeshMembership.of({
    snapshot: SubscriptionRef.get(snapshotRef).pipe(Effect.map(Option.fromNullishOr)),
    snapshots: SubscriptionRef.changes(snapshotRef).pipe(
      Stream.filterMap((snapshot) =>
        snapshot === null ? Result.failVoid : Result.succeed(snapshot),
      ),
    ),
    status: Effect.gen(function* () {
      const snapshot = yield* SubscriptionRef.get(snapshotRef);
      const enabled = yield* SubscriptionRef.get(enabledRef);
      return {
        enabled,
        selfRole: yield* selfRole,
        ...(!enabled
          ? { unavailableReason: "disabled" as const }
          : snapshot === null
            ? { unavailableReason: "connecting" as const }
            : {}),
        captain: snapshot?.captain ?? null,
        pin: snapshot?.pin ?? null,
        members: snapshot?.members ?? [],
      };
    }),
    selfRole,
    isEnabled: SubscriptionRef.get(enabledRef),
    setEnabled: (enabled) => SubscriptionRef.set(enabledRef, enabled),
    setPin: Effect.fn("MeshTestkit.setPin")(function* (environmentId) {
      const snapshot = yield* SubscriptionRef.get(snapshotRef);
      if (snapshot === null) {
        return yield* new MeshServices.MeshUnavailableError({ reason: "connecting" });
      }
      yield* SubscriptionRef.set(snapshotRef, { ...snapshot, pin: environmentId });
    }),
    requestGrant:
      options.requestGrant ??
      (({ targetEnvironmentId }) => Effect.succeed(`mesh-test-grant:${targetEnvironmentId}`)),
  });

  return {
    service,
    layer: Layer.succeed(MeshServices.MeshMembership, service),
    setSnapshot: (snapshot: MeshSnapshot | null) => SubscriptionRef.set(snapshotRef, snapshot),
  };
});

/** A session with a static token and headers that name the target. No real DPoP. */
export const testSession = (
  environmentId: EnvironmentId,
  route: MeshRoute = { kind: "lan", httpBaseUrl: `http://${environmentId}.mesh.test` },
): MeshServices.MeshSession => ({
  environmentId,
  token: `mesh-test:${environmentId}`,
  expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
  route,
  connectUrl: null,
  authorizationHeaders: ({ method, url }) =>
    Effect.succeed({
      authorization: `DPoP mesh-test:${environmentId}`,
      dpop: `mesh-test-proof:${method}:${url}`,
    }),
});

/**
 * MeshCredentials from `handlers`. Sessions and routes default to a {@link testSession} for any
 * member; dropping one does nothing.
 */
export const layerCredentials = (handlers: Partial<MeshServices.MeshCredentials["Service"]> = {}) =>
  Layer.succeed(
    MeshServices.MeshCredentials,
    MeshServices.MeshCredentials.of({
      session: (environmentId) => Effect.succeed(testSession(environmentId)),
      route: (environmentId) => Effect.succeed(testSession(environmentId).route),
      cachedRoute: () => Effect.succeedNone,
      invalidate: () => Effect.void,
      forgetRoute: () => Effect.void,
      cachedSessions: Effect.succeed([]),
      ...handlers,
    }),
  );

/** MeshMcpClient that dispatches every call to `callTool`. */
export const layerMcpClient = (callTool: MeshServices.MeshMcpClient["Service"]["callTool"]) =>
  Layer.succeed(MeshServices.MeshMcpClient, MeshServices.MeshMcpClient.of({ callTool }));
