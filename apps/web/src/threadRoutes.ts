import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
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

export function isThreadRouteSnapshotAuthoritative(
  status: EnvironmentShellStatus | undefined,
): boolean {
  return status === "live";
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadExists: boolean;
  serverThreadDeleted: boolean;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (input.draftThreadExists || (input.serverThreadExists && !input.serverThreadDeleted)) {
    return "ready";
  }
  if (!input.bootstrapComplete) {
    return "loading";
  }
  return "missing";
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

export interface KeptThreadView {
  /** Promotion preserves the draft's React key. */
  readonly key: string;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Draft views are dropped once left. */
  readonly draftId: DraftId | null;
  readonly visit: number;
}

/** Keep recent views in DOM order so their scroll positions and editor history survive. */
export function resolveKeptThreadViews(
  current: ReadonlyArray<KeptThreadView>,
  active: Omit<KeptThreadView, "visit"> | null,
  limit = 4,
): ReadonlyArray<KeptThreadView> {
  const lastVisit = current.reduce((max, view) => Math.max(max, view.visit), 0);
  const existing =
    active === null
      ? undefined
      : current.find((view) =>
          active.draftId === null ? view.threadKey === active.threadKey : view.key === active.key,
        );
  const views = current.flatMap((view) => {
    if (view === existing && active !== null) {
      return [
        { ...active, key: view.key, visit: view.visit === lastVisit ? lastVisit : lastVisit + 1 },
      ];
    }
    return view.draftId === null ? [view] : [];
  });
  if (active !== null && existing === undefined) views.push({ ...active, visit: lastVisit + 1 });
  if (views.length > limit) {
    const oldest = views.reduce((a, b) => (a.visit < b.visit ? a : b));
    views.splice(views.indexOf(oldest), 1);
  }
  return views.length === current.length &&
    views.every((view, index) => {
      const old = current[index];
      return (
        old !== undefined &&
        view.key === old.key &&
        view.threadKey === old.threadKey &&
        view.draftId === old.draftId &&
        view.visit === old.visit
      );
    })
    ? current
    : views;
}
