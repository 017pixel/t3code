import { beforeEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

import { useDiffPanelSessionStore, useDiffPanelStore } from "./diffPanelStore";

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

  it("keeps a response group's range until the selected turn disappears", () => {
    const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
    const latest = RunId.make("run-9");
    useDiffPanelStore.getState().selectTurn(ref, latest, undefined, 4);
    expect(Object.values(useDiffPanelStore.getState().byThreadKey)[0]).toMatchObject({
      turnId: latest,
      fromTurnCount: 4,
    });
    useDiffPanelStore.getState().reconcileTurnSelection(ref, [RunId.make("run-10")]);
    const reconciled = Object.values(useDiffPanelStore.getState().byThreadKey)[0];
    expect(reconciled).toMatchObject({ turnId: "run-10" });
    expect(reconciled).not.toHaveProperty("fromTurnCount");
  });
});
