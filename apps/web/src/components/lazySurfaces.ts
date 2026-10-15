import { createElement, useEffect, useState, type ComponentProps, type ComponentType } from "react";
import { preloadSpeculatively } from "../lib/chunkReloadGuard";

export const commandPaletteSurface = loadableComponent<
  ComponentProps<(typeof import("./CommandPalette"))["CommandPaletteDialog"]>
>(() => import("./CommandPalette").then((module) => ({ default: module.CommandPaletteDialog })));
export const terminalDrawerSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./ThreadTerminalDrawer"))["default"]>>
> = loadableComponent(() => import("./ThreadTerminalDrawer"));
export const diffPanelSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./DiffPanel"))["default"]>>
> = loadableComponent(() => import("./DiffPanel"));
/** Only renderer assets; opening a PTY remains behind terminal intent. */
export const preloadTerminalDrawer = async (): Promise<void> => {
  await Promise.all([
    terminalDrawerSurface.preload(),
    preloadSpeculatively(() =>
      import("../terminal/ghostty/surface").then(({ preloadTerminalAssets }) =>
        preloadTerminalAssets(),
      ),
    ),
  ]);
};

/** Load on demand without Suspense's minimum fallback reveal delay. */
function loadableComponent<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
) {
  let loaded: ComponentType<Props> | null = null;
  const resolve = () => load().then((module) => (loaded = module.default));

  function Loadable(props: Props) {
    const [result, setResult] = useState<{ component: ComponentType<Props> } | { error: unknown } | null>(
      () => loaded === null ? null : { component: loaded },
    );
    useEffect(() => {
      if (result !== null) return;
      // Real use retries failed speculative imports.
      void resolve().then(
        (component) => setResult({ component }),
        (error: unknown) => setResult({ error }),
      );
    }, [result]);
    if (result !== null && "error" in result) throw result.error;
    return result === null ? null : createElement(result.component, props);
  }

  return { Component: Loadable, preload: () => preloadSpeculatively(resolve) };
}

/** Warm one surface per idle task after the composer paints. */
export function preloadAfterComposer(loads: ReadonlyArray<() => Promise<unknown>>) {
  let stopped = false;
  const queue = [...loads];
  const next = () => {
    if (stopped || document.visibilityState !== "visible") return;
    const load = queue.shift();
    if (!load) return;
    const run = () => { if (!stopped) void load().catch(() => undefined).finally(next); };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run);
    else window.setTimeout(run, 50);
  };
  const ready = () => {
    if (!document.querySelector('[contenteditable="true"]')) return;
    observer.disconnect();
    requestAnimationFrame(() => requestAnimationFrame(next));
  };
  const observer = new MutationObserver(ready);
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["contenteditable"] });
  ready();
  const stop = () => {
    stopped = true;
    observer.disconnect();
    window.removeEventListener("keydown", stop, true);
    window.removeEventListener("pointerdown", stop, true);
  };
  window.addEventListener("keydown", stop, true);
  window.addEventListener("pointerdown", stop, true);
  return stop;
}
