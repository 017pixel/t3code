import { useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";

import type { AppSymbolName } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { NativeAppBar } from "./NativeAppBar.android";
import { IconButton } from "./IconButton";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { useToolbarLayout } from "./useToolbarLayout";

export interface AndroidHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly selected?: boolean;
}

export function AndroidHeaderIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
}) {
  return <IconButton {...props} tintColorClassName="accent-header-foreground" />;
}

export function AndroidScreenHeader(props: {
  readonly title: string;
  readonly titleContent?: ReactNode;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AndroidHeaderAction>;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onBack?: () => void;
  readonly embedded?: boolean;
  readonly hideBottomBorder?: boolean;
}) {
  const titleTypography = useScaledTextRole("title");
  const subtitleTypography = useScaledTextRole("label");
  const { height: _toolbarHeight, ...headerPadding } = useToolbarLayout(props.embedded);
  const [headerWidth, setHeaderWidth] = useState(0);
  const actions = props.actions ?? [];
  const directCount = actions.length > 2 ? (headerWidth >= 600 ? 3 : 1) : actions.length;
  const visibleActions = actions.slice(0, directCount);
  const overflowActions = actions.slice(directCount);

  return (
    <View
      onLayout={(event) => setHeaderWidth(event.nativeEvent.layout.width)}
      className="border-b border-header-border bg-header"
      style={{
        ...headerPadding,
        borderBottomWidth: props.hideBottomBorder ? 0 : undefined,
      }}
    >
      <NativeAppBar
        navigationIcon={
          props.onBack || props.leading ? (
            <View className="flex-row items-center">
              {props.onBack ? (
                <IconButton
                  accessibilityLabel="Navigate up"
                  icon="arrow.left"
                  tintColorClassName="accent-header-foreground"
                  onPress={props.onBack}
                />
              ) : null}

              {props.leading}
            </View>
          ) : undefined
        }
        title={
          <View className="min-w-0">
            {props.titleContent ?? (
              <Text numberOfLines={1} style={titleTypography} className="text-header-foreground">
                {props.title}
              </Text>
            )}
            {props.subtitle ? (
              <Text
                numberOfLines={1}
                style={subtitleTypography}
                className="mt-px text-[13px] font-t3-medium text-foreground-muted"
              >
                {props.subtitle}
              </Text>
            ) : null}
          </View>
        }
        actions={
          <View className="flex-row items-center">
            {visibleActions.map((action) =>
              action.loading ? (
                <View
                  key={action.accessibilityLabel}
                  accessibilityLabel={action.accessibilityLabel}
                  className="size-12 items-center justify-center"
                >
                  <ActivityIndicator colorClassName="accent-header-foreground" />
                </View>
              ) : (
                <AndroidHeaderIconButton
                  key={action.accessibilityLabel}
                  accessibilityLabel={action.accessibilityLabel}
                  disabled={action.disabled}
                  selected={action.selected}
                  icon={action.icon}
                  onPress={action.onPress}
                />
              ),
            )}
            {overflowActions.length > 0 ? (
              <AndroidAnchoredMenu
                actions={overflowActions.map((action, index) => ({
                  id: String(index),
                  title: action.accessibilityLabel,
                  attributes: {
                    disabled: Boolean(action.disabled),
                    state: action.selected ? "on" : undefined,
                  },
                }))}
                onPressAction={({ nativeEvent }) =>
                  overflowActions[Number(nativeEvent.event)]?.onPress()
                }
              >
                {(open) => (
                  <IconButton
                    accessibilityLabel="More actions"
                    icon="ellipsis"
                    tintColorClassName="accent-header-foreground"
                    onPress={open}
                  />
                )}
              </AndroidAnchoredMenu>
            ) : null}
            {props.trailing}
          </View>
        }
      />
    </View>
  );
}

export function AndroidSheetHeader(
  props: Omit<Parameters<typeof AndroidScreenHeader>[0], "embedded">,
) {
  return <AndroidScreenHeader {...props} embedded />;
}
