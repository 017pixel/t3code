import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

interface AdmissionLease {
  readonly owner: object;
  readonly permits: number;
  users: number;
}
interface AdmissionToken {
  readonly lease: AdmissionLease;
  active: boolean;
}
const HeldAdmission = Context.Reference<AdmissionToken | null>(
  "@t3tools/provider-core/server/maintenance/HeldAdmission",
  { defaultValue: () => null },
);
const INSTALL_PERMITS = Number.MAX_SAFE_INTEGER;

/**
 * Installs exclude CLI launches; launches share admission with each other.
 * Work already holding admission, such as an install's verification, reenters it.
 */
export class ProviderMaintenanceAdmission extends Context.Reference<{
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly withLaunchPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly withScopedLaunchPermit: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R | Scope.Scope>;
}>("t3/provider/providerMaintenanceCommandCoordinator/ProviderMaintenanceAdmission", {
  defaultValue: () => {
    const semaphore = Semaphore.makeUnsafe(INSTALL_PERMITS);
    const owner = {};
    const take = (permits: number) =>
      Effect.flatMap(HeldAdmission, (inherited) => {
        if (inherited?.lease.owner === owner && inherited.active) {
          inherited.lease.users++;
          return Effect.succeed({ lease: inherited.lease, active: true });
        }
        return semaphore.take(permits).pipe(
          Effect.map(() => ({
            lease: { owner, permits, users: 1 },
            active: true,
          })),
        );
      });
    const release = (token: AdmissionToken) =>
      Effect.suspend(() => {
        token.active = false;
        token.lease.users--;
        return token.lease.users === 0
          ? Effect.asVoid(semaphore.release(token.lease.permits))
          : Effect.void;
      });
    const withPermits =
      (permits: number) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.acquireUseRelease(
            restore(take(permits)),
            (token) => restore(effect.pipe(Effect.provideService(HeldAdmission, token))),
            release,
          ),
        );
    return {
      withPermit: withPermits(INSTALL_PERMITS),
      withLaunchPermit: withPermits(1),
      withScopedLaunchPermit: (effect) =>
        Effect.acquireRelease(take(1), release, { interruptible: true }).pipe(
          Effect.flatMap((token) => effect.pipe(Effect.provideService(HeldAdmission, token))),
        ),
    };
  },
}) {}

export interface ProviderMaintenanceCapabilities {
  readonly provider: ProviderDriverKind;
  readonly packageName: string | null;
  readonly update: ProviderMaintenanceCommandAction | null;
  /**
   * Latest version reported by the installer that owns the executable.
   * `undefined` means the installer has no channel of its own and the npm
   * registry entry for `packageName` is authoritative; `null` means the
   * installer was asked and did not know.
   */
  readonly latestVersion?: string | null;
  /** Compare native release revisions when the provider does not use plain semver. */
  readonly compareVersions?: (current: string, latest: string) => number;
}

export interface ProviderMaintenanceCommandAction {
  readonly command: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly lockKey: string;
  /** Stable identity of an install whose updater ownership is proven. Absent for manual fallbacks. */
  readonly installationKey?: string | undefined;
  /**
   * Extra environment for the spawned updater, on top of the server's own.
   * A native updater finds its install through the same variables the
   * provider runs with (e.g. `CODEX_HOME`), so an instance with a custom home
   * must update that home and not the default one.
   */
  readonly env?: NodeJS.ProcessEnv;
}
