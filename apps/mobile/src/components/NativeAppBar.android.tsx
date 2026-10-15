import { RNHostView, TopAppBar } from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import type { ReactElement } from "react";
import { NativeThemeHost } from "./NativeThemeHost.android";
import { useControlTheme } from "./useControlTheme";

/** Internal renderer. The surrounding screen owns status-bar and sheet insets. */
export function NativeAppBar(props: {
  readonly title: ReactElement;
  readonly navigationIcon?: ReactElement;
  readonly actions?: ReactElement;
}) {
  const { colors } = useControlTheme();
  return (
    <NativeThemeHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
      <TopAppBar
        applyWindowInsets={false}
        modifiers={[fillMaxWidth()]}
        colors={{
          containerColor: colors["--color-header"],
          titleContentColor: colors["--color-header-foreground"],
          navigationIconContentColor: colors["--color-header-foreground"],
          actionIconContentColor: colors["--color-header-foreground"],
        }}
      >
        <TopAppBar.Title>
          <RNHostView matchContents>{props.title}</RNHostView>
        </TopAppBar.Title>
        {props.navigationIcon ? (
          <TopAppBar.NavigationIcon>
            <RNHostView matchContents>{props.navigationIcon}</RNHostView>
          </TopAppBar.NavigationIcon>
        ) : null}
        {props.actions ? (
          <TopAppBar.Actions>
            <RNHostView matchContents>{props.actions}</RNHostView>
          </TopAppBar.Actions>
        ) : null}
      </TopAppBar>
    </NativeThemeHost>
  );
}
