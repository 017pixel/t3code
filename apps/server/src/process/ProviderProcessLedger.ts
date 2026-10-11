import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import * as OwnedProcesses from "./ownedProcesses.ts";
export type { ProcessController } from "./ownedProcesses.ts";

/** One instance's local children only. External servers, launchers and install supervisors never register. */
export const make = Effect.fn("ProviderProcessLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
  readonly controller?: OwnedProcesses.ProcessController;
  readonly installLeaseDirectory?: string;
}) {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const hostname = yield* HostProcess.Hostname;
  const ledger = yield* Effect.acquireRelease(
    Effect.promise(() =>
      OwnedProcesses.make({ ...input, registerServer: true, platform, environment, hostname }),
    ),
    (ledger) => Effect.sync(ledger.release),
  );
  // Registration records the PID immediately; one shared sampler discovers descendants.
  yield* Effect.forever(
    Effect.sleep("30 seconds").pipe(
      Effect.andThen(
        Effect.tryPromise(ledger.refresh).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not record provider descendants", { cause }),
          ),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);
  // Leave surviving entries for the next startup. A graceful provider stop makes refresh remove them.
  yield* Effect.addFinalizer(() => Effect.tryPromise(ledger.refresh).pipe(Effect.ignore));
  return { track: (pid: number) => Effect.promise(() => ledger.track(pid)) };
});
