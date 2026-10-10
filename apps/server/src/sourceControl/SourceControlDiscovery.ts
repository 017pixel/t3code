import {
  type SourceControlDiscoveryResult,
  type VcsDiscoveryItem,
  type VcsDriverKind,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { detailFromCause, firstNonEmptyLine } from "@t3tools/source-control-core/server/discovery";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

interface DiscoveryProbe {
  readonly label: string;
  readonly executable?: string;
  readonly versionArgs?: ReadonlyArray<string>;
  readonly implemented: boolean;
  readonly installHint: string;
}

type VcsProbe = DiscoveryProbe & {
  readonly kind: VcsDriverKind;
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
};

interface DiscoveryProbeResult<Kind extends string> {
  readonly kind: Kind;
  readonly label: string;
  readonly executable?: string;
  readonly implemented: boolean;
  readonly status: "available" | "missing";
  readonly version: Option.Option<string>;
  readonly installHint: string;
  readonly detail: Option.Option<string>;
}

const DISCOVERY_TTL_MS = 60_000;

const VCS_PROBES: ReadonlyArray<VcsProbe> = [
  {
    kind: "git",
    label: "Git",
    executable: "git",
    versionArgs: ["--version"],
    implemented: true,
    installHint: "Install Git from https://git-scm.com/downloads or with your package manager.",
  },
  {
    kind: "jj",
    label: "Jujutsu",
    executable: "jj",
    versionArgs: ["--version"],
    implemented: false,
    installHint: "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
  },
];

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  {
    readonly discover: Effect.Effect<SourceControlDiscoveryResult>;
    readonly refresh: Effect.Effect<SourceControlDiscoveryResult>;
  }
>()("t3/sourceControl/SourceControlDiscovery") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const process = yield* VcsProcess.VcsProcess;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const probe = <Kind extends VcsDriverKind>(
    input: DiscoveryProbe & { readonly kind: Kind },
  ): Effect.Effect<DiscoveryProbeResult<Kind>> => {
    const executable = input.executable;
    const versionArgs = input.versionArgs;

    if (!executable || !versionArgs) {
      return Effect.succeed({
        kind: input.kind,
        label: input.label,
        implemented: input.implemented,
        status: "missing" as const,
        version: Option.none<string>(),
        installHint: input.installHint,
        detail: Option.some(input.installHint),
      } satisfies DiscoveryProbeResult<Kind>);
    }

    return process
      .run({
        operation: "source-control.discovery.probe",
        command: executable,
        args: versionArgs,
        cwd: config.cwd,
        timeoutMs: 5_000,
        maxOutputBytes: 8_000,
        appendTruncationMarker: true,
      })
      .pipe(
        Effect.map(
          (result) =>
            ({
              kind: input.kind,
              label: input.label,
              executable,
              implemented: input.implemented,
              status: "available" as const,
              version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
                firstNonEmptyLine(result.stderr),
              ),
              installHint: input.installHint,
              detail: Option.none<string>(),
            }) satisfies DiscoveryProbeResult<Kind>,
        ),
        Effect.catch((cause) =>
          Effect.succeed({
            kind: input.kind,
            label: input.label,
            executable,
            implemented: input.implemented,
            status: "missing" as const,
            version: Option.none<string>(),
            installHint: input.installHint,
            detail: detailFromCause(cause),
          } satisfies DiscoveryProbeResult<Kind>),
        ),
      );
  };

  const discoverNow = Effect.all({
    versionControlSystems: Effect.all(
      VCS_PROBES.map((entry) => probe(entry)) as ReadonlyArray<Effect.Effect<VcsDiscoveryItem>>,
      { concurrency: "unbounded" },
    ),
    sourceControlProviders: sourceControlProviders.discover,
  });
  // Discovery spawns a process per tool, so callers within a minute share one run. A refresh
  // or a settings change (credentials are saved through settings) starts a new run for every
  // later caller, rather than joining one that began before the change.
  const scope = yield* Effect.scope;
  let latest:
    | {
        readonly startedAt: number;
        readonly result: Deferred.Deferred<SourceControlDiscoveryResult>;
      }
    | undefined;
  const run = (fresh: boolean) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { result, started } = yield* Effect.sync(() => {
        if (!fresh && latest !== undefined && now - latest.startedAt < DISCOVERY_TTL_MS) {
          return { result: latest.result, started: false };
        }
        const result = Deferred.makeUnsafe<SourceControlDiscoveryResult>();
        latest = { startedAt: now, result };
        return { result, started: true };
      });
      if (started) yield* discoverNow.pipe(Deferred.into(result), Effect.forkIn(scope));
      return yield* Deferred.await(result);
    });
  const settingsChanges = yield* (yield* ServerSettings.ServerSettingsService).subscribeChanges;
  yield* settingsChanges.pipe(
    Stream.runForEach(() =>
      Effect.sync(() => {
        latest = undefined;
      }),
    ),
    Effect.forkIn(scope),
  );
  return SourceControlDiscovery.of({ discover: run(false), refresh: run(true) });
});

export const layer = Layer.effect(SourceControlDiscovery, make);
