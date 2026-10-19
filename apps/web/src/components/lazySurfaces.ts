import { createElement, useEffect, useState, type ComponentProps, type ComponentType } from "react";
import { loadOnDemand, preloadSpeculatively } from "../lib/chunkReloadGuard";

export const terminalDrawerSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./ThreadTerminalDrawer"))["default"]>>
> = loadableComponent(() => import("./ThreadTerminalDrawer"));
export const diffPanelSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./DiffPanel"))["default"]>>
> = loadableComponent(() => import("./DiffPanel"));

/** Warm assets without mounting a terminal or opening a shell. */
export async function preloadTerminalDrawer(): Promise<void> {
  await Promise.all([
    terminalDrawerSurface.preload(),
    preloadSpeculatively(() =>
      import("../terminal/ghostty/surface").then(({ preloadTerminalAssets }) =>
        preloadTerminalAssets(),
      ),
    ),
  ]);
}

/** Load on demand without Suspense delaying the reveal after the module arrives. */
function loadableComponent<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
) {
  let loaded: ComponentType<Props> | null = null;
  let loading: Promise<ComponentType<Props>> | null = null;
  const resolve = () => {
    if (loaded !== null) return Promise.resolve(loaded);
    loading ??= load()
      .then((module) => (loaded = module.default))
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  function Loadable(props: Props) {
    const [result, setResult] = useState<
      { component: ComponentType<Props> } | { error: unknown } | null
    >(() => (loaded === null ? null : { component: loaded }));
    useEffect(() => {
      if (result !== null) return;
      let mounted = true;
      void loadOnDemand(resolve).then(
        (component) => {
          if (mounted) setResult({ component });
        },
        (error: unknown) => {
          if (mounted) setResult({ error });
        },
      );
      return () => {
        mounted = false;
      };
    }, [result]);
    if (result !== null && "error" in result) throw result.error;
    return result === null ? null : createElement(result.component, props);
  }

  return { Component: Loadable, preload: () => preloadSpeculatively(resolve) };
}
