import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
export { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { isLiveSubagentTurnItem } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  mergeResponseGroupCheckpoints,
  messageStartsResponseGroup,
  responseGroupFoldLabel,
  responseGroupKey,
} from "@t3tools/client-runtime/state/response-groups";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import {
  assistantCitationLabel,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { shallow } from "zustand/vanilla/shallow";
import { claudeResumeCompactionAge } from "@t3tools/shared/claudeCompaction";
import {
  IDLE_COMPACTING_LABELS,
  IDLE_COMPACTION_TITLES,
} from "@t3tools/client-runtime/user-message";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import { renderCodexDirectivesForCopy } from "@t3tools/shared/codexMarkdownDirectives";
import {
  commandDisplayText,
  commandProgramName,
} from "@t3tools/client-runtime/work-log/command-label";
import {
  liveActivityToolStatus,
  normalizeCompactToolLabel,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  contextCompactionTokenCounts,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
export { toolGroupAction } from "@t3tools/client-runtime/work-log/presentation";
import {
  deriveRevertTurnCountByUserMessageId,
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  timelineEntryIsPersistentResourceCard,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  type ChatMessage,
  type ProposedPlan,
  type ThreadShell,
  type TurnDiffSummary,
} from "../../types";
import {
  idleCompactionOf,
  isCompactionCommandMessage,
  type MessageId,
  type OrchestrationV2IdleCompaction,
  type WorktreeSetupSnapshot,
  type OrchestrationV2ProjectedTurnItem,
  type RunAttemptId,
  RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/shell";
import {
  resolveT3McpToolDefinition,
  type T3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import { htmlRenderReferencesEqual, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { mcpAppReferencesEqual, type McpAppReference } from "@t3tools/shared/mcpApp";
import { dynamicToolTitle } from "@t3tools/shared/toolActivity";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  collectToolFilePaths,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

function timelineEntryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.runId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.runId;
  }
  if (entry.kind === "html-render" || entry.kind === "mcp-app") return entry.runId;
  return entry.kind === "work" ? (entry.entry.runId ?? null) : null;
}

function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

function singleToolCallLabel(entry: WorkLogEntry): string {
  if (entry.itemType === "reasoning") return entry.detail?.trim().replace(/\s+/g, " ") || "Thought";
  const toolPresentation = resolveWorkEntryToolPresentation(entry, "completed");
  if (toolPresentation) return toolPresentation.displayName;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input, item.title) : null;
  if (title) return title;
  if (entry.itemType === "web_search") return entry.toolTitle ?? "Web search";
  return workEntryDisplayLabel(entry, undefined);
}

function workEntryToolDataRecord(entry: WorkLogEntry): Record<string, unknown> | undefined {
  return entry.toolData !== null &&
    typeof entry.toolData === "object" &&
    !Array.isArray(entry.toolData)
    ? (entry.toolData as Record<string, unknown>)
    : undefined;
}

function workEntryReadRawPaths(entry: WorkLogEntry): readonly string[] {
  const fromChanged = entry.changedFiles ?? [];
  if (fromChanged.length > 0) return fromChanged;
  const structured = entry.structuredPayload;
  if (structured?.type === "dynamic_tool") {
    const structuredPaths = collectToolFilePaths({ input: structured.input });
    if (structuredPaths.length > 0) return structuredPaths;
  }
  return collectToolFilePaths(workEntryToolDataRecord(entry));
}

function workEntryReadPaths(entry: WorkLogEntry, workspaceRoot: string | undefined): string[] {
  return workEntryReadRawPaths(entry).map((filePath) =>
    formatWorkspaceRelativePath(filePath, workspaceRoot),
  );
}

export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot: string | undefined) {
  if (entry.itemType === "system_notice") return entry.label;
  if (entry.itemType === "reasoning" || entry.tone === "thinking") {
    const thought = entry.detail?.trim().replace(/\s+/g, " ");
    return thought || entry.label;
  }
  const toolPresentation = resolveWorkEntryToolPresentation(entry);
  if (toolPresentation) return toolPresentation.displayName;
  if (entry.command?.trim()) return commandDisplayText(entry.command);
  const action = toolGroupAction(entry);
  if (action === "code-search" || action === "search") {
    const searchLabel =
      entry.itemType === "file_search"
        ? entry.label
        : formatSearchToolLabel(workEntryToolDataRecord(entry));
    if (searchLabel) return searchLabel;
  }
  const readPaths = action === "read" ? workEntryReadPaths(entry, workspaceRoot) : [];
  if (action === "read" && readPaths[0]) {
    return formatReadToolLabel(readPaths[0], readPaths.length - 1);
  }
  const providerRetry =
    entry.projectedItem?.item.type === "error" && entry.projectedItem.item.retry !== undefined;
  const item = entry.structuredPayload;
  const title =
    item?.type === "dynamic_tool" ? dynamicToolTitle(item.toolName, item.input, item.title) : null;
  if (title) return title;
  const compactDetail = entry.detail?.trim();
  const detailIsSearchOutput =
    (action === "code-search" || action === "search") && /[\r\n]/.test(compactDetail ?? "");
  if (compactDetail && !providerRetry && action !== "read" && !detailIsSearchOutput) {
    return compactDetail;
  }
  const [firstPath] = entry.changedFiles ?? [];
  if (firstPath) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return entry.changedFiles!.length === 1
      ? path
      : `${path} +${entry.changedFiles!.length - 1} more`;
  }
  if (action === "read" && !entry.viewedImagePath) {
    return "Read file";
  }
  const heading = normalizeCompactToolLabel(entry.toolTitle || entry.label);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

export function threadReadTargetId(entry: Pick<WorkLogEntry, "structuredPayload">) {
  const item = entry.structuredPayload;
  if (item?.type !== "dynamic_tool") return null;
  if (resolveT3McpToolDefinition(item.toolName)?.summaryAction !== "thread-read") return null;
  const input = item.input;
  const threadId =
    input !== null && typeof input === "object" && "threadId" in input ? input.threadId : null;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId.trim() : null;
}

const THREAD_READ_OBJECT = " a T3 thread";

export function threadReadTargetTitle(
  shell: Pick<ThreadShell, "title" | "archivedAt" | "deletedAt"> | null,
) {
  if (!shell || shell.archivedAt !== null || shell.deletedAt !== null) return null;
  return shell.title.trim() || null;
}

export function threadReadLabelPrefix(label: string) {
  return label.endsWith(THREAD_READ_OBJECT)
    ? `${label.slice(0, -THREAD_READ_OBJECT.length)} thread`
    : null;
}

export function workEntryReadOutput(
  entry: Pick<
    WorkLogEntry,
    "changedFiles" | "detail" | "viewedImagePath" | "structuredPayload" | "toolData"
  >,
  workspaceRoot: string | undefined,
): string | null {
  const paths = [
    ...new Set(
      workEntryReadRawPaths(entry as WorkLogEntry)
        .map((path) => {
          const trimmed = path.trim().replaceAll("\\", "/");
          if (!workspaceRoot || trimmed.startsWith("/") || isWindowsAbsolutePath(trimmed)) {
            return trimmed;
          }
          const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
          const relative = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
          return `${root}/${relative}`;
        })
        .filter((path) => path.length > 0),
    ),
  ];
  if (paths.length > 0) {
    return paths.join("\n");
  }
  return null;
}

export function liveWorkEntryLabel(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
  active: boolean,
) {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  if (entry.itemType === "reasoning") {
    return (
      entry.detail?.trim().replace(/\s+/g, " ") ||
      (status === "inProgress" ? "Thinking" : "Thought")
    );
  }
  const toolPresentation = resolveWorkEntryToolPresentation({
    ...entry,
    toolLifecycleStatus: status,
  });
  if (toolPresentation) return toolPresentation.displayName;
  const command = entry.command?.trim();
  if (command) {
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : status === "stopped"
              ? "Stopped"
              : "Ran";
    return `${verb} ${commandProgramName(command) ?? "command"}`;
  }
  return workEntryDisplayLabel(entry, workspaceRoot);
}

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  if (entry.itemType === "reasoning") return Boolean(entry.detail?.trim());
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    entry.toolLifecycleStatus === "stopped" ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}
const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export interface WorkGroupScrollAnchor {
  readonly entryId: string;
  readonly offset: number;
}

export function resolveWorkGroupScrollIndex(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: WorkGroupScrollAnchor | undefined,
): { index: number; viewOffset: number } | undefined {
  if (!anchor) return undefined;
  const index = entries.findIndex((entry) => entry.id === anchor.entryId);
  return index < 0 ? undefined : { index, viewOffset: -anchor.offset };
}

export function shouldFollowWorkGroupAppend(
  previous: ReadonlyArray<{ readonly id: string }>,
  entries: ReadonlyArray<{ readonly id: string }>,
  distanceFromEnd: number,
): boolean {
  return (
    previous.length > 0 &&
    entries.length > previous.length &&
    distanceFromEnd <= 1 &&
    previous.every((entry, index) => entry.id === entries[index]?.id)
  );
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly isNearEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

// Streaming can briefly unset isAtEnd; re-arm near the content bottom.
const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: TimelineEndState | undefined): boolean | undefined {
  if (!state) {
    return undefined;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // LegendList double-subtracts the composer inset, so its isAtEnd is only a fallback.
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

/** Recheck the rendered buffer: LegendList's unbuffered range can lag during scrolling. */
export function resolveTimelineMinimapVisibleRange(state: {
  readonly startBuffered: number | null | undefined;
  readonly endBuffered: number | null | undefined;
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}) {
  let start: number | null = null;
  let end: number | null = null;
  if (state.startBuffered == null || state.endBuffered == null || state.startBuffered < 0) {
    return { start, end };
  }
  const bottom = state.scroll + state.scrollLength;
  for (let index = state.startBuffered; index <= state.endBuffered; index += 1) {
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
      top != null &&
      Number.isFinite(top) &&
      top < bottom &&
      top + Math.max(1, height != null && Number.isFinite(height) ? height : 1) > state.scroll
    ) {
      start ??= index;
      end = index;
    }
  }
  return { start, end };
}

export function isTimelineMinimapRowVisible(
  rowIndex: number,
  visibleStart: number | null | undefined,
  visibleEnd: number | null | undefined,
): boolean {
  return (
    visibleStart != null && visibleEnd != null && rowIndex >= visibleStart && rowIndex <= visibleEnd
  );
}

export function resolveTimelineMinimapCurrentIndex(input: {
  readonly visibleStart: number | null | undefined;
  readonly visibleEnd: number | null | undefined;
  readonly rowIndices: ReadonlyArray<number>;
}): number | null {
  if (input.visibleStart == null || input.visibleEnd == null) {
    return null;
  }
  let precedingIndex: number | null = null;
  for (const [index, rowIndex] of input.rowIndices.entries()) {
    if (rowIndex >= input.visibleStart) {
      // Prefer the first visible user message, otherwise the turn being read.
      return rowIndex <= input.visibleEnd ? index : precedingIndex;
    }
    precedingIndex = index;
  }
  return precedingIndex;
}

function resolveTimelineSideGutter(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(contentWidth)) {
    return 0;
  }
  return Math.max(0, (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2);
}

export function resolveTimelineMinimapHasPersistentGutter(
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    resolveTimelineSideGutter(viewportWidth, contentWidth) >= TIMELINE_MINIMAP_PERSISTENT_GUTTER
  );
}

const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

export function resolveTimelineMinimapHitStripWidth(
  viewportWidth: number,
  contentWidth: number,
): number {
  const sideGutter = resolveTimelineSideGutter(viewportWidth, contentWidth);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

const TIMELINE_MINIMAP_NAVIGATION_REACH = 14;

export function resolveTimelineMinimapNavigationInteractive(collapsedWidth: number): boolean {
  return collapsedWidth >= TIMELINE_MINIMAP_NAVIGATION_REACH;
}

export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestRun = Pick<
  ThreadRunSummary,
  "runId" | "status" | "startedAt" | "completedAt" | "turnEnded"
>;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export type MessagesTimelineRow = MessagesTimelineRowContent & {
  readonly continuesWorkLog?: boolean;
};

type MessagesTimelineRowContent =
  | {
      kind: "worktree-setup";
      id: string;
      createdAt: string | null;
      snapshot: WorktreeSetupSnapshot;
      embedded: boolean;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroup: boolean;
      displayLabel?: string;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
      thought?: WorkLogEntry;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
      /** A running compaction owns the working row, so its divider appears only once it ends. */
      compacting?: string;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string | null;
      groupId?: string;
      expanded?: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      runId?: RunId | null;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      toolSurface?: WorkLogEntry["toolSurface"];
      toolIcon?: WorkLogEntry["toolIcon"];
      summaryToolIcon?: "browser" | "device" | "t3-code" | "pull-request";
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      /** Toggling the row opens or closes all of these. */
      foldKeys: ReadonlyArray<RunId>;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "attempt-fold";
      id: string;
      createdAt: string;
      runId: RunId;
      attemptId: RunAttemptId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      label: string;
      tokenCounts: ReturnType<typeof contextCompactionTokenCounts>;
      active: boolean;
      /** Replaces "Context compacted" when T3 Code compacted without being asked. */
      title?: string;
      failed?: true;
      /** The provider's reason, when a failed compaction gave one. */
      failure?: string;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      durationStart: string;
      showAssistantMeta: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "assistant-meta";
      projectedItem?: OrchestrationV2ProjectedTurnItem;
      id: string;
      createdAt: string;
      message: ChatMessage;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
    }
  | {
      kind: "event";
      id: string;
      createdAt: string;
      projectedItem: OrchestrationV2ProjectedTurnItem;
      subagents?: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      resourceSummary?: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      htmlRender: HtmlRenderReference;
    }
  | {
      kind: "mcp-app";
      id: string;
      createdAt: string;
      sourceThreadId: ThreadId;
      itemId: TurnItemId;
      revision: string;
      mcpApp: McpAppReference;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

function workGroupId(timelineEntryId: string): string {
  return `work-group:${timelineEntryId}`;
}

export type TimelineToolPresentation = T3McpToolPresentation;

function expandedWorkGroupRow(
  groupId: string,
  createdAt: string,
  groupedEntries: WorkLogEntry[],
): Extract<MessagesTimelineRow, { kind: "work" }> {
  return {
    kind: "work",
    id: `${groupId}:details`,
    createdAt,
    groupedEntries,
    isExpandedToolGroup: true,
  };
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? (visible ? renderCodexDirectivesForCopy(text) : text) : null,
    visible,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.runId
      ? `turn:${message.runId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface SupersededAttemptFold {
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly anchorEntryId: string;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
}

// Interrupted streams can be `completed`; only the attempt's last output proves completion.
function completeSupersededReplyEntryIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlySet<string> {
  const lastOutputByAttemptId = new Map<RunAttemptId, TimelineEntry>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      (entry.kind === "message" && entry.message.role === "user") ||
      (entry.kind === "work" &&
        (entry.entry.itemType === "system_notice" || entry.entry.itemType === "notification")) ||
      (entry.kind !== "message" && entry.kind !== "work")
    ) {
      continue;
    }
    lastOutputByAttemptId.set(entry.attempt.id, entry);
  }
  const replyEntryIds = new Set<string>();
  for (const entry of lastOutputByAttemptId.values()) {
    const supersededAt = entry.attempt?.completedAt ?? null;
    const item = entry.kind === "message" ? entry.projectedItem?.item : undefined;
    if (
      entry.kind === "message" &&
      !entry.message.streaming &&
      item?.type === "assistant_message" &&
      item.status === "completed" &&
      item.completedAt !== null &&
      supersededAt !== null &&
      DateTime.isLessThan(item.completedAt, supersededAt)
    ) {
      replyEntryIds.add(entry.id);
    }
  }
  return replyEntryIds;
}

function deriveSupersededAttemptFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  unfoldedRunIds: ReadonlySet<RunId>,
  liveSubagentEntryIds: ReadonlySet<string>,
  completeReplyEntryIds: ReadonlySet<string>,
): ReadonlyMap<string, SupersededAttemptFold> {
  const completeAttemptIds = new Set(
    timelineEntries.flatMap((entry) =>
      entry.attempt !== undefined && completeReplyEntryIds.has(entry.id) ? [entry.attempt.id] : [],
    ),
  );
  const entriesByAttemptId = new Map<RunAttemptId, TimelineEntry[]>();
  for (const entry of timelineEntries) {
    if (
      entry.attempt?.status !== "superseded" ||
      completeAttemptIds.has(entry.attempt.id) ||
      unfoldedRunIds.has(entry.attempt.runId) ||
      (entry.kind === "message" && entry.message.role === "user") ||
      entry.kind === "html-render" ||
      entry.kind === "mcp-app" ||
      timelineEntryIsPersistentResourceCard(entry) ||
      liveSubagentEntryIds.has(entry.id) ||
      (entry.kind === "work" && entry.entry.itemType === "system_notice")
    ) {
      continue;
    }
    const entries = entriesByAttemptId.get(entry.attempt.id) ?? [];
    entries.push(entry);
    entriesByAttemptId.set(entry.attempt.id, entries);
  }

  const foldsByAnchorEntryId = new Map<string, SupersededAttemptFold>();
  for (const entries of entriesByAttemptId.values()) {
    const firstEntry = entries[0];
    const attempt = firstEntry?.attempt;
    if (firstEntry === undefined || attempt === undefined) continue;
    foldsByAnchorEntryId.set(firstEntry.id, {
      runId: attempt.runId,
      attemptId: attempt.id,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds: new Set(entries.map((entry) => entry.id)),
    });
  }
  return foldsByAnchorEntryId;
}

// After send, the previous turn stays active until the server creates its replacement.
function deriveUnsettledRunId(
  latestRun: TimelineLatestRun | null,
  runningRunId: RunId | null = null,
): RunId | null {
  if (runningRunId !== null) return runningRunId;
  if (!latestRun) {
    return null;
  }
  const isSettled =
    latestRun.completedAt !== null &&
    latestRun.status !== "running" &&
    latestRun.status !== "starting" &&
    latestRun.status !== "waiting";
  return isSettled ? null : latestRun.runId;
}

// Children can outlive their launching turn; keep cards visible while the footer counts them.
function liveSubagentCardEntryIds(entries: ReadonlyArray<TimelineEntry>): ReadonlySet<string> {
  const visible = new Set<string>();
  let batch: Array<Extract<TimelineEntry, { kind: "event" }>> = [];
  const flush = () => {
    if (batch.length === 0) return;
    if (batch.some((entry) => isLiveSubagentTurnItem(entry.projectedItem.item))) {
      for (const entry of batch) visible.add(entry.id);
    }
    batch = [];
  };
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") {
      flush();
      continue;
    }
    const item = entry.projectedItem.item;
    const previous = batch.at(-1)?.projectedItem.item;
    if (
      previous !== undefined &&
      (previous.runId !== item.runId || previous.providerTurnId !== item.providerTurnId)
    ) {
      flush();
    }
    batch.push(entry);
  }
  flush();
  return visible;
}

function timelineEntryFoldRunId(entry: TimelineEntry, runlessKey: RunId | null): RunId | null {
  if (entry.kind === "work" && entry.entry.itemType === "system_notice") return null;
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.runId ?? runlessKey;
  }
  if (entry.kind === "work") {
    return entry.entry.runId ?? runlessKey;
  }
  if (
    entry.kind === "event" &&
    (timelineEntryIsPersistentResourceCard(entry) || entry.projectedItem.item.type === "subagent")
  ) {
    return entry.projectedItem.item.runId ?? runlessKey;
  }
  return null;
}

function timelineEntryIsSteer(entry: TimelineEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "user" &&
    (entry.message.inputIntent === "steer" ||
      entry.message.inputIntent === "promoted_queued_to_steer")
  );
}

function timelineEntryStartsResponse(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" && entry.message.role === "user" && !timelineEntryIsSteer(entry)) ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

function timelineEntryEnd(entry: TimelineEntry): string {
  return entry.kind === "message" ? entry.message.updatedAt : entry.createdAt;
}

function timelineEntryIsCompaction(entry: TimelineEntry): boolean {
  return entry.kind === "work" && entry.entry.sourceActivityKind === "context-compaction";
}

function responseBoundaryRunId(entry: TimelineEntry): RunId | null {
  if (entry.kind === "message") return entry.message.runId ?? null;
  if (entry.kind === "work") return entry.entry.runId ?? null;
  return null;
}

// Group promptless restarts under the initiating prompt until settled.
function lastResponseBoundaryIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(timelineEntryStartsResponse);
}

function deriveActiveVisualResponseRunIds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  unsettledRunId: RunId | null;
  isWorking: boolean;
}): ReadonlySet<RunId> {
  const runIds = new Set<RunId>();
  if (input.unsettledRunId === null) {
    return runIds;
  }

  runIds.add(input.unsettledRunId);
  if (!input.isWorking) {
    return runIds;
  }

  const latestResponseBoundaryIndex = lastResponseBoundaryIndex(input.timelineEntries);
  for (
    let index = latestResponseBoundaryIndex + 1;
    index < input.timelineEntries.length;
    index += 1
  ) {
    const runId = timelineEntryRunId(input.timelineEntries[index]!);
    if (runId !== null) {
      runIds.add(runId);
    }
  }
  return runIds;
}

function timelineEntryFailedItem(entry: TimelineEntry) {
  const item =
    entry.kind === "event"
      ? entry.projectedItem.item
      : entry.kind === "work"
        ? entry.entry.projectedItem?.item
        : null;
  return item?.type === "error" && item.status === "failed" && item.parentItemId === null
    ? item
    : null;
}

function failedTimelineRunIds(
  entries: ReadonlyArray<TimelineEntry>,
  latestRun: TimelineLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of entries) {
    const runId = timelineEntryFailedItem(entry)?.runId;
    if (runId) failed.add(runId);
  }
  return failed;
}

interface TurnFold {
  /** The segment's own key: its run id, a runless prompt key, or a post-steer key. */
  runId: RunId;
  /** Any of these keys opens the fold. A response's only segment also answers to its group key. */
  foldKeys: ReadonlyArray<RunId>;
  /** Set when a multi-segment response group owns this fold; its collapsed row hides this one. */
  groupKey: RunId | null;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  /** Every entry in the segment, including the cards a fold never hides. */
  entryIds: ReadonlySet<string>;
  label: string;
}

/**
 * One row for every run from a prompt to the latest answer, so the background
 * wakes of a long `/goal` thread fold away together. Expanded, it shows the
 * per-run folds as before.
 */
interface ResponseGroupFold {
  key: RunId;
  anchorEntryId: string;
  createdAt: string;
  /** Hidden while collapsed: earlier runs and their notifications. */
  hiddenEntryIds: ReadonlySet<string>;
  /**
   * The latest run's own fold also hides under a collapsed group, unless it was
   * opened on its own (an interrupt keeps the stopped run open).
   */
  trailingFold: TurnFold | null;
  label: string;
  /** The answer that stays visible; its changed-files card covers the whole group. */
  finalMessageId: MessageId | null;
  /** Runs whose checkpoint belongs here. A steer-split run's belongs to the later group. */
  checkpointRunIds: ReadonlyArray<RunId>;
  /** Stopped or failed runs: the group's diff cannot end at their checkpoint. */
  unfinishedRunIds: ReadonlySet<RunId>;
}

interface TimelineFolds {
  turnFolds: ReadonlyMap<string, TurnFold>;
  groupFolds: ReadonlyMap<string, ResponseGroupFold>;
}

const PARTIAL_GROUP_PREFIX = "group:partial:";

function timelineEntryAlwaysVisibleInFold(
  entry: TimelineEntry,
  input: {
    liveSubagentEntryIds: ReadonlySet<string>;
    completeSupersededReplyEntryIds: ReadonlySet<string>;
  },
): boolean {
  return (
    timelineEntryIsCompaction(entry) ||
    timelineEntryIsPersistentResourceCard(entry) ||
    input.liveSubagentEntryIds.has(entry.id) ||
    input.completeSupersededReplyEntryIds.has(entry.id) ||
    // User input stays visible after the surrounding work settles.
    (entry.kind === "work" && entry.entry.questionAnswer !== undefined)
  );
}

function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun: TimelineLatestRun | null;
  activeRunIds: ReadonlySet<RunId>;
  failedRunIds: ReadonlySet<RunId>;
  runlessWorkActive: boolean;
  liveSubagentEntryIds: ReadonlySet<string>;
  completeSupersededReplyEntryIds: ReadonlySet<string>;
}): TimelineFolds {
  const interruptedRunIds = new Set<RunId>();
  const promptIndexByRunId = new Map<RunId, number>();
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const runId = responseBoundaryRunId(entry);
      if (runId !== null && !promptIndexByRunId.has(runId)) promptIndexByRunId.set(runId, index);
    }
    if (
      entry.kind === "event" &&
      entry.projectedItem.item.runId !== null &&
      (entry.projectedItem.item.type === "run_interrupt_request" ||
        entry.projectedItem.item.type === "run_interrupt_result")
    ) {
      interruptedRunIds.add(entry.projectedItem.item.runId);
    }
  }

  interface Segment {
    key: RunId;
    runId: RunId;
    entries: ReadonlyArray<TimelineEntry>;
    firstIndex: number;
    startedAt: string;
    anchorEntryId: string;
    /** The wake notification that started this run, when one did. */
    notificationEntryId: string | null;
    lastOfRun: boolean;
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    /** Never folds: live, streaming, failed, or interrupted. */
    unfolded: boolean;
    live: boolean;
    fold: TurnFold | null;
  }
  interface Response {
    key: RunId;
    /** Null when the history window opens after the prompt. */
    startedAt: string | null;
    segments: Segment[];
  }
  interface TurnGroup {
    entries: Array<TimelineEntry>;
    indexes: Array<number>;
    /**
     * Entry timestamps alone undercount the duration (the first entry appears
     * only once the provider starts producing output).
     */
    startBoundary: string | null;
    anchorEntryId: string;
    notificationEntryId: string | null;
    response: Response | null;
    /**
     * Each steer after the turn has produced output starts a new segment, and
     * a new response, at this index into `entries`.
     */
    steerSegments: Array<{ startIndex: number; steer: TimelineEntry; response: Response }>;
  }
  const groupsByRunId = new Map<RunId, TurnGroup>();
  const runlessFailedKeys = new Set<RunId>();
  const responses: Response[] = [];
  const openResponse = (entry: TimelineEntry): Response => {
    const response = {
      key: RunId.make(responseGroupKey(entry.id)),
      startedAt: entry.createdAt,
      segments: [],
    };
    responses.push(response);
    return response;
  };
  let firstPromptIndex: number | null = null;
  let partialResponse: Response | null = null;
  const openPartialResponse = (segment: { key: RunId }): Response => {
    const partial = {
      key: RunId.make(`${PARTIAL_GROUP_PREFIX}${segment.key}`),
      startedAt: null,
      segments: [],
    };
    responses.unshift(partial);
    return partial;
  };

  // Key runless responses per prompt to prevent V2 runs unfolding imported turns.
  let runlessKey: RunId | null = null;
  let responseKey: RunId | null = null;
  let response: Response | null = null;
  let pendingBoundary: {
    createdAt: string;
    anchorEntryId: string;
    notificationEntryId: string | null;
  } | null = null;
  for (const [index, entry] of input.timelineEntries.entries()) {
    if (timelineEntryStartsResponse(entry)) {
      const nextEntry = input.timelineEntries[index + 1];
      pendingBoundary = nextEntry
        ? {
            createdAt: entry.createdAt,
            anchorEntryId: nextEntry.id,
            notificationEntryId: entry.kind === "work" ? entry.id : null,
          }
        : null;
      const boundaryRunId = responseBoundaryRunId(entry);
      runlessKey = boundaryRunId == null ? RunId.make(`runless:${entry.id}`) : null;
      responseKey = boundaryRunId ?? runlessKey;
      if (entry.kind === "message" && messageStartsResponseGroup(entry.message)) {
        response = openResponse(entry);
        firstPromptIndex ??= index;
      }
      continue;
    }
    if (entry.kind === "message" && timelineEntryIsSteer(entry)) {
      const steerRunId = entry.message.runId ?? responseKey;
      const group = steerRunId === null ? undefined : groupsByRunId.get(steerRunId);
      if (group !== undefined && group.entries.length > 0) {
        // Back-to-back steers split once, after the last of them.
        if (group.steerSegments.at(-1)?.startIndex === group.entries.length) {
          group.steerSegments.pop();
        }
        response = openResponse(entry);
        group.steerSegments.push({ startIndex: group.entries.length, steer: entry, response });
      }
      continue;
    }
    const ownRunId = timelineEntryFoldRunId(entry, runlessKey);
    if (!ownRunId) {
      continue;
    }
    // Resumed subagents keep their position and fold with their original turn.
    const runId =
      responseKey !== null && (promptIndexByRunId.get(ownRunId) ?? -1) > index
        ? responseKey
        : ownRunId;
    if (runId === runlessKey && timelineEntryFailedItem(entry) !== null) {
      runlessFailedKeys.add(runId);
    }
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = {
        entries: [],
        indexes: [],
        startBoundary: pendingBoundary?.createdAt ?? null,
        anchorEntryId: pendingBoundary?.anchorEntryId ?? entry.id,
        notificationEntryId: pendingBoundary?.notificationEntryId ?? null,
        response,
        steerSegments: [],
      };
      pendingBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    group.indexes.push(index);
  }

  const failedRunIds = new Set([...input.failedRunIds, ...runlessFailedKeys]);
  const segments: Segment[] = [];
  for (const [runId, group] of groupsByRunId) {
    const live = input.activeRunIds.has(runId) || (input.runlessWorkActive && runId === runlessKey);
    const runUnfolded = live || failedRunIds.has(runId) || interruptedRunIds.has(runId);
    const slices = [
      { startIndex: 0, steer: null, response: group.response },
      ...group.steerSegments,
    ];
    for (const [sliceIndex, slice] of slices.entries()) {
      const entries = group.entries.slice(slice.startIndex, slices[sliceIndex + 1]?.startIndex);
      const firstEntry = entries[0];
      if (firstEntry === undefined) continue;
      const streaming = entries.some(
        (entry) => entry.kind === "message" && entry.message.streaming,
      );
      const segment: Segment = {
        key: slice.steer === null ? runId : RunId.make(`${runId}:steer:${slice.steer.id}`),
        runId,
        entries,
        firstIndex: group.indexes[slice.startIndex] ?? 0,
        startedAt:
          slice.steer !== null
            ? slice.steer.createdAt
            : (group.startBoundary ??
              (input.latestRun?.runId === runId ? input.latestRun.startedAt : null) ??
              firstEntry.createdAt),
        anchorEntryId: slice.steer === null ? group.anchorEntryId : firstEntry.id,
        notificationEntryId: slice.steer === null ? group.notificationEntryId : null,
        lastOfRun: sliceIndex === slices.length - 1,
        // Late output from the attempt a steer replaced is not the new answer.
        terminalEntry:
          entries.findLast(
            (entry): entry is Extract<TimelineEntry, { kind: "message" }> =>
              entry.kind === "message" &&
              entry.message.role === "assistant" &&
              (slice.steer === null || entry.attempt?.status !== "superseded"),
          ) ?? null,
        unfolded: runUnfolded || streaming,
        live: live || streaming,
        fold: null,
      };
      segments.push(segment);
      // A history window can open mid-response, so runs before the first
      // loaded prompt fold together under a group with no known start.
      const owner =
        slice.response ??
        (segment.firstIndex < (firstPromptIndex ?? Infinity)
          ? (partialResponse ??= openPartialResponse(segment))
          : null);
      owner?.segments.push(segment);
    }
  }

  const segmentEnd = (segment: Segment): string => {
    if (
      segment.lastOfRun &&
      input.latestRun?.runId === segment.runId &&
      input.latestRun.completedAt
    ) {
      return input.latestRun.completedAt;
    }
    // A turn cut short by a steer leaves trailing work entries behind its
    // terminal message — take whichever ended last.
    const lastEntryEnd = timelineEntryEnd(segment.entries.at(-1)!);
    return (
      maxIsoTimestamp(segment.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ??
      lastEntryEnd
    );
  };
  const segmentStopped = (segment: Segment) =>
    segment.lastOfRun &&
    (interruptedRunIds.has(segment.runId) ||
      (input.latestRun?.runId === segment.runId && input.latestRun.status === "interrupted"));

  for (const segment of segments) {
    if (segment.unfolded) continue;
    const hiddenEntryIds = new Set<string>();
    let hidesNonCompactionWork = false;
    const terminalEntryIndex = segment.terminalEntry
      ? segment.entries.indexOf(segment.terminalEntry)
      : segment.entries.length;
    for (const [index, entry] of segment.entries.entries()) {
      if (entry === segment.terminalEntry) continue;
      const isCompaction = timelineEntryIsCompaction(entry);
      const isFoldableTrailingActivity =
        entry.kind === "work" &&
        entry.entry.toolLifecycleStatus !== "inProgress" &&
        !workEntryDisplayIndicatesToolFailure(entry.entry);
      if (!isCompaction && index > terminalEntryIndex && !isFoldableTrailingActivity) continue;
      if (timelineEntryAlwaysVisibleInFold(entry, input)) continue;
      hiddenEntryIds.add(entry.id);
      hidesNonCompactionWork ||= !isCompaction;
    }
    if (!hidesNonCompactionWork) continue;
    segment.fold = {
      runId: segment.key,
      foldKeys: [segment.key],
      groupKey: null,
      anchorEntryId: segment.anchorEntryId,
      createdAt: segment.startedAt,
      hiddenEntryIds,
      entryIds: new Set(segment.entries.map((entry) => entry.id)),
      label: responseGroupFoldLabel({
        durationMs: computeElapsedMs(segment.startedAt, segmentEnd(segment)),
        updates: 0,
        failed: 0,
        stopped: segmentStopped(segment),
        live: false,
      }),
    };
  }

  const groupFolds = new Map<string, ResponseGroupFold>();
  for (const { key, startedAt, segments: members } of responses) {
    // A run that only left cards a fold never hides adds nothing to fold.
    const ordered = members
      .filter(
        (segment) =>
          segment.notificationEntryId !== null ||
          segment.entries.some((entry) => !timelineEntryAlwaysVisibleInFold(entry, input)),
      )
      .toSorted((left, right) => left.firstIndex - right.firstIndex);
    const last = ordered.at(-1);
    if (last === undefined) continue;
    const live = ordered.some((segment) => segment.live);
    const end = live ? null : ordered.map(segmentEnd).reduce(maxIsoTimestamp, null);
    const label = responseGroupFoldLabel({
      durationMs: end === null || startedAt === null ? null : computeElapsedMs(startedAt, end),
      updates: ordered.filter((segment) => segment.notificationEntryId !== null).length,
      failed: new Set(
        ordered
          .slice(0, -1)
          .filter(
            (segment) => failedRunIds.has(segment.runId) && !interruptedRunIds.has(segment.runId),
          )
          .map((segment) => segment.runId),
      ).size,
      stopped: segmentStopped(last),
      live,
    });
    if (ordered.length === 1) {
      // A lone run with no loaded prompt keeps its own timing.
      if (last.fold && startedAt !== null) {
        last.fold.label = label;
        last.fold.foldKeys = [last.key, key];
      }
      continue;
    }
    if (ordered.every((segment) => segment.live)) continue;

    const hiddenEntryIds = new Set<string>();
    for (const segment of ordered.slice(0, -1)) {
      if (segment.notificationEntryId !== null) hiddenEntryIds.add(segment.notificationEntryId);
      for (const entry of segment.entries) {
        if (!timelineEntryAlwaysVisibleInFold(entry, input)) hiddenEntryIds.add(entry.id);
      }
    }
    if (!last.unfolded && last.notificationEntryId !== null) {
      hiddenEntryIds.add(last.notificationEntryId);
    }
    // The newest settled answer stays, even when the latest wake only ran
    // tools. Output from an attempt a steer replaced counts only if complete.
    const finalEntry = ordered
      .filter((segment) => !segment.live)
      .flatMap((segment) => segment.entries)
      .findLast(
        (entry): entry is Extract<TimelineEntry, { kind: "message" }> =>
          entry.kind === "message" &&
          entry.message.role === "assistant" &&
          !entry.message.streaming &&
          (entry.attempt?.status !== "superseded" ||
            input.completeSupersededReplyEntryIds.has(entry.id)),
      );
    if (finalEntry) hiddenEntryIds.delete(finalEntry.id);
    const trailingFold = last.unfolded ? null : last.fold;
    if (hiddenEntryIds.size === 0 && trailingFold === null) continue;
    for (const segment of ordered) {
      if (segment.fold) segment.fold.groupKey = key;
    }
    const first = ordered[0]!;
    groupFolds.set(first.anchorEntryId, {
      key,
      anchorEntryId: first.anchorEntryId,
      createdAt: startedAt ?? first.startedAt,
      hiddenEntryIds,
      trailingFold,
      label,
      finalMessageId: finalEntry?.message.id ?? null,
      checkpointRunIds: ordered
        .filter((segment) => segment.lastOfRun)
        .map((segment) => segment.runId),
      unfinishedRunIds: new Set(
        ordered
          .map((segment) => segment.runId)
          .filter(
            (runId) =>
              failedRunIds.has(runId) ||
              interruptedRunIds.has(runId) ||
              (input.latestRun?.runId === runId && input.latestRun.status !== "completed"),
          ),
      ),
    });
  }

  const turnFolds = new Map<string, TurnFold>();
  for (const segment of segments) {
    if (segment.fold) turnFolds.set(segment.anchorEntryId, segment.fold);
  }
  return { turnFolds, groupFolds };
}

function attachTrailingToolGroupsToAssistant(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<
    number,
    Extract<MessagesTimelineRow, { kind: "assistant-meta" }>
  >();

  for (const [messageIndex, row] of rows.entries()) {
    const runId = row.kind === "message" ? (row.message.runId ?? null) : null;
    if (
      row.kind !== "message" ||
      row.message.role !== "assistant" ||
      !row.showAssistantMeta ||
      runId === null
    ) {
      continue;
    }

    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate || candidate.kind === "message") {
        break;
      }
      if (candidate.kind === "work-toggle" && candidate.runId === runId) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "event" &&
        candidate.resourceSummary &&
        candidate.projectedItem.item.runId === runId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (
        candidate.kind === "work" &&
        candidate.groupedEntries.some((entry) => entry.runId === runId)
      ) {
        if (
          !candidate.isExpandedToolGroup &&
          candidate.groupedEntries.some(
            (entry) =>
              workLogEntryIsToolLike(entry) ||
              (entry.projectedItem?.item.type === "error" &&
                entry.projectedItem.item.status === "failed"),
          )
        ) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }

    if (lastTrailingWorkIndex < 0) {
      continue;
    }

    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      ...(row.projectedItem === undefined ? {} : { projectedItem: row.projectedItem }),
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message,
      showAssistantCopyButton: row.showAssistantCopyButton,
      assistantCopyStreaming: row.assistantCopyStreaming,
    });
  }

  const result: MessagesTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false, showAssistantCopyButton: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

// Hide delegation rows only when task ids identify durable child cards; prompts can repeat.
function withoutSubagentDelegationRows(entries: ReadonlyArray<TimelineEntry>) {
  const childrenByRun = new Map<RunId, Set<string>>();
  for (const entry of entries) {
    if (entry.kind !== "event" || entry.projectedItem.item.type !== "subagent") continue;
    const item = entry.projectedItem.item;
    if (item.origin !== "app_owned" || item.runId === null) continue;
    const children = childrenByRun.get(item.runId) ?? new Set<string>();
    children.add(item.subagentId);
    childrenByRun.set(item.runId, children);
  }
  return entries.filter((entry) => {
    if (entry.kind !== "work" || workEntryDisplayIndicatesToolFailure(entry.entry)) return true;
    const item = entry.entry.projectedItem?.item ?? entry.entry.structuredPayload;
    if (
      item?.type !== "dynamic_tool" ||
      item.runId === null ||
      (item.status !== "running" && item.status !== "completed") ||
      resolveT3McpToolDefinition(item.toolName)?.summaryAction !== "delegate"
    )
      return true;
    const output = compactDynamicToolOutput(item.output);
    if (output?.isError) return true;
    if (output?.taskId !== undefined) {
      return !childrenByRun.get(item.runId)?.has(output.taskId);
    }
    return true;
  });
}

const supersededReasoningEntries = new WeakMap<TimelineEntry, TimelineEntry>();

function settleSupersededReasoning(entries: ReadonlyArray<TimelineEntry>) {
  return entries.map((entry, index) => {
    if (
      index === entries.length - 1 ||
      entry.kind !== "work" ||
      entry.entry.itemType !== "reasoning" ||
      entry.entry.toolLifecycleStatus !== "inProgress"
    ) {
      return entry;
    }
    let settled = supersededReasoningEntries.get(entry);
    if (!settled) {
      settled = { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "completed" } };
      supersededReasoningEntries.set(entry, settled);
    }
    return settled;
  });
}

function timelineRowEntries(entries: ReadonlyArray<TimelineEntry>) {
  return withoutSubagentDelegationRows(settleSupersededReasoning(entries));
}

function deriveTimelineTurnFolds(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
) {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  return deriveTurnFolds({
    timelineEntries,
    latestRun: input.latestRun ?? null,
    activeRunIds: activeVisualResponseRunIds,
    failedRunIds,
    runlessWorkActive: input.isWorking && input.runlessWorkActive === true,
    liveSubagentEntryIds: liveSubagentCardEntryIds(timelineEntries),
    completeSupersededReplyEntryIds: completeSupersededReplyEntryIds(timelineEntries),
  });
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun?: TimelineLatestRun | null;
  runningRunId?: RunId | null;
  expandedRunIds?: ReadonlySet<RunId>;
  expandedAttemptIds?: ReadonlySet<RunAttemptId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  /** Native subagent work has no app run; runless entries form the live response. */
  runlessWorkActive?: boolean;
  activeTurnStartedAt?: string | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  supportsConversationRollback: boolean;
  threadStartCheckpointReady?: boolean;
  availableRevertTurnCounts?: ReadonlySet<number> | undefined;
  liveAgentTaskIds?: ReadonlySet<string> | undefined;
  worktreeSetup?: WorktreeSetupSnapshot | null;
}): MessagesTimelineRow[] {
  const timelineEntries = timelineRowEntries(input.timelineEntries);
  const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    if (summary.assistantMessageId) {
      turnDiffSummaryByAssistantMessageId.set(summary.assistantMessageId, summary);
    }
  }
  const unsettledRunId = deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null);
  const revertTurnCountByUserMessageId = input.supportsConversationRollback
    ? deriveRevertTurnCountByUserMessageId({
        timelineEntries: timelineEntries,
        checkpoints: input.turnDiffSummaries,
        threadStartCheckpointReady: input.threadStartCheckpointReady === true,
        unsettledRunId,
        availableRevertTurnCounts: input.availableRevertTurnCounts,
      })
    : new Map<MessageId, number>();
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineEntries);
  const failedRunIds = failedTimelineRunIds(timelineEntries, input.latestRun ?? null);
  const liveSubagentEntryIds = liveSubagentCardEntryIds(timelineEntries);
  const completeSupersededReplyIds = completeSupersededReplyEntryIds(timelineEntries);
  const supersededFoldsByAnchorEntryId = deriveSupersededAttemptFolds(
    timelineEntries,
    failedRunIds,
    liveSubagentEntryIds,
    completeSupersededReplyIds,
  );
  const activeVisualResponseRunIds = deriveActiveVisualResponseRunIds({
    timelineEntries: timelineEntries,
    unsettledRunId,
    isWorking: input.isWorking,
  });
  const runlessWorkActive = input.isWorking && input.runlessWorkActive === true;
  const { turnFolds: foldsByAnchorEntryId, groupFolds: groupFoldsByAnchorEntryId } =
    deriveTurnFolds({
      timelineEntries: timelineEntries,
      latestRun: input.latestRun ?? null,
      activeRunIds: activeVisualResponseRunIds,
      failedRunIds,
      runlessWorkActive,
      liveSubagentEntryIds,
      completeSupersededReplyEntryIds: completeSupersededReplyIds,
    });
  const foldExpanded = (keys: ReadonlyArray<RunId>) =>
    keys.some((key) => input.expandedRunIds?.has(key) === true);
  const foldAnchorEntryIds = new Set([
    ...foldsByAnchorEntryId.keys(),
    ...groupFoldsByAnchorEntryId.keys(),
  ]);
  const collapsedEntryIds = new Set<string>();
  const collapsedFoldMemberIds = new Set<string>();
  const collapsedGroupKeys = new Set<RunId>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!foldExpanded(fold.foldKeys)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
      for (const entryId of fold.entryIds) {
        collapsedFoldMemberIds.add(entryId);
      }
    }
  }
  const groupTurnDiffSummaryByMessageId = new Map<MessageId, TurnDiffSummary>();
  const openTrailingFoldKeys = new Set<RunId>();
  for (const group of groupFoldsByAnchorEntryId.values()) {
    if (input.expandedRunIds?.has(group.key)) continue;
    collapsedGroupKeys.add(group.key);
    // Collapsed, the answer's card covers the whole group; open, each run shows its own.
    if (group.finalMessageId !== null) {
      const runIds = new Set(group.checkpointRunIds);
      const merged = mergeResponseGroupCheckpoints(
        input.turnDiffSummaries.filter((summary) => runIds.has(summary.runId)),
        group.unfinishedRunIds,
      );
      if (merged) groupTurnDiffSummaryByMessageId.set(group.finalMessageId, merged);
    }
    // A latest run opened on its own keeps its row, so it can be closed again.
    if (group.trailingFold && foldExpanded(group.trailingFold.foldKeys)) {
      openTrailingFoldKeys.add(group.trailingFold.runId);
    }
    for (const entryId of group.hiddenEntryIds) collapsedEntryIds.add(entryId);
    if (group.trailingFold && !foldExpanded(group.trailingFold.foldKeys)) {
      for (const entryId of group.trailingFold.hiddenEntryIds) collapsedEntryIds.add(entryId);
    }
  }
  const collapsedSupersededEntryIds = new Set<string>();
  for (const fold of supersededFoldsByAnchorEntryId.values()) {
    if (!input.expandedAttemptIds?.has(fold.attemptId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedSupersededEntryIds.add(entryId);
      }
    }
  }
  const runIdIsActiveResponse = (runId: RunId | null | undefined) =>
    runId == null ? runlessWorkActive : activeVisualResponseRunIds.has(runId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    entry.toolLifecycleStatus === "inProgress" &&
    (entry.runId == null ? runlessWorkActive : entry.runId === unsettledRunId);

  const activeTurnHeaderIndex = input.isWorking
    ? lastResponseBoundaryIndex(timelineEntries) + 1
    : timelineEntries.length;

  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  if (input.isWorking && (unsettledRunId !== null || runlessWorkActive)) {
    let tailAttemptId: string | null | undefined;
    for (let index = timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
      const entry = timelineEntries[index]!;
      if (
        entry.kind !== "work" ||
        entry.entry.tone === "error" ||
        entry.entry.sourceActivityKind === "runtime.error" ||
        entry.entry.itemType === "system_notice" ||
        entry.entry.itemType === "notification" ||
        entry.entry.questionAnswer !== undefined ||
        !runIdIsActiveResponse(entry.entry.runId) ||
        entry.entry.sourceActivityKind === "context-compaction" ||
        collapsedEntryIds.has(entry.id) ||
        collapsedSupersededEntryIds.has(entry.id) ||
        foldAnchorEntryIds.has(entry.id) ||
        supersededFoldsByAnchorEntryId.has(entry.id)
      ) {
        break;
      }
      if (tailAttemptId === undefined) {
        tailAttemptId = entry.attempt?.id ?? null;
      } else if ((entry.attempt?.id ?? null) !== tailAttemptId) {
        break;
      }
      activeToolEntries.push(entry);
    }
  }
  activeToolEntries.reverse();
  const visibleActiveToolEntries = activeToolEntries.filter((entry) =>
    workEntryIsVisibleInGroup(entry.entry, true),
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry));
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);

  const latestThoughtEntry = visibleActiveToolEntries.findLast(
    (entry) => entry.entry.itemType === "reasoning" && (entry.entry.detail?.trim() ?? "") !== "",
  );
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${activeWorkAnchor.id}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            active: latestToolKeepsActivityLive,
            ...(latestThoughtEntry ? { thought: latestThoughtEntry.entry } : {}),
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : [],
  );
  // A bare `/compact` turn is the compaction itself: one compaction row stands in for its prompt
  // and working indicator, from the moment the turn starts. Likewise an answered "compact before
  // continuing?" question folds into the compaction it asked for.
  const compactionRuns = new Map<RunId, OrchestrationV2IdleCompaction | undefined>();
  const compactedRunIds = new Set<RunId>();
  const pendingResumeCompactionAgeByRunId = new Map<RunId, string>();
  const resumeCompactionAgeByEntryId = new Map<string, string>();
  for (const entry of timelineEntries) {
    if (
      entry.kind === "message" &&
      entry.message.runId !== null &&
      isCompactionCommandMessage(entry.message)
    ) {
      compactionRuns.set(entry.message.runId, idleCompactionOf(entry.message));
    } else if (entry.kind === "work" && entry.entry.runId) {
      if (timelineEntryIsCompaction(entry)) {
        compactedRunIds.add(entry.entry.runId);
        const age = pendingResumeCompactionAgeByRunId.get(entry.entry.runId);
        if (age !== undefined) {
          resumeCompactionAgeByEntryId.set(entry.id, age);
          pendingResumeCompactionAgeByRunId.delete(entry.entry.runId);
        }
      }
      const age = entry.entry.questionAnswer
        ? claudeResumeCompactionAge(entry.entry.questionAnswer)
        : null;
      if (age !== null) pendingResumeCompactionAgeByRunId.set(entry.entry.runId, age);
    }
  }
  const compactionTitle = (runId: RunId | null | undefined, entryId: string) => {
    if (runId == null) return undefined;
    const reason = compactionRuns.get(runId);
    if (reason !== undefined) return IDLE_COMPACTION_TITLES[reason];
    const age = resumeCompactionAgeByEntryId.get(entryId);
    return age ? `Context compacted after ${age} idle` : undefined;
  };
  const activeCompactionEntry = timelineEntries.find(
    (entry): entry is Extract<TimelineEntry, { kind: "work" }> =>
      timelineEntryIsCompaction(entry) &&
      entry.kind === "work" &&
      workEntryIsInActiveRun(entry.entry),
  );
  const activeRunIsCompaction =
    input.isWorking && unsettledRunId !== null && compactionRuns.has(unsettledRunId);
  // The item can finish before its run settles; only other work should keep activity visible.
  const compactionRunFinished =
    activeRunIsCompaction &&
    compactedRunIds.has(unsettledRunId) &&
    activeCompactionEntry === undefined;
  const compactionOnlyRunFinished =
    compactionRunFinished &&
    !timelineEntries.some(
      (entry) =>
        timelineEntryRunId(entry) === unsettledRunId &&
        !timelineEntryIsCompaction(entry) &&
        !(entry.kind === "message" && isCompactionCommandMessage(entry.message)),
    );
  const runningCompactionRunId =
    activeRunIsCompaction && !compactionRunFinished ? unsettledRunId : null;
  // Compacting on return holds back the message the user just sent, so the working row says why
  // it is waiting. Any other compaction shows only its live divider, never both.
  const activeCompactionRunId =
    runningCompactionRunId !== null && compactionRuns.get(runningCompactionRunId) === "onReturn"
      ? runningCompactionRunId
      : activeCompactionEntry?.entry.runId != null &&
          resumeCompactionAgeByEntryId.has(activeCompactionEntry.id)
        ? activeCompactionEntry.entry.runId
        : null;
  const compactingLabel = (() => {
    if (activeCompactionRunId === null) return undefined;
    const age = activeCompactionEntry
      ? resumeCompactionAgeByEntryId.get(activeCompactionEntry.id)
      : undefined;
    return age ? `Compacting after ${age} idle…` : IDLE_COMPACTING_LABELS.onReturn;
  })();
  const appendWorkingRow = () => {
    if (compactionOnlyRunFinished) return;
    if (runningCompactionRunId !== null && activeCompactionRunId === null) return;
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt ?? null,
      ...(compactingLabel ? { compacting: compactingLabel } : {}),
    });
  };
  let hasActivityRow = false;
  const hasActiveCompaction =
    activeCompactionEntry !== undefined || (activeRunIsCompaction && !compactionRunFinished);
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    nextRows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded) return;
    nextRows.push(
      expandedWorkGroupRow(
        activeWorkRow.groupId,
        activeWorkRow.createdAt,
        activeWorkRow.groupedEntries,
      ),
    );
  };

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    if (
      timelineEntry.kind === "event" &&
      timelineEntry.projectedItem.item.type === "run_interrupt_request"
    ) {
      continue;
    }

    const groupFold = groupFoldsByAnchorEntryId.get(timelineEntry.id);
    if (groupFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${groupFold.key}`,
        createdAt: groupFold.createdAt,
        runId: groupFold.key,
        foldKeys: [groupFold.key],
        label: groupFold.label,
        expanded: !collapsedGroupKeys.has(groupFold.key),
      });
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (
      turnFold &&
      (turnFold.groupKey === null ||
        !collapsedGroupKeys.has(turnFold.groupKey) ||
        openTrailingFoldKeys.has(turnFold.runId))
    ) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${turnFold.runId}`,
        createdAt: turnFold.createdAt,
        runId: turnFold.runId,
        foldKeys: turnFold.foldKeys,
        label: turnFold.label,
        expanded: foldExpanded(turnFold.foldKeys),
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    const supersededFold = supersededFoldsByAnchorEntryId.get(timelineEntry.id);
    if (supersededFold) {
      nextRows.push({
        kind: "attempt-fold",
        id: `attempt-fold:${supersededFold.attemptId}`,
        createdAt: supersededFold.createdAt,
        runId: supersededFold.runId,
        attemptId: supersededFold.attemptId,
        label: "Superseded attempt",
        expanded: input.expandedAttemptIds?.has(supersededFold.attemptId) ?? false,
      });
    }

    if (collapsedSupersededEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.sourceActivityKind === "context-compaction"
    ) {
      const active = workEntryIsInActiveRun(timelineEntry.entry);
      if (
        active &&
        activeCompactionRunId !== null &&
        timelineEntry.entry.runId === activeCompactionRunId
      )
        continue;
      const compaction = timelineEntry.entry.structuredPayload;
      const compactionRunId = timelineEntry.entry.runId;
      const title = compactionTitle(compactionRunId, timelineEntry.id);
      const reason = compactionRunId == null ? undefined : compactionRuns.get(compactionRunId);
      const failed = compaction?.type === "compaction" && compaction.status === "failed";
      const failure = failed ? compaction.summary?.trim() || undefined : undefined;
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        ...(title ? { title } : {}),
        ...(failed ? { failed: true } : {}),
        ...(failure ? { failure } : {}),
        createdAt: timelineEntry.createdAt,
        label: active && reason ? IDLE_COMPACTING_LABELS[reason] : timelineEntry.entry.label,
        tokenCounts:
          compaction?.type === "compaction" ? contextCompactionTokenCounts(compaction) : null,
        active,
      });
      continue;
    }

    if (
      timelineEntry.kind === "work" &&
      timelineEntry.entry.runId != null &&
      compactedRunIds.has(timelineEntry.entry.runId) &&
      timelineEntry.entry.questionAnswer !== undefined &&
      claudeResumeCompactionAge(timelineEntry.entry.questionAnswer) !== null
    ) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (
        (timelineEntry.entry.runId != null && failedRunIds.has(timelineEntry.entry.runId)) ||
        (timelineEntry.entry.itemType === "error" &&
          timelineEntry.entry.toolLifecycleStatus === "failed") ||
        timelineEntry.entry.tone === "error" ||
        timelineEntry.entry.sourceActivityKind === "runtime.error" ||
        timelineEntry.entry.itemType === "system_notice" ||
        timelineEntry.entry.itemType === "notification" ||
        timelineEntry.entry.questionAnswer !== undefined
      ) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false,
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.sourceActivityKind === "context-compaction" ||
          nextEntry.entry.tone === "error" ||
          nextEntry.entry.sourceActivityKind === "runtime.error" ||
          nextEntry.entry.itemType === "system_notice" ||
          nextEntry.entry.itemType === "notification" ||
          nextEntry.entry.questionAnswer !== undefined ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          collapsedSupersededEntryIds.has(nextEntry.id) ||
          foldAnchorEntryIds.has(nextEntry.id) ||
          supersededFoldsByAnchorEntryId.has(nextEntry.id) ||
          (nextEntry.entry.runId ?? null) !== (timelineEntry.entry.runId ?? null) ||
          nextEntry.attempt?.id !== timelineEntry.attempt?.id
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = groupedEntries.filter((entry) =>
        workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          nextRows.push({
            kind: "work-live",
            id: `work-live:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true,
          });
          hasActivityRow = true;
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        } else if (
          visibleGroupedEntries.length === 1 &&
          workLogEntryIsToolLike(visibleGroupedEntries[0]!)
        ) {
          const singleEntry = visibleGroupedEntries[0]!;
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(visibleGroupedEntries).summary
                : singleToolCallLabel(singleEntry),
          });
        } else {
          const groupId = workGroupId(timelineEntry.id);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const primarySourceEntry = visibleGroupedEntries.find(
            (entry) => entry.toolSource !== undefined,
          );
          const primarySourceKey = primarySourceEntry?.toolSource?.key;
          const primarySourceIcon = primarySourceKey
            ? (visibleGroupedEntries.find(
                (entry) =>
                  entry.toolSource?.key === primarySourceKey && entry.toolIcon !== undefined,
              )?.toolIcon ?? primarySourceEntry?.toolSource?.icon)
            : undefined;
          const groupToolSurface =
            primarySourceEntry?.toolSurface ??
            visibleGroupedEntries.findLast((entry) => entry.toolSurface !== undefined)?.toolSurface;
          const groupToolIcon =
            primarySourceIcon ??
            visibleGroupedEntries.findLast((entry) => entry.toolIcon !== undefined)?.toolIcon;
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          const singleEntry =
            visibleGroupedEntries.length === 1 ? (visibleGroupedEntries[0] ?? null) : null;
          const usesSingleToolCallLabel =
            singleEntry !== null &&
            workLogEntryIsToolLike(singleEntry) &&
            toolGroupAction(singleEntry) !== "edit";
          const summaryToolIcon = usesSingleToolCallLabel
            ? resolveWorkEntryToolPresentation(singleEntry, "completed")?.icon
            : undefined;
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            runId: timelineEntry.entry.runId ?? null,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary: usesSingleToolCallLabel
              ? singleToolCallLabel(singleEntry)
              : singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroup(visibleGroupedEntries).summary,
            summaryKind,
            ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
            ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
            ...(summaryToolIcon ? { summaryToolIcon } : {}),
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (expanded) {
            nextRows.push(
              expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries),
            );
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "mcp-app") {
      nextRows.push({
        kind: "mcp-app",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        sourceThreadId: timelineEntry.sourceThreadId,
        itemId: timelineEntry.itemId,
        revision: timelineEntry.revision,
        mcpApp: timelineEntry.mcpApp,
      });
      continue;
    }

    if (timelineEntry.kind === "event") {
      const previous = nextRows.at(-1);
      if (
        timelineEntry.projectedItem.item.type === "subagent" &&
        previous?.kind === "event" &&
        previous.projectedItem.item.type === "subagent" &&
        previous.projectedItem.item.runId === timelineEntry.projectedItem.item.runId &&
        previous.projectedItem.item.providerTurnId ===
          timelineEntry.projectedItem.item.providerTurnId
      ) {
        nextRows[nextRows.length - 1] = {
          ...previous,
          subagents: [
            ...(previous.subagents ?? [previous.projectedItem]),
            timelineEntry.projectedItem,
          ],
        };
        continue;
      }
      nextRows.push({
        kind: "event",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        projectedItem: timelineEntry.projectedItem,
      });
      continue;
    }

    const compactionRunId = timelineEntry.message.runId;
    const compactionRun =
      compactionRunId !== null && isCompactionCommandMessage(timelineEntry.message);
    if (compactionRun) {
      if (!compactedRunIds.has(compactionRunId) && compactionRunId !== activeCompactionRunId) {
        const pending = compactionRunId === runningCompactionRunId;
        const reason = compactionRuns.get(compactionRunId);
        nextRows.push({
          kind: "context-compaction",
          id: `compaction:${compactionRunId}`,
          createdAt: timelineEntry.createdAt,
          label: pending
            ? reason
              ? IDLE_COMPACTING_LABELS[reason]
              : "Compacting context"
            : "Context compaction",
          tokenCounts: null,
          active: pending,
        });
      }
      continue;
    }

    const assistantResponseStillInProgress =
      timelineEntry.message.role === "assistant" &&
      runIdIsActiveResponse(timelineEntry.message.runId);

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      !assistantResponseStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      ...(timelineEntry.projectedItem === undefined
        ? {}
        : { projectedItem: timelineEntry.projectedItem }),
      durationStart,
      showAssistantMeta,
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantResponseStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? (groupTurnDiffSummaryByMessageId.get(timelineEntry.message.id) ??
            turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id))
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  const setupHandedOff =
    input.worktreeSetup !== null &&
    input.worktreeSetup !== undefined &&
    worktreeSetupAgentStarted(input.worktreeSetup) &&
    input.latestRun?.startedAt != null;
  const setupOwnsWorkingSlot =
    !setupHandedOff &&
    (input.worktreeSetup?.phase === "running" || input.worktreeSetup?.phase === "done");
  if (input.worktreeSetup && (!setupHandedOff || input.worktreeSetup.phase !== "running")) {
    const setupRow = {
      kind: "worktree-setup",
      id: WORKTREE_SETUP_ROW_ID,
      createdAt: input.worktreeSetup.startedAt,
      snapshot: input.worktreeSetup,
      embedded: setupHandedOff,
    } as const;
    const firstUserRowIndex = nextRows.findIndex(
      (row) => row.kind === "message" && row.message.role === "user",
    );
    const workingRowIndex = setupOwnsWorkingSlot
      ? nextRows.findIndex((row) => row.kind === "working")
      : -1;
    if (workingRowIndex >= 0) {
      nextRows.splice(workingRowIndex + 1, 0, setupRow);
    } else {
      const insertAt = firstUserRowIndex >= 0 ? firstUserRowIndex + 1 : nextRows.length;
      nextRows.splice(
        insertAt,
        0,
        ...(setupOwnsWorkingSlot
          ? [
              {
                kind: "working",
                id: "working-indicator-row",
                createdAt: input.worktreeSetup.startedAt,
              } as const,
              setupRow,
            ]
          : [setupRow]),
      );
    }
  }

  const hasWorkingRow = nextRows.some((row) => row.kind === "working");
  if (input.isWorking && !hasWorkingRow && activeTurnHeaderIndex === timelineEntries.length) {
    appendWorkingRow();
  }
  if (
    input.isWorking &&
    input.latestRun?.turnEnded !== true &&
    !setupOwnsWorkingSlot &&
    !hasActiveCompaction &&
    !compactionOnlyRunFinished &&
    (!hasActivityRow || latestToolFailed)
  ) {
    const failedGroupAnchor = latestToolFailed ? activeWorkAnchor : undefined;
    if (failedGroupAnchor) {
      const groupId = workGroupId(failedGroupAnchor.id);
      const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
        groupId,
        expanded,
      });
      if (expanded) {
        nextRows.push(
          expandedWorkGroupRow(
            groupId,
            failedGroupAnchor.createdAt,
            visibleActiveToolEntries.map((entry) => entry.entry),
          ),
        );
      }
    } else {
      nextRows.push({
        kind: "thinking",
        id: LIVE_ACTIVITY_ROW_ID,
        createdAt: input.activeTurnStartedAt ?? null,
      });
    }
  }

  const result = attachTrailingToolGroupsToAssistant(
    attachCreatedThreadSummaries(nextRows, timelineEntries, collapsedFoldMemberIds),
  );
  return result.map((row, index) =>
    timelineRowIsWorkLog(row) && timelineRowIsWorkLog(result[index + 1])
      ? { ...row, continuesWorkLog: true }
      : row,
  );
}

function timelineRowIsWorkLog(row: MessagesTimelineRow | undefined): boolean {
  return (
    row !== undefined &&
    (row.kind === "work" ||
      row.kind === "work-toggle" ||
      row.kind === "work-live" ||
      row.kind === "thinking")
  );
}

function attachCreatedThreadSummaries(
  rows: MessagesTimelineRow[],
  timelineEntries: ReadonlyArray<TimelineEntry>,
  collapsedFoldMemberIds: ReadonlySet<string>,
): MessagesTimelineRow[] {
  const terminalIndexes = new Map<RunId, number>();
  const createdByRun = new Map<RunId, Array<Extract<MessagesTimelineRow, { kind: "event" }>>>();
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      terminalIndexes.set(row.message.runId, index);
    }
  }
  for (const entry of timelineEntries) {
    const projectedItem =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : entry.kind === "event"
          ? entry.projectedItem
          : undefined;
    if (projectedItem?.item.type === "thread_created" && projectedItem.item.runId) {
      const runId = projectedItem.item.runId;
      const entries = createdByRun.get(runId) ?? [];
      entries.push({ kind: "event", id: entry.id, createdAt: entry.createdAt, projectedItem });
      createdByRun.set(runId, entries);
    }
  }
  return rows.flatMap((row, index): MessagesTimelineRow[] => {
    if (row.kind === "event" && row.projectedItem.item.type === "thread_created") {
      const runId = row.projectedItem.item.runId;
      const terminalIndex = runId === null ? undefined : terminalIndexes.get(runId);
      if (
        terminalIndex !== undefined &&
        (collapsedFoldMemberIds.has(row.id) || index > terminalIndex)
      )
        return [];
    }
    if (row.kind === "message" && row.showAssistantMeta && row.message.runId) {
      return [
        row,
        ...(createdByRun.get(row.message.runId) ?? []).map((entry) => ({
          ...entry,
          id: `summary:${entry.id}`,
          resourceSummary: true,
        })),
      ];
    }
    return [row];
  });
}

const WORKTREE_SETUP_ROW_ID = "worktree-setup-row";

export type MessagesTimelineRowsInput = Parameters<typeof deriveMessagesTimelineRows>[0];

export interface MessagesTimelineRowsProjection {
  readonly input: MessagesTimelineRowsInput;
  readonly rows: MessagesTimelineRow[];
}

/**
 * Every fold key an entry hides behind: its run's fold and its response
 * group's. Runless (imported V1) turns and work after a steer fold under
 * synthetic keys, so the entry's own run id is not enough to open them.
 */
export function timelineTurnFoldRunIdsByEntryId(
  input: Pick<
    MessagesTimelineRowsInput,
    "timelineEntries" | "latestRun" | "isWorking" | "runlessWorkActive" | "runningRunId"
  >,
): ReadonlyMap<string, ReadonlyArray<RunId>> {
  const byEntryId = new Map<string, RunId[]>();
  const add = (entryId: string, key: RunId) => {
    const keys = byEntryId.get(entryId);
    if (keys === undefined) byEntryId.set(entryId, [key]);
    else if (!keys.includes(key)) keys.push(key);
  };
  const { turnFolds, groupFolds } = deriveTimelineTurnFolds(input);
  for (const fold of turnFolds.values()) {
    for (const entryId of fold.hiddenEntryIds) {
      for (const key of fold.foldKeys) add(entryId, key);
    }
  }
  for (const group of groupFolds.values()) {
    for (const entryId of group.hiddenEntryIds) add(entryId, group.key);
    for (const entryId of group.trailingFold?.hiddenEntryIds ?? []) add(entryId, group.key);
  }
  return byEntryId;
}

function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaries"],
  next: MessagesTimelineRowsInput["turnDiffSummaries"],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (const [index, summary] of previous.entries()) {
    if (!shallow(summary, next[index])) return false;
  }
  return true;
}

/** A response group's merged summary is rebuilt on each derivation; compare it by value. */
function sameTurnDiffSummary(
  previous: TurnDiffSummary | undefined,
  next: TurnDiffSummary | undefined,
): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  const { files: previousFiles, ...previousRest } = previous;
  const { files: nextFiles, ...nextRest } = next;
  return (
    shallow(previousRest, nextRest) &&
    previousFiles.length === nextFiles.length &&
    previousFiles.every((file, index) => shallow(file, nextFiles[index]))
  );
}

function replaceStreamingMessageRows(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection,
): MessagesTimelineRow[] | null {
  const {
    timelineEntries: previousEntries,
    latestRun: previousRun,
    turnDiffSummaries: previousCheckpoints,
    expandedRunIds: previousExpandedRuns,
    expandedAttemptIds: previousExpandedAttempts,
    expandedWorkGroupIds: previousExpandedGroups,
    availableRevertTurnCounts: previousAvailableRevertTurnCounts,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaries,
    expandedRunIds,
    expandedAttemptIds,
    expandedWorkGroupIds,
    availableRevertTurnCounts,
    ...context
  } = input;
  // Shell/checkpoint selectors rebuild summaries per event; compare contents.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousExpandedRuns, expandedRunIds) ||
    !shallow(previousExpandedAttempts, expandedAttemptIds) ||
    !shallow(previousExpandedGroups, expandedWorkGroupIds) ||
    !shallow(previousAvailableRevertTurnCounts, availableRevertTurnCounts) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaries)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index]!;
    const previousEntry = previousEntries[index]!;
    if (entry === previousEntry) continue;
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt ||
      entry.attempt !== previousEntry.attempt
    ) {
      return null;
    }
    if (
      entry.projectedItem !== previousEntry.projectedItem &&
      (entry.projectedItem === undefined ||
        previousEntry.projectedItem === undefined ||
        !isStreamingTurnItemTextUpdate(previousEntry.projectedItem, entry.projectedItem))
    ) {
      return null;
    }
    if (
      entry.message === previousEntry.message &&
      entry.projectedItem === previousEntry.projectedItem
    )
      continue;
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) return null;
    replacements.set(previousEntry.message, entry);
  }
  if (replacements.size === 0) return previous.rows;
  return previous.rows.map((row) => {
    if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
    const entry = replacements.get(row.message);
    return entry
      ? {
          ...row,
          message: entry.message,
          ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        }
      : row;
  });
}

export function deriveMessagesTimelineRowsWithState(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection | null = null,
): MessagesTimelineRowsProjection {
  return {
    input,
    rows:
      (previous === null ? null : replaceStreamingMessageRows(input, previous)) ??
      deriveMessagesTimelineRows(input),
  };
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return (
        a.createdAt === (b as typeof a).createdAt && a.compacting === (b as typeof a).compacting
      );
    case "thinking": {
      const bt = b as typeof a;
      return a.createdAt === bt.createdAt && a.groupId === bt.groupId && a.expanded === bt.expanded;
    }
    case "worktree-setup":
      return a.snapshot === (b as typeof a).snapshot;

    case "assistant-meta": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.projectedItem === bm.projectedItem &&
        a.message === bm.message &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming
      );
    }

    case "turn-fold": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.label === bf.label &&
        a.expanded === bf.expanded &&
        a.foldKeys.join("\0") === bf.foldKeys.join("\0")
      );
    }

    case "attempt-fold": {
      const bf = b as typeof a;
      return a.createdAt === bf.createdAt && a.label === bf.label && a.expanded === bf.expanded;
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return (
        a.createdAt === bc.createdAt &&
        a.label === bc.label &&
        a.active === bc.active &&
        a.title === bc.title &&
        a.failed === bc.failed &&
        a.failure === bc.failure
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render": {
      // Tool updates rebuild entries; preserve frames for unchanged pages.
      const bh = b as typeof a;
      return a.createdAt === bh.createdAt && htmlRenderReferencesEqual(a.htmlRender, bh.htmlRender);
    }

    case "mcp-app": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.revision === bm.revision &&
        mcpAppReferencesEqual(a.mcpApp, bm.mcpApp)
      );
    }

    case "event":
      return (
        a.projectedItem === (b as typeof a).projectedItem &&
        a.resourceSummary === (b as typeof a).resourceSummary &&
        Equal.equals(a.subagents, (b as typeof a).subagents)
      );

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroup === bw.isExpandedToolGroup &&
        a.displayLabel === bw.displayLabel &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.active === bw.active &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.runId === bw.runId &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.toolSurface === bw.toolSurface &&
        Equal.equals(a.toolIcon, bw.toolIcon) &&
        a.hasFailure === bw.hasFailure
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.projectedItem === bm.projectedItem &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        sameTurnDiffSummary(a.assistantTurnDiffSummary, bm.assistantTurnDiffSummary) &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g;

function visibleUserMessageText(text: string): string {
  const linkLabels = (segment: string) => segment.replace(MARKDOWN_LINK, "$1");
  let visible = "";
  let cursor = 0;
  for (const match of collectAssistantCitations(text)) {
    visible += linkLabels(text.slice(cursor, match.start)) + assistantCitationLabel(match.citation);
    cursor = match.end;
  }
  return visible + linkLabels(text.slice(cursor));
}

export function shouldCollapseUserMessage(text: string): boolean {
  const visible = visibleUserMessageText(text);
  if (visible.trim().length === 0) {
    return false;
  }

  return (
    visible.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    visible.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

export function handoffRunsSignature(runs: ReadonlyArray<HandoffTimelineRun>): string {
  return runs
    .map(
      (run) =>
        `${run.id}\0${run.providerInstanceId}\0${run.ordinal}\0${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
    )
    .join("\n");
}

// Expanded-id sets can be rebuilt during render; comparing them by content keeps
// the render-time state update in useIncrementalTimelineRows from repeating forever.
export function sameRowsInput(
  left: MessagesTimelineRowsInput,
  right: MessagesTimelineRowsInput,
): boolean {
  for (const key of Object.keys(right) as Array<keyof MessagesTimelineRowsInput>) {
    const previous = left[key];
    const next = right[key];
    if (Object.is(previous, next)) continue;
    if (previous instanceof Set && next instanceof Set && shallow(previous, next)) continue;
    return false;
  }
  return Object.keys(left).length === Object.keys(right).length;
}
