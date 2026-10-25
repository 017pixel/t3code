import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

/**
 * Wakes a task's parent about a question in its child. A remote task's child is the member's
 * thread, which pending request tools reach by id. Keyed by request, so repeats are no-ops.
 */
export function delegatedTaskQuestionWake(input: {
  readonly task: Pick<OrchestrationV2Subagent, "id" | "threadId" | "title" | "prompt">;
  readonly childThreadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  /** False when the child asked by message and keeps working. */
  readonly blocking: boolean;
}): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> {
  const { task, childThreadId, requestId } = input;
  const key = `${task.threadId}:${requestId}`;
  const label = reportLabel(task.title?.trim() || task.prompt);
  const situation = input.blocking
    ? `Delegated task ${task.id} is blocked on a question and cannot continue until it is answered.`
    : `Delegated task ${task.id} asked a question and is still working.`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`server:delegated-task-question:${key}`),
    threadId: task.threadId,
    messageId: delegatedTaskQuestionMessageId(task.threadId, requestId),
    text: `${situation} Read it with t3_pending_request_read using threadId ${childThreadId} and requestId ${requestId}. Answer it with t3_pending_request_respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
    notification: {
      source: { kind: "delegated_task", taskIds: [task.id], childThreadId },
      outcome: "updated",
      summary: `Delegated task${label === undefined ? "" : ` "${label}"`} has a question`,
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  };
}

export const delegatedTaskQuestionMessageId = (parentThreadId: ThreadId, requestId: string) =>
  MessageId.make(`message:delegated-task-question:${parentThreadId}:${requestId}`);

/** A blocking delegate_task wait delivers its task's live questions itself. */
export function blockingWaitDeliversQuestions(
  task: Pick<OrchestrationV2Subagent, "runId" | "completionWake">,
  runs: ReadonlyArray<{ readonly id: string; readonly status: string }>,
): boolean {
  return (
    task.completionWake === "settled_only" &&
    runs.some(
      (run) =>
        run.id === task.runId &&
        (run.status === "preparing" || run.status === "starting" || run.status === "running"),
    )
  );
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.runId !== event.payload.id ||
            task.completionWake !== "settled_only" ||
            task.completionDelivery?.state === "disposed" ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ) {
            continue;
          }
          // A remote task's follower records the member's open question on the task.
          const remote = task.remote;
          if (remote !== undefined) {
            if (remote.pending?.kind !== "question" || remote.threadId === null) continue;
            yield* engine
              .dispatch(
                delegatedTaskQuestionWake({
                  task,
                  childThreadId: remote.threadId,
                  requestId: remote.pending.requestId,
                  blocking: true,
                }),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("catching up a remote task question failed", {
                    taskId: task.id,
                    cause,
                  }),
                ),
              );
            continue;
          }
          if (task.childThreadId === null) continue;
          const childThreadId = task.childThreadId;
          const child = yield* projections.getThreadRecords(childThreadId, ["runtimeRequests"]);
          for (const request of child.runtimeRequests) {
            if (
              request.kind !== "user_input" ||
              request.status !== "pending" ||
              request.responseCapability.type !== "live"
            ) {
              continue;
            }
            yield* engine
              .dispatch(
                delegatedTaskQuestionWake({
                  task,
                  childThreadId,
                  requestId: request.id,
                  blocking: true,
                }),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("catching up a delegated task question failed", {
                    taskId: task.id,
                    requestId: request.id,
                    cause,
                  }),
                ),
              );
          }
        }
        return;
      }
      if (event.type !== "runtime-request.updated" || event.payload.kind !== "user_input") {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      const key = `${parentThreadId}:${event.payload.id}`;
      const messageId = delegatedTaskQuestionMessageId(parentThreadId, event.payload.id);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
        const queued = parent.runs.find(
          (run) => run.status === "queued" && run.userMessageId === messageId,
        );
        if (queued !== undefined) {
          yield* engine.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
            threadId: parentThreadId,
            runId: queued.id,
          });
        }
        return;
      }
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
      const { runs } = yield* projections.getThreadRecords(child.id, ["runs"]);
      const run =
        runs.find((run) => run.id === event.runId) ??
        runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const taskId =
        run?.delegatedTaskId ??
        (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
      const task = parent.subagents.find(
        (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
      );
      if (
        task === undefined ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      ) {
        return;
      }
      if (
        event.payload.responseCapability.type === "live" &&
        blockingWaitDeliversQuestions(task, parent.runs)
      ) {
        return;
      }
      if (task.childThreadId === null) return;
      yield* engine.dispatch(
        delegatedTaskQuestionWake({
          task,
          childThreadId: task.childThreadId,
          requestId: request.id,
          blocking: request.responseCapability.type !== "message",
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
