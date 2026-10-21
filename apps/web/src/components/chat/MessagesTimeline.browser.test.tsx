import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, useRef, useState, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import { useTimelineFollow } from "./useTimelineFollow";
import type { ChatComposerHandle } from "./ChatComposer";
import { remarkThoughtPreview } from "./TimelineWorkEntryRow.logic";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";

const pullRequestQuery = vi.hoisted(() => ({ error: "Pull request not found" }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: pullRequestQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function FollowHarness({ entries, loading }: { entries: Entry[]; loading: boolean }) {
  const listRef = useRef<LegendListRef | null>(null);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const [routeThreadKey] = useState(() => baseProps().routeThreadKey);
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerRef,
    composerOverlayElement: null,
    composerTimelineInset: 0,
    routeThreadKey,
    activeThreadKey: routeThreadKey,
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: null,
    activeRunningTurnId: null,
    timelineEntries: entries,
    timelineAnchorMessageId: null,
    setTimelineAnchor: () => {},
  });
  return (
    <div
      data-live-follow={String(follow.timelineLiveFollowEnabled)}
      style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <MessagesTimeline
        {...baseProps()}
        listRef={listRef}
        routeThreadKey={routeThreadKey}
        timelineEntries={loading ? [] : entries}
        hideEmptyPlaceholder={loading}
        liveFollowEnabled={follow.timelineLiveFollowEnabled}
        onIsAtEndChange={follow.onIsAtEndChangeStable}
        onManualNavigation={follow.cancelTimelineLiveFollowForUserNavigationStable}
        onScrollNodeChange={follow.setTimelineScrollNode}
      />
    </div>
  );
}

describe("MessagesTimeline messages", () => {
  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });
});

describe("timeline live follow", () => {
  it("lets a wheel up break follow when the list mounts after a slow hydration", async () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      message(`Paragraph ${index}\n\n${"lorem ipsum ".repeat(60)}`, {}, `message-${index}`),
    );
    const container = document.createElement("div");
    container.style.cssText =
      "height: 1200px; width: 900px; display: flex; flex-direction: column;";
    let screen: Awaited<ReturnType<typeof render>>;
    {
      // Hydration can outlast any fixed frame budget before the list mounts.
      using _timers = fakeTimers();
      screen = await render(<FollowHarness entries={entries} loading />, { container });
      expect(container.querySelector(".messages-timeline-scroll")).toBeNull();
      await act(async () => vi.advanceTimersByTime(16 * 20));
    }
    await using _screen = screen;
    await screen.rerender(<FollowHarness entries={entries} loading={false} />);
    const scrollNode = container.querySelector<HTMLElement>(".messages-timeline-scroll");
    if (!scrollNode) throw new Error("Timeline did not mount");
    await expect.poll(() => scrollNode.scrollHeight > scrollNode.clientHeight).toBe(true);
    const follow = () => container.firstElementChild?.getAttribute("data-live-follow");
    expect(follow()).toBe("true");
    const row = scrollNode.querySelector<HTMLElement>("[data-timeline-root]");
    if (!row) throw new Error("No timeline row");
    // LegendList measures its viewport a frame after mount; retry until the gate sees overflow.
    await vi.waitFor(async () => {
      await act(async () => {
        row.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      });
      expect(follow()).toBe("false");
    });
  });
});

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});
