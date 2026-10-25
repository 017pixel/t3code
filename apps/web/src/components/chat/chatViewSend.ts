import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ScopedThreadRef,
  type ThreadId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@t3tools/client-runtime/errors";
import { Atom } from "effect/reactivity";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { TurnDeliveryFailure } from "@t3tools/client-runtime/state/turn-delivery";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { readLocalApi } from "../../localApi";
import { getUploadedAttachments } from "../../lib/attachmentUploadQueue";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { randomUUID } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { newThreadId } from "~/lib/utils";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadState,
  composerDraftHasUserContent,
  restoreFailedDraftThread,
  useComposerDraftStore,
  DraftId,
} from "../../composerDraftStore";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { createModelSelection } from "@t3tools/shared/model";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import {
  formatOutgoingPrompt,
  getAntigravitySendBlockReason,
  resolveComposerInteractionMode,
  cloneComposerImageForRetry,
  type ComposerSendSnapshot,
  readFileAsDataUrl,
  prepareRevertedMessageAttachments,
  waitForRevertedMessage,
} from "../ChatView.logic";
import { readPreparedConnection } from "../../state/session";
import { recallableComposerPrompt } from "./composerPromptHistory";

// Kept per route so a send in flight, and the multiple-model selections, survive
// ChatView remounting while the user navigates.
export const draftFanoutSelectionsAtom = Atom.family((_routeKey: string) =>
  Atom.make<ReadonlyArray<ModelSelection> | null>(null).pipe(Atom.keepAlive),
);
const draftSendStateByRouteKey = new Map<
  string,
  {
    readonly sendInFlight: { current: boolean };
    readonly uncertainSubmissions: { current: Map<string, ThreadId> };
  }
>();
export function draftSendState(routeKey: string) {
  let state = draftSendStateByRouteKey.get(routeKey);
  if (!state) {
    state = { sendInFlight: { current: false }, uncertainSubmissions: { current: new Map() } };
    draftSendStateByRouteKey.set(routeKey, state);
  }
  return state;
}

/**
 * Starts one thread of a multiple-model send. A request that may have
 * reached the server before failing is remembered by `retryKey`, so sending
 * again cannot silently create a duplicate thread; its failure toast offers
 * to open that thread or to allow the retry.
 */
export async function startFanoutThread(input: {
  readonly retryKey: string;
  readonly model: string;
  readonly uncertainSubmissions: Map<string, ThreadId>;
  readonly start: (threadId: ThreadId) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly openThread: (threadId: ThreadId) => void;
}): Promise<boolean> {
  const { retryKey, uncertainSubmissions } = input;
  const uncertainThreadId = uncertainSubmissions.get(retryKey);
  const targetThreadId = uncertainThreadId ?? newThreadId();
  let requestMayHaveStarted = false;
  try {
    if (uncertainThreadId) {
      throw new Error(
        "The previous request may have started. Open its thread to check before sending again.",
      );
    }
    requestMayHaveStarted = true;
    const result = await input.start(targetThreadId);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      if (wasBootstrapThreadDeleted(error) || wasBootstrapThreadNotCreated(error)) {
        requestMayHaveStarted = false;
      }
      throw error;
    }
    return true;
  } catch (error) {
    if (requestMayHaveStarted && !uncertainSubmissions.has(retryKey)) {
      uncertainSubmissions.set(retryKey, targetThreadId);
    }
    const retainedThreadId = uncertainSubmissions.get(retryKey);
    const failureToastId = toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not start ${input.model}`,
        description: error instanceof Error ? error.message : "Failed to send message.",
        ...(retainedThreadId
          ? {
              timeout: 0,
              data: {
                secondaryActionProps: {
                  children: "Allow retry",
                  onClick: () => {
                    void readLocalApi()
                      ?.dialogs.confirm(
                        "The previous request may already be running. Check its thread first. Allow another send that could create a duplicate thread?",
                      )
                      .then(
                        (confirmed) => {
                          if (
                            confirmed &&
                            uncertainSubmissions.get(retryKey) === retainedThreadId
                          ) {
                            uncertainSubmissions.delete(retryKey);
                            toastManager.close(failureToastId);
                          }
                        },
                        () => undefined,
                      );
                  },
                },
              },
              actionProps: {
                children: "Open thread",
                onClick: () => input.openThread(retainedThreadId),
              },
            }
          : {}),
      }),
    );
    return false;
  }
}

/**
 * Reverts the thread to before `message` and puts that message's text and
 * attachments back in the composer draft. Returns the restored prompt, or the
 * error to show; on error the draft is untouched.
 */
export async function rewindToMessage(input: {
  readonly message: ChatMessage;
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly restoreFiles: boolean;
  readonly checkpoint: ReturnType<typeof findRevertCheckpoint>;
  readonly draftTarget: ScopedThreadRef | DraftId;
  readonly composerHasPendingAttachments: boolean;
  readonly createAssetUrl: Parameters<
    typeof prepareRevertedMessageAttachments
  >[0]["createAssetUrl"];
  readonly revertThreadCheckpoint: (value: {
    environmentId: EnvironmentId;
    input: {
      commandId: CommandId;
      threadId: ThreadId;
      turnCount: number;
      restoreFiles: boolean;
      checkpointId?: string;
      scopeId?: string;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<
  | { readonly error: string; readonly prompt?: never }
  | { readonly error: null; readonly prompt: string }
> {
  const { message, environmentId, draftTarget } = input;
  try {
    if (input.composerHasPendingAttachments) {
      throw new Error("Wait for attachments to finish preparing before rewinding.");
    }
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error("The environment is not connected.");
    const files = await prepareRevertedMessageAttachments({
      message,
      environmentId,
      httpBaseUrl: connection.httpBaseUrl,
      createAssetUrl: input.createAssetUrl,
    });
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(draftTarget);
    if (
      (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + files.length >
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      throw new Error("Make room for this message's attachments in the composer before rewinding.");
    }
    const commandId = CommandId.make(randomUUID());
    await waitForRevertedMessage(input.routeThreadRef, input.turnCount, commandId, async () => {
      const result = await input.revertThreadCheckpoint({
        environmentId,
        input: {
          commandId,
          threadId: input.threadId,
          turnCount: input.turnCount,
          restoreFiles: input.restoreFiles,
          ...(input.checkpoint === undefined
            ? {}
            : { checkpointId: input.checkpoint.id, scopeId: input.checkpoint.scopeId }),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    });
    const currentPrompt = store.getComposerDraft(draftTarget)?.prompt ?? "";
    const restoredPrompt = recallableComposerPrompt(message.text);
    const nextPrompt =
      restoredPrompt.length === 0
        ? currentPrompt
        : currentPrompt.length > 0
          ? `${currentPrompt}\n\n${restoredPrompt}`
          : restoredPrompt;
    store.setPrompt(draftTarget, nextPrompt);
    const images: ComposerImageAttachment[] = [];
    const restoredFiles: ComposerFileAttachment[] = [];
    files.forEach((file, index) => {
      const attachment = {
        id: randomUUID(),
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      };
      if (message.attachments?.[index]?.type === "image") {
        images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
      } else {
        restoredFiles.push({ ...attachment, type: "file" });
      }
    });
    store.addImages(draftTarget, images, { allowDuplicates: true });
    store.addFiles(draftTarget, restoredFiles, { allowDuplicates: true });
    return { error: null, prompt: nextPrompt };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to revert thread state." };
  }
}

/**
 * Reopens an unsent launch's draft and returns where its message restores. A cancelled launch
 * (`failure` null) may have committed, and a deleted one is tombstoned, so either gets a fresh
 * thread id. The returned ref still resolves after that draft is sent and promoted.
 */
export function reopenUnsentDraftThread(
  draftId: DraftId,
  draftThread: DraftThreadState,
  launchRef: ScopedThreadRef,
  failure: TurnDeliveryFailure | null,
): ScopedThreadRef {
  const threadRef =
    failure === null || wasBootstrapThreadDeleted(squashAtomCommandFailure(failure))
      ? scopeThreadRef(launchRef.environmentId, newThreadId())
      : launchRef;
  restoreFailedDraftThread(draftId, draftThread, threadRef.threadId);
  return threadRef;
}

/**
 * Writes an unsent message's composer contents back into its draft, after any newer draft
 * started meanwhile. Images are fresh copies, so their previews outlive the optimistic row.
 * Returns false, changing nothing, when its attachments would not fit beside the newer draft.
 */
export function restoreComposerDraft(
  draftTarget: ScopedThreadRef | DraftId,
  snapshot: ComposerSendSnapshot,
): boolean {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(draftTarget);
  const newer = composerDraftHasUserContent(current) ? current : null;
  if (
    (newer?.images.length ?? 0) +
      (newer?.files.length ?? 0) +
      snapshot.images.length +
      snapshot.files.length >
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  ) {
    return false;
  }
  store.setPrompt(
    draftTarget,
    newer === null
      ? snapshot.messageText
      : snapshot.messageText.length === 0
        ? newer.prompt
        : `${newer.prompt.trimEnd()}\n\n${snapshot.messageText}`,
  );
  store.addImages(draftTarget, snapshot.images.map(cloneComposerImageForRetry), {
    allowDuplicates: true,
  });
  store.addFiles(draftTarget, snapshot.files, { allowDuplicates: true });
  store.setTerminalContexts(draftTarget, [
    ...(newer?.terminalContexts ?? []),
    ...snapshot.terminalContexts,
  ]);
  store.setPreviewAnnotations(draftTarget, [
    ...(newer?.previewAnnotations ?? []),
    ...snapshot.previewAnnotations,
  ]);
  store.setReviewComments(draftTarget, [
    ...(newer?.reviewComments ?? []),
    ...snapshot.reviewComments,
  ]);
  store.setThreadContexts(draftTarget, [
    ...(newer?.threadContexts ?? []),
    ...snapshot.threadContexts,
  ]);
  return true;
}

export interface MultipleModelTarget {
  readonly selection: ModelSelection;
  readonly text: string;
  readonly interactionMode: ProviderInteractionMode;
}

/**
 * The thread each selected model starts for a multiple-model send, in
 * selection order, or why that model cannot take the message.
 */
export function resolveMultipleModelTargets(input: {
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly messageText: string;
  readonly planModeEnabled: boolean;
  readonly interactionMode: ProviderInteractionMode;
}): Array<MultipleModelTarget | { readonly error: string }> {
  const { messageText, planModeEnabled } = input;
  return input.selections.map((selection) => {
    const provider = input.providerInstanceEntries.find(
      (entry) => entry.instanceId === selection.instanceId,
    );
    if (!provider?.enabled || !provider.isAvailable || provider.status !== "ready") {
      return { error: `Provider for ${selection.model} is unavailable.` };
    }
    const providerBlockReason = getAntigravitySendBlockReason(provider.snapshot, selection.model);
    if (providerBlockReason) return { error: providerBlockReason };
    const providerState = getComposerProviderState({
      provider: provider.driverKind,
      model: selection.model,
      models: provider.models,
      modelOptions: selection.options,
      promptInjectionState: getComposerPromptInjectionState(messageText),
      planModeEnabled,
    });
    return {
      selection: createModelSelection(
        selection.instanceId,
        selection.model,
        providerState.modelOptionsForDispatch,
      ),
      text: formatOutgoingPrompt({
        provider: provider.driverKind,
        model: selection.model,
        models: provider.models,
        effort: providerState.promptEffort,
        text: messageText || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      }),
      interactionMode: resolveComposerInteractionMode({
        planModeEnabled,
        provider: provider.snapshot,
        interactionMode: input.interactionMode,
      }).interactionMode,
    };
  });
}

/**
 * The attachments a turn sends: the server's upload records when it takes uploads, otherwise
 * images inlined as data URLs. Rejects when an attachment cannot go out.
 */
export function prepareTurnAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly usesAttachmentUploads: boolean;
}) {
  const { environmentId, usesAttachmentUploads } = input;
  return Promise.all(
    input.attachments.map(async (attachment) => {
      if (usesAttachmentUploads) {
        const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
        if (!uploaded) {
          throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
        }
        return uploaded;
      }
      if (attachment.type !== "image") {
        throw new Error("This server does not support file attachments.");
      }
      return {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: await readFileAsDataUrl(attachment.file),
        ...(attachment.source ? { source: attachment.source } : {}),
      };
    }),
  );
}
