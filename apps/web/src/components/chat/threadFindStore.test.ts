import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  attachThreadFindTimeline,
  closeThreadFind,
  findForMessageMatch,
  openThreadFind,
  openThreadFindOnQuery,
  retainThreadFindForThread,
  setThreadFindQuery,
  useThreadFindStore,
} from "./threadFindStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const otherRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-2"));
const threadKey = "env-1:thread-1";

function setup() {
  closeThreadFind();
  const navigate = vi.fn();
  const readPosition = vi.fn(() => ({ entryId: "entry-9", occurrence: 1 }));
  return { navigate, readPosition, timeline: { threadKey, navigate, readPosition } };
}

describe("thread find store", () => {
  it("navigates the timeline once when find opens, and restarts a query from the viewport", () => {
    const { navigate, readPosition, timeline } = setup();
    const detach = attachThreadFindTimeline(timeline);
    openThreadFind(threadKey);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey, focusRequestId: 1 });

    setThreadFindQuery(threadKey, " needle ");
    expect(readPosition).toHaveBeenLastCalledWith("needle");
    // Opening again refocuses and restarts the search from where the viewport is.
    openThreadFind(threadKey);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(useThreadFindStore.getState()).toMatchObject({
      query: " needle ",
      focusRequestId: 2,
      start: { entryId: "entry-9", occurrence: 1 },
      navigationId: 2,
      requestId: 2,
    });
    detach?.();
  });

  it("leaves a timeline that is not showing the thread alone when a search result opens find", () => {
    const { navigate, timeline } = setup();
    const detach = attachThreadFindTimeline({ ...timeline, threadKey: "env-1:thread-2" });
    openThreadFindOnQuery(threadKey, { query: "Café", start: { entryId: "m", occurrence: 0 } });
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey, query: "Café" });
    expect(navigate).not.toHaveBeenCalled();
    detach?.();
    // Attaching does not navigate; the timeline releases follow as it starts showing the thread.
    attachThreadFindTimeline(timeline)?.();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("closes find once the route leaves its thread", () => {
    setup();
    openThreadFindOnQuery(threadKey, { query: "x" });
    retainThreadFindForThread(threadRef);
    expect(useThreadFindStore.getState().threadKey).toBe(threadKey);
    retainThreadFindForThread(otherRef);
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey: null, query: "" });
  });
});

describe("findForMessageMatch", () => {
  it("opens find on the longest word as the snippet writes it, at the matched message", () => {
    expect(
      findForMessageMatch(
        { snippet: "The cafeteria, then the Café", messageId: MessageId.make("message-1") },
        "cafe",
      ),
    ).toEqual({ query: "Café", start: { entryId: "message-1", occurrence: 0 } });
    expect(findForMessageMatch({ snippet: "fix the sidebar lag" }, "fix sidebar")).toEqual({
      query: "sidebar",
    });
    // The whole query, when the snippet holds it as typed.
    expect(findForMessageMatch({ snippet: "then Vp  run dev again" }, "vp run dev")).toEqual({
      query: "Vp  run dev",
    });
  });
});
