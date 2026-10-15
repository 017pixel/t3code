import { describe, expect, it, vi } from "vite-plus/test";

import { reloadOnceForChunkLoadError } from "./chunkReloadGuard";

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const BUILD_A = "https://app.t3.codes/assets/index-A.js";
const BUILD_B = "https://app.t3.codes/assets/index-B.js";
const failedImport = (asset: string) =>
  `TypeError: Failed to fetch dynamically imported module: https://app.t3.codes/assets/${asset}`;

describe("reloadOnceForChunkLoadError", () => {
  it("reloads once for a chunk that fails on every boot, then lets it surface", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chat-1.js"), () => storage, reload),
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // Every later boot requests the same failing chunk during its first render.
    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chat-1.js"), () => storage, reload),
    ).toBe(false);
    expect(
      reloadOnceForChunkLoadError(BUILD_B, failedImport("chat-1.js"), () => storage, reload),
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("gives later builds their own reloads after the previous build exhausts its limit", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    for (const build of [BUILD_A, BUILD_B]) {
      for (let index = 0; index < 20; index += 1) {
        expect(
          reloadOnceForChunkLoadError(
            build,
            failedImport(`chunk-${index}.js`),
            () => storage,
            reload,
          ),
        ).toBe(true);
      }
      expect(
        reloadOnceForChunkLoadError(build, failedImport("chunk-20.js"), () => storage, reload),
      ).toBe(false);
    }
    expect(reload).toHaveBeenCalledTimes(40);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadOnceForChunkLoadError(BUILD_B, failedImport("chat-1.js"), blocked, reload)).toBe(
      false,
    );
    expect(reload).not.toHaveBeenCalled();
  });
});
