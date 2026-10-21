import React, { Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import "../../../src/index.css";
import data from "./messages.json";
import { ComposerPendingUserInputPanel } from "../../../src/components/chat/ComposerPendingUserInputPanel";
import { WorkflowOpeningBlock } from "../../../src/components/chat/WorkflowOpeningBlock";
import {
  PullRequestMarkdown,
  PullRequestMarkdownContext,
} from "../../../src/components/pullRequest/PullRequestMarkdown";
import { AttachmentFilePreview } from "../../../src/components/files/AttachmentFilePreview";
import { V2ItemInspector } from "../../../src/components/chat/V2ItemInspector";
import { V2EventTimelineRow } from "../../../src/components/chat/TimelineV2EventRow";
import {
  TimelineRowCtx,
  TimelineRowActivityCtx,
} from "../../../src/components/chat/timelineRowContext";
import { SimpleWorkEntryRow } from "../../../src/components/chat/TimelineWorkEntryRow";
import { UserMessageContextReferenceChip } from "../../../src/components/chat/UserMessageContextChips";
import {
  ComposerContextReferenceChip,
  ComposerContextRecordsContext,
} from "../../../src/components/composerContextPresentation";
const env = "rtl-proof-harness",
  tid = "rtl-proof-harness-thread";
const ref = { environmentId: env, threadId: tid };
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const noop = () => {};
const base = {
  id: "harness-item",
  threadId: tid,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
const reason = { ...base, id: "reason", type: "reasoning", text: data.thought, streaming: false };
const projected = (item) => ({
  item,
  position: 0,
  visibility: "local",
  sourceThreadId: tid,
  sourceItemId: item.id,
});
const shared = {
  citationRequest: null,
  listRef: { current: null },
  timestampFormat: "locale",
  routeThreadKey: tid,
  threadRef: ref,
  markdownCwd: "/synthetic",
  resolvedTheme: "light",
  workspaceRoot: "/synthetic",
  skills: [{ name: "test-t3-app", displayName: "Test T3 app" }],
  runs: [],
  activeThreadEnvironmentId: env,
  onRevertToTurnCount: noop,
  onUseArtifactTemplate: noop,
  onAppFullscreenChange: noop,
  findActive: false,
  onImageExpand: noop,
  onOpenTurnDiff: noop,
  onOpenThread: noop,
  workflowOpening: null,
  onForkFromRun: noop,
  onRollbackCheckpoint: noop,
  onToggleTurnFold: noop,
  onToggleAttemptFold: noop,
  onFileOpen: noop,
  onFileDownload: noop,
  openPullRequest: noop,
  onToggleWorkGroup: noop,
  onToggleWorkEntry: noop,
  onCancelWorktreeSetup: null,
  retryableWorkspacePreparationRunIds: new Set(),
  onRetryWorkspacePreparation: null,
  onWorktreeSetupWorkLocally: null,
  onOpenWorktreeSetupTerminal: null,
  workGroupViewState: { scrollPositions: new Map(), expandedEntries: new Set() },
};
const comment = {
  id: "synthetic-review",
  sectionId: "proof",
  sectionTitle: "Synthetic review",
  filePath: "proof.ts",
  startIndex: 0,
  endIndex: 1,
  rangeLabel: "Lines 1–2",
  text: data.context,
  diff: 'const message = "שלום";\nconsole.log(message);',
  fenceLanguage: "typescript",
};
function Question() {
  const [answers, setAnswers] = useState({});
  const [advanced, setAdvanced] = useState(false);
  return (
    <>
      <ComposerPendingUserInputPanel
        cwd="/synthetic"
        threadRef={ref}
        pendingUserInputs={[
          {
            requestId: "question",
            createdAt: "2026-01-01T00:00:00Z",
            questions: [
              {
                id: "q",
                header: "Synthetic question",
                question: data.question,
                options: [
                  { label: "שלום", description: "אפשרות ראשונה" },
                  { label: "English", description: "English control" },
                ],
                multiSelect: true,
              },
            ],
            responseCapability: "message",
            dismissible: true,
          },
        ]}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={0}
        onToggleOption={(id, value) =>
          setAnswers({
            [id]: {
              selectedOptionValues: answers[id]?.selectedOptionValues?.includes(value)
                ? []
                : [value],
            },
          })
        }
        onAdvance={() => setAdvanced(true)}
        onDismiss={noop}
      />
      <output>{JSON.stringify({ answers, advanced })}</output>
    </>
  );
}
function Thought() {
  const [active, setActive] = useState(true);
  const item = { ...reason, status: active ? "running" : "completed", streaming: active };
  return (
    <>
      <button onClick={() => setActive(!active)}>Finish / activate synthetic thought</button>
      <TimelineRowActivityCtx
        value={{
          isWorking: active,
          latestRunId: null,
          isCompacting: false,
          isRevertingCheckpoint: false,
          activeTurnInProgress: active,
          awaitingUser: false,
          isPreparingWorktree: false,
          backgroundWorktreeSetup: null,
        }}
      >
        <SimpleWorkEntryRow
          workspaceRoot="/synthetic"
          workEntry={{
            id: "thought-entry",
            itemType: "reasoning",
            label: "Thought",
            detail: data.thought,
            tone: "thinking",
            createdAt: "2026-01-01T00:00:00Z",
            runId: null,
            toolLifecycleStatus: active ? "inProgress" : "completed",
            projectedItem: projected(item),
          }}
        />
      </TimelineRowActivityCtx>
    </>
  );
}
function Secondary() {
  return (
    <>
      <h2>Event detail — non-error branch (todo_list)</h2>
      <V2EventTimelineRow
        row={{
          kind: "event",
          id: "compact",
          createdAt: "2026-01-01T00:00:00Z",
          projectedItem: projected({
            ...base,
            id: "compact",
            type: "todo_list",
            explanation: data.context,
            steps: [],
          }),
        }}
      />
      <h2>Event detail — error disclosure branch</h2>
      <V2EventTimelineRow
        row={{
          kind: "event",
          id: "error",
          createdAt: "2026-01-01T00:00:00Z",
          projectedItem: projected({
            ...base,
            id: "error",
            type: "error",
            failure: { class: "unknown", message: data.context, code: null, retryable: false },
          }),
        }}
      />
      <h2>Inspector — reasoning text branch</h2>
      <V2ItemInspector
        environmentId={env}
        cwd="/synthetic"
        projectedItem={projected(reason)}
        onOpenThread={noop}
        onOpenTurnDiff={noop}
      />
    </>
  );
}
function Contexts() {
  return (
    <>
      <h2>User-message review context</h2>
      <UserMessageContextReferenceChip
        reference={{ kind: "review-comment", contextId: "review", label: "Synthetic review" }}
        record={{ ...comment, contextId: "review", kind: "review-comment" }}
        annotationImage={null}
        attachment={null}
        onExpandImage={noop}
        onExpandVideo={noop}
        onOpenFile={noop}
      />
      <h2>Composer review context</h2>
      <ComposerContextRecordsContext
        value={new Map([["review", { kind: "review-comment", record: comment }]])}
      >
        <ComposerContextReferenceChip
          kind="review-comment"
          contextId="review"
          label="Synthetic review"
        />
      </ComposerContextRecordsContext>
    </>
  );
}
const attachment = new Blob([data.F2 + "\n\n" + data.F3], { type: "text/markdown" });
function Gallery() {
  const view = new URLSearchParams(location.search).get("view") || "question";
  document.documentElement.classList.toggle(
    "dark",
    matchMedia("(prefers-color-scheme: dark)").matches,
  );
  return (
    <TimelineRowCtx value={shared}>
      <div
        data-proof-gallery
        style={{ height: "100dvh", overflow: "auto", padding: 16, maxWidth: 960, margin: "0 auto" }}
      >
        <p>
          HARNESS ONLY — real callers, synthetic props. No live provider, app navigation, scheduler,
          or forge writes.
        </p>
        <h1>{view}</h1>
        <Suspense fallback={<p>Loading real component…</p>}>
          {view === "question" ? (
            <Question />
          ) : view === "thought" ? (
            <Thought />
          ) : view === "secondary" ? (
            <Secondary />
          ) : view === "contexts" ? (
            <Contexts />
          ) : view === "pr" ? (
            <PullRequestMarkdownContext
              value={{ repositoryUrl: "https://github.com/example/synthetic", threadRef: ref }}
            >
              <PullRequestMarkdown
                text={data.F1 + "\n\n" + data.F2}
                cwd="/synthetic"
                environmentId={env}
                threadRef={ref}
              />
            </PullRequestMarkdownContext>
          ) : view === "attachment" ? (
            <AttachmentFilePreview
              name="synthetic-rtl.md"
              mimeType="text/markdown"
              sizeBytes={attachment.size}
              file={attachment}
              threadRef={ref}
            />
          ) : view === "workflow" ? (
            <WorkflowOpeningBlock
              environmentId={env}
              onOpenThread={noop}
              opening={{
                messageId: "workflow",
                script: Array.from(
                  { length: 35 },
                  (_, i) => `// ${i + 1} שלום עולם\nconst value${i} = ${i};`,
                ).join("\n"),
                name: "Synthetic workflow",
                description: "Display only; never scheduled or executed.",
                driver: null,
                providerInstanceId: null,
                group: null,
              }}
            />
          ) : null}
        </Suspense>
      </div>
    </TimelineRowCtx>
  );
}
const route = createRootRoute({ component: Gallery });
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("proof-root")).render(<RouterProvider router={router} />);
