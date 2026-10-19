import { describe, expect, it, vi } from "vite-plus/test";

import {
  clearChunkReloadGuard,
  clearChunkReloadGuardAfterStartup,
  isChunkReloadScheduled,
  loadOnDemand,
  preloadSpeculatively,
  reloadOnceForChunkLoadError,
} from "./chunkReloadGuard";

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

describe("reloadOnceForChunkLoadError", () => {
  it("recovers once when a real import shares a hover preload's rejection", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", {
      sessionStorage: createStorageStub(),
      location: { reload },
    });
    try {
      expect(
        await preloadSpeculatively(() => Promise.reject(new Error("Hover preload failed"))),
      ).toBeUndefined();
      expect(reload).not.toHaveBeenCalled();

      const failure = new Error("Failed to fetch dynamically imported module");
      let rejectImport!: (reason: unknown) => void;
      const sharedImport = new Promise<never>((_, reject) => {
        rejectImport = reject;
      });
      const demand = loadOnDemand(() => sharedImport);
      const hover = preloadSpeculatively(() => sharedImport);
      const outcomes = Promise.allSettled([hover, demand]);
      rejectImport(failure);

      expect(await outcomes).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: failure },
      ]);
      await expect(demand).rejects.toBe(failure);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(isChunkReloadScheduled()).toBe(true);
      clearChunkReloadGuardAfterStartup();
      expect(reloadOnceForChunkLoadError()).toBe(false);

      await expect(loadOnDemand(() => Promise.reject(failure))).rejects.toBe(failure);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains recent recovery across a fresh boot and recovers after the cooldown", async () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    const startedAt = new Date("2026-10-19T00:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt);
    vi.stubGlobal("window", { sessionStorage: storage, location: { reload } });
    try {
      expect(reloadOnceForChunkLoadError()).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);

      expect(reloadOnceForChunkLoadError()).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);

      vi.setSystemTime(startedAt.getTime() + 1_000);
      vi.resetModules();
      const freshPage = await import("./chunkReloadGuard");
      freshPage.clearChunkReloadGuardAfterStartup();
      expect(freshPage.reloadOnceForChunkLoadError()).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);

      vi.setSystemTime(startedAt.getTime() + 31_000);
      expect(freshPage.reloadOnceForChunkLoadError()).toBe(true);
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("reloads again after manually clearing the guard", () => {
    const storage = createStorageStub();
    const reload = vi.fn();

    reloadOnceForChunkLoadError(() => storage, reload);
    clearChunkReloadGuard(() => storage);

    expect(reloadOnceForChunkLoadError(() => storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads when storage is blocked, so a persistent failure cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadOnceForChunkLoadError(blocked, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(() => clearChunkReloadGuard(blocked)).not.toThrow();
  });
});
