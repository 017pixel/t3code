import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
export { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";

export class ThreadTitleRegenerationService extends Context.Service<
  ThreadTitleRegenerationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly kind:
        | { readonly type: "initial"; readonly messageId: MessageId }
        | { readonly type: "regenerate" };
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const scope = yield* Effect.scope;

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
      })
      .pipe(Effect.asVoid);

  const refineAfterRun = Effect.fn("ThreadTitleRegenerationService.refineAfterRun")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly messageId: MessageId;
      readonly expectedTitle: string;
    }) {
      // Capture the cursor before reading: completion may precede the initial title response.
      const afterSequence = yield* threads.getThreadEventSequence(input.threadId);
      const initial = yield* threads.getThreadRecords(input.threadId, ["runs"]);
      const run = initial.runs.find((candidate) => candidate.userMessageId === input.messageId);
      if (run === undefined) return;
      const inspect = (projection: typeof initial) => {
        if (
          projection.thread.title !== input.expectedTitle ||
          projection.thread.archivedAt !== null ||
          projection.thread.deletedAt !== null ||
          projection.thread.titleRegeneration != null
        )
          return "cancel" as const;
        const current = projection.runs.find((candidate) => candidate.id === run.id);
        if (current === undefined) return "cancel" as const;
        return current.status === "completed"
          ? ("ready" as const)
          : ThreadManagementService.isTerminalRunStatus(current.status)
            ? ("cancel" as const)
            : ("pending" as const);
      };
      let outcome = inspect(initial);
      if (outcome === "pending") {
        const wake = Stream.mergeAll(
          [
            threads
              .streamStoredEventsFrom({
                threadId: input.threadId,
                afterSequence,
                eventType: "run.updated",
              })
              .pipe(
                Stream.filter(
                  ({ event }) => event.type === "run.updated" && event.payload.id === run.id,
                ),
              ),
            threads.streamStoredEventsFrom({
              threadId: input.threadId,
              afterSequence,
              eventType: "thread.metadata-updated",
            }),
            threads.streamStoredEventsFrom({
              threadId: input.threadId,
              afterSequence,
              eventType: "thread.archived",
            }),
            threads.streamStoredEventsFrom({
              threadId: input.threadId,
              afterSequence,
              eventType: "thread.deleted",
            }),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Stream.mapEffect(({ event }) =>
            event.type === "thread.deleted"
              ? Effect.succeed("cancel" as const)
              : threads
                  .getThreadRecords(input.threadId, ["runs"], { runIds: [run.id] })
                  .pipe(Effect.map(inspect)),
          ),
          Stream.filter((state) => state !== "pending"),
          Stream.runHead,
        );
        const result = yield* wake;
        if (Option.isNone(result)) return;
        outcome = result.value;
      }
      if (outcome !== "ready") return;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.requestId}:refine`),
        threadId: input.threadId,
        regenerateTitle: true,
        expectedTitle: input.expectedTitle,
      });
    },
  );

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome:
      | { readonly type: "stale" }
      | {
          readonly type: "complete";
          readonly title?: string;
          readonly refinement?:
            | { readonly expectedTitle: string; readonly messageId: MessageId }
            | undefined;
        } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { type: "complete" as const };
      }

      let context: {
        readonly message: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      };
      if (input.kind.type === "initial") {
        const messageId = input.kind.messageId;
        const message = projection.messages.find(
          (candidate) => candidate.id === messageId && !candidate.streaming,
        );
        context =
          message === undefined
            ? { message: "", attachments: [] }
            : { message: message.text, attachments: message.attachments };
      } else {
        context = formatThreadTitleContext(
          projection.messages.filter((message) => !message.streaming),
        );
      }
      if (context.message.length === 0 && context.attachments.length === 0) {
        return { type: "complete" as const };
      }

      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projection.thread.projectId,
      ).settings;
      const result = yield* textGeneration.generateThreadTitle({
        cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
        message: context.message,
        attachments: context.attachments,
        ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
        modelSelection: settings.textGenerationModelSelection,
      });
      const generatedTitle = result.title.trim();
      const refinement =
        input.kind.type === "initial" &&
        (result.needsRefinement === true || generatedTitle === "New thread")
          ? {
              expectedTitle:
                generatedTitle === "New thread" ? projection.thread.title : generatedTitle,
              messageId: input.kind.messageId,
            }
          : undefined;
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { type: "complete" as const, refinement }
        : { type: "complete" as const, title: result.title, refinement };
    }).pipe(
      Effect.retry({
        times: input.kind.type === "initial" ? 2 : 0,
        schedule: Schedule.exponential("2 seconds"),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread title generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ type: "complete" as const })),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
    });
    if (outcome.refinement !== undefined) {
      yield* refineAfterRun({ ...input, ...outcome.refinement }).pipe(
        Effect.timeoutOption("30 minutes"),
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(scope),
      );
    }
  });

  return ThreadTitleRegenerationService.of({ execute });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
