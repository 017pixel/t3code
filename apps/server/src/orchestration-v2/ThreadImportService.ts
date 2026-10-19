import {
  CommandId,
  MessageId,
  type OrchestrationV2LinkOrigin,
  type OrchestratorMcpThreadImportInput,
  type OrchestratorMcpThreadImportResult,
  type ProviderInteractionMode,
  ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadImportError extends Schema.TaggedError<ThreadImportError>()(
  "ThreadImportError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["read", "validate-workspace", "create"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread import failed during ${this.operation}.`;
  }
}

export class ThreadImportProjectMismatchError extends Schema.TaggedError<ThreadImportProjectMismatchError>()(
  "ThreadImportProjectMismatchError",
  { threadId: ThreadId, existingProjectId: ProjectId },
) {
  override get message(): string {
    return `This handoff was already imported into another project (${this.existingProjectId}).`;
  }
}

export class ThreadImportWorkspaceError extends Schema.TaggedError<ThreadImportWorkspaceError>()(
  "ThreadImportWorkspaceError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "Choose an existing project and one of its Git worktrees, or omit worktreePath for the project root.";
  }
}

export class ThreadImportDeletedError extends Schema.TaggedError<ThreadImportDeletedError>()(
  "ThreadImportDeletedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This handoff's imported thread was deleted.";
  }
}

export class ThreadImportService extends Context.Service<
  ThreadImportService,
  {
    readonly importThread: (
      input: OrchestratorMcpThreadImportInput & {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
        readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
      },
    ) => Effect.Effect<
      OrchestratorMcpThreadImportResult,
      | ThreadImportError
      | ThreadImportProjectMismatchError
      | ThreadImportWorkspaceError
      | ThreadImportDeletedError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ThreadImportService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const imports = yield* KeyedLock.make<ThreadId>();

  const importThread: ThreadImportService["Service"]["importThread"] = Effect.fn(
    "ThreadImportService.importThread",
  )(function* (input) {
    const digest = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- Hash a fixed tuple of source identity strings without delimiter ambiguity.
          JSON.stringify([
            input.source.environmentId,
            input.source.threadId,
            input.source.handoffId,
          ]),
        ),
      )
      .pipe(Effect.orDie);
    const threadId = ThreadId.make(`thread:import:${Hex.encode(digest)}`);
    const commandId = CommandId.make(`${threadId}:create`);
    const messageId = MessageId.make(`${threadId}:continuation`);
    const wrap = (operation: ThreadImportError["operation"]) => (cause: unknown) =>
      new ThreadImportError({ threadId, operation, cause });
    return yield* imports.withLock(
      threadId,
      Effect.gen(function* () {
        const existing = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(wrap("read")));
        if (existing !== null && existing.projectId !== input.projectId) {
          return yield* new ThreadImportProjectMismatchError({
            threadId,
            existingProjectId: existing.projectId,
          });
        }
        if (existing === null) {
          const project = yield* projects.get(input.projectId).pipe(Effect.mapError(wrap("read")));
          if (Option.isNone(project))
            return yield* new ThreadImportWorkspaceError({ projectId: input.projectId });
          if (input.worktreePath !== undefined) {
            const paths = yield* git
              .listWorktreePaths(project.value.workspaceRoot)
              .pipe(Effect.mapError(wrap("validate-workspace")));
            const realPaths = yield* Effect.forEach(paths, (path) =>
              fs.realPath(path).pipe(Effect.orElseSucceed(() => path)),
            );
            const target = yield* fs
              .realPath(input.worktreePath)
              .pipe(
                Effect.mapError(
                  () => new ThreadImportWorkspaceError({ projectId: input.projectId }),
                ),
              );
            if (!realPaths.includes(target))
              return yield* new ThreadImportWorkspaceError({ projectId: input.projectId });
          }
          yield* threads.assertProviderInstanceEnabled({
            commandId,
            projectId: input.projectId,
            instanceId: input.modelSelection.instanceId,
          });
          // History and the continuation's run/outbox share the native creation receipt.
          yield* threads
            .dispatch({
              type: "thread.create",
              commandId,
              threadId,
              projectId: input.projectId,
              title: input.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: input.branch ?? null,
              worktreePath: input.worktreePath ?? null,
              ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
              importedConversation: {
                messages: input.messages,
                ...(input.continuationPrompt === undefined
                  ? {}
                  : { continuationPrompt: input.continuationPrompt }),
              },
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(wrap("create")));
        }
        const projection = yield* threads
          .getThreadRecords(threadId, ["messages"], { messageIds: [messageId] })
          .pipe(Effect.mapError(wrap("read")));
        if (projection.thread.deletedAt !== null) {
          return yield* new ThreadImportDeletedError({ threadId });
        }
        // A replayed native receipt can have won creation in another service instance.
        if (projection.thread.projectId !== input.projectId) {
          return yield* new ThreadImportProjectMismatchError({
            threadId,
            existingProjectId: projection.thread.projectId,
          });
        }
        return {
          threadId,
          projectId: input.projectId,
          created: existing === null,
          runId: projection.messages.find((message) => message.id === messageId)?.runId ?? null,
        };
      }),
    );
  });
  return ThreadImportService.of({ importThread });
});

export const layer = Layer.effect(ThreadImportService, make);
