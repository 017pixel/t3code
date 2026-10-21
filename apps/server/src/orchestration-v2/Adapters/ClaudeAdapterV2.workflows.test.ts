// @effect-diagnostics nodeBuiltinImport:off -- workflow fixtures write transcript files
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowAgentTranscriptReadObserver } from "../workflowAgentTranscript.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
} from "./ClaudeAdapterV2.unit.testkit.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

describe("ClaudeAdapterV2 workflows", () => {
  const WORKFLOW_TASK_ID = "task-workflow-run";
  const WORKFLOW_TOOL_USE_ID = "toolu-workflow-run";
  const makeWorkflowHarnessWithOptions = (
    options?: Parameters<typeof makeWakeHarnessWithOptions>[0],
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-wf-" });
      const transcriptDir = NodePath.join(configDir, "projects", "workflow");
      yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
      yield* fileSystem.writeFileString(
        NodePath.join(transcriptDir, "agent-a1.jsonl"),
        `{"type":"assistant","uuid":"wf-line-1-${options?.nativeSessionId ?? "default"}","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a1","content":[{"type":"text","text":"A1 from the transcript"}]}}\n`,
      );
      const harness = yield* makeWakeHarnessWithOptions({
        ...options,
        environment: { ...options?.environment, CLAUDE_CONFIG_DIR: configDir },
      });
      return { ...harness, transcriptDir };
    });
  const makeWorkflowHarness = makeWorkflowHarnessWithOptions();

  const workflowToolUse = claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: WORKFLOW_TOOL_USE_ID,
          name: "Workflow",
          input: { script: "alpha.js" },
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000001001",
    session_id: WAKE_NATIVE_SESSION,
  });
  const workflowTaskStarted = claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: WORKFLOW_TASK_ID,
    tool_use_id: WORKFLOW_TOOL_USE_ID,
    description: "Run the alpha workflow",
    task_type: "local_workflow",
    workflow_name: "probe-wf",
    uuid: "00000000-0000-4000-8000-000000001002",
    session_id: WAKE_NATIVE_SESSION,
  });
  const workflowLaunchAck = (transcriptDir: string) =>
    claudeSdkFrame({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: WORKFLOW_TOOL_USE_ID,
            content: [{ type: "text", text: "Workflow launched." }],
          },
        ],
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000001003",
      session_id: WAKE_NATIVE_SESSION,
      tool_use_result: {
        taskType: "local_workflow",
        runId: "wf_probe",
        transcriptDir,
      },
    });
  const workflowSnapshot = (input: {
    readonly uuid: string;
    readonly state: "queued" | "start" | "done";
    readonly secondState?: "queued" | "start" | "done";
    readonly startedAt?: number;
    readonly lastProgressAt?: number;
    readonly durationMs?: number;
    readonly label?: string;
    readonly prompt?: string;
    readonly model?: string;
    readonly attempt?: number;
    readonly omitResult?: boolean;
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_progress",
      task_id: WORKFLOW_TASK_ID,
      tool_use_id: WORKFLOW_TOOL_USE_ID,
      description: "Alpha: alpha:one",
      workflow_progress: [
        { type: "workflow_phase", index: 1, title: "Alpha" },
        {
          type: "workflow_agent",
          index: 1,
          label: input.label ?? "alpha:one",
          agentId: "a1",
          state: input.state,
          phaseIndex: 1,
          phaseTitle: "Alpha",
          model: input.model ?? "claude-opus-5[1m]",
          promptPreview: input.prompt ?? "Reply with exactly: A1",
          ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
          ...(input.lastProgressAt === undefined ? {} : { lastProgressAt: input.lastProgressAt }),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
          ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
          ...(input.state === "done" && input.omitResult !== true
            ? { resultPreview: "A1 excerpt" }
            : {}),
        },
        {
          type: "workflow_agent",
          index: 2,
          label: "alpha:two",
          agentId: "a2",
          state: input.secondState ?? input.state,
          phaseIndex: 1,
          phaseTitle: "Alpha",
          promptPreview: "Reply with exactly: A2",
          ...(input.state === "done" ? { resultPreview: "A2 excerpt" } : {}),
        },
      ],
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const workflowNotification = (input: {
    readonly uuid: string;
    readonly status: "completed" | "failed" | "stopped";
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_notification",
      task_id: WORKFLOW_TASK_ID,
      tool_use_id: WORKFLOW_TOOL_USE_ID,
      status: input.status,
      summary: "Workflow finished.",
      output_file: "/tmp/workflow.output",
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const workflowCoordinatorEvents = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
  ) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
        event.type === "subagent.updated" &&
        event.subagent.nativeTaskRef?.nativeId === WORKFLOW_TASK_ID,
    );
  const workflowMemberEvents = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    index: number,
  ) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }> =>
        event.type === "subagent.updated" &&
        event.subagent.nativeTaskRef?.nativeId?.endsWith(`:agent:${index}`) === true,
    );
  const threadMessages = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    threadId: ThreadId | null | undefined,
  ) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
        event.type === "message.updated" && event.message.threadId === threadId,
    );

  const launchWorkflow = Effect.fnUntraced(function* (input: {
    readonly harness: Effect.Success<typeof makeWorkflowHarness>;
    readonly snapshotUuid: string;
    readonly state?: "queued" | "start";
  }) {
    yield* input.harness.offerAndWait(workflowToolUse);
    yield* input.harness.offerAndWait(workflowTaskStarted);
    yield* input.harness.offerAndWait(workflowLaunchAck(input.harness.transcriptDir));
    yield* input.harness.offerAndWait(
      workflowSnapshot({ uuid: input.snapshotUuid, state: input.state ?? "start" }),
    );
    yield* input.harness.until(() => workflowMemberEvents(input.harness.events, 2).length === 1);
  });

  it.effect.each(["Agent", "Workflow"] as const)(
    "keeps a workflow running after its %s launch reply without an async flag",
    (toolName) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWorkflowHarness;
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-workflow-launch-${toolName}`),
              text: "Run the workflow.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowToolUse,
              message: {
                model: "claude-sonnet-4-6",
                content: [
                  { type: "tool_use", id: WORKFLOW_TOOL_USE_ID, name: toolName, input: {} },
                ],
              },
            }),
          );
          yield* harness.offerAndWait(workflowTaskStarted);
          yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001200", state: "start" }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001201", result: "Launched." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.equal(
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
            "running",
          );
          assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          const toolItems = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId === WORKFLOW_TOOL_USE_ID
              ? [event.turnItem.status]
              : [],
          );
          assert.deepEqual(toolItems, toolName === "Workflow" ? ["running", "completed"] : []);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000001202",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-workflow-complete-${toolName}`),
              text: "Workflow finished.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001205", result: "Finished." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.equal(
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
            "completed",
          );
          assert.equal(
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status,
            "completed",
          );
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("marks a workflow coordinator's script prompt and leaves a subagent brief plain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const script =
          'export const meta = { name: "probe-wf", description: "Run the alpha workflow" };';
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-script-prompt"),
            text: "Run the workflow and an auditor.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(workflowToolUse);
        yield* harness.offerAndWait(claudeSdkFrame({ ...workflowTaskStarted, prompt: script }));
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001289", state: "start" }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-plain-auditor",
            description: "Audit recent commits",
            task_type: "local_agent",
            prompt: "Audit the last five commits.",
            uuid: "00000000-0000-4000-8000-000000001290",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const subagentPrompt = (nativeTaskId: string) => {
          const subagent = harness.events.flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === nativeTaskId
              ? [event.subagent]
              : [],
          )[0];
          const message = threadMessages(harness.events, subagent?.childThreadId).find(
            (event) => event.message.role === "user",
          )?.message;
          const turnItem = harness.events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "user_message" &&
              event.turnItem.messageId === message?.id,
          );
          return {
            text: message?.text,
            messageMark: message?.workflowScript,
            itemMark:
              turnItem?.type === "turn_item.updated" && turnItem.turnItem.type === "user_message"
                ? turnItem.turnItem.workflowScript
                : undefined,
          };
        };
        // The user message item lands after the subagent node, so wait on the item itself.
        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).length > 0 &&
            subagentPrompt(WORKFLOW_TASK_ID).itemMark !== undefined &&
            subagentPrompt("task-plain-auditor").itemMark !== undefined,
        );
        assert.deepEqual(subagentPrompt(WORKFLOW_TASK_ID), {
          text: script,
          messageMark: true,
          itemMark: true,
        });
        // A brief is marked as not a script, so its text is never read as one.
        assert.deepEqual(subagentPrompt("task-plain-auditor"), {
          text: "Audit the last five commits.",
          messageMark: false,
          itemMark: false,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("stops only a live workflow task and waits for its stopped notification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stoppedTasks: Array<string> = [];
        let interrupted = false;
        let closed = false;
        const harness = yield* makeWorkflowHarnessWithOptions({
          stopTask: (taskId) =>
            Effect.sync(() => {
              stoppedTasks.push(taskId);
            }),
          interrupt: Effect.sync(() => {
            interrupted = true;
          }),
          close: () =>
            Effect.sync(() => {
              closed = true;
            }),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-stop"),
            text: "Run the workflow.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(workflowToolUse);
        yield* harness.offerAndWait(workflowTaskStarted);
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001100",
            state: "start",
          }),
        );
        let member = yield* Queue.take(harness.subagentReceipts);
        while (!member.subagent.nativeTaskRef?.nativeId?.endsWith(":agent:2")) {
          member = yield* Queue.take(harness.subagentReceipts);
        }
        const stopTask = harness.runtime.stopTask!;
        for (const taskId of ["missing-task", `${WORKFLOW_TASK_ID}:agent:1`]) {
          const exit = yield* stopTask({ providerThread: harness.providerThread, taskId }).pipe(
            Effect.exit,
          );
          assert.isTrue(Exit.isFailure(exit));
        }
        const wrongThread = {
          ...harness.providerThread,
          nativeThreadRef: {
            driver: harness.providerThread.driver,
            nativeId: "wrong-session",
            strength: "strong" as const,
          },
        };
        assert.isTrue(
          Exit.isFailure(
            yield* stopTask({
              providerThread: wrongThread,
              taskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit),
          ),
        );
        assert.deepEqual(stoppedTasks, []);
        yield* stopTask({ providerThread: harness.providerThread, taskId: WORKFLOW_TASK_ID });
        assert.deepEqual(stoppedTasks, [WORKFLOW_TASK_ID]);
        assert.isFalse(interrupted);
        assert.isFalse(closed);
        assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, "running");
        yield* harness.offerAndWait(
          workflowNotification({
            uuid: "00000000-0000-4000-8000-000000001101",
            status: "stopped",
          }),
        );
        member = yield* Queue.take(harness.subagentReceipts);
        while (!member.subagent.nativeTaskRef?.nativeId?.endsWith(":agent:2")) {
          member = yield* Queue.take(harness.subagentReceipts);
        }
        assert.equal(
          workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
          "cancelled",
        );
        for (const index of [1, 2]) {
          assert.equal(
            workflowMemberEvents(harness.events, index).at(-1)?.subagent.status,
            "cancelled",
          );
        }
        assert.isTrue(
          Exit.isFailure(
            yield* stopTask({
              providerThread: harness.providerThread,
              taskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit),
          ),
        );
        assert.deepEqual(stoppedTasks, [WORKFLOW_TASK_ID]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("projects each workflow member as its own subagent thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const now = yield* DateTime.now;
        const coordinatorTurnItems = () =>
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "subagent" &&
              event.turnItem.nativeItemRef?.nativeId === WORKFLOW_TASK_ID,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-members"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({
          harness,
          snapshotUuid: "00000000-0000-4000-8000-000000001004",
          state: "queued",
        });

        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)?.subagent;
        const first = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        const second = workflowMemberEvents(harness.events, 2).at(-1)?.subagent;
        assert.equal(first?.status, "pending");
        assert.isNull(first?.startedAt);
        assert.equal(second?.status, "pending");
        assert.isNull(second?.startedAt);
        const coordinatorThread = harness.events.find(
          (event) =>
            event.type === "app_thread.created" &&
            event.appThread.id === coordinator?.childThreadId,
        );
        assert.equal(
          coordinatorThread?.type === "app_thread.created"
            ? coordinatorThread.appThread.title
            : null,
          "Workflow · probe-wf",
        );
        assert.equal(first?.title, "alpha:one");
        assert.equal(first?.prompt, "Reply with exactly: A1");
        assert.equal(first?.model, "claude-opus-5[1m]");
        assert.equal(first?.threadId, coordinator?.childThreadId);
        assert.equal(second?.threadId, coordinator?.childThreadId);
        assert.notEqual(first?.childThreadId, second?.childThreadId);

        assert.equal(
          harness.events.find(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "app_thread.created" }
            > => event.type === "app_thread.created" && event.appThread.id === first?.childThreadId,
          )?.appThread.title,
          "alpha:one",
        );
        const memberNodes = harness.events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> =>
            event.type === "node.updated" &&
            event.node.nativeItemRef?.nativeId === first?.nativeTaskRef?.nativeId,
        );
        assert.deepEqual(
          memberNodes.map((event) => event.node.kind),
          ["subagent", "root_turn"],
        );
        assert.deepEqual(
          memberNodes.map((event) => [event.node.status, event.node.startedAt]),
          [
            ["pending", null],
            ["pending", null],
          ],
        );
        assert.deepEqual(
          threadMessages(harness.events, first?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1"],
        );
        assert.deepEqual(
          threadMessages(harness.events, second?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A2"],
        );

        yield* TestClock.adjust("60 seconds");
        const memberStartedAt = DateTime.add(now, { seconds: 30 });
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001007",
            state: "start",
            secondState: "queued",
            startedAt: DateTime.toEpochMillis(memberStartedAt),
          }),
        );
        let started = yield* Queue.take(harness.subagentReceipts);
        while (started.subagent.id !== first?.id || started.subagent.status !== "running") {
          started = yield* Queue.take(harness.subagentReceipts);
        }
        assert.deepEqual(started.subagent.startedAt, memberStartedAt);
        const startedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === first?.childThreadId,
        );
        assert.equal(
          startedRoot?.type === "node.updated" ? startedRoot.node.status : null,
          "running",
        );
        assert.deepEqual(
          startedRoot?.type === "node.updated" ? startedRoot.node.startedAt : null,
          memberStartedAt,
        );

        const turnItemsBeforeRepeat = coordinatorTurnItems().length;
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001005",
            state: "start",
            secondState: "queued",
          }),
        );
        yield* harness.until(() => coordinatorTurnItems().length > turnItemsBeforeRepeat);
        assert.lengthOf(workflowMemberEvents(harness.events, 1), 2);
        assert.lengthOf(workflowMemberEvents(harness.events, 2), 1);

        const firstThreadId = first?.childThreadId;
        const firstThreadEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "app_thread.created" }
            > => event.type === "app_thread.created" && event.appThread.id === firstThreadId,
          );
        const turnItemsBeforeMetadata = coordinatorTurnItems().length;
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001017",
            state: "start",
            secondState: "queued",
            label: "alpha:review",
            prompt: "Review the change",
            model: "claude-sonnet-4-6",
          }),
        );
        // The member's node and app thread pick up the metadata after the coordinator item.
        yield* harness.until(
          () =>
            coordinatorTurnItems().length > turnItemsBeforeMetadata &&
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.title === "alpha:review" &&
            firstThreadEvents().at(-1)?.appThread.title === "alpha:review",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.title,
          "alpha:review",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.prompt,
          "Review the change",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.model,
          "claude-sonnet-4-6",
        );
        assert.equal(firstThreadEvents().at(-1)?.appThread.title, "alpha:review");
        assert.equal(
          firstThreadEvents().at(-1)?.appThread.modelSelection.model,
          "claude-sonnet-4-6",
        );
        assert.deepEqual(
          firstThreadEvents().at(-1)?.appThread.createdAt,
          firstThreadEvents()[0]?.appThread.createdAt,
        );
        assert.equal(
          threadMessages(harness.events, firstThreadId).at(-1)?.message.text,
          "Review the change",
        );

        yield* TestClock.adjust("10 seconds");
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001018",
            state: "done",
            secondState: "queued",
            omitResult: true,
          }),
        );
        let finished = yield* Queue.take(harness.subagentReceipts);
        while (finished.subagent.id !== first?.id || finished.subagent.status !== "completed") {
          finished = yield* Queue.take(harness.subagentReceipts);
        }
        const completedAt = finished.subagent.completedAt;
        assert.deepEqual(completedAt, DateTime.add(now, { seconds: 70 }));
        yield* TestClock.adjust("60 seconds");
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001019",
            state: "done",
            secondState: "queued",
          }),
        );
        let excerpt = yield* Queue.take(harness.subagentReceipts);
        while (excerpt.subagent.id !== first?.id || excerpt.subagent.result !== "A1 excerpt") {
          excerpt = yield* Queue.take(harness.subagentReceipts);
        }
        assert.deepEqual(excerpt.subagent.completedAt, completedAt);
        const finishedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === firstThreadId,
        );
        assert.deepEqual(
          finishedRoot?.type === "node.updated" ? finishedRoot.node.completedAt : undefined,
          completedAt,
        );

        yield* harness.offerAndWait(
          workflowNotification({ uuid: "00000000-0000-4000-8000-000000001008", status: "stopped" }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001006",
            result: "Launched the workflow.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const stopped = workflowMemberEvents(harness.events, 2).at(-1)?.subagent;
        assert.equal(stopped?.status, "cancelled");
        assert.isNull(stopped?.startedAt);
        const stoppedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === second?.childThreadId,
        );
        assert.equal(
          stoppedRoot?.type === "node.updated" ? stoppedRoot.node.status : null,
          "cancelled",
        );
        assert.isNull(
          stoppedRoot?.type === "node.updated" ? stoppedRoot.node.startedAt : undefined,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("projects workflow member threads after resuming a restarted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarnessWithOptions({
          subagentLaunchToolUseId: WORKFLOW_TOOL_USE_ID,
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-resume"),
            text: "Continue the workflow.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...workflowToolUse,
            message: {
              model: "claude-sonnet-4-6",
              content: [
                { type: "tool_use", id: "toolu-resume-workflow", name: "SendMessage", input: {} },
              ],
            },
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...workflowTaskStarted,
            tool_use_id: "toolu-resume-workflow",
            prompt: "Continue the workflow.",
          }),
        );
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001040", state: "start" }),
        );
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001041", result: "Resumed." }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const member = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)?.subagent;
        assert.isDefined(member);
        assert.equal(member?.status, "running");
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "app_thread.created" && event.appThread.id === member?.childThreadId,
          ),
        );
        assert.deepEqual(
          threadMessages(harness.events, member?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1", "A1 from the transcript"],
        );
        assert.isDefined(coordinator?.childThreadId);
        const recoveredThreads = harness.events.filter(
          (event) =>
            event.type === "app_thread.created" &&
            event.appThread.id === coordinator?.childThreadId,
        );
        assert.lengthOf(recoveredThreads, 1);
        const recovered = recoveredThreads[0];
        assert.equal(recovered?.type, "app_thread.created");
        if (recovered?.type !== "app_thread.created") throw new Error("Expected recovered thread");
        assert.isTrue(recovered.createOnly);
        assert.deepEqual(recovered.appThread.lineage, {
          parentThreadId: harness.threadId,
          relationshipToParent: "subagent",
          rootThreadId: harness.threadId,
        });
        assert.equal(recovered.appThread.createdBy, "agent");
        assert.equal(recovered.appThread.creationSource, "provider");
        assert.isBelow(
          harness.events.indexOf(recovered),
          harness.events.findIndex(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.childThreadId === coordinator?.childThreadId,
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    "root result",
    "resume after root result",
    "completion before buffered start",
  ] as const)("orders %s arriving during workflow transcript replay", (arrival) =>
    Effect.scoped(
      Effect.gen(function* () {
        const digestStarted = yield* Deferred.make<void>();
        const releaseDigest = yield* Deferred.make<void>();
        const liveFrameOffered = yield* Deferred.make<void>();
        let pauseDigest = false;
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarnessWithOptions({ close: Queue.shutdown });
          const taskId = "task-resumed-during-workflow-replay";
          const taskStart = (toolUseId: string, prompt: string, uuid: string) =>
            claudeSdkFrame({
              ...workflowTaskStarted,
              task_id: taskId,
              task_type: "local_agent",
              is_backgrounded: true,
              subagent_type: "general-purpose",
              spawn_depth: 1,
              workflow_name: undefined,
              tool_use_id: toolUseId,
              prompt,
              uuid,
            });
          const taskFinished = (toolUseId: string, summary: string, uuid: string) =>
            claudeSdkFrame({
              ...workflowNotification({ uuid, status: "completed" }),
              task_id: taskId,
              tool_use_id: toolUseId,
              summary,
            });
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-workflow-replay-launch"),
              text: "Run the workflow and a background subagent.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(workflowToolUse);
          yield* harness.offerAndWait(workflowTaskStarted);
          yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000003001", state: "start" }),
          );
          if (arrival !== "completion before buffered start") {
            yield* harness.offerAndWait(
              taskStart("toolu-initial", "Initial work.", "00000000-0000-4000-8000-000000003002"),
            );
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000003003",
              result: "Launched both tasks.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000003004",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          if (arrival === "completion before buffered start") {
            yield* harness.offerAndWait(
              taskStart("toolu-initial", "Initial work.", "00000000-0000-4000-8000-000000003005"),
            );
          } else {
            yield* harness.offerAndWait(
              taskFinished(
                "toolu-initial",
                "Initial result.",
                "00000000-0000-4000-8000-000000003005",
              ),
            );
          }
          if (arrival === "root result") {
            yield* harness.offerAndWait(
              claudeSdkFrame({
                type: "system",
                subtype: "init",
                session_id: WAKE_NATIVE_SESSION,
                uuid: "00000000-0000-4000-8000-000000003006",
              }),
            );
          }
          pauseDigest = true;
          const replay = yield* harness.runtime
            .startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-continuation"),
                providerTurnOrdinal: 2,
                text: "Continue.",
                attachments: [],
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(digestStarted);
          const liveFrames = yield* Effect.gen(function* () {
            if (arrival === "completion before buffered start") {
              yield* harness.offerAndWait(
                taskFinished(
                  "toolu-initial",
                  "Initial result.",
                  "00000000-0000-4000-8000-000000003007",
                ),
                liveFrameOffered,
              );
              return;
            }
            yield* harness.offerAndWait(
              claudeSdkFrame({
                ...makeResultFrame({
                  uuid: "00000000-0000-4000-8000-000000003008",
                  result: "Native wake turn finished.",
                }),
                origin: { kind: "task-notification" },
                num_turns: 1,
              }),
              liveFrameOffered,
            );
            if (arrival === "resume after root result") {
              yield* harness.offerAndWait(
                claudeSdkFrame({
                  type: "system",
                  subtype: "init",
                  session_id: WAKE_NATIVE_SESSION,
                  uuid: "00000000-0000-4000-8000-000000003009",
                }),
              );
              yield* harness.offerAndWait(
                taskStart(
                  "toolu-latest",
                  "Latest live resume.",
                  "00000000-0000-4000-8000-000000003010",
                ),
              );
            }
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(liveFrameOffered);
          yield* Deferred.succeed(releaseDigest, undefined);
          yield* Fiber.join(replay);
          yield* Fiber.join(liveFrames);
          if (arrival === "resume after root result") {
            yield* Queue.take(harness.terminalReceipts);
            yield* Queue.take(harness.continuationReceipts);
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-resume-continuation"),
                providerTurnOrdinal: 3,
                text: "Continue.",
                attachments: [],
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          if (arrival !== "root result") {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000003011",
                result: "Workflow answer delivered.",
              }),
            );
          }
          yield* Queue.take(harness.terminalReceipts);
          const latest = harness.events
            .flatMap((event) =>
              event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId
                ? [event.subagent]
                : [],
            )
            .at(-1);
          if (arrival === "resume after root result") {
            assert.equal(latest?.status, "running");
            assert.equal(latest?.prompt, "Latest live resume.");
            assert.isNull(latest?.result);
            assert.isTrue(yield* harness.hasPendingBackgroundWork);
          } else {
            assert.equal(latest?.status, "completed");
            assert.equal(latest?.result, "Initial result.");
            assert.isFalse(yield* harness.hasPendingBackgroundWork);
            assert.lengthOf(harness.continuationRequests, 1);
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-next-user"),
                providerTurnOrdinal: 3,
                text: "Next task.",
                attachments: [],
              }),
            );
          }
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, () =>
            Effect.gen(function* () {
              if (pauseDigest) {
                pauseDigest = false;
                yield* Deferred.succeed(digestStarted, undefined);
                yield* Deferred.await(releaseDigest);
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("preserves buffered workflow outcomes when interrupted during replay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const digestStarted = yield* Deferred.make<void>();
        const releaseDigest = yield* Deferred.make<void>();
        let pauseDigest = false;
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarnessWithOptions({ close: Queue.shutdown });
          const secondTaskId = "task-workflow-buffered-completion";
          const secondToolUseId = "toolu-workflow-buffered-completion";
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-workflow-buffered-launch"),
              text: "Run both workflows.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({
            harness,
            snapshotUuid: "00000000-0000-4000-8000-000000003100",
          });
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowTaskStarted,
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
              uuid: "00000000-0000-4000-8000-000000003101",
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowSnapshot({
                uuid: "00000000-0000-4000-8000-000000003102",
                state: "start",
              }),
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
            }),
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000003103",
              result: "Launched both workflows.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000003104",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowNotification({
                uuid: "00000000-0000-4000-8000-000000003105",
                status: "completed",
              }),
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
            }),
          );
          const continuationInput = makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-buffered-replay"),
            providerTurnOrdinal: 2,
            text: "Continue.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          });
          pauseDigest = true;
          const replay = yield* harness.runtime
            .startTurn(continuationInput)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(digestStarted);
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${continuationInput.attemptId}`,
            }),
          });
          yield* Deferred.succeed(releaseDigest, undefined);
          yield* Fiber.join(replay);
          const second = harness.events
            .flatMap((event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === secondTaskId
                ? [event.subagent]
                : [],
            )
            .at(-1);
          assert.equal(second?.status, "completed");
          assert.equal(second?.result, "Workflow finished.");
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, () =>
            Effect.gen(function* () {
              if (pauseDigest) {
                pauseDigest = false;
                yield* Deferred.succeed(digestStarted, undefined);
                yield* Deferred.await(releaseDigest);
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    ["api_error", false, false],
    ["aborted_streaming", false, false],
    ["api_error", true, false],
    ["api_error", false, true],
    ["aborted_streaming", false, true],
  ] as const)(
    "stops the run's live workflow after root result %s, continuation=%s, pending Stop=%s",
    ([terminalReason, continuation, pendingStop]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stoppedTasks: Array<string> = [];
          const stopRequested = yield* Deferred.make<void>();
          const harness = yield* makeWorkflowHarnessWithOptions({
            stopTask: (taskId) =>
              Effect.sync(() => void stoppedTasks.push(taskId)).pipe(
                Effect.andThen(Deferred.succeed(stopRequested, undefined)),
                Effect.asVoid,
              ),
          });
          const now = yield* DateTime.now;
          const turnInput = {
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-root-failure"),
            text: "Run the workflow.",
            attachments: [],
          };
          yield* harness.runtime.startTurn(makeClaudeTestTurnInput(turnInput));
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001050" });
          const stopping = pendingStop
            ? yield* harness.runtime.stopSubagent!({
                providerThread: harness.providerThread,
                nativeTaskId: WORKFLOW_TASK_ID,
              }).pipe(Effect.exit, Effect.forkScoped)
            : undefined;
          if (pendingStop) yield* Deferred.await(stopRequested);
          if (continuation) {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000001051",
                result: "Launched.",
              }),
            );
            yield* Queue.take(harness.terminalReceipts);
            yield* harness.offerAndWait(
              claudeSdkFrame({
                ...workflowTaskStarted,
                uuid: "00000000-0000-4000-8000-000000001052",
              }),
            );
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001053",
              result: "Root turn ended.",
              terminalReason,
              isError: terminalReason === "api_error",
            }),
          );
          if (continuation) {
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                ...turnInput,
                attemptId: RunAttemptId.make("attempt-claude-workflow-root-failure-wake"),
                providerTurnOrdinal: 2,
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, terminalReason === "api_error" ? "failed" : "interrupted");
          assert.equal(terminal.threadDisposition, "reusable");
          const settled = terminalReason === "api_error" ? "failed" : "cancelled";
          assert.deepEqual(
            stoppedTasks,
            pendingStop ? [WORKFLOW_TASK_ID, WORKFLOW_TASK_ID] : [WORKFLOW_TASK_ID],
          );
          if (stopping !== undefined) {
            yield* TestClock.adjust("2 seconds");
            assert.isTrue(Exit.isFailure(yield* Fiber.join(stopping)));
            const retry = yield* harness.runtime.stopSubagent!({
              providerThread: harness.providerThread,
              nativeTaskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit, Effect.forkScoped);
            yield* TestClock.adjust("2 seconds");
            assert.isTrue(Exit.isFailure(yield* Fiber.join(retry)));
          }
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, settled);
          for (const index of [1, 2]) {
            assert.equal(
              workflowMemberEvents(harness.events, index).at(-1)?.subagent.status,
              settled,
            );
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("answers settled workflow members from a transcript, or the snapshot excerpt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-settled"),
            text: "Run the alpha workflow in the background.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001007" });
        const firstThreadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        const secondThreadId = workflowMemberEvents(harness.events, 2)[0]?.subagent.childThreadId;
        const currentAssistantAnswers = () => [
          ...new Map(
            threadMessages(harness.events, firstThreadId)
              .filter((event) => event.message.role === "assistant")
              .map((event) => [event.message.id, event.message.text]),
          ).values(),
        ];
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001008",
            result: "Launched the workflow.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-unrelated-failure"),
            text: "Do another task.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001014",
            result: "Another task failed.",
            terminalReason: "api_error",
            isError: true,
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, "running");
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");

        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001009", state: "done" }),
        );
        yield* harness.until(() => threadMessages(harness.events, secondThreadId).length === 2);

        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)?.subagent;
        assert.deepEqual(
          coordinator?.workflow?.agents.map((member) => member.state),
          ["completed", "completed"],
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "completed");
        assert.equal(workflowMemberEvents(harness.events, 2).at(-1)?.subagent.status, "completed");
        assert.deepEqual(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.completedAt,
          yield* DateTime.now,
        );
        assert.deepEqual(
          threadMessages(harness.events, firstThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1", "A1 from the transcript"],
        );
        assert.deepEqual(
          threadMessages(harness.events, secondThreadId).map((event) => event.message.text),
          ["Reply with exactly: A2", "Partial answer from workflow progress:\n\nA2 excerpt"],
        );
        const coordinatorEventsBeforeRepeat = workflowCoordinatorEvents(harness.events).length;
        const memberEventsBeforeRepeat = workflowMemberEvents(harness.events, 2).length;
        NodeFS.appendFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          '{"type":"assistant","uuid":"wf-line-4","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a1","content":[{"type":"text","text":"A1 continued"}]}}\n',
        );
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001015", state: "done" }),
        );
        yield* harness.until(
          () => workflowCoordinatorEvents(harness.events).length > coordinatorEventsBeforeRepeat,
        );
        yield* harness.until(
          () =>
            threadMessages(harness.events, firstThreadId).at(-1)?.message.text === "A1 continued",
        );
        assert.lengthOf(workflowMemberEvents(harness.events, 2), memberEventsBeforeRepeat);
        assert.lengthOf(threadMessages(harness.events, secondThreadId), 2);
        assert.deepEqual(currentAssistantAnswers(), ["A1 from the transcript", "A1 continued"]);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a2.jsonl"),
          '{"type":"assistant","uuid":"wf-line-5","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a2","content":[{"type":"text","text":"A2 from the transcript"}]}}\n',
        );
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001016", state: "done" }),
        );
        yield* harness.until(() => threadMessages(harness.events, secondThreadId).length === 3);
        assert.lengthOf(workflowMemberEvents(harness.events, 2), memberEventsBeforeRepeat);
        assert.equal(
          threadMessages(harness.events, secondThreadId).at(-1)?.message.text,
          "A2 from the transcript",
        );
        const previousStartedAt = workflowMemberEvents(harness.events, 1).at(-1)?.subagent
          .startedAt;
        yield* TestClock.adjust(1_000);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          [
            '{"type":"assistant","uuid":"wf-line-6","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_first","content":[{"type":"text","text":"First answer"}]}}',
            '{"type":"assistant","uuid":"wf-line-7","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_second","content":[{"type":"text","text":"Second answer"}]}}',
          ].join("\n") + "\n",
        );
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001018",
            state: "done",
            attempt: 2,
            startedAt: 1000,
            durationMs: 500,
            lastProgressAt: 4432,
          }),
        );
        yield* harness.until(() =>
          currentAssistantAnswers().join("\n\n").includes("Second answer"),
        );
        assert.deepEqual(currentAssistantAnswers().slice(-2), ["First answer", "Second answer"]);
        const completedMember = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        assert.equal(
          completedMember?.completedAt && DateTime.toEpochMillis(completedMember.completedAt),
          4432,
        );
        assert.notDeepEqual(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.startedAt,
          previousStartedAt,
        );
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001019",
            state: "start",
            attempt: 3,
          }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");
        assert.isNull(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.completedAt);
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001020",
            state: "start",
            attempt: 3,
          }),
        );
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          '{"type":"assistant","uuid":"wf-line-8","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_retry","content":[{"type":"text","text":"A1 retry answer"}]}}\n',
        );
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001021",
            state: "done",
            attempt: 3,
          }),
        );
        yield* harness.until(
          () =>
            threadMessages(harness.events, firstThreadId).at(-1)?.message.text ===
            "A1 retry answer",
        );
        assert.equal(currentAssistantAnswers().at(-1), "A1 retry answer");
        NodeFS.rmSync(NodePath.join(harness.transcriptDir, "agent-a1.jsonl"));
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001022",
            state: "start",
            attempt: 4,
          }),
        );
        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]
              ?.attempt === 4,
        );
        const answersBeforeEmptyAttempt = currentAssistantAnswers();
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001023",
            state: "done",
            attempt: 4,
            omitResult: true,
          }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "completed");
        assert.deepEqual(
          currentAssistantAnswers(),
          answersBeforeEmptyAttempt,
          "an attempt with no transcript and no excerpt adds nothing",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  // Line shapes copied from a Claude CLI 2.1.301 workflow member transcript.
  const transcriptLine = (entry: Record<string, unknown>) =>
    `${JSON.stringify({ isSidechain: true, agentId: "a1", timestamp: "2026-10-17T05:08:07.524Z", ...entry })}\n`;
  const memberAssistantLine = (
    uuid: string,
    messageId: string,
    content: unknown,
    stopReason?: "tool_use" | "end_turn",
  ) =>
    transcriptLine({
      type: "assistant",
      uuid,
      message: {
        model: "claude-opus-5-5",
        id: messageId,
        type: "message",
        role: "assistant",
        content,
        ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      },
    });
  const memberToolResultLine = (uuid: string, toolUseId: string, output: string) =>
    transcriptLine({
      type: "user",
      uuid,
      message: {
        role: "user",
        content: [{ tool_use_id: toolUseId, type: "tool_result", content: output }],
      },
    });
  const memberTranscript = [
    transcriptLine({
      type: "user",
      uuid: "line-prompt",
      message: { role: "user", content: "Reply with exactly: A1" },
    }),
    transcriptLine({
      type: "attachment",
      uuid: "line-attachment",
      attachment: { type: "skill_listing", content: "- adhd" },
    }),
    transcriptLine({
      type: "user",
      uuid: "line-meta",
      isMeta: true,
      message: { role: "user", content: "<system-reminder>context</system-reminder>" },
    }),
    memberAssistantLine("line-thinking", "msg_a1", [
      { type: "thinking", thinking: "List the files first.", signature: "sig" },
    ]),
    memberAssistantLine("line-bash", "msg_a1", [
      { type: "tool_use", id: "toolu_a1_ls", name: "Bash", input: { command: "ls" } },
    ]),
    memberToolResultLine("line-ls-result", "toolu_a1_ls", "README.md"),
    memberAssistantLine("line-reply", "msg_a1_reply", [
      { type: "text", text: "A1 found README.md" },
    ]),
  ].join("");
  const memberThreadItems = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    threadId: ThreadId | null | undefined,
  ) =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.threadId === threadId
        ? [event.turnItem]
        : [],
    );
  const latestMemberThreadItems = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    threadId: ThreadId | null | undefined,
  ) =>
    [
      ...new Map(memberThreadItems(events, threadId).map((item) => [item.id, item])).values(),
    ].toSorted((left, right) => left.ordinal - right.ordinal);
  const describeItem = (item: ReturnType<typeof memberThreadItems>[number]) =>
    item.type === "reasoning"
      ? `reasoning: ${item.text}`
      : item.type === "command_execution"
        ? `command ${item.status}: ${item.output ?? ""}`
        : item.type === "assistant_message" || item.type === "user_message"
          ? `${item.type}`
          : `${item.type} ${item.status}`;

  it.effect("streams a running workflow member's conversation from its transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads: Array<{
          readonly startOffset: number;
          readonly endOffset: number;
          readonly lineCount: number;
        }> = [];
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarness;
          const transcriptPath = NodePath.join(harness.transcriptDir, "agent-a1.jsonl");
          NodeFS.writeFileSync(transcriptPath, memberTranscript);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-claude-workflow-live-stream"),
              text: "Run the alpha workflow.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001360" });
          const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
          const running = (uuid: string) => workflowSnapshot({ uuid, state: "start" });

          assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
            "user_message",
            "reasoning: List the files first.",
            "command completed: README.md",
            "assistant_message",
          ]);
          assert.deepEqual(
            threadMessages(harness.events, threadId).map((event) => event.message.text),
            ["Reply with exactly: A1", "A1 found README.md"],
          );
          assert.deepEqual(reads.at(-1), {
            startOffset: 0,
            endOffset: Buffer.byteLength(memberTranscript),
            lineCount: 5,
          });

          const itemsBefore = memberThreadItems(harness.events, threadId).length;
          const more = memberAssistantLine("line-more", "msg_a1_more", [
            {
              type: "tool_use",
              id: "toolu_a1_cat",
              name: "Bash",
              input: { command: "cat README.md" },
            },
          ]);
          const half = memberToolResultLine("line-cat-result", "toolu_a1_cat", "hello");
          NodeFS.appendFileSync(transcriptPath, more + half.slice(0, 40));
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001361"));
          assert.deepEqual(reads.at(-1), {
            startOffset: Buffer.byteLength(memberTranscript),
            endOffset: Buffer.byteLength(memberTranscript + more),
            lineCount: 1,
          });
          assert.deepEqual(
            memberThreadItems(harness.events, threadId).slice(itemsBefore).map(describeItem),
            ["command running: "],
            "only the new line is projected; the half-written one waits",
          );

          NodeFS.appendFileSync(transcriptPath, half.slice(40));
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001362"));
          assert.deepEqual(reads.at(-1), {
            startOffset: Buffer.byteLength(memberTranscript + more),
            endOffset: Buffer.byteLength(memberTranscript + more + half),
            lineCount: 1,
          });
          assert.deepEqual(
            memberThreadItems(harness.events, threadId).slice(itemsBefore).map(describeItem),
            ["command running: ", "command completed: hello"],
          );

          const itemsBeforeIdle = memberThreadItems(harness.events, threadId).length;
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001363"));
          assert.equal(reads.at(-1)?.lineCount, 0);
          assert.lengthOf(memberThreadItems(harness.events, threadId), itemsBeforeIdle);

          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001364", state: "done" }),
          );
          assert.equal(
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status,
            "completed",
          );
          assert.deepEqual(
            threadMessages(harness.events, threadId).map((event) => event.message.text),
            ["Reply with exactly: A1", "A1 found README.md"],
            "the settled member adds no second copy of its answer",
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001365", result: "Done." }),
          );
          yield* Queue.take(harness.terminalReceipts);
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, (read) =>
            Effect.sync(() => {
              if (read.agentId === "a1") {
                reads.push({
                  startOffset: read.startOffset,
                  endOffset: read.endOffset,
                  lineCount: read.lineCount,
                });
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("interrupts the open tool calls of a workflow member that failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          memberAssistantLine("line-bash", "msg_a1", [
            { type: "tool_use", id: "toolu_a1_ls", name: "Bash", input: { command: "ls" } },
          ]),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-member-fails"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001370" });
        const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
          "user_message",
          "command running: ",
        ]);
        yield* harness.offerAndWait(
          workflowNotification({ uuid: "00000000-0000-4000-8000-000000001371", status: "failed" }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "failed");
        assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
          "user_message",
          "command interrupted: ",
        ]);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001372", result: "Done." }),
        );
        yield* Queue.take(harness.terminalReceipts);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("reads a settled workflow member's transcript to its end past the read cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        // About 1.3 MB of early replies: more than the launch frame's read
        // and the settled frame's read together, at 512 KB each.
        const filler = "x".repeat(16 * 1024);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          Array.from({ length: 80 }, (_, index) =>
            memberAssistantLine(`line-early-${index}`, `msg_early_${index}`, [
              { type: "text", text: `${index} ${filler}` },
            ]),
          ).join("") +
            memberAssistantLine("line-final", "msg_final", [
              { type: "text", text: "FINAL ANSWER" },
            ]),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-member-long-transcript"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001390" });
        const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        yield* harness.offerAndWait(
          workflowNotification({
            uuid: "00000000-0000-4000-8000-000000001391",
            status: "completed",
          }),
        );
        const texts = threadMessages(harness.events, threadId)
          .filter((event) => event.message.role === "assistant")
          .map((event) => event.message.text);
        assert.lengthOf(texts, 81);
        assert.equal(texts.at(-1), "FINAL ANSWER", "the answer past the first read is shown");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001392", result: "Done." }),
        );
        yield* Queue.take(harness.terminalReceipts);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("re-reads a workflow member's transcript after a restart without new items", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runOnce = Effect.fnUntraced(function* (attemptId: string) {
          const harness = yield* makeWorkflowHarness;
          NodeFS.writeFileSync(
            NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
            memberTranscript,
          );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(attemptId),
              text: "Run the alpha workflow.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001380" });
          const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001381", result: "Done." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
            "user_message",
            "reasoning: List the files first.",
            "command completed: README.md",
            "assistant_message",
          ]);
          return new Set(memberThreadItems(harness.events, threadId).map((item) => item.id));
        });
        const before = yield* runOnce("attempt-claude-workflow-before-restart");
        const after = yield* runOnce("attempt-claude-workflow-after-restart");
        assert.isAtLeast(before.size, 4);
        assert.deepEqual(
          [...after].filter((id) => !before.has(id)),
          [],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
