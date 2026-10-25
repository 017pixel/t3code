import {
  onThreadRequestsResolved,
  resolvedQuestionDraftKeys,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { releaseDraftAttachments } from "./lib/attachmentUploadQueue";
import { derivePendingUserInputProgress } from "./pendingUserInput";

export function questionAttachmentDraftPrefix(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string {
  return `${encodeURIComponent(JSON.stringify(environmentId))}:question-${encodeURIComponent(JSON.stringify(threadId))}-`;
}

/** Question drafts have no draft session, so their key is the only record of the environment. */
export function questionAttachmentDraftEnvironmentId(key: string): EnvironmentId | null {
  const match = /^([^:]+):question-/.exec(key);
  if (!match) return null;
  try {
    const environmentId: unknown = JSON.parse(decodeURIComponent(match[1]!));
    return typeof environmentId === "string" ? EnvironmentId.make(environmentId) : null;
  } catch {
    return null;
  }
}

export function questionAttachmentDraftId(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: string,
  questionId: string,
): DraftId {
  return DraftId.make(
    `${questionAttachmentDraftPrefix(environmentId, threadId)}${encodeURIComponent(JSON.stringify([requestId, questionId]))}`,
  );
}

/** The thread a question draft key belongs to. */
export function questionAttachmentDraftThreadRef(key: string): ScopedThreadRef | null {
  const environmentId = questionAttachmentDraftEnvironmentId(key);
  if (!environmentId) return null;
  const rest = key.slice(key.indexOf(":question-") + ":question-".length);
  // Encoding keeps "-", so take the first split whose head decodes to a JSON string.
  for (let index = rest.indexOf("-"); index !== -1; index = rest.indexOf("-", index + 1)) {
    try {
      const threadId: unknown = JSON.parse(decodeURIComponent(rest.slice(0, index)));
      if (typeof threadId === "string") return { environmentId, threadId: ThreadId.make(threadId) };
    } catch {
      // Not a split point.
    }
  }
  return null;
}

export type OpenQuestionAttachmentDraft = {
  readonly draftId: DraftId;
  readonly requestKeys: ReadonlyArray<DraftId>;
};

/**
 * The question draft that takes attachments for a thread whose oldest pending question is
 * `request`: none while the question is hidden from the composer, being answered, or cannot
 * take attachments.
 */
export function resolveOpenQuestionAttachmentDraft(input: {
  readonly threadRef: ScopedThreadRef;
  readonly request: ThreadPendingUserInput | null;
  readonly questionIndex: number;
  readonly held: boolean;
  readonly responding: boolean;
  readonly questionAttachmentsEnabled: boolean;
}): OpenQuestionAttachmentDraft | null {
  const { threadRef, request } = input;
  if (
    !request ||
    request.responseCapability === "not_resumable" ||
    input.held ||
    input.responding ||
    !input.questionAttachmentsEnabled
  ) {
    return null;
  }
  const { activeQuestion } = derivePendingUserInputProgress(
    request.questions,
    {},
    input.questionIndex,
  );
  if (!activeQuestion || activeQuestion.allowCustomAnswer === false) return null;
  const draftIdFor = (questionId: string) =>
    questionAttachmentDraftId(
      threadRef.environmentId,
      threadRef.threadId,
      request.requestId,
      questionId,
    );
  return {
    draftId: draftIdFor(activeQuestion.id),
    requestKeys: request.questions.map((question) => draftIdFor(question.id)),
  };
}

export const useQuestionAttachmentPreparation = create<{ counts: Record<string, number> }>(() => ({
  counts: {},
}));

export function countQuestionAttachments(keys: ReadonlyArray<DraftId>): number {
  const store = useComposerDraftStore.getState();
  const { counts } = useQuestionAttachmentPreparation.getState();
  return keys.reduce((total, key) => {
    const draft = store.getComposerDraft(key);
    return total + (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + (counts[key] ?? 0);
  }, 0);
}

export function changeQuestionAttachmentPreparation(key: DraftId, delta: number): void {
  useQuestionAttachmentPreparation.setState((state) =>
    delta < 0 && !(key in state.counts)
      ? state
      : {
          counts: { ...state.counts, [key]: Math.max(0, (state.counts[key] ?? 0) + delta) },
        },
  );
}

export function clearQuestionAttachmentDraft(key: DraftId): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(key);
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files]);
    for (const image of draft.images) {
      if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
    }
  }
  store.clearComposerContent(key);
  useQuestionAttachmentPreparation.setState(({ counts }) => {
    const next = { ...counts };
    delete next[key];
    return { counts: next };
  });
}

/** Clears the thread's question attachment drafts for every request outside `pendingRequestIds`. */
export function pruneResolvedQuestionAttachmentDrafts(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  pendingRequestIds: ReadonlyArray<string>,
): void {
  const keys = new Set([
    ...Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
    ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
  ]);
  const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
  for (const key of resolvedQuestionDraftKeys(keys, prefix, pendingRequestIds)) {
    clearQuestionAttachmentDraft(DraftId.make(key));
  }
}

onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds }) =>
  pruneResolvedQuestionAttachmentDrafts(environmentId, threadId, pendingRequestIds),
);
