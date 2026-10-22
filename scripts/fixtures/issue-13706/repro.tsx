import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

type Row = { id: number };
type Target = { index?: number; viewPosition?: number; itemSize?: number };
type ObservedState = {
  scrollingTo?: Target;
  totalSize: number;
  scroll: number;
  scrollLength: number;
  props: { data: Row[] };
  sizes: Map<string, number>;
};
type Fiber = {
  return?: Fiber;
  memoizedState?: { memoizedState?: { state?: ObservedState } };
};

const rows = () => Array.from({ length: 150 }, (_, id) => ({ id }));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.style.colorScheme = dark ? "dark" : "light";
document.body.style.cssText = `margin:0;font:16px/1.25 monospace;background:${dark ? "#171717" : "#fff"};color:${dark ? "#eee" : "#111"}`;

function App() {
  const ref = useRef<LegendListRef>(null);
  const [data, setData] = useState(rows);
  const [lastHeight, setLastHeight] = useState(900);
  const [mvcp, setMvcp] = useState({ data: true, size: true });
  const output = useRef<HTMLOutputElement>(null);
  const recordingState = useRef({ trace: [] as Record<string, unknown>[], started: 0 });

  // Observe the real development dependency, without modifying its state or copying its algorithm.
  const internal = () => {
    const element = ref.current?.getScrollableNode() as HTMLElement & Record<string, unknown>;
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber"));
    let fiber = key ? (element[key] as Fiber | undefined) : undefined;
    while (fiber) {
      const state = fiber.memoizedState?.memoizedState?.state;
      if (state?.sizes instanceof Map && state.props) return state;
      fiber = fiber.return;
    }
    throw new Error("Development React state unavailable; do not infer active target from props.");
  };
  const sample = (phase: string) => {
    const state = internal();
    const element = ref.current?.getScrollableNode() as HTMLElement;
    const target = state.scrollingTo;
    const result = {
      phase,
      ms: +(performance.now() - recordingState.current.started).toFixed(3),
      count: state.props.data.length,
      target: target ? { ...target } : null,
      targetId:
        target?.index === undefined ? undefined : (state.props.data[target.index]?.id ?? null),
      total: state.totalSize,
      measured: state.sizes.size,
      scroll: state.scroll,
      viewport: state.scrollLength,
      domScroll: element.scrollTop,
      domHeight: element.scrollHeight,
      endDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
    };
    recordingState.current.trace.push(result);
    if (output.current)
      output.current.textContent = `${phase} | rows ${result.count} | total ${result.total.toFixed(0)} | scroll ${result.domScroll.toFixed(0)} | end Δ ${result.endDistance.toFixed(0)}`;
    return result;
  };
  const prepare = async (warm = true) => {
    flushSync(() => {
      setData(rows());
      setLastHeight(900);
      setMvcp({ data: true, size: true });
    });
    await delay(300);
    if (warm) {
      // Public sizing API pins known fixture geometry, avoiding viewport-dependent estimate totals.
      for (let id = 0; id < 150; id++)
        ref.current?.setItemSize(String(id), { height: 900, width: innerWidth });
    }
    await delay(300);
    ref.current?.scrollToOffset({ offset: 5000, animated: false });
    await delay(300);
    recordingState.current.started = performance.now();
    recordingState.current.trace.length = 0;
    return sample("ready");
  };
  const run = async (
    options: {
      delayMs?: number;
      animated?: boolean;
      action?: "shrink" | "resize";
      viewPosition?: number;
      data?: boolean;
      size?: boolean;
    } = {},
  ) => {
    const { delayMs = 150, animated = true, action = "shrink", viewPosition, ...gates } = options;
    if (gates.data !== undefined || gates.size !== undefined) {
      flushSync(() => setMvcp({ data: gates.data ?? true, size: gates.size ?? true }));
      await nextFrame();
    }
    recordingState.current.started = performance.now();
    recordingState.current.trace.length = 0;
    sample("start");
    if (viewPosition === undefined) ref.current?.scrollToEnd({ animated });
    else ref.current?.scrollToIndex({ index: 149, viewPosition, animated });
    sample("dispatched");
    let recording = true;
    const frame = () => {
      if (recording) {
        sample("frame");
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
    setTimeout(() => {
      sample("before-mutation");
      flushSync(() => {
        if (action === "resize") setLastHeight(1000);
        else setData((current) => current.slice(0, -1));
      });
      sample("after-mutation");
    }, delayMs);
    await delay(2400);
    recording = false;
    await nextFrame();
    sample("settled");
    return recordingState.current.trace;
  };
  useEffect(() => {
    Object.assign(window, {
      repro: {
        ref,
        prepare,
        run,
        sample,
        trace: recordingState.current.trace,
        environment: () => ({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          font: getComputedStyle(document.body).font,
          fonts: document.fonts.status,
          theme: dark ? "dark" : "light",
          frozenDisplayClock: "2026-10-22T12:00:00.000Z",
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
          visualScale: visualViewport?.scale,
        }),
      },
    });
  });
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{ height: 100, flexShrink: 0, padding: 8, boxSizing: "border-box", fontSize: 14 }}
      >
        <div>LegendList dependency harness · 2026-10-22 12:00 UTC</div>
        <div>150 × 900px · estimate 90 · MVCP data + size</div>
        <button onClick={() => void prepare()}>Prepare offset 5000</button>{" "}
        <button onClick={() => void run()}>Animate end + shrink at 150ms</button>
        <div>
          <output ref={output}>Ready to prepare</output>
        </div>
      </header>
      <LegendList
        ref={ref}
        data={data}
        keyExtractor={(item) => String(item.id)}
        estimatedItemSize={90}
        initialScrollAtEnd
        maintainVisibleContentPosition={mvcp}
        renderItem={({ item }) => (
          <div
            style={{
              height: item.id === 149 ? lastHeight : 900,
              boxSizing: "border-box",
              borderBottom: `1px solid ${dark ? "#777" : "#333"}`,
              background: dark
                ? item.id % 2
                  ? "#242424"
                  : "#303030"
                : item.id % 2
                  ? "#ddd"
                  : "#eee",
            }}
          >
            Row {item.id}
          </div>
        )}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App />);
