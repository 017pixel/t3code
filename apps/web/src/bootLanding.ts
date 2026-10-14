import type { ScopedProjectRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { DraftId, DraftSessionState } from "./composerDraftStore";

/** A snapshot landing accepts typing but waits for server defaults before sending. */
export interface PendingLandingDraft {
  readonly draftId: DraftId;
  /** A user move from this project drops the landing. */
  readonly projectRef: ScopedProjectRef;
  /** Preserve changes the user makes while defaults load. */
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

export function useLandingDraftDefaultsPending(draftId: DraftId | null): boolean {
  const landing = usePendingLandingDraft();
  return draftId !== null && landing?.draftId === draftId;
}
