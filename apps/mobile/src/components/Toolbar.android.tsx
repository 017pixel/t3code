import { NativeThemeHost } from "./NativeThemeHost.android";
import { HorizontalFloatingToolbar, RNHostView } from "@expo/ui/jetpack-compose";
import type { ToolbarProps } from "./Toolbar.types";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/** Native toolbar surface; hosted RN controls retain their existing menus and accessibility. */
export function Toolbar(props: ToolbarProps) {
  const { themeVariables: colors } = useAppearancePreferences();
  return (
    <NativeThemeHost
      matchContents
      ignoreSafeAreaKeyboardInsets
      style={{ alignSelf: "center", maxWidth: "100%" }}
    >
      <HorizontalFloatingToolbar
        colors={{
          toolbarContainerColor: colors["--color-grouped-card"],
          toolbarContentColor: colors["--color-foreground"],
        }}
      >
        <RNHostView matchContents>{props.children}</RNHostView>
      </HorizontalFloatingToolbar>
    </NativeThemeHost>
  );
}
