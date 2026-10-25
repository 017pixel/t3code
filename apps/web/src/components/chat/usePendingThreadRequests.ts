import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
  type ThreadId,
  type UserInputAttachments,
} from "@t3tools/contracts";
import {
  derivePendingThreadRequests,
  onThreadRequestsResolved,
  pruneResolvedUserInputDrafts,
  seedUserInputDraftAnswers,
  userInputDraftKey,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";
import { useRef, type RefObject, type SetStateAction } from "react";
import { useShallow } from "zustand/react/shallow";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { getUploadedAttachments, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  projectPendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  threadContextsReferencedByAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import {
  countQuestionAttachments,
  pruneResolvedQuestionAttachmentDrafts,
  questionAttachmentDraftId,
  questionAttachmentDraftThreadRef,
  resolveOpenQuestionAttachmentDraft,
  type OpenQuestionAttachmentDraft,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingUserInput,
} from "../../session-logic";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ChatComposerHandle } from "./ChatComposer";
import { isRequestHeldByTypingGuard } from "./useComposerTypingGuard";

const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const usePendingUserInputAnswers = create<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>(() => ({}));
const usePendingUserInputQuestionIndex = create<Record<string, number>>(() => ({}));
const NO_PENDING_REQUESTS = { approvals: [], userInputs: [] } as const;
const NO_PENDING_APPROVALS: ReturnType<typeof derivePendingApprovals> = [];
const NO_PENDING_USER_INPUTS: ReturnType<typeof derivePendingUserInputs> = [];
const NO_RESPONDING_REQUEST_IDS: RuntimeRequestId[] = [];
// Keyed by thread so a send that resumes after an await reads the approvals
// being answered at that moment.
const useRespondingApprovalIds = create<Record<string, RuntimeRequestId[]>>(() => ({}));

function threadRequestsKey(environmentId: EnvironmentId, threadId: ThreadId | null): string {
  return JSON.stringify([environmentId, threadId]);
}

// Keyed like useRespondingApprovalIds so captures and sends that resume after an await see a
// question whose answer is already on its way.
const useRespondingUserInputIds = create<Record<string, RuntimeRequestId[]>>(() => ({}));

function setResponding(
  store: typeof useRespondingApprovalIds,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  responding: boolean,
) {
  const key = threadRequestsKey(environmentId, threadId);
  store.setState((existing) => {
    const current = existing[key] ?? NO_RESPONDING_REQUEST_IDS;
    if (current.includes(requestId) === responding) return existing;
    const next = responding ? [...current, requestId] : current.filter((id) => id !== requestId);
    if (next.length > 0) return { ...existing, [key]: next };
    const { [key]: _dropped, ...rest } = existing;
    return rest;
  }, true);
}

/**
 * The question draft a capture for `threadRef` belongs to right now: the question the composer
 * shows, while it still takes attachments. Read at capture time, so a question that closed or
 * moved on never claims a late capture.
 */
export function openQuestionAttachmentDraft(
  threadRef: ScopedThreadRef,
): OpenQuestionAttachmentDraft | null {
  const { environmentId, threadId } = threadRef;
  const pending = appAtomRegistry.get(environmentThreadDetails.pendingRequestsAtom(threadRef));
  const request =
    pending && pending.userInputs.length > 0
      ? (derivePendingUserInputs(pending.userInputs)[0] ?? null)
      : null;
  return resolveOpenQuestionAttachmentDraft({
    threadRef,
    request,
    questionIndex: request
      ? (usePendingUserInputQuestionIndex.getState()[
          userInputDraftKey(environmentId, threadId, request.requestId)
        ] ?? 0)
      : 0,
    held: request !== null && isRequestHeldByTypingGuard(request.requestId),
    responding:
      request !== null &&
      (
        useRespondingUserInputIds.getState()[threadRequestsKey(environmentId, threadId)] ??
        NO_RESPONDING_REQUEST_IDS
      ).includes(request.requestId),
    questionAttachmentsEnabled:
      appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .questionAttachments === true,
  });
}

/**
 * The custom answer the composer editor shows for a pending question, read from the answer store
 * at call time so a handler running before the next render sees the latest keystroke.
 */
export function getPendingCustomAnswer(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  request: PendingUserInput,
  questionId: string,
): string {
  const question = request.questions.find((entry) => entry.id === questionId);
  if (!question || question.allowCustomAnswer === false) return "";
  const stored =
    usePendingUserInputAnswers.getState()[
      userInputDraftKey(environmentId, threadId, request.requestId)
    ] ?? EMPTY_PENDING_USER_INPUT_ANSWERS;
  return seedUserInputDraftAnswers(request.questions, stored)[questionId]?.customAnswer ?? "";
}

/** Attachments across the whole request of `draftId`, or null when it is not the open question. */
export function countQuestionRequestAttachments(draftId: DraftId): number | null {
  const threadRef = questionAttachmentDraftThreadRef(draftId);
  const open = threadRef ? openQuestionAttachmentDraft(threadRef) : null;
  return open?.draftId === draftId ? countQuestionAttachments(open.requestKeys) : null;
}

/** Approvals the thread is waiting on now, for continuations that resume after an await. */
export function getPendingApprovals(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReturnType<typeof derivePendingApprovals> {
  const current = appAtomRegistry.get(
    environmentThreadDetails.pendingRequestsAtom({ environmentId, threadId }),
  );
  return current === null || current.approvals.length === 0
    ? NO_PENDING_APPROVALS
    : derivePendingApprovals(current.approvals);
}

/** Approvals whose response is in flight now, for continuations that resume after an await. */
export function getRespondingApprovalIds(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<RuntimeRequestId> {
  return (
    useRespondingApprovalIds.getState()[threadRequestsKey(environmentId, threadId)] ??
    NO_RESPONDING_REQUEST_IDS
  );
}

/** Drops a thread's answer, question-position and attachment drafts for every request outside `pendingRequestIds`. */
function pruneResolvedRequestDrafts(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  pendingRequestIds: ReadonlyArray<RuntimeRequestId>,
) {
  usePendingUserInputAnswers.setState(
    (existing) =>
      pruneResolvedUserInputDrafts(existing, environmentId, threadId, pendingRequestIds),
    true,
  );
  usePendingUserInputQuestionIndex.setState(
    (existing) =>
      pruneResolvedUserInputDrafts(existing, environmentId, threadId, pendingRequestIds),
    true,
  );
  pruneResolvedQuestionAttachmentDrafts(environmentId, threadId, pendingRequestIds);
}

// Resolution can come from anywhere: another device, an interrupt, the turn
// ending, or a reload over drafts for requests that resolved meanwhile.
onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds }) =>
  pruneResolvedRequestDrafts(environmentId, threadId, pendingRequestIds),
);

/**
 * Drops `answeredRequestId`'s drafts as soon as the server accepts the
 * response, before the projection push that resolves it lands.
 */
function collectAnsweredRequestDrafts(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  answeredRequestId: RuntimeRequestId,
) {
  const current = appAtomRegistry.get(
    environmentThreadDetails.pendingRequestsAtom({ environmentId, threadId }),
  );
  // Missing detail is not resolution.
  if (current === null) return;
  pruneResolvedRequestDrafts(
    environmentId,
    threadId,
    [...current.approvals, ...current.userInputs]
      .map((request) => request.requestId)
      .filter((requestId) => requestId !== answeredRequestId),
  );
}

function makePendingCustomAnswerSetter(input: {
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingRequestKey: string;
  readonly setPendingUserInputAnswersByRequestId: (
    update: SetStateAction<Record<string, Record<string, PendingUserInputDraftAnswer>>>,
  ) => void;
}) {
  return (questionId: string, value: string) => {
    const { activePendingUserInput, activePendingRequestKey } = input;
    if (!activePendingUserInput) {
      return;
    }
    const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
    if (!question || question.allowCustomAnswer === false) {
      return;
    }
    input.setPendingUserInputAnswersByRequestId((existing) => ({
      ...existing,
      [activePendingRequestKey]: {
        ...existing[activePendingRequestKey],
        [questionId]: setPendingUserInputCustomAnswer(
          existing[activePendingRequestKey]?.[questionId],
          value,
          question,
        ),
      },
    }));
    // Resetting selection before rendering can re-enter Lexical with stale skill-token offsets.
  };
}

export function usePendingThreadRequests(input: {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
  readonly serverProjection: ThreadStructure | null;
  readonly supportsQuestionAttachments: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly setComposerDraftPrompt: (target: ScopedThreadRef | DraftId, prompt: string) => void;
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  readonly setThreadError: (threadId: ThreadId, error: string | null) => void;
}) {
  const {
    environmentId,
    activeThreadId,
    serverProjection,
    supportsQuestionAttachments,
    composerDraftTarget,
    setComposerDraftPrompt,
    composerRef,
    setThreadError,
  } = input;
  const respondToThreadApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissThreadUserInput = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const userInputResponsesInFlight = useRef(new Set<string>());
  const respondingRequestIds = useRespondingApprovalIds(
    (state) => state[threadRequestsKey(environmentId, activeThreadId)] ?? NO_RESPONDING_REQUEST_IDS,
  );
  const respondingUserInputRequestIds = useRespondingUserInputIds(
    (state) => state[threadRequestsKey(environmentId, activeThreadId)] ?? NO_RESPONDING_REQUEST_IDS,
  );
  const setPendingUserInputAnswersByRequestId = usePendingUserInputAnswers.setState;
  const setPendingUserInputQuestionIndexByRequestId = usePendingUserInputQuestionIndex.setState;
  const pendingRequests =
    serverProjection !== null && serverProjection.thread.id === activeThreadId
      ? derivePendingThreadRequests(serverProjection)
      : NO_PENDING_REQUESTS;
  // The projection changes on every streamed event, so shared empties keep the
  // composer and approval panel from re-rendering while nothing is pending.
  const pendingApprovals =
    pendingRequests.approvals.length === 0
      ? NO_PENDING_APPROVALS
      : derivePendingApprovals(pendingRequests.approvals);
  const pendingUserInputs =
    pendingRequests.userInputs.length === 0
      ? NO_PENDING_USER_INPUTS
      : derivePendingUserInputs(pendingRequests.userInputs);
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingRequestKey = userInputDraftKey(
    environmentId,
    activeThreadId,
    activePendingUserInput?.requestId,
  );
  const storedPendingAnswerDrafts = usePendingUserInputAnswers(
    (state) => state[activePendingRequestKey] ?? EMPTY_PENDING_USER_INPUT_ANSWERS,
  );
  // Suggested answers are shown until the user edits them; only edits are stored.
  const activePendingAnswerDrafts: Record<string, PendingUserInputDraftAnswer> =
    activePendingUserInput
      ? seedUserInputDraftAnswers(activePendingUserInput.questions, storedPendingAnswerDrafts)
      : storedPendingAnswerDrafts;
  const activePendingQuestionIndex = usePendingUserInputQuestionIndex(
    (state) => state[activePendingRequestKey] ?? 0,
  );
  const pendingQuestionDraftKeys = activeThreadId
    ? pendingUserInputs.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftId(environmentId, activeThreadId, request.requestId, question.id),
        ),
      )
    : [];
  const questionComposerDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => [key, state.draftsByThreadKey[key]]),
      ),
    ),
  );
  const questionUploadsBlocked = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => {
          const draft = questionComposerDrafts[key];
          const attachments = draft ? [...draft.images, ...draft.files] : [];
          return [
            key,
            attachments.some((attachment) => {
              const upload = state.uploadsByImageId[attachment.id];
              return upload?.status !== "ready" || upload.environmentId !== environmentId;
            }),
          ];
        }),
      ),
    ),
  );
  const questionPreparations = useQuestionAttachmentPreparation(
    useShallow((state) =>
      Object.fromEntries(pendingQuestionDraftKeys.map((key) => [key, state.counts[key] ?? 0])),
    ),
  );
  const activePendingDraftAnswers =
    !activePendingUserInput || !activeThreadId
      ? EMPTY_PENDING_USER_INPUT_ANSWERS
      : Object.fromEntries(
          activePendingUserInput.questions.map((question) => {
            const key = questionAttachmentDraftId(
              environmentId,
              activeThreadId,
              activePendingUserInput.requestId,
              question.id,
            );
            const draft = questionComposerDrafts[key];
            const attachments = draft ? [...draft.images, ...draft.files] : [];
            return [
              question.id,
              {
                ...activePendingAnswerDrafts[question.id],
                attachmentCount: attachments.length,
                attachmentsBlocked:
                  (attachments.length > 0 && !supportsQuestionAttachments) ||
                  (questionPreparations[key] ?? 0) > 0 ||
                  questionUploadsBlocked[key] === true,
              },
            ];
          }),
        );
  const activePendingProgress = activePendingUserInput
    ? derivePendingUserInputProgress(
        activePendingUserInput.questions,
        activePendingDraftAnswers,
        activePendingQuestionIndex,
      )
    : null;
  const activePendingResolvedAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
    : null;
  const activePendingIsResponding = activePendingUserInput
    ? activePendingUserInput.responseCapability === "not_resumable" ||
      respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activePendingApproval = pendingApprovals[0] ?? null;

  const onRespondToApproval = async (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    feedback?: string,
  ) => {
    if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    if (
      pendingApprovals.find((approval) => approval.requestId === requestId)?.responseCapability !==
      "live"
    )
      return;

    setResponding(useRespondingApprovalIds, environmentId, activeThreadId, requestId, true);
    const result = await respondToThreadApproval({
      environmentId,
      input: {
        threadId: activeThreadId,
        requestId,
        decision,
        ...(feedback === undefined ? {} : { feedback }),
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to submit approval decision.",
      );
    }
    setResponding(useRespondingApprovalIds, environmentId, activeThreadId, requestId, false);
    return result;
  };
  const onRespondToApprovalStable = useStableCallback(onRespondToApproval);

  const onRespondToUserInput = async (
    requestId: RuntimeRequestId,
    answers: Record<string, unknown>,
  ) => {
    if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    const pendingInput = pendingUserInputs.find((input) => input.requestId === requestId);
    if (!pendingInput || pendingInput.responseCapability === "not_resumable") return;
    const responseKey = JSON.stringify([environmentId, activeThreadId, requestId]);
    if (userInputResponsesInFlight.current.has(responseKey)) return;
    const attachmentsByQuestionId = new Map<string, UserInputAttachments[string]>();
    const providerAnswers = { ...answers };
    for (const question of pendingInput.questions) {
      const target = questionAttachmentDraftId(
        environmentId,
        activeThreadId,
        requestId,
        question.id,
      );
      if ((useQuestionAttachmentPreparation.getState().counts[target] ?? 0) > 0) return;
      const draft = useComposerDraftStore.getState().getComposerDraft(target);
      providerAnswers[question.id] = projectPendingUserInputAnswer(
        answers[question.id],
        draft?.threadContexts ?? [],
      );
      const attachments = draft ? [...draft.images, ...draft.files] : [];
      if (attachments.length === 0) continue;
      const uploaded = getUploadedAttachments({ environmentId, images: attachments });
      if (!uploaded) {
        setThreadError(
          activeThreadId,
          "Wait for attachments to finish uploading, or remove failed uploads.",
        );
        return;
      }
      attachmentsByQuestionId.set(question.id, uploaded as UserInputAttachments[string]);
    }
    userInputResponsesInFlight.current.add(responseKey);

    setResponding(useRespondingUserInputIds, environmentId, activeThreadId, requestId, true);
    const result = await respondToThreadUserInput({
      environmentId,
      input: {
        threadId: activeThreadId,
        requestId,
        answers: providerAnswers,
        ...(attachmentsByQuestionId.size > 0
          ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
          : {}),
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to submit user input.",
      );
    }
    if (result._tag === "Success")
      collectAnsweredRequestDrafts(environmentId, activeThreadId, requestId);
    userInputResponsesInFlight.current.delete(responseKey);
    setResponding(useRespondingUserInputIds, environmentId, activeThreadId, requestId, false);
    return result;
  };

  const onDismissUserInput = async (requestId: RuntimeRequestId) => {
    if (!activeThreadId) return;

    setResponding(useRespondingUserInputIds, environmentId, activeThreadId, requestId, true);
    const result = await dismissThreadUserInput({
      environmentId,
      input: { threadId: activeThreadId, requestId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to dismiss the question.",
      );
    }
    if (result._tag === "Success")
      collectAnsweredRequestDrafts(environmentId, activeThreadId, requestId);
    setResponding(useRespondingUserInputIds, environmentId, activeThreadId, requestId, false);
    return result;
  };
  const onDismissUserInputStable = useStableCallback(onDismissUserInput);

  const setActivePendingUserInputQuestionIndex = (nextQuestionIndex: number) => {
    if (!activePendingUserInput) {
      return;
    }
    setPendingUserInputQuestionIndexByRequestId((existing) => ({
      ...existing,
      [activePendingRequestKey]: nextQuestionIndex,
    }));
  };

  const onSelectActivePendingUserInputOption = (questionId: string, optionValue: string) => {
    if (!activePendingUserInput) {
      return;
    }
    // The option replaces the custom answer. Anything typed there is the
    // user's text, so it goes back to the thread draft instead of vanishing.
    const displacedAnswer = activePendingAnswerDrafts[questionId]?.customAnswer;
    const currentPrompt =
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
    const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(currentPrompt, displacedAnswer);
    if (nextPrompt !== currentPrompt) {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      if (activeThreadId) {
        const store = useComposerDraftStore.getState();
        const questionTarget = questionAttachmentDraftId(
          environmentId,
          activeThreadId,
          activePendingUserInput.requestId,
          questionId,
        );
        store.addThreadContexts(
          composerDraftTarget,
          threadContextsReferencedByAnswer(
            displacedAnswer ?? "",
            store.getComposerDraft(questionTarget)?.threadContexts ?? [],
          ),
          { appendReference: false },
        );
      }
    }
    setPendingUserInputAnswersByRequestId((existing) => {
      const question =
        (activePendingProgress?.activeQuestion?.id === questionId
          ? activePendingProgress.activeQuestion
          : undefined) ?? activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) {
        return existing;
      }

      return {
        ...existing,
        [activePendingRequestKey]: {
          ...existing[activePendingRequestKey],
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            existing[activePendingRequestKey]?.[questionId],
            optionValue,
          ),
        },
      };
    });
    composerRef.current?.resetCursorState({ cursor: 0 });
  };
  const onSelectActivePendingUserInputOptionStable = useStableCallback(
    onSelectActivePendingUserInputOption,
  );

  const onChangeActivePendingUserInputCustomAnswer = makePendingCustomAnswerSetter({
    activePendingUserInput,
    activePendingRequestKey,
    setPendingUserInputAnswersByRequestId,
  });

  const onAdvanceActivePendingUserInput = () => {
    if (
      !activePendingUserInput ||
      activePendingUserInput.responseCapability === "not_resumable" ||
      !activePendingProgress
    ) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  };
  const onAdvanceActivePendingUserInputStable = useStableCallback(onAdvanceActivePendingUserInput);

  const onPreviousActivePendingUserInputQuestion = () => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  };
  const onPreviousActivePendingUserInputQuestionStable = useStableCallback(
    onPreviousActivePendingUserInputQuestion,
  );

  return {
    pendingApprovals,
    pendingUserInputs,
    activePendingApproval,
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    respondingRequestIds,
    onRespondToApproval: onRespondToApprovalStable,
    onDismissUserInput: onDismissUserInputStable,
    onSelectActivePendingUserInputOption: onSelectActivePendingUserInputOptionStable,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onAdvanceActivePendingUserInputStable,
    onPreviousActivePendingUserInputQuestion: onPreviousActivePendingUserInputQuestionStable,
  };
}
