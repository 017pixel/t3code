import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import type { AtomCommandResult } from "./runtime.ts";
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

function connection(
  phase: SupervisorConnectionState["phase"],
  generation: number,
): SupervisorConnectionState {
  return { ...AVAILABLE_CONNECTION_STATE, phase, generation };
}

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

function setup(results: ReadonlyArray<SendResult | Promise<SendResult>>) {
  const queue = [...results];
  const sent: Array<TurnDeliveryInput> = [];
  let threadListener: ((state: EnvironmentThreadState) => void) | null = null;
  let connectionListener: ((state: SupervisorConnectionState) => void) | null = null;
  let threadObservations = 0;
  const deliveries = createTurnDeliveries<{ sequence: number }, unknown, string>({
    send: async (_environmentId, input) => {
      sent.push(input);
      return queue.shift() ?? ACCEPTED;
    },
    observeThread: (_environmentId, _threadId, listener) => {
      threadObservations += 1;
      threadListener = listener;
      listener(thread("live"));
      return () => {
        threadListener = null;
      };
    },
    observeConnection: (_environmentId, listener) => {
      connectionListener = listener;
      listener(connection("connected", 1));
      return () => {
        connectionListener = null;
      };
    },
  });
  return {
    deliveries,
    sent,
    threadObservations: () => threadObservations,
    emitThread: (state: EnvironmentThreadState) => threadListener?.(state),
    emitConnection: (state: SupervisorConnectionState) => connectionListener?.(state),
  };
}

async function deliverUntilWaiting(harness: ReturnType<typeof setup>, input = INPUT) {
  const outcome = await harness.deliveries.deliver(ENVIRONMENT_ID, input, "optimistic row");
  expect(outcome.type).toBe("waiting");
  if (outcome.type !== "waiting") throw new Error(`Expected waiting, got ${outcome.type}.`);
  return outcome.settled;
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
    const settled = await deliverUntilWaiting(harness);

    harness.emitThread(thread("cached"));
    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));

    expect(await settled).toEqual({ type: "delivered", value: { sequence: 7 } });
    expect(harness.sent).toEqual([INPUT, INPUT]);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
  });

  it("settles without a resend when the resynced thread already holds the message", async () => {
    const harness = setup([LOST_ACK]);
    const settled = await deliverUntilWaiting(harness);

    harness.emitThread(thread("synchronizing"));
    harness.emitThread(
      thread("live", {
        messages: [
          { id: MESSAGE_ID, role: "user" } as OrchestrationV2ThreadProjection["messages"][number],
        ],
      }),
    );

    expect(await settled).toEqual({ type: "delivered", value: null });
    expect(harness.sent).toHaveLength(1);
  });

  it("settles without a resend when the resynced thread queued the message", async () => {
    const harness = setup([LOST_ACK]);
    const settled = await deliverUntilWaiting(harness);

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
    const settled = await deliverUntilWaiting(harness);

    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));

    expect(await settled).toEqual({ type: "rejected", failure: REJECTED });
    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));
    expect(harness.sent).toHaveLength(2);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
  });

  it("stops replaying after a cancel", async () => {
    const harness = setup([LOST_ACK]);
    const settled = await deliverUntilWaiting(harness);
    const [pending] = harness.deliveries.getSnapshot();

    harness.deliveries.cancel(pending!.key);
    harness.emitThread(thread("synchronizing"));
    harness.emitThread(thread("live"));

    expect(await settled).toEqual({ type: "cancelled" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.deliveries.getSnapshot()).toEqual([]);
  });

  it("keeps a replay the server accepted even when cancelled while it was in flight", async () => {
    let acceptReplay!: (result: SendResult) => void;
    const replay = new Promise<SendResult>((resolve) => {
      acceptReplay = resolve;
    });
    const harness = setup([LOST_ACK, replay]);
    const settled = await deliverUntilWaiting(harness);

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
    const outcome = await harness.deliveries.deliver(ENVIRONMENT_ID, INPUT, "optimistic row");

    expect(outcome).toEqual({ type: "rejected", failure: REJECTED });
    expect(harness.deliveries.getSnapshot()).toEqual([]);
  });

  it("replays a first message after reconnecting without watching the unborn thread", async () => {
    const harness = setup([LOST_ACK, ACCEPTED]);
    const settled = await deliverUntilWaiting(harness, LAUNCH);

    harness.emitConnection(connection("connected", 1));
    expect(harness.sent).toHaveLength(1);
    harness.emitConnection(connection("connecting", 2));
    harness.emitConnection(connection("connected", 2));

    expect(await settled).toEqual({ type: "delivered", value: { sequence: 7 } });
    expect(harness.sent).toEqual([LAUNCH, LAUNCH]);
    expect(harness.threadObservations()).toBe(0);
  });
});
