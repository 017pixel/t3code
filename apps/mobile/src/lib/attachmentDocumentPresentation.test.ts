import { expect, it } from "vite-plus/test";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { attachmentDocumentPresentation } from "./attachmentDocumentPresentation";

it.each([
  {
    kind: "markdown",
    hasTable: false,
    hasEnvironment: false,
    rendered: true,
    renderedMode: null,
    activeMode: "source",
  },
  {
    kind: "markdown",
    hasTable: false,
    hasEnvironment: true,
    rendered: true,
    renderedMode: "markdown",
    activeMode: "markdown",
  },
  {
    kind: "markdown",
    hasTable: false,
    hasEnvironment: true,
    rendered: false,
    renderedMode: "markdown",
    activeMode: "source",
  },
  {
    kind: "text",
    hasTable: false,
    hasEnvironment: true,
    rendered: true,
    renderedMode: null,
    activeMode: "source",
  },
  {
    kind: "text",
    hasTable: true,
    hasEnvironment: false,
    rendered: true,
    renderedMode: "table",
    activeMode: "table",
  },
  {
    kind: "text",
    hasTable: true,
    hasEnvironment: true,
    rendered: false,
    renderedMode: "table",
    activeMode: "source",
  },
  {
    kind: "html",
    hasTable: false,
    hasEnvironment: false,
    rendered: true,
    renderedMode: "html",
    activeMode: "html",
  },
  {
    kind: "html",
    hasTable: false,
    hasEnvironment: true,
    rendered: false,
    renderedMode: "html",
    activeMode: "source",
  },
] as const)("matches the available preview for %j", ({ renderedMode, activeMode, ...input }) => {
  expect(attachmentDocumentPresentation(input)).toEqual({ renderedMode, activeMode });
});

it.each([
  [
    "report.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "unsupported",
  ],
  [
    "budget.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "unsupported",
  ],
  [
    "deck.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "unsupported",
  ],
  ["report.docx", "text/plain", "text"],
  ["report.docx", "application/octet-stream", "unsupported"],
  ["chart.mmd", "text/vnd.mermaid", "text"],
  ["chart.mermaid", "text/plain", "text"],
  ["chart.mmd", "application/octet-stream", "unsupported"],
  ["font.ttf", "font/ttf", "unsupported"],
] as const)("preserves mobile's existing path for %s (%s)", (name, mimeType, expected) => {
  expect(filePreviewKind({ name, mimeType }, { richDocuments: false })).toBe(expected);
});
