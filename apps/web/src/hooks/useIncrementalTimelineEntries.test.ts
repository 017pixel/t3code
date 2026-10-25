import { MessageId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../session-logic";
import {
  peekLastReadyThreadTimeline,
  peekReadyThreadTimeline,
  rememberReadyThreadTimeline,
  resetReadyThreadTimelines,
} from "./useIncrementalTimelineEntries";

function messageEntry(id: string, previewUrl?: string): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: "2026-09-10T12:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role: "user",
      text: id,
      runId: null,
      streaming: false,
      createdAt: "2026-09-10T12:00:00.000Z",
      updatedAt: "2026-09-10T12:00:00.000Z",
      ...(previewUrl
        ? {
            attachments: [
              {
                type: "image" as const,
                id: `${id}-image`,
                name: "preview.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl,
              },
            ],
          }
        : {}),
    },
  };
}

const context = { markdownCwd: "/repo", workspaceRoot: "/repo" };

describe("ready thread timelines", () => {
  afterEach(() => resetReadyThreadTimelines());

  it("remembers each thread's timeline and tracks the latest one", () => {
    const a = [messageEntry("a1")];
    const b = [messageEntry("b1")];
    rememberReadyThreadTimeline("env-1:thread-a", a, context);
    rememberReadyThreadTimeline("env-1:thread-b", b, { markdownCwd: "/b", workspaceRoot: null });
    expect(peekReadyThreadTimeline("env-1:thread-a")).toBe(a);
    expect(peekLastReadyThreadTimeline()).toEqual({
      threadKey: "env-1:thread-b",
      entries: b,
      markdownCwd: "/b",
      workspaceRoot: null,
    });
    rememberReadyThreadTimeline("env-1:thread-a", a, context);
    expect(peekLastReadyThreadTimeline()?.threadKey).toBe("env-1:thread-a");
  });

  it("skips empty timelines and ones with blob previews", () => {
    const ready = [messageEntry("a1")];
    rememberReadyThreadTimeline("env-1:thread-a", ready, context);
    rememberReadyThreadTimeline("env-1:thread-a", [], context);
    rememberReadyThreadTimeline("env-1:thread-a", [messageEntry("a2", "blob:handoff")], context);
    expect(peekReadyThreadTimeline("env-1:thread-a")).toBe(ready);
  });

  it("evicts the least recently ready thread past the limit", () => {
    for (let index = 0; index < 17; index += 1) {
      rememberReadyThreadTimeline(`env-1:thread-${index}`, [messageEntry(`m${index}`)], context);
    }
    expect(peekReadyThreadTimeline("env-1:thread-0")).toBeNull();
    expect(peekReadyThreadTimeline("env-1:thread-1")).not.toBeNull();
    expect(peekReadyThreadTimeline("env-1:thread-16")).not.toBeNull();
  });
});
