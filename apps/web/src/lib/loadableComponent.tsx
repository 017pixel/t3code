import { createElement, useEffect, useState, type ComponentType } from "react";

import { preloadSpeculatively } from "./chunkReloadGuard";

/** Load on demand without Suspense's minimum fallback reveal delay. */
export function loadableComponent<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
) {
  let loaded: ComponentType<Props> | null = null;
  const resolve = () => load().then((module) => (loaded = module.default));

  function Loadable(props: Props) {
    const [component, setComponent] = useState(() => loaded);
    const [failure, setFailure] = useState<{ error: unknown } | null>(null);
    useEffect(() => {
      if (component !== null) return;
      let active = true;
      // A real use imports again, so a failed speculative load cannot claim it.
      void resolve().then(
        (value) => {
          if (active) setComponent(() => value);
        },
        (error: unknown) => {
          if (active) setFailure({ error });
        },
      );
      return () => {
        active = false;
      };
    }, [component]);
    if (failure !== null) throw failure.error;
    return component === null ? null : createElement(component, props);
  }

  return { Component: Loadable, preload: () => preloadSpeculatively(resolve) };
}

/** Warm one surface at a time, after the editable composer has painted. */
export function preloadAfterComposer(loads: ReadonlyArray<() => Promise<unknown>>) {
  let stopped = false;
  let frame = 0;
  let idle = 0;
  let timer = 0;
  const queue = [...loads];
  const next = () => {
    if (stopped || queue.length === 0) return;
    const run = () => {
      if (stopped || document.visibilityState !== "visible") return;
      const load = queue.shift();
      if (load)
        void load()
          .catch(() => undefined)
          .finally(next);
    };
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(run);
    else timer = window.setTimeout(run, 50);
  };
  const observer = new MutationObserver(ready);
  function ready() {
    if (!document.querySelector('[contenteditable="true"]')) return;
    observer.disconnect();
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(next);
    });
  }
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["contenteditable"],
  });
  ready();
  const stop = () => {
    stopped = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    if (idle) window.cancelIdleCallback(idle);
    clearTimeout(timer);
    window.removeEventListener("keydown", stop, true);
    window.removeEventListener("pointerdown", stop, true);
  };
  // Intent owns the main thread now; do not start unrelated surface work.
  window.addEventListener("keydown", stop, true);
  window.addEventListener("pointerdown", stop, true);
  return stop;
}
