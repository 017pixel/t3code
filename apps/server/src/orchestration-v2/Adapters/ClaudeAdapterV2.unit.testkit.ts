// Shared setup for the ClaudeAdapterV2.*.test.ts unit tests. Each file drives the adapter
// through a scripted query runner (the wake harness) and builds SDK frames with these helpers.
// Kept apart from ClaudeAdapterV2.testkit.ts, whose replay imports add about a second to
// every test file that loads it.
import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type RunAttemptId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import type * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

export const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
export const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
export const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

export const WAKE_NATIVE_SESSION = "native-thread-claude-wake";
export const WAKE_TASK_ID = "bdqirlcyw";
const WAKE_TOOL_USE_ID = "toolu_01Rs6JNNf5SqHRxpq5DeJHrW";
const WAKE_TASK_DESCRIPTION = "Background sleep test";
export const WAKE_SUMMARY = 'Background command "Background sleep test" completed (exit code 0)';
export const WAKE_ASSISTANT_TEXT = "WAKE_DONE";
export const WAKE_RESULT_TEXT = "WAKE_DONE";

export function claudeSdkFrame(frame: unknown): SDKMessage {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof Reflect.get(frame, "type") !== "string"
  ) {
    throw new Error("Frame is not a Claude Agent SDK message.");
  }
  return frame as SDKMessage;
}

export const wakeTaskStarted = claudeSdkFrame({
  type: "system",
  subtype: "task_started",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  description: WAKE_TASK_DESCRIPTION,
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "00000000-0000-4000-8000-000000000101",
  session_id: WAKE_NATIVE_SESSION,
});
export const makeAssistantTextFrame = (input: { readonly uuid: string; readonly text: string }) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
export const makeAssistantErrorFrame = (input: {
  readonly uuid: string;
  readonly error:
    | "authentication_failed"
    | "invalid_request"
    | "rate_limit"
    | "server_error"
    | undefined;
  readonly text?: string;
  readonly parentToolUseId?: string | null;
  readonly apiErrorParams?: unknown;
}) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: input.text ?? "Claude could not complete this request." }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: input.parentToolUseId ?? null,
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.apiErrorParams === undefined ? {} : { api_error_params: input.apiErrorParams }),
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
export const makeResultFrame = (input: {
  readonly uuid: string;
  readonly result: string;
  readonly numTurns?: number;
  readonly origin?: { readonly kind: "task-notification" };
  readonly subtype?: string;
  readonly isError?: boolean;
  readonly errors?: ReadonlyArray<string>;
  readonly apiErrorStatus?: number;
  // null omits the field, as the CLI does on a zero-turn result.
  readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
}) =>
  claudeSdkFrame({
    type: "result",
    subtype: input.subtype ?? "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: input.isError ?? false,
    num_turns: input.numTurns ?? 1,
    result: input.result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: input.usage ?? {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.errors === undefined ? {} : { errors: input.errors }),
    ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
    ...(input.terminalReason === null
      ? {}
      : { terminal_reason: input.terminalReason ?? "completed" }),
  });
export const turnOneResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000102",
  result: "Kicked off the build in the background.",
});
export const wakeNotification = claudeSdkFrame({
  type: "system",
  subtype: "task_notification",
  task_id: WAKE_TASK_ID,
  tool_use_id: WAKE_TOOL_USE_ID,
  status: "completed",
  output_file: `/tmp/claude-replay/tasks/${WAKE_TASK_ID}.output`,
  summary: WAKE_SUMMARY,
  uuid: "00000000-0000-4000-8000-000000000103",
  session_id: WAKE_NATIVE_SESSION,
});
export const wakeAssistant = makeAssistantTextFrame({
  uuid: "00000000-0000-4000-8000-000000000107",
  text: WAKE_ASSISTANT_TEXT,
});
export const wakeTurnInit = claudeSdkFrame({
  type: "system",
  subtype: "init",
  uuid: "00000000-0000-4000-8000-000000000110",
  session_id: WAKE_NATIVE_SESSION,
});
export const wakeResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000104",
  result: WAKE_RESULT_TEXT,
  origin: { kind: "task-notification" },
});
export const STALE_TASK_NOTIFICATION_RESULT_TEXT =
  "Stale task-notification origin text that must not appear.";
// Shape seen live after interrupt recovery: zero turns, no terminal_reason.
export const staleTaskNotificationResult = makeResultFrame({
  uuid: "00000000-0000-4000-8000-000000000106",
  result: STALE_TASK_NOTIFICATION_RESULT_TEXT,
  numTurns: 0,
  origin: { kind: "task-notification" },
  terminalReason: null,
});

// Harnesses notify after every recorded event, continuation, or prompt, so a
// wait re-checks exactly when the state it reads changes. Subscribing before
// the first check means a change that lands in between is not lost.
export const makeChangeSignal = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const until = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        while (!predicate()) yield* PubSub.take(subscription);
      }),
    );
  return { notify: PubSub.publish(changes, undefined), until };
});

// Fixed quiet windows for asserting that nothing happens after input the
// harness cannot observe being handled (a shut-down query, a replaced process).
export const yieldTicks = (ticks: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow;
  });

export const makeWakeHarnessWithOptions = (options?: {
  readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
  readonly interrupt?: Effect.Effect<void>;
  readonly setPermissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["setPermissionMode"];
  readonly stopTask?: (
    taskId: string,
  ) => Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly backgroundTasks?: (
    toolUseId: string,
  ) => Effect.Effect<boolean, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly subagentLaunchToolUseId?: string;
  readonly nativeSessionId?: string;
  readonly settings?: ClaudeSettings;
  readonly freshQueueOnReopen?: boolean;
  readonly forkSession?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["forkSession"];
  readonly allocateSessionId?: Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-wake-",
    });
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const processQueues: Array<Queue.Queue<SDKMessage>> = [];
    const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
    const offerAndWait = Effect.fnUntraced(function* (
      message: SDKMessage,
      offered?: Deferred.Deferred<void>,
    ) {
      const processed = yield* Deferred.make<void>();
      processedMessages.set(message, processed);
      yield* Queue.offer(processQueues.at(-1) ?? sdkMessages, message);
      if (offered !== undefined) yield* Deferred.succeed(offered, undefined);
      yield* Deferred.await(processed);
    });
    const changes = yield* makeChangeSignal;
    const offeredMessages: Array<SDKUserMessage> = [];
    const permissionModeChanges: Array<string> = [];
    const liveSelectionChanges: Array<unknown> = [];
    const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
      [];
    const continuationReceipts =
      yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
    const terminalReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
      >();
    const subagentReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }>
      >();
    const systemNoticeReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
      >();
    const runtimeRequestReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
      >();
    const planReceipts =
      yield* Queue.unbounded<
        Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "plan.updated" }>
      >();
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
      environment: options?.environment ?? {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator,
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }).pipe(
            Effect.andThen(Queue.offer(continuationReceipts, request)),
            Effect.andThen(changes.notify),
          ),
      },
      queryRunner: {
        allocateSessionId:
          options?.allocateSessionId ??
          Effect.succeed(options?.nativeSessionId ?? WAKE_NATIVE_SESSION),
        open: (input) =>
          Effect.gen(function* () {
            openedOptions = input.options;
            const processMessages =
              options?.freshQueueOnReopen === true && processQueues.length > 0
                ? yield* Queue.unbounded<SDKMessage>()
                : sdkMessages;
            const messages = Stream.fromQueue(processMessages).pipe(
              Stream.flatMap((message) =>
                Stream.make(message).pipe(
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() => {
                        const processed = processedMessages.get(message);
                        return processed === undefined
                          ? Effect.void
                          : Deferred.succeed(processed, undefined);
                      }),
                    ).pipe(Stream.drain),
                  ),
                ),
              ),
            );
            if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
              processQueues.push(processMessages);
              return {
                messages,
                offer: (message: SDKUserMessage) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }).pipe(Effect.andThen(changes.notify)),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: (mode) =>
                  Effect.sync(() => {
                    permissionModeChanges.push(mode);
                  }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
                backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                stopTask: options?.stopTask ?? (() => Effect.void),
                interrupt: Effect.void,
                close: Queue.shutdown(processMessages),
              };
            }
            processQueues.push(sdkMessages);
            return {
              messages,
              offer: (message) =>
                Effect.sync(() => {
                  offeredMessages.push(message);
                }).pipe(Effect.andThen(changes.notify)),
              setModel: (model) =>
                Effect.sync(() => {
                  liveSelectionChanges.push({ model });
                }),
              applyFlagSettings: (settings) =>
                Effect.sync(() => {
                  liveSelectionChanges.push(settings);
                }),
              setPermissionMode: (mode) =>
                Effect.sync(() => {
                  permissionModeChanges.push(mode);
                }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
              backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
              stopTask: options?.stopTask ?? (() => Effect.void),
              interrupt: options?.interrupt ?? Effect.void,
              close: options?.close?.(sdkMessages) ?? Effect.void,
            };
          }),
        forkSession: options?.forkSession ?? (() => Effect.die("unused forkSession")),
        subagentLaunchToolUseId: () => Effect.succeed(options?.subagentLaunchToolUseId ?? null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make("thread-claude-wake");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "subagent.updated") {
            yield* Queue.offer(subagentReceipts, event);
          }
          if (event.type === "turn.terminal") {
            yield* Queue.offer(terminalReceipts, event);
          }
          if (event.type === "runtime_request.updated") {
            yield* Queue.offer(runtimeRequestReceipts, event);
          }
          if (event.type === "plan.updated") {
            yield* Queue.offer(planReceipts, event);
          }
          if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
            yield* Queue.offer(systemNoticeReceipts, event);
          }
          yield* changes.notify;
        }),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    return {
      attachmentsDir,
      runtime,
      providerThread,
      threadId,
      sdkMessages,
      processQueues,
      offerAndWait,
      offeredMessages,
      promptUuid: (index: number) => {
        const uuid = offeredMessages[index]?.uuid;
        if (uuid === undefined) throw new Error(`No prompt offered at index ${index}.`);
        return uuid;
      },
      permissionModeChanges,
      liveSelectionChanges,
      continuationRequests,
      continuationReceipts,
      events,
      terminalReceipts,
      subagentReceipts,
      systemNoticeReceipts,
      runtimeRequestReceipts,
      planReceipts,
      getOpenedOptions: () => openedOptions,
      terminalEvents,
      hasPendingBackgroundWork,
      until: changes.until,
      awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
      awaitContinuation: (count: number) =>
        changes.until(() => continuationRequests.length >= count),
    };
  });
export const makeWakeHarness = makeWakeHarnessWithOptions();

export const makeSubagentAssistantFrames = (input: {
  readonly parentToolUseId: string;
  readonly uuid: string;
  readonly messageId?: string;
  readonly text?: string;
  readonly bashToolUseId?: string;
}): ReadonlyArray<SDKMessage> =>
  [
    ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
    ...(input.bashToolUseId === undefined
      ? []
      : [
          {
            type: "tool_use",
            id: input.bashToolUseId,
            name: "Bash",
            input: { command: "git log -5" },
          },
        ]),
  ].map((block, index) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        id: input.messageId ?? `msg_${input.uuid}`,
        type: "message",
        role: "assistant",
        content: [block],
      },
      parent_tool_use_id: input.parentToolUseId,
      uuid: index === 0 ? input.uuid : `${input.uuid}:${index}`,
      session_id: WAKE_NATIVE_SESSION,
    }),
  );
export const makeSubagentToolResultFrame = (input: {
  readonly parentToolUseId: string;
  readonly uuid: string;
  readonly toolUseId: string;
}) =>
  claudeSdkFrame({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: input.toolUseId, content: "ok" }],
    },
    parent_tool_use_id: input.parentToolUseId,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
export const makeSubagentTaskStartedFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    description: "Audit recent commits",
    subagent_type: "general-purpose",
    is_backgrounded: true,
    task_type: "local_agent",
    prompt: "Audit the last five commits.",
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
export const makeSubagentNotificationFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly summary: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    status: "completed",
    output_file: `/tmp/${input.taskId}.output`,
    summary: input.summary,
    uuid: input.uuid,
    session_id: WAKE_NATIVE_SESSION,
  });
