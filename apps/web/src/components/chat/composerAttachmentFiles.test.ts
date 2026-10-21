import { EnvironmentId, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  classifyComposerAttachmentFile,
  localComposerFilePath,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it("handles SVG clipboard files with the same text-paste behavior as ordinary files", () => {
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "diagram.svg", {
      type: "image/svg+xml",
    });

    expect(classifyComposerAttachmentFile(file)).toBe("file");
    expect(shouldHandleComposerAttachmentPaste({ files: [file], plainText: "" })).toBe(true);
    expect(shouldHandleComposerAttachmentPaste({ files: [file], plainText: "Copied text" })).toBe(
      false,
    );
  });

  it("resolves native file references only for the local desktop environment", () => {
    const environmentId = EnvironmentId.make("local");
    const file = new File(["video"], "clip.mov", { type: "video/quicktime" });
    let pathReads = 0;
    const local = {
      file,
      environmentId,
      primaryEnvironmentId: environmentId,
      localEnvironmentDisabled: false,
      getPathForFile: (selected: File) => {
        expect(selected).toBe(file);
        pathReads += 1;
        return "/local/clip.mov";
      },
    };
    expect(localComposerFilePath(local)).toBe("/local/clip.mov");
    expect(localComposerFilePath({ ...local, getPathForFile: undefined })).toBeNull();
    expect(localComposerFilePath({ ...local, localEnvironmentDisabled: true })).toBeNull();
    expect(localComposerFilePath({ ...local, primaryEnvironmentId: null })).toBeNull();
    expect(
      localComposerFilePath({ ...local, environmentId: EnvironmentId.make("remote") }),
    ).toBeNull();
    expect(pathReads).toBe(1);
    expect(localComposerFilePath({ ...local, getPathForFile: () => "" })).toBeNull();
  });

  it("keeps the hard upload limit even when the server advertises a larger limit", () => {
    const capability = {
      attachmentUploadsCapabilityKnown: true,
      supportsAttachmentUploads: true,
      maxFileAttachmentBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2,
    };

    expect(
      fileAttachmentCapabilityBlockReason({
        ...capability,
        files: [{ name: "archive.zip", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES }],
      }),
    ).toBeNull();
    const reason = fileAttachmentCapabilityBlockReason({
      ...capability,
      files: [{ name: "archive.zip", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }],
    });
    expect(reason).toContain("archive.zip");
    expect(reason).toContain("50 MB");
    expect(reason).toMatch(/path/i);
  });

  it("preserves text paste when an application adds a synthetic generic file", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Copied text",
      }),
    ).toBe(false);
  });

  it("uses the hard local limit while server config is unknown", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    expect(
      fileAttachmentCapabilityBlockReason({
        files: [{ name: "pending.zip", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES }],
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBe("Waiting for the server before file attachments can send");
  });

  it("keeps draft-persisted file uploads when the upload capability flips off", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const image: ComposerImageAttachment = {
      type: "image",
      id: "image-1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "blob:photo",
      file: new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }),
    };
    const uploadingFile: ComposerFileAttachment = {
      type: "file",
      id: "file-uploading",
      name: "fresh.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: new File([new Uint8Array([1, 2, 3])], "fresh.pdf", { type: "application/pdf" }),
    };
    const hydratedFile: ComposerFileAttachment = {
      type: "file",
      id: "file-hydrated",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "pending-report-pdf",
      uploadEnvironmentId: environmentId,
    };
    const uploadedLocalFile: ComposerFileAttachment = {
      ...uploadingFile,
      id: "file-uploaded-local",
      uploadedAttachmentId: "pending-fresh-pdf",
      uploadEnvironmentId: environmentId,
    };

    const released = attachmentsToReleaseOnUploadCapabilityLoss([
      image,
      uploadingFile,
      hydratedFile,
      uploadedLocalFile,
    ]);

    expect(released.map((attachment) => attachment.id)).toEqual(["image-1", "file-uploading"]);
  });
});
