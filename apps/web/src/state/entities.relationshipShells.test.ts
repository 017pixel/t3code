import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { deriveThreadRelationshipGraph } from "@t3tools/client-runtime/state/thread-relationships";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { selectThreadRelationshipShells } from "./entities";

type Projection = Parameters<typeof selectThreadRelationshipShells>[1];

const shell = (id: string, parentThreadId: string | null = null) =>
  ({
    id,
    forkedFrom: null,
    deletedAt: null,
    lineage: { parentThreadId, relationshipToParent: parentThreadId === null ? null : "fork" },
  }) as unknown as OrchestrationV2ThreadShell;

const threadId = "current" as OrchestrationV2ThreadShell["id"];

describe("selectThreadRelationshipShells", () => {
  it("keeps the thread, its parent, its children and the threads its projection names", () => {
    const threads = [
      shell("current", "parent"),
      shell("parent"),
      shell("child", "current"),
      shell("subagent-child"),
      shell("workflow-member"),
      shell("transfer-source"),
      shell("unrelated"),
      shell("grandchild", "child"),
    ];
    const projection = {
      thread: threads[0],
      subagents: [
        {
          childThreadId: "subagent-child",
          workflow: { agents: [{ childThreadId: "workflow-member" }, {}] },
        },
        { childThreadId: null },
      ],
      contextTransfers: [{ sourceThreadId: "transfer-source", targetThreadId: "current" }],
    } as unknown as Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "subagents" | "contextTransfers"
    >;

    expect(
      selectThreadRelationshipShells(threadId, projection, threads).map((thread) => thread.id),
    ).toEqual([
      "current",
      "parent",
      "child",
      "subagent-child",
      "workflow-member",
      "transfer-source",
    ]);
  });

  it.each([false, true])(
    "retains an ordinary opener and its deletion update with projection loaded: %s",
    (loaded) => {
      const opener = shell("opener");
      const current = {
        ...shell("current"),
        createdBy: "agent" as const,
        openedByThreadId: opener.id,
      };
      const projection = loaded
        ? ({ thread: current, subagents: [], contextTransfers: [] } as unknown as Projection)
        : null;
      const currentShell = loaded ? shell("current") : current;
      const unrelated = shell("unrelated");
      const threads = [currentShell, opener, unrelated];
      const selected = selectThreadRelationshipShells(threadId, projection, threads);

      expect(selected).toEqual([currentShell, opener]);
      expect(deriveThreadRelationshipGraph({ threads: selected, projection: null }).edges).toEqual(
        [],
      );

      const deletedOpener = { ...opener, deletedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z") };
      expect(
        selectThreadRelationshipShells(threadId, projection, [
          currentShell,
          deletedOpener,
          unrelated,
        ])[1],
      ).toBe(deletedOpener);
      expect(selectThreadRelationshipShells(threadId, projection, [currentShell])).toEqual([
        currentShell,
      ]);
    },
  );

  it("finds the parent from the shell before the projection loads", () => {
    const threads = [shell("current", "parent"), shell("parent"), shell("unrelated")];
    expect(
      selectThreadRelationshipShells(threadId, null as Projection, threads).map(
        (thread) => thread.id,
      ),
    ).toEqual(["current", "parent"]);
  });
});
