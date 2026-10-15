// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  eraseHeldText,
  holdTextForUrlRouteTarget,
  isUrlTargetSidebarTextKey,
  setUrlRouteTargetKey,
  takeHeldText,
} from "./components/keptView";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveActiveThreadRouteRef,
  resolveKeptThreadViews,
  resolveThreadRouteRenderState,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
  type KeptThreadView,
} from "./threadRoutes";

describe("sidebar typing during a kept thread navigation", () => {
  const previous = "server:env-1:previous";
  const destination = "server:env-1:destination";
  const item = document.createElement("li");
  item.setAttribute("data-thread-item", "env-1:destination");
  item.innerHTML =
    '<div data-testid="sidebar-row-slim" role="button" tabindex="0"><button>Menu</button></div>';
  const row = item.querySelector<HTMLElement>("[role=button]")!;

  beforeEach(() => document.body.append(item));

  afterEach(() => {
    takeHeldText(destination);
    setUrlRouteTargetKey(null);
    item.remove();
  });

  it("holds destination row typing without giving any text to the previous draft", () => {
    setUrlRouteTargetKey(destination);
    row.focus();
    const key = new KeyboardEvent("keydown", { key: "A", shiftKey: true });
    row.dispatchEvent(key);
    expect(isUrlTargetSidebarTextKey(key)).toBe(true);
    expect(holdTextForUrlRouteTarget(previous, key.key)).toBe(true);
    expect(takeHeldText(previous)).toBeNull();
    holdTextForUrlRouteTarget(previous, "b");
    expect(eraseHeldText(previous)).toBe(true);
    holdTextForUrlRouteTarget(previous, "c");
    setUrlRouteTargetKey(destination);
    expect(takeHeldText(destination)).toBe("Ac");
    expect(takeHeldText(destination)).toBeNull();
    expect(eraseHeldText(previous)).toBe(false);
  });

  it("rejects another row and nested controls, and buffers nothing after reveal", () => {
    const key = new KeyboardEvent("keydown", { key: "a" });
    row.dispatchEvent(key);
    expect(isUrlTargetSidebarTextKey(key)).toBe(false);
    setUrlRouteTargetKey(previous);
    expect(isUrlTargetSidebarTextKey(key)).toBe(false);
    setUrlRouteTargetKey(destination);
    expect(isUrlTargetSidebarTextKey(key)).toBe(true);
    expect(holdTextForUrlRouteTarget(destination, "a")).toBe(false);
    row.querySelector("button")!.dispatchEvent(key);
    expect(isUrlTargetSidebarTextKey(key)).toBe(false);
    expect(takeHeldText(destination)).toBeNull();
  });

  it.each([
    { key: " " },
    { key: "Enter" },
    { key: "Tab" },
    { key: "ArrowDown" },
    { key: "a", ctrlKey: true },
    { key: "a", metaKey: true },
    { key: "a", altKey: true },
    { key: "a", isComposing: true },
  ])("leaves activation, navigation, modifiers and composition alone: %j", (init) => {
    setUrlRouteTargetKey(destination);
    const key = new KeyboardEvent("keydown", init);
    row.dispatchEvent(key);
    expect(isUrlTargetSidebarTextKey(key)).toBe(false);
    expect(takeHeldText(destination)).toBeNull();
  });
});

describe("threadRoutes", () => {
  it("does not treat cached thread lists as authoritative for deep links", () => {
    expect(isThreadRouteSnapshotAuthoritative("empty")).toBe(false);
    expect(isThreadRouteSnapshotAuthoritative("cached")).toBe(false);
    expect(isThreadRouteSnapshotAuthoritative("synchronizing")).toBe(false);
    expect(isThreadRouteSnapshotAuthoritative("live")).toBe(true);
  });

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

  it.each([
    { status: "cached", source: "server thread" },
    { status: "synchronizing", source: "server thread" },
    { status: "cached", source: "draft" },
    { status: "synchronizing", source: "draft" },
  ] as const)(
    "keeps available $source visible while the shell is $status",
    ({ status, source }) => {
      expect(
        resolveThreadRouteRenderState({
          bootstrapComplete: isThreadRouteSnapshotAuthoritative(status),
          serverThreadExists: source === "server thread",
          serverThreadDeleted: false,
          draftThreadExists: source === "draft",
        }),
      ).toBe("ready");
    },
  );

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

  it("waits for the live shell before redirecting a deleted thread", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: isThreadRouteSnapshotAuthoritative("cached"),
        serverThreadExists: true,
        serverThreadDeleted: true,
        draftThreadExists: false,
      }),
    ).toBe("loading");
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
  const visit = (ids: ReadonlyArray<string>, limit = 4) =>
    ids.reduce<ReadonlyArray<KeptThreadView>>(
      (views, id) => resolveKeptThreadViews(views, serverView(id), limit),
      [],
    );

  it("retains views in DOM order and evicts the least recently visited thread", () => {
    const views = visit(["a", "b", "c"]);
    const back = resolveKeptThreadViews(views, serverView("a"));
    expect(back.map((view) => view.key)).toEqual(views.map((view) => view.key));
    expect(resolveKeptThreadViews(back, serverView("d"), 3).map((view) => view.threadId)).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(resolveKeptThreadViews(back, serverView("a"))).toBe(back);
  });

  it("keeps promotion identity and drops a draft once left", () => {
    const draftId = DraftId.make("draft-1");
    const draft = resolveKeptThreadViews([], { ...serverView("t"), key: draftId, draftId });
    expect(resolveKeptThreadViews(draft, serverView("t"))[0]).toMatchObject({
      key: draftId,
      draftId: null,
    });
    expect(resolveKeptThreadViews(draft, serverView("a")).map((view) => view.threadId)).toEqual([
      "a",
    ]);
  });
});
