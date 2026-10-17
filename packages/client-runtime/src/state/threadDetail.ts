import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  deriveThreadQueueWorkflowState,
  getUserQueuedThreadRuns,
  type ThreadQueueWorkflowState,
} from "./threadWorkflows.ts";
import { deriveThreadTurnSubagents, type ThreadTurnSubagents } from "./threadSubagents.ts";
import {
  deriveThreadCheckpointSummaries,
  type ThreadCheckpointSummary,
} from "./threadCheckpoints.ts";
import type { EnvironmentThread } from "./models.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";
import {
  createQuestionHistoryProjector,
  derivePendingThreadRequests,
  type PendingThreadRequests,
} from "./threadRequests.ts";
import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";

const EMPTY_VISIBLE_TURN_ITEMS: OrchestrationV2ThreadProjection["visibleTurnItems"] = Object.freeze(
  [],
);
const EMPTY_CHECKPOINT_SUMMARIES: ReadonlyArray<ThreadCheckpointSummary> = Object.freeze([]);

type StreamedText = {
  readonly text: string;
  readonly updatedAt: unknown;
  readonly streaming: boolean;
};

function sameApartFromText(previous: StreamedText, next: StreamedText): boolean {
  // An empty item can render differently from one with text, so only growth
  // of text that is already there counts as streaming.
  if (!previous.streaming || !next.streaming || previous.text === "" || next.text === "") {
    return false;
  }
  const { text: _previousText, updatedAt: _previousUpdatedAt, ...previousRest } = previous;
  const { text: _nextText, updatedAt: _nextUpdatedAt, ...nextRest } = next;
  // Wire decoding recreates nested values on every update, so compare the
  // changed entry structurally. Only the changed entries reach this.
  return Equal.equals(previousRest, nextRest);
}

function isStreamedTextItem(
  item: OrchestrationV2TurnItem,
): item is Extract<OrchestrationV2TurnItem, { type: "assistant_message" | "reasoning" }> {
  return item.type === "assistant_message" || item.type === "reasoning";
}

function sameTurnItemApartFromText(
  previous: OrchestrationV2TurnItem,
  next: OrchestrationV2TurnItem,
): boolean {
  return (
    previous.type === next.type &&
    isStreamedTextItem(previous) &&
    isStreamedTextItem(next) &&
    sameApartFromText(previous, next)
  );
}

function sameRowApartFromText(
  previous: OrchestrationV2ProjectedTurnItem,
  next: OrchestrationV2ProjectedTurnItem,
): boolean {
  return (
    previous.position === next.position &&
    previous.visibility === next.visibility &&
    previous.sourceThreadId === next.sourceThreadId &&
    previous.sourceItemId === next.sourceItemId &&
    sameTurnItemApartFromText(previous.item, next.item)
  );
}

function sameMessageApartFromText(
  previous: OrchestrationV2ConversationMessage,
  next: OrchestrationV2ConversationMessage,
): boolean {
  return previous.role === "assistant" && sameApartFromText(previous, next);
}

function sameEntriesApartFrom<A>(
  previous: ReadonlyArray<A>,
  next: ReadonlyArray<A>,
  sameApartFromStreamedText: (previous: A, next: A) => boolean,
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]!;
    const after = next[index]!;
    if (before !== after && !sameApartFromStreamedText(before, after)) return false;
  }
  return true;
}

const STREAMED_PROJECTION_KEYS = new Set<string>([
  "updatedAt",
  "turnItems",
  "visibleTurnItems",
  "messages",
]);

/**
 * True when `next` only grew the text of assistant or reasoning entries that
 * were already streaming, plus the projection's `updatedAt`. Every other field
 * is compared by reference: the reducer keeps the identity of untouched ones.
 */
export function projectionDiffersOnlyInStreamedText(
  previous: OrchestrationV2ThreadProjection,
  next: OrchestrationV2ThreadProjection,
): boolean {
  for (const key of Object.keys(next) as Array<keyof OrchestrationV2ThreadProjection>) {
    if (!STREAMED_PROJECTION_KEYS.has(key) && previous[key] !== next[key]) return false;
  }
  return (
    sameEntriesApartFrom(previous.turnItems, next.turnItems, sameTurnItemApartFromText) &&
    sameEntriesApartFrom(previous.visibleTurnItems, next.visibleTurnItems, sameRowApartFromText) &&
    sameEntriesApartFrom(previous.messages, next.messages, sameMessageApartFromText)
  );
}

export function createEnvironmentThreadDetailAtoms<E>(
  threadStateAtom: (
    environmentId: ScopedThreadRef["environmentId"],
    threadId: ScopedThreadRef["threadId"],
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
) {
  const threadStateValueAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(threadStateAtom(ref.environmentId, ref.threadId))),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state-value:${key}`));
  });

  const threadAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousProjection: OrchestrationV2ThreadProjection | null = null;
    let previousValue: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === previousProjection) return previousValue;
      previousProjection = projection;
      previousValue = projection === null ? null : { environmentId: ref.environmentId, projection };
      return previousValue;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread:${key}`));
  });

  // While a reply streams, every chunk replaces the projection. Readers that
  // show run state, not the streamed text, keep the previous projection until
  // something other than that text changes. A finished item (streaming: false)
  // always counts, so this never holds text past the end of a stream.
  const quietThreadAtomFamily = Atom.family((key: string) => {
    let previous: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const next = get(threadAtomFamily(key));
      if (
        previous !== null &&
        next !== null &&
        projectionDiffersOnlyInStreamedText(previous.projection, next.projection)
      ) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-quiet-thread:${key}`));
  });

  const visibleTurnItemsAtomFamily = Atom.family((key: string) => {
    const projectQuestionHistory = createQuestionHistoryProjector();
    return Atom.make((get): OrchestrationV2ThreadProjection["visibleTurnItems"] => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      return projection === null ? EMPTY_VISIBLE_TURN_ITEMS : projectQuestionHistory(projection);
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-visible-turn-items:${key}`));
  });

  // The same array as visibleTurnItemsAtom, held while only streamed text moves.
  const quietVisibleTurnItemsAtomFamily = Atom.family((key: string) => {
    let previousThread: EnvironmentThread | null | undefined;
    let previousItems = EMPTY_VISIBLE_TURN_ITEMS;
    return Atom.make((get): OrchestrationV2ThreadProjection["visibleTurnItems"] => {
      const thread = get(quietThreadAtomFamily(key));
      const items = get(visibleTurnItemsAtomFamily(key));
      if (thread !== previousThread) {
        previousThread = thread;
        previousItems = items;
      }
      return previousItems;
    }).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-quiet-thread-visible-turn-items:${key}`),
    );
  });

  const queueWorkflowAtomFamily = Atom.family((key: string) => {
    let previous: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "providerThreads" | "providerSessions" | "providerTurns"
    > | null = null;
    let value: ThreadQueueWorkflowState | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
      } else if (
        previous === null ||
        projection.thread !== previous.thread ||
        projection.runs !== previous.runs ||
        projection.messages !== previous.messages ||
        projection.providerThreads !== previous.providerThreads ||
        projection.providerSessions !== previous.providerSessions ||
        projection.providerTurns !== previous.providerTurns
      ) {
        value = deriveThreadQueueWorkflowState(projection);
        const { thread, runs, messages, providerThreads, providerSessions, providerTurns } =
          projection;
        previous = { thread, runs, messages, providerThreads, providerSessions, providerTurns };
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-queue:${key}`));
  });
  const queuedCountAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> | null = null;
    let count = 0;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        count = 0;
      } else if (projection.runs !== previous?.runs || projection.messages !== previous?.messages) {
        const { runs, messages } = projection;
        previous = { runs, messages };
        count = getUserQueuedThreadRuns(previous).length;
      }
      return count;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-queue-count:${key}`));
  });

  const turnSubagentsAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents"> | null = null;
    let value: ThreadTurnSubagents | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
      } else if (
        projection.runs !== previous?.runs ||
        projection.subagents !== previous?.subagents
      ) {
        const { runs, subagents } = projection;
        previous = { runs, subagents };
        value = deriveThreadTurnSubagents(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-turn-subagents:${key}`));
  });

  const checkpointSummariesAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages"> | null = null;
    let value = EMPTY_CHECKPOINT_SUMMARIES;
    return Atom.make((get) => {
      // Assistant message ids, not their text, feed the summaries.
      const projection = get(quietThreadAtomFamily(key))?.projection ?? null;
      if (projection === null) {
        previous = null;
        value = EMPTY_CHECKPOINT_SUMMARIES;
      } else if (
        projection.checkpoints !== previous?.checkpoints ||
        projection.messages !== previous?.messages
      ) {
        const { checkpoints, messages } = projection;
        previous = { checkpoints, messages };
        value = deriveThreadCheckpointSummaries(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-checkpoint-summaries:${key}`));
  });

  const worktreePathAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get) =>
        Option.getOrNull(get(threadStateValueAtomFamily(key)).data)?.thread.worktreePath ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-worktree:${key}`)),
  );
  const pendingRequestsAtomFamily = Atom.family((key: string) => {
    let previous: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems"> | null =
      null;
    let value: PendingThreadRequests | null = null;
    return Atom.make((get) => {
      const projection = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (projection === null) {
        previous = null;
        value = null;
        return value;
      }
      const runtimeRequests = projection.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      const ids = new Set(runtimeRequests.map((request) => request.id));
      const turnItems =
        ids.size === 0
          ? []
          : projection.turnItems.filter(
              (item) =>
                (item.type === "approval_request" || item.type === "user_input_request") &&
                ids.has(item.requestId),
            );
      if (
        previous === null ||
        !arrayElementsEqual(previous.runtimeRequests, runtimeRequests) ||
        !arrayElementsEqual(previous.turnItems, turnItems)
      ) {
        previous = { runtimeRequests, turnItems };
        value = derivePendingThreadRequests(previous);
      }
      return value;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-pending-requests:${key}`));
  });

  const statusAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).status).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-status:${key}`),
    ),
  );
  const errorAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).error)).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-error:${key}`),
    ),
  );
  const historyAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).history).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-history:${key}`),
    ),
  );

  return {
    worktreePathAtom: (ref: ScopedThreadRef) => worktreePathAtomFamily(threadKey(ref)),
    pendingRequestsAtom: (ref: ScopedThreadRef) => pendingRequestsAtomFamily(threadKey(ref)),
    queueWorkflowAtom: (ref: ScopedThreadRef) => queueWorkflowAtomFamily(threadKey(ref)),
    queuedCountAtom: (ref: ScopedThreadRef) => queuedCountAtomFamily(threadKey(ref)),
    turnSubagentsAtom: (ref: ScopedThreadRef) => turnSubagentsAtomFamily(threadKey(ref)),
    checkpointSummariesAtom: (ref: ScopedThreadRef) =>
      checkpointSummariesAtomFamily(threadKey(ref)),
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    threadAtom: (ref: ScopedThreadRef) => threadAtomFamily(threadKey(ref)),
    visibleTurnItemsAtom: (ref: ScopedThreadRef) => visibleTurnItemsAtomFamily(threadKey(ref)),
    quietThreadAtom: (ref: ScopedThreadRef) => quietThreadAtomFamily(threadKey(ref)),
    quietVisibleTurnItemsAtom: (ref: ScopedThreadRef) =>
      quietVisibleTurnItemsAtomFamily(threadKey(ref)),
    statusAtom: (ref: ScopedThreadRef) => statusAtomFamily(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => errorAtomFamily(threadKey(ref)),
    historyAtom: (ref: ScopedThreadRef) => historyAtomFamily(threadKey(ref)),
  };
}
