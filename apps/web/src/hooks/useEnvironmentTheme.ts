import { useAtomValue } from "@effect/atom-react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThemeDefinitionsAtom, type ThemeDefinition } from "../themePalette";
import { refreshTheme } from "./useTheme";

export function useEnvironmentThemeDefinitions(): ReadonlyArray<ThemeDefinition> {
  return useAtomValue(environmentThemeDefinitionsAtom);
}

/**
 * The palette is painted from a snapshot taken when the theme last changed, so new colors
 * only land if the active theme is re-applied.
 */
export function startEnvironmentThemeRepaint(): () => void {
  return appAtomRegistry.subscribe(environmentThemeDefinitionsAtom, () => {
    refreshTheme({ preservePreview: true });
  });
}
