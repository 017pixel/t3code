import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  hostPreviewMimeTypeFromExtension,
  isWorkspaceAudioPreviewPath,
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceFontPreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  mediaKindFromPath,
  officePreviewKind,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["ttf", "otf", "woff", "woff2"])(
    "previews %s fonts through signed host assets",
    (extension) => {
      expect(
        filePreviewKind({ name: `sample.${extension}`, mimeType: "application/octet-stream" }),
      ).toBe("font");
      expect(filePreviewKind({ name: "download", mimeType: `font/${extension}` })).toBe("font");
      expect(isWorkspaceFontPreviewPath(`/tmp/sample.${extension.toUpperCase()}`)).toBe(true);
      expect(isWorkspacePreviewEntryPath(`sample.${extension}`)).toBe(true);
      expect(hostPreviewMimeTypeFromExtension(`.${extension}`)).toBe(`font/${extension}`);
      expect(isWorkspaceFontPreviewPath(`sample.${extension}?download=1`)).toBe(false);
      expect(filePreviewKind({ name: `sample.${extension}`, mimeType: "application/zip" })).toBe(
        "unsupported",
      );
    },
  );
  it.each([
    [
      "quarterly-report.DOCX",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "finance#q4/operating-plan.xlsx",
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    [
      "slides?review/quarterly-review.pptx",
      "pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  ])("recognizes Office assets at literal path %s", (name, kind, mimeType) => {
    expect(officePreviewKind({ name })).toBe(kind);
    expect(filePreviewKind({ name, mimeType: "application/octet-stream" })).toBe(kind);
    expect(isWorkspacePreviewEntryPath(name)).toBe(true);
    expect(hostPreviewMimeTypeFromExtension(`.${kind}`)).toBe(mimeType);
    expect(filePreviewKind({ name: "download", mimeType })).toBe(kind);
    expect(filePreviewKind({ name, mimeType: "application/zip" })).toBe("unsupported");
  });
  it.each(["report.html", "report.HTM", "document#draft.pdf", "reports?old/document.pdf"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector#mark.svg",
    "photo?edited.JPEG",
    "images#archive/icon.png",
    "texture.webp",
    "image.avif",
    "picture.bmp",
    "photo.heic",
    "scan.tif",
    "scan.TIFF",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each([
    "README.md",
    "src/index.ts",
    "image.png.ts",
    "png",
    "image.png#notes.txt",
    "image.svg?notes.txt",
    "document.pdf?download=1",
    "report.html#notes.txt",
    "report.docx#notes.txt",
    "report.xlsx?download=1",
    "slides%2Epptx",
    "report.docm",
    "slides.ppt",
    "image%2Epng",
  ])("rejects non-preview path %s", (path) => {
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  it("serves audio in place from the host like video and browser documents", () => {
    expect(isWorkspaceAudioPreviewPath("notes/recording.WAV")).toBe(true);
    expect(isWorkspaceAudioPreviewPath("recording.wav.ts")).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(".m4a")).toBe("audio/mp4");
    expect(hostPreviewMimeTypeFromExtension(".weba")).toBe("audio/webm");
    expect(hostPreviewMimeTypeFromExtension(".mp4")).toBe("video/mp4");
    expect(hostPreviewMimeTypeFromExtension(".txt")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".constructor")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".toString")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".__proto__")).toBeNull();
    expect(hostPreviewMimeTypeFromExtension(".webm-audio")).toBe("audio/webm");
  });
});

describe("media path parsing", () => {
  it.each([
    ["https://cdn.example/clip.webm?download=1#t=2", "video"],
    ["https://example.com/download?name=recording.mp4", null],
    ["https://example.png", null],
    ["images%2Fresult%2Epng", "image"],
    ["images/result%23v2.png", "image"],
    ["images/result.png%23secret.txt", null],
    ["images/result.png%3Fsecret.txt", null],
    ["/tmp/100%.png", "image"],
    ["/tmp/tone.MP3", "audio"],
    ["./tone.wav", "audio"],
    ["tone.ogg", "audio"],
    ["tone.m4a", "audio"],
    ["tone.flac", "audio"],
    ["tone.aac", "audio"],
    ["tone.opus", "audio"],
    ["tone.webm-audio", "audio"],
    ["tone.webm", "video"],
    ["https://example.com/tone%2Emp3?download=1", "audio"],
    ["tone.mp3%23notes.txt", null],
    ["data.csv", null],
    ["report.pdf", null],
    ["report.docx", null],
    ["archive.zip", null],
  ])("classifies the decoded pathname of %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });

  it.each([
    ["recording.mp4#t=2", "video", false],
    ["recording%2Emp4", "video", false],
    ["recording#take2.mp4", null, true],
    ["recording?take2.mp4", null, true],
  ])("distinguishes authored URLs from literal filenames in %s", (source, kind, literalVideo) => {
    expect(mediaKindFromPath(source)).toBe(kind);
    expect(isWorkspaceVideoPreviewPath(source)).toBe(literalVideo);
  });
});

describe("attachment preview classification", () => {
  it.each([
    ["example.json", "application/octet-stream", "text"],
    ["README.md", "text/plain", "markdown"],
    ["component.tsx", "", "text"],
    ["report.pdf", "application/pdf", "pdf"],
    ["page.HTML", "", "html"],
    ["diagram.mmd", "", "mermaid"],
    ["diagram.MERMAID", "text/plain", "mermaid"],
    ["download", "text/vnd.mermaid", "mermaid"],
    ["source-code.otf", "application/vnd.oasis.opendocument.formula-template", "font"],
    ["notes.rtf", "application/rtf", "text"],
    ["notes.rtf", "", "text"],
    ["clip.weba", "", "audio"],
    ["image.bmp", "application/octet-stream", "image"],
    ["photo.heic", "application/octet-stream", "image"],
    ["scan.tiff", "application/octet-stream", "image"],
    ["recording.mp3", "", "audio"],
    ["recording.webm-audio", "", "audio"],
    ["recording.webm", "audio/webm", "audio"],
    ["payload", "application/problem+json", "text"],
    ["archive.zip", "application/zip", "unsupported"],
    ["misleading.json", "application/pdf", "pdf"],
    ["misleading.pdf", "application/zip", "unsupported"],
  ])("classifies %s (%s) as %s", (name, mimeType, expected) => {
    expect(filePreviewKind({ name, mimeType })).toBe(expected);
  });
  it("rejects binary and invalid UTF-8 data", () => {
    expect(() => decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toThrow("binary");
    expect(() => decodeFilePreviewText(new Uint8Array([255]))).toThrow("UTF-8");
  });
  it.each(["doc", "xls", "ppt", "odt", "ods", "odp", "epub", "zip", "tar", "gz", "7z", "rar"])(
    "retains the binary fallback for %s, which opencode does not render",
    (extension) => {
      expect(filePreviewKind({ name: `sample.${extension}` })).toBe("unsupported");
    },
  );
  it("does not corrupt a multi-byte character at the preview boundary", () => {
    const bytes = new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES + 1).fill(97);
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES - 1] = 0xe2;
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES] = 0x82;
    const preview = decodeFilePreviewText(bytes);
    expect(preview.truncated).toBe(true);
    expect(preview.text.endsWith("�")).toBe(false);
    expect(preview.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES - 1);
  });
});
