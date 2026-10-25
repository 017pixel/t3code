import {
  MESH_ALL_MACHINES,
  MessageId,
  NonNegativeInt,
  Project as ProjectSchema,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Tool } from "effect/ai";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as MeshForwarding from "../../../mesh/MeshForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpMeshRouting from "../../McpMeshRouting.ts";
import * as McpMeshLaunch from "../../McpMeshLaunch.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { resolveRuntimeMode, stableCommandId } from "../../OrchestratorMcpService.ts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

/** Require project worktrees so launches cannot target arbitrary host directories. */
const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. t3_worktree_list shows them.",
    });
});

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});

const byProject = (input: { readonly projectId: ProjectId }) =>
  McpToolAccess.projectTarget(input.projectId);

type LaunchInput = Tool.Parameters<typeof ProjectToolkit.tools.t3_thread_launch>;
type ProjectListInput = Tool.Parameters<typeof ProjectToolkit.tools.t3_project_list>;
type ProjectListResult = Tool.Success<typeof ProjectToolkit.tools.t3_project_list>;

/** PLAN §8.4 remote spawn: the member's project for this repository, committed work only. */
const launchOnMember = Effect.fn("mcp.launchOnMember")(function* (
  input: LaunchInput,
  call: McpToolAccess.MeshRemoteCall<
    LaunchInput,
    Tool.Success<typeof ProjectToolkit.tools.t3_thread_launch>
  >,
) {
  if ((input.attachments ?? []).length > 0)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `A launch on ${call.machine.label} cannot carry attachments. Launch without them, then send them from a thread there.`,
    });
  const sourceProjectId =
    input.scratch === true ? undefined : (input.projectId ?? call.caller.caller?.projectId);
  const projectId =
    sourceProjectId === undefined
      ? undefined
      : yield* McpMeshRouting.memberProjectFor(call, sourceProjectId);
  const callerModel = call.caller.caller?.modelSelection;
  // A target inherits from the caller's model there; without one, the caller's model is used only
  // when that machine has it.
  const modelSelection =
    input.modelSelection ??
    (input.target !== undefined
      ? callerModel
      : yield* McpMeshLaunch.modelOnMember(callerModel, (search) =>
          McpMeshRouting.forwardTool(
            call.mesh,
            OrchestratorToolkit.tools.orchestrator_capabilities,
            call.machine,
            { search },
            call.options,
          ),
        ));
  const strategy = input.workspaceStrategy;
  return yield* call.forward({
    ...input,
    ...(projectId === undefined ? {} : { projectId }),
    ...(modelSelection === undefined ? {} : { modelSelection }),
    // Local commits are not on the other machine: start from origin unless told otherwise.
    ...(strategy?.type === "worktree" && strategy.startFromOrigin === undefined
      ? { workspaceStrategy: { ...strategy, startFromOrigin: true } }
      : {}),
  });
});

const ProjectListPage = Schema.Struct({
  projects: Schema.Array(ProjectSchema),
  nextCursor: Schema.NullOr(NonNegativeInt),
});

const listProjectsHere = Effect.fn("mcp.listProjectsHere")(function* (input: ProjectListInput) {
  const projects = yield* access;
  const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
  const rows = snapshot.projects.filter((project) => project.deletedAt === null);
  const start = input.cursor ?? 0,
    end = start + (input.limit ?? 20);
  return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
});
export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  t3_thread_launch: McpToolAccess.routed(
    { machine: (input) => input.machine, remote: launchOnMember },
    McpToolAccess.startsThreads(
      (input) => input,
      (input, { runtimeMode, interactionMode }) =>
        Effect.gen(function* () {
          const context = yield* readCaller();
          const { caller, scope } = context;
          const commandId =
            input.clientRequestId === undefined
              ? yield* newCommandId()
              : stableCommandId({
                  scope,
                  requestKey: input.clientRequestId,
                  operation: "thread-launch",
                });
          const threadId = ThreadId.make(commandId);
          const messageId = MessageId.make(commandId);
          const attachments = input.attachments ?? [];
          if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "A new thread accepts only pending attachment uploads.",
            });
          if (
            input.scratch === true &&
            (input.projectId !== undefined || input.workspaceStrategy !== undefined)
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
            });
          const projectId =
            input.scratch === true
              ? (yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
                  Effect.flatMap((folders) => folders.ensureScratchProject),
                  Effect.mapError(
                    (error) =>
                      new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: error.message,
                      }),
                  ),
                )).projectId
              : yield* resolveProjectId(context, input.projectId);
          const readProject = Project.ProjectService.pipe(
            Effect.flatMap((projects) => projects.getById(projectId)),
            Effect.mapError(unavailable),
            Effect.map(Option.getOrUndefined),
          );
          if (input.workspaceStrategy?.type === "existing_worktree") {
            const project = yield* readProject;
            if (project === undefined)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "The project was not found.",
              });
            yield* assertProjectWorktree(
              project.workspaceRoot,
              input.workspaceStrategy.worktreePath,
            );
          }
          // Reject unresolved base refs before accepting a launch; worktree provisioning happens later.
          const strategy = input.workspaceStrategy;
          if (strategy?.type === "worktree")
            yield* ThreadLaunch.ThreadLaunchService.pipe(
              Effect.flatMap((launches) =>
                launches.checkWorktreeBase({ projectId, workspaceStrategy: strategy }),
              ),
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: `${error.message} No thread was created. Pass a branch, tag, or commit that exists there${
                      strategy.startFromOrigin === true
                        ? "; the project has no usable remote to fetch it from."
                        : ", or set startFromOrigin:true if it exists only on a remote."
                    }`,
                  }),
              ),
            );
          // A caller outside a thread has nothing to inherit, so it starts with the
          // project's effective defaults, as the composer does. Its mode stays
          // within the ceiling it was approved with.
          const projectDefaults =
            caller === undefined
              ? yield* ServerSettings.ServerSettingsService.pipe(
                  Effect.flatMap((settings) => settings.getSettings),
                  Effect.mapError(unavailable),
                  Effect.flatMap((settings) =>
                    Effect.map(
                      readProject,
                      (project) => resolveProjectSettings(settings, projectId, project).settings,
                    ),
                  ),
                )
              : undefined;
          const inheritedModel =
            input.modelSelection ??
            caller?.modelSelection ??
            projectDefaults?.defaultModelSelection ??
            undefined;
          const defaultRuntimeMode =
            projectDefaults !== undefined && input.runtimeMode === undefined
              ? yield* resolveRuntimeMode(runtimeMode, projectDefaults.defaultRuntimeMode).pipe(
                  Effect.orElseSucceed(() => runtimeMode),
                )
              : runtimeMode;
          // A retry replays its receipt, so only a first attempt resolves the target, unless the
          // target is the only model there is.
          const requestedTarget = input.target;
          const replayed =
            requestedTarget !== undefined &&
            inheritedModel !== undefined &&
            input.clientRequestId !== undefined &&
            (yield* ThreadManagement.ThreadManagementService.pipe(
              Effect.flatMap((threads) => threads.hasReceipt(commandId)),
            ));
          const target =
            requestedTarget === undefined || replayed
              ? undefined
              : yield* (yield* OrchestratorMcpService.OrchestratorMcpService).resolveLaunchTarget({
                  projectId,
                  inherited: inheritedModel,
                  target: requestedTarget,
                });
          const modelSelection = target?.modelSelection ?? inheritedModel;
          if (modelSelection === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Pass modelSelection or a target provider: the project has no default model. orchestrator_capabilities lists providers and models.",
            });
          const startedRuntimeMode =
            target === undefined
              ? defaultRuntimeMode
              : yield* resolveRuntimeMode(
                  defaultRuntimeMode,
                  input.runtimeMode === undefined ? undefined : defaultRuntimeMode,
                  target,
                );
          const result = yield* ThreadMessageIntake.launchThread({
            commandId,
            threadId,
            projectId,
            title: input.title,
            modelSelection,
            runtimeMode: startedRuntimeMode,
            interactionMode,
            workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
            ...(input.message === undefined && attachments.length === 0
              ? {}
              : {
                  initialMessage: {
                    messageId,
                    ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                    text: input.message ?? "",
                    attachments,
                  },
                }),
            createdBy: "agent",
            creationSource: "mcp",
            ...(scope.mesh === undefined
              ? {}
              : {
                  meshOrigin: {
                    environmentId: scope.mesh.sourceEnvironmentId,
                    threadId:
                      scope.mesh.source?.kind === "thread" ? scope.mesh.source.threadId : null,
                    ...(scope.mesh.source?.kind === "thread" && scope.mesh.source.delegated === true
                      ? { delegated: true }
                      : {}),
                  },
                }),
          }).pipe(
            Effect.mapError((error) => {
              if (error._tag === "AttachmentClaimError") {
                return new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                });
              }
              if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
                return new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: error.message,
                });
              }
              return unavailable();
            }),
          );
          const thread = result.projection.thread;
          const run = result.projection.runs.find((run) => run.userMessageId === messageId);
          return {
            threadId: thread.id,
            link: formatThreadLink(thread.id, thread.title),
            projectId: thread.projectId,
            modelSelection: thread.modelSelection,
            runId: run?.id ?? null,
            status: run?.status ?? null,
          };
        }),
    ),
  ),
  t3_project_list: McpToolAccess.routed(
    { machine: (input) => (input.machine === MESH_ALL_MACHINES ? undefined : input.machine) },
    McpToolAccess.reads((input) =>
      Effect.gen(function* (): Effect.fn.Return<
        ProjectListResult,
        OrchestratorMcpFailure,
        Effect.Services<typeof access> | McpInvocationContext.McpInvocationContext
      > {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const mesh = yield* Effect.serviceOption(MeshForwarding.MeshForwarding);
        if (
          input.machine !== MESH_ALL_MACHINES ||
          scope.mesh !== undefined ||
          Option.isNone(mesh)
        ) {
          return yield* listProjectsHere(input);
        }
        const options = McpMeshRouting.meshCallOptions(yield* readCaller());
        const sections = yield* McpMeshRouting.machineSections(
          mesh.value,
          listProjectsHere(input),
          (machine) =>
            McpMeshRouting.forwardToolAs(
              mesh.value,
              ProjectToolkit.tools.t3_project_list,
              ProjectListPage,
              machine,
              McpMeshRouting.withoutMachine(input),
              options,
            ),
        );
        return { sections };
      }),
    ),
  ),
  t3_project_read: McpToolAccess.routed(
    { owner: byProject },
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const projects = yield* access;
        const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
        if (Option.isNone(result))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The project was not found.",
          });
        return result.value;
      }),
    ),
  ),
  t3_project_create: McpToolAccess.routed(
    { machine: (input) => input.machine },
    McpToolAccess.writesEnvironment(({ workspaceRoot, ...input }) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        if (workspaceRoot === undefined) {
          // Only updates record model defaults; reject defaults that creation would silently drop.
          if (
            input.scripts !== undefined ||
            input.createWorkspaceRootIfMissing !== undefined ||
            input.defaultModelSelection !== undefined
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with t3_project_update.",
            });
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const created = yield* folders.createNamedProject({ name: input.title }).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                }),
            ),
          );
          const project = yield* projects
            .getById(created.projectId)
            .pipe(
              Effect.mapError(unavailable),
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
              ),
            );
          return {
            ...project,
            ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
          };
        }
        const commandId = yield* newCommandId();
        return yield* projects
          .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
          .pipe(Effect.mapError(projectFailure));
      }),
    ),
  ),
  t3_project_update: McpToolAccess.routed(
    { owner: byProject },
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        return yield* projects
          .update({ ...input, commandId: yield* newCommandId() })
          .pipe(Effect.mapError(projectFailure));
      }),
    ),
  ),
  t3_project_delete: McpToolAccess.routed(
    { owner: byProject },
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        return yield* projects
          .delete({ ...input, commandId: yield* newCommandId() })
          .pipe(Effect.mapError(projectFailure));
      }),
    ),
  ),
  t3_project_clone: McpToolAccess.routed(
    { machine: (input) => input.machine },
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const repositories = yield* Repositories.SourceControlRepositoryService;
        return yield* repositories.cloneRepository(input).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.detail,
              }),
          ),
        );
      }),
    ),
  ),
});
