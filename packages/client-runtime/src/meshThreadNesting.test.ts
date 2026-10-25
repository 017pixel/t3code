import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { type MeshNestableThread, nestMeshChildren } from "./meshThreadNesting.ts";

const X = EnvironmentId.make("x");
const Y = EnvironmentId.make("y");
const Z = EnvironmentId.make("z");

const thread = (
  environmentId: EnvironmentId,
  id: string,
  origin?: { readonly environmentId: EnvironmentId; readonly threadId: string | null },
): MeshNestableThread => ({
  environmentId,
  id: ThreadId.make(id),
  source:
    origin === undefined
      ? { id: ThreadId.make(id) }
      : {
          id: ThreadId.make(id),
          meshOrigin: {
            environmentId: origin.environmentId,
            threadId: origin.threadId === null ? null : ThreadId.make(origin.threadId),
          },
        },
});

const ids = (threads: ReadonlyArray<MeshNestableThread>) => threads.map((entry) => entry.id);
const key = (environmentId: EnvironmentId, id: string) => `${environmentId}:${id}`;

describe("nestMeshChildren", () => {
  it("returns a list with no thread from another machine unchanged", () => {
    const threads = [
      thread(X, "a"),
      thread(Y, "b"),
      thread(X, "c", { environmentId: X, threadId: "a" }),
    ];
    const nesting = nestMeshChildren(threads);
    expect(nesting.roots).toBe(threads);
    expect(nesting.childrenByParentKey.size).toBe(0);
  });

  it("lists a remote child under its parent", () => {
    const parent = thread(X, "parent");
    const child = thread(Y, "child", { environmentId: X, threadId: "parent" });
    const other = thread(Y, "other");
    const nesting = nestMeshChildren([child, parent, other]);
    expect(ids(nesting.roots)).toEqual(["parent", "other"]);
    expect(ids(nesting.childrenByParentKey.get(key(X, "parent")) ?? [])).toEqual(["child"]);
  });

  it("keeps a child on its own when its parent is not listed or has no thread", () => {
    const orphan = thread(Y, "orphan", { environmentId: X, threadId: "archived" });
    const fromMcp = thread(Y, "from-mcp", { environmentId: X, threadId: null });
    expect(ids(nestMeshChildren([orphan, fromMcp]).roots)).toEqual(["orphan", "from-mcp"]);
  });

  it("puts a grandchild under the top-level ancestor", () => {
    const parent = thread(X, "parent");
    const child = thread(Y, "child", { environmentId: X, threadId: "parent" });
    const grandchild = thread(Z, "grandchild", { environmentId: Y, threadId: "child" });
    const nesting = nestMeshChildren([grandchild, child, parent]);
    expect(ids(nesting.roots)).toEqual(["parent"]);
    expect(ids(nesting.childrenByParentKey.get(key(X, "parent")) ?? [])).toEqual([
      "grandchild",
      "child",
    ]);
  });

  it("keeps a cycle top-level", () => {
    const a = thread(X, "a", { environmentId: Y, threadId: "b" });
    const b = thread(Y, "b", { environmentId: X, threadId: "a" });
    const nesting = nestMeshChildren([a, b]);
    expect(ids(nesting.roots)).toEqual(["a", "b"]);
    expect(nesting.childrenByParentKey.size).toBe(0);
  });
});
