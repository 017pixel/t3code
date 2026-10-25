import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { revokeUserMessagePreviewUrls } from "../components/ChatView.logic";
import type { ChatMessage } from "../types";

interface UnsentMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Owns its previews, which are revoked once the message is restored or discarded. */
  readonly display: ChatMessage;
  /** Writes the message back into its composer; false while it still does not fit. */
  readonly restore: () => boolean;
}

let records: ReadonlyArray<UnsentMessage> = [];
const listeners = new Set<() => void>();

const isRecord = (record: UnsentMessage, environmentId: EnvironmentId, messageId: MessageId) =>
  record.environmentId === environmentId && record.display.id === messageId;

function drop(environmentId: EnvironmentId, messageId: MessageId) {
  const record = records.find((candidate) => isRecord(candidate, environmentId, messageId));
  if (record === undefined) return;
  records = records.filter((candidate) => candidate !== record);
  for (const listener of listeners) listener();
  revokeUserMessagePreviewUrls(record.display);
}

/**
 * Holds a message whose send ended unsent but which no longer fits in its composer, so it stays in
 * its thread until restored or discarded. Outlives ChatView, like a send waiting on a reconnect.
 */
export const unsentMessages = {
  keep: (record: UnsentMessage) => {
    drop(record.environmentId, record.display.id);
    // It is no longer queued, so it belongs in the timeline rather than the queue.
    const { inputIntent, ...display } = record.display;
    records = [...records, inputIntent === "queued_turn" ? { ...record, display } : record];
    for (const listener of listeners) listener();
  },
  restore: (environmentId: EnvironmentId, messageId: MessageId): boolean => {
    const record = records.find((candidate) => isRecord(candidate, environmentId, messageId));
    if (record === undefined) return true;
    if (!record.restore()) return false;
    drop(environmentId, messageId);
    return true;
  },
  discard: drop,
  getSnapshot: (): ReadonlyArray<UnsentMessage> => records,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

const EMPTY: ReadonlyArray<UnsentMessage> = [];

function useUnsentMessageSnapshot() {
  return useSyncExternalStore(unsentMessages.subscribe, unsentMessages.getSnapshot);
}

export function useUnsentMessages(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ReadonlyArray<UnsentMessage> {
  const kept = useUnsentMessageSnapshot().filter(
    (record) => record.environmentId === environmentId && record.threadId === threadId,
  );
  return kept.length === 0 ? EMPTY : kept;
}

export function useUnsentMessage(
  environmentId: EnvironmentId,
  messageId: MessageId,
): UnsentMessage | null {
  return (
    useUnsentMessageSnapshot().find((record) => isRecord(record, environmentId, messageId)) ?? null
  );
}
