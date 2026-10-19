import { CommandId, type ChatAttachment, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";

type NamingInput = {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly message: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly context?: string;
  };
};

export class TemporaryBranchNaming extends Context.Service<
  TemporaryBranchNaming,
  {
    readonly schedule: (input: NamingInput) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/TemporaryBranchNaming") {}

const make = Effect.gen(function* () {
  const threads = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitWorkflow.GitWorkflowService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const generation = yield* TextGeneration.TextGeneration;
  const scope = yield* Effect.scope;
  const attempted = yield* Ref.make<ReadonlySet<string>>(new Set());

  const schedule = Effect.fn("TemporaryBranchNaming.schedule")(function* (input: NamingInput) {
    if (
      input.worktreePath === null ||
      input.branch === null ||
      !isTemporaryWorktreeBranch(input.branch)
    )
      return;
    const cwd = input.worktreePath;
    const oldBranch = input.branch;
    const key = `${cwd}\0${oldBranch}`;
    const first = yield* Ref.modify(attempted, (current) =>
      current.has(key) ? [false, current] : [true, new Set(current).add(key)],
    );
    if (!first) return;
    yield* Effect.gen(function* () {
      const settings = resolveProjectSettings(
        yield* settingsService.getSettings,
        input.projectId,
      ).settings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : ServerSettings.resolveSourceControlWriterModelSelection(
              settings,
              yield* providers.getProviders,
              input.projectId,
            );
      const generated = yield* generation.generateBranchName({
        naming: {
          mode: settings.branchNamingMode,
          prefix: settings.branchNamePrefix,
          instructions: settings.branchNameInstructions,
        },
        cwd,
        message: input.message.text,
        attachments: input.message.attachments,
        ...(input.message.context ? { context: input.message.context } : {}),
        modelSelection,
      });
      const sharing = (branch: string) =>
        threads
          .getShellSnapshot()
          .pipe(
            Effect.map((snapshot) =>
              [...snapshot.threads, ...snapshot.archivedThreads].filter(
                (thread) => thread.worktreePath === cwd && thread.branch === branch,
              ),
            ),
          );
      if ((yield* sharing(oldBranch)).length === 0) return;
      const renamed = yield* git.renameBranch({
        cwd,
        oldBranch,
        newBranch: generated.branch,
        ...(settings.branchNamingMode === "custom" ? { exactName: true } : {}),
      });
      if (renamed.branch === oldBranch) return;
      const update = (threadId: ThreadId, from: string, to: string, suffix: string) =>
        threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:${suffix}:${threadId}`),
            threadId,
            branch: to,
            expectedBranch: from,
            expectedWorktreePath: cwd,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                // A moved thread no longer describes this checkout; the remaining sharers still do.
                if (!(yield* sharing(from)).some((thread) => thread.id === threadId)) return;
                return yield* error;
              }),
            ),
          );
      yield* Effect.gen(function* () {
        while (true) {
          const remaining = yield* sharing(oldBranch);
          if (remaining.length === 0) break;
          for (const thread of remaining) {
            yield* update(thread.id, oldBranch, renamed.branch, "branch-rename").pipe(
              Effect.retry({ times: 2, schedule: Schedule.spaced("100 millis") }),
            );
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // Undo partial publication if persistence is unavailable, including children that inherited it.
            yield* git.renameBranch({
              cwd,
              oldBranch: renamed.branch,
              newBranch: oldBranch,
              exactName: true,
            });
            for (const thread of yield* sharing(renamed.branch)) {
              yield* update(thread.id, renamed.branch, oldBranch, "branch-rollback");
            }
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Temporary worktree branch naming failed", {
          threadId: input.threadId,
          cause,
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });
  return TemporaryBranchNaming.of({ schedule });
});

export const layer = Layer.effect(TemporaryBranchNaming, make);
