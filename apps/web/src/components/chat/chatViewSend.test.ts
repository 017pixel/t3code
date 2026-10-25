import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
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
