import { EnvironmentId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { terminalContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { snapshotComposerSend } from "../ChatView.logic";
import { restoreComposerDraft } from "./chatViewSend";

const target = { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("t") };

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

it("restores an unsent message after a newer draft without replacing it", () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, "Newer draft");
  store.addImages(target, [image("newer")]);
  const unsent = snapshotComposerSend({
    prompt: "Unsent message",
    images: [image("unsent")],
    files: [],
    terminalContexts: [],
    sendableTerminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  });

  restoreComposerDraft(target, unsent);

  const draft = store.getComposerDraft(target);
  expect(draft?.prompt).toBe("Newer draft\n\nUnsent message");
  expect(draft?.images.map((attachment) => attachment.id)).toEqual(["newer", "unsent"]);
});

it("leaves a full newer draft untouched when the unsent attachments do not fit", () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, "Newer draft");
  store.addImages(
    target,
    Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) =>
      image(`newer-${index}`),
    ),
  );
  const unsent = snapshotComposerSend({
    prompt: "Unsent message",
    images: [image("unsent")],
    files: [],
    terminalContexts: [],
    sendableTerminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  });

  expect(restoreComposerDraft(target, unsent)).toBe(false);

  const draft = store.getComposerDraft(target);
  expect(draft?.prompt).toBe("Newer draft");
  expect(draft?.images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
  expect(unsent.images.map((attachment) => attachment.id)).toEqual(["unsent"]);
});

it("points a restored terminal reference at the newer draft's copy of the same selection", () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const store = useComposerDraftStore.getState();
  const selection = (id: string): TerminalContextDraft => ({
    id,
    threadId: target.threadId,
    createdAt: "2026-10-25T00:00:00.000Z",
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 4,
    lineEnd: 6,
    text: "npm test failed",
  });
  const newer = selection("newer-selection");
  const unsentSelection = selection("unsent-selection");
  const reference = (context: TerminalContextDraft) =>
    formatInlineContextReference(terminalContextReference(context));
  store.setPrompt(target, `Newer ${reference(newer)}`);
  store.setTerminalContexts(target, [newer]);
  const unsent = snapshotComposerSend({
    prompt: `Unsent ${reference(unsentSelection)}`,
    images: [],
    files: [],
    terminalContexts: [unsentSelection],
    sendableTerminalContexts: [unsentSelection],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  });

  expect(restoreComposerDraft(target, unsent)).toBe(true);

  const draft = store.getComposerDraft(target);
  expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["newer-selection"]);
  expect(draft?.prompt).toBe(`Newer ${reference(newer)}\n\nUnsent ${reference(newer)}`);
});
