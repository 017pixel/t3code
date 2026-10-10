import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveKeptThreadViews,
  resolveThreadRouteRenderState,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  threadRouteTargetFromKey,
  threadRouteTargetKey,
  type KeptThreadView,
} from "./threadRoutes";

describe("threadRoutes", () => {
  it("builds canonical thread route params from a scoped ref", () => {
    const ref = scopeThreadRef("env-1" as never, ThreadId.make("thread-1"));

    expect(buildThreadRouteParams(ref)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("resolves a scoped ref only when both params are present", () => {
    expect(
      resolveThreadRouteRef({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(resolveThreadRouteRef({ environmentId: "env-1" })).toBeNull();
    expect(resolveThreadRouteRef({ threadId: "thread-1" })).toBeNull();
  });

  it("builds canonical draft route params from a draft id", () => {
    expect(buildDraftThreadRouteParams(DraftId.make("draft-1"))).toEqual({
      draftId: "draft-1",
    });
  });

  it("resolves draft and server route targets", () => {
    expect(
      resolveThreadRouteTarget({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "server",
      threadRef: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
    });

    expect(
      resolveThreadRouteTarget({
        draftId: "draft-1",
      }),
    ).toEqual({
      kind: "draft",
      draftId: "draft-1",
    });
  });

  it("resolves the backing thread while a draft route is being promoted", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: scopeThreadRef("env-2" as never, ThreadId.make("server-thread")),
      }),
    ).toEqual({
      environmentId: "env-2",
      threadId: "server-thread",
    });
  });

  it("does not treat a draft's reserved thread ref as an active sidebar thread", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: null,
      }),
    ).toBeNull();
  });

  it("renders authoritative server-thread shells when bootstrap is complete", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("ready");
  });

  it("renders server threads and local drafts when they are ready", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("ready");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: true,
      }),
    ).toBe("ready");
  });

  it("distinguishes bootstrap loading from a missing thread", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: false,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("loading");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("redirects deleted server threads", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: true,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("round-trips a route target through its key", () => {
    const server = resolveThreadRouteTarget({ environmentId: "env-1", threadId: "thread-1" });
    const draft = resolveThreadRouteTarget({ draftId: "draft-1" });
    expect(threadRouteTargetFromKey(threadRouteTargetKey(server))).toEqual(server);
    expect(threadRouteTargetFromKey(threadRouteTargetKey(draft))).toEqual(draft);
    expect(threadRouteTargetKey(null)).toBeNull();
    expect(threadRouteTargetFromKey(null)).toBeNull();
  });
});

describe("resolveKeptThreadViews", () => {
  const serverView = (id: string): Omit<KeptThreadView, "visit"> => ({
    key: `env-1:${id}`,
    threadKey: `env-1:${id}`,
    environmentId: "env-1" as never,
    threadId: ThreadId.make(id),
    draftId: null,
  });
  const keep = (
    views: ReadonlyArray<KeptThreadView>,
    active: Omit<KeptThreadView, "visit"> | null,
    limit?: number,
  ) => resolveKeptThreadViews(views, active, limit);

  it("adds each visited thread in place and returns the same list when nothing changes", () => {
    const first = keep([], serverView("a"));
    const second = keep(first, serverView("b"));
    expect(second.map((view) => view.threadId)).toEqual(["a", "b"]);
    expect(keep(second, serverView("b"))).toBe(second);
  });

  it("revisits a kept thread without moving it", () => {
    const views = keep(keep(keep([], serverView("a")), serverView("b")), serverView("a"));
    expect(views.map((view) => view.threadId)).toEqual(["a", "b"]);
    expect(views[0]!.visit).toBeGreaterThan(views[1]!.visit);
  });

  it("evicts the least recently shown thread past the limit", () => {
    let views = keep([], serverView("a"), 2);
    views = keep(views, serverView("b"), 2);
    views = keep(views, serverView("a"), 2);
    views = keep(views, serverView("c"), 2);
    expect(views.map((view) => view.threadId)).toEqual(["a", "c"]);
  });

  it("keeps a promoted draft's view, and its key, on the thread route", () => {
    const draftId = DraftId.make("draft-1");
    const draft = keep([], { ...serverView("t"), key: draftId, draftId });
    const promoted = keep(draft, serverView("t"));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ key: draftId, draftId: null, threadId: "t" });
  });

  it("drops a draft's view once another view is shown", () => {
    const draftId = DraftId.make("draft-1");
    const views = keep(keep([], serverView("a")), { ...serverView("t"), key: draftId, draftId });
    expect(keep(views, serverView("a")).map((view) => view.key)).toEqual(["env-1:a"]);
  });
});
