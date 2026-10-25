import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpThreadInterruptInput,
  type NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { delegatedTaskQuestionMessageId } from "../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";
import * as MeshServices from "./Services.ts";
import {
  layerOrchestration,
  makeMember,
  memberEnvironmentId,
  memberProject,
  memberProjectId,
  memberRunId,
  memberThreadId,
  modelSelection,
  readTask,
  requestRemoteTask,
  seedParent,
} from "./RemoteDelegation.testkit.ts";

type Member = Effect.Success<ReturnType<typeof makeMember>>;
const decodeDelegateTask = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskInput);
const decodeLaunchThread = Schema.decodeUnknownEffect(
  ProjectToolkit.tools.t3_thread_launch.parametersSchema,
);
const decodeInterruptThread = Schema.decodeUnknownEffect(OrchestratorMcpThreadInterruptInput);

const layerMcpService = OrchestratorMcpService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    ),
  ),
);

/** Runs `body` against a fresh orchestrator, a scripted member, and the MCP service. */
const withMember = <A, E, R>(body: (member: Member) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const member = yield* makeMember();
    const layer = layerMcpService.pipe(
      Layer.provideMerge(RemoteDelegation.layer),
      Layer.provideMerge(member.layer),
      Layer.provideMerge(layerOrchestration),
    );
    return yield* body(member).pipe(Effect.provide(layer));
  });

const threadScope = (threadId: Effect.Success<ReturnType<typeof seedParent>>["threadId"]) =>
  ({
    environmentId: EnvironmentId.make("environment:laptop"),
    requestNamespace: "provider-session:remote",
    thread: {
      threadId,
      providerSessionId: "provider-session:remote",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  }) satisfies McpInvocationScope;

const launched = (parent: Effect.Success<ReturnType<typeof seedParent>>, taskId: NodeId) =>
  Effect.flatMap(RemoteDelegation.RemoteDelegation, (delegation) =>
    delegation.launch({ parentThreadId: parent.threadId, taskId, report: "parent" }),
  );

const step = (parent: Effect.Success<ReturnType<typeof seedParent>>, taskId: NodeId) =>
  Effect.flatMap(RemoteDelegation.RemoteDelegation, (delegation) =>
    delegation.step(parent.threadId, taskId),
  );

describe("remote delegate_task", () => {
  it.effect("attaches and follows a launch after its caller is interrupted", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("interrupted-launch");
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const mcp = yield* MeshServices.MeshMcpClient;
        const callTool = mcp.callTool;
        const landed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let launchCount = 0;
        let launchInterrupted = false;
        Object.assign(mcp, {
          callTool: (...args: Parameters<typeof callTool>) =>
            callTool(...args).pipe(
              Effect.tap(() =>
                args[1] === "t3_thread_launch"
                  ? Effect.sync(() => {
                      launchCount += 1;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(landed, undefined)),
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.void,
              ),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  launchInterrupted = true;
                }),
              ),
            ),
        });
        const caller = yield* service
          .delegateTask(threadScope(parent.threadId), {
            task: "Run the tests.",
            machine: "box",
            mode: "async",
            clientRequestId: "interrupted-launch",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(landed);
        yield* Fiber.interrupt(caller);
        assert.isFalse(launchInterrupted);
        yield* Deferred.succeed(release, undefined);
        yield* member.takeCall("t3_thread_wait");

        const { subagents } = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(
          parent.threadId,
          ["subagents"],
        );
        assert.equal(launchCount, 1);
        assert.equal(subagents[0]?.status, "running");
        assert.equal(subagents[0]?.remote?.threadId, memberThreadId);
        assert.equal(subagents[0]?.remote?.runId, memberRunId);
      }),
    ),
  );

  it.effect("retries a lost launch reply with the same key after its caller is interrupted", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("interrupted-retry");
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const mcp = yield* MeshServices.MeshMcpClient;
        const callTool = mcp.callTool;
        const landed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const failed = yield* Deferred.make<void>();
        let firstLaunch = true;
        Object.assign(mcp, {
          callTool: (...args: Parameters<typeof callTool>) =>
            callTool(...args).pipe(
              Effect.flatMap((result) => {
                if (args[1] !== "t3_thread_launch" || !firstLaunch) return Effect.succeed(result);
                firstLaunch = false;
                return Deferred.succeed(landed, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Deferred.succeed(failed, undefined)),
                  Effect.andThen(
                    Effect.fail(
                      new MeshServices.MeshMemberUnreachableError({
                        environmentId: memberEnvironmentId,
                      }),
                    ),
                  ),
                );
              }),
            ),
        });
        const caller = yield* service
          .delegateTask(threadScope(parent.threadId), {
            task: "Run the tests.",
            machine: "box",
            clientRequestId: "interrupted-retry",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(landed);
        const first = yield* member.takeCall("t3_thread_launch");
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(failed);
        yield* TestClock.adjust("2 seconds");
        const retry = yield* member.takeCall("t3_thread_launch");
        yield* member.takeCall("t3_thread_wait");

        assert.equal(retry.args.clientRequestId, first.args.clientRequestId);
        assert.equal(retry.options.requestKey, first.options.requestKey);
        const { subagents } = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(
          parent.threadId,
          ["subagents"],
        );
        assert.equal(subagents[0]?.status, "running");
        assert.equal(subagents[0]?.remote?.threadId, memberThreadId);
      }),
    ),
  );

  it.effect("keeps following when the first attach cannot be committed", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("attach-retry");
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const dispatch = orchestrator.dispatch;
        let firstAttach = true;
        Object.assign(orchestrator, {
          dispatch: (command: Parameters<typeof dispatch>[0]) => {
            if (command.type !== "delegated_task.remote.attach" || !firstAttach) {
              return dispatch(command);
            }
            firstAttach = false;
            return Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "The test storage write failed.",
              }),
            );
          },
        });
        const error = yield* service
          .delegateTask(threadScope(parent.threadId), {
            task: "Run the tests.",
            machine: "box",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");
        const first = yield* member.takeCall("t3_thread_launch");
        yield* TestClock.adjust("2 seconds");
        const retry = yield* member.takeCall("t3_thread_launch");
        yield* member.takeCall("t3_thread_wait");
        assert.equal(retry.args.clientRequestId, first.args.clientRequestId);
        const { subagents } = yield* orchestrator.getThreadRecords(parent.threadId, ["subagents"]);
        assert.equal(subagents[0]?.status, "running");
        assert.equal(subagents[0]?.remote?.threadId, memberThreadId);
      }),
    ),
  );

  it.effect("records the task, launches it on the member, and reports the member's thread", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("mcp-launch");
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(threadScope(parent.threadId), {
          task: "Run the test suite on the box.",
          machine: "box",
        });
        assert.equal(result.childThreadId, memberThreadId);
        assert.equal(result.childEnvironmentId, memberEnvironmentId);
        assert.equal(result.childRunId, memberRunId);
        assert.equal(result.status, "running");
        assert.equal(result.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
        assert.include(result.link ?? "", `](t3-thread://v1/${memberThreadId})`);

        const launch = yield* member.takeCall("t3_thread_launch");
        assert.equal(launch.args.projectId, memberProjectId);
        assert.match(String(launch.args.clientRequestId), /^delegated-task:[\w-]{43}$/);
        assert.deepEqual(launch.args.modelSelection, modelSelection);
        assert.equal(launch.options.requestKey, launch.args.clientRequestId);
        assert.deepStrictEqual(launch.options.caller, {
          kind: "thread",
          threadId: parent.threadId,
          delegated: true,
        });

        const { task, item } = yield* readTask(parent.threadId, result.taskId);
        assert.isNull(task.childThreadId);
        assert.deepEqual(task.remote?.threadId, memberThreadId);
        assert.equal(task.status, "running");
        assert.equal(item?.type === "subagent" ? item.remote?.label : undefined, "box");
        const running = yield* service.taskStatus(threadScope(parent.threadId), result.taskId);
        assert.equal(running.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
        assert.equal(running.link, result.link);
        yield* member.setState({ hasPendingQuestion: true });
        const asking = yield* service.taskStatus(threadScope(parent.threadId), result.taskId);
        assert.notProperty(asking, "next");
        assert.equal(asking.link, result.link);
      }),
    ),
  );

  it.effect.each([256, 159])(
    "keeps remote launch and stop IDs within MCP input limits for %i characters",
    (length) =>
      withMember((member) =>
        Effect.gen(function* () {
          const parent = yield* seedParent("request-id-boundaries");
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const input = yield* decodeDelegateTask({
            task: "Run the tests.",
            machine: "box",
            clientRequestId: "x".repeat(length),
          });
          const result = yield* service.delegateTask(threadScope(parent.threadId), input);
          const launch = yield* member.takeCall("t3_thread_launch");
          yield* decodeLaunchThread(launch.args);
          yield* service.cancelTask(threadScope(parent.threadId), { taskId: result.taskId });
          yield* step(parent, result.taskId);
          const stop = yield* member.takeCall("t3_thread_interrupt");
          yield* decodeInterruptThread(stop.args);
          assert.equal(stop.args.clientRequestId, `${launch.args.clientRequestId}:stop`);
        }),
      ),
  );

  it.effect("completes with the member's result and claims a wake for the parent", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("complete");
        const taskId = yield* requestRemoteTask(parent);
        yield* launched(parent, taskId);
        yield* member.setState({
          workState: "result_available",
          status: "completed",
          result: "All 412 tests pass.",
          settled: true,
        });
        assert.equal((yield* step(parent, taskId)).type, "done");

        const { task, item, node, runs } = yield* readTask(parent.threadId, taskId);
        assert.equal(task.status, "completed");
        assert.equal(task.result, "All 412 tests pass.");
        assert.equal(task.completionDelivery?.state, "claimed");
        assert.equal(item?.type === "subagent" ? item.result : undefined, "All 412 tests pass.");
        assert.equal(node?.status, "completed");
        const parentRun = runs.find((run) => run.id === parent.runId);
        assert.deepEqual(parentRun?.delegatedCompletion?.delivery?.taskIds, [taskId]);
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const completed = yield* service.taskStatus(threadScope(parent.threadId), taskId);
        assert.notProperty(completed, "next");
        assert.include(completed.link ?? "", `](t3-thread://v1/${memberThreadId})`);
      }),
    ),
  );

  it.effect("waits while only the member's nested children work", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("nested");
        const taskId = yield* requestRemoteTask(parent);
        yield* launched(parent, taskId);
        yield* member.setState({ workState: "waiting_for_children" });
        assert.equal((yield* step(parent, taskId)).type, "idle");
        assert.equal((yield* readTask(parent.threadId, taskId)).task.status, "running");

        yield* member.setState({
          workState: "result_available",
          status: "completed",
          result: "Nested work merged.",
          settled: true,
        });
        assert.equal((yield* step(parent, taskId)).type, "done");
        assert.equal((yield* readTask(parent.threadId, taskId)).task.result, "Nested work merged.");
      }),
    ),
  );

  it.effect("wakes the parent about a question on the member, and withdraws it once answered", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("question");
        const taskId = yield* requestRemoteTask(parent);
        yield* launched(parent, taskId);
        const requestId = RuntimeRequestId.make("request:box-question");
        yield* member.setState({ hasPendingQuestion: true, pendingQuestionRequestId: requestId });
        assert.equal((yield* step(parent, taskId)).type, "wait");

        const asked = yield* readTask(parent.threadId, taskId);
        assert.deepEqual(asked.task.remote?.pending, { kind: "question", requestId });
        assert.equal(asked.task.progress, "Question waiting on box");
        const messageId = delegatedTaskQuestionMessageId(parent.threadId, requestId);
        const wake = asked.messages.find((message) => message.id === messageId);
        assert.include(wake?.text ?? "", `threadId ${memberThreadId}`);
        const queued = asked.runs.find((run) => run.userMessageId === messageId);
        assert.equal(queued?.status, "queued");

        yield* member.setState({});
        assert.equal((yield* step(parent, taskId)).type, "wait");
        const answered = yield* readTask(parent.threadId, taskId);
        assert.isUndefined(answered.task.remote?.pending);
        assert.isUndefined(answered.task.progress);
        assert.equal(answered.runs.find((run) => run.id === queued?.id)?.status, "cancelled");
      }),
    ),
  );

  it.effect("ends a mode=wait delegate_task on a question on the member", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("wait-question");
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegation = yield* Effect.forkChild(
          service.delegateTask(threadScope(parent.threadId), {
            task: "Ask before deleting anything.",
            machine: "box",
            mode: "wait",
          }),
        );
        yield* member.takeCall("t3_thread_launch");
        const { subagents } = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(
          parent.threadId,
          ["subagents"],
        );
        const taskId = subagents[0]!.id;
        // Repeating the launch only replays it, whichever of the two attaches first.
        yield* launched(parent, taskId);
        const requestId = RuntimeRequestId.make("request:wait-question");
        yield* member.setState({ hasPendingQuestion: true, pendingQuestionRequestId: requestId });
        yield* step(parent, taskId);

        const result = yield* Fiber.join(delegation);
        assert.isTrue(result.hasPendingQuestion);
        assert.equal(result.status, "running");
        assert.isFalse(result.waitTimedOut);
        // The blocking call delivered the question, so no wake message was queued.
        const { messages } = yield* readTask(parent.threadId, taskId);
        assert.isUndefined(
          messages.find(
            (message) => message.id === delegatedTaskQuestionMessageId(parent.threadId, requestId),
          ),
        );
      }),
    ),
  );

  it.effect("task_status reads the member's live state", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("status");
        const taskId = yield* requestRemoteTask(parent);
        yield* launched(parent, taskId);
        const approval = {
          requestId: RuntimeRequestId.make("request:box-approval"),
          kind: "command" as const,
          runId: memberRunId,
        };
        yield* member.setState({ pendingApproval: approval });
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const status = yield* service.taskStatus(threadScope(parent.threadId), taskId);
        assert.equal(status.status, "running");
        assert.equal(status.workState, "working");
        assert.equal(status.childThreadId, memberThreadId);
        assert.equal(status.childEnvironmentId, memberEnvironmentId);
        assert.deepEqual(status.pendingApproval, approval);
        assert.isNull(status.summary);
      }),
    ),
  );

  it.effect("returns a typed failure when stopped during the first remote launch", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("stop-during-launch");
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const mcp = yield* MeshServices.MeshMcpClient;
        const callTool = mcp.callTool;
        const landed = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let firstLaunch = true;
        Object.assign(mcp, {
          callTool: (...args: Parameters<typeof callTool>) =>
            callTool(...args).pipe(
              Effect.tap(() => {
                if (args[1] !== "t3_thread_launch" || !firstLaunch) return Effect.void;
                firstLaunch = false;
                return Deferred.succeed(landed, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                );
              }),
            ),
        });
        yield* (yield* RemoteDelegation.RemoteDelegation).start();
        const caller = yield* service
          .delegateTask(threadScope(parent.threadId), {
            task: "Run the tests.",
            machine: "box",
            clientRequestId: "stop-during-launch",
          })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(landed);
        const { subagents } = yield* orchestrator.getThreadRecords(parent.threadId, ["subagents"]);
        const taskId = subagents[0]!.id;
        const stopped = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "subagent.updated" &&
              event.payload.id === taskId &&
              event.payload.status === "cancelled" &&
              event.payload.remote?.stopOwed !== true,
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("command:stop-during-launch:stop"),
          threadId: parent.threadId,
        });
        const result = yield* Fiber.join(caller);
        const stop = yield* member.takeCall("t3_thread_interrupt");
        yield* Fiber.join(stopped);

        assert.deepEqual(
          Option.map(Exit.findErrorOption(result), (error) => ({
            code: error.code,
            message: error.message,
          })),
          Option.some({
            code: "orchestration_error",
            message: "The task was stopped before it started.",
          }),
        );
        assert.equal(stop.args.threadId, memberThreadId);
        assert.isTrue(stop.args.stop);
        const { task } = yield* readTask(parent.threadId, taskId);
        assert.equal(task.status, "cancelled");
        assert.equal(task.remote?.threadId, memberThreadId);
        assert.isUndefined(task.remote?.stopOwed);
        assert.equal(task.completionDelivery?.state, "disposed");
      }),
    ),
  );

  it.effect("stops the member's thread when the task is cancelled before it attached", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("cancel-early");
        const taskId = yield* requestRemoteTask(parent);
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("command:cancel-early:stop"),
          threadId: parent.threadId,
          runId: parent.runId,
          subagentId: taskId,
        });
        const cancelled = (yield* readTask(parent.threadId, taskId)).task;
        assert.equal(cancelled.status, "cancelled");
        assert.isTrue(cancelled.remote?.stopOwed);
        assert.equal(cancelled.completionDelivery?.state, "disposed");

        assert.equal((yield* step(parent, taskId)).type, "next");
        const attached = (yield* readTask(parent.threadId, taskId)).task;
        assert.equal(attached.remote?.threadId, memberThreadId);
        assert.equal(attached.status, "cancelled");

        assert.equal((yield* step(parent, taskId)).type, "done");
        const stop = yield* member.takeCall("t3_thread_interrupt");
        assert.equal(stop.args.threadId, memberThreadId);
        assert.isTrue(stop.args.stop);
        assert.isUndefined((yield* readTask(parent.threadId, taskId)).task.remote?.stopOwed);
      }),
    ),
  );

  it.effect("recovers a pending task at startup and follows new unattached tasks", () =>
    withMember((member) =>
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* seedParent("restart");
          const taskId = yield* requestRemoteTask(parent);
          yield* (yield* RemoteDelegation.RemoteDelegation).start();

          const launch = yield* member.takeCall("t3_thread_launch");
          assert.match(String(launch.args.clientRequestId), /^delegated-task:[\w-]{43}$/);
          const wait = yield* member.takeCall("t3_thread_wait");
          assert.equal(wait.args.threadId, memberThreadId);
          assert.equal(wait.args.timeoutMs, 50_000);
          const { task } = yield* readTask(parent.threadId, taskId);
          assert.equal(task.status, "running");
          assert.equal(task.remote?.runId, memberRunId);

          const laterParent = yield* seedParent("after-startup");
          const laterTaskId = yield* requestRemoteTask(laterParent);
          const laterLaunch = yield* member.takeCall("t3_thread_launch");
          assert.notEqual(laterLaunch.args.clientRequestId, launch.args.clientRequestId);
          yield* member.takeCall("t3_thread_wait");
          const later = yield* readTask(laterParent.threadId, laterTaskId);
          assert.equal(later.task.status, "running");
          assert.equal(later.task.remote?.threadId, memberThreadId);
        }),
      ),
    ),
  );

  it.effect("keeps owing the member a stop while it is unreachable", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("stop-unreachable");
        const taskId = yield* requestRemoteTask(parent);
        yield* launched(parent, taskId);
        yield* member.setUnreachable(true);
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "thread.stop",
          commandId: CommandId.make("command:stop-unreachable:stop"),
          threadId: parent.threadId,
        });
        assert.equal((yield* readTask(parent.threadId, taskId)).task.status, "cancelled");

        assert.equal((yield* step(parent, taskId)).type, "retry");
        assert.isTrue((yield* readTask(parent.threadId, taskId)).task.remote?.stopOwed);

        yield* member.setUnreachable(false);
        assert.equal((yield* step(parent, taskId)).type, "done");
        assert.isUndefined((yield* readTask(parent.threadId, taskId)).task.remote?.stopOwed);
      }),
    ),
  );

  it.effect("t3_thread_interrupt with stop stops the thread and the tasks it delegated", () =>
    withMember(() =>
      Effect.gen(function* () {
        const parent = yield* seedParent("interrupt-stop");
        const taskId = yield* requestRemoteTask(parent);
        yield* launched(parent, taskId);
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.interruptThread(threadScope(parent.threadId), {
          threadId: parent.threadId,
          stop: true,
        });
        assert.equal(result.status, "interrupt_requested");
        assert.equal(result.runId, parent.runId);
        const { task } = yield* readTask(parent.threadId, taskId);
        assert.equal(task.status, "cancelled");
        assert.isTrue(task.remote?.stopOwed);
      }),
    ),
  );

  it.effect("attaches and completes after the parent's turn ended", () =>
    withMember(() =>
      Effect.gen(function* () {
        const parent = yield* seedParent("ended-parent");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const taskId = yield* requestRemoteTask(parent);
        const now = yield* DateTime.now;
        const run = (yield* readTask(parent.threadId, taskId)).runs.find(
          (candidate) => candidate.id === parent.runId,
        )!;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("event:ended-parent:run-completed"),
              type: "run.updated",
              threadId: parent.threadId,
              runId: parent.runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
        const rejected = yield* orchestrator
          .dispatch({
            type: "delegated_task.remote.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make("command:ended-parent:late-request"),
            parentThreadId: parent.threadId,
            parentRunId: parent.runId,
            parentNodeId: parent.rootNodeId,
            task: "Too late.",
            modelSelection,
            environmentId: memberEnvironmentId,
            label: "box",
            launch: {
              repositoryKey: "github.com/t3/app",
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          })
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "OrchestratorDispatchError");
        assert.include(String("cause" in rejected ? rejected.cause : ""), "not active");

        yield* orchestrator.dispatch({
          type: "delegated_task.remote.attach",
          commandId: CommandId.make("command:ended-parent:attach"),
          parentThreadId: parent.threadId,
          taskId,
          threadId: memberThreadId,
          runId: RunId.make("run:on-box"),
          modelSelection,
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.remote.complete",
          commandId: CommandId.make("command:ended-parent:complete"),
          parentThreadId: parent.threadId,
          taskId,
          status: "failed",
          result: "Lint failed on the box.",
        });
        const after = yield* readTask(parent.threadId, taskId);
        assert.equal(after.task.status, "failed");
        assert.equal(after.task.completionDelivery?.state, "claimed");
        const parentRun = after.runs.find((candidate) => candidate.id === parent.runId);
        assert.deepEqual(parentRun?.delegatedCompletion?.delivery?.taskIds, [taskId]);
      }),
    ),
  );
  it.effect(
    "sends the whole delegate target for the member to resolve from the parent's model",
    () =>
      withMember((member) =>
        Effect.gen(function* () {
          const parent = yield* seedParent("target");
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const target = { model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] };
          yield* service.delegateTask(threadScope(parent.threadId), {
            task: "Profile the build on the box.",
            machine: "box",
            target,
          });
          const launch = yield* member.takeCall("t3_thread_launch");
          assert.deepEqual(launch.args.target, target);
          assert.deepEqual(launch.args.modelSelection, modelSelection);
        }),
      ),
  );

  it.effect("refuses a member with two checkouts of the repository, naming both", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("ambiguous");
        const second = ProjectId.make("project:on-box-copy");
        yield* member.setProjects([
          memberProject(memberProjectId, "/srv/app"),
          memberProject(second, "/srv/app-copy"),
        ]);
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const refused = yield* service
          .delegateTask(threadScope(parent.threadId), { task: "Run lint.", machine: "box" })
          .pipe(Effect.flip);
        assert.equal(refused.code, "invalid_request");
        for (const part of [memberProjectId, "/srv/app", second, "/srv/app-copy"]) {
          assert.include(refused.message, part);
        }
        const { subagents } = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(
          parent.threadId,
          ["subagents"],
        );
        assert.equal(subagents[0]?.status, "failed");
        assert.isNull(subagents[0]?.remote?.threadId ?? null);
      }),
    ),
  );

  it.effect("task_status reads a task that has not started on the member", () =>
    withMember(() =>
      Effect.gen(function* () {
        const parent = yield* seedParent("unattached");
        const taskId = yield* requestRemoteTask(parent);
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(threadScope(parent.threadId), taskId);
        assert.equal(pending.status, "queued");
        assert.equal(pending.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
        assert.notProperty(pending, "link");
        assert.deepEqual(pending.notStartedOn, {
          environmentId: memberEnvironmentId,
          label: "box",
        });
        assert.equal(String(pending.childThreadId), String(taskId));
        assert.isNull(pending.childRunId);

        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "delegated_task.remote.complete",
          commandId: CommandId.make("command:unattached:complete"),
          parentThreadId: parent.threadId,
          taskId,
          status: "failed",
          result: "box has no project for github.com/t3/app.",
        });
        const failed = yield* service.taskStatus(threadScope(parent.threadId), taskId);
        assert.equal(failed.status, "failed");
        assert.equal(failed.summary, "box has no project for github.com/t3/app.");
        assert.deepEqual(failed.notStartedOn, { environmentId: memberEnvironmentId, label: "box" });
        assert.notProperty(failed, "next");
        assert.notProperty(failed, "link");
      }),
    ),
  );

  it.effect("wakes the parent after a restart between recording a question and the wake", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("question-restart");
        const taskId = yield* requestRemoteTask(parent);
        yield* launched(parent, taskId);
        const requestId = RuntimeRequestId.make("request:restart-question");
        // The progress committed, then the process stopped before the wake went out.
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "delegated_task.remote.progress",
          commandId: CommandId.make("command:question-restart:progress"),
          parentThreadId: parent.threadId,
          taskId,
          pending: { kind: "question", requestId },
        });
        yield* member.setState({ hasPendingQuestion: true, pendingQuestionRequestId: requestId });
        assert.equal((yield* step(parent, taskId)).type, "wait");

        const messageId = delegatedTaskQuestionMessageId(parent.threadId, requestId);
        const { messages, runs } = yield* readTask(parent.threadId, taskId);
        assert.include(messages.find((message) => message.id === messageId)?.text ?? "", "blocked");
        assert.equal(runs.find((run) => run.userMessageId === messageId)?.status, "queued");
      }),
    ),
  );

  it.effect("wakes the parent about a question asked by message without blocking the task", () =>
    withMember((member) =>
      Effect.gen(function* () {
        const parent = yield* seedParent("message-question");
        const taskId = yield* requestRemoteTask(parent);
        yield* launched(parent, taskId);
        const requestId = RuntimeRequestId.make("request:message-question");
        yield* member.setState({ messageQuestionRequestIds: [requestId] });
        assert.equal((yield* step(parent, taskId)).type, "wait");

        const messageId = delegatedTaskQuestionMessageId(parent.threadId, requestId);
        const asked = yield* readTask(parent.threadId, taskId);
        assert.isUndefined(asked.task.remote?.pending);
        assert.include(
          asked.messages.find((message) => message.id === messageId)?.text ?? "",
          "is still working",
        );
        const queued = asked.runs.find((run) => run.userMessageId === messageId);
        assert.equal(queued?.status, "queued");

        yield* member.setState({});
        yield* step(parent, taskId);
        const answered = yield* readTask(parent.threadId, taskId);
        assert.equal(answered.runs.find((run) => run.id === queued?.id)?.status, "cancelled");
      }),
    ),
  );

  it.effect(
    "wakes the parent about a message question the member asked just before it settled",
    () =>
      withMember((member) =>
        Effect.gen(function* () {
          const parent = yield* seedParent("message-question-settled");
          const taskId = yield* requestRemoteTask(parent);
          yield* launched(parent, taskId);
          const requestId = RuntimeRequestId.make("request:message-question-settled");
          // Asked and settled within one wait piece: no look saw the question while it worked.
          yield* member.setState({
            workState: "result_available",
            status: "completed",
            result: "Done; one question for you.",
            messageQuestionRequestIds: [requestId],
            settled: true,
          });
          assert.equal((yield* step(parent, taskId)).type, "done");

          const messageId = delegatedTaskQuestionMessageId(parent.threadId, requestId);
          const { task, messages } = yield* readTask(parent.threadId, taskId);
          assert.equal(task.status, "completed");
          assert.include(
            messages.find((message) => message.id === messageId)?.text ?? "",
            `requestId ${requestId}`,
          );
        }),
      ),
  );
});
