// EXPERIMENTAL mesh v1: handlers for the guarded `mesh.*` RPCs. Scopes are checked by the group
// middleware (status needs orchestration:read, the mutations settings:write).
import {
  type EnvironmentId,
  type MeshCachedSession,
  MeshRpcError,
  type MeshStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MeshCredentials, MeshMembership } from "./Services.ts";

export const makeMeshRpcHandlers = Effect.gen(function* () {
  const membership = yield* MeshMembership;
  const credentials = yield* MeshCredentials;

  return {
    /** Cached state only: reading status never asks the relay or opens a session. */
    status: Effect.zipWith(
      membership.status,
      credentials.cachedSessions,
      (status, sessions): MeshStatus => ({
        ...status,
        sessions: sessions satisfies ReadonlyArray<MeshCachedSession>,
      }),
    ),
    setEnabled: (input: { readonly enabled: boolean }) => membership.setEnabled(input.enabled),
    setPin: Effect.fn("MeshRpc.setPin")(function* (input: {
      readonly environmentId: EnvironmentId | null;
    }) {
      const snapshot = yield* membership.snapshot;
      if (
        input.environmentId !== null &&
        Option.isSome(snapshot) &&
        !snapshot.value.members.some((member) => member.environmentId === input.environmentId)
      ) {
        return yield* new MeshRpcError({ reason: "unknown-member" });
      }
      yield* membership.setPin(input.environmentId).pipe(
        Effect.catchTags({
          MeshUnavailableError: (error) => Effect.fail(new MeshRpcError({ reason: error.reason })),
        }),
      );
    }),
  };
});
