import type { ScopedThreadRef } from "@t3tools/contracts";

/** Compare both ids; scopedThreadKey can collide when ids contain colons. */
function isSameSidebarThreadRef(a: ScopedThreadRef, b: ScopedThreadRef): boolean {
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

interface SidebarPendingFileDrop {
  readonly id: string;
  readonly threadRef: ScopedThreadRef;
  readonly files: File[];
}

interface SidebarFileDropReceiver {
  readonly threadRef: ScopedThreadRef;
  readonly receive: (files: File[]) => void;
}

let pending: SidebarPendingFileDrop[] = [];
let receivers: SidebarFileDropReceiver[] = [];
let nextPendingFileDropId = 0;

/**
 * Hands files dropped on a sidebar thread to that thread's composer. With no composer
 * mounted for it yet, the drop waits until one registers; the returned id clears it.
 */
export function queuePendingFileDrop(entry: {
  readonly threadRef: ScopedThreadRef;
  readonly files: File[];
}): string | null {
  const receiver = receivers.findLast((candidate) =>
    isSameSidebarThreadRef(candidate.threadRef, entry.threadRef),
  );
  if (receiver) {
    receiver.receive(entry.files);
    return null;
  }
  const id = `sidebar-file-drop-${(nextPendingFileDropId += 1)}`;
  pending = [...pending, { ...entry, id }];
  return id;
}

export function clearPendingFileDrop(id: string | null): void {
  if (id === null) return;
  pending = pending.filter((drop) => drop.id !== id);
}

/** Drops only wait for their thread's route; leaving it (or never reaching it) discards them. */
export function retainPendingFileDropsForThread(threadRef: ScopedThreadRef | null): void {
  pending = pending.filter(
    (drop) => threadRef !== null && isSameSidebarThreadRef(drop.threadRef, threadRef),
  );
}

/**
 * A composer takes its thread's drops while registered, starting with any that arrived
 * before it mounted.
 */
export function registerSidebarFileDropReceiver(
  threadRef: ScopedThreadRef,
  receive: (files: File[]) => void,
): () => void {
  const receiver: SidebarFileDropReceiver = { threadRef, receive };
  receivers = [...receivers, receiver];
  const waiting = pending.filter((drop) => isSameSidebarThreadRef(drop.threadRef, threadRef));
  if (waiting.length > 0) {
    pending = pending.filter((drop) => !waiting.includes(drop));
    receive(waiting.flatMap((drop) => drop.files));
  }
  return () => {
    receivers = receivers.filter((candidate) => candidate !== receiver);
  };
}
