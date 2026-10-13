import type { ComponentProps } from "react";
import { preloadSpeculatively } from "../lib/chunkReloadGuard";
import { loadableComponent } from "../lib/loadableComponent";

export const commandPaletteSurface = loadableComponent<
  ComponentProps<(typeof import("./CommandPalette"))["CommandPaletteDialog"]>
>(() => import("./CommandPalette").then((module) => ({ default: module.CommandPaletteDialog })));
export const terminalDrawerSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./ThreadTerminalDrawer"))["default"]>>
> = loadableComponent(() => import("./ThreadTerminalDrawer"));
export const diffPanelSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./DiffPanel"))["default"]>>
> = loadableComponent(() => import("./DiffPanel"));
export const filePreviewSurface: ReturnType<
  typeof loadableComponent<ComponentProps<(typeof import("./files/FilePreviewPanel"))["default"]>>
> = loadableComponent(() => import("./files/FilePreviewPanel"));

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
