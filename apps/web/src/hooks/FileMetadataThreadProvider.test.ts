import { describe, expect, it } from "vite-plus/test";

import { changedCheckpointPaths } from "./FileMetadataThreadProvider";

const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe("changedCheckpointPaths", () => {
  it("skips checkpoints whose files and status are unchanged", () => {
    const shared = files("src/a.ts");
    expect(
      changedCheckpointPaths(
        [{ id: "c1", status: "ready", files: shared }],
        [{ id: "c1", status: "ready", files: shared }],
        "/repo",
      ),
    ).toEqual([]);
  });

  it("covers old and new files of a changed checkpoint, a new one and a removed one", () => {
    expect(
      changedCheckpointPaths(
        [
          { id: "c1", status: "capturing", files: files("src/a.ts") },
          { id: "gone", status: "ready", files: files("src/old.ts") },
        ],
        [
          { id: "c1", status: "ready", files: files("src/b.ts") },
          { id: "c2", status: "ready", files: files("src/c.ts") },
        ],
        "/repo",
      ).toSorted(),
    ).toEqual(["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts", "/repo/src/old.ts"]);
  });
});
