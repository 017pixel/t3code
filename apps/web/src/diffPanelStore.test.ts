import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });

  it("keeps a timeline Open diff on its run until that run's checkpoint lands", () => {
    const completedRunId = RunId.make("run-1");
    const runningRunId = RunId.make("run-2");
    const store = useDiffPanelStore.getState();

    store.selectTurn(threadRef, runningRunId, "src/notes.md");
    // The running run has no checkpoint yet, so only the earlier turn is available.
    store.reconcileTurnSelection(threadRef, [completedRunId]);
    store.reconcileTurnSelection(threadRef, [runningRunId, completedRunId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "turn", turnId: runningRunId, filePath: "src/notes.md" });
  });
});
