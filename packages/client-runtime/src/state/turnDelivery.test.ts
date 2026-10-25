import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { wasBootstrapThreadDeleted } from "../errors/orchestration.ts";
import { type AtomCommandResult, squashAtomCommandFailure } from "./runtime.ts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";
import { createTurnDeliveries, type TurnDeliveryInput } from "./turnDelivery.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment");
const THREAD_ID = ThreadId.make("thread");
const MESSAGE_ID = MessageId.make("message");
const MODEL_SELECTION = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const INPUT: TurnDeliveryInput = {
  commandId: CommandId.make("command"),
  threadId: THREAD_ID,
  message: {
    messageId: MESSAGE_ID,
    role: "user",
    text: "Delivery check. Reply only with RECEIVED.",
    attachments: [],
  },
  modelSelection: MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
};

const LAUNCH: TurnDeliveryInput = {
  ...INPUT,
  bootstrap: {
    createThread: {
      projectId: ProjectId.make("project"),
      title: "New thread",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-10-25T00:00:00.000Z",
    },
  },
};

type SendResult = AtomCommandResult<{ sequence: number }, unknown>;

const LOST_ACK: SendResult = AsyncResult.failure(
  Cause.fail({ _tag: "RpcClientError", message: "SocketCloseError" }),
);
const REJECTED: SendResult = AsyncResult.failure(
  Cause.fail({ _tag: "OrchestrationDispatchCommandError", message: "Thread is archived." }),
);
const ACCEPTED: SendResult = AsyncResult.success({ sequence: 7 });

function shell(
  status: EnvironmentShellState["status"],
  threadIds: ReadonlyArray<ThreadId> = [],
): EnvironmentShellState {
  return {
    ...EMPTY_SHELL_STATE,
    status,
    snapshot: Option.some({
      threads: threadIds.map((id) => ({ id })),
      archivedThreads: [],
    } as unknown as OrchestrationV2ShellSnapshot),
  };
}

const HELD = thread("live", {
  messages: [
    { id: MESSAGE_ID, role: "user" } as OrchestrationV2ThreadProjection["messages"][number],
  ],
});

function thread(
  status: EnvironmentThreadState["status"],
  projection: Partial<Pick<OrchestrationV2ThreadProjection, "messages" | "runs">> = {},
): EnvironmentThreadState {
  return {
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    status,
    data: Option.some({
      messages: [],
      runs: [],
      turnItems: [],
      ...projection,
    } as unknown as OrchestrationV2ThreadProjection),
  };
}

function setup(
  results: ReadonlyArray<SendResult | Promise<SendResult>>,
  initialThread = thread("live"),
) {
  const queue = [...results];
  const sent: Array<TurnDeliveryInput> = [];
  let threadListener: ((state: EnvironmentThreadState) => void) | null = null;
  let shellListener: ((state: EnvironmentShellState) => void) | null = null;
  let threadObservations = 0;
  let activeObservers = 0;
  let displaysMade = 0;
  const released: Array<string> = [];
  const deliveries = createTurnDeliveries<{ sequence: number }, unknown, string>({
    send: async (_environmentId, input) => {
      sent.push(input);
      return queue.shift() ?? ACCEPTED;
    },
    observeThread: (_environmentId, _threadId, listener) => {
      threadObservations += 1;
      activeObservers += 1;
      threadListener = listener;
      listener(initialThread);
      return () => {
        activeObservers -= 1;
        threadListener = null;
      };
    },
    observeShell: (_environmentId, listener) => {
      activeObservers += 1;
      shellListener = listener;
      listener(shell("live"));
      return () => {
        activeObservers -= 1;
        shellListener = null;
      };
    },
    releaseDisplay: (display) => {
      released.push(display);
    },
  });
  return {
    deliveries,
    sent,
    released,
    threadObservations: () => threadObservations,
    activeObservers: () => activeObservers,
    displaysMade: () => displaysMade,
    makeDisplay: () => {
      displaysMade += 1;
      return "optimistic row";
    },
    emitThread: (state: EnvironmentThreadState) => threadListener?.(state),
    emitShell: (state: EnvironmentShellState) => shellListener?.(state),
  };
}

async function deliverUntilWaiting(harness: ReturnType<typeof setup>, input = INPUT) {
  const outcome = await harness.deliveries.deliver(ENVIRONMENT_ID, input, harness.makeDisplay);
  expect(outcome.type).toBe("waiting");
  if (outcome.type !== "waiting") throw new Error(`Expected waiting, got ${outcome.type}.`);
  // Wrapped: an async function returning the promise would wait for it to settle.
  return { settled: outcome.settled };
}

describe("turn deliveries", () => {
  it("keeps a send whose acknowledgement was lost instead of rejecting it", async () => {
    const harness = setup([LOST_ACK]);
    await deliverUntilWaiting(harness);

    expect(harness.deliveries.getSnapshot()).toEqual([
      expect.objectContaining({
        messageId: MESSAGE_ID,
        state: "waiting",
        display: "optimistic row",
      }),
    ]);
    expect(harness.sent).toHaveLength(1);
  });

  it("does not replay until the thread resyncs after the lost send", async () => {
    const harness = setup([LOST_ACK]);
    await deliverUntilWaiting(harness);

    harness.emitThread(thread("live"));
    harness.emitThread(thread("synchronizing"));

    expect(harness.sent).toHaveLength(1);
  });

  it("replays the same command and payload once the thread resyncs without the message", async () => {
    const harness = setup([LOST_ACK, ACCEPTED]);
    const { settled } = await deliverUntilWaiting(harness);

    harness.emitThread(thread("cached"));
    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));

    expect(await settled).toEqual({ type: "delivered", value: { sequence: 7 } });
    expect(harness.sent).toEqual([INPUT, INPUT]);
  });

  it("keeps an acknowledged replay on screen until the thread shows the message", async () => {
    const harness = setup([LOST_ACK, ACCEPTED]);
    const { settled } = await deliverUntilWaiting(harness);

    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));
    await settled;

    expect(harness.deliveries.getSnapshot()).toEqual([
      expect.objectContaining({ state: "delivered", display: "optimistic row" }),
    ]);
    expect(harness.released).toEqual([]);
    harness.emitThread(HELD);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
    expect(harness.released).toEqual(["optimistic row"]);
  });

  it("settles without a resend when the resynced thread already holds the message", async () => {
    const harness = setup([LOST_ACK]);
    const { settled } = await deliverUntilWaiting(harness);

    harness.emitThread(thread("synchronizing"));
    harness.emitThread(HELD);

    expect(await settled).toEqual({ type: "delivered", value: null });
    expect(harness.sent).toHaveLength(1);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
  });

  it("settles without a resend when the resynced thread queued the message", async () => {
    const harness = setup([LOST_ACK]);
    const { settled } = await deliverUntilWaiting(harness);

    harness.emitThread(thread("synchronizing"));
    harness.emitThread(
      thread("live", {
        runs: [
          {
            userMessageId: MESSAGE_ID,
            status: "queued",
          } as OrchestrationV2ThreadProjection["runs"][number],
        ],
      }),
    );

    expect(await settled).toEqual({ type: "delivered", value: null });
    expect(harness.sent).toHaveLength(1);
  });

  it("ends once with the rejection when the replay is refused", async () => {
    const harness = setup([LOST_ACK, REJECTED]);
    const { settled } = await deliverUntilWaiting(harness);

    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));

    expect(await settled).toEqual({ type: "rejected", failure: REJECTED });
    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));
    expect(harness.sent).toHaveLength(2);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
    expect(harness.released).toEqual(["optimistic row"]);
  });

  it("stops replaying after a cancel", async () => {
    const harness = setup([LOST_ACK]);
    const { settled } = await deliverUntilWaiting(harness);
    const [pending] = harness.deliveries.getSnapshot();

    harness.deliveries.cancel(pending!.key);
    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));

    expect(await settled).toEqual({ type: "cancelled" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
    expect(harness.released).toEqual(["optimistic row"]);
  });

  it("keeps a replay the server accepted even when cancelled while it was in flight", async () => {
    let acceptReplay!: (result: SendResult) => void;
    const replay = new Promise<SendResult>((resolve) => {
      acceptReplay = resolve;
    });
    const harness = setup([LOST_ACK, replay]);
    const { settled } = await deliverUntilWaiting(harness);

    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));
    const [pending] = harness.deliveries.getSnapshot();
    expect(pending?.state).toBe("retrying");
    harness.deliveries.cancel(pending!.key);
    acceptReplay(ACCEPTED);

    expect(await settled).toEqual({ type: "delivered", value: { sequence: 7 } });
  });

  it("returns a rejection right away without holding the send", async () => {
    const harness = setup([REJECTED]);
    const outcome = await harness.deliveries.deliver(ENVIRONMENT_ID, INPUT, harness.makeDisplay);

    expect(outcome).toEqual({ type: "rejected", failure: REJECTED });
    expect(harness.deliveries.getSnapshot()).toEqual([]);
    expect(harness.displaysMade()).toBe(0);
  });

  it("replays a first message once the resynced shell lacks its thread, without watching it", async () => {
    const harness = setup([LOST_ACK, ACCEPTED]);
    const { settled } = await deliverUntilWaiting(harness, LAUNCH);

    harness.emitShell(shell("live"));
    expect(harness.sent).toHaveLength(1);
    harness.emitShell(shell("synchronizing"));
    harness.emitShell(shell("live"));

    expect(await settled).toEqual({ type: "delivered", value: { sequence: 7 } });
    expect(harness.sent).toEqual([LAUNCH, LAUNCH]);
    expect(harness.threadObservations()).toBe(1);
  });

  it("settles a launch the resynced shell already holds without replaying it", async () => {
    const harness = setup([LOST_ACK], EMPTY_ENVIRONMENT_THREAD_STATE);
    const { settled } = await deliverUntilWaiting(harness, LAUNCH);
    expect(harness.threadObservations()).toBe(0);

    harness.emitShell(shell("synchronizing"));
    harness.emitShell(shell("live", [THREAD_ID]));
    harness.emitThread(HELD);

    expect(await settled).toEqual({ type: "delivered", value: null });
    expect(harness.sent).toEqual([LAUNCH]);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
  });

  it("waits without replaying a launch the shell holds until its thread shows the message", async () => {
    const harness = setup([LOST_ACK, ACCEPTED], thread("live"));
    const { settled } = await deliverUntilWaiting(harness, LAUNCH);

    harness.emitShell(shell("synchronizing"));
    harness.emitShell(shell("live", [THREAD_ID]));
    // The shell proves only the thread.create; the first message may still be missing.
    expect(harness.deliveries.getSnapshot()).toEqual([
      expect.objectContaining({ state: "waiting", display: "optimistic row" }),
    ]);
    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));
    harness.emitShell(shell("synchronizing", [THREAD_ID]));
    harness.emitShell(shell("live", [THREAD_ID]));
    expect(harness.sent).toEqual([LAUNCH]);
    expect(harness.threadObservations()).toBe(1);
    expect(harness.deliveries.getSnapshot()).toEqual([
      expect.objectContaining({ state: "waiting" }),
    ]);

    harness.emitThread(HELD);
    expect(await settled).toEqual({ type: "delivered", value: null });
    expect(harness.deliveries.getSnapshot()).toEqual([]);
    expect(harness.released).toEqual(["optimistic row"]);
    expect(harness.activeObservers()).toBe(0);
  });

  it("cancels a launch the shell holds while its thread lacks the message", async () => {
    const harness = setup([LOST_ACK], thread("live"));
    const { settled } = await deliverUntilWaiting(harness, LAUNCH);

    harness.emitShell(shell("synchronizing"));
    harness.emitShell(shell("live", [THREAD_ID]));
    const [pending] = harness.deliveries.getSnapshot();
    harness.deliveries.cancel(pending!.key);

    expect(await settled).toEqual({ type: "cancelled" });
    expect(harness.sent).toEqual([LAUNCH]);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
    expect(harness.released).toEqual(["optimistic row"]);
    expect(harness.activeObservers()).toBe(0);
  });

  it("rejects a launch the shell held once its thread is deleted", async () => {
    const harness = setup([LOST_ACK], thread("live"));
    const { settled } = await deliverUntilWaiting(harness, LAUNCH);

    harness.emitShell(shell("synchronizing"));
    harness.emitShell(shell("live", [THREAD_ID]));
    harness.emitThread(thread("deleted"));

    const end = await settled;
    // The composer gives a restored draft a fresh thread id only for this classification.
    expect(
      end.type === "rejected" && wasBootstrapThreadDeleted(squashAtomCommandFailure(end.failure)),
    ).toBe(true);
    expect(harness.sent).toEqual([LAUNCH]);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
    expect(harness.activeObservers()).toBe(0);
  });

  it("stops watching a committed launch whose thread already shows the message", async () => {
    const harness = setup([LOST_ACK], HELD);
    const { settled } = await deliverUntilWaiting(harness, LAUNCH);

    harness.emitShell(shell("synchronizing"));
    harness.emitShell(shell("live", [THREAD_ID]));

    expect(await settled).toEqual({ type: "delivered", value: null });
    expect(harness.deliveries.getSnapshot()).toEqual([]);
    expect(harness.activeObservers()).toBe(0);
  });
});
