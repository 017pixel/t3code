import * as Maintenance from "@t3tools/provider-core/server/maintenance";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as HostLock from "./ProviderMaintenanceHostLock.ts";

export { ProviderMaintenanceAdmission } from "@t3tools/provider-core/server/maintenance";

export interface ProviderMaintenanceCommandCoordinatorShape<E> {
  readonly withCommandLock: <A, R>(input: {
    readonly targetKey: string;
    readonly lockKey: string;
    readonly onQueued?: Effect.Effect<void, E, R>;
    readonly onInterrupted?: Effect.Effect<void, E, R>;
    readonly run: Effect.Effect<A, E, R>;
  }) => Effect.Effect<A, E, R>;
}

export const makeProviderMaintenanceCommandCoordinator = Effect.fn(
  "makeProviderMaintenanceCommandCoordinator",
)(function* <E>(input: { readonly makeAlreadyRunningError: (targetKey: string) => E }) {
  const admission = yield* Maintenance.ProviderMaintenanceAdmission;
  const runningTargetsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const locks = yield* KeyedLock.make<string>();
  const hostLock = yield* HostLock.ProviderMaintenanceHostLock;

  const acquireTarget = Effect.fn("acquireTarget")(function* (targetKey: string) {
    return yield* Ref.modify(runningTargetsRef, (runningTargets) => {
      if (runningTargets.has(targetKey)) {
        return [false, runningTargets] as const;
      }
      const next = new Set(runningTargets);
      next.add(targetKey);
      return [true, next] as const;
    });
  });

  const releaseTarget = (targetKey: string) =>
    Ref.update(runningTargetsRef, (runningTargets) => {
      const next = new Set(runningTargets);
      next.delete(targetKey);
      return next;
    });

  const withCommandLock: ProviderMaintenanceCommandCoordinatorShape<E>["withCommandLock"] = ({
    targetKey,
    lockKey,
    onQueued,
    onInterrupted,
    run,
  }) =>
    Effect.gen(function* () {
      const acquired = yield* acquireTarget(targetKey);
      if (!acquired) {
        return yield* Effect.fail(input.makeAlreadyRunningError(targetKey));
      }

      return yield* (onQueued ?? Effect.void).pipe(
        // Host leases drain before admission closes: a session holding a lease
        // may still need admission to finish launching its CLI.
        Effect.andThen(locks.withLock(lockKey, hostLock.withWrite(admission.withPermit(run)))),
        Effect.onInterrupt(() => onInterrupted ?? Effect.void),
        Effect.ensuring(releaseTarget(targetKey)),
      );
    });

  return {
    withCommandLock,
  } satisfies ProviderMaintenanceCommandCoordinatorShape<E>;
});
