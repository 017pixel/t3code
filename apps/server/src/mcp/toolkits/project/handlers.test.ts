import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type ProjectScript,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ProjectScriptService from "../../ProjectScriptMcpService.ts";
import * as ScriptHandlers from "../project_script/handlers.ts";
import { ProjectScriptToolkit } from "../project_script/tools.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import { withWorkspaceLease } from "../../../workspace/workspaceLease.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";

it.effect("attributes a launched thread's first message to the calling thread", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    let launchedSender: ThreadId | undefined;
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launchedSender = input.initialMessage?.senderThreadId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launchedSender).toBe(sourceThreadId);
  }),
);

it.effect("launches a scratch thread into the Scratch project", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const scratchProjectId = ProjectId.make("project:scratch");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launched.push(input);
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId: input.projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-scratch-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    const result = yield* handle({ title: "Notes", scratch: true, message: "Draft a list" });
    expect(result.at(-1)?.result).toMatchObject({ projectId: scratchProjectId });
    expect(launched.map((input) => [input.projectId, input.workspaceStrategy])).toEqual([
      [scratchProjectId, { type: "root" }],
    ]);

    const rejected = yield* handle({
      title: "Notes",
      scratch: true,
      projectId: caller.projectId,
    });
    expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("starts a project from just a title when workspaceRoot is omitted", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const createdProjectId = ProjectId.make("project:named");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const named: Array<string> = [];
    const registered: Array<string> = [];
    const createdProject = {
      id: createdProjectId,
      title: "Pinball Stats",
      workspaceRoot: "/projects/pinball-stats",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        create: (input) =>
          Effect.sync(() => {
            registered.push(input.workspaceRoot);
            return { ...createdProject, id: input.projectId, workspaceRoot: input.workspaceRoot };
          }),
        getById: (projectId) =>
          Effect.succeed(
            projectId === createdProjectId ? Option.some(createdProject) : Option.none(),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        createNamedProject: (input) =>
          Effect.sync(() => {
            named.push(input.name);
            return {
              projectId: createdProjectId,
              workspaceRoot: createdProject.workspaceRoot,
              commitError: "Git has no name or email on this machine.",
            };
          }),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-named-project-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_project_create">>[1]) =>
      toolkit
        .handle("t3_project_create", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    const result = yield* handle({ title: "Pinball Stats" });
    expect(result.at(-1)?.result).toMatchObject({
      id: createdProjectId,
      workspaceRoot: "/projects/pinball-stats",
      commitError: "Git has no name or email on this machine.",
    });
    expect(named).toEqual(["Pinball Stats"]);

    yield* handle({ title: "Existing", workspaceRoot: "/work/existing" });
    expect(registered).toEqual(["/work/existing"]);

    for (const extra of [
      { scripts: [] },
      { defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" } },
    ]) {
      const rejected = yield* handle({ title: "Configured", ...extra });
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    }
    expect(named).toEqual(["Pinball Stats"]);
  }),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest(),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
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
    }),
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
                defaultModelSelection: modelSelection,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
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
  return { projectId, modelSelection, dependencies: layerDependencies };
};

it.effect("a client launches at its ceiling with the project's default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Fix", projectId, message: "Fix the bug" });
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launched[0]?.runtimeMode).toBe("auto-accept-edits");
    expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

    const escalated = yield* handle({ title: "Fix", projectId, runtimeMode: "full-access" });
    expect(escalated.at(-1)?.result).toMatchObject({ code: "runtime_mode_escalation_denied" });

    const untargeted = yield* handle({ title: "Fix" });
    expect(untargeted.at(-1)?.result).toMatchObject({ code: "target_required" });
    expect(launched).toHaveLength(1);
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

const savedScriptFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-saved-script-" });
  const worktree = `${root}/worktree`;
  yield* fs.makeDirectory(worktree);
  const caller = liveThreadShell(ThreadId.make("z-parent"));
  const target: OrchestrationV2ThreadShell = {
    ...liveThreadShell(ThreadId.make("a-child")),
    worktreePath: worktree,
    modelSelection: { instanceId: ProviderInstanceId.make("target-provider"), model: "test" },
    lineage: {
      rootThreadId: caller.id,
      parentThreadId: caller.id,
      relationshipToParent: "subagent" as const,
    },
  };
  const script: ProjectScript = {
    id: "saved-" + "x".repeat(600),
    name: "Dev",
    command: "echo 🚀 café",
    icon: "play",
    runOnWorktreeCreate: false,
    previewUrl: "http://localhost:3000",
    autoOpenPreview: true,
  };
  const state = {
    caller,
    target,
    project: {
      id: caller.projectId,
      workspaceRoot: root,
      scripts: [] as ProjectScript[],
      title: "Scripts",
      defaultModelSelection: null,
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      deletedAt: null,
    } satisfies ProjectRecord,
    partialWrite: false,
    beforeLock: (_id: ThreadId): Effect.Effect<void> => Effect.void,
    beforeOpen: Effect.void,
  };
  const spawns: PtyAdapter.PtySpawnInput[] = [];
  const processes: Array<{ writes: string[]; killed: boolean; exit: () => void }> = [];
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir: `${root}/logs`,
    processKillGraceMs: 1,
    shellResolver: () => "/bin/sh",
    resolveProviderInstanceEnvironment: (id, env) =>
      state.beforeOpen.pipe(Effect.as({ ...env, TEST_PROVIDER: id })),
    ptyAdapter: {
      spawn: (input) =>
        Effect.sync(() => {
          spawns.push(input);
          const listeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
          const process = {
            writes: [] as string[],
            killed: false,
            exit: () => {
              for (const listener of listeners) listener({ exitCode: 0, signal: null });
            },
          };
          processes.push(process);
          return {
            pid: 9000,
            resize: () => {},
            onData: () => () => {},
            write: (data: string) => {
              process.writes.push(state.partialWrite ? data.slice(0, 3) : data);
              if (state.partialWrite) throw new Error("PTY accepted a prefix");
            },
            kill: () => {
              process.killed = true;
              process.exit();
            },
            onExit: (listener: (event: PtyAdapter.PtyExitEvent) => void) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          };
        }),
    },
  });
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.provide(
      ServerSettings.layerTest({ defaultProjectScripts: [script], projectSettingsFolded: true }),
    ),
  );
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerSettings.ServerSettingsService, settings),
    Layer.succeed(TerminalManager.TerminalManager, manager),
    Layer.succeed(ThreadCommandExecutor.ThreadCommandExecutor, {
      ...executor,
      withLock: (id, effect) =>
        Effect.suspend(() =>
          state.beforeLock(id).pipe(Effect.andThen(executor.withLock(id, effect))),
        ),
    }),
    Layer.mock(Project.ProjectService)({
      getById: () => Effect.sync(() => Option.some(state.project)),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.sync(() =>
          id === caller.id ? state.caller : id === target.id ? state.target : null,
        ),
    }),
  );
  const context = yield* Layer.build(
    ProjectScriptService.layer.pipe(Layer.provideMerge(dependencies)),
  );
  const toolkit = yield* ProjectScriptToolkit.pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(ScriptHandlers.layer)),
    Effect.provide(context),
  );
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "saved-scripts",
    thread: {
      threadId: caller.id,
      providerSessionId: "session",
      providerInstanceId: caller.providerInstanceId!,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  };
  const handle = <Name extends keyof typeof ProjectScriptToolkit.tools>(
    name: Name,
    input: Parameters<typeof toolkit.handle<Name>>[1],
    invocation = scope,
  ) =>
    toolkit.handle(name, input).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunks) => chunks.at(-1)!.result),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(context),
    );
  return { state, script, manager, executor, settings, handle, scope, spawns, processes };
});

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
    ThreadCommandExecutor.layer,
  ),
  { excludeTestServices: true },
)("saved project scripts", (it) => {
  it.effect(
    "discovers effective scripts and runs and stops a saved command in the target worktree",
    () =>
      Effect.gen(function* () {
        const { state, script, settings, handle, spawns, processes } = yield* savedScriptFixture;
        const page = yield* handle("t3_project_script_list", { limit: 1, commandPreviewChars: 6 });
        expect(page).toMatchObject({
          total: 1,
          nextCursor: null,
          scripts: [
            {
              scriptId: script.id,
              commandPreview: "echo 🚀",
              commandCharacters: 11,
              commandTruncated: true,
            },
          ],
        });
        const override = { ...script, command: "printf override" };
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [state.project.id]: { defaultProjectScripts: [override, { ...script, id: "second" }] },
          },
        });
        expect(yield* handle("t3_project_script_list", { limit: 1 })).toMatchObject({
          total: 2,
          nextCursor: 1,
          scripts: [{ commandPreview: override.command, commandTruncated: false }],
        });
        expect(yield* handle("t3_project_script_list", { cursor: 1, limit: 1 })).toMatchObject({
          total: 2,
          nextCursor: null,
          scripts: [{ scriptId: "second" }],
        });
        const run = { threadId: state.target.id, scriptId: script.id, terminalId: "dev" };
        expect(yield* handle("t3_project_script_run", run)).toMatchObject({
          ...run,
          outcome: "input_accepted",
          inputAcceptance: { accepted: true, characters: 17 },
          previewUrl: script.previewUrl,
          previewAutoOpened: false,
          terminal: {
            cwd: state.target.worktreePath,
            worktreePath: state.target.worktreePath,
            status: "running",
          },
        });
        expect(spawns[0]).toMatchObject({
          cwd: state.target.worktreePath,
          env: {
            T3CODE_PROJECT_ROOT: state.project.workspaceRoot,
            T3CODE_WORKTREE_PATH: state.target.worktreePath,
            TEST_PROVIDER: state.target.modelSelection.instanceId,
          },
        });
        expect(processes[0]!.writes).toEqual([" printf override\r"]);
        for (const mismatch of [
          { scriptId: "second" },
          { threadId: state.caller.id },
          { terminalId: "other" },
        ]) {
          expect(yield* handle("t3_project_script_stop", { ...run, ...mismatch })).toMatchObject({
            code: "script_run_not_found",
          });
        }
        expect(processes[0]!.killed).toBe(false);
        yield* settings.updateSettings({
          projectSettingsOverrides: { [state.project.id]: { defaultProjectScripts: [] } },
        });
        expect(yield* handle("t3_project_script_stop", run)).toMatchObject({ stopped: true });
        expect(processes[0]!.killed).toBe(true);
        expect(yield* handle("t3_project_script_stop", run)).toMatchObject({
          code: "script_run_not_found",
        });
      }),
  );

  it.effect(
    "bounds the complete UTF-16 input and leaves a partially written terminal stoppable",
    () =>
      Effect.gen(function* () {
        const { state, script, settings, handle, processes } = yield* savedScriptFixture;
        const run = { scriptId: script.id, terminalId: "limit" };
        const command = "🚀".repeat(32_766) + "x";
        yield* settings.updateSettings({ defaultProjectScripts: [{ ...script, command }] });
        expect(yield* handle("t3_project_script_run", run)).toMatchObject({
          outcome: "input_accepted",
          inputAcceptance: { characters: 65_535 },
        });
        expect(processes[0]!.writes).toEqual([` ${command}\r`]);
        yield* handle("t3_project_script_stop", run);
        yield* settings.updateSettings({
          defaultProjectScripts: [{ ...script, command: command + "x" }],
        });
        expect(
          yield* handle("t3_project_script_run", { ...run, terminalId: "too-long" }),
        ).toMatchObject({ code: "script_command_too_large" });
        expect(processes).toHaveLength(1);
        yield* settings.updateSettings({ defaultProjectScripts: [script] });
        state.partialWrite = true;
        const partial = { ...run, terminalId: "partial" };
        expect(yield* handle("t3_project_script_run", partial)).toMatchObject({
          terminalId: partial.terminalId,
          outcome: "terminal_opened_input_failed",
          inputAcceptance: null,
          error: expect.stringContaining("partially written"),
        });
        expect(processes[1]!.writes).toEqual([" ec"]);
        expect(yield* handle("t3_project_script_run", partial)).toMatchObject({
          code: "terminal_already_exists",
        });
        expect(yield* handle("t3_project_script_stop", partial)).toMatchObject({ stopped: true });
        expect(processes[1]!.killed).toBe(true);
      }),
  );

  it.effect(
    "enforces current MCP caller and target authority while keeping discovery read-only",
    () =>
      Effect.gen(function* () {
        const { state, script, handle, scope, processes } = yield* savedScriptFixture;
        const caller = state.caller,
          target = state.target;
        const run = { threadId: target.id, scriptId: script.id, terminalId: "denied" };
        for (const modes of [
          { runtimeMode: "approval-required" as const },
          { interactionMode: "plan" as const },
          { activeRunId: null },
        ]) {
          state.caller = { ...caller, ...modes };
          expect(yield* handle("t3_project_script_run", run)).toMatchObject({
            code: "activeRunId" in modes ? "parent_not_active" : "capability_denied",
          });
        }
        state.caller = caller;
        state.target = { ...target, interactionMode: "plan" };
        expect(yield* handle("t3_project_script_run", run)).toMatchObject({
          code: "execution_policy_denied",
        });
        state.target = target;
        const readOnly = {
          ...scope,
          thread: undefined,
          client: { sessionId: "read", label: "Reader", access: "read-only" as const },
        };
        expect(
          yield* handle("t3_project_script_list", { threadId: target.id }, readOnly),
        ).toMatchObject({ total: 1 });
        for (const name of ["t3_project_script_run", "t3_project_script_stop"] as const) {
          expect(yield* handle(name, run, readOnly)).toMatchObject({ code: "capability_denied" });
        }
        expect(processes).toEqual([]);
      }),
  );

  it.effect("rechecks authority after waiting for a lock and orders parent before child", () =>
    Effect.gen(function* () {
      const { state, script, handle, manager, executor, processes } = yield* savedScriptFixture;
      const caller = state.caller,
        target = state.target;
      for (const changed of ["caller", "target"] as const) {
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const attempted = yield* Deferred.make<ThreadId>();
        const holder = yield* executor
          .withLock(
            caller.id,
            Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(locked);
        state.beforeLock = (id) => Deferred.succeed(attempted, id).pipe(Effect.asVoid);
        const running = yield* handle("t3_project_script_run", {
          threadId: target.id,
          scriptId: script.id,
          terminalId: changed,
        }).pipe(Effect.forkScoped);
        expect(yield* Deferred.await(attempted)).toBe(caller.id);
        // This is the parent-to-child order used by orchestration while the script waits.
        yield* executor.withLock(
          target.id,
          Effect.sync(() => {
            state[changed] = { ...state[changed], interactionMode: "plan" };
          }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        expect(yield* Fiber.join(running)).toMatchObject({
          code: changed === "caller" ? "capability_denied" : "execution_policy_denied",
        });
        state.caller = caller;
        state.target = target;
      }
      expect(processes).toEqual([]);
      for (const changed of ["caller", "target"] as const) {
        const opening = yield* Deferred.make<void>();
        state.beforeOpen = Deferred.succeed(opening, undefined).pipe(Effect.asVoid);
        const run = {
          threadId: target.id,
          scriptId: script.id,
          terminalId: `lease-${changed}`,
        };
        const running = yield* withWorkspaceLease(
          target.worktreePath!,
          Effect.gen(function* () {
            const running = yield* handle("t3_project_script_run", run).pipe(Effect.forkScoped);
            yield* Deferred.await(opening);
            expect(processes).toHaveLength(changed === "caller" ? 0 : 1);
            // Checkpoint rollback takes the executor lock while still holding this lease.
            yield* executor
              .withLock(
                target.id,
                Effect.sync(() => {
                  state[changed] = { ...state[changed], interactionMode: "plan" };
                }),
              )
              .pipe(
                Effect.timeoutOrElse({
                  duration: "2 seconds",
                  orElse: () =>
                    Effect.die(
                      "Script startup held the executor lock while waiting for the workspace lease",
                    ),
                }),
              );
            return running;
          }),
        );
        expect(yield* Fiber.join(running)).toMatchObject({
          code: changed === "caller" ? "capability_denied" : "execution_policy_denied",
        });
        expect(processes.at(-1)).toMatchObject({ writes: [], killed: true });
        state.caller = caller;
        state.target = target;
        expect(yield* handle("t3_project_script_stop", run)).toMatchObject({
          code: "script_run_not_found",
        });
      }
      state.caller = { ...caller, worktreePath: target.worktreePath };
      const run = { threadId: target.id, scriptId: script.id, terminalId: "lease-stop" };
      expect(yield* handle("t3_project_script_run", run)).toMatchObject({
        outcome: "input_accepted",
      });
      const owned = processes.at(-1)!;
      const opening = yield* Deferred.make<void>();
      const stopping = yield* Deferred.make<void>();
      state.beforeOpen = Deferred.succeed(opening, undefined).pipe(Effect.asVoid);
      state.beforeLock = (id) =>
        id === target.id ? Deferred.succeed(stopping, undefined).pipe(Effect.asVoid) : Effect.void;
      const pending = yield* withWorkspaceLease(
        target.worktreePath!,
        Effect.gen(function* () {
          const other = yield* manager
            .open({
              threadId: target.id,
              terminalId: "other",
              cwd: target.worktreePath!,
              worktreePath: target.worktreePath,
              providerInstanceId: target.modelSelection.instanceId,
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(opening);
          const stop = yield* handle("t3_project_script_stop", run).pipe(Effect.forkScoped);
          yield* Deferred.await(stopping);
          // Stop reaches the child lock under the parent lock; rollback shares their workspace.
          yield* executor.withLock(caller.id, Effect.void).pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () =>
                Effect.die(
                  "Script stop held the executor lock while another terminal held the terminal lock waiting for the workspace lease",
                ),
            }),
          );
          expect(owned.killed).toBe(false);
          expect(processes.at(-1)).toBe(owned);
          return { other, stop };
        }),
      );
      expect(yield* Fiber.join(pending.other)).toMatchObject({
        terminalId: "other",
        status: "running",
      });
      expect(yield* Fiber.join(pending.stop)).toMatchObject({ stopped: true });
      expect(owned.killed).toBe(true);
      expect(processes.at(-1)).toMatchObject({ writes: [], killed: false });
    }),
  );

  it.effect("never adopts a terminal replacement and cleans up an interrupted script startup", () =>
    Effect.gen(function* () {
      const { state, script, handle, manager, processes } = yield* savedScriptFixture;
      const run = { scriptId: script.id, terminalId: "owned" };
      yield* handle("t3_project_script_run", run);
      yield* manager.restart({
        threadId: state.caller.id,
        terminalId: run.terminalId,
        cwd: state.project.workspaceRoot,
        cols: 100,
        rows: 24,
      });
      expect(yield* handle("t3_project_script_stop", run)).toMatchObject({
        code: "script_run_not_found",
      });
      expect(processes[1]!.killed).toBe(false);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "started" && event.terminalId === "interrupted"
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const interrupted = { ...run, terminalId: "interrupted" };
      const running = yield* handle("t3_project_script_run", interrupted).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      running.interruptUnsafe();
      yield* Deferred.succeed(release, undefined);
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true);
      expect(processes[2]!.killed).toBe(true);
      expect(processes[2]!.writes).toEqual([]);
      expect(yield* handle("t3_project_script_stop", interrupted)).toMatchObject({
        code: "script_run_not_found",
      });
    }),
  );
});
