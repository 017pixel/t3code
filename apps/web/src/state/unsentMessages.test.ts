import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { snapshotComposerSend } from "../components/ChatView.logic";
import { reopenUnsentDraftThread, restoreComposerDraft } from "../components/chat/chatViewSend";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../session-logic";
import type { ChatMessage } from "../types";
import { unsentMessages } from "./unsentMessages";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("t");
const target = { environmentId, threadId };
const messageId = MessageId.make("unsent-message");

function image(id: string) {
  return {
    type: "image" as const,
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 5,
    previewUrl: `data:image/png;base64,${id}`,
    file: new File([id], `${id}.png`, { type: "image/png" }),
  };
}

function newerImages() {
  return Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) =>
    image(`newer-${index}`),
  );
}

function unsentSnapshot() {
  return snapshotComposerSend({
    prompt: "Unsent message",
    images: [image("unsent")],
    files: [],
    terminalContexts: [],
    sendableTerminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  });
}

const display: ChatMessage = {
  id: messageId,
  role: "user",
  text: "Unsent message",
  runId: null,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  streaming: false,
};

function keepUnsentBesideFullDraft() {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, "Newer draft");
  store.addImages(target, newerImages());
  const snapshot = unsentSnapshot();
  const restore = () => restoreComposerDraft(target, snapshot);
  expect(restore()).toBe(false);
  unsentMessages.keep({ environmentId, threadId, display, restore });
  return store;
}

it("keeps an unsent message that does not fit until the composer has room", () => {
  const store = keepUnsentBesideFullDraft();

  expect(unsentMessages.restore(environmentId, messageId)).toBe(false);
  expect(unsentMessages.getSnapshot().map((record) => record.display.id)).toEqual([messageId]);
  expect(store.getComposerDraft(target)?.prompt).toBe("Newer draft");

  store.removeImage(target, "newer-0");
  expect(unsentMessages.restore(environmentId, messageId)).toBe(true);

  expect(unsentMessages.getSnapshot()).toEqual([]);
  const draft = store.getComposerDraft(target);
  expect(draft?.prompt).toBe("Newer draft\n\nUnsent message");
  expect(draft?.images.map((attachment) => attachment.id).at(-1)).toBe("unsent");
});

it("drops a kept message only when it is discarded", () => {
  const store = keepUnsentBesideFullDraft();

  unsentMessages.discard(environmentId, messageId);

  expect(unsentMessages.getSnapshot()).toEqual([]);
  expect(store.getComposerDraft(target)?.prompt).toBe("Newer draft");
});

it("restores a cancelled launch into its thread after the newer draft there is sent", () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const store = useComposerDraftStore.getState();
  const draftId = DraftId.make("launch-draft");
  store.setProjectDraftThreadId(scopeProjectRef(environmentId, ProjectId.make("p")), draftId, {
    threadId: ThreadId.make("launched"),
  });
  const launched = store.getDraftSession(draftId)!;
  markPromotedDraftThreadByRef(scopeThreadRef(environmentId, launched.threadId));
  store.setPrompt(draftId, "Newer draft");
  store.addImages(draftId, newerImages());

  const launchedRef = scopeThreadRef(environmentId, launched.threadId);
  const reopenedRef = reopenUnsentDraftThread(draftId, launched, launchedRef, null);
  expect(reopenedRef.threadId).not.toBe(launched.threadId);
  const snapshot = unsentSnapshot();
  const restore = () => restoreComposerDraft(reopenedRef, snapshot);
  expect(restore()).toBe(false);
  unsentMessages.keep({ environmentId, threadId: reopenedRef.threadId, display, restore });

  markPromotedDraftThreadByRef(reopenedRef);
  store.clearComposerContent(draftId);
  finalizePromotedDraftThreadByRef(reopenedRef);
  expect(store.getDraftSession(draftId)).toBeNull();

  expect(unsentMessages.restore(environmentId, messageId)).toBe(true);
  expect(unsentMessages.getSnapshot()).toEqual([]);
  const draft = store.getComposerDraft(reopenedRef);
  expect(draft?.prompt).toBe("Unsent message");
  expect(draft?.images.map((attachment) => attachment.id)).toEqual(["unsent"]);
});

it("shows a kept queued message in its timeline instead of as a queued run", () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, "Newer draft");
  store.addImages(target, newerImages());
  const snapshot = unsentSnapshot();
  const restore = () => restoreComposerDraft(target, snapshot);
  unsentMessages.keep({
    environmentId,
    threadId,
    display: { ...display, inputIntent: "queued_turn" },
    restore,
  });

  const [kept] = unsentMessages.getSnapshot();
  expect(kept?.display.inputIntent).not.toBe("queued_turn");
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [],
    optimisticMessages: unsentMessages.getSnapshot().map((record) => record.display),
  });
  expect(entries.map((entry) => entry.id)).toEqual([messageId]);
  unsentMessages.discard(environmentId, messageId);
});
