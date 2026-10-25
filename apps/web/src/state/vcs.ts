import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
  createVcsStatusRevalidationAtomFamily,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { getDocumentActivity, subscribeDocumentActivity } from "../lib/documentActivity";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

/** Fires when the window regains focus or the tab becomes visible again. */
function subscribeDocumentReturn(wake: () => void): () => void {
  let previous = getDocumentActivity();
  return subscribeDocumentActivity(() => {
    const next = getDocumentActivity();
    if ((next.focused && !previous.focused) || (next.visible && !previous.visible)) wake();
    previous = next;
  });
}

/**
 * Refreshes a checkout's status when the user comes back to the window, where
 * edits made in another app or terminal may be waiting.
 */
export const vcsStatusRevalidation = createVcsStatusRevalidationAtomFamily({
  refreshStatus: vcsEnvironment.refreshStatus,
  subscribeWake: subscribeDocumentReturn,
  wakeDebounceMs: 250,
});
