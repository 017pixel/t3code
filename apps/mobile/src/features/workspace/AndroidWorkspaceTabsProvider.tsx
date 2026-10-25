import type { NavigationState } from "@react-navigation/native";
import { createContext, use, type ReactNode } from "react";
import { Platform } from "react-native";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { androidWorkspaceSettingsOpen } from "./android-workspace-tabs";
import { WorkspaceTabsProvider } from "./WorkspaceTabsContext";

interface AndroidWorkspaceRoot {
  /**
   * The rail's `useNavigation()` dispatches to the focused navigator, which may be nested Settings.
   * Use the root stack's state and key so a tab press resets the root.
   */
  readonly key: string;
  readonly getState: () => NavigationState;
  /** Settings is derived from navigation rather than kept in the tab reducer. */
  readonly settingsOpen: boolean;
}

const AndroidWorkspaceRootContext = createContext<AndroidWorkspaceRoot | null>(null);

export function useAndroidWorkspaceRoot() {
  return use(AndroidWorkspaceRootContext);
}

/** Android keeps one tab controller above the root navigator and split sidebar. */
export function AndroidWorkspaceTabsProvider(props: {
  readonly state: NavigationState;
  readonly children: ReactNode;
}) {
  const fallbackState = props.state;
  const root = {
    key: props.state.key,
    // This provider renders inside the root stack's layout, so the container's
    // root state is this stack's current state.
    getState: () => rootNavigationRef.getRootState() ?? fallbackState,
    settingsOpen: Platform.OS === "android" && androidWorkspaceSettingsOpen(props.state),
  };
  return Platform.OS === "android" ? (
    <WorkspaceTabsProvider>
      <AndroidWorkspaceRootContext value={root}>{props.children}</AndroidWorkspaceRootContext>
    </WorkspaceTabsProvider>
  ) : (
    props.children
  );
}
