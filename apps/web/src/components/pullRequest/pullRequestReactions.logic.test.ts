import type {
  PullRequestDetail,
  PullRequestReaction,
  PullRequestReactionContent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingPullRequestReactions,
  canReactPullRequestComment,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
} from "./pullRequestReactions.logic";

describe("comment reaction permissions", () => {
  it("excludes GitLab review system notes while preserving supported comment reactions", () => {
    const detail = {
      provider: "gitlab",
      capabilities: {
        diff: true,
        comment: true,
        actions: [],
        mergeMethods: [],
        search: true,
        reactions: true,
        review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
        reviewers: { request: true, listCandidates: true },
      },
    } satisfies Pick<PullRequestDetail, "provider" | "capabilities">;

    expect(canReactPullRequestComment(detail, { kind: "issue-comment" })).toBe(true);
    expect(canReactPullRequestComment(detail, { kind: "review-comment" })).toBe(true);
    expect(canReactPullRequestComment({ ...detail, provider: "github" }, { kind: "review" })).toBe(
      true,
    );
    expect(
      canReactPullRequestComment(
        { ...detail, capabilities: { ...detail.capabilities, reactions: false } },
        { kind: "issue-comment" },
      ),
    ).toBe(false);
    expect(
      canReactPullRequestComment(
        { ...detail, capabilities: { ...detail.capabilities, reactions: undefined } },
        { kind: "issue-comment" },
      ),
    ).toBe(false);
    expect(canReactPullRequestComment(detail, { kind: "review" })).toBe(false);
  });
});

function reaction(overrides: Partial<PullRequestReaction> = {}): PullRequestReaction {
  return {
    content: "heart",
    count: 1,
    actors: ["octocat"],
    viewerHasReacted: false,
    ...overrides,
  };
}

describe("reaction presentation", () => {
  it("names and draws all eight, in GitHub's picker order", () => {
    expect(PULL_REQUEST_REACTION_ORDER).toEqual([
      "thumbs-up",
      "thumbs-down",
      "laugh",
      "hooray",
      "confused",
      "heart",
      "rocket",
      "eyes",
    ]);
    expect(PULL_REQUEST_REACTION_ORDER.map(pullRequestReactionEmoji)).toEqual([
      "👍",
      "👎",
      "😄",
      "🎉",
      "😕",
      "❤️",
      "🚀",
      "👀",
    ]);
    expect(pullRequestReactionName("thumbs-up")).toBe("thumbs up");
    expect(pullRequestReactionName("eyes")).toBe("eyes");
  });
});

describe("reaction tooltip", () => {
  it("reads as GitHub's sentence for one, two and three names", () => {
    expect(
      pullRequestReactionTooltip(reaction({ content: "thumbs-up", count: 1, actors: ["Bil0000"] })),
    ).toBe("Bil0000 reacted with thumbs up emoji");
    expect(pullRequestReactionTooltip(reaction({ count: 2, actors: ["Bil0000", "octocat"] }))).toBe(
      "Bil0000 and octocat reacted with heart emoji",
    );
    expect(
      pullRequestReactionTooltip(
        reaction({
          content: "eyes",
          count: 3,
          actors: ["Bil0000", "octocat"],
          viewerHasReacted: true,
        }),
      ),
    ).toBe("You, Bil0000, and octocat reacted with eyes emoji");
  });

  it("counts everyone past the third name, including the ones the host never named", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({
          content: "rocket",
          count: 15,
          actors: ["a", "b", "c", "d"],
          viewerHasReacted: true,
        }),
      ),
    ).toBe("You, a, b, and 12 others reacted with rocket emoji");
    expect(pullRequestReactionTooltip(reaction({ count: 2, actors: ["octocat"] }))).toBe(
      "octocat and 1 other reacted with heart emoji",
    );
    expect(pullRequestReactionTooltip(reaction({ count: 4, actors: [] }))).toBe(
      "4 people reacted with heart emoji",
    );
    expect(pullRequestReactionTooltip(reaction({ count: 1, actors: [] }))).toBe(
      "1 person reacted with heart emoji",
    );
  });

  it("names the viewer as You, ahead of the other people who reacted", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 3, actors: ["Bil0000", "octocat"], viewerHasReacted: true }),
      ),
    ).toBe("You, Bil0000, and octocat reacted with heart emoji");
  });

  it("names nobody as You when the viewer has not reacted", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 2, actors: ["Bil0000", "octocat"], viewerHasReacted: false }),
      ),
    ).toBe("Bil0000 and octocat reacted with heart emoji");
  });

  it("names actors as given, and leaves off You, for a host with no room for the viewer", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 2, actors: ["Bil0000", "octocat"], viewerHasReacted: true }),
      ),
    ).toBe("Bil0000 and octocat reacted with heart emoji");
    expect(
      pullRequestReactionTooltip(
        reaction({
          count: 4,
          actors: ["Bil0000", "octocat", "hubot", "zzz"],
          viewerHasReacted: true,
        }),
      ),
    ).toBe("Bil0000, octocat, hubot, and 1 other reacted with heart emoji");
  });

  it("keeps naming the viewer You when the host does leave them room", () => {
    expect(
      pullRequestReactionTooltip(
        reaction({ count: 2, actors: ["octocat"], viewerHasReacted: true }),
      ),
    ).toBe("You and octocat reacted with heart emoji");
  });
});

describe("reaction tooltip, with a reaction in flight", () => {
  it("still says You after an optimistic react, even at full capacity", () => {
    const applied = applyPendingPullRequestReactions(
      [reaction({ count: 2, actors: ["a", "b"], viewerHasReacted: false })],
      new Map([["heart", true] as const]),
    );
    expect(pullRequestReactionTooltip(applied[0]!)).toBe("You, a, and b reacted with heart emoji");
  });

  it("drops You after an optimistic un-react, without treating the host as non-compliant", () => {
    const applied = applyPendingPullRequestReactions(
      [reaction({ count: 2, actors: ["octocat"], viewerHasReacted: true })],
      new Map([["heart", false] as const]),
    );
    expect(pullRequestReactionTooltip(applied[0]!)).toBe("octocat reacted with heart emoji");
  });
});

describe("pending reactions", () => {
  const pending = (
    entries: ReadonlyArray<readonly [PullRequestReactionContent, boolean]>,
  ): ReadonlyMap<PullRequestReactionContent, boolean> => new Map(entries);

  it("returns the host's list untouched while nothing is in flight", () => {
    const reactions = [reaction()];
    expect(applyPendingPullRequestReactions(reactions, pending([]))).toBe(reactions);
  });

  it("adds a reaction nobody had yet, in picker order", () => {
    const applied = applyPendingPullRequestReactions(
      [reaction({ content: "rocket", count: 2, actors: ["a", "b"] })],
      pending([["thumbs-up", true]]),
    );
    expect(applied).toEqual([
      { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
      { content: "rocket", count: 2, actors: ["a", "b"], viewerHasReacted: false },
    ]);
  });

  it("joins and leaves an existing reaction, and drops the pill nobody is left on", () => {
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"] })],
        pending([["heart", true]]),
      ),
    ).toEqual([{ content: "heart", count: 3, actors: ["a", "b"], viewerHasReacted: true }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 2, actors: ["a", "b"], viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([{ content: "heart", count: 1, actors: ["a", "b"], viewerHasReacted: false }]);
    expect(
      applyPendingPullRequestReactions(
        [reaction({ count: 1, viewerHasReacted: true })],
        pending([["heart", false]]),
      ),
    ).toEqual([]);
  });

  it("ignores a pending state the host has already caught up with", () => {
    const reactions = [reaction({ count: 3, viewerHasReacted: true })];
    expect(applyPendingPullRequestReactions(reactions, pending([["heart", true]]))).toEqual(
      reactions,
    );
    expect(applyPendingPullRequestReactions([], pending([["heart", false]]))).toEqual([]);
  });
});
