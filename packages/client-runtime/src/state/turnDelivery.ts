import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import type { SupervisorConnectionState } from "../connection/model.ts";
import { isRetryableDeliveryFailure } from "../errors/transport.ts";
import type { StartThreadTurnInput } from "../operations/commands.ts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./runtime.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

export type TurnDeliveryInput = StartThreadTurnInput & { readonly commandId: CommandId };

export type TurnDeliveryFailure = Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>;

type TurnDeliveryEnd<A> =
  /** `value` is null when a resynced thread already held the message. */
  | { readonly type: "delivered"; readonly value: A | null }
  | { readonly type: "rejected"; readonly failure: TurnDeliveryFailure }
  | { readonly type: "cancelled" };

type TurnDeliveryOutcome<A> =
  | TurnDeliveryEnd<A>
  /** The server may have committed it; `settled` ends after a later resync or cancel. */
  | { readonly type: "waiting"; readonly settled: Promise<TurnDeliveryEnd<A>> };

export interface PendingTurnDelivery<M> {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly state: "waiting" | "retrying";
  readonly display: M;
}

interface TurnDeliveryDependencies<A, E> {
  readonly send: (
    environmentId: EnvironmentId,
    input: TurnDeliveryInput,
  ) => Promise<AtomCommandResult<A, E>>;
  /** Must call the listener with the current state before returning. */
  readonly observeThread: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    listener: (state: EnvironmentThreadState) => void,
  ) => () => void;
  /** Must call the listener with the current state before returning. */
  readonly observeConnection: (
    environmentId: EnvironmentId,
    listener: (state: SupervisorConnectionState) => void,
  ) => () => void;
}

interface Entry<A, M> {
  readonly pending: Omit<PendingTurnDelivery<M>, "state">;
  readonly input: TurnDeliveryInput;
  readonly launch: boolean;
  state: "sending" | "waiting";
  failedOnce: boolean;
  cancelRequested: boolean;
  /** The thread left live sync since the last dispatch. */
  resynced: boolean;
  thread: EnvironmentThreadState | null;
  connection: SupervisorConnectionState | null;
  dispatchGeneration: number;
  settle: (end: TurnDeliveryEnd<A>) => void;
  stopObserving: Array<() => void>;
}

function turnDeliveryKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
): string {
  return JSON.stringify([environmentId, threadId, messageId]);
}

function threadHoldsUserMessage(state: EnvironmentThreadState, messageId: MessageId): boolean {
  return Option.match(state.data, {
    onNone: () => false,
    onSome: (projection) =>
      projection.messages.some((message) => message.id === messageId) ||
      projection.runs.some((run) => run.userMessageId === messageId) ||
      projection.turnItems.some(
        (item) => item.type === "user_message" && item.messageId === messageId,
      ),
  });
}

/**
 * Keeps a send whose acknowledgement was lost until the thread resyncs on a later session, then
 * settles it when the server already holds the message or replays the same command otherwise.
 * Waiting happens here, outside the thread's serial command lane, so Stop is never held behind it.
 */
export function createTurnDeliveries<A, E, M>(deps: TurnDeliveryDependencies<A, E>) {
  const entries = new Map<string, Entry<A, M>>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyArray<PendingTurnDelivery<M>> = [];

  const publish = () => {
    snapshot = [...entries.values()].flatMap((entry) =>
      entry.failedOnce
        ? [
            {
              ...entry.pending,
              state: entry.state === "waiting" ? ("waiting" as const) : ("retrying" as const),
            },
          ]
        : [],
    );
    for (const listener of listeners) listener();
  };

  const finish = (entry: Entry<A, M>, end: TurnDeliveryEnd<A>) => {
    if (entries.get(entry.pending.key) !== entry) return;
    entries.delete(entry.pending.key);
    for (const stop of entry.stopObserving) stop();
    if (entry.failedOnce) publish();
    entry.settle(end);
  };

  // A launch's thread may not exist yet, and its command receipt makes a replay safe.
  const readyToReplay = (entry: Entry<A, M>) =>
    entry.launch
      ? entry.connection?.phase === "connected" &&
        entry.connection.generation > entry.dispatchGeneration
      : entry.resynced && entry.thread?.status === "live";

  const evaluate = (entry: Entry<A, M>) => {
    if (entry.state !== "waiting") return;
    if (!entry.launch && entry.thread?.status === "deleted") {
      finish(entry, {
        type: "rejected",
        failure: AsyncResult.failure(Cause.fail(new Error("The thread was deleted."))),
      });
      return;
    }
    if (!readyToReplay(entry)) return;
    if (!entry.launch && threadHoldsUserMessage(entry.thread!, entry.pending.messageId)) {
      finish(entry, { type: "delivered", value: null });
      return;
    }
    void dispatch(entry).then((end) => {
      if (end !== null) finish(entry, end);
    });
  };

  const dispatch = async (entry: Entry<A, M>): Promise<TurnDeliveryEnd<A> | null> => {
    entry.state = "sending";
    entry.resynced = false;
    entry.dispatchGeneration = entry.connection?.generation ?? 0;
    if (entry.failedOnce) publish();
    const result = await deps.send(entry.pending.environmentId, entry.input);
    if (result._tag === "Success") return { type: "delivered", value: result.value };
    const retryable =
      isAtomCommandInterrupted(result) ||
      isRetryableDeliveryFailure(squashAtomCommandFailure(result));
    if (entry.cancelRequested) return { type: "cancelled" };
    if (!retryable) return { type: "rejected", failure: result };
    entry.state = "waiting";
    entry.failedOnce = true;
    publish();
    evaluate(entry);
    return null;
  };

  const deliver = async (
    environmentId: EnvironmentId,
    input: TurnDeliveryInput,
    display: M,
  ): Promise<TurnDeliveryOutcome<A>> => {
    const key = turnDeliveryKey(environmentId, input.threadId, input.message.messageId);
    let settle!: (end: TurnDeliveryEnd<A>) => void;
    const settled = new Promise<TurnDeliveryEnd<A>>((resolve) => {
      settle = resolve;
    });
    const entry: Entry<A, M> = {
      pending: {
        key,
        environmentId,
        threadId: input.threadId,
        messageId: input.message.messageId,
        display,
      },
      input,
      // Observing a thread that does not exist yet would park its state as deleted.
      launch: input.bootstrap?.createThread !== undefined,
      state: "sending",
      failedOnce: false,
      cancelRequested: false,
      resynced: false,
      thread: null,
      connection: null,
      dispatchGeneration: 0,
      settle,
      stopObserving: [],
    };
    const previous = entries.get(key);
    if (previous !== undefined) finish(previous, { type: "cancelled" });
    entries.set(key, entry);
    entry.stopObserving.push(
      deps.observeConnection(environmentId, (state) => {
        entry.connection = state;
        evaluate(entry);
      }),
    );
    if (!entry.launch) {
      entry.stopObserving.push(
        deps.observeThread(environmentId, input.threadId, (state) => {
          entry.thread = state;
          if (state.status !== "live") entry.resynced = true;
          evaluate(entry);
        }),
      );
    }
    const end = await dispatch(entry);
    if (end === null) return { type: "waiting", settled };
    finish(entry, end);
    return end;
  };

  /** Stops local delivery only; a command the server already committed stays committed. */
  const cancel = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    if (entry.state === "waiting") {
      finish(entry, { type: "cancelled" });
      return;
    }
    entry.cancelRequested = true;
  };

  return {
    deliver,
    cancel,
    getSnapshot: (): ReadonlyArray<PendingTurnDelivery<M>> => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
