import { Host } from "@expo/ui/jetpack-compose";
import { SegmentedButtons } from "./SegmentedButtons.android";
import { View } from "react-native";

import { useControlTheme } from "./useControlTheme";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export function SegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const { colorScheme } = useControlTheme();
  return (
    <View className={props.className}>
      <View importantForAccessibility="no-hide-descendants">
        <Host
          matchContents={{ vertical: true }}
          colorScheme={colorScheme}
          ignoreSafeAreaKeyboardInsets
          style={{ width: "100%" }}
        >
          <SegmentedButtons {...props} />
        </Host>
      </View>
      <View pointerEvents="none" className="absolute inset-0 flex-row">
        {props.options.map((option) => (
          <View
            key={String(option.value)}
            accessible
            accessibilityRole={props.role ?? "button"}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: option.value === props.selected }}
            accessibilityActions={[{ name: "activate" }]}
            onAccessibilityAction={() => props.onSelect(option.value)}
            className="flex-1"
          />
        ))}
      </View>
    </View>
  );
}

export type { SegmentedControlProps } from "./SegmentedControl.types";
