import { parseNewThreadLink } from "@t3tools/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import {
  promptLinkSearchFromParams,
  stepPendingPromptLink,
  withoutPromptLinkParams,
} from "./prompt-link-model";

describe("promptLinkSearchFromParams", () => {
  it("round-trips decoded route params into the shared parser", () => {
    const search = promptLinkSearchFromParams({
      prompt: "Fix the bug & add tests = done?",
      repo: ["pingdotgg/t3code", "ignored/second"],
      provider: "codex",
      screen: "NewTask",
    });

    expect(parseNewThreadLink(search ?? "")).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Fix the bug & add tests = done?", hiddenCharacters: 0 },
        repository: { owner: "pingdotgg", name: "t3code" },
        provider: "codex",
        model: null,
      },
    });
  });
});

describe("stepPendingPromptLink", () => {
  const waiting = { search: "repo=t3tools%2Ft3code", arrived: false };

  it("waits for the link's screen before it can be abandoned", () => {
    expect(stepPendingPromptLink(waiting, { screenOnStack: false, shellsSettled: true })).toEqual({
      pending: waiting,
      resolve: null,
    });
  });

  it("holds an arrived link until the shells settle, then resolves it once", () => {
    const arrived = stepPendingPromptLink(waiting, { screenOnStack: true, shellsSettled: false });
    expect(arrived).toEqual({ pending: { ...waiting, arrived: true }, resolve: null });
    expect(
      stepPendingPromptLink(arrived.pending!, { screenOnStack: true, shellsSettled: true }),
    ).toEqual({ pending: null, resolve: waiting.search });
  });

  it("drops a link whose screen was left while the shells were loading", () => {
    expect(
      stepPendingPromptLink(
        { ...waiting, arrived: true },
        { screenOnStack: false, shellsSettled: false },
      ),
    ).toEqual({ pending: null, resolve: null });
  });
});

describe("withoutPromptLinkParams", () => {
  it("keeps the route's other params", () => {
    expect(withoutPromptLinkParams({ prompt: "hi", repo: "a/b", incomingShareId: "1" })).toEqual({
      incomingShareId: "1",
    });
  });
});
