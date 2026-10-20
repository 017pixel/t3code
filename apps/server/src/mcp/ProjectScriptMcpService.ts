import {
  PROJECT_SCRIPT_MCP_DEFAULT_LIST_LIMIT,
  PROJECT_SCRIPT_MCP_DEFAULT_PREVIEW_CHARS,
  ProjectScriptMcpFailure,
  OrchestratorMcpFailure,
  type ProjectScriptMcpListInput,
  type ProjectScriptMcpListResult,
  type ProjectScriptMcpRunInput,
  type ProjectScriptMcpRunResult,
  type ProjectScriptMcpStopInput,
  type ProjectScriptMcpStopResult,
  type ProjectScript,
  type ThreadId,
} from "@t3tools/contracts";
import {
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Project from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Settings from "../serverSettings.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

type Invocation = McpInvocationContext.McpInvocationScope;
type Failure = ProjectScriptMcpFailure | OrchestratorMcpFailure;

export class ProjectScriptMcpService extends Context.Service<
  ProjectScriptMcpService,
  {
    readonly list: (
      scope: Invocation,
      input: ProjectScriptMcpListInput,
    ) => Effect.Effect<ProjectScriptMcpListResult, Failure>;
    readonly run: (
      scope: Invocation,
      input: ProjectScriptMcpRunInput,
    ) => Effect.Effect<ProjectScriptMcpRunResult, Failure>;
    readonly stop: (
      scope: Invocation,
      input: ProjectScriptMcpStopInput,
    ) => Effect.Effect<ProjectScriptMcpStopResult, Failure>;
  }
>()("t3/mcp/ProjectScriptMcpService") {}

function preview(script: ProjectScript, maxChars: number) {
  let commandPreview = "",
    commandCharacters = 0;
  for (const character of script.command) {
    if (commandCharacters < maxChars) commandPreview += character;
    commandCharacters++;
  }
  return {
    scriptId: script.id,
    name: script.name,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    previewUrl: script.previewUrl ?? null,
    autoOpenPreview: script.autoOpenPreview ?? false,
    commandPreview,
    commandCharacters,
    commandTruncated: commandCharacters > maxChars,
  };
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* Project.ProjectService;
  const terminals = yield* TerminalManager.TerminalManager;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const settings = yield* Settings.ServerSettingsService;
  const runs = new Map<
    TerminalManager.TerminalSessionHandle,
    { readonly projectId: string; readonly scriptId: string }
  >();

  const load = Effect.fn("ProjectScriptMcpService.load")(function* (
    scope: Invocation,
    threadId?: ThreadId,
  ) {
    const context = yield* readCaller().pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    const targetId = threadId ?? context.caller?.id;
    if (targetId === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass threadId when calling from outside a T3 thread.",
      });
    const target = yield* threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
    if (target === null || target.deletedAt !== null)
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The target thread was not found.",
      });
    const project = yield* projects.getById(target.projectId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(project))
      return yield* new ProjectScriptMcpFailure({
        code: "project_not_found",
        message: "The target project was not found.",
      });
    return { context, target, project: project.value };
  });

  // Orchestration takes parent locks before child locks; a lexical ID ordering alone can deadlock it.
  const depth = Effect.fn("ProjectScriptMcpService.depth")(function* (threadId: ThreadId) {
    let id = threadId;
    for (let value = 0; value < 64; value++) {
      const shell = yield* threads.getThreadShell(id).pipe(Effect.mapError(unavailable));
      if (shell === null || shell.lineage.parentThreadId === null) return value;
      id = shell.lineage.parentThreadId;
    }
    return yield* new ProjectScriptMcpFailure({
      code: "operation_failed",
      message: "The thread ancestry exceeds the script execution limit.",
    });
  });

  const mutate = <A, E, R>(
    scope: Invocation,
    threadId: ThreadId | undefined,
    use: (resolved: Effect.Success<ReturnType<typeof load>>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const initial = yield* load(scope, threadId);
      const ids = [
        ...new Set(
          [initial.context.caller?.id, initial.target.id].filter(
            (id): id is ThreadId => id !== undefined,
          ),
        ),
      ];
      const ordered = yield* Effect.forEach(ids, (id) =>
        depth(id).pipe(Effect.map((depth) => ({ id, depth }))),
      );
      ordered.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1));
      const operation = Effect.gen(function* () {
        const resolved = yield* load(scope, initial.target.id);
        if (resolved.context.scope.client?.access === "read-only")
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This MCP client has read-only access.",
          });
        yield* assertLiveCaller(resolved.context);
        yield* assertFullAccess(
          resolved.context,
          "Running or stopping saved scripts requires full-access/default authority.",
        );
        yield* assertTargetWithinLimits(resolved.context.limits, resolved.target);
        if (
          resolved.target.runtimeMode !== "full-access" ||
          resolved.target.interactionMode !== "default"
        )
          return yield* new ProjectScriptMcpFailure({
            code: "execution_policy_denied",
            message: "The target thread must use full-access/default mode.",
          });
        return yield* use(resolved);
      });
      return yield* ordered.reduceRight(
        (effect, { id }) => executor.withLock(id, effect),
        operation,
      );
    });

  const list: ProjectScriptMcpService["Service"]["list"] = (scope, input) =>
    Effect.gen(function* () {
      const { target, project } = yield* load(scope, input.threadId);
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const scripts = resolveProjectScripts(current, project);
      const cursor = input.cursor ?? 0,
        limit = input.limit ?? PROJECT_SCRIPT_MCP_DEFAULT_LIST_LIMIT;
      const page = scripts.slice(cursor, cursor + limit);
      return {
        threadId: target.id,
        projectId: project.id,
        scripts: page.map((script) =>
          preview(script, input.commandPreviewChars ?? PROJECT_SCRIPT_MCP_DEFAULT_PREVIEW_CHARS),
        ),
        total: scripts.length,
        nextCursor: cursor + page.length < scripts.length ? cursor + page.length : null,
      };
    });

  const run: ProjectScriptMcpService["Service"]["run"] = (scope, input) =>
    mutate(scope, input.threadId, ({ target, project }) =>
      Effect.suspend(() => {
        let admittedHandle: TerminalManager.TerminalSessionHandle | undefined;
        return Effect.gen(function* () {
          const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
          const script = resolveProjectScripts(current, project).find(
            (script) => script.id === input.scriptId,
          );
          if (script === undefined)
            return yield* new ProjectScriptMcpFailure({
              code: "script_not_found",
              message: "The saved script was not found.",
            });
          const data = projectScriptTerminalInput(script.command);
          if (data.length > 65_535)
            return yield* new ProjectScriptMcpFailure({
              code: "script_command_too_large",
              message: "The saved script exceeds the terminal input limit including its newline.",
            });
          const opened = yield* terminals
            .openFreshWithHandle(
              {
                threadId: target.id,
                terminalId: input.terminalId,
                cwd: target.worktreePath ?? project.workspaceRoot,
                worktreePath: target.worktreePath,
                env: projectScriptRuntimeEnv({
                  project: { cwd: project.workspaceRoot },
                  worktreePath: target.worktreePath,
                }),
                providerInstanceId: target.modelSelection.instanceId,
              },
              (handle) => {
                admittedHandle = handle;
                runs.set(handle, { projectId: project.id, scriptId: script.id });
              },
              (handle) => {
                runs.delete(handle);
              },
            )
            .pipe(
              Effect.mapError(
                (error) =>
                  new ProjectScriptMcpFailure({
                    code:
                      error._tag === "TerminalAlreadyExistsError"
                        ? "terminal_already_exists"
                        : "operation_failed",
                    message:
                      error._tag === "TerminalAlreadyExistsError"
                        ? error.message
                        : "The script terminal could not be opened.",
                  }),
              ),
            );
          const result = yield* Effect.result(
            terminals.writeWithHandle({
              threadId: target.id,
              terminalId: input.terminalId,
              handle: opened.handle,
              data,
            }),
          );
          const accepted = result._tag === "Success" && result.success;
          return {
            threadId: target.id,
            projectId: project.id,
            scriptId: script.id,
            terminalId: input.terminalId,
            outcome: accepted
              ? ("input_accepted" as const)
              : ("terminal_opened_input_failed" as const),
            terminal: opened.snapshot,
            inputAcceptance: accepted ? { accepted: true as const, characters: data.length } : null,
            error: accepted
              ? null
              : "The terminal opened, but its input may have been partially written. Inspect it before retrying.",
            previewUrl: script.previewUrl ?? null,
            previewAutoOpened: false as const,
          };
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (admittedHandle !== undefined)
                yield* terminals.closeWithHandle(admittedHandle).pipe(Effect.ignore);
            }),
          ),
        );
      }),
    );

  const stop: ProjectScriptMcpService["Service"]["stop"] = (scope, input) =>
    mutate(scope, input.threadId, ({ target, project }) =>
      Effect.gen(function* () {
        const handle = [...runs.entries()].find(
          ([handle, ownership]) =>
            handle.threadId === target.id &&
            handle.terminalId === input.terminalId &&
            ownership.projectId === project.id &&
            ownership.scriptId === input.scriptId,
        )?.[0];
        if (
          handle === undefined ||
          !(yield* terminals.closeWithHandle(handle).pipe(
            Effect.mapError(
              () =>
                new ProjectScriptMcpFailure({
                  code: "operation_failed",
                  message: "The script terminal could not be stopped.",
                }),
            ),
          ))
        ) {
          if (handle !== undefined) runs.delete(handle);
          return yield* new ProjectScriptMcpFailure({
            code: "script_run_not_found",
            message: "No matching live script run was found.",
          });
        }
        return {
          threadId: target.id,
          projectId: project.id,
          scriptId: input.scriptId,
          terminalId: input.terminalId,
          stopped: true as const,
        };
      }),
    );

  return ProjectScriptMcpService.of({ list, run, stop });
});

export const layer = Layer.effect(ProjectScriptMcpService, make);
