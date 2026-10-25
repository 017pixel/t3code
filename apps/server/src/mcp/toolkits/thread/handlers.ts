import {
  type CommandId,
  MESH_ALL_MACHINES,
  type MeshMachineRef,
  type ProjectId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Tool } from "effect/ai";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

import * as MeshForwarding from "../../../mesh/MeshForwarding.ts";
import type * as Project from "../../../project/ProjectService.ts";
import * as McpMeshRouting from "../../McpMeshRouting.ts";

import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId && request.kind === "user_input",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    });
  return { ...context, request, item };
});
const byThread = <P extends { readonly threadId?: ThreadId | undefined }>(params: P) =>
  McpToolAccess.threadTarget(params.threadId);

const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  McpToolAccess.routed(
    { owner: byThread },
    McpToolAccess.writesThreads((params: P) => [params.threadId], handle),
  );

const readsThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.routed({ owner: byThread }, McpToolAccess.reads(handle));

type SearchInput = Tool.Parameters<typeof ThreadToolkit.tools.t3_thread_search>;
type SearchResult = Tool.Success<typeof ThreadToolkit.tools.t3_thread_search>;
type SearchRow = SearchResult["matches"][number];

/** A member past this is named in unansweredMachines instead of holding the search. */
const MEMBER_SEARCH_TIMEOUT = "10 seconds";

const searchHere = Effect.fn("mcp.searchHere")(function* (
  input: SearchInput,
  projectId: ProjectId | undefined,
) {
  const threadSearch = yield* ThreadSearch.ThreadSearch;
  const { matches } = yield* threadSearch
    .searchThreads({ ...McpMeshRouting.withoutMachine(input), projectId })
    .pipe(Effect.mapError(unavailable));
  return matches.map((match) => ({
    ...match,
    link: formatThreadLink(match.threadId, match.title),
  }));
});

/**
 * Rows from one member: its projects for this caller's repository, or all its projects for a
 * caller outside a thread. Rows carry the member so agents can call it.
 */
const searchMember = Effect.fn("mcp.searchMember")(function* (
  input: SearchInput,
  call: McpMeshRouting.MemberCall,
  callerProjectId: ProjectId | undefined,
) {
  const projectIds =
    callerProjectId === undefined
      ? [undefined]
      : (yield* McpMeshRouting.memberProjectsForRepository(call, callerProjectId)).matches.map(
          (project) => project.id,
        );
  const results = yield* Effect.forEach(projectIds, (projectId) =>
    McpMeshRouting.forwardTool(
      call.mesh,
      ThreadToolkit.tools.t3_thread_search,
      call.machine,
      {
        query: input.query,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(projectId === undefined ? {} : { projectId }),
      },
      call.options,
    ),
  );
  return results.flatMap((result) =>
    result.matches.map((row): SearchRow => ({ ...row, machine: call.machine })),
  );
});

/** Titles first, then messages, each by score, with a fifth of the slots kept for messages. */
const mergeSearchRows = (rows: ReadonlyArray<SearchRow>, limit: number) => {
  const byScore = (left: SearchRow, right: SearchRow) => (right.score ?? 0) - (left.score ?? 0);
  const titles = rows.filter((row) => row.source === "title").toSorted(byScore);
  const messages = rows.filter((row) => row.source !== "title").toSorted(byScore);
  const messageSlots = Math.min(messages.length, Math.floor(limit / 5));
  return [...titles.slice(0, limit - messageSlots), ...messages].slice(0, limit);
};

const searchThreads = Effect.fn("mcp.searchThreads")(function* (
  input: SearchInput,
): Effect.fn.Return<
  SearchResult,
  OrchestratorMcpFailure,
  | Effect.Services<ReturnType<typeof readCaller>>
  | ThreadSearch.ThreadSearch
  | Project.ProjectService
> {
  const context = yield* readCaller();
  const callerProjectId = context.caller?.projectId;
  const mesh = yield* Effect.serviceOption(MeshForwarding.MeshForwarding);
  if (context.scope.mesh !== undefined || Option.isNone(mesh)) {
    return { matches: yield* searchHere(input, input.projectId ?? callerProjectId) };
  }
  const options = McpMeshRouting.meshCallOptions(context);
  const memberCall = (machine: MeshMachineRef) => ({ mesh: mesh.value, machine, options });
  // "all" is the default mesh-wide search, not a machine name.
  const machine = input.machine === MESH_ALL_MACHINES ? undefined : input.machine;
  if (input.projectId !== undefined || machine !== undefined) {
    const placement =
      machine !== undefined
        ? yield* mesh.value.resolveMachine(machine)
        : yield* mesh.value.resolveOwner({ kind: "project", id: input.projectId! });
    if (placement._tag === "local") {
      return { matches: yield* searchHere(input, input.projectId ?? callerProjectId) };
    }
    const call = memberCall(placement.machine);
    if (input.projectId !== undefined) {
      const { matches } = yield* McpMeshRouting.forwardTool(
        mesh.value,
        ThreadToolkit.tools.t3_thread_search,
        placement.machine,
        input,
        options,
      );
      return { matches: matches.map((row) => ({ ...row, machine: placement.machine })) };
    }
    return { matches: yield* searchMember(input, call, callerProjectId) };
  }
  const members = (yield* mesh.value.machines).filter((machine) => !machine.self && machine.online);
  const [here, ...answers] = yield* Effect.all(
    [
      searchHere(input, callerProjectId),
      ...members.map(({ online: _online, self: _self, ...machine }) =>
        searchMember(input, memberCall(machine), callerProjectId).pipe(
          Effect.timeoutOption(MEMBER_SEARCH_TIMEOUT),
          Effect.orElseSucceed(() => Option.none<ReadonlyArray<SearchRow>>()),
          Effect.map((rows) => ({ machine, rows })),
        ),
      ),
    ] as const,
    { concurrency: "unbounded" },
  );
  const unanswered = answers
    .filter((answer) => Option.isNone(answer.rows))
    .map((answer) => answer.machine);
  return {
    matches: mergeSearchRows(
      [...here, ...answers.flatMap((answer) => Option.getOrElse(answer.rows, () => []))],
      input.limit ?? 50,
    ),
    ...(unanswered.length === 0 ? {} : { unansweredMachines: unanswered }),
  };
});

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      return {
        taskId: task.id,
        threadId,
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads(searchThreads),
  t3_thread_fork: McpToolAccess.routed(
    { localThreads: (input) => [input.threadId] },
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const { threads, projection } = yield* readThread(input.threadId);
          const commandId = yield* newCommandId();
          const targetThreadId = ThreadId.make(`${commandId}:fork`);
          const result = yield* threads
            .dispatch({
              type: "thread.fork",
              commandId,
              sourceThreadId: projection.thread.id,
              targetThreadId,
              sourcePoint: input.sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId };
        }),
    ),
  ),
  t3_thread_merge_back: McpToolAccess.routed(
    { localThreads: (input) => [input.targetThreadId, input.sourceThreadId] },
    McpToolAccess.writesThreads(
      (input) => [input.targetThreadId, input.sourceThreadId],
      (input) =>
        Effect.gen(function* () {
          const context = yield* readThread(input.targetThreadId);
          const source = yield* readThread(input.sourceThreadId);
          const result = yield* context.threads
            .dispatch({
              type: "thread.merge_back",
              commandId: yield* newCommandId(),
              sourceThreadId: source.projection.thread.id,
              targetThreadId: input.targetThreadId,
              sourcePoint: input.sourcePoint,
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId: input.targetThreadId };
        }),
    ),
  ),
  t3_thread_transfers: readsThread((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  ),
  t3_thread_configuration: readsThread((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    }),
  ),
  t3_thread_configure: writesThread((input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_pending_request_list: readsThread((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      return {
        requestIds: projection.runtimeRequests
          .filter((request) => request.kind === "user_input" && request.status === "pending")
          .map((request) => request.id),
      };
    }),
  ),
  t3_pending_request_read: readsThread((input) =>
    Effect.gen(function* () {
      const { item } = yield* readQuestion(input);
      return { requestId: input.requestId, questions: item.questions };
    }),
  ),
  t3_pending_request_respond: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readQuestion(input);
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          answers: input.answers,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_queue_list: readsThread((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  ),
  t3_queue_read: readsThread((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  ),
  t3_queue_edit: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  ),
  t3_queue_cancel: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  ),
  t3_queue_reorder: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  ),
  t3_queue_promote_to_steer: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
