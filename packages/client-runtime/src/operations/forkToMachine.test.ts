import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { forkBranchState, forkModelSelection } from "./forkToMachine.ts";

const pushed = { isRepo: true, refName: "fix/login", hasUpstream: true, aheadCount: 0 };

describe("forkBranchState", () => {
  it("is ready when every commit is on origin", () => {
    expect(forkBranchState(pushed)).toEqual({ kind: "ready", branch: "fix/login" });
  });

  it("asks for a push when the branch has no upstream or is ahead", () => {
    expect(forkBranchState({ ...pushed, hasUpstream: false })).toMatchObject({
      kind: "blocked",
      canPush: true,
    });
    expect(forkBranchState({ ...pushed, aheadCount: 2 })).toEqual({
      kind: "blocked",
      reason: "Push fix/login first. 2 commits are not on origin yet.",
      canPush: true,
    });
  });

  it("cannot fork a detached HEAD", () => {
    expect(forkBranchState({ ...pushed, refName: null })).toMatchObject({
      kind: "blocked",
      canPush: false,
    });
  });
});

describe("forkModelSelection", () => {
  const provider = (instanceId: string, models: ReadonlyArray<string>) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    status: "ready" as const,
    models: models.map((slug, index) => ({ slug, name: slug, isDefault: index === 0 })),
  });
  const selection = {
    instanceId: ProviderInstanceId.make("claude-laptop"),
    model: "opus",
    options: [{ id: "effort", value: "max" }],
  };
  const sourceProviders = [provider("claude-laptop", ["opus"])];

  it("keeps the model and options on another instance of the same provider", () => {
    expect(
      forkModelSelection({
        selection,
        sourceProviders,
        targetProviders: [provider("claude-box", ["opus"])],
      }),
    ).toEqual({ ...selection, instanceId: "claude-box" });
  });

  it("falls back to the target's default model without the options", () => {
    expect(
      forkModelSelection({
        selection,
        sourceProviders,
        targetProviders: [provider("claude-box", ["sonnet"])],
      }),
    ).toEqual({ instanceId: "claude-box", model: "sonnet" });
  });
});
