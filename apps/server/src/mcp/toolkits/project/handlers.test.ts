import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  /** A project with no saved model, so only modelSelection or a target names one. */
  readonly noDefaultModel?: true;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: {
      sessionId: "session-1",
      label: "Claude Code",
      access: input.runtimeModeCeiling,
    },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  };
  // Everything the handlers read except the caller, which the MCP server provides per request.
  const layerServices = Layer.mergeAll(
    ServerSettings.layerTest({
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    NodeCrypto.layer,
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection:
                  input.overrideModel === undefined && input.noDefaultModel !== true
                    ? modelSelection
                    : null,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([codexProvider]),
      refreshInstance: () => Effect.succeed([codexProvider]),
    }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([codexProvider.instanceId]),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const dependencies = OrchestratorMcpService.layer.pipe(
    Layer.provideMerge(layerServices),
    Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
  );
  return { projectId, modelSelection, scope, layerServices, dependencies };
};

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-25T00:00:00.000Z",
  models: [{ slug: "gpt-6", name: "gpt-6", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "project-handlers", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "project-handlers", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** Calls t3_thread_launch through the toolkits server.ts registers, as an MCP client would. */
const launchThroughServer = (
  harness: ReturnType<typeof clientLaunchHarness>,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_launch", arguments: { projectId: harness.projectId, ...args } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, harness.scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    const text = result.content[0];
    return result.isError === true && text?.type === "text"
      ? (JSON.parse(text.text) as { readonly code: string; readonly message: string })
      : undefined;
  }).pipe(
    Effect.provide(
      McpHttpServer.layerOrchestrationToolkits.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(harness.layerServices),
      ),
    ),
  );

it.effect.each([undefined, true] as const)(
  "persists remote delegation provenance only from the mesh caller (%s)",
  (delegated) =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched });
      const source = {
        kind: "thread" as const,
        threadId: ThreadId.make("remote-parent"),
        ...(delegated === undefined ? {} : { delegated }),
      };
      const mesh = {
        sourceEnvironmentId: EnvironmentId.make("remote"),
        sessionId: "mesh-session",
        modeLimit: { runtimeMode: "full-access" as const, interactionMode: "default" as const },
        source,
      };
      yield* launchThroughServer(
        { ...harness, scope: { ...harness.scope, client: undefined, mesh } },
        { title: "Remote task", meshOrigin: { ...source, delegated: true } },
      );
      expect(launched[0]?.meshOrigin).toEqual({
        environmentId: mesh.sourceEnvironmentId,
        threadId: source.threadId,
        ...(delegated === undefined ? {} : { delegated }),
      });
      yield* launchThroughServer(harness, {
        title: "Local task",
        meshOrigin: {
          environmentId: mesh.sourceEnvironmentId,
          threadId: source.threadId,
          delegated: true,
        },
      });
      expect(launched[1]?.meshOrigin).toBeUndefined();
    }),
);

it.effect(
  "a client launches with the project's default model and mode, capped at its ceiling",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        runtimeModeCeiling: RuntimeMode,
        defaultRuntimeMode: RuntimeMode,
        params: {
          readonly title: string;
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
        },
      ) {
        const { targeted, overrideModel, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", targeted === false ? input : { ...input, projectId })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return { result: result.at(-1)?.result, launched, projectId, modelSelection };
      });

      const belowCeiling = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        message: "Fix the bug",
      });
      expect(belowCeiling.result).toMatchObject({
        projectId: belowCeiling.projectId,
        modelSelection: belowCeiling.modelSelection,
        link: `[Fix](t3-thread://v1/${belowCeiling.launched[0]?.threadId})`,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", { title: "Fix" });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");

      const requested = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        runtimeMode: "auto",
      });
      expect(requested.launched[0]?.runtimeMode).toBe("auto");

      const escalated = yield* launchWith("auto-accept-edits", "auto-accept-edits", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(escalated.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(escalated.launched).toHaveLength(0);

      const untargeted = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        targeted: false,
      });
      expect(untargeted.result).toMatchObject({ code: "target_required" });

      const overrideModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-settings",
      };
      const fromSettings = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        overrideModel,
      });
      expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);
    }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("an explicit target resolves through the production registration", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched });
    const refused = yield* launchThroughServer(harness, {
      title: "Fix",
      target: { providerInstanceId: "codex", model: "gpt-6" },
    });
    expect(refused).toBeUndefined();
    expect(launched[0]?.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6",
    });
  }),
);

it.effect("a target that names a provider stands in for a missing default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const harness = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      noDefaultModel: true,
      launched,
    });
    expect(
      yield* launchThroughServer(harness, {
        title: "Fix",
        target: { providerInstanceId: "codex" },
      }),
    ).toBeUndefined();
    expect(launched[0]?.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6",
    });

    const modelOnly = yield* launchThroughServer(harness, {
      title: "Fix",
      target: { model: "gpt-6" },
    });
    expect(modelOnly?.code).toBe("invalid_request");
    expect(modelOnly?.message).toContain("name providerInstanceId or driverKind");
    expect((yield* launchThroughServer(harness, { title: "Fix" }))?.message).toContain(
      "Pass modelSelection or a target provider",
    );
    expect(launched).toHaveLength(1);
  }),
);
