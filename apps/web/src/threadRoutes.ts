import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  serverThreadDeleted: boolean;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (!input.bootstrapComplete) {
    return "loading";
  }
  if (input.draftThreadExists) {
    return "ready";
  }
  if (input.serverThreadDeleted) {
    return "missing";
  }
  return input.serverThreadExists ? "ready" : "missing";
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

/** A string identity for a route target, stable across renders. */
export function threadRouteTargetKey(target: ThreadRouteTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "server"
    ? `server:${scopedThreadKey(target.threadRef)}`
    : `draft:${target.draftId}`;
}

export function threadRouteTargetFromKey(key: string | null): ThreadRouteTarget | null {
  if (key === null) return null;
  if (key.startsWith("draft:")) {
    return { kind: "draft", draftId: key.slice("draft:".length) as DraftId };
  }
  const threadRef = key.startsWith("server:")
    ? parseScopedThreadKey(key.slice("server:".length))
    : null;
  return threadRef === null ? null : { kind: "server", threadRef };
}

/**
 * Resolves the thread represented by either a canonical thread route or a
 * draft route whose promotion to a server thread has been recorded.
 */
export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}

/** A chat view the thread route keeps mounted, shown or hidden by `ThreadRouteView`. */
export interface KeptThreadView {
  /** React key. A promoted draft keeps its draft id so its view survives the route swap. */
  readonly key: string;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Set while the view is a draft route's; drafts are not kept once left. */
  readonly draftId: DraftId | null;
  /** Visit order, used to evict the least recently shown view. */
  readonly visit: number;
}

/** Recently shown server threads stay rendered, so a revisit only reveals them. */
export const KEPT_THREAD_VIEW_LIMIT = 4;

/**
 * Adds or refreshes the active view and evicts the least recently shown
 * ones past `limit`. Entries never reorder: moving a rendered view in the
 * DOM would drop its scroll position. Returns `current` when nothing changed.
 */
export function resolveKeptThreadViews(
  current: ReadonlyArray<KeptThreadView>,
  active: Omit<KeptThreadView, "visit"> | null,
  limit = KEPT_THREAD_VIEW_LIMIT,
): ReadonlyArray<KeptThreadView> {
  const lastVisit = current.reduce((max, view) => Math.max(max, view.visit), 0);
  // A server thread reuses whichever view already shows it, which is how a
  // promoted draft's view carries over to the thread route.
  const activeIndex =
    active === null
      ? -1
      : current.findIndex((view) =>
          active.draftId === null ? view.threadKey === active.threadKey : view.key === active.key,
        );
  let next = current.filter((view, index) => view.draftId === null || index === activeIndex);
  if (active !== null) {
    const existing = activeIndex === -1 ? undefined : current[activeIndex];
    if (existing === undefined) {
      next = [...next, { ...active, visit: lastVisit + 1 }];
    } else if (
      existing.draftId !== active.draftId ||
      existing.environmentId !== active.environmentId ||
      existing.threadId !== active.threadId ||
      existing.visit !== lastVisit
    ) {
      const refreshed: KeptThreadView = {
        ...existing,
        environmentId: active.environmentId,
        threadId: active.threadId,
        threadKey: active.threadKey,
        draftId: active.draftId,
        visit: existing.visit === lastVisit ? lastVisit : lastVisit + 1,
      };
      next = next.map((view) => (view === existing ? refreshed : view));
    }
  }
  while (next.length > limit) {
    const evicted = next.reduce<KeptThreadView | null>(
      (oldest, view) =>
        (active !== null && view.threadKey === active.threadKey) ||
        (oldest !== null && oldest.visit <= view.visit)
          ? oldest
          : view,
      null,
    );
    if (evicted === null) break;
    next = next.filter((view) => view !== evicted);
  }
  return next.length === current.length && next.every((view, index) => view === current[index])
    ? current
    : next;
}
