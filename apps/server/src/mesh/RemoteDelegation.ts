// EXPERIMENTAL mesh v1: delegate_task on another member. The task lives here. The member runs an
// ordinary thread launch, and a follower here reads its state and reports it as internal commands.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- this hashes a durable id synchronously.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type EnvironmentId,
  type MeshMachineRef,
  type MeshModeLimit,
  type MeshTaskStateResponse,
  ModelSelection,
  type NodeId,
  OrchestratorMcpFailure,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentRemotePending,
  NonNegativeInt,
  Project,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type RuntimeRequestId,
  ThreadId,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  blockingWaitDeliversQuestions,
  delegatedTaskQuestionMessageId,
  delegatedTaskQuestionWake,
} from "../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as McpMeshLaunch from "../mcp/McpMeshLaunch.ts";
import { forkParked } from "../serverActivation.ts";
import * as MeshMachines from "./MeshMachines.ts";
import * as MeshTaskState from "./MeshTaskState.ts";
import * as MeshServices from "./Services.ts";

/** The Connect edge drops requests idle for about 100 s. */
const WAIT_PIECE_MS = 50_000;
/** The member's own run is done but its children are not; nothing on the member long-polls that. */
const CHILDREN_POLL = Duration.seconds(15);
const MAX_RETRY_DELAY = Duration.minutes(5);

/** A fixed-length digest leaves room for operation suffixes and replays launches after a restart. */
const remoteTaskLaunchKey = (taskId: NodeId) =>
  `delegated-task:${NodeCrypto.createHash("sha256").update(taskId).digest("base64url")}`;

const remoteTaskCommandId = (operation: string, taskId: NodeId, suffix?: string) =>
  CommandId.make(
    ["command", "mesh", `delegated-task-${operation}`, taskId, ...(suffix ? [suffix] : [])].join(
      ":",
    ),
  );

/** What the follower does after one look at a task. */
export type RemoteTaskStep =
  | { readonly type: "done" }
  /** Look again at once, for example after the launch attached. */
  | { readonly type: "next" }
  /** The member's thread is working: long-poll it. */
  | {
      readonly type: "wait";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly modeLimit: MeshModeLimit;
    }
  /** Only the member's nested children are working: look again later. */
  | { readonly type: "idle" }
  /** The member did not answer, or a write here failed. */
  | { readonly type: "retry" };

type RemoteTask = {
  readonly parent: ProjectionStore.ProjectionRecords<"subagents" | "runs">;
  readonly task: OrchestrationV2Subagent;
  readonly remote: NonNullable<OrchestrationV2Subagent["remote"]>;
};

type LaunchWaiter = {
  readonly result: Deferred.Deferred<OrchestrationV2Subagent, OrchestratorMcpFailure>;
  readonly report: "caller" | "parent";
};

/** The member refused the launch for good: not exactly one matching project, or an unreadable reply. */
class RemoteLaunchRefusedError extends Schema.TaggedError<RemoteLaunchRefusedError>()(
  "RemoteLaunchRefusedError",
  { message: Schema.String },
) {}

type MemberError =
  | MeshServices.MeshCredentialsError
  | MeshServices.MeshRemoteToolError
  | MeshTaskState.MeshTaskStateRequestError
  | RemoteLaunchRefusedError;

/** Errors a later attempt can get past. Everything else ends the task. */
const isTransient = (error: MemberError): boolean =>
  error._tag === "MeshUnavailableError" ||
  error._tag === "MeshGrantRefusedError" ||
  error._tag === "MeshMemberOfflineError" ||
  error._tag === "MeshMemberUnreachableError" ||
  error._tag === "MeshSessionRefusedError" ||
  error._tag === "MeshTaskStateRequestError";

const isFailureCode = Schema.is(OrchestratorMcpFailure.fields.code);

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

function memberFailure(error: MemberError, label: string): OrchestratorMcpFailure {
  switch (error._tag) {
    case "MeshUnavailableError":
      return failure("mesh_unavailable", error.message);
    case "MeshNotMemberError":
      return failure("machine_not_found", `${label} is no longer in the mesh.`);
    case "MeshMemberOfflineError":
      return failure("machine_offline", `${label} is offline.`);
    case "MeshRemoteToolError":
      return failure(
        isFailureCode(error.code) ? error.code : "orchestration_error",
        `${label}: ${error.message}`,
      );
    case "RemoteLaunchRefusedError":
      return failure("invalid_request", error.message);
    default:
      return failure("machine_unreachable", `${label} did not answer: ${error.message}`);
  }
}

const isTransientFailure = (error: OrchestratorMcpFailure) =>
  error.code === "orchestration_error" ||
  error.code === "mesh_unavailable" ||
  error.code === "machine_offline" ||
  error.code === "machine_unreachable";

const ProjectPage = Schema.Struct({
  projects: Schema.Array(Project),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
const decodeProjectPage = Schema.decodeUnknownEffect(ProjectPage);
const decodeCapabilities = Schema.decodeUnknownEffect(
  Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        providerInstanceId: ProviderInstanceId,
        models: Schema.Array(Schema.Struct({ id: Schema.String })),
      }),
    ),
  }),
);
const decodeLaunch = Schema.decodeUnknownEffect(
  Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
  }),
);

const samePending = (
  left: OrchestrationV2SubagentRemotePending | undefined,
  right: OrchestrationV2SubagentRemotePending | null,
) => (left?.requestId ?? null) === (right?.requestId ?? null) && left?.kind === right?.kind;

const settledTaskStatus = (status: MeshTaskStateResponse["status"]) =>
  status === "failed" || status === "cancelled" || status === "interrupted" ? status : "completed";

export class RemoteDelegation extends Context.Service<
  RemoteDelegation,
  {
    /** Another member named by id or label, or none when `machine` names this one. */
    readonly resolveMachine: (
      machine: string,
    ) => Effect.Effect<Option.Option<MeshMachineRef>, OrchestratorMcpFailure>;
    /**
     * Follows a recorded task and waits for its next launch attempt; repeats are safe. A refusal
     * ends the task, delivered to the parent agent unless `report` is `caller`, which tells the
     * agent through the returned error instead.
     */
    readonly launch: (input: {
      readonly parentThreadId: ThreadId;
      readonly taskId: NodeId;
      readonly report: "caller" | "parent";
    }) => Effect.Effect<OrchestrationV2Subagent, OrchestratorMcpFailure>;
    /** The member's live state for an attached task. Nothing is copied here. */
    readonly readState: (
      remote: NonNullable<OrchestrationV2Subagent["remote"]>,
    ) => Effect.Effect<MeshTaskStateResponse, OrchestratorMcpFailure>;
    /** One look at a task. The follower repeats it; callers use it to act without waiting. */
    readonly step: (parentThreadId: ThreadId, taskId: NodeId) => Effect.Effect<RemoteTaskStep>;
    /** Follows a task in the background until it settles; a no-op while one already does. */
    readonly follow: (parentThreadId: ThreadId, taskId: NodeId) => Effect.Effect<void>;
    /** Relaunches pending tasks and follows open ones, then every task that opens later. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/mesh/RemoteDelegation") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const membership = yield* MeshServices.MeshMembership;
  const mcp = yield* MeshServices.MeshMcpClient;
  const taskStates = yield* MeshTaskState.MeshTaskStateClient;
  const followers = yield* FiberMap.make<NodeId>();
  const launchWaiters = new Map<NodeId, Set<LaunchWaiter>>();
  // This process's question wakes, and the message questions each task has open on its member.
  const woken = new Set<string>();
  const messageQuestions = new Map<NodeId, ReadonlyArray<RuntimeRequestId>>();

  const resolveMachine = (machine: string) => MeshMachines.resolveMachine(membership, machine);

  const loadTask = Effect.fn("RemoteDelegation.loadTask")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
  ) {
    const parent = yield* orchestrator.getThreadRecords(parentThreadId, ["subagents", "runs"]);
    const task = parent.subagents.find(
      (candidate) => candidate.id === taskId && candidate.origin === "app_owned",
    );
    return task?.remote === undefined
      ? undefined
      : ({ parent, task, remote: task.remote } satisfies RemoteTask);
  });

  const parentModes = (loaded: RemoteTask): MeshModeLimit => ({
    runtimeMode: loaded.parent.thread.runtimeMode,
    interactionMode: loaded.parent.thread.interactionMode,
  });

  /** Ends the task here. A no-op on a task that already ended and owes no stop. */
  const complete = (
    loaded: RemoteTask,
    outcome: {
      readonly status: "completed" | "failed" | "cancelled" | "interrupted";
      readonly result: string;
      readonly disposeDelivery?: boolean;
    },
  ) =>
    !isOrchestrationV2WorkActive(loaded.task.status) && loaded.remote.stopOwed !== true
      ? Effect.void
      : orchestrator
          .dispatch({
            type: "delegated_task.remote.complete",
            commandId: remoteTaskCommandId("complete", loaded.task.id),
            parentThreadId: loaded.task.threadId,
            taskId: loaded.task.id,
            ...outcome,
          })
          .pipe(Effect.asVoid);

  const matchProject = Effect.fn("RemoteDelegation.matchProject")(function* (
    loaded: RemoteTask,
    repositoryKey: string,
    call: (
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<unknown, MemberError>,
  ) {
    const projects = yield* McpMeshLaunch.listMemberProjects((page) =>
      call("t3_project_list", page).pipe(
        Effect.flatMap((raw) =>
          decodeProjectPage(raw).pipe(
            Effect.mapError(
              () =>
                new RemoteLaunchRefusedError({
                  message: `${loaded.remote.label} sent a project list this machine cannot read.`,
                }),
            ),
          ),
        ),
      ),
    );
    const match = McpMeshLaunch.matchRepositoryProject(
      loaded.remote.label,
      repositoryKey,
      projects,
    );
    if (match._tag === "found") return match.projectId;
    return yield* new RemoteLaunchRefusedError({
      message: `${match.reason} A task there needs exactly one checkout of the repository.`,
    });
  });

  const launchOnMember = Effect.fn("RemoteDelegation.launchOnMember")(function* (
    loaded: RemoteTask,
  ) {
    const { task, remote } = loaded;
    const launch = remote.launch;
    if (launch === undefined) {
      return yield* new RemoteLaunchRefusedError({ message: "The task has no launch record." });
    }
    const key = remoteTaskLaunchKey(task.id);
    const call = (tool: string, args: Readonly<Record<string, unknown>>) =>
      mcp.callTool(remote.environmentId, tool, args, {
        modeLimit: { runtimeMode: launch.runtimeMode, interactionMode: launch.interactionMode },
        requestKey: `${key}:${tool}`,
        caller: { kind: "thread", threadId: task.threadId },
      });
    const projectId = yield* matchProject(loaded, launch.repositoryKey, call);
    // A target resolves there, inheriting from the parent's model. Without one, the parent's model
    // is used when the member has it, else the member project's default.
    const modelSelection =
      launch.target !== undefined
        ? task.modelSelection
        : yield* McpMeshLaunch.modelOnMember(task.modelSelection, (search) =>
            call("orchestrator_capabilities", { search }).pipe(
              Effect.flatMap((raw) =>
                decodeCapabilities(raw).pipe(Effect.orElseSucceed(() => ({ providers: [] }))),
              ),
            ),
          );
    const launched = yield* mcp
      .callTool(
        remote.environmentId,
        "t3_thread_launch",
        {
          projectId,
          title: task.title ?? task.prompt.slice(0, 80),
          message: task.prompt,
          runtimeMode: launch.runtimeMode,
          interactionMode: launch.interactionMode,
          clientRequestId: key,
          ...(modelSelection === undefined ? {} : { modelSelection }),
          ...(launch.target === undefined ? {} : { target: launch.target }),
          ...(launch.workspaceStrategy === undefined
            ? {}
            : { workspaceStrategy: launch.workspaceStrategy }),
        },
        {
          modeLimit: { runtimeMode: launch.runtimeMode, interactionMode: launch.interactionMode },
          requestKey: key,
          caller: { kind: "thread", threadId: task.threadId, delegated: true },
        },
      )
      .pipe(
        Effect.flatMap((raw) =>
          decodeLaunch(raw).pipe(
            Effect.mapError(
              () =>
                new RemoteLaunchRefusedError({
                  message: `${remote.label} launched the task but sent a reply this machine cannot read.`,
                }),
            ),
          ),
        ),
      );
    if (launched.runId === null) {
      return yield* new RemoteLaunchRefusedError({
        message: `${remote.label} created thread ${launched.threadId} without starting it.`,
      });
    }
    return { ...launched, runId: launched.runId };
  });

  const launchAttempt = Effect.fn("RemoteDelegation.launchAttempt")(
    function* (parentThreadId: ThreadId, taskId: NodeId) {
      const dispatchFailure = (error: unknown) =>
        failure("orchestration_error", `Unable to record the remote task: ${String(error)}`);
      const loaded = yield* loadTask(parentThreadId, taskId).pipe(Effect.mapError(dispatchFailure));
      if (loaded === undefined) {
        return yield* failure("task_not_found", `Remote task ${taskId} was not found.`);
      }
      if (loaded.remote.threadId !== null) return loaded.task;
      const launched = yield* launchOnMember(loaded).pipe(
        Effect.catch((error: MemberError) => {
          const reported = memberFailure(error, loaded.remote.label);
          if (isTransient(error)) return Effect.fail(reported);
          return complete(loaded, {
            status: "failed",
            result: reported.message,
            ...([...(launchWaiters.get(taskId) ?? [])].some((waiter) => waiter.report === "caller")
              ? { disposeDelivery: true }
              : {}),
          }).pipe(Effect.mapError(dispatchFailure), Effect.andThen(Effect.fail(reported)));
        }),
      );
      yield* orchestrator
        .dispatch({
          type: "delegated_task.remote.attach",
          commandId: remoteTaskCommandId("attach", loaded.task.id),
          parentThreadId,
          taskId,
          threadId: launched.threadId,
          runId: launched.runId,
          modelSelection: launched.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
      const attached = yield* loadTask(parentThreadId, taskId).pipe(
        Effect.mapError(dispatchFailure),
      );
      return attached?.task ?? loaded.task;
    },
    (effect, _parentThreadId, taskId) =>
      effect.pipe(
        Effect.onExit((exit) => {
          const result =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Exit.fail(failure("orchestration_error", "The task was stopped before it started."))
              : exit;
          return Effect.forEach(
            launchWaiters.get(taskId) ?? [],
            (waiter) => Deferred.done(waiter.result, result),
            {
              discard: true,
            },
          );
        }),
      ),
  );

  const readState: RemoteDelegation["Service"]["readState"] = (remote) =>
    remote.threadId === null || remote.runId === null
      ? Effect.fail(
          failure("machine_unreachable", `The task has not started on ${remote.label} yet.`),
        )
      : taskStates
          .read(remote.environmentId, { threadId: remote.threadId, runId: remote.runId })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "MeshTaskStateNotFoundError"
                ? failure(
                    "thread_not_found",
                    `The task's thread no longer exists on ${remote.label}.`,
                  )
                : memberFailure(error, remote.label),
            ),
          );

  /** Stops the member's thread, its own delegated tasks included, then clears the owed stop. */
  const stopOnMember = Effect.fn("RemoteDelegation.stopOnMember")(function* (
    loaded: RemoteTask,
    threadId: ThreadId,
  ) {
    const key = `${remoteTaskLaunchKey(loaded.task.id)}:stop`;
    const stopped = yield* mcp
      .callTool(
        loaded.remote.environmentId,
        "t3_thread_interrupt",
        { threadId, stop: true, clientRequestId: key, reason: "The delegating thread stopped." },
        {
          modeLimit: parentModes(loaded),
          requestKey: key,
          caller: { kind: "thread", threadId: loaded.task.threadId },
        },
      )
      .pipe(
        Effect.as(true),
        Effect.catch((error: MemberError) =>
          isTransient(error)
            ? Effect.succeed(false)
            : // Refused for good (thread gone, or raised above our modes there): nothing to retry.
              Effect.logWarning("mesh.remote-task.stop-refused", {
                taskId: loaded.task.id,
                error,
              }).pipe(Effect.as(true)),
        ),
      );
    if (!stopped) return { type: "retry" } as const;
    yield* complete(loaded, { status: "cancelled", result: loaded.task.result ?? "Stopped." });
    return { type: "done" } as const;
  });

  /**
   * Wakes the parent about a question on the member. Wakes are keyed by request, so this sends each
   * one once per process and a restart re-sends it, replaying a wake that already landed.
   */
  const wakeParent = (
    loaded: RemoteTask,
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    blocking: boolean,
  ) => {
    const key = `${loaded.task.id}:${requestId}`;
    if (
      woken.has(key) ||
      (blocking && blockingWaitDeliversQuestions(loaded.task, loaded.parent.runs))
    ) {
      return Effect.void;
    }
    woken.add(key);
    return orchestrator
      .dispatch(
        delegatedTaskQuestionWake({
          task: loaded.task,
          childThreadId: threadId,
          requestId,
          blocking,
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("mesh.remote-task.question-wake-failed", {
            taskId: loaded.task.id,
            requestId,
            cause,
          }),
        ),
      );
  };

  /** Cancels a queued wake for a question answered or dismissed on the member first. */
  const withdrawWake = Effect.fn("RemoteDelegation.withdrawWake")(function* (
    loaded: RemoteTask,
    requestId: RuntimeRequestId,
  ) {
    const parentThreadId = loaded.task.threadId;
    const messageId = delegatedTaskQuestionMessageId(parentThreadId, requestId);
    const queued = loaded.parent.runs.find(
      (run) => run.status === "queued" && run.userMessageId === messageId,
    );
    if (queued === undefined) return;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make(
        `server:delegated-task-question-cancel:${parentThreadId}:${requestId}`,
      ),
      threadId: parentThreadId,
      runId: queued.id,
    });
  });

  /** Records a changed question or approval on the task; the record ends a blocking wait. */
  const reportPending = Effect.fn("RemoteDelegation.reportPending")(function* (
    loaded: RemoteTask,
    pending: OrchestrationV2SubagentRemotePending | null,
  ) {
    const { task, remote } = loaded;
    const previous = remote.pending;
    yield* orchestrator.dispatch({
      type: "delegated_task.remote.progress",
      commandId: remoteTaskCommandId(
        "progress",
        task.id,
        pending === null ? `clear:${previous?.requestId}` : pending.requestId,
      ),
      parentThreadId: task.threadId,
      taskId: task.id,
      pending,
    });
    if (previous?.kind === "question" && previous.requestId !== pending?.requestId) {
      yield* withdrawWake(loaded, previous.requestId);
    }
  });

  /**
   * Questions asked by message do not block the member's work, so they only wake the parent, as
   * a local child's do, and never end a wait.
   */
  const reportMessageQuestions = Effect.fn("RemoteDelegation.reportMessageQuestions")(function* (
    loaded: RemoteTask,
    threadId: ThreadId,
    open: ReadonlyArray<RuntimeRequestId>,
  ) {
    const seen = messageQuestions.get(loaded.task.id) ?? [];
    for (const requestId of open) yield* wakeParent(loaded, threadId, requestId, false);
    for (const requestId of seen) {
      if (!open.includes(requestId)) yield* withdrawWake(loaded, requestId);
    }
    if (open.length === 0) messageQuestions.delete(loaded.task.id);
    else messageQuestions.set(loaded.task.id, open);
  });

  const observe = Effect.fn("RemoteDelegation.observe")(function* (
    loaded: RemoteTask,
    threadId: ThreadId,
    runId: RunId,
  ) {
    const { remote } = loaded;
    const read = yield* taskStates
      .read(remote.environmentId, { threadId, runId })
      .pipe(Effect.result);
    if (read._tag === "Failure") {
      const error = read.failure;
      if (error._tag !== "MeshTaskStateNotFoundError" && isTransient(error)) {
        return { type: "retry" } as const;
      }
      yield* complete(loaded, {
        status: "failed",
        result:
          error._tag === "MeshTaskStateNotFoundError"
            ? `The task's thread no longer exists on ${remote.label}.`
            : memberFailure(error, remote.label).message,
      });
      return { type: "done" } as const;
    }
    const state = read.success;
    if (state.settled) {
      // A question asked during the last wait piece wakes the parent ahead of the result.
      yield* reportMessageQuestions(loaded, threadId, state.messageQuestionRequestIds ?? []);
      messageQuestions.delete(loaded.task.id);
      yield* complete(loaded, {
        status: settledTaskStatus(state.status),
        result: state.result ?? `The task ended on ${remote.label} with status ${state.status}.`,
      });
      return { type: "done" } as const;
    }
    const pending: OrchestrationV2SubagentRemotePending | null =
      state.pendingQuestionRequestId != null
        ? { kind: "question", requestId: state.pendingQuestionRequestId }
        : state.pendingApproval !== null
          ? { kind: "approval", requestId: state.pendingApproval.requestId }
          : null;
    if (!samePending(remote.pending, pending)) yield* reportPending(loaded, pending);
    // Also after a restart between recording a question and waking the parent for it.
    if (pending?.kind === "question") {
      yield* wakeParent(loaded, threadId, pending.requestId, true);
    }
    yield* reportMessageQuestions(loaded, threadId, state.messageQuestionRequestIds ?? []);
    return state.workState === "working"
      ? ({
          type: "wait",
          environmentId: remote.environmentId,
          threadId,
          modeLimit: parentModes(loaded),
        } as const)
      : ({ type: "idle" } as const);
  });

  const step: RemoteDelegation["Service"]["step"] = Effect.fn("RemoteDelegation.step")(
    function* (parentThreadId, taskId) {
      const loaded = yield* loadTask(parentThreadId, taskId);
      if (loaded === undefined) return { type: "done" } as const;
      const { task, remote } = loaded;
      const active = isOrchestrationV2WorkActive(task.status);
      if (remote.threadId === null || remote.runId === null) {
        // Cancelled before it attached: the launch may have landed, so it is replayed to learn
        // the member's thread and stop it.
        if (!active && remote.stopOwed !== true) return { type: "done" } as const;
        return yield* launchAttempt(parentThreadId, taskId).pipe(
          Effect.as({ type: "next" } as const),
          Effect.catch((error) =>
            Effect.succeed(
              isTransientFailure(error)
                ? ({ type: "retry" } as const)
                : ({ type: "done" } as const),
            ),
          ),
        );
      }
      if (remote.stopOwed === true) return yield* stopOnMember(loaded, remote.threadId);
      if (!active) return { type: "done" } as const;
      return yield* observe(loaded, remote.threadId, remote.runId);
    },
    (effect, parentThreadId, taskId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("mesh.remote-task.step-failed", { parentThreadId, taskId, cause }).pipe(
            Effect.as({ type: "retry" } as const),
          ),
        ),
      ),
  );

  const retryDelay = (failures: number) =>
    Duration.min(Duration.seconds(2 ** Math.min(failures, 10)), MAX_RETRY_DELAY);

  const drive = Effect.fn("RemoteDelegation.drive")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
  ) {
    let failures = 0;
    while (true) {
      const next = yield* step(parentThreadId, taskId);
      switch (next.type) {
        case "done":
          return;
        case "next":
          failures = 0;
          break;
        case "idle":
          failures = 0;
          yield* Effect.sleep(CHILDREN_POLL);
          break;
        case "retry":
          failures += 1;
          yield* Effect.sleep(retryDelay(failures));
          break;
        case "wait": {
          const waited = yield* mcp
            .callTool(
              next.environmentId,
              "t3_thread_wait",
              { threadId: next.threadId, timeoutMs: WAIT_PIECE_MS },
              { modeLimit: next.modeLimit },
            )
            .pipe(Effect.result);
          failures = waited._tag === "Success" ? 0 : failures + 1;
          if (failures > 0) yield* Effect.sleep(retryDelay(failures));
          break;
        }
      }
    }
  });

  const follow: RemoteDelegation["Service"]["follow"] = (parentThreadId, taskId) =>
    FiberMap.run(followers, taskId, drive(parentThreadId, taskId), { onlyIfMissing: true }).pipe(
      Effect.asVoid,
    );

  const launch: RemoteDelegation["Service"]["launch"] = Effect.fn("RemoteDelegation.launch")(
    function* ({ parentThreadId, taskId, report }) {
      const result = yield* Deferred.make<OrchestrationV2Subagent, OrchestratorMcpFailure>();
      const waiter: LaunchWaiter = { result, report };
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const waiters = launchWaiters.get(taskId) ?? new Set<LaunchWaiter>();
          waiters.add(waiter);
          launchWaiters.set(taskId, waiters);
          return waiters;
        }),
        () =>
          Effect.gen(function* () {
            const loaded = yield* loadTask(parentThreadId, taskId).pipe(
              Effect.mapError((error) =>
                failure("orchestration_error", `Unable to read the remote task: ${String(error)}`),
              ),
            );
            if (loaded === undefined) {
              return yield* failure("task_not_found", `Remote task ${taskId} was not found.`);
            }
            if (
              loaded.remote.threadId !== null ||
              (!isOrchestrationV2WorkActive(loaded.task.status) && loaded.remote.stopOwed !== true)
            )
              return loaded.task;
            yield* follow(parentThreadId, taskId);
            return yield* Deferred.await(result);
          }),
        (waiters) =>
          Effect.sync(() => {
            waiters.delete(waiter);
            if (waiters.size === 0) launchWaiters.delete(taskId);
          }),
      );
    },
  );

  const start: RemoteDelegation["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
            if (event.type !== "subagent.updated") return Effect.void;
            const task = event.payload;
            const remote = task.remote;
            if (task.origin !== "app_owned" || remote === undefined) return Effect.void;
            // A follower may sit in a long wait on the member; a new one delivers the stop now.
            if (remote.stopOwed === true) {
              return FiberMap.run(followers, task.id, drive(task.threadId, task.id)).pipe(
                Effect.asVoid,
              );
            }
            return isOrchestrationV2WorkActive(task.status)
              ? follow(task.threadId, task.id)
              : Effect.void;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("mesh.remote-task.event-stream-failed", { cause }),
            ),
          ),
        );
        const threadIds = yield* projections.getRecoveryThreadIds("remote-delegations");
        for (const threadId of threadIds) {
          const { subagents } = yield* orchestrator.getThreadRecords(threadId, ["subagents"]);
          for (const task of subagents) {
            if (
              task.remote !== undefined &&
              (isOrchestrationV2WorkActive(task.status) || task.remote.stopOwed === true)
            ) {
              yield* follow(threadId, task.id);
            }
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("mesh.remote-task.recovery-failed", { cause }),
        ),
      ),
    );

  return RemoteDelegation.of({ resolveMachine, launch, readState, step, follow, start });
});

export const layer = Layer.effect(RemoteDelegation, make);
