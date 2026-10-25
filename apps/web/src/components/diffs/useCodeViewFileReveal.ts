import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  getItem(id: string): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

/**
 * Scrolls a code view to a file. A file the viewer does not hold yet stays
 * pending until `flush` (from the viewer's post-render) finds it. A pending
 * reveal belongs to the viewer it was asked of, so a remounted viewer, such as
 * one for another diff scope, drops it.
 */
export function createCodeViewFileReveal() {
  let pending: { readonly viewer: FileRevealHandle; readonly fileKey: string } | null = null;
  const apply = (viewer: FileRevealHandle, fileKey: string) => {
    if (!viewer.getInstance() || viewer.getItem(fileKey) === undefined) return false;
    viewer.scrollTo({ type: "item", id: fileKey, align: "start" });
    return true;
  };
  return {
    request(viewer: FileRevealHandle | null, fileKey: string) {
      pending = viewer === null || apply(viewer, fileKey) ? null : { viewer, fileKey };
    },
    flush(viewer: FileRevealHandle | null) {
      if (pending === null || pending.viewer !== viewer) return;
      if (apply(pending.viewer, pending.fileKey)) pending = null;
    },
  };
}

export function useCodeViewFileReveal(viewer: FileRevealHandle | null) {
  const [reveal] = useState(createCodeViewFileReveal);
  return (fileKey: string) => reveal.request(viewer, fileKey);
}
