import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import {
  createTurnDeliveries,
  type PendingTurnDelivery,
} from "@t3tools/client-runtime/state/turn-delivery";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { revokeUserMessagePreviewUrls } from "../components/ChatView.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { ChatMessage } from "../types";
import { environmentShell } from "./shell";
import { environmentThreadStateAtom, threadEnvironment } from "./threads";
import { runOrchestrationCommand } from "./use-orchestration-command";

/** Outlives ChatView, so a send waiting on a reconnect survives navigating between threads. */
export const turnDeliveries = createTurnDeliveries<unknown, unknown, ChatMessage>({
  send: (environmentId, input) =>
    runOrchestrationCommand(
      threadEnvironment.startTurn,
      { environmentId, input },
      { reportFailure: false },
    ),
  observeThread: (environmentId, threadId, listener) =>
    appAtomRegistry.subscribe(
      environmentThreadStateAtom(environmentId, threadId),
      (result) =>
        listener(Option.getOrElse(AsyncResult.value(result), () => EMPTY_ENVIRONMENT_THREAD_STATE)),
      { immediate: true },
    ),
  observeShell: (environmentId, listener) =>
    appAtomRegistry.subscribe(environmentShell.stateValueAtom(environmentId), listener, {
      immediate: true,
    }),
  releaseDisplay: revokeUserMessagePreviewUrls,
});

const EMPTY: ReadonlyArray<PendingTurnDelivery<ChatMessage>> = [];

function usePendingTurnDeliverySnapshot() {
  return useSyncExternalStore(turnDeliveries.subscribe, turnDeliveries.getSnapshot);
}

export function usePendingTurnDeliveries(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ReadonlyArray<PendingTurnDelivery<ChatMessage>> {
  const pending = usePendingTurnDeliverySnapshot().filter(
    (delivery) => delivery.environmentId === environmentId && delivery.threadId === threadId,
  );
  return pending.length === 0 ? EMPTY : pending;
}

export function usePendingTurnDelivery(
  environmentId: EnvironmentId,
  messageId: MessageId,
): PendingTurnDelivery<ChatMessage> | null {
  const snapshot = usePendingTurnDeliverySnapshot();
  return (
    snapshot.find(
      (delivery) => delivery.environmentId === environmentId && delivery.messageId === messageId,
    ) ?? null
  );
}
