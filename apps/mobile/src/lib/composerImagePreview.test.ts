import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ write: vi.fn(async () => undefined) }));

vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class {
    constructor(
      readonly parent: string,
      readonly name: string,
    ) {}
    create() {}
  },
  File: class {
    readonly uri: string;
    constructor(directory: { parent: string; name: string }, name: string) {
      this.uri = `${directory.parent}/${directory.name}/${name}`;
    }
    get exists() {
      return false;
    }
    create() {}
    write = mocks.write;
  },
}));

import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import type { DraftComposerImageAttachment } from "./composerImages";
import { MaterializedPreviewKey, materializedPreviewAtom } from "./composerImagePreview";

describe("materializedPreviewAtom", () => {
  it("keeps the materialized preview when the upload reference lands", async () => {
    const registry = AtomRegistry.make();
    const attachment: DraftComposerImageAttachment = {
      id: "image-1",
      type: "image",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUri: "data:image/png;base64,AAAA",
    };
    const atom = materializedPreviewAtom(new MaterializedPreviewKey(attachment));
    const unmount = registry.mount(atom);
    await vi.waitFor(() => expect(AsyncResult.isSuccess(registry.get(atom))).toBe(true));

    const uploaded = materializedPreviewAtom(
      new MaterializedPreviewKey({
        ...attachment,
        uploadedAttachmentId: "uploaded-1",
        uploadEnvironmentId: "env-1" as EnvironmentId,
      }),
    );

    expect(uploaded).toBe(atom);
    const result = registry.get(uploaded);
    expect(AsyncResult.isSuccess(result) && result.value).toBe(
      "file:///cache/t3-composer-previews/image-1.png",
    );
    expect(mocks.write).toHaveBeenCalledTimes(1);
    unmount();
  });
});
