import type { PostRenderPhase } from "@pierre/diffs";
import { useEffect, useLayoutEffect, useState } from "react";

interface SourceSelection {
  readonly start: number;
  readonly end: number;
}

function getLineStarts(state: SourceTextSelection): number[] {
  if (state.lineStarts) return state.lineStarts;
  const starts = [0];
  for (let index = state.text.indexOf("\n"); index !== -1;) {
    starts.push(index + 1);
    index = state.text.indexOf("\n", index + 1);
  }
  state.lineStarts = starts;
  return starts;
}

function lineBounds(state: SourceTextSelection, lineNumber: number): SourceSelection | null {
  const starts = getLineStarts(state);
  const start = starts[lineNumber - 1];
  if (start === undefined) return null;
  const next = starts[lineNumber];
  return { start, end: next === undefined ? state.text.length : next - 1 };
}

function renderedLine(element: Element): number | null {
  const lineNumber = Number((element as HTMLElement).dataset.line);
  return Number.isInteger(lineNumber) ? lineNumber : null;
}

function domPointToOffset(
  state: SourceTextSelection,
  node: Node,
  nodeOffset: number,
): number | null {
  const element = node instanceof Element ? node : node.parentElement;
  const lineElement = element?.closest("[data-line]");
  if (!lineElement) {
    // Drags past the first or last row end on the code column itself.
    if (!(node instanceof Element)) return null;
    const after = node.childNodes[nodeOffset];
    const lineAfter =
      after instanceof Element
        ? after.matches("[data-line]")
          ? after
          : after.querySelector("[data-line]")
        : null;
    if (lineAfter) {
      const lineNumber = renderedLine(lineAfter);
      return lineNumber === null ? null : (lineBounds(state, lineNumber)?.start ?? null);
    }
    const lines = node.querySelectorAll("[data-line]");
    const last = lines[lines.length - 1];
    const lineNumber = last ? renderedLine(last) : null;
    return lineNumber === null ? null : (lineBounds(state, lineNumber)?.end ?? null);
  }
  const lineNumber = renderedLine(lineElement);
  const bounds = lineNumber === null ? null : lineBounds(state, lineNumber);
  if (!bounds) return null;
  const prefix = document.createRange();
  prefix.setStart(lineElement, 0);
  prefix.setEnd(node, nodeOffset);
  return Math.min(bounds.start + prefix.toString().length, bounds.end);
}

function offsetToDomPoint(
  lineElement: Element,
  column: number,
): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT);
  let remaining = column;
  let last: Text | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (remaining <= node.length) return { node, offset: remaining };
    remaining -= node.length;
    last = node;
  }
  return last ? { node: last, offset: last.length } : { node: lineElement, offset: 0 };
}

function readDomSelection(root: ShadowRoot): AbstractRange | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  if (typeof selection.getComposedRanges === "function") {
    return selection.getComposedRanges({ shadowRoots: [root] })[0] ?? null;
  }
  return selection.getRangeAt(0);
}

function readSourceSelection(state: SourceTextSelection): SourceSelection | "outside" | null {
  const root = state.host?.shadowRoot;
  if (!root) return null;
  const range = readDomSelection(root);
  if (!range || range.collapsed) return null;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return "outside";
  }
  const start = domPointToOffset(state, range.startContainer, range.startOffset);
  const end = domPointToOffset(state, range.endContainer, range.endOffset);
  if (start === null || end === null) return "outside";
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function restoreDomSelection(state: SourceTextSelection) {
  const root = state.host?.shadowRoot;
  const source = state.selection;
  if (!root || !source) return;
  const lines = root.querySelectorAll("[data-line]");
  const first = lines[0];
  const last = lines[lines.length - 1];
  const firstLine = first ? renderedLine(first) : null;
  const lastLine = last ? renderedLine(last) : null;
  const firstBounds = firstLine === null ? null : lineBounds(state, firstLine);
  const lastBounds = lastLine === null ? null : lineBounds(state, lastLine);
  const selection = document.getSelection();
  if (!selection || !first || !last || !firstBounds || !lastBounds) return;
  const start = Math.max(source.start, firstBounds.start);
  const end = Math.min(source.end, lastBounds.end);
  if (start >= end) {
    state.restored = null;
    if (readSourceSelection(state) !== null) selection.removeAllRanges();
    return;
  }
  const point = (offset: number) => {
    const starts = getLineStarts(state);
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    const element = root.querySelector(`[data-line="${low + 1}"]`);
    return element ? offsetToDomPoint(element, offset - (starts[low] ?? 0)) : null;
  };
  const startPoint = point(start);
  const endPoint = point(end);
  if (!startPoint || !endPoint) return;
  state.restored = { start, end };
  selection.setBaseAndExtent(startPoint.node, startPoint.offset, endPoint.node, endPoint.offset);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}

class SourceTextSelection {
  lineStarts: number[] | null = null;
  host: HTMLElement | null = null;
  selection: SourceSelection | null = null;
  // The range last drawn by restore, so its selectionchange is not read back
  // as a user selection clamped to the rendered rows.
  restored: SourceSelection | null = null;
  active = false;

  constructor(public text: string) {}

  setText(text: string) {
    if (this.text === text) return;
    this.text = text;
    this.lineStarts = null;
    this.selection = null;
    this.restored = null;
  }

  onPostRender = (fileContainer: HTMLElement, phase: PostRenderPhase) => {
    if (phase === "unmount") {
      if (this.host === fileContainer) this.host = null;
      return;
    }
    this.host = fileContainer;
    restoreDomSelection(this);
  };

  listen(): () => void {
    const onSelectionChange = () => {
      const next = readSourceSelection(this);
      if (next === null) return;
      if (next === "outside") {
        this.selection = null;
        return;
      }
      if (this.restored && next.start === this.restored.start && next.end === this.restored.end) {
        return;
      }
      this.restored = null;
      this.selection = next;
    };
    const onPointerDown = (event: PointerEvent) => {
      const scroller = this.host?.closest(".file-preview-virtualizer");
      // The scrollbar belongs to the scroller; using it keeps the selection.
      if (scroller && event.target === scroller) return;
      this.selection = null;
      this.restored = null;
      this.active = scroller ? event.composedPath().includes(scroller) : false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "a" || !(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      if (!this.active || isEditableTarget(event.target)) return;
      event.preventDefault();
      this.selection = { start: 0, end: this.text.length };
      restoreDomSelection(this);
    };
    const onCopy = (event: ClipboardEvent) => {
      const source = this.selection;
      if (!source || !event.clipboardData || isEditableTarget(document.activeElement)) return;
      if (readSourceSelection(this) === "outside") return;
      event.clipboardData.setData("text/plain", this.text.slice(source.start, source.end));
      event.preventDefault();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("copy", onCopy, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("copy", onCopy, true);
    };
  }
}

/**
 * Keeps the preview's text selection as source offsets. The virtualizer drops
 * offscreen rows, which collapses a DOM selection and limits select all and
 * copy to the rendered rows, so both read from the source text instead.
 */
export function useSourceTextSelection(text: string) {
  const [selection] = useState(() => new SourceTextSelection(text));
  useLayoutEffect(() => selection.setText(text), [selection, text]);
  useEffect(() => selection.listen(), [selection]);
  return selection.onPostRender;
}
