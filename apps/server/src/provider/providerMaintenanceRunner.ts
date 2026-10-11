import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeUtil from "node:util";

import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeTargetedProviderUpdateAction,
  resolveLatestProviderVersion,
  type ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_FORCE_KILL_AFTER = Duration.seconds(5);
const UPDATE_OUTPUT_MAX_BYTES = 10_000;
// Every progress publish resends the provider list to each client, so the
// installer's output is sampled rather than forwarded line by line.
const UPDATE_PROGRESS_INTERVAL = Duration.seconds(1);
const UPDATE_PROGRESS_MAX_LENGTH = 200;
// An installer may write for minutes without a line ending; only its tail matters.
const UPDATE_PARTIAL_LINE_MAX_LENGTH = 4_096;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
          readonly targetVersion?: string | undefined;
          /** Skips installer output progress, for background installs nobody watches. */
          readonly quiet?: boolean | undefined;
          /** Background installs require proven ownership and pin the checked release. */
          readonly origin?: ServerProviderUpdateState["origin"];
          /** Rechecks background eligibility after queued turns and installs have drained. */
          readonly beforeInstall?: Effect.Effect<boolean>;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("t3/provider/providerMaintenanceRunner") {}

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: NodeJS.ProcessEnv;
    readonly onProgress?: (line: string) => Effect.Effect<void>;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        // Resolve the executable for the host platform before spawning. On
        // Windows the update tools are batch shims (e.g. `npm` -> `npm.cmd`),
        // which a bare ChildProcess.spawn cannot launch (spawn npm ENOENT);
        // resolveSpawnCommand finds the real `.cmd` and routes it through the
        // shell. On Linux/macOS (incl. the WSL backend) this is a no-op.
        const resolved = yield* resolveSpawnCommand(input.command, input.args, {
          ...(input.env ? { env: input.env } : {}),
          extendEnv: true,
        });
        const child = yield* input.spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              shell: resolved.shell,
              // An installer that ignores SIGTERM must not hold up the update forever.
              forceKillAfter: UPDATE_FORCE_KILL_AFTER,
              ...(input.env ? { env: input.env, extendEnv: true } : {}),
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderMaintenanceCommandError({
                  message: `Failed to run update command ${input.command}: ${cause.message}`,
                  cause,
                }),
            ),
          );
        yield* Effect.addFinalizer(() =>
          child.kill({ forceKillAfter: UPDATE_FORCE_KILL_AFTER }).pipe(Effect.ignore),
        );

        // Holds the newest output line not yet reported; the sampler takes it.
        const pendingProgress = yield* Ref.make<string | null>(null);
        const onProgress = input.onProgress;
        if (onProgress) {
          yield* Ref.getAndSet(pendingProgress, null).pipe(
            Effect.flatMap((line) => (line === null ? Effect.void : onProgress(line))),
            Effect.repeat(Schedule.spaced(UPDATE_PROGRESS_INTERVAL)),
            Effect.forkScoped,
          );
        }
        const trackProgress = <E>(stream: Stream.Stream<Uint8Array, E>) => {
          if (!onProgress) {
            return stream;
          }
          const decoder = new TextDecoder();
          let partialLine = "";
          return stream.pipe(
            Stream.tap((chunk) => {
              const split = splitOutputLines(partialLine, decoder.decode(chunk, { stream: true }));
              partialLine = split.partialLine;
              // A progress bar that redraws with a leading `\r` keeps its newest
              // frame unterminated, so that frame is the latest status.
              const line =
                toProgressLine(split.partialLine) ??
                split.lines.map(toProgressLine).findLast((value) => value !== null);
              return line ? Ref.set(pendingProgress, line) : Effect.void;
            }),
          );
        };

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: trackProgress(child.stdout),
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: trackProgress(child.stderr),
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderMaintenanceCommandError({
                message: cause instanceof Error ? cause.message : "Update command failed to run.",
                cause,
              }),
          ),
        );

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          timedOut: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ProviderMaintenanceCommandResult;
      },
    );

    return yield* collectCommandResult().pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
      Effect.map((result) =>
        Option.match(result, {
          onSome: (value) => value,
          onNone: () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: null,
              timedOut: true,
              stdoutTruncated: false,
              stderrTruncated: false,
            }) satisfies ProviderMaintenanceCommandResult,
        }),
      ),
    );
  },
);

/**
 * Split a chunk of installer output into complete lines. `\r` ends a line too,
 * so a redrawn progress bar reports its latest frame.
 */
export function splitOutputLines(
  partialLine: string,
  text: string,
): { readonly lines: ReadonlyArray<string>; readonly partialLine: string } {
  const parts = (partialLine + text).split(/\r\n|\r|\n/);
  return { partialLine: (parts.pop() ?? "").slice(-UPDATE_PARTIAL_LINE_MAX_LENGTH), lines: parts };
}

/** Turn one raw output line into a short status message, or null if it has no text. */
export function toProgressLine(line: string): string | null {
  const text = NodeUtil.stripVTControlCharacters(line).replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return null;
  }
  return text.length <= UPDATE_PROGRESS_MAX_LENGTH
    ? text
    : `${text.slice(0, UPDATE_PROGRESS_MAX_LENGTH - 1)}…`;
}

/** `claude update` reads better in a status line than the full executable path. */
function describeCommand(command: ProviderMaintenanceCommandAction): string {
  const executable = command.executable.split(/[\\/]/).pop() || command.executable;
  return [executable, ...command.args].join(" ");
}

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return "Update timed out.";
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `Update command exited with code ${result.exitCode}.`;
  }
  return "Update command failed.";
}

function isOutdatedProvider(provider: ServerProvider | undefined): boolean {
  return provider?.versionAdvisory?.status === "behind_latest";
}

function isStillInstalled(provider: ServerProvider): boolean {
  return provider.installed;
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const manifestService = yield* ModelManifest.ModelManifest;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  const runMaintenanceCommand = (
    update: ProviderMaintenanceCommandAction,
    onProgress: (line: string) => Effect.Effect<void>,
  ) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command: update.executable,
      args: update.args,
      onProgress,
      ...(update.env ? { env: update.env } : {}),
    });
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "An update is already running for this provider.",
      }),
  });

  const resolveInstallationInstances = (
    provider: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    installationKey: string | undefined,
  ) =>
    providerRegistry.getProviders.pipe(
      Effect.flatMap((providers) =>
        Effect.forEach(providers, (candidate) =>
          candidate.instanceId === instanceId
            ? Effect.succeed(candidate.instanceId)
            : candidate.driver !== provider || !installationKey
              ? Effect.succeed(null)
              : providerRegistry
                  .getProviderMaintenanceCapabilitiesForInstance(
                    candidate.instanceId,
                    candidate.driver,
                  )
                  .pipe(
                    Effect.map((capabilities) =>
                      capabilities.update?.installationKey === installationKey
                        ? candidate.instanceId
                        : null,
                    ),
                  ),
        ),
      ),
      Effect.map((ids) => ids.filter((id) => id !== null)),
    );

  const refreshInstallationInstances = (
    provider: ProviderDriverKind,
    instanceIds: ReadonlyArray<ProviderInstanceId>,
    alreadyFresh?: ProviderInstanceId,
  ) =>
    Effect.forEach(
      instanceIds,
      (id) =>
        (id === alreadyFresh
          ? Effect.void
          : providerRegistry.getProviderMaintenanceCapabilitiesForInstance(id, provider, {
              fresh: true,
            })
        ).pipe(Effect.andThen(providerRegistry.refreshInstance(id))),
      { discard: true },
    );

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
    instanceIds: ReadonlyArray<ProviderInstanceId>,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    refreshInstallationInstances(provider, instanceIds, instanceId).pipe(
      Effect.andThen(providerRegistry.getProviders),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            ),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map((verifiedProviders): VerifiedProviderRefresh => ({
            providers,
            verifiedProviders,
          })),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const targetVersion = typeof target === "string" ? undefined : target.targetVersion;
    const quiet = typeof target !== "string" && target.quiet === true;
    const origin = typeof target === "string" ? "manual" : (target.origin ?? "manual");
    const background = origin === "background";
    const targetKey = `instance:${instanceId}`;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state: state === null ? null : { ...state, origin },
      });
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider update to finish.",
      }),
    ).pipe(Effect.asVoid);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        const finish = (state: ServerProviderUpdateState) =>
          setUpdateState(state).pipe(Effect.map((providers) => ({ providers })));
        const startedAtRef = yield* Ref.make<string | null>(null);

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* () {
            const startedAt = yield* nowIso;
            yield* Ref.set(startedAtRef, startedAt);
            const setRunningMessage = (message: string) =>
              setUpdateState(
                makeUpdateState({
                  status: "running",
                  startedAt,
                  finishedAt: null,
                  message,
                }),
              ).pipe(Effect.asVoid);
            yield* setRunningMessage("Checking for the latest version");

            // The cached capabilities chose the lock; re-derive ownership
            // now so the command that runs matches the executable as it is
            // at click time, not as it was at the last health refresh.
            const fresh = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
              instanceId,
              provider,
              { fresh: true },
            );
            if (
              !fresh.update ||
              fresh.update.lockKey !== update.lockKey ||
              (background &&
                (!fresh.update.installationKey ||
                  fresh.update.installationKey !== update.installationKey))
            ) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message: "Provider installation changed. Refresh and try again.",
                }),
              );
            }

            const manifest = yield* manifestService.current;
            const checkedTarget = targetVersion
              ? makeTargetedProviderUpdateAction(fresh, targetVersion)
              : null;
            if (background && !checkedTarget && fresh.packageName) {
              yield* latestVersions.invalidate(fresh.packageName);
            }
            const candidateVersion =
              (!background || checkedTarget !== null ? targetVersion : undefined) ??
              (yield* resolveLatestProviderVersion(fresh).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                  ProviderLatestVersions.ProviderLatestVersions,
                  latestVersions,
                ),
              ));
            const advisory =
              resolveProviderCompatibility(manifest.compatibility, provider, candidateVersion) ??
              resolveProviderCompatibility(
                ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
                provider,
                candidateVersion,
              );
            if (background) {
              // Re-probe under the install lock: a manual/external update may have won the race.
              const current = (yield* providerRegistry.refreshInstance(instanceId)).find(
                (candidate) => candidate.instanceId === instanceId,
              );
              if (
                !current?.enabled ||
                !current.installed ||
                !current.version ||
                !candidateVersion ||
                !parseSemver(current.version) ||
                !parseSemver(candidateVersion) ||
                (fresh.compareVersions ?? compareSemverVersions)(
                  current.version,
                  candidateVersion,
                ) >= 0
              ) {
                return yield* finish(
                  makeUpdateState({
                    status: "unchanged",
                    startedAt,
                    finishedAt: yield* nowIso,
                    message: "No newer provider version is available.",
                  }),
                );
              }
            }
            const pinnedCommand = candidateVersion
              ? makeTargetedProviderUpdateAction(fresh, candidateVersion)
              : null;
            const command = background
              ? (pinnedCommand ??
                (fresh.packageName === null ||
                fresh.latestVersion !== undefined ||
                fresh.update.lockKey.endsWith("-native")
                  ? fresh.update
                  : null))
              : targetVersion !== undefined
                ? makeTargetedProviderUpdateAction(fresh, targetVersion)
                : fresh.update;
            const rejected =
              !background && targetVersion !== undefined
                ? !command ||
                  advisory?.recommendedVersion !== targetVersion ||
                  advisory.status !== "supported"
                : advisory?.status === "broken" || advisory?.status === "unsupported";
            if (rejected || !command) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message:
                    targetVersion !== undefined
                      ? "This version is no longer recommended or this installer cannot install a specific version. Refresh provider settings."
                      : "The latest provider version is incompatible with this T3 Code release. Review provider settings.",
                }),
              );
            }
            const affectedInstances = yield* resolveInstallationInstances(
              provider,
              instanceId,
              fresh.update.installationKey,
            );
            if (
              background &&
              typeof target !== "string" &&
              target.beforeInstall &&
              !(yield* target.beforeInstall)
            ) {
              return yield* finish(
                makeUpdateState({
                  status: "unchanged",
                  startedAt: null,
                  finishedAt: yield* nowIso,
                  message: "Background update postponed until the update window opens.",
                }),
              );
            }
            yield* setRunningMessage(`Running ${describeCommand(command)}`);
            const result = yield* runMaintenanceCommand(
              command,
              quiet ? () => Effect.void : setRunningMessage,
            );
            const finishedAt = yield* nowIso;
            if (result.timedOut || result.exitCode !== 0) {
              yield* refreshInstallationInstances(provider, affectedInstances);
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt,
                  message: failureMessage(result),
                  output: commandOutput(result),
                }),
              );
            }

            yield* setRunningMessage("Verifying the installed version");
            // Homebrew's "latest" moves once the upgrade lands; read it again.
            const verified = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
              instanceId,
              provider,
              { fresh: true },
            );
            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              verified,
              instanceId,
              affectedInstances,
            );
            // "Succeeded" needs the provider to still be installed: an
            // installer that exits 0 and leaves the binary missing is not a
            // success. A missing version alone is not held against it, since
            // Cursor's `about` probe can fail transiently on a healthy binary.
            const couldNotVerify =
              verifiedProviders.length === 0 ||
              verifiedProviders.some(
                (verifiedProvider) =>
                  !isStillInstalled(verifiedProvider) ||
                  (background &&
                    (!verifiedProvider.version ||
                      !candidateVersion ||
                      (verified.compareVersions ?? compareSemverVersions)(
                        verifiedProvider.version,
                        candidateVersion,
                      ) < 0)) ||
                  (((!background && targetVersion !== undefined) ||
                    (background && pinnedCommand !== null)) &&
                    verifiedProvider.version?.replace(/^v/, "") !== candidateVersion),
              );
            const stillOutdated =
              targetVersion === undefined &&
              verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));
            return yield* finish(
              makeUpdateState({
                status: couldNotVerify || stillOutdated ? "unchanged" : "succeeded",
                startedAt,
                finishedAt,
                message: couldNotVerify
                  ? "Update command completed, but T3 Code could not verify the provider version."
                  : stillOutdated
                    ? "Update command completed, but T3 Code still detects an outdated provider version."
                    : "Provider updated.",
                output: commandOutput(result),
              }),
            );
          },
        );

        const recordFailedUpdate = Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(
          function* (cause: Cause.Cause<unknown>) {
            const failure = Cause.squash(cause);
            const startedAt = yield* Ref.get(startedAtRef);
            return yield* finish(
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: yield* nowIso,
                message: failure instanceof Error ? failure.message : "Update command failed.",
                output: null,
              }),
            );
          },
        );

        return yield* runCommandAndVerify().pipe(Effect.catchCause(recordFailedUpdate));
      },
    );

    return yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        onWaitingForTurns: setUpdateState(
          makeUpdateState({
            status: "queued",
            startedAt: null,
            finishedAt: null,
            message: "Waiting for running turns to finish.",
          }),
        ).pipe(Effect.asVoid),
        onFailure: (cause) =>
          Effect.gen(function* () {
            const current = (yield* providerRegistry.getProviders).find(
              (candidate) => candidate.instanceId === instanceId,
            );
            // A state left queued or running would block background updates until restart.
            const status = current?.updateState?.status;
            if (status !== "queued" && status !== "running") return;
            const failure = Cause.squash(cause);
            yield* setUpdateState(
              makeUpdateState({
                status: "failed",
                startedAt: current?.updateState?.startedAt ?? null,
                finishedAt: yield* nowIso,
                message: !Cause.hasInterrupts(cause)
                  ? failure instanceof Error
                    ? failure.message
                    : "Could not acquire the provider installation lock."
                  : status === "queued"
                    ? "Update canceled before installation started."
                    : "Update canceled.",
              }),
            );
          }),
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );
  });

  return ProviderMaintenanceRunner.of({
    updateProvider,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());
