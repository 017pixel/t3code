// EXPERIMENTAL mesh v1: thread lists show a thread another machine started under the thread
// that started it, such as a remote delegate_task child under its parent.
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "./environment/scoped.ts";

export interface MeshNestableThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly source: Pick<OrchestrationV2ThreadShell, "id" | "meshOrigin">;
}

export interface MeshThreadNesting<T> {
  /** Threads listed on their own, in input order. The input itself when nothing nests. */
  readonly roots: ReadonlyArray<T>;
  /** Nested threads by their top-level ancestor's scoped key, in input order. */
  readonly childrenByParentKey: ReadonlyMap<string, ReadonlyArray<T>>;
}

const NO_CHILDREN: ReadonlyMap<string, ReadonlyArray<never>> = new Map();

const threadKey = (thread: MeshNestableThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

export function resolveMeshThreadRootKey(
  selectedThreadKey: string | null,
  childrenByParentKey: ReadonlyMap<string, ReadonlyArray<MeshNestableThread>>,
): string | null {
  if (selectedThreadKey === null) return null;
  for (const [parentKey, children] of childrenByParentKey) {
    if (children.some((child) => threadKey(child) === selectedThreadKey)) return parentKey;
  }
  return selectedThreadKey;
}

function originKey(thread: MeshNestableThread): string | null {
  const origin = thread.source.meshOrigin;
  if (origin?.threadId == null || origin.environmentId === thread.environmentId) return null;
  return scopedThreadKey(scopeThreadRef(origin.environmentId, origin.threadId));
}

/**
 * Nests a thread under its mesh origin thread only when that thread is in `threads` too, so a
 * child whose parent is hidden or on a machine this client cannot see stays listed on its own.
 * Children of nested threads go under the same top-level ancestor; a cycle stays top-level.
 */
export function nestMeshChildren<T extends MeshNestableThread>(
  threads: ReadonlyArray<T>,
): MeshThreadNesting<T> {
  // Most lists have no thread from another machine; they pay one scan and keep their identity.
  if (!threads.some((thread) => originKey(thread) !== null)) {
    return { roots: threads, childrenByParentKey: NO_CHILDREN };
  }
  const byKey = new Map(threads.map((thread) => [threadKey(thread), thread] as const));
  const rootKeyOf = (thread: T): string | null => {
    const seen = new Set([threadKey(thread)]);
    let parentKey = originKey(thread);
    let rootKey: string | null = null;
    while (parentKey !== null) {
      const parent = byKey.get(parentKey);
      if (parent === undefined) return rootKey;
      if (seen.has(parentKey)) return null;
      seen.add(parentKey);
      rootKey = parentKey;
      parentKey = originKey(parent);
    }
    return rootKey;
  };
  const roots: T[] = [];
  const childrenByParentKey = new Map<string, T[]>();
  for (const thread of threads) {
    const rootKey = rootKeyOf(thread);
    if (rootKey === null) {
      roots.push(thread);
      continue;
    }
    const siblings = childrenByParentKey.get(rootKey);
    if (siblings) siblings.push(thread);
    else childrenByParentKey.set(rootKey, [thread]);
  }
  return { roots, childrenByParentKey };
}
