import { describe, expect, it } from "vite-plus/test";

import type { PreviewViewportSetting } from "@t3tools/contracts";

import { queueBrowserViewportCommit } from "./browserViewportActions";

describe("browserViewportActions", () => {
  it("commits viewport changes in order for each tab", async () => {
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const calls: Array<number> = [];
    const resize = async (setting: PreviewViewportSetting) => {
      if (setting._tag === "fill") return;
      calls.push(setting.width);
      if (setting.width === 800) {
        markFirstStarted?.();
        await firstPending;
      }
    };

    const first = queueBrowserViewportCommit("tab-serial", () =>
      resize({ _tag: "freeform", width: 800, height: 600 }),
    );
    const second = queueBrowserViewportCommit("tab-serial", () =>
      resize({ _tag: "freeform", width: 900, height: 700 }),
    );
    await firstStarted;
    expect(calls).toEqual([800]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual([800, 900]);
  });
});
