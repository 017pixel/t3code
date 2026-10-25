import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

import type { SupervisorConnectionState } from "../connection/model.ts";
import type { StartThreadTurnInput } from "../operations/commands.ts";
import type { AtomCommandResult } from "./runtime.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

export type TurnDeliveryInput = StartThreadTurnInput & { readonly commandId: CommandId };

export type TurnDeliveryFailure = Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>;

export type TurnDeliveryEnd<A> =
  /** `value` is null when a resynced thread already held the message. */
  | { readonly type: "delivered"; readonly value: A | null }
  | { readonly type: "rejected"; readonly failure: TurnDeliveryFailure }
  | { readonly type: "cancelled" };

export type TurnDeliveryOutcome<A> =
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

export interface TurnDeliveryDependencies<A, E> {
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

export function turnDeliveryKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
): string {
  return JSON.stringify([environmentId, threadId, messageId]);
}

/** Sends a turn once; any failure is final. */
export function createTurnDeliveries<A, E, M>(deps: TurnDeliveryDependencies<A, E>) {
  const snapshot: ReadonlyArray<PendingTurnDelivery<M>> = [];
  const deliver = async (
    environmentId: EnvironmentId,
    input: TurnDeliveryInput,
    _display: M,
  ): Promise<TurnDeliveryOutcome<A>> => {
    const result = await deps.send(environmentId, input);
    return result._tag === "Success"
      ? { type: "delivered", value: result.value }
      : { type: "rejected", failure: result };
  };
  return {
    deliver,
    cancel: (_key: string) => {},
    getSnapshot: (): ReadonlyArray<PendingTurnDelivery<M>> => snapshot,
    subscribe: (_listener: () => void) => () => {},
  };
}

export type TurnDeliveries<A, M> = ReturnType<typeof createTurnDeliveries<A, unknown, M>>;
