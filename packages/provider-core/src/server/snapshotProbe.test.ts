import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Maintenance from "./maintenance.ts";
import { describe, expect, it } from "@effect/vitest";
import type { ModelCapabilities } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./snapshotProbe.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });

  it("keeps an entry's own name and capabilities over the driver default", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const models = providerModelsFromSettings(
      [],
      ["bare", { slug: "named", name: "Named", capabilities }],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "bare",
        name: "bare",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
      { slug: "named", name: "Named", isCustom: true, capabilities },
    ]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });
});

describe("parseGenericCliVersion", () => {
  it("parses a bare version", () => {
    expect(parseGenericCliVersion("1.14.19")).toBe("1.14.19");
  });

  it("parses a v-prefixed version", () => {
    expect(parseGenericCliVersion("opencode v2.0.3")).toBe("2.0.3");
    expect(parseGenericCliVersion("v22.19.0")).toBe("22.19.0");
  });

  it("parses a version embedded in other output", () => {
    expect(parseGenericCliVersion("codex-cli 0.53.0 (build abc)")).toBe("0.53.0");
  });

  it("returns null when no version is present", () => {
    expect(parseGenericCliVersion("no version here")).toBeNull();
  });

  it("ignores versions glued to other word characters", () => {
    expect(parseGenericCliVersion("build2.0.3artifact")).toBeNull();
  });
});

describe("ProviderCommandNotFoundError", () => {
  it("classifies normalized platform failures without parsing messages", () => {
    expect(
      isCommandMissingCause(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "arbitrary host detail",
        }),
      ),
    ).toBe(true);
    expect(isCommandMissingCause(new Error("spawn provider ENOENT"))).toBe(false);
  });

  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9009)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
      ).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });
});

describe("provider maintenance admission", () => {
  it.effect("keeps CLI probes behind an install and permits its verification", () =>
    Effect.gen(function* () {
      const admission = yield* Maintenance.ProviderMaintenanceAdmission;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let launches = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          launches++;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const probe = spawnAndCollect("codex", ChildProcess.make("codex", ["--version"])).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const install = yield* admission
        .withPermit(
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            yield* probe;
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const waiting = yield* probe.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(launches).toBe(0);
      expect(waiting.pollUnsafe() === undefined).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(install);
      yield* Fiber.join(waiting);
      expect(launches).toBe(2);
    }),
  );

  it.effect("revokes inherited verification admission when the holder exits", () =>
    Effect.gen(function* () {
      const admission = yield* Maintenance.ProviderMaintenanceAdmission;
      const proceed = yield* Deferred.make<void>();
      const child = yield* admission.withPermit(
        Deferred.await(proceed).pipe(
          Effect.andThen(admission.withPermit(Effect.succeed("child"))),
          Effect.forkScoped,
        ),
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const install = yield* admission
        .withPermit(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(proceed, undefined);
      yield* Effect.yieldNow;
      expect(child.pollUnsafe() === undefined).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(install);
      expect(yield* Fiber.join(child)).toBe("child");
    }),
  );

  it.effect("releases scoped CLI admission on interruption", () =>
    Effect.gen(function* () {
      const admission = yield* Maintenance.ProviderMaintenanceAdmission;
      const entered = yield* Deferred.make<void>();
      const probe = yield* Effect.scoped(
        admission
          .withScopedLaunchPermit(Effect.void)
          .pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const install = yield* admission
        .withPermit(Effect.succeed("installed"))
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(install.pollUnsafe() === undefined).toBe(true);
      yield* Fiber.interrupt(probe);
      expect(yield* Fiber.join(install)).toBe("installed");
    }),
  );
});

it.effect("keeps an install excluded until borrowed scoped probe admission closes", () =>
  Effect.gen(function* () {
    const admission = yield* Maintenance.ProviderMaintenanceAdmission;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const child = yield* admission.withPermit(
      Effect.gen(function* () {
        const child = yield* Effect.scoped(
          admission.withScopedLaunchPermit(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        return child;
      }),
    );
    const install = yield* admission
      .withPermit(Effect.succeed("installed"))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(install.pollUnsafe() === undefined).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(child);
    expect(yield* Fiber.join(install)).toBe("installed");
  }),
);

it.effect("cancels an admission waiter while an install still holds the permit", () =>
  Effect.gen(function* () {
    const admission = yield* Maintenance.ProviderMaintenanceAdmission;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const install = yield* admission
      .withPermit(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const probe = yield* admission
      .withPermit(Effect.die("canceled CLI must not launch"))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(probe);
    expect(probe.pollUnsafe() !== undefined).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(install);
    expect(yield* admission.withPermit(Effect.succeed("next"))).toBe("next");
  }),
);
