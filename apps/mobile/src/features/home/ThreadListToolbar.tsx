import { useCallback, useRef, useState, type ComponentProps } from "react";
import { useNavigation } from "@react-navigation/native";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { Keyboard, type TextInputInstance, View, type LayoutChangeEvent } from "react-native";
import type { MenuAction } from "@react-native-menu/menu";

import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import { Menu } from "../../components/ui/Menu";
import { SearchField } from "../../components/ui/SearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { WorkspaceListToolbarRow } from "../workspace/WorkspaceListToolbarRow";
import { useWorkspaceConnectionState } from "../../state/workspace";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { backHandlerRef } from "../../lib/backHandler";

export function ThreadListToolbar(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterAction: NonNullable<ComponentProps<typeof Menu>["onPressAction"]>;
  readonly onOpenEnvironments: () => void;
  readonly sidebar?: boolean;
  readonly onLayout?: (event: LayoutChangeEvent) => void;
  readonly onRequestVisibility?: () => void;
}) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const { paddingTop, paddingBottom } = useToolbarLayout();
  const connectionState = useWorkspaceConnectionState();
  const { onRequestVisibility, onSearchQueryChange } = props;
  const searchRef = useRef<TextInputInstance>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = useCallback(() => {
    onRequestVisibility?.();
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  }, [onRequestVisibility]);
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

  // The search field stays mounted on frozen Home screens under a detail route
  // or another tab, so back only applies while the thread list is in front.
  const searchBackRef = backHandlerRef(() => {
    const state = navigation.getState();
    if (!state || state.routes[state.index]?.name !== "Home" || isTabActive?.("threads") === false)
      return false;
    if (Keyboard.isVisible()) Keyboard.dismiss();
    else closeSearch();
    return true;
  });

  const filterIcon = props.filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const searchField = (
    <View ref={searchBackRef} className="min-w-0 flex-1 flex-row">
      <SearchField
        inputRef={searchRef}
        accessibilityLabel="Search threads"
        clearAccessibilityLabel="Clear search"
        placeholder="Search"
        value={props.searchQuery}
        onChangeText={onSearchQueryChange}
      />
    </View>
  );
  const filterButton = connectionState.hasConnections ? (
    <AndroidAnchoredMenu actions={props.filterActions} onPressAction={props.onFilterAction}>
      {(open) => (
        <AndroidHeaderIconButton
          accessibilityLabel="Filter threads"
          icon={filterIcon}
          onPress={open}
        />
      )}
    </AndroidAnchoredMenu>
  ) : null;

  return (
    <View
      onLayout={props.onLayout}
      className={props.sidebar ? "absolute inset-x-0 top-0 z-[4] bg-header px-2" : "bg-header px-2"}
      style={{ paddingTop, paddingBottom }}
    >
      <WorkspaceListToolbarRow
        searching={searching}
        searchField={searchField}
        onCloseSearch={closeSearch}
        onOpenSearch={openSearch}
        searchAccessibilityLabel="Search threads"
        titleAccessibilityLabel="T3 Code, Threads"
        onOpenEnvironments={props.onOpenEnvironments}
        filter={filterButton}
      />
    </View>
  );
}
