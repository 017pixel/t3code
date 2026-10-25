import {
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { snapshotComposerSend } from "../components/ChatView.logic";
import { restoreComposerDraft } from "../components/chat/chatViewSend";
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

function keepUnsentBesideFullDraft() {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, "Newer draft");
  store.addImages(
    target,
    Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) =>
      image(`newer-${index}`),
    ),
  );
  const snapshot = snapshotComposerSend({
    prompt: "Unsent message",
    images: [image("unsent")],
    files: [],
    terminalContexts: [],
    sendableTerminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  });
  const display: ChatMessage = {
    id: messageId,
    role: "user",
    text: "Unsent message",
    runId: null,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    streaming: false,
  };
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
