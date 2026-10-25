import {
  HTML_RENDER_DEFAULT_FONTS,
  htmlRenderTheme,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { useSyncExternalStore } from "react";

import { appearanceFontStack } from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  subscribeToCustomThemes,
  themeColorToHex,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { getClientSettingsSnapshot, subscribeClientSettings } from "./useSettings";
import { getThemeSnapshot, subscribeTheme } from "./useTheme";

function resolveActiveThemeColors(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
) {
  const definition = getThemeDefinition(resolveThemeHalf(theme, halves, appearance));
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? definition.colors);
}

/**
 * Frames post the theme from their own subscription, so a theme change reaches a
 * page without waiting for the component that owns the frame to re-render.
 */
let themeDirty = true;

export function subscribeHtmlRenderTheme(listener: () => void): () => void {
  // Mark dirty before notifying, so a listener that reads the theme never sees the
  // cached one regardless of the order source listeners run in.
  const onChange = () => {
    themeDirty = true;
    listener();
  };
  const unsubscribers = [
    subscribeTheme(onChange),
    // Custom and published palettes can be edited in place, under an unchanged preference.
    subscribeToCustomThemes(onChange),
    subscribeClientSettings(onChange),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

function computeHtmlRenderTheme(): HtmlRenderTheme {
  const { theme, resolvedTheme, themeHalves } = getThemeSnapshot();
  const colors = resolveActiveThemeColors(theme, themeHalves, resolvedTheme);
  const settings = getClientSettingsSnapshot();
  return htmlRenderTheme(
    Object.fromEntries(
      Object.entries(colors).map(([role, color]) => [role, themeColorToHex(color) ?? color]),
    ) as typeof colors,
    resolvedTheme,
    {
      sans: appearanceFontStack(settings.fontFamilySans, HTML_RENDER_DEFAULT_FONTS.sans),
      mono: appearanceFontStack(settings.fontFamilyCode, HTML_RENDER_DEFAULT_FONTS.mono),
    },
  );
}

// getHtmlRenderTheme is every frame's getSnapshot, so reads return the cached theme and
// only a source emit rebuilds it. A watcher installed on first read keeps the flag right
// for reads with no subscriber; it stays for the page's lifetime.
let cachedTheme: { readonly key: string; readonly theme: HtmlRenderTheme } | null = null;
let watchingThemeSources = false;

export function getHtmlRenderTheme(): HtmlRenderTheme {
  if (!watchingThemeSources) {
    watchingThemeSources = true;
    subscribeHtmlRenderTheme(() => {});
  }
  if (cachedTheme === null || themeDirty) {
    themeDirty = false;
    const next = computeHtmlRenderTheme();
    // Unrelated settings writes emit too; an equal theme keeps its identity.
    const key = JSON.stringify(next);
    if (cachedTheme?.key !== key) cachedTheme = { key, theme: next };
  }
  return cachedTheme.theme;
}

const serverTheme = htmlRenderTheme(getStandardThemeColors("light"), "light");

export function useHtmlRenderTheme(): HtmlRenderTheme {
  return useSyncExternalStore(subscribeHtmlRenderTheme, getHtmlRenderTheme, () => serverTheme);
}
