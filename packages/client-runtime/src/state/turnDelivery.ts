import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { isRetryableDeliveryFailure } from "../errors/transport.ts";
import type { StartThreadTurnInput } from "../operations/commands.ts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";
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
  /** `delivered` rows stay until the thread shows the message, since they may be its only copy. */
  readonly state: "waiting" | "retrying" | "delivered";
  readonly display: M;
}

interface TurnDeliveryDependencies<A, E, M> {
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
  readonly observeShell: (
    environmentId: EnvironmentId,
    listener: (state: EnvironmentShellState) => void,
  ) => () => void;
  /** Frees a display made by `deliver`'s factory once no pending row shows it. */
  readonly releaseDisplay: (display: M) => void;
}

interface Entry<A, M> {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly input: TurnDeliveryInput;
  readonly createDisplay: () => M;
  /** Made on the first lost acknowledgement, so a send that lands at once owns nothing. */
  display: M | null;
  /** Observing a thread that does not exist yet would park its state as deleted. */
  unborn: boolean;
  state: "sending" | "waiting" | "delivered";
  cancelRequested: boolean;
  /** The thread, or for an unborn one the shell, left live sync since the last dispatch. */
  resynced: boolean;
  thread: EnvironmentThreadState | null;
  shell: EnvironmentShellState | null;
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

function shellHoldsThread(state: EnvironmentShellState, threadId: ThreadId): boolean {
  return Option.match(state.snapshot, {
    onNone: () => false,
    onSome: (snapshot) =>
      snapshot.threads.some((thread) => thread.id === threadId) ||
      snapshot.archivedThreads.some((thread) => thread.id === threadId),
  });
}

/**
 * Keeps a send whose acknowledgement was lost until the thread resyncs on a later session, then
 * settles it when the server already holds the message or replays the same command otherwise.
 * Waiting happens here, outside the thread's serial command lane, so Stop is never held behind it.
 */
export function createTurnDeliveries<A, E, M>(deps: TurnDeliveryDependencies<A, E, M>) {
  const entries = new Map<string, Entry<A, M>>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyArray<PendingTurnDelivery<M>> = [];

  const publish = () => {
    snapshot = [...entries.values()].flatMap((entry) =>
      entry.display === null
        ? []
        : [
            {
              key: entry.key,
              environmentId: entry.environmentId,
              threadId: entry.input.threadId,
              messageId: entry.input.message.messageId,
              state: entry.state === "sending" ? ("retrying" as const) : entry.state,
              display: entry.display,
            },
          ],
    );
    for (const listener of listeners) listener();
  };

  const remove = (entry: Entry<A, M>) => {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    for (const stop of entry.stopObserving) stop();
    entry.stopObserving = [];
    if (entry.display === null) return;
    publish();
    deps.releaseDisplay(entry.display);
  };

  /** The first callback runs before `stop` exists and may already have removed the entry. */
  const keepObserving = (entry: Entry<A, M>, stop: () => void) => {
    if (entries.get(entry.key) === entry) entry.stopObserving.push(stop);
    else stop();
  };

  const observeThread = (entry: Entry<A, M>) => {
    keepObserving(
      entry,
      deps.observeThread(entry.environmentId, entry.input.threadId, (state) => {
        entry.thread = state;
        if (state.status !== "live") entry.resynced = true;
        evaluate(entry);
      }),
    );
  };

  const finish = (entry: Entry<A, M>, end: TurnDeliveryEnd<A>) => {
    if (entries.get(entry.key) !== entry) return;
    entry.settle(end);
    if (end.type !== "delivered" || entry.display === null) {
      remove(entry);
      return;
    }
    entry.state = "delivered";
    publish();
    if (entry.unborn) {
      // Acknowledged or held by the shell, so the thread exists now.
      entry.unborn = false;
      observeThread(entry);
      return;
    }
    evaluate(entry);
  };

  const evaluate = (entry: Entry<A, M>) => {
    const messageId = entry.input.message.messageId;
    if (entry.state === "delivered") {
      if (
        entry.thread !== null &&
        (entry.thread.status === "deleted" || threadHoldsUserMessage(entry.thread, messageId))
      ) {
        remove(entry);
      }
      return;
    }
    if (entry.state !== "waiting") return;
    if (entry.unborn) {
      if (!entry.resynced || entry.shell?.status !== "live") return;
      if (shellHoldsThread(entry.shell, entry.input.threadId)) {
        // The launch committed; its pending uploads may have expired, so reconcile, never replay.
        finish(entry, { type: "delivered", value: null });
        return;
      }
    } else {
      if (entry.thread?.status === "deleted") {
        finish(entry, {
          type: "rejected",
          failure: AsyncResult.failure(Cause.fail(new Error("The thread was deleted."))),
        });
        return;
      }
      if (!entry.resynced || entry.thread?.status !== "live") return;
      if (threadHoldsUserMessage(entry.thread, messageId)) {
        finish(entry, { type: "delivered", value: null });
        return;
      }
    }
    void dispatch(entry).then((end) => {
      if (end !== null) finish(entry, end);
    });
  };

  const dispatch = async (entry: Entry<A, M>): Promise<TurnDeliveryEnd<A> | null> => {
    entry.state = "sending";
    entry.resynced = false;
    if (entry.display !== null) publish();
    const result = await deps.send(entry.environmentId, entry.input);
    if (result._tag === "Success") return { type: "delivered", value: result.value };
    const retryable =
      isAtomCommandInterrupted(result) ||
      isRetryableDeliveryFailure(squashAtomCommandFailure(result));
    if (entry.cancelRequested) return { type: "cancelled" };
    if (!retryable) return { type: "rejected", failure: result };
    entry.state = "waiting";
    entry.display ??= entry.createDisplay();
    publish();
    evaluate(entry);
    return null;
  };

  const deliver = async (
    environmentId: EnvironmentId,
    input: TurnDeliveryInput,
    createDisplay: () => M,
  ): Promise<TurnDeliveryOutcome<A>> => {
    const key = turnDeliveryKey(environmentId, input.threadId, input.message.messageId);
    let settle!: (end: TurnDeliveryEnd<A>) => void;
    const settled = new Promise<TurnDeliveryEnd<A>>((resolve) => {
      settle = resolve;
    });
    const entry: Entry<A, M> = {
      key,
      environmentId,
      input,
      createDisplay,
      display: null,
      unborn: input.bootstrap?.createThread !== undefined,
      state: "sending",
      cancelRequested: false,
      resynced: false,
      thread: null,
      shell: null,
      settle,
      stopObserving: [],
    };
    const previous = entries.get(key);
    if (previous !== undefined) {
      previous.settle({ type: "cancelled" });
      remove(previous);
    }
    entries.set(key, entry);
    if (entry.unborn) {
      keepObserving(
        entry,
        deps.observeShell(environmentId, (state) => {
          entry.shell = state;
          if (entry.unborn && state.status !== "live") entry.resynced = true;
          evaluate(entry);
        }),
      );
    } else {
      observeThread(entry);
    }
    const end = await dispatch(entry);
    if (end === null) return { type: "waiting", settled };
    finish(entry, end);
    return end;
  };

  /** Stops local delivery only; a command the server already committed stays committed. */
  const cancel = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined || entry.state === "delivered") return;
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
