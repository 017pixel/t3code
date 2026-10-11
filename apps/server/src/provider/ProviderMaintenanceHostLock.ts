// @effect-diagnostics nodeBuiltinImport:off - Host leases coordinate independent Node servers.
// oxlint-disable t3code/no-global-process-runtime -- Leases belong to the OS user and process, not an environment.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Semaphore from "effect/Semaphore";
import * as Maintenance from "@t3tools/provider-core/server/maintenance";

const HeldWrite = Context.Reference<{ readonly owner: object; active: boolean } | null>(
  "t3/provider/ProviderMaintenanceHostLock/HeldWrite",
  { defaultValue: () => null },
);

// Linux exposes a process start identity, so recycled PIDs cannot pin a dead reader.
const processIdentity = (pid: number) => {
  if (NodeOS.platform() !== "linux") return null;
  const fields = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
  return fields[0] === "Z" ? "" : fields[19]!;
};

/**
 * One user-wide reader/writer gate, deliberately covering every CLI: package
 * managers can replace several providers in one installation. Readers overlap;
 * an installer closes admission before waiting for active turns to drain.
 */
export const make = (directory: string) => {
  const owner = {};
  const readers = NodePath.join(directory, "readers");
  const prepare = Effect.sync(() => NodeFS.mkdirSync(readers, { recursive: true }));
  const acquireGate = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* prepare;
      const compromised = yield* Deferred.make<never>();
      const services = yield* Effect.context<never>();
      while (true) {
        const result = yield* Effect.tryPromise(() =>
          lock(NodePath.join(directory, "gate"), {
            realpath: false,
            stale: 120_000,
            update: 10_000,
            onCompromised: (error) =>
              Effect.runSyncWith(services)(Deferred.die(compromised, error)),
          }),
        ).pipe(Effect.result);
        if (result._tag === "Success") return { release: result.success, compromised };
        const cause = result.failure.cause;
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ELOCKED") {
          return yield* Effect.die(cause);
        }
        yield* Effect.interruptible(restore(Effect.sleep("100 millis")));
      }
    }),
  );
  const withGate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquireGate,
      ({ compromised }) => Effect.raceFirst(effect, Deferred.await(compromised)),
      ({ release }) => Effect.promise(() => release()),
    );

  const readPermit = Semaphore.makeUnsafe(1);
  let readCount = 0;
  let readFile: string | undefined;
  const registerRead = Effect.sync(() => {
    const file = NodePath.join(readers, `${process.pid}-${NodeCrypto.randomUUID()}`);
    NodeFS.writeFileSync(file, processIdentity(process.pid) ?? "", { flag: "wx" });
    return file;
  });
  // A provider can launch helper CLIs while its turn holds a read lease.
  // Joining that lease must not wait behind an installer draining this turn.
  const acquireRead = Effect.flatMap(HeldWrite, (held) =>
    held?.owner === owner && held.active
      ? // A scoped verification can outlive the install. Its own reader remains
        // visible to the next writer without admitting unrelated launches here.
        registerRead.pipe(
          Effect.map((file) => Effect.sync(() => NodeFS.rmSync(file, { force: true }))),
        )
      : Effect.acquireUseRelease(
          Effect.interruptible(readPermit.take(1)),
          () =>
            Effect.uninterruptible(
              Effect.gen(function* () {
                if (readCount === 0) {
                  readFile = yield* withGate(registerRead);
                }
                readCount++;
                let released = false;
                return readPermit.withPermits(1)(
                  Effect.sync(() => {
                    if (released) return;
                    released = true;
                    if (--readCount === 0 && readFile !== undefined) {
                      NodeFS.rmSync(readFile, { force: true });
                      readFile = undefined;
                    }
                  }),
                );
              }),
            ),
          () => Effect.asVoid(readPermit.release(1)),
        ),
  );
  const withRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquireRead,
      () => effect,
      (release) => release,
    );
  const drained = Effect.sync(() => {
    let busy = false;
    for (const file of NodeFS.readdirSync(readers)) {
      const pid = Number(file.split("-")[0]);
      try {
        process.kill(pid, 0);
        const identity = processIdentity(pid);
        if (
          identity !== null &&
          identity !== NodeFS.readFileSync(NodePath.join(readers, file), "utf8")
        ) {
          NodeFS.rmSync(NodePath.join(readers, file), { force: true });
        } else {
          busy = true;
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "ESRCH" && error.code !== "ENOENT")
        ) {
          throw error;
        }
        NodeFS.rmSync(NodePath.join(readers, file), { force: true });
      }
    }
    return !busy;
  });
  /** `onBusy` runs once if active turns or CLI calls, here or on another server, must drain first. */
  const withWrite = <A, E, R, E2 = never, R2 = never>(
    effect: Effect.Effect<A, E, R>,
    onBusy?: Effect.Effect<void, E2, R2>,
  ) =>
    withGate(
      Effect.gen(function* () {
        if (!(yield* drained)) {
          if (onBusy) yield* onBusy;
          while (!(yield* drained)) yield* Effect.sleep("100 millis");
        }
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => ({ owner, active: true })),
          (token) => effect.pipe(Effect.provideService(HeldWrite, token)),
          (token) =>
            Effect.sync(() => {
              token.active = false;
            }),
        );
      }),
    );
  return { directory, acquireRead, withRead, withWrite };
};

/** Every T3 server on the host shares the user's provider CLIs, so servers share one gate. */
export const userDirectory = () =>
  NodePath.join(
    process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache"),
    "t3",
    "provider-maintenance",
  );

/**
 * Servers provide the user-wide gate through `layer`. Anything else, such as a
 * test, gets a private gate so it never waits on or blocks a live T3.
 */
export class ProviderMaintenanceHostLock extends Context.Reference<ReturnType<typeof make>>(
  "t3/provider/ProviderMaintenanceHostLock",
  {
    defaultValue: () => {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-maintenance-"),
      );
      process.once("exit", () => NodeFS.rmSync(directory, { recursive: true, force: true }));
      return make(directory);
    },
  },
) {}

export const layer = Layer.effectContext(
  Effect.sync(() => {
    const host = make(userDirectory());
    const admission = Maintenance.ProviderMaintenanceAdmission.defaultValue();
    return Context.make(ProviderMaintenanceHostLock, host).pipe(
      Context.add(Maintenance.ProviderMaintenanceAdmission, {
        // Taking the host lease first prevents a probe nested in an update
        // window from waiting behind a writer that needs local admission.
        withPermit: (effect) => host.withRead(admission.withPermit(effect)),
        withLaunchPermit: (effect) => host.withRead(admission.withLaunchPermit(effect)),
        withScopedLaunchPermit: (effect) =>
          Effect.acquireRelease(host.acquireRead, (release) => release, {
            interruptible: true,
          }).pipe(Effect.andThen(admission.withScopedLaunchPermit(effect))),
      }),
    );
  }),
);
