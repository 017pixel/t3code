import type { ScopedProjectRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { DraftId, DraftSessionState } from "./composerDraftStore";

/**
 * The index route normally opens the most recent project's draft only after
 * the server confirms its defaults (server settings, t3.json). A browser that
 * booted with a snapshot opens the empty draft it already has at once, and the
 * defaults land on it when the server answers. Until then the draft accepts
 * typing but not sending.
 */
export interface PendingLandingDraft {
  readonly draftId: DraftId;
  /** Where the draft sat when it opened; a move by the user from there drops the landing. */
  readonly projectRef: ScopedProjectRef;
  /** The draft's workspace context when it opened; a user change keeps theirs. */
  readonly openedWith: LandingDraftContext;
}

export type LandingDraftContext = Pick<
  DraftSessionState,
  "branch" | "worktreePath" | "envMode" | "startFromOrigin" | "runtimeMode" | "interactionMode"
>;

export function landingDraftContext(draft: DraftSessionState): LandingDraftContext {
  return {
    branch: draft.branch,
    worktreePath: draft.worktreePath,
    envMode: draft.envMode,
    startFromOrigin: draft.startFromOrigin,
    runtimeMode: draft.runtimeMode,
    interactionMode: draft.interactionMode,
  };
}

let pending: PendingLandingDraft | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function readPendingLandingDraft(): PendingLandingDraft | null {
  return pending;
}

export function setPendingLandingDraft(next: PendingLandingDraft): void {
  pending = next;
  emit();
}

export function clearPendingLandingDraft(draftId: DraftId): void {
  if (pending?.draftId !== draftId) return;
  pending = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingLandingDraft(): PendingLandingDraft | null {
  return useSyncExternalStore(subscribe, readPendingLandingDraft, readPendingLandingDraft);
}

/** Whether this draft still waits for the server's defaults before it can send. */
export function useLandingDraftDefaultsPending(draftId: DraftId | null): boolean {
  const landing = usePendingLandingDraft();
  return draftId !== null && landing?.draftId === draftId;
}
