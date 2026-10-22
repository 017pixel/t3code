// @effect-diagnostics nodeBuiltinImport:off - reads the installed native JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const renderState = source.slice(
    source.indexOf("function setInitialRenderState("),
    source.indexOf("// src/core/finishInitialScroll.ts"),
  );
  const watchdog = source.slice(
    source.indexOf("var INSET_END_SETTLE_WATCHDOG_FRAMES"),
    source.indexOf("function dispatchInitialScroll("),
  );
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>();
  const scrollTo = vi.fn();
  const onLoad = vi.fn();
  const state = {
    props: { data: ["message"], onLoad, drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 },
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
  };
  const ctx = { state };
  let contentSize = 1200;
  let inset = 100;
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n({ start: startInsetEndSettleWatchdog, complete: setInitialRenderState })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => inset,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
    },
  ) as {
    start: (context: typeof ctx) => void;
    complete: (context: typeof ctx, flags: Record<string, boolean>) => void;
  };
  return {
    state,
    scrollTo,
    onLoad,
    start: () => api.start(ctx),
    complete: () => api.complete(ctx, {}),
    ready: () => values.get("readyToRender") === true,
    resize: (size: number) => {
      contentSize = size;
    },
    setInset: (value: number) => {
      inset = value;
    },
    advance(count: number) {
      for (let index = 0; index < count; index++) {
        const batch = frames.splice(0);
        for (const frame of batch) frame();
      }
    },
  };
}

describe.each(["react-native.js", "react-native.mjs"])(
  "initial inset end reveal (%s)",
  (bundle) => {
    it("waits for the native offset instead of the optimistic scroll target", () => {
      const list = createList(bundle);
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 400 });
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("does not count an in-flight scroll as stability", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = 400;
      list.state.scrollingTo = { offset: 400 };
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.scrollingTo = undefined;
      list.state.maintainingScrollAtEnd = true;
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.maintainingScrollAtEnd = false;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("waits for a stable end target even when native scrolling follows each measurement", () => {
      const list = createList(bundle);
      list.start();
      for (let index = 0; index < 10; index++) {
        list.resize(1200 + index * 10);
        list.state.lastNativeScroll = 400 + index * 10;
        list.advance(1);
      }
      expect(list.ready()).toBe(false);
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("keeps the reveal bounded when native events never arrive", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = undefined;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.advance(32);
      expect(list.ready()).toBe(true);
    });

    it("releases control on drag and never starts another initial hold", () => {
      const list = createList(bundle);
      list.start();
      list.state.didUserDrag = true;
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.complete();
      list.start();
      list.advance(20);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });
  },
);

function createScrollToEndList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const section = (name: string) => {
    const start = source.indexOf(`// src/${name}\n`);
    return source.slice(start, source.indexOf("\n// src/", start + 1));
  };
  const code = [
    "utils/getId.ts",
    "core/updateContentMetricsState.ts",
    "core/addTotalSize.ts",
    "core/setSize.ts",
    "utils/helpers.ts",
    "utils/getItemSize.ts",
    "core/mvcp.ts",
  ]
    .map(section)
    .join("\n");
  const rowSize = 900;
  const ids = Array.from({ length: 150 }, (_, index) => `row-${index}`);
  const values = new Map<string, unknown>();
  const requestAdjust = vi.fn();
  const state = {
    props: {
      data: ids,
      keyExtractor: (id: string) => id,
      estimatedItemSize: 90,
      maintainVisibleContentPosition: { data: true, size: true },
    },
    idCache: [] as unknown[],
    indexByKey: new Map(ids.map((id, index) => [id, index])),
    positions: ids.map((_, index) => index * rowSize),
    sizes: new Map(ids.map((id) => [id, rowSize])),
    sizesKnown: new Map(ids.map((id) => [id, rowSize])),
    averageSizes: { "": { avg: rowSize, num: ids.length } },
    idsInView: ids.slice(140),
    didContainersLayout: true,
    totalSize: ids.length * rowSize,
    scroll: 5000,
    scrollLength: 800,
    // In flight from `scrollToEnd({ animated: true })`.
    scrollingTo: { index: ids.length - 1, viewPosition: 1, itemSize: rowSize, offset: 134200 },
  };
  const ctx = { state, values, scrollAxisGap: 0 };
  const api = NodeVM.runInNewContext(`${code}\n({ prepareMVCP })`, {
    Platform: { OS: "web" },
    IS_DEV: false,
    IsNewArchitecture: true,
    peek$: (_ctx: unknown, key: string) => values.get(key),
    set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
    getContentSize: () => state.totalSize,
    getContentInsetEnd: () => 0,
    requestAdjust,
  }) as { prepareMVCP: (context: typeof ctx, dataChanged: boolean) => (() => void) | undefined };
  return {
    state,
    requestAdjust,
    removeLastRow() {
      const data = ids.slice(0, -1);
      state.props.data = data;
      state.indexByKey = new Map(data.map((id, index) => [id, index]));
      state.idsInView = state.idsInView.filter((id) => state.indexByKey.has(id));
      state.sizes.delete(ids.at(-1)!);
      state.sizesKnown.delete(ids.at(-1)!);
      state.positions = state.positions.slice(0, -1);
      state.totalSize -= rowSize;
    },
    prepareMVCP: (dataChanged: boolean) => api.prepareMVCP(ctx, dataChanged),
  };
}

describe.each(["react.js", "react.mjs", "react-native.js", "react-native.mjs"])(
  "scrollToEnd while data shrinks (%s)",
  (bundle) => {
    it("keeps the total size when the in-flight scroll target index is past the end", () => {
      const list = createScrollToEndList(bundle);
      list.removeLastRow();
      list.prepareMVCP(true)?.();
      expect(list.state.totalSize).toBe(149 * 900);
    });
  },
);
